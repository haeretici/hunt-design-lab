#!/usr/bin/env node
/**
 * Headless hunt CLI (Stage 6).
 *
 * Usage:
 *   npm run sim:hunt -- '{"seed":42,"huntId":"cave_crawl_generated"}'
 *   node bin/sim_hunt.js --seed 42 --hunt cave_crawl_generated
 *   node bin/sim_hunt.js --batch 5 --seed 1 --out var/sim
 *   node bin/sim_hunt.js --help
 *
 * JSON config (optional first non-flag arg) merges with flags.
 * Prints one summary JSON to stdout (batch prints aggregate + file list).
 */

'use strict';

const path = require('path');
const {
    runHeadlessHunt,
    runHeadlessHuntBatch,
    defaultSimOutDir,
    stableStringify
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode, DEFAULT_MODE_ID } = require('../kernel/core/lib/modes.js');

function printHelp() {
    console.log(`Headless hunt simulator (Stage 6 telemetry + batch).

Usage:
  node bin/sim_hunt.js [json-config] [options]
  npm run sim:hunt -- '{"seed":42,"huntId":"cave_crawl_generated"}'

Options:
  --seed <n>         RNG seed (default 1)
  --hunt <id>        Hunt preset id (presets/<mode>/hunts/<id>.json)
  --party <id>       Party preset id (presets/<mode>/parties/<id>.json)
  --mode <id>        Content mode pack (default: standard; env HDL_CONTENT_MODE)
  --floor <n>        Floor / path map id
  --frames <n>       Max logic frames (safety cap)
  --max-kills <n>    End session after N kills (kill_cap)
  --max-seconds <n>  End session after N sim seconds
  --batch <n>        Run N iterations (seeds seed..seed+n-1)
  --concurrency <n>  Parallel worker processes for batch (default 1)
  --out <dir>        Batch summary directory (default: var/sim)
  --no-write         Batch: do not write summary files
  --quiet            Suppress batch per-iter lines (default for single)
  --verbose          Print progress lines for batch
  -h, --help         Show help

Exit: summary JSON on stdout. Same seed ⇒ same summary core fields.
`);
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const out = {
        json: null,
        seed: undefined,
        huntId: undefined,
        partyId: undefined,
        mode: undefined,
        floor: undefined,
        frames: undefined,
        maxKills: undefined,
        maxSeconds: undefined,
        batch: null,
        concurrency: undefined,
        outDir: undefined,
        writeFiles: true,
        quiet: true,
        help: false
    };

    const args = argv.slice();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
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
        if (a === '--no-write') {
            out.writeFiles = false;
            continue;
        }
        if (a === '--seed' || a === '-s') {
            out.seed = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--hunt' || a === '--huntId') {
            out.huntId = args[++i];
            continue;
        }
        if (a === '--party' || a === '--partyId') {
            out.partyId = args[++i];
            continue;
        }
        if (a === '--mode') {
            out.mode = args[++i];
            continue;
        }
        if (a === '--floor') {
            out.floor = args[++i];
            continue;
        }
        if (a === '--frames') {
            out.frames = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--max-kills' || a === '--maxKills') {
            out.maxKills = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--max-seconds' || a === '--maxSeconds') {
            out.maxSeconds = parseFloat(args[++i]);
            continue;
        }
        if (a === '--batch' || a === '-n') {
            out.batch = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--concurrency' || a === '-c') {
            out.concurrency = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--out' || a === '--outDir') {
            out.outDir = args[++i];
            continue;
        }
        if (a.startsWith('-')) {
            throw new Error(`Unknown flag: ${a}`);
        }
        // Positional JSON blob
        if (!out.json) {
            try {
                out.json = JSON.parse(a);
            } catch (err) {
                throw new Error(`Invalid JSON config: ${err.message}`);
            }
        }
    }
    return out;
}

/**
 * @param {ReturnType<typeof parseArgs>} parsed
 * @returns {object}
 */
function buildInput(parsed) {
    const input = Object.assign({}, parsed.json || {});
    if (parsed.seed !== undefined && !Number.isNaN(parsed.seed)) {
        input.seed = parsed.seed;
    }
    if (parsed.huntId) input.huntId = parsed.huntId;
    if (parsed.partyId) input.partyId = parsed.partyId;
    if (parsed.floor !== undefined) input.floor = parsed.floor;
    if (parsed.frames !== undefined && !Number.isNaN(parsed.frames)) {
        input.frames = parsed.frames;
    }
    if (parsed.maxKills !== undefined && !Number.isNaN(parsed.maxKills)) {
        input.maxKills = parsed.maxKills;
    }
    if (parsed.maxSeconds !== undefined && !Number.isNaN(parsed.maxSeconds)) {
        input.maxSeconds = parsed.maxSeconds;
    }
    if (input.seed === undefined) input.seed = 1;
    if (!input.huntId && !input.hunt) input.huntId = 'cave_crawl_generated';
    return input;
}

async function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(err.message || err);
        process.exit(2);
    }

    if (parsed.help) {
        printHelp();
        return;
    }

    const modeId =
        parsed.mode ||
        (parsed.json && parsed.json.mode) ||
        process.env.HDL_CONTENT_MODE ||
        DEFAULT_MODE_ID;
    try {
        setActiveMode(modeId);
    } catch (err) {
        console.error(`Invalid content mode "${modeId}":`, err.message || err);
        process.exit(2);
    }

    const input = buildInput(parsed);

    if (parsed.batch != null && parsed.batch > 0) {
        const result = await runHeadlessHuntBatch({
            ...input,
            iterations: parsed.batch,
            concurrency:
                parsed.concurrency != null
                    ? parsed.concurrency
                    : input.concurrency,
            outDir: parsed.outDir
                ? path.resolve(parsed.outDir)
                : defaultSimOutDir(),
            writeFiles: parsed.writeFiles,
            quiet: parsed.quiet
        });
        const out = {
            iterations: result.iterations,
            concurrency: result.concurrency,
            workerProcessesUsed: result.workerProcessesUsed,
            outDir: result.outDir,
            files: result.files,
            aggregate: result.aggregate,
            /** First / last cores for quick checks */
            first: result.summaries[0]
                ? {
                      seed: result.summaries[0].seed,
                      sessionState: result.summaries[0].sessionState,
                      kills: result.summaries[0].kills,
                      expGained: result.summaries[0].expGained,
                      tickCount: result.summaries[0].tickCount
                  }
                : null
        };
        console.log(stableStringify(out));
        return;
    }

    const summary = await runHeadlessHunt(input);
    console.log(stableStringify(summary));
}

main().catch((err) => {
    console.error('sim_hunt FAILED:', err);
    process.exit(1);
});
