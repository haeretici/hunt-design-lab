/**
 * Shared sample walk coordinates (Stage 3+ ghost-walk / fallback route only).
 * Prefer presets/waypoints/*.json for hunt authoring (Stage 9).
 * Validated against the synthetic floor-07 reference corridor
 * (assets/legacy/maps/v01/floor-07-path.png, horizontal walkable run ~y=96).
 * Regenerate map with: python3 bin/build_legacy_map_reference.py
 * No creature / monster names here.
 */

/** @type {{ x: number, y: number, z: number }[]} */
const DEFAULT_FLOOR07_WAYPOINTS = [
    { x: 651, y: 1026, z: 7 },
    { x: 670, y: 1026, z: 7 },
    { x: 675, y: 1026, z: 7 },
    { x: 680, y: 1026, z: 7 },
    { x: 690, y: 1026, z: 7 }
];

module.exports = {
    DEFAULT_FLOOR07_WAYPOINTS
};
