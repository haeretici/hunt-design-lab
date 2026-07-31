#!/usr/bin/env node
/**
 * Balance sweep + class viability CLI (Stage 8).
 *
 * Usage:
 *   npm run sim:sweep -- --knob creature_hp --values 0.5,1,2 --seed 1
 *   node bin/sim_sweep.js --knob spell_power --iterations 3 --out var/sim/sweeps/power
 *   node bin/sim_sweep.js --matrix --hunt cave_crawl_generated --out var/sim/sweeps/matrix
 *   node bin/sim_sweep.js --list
 *
 * Writes sweep.json + sweep.tsv (or class_matrix.*) under --out.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    listKnobs,
    runBalanceSweep,
    runClassViabilityMatrix,
    runCompositionSideSwap,
    sampleAnalysisDir
} = require('../kernel/core/lib/balance_sweep.js');
const {
    defaultSimOutDir,
    stableStringify
} = require('../kernel/providers/simulator/headless_runner.js');

function printHelp() {
    const knobs = listKnobs()
        .map((k) => `    ${k.id.padEnd(18)} ${k.label} (${k.unit}) defaults: ${k.defaultValues.join(',')}`)
        .join('\n');
    console.log(`Balance sweep / class matrix / side-swap (Stage 8).

Usage:
  node bin/sim_sweep.js [options]
  npm run sim:sweep -- --knob creature_hp --values 0.5,1,2
  npm run sim:sweep -- --matrix --side-swap --classes guardian,scout
  npm run sim:sweep -- --side-swap --class-a guardian --class-b scout

Options:
  --knob <id>          Knob to sweep (default: creature_hp)
  --values <list>      Comma-separated values (default: knob defaults)
  --hunt <id>          Hunt preset id (default: cave_crawl_generated)
  --seed <n>           Base seed (default 1)
  --iterations <n>     Hunts per knob value / class (default 1)
  --out <dir>          Output directory (JSON + TSV)
  --frames <n>         Max logic frames per hunt
  --matrix             Class viability matrix instead of knob sweep
  --side-swap          Composition side-swap (leader↔follower fairness)
  --class-a <id>       Primary class for --side-swap duo (default guardian)
  --class-b <id>       Partner class for --side-swap duo (default scout)
  --baseline <id>      Companion class when --matrix --side-swap (default adventurer)
  --classes <list>     Class ids for matrix (default: all)
  --list               List knobs and exit
  --quiet              Suppress per-value progress (default)
  --verbose            Log each value
  --sample             Write into presets/standard/analysis/ (documented sample)
  -h, --help

Knobs:
${knobs}

Exit: compact result JSON on stdout. Files: sweep.json + sweep.tsv under --out.
`);
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const out = {
        knob: 'creature_hp',
        values: null,
        huntId: 'cave_crawl_generated',
        seed: 1,
        iterations: 1,
        outDir: undefined,
        frames: undefined,
        matrix: false,
        sideSwap: false,
        classA: 'guardian',
        classB: 'scout',
        baseline: 'adventurer',
        classes: null,
        list: false,
        quiet: true,
        sample: false,
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
        if (a === '--matrix') {
            out.matrix = true;
            continue;
        }
        if (a === '--side-swap' || a === '--sideswap') {
            out.sideSwap = true;
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
        if (a === '--sample') {
            out.sample = true;
            continue;
        }
        if (a === '--knob') {
            out.knob = argv[++i];
            continue;
        }
        if (a === '--values') {
            out.values = argv[++i];
            continue;
        }
        if (a === '--hunt' || a === '--huntId') {
            out.huntId = argv[++i];
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
        if (a === '--out' || a === '--outDir') {
            out.outDir = argv[++i];
            continue;
        }
        if (a === '--frames') {
            out.frames = parseInt(argv[++i], 10);
            continue;
        }
        if (a === '--class-a' || a === '--classA') {
            out.classA = argv[++i];
            continue;
        }
        if (a === '--class-b' || a === '--classB') {
            out.classB = argv[++i];
            continue;
        }
        if (a === '--baseline') {
            out.baseline = argv[++i];
            continue;
        }
        if (a === '--classes') {
            out.classes = String(argv[++i])
                .split(/[\s,;]+/)
                .filter(Boolean);
            continue;
        }
        if (a.startsWith('-')) {
            throw new Error(`Unknown flag: ${a}`);
        }
    }
    return out;
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

    if (parsed.list) {
        console.log(stableStringify(listKnobs()));
        return;
    }

    let outDir = parsed.outDir;
    if (parsed.sample) {
        outDir = sampleAnalysisDir();
    } else if (!outDir) {
        const stamp = Date.now();
        let name;
        if (parsed.matrix) name = `class_matrix_${stamp}`;
        else if (parsed.sideSwap) name = `side_swap_${stamp}`;
        else name = `${parsed.knob}_${stamp}`;
        outDir = path.join(defaultSimOutDir(), 'sweeps', name);
    }
    outDir = path.resolve(outDir);

    // Pure duo side-swap (not full class matrix)
    if (parsed.sideSwap && !parsed.matrix) {
        const result = await runCompositionSideSwap({
            huntId: parsed.huntId,
            seed: parsed.seed,
            iterations: parsed.iterations,
            classA: parsed.classA,
            classB: parsed.classB,
            frames: parsed.frames,
            outDir,
            writeFiles: true,
            quiet: parsed.quiet
        });
        console.log(
            stableStringify({
                kind: result.kind,
                classA: result.classA,
                classB: result.classB,
                averaged: {
                    routeCompleteRate: result.averagedMetrics.routeCompleteRate,
                    meanKills: result.averagedMetrics.meanKills,
                    meanExpPerHour: result.averagedMetrics.meanExpPerHour
                },
                forward: result.forward.metrics,
                swap: result.swap.metrics,
                outDir: result.outDir,
                files: result.files
            })
        );
        return;
    }

    if (parsed.matrix) {
        const result = await runClassViabilityMatrix({
            huntId: parsed.huntId,
            seed: parsed.seed,
            iterations: parsed.iterations,
            classIds: parsed.classes || undefined,
            frames: parsed.frames,
            sideSwap: parsed.sideSwap,
            baselineClassId: parsed.baseline,
            outDir,
            writeFiles: true,
            quiet: parsed.quiet
        });
        if (parsed.sample && result.files) {
            renameSampleOutputs(result, 'sample_class_matrix');
        }
        console.log(
            stableStringify({
                kind: result.kind,
                huntId: result.huntId,
                seed: result.seed,
                sideSwap: result.sideSwap,
                rows: result.rows.map((r) => ({
                    classId: r.classId,
                    routeCompleteRate: r.metrics.routeCompleteRate,
                    meanKills: r.metrics.meanKills,
                    meanExpPerHour: r.metrics.meanExpPerHour
                })),
                outDir: result.outDir,
                files: result.files
            })
        );
        return;
    }

    const result = await runBalanceSweep({
        knob: parsed.knob,
        values: parsed.values,
        huntId: parsed.huntId,
        seed: parsed.seed,
        iterations: parsed.iterations,
        frames: parsed.frames,
        outDir,
        writeFiles: true,
        quiet: parsed.quiet
    });

    if (parsed.sample && result.files) {
        const base =
            result.knob === 'creature_hp'
                ? 'sample_creature_hp_sweep'
                : `sample_${result.knob}_sweep`;
        renameSampleOutputs(result, base);
    }

    console.log(
        stableStringify({
            kind: result.kind,
            knob: result.knob,
            huntId: result.huntId,
            seed: result.seed,
            values: result.values,
            rows: result.rows.map((r) => ({
                value: r.value,
                routeCompleteRate: r.metrics.routeCompleteRate,
                meanKills: r.metrics.meanKills,
                meanExpPerHour: r.metrics.meanExpPerHour,
                partyWipeRate: r.metrics.partyWipeRate
            })),
            outDir: result.outDir,
            files: result.files
        })
    );
}

/**
 * Rename sweep.json/tsv to stable sample_* names under presets/standard/analysis/.
 * @param {object} result
 * @param {string} base without extension
 */
function renameSampleOutputs(result, base) {
    if (!result.files || !result.outDir) return;
    const dir = result.outDir;
    const jsonSrc = result.files.json;
    const tsvSrc = result.files.tsv;
    const jsonDst = path.join(dir, `${base}.json`);
    const tsvDst = path.join(dir, `${base}.tsv`);
    if (jsonSrc && fs.existsSync(jsonSrc) && jsonSrc !== jsonDst) {
        fs.renameSync(jsonSrc, jsonDst);
        result.files.json = jsonDst;
    }
    if (tsvSrc && fs.existsSync(tsvSrc) && tsvSrc !== tsvDst) {
        fs.renameSync(tsvSrc, tsvDst);
        result.files.tsv = tsvDst;
    }
}

main().catch((err) => {
    console.error('sim_sweep FAILED:', err);
    process.exit(1);
});
