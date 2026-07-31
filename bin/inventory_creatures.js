#!/usr/bin/env node
/**
 * Scan sprite folders and write per-genre creature catalogs (creatures.json).
 *
 * Usage:
 *   node bin/inventory_creatures.js -g rpg_fantasy
 *   node bin/inventory_creatures.js --all
 *   node bin/inventory_creatures.js -g rpg_fantasy --dry-run
 *   node bin/inventory_creatures.js -g rpg_fantasy --print
 */

'use strict';

const {
    DEFAULT_GENRE,
    DEFAULT_KIND,
    GENRES,
    genrePaths,
    listKindIds
} = require('../kernel/settings.js');
const {
    inventoryGenre,
    inventoryAll,
    saveCatalog,
    loadCatalog,
    listCreatures
} = require('../kernel/core/lib/creature_manifest.js');

function printHelp() {
    console.log(`Build or refresh asset catalog JSON from on-disk sprites.

Usage:
  node bin/inventory_creatures.js [options]

Options:
  -g, --genre <id>   Genre to inventory (default: ${DEFAULT_GENRE})
  -k, --kind <id>    Asset kind (default: ${DEFAULT_KIND})
                     ${listKindIds().join(' | ')}
  --all              Inventory every registered genre (current kind)
  --all-kinds        With --all: inventory every genre × kind
  --no-merge         Ignore existing catalog (rebuild from sprites only)
  --dry-run          Scan and report; do not write JSON
  --print            Print catalog JSON to stdout after inventory
  --summary          Print asset id / status / alias table
  -h, --help         Show help

Genres: ${Object.keys(GENRES).join(', ')}
Output: assets/data/<genre>/<kind catalog>.json
`);
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
        merge: true,
        dryRun: false,
        print: false,
        summary: false,
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
            case '--no-merge':
                opts.merge = false;
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
            case '--print':
                opts.print = true;
                break;
            case '--summary':
                opts.summary = true;
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }
    return opts;
}

/**
 * @param {string} key display key (genre or genre/kind)
 * @param {string} genreId
 * @param {string} kindId
 * @param {object} result
 * @param {object} opts
 */
function reportGenre(key, genreId, kindId, result, opts) {
    const { catalog, stats } = result;
    const manifestPath = genrePaths(genreId, kindId).manifest;
    console.log(
        `[${key}] sprites original=${stats.original} (transformed/ ignored)`
    );
    console.log(
        `  catalog items=${stats.total} (scan added≈${stats.added}, updated=${stats.updated})`
    );

    if (opts.summary) {
        for (const c of listCreatures(catalog)) {
            console.log(`  - ${c.id} | ${c.status} | ${c.alias} — ${c.technical}`);
        }
    }

    if (opts.dryRun) {
        console.log(`  dry-run: would write ${manifestPath}`);
        return null;
    }

    const written = saveCatalog(catalog, { kind: kindId });
    console.log(`  wrote ${written}`);
    return written;
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

    const invOpts = {
        merge: opts.merge,
        kind: opts.kind,
        allKinds: opts.allKinds
    };

    if (opts.all) {
        const all = inventoryAll(invOpts);
        for (const key of Object.keys(all)) {
            const parts = key.split('/');
            const genreId = parts[0];
            const kindId = parts[1] || opts.kind;
            reportGenre(key, genreId, kindId, all[key], opts);
        }
        if (opts.print) {
            const dump = {};
            for (const key of Object.keys(all)) {
                const parts = key.split('/');
                const genreId = parts[0];
                const kindId = parts[1] || opts.kind;
                dump[key] = opts.dryRun
                    ? all[key].catalog
                    : loadCatalog(genreId, { kind: kindId });
            }
            console.log(JSON.stringify(dump, null, 2));
        }
        return;
    }

    const result = inventoryGenre(opts.genre, invOpts);
    reportGenre(
        `${opts.genre}/${opts.kind}`,
        opts.genre,
        opts.kind,
        result,
        opts
    );
    if (opts.print) {
        const cat = opts.dryRun
            ? result.catalog
            : loadCatalog(opts.genre, { kind: opts.kind });
        console.log(JSON.stringify(cat, null, 2));
    }
}

main();
