#!/usr/bin/env node
/**
 * Phase H — overwrite ref_* placeholder PNGs with procedural 32px art.
 * Keeps catalog ids + autoTile + anim. Flips source to pipeline, replaceable false.
 *
 *   node bin/replace_placeholder_tiles.js --force
 *   node bin/replace_placeholder_tiles.js --dry-run
 *   node bin/replace_placeholder_tiles.js --force --only ref_grass_fill,ref_water_fill
 *   node bin/replace_placeholder_tiles.js --force --preview var/placeholder_preview
 */

'use strict';

const { replacePlaceholderTiles } = require('../kernel/core/lib/replace_placeholder_art.js');

function printHelp() {
    console.log(`Replace reference_placeholder pixels with original 32px art.

Usage:
  node bin/replace_placeholder_tiles.js [options]

Options:
  --force             Overwrite existing original/icon/small/medium/alpha PNGs
  --only <ids>        Comma-separated catalog ids
  --preview <dir>     Write family contact sheets
  --dry-run           Count writes; do not touch disk
  -h, --help          Show help
`);
}

function parseArgs(argv) {
    const opts = {
        help: false,
        dryRun: false,
        force: false,
        only: null,
        previewDir: null
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--only') opts.only = argv[++i];
        else if (a === '--preview') opts.previewDir = argv[++i];
        else throw new Error(`unknown arg: ${a}`);
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        printHelp();
        return;
    }
    const result = replacePlaceholderTiles({
        dryRun: opts.dryRun,
        force: opts.force,
        only: opts.only,
        previewDir: opts.previewDir
    });
    const prefix = opts.dryRun ? 'dry-run ' : '';
    console.log(
        `${prefix}replace items=${result.items.length} pngWrote=${result.wrote} pngSkipped=${result.skipped} catalog=${result.catalogUpserts}`
    );
}

main();
