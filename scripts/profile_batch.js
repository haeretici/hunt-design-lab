#!/usr/bin/env node
/**
 * Sequential short-hunt performance report (Stage 12A).
 *
 * Default: 10 sequential hunts, no summary files, concurrency forced to 1
 * so wall-clock UPS is honest (not parallel-inflated).
 *
 * Usage:
 *   npm run sim:profile
 *   node scripts/profile_batch.js
 *   node scripts/profile_batch.js '{"iterations":5,"seed":1,"frames":2000}'
 *   node scripts/profile_batch.js --iterations 5 --frames 2000
 *
 * Does not write huge summary trees unless writeFiles is set true.
 */

'use strict';

const {
    runBatchSlice,
    DEFAULT_HUNT_MAX_FRAMES
} = require('../kernel/providers/simulator/headless_runner.js');

const DEFAULT = {
    iterations: 10,
    seed: 42,
    huntId: 'cave_crawl_generated',
    headless: true,
    concurrency: 1,
    writeFiles: false,
    quiet: true,
    frames: DEFAULT_HUNT_MAX_FRAMES
};

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const out = {
        json: null,
        iterations: undefined,
        seed: undefined,
        huntId: undefined,
        frames: undefined,
        maxTicks: undefined,
        maxSeconds: undefined,
        writeFiles: undefined,
        help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
            continue;
        }
        if (a === '--iterations' || a === '-n') {
            out.iterations = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--seed' || a === '-s') {
            out.seed = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--hunt' || a === '--huntId') {
            out.huntId = argv[++i];
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
        if (a === '--max-seconds' || a === '--maxSeconds') {
            out.maxSeconds = parseFloat(argv[++i]);
            continue;
        }
        if (a === '--write-files') {
            out.writeFiles = true;
            continue;
        }
        if (a.startsWith('-')) {
            throw new Error(`Unknown flag: ${a}`);
        }
        if (!out.json) {
            out.json = JSON.parse(a);
        }
    }
    return out;
}

/**
 * Build timing report from sequential batch wall clock + summaries.
 *
 * @param {{
 *   elapsedMs: number,
 *   summaries: object[],
 *   config?: object
 * }} opts
 * @returns {object}
 */
function buildProfileReport(opts) {
    const elapsedMs = Math.max(0, Number(opts.elapsedMs) || 0);
    const summaries = Array.isArray(opts.summaries) ? opts.summaries : [];
    const config = opts.config || {};
    const iterations = summaries.length;
    let totalTicks = 0;
    for (let i = 0; i < iterations; i++) {
        totalTicks += summaries[i].tickCount || 0;
    }
    const avgTicksPerHunt = iterations ? totalTicks / iterations : 0;
    const seconds = elapsedMs / 1000;
    return {
        elapsedMs,
        iterations,
        huntId: config.huntId || config.hunt || null,
        seed: config.seed != null ? config.seed : null,
        frames: config.frames != null ? config.frames : null,
        totalTicks,
        avgTicksPerHunt,
        effectiveUps: seconds > 0 ? totalTicks / seconds : 0,
        msPerHunt: iterations ? elapsedMs / iterations : 0
    };
}

/**
 * Run sequential short hunts and return a profile report.
 * Always concurrency 1; writeFiles default false.
 *
 * @param {object} [input]
 * @returns {Promise<object>}
 */
async function runProfileBatch(input) {
    const raw = Object.assign({}, DEFAULT, input || {});
    // Force sequential for honest wall-clock UPS.
    raw.concurrency = 1;
    if (raw.writeFiles !== true) {
        raw.writeFiles = false;
    }
    if (raw.quiet !== false) {
        raw.quiet = true;
    }
    if (!raw.huntId && !raw.hunt) {
        raw.huntId = DEFAULT.huntId;
    }
    if (raw.iterations == null || raw.iterations < 1) {
        raw.iterations = DEFAULT.iterations;
    }

    const sliceConfig = Object.assign({}, raw);
    delete sliceConfig.iterations;
    delete sliceConfig.writeFiles;
    delete sliceConfig.quiet;
    delete sliceConfig.onIteration;
    delete sliceConfig.concurrency;
    delete sliceConfig.outDir;
    delete sliceConfig.seeds;

    const started = Date.now();
    const summaries = await runBatchSlice(
        sliceConfig,
        0,
        raw.iterations
    );
    const elapsedMs = Date.now() - started;

    return buildProfileReport({
        elapsedMs,
        summaries,
        config: raw
    });
}

function printHelp() {
    console.log(`Headless hunt profile (Stage 12A).

Usage:
  npm run sim:profile
  node scripts/profile_batch.js [json-config] [options]

Options:
  --iterations <n>   Hunts to run (default 10)
  --seed <n>         Base seed (default 42)
  --hunt <id>        Hunt preset (default cave_crawl_generated)
  --frames <n>       Max logic frames per hunt
  --max-ticks <n>    Session maxTicks override
  --max-seconds <n>  Session maxSeconds override
  --write-files      Write per-hunt summaries (default: no)
  -h, --help

Prints JSON: elapsedMs, msPerHunt, effectiveUps, avgTicksPerHunt, …
Does not write summary trees unless --write-files is set.
`);
}

async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
        printHelp();
        return;
    }

    const input = Object.assign({}, parsed.json || {});
    if (parsed.iterations != null) input.iterations = parsed.iterations;
    if (parsed.seed != null) input.seed = parsed.seed;
    if (parsed.huntId) input.huntId = parsed.huntId;
    if (parsed.frames != null) input.frames = parsed.frames;
    if (parsed.maxTicks != null) input.maxTicks = parsed.maxTicks;
    if (parsed.maxSeconds != null) input.maxSeconds = parsed.maxSeconds;
    if (parsed.writeFiles != null) input.writeFiles = parsed.writeFiles;

    const report = await runProfileBatch(input);
    console.log(JSON.stringify(report, null, 2));
}

module.exports = {
    DEFAULT,
    buildProfileReport,
    runProfileBatch,
    parseArgs
};

if (require.main === module) {
    main().catch((err) => {
        console.error('profile_batch FAILED:', err);
        process.exit(1);
    });
}
