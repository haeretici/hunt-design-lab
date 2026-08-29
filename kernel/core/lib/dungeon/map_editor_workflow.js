/**
 * Map editor P2 workflow helpers (goto, find, eyedrop, spawn clipboard, minimap).
 * Pure — no DOM. Wiki page wires tools; session.sampleCellAt samples stamps.
 */

'use strict';

const {
    resolveCreatureSpawnId,
    makeEditorSpawnPin,
    slugifyCreatureId
} = require('../content/spawn_rows.js');
const { hasNpcIdentity } = require('../npc/flags.js');
const { FRICTION_BLOCKED } = require('./tile_roles.js');
const worldPins = require('./world_pins.js');

const MINIMAP_DEFAULT_W = 248;
const MINIMAP_DEFAULT_H = 198;
const FIND_ISSUE_EMPTY = 'empty';
const FIND_ISSUE_UNKNOWN = 'unknown';
const FIND_ISSUE_BLOCKED = 'blocked';
const FIND_ISSUE_OK = 'ok';

/**
 * @param {*} v
 * @returns {number|null}
 */
function finiteInt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
}

/**
 * Parse a goto box: "x,y" / "x,y,z" / "x y z" or a creature search string.
 * @param {string} text
 * @returns {{ kind: 'xyz', x: number, y: number, z?: number }|{ kind: 'search', query: string }|null}
 */
function parseGotoQuery(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const compact = s.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
    const kv = compact.match(
        /^(?:x\s*=\s*)?(-?\d+)\s+(?:y\s*=\s*)?(-?\d+)(?:\s+(?:z\s*=\s*)?(-?\d+))?$/i
    );
    if (kv) {
        const x = Number(kv[1]);
        const y = Number(kv[2]);
        const out = { kind: 'xyz', x, y };
        if (kv[3] != null && kv[3] !== '') out.z = Number(kv[3]);
        return out;
    }
    return { kind: 'search', query: s };
}

/**
 * Stable pin fingerprint for "modified since load".
 * @param {object|null|undefined} spawn
 * @returns {string}
 */
function spawnPinSignature(spawn) {
    if (!spawn || typeof spawn !== 'object') return '';
    const x = finiteInt(spawn.x);
    const y = finiteInt(spawn.y);
    const z = spawn.z != null ? finiteInt(spawn.z) : '';
    const respawn = spawn.respawn != null ? finiteInt(spawn.respawn) : '';
    return [
        String(spawn.creatureId || ''),
        x == null ? '' : x,
        y == null ? '' : y,
        z == null ? '' : z,
        respawn == null ? '' : respawn,
        spawn.dir ? String(spawn.dir) : ''
    ].join('|');
}

/**
 * Stamp `_origSig` on each pin (editor-only; save strips extras).
 * @param {object[]} spawns
 * @returns {object[]}
 */
function markSpawnBaseline(spawns) {
    const list = Array.isArray(spawns) ? spawns : [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || typeof s !== 'object') continue;
        s._origSig = spawnPinSignature(s);
    }
    return list;
}

/**
 * New pins (no `_origSig`) and edited pins (signature drift) count as modified.
 * @param {object|null|undefined} spawn
 * @returns {boolean}
 */
function isModifiedSpawn(spawn) {
    if (!spawn || typeof spawn !== 'object') return false;
    if (spawn._origSig == null || spawn._origSig === '') return true;
    return spawnPinSignature(spawn) !== spawn._origSig;
}

/**
 * @param {object|null|undefined} spawn
 * @param {Record<string, object>|null|undefined} presets
 * @returns {object|null}
 */
function spawnTemplate(spawn, presets) {
    if (!spawn || !presets || typeof presets !== 'object') return null;
    const raw = spawn.creatureId || spawn.id || spawn.name;
    if (raw && presets[raw]) return presets[raw];
    const id = resolveCreatureSpawnId(raw, presets);
    return (id && presets[id]) || null;
}

/**
 * Talkable / NPC identity comes from the template (P1 layer is a filter, not a type).
 * @param {object|null|undefined} spawn
 * @param {Record<string, object>|null|undefined} presets
 * @returns {boolean}
 */
function spawnIsNpc(spawn, presets) {
    if (hasNpcIdentity(spawn)) return true;
    return hasNpcIdentity(spawnTemplate(spawn, presets));
}

/**
 * @param {object|null|undefined} spawn
 * @param {string} query
 * @param {Record<string, object>|null|undefined} presets
 * @returns {boolean}
 */
function spawnMatchesQuery(spawn, query, presets) {
    if (!query) return true;
    if (!spawn) return false;
    const q = String(query).trim().toLowerCase();
    if (!q) return true;
    const id = String(spawn.creatureId || '').toLowerCase();
    if (id && id.indexOf(q) !== -1) return true;
    const slug = slugifyCreatureId(query);
    if (slug && slug !== 'unknown' && id && (id === slug || id.indexOf(slug) !== -1)) {
        return true;
    }
    const tpl = spawnTemplate(spawn, presets);
    const label = tpl && tpl.label != null ? String(tpl.label).toLowerCase() : '';
    if (label && label.indexOf(q) !== -1) return true;
    const legacy = spawn.legacyName != null ? String(spawn.legacyName).toLowerCase() : '';
    if (legacy && legacy.indexOf(q) !== -1) return true;
    return false;
}

/**
 * @param {object|null|undefined} spawn
 * @param {{
 *   presets?: Record<string, object>,
 *   friction?: Uint8Array|number[]|null,
 *   cols?: number,
 *   rows?: number,
 *   blocked?: number
 * }} [opts]
 * @returns {'empty'|'unknown'|'blocked'|'ok'}
 */
function classifySpawnPin(spawn, opts) {
    const o = opts || {};
    if (!spawn || typeof spawn !== 'object') return FIND_ISSUE_EMPTY;
    const raw = spawn.creatureId || spawn.id || spawn.name;
    if (raw == null || String(raw).trim() === '') return FIND_ISSUE_EMPTY;
    const presets = o.presets && typeof o.presets === 'object' ? o.presets : {};
    const id = resolveCreatureSpawnId(raw, presets);
    if (!presets[id] && !presets[String(raw)]) return FIND_ISSUE_UNKNOWN;
    const friction = o.friction;
    const cols = o.cols | 0;
    const rows = o.rows | 0;
    if (friction && cols > 0 && rows > 0) {
        const x = finiteInt(spawn.x);
        const y = finiteInt(spawn.y);
        if (x != null && y != null && x >= 0 && y >= 0 && x < cols && y < rows) {
            const blocked = o.blocked != null ? o.blocked & 0xff : FRICTION_BLOCKED;
            if ((friction[y * cols + x] & 0xff) === blocked) return FIND_ISSUE_BLOCKED;
        }
    }
    return FIND_ISSUE_OK;
}

/**
 * @param {object[]} spawns
 * @param {{
 *   query?: string,
 *   onlyNpcs?: boolean,
 *   onlyModified?: boolean,
 *   issue?: string,
 *   presets?: Record<string, object>,
 *   friction?: Uint8Array|number[]|null,
 *   cols?: number,
 *   rows?: number,
 *   blocked?: number
 * }} [opts]
 * @returns {object[]}
 */
function filterEditorSpawns(spawns, opts) {
    const list = Array.isArray(spawns) ? spawns : [];
    const o = opts || {};
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s) continue;
        if (o.query && !spawnMatchesQuery(s, o.query, o.presets)) continue;
        if (o.onlyNpcs && !spawnIsNpc(s, o.presets)) continue;
        if (o.onlyModified && !isModifiedSpawn(s)) continue;
        if (o.issue) {
            const issue = classifySpawnPin(s, o);
            if (o.issue === FIND_ISSUE_UNKNOWN) {
                if (issue !== FIND_ISSUE_UNKNOWN && issue !== FIND_ISSUE_EMPTY) continue;
            } else if (issue !== o.issue) {
                continue;
            }
        }
        out.push(s);
    }
    return out;
}

/**
 * @param {object[]} spawns
 * @param {string} query
 * @param {Record<string, object>|null|undefined} presets
 * @returns {object[]}
 */
function searchSpawns(spawns, query, presets) {
    return filterEditorSpawns(spawns, { query, presets });
}

/**
 * Scan one or more floors for find hits.
 * @param {Array<{ floor: string|number, spawns: object[] }>} floors
 * @param {{
 *   query?: string,
 *   issue?: string,
 *   presets?: Record<string, object>,
 *   frictionForFloor?: function(string|number): { friction: Uint8Array|number[], cols: number, rows: number }|null
 * }} [opts]
 * @returns {Array<{ floor: string|number, spawn: object, issue: string }>}
 */
function findSpawnHits(floors, opts) {
    const bags = Array.isArray(floors) ? floors : [];
    const o = opts || {};
    const hits = [];
    for (let b = 0; b < bags.length; b++) {
        const bag = bags[b];
        if (!bag) continue;
        const rows = Array.isArray(bag.spawns) ? bag.spawns : [];
        let classOpts = o;
        if (typeof o.frictionForFloor === 'function') {
            const ch = o.frictionForFloor(bag.floor);
            classOpts = Object.assign({}, o, ch || {});
        }
        for (let i = 0; i < rows.length; i++) {
            const s = rows[i];
            if (!s) continue;
            if (o.query && !spawnMatchesQuery(s, o.query, o.presets)) continue;
            const issue = classifySpawnPin(s, classOpts);
            if (o.issue) {
                if (o.issue === FIND_ISSUE_UNKNOWN) {
                    if (issue !== FIND_ISSUE_UNKNOWN && issue !== FIND_ISSUE_EMPTY) continue;
                } else if (issue !== o.issue) {
                    continue;
                }
            }
            hits.push({ floor: bag.floor, spawn: s, issue });
        }
    }
    return hits;
}

/**
 * Relative clipboard. Origin = min x/y of the selection.
 * @param {object[]} spawns
 * @returns {{ origin: { x: number, y: number }, pins: object[] }|null}
 */
function copySpawnPins(spawns) {
    const list = (Array.isArray(spawns) ? spawns : []).filter(
        (s) => s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y))
    );
    if (!list.length) return null;
    let ox = Infinity;
    let oy = Infinity;
    for (let i = 0; i < list.length; i++) {
        const x = Math.round(Number(list[i].x));
        const y = Math.round(Number(list[i].y));
        if (x < ox) ox = x;
        if (y < oy) oy = y;
    }
    const pins = [];
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        const pin = {
            creatureId: s.creatureId || s.id || s.name,
            dx: Math.round(Number(s.x)) - ox,
            dy: Math.round(Number(s.y)) - oy
        };
        if (s.respawn != null) pin.respawn = Math.max(0, Number(s.respawn) || 0);
        if (s.dir) pin.dir = String(s.dir);
        pins.push(pin);
    }
    return { origin: { x: ox, y: oy }, pins };
}

/**
 * @param {{ pins: object[] }|null|undefined} clip
 * @param {{ x: number, y: number, z?: number }} dest
 * @param {Record<string, object>|null|undefined} presets
 * @returns {object[]}
 */
function pasteSpawnPins(clip, dest, presets) {
    if (!clip || !Array.isArray(clip.pins) || !clip.pins.length) return [];
    const dx0 = dest && dest.x != null ? Math.round(Number(dest.x)) : 0;
    const dy0 = dest && dest.y != null ? Math.round(Number(dest.y)) : 0;
    if (!Number.isFinite(dx0) || !Number.isFinite(dy0)) return [];
    const z = dest && dest.z != null ? Number(dest.z) : 0;
    const out = [];
    for (let i = 0; i < clip.pins.length; i++) {
        const p = clip.pins[i];
        if (!p) continue;
        const pin = makeEditorSpawnPin(
            {
                creatureId: p.creatureId,
                x: dx0 + (Number(p.dx) || 0),
                y: dy0 + (Number(p.dy) || 0),
                z,
                respawn: p.respawn,
                dir: p.dir
            },
            presets,
            { z, respawn: p.respawn }
        );
        if (pin) {
            if (p.dir) pin.dir = String(p.dir);
            out.push(pin);
        }
    }
    return out;
}

/**
 * Last pin whose rounded tile equals (x, y).
 * @param {object[]} spawns
 * @param {number} x
 * @param {number} y
 * @returns {object|null}
 */
function spawnAtTile(spawns, x, y) {
    const list = Array.isArray(spawns) ? spawns : [];
    const tx = Math.floor(Number(x));
    const ty = Math.floor(Number(y));
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
        const s = list[i];
        if (!s) continue;
        if (Math.round(Number(s.x)) === tx && Math.round(Number(s.y)) === ty) return s;
    }
    return null;
}

/**
 * @param {number} mapX
 * @param {number} mapY
 * @param {number} cols
 * @param {number} rows
 * @param {number} destW
 * @param {number} destH
 * @returns {{ x: number, y: number }}
 */
function mapToMinimap(mapX, mapY, cols, rows, destW, destH) {
    const c = Math.max(1, cols | 0);
    const r = Math.max(1, rows | 0);
    const w = Math.max(1, destW | 0);
    const h = Math.max(1, destH | 0);
    return {
        x: Math.min(w - 1, Math.max(0, Math.floor((Number(mapX) / c) * w))),
        y: Math.min(h - 1, Math.max(0, Math.floor((Number(mapY) / r) * h)))
    };
}

/**
 * @param {number} px
 * @param {number} py
 * @param {number} cols
 * @param {number} rows
 * @param {number} destW
 * @param {number} destH
 * @returns {{ x: number, y: number }}
 */
function minimapToMap(px, py, cols, rows, destW, destH) {
    const c = Math.max(1, cols | 0);
    const r = Math.max(1, rows | 0);
    const w = Math.max(1, destW | 0);
    const h = Math.max(1, destH | 0);
    return {
        x: Math.min(c - 1, Math.max(0, Math.floor((Number(px) / w) * c))),
        y: Math.min(r - 1, Math.max(0, Math.floor((Number(py) / h) * r)))
    };
}

function writeRgba(rgba, i, r, g, b, a) {
    const p = i * 4;
    rgba[p] = r;
    rgba[p + 1] = g;
    rgba[p + 2] = b;
    rgba[p + 3] = a;
}

function strokeRect(rgba, destW, destH, x0, y0, x1, y1, r, g, b) {
    const xa = Math.max(0, Math.min(destW - 1, x0 | 0));
    const xb = Math.max(0, Math.min(destW - 1, x1 | 0));
    const ya = Math.max(0, Math.min(destH - 1, y0 | 0));
    const yb = Math.max(0, Math.min(destH - 1, y1 | 0));
    for (let x = xa; x <= xb; x++) {
        writeRgba(rgba, ya * destW + x, r, g, b, 255);
        writeRgba(rgba, yb * destW + x, r, g, b, 255);
    }
    for (let y = ya; y <= yb; y++) {
        writeRgba(rgba, y * destW + xa, r, g, b, 255);
        writeRgba(rgba, y * destW + xb, r, g, b, 255);
    }
}

/**
 * Downsampled friction + spawn dots + optional viewport box.
 * @param {Uint8ClampedArray|Uint8Array} rgba destW*destH*4
 * @param {{
 *   cols: number,
 *   rows: number,
 *   friction?: Uint8Array|number[]|null,
 *   destW?: number,
 *   destH?: number,
 *   spawns?: object[],
 *   world?: object[],
 *   presets?: Record<string, object>,
 *   viewRect?: { x: number, y: number, w: number, h: number }|null,
 *   blocked?: number
 * }} opts
 * @returns {Uint8ClampedArray|Uint8Array}
 */
function fillMinimapRgba(rgba, opts) {
    const o = opts || {};
    const cols = Math.max(1, o.cols | 0);
    const rows = Math.max(1, o.rows | 0);
    const destW = Math.max(1, o.destW != null ? o.destW | 0 : MINIMAP_DEFAULT_W);
    const destH = Math.max(1, o.destH != null ? o.destH | 0 : MINIMAP_DEFAULT_H);
    const n = destW * destH;
    const blocked = o.blocked != null ? o.blocked & 0xff : FRICTION_BLOCKED;
    const friction = o.friction;
    for (let i = 0; i < n; i++) {
        const mx = Math.min(cols - 1, Math.floor(((i % destW) / destW) * cols));
        const my = Math.min(rows - 1, Math.floor((Math.floor(i / destW) / destH) * rows));
        let r = 28;
        let g = 28;
        let b = 32;
        if (friction && friction.length >= cols * rows) {
            const v = friction[my * cols + mx] & 0xff;
            if (v === blocked) {
                r = 70;
                g = 62;
                b = 18;
            } else {
                const t = 18 + Math.floor((250 - Math.min(250, v)) * 0.12);
                r = t;
                g = t + 4;
                b = t + 8;
            }
        }
        writeRgba(rgba, i, r, g, b, 255);
    }
    const vr = o.viewRect;
    if (vr && Number.isFinite(Number(vr.w)) && Number.isFinite(Number(vr.h))) {
        const a = mapToMinimap(vr.x, vr.y, cols, rows, destW, destH);
        const b = mapToMinimap(vr.x + vr.w, vr.y + vr.h, cols, rows, destW, destH);
        strokeRect(rgba, destW, destH, a.x, a.y, b.x, b.y, 230, 230, 230);
    }
    const spawns = Array.isArray(o.spawns) ? o.spawns : [];
    for (let s = 0; s < spawns.length; s++) {
        const pin = spawns[s];
        if (!pin) continue;
        const x = finiteInt(pin.x);
        const y = finiteInt(pin.y);
        if (x == null || y == null) continue;
        const p = mapToMinimap(x, y, cols, rows, destW, destH);
        const npc = spawnIsNpc(pin, o.presets);
        const idx = p.y * destW + p.x;
        if (npc) writeRgba(rgba, idx, 68, 221, 238, 255);
        else writeRgba(rgba, idx, 220, 96, 48, 255);
    }
    const world = Array.isArray(o.world) ? o.world : [];
    for (let w = 0; w < world.length; w++) {
        const pin = world[w];
        if (!pin) continue;
        const x = finiteInt(pin.x);
        const y = finiteInt(pin.y);
        if (x == null || y == null) continue;
        const p = mapToMinimap(x, y, cols, rows, destW, destH);
        writeRgba(rgba, p.y * destW + p.x, 80, 220, 110, 255);
    }
    return rgba;
}

module.exports = {
    MINIMAP_DEFAULT_W,
    MINIMAP_DEFAULT_H,
    FIND_ISSUE_EMPTY,
    FIND_ISSUE_UNKNOWN,
    FIND_ISSUE_BLOCKED,
    FIND_ISSUE_OK,
    parseGotoQuery,
    spawnPinSignature,
    markSpawnBaseline,
    isModifiedSpawn,
    spawnTemplate,
    spawnIsNpc,
    spawnMatchesQuery,
    classifySpawnPin,
    filterEditorSpawns,
    searchSpawns,
    findSpawnHits,
    copySpawnPins,
    pasteSpawnPins,
    spawnAtTile,
    mapToMinimap,
    minimapToMap,
    fillMinimapRgba,
    worldPins,
    WORLD_KINDS: worldPins.WORLD_KINDS,
    DEFAULT_CONTAINER_CAPACITY: worldPins.DEFAULT_CONTAINER_CAPACITY,
    slugifyWorldId: worldPins.slugifyWorldId,
    parseWorldRows: worldPins.parseWorldRows,
    loadFloorWorldFromDocs: worldPins.loadFloorWorldFromDocs,
    normalizeWorldPin: worldPins.normalizeWorldPin,
    normalizeWorldList: worldPins.normalizeWorldList,
    makeEditorWorldPin: worldPins.makeEditorWorldPin,
    stripWorldListForSave: worldPins.stripWorldListForSave,
    worldPinSignature: worldPins.worldPinSignature,
    markWorldBaseline: worldPins.markWorldBaseline,
    isModifiedWorld: worldPins.isModifiedWorld,
    worldPinAtTile: worldPins.worldPinAtTile,
    worldMatchesQuery: worldPins.worldMatchesQuery,
    classifyWorldPin: worldPins.classifyWorldPin,
    filterEditorWorld: worldPins.filterEditorWorld,
    findWorldHits: worldPins.findWorldHits,
    copyWorldPins: worldPins.copyWorldPins,
    pasteWorldPins: worldPins.pasteWorldPins,
    planWorldFloorMove: worldPins.planWorldFloorMove,
    applyWorldFloorMove: worldPins.applyWorldFloorMove
};
