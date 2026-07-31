#!/usr/bin/env node
/**
 * Asset Manager CLI — list / remove / rename / flip / replace / fix-green creature sprites + catalog.
 *
 * Usage:
 *   node bin/manage_creature.js list -g rpg_fantasy [--limit 50] [--query goblin] [--json]
 *   node bin/manage_creature.js genres [--json]
 *   node bin/manage_creature.js remove -g rpg_fantasy --id ashen_dwarf_priest [--dry-run] [--json]
 *   node bin/manage_creature.js rename -g rpg_fantasy --id ashen_dwarf_priest --name "Ashen Dwarf Cleric" [--json]
 *   node bin/manage_creature.js flip -g rpg_fantasy --id ashen_dwarf_priest [--json]
 *   node bin/manage_creature.js replace -g rpg_fantasy --id ashen_dwarf_priest --file /path/to.png [--json]
 */

'use strict';

const {
    DEFAULT_GENRE,
    DEFAULT_KIND,
    GENRES,
    listKindIds
} = require('../kernel/settings.js');
const {
    listCreaturesEnriched,
    listGenresSummary,
    removeCreature,
    renameCreature,
    flipCreatureHorizontal,
    replaceCreatureOriginal,
    setOpaqueAlpha,
    reprocessCreature,
    fixGreenCreature
} = require('../kernel/core/lib/creature_assets.js');

function printHelp() {
    console.log(`Asset manager (catalog + files) for any asset kind.

Usage:
  node bin/manage_creature.js <command> [options]

Commands:
  list      List assets (newest file mtime first)
  genres    Genre summary counts (for current --kind)
  remove    Delete sprite variants + catalog row (+ done list)
  rename    Rename technical name, files, catalog, done list
  flip      Horizontal flip of original/ via ImageMagick, then process_sprites --force --only
  replace   Overwrite original/ from --file, then process_sprites --force --only
  opaque    Set opaqueAlpha flag and reprocess stem (--value true|false)
  reprocess Re-run process_sprites --force --only for one stem (no flip/replace)
  fix-green Neutralize accentuated green (R=B=G) on original/, then reprocess

Options:
  -g, --genre <id>     Genre id (default: ${DEFAULT_GENRE})
  -k, --kind <id>      Asset kind (default: ${DEFAULT_KIND})
                       ${listKindIds().join(' | ')}
  --id <id>            Asset id (snake_case)
  --name <technical>   New technical name (rename)
  --alias <alias>      Optional new alias (rename)
  --file <path>        Source image path (replace)
  --value <bool>       true|false for opaque command
  --limit <n>          Max rows for list
  --query <text>       Filter list by id/technical/alias
  --dry-run            Report only (remove/rename/flip/replace/reprocess/opaque/fix-green)
  --keep-done          Do not edit done list on remove
  --json               Machine-readable JSON on stdout
  -h, --help           Show help

Genres: ${Object.keys(GENRES).join(', ')}
`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        command: null,
        genre: DEFAULT_GENRE,
        kind: DEFAULT_KIND,
        id: null,
        name: null,
        alias: null,
        file: null,
        limit: null,
        query: '',
        value: null,
        dryRun: false,
        keepDone: false,
        json: false,
        help: false
    };

    const args = argv.slice();
    if (args.length && !args[0].startsWith('-')) {
        opts.command = args.shift();
    }

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const next = () => {
            const v = args[++i];
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
            case '--id':
                opts.id = next();
                break;
            case '--name':
                opts.name = next();
                break;
            case '--alias':
                opts.alias = next();
                break;
            case '--file':
                opts.file = next();
                break;
            case '--value':
                opts.value = next();
                break;
            case '--limit': {
                const n = parseInt(next(), 10);
                if (!Number.isFinite(n) || n < 0) throw new Error('Invalid --limit');
                opts.limit = n;
                break;
            }
            case '--query':
            case '-q':
                opts.query = next();
                break;
            case '--dry-run':
                opts.dryRun = true;
                break;
            case '--keep-done':
                opts.keepDone = true;
                break;
            case '--json':
                opts.json = true;
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }
    return opts;
}

function emit(opts, data, textLines) {
    if (opts.json) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        return;
    }
    for (const line of textLines || []) {
        console.log(line);
    }
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`Error: ${err.message || err}`);
        process.exit(1);
    }

    if (opts.help || !opts.command) {
        printHelp();
        process.exit(opts.help ? 0 : 1);
    }

    try {
        switch (opts.command) {
            case 'list': {
                const data = listCreaturesEnriched(opts.genre, {
                    limit: opts.limit,
                    query: opts.query,
                    kind: opts.kind
                });
                const lines = [
                    `[${data.genre}/${data.kind}] ${data.total} asset(s)` +
                        (opts.limit != null ? ` (showing ${data.creatures.length})` : ''),
                    ...data.creatures.map((c) => {
                        const when = c.mtime || c.createdAt || '—';
                        const alpha = c.present?.alpha ? 'α' : '-';
                        return `  ${when}  ${alpha}  ${c.id}  (${c.technical})`;
                    })
                ];
                emit(opts, data, lines);
                break;
            }
            case 'genres': {
                const data = listGenresSummary({ kind: opts.kind });
                const lines = data.genres.map(
                    (g) => `  ${g.id.padEnd(22)} ${String(g.total).padStart(4)} total  ${String(g.withOriginal).padStart(4)} with original  ${g.label}`
                );
                emit(opts, data, [`Genres (kind=${data.kind}):`, ...lines]);
                break;
            }
            case 'remove': {
                if (!opts.id) throw new Error('--id is required for remove');
                const data = removeCreature(opts.genre, opts.id, {
                    dryRun: opts.dryRun,
                    keepDone: opts.keepDone,
                    kind: opts.kind
                });
                emit(opts, data, [
                    `${opts.dryRun ? 'Would remove' : 'Removed'} ${data.id} (${data.technical})`,
                    `  deleted ${data.deleted.length} file(s)`
                ]);
                break;
            }
            case 'rename': {
                if (!opts.id) throw new Error('--id is required for rename');
                if (!opts.name) throw new Error('--name is required for rename');
                const data = renameCreature(opts.genre, opts.id, opts.name, {
                    dryRun: opts.dryRun,
                    alias: opts.alias,
                    kind: opts.kind
                });
                emit(opts, data, [
                    `${opts.dryRun ? 'Would rename' : 'Renamed'} ${data.from.id} → ${data.to.id}`,
                    `  ${data.from.technical} → ${data.to.technical}`,
                    `  files: ${data.renamed.length}`
                ]);
                break;
            }
            case 'flip': {
                if (!opts.id) throw new Error('--id is required for flip');
                const data = flipCreatureHorizontal(opts.genre, opts.id, {
                    dryRun: opts.dryRun,
                    kind: opts.kind
                });
                emit(opts, data, [
                    `${opts.dryRun ? 'Would flip' : 'Flipped'} ${data.id} (${data.stem})`,
                    `  original: ${data.original}`
                ]);
                break;
            }
            case 'replace': {
                if (!opts.id) throw new Error('--id is required for replace');
                if (!opts.file) throw new Error('--file is required for replace');
                const data = replaceCreatureOriginal(opts.genre, opts.id, opts.file, {
                    dryRun: opts.dryRun,
                    kind: opts.kind
                });
                emit(opts, data, [
                    `${opts.dryRun ? 'Would replace' : 'Replaced'} ${data.id} (${data.stem})`,
                    `  original: ${data.original}`,
                    `  from: ${opts.file}`
                ]);
                break;
            }
            case 'opaque': {
                if (!opts.id) throw new Error('--id is required for opaque');
                if (opts.value == null) {
                    throw new Error('--value true|false is required for opaque');
                }
                const v = String(opts.value).toLowerCase();
                if (v !== 'true' && v !== 'false' && v !== '1' && v !== '0') {
                    throw new Error('--value must be true or false');
                }
                const opaqueAlpha = v === 'true' || v === '1';
                const data = setOpaqueAlpha(opts.genre, opts.id, opaqueAlpha, {
                    dryRun: opts.dryRun,
                    kind: opts.kind
                });
                emit(opts, data, [
                    `${opts.dryRun ? 'Would set' : 'Set'} opaqueAlpha=${data.opaqueAlpha} for ${data.id}`,
                    data.reprocessed
                        ? '  reprocessed stem'
                        : '  catalog only (no original on disk)'
                ]);
                break;
            }
            case 'reprocess':
            case 'regen': {
                if (!opts.id) throw new Error('--id is required for reprocess');
                const data = reprocessCreature(opts.genre, opts.id, {
                    dryRun: opts.dryRun,
                    kind: opts.kind
                });
                emit(opts, data, [
                    `${opts.dryRun ? 'Would reprocess' : 'Reprocessed'} ${data.id} (${data.stem})`,
                    `  opaqueAlpha=${data.opaqueAlpha}`,
                    `  original: ${data.original}`
                ]);
                break;
            }
            case 'fix-green':
            case 'fix_green': {
                if (!opts.id) throw new Error('--id is required for fix-green');
                const data = fixGreenCreature(opts.genre, opts.id, {
                    dryRun: opts.dryRun,
                    kind: opts.kind
                });
                emit(opts, data, [
                    `${opts.dryRun ? 'Would fix-green' : 'Fix-green'} ${data.id} (${data.stem})`,
                    `  pixelsFixed=${data.pixelsFixed}`,
                    `  original: ${data.original}`
                ]);
                break;
            }
            default:
                throw new Error(`Unknown command: ${opts.command}`);
        }
    } catch (err) {
        if (opts.json) {
            process.stdout.write(
                JSON.stringify({ ok: false, error: String(err.message || err) }) + '\n'
            );
        } else {
            console.error(`Error: ${err.message || err}`);
        }
        process.exit(1);
    }
}

main();
