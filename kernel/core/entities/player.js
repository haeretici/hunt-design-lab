/**
 * Player — party member (movement, class/equipment stats, Stage 5 strategy AI).
 */

const { Creature } = require('./creature.js');
const { Time } = require('../lib/time.js');
const {
    rollupEquipment,
    buildEffectiveStats
} = require('../lib/character/stats.js');
const {
    initEquipmentRuntime,
    advanceEquipmentRuntime,
    applyHitChargeConsumption,
    tickEquipmentRegen
} = require('../lib/character/equipment_runtime.js');
const {
    buildInventoryFromSeed,
    buildInventorySandboxSeed,
    equipmentMapFromInventory,
    destroyItem,
    totalCarriedWeight,
    remainingCapacity
} = require('../lib/character/inventory.js');
const { recomputeDerived } = require('../lib/combat/conditions.js');
const { Settings } = require('../../settings.js');

class Player extends Creature {
    /**
     * @param {object} [opts]
     * @param {string} [opts.name]
     * @param {number} [opts.id]
     * @param {{ x: number, y: number, z?: string|number }} [opts.tile]
     * @param {number} [opts.hp]
     * @param {number} [opts.hpMax]
     * @param {number} [opts.mp]
     * @param {number} [opts.mpMax]
     * @param {number} [opts.speed]
     * @param {number} [opts.level]
     * @param {string} [opts.classId] Class / vocation template id (commercial-safe labels)
     * @param {object} [opts.equipment] Slot → item id
     * @param {object} [opts.classDef] Inline class definition (skips preset load)
     * @param {object[]|Record<string, object>} [opts.itemDb] Equipment stat table
     * @param {boolean} [opts.isLeader]
     * @param {number|null} [opts.leaderId] When not leader, id of party leader
     * @param {string} [opts.strategyId] Strategy preset id
     * @param {object} [opts.strategy] Inline strategy bag
     * @param {object} [opts.skills] Character skills (profile / party member)
     * @param {number} [opts.critChance]
     * @param {number} [opts.critDamage]
     */
    constructor(opts = {}) {
        super(
            Object.assign({}, opts, {
                type: 'player',
                name: opts.name || 'Player',
                // Players do not use creature aggro AI
                aggro: false
            })
        );
        this.classId = opts.classId || 'adventurer';
        /** @type {Record<string, string|number|null>} */
        this.equipment = opts.equipment ? Object.assign({}, opts.equipment) : {};
        this.isLeader = !!opts.isLeader;
        this.leaderId =
            opts.leaderId != null && opts.leaderId !== ''
                ? opts.leaderId | 0
                : null;
        this.canBlock = opts.canBlock !== undefined ? !!opts.canBlock : true;
        this.strategyId = opts.strategyId || null;
        /** @type {object|null} Normalized strategy (set by hunt AI init) */
        this.strategy = opts.strategy || null;
        /** @type {string} Control mode ('ai' | 'manual') */
        this.controlMode = opts.controlMode || 'ai';
        /** @type {boolean} Opt-in Auto-Chase toggle for manual mode */
        this.autoChase = opts.autoChase !== undefined ? !!opts.autoChase : false;
        /** @type {object[]} Buffer of commands awaiting authoritative simulation tick processing */
        this.commandQueue = Array.isArray(opts.commandQueue) ? opts.commandQueue.slice() : [];
        /** @type {import('./party.js').Party|null} */
        this.party = null;
        /** Per-player hunt counters (exp/loot share) */
        /** Awarded exp after personal rates (prey/stamina/baseRate/…). */
        this.expGained = 0;
        /**
         * Party-share raw exp only (before personal rate modifiers).
         * @type {number}
         */
        this.rawExpGained = 0;
        /**
         * Total character experience (seeded from level when progression runs).
         * @type {number|null}
         */
        this.experience =
            opts.experience != null && Number.isFinite(Number(opts.experience))
                ? Math.max(0, Math.floor(Number(opts.experience)))
                : null;
        /** Levels gained this session while expProgression was on. */
        this.levelUps = 0;
        this.damageDealt = 0;
        this.damageTaken = 0;
        this.kills = 0;
        /** Weapon auto swings this session (melee/distance/wand auto). */
        this.autoAttacks = 0;
        /** Non-auto spell casts this session (strategy / heal / strike). */
        this.spellsCast = 0;
        /** Per-spell-id cast counts (includes auto ids). */
        this.spellsCastById = Object.create(null);
        /** Per-spell-kind cast counts (auto | spell | heal | …). */
        this.spellsCastByKind = Object.create(null);
        /** Mana spent on successful resolves this session. */
        this.manaSpent = 0;

        /** Character skills from profile / party member (engine or profile keys) */
        this.skills =
            opts.skills && typeof opts.skills === 'object'
                ? Object.assign({}, opts.skills)
                : null;
        this.critChance = opts.critChance != null ? Number(opts.critChance) || 0 : null;
        this.critDamage = opts.critDamage != null ? Number(opts.critDamage) || 0 : null;
        this.promoted = !!opts.promoted;
        this.hasMonstersInEngage = false;
        this._nativeRegenHpTimerMs = 0;
        this._nativeRegenMpTimerMs = 0;

        /** @type {Record<string, import('../lib/character/equipment_runtime.js').EquipmentSlotRuntime>|null} */
        this.equipmentRuntime = null;
        /**
         * Live inventory (root backpack + nested containers + equipment uids).
         * Null until initInventory / spawn wiring.
         * @type {import('../lib/character/inventory.js').Inventory|null}
         */
        this.inventory = opts.inventory || null;
        /** @type {object|null} last class def used by applyClassLoadout */
        this._loadoutClassDef = null;
        /** @type {object[]|Record<string, object>|null} */
        this._loadoutItemDb = null;
        /** @type {object} */
        this._loadoutOpts = {};

        if (opts.classDef || opts.combatStats) {
            if (opts.combatStats) {
                this.applyCombatStats(opts.combatStats);
            } else {
                this.applyClassLoadout(opts.classDef, opts.itemDb, {
                    level: opts.level,
                    baseSkills: opts.skills,
                    critChance: opts.critChance,
                    critDamage: opts.critDamage,
                    promoted: opts.promoted
                });
            }
        }
    }

    /**
     * Build and attach effective combat stats from class + equipment.
     * Initializes duration/charges runtime for timed gear.
     *
     * @param {object} classDef
     * @param {object[]|Record<string, object>|null} [itemDb]
     * @param {{ level?: number, baseSkills?: object, skills?: object, skillOverrides?: object, critChance?: number, critDamage?: number }} [opts]
     * @returns {object} combatStats
     */
    applyClassLoadout(classDef, itemDb, opts) {
        const options = opts || {};
        this._loadoutClassDef = classDef || this._loadoutClassDef;
        this._loadoutItemDb = itemDb !== undefined ? itemDb : this._loadoutItemDb;
        this._loadoutOpts = Object.assign({}, this._loadoutOpts, options);

        if (options.baseSkills || options.skills) {
            this.skills = Object.assign(
                {},
                this.skills || {},
                options.baseSkills || options.skills
            );
        }
        if (options.critChance != null) this.critChance = Number(options.critChance) || 0;
        if (options.critDamage != null) this.critDamage = Number(options.critDamage) || 0;
        if (options.promoted !== undefined) this.promoted = !!options.promoted;

        this.equipmentRuntime = initEquipmentRuntime(
            this.equipment,
            this._loadoutItemDb,
            this.equipmentRuntime
        );

        return this._rebuildCombatStatsFromLoadout();
    }

    /**
     * Recompute effective stats from current equipment + stored loadout opts.
     * Used after duration/charge expiry without resetting remaining budgets.
     * @returns {object|null}
     */
    _rebuildCombatStatsFromLoadout() {
        const classDef = this._loadoutClassDef;
        if (!classDef) return null;
        const options = this._loadoutOpts || {};
        const gear = rollupEquipment(this.equipment, this._loadoutItemDb || null);
        const stats = buildEffectiveStats(classDef, gear, {
            level: options.level != null ? options.level : this.level,
            promoted: options.promoted != null ? options.promoted : this.promoted,
            baseSkills: options.baseSkills || options.skills || this.skills,
            skillOverrides: options.skillOverrides,
            critChance:
                options.critChance != null
                    ? options.critChance
                    : this.critChance != null
                      ? this.critChance
                      : undefined,
            critDamage:
                options.critDamage != null
                    ? options.critDamage
                    : this.critDamage != null
                      ? this.critDamage
                      : undefined
        });
        return this.applyCombatStats(stats);
    }

    /**
     * Attach a pre-built effective stats bag and sync entity fields.
     * @param {object} stats
     * @returns {object}
     */
    applyCombatStats(stats) {
        if (!stats) return null;
        this.combatStats = stats;
        if (stats.promoted !== undefined) this.promoted = !!stats.promoted;
        this.classId = stats.classId || this.classId;
        this.level = stats.level != null ? stats.level : this.level;
        if (stats.autoAttack) this.autoAttack = stats.autoAttack;
        this.armor = stats.armor || 0;
        this.mitigation = stats.mitigation || 0;
        this.maxBlock = stats.maxBlock || 0;
        this.resists = Object.assign({}, stats.resists || {});
        if (stats.speed != null) {
            this.baseSpeed = stats.speed;
            this.speed = stats.speed;
            // Re-apply haste/slow on top of new gear/base speed
            if (Array.isArray(this.conditions) && this.conditions.length) {
                recomputeDerived(this);
            }
        }
        this.skill = stats.skill != null ? stats.skill : this.skill;
        this.meleeSkill = this.skill;
        this.magic = stats.magic != null ? stats.magic : this.magic;

        // Preserve current ratios when re-rolling max, else fill from stats
        if (this.hp.max <= 1 || this.hp.current === this.hp.max) {
            this.hp.max = stats.hpMax;
            this.hp.current = stats.hpMax;
        } else {
            this.hp.max = stats.hpMax;
            this.hp.current = Math.min(this.hp.current, this.hp.max);
        }
        this.mp.max = stats.mpMax;
        if (this.mp.current > this.mp.max || this.mp.current === 0) {
            this.mp.current = stats.mpMax;
        }
        this.alive = this.hp.current > 0;
        return stats;
    }

    /**
     * Build / replace inventory from a seed bag or current equipment map.
     * Syncs `this.equipment` item ids from inventory instances.
     *
     * @param {object|null|undefined} seed see buildInventoryFromSeed
     * @param {object[]|Record<string, object>|null} [itemDb]
     * @returns {import('../lib/character/inventory.js').Inventory}
     */
    initInventory(seed, itemDb) {
        const db = itemDb !== undefined ? itemDb : this._loadoutItemDb;
        if (itemDb != null) this._loadoutItemDb = itemDb;
        if (seed && seed.sandbox === true) {
            this.inventory = buildInventorySandboxSeed(
                (seed.equipment != null ? seed.equipment : this.equipment) || {},
                db
            );
        } else {
            const s =
                seed && typeof seed === 'object'
                    ? Object.assign(
                          { equipment: this.equipment },
                          seed
                      )
                    : { equipment: this.equipment };
            if (!s.equipment) s.equipment = this.equipment;
            this.inventory = buildInventoryFromSeed(s, db);
        }
        this.syncEquipmentFromInventory();
        return this.inventory;
    }

    /**
     * Push inventory equipment uids → `this.equipment` item-id map.
     * @returns {Record<string, string>}
     */
    syncEquipmentFromInventory() {
        if (!this.inventory) return this.equipment || {};
        this.equipment = equipmentMapFromInventory(
            this.inventory,
            this._loadoutItemDb
        );
        return this.equipment;
    }

    /**
     * After inventory UI mutates bags/gear: sync equipment + re-roll combat stats.
     * @returns {object|null} combatStats
     */
    applyInventoryMutation() {
        this.syncEquipmentFromInventory();
        this.equipmentRuntime = initEquipmentRuntime(
            this.equipment,
            this._loadoutItemDb,
            this.equipmentRuntime
        );
        return this._rebuildCombatStatsFromLoadout();
    }

    /**
     * Remaining Cap after carried weight (equipped + backpack tree).
     * @returns {number}
     */
    getRemainingCapacity() {
        const weight = totalCarriedWeight(this.inventory, this._loadoutItemDb);
        return remainingCapacity(this.level || 1, weight, this.classId);
    }

    /**
     * Destroy items in inventory equipment slots (duration/charge expiry).
     * @param {string[]} slots
     */
    _destroyInventoryEquipmentSlots(slots) {
        if (!this.inventory || !Array.isArray(slots)) return;
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            const uid = this.inventory.equipment[slot];
            if (uid) destroyItem(this.inventory, uid);
        }
    }

    /**
     * Tick durationSec budgets; unequip expired items and re-roll stats.
     * @param {number} [dtSec] defaults to Time.deltaTime
     * @returns {{ expiredSlots: string[], changed: boolean }}
     */
    tickEquipmentRuntime(dtSec) {
        const dt = dtSec != null ? dtSec : Time.deltaTime;
        if (!this.equipmentRuntime) {
            return { expiredSlots: [], changed: false };
        }
        const advanced = advanceEquipmentRuntime(
            this.equipment,
            this.equipmentRuntime,
            dt
        );
        this.equipment = advanced.equipment;
        this.equipmentRuntime = advanced.runtime;
        if (advanced.expiredSlots.length) {
            this._destroyInventoryEquipmentSlots(advanced.expiredSlots);
            this._rebuildCombatStatsFromLoadout();
        }
        return {
            expiredSlots: advanced.expiredSlots,
            changed: advanced.changed
        };
    }

    /**
     * Consume charges on damaging hits; unequip when charges hit 0.
     * @param {number} [amount=1]
     * @returns {{ depletedSlots: string[], consumedSlots: string[], changed: boolean }}
     */
    consumeEquipmentChargesOnHit(amount) {
        if (!this.equipmentRuntime) {
            return { depletedSlots: [], consumedSlots: [], changed: false };
        }
        const result = applyHitChargeConsumption(
            this.equipment,
            this.equipmentRuntime,
            amount != null ? amount : 1
        );
        this.equipment = result.equipment;
        this.equipmentRuntime = result.runtime;
        if (result.depletedSlots.length) {
            this._destroyInventoryEquipmentSlots(result.depletedSlots);
            this._rebuildCombatStatsFromLoadout();
        }
        return {
            depletedSlots: result.depletedSlots,
            consumedSlots: result.consumedSlots,
            changed: result.changed
        };
    }

    /**
     * @param {number} amount
     * @param {string} [element='physical']
     * @returns {number} hp delta
     */
    applyHpDelta(amount, element) {
        const delta = super.applyHpDelta(amount, element);
        // Charged gear (e.g. might_ring) loses charges when the wearer is hit
        if (delta < 0) {
            this.consumeEquipmentChargesOnHit(1);
        }
        return delta;
    }

    /**
     * Advance native and equipment HP/MP regeneration timers and restore hit/mana points.
     * Native intervals depend on whether monsters are currently within engage range.
     * Equipment regeneration runs on independent item-defined intervals regardless of engage area.
     * @param {number} [dtSec] defaults to Time.deltaTime
     * @returns {{ hpDelta: number, mpDelta: number }}
     */
    tickRegeneration(dtSec) {
        if (!this.alive || !this.hp || this.hp.current <= 0) {
            return { hpDelta: 0, mpDelta: 0 };
        }
        const dt = dtSec != null ? Number(dtSec) : Time.deltaTime;
        if (!Number.isFinite(dt) || dt <= 0) {
            return { hpDelta: 0, mpDelta: 0 };
        }
        const dtMs = dt * 1000;
        let hpRestored = 0;
        let mpRestored = 0;

        // Native regeneration
        const stats = this.combatStats;
        const nativeRegen = stats && stats.nativeRegen ? stats.nativeRegen : { hp: 0, mp: 0 };
        const inEngage = !!(this.hasMonstersInEngage || (this.target && this.target.alive) || this.inBattle);

        const hpInterval = inEngage
            ? (Settings.ENGAGE_REGEN_HP_INTERVAL_MS != null ? Settings.ENGAGE_REGEN_HP_INTERVAL_MS : 4000)
            : (Settings.BASE_REGEN_HP_INTERVAL_MS != null ? Settings.BASE_REGEN_HP_INTERVAL_MS : 3000);
        const mpInterval = inEngage
            ? (Settings.ENGAGE_REGEN_MP_INTERVAL_MS != null ? Settings.ENGAGE_REGEN_MP_INTERVAL_MS : 6000)
            : (Settings.BASE_REGEN_MP_INTERVAL_MS != null ? Settings.BASE_REGEN_MP_INTERVAL_MS : 5000);

        if (nativeRegen.hp > 0 && hpInterval > 0) {
            this._nativeRegenHpTimerMs = (this._nativeRegenHpTimerMs || 0) + dtMs;
            while (this._nativeRegenHpTimerMs >= hpInterval) {
                this._nativeRegenHpTimerMs -= hpInterval;
                hpRestored += nativeRegen.hp;
            }
        }
        if (nativeRegen.mp > 0 && mpInterval > 0) {
            this._nativeRegenMpTimerMs = (this._nativeRegenMpTimerMs || 0) + dtMs;
            while (this._nativeRegenMpTimerMs >= mpInterval) {
                this._nativeRegenMpTimerMs -= mpInterval;
                mpRestored += nativeRegen.mp;
            }
        }

        // Equipment regeneration (independent per item, ignoring engage area)
        if (this.equipmentRuntime) {
            const eqRegen = tickEquipmentRegen(this.equipmentRuntime, dt);
            hpRestored += eqRegen.hpDelta;
            mpRestored += eqRegen.mpDelta;
        }

        let actualHpDelta = 0;
        let actualMpDelta = 0;

        if (hpRestored > 0 && this.hp.current < this.hp.max) {
            actualHpDelta = this.applyHpDelta(hpRestored, 'healing');
        }
        if (mpRestored > 0 && this.mp && this.mp.current < this.mp.max) {
            const before = this.mp.current;
            this.mp.current = Math.min(this.mp.max, this.mp.current + mpRestored);
            actualMpDelta = this.mp.current - before;
        }

        return { hpDelta: actualHpDelta, mpDelta: actualMpDelta };
    }

    update() {
        super.update();
        const dt = Time.deltaTime;
        this.tickEquipmentRuntime(dt);
        this.tickRegeneration(dt);
    }
}

module.exports = { Player };
