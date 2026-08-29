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
 *   node bin/generate_sprite.js --model 'Grok 4.6 (High)'
 *   node bin/generate_sprite.js --config batch.json
 *   node bin/generate_sprite.js -g rpg_fantasy --resplit-last
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    DEFAULT_GENRE,
    DEFAULT_KIND,
    ROOT,
    listKindIds,
    genrePaths
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
                         tiles: floor|wall|…; overlays: dirt|water|cobble;
                         objects: tree|house|…)
  --wall-family <id>     Wall Wang family (objects): 4 faces, count must be 4
  --wang-family <id>     Alias of --wall-family (objects only)
  --seed <n>             Reproducible name batch
  --model <name>         Image model label (default: ${DEFAULT_MODEL})
                         Gemini * → agy; Grok 4.6 (Low|Medium|High) → grok
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
                         (forbidden for --kind overlays and wall families)
  --scale-filter <id>    lanczos (default) | nearest. Stamps catalog scaleFilter
                         and process_sprites small/icon. Use nearest for 32/64
                         pixel art (32/64 originals expand to 256 with NEAREST)
  --no-record            Do not append names to done file
  --resplit-last         Re-crop existing sprites.png onto the last sheet's roster
                         (last rows×cols names from the done list). Overwrites only
                         those original/ tiles, then reprocesses their variants.
                         Implies --skip-agy and --no-record. iterations must be 1.
                         (Any sprites.png split already force-reprocesses sheet stems.)
  -h, --help             Show help

One-shot (copy from Batch Builder CLI box):
  node bin/generate_sprite.js -g steampunk --seed 42 --iterations 2 --model 'Gemini 3.7 Flash (High)'
  node bin/generate_sprite.js -g rpg_fantasy --kind equipment --category sword --seed 1
  node bin/generate_sprite.js -g rpg_fantasy --kind objects --seed 3 --model 'Grok 4.6 (High)'
  node bin/generate_sprite.js -g rpg_fantasy --kind overlays --category dirt --dry-run
  node bin/generate_sprite.js -g rpg_fantasy --kind objects --category wall --wall-family stone_wall --rows 2 --cols 2 --dry-run

Re-split after fixing crop alignment on sprites.png (last batch only):
  node bin/generate_sprite.js -g rpg_fantasy --resplit-last
  node bin/generate_sprite.js -g rpg_fantasy --resplit-last --dry-run
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
        wallFamily: null,
        wangFamily: null,
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
        scaleFilter: null,
        record: true,
        resplitLast: false,
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
            case '--wall-family':
                opts.wallFamily = next();
                break;
            case '--wang-family':
                opts.wangFamily = next();
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
            case '--scale-filter': {
                const v = String(next()).trim().toLowerCase();
                if (v !== 'lanczos' && v !== 'nearest') {
                    throw new Error('--scale-filter must be lanczos or nearest');
                }
                opts.scaleFilter = v;
                break;
            }
            case '--no-record':
                opts.record = false;
                break;
            case '--resplit-last':
                opts.resplitLast = true;
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }

    if (!Number.isFinite(opts.iterations) || opts.iterations < 1) {
        throw new Error('--iterations must be an integer >= 1');
    }
    if (opts.resplitLast) {
        // Re-crop the existing sheet onto the last recorded roster only.
        opts.skipAgy = true;
        opts.record = false;
        if (opts.iterations !== 1) {
            throw new Error('--resplit-last requires --iterations 1 (default)');
        }
    }
    return opts;
}

/**
 * Last N non-empty done-list lines as ordered roster entries (technical + alias).
 * Used by --resplit-last so tile order matches the sheet that was just generated.
 * @param {string} doneFile
 * @param {number} count
 * @returns {Array<{technical: string, alias: string}>}
 */
function loadLastDoneEntries(doneFile, count) {
    if (!doneFile || !fs.existsSync(doneFile)) {
        throw new Error(
            `Done list not found at ${doneFile || '(empty path)'}. ` +
                'Cannot resolve the last sheet roster for --resplit-last.'
        );
    }
    if (!Number.isFinite(count) || count < 1) {
        throw new Error(`Invalid last-sheet count: ${count}`);
    }
    const lines = fs
        .readFileSync(doneFile, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.length < count) {
        throw new Error(
            `Done list has ${lines.length} name(s); need at least ${count} ` +
                `(rows×cols) to re-split the last sheet.`
        );
    }
    return lines.slice(-count).map((line) => {
        const tab = line.indexOf('\t');
        const technical = (tab >= 0 ? line.slice(0, tab) : line).trim();
        const alias = (tab >= 0 ? line.slice(tab + 1) : technical).trim() || technical;
        return { technical, alias };
    });
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
        wallFamily:
            raw.wallFamily != null
                ? raw.wallFamily
                : opts.wallFamily || raw.wangFamily || opts.wangFamily,
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
        scaleFilter:
            raw.scaleFilter === 'nearest' ||
            raw.scaleFilter === 'lanczos' ||
            raw.scale_filter === 'nearest' ||
            raw.scale_filter === 'lanczos'
                ? raw.scaleFilter || raw.scale_filter
                : opts.scaleFilter,
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
        /** @type {Record<string, unknown>} */
        const row = {
            technical: c.technical,
            alias: c.alias,
            genre: batch.genreId,
            kind: kindId,
            category: c.category || batch.category || null,
            wangFamily: c.wangFamily,
            wangMask: c.wangMask,
            wallFamily: c.wallFamily,
            wallAlign: c.wallAlign,
            opaqueAlpha: Boolean(
                c.opaqueAlpha !== undefined ? c.opaqueAlpha : batch.opaqueAlpha
            ),
            tags,
            source: 'pipeline'
        };
        if (batch.scaleFilter === 'nearest' || batch.scaleFilter === 'lanczos') {
            row.scaleFilter = batch.scaleFilter;
        } else if (c.scaleFilter === 'nearest' || c.scaleFilter === 'lanczos') {
            row.scaleFilter = c.scaleFilter;
        }
        upsertCreature(catalog, row);
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
                console.log(
                    opts.resplitLast ? `Overwrote: ${dest}` : `Created: ${dest}`
                );
            } else {
                console.warn(`Warning: missing tile ${temp}`);
            }
        }
        // Drop any leftover temp tiles (e.g. crop count > roster).
        try {
            for (const name of fs.readdirSync(batch.paths.original)) {
                if (/^temp_tile_\d+\.png$/i.test(name)) {
                    fs.unlinkSync(path.join(batch.paths.original, name));
                }
            }
        } catch (_) {
            /* ignore cleanup errors */
        }
        console.log(`${tag}Spritesheet successfully split and renamed.`);
    }

    if (!opts.skipProcess) {
        const py = path.join(ROOT, 'bin', 'process_sprites.py');
        const opaque =
            batch.kindId !== 'overlays' &&
            (batch.opaqueAlpha === true || opts.opaqueAlpha === true);
        const modeNote = opaque
            ? 'opaque alpha copy (no chroma)'
            : 'chroma key + quantize';
        // After any sprites.png crop, rewrite variants even if they already exist.
        // Scope to this sheet's stems so the rest of original/ is not reprocessed.
        const forceSheetAfterSplit = !opts.skipSplit;
        const stems = batch.fileStems || [];
        console.log(
            `\n${tag}Processing sprites (${modeNote}${
                forceSheetAfterSplit
                    ? `; force ${stems.length || 'sheet'} stem(s) after split`
                    : ''
            })...`
        );
        try {
            const pyArgs = [py, batch.paths.original];
            if (opaque) pyArgs.push('--opaque-alpha');
            if (batch.scaleFilter === 'nearest' || batch.scaleFilter === 'lanczos') {
                pyArgs.push('--scale-filter', batch.scaleFilter);
            } else if (opts.scaleFilter === 'nearest' || opts.scaleFilter === 'lanczos') {
                pyArgs.push('--scale-filter', opts.scaleFilter);
            }
            if (forceSheetAfterSplit) {
                pyArgs.push('--force');
                for (const stem of stems) {
                    pyArgs.push('--only', stem);
                }
            }
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
        wallFamily: opts.wallFamily || opts.wangFamily || undefined,
        seed: opts.seed,
        rows: opts.rows,
        cols: opts.cols,
        doneFile: opts.doneFile || undefined,
        model: opts.model || undefined,
        opaqueAlpha: opts.opaqueAlpha === true,
        scaleFilter: opts.scaleFilter
    };

    let rawConfig = null;
    try {
        rawConfig = loadConfigObject(opts.config, opts.configJson);
    } catch (e) {
        console.error(`Error reading config: ${e.message}`);
        process.exit(1);
    }
    if (rawConfig) {
        if (opts.resplitLast) {
            console.error(
                'Error: --resplit-last cannot be combined with --config / --config-json. ' +
                    'Roster comes from the last rows×cols entries of the done list.'
            );
            process.exit(1);
        }
        batchOpts = batchOptsFromConfig(rawConfig, opts);
        if (opts.iterations > 1 && batchOpts.creatures && batchOpts.creatures.length) {
            console.error(
                'Error: --iterations > 1 is incompatible with a frozen items list in config. ' +
                    'Use seed + flags (no items) so each iteration can grow the done list.'
            );
            process.exit(1);
        }
    }

    if (opts.resplitLast) {
        const sheetCount = batchOpts.rows * batchOpts.cols;
        let donePath = batchOpts.doneFile;
        if (!donePath) {
            try {
                donePath = genrePaths(batchOpts.genre, batchOpts.kind).doneFile;
            } catch (e) {
                console.error(`Error resolving done list for --resplit-last: ${e.message}`);
                process.exit(1);
            }
        }
        try {
            const lastItems = loadLastDoneEntries(donePath, sheetCount);
            batchOpts.creatures = lastItems;
            console.log(
                `--resplit-last: re-cropping sprites.png onto last ${sheetCount} done-list name(s):`
            );
            for (const c of lastItems) {
                console.log(`  - ${c.technical}`);
            }
            console.log(`Done list: ${donePath}`);
        } catch (e) {
            console.error(`Error: ${e.message}`);
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
