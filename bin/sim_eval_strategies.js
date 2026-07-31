#!/usr/bin/env node
/**
 * Strategy preset eval / tune CLI (Stage 12F).
 *
 * Usage:
 *   npm run sim:eval-strategies
 *   node bin/sim_eval_strategies.js --strategies balanced,guardian_aggro --seed 1
 *   node bin/sim_eval_strategies.js --tune --iterations 8 --side-swap
 *   node bin/sim_eval_strategies.js --list
 *   node bin/sim_eval_strategies.js --class guardian --rank-by meanTimeToClear
 *
 * Writes strategy_eval.json + strategy_eval.tsv under --out
 * (default: var/sim/strategy_eval/eval_<stamp>/).
 */

'use strict';

const path = require('path');
const {
    listStrategyIds,
    runStrategyEval,
    runStrategyTune
} = require('../kernel/core/lib/balance_sweep.js');
const {
    defaultSimOutDir,
    stableStringify
} = require('../kernel/providers/simulator/headless_runner.js');

function printHelp() {
    console.log(`Strategy preset eval / tune (Stage 12F).

Ranks each strategy on a hunt. Default party = hunt roster classes/gear
with strategyId swapped on every member (open decision: swap strategy only).

Usage:
  node bin/sim_eval_strategies.js [options]
  npm run sim:eval-strategies -- --strategies balanced,pacifist --seed 1
  npm run sim:eval-strategies -- --tune --iterations 8

Options:
  --hunt <id>            Hunt preset (default: cave_crawl_generated)
  --strategies <list>    Comma-separated strategy ids (default: all)
  --class <id>           Solo that class instead of hunt default party
  --seed <n>             Base seed (default 1)
  --iterations <n>       Hunts per strategy (default 1; tune default 8)
  --frames <n>           Max logic frames per hunt
  --max-ticks <n>        Session maxTicks
  --rank-by <metric>     Ranking key (default meanExpPerHour)
  --lower-is-better      Invert rank-by (auto for time/deaths/wipe metrics)
  --side-swap            Average leader↔follower mirror (multi-member parties)
  --tune                 Larger default batch + side-swap (human tune loop)
  --out <dir>            Output directory (JSON + TSV)
  --list                 List strategy ids and exit
  --quiet                Suppress per-strategy progress (default)
  --verbose              Log each strategy metrics line
  -h, --help

Metrics (from batch aggregate means/rates):
  routeCompleteRate, partyWipeRate, timeoutRate, meanKills, meanDeaths,
  meanDamageDealt, meanDamageTaken, meanExpPerHour, meanTimeToClear

Exit: compact ranking JSON on stdout. Files under --out.
`);
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const out = {
        huntId: 'cave_crawl_generated',
        strategyIds: null,
        classId: null,
        seed: 1,
        iterations: null,
        frames: undefined,
        maxTicks: undefined,
        rankBy: 'meanExpPerHour',
        lowerIsBetter: null,
        sideSwap: false,
        tune: false,
        outDir: undefined,
        list: false,
        quiet: true,
        help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
            continue;
        }
        if (a === '--list') {
            out.list = true;
            continue;
        }
        if (a === '--quiet') {
            out.quiet = true;
            continue;
        }
        if (a === '--verbose') {
            out.quiet = false;
            continue;
        }
        if (a === '--tune') {
            out.tune = true;
            continue;
        }
        if (a === '--side-swap' || a === '--sideswap') {
            out.sideSwap = true;
            continue;
        }
        if (a === '--lower-is-better') {
            out.lowerIsBetter = true;
            continue;
        }
        if (a === '--hunt' || a === '--huntId') {
            out.huntId = argv[++i];
            continue;
        }
        if (a === '--strategies' || a === '--strategy') {
            out.strategyIds = String(argv[++i])
                .split(/[\s,;]+/)
                .filter(Boolean);
            continue;
        }
        if (a === '--class' || a === '--classId') {
            out.classId = argv[++i];
            continue;
        }
        if (a === '--seed' || a === '-s') {
            out.seed = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--iterations' || a === '-n') {
            out.iterations = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--frames') {
            out.frames = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--max-ticks' || a === '--maxTicks') {
            out.maxTicks = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--rank-by' || a === '--rankBy') {
            out.rankBy = argv[++i];
            continue;
        }
        if (a === '--out' || a === '--outDir') {
            out.outDir = argv[++i];
            continue;
        }
        if (a.startsWith('-')) {
            throw new Error(`Unknown flag: ${a}`);
        }
        // Optional inline JSON (soccer-style)
        if (a.startsWith('{')) {
            try {
                const extra = JSON.parse(a);
                Object.assign(out, extra);
            } catch (err) {
                throw new Error(`Invalid JSON arg: ${err.message}`);
            }
            continue;
        }
    }
    return out;
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<object|void>}
 */
async function main(argv) {
    let parsed;
    try {
        parsed = parseArgs(argv || process.argv.slice(2));
    } catch (err) {
        console.error(err.message || err);
        process.exitCode = 2;
        return;
    }

    if (parsed.help) {
        printHelp();
        return;
    }

    if (parsed.list) {
        console.log(stableStringify(listStrategyIds()));
        return;
    }

    let outDir = parsed.outDir;
    if (!outDir) {
        const stamp = Date.now();
        const prefix = parsed.tune ? 'tune' : 'eval';
        outDir = path.join(defaultSimOutDir(), 'strategy_eval', `${prefix}_${stamp}`);
    }
    outDir = path.resolve(outDir);

    const opts = {
        huntId: parsed.huntId,
        strategyIds: parsed.strategyIds || undefined,
        classId: parsed.classId || undefined,
        seed: parsed.seed,
        iterations: parsed.iterations,
        frames: parsed.frames,
        maxTicks: parsed.maxTicks,
        rankBy: parsed.rankBy,
        lowerIsBetter:
            parsed.lowerIsBetter != null ? parsed.lowerIsBetter : undefined,
        sideSwap: parsed.sideSwap,
        outDir,
        writeFiles: true,
        quiet: parsed.quiet
    };

    const result = parsed.tune
        ? await runStrategyTune(opts)
        : await runStrategyEval(opts);

    console.log(
        stableStringify({
            kind: result.kind,
            tune: !!result.tune,
            huntId: result.huntId,
            seed: result.seed,
            partyMode: result.partyMode,
            classId: result.classId,
            rankBy: result.rankBy,
            sideSwap: result.sideSwap,
            ranking: result.rows.map((r) => ({
                rank: r.rank,
                strategyId: r.strategyId,
                routeCompleteRate: r.metrics.routeCompleteRate,
                meanKills: r.metrics.meanKills,
                meanDeaths: r.metrics.meanDeaths,
                meanExpPerHour: r.metrics.meanExpPerHour,
                meanTimeToClear: r.metrics.meanTimeToClear,
                meanDamageTaken: r.metrics.meanDamageTaken,
                partyWipeRate: r.metrics.partyWipeRate
            })),
            notes: result.notes,
            outDir: result.outDir,
            files: result.files
        })
    );
    return result;
}

module.exports = {
    parseArgs,
    main,
    printHelp
};

if (require.main === module) {
    main().catch((err) => {
        console.error('sim_eval_strategies FAILED:', err);
        process.exit(1);
    });
}
