/**
 * Combat package entry (Stage 4 + shaped multi-target + elemental fields).
 */

const damage = require('./damage.js');
const cooldowns = require('./cooldowns.js');
const resolve = require('./resolve.js');
const area = require('./area.js');
const chain = require('./chain.js');
const conditions = require('./conditions.js');
const elementalFields = require('./elemental_fields.js');
const delayedCast = require('./delayed_cast.js');
const castRange = require('./cast_range.js');

module.exports = {
    ...damage,
    Cooldowns: cooldowns,
    ...cooldowns,
    ...resolve,
    ...area,
    ...chain,
    ...conditions,
    ...elementalFields,
    ...delayedCast,
    ...castRange
};
