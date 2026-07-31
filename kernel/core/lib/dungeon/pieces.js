/**
 * Stage 11.3 — Modular friction pieces (Blueprint Phase 2, logic-only).
 *
 * A piece is a friction prefab + exit mask + sockets (spawns / markers /
 * waypoints). 1 tile = 1 path-PNG pixel (the project's metric foot).
 * No decorative art here — collision + holes only.
 */

'use strict';

const { FRICTION_BLOCKED } = require('../../entities/tilemap.js');

/** Default walkable gray friction (matches common path-PNG mid-gray). */
const DEFAULT_WALK_FRICTION = 100;

/** Cardinal directions and opposites. */
const CARDINALS = ['N', 'S', 'E', 'W'];
const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

/**
 * @param {*} v
 * @returns {number|null}
 */
function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Decode one friction cell token to 0–255.
 * Row-string chars: `#`/`X`/`W` blocked; `.`/` ` default walk; hex `0`-`9`/`a`-`f`
 * for 0–15 scaled later is NOT used — digits 0–9 map to friction 0,28,…,252
 * and `+` is full open (0). Prefer `.` for normal floors.
 *
 * Number cells: 0–254 walkable, 255 blocked.
 *
 * @param {string|number} cell
 * @param {number} walkDefault
 * @returns {number}
 */
function decodeFrictionCell(cell, walkDefault) {
    const walk =
        Number.isFinite(walkDefault) && walkDefault >= 0 && walkDefault < 255
            ? walkDefault | 0
            : DEFAULT_WALK_FRICTION;

    if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) return FRICTION_BLOCKED;
        const n = Math.floor(cell);
        if (n < 0) return FRICTION_BLOCKED;
        if (n > 255) return FRICTION_BLOCKED;
        return n;
    }

    const s = String(cell);
    if (!s.length) return FRICTION_BLOCKED;
    const ch = s.charAt(0);
    if (ch === '#' || ch === 'X' || ch === 'x' || ch === 'W') {
        return FRICTION_BLOCKED;
    }
    if (ch === '.' || ch === ' ' || ch === 'o' || ch === 'O') {
        return walk;
    }
    if (ch === '+') return 0;
    // Single hex digit → friction 0–15 (fine-grained soft floors)
    if (/^[0-9a-fA-F]$/.test(ch)) {
        return parseInt(ch, 16);
    }
    // Multi-digit numeric string
    const n = Number(s);
    if (Number.isFinite(n) && n >= 0 && n <= 255) return Math.floor(n);
    return FRICTION_BLOCKED;
}

/**
 * Parse friction field into a flat Uint8Array of length w*h.
 *
 * Accepts:
 * - array of row strings (human-diffable, preferred)
 * - array of number arrays
 * - flat number array length w*h
 * - single string with `\n` or `;` row separators
 *
 * @param {*} raw
 * @param {number} w
 * @param {number} h
 * @param {number} [walkDefault]
 * @returns {Uint8Array}
 */
function parseFrictionGrid(raw, w, h, walkDefault) {
    const cols = Math.max(1, Math.floor(w));
    const rows = Math.max(1, Math.floor(h));
    const n = cols * rows;
    const out = new Uint8Array(n);
    out.fill(FRICTION_BLOCKED);

    if (raw == null) return out;

    // Flat number array
    if (Array.isArray(raw) && raw.length === n && typeof raw[0] === 'number') {
        for (let i = 0; i < n; i++) {
            out[i] = decodeFrictionCell(raw[i], walkDefault);
        }
        return out;
    }

    /** @type {string[]|number[][]} */
    let rowList;
    if (typeof raw === 'string') {
        rowList = raw
            .replace(/\r\n/g, '\n')
            .split(/[\n;]/)
            .map((r) => r.trimEnd())
            .filter((r) => r.length > 0);
    } else if (Array.isArray(raw)) {
        rowList = raw;
    } else {
        return out;
    }

    for (let y = 0; y < rows; y++) {
        const row = rowList[y];
        if (row == null) continue;
        if (typeof row === 'string') {
            for (let x = 0; x < cols; x++) {
                const ch = x < row.length ? row.charAt(x) : '#';
                out[y * cols + x] = decodeFrictionCell(ch, walkDefault);
            }
        } else if (Array.isArray(row)) {
            for (let x = 0; x < cols; x++) {
                out[y * cols + x] = decodeFrictionCell(
                    x < row.length ? row[x] : FRICTION_BLOCKED,
                    walkDefault
                );
            }
        }
    }
    return out;
}

/**
 * Normalize exit mask. Accepts {N,S,E,W}, array ["N","S"], or bitmask string "NS".
 * @param {*} raw
 * @returns {{ N: boolean, S: boolean, E: boolean, W: boolean }}
 */
function normalizeExits(raw) {
    const exits = { N: false, S: false, E: false, W: false };
    if (!raw) return exits;
    if (typeof raw === 'string') {
        const u = raw.toUpperCase();
        for (let i = 0; i < CARDINALS.length; i++) {
            const d = CARDINALS[i];
            if (u.indexOf(d) >= 0) exits[d] = true;
        }
        return exits;
    }
    if (Array.isArray(raw)) {
        for (let i = 0; i < raw.length; i++) {
            const d = String(raw[i]).toUpperCase().charAt(0);
            if (exits[d] !== undefined) exits[d] = true;
        }
        return exits;
    }
    if (typeof raw === 'object') {
        for (let i = 0; i < CARDINALS.length; i++) {
            const d = CARDINALS[i];
            const v = raw[d] != null ? raw[d] : raw[d.toLowerCase()];
            if (v === true || v === 1 || v === '1' || v === 'true') {
                exits[d] = true;
            }
        }
    }
    return exits;
}

/**
 * @param {*} raw
 * @returns {{ x: number, y: number, id?: string }[]}
 */
function normalizePointList(raw) {
    const out = [];
    const list = Array.isArray(raw) ? raw : [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || s.x == null || s.y == null) continue;
        const x = Math.floor(Number(s.x));
        const y = Math.floor(Number(s.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const row = { x, y };
        if (s.id != null) row.id = String(s.id);
        else if (s.markerId != null) row.id = String(s.markerId);
        else if (s.letter != null) row.id = String(s.letter);
        out.push(row);
    }
    return out;
}

/**
 * Normalize stair direction: up | down (null if unknown).
 * @param {*} v
 * @returns {'up'|'down'|null}
 */
function normalizeStairDir(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    if (s === 'up' || s === 'u' || s === 'ascend' || s === 'above') return 'up';
    if (s === 'down' || s === 'd' || s === 'descend' || s === 'below') {
        return 'down';
    }
    return null;
}

/**
 * Stair sockets: vertical connectors for multi-floor chains (Stage 11.8).
 * Accepts array of { x, y, dir|direction, link|linkId? }.
 *
 * @param {*} raw
 * @returns {{ x: number, y: number, dir: 'up'|'down', link: string|null }[]}
 */
function normalizeStairList(raw) {
    const out = [];
    const list = Array.isArray(raw) ? raw : [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || s.x == null || s.y == null) continue;
        const x = Math.floor(Number(s.x));
        const y = Math.floor(Number(s.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const dir = normalizeStairDir(
            s.dir != null
                ? s.dir
                : s.direction != null
                  ? s.direction
                  : s.stair
        );
        if (!dir) continue;
        const link =
            s.link != null
                ? String(s.link)
                : s.linkId != null
                  ? String(s.linkId)
                  : s.id != null
                    ? String(s.id)
                    : null;
        out.push({ x, y, dir, link });
    }
    return out;
}

/**
 * Normalize one piece definition.
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizePiece(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = raw.id != null ? String(raw.id) : null;
    if (!id) return null;

    let w = 1;
    let h = 1;
    if (raw.size && typeof raw.size === 'object') {
        w = Math.max(1, Math.floor(Number(raw.size.w) || Number(raw.size.width) || 1));
        h = Math.max(1, Math.floor(Number(raw.size.h) || Number(raw.size.height) || 1));
    } else {
        if (raw.w != null) w = Math.max(1, Math.floor(Number(raw.w) || 1));
        if (raw.h != null) h = Math.max(1, Math.floor(Number(raw.h) || 1));
        if (raw.width != null) w = Math.max(1, Math.floor(Number(raw.width) || 1));
        if (raw.height != null) h = Math.max(1, Math.floor(Number(raw.height) || 1));
    }

    // Infer size from friction rows when size omitted / undersized
    const frictionRaw = raw.friction;
    if (Array.isArray(frictionRaw) && frictionRaw.length) {
        const row0 = frictionRaw[0];
        if (typeof row0 === 'string') {
            h = Math.max(h, frictionRaw.length);
            w = Math.max(w, row0.length);
            for (let i = 1; i < frictionRaw.length; i++) {
                if (typeof frictionRaw[i] === 'string') {
                    w = Math.max(w, frictionRaw[i].length);
                }
            }
        } else if (Array.isArray(row0)) {
            h = Math.max(h, frictionRaw.length);
            w = Math.max(w, row0.length);
        }
    } else if (typeof frictionRaw === 'string' && frictionRaw.length) {
        const lines = frictionRaw
            .replace(/\r\n/g, '\n')
            .split(/[\n;]/)
            .filter((r) => r.length > 0);
        if (lines.length) {
            h = Math.max(h, lines.length);
            for (let i = 0; i < lines.length; i++) {
                w = Math.max(w, lines[i].length);
            }
        }
    }

    const walkDefault =
        numOrNull(raw.walkFriction) != null
            ? Number(raw.walkFriction)
            : numOrNull(raw.defaultFriction) != null
              ? Number(raw.defaultFriction)
              : DEFAULT_WALK_FRICTION;

    const friction = parseFrictionGrid(frictionRaw, w, h, walkDefault);
    const exits = normalizeExits(raw.exits != null ? raw.exits : raw.exitsMask);

    const socketsRaw =
        raw.sockets && typeof raw.sockets === 'object' ? raw.sockets : {};
    const sockets = {
        spawns: normalizePointList(
            socketsRaw.spawns != null ? socketsRaw.spawns : raw.spawns
        ),
        markers: normalizePointList(
            socketsRaw.markers != null ? socketsRaw.markers : raw.markers
        ),
        waypoints: normalizePointList(
            socketsRaw.waypoints != null ? socketsRaw.waypoints : raw.waypoints
        ),
        // Stage 11.8: vertical connectors for multi-floor biome chains
        stairs: normalizeStairList(
            socketsRaw.stairs != null
                ? socketsRaw.stairs
                : socketsRaw.stair != null
                  ? socketsRaw.stair
                  : raw.stairs
        )
    };

    const tags = Array.isArray(raw.tags)
        ? raw.tags.map((t) => String(t)).filter(Boolean)
        : [];

    return {
        id,
        biome: raw.biome != null ? String(raw.biome) : null,
        size: { w, h },
        exits,
        friction,
        sockets,
        tags,
        walkFriction: walkDefault | 0
    };
}

/**
 * Normalize a piece pack (file or inline).
 * Accepts `{ id, pieces: [...] }` or `{ id, pieces: { id: piece } }`.
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizePiecePack(raw) {
    if (!raw || typeof raw !== 'object') return null;

    /** @type {Record<string, object>} */
    const byId = Object.create(null);
    /** @type {object[]} */
    const list = [];

    const src = raw.pieces != null ? raw.pieces : raw.tiles;
    if (Array.isArray(src)) {
        for (let i = 0; i < src.length; i++) {
            const p = normalizePiece(src[i]);
            if (!p) continue;
            byId[p.id] = p;
            list.push(p);
        }
    } else if (src && typeof src === 'object') {
        const keys = Object.keys(src);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            const row = src[key];
            const withId =
                row && typeof row === 'object' && row.id == null
                    ? Object.assign({ id: key }, row)
                    : row;
            const p = normalizePiece(withId);
            if (!p) continue;
            byId[p.id] = p;
            list.push(p);
        }
    }

    // Bare single piece object
    if (!list.length && raw.id && (raw.friction != null || raw.size)) {
        const p = normalizePiece(raw);
        if (p) {
            byId[p.id] = p;
            list.push(p);
        }
    }

    if (!list.length) return null;

    return {
        id: raw.id != null ? String(raw.id) : null,
        biome: raw.biome != null ? String(raw.biome) : null,
        notes: raw.notes != null ? String(raw.notes) : null,
        pieces: list,
        byId
    };
}

/**
 * Whether pieceA can connect to pieceB in direction `dir` from A toward B.
 * e.g. canConnect(a, 'S', b) when a has S exit and b has N exit.
 * @param {object} pieceA normalized
 * @param {string} dir N|S|E|W
 * @param {object} pieceB normalized
 * @returns {boolean}
 */
function canConnect(pieceA, dir, pieceB) {
    if (!pieceA || !pieceB) return false;
    const d = String(dir || '').toUpperCase();
    const opp = OPPOSITE[d];
    if (!opp) return false;
    const aEx = pieceA.exits || normalizeExits(null);
    const bEx = pieceB.exits || normalizeExits(null);
    return aEx[d] === true && bEx[opp] === true;
}

/**
 * List directions where two pieces mutually match (A exit ↔ B opposite).
 * @param {object} pieceA
 * @param {object} pieceB
 * @returns {string[]} directions from A toward B that work
 */
function matchingDirections(pieceA, pieceB) {
    const out = [];
    for (let i = 0; i < CARDINALS.length; i++) {
        const d = CARDINALS[i];
        if (canConnect(pieceA, d, pieceB)) out.push(d);
    }
    return out;
}

/**
 * True if piece has no exits (solid) or only one exit (dead-end candidate).
 * @param {object} piece
 * @returns {{ openCount: number, deadEnd: boolean, open: string[] }}
 */
function exitSummary(piece) {
    const ex = (piece && piece.exits) || normalizeExits(null);
    const open = [];
    for (let i = 0; i < CARDINALS.length; i++) {
        if (ex[CARDINALS[i]]) open.push(CARDINALS[i]);
    }
    return {
        openCount: open.length,
        deadEnd: open.length <= 1,
        open
    };
}

/**
 * Filter pieces by tag(s). All tags must match (AND).
 * @param {object[]} pieces
 * @param {string|string[]} tags
 * @returns {object[]}
 */
function filterByTags(pieces, tags) {
    const need = Array.isArray(tags)
        ? tags.map((t) => String(t))
        : tags != null
          ? [String(tags)]
          : [];
    if (!need.length) return (pieces || []).slice();
    const list = Array.isArray(pieces) ? pieces : [];
    return list.filter((p) => {
        const have = p.tags || [];
        for (let i = 0; i < need.length; i++) {
            if (have.indexOf(need[i]) < 0) return false;
        }
        return true;
    });
}

/**
 * Filter pieces that have all listed exits open.
 * @param {object[]} pieces
 * @param {string|string[]} dirs
 * @returns {object[]}
 */
function filterByExits(pieces, dirs) {
    const need = Array.isArray(dirs)
        ? dirs.map((d) => String(d).toUpperCase())
        : dirs != null
          ? [String(dirs).toUpperCase()]
          : [];
    const list = Array.isArray(pieces) ? pieces : [];
    if (!need.length) return list.slice();
    return list.filter((p) => {
        const ex = p.exits || normalizeExits(null);
        for (let i = 0; i < need.length; i++) {
            if (!ex[need[i]]) return false;
        }
        return true;
    });
}

/**
 * Encode friction Uint8Array back to row strings for debug/export.
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {number} [walkDefault]
 * @returns {string[]}
 */
function frictionToRowStrings(friction, cols, rows, walkDefault) {
    const walk =
        walkDefault != null ? walkDefault | 0 : DEFAULT_WALK_FRICTION;
    const out = [];
    for (let y = 0; y < rows; y++) {
        let s = '';
        for (let x = 0; x < cols; x++) {
            const f = friction[y * cols + x];
            if (f === FRICTION_BLOCKED) s += '#';
            else if (f === walk) s += '.';
            else if (f === 0) s += '+';
            else if (f >= 0 && f <= 15) s += f.toString(16);
            else s += '.';
        }
        out.push(s);
    }
    return out;
}

module.exports = {
    DEFAULT_WALK_FRICTION,
    CARDINALS,
    OPPOSITE,
    FRICTION_BLOCKED,
    decodeFrictionCell,
    parseFrictionGrid,
    normalizeExits,
    normalizePointList,
    normalizeStairDir,
    normalizeStairList,
    normalizePiece,
    normalizePiecePack,
    canConnect,
    matchingDirections,
    exitSummary,
    filterByTags,
    filterByExits,
    frictionToRowStrings
};
