/**
 * Creature — tile combatant (movement, combat stats, Stage 5 AI hooks).
 */

const { GameObject } = require('./gameobject.js');
const { Time } = require('../lib/time.js');
const { Settings } = require('../../settings.js');
const Cooldowns = require('../lib/combat/cooldowns.js');
const { applyHpDelta } = require('../lib/combat/resolve.js');
const {
    tickConditions,
    ensureBaseSpeed
} = require('../lib/combat/conditions.js');
const {
    DEFAULT_RESISTS,
    SHIELD_BLOCK_WINDOW_SEC
} = require('../lib/character/stats.js');
const {
    DEFAULT_CREATURE_COMBAT,
    resolveCreatureSpeed
} = require('../lib/content/defaults.js');
const { ensureCreatureKit } = require('../lib/ai/creature_kit.js');
const {
    snapVisualToTile,
    tickStepVisual
} = require('../lib/movement.js');

class Creature extends GameObject {
    /**
     * @param {object} [opts]
     * @param {string} [opts.name]
     * @param {number} [opts.id] Positive id for TileMap occupancy (required to occupy)
     * @param {{ x: number, y: number, z?: string|number }} [opts.tile]
     * @param {number} [opts.hp]
     * @param {number} [opts.hpMax]
     * @param {number} [opts.mp]
     * @param {number} [opts.mpMax]
     * @param {number} [opts.speed]
     * @param {number} [opts.level]
     * @param {number} [opts.armor]
     * @param {number} [opts.mitigation]
     * @param {number} [opts.maxBlock]
     * @param {number} [opts.atk] Player fallback only (resolveAttack when combatStats missing). Hostiles use attacks[].
     * @param {number} [opts.skill] Player weapon skill fallback. Hostiles ignore.
     * @param {string} [opts.autoAttack] Player class/equipment auto spell id. Hostiles use kit attacks[] only.
     * @param {number} [opts.magic] Player magic skill fallback. Hostiles ignore (kit fixed min/max).
     * @param {number} [opts.exp] Exp awarded on kill
     * @param {number} [opts.lootValue] Minimal loot counter
     * @param {boolean} [opts.aggro]
     * @param {object} [opts.resists]
     * @param {object} [opts.combatStats] Pre-built effective stats (players)
     * @param {string} [opts.creatureType] Catalog / template id (optional)
     * @param {string} [opts.type] Entity kind: 'creature' | 'player'
     */
    constructor(opts = {}) {
        super(opts.name || 'Creature');
        this.type = opts.type || 'creature';
        this.creatureType = opts.creatureType || null;

        const rawId = opts.id != null ? opts.id | 0 : 0;
        this.id = rawId > 0 ? rawId : 0;

        const hpMax = opts.hpMax != null ? opts.hpMax : opts.hp != null ? opts.hp : 100;
        const hpCur = opts.hp != null ? opts.hp : hpMax;
        this.hp = {
            current: Math.max(0, hpCur),
            max: Math.max(1, hpMax)
        };

        const mpMax = opts.mpMax != null ? opts.mpMax : opts.mp != null ? opts.mp : 0;
        const mpCur = opts.mp != null ? opts.mp : mpMax;
        this.mp = {
            current: Math.max(0, mpCur),
            max: Math.max(0, mpMax)
        };

        // Players: class/level speed is applied later via applyCombatStats.
        // Creatures: absolute template speed (no level scaling); default 100.
        const isPlayer = (opts.type || 'creature') === 'player';
        if (opts.speed !== undefined && opts.speed !== null && opts.speed !== '') {
            this.speed = resolveCreatureSpeed(opts.speed);
        } else if (isPlayer) {
            this.speed =
                Settings.DEFAULT_ENTITY_SPEED != null
                    ? Settings.DEFAULT_ENTITY_SPEED
                    : 110;
        } else {
            this.speed = resolveCreatureSpeed(
                undefined,
                DEFAULT_CREATURE_COMBAT.speed
            );
        }
        /** Unbuffed speed snapshot for haste/slow conditions. */
        this.baseSpeed = this.speed;
        /** @type {object[]} active conditions (poison DoT, haste, invis, …) */
        this.conditions = Array.isArray(opts.conditions)
            ? opts.conditions.slice()
            : [];
        /** Derived: true while invisible condition is active. */
        this.invisible = !!opts.invisible;

        this.level = opts.level != null ? opts.level | 0 : 1;
        this.armor = opts.armor != null ? Number(opts.armor) : 0;
        this.mitigation = opts.mitigation != null ? Number(opts.mitigation) : 0;
        this.maxBlock = opts.maxBlock != null ? Number(opts.maxBlock) : 0;
        // Player combat fallbacks (resolveAttack when combatStats missing).
        // Hostiles: offense is kit attacks[] only — applyTemplate does not set these.
        this.atk = opts.atk != null ? Number(opts.atk) : 0;
        this.skill = opts.skill != null ? Number(opts.skill) : 0;
        this.meleeSkill = this.skill;
        this.magic = opts.magic != null ? Number(opts.magic) : 0; // player only
        this.expValue = opts.exp != null ? Number(opts.exp) : 0;
        this.lootValue = opts.lootValue != null ? Number(opts.lootValue) : 0;
        this.autoAttack = opts.autoAttack || 'melee_auto';
        this.aggro = opts.aggro !== undefined ? !!opts.aggro : true;
        this.resists = Object.assign({}, DEFAULT_RESISTS, opts.resists || {});
        this.canBlock = opts.canBlock !== undefined ? !!opts.canBlock : false;
        /** Successful block attempts in the current shielding window (cap 2). */
        this.shieldingHits = 0;
        /** Seconds remaining in the shielding window before hits reset. */
        this.shieldingTimer = 0;
        /** @type {object|null} Effective combat stats (players set via applyClassLoadout) */
        this.combatStats = opts.combatStats || null;

        // Creature kit (multi-attack / strategies / range-flee flags)
        /** @type {object|null} last template used for kit rebuild */
        this._kitTemplate = null;
        /** @type {object|null} */
        this.flags = opts.flags || null;
        /** @type {Record<string, number>|null} */
        this.strategiesTarget = opts.strategiesTarget || null;
        /** @type {object[]|null} raw or normalized attacks */
        this.attacks = Array.isArray(opts.attacks) ? opts.attacks : null;
        /** @type {Record<string|number, number>} damage dealt to this creature by player id */
        this.damageTakenBy = Object.create(null);
        /** @type {object|null} runtime kit from ensureCreatureKit */
        this.kit = null;
        /**
         * Master entity id when this creature is a summon (null = independent).
         * @type {number|null}
         */
        this.masterId =
            opts.masterId != null && opts.masterId > 0
                ? opts.masterId | 0
                : null;
        /**
         * Entity ids of living summons owned by this master.
         * @type {number[]}
         */
        this.summonIds = Array.isArray(opts.summonIds)
            ? opts.summonIds.slice()
            : [];
        /**
         * Template summon config ({ maxSummons, summons[] }) when present.
         * @type {object|null}
         */
        this.summon = opts.summon && typeof opts.summon === 'object'
            ? opts.summon
            : null;

        // Watch-mode catalog art (Stage 12D) — optional; markers fall back if missing
        /** @type {string|null} */
        this.genre = opts.genre || null;
        /** @type {string|null} */
        this.technical = opts.technical || null;
        /** @type {object|null} Catalog sprites bag (original path, …) */
        this.sprites = opts.sprites || null;
        /** @type {object|null} Singular sprite bag (e.g. legacy GIF) */
        this.sprite = opts.sprite || null;
        /**
         * Optional catalog creature id used only for art resolution
         * (template.customSprite). Wins over creatureType for stem path.
         * @type {string|null}
         */
        this.spriteId = opts.spriteId || opts.customSprite || null;
        /**
         * Catalog genre for spriteId / customSprite when different from hunt genre
         * (template.customSpriteGenre).
         * @type {string|null}
         */
        this.spriteGenre =
            opts.spriteGenre || opts.customSpriteGenre || null;
        /** @type {string|null} Override stem when not derived from technical/id */
        this.spriteStem = opts.spriteStem || null;
        /**
         * Species visual size vs a standard humanoid (template.displayScale).
         * Affix/rarity mults multiply this at draw time. Default 1.
         * @type {number}
         */
        this.displayScale =
            opts.displayScale != null && Number(opts.displayScale) > 0
                ? Number(opts.displayScale)
                : 1;

        /** @type {{ x: number, y: number, z: string|number }|null} */
        this.tile = null;
        if (opts.tile) {
            this.tile = {
                x: Math.round(opts.tile.x),
                y: Math.round(opts.tile.y),
                z: opts.tile.z !== undefined ? opts.tile.z : 0
            };
            this.x = this.tile.x;
            this.y = this.tile.y;
            this.z = this.tile.z;
        }

        /** @type {{ x: number, y: number }[]} Remaining steps (TileMap.followPath buffer) */
        this.path = [];
        /** Seconds until the next tile step is allowed */
        this.moveDelay = 0;
        /**
         * Presentation slide (watch mode): duration / elapsed of the current
         * step visual and start coords. Logic always uses `tile`; render uses
         * `x`/`y`. Slide length matches the step's moveDelay at start.
         * @type {number}
         */
        this._moveVisDuration = 0;
        this._moveVisElapsed = 0;
        this._moveVisFromX = this.x;
        this._moveVisFromY = this.y;
        /** Tiles/sec of the active slide (1/moveDelay); 0 when idle */
        this.moveSpeed = 0;
        /**
         * Watch-mode horizontal facing for static sprites (1 = right / default,
         * -1 = left / canvas flip). Updated on tile steps with a horizontal delta.
         * @type {number}
         */
        this.spriteFacing = 1;
        this.alive = this.hp.current > 0;
        /**
         * When true, scene-graph updateAll is a no-op (Etapa 3 sleep).
         * Set by applyCreatureSleepState — freezes CD / moveDelay while far idle.
         * Players never sleep; sticky / non-idle never sleep.
         * @type {boolean}
         */
        this.simSleeping = false;
        /** Ghost-walk route progress (party sets / reads) */
        this.currentWaypoint = 0;
        this.routeComplete = false;

        // Stage 5 AI fields
        /** @type {import('../lib/fsm.js').StateMachine|null} */
        this.brain = null;
        this.aiState = '';
        this.targetId = null;
        /** @type {object|null} */
        this.target = null;
        this.inBattle = false;
        /** @type {{ x: number, y: number, z: string|number }|null} */
        this.homeTile = opts.homeTile
            ? {
                  x: Math.round(opts.homeTile.x),
                  y: Math.round(opts.homeTile.y),
                  z: opts.homeTile.z !== undefined ? opts.homeTile.z : 0
              }
            : this.tile
              ? { x: this.tile.x, y: this.tile.y, z: this.tile.z }
              : null;
        this.spawnTile = this.homeTile
            ? { x: this.homeTile.x, y: this.homeTile.y, z: this.homeTile.z }
            : null;
        this.respawnTime = opts.respawn != null ? Number(opts.respawn) : 0;
        this.despawnLeashTicks =
            opts.despawnLeashTicks != null ? opts.despawnLeashTicks | 0 : 0;

        this.cooldowns = Cooldowns.createCooldownState();

        if (opts.attacks || opts.flags || opts.strategiesTarget) {
            this._kitTemplate = {
                attacks: this.attacks,
                flags: this.flags,
                strategiesTarget: this.strategiesTarget
            };
            ensureCreatureKit(this, this._kitTemplate);
        }
    }

    /**
     * Apply fields from a creature combat template (presets/creatures/*.json).
     * @param {object} template
     */
    applyTemplate(template) {
        if (!template) return this;
        if (template.label && (this.name === 'Creature' || !this.name)) {
            this.name = template.label;
        }
        if (template.id) this.creatureType = template.id;
        if (template.genre) this.genre = template.genre;
        if (template.technical) this.technical = template.technical;
        if (template.sprites) this.sprites = template.sprites;
        // Ported legacy templates use singular `sprite.legacy` (GIF path).
        if (template.sprite) this.sprite = template.sprite;
        // customSprite: browse-picked catalog id when template id has no art
        if (template.customSprite != null && String(template.customSprite).trim()) {
            this.spriteId = String(template.customSprite).trim();
        } else if (template.spriteId != null && String(template.spriteId).trim()) {
            this.spriteId = String(template.spriteId).trim();
        }
        // customSpriteGenre: catalog genre for customSprite (other genres allowed)
        if (
            template.customSpriteGenre != null &&
            String(template.customSpriteGenre).trim()
        ) {
            this.spriteGenre = String(template.customSpriteGenre).trim();
        } else if (
            template.spriteGenre != null &&
            String(template.spriteGenre).trim()
        ) {
            this.spriteGenre = String(template.spriteGenre).trim();
        }
        if (template.spriteStem) this.spriteStem = template.spriteStem;
        if (template.displayScale != null) {
            const d = Number(template.displayScale);
            if (Number.isFinite(d) && d > 0) this.displayScale = d;
        }
        if (template.hpMax != null || template.hp != null) {
            const max = template.hpMax != null ? template.hpMax : template.hp;
            const cur = template.hp != null ? template.hp : max;
            this.hp.max = Math.max(1, max);
            this.hp.current = Math.max(0, Math.min(this.hp.max, cur));
        }
        // Absolute speed from template (0 = stationary). Level never modifies it.
        // Omitting speed keeps the ctor default (DEFAULT_CREATURE_COMBAT.speed).
        if (template.speed !== undefined && template.speed !== null) {
            this.speed = resolveCreatureSpeed(template.speed);
            this.baseSpeed = this.speed;
        }
        if (Array.isArray(template.defenseSpells)) {
            this.defenseSpells = template.defenseSpells;
        }
        // Summon metadata (runtime AI uses kit.summon when feature enabled)
        if (template.summon && typeof template.summon === 'object') {
            this.summon = template.summon;
        }
        if (template.level != null) this.level = template.level | 0;
        if (template.armor != null) this.armor = Number(template.armor);
        if (template.mitigation != null) this.mitigation = Number(template.mitigation);
        if (template.maxBlock != null) this.maxBlock = Number(template.maxBlock);
        if (template.exp != null) this.expValue = Number(template.exp);
        if (template.lootValue != null) this.lootValue = Number(template.lootValue);
        if (template.aggro !== undefined) this.aggro = !!template.aggro;
        if (template.resists) {
            this.resists = Object.assign({}, DEFAULT_RESISTS, template.resists);
        }
        if (template.canBlock !== undefined) this.canBlock = !!template.canBlock;
        // immunities.invisible → canSeeInvisibility (legacy monster isImmune CONDITION_INVISIBLE)
        if (template.immunities && typeof template.immunities === 'object') {
            this.immunities = Object.assign({}, template.immunities);
        }

        // Kit fields (multi-attack, strategies, range/flee)
        if (template.flags) this.flags = template.flags;
        if (template.strategiesTarget) {
            this.strategiesTarget = template.strategiesTarget;
        }
        if (template.targetStrategies && !template.strategiesTarget) {
            this.strategiesTarget = template.targetStrategies;
        }
        // Clone attacks so spawn affix mults never mutate the preset cache.
        if (Array.isArray(template.attacks)) {
            this.attacks = JSON.parse(JSON.stringify(template.attacks));
        }
        if (template.runHealthPercent != null) {
            this.runHealthPercent = Number(template.runHealthPercent);
        }
        if (template.aggroRange != null) {
            this.aggroRange = template.aggroRange | 0;
        }

        this._kitTemplate = Object.assign({}, template, {
            attacks: this.attacks,
            flags: this.flags,
            strategiesTarget: this.strategiesTarget,
            runHealthPercent: this.runHealthPercent,
            aggroRange: this.aggroRange,
            summon: this.summon,
            defenseSpells: this.defenseSpells
        });
        ensureCreatureKit(this, this._kitTemplate);

        this.alive = this.hp.current > 0;
        return this;
    }

    /**
     * Count down move delay by one fixed logic step and advance step visual.
     */
    tickMoveDelay() {
        const dt = Time.deltaTime;
        if (this.moveDelay > 0) {
            this.moveDelay = Math.max(0, this.moveDelay - dt);
        }
        // Presentation: x/y catch up to tile over the step's moveDelay window
        tickStepVisual(this, dt);
    }

    /**
     * @returns {boolean}
     */
    canStep() {
        return this.alive && this.moveDelay <= 0;
    }

    /**
     * Hard-snap render position to logic tile (spawn, stairs, teleports).
     * Does not start a slide — use TileMap.moveEntityToTile for walks.
     */
    syncPositionFromTile() {
        snapVisualToTile(this);
    }

    /**
     * Apply incoming hit points (damage or healing).
     * @param {number} amount
     * @param {string} [element='physical']
     * @returns {number} hp delta
     */
    applyHpDelta(amount, element) {
        const delta = applyHpDelta(this, amount, element || 'physical');
        this.alive = this.hp.current > 0;
        return delta;
    }

    /**
     * Advance the 2s shielding window; resets block counter when it expires.
     * @param {number} [dtSec]
     */
    tickShieldingWindow(dtSec) {
        const dt = dtSec != null ? Number(dtSec) : Time.deltaTime;
        if (!(dt > 0)) return;
        if (this.shieldingTimer > 0) {
            this.shieldingTimer = Math.max(0, this.shieldingTimer - dt);
            if (this.shieldingTimer <= 0) {
                this.shieldingHits = 0;
            }
        } else if ((this.shieldingHits || 0) > 0) {
            // Hits without an active timer: start a full window (safety net)
            this.shieldingTimer = SHIELD_BLOCK_WINDOW_SEC;
        }
    }

    update() {
        if (this.simSleeping) return;
        this.tickMoveDelay();
        this.tickShieldingWindow(Time.deltaTime);
        Cooldowns.tick(this, Time.deltaTime);
        ensureBaseSpeed(this);
        tickConditions(this, Time.deltaTime);
    }

    /**
     * Sleeping creatures skip the whole scene-graph pass (self + scripts +
     * children). Awake path is unchanged GameObject.updateAll.
     */
    updateAll() {
        if (this.simSleeping) return;
        super.updateAll();
    }
}

module.exports = { Creature };
