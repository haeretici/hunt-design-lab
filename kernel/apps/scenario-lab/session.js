/**
 * Pure helpers for the browser Scenario Lab (Stage 12G.2 shell).
 * No DOM — form state + Simulator opts from scenario fixtures.
 * Avoids headless_runner (Node child_process) so the browser bundle stays clean.
 */

'use strict';

const {
    applyScenario,
    getScenarioMeta,
    pickScenarioSettings,
    splitScenarioOpts,
    SCENARIO_SETTINGS_KEYS
} = require('../../core/lib/hunt_scenarios.js');
const { loadHunt, expandHuntDefinition } = require('../../core/lib/presets.js');
const {
    huntToSimulatorOpts
} = require('../../providers/simulator/hunt_opts.js');

/**
 * Read scenario UI variables into a plain object.
 * @param {object} form
 * @param {string} form.scenarioId
 * @param {string|number} [form.seed]
 * @param {string} [form.partyId]
 * @param {object[]} [form.members] enabled form members (party editor)
 * @param {Record<string, string|number|boolean>} [form.settings]
 * @returns {{
 *   scenarioId: string,
 *   seed: number,
 *   partyId: string|null,
 *   members: object[]|null,
 *   settings: Record<string, number|boolean>|null
 * }}
 */
function normalizeScenarioForm(form) {
    const f = form || {};
    const scenarioId =
        f.scenarioId != null && String(f.scenarioId).trim() !== ''
            ? String(f.scenarioId).trim()
            : 'choke_pack';

    let seed = 1;
    if (f.seed != null && String(f.seed).trim() !== '') {
        const n = parseInt(String(f.seed).trim(), 10);
        if (Number.isFinite(n)) seed = n >>> 0 || 1;
    }

    const partyId =
        f.partyId != null && String(f.partyId).trim() !== ''
            ? String(f.partyId).trim()
            : null;
    const members = Array.isArray(f.members) ? f.members : null;

    let settings = null;
    if (f.settings && typeof f.settings === 'object') {
        /** @type {Record<string, number|boolean>} */
        const raw = Object.create(null);
        for (const key of Object.keys(f.settings)) {
            if (!SCENARIO_SETTINGS_KEYS.has(key)) continue;
            const v = f.settings[key];
            if (typeof v === 'boolean') {
                raw[key] = v;
            } else if (v != null && String(v).trim() !== '') {
                const num = Number(v);
                if (Number.isFinite(num)) raw[key] = num;
            }
        }
        settings = pickScenarioSettings(raw);
    }

    return { scenarioId, seed, partyId, members, settings };
}

/**
 * Default form values when a scenario is selected.
 * @param {string} scenarioId
 * @returns {{
 *   scenarioId: string,
 *   seed: number,
 *   partyId: string|null,
 *   settings: Record<string, number|boolean>|null,
 *   members: object[]|null
 * }}
 */
function formDefaultsForScenario(scenarioId) {
    const meta = getScenarioMeta(scenarioId);
    let partyId = null;
    /** @type {object[]|null} */
    let members = null;
    try {
        const {
            loadScenario
        } = require('../../core/lib/hunt_scenarios.js');
        const raw = loadScenario(scenarioId);
        if (raw && raw.partyId) partyId = String(raw.partyId);
        // Fixture-authored party (e.g. inventorySandbox solo) wins over default party
        if (Array.isArray(raw.members) && raw.members.length) {
            members = raw.members.map((m) =>
                m && typeof m === 'object' ? Object.assign({}, m) : m
            );
        }
    } catch (_) {
        /* ignore */
    }
    return {
        scenarioId: meta.id,
        seed: meta.seed != null ? meta.seed : 1,
        partyId,
        settings: meta.settings ? Object.assign({}, meta.settings) : null,
        members
    };
}

/**
 * Resolve applied scenario input into hunt-shaped fields (browser-safe).
 * Mirrors the override order of headless resolveHuntConfig for scenario use.
 *
 * @param {object} runnerInput from splitScenarioOpts
 * @returns {object}
 */
function resolveScenarioHunt(runnerInput) {
    const config = runnerInput || {};
    const seed = config.seed >>> 0 || 1;

    let hunt = null;
    let huntId = config.huntId || null;
    if (huntId) {
        try {
            hunt = expandHuntDefinition(loadHunt(huntId));
        } catch (_) {
            hunt = null;
        }
    }
    if (!hunt) {
        try {
            hunt = expandHuntDefinition(loadHunt('cave_crawl_generated'));
            if (!huntId) huntId = 'cave_crawl_generated';
        } catch (_) {
            hunt = { floor: 7, waypoints: [], spawns: [], parties: [] };
        }
    }
    if (!huntId && hunt && hunt.id) huntId = hunt.id;

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
              : [];
    const spawns =
        Array.isArray(config.spawns) && config.spawns.length
            ? config.spawns
            : hunt.spawns || [];
    // Sequential arena waves: scenario override > hunt file
    const waves =
        config.waves != null
            ? config.waves
            : hunt && hunt.waves != null
              ? hunt.waves
              : null;

    const genre = config.genre || hunt.genre || null;

    const limits = Object.assign({}, hunt.limits || {}, config.limits || {});
    if (config.maxKills != null) limits.maxKills = config.maxKills;
    if (config.maxSeconds != null) limits.maxSeconds = config.maxSeconds;
    if (config.maxTicks != null) limits.maxTicks = config.maxTicks;
    if (config.noAttackTimeoutSec != null) {
        limits.noAttackTimeoutSec = config.noAttackTimeoutSec;
    }

    let maxTicks = limits.maxTicks != null ? Math.floor(limits.maxTicks) : null;
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

    const loopWaypoints =
        config.loopWaypoints != null
            ? !!config.loopWaypoints
            : !!hunt.loopWaypoints;

    const floorFriction =
        config.floorFriction ||
        (hunt.floorFriction && hunt.floorFriction.friction
            ? hunt.floorFriction
            : null);
    const floorLayers =
        config.floorLayers ||
        (hunt.floorLayers && typeof hunt.floorLayers === 'object'
            ? hunt.floorLayers
            : null);
    const hasGeneratedFloor = !!(floorFriction || floorLayers);
    const props =
        Array.isArray(config.props) && config.props.length
            ? config.props
            : Array.isArray(hunt.props)
              ? hunt.props
              : [];

    /** @type {'eager'|'on_demand'|undefined} */
    let spawnMode;
    if (config.spawnMode === 'on_demand' || hunt.spawnMode === 'on_demand') {
        spawnMode = 'on_demand';
    } else if (config.spawnMode === 'eager' || hunt.spawnMode === 'eager') {
        spawnMode = 'eager';
    }

    const stairLinks =
        Array.isArray(config.stairLinks) && config.stairLinks.length
            ? config.stairLinks
            : Array.isArray(hunt.stairLinks) && hunt.stairLinks.length
              ? hunt.stairLinks
              : null;

    const {
        resolveSessionParties
    } = require('../../core/lib/character/party_resolve.js');
    let parties = resolveSessionParties(config, {
        hunt,
        waypoints,
        stairLinks,
        loopWaypoints
    });

    const navmeshData =
        (config.navmeshData && typeof config.navmeshData === 'object'
            ? config.navmeshData
            : null) ||
        (hunt.navmeshData && typeof hunt.navmeshData === 'object'
            ? hunt.navmeshData
            : null) ||
        (hunt.navmesh && typeof hunt.navmesh === 'object' ? hunt.navmesh : null);
    const layoutMeta =
        (hunt.layoutMeta && typeof hunt.layoutMeta === 'object'
            ? hunt.layoutMeta
            : null) ||
        (config.layoutMeta && typeof config.layoutMeta === 'object'
            ? config.layoutMeta
            : null);
    const floorMeta =
        (Array.isArray(config.floorMeta) ? config.floorMeta : null) ||
        (Array.isArray(hunt.floorMeta) ? hunt.floorMeta : null) ||
        (layoutMeta && Array.isArray(layoutMeta.floorMeta)
            ? layoutMeta.floorMeta
            : null);
    const pacingBudget =
        (config.pacingBudget && typeof config.pacingBudget === 'object'
            ? config.pacingBudget
            : null) ||
        (hunt.pacingBudget && typeof hunt.pacingBudget === 'object'
            ? hunt.pacingBudget
            : null);
    const floorArt = config.floorArt || hunt.floorArt || null;
    const artLayers =
        (config.artLayers && typeof config.artLayers === 'object'
            ? config.artLayers
            : null) ||
        (hunt.artLayers && typeof hunt.artLayers === 'object'
            ? hunt.artLayers
            : null);
    const mapPaths =
        (config.mapPaths && typeof config.mapPaths === 'object'
            ? config.mapPaths
            : null) ||
        (hunt.mapPaths && typeof hunt.mapPaths === 'object'
            ? hunt.mapPaths
            : null);

    // Attach stair links on parties (headless does the same).
    if (stairLinks && Array.isArray(parties)) {
        parties = parties.map((p) =>
            Object.assign({}, p, {
                stairLinks: p.stairLinks || stairLinks
            })
        );
    }

    return {
        seed,
        floor,
        floors,
        mapPath: config.mapPath || hunt.mapPath || undefined,
        mapPaths,
        floorFriction,
        floorLayers,
        floorArt,
        artLayers,
        genre,
        huntId,
        hunt,
        waypoints,
        spawns,
        waves,
        props,
        spawnMode,
        stairLinks,
        navmeshData,
        pacingBudget,
        layoutMeta,
        floorMeta,
        parties,
        loopWaypoints,
        maxTicks,
        maxKills,
        maxSeconds,
        noAttackTimeoutSec
    };
}

/**
 * Merge scenario fixture + form overrides → Simulator constructor options.
 *
 * @param {object} form from normalizeScenarioForm
 * @param {object} [injectors] from buildPresetInjectors()
 * @param {string|null} [mapPath] browser map URL
 * @returns {{
 *   simOpts: object,
 *   scenarioSettings: Record<string, number|boolean>|null,
 *   meta: object,
 *   resolved: object
 * }}
 */
/**
 * Copy inventory / condition seed flags from scenario members onto form party
 * rows so UI party edits do not strip inventorySandbox / backpack trees or
 * authored starting conditions (status strip demos).
 * @param {object[]} formMembers
 * @param {object[]|null|undefined} scenarioMembers
 * @returns {object[]}
 */
function mergeScenarioInventorySeeds(formMembers, scenarioMembers) {
    if (!Array.isArray(formMembers) || !formMembers.length) {
        return formMembers;
    }
    if (!Array.isArray(scenarioMembers) || !scenarioMembers.length) {
        return formMembers;
    }
    const out = formMembers.map((m) =>
        m && typeof m === 'object' ? Object.assign({}, m) : m
    );
    const used = new Set();
    for (let i = 0; i < out.length; i++) {
        const row = out[i];
        if (!row || row.enabled === false) continue;
        let src = null;
        if (row.profileId) {
            for (let j = 0; j < scenarioMembers.length; j++) {
                if (used.has(j)) continue;
                const sm = scenarioMembers[j];
                if (
                    sm &&
                    sm.profileId != null &&
                    String(sm.profileId) === String(row.profileId)
                ) {
                    src = sm;
                    used.add(j);
                    break;
                }
            }
        }
        if (!src && i < scenarioMembers.length && !used.has(i)) {
            src = scenarioMembers[i];
            used.add(i);
        }
        if (!src || typeof src !== 'object') continue;
        if (src.inventorySandbox === true) row.inventorySandbox = true;
        if (src.inventory != null) row.inventory = src.inventory;
        if (src.backpack != null) row.backpack = src.backpack;
        if (Array.isArray(src.conditions) && src.conditions.length) {
            row.conditions = src.conditions.slice();
        }
        if (src.name && (!row.name || row.name === 'Leader')) {
            row.name = String(src.name);
        }
    }
    return out;
}

function buildScenarioSimulatorOpts(form, injectors, mapPath) {
    const n = normalizeScenarioForm(form);
    const meta = getScenarioMeta(n.scenarioId);

    /** @type {object[]|null} */
    let scenarioMembers = null;
    try {
        const {
            loadScenario
        } = require('../../core/lib/hunt_scenarios.js');
        const raw = loadScenario(n.scenarioId);
        if (Array.isArray(raw.members) && raw.members.length) {
            scenarioMembers = raw.members;
        }
    } catch (_) {
        /* ignore */
    }

    /** @type {object} */
    const overrides = { seed: n.seed };
    if (n.partyId) overrides.partyId = n.partyId;
    // Explicit form members (enable/disable + leader) win over party preset,
    // but keep inventorySandbox / backpack seeds from the fixture when present.
    if (Array.isArray(n.members) && n.members.length) {
        const {
            membersToPartyConfig
        } = require('../game/party_form.js');
        const merged = mergeScenarioInventorySeeds(n.members, scenarioMembers);
        overrides.members = membersToPartyConfig(merged);
        if (n.partyId) overrides.partyId = n.partyId;
    }
    const applied = applyScenario(n.scenarioId, overrides);

    if (n.settings) {
        applied.scenarioSettings = pickScenarioSettings(
            Object.assign({}, applied.scenarioSettings || {}, n.settings)
        );
    }

    const { runnerInput, scenarioSettings } = splitScenarioOpts(applied);
    // When UI supplies members, drop fixture parties so resolve uses members/partyId
    if (Array.isArray(n.members) && n.members.length) {
        delete runnerInput.parties;
        runnerInput.members = overrides.members;
        if (n.partyId) runnerInput.partyId = n.partyId;
    } else if (n.partyId) {
        delete runnerInput.parties;
        runnerInput.partyId = n.partyId;
    }
    const resolved = resolveScenarioHunt(runnerInput);

    const hasGeneratedFloor = !!(
        resolved.floorFriction || resolved.floorLayers
    );
    // Generated friction wins; avoid continent PNG when layout owns the map
    const resolvedMapPath = hasGeneratedFloor
        ? resolved.mapPath || null
        : mapPath || resolved.mapPath || null;

    const simOpts = huntToSimulatorOpts(resolved, {
        injectors: injectors || {},
        mapPath: resolvedMapPath,
        combatAi: true
    });

    return {
        simOpts,
        scenarioSettings,
        meta,
        resolved
    };
}

/**
 * Short party summary lines for the Scenario Lab sidebar (no full editor).
 * @param {object} resolved from resolveScenarioHunt / buildScenarioSimulatorOpts
 * @returns {{ name: string, classId: string, level: number, strategyId: string }[]}
 */
function partySummaryFromResolved(resolved) {
    const out = [];
    const parties = resolved && resolved.parties;
    if (!Array.isArray(parties) || !parties[0]) return out;
    const members = parties[0].members || [];
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m) continue;
        out.push({
            name: m.name || `Member${i + 1}`,
            classId: m.classId || '?',
            level: m.level != null ? m.level : 50,
            strategyId: m.strategyId || 'balanced'
        });
    }
    return out;
}

module.exports = {
    normalizeScenarioForm,
    formDefaultsForScenario,
    resolveScenarioHunt,
    buildScenarioSimulatorOpts,
    partySummaryFromResolved
};
