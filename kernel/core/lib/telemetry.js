/**
 * Hunt session telemetry (Stage 6 + Stage 11.0 pacing samples).
 *
 * Contract (TELEMETRY INTEGRATION RULE):
 *   1. createEmptyHuntTelemetry() at session start
 *   2. sample* during sim (attacks, kills, consumables, pacing events, …)
 *   3. buildHuntSummary() for runner / CLI / analysis UI
 *   4. New events must update: sampler + summary fields + tests + analysis UI (Stage 8)
 *
 * Pure helpers: no DOM, no Settings side effects. Safe for Node + browser.
 */

const { LOGIC_DT, LOGIC_UPS } = require('./time.js');
const {
    buildPacingMetrics,
    evaluatePacing,
    normalizeBudget
} = require('./dungeon/pacing.js');

/** Known combat elements for breakdown maps (plus `other`). */
const DAMAGE_ELEMENTS = [
    'physical',
    'fire',
    'ice',
    'energy',
    'earth',
    'holy',
    'death',
    'healing'
];

/**
 * @returns {Record<string, number>}
 */
function emptyElementMap() {
    const m = Object.create(null);
    for (let i = 0; i < DAMAGE_ELEMENTS.length; i++) {
        m[DAMAGE_ELEMENTS[i]] = 0;
    }
    m.other = 0;
    return m;
}

/**
 * Fresh counters for one hunt session.
 * @returns {object}
 */
function createEmptyHuntTelemetry() {
    return {
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        damageTaken: 0,
        damageDealtByElement: emptyElementMap(),
        damageTakenByElement: emptyElementMap(),
        healingDone: 0,
        /** Awarded exp after party share + personal rates (sum of member awards). */
        expGained: 0,
        /**
         * Party-share raw exp only (before prey/stamina/baseRate/…); sum of member raws.
         * @type {number}
         */
        rawExpGained: 0,
        /** Levels gained while expProgression was on. */
        levelUps: 0,
        lootGained: 0,
        attacks: 0,
        hits: 0,
        crits: 0,
        fatals: 0,
        misses: 0,
        /** Party weapon auto swings (melee/distance/wand auto only). */
        autoAttacks: 0,
        /**
         * Party strategy / heal / strike casts (non-auto). Auto swings use autoAttacks.
         * @type {number}
         */
        spellsCast: 0,
        /**
         * Per-spell-id cast counts for party members (includes auto ids).
         * @type {Record<string, number>}
         */
        spellsCastById: Object.create(null),
        /**
         * Per-spell-kind cast counts (auto | spell | heal | strike | …).
         * @type {Record<string, number>}
         */
        spellsCastByKind: Object.create(null),
        creaturesSpawned: 0,
        /** Stage 11.2 interactive props used (break / loot / heal). */
        propsSpawned: 0,
        propsUsed: 0,
        /** Mana spent by party (from spells). */
        manaSpent: 0,
        /**
         * Phase D: skill tries credited this session (sum of effective tries).
         * @type {number}
         */
        skillTriesGained: 0,
        /** Per-bag try totals (sword/axe/club/fist/distance/shielding). */
        skillTriesByBag: Object.create(null),
        /** Mana credited toward magic level (after skill rate pins). */
        manaSpentTowardMagic: 0,
        /** Skill level-ups while skillProgression was on. */
        skillLevelsGained: 0,
        /** Magic level-ups while skillProgression was on. */
        magicLevelsGained: 0,
        consumables: {
            mana: 0,
            potions: 0
        },
        endReason: null,
        startTick: 0,
        endTick: null,
        /**
         * Stage 11.0 pacing event log (sim-seconds timestamps).
         * Kinds: combat | kill | death | consumable | prop | well |
         * biome_transition (11.10 stair hop into new biome/art) | …
         * Optional tag: champion | elite | boss | well | …
         * Macro fields on biome_transition: fromBiomeId, toBiomeId, …
         * @type {{ t: number, kind: string, tag?: string|null, entityId?: number|null }[]}
         */
        events: [],
        /**
         * Creature entity ids that already emitted a combat-touch event this session.
         * Used to avoid flooding the micro-loop with every hit.
         * @type {Set<number|string>}
         */
        combatTouchedIds: new Set(),
        commandHistory: []
    };
}

/**
 * @deprecated Prefer createEmptyHuntTelemetry (Stage 6 name).
 * @returns {object}
 */
function createEmptyTelemetry() {
    return createEmptyHuntTelemetry();
}

/**
 * Normalize element key into the breakdown map.
 * @param {Record<string, number>} map
 * @param {string|null|undefined} element
 * @param {number} amount
 */
function bumpElement(map, element, amount) {
    if (!map || !(amount > 0)) return;
    const el = element || 'physical';
    if (map[el] != null) {
        map[el] += amount;
    } else {
        map.other = (map.other || 0) + amount;
    }
}

/**
 * Value / hour from sim-seconds (logic time, not wall clock).
 * @param {number} value
 * @param {number} timeSeconds
 * @returns {number}
 */
function ratePerHour(value, timeSeconds) {
    const t = Number(timeSeconds) || 0;
    if (t <= 0) return 0;
    const v = Number(value) || 0;
    return (v * 3600) / t;
}

/**
 * Whether a resolved spell is a player weapon auto (not a strategy spell).
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function isAutoAttackSpell(spell) {
    if (!spell || typeof spell !== 'object') return false;
    if (spell.kind === 'auto') return true;
    const id = spell.id != null ? String(spell.id) : '';
    return (
        id === 'melee_auto' ||
        id === 'distance_auto' ||
        id === 'wand_auto' ||
        id === 'auto'
    );
}

/**
 * Stable spell id for cast counters.
 * @param {object|null|undefined} spell
 * @returns {string}
 */
function spellCastId(spell) {
    if (spell && spell.id != null && String(spell.id).length) {
        return String(spell.id);
    }
    if (isAutoAttackSpell(spell)) return 'auto';
    return 'unknown';
}

/**
 * Stable spell kind for cast counters (auto | spell | heal | strike | …).
 * @param {object|null|undefined} spell
 * @returns {string}
 */
function spellCastKind(spell) {
    if (isAutoAttackSpell(spell)) return 'auto';
    if (spell && spell.kind != null && String(spell.kind).length) {
        return String(spell.kind);
    }
    if (spell && spell.element === 'healing') return 'heal';
    return 'spell';
}

/**
 * Clone a positive count map (spell id / kind → n).
 * @param {Record<string, number>|null|undefined} map
 * @returns {Record<string, number>}
 */
function cloneCountMap(map) {
    const out = Object.create(null);
    if (!map || typeof map !== 'object') return out;
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const n = Number(map[k]) || 0;
        if (n > 0) out[k] = n;
    }
    return out;
}

/**
 * Bump party + attacker spell cast counters (id and kind). Mutates t / attacker.
 * Auto swings also bump autoAttacks; non-auto bump spellsCast.
 *
 * @param {object} t telemetry bag
 * @param {object} attacker player entity
 * @param {object|null|undefined} spell
 */
function bumpSpellCast(t, attacker, spell) {
    if (!t || !attacker || attacker.type !== 'player') return;
    const id = spellCastId(spell);
    const kind = spellCastKind(spell);
    const isAuto = isAutoAttackSpell(spell);

    if (!t.spellsCastById) t.spellsCastById = Object.create(null);
    if (!t.spellsCastByKind) t.spellsCastByKind = Object.create(null);
    t.spellsCastById[id] = (t.spellsCastById[id] || 0) + 1;
    t.spellsCastByKind[kind] = (t.spellsCastByKind[kind] || 0) + 1;

    if (!attacker.spellsCastById) attacker.spellsCastById = Object.create(null);
    if (!attacker.spellsCastByKind) attacker.spellsCastByKind = Object.create(null);
    attacker.spellsCastById[id] = (attacker.spellsCastById[id] || 0) + 1;
    attacker.spellsCastByKind[kind] = (attacker.spellsCastByKind[kind] || 0) + 1;

    if (isAuto) {
        t.autoAttacks = (t.autoAttacks || 0) + 1;
        attacker.autoAttacks = (attacker.autoAttacks || 0) + 1;
    } else {
        t.spellsCast = (t.spellsCast || 0) + 1;
        attacker.spellsCast = (attacker.spellsCast || 0) + 1;
    }
}

/**
 * Sample one resolveAttack result into telemetry (mutates t).
 * Caller still owns kill awards / party counters.
 *
 * @param {object} t telemetry bag
 * @param {object|null} attacker
 * @param {object|null} defender
 * @param {object} result resolveAttack result
 * @returns {{ dealt: number, healing: number, element: string }}
 */
function sampleAttack(t, attacker, defender, result) {
    const out = { dealt: 0, healing: 0, element: 'physical' };
    if (!t || !result || !result.ok) return out;

    t.attacks += 1;
    if (result.hit) {
        t.hits += 1;
        if (result.critical) t.crits += 1;
        if (result.fatal) t.fatals += 1;
    } else {
        t.misses += 1;
    }

    const spell = result.spell || null;
    // Party cast counters (auto + strategy spells); creatures ignored.
    if (attacker && attacker.type === 'player') {
        bumpSpellCast(t, attacker, spell);
    }
    const element =
        (spell && spell.element) ||
        (result.breakdown && result.breakdown.element) ||
        'physical';
    out.element = element;

    const manaCost =
        spell && spell.mana != null ? Math.max(0, Math.floor(Number(spell.mana) || 0)) : 0;
    if (manaCost > 0 && attacker && attacker.type === 'player') {
        t.manaSpent += manaCost;
        t.consumables.mana += manaCost;
        attacker.manaSpent = (attacker.manaSpent || 0) + manaCost;
    }

    // Phase D skill try / ML telemetry from resolveAttack.skillProgress
    sampleSkillProgress(t, attacker, defender, result);

    if (!result.hit) return out;

    // Healing: positive hpDelta
    if (element === 'healing') {
        const healed = Math.max(0, result.hpDelta || result.final || 0);
        out.healing = healed;
        if (healed > 0) {
            t.healingDone += healed;
            bumpElement(t.damageDealtByElement, 'healing', healed);
        }
        return out;
    }

    const dmg = Math.max(0, result.final != null ? result.final : -result.hpDelta);
    out.dealt = dmg;
    if (!(dmg > 0)) return out;

    if (attacker && attacker.type === 'player') {
        t.damageDealt += dmg;
        bumpElement(t.damageDealtByElement, element, dmg);
    } else if (attacker && attacker.type === 'creature') {
        t.damageTaken += dmg;
        bumpElement(t.damageTakenByElement, element, dmg);
    }

    return out;
}

/**
 * Roll skill progression counters from a resolve result into session telemetry.
 * Player bags are already updated in resolveAttack; this only fills session totals.
 *
 * @param {object} t
 * @param {object|null} attacker
 * @param {object|null} defender
 * @param {object} result
 */
function sampleSkillProgress(t, attacker, defender, result) {
    if (!t || !result) return;
    const sp = result.skillProgress;
    if (sp) {
        if (sp.weaponAdvance && sp.weaponAdvance.effectiveTries > 0) {
            const n = sp.weaponAdvance.effectiveTries;
            const bag = sp.weaponAdvance.skill || sp.weaponSkill || 'melee';
            t.skillTriesGained = (t.skillTriesGained || 0) + n;
            if (!t.skillTriesByBag) t.skillTriesByBag = Object.create(null);
            t.skillTriesByBag[bag] = (t.skillTriesByBag[bag] || 0) + n;
            if (sp.weaponAdvance.levelsGained > 0) {
                t.skillLevelsGained =
                    (t.skillLevelsGained || 0) + sp.weaponAdvance.levelsGained;
            }
        }
        if (sp.shieldAdvance && sp.shieldAdvance.effectiveTries > 0) {
            const n = sp.shieldAdvance.effectiveTries;
            t.skillTriesGained = (t.skillTriesGained || 0) + n;
            if (!t.skillTriesByBag) t.skillTriesByBag = Object.create(null);
            t.skillTriesByBag.shielding =
                (t.skillTriesByBag.shielding || 0) + n;
            if (sp.shieldAdvance.levelsGained > 0) {
                t.skillLevelsGained =
                    (t.skillLevelsGained || 0) + sp.shieldAdvance.levelsGained;
            }
        }
    }
    if (result.manaProgress && result.manaProgress.mana > 0) {
        t.manaSpentTowardMagic =
            (t.manaSpentTowardMagic || 0) + result.manaProgress.mana;
        if (result.manaProgress.levelsGained > 0) {
            t.magicLevelsGained =
                (t.magicLevelsGained || 0) + result.manaProgress.levelsGained;
        }
    }
}

/**
 * Record a creature kill award (exp/loot). Mutates t.
 *
 * Phase C: pass a bag `{ exp, rawExp, loot, levelUps }` so session totals
 * distinguish awarded (with rates) vs raw (party share only). Legacy
 * `sampleKill(t, exp, loot)` still works (raw defaults to exp).
 *
 * @param {object} t
 * @param {number|{ exp?: number, awarded?: number, rawExp?: number, raw?: number, loot?: number, levelUps?: number }} [expOrBag=0]
 * @param {number} [loot=0]
 */
function sampleKill(t, expOrBag, loot) {
    if (!t) return;
    t.kills += 1;
    if (expOrBag && typeof expOrBag === 'object') {
        const awarded = Math.max(
            0,
            Number(
                expOrBag.exp != null
                    ? expOrBag.exp
                    : expOrBag.awarded != null
                      ? expOrBag.awarded
                      : 0
            ) || 0
        );
        const raw = Math.max(
            0,
            Number(
                expOrBag.rawExp != null
                    ? expOrBag.rawExp
                    : expOrBag.raw != null
                      ? expOrBag.raw
                      : awarded
            ) || 0
        );
        const lootN = Math.max(
            0,
            Number(expOrBag.loot != null ? expOrBag.loot : loot) || 0
        );
        const ups = Math.max(0, Math.floor(Number(expOrBag.levelUps) || 0));
        t.expGained += awarded;
        t.rawExpGained = (t.rawExpGained || 0) + raw;
        t.lootGained += lootN;
        if (ups) t.levelUps = (t.levelUps || 0) + ups;
        return;
    }
    const e = Math.max(0, Number(expOrBag) || 0);
    const l = Math.max(0, Number(loot) || 0);
    t.expGained += e;
    t.rawExpGained = (t.rawExpGained || 0) + e;
    t.lootGained += l;
}

/**
 * Record a player death. Mutates t.
 * @param {object} t
 */
function sampleDeath(t) {
    if (!t) return;
    t.deaths += 1;
}

/**
 * Record a potion / item consumable use (future Stage 7+ UI).
 * @param {object} t
 * @param {'mana'|'potion'|string} kind
 * @param {number} [count=1]
 * @param {{ timeSec?: number }} [meta]
 */
function sampleConsumable(t, kind, count, meta) {
    if (!t || !t.consumables) return;
    const n = count != null ? Math.max(0, Math.floor(Number(count) || 0)) : 1;
    if (kind === 'mana') {
        t.consumables.mana += n;
        t.manaSpent += n;
    } else if (kind === 'potion' || kind === 'potions') {
        t.consumables.potions += n;
        if (meta && meta.timeSec != null) {
            samplePacingEvent(t, {
                kind: 'consumable',
                t: meta.timeSec,
                tag: 'potion'
            });
        }
    }
}

/**
 * Optional macro / floor fields copied onto pacing events when present.
 * Used by Stage 11.10 runtime biome_transition samples.
 * @type {string[]}
 */
const PACING_EVENT_META_KEYS = [
    'fromBiomeId',
    'toBiomeId',
    'fromArtSet',
    'toArtSet',
    'fromZ',
    'toZ',
    'fromSegment',
    'toSegment'
];

/**
 * Append a pacing event (mutates t.events).
 * @param {object} t telemetry bag
 * @param {{
 *   t: number,
 *   kind: string,
 *   tag?: string|null,
 *   entityId?: number|string|null,
 *   fromBiomeId?: string|null,
 *   toBiomeId?: string|null,
 *   fromArtSet?: string|null,
 *   toArtSet?: string|null,
 *   fromZ?: string|number|null,
 *   toZ?: string|number|null,
 *   fromSegment?: number|null,
 *   toSegment?: number|null
 * }} ev
 */
function samplePacingEvent(t, ev) {
    if (!t || !ev) return;
    if (!Array.isArray(t.events)) t.events = [];
    const row = {
        t: Math.max(0, Number(ev.t) || 0),
        kind: ev.kind ? String(ev.kind) : 'other'
    };
    if (ev.tag != null && ev.tag !== '') row.tag = String(ev.tag);
    if (ev.entityId != null) row.entityId = ev.entityId;
    for (let i = 0; i < PACING_EVENT_META_KEYS.length; i++) {
        const k = PACING_EVENT_META_KEYS[i];
        if (ev[k] != null && ev[k] !== '') row[k] = ev[k];
    }
    t.events.push(row);
}

/**
 * Stage 11.10: party stair-hopped into a different biome / art segment.
 * Mutates t.events with kind `biome_transition`. Dedup is caller's job
 * (Simulator tracks seen fromZ→toZ keys so multi-member parties do not spam).
 *
 * @param {object} t
 * @param {{
 *   t: number,
 *   fromBiomeId?: string|null,
 *   toBiomeId?: string|null,
 *   fromArtSet?: string|null,
 *   toArtSet?: string|null,
 *   fromZ?: string|number|null,
 *   toZ?: string|number|null,
 *   fromSegment?: number|null,
 *   toSegment?: number|null,
 *   entityId?: number|string|null,
 *   tag?: string|null
 * }} ev
 * @returns {boolean} true when an event was appended
 */
function sampleBiomeTransition(t, ev) {
    if (!t || !ev) return false;
    samplePacingEvent(t, {
        kind: 'biome_transition',
        t: Math.max(0, Number(ev.t) || 0),
        tag: ev.tag != null && ev.tag !== '' ? String(ev.tag) : 'biome_transition',
        entityId: ev.entityId != null ? ev.entityId : null,
        fromBiomeId: ev.fromBiomeId != null ? String(ev.fromBiomeId) : null,
        toBiomeId: ev.toBiomeId != null ? String(ev.toBiomeId) : null,
        fromArtSet: ev.fromArtSet != null ? String(ev.fromArtSet) : null,
        toArtSet: ev.toArtSet != null ? String(ev.toArtSet) : null,
        fromZ: ev.fromZ != null ? ev.fromZ : null,
        toZ: ev.toZ != null ? ev.toZ : null,
        fromSegment: ev.fromSegment != null ? ev.fromSegment : null,
        toSegment: ev.toSegment != null ? ev.toSegment : null
    });
    return true;
}

/**
 * First party damage on a creature → combat-touch event (once per entity id).
 * @param {object} t
 * @param {number|string|null|undefined} entityId
 * @param {number} timeSec
 * @param {string|null|undefined} [tag]
 * @returns {boolean} true if a new event was recorded
 */
function sampleCombatTouch(t, entityId, timeSec, tag) {
    if (!t) return false;
    if (entityId != null) {
        if (!t.combatTouchedIds) t.combatTouchedIds = new Set();
        if (t.combatTouchedIds.has(entityId)) return false;
        t.combatTouchedIds.add(entityId);
    }
    samplePacingEvent(t, {
        kind: 'combat',
        t: timeSec,
        tag: tag || null,
        entityId: entityId != null ? entityId : null
    });
    return true;
}

/**
 * Stage 11.2: party used a prop (break / loot / heal / well). Mutates t.
 * Counts as micro-loop interactive (kind `prop`; well also mid-loop tag).
 *
 * @param {object} t
 * @param {{
 *   t: number,
 *   effect?: string|null,
 *   tag?: string|null,
 *   entityId?: number|string|null,
 *   objectId?: string|null,
 *   loot?: number,
 *   heal?: number
 * }} ev
 */
function samplePropUse(t, ev) {
    if (!t || !ev) return;
    t.propsUsed = (t.propsUsed || 0) + 1;
    const loot = Math.max(0, Number(ev.loot) || 0);
    if (loot > 0) t.lootGained = (t.lootGained || 0) + loot;
    const heal = Math.max(0, Number(ev.heal) || 0);
    if (heal > 0) t.healingDone = (t.healingDone || 0) + heal;
    const effect = ev.effect != null ? String(ev.effect) : 'break';
    const tag =
        ev.tag != null && ev.tag !== ''
            ? String(ev.tag)
            : effect === 'well'
              ? 'well'
              : effect;
    samplePacingEvent(t, {
        kind: effect === 'well' ? 'well' : 'prop',
        t: Math.max(0, Number(ev.t) || 0),
        tag,
        entityId: ev.entityId != null ? ev.entityId : null
    });
}

/**
 * Snapshot element maps (plain objects, no prototypes).
 * @param {Record<string, number>|null|undefined} map
 * @returns {Record<string, number>}
 */
function cloneElementMap(map) {
    const out = emptyElementMap();
    if (!map) return out;
    for (const k of Object.keys(map)) {
        out[k] = map[k] || 0;
    }
    return out;
}

/**
 * Build analysis-ready hunt summary from session state + telemetry.
 *
 * @param {object} opts
 * @param {object} opts.telemetry
 * @param {number} [opts.seed]
 * @param {string|number|null} [opts.floor]
 * @param {number} [opts.tickCount]
 * @param {string} [opts.sessionState]
 * @param {boolean} [opts.routeComplete]
 * @param {boolean} [opts.partyWipe]
 * @param {object[]} [opts.parties] getPartyPositions() style
 * @param {number} [opts.frames] logic frames actually run
 * @param {number} [opts.maxFrames]
 * @param {string|null} [opts.huntId]
 * @param {number} [opts.timeSinceLevelLoad] sim seconds
 * @param {number} [opts.logicDt]
 * @param {object} [opts.limits] { maxFrames, maxSeconds, maxKills }
 * @param {object} [opts.config] echo of resolved hunt knobs (seed, floor, …)
 * @param {object|null} [opts.pacingBudget] Stage 11.0 budget (optional)
 * @param {object|null} [opts.layoutMeta] Stage 11.10 macro layout (optional)
 * @param {object|null} [opts.waves] WaveController snapshot (optional)
 * @returns {object}
 */
function buildHuntSummary(opts) {
    const o = opts || {};
    const t = o.telemetry || createEmptyHuntTelemetry();
    const tickCount =
        o.tickCount != null
            ? o.tickCount
            : t.endTick != null
              ? t.endTick
              : 0;
    const logicDt = o.logicDt != null ? o.logicDt : LOGIC_DT;
    const timeSec =
        o.timeSinceLevelLoad != null
            ? o.timeSinceLevelLoad
            : tickCount * logicDt;

    const endReason =
        t.endReason ||
        (o.sessionState && o.sessionState !== 'running' ? o.sessionState : null);

    if (t.endTick == null && o.sessionState && o.sessionState !== 'running') {
        t.endTick = tickCount;
    }

    const hits = t.hits || 0;
    const attacks = t.attacks || 0;
    const kills = t.kills || 0;

    const events = Array.isArray(t.events)
        ? t.events.map((e) => clonePacingEvent(e))
        : [];

    const metrics = buildPacingMetrics({
        events,
        timeSec,
        kills
    });

    const layoutMeta =
        o.layoutMeta && typeof o.layoutMeta === 'object' ? o.layoutMeta : null;

    const budget = normalizeBudget(o.pacingBudget);
    const evaluation = budget
        ? evaluatePacing(
              {
                  kills,
                  timeToClear: timeSec,
                  pacing: { metrics, events },
                  layoutMeta
              },
              budget
          )
        : {
              status: 'skipped',
              budgetId: null,
              checks: [],
              metrics
          };

    const commandHistory = Array.isArray(o.commandHistory)
        ? o.commandHistory.map((c) => JSON.parse(JSON.stringify(c)))
        : Array.isArray(t.commandHistory)
          ? t.commandHistory.map((c) => JSON.parse(JSON.stringify(c)))
          : [];

    return {
        schemaVersion: 1,
        seed: o.seed != null ? o.seed : null,
        huntId: o.huntId != null ? o.huntId : null,
        floor: o.floor != null ? o.floor : null,
        tickCount,
        frames: o.frames != null ? o.frames : tickCount,
        maxFrames: o.maxFrames != null ? o.maxFrames : null,
        timeSinceLevelLoad: timeSec,
        logicDt,
        logicUps: LOGIC_UPS,
        sessionState: o.sessionState || 'idle',
        endReason,
        routeComplete: !!o.routeComplete,
        partyWipe: !!o.partyWipe,
        /**
         * Sequential arena waves snapshot (null when hunt has no waves).
         * @type {object|null}
         */
        waves:
            o.waves && typeof o.waves === 'object'
                ? {
                      phase: o.waves.phase != null ? String(o.waves.phase) : null,
                      waveIndex:
                          o.waves.waveIndex != null
                              ? Number(o.waves.waveIndex)
                              : -1,
                      waveId:
                          o.waves.waveId != null
                              ? String(o.waves.waveId)
                              : null,
                      waveLabel:
                          o.waves.waveLabel != null
                              ? String(o.waves.waveLabel)
                              : null,
                      wavesCompleted:
                          o.waves.wavesCompleted != null
                              ? Number(o.waves.wavesCompleted)
                              : 0,
                      totalWaves:
                          o.waves.totalWaves != null
                              ? Number(o.waves.totalWaves)
                              : 0
                  }
                : null,
        /** Sim seconds until session ended (time-to-clear when route/wipe/kill_cap/waves). */
        timeToClear: timeSec,
        kills,
        deaths: t.deaths || 0,
        damageDealt: t.damageDealt || 0,
        damageTaken: t.damageTaken || 0,
        damageDealtByElement: cloneElementMap(t.damageDealtByElement),
        damageTakenByElement: cloneElementMap(t.damageTakenByElement),
        healingDone: t.healingDone || 0,
        expGained: t.expGained || 0,
        /** Party-share raw exp (before personal rate modifiers). */
        rawExpGained: t.rawExpGained || 0,
        levelUps: t.levelUps || 0,
        lootGained: t.lootGained || 0,
        /** Awarded experience per simulated hour. */
        expPerHour: ratePerHour(t.expGained, timeSec),
        /** Raw (party-share only) experience per simulated hour. */
        rawExpPerHour: ratePerHour(t.rawExpGained || 0, timeSec),
        damageDealtPerHour: ratePerHour(t.damageDealt, timeSec),
        damageTakenPerHour: ratePerHour(t.damageTaken, timeSec),
        killsPerHour: ratePerHour(t.kills, timeSec),
        attacks: attacks,
        hits: hits,
        crits: t.crits || 0,
        fatals: t.fatals || 0,
        misses: t.misses || 0,
        /** Party weapon auto swings this session. */
        autoAttacks: t.autoAttacks || 0,
        /** Estimated auto attacks per simulated hour. */
        autoAttacksPerHour: ratePerHour(t.autoAttacks, timeSec),
        /** Party non-auto spell casts (strategy / heal / strike). */
        spellsCast: t.spellsCast || 0,
        spellsCastPerHour: ratePerHour(t.spellsCast, timeSec),
        spellsCastById: cloneCountMap(t.spellsCastById),
        spellsCastByKind: cloneCountMap(t.spellsCastByKind),
        hitRate: attacks > 0 ? hits / attacks : 0,
        creaturesSpawned: t.creaturesSpawned || 0,
        creaturesAlive:
            o.creaturesAlive != null ? o.creaturesAlive : null,
        propsSpawned: t.propsSpawned || 0,
        propsUsed: t.propsUsed || 0,
        propsAlive: o.propsAlive != null ? o.propsAlive : null,
        manaSpent: t.manaSpent || 0,
        /** Phase D skill try counters (always honest when D ships). */
        skillTriesGained: t.skillTriesGained || 0,
        skillTriesByBag: cloneCountMap(t.skillTriesByBag),
        manaSpentTowardMagic: t.manaSpentTowardMagic || 0,
        skillLevelsGained: t.skillLevelsGained || 0,
        magicLevelsGained: t.magicLevelsGained || 0,
        consumables: {
            mana: (t.consumables && t.consumables.mana) || 0,
            potions: (t.consumables && t.consumables.potions) || 0
        },
        limits: o.limits || null,
        config: o.config || null,
        parties: Array.isArray(o.parties) ? o.parties : [],
        /** Stage 11.10: multi-biome layout meta when the hunt provides it. */
        layoutMeta: layoutMeta,
        /**
         * Stage 11.0 pacing (Blueprint Phase 1 metrics).
         * Stage 11.10: runtime biome_transition events feed macro metrics.
         */
        pacing: {
            budget,
            events,
            metrics,
            evaluation: {
                status: evaluation.status,
                budgetId: evaluation.budgetId,
                checks: evaluation.checks
            }
        },
        commandHistory
    };
}

/**
 * Plain copy of a pacing event for summaries (no prototypes).
 * @param {object} e
 * @returns {object}
 */
function clonePacingEvent(e) {
    if (!e || typeof e !== 'object') {
        return { t: 0, kind: 'other' };
    }
    const row = {
        t: e.t,
        kind: e.kind
    };
    if (e.tag != null) row.tag = e.tag;
    if (e.entityId != null) row.entityId = e.entityId;
    for (let i = 0; i < PACING_EVENT_META_KEYS.length; i++) {
        const k = PACING_EVENT_META_KEYS[i];
        if (e[k] != null && e[k] !== '') row[k] = e[k];
    }
    return row;
}

/**
 * Core fields used for seed-stability asserts (ignore wall-clock / paths).
 * @param {object} summary
 * @returns {object}
 */
function summaryCore(summary) {
    const s = summary || {};
    const pacingEvents =
        s.pacing && Array.isArray(s.pacing.events)
            ? s.pacing.events.map((e) => {
                  const row = {
                      t: e.t,
                      kind: e.kind,
                      tag: e.tag != null ? e.tag : undefined
                  };
                  // Seed-stable macro fields when present
                  if (e.fromBiomeId != null) row.fromBiomeId = e.fromBiomeId;
                  if (e.toBiomeId != null) row.toBiomeId = e.toBiomeId;
                  if (e.fromArtSet != null) row.fromArtSet = e.fromArtSet;
                  if (e.toArtSet != null) row.toArtSet = e.toArtSet;
                  if (e.fromZ != null) row.fromZ = e.fromZ;
                  if (e.toZ != null) row.toZ = e.toZ;
                  return row;
              })
            : [];
    return {
        seed: s.seed,
        huntId: s.huntId,
        floor: s.floor,
        tickCount: s.tickCount,
        sessionState: s.sessionState,
        endReason: s.endReason,
        routeComplete: !!s.routeComplete,
        partyWipe: !!s.partyWipe,
        waves: s.waves
            ? {
                  phase: s.waves.phase,
                  waveIndex: s.waves.waveIndex,
                  waveId: s.waves.waveId,
                  wavesCompleted: s.waves.wavesCompleted,
                  totalWaves: s.waves.totalWaves
              }
            : null,
        kills: s.kills,
        deaths: s.deaths,
        damageDealt: s.damageDealt,
        damageTaken: s.damageTaken,
        damageDealtByElement: s.damageDealtByElement,
        damageTakenByElement: s.damageTakenByElement,
        healingDone: s.healingDone,
        expGained: s.expGained,
        lootGained: s.lootGained,
        attacks: s.attacks,
        hits: s.hits,
        crits: s.crits,
        fatals: s.fatals || 0,
        misses: s.misses,
        autoAttacks: s.autoAttacks || 0,
        spellsCast: s.spellsCast || 0,
        spellsCastById: s.spellsCastById || {},
        spellsCastByKind: s.spellsCastByKind || {},
        manaSpent: s.manaSpent,
        creaturesSpawned: s.creaturesSpawned,
        propsSpawned: s.propsSpawned || 0,
        propsUsed: s.propsUsed || 0,
        /** Seed-stable pacing event timestamps (budget eval excluded). */
        pacingEvents,
        commandHistory: Array.isArray(s.commandHistory) ? s.commandHistory : []
    };
}

/**
 * Deep-stable JSON stringify for deterministic summary compares / files.
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
    return JSON.stringify(value, replacerSorted, 2);
}

function replacerSorted(_key, val) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
        const sorted = {};
        const keys = Object.keys(val).sort();
        for (let i = 0; i < keys.length; i++) {
            sorted[keys[i]] = val[keys[i]];
        }
        return sorted;
    }
    return val;
}

module.exports = {
    DAMAGE_ELEMENTS,
    LOGIC_DT,
    LOGIC_UPS,
    PACING_EVENT_META_KEYS,
    createEmptyHuntTelemetry,
    createEmptyTelemetry,
    emptyElementMap,
    bumpElement,
    ratePerHour,
    isAutoAttackSpell,
    spellCastId,
    spellCastKind,
    cloneCountMap,
    bumpSpellCast,
    sampleAttack,
    sampleKill,
    sampleDeath,
    sampleConsumable,
    samplePacingEvent,
    sampleBiomeTransition,
    sampleCombatTouch,
    samplePropUse,
    cloneElementMap,
    clonePacingEvent,
    buildHuntSummary,
    summaryCore,
    stableStringify
};
