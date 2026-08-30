/**
 * Shared hunt → Simulator constructor options.
 *
 * Headless resolve, Hunt UI, and Scenario Lab must all map the same fields.
 * Adding a Simulator feature only on one path leaves the others silently broken
 * (see sequential waves + browser parity in docs/11_hunt_ui.md).
 *
 * Browser-safe: no fs / child_process. Headless resolve still owns loading
 * presets from disk; this module only maps already-resolved fields.
 */

'use strict';

/**
 * First strict boolean in `values`, else null.
 * @param {unknown[]} values
 * @returns {boolean|null}
 */
function pickOptionalBoolean(values) {
    const list = Array.isArray(values) ? values : [];
    for (let i = 0; i < list.length; i++) {
        if (typeof list[i] === 'boolean') return list[i];
    }
    return null;
}

/**
 * Session corpse-loot flag. Hunt/opts pin wins. Headless (runner extra or
 * Settings.HEADLESS) defaults **false** so DPS/golden/CI keep scalar
 * lootValue. Watch inherits mode.features (standard: true) then Settings.
 *
 * @param {object|null|undefined} resolved
 * @param {object|null|undefined} extra
 * @returns {boolean}
 */
function resolveCorpseLootFlag(resolved, extra) {
    const x = extra || {};
    const r = resolved || {};
    const explicit = pickOptionalBoolean([
        x.corpseLoot,
        x.features && x.features.corpseLoot,
        r.corpseLoot,
        r.features && r.features.corpseLoot
    ]);
    if (explicit !== null) return explicit;

    const headless =
        x.headless === true ||
        (x.headless !== false &&
            (function () {
                try {
                    const { Settings } = require('../../settings.js');
                    return !!(Settings && Settings.HEADLESS);
                } catch (_) {
                    return false;
                }
            })());
    if (headless) return false;

    try {
        const { Settings } = require('../../settings.js');
        if (
            Settings &&
            Settings.features &&
            typeof Settings.features.corpseLoot === 'boolean'
        ) {
            return Settings.features.corpseLoot;
        }
    } catch (_) {
        /* Settings optional */
    }

    try {
        const { getActiveMode } = require('../../core/lib/modes.js');
        const m = getActiveMode();
        if (m && m.features && typeof m.features.corpseLoot === 'boolean') {
            return m.features.corpseLoot;
        }
    } catch (_) {
        /* modes optional */
    }
    return false;
}

/** Injector keys accepted by Simulator (functions / tables). */
const INJECTOR_KEYS = [
    'creatureLoader',
    'classLoader',
    'itemDb',
    'spellBook',
    'strategyTable'
];

/**
 * Optional injectors forwarded to Simulator (balance sweeps / tests / browser).
 * @param {object|null|undefined} input
 * @returns {object}
 */
function pickInjectors(input) {
    if (!input || typeof input !== 'object') return {};
    const out = {};
    for (let i = 0; i < INJECTOR_KEYS.length; i++) {
        const k = INJECTOR_KEYS[i];
        if (input[k] != null) out[k] = input[k];
    }
    return out;
}

/**
 * True when a hunt session has left the playable states.
 * Used by headless stopOnEnd, browser freeze, and live-panel freeze.
 *
 * @param {string|null|undefined} sessionState
 * @returns {boolean}
 */
function isSessionTerminal(sessionState) {
    return (
        sessionState != null &&
        sessionState !== 'running' &&
        sessionState !== 'idle'
    );
}

/**
 * Map resolved hunt fields (+ optional injectors/overrides) → Simulator opts.
 *
 * @param {object} resolved Output of resolveHuntConfig / resolveScenarioHunt /
 *   browser resolved-from-hunt shape (seed, floor, parties, spawns, waves, …).
 * @param {object} [extra]
 * @param {object} [extra.injectors] classLoader / creatureLoader / …
 * @param {string|null} [extra.mapPath] override mapPath (browser continent URL)
 * @param {boolean} [extra.combatAi=true]
 * @param {boolean} [extra.recordSteps]
 * @param {boolean|object} [extra.parityTrace] opt-in split-floor combat/RNG log (default off)
 * @param {boolean} [extra.name]
 * @returns {object} Simulator constructor options
 */
function huntToSimulatorOpts(resolved, extra) {
    const r = resolved || {};
    const x = extra || {};
    const inject =
        x.injectors && typeof x.injectors === 'object'
            ? pickInjectors(x.injectors)
            : pickInjectors(x);

    const mapPath =
        x.mapPath !== undefined
            ? x.mapPath
            : r.mapPath != null
              ? r.mapPath
              : null;

    /** @type {object} */
    const opts = {
        seed: r.seed >>> 0 || 1,
        floor: r.floor,
        floors: Array.isArray(r.floors) ? r.floors.slice() : null,
        mapPath: mapPath || null,
        mapPaths:
            r.mapPaths && typeof r.mapPaths === 'object' ? r.mapPaths : null,
        mapsRoot: typeof r.mapsRoot === 'string' && r.mapsRoot ? r.mapsRoot : null,
        hybridMapPack:
            x.hybridMapPack !== undefined
                ? x.hybridMapPack
                : r.hybridMapPack != null
                  ? r.hybridMapPack
                  : null,
        floorFriction: r.floorFriction || null,
        floorLayers:
            r.floorLayers && typeof r.floorLayers === 'object'
                ? r.floorLayers
                : null,
        floorArt: r.floorArt || null,
        artLayers:
            r.artLayers && typeof r.artLayers === 'object' ? r.artLayers : null,
        genre: r.genre || null,
        huntId: r.huntId != null ? r.huntId : null,
        recordSteps:
            x.recordSteps != null ? !!x.recordSteps : !!r.recordSteps,
        combatAi: x.combatAi !== false && x.combatAi !== 0,
        parties: Array.isArray(r.parties) ? r.parties : [],
        spawns: Array.isArray(r.spawns) ? r.spawns : [],
        props: Array.isArray(r.props) ? r.props : [],
        spawnMode: r.spawnMode,
        waves: r.waves != null ? r.waves : null,
        stairLinks: Array.isArray(r.stairLinks) ? r.stairLinks : null,
        navmeshData:
            r.navmeshData && typeof r.navmeshData === 'object'
                ? r.navmeshData
                : null,
        maxTicks: r.maxTicks != null ? r.maxTicks : null,
        maxKills: r.maxKills != null ? r.maxKills : null,
        maxSeconds: r.maxSeconds != null ? r.maxSeconds : null,
        noAttackTimeoutSec:
            r.noAttackTimeoutSec != null ? r.noAttackTimeoutSec : null,
        pacingBudget:
            r.pacingBudget && typeof r.pacingBudget === 'object'
                ? r.pacingBudget
                : null,
        layoutMeta:
            r.layoutMeta && typeof r.layoutMeta === 'object'
                ? r.layoutMeta
                : null,
        floorMeta: Array.isArray(r.floorMeta) ? r.floorMeta : null,
        arenaLoop:
            r.arenaLoop && typeof r.arenaLoop === 'object' ? r.arenaLoop : null,
        perFloorWaypoints:
            r.perFloorWaypoints && typeof r.perFloorWaypoints === 'object'
                ? r.perFloorWaypoints
                : null,
        commandHistory: Array.isArray(x.commandHistory)
            ? x.commandHistory.slice()
            : Array.isArray(r.commandHistory)
              ? r.commandHistory.slice()
              : null,
        forceAiControl: x.forceAiControl != null ? !!x.forceAiControl : !!r.forceAiControl,
        corpseLoot: resolveCorpseLootFlag(r, x)
    };

    // Inventory practice: keep watch canvas alive after hunt end (drop/pickup lab)
    let inventoryPractice = r.inventoryPractice === true;
    if (!inventoryPractice && Array.isArray(r.parties)) {
        for (let pi = 0; pi < r.parties.length && !inventoryPractice; pi++) {
            const party = r.parties[pi];
            const members = party && Array.isArray(party.members) ? party.members : null;
            if (!members) continue;
            for (let mi = 0; mi < members.length; mi++) {
                const m = members[mi];
                if (m && m.inventorySandbox === true) {
                    inventoryPractice = true;
                    break;
                }
            }
        }
    }
    if (inventoryPractice) opts.inventoryPractice = true;

    if (x.name != null) opts.name = x.name;
    // Split-floor combat/RNG isolation (docs/25). Default: auto after first hop.
    if (x.parityTrace !== undefined) {
        opts.parityTrace = x.parityTrace;
    } else if (r.parityTrace !== undefined) {
        opts.parityTrace = r.parityTrace;
    }

    if (inject.spellBook != null) opts.spellBook = inject.spellBook;
    if (inject.strategyTable != null) opts.strategyTable = inject.strategyTable;
    if (inject.classLoader != null) opts.classLoader = inject.classLoader;
    if (inject.itemDb != null) opts.itemDb = inject.itemDb;
    if (inject.creatureLoader != null) {
        opts.creatureLoader = inject.creatureLoader;
    }

    return opts;
}

/**
 * Simulator-facing keys that headless resolve and the browser builder must share.
 * Used by parity tests.
 * @type {readonly string[]}
 */
const SIMULATOR_HUNT_FIELD_KEYS = Object.freeze([
    'seed',
    'floor',
    'floors',
    'mapPath',
    'mapPaths',
    'hybridMapPack',
    'floorFriction',
    'floorLayers',
    'floorArt',
    'artLayers',
    'genre',
    'huntId',
    'parties',
    'spawns',
    'props',
    'spawnMode',
    'waves',
    'stairLinks',
    'navmeshData',
    'maxTicks',
    'maxKills',
    'maxSeconds',
    'noAttackTimeoutSec',
    'pacingBudget',
    'layoutMeta',
    'floorMeta',
    'arenaLoop',
    'perFloorWaypoints',
    'inventoryPractice',
    'commandHistory',
    'forceAiControl',
    'corpseLoot'
]);

module.exports = {
    INJECTOR_KEYS,
    SIMULATOR_HUNT_FIELD_KEYS,
    pickInjectors,
    pickOptionalBoolean,
    resolveCorpseLootFlag,
    isSessionTerminal,
    huntToSimulatorOpts
};
