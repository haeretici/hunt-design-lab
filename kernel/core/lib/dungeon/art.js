/**
 * Stage 11.9 — Art tile binding.
 * Stage 11.11 — Art volume helpers (historically large packs; slim policy now).
 * TileMap plan Phase 3 — role-aware entries (roleId / scale / anchor / kind),
 * slim packs (1–4 tiles per role), bindArtFromRoles terrain-only.
 *
 * Map an artSet id (biome / hunt pointer) onto friction cells using a
 * mode-local art set pack that lists genre catalog ids by role
 * (floor / wall / path / stairs / void|water). Output is a compact palette +
 * Uint16 index layer parallel to floorFriction / floorLayers — headless stays
 * pure; watch mode draws catalog PNGs when ImageDB is ready.
 *
 * Logic pieces stay collision-only; decorative binding is a separate layer.
 * Scenery / furniture role lists are for editor palette only — procedural
 * bind never auto-stamps object stacks.
 */

'use strict';

const { createSeededRandom } = require('../utils.js');
const { FRICTION_BLOCKED } = require('../../entities/tilemap.js');
const { normalizeArtSet } = require('./biome.js');
const {
    defaultCatalogKindForRole,
    normalizeCatalogKind
} = require('./art_set_context.js');

/** Salt so art RNG is independent of layout / population streams. */
const ART_SEED_SALT = 0x41525454; // "ARTT"

/** Default walkable gray used when comparing friction (informational). */
const DEFAULT_WALK_FRICTION = 100;

/**
 * Minimum distinct catalog ids per art set (not empty).
 * Slim policy: 1 is enough when roles resolve; large min volume was retired.
 */
const MIN_ART_SET_VOLUME = 1;

/**
 * Preferred max unique ids for a whole slim pack (soft / meetsTarget).
 * Historical TARGET aimed high (40+); now we prefer quiet packs.
 */
const TARGET_ART_SET_VOLUME = 16;

/** Soft upper note for designers (not a hard fail). */
const MAX_ART_SET_VOLUME_NOTE = 24;

/**
 * Hard CI preference: max weighted entries per role list.
 * Prefer 1–2; 4 is the soft ceiling.
 */
const MAX_ART_SET_PER_ROLE = 4;

/**
 * Role keys used by procedural friction bind (terrain only).
 * Editor-only keys (scenery, furniture, …) are stored but never stamped here.
 */
const TERRAIN_BIND_ROLES = ['floor', 'wall', 'path', 'stairs', 'void'];

/**
 * Extra role keys accepted on pack files (palette / bake later).
 * water → void for bind; stairs_up / stairs_down → stairs for bind.
 */
const EXTRA_ROLE_KEYS = [
    'water',
    'stairs_up',
    'stairs_down',
    'scenery',
    'furniture',
    'protection',
    'hole',
    'grate',
    'rope_spot',
    'shovel_spot'
];

/** Default roleId when pack role key matches a tile role id. */
const DEFAULT_ROLE_ID_BY_KEY = {
    floor: 'floor',
    path: 'path',
    wall: 'wall',
    stairs: 'stairs_up',
    stairs_up: 'stairs_up',
    stairs_down: 'stairs_down',
    void: 'void',
    water: 'water',
    scenery: 'scenery_blocking',
    furniture: 'furniture_blocking',
    protection: 'protection',
    hole: 'hole',
    grate: 'grate',
    rope_spot: 'rope_spot',
    shovel_spot: 'shovel_spot'
};

/**
 * @param {number} seed
 * @returns {number}
 */
function artSeed(seed) {
    return ((seed >>> 0) ^ ART_SEED_SALT) >>> 0 || 1;
}

/**
 * @param {() => number} rng
 * @param {Array<{ id: string, weight: number }>} items
 * @returns {string|null}
 */
function pickWeightedId(rng, items) {
    if (!items || !items.length) return null;
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        const w = Number(items[i].weight) || 0;
        if (w > 0) total += w;
    }
    if (total <= 0) {
        const it = items[Math.floor(rng() * items.length)];
        return it && it.id ? it.id : null;
    }
    let r = rng() * total;
    for (let i = 0; i < items.length; i++) {
        const w = Number(items[i].weight) || 0;
        if (w <= 0) continue;
        r -= w;
        if (r < 0) return items[i].id || null;
    }
    const last = items[items.length - 1];
    return last && last.id ? last.id : null;
}

/**
 * Normalize one role entry: string id or { id, weight, roleId?, kind?, scale?, anchor? }.
 * @param {*} raw
 * @param {string} [roleKey] pack roles key (floor, wall, …) for default roleId
 * @param {string} [defaultKind] pack-level kind default
 * @returns {{
 *   id: string,
 *   weight: number,
 *   roleId: string|null,
 *   kind: string,
 *   scale: number|null,
 *   anchor: string|null
 * }|null}
 */
function normalizeRoleEntry(raw, roleKey, defaultKind) {
    if (raw == null) return null;
    const defRole =
        roleKey && DEFAULT_ROLE_ID_BY_KEY[roleKey]
            ? DEFAULT_ROLE_ID_BY_KEY[roleKey]
            : null;
    const packKind =
        defaultKind != null && String(defaultKind).trim()
            ? String(defaultKind).trim()
            : 'tiles';
    const roleKind = defaultCatalogKindForRole(roleKey, defRole) || packKind;

    if (typeof raw === 'string') {
        const id = String(raw).trim();
        if (!id) return null;
        return {
            id,
            weight: 1,
            roleId: defRole,
            kind: roleKind,
            scale: null,
            anchor: null
        };
    }
    if (typeof raw !== 'object') return null;
    const id =
        raw.id != null
            ? String(raw.id).trim()
            : raw.tileId != null
              ? String(raw.tileId).trim()
              : raw.tile != null
                ? String(raw.tile).trim()
                : raw.catalogId != null
                  ? String(raw.catalogId).trim()
                  : '';
    if (!id) return null;
    let weight = Number(raw.weight);
    if (!Number.isFinite(weight) || weight < 0) weight = 1;

    let roleId = null;
    if (raw.roleId != null && String(raw.roleId).trim()) {
        roleId = String(raw.roleId)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
        if (!roleId) roleId = null;
    } else {
        roleId = defRole;
    }

    let kind = defaultCatalogKindForRole(roleKey, roleId) || packKind;
    if (raw.kind != null && String(raw.kind).trim()) {
        const k = normalizeCatalogKind(raw.kind);
        kind = k || String(raw.kind).trim().toLowerCase();
    }

    let scale = null;
    if (raw.scale != null && Number.isFinite(Number(raw.scale))) {
        scale = Number(raw.scale);
        if (scale < 0.05) scale = 0.05;
        if (scale > 8) scale = 8;
    }

    let anchor = null;
    if (raw.anchor != null && String(raw.anchor).trim()) {
        anchor = String(raw.anchor).trim();
    }

    return { id, weight, roleId, kind, scale, anchor };
}

/**
 * @param {*} raw array of role entries
 * @param {string} [roleKey]
 * @param {string} [defaultKind]
 * @returns {Array<object>}
 */
function normalizeRoleList(raw, roleKey, defaultKind) {
    if (!Array.isArray(raw)) return [];
    /** @type {Array<object>} */
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const e = normalizeRoleEntry(raw[i], roleKey, defaultKind);
        if (e) out.push(e);
    }
    return out;
}

/**
 * Merge role lists, de-dupe by catalog id (first wins).
 * @param {...Array<object>} lists
 * @returns {Array<object>}
 */
function mergeRoleLists() {
    const seen = Object.create(null);
    /** @type {Array<object>} */
    const out = [];
    for (let a = 0; a < arguments.length; a++) {
        const list = arguments[a];
        if (!list || !list.length) continue;
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            if (!e || !e.id || seen[e.id]) continue;
            seen[e.id] = true;
            out.push(e);
        }
    }
    return out;
}

/**
 * Normalize art set pack (file or inline).
 * Accepts legacy keys (stairs, void) and slim keys (stairs_up, water, scenery).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeArtSetPack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeArtSet(raw.id != null ? raw.id : raw.artSet);
    if (!id) return null;

    const packKind = raw.kind != null ? String(raw.kind) : 'tiles';
    const rolesRaw =
        raw.roles && typeof raw.roles === 'object' ? raw.roles : raw;

    const floor = normalizeRoleList(
        rolesRaw.floor || rolesRaw.floors || raw.floor,
        'floor',
        packKind
    );
    const wall = normalizeRoleList(
        rolesRaw.wall || rolesRaw.walls || raw.wall,
        'wall',
        packKind
    );
    const path = normalizeRoleList(
        rolesRaw.path || rolesRaw.paths || raw.path,
        'path',
        packKind
    );
    const stairsLegacy = normalizeRoleList(
        rolesRaw.stairs ||
            rolesRaw.stair ||
            rolesRaw.special ||
            raw.stairs ||
            raw.special,
        'stairs',
        packKind
    );
    const stairsUp = normalizeRoleList(
        rolesRaw.stairs_up || raw.stairs_up,
        'stairs_up',
        packKind
    );
    const stairsDown = normalizeRoleList(
        rolesRaw.stairs_down || raw.stairs_down,
        'stairs_down',
        packKind
    );
    const voidLegacy = normalizeRoleList(
        rolesRaw.void || rolesRaw.voids || raw.void,
        'void',
        packKind
    );
    const water = normalizeRoleList(
        rolesRaw.water || raw.water,
        'water',
        packKind
    );
    const scenery = normalizeRoleList(
        rolesRaw.scenery || raw.scenery,
        'scenery',
        packKind
    );
    const furniture = normalizeRoleList(
        rolesRaw.furniture || raw.furniture,
        'furniture',
        packKind
    );

    // Procedural terrain lists (bind never uses scenery/furniture).
    const stairs = mergeRoleLists(stairsLegacy, stairsUp, stairsDown);
    const voidRole = mergeRoleLists(voidLegacy, water);

    if (!floor.length && !wall.length && !path.length && !stairs.length) {
        return null;
    }

    // Preserve any other role keys for editor palette (unknown → pass through).
    /** @type {Record<string, Array<object>>} */
    const roles = {
        floor,
        wall,
        path,
        stairs,
        void: voidRole
    };
    if (water.length) roles.water = water;
    if (stairsUp.length) roles.stairs_up = stairsUp;
    if (stairsDown.length) roles.stairs_down = stairsDown;
    if (scenery.length) roles.scenery = scenery;
    if (furniture.length) roles.furniture = furniture;

    for (let i = 0; i < EXTRA_ROLE_KEYS.length; i++) {
        const key = EXTRA_ROLE_KEYS[i];
        if (roles[key]) continue;
        if (!rolesRaw[key]) continue;
        const list = normalizeRoleList(rolesRaw[key], key, packKind);
        if (list.length) roles[key] = list;
    }

    const rulesRaw =
        raw.rules && typeof raw.rules === 'object' ? raw.rules : {};
    const blockedEdgeOnly =
        rulesRaw.blockedEdgeOnly !== undefined
            ? !!rulesRaw.blockedEdgeOnly
            : raw.blockedEdgeOnly !== undefined
              ? !!raw.blockedEdgeOnly
              : true;
    // When path list is non-empty, mix path tiles into walkable at this ratio
    let pathMix = Number(
        rulesRaw.pathMix != null
            ? rulesRaw.pathMix
            : raw.pathMix != null
              ? raw.pathMix
              : path.length
                ? 0.15
                : 0
    );
    if (!Number.isFinite(pathMix) || pathMix < 0) pathMix = 0;
    if (pathMix > 1) pathMix = 1;

    return {
        id,
        label: raw.label != null ? String(raw.label) : id,
        notes: raw.notes != null ? String(raw.notes) : null,
        genre: raw.genre != null ? String(raw.genre) : null,
        kind: packKind,
        roles,
        rules: {
            blockedEdgeOnly,
            pathMix,
            walkDefault:
                Number.isFinite(Number(rulesRaw.walkDefault))
                    ? Number(rulesRaw.walkDefault) | 0
                    : DEFAULT_WALK_FRICTION
        }
    };
}

/**
 * Collect unique catalog ids referenced by a pack (all role lists).
 * @param {object|null} pack normalizeArtSetPack result
 * @param {{ terrainOnly?: boolean }} [opts]
 * @returns {string[]}
 */
function listArtSetTileIds(pack, opts) {
    if (!pack || !pack.roles) return [];
    const terrainOnly = !!(opts && opts.terrainOnly);
    const seen = Object.create(null);
    /** @type {string[]} */
    const out = [];
    const keys = Object.keys(pack.roles);
    for (let r = 0; r < keys.length; r++) {
        const roleKey = keys[r];
        if (terrainOnly && TERRAIN_BIND_ROLES.indexOf(roleKey) < 0) continue;
        const list = pack.roles[roleKey] || [];
        for (let i = 0; i < list.length; i++) {
            const id = list[i] && list[i].id;
            if (!id || seen[id]) continue;
            seen[id] = true;
            out.push(id);
        }
    }
    return out;
}

/**
 * Count unique catalog ids referenced by a pack (art volume).
 * @param {object|null} pack normalizeArtSetPack result
 * @returns {number}
 */
function artSetVolume(pack) {
    return listArtSetTileIds(pack).length;
}

/**
 * Per-role entry counts (weights ignored; list length only).
 * Includes terrain bind keys always; extra keys when present.
 * @param {object|null} pack
 * @returns {Record<string, number>}
 */
function artSetRoleCounts(pack) {
    /** @type {Record<string, number>} */
    const counts = {
        floor: 0,
        wall: 0,
        path: 0,
        stairs: 0,
        void: 0
    };
    if (!pack || !pack.roles) return counts;
    const keys = Object.keys(pack.roles);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        counts[k] = (pack.roles[k] || []).length;
    }
    return counts;
}

/**
 * Score art-set decorative volume under the slim-pack policy.
 *
 * ok / meetsMin: pack exists and unique ≥ min (default 1).
 * meetsTarget: unique ≤ target soft max AND every role list ≤ maxPerRole.
 * withinRoleMax: no role exceeds maxPerRole (default 4).
 *
 * @param {object|null} pack normalizeArtSetPack result
 * @param {{ min?: number, target?: number, maxPerRole?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   unique: number,
 *   min: number,
 *   target: number,
 *   maxNote: number,
 *   maxPerRole: number,
 *   meetsMin: boolean,
 *   meetsTarget: boolean,
 *   withinRoleMax: boolean,
 *   hasTerrain: boolean,
 *   roleCounts: Record<string, number>,
 *   tileIds: string[],
 *   message: string|null
 * }}
 */
function evaluateArtSetVolume(pack, opts) {
    const o = opts || {};
    const min =
        Number.isFinite(Number(o.min)) && Number(o.min) > 0
            ? Number(o.min) | 0
            : MIN_ART_SET_VOLUME;
    const target =
        Number.isFinite(Number(o.target)) && Number(o.target) > 0
            ? Number(o.target) | 0
            : TARGET_ART_SET_VOLUME;
    const maxPerRole =
        Number.isFinite(Number(o.maxPerRole)) && Number(o.maxPerRole) > 0
            ? Number(o.maxPerRole) | 0
            : MAX_ART_SET_PER_ROLE;
    const tileIds = listArtSetTileIds(pack);
    const unique = tileIds.length;
    const roleCounts = artSetRoleCounts(pack);
    const meetsMin = unique >= min;

    let withinRoleMax = true;
    const keys = Object.keys(roleCounts);
    for (let i = 0; i < keys.length; i++) {
        if ((roleCounts[keys[i]] | 0) > maxPerRole) {
            withinRoleMax = false;
            break;
        }
    }

    const hasTerrain =
        !!pack &&
        ((roleCounts.floor | 0) > 0 || (roleCounts.path | 0) > 0) &&
        ((roleCounts.wall | 0) > 0 || (roleCounts.void | 0) > 0);

    // Slim target: not oversized; role lists stay small.
    const meetsTarget = meetsMin && withinRoleMax && unique <= target;

    let message = null;
    if (!pack) {
        message = 'missing_art_set_pack';
    } else if (!meetsMin) {
        message = `art_volume_below_min unique=${unique} min=${min}`;
    } else if (!withinRoleMax) {
        message = `art_role_over_max maxPerRole=${maxPerRole}`;
    } else if (unique > target) {
        message = `art_volume_above_soft_target unique=${unique} target=${target}`;
    } else if (!hasTerrain) {
        message = 'art_missing_terrain_roles';
    }

    return {
        ok: !!pack && meetsMin && hasTerrain,
        unique,
        min,
        target,
        maxNote: MAX_ART_SET_VOLUME_NOTE,
        maxPerRole,
        meetsMin,
        meetsTarget,
        withinRoleMax,
        hasTerrain,
        roleCounts,
        tileIds,
        message
    };
}

/**
 * Build stair key set from links / pads.
 * @param {object[]} [stairs]
 * @param {object[]} [stairLinks]
 * @param {string|number} [zFilter] when set, only pads on this floor
 * @returns {Record<string, true>}
 */
function buildStairPadSet(stairs, stairLinks, zFilter) {
    /** @type {Record<string, true>} */
    const set = Object.create(null);
    const zWant =
        zFilter !== undefined && zFilter !== null ? String(zFilter) : null;

    const add = (x, y, z) => {
        if (x == null || y == null) return;
        const zz = z != null ? String(z) : zWant || '0';
        if (zWant != null && zz !== zWant) return;
        set[`${Math.round(Number(x))},${Math.round(Number(y))}`] = true;
    };

    if (Array.isArray(stairs)) {
        for (let i = 0; i < stairs.length; i++) {
            const s = stairs[i];
            if (!s) continue;
            if (s.x != null) {
                add(s.x, s.y, s.z);
            } else if (s.from) {
                add(s.from.x, s.from.y, s.from.z);
            }
            if (s.to) add(s.to.x, s.to.y, s.to.z);
        }
    }
    if (Array.isArray(stairLinks)) {
        for (let i = 0; i < stairLinks.length; i++) {
            const L = stairLinks[i];
            if (!L) continue;
            if (L.from) add(L.from.x, L.from.y, L.from.z);
            if (L.to) add(L.to.x, L.to.y, L.to.z);
        }
    }
    return set;
}

/**
 * True if any 4-neighbour is walkable.
 * @param {Uint8Array|ArrayLike<number>} friction
 * @param {number} cols
 * @param {number} rows
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function adjacentWalkable(friction, cols, rows, x, y) {
    const dirs = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0]
    ];
    for (let d = 0; d < 4; d++) {
        const nx = x + dirs[d][0];
        const ny = y + dirs[d][1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const f = friction[ny * cols + nx] & 0xff;
        if (f !== FRICTION_BLOCKED) return true;
    }
    return false;
}

/**
 * Bind one friction grid to decorative tile ids from terrain roles only.
 *
 * Uses floor / path / wall / stairs / void (water merges into void at normalize).
 * Does **not** stamp scenery or furniture — those stay editor palette lists.
 *
 * Preferred name: `bindArtFromRoles`. `bindArtToFriction` is an alias.
 *
 * @param {{
 *   friction: Uint8Array|ArrayLike<number>,
 *   cols: number,
 *   rows: number,
 *   artSet: object,
 *   seed?: number,
 *   z?: string|number,
 *   stairs?: object[],
 *   stairLinks?: object[],
 *   stairPads?: Record<string, true>
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   z: string|number,
 *   cols: number,
 *   rows: number,
 *   artSet: string,
 *   genre: string|null,
 *   kind: string,
 *   palette: string[],
 *   cells: Uint16Array,
 *   stats: { painted: number, floor: number, wall: number, path: number, stairs: number, void: number }
 * }|null}
 */
function bindArtFromRoles(opts) {
    const o = opts || {};
    const pack =
        o.artSet && o.artSet.roles
            ? o.artSet
            : normalizeArtSetPack(o.artSet);
    if (!pack) return null;

    const cols = o.cols | 0;
    const rows = o.rows | 0;
    const friction = o.friction;
    if (!friction || cols < 1 || rows < 1) return null;
    const n = cols * rows;
    if (friction.length < n) return null;

    const rng = createSeededRandom(artSeed(o.seed != null ? o.seed : 1));
    const z = o.z != null ? o.z : 0;
    const stairPads =
        o.stairPads ||
        buildStairPadSet(o.stairs, o.stairLinks, z);
    const edgeOnly = pack.rules.blockedEdgeOnly !== false;
    const pathMix = pack.rules.pathMix || 0;

    // Terrain-only lists (never scenery / furniture).
    const floorList = pack.roles.floor || [];
    const pathList = pack.roles.path || [];
    const wallList = pack.roles.wall || [];
    const stairsList = pack.roles.stairs || [];
    const voidList = pack.roles.void || [];

    /** @type {Record<string, number>} */
    const paletteIndex = Object.create(null);
    /** @type {string[]} index 0 reserved = empty / void */
    const palette = [''];

    /**
     * @param {string|null} tileId
     * @returns {number}
     */
    const toIndex = (tileId) => {
        if (!tileId) return 0;
        if (paletteIndex[tileId] != null) return paletteIndex[tileId];
        const idx = palette.length;
        if (idx > 0xffff) return 0;
        palette.push(tileId);
        paletteIndex[tileId] = idx;
        return idx;
    };

    const cells = new Uint16Array(n);
    const stats = {
        painted: 0,
        floor: 0,
        wall: 0,
        path: 0,
        stairs: 0,
        void: 0
    };

    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const i = y * cols + x;
            const f = friction[i] & 0xff;
            let tileId = null;
            let role = 'void';

            if (f !== FRICTION_BLOCKED) {
                const isStair = !!stairPads[`${x},${y}`];
                if (isStair && stairsList.length) {
                    tileId = pickWeightedId(rng, stairsList);
                    role = 'stairs';
                } else if (
                    pathMix > 0 &&
                    pathList.length &&
                    rng() < pathMix
                ) {
                    tileId = pickWeightedId(rng, pathList);
                    role = 'path';
                } else if (floorList.length) {
                    tileId = pickWeightedId(rng, floorList);
                    role = 'floor';
                } else if (pathList.length) {
                    tileId = pickWeightedId(rng, pathList);
                    role = 'path';
                }
            } else {
                // Blocked — wall on edges (or all blocked if !edgeOnly); else void art
                let paintWall = true;
                if (edgeOnly) {
                    paintWall = adjacentWalkable(friction, cols, rows, x, y);
                }
                if (paintWall && wallList.length) {
                    tileId = pickWeightedId(rng, wallList);
                    role = 'wall';
                } else if (voidList.length) {
                    tileId = pickWeightedId(rng, voidList);
                    role = 'void';
                } else {
                    tileId = null;
                    role = 'void';
                }
            }

            const idx = toIndex(tileId);
            cells[i] = idx;
            if (idx > 0) {
                stats.painted += 1;
                if (role === 'floor') stats.floor += 1;
                else if (role === 'wall') stats.wall += 1;
                else if (role === 'path') stats.path += 1;
                else if (role === 'stairs') stats.stairs += 1;
                else stats.void += 1;
            } else {
                stats.void += 1;
            }
        }
    }

    return {
        ok: true,
        z,
        cols,
        rows,
        artSet: pack.id,
        genre: pack.genre,
        kind: pack.kind || 'tiles',
        palette,
        cells,
        stats
    };
}

/** @deprecated Prefer bindArtFromRoles — same terrain-only bind. */
const bindArtToFriction = bindArtFromRoles;

/**
 * Resolve artSet id from hunt / layout / biome pointers.
 * @param {object} hunt
 * @param {{
 *   loadBiomePack?: (id: string) => object,
 *   loadDungeonProfile?: (id: string) => object
 * }} [loaders]
 * @returns {string|null}
 */
function resolveArtSetId(hunt, loaders) {
    if (!hunt || typeof hunt !== 'object') return null;
    const L = loaders || {};

    if (hunt.artSet != null) {
        const a = normalizeArtSet(hunt.artSet);
        if (a) return a;
    }
    if (hunt.layoutMeta && hunt.layoutMeta.artSet != null) {
        const a = normalizeArtSet(hunt.layoutMeta.artSet);
        if (a) return a;
    }
    if (hunt.layout && hunt.layout.artSet != null) {
        const a = normalizeArtSet(hunt.layout.artSet);
        if (a) return a;
    }

    // Biome pack pointer
    let biomeId = null;
    if (hunt.biomeId != null) biomeId = String(hunt.biomeId);
    else if (hunt.biome != null && typeof hunt.biome === 'string') {
        biomeId = String(hunt.biome);
    } else if (hunt.layout) {
        if (hunt.layout.biomeId != null) biomeId = String(hunt.layout.biomeId);
        else if (hunt.layout.biome != null) biomeId = String(hunt.layout.biome);
    }

    if (biomeId && typeof L.loadBiomePack === 'function') {
        try {
            const raw = L.loadBiomePack(biomeId);
            if (raw && raw.artSet != null) {
                const a = normalizeArtSet(raw.artSet);
                if (a) return a;
            }
            // Convention: artSet id often matches biome id
            if (raw && raw.id != null) {
                const a = normalizeArtSet(raw.id);
                // Only use biome id as artSet if pack file would be loadable later
                if (a) return a;
            }
        } catch (_e) {
            /* optional */
        }
    }

    // Profile.biome → load biome pack for artSet
    let profileBiome = null;
    if (hunt.layoutMeta && hunt.layoutMeta.biome) {
        profileBiome = String(hunt.layoutMeta.biome);
    }
    if (
        !profileBiome &&
        hunt.layout &&
        hunt.layout.profileId &&
        typeof L.loadDungeonProfile === 'function'
    ) {
        try {
            const pr = L.loadDungeonProfile(String(hunt.layout.profileId));
            if (pr && pr.biome) profileBiome = String(pr.biome);
            if (pr && pr.artSet) {
                const a = normalizeArtSet(pr.artSet);
                if (a) return a;
            }
        } catch (_e) {
            /* optional */
        }
    }
    if (profileBiome && typeof L.loadBiomePack === 'function') {
        try {
            const raw = L.loadBiomePack(profileBiome);
            if (raw && raw.artSet != null) {
                const a = normalizeArtSet(raw.artSet);
                if (a) return a;
            }
        } catch (_e) {
            /* optional */
        }
        // Fall back to biome id as art set id (cave → art_sets/cave.json)
        return normalizeArtSet(profileBiome);
    }

    return null;
}

/**
 * Attach floorArt / artLayers onto a hunt that already has friction.
 *
 * @param {object} hunt
 * @param {{
 *   seed?: number,
 *   loadArtSet?: (id: string) => object,
 *   loadBiomePack?: (id: string) => object,
 *   loadDungeonProfile?: (id: string) => object,
 *   genre?: string|null
 * }} [opts]
 * @returns {object}
 */
function bindHuntArt(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    // Already bound for this expand
    if (hunt.artMeta && hunt.artMeta.reason === 'ok') {
        if (hunt.floorArt || hunt.artLayers) return hunt;
    }

    const o = opts || {};
    const seed =
        o.seed != null
            ? o.seed >>> 0 || 1
            : hunt.seed != null
              ? hunt.seed >>> 0 || 1
              : 1;

    const artSetId = resolveArtSetId(hunt, {
        loadBiomePack: o.loadBiomePack,
        loadDungeonProfile: o.loadDungeonProfile
    });
    if (!artSetId) {
        const out = Object.assign({}, hunt);
        if (!out.artMeta) {
            out.artSkipped = 'no_artSet';
        }
        return out;
    }

    if (typeof o.loadArtSet !== 'function') {
        const out = Object.assign({}, hunt);
        out.artSkipped = 'no_loader';
        out.artMeta = {
            reason: 'skipped',
            artSet: artSetId,
            message: 'loadArtSet not available'
        };
        return out;
    }

    let packRaw = null;
    try {
        packRaw = o.loadArtSet(artSetId);
    } catch (e) {
        const out = Object.assign({}, hunt);
        out.artSkipped = 'load_failed';
        out.artMeta = {
            reason: 'failed',
            artSet: artSetId,
            message: e && e.message ? e.message : String(e)
        };
        return out;
    }

    const pack = normalizeArtSetPack(packRaw);
    if (!pack) {
        const out = Object.assign({}, hunt);
        out.artSkipped = 'invalid_pack';
        out.artMeta = {
            reason: 'failed',
            artSet: artSetId,
            message: 'Art set pack failed to normalize'
        };
        return out;
    }

    // Prefer explicit genre from pack, then hunt/mode, then null
    if (!pack.genre && o.genre) pack.genre = o.genre;
    if (!pack.genre && hunt.genre) pack.genre = String(hunt.genre);

    const out = Object.assign({}, hunt);
    out.artSet = artSetId;

    /** @type {object[]} */
    const floorResults = [];

    if (hunt.floorLayers && typeof hunt.floorLayers === 'object') {
        /** @type {Record<string, object>} */
        const artLayers = Object.create(null);
        const keys = Object.keys(hunt.floorLayers);
        for (let i = 0; i < keys.length; i++) {
            const zKey = keys[i];
            const layer = hunt.floorLayers[zKey];
            if (!layer || !layer.friction) continue;
            // Per-floor artSet override from layoutMeta.floorMeta
            let floorPack = pack;
            if (
                hunt.layoutMeta &&
                Array.isArray(hunt.layoutMeta.floorMeta)
            ) {
                for (let f = 0; f < hunt.layoutMeta.floorMeta.length; f++) {
                    const fm = hunt.layoutMeta.floorMeta[f];
                    if (!fm) continue;
                    if (String(fm.z) !== String(zKey)) continue;
                    if (fm.artSet && String(fm.artSet) !== pack.id) {
                        try {
                            const alt = normalizeArtSetPack(
                                o.loadArtSet(String(fm.artSet))
                            );
                            if (alt) floorPack = alt;
                        } catch (_e) {
                            /* keep default pack */
                        }
                    }
                    break;
                }
            }
            const bound = bindArtToFriction({
                friction: layer.friction,
                cols: layer.cols | 0,
                rows: layer.rows | 0,
                artSet: floorPack,
                seed: (seed + (Number(zKey) || 0) * 0x9e3779b9) >>> 0 || 1,
                z: zKey,
                stairs: hunt.stairs,
                stairLinks: hunt.stairLinks
            });
            if (bound) {
                artLayers[zKey] = {
                    cols: bound.cols,
                    rows: bound.rows,
                    palette: bound.palette,
                    cells: bound.cells,
                    artSet: bound.artSet,
                    genre: bound.genre,
                    kind: bound.kind
                };
                floorResults.push(bound);
            }
        }
        if (Object.keys(artLayers).length) {
            out.artLayers = artLayers;
            // Primary floor art for convenience
            const firstZ =
                hunt.floor != null
                    ? String(hunt.floor)
                    : Object.keys(artLayers)[0];
            if (artLayers[firstZ]) {
                out.floorArt = Object.assign({ z: firstZ }, artLayers[firstZ]);
            } else {
                const k0 = Object.keys(artLayers)[0];
                out.floorArt = Object.assign({ z: k0 }, artLayers[k0]);
            }
        }
    } else if (hunt.floorFriction && hunt.floorFriction.friction) {
        const ff = hunt.floorFriction;
        const z = ff.z != null ? ff.z : hunt.floor != null ? hunt.floor : 0;
        const bound = bindArtToFriction({
            friction: ff.friction,
            cols: ff.cols | 0,
            rows: ff.rows | 0,
            artSet: pack,
            seed,
            z,
            stairs: hunt.stairs,
            stairLinks: hunt.stairLinks
        });
        if (bound) {
            out.floorArt = {
                z: bound.z,
                cols: bound.cols,
                rows: bound.rows,
                palette: bound.palette,
                cells: bound.cells,
                artSet: bound.artSet,
                genre: bound.genre,
                kind: bound.kind
            };
            out.artLayers = Object.create(null);
            out.artLayers[String(bound.z)] = {
                cols: bound.cols,
                rows: bound.rows,
                palette: bound.palette,
                cells: bound.cells,
                artSet: bound.artSet,
                genre: bound.genre,
                kind: bound.kind
            };
            floorResults.push(bound);
        }
    } else {
        out.artSkipped = 'no_friction';
        out.artMeta = {
            reason: 'skipped',
            artSet: artSetId,
            message: 'No floorFriction / floorLayers to bind'
        };
        return out;
    }

    if (!floorResults.length) {
        out.artSkipped = 'bind_empty';
        out.artMeta = {
            reason: 'failed',
            artSet: artSetId,
            message: 'Art bind produced no layers'
        };
        return out;
    }

    let painted = 0;
    for (let i = 0; i < floorResults.length; i++) {
        painted += floorResults[i].stats.painted;
    }

    out.artMeta = {
        reason: 'ok',
        artSet: artSetId,
        genre: pack.genre,
        kind: pack.kind,
        seed,
        floorCount: floorResults.length,
        painted,
        tileIds: listArtSetTileIds(pack),
        stats: floorResults.map((r) => ({
            z: r.z,
            stats: r.stats,
            paletteSize: r.palette.length
        }))
    };
    delete out.artSkipped;
    return out;
}

/**
 * Resolve palette index → tile catalog id.
 * @param {{ palette: string[], cells: Uint16Array|ArrayLike<number> }} layer
 * @param {number} index flat cell index
 * @returns {string|null}
 */
function tileIdAt(layer, index) {
    if (!layer || !layer.palette || !layer.cells) return null;
    const idx = layer.cells[index] | 0;
    if (idx <= 0 || idx >= layer.palette.length) return null;
    const id = layer.palette[idx];
    return id || null;
}

/**
 * @param {{ palette: string[], cells: Uint16Array|ArrayLike<number>, cols: number }} layer
 * @param {number} x
 * @param {number} y
 * @returns {string|null}
 */
function tileIdAtXY(layer, x, y) {
    if (!layer) return null;
    const cols = layer.cols | 0;
    return tileIdAt(layer, (y | 0) * cols + (x | 0));
}

module.exports = {
    ART_SEED_SALT,
    MIN_ART_SET_VOLUME,
    TARGET_ART_SET_VOLUME,
    MAX_ART_SET_VOLUME_NOTE,
    MAX_ART_SET_PER_ROLE,
    TERRAIN_BIND_ROLES,
    artSeed,
    normalizeRoleEntry,
    normalizeArtSetPack,
    listArtSetTileIds,
    artSetVolume,
    artSetRoleCounts,
    evaluateArtSetVolume,
    bindArtFromRoles,
    bindArtToFriction,
    bindHuntArt,
    resolveArtSetId,
    buildStairPadSet,
    tileIdAt,
    tileIdAtXY,
    pickWeightedId,
    defaultCatalogKindForRole
};
