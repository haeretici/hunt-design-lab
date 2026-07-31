/**
 * Hunt AI orchestrator (Stage 5).
 * Ticks player + creature FSMs once per logic frame (when cadence allows).
 *
 * Creature brains follow legacy tilesToUpdate style: only living creatures near
 * party members (or still non-idle / sticky-target) run AI — big win when many
 * eager slots or on_demand dens stay materialised.
 *
 * Scale path:
 *   Etapa 0–1 — SpatialIndex gather (sim.creatureSpatialIndex / aiPerf)
 *   Etapa 2   — live population caps (SpawnManager idle AOI / max living)
 *   Etapa 3   — selective Creature.update (simSleeping freezes CD / moveDelay)
 *   Etapa 4   — unified AOI frame cache (enemies / sleep / tick share one query)
 *   Etapa 5   — player SpatialIndex (aggro O(local)) + AI_PATH_BUDGET_PER_FRAME
 */

const { Settings } = require('../../../settings.js');
const { StateMachine } = require('../fsm.js');
const {
    FollowWaypoint,
    FollowLeader,
    initialPlayerState,
    combatMove
} = require('./player_states.js');
const {
    initialCreatureState,
    tryEngagedAttacks
} = require('./creature_states.js');
const { allPartyMembers, living } = require('./targeting.js');
const { tileDistance } = require('../movement.js');
const { resolveStrategy, indexStrategies, DEFAULT_STRATEGIES } =
    require('./strategy.js');
const { indexSpells } = require('../combat/resolve.js');
const { brainReady } = require('./cadence.js');
const { ensureCreatureKit } = require('./creature_kit.js');
const { SpatialIndex } = require('../spatial_index.js');
const { Time } = require('../time.js');
const {
    isMoveUnlocked,
    tryAutoAttack,
    tryAttack,
    stepToward
} = require('./combat_actions.js');

/**
 * Empty per-frame AI performance counters.
 * @returns {{
 *   creaturesIterated: number,
 *   distanceChecks: number,
 *   brainsExecuted: number,
 *   brainsConsidered: number,
 *   enemiesListed: number,
 *   spatialCandidates: number,
 *   stickyCandidates: number,
 *   usedSpatial: boolean,
 *   aoiBuilt: number,
 *   aoiCacheHits: number
 * }}
 */
function createAiPerfFrame() {
    return {
        creaturesIterated: 0,
        distanceChecks: 0,
        brainsExecuted: 0,
        brainsConsidered: 0,
        enemiesListed: 0,
        spatialCandidates: 0,
        stickyCandidates: 0,
        usedSpatial: false,
        aoiBuilt: 0,
        aoiCacheHits: 0
    };
}

/**
 * Empty per-frame selective-update (sleep) counters.
 * @returns {{
 *   living: number,
 *   awake: number,
 *   asleep: number,
 *   woke: number,
 *   slept: number,
 *   sleepEnabled: boolean
 * }}
 */
function createUpdatePerfFrame() {
    return {
        living: 0,
        awake: 0,
        asleep: 0,
        woke: 0,
        slept: 0,
        sleepEnabled: false
    };
}

/**
 * @param {object} sim
 * @param {object} frame
 */
function endUpdatePerfFrame(sim, frame) {
    if (!sim || !frame) return;
    sim.updatePerf = frame;
    if (!sim.updatePerfTotals) {
        sim.updatePerfTotals = createUpdatePerfFrame();
        sim.updatePerfTotals.frames = 0;
    }
    const t = sim.updatePerfTotals;
    if (t.frames == null) t.frames = 0;
    t.frames += 1;
    t.living += frame.living;
    t.awake += frame.awake;
    t.asleep += frame.asleep;
    t.woke += frame.woke;
    t.slept += frame.slept;
    t.sleepEnabled = t.sleepEnabled || frame.sleepEnabled;
}

/**
 * Whether selective creature sleep is active for this frame.
 * Off when AI_CREATURE_SLEEP is false or AI_TICK_RADIUS is 0 (all awake).
 * @returns {boolean}
 */
function isCreatureSleepEnabled() {
    if (Settings.AI_CREATURE_SLEEP === false) return false;
    const r = resolveAiTickRadius();
    return r > 0;
}

/**
 * Ensure sim.aiPerf exists and is reset for this frame.
 * @param {object} sim
 * @returns {object}
 */
function beginAiPerfFrame(sim) {
    const frame = createAiPerfFrame();
    if (!sim) return frame;
    sim.aiPerf = frame;
    if (!sim.aiPerfTotals) {
        sim.aiPerfTotals = createAiPerfFrame();
        sim.aiPerfTotals.frames = 0;
    }
    return frame;
}

/**
 * Fold frame counters into running totals (call at end of tickHuntAi).
 * @param {object} sim
 * @param {object} frame
 */
function endAiPerfFrame(sim, frame) {
    if (!sim || !frame) return;
    const t = sim.aiPerfTotals || (sim.aiPerfTotals = createAiPerfFrame());
    if (t.frames == null) t.frames = 0;
    t.frames += 1;
    t.creaturesIterated += frame.creaturesIterated;
    t.distanceChecks += frame.distanceChecks;
    t.brainsExecuted += frame.brainsExecuted;
    t.brainsConsidered += frame.brainsConsidered;
    t.enemiesListed += frame.enemiesListed;
    t.spatialCandidates += frame.spatialCandidates;
    t.stickyCandidates += frame.stickyCandidates;
    t.usedSpatial = t.usedSpatial || frame.usedSpatial;
    t.aoiBuilt = (t.aoiBuilt || 0) + (frame.aoiBuilt || 0);
    t.aoiCacheHits = (t.aoiCacheHits || 0) + (frame.aoiCacheHits || 0);
}

/**
 * Chebyshev radius for creature AI ticks (legacy PLAYER_UPDATE_RADIUS).
 * 0 = tick every living creature (filter off).
 * @returns {number}
 */
function resolveAiTickRadius() {
    const r = Settings.AI_TICK_RADIUS;
    if (r == null) return 10;
    const n = Number(r);
    if (!Number.isFinite(n) || n < 0) return 10;
    return n;
}

/**
 * Chunk size for creature spatial index (AI gather).
 * @returns {number}
 */
function resolveAiSpatialChunkSize() {
    const raw =
        Settings.AI_SPATIAL_CHUNK_SIZE != null
            ? Settings.AI_SPATIAL_CHUNK_SIZE
            : Settings.SPAWN_CHUNK_SIZE;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return 32;
    return Math.max(1, n | 0);
}

/**
 * True when creature keeps ticking regardless of proximity (leash / combat).
 * @param {object} creature
 * @returns {boolean}
 */
function isCreatureAlwaysTick(creature) {
    if (!creature) return false;
    if (creature.target || creature.targetId != null) return true;
    const state = creature.aiState;
    return !!(state && state !== 'idle');
}

/**
 * True when creature is within Chebyshev radius of any living observer (same z).
 * @param {object} creature
 * @param {object[]} observers living party members with tile
 * @param {number} radius
 * @param {object} [perf] optional counters
 * @returns {boolean}
 */
function isCreatureNearObservers(creature, observers, radius, perf) {
    if (!creature || !creature.tile || !observers || !observers.length) {
        return false;
    }
    if (radius < 0) return false;
    const cz = String(creature.tile.z);
    for (let i = 0; i < observers.length; i++) {
        const o = observers[i];
        if (!o || !o.tile) continue;
        if (String(o.tile.z) !== cz) continue;
        if (perf) perf.distanceChecks += 1;
        if (tileDistance(creature.tile, o.tile) <= radius) return true;
    }
    return false;
}

/**
 * Whether a creature brain should run this frame (legacy tilesToUpdate).
 * Near any living party member, or still engaged / leashing (non-idle / sticky).
 * Radius 0 disables the proximity filter (tick all living).
 *
 * @param {object} creature
 * @param {object[]} observers
 * @param {number} radius
 * @param {object} [perf]
 * @returns {boolean}
 */
function shouldTickCreatureAi(creature, observers, radius, perf) {
    if (!creature || creature.alive === false) return false;
    if (creature.hp && creature.hp.current <= 0) return false;
    // Keep combat / leash FSM alive even if the party briefly leaves the cell
    if (isCreatureAlwaysTick(creature)) return true;
    if (radius <= 0) return true;
    return isCreatureNearObservers(creature, observers, radius, perf);
}

/**
 * Attach / rebuild sim.creatureSpatialIndex from the live creature list when dirty.
 * Set sim.creatureSpatialIndex = false to force linear gather (debug).
 *
 * @param {object} sim
 * @returns {SpatialIndex|null}
 */
function ensureCreatureSpatialIndex(sim) {
    if (!sim || sim.creatureSpatialIndex === false) return null;

    if (!sim.creatureSpatialIndex) {
        sim.creatureSpatialIndex = new SpatialIndex({
            chunkSize: resolveAiSpatialChunkSize()
        });
        sim._creatureSpatialDirty = true;
    }

    const idx = sim.creatureSpatialIndex;
    const list = sim.creatures || [];
    if (
        sim._creatureSpatialDirty ||
        idx.size !== list.length
    ) {
        idx.rebuild(list);
        sim._creatureSpatialDirty = false;
    }
    return idx;
}

/**
 * Mark spatial index dirty (call after bulk creature list mutations).
 * Also drops the AOI frame cache so the next gather rebuilds.
 * @param {object} sim
 */
function markCreatureSpatialDirty(sim) {
    if (!sim) return;
    sim._creatureSpatialDirty = true;
    sim._aoiFrame = null;
}

/**
 * Attach / rebuild sim.playerSpatialIndex from living party members when dirty.
 * Set sim.playerSpatialIndex = false to force linear player scans (debug).
 * Creature aggro / shaped kit use this for O(local chunks) instead of O(P).
 *
 * @param {object} sim
 * @returns {SpatialIndex|null}
 */
function ensurePlayerSpatialIndex(sim) {
    if (!sim || sim.playerSpatialIndex === false) return null;

    if (!sim.playerSpatialIndex) {
        sim.playerSpatialIndex = new SpatialIndex({
            chunkSize: resolveAiSpatialChunkSize()
        });
        sim._playerSpatialDirty = true;
    }

    const idx = sim.playerSpatialIndex;
    const list = living(allPartyMembers(sim));
    if (sim._playerSpatialDirty || idx.size !== list.length) {
        idx.rebuild(list);
        sim._playerSpatialDirty = false;
    }
    return idx;
}

/**
 * Mark player spatial index dirty (party spawn/remove, bulk moves).
 * @param {object} sim
 */
function markPlayerSpatialDirty(sim) {
    if (!sim) return;
    sim._playerSpatialDirty = true;
}

/**
 * Stable cache key for observers + radius + logic time + spatial mode.
 * Spatial mode is part of the key so forcing `creatureSpatialIndex = false`
 * never reuses a spatial-built frame (and vice versa).
 *
 * @param {object[]} observers
 * @param {number} radius
 * @param {boolean} useSpatial
 * @returns {string}
 */
function aoiFrameCacheKey(observers, radius, useSpatial) {
    const ids = [];
    if (observers) {
        for (let i = 0; i < observers.length; i++) {
            const o = observers[i];
            if (o && o.id != null) ids.push(String(o.id));
        }
    }
    ids.sort();
    return `${Time.timeSinceLevelLoad}|${radius}|s${useSpatial ? 1 : 0}|${ids.join(',')}`;
}

/**
 * Build (or reuse) the per-logic-frame AOI snapshot shared by sleep, enemy
 * list, and creature brain gather.
 *
 * Frame fields:
 *   enemies — living hostiles near any observer (player scans / shapes)
 *   active  — enemies ∪ sticky / non-idle (brains + sleep membership)
 *   activeIds — Set of active ids
 *   usedSpatial — true when SpatialIndex path ran
 *
 * @param {object} sim
 * @param {object[]} observers
 * @param {number} radius
 * @param {object} [perf]
 * @returns {{
 *   key: string,
 *   stamp: number,
 *   radius: number,
 *   observers: object[],
 *   enemies: object[],
 *   active: object[],
 *   activeIds: Set<string|number>,
 *   usedSpatial: boolean
 * }}
 */
function ensureAoiFrame(sim, observers, radius, perf) {
    const obs = observers || [];
    const r = radius != null ? Number(radius) : resolveAiTickRadius();
    // Detect spatial preference without rebuilding yet (false disables index).
    const wantSpatial = !!(sim && sim.creatureSpatialIndex !== false);
    const key = aoiFrameCacheKey(obs, r, wantSpatial);
    const p = perf || null;

    if (
        sim &&
        sim._aoiFrame &&
        sim._aoiFrame.key === key
    ) {
        if (p) p.aoiCacheHits = (p.aoiCacheHits || 0) + 1;
        // Fold spatial flag so later consumers still mark the frame usedSpatial
        if (p && sim._aoiFrame.usedSpatial) p.usedSpatial = true;
        return sim._aoiFrame;
    }

    if (p) p.aoiBuilt = (p.aoiBuilt || 0) + 1;

    /** @type {Map<string|number, object>} */
    const enemyById = new Map();
    /** @type {Map<string|number, object>} */
    const activeById = new Map();
    let usedSpatial = false;

    const creatures = (sim && sim.creatures) || [];

    if (r <= 0) {
        const all = living(creatures);
        if (p) p.creaturesIterated += creatures.length;
        for (let i = 0; i < all.length; i++) {
            const c = all[i];
            if (!c || c.id == null) continue;
            enemyById.set(c.id, c);
            activeById.set(c.id, c);
        }
    } else {
        // Sticky / non-idle always active (leash / combat finish) — one O(C) pass
        for (let i = 0; i < creatures.length; i++) {
            const c = creatures[i];
            if (p) p.creaturesIterated += 1;
            if (!c || c.alive === false) continue;
            if (c.hp && c.hp.current <= 0) continue;
            if (isCreatureAlwaysTick(c)) {
                activeById.set(c.id, c);
                if (p) p.stickyCandidates += 1;
            }
        }

        const idx = wantSpatial && sim ? ensureCreatureSpatialIndex(sim) : null;
        if (idx && typeof idx.queryNearObserversExact === 'function') {
            usedSpatial = true;
            if (p) p.usedSpatial = true;
            const near = idx.queryNearObserversExact(obs, r, {
                livingOnly: true
            });
            if (p) p.spatialCandidates += near.length;
            for (let i = 0; i < near.length; i++) {
                const c = near[i];
                if (!c || c.id == null) continue;
                // queryNearObserversExact already exact-refined; count as checks
                // for parity with linear path telemetry (1 per accepted entity)
                if (p) p.distanceChecks += 1;
                enemyById.set(c.id, c);
                activeById.set(c.id, c);
            }
        } else if (idx) {
            // Older index without exact helper — chunk + refine
            usedSpatial = true;
            if (p) p.usedSpatial = true;
            const candidates = idx.queryNearObservers(obs, r);
            if (p) p.spatialCandidates += candidates.length;
            for (let i = 0; i < candidates.length; i++) {
                const c = candidates[i];
                if (!c || c.alive === false) continue;
                if (c.hp && c.hp.current <= 0) continue;
                if (isCreatureNearObservers(c, obs, r, p)) {
                    enemyById.set(c.id, c);
                    activeById.set(c.id, c);
                }
            }
        } else {
            for (let i = 0; i < creatures.length; i++) {
                const c = creatures[i];
                if (!c || c.alive === false) continue;
                if (c.hp && c.hp.current <= 0) continue;
                if (isCreatureNearObservers(c, obs, r, p)) {
                    enemyById.set(c.id, c);
                    activeById.set(c.id, c);
                }
            }
        }
    }

    const sortById = (a, b) => {
        const na = Number(a && a.id);
        const nb = Number(b && b.id);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
    };

    // Party-owned summons are not hostiles for player AI / shapes
    const { isPartyOwnedSummon } = require('./creature_kit.js');
    const enemies = Array.from(enemyById.values())
        .filter((c) => !isPartyOwnedSummon(c, sim))
        .sort(sortById);
    const active = Array.from(activeById.values()).sort(sortById);
    /** @type {Set<string|number>} */
    const activeIds = new Set();
    for (let i = 0; i < active.length; i++) {
        if (active[i] && active[i].id != null) activeIds.add(active[i].id);
    }

    const frame = {
        key,
        stamp: Time.timeSinceLevelLoad,
        radius: r,
        observers: obs,
        enemies,
        active,
        activeIds,
        usedSpatial
    };
    if (sim) sim._aoiFrame = frame;
    return frame;
}

/**
 * Drop cached AOI (call after bulk creature mutations mid-frame if needed).
 * @param {object} sim
 */
function invalidateAoiFrame(sim) {
    if (sim) sim._aoiFrame = null;
}

/**
 * Living creatures that belong in player enemy scans this frame.
 * Same proximity rule as ticks (without sticky-only far targets — those stay
 * on the creature list for brain ticks only).
 *
 * When `sim` is provided, reuses the shared AOI frame (Etapa 4).
 *
 * @param {object[]} creatures
 * @param {object[]} observers
 * @param {number} radius
 * @param {object} [sim] optional — enables spatial gather + frame cache
 * @param {object} [perf]
 * @returns {object[]}
 */
function filterEnemiesForAi(creatures, observers, radius, sim, perf) {
    if (radius <= 0) {
        return living(creatures || (sim && sim.creatures) || []);
    }
    if (sim) {
        const frame = ensureAoiFrame(sim, observers, radius, perf);
        return frame.enemies;
    }

    // No sim: pure linear over provided list
    const livingCreatures = living(creatures || []);
    const p = perf || null;
    const out = [];
    for (let i = 0; i < livingCreatures.length; i++) {
        const c = livingCreatures[i];
        if (p) p.creaturesIterated += 1;
        if (isCreatureNearObservers(c, observers, radius, p)) out.push(c);
    }
    return out;
}

/**
 * Mark living hostiles as simSleeping when outside the AI active set.
 * Same membership as gatherCreatureAiCandidates / shouldTickCreatureAi:
 * near observers (Chebyshev, same floor) ∪ sticky / non-idle.
 *
 * Sleep freezes Creature.update (cooldowns + moveDelay). No catch-up on wake.
 * Call once per logic frame **before** scene-graph updateAll.
 *
 * @param {object} sim
 * @param {object} [opts]
 * @param {object[]} [opts.observers] living party (default: allPartyMembers)
 * @param {number} [opts.radius] AI tick radius (default resolveAiTickRadius)
 * @returns {object} updatePerf frame
 */
function applyCreatureSleepState(sim, opts) {
    const frame = createUpdatePerfFrame();
    if (!sim) return frame;

    const o = opts || {};
    const creatures = sim.creatures || [];
    const enabled = isCreatureSleepEnabled();
    frame.sleepEnabled = enabled;

    if (!enabled) {
        for (let i = 0; i < creatures.length; i++) {
            const c = creatures[i];
            if (!c) continue;
            if (c.alive === false) {
                if (c.simSleeping) c.simSleeping = false;
                continue;
            }
            frame.living += 1;
            if (c.simSleeping) {
                c.simSleeping = false;
                frame.woke += 1;
            }
            frame.awake += 1;
        }
        endUpdatePerfFrame(sim, frame);
        return frame;
    }

    // allPartyMembers expects the sim (or any { parties }) root, not the array.
    const observers =
        o.observers || living(allPartyMembers(sim));
    const radius =
        o.radius != null ? Number(o.radius) : resolveAiTickRadius();

    // Membership matches brains; build then drop the cache. Scene-graph
    // movement runs after sleep, so tickHuntAi must rebuild AOI with fresh tiles.
    const aoi = ensureAoiFrame(sim, observers, radius, null);
    const awakeIds = aoi.activeIds;
    invalidateAoiFrame(sim);

    for (let i = 0; i < creatures.length; i++) {
        const c = creatures[i];
        if (!c) continue;
        if (c.alive === false || (c.hp && c.hp.current <= 0)) {
            if (c.simSleeping) c.simSleeping = false;
            continue;
        }
        // Players must never sleep even if they appear on creatures[] by mistake
        if (c.type === 'player') {
            if (c.simSleeping) c.simSleeping = false;
            frame.living += 1;
            frame.awake += 1;
            continue;
        }

        frame.living += 1;
        const wantSleep = !awakeIds.has(c.id);
        const wasSleeping = !!c.simSleeping;
        if (wantSleep !== wasSleeping) {
            if (wantSleep) frame.slept += 1;
            else frame.woke += 1;
        }
        c.simSleeping = wantSleep;
        if (wantSleep) frame.asleep += 1;
        else frame.awake += 1;
    }

    endUpdatePerfFrame(sim, frame);
    return frame;
}

/**
 * Candidates for creature brain ticks this frame.
 * Spatial near-observers ∪ sticky/non-idle (always tick).
 * Sorted by id for stable tick order. Reuses AOI frame when sim is set.
 *
 * @param {object} sim
 * @param {object[]} observers
 * @param {number} radius
 * @param {object} [perf]
 * @returns {object[]}
 */
function gatherCreatureAiCandidates(sim, observers, radius, perf) {
    if (!sim) {
        // No sim root: linear over empty
        return [];
    }
    const frame = ensureAoiFrame(sim, observers, radius, perf);
    return frame.active;
}

/**
 * Attach a player brain + strategy.
 * @param {object} player
 * @param {object} [opts]
 * @param {object} [opts.strategy]
 * @param {string} [opts.strategyId]
 * @param {Record<string, object>} [opts.strategyTable]
 */
function initPlayerAi(player, opts) {
    const o = opts || {};
    if (!player) return;
    const table =
        o.strategyTable || indexStrategies(DEFAULT_STRATEGIES);
    player.strategy =
        o.strategy ||
        resolveStrategy(o.strategyId || player.strategyId, table, player.classId);
    player.strategyId = player.strategy.id;
    player.targetId = null;
    player.target = null;
    player.inBattle = false;
    player.controlMode = player.controlMode || 'ai';
    player.commandQueue = Array.isArray(player.commandQueue) ? player.commandQueue : [];
    player.brain = new StateMachine(player);
    const start = initialPlayerState(player);
    player.brain.setCurrentState(start);
    if (start && typeof start.enter === 'function') start.enter(player);
    player.aiState = player.controlMode === 'manual' ? 'manual' : player.brain.getNameOfCurrentState();
}

/**
 * Attach a creature brain.
 * @param {object} creature
 */
function initCreatureAi(creature) {
    if (!creature) return;
    creature.targetId = null;
    creature.target = null;
    if (!creature.homeTile && creature.tile) {
        creature.homeTile = {
            x: creature.tile.x,
            y: creature.tile.y,
            z: creature.tile.z
        };
    }
    ensureCreatureKit(creature, creature._kitTemplate || null);
    creature.brain = new StateMachine(creature);
    const start = initialCreatureState();
    creature.brain.setCurrentState(start);
    if (start && typeof start.enter === 'function') start.enter(creature);
    creature.aiState = creature.brain.getNameOfCurrentState();
}

/**
 * Build per-tick context for AI states.
 * Enemy list is proximity-filtered when AI_TICK_RADIUS > 0 (legacy tilesToUpdate).
 * Etapa 4: shared AOI frame + creature spatial index for per-origin engage.
 * Etapa 5: player spatial index for creature aggro / shaped multi-target.
 *
 * @param {object} sim
 * @param {object} [hooks]
 * @param {object} [perf]
 * @returns {object}
 */
function buildCtx(sim, hooks, perf) {
    const spells = sim.spellBook || sim._spellBook || null;
    const players = living(allPartyMembers(sim));
    const radius = resolveAiTickRadius();
    const aoi = ensureAoiFrame(sim, players, radius, perf);
    const enemies = aoi.enemies;
    if (perf) perf.enemiesListed = enemies.length;
    const creatureIndex = ensureCreatureSpatialIndex(sim);
    const playerIndex = ensurePlayerSpatialIndex(sim);
    return {
        sim,
        tileMap: sim.tileMap,
        enemies,
        players,
        allies: players,
        spellBook: spells || Object.create(null),
        rng: Math.random,
        hooks: hooks || null,
        aiTickRadius: radius,
        aoi,
        creatureIndex,
        playerIndex,
        entityById: sim.entityById || new Map(),
        creatureById: sim.entityById || new Map()
    };
}

/**
 * Resolve manual cast/use target. Supports self, entity id, and tile aim points.
 * Does not fall back to self when the caller asked for an entity/tile that is missing
 * (avoids self-damaging strikes/fireballs).
 *
 * @param {object} owner
 * @param {object} cmd
 * @param {object} ctx
 * @returns {object|null}
 */
function resolveManualCommandTarget(owner, cmd, ctx) {
    const targetId = cmd.target && cmd.target.id != null ? cmd.target.id : cmd.targetId;
    const targetKind = cmd.target ? cmd.target.kind : null;

    if (targetKind === 'self' || (!targetKind && !targetId && !cmd.target)) {
        return owner;
    }

    if (targetKind === 'tile' && cmd.target) {
        const x = Number(cmd.target.x);
        const y = Number(cmd.target.y);
        const z =
            cmd.target.z !== undefined
                ? cmd.target.z
                : owner.tile
                  ? owner.tile.z
                  : 0;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        // Synthetic aim primary for shaped / ground-centered effects
        return {
            tile: { x, y, z },
            alive: true,
            _aimOnly: true
        };
    }

    if (targetId != null && ctx) {
        const map = ctx.entityById || (ctx.sim && ctx.sim.entityById) || ctx.creatureById;
        if (map && map.has(targetId)) {
            return map.get(targetId);
        }
        if (ctx.enemies || ctx.players) {
            const pool = (ctx.enemies || []).concat(ctx.players || []);
            for (let i = 0; i < pool.length; i++) {
                if (pool[i] && pool[i].id === targetId) {
                    return pool[i];
                }
            }
        }
        return null;
    }

    return null;
}

/**
 * Authoritatively resolve USE_ITEM or USE_ITEM_WITH commands during manual control.
 * Runes route through the spell book; other usables (potions) apply item_use effects.
 * @param {object} owner
 * @param {object} cmd
 * @param {object} ctx
 */
function executeManualUseItem(owner, cmd, ctx) {
    const targetEntity = resolveManualCommandTarget(owner, cmd, ctx);
    if (!targetEntity) return;

    if (cmd.itemId) {
        let matchedSpellId = null;
        if (ctx && ctx.spellBook) {
            if (ctx.spellBook[cmd.itemId]) {
                matchedSpellId = cmd.itemId;
            } else {
                const ids = Object.keys(ctx.spellBook);
                for (let i = 0; i < ids.length; i++) {
                    const s = ctx.spellBook[ids[i]];
                    if (s && String(s.source).toLowerCase() === 'rune' && (s.runeItemId === cmd.itemId || s.id === cmd.itemId)) {
                        matchedSpellId = ids[i];
                        break;
                    }
                }
            }
        }
        if (matchedSpellId) {
            // Tile aim only for rune/spell effects; skip single-target resolve on pure aim
            if (targetEntity._aimOnly) {
                const spell = ctx.spellBook && ctx.spellBook[matchedSpellId];
                const { spellHasShape } = require('../combat/area.js');
                if (!spell || !spellHasShape(spell)) return;
            }
            tryAttack({ attacker: owner, defender: targetEntity, spellId: matchedSpellId, ctx });
        } else if (owner.inventory && !targetEntity._aimOnly) {
            try {
                const { consumeItemIdFromInventory } = require('../character/inventory.js');
                const {
                    resolveUseForItemId,
                    applyItemUseEffect
                } = require('../character/item_use.js');
                const itemDb =
                    (ctx && ctx.itemDb) ||
                    (ctx && ctx.sim && ctx.sim._itemDb) ||
                    owner._loadoutItemDb ||
                    null;
                const effect = resolveUseForItemId(cmd.itemId, itemDb);
                // Consume only when we understand the item or it is flagged usable
                const usable =
                    effect.known ||
                    (effect.item &&
                        (effect.item.consumable === true ||
                            effect.item.usable === true ||
                            String(effect.item.category || '').toLowerCase() ===
                                'potion'));
                if (!usable && !effect.heal && !effect.mana && !(effect.dispel && effect.dispel.length)) {
                    return;
                }
                const r = consumeItemIdFromInventory(owner.inventory, cmd.itemId, 1);
                if (r.changed) {
                    if (typeof owner.applyInventoryMutation === 'function') {
                        owner.applyInventoryMutation();
                    }
                    const rng = ctx && typeof ctx.rng === 'function' ? ctx.rng : Math.random;
                    applyItemUseEffect(targetEntity, effect, { rng });
                    const sim = ctx && ctx.sim;
                    if (sim && sim.telemetry) {
                        try {
                            const { sampleConsumable } = require('../telemetry.js');
                            sampleConsumable(sim.telemetry, 'potion', 1, {
                                timeSec:
                                    sim.timeSec != null
                                        ? sim.timeSec
                                        : undefined
                            });
                        } catch (_) {
                            /* telemetry optional */
                        }
                    }
                }
            } catch (_) {}
        }
    }
}

/**
 * Max living player summons (reference server: 2 without CanSummonAll).
 * @type {number}
 */
const PLAYER_SUMMON_CAP = 2;

/**
 * Parse and run CUSTOM_COMMAND macros (action-bar free text).
 * Known macros:
 *   heal_friend — cast Heal Friend on selected target (or cmd.target)
 *   summon_creature <id> | summon <id> — player summon (mana + summonable flag)
 * Unknown strings no-op (already dequeued by caller).
 *
 * @param {object} owner
 * @param {object} cmd
 * @param {object} ctx
 */
function executeCustomCommand(owner, cmd, ctx) {
    const raw = String((cmd && cmd.command) || '').trim();
    if (!raw) return;
    const lower = raw.toLowerCase();

    // heal_friend — basis for ally-targeted support (also available as CAST_SPELL)
    if (lower === 'heal_friend' || lower.startsWith('heal_friend ')) {
        let target = null;
        if (cmd.target || cmd.targetId) {
            target = resolveManualCommandTarget(owner, cmd, ctx);
        } else if (owner.target && owner.target.alive !== false) {
            target = owner.target;
        }
        if (!target || target._aimOnly) return;
        // Prefer living party members; allow self only if explicitly targeted
        tryAttack({
            attacker: owner,
            defender: target,
            spellId: 'heal_friend',
            ctx
        });
        return;
    }

    // summon_creature <creatureId> | summon <creatureId>
    const summonMatch = lower.match(
        /^(?:summon_creature|summon_creature:|summon|utevo_res|utevo)\s+(.+)$/
    );
    if (summonMatch) {
        executePlayerSummon(owner, summonMatch[1].trim(), ctx);
        return;
    }

    // Explicit noop / reserved labels
    if (lower === 'noop' || lower === 'none' || lower === 'pass') return;
}

/**
 * Player-cast summon creature (CUSTOM_COMMAND / future spell words).
 * @param {object} owner
 * @param {string} creatureToken free text id or label slug
 * @param {object} ctx
 */
function executePlayerSummon(owner, creatureToken, ctx) {
    if (!owner || !ctx || !ctx.sim) return;
    const sim = ctx.sim;
    if (typeof sim.spawnSummon !== 'function') return;

    const creatureId = String(creatureToken || '')
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_]/g, '');
    if (!creatureId) return;

    // Cap living summons
    const { livingSummonsOf, isSummon } = require('./creature_kit.js');
    if (isSummon(owner)) return;
    const living = livingSummonsOf(owner, ctx);
    if (living.length >= PLAYER_SUMMON_CAP) {
        if (typeof sim.emitCombatText === 'function' && owner.tile) {
            sim.emitCombatText({
                x: owner.tile.x,
                y: owner.tile.y,
                z: owner.tile.z,
                text: 'You cannot summon more creatures.',
                color: '#c0c0c0',
                life: 1.2
            });
        }
        return;
    }

    let template = null;
    if (typeof sim._creatureLoader === 'function') {
        try {
            template = sim._creatureLoader(creatureId);
        } catch (_) {
            template = null;
        }
    }
    if (!template) {
        if (typeof sim.emitCombatText === 'function' && owner.tile) {
            sim.emitCombatText({
                x: owner.tile.x,
                y: owner.tile.y,
                z: owner.tile.z,
                text: 'Not possible.',
                color: '#c0c0c0',
                life: 1.0
            });
        }
        return;
    }

    const flags = template.flags || {};
    if (flags.summonable === false) {
        if (typeof sim.emitCombatText === 'function' && owner.tile) {
            sim.emitCombatText({
                x: owner.tile.x,
                y: owner.tile.y,
                z: owner.tile.z,
                text: 'Not possible.',
                color: '#c0c0c0',
                life: 1.0
            });
        }
        return;
    }

    const manaCost = Math.max(0, Math.floor(Number(template.manaCost) || 0));
    const { hasMana, spendMana } = require('../combat/resolve.js');
    if (manaCost > 0 && !hasMana(owner, manaCost)) {
        if (typeof sim.emitCombatText === 'function' && owner.tile) {
            sim.emitCombatText({
                x: owner.tile.x,
                y: owner.tile.y,
                z: owner.tile.z,
                text: 'Not enough mana.',
                color: '#8080ff',
                life: 1.0
            });
        }
        return;
    }

    const summon = sim.spawnSummon({
        creatureId,
        template,
        master: owner,
        force: true
    });
    if (!summon) {
        if (typeof sim.emitCombatText === 'function' && owner.tile) {
            sim.emitCombatText({
                x: owner.tile.x,
                y: owner.tile.y,
                z: owner.tile.z,
                text: 'There is not enough room.',
                color: '#c0c0c0',
                life: 1.0
            });
        }
        return;
    }

    // Ally bookkeeping: party AI should not treat this as a hostile
    summon.partyOwned = true;
    summon.allySummon = true;
    if (manaCost > 0) spendMana(owner, manaCost);
}

function executeManualCastSpell(owner, cmd, ctx) {
    const targetEntity = resolveManualCommandTarget(owner, cmd, ctx);
    if (!targetEntity) return;

    if (cmd.spellId) {
        if (targetEntity._aimOnly) {
            const spell =
                ctx && ctx.spellBook
                    ? ctx.spellBook[cmd.spellId]
                    : null;
            const { spellHasShape } = require('../combat/area.js');
            if (!spell || !spellHasShape(spell)) return;
        }
        tryAttack({ attacker: owner, defender: targetEntity, spellId: cmd.spellId, ctx });
    }
}

/**
 * Cancel manual autowalk and optionally show legacy-style "There is no way."
 * @param {object} owner
 * @param {object} ctx
 * @param {boolean} [announce]
 */
function cancelManualAutowalk(owner, ctx, announce) {
    if (!owner) return;
    owner._manualDest = null;
    owner.path = [];
    if (!announce) return;
    const sim = ctx && ctx.sim;
    if (!sim || typeof sim.emitCombatText !== 'function' || !owner.tile) return;
    sim.emitCombatText({
        x: owner.tile.x,
        y: owner.tile.y,
        z: owner.tile.z,
        text: 'There is no way.',
        color: '#c0c0c0',
        life: 1.2
    });
}

/**
 * Record + dequeue the head of a member command queue (shared by meta + manual).
 * @param {object} owner
 * @param {object} ctx
 * @returns {object|undefined}
 */
function consumeMemberCommand(owner, ctx) {
    if (!owner || !Array.isArray(owner.commandQueue) || owner.commandQueue.length === 0) {
        return undefined;
    }
    const c = owner.commandQueue.shift();
    if (c && !c._replayed && ctx && ctx.sim && typeof ctx.sim.recordManualCommand === 'function') {
        ctx.sim.recordManualCommand(owner, c);
    }
    return c;
}

/**
 * Re-enter player FSM after leaving manual control so AI does not resume a stale state.
 * @param {object} player
 */
function reenterPlayerBrain(player) {
    if (!player) return;
    player._manualDest = null;
    player.path = [];
    if (!player.brain) {
        initPlayerAi(player);
        return;
    }
    const start = initialPlayerState(player);
    player.brain.setCurrentState(start);
    if (start && typeof start.enter === 'function') start.enter(player);
    player.aiState = player.brain.getNameOfCurrentState();
}

/**
 * Apply SET_CONTROL_MODE payload (AI ↔ manual). Used for live UI + TAS replay.
 * @param {object} owner
 * @param {object} cmd
 */
function applySetControlMode(owner, cmd) {
    if (!owner) return;
    const mode = cmd && cmd.mode === 'manual' ? 'manual' : 'ai';
    owner.controlMode = mode;
    if (mode === 'manual') {
        owner.aiState = 'manual';
    } else {
        reenterPlayerBrain(owner);
    }
}

/**
 * Drain leading SET_CONTROL_MODE commands so AI members can enter manual on replay
 * (executeManualControl only runs while already manual).
 * @param {object} owner
 * @param {object} ctx
 */
function drainLeadingControlModeCommands(owner, ctx) {
    if (!owner || !Array.isArray(owner.commandQueue)) return;
    while (owner.commandQueue.length > 0 && owner.commandQueue[0] && owner.commandQueue[0].type === 'SET_CONTROL_MODE') {
        const cmd = consumeMemberCommand(owner, ctx);
        applySetControlMode(owner, cmd);
    }
}

/**
 * Tick all party members then nearby / engaged creatures.
 * When AI_GATE_*_ON_MOVE_DELAY is on (default), skips full brain.execute while
 * moveDelay > 0 (movement / retarget / leash). Spell cooldowns still tick on
 * entity.update. Creatures additionally keep the **attack kit** live while
 * mid-step so kiting / flee does not starve waves and balls.
 *
 * @param {object} sim
 * @param {object} [hooks] step log hooks for movement
 */
function tickHuntAi(sim, hooks) {
    if (!sim || !sim.tileMap) return;
    const perf = beginAiPerfFrame(sim);
    const ctx = buildCtx(sim, hooks, perf);
    const observers = ctx.players;
    const radius = ctx.aiTickRadius;

    for (let i = 0; i < sim.parties.length; i++) {
        const party = sim.parties[i];
        if (!party || !party.enabled) continue;
        for (let j = 0; j < party.members.length; j++) {
            const m = party.members[j];
            if (!m || !m.alive) continue;
            m.party = party;
            if (!m.brain) initPlayerAi(m, { strategy: m.strategy });
            // Mode flips must run for AI members too (TAS / replay enter manual).
            drainLeadingControlModeCommands(m, ctx);
            if (m.controlMode === 'manual') {
                executeManualControl(m, ctx);
                m.aiState = 'manual';
                continue;
            }
            if (!brainReady(m, 'player')) {
                m.aiState = m.brain.getNameOfCurrentState();
                continue;
            }
            m.brain.update(ctx);
            m.aiState = m.brain.getNameOfCurrentState();
        }
        // Sync party route flag after AI movement
        if (typeof party.allRoutesComplete === 'function') {
            party.routeComplete = party.allRoutesComplete();
        }
    }

    const candidates = gatherCreatureAiCandidates(sim, observers, radius, perf);
    for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        if (!c || !c.alive) continue;
        // Defensive: sticky gather already included; near set is refined.
        // Re-check shouldTick so radius-0 / edge cases stay identical.
        if (!shouldTickCreatureAi(c, observers, radius, perf)) continue;
        perf.brainsConsidered += 1;
        if (!c.brain) initCreatureAi(c);
        if (!brainReady(c, 'creature')) {
            c.aiState = c.brain.getNameOfCurrentState();
            // Movement stays rooted, but kit timers + casts still run so a
            // fleeing / pathing monster can wave/ball while mid-step.
            tryEngagedAttacks(c, ctx);
            perf.brainsExecuted += 1;
            continue;
        }
        c.brain.update(ctx);
        c.aiState = c.brain.getNameOfCurrentState();
        perf.brainsExecuted += 1;
    }

    endAiPerfFrame(sim, perf);
}

/**
 * Ensure spell book is an id → def map.
 * @param {object[]|Record<string, object>|null} spells
 * @returns {Record<string, object>}
 */
function ensureSpellBook(spells) {
    return indexSpells(spells);
}

module.exports = {
    initPlayerAi,
    initCreatureAi,
    tickHuntAi,
    buildCtx,
    resolveAiTickRadius,
    resolveAiSpatialChunkSize,
    isCreatureNearObservers,
    isCreatureAlwaysTick,
    shouldTickCreatureAi,
    filterEnemiesForAi,
    gatherCreatureAiCandidates,
    ensureCreatureSpatialIndex,
    markCreatureSpatialDirty,
    ensurePlayerSpatialIndex,
    markPlayerSpatialDirty,
    ensureAoiFrame,
    invalidateAoiFrame,
    applyCreatureSleepState,
    isCreatureSleepEnabled,
    createAiPerfFrame,
    createUpdatePerfFrame,
    ensureSpellBook,
    FollowWaypoint,
    FollowLeader,
    executeManualControl
};

/**
 * Authoritatively process buffered commands and execute hybrid auto-attack logic for manual control mode.
 * @param {object} owner
 * @param {object} ctx
 */
function executeManualControl(owner, ctx) {
    if (!owner || !owner.alive) return;
    if (!Array.isArray(owner.commandQueue)) owner.commandQueue = [];
    const queue = owner.commandQueue;
    const consumeCmd = () => consumeMemberCommand(owner, ctx);

    // Process command buffer if present
    if (queue.length > 0) {
        const cmd = queue[0];
        if (!cmd) {
            queue.shift();
        } else if (cmd.type === 'STOP_AUTOWALK') {
            consumeCmd();
            owner._manualDest = null;
            owner.path = [];
        } else if (cmd.type === 'SET_TARGET') {
            consumeCmd();
            owner.targetId = cmd.targetId != null ? cmd.targetId : null;
            if (!owner.targetId) {
                owner.target = null;
                owner.inBattle = false;
            }
        } else if (cmd.type === 'SET_AUTO_CHASE') {
            consumeCmd();
            owner.autoChase = cmd.enabled !== undefined ? !!cmd.enabled : !owner.autoChase;
        } else if (cmd.type === 'SET_CONTROL_MODE') {
            // Mid-queue mode flip (not only leading); leaving manual re-enters AI brain
            consumeCmd();
            applySetControlMode(owner, cmd);
            if (owner.controlMode !== 'manual') return;
        } else if (cmd.type === 'USE_ITEM' || cmd.type === 'USE_ITEM_WITH') {
            consumeCmd();
            executeManualUseItem(owner, cmd, ctx);
        } else if (cmd.type === 'CAST_SPELL') {
            consumeCmd();
            executeManualCastSpell(owner, cmd, ctx);
        } else if (cmd.type === 'CUSTOM_COMMAND') {
            consumeCmd();
            executeCustomCommand(owner, cmd, ctx);
        } else if (cmd.type === 'MOVE_STEP' || cmd.type === 'START_AUTOWALK') {
            if (isMoveUnlocked(owner)) {
                if (cmd.type === 'MOVE_STEP') {
                    consumeCmd();
                    owner._manualDest = null;
                    owner.path = [];
                    const tx = owner.tile.x + (Number(cmd.dx) || 0);
                    const ty = owner.tile.y + (Number(cmd.dy) || 0);
                    const tz = cmd.z !== undefined ? cmd.z : owner.tile.z;
                    if (
                        ctx &&
                        ctx.tileMap &&
                        (typeof ctx.tileMap.isTileWalkable === 'function'
                            ? ctx.tileMap.isTileWalkable(tx, ty, tz, owner)
                            : true)
                    ) {
                        stepToward(owner, { x: tx, y: ty, z: tz }, ctx.tileMap);
                    }
                } else {
                    consumeCmd();
                    if (cmd.dest && ctx && ctx.tileMap) {
                        owner._manualDest = cmd.dest;
                        owner.path = [];
                        stepToward(owner, cmd.dest, ctx.tileMap, { allowLongPath: true });
                        const atDest =
                            owner.tile &&
                            owner.tile.x === cmd.dest.x &&
                            owner.tile.y === cmd.dest.y &&
                            String(owner.tile.z) === String(cmd.dest.z);
                        if (!atDest && (!owner.path || owner.path.length === 0)) {
                            // No route (legacy RETURNVALUE_THEREISNOWAY) — cancel, do not buffer forever
                            cancelManualAutowalk(owner, ctx, true);
                        }
                    }
                }
            }
        } else {
            // Unknown types: drop safely so the queue cannot stall
            consumeCmd();
        }
    }

    // Continue autowalk toward manual destination if move is unlocked
    if (isMoveUnlocked(owner) && owner._manualDest && ctx && ctx.tileMap) {
        if (
            owner.tile.x === owner._manualDest.x &&
            owner.tile.y === owner._manualDest.y &&
            String(owner.tile.z) === String(owner._manualDest.z)
        ) {
            owner._manualDest = null;
            owner.path = [];
        } else {
            const stepOk = stepToward(owner, owner._manualDest, ctx.tileMap, {
                allowLongPath: true
            });
            if (!stepOk && (!owner.path || owner.path.length === 0)) {
                cancelManualAutowalk(owner, ctx, true);
            }
        }
    }

    // Resolve target if set
    let activeTarget = null;
    if (owner.targetId != null && ctx && ctx.creatureById) {
        const target = ctx.creatureById.get(owner.targetId);
        if (target && target.alive && (target.hp && target.hp.current > 0)) {
            activeTarget = target;
            owner.target = target;
            owner.inBattle = true;
        } else {
            // Dead or despawned / missing from map — clear stale targetId
            owner.targetId = null;
            owner.target = null;
            owner.inBattle = false;
        }
    }

    // Auto-chase: if enabled and move unlocked with an active target and no manual autowalk destination
    if (isMoveUnlocked(owner) && !owner._manualDest && owner.autoChase && activeTarget && ctx && ctx.tileMap) {
        combatMove(owner, activeTarget, owner.strategy || { keepDistance: 1 }, ctx);
    }

    // Hybrid auto-attack: swing at active target if alive and within weapon range
    if (activeTarget) {
        tryAutoAttack({ attacker: owner, defender: activeTarget, ctx });
    }
}
