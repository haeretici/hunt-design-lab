/**
 * High-level combat resolution (Stage 4).
 * Wires presets + pure damage + cooldowns + mana into one attack result.
 * Does not implement AI / FSM (Stage 5).
 */

const { Settings } = require('../../../settings.js');
const { Time } = require('../time.js');
const {
    computeDamage,
    computeDamageRange
} = require('./damage.js');
const Cooldowns = require('./cooldowns.js');
const {
    attackerBagFromStats,
    defenderBagFromStats,
    SHIELD_BLOCK_MAX_PER_WINDOW,
    SHIELD_BLOCK_WINDOW_SEC
} = require('../character/stats.js');

/**
 * @typedef {object} SpellDef
 * @property {string} id
 * @property {string} [label]
 * @property {string} [kind] auto | strike | spell | heal
 * @property {string} [element]
 * @property {string} [powerCurve]
 * @property {number} [basePower]
 * @property {number} [damageAmplitude] half-width fraction for strikes; omit → 0
 * @property {number} [range]
 * @property {number} [mana]
 * @property {number} [hitChance]
 * @property {number} [moveLock] post-cast self root seconds (omit → Settings.SPELL_MOVE_LOCK_DEFAULT; 0 = none)
 * @property {object} [cooldowns]
 * @property {boolean} [isMelee]
 */

/**
 * Effective post-cast movement lock for a spell (seconds).
 * @param {SpellDef|null|undefined} spell
 * @returns {number}
 */
function resolveMoveLock(spell) {
    if (spell && spell.moveLock != null) {
        const n = Number(spell.moveLock);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }
    const def =
        Settings.SPELL_MOVE_LOCK_DEFAULT != null
            ? Number(Settings.SPELL_MOVE_LOCK_DEFAULT)
            : 0.05;
    return Number.isFinite(def) && def > 0 ? def : 0;
}

/**
 * Extend attacker.moveDelay to at least lockSec (does not shorten an existing step delay).
 * @param {object} attacker
 * @param {number} lockSec
 */
function applyMoveLock(attacker, lockSec) {
    const lock = Number(lockSec) || 0;
    if (!attacker || !(lock > 0)) return;
    const cur = Number(attacker.moveDelay) || 0;
    attacker.moveDelay = Math.max(cur, lock);
}

/**
 * Index spells array/object by id.
 * @param {SpellDef[]|Record<string, SpellDef>|null} spells
 * @returns {Record<string, SpellDef>}
 */
function indexSpells(spells) {
    const out = Object.create(null);
    if (!spells) return out;
    if (Array.isArray(spells)) {
        for (let i = 0; i < spells.length; i++) {
            const s = spells[i];
            if (s && s.id) out[s.id] = s;
        }
    } else {
        for (const k of Object.keys(spells)) {
            const s = spells[k];
            if (s) out[s.id || k] = s.id ? s : Object.assign({ id: k }, s);
        }
    }
    return out;
}

/**
 * Whether attacker has enough mana for the spell.
 * @param {object} attacker entity with mp or effective stats
 * @param {number} manaCost
 * @returns {boolean}
 */
function hasMana(attacker, manaCost) {
    const cost = Math.max(0, Number(manaCost) || 0);
    if (cost <= 0) return true;
    const cur =
        attacker.mp && attacker.mp.current != null
            ? attacker.mp.current
            : attacker.mana != null
              ? attacker.mana
              : Infinity;
    return cur >= cost;
}

/**
 * Spend mana on attacker (mutates).
 * @param {object} attacker
 * @param {number} manaCost
 */
function spendMana(attacker, manaCost) {
    const cost = Math.max(0, Math.floor(Number(manaCost) || 0));
    if (cost <= 0) return;
    if (attacker.mp && attacker.mp.current != null) {
        attacker.mp.current = Math.max(0, attacker.mp.current - cost);
    } else if (attacker.mana != null) {
        attacker.mana = Math.max(0, attacker.mana - cost);
    }
}

/**
 * Apply final damage to defender hp (mutates). Healing element restores.
 * @param {object} defender
 * @param {number} amount
 * @param {string} element
 * @returns {number} actual hp delta applied (negative = damage)
 */
function applyHpDelta(defender, amount, element) {
    if (!defender) return 0;
    if (!defender.hp) {
        defender.hp = { current: 0, max: 1 };
    }
    if (element === 'healing') {
        const before = defender.hp.current;
        const max = defender.hp.max != null ? defender.hp.max : before + amount;
        defender.hp.current = Math.min(max, before + amount);
        return defender.hp.current - before;
    }
    const before = defender.hp.current;
    defender.hp.current = Math.max(0, before - amount);
    if (defender.hp.current <= 0) {
        defender.alive = false;
    }
    return defender.hp.current - before;
}

/**
 * Build spell def for built-in melee auto when not in spell book.
 * @returns {SpellDef}
 */
function defaultMeleeAutoSpell() {
    return {
        id: 'melee_auto',
        label: 'Auto Attack',
        kind: 'auto',
        element: 'physical',
        powerCurve: 'melee_auto',
        basePower: 0,
        range: 1,
        mana: 0,
        hitChance: 100,
        isMelee: true,
        moveLock: resolveMoveLock(null),
        // Legacy autoAttackTimer — separate from primary spell GCD
        cooldowns: {
            auto: { attack: 2 }
        }
    };
}

/**
 * Resolve one attack from attacker against defender.
 *
 * @param {object} opts
 * @param {object} opts.attacker Entity (Player/Creature) or plain bag with stats
 * @param {object} opts.defender Entity or plain bag
 * @param {string|SpellDef} opts.spell Spell id or def
 * @param {SpellDef[]|Record<string, SpellDef>} [opts.spellBook]
 * @param {object} [opts.attackerStats] override effective stats
 * @param {object} [opts.defenderStats] override effective stats
 * @param {boolean} [opts.skipCooldown=false]
 * @param {boolean} [opts.skipMana=false]
 * @param {boolean} [opts.apply=true] mutate hp / cooldowns / mana
 * @param {() => number} [opts.rng]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   spell: SpellDef|null,
 *   hit: boolean,
 *   critical: boolean,
 *   final: number,
 *   hpDelta: number,
 *   breakdown: object|null,
 *   range: {min:number,max:number}|null,
 *   moveLock: number
 * }}
 */
function resolveAttack(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const defender = o.defender;
    if (!attacker || !defender) {
        return fail('missing_combatant');
    }

    let spell = null;
    if (typeof o.spell === 'string') {
        const book = indexSpells(o.spellBook);
        spell = book[o.spell] || null;
        if (!spell && (o.spell === 'melee_auto' || o.spell === 'auto')) {
            spell = defaultMeleeAutoSpell();
        }
    } else if (o.spell && typeof o.spell === 'object') {
        spell = o.spell;
    }
    if (!spell) {
        return fail('unknown_spell');
    }

    const aStats =
        o.attackerStats ||
        attacker.combatStats ||
        attacker.effectiveStats ||
        null;
    const dStats =
        o.defenderStats ||
        defender.combatStats ||
        defender.effectiveStats ||
        null;

    if (!o.skipCooldown) {
        Cooldowns.ensureCooldowns(attacker);
        if (!Cooldowns.canUse(attacker, spell.cooldowns)) {
            return fail('cooldown', spell);
        }
    }

    const manaCost = spell.mana != null ? spell.mana : 0;
    if (!o.skipMana && !hasMana(attacker, manaCost)) {
        return fail('mana', spell);
    }

    const atkBag = aStats
        ? attackerBagFromStats(aStats)
        : {
              level: attacker.level || 1,
              atk: attacker.atk || 0,
              skill: attacker.skill || attacker.meleeSkill || 0,
              magic: attacker.magic || attacker.magicSkill || 0,
              critChance: attacker.critChance || 0,
              critDamage: attacker.critDamage || 0,
              hitChance:
                  attacker.hitChance != null ? attacker.hitChance : 100
          };

    // Shield block: at most SHIELD_BLOCK_MAX_PER_WINDOW (2) per SHIELD_BLOCK_WINDOW_SEC (2s).
    // Window is ticked on entity update; also accept null hits as unlimited for pure bags.
    const canBlock =
        defender.canBlock !== false &&
        (defender.shieldingHits == null ||
            defender.shieldingHits < SHIELD_BLOCK_MAX_PER_WINDOW);

    const defBag = dStats
        ? defenderBagFromStats(dStats, { canBlock })
        : {
              mitigation: defender.mitigation || 0,
              resists: defender.resists || {},
              armor: defender.armor || 0,
              maxBlock: defender.maxBlock || 0,
              canBlock
          };

    const isMelee =
        spell.isMelee != null
            ? !!spell.isMelee
            : spell.kind === 'auto' ||
              spell.powerCurve === 'melee_auto' ||
              spell.powerCurve === 'melee_strike' ||
              spell.element === 'physical';

    // Distance auto: prefer equipment-derived hit% (ammo + weapon mods).
    // Explicit spell.hitChance wins only when stats do not supply one (or for non-auto).
    const isDistanceAuto =
        spell.id === 'distance_auto' || spell.powerCurve === 'distance_auto';
    let hitChance = 100;
    if (isDistanceAuto && atkBag.hitChance != null) {
        hitChance = Number(atkBag.hitChance);
    } else if (spell.hitChance != null) {
        hitChance = Number(spell.hitChance);
    } else if (atkBag.hitChance != null && spell.kind === 'auto') {
        hitChance = Number(atkBag.hitChance);
    }

    const result = computeDamage({
        powerCurve: spell.powerCurve,
        basePower: spell.basePower,
        damageAmplitude: spell.damageAmplitude,
        attacker: atkBag,
        defender: defBag,
        element: spell.element || 'physical',
        isMelee,
        hitChance,
        critChance: atkBag.critChance,
        critDamage: atkBag.critDamage,
        min: spell.min,
        max: spell.max,
        rng: o.rng
    });

    const applyMutations = o.apply !== false;
    let hpDelta = 0;
    const moveLock = resolveMoveLock(spell);

    if (applyMutations) {
        if (!o.skipCooldown) {
            Cooldowns.apply(attacker, spell.cooldowns);
        }
        if (!o.skipMana) {
            spendMana(attacker, manaCost);
        }
        // Post-cast self root: same-tick combatMove is gated by canStep/moveDelay.
        applyMoveLock(attacker, moveLock);
        if (result.hit && result.final > 0) {
            hpDelta = applyHpDelta(
                defender,
                result.final,
                spell.element || 'physical'
            );
            // Sole owner of AI provocation window (safe-spotting / field routing).
            // Do not re-stamp in Simulator.recordAttack.
            const winSec = Settings.AI_PROVOKED_WINDOW_SEC != null ? Number(Settings.AI_PROVOKED_WINDOW_SEC) : 5.0;
            const now = Time && Time.timeSinceLevelLoad != null ? Number(Time.timeSinceLevelLoad) : 0;
            defender.provokedUntil = now + winSec;
        }
        // Count each allowed melee-physical block attempt (legacy parity),
        // even when the roll is 0 or final damage is 0. Starts the 2s window.
        if (
            result.hit &&
            isMelee &&
            (spell.element || 'physical') === 'physical' &&
            defBag.canBlock &&
            (defBag.maxBlock || 0) > 0
        ) {
            defender.shieldingHits = (defender.shieldingHits || 0) + 1;
            if (!(defender.shieldingTimer > 0)) {
                defender.shieldingTimer = SHIELD_BLOCK_WINDOW_SEC;
            }
        }
    }

    return {
        ok: true,
        defender,
        spell,
        hit: result.hit,
        critical: result.critical,
        final: result.final,
        hpDelta,
        breakdown: result.breakdown,
        range: result.range,
        moveLock
    };
}

function fail(reason, spell) {
    return {
        ok: false,
        reason,
        spell: spell || null,
        hit: false,
        critical: false,
        final: 0,
        hpDelta: 0,
        breakdown: null,
        range: null,
        moveLock: 0
    };
}

/**
 * Preview damage range for UI / tests without rolling.
 * @param {object} attackerStats
 * @param {SpellDef} spell
 * @returns {{ min: number, max: number }}
 */
function previewDamageRange(attackerStats, spell) {
    const bag = attackerBagFromStats(attackerStats || {});
    return computeDamageRange(
        spell.powerCurve || 'fixed',
        bag,
        spell.basePower,
        spell.damageAmplitude
    );
}

module.exports = {
    indexSpells,
    hasMana,
    spendMana,
    applyHpDelta,
    resolveMoveLock,
    applyMoveLock,
    defaultMeleeAutoSpell,
    resolveAttack,
    previewDamageRange
};
