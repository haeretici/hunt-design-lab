/**
 * Spell AoE / wave shape matrices (ported from the legacy prototype shapes).
 *
 * Pure data + lookup + world-space tile resolution. Combat multi-target uses
 * getAffectedTiles (inject tileMap for LoS / walls). Designer shape picker
 * uses listShapeCatalog + preview (no tileMap required).
 *
 * Cell values in matrices (legacy createArea semantics):
 *   0 = empty
 *   1 = affected (hit) tile
 *   2 = origin only (not hit) — ring/burst holes; even_contest front origin
 *   3 = origin + hit — standard waves/areas (berserk square, ice wave, …)
 *
 * Waves/beams: matrix origin is placed one step in front of the caster
 * (legacy getCasterPosition). Area self-AoE: origin on caster tile.
 * Matrices are east-authored; north-authored legacy tables are rotated 90° CW.
 */

'use strict';

/** Friction value for non-walkable tiles (matches TileMap). */
const FRICTION_BLOCKED = 255;

/** Sight-block sentinel (matches TileMap.SIGHT_BLOCKED). */
const SIGHT_BLOCKED = 255;

const AREA_DIAMOND_5 = [
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]
];

const AREA_DIAMOND_6 = [
    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]
];

/** Ring burst: outer ring hits; center hole; cell 2 = origin only (not hit). */
const AREA_RING1_BURST3 = [
    [0, 0, 0, 1, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 0],
    [1, 1, 1, 0, 0, 0, 1, 1, 1],
    [1, 1, 1, 0, 2, 0, 1, 1, 1],
    [1, 1, 1, 0, 0, 0, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 0, 0, 0]
];

const AREA_BEAM_0_RIGHT = {
    1: [[3]],
    2: [[3, 1]],
    3: [[3, 1, 1]],
    4: [[3, 1, 1, 1]],
    5: [[3, 1, 1, 1, 1]],
    6: [[3, 1, 1, 1, 1, 1]],
    7: [[3, 1, 1, 1, 1, 1, 1]],
    8: [[3, 1, 1, 1, 1, 1, 1, 1]],
    9: [[3, 1, 1, 1, 1, 1, 1, 1, 1]],
    10: [[3, 1, 1, 1, 1, 1, 1, 1, 1, 1]]
};

const AREA_WAVE_1_RIGHT = {
    1: [[1], [3], [1]],
    3: [
        [0, 1, 1],
        [3, 1, 1],
        [0, 1, 1]
    ]
};

const AREA_WAVE_2_RIGHT = {
    3: [
        [0, 0, 1],
        [0, 1, 1],
        [3, 1, 1],
        [0, 1, 1],
        [0, 0, 1]
    ],
    4: [
        [0, 0, 0, 1],
        [0, 1, 1, 1],
        [3, 1, 1, 1],
        [0, 1, 1, 1],
        [0, 0, 0, 1]
    ],
    5: [
        [0, 0, 0, 1, 1],
        [0, 1, 1, 1, 1],
        [3, 1, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [0, 0, 0, 1, 1]
    ],
    6: [
        [0, 0, 0, 1, 1, 1],
        [0, 1, 1, 1, 1, 1],
        [3, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 1]
    ],
    7: [
        [0, 0, 0, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1],
        [3, 1, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 1, 1]
    ],
    8: [
        [0, 0, 0, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1, 1],
        [3, 1, 1, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 1, 1, 1]
    ]
};

const AREA_WAVE_3_RIGHT = {
    4: [
        [0, 0, 0, 1],
        [0, 0, 1, 1],
        [0, 1, 1, 1],
        [3, 1, 1, 1],
        [0, 1, 1, 1],
        [0, 0, 1, 1],
        [0, 0, 0, 1]
    ],
    5: [
        [0, 0, 0, 1, 1],
        [0, 0, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [3, 1, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [0, 0, 1, 1, 1],
        [0, 0, 0, 1, 1]
    ],
    6: [
        [0, 0, 0, 1, 1, 1],
        [0, 0, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1],
        [3, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1],
        [0, 0, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 1]
    ],
    7: [
        [0, 0, 0, 1, 1, 1, 1],
        [0, 0, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1],
        [3, 1, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1],
        [0, 0, 1, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 1, 1]
    ],
    8: [
        [0, 0, 0, 1, 1, 1, 1, 1],
        [0, 0, 1, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1, 1],
        [3, 1, 1, 1, 1, 1, 1, 1],
        [0, 1, 1, 1, 1, 1, 1, 1],
        [0, 0, 1, 1, 1, 1, 1, 1],
        [0, 0, 0, 1, 1, 1, 1, 1]
    ]
};

const AREA_WAVE_4_RIGHT = {
    2: [
        [0, 0, 0, 1],
        [0, 0, 1, 1],
        [0, 1, 1, 1],
        [0, 1, 1, 1],
        [3, 1, 1, 1],
        [0, 1, 1, 1],
        [0, 1, 1, 1],
        [0, 0, 1, 1],
        [0, 0, 0, 1]
    ],
    3: [
        [0, 0, 0, 1, 1],
        [0, 0, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [3, 1, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [0, 0, 1, 1, 1],
        [0, 0, 0, 1, 1]
    ]
};

const AREA_WAVE_CUSTOM = {
    1: [
        [0, 0, 1, 1, 1],
        [3, 1, 1, 1, 1],
        [0, 0, 1, 1, 1]
    ],
    2: [
        [0, 0, 0, 1, 1],
        [0, 1, 1, 1, 1],
        [3, 1, 1, 1, 1],
        [0, 1, 1, 1, 1],
        [0, 0, 0, 1, 1]
    ],
    // Legacy AREA_FLURRY_OF_BLOWS (north) rotated 90° CW → east.
    'rapid_strikes': [
        [0, 0, 0, 0, 0, 0],
        [0, 1, 1, 1, 0, 0],
        [0, 0, 3, 1, 1, 0],
        [0, 1, 1, 1, 0, 0],
        [0, 0, 0, 0, 0, 0]
    ],
    // Legacy AREA_SWEEPING_CENTER (north) rotated 90° CW → east.
    // Full-damage pass of dual-combat Wide Takedown (outer is separate).
    'wide_takedown': [
        [0, 1, 1, 0, 0, 0],
        [0, 1, 1, 1, 0, 0],
        [0, 0, 3, 1, 0, 0],
        [0, 1, 1, 1, 0, 0],
        [0, 1, 1, 0, 0, 0]
    ],
    // Legacy AREA_SWEEPING_OUTER (north) rotated 90° CW → east.
    // Cell 2 = front origin not hit; 75% damage pass (spell.followupShapes).
    'wide_takedown_outer': [
        [0, 1, 1, 0],
        [0, 0, 1, 1],
        [2, 0, 1, 1],
        [0, 0, 1, 1],
        [0, 1, 1, 0]
    ],
    // Legacy AREA_GREATER_FLURRY_OF_BLOWS (north) rotated 90° CW → east.
    'greater_rapid_strikes': [
        [0, 0, 1, 0, 0, 0],
        [0, 1, 1, 1, 1, 0],
        [0, 0, 3, 1, 1, 1],
        [0, 1, 1, 1, 1, 0],
        [0, 0, 1, 0, 0, 0]
    ],
    // Legacy AREA_BALANCED_BRAWL (north) rotated 90° CW → east.
    // Cell 2 = front-of-caster origin, not a hit (legacy createArea).
    'even_contest': [
        [1, 0, 0, 0, 0, 0, 0, 0],
        [1, 1, 1, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 0, 0, 0],
        [1, 1, 1, 1, 1, 1, 0, 0],
        [0, 0, 1, 1, 1, 1, 0, 0],
        [0, 2, 1, 1, 1, 1, 1, 0],
        [0, 0, 1, 1, 1, 1, 0, 0],
        [1, 1, 1, 1, 1, 1, 0, 0],
        [1, 1, 1, 1, 1, 0, 0, 0],
        [1, 1, 1, 1, 0, 0, 0, 0],
        [1, 1, 1, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0, 0]
    ]
};

const WAVE_SPREAD_MAP = {
    0: AREA_BEAM_0_RIGHT,
    1: AREA_WAVE_1_RIGHT,
    2: AREA_WAVE_2_RIGHT,
    3: AREA_WAVE_3_RIGHT,
    4: AREA_WAVE_4_RIGHT,
    custom: AREA_WAVE_CUSTOM
};

const AREA_CIRCLE2X2 = [
    [0, 1, 1, 1, 0],
    [1, 1, 1, 1, 1],
    [1, 1, 3, 1, 1],
    [1, 1, 1, 1, 1],
    [0, 1, 1, 1, 0]
];

const AREA_CIRCLE3X3 = [
    [0, 0, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 3, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 0, 0]
];

const AREA_CIRCLE3X4 = [
    [0, 0, 0, 1, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 3, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 0, 0, 0]
];

const AREA_CIRCLE5X5 = [
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0]
];

const AREA_CIRCLE6X6 = [
    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0],
    [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0],
    [0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]
];

const AREA_SQUARE1X1 = [
    [1, 1, 1],
    [1, 3, 1],
    [1, 1, 1]
];

const AREA_DIAMOND1X1 = [
    [0, 1, 0],
    [1, 3, 1],
    [0, 1, 0]
];

/**
 * Cardinal wall field (5 tiles): horizontal line through target (authored east-west).
 * Rotated by caster→target cardinal in getAffectedTiles. Used by fire/poison wall runes.
 * Source: Legacy AREA_WALLFIELD / legacy node shapes.js.
 */
const AREA_WALLFIELD = [[1, 1, 3, 1, 1]];

/**
 * Energy wall field (7 tiles): longer horizontal line through target.
 * Source: Legacy AREA_WALLFIELD_ENERGY / legacy node shapes.js.
 */
const AREA_WALLFIELD_ENERGY = [[1, 1, 1, 3, 1, 1, 1]];

/**
 * Diagonal wall field companion (5×5 stair), NW-authored base.
 * Mirror/flip for NE/SW/SE (Legacy AreaCombat::setupExtArea).
 * Source: Legacy AREADIAGONAL_WALLFIELD.
 */
const AREA_DIAGONAL_WALLFIELD = [
    [0, 0, 0, 0, 1],
    [0, 0, 0, 1, 1],
    [0, 1, 3, 1, 0],
    [1, 1, 0, 0, 0],
    [1, 0, 0, 0, 0]
];

/**
 * Diagonal energy wall companion (7×7 stair), NW-authored base.
 * Source: Legacy AREADIAGONAL_WALLFIELD_ENERGY.
 */
const AREA_DIAGONAL_WALLFIELD_ENERGY = [
    [0, 0, 0, 0, 0, 0, 1],
    [0, 0, 0, 0, 0, 1, 1],
    [0, 0, 0, 0, 1, 1, 0],
    [0, 0, 1, 3, 1, 0, 0],
    [0, 1, 1, 0, 0, 0, 0],
    [0, 1, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0]
];

/** Single-tile self (legacy code 1 special-case). */
const AREA_SINGLE = [[3]];

/**
 * Named area codes for catalog + getAreaArray.
 * Primary numeric codes first; string aliases resolve to the same matrix.
 * Wall cardinal codes auto-select diagonal companions when facing is off-axis.
 * @type {Array<{ code: number|string, label: string, matrix: number[][] }>}
 */
const AREA_ENTRIES = [
    { code: 1, label: 'Single tile (self)', matrix: AREA_SINGLE },
    { code: 2, label: 'Diamond 1×1', matrix: AREA_DIAMOND1X1 },
    { code: 3, label: 'Square 1×1', matrix: AREA_SQUARE1X1 },
    { code: 4, label: 'Circle ~2×2', matrix: AREA_CIRCLE2X2 },
    { code: 5, label: 'Circle 3×3 (GFB)', matrix: AREA_CIRCLE3X3 },
    { code: 6, label: 'Circle 3×4', matrix: AREA_CIRCLE3X4 },
    { code: 7, label: "Circle 5×5 (Hell's Core)", matrix: AREA_CIRCLE5X5 },
    { code: 8, label: 'Circle 6×6 (Wrath of Nature)', matrix: AREA_CIRCLE6X6 },
    { code: 9, label: 'Diamond 6 (Rage of the Skies)', matrix: AREA_DIAMOND_6 },
    { code: 'glacial_cataclysm', label: 'Diamond 5 (Glacial Cataclysm)', matrix: AREA_DIAMOND_5 },
    { code: 'ring1_burst3', label: 'Ring burst 3 (Ice/Terra Burst)', matrix: AREA_RING1_BURST3 },
    // Wall fields (player runes); oriented via direction in getAffectedTiles
    { code: 'wall_field', label: 'Wall field (5)', matrix: AREA_WALLFIELD },
    { code: 'wall_field_energy', label: 'Wall field energy (7)', matrix: AREA_WALLFIELD_ENERGY },
    // Diagonal companions (catalog/preview; runtime pick is automatic for wall_field*)
    {
        code: 'wall_field_diag',
        label: 'Wall field diagonal (5 stair)',
        matrix: AREA_DIAGONAL_WALLFIELD
    },
    {
        code: 'wall_field_energy_diag',
        label: 'Wall field energy diagonal (7 stair)',
        matrix: AREA_DIAGONAL_WALLFIELD_ENERGY
    },
    // Aliases (same matrices; listed for exact match when presets use names)
    { code: 'gfb', label: 'Alias: gfb → circle 3×3', matrix: AREA_CIRCLE3X3 },
    { code: "hell's core", label: "Alias: hell's core → circle 5×5", matrix: AREA_CIRCLE5X5 },
    { code: 'wrath of nature', label: 'Alias: wrath of nature → circle 6×6', matrix: AREA_CIRCLE6X6 },
    { code: 'rage of the skies', label: 'Alias: rage of the skies → diamond 6', matrix: AREA_DIAMOND_6 }
];

/**
 * @param {unknown} matrix
 * @returns {number[][]}
 */
function cloneMatrix(matrix) {
    if (!Array.isArray(matrix)) return [];
    return matrix.map((row) => (Array.isArray(row) ? row.slice() : []));
}

/**
 * Resolve wave table key (0–4 or 'custom').
 * @param {unknown} spread
 * @returns {number|string}
 */
function normalizeWaveSpread(spread) {
    if (spread === 'custom' || spread === 'Custom') return 'custom';
    const n = Number(spread);
    if (Number.isFinite(n) && WAVE_SPREAD_MAP[n] != null) return n;
    if (spread != null && WAVE_SPREAD_MAP[/** @type {any} */ (spread)] != null) {
        return /** @type {number|string} */ (spread);
    }
    return 0;
}

/**
 * Lookup raw matrix for area / wave.
 * Mirrors legacy Shapes.getAreaArray.
 *
 * @param {string} spellType 'area' | 'wave' (other types fall through to wave path)
 * @param {unknown} code For area: number|string. For wave: shape-like {spread, length}.
 * @returns {number[][]}
 */
function getAreaArray(spellType, code) {
    if (spellType === 'area') {
        if (code === 1 || code === '1') {
            return cloneMatrix(AREA_SINGLE);
        }
        for (const entry of AREA_ENTRIES) {
            if (entry.code === code || String(entry.code) === String(code)) {
                return cloneMatrix(entry.matrix);
            }
        }
        // Legacy default for unknown area codes
        return cloneMatrix(AREA_CIRCLE6X6);
    }

    // Wave / beam: code is the shape object { spread, length }
    const shape = code && typeof code === 'object' ? /** @type {Record<string, unknown>} */ (code) : {};
    const spreadKey = normalizeWaveSpread(shape.spread ?? 0);
    const table = WAVE_SPREAD_MAP[spreadKey] || WAVE_SPREAD_MAP[0];
    const length = shape.length;
    let area = table[/** @type {any} */ (length)];
    if (!area && length != null) {
        // Try numeric coercion for string lengths like "4"
        const n = Number(length);
        if (Number.isFinite(n)) area = table[n];
    }
    return cloneMatrix(area || []);
}

/**
 * Build matrix from a spell.shape object (designer / combat helpers).
 * @param {unknown} shape
 * @returns {number[][]}
 */
function matrixFromShape(shape) {
    if (!shape || typeof shape !== 'object') return [];
    const s = /** @type {Record<string, unknown>} */ (shape);
    const type = String(s.type || 'area');
    if (type === 'area') {
        return getAreaArray('area', s.code);
    }
    if (type === 'wave' || type === 'beam') {
        return getAreaArray('wave', s);
    }
    return [];
}

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   type: string,
 *   shape: Record<string, unknown>,
 *   matrix: number[][]
 * }} ShapeCatalogEntry
 */

/**
 * Flat catalog of selectable shapes for the Designer picker.
 * Area entries use { type, code }; waves use { type, spread, length }.
 * @returns {ShapeCatalogEntry[]}
 */
function listShapeCatalog() {
    /** @type {ShapeCatalogEntry[]} */
    const out = [];

    for (const entry of AREA_ENTRIES) {
        // Skip pure aliases from primary list? Keep them — presets use string codes.
        out.push({
            id: `area:${String(entry.code)}`,
            label: `Area · ${entry.label}`,
            type: 'area',
            shape: { type: 'area', code: entry.code },
            matrix: cloneMatrix(entry.matrix)
        });
    }

    for (const [spreadKey, table] of Object.entries(WAVE_SPREAD_MAP)) {
        const spread =
            spreadKey === 'custom' ? 'custom' : Number(spreadKey);
        const lengths = Object.keys(table);
        for (const lenKey of lengths) {
            const length = /^\d+$/.test(lenKey) ? Number(lenKey) : lenKey;
            const matrix = table[/** @type {any} */ (lenKey)];
            const spreadLabel =
                spread === 'custom'
                    ? 'custom'
                    : spread === 0
                      ? 'beam (0)'
                      : String(spread);
            out.push({
                id: `wave:${String(spread)}:${String(length)}`,
                label: `Wave · spread ${spreadLabel} · length ${length}`,
                type: 'wave',
                shape: { type: 'wave', spread, length },
                matrix: cloneMatrix(matrix)
            });
        }
    }

    return out;
}

/**
 * Match a catalog entry id for an existing shape object (best-effort).
 * @param {unknown} shape
 * @returns {string|null}
 */
function catalogIdForShape(shape) {
    if (!shape || typeof shape !== 'object') return null;
    const s = /** @type {Record<string, unknown>} */ (shape);
    const type = String(s.type || '');
    if (type === 'area') {
        if (s.code == null) return null;
        return `area:${String(s.code)}`;
    }
    if (type === 'wave' || type === 'beam') {
        const spread = normalizeWaveSpread(s.spread ?? 0);
        const length = s.length;
        if (length == null) return null;
        return `wave:${String(spread)}:${String(length)}`;
    }
    return null;
}

/**
 * Short display string for form summary.
 * @param {unknown} shape
 * @returns {string}
 */
function formatShapeSummary(shape) {
    if (!shape || typeof shape !== 'object') return '—';
    const s = /** @type {Record<string, unknown>} */ (shape);
    const type = String(s.type || '');
    if (type === 'area') {
        return s.code != null ? `area · code ${s.code}` : 'area';
    }
    if (type === 'wave' || type === 'beam') {
        const bits = [type];
        if (s.spread != null) bits.push(`spread ${s.spread}`);
        if (s.length != null) bits.push(`length ${s.length}`);
        if (s.code != null) bits.push(`code ${s.code}`);
        return bits.join(' · ');
    }
    return type || '—';
}

/**
 * Render matrix as plain text (debug / tests).
 * @param {number[][]} matrix
 * @returns {string}
 */
function matrixToAscii(matrix) {
    if (!Array.isArray(matrix) || !matrix.length) return '(empty)';
    return matrix
        .map((row) =>
            (Array.isArray(row) ? row : [])
                .map((c) => {
                    if (c === 3) return '@';
                    if (c === 1) return '#';
                    if (c === 2) return '*';
                    return '.';
                })
                .join('')
        )
        .join('\n');
}

/**
 * @param {unknown} shape
 * @returns {'area'|'wave'}
 */
function spellTypeFromShape(shape) {
    if (!shape || typeof shape !== 'object') return 'area';
    const t = String(/** @type {Record<string, unknown>} */ (shape).type || 'area');
    if (t === 'wave' || t === 'beam') return 'wave';
    return 'area';
}

/**
 * Whether an area shape should orient with caster→center facing.
 * Symmetric circles/diamonds ignore facing; wall fields are lines and need it
 * (cardinal rotate + diagonal stair companion when off-axis).
 * @param {unknown} shape
 * @returns {boolean}
 */
function areaShapeUsesDirection(shape) {
    if (!shape || typeof shape !== 'object') return false;
    const s = /** @type {Record<string, unknown>} */ (shape);
    if (String(s.type || 'area') !== 'area') return false;
    return isWallFieldCode(s.code);
}

/**
 * Wall-field family codes that support diagonal companions.
 * @param {unknown} code
 * @returns {boolean}
 */
function isWallFieldCode(code) {
    return (
        code === 'wall_field' ||
        code === 'wall_field_energy' ||
        code === 'wall_field_diag' ||
        code === 'wall_field_energy_diag'
    );
}

/**
 * NW-authored diagonal companion for a wall cardinal code.
 * @param {unknown} code
 * @returns {number[][]|null}
 */
function diagonalWallMatrixForCode(code) {
    if (code === 'wall_field' || code === 'wall_field_diag') {
        return AREA_DIAGONAL_WALLFIELD;
    }
    if (code === 'wall_field_energy' || code === 'wall_field_energy_diag') {
        return AREA_DIAGONAL_WALLFIELD_ENERGY;
    }
    return null;
}

/**
 * Horizontal mirror (reverse each row). Legacy MATRIXOPERATION_MIRROR.
 * @param {number[][]} matrix
 * @returns {number[][]}
 */
function mirrorMatrix(matrix) {
    if (!Array.isArray(matrix)) return [];
    return matrix.map((row) =>
        Array.isArray(row) ? row.slice().reverse() : []
    );
}

/**
 * Vertical flip (reverse row order). Legacy MATRIXOPERATION_FLIP.
 * @param {number[][]} matrix
 * @returns {number[][]}
 */
function flipMatrix(matrix) {
    if (!Array.isArray(matrix)) return [];
    return matrix
        .slice()
        .reverse()
        .map((row) => (Array.isArray(row) ? row.slice() : []));
}

/**
 * Orient NW-authored diagonal wall matrix for an 8-dir facing.
 * Legacy setupExtArea: NW base, mirror→NE, flip→SW, mirror(SW)→SE.
 * @param {number[][]} baseNw
 * @param {{x:number,y:number}|null|undefined} direction
 * @returns {number[][]}
 */
function orientDiagonalWallMatrix(baseNw, direction) {
    const dir = direction || { x: -1, y: -1 };
    const dx = Number(dir.x) || 0;
    const dy = Number(dir.y) || 0;
    if (dx > 0 && dy < 0) return mirrorMatrix(baseNw);
    if (dx < 0 && dy > 0) return flipMatrix(baseNw);
    if (dx > 0 && dy > 0) return mirrorMatrix(flipMatrix(baseNw));
    // NW (default for diagonal) and any ambiguous fallback
    return cloneMatrix(baseNw);
}

/**
 * Find matrix origin anchor: cell 3 (hit + origin) or cell 2 (origin only, not hit).
 * Legacy ring/burst and even_contest use 2 when the origin tile is empty.
 * @param {number[][]} area
 * @returns {{ row: number, col: number, cell: number }|null}
 */
function findOriginInMatrix(area) {
    if (!Array.isArray(area)) return null;
    let fallback2 = null;
    for (let i = 0; i < area.length; i++) {
        const row = area[i];
        if (!Array.isArray(row)) continue;
        for (let j = 0; j < row.length; j++) {
            const v = row[j];
            if (v === 3) return { row: i, col: j, cell: 3 };
            if (v === 2 && !fallback2) fallback2 = { row: i, col: j, cell: 2 };
        }
    }
    return fallback2;
}

/**
 * Cardinal direction from a toward b (legacy wave facing).
 * Ties prefer horizontal.
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @returns {{x:number,y:number}}
 */
function cardinalDirection(from, to) {
    if (!from || !to) return { x: 1, y: 0 };
    const dx = Number(to.x) - Number(from.x);
    const dy = Number(to.y) - Number(from.y);
    if (Math.abs(dx) >= Math.abs(dy)) {
        return { x: dx >= 0 ? 1 : -1, y: 0 };
    }
    return { x: 0, y: dy >= 0 ? 1 : -1 };
}

/**
 * 8-dir facing from a toward b (Legacy AreaCombat::getArea).
 * When both axes nonzero → true diagonal (does not require |dx|==|dy|).
 * Pure axis → cardinal. Zero offset → east default.
 * Used for wall fields; waves stay on cardinalDirection.
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @returns {{x:number,y:number}}
 */
function octantDirection(from, to) {
    if (!from || !to) return { x: 1, y: 0 };
    const dx = Number(to.x) - Number(from.x);
    const dy = Number(to.y) - Number(from.y);
    if (dx === 0 && dy === 0) return { x: 1, y: 0 };
    if (dx !== 0 && dy !== 0) {
        return { x: dx > 0 ? 1 : -1, y: dy > 0 ? 1 : -1 };
    }
    if (dx !== 0) return { x: dx > 0 ? 1 : -1, y: 0 };
    return { x: 0, y: dy > 0 ? 1 : -1 };
}

/**
 * Whether direction is a true diagonal (both axes nonzero).
 * @param {{x:number,y:number}|null|undefined} direction
 * @returns {boolean}
 */
function isDiagonalDirection(direction) {
    if (!direction) return false;
    return Number(direction.x) !== 0 && Number(direction.y) !== 0;
}

/**
 * Rotate matrix-relative offset for cardinal facing.
 * Matrices are authored facing east (+x); 0° = east (legacy right).
 * @param {number} dx
 * @param {number} dy
 * @param {{x:number,y:number}|null|undefined} direction
 * @returns {{x:number,y:number}}
 */
function rotateOffset(dx, dy, direction) {
    const dir = direction || { x: 1, y: 0 };
    let x = dx;
    let y = dy;
    // East (default / authored)
    if (dir.x === 1 && dir.y === 0) {
        /* keep */
    } else if (dir.x === -1 && dir.y === 0) {
        // West 180°
        x = -dx;
        y = -dy;
    } else if (dir.x === 0 && dir.y === -1) {
        // North (screen -y) → -90°
        x = dy;
        y = -dx;
    } else if (dir.x === 0 && dir.y === 1) {
        // South +90°
        x = -dy;
        y = dx;
    }
    // Normalize -0 from unary minus (deepStrictEqual treats -0 ≠ 0)
    if (Object.is(x, -0)) x = 0;
    if (Object.is(y, -0)) y = 0;
    return { x, y };
}

/**
 * Whether a tile is non-walkable (area footprint / solid ground).
 * Does **not** mean LoS is blocked (water is walk-blocked, sight-clear).
 * @param {object|null|undefined} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {boolean}
 */
function isTileWalkBlocked(tileMap, x, y, z) {
    if (!tileMap) return false;
    // Prefer friction (authoritative walk-block); mocks often set isWalkable
    // always-true while using getFriction for walls.
    if (typeof tileMap.getFriction === 'function') {
        return tileMap.getFriction(x, y, z) === FRICTION_BLOCKED;
    }
    if (typeof tileMap.isWalkable === 'function') {
        return !tileMap.isWalkable(x, y, z);
    }
    return false;
}

/**
 * Whether a tile blocks line of sight / projectiles.
 * Prefers tileMap.blocksSight; falls back to walk-block (legacy couple).
 * @param {object|null|undefined} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {boolean}
 */
function isTileSightBlocked(tileMap, x, y, z) {
    if (!tileMap) return false;
    if (typeof tileMap.blocksSight === 'function') {
        return !!tileMap.blocksSight(x, y, z);
    }
    // Legacy mock maps: only getFriction / isWalkable — couple sight to walk
    return isTileWalkBlocked(tileMap, x, y, z);
}

/**
 * @deprecated Use isTileWalkBlocked (area) or isTileSightBlocked (LoS).
 * Kept as walk-block alias for older call sites / tests.
 */
function isTileBlocked(tileMap, x, y, z) {
    return isTileWalkBlocked(tileMap, x, y, z);
}

/**
 * Bresenham line-of-sight (tiles with sight-block cut the ray).
 * Walk-only blockers (water) do **not** cut. Adjacent always clear.
 * When tileMap is omitted, always true.
 *
 * Intermediate tiles only: origin/destination are not required to be
 * sight-clear (attacker stands on open ground; dest is usually a creature).
 *
 * @param {number} x1
 * @param {number} y1
 * @param {string|number} z1
 * @param {number} x2
 * @param {number} y2
 * @param {string|number} z2
 * @param {object|null|undefined} tileMap
 * @returns {boolean}
 */
function hasLineOfSight(x1, y1, z1, x2, y2, z2, tileMap) {
    if (String(z1) !== String(z2)) return false;
    const dx0 = Math.abs(x2 - x1);
    const dy0 = Math.abs(y2 - y1);
    if (dx0 <= 1 && dy0 <= 1) return true;
    if (!tileMap) return true;

    let dx = dx0;
    let dy = dy0;
    const sx = x1 < x2 ? 1 : -1;
    const sy = y1 < y2 ? 1 : -1;
    let err = dx - dy;
    let x = x1;
    let y = y1;

    while (true) {
        // Skip origin: standing tile must not self-block the ray.
        if (!(x === x1 && y === y1)) {
            if (x === x2 && y === y2) break;
            if (isTileSightBlocked(tileMap, x, y, z1)) return false;
        }
        if (x === x2 && y === y2) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x += sx;
        }
        if (e2 < dx) {
            err += dx;
            y += sy;
        }
    }
    return true;
}

/**
 * Filter world tiles for area (drop blocked) or wave (require LoS from center).
 * @param {{x:number,y:number,z?:*}} center
 * @param {{x:number,y:number}[]} affectedTiles
 * @param {string|number} z
 * @param {'area'|'wave'} spellType
 * @param {object|null|undefined} tileMap
 * @returns {{x:number,y:number,z?:*}[]}
 */
function filterAffectedTilesWithObstacles(
    center,
    affectedTiles,
    z,
    spellType,
    tileMap
) {
    if (!affectedTiles || !affectedTiles.length) return [];
    if (!tileMap) {
        return affectedTiles.map((t) => ({
            x: t.x,
            y: t.y,
            z: t.z !== undefined ? t.z : z
        }));
    }

    if (spellType === 'area') {
        const out = [];
        for (let i = 0; i < affectedTiles.length; i++) {
            const tile = affectedTiles[i];
            // Area hits only walkable ground (water has no combatants / fields).
            if (!isTileWalkBlocked(tileMap, tile.x, tile.y, z)) {
                out.push({ x: tile.x, y: tile.y, z });
            }
        }
        return out;
    }

    if (spellType === 'wave') {
        const filtered = [];
        const visited = Object.create(null);
        const cz = center.z !== undefined ? center.z : z;
        for (let i = 0; i < affectedTiles.length; i++) {
            const tile = affectedTiles[i];
            const key = tile.x + ',' + tile.y;
            if (visited[key]) continue;
            if (isTileBlocked(tileMap, tile.x, tile.y, z)) continue;
            if (
                !hasLineOfSight(
                    center.x,
                    center.y,
                    cz,
                    tile.x,
                    tile.y,
                    z,
                    tileMap
                )
            ) {
                continue;
            }
            visited[key] = true;
            filtered.push({ x: tile.x, y: tile.y, z });
        }
        return filtered;
    }

    return affectedTiles.map((t) => ({ x: t.x, y: t.y, z }));
}

/**
 * World tiles covered by a spell shape (legacy Shapes.getAffectedTiles).
 *
 * Matrices are authored facing east; pass direction for waves/beams.
 * Area spells optionally require LoS from caster → center before expanding.
 *
 * @param {object} opts
 * @param {{x:number,y:number,z?:*}|null} [opts.caster] caster tile (LoS for area)
 * @param {{x:number,y:number,z?:*}} opts.center origin cell (3) in world space
 * @param {Record<string, unknown>|null|undefined} opts.shape spell.shape bag
 * @param {{x:number,y:number}} [opts.direction] cardinal facing (default east)
 * @param {object|null} [opts.tileMap] TileMap for LoS / blocked filter
 * @returns {{x:number,y:number,z?:*}[]}
 */
function getAffectedTiles(opts) {
    const o = opts || {};
    const center = o.center;
    if (
        !center ||
        typeof center.x !== 'number' ||
        typeof center.y !== 'number'
    ) {
        return [];
    }
    const shape = o.shape;
    if (!shape || typeof shape !== 'object') {
        return [{ x: center.x, y: center.y, z: center.z }];
    }

    const spellType = spellTypeFromShape(shape);
    const z =
        center.z !== undefined
            ? center.z
            : o.caster && o.caster.z !== undefined
              ? o.caster.z
              : 0;
    const direction = o.direction || { x: 1, y: 0 };
    const tileMap = o.tileMap || null;

    // Area code 1 = single tile (legacy special-case)
    if (
        spellType === 'area' &&
        (/** @type {any} */ (shape).code === 1 ||
            /** @type {any} */ (shape).code === '1')
    ) {
        return [{ x: center.x, y: center.y, z }];
    }

    const code =
        spellType === 'area' ? /** @type {any} */ (shape).code : shape;

    // Wall fields: diagonal aim uses stair companion (no cardinal rotate);
    // pure axis keeps east-authored line + rotateOffset (Phase A).
    let area;
    let applyCardinalRotate = true;
    if (
        spellType === 'area' &&
        isWallFieldCode(/** @type {any} */ (code)) &&
        isDiagonalDirection(direction)
    ) {
        const baseNw = diagonalWallMatrixForCode(/** @type {any} */ (code));
        area = baseNw
            ? orientDiagonalWallMatrix(baseNw, direction)
            : getAreaArray(spellType, code);
        applyCardinalRotate = false;
    } else {
        area = getAreaArray(spellType, code);
    }
    if (!Array.isArray(area) || !area.length) return [];

    const origin = findOriginInMatrix(area);
    if (!origin) return [];

    // Area (not wave): require LoS caster → center when both provided
    if (
        spellType === 'area' &&
        o.caster &&
        typeof o.caster.x === 'number' &&
        typeof o.caster.y === 'number'
    ) {
        const cz = o.caster.z !== undefined ? o.caster.z : z;
        if (String(cz) !== String(z)) return [];
        if (
            !hasLineOfSight(
                o.caster.x,
                o.caster.y,
                cz,
                center.x,
                center.y,
                z,
                tileMap
            )
        ) {
            return [];
        }
    }

    /** @type {{x:number,y:number}[]} */
    const raw = [];
    for (let i = 0; i < area.length; i++) {
        const row = area[i];
        if (!Array.isArray(row)) continue;
        for (let j = 0; j < row.length; j++) {
            const cell = row[j];
            if (cell !== 1 && cell !== 3) continue;
            const dx = j - origin.col;
            const dy = i - origin.row;
            // Diagonal wall companions are pre-oriented; do not rotateOffset.
            const off = applyCardinalRotate
                ? rotateOffset(dx, dy, direction)
                : { x: dx, y: dy };
            raw.push({ x: center.x + off.x, y: center.y + off.y });
        }
    }

    return filterAffectedTilesWithObstacles(
        { x: center.x, y: center.y, z },
        raw,
        z,
        spellType,
        tileMap
    );
}

/**
 * Living entities whose tile is in the affected set (same floor).
 * @param {object[]} entities
 * @param {{x:number,y:number}[]} tiles
 * @param {string|number} z
 * @returns {object[]}
 */
function entitiesOnTiles(entities, tiles, z) {
    if (!entities || !tiles || !tiles.length) return [];
    const set = Object.create(null);
    for (let i = 0; i < tiles.length; i++) {
        set[tiles[i].x + ',' + tiles[i].y] = true;
    }
    const out = [];
    for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e || !e.tile || e.alive === false) continue;
        if (e.hp && e.hp.current <= 0) continue;
        if (String(e.tile.z) !== String(z)) continue;
        if (set[e.tile.x + ',' + e.tile.y]) out.push(e);
    }
    return out;
}

/**
 * Rank area blast centers that maximize hits (legacy bot findTopAttackPositions).
 * Used by resolveAreaCenter when centerMode is **maximize** (Smart Cast action
 * bar, player/creature AI). Manual castWith tile aim and Active Target use
 * primary-tile centering instead. Wave shapes return [] (facing from caster).
 *
 * @param {{x:number,y:number}} casterTile
 * @param {object[]} targets entities with .tile
 * @param {Record<string, unknown>} shape area shape
 * @param {number} [topN=10]
 * @returns {{x:number,y:number,hits:number}[]}
 */
function findTopAreaCenters(casterTile, targets, shape, topN) {
    if (!shape || spellTypeFromShape(shape) !== 'area') return [];
    if (!targets || !targets.length || !casterTile) return [];

    const area = matrixFromShape(shape);
    if (!area.length || !area[0] || !area[0].length) return [];
    const origin = findOriginInMatrix(area);
    if (!origin) return [];

    const numRows = area.length;
    const numCols = area[0].length;
    const halfH = Math.floor(numRows / 2);
    const halfW = Math.floor(numCols / 2);

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let t = 0; t < targets.length; t++) {
        const tile = targets[t] && targets[t].tile;
        if (!tile) continue;
        if (tile.x < minX) minX = tile.x;
        if (tile.x > maxX) maxX = tile.x;
        if (tile.y < minY) minY = tile.y;
        if (tile.y > maxY) maxY = tile.y;
    }
    if (!Number.isFinite(minX)) return [];

    minX -= halfW;
    maxX += halfW;
    minY -= halfH;
    maxY += halfH;

    /** @type {{x:number,y:number,hits:number}[]} */
    const candidates = [];
    for (let cx = minX; cx <= maxX; cx++) {
        for (let cy = minY; cy <= maxY; cy++) {
            let count = 0;
            for (let t = 0; t < targets.length; t++) {
                const ent = targets[t];
                if (!ent || !ent.tile) continue;
                const dx = ent.tile.x - cx;
                const dy = ent.tile.y - cy;
                const col = origin.col + dx;
                const row = origin.row + dy;
                if (row < 0 || row >= numRows || col < 0 || col >= numCols) {
                    continue;
                }
                if (area[row][col] >= 1) count += 1;
            }
            if (count > 0) {
                candidates.push({ x: cx, y: cy, hits: count });
            }
        }
    }

    const px = casterTile.x;
    const py = casterTile.y;
    candidates.sort((a, b) => {
        if (b.hits !== a.hits) return b.hits - a.hits;
        const distA = Math.abs(a.x - px) + Math.abs(a.y - py);
        const distB = Math.abs(b.x - px) + Math.abs(b.y - py);
        if (distA !== distB) return distA - distB;
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
    });

    const n = topN != null ? Math.max(0, topN | 0) : 10;
    return candidates.slice(0, n);
}

module.exports = {
    getAreaArray,
    matrixFromShape,
    listShapeCatalog,
    catalogIdForShape,
    formatShapeSummary,
    matrixToAscii,
    spellTypeFromShape,
    areaShapeUsesDirection,
    isWallFieldCode,
    diagonalWallMatrixForCode,
    mirrorMatrix,
    flipMatrix,
    orientDiagonalWallMatrix,
    findOriginInMatrix,
    cardinalDirection,
    octantDirection,
    isDiagonalDirection,
    rotateOffset,
    hasLineOfSight,
    isTileBlocked,
    isTileWalkBlocked,
    isTileSightBlocked,
    filterAffectedTilesWithObstacles,
    getAffectedTiles,
    entitiesOnTiles,
    findTopAreaCenters,
    WAVE_SPREAD_MAP,
    AREA_ENTRIES,
    FRICTION_BLOCKED,
    SIGHT_BLOCKED
};
