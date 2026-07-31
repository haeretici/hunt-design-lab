#!/usr/bin/env node
/**
 * CLI for multi-genre creature name generation.
 * Uses kernel/core/lib/creature_names.js (shared with future web UI).
 *
 * Usage:
 *   node bin/generate_creature_names.js
 *   node bin/generate_creature_names.js -n 32 --genre ultra_tech
 *   node bin/generate_creature_names.js --format json --seed 42
 *   node bin/generate_creature_names.js --audit
 *   node bin/generate_creature_names.js --stats
 *   node bin/generate_creature_names.js --list-genres
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');
const {
    DEFAULT_GENRE,
    GENRES,
    genrePaths
} = require('../kernel/settings.js');
const {
    generateNames,
    parseDoneList,
    auditNames,
    listGenres,
    genreCapacityStats,
    allGenreCapacityStats,
    RESTRICTED_TERMS
} = require('../kernel/core/lib/creature_names.js');

function printHelp() {
    console.log(`Generate unique commercial-safe creature names (technical + alias).

Usage:
  node bin/generate_creature_names.js [options]

Options:
  -n, --count <n>       Number of names (default: 16)
  -g, --genre <id>      Genre id (default: ${DEFAULT_GENRE})
  --done-file <path>    Exclude list (default: assets/data/<genre>/creature_list_done.txt)
  -o, --output <path>   Write output to file
  --seed <n>            RNG seed
  --format <mode>       text | pair | json  (default: text = technical only;
                            pair = "technical | alias")
  --audit               Audit done-file(s) for restricted terms
  --audit-file <path>   Extra file to audit (repeatable; implies --audit)
  --stats               Bank sizes, alias diversity sample, max batch capacity
  --stats-sample <n>    Sample size for --stats (default: 2000)
  --list-genres         Print known genre ids
  -h, --help            Show help

Genres: ${listGenres().join(', ')}
`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        count: 16,
        genre: DEFAULT_GENRE,
        doneFile: null,
        output: null,
        seed: null,
        format: 'text',
        audit: false,
        auditFiles: /** @type {string[]} */ ([]),
        stats: false,
        statsSample: 2000,
        listGenres: false,
        help: false,
        /** When set with --stats, only this genre (else all). */
        statsGenre: null
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
            case '-n':
            case '--count':
                opts.count = parseInt(next(), 10);
                break;
            case '-g':
            case '--genre':
                opts.genre = next();
                opts.statsGenre = opts.genre;
                break;
            case '--done-file':
                opts.doneFile = next();
                break;
            case '-o':
            case '--output':
                opts.output = next();
                break;
            case '--seed':
                opts.seed = parseInt(next(), 10);
                break;
            case '--format':
                opts.format = next();
                break;
            case '--audit':
                opts.audit = true;
                break;
            case '--audit-file':
                opts.audit = true;
                opts.auditFiles.push(next());
                break;
            case '--stats':
                opts.stats = true;
                break;
            case '--stats-sample':
                opts.statsSample = parseInt(next(), 10);
                break;
            case '--list-genres':
                opts.listGenres = true;
                break;
            default:
                throw new Error(`Unknown argument: ${a}`);
        }
    }
    return opts;
}

/**
 * @param {string[]} paths
 * @returns {number} exit code
 */
function cmdAudit(paths) {
    let anyFlagged = false;
    for (const p of paths) {
        console.log(`=== Audit: ${p} ===`);
        if (!fs.existsSync(p)) {
            console.log('  (file missing or empty)\n');
            continue;
        }
        const names = [...parseDoneList(fs.readFileSync(p, 'utf8'))];
        // Also audit aliases if present
        const rawLines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const allTokens = [];
        for (const line of rawLines) {
            for (const part of line.split('\t')) {
                if (part.trim()) allTokens.push(part.trim());
            }
        }
        const { total, flagged } = auditNames(allTokens.length ? allTokens : names);
        console.log(`  Total entries checked: ${total}`);
        console.log(`  Flagged: ${flagged.length}`);
        if (flagged.length) {
            anyFlagged = true;
            const byTerm = {};
            for (const f of flagged) {
                for (const [term] of f.hits) {
                    byTerm[term] = (byTerm[term] || 0) + 1;
                }
            }
            console.log('  Restricted terms found:');
            for (const [term, n] of Object.entries(byTerm).sort((a, b) => b[1] - a[1])) {
                console.log(`    - ${term}: ${n} — ${RESTRICTED_TERMS[term] || ''}`);
            }
            console.log('  Sample:');
            for (const f of flagged.slice(0, 12)) {
                console.log(`    · ${f.name}  [${f.hits.map((h) => h[0]).join(', ')}]`);
            }
        } else {
            console.log('  All names look free for commercial use.');
        }
        console.log();
    }
    return anyFlagged ? 1 : 0;
}

/**
 * Print bank / capacity metrics (text table).
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {number} exit code
 */
function cmdStats(opts) {
    const seed = opts.seed != null ? opts.seed : 42;
    const sampleSize = opts.statsSample || 2000;

    /** @type {string[]} */
    const genreIds =
        opts.statsGenre && listGenres().includes(opts.statsGenre)
            ? [opts.statsGenre]
            : listGenres();

    /** @type {Record<string, string[]>} */
    const excludeByGenre = {};
    for (const id of genreIds) {
        const donePath = opts.doneFile && genreIds.length === 1
            ? opts.doneFile
            : genrePaths(id).doneFile;
        if (fs.existsSync(donePath)) {
            excludeByGenre[id] = [...parseDoneList(fs.readFileSync(donePath, 'utf8'))];
        } else {
            excludeByGenre[id] = [];
        }
    }

    const rows =
        genreIds.length === 1
            ? [
                  genreCapacityStats(genreIds[0], {
                      sampleSize,
                      seed,
                      exclude: excludeByGenre[genreIds[0]]
                  })
              ]
            : allGenreCapacityStats({
                  sampleSize,
                  seed,
                  excludeByGenre
              });

    console.log(
        `Name generator capacity (sample=${sampleSize}, seed=${seed}; max batch excludes done-list)\n`
    );
    console.log(
        pad('genre', 20) +
            pad('tokens', 8) +
            pad('cre', 6) +
            pad('1w%', 6) +
            pad('tech~', 8) +
            pad('alias~', 8) +
            pad('ratio', 8) +
            pad('maxN', 6) +
            'done'
    );
    console.log('-'.repeat(78));

    for (const r of rows) {
        const b = r.bank;
        const oneWordPct =
            b.creatures > 0
                ? Math.round((100 * b.singleWordCreatures) / b.creatures)
                : 0;
        console.log(
            pad(r.genre, 20) +
                pad(String(b.totalTokens), 8) +
                pad(String(b.creatures), 6) +
                pad(`${oneWordPct}%`, 6) +
                pad(String(r.uniqueTechnicalSample), 8) +
                pad(String(r.uniqueAliasSample), 8) +
                pad(String(r.aliasToTechRatio), 8) +
                pad(
                    r.maxSingleCallBatchCapped
                        ? `${r.maxSingleCallBatch}+`
                        : String(r.maxSingleCallBatch),
                    6
                ) +
                String(r.excludeSize)
        );
    }

    console.log(`
Columns:
  tokens  sum of adj+habitat+creature+role+special
  cre     creature bank size
  1w%     share of single-word creature cores
  tech~   unique technicals in sample
  alias~  unique aliases in sample (after candidate ladder)
  ratio   alias~/tech~
  maxN    largest generateNames(count) that succeeds with current done-list exclude
          (suffix + means at probe cap ≥256 — plenty of headroom for batches)
  done    exclude (done-list) size
`);
    return 0;
}

/**
 * @param {string} s
 * @param {number} w
 */
function pad(s, w) {
    const t = String(s);
    return t.length >= w ? t.slice(0, w) : t + ' '.repeat(w - t.length);
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

    if (opts.listGenres) {
        for (const id of listGenres()) {
            const g = GENRES[id];
            console.log(`${id} — ${g.label}`);
        }
        process.exit(0);
    }

    if (opts.audit) {
        const paths = opts.auditFiles.length
            ? opts.auditFiles
            : Object.keys(GENRES).map((id) => genrePaths(id).doneFile);
        process.exit(cmdAudit(paths));
    }

    if (opts.stats) {
        process.exit(cmdStats(opts));
    }

    let paths;
    try {
        paths = genrePaths(opts.genre);
    } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }

    const doneFile = opts.doneFile || paths.doneFile;
    let exclude = new Set();
    if (fs.existsSync(doneFile)) {
        exclude = parseDoneList(fs.readFileSync(doneFile, 'utf8'));
    }

    let names;
    try {
        names = generateNames({
            genre: opts.genre,
            count: opts.count,
            exclude,
            seed: opts.seed
        });
    } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }

    let text;
    if (opts.format === 'json') {
        text = formatJson(names);
    } else if (opts.format === 'pair') {
        text = names.map((n) => `${n.technical} | ${n.alias}`).join('\n') + '\n';
    } else {
        // text: technical only (back-compat with shell consumers)
        text = names.map((n) => n.technical).join('\n') + '\n';
    }

    if (opts.output) {
        fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
        fs.writeFileSync(opts.output, text, 'utf8');
        console.error(`Wrote ${names.length} names to ${opts.output}`);
    } else {
        process.stdout.write(text);
    }
}

main();
