/**
 * Player engage area as an axis-aligned box (‖Δx‖ ≤ X, ‖Δy‖ ≤ Y).
 *
 * Defaults 7×7 match the historical Chebyshev engage radius of 7
 * (max(dx,dy) ≤ 7 ⇔ dx≤7 && dy≤7). Scalar strategy `engageRange` still
 * means a square (both axes). Optional `engageRangeX` / `engageRangeY`
 * override per axis.
 */

const { Settings } = require('../../../settings.js');

const DEFAULT_ENGAGE_AXIS = 7;

/**
 * @param {*} v
 * @param {number} fallback
 * @returns {number}
 */
function axisInt(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.floor(n));
}

/**
 * Global defaults from Settings (X/Y, falling back to scalar AI_ENGAGE_RANGE).
 * @returns {{ x: number, y: number }}
 */
function defaultEngageRangeXY() {
    const scalar =
        Settings && Settings.AI_ENGAGE_RANGE != null
            ? axisInt(Settings.AI_ENGAGE_RANGE, DEFAULT_ENGAGE_AXIS)
            : DEFAULT_ENGAGE_AXIS;
    const x =
        Settings && Settings.AI_ENGAGE_RANGE_X != null
            ? axisInt(Settings.AI_ENGAGE_RANGE_X, scalar)
            : scalar;
    const y =
        Settings && Settings.AI_ENGAGE_RANGE_Y != null
            ? axisInt(Settings.AI_ENGAGE_RANGE_Y, scalar)
            : scalar;
    return { x, y };
}

/**
 * Resolve engage box for a player or raw strategy bag.
 * Priority per axis: engageRangeX/Y → engageRange (square) → Settings.
 *
 * @param {object|null|undefined} playerOrStrategy player with .strategy, or strategy bag
 * @returns {{ x: number, y: number }}
 */
function resolveEngageRange(playerOrStrategy) {
    const def = defaultEngageRangeXY();
    if (!playerOrStrategy) return def;

    const st =
        playerOrStrategy.strategy && typeof playerOrStrategy.strategy === 'object'
            ? playerOrStrategy.strategy
            : playerOrStrategy;

    const square =
        st.engageRange != null && Number.isFinite(Number(st.engageRange))
            ? axisInt(st.engageRange, def.x)
            : null;

    const x =
        st.engageRangeX != null && Number.isFinite(Number(st.engageRangeX))
            ? axisInt(st.engageRangeX, def.x)
            : square != null
              ? square
              : def.x;
    const y =
        st.engageRangeY != null && Number.isFinite(Number(st.engageRangeY))
            ? axisInt(st.engageRangeY, def.y)
            : square != null
              ? square
              : def.y;

    return { x, y };
}

/**
 * Chebyshev radius that covers the engage box (for spatial over-fetch).
 * @param {{ x: number, y: number }|number|null|undefined} range
 * @returns {number}
 */
function engageQueryRadius(range) {
    if (range == null) {
        const d = defaultEngageRangeXY();
        return Math.max(d.x, d.y);
    }
    if (typeof range === 'number') return axisInt(range, DEFAULT_ENGAGE_AXIS);
    return Math.max(axisInt(range.x, 0), axisInt(range.y, 0));
}

/**
 * Same-floor axis box: |Δx| ≤ rangeX and |Δy| ≤ rangeY.
 * @param {{ x: number, y: number, z?: * }|null|undefined} from
 * @param {{ x: number, y: number, z?: * }|null|undefined} to
 * @param {{ x: number, y: number }|number} range XY box or square scalar
 * @returns {boolean}
 */
function isWithinEngageRange(from, to, range) {
    if (!from || !to) return false;
    if (
        from.z !== undefined &&
        from.z !== null &&
        to.z !== undefined &&
        to.z !== null &&
        String(from.z) !== String(to.z)
    ) {
        return false;
    }
    let rx;
    let ry;
    if (typeof range === 'number') {
        rx = ry = axisInt(range, DEFAULT_ENGAGE_AXIS);
    } else if (range && typeof range === 'object') {
        rx = axisInt(range.x, DEFAULT_ENGAGE_AXIS);
        ry = axisInt(range.y, DEFAULT_ENGAGE_AXIS);
    } else {
        const d = defaultEngageRangeXY();
        rx = d.x;
        ry = d.y;
    }
    const dx = Math.abs(Math.round(from.x) - Math.round(to.x));
    const dy = Math.abs(Math.round(from.y) - Math.round(to.y));
    return dx <= rx && dy <= ry;
}

module.exports = {
    DEFAULT_ENGAGE_AXIS,
    defaultEngageRangeXY,
    resolveEngageRange,
    engageQueryRadius,
    isWithinEngageRange
};
