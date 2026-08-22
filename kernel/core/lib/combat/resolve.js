/**
 * High-level combat resolution (Stage 4).
 * Wires presets + pure damage + cooldowns + mana into one attack result.
 * Does not implement AI / FSM (Stage 5).
 */

const { Settings } = require('../../../settings.js');
const { Time } = require('../time.js');
const {
    computeDamage,
    computeDamageRange,
    fatalChanceFromTier,
    CRIT_BAND_AUTO_ST,
    CRIT_BAND_MULTIPLY
} = require('./damage.js');
const Cooldowns = require('./cooldowns.js');
const {
    attackerBagFromStats,
    defenderBagFromStats,
    SHIELD_BLOCK_MAX_PER_WINDOW,
    SHIELD_BLOCK_WINDOW_SEC
} = require('../character/stats.js');
const {
    processAttackSkillProgression,
    processManaSkillProgression
} = require('../character/progression.js');
const {
    removeConditions,
    removeCondition,
    applyCondition,
    conditionDefFromSpell,
    isInvisible,
    getAttributeMods,
    absorbWithManaShield
} = require('./conditions.js');

/**
 * @typedef {object} SpellDef
 * @property {string} id
 * @property {string} [label]
 * @property {string} [kind] auto | strike | spell | heal | support
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
 * @property {string[]} [dispel] condition kinds to clear on defender (cure spells)
 * @property {object} [condition] buff/debuff applied on hit (haste / invisible / …)
 * @property {boolean} [statusOnly] no meaningful direct damage (min/max 0)
 * @property {number} [tauntDurationSec] force creature target onto caster (legacy challenge)
 * @property {number} [forceMeleeDurationSec] force creature stand-off to 1 for this many seconds (legacy changeTargetDistance)
 * @property {boolean} [chainOnlyRanged] chain hops only free (non-summon) hostiles with base targetDistance > 1
 */

/**
 * Whether the defender is a challengeable hostile (not player, not summon).
 * Mirrors legacy Monster::challengeCreature (summons return false).
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isChallengeableCreature(entity) {
    if (!entity || entity.alive === false) return false;
    if (entity.type === 'player') return false;
    if (entity.isPlayer === true) return false;
    // Party / player-owned summons are not taunted (legacy isSummon).
    if (entity.masterId != null && Number(entity.masterId) > 0) return false;
    return true;
}

/**
 * @returns {number} Time.timeSinceLevelLoad or 0
 */
function combatNow() {
    return Time && Time.timeSinceLevelLoad != null
        ? Number(Time.timeSinceLevelLoad)
        : 0;
}

/**
 * Force a creature's combat target onto the challenger for a duration.
 * Legacy: doChallengeCreature → selectTarget + challengeFocusDuration (default 6s).
 *
 * @param {object} creature defender (hostile)
 * @param {object} challenger caster (player)
 * @param {number} [durationSec=6]
 * @returns {boolean} true when taunt applied
 */
function applyChallengeTaunt(creature, challenger, durationSec) {
    if (!isChallengeableCreature(creature) || !challenger) return false;
    if (creature === challenger) return false;

    const dur =
        durationSec != null && Number.isFinite(Number(durationSec))
            ? Math.max(0, Number(durationSec))
            : 6;
    if (!(dur > 0)) return false;

    const now = combatNow();

    creature.challengedById =
        challenger.id != null ? challenger.id : null;
    creature.challengeUntil = now + dur;
    creature.targetId = challenger.id != null ? challenger.id : null;
    creature.target = challenger;

    // Safe-spot / field routing window tracks the taunt window at least.
    const prevProv = Number(creature.provokedUntil) || 0;
    creature.provokedUntil = Math.max(prevProv, now + dur);
    return true;
}

/**
 * True while challenge focus still locks target selection.
 * @param {object|null|undefined} creature
 * @param {number} [now]
 * @returns {boolean}
 */
function isCreatureChallenged(creature, now) {
    if (!creature) return false;
    const until = Number(creature.challengeUntil) || 0;
    if (!(until > 0)) return false;
    const t =
        typeof now === 'number' && Number.isFinite(now)
            ? now
            : combatNow();
    if (t >= until) {
        creature.challengeUntil = 0;
        creature.challengedById = null;
        return false;
    }
    return true;
}

/**
 * Force creature stand-off to melee (targetDistance = 1) for a duration.
 * Legacy: Monster::changeTargetDistance(1, durationMs) + challengeMeleeDuration.
 * Only applies when the creature's base stand-off is greater than 1 (ranged).
 *
 * @param {object} creature
 * @param {number} [durationSec=12]
 * @param {number} [distance=1]
 * @returns {boolean}
 */
function applyForceMelee(creature, durationSec, distance) {
    if (!isChallengeableCreature(creature)) return false;
    // Reward bosses are immune (legacy changeTargetDistance).
    if (
        creature.isRewardBoss === true ||
        (creature.flags && creature.flags.rewardBoss === true) ||
        (creature.kit &&
            creature.kit.flags &&
            creature.kit.flags.rewardBoss === true)
    ) {
        return false;
    }

    const baseTd = baseTargetDistance(creature);
    const dist =
        distance != null && Number.isFinite(Number(distance))
            ? Math.max(1, Math.floor(Number(distance)))
            : 1;
    // Only pull ranged → melee; melee already at 1 is a no-op for icons/AI.
    if (!(baseTd > dist)) return false;

    const dur =
        durationSec != null && Number.isFinite(Number(durationSec))
            ? Math.max(0, Number(durationSec))
            : 12;
    if (!(dur > 0)) return false;

    const now = combatNow();
    creature.forceMeleeUntil = now + dur;
    creature.forceMeleeDistance = dist;
    return true;
}

/**
 * Base (template) stand-off distance, ignoring temporary force-melee.
 * @param {object|null|undefined} creature
 * @returns {number}
 */
function baseTargetDistance(creature) {
    if (!creature) return 1;
    if (creature.kit && creature.kit.flags && creature.kit.flags.targetDistance != null) {
        return Math.max(1, creature.kit.flags.targetDistance | 0);
    }
    if (creature.flags && creature.flags.targetDistance != null) {
        return Math.max(1, creature.flags.targetDistance | 0);
    }
    if (creature.targetDistance != null) {
        return Math.max(1, creature.targetDistance | 0);
    }
    return 1;
}

/**
 * Effective temporary stand-off override while force-melee is active.
 * Clears expired locks.
 * @param {object|null|undefined} creature
 * @param {number} [now]
 * @returns {number|null} forced distance, or null when inactive
 */
function getForcedTargetDistance(creature, now) {
    if (!creature) return null;
    const until = Number(creature.forceMeleeUntil) || 0;
    if (!(until > 0)) return null;
    const t =
        typeof now === 'number' && Number.isFinite(now)
            ? now
            : combatNow();
    if (t >= until) {
        creature.forceMeleeUntil = 0;
        creature.forceMeleeDistance = null;
        return null;
    }
    const d = creature.forceMeleeDistance;
    return d != null && Number.isFinite(Number(d))
        ? Math.max(1, Math.floor(Number(d)))
        : 1;
}

/**
 * True while force-melee (challengeMeleeDuration) is active.
 * @param {object|null|undefined} creature
 * @param {number} [now]
 * @returns {boolean}
 */
function isForceMeleeActive(creature, now) {
    return getForcedTargetDistance(creature, now) != null;
}

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
 * Restore mana on an entity (player.mp or creature.mana).
 * @param {object} entity
 * @param {number} amount
 * @returns {number} actual delta
 */
function applyManaDelta(entity, amount) {
    const n = Math.max(0, Math.floor(Number(amount) || 0));
    if (!entity || n <= 0) return 0;
    if (entity.mp && entity.mp.current != null) {
        const max =
            entity.mp.max != null
                ? Number(entity.mp.max)
                : entity.mp.current + n;
        const before = entity.mp.current;
        entity.mp.current = Math.min(max, before + n);
        return entity.mp.current - before;
    }
    if (entity.mana != null) {
        const before = Number(entity.mana) || 0;
        const max =
            entity.manaMax != null
                ? Number(entity.manaMax)
                : entity.maxMana != null
                  ? Number(entity.maxMana)
                  : before + n;
        entity.mana = Math.min(max, before + n);
        return entity.mana - before;
    }
    return 0;
}

/**
 * Whether this spell can crit or leech (legacy skips healing).
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
/**
 * Distance auto prefers equipment hit% (ammo maxHit + bow mod).
 * @param {object|null|undefined} spell
 * @param {object|null|undefined} atkBag
 * @returns {number}
 */
function resolveSpellHitChance(spell, atkBag) {
    const isDistanceAuto =
        !!spell &&
        (spell.id === 'distance_auto' || spell.powerCurve === 'distance_auto');
    if (isDistanceAuto && atkBag && atkBag.hitChance != null) {
        return Number(atkBag.hitChance);
    }
    if (spell && spell.hitChance != null) return Number(spell.hitChance);
    if (atkBag && atkBag.hitChance != null && spell && spell.kind === 'auto') {
        return Number(atkBag.hitChance);
    }
    return 100;
}

/**
 * Crit chance 0–100 from combat bag, else entity field (kit has no combatStats).
 * @param {object|null|undefined} attacker
 * @returns {number}
 */
function critChanceForAttacker(attacker) {
    if (!attacker) return 0;
    const stats = attacker.combatStats || attacker.effectiveStats || null;
    if (stats && stats.critChance != null) return Number(stats.critChance) || 0;
    if (attacker.critChance != null) return Number(attacker.critChance) || 0;
    return 0;
}

/**
 * Player-only fatal chance from weapon `tier` (creatures never fatal).
 * @param {object|null|undefined} attacker
 * @returns {number}
 */
function fatalChanceForAttacker(attacker) {
    if (!attacker || attacker.type === 'creature') return 0;
    const stats = attacker.combatStats || attacker.effectiveStats || null;
    if (stats) {
        if (stats.fatalChance != null) return Math.max(0, Number(stats.fatalChance) || 0);
        if (stats.weaponTier != null) return fatalChanceFromTier(stats.weaponTier);
    }
    if (attacker.fatalChance != null) {
        return Math.max(0, Number(attacker.fatalChance) || 0);
    }
    if (attacker.weaponTier != null) return fatalChanceFromTier(attacker.weaponTier);
    return 0;
}

function spellCanCritOrLeech(spell) {
    if (!spell) return false;
    if (spell.kind === 'heal' || spell.kind === 'support') return false;
    const el = spell.element || 'physical';
    if (el === 'healing' || el === 'manadrain' || el === 'undefined') return false;
    return true;
}

/**
 * Area / wave / beam / chain / followup — never the ST auto 65% band.
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function spellIsMultiTarget(spell) {
    if (!spell) return false;
    if (spell.shape && typeof spell.shape === 'object') {
        const t = String(spell.shape.type || '');
        if (t === 'area' || t === 'wave' || t === 'beam') return true;
    }
    if (spell.chain != null && Number(spell.chain) > 1) return true;
    if (Array.isArray(spell.followupShapes) && spell.followupShapes.length > 0) {
        return true;
    }
    return false;
}

/**
 * ST melee/distance auto → `auto_st`. Wand, kit, strikes, shaped, chain → multiply.
 * Kit melee uses `kind: 'auto'` with no power curve / auto id — must not match.
 * @param {object|null|undefined} spell
 * @returns {'auto_st'|'multiply'}
 */
function critBandForSpell(spell) {
    if (!spell) return CRIT_BAND_MULTIPLY;
    const id = String(spell.id || '');
    if (id === 'wand_auto') return CRIT_BAND_MULTIPLY;
    const curve = spell.powerCurve;
    if (curve === 'magic_strike') return CRIT_BAND_MULTIPLY;
    const isWeaponAuto =
        spell.kind === 'auto' ||
        id === 'melee_auto' ||
        id === 'distance_auto';
    if (!isWeaponAuto) return CRIT_BAND_MULTIPLY;
    const isMeleeOrDistance =
        curve === 'melee_auto' ||
        curve === 'distance_auto' ||
        id === 'melee_auto' ||
        id === 'distance_auto';
    if (!isMeleeOrDistance) return CRIT_BAND_MULTIPLY;
    if (spellIsMultiTarget(spell)) return CRIT_BAND_MULTIPLY;
    return CRIT_BAND_AUTO_ST;
}

/**
 * Roll one leech proc. Chance is 0–100 percent; amount is percent of realDamage.
 * @param {number} chance
 * @param {number} amountPct
 * @param {number} realDamage
 * @param {() => number} [rng]
 * @returns {number}
 */
function rollLeechAmount(chance, amountPct, realDamage, rng) {
    const dmg = Math.max(0, Number(realDamage) || 0);
    const c = Math.max(0, Number(chance) || 0);
    const a = Math.max(0, Number(amountPct) || 0);
    if (dmg <= 0 || c <= 0 || a <= 0) return 0;
    if (c < 100) {
        const r = typeof rng === 'function' ? rng() : Math.random();
        if (r * 100 >= c) return 0;
    }
    const raw = Math.round(dmg * (a / 100));
    return Math.max(0, Math.min(dmg, raw));
}

/**
 * Life / mana leech after real HP damage (legacy applyLifeLeech / applyManaLeech).
 * Chance and amount come from effective stats (class/profile % + equipment).
 * @param {object} attacker
 * @param {number} realDamage
 * @param {() => number} [rng]
 * @returns {{ life: number, mana: number }}
 */
function applyAttackLeech(attacker, realDamage, rng) {
    const dmg = Math.max(0, Number(realDamage) || 0);
    if (!attacker || dmg <= 0) return { life: 0, mana: 0 };
    const bag =
        attacker.combatStats || attacker.effectiveStats || attacker;
    const life = rollLeechAmount(
        bag.lifeLeechChance,
        bag.lifeLeechAmount,
        dmg,
        rng
    );
    const mana = rollLeechAmount(
        bag.manaLeechChance,
        bag.manaLeechAmount,
        dmg,
        rng
    );
    let lifeApplied = 0;
    let manaApplied = 0;
    if (life > 0) lifeApplied = applyHpDelta(attacker, life, 'healing');
    if (mana > 0) manaApplied = applyManaDelta(attacker, mana);
    return { life: lifeApplied, mana: manaApplied };
}

/**
 * Whether entity is a player (not a hostile creature).
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isPlayerEntity(entity) {
    if (!entity) return false;
    if (entity.type === 'player') return true;
    if (entity.isPlayer === true) return true;
    return false;
}

/**
 * Legacy parity (Monster::drainHealth): real damage breaks monster invisibility.
 * Players keep invis when hit (player drainHealth does not strip CONDITION_INVISIBLE).
 *
 * @param {object|null|undefined} entity
 * @param {number} damageAmount positive damage taken
 */
function breakInvisibilityOnDamage(entity, damageAmount) {
    if (!entity || !(Number(damageAmount) > 0)) return;
    if (isPlayerEntity(entity)) return;
    if (!isInvisible(entity) && !entity.invisible) return;
    removeCondition(entity, 'invisible');
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
    // Healing / undefined / manadrain skip absorb. Everything else (incl. DoT
    // and field ticks that already went through mitigation) can hit the shield.
    let incoming = Number(amount) || 0;
    if (
        incoming > 0 &&
        element !== 'undefined' &&
        element !== 'manadrain'
    ) {
        incoming = absorbWithManaShield(defender, incoming).leftoverHp;
    }
    const before = defender.hp.current;
    defender.hp.current = Math.max(0, before - incoming);
    if (defender.hp.current <= 0) {
        defender.alive = false;
    }
    const dealt = before - defender.hp.current;
    // AoE / single-target / DoT that reduce HP cancel monster invis (legacy).
    if (dealt > 0) {
        breakInvisibilityOnDamage(defender, dealt);
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
 * @param {boolean} [opts.grantWeaponSkillTry=true] false for AOE secondary targets
 * @param {number} [opts.damageScale] multiply post-mitigation damage (followup shapes)
 * @param {object} [opts.sessionConfig] frozen progression session (Phase C/D)
 * @param {boolean} [opts.skillProgression]
 * @param {string} [opts.critBand] force `auto_st` / `multiply` (area/chain pass multiply)
 * @param {boolean} [opts.hit] skip the hit roll (`true` = already hit, `false` = miss)
 * @param {boolean} [opts.critical] skip the crit roll (area: one flag / swing)
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
 *   moveLock: number,
 *   skillProgress?: object|null
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
              lifeLeechChance: attacker.lifeLeechChance || 0,
              lifeLeechAmount: attacker.lifeLeechAmount || 0,
              manaLeechChance: attacker.manaLeechChance || 0,
              manaLeechAmount: attacker.manaLeechAmount || 0,
              hitChance:
                  attacker.hitChance != null ? attacker.hitChance : 100,
              weaponTier: Math.max(
                  0,
                  Math.floor(Number(attacker.weaponTier) || 0)
              )
          };

    const atkMods = getAttributeMods(attacker);
    const defMods = getAttributeMods(defender);

    // Shield block: at most SHIELD_BLOCK_MAX_PER_WINDOW (2) per SHIELD_BLOCK_WINDOW_SEC (2s).
    // Window is ticked on entity update; also accept null hits as unlimited for pure bags.
    const canBlock =
        defender.canBlock !== false &&
        !defMods.disableDefense &&
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

    // Protector-style shielding skill% → scale maxBlock / mitigation (approx).
    if (defMods.skillMult && defMods.skillMult.shielding != null) {
        const shM = defMods.skillMult.shielding;
        defBag.maxBlock = Math.max(
            0,
            Math.floor((Number(defBag.maxBlock) || 0) * shM)
        );
        defBag.mitigation = Math.min(
            100,
            Math.max(0, (Number(defBag.mitigation) || 0) * shM)
        );
    }
    if (defMods.disableDefense) {
        defBag.canBlock = false;
        defBag.maxBlock = 0;
    }

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
    const hitChance = resolveSpellHitChance(spell, atkBag);

    // Phase M: stance skill% — melee/fist for melee family, distance for bows, magic for ML.
    if (atkMods.skillMult) {
        const sm = atkMods.skillMult;
        if (isDistanceAuto && sm.distance != null) {
            atkBag.skill = Math.max(
                0,
                (Number(atkBag.skill) || 0) * sm.distance
            );
        } else if (
            !isDistanceAuto &&
            spell.powerCurve !== 'magic_strike' &&
            spell.kind !== 'heal'
        ) {
            const meleeM =
                sm.melee != null
                    ? sm.melee
                    : sm.sword != null
                      ? sm.sword
                      : sm.axe != null
                        ? sm.axe
                        : sm.club != null
                          ? sm.club
                          : sm.fist != null
                            ? sm.fist
                            : null;
            if (meleeM != null) {
                atkBag.skill = Math.max(
                    0,
                    (Number(atkBag.skill) || 0) * meleeM
                );
            }
        }
        if (sm.magic != null) {
            atkBag.magic = Math.max(0, (Number(atkBag.magic) || 0) * sm.magic);
        }
    }

    const isWeaponAuto =
        spell.kind === 'auto' ||
        spell.id === 'melee_auto' ||
        spell.id === 'distance_auto' ||
        spell.id === 'wand_auto';
    const extraAtk = isWeaponAuto ? Number(atkBag.extraAtk) || 0 : 0;
    const extraAtkElement =
        isWeaponAuto && extraAtk > 0 ? atkBag.extraAtkElement || null : null;

    const canCritOrLeech = spellCanCritOrLeech(spell);
    const critBand = o.critBand || critBandForSpell(spell);
    const canFatal = canCritOrLeech && attacker.type !== 'creature';
    const fatalChance = canFatal
        ? o.fatalChance != null
            ? Number(o.fatalChance) || 0
            : atkBag.fatalChance != null
              ? Number(atkBag.fatalChance) || 0
              : fatalChanceFromTier(atkBag.weaponTier)
        : 0;
    const result = computeDamage({
        powerCurve: spell.powerCurve,
        basePower: spell.basePower,
        damageAmplitude: spell.damageAmplitude,
        attacker: atkBag,
        defender: defBag,
        element: spell.element || 'physical',
        isMelee,
        hitChance,
        hit: o.hit,
        critChance: canCritOrLeech ? atkBag.critChance : 0,
        critDamage: canCritOrLeech ? atkBag.critDamage : 0,
        critBand,
        critical: o.critical,
        fatalChance,
        fatal: o.fatal,
        min: spell.min,
        max: spell.max,
        extraAtk,
        extraAtkElement,
        rng: o.rng
    });

    // Stance damage dealt / received (not healing).
    const spellElement = spell.element || 'physical';
    if (result.hit && result.final > 0 && spellElement !== 'healing') {
        let final = result.final;
        if (atkMods.damageDealtMult !== 1) {
            final = Math.max(0, Math.floor(final * atkMods.damageDealtMult));
        }
        if (defMods.damageReceivedMult !== 1) {
            final = Math.max(0, Math.floor(final * defMods.damageReceivedMult));
        }
        // Dual-combat outer ring (e.g. Sweeping Takedown 75% pass).
        const dmgScale = Number(o.damageScale);
        if (Number.isFinite(dmgScale) && dmgScale !== 1) {
            final = Math.max(0, Math.floor(final * dmgScale));
        }
        if (final !== result.final) {
            result.final = final;
            if (result.breakdown) {
                result.breakdown.final = final;
            }
        }
    }

    const applyMutations = o.apply !== false;
    let hpDelta = 0;
    let lifeLeech = 0;
    let manaLeech = 0;
    let conditionsRemoved = 0;
    /** @type {object|null} */
    let conditionApplied = null;
    let tauntApplied = false;
    let forceMeleeApplied = false;
    const moveLock = resolveMoveLock(spell);
    /** @type {object|null} */
    let skillProgress = null;
    /** @type {object|null} */
    let manaProgress = null;
    let blockChargeSpent = false;

    if (applyMutations) {
        if (!o.skipCooldown) {
            Cooldowns.apply(attacker, spell.cooldowns);
        }
        if (!o.skipMana) {
            spendMana(attacker, manaCost);
            // Phase D: mana → magic level (hit not required)
            if (manaCost > 0) {
                manaProgress = processManaSkillProgression(attacker, manaCost, {
                    sessionConfig: o.sessionConfig,
                    skillProgression: o.skillProgression
                });
            }
        }
        // Post-cast self root: same-tick combatMove is gated by canStep/moveDelay.
        applyMoveLock(attacker, moveLock);
        if (result.hit && result.final > 0) {
            hpDelta = applyHpDelta(
                defender,
                result.final,
                spell.element || 'physical'
            );
            // Leech uses actual HP lost (after mana-shield / floor), not raw.
            if (canCritOrLeech && hpDelta < 0) {
                const leech = applyAttackLeech(attacker, -hpDelta, o.rng);
                lifeLeech = leech.life;
                manaLeech = leech.mana;
            }
        }
        // Cure / dispel: clear listed condition kinds on the defender (self for cures).
        if (result.hit && Array.isArray(spell.dispel) && spell.dispel.length) {
            conditionsRemoved = removeConditions(defender, spell.dispel);
        }
        // Buffs / DoTs (haste, invisible, utori *) — apply on hit (incl. statusOnly 0 dmg).
        if (result.hit && spell.condition) {
            const def = conditionDefFromSpell(spell.condition, defender);
            if (def) {
                conditionApplied = applyCondition(defender, def, {
                    source: spell.id || 'spell'
                });
            }
        }
        // Taunt / challenge: force creature target onto caster (0 dmg statusOnly OK).
        if (
            result.hit &&
            defender !== attacker &&
            spell.tauntDurationSec != null &&
            Number(spell.tauntDurationSec) > 0
        ) {
            tauntApplied = applyChallengeTaunt(
                defender,
                attacker,
                Number(spell.tauntDurationSec)
            );
        }
        // Force melee stand-off (chivalrous_challenge / divine_dazzle).
        if (
            result.hit &&
            defender !== attacker &&
            spell.forceMeleeDurationSec != null &&
            Number(spell.forceMeleeDurationSec) > 0
        ) {
            forceMeleeApplied = applyForceMelee(
                defender,
                Number(spell.forceMeleeDurationSec),
                1
            );
        }
        // Sole owner of AI provocation window (safe-spotting / field routing).
        // Direct damage OR hostile DoT apply both count (statusOnly DoTs are 0 final).
        // Taunt also stamps provokedUntil inside applyChallengeTaunt.
        // Force-melee alone (divine_dazzle) does not open the provoke window.
        // Do not re-stamp in Simulator.recordAttack.
        if (
            result.hit &&
            defender !== attacker &&
            !tauntApplied &&
            (result.final > 0 ||
                (conditionApplied &&
                    conditionApplied.remainingDamage != null &&
                    conditionApplied.remainingDamage > 0))
        ) {
            const winSec =
                Settings.AI_PROVOKED_WINDOW_SEC != null
                    ? Number(Settings.AI_PROVOKED_WINDOW_SEC)
                    : 5.0;
            const now =
                Time && Time.timeSinceLevelLoad != null
                    ? Number(Time.timeSinceLevelLoad)
                    : 0;
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
            blockChargeSpent = true;
            if (!(defender.shieldingTimer > 0)) {
                defender.shieldingTimer = SHIELD_BLOCK_WINDOW_SEC;
            }
        }

        // Phase D: blood bucket, weapon tries, shield full-zero tries
        skillProgress = processAttackSkillProgression(
            attacker,
            defender,
            {
                ok: true,
                hit: result.hit,
                final: result.final,
                breakdown: result.breakdown,
                spell
            },
            {
                sessionConfig: o.sessionConfig,
                skillProgression: o.skillProgression,
                grantWeaponSkillTry: o.grantWeaponSkillTry !== false,
                blockChargeSpent
            }
        );
    }

    return {
        ok: true,
        defender,
        spell,
        hit: result.hit,
        critical: result.critical,
        fatal: !!result.fatal,
        final: result.final,
        hpDelta,
        lifeLeech,
        manaLeech,
        conditionsRemoved,
        conditionApplied,
        tauntApplied,
        forceMeleeApplied,
        breakdown: result.breakdown,
        range: result.range,
        moveLock,
        skillProgress,
        manaProgress
    };
}

function fail(reason, spell) {
    return {
        ok: false,
        reason,
        spell: spell || null,
        hit: false,
        critical: false,
        fatal: false,
        final: 0,
        hpDelta: 0,
        lifeLeech: 0,
        manaLeech: 0,
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
    applyManaDelta,
    applyAttackLeech,
    rollLeechAmount,
    applyChallengeTaunt,
    isCreatureChallenged,
    isChallengeableCreature,
    applyForceMelee,
    baseTargetDistance,
    getForcedTargetDistance,
    isForceMeleeActive,
    resolveMoveLock,
    applyMoveLock,
    defaultMeleeAutoSpell,
    spellIsMultiTarget,
    critBandForSpell,
    spellCanCritOrLeech,
    resolveSpellHitChance,
    critChanceForAttacker,
    fatalChanceForAttacker,
    resolveAttack,
    previewDamageRange
};
