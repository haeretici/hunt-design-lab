#!/usr/bin/env node
/**
 * Generate asset spritesheet(s) via Google Antigravity (agy) or Grok Build (grok),
 * split tiles with ImageMagick, run process_sprites.py, refresh catalog JSON.
 *
 * Built on kernel batch_builder (genre + asset-kind paths, prompts, done list).
 *
 * Usage:
 *   node bin/generate_sprite.js
 *   node bin/generate_sprite.js --genre steampunk
 *   node bin/generate_sprite.js -g rpg_fantasy --kind equipment --category sword
 *   node bin/generate_sprite.js -g rpg_fantasy --kind tiles --seed 7 --dry-run
 *   node bin/generate_sprite.js -g steampunk --seed 42 --iterations 3
 *   node bin/generate_sprite.js --model 'Grok 4.5 (High)'
 *   node bin/generate_sprite.js --config batch.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    DEFAULT_GENRE,
    DEFAULT_KIND,
    ROOT,
    listKindIds
} = require('../kernel/settings.js');
const {
    buildBatch,
    formatBatchSummary,
    batchToConfigJson,
    appendDoneFile,
    cleanFileStem,
    listGenreIds,
    DEFAULT_MODEL
} = require('../kernel/core/lib/batch_builder.js');
const {
    inventoryGenre,
    saveCatalog,
    upsertCreature
} = require('../kernel/core/lib/creature_manifest.js');

function printHelp() {
    console.log(`Generate an asset spritesheet batch (image gen + split + process + inventory).

Usage:
  node bin/generate_sprite.js [options]

Options:
  -g, --genre <id>       ${listGenreIds().join(' | ')}
                         (default: ${DEFAULT_GENRE})
  -k, --kind <id>        ${listKindIds().join(' | ')}
                         (default: ${DEFAULT_KIND})
  --category <id>        Optional subcategory (equipment: sword|axe|…;
                         tiles: floor|wall|…; objects: tree|house|…)
  --seed <n>             Reproducible name batch
  --model <name>         Image model label (default: ${DEFAULT_MODEL})
                         Gemini * → agy; Grok 4.5 (Low|Medium|High) → grok
  --done-file <path>     Override done list path
  --rows <n>             Grid rows (default: 4)
  --cols <n>             Grid cols (default: 4)
  --iterations <n>       Number of sheets to generate (default: 1).
                         Each iteration rebuilds the roster from seed + current
                         done list, then appends names so the next sheet is unique.
  --config <path>        Load JSON config from file (use - for stdin; advanced)
  --config-json <json>   Load JSON config from a string (frozen roster; advanced)
  --dry-run              Build batch + print prompt; do not call image gen or write files
  --print-config         Print first-iteration batch JSON to stdout and exit
  --skip-agy             Skip image gen (agy/grok); use existing spritesheet if present
  --skip-split           Skip ImageMagick crop/rename
  --skip-process         Skip process_sprites.py
  --skip-inventory       Skip refreshing assets/data/<genre>/<kind>.json
  --opaque-alpha         process_sprites: opaque alpha copy (no chroma key);
                         stamps opaqueAlpha=true on all catalog rows in this batch
  --no-record            Do not append names to done file
  -h, --help             Show help

One-shot (copy from Batch Builder CLI box):
  node bin/generate_sprite.js -g steampunk --seed 42 --iterations 2 --model 'Gemini 3.6 Flash (High)'
  node bin/generate_sprite.js -g rpg_fantasy --kind equipment --category sword --seed 1
  node bin/generate_sprite.js -g rpg_fantasy --kind objects --seed 3 --model 'Grok 4.5 (High)'
`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        genre: DEFAULT_GENRE,
        kind: DEFAULT_KIND,
        category: null,
        seed: null,
        model: null,
        doneFile: null,
        rows: 4,
        cols: 4,
        iterations: 1,
        config: null,
        configJson: null,
        dryRun: false,
        printConfig: false,
        skipAgy: false,
        skipSplit: false,
        skipProcess: false,
        skipInventory: false,
        opaqueAlpha: false,
        record: true,
        help: false
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`Missing value after ${a}`);
            return v;
        };
        switch (a) {
            case '-h':
            case '--help':
                opts.help = true;
                break;
            case '-g':
            case '--genre':
                opts.genre = next();
                break;
            case '-k':
            case '--kind':
                opts.kind = next();
                break;
            case '--category':
                opts.category = next();
                break;
            case '--seed':
                opts.seed = parseInt(next(), 10);
                break;
            case '--model':
                opts.model = next();
                break;
            case '--done-file':
                opts.doneFile = next();
                break;
            case '--rows':
                opts.rows = parseInt(next(), 10);
                break;
            case '--cols':
                opts.cols = parseInt(next(), 10);
                break;
            case '--iterations':
                opts.iterations = parseInt(next(), 10);
                break;
            case '--config':
                opts.config = next();
                break;
            case '--config-json':
                opts.configJson = next();
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
            case '--print-config':
                opts.printConfig = true;
                break;
            case '--skip-agy':
                opts.skipAgy = true;
                break;
            case '--skip-split':
                opts.skipSplit = true;
                break;
            case '--skip-process':
                opts.skipProcess = true;
                break;
            case '--skip-inventory':
                opts.skipInventory = true;
                break;
            case '--opaque-alpha':
                opts.opaqueAlpha = true;
                break;
            case '--no-record':
                opts.record = false;
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }

    if (!Number.isFinite(opts.iterations) || opts.iterations < 1) {
        throw new Error('--iterations must be an integer >= 1');
    }
    return opts;
}

/**
 * Parse batch JSON from a string or file path (`-` = stdin).
 * @param {string|null} configPath
 * @param {string|null} configJson
 * @returns {object|null}
 */
function loadConfigObject(configPath, configJson) {
    if (configJson != null) {
        return JSON.parse(configJson);
    }
    if (!configPath) return null;
    const text =
        configPath === '-'
            ? fs.readFileSync(0, 'utf8')
            : fs.readFileSync(
                  path.isAbsolute(configPath) ? configPath : path.join(ROOT, configPath),
                  'utf8'
              );
    return JSON.parse(text);
}

/**
 * Map raw config + CLI flags → buildBatch options.
 * @param {object} raw
 * @param {ReturnType<typeof parseArgs>} opts
 */
function batchOptsFromConfig(raw, opts) {
    const resolveMaybe = (p) => {
        if (!p) return undefined;
        return path.isAbsolute(p) ? p : path.join(ROOT, p);
    };
    return {
        genre: raw.genre || opts.genre,
        kind: raw.kind || opts.kind,
        category: raw.category != null ? raw.category : opts.category,
        seed: raw.seed != null ? raw.seed : opts.seed,
        rows: raw.rows || opts.rows,
        cols: raw.cols || opts.cols,
        count: raw.count,
        doneFile: resolveMaybe(raw.doneFile || opts.doneFile) || undefined,
        model: raw.model || opts.model || undefined,
        opaqueAlpha:
            raw.opaqueAlpha === true ||
            raw.opaque_alpha === true ||
            opts.opaqueAlpha === true,
        creatures: raw.items || raw.creatures || undefined
    };
}

/**
 * Scan original/ tiles and rewrite catalog JSON, re-applying batch aliases.
 * @param {ReturnType<typeof buildBatch>} batch
 */
function refreshCreatureCatalog(batch) {
    const kindId = batch.kindId || DEFAULT_KIND;
    const { catalog, stats } = inventoryGenre(batch.genreId, {
        merge: true,
        kind: kindId
    });
    for (const c of batch.items || batch.creatures) {
        const tags = c.category ? [c.category] : [];
        upsertCreature(catalog, {
            technical: c.technical,
            alias: c.alias,
            genre: batch.genreId,
            kind: kindId,
            category: c.category || batch.category || null,
            opaqueAlpha: Boolean(
                c.opaqueAlpha !== undefined ? c.opaqueAlpha : batch.opaqueAlpha
            ),
            tags,
            source: 'pipeline'
        });
    }
    const written = saveCatalog(catalog, { kind: kindId });
    return { written, stats, total: catalog.creatures.length };
}

/**
 * Resolve ImageMagick binary (v7 magick or v6 convert).
 * @returns {string|null}
 */
function findImageMagick() {
    for (const bin of ['magick', 'convert']) {
        const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
        if (r.status === 0) return bin;
    }
    return null;
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 */
function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        stdio: opts.stdio || 'inherit',
        cwd: ROOT,
        env: process.env
    });
    if (r.error) {
        throw r.error;
    }
    if (r.status !== 0) {
        throw new Error(`${cmd} exited with code ${r.status}`);
    }
    return r;
}

/**
 * Run one sheet: record → image gen (agy|grok) → split → process → inventory.
 * @param {ReturnType<typeof buildBatch>} batch
 * @param {ReturnType<typeof parseArgs>} opts
 * @param {{ iteration: number, total: number }} meta
 */
function runOneIteration(batch, opts, meta) {
    const tag =
        meta.total > 1 ? `[iteration ${meta.iteration}/${meta.total}] ` : '';
    const imageGen = batch.imageGen;

    console.log(`\n${tag}Generating spritesheet batch...`);
    console.log(formatBatchSummary(batch));
    console.log(`Image provider: ${imageGen.provider} (${batch.model})`);
    console.log('');
    console.log('--- Prompt ---');
    console.log(batch.prompt);
    console.log('--------------');

    if (opts.dryRun) {
        console.log(
            `\n${tag}[dry-run] No files written, ${imageGen.command} not called.`
        );
        return;
    }

    fs.mkdirSync(batch.paths.original, { recursive: true });
    fs.mkdirSync(batch.paths.alpha, { recursive: true });
    fs.mkdirSync(batch.paths.medium, { recursive: true });
    fs.mkdirSync(batch.paths.retro, { recursive: true });
    fs.mkdirSync(batch.paths.small, { recursive: true });
    fs.mkdirSync(batch.paths.icon, { recursive: true });
    fs.mkdirSync(path.dirname(batch.doneFile), { recursive: true });

    if (opts.record) {
        appendDoneFile(batch.doneFile, batch.items || batch.creatures);
        console.log(
            `${tag}Recorded ${(batch.items || batch.creatures).length} names → ${batch.doneFile}`
        );
    }

    if (!opts.skipAgy) {
        const effortNote =
            imageGen.provider === 'grok' && imageGen.effort
                ? `, effort: ${imageGen.effort}`
                : '';
        console.log(
            `\n${tag}Running ${imageGen.command} (model: ${batch.model}${effortNote})...`
        );
        try {
            run(imageGen.command, imageGen.args);
        } catch (e) {
            console.error(
                `${tag}Error running ${imageGen.command}: ${e.message}`
            );
            console.error(
                'Names were already recorded in the done file. ' +
                    'Re-run with --skip-agy if the spritesheet was created, or remove the last batch from the done file.'
            );
            process.exit(1);
        }
    } else {
        console.log(`${tag}[skip-agy] Assuming spritesheet already exists.`);
    }

    const spritesheet = batch.paths.spritesheet;
    if (!fs.existsSync(spritesheet)) {
        console.error(
            `${tag}Error: Spritesheet not found at ${spritesheet}. Image generation may have failed.`
        );
        process.exit(1);
    }

    const im = findImageMagick();
    if (!im) {
        console.error(
            'Error: ImageMagick is not installed. Install it (e.g. apt install imagemagick) to split the spritesheet.'
        );
        process.exit(1);
    }

    run(im, [
            spritesheet,
            '-strip',    // Remove all EXIF/profile data
            '-define', 'png:exclude-chunk=all',
            spritesheet
        ]);

    if (!opts.skipSplit) {

        const roster = batch.items || batch.creatures;
        console.log(`\n${tag}Splitting spritesheet into individual files...`);
        const tempPattern = path.join(batch.paths.original, 'temp_tile_%d.png');
        run(im, [
            spritesheet,
            '-define', 'png:exclude-chunk=all',
            '-crop',
            `${batch.cols}x${batch.rows}@`,
            '+repage',
            tempPattern
        ]);

        for (let i = 0; i < roster.length; i++) {
            const temp = path.join(batch.paths.original, `temp_tile_${i}.png`);
            const stem = cleanFileStem(roster[i].technical);
            const dest = path.join(batch.paths.original, `${stem}.png`);
            if (fs.existsSync(temp)) {
                fs.renameSync(temp, dest);
                console.log(`Created: ${dest}`);
            } else {
                console.warn(`Warning: missing tile ${temp}`);
            }
        }
        console.log(`${tag}Spritesheet successfully split and renamed.`);
    }

    if (!opts.skipProcess) {
        const py = path.join(ROOT, 'bin', 'process_sprites.py');
        const opaque = batch.opaqueAlpha === true || opts.opaqueAlpha === true;
        const modeNote = opaque
            ? 'opaque alpha copy (no chroma)'
            : 'chroma key + quantize';
        console.log(`\n${tag}Processing sprites (${modeNote})...`);
        try {
            const pyArgs = [py, batch.paths.original];
            if (opaque) pyArgs.push('--opaque-alpha');
            run('python3', pyArgs);
        } catch (e) {
            console.error(`${tag}Error: process_sprites.py failed: ${e.message}`);
            process.exit(1);
        }
    }

    if (!opts.skipInventory) {
        const manifestName = batch.kind
            ? batch.kind.manifestFileName
            : 'creatures.json';
        console.log(`\n${tag}Refreshing catalog (${manifestName})...`);
        try {
            const inv = refreshCreatureCatalog(batch);
            console.log(
                `Catalog: ${inv.written} (+${inv.stats.added} / ~${inv.stats.updated} / total ${inv.total})`
            );
        } catch (e) {
            console.error(`${tag}Error: catalog inventory failed: ${e.message}`);
            process.exit(1);
        }
    }
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`Error: ${e.message}`);
        printHelp();
        process.exit(1);
    }

    if (opts.help) {
        printHelp();
        process.exit(0);
    }

    /** @type {import('../kernel/core/lib/batch_builder.js').BatchOptions} */
    let batchOpts = {
        genre: opts.genre,
        kind: opts.kind,
        category: opts.category || undefined,
        seed: opts.seed,
        rows: opts.rows,
        cols: opts.cols,
        doneFile: opts.doneFile || undefined,
        model: opts.model || undefined,
        opaqueAlpha: opts.opaqueAlpha === true
    };

    let rawConfig = null;
    try {
        rawConfig = loadConfigObject(opts.config, opts.configJson);
    } catch (e) {
        console.error(`Error reading config: ${e.message}`);
        process.exit(1);
    }
    if (rawConfig) {
        batchOpts = batchOptsFromConfig(rawConfig, opts);
        if (opts.iterations > 1 && batchOpts.creatures && batchOpts.creatures.length) {
            console.error(
                'Error: --iterations > 1 is incompatible with a frozen items list in config. ' +
                    'Use seed + flags (no items) so each iteration can grow the done list.'
            );
            process.exit(1);
        }
    }

    const totalIters = opts.iterations;
    /** @type {string[]} dry-run exclude accumulation (in-memory) */
    let dryExclude = [];

    for (let i = 1; i <= totalIters; i++) {
        let batch;
        try {
            const iterOpts = { ...batchOpts };
            // Frozen creatures only apply to a single iteration.
            if (i > 1) {
                delete iterOpts.creatures;
            }
            if (opts.dryRun && dryExclude.length) {
                iterOpts.exclude = [...(iterOpts.exclude || []), ...dryExclude];
            }
            batch = buildBatch(iterOpts);
        } catch (e) {
            console.error(`Error (iteration ${i}/${totalIters}): ${e.message}`);
            process.exit(1);
        }

        if (opts.printConfig) {
            process.stdout.write(JSON.stringify(batchToConfigJson(batch), null, 2) + '\n');
            process.exit(0);
        }

        runOneIteration(batch, opts, { iteration: i, total: totalIters });

        if (opts.dryRun) {
            dryExclude.push(
                ...(batch.items || batch.creatures).map((c) => c.technical)
            );
        }
    }

    if (opts.dryRun) {
        console.log(
            `\n[dry-run] Planned ${totalIters} iteration(s); nothing written.`
        );
        process.exit(0);
    }

    console.log('\nDone.');
    try {
        const last = buildBatch(batchOpts);
        console.log(`Kind:         ${last.kindId}`);
        console.log(`Originals:    ${last.paths.original}`);
        console.log(`Alpha:        ${last.paths.alpha}`);
        console.log(`Medium:       ${last.paths.medium}`);
        console.log(`Retro:        ${last.paths.retro}`);
        console.log(`Small:        ${last.paths.small}`);
        console.log(`Icon:         ${last.paths.icon}`);
        if (!opts.skipInventory) {
            console.log(
                `Catalog:      assets/data/${last.genreId}/${last.kind.manifestFileName}`
            );
        }
        if (totalIters > 1) {
            console.log(`Iterations:   ${totalIters}`);
        }
    } catch (_) {
        /* ignore summary path errors after success */
    }
}

main();
