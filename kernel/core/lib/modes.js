/**
 * Content mode registry — self-contained packs under presets/<mode>/.
 *
 * Each mode has mode.json (metadata, asset roots, browser preload catalog).
 * Active mode drives presets root + map/navmesh/spawn paths (see applyModePaths).
 *
 * Genre (art catalog under assets/data|sprites) stays orthogonal.
 */

'use strict';

const path = require('path');

// Independent ROOT avoids circular require with settings.js
const ROOT =
    typeof __dirname !== 'undefined'
        ? path.resolve(__dirname, '../../..')
        : '';

let fs = null;
try {
    fs = require('fs');
} catch (_) {
    fs = null;
}

/** @type {string} */
const DEFAULT_MODE_ID = 'standard';

/** @type {string} */
let activeModeId = DEFAULT_MODE_ID;

/** @type {Record<string, object>} */
const modeCache = Object.create(null);

/**
 * @returns {string} absolute or relative presets root (parent of mode folders)
 */
function modesRootDir() {
    return ROOT ? path.join(ROOT, 'presets') : 'presets';
}

/**
 * @param {string} [modeId]
 * @returns {string}
 */
function modePresetsDir(modeId) {
    const id = sanitizeModeId(modeId != null ? modeId : activeModeId);
    return path.join(modesRootDir(), id);
}

/**
 * @param {string} id
 * @returns {string}
 */
function sanitizeModeId(id) {
    const s = String(id || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '');
    if (!s) {
        throw new Error('modes: empty mode id');
    }
    return s;
}

/**
 * Inject mode.json (browser / tests).
 * @param {string} id
 * @param {object|null} data null deletes
 */
function setModeCache(id, data) {
    const mid = sanitizeModeId(id);
    if (data === null || data === undefined) {
        delete modeCache[mid];
        return;
    }
    modeCache[mid] = data;
}

/** Clear cached mode definitions. */
function clearModeCache() {
    for (const k of Object.keys(modeCache)) delete modeCache[k];
}

/**
 * Normalize + validate mode document.
 * @param {object} raw
 * @param {string} [fallbackId]
 * @returns {object}
 */
function normalizeMode(raw, fallbackId) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('modes: invalid mode.json');
    }
    const id = sanitizeModeId(raw.id || fallbackId);
    const assets = raw.assets && typeof raw.assets === 'object' ? raw.assets : {};
    const browser =
        raw.browser && typeof raw.browser === 'object' ? raw.browser : {};
    const features =
        raw.features && typeof raw.features === 'object' ? raw.features : {};
    const defaults =
        raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};

    const list = (v) =>
        Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : [];

    return {
        id,
        label: raw.label || id,
        isDefault: !!raw.isDefault,
        version: raw.version != null ? Number(raw.version) || 1 : 1,
        genre: raw.genre || 'rpg_fantasy',
        assets: {
            maps: assets.maps || 'assets/legacy/maps/v01',
            navmesh: assets.navmesh || 'assets/legacy/maps/v01/navmesh',
            spawns: assets.spawns || null,
            monsters: assets.monsters || null,
            sprites: assets.sprites || 'assets/sprites',
            data: assets.data || 'assets/data'
        },
        features: {
            legacySpawnSource: !!features.legacySpawnSource,
            // Weapon auto-attack when target + weapon conditions allow (not strategy list).
            autoAttack: features.autoAttack !== false,
            // Distance auto consumes quiver ammo stacks (standard product default).
            ammoConsumption: features.ammoConsumption === true,
            // Rune spells consume stackable items from the backpack tree (standard product default).
            runeConsumption: features.runeConsumption === true,
            // Monster auto-summon AI (template summon{} → runtime adds). Default on.
            monsterSummons: features.monsterSummons !== false,
            // Phase C: credit player.experience + level-ups on kill (default off).
            expProgression: features.expProgression === true,
            // Phase D: live skill tries (default off; no-op until D lands).
            skillProgression: features.skillProgression === true,
            // Wild-death corpse container. standard: true (D4). Headless
            // hunt opts pin false so DPS / golden / CI stay scalar.
            corpseLoot: features.corpseLoot === true
        },
        defaults: {
            huntId: defaults.huntId || null,
            scenarioId: defaults.scenarioId || null,
            partyId: defaults.partyId || null
        },
        browser: {
            hunts: list(browser.hunts),
            populations: list(browser.populations),
            creatures: list(browser.creatures),
            dialogs: list(browser.dialogs),
            waypoints: list(browser.waypoints),
            catalogCreatures: list(browser.catalogCreatures),
            scenarios: list(browser.scenarios),
            parties: list(browser.parties),
            playerProfiles: list(browser.playerProfiles)
        }
    };
}

/**
 * Load mode.json from disk or cache.
 * @param {string} modeId
 * @returns {object}
 */
function loadMode(modeId) {
    const id = sanitizeModeId(modeId);
    if (modeCache[id] !== undefined) {
        return normalizeMode(modeCache[id], id);
    }
    if (!fs) {
        throw new Error(
            `loadMode("${id}"): fs unavailable (browser). Inject via setModeCache.`
        );
    }
    const full = path.join(modePresetsDir(id), 'mode.json');
    if (!fs.existsSync(full)) {
        throw new Error(`loadMode: unknown mode "${id}" (${full})`);
    }
    const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    const normalized = normalizeMode(raw, id);
    modeCache[id] = raw;
    return normalized;
}

/**
 * @param {string} modeId
 * @returns {object|null}
 */
function getMode(modeId) {
    try {
        return loadMode(modeId);
    } catch (_) {
        return null;
    }
}

/**
 * List installed modes (disk scan + cache).
 * @returns {{ id: string, label: string, isDefault: boolean }[]}
 */
function listModes() {
    /** @type {Map<string, { id: string, label: string, isDefault: boolean }>} */
    const byId = new Map();

    if (fs) {
        const root = modesRootDir();
        if (fs.existsSync(root)) {
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (let i = 0; i < entries.length; i++) {
                const ent = entries[i];
                if (!ent.isDirectory()) continue;
                const mid = ent.name;
                const modeFile = path.join(root, mid, 'mode.json');
                if (!fs.existsSync(modeFile)) continue;
                try {
                    const m = loadMode(mid);
                    byId.set(m.id, {
                        id: m.id,
                        label: m.label,
                        isDefault: m.isDefault
                    });
                } catch (_) {
                    /* skip invalid */
                }
            }
        }
    }

    for (const id of Object.keys(modeCache)) {
        try {
            const m = normalizeMode(modeCache[id], id);
            if (!byId.has(m.id)) {
                byId.set(m.id, {
                    id: m.id,
                    label: m.label,
                    isDefault: m.isDefault
                });
            }
        } catch (_) {
            /* skip */
        }
    }

    const list = Array.from(byId.values());
    list.sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.id.localeCompare(b.id);
    });
    return list;
}

/**
 * Resolve project-relative path to absolute when ROOT is set.
 * @param {string} rel
 * @returns {string}
 */
function resolveProjectPath(rel) {
    const r = String(rel || '').replace(/^\//, '');
    if (!r) return ROOT || '';
    return ROOT ? path.join(ROOT, r) : r;
}

/**
 * Absolute (or browser-relative) roots for a mode.
 * @param {string} [modeId]
 * @returns {{
 *   modeId: string,
 *   presets: string,
 *   maps: string,
 *   navmesh: string,
 *   spawns: string|null,
 *   monsters: string|null,
 *   sprites: string,
 *   data: string,
 *   mapsRel: string,
 *   navmeshRel: string,
 *   spawnsRel: string|null
 * }}
 */
function modePaths(modeId) {
    const m = loadMode(modeId != null ? modeId : activeModeId);
    const mapsRel = m.assets.maps;
    const navmeshRel = m.assets.navmesh;
    const spawnsRel = m.assets.spawns;
    return {
        modeId: m.id,
        presets: modePresetsDir(m.id),
        maps: resolveProjectPath(mapsRel),
        navmesh: resolveProjectPath(navmeshRel),
        spawns: spawnsRel ? resolveProjectPath(spawnsRel) : null,
        monsters: m.assets.monsters
            ? resolveProjectPath(m.assets.monsters)
            : null,
        sprites: resolveProjectPath(m.assets.sprites),
        data: resolveProjectPath(m.assets.data),
        mapsRel,
        navmeshRel,
        spawnsRel: spawnsRel || null
    };
}

/**
 * Push active mode roots into settings.PATHS (maps, navmesh, presets).
 * Safe if settings not yet fully loaded.
 * @param {string} [modeId]
 */
function applyModePaths(modeId) {
    const id = modeId != null ? sanitizeModeId(modeId) : activeModeId;
    const p = modePaths(id);
    try {
        const settings = require('../../settings.js');
        if (settings.PATHS) {
            settings.PATHS.presets = p.presets;
            settings.PATHS.maps = p.maps;
            settings.PATHS.navmesh = p.navmesh;
        }
    } catch (_) {
        /* ignore */
    }
    return p;
}

/**
 * @returns {string}
 */
function getActiveModeId() {
    return activeModeId;
}

/**
 * @returns {object}
 */
function getActiveMode() {
    return loadMode(activeModeId);
}

/**
 * Switch active content mode; refreshes PATHS and clears preset caches when available.
 * @param {string} modeId
 * @param {{ skipCacheClear?: boolean }} [opts]
 * @returns {object} normalized mode
 */
function setActiveMode(modeId, opts) {
    const id = sanitizeModeId(modeId);
    // Validate exists (disk or cache)
    const mode = loadMode(id);
    activeModeId = id;
    applyModePaths(id);

    if (!(opts && opts.skipCacheClear)) {
        try {
            const presets = require('./presets.js');
            if (presets.clearPresetCache) presets.clearPresetCache();
        } catch (_) {
            /* ignore */
        }
        try {
            const scenarios = require('./hunt_scenarios.js');
            if (scenarios.clearScenarioCache) scenarios.clearScenarioCache();
        } catch (_) {
            /* ignore */
        }
    }
    return mode;
}

/**
 * Active mode presets directory (for loaders).
 * @returns {string}
 */
function getPresetsDir() {
    return modePresetsDir(activeModeId);
}

/**
 * Browser catalog lists for the active (or given) mode.
 * @param {string} [modeId]
 * @returns {object}
 */
function getBrowserCatalog(modeId) {
    return loadMode(modeId != null ? modeId : activeModeId).browser;
}

/**
 * Prefer env HDL_CONTENT_MODE, else default mode from registry, else standard.
 * @returns {string}
 */
function resolveDefaultModeId() {
    if (typeof process !== 'undefined' && process.env && process.env.HDL_CONTENT_MODE) {
        try {
            return sanitizeModeId(process.env.HDL_CONTENT_MODE);
        } catch (_) {
            /* fall through */
        }
    }
    const modes = listModes();
    for (let i = 0; i < modes.length; i++) {
        if (modes[i].isDefault) return modes[i].id;
    }
    if (modes.length) return modes[0].id;
    return DEFAULT_MODE_ID;
}

/**
 * Initialize active mode once (Node startup / browser after cache inject).
 * @param {string} [modeId]
 * @returns {object}
 */
function ensureActiveMode(modeId) {
    const id = modeId != null ? sanitizeModeId(modeId) : resolveDefaultModeId();
    return setActiveMode(id, { skipCacheClear: true });
}

module.exports = {
    DEFAULT_MODE_ID,
    modesRootDir,
    modePresetsDir,
    sanitizeModeId,
    setModeCache,
    clearModeCache,
    normalizeMode,
    loadMode,
    getMode,
    listModes,
    modePaths,
    applyModePaths,
    getActiveModeId,
    getActiveMode,
    setActiveMode,
    getPresetsDir,
    getBrowserCatalog,
    resolveDefaultModeId,
    ensureActiveMode,
    resolveProjectPath
};
