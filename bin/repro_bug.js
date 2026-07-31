#!/usr/bin/env node
/**
 * Reproduce a browser bug report under bugs/*.json headlessly.
 *
 * Usage:
 *   npm run bug:repro -- bugs/bug_….json
 *   node bin/repro_bug.js bugs/bug_….json
 *   node bin/repro_bug.js --to-tick 200 bugs/bug_….json
 *   node bin/repro_bug.js --to-tick 560 --parity-text bugs/bug_….json
 *   node bin/repro_bug.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    bugReportToRunnerInput
} = require('../kernel/apps/game/bug_report.js');
const {
    formatParityTickLog
} = require('../kernel/apps/game/live_panel.js');
const {
    runHeadlessHunt,
    runHeadlessHuntToTick
} = require('../kernel/providers/simulator/headless_runner.js');
const {
    runScenarioHunt
} = require('../kernel/core/lib/hunt_scenarios.js');
const { setActiveMode, DEFAULT_MODE_ID } = require('../kernel/core/lib/modes.js');
const { stableStringify } = require('../kernel/core/lib/telemetry.js');
const { ROOT } = require('../kernel/settings.js');

function printHelp() {
    console.log(`Reproduce a Hunt / Scenario Lab bug report (bugs/*.json).

Usage:
  node bin/repro_bug.js <path-to-bug.json> [options]
  npm run bug:repro -- bugs/bug_….json

Options:
  --to-tick <n>     Stop at logic tick n (hunt only; uses runHeadlessHuntToTick)
  --parity-text     Print Scout/RNG post-hop parity lines to stderr (docs/25)
  --parity-from <n> Fixed parity window start tick (with --parity-to)
  --parity-to <n>   Fixed parity window end tick
  --mode <id>       Override content mode from the report
  --quiet           Print summary JSON only (default)
  --verbose         Log seed / mode / runner kind before the summary
  -h, --help        Show help

The report must include seed + party members (or partyId) and either huntId
or scenarioId (source: "hunt" | "scenario").
`);
}

/**
 * @param {string[]} argv
 * @returns {{ file: string|null, toTick: number|null, mode: string|null, verbose: boolean, help: boolean, parityText: boolean, parityFrom: number|null, parityTo: number|null }}
 */
function parseArgs(argv) {
    const out = {
        file: null,
        toTick: null,
        mode: null,
        verbose: false,
        help: false,
        parityText: false,
        parityFrom: null,
        parityTo: null
    };
    const args = argv.slice();
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-h' || a === '--help') {
            out.help = true;
            continue;
        }
        if (a === '--verbose') {
            out.verbose = true;
            continue;
        }
        if (a === '--quiet') {
            out.verbose = false;
            continue;
        }
        if (a === '--parity-text' || a === '--parityText') {
            out.parityText = true;
            continue;
        }
        if (a === '--parity-from' || a === '--parityFrom') {
            out.parityFrom = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--parity-to' || a === '--parityTo') {
            out.parityTo = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--to-tick' || a === '--toTick') {
            out.toTick = parseInt(args[++i], 10);
            continue;
        }
        if (a === '--mode') {
            out.mode = args[++i];
            continue;
        }
        if (a.startsWith('-')) {
            throw new Error(`Unknown flag: ${a}`);
        }
        if (!out.file) out.file = a;
    }
    return out;
}

/**
 * @param {string} filePath
 * @returns {object}
 */
function loadReport(filePath) {
    const abs = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(abs)) {
        // Also try under project ROOT
        const alt = path.join(ROOT, filePath);
        if (fs.existsSync(alt)) {
            return JSON.parse(fs.readFileSync(alt, 'utf8'));
        }
        throw new Error(`Bug report not found: ${filePath}`);
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const doc = JSON.parse(raw);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('Bug report must be a JSON object');
    }
    return doc;
}

async function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(err.message || err);
        process.exit(2);
    }

    if (parsed.help || !parsed.file) {
        printHelp();
        process.exit(parsed.help ? 0 : 2);
    }

    const report = loadReport(parsed.file);
    const { kind, modeId, input } = bugReportToRunnerInput(report);
    const mode = parsed.mode || modeId || DEFAULT_MODE_ID;

    try {
        setActiveMode(mode);
    } catch (err) {
        console.error(`Invalid content mode "${mode}":`, err.message || err);
        process.exit(2);
    }

    if (parsed.verbose) {
        console.error(
            `[repro] kind=${kind} mode=${mode} seed=${input.seed}` +
                (input.huntId ? ` hunt=${input.huntId}` : '') +
                (input.scenarioId ? ` scenario=${input.scenarioId}` : '') +
                (input.partyId ? ` party=${input.partyId}` : '') +
                (Array.isArray(input.members)
                    ? ` members=${input.members.length}`
                    : '')
        );
        if (report.description) {
            console.error(`[repro] description: ${String(report.description).slice(0, 200)}`);
        }
    }

    let summary;
    if (kind === 'scenario') {
        const scenarioId = input.scenarioId || 'choke_pack';
        /** @type {object} */
        const overrides = {
            seed: input.seed
        };
        if (input.partyId) overrides.partyId = input.partyId;
        if (Array.isArray(input.members) && input.members.length) {
            overrides.members = input.members;
        }
        // scenarioSettings applied via applyScenario when on the fixture;
        // pass as override only if the report captured knobs.
        if (input.scenarioSettings && typeof input.scenarioSettings === 'object') {
            // runScenarioHunt → applyScenario merges overrides; Settings patch
            // comes from scenario.settings + scenarioSettings on merged opts.
            overrides.scenarioSettings = input.scenarioSettings;
        }
        if (parsed.toTick != null && Number.isFinite(parsed.toTick)) {
            console.error(
                'Warning: --to-tick is only supported for hunt reports; ignoring for scenario.'
            );
        }
        summary = await runScenarioHunt(scenarioId, overrides);
    } else {
        const huntInput = {
            seed: input.seed,
            huntId: input.huntId || 'cave_crawl_generated'
        };
        if (input.partyId) huntInput.partyId = input.partyId;
        if (Array.isArray(input.members) && input.members.length) {
            huntInput.members = input.members;
        }
        if (
            parsed.parityFrom != null &&
            Number.isFinite(parsed.parityFrom) &&
            parsed.parityTo != null &&
            Number.isFinite(parsed.parityTo)
        ) {
            huntInput.parityTrace = {
                fromTick: Math.floor(parsed.parityFrom),
                toTick: Math.floor(parsed.parityTo)
            };
        } else {
            // Default: auto window after first stair hop (Scout split-floor).
            huntInput.parityTrace = true;
        }
        if (parsed.toTick != null && Number.isFinite(parsed.toTick) && parsed.toTick >= 0) {
            summary = await runHeadlessHuntToTick({
                ...huntInput,
                toTick: Math.floor(parsed.toTick)
            });
        } else {
            summary = await runHeadlessHunt(huntInput);
        }
    }

    if (parsed.parityText && summary && Array.isArray(summary.parityTickLog)) {
        const text = formatParityTickLog(summary.parityTickLog, {
            focusName: 'Scout',
            maxLines: 80
        });
        console.error('[parity]\n' + text);
        if (summary.parityWindow) {
            console.error(
                `[parity] window ${summary.parityWindow.from}–${summary.parityWindow.to} (${summary.parityWindow.mode})`
            );
        }
    }

    console.log(stableStringify(summary));
}

main().catch((err) => {
    console.error('repro_bug FAILED:', err);
    process.exit(1);
});
