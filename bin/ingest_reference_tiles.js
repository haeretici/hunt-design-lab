#!/usr/bin/env node
/**
 * Copy dump fills + beach + walls + scenery into live sprites + catalog
 * (map editor Phase B–F). Extra `anim` frames are `Stem_N.png`.
 *
 *   node bin/ingest_reference_tiles.js
 *   node bin/ingest_reference_tiles.js --dry-run
 *   node bin/ingest_reference_tiles.js --force
 *   node bin/ingest_reference_tiles.js --only ref_grass_fill,ref_water_fill
 *
 * Reads other/tiles/ingest_manifest.json. Writes original/ 256 + icon/ 32
 * nearest. Does not run generate_sprite or chroma. No autotile resolve.
 */

'use strict';

const path = require('path');
const {
    DEFAULT_MANIFEST_REL,
    defaultManifestPath,
    ingestReferenceTiles
} = require('../kernel/core/lib/reference_tile_ingest.js');

function printHelp() {
    console.log(`Ingest replaceable placeholder tiles from a dump manifest.

Usage:
  node bin/ingest_reference_tiles.js [options]

Options:
  --manifest <path>   Manifest JSON (default: ${DEFAULT_MANIFEST_REL})
  --dump-root <path>  Override dump folder (default: manifest.dumpRoot)
  --only <ids>        Comma-separated catalog ids
  --force             Overwrite existing original/ and icon/ PNGs
  --dry-run           Validate + report; do not write
  -h, --help          Show help
`);
}

function parseArgs(argv) {
    const opts = {
        help: false,
        dryRun: false,
        force: false,
        manifestPath: null,
        dumpRoot: null,
        only: null
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--manifest') opts.manifestPath = argv[++i];
        else if (a === '--dump-root') opts.dumpRoot = argv[++i];
        else if (a === '--only') opts.only = argv[++i];
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
    const result = ingestReferenceTiles({
        manifestPath: opts.manifestPath || defaultManifestPath(),
        dumpRoot: opts.dumpRoot || undefined,
        dryRun: opts.dryRun,
        force: opts.force,
        only: opts.only
    });
    const prefix = opts.dryRun ? 'dry-run ' : '';
    console.log(
        `${prefix}ingest items=${result.items.length} pngWrote=${result.wrote} pngSkipped=${result.skipped} catalog=${result.catalogUpserts}`
    );
    for (let i = 0; i < result.warnings.length; i++) {
        console.warn('warn', result.warnings[i]);
    }
    if (!opts.manifestPath) {
        console.log('manifest', path.normalize(DEFAULT_MANIFEST_REL));
    }
}

main();
