/**
 * Shared message protocol for Engine Tweakings popup ↔ parent.
 * Channel string must match on both sides.
 */

'use strict';

const ENGINE_TWEAKS_CHANNEL = 'hunt-design-lab-tweaks';
const ENGINE_TWEAKS_WINDOW_NAME = 'hunt_design_lab_tweakings';
/** Path from repo root (resolve with appUrl in the parent). */
const ENGINE_TWEAKS_URL_PATH = 'html/widgets/engine_tweakings/index.html';

module.exports = {
    ENGINE_TWEAKS_CHANNEL,
    ENGINE_TWEAKS_WINDOW_NAME,
    ENGINE_TWEAKS_URL_PATH
};
