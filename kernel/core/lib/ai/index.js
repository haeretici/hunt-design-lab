/**
 * Hunt AI package (Stage 5).
 */

const targeting = require('./targeting.js');
const strategy = require('./strategy.js');
const combatActions = require('./combat_actions.js');
const playerStates = require('./player_states.js');
const creatureStates = require('./creature_states.js');
const huntAi = require('./hunt_ai.js');
const cadence = require('./cadence.js');
const creatureKit = require('./creature_kit.js');

module.exports = {
    ...targeting,
    ...strategy,
    ...combatActions,
    ...playerStates,
    ...creatureStates,
    ...huntAi,
    ...cadence,
    ...creatureKit
};
