#!/usr/bin/env node
/**
 * Hunt batch worker (Stage 6).
 *
 * Two modes:
 * 1) IPC (forked by headless_runner when concurrency > 1):
 *      node scripts/batch_worker.js --ipc
 *      parent sends { config, startIndex, count, seeds } → replies { summaries }
 * 2) CLI sequential wrapper:
 *      node scripts/batch_worker.js '{"iterations":10,"seed":1,"concurrency":4}'
 *      node scripts/batch_worker.js --iterations 10 --seed 1 --concurrency 4 --out var/sim
 */

'use strict';

const path = require('path');
const {
    runHeadlessHuntBatch,
    runBatchSlice,
    defaultSimOutDir,
    stableStringify
} = require('../kernel/providers/simulator/headless_runner.js');

function printHelp() {
    console.log(`Hunt batch worker.

Usage:
  node scripts/batch_worker.js [json-config] [options]
  node scripts/batch_worker.js --ipc   # forked worker (parent IPC)

Options:
  --iterations <n>   Number of hunts (default 1)
  --seed <n>         Base seed (iteration i uses seed+i)
  --hunt <id>        Hunt preset id
  --out <dir>        Output directory (default var/sim)
  --frames <n>       Max frames per hunt
  --concurrency <n>  Parallel worker processes (default 1)
  --quiet            No per-iteration stdout
  --verbose          Log each iteration
  -h, --help

See also: bin/sim_hunt.js --batch
`);
}

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
        outDir: undefined,
        frames: undefined,
        concurrency: undefined,
        quiet: false,
        help: false,
        ipc: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
            continue;
        }
        if (a === '--ipc') {
            out.ipc = true;
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
        if (a === '--out') {
            out.outDir = argv[++i];
            continue;
        }
        if (a === '--frames') {
            out.frames = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--concurrency' || a === '-c') {
            out.concurrency = parseInt(argv[++i], 10);
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
 * IPC worker loop (soccer-oss style).
 */
function runIpcWorker() {
    process.on('message', async (msg) => {
        try {
            const config = (msg && msg.config) || {};
            const startIndex = (msg && msg.startIndex) || 0;
            const count = (msg && msg.count) || 0;
            const seeds = msg && msg.seeds;
            const summaries = await runBatchSlice(
                config,
                startIndex,
                count,
                seeds
            );
            if (typeof process.send === 'function') {
                process.send({ summaries });
            }
            process.exit(0);
        } catch (err) {
            if (typeof process.send === 'function') {
                process.send({
                    error: String(err && err.stack ? err.stack : err)
                });
            }
            process.exit(1);
        }
    });
}

async function mainCli(parsed) {
    if (parsed.help) {
        printHelp();
        return;
    }

    const input = Object.assign({}, parsed.json || {});
    if (parsed.iterations != null) input.iterations = parsed.iterations;
    if (parsed.seed != null) input.seed = parsed.seed;
    if (parsed.huntId) input.huntId = parsed.huntId;
    if (parsed.frames != null) input.frames = parsed.frames;
    if (parsed.concurrency != null) input.concurrency = parsed.concurrency;
    if (input.iterations == null) input.iterations = 1;
    if (input.seed == null) input.seed = 1;
    if (!input.huntId && !input.hunt) input.huntId = 'cave_crawl_generated';

    const outDir = path.resolve(
        parsed.outDir || input.outDir || defaultSimOutDir()
    );

    const result = await runHeadlessHuntBatch({
        ...input,
        outDir,
        writeFiles: true,
        quiet: parsed.quiet
    });

    console.log(
        stableStringify({
            iterations: result.iterations,
            outDir: result.outDir,
            files: result.files,
            aggregate: result.aggregate,
            workerProcessesUsed: result.workerProcessesUsed,
            concurrency: result.concurrency
        })
    );
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.ipc) {
    runIpcWorker();
} else {
    mainCli(parsed).catch((err) => {
        console.error('batch_worker FAILED:', err);
        process.exit(1);
    });
}
