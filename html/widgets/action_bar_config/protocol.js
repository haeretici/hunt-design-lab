/**
 * Shared message protocol for Action Bar Config popup ↔ parent.
 * Channel string must match on both sides.
 */

'use strict';

const ACTION_BAR_CHANNEL = 'hunt-design-lab-action-bar';
const ACTION_BAR_WINDOW_NAME = 'hunt_design_lab_action_bar_config';
/** Path from repo root (resolve with appUrl in the parent). */
const ACTION_BAR_URL_PATH = 'html/widgets/action_bar_config/index.html';

module.exports = {
    ACTION_BAR_CHANNEL,
    ACTION_BAR_WINDOW_NAME,
    ACTION_BAR_URL_PATH
};
