#!/usr/bin/env node
/**
 * Headless dungeon generator stress tester (Stage 11.6).
 *
 * Usage:
 *   npm run dungeon:test -- --profile small_crawl --iterations 1000
 *   node bin/dungeon_test.js --profile outskirts_camp --iterations 500 --mode standard
 *   node bin/dungeon_test.js --profile small_crawl --iterations 10000 --out var/dungeon_test/report.json
 *   node bin/dungeon_test.js --help
 *
 * Exit code 0 when failure rate ≤ --threshold (default 0). Prints JSON report.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    runDungeonTests,
    DEFAULT_STRESS_ITERATIONS,
    DEFAULT_CI_ITERATIONS
} = require('../kernel/core/lib/dungeon/tester.js');
const {
    loadDungeonProfile,
    loadPiecePack,
    loadPopulation,
    loadMarkerRules,
    listDungeonProfileIds
} = require('../kernel/core/lib/presets.js');
const {
    setActiveMode,
    getActiveModeId,
    DEFAULT_MODE_ID
} = require('../kernel/core/lib/modes.js');

function printHelp() {
    console.log(`Dungeon generator stress tester (Stage 11.6).

Usage:
  node bin/dungeon_test.js [options]
  npm run dungeon:test -- --profile small_crawl --iterations 1000

Options:
  --profile <id>       Dungeon profile id (presets/<mode>/dungeons/<id>.json)
  --mode <id>          Content mode (default: standard; env HDL_CONTENT_MODE)
  --iterations <n>     Generation count (default: ${DEFAULT_STRESS_ITERATIONS}; CI often 100–1000)
  --seed <n>           First seed (seeds seed..seed+n-1; default 1)
  --threshold <f>      Max failure rate before non-zero exit (default 0)
  --max-fail-samples <n>  Failures kept in JSON errorLog (default 50)
  --no-population      Skip population capacity/limit checks
  --no-pacing          Skip pacing feasibility heuristic
  --out <path>         Write full JSON report to file
  --quiet              Suppress progress (report still on stdout unless --out-only)
  --out-only           Write report to --out only (no stdout dump)
  --list               List dungeon profile ids for active mode
  --ci                 Shortcut: iterations=${DEFAULT_CI_ITERATIONS}, quiet progress
  -h, --help           Show help

Exit: 0 if Successful (failureRate ≤ threshold), else 1.
Report fields: Successful, passed, failed, failureRate, errorLog, errorCodes, stats.
`);
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const out = {
        profileId: null,
        mode: undefined,
        iterations: DEFAULT_STRESS_ITERATIONS,
        seedStart: 1,
        failRateThreshold: 0,
        maxFailSamples: 50,
        checkPopulation: true,
        checkPacing: true,
        outPath: null,
        quiet: false,
        outOnly: false,
        list: false,
        help: false
    };

    const args = argv.slice();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
            continue;
        }
        if (a === '--list') {
            out.list = true;
            continue;
        }
        if (a === '--ci') {
            out.iterations = DEFAULT_CI_ITERATIONS;
            out.quiet = true;
            continue;
        }
        if (a === '--quiet') {
            out.quiet = true;
            continue;
        }
        if (a === '--out-only') {
            out.outOnly = true;
            continue;
        }
        if (a === '--no-population') {
            out.checkPopulation = false;
            continue;
        }
        if (a === '--no-pacing') {
            out.checkPacing = false;
            continue;
        }
        if (a === '--profile' || a === '--profileId') {
            out.profileId = args[++i];
            continue;
        }
        if (a === '--mode') {
            out.mode = args[++i];
            continue;
        }
        if (a === '--iterations' || a === '--iters' || a === '-n') {
            out.iterations = Math.max(1, parseInt(args[++i], 10) || 1);
            continue;
        }
        if (a === '--seed' || a === '--seedStart') {
            out.seedStart = parseInt(args[++i], 10) || 1;
            continue;
        }
        if (a === '--threshold' || a === '--fail-rate') {
            out.failRateThreshold = Number(args[++i]);
            if (!Number.isFinite(out.failRateThreshold)) out.failRateThreshold = 0;
            continue;
        }
        if (a === '--max-fail-samples') {
            out.maxFailSamples = Math.max(0, parseInt(args[++i], 10) || 0);
            continue;
        }
        if (a === '--out' || a === '--report') {
            out.outPath = args[++i];
            continue;
        }
        // bare profile id as first positional
        if (!a.startsWith('-') && !out.profileId) {
            out.profileId = a;
            continue;
        }
    }
    return out;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        process.exit(0);
    }

    const mode =
        args.mode ||
        process.env.HDL_CONTENT_MODE ||
        DEFAULT_MODE_ID ||
        'standard';
    setActiveMode(mode);

    if (args.list) {
        const ids = listDungeonProfileIds();
        console.log(
            JSON.stringify(
                { mode: getActiveModeId(), profiles: ids },
                null,
                2
            )
        );
        process.exit(0);
    }

    if (!args.profileId) {
        console.error('Error: --profile <id> required (or --list / --help)');
        process.exit(2);
    }

    const onProgress =
        args.quiet
            ? null
            : (info) => {
                  process.stderr.write(
                      `\r[dungeon:test] ${info.done}/${info.iterations} passed=${info.passed} failed=${info.failed}`
                  );
                  if (info.done === info.iterations) process.stderr.write('\n');
              };

    const report = runDungeonTests({
        profileId: args.profileId,
        iterations: args.iterations,
        seedStart: args.seedStart,
        failRateThreshold: args.failRateThreshold,
        maxFailSamples: args.maxFailSamples,
        checkPopulation: args.checkPopulation,
        checkPacing: args.checkPacing,
        loadDungeonProfile,
        loadPiecePack,
        loadPopulation,
        loadMarkers: loadMarkerRules,
        onProgress: onProgress || undefined,
        progressEvery: args.quiet
            ? 0
            : Math.max(1, Math.floor(args.iterations / 20))
    });

    report.mode = getActiveModeId();

    if (args.outPath) {
        const abs = path.isAbsolute(args.outPath)
            ? args.outPath
            : path.join(process.cwd(), args.outPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, JSON.stringify(report, null, 2), 'utf8');
        if (!args.outOnly) {
            process.stderr.write(`Wrote report: ${abs}\n`);
        }
    }

    if (!args.outOnly) {
        // Compact stdout for large error logs
        const printable = Object.assign({}, report);
        if (printable.errorLog && printable.errorLog.length > 20) {
            printable.errorLog = printable.errorLog.slice(0, 20);
            printable.errorLogTruncated = true;
        }
        console.log(JSON.stringify(printable, null, 2));
    } else if (args.outPath) {
        console.log(
            JSON.stringify({
                Successful: report.Successful,
                successful: report.successful,
                passed: report.passed,
                failed: report.failed,
                failureRate: report.failureRate,
                out: args.outPath
            })
        );
    }

    process.exit(report.successful ? 0 : 1);
}

main();
