#!/usr/bin/env node
/**
 * Clean bad / removed creature tiles and sync catalog + done list.
 *
 * 1. Undersized originals (width < min, default 256) — delete original +
 *    matching alpha/medium/retro/small/icon (and legacy transformed/) tiles.
 * 2. Missing originals — after manual deletes (or step 1), drop catalog rows
 *    and done-list names that no longer have an original PNG on disk.
 * 3. Orphan processed tiles (alpha/medium/retro/small/icon/transformed) without a
 *    matching original — delete.
 *
 * Usage:
 *   node bin/clean_undersized_sprites.js --all --dry-run
 *   node bin/clean_undersized_sprites.js --all
 *   node bin/clean_undersized_sprites.js -g ultra_tech --min-width 256
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_GENRE,
    DEFAULT_KIND,
    GENRES,
    genrePaths,
    listKindIds
} = require('../kernel/settings.js');
const {
    loadCatalog,
    saveCatalog,
    technicalToId,
    technicalToFileStem,
    fileStemToTechnical,
    absoluteSpritePath
} = require('../kernel/core/lib/creature_manifest.js');

const DEFAULT_MIN_WIDTH = 256;

function printHelp() {
    console.log(`Clean undersized / missing sprites and sync catalogs.

Usage:
  node bin/clean_undersized_sprites.js [options]

Options:
  -g, --genre <id>     Genre to clean (default: ${DEFAULT_GENRE})
  -k, --kind <id>      Asset kind (default: ${DEFAULT_KIND})
                       ${listKindIds().join(' | ')}
  --all                Clean every registered genre (current kind)
  --all-kinds          With --all: clean every genre × kind
  --min-width <n>      Delete when image width < n (default: ${DEFAULT_MIN_WIDTH})
  --keep-done          Do not edit the kind done-list file
  --dry-run            Report only; do not delete or write
  -h, --help           Show help

Genres: ${Object.keys(GENRES).join(', ')}

What it does:
  • Delete original/*.png with width < --min-width (and matching processed variants)
  • Drop catalog rows whose original image is not on disk
    (planned rows with no original path are kept)
  • Prune done-list lines with no matching original PNG
  • Delete orphan alpha/medium/retro/small/icon (and legacy transformed/) tiles
`);
}

/** Processed variant folder names under …/creatures/. */
const PROCESSED_VARIANT_NAMES = [
    'alpha',
    'medium',
    'retro',
    'small',
    'icon',
    'transformed'
];

/**
 * Absolute paths for processed variants that exist on disk for a genre.
 * @param {ReturnType<typeof genrePaths>} paths
 * @returns {Array<{ name: string, dir: string }>}
 */
function processedVariantDirs(paths) {
    const out = [];
    for (const name of PROCESSED_VARIANT_NAMES) {
        const dir =
            name === 'transformed'
                ? path.join(paths.creaturesRoot, 'transformed')
                : paths[name] || path.join(paths.creaturesRoot, name);
        if (dir && fs.existsSync(dir)) {
            out.push({ name, dir });
        }
    }
    return out;
}

/**
 * @param {Array<{ name: string, dir: string }>} variants
 * @param {string} stem
 * @returns {string[]}
 */
function matchingProcessedPaths(variants, stem) {
    const found = [];
    for (const { dir } of variants) {
        const p = path.join(dir, `${stem}.png`);
        if (fs.existsSync(p)) found.push(p);
    }
    return found;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        genre: DEFAULT_GENRE,
        kind: DEFAULT_KIND,
        all: false,
        allKinds: false,
        minWidth: DEFAULT_MIN_WIDTH,
        keepDone: false,
        dryRun: false,
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
            case '--all':
                opts.all = true;
                break;
            case '--all-kinds':
                opts.allKinds = true;
                break;
            case '--min-width': {
                const n = parseInt(next(), 10);
                if (!Number.isFinite(n) || n < 1) {
                    throw new Error(`Invalid --min-width: must be a positive integer`);
                }
                opts.minWidth = n;
                break;
            }
            case '--keep-done':
                opts.keepDone = true;
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }
    return opts;
}

/**
 * Read PNG width/height from IHDR (no native deps).
 * @param {string} filePath
 * @returns {{ width: number, height: number }}
 */
function readPngSize(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(24);
        const n = fs.readSync(fd, buf, 0, 24, 0);
        if (n < 24) {
            throw new Error(`file too short (${n} bytes)`);
        }
        if (
            buf[0] !== 0x89 ||
            buf.toString('ascii', 1, 4) !== 'PNG' ||
            buf[4] !== 0x0d ||
            buf[5] !== 0x0a ||
            buf[6] !== 0x1a ||
            buf[7] !== 0x0a
        ) {
            throw new Error('not a PNG');
        }
        if (buf.toString('ascii', 12, 16) !== 'IHDR') {
            throw new Error('missing IHDR');
        }
        return {
            width: buf.readUInt32BE(16),
            height: buf.readUInt32BE(20)
        };
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * @param {string} dir
 * @returns {string[]} absolute paths to *.png
 */
function listPngFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.png'))
        .map((name) => path.join(dir, name))
        .sort();
}

/**
 * @param {string} filePath
 */
function unlinkQuiet(filePath) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}

/**
 * @param {string} originalDir
 * @returns {Set<string>} lowercase stems that exist on disk
 */
function existingOriginalStems(originalDir) {
    const set = new Set();
    for (const filePath of listPngFiles(originalDir)) {
        set.add(path.basename(filePath, path.extname(filePath)).toLowerCase());
    }
    return set;
}

/**
 * Whether the original PNG for this catalog row exists.
 * Planned rows with no original path are treated as present (nothing to clean).
 * @param {object} creature
 * @param {string} originalDir
 * @returns {{ exists: boolean, stem: string|null, reason: string }}
 */
function resolveOriginalPresence(creature, originalDir) {
    const rel = creature.sprites && creature.sprites.original;
    if (rel) {
        const abs = absoluteSpritePath(String(rel));
        const stem = path.basename(abs, path.extname(abs));
        return {
            exists: fs.existsSync(abs),
            stem,
            reason: 'sprites.original'
        };
    }

    // No path claimed — keep planned/manual concept-only rows
    if (creature.status === 'planned' || creature.source === 'manual') {
        return { exists: true, stem: null, reason: 'concept-only' };
    }

    // Inventory-style row should have a file derived from technical / id
    let stem = null;
    if (creature.technical) {
        stem = technicalToFileStem(String(creature.technical));
    } else if (creature.id) {
        // id is snake_case; file stems are Title_Case — try id as stem first
        stem = String(creature.id);
    }
    if (!stem) {
        return { exists: false, stem: null, reason: 'no-identity' };
    }
    const abs = path.join(originalDir, `${stem}.png`);
    if (fs.existsSync(abs)) {
        return { exists: true, stem, reason: 'derived-stem' };
    }
    // Case-insensitive fallback against directory listing
    const lower = stem.toLowerCase();
    for (const filePath of listPngFiles(originalDir)) {
        const s = path.basename(filePath, path.extname(filePath));
        if (s.toLowerCase() === lower) {
            return { exists: true, stem: s, reason: 'derived-stem-ci' };
        }
    }
    return { exists: false, stem, reason: 'derived-stem' };
}

/**
 * Drop done-list lines whose technical name is in `technicals`.
 * @param {string} doneFile
 * @param {Set<string>} technicals
 * @param {boolean} dryRun
 * @returns {{ before: number, after: number, removed: number }}
 */
function pruneDoneFile(doneFile, technicals, dryRun) {
    if (!fs.existsSync(doneFile)) {
        return { before: 0, after: 0, removed: 0 };
    }
    if (technicals.size === 0) {
        const text = fs.readFileSync(doneFile, 'utf8');
        const before = text.split(/\r?\n/).filter((l) => l.trim()).length;
        return { before, after: before, removed: 0 };
    }
    const text = fs.readFileSync(doneFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const kept = [];
    let removed = 0;
    let contentLines = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        contentLines += 1;
        const technical = trimmed.split('\t')[0].trim();
        if (technicals.has(technical)) {
            removed += 1;
            continue;
        }
        kept.push(line.replace(/\r$/, ''));
    }
    const after = kept.length;
    if (!dryRun && removed > 0) {
        const body = kept.length ? kept.join('\n') + '\n' : '';
        fs.writeFileSync(doneFile, body, 'utf8');
    }
    return { before: contentLines, after, removed };
}

/**
 * Collect technical names from done list that have no original PNG.
 * @param {string} doneFile
 * @param {string} originalDir
 * @param {Set<string>} existingStemsLower
 * @returns {Set<string>}
 */
function missingDoneTechnicals(doneFile, originalDir, existingStemsLower) {
    const missing = new Set();
    if (!fs.existsSync(doneFile)) return missing;
    const text = fs.readFileSync(doneFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const technical = trimmed.split('\t')[0].trim();
        if (!technical) continue;
        const stem = technicalToFileStem(technical);
        if (!existingStemsLower.has(stem.toLowerCase())) {
            missing.add(technical);
        }
    }
    return missing;
}

/**
 * @param {string} genreId
 * @param {{ minWidth: number, keepDone: boolean, dryRun: boolean, kind?: string }} opts
 */
function cleanGenre(genreId, opts) {
    const kindId = opts.kind || DEFAULT_KIND;
    const paths = genrePaths(genreId, kindId);
    const label = opts.dryRun ? 'would remove' : 'remove';
    const originals = listPngFiles(paths.original);
    const variants = processedVariantDirs(paths);

    /** @type {Array<{ stem: string, width: number, height: number, original: string, processed: string[], technical: string, id: string }>} */
    const undersized = [];

    for (const filePath of originals) {
        const stem = path.basename(filePath, path.extname(filePath));
        let size;
        try {
            size = readPngSize(filePath);
        } catch (err) {
            console.warn(
                `  [warn] skip unreadable PNG ${path.basename(filePath)}: ${err.message || err}`
            );
            continue;
        }
        if (size.width < opts.minWidth) {
            const technical = fileStemToTechnical(stem);
            undersized.push({
                stem,
                width: size.width,
                height: size.height,
                original: filePath,
                processed: matchingProcessedPaths(variants, stem),
                technical,
                id: technicalToId(technical)
            });
        }
    }

    console.log(
        `\n[${genreId}/${kindId}] scanned ${originals.length} original(s); ` +
            `${undersized.length} under min-width ${opts.minWidth}`
    );

    let removedImages = 0;
    let removedTransformed = 0;
    /** @type {Set<string>} absolute paths already deleted as paired undersized */
    const pairedProcessed = new Set();

    for (const b of undersized) {
        const pNote = b.processed.length
            ? ` + ${b.processed.length} processed`
            : '';
        console.log(`  ${label} undersized ${b.stem}.png (${b.width}×${b.height})${pNote}`);
        if (!opts.dryRun) {
            if (unlinkQuiet(b.original)) removedImages += 1;
            for (const p of b.processed) {
                if (unlinkQuiet(p)) {
                    removedTransformed += 1;
                    pairedProcessed.add(p);
                }
            }
        } else {
            removedImages += 1;
            removedTransformed += b.processed.length;
            for (const p of b.processed) pairedProcessed.add(p);
        }
    }

    // Stems still on disk after undersized deletes
    const stemsOnDisk = opts.dryRun
        ? new Set(
              originals
                  .filter((fp) => {
                      const stem = path.basename(fp, path.extname(fp));
                      return !undersized.some((u) => u.stem === stem);
                  })
                  .map((fp) => path.basename(fp, path.extname(fp)).toLowerCase())
          )
        : existingOriginalStems(paths.original);

    // Orphan processed variants (no matching original after cleanup)
    let removedOrphanTransformed = 0;
    for (const { name, dir } of variants) {
        for (const tPath of listPngFiles(dir)) {
            if (pairedProcessed.has(tPath)) continue;
            const stem = path.basename(tPath, path.extname(tPath));
            if (stemsOnDisk.has(stem.toLowerCase())) continue;
            console.log(`  ${label} orphan ${name}/${stem}.png (no original)`);
            if (!opts.dryRun) {
                if (unlinkQuiet(tPath)) {
                    removedTransformed += 1;
                    removedOrphanTransformed += 1;
                }
            } else {
                removedTransformed += 1;
                removedOrphanTransformed += 1;
            }
        }
    }

    // Catalog: drop rows whose original image is missing
    const catalog = loadCatalog(genreId, { kind: kindId });
    const beforeCount = catalog.creatures.length;
    /** @type {object[]} */
    const droppedCatalog = [];
    catalog.creatures = catalog.creatures.filter((c) => {
        const presence = resolveOriginalPresence(c, paths.original);
        if (presence.exists) {
            // Also treat as missing if file is in the undersized set (dry-run still on disk)
            if (
                presence.stem &&
                undersized.some((u) => u.stem.toLowerCase() === presence.stem.toLowerCase())
            ) {
                droppedCatalog.push(c);
                return false;
            }
            return true;
        }
        droppedCatalog.push(c);
        return false;
    });
    const removedCatalog = beforeCount - catalog.creatures.length;

    for (const c of droppedCatalog) {
        const tech = c.technical || c.id || '?';
        console.log(`  ${label} catalog row: ${tech} (original missing)`);
    }

    if (opts.dryRun) {
        if (removedCatalog > 0 || undersized.length === 0) {
            console.log(
                `  dry-run: would drop ${removedCatalog} catalog row(s) ` +
                    `(${beforeCount} → ${catalog.creatures.length})`
            );
        }
    } else if (removedCatalog > 0 || undersized.length > 0) {
        // Always rewrite when we touched images so updatedAt stays honest if only orphans
        const written = saveCatalog(catalog, { kind: kindId });
        console.log(
            `  catalog: dropped ${removedCatalog} row(s) ` +
                `(${beforeCount} → ${catalog.creatures.length}) → ${written}`
        );
    } else if (droppedCatalog.length === 0) {
        console.log(`  catalog: unchanged (${beforeCount} row(s))`);
    }

    // Done list: prune names with no original on disk
    let removedDone = 0;
    if (!opts.keepDone) {
        const missingTechnicals = missingDoneTechnicals(
            paths.doneFile,
            paths.original,
            stemsOnDisk
        );
        // Include undersized technicals (dry-run: still on disk but will be gone)
        for (const u of undersized) {
            missingTechnicals.add(u.technical);
        }
        const doneStats = pruneDoneFile(paths.doneFile, missingTechnicals, opts.dryRun);
        removedDone = doneStats.removed;
        if (doneStats.removed > 0) {
            console.log(
                `  done list: ${opts.dryRun ? 'would remove' : 'removed'} ` +
                    `${doneStats.removed} line(s) with no original ` +
                    `(${doneStats.before} → ${doneStats.after})`
            );
        } else {
            console.log(
                `  done list: unchanged (${doneStats.before} line(s), all have originals)`
            );
        }
    } else {
        console.log('  done list: left unchanged (--keep-done)');
    }

    return {
        genreId,
        kindId,
        scanned: originals.length,
        removedImages,
        removedTransformed,
        removedOrphanTransformed,
        removedCatalog,
        removedDone
    };
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(String(err.message || err));
        process.exit(1);
    }

    if (opts.help) {
        printHelp();
        process.exit(0);
    }

    const genres = opts.all ? Object.keys(GENRES) : [opts.genre];
    if (!opts.all && !GENRES[opts.genre]) {
        console.error(
            `Unknown genre "${opts.genre}". Known: ${Object.keys(GENRES).join(', ')}`
        );
        process.exit(1);
    }
    const kinds = opts.allKinds ? listKindIds() : [opts.kind || DEFAULT_KIND];

    console.log(
        `Clean sprites (min-width ${opts.minWidth}; sync missing originals)` +
            (opts.dryRun ? ' [dry-run]' : '')
    );

    /** @type {ReturnType<typeof cleanGenre>[]} */
    const results = [];
    for (const genreId of genres) {
        for (const kindId of kinds) {
            results.push(cleanGenre(genreId, { ...opts, kind: kindId }));
        }
    }

    const totals = results.reduce(
        (acc, r) => {
            acc.scanned += r.scanned;
            acc.removedImages += r.removedImages;
            acc.removedTransformed += r.removedTransformed;
            acc.removedCatalog += r.removedCatalog;
            acc.removedDone += r.removedDone;
            return acc;
        },
        {
            scanned: 0,
            removedImages: 0,
            removedTransformed: 0,
            removedCatalog: 0,
            removedDone: 0
        }
    );

    console.log('\n--- Summary ---');
    console.log(`Genres:              ${genres.join(', ')}`);
    console.log(`Originals scanned:   ${totals.scanned}`);
    console.log(
        `${opts.dryRun ? 'Would remove originals:' : 'Removed originals:'}  ${totals.removedImages}`
    );
    console.log(
        `${opts.dryRun ? 'Would remove processed:' : 'Removed processed:'}   ${totals.removedTransformed}`
    );
    console.log(
        `${opts.dryRun ? 'Would drop catalog rows:' : 'Dropped catalog rows:'}  ${totals.removedCatalog}`
    );
    if (!opts.keepDone) {
        console.log(
            `${opts.dryRun ? 'Would prune done lines:' : 'Pruned done lines:'}    ${totals.removedDone}`
        );
    }
}

main();
