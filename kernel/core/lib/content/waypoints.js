/**
 * Waypoint presets for hunt authoring (Stage 9).
 * Mirrors the legacy waypoint-presets idea: named routes reused by hunts.
 *
 * Files: presets/waypoints/<id>.json
 *   { id, label?, floor?, mapPath?, waypoints: [{x,y,z}] }
 */

'use strict';

/**
 * Normalize a waypoint list (round coords; default z).
 * @param {object[]} list
 * @param {string|number} [defaultZ=0]
 * @returns {{ x: number, y: number, z: string|number }[]}
 */
function normalizeWaypoints(list, defaultZ) {
    if (!Array.isArray(list)) return [];
    const z0 = defaultZ !== undefined ? defaultZ : 0;
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (!w || w.x == null || w.y == null) continue;
        out.push({
            x: Math.round(Number(w.x)),
            y: Math.round(Number(w.y)),
            z: w.z !== undefined ? w.z : z0
        });
    }
    return out;
}

/**
 * Expand hunt / party config: if waypointPreset is set and waypoints empty,
 * load the named preset. Inline waypoints always win.
 *
 * @param {object} hunt
 * @param {{ loadWaypointPreset?: (id: string) => object }} [opts]
 * @returns {object} shallow clone with waypoints resolved
 */
function resolveHuntWaypoints(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    const options = opts || {};
    const out = Object.assign({}, hunt);

    if (Array.isArray(out.waypoints) && out.waypoints.length) {
        out.waypoints = normalizeWaypoints(
            out.waypoints,
            out.floor != null ? out.floor : 0
        );
        return out;
    }

    const presetId = out.waypointPreset || out.waypointsId || null;
    if (!presetId) {
        out.waypoints = [];
        return out;
    }

    let preset = null;
    if (typeof options.loadWaypointPreset === 'function') {
        preset = options.loadWaypointPreset(presetId);
    } else {
        const presets = require('../presets.js');
        preset = presets.loadWaypointPreset(presetId);
    }

    if (!preset) {
        throw new Error(`resolveHuntWaypoints: unknown waypoint preset "${presetId}"`);
    }

    const floor =
        out.floor !== undefined
            ? out.floor
            : preset.floor !== undefined
              ? preset.floor
              : 0;
    if (out.floor === undefined && preset.floor !== undefined) {
        out.floor = preset.floor;
    }
    if (out.mapPath == null && preset.mapPath) {
        out.mapPath = preset.mapPath;
    }
    out.waypoints = normalizeWaypoints(preset.waypoints || [], floor);
    out._waypointPresetId = preset.id || presetId;
    return out;
}

module.exports = {
    normalizeWaypoints,
    resolveHuntWaypoints
};
