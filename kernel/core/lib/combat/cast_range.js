/**
 * Spell / rune cast-range gates.
 *
 * Default: Chebyshev ≤ spell.range (or a pre-resolved range number).
 * Far-use runes (`allowFarUse: true`): also require the far-use box
 * (‖Δx‖ ≤ FAR_USE_RANGE_X, ‖Δy‖ ≤ FAR_USE_RANGE_Y). Defaults are 7×7 so the
 * box matches the player engage square (Settings AI_ENGAGE_RANGE_X/Y).
 * Explicit `range` still caps Chebyshev (e.g. destroy-field range 5 stays
 * Chebyshev ≤ 5 inside that box).
 */

/** Far-use max |Δx| (aligned with player engage). */
const FAR_USE_RANGE_X = 7;

/** Far-use max |Δy| (aligned with player engage; square with X). */
const FAR_USE_RANGE_Y = 7;

/**
 * @param {{ x: number, y: number, z?: * }|null|undefined} from
 * @param {{ x: number, y: number, z?: * }|null|undefined} to
 * @param {object|null|undefined} spell
 * @param {number} [range] pre-resolved Chebyshev cap (wand auto etc.)
 * @returns {boolean}
 */
function isWithinSpellCastRange(from, to, spell, range) {
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

    const dx = Math.abs(from.x - to.x);
    const dy = Math.abs(from.y - to.y);

    if (spell && spell.allowFarUse === true) {
        if (dx > FAR_USE_RANGE_X || dy > FAR_USE_RANGE_Y) return false;
    }

    let r = range;
    if (r == null || !Number.isFinite(r)) {
        r = spell && spell.range != null ? Number(spell.range) : 1;
    }
    if (!Number.isFinite(r)) r = 1;
    return Math.max(dx, dy) <= r;
}

module.exports = {
    FAR_USE_RANGE_X,
    FAR_USE_RANGE_Y,
    isWithinSpellCastRange
};
