/**
 * Hunt AI debug canvas overlays (FSM states, paths, targets, ranges, spawns,
 * combat VFX hit sources, tile types).
 *
 * Dev-only: all flags default false. No-ops when Settings.HEADLESS or master
 * enabled is false. Drawn from Simulator.onGUIAll after entity markers / FCT.
 * Tile space → screen via camera origin + tileWidth/tileHeight (no soccer projections).
 */

'use strict';

const { Settings } = require('../../settings.js');
const { getVisualTilePos } = require('./movement.js');

/** Default debugAI flags (production: all off). Hunt domain only. */
const DEBUG_AI_DEFAULTS = {
    enabled: false,
    states: false,
    paths: false,
    targets: false,
    ranges: false,
    spawns: false,
    /** Mark combat VFX hit sources (attacker tile) for active animation frames */
    hitSources: false,
    /**
     * Color-code collision/art roles per tile in the viewport:
     * floor (walkable), wall (blocked edge), void (blocked interior), stairs.
     */
    tileTypes: false
};

const DEBUG_AI_FLAG_KEYS = Object.keys(DEBUG_AI_DEFAULTS);

/**
 * Ensure Settings.debugAI exists with defaults.
 * @returns {typeof DEBUG_AI_DEFAULTS}
 */
function ensureDebugAI() {
    if (!Settings.debugAI || typeof Settings.debugAI !== 'object') {
        Settings.debugAI = Object.assign({}, DEBUG_AI_DEFAULTS);
    } else {
        for (const [k, v] of Object.entries(DEBUG_AI_DEFAULTS)) {
            if (Settings.debugAI[k] === undefined) Settings.debugAI[k] = v;
        }
    }
    return Settings.debugAI;
}

/**
 * Pure merge of a patch onto defaults / existing (no Settings mutation).
 * @param {object|null|undefined} base
 * @param {object|null|undefined} patch
 * @returns {typeof DEBUG_AI_DEFAULTS}
 */
function mergeDebugAI(base, patch) {
    const out = Object.assign({}, DEBUG_AI_DEFAULTS);
    if (base && typeof base === 'object') {
        for (const k of DEBUG_AI_FLAG_KEYS) {
            if (typeof base[k] === 'boolean') out[k] = base[k];
        }
    }
    if (patch && typeof patch === 'object') {
        for (const k of DEBUG_AI_FLAG_KEYS) {
            if (typeof patch[k] === 'boolean') out[k] = patch[k];
        }
    }
    return out;
}

/**
 * Apply a debugAI patch onto Settings (source of truth).
 * @param {object|null|undefined} patch
 * @returns {typeof DEBUG_AI_DEFAULTS}
 */
function applyDebugAIPatch(patch) {
    const next = mergeDebugAI(ensureDebugAI(), patch);
    Settings.debugAI = next;
    return next;
}

/**
 * Snapshot for postMessage state (plain object, no shared refs).
 * @returns {typeof DEBUG_AI_DEFAULTS}
 */
function snapshotDebugAI() {
    return Object.assign({}, ensureDebugAI());
}

/**
 * @returns {boolean}
 */
function isAiDebugActive() {
    if (Settings.HEADLESS) return false;
    const d = ensureDebugAI();
    if (!d.enabled) return false;
    return !!(
        d.states ||
        d.paths ||
        d.targets ||
        d.ranges ||
        d.spawns ||
        d.hitSources ||
        d.tileTypes
    );
}

/**
 * Floor currently painted by TileMap (or camera fallback).
 * @param {object|null} sim
 * @returns {string|null}
 */
function resolveViewZ(sim) {
    const map = sim && sim.tileMap;
    if (map && map._viewZ != null) return String(map._viewZ);
    if (Settings.cameraTileZ != null) return String(Settings.cameraTileZ);
    return null;
}

/**
 * @param {string|number|null|undefined} z
 * @param {string|null} viewZ
 * @returns {boolean}
 */
function matchesViewZ(z, viewZ) {
    if (viewZ == null) return true;
    if (z === undefined || z === null) return true;
    return String(z) === viewZ;
}

/**
 * @param {object|null} sim
 * @returns {{ ox: number, oy: number, tw: number, th: number, viewCols: number, viewRows: number, viewZ: string|null }}
 */
function viewParams(sim) {
    const map = sim && sim.tileMap;
    return {
        ox: (map && map._viewOriginX) || 0,
        oy: (map && map._viewOriginY) || 0,
        tw: Settings.tileWidth || 32,
        th: Settings.tileHeight || 32,
        viewCols: (map && map._viewCols) || 64,
        viewRows: (map && map._viewRows) || 40,
        viewZ: resolveViewZ(sim)
    };
}

/**
 * Tile center → canvas pixels.
 * @param {number} tileX
 * @param {number} tileY
 * @param {{ ox: number, oy: number, tw: number, th: number }} vp
 * @returns {{ x: number, y: number }}
 */
function tileToScreen(tileX, tileY, vp) {
    return {
        x: (tileX - vp.ox + 0.5) * vp.tw,
        y: (tileY - vp.oy + 0.5) * vp.th
    };
}

/**
 * @param {{ x: number, y: number }|null|undefined} tile
 * @param {{ ox: number, oy: number, viewCols: number, viewRows: number }} vp
 * @returns {boolean}
 */
function tileInView(tile, vp) {
    if (!tile) return false;
    const vx = tile.x - vp.ox;
    const vy = tile.y - vp.oy;
    // Pad so edges of large range circles still draw when center is near edge
    return vx >= -8 && vy >= -8 && vx < vp.viewCols + 8 && vy < vp.viewRows + 8;
}

/**
 * Collect living players + creatures with tiles on the current view floor.
 * @param {object} sim
 * @param {string|null} [viewZ]
 * @returns {object[]}
 */
function collectEntities(sim, viewZ) {
    const vz = viewZ !== undefined ? viewZ : resolveViewZ(sim);
    const out = [];
    const parties = sim.parties || [];
    for (let p = 0; p < parties.length; p++) {
        const members = parties[p].members || [];
        for (let m = 0; m < members.length; m++) {
            const ent = members[m];
            if (!ent || ent.alive === false || !ent.tile) continue;
            if (!matchesViewZ(ent.tile.z, vz)) continue;
            out.push(ent);
        }
    }
    const creatures = sim.creatures || [];
    for (let i = 0; i < creatures.length; i++) {
        const c = creatures[i];
        if (!c || c.alive === false || !c.tile) continue;
        if (!matchesViewZ(c.tile.z, vz)) continue;
        out.push(c);
    }
    return out;
}

function drawLabel(g, sx, sy, text, fill, font) {
    g.save();
    g.font = font || '10px monospace';
    g.fillStyle = fill || '#fff';
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.lineWidth = 3;
    g.strokeText(text, sx + 4, sy - 6);
    g.fillText(text, sx + 4, sy - 6);
    g.restore();
}

function drawLineScreen(g, x0, y0, x1, y1, stroke, lineWidth, alpha) {
    g.save();
    g.globalAlpha = alpha != null ? alpha : 1;
    g.beginPath();
    g.strokeStyle = stroke;
    g.lineWidth = lineWidth != null ? lineWidth : 1.5;
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.restore();
}

/** Named range box kinds shown by the Ranges overlay (and legend). */
const RANGE_BOX_INFO = {
    engage: {
        name: 'engage',
        stroke: 'rgba(0, 220, 255, 0.55)',
        label: 'rgba(0, 220, 255, 0.95)',
        blurb: 'player engage (start fight)'
    },
    aggro: {
        name: 'aggro',
        stroke: 'rgba(255, 100, 80, 0.55)',
        label: 'rgba(255, 140, 120, 0.95)',
        blurb: 'creature aggro (detect player)'
    },
    leash: {
        name: 'leash',
        stroke: 'rgba(255, 200, 80, 0.45)',
        label: 'rgba(255, 210, 100, 0.95)',
        blurb: 'creature leash (return home)'
    }
};

/**
 * Chebyshev radius as a square (tile footprint outline), with optional name tag.
 * @param {CanvasRenderingContext2D} g
 * @param {number} cx tile center x
 * @param {number} cy tile center y
 * @param {number} radiusTiles
 * @param {{ ox: number, oy: number, tw: number, th: number }} vp
 * @param {string} stroke
 * @param {string} [boxName] short name drawn on the box edge (engage / aggro / leash)
 * @param {string} [labelFill]
 */
function drawRangeSquare(g, cx, cy, radiusTiles, vp, stroke, boxName, labelFill) {
    if (!(radiusTiles > 0)) return;
    const half = radiusTiles + 0.5;
    const left = (cx - half - vp.ox) * vp.tw;
    const top = (cy - half - vp.oy) * vp.th;
    const size = half * 2 * vp.tw;
    const sizeY = half * 2 * vp.th;
    g.save();
    g.beginPath();
    g.strokeStyle = stroke;
    g.lineWidth = 1;
    g.globalAlpha = 0.85;
    g.strokeRect(left, top, size, sizeY);
    g.restore();

    if (boxName) {
        // Top-left of the square edge so overlapping entities stay readable
        const tag = `${boxName} r${radiusTiles}`;
        drawLabel(g, left, top + 10, tag, labelFill || stroke, '8px monospace');
    }
}

/**
 * Corner legend for Ranges overlay — color → box name + meaning.
 * @param {CanvasRenderingContext2D} g
 */
function drawRangesLegend(g) {
    const lines = [
        { key: 'engage', text: 'engage — player start-fight range' },
        { key: 'aggro', text: 'aggro — creature detect range' },
        { key: 'leash', text: 'leash — creature home leash (from home)' }
    ];
    const padX = 8;
    const padY = 10;
    const lineH = 12;
    const title = 'Ranges';
    g.save();
    g.font = '9px monospace';
    // Soft panel behind legend
    const boxW = 220;
    const boxH = padY + lineH + lines.length * lineH + 6;
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(4, 4, boxW, boxH);
    g.strokeStyle = 'rgba(180, 180, 180, 0.35)';
    g.lineWidth = 1;
    g.strokeRect(4, 4, boxW, boxH);

    g.fillStyle = 'rgba(220, 220, 220, 0.95)';
    g.fillText(title, padX, padY + 8);
    for (let i = 0; i < lines.length; i++) {
        const info = RANGE_BOX_INFO[lines[i].key];
        const y = padY + 8 + (i + 1) * lineH;
        g.fillStyle = info.label;
        g.fillText(lines[i].text, padX, y);
    }
    g.restore();
}

function drawStates(g, entities, vp) {
    for (let i = 0; i < entities.length; i++) {
        const ent = entities[i];
        const vis = getVisualTilePos(ent) || ent.tile;
        if (!tileInView(vis, vp) && !tileInView(ent.tile, vp)) continue;
        let name = ent.aiState || '';
        if (!name && ent.brain && typeof ent.brain.getNameOfCurrentState === 'function') {
            name = ent.brain.getNameOfCurrentState() || '';
        }
        if (!name) continue;
        const short = name.length > 12 ? name.slice(0, 11) + '…' : name;
        const s = tileToScreen(vis.x, vis.y, vp);
        const color =
            ent.type === 'player'
                ? ent.isLeader
                    ? 'rgba(0, 242, 254, 0.95)'
                    : 'rgba(240, 160, 48, 0.95)'
                : 'rgba(255, 140, 140, 0.95)';
        drawLabel(g, s.x, s.y, short, color, '9px monospace');
    }
}

function drawPaths(g, entities, vp) {
    for (let i = 0; i < entities.length; i++) {
        const ent = entities[i];
        if (!ent.tile || !Array.isArray(ent.path) || ent.path.length === 0) continue;
        const vis = getVisualTilePos(ent) || ent.tile;
        if (!tileInView(vis, vp) && !tileInView(ent.tile, vp)) continue;
        const color =
            ent.type === 'player'
                ? 'rgba(0, 200, 255, 0.75)'
                : 'rgba(255, 100, 80, 0.7)';
        g.save();
        g.beginPath();
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.setLineDash([3, 3]);
        const start = tileToScreen(vis.x, vis.y, vp);
        g.moveTo(start.x, start.y);
        for (let p = 0; p < ent.path.length; p++) {
            const step = ent.path[p];
            if (!step) continue;
            const s = tileToScreen(step.x, step.y, vp);
            g.lineTo(s.x, s.y);
        }
        g.stroke();
        g.setLineDash([]);
        // Endpoint marker
        const last = ent.path[ent.path.length - 1];
        if (last) {
            const e = tileToScreen(last.x, last.y, vp);
            g.beginPath();
            g.fillStyle = color;
            g.arc(e.x, e.y, 2.5, 0, Math.PI * 2);
            g.fill();
        }
        g.restore();
    }
}

function drawTargets(g, entities, vp) {
    for (let i = 0; i < entities.length; i++) {
        const ent = entities[i];
        if (!ent.tile || !ent.target || !ent.target.tile) continue;
        const vis = getVisualTilePos(ent) || ent.tile;
        const tVis = getVisualTilePos(ent.target) || ent.target.tile;
        if (!tileInView(vis, vp) && !tileInView(tVis, vp)) continue;
        const a = tileToScreen(vis.x, vis.y, vp);
        const b = tileToScreen(tVis.x, tVis.y, vp);
        const color =
            ent.type === 'player'
                ? 'rgba(120, 255, 120, 0.8)'
                : 'rgba(255, 80, 80, 0.75)';
        drawLineScreen(g, a.x, a.y, b.x, b.y, color, 1.5, 0.9);
        g.save();
        g.beginPath();
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.arc(b.x, b.y, 5, 0, Math.PI * 2);
        g.stroke();
        g.restore();
    }
}

function engageRangeFor(ent) {
    if (ent.type === 'player') {
        if (ent.strategy && ent.strategy.engageRange != null) {
            return Number(ent.strategy.engageRange);
        }
        return Settings.AI_ENGAGE_RANGE != null ? Settings.AI_ENGAGE_RANGE : 7;
    }
    return Settings.AI_CREATURE_AGGRO_RANGE != null
        ? Settings.AI_CREATURE_AGGRO_RANGE
        : 7;
}

function leashRange() {
    return Settings.AI_CREATURE_LEASH != null ? Settings.AI_CREATURE_LEASH : 18;
}

function drawRanges(g, entities, vp) {
    const engage = RANGE_BOX_INFO.engage;
    const aggro = RANGE_BOX_INFO.aggro;
    const leash = RANGE_BOX_INFO.leash;

    for (let i = 0; i < entities.length; i++) {
        const ent = entities[i];
        if (!ent.tile || !tileInView(ent.tile, vp)) continue;
        const r = engageRangeFor(ent);
        if (ent.type === 'player') {
            drawRangeSquare(
                g,
                ent.tile.x,
                ent.tile.y,
                r,
                vp,
                engage.stroke,
                engage.name,
                engage.label
            );
        } else {
            drawRangeSquare(
                g,
                ent.tile.x,
                ent.tile.y,
                r,
                vp,
                aggro.stroke,
                aggro.name,
                aggro.label
            );
            const home = ent.homeTile || ent.spawnTile;
            if (home) {
                drawRangeSquare(
                    g,
                    home.x,
                    home.y,
                    leashRange(),
                    vp,
                    leash.stroke,
                    leash.name,
                    leash.label
                );
            }
        }
    }

    drawRangesLegend(g);
}

function drawSpawns(g, sim, vp) {
    const drawn = new Set();
    const mark = (x, y, z, label, color) => {
        if (!matchesViewZ(z, vp.viewZ)) return;
        const key = `${x},${y},${z != null ? z : ''}`;
        if (drawn.has(key)) return;
        drawn.add(key);
        if (!tileInView({ x, y }, vp)) return;
        const s = tileToScreen(x, y, vp);
        g.save();
        g.beginPath();
        g.strokeStyle = color;
        g.lineWidth = 1.5;
        g.rect(s.x - 4, s.y - 4, 8, 8);
        g.stroke();
        if (label) {
            drawLabel(g, s.x, s.y + 10, label, color, '8px monospace');
        }
        g.restore();
    };

    const configs = sim._spawnConfigs;
    if (Array.isArray(configs)) {
        for (let i = 0; i < configs.length; i++) {
            const e = configs[i];
            if (!e || e.x == null || e.y == null) continue;
            mark(
                Math.round(e.x),
                Math.round(e.y),
                e.z,
                e.creatureId || e.id || 'spawn',
                'rgba(180, 140, 255, 0.9)'
            );
        }
    }

    const creatures = sim.creatures || [];
    for (let i = 0; i < creatures.length; i++) {
        const c = creatures[i];
        const home = c && (c.homeTile || c.spawnTile);
        if (!home) continue;
        mark(
            home.x,
            home.y,
            home.z != null ? home.z : c.tile && c.tile.z,
            'home',
            'rgba(200, 160, 255, 0.7)'
        );
    }
}

/** Named tile-type colors for the Tile types overlay (and legend). */
const TILE_TYPE_INFO = {
    floor: {
        name: 'floor',
        fill: 'rgba(60, 200, 100, 0.28)',
        label: 'rgba(120, 240, 160, 0.95)',
        blurb: 'walkable friction'
    },
    wall: {
        name: 'wall',
        fill: 'rgba(220, 90, 60, 0.35)',
        label: 'rgba(255, 150, 120, 0.95)',
        blurb: 'blocked edge (adjacent walkable)'
    },
    void: {
        name: 'void',
        fill: 'rgba(40, 30, 70, 0.45)',
        label: 'rgba(160, 150, 200, 0.9)',
        blurb: 'blocked interior / empty'
    },
    stairs: {
        name: 'stairs',
        fill: 'rgba(60, 180, 255, 0.4)',
        label: 'rgba(120, 210, 255, 0.95)',
        blurb: 'stair pad (multi-floor hop)'
    }
};

/**
 * True if any cardinal neighbor is walkable (used to separate wall edge vs void).
 * @param {{ cols: number, rows: number, friction: Uint8Array|ArrayLike<number> }} layer
 * @param {number} x
 * @param {number} y
 * @param {number} blocked
 * @returns {boolean}
 */
function adjacentWalkable(layer, x, y, blocked) {
    const cols = layer.cols;
    const rows = layer.rows;
    const f = layer.friction;
    const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1]
    ];
    for (let i = 0; i < dirs.length; i++) {
        const nx = x + dirs[i][0];
        const ny = y + dirs[i][1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if ((f[ny * cols + nx] & 0xff) !== blocked) return true;
    }
    return false;
}

/**
 * True when the decorative art tile id is a stairs-role catalog cell.
 * Piece stair sockets may get stairs art without a TileMap hop entry
 * (only paired stairLinks are registered for multi-floor hops).
 * @param {object|null|undefined} map
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {boolean}
 */
function artTileIsStairs(map, x, y, z) {
    if (!map) return false;
    let id = null;
    if (typeof map.artTileIdAt === 'function') {
        id = map.artTileIdAt(x, y, z);
    } else if (map.artLayers) {
        const art = map.artLayers[String(z)];
        if (art && art.palette && art.cells) {
            const cols = art.cols | 0;
            const rows = art.rows | 0;
            if (x >= 0 && y >= 0 && x < cols && y < rows) {
                const idx = art.cells[y * cols + x] & 0xffff;
                id = art.palette[idx] != null ? String(art.palette[idx]) : null;
            }
        }
    }
    if (!id) return false;
    // Catalog ids: damp_cave_stairs, dark_stone_stairs, … (role stairs)
    return /stair/i.test(id);
}

/**
 * Infer art-role-style tile type from friction + stair registry + art layer.
 * Matches Stage 11.9 art binding semantics (floor / wall / void / stairs).
 * Path tiles are not stored separately at runtime → walkable shows as floor.
 *
 * Stairs: hop pads (TileMap.stairs / getStair) OR decorative stairs art
 * (piece sockets that were painted but not paired into stairLinks).
 *
 * @param {object} map TileMap
 * @param {object} layer FloorLayer
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {number} blocked FRICTION_BLOCKED
 * @returns {'floor'|'wall'|'void'|'stairs'}
 */
function classifyTileType(map, layer, x, y, z, blocked) {
    if (map && typeof map.getStair === 'function' && map.getStair(x, y, z)) {
        return 'stairs';
    }
    if (
        map &&
        map.stairs &&
        map.stairs[`${x},${y},${String(z)}`]
    ) {
        return 'stairs';
    }
    if (artTileIsStairs(map, x, y, z)) {
        return 'stairs';
    }
    const flat = y * layer.cols + x;
    const fr = layer.friction[flat] & 0xff;
    if (fr !== blocked) return 'floor';
    if (adjacentWalkable(layer, x, y, blocked)) return 'wall';
    return 'void';
}

/**
 * Corner legend for Tile types overlay (bottom-left so Ranges can stay top-left).
 * @param {CanvasRenderingContext2D} g
 * @param {{ viewRows?: number, th?: number }} [vp]
 */
function drawTileTypesLegend(g, vp) {
    const lines = [
        { key: 'floor', text: 'floor — walkable' },
        { key: 'wall', text: 'wall — blocked edge' },
        { key: 'void', text: 'void — blocked interior' },
        { key: 'stairs', text: 'stairs — multi-floor pad' }
    ];
    const padX = 8;
    const padY = 10;
    const lineH = 12;
    const title = 'Tile types';
    g.save();
    g.font = '9px monospace';
    const boxW = 200;
    const boxH = padY + lineH + lines.length * lineH + 6;
    const boxX = 4;
    const canvasH =
        Settings.app && Settings.app.height > 0
            ? Settings.app.height
            : vp && vp.viewRows && vp.th
              ? vp.viewRows * vp.th
              : 320;
    const boxY = Math.max(4, canvasH - boxH - 4);
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(boxX, boxY, boxW, boxH);
    g.strokeStyle = 'rgba(180, 180, 180, 0.35)';
    g.lineWidth = 1;
    g.strokeRect(boxX, boxY, boxW, boxH);

    g.fillStyle = 'rgba(220, 220, 220, 0.95)';
    g.fillText(title, boxX + padX, boxY + padY + 8);
    for (let i = 0; i < lines.length; i++) {
        const info = TILE_TYPE_INFO[lines[i].key];
        const y = boxY + padY + 8 + (i + 1) * lineH;
        g.fillStyle = info.label;
        g.fillText(lines[i].text, boxX + padX, y);
    }
    g.restore();
}

/**
 * Paint semi-transparent type colors over every tile in the current viewport.
 * Uses collision friction + stair pads (same roles as art binding).
 * @param {CanvasRenderingContext2D} g
 * @param {object} sim
 * @param {{ ox: number, oy: number, tw: number, th: number, viewCols: number, viewRows: number, viewZ: string|null }} vp
 */
function drawTileTypes(g, sim, vp) {
    const map = sim && sim.tileMap;
    if (!map || !map.layers) return;

    const zKey =
        vp.viewZ != null
            ? String(vp.viewZ)
            : Object.keys(map.layers)[0] || null;
    if (zKey == null) return;
    const layer = map.layers[zKey];
    if (!layer || !layer.friction) return;

    const blocked =
        Settings.FRICTION_BLOCKED != null ? Settings.FRICTION_BLOCKED : 255;
    const ox = vp.ox | 0;
    const oy = vp.oy | 0;
    const viewCols = vp.viewCols | 0;
    const viewRows = vp.viewRows | 0;
    const tw = vp.tw;
    const th = vp.th;

    g.save();
    for (let vy = 0; vy < viewRows; vy++) {
        for (let vx = 0; vx < viewCols; vx++) {
            const x = ox + vx;
            const y = oy + vy;
            if (x < 0 || y < 0 || x >= layer.cols || y >= layer.rows) continue;
            const kind = classifyTileType(map, layer, x, y, zKey, blocked);
            const info = TILE_TYPE_INFO[kind];
            if (!info) continue;
            g.fillStyle = info.fill;
            g.fillRect(vx * tw, vy * th, tw, th);
        }
    }
    g.restore();

    drawTileTypesLegend(g, vp);
}

/**
 * Resolve hit source + impact tiles for one combat FX entry (if any).
 * Auto attacks keep plain type labels (melee / projectile).
 * Non-auto spells append spellId: hit:projectile:ember_bolt
 * @param {object} e combat FX entry
 * @returns {{ sx: number, sy: number, ix: number, iy: number, type: string, spellId: string, label: string }|null}
 */
function hitSourceOfFx(e) {
    if (!e || !e.type) return null;
    let sx = e.sx;
    let sy = e.sy;
    if (sx == null || sy == null) {
        if (e.x0 != null && e.y0 != null) {
            sx = e.x0;
            sy = e.y0;
        }
    }
    if (sx == null || sy == null) return null;
    let ix = e.x1 != null ? e.x1 : e.x;
    let iy = e.y1 != null ? e.y1 : e.y;
    if (ix == null) ix = sx;
    if (iy == null) iy = sy;
    const type = String(e.type);
    const spellId =
        e.spellId != null && String(e.spellId).length
            ? String(e.spellId)
            : '';
    // Auto: hit:melee / hit:projectile. Spell: hit:aoe:fire_bomb
    const label = spellId ? `hit:${type}:${spellId}` : `hit:${type}`;
    return {
        sx: Number(sx),
        sy: Number(sy),
        ix: Number(ix),
        iy: Number(iy),
        type,
        spellId,
        label
    };
}

/**
 * Draw combat VFX hit sources (attacker origin) for active animation frames.
 * Reads sim.combatEffects.entries only — no mutation.
 * @param {CanvasRenderingContext2D} g
 * @param {object} sim
 * @param {{ ox: number, oy: number, tw: number, th: number, viewCols: number, viewRows: number }} vp
 */
function drawHitSources(g, sim, vp) {
    const script = sim.combatEffects;
    const entries = script && Array.isArray(script.entries) ? script.entries : null;
    if (!entries || !entries.length) return;

    const color = 'rgba(255, 220, 80, 0.95)';
    const lineColor = 'rgba(255, 220, 80, 0.7)';

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!matchesViewZ(entry && entry.z, vp.viewZ)) continue;
        const info = hitSourceOfFx(entry);
        if (!info) continue;
        const srcTile = { x: info.sx, y: info.sy };
        const impactTile = { x: info.ix, y: info.iy };
        if (!tileInView(srcTile, vp) && !tileInView(impactTile, vp)) continue;

        const a = tileToScreen(info.sx, info.sy, vp);
        const b = tileToScreen(info.ix, info.iy, vp);

        // Source diamond
        g.save();
        g.beginPath();
        g.strokeStyle = color;
        g.fillStyle = 'rgba(255, 220, 80, 0.25)';
        g.lineWidth = 1.5;
        const r = 5;
        g.moveTo(a.x, a.y - r);
        g.lineTo(a.x + r, a.y);
        g.lineTo(a.x, a.y + r);
        g.lineTo(a.x - r, a.y);
        g.closePath();
        g.fill();
        g.stroke();
        g.restore();

        // Source → impact guide
        if (info.sx !== info.ix || info.sy !== info.iy) {
            drawLineScreen(g, a.x, a.y, b.x, b.y, lineColor, 1, 0.85);
            g.save();
            g.beginPath();
            g.strokeStyle = lineColor;
            g.lineWidth = 1;
            g.arc(b.x, b.y, 3.5, 0, Math.PI * 2);
            g.stroke();
            g.restore();
        }

        drawLabel(g, a.x, a.y, info.label, color, '8px monospace');
    }
}

/**
 * Main entry: draw all enabled AI debug layers for a Simulator instance.
 * Never mutates sim state; never calls Math.random.
 * @param {CanvasRenderingContext2D} g
 * @param {object} sim Simulator
 */
function drawAiDebugOverlays(g, sim) {
    if (!g || !sim || !isAiDebugActive()) return;

    const d = ensureDebugAI();
    const vp = viewParams(sim);
    const entities = collectEntities(sim, vp.viewZ);

    g.save();
    try {
        // Tile types under entity overlays so paths / labels stay readable
        if (d.tileTypes) drawTileTypes(g, sim, vp);
        if (d.ranges) drawRanges(g, entities, vp);
        if (d.paths) drawPaths(g, entities, vp);
        if (d.targets) drawTargets(g, entities, vp);
        if (d.spawns) drawSpawns(g, sim, vp);
        if (d.hitSources) drawHitSources(g, sim, vp);
        if (d.states) drawStates(g, entities, vp);
    } finally {
        g.restore();
    }
}

module.exports = {
    DEBUG_AI_DEFAULTS,
    DEBUG_AI_FLAG_KEYS,
    RANGE_BOX_INFO,
    TILE_TYPE_INFO,
    ensureDebugAI,
    mergeDebugAI,
    applyDebugAIPatch,
    snapshotDebugAI,
    isAiDebugActive,
    drawAiDebugOverlays,
    hitSourceOfFx,
    classifyTileType,
    tileToScreen,
    viewParams,
    resolveViewZ,
    matchesViewZ
};
