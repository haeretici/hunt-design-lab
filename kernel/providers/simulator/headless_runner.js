/**
 * Headless hunt shell.
 * Stage 0: N empty logic ticks with a fixed seed.
 * Stage 3: party ghost-walk along waypoints on a path map.
 * Stage 5: full hunt with combat AI until party wipe or route complete.
 * Stage 6: hunt config + telemetry summary + batch iterations → files.
 * Parallel: fork workers (soccer-oss pattern) when concurrency > 1.
 */

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { Time, LOGIC_DT } = require('../../core/lib/time.js');
const { Settings, ROOT } = require('../../settings.js');
const {
    resolveHuntLegacyMapPack,
    padFloorId
} = require('../../core/lib/content/legacy_assets.js');
const { unbindSeededRandom } = require('../../core/lib/utils.js');
const {
    summaryCore,
    stableStringify
} = require('../../core/lib/telemetry.js');
const { normalizeBudget } = require('../../core/lib/dungeon/pacing.js');
const { Simulator } = require('./simulator.js');
const {
    huntToSimulatorOpts,
    pickInjectors,
    pickOptionalBoolean,
    isSessionTerminal
} = require('./hunt_opts.js');

const BATCH_WORKER_PATH = path.join(__dirname, '../../../scripts/batch_worker.js');

const DEFAULT_CONFIG = {
    seed: 1,
    frames: 100,
    headless: true,
    timeSpeed: 1.0,
    /** Parallel worker processes for batch (1 = in-process sequential). */
    concurrency: 1
};

/** Keys that may hold non-IPC values (functions / live injectors). */
const INJECTOR_KEYS = [
    'creatureLoader',
    'classLoader',
    'itemDb',
    'spellBook',
    'strategyTable',
    'onIteration'
];

const {
    DEFAULT_FLOOR07_WAYPOINTS
} = require('./default_waypoints.js');

/** Default safety cap for a single combat hunt (logic frames). */
const DEFAULT_HUNT_MAX_FRAMES = 8000;

/**
 * @param {object} [input]
 * @returns {typeof DEFAULT_CONFIG}
 */
function mergeConfig(input) {
    return Object.assign({}, DEFAULT_CONFIG, input || {});
}

/**
 * Apply runner knobs that live on Settings.
 * @param {ReturnType<typeof mergeConfig>} config
 */
function applySettingsFromConfig(config) {
    Settings.HEADLESS = config.headless !== false;
    Settings.TIME_SPEED = config.timeSpeed || 1.0;
}

/**
 * @param {unknown} value
 * @param {number} iterations
 * @returns {number}
 */
function normalizeConcurrency(value, iterations) {
    const parsed = parseInt(value, 10);
    const requested = Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
    const total = Math.max(1, parseInt(iterations, 10) || 1);
    return Math.min(requested, total);
}

/**
 * Split iterations across workers (contiguous index ranges).
 * @param {number} iterations
 * @param {number} concurrency
 * @returns {{ startIndex: number, count: number }[]}
 */
function planWorkerChunks(iterations, concurrency) {
    const workers = normalizeConcurrency(concurrency, iterations);
    const baseSize = Math.floor(iterations / workers);
    const remainder = iterations % workers;
    const chunks = [];
    let startIndex = 0;
    for (let worker = 0; worker < workers; worker++) {
        const count = baseSize + (worker < remainder ? 1 : 0);
        if (count > 0) {
            chunks.push({ startIndex, count });
            startIndex += count;
        }
    }
    return chunks;
}

/**
 * True when config carries functions that cannot be sent over IPC.
 * @param {object} config
 * @returns {boolean}
 */
function hasNonSerializableInjectors(config) {
    if (!config || typeof config !== 'object') return false;
    for (let i = 0; i < INJECTOR_KEYS.length; i++) {
        const k = INJECTOR_KEYS[i];
        if (typeof config[k] === 'function') return true;
    }
    return false;
}

/**
 * Clone batch config for worker IPC (drop functions + batch control keys).
 * @param {object} config
 * @returns {object}
 */
function serializeBatchConfig(config) {
    const out = {};
    const skip = new Set([
        'onIteration',
        'creatureLoader',
        'classLoader',
        'writeFiles',
        'outDir',
        'quiet',
        'iterations',
        'seeds',
        'concurrency'
    ]);
    const src = config || {};
    for (const key of Object.keys(src)) {
        if (skip.has(key)) continue;
        if (typeof src[key] === 'function') continue;
        out[key] = src[key];
    }
    out.headless = true;
    return out;
}

/**
 * Resolve hunt definition + parties/spawns/waypoints/limits from runner input.
 * Pure-ish (may load presets from disk). Monster/spawn ids come only from hunt
 * data files or caller input — never hard-coded in this module.
 *
 * @param {object} [input]
 * @returns {{
 *   seed: number,
 *   floor: string|number,
 *   floors: (string|number)[],
 *   mapPath: string|undefined,
 *   mapPaths: Record<string, string>|undefined,
 *   genre: string|null,
 *   huntId: string|null,
 *   hunt: object,
 *   waypoints: object[],
 *   spawns: object[],
 *   spawnMode: 'eager'|'on_demand',
 *   waves: object|object[]|null,
 *   parties: object[],
 *   maxFrames: number,
 *   maxTicks: number|null,
 *   maxKills: number|null,
 *   maxSeconds: number|null,
 *   pacingBudget: object|null,
 *   layoutMeta: object|null,
 *   floorMeta: object[]|null,
 *   recordSteps: boolean,
 *   stopOnEnd: boolean
 * }}
 */
function resolveHuntConfig(input) {
    const config = mergeConfig(input);
    const seed = config.seed >>> 0 || 1;
    const stopOnEnd = config.stopOnEnd !== false;
    const recordSteps = !!config.recordSteps;
    const presets = require('../../core/lib/presets.js');

    const expandOpts = {
        seed,
        populationDensity:
            config.populationDensity != null
                ? config.populationDensity
                : undefined
    };

    let hunt = config.hunt || null;
    let huntId = config.huntId || null;
    if (!hunt && huntId) {
        // Prefer unexpanded file so population expands once under the run seed.
        try {
            hunt = presets.loadJson(`hunts/${huntId}.json`);
        } catch (_) {
            hunt = presets.loadHunt(huntId, expandOpts);
        }
    }
    if (!hunt) {
        // Default hunt is generator-owned cave_crawl_generated (hand floor07_* retired).
        try {
            hunt = presets.loadJson('hunts/cave_crawl_generated.json');
        } catch (_) {
            hunt = presets.loadHunt('cave_crawl_generated', expandOpts);
        }
        if (!huntId) huntId = 'cave_crawl_generated';
    }

    // Runner population overrides (before expand)
    if (config.populationId || config.population) {
        hunt = Object.assign({}, hunt, {
            populationId:
                config.populationId != null
                    ? config.populationId
                    : hunt.populationId,
            population:
                config.population != null ? config.population : hunt.population
        });
        // Override implies re-roll; do not treat prior spawns as fixtures.
        if (!Array.isArray(config.spawns) || !config.spawns.length) {
            delete hunt.spawns;
            delete hunt.populationMeta;
            delete hunt.populationSkipped;
            hunt._hadAuthoredSpawns = false;
        }
    }
    if (config.populationDensity != null) {
        hunt = Object.assign({}, hunt, {
            populationDensity: config.populationDensity
        });
    }
    if (config.populationSlots) {
        hunt = Object.assign({}, hunt, {
            populationSlots: config.populationSlots
        });
    }

    // Stage 11.2 marker overrides (before expand)
    if (config.markersId || config.markerRules || config.markers) {
        hunt = Object.assign({}, hunt, {
            markersId:
                config.markersId != null ? config.markersId : hunt.markersId,
            markerRules:
                config.markerRules != null
                    ? config.markerRules
                    : hunt.markerRules,
            markers:
                config.markers != null ? config.markers : hunt.markers
        });
        if (!Array.isArray(config.props) || !config.props.length) {
            delete hunt.props;
            delete hunt.markersMeta;
            delete hunt.markersSkipped;
            hunt._hadAuthoredProps = false;
        }
    }
    if (config.markerSockets) {
        hunt = Object.assign({}, hunt, {
            markerSockets: config.markerSockets
        });
    }
    if (config.markerDensity != null) {
        hunt = Object.assign({}, hunt, {
            markerDensity: config.markerDensity
        });
        expandOpts.markerDensity = config.markerDensity;
    }

    // Expand waypointPreset + spawnSource + population + markers → defs (not instances)
    hunt = presets.expandHuntDefinition(hunt, expandOpts);
    if (!huntId && hunt && hunt.id) huntId = hunt.id;

    // Runner-level spawnSource overrides hunt file (still defs only; re-apply population)
    if (config.spawnSource) {
        const withSource = Object.assign({}, hunt, {
            spawnSource: config.spawnSource
        });
        delete withSource.spawnSourceSpec;
        delete withSource.populationMeta;
        if (!Array.isArray(config.spawns) || !config.spawns.length) {
            // Drop prior defs so source rows become population slots when needed.
            if (withSource.populationId || withSource.population) {
                delete withSource.spawns;
                withSource._hadAuthoredSpawns = false;
            }
        }
        hunt = presets.expandHuntDefinition(withSource, expandOpts);
    }

    const floor =
        config.floor !== undefined
            ? config.floor
            : hunt.floor !== undefined
              ? hunt.floor
              : 7;
    /** @type {(string|number)[]} */
    let floors = [];
    if (Array.isArray(config.floors) && config.floors.length) {
        floors = config.floors.slice();
    } else if (Array.isArray(hunt.floors) && hunt.floors.length) {
        floors = hunt.floors.slice();
    } else {
        floors = [floor];
    }

    const waypoints =
        Array.isArray(config.waypoints) && config.waypoints.length
            ? config.waypoints
            : hunt.waypoints && hunt.waypoints.length
              ? hunt.waypoints
              : DEFAULT_FLOOR07_WAYPOINTS;
    // Priority: explicit runner spawns > resolved spawnSource/population/hunt.spawns
    const spawns =
        Array.isArray(config.spawns) && config.spawns.length
            ? config.spawns
            : hunt.spawns || [];

    // Stage 11.2 props: runner override > marker-resolved / authored hunt.props
    const props =
        Array.isArray(config.props) && config.props.length
            ? config.props
            : Array.isArray(hunt.props)
              ? hunt.props
              : [];

    /** @type {'eager'|'on_demand'} */
    const spawnMode =
        config.spawnMode === 'on_demand' || hunt.spawnMode === 'on_demand'
            ? 'on_demand'
            : config.spawnMode === 'eager' || hunt.spawnMode === 'eager'
              ? 'eager'
              : Settings.SPAWN_MODE === 'on_demand'
                ? 'on_demand'
                : 'eager';

    // Sequential arena waves (runner override > hunt file). Null when absent.
    let waves = null;
    if (config.waves != null) {
        waves = config.waves;
    } else if (hunt && hunt.waves != null) {
        waves = hunt.waves;
    }

    const genre =
        config.genre || hunt.genre || null;

    // Stage 11.8 / 12H multi-floor stair pads (TileMap first-class + party hops)
    const stairLinks =
        Array.isArray(config.stairLinks) && config.stairLinks.length
            ? config.stairLinks
            : Array.isArray(hunt.stairLinks) && hunt.stairLinks.length
              ? hunt.stairLinks
              : null;

    // Stage 12H: generator / hunt navmesh graph data for long multi-floor routes
    const navmeshData =
        config.navmeshData && typeof config.navmeshData === 'object'
            ? config.navmeshData
            : hunt.navmeshData && typeof hunt.navmeshData === 'object'
              ? hunt.navmeshData
              : hunt.navmesh && typeof hunt.navmesh === 'object'
                ? hunt.navmesh
                : null;

    // Arena patrol: one lap of waypoints can loop until waves/session end.
    const loopWaypoints =
        config.loopWaypoints != null
            ? !!config.loopWaypoints
            : !!hunt.loopWaypoints;

    // Party from partyId / parties[] / members (not authored on hunt JSON).
    const {
        resolveSessionParties
    } = require('../../core/lib/character/party_resolve.js');
    const parties = resolveSessionParties(config, {
        hunt,
        waypoints,
        stairLinks,
        loopWaypoints
    });

    // Limits: runner frames cap + optional session maxTicks/maxSeconds/maxKills
    const limits = Object.assign(
        {},
        hunt.limits || {},
        config.limits || {}
    );
    if (config.maxKills != null) limits.maxKills = config.maxKills;
    if (config.maxSeconds != null) limits.maxSeconds = config.maxSeconds;
    if (config.maxTicks != null) limits.maxTicks = config.maxTicks;
    if (config.noAttackTimeoutSec != null) {
        limits.noAttackTimeoutSec = config.noAttackTimeoutSec;
    }
    if (hunt.maxKills != null && limits.maxKills == null) {
        limits.maxKills = hunt.maxKills;
    }
    if (hunt.maxSeconds != null && limits.maxSeconds == null) {
        limits.maxSeconds = hunt.maxSeconds;
    }
    if (hunt.maxTicks != null && limits.maxTicks == null) {
        limits.maxTicks = hunt.maxTicks;
    }
    if (hunt.duration != null && limits.maxSeconds == null) {
        limits.maxSeconds = hunt.duration;
    }

    let maxFrames = DEFAULT_HUNT_MAX_FRAMES;
    if (input && input.frames !== undefined && input.frames !== null) {
        maxFrames = Math.max(1, parseInt(input.frames, 10) || DEFAULT_HUNT_MAX_FRAMES);
    } else if (limits.maxFrames != null) {
        maxFrames = Math.max(1, parseInt(limits.maxFrames, 10) || DEFAULT_HUNT_MAX_FRAMES);
    } else if (limits.maxTicks != null) {
        maxFrames = Math.max(1, Math.floor(limits.maxTicks));
    } else if (limits.maxSeconds != null) {
        const ups = Settings.LOGIC_UPS || 20;
        maxFrames = Math.max(1, Math.ceil(Number(limits.maxSeconds) * ups));
    }

    let maxTicks = limits.maxTicks != null ? Math.floor(limits.maxTicks) : null;
    if (maxTicks == null && limits.maxSeconds != null) {
        const ups = Settings.LOGIC_UPS || 20;
        maxTicks = Math.max(1, Math.ceil(Number(limits.maxSeconds) * ups));
    }
    const maxKills =
        limits.maxKills != null && limits.maxKills > 0
            ? Math.floor(limits.maxKills)
            : null;
    const maxSeconds =
        limits.maxSeconds != null ? Number(limits.maxSeconds) : null;
    const noAttackTimeoutSec =
        limits.noAttackTimeoutSec != null &&
        Number(limits.noAttackTimeoutSec) > 0
            ? Number(limits.noAttackTimeoutSec)
            : null;

    // Stage 11.0 pacing budget: runner override > hunt.pacingBudget (report-only)
    let pacingBudget = null;
    if (config.pacingBudget && typeof config.pacingBudget === 'object') {
        pacingBudget = normalizeBudget(config.pacingBudget);
    } else if (hunt.pacingBudget && typeof hunt.pacingBudget === 'object') {
        pacingBudget = normalizeBudget(hunt.pacingBudget);
    } else if (limits.pacingBudget && typeof limits.pacingBudget === 'object') {
        pacingBudget = normalizeBudget(limits.pacingBudget);
    }

    // Stage 11.4: generated friction (in-memory) wins over path PNG
    const floorFriction =
        config.floorFriction ||
        hunt.floorFriction ||
        null;
    /** @type {Record<string, object>|null} */
    let floorLayers = null;
    if (config.floorLayers && typeof config.floorLayers === 'object') {
        floorLayers = config.floorLayers;
    } else if (hunt.floorLayers && typeof hunt.floorLayers === 'object') {
        floorLayers = hunt.floorLayers;
    } else if (floorFriction && floorFriction.friction) {
        const z =
            floorFriction.z != null
                ? floorFriction.z
                : floor != null
                  ? floor
                  : 0;
        floorLayers = Object.create(null);
        floorLayers[String(z)] = {
            cols: floorFriction.cols,
            rows: floorFriction.rows,
            friction: floorFriction.friction,
            sight: floorFriction.sight || null,
            flags: floorFriction.flags || null
        };
    }

    // Stage 11.9: decorative art layers (palette + cells)
    const floorArt = config.floorArt || hunt.floorArt || null;
    /** @type {Record<string, object>|null} */
    let artLayers = null;
    if (config.artLayers && typeof config.artLayers === 'object') {
        artLayers = config.artLayers;
    } else if (hunt.artLayers && typeof hunt.artLayers === 'object') {
        artLayers = hunt.artLayers;
    } else if (floorArt && floorArt.cells) {
        const z =
            floorArt.z != null
                ? floorArt.z
                : floor != null
                  ? floor
                  : 0;
        artLayers = Object.create(null);
        artLayers[String(z)] = floorArt;
    }

    // When layout generated a map, do not fall back to continent path PNGs
    let mapPath = floorLayers
        ? config.mapPath || hunt.mapPath || undefined
        : config.mapPath || hunt.mapPath || undefined;
    const mapPaths = floorLayers
        ? config.mapPaths || hunt.mapPaths || undefined
        : config.mapPaths || hunt.mapPaths || undefined;

    // Editor hybrid packs (fields + channels) when present and not a generated layout
    let hybridMapPack =
        config.hybridMapPack != null
            ? config.hybridMapPack
            : hunt && hunt.hybridMapPack != null
              ? hunt.hybridMapPack
              : null;
    let mapsRoot;
    if (!floorLayers) {
        try {
            const pack = resolveHuntLegacyMapPack(hunt).pack;
            mapsRoot = path.join(ROOT, pack.mapsRel);
        } catch (_e) {
            mapsRoot = undefined;
        }
    }
    if (!hybridMapPack && !floorLayers) {
        try {
            const {
                tryResolveHybridMapPack
            } = require('../../core/lib/dungeon/tilemap_bake.js');
            const floorList =
                floors && floors.length
                    ? floors
                    : floor != null
                      ? [floor]
                      : [];
            hybridMapPack = tryResolveHybridMapPack(floorList, {
                mapsRoot: mapsRoot || undefined
            });
        } catch (_e) {
            hybridMapPack = null;
        }
    }
    if (!mapPath && !floorLayers && mapsRoot) {
        mapPath = path.join(mapsRoot, `floor-${padFloorId(floor)}-path.png`);
    }

    // Stage 11.10: layout meta for runtime biome_transition + macro pacing
    const layoutMeta =
        (hunt && hunt.layoutMeta && typeof hunt.layoutMeta === 'object'
            ? hunt.layoutMeta
            : null) ||
        (config.layoutMeta && typeof config.layoutMeta === 'object'
            ? config.layoutMeta
            : null);
    const floorMeta =
        (layoutMeta && Array.isArray(layoutMeta.floorMeta)
            ? layoutMeta.floorMeta
            : null) ||
        (Array.isArray(config.floorMeta) ? config.floorMeta : null) ||
        (hunt && Array.isArray(hunt.floorMeta) ? hunt.floorMeta : null);

    const arenaLoop =
        (config.arenaLoop && typeof config.arenaLoop === 'object'
            ? config.arenaLoop
            : null) ||
        (hunt && hunt.arenaLoop && typeof hunt.arenaLoop === 'object'
            ? hunt.arenaLoop
            : null);

    const perFloorWaypoints =
        (config.perFloorWaypoints &&
        typeof config.perFloorWaypoints === 'object'
            ? config.perFloorWaypoints
            : null) ||
        (hunt &&
        hunt.perFloorWaypoints &&
        typeof hunt.perFloorWaypoints === 'object'
            ? hunt.perFloorWaypoints
            : null);

    return {
        seed,
        floor,
        floors,
        mapPath,
        mapPaths,
        mapsRoot: mapsRoot || null,
        hybridMapPack: hybridMapPack || null,
        floorFriction,
        floorLayers,
        floorArt,
        artLayers,
        genre,
        huntId,
        hunt,
        waypoints,
        loopWaypoints,
        spawns,
        props,
        spawnMode,
        waves,
        parties,
        stairLinks,
        navmeshData,
        maxFrames,
        maxTicks,
        maxKills,
        maxSeconds,
        noAttackTimeoutSec,
        pacingBudget,
        layoutMeta,
        floorMeta,
        arenaLoop,
        perFloorWaypoints,
        recordSteps,
        stopOnEnd,
        commandHistory: Array.isArray(config.commandHistory)
            ? config.commandHistory.slice()
            : Array.isArray(hunt.commandHistory)
              ? hunt.commandHistory.slice()
              : null,
        forceAiControl: config.forceAiControl != null ? !!config.forceAiControl : !!hunt.forceAiControl,
        corpseLoot: pickOptionalBoolean([
            config.corpseLoot,
            config.features && config.features.corpseLoot,
            hunt.corpseLoot,
            hunt.features && hunt.features.corpseLoot
        ])
    };
}

/**
 * Run an empty Simulator for `frames` fixed logic steps.
 * Same seed ⇒ same tickCount, sim time, and Math.random sample sequence.
 *
 * @param {object} [input]
 * @returns {Promise<{
 *   seed: number,
 *   frames: number,
 *   tickCount: number,
 *   timeSinceLevelLoad: number,
 *   logicDt: number,
 *   randomSamples: number[],
 *   sessionState: string
 * }>}
 */
async function runHeadlessTicks(input) {
    const config = mergeConfig(input);
    applySettingsFromConfig(config);

    const frames = Math.max(0, parseInt(config.frames, 10) || 0);
    const seed = config.seed >>> 0 || 1;
    const sampleEvery = Math.max(1, parseInt(config.sampleEvery, 10) || 10);

    const prevRandom = Math.random;
    let sim = null;

    try {
        sim = new Simulator({ seed });
        await sim.start();
        // Bootstrap must leave native Math.random (seeded only during updateAll)
        if (Math.random === sim.seededRandom) {
            throw new Error('Math.random still bound after start()');
        }
        sim.active = true;

        const randomSamples = [];

        for (let frame = 0; frame < frames; frame++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            // Sample session LCG directly (Math.random is native between ticks)
            if (frame % sampleEvery === 0 && typeof sim.seededRandom === 'function') {
                randomSamples.push(sim.seededRandom());
            }
        }

        return {
            seed,
            frames,
            tickCount: sim.tickCount,
            timeSinceLevelLoad: Time.timeSinceLevelLoad,
            logicDt: LOGIC_DT,
            randomSamples,
            sessionState: sim.sessionState
        };
    } finally {
        if (sim && typeof sim.destroy === 'function') {
            sim.destroy();
        }
        Math.random = prevRandom;
        unbindSeededRandom();
        Settings.HEADLESS = false;
    }
}

/**
 * Headless ghost-walk: load floor path map, spawn party, tick until route done or max frames.
 *
 * @param {object} [input]
 * @returns {Promise<object>}
 */
async function runHeadlessPartyWalk(input) {
    const config = mergeConfig(input);
    applySettingsFromConfig(config);

    const maxFrames = Math.max(
        1,
        parseInt(
            input && input.frames !== undefined && input.frames !== null
                ? input.frames
                : 2000,
            10
        ) || 2000
    );
    const seed = config.seed >>> 0 || 1;
    const floor = config.floor !== undefined ? config.floor : 7;
    const waypoints =
        Array.isArray(config.waypoints) && config.waypoints.length
            ? config.waypoints
            : DEFAULT_FLOOR07_WAYPOINTS;
    const members =
        Array.isArray(config.members) && config.members.length
            ? config.members
            : [
                  { name: 'Leader', classId: 'fighter', isLeader: true },
                  { name: 'Ally', classId: 'ranger', isLeader: false }
              ];
    const recordSteps = config.recordSteps !== false;
    const stopOnRouteComplete = config.stopOnRouteComplete !== false;

    const prevRandom = Math.random;
    let sim = null;

    try {
        sim = new Simulator({
            seed,
            floor,
            mapPath: config.mapPath || undefined,
            recordSteps,
            combatAi: false,
            parties: [
                {
                    name: config.partyName || 'WalkParty',
                    id: config.partyId || 'walk',
                    waypoints,
                    members
                }
            ]
        });
        await sim.start();
        sim.active = true;

        let framesRun = 0;
        for (let frame = 0; frame < maxFrames; frame++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            framesRun = frame + 1;
            if (stopOnRouteComplete && sim.allRoutesComplete()) {
                break;
            }
        }

        return {
            seed,
            floor,
            frames: framesRun,
            maxFrames,
            tickCount: sim.tickCount,
            timeSinceLevelLoad: Time.timeSinceLevelLoad,
            logicDt: LOGIC_DT,
            sessionState: sim.sessionState,
            routeComplete: sim.allRoutesComplete(),
            stepLog: sim.stepLog.slice(),
            parties: sim.getPartyPositions(),
            waypoints
        };
    } finally {
        if (sim && typeof sim.destroy === 'function') {
            sim.destroy();
        }
        Math.random = prevRandom;
        unbindSeededRandom();
        Settings.HEADLESS = false;
    }
}

/**
 * Headless combat hunt: map + party + spawn table + AI until wipe, route done, limit, or max frames.
 *
 * @param {object} [input]
 * @param {number} [input.seed=1]
 * @param {number} [input.frames] Safety cap / max frames
 * @param {string|number} [input.floor]
 * @param {string} [input.mapPath]
 * @param {string} [input.huntId] Load presets/hunts/<id>.json
 * @param {object} [input.hunt] Inline hunt definition
 * @param {{ x,y,z }[]} [input.waypoints]
 * @param {object[]} [input.spawns]
 * @param {object[]} [input.members] / input.parties
 * @param {number} [input.maxKills]
 * @param {number} [input.maxSeconds]
 * @param {number} [input.maxTicks]
 * @param {boolean} [input.recordSteps=false]
 * @param {boolean} [input.stopOnEnd=true]
 * @param {object[]|Record<string, object>} [input.spellBook]
 * @param {Record<string, object>} [input.strategyTable]
 * @param {(id: string) => object|null} [input.classLoader]
 * @param {object[]|Record<string, object>} [input.itemDb]
 * @param {(id: string) => object|null} [input.creatureLoader]
 * @returns {Promise<object>} Stage 6 summary JSON
 */
async function runHeadlessHunt(input) {
    const config = mergeConfig(input);
    applySettingsFromConfig(config);

    const resolved = resolveHuntConfig(input);
    const {
        seed,
        floor,
        mapPath,
        huntId,
        maxFrames,
        maxTicks,
        maxKills,
        maxSeconds,
        pacingBudget,
        layoutMeta,
        recordSteps,
        stopOnEnd
    } = resolved;

    const prevRandom = Math.random;
    let sim = null;

    try {
        sim = new Simulator(
            huntToSimulatorOpts(resolved, {
                injectors: pickInjectors(input || {}),
                recordSteps,
                combatAi: true,
                headless: true,
                // Opt-in only (browser:parity / bug:repro --parity-*); default off
                ...(input && input.parityTrace !== undefined
                    ? { parityTrace: input.parityTrace }
                    : {})
            })
        );
        await sim.start();
        sim.active = true;

        let framesRun = 0;
        for (let frame = 0; frame < maxFrames; frame++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            framesRun = frame + 1;
            if (stopOnEnd && isSessionTerminal(sim.sessionState)) {
                break;
            }
        }

        if (sim.sessionState === 'running' && framesRun >= maxFrames) {
            sim.sessionState = 'timeout';
            sim.telemetry.endReason = 'timeout';
            sim.telemetry.endTick = sim.tickCount;
        }

        const summary = sim.buildHuntSummary({
            frames: framesRun,
            maxFrames,
            huntId,
            timeSinceLevelLoad: Time.timeSinceLevelLoad,
            logicDt: LOGIC_DT,
            pacingBudget,
            layoutMeta,
            config: {
                seed,
                floor,
                huntId,
                mapPath: mapPath || null,
                maxFrames,
                maxTicks,
                maxKills,
                maxSeconds,
                pacingBudgetId: pacingBudget && pacingBudget.id,
                knob: (input && input.knob) || null,
                knobValue:
                    input && input.knobValue !== undefined
                        ? input.knobValue
                        : null,
                forceAiControl: !!resolved.forceAiControl
            }
        });
        if (recordSteps) {
            summary.stepLog = sim.stepLog.slice();
        }
        return summary;
    } finally {
        if (sim && typeof sim.destroy === 'function') {
            sim.destroy();
        }
        Math.random = prevRandom;
        unbindSeededRandom();
        Settings.HEADLESS = false;
    }
}

/**
 * Stage 12E: run a combat hunt for exactly `tick` logic steps (or until end if stopOnEnd).
 * Used by scrubber tests / CLI — same seed + tick ⇒ same positions / summary core.
 *
 * @param {object} [input] same shape as runHeadlessHunt
 * @param {number} [input.tick] alias for frames when only stopping at T
 * @param {number} [input.toTick] prefer this over frames for the cap
 * @returns {Promise<object>} summary + optional positions snapshot
 */
async function runHeadlessHuntToTick(input) {
    const raw = input || {};
    const toTick = Math.max(
        0,
        parseInt(
            raw.toTick != null
                ? raw.toTick
                : raw.tick != null
                  ? raw.tick
                  : raw.frames != null
                    ? raw.frames
                    : 0,
            10
        ) || 0
    );

    // Cap frames at toTick; default stopOnEnd false so we can land mid-hunt
    const merged = Object.assign({}, raw, {
        frames: toTick > 0 ? toTick : 0,
        stopOnEnd: raw.stopOnEnd !== undefined ? raw.stopOnEnd : false
    });

    if (toTick === 0) {
        // Bootstrap only: start then summary without logic ticks
        const config = mergeConfig(merged);
        applySettingsFromConfig(config);
        const resolved = resolveHuntConfig(merged);
        const prevRandom = Math.random;
        let sim = null;
        try {
            sim = new Simulator(
                huntToSimulatorOpts(resolved, {
                    injectors: pickInjectors(merged),
                    recordSteps: resolved.recordSteps,
                    combatAi: true,
                    headless: true,
                    ...(merged.parityTrace !== undefined
                        ? { parityTrace: merged.parityTrace }
                        : {})
                })
            );
            await sim.start();
            sim.active = true;
            const summary = sim.buildHuntSummary({
                frames: 0,
                maxFrames: 0,
                huntId: resolved.huntId,
                timeSinceLevelLoad: Time.timeSinceLevelLoad,
                logicDt: LOGIC_DT,
                pacingBudget: resolved.pacingBudget,
                layoutMeta: resolved.layoutMeta,
                config: { seed: resolved.seed, toTick: 0, forceAiControl: !!resolved.forceAiControl }
            });
            summary.partyPositions = sim.getPartyPositions();
            return summary;
        } finally {
            if (sim && typeof sim.destroy === 'function') {
                sim.destroy();
            }
            Math.random = prevRandom;
            unbindSeededRandom();
            Settings.HEADLESS = false;
        }
    }

    // Reuse runHeadlessHunt path but keep sim positions: inline loop like hunt
    const config = mergeConfig(merged);
    applySettingsFromConfig(config);
    const resolved = resolveHuntConfig(merged);
    const {
        seed,
        floor,
        huntId,
        maxTicks,
        maxKills,
        pacingBudget,
        layoutMeta,
        recordSteps,
        stopOnEnd
    } = resolved;
    const maxFrames = toTick;

    const prevRandom = Math.random;
    let sim = null;

    try {
        sim = new Simulator(
            huntToSimulatorOpts(resolved, {
                injectors: pickInjectors(merged),
                recordSteps,
                combatAi: true,
                headless: true,
                ...(merged.parityTrace !== undefined
                    ? { parityTrace: merged.parityTrace }
                    : {})
            })
        );
        await sim.start();
        sim.active = true;

        let framesRun = 0;
        for (let frame = 0; frame < maxFrames; frame++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
            framesRun = frame + 1;
            if (stopOnEnd && isSessionTerminal(sim.sessionState)) {
                break;
            }
        }

        const summary = sim.buildHuntSummary({
            frames: framesRun,
            maxFrames,
            huntId,
            timeSinceLevelLoad: Time.timeSinceLevelLoad,
            logicDt: LOGIC_DT,
            pacingBudget,
            layoutMeta,
            config: {
                seed,
                floor,
                huntId,
                toTick,
                maxTicks,
                maxKills,
                forceAiControl: !!resolved.forceAiControl
            }
        });
        summary.partyPositions = sim.getPartyPositions();
        if (recordSteps) {
            summary.stepLog = sim.stepLog.slice();
        }
        return summary;
    } finally {
        if (sim && typeof sim.destroy === 'function') {
            sim.destroy();
        }
        Math.random = prevRandom;
        unbindSeededRandom();
        Settings.HEADLESS = false;
    }
}

/**
 * Default directory for batch summary files.
 * @returns {string}
 */
function defaultSimOutDir() {
    return path.join(ROOT || process.cwd(), 'var', 'sim');
}

/**
 * Write one summary JSON file. Returns absolute path.
 *
 * @param {object} summary
 * @param {string} outDir
 * @param {string} [basename] without extension
 * @returns {string}
 */
function writeSummaryFile(summary, outDir, basename) {
    fs.mkdirSync(outDir, { recursive: true });
    const seed = summary && summary.seed != null ? summary.seed : 'x';
    const hunt = (summary && summary.huntId) || 'hunt';
    const base =
        basename ||
        `${String(hunt).replace(/[^\w.-]+/g, '_')}_seed${seed}`;
    const filePath = path.join(outDir, `${base}.json`);
    fs.writeFileSync(filePath, stableStringify(summary) + '\n', 'utf8');
    return filePath;
}

/**
 * Resolve seed list from batch input.
 * @param {object} config
 * @returns {number[]}
 */
function resolveBatchSeeds(config) {
    if (Array.isArray(config.seeds) && config.seeds.length) {
        return config.seeds.map((s) => s >>> 0 || 1);
    }
    const n = Math.max(1, parseInt(config.iterations, 10) || 1);
    const base = (config.seed !== undefined ? config.seed : 1) >>> 0 || 1;
    const seeds = [];
    for (let i = 0; i < n; i++) {
        seeds.push((base + i) >>> 0 || 1);
    }
    return seeds;
}

/**
 * Run a contiguous slice of a batch in-process (used by workers and sequential path).
 *
 * @param {object} config serializable hunt input (no outDir write)
 * @param {number} startIndex global batch index of first iteration
 * @param {number} count
 * @param {number[]} [seeds] full seed list; when omitted uses seed+i
 * @returns {Promise<object[]>} summaries with batchIndex
 */
function hasManualControl(cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    if (Array.isArray(cfg.commandHistory) && cfg.commandHistory.length > 0) return true;
    if (Array.isArray(cfg.members)) {
        for (let i = 0; i < cfg.members.length; i++) {
            if (cfg.members[i] && cfg.members[i].controlMode === 'manual') return true;
        }
    }
    if (Array.isArray(cfg.parties)) {
        for (let i = 0; i < cfg.parties.length; i++) {
            const p = cfg.parties[i];
            if (p && Array.isArray(p.members)) {
                for (let j = 0; j < p.members.length; j++) {
                    if (p.members[j] && p.members[j].controlMode === 'manual') return true;
                }
            }
        }
    }
    return false;
}

async function runBatchSlice(config, startIndex, count, seeds) {
    const base = Object.assign({}, config || {});
    delete base.iterations;
    delete base.seeds;
    delete base.outDir;
    delete base.writeFiles;
    delete base.quiet;
    delete base.onIteration;
    delete base.concurrency;

    const summaries = [];
    for (let i = 0; i < count; i++) {
        const globalIndex = startIndex + i;
        let seed;
        if (Array.isArray(seeds) && seeds[globalIndex] != null) {
            seed = seeds[globalIndex] >>> 0 || 1;
        } else {
            const baseSeed = (base.seed !== undefined ? base.seed : 1) >>> 0 || 1;
            seed = (baseSeed + globalIndex) >>> 0 || 1;
        }
        const runOpts = Object.assign({}, base, { seed });
        if (globalIndex > 0 && (Array.isArray(runOpts.commandHistory) || hasManualControl(runOpts))) {
            delete runOpts.commandHistory;
            runOpts.forceAiControl = true;
        }
        const summary = await runHeadlessHunt(runOpts);
        summary.batchIndex = globalIndex;
        summary.seed = seed;
        summaries.push(summary);
    }
    return summaries;
}

/**
 * Fork one worker for a chunk. Config must be IPC-serializable.
 * @param {object} config
 * @param {{ startIndex: number, count: number }} chunk
 * @param {number[]} seeds
 * @returns {Promise<object[]>}
 */
function runWorkerChunk(config, chunk, seeds) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const child = fork(BATCH_WORKER_PATH, ['--ipc'], {
            stdio: ['inherit', 'inherit', 'inherit', 'ipc']
        });

        const finish = (err, summaries) => {
            if (settled) return;
            settled = true;
            try {
                child.kill();
            } catch (_) {
                /* ignore */
            }
            if (err) reject(err);
            else resolve(summaries || []);
        };

        child.on('message', (msg) => {
            if (msg && msg.error) {
                finish(new Error(msg.error));
                return;
            }
            finish(null, (msg && msg.summaries) || []);
        });
        child.on('error', (err) => finish(err));
        child.on('exit', (code) => {
            if (!settled) {
                finish(
                    new Error(
                        `Batch worker exited with code ${code} before sending results`
                    )
                );
            }
        });
        child.send({
            config: serializeBatchConfig(config),
            startIndex: chunk.startIndex,
            count: chunk.count,
            seeds
        });
    });
}

/**
 * @param {object} config
 * @param {number[]} seeds
 * @param {number} concurrency
 * @returns {Promise<{ summaries: object[], workerProcessesUsed: number }>}
 */
async function runBatchParallel(config, seeds, concurrency) {
    const iterations = seeds.length;
    const chunks = planWorkerChunks(iterations, concurrency);
    const chunkResults = await Promise.all(
        chunks.map((chunk) => runWorkerChunk(config, chunk, seeds))
    );
    const summaries = chunkResults.flat().sort((a, b) => a.batchIndex - b.batchIndex);
    return { summaries, workerProcessesUsed: chunks.length };
}

/**
 * Run N headless hunts; write one summary file per iteration.
 * Same seed ⇒ same summaryCore (when seed is fixed or seeds[i] fixed).
 * concurrency > 1 forks scripts/batch_worker.js (no function injectors).
 *
 * @param {object} [input]
 * @param {number} [input.iterations=1]
 * @param {number} [input.seed=1] Base seed when `seeds` omitted (seed + i)
 * @param {number[]} [input.seeds] Explicit seed list (overrides iterations length)
 * @param {number} [input.concurrency=1] Worker processes (capped to iterations)
 * @param {string} [input.outDir] default var/sim
 * @param {boolean} [input.writeFiles=true]
 * @param {boolean} [input.quiet=true] suppress per-iter logs
 * @param {function} [input.onIteration] (index, summary, path|null) => void
 * @returns {Promise<{
 *   iterations: number,
 *   outDir: string|null,
 *   files: string[],
 *   summaries: object[],
 *   aggregate: object,
 *   workerProcessesUsed: number
 * }>}
 */
async function runHeadlessHuntBatch(input) {
    const config = input || {};
    const writeFiles = config.writeFiles !== false;
    const quiet = config.quiet !== false;
    const outDir = writeFiles
        ? path.resolve(config.outDir || defaultSimOutDir())
        : null;

    const seeds = resolveBatchSeeds(config);
    const iterations = seeds.length;

    let concurrency = normalizeConcurrency(config.concurrency, iterations);
    // Function injectors (balance knobs) cannot cross IPC — stay in-process
    if (concurrency > 1 && hasNonSerializableInjectors(config)) {
        concurrency = 1;
    }

    const baseInput = Object.assign({}, config);
    delete baseInput.iterations;
    delete baseInput.seeds;
    delete baseInput.outDir;
    delete baseInput.writeFiles;
    delete baseInput.quiet;
    delete baseInput.onIteration;
    delete baseInput.concurrency;

    let summaries;
    let workerProcessesUsed;

    if (concurrency <= 1) {
        summaries = await runBatchSlice(baseInput, 0, iterations, seeds);
        workerProcessesUsed = 1;
    } else {
        const parallel = await runBatchParallel(baseInput, seeds, concurrency);
        summaries = parallel.summaries;
        workerProcessesUsed = parallel.workerProcessesUsed;
    }

    const files = [];
    for (let i = 0; i < summaries.length; i++) {
        const summary = summaries[i];
        const seed = summary.seed;
        const idx = summary.batchIndex != null ? summary.batchIndex : i;
        let filePath = null;
        if (writeFiles && outDir) {
            const hunt = summary.huntId || 'hunt';
            filePath = writeSummaryFile(
                summary,
                outDir,
                `${String(hunt).replace(/[^\w.-]+/g, '_')}_seed${seed}_i${idx}`
            );
            files.push(filePath);
        }

        if (typeof config.onIteration === 'function') {
            config.onIteration(idx, summary, filePath);
        } else if (!quiet) {
            console.log(
                JSON.stringify({
                    i: idx,
                    seed,
                    state: summary.sessionState,
                    kills: summary.kills,
                    exp: summary.expGained,
                    ticks: summary.tickCount,
                    file: filePath
                })
            );
        }
    }

    const aggregate = aggregateSummaries(summaries);
    if (writeFiles && outDir) {
        const aggPath = path.join(outDir, 'batch_aggregate.json');
        fs.writeFileSync(
            aggPath,
            stableStringify(
                Object.assign({}, aggregate, {
                    iterations: seeds.length,
                    seeds,
                    files,
                    workerProcessesUsed,
                    concurrency
                })
            ) + '\n',
            'utf8'
        );
        files.push(aggPath);
    }

    return {
        iterations: seeds.length,
        outDir,
        files,
        summaries,
        aggregate,
        workerProcessesUsed,
        concurrency
    };
}

/**
 * Mean / totals over a batch of summaries (for balance sweeps later).
 * @param {object[]} summaries
 * @returns {object}
 */
function aggregateSummaries(summaries) {
    const list = Array.isArray(summaries) ? summaries : [];
    const n = list.length;
    const zeros = {
        iterations: n,
        kills: 0,
        deaths: 0,
        damageDealt: 0,
        damageTaken: 0,
        expGained: 0,
        lootGained: 0,
        tickCount: 0,
        timeToClear: 0,
        routeComplete: 0,
        partyWipe: 0,
        timeout: 0,
        killCap: 0,
        wavesComplete: 0,
        noAttackTimeout: 0
    };
    if (!n) return zeros;

    for (let i = 0; i < n; i++) {
        const s = list[i];
        zeros.kills += s.kills || 0;
        zeros.deaths += s.deaths || 0;
        zeros.damageDealt += s.damageDealt || 0;
        zeros.damageTaken += s.damageTaken || 0;
        zeros.expGained += s.expGained || 0;
        zeros.lootGained += s.lootGained || 0;
        zeros.tickCount += s.tickCount || 0;
        zeros.timeToClear += s.timeToClear || 0;
        if (s.sessionState === 'route_complete') zeros.routeComplete += 1;
        if (s.sessionState === 'party_wipe') zeros.partyWipe += 1;
        if (s.sessionState === 'timeout') zeros.timeout += 1;
        if (s.sessionState === 'kill_cap') zeros.killCap += 1;
        if (s.sessionState === 'waves_complete') zeros.wavesComplete += 1;
        if (s.sessionState === 'no_attack_timeout') zeros.noAttackTimeout += 1;
    }

    return {
        iterations: n,
        totals: {
            kills: zeros.kills,
            deaths: zeros.deaths,
            damageDealt: zeros.damageDealt,
            damageTaken: zeros.damageTaken,
            expGained: zeros.expGained,
            lootGained: zeros.lootGained,
            tickCount: zeros.tickCount,
            timeToClear: zeros.timeToClear
        },
        means: {
            kills: zeros.kills / n,
            deaths: zeros.deaths / n,
            damageDealt: zeros.damageDealt / n,
            damageTaken: zeros.damageTaken / n,
            expGained: zeros.expGained / n,
            lootGained: zeros.lootGained / n,
            tickCount: zeros.tickCount / n,
            timeToClear: zeros.timeToClear / n,
            expPerHour:
                list.reduce((a, s) => a + (s.expPerHour || 0), 0) / n
        },
        outcomes: {
            routeComplete: zeros.routeComplete,
            partyWipe: zeros.partyWipe,
            timeout: zeros.timeout,
            killCap: zeros.killCap,
            wavesComplete: zeros.wavesComplete,
            noAttackTimeout: zeros.noAttackTimeout
        }
    };
}

module.exports = {
    DEFAULT_CONFIG,
    DEFAULT_FLOOR07_WAYPOINTS,
    DEFAULT_HUNT_MAX_FRAMES,
    mergeConfig,
    applySettingsFromConfig,
    resolveHuntConfig,
    huntToSimulatorOpts,
    isSessionTerminal,
    pickInjectors,
    runHeadlessTicks,
    runHeadlessPartyWalk,
    runHeadlessHunt,
    runHeadlessHuntToTick,
    runHeadlessHuntBatch,
    runBatchSlice,
    normalizeConcurrency,
    planWorkerChunks,
    hasNonSerializableInjectors,
    serializeBatchConfig,
    writeSummaryFile,
    defaultSimOutDir,
    aggregateSummaries,
    summaryCore,
    stableStringify
};
