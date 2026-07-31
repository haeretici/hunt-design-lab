/**
 * Shared message protocol for Hunt Sim Batch Builder popup ↔ parent.
 * Channel string must match on both sides — do not reuse Engine Tweakings channel.
 */

'use strict';

const SIM_BATCH_CHANNEL = 'hunt-design-lab-sim-batch';
const SIM_BATCH_WINDOW_NAME = 'hunt_design_lab_sim_batch';
/** Path from repo root (resolve with appUrl in the parent). */
const SIM_BATCH_URL_PATH = 'sim-batch-builder.php?popup=1';

module.exports = {
    SIM_BATCH_CHANNEL,
    SIM_BATCH_WINDOW_NAME,
    SIM_BATCH_URL_PATH
};
