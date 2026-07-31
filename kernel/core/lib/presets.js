/**
 * Load combat presets (classes, spells, equipment, creature templates, hunts).
 * Stage 9: creature/equipment also resolve from assets/data catalogs with defaults.
 * Node: reads JSON from presets/ under project root.
 * Browser: callers may inject via setPresetCache or pass data directly.
 */

const path = require('path');
const { DEFAULT_GENRE } = require('../../settings.js');
const {
    resolveCreatureTemplate: resolveCreatureFromBridge
} = require('./content/creature_bridge.js');
const {
    buildItemDb,
    resolveEquipmentItem: resolveEquipmentFromBridge
} = require('./content/equipment_bridge.js');
const { resolveHuntWaypoints } = require('./content/waypoints.js');
const {
    resolveHuntSpawnDefs,
    resolveSpawnSource
} = require('./content/legacy_assets.js');
const { resolveHuntPopulationDefs } = require('./dungeon/population.js');
const { getPresetsDir } = require('./modes.js');

let fs = null;
try {
    fs = require('fs');
} catch (_) {
    fs = null;
}

/**
 * Active mode presets root (presets/<mode>/).
 * Kept as a getter so mode switches take effect without reloading this module.
 * @returns {string}
 */
function getPresetsDirResolved() {
    return getPresetsDir();
}

/** @type {Record<string, any>} */
const cache = Object.create(null);

/**
 * @param {string} relPath relative to presets/
 * @returns {boolean}
 */
function cacheHas(relPath) {
    return cache[relPath] !== undefined;
}

/**
 * @param {string} relPath relative to active mode presets/
 * @returns {any}
 */
function loadJson(relPath) {
    if (cache[relPath] !== undefined) return cache[relPath];
    if (!fs || typeof fs.readFileSync !== 'function') {
        throw new Error(
            `presets.loadJson("${relPath}"): fs unavailable (browser). Inject via setPresetCache.`
        );
    }
    const full = path.join(getPresetsDirResolved(), relPath);
    // Browser fs shim always returns existsSync=false; Node reports real missing files.
    if (typeof fs.existsSync === 'function' && !fs.existsSync(full)) {
        throw new Error(
            `presets.loadJson("${relPath}"): not found. Inject via setPresetCache in browser.`
        );
    }
    const raw = fs.readFileSync(full, 'utf8');
    const data = JSON.parse(raw);
    cache[relPath] = data;
    return data;
}

/**
 * Inject or override a cached preset (tests / browser).
 * @param {string} relPath
 * @param {any} data
 */
function setPresetCache(relPath, data) {
    cache[relPath] = data;
}

/** Clear all cached presets. */
function clearPresetCache() {
    for (const k of Object.keys(cache)) delete cache[k];
}

/**
 * @returns {{ version?: number, classes: object[] }}
 */
function loadClasses() {
    const data = loadJson('classes.json');
    return data;
}

/**
 * @param {string} classId
 * @returns {object|null}
 */
function getClass(classId) {
    const data = loadClasses();
    const list = data.classes || data;
    if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
            if (list[i].id === classId) return list[i];
        }
        return null;
    }
    return list[classId] || null;
}

/**
 * @returns {{ version?: number, spells: object[] }}
 */
function loadSpells() {
    return loadJson('spells.json');
}

/**
 * @param {string} spellId
 * @returns {object|null}
 */
function getSpell(spellId) {
    const data = loadSpells();
    const list = data.spells || data;
    if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
            if (list[i].id === spellId) return list[i];
        }
        return null;
    }
    return list[spellId] || null;
}

/**
 * Preset-only combat equipment file (no catalog merge).
 * @returns {{ version?: number, items: object[] }}
 */
function loadEquipmentPreset() {
    return loadJson('equipment.json');
}

/**
 * Combat equipment: presets/equipment.json only (backward compatible).
 * Prefer loadCombatItemDb() when catalog gear should be available.
 * @returns {{ version?: number, items: object[] }}
 */
function loadEquipment() {
    return loadEquipmentPreset();
}

/**
 * @param {string} itemId
 * @returns {object|null}
 */
function getEquipmentItem(itemId) {
    const data = loadEquipmentPreset();
    const list = data.items || data;
    if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
            if (list[i].id === itemId) return list[i];
        }
        return null;
    }
    return list[itemId] || null;
}

/**
 * Merged item db: catalog equipment (category defaults) + preset overrides.
 * @param {{ genre?: string, includeCatalog?: boolean }} [opts]
 * @returns {object[]}
 */
function loadCombatItemDb(opts) {
    const options = opts || {};
    const preset = loadEquipmentPreset();
    const presetItems = Array.isArray(preset.items) ? preset.items : [];
    const includeCatalog = options.includeCatalog !== false;
    return buildItemDb({
        presetItems,
        genre: options.genre || DEFAULT_GENRE,
        loadCatalogFromDisk: includeCatalog,
        fillCatalog: true
    });
}

/**
 * Resolve one equipment item: preset → catalog + category defaults.
 * @param {string} itemId
 * @param {{ genre?: string }} [opts]
 * @returns {object|null}
 */
function resolveEquipmentItem(itemId, opts) {
    return resolveEquipmentFromBridge(itemId, {
        genre: (opts && opts.genre) || DEFAULT_GENRE,
        getPresetItem: getEquipmentItem
    });
}

/**
 * Load raw combat template from presets/creatures only (no catalog).
 * @param {string} creatureId
 * @returns {object|null}
 */
function loadCreatureTemplateRaw(creatureId) {
    if (!creatureId) return null;
    const rel = path.join('creatures', `${creatureId}.json`);
    if (cache[rel] !== undefined) return cache[rel];
    if (!fs) {
        // Browser: only cached templates exist
        return null;
    }
    const full = path.join(getPresetsDirResolved(), rel);
    if (!fs.existsSync(full)) return null;
    try {
        return loadJson(rel);
    } catch (_) {
        return null;
    }
}

/**
 * Combat template: presets/creatures/<id>.json, else catalog + defaults.
 * @param {string} creatureId e.g. 'dummy' or catalog id
 * @param {{ genre?: string }} [opts]
 * @returns {object}
 */
function loadCreatureTemplate(creatureId, opts) {
    const options = opts || {};
    const resolved = resolveCreatureFromBridge(creatureId, {
        genre: options.genre || DEFAULT_GENRE,
        loadPresetTemplate: loadCreatureTemplateRaw
    });
    if (!resolved) {
        throw new Error(
            `loadCreatureTemplate: unknown creature "${creatureId}" (no preset and no catalog entry)`
        );
    }
    return resolved;
}

/**
 * All creature template ids: preset files + optional catalog ids.
 * @param {{ includeCatalog?: boolean, genre?: string }} [opts]
 * @returns {string[]}
 */
function listCreatureTemplateIds(opts) {
    const options = opts || {};
    /** @type {Set<string>} */
    const ids = new Set();
    if (fs) {
        const dir = path.join(getPresetsDirResolved(), 'creatures');
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .forEach((f) => ids.add(f.replace(/\.json$/, '')));
        }
    }
    // Browser cache: any creatures/*.json keys
    for (const k of Object.keys(cache)) {
        const m = /^creatures[/\\](.+)\.json$/.exec(k);
        if (m) ids.add(m[1]);
    }
    if (options.includeCatalog !== false && fs) {
        try {
            const { loadCatalog } = require('./creature_manifest.js');
            const cat = loadCatalog(options.genre || DEFAULT_GENRE, {
                kind: 'creatures'
            });
            for (let i = 0; i < (cat.creatures || []).length; i++) {
                if (cat.creatures[i] && cat.creatures[i].id) {
                    ids.add(cat.creatures[i].id);
                }
            }
        } catch (_) {
            /* ignore */
        }
    }
    return Array.from(ids).sort();
}

/**
 * @returns {{ version?: number, strategies: object[] }}
 */
function loadStrategies() {
    try {
        return loadJson('strategies.json');
    } catch (_) {
        // Browser without cache — callers use DEFAULT_STRATEGIES
        return { version: 1, strategies: [] };
    }
}

/**
 * @param {string} strategyId
 * @returns {object|null}
 */
function getStrategy(strategyId) {
    const data = loadStrategies();
    const list = data.strategies || data;
    if (Array.isArray(list)) {
        for (let i = 0; i < list.length; i++) {
            if (list[i].id === strategyId) return list[i];
        }
        return null;
    }
    return list[strategyId] || null;
}

/**
 * Load a named waypoint route (presets/waypoints/<id>.json).
 * @param {string} presetId
 * @returns {object}
 */
function loadWaypointPreset(presetId) {
    return loadJson(path.join('waypoints', `${presetId}.json`));
}

/**
 * @returns {string[]}
 */
function listWaypointPresetIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^waypoints[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'waypoints');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

/**
 * Load a population table (presets/populations/<id>.json).
 * @param {string} populationId
 * @returns {object}
 */
function loadPopulation(populationId) {
    return loadJson(path.join('populations', `${populationId}.json`));
}

/**
 * @returns {string[]}
 */
function listPopulationIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^populations[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'populations');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

/**
 * Load marker / gizmo rules (presets/markers/<id>.json).
 * @param {string} markersId
 * @returns {object}
 */
function loadMarkerRules(markersId) {
    return loadJson(path.join('markers', `${markersId}.json`));
}

/**
 * @returns {string[]}
 */
function listMarkerRuleIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^markers[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'markers');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

/**
 * Load a piece pack (presets/pieces/<id>.json). Stage 11.3.
 * Returns raw JSON; call dungeon.normalizePiecePack for runtime form.
 * @param {string} packId e.g. 'cave_v1'
 * @returns {object}
 */
function loadPiecePack(packId) {
    return loadJson(path.join('pieces', `${packId}.json`));
}

/**
 * @returns {string[]}
 */
function listPiecePackIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^pieces[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'pieces');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

/**
 * Load a dungeon profile (presets/dungeons/<id>.json). Stage 11.4.
 * Rule program + piecePack / population / markers pointers.
 * @param {string} profileId e.g. 'small_crawl'
 * @returns {object}
 */
function loadDungeonProfile(profileId) {
    return loadJson(path.join('dungeons', `${profileId}.json`));
}

/**
 * @returns {string[]}
 */
function listDungeonProfileIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^dungeons[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'dungeons');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

/**
 * Collect ids from setPresetCache keys for a folder prefix (browser pack path).
 * Browser esbuild aliases `fs` to a stub with existsSync()=false; listing must
 * not depend on real disk when presets were injected into the cache.
 * @param {string} folder e.g. 'parties', 'player_profiles'
 * @returns {string[]}
 */
function listIdsFromCache(folder) {
    const prefix = String(folder || '').replace(/[/\\]+$/, '');
    if (!prefix) return [];
    const re = new RegExp(
        `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\](.+)\\.json$`
    );
    const ids = [];
    for (const k of Object.keys(cache)) {
        const m = re.exec(k);
        if (m) ids.push(m[1]);
    }
    return ids.sort();
}

/**
 * List JSON ids under presets/<folder>/ — disk when available, else cache.
 * @param {string} folder
 * @returns {string[]}
 */
function listPresetFolderIds(folder) {
    if (fs && typeof fs.readdirSync === 'function') {
        const dir = path.join(getPresetsDirResolved(), folder);
        if (typeof fs.existsSync === 'function' && fs.existsSync(dir)) {
            return fs
                .readdirSync(dir)
                .filter((f) => f.endsWith('.json'))
                .map((f) => f.replace(/\.json$/, ''))
                .sort();
        }
    }
    return listIdsFromCache(folder);
}

/**
 * Load a player character profile (presets/player_profiles/<id>.json).
 * Used by party members with `profileId` (Phase 5 slot mapping).
 * @param {string} profileId e.g. 'guardian_starter'
 * @returns {object}
 */
function loadPlayerProfile(profileId) {
    return loadJson(path.join('player_profiles', `${profileId}.json`));
}

/**
 * @returns {string[]}
 */
function listPlayerProfileIds() {
    return listPresetFolderIds('player_profiles');
}

/**
 * Load a party composition (presets/parties/<id>.json) and expand profileIds.
 * @param {string} partyId e.g. 'starter_duo'
 * @param {{ loadPlayerProfile?: (id: string) => object|null }} [opts]
 * @returns {object}
 */
function loadParty(partyId, opts) {
    const raw = loadJson(path.join('parties', `${partyId}.json`));
    const { expandPartyMembers } = require('./character/player_profile.js');
    return expandPartyMembers(raw, {
        loadPlayerProfile:
            opts && typeof opts.loadPlayerProfile === 'function'
                ? opts.loadPlayerProfile
                : loadPlayerProfile
    });
}

/**
 * @returns {string[]}
 */
function listPartyIds() {
    return listPresetFolderIds('parties');
}

/**
 * Load a biome pack manifest (presets/biomes/<id>.json). Stage 11.7.
 * Bundles piece pack + population + markers + profile ids for one biome.
 * @param {string} biomeId e.g. 'cave'
 * @returns {object}
 */
function loadBiomePack(biomeId) {
    return loadJson(path.join('biomes', `${biomeId}.json`));
}

/**
 * @returns {string[]}
 */
function listBiomePackIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^biomes[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'biomes');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

/**
 * Load an art set pack (presets/art_sets/<id>.json). Stage 11.9.
 * Lists genre tiles catalog ids by role for decorative binding.
 * @param {string} artSetId e.g. 'cave'
 * @returns {object}
 */
function loadArtSet(artSetId) {
    return loadJson(path.join('art_sets', `${artSetId}.json`));
}

/**
 * @returns {string[]}
 */
function listArtSetIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^art_sets[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'art_sets');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

/**
 * Load a hunt definition (waypoints, spawns, parties).
 * Expands waypointPreset, spawnSource → defs, and population tables when present.
 * @param {string} huntId e.g. 'cave_crawl_generated'
 * @param {{
 *   loadFloorSpawns?: (id: string|number) => object[],
 *   seed?: number,
 *   populationDensity?: number
 * }} [opts]
 * @returns {object}
 */
function loadHunt(huntId, opts) {
    const raw = loadJson(path.join('hunts', `${huntId}.json`));
    return expandHuntDefinition(raw, opts);
}

/**
 * Expand an inline hunt object (waypoint presets, spawnSource → defs,
 * Stage 11.4 procedural / 11.5 fixed+cutouts layout → friction + sockets,
 * Stage 11.1 population tables → spawn defs, Stage 11.2 marker props,
 * Stage 11.9 art tile binding when artSet resolves).
 * spawnSource / population resolve to spawn **table rows only** (not live creatures).
 * Explicit authored `spawns` win over population (fixtures).
 * Explicit authored `props` win over marker resolve (fixtures).
 * Layout runs first so population/markers can use piece sockets.
 * Art binds after friction exists (layout or multi-floor).
 * @param {object} hunt
 * @param {{
 *   loadFloorSpawns?: (id: string|number) => object[],
 *   seed?: number,
 *   populationDensity?: number,
 *   markerDensity?: number,
 *   loadPopulation?: (id: string) => object,
 *   loadMarkerRules?: (id: string) => object,
 *   loadDungeonProfile?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   loadArtSet?: (id: string) => object,
 *   loadBiomePack?: (id: string) => object,
 *   genre?: string|null
 * }} [opts]
 * @returns {object}
 */
function expandHuntDefinition(hunt, opts) {
    if (!hunt) return hunt;
    const o = opts || {};
    // Capture fixture spawns before spawnSource / population rewrite the table.
    const hadAuthoredSpawns =
        hunt._hadAuthoredSpawns === true ||
        (Array.isArray(hunt.spawns) &&
            hunt.spawns.length > 0 &&
            !hunt.spawnSource &&
            !hunt.spawnSourceSpec &&
            !hunt.populationMeta);

    const hadAuthoredProps =
        hunt._hadAuthoredProps === true ||
        (Array.isArray(hunt.props) &&
            hunt.props.length > 0 &&
            !hunt.markersMeta);

    // Stage 11.4 / 11.5: layout → floorFriction, waypoints, sockets (+ cutout spawns)
    const { resolveHuntLayout } = require('./dungeon/layout/procedural.js');
    const { normalizePiecePack } = require('./dungeon/pieces.js');
    let out = resolveHuntLayout(hunt, {
        seed: o.seed,
        loadDungeonProfile:
            typeof o.loadDungeonProfile === 'function'
                ? o.loadDungeonProfile
                : loadDungeonProfile,
        loadPiecePack:
            typeof o.loadPiecePack === 'function'
                ? o.loadPiecePack
                : loadPiecePack,
        normalizePiecePack,
        loadPopulation:
            typeof o.loadPopulation === 'function'
                ? o.loadPopulation
                : loadPopulation
    });

    out = resolveHuntWaypoints(out, { loadWaypointPreset });
    out = Object.assign({}, out, {
        _hadAuthoredSpawns: hadAuthoredSpawns,
        _hadAuthoredProps: hadAuthoredProps
    });
    out = resolveHuntSpawnDefs(out, o);
    out = resolveHuntPopulationDefs(out, {
        seed: o.seed,
        populationDensity: o.populationDensity,
        loadFloorSpawns: o.loadFloorSpawns,
        resolveSpawnSource,
        loadPopulation:
            typeof o.loadPopulation === 'function'
                ? o.loadPopulation
                : loadPopulation
    });
    const { resolveHuntMarkerDefs } = require('./dungeon/markers.js');
    out = resolveHuntMarkerDefs(out, {
        seed: o.seed,
        markerDensity: o.markerDensity,
        loadMarkerRules:
            typeof o.loadMarkerRules === 'function'
                ? o.loadMarkerRules
                : loadMarkerRules
    });

    // Stage 11.9: decorative art layer (artSet → tiles catalog cells)
    const { bindHuntArt } = require('./dungeon/art.js');
    out = bindHuntArt(out, {
        seed: o.seed,
        loadArtSet:
            typeof o.loadArtSet === 'function' ? o.loadArtSet : loadArtSet,
        loadBiomePack:
            typeof o.loadBiomePack === 'function'
                ? o.loadBiomePack
                : loadBiomePack,
        loadDungeonProfile:
            typeof o.loadDungeonProfile === 'function'
                ? o.loadDungeonProfile
                : loadDungeonProfile,
        genre: o.genre != null ? o.genre : out.genre
    });

    // Party roster is no longer authored on hunts (select partyId at session time).
    // If a legacy/fixture hunt still embeds parties[], expand profileId for compat.
    if (Array.isArray(out.parties) && out.parties.length) {
        const { expandParties } = require('./character/player_profile.js');
        const loadProf =
            typeof o.loadPlayerProfile === 'function'
                ? o.loadPlayerProfile
                : loadPlayerProfile;
        out = Object.assign({}, out, {
            parties: expandParties(out.parties, {
                loadPlayerProfile: loadProf
            })
        });
    }
    return out;
}

/**
 * @returns {string[]}
 */
function listHuntIds() {
    if (!fs) {
        const ids = [];
        for (const k of Object.keys(cache)) {
            const m = /^hunts[/\\](.+)\.json$/.exec(k);
            if (m) ids.push(m[1]);
        }
        return ids.sort();
    }
    const dir = path.join(getPresetsDirResolved(), 'hunts');
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
}

module.exports = {
    get PRESETS_DIR() {
        return getPresetsDirResolved();
    },
    getPresetsDir: getPresetsDirResolved,
    loadJson,
    setPresetCache,
    clearPresetCache,
    cacheHas,
    loadClasses,
    getClass,
    loadSpells,
    getSpell,
    loadEquipment,
    loadEquipmentPreset,
    getEquipmentItem,
    loadCombatItemDb,
    resolveEquipmentItem,
    loadCreatureTemplateRaw,
    loadCreatureTemplate,
    listCreatureTemplateIds,
    loadStrategies,
    getStrategy,
    loadWaypointPreset,
    listWaypointPresetIds,
    loadPopulation,
    listPopulationIds,
    loadMarkerRules,
    listMarkerRuleIds,
    loadPiecePack,
    listPiecePackIds,
    loadDungeonProfile,
    listDungeonProfileIds,
    loadPlayerProfile,
    listPlayerProfileIds,
    loadParty,
    listPartyIds,
    loadBiomePack,
    listBiomePackIds,
    loadArtSet,
    listArtSetIds,
    loadHunt,
    expandHuntDefinition,
    listHuntIds
};
