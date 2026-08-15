/**
 * Tile roles — pure data helpers for map-editor bake (Phase 1).
 *
 * Roles declare gameplay influence (friction / sight / flags) and default
 * render scale/anchor. Composition bakes ordered stacks into flat channels.
 * Runtime maps still load friction PNG / flat arrays; this module does not
 * touch TileMap entities.
 *
 * Flag bit constants here match the locked plan (Phase 2 will mirror them on
 * tilemap.js). Fields are never written by role influence.
 */

'use strict';

/** Walk / sight blocked channel value. */
const FRICTION_BLOCKED = 255;
const SIGHT_BLOCKED = 255;
/** Default open-floor step delay (matches DEFAULT_TILE_FRICTION). */
const DEFAULT_OPEN_FRICTION = 100;

/**
 * Flag bits used by role influence (authoritative names for bake data).
 * Phase 2 wires the same values into tilemap helpers.
 */
const TILE_FLAG_NO_CAST = 1 << 0; // 1
const TILE_FLAG_STAIR = 1 << 1; // 2
const TILE_FLAG_LADDER = 1 << 2; // 4
const TILE_FLAG_HOLE = 1 << 3; // 8
const TILE_FLAG_ROPE_SPOT = 1 << 4; // 16
const TILE_FLAG_SHOVEL_SPOT = 1 << 5; // 32
const TILE_FLAG_NO_CREATURE = 1 << 6; // 64
/** Full protection-zone package (editor sugar + protection role bake). */
const TILE_FLAG_PZ_PACKAGE = TILE_FLAG_NO_CAST | TILE_FLAG_NO_CREATURE; // 65

const ANCHOR_OPTIONS = [
    'top_left',
    'top_center',
    'top_right',
    'middle_left',
    'middle_center',
    'middle_right',
    'bottom_left',
    'bottom_center',
    'bottom_right'
];

const WALK_MODES = { open: true, block: true };
const SIGHT_MODES = { clear: true, block: true };
const VERTICAL_TYPES = {
    stairs: true,
    ladder: true,
    hole: true,
    rope: true,
    shovel: true
};
const HOP_DIRS = {
    center: true,
    north: true,
    south: true,
    east: true,
    west: true
};

const ENTITY_ID_RE = /^[a-z][a-z0-9_]{0,79}$/;

/**
 * @param {*} v
 * @returns {string|null}
 */
function normalizeEntityId(v) {
    if (v == null) return null;
    const s = String(v)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '');
    if (!s || !ENTITY_ID_RE.test(s)) return null;
    return s;
}

/**
 * @param {*} v
 * @param {string} fallback
 * @returns {string}
 */
function normalizeAnchor(v, fallback) {
    const s = v != null ? String(v).trim().toLowerCase() : '';
    if (ANCHOR_OPTIONS.indexOf(s) >= 0) return s;
    return fallback || 'middle_center';
}

/**
 * @param {*} v
 * @param {number} lo
 * @param {number} hi
 * @param {number} fallback
 * @returns {number}
 */
function clampInt(v, lo, hi, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.round(n);
    if (i < lo) return lo;
    if (i > hi) return hi;
    return i;
}

/**
 * @param {*} v
 * @param {number} lo
 * @param {number} hi
 * @param {number} fallback
 * @returns {number}
 */
function clampNum(v, lo, hi, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

/**
 * Infer walkMode from friction when omitted.
 * @param {number} friction
 * @param {string|undefined} walkMode
 * @returns {'open'|'block'}
 */
function resolveWalkMode(friction, walkMode) {
    const m = walkMode != null ? String(walkMode).trim().toLowerCase() : '';
    if (WALK_MODES[m]) return /** @type {'open'|'block'} */ (m);
    return friction >= FRICTION_BLOCKED ? 'block' : 'open';
}

/**
 * Infer sightMode from sight when omitted.
 * @param {number} sight
 * @param {string|undefined} sightMode
 * @returns {'clear'|'block'}
 */
function resolveSightMode(sight, sightMode) {
    const m = sightMode != null ? String(sightMode).trim().toLowerCase() : '';
    if (SIGHT_MODES[m]) return /** @type {'clear'|'block'} */ (m);
    return sight >= SIGHT_BLOCKED ? 'block' : 'clear';
}

/**
 * Parse only authored influence keys (no role defaults). Empty / invalid → null.
 * Used by art-set items and hybrid placements so one icy floor can override
 * friction without replacing the whole role.
 *
 * @param {*} raw
 * @returns {{
 *   friction?: number,
 *   sight?: number,
 *   flags?: number,
 *   walkMode?: 'open'|'block',
 *   sightMode?: 'clear'|'block'
 * }|null}
 */
function normalizePartialInfluence(raw) {
    if (!raw || typeof raw !== 'object') return null;
    /** @type {{
     *   friction?: number,
     *   sight?: number,
     *   flags?: number,
     *   walkMode?: 'open'|'block',
     *   sightMode?: 'clear'|'block'
     * }} */
    const out = {};
    let any = false;
    if (raw.friction != null && Number.isFinite(Number(raw.friction))) {
        out.friction = clampInt(raw.friction, 0, 255, DEFAULT_OPEN_FRICTION);
        any = true;
    }
    if (raw.sight != null && Number.isFinite(Number(raw.sight))) {
        out.sight = clampInt(raw.sight, 0, 255, 0);
        any = true;
    }
    if (raw.flags != null && Number.isFinite(Number(raw.flags))) {
        out.flags = clampInt(raw.flags, 0, 255, 0);
        any = true;
    }
    if (raw.walkMode != null) {
        const m = String(raw.walkMode).trim().toLowerCase();
        if (WALK_MODES[m]) {
            out.walkMode = /** @type {'open'|'block'} */ (m);
            any = true;
        }
    }
    if (raw.sightMode != null) {
        const m = String(raw.sightMode).trim().toLowerCase();
        if (SIGHT_MODES[m]) {
            out.sightMode = /** @type {'clear'|'block'} */ (m);
            any = true;
        }
    }
    return any ? out : null;
}

/**
 * Overlay authored keys onto a base influence. Override wins per key.
 * `flags` is replaced (not OR'd) at this layer; bake still ORs the stack.
 *
 * @param {object|null|undefined} base
 * @param {object|null|undefined} override
 * @returns {object|null}
 */
function mergeInfluence(base, override) {
    const o = normalizePartialInfluence(override);
    if (!o) {
        return base && typeof base === 'object' ? base : null;
    }
    /** @type {object} */
    const out = base && typeof base === 'object' ? Object.assign({}, base) : {};
    if (o.friction != null) out.friction = o.friction;
    if (o.sight != null) out.sight = o.sight;
    if (o.flags != null) out.flags = o.flags;
    if (o.walkMode != null) out.walkMode = o.walkMode;
    if (o.sightMode != null) out.sightMode = o.sightMode;
    return out;
}

/**
 * Stable identity for palette intern (same catalog id + different friction
 * must not collapse to one slot).
 *
 * @param {object|null|undefined} inf
 * @returns {string}
 */
function influenceKey(inf) {
    if (!inf || typeof inf !== 'object') return '';
    return [
        inf.friction != null ? inf.friction : '',
        inf.sight != null ? inf.sight : '',
        inf.flags != null ? inf.flags : '',
        inf.walkMode || '',
        inf.sightMode || ''
    ].join(',');
}

/**
 * @param {*} raw
 * @returns {{ type: string, deltaZ: number, defaultDir: string, bidirectional: boolean, registerStairLink: boolean }|null}
 */
function normalizeVertical(raw) {
    if (raw == null || raw === false) return null;
    if (typeof raw !== 'object') return null;
    const typeRaw =
        raw.type != null
            ? String(raw.type).trim().toLowerCase()
            : raw.kind != null
              ? String(raw.kind).trim().toLowerCase()
              : '';
    if (!VERTICAL_TYPES[typeRaw]) return null;

    let deltaZ = Number(raw.deltaZ);
    if (!Number.isFinite(deltaZ)) {
        // Convention: up transit decreases z; down increases z.
        if (typeRaw === 'stairs' || typeRaw === 'ladder' || typeRaw === 'rope') {
            deltaZ = -1;
        } else {
            deltaZ = 1;
        }
    }
    deltaZ = Math.trunc(deltaZ);
    if (deltaZ === 0) deltaZ = typeRaw === 'hole' || typeRaw === 'shovel' ? 1 : -1;

    const dirRaw =
        raw.defaultDir != null
            ? String(raw.defaultDir).trim().toLowerCase()
            : raw.dir != null
              ? String(raw.dir).trim().toLowerCase()
              : 'center';
    const defaultDir = HOP_DIRS[dirRaw] ? dirRaw : 'center';

    const registerStairLink =
        raw.registerStairLink !== undefined
            ? !!raw.registerStairLink
            : typeRaw === 'stairs' || typeRaw === 'ladder' || typeRaw === 'hole';

    return {
        type: typeRaw,
        deltaZ,
        defaultDir,
        bidirectional: !!raw.bidirectional,
        registerStairLink
    };
}

/**
 * Default anchor: props (objects-only hints) use bottom_center; terrain middle_center.
 * @param {string[]} kindHints
 * @returns {string}
 */
function defaultAnchorForKinds(kindHints) {
    if (
        Array.isArray(kindHints) &&
        kindHints.length === 1 &&
        kindHints[0] === 'objects'
    ) {
        return 'bottom_center';
    }
    if (
        Array.isArray(kindHints) &&
        kindHints.indexOf('objects') >= 0 &&
        kindHints.indexOf('tiles') < 0
    ) {
        return 'bottom_center';
    }
    return 'middle_center';
}

/**
 * Normalize a tile role document (file or inline).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeTileRole(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeEntityId(raw.id != null ? raw.id : raw.roleId);
    if (!id) return null;

    const label =
        raw.label != null && String(raw.label).trim()
            ? String(raw.label).trim().slice(0, 120)
            : id;

    const notes =
        raw.notes != null && String(raw.notes).trim()
            ? String(raw.notes).trim().slice(0, 4000)
            : '';

    /** @type {string[]} */
    const kindHints = [];
    const khRaw = raw.kindHints != null ? raw.kindHints : raw.kinds;
    if (Array.isArray(khRaw)) {
        for (let i = 0; i < khRaw.length; i++) {
            const k = String(khRaw[i] || '')
                .trim()
                .toLowerCase();
            if (
                (k === 'tiles' || k === 'objects' || k === 'overlays') &&
                kindHints.indexOf(k) < 0
            ) {
                kindHints.push(k);
            }
        }
    }
    if (!kindHints.length) kindHints.push('tiles');

    /** @type {string[]} */
    const catalogCategories = [];
    const catRaw =
        raw.catalogCategories != null
            ? raw.catalogCategories
            : raw.categories;
    if (Array.isArray(catRaw)) {
        for (let i = 0; i < catRaw.length; i++) {
            const c = String(catRaw[i] || '')
                .trim()
                .toLowerCase();
            if (c && catalogCategories.indexOf(c) < 0) {
                catalogCategories.push(c.slice(0, 40));
            }
        }
    }

    const infRaw =
        raw.influence && typeof raw.influence === 'object' ? raw.influence : {};
    let friction = clampInt(
        infRaw.friction != null ? infRaw.friction : raw.friction,
        0,
        255,
        DEFAULT_OPEN_FRICTION
    );
    let sight = clampInt(
        infRaw.sight != null ? infRaw.sight : raw.sight,
        0,
        255,
        0
    );
    const flags = clampInt(
        infRaw.flags != null ? infRaw.flags : raw.flags,
        0,
        255,
        0
    );
    const walkMode = resolveWalkMode(
        friction,
        infRaw.walkMode != null ? infRaw.walkMode : raw.walkMode
    );
    const sightMode = resolveSightMode(
        sight,
        infRaw.sightMode != null ? infRaw.sightMode : raw.sightMode
    );

    // Keep channel values consistent with modes.
    if (walkMode === 'block') friction = FRICTION_BLOCKED;
    else if (friction >= FRICTION_BLOCKED) friction = DEFAULT_OPEN_FRICTION;
    if (sightMode === 'block') sight = SIGHT_BLOCKED;
    else sight = 0;

    const renderRaw =
        raw.render && typeof raw.render === 'object' ? raw.render : {};
    const defaultAnchor = defaultAnchorForKinds(kindHints);
    const render = {
        scale: clampNum(
            renderRaw.scale != null ? renderRaw.scale : raw.scale,
            0.05,
            8,
            1
        ),
        anchor: normalizeAnchor(
            renderRaw.anchor != null ? renderRaw.anchor : raw.anchor,
            defaultAnchor
        ),
        variant:
            renderRaw.variant != null && String(renderRaw.variant).trim()
                ? String(renderRaw.variant).trim().slice(0, 40)
                : 'retro'
    };

    const vertical = normalizeVertical(
        raw.vertical !== undefined ? raw.vertical : null
    );

    return {
        id,
        label,
        notes,
        kindHints,
        catalogCategories,
        render,
        influence: {
            friction,
            sight,
            flags,
            walkMode,
            sightMode
        },
        vertical
    };
}

/**
 * True when authored vertical has hop fields (not null / empty).
 * @param {*} raw
 * @returns {boolean}
 */
function authoredHopFields(raw) {
    if (raw == null || raw === false) return false;
    if (typeof raw !== 'object') return false;
    return (
        raw.type != null ||
        raw.kind != null ||
        raw.deltaZ != null ||
        raw.defaultDir != null ||
        raw.dir != null ||
        raw.bidirectional != null ||
        raw.registerStairLink != null
    );
}

/**
 * Structural check for Designer validate (influence ranges + wall vs hop).
 * @param {*} raw
 * @returns {{ ok: boolean, errors: string[], warnings: string[], detail: object|null }}
 */
function validateTileRole(raw) {
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];
    const role = normalizeTileRole(raw);
    if (!role) {
        return {
            ok: false,
            errors: ['tile_role_invalid_or_missing_id'],
            warnings,
            detail: null
        };
    }

    const infRaw =
        raw && raw.influence && typeof raw.influence === 'object'
            ? raw.influence
            : raw && typeof raw === 'object'
              ? raw
              : {};
    const checkByte = (key) => {
        if (infRaw[key] == null) return;
        const n = Number(infRaw[key]);
        if (!Number.isFinite(n) || n < 0 || n > 255) {
            errors.push('influence.' + key + '_out_of_range');
        }
    };
    checkByte('friction');
    checkByte('sight');
    checkByte('flags');

    if (infRaw.walkMode != null) {
        const m = String(infRaw.walkMode).trim().toLowerCase();
        if (!WALK_MODES[m]) errors.push('influence.walkMode_invalid');
    }
    if (infRaw.sightMode != null) {
        const m = String(infRaw.sightMode).trim().toLowerCase();
        if (!SIGHT_MODES[m]) errors.push('influence.sightMode_invalid');
    }

    const hints = role.kindHints;
    const cats = role.catalogCategories;
    const claimsWallFace =
        hints.indexOf('objects') >= 0 && cats.indexOf('wall') >= 0;
    const isWallRole = role.id === 'wall' || claimsWallFace;
    const hop = authoredHopFields(raw && raw.vertical);
    if (isWallRole && hop) {
        errors.push('vertical_hop_on_wall_face');
    }
    if (hop && !normalizeVertical(raw.vertical)) {
        errors.push('vertical_invalid');
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        detail: {
            id: role.id,
            influence: role.influence,
            vertical: role.vertical,
            kindHints: role.kindHints
        }
    };
}

/**
 * Mutable bake accumulator for one cell (bottom → top apply).
 * @returns {object}
 */
function createBakeAccumulator() {
    return {
        walkBlocked: false,
        hasWalkContributor: false,
        lastOpenFriction: DEFAULT_OPEN_FRICTION,
        sightBlocked: false,
        hasSightContributor: false,
        flags: 0,
        /** @type {object|null} */
        vertical: null,
        /** @type {object|null} */
        hop: null,
        /** @type {string|null} */
        topRoleId: null
    };
}

/**
 * Apply one role influence onto a bake accumulator (OR walk/sight; OR flags;
 * topmost open friction; topmost vertical wins).
 *
 * @param {object} cell accumulator from createBakeAccumulator
 * @param {object|null|undefined} influence role.influence or raw influence
 * @param {{ vertical?: object|null, hop?: object|null, roleId?: string, id?: string }|null} [meta]
 * @returns {object} cell
 */
function applyInfluence(cell, influence, meta) {
    if (!cell || typeof cell !== 'object') return cell;
    const inf =
        influence && typeof influence === 'object' ? influence : null;
    if (!inf) return cell;

    const friction = clampInt(inf.friction, 0, 255, DEFAULT_OPEN_FRICTION);
    const sight = clampInt(inf.sight, 0, 255, 0);
    const flags = clampInt(inf.flags, 0, 255, 0) | 0;
    const walkMode = resolveWalkMode(friction, inf.walkMode);
    const sightMode = resolveSightMode(sight, inf.sightMode);

    if (walkMode === 'block' || friction >= FRICTION_BLOCKED) {
        cell.walkBlocked = true;
    } else {
        cell.hasWalkContributor = true;
        // Topmost walkable contributor wins delay when final cell is open.
        cell.lastOpenFriction =
            friction > 250 ? DEFAULT_OPEN_FRICTION : friction;
    }

    if (sightMode === 'block' || sight >= SIGHT_BLOCKED) {
        cell.sightBlocked = true;
    } else {
        cell.hasSightContributor = true;
    }

    cell.flags = (cell.flags | flags) & 0xff;

    const m = meta && typeof meta === 'object' ? meta : null;
    if (m) {
        if (m.vertical && typeof m.vertical === 'object') {
            const v = normalizeVertical(m.vertical);
            if (v) cell.vertical = v;
        }
        if (m.hop && typeof m.hop === 'object') {
            cell.hop = m.hop;
        }
        const rid =
            m.roleId != null
                ? normalizeEntityId(m.roleId)
                : m.id != null
                  ? normalizeEntityId(m.id)
                  : null;
        if (rid) cell.topRoleId = rid;
    }

    return cell;
}

/**
 * Apply a full normalized role (influence + vertical) onto accumulator.
 * @param {object} cell
 * @param {object|null|undefined} role normalizeTileRole output
 * @param {{ hop?: object|null }|null} [placement]
 * @returns {object}
 */
function applyRole(cell, role, placement) {
    if (!role || typeof role !== 'object') return cell;
    applyInfluence(cell, role.influence, {
        vertical: role.vertical,
        hop: placement && placement.hop,
        roleId: role.id,
        id: role.id
    });
    return cell;
}

/**
 * Finalize accumulator → flat channel values.
 * Empty stack (no contributors) → void (blocked walk + sight).
 *
 * @param {object} cell
 * @returns {{
 *   friction: number,
 *   sight: number,
 *   flags: number,
 *   vertical: object|null,
 *   hop: object|null,
 *   topRoleId: string|null
 * }}
 */
function finalizeBakeCell(cell) {
    const c = cell && typeof cell === 'object' ? cell : createBakeAccumulator();
    const walkOpen = c.hasWalkContributor && !c.walkBlocked;
    const sightClear = c.hasSightContributor && !c.sightBlocked;
    return {
        friction: walkOpen
            ? clampInt(c.lastOpenFriction, 0, 250, DEFAULT_OPEN_FRICTION)
            : FRICTION_BLOCKED,
        sight: sightClear ? 0 : SIGHT_BLOCKED,
        flags: (c.flags | 0) & 0xff,
        vertical: c.vertical || null,
        hop: c.hop || null,
        topRoleId: c.topRoleId || null
    };
}

/**
 * Bake one cell from an ordered list of roles (bottom → top).
 * Accepts normalized roles, raw role docs, or { role, hop } placement-like entries.
 *
 * @param {Array<object|null|undefined>} stack
 * @returns {{
 *   friction: number,
 *   sight: number,
 *   flags: number,
 *   vertical: object|null,
 *   hop: object|null,
 *   topRoleId: string|null
 * }}
 */
function bakeCellChannels(stack) {
    const acc = createBakeAccumulator();
    if (!Array.isArray(stack) || stack.length === 0) {
        return finalizeBakeCell(acc);
    }
    for (let i = 0; i < stack.length; i++) {
        const entry = stack[i];
        if (entry == null) continue;

        // Placement-shaped: { role, hop } or { influence, vertical, hop, roleId }
        if (entry.role != null) {
            const role =
                entry.role.influence != null
                    ? entry.role
                    : normalizeTileRole(entry.role);
            if (role) applyRole(acc, role, entry);
            continue;
        }

        if (entry.influence != null && typeof entry.influence === 'object') {
            // Already normalized role or influence-bearing object
            if (entry.id != null || entry.vertical !== undefined || entry.render) {
                const role =
                    entry.influence.walkMode != null || entry.render
                        ? entry
                        : normalizeTileRole(entry);
                if (role && role.influence) {
                    applyRole(acc, role, entry);
                } else {
                    applyInfluence(acc, entry.influence, entry);
                }
            } else {
                applyInfluence(acc, entry.influence, entry);
            }
            continue;
        }

        // Raw role document
        const role = normalizeTileRole(entry);
        if (role) applyRole(acc, role, null);
    }
    return finalizeBakeCell(acc);
}

/**
 * Resolve hop exit offset for stair registry (Phase 2+ wiring).
 * @param {string|null|undefined} dir
 * @returns {{ dx: number, dy: number }}
 */
function hopDirOffset(dir) {
    const d = dir != null ? String(dir).trim().toLowerCase() : 'center';
    switch (d) {
        case 'north':
            return { dx: 0, dy: -1 };
        case 'south':
            return { dx: 0, dy: 1 };
        case 'west':
            return { dx: -1, dy: 0 };
        case 'east':
            return { dx: 1, dy: 0 };
        case 'custom':
        default:
            return { dx: 0, dy: 0 };
    }
}

/**
 * Index normalized roles by id from an array of raw or normalized docs.
 * @param {Array<object|null|undefined>} list
 * @returns {Map<string, object>}
 */
function indexTileRoles(list) {
    /** @type {Map<string, object>} */
    const map = new Map();
    if (!Array.isArray(list)) return map;
    for (let i = 0; i < list.length; i++) {
        const role = list[i] && list[i].influence
            ? list[i]
            : normalizeTileRole(list[i]);
        if (role && role.id) map.set(role.id, role);
    }
    return map;
}

/**
 * Look up a role by id from a Map or plain object catalog.
 * @param {Map<string, object>|Record<string, object>|null|undefined} catalog
 * @param {string} roleId
 * @returns {object|null}
 */
function resolveTileRole(catalog, roleId) {
    const id = normalizeEntityId(roleId);
    if (!id || catalog == null) return null;
    if (typeof catalog.get === 'function') {
        const hit = catalog.get(id);
        return hit || null;
    }
    if (typeof catalog === 'object') {
        return catalog[id] || null;
    }
    return null;
}

module.exports = {
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    DEFAULT_OPEN_FRICTION,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_STAIR,
    TILE_FLAG_LADDER,
    TILE_FLAG_HOLE,
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT,
    TILE_FLAG_NO_CREATURE,
    TILE_FLAG_PZ_PACKAGE,
    ANCHOR_OPTIONS,
    normalizeEntityId,
    normalizeTileRole,
    normalizeVertical,
    validateTileRole,
    createBakeAccumulator,
    applyInfluence,
    applyRole,
    finalizeBakeCell,
    bakeCellChannels,
    hopDirOffset,
    indexTileRoles,
    resolveTileRole,
    normalizePartialInfluence,
    mergeInfluence,
    influenceKey
};
