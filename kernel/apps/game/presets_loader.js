/**
 * Load combat/hunt presets into the browser via setPresetCache.
 *
 * Preferred path: PHP `presets_browser_pack` (FS + transitive Stage 11 deps).
 * Fallback: static multi-fetch of mode.json catalog + layout deps (no PHP).
 * Headless Node keeps using fs through kernel/core/lib/presets.js.
 */

'use strict';

const {
    setPresetCache,
    clearPresetCache,
    cacheHas,
    loadClasses,
    loadSpells,
    loadEquipment,
    loadStrategies,
    loadHunt,
    loadParty,
    listPartyIds,
    loadCreatureTemplate,
    expandHuntDefinition
} = require('../../core/lib/presets.js');
const {
    setScenarioCache,
    clearScenarioCache,
    listScenarioCatalog
} = require('../../core/lib/hunt_scenarios.js');
const {
    setActiveMode,
    setModeCache,
    loadMode,
    listModes,
    getActiveModeId,
    getActiveMode,
    getBrowserCatalog,
    modePaths,
    DEFAULT_MODE_ID
} = require('../../core/lib/modes.js');
const { indexStrategies, DEFAULT_STRATEGIES } =
    require('../../core/lib/ai/strategy.js');
const { appUrl } = require('../../core/lib/app_paths.js');
const {
    padFloorId,
    floorsFromSpawnSource,
    resolveHuntSpawnDefs,
    parseSpawnRows
} = require('../../core/lib/content/legacy_assets.js');

/**
 * In-memory spawn rows (browser only). Key: "07".
 * Filled hybrid-first (`map.json` `spawns`, else `by_floor`).
 * @type {Record<string, object[]>}
 */
const legacyFloorSpawnCache = Object.create(null);

/**
 * Last loaded browser catalog (for getCatalogLists without re-fetch).
 * @type {object|null}
 */
let lastBrowserCatalog = null;

/**
 * Job / content API base URL (php/api.php).
 * @returns {string}
 */
function apiUrl() {
    if (typeof window !== 'undefined' && window.__API_URL__) {
        return String(window.__API_URL__);
    }
    return appUrl('php/api.php');
}

/**
 * @param {string} rel under active mode presets/
 * @returns {Promise<any>}
 */
async function fetchPresetJson(rel) {
    const modeId = getActiveModeId();
    const url = appUrl(
        `presets/${modeId}/${rel.replace(/^\//, '')}`
    );
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`Failed to load preset ${rel}: HTTP ${res.status}`);
    }
    return res.json();
}

/**
 * Fetch a mode-relative JSON preset into setPresetCache when missing.
 * Soft-fails (returns null) so optional Stage 11 deps never blank the UI.
 * @param {string} rel e.g. 'dungeons/small_crawl.json'
 * @returns {Promise<object|null>}
 */
async function ensurePresetCached(rel) {
    const key = String(rel || '').replace(/^\//, '');
    if (!key) return null;
    if (cacheHas(key)) return true;
    try {
        const data = await fetchPresetJson(key);
        setPresetCache(key, data);
        return data;
    } catch (err) {
        console.warn(`Optional preset not loaded: ${key}`, err);
        return null;
    }
}

/**
 * @param {string[]} ids
 * @returns {string[]}
 */
function uniqueIds(ids) {
    const map = Object.create(null);
    const list = Array.isArray(ids) ? ids : [];
    for (let i = 0; i < list.length; i++) {
        if (list[i] == null || list[i] === '') continue;
        map[String(list[i])] = true;
    }
    return Object.keys(map);
}

/**
 * Stage 11 layout deps referenced by raw hunt JSON (before expand).
 * Used only by the static-fetch fallback when PHP pack is unavailable.
 * @param {object[]} rawHunts
 * @returns {{
 *   profileIds: string[],
 *   pieceIds: string[],
 *   populationIds: string[],
 *   markerIds: string[],
 *   biomeIds: string[]
 * }}
 */
/**
 * Arena/rest shell + pack + art pointers (matches kernel normalizeArenaLoop defaults).
 * @param {object|null|undefined} loop
 * @param {string[]} profileIds
 * @param {string[]} pieceIds
 * @param {string[]} [artSetIds]
 */
function collectArenaLoopDeps(loop, profileIds, pieceIds, artSetIds) {
    const r = loop && typeof loop === 'object' ? loop : {};
    profileIds.push(
        r.arenaProfileId != null && String(r.arenaProfileId) !== ''
            ? String(r.arenaProfileId)
            : 'arena_combat_shell'
    );
    profileIds.push(
        r.restProfileId != null && String(r.restProfileId) !== ''
            ? String(r.restProfileId)
            : 'rest_area_shell'
    );
    if (r.arenaPackId != null) pieceIds.push(r.arenaPackId);
    if (r.restPackId != null) pieceIds.push(r.restPackId);
    if (r.arenaPiecePack != null) pieceIds.push(r.arenaPiecePack);
    if (r.restPiecePack != null) pieceIds.push(r.restPiecePack);
    if (Array.isArray(artSetIds)) {
        if (r.restArtSet != null) artSetIds.push(r.restArtSet);
        if (Array.isArray(r.artSets)) {
            for (let i = 0; i < r.artSets.length; i++) {
                if (r.artSets[i] != null) artSetIds.push(r.artSets[i]);
            }
        }
    }
}

function collectLayoutDepsFromHunts(rawHunts) {
    const profileIds = [];
    const pieceIds = [];
    const populationIds = [];
    const markerIds = [];
    const biomeIds = [];
    const artSetIds = [];

    const list = Array.isArray(rawHunts) ? rawHunts : [];
    for (let i = 0; i < list.length; i++) {
        const hunt = list[i];
        if (!hunt || typeof hunt !== 'object') continue;
        if (hunt.populationId != null) populationIds.push(hunt.populationId);
        if (hunt.markersId != null) markerIds.push(hunt.markersId);
        if (hunt.biomeId != null) biomeIds.push(hunt.biomeId);
        else if (hunt.biome != null) biomeIds.push(hunt.biome);
        if (hunt.artSet != null) artSetIds.push(hunt.artSet);

        const layout = hunt.layout;
        const layoutType = layout
            ? String(layout.type || layout.kind || '').toLowerCase()
            : '';
        const isArenaRest =
            layoutType === 'arena_rest_chain' ||
            layoutType === 'arena-rest-chain';

        // Hunt-level or nested layout.arenaLoop (shells default when omitted)
        if (hunt.arenaLoop && typeof hunt.arenaLoop === 'object') {
            collectArenaLoopDeps(
                hunt.arenaLoop,
                profileIds,
                pieceIds,
                artSetIds
            );
        } else if (
            layout &&
            layout.arenaLoop &&
            typeof layout.arenaLoop === 'object'
        ) {
            collectArenaLoopDeps(
                layout.arenaLoop,
                profileIds,
                pieceIds,
                artSetIds
            );
        } else if (isArenaRest) {
            collectArenaLoopDeps(null, profileIds, pieceIds, artSetIds);
        }

        if (!layout || typeof layout !== 'object') continue;

        const profileId =
            layout.profileId != null
                ? layout.profileId
                : layout.id != null
                  ? layout.id
                  : hunt.dungeonProfileId;
        if (profileId != null) profileIds.push(profileId);
        if (layout.piecePack != null) pieceIds.push(layout.piecePack);
        if (layout.biomeId != null) biomeIds.push(layout.biomeId);
        else if (layout.biome != null) biomeIds.push(layout.biome);
        if (layout.artSet != null) artSetIds.push(layout.artSet);

        if (layout.profile && typeof layout.profile === 'object') {
            if (layout.profile.piecePack != null) {
                pieceIds.push(layout.profile.piecePack);
            }
            if (layout.profile.populationId != null) {
                populationIds.push(layout.profile.populationId);
            }
            if (layout.profile.markersId != null) {
                markerIds.push(layout.profile.markersId);
            }
            if (layout.profile.biome != null) {
                biomeIds.push(layout.profile.biome);
            } else if (layout.profile.biomeId != null) {
                biomeIds.push(layout.profile.biomeId);
            }
        }
    }

    return {
        profileIds: uniqueIds(profileIds),
        pieceIds: uniqueIds(pieceIds),
        populationIds: uniqueIds(populationIds),
        markerIds: uniqueIds(markerIds),
        biomeIds: uniqueIds(biomeIds),
        artSetIds: uniqueIds(artSetIds)
    };
}

/**
 * Prefetch layout deps over static HTTP (fallback only).
 * @param {object[]} rawHunts
 * @returns {Promise<void>}
 */
async function ensureLayoutDepsForBrowser(rawHunts) {
    const deps = collectLayoutDepsFromHunts(rawHunts);
    const { loadDungeonProfile } = require('../../core/lib/presets.js');

    await Promise.all(
        deps.profileIds.map((id) =>
            ensurePresetCached(`dungeons/${id}.json`)
        )
    );

    const pieceIds = deps.pieceIds.slice();
    const populationIds = deps.populationIds.slice();
    const markerIds = deps.markerIds.slice();
    const biomeIds = deps.biomeIds.slice();

    for (let i = 0; i < deps.profileIds.length; i++) {
        const pid = deps.profileIds[i];
        if (!cacheHas(`dungeons/${pid}.json`)) continue;
        let profile = null;
        try {
            profile = loadDungeonProfile(pid);
        } catch (_) {
            profile = null;
        }
        if (!profile || typeof profile !== 'object') continue;
        if (profile.piecePack != null) pieceIds.push(profile.piecePack);
        if (profile.populationId != null) {
            populationIds.push(profile.populationId);
        }
        if (profile.markersId != null) markerIds.push(profile.markersId);
        if (profile.biome != null) biomeIds.push(profile.biome);
        if (profile.biomeId != null) biomeIds.push(profile.biomeId);
    }

    const artSetIds = Array.isArray(deps.artSetIds) ? deps.artSetIds.slice() : [];

    await Promise.all([
        ...uniqueIds(pieceIds).map((id) =>
            ensurePresetCached(`pieces/${id}.json`)
        ),
        ...uniqueIds(populationIds).map((id) =>
            ensurePresetCached(`populations/${id}.json`)
        ),
        ...uniqueIds(markerIds).map((id) =>
            ensurePresetCached(`markers/${id}.json`)
        ),
        ...uniqueIds(biomeIds).map((id) =>
            ensurePresetCached(`biomes/${id}.json`)
        ),
        ...uniqueIds(artSetIds).map((id) =>
            ensurePresetCached(`art_sets/${id}.json`)
        )
    ]);
}

/**
 * Fetch PHP browser pack (mode catalog + transitive layout deps).
 * @param {string} modeId
 * @returns {Promise<{
 *   packVersion: number,
 *   modeId: string,
 *   mode: object,
 *   files: Record<string, object>,
 *   missing?: string[],
 *   deps?: object
 * }|null>}
 */
async function fetchBrowserPresetPack(modeId) {
    const id = modeId || DEFAULT_MODE_ID;
    let url;
    try {
        url = new URL(apiUrl(), typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    } catch (_) {
        return null;
    }
    url.searchParams.set('action', 'presets_browser_pack');
    url.searchParams.set('mode', id);
    try {
        const res = await fetch(url.toString(), { credentials: 'same-origin' });
        if (!res.ok) return null;
        const body = await res.json();
        if (!body || body.ok === false || !body.mode || !body.files) {
            return null;
        }
        return body;
    } catch (err) {
        console.warn('presets_browser_pack unavailable, using static fallback', err);
        return null;
    }
}

/**
 * Inject pack files into preset + scenario caches.
 * @param {Record<string, object>} files
 */
function injectPackFiles(files) {
    const map = files && typeof files === 'object' ? files : {};
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
        const rel = keys[i];
        const data = map[rel];
        if (!rel || data == null) continue;
        setPresetCache(rel, data);
        const sm = /^scenarios[/\\](.+)\.json$/.exec(rel);
        if (sm) {
            setScenarioCache(sm[1], data);
        }
    }
}

/**
 * @param {string} rel under assets/ (or any project-relative path)
 * @returns {Promise<any>}
 */
async function fetchAssetJson(rel) {
    const url = appUrl(rel.replace(/^\//, ''));
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`Failed to load asset ${rel}: HTTP ${res.status}`);
    }
    return res.json();
}

/**
 * Fetch and activate a content mode (mode.json).
 * @param {string} [modeId]
 * @returns {Promise<object>} normalized mode
 */
async function loadModeForBrowser(modeId) {
    const id = modeId || DEFAULT_MODE_ID;
    const url = appUrl(`presets/${id}/mode.json`);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
        throw new Error(`Failed to load mode ${id}: HTTP ${res.status}`);
    }
    const raw = await res.json();
    setModeCache(id, raw);
    clearPresetCache();
    clearScenarioCache();
    for (const k of Object.keys(legacyFloorSpawnCache)) {
        delete legacyFloorSpawnCache[k];
    }
    const mode = setActiveMode(id);
    lastBrowserCatalog = mode.browser;
    return mode;
}

/**
 * List modes for UI: prefer window.__MODES__, else known defaults + fetch.
 * @returns {Promise<{ id: string, label: string, isDefault: boolean }[]>}
 */
async function listModesForBrowser() {
    if (
        typeof window !== 'undefined' &&
        Array.isArray(window.__MODES__) &&
        window.__MODES__.length
    ) {
        return window.__MODES__.map((m) => ({
            id: m.id,
            label: m.label || m.id,
            isDefault: !!m.isDefault
        }));
    }
    try {
        return listModes();
    } catch (_) {
        /* disk unavailable */
    }
    // Static fallback when PHP did not inject and Node list is empty
    const ids = ['standard', 'legacy'];
    const out = [];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        try {
            const url = appUrl(`presets/${id}/mode.json`);
            const res = await fetch(url, { credentials: 'same-origin' });
            if (!res.ok) continue;
            const raw = await res.json();
            setModeCache(id, raw);
            out.push({
                id: raw.id || id,
                label: raw.label || id,
                isDefault: !!raw.isDefault
            });
        } catch (_) {
            /* skip */
        }
    }
    out.sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.id.localeCompare(b.id);
    });
    return out;
}

/**
 * Fetch spawn rows for one floor: hybrid map.json first, by_floor fallback.
 * Hybrid pack present (even with empty `spawns`) is SoT.
 * @param {string} id padded floor id
 * @returns {Promise<object[]>}
 */
async function fetchFloorSpawnRows(id) {
    const mapsRel = mapsRelRoot();
    try {
        const hybrid = await fetchAssetJson(
            `${mapsRel}/hybrid/floor-${id}/map.json`
        );
        if (hybrid && typeof hybrid === 'object' && !Array.isArray(hybrid)) {
            return Array.isArray(hybrid.spawns) ? hybrid.spawns : [];
        }
    } catch (_) {
        /* pack missing — fall back */
    }
    const mode = getActiveMode();
    if (!mode.features.legacySpawnSource || !mode.assets.spawns) {
        return [];
    }
    const spawnsRel = String(mode.assets.spawns).replace(/\/$/, '');
    try {
        const data = await fetchAssetJson(`${spawnsRel}/by_floor/${id}.json`);
        return parseSpawnRows(data);
    } catch (_) {
        return [];
    }
}

/**
 * Fetch spawn pins for the given floors only (hybrid-first).
 * @param {(string|number)[]} floorIds
 * @returns {Promise<void>}
 */
async function ensureLegacyFloorSpawns(floorIds) {
    const mode = getActiveMode();
    if (!mode.features.legacySpawnSource || !mode.assets.spawns) {
        return;
    }
    const list = Array.isArray(floorIds) ? floorIds : [];
    const pending = [];
    for (let i = 0; i < list.length; i++) {
        const id = padFloorId(list[i]);
        if (legacyFloorSpawnCache[id]) continue;
        pending.push(
            fetchFloorSpawnRows(id)
                .then((rows) => {
                    legacyFloorSpawnCache[id] = rows;
                })
                .catch(() => {
                    legacyFloorSpawnCache[id] = [];
                })
        );
    }
    if (pending.length) await Promise.all(pending);
}

/**
 * @param {string|number} floorId
 * @returns {object[]}
 */
function loadFloorSpawnsCached(floorId) {
    return legacyFloorSpawnCache[padFloorId(floorId)] || [];
}

/**
 * @param {object} hunt
 * @returns {(string|number)[]}
 */
function floorsNeededForHuntSpawns(hunt) {
    if (!hunt || !hunt.spawnSource) return [];
    return floorsFromSpawnSource(hunt.spawnSource, {
        floors: hunt.floors,
        floor: hunt.floor
    });
}

/**
 * @param {string[]} creatureIds
 * @param {Record<string, object>} [creaturesOut]
 * @returns {Promise<void>}
 */
async function ensureCreatureTemplatesForIds(creatureIds, creaturesOut) {
    const ids = Array.isArray(creatureIds) ? creatureIds : [];
    const pending = [];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const rel = `creatures/${id}.json`;
        if (cacheHas(rel)) {
            if (creaturesOut && !creaturesOut[id]) {
                try {
                    creaturesOut[id] = loadCreatureTemplate(id);
                } catch (_) {
                    /* ignore */
                }
            }
            continue;
        }
        pending.push(
            fetchPresetJson(rel)
                .then((data) => {
                    setPresetCache(rel, data);
                    if (creaturesOut) creaturesOut[id] = data;
                })
                .catch(() => {
                    /* missing preset: spawnFromTable will skip */
                })
        );
    }
    if (pending.length) await Promise.all(pending);
}

/**
 * @param {object} rawHunt
 * @param {Record<string, object>} [creaturesOut]
 * @returns {Promise<object>}
 */
async function expandHuntForBrowser(rawHunt, creaturesOut) {
    if (!rawHunt) return rawHunt;
    const savedSource = rawHunt.spawnSource;
    const hasPopulation = !!(rawHunt.populationId || rawHunt.population);

    // Expand waypoints first without spawnSource (legacy floors load async below).
    // When spawnSource will supply population slots, delay population until after.
    const wpOnly = Object.assign({}, rawHunt);
    delete wpOnly.spawnSource;
    if (savedSource && hasPopulation) {
        delete wpOnly.populationId;
        delete wpOnly.population;
        delete wpOnly.spawns;
    }
    let hunt = expandHuntDefinition(wpOnly, { seed: 1 });

    if (savedSource) {
        hunt = Object.assign({}, hunt, {
            spawnSource: savedSource,
            populationId: rawHunt.populationId,
            population: rawHunt.population,
            populationDensity: rawHunt.populationDensity,
            populationSlots: rawHunt.populationSlots,
            _hadAuthoredSpawns: false
        });
        if (hasPopulation) {
            delete hunt.spawns;
            delete hunt.populationMeta;
            delete hunt.populationSkipped;
        }
        const floors = floorsNeededForHuntSpawns(hunt);
        await ensureLegacyFloorSpawns(floors);
        // Full expand: spawnSource → slots, then Stage 11.1 population if present
        hunt = expandHuntDefinition(hunt, {
            seed: 1,
            loadFloorSpawns: loadFloorSpawnsCached
        });
    }

    const ids = [];
    if (Array.isArray(hunt.spawns)) {
        for (let i = 0; i < hunt.spawns.length; i++) {
            const c = hunt.spawns[i] && hunt.spawns[i].creatureId;
            if (c) ids.push(c);
        }
    }
    // Wave hunts have no flat spawn table; still need creature templates in cache.
    if (hunt.waves != null) {
        try {
            const { collectWaveCreatureIds } = require('../../core/lib/wave_manager.js');
            const waveIds = collectWaveCreatureIds(hunt.waves);
            for (let i = 0; i < waveIds.length; i++) ids.push(waveIds[i]);
        } catch (_) {
            /* optional in incomplete trees */
        }
    }
    await ensureCreatureTemplatesForIds(ids, creaturesOut);
    return hunt;
}

/**
 * Activate mode from raw mode.json (pack or static).
 * @param {string} modeId
 * @param {object} rawMode
 * @returns {object} normalized mode
 */
function activateModeFromRaw(modeId, rawMode) {
    const id = modeId || DEFAULT_MODE_ID;
    setModeCache(id, rawMode);
    clearPresetCache();
    clearScenarioCache();
    for (const k of Object.keys(legacyFloorSpawnCache)) {
        delete legacyFloorSpawnCache[k];
    }
    const mode = setActiveMode(id);
    lastBrowserCatalog = mode.browser;
    return mode;
}

/**
 * @param {string[]} huntIds
 * @param {object[]} rawHuntList
 * @param {Record<string, object>} creatures
 * @returns {Promise<Record<string, object>>}
 */
async function expandHuntListForBrowser(huntIds, rawHuntList, creatures) {
    const hunts = Object.create(null);
    for (let i = 0; i < huntIds.length; i++) {
        const id = huntIds[i];
        const data = rawHuntList[i];
        if (!data) {
            console.warn(`Hunt missing from pack/catalog: ${id}`);
            continue;
        }
        try {
            hunts[id] = await expandHuntForBrowser(data, creatures);
        } catch (err) {
            console.error(`Failed to expand hunt "${id}":`, err);
            hunts[id] = Object.assign({}, data, {
                layoutSkipped: 'expand_failed',
                layoutError: {
                    code: 'expand_failed',
                    message:
                        err && err.message ? String(err.message) : String(err)
                }
            });
        }
        // Keep RAW under hunts/*.json. Catalog seed-1 expand is only for the
        // returned preview map (creature prefetch / labels). Session play calls
        // getHuntDef(id, { seed }) → loadHunt → expand from this cache; if we
        // store the seed-1 expanded snapshot here, re-expand with the session
        // seed corrupts multi-biome z1/z2 packs (docs/25 browser:parity).
        setPresetCache(`hunts/${id}.json`, data);
    }
    return hunts;
}

/**
 * Merge genre catalog combat defaults into equipment + creature tables.
 * @param {object} mode
 * @param {object} equipment
 * @param {Record<string, object>} creatures
 * @returns {Promise<object>} equipment (possibly merged)
 */
async function mergeGenreCatalogDefaults(mode, equipment, creatures) {
    const {
        catalogEntryToCombatTemplate
    } = require('../../core/lib/content/creature_bridge.js');
    const { fillEquipmentCombatDefaults } = require(
        '../../core/lib/content/equipment_bridge.js'
    );

    const genre = mode.genre || 'rpg_fantasy';
    const dataRel = String(mode.assets.data || 'assets/data').replace(
        /\/$/,
        ''
    );
    const catalog = mode.browser || {};
    const catalogCreatureIds = Array.isArray(catalog.catalogCreatures)
        ? catalog.catalogCreatures.slice()
        : [];

    const [catalogCreatures, catalogEquipment] = await Promise.all([
        fetchAssetJson(`${dataRel}/${genre}/creatures.json`).catch(() => null),
        fetchAssetJson(`${dataRel}/${genre}/equipment.json`).catch(() => null)
    ]);

    if (catalogCreatures && Array.isArray(catalogCreatures.creatures)) {
        const byId = Object.create(null);
        for (let i = 0; i < catalogCreatures.creatures.length; i++) {
            const e = catalogCreatures.creatures[i];
            if (e && e.id) byId[e.id] = e;
        }
        for (let i = 0; i < catalogCreatureIds.length; i++) {
            const id = catalogCreatureIds[i];
            if (creatures[id] || !byId[id]) continue;
            const tpl = catalogEntryToCombatTemplate(byId[id]);
            creatures[id] = tpl;
            setPresetCache(`creatures/${id}.json`, tpl);
        }
    }

    let eq = equipment;
    if (catalogEquipment && Array.isArray(catalogEquipment.items)) {
        const seen = Object.create(null);
        const merged = [];
        const presetItems = Array.isArray(eq.items) ? eq.items : [];
        for (let i = 0; i < presetItems.length; i++) {
            const it = presetItems[i];
            if (!it || !it.id) continue;
            seen[it.id] = true;
            merged.push(it);
        }
        for (let i = 0; i < catalogEquipment.items.length; i++) {
            const row = catalogEquipment.items[i];
            if (!row || !row.id || seen[row.id]) continue;
            seen[row.id] = true;
            merged.push(fillEquipmentCombatDefaults(row));
        }
        eq = Object.assign({}, eq, { items: merged });
        setPresetCache('equipment.json', eq);
    }
    return eq;
}

/**
 * Build creature map from catalog creature ids already in cache.
 * @param {string[]} creatureIds
 * @returns {Record<string, object>}
 */
function creaturesFromCache(creatureIds) {
    const creatures = Object.create(null);
    const ids = Array.isArray(creatureIds) ? creatureIds : [];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        try {
            creatures[id] = loadCreatureTemplate(id);
        } catch (_) {
            /* missing template */
        }
    }
    return creatures;
}

/**
 * Fetch Stage 7+ presets for the active (or given) mode.
 * Prefers PHP browser pack; falls back to static multi-fetch.
 * @param {string} [modeId]
 * @returns {Promise<object>}
 */
async function loadBrowserPresets(modeId) {
    const {
        fillCreatureCombatDefaults
    } = require('../../core/lib/content/creature_bridge.js');

    const wantedId =
        modeId ||
        (typeof window !== 'undefined' && window.__CONTENT_MODE__) ||
        DEFAULT_MODE_ID;

    const pack = await fetchBrowserPresetPack(wantedId);
    if (pack && pack.mode && pack.files) {
        if (Array.isArray(pack.missing) && pack.missing.length) {
            console.warn(
                'presets_browser_pack missing files:',
                pack.missing.join(', ')
            );
        }
        const mode = activateModeFromRaw(wantedId, pack.mode);
        injectPackFiles(pack.files);

        const catalog = mode.browser;
        // mode.json often omits browser.parties / playerProfiles; PHP pack always
        // ships full folders and lists them on deps. Merge so Hunt/Scenario UI
        // dropdowns are not stuck on starter_duo-only fallback.
        const deps = pack.deps && typeof pack.deps === 'object' ? pack.deps : {};
        const packParties = Array.isArray(deps.parties) ? deps.parties.slice() : [];
        const packProfiles = Array.isArray(deps.player_profiles)
            ? deps.player_profiles.slice()
            : [];
        lastBrowserCatalog = Object.assign({}, catalog, {
            parties:
                Array.isArray(catalog.parties) && catalog.parties.length
                    ? catalog.parties.slice()
                    : packParties.length
                      ? packParties
                      : listPartyIds(),
            playerProfiles:
                Array.isArray(catalog.playerProfiles) &&
                catalog.playerProfiles.length
                    ? catalog.playerProfiles.slice()
                    : packProfiles.length
                      ? packProfiles
                      : []
        });
        const huntIds = catalog.hunts.slice();
        const creatureIds = catalog.creatures.slice();
        const scenarioIds = catalog.scenarios.slice();

        let equipment = loadEquipment();
        const creatures = creaturesFromCache(creatureIds);
        equipment = await mergeGenreCatalogDefaults(mode, equipment, creatures);

        // Raw hunts from pack files (not expanded yet).
        const rawHuntList = huntIds.map((id) => {
            const rel = `hunts/${id}.json`;
            return pack.files[rel] || null;
        });
        // Ensure raw is what expand sees (overwrite if something else was cached).
        for (let i = 0; i < huntIds.length; i++) {
            if (rawHuntList[i]) {
                setPresetCache(`hunts/${huntIds[i]}.json`, rawHuntList[i]);
            }
        }

        const hunts = await expandHuntListForBrowser(
            huntIds,
            rawHuntList,
            creatures
        );

        const scenarios = Object.create(null);
        for (let i = 0; i < scenarioIds.length; i++) {
            const id = scenarioIds[i];
            const rel = `scenarios/${id}.json`;
            if (pack.files[rel]) {
                scenarios[id] = pack.files[rel];
                setScenarioCache(id, scenarios[id]);
            }
        }

        return {
            mode,
            classes: loadClasses(),
            spells: loadSpells(),
            equipment,
            strategies: loadStrategies(),
            hunts,
            creatures,
            scenarios,
            fillCreatureCombatDefaults,
            packSource: 'php'
        };
    }

    // --- Static fallback (no PHP / pack failed) ---
    const mode = await loadModeForBrowser(wantedId);
    const catalog = mode.browser;
    lastBrowserCatalog = catalog;

    const huntIds = catalog.hunts.slice();
    const populationIds = Array.isArray(catalog.populations)
        ? catalog.populations.slice()
        : [];
    const creatureIds = catalog.creatures.slice();
    const waypointIds = catalog.waypoints.slice();
    const scenarioIds = catalog.scenarios.slice();
    // Static fallback: discover party/profile ids from mode catalog when present;
    // otherwise try known defaults (pack path is preferred).
    const partyIds = Array.isArray(catalog.parties) && catalog.parties.length
        ? catalog.parties.slice()
        : [
              'starter_duo',
              'balance_quartet',
              'test_cave_duo',
              'test_solo_guardian',
              'test_balance_quartet',
              'test_wipe_solo',
              'test_leash_walker'
          ];
    const profileIds =
        Array.isArray(catalog.playerProfiles) && catalog.playerProfiles.length
            ? catalog.playerProfiles.slice()
            : [
                  'guardian_starter',
                  'scout_starter',
                  'adept_starter',
                  'warden_starter',
                  'test_guardian_bar',
                  'test_scout_bar',
                  'test_adept_bar',
                  'test_warden_bar',
                  'test_weak_adventurer',
                  'test_pacifist_guardian'
              ];

    const softFetch = (rel) =>
        fetchPresetJson(rel).catch(() => null);

    const [classes, spells, equipmentRaw, strategies, ...rest] =
        await Promise.all([
            fetchPresetJson('classes.json'),
            fetchPresetJson('spells.json'),
            fetchPresetJson('equipment.json'),
            fetchPresetJson('strategies.json'),
            ...creatureIds.map((id) => fetchPresetJson(`creatures/${id}.json`)),
            ...waypointIds.map((id) => fetchPresetJson(`waypoints/${id}.json`)),
            ...populationIds.map((id) =>
                fetchPresetJson(`populations/${id}.json`)
            ),
            ...huntIds.map((id) => fetchPresetJson(`hunts/${id}.json`)),
            ...scenarioIds.map((id) => fetchPresetJson(`scenarios/${id}.json`)),
            ...partyIds.map((id) => softFetch(`parties/${id}.json`)),
            ...profileIds.map((id) =>
                softFetch(`player_profiles/${id}.json`)
            )
        ]);

    setPresetCache('classes.json', classes);
    setPresetCache('spells.json', spells);
    setPresetCache('equipment.json', equipmentRaw);
    setPresetCache('strategies.json', strategies);

    const creatures = Object.create(null);
    let offset = 0;
    for (let i = 0; i < creatureIds.length; i++) {
        const id = creatureIds[i];
        const data = rest[offset + i];
        creatures[id] = data;
        setPresetCache(`creatures/${id}.json`, data);
    }
    offset += creatureIds.length;

    for (let i = 0; i < waypointIds.length; i++) {
        const id = waypointIds[i];
        setPresetCache(`waypoints/${id}.json`, rest[offset + i]);
    }
    offset += waypointIds.length;

    for (let i = 0; i < populationIds.length; i++) {
        const id = populationIds[i];
        setPresetCache(`populations/${id}.json`, rest[offset + i]);
    }
    offset += populationIds.length;

    const rawHuntList = [];
    for (let i = 0; i < huntIds.length; i++) {
        const id = huntIds[i];
        const data = rest[offset + i];
        setPresetCache(`hunts/${id}.json`, data);
        rawHuntList.push(data);
    }
    offset += huntIds.length;

    await ensureLayoutDepsForBrowser(rawHuntList);

    let equipment = await mergeGenreCatalogDefaults(
        mode,
        equipmentRaw,
        creatures
    );
    const hunts = await expandHuntListForBrowser(
        huntIds,
        rawHuntList,
        creatures
    );

    const scenarios = Object.create(null);
    for (let i = 0; i < scenarioIds.length; i++) {
        const id = scenarioIds[i];
        const data = rest[offset + i];
        scenarios[id] = data;
        setScenarioCache(id, data);
    }
    offset += scenarioIds.length;

    /** @type {string[]} */
    const loadedPartyIds = [];
    for (let i = 0; i < partyIds.length; i++) {
        const id = partyIds[i];
        const data = rest[offset + i];
        if (data) {
            setPresetCache(`parties/${id}.json`, data);
            loadedPartyIds.push(id);
        }
    }
    offset += partyIds.length;

    /** @type {string[]} */
    const loadedProfileIds = [];
    for (let i = 0; i < profileIds.length; i++) {
        const id = profileIds[i];
        const data = rest[offset + i];
        if (data) {
            setPresetCache(`player_profiles/${id}.json`, data);
            loadedProfileIds.push(id);
        }
    }

    // Same catalog merge as PHP pack path (UI party dropdown).
    lastBrowserCatalog = Object.assign({}, catalog, {
        parties: loadedPartyIds.length ? loadedPartyIds : listPartyIds(),
        playerProfiles: loadedProfileIds.length
            ? loadedProfileIds
            : Array.isArray(catalog.playerProfiles)
              ? catalog.playerProfiles.slice()
              : []
    });

    return {
        mode,
        classes,
        spells,
        equipment,
        strategies,
        hunts,
        creatures,
        scenarios,
        fillCreatureCombatDefaults,
        packSource: 'static'
    };
}

/**
 * @returns {{
 *   classLoader: (id: string) => object|null,
 *   creatureLoader: (id: string) => object|null,
 *   itemDb: object[],
 *   spellBook: object[],
 *   strategyTable: Record<string, object>
 * }}
 */
function buildPresetInjectors() {
    const classesData = loadClasses();
    const classList = classesData.classes || classesData;
    const classById = Object.create(null);
    if (Array.isArray(classList)) {
        for (let i = 0; i < classList.length; i++) {
            if (classList[i] && classList[i].id) {
                classById[classList[i].id] = classList[i];
            }
        }
    }

    const eq = loadEquipment();
    const itemDb = eq.items || eq;

    const spellsData = loadSpells();
    const spellBook = spellsData.spells || spellsData;

    let strategiesData;
    try {
        strategiesData = loadStrategies();
    } catch (_) {
        strategiesData = { strategies: [] };
    }
    const strategyTable =
        strategiesData &&
        strategiesData.strategies &&
        strategiesData.strategies.length
            ? indexStrategies(strategiesData)
            : indexStrategies(DEFAULT_STRATEGIES);

    return {
        classLoader: (id) => classById[id] || null,
        creatureLoader: (id) => {
            try {
                return loadCreatureTemplate(id);
            } catch (_) {
                return null;
            }
        },
        itemDb,
        spellBook,
        strategyTable
    };
}

/**
 * Load + expand a hunt for the active mode.
 * Pass `opts.seed` so layout / population match the session seed (headless parity).
 * Without seed, expand defaults to 1 (stable catalog previews only).
 *
 * Requires `hunts/<id>.json` in the preset cache to be the **raw** authored
 * definition (see expandHuntListForBrowser) — never a prior expand snapshot.
 *
 * @param {string} huntId
 * @param {{ seed?: number, populationDensity?: number, loadFloorSpawns?: Function }} [opts]
 * @returns {object}
 */
function getHuntDef(huntId, opts) {
    const mode = getActiveMode();
    const fallback =
        (mode.defaults && mode.defaults.huntId) || 'cave_crawl_generated';
    const o = Object.assign({}, opts || {});
    // Browser legacy spawnSource floors are prefetched into legacyFloorSpawnCache.
    if (typeof o.loadFloorSpawns !== 'function') {
        o.loadFloorSpawns = loadFloorSpawnsCached;
    }
    return loadHunt(huntId || fallback, o);
}

/**
 * Catalog lists for party editor dropdowns.
 * @returns {{
 *   classes: { id: string, label: string }[],
 *   strategies: { id: string, label: string }[],
 *   items: object[],
 *   itemsBySlot: Record<string, object[]>,
 *   hunts: { id: string, label: string }[],
 *   parties: { id: string, label: string }[],
 *   modeId: string
 * }}
 */
function getCatalogLists() {
    const classesData = loadClasses();
    const classList = (classesData.classes || classesData || []).map((c) => ({
        id: c.id,
        label: c.label || c.id
    }));

    let strategiesData;
    try {
        strategiesData = loadStrategies();
    } catch (_) {
        strategiesData = { strategies: DEFAULT_STRATEGIES };
    }
    const stratList = (strategiesData.strategies || DEFAULT_STRATEGIES || []).map(
        (s) => ({
            id: s.id,
            label: s.label || s.id
        })
    );

    const eq = loadEquipment();
    const items = Array.isArray(eq.items) ? eq.items : [];
    /** @type {Record<string, object[]>} */
    const itemsBySlot = Object.create(null);
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || !it.slot) continue;
        if (!itemsBySlot[it.slot]) itemsBySlot[it.slot] = [];
        itemsBySlot[it.slot].push(it);
    }

    const catalog = lastBrowserCatalog || getBrowserCatalog();
    const huntIds = catalog.hunts || [];
    const hunts = huntIds.map((id) => {
        let label = id;
        try {
            const h = loadHunt(id);
            if (h && h.label) label = h.label;
        } catch (_) {
            /* keep id */
        }
        return { id, label };
    });

    /** @type {string[]} */
    let partyIdList = [];
    if (Array.isArray(catalog.parties) && catalog.parties.length) {
        partyIdList = catalog.parties.slice();
    } else {
        try {
            partyIdList = listPartyIds();
        } catch (_) {
            partyIdList = [];
        }
    }
    // Prefer product parties first in the UI (test_* last)
    partyIdList = partyIdList.slice().sort((a, b) => {
        const at = a.startsWith('test_') ? 1 : 0;
        const bt = b.startsWith('test_') ? 1 : 0;
        if (at !== bt) return at - bt;
        return a.localeCompare(b);
    });
    const parties = partyIdList.map((id) => {
        let label = id;
        try {
            const p = loadParty(id);
            if (p && p.label) label = p.label;
        } catch (_) {
            /* keep id */
        }
        return { id, label };
    });

    return {
        classes: classList,
        strategies: stratList,
        items,
        itemsBySlot,
        hunts,
        parties,
        modeId: getActiveModeId()
    };
}

/**
 * Scenario catalog for Scenario Lab.
 * @returns {object[]}
 */
function getScenarioLists() {
    const catalog = lastBrowserCatalog || getBrowserCatalog();
    const ids = (catalog.scenarios || []).slice();
    return listScenarioCatalog(ids).map((m) => ({
        id: m.id,
        label: m.label,
        notes: m.notes,
        baseHuntId: m.baseHuntId,
        seed: m.seed,
        settings: m.settings,
        optionKeys: m.optionKeys
    }));
}

/**
 * Browser map URL for a floor using the active mode asset root.
 * @param {string|number} floorId
 * @returns {string}
 */
function mapUrlForFloor(floorId) {
    const raw = String(floorId);
    const id = /^\d+$/.test(raw) ? raw.padStart(2, '0') : raw;
    let mapsRel = 'assets/legacy/map';
    try {
        mapsRel = modePaths().mapsRel || mapsRel;
    } catch (_) {
        /* keep default */
    }
    mapsRel = String(mapsRel).replace(/\/$/, '');
    return appUrl(`${mapsRel}/floor-${id}-path.png`);
}

/**
 * Relative maps root for hybrid / path assets (active mode).
 * @returns {string}
 */
function mapsRelRoot() {
    let mapsRel = 'assets/legacy/map';
    try {
        mapsRel = modePaths().mapsRel || mapsRel;
    } catch (_) {
        /* keep default */
    }
    return String(mapsRel).replace(/\/$/, '');
}

/**
 * Fetch one hybrid pack for a floor via API + asset blobs (browser).
 * Returns null when no pack is present.
 *
 * @param {string|number} floorId
 * @returns {Promise<object|null>} normalized hybrid pack
 */
async function fetchHybridPackForFloor(floorId) {
    const pad = padFloorId(floorId);
    const res = await fetch(
        `${apiUrl()}?action=legacy_map_load_hybrid&floor=${encodeURIComponent(pad)}`
    );
    if (!res.ok) return null;
    const body = await res.json();
    const data = body.data || body;
    if (!data || !data.present || !data.meta) return null;

    /** @type {Record<string, Uint8Array>} */
    const blobs = Object.create(null);
    const paths = Array.isArray(data.blobPaths)
        ? data.blobPaths
        : Object.keys(data.blobsBase64 || {});
    if (data.dir && paths.length) {
        const root = appUrl(String(data.dir).replace(/\/$/, ''));
        await Promise.all(
            paths.map(async (rel) => {
                const url = `${root}/${rel}`;
                const br = await fetch(url, { cache: 'no-store' });
                if (!br.ok) {
                    throw new Error(
                        `hybrid blob ${rel} HTTP ${br.status}`
                    );
                }
                blobs[rel] = new Uint8Array(await br.arrayBuffer());
            })
        );
    } else if (data.blobsBase64 && typeof data.blobsBase64 === 'object') {
        const keys = Object.keys(data.blobsBase64);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const b64 = data.blobsBase64[k];
            if (typeof b64 !== 'string') continue;
            // atob → binary string → Uint8Array
            const bin = atob(b64);
            const u8 = new Uint8Array(bin.length);
            for (let j = 0; j < bin.length; j++) u8[j] = bin.charCodeAt(j);
            blobs[k] = u8;
        }
    }

    const {
        deserializeHybridPack
    } = require('../../core/lib/dungeon/tilemap_bake.js');
    return deserializeHybridPack(data.meta, blobs);
}

/**
 * Load and merge hybrid packs for hunt floors (browser).
 * @param {Array<string|number>|null|undefined} floorIds
 * @returns {Promise<object|null>}
 */
async function fetchHybridPackForFloors(floorIds) {
    const list = Array.isArray(floorIds) ? floorIds : [];
    if (!list.length) return null;
    /** @type {object[]} */
    const floors = [];
    /** @type {object[]} */
    const spawns = [];
    for (let i = 0; i < list.length; i++) {
        try {
            const pack = await fetchHybridPackForFloor(list[i]);
            if (!pack || !pack.floors) continue;
            const keys = Object.keys(pack.floors);
            for (let k = 0; k < keys.length; k++) {
                floors.push(pack.floors[keys[k]]);
            }
            if (Array.isArray(pack.spawns)) {
                for (let s = 0; s < pack.spawns.length; s++) {
                    spawns.push(pack.spawns[s]);
                }
            }
        } catch (err) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn(
                    'fetchHybridPackForFloors: floor',
                    list[i],
                    err && err.message ? err.message : err
                );
            }
        }
    }
    if (!floors.length) return null;
    const {
        normalizeHybridPack
    } = require('../../core/lib/dungeon/tilemap_bake.js');
    return normalizeHybridPack({
        id: 'browser_hybrid',
        label: 'Browser hybrid packs',
        floors,
        spawns: spawns.length ? spawns : null
    });
}

/**
 * Snapshot of browser hunt ids for the active mode (compat for tests).
 * @returns {string[]}
 */
function getBrowserHuntIds() {
    try {
        return (lastBrowserCatalog || getBrowserCatalog()).hunts.slice();
    } catch (_) {
        return [];
    }
}

module.exports = {
    appUrl,
    apiUrl,
    fetchPresetJson,
    fetchAssetJson,
    fetchBrowserPresetPack,
    injectPackFiles,
    ensurePresetCached,
    collectLayoutDepsFromHunts,
    ensureLayoutDepsForBrowser,
    loadModeForBrowser,
    listModesForBrowser,
    ensureLegacyFloorSpawns,
    ensureCreatureTemplatesForIds,
    expandHuntForBrowser,
    loadBrowserPresets,
    buildPresetInjectors,
    getHuntDef,
    getCatalogLists,
    getScenarioLists,
    mapUrlForFloor,
    mapsRelRoot,
    fetchHybridPackForFloor,
    fetchHybridPackForFloors,
    getBrowserHuntIds,
    getActiveModeId,
    DEFAULT_MODE_ID,
    // Compat aliases used by older tests / apps — prefer getBrowser*
    get BROWSER_HUNT_IDS() {
        return getBrowserHuntIds();
    },
    get BROWSER_SCENARIO_IDS() {
        try {
            return (lastBrowserCatalog || getBrowserCatalog()).scenarios.slice();
        } catch (_) {
            return [];
        }
    },
    get BROWSER_CREATURE_IDS() {
        try {
            return (lastBrowserCatalog || getBrowserCatalog()).creatures.slice();
        } catch (_) {
            return [];
        }
    },
    get BROWSER_WAYPOINT_IDS() {
        try {
            return (lastBrowserCatalog || getBrowserCatalog()).waypoints.slice();
        } catch (_) {
            return [];
        }
    },
    get BROWSER_CATALOG_CREATURE_IDS() {
        try {
            return (lastBrowserCatalog || getBrowserCatalog()).catalogCreatures.slice();
        } catch (_) {
            return [];
        }
    }
};
