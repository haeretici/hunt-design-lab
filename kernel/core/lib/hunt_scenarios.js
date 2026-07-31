/**
 * Hunt scenario fixtures (Stage 12G.2).
 *
 * Named combat setups (choke pack, leash, wipe) map to headless runner input
 * and spawn/waypoint patches so tests and balance work skip full corridor walks.
 * Opt-in only: default sims are unchanged until applyScenario / runScenarioHunt.
 *
 * Data: presets/scenarios/<id>.json
 */

'use strict';

const path = require('path');
const { Settings } = require('../../settings.js');
const { getPresetsDir, getBrowserCatalog } = require('./modes.js');

let fs = null;
try {
    fs = require('fs');
} catch (_) {
    fs = null;
}

/**
 * Active mode scenarios directory (presets/<mode>/scenarios).
 * @returns {string}
 */
function getScenariosDir() {
    return path.join(getPresetsDir(), 'scenarios');
}

/** @type {Record<string, object>} */
const cache = Object.create(null);

/**
 * Settings keys scenarios may patch (whitelist). Applied only for the duration
 * of withScenarioSettings / runScenarioHunt, then restored.
 * @type {ReadonlySet<string>}
 */
const SCENARIO_SETTINGS_KEYS = new Set([
    'AI_CREATURE_LEASH',
    'AI_CREATURE_LEASH_REAGGRO_MARGIN',
    'AI_CREATURE_AGGRO_RANGE',
    'AI_DESPAWN_LEASH_TICKS',
    'AI_ENGAGE_RANGE',
    'AI_FLEE_HP_PERCENT'
]);

/**
 * JSON-safe clone.
 * @param {any} v
 * @returns {any}
 */
function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
}

/**
 * Inject or override a cached scenario (tests / browser).
 * @param {string} id
 * @param {object|null} data null deletes
 */
function setScenarioCache(id, data) {
    if (!id) return;
    if (data === null || data === undefined) {
        delete cache[id];
        return;
    }
    cache[id] = data;
}

/** Clear all cached scenarios. */
function clearScenarioCache() {
    for (const k of Object.keys(cache)) delete cache[k];
}

/**
 * @returns {string[]}
 */
function listScenarioIds() {
    /** @type {Set<string>} */
    const ids = new Set(Object.keys(cache));
    const dir = getScenariosDir();
    if (fs && fs.existsSync(dir)) {
        fs.readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .forEach((f) => ids.add(f.replace(/\.json$/, '')));
    }
    return Array.from(ids).sort();
}

/**
 * Load raw scenario JSON (disk or cache).
 * @param {string} id
 * @returns {object}
 */
function loadScenario(id) {
    if (!id || typeof id !== 'string') {
        throw new Error('loadScenario: id required');
    }
    if (cache[id] !== undefined) return cloneJson(cache[id]);
    if (!fs) {
        throw new Error(
            `loadScenario("${id}"): fs unavailable (browser). Inject via setScenarioCache.`
        );
    }
    const full = path.join(getScenariosDir(), `${id}.json`);
    if (!fs.existsSync(full)) {
        throw new Error(`loadScenario: unknown scenario "${id}" (${full})`);
    }
    const raw = fs.readFileSync(full, 'utf8');
    const data = JSON.parse(raw);
    cache[id] = data;
    return cloneJson(data);
}

/**
 * Scenario ids for browser preload (from active mode.json browser.scenarios).
 * Prefer getBrowserScenarioIds() so mode switches are visible.
 * @returns {string[]}
 */
function getBrowserScenarioIds() {
    try {
        return getBrowserCatalog().scenarios.slice();
    } catch (_) {
        return [];
    }
}

/**
 * @deprecated use getBrowserScenarioIds() — snapshot of standard catalog for older tests
 * @type {readonly string[]}
 */
const BROWSER_SCENARIO_IDS = Object.freeze([
    'standard_cave_crawl',
    'choke_pack',
    'leash_test',
    'wipe',
    'legacy_cave_crawl'
]);

/**
 * Lightweight meta for UI lists (Scenario Lab picker).
 * @param {string} id
 * @returns {{
 *   id: string,
 *   label: string,
 *   notes: string,
 *   baseHuntId: string|null,
 *   seed: number|null,
 *   settings: Record<string, number|boolean>|null,
 *   optionKeys: string[]
 * }}
 */
function getScenarioMeta(id) {
    const s = loadScenario(id);
    const settings = pickScenarioSettings(s.settings);
    return {
        id: s.id || id,
        label: s.label || s.id || id,
        notes: s.notes || '',
        baseHuntId: s.baseHuntId || s.huntId || null,
        seed: s.seed != null ? s.seed >>> 0 || 1 : null,
        settings,
        optionKeys: settings ? Object.keys(settings) : []
    };
}

/**
 * Catalog rows for pickers (sorted by id).
 * @param {string[]} [ids] defaults to listScenarioIds()
 * @returns {ReturnType<typeof getScenarioMeta>[]}
 */
function listScenarioCatalog(ids) {
    const list = Array.isArray(ids) && ids.length ? ids : listScenarioIds();
    const out = [];
    for (let i = 0; i < list.length; i++) {
        try {
            out.push(getScenarioMeta(list[i]));
        } catch (_) {
            out.push({
                id: list[i],
                label: list[i],
                notes: '',
                baseHuntId: null,
                seed: null,
                settings: null,
                optionKeys: []
            });
        }
    }
    return out;
}

/**
 * Scenario-owned fields → partial headless runner input.
 * Does not include settings (see withScenarioSettings).
 * @param {object} scenario
 * @returns {object}
 */
function scenarioToInput(scenario) {
    if (!scenario || typeof scenario !== 'object') {
        throw new Error('scenarioToInput: scenario object required');
    }
    /** @type {object} */
    const out = {};
    const baseHuntId = scenario.baseHuntId || scenario.huntId;
    if (baseHuntId) out.huntId = baseHuntId;
    if (scenario.seed != null) out.seed = scenario.seed >>> 0 || 1;
    if (Array.isArray(scenario.waypoints) && scenario.waypoints.length) {
        out.waypoints = cloneJson(scenario.waypoints);
    }
    if (Array.isArray(scenario.spawns)) {
        out.spawns = cloneJson(scenario.spawns);
    }
    if (Array.isArray(scenario.parties) && scenario.parties.length) {
        out.parties = cloneJson(scenario.parties);
    }
    if (
        scenario.partyId != null &&
        String(scenario.partyId).trim() !== ''
    ) {
        out.partyId = String(scenario.partyId).trim();
    }
    if (Array.isArray(scenario.members) && scenario.members.length) {
        out.members = cloneJson(scenario.members);
    }
    if (scenario.limits && typeof scenario.limits === 'object') {
        out.limits = cloneJson(scenario.limits);
    }
    if (scenario.frames != null) out.frames = Math.max(1, parseInt(scenario.frames, 10) || 1);
    if (scenario.maxTicks != null) {
        out.maxTicks = Math.max(1, Math.floor(Number(scenario.maxTicks)));
    }
    if (scenario.maxKills != null) {
        out.maxKills = Math.max(0, Math.floor(Number(scenario.maxKills)));
    }
    if (scenario.maxSeconds != null) {
        out.maxSeconds = Number(scenario.maxSeconds);
    }
    if (scenario.floor !== undefined) out.floor = scenario.floor;
    if (Array.isArray(scenario.floors) && scenario.floors.length) {
        out.floors = scenario.floors.slice();
    }
    if (scenario.mapPath) out.mapPath = scenario.mapPath;
    if (scenario.genre) out.genre = scenario.genre;
    if (
        scenario.spawnMode === 'on_demand' ||
        scenario.spawnMode === 'eager'
    ) {
        out.spawnMode = scenario.spawnMode;
    }
    // Sequential arena waves (override base hunt when present on scenario)
    if (scenario.waves != null) {
        out.waves = cloneJson(scenario.waves);
    }
    // spawnSource → defs at resolveHuntConfig / expandHuntDefinition (not instances)
    if (scenario.spawnSource && typeof scenario.spawnSource === 'object') {
        out.spawnSource = cloneJson(scenario.spawnSource);
    }
    if (scenario.id) out.scenarioId = scenario.id;
    if (scenario.inventoryPractice === true) {
        out.inventoryPractice = true;
    }
    return out;
}

/**
 * Whitelist and clone settings patch from scenario data.
 * @param {object|null|undefined} settings
 * @returns {Record<string, number|boolean>|null}
 */
function pickScenarioSettings(settings) {
    if (!settings || typeof settings !== 'object') return null;
    /** @type {Record<string, number|boolean>} */
    const out = {};
    let any = false;
    for (const key of Object.keys(settings)) {
        if (!SCENARIO_SETTINGS_KEYS.has(key)) continue;
        out[key] = settings[key];
        any = true;
    }
    return any ? out : null;
}

/**
 * Merge scenario onto runner input. Caller overrides win (applied last).
 * Scenario `settings` become `scenarioSettings` on the result (stripped before
 * the headless runner; use withScenarioSettings / runScenarioHunt).
 *
 * @param {string|object} scenarioOrId
 * @param {object} [overrides] Final runner knobs (seed, frames, …)
 * @returns {object}
 */
function applyScenario(scenarioOrId, overrides) {
    const scenario =
        typeof scenarioOrId === 'string'
            ? loadScenario(scenarioOrId)
            : scenarioOrId;
    if (!scenario || typeof scenario !== 'object') {
        throw new Error('applyScenario: scenario id or object required');
    }
    const fromScenario = scenarioToInput(scenario);
    const settings = pickScenarioSettings(scenario.settings);
    if (settings) fromScenario.scenarioSettings = settings;

    /** @type {object} */
    const over = {};
    if (overrides && typeof overrides === 'object') {
        for (const key of Object.keys(overrides)) {
            const v = overrides[key];
            if (v === undefined) continue;
            if (typeof v === 'function') {
                over[key] = v;
            } else if (v !== null && typeof v === 'object') {
                over[key] = cloneJson(v);
            } else {
                over[key] = v;
            }
        }
    }

    const out = Object.assign({}, fromScenario, over);
    if (!out.scenarioId && scenario.id) out.scenarioId = scenario.id;
    return out;
}

/**
 * Apply whitelisted Settings patches for a long-lived session (browser Scenario Lab).
 * Call the returned restore function on stop / page leave.
 *
 * @param {Record<string, number|boolean>|null|undefined} settings
 * @returns {() => void} restore previous values (idempotent)
 */
function openScenarioSettings(settings) {
    if (!settings || typeof settings !== 'object') {
        return () => {};
    }
    /** @type {Record<string, any>} */
    const prev = {};
    const keys = Object.keys(settings);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!SCENARIO_SETTINGS_KEYS.has(k)) continue;
        prev[k] = Settings[k];
        Settings[k] = settings[k];
    }
    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (!Object.prototype.hasOwnProperty.call(prev, k)) continue;
            Settings[k] = prev[k];
        }
    };
}

/**
 * Apply whitelisted Settings patches, run fn, restore previous values.
 * Supports sync or async fn (returns Promise when fn is async).
 * For long browser sessions prefer openScenarioSettings + restore on stop.
 *
 * @param {Record<string, number|boolean>|null|undefined} settings
 * @param {() => any} fn
 * @returns {any}
 */
function withScenarioSettings(settings, fn) {
    if (!settings || typeof settings !== 'object') {
        return fn();
    }
    const restore = openScenarioSettings(settings);
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(
                (v) => {
                    restore();
                    return v;
                },
                (err) => {
                    restore();
                    throw err;
                }
            );
        }
        restore();
        return result;
    } catch (err) {
        restore();
        throw err;
    }
}

/**
 * Strip scenario-only keys before passing to headless_runner.
 * @param {object} opts
 * @returns {{ runnerInput: object, scenarioSettings: Record<string, number|boolean>|null }}
 */
function splitScenarioOpts(opts) {
    const src = opts || {};
    const runnerInput = Object.assign({}, src);
    const scenarioSettings = runnerInput.scenarioSettings
        ? pickScenarioSettings(runnerInput.scenarioSettings)
        : null;
    delete runnerInput.scenarioSettings;
    // scenarioId is harmless metadata; leave it for summaries if ever plumbed
    return { runnerInput, scenarioSettings };
}

/**
 * applyScenario + optional Settings patch + runHeadlessHunt.
 * Lives in a separate Node-only path so the browser bundle does not pull
 * headless_runner (child_process). Prefer requiring this helper only from
 * CLI / tests; the function below re-exports it when Node loads the module.
 *
 * @param {string|object} scenarioOrId
 * @param {object} [overrides]
 * @returns {Promise<object>} Hunt summary
 */
async function runScenarioHunt(scenarioOrId, overrides) {
    // Dynamic path keeps esbuild from bundling headless_runner into the web IIFE
    // when this module is imported for catalog/cache only.
    const runnerPath = '../../providers/simulator/' + 'headless_runner.js';
    const { runHeadlessHunt } = require(runnerPath);
    const merged = applyScenario(scenarioOrId, overrides);
    const { runnerInput, scenarioSettings } = splitScenarioOpts(merged);
    return withScenarioSettings(scenarioSettings, () =>
        runHeadlessHunt(runnerInput)
    );
}

module.exports = {
    get SCENARIOS_DIR() {
        return getScenariosDir();
    },
    getScenariosDir,
    SCENARIO_SETTINGS_KEYS,
    BROWSER_SCENARIO_IDS,
    getBrowserScenarioIds,
    listScenarioIds,
    listScenarioCatalog,
    loadScenario,
    getScenarioMeta,
    scenarioToInput,
    applyScenario,
    pickScenarioSettings,
    openScenarioSettings,
    withScenarioSettings,
    splitScenarioOpts,
    runScenarioHunt,
    setScenarioCache,
    clearScenarioCache,
    cloneJson
};
