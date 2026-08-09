/**
 * Pure movement helpers (Stage 3 + watch-mode step visuals).
 *
 * Step delay uses legacy breakpoint tables (friction × speed → discrete
 * delay). Diagonal steps multiply delay (legacy: ×2). Pathfinding never uses
 * friction as path cost — only walkable vs blocked (255).
 *
 * Fixed logic UPS still advances every tick; entities only change tiles when
 * moveDelay ≤ 0.
 *
 * Presentation (legacy sprite slide):
 *   Logic `tile` updates instantly on a step. Render position (`entity.x` / `y`)
 *   lerps from the previous visual toward the new tile over the same `moveDelay`
 *   window, so the sprite lands when the entity is ready to step again.
 *   Stairs / teleports / multi-tile jumps snap (no cross-map slide).
 *
 * Source tables: historical prototype friction/delay (ported into this module).
 */

const { Settings } = require('../../settings.js');

/**
 * Default walkable friction when tile data is missing or out of table range.
 * Matches common path-PNG mid-gray and dungeon piece DEFAULT_WALK_FRICTION.
 * frictionTable[100] = [0…0, 113, 135, 167, 219, 321, 592, 2382]
 */
const DEFAULT_TILE_FRICTION = 100;

/**
 * Friction → 17 speed breakpoint thresholds (legacy).
 * Keys must stay sorted for interpolation. Values increase along the array.
 * @type {Readonly<Record<number, readonly number[]>>}
 */
const FRICTION_TABLE = Object.freeze({
    70: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 111, 142, 200, 342, 1070]),
    90: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 147, 192, 278, 499, 1842]),
    95: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 127, 157, 205, 299, 543, 2096]),
    100: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 113, 135, 167, 219, 321, 592, 2382]),
    110: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 126, 150, 187, 248, 367, 696, 3060]),
    120: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 120, 139, 167, 208, 278, 417, 813, 3913]),
    121: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 121, 140, 168, 211, 281, 423, 826, 4012]),
    125: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 0, 125, 146, 175, 219, 293, 444, 876, 4419]),
    130: Object.freeze([0, 0, 0, 0, 0, 0, 0, 0, 115, 131, 153, 183, 230, 310, 472, 944, 4992]),
    140: Object.freeze([0, 0, 0, 0, 0, 0, 0, 111, 125, 143, 167, 201, 254, 344, 531, 1092, 6341]),
    150: Object.freeze([0, 0, 0, 0, 0, 0, 0, 120, 135, 155, 181, 219, 278, 380, 595, 1258, 8036]),
    160: Object.freeze([0, 0, 0, 0, 0, 0, 116, 129, 145, 167, 196, 238, 304, 419, 663, 1443, 10167]),
    170: Object.freeze([0, 0, 0, 0, 0, 112, 124, 138, 156, 179, 212, 258, 331, 459, 737, 1652, 12846]),
    180: Object.freeze([0, 0, 0, 0, 0, 120, 132, 148, 167, 192, 227, 279, 359, 502, 818, 1886, 16212]),
    200: Object.freeze([0, 0, 0, 114, 124, 135, 149, 167, 190, 219, 261, 322, 419, 597, 998, 2444, 25761]),
    250: Object.freeze([117, 126, 135, 146, 160, 175, 195, 220, 252, 295, 356, 446, 598, 884, 1591, 4557, 81351])
});

/** Sorted friction keys for interpolation (cached). */
const FRICTION_KEYS = Object.freeze(
    Object.keys(FRICTION_TABLE)
        .map(Number)
        .sort((a, b) => a - b)
);

/**
 * Breakpoint index (0–17) → step delay in seconds.
 * Index 0 is the slowest (speed never cleared a threshold).
 * @type {readonly number[]}
 */
const DELAY_TABLE = Object.freeze([
    1.5, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3,
    0.25, 0.2, 0.15, 0.1, 0.05
]);

/**
 * Normalize tile friction for the breakpoint tables.
 * Missing / non-finite / blocked-ish values fall back to DEFAULT_TILE_FRICTION.
 * Values outside [70, 250] are clamped to table bounds (legacy throws; we clamp).
 *
 * @param {number|null|undefined} friction
 * @returns {number}
 */
function normalizeFriction(friction) {
    const n = Number(friction);
    if (!Number.isFinite(n) || n <= 0 || n >= 255) {
        return DEFAULT_TILE_FRICTION;
    }
    if (n < 70) return 70;
    if (n > 250) return 250;
    return n;
}

/**
 * 17 speed thresholds for a friction value (exact or linear interpolate).
 *
 * @param {number} friction Walkable friction (will be normalized)
 * @returns {number[]} length 17
 */
function getFrictionBreakpoints(friction) {
    const f = normalizeFriction(friction);
    if (FRICTION_TABLE[f]) {
        return FRICTION_TABLE[f].slice();
    }

    let lower = FRICTION_KEYS[0];
    let upper = FRICTION_KEYS[FRICTION_KEYS.length - 1];
    for (let i = 0; i < FRICTION_KEYS.length; i++) {
        const key = FRICTION_KEYS[i];
        if (key <= f) lower = key;
        if (key >= f) {
            upper = key;
            break;
        }
    }
    if (lower === upper) {
        return FRICTION_TABLE[lower].slice();
    }

    const lowerValues = FRICTION_TABLE[lower];
    const upperValues = FRICTION_TABLE[upper];
    const fraction = (f - lower) / (upper - lower);
    const result = new Array(17);
    for (let i = 0; i < 17; i++) {
        result[i] = Math.round(
            lowerValues[i] + fraction * (upperValues[i] - lowerValues[i])
        );
    }
    return result;
}

/**
 * Map a breakpoint index (0–17) to step delay in seconds.
 * @param {number} breakpoint
 * @returns {number}
 */
function movementDelay(breakpoint) {
    const i = Math.max(0, Math.min(DELAY_TABLE.length - 1, Math.floor(Number(breakpoint) || 0)));
    return DELAY_TABLE[i];
}

/**
 * Greatest breakpoint index such that speed > threshold, as 0-based table
 * index into DELAY_TABLE (legacy returns maxIndex+1 so range is 0..17).
 *
 * @param {number} friction
 * @param {number} speed
 * @returns {number} 0..17
 */
function getBreakpointForFrictionAndSpeed(friction, speed) {
    const s = Number(speed);
    const safeSpeed = Number.isFinite(s) && s >= 0 ? s : 0;
    const breakpointValues = getFrictionBreakpoints(friction);

    let maxBreakpointIndex = -1;
    for (let i = 0; i < breakpointValues.length; i++) {
        if (safeSpeed > breakpointValues[i]) {
            maxBreakpointIndex = i;
        } else {
            break;
        }
    }
    return maxBreakpointIndex + 1;
}

/**
 * Legacy getMovementDelay: friction + speed → step delay seconds (no diagonal).
 *
 * @param {number} friction
 * @param {number} speed
 * @returns {number}
 */
function getMovementDelay(friction, speed) {
    return movementDelay(getBreakpointForFrictionAndSpeed(friction, speed));
}

/**
 * Compute seconds to wait after entering a tile before the next step.
 *
 * Legacy tables:
 *   delay = DELAY_TABLE[breakpoint(friction, speed)]
 *   if diagonal: delay *= MOVE_DIAGONAL_FACTOR (default 2)
 *
 * Higher friction → slower (higher thresholds); higher speed → faster.
 *
 * @param {number} friction Tile friction 0–254 (caller should not pass blocked)
 * @param {number} speed Entity speed (≥ 0; 0 → slowest delay)
 * @param {boolean} [isDiagonal=false]
 * @returns {number} delay in seconds
 */
function computeMoveDelay(friction, speed, isDiagonal) {
    const diag =
        Settings.MOVE_DIAGONAL_FACTOR != null
            ? Settings.MOVE_DIAGONAL_FACTOR
            : 2;
    const min =
        Settings.MOVE_MIN_DELAY != null ? Settings.MOVE_MIN_DELAY : 0.05;

    let delay = getMovementDelay(friction, speed);
    if (isDiagonal) {
        delay *= diag;
    }
    return Math.max(min, delay);
}

/**
 * Chebyshev distance on the tile grid (diag counts as 1).
 * @param {{ x: number, y: number }} a
 * @param {{ x: number, y: number }} b
 * @returns {number}
 */
function tileDistance(a, b) {
    if (!a || !b) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Whether a step from (fromX,fromY) to (toX,toY) is diagonal.
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @returns {boolean}
 */
function isDiagonalStep(fromX, fromY, toX, toY) {
    return (
        Math.abs(Math.round(toX) - Math.round(fromX)) > 0 &&
        Math.abs(Math.round(toY) - Math.round(fromY)) > 0
    );
}

/**
 * True when a move is a single adjacent step on the same floor (slide eligible).
 * Stairs (z change) and multi-tile jumps snap instead.
 *
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} from
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} to
 * @returns {boolean}
 */
function isAdjacentStep(from, to) {
    if (!from || !to) return false;
    if (String(from.z) !== String(to.z)) return false;
    const dx = Math.abs(Math.round(to.x) - Math.round(from.x));
    const dy = Math.abs(Math.round(to.y) - Math.round(from.y));
    if (dx === 0 && dy === 0) return false;
    return dx <= 1 && dy <= 1;
}

/**
 * Hard-snap render position to logic tile (spawn, stairs, teleport).
 * Clears any in-flight step visual.
 *
 * @param {object|null|undefined} entity
 */
function snapVisualToTile(entity) {
    if (!entity || !entity.tile) return;
    entity.x = entity.tile.x;
    entity.y = entity.tile.y;
    entity.z = entity.tile.z;
    entity._moveVisFromX = entity.tile.x;
    entity._moveVisFromY = entity.tile.y;
    entity._moveVisDuration = 0;
    entity._moveVisElapsed = 0;
    // Legacy used moveSpeed = 1/moveDelay for sprite travel; 0 when idle
    entity.moveSpeed = 0;
}

/**
 * Cheap watch-mode facing: catalog sprites face right by default.
 * Horizontal steps flip the draw (`spriteFacing = -1` left, `1` right).
 * Pure vertical / stairs-only moves keep the previous facing.
 *
 * @param {object|null|undefined} entity
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} fromTile
 */
function updateSpriteFacing(entity, fromTile) {
    if (!entity || !fromTile || !entity.tile) return;
    const dx = Math.round(entity.tile.x) - Math.round(fromTile.x);
    if (dx < 0) {
        entity.spriteFacing = -1;
    } else if (dx > 0) {
        entity.spriteFacing = 1;
    }
}

/**
 * Start a presentation slide after logic already moved `entity.tile`.
 * Visual stays at the previous render position (or previous tile) and catches
 * up over `duration` seconds — typically the step's `moveDelay` so the sprite
 * lands when the entity is ready to step again.
 *
 * Uses elapsed time (not remaining moveDelay) so a later spell moveLock that
 * extends moveDelay does not reverse the sprite mid-slide.
 *
 * @param {object} entity
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} fromTile
 *   Previous logic tile (before the step)
 * @param {number} duration Seconds until visual should land (usually moveDelay)
 */
function beginStepVisual(entity, fromTile, duration) {
    if (!entity || !entity.tile) return;
    updateSpriteFacing(entity, fromTile);
    const dur = Number(duration);
    if (!(dur > 0) || !isAdjacentStep(fromTile, entity.tile)) {
        snapVisualToTile(entity);
        return;
    }
    const fromX = Number.isFinite(entity.x)
        ? entity.x
        : fromTile
          ? fromTile.x
          : entity.tile.x;
    const fromY = Number.isFinite(entity.y)
        ? entity.y
        : fromTile
          ? fromTile.y
          : entity.tile.y;
    entity._moveVisFromX = fromX;
    entity._moveVisFromY = fromY;
    entity._moveVisDuration = dur;
    entity._moveVisElapsed = 0;
    // Tiles per second if traveling unit distance in `dur` (legacy moveSpeed)
    entity.moveSpeed = 1 / dur;
    // Leave entity.x/y at the start of the slide (do not snap to destination)
    entity.x = fromX;
    entity.y = fromY;
    entity.z = entity.tile.z;
}

/**
 * Progress 0..1 of the current step visual from elapsed / duration.
 * When duration is unknown/expired, returns 1 (fully landed).
 * Accepts optional extraDt (seconds) for sub-frame canvas render interpolation.
 *
 * @param {object|null|undefined} entity
 * @param {number} [extraDt=0]
 * @returns {number}
 */
function stepVisualProgress(entity, extraDt) {
    if (!entity) return 1;
    const dur = Number(entity._moveVisDuration) || 0;
    if (dur <= 0) return 1;
    const elapsed = (Number(entity._moveVisElapsed) || 0) + (Number(extraDt) || 0);
    if (elapsed <= 0) return 0;
    const t = elapsed / dur;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t;
}

/**
 * Advance step visual by `dt` seconds and write `entity.x` / `y`.
 * Call once per logic tick (with or without a prior moveDelay countdown).
 * When the slide finishes, snaps to the logic tile.
 *
 * @param {object|null|undefined} entity
 * @param {number} [dt] Seconds (default 0 — re-sample only)
 */
function tickStepVisual(entity, dt) {
    if (!entity || !entity.tile) return;
    const dur = Number(entity._moveVisDuration) || 0;
    if (dur <= 0) {
        entity.x = entity.tile.x;
        entity.y = entity.tile.y;
        entity.z = entity.tile.z;
        entity.moveSpeed = 0;
        return;
    }
    const step = Number(dt) || 0;
    if (step > 0) {
        entity._moveVisElapsed = (Number(entity._moveVisElapsed) || 0) + step;
    }
    const t = stepVisualProgress(entity);
    if (t >= 1) {
        entity.x = entity.tile.x;
        entity.y = entity.tile.y;
        entity.z = entity.tile.z;
        entity._moveVisDuration = 0;
        entity._moveVisElapsed = 0;
        entity.moveSpeed = 0;
        return;
    }
    const fx =
        entity._moveVisFromX != null ? entity._moveVisFromX : entity.tile.x;
    const fy =
        entity._moveVisFromY != null ? entity._moveVisFromY : entity.tile.y;
    entity.x = fx + (entity.tile.x - fx) * t;
    entity.y = fy + (entity.tile.y - fy) * t;
    entity.z = entity.tile.z;
}

/**
 * Wall-clock sub-frame step interpolation for canvas only (seconds).
 * Returns 0 when the session is paused or seek is in progress so mid-slide
 * sprites stay frozen (otherwise extraDt oscillates with lastUpdate refresh
 * and the sprite appears to tremble).
 *
 * @param {number} [nowMs] wall clock ms (default performance.now / Date.now)
 * @returns {number}
 */
function getCanvasStepExtraDt(nowMs) {
    const app = Settings.app;
    if (app && app.paused) return 0;
    if (app && app.currentLevel && app.currentLevel._seekInProgress) return 0;
    const now =
        nowMs != null && Number.isFinite(Number(nowMs))
            ? Number(nowMs)
            : typeof performance !== 'undefined' &&
                typeof performance.now === 'function'
              ? performance.now()
              : Date.now();
    const lastUpd = app && app.lastUpdate ? app.lastUpdate : now;
    const speed = Settings.TIME_SPEED || 1;
    return Math.max(0, Math.min(0.05, ((now - lastUpd) / 1000) * speed));
}

/**
 * Float tile coords for drawing (presentation). Prefer sliding `x`/`y`;
 * fall back to logic tile. Accepts optional extraDt (seconds) for sub-frame canvas render.
 *
 * @param {object|null|undefined} entity
 * @param {number} [extraDt=0]
 * @returns {{ x: number, y: number, z: * }|null}
 */
function getVisualTilePos(entity, extraDt) {
    if (!entity) return null;
    const dur = Number(entity._moveVisDuration) || 0;
    if (dur > 0 && entity.tile) {
        const t = stepVisualProgress(entity, extraDt);
        const fx =
            entity._moveVisFromX != null ? entity._moveVisFromX : entity.tile.x;
        const fy =
            entity._moveVisFromY != null ? entity._moveVisFromY : entity.tile.y;
        return {
            x: fx + (entity.tile.x - fx) * t,
            y: fy + (entity.tile.y - fy) * t,
            z:
                entity.z !== undefined && entity.z !== null
                    ? entity.z
                    : entity.tile
                      ? entity.tile.z
                      : 0
        };
    }
    if (Number.isFinite(entity.x) && Number.isFinite(entity.y)) {
        return {
            x: entity.x,
            y: entity.y,
            z:
                entity.z !== undefined && entity.z !== null
                    ? entity.z
                    : entity.tile
                      ? entity.tile.z
                      : 0
        };
    }
    if (entity.tile && entity.tile.x != null && entity.tile.y != null) {
        return {
            x: entity.tile.x,
            y: entity.tile.y,
            z: entity.tile.z
        };
    }
    return null;
}

module.exports = {
    DEFAULT_TILE_FRICTION,
    FRICTION_TABLE,
    /** Sorted numeric keys of FRICTION_TABLE (70…250), for piece nibble maps. */
    FRICTION_KEYS,
    DELAY_TABLE,
    normalizeFriction,
    getFrictionBreakpoints,
    movementDelay,
    getBreakpointForFrictionAndSpeed,
    getMovementDelay,
    computeMoveDelay,
    tileDistance,
    isDiagonalStep,
    isAdjacentStep,
    snapVisualToTile,
    updateSpriteFacing,
    beginStepVisual,
    stepVisualProgress,
    tickStepVisual,
    getCanvasStepExtraDt,
    getVisualTilePos
};
