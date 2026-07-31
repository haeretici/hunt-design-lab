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
        commandHistory: Array.isArray(x.commandHistory)
            ? x.commandHistory.slice()
            : Array.isArray(r.commandHistory)
              ? r.commandHistory.slice()
              : null,
        forceAiControl: x.forceAiControl != null ? !!x.forceAiControl : !!r.forceAiControl
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
    'inventoryPractice',
    'commandHistory',
    'forceAiControl'
]);

module.exports = {
    INJECTOR_KEYS,
    SIMULATOR_HUNT_FIELD_KEYS,
    pickInjectors,
    isSessionTerminal,
    huntToSimulatorOpts
};
