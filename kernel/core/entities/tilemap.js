/**
 * TileMap — numeric collision grids per floor.
 *
 * Stage 1: load path PNG (each pixel = one tile), flat friction storage,
 * occupancy helpers.
 * Stage 2: search / followPath via Pathfinder (A*).
 * Stage 10: optional navmesh + findLongPath (coarse graph → local segments).
 * Stage 12H: first-class stair tiles (registry + hop helpers). Local A* stays
 * same-floor; multi-floor hops use stairs / navmesh edges.
 *
 * Walk vs sight are independent (docs/08):
 *   friction — walk delay / FRICTION_BLOCKED (255) non-walkable
 *   sight    — SIGHT_BLOCKED (255) cuts LoS / projectiles; 0 = clear
 *   flags    — TILE_FLAG_* bits (NO_CAST, NO_CREATURE, vertical markers, …)
 *
 * Path-PNG pixel encoding (docs/08, assets/.../REFERENCE.md):
 *   #ffff00 pure yellow     → full wall (walk+sight blocked)
 *   #00ffff pure cyan       → water / solid clear-sight (walk blocked, sight open)
 *   #ff00ff pure magenta    → grate / glass (walk open, sight blocked)
 *   #00ff00 pure green      → NO_CAST only (legacy single-bit; full PZ package is both bits)
 *   R === G === B, not white → walkable floor; friction = channel 0–250 (table)
 *   white / other non-gray  → full wall
 *
 * Full protection zone = TILE_FLAG_PZ_PACKAGE (NO_CAST | NO_CREATURE). Role bake and
 * editor packages set both; pure-green PNG stays NO_CAST-only for backward compat.
 */

const { GameObject } = require('./gameobject.js');
const { Settings, DEFAULT_GENRE } = require('../../settings.js');
const { findPath } = require('../lib/pathfinder.js');
const { findLongPath } = require('../lib/navmesh.js');
const {
    computeMoveDelay,
    isDiagonalStep,
    isAdjacentStep,
    beginStepVisual,
    snapVisualToTile,
    updateSpriteFacing,
    getCanvasStepExtraDt
} = require('../lib/movement.js');
const { isTickDue, forceDue, isLogicIntervalDue } = require('../lib/logic_regulator.js');
const { takePathBudget, noteFailBackoff } = require('../lib/path_budget.js');
const { Time } = require('../lib/time.js');
const { onEntityTileTransition, computeEntityAvoidFieldMask } = require('../lib/combat/elemental_fields.js');
const { onWorldPinStep } = require('../lib/dungeon/world_pin_trap.js');
const { hopDirOffset } = require('../lib/dungeon/tile_roles.js');
const {
    resolveTileDrawBox,
    resolvePlacementRender,
    collectTallPropsFromFloor,
    TERRAIN_SUB_LAYER_IDS
} = require('../lib/tile_draw.js');

/**
 * Whether an entity may path with fieldPenalty (cross avoided hazards).
 * Shared by followPath pre-search cache branch and post-fail fallback so the
 * gate cannot drift between the two sites.
 *
 * Product rule (S06-01 Option B): same gates for wild monsters and summons.
 * Crossing is allowed only when:
 *   - provokedUntil is still active (took attack damage), or
 *   - ignoreFieldProvocation escape hatch, or
 *   - brain is in leash / return_home (anti-stuck forced movement).
 * Summon master distance / master.inBattle do NOT grant free field crossing.
 *
 * Immunity / canWalkOn* is handled earlier via avoidFieldMask === 0, not here.
 *
 * @param {object} entity
 * @param {number} now Logic time (Time.timeSinceLevelLoad)
 * @returns {boolean}
 */
function canCrossFieldHazards(entity, now) {
    if (!entity) return false;
    if (entity.provokedUntil && entity.provokedUntil >= now) return true;
    if (entity.ignoreFieldProvocation === true) return true;
    // Manual control: player may deliberately path onto creature/scenario hazards
    // (soft fieldPenalty). AI party members stay hard-avoid until provoked.
    if (entity.controlMode === 'manual') return true;
    if (
        entity.brain &&
        (entity.brain.state === 'leash' || entity.brain.state === 'return_home')
    ) {
        return true;
    }
    return false;
}

/** Lazy sprite helpers for art tiles (browser watch); null in pure headless paths. */
let _tileSpriteApi = null;
function tileSpriteApi() {
    if (_tileSpriteApi !== null) return _tileSpriteApi;
    try {
        _tileSpriteApi = require('../lib/creature_sprites.js');
    } catch (_e) {
        _tileSpriteApi = false;
    }
    return _tileSpriteApi || null;
}

/** @type {number} Non-walkable sentinel stored in friction arrays */
const FRICTION_BLOCKED = 255;

/** @type {number} Line-of-sight / projectile block sentinel in sight arrays */
const SIGHT_BLOCKED = 255;

/** @type {number} Sight clear (projectiles pass) */
const SIGHT_CLEAR = 0;

/**
 * Tile flag bits on layer.flags (parallel Uint8Array).
 * Bits stay independent; "Protection Zone" is a package of NO_CAST|NO_CREATURE,
 * not a single magic bit. STAIR/LADDER/HOLE/ROPE/SHOVEL are markers only —
 * hops still need the stair registry (addStair). Hop-on-step vs Use is
 * hopsOnStep(pad.type), not the flag bit. Same values as tile_roles.js
 * / presets and the flag table in docs/08.
 */
const TILE_FLAG_NO_CAST = 1 << 0; // 1 — no attack/cast affect tile; standing blocks cast
const TILE_FLAG_STAIR = 1 << 1; // 2 — up transit marker
const TILE_FLAG_LADDER = 1 << 2; // 4 — ladder (UI / use)
const TILE_FLAG_HOLE = 1 << 3; // 8 — down transit (hole / trapdoor)
const TILE_FLAG_ROPE_SPOT = 1 << 4; // 16
const TILE_FLAG_SHOVEL_SPOT = 1 << 5; // 32
const TILE_FLAG_NO_CREATURE = 1 << 6; // 64 — creatures may not path/step onto
// 1 << 7 reserved spare
/** Full PZ package (editor sugar + protection role bake). */
const TILE_FLAG_PZ_PACKAGE = TILE_FLAG_NO_CAST | TILE_FLAG_NO_CREATURE; // 65

/** Default walk friction for special walkable colors (grate, protection zone). */
const PATH_PNG_DEFAULT_WALK_FRICTION = 100;

/** Vertical type → flag bit (marker only; stair registry still required). */
const VERTICAL_TYPE_FLAGS = {
    stairs: TILE_FLAG_STAIR,
    ladder: TILE_FLAG_LADDER,
    hole: TILE_FLAG_HOLE,
    rope: TILE_FLAG_ROPE_SPOT,
    shovel: TILE_FLAG_SHOVEL_SPOT
};

/**
 * Whether a registered pad of this type hops when a player lands on it.
 * `stairs` / `hole` (and untyped legacy / portal pads) hop on step.
 * `ladder` / `rope` / `shovel` stay until Use (`USE_STAIR`) or an
 * intentional `tryUseStair` (followLongPath / party hop).
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
function hopsOnStep(type) {
    if (type == null || type === '') return true;
    const t = String(type).trim().toLowerCase();
    return t === 'stairs' || t === 'hole';
}

/**
 * Reverse hop facing for bidirectional stair links.
 * @param {string|null|undefined} dir
 * @returns {string|null}
 */
function reverseHopDir(dir) {
    if (dir == null) return null;
    const d = String(dir).trim().toLowerCase();
    switch (d) {
        case 'north':
            return 'south';
        case 'south':
            return 'north';
        case 'east':
            return 'west';
        case 'west':
            return 'east';
        case 'up':
            return 'down';
        case 'down':
            return 'up';
        case 'center':
            return 'center';
        default:
            return d || null;
    }
}

/**
 * Normalize vertical meta from a placement / role for stair registration.
 * @param {object|null|undefined} raw
 * @returns {{ type: string, deltaZ: number, defaultDir: string, bidirectional: boolean, registerStairLink: boolean }|null}
 */
function normalizePlacementVertical(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const typeRaw =
        raw.type != null
            ? String(raw.type).trim().toLowerCase()
            : raw.kind != null
              ? String(raw.kind).trim().toLowerCase()
              : '';
    if (!VERTICAL_TYPE_FLAGS[typeRaw]) return null;

    let deltaZ = Number(raw.deltaZ);
    if (!Number.isFinite(deltaZ)) {
        if (typeRaw === 'hole' || typeRaw === 'shovel') deltaZ = 1;
        else deltaZ = -1;
    }
    deltaZ = Math.trunc(deltaZ);
    if (deltaZ === 0) {
        deltaZ = typeRaw === 'hole' || typeRaw === 'shovel' ? 1 : -1;
    }

    const dirRaw =
        raw.defaultDir != null
            ? String(raw.defaultDir).trim().toLowerCase()
            : raw.dir != null
              ? String(raw.dir).trim().toLowerCase()
              : 'center';
    const dirs = { center: 1, north: 1, south: 1, east: 1, west: 1 };
    const defaultDir = dirs[dirRaw] ? dirRaw : 'center';

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
 * Coerce floor index for deltaZ arithmetic (numeric floors + string digits).
 * @param {string|number} z
 * @param {number} deltaZ
 * @returns {string|number}
 */
function applyFloorDelta(z, deltaZ) {
    const n = Number(z);
    if (Number.isFinite(n) && String(n) === String(z).trim()) {
        return n + deltaZ;
    }
    // Non-numeric floor keys: cannot apply delta; return as-is (caller should set hop.to)
    return z;
}

/** Default: full-floor cache when map has ≤ this many tiles (80×80). */
const DEFAULT_CACHE_FULL_MAX_TILES = 6400;
/** Default minimum overscan margin in tiles. */
const DEFAULT_CACHE_MARGIN_MIN = 8;

/**
 * Precomputed fill styles for friction gray (avoids `rgb(...)` alloc on rebuild).
 * Special collision colors override in render when sight/flags differ.
 * @type {string[]}
 */
const FRICTION_FILL_STYLE = (function buildFrictionFillStyle() {
    const out = new Array(256);
    out[FRICTION_BLOCKED] = '#1a1a24';
    for (let i = 0; i < FRICTION_BLOCKED; i++) {
        const v = Math.max(40, Math.min(220, i));
        out[i] = 'rgb(' + v + ',' + v + ',' + v + ')';
    }
    return out;
})();

/**
 * Resolve viewport origin + size in tile space (camera + canvas).
 *
 * @param {{ cols: number, rows: number }} layer
 * @param {{
 *   tileWidth?: number,
 *   tileHeight?: number,
 *   cameraTileX?: number|null,
 *   cameraTileY?: number|null,
 *   appWidth?: number,
 *   appHeight?: number
 * }} [opts]
 * @returns {{ originX: number, originY: number, viewCols: number, viewRows: number }}
 */
function resolveTilemapViewport(layer, opts) {
    const o = opts || {};
    const tw = o.tileWidth != null ? o.tileWidth : Settings.tileWidth || 1;
    const th = o.tileHeight != null ? o.tileHeight : Settings.tileHeight || 1;
    const appW =
        o.appWidth != null
            ? o.appWidth
            : Settings.app && Settings.app.width > 0
              ? Settings.app.width
              : 0;
    const appH =
        o.appHeight != null
            ? o.appHeight
            : Settings.app && Settings.app.height > 0
              ? Settings.app.height
              : 0;

    let viewCols = 64;
    let viewRows = 40;
    if (appW > 0 && tw > 0) {
        viewCols = Math.max(1, Math.ceil(appW / tw));
    }
    if (appH > 0 && th > 0) {
        viewRows = Math.max(1, Math.ceil(appH / th));
    }
    viewCols = Math.min(layer.cols, viewCols);
    viewRows = Math.min(layer.rows, viewRows);

    const camX =
        o.cameraTileX !== undefined ? o.cameraTileX : Settings.cameraTileX;
    const camY =
        o.cameraTileY !== undefined ? o.cameraTileY : Settings.cameraTileY;

    let originX = 0;
    let originY = 0;
    if (camX != null && camY != null) {
        // Keep fractional tile coords so the camera eases with step slides
        // (sprites use the same continuous space). Integer snap caused 1-tile jumps.
        const cx = Number(camX);
        const cy = Number(camY);
        const maxX = layer.cols - viewCols;
        const maxY = layer.rows - viewRows;
        originX = Number.isFinite(cx)
            ? Math.max(0, Math.min(maxX, cx))
            : 0;
        originY = Number.isFinite(cy)
            ? Math.max(0, Math.min(maxY, cy))
            : 0;
    }
    return { originX, originY, viewCols, viewRows };
}

/**
 * Choose full-map vs overscan cache rectangle in tile space.
 *
 * @param {{ cols: number, rows: number }} layer
 * @param {{ originX: number, originY: number, viewCols: number, viewRows: number }} view
 * @param {{ fullMaxTiles?: number, marginMin?: number }} [opts]
 * @returns {{ x: number, y: number, w: number, h: number, mode: 'full'|'overscan' }}
 */
function computeTilemapCacheRect(layer, view, opts) {
    const o = opts || {};
    const fullMax =
        o.fullMaxTiles != null
            ? o.fullMaxTiles
            : Settings.TILEMAP_CACHE_FULL_MAX_TILES != null
              ? Settings.TILEMAP_CACHE_FULL_MAX_TILES
              : DEFAULT_CACHE_FULL_MAX_TILES;
    const marginMin =
        o.marginMin != null
            ? o.marginMin
            : Settings.TILEMAP_CACHE_MARGIN_MIN != null
              ? Settings.TILEMAP_CACHE_MARGIN_MIN
              : DEFAULT_CACHE_MARGIN_MIN;

    const mapTiles = layer.cols * layer.rows;
    if (mapTiles <= fullMax) {
        return {
            x: 0,
            y: 0,
            w: layer.cols,
            h: layer.rows,
            mode: 'full'
        };
    }

    const marginX = Math.max(marginMin, Math.ceil(view.viewCols / 2));
    const marginY = Math.max(marginMin, Math.ceil(view.viewRows / 2));
    // +1 tile so fractional camera origins still have a full pixel row/col of art
    const w = Math.min(layer.cols, view.viewCols + 2 * marginX + 1);
    const h = Math.min(layer.rows, view.viewRows + 2 * marginY + 1);
    const centerX = Math.floor(view.originX + view.viewCols / 2);
    const centerY = Math.floor(view.originY + view.viewRows / 2);
    const x = Math.max(0, Math.min(layer.cols - w, centerX - Math.floor(w / 2)));
    const y = Math.max(0, Math.min(layer.rows - h, centerY - Math.floor(h / 2)));
    return { x, y, w, h, mode: 'overscan' };
}

/**
 * Whether the static cache should be rebuilt for the current viewport.
 * Full-map caches never rebuild for pan. Overscan rebuilds only when the
 * viewport is no longer fully contained (the build margin is the hysteresis:
 * a large overscan means the camera can walk many tiles before a rebuild).
 *
 * Optional `tripMargin` (default 0) rebuilds slightly early when the view
 * enters a strip inside the cache edge — useful if you want pre-fetch before
 * the hard edge. Must be smaller than the build overscan or every pan rebuilds.
 *
 * @param {{ originX: number, originY: number, viewCols: number, viewRows: number }} view
 * @param {{ x: number, y: number, w: number, h: number, mode: string }} cache
 * @param {{ cols: number, rows: number }} layer
 * @param {{ tripMargin?: number }} [opts]
 * @returns {boolean}
 */
function tilemapCacheNeedsRebuild(view, cache, layer, opts) {
    if (!cache || cache.mode === 'full') return false;
    const o = opts || {};
    const trip =
        o.tripMargin != null
            ? Math.max(0, o.tripMargin | 0)
            : Settings.TILEMAP_CACHE_TRIP_MARGIN != null
              ? Math.max(0, Settings.TILEMAP_CACHE_TRIP_MARGIN | 0)
              : 0;

    // Continuous camera origin → need integer tile coverage of the painted span
    const needX0 = Math.floor(view.originX);
    const needY0 = Math.floor(view.originY);
    const needX1 = Math.ceil(view.originX + view.viewCols);
    const needY1 = Math.ceil(view.originY + view.viewRows);
    const cx0 = cache.x;
    const cy0 = cache.y;
    const cx1 = cache.x + cache.w;
    const cy1 = cache.y + cache.h;

    // Soft trip: still inside cache but within trip tiles of an expandable edge
    if (trip > 0) {
        if (needX0 < cx0 + trip && cx0 > 0) return true;
        if (needY0 < cy0 + trip && cy0 > 0) return true;
        if (needX1 > cx1 - trip && cx1 < layer.cols) return true;
        if (needY1 > cy1 - trip && cy1 < layer.rows) return true;
    }

    // Hard edge: painted span not fully contained in cache tiles
    if (needX0 < cx0 || needY0 < cy0 || needX1 > cx1 || needY1 > cy1) {
        return true;
    }
    return false;
}

/**
 * Stable key for a stair pad at (x,y,z).
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {string}
 */
function stairKey(x, y, z) {
    return `${Math.round(x)},${Math.round(y)},${String(z)}`;
}

/**
 * Normalize a tile coordinate triple.
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} t
 * @param {string|number} [defaultZ]
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function normalizeTileRef(t, defaultZ) {
    if (!t || t.x == null || t.y == null) return null;
    const z = t.z !== undefined ? t.z : defaultZ;
    if (z === undefined) return null;
    return {
        x: Math.round(Number(t.x)),
        y: Math.round(Number(t.y)),
        z
    };
}

/**
 * Decode one path-PNG pixel to friction + sight + flags.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {{ friction: number, sight: number, flags: number }}
 */
function collisionFromPixel(r, g, b) {
    // Pure yellow → full wall (walk + sight)
    if (r === 255 && g === 255 && b === 0) {
        return {
            friction: FRICTION_BLOCKED,
            sight: SIGHT_BLOCKED,
            flags: 0
        };
    }
    // Pure cyan → water / solid clear-sight
    if (r === 0 && g === 255 && b === 255) {
        return {
            friction: FRICTION_BLOCKED,
            sight: SIGHT_CLEAR,
            flags: 0
        };
    }
    // Pure magenta → grate / glass (walk open, sight blocked)
    if (r === 255 && g === 0 && b === 255) {
        return {
            friction: PATH_PNG_DEFAULT_WALK_FRICTION,
            sight: SIGHT_BLOCKED,
            flags: 0
        };
    }
    // Pure green → protection zone (walk + sight open, no cast)
    if (r === 0 && g === 255 && b === 0) {
        return {
            friction: PATH_PNG_DEFAULT_WALK_FRICTION,
            sight: SIGHT_CLEAR,
            flags: TILE_FLAG_NO_CAST
        };
    }
    // Gray walkable (not pure white); clamp channel to table max 250
    if (r === g && g === b && r !== 255) {
        const f = r > 250 ? 250 : r;
        return { friction: f, sight: SIGHT_CLEAR, flags: 0 };
    }
    // White or any other non-gray → full wall
    return {
        friction: FRICTION_BLOCKED,
        sight: SIGHT_BLOCKED,
        flags: 0
    };
}

/**
 * Decode friction only (compat). Prefer collisionFromPixel for full profile.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} 0–250 walkable friction, or FRICTION_BLOCKED
 */
function frictionFromPixel(r, g, b) {
    return collisionFromPixel(r, g, b).friction;
}

/**
 * Build default sight grid from friction (blocked walk ⇒ blocked sight).
 * Used when loaders omit an explicit sight buffer.
 * @param {Uint8Array} friction
 * @returns {Uint8Array}
 */
function defaultSightFromFriction(friction) {
    const n = friction.length;
    const sight = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        if (friction[i] === FRICTION_BLOCKED) sight[i] = SIGHT_BLOCKED;
    }
    return sight;
}

/**
 * @typedef {Object} FloorLayer
 * @property {number} cols
 * @property {number} rows
 * @property {Uint8Array} friction  length cols*rows; 255 = walk blocked
 * @property {Uint8Array} sight     length cols*rows; 255 = LoS blocked
 * @property {Uint8Array} flags     length cols*rows; TILE_FLAG_* bits
 * @property {Int32Array} occupancy length cols*rows; 0 = empty, else first combatant id
 * @property {Uint8Array} [fields] elemental field bitmasks
 */

/**
 * Stage 11.9 decorative art layer (parallel to friction).
 * @typedef {Object} ArtFloorLayer
 * @property {number} cols
 * @property {number} rows
 * @property {string[]} palette  index 0 = empty
 * @property {string[]} [roleIds] parallel to palette (live role render lookup)
 * @property {Array<object|null>} [renders] parallel — art-set scale/anchor/variant
 * @property {Array<object|null>} [influences] parallel — art-set influence overlay
 * @property {Uint16Array|ArrayLike<number>} cells palette indices
 * @property {string} [artSet]
 * @property {string|null} [genre]
 * @property {string} [kind]
 */

class TileMap extends GameObject {
    /**
     * @param {string} [name]
     */
    constructor(name) {
        super(name || 'TileMap');
        /** @type {Record<string, FloorLayer>} */
        this.layers = Object.create(null);
        /**
         * Stage 11.9 art layers keyed by floor z (same keys as friction layers).
         * Procedural / decorative single-cell path (no multi-stack).
         * @type {Record<string, ArtFloorLayer>}
         */
        this.artLayers = Object.create(null);
        /**
         * Hybrid authoring floors (TileMap sub-layers + palette) for Phase 6 render:
         * ground+path → terrain cache; scenery/furniture/vertical → tall props.
         * @type {Record<string, object>}
         */
        this.authoringFloors = Object.create(null);
        /**
         * Optional tile-role catalog for placement scale/anchor defaults (watch).
         * @type {Map<string, object>|Record<string, object>|null}
         */
        this.tileRoleCatalog = null;
        /**
         * Optional Stage 10 coarse graph for long routes.
         * @type {import('../lib/navmesh.js').Navmesh|null}
         */
        this.navmesh = null;
        /**
         * Stage 12H first-class stair pads: key "x,y,z" → destination tile.
         * Bidirectional links store both directions as separate entries.
         * @type {Record<string, { x: number, y: number, z: string|number, dir?: string|null, link?: string|null }>}
         */
        this.stairs = Object.create(null);
        /**
         * Sparse multi-combatant stacks: key `${z}:${x}:${y}` → ordered entity
         * ids (length ≥ 2). occupancy grid holds only the first id. Normal:
         * players only. Mixed stair exception: players + at most one creature.
         * @type {Map<string, number[]>}
         */
        this.playerStacks = new Map();
        /**
         * Tiles that deny a second player joining a stack (`noPlayerStack`).
         * Default allow everywhere. Key `${z}:${x}:${y}`.
         * @type {Set<string>}
         */
        this.noPlayerStackTiles = new Set();
        /**
         * Browser watch: static floor offscreen cache (see render()).
         * @type {null|{
         *   canvas: *,
         *   ctx: *,
         *   x: number, y: number, w: number, h: number,
         *   mode: 'full'|'overscan',
         *   zKey: string,
         *   tw: number, th: number,
         *   appW: number, appH: number,
         *   layerCols: number, layerRows: number,
         *   hasArt: boolean,
         *   hasAuthoring: boolean,
         *   useSprites: boolean,
         *   pendingSprites: boolean
         * }}
         */
        this._renderCache = null;
        /** Force next render to rebuild the static cache. */
        this._renderCacheDirty = true;
        /** Debug: total rebuilds this map instance (tests / HUD). */
        this._renderCacheRebuilds = 0;
    }

    /**
     * Drop the static floor cache (content / art / floor load changed).
     * @returns {this}
     */
    invalidateRenderCache() {
        this._renderCacheDirty = true;
        this._renderCache = null;
        return this;
    }

    /**
     * Attach hybrid authoring floor (sub-layers + palette) for watch paint.
     * Invalidates the terrain cache (ground+path) so tall props re-collect.
     *
     * @param {string|number} z
     * @param {object|null} floor
     * @returns {this}
     */
    setAuthoringFloor(z, floor) {
        const key = String(z);
        if (!floor || typeof floor !== 'object') {
            delete this.authoringFloors[key];
        } else {
            this.authoringFloors[key] = floor;
        }
        this.invalidateRenderCache();
        return this;
    }

    /**
     * @param {string|number} z
     * @returns {object|null}
     */
    getAuthoringFloor(z) {
        return this.authoringFloors[String(z)] || null;
    }

    /**
     * Clear all authoring floors (tests / map swap).
     * @returns {this}
     */
    clearAuthoringFloors() {
        this.authoringFloors = Object.create(null);
        this.invalidateRenderCache();
        return this;
    }

    /**
     * Optional role catalog for prop/terrain scale-anchor defaults.
     * @param {Map<string, object>|Record<string, object>|null} catalog
     * @returns {this}
     */
    setTileRoleCatalog(catalog) {
        this.tileRoleCatalog = catalog || null;
        this.invalidateRenderCache();
        return this;
    }

    /**
     * Tall props (scenery / furniture / vertical) in a tile region for y-sort.
     * @param {string|number} z
     * @param {{
     *   x0?: number, y0?: number, x1?: number, y1?: number
     * }} [region] inclusive; default whole floor
     * @returns {ReturnType<typeof collectTallPropsFromFloor>}
     */
    collectTallProps(z, region) {
        const floor = this.getAuthoringFloor(z);
        if (!floor) return [];
        return collectTallPropsFromFloor(floor, {
            ...(region || {}),
            z,
            roleCatalog: this.tileRoleCatalog
        });
    }

    /**
     * Attach a navmesh graph used by findLongPath / long followPath segments.
     * @param {import('../lib/navmesh.js').Navmesh|null} mesh
     * @returns {this}
     */
    setNavmesh(mesh) {
        this.navmesh = mesh || null;
        return this;
    }

    /**
     * Clear all first-class stair tiles.
     * @returns {this}
     */
    clearStairs() {
        this.stairs = Object.create(null);
        return this;
    }

    /**
     * Register one directed stair pad: standing on `from` hops to `to`.
     * Destination already includes hop exit offset when computed by bake helpers.
     * @param {{ x: number, y: number, z: string|number }} from
     * @param {{ x: number, y: number, z: string|number }} to
     * @param {{
     *   dir?: string|null,
     *   link?: string|null,
     *   type?: string|null,
     *   bidirectional?: boolean|null,
     *   exitDx?: number,
     *   exitDy?: number,
     *   deltaZ?: number
     * }} [meta]
     * @returns {this}
     */
    addStair(from, to, meta) {
        const a = normalizeTileRef(from);
        const b = normalizeTileRef(to);
        if (!a || !b) return this;
        if (a.x === b.x && a.y === b.y && String(a.z) === String(b.z)) {
            return this;
        }
        const m = meta && typeof meta === 'object' ? meta : null;
        const row = {
            x: b.x,
            y: b.y,
            z: b.z,
            dir: m && m.dir != null ? String(m.dir) : null,
            link: m && m.link != null ? String(m.link) : null,
            type: m && m.type != null ? String(m.type).toLowerCase() : null,
            bidirectional:
                m && m.bidirectional !== undefined && m.bidirectional !== null
                    ? !!m.bidirectional
                    : null,
            exitDx:
                m && m.exitDx != null && Number.isFinite(Number(m.exitDx))
                    ? Math.trunc(Number(m.exitDx))
                    : 0,
            exitDy:
                m && m.exitDy != null && Number.isFinite(Number(m.exitDy))
                    ? Math.trunc(Number(m.exitDy))
                    : 0,
            deltaZ:
                m && m.deltaZ != null && Number.isFinite(Number(m.deltaZ))
                    ? Math.trunc(Number(m.deltaZ))
                    : null
        };
        this.stairs[stairKey(a.x, a.y, a.z)] = row;
        return this;
    }

    /**
     * Remove a directed stair pad at (x,y,z) if present.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {this}
     */
    removeStair(x, y, z) {
        delete this.stairs[stairKey(x, y, z)];
        return this;
    }

    /**
     * Merge stair links. Default is from ↔ to (procedural hunt pairing).
     * Per-link `bidirectional` overrides `opts.bidirectional` when set.
     * Hybrid / editor rows default one-way so dest tiles stay hop-free
     * unless the designer also painted a return pad.
     * @param {{ from: object, to: object, dir?: string, link?: string|null, type?: string, bidirectional?: boolean, exitDx?: number, exitDy?: number, deltaZ?: number }[]|null|undefined} links
     * @param {{ bidirectional?: boolean }} [opts]
     * @returns {this}
     */
    addStairLinks(links, opts) {
        const defaultBidirectional =
            !opts || opts.bidirectional === undefined
                ? true
                : !!opts.bidirectional;
        const list = Array.isArray(links) ? links : [];
        for (let i = 0; i < list.length; i++) {
            const L = list[i];
            if (!L || !L.from || !L.to) continue;
            const bidirectional =
                L.bidirectional !== undefined && L.bidirectional !== null
                    ? !!L.bidirectional
                    : defaultBidirectional;
            const meta = {
                dir: L.dir != null ? L.dir : 'down',
                link: L.link,
                type: L.type,
                bidirectional,
                exitDx: L.exitDx,
                exitDy: L.exitDy,
                deltaZ: L.deltaZ
            };
            this.addStair(L.from, L.to, meta);
            if (bidirectional) {
                const revDir =
                    L.dir != null
                        ? reverseHopDir(L.dir) ||
                          (L.dir === 'down' ? 'up' : 'down')
                        : 'up';
                this.addStair(L.to, L.from, {
                    dir: revDir,
                    link: L.link,
                    type: L.type,
                    bidirectional: true,
                    exitDx:
                        L.exitDx != null ? -Math.trunc(Number(L.exitDx) || 0) : 0,
                    exitDy:
                        L.exitDy != null ? -Math.trunc(Number(L.exitDy) || 0) : 0,
                    deltaZ:
                        L.deltaZ != null && Number.isFinite(Number(L.deltaZ))
                            ? -Math.trunc(Number(L.deltaZ))
                            : null
                });
            }
        }
        return this;
    }

    /**
     * Replace the stair registry from link list (clears first).
     * @param {{ from: object, to: object, dir?: string, link?: string|null }[]|null|undefined} links
     * @param {{ bidirectional?: boolean }} [opts]
     * @returns {this}
     */
    setStairs(links, opts) {
        this.clearStairs();
        return this.addStairLinks(links, opts);
    }

    /**
     * Destination of the stair pad at (x,y,z), or null.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {{ x: number, y: number, z: string|number, dir?: string|null, link?: string|null, type?: string|null, exitDx?: number, exitDy?: number, deltaZ?: number|null }|null}
     */
    getStair(x, y, z) {
        const row = this.stairs[stairKey(x, y, z)];
        return row || null;
    }

    /**
     * Whether (x,y,z) is a registered stair pad.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    isStair(x, y, z) {
        return this.getStair(x, y, z) != null;
    }

    /**
     * Whether a player landing on (x,y,z) should hop immediately.
     * Requires a registered pad whose type is hopsOnStep.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    hopsOnStepAt(x, y, z) {
        const row = this.getStair(x, y, z);
        if (!row) return false;
        return hopsOnStep(row.type);
    }

    /**
     * List directed stair pads as { from, to } rows.
     * @returns {{ from: {x:number,y:number,z:string|number}, to: {x:number,y:number,z:string|number, dir?: string|null, link?: string|null} }[]}
     */
    listStairs() {
        /** @type {{ from: object, to: object }[]} */
        const out = [];
        const keys = Object.keys(this.stairs);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const parts = k.split(',');
            if (parts.length < 3) continue;
            const to = this.stairs[k];
            out.push({
                from: {
                    x: Number(parts[0]),
                    y: Number(parts[1]),
                    z: parts.slice(2).join(',')
                },
                to: {
                    x: to.x,
                    y: to.y,
                    z: to.z,
                    dir: to.dir,
                    link: to.link,
                    type: to.type,
                    exitDx: to.exitDx,
                    exitDy: to.exitDy,
                    deltaZ: to.deltaZ,
                    bidirectional: to.bidirectional
                }
            });
        }
        return out;
    }

    /**
     * Hop entity across floors when standing on a first-class stair pad.
     * When `preferredDest.z` is set, only hop if the pad leads to that floor.
     * Lands on the **exact** pad destination (player–player stack or
     * player→creature mixed exception). No spiral free-tile fallback.
     *
     * @param {{ id?: number, tile?: { x: number, y: number, z: string|number } }} entity
     * @param {{ x?: number, y?: number, z?: string|number }|null} [preferredDest]
     * @returns {boolean} true when a hop was performed
     */
    tryUseStair(entity, preferredDest) {
        if (!entity || !entity.tile) return false;
        const dest = this.getStair(entity.tile.x, entity.tile.y, entity.tile.z);
        if (!dest) return false;

        if (preferredDest != null && preferredDest.z !== undefined) {
            if (String(preferredDest.z) !== String(dest.z)) return false;
        }

        return this.moveEntityToTile(entity, dest.x, dest.y, dest.z, {
            reason: 'stair'
        });
    }

    /**
     * Manual hop-on-step: if standing on a stairs/hole pad, tryUseStair.
     * Ladders and rope/shovel pads are skipped. Clears leftover same-floor path.
     * AI / party members (`controlMode === 'ai'`) MUST NOT hop here — they
     * climb via tryUseStair / Party._tryStairHop so same-floor walks do not
     * bounce on paired dest pads. Test stubs with no controlMode still hop.
     * @param {{ id?: number, tile?: { x: number, y: number, z: string|number }, path?: object[], type?: string, controlMode?: string }} entity
     * @returns {boolean}
     */
    tryAutoStairHop(entity) {
        if (!entity || !entity.tile || !isPlayerEntity(entity)) return false;
        if (!playerHopsOnStep(entity)) return false;
        if (!this.hopsOnStepAt(entity.tile.x, entity.tile.y, entity.tile.z)) {
            return false;
        }
        const hopped = this.tryUseStair(entity, null);
        if (hopped && Array.isArray(entity.path)) entity.path = [];
        return hopped;
    }

    /**
     * Nearest free walkable tile around (x,y,z) that `entity` can enter.
     * Spiral by Chebyshev ring (r=0 exact first). Generic helper — **not**
     * used by stairs (exact dest only).
     *
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number }|number|null|undefined} entity
     * @param {{ maxRadius?: number }} [opts]
     * @returns {{ x: number, y: number }|null}
     */
    findNearestFreeTile(x, y, z, entity, opts) {
        const ox = Math.round(Number(x) || 0);
        const oy = Math.round(Number(y) || 0);
        const maxR =
            opts && opts.maxRadius != null
                ? Math.max(0, Math.floor(Number(opts.maxRadius) || 0))
                : 6;
        for (let r = 0; r <= maxR; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (r !== 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) {
                        continue;
                    }
                    const cx = ox + dx;
                    const cy = oy + dy;
                    if (!this.canEnter(cx, cy, z, entity)) continue;
                    return { x: cx, y: cy };
                }
            }
        }
        return null;
    }

    /**
     * Nearest stair pad on `fromZ` whose destination floor is `toZ`.
     * Used by party / long routes to walk up to a stair before hopping.
     *
     * @param {string|number} fromZ
     * @param {string|number} toZ
     * @param {number} [nearX=0]
     * @param {number} [nearY=0]
     * @param {{ hopsOnStepOnly?: boolean }} [opts]
     * @returns {{ x: number, y: number, z: string|number, dest: object }|null}
     */
    findStairToward(fromZ, toZ, nearX, nearY, opts) {
        const hopsOnStepOnly = !!(opts && opts.hopsOnStepOnly);
        const nx = nearX != null ? Math.round(nearX) : 0;
        const ny = nearY != null ? Math.round(nearY) : 0;
        let best = null;
        let bestD = Infinity;
        const keys = Object.keys(this.stairs);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const parts = k.split(',');
            if (parts.length < 3) continue;
            const fx = Number(parts[0]);
            const fy = Number(parts[1]);
            const fz = parts.slice(2).join(',');
            if (String(fz) !== String(fromZ)) continue;
            const dest = this.stairs[k];
            if (!dest || String(dest.z) !== String(toZ)) continue;
            if (hopsOnStepOnly && !hopsOnStep(dest.type)) continue;
            const d = Math.abs(fx - nx) + Math.abs(fy - ny);
            if (d < bestD) {
                bestD = d;
                best = {
                    x: fx,
                    y: fy,
                    z: fz,
                    dest: { x: dest.x, y: dest.y, z: dest.z }
                };
            }
        }
        return best;
    }

    /**
     * Flat index into a layer's friction/occupancy arrays.
     * @param {number} x
     * @param {number} y
     * @param {number} cols
     * @returns {number}
     */
    index(x, y, cols) {
        return y * cols + x;
    }

    /**
     * @param {string|number} z
     * @returns {FloorLayer|null}
     */
    getLayer(z) {
        const key = String(z);
        return this.layers[key] || null;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    inBounds(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = Math.round(x);
        const iy = Math.round(y);
        return ix >= 0 && iy >= 0 && ix < layer.cols && iy < layer.rows;
    }

    /**
     * Friction at tile (x,y,z). Missing layer / OOB → blocked.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {number}
     */
    getFriction(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer) return FRICTION_BLOCKED;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return FRICTION_BLOCKED;
        }
        return layer.friction[this.index(ix, iy, layer.cols)];
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    isWalkable(x, y, z) {
        return this.getFriction(x, y, z) !== FRICTION_BLOCKED;
    }

    /**
     * Whether the tile blocks line of sight / projectiles.
     * Missing layer / OOB → blocked (same as walk OOB).
     * Missing sight buffer → coupled fallback (friction === 255).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    blocksSight(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer) return true;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return true;
        }
        const idx = this.index(ix, iy, layer.cols);
        if (layer.sight) {
            return layer.sight[idx] === SIGHT_BLOCKED;
        }
        return layer.friction[idx] === FRICTION_BLOCKED;
    }

    /**
     * Raw sight byte (0 clear, 255 blocked). OOB / missing → SIGHT_BLOCKED.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {number}
     */
    getSightBlock(x, y, z) {
        return this.blocksSight(x, y, z) ? SIGHT_BLOCKED : SIGHT_CLEAR;
    }

    /**
     * Set sight block for one tile (e.g. dynamic obstacles).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {boolean|number} blocked true/255 block, false/0 clear
     * @returns {boolean}
     */
    setSightBlock(x, y, z, blocked) {
        const layer = this.getLayer(z);
        if (!layer || !layer.friction) return false;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return false;
        }
        if (!layer.sight || layer.sight.length < layer.friction.length) {
            layer.sight = defaultSightFromFriction(layer.friction);
        }
        const idx = this.index(ix, iy, layer.cols);
        const on =
            blocked === true ||
            blocked === SIGHT_BLOCKED ||
            blocked === 1;
        layer.sight[idx] = on ? SIGHT_BLOCKED : SIGHT_CLEAR;
        return true;
    }

    /**
     * Tile flag bits (TILE_FLAG_*). Missing layer / OOB → 0.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {number}
     */
    getTileFlags(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer || !layer.flags) return 0;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return 0;
        }
        return layer.flags[this.index(ix, iy, layer.cols)] & 0xff;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {number} flags
     * @returns {boolean}
     */
    setTileFlags(x, y, z, flags) {
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return false;
        }
        if (!layer.flags || layer.flags.length < layer.friction.length) {
            layer.flags = new Uint8Array(layer.friction.length);
        }
        layer.flags[this.index(ix, iy, layer.cols)] = flags & 0xff;
        return true;
    }

    /**
     * Standing here cannot cast magic / autos (NO_CAST bit).
     * Same bit also gates attack effect on the tile via attackMayAffectTile.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    blocksCast(x, y, z) {
        return (this.getTileFlags(x, y, z) & TILE_FLAG_NO_CAST) !== 0;
    }

    /**
     * Creatures may not enter this tile (NO_CREATURE bit).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    blocksCreatures(x, y, z) {
        return (this.getTileFlags(x, y, z) & TILE_FLAG_NO_CREATURE) !== 0;
    }

    /**
     * Whether a creature may step / path onto the tile under flag rules.
     * Players always pass the flag check (walk still needs isWalkable / stack).
     * Missing / unresolved entity on a NO_CREATURE tile → false (treat as creature).
     *
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number, type?: string }|number|null|undefined} [entity]
     * @returns {boolean}
     */
    creatureMayEnterTile(x, y, z, entity) {
        if (!this.blocksCreatures(x, y, z)) return true;
        if (entity != null && typeof entity === 'object' && isPlayerEntity(entity)) {
            return true;
        }
        const id = entityIdOf(entity);
        const mover = resolveMoverEntity(this, entity, id);
        if (mover && isPlayerEntity(mover)) return true;
        return false;
    }

    /**
     * Whether attack spells / harmful AOE / field deploy may affect this tile.
     * Fails when NO_CAST is set (including full PZ package and legacy green PNG).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    attackMayAffectTile(x, y, z) {
        return (this.getTileFlags(x, y, z) & TILE_FLAG_NO_CAST) === 0;
    }

    /**
     * Full protection-zone package: both NO_CAST and NO_CREATURE set.
     * Pure-green PNG loads set only NO_CAST (single-bit still works).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    isProtectionZonePackage(x, y, z) {
        const f = this.getTileFlags(x, y, z);
        return (f & TILE_FLAG_PZ_PACKAGE) === TILE_FLAG_PZ_PACKAGE;
    }

    /**
     * Sparse stack / noPlayerStack key for a tile.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {string}
     */
    tileStackKey(x, y, z) {
        return String(z) + ':' + Math.round(x) + ':' + Math.round(y);
    }

    /**
     * First combatant entity id at tile, or 0 if empty / OOB / missing layer.
     * Same as historical `getOccupant` (grid cell value).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {number}
     */
    getFirstOccupant(x, y, z) {
        return this.getOccupant(x, y, z);
    }

    /**
     * Occupant entity id at tile, or 0 if empty / OOB / missing layer.
     * With stacks, this is the **first** combatant (join order).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {number}
     */
    getOccupant(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer) return 0;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return 0;
        }
        return layer.occupancy[this.index(ix, iy, layer.cols)] | 0;
    }

    /**
     * Ordered combatant entity ids on the tile (join order). Empty → [].
     * Single occupant → [id]. Stack / mixed → full list (length ≥ 2).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {number[]}
     */
    getCombatants(x, y, z) {
        const first = this.getOccupant(x, y, z);
        if (first === 0) return [];
        const stack = this.playerStacks.get(this.tileStackKey(x, y, z));
        if (stack && stack.length >= 2) return stack.slice();
        return [first];
    }

    /**
     * A* intermediate occupancy under stack / push policy (4C).
     * - free: empty or self
     * - soft: enterable creature tile for canPushCreatures mover (soft step cost)
     * - hard: blocked for this mover
     * Players may path through player-only tiles (free). Creatures hard-block
     * player/mixed tiles; pushable-only tiles are soft when mover may push.
     *
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number, type?: string }|number|null} [mover]
     * @returns {'free'|'soft'|'hard'}
     */
    pathStepOccupancy(x, y, z, mover) {
        const first = this.getOccupant(x, y, z);
        if (first === 0) return 'free';
        const id = entityIdOf(mover);
        if (id !== 0 && first === id) return 'free';
        const combatants = this.getCombatants(x, y, z);
        if (id !== 0 && combatants.indexOf(id) >= 0) return 'free';

        const moverEnt = resolveMoverEntity(this, mover, id);
        if (!moverEnt) return 'hard';

        const occupants = resolveCombatantEntities(this, combatants);
        if (!occupants.length || occupants.length < combatants.length) {
            return 'hard';
        }

        if (isPlayerEntity(moverEnt)) {
            for (let i = 0; i < occupants.length; i++) {
                if (!isPlayerEntity(occupants[i])) return 'hard';
            }
            return 'free';
        }

        // Creature / summon mover
        if (occupantsHavePlayer(occupants)) return 'hard';
        if (!entityCanPushCreatures(moverEnt)) return 'hard';
        for (let i = 0; i < occupants.length; i++) {
            if (!isPushableEntity(occupants[i])) return 'hard';
        }
        return 'soft';
    }

    /**
     * Resolve combatants via `resolveEntity` (Simulator sets resolveEntity).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {object[]}
     */
    getCombatantEntities(x, y, z) {
        const ids = this.getCombatants(x, y, z);
        const out = [];
        for (let i = 0; i < ids.length; i++) {
            const ent = this.resolveOccupant(ids[i]);
            if (ent) out.push(ent);
        }
        return out;
    }

    /**
     * Mark or clear a tile as noPlayerStack (second player denied).
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {boolean} [value=true]
     */
    setNoPlayerStack(x, y, z, value) {
        const key = this.tileStackKey(x, y, z);
        if (value === false) this.noPlayerStackTiles.delete(key);
        else this.noPlayerStackTiles.add(key);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @returns {boolean}
     */
    isNoPlayerStack(x, y, z) {
        return this.noPlayerStackTiles.has(this.tileStackKey(x, y, z));
    }

    /**
     * Whether entity may enter the tile under stack / push policy.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number, type?: string }|number|null} [entity]
     * @param {{ reason?: string }} [opts] `reason: 'stair'` enables mixed player→creature
     * @returns {boolean}
     */
    canEnter(x, y, z, entity, opts) {
        if (!this.isWalkable(x, y, z)) return false;
        // NO_CREATURE: players walk; creatures / bare probes blocked (PZ package).
        if (!this.creatureMayEnterTile(x, y, z, entity)) return false;

        const firstId = this.getOccupant(x, y, z);
        if (firstId === 0) return true;

        const id = entityIdOf(entity);
        if (id !== 0 && firstId === id) return true;

        const combatants = this.getCombatants(x, y, z);
        if (id !== 0 && combatants.indexOf(id) >= 0) return true;

        const mover = resolveMoverEntity(this, entity, id);
        // Bare id / null without resolve: only empty or self (legacy exclusive)
        if (!mover) return false;

        const occupants = resolveCombatantEntities(this, combatants);
        const reason = opts && opts.reason != null ? String(opts.reason) : '';
        const isStair =
            reason === 'stair' ||
            reason === 'floor-change' ||
            reason === 'floor_change';

        if (isPlayerEntity(mover)) {
            return canPlayerEnterTile(this, x, y, z, occupants, isStair);
        }

        // Creature mover: never enter player / mixed; may push pushable creatures
        if (occupantsHavePlayer(occupants)) return false;
        if (!occupants.length) {
            // Occupied in grid but unresolved — hard block for creatures
            return false;
        }
        if (!entityCanPushCreatures(mover)) return false;
        for (let i = 0; i < occupants.length; i++) {
            if (!isPushableEntity(occupants[i])) return false;
        }
        return true;
    }

    /**
     * Claim / join tile occupancy (sole writer with leaveTile).
     * Creature→creature: push or crush targets first, then claim.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number }|number} entity
     * @param {{ reason?: string }} [opts]
     * @returns {boolean}
     */
    enterTile(x, y, z, entity, opts) {
        const id = entityIdOf(entity);
        if (id === 0) return false;
        if (!this.canEnter(x, y, z, entity, opts)) return false;

        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return false;
        }
        const idx = this.index(ix, iy, layer.cols);
        const firstId = layer.occupancy[idx] | 0;

        if (firstId === id) return true;
        const key = this.tileStackKey(ix, iy, z);
        const existing = this.playerStacks.get(key);
        if (existing && existing.indexOf(id) >= 0) return true;

        const mover = resolveMoverEntity(this, entity, id);

        // Creature push/crush before claim
        if (
            firstId !== 0 &&
            mover &&
            !isPlayerEntity(mover) &&
            entityCanPushCreatures(mover)
        ) {
            if (!this._pushCreaturesOnTile(ix, iy, z, mover)) return false;
            // Dest must be empty after push/crush
            if ((layer.occupancy[idx] | 0) !== 0) return false;
        }

        const occNow = layer.occupancy[idx] | 0;
        if (occNow === 0) {
            layer.occupancy[idx] = id;
            return true;
        }
        if (occNow === id) return true;

        // Join stack (players, or stair mixed onto creature)
        let stack = this.playerStacks.get(key);
        if (!stack) {
            stack = [occNow, id];
            this.playerStacks.set(key, stack);
        } else {
            if (stack.indexOf(id) < 0) stack.push(id);
        }
        // Grid keeps first (join order)
        layer.occupancy[idx] = stack[0];
        return true;
    }

    /**
     * Remove entity from tile occupancy; promote stack first when needed.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number }|number} entity
     * @returns {boolean}
     */
    leaveTile(x, y, z, entity) {
        const id = entityIdOf(entity);
        if (id === 0) return false;
        const layer = this.getLayer(z);
        if (!layer) return false;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) {
            return false;
        }
        const idx = this.index(ix, iy, layer.cols);
        const key = this.tileStackKey(ix, iy, z);
        const stack = this.playerStacks.get(key);

        if (stack && stack.length >= 2) {
            const at = stack.indexOf(id);
            if (at < 0) return false;
            stack.splice(at, 1);
            if (stack.length <= 1) {
                this.playerStacks.delete(key);
                layer.occupancy[idx] = stack.length === 1 ? stack[0] : 0;
            } else {
                layer.occupancy[idx] = stack[0];
            }
            return true;
        }

        if ((layer.occupancy[idx] | 0) !== id) return false;
        layer.occupancy[idx] = 0;
        this.playerStacks.delete(key);
        return true;
    }

    /**
     * Thin wrapper → enterTile.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number }|number} entity
     * @param {{ reason?: string }} [opts]
     * @returns {boolean}
     */
    tryOccupy(x, y, z, entity, opts) {
        return this.enterTile(x, y, z, entity, opts);
    }

    /**
     * Thin wrapper → leaveTile.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ id?: number }|number} entity
     * @returns {boolean}
     */
    release(x, y, z, entity) {
        return this.leaveTile(x, y, z, entity);
    }

    /**
     * Clear all occupancy on a floor (or every floor if z omitted).
     * @param {string|number} [z]
     */
    clearOccupancy(z) {
        if (z !== undefined && z !== null) {
            const layer = this.getLayer(z);
            if (layer) layer.occupancy.fill(0);
            const prefix = String(z) + ':';
            for (const key of Array.from(this.playerStacks.keys())) {
                if (key.startsWith(prefix)) this.playerStacks.delete(key);
            }
            return;
        }
        for (const key of Object.keys(this.layers)) {
            this.layers[key].occupancy.fill(0);
        }
        this.playerStacks.clear();
    }

    /**
     * Get the bitmask of active elemental fields on a tile.
     * @param {number} x
     * @param {number} y
     * @param {string|number} [z='0']
     * @returns {number}
     */
    getTileFieldMask(x, y, z) {
        const layer = this.getLayer(z);
        if (!layer || !layer.fields) return 0;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return 0;
        return layer.fields[this.index(ix, iy, layer.cols)];
    }

    /**
     * Set the bitmask of active elemental fields on a tile.
     * @param {number} x
     * @param {number} y
     * @param {string|number} [z='0']
     * @param {number} [mask=0]
     */
    setTileFieldMask(x, y, z, mask) {
        const layer = this.getLayer(z);
        if (!layer) return;
        if (!layer.fields && layer.cols && layer.rows) {
            layer.fields = new Uint8Array(layer.cols * layer.rows);
        }
        if (!layer.fields) return;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return;
        layer.fields[this.index(ix, iy, layer.cols)] = Number(mask) & 0xff;
    }

    /**
     * Short-path A* (Stage 2). Thin wrapper over Pathfinder.findPath.
     *
     * @param {{ x: number, y: number, z?: string|number }} start
     * @param {{ x: number, y: number, z?: string|number }} end
     * @param {boolean|object} [allowDiagonalOrOptions=true]
     *   If boolean: allowDiagonal. If object: full FindPathOptions.
     * @param {boolean} [checkOccupied=false] Ignored when 3rd arg is options object
     * @param {number} [maxDistance]
     * @param {number} [maxIterations]
     * @returns {{ x: number, y: number }[]|null} Inclusive path, or null
     */
    search(
        start,
        end,
        allowDiagonalOrOptions,
        checkOccupied,
        maxDistance,
        maxIterations
    ) {
        /** @type {import('../lib/pathfinder.js').FindPathOptions} */
        let options;
        if (
            allowDiagonalOrOptions !== null &&
            typeof allowDiagonalOrOptions === 'object'
        ) {
            options = allowDiagonalOrOptions;
        } else {
            options = {
                allowDiagonal:
                    allowDiagonalOrOptions === undefined
                        ? true
                        : !!allowDiagonalOrOptions,
                checkOccupied: !!checkOccupied
            };
            if (maxDistance !== undefined) options.maxDistance = maxDistance;
            if (maxIterations !== undefined) options.maxIterations = maxIterations;
        }
        if (start && end && start.z === undefined && end.z !== undefined) {
            start = { x: start.x, y: start.y, z: end.z };
        }
        return findPath(this, start, end, options);
    }

    /**
     * Move entity one tile if enter policy allows (stack join, push, or empty).
     * Updates occupancy, entity.tile, and moveDelay (Stage 3) on success.
     *
     * Logic tile + occupancy transfer instantly. Presentation (`entity.x`/`y`)
     * slides over moveDelay for adjacent same-floor steps (legacy sprite
     * slide); stairs / multi-tile jumps snap via syncPositionFromTile.
     *
     * @param {{
     *   id?: number,
     *   tile?: { x: number, y: number, z: string|number },
     *   speed?: number,
     *   moveDelay?: number,
     *   syncPositionFromTile?: Function
     * }} entity
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ reason?: string }} [opts]
     * @returns {boolean}
     */
    moveEntityToTile(entity, x, y, z, opts) {
        if (!entity) return false;
        const id = entityIdOf(entity);
        if (id === 0) return false;
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (!this.canEnter(ix, iy, z, entity, opts)) return false;

        const prev = entity.tile
            ? { x: entity.tile.x, y: entity.tile.y, z: entity.tile.z }
            : null;
        if (prev && (prev.x !== ix || prev.y !== iy || String(prev.z) !== String(z))) {
            this.leaveTile(prev.x, prev.y, prev.z, entity);
        }

        if (!this.enterTile(ix, iy, z, entity, opts)) {
            // Restore previous occupancy if we released it
            if (prev && (prev.x !== ix || prev.y !== iy || String(prev.z) !== String(z))) {
                this.enterTile(prev.x, prev.y, prev.z, entity);
            }
            return false;
        }

        entity.tile = { x: ix, y: iy, z };
        this._finalizeTileMove(entity, prev);
        const reason = opts && opts.reason;
        if (reason !== 'stair') {
            this.tryAutoStairHop(entity);
        }
        return true;
    }

    /**
     * Apply moveDelay, presentation slide, and host spatial hook after a
     * successful occupancy transfer.
     * @param {object} entity
     * @param {{ x: number, y: number, z: string|number }|null} prev
     * @private
     */
    _finalizeTileMove(entity, prev) {
        const ix = entity.tile.x;
        const iy = entity.tile.y;
        const z = entity.tile.z;
        const friction = this.getFriction(ix, iy, z);
        const speed =
            entity.speed != null
                ? entity.speed
                : Settings.DEFAULT_ENTITY_SPEED != null
                  ? Settings.DEFAULT_ENTITY_SPEED
                  : 110;
        const diagonal =
            prev != null && isDiagonalStep(prev.x, prev.y, ix, iy);
        entity.moveDelay = computeMoveDelay(friction, speed, diagonal);

        // Watch-mode sprite facing (left/right flip) even when the step snaps
        // instead of sliding (stairs, multi-tile jumps). beginStepVisual also
        // calls this for slide paths; idempotent.
        if (prev) updateSpriteFacing(entity, prev);

        if (isAdjacentStep(prev, entity.tile) && entity.moveDelay > 0) {
            beginStepVisual(entity, prev, entity.moveDelay);
        } else if (typeof entity.syncPositionFromTile === 'function') {
            entity.syncPositionFromTile();
        } else {
            snapVisualToTile(entity);
        }

        const store = this.groundStore || this.groundItems;
        if (store) {
            onEntityTileTransition(entity, prev, entity.tile, store, Time.timeSinceLevelLoad);
            onWorldPinStep(entity, prev, entity.tile, store, Time.timeSinceLevelLoad);
        }

        if (typeof this.onEntityTileMoved === 'function') {
            this.onEntityTileMoved(entity, prev, entity.tile);
        }
    }

    /**
     * Resolve an occupancy id to a live entity (Simulator sets resolveEntity).
     * @param {number} id
     * @returns {object|null}
     */
    resolveOccupant(id) {
        const n = id | 0;
        if (n <= 0) return null;
        if (typeof this.resolveEntity === 'function') {
            return this.resolveEntity(n) || null;
        }
        return null;
    }

    /**
     * Shove or crush every creature on (x,y,z) so the mover can claim the tile.
     * Orthogonal N/W/E/S only (shuffled). Failed shove → crush when enabled.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {object} mover
     * @returns {boolean} true when the tile is empty afterward
     * @private
     */
    _pushCreaturesOnTile(x, y, z, mover) {
        const ids = this.getCombatants(x, y, z);
        // Top-down / reverse stack order (legacy pushCreatures)
        for (let i = ids.length - 1; i >= 0; i--) {
            const tid = ids[i];
            if (tid === entityIdOf(mover)) continue;
            const target = this.resolveOccupant(tid);
            if (!target) {
                // Unresolved id: cannot push safely
                return false;
            }
            if (isPlayerEntity(target) || !isPushableEntity(target)) {
                return false;
            }
            if (!this._tryShoveOrthogonal(target)) {
                const crushOn =
                    Settings.CREATURE_PUSH_CRUSH == null
                        ? true
                        : !!Settings.CREATURE_PUSH_CRUSH;
                if (!crushOn) return false;
                this._crushCreature(target);
            }
        }
        return this.getOccupant(x, y, z) === 0;
    }

    /**
     * Try orthogonal shove of target onto a free neighbor (N,W,E,S shuffled).
     * @param {object} target
     * @returns {boolean}
     * @private
     */
    _tryShoveOrthogonal(target) {
        if (!target || !target.tile) return false;
        const dirs = [
            [0, -1],
            [-1, 0],
            [1, 0],
            [0, 1]
        ];
        // Fisher–Yates; Math.random is seeded during sim logic
        for (let i = dirs.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0;
            const tmp = dirs[i];
            dirs[i] = dirs[j];
            dirs[j] = tmp;
        }
        const z = target.tile.z;
        const bx = target.tile.x;
        const by = target.tile.y;
        for (let i = 0; i < dirs.length; i++) {
            const nx = bx + dirs[i][0];
            const ny = by + dirs[i][1];
            if (!this.canEnter(nx, ny, z, target)) continue;
            if (this.moveEntityToTile(target, nx, ny, z)) {
                target.path = [];
                return true;
            }
        }
        return false;
    }

    /**
     * Zero HP and leave tile (crush after failed shove).
     * @param {object} target
     * @private
     */
    _crushCreature(target) {
        if (!target) return;
        if (target.hp && typeof target.hp === 'object') {
            target.hp.current = 0;
        }
        target.alive = false;
        if (target.tile) {
            this.leaveTile(target.tile.x, target.tile.y, target.tile.z, target);
        }
    }

    /**
     * Step entity toward (targetX, targetY, targetZ) using cached path + A*.
     * Re-paths when the target changes or a step is blocked (one retry).
     * Party members stack through corridors (no ally swap/yield).
     * Creatures with canPushCreatures push/crush on step into pushable tiles.
     *
     * Entity shape (Stage 2 minimal):
     *   { id, tile: {x,y,z}, path: PathPoint[] }
     *
     * @param {{ id?: number, tile: { x: number, y: number, z: string|number }, path?: { x: number, y: number }[] }} entity
     * @param {number} targetX
     * @param {number} targetY
     * @param {string|number} targetZ
     * @param {number} [maxDistance]
     * @param {number} [retries=0] Internal repath counter
     * @returns {boolean} true if a step was taken or path already complete
     */
    followPath(entity, targetX, targetY, targetZ, maxDistance, retries) {
        if (!entity || !entity.tile) return false;
        if (!Array.isArray(entity.path)) entity.path = [];

        const tx = Math.round(targetX);
        const ty = Math.round(targetY);
        const tz =
            targetZ !== undefined && targetZ !== null
                ? targetZ
                : entity.tile.z;
        // Same-floor only. Cross-floor: clear path, no A* on wrong floor (E5).
        // Stairs / multi-z routes must use tryUseStair or followLongPath.
        if (String(entity.tile.z) !== String(tz)) {
            entity.path = [];
            return false;
        }
        const cap =
            maxDistance !== undefined
                ? maxDistance
                : Settings.PATH_MAX_DISTANCE != null
                  ? Settings.PATH_MAX_DISTANCE
                  : 100;
        const attempt = retries | 0;
        const now =
            Time && Time.timeSinceLevelLoad != null
                ? Number(Time.timeSinceLevelLoad)
                : 0;

        // New goal tile clears critical fail-backoff (E4)
        if (
            entity._repathGoalX !== tx ||
            entity._repathGoalY !== ty ||
            String(entity._repathGoalZ) !== String(tz)
        ) {
            entity._repathFailBackoffUntil = null;
            entity._repathGoalX = tx;
            entity._repathGoalY = ty;
            entity._repathGoalZ = tz;
        }

        const last = entity.path.length
            ? entity.path[entity.path.length - 1]
            : null;
        const needRepath =
            !last ||
            last.x !== tx ||
            last.y !== ty ||
            String(entity.tile.z) !== String(tz);

        if (needRepath) {
            // F2: free adjacent goal → direct step (flee / circle / random / melee hug).
            // Avoids a full A* package every micro-step when path is empty.
            // Blocked adjacent still falls through so A* can detour.
            // Include z so isAdjacentStep same-floor check matches (omit → false).
            if (
                isAdjacentStep(entity.tile, { x: tx, y: ty, z: tz }) &&
                this.canEnter(tx, ty, tz, entity)
            ) {
                entity.path = [];
                entity._repathFailBackoffUntil = null;
                if (this.moveEntityToTile(entity, tx, ty, tz)) {
                    return entity.tile.x === tx && entity.tile.y === ty;
                }
            }

            // One repath package = one A* (4C + 13C). Critical = empty / blocked retry.
            // Optional moving-goal: AI_REPATH_INTERVAL_SEC (wins if > 0) else ticks;
            // then AI_PATH_BUDGET_PER_FRAME (skip keeps stale path).
            const hasPath = entity.path.length > 0;
            const critical = !hasPath || attempt > 0;
            const failBackoff =
                Settings.AI_REPATH_FAIL_BACKOFF_SEC != null
                    ? Number(Settings.AI_REPATH_FAIL_BACKOFF_SEC)
                    : 0.25;
            // Provocation / leash mayCross upgrades hard-field fail to soft mode —
            // clear fail-backoff so a prior unprovoked wall does not trap the entity.
            if (critical && canCrossFieldHazards(entity, now)) {
                entity._repathFailBackoffUntil = null;
            }
            const inFailBackoff =
                critical &&
                entity._repathFailBackoffUntil != null &&
                Number.isFinite(entity._repathFailBackoffUntil) &&
                now < entity._repathFailBackoffUntil;

            let due = false;
            if (critical) {
                due = !inFailBackoff;
            } else {
                const repathSec =
                    Settings.AI_REPATH_INTERVAL_SEC != null
                        ? Number(Settings.AI_REPATH_INTERVAL_SEC)
                        : 0;
                if (Number.isFinite(repathSec) && repathSec > 0) {
                    due = isLogicIntervalDue(
                        entity,
                        '_repathNextAt',
                        repathSec,
                        now
                    );
                } else {
                    const repathTicks =
                        Settings.AI_REPATH_INTERVAL_TICKS != null
                            ? Number(Settings.AI_REPATH_INTERVAL_TICKS)
                            : 1;
                    due = isTickDue(entity, '_repathReg', repathTicks);
                }
            }

            if (due && takePathBudget({ critical })) {
                const fieldOpts = computeEntityAvoidFieldMask(entity);
                const avoidMask = fieldOpts.avoidFieldMask || 0;
                const fieldPenaltyVal =
                    Settings.AI_FIELD_STEP_PENALTY != null
                        ? Number(Settings.AI_FIELD_STEP_PENALTY)
                        : 10;
                const occupantPenalty =
                    Settings.AI_OCCUPANT_STEP_PENALTY != null
                        ? Number(Settings.AI_OCCUPANT_STEP_PENALTY)
                        : 4;
                const cacheSec =
                    Settings.AI_HAZARD_CACHE_SEC != null
                        ? Number(Settings.AI_HAZARD_CACHE_SEC)
                        : 2.0;

                // 13C: unprovoked → hard field avoid; canCross → soft in same search
                let fieldPenalty = 0;
                if (avoidMask > 0 && canCrossFieldHazards(entity, now)) {
                    fieldPenalty = fieldPenaltyVal;
                }

                /** @type {import('../lib/pathfinder.js').FindPathOptions} */
                const searchOpts = {
                    allowDiagonal: true,
                    maxDistance: cap,
                    avoidFieldMask: avoidMask,
                    ignorePlayerFields: fieldOpts.ignorePlayerFields,
                    fieldPenalty,
                    mover: entity,
                    useStackPolicy: true,
                    occupantStepPenalty: occupantPenalty
                };

                const path = this.search(
                    entity.tile,
                    { x: tx, y: ty, z: tz },
                    searchOpts
                );

                if (path && path.length > 0) {
                    entity.path = path.slice(1);
                    entity._repathFailBackoffUntil = null;
                    if (fieldPenalty > 0) {
                        entity._hazardRouteUntil = now + cacheSec;
                    }
                } else {
                    entity.path = [];
                    if (
                        critical &&
                        Number.isFinite(failBackoff) &&
                        failBackoff > 0
                    ) {
                        entity._repathFailBackoffUntil = now + failBackoff;
                        noteFailBackoff();
                    }
                }
            }
            // else: keep stale path (optional throttle / budget / fail-backoff)
        }

        if (entity.path.length === 0) {
            if (entity.tile.x === tx && entity.tile.y === ty) return true;
            // No path: if adjacent to goal and enter policy allows (stack / push), step in
            if (isAdjacentStep(entity.tile, { x: tx, y: ty, z: tz })) {
                if (this.moveEntityToTile(entity, tx, ty, tz)) {
                    return entity.tile.x === tx && entity.tile.y === ty;
                }
            }
            return false;
        }

        const step = entity.path[0];
        if (step.x === entity.tile.x && step.y === entity.tile.y) {
            entity.path.shift();
            return true;
        }

        // Always step on the entity's current floor (path is same-floor).
        const stepZ = entity.tile.z;
        const moved = this.moveEntityToTile(entity, step.x, step.y, stepZ);
        if (moved) {
            entity.path.shift();
            return true;
        }

        // Blocked step → clear and one critical repath (force throttle due)
        if (attempt === 0) {
            entity.path = [];
            entity._repathFailBackoffUntil = null;
            forceDue(entity, '_repathReg');
            forceDue(entity, '_repathNextAt');
            return this.followPath(entity, tx, ty, tz, cap, 1);
        }
        return false;
    }

    /**
     * Long path via local A* and optional navmesh (Stage 10).
     * Prefer this for UI/cross-map requests; combat micro-steps keep using search().
     *
     * @param {{ x: number, y: number, z?: string|number }} start
     * @param {{ x: number, y: number, z?: string|number }} end
     * @param {object} [options] findLongPath options; navmesh defaults to this.navmesh
     * @returns {{
     *   path: { x: number, y: number, z: string|number }[]|null,
     *   mode: string,
     *   anchors?: object[],
     *   reason?: string
     * }}
     */
    findLongPath(start, end, options) {
        const opts = Object.assign({}, options || {});
        if (opts.navmesh === undefined) opts.navmesh = this.navmesh;
        return findLongPath(this, start, end, opts);
    }

    /**
     * Like followPath, but seeds entity.path from findLongPath when a single
     * local search would fail (navmesh segmented routes).
     *
     * @param {{ id?: number, tile: { x: number, y: number, z: string|number }, path?: { x: number, y: number }[] }} entity
     * @param {number} targetX
     * @param {number} targetY
     * @param {string|number} targetZ
     * @param {object} [longOptions] passed to findLongPath on repath
     * @param {number} [retries=0]
     * @returns {boolean}
     */
    followLongPath(entity, targetX, targetY, targetZ, longOptions, retries) {
        if (!entity || !entity.tile) return false;
        if (!Array.isArray(entity.path)) entity.path = [];

        const tx = Math.round(targetX);
        const ty = Math.round(targetY);
        const tz = targetZ;
        const attempt = retries | 0;

        const last = entity.path.length ? entity.path[entity.path.length - 1] : null;
        const lastZ = last && last.z !== undefined ? last.z : entity.tile.z;
        const needRepath =
            !last ||
            last.x !== tx ||
            last.y !== ty ||
            String(lastZ) !== String(tz);

        if (needRepath) {
            const result = this.findLongPath(
                entity.tile,
                { x: tx, y: ty, z: tz },
                longOptions
            );
            if (result.path && result.path.length > 0) {
                // Keep z so multi-floor stair hops in the expanded path work
                entity.path = result.path.slice(1).map((p) => ({
                    x: p.x,
                    y: p.y,
                    z: p.z !== undefined ? p.z : entity.tile.z
                }));
            } else {
                entity.path = [];
            }
        }

        if (entity.path.length === 0) {
            return (
                entity.tile.x === tx &&
                entity.tile.y === ty &&
                String(entity.tile.z) === String(tz)
            );
        }

        const step = entity.path[0];
        const stepZ = step.z !== undefined ? step.z : entity.tile.z;
        if (
            step.x === entity.tile.x &&
            step.y === entity.tile.y &&
            String(entity.tile.z) === String(stepZ)
        ) {
            entity.path.shift();
            return true;
        }

        // Stage 12H: cross-floor path step → first-class stair hop
        if (String(entity.tile.z) !== String(stepZ)) {
            const hopped = this.tryUseStair(entity, {
                x: step.x,
                y: step.y,
                z: stepZ
            });
            if (hopped) {
                if (
                    entity.tile.x === step.x &&
                    entity.tile.y === step.y &&
                    String(entity.tile.z) === String(stepZ)
                ) {
                    entity.path.shift();
                }
                return true;
            }
            // Authored multi-floor path with no pad underfoot: direct transfer
            // when the next anchor is already the destination tile
            const movedCross = this.moveEntityToTile(
                entity,
                step.x,
                step.y,
                stepZ
            );
            if (movedCross) {
                entity.path.shift();
                return true;
            }
            if (attempt === 0) {
                entity.path = [];
                return this.followLongPath(entity, tx, ty, tz, longOptions, 1);
            }
            return false;
        }

        const moved = this.moveEntityToTile(entity, step.x, step.y, stepZ);
        if (moved) {
            entity.path.shift();
            return true;
        }

        if (attempt === 0) {
            entity.path = [];
            return this.followLongPath(entity, tx, ty, tz, longOptions, 1);
        }
        return false;
    }

    /**
     * Install a floor from raw RGBA bytes (length must be cols*rows*4).
     * Used by loadFloor and unit tests — no nested tile objects.
     *
     * @param {string|number} z
     * @param {number} cols
     * @param {number} rows
     * @param {Uint8Array|Buffer|Uint8ClampedArray} rgba
     * @returns {FloorLayer}
     */
    loadFloorFromRgba(z, cols, rows, rgba) {
        const n = cols * rows;
        if (!rgba || rgba.length < n * 4) {
            throw new Error(
                `loadFloorFromRgba: expected ${n * 4} bytes, got ${rgba ? rgba.length : 0}`
            );
        }
        const friction = new Uint8Array(n);
        const sight = new Uint8Array(n);
        const flags = new Uint8Array(n);
        const occupancy = new Int32Array(n);
        const fields = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const o = i * 4;
            const c = collisionFromPixel(rgba[o], rgba[o + 1], rgba[o + 2]);
            friction[i] = c.friction;
            sight[i] = c.sight;
            flags[i] = c.flags;
        }
        const layer = { cols, rows, friction, sight, flags, occupancy, fields };
        this.layers[String(z)] = layer;
        this.invalidateRenderCache();
        return layer;
    }

    /**
     * Install a floor from a flat friction grid (Stage 11.3 stitch output).
     * Copies the buffer; does not retain the caller's reference.
     * Optional `opts.sight` / `opts.flags` copy in; otherwise sight defaults to
     * "blocked walk ⇒ blocked sight" and flags are zero.
     *
     * @param {string|number} z
     * @param {number} cols
     * @param {number} rows
     * @param {Uint8Array|Buffer|ArrayLike<number>} friction length cols*rows
     * @param {{
     *   sight?: Uint8Array|ArrayLike<number>|null,
     *   flags?: Uint8Array|ArrayLike<number>|null
     * }} [opts]
     * @returns {FloorLayer}
     */
    loadFloorFromFriction(z, cols, rows, friction, opts) {
        const n = cols * rows;
        if (!friction || friction.length < n) {
            throw new Error(
                `loadFloorFromFriction: expected ${n} bytes, got ${friction ? friction.length : 0}`
            );
        }
        const o = opts || {};
        const copy = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const v = friction[i] & 0xff;
            copy[i] = v;
        }
        let sight;
        if (o.sight && o.sight.length >= n) {
            sight = new Uint8Array(n);
            for (let i = 0; i < n; i++) sight[i] = o.sight[i] & 0xff;
        } else {
            sight = defaultSightFromFriction(copy);
        }
        const flags = new Uint8Array(n);
        if (o.flags && o.flags.length >= n) {
            for (let i = 0; i < n; i++) flags[i] = o.flags[i] & 0xff;
        }
        const occupancy = new Int32Array(n);
        const fields = new Uint8Array(n);
        const layer = {
            cols,
            rows,
            friction: copy,
            sight,
            flags,
            occupancy,
            fields
        };
        this.layers[String(z)] = layer;
        this.invalidateRenderCache();
        return layer;
    }

    /**
     * Stage 11.9: attach a decorative art layer for floor z.
     * Does not affect collision. Palette[0] is empty (void).
     *
     * @param {string|number} z
     * @param {{
     *   cols: number,
     *   rows: number,
     *   palette: string[],
     *   roleIds?: string[],
     *   renders?: Array<object|null>,
     *   influences?: Array<object|null>,
     *   cells: Uint16Array|ArrayLike<number>,
     *   artSet?: string,
     *   genre?: string|null,
     *   kind?: string
     * }} art
     * @returns {ArtFloorLayer|null}
     */
    setArtLayer(z, art) {
        if (!art || !art.palette || !art.cells) return null;
        const cols = art.cols | 0;
        const rows = art.rows | 0;
        if (cols < 1 || rows < 1) return null;
        const n = cols * rows;
        const src = art.cells;
        /** @type {Uint16Array|null} */
        let cells = null;
        if (src instanceof Uint16Array) {
            if (src.length < n) return null;
            cells = src.length === n ? src : src.subarray(0, n);
        } else if (ArrayBuffer.isView(src)) {
            const viewLen = src.byteLength / (src.BYTES_PER_ELEMENT || 1);
            if (viewLen < n) return null;
            cells = new Uint16Array(n);
            for (let i = 0; i < n; i++) cells[i] = src[i] & 0xffff;
        } else if (Array.isArray(src)) {
            if (src.length < n) return null;
            cells = new Uint16Array(n);
            for (let i = 0; i < n; i++) cells[i] = src[i] & 0xffff;
        } else if (typeof src === 'object') {
            // Defensive: JSON-cloned TypedArray is a number-keyed object without
            // `.length`. Uint16Array.from(that) yields empty → blank art paint.
            cells = new Uint16Array(n);
            for (let i = 0; i < n; i++) cells[i] = src[i] & 0xffff;
        } else {
            return null;
        }
        const layer = {
            cols,
            rows,
            palette: art.palette.slice(),
            cells,
            artSet: art.artSet != null ? String(art.artSet) : null,
            genre: art.genre != null ? String(art.genre) : null,
            kind: art.kind != null ? String(art.kind) : 'tiles'
        };
        if (Array.isArray(art.roleIds)) {
            layer.roleIds = art.roleIds.slice();
        }
        if (Array.isArray(art.renders)) {
            layer.renders = art.renders.slice();
        }
        if (Array.isArray(art.influences)) {
            layer.influences = art.influences.slice();
        }
        this.artLayers[String(z)] = layer;
        this.invalidateRenderCache();
        return layer;
    }

    /**
     * @param {string|number} z
     * @returns {ArtFloorLayer|null}
     */
    getArtLayer(z) {
        return this.artLayers[String(z)] || null;
    }

    /**
     * Tile catalog id at (x,y,z), or null.
     * @param {number} x
     * @param {number} y
     * @param {string|number} [z]
     * @returns {string|null}
     */
    artTileIdAt(x, y, z) {
        const keys = Object.keys(this.artLayers);
        const zz =
            z !== undefined && z !== null
                ? String(z)
                : keys.length
                  ? keys[0]
                  : null;
        if (zz == null) return null;
        const layer = this.artLayers[zz];
        if (!layer) return null;
        const xi = Math.round(Number(x));
        const yi = Math.round(Number(y));
        if (xi < 0 || yi < 0 || xi >= layer.cols || yi >= layer.rows) {
            return null;
        }
        const idx = layer.cells[yi * layer.cols + xi] | 0;
        if (idx <= 0 || idx >= layer.palette.length) return null;
        return layer.palette[idx] || null;
    }

    /**
     * Load a collision path PNG for floor z.
     * - Node: `pathPng` is a filesystem path (pngjs, no OpenCV).
     * - Browser: `pathPng` is a URL (or data URL); decoded via Image + canvas.
     *
     * @param {string|number} z
     * @param {string} pathPng
     * @returns {Promise<FloorLayer>}
     */
    async loadFloor(z, pathPng) {
        if (!pathPng) {
            throw new Error('loadFloor: pathPng is required');
        }
        const { cols, rows, rgba } = await decodePathPng(pathPng);
        return this.loadFloorFromRgba(z, cols, rows, rgba);
    }

    /**
     * Allocate an offscreen surface for the static floor cache.
     * Override in tests (`map._allocRenderCache = …`). Returns null → direct paint.
     *
     * @param {number} pixelW
     * @param {number} pixelH
     * @returns {{ canvas: *, ctx: * }|null}
     */
    _allocRenderCache(pixelW, pixelH) {
        const w = Math.max(1, pixelW | 0);
        const h = Math.max(1, pixelH | 0);
        if (typeof OffscreenCanvas !== 'undefined') {
            try {
                const canvas = new OffscreenCanvas(w, h);
                const ctx = canvas.getContext('2d');
                if (ctx) return { canvas, ctx };
            } catch (_e) {
                /* fall through */
            }
        }
        if (typeof document !== 'undefined' && document.createElement) {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (ctx) return { canvas, ctx };
            } catch (_e) {
                /* fall through */
            }
        }
        return null;
    }

    /**
     * Resolve sprite folder: Engine Tweakings override, else placement/role, else size default.
     * @param {string|null|undefined} explicit
     * @returns {string}
     * @private
     */
    _tileDrawVariant(explicit) {
        const sprites = tileSpriteApi();
        if (sprites && typeof sprites.resolveTileVariantForDisplay === 'function') {
            return sprites.resolveTileVariantForDisplay(explicit);
        }
        if (sprites && typeof sprites.defaultTileVariantForDisplay === 'function') {
            return sprites.defaultTileVariantForDisplay();
        }
        return explicit && String(explicit).trim() ? String(explicit).trim() : 'icon';
    }

    /**
     * Catalog tile sprite lookup + palette prefetch (browser watch).
     * @param {ArtFloorLayer|null} art
     * @returns {((tileId: string, variant?: string|null) => *)|null}
     */
    _artTileImageGetter(art) {
        if (!art || Settings.useEntitySprites === false) return null;
        const sprites = tileSpriteApi();
        if (!sprites) return null;
        const genre = art.genre || DEFAULT_GENRE;
        const kind = art.kind || 'tiles';
        const roleIds = Array.isArray(art.roleIds) ? art.roleIds : null;
        if (typeof sprites.prefetchSprite === 'function') {
            for (let p = 1; p < art.palette.length; p++) {
                const tid = art.palette[p];
                if (!tid) continue;
                const placement = this._artPalettePlacement(art, p);
                const role = roleIds
                    ? this._roleForPlacement(placement)
                    : null;
                const meta = resolvePlacementRender(placement, role);
                sprites.prefetchSprite({
                    genre,
                    kind,
                    id: tid,
                    variant: this._tileDrawVariant(meta.variant)
                });
            }
        }
        const getImg = (tileId, variant) => {
            if (!tileId) return null;
            return sprites.getReadySpriteImage({
                genre,
                kind,
                id: tileId,
                variant: this._tileDrawVariant(variant)
            });
        };
        getImg.isPending = (tileId, variant) => {
            if (!tileId || typeof sprites.isSpritePending !== 'function') {
                return false;
            }
            return sprites.isSpritePending({
                genre,
                kind,
                id: tileId,
                variant: this._tileDrawVariant(variant)
            });
        };
        return getImg;
    }

    /**
     * Catalog image lookup for hybrid placements (tiles + objects).
     * Prefetches palette entries. Returns null when sprites unavailable.
     *
     * @param {object|null} authoringFloor
     * @param {string|null|undefined} [genre]
     * @returns {((catalogId: string, kind: string, variant?: string|null) => *)|null}
     */
    _authoringImageGetter(authoringFloor, genre) {
        if (!authoringFloor || Settings.useEntitySprites === false) return null;
        const sprites = tileSpriteApi();
        if (!sprites || typeof sprites.getReadySpriteImage !== 'function') {
            return null;
        }
        const g0 = genre || DEFAULT_GENRE;
        const palette = authoringFloor.palette || [];
        const kindOf = (kind) =>
            kind === 'overlays'
                ? 'overlays'
                : kind === 'objects'
                  ? 'objects'
                  : 'tiles';
        if (typeof sprites.prefetchSprite === 'function') {
            for (let p = 1; p < palette.length; p++) {
                const entry = palette[p];
                if (!entry) continue;
                const id =
                    entry.catalogId != null
                        ? String(entry.catalogId)
                        : entry.id != null
                          ? String(entry.id)
                          : '';
                if (!id) continue;
                const kind = kindOf(entry.kind);
                const meta = resolvePlacementRender(
                    entry,
                    this._roleForPlacement(entry)
                );
                sprites.prefetchSprite({
                    genre: g0,
                    kind,
                    id,
                    variant: this._tileDrawVariant(meta.variant)
                });
            }
        }
        const getImg = (catalogId, kind, variant) => {
            if (!catalogId) return null;
            return sprites.getReadySpriteImage({
                genre: g0,
                kind: kindOf(kind),
                id: catalogId,
                variant: this._tileDrawVariant(variant)
            });
        };
        getImg.isPending = (catalogId, kind, variant) => {
            if (!catalogId || typeof sprites.isSpritePending !== 'function') {
                return false;
            }
            return sprites.isSpritePending({
                genre: g0,
                kind: kindOf(kind),
                id: catalogId,
                variant: this._tileDrawVariant(variant)
            });
        };
        return getImg;
    }

    /**
     * Resolve role document for a placement (optional catalog).
     * @param {object|null|undefined} placement
     * @returns {object|null}
     */
    _roleForPlacement(placement) {
        if (!placement || !placement.roleId || !this.tileRoleCatalog) return null;
        const rid = String(placement.roleId);
        const cat = this.tileRoleCatalog;
        if (typeof cat.get === 'function') return cat.get(rid) || null;
        return cat[rid] || null;
    }

    /**
     * Rebuild a placement-shaped object from an artLayers palette slot
     * (catalog id + role + optional art-set render override).
     * @param {ArtFloorLayer} art
     * @param {number} pIdx
     * @returns {object}
     * @private
     */
    _artPalettePlacement(art, pIdx) {
        const render =
            art && Array.isArray(art.renders) && art.renders[pIdx]
                ? art.renders[pIdx]
                : null;
        const roleId =
            art && art.roleIds && art.roleIds[pIdx]
                ? String(art.roleIds[pIdx])
                : '';
        /** @type {object} */
        const placement = {
            catalogId:
                art && art.palette && pIdx > 0 && pIdx < art.palette.length
                    ? art.palette[pIdx]
                    : '',
            kind: (art && art.kind) || 'tiles',
            roleId
        };
        if (render) {
            if (render.scale != null) placement.scale = render.scale;
            if (render.anchor) placement.anchor = render.anchor;
            if (render.variant) placement.variant = render.variant;
        }
        return placement;
    }

    /**
     * Paint ground+path stamps from authoring floor into local tile space.
     * Tall props are excluded (y-sorted with entities later).
     *
     * @param {*} g
     * @param {FloorLayer} layer
     * @param {object} authoring
     * @param {((id: string, kind: string) => *)|null} getImg
     * @param {number} regionX
     * @param {number} regionY
     * @param {number} regionW
     * @param {number} regionH
     * @param {number} tw
     * @param {number} th
     * @returns {boolean} pendingSprites
     * @private
     */
    _paintTerrainAuthoringRegion(
        g,
        layer,
        authoring,
        getImg,
        regionX,
        regionY,
        regionW,
        regionH,
        tw,
        th
    ) {
        let pendingSprites = false;
        const cols = authoring.cols | 0;
        const rows = authoring.rows | 0;
        const palette = authoring.palette || [];
        /** @type {Map<string, object>} */
        const subById = new Map();
        if (Array.isArray(authoring.subLayers)) {
            for (let i = 0; i < authoring.subLayers.length; i++) {
                const sl = authoring.subLayers[i];
                if (sl && sl.id) subById.set(String(sl.id), sl);
            }
        }

        for (let ry = 0; ry < regionH; ry++) {
            const y = regionY + ry;
            if (y < 0 || y >= layer.rows || y >= rows) continue;
            for (let rx = 0; rx < regionW; rx++) {
                const x = regionX + rx;
                if (x < 0 || x >= layer.cols || x >= cols) continue;
                const flat = this.index(x, y, layer.cols);
                const f = layer.friction[flat];
                const tilePx = rx * tw;
                const tilePy = ry * th;

                // Always seed with friction gray so empty authoring still reads.
                g.fillStyle =
                    FRICTION_FILL_STYLE[f] || FRICTION_FILL_STYLE[FRICTION_BLOCKED];
                g.fillRect(tilePx, tilePy, tw, th);

                if (!getImg) continue;

                for (let t = 0; t < TERRAIN_SUB_LAYER_IDS.length; t++) {
                    const sid = TERRAIN_SUB_LAYER_IDS[t];
                    const sl = subById.get(sid);
                    if (!sl || !sl.cells) continue;
                    const pIdx = sl.cells[y * cols + x] | 0;
                    if (pIdx <= 0 || pIdx >= palette.length) continue;
                    const placement = palette[pIdx];
                    if (!placement) continue;
                    const meta = resolvePlacementRender(
                        placement,
                        this._roleForPlacement(placement)
                    );
                    if (!meta.catalogId) continue;
                    const img = getImg(meta.catalogId, meta.kind, meta.variant);
                    if (!img) {
                        if (
                            typeof getImg.isPending !== 'function' ||
                            getImg.isPending(meta.catalogId, meta.kind, meta.variant)
                        ) {
                            pendingSprites = true;
                        }
                        continue;
                    }
                    const iw =
                        img.naturalWidth ||
                        img.width ||
                        img.videoWidth ||
                        tw;
                    const ih =
                        img.naturalHeight ||
                        img.height ||
                        img.videoHeight ||
                        th;
                    const box = resolveTileDrawBox(
                        tilePx,
                        tilePy,
                        tw,
                        th,
                        iw,
                        ih,
                        meta.scale,
                        meta.anchor
                    );
                    try {
                        g.drawImage(img, box.dx, box.dy, box.dw, box.dh);
                    } catch (_e) {
                        // keep friction fill
                    }
                }
            }
        }
        return pendingSprites;
    }

    /**
     * Paint a tile-space rectangle of the floor into `g` at local (0,0).
     * Prefer hybrid authoring ground+path; else single-cell artLayers; else friction gray.
     * Returns whether any art tile still lacked a ready sprite (retry rebuild).
     *
     * @param {*} g
     * @param {FloorLayer} layer
     * @param {ArtFloorLayer|null} art
     * @param {((id: string) => *)|null} getTileImg
     * @param {number} regionX
     * @param {number} regionY
     * @param {number} regionW
     * @param {number} regionH
     * @param {number} tw
     * @param {number} th
     * @param {{
     *   authoring?: object|null,
     *   getAuthoringImg?: ((id: string, kind: string) => *)|null
     * }} [opts]
     * @returns {boolean} pendingSprites
     */
    _paintFloorRegion(
        g,
        layer,
        art,
        getTileImg,
        regionX,
        regionY,
        regionW,
        regionH,
        tw,
        th,
        opts
    ) {
        const o = opts || {};
        if (o.authoring) {
            return this._paintTerrainAuthoringRegion(
                g,
                layer,
                o.authoring,
                o.getAuthoringImg || null,
                regionX,
                regionY,
                regionW,
                regionH,
                tw,
                th
            );
        }

        let pendingSprites = false;
        for (let ry = 0; ry < regionH; ry++) {
            const y = regionY + ry;
            if (y < 0 || y >= layer.rows) continue;
            for (let rx = 0; rx < regionW; rx++) {
                const x = regionX + rx;
                if (x < 0 || x >= layer.cols) continue;
                const flat = this.index(x, y, layer.cols);
                const f = layer.friction[flat];
                let drewSprite = false;
                if (art && getTileImg) {
                    const pIdx = art.cells[flat] | 0;
                    const tileId =
                        pIdx > 0 && pIdx < art.palette.length
                            ? art.palette[pIdx]
                            : null;
                    if (tileId) {
                        const placement = this._artPalettePlacement(art, pIdx);
                        const meta = resolvePlacementRender(
                            placement,
                            this._roleForPlacement(placement)
                        );
                        const img = getTileImg(tileId, meta.variant);
                        if (img) {
                            const iw =
                                img.naturalWidth ||
                                img.width ||
                                img.videoWidth ||
                                tw;
                            const ih =
                                img.naturalHeight ||
                                img.height ||
                                img.videoHeight ||
                                th;
                            const box = resolveTileDrawBox(
                                rx * tw,
                                ry * th,
                                tw,
                                th,
                                iw,
                                ih,
                                meta.scale,
                                meta.anchor
                            );
                            try {
                                g.drawImage(img, box.dx, box.dy, box.dw, box.dh);
                                drewSprite = true;
                            } catch (_e) {
                                drewSprite = false;
                            }
                        } else if (
                            typeof getTileImg.isPending !== 'function' ||
                            getTileImg.isPending(tileId, meta.variant)
                        ) {
                            pendingSprites = true;
                        }
                    }
                }
                if (!drewSprite) {
                    g.fillStyle =
                        FRICTION_FILL_STYLE[f] || FRICTION_FILL_STYLE[FRICTION_BLOCKED];
                    g.fillRect(rx * tw, ry * th, tw, th);
                }
            }
        }
        return pendingSprites;
    }

    /**
     * Draw floor: static offscreen cache + one blit when possible; else direct paint.
     * Viewport: Settings.cameraTileX/Y origin (may be fractional for smooth follow),
     * else NW corner. Prefers the art layer matching the camera floor (or first
     * friction layer).
     * @param {CanvasRenderingContext2D} g
     */
    render(g) {
        if (Settings.HEADLESS || !g) return;
        const keys = Object.keys(this.layers);
        if (!keys.length) return;

        // Sub-frame: re-anchor camera on presentation pos so the floor pans with
        // the same moveLock slide that entity_markers use (extraDt).
        const level = Settings.app && Settings.app.currentLevel;
        if (level && typeof level._updateCamera === 'function') {
            level._updateCamera(getCanvasStepExtraDt());
        }

        // Prefer floor under camera z when multi-floor; else first layer
        let zKey = keys[0];
        if (
            Settings.cameraTileZ != null &&
            this.layers[String(Settings.cameraTileZ)]
        ) {
            zKey = String(Settings.cameraTileZ);
        }
        const layer = this.layers[zKey];
        if (!layer) return;
        const art = this.artLayers[zKey] || null;
        const authoring = this.authoringFloors[zKey] || null;
        const hasAuthoring = !!authoring;
        const tw = Settings.tileWidth || 1;
        const th = Settings.tileHeight || 1;
        const app = Settings.app;
        const appW = app && app.width > 0 ? app.width : 0;
        const appH = app && app.height > 0 ? app.height : 0;
        const genre =
            (art && art.genre) ||
            (Settings.app && Settings.app.genre) ||
            DEFAULT_GENRE;

        const view = resolveTilemapViewport(layer, {
            tileWidth: tw,
            tileHeight: th,
            appWidth: appW,
            appHeight: appH
        });
        const { originX, originY, viewCols, viewRows } = view;

        // Stash for entity overlay (Simulator / later scripts). Fractional OK.
        this._viewOriginX = originX;
        this._viewOriginY = originY;
        this._viewCols = viewCols;
        this._viewRows = viewRows;
        this._viewZ = zKey;

        const getTileImg = hasAuthoring ? null : this._artTileImageGetter(art);
        const getAuthoringImg = hasAuthoring
            ? this._authoringImageGetter(authoring, genre)
            : null;
        const hasArt = hasAuthoring ? true : !!art;
        const useSprites =
            Settings.useEntitySprites !== false &&
            !!(hasAuthoring ? getAuthoringImg : getTileImg);
        const paintOpts = hasAuthoring
            ? { authoring, getAuthoringImg }
            : null;
        const canBlit =
            typeof g.drawImage === 'function' &&
            (g.canvas != null || typeof OffscreenCanvas !== 'undefined');

        if (!canBlit) {
            this._paintFloorRegionFractional(
                g,
                layer,
                art,
                getTileImg,
                originX,
                originY,
                viewCols,
                viewRows,
                tw,
                th,
                paintOpts
            );
            return;
        }

        const desired = computeTilemapCacheRect(layer, view);
        let cache = this._renderCache;
        let needRebuild = this._renderCacheDirty || !cache;

        if (cache && !needRebuild) {
            if (
                cache.zKey !== zKey ||
                cache.tw !== tw ||
                cache.th !== th ||
                cache.appW !== appW ||
                cache.appH !== appH ||
                cache.layerCols !== layer.cols ||
                cache.layerRows !== layer.rows ||
                cache.hasArt !== hasArt ||
                !!cache.hasAuthoring !== hasAuthoring ||
                cache.useSprites !== useSprites ||
                cache.pendingSprites
            ) {
                needRebuild = true;
            } else if (tilemapCacheNeedsRebuild(view, cache, layer)) {
                needRebuild = true;
            }
        }

        if (needRebuild) {
            const pixelW = desired.w * tw;
            const pixelH = desired.h * th;
            const surface =
                cache &&
                cache.canvas &&
                cache.ctx &&
                cache.canvas.width === pixelW &&
                cache.canvas.height === pixelH
                    ? { canvas: cache.canvas, ctx: cache.ctx }
                    : this._allocRenderCache(pixelW, pixelH);

            if (!surface || !surface.ctx) {
                // No offscreen available (typical Node unit tests): direct paint.
                this._paintFloorRegionFractional(
                    g,
                    layer,
                    art,
                    getTileImg,
                    originX,
                    originY,
                    viewCols,
                    viewRows,
                    tw,
                    th,
                    paintOpts
                );
                return;
            }

            if (typeof surface.ctx.clearRect === 'function') {
                surface.ctx.clearRect(0, 0, pixelW, pixelH);
            }
            const pendingSprites = this._paintFloorRegion(
                surface.ctx,
                layer,
                art,
                getTileImg,
                desired.x,
                desired.y,
                desired.w,
                desired.h,
                tw,
                th,
                paintOpts
            );

            this._renderCache = {
                canvas: surface.canvas,
                ctx: surface.ctx,
                x: desired.x,
                y: desired.y,
                w: desired.w,
                h: desired.h,
                mode: desired.mode,
                zKey,
                tw,
                th,
                appW,
                appH,
                layerCols: layer.cols,
                layerRows: layer.rows,
                hasArt,
                hasAuthoring,
                useSprites,
                pendingSprites
            };
            this._renderCacheDirty = false;
            this._renderCacheRebuilds =
                (this._renderCacheRebuilds | 0) + 1;
            cache = this._renderCache;
        }

        // One blit: cache sub-rect → screen (fractional sx/sy = sub-tile pan)
        const sx = (originX - cache.x) * tw;
        const sy = (originY - cache.y) * th;
        const sw = viewCols * tw;
        const sh = viewRows * th;
        try {
            g.drawImage(cache.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        } catch (_e) {
            // Corrupt surface: fall back once
            this.invalidateRenderCache();
            this._paintFloorRegionFractional(
                g,
                layer,
                art,
                getTileImg,
                originX,
                originY,
                viewCols,
                viewRows,
                tw,
                th,
                paintOpts
            );
        }
    }

    /**
     * Direct-paint path for fractional camera origins: paint integer tiles then
     * translate by the sub-tile pixel remainder so the floor pans smoothly.
     * @private
     */
    _paintFloorRegionFractional(
        g,
        layer,
        art,
        getTileImg,
        originX,
        originY,
        viewCols,
        viewRows,
        tw,
        th,
        opts
    ) {
        const tileOx = Math.floor(originX);
        const tileOy = Math.floor(originY);
        const offX = (originX - tileOx) * tw;
        const offY = (originY - tileOy) * th;
        const paintCols = viewCols + (offX > 0 ? 1 : 0);
        const paintRows = viewRows + (offY > 0 ? 1 : 0);
        const canTranslate =
            typeof g.save === 'function' &&
            typeof g.restore === 'function' &&
            typeof g.translate === 'function';
        if (canTranslate && (offX !== 0 || offY !== 0)) {
            g.save();
            g.translate(-offX, -offY);
            this._paintFloorRegion(
                g,
                layer,
                art,
                getTileImg,
                tileOx,
                tileOy,
                paintCols,
                paintRows,
                tw,
                th,
                opts
            );
            g.restore();
            return;
        }
        this._paintFloorRegion(
            g,
            layer,
            art,
            getTileImg,
            tileOx,
            tileOy,
            viewCols,
            viewRows,
            tw,
            th,
            opts
        );
    }
}

/**
 * @param {{ id?: number }|number|null|undefined} entity
 * @returns {number}
 */
function entityIdOf(entity) {
    if (entity == null) return 0;
    if (typeof entity === 'number') {
        const n = entity | 0;
        return n > 0 ? n : 0;
    }
    if (typeof entity === 'object' && entity.id != null) {
        const n = entity.id | 0;
        return n > 0 ? n : 0;
    }
    return 0;
}

/**
 * @param {object|null|undefined} ent
 * @returns {boolean}
 */
function isPlayerEntity(ent) {
    if (!ent || typeof ent !== 'object') return false;
    return ent.type === 'player';
}

/**
 * Hop-on-step is a manual-control landing rule. AI defaults to `controlMode:
 * 'ai'` and must use tryUseStair. Stubs that omit controlMode still hop
 * (tilemap unit tests).
 * @param {object|null|undefined} ent
 * @returns {boolean}
 */
function playerHopsOnStep(ent) {
    if (!isPlayerEntity(ent)) return false;
    const mode = ent.controlMode;
    if (mode == null || mode === '') return true;
    return mode === 'manual';
}

/**
 * @param {object|null|undefined} ent
 * @returns {boolean}
 */
function isSummonEntity(ent) {
    if (!ent) return false;
    return ent.masterId != null && (ent.masterId | 0) > 0;
}

/**
 * Mover may path into / clear pushable creature tiles.
 * Summons never get push (legacy-shaped).
 * @param {object|null|undefined} ent
 * @returns {boolean}
 */
function entityCanPushCreatures(ent) {
    if (!ent || isPlayerEntity(ent) || isSummonEntity(ent)) return false;
    if (ent.canPushCreatures === true) return true;
    if (ent.flags && ent.flags.canPushCreatures === true) return true;
    return false;
}

/**
 * Target may be shoved (or crushed) by a canPushCreatures mover.
 * Players and player-owned summons are never pushable.
 * Default for wild creatures: true unless pushable === false or speed 0.
 * @param {object|null|undefined} ent
 * @returns {boolean}
 */
function isPushableEntity(ent) {
    if (!ent || typeof ent !== 'object') return false;
    if (isPlayerEntity(ent)) return false;
    if (isSummonEntity(ent)) return false;
    if (ent.alive === false) return false;
    if (ent.hp && typeof ent.hp === 'object' && Number(ent.hp.current) <= 0) {
        return false;
    }
    if (ent.speed != null && Number(ent.speed) === 0) return false;
    if (ent.pushable === false) return false;
    if (ent.flags && ent.flags.pushable === false) return false;
    return true;
}

/**
 * @param {TileMap} tileMap
 * @param {{ id?: number }|number|null|undefined} entity
 * @param {number} id
 * @returns {object|null}
 */
function resolveMoverEntity(tileMap, entity, id) {
    if (entity != null && typeof entity === 'object') return entity;
    if (id > 0 && tileMap) return tileMap.resolveOccupant(id);
    return null;
}

/**
 * @param {TileMap} tileMap
 * @param {number[]} combatants
 * @returns {object[]}
 */
function resolveCombatantEntities(tileMap, combatants) {
    const out = [];
    if (!combatants || !tileMap) return out;
    for (let i = 0; i < combatants.length; i++) {
        const ent = tileMap.resolveOccupant(combatants[i]);
        if (ent) out.push(ent);
    }
    return out;
}

/**
 * @param {object[]} occupants
 * @returns {boolean}
 */
function occupantsHavePlayer(occupants) {
    for (let i = 0; i < occupants.length; i++) {
        if (isPlayerEntity(occupants[i])) return true;
    }
    return false;
}

/**
 * Max players per tile from Settings (0 = unlimited).
 * @returns {number}
 */
function playerTileMaxStack() {
    const m =
        Settings.PLAYER_TILE_MAX_STACK != null
            ? Number(Settings.PLAYER_TILE_MAX_STACK)
            : 10;
    if (!Number.isFinite(m) || m < 0) return 10;
    return m | 0;
}

/**
 * Player enter policy for a non-empty tile (occupants already resolved).
 * @param {TileMap} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {object[]} occupants
 * @param {boolean} isStair
 * @returns {boolean}
 */
function canPlayerEnterTile(tileMap, x, y, z, occupants, isStair) {
    if (!occupants.length) return false;

    let playerCount = 0;
    let creatureCount = 0;
    for (let i = 0; i < occupants.length; i++) {
        if (isPlayerEntity(occupants[i])) playerCount += 1;
        else creatureCount += 1;
    }

    // Unresolved mixed state should not happen when resolve is wired
    if (playerCount === 0 && creatureCount === 0) return false;

    // Pure creature tile: only stair / floor-change mixed exception
    if (playerCount === 0 && creatureCount >= 1) {
        if (!isStair) return false;
        // At most one creature in mixed stack
        if (creatureCount > 1) return false;
        return true;
    }

    // Players only, or already mixed (players + one creature)
    if (creatureCount > 1) return false;

    if (tileMap.isNoPlayerStack(x, y, z) && playerCount >= 1) {
        return false;
    }

    const max = playerTileMaxStack();
    if (max > 0 && playerCount >= max) return false;
    return true;
}

/**
 * Decode a path PNG to { cols, rows, rgba }.
 * @param {string} pathPng
 * @returns {Promise<{ cols: number, rows: number, rgba: Uint8Array }>}
 */
async function decodePathPng(pathPng) {
    if (isBrowserEnv()) {
        return decodePathPngBrowser(pathPng);
    }
    return decodePathPngNode(pathPng);
}

function isBrowserEnv() {
    return (
        typeof window !== 'undefined' &&
        typeof document !== 'undefined' &&
        typeof Image !== 'undefined'
    );
}

/**
 * @param {string} url
 * @returns {Promise<{ cols: number, rows: number, rgba: Uint8Array }>}
 */
function decodePathPngBrowser(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            try {
                const cols = img.naturalWidth || img.width;
                const rows = img.naturalHeight || img.height;
                const canvas = document.createElement('canvas');
                canvas.width = cols;
                canvas.height = rows;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('loadFloor: 2d context unavailable'));
                    return;
                }
                ctx.drawImage(img, 0, 0);
                const imageData = ctx.getImageData(0, 0, cols, rows);
                resolve({
                    cols,
                    rows,
                    rgba: new Uint8Array(imageData.data.buffer.slice(0))
                });
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => reject(new Error(`loadFloor: failed to load image ${url}`));
        img.src = url;
    });
}

/**
 * @param {string} filePath
 * @returns {Promise<{ cols: number, rows: number, rgba: Uint8Array }>}
 */
function decodePathPngNode(filePath) {
    const fs = require('fs');
    const { PNG } = require('pngjs');
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, (err, buf) => {
            if (err) {
                reject(err);
                return;
            }
            try {
                const png = PNG.sync.read(buf);
                resolve({
                    cols: png.width,
                    rows: png.height,
                    rgba: png.data
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

/**
 * Bake helper: register a stair/hole/ladder link from a TileMap placement.
 * Computes destination as hop.to or same (x,y) + hopDirOffset(dir) + z+deltaZ.
 * ORs the vertical type flag bit onto the from-cell when a flags layer exists
 * (or creates one via setTileFlags). Does nothing when registerStairLink is false.
 *
 * @param {TileMap} map
 * @param {{
 *   vertical?: object|null,
 *   hop?: { dir?: string, deltaZ?: number, to?: { x: number, y: number, z?: string|number } }|null,
 *   role?: { vertical?: object|null }|null,
 *   link?: string|null,
 *   type?: string|null
 * }|null|undefined} placement
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {{ setFlags?: boolean, bidirectional?: boolean }} [opts]
 * @returns {{
 *   registered: boolean,
 *   from: { x: number, y: number, z: string|number },
 *   to: { x: number, y: number, z: string|number }|null,
 *   type: string|null,
 *   dir: string|null,
 *   exitDx: number,
 *   exitDy: number,
 *   deltaZ: number|null
 * }}
 */
function registerVerticalFromPlacement(map, placement, x, y, z, opts) {
    const ix = Math.round(Number(x) || 0);
    const iy = Math.round(Number(y) || 0);
    const from = { x: ix, y: iy, z };
    const empty = {
        registered: false,
        from,
        to: null,
        type: null,
        dir: null,
        exitDx: 0,
        exitDy: 0,
        deltaZ: null
    };
    if (!map || typeof map.addStair !== 'function') return empty;
    if (!placement || typeof placement !== 'object') return empty;

    const verticalRaw =
        placement.vertical != null
            ? placement.vertical
            : placement.role && placement.role.vertical != null
              ? placement.role.vertical
              : placement.type != null
                ? {
                      type: placement.type,
                      deltaZ: placement.deltaZ,
                      defaultDir: placement.dir,
                      bidirectional: placement.bidirectional,
                      registerStairLink: placement.registerStairLink
                  }
                : null;
    const vertical = normalizePlacementVertical(verticalRaw);
    if (!vertical) return empty;

    const setFlags = !opts || opts.setFlags !== false;
    if (setFlags) {
        const bit = VERTICAL_TYPE_FLAGS[vertical.type] || 0;
        if (bit && typeof map.setTileFlags === 'function') {
            const prev =
                typeof map.getTileFlags === 'function'
                    ? map.getTileFlags(ix, iy, z)
                    : 0;
            map.setTileFlags(ix, iy, z, (prev | bit) & 0xff);
        }
    }

    if (!vertical.registerStairLink) {
        return {
            registered: false,
            from,
            to: null,
            type: vertical.type,
            dir: vertical.defaultDir,
            exitDx: 0,
            exitDy: 0,
            deltaZ: vertical.deltaZ
        };
    }

    const hop =
        placement.hop && typeof placement.hop === 'object' ? placement.hop : {};
    const dirRaw =
        hop.dir != null
            ? String(hop.dir).trim().toLowerCase()
            : vertical.defaultDir;
    const dirs = { center: 1, north: 1, south: 1, east: 1, west: 1 };
    const dir = dirs[dirRaw] ? dirRaw : 'center';
    const off = hopDirOffset(dir);
    const exitDx = off.dx;
    const exitDy = off.dy;

    let deltaZ =
        hop.deltaZ != null && Number.isFinite(Number(hop.deltaZ))
            ? Math.trunc(Number(hop.deltaZ))
            : vertical.deltaZ;

    let toX;
    let toY;
    let toZ;
    if (hop.to && hop.to.x != null && hop.to.y != null) {
        toX = Math.round(Number(hop.to.x));
        toY = Math.round(Number(hop.to.y));
        toZ =
            hop.to.z !== undefined && hop.to.z !== null
                ? hop.to.z
                : applyFloorDelta(z, deltaZ);
    } else {
        toX = ix + exitDx;
        toY = iy + exitDy;
        toZ = applyFloorDelta(z, deltaZ);
    }

    if (toX === ix && toY === iy && String(toZ) === String(z)) {
        return {
            registered: false,
            from,
            to: { x: toX, y: toY, z: toZ },
            type: vertical.type,
            dir,
            exitDx,
            exitDy,
            deltaZ
        };
    }

    const meta = {
        dir,
        type: vertical.type,
        link: placement.link != null ? placement.link : null,
        bidirectional: vertical.bidirectional,
        exitDx,
        exitDy,
        deltaZ
    };
    map.addStair(from, { x: toX, y: toY, z: toZ }, meta);

    const bi =
        opts && opts.bidirectional !== undefined
            ? !!opts.bidirectional
            : vertical.bidirectional;
    if (bi) {
        map.addStair(
            { x: toX, y: toY, z: toZ },
            from,
            {
                dir: reverseHopDir(dir),
                type: vertical.type,
                link: placement.link != null ? placement.link : null,
                bidirectional: true,
                exitDx: -exitDx,
                exitDy: -exitDy,
                deltaZ: -deltaZ
            }
        );
    }

    return {
        registered: true,
        from,
        to: { x: toX, y: toY, z: toZ },
        type: vertical.type,
        dir,
        exitDx,
        exitDy,
        deltaZ
    };
}

module.exports = {
    TileMap,
    FRICTION_BLOCKED,
    SIGHT_BLOCKED,
    SIGHT_CLEAR,
    TILE_FLAG_NO_CAST,
    TILE_FLAG_STAIR,
    TILE_FLAG_LADDER,
    TILE_FLAG_HOLE,
    TILE_FLAG_ROPE_SPOT,
    TILE_FLAG_SHOVEL_SPOT,
    TILE_FLAG_NO_CREATURE,
    TILE_FLAG_PZ_PACKAGE,
    PATH_PNG_DEFAULT_WALK_FRICTION,
    frictionFromPixel,
    collisionFromPixel,
    defaultSightFromFriction,
    stairKey,
    reverseHopDir,
    hopsOnStep,
    playerHopsOnStep,
    registerVerticalFromPlacement,
    normalizePlacementVertical,
    resolveTilemapViewport,
    computeTilemapCacheRect,
    tilemapCacheNeedsRebuild,
    DEFAULT_CACHE_FULL_MAX_TILES,
    DEFAULT_CACHE_MARGIN_MIN,
    isPlayerEntity,
    isPushableEntity,
    entityCanPushCreatures,
    isSummonEntity
};
