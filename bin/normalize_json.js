#!/usr/bin/env node
/**
 * Reformat git-tracked JSON to the canonical pretty form (4-space + trailing \\n).
 * Use after tooling mixed 2-space / escaped-unicode files so future diffs stay semantic.
 *
 *   node bin/normalize_json.js                  # dry-run under presets/
 *   node bin/normalize_json.js --apply          # write changes
 *   node bin/normalize_json.js --apply presets/standard/biomes
 *   node bin/normalize_json.js --apply assets/data
 *
 * Does not sort keys. Parse + re-emit only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { reformatJsonText } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOTS = ['presets', 'assets/data'];

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const args = argv.slice(2);
    const apply = args.includes('--apply');
    const paths = args.filter((a) => a !== '--apply' && !a.startsWith('--'));
    return {
        apply,
        roots: paths.length ? paths : DEFAULT_ROOTS
    };
}

/**
 * @param {string} dir
 * @param {(abs: string) => void} visit
 */
function walkJson(dir, visit) {
    if (!fs.existsSync(dir)) return;
    const st = fs.statSync(dir);
    if (st.isFile()) {
        if (dir.endsWith('.json')) visit(dir);
        return;
    }
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git' || name === 'other') continue;
        walkJson(path.join(dir, name), visit);
    }
}

function main() {
    const { apply, roots } = parseArgs(process.argv);
    let scanned = 0;
    let changed = 0;
    /** @type {string[]} */
    const samples = [];

    for (const rel of roots) {
        const absRoot = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
        walkJson(absRoot, (abs) => {
            scanned++;
            let raw;
            try {
                raw = fs.readFileSync(abs, 'utf8');
            } catch {
                return;
            }
            let next;
            try {
                next = reformatJsonText(raw);
            } catch (e) {
                console.error(`skip invalid JSON: ${path.relative(ROOT, abs)} (${e.message})`);
                return;
            }
            if (next === raw) return;
            changed++;
            if (samples.length < 12) samples.push(path.relative(ROOT, abs));
            if (apply) {
                fs.writeFileSync(abs, next, 'utf8');
            }
        });
    }

    console.log(
        `${apply ? 'Applied' : 'Dry-run'}: ${changed} / ${scanned} files need canonical format`
    );
    if (samples.length) {
        console.log('Examples:');
        for (const s of samples) console.log(`  ${s}`);
    }
    if (!apply && changed > 0) {
        console.log('Re-run with --apply to write.');
    }
}

main();
