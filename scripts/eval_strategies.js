#!/usr/bin/env node
/**
 * Strategy preset eval / tune (Stage 12F) — thin entry for scripts/.
 * Full CLI: bin/sim_eval_strategies.js
 *
 * Usage:
 *   node scripts/eval_strategies.js
 *   node scripts/eval_strategies.js --strategies balanced,pacifist --seed 1
 *   node scripts/eval_strategies.js --tune --iterations 8
 *   npm run sim:eval-strategies -- --list
 */

'use strict';

const { main } = require('../bin/sim_eval_strategies.js');

main().catch((err) => {
    console.error('eval_strategies FAILED:', err);
    process.exit(1);
});
