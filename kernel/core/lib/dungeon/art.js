/**
 * Stage 11.9 — Art tile binding.
 * Stage 11.11 — Deeper art volume helpers (unique tile counts per art set).
 *
 * Map an artSet id (biome / hunt pointer) onto friction cells using a
 * mode-local art set pack that lists genre tiles catalog ids by role
 * (floor / wall / path / stairs). Output is a compact palette + Uint16
 * index layer parallel to floorFriction / floorLayers — headless stays
 * pure; watch mode draws catalog PNGs when ImageDB is ready.
 *
 * Logic pieces stay collision-only; decorative binding is a separate layer.
 * Blueprint tile volume: 18–70 unique decorative looks per biome.
 */

'use strict';

const { createSeededRandom } = require('../utils.js');
const { FRICTION_BLOCKED } = require('../../entities/tilemap.js');
const { normalizeArtSet } = require('./biome.js');

/** Salt so art RNG is independent of layout / population streams. */
const ART_SEED_SALT = 0x41525454; // "ARTT"

/** Default walkable gray used when comparing friction (informational). */
const DEFAULT_WALK_FRICTION = 100;

/**
 * Blueprint Phase 2 floor: minimum distinct catalog tile ids per art set.
 * Packs below this still bind, but CI flags volume as short.
 */
const MIN_ART_SET_VOLUME = 18;

/**
 * Comfortable mid-range toward the 70-tile ceiling (Stage 11.11 target).
 */
const TARGET_ART_SET_VOLUME = 40;

/** Soft upper note for designers (not enforced). */
const MAX_ART_SET_VOLUME_NOTE = 70;

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
 * Normalize one role entry: string id or { id, weight }.
 * @param {*} raw
 * @returns {{ id: string, weight: number }|null}
 */
function normalizeRoleEntry(raw) {
    if (raw == null) return null;
    if (typeof raw === 'string') {
        const id = String(raw).trim();
        if (!id) return null;
        return { id, weight: 1 };
    }
    if (typeof raw !== 'object') return null;
    const id =
        raw.id != null
            ? String(raw.id).trim()
            : raw.tileId != null
              ? String(raw.tileId).trim()
              : raw.tile != null
                ? String(raw.tile).trim()
                : '';
    if (!id) return null;
    let weight = Number(raw.weight);
    if (!Number.isFinite(weight) || weight < 0) weight = 1;
    return { id, weight };
}

/**
 * @param {*} raw array of role entries
 * @returns {Array<{ id: string, weight: number }>}
 */
function normalizeRoleList(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {Array<{ id: string, weight: number }>} */
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const e = normalizeRoleEntry(raw[i]);
        if (e) out.push(e);
    }
    return out;
}

/**
 * Normalize art set pack (file or inline).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeArtSetPack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeArtSet(raw.id != null ? raw.id : raw.artSet);
    if (!id) return null;

    const rolesRaw =
        raw.roles && typeof raw.roles === 'object' ? raw.roles : raw;
    const floor = normalizeRoleList(
        rolesRaw.floor || rolesRaw.floors || raw.floor
    );
    const wall = normalizeRoleList(
        rolesRaw.wall || rolesRaw.walls || raw.wall
    );
    const path = normalizeRoleList(
        rolesRaw.path || rolesRaw.paths || raw.path
    );
    const stairs = normalizeRoleList(
        rolesRaw.stairs ||
            rolesRaw.stair ||
            rolesRaw.special ||
            raw.stairs ||
            raw.special
    );
    const voidRole = normalizeRoleList(
        rolesRaw.void || rolesRaw.voids || raw.void
    );

    if (!floor.length && !wall.length && !path.length && !stairs.length) {
        return null;
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
        kind: raw.kind != null ? String(raw.kind) : 'tiles',
        roles: {
            floor,
            wall,
            path,
            stairs,
            void: voidRole
        },
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
 * Collect unique tile catalog ids referenced by a pack.
 * @param {object|null} pack normalizeArtSetPack result
 * @returns {string[]}
 */
function listArtSetTileIds(pack) {
    if (!pack || !pack.roles) return [];
    const seen = Object.create(null);
    /** @type {string[]} */
    const out = [];
    const roles = ['floor', 'wall', 'path', 'stairs', 'void'];
    for (let r = 0; r < roles.length; r++) {
        const list = pack.roles[roles[r]] || [];
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
 * Count unique tile catalog ids referenced by a pack (art volume).
 * @param {object|null} pack normalizeArtSetPack result
 * @returns {number}
 */
function artSetVolume(pack) {
    return listArtSetTileIds(pack).length;
}

/**
 * Per-role entry counts (weights ignored; list length only).
 * @param {object|null} pack
 * @returns {{ floor: number, wall: number, path: number, stairs: number, void: number }}
 */
function artSetRoleCounts(pack) {
    const empty = { floor: 0, wall: 0, path: 0, stairs: 0, void: 0 };
    if (!pack || !pack.roles) return empty;
    return {
        floor: (pack.roles.floor || []).length,
        wall: (pack.roles.wall || []).length,
        path: (pack.roles.path || []).length,
        stairs: (pack.roles.stairs || []).length,
        void: (pack.roles.void || []).length
    };
}

/**
 * Score art-set decorative volume vs blueprint 18–70 band.
 *
 * @param {object|null} pack normalizeArtSetPack result
 * @param {{ min?: number, target?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   unique: number,
 *   min: number,
 *   target: number,
 *   maxNote: number,
 *   meetsMin: boolean,
 *   meetsTarget: boolean,
 *   roleCounts: { floor: number, wall: number, path: number, stairs: number, void: number },
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
    const tileIds = listArtSetTileIds(pack);
    const unique = tileIds.length;
    const roleCounts = artSetRoleCounts(pack);
    const meetsMin = unique >= min;
    const meetsTarget = unique >= target;
    let message = null;
    if (!pack) {
        message = 'missing_art_set_pack';
    } else if (!meetsMin) {
        message = `art_volume_below_min unique=${unique} min=${min}`;
    } else if (!meetsTarget) {
        message = `art_volume_below_target unique=${unique} target=${target}`;
    }
    return {
        ok: !!pack && meetsMin,
        unique,
        min,
        target,
        maxNote: MAX_ART_SET_VOLUME_NOTE,
        meetsMin,
        meetsTarget,
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
 * Bind one friction grid to decorative tile ids.
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
function bindArtToFriction(opts) {
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
                if (isStair && pack.roles.stairs.length) {
                    tileId = pickWeightedId(rng, pack.roles.stairs);
                    role = 'stairs';
                } else if (
                    pathMix > 0 &&
                    pack.roles.path.length &&
                    rng() < pathMix
                ) {
                    tileId = pickWeightedId(rng, pack.roles.path);
                    role = 'path';
                } else if (pack.roles.floor.length) {
                    tileId = pickWeightedId(rng, pack.roles.floor);
                    role = 'floor';
                } else if (pack.roles.path.length) {
                    tileId = pickWeightedId(rng, pack.roles.path);
                    role = 'path';
                }
            } else {
                // Blocked
                let paintWall = true;
                if (edgeOnly) {
                    paintWall = adjacentWalkable(friction, cols, rows, x, y);
                }
                if (paintWall && pack.roles.wall.length) {
                    tileId = pickWeightedId(rng, pack.roles.wall);
                    role = 'wall';
                } else if (pack.roles.void.length) {
                    tileId = pickWeightedId(rng, pack.roles.void);
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
    artSeed,
    normalizeArtSetPack,
    listArtSetTileIds,
    artSetVolume,
    artSetRoleCounts,
    evaluateArtSetVolume,
    bindArtToFriction,
    bindHuntArt,
    resolveArtSetId,
    buildStairPadSet,
    tileIdAt,
    tileIdAtXY,
    pickWeightedId
};
