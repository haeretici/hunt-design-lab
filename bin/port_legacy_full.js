#!/usr/bin/env node
/**
 * Rebuild standard packs from existing presets/legacy (no source tree).
 * Requires presets/legacy (git branch `legacy` if not on disk):
 *   1. map_standard_spells.js    (legacy spells + other/content_maps/spell_map.csv → standard)
 *   2. map_standard_vocations.js (legacy classes + other/content_maps/vocation_map.csv → standard)
 *   3. map_standard_equipment.js (legacy equipment + other/content_maps/equipment_map.csv → standard)
 *   4. port_creatures_standard.js(legacy creatures + other/content_maps/legacy_to_standard_names.csv → standard)
 *
 *   node bin/port_legacy_full.js
 *   node bin/port_legacy_full.js --dry-run
 *   node bin/port_legacy_full.js --only spells,vocations
 *
 * Extra flags after `--` are forwarded to each child (limited support).
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

const STEPS = [
    {
        id: 'spells',
        label: 'standard spells map',
        script: 'bin/map_standard_spells.js',
        group: 'map'
    },
    {
        id: 'vocations',
        label: 'standard vocations/classes map',
        script: 'bin/map_standard_vocations.js',
        group: 'map'
    },
    {
        id: 'equipment',
        label: 'standard equipment map',
        script: 'bin/map_standard_equipment.js',
        group: 'map'
    },
    {
        id: 'monsters',
        label: 'standard creatures port',
        script: 'bin/port_creatures_standard.js',
        group: 'map'
    }
];

function parseArgs(argv) {
    const opts = {
        dryRun: false,
        only: null,
        skip: new Set(),
        quiet: false,
        childArgs: []
    };
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === '--') {
            opts.childArgs = argv.slice(i + 1);
            break;
        }
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--skip-port') {
            // Legacy flag: port from legacy/source was removed; no-op for CI/docs.
        } else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--only' && argv[i + 1]) {
            opts.only = new Set(
                String(argv[++i])
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
            );
        } else if (a.startsWith('--only=')) {
            opts.only = new Set(
                a
                    .slice('--only='.length)
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean)
            );
        } else if (a === '--skip' && argv[i + 1]) {
            String(argv[++i])
                .split(',')
                .forEach((s) => opts.skip.add(s.trim()));
        } else if (a.startsWith('--skip=')) {
            a.slice('--skip='.length)
                .split(',')
                .forEach((s) => opts.skip.add(s.trim()));
        } else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/port_legacy_full.js [options]

Rebuild standard packs from existing presets/legacy (maps/spells/vocations/equipment/monsters).

Options:
  --dry-run           Forward --dry-run to every step (report only)
  --only a,b          Run only these steps: spells,vocations,equipment,monsters
  --skip a,b          Skip these steps
  --quiet             Less logging from this orchestrator
  --help

Examples:
  npm run port:legacy:full
  npm run port:legacy:full -- --only spells,vocations
  npm run port:legacy:full -- --dry-run`);
            process.exit(0);
        } else {
            console.error(`Unknown option: ${a} (use --help)`);
            process.exit(1);
        }
        i++;
    }
    return opts;
}

function shouldRun(step, opts) {
    if (opts.skip.has(step.id)) return false;
    if (opts.only && !opts.only.has(step.id)) return false;
    return true;
}

function runStep(step, opts) {
    const scriptPath = path.join(ROOT, step.script);
    const args = [scriptPath];
    if (opts.dryRun) args.push('--dry-run');
    if (!opts.quiet) {
        console.log(`\n==> ${step.label}`);
        console.log(`    node ${step.script}${opts.dryRun ? ' --dry-run' : ''}`);
    }
    const res = spawnSync(NODE, args, {
        cwd: ROOT,
        stdio: 'inherit',
        env: process.env
    });
    if (res.error) {
        console.error(res.error);
        return 1;
    }
    return res.status == null ? 1 : res.status;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const planned = STEPS.filter((s) => shouldRun(s, opts));

    if (!opts.quiet) {
        console.log('port_legacy_full');
        console.log(`  steps: ${planned.map((s) => s.id).join(' → ') || '(none)'}`);
        if (opts.dryRun) console.log('  mode:  dry-run (no writes)');
    }

    if (!planned.length) {
        console.error('No steps selected.');
        process.exit(1);
    }

    for (let i = 0; i < planned.length; i++) {
        const code = runStep(planned[i], opts);
        if (code !== 0) {
            console.error(`\nFAILED at step "${planned[i].id}" (exit ${code})`);
            process.exit(code || 1);
        }
    }

    if (!opts.quiet) {
        console.log('\nport_legacy_full: done');
    }
}

main();
