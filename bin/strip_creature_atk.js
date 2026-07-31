#!/usr/bin/env node
/**
 * Strip dead top-level fields from creature preset JSON (Phase 4.x).
 *
 * Monster offense / stand-off use:
 *   - attacks[] min/max
 *   - flags.targetDistance
 *
 * Removed keys (when present):
 *   atk, skill, autoAttack, attackRange, magic
 *
 * Does not touch: level, attacks, flags, armor, resists, exp, lootValue,
 * port metadata (race, bestiary, loot, changeTarget, immunities),
 * equipment / classes (player still uses atk / magic skill).
 *
 * Usage:
 *   node bin/strip_creature_atk.js              # dry-run
 *   node bin/strip_creature_atk.js --apply      # write files
 *   node bin/strip_creature_atk.js --mode standard --apply
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const MODES = ['standard', 'legacy'];

/** @type {readonly string[]} */
const STRIP_KEYS = Object.freeze([
    'atk',
    'skill',
    'autoAttack',
    'attackRange',
    'magic'
]);

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ apply: boolean, modes: string[] }} */
    const opts = { apply: false, modes: MODES.slice() };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') opts.apply = true;
        else if (a === '--mode' && argv[i + 1]) {
            opts.modes = [String(argv[++i])];
        } else if (a === '--help' || a === '-h') {
            console.log(`Strip dead creature template fields (Phase 4.x).

Usage:
  node bin/strip_creature_atk.js [--mode standard|legacy] [--apply]

Keys removed: ${STRIP_KEYS.join(', ')}
Monster offense is attacks[] only; magic skill is player-only.
Without --apply, reports how many files would change.`);
            process.exit(0);
        }
    }
    return opts;
}

/**
 * @param {object} data
 * @returns {{ removed: string[], changed: boolean }}
 */
function stripFields(data) {
    /** @type {string[]} */
    const removed = [];
    for (let i = 0; i < STRIP_KEYS.length; i++) {
        const k = STRIP_KEYS[i];
        if (Object.prototype.hasOwnProperty.call(data, k)) {
            delete data[k];
            removed.push(k);
        }
    }
    return { removed, changed: removed.length > 0 };
}

/**
 * @param {string} mode
 * @param {boolean} apply
 */
function stripMode(mode, apply) {
    const dir = path.join(ROOT, 'presets', mode, 'creatures');
    if (!fs.existsSync(dir)) {
        console.warn(`  skip missing dir ${path.relative(ROOT, dir)}`);
        return {
            mode,
            total: 0,
            changed: 0,
            keyHits: Object.create(null)
        };
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    let changed = 0;
    /** @type {Record<string, number>} */
    const keyHits = Object.create(null);
    for (let i = 0; i < STRIP_KEYS.length; i++) keyHits[STRIP_KEYS[i]] = 0;

    for (const file of files) {
        const abs = path.join(dir, file);
        let raw;
        try {
            raw = fs.readFileSync(abs, 'utf8');
        } catch (_) {
            continue;
        }
        let data;
        try {
            data = JSON.parse(raw);
        } catch (_) {
            console.warn(`  skip invalid JSON ${path.relative(ROOT, abs)}`);
            continue;
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
        const result = stripFields(data);
        if (!result.changed) continue;
        for (let i = 0; i < result.removed.length; i++) {
            keyHits[result.removed[i]] =
                (keyHits[result.removed[i]] || 0) + 1;
        }
        changed += 1;
        if (apply) {
            const out = formatJson(data);
            fs.writeFileSync(abs, out, 'utf8');
            try {
                fs.chmodSync(abs, 0o664);
            } catch (_) {
                /* ignore */
            }
        }
    }
    return { mode, total: files.length, changed, keyHits };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    console.log(
        `Strip creature dead fields [${STRIP_KEYS.join(', ')}]  apply=${opts.apply}  modes=${opts.modes.join(',')}`
    );
    let totalChanged = 0;
    /** @type {Record<string, number>} */
    const totals = Object.create(null);
    for (let i = 0; i < STRIP_KEYS.length; i++) totals[STRIP_KEYS[i]] = 0;

    for (const mode of opts.modes) {
        const r = stripMode(mode, opts.apply);
        totalChanged += r.changed;
        const hitStr = STRIP_KEYS.map(
            (k) => `${k}=${r.keyHits[k] || 0}`
        ).join(' ');
        console.log(
            `  ${r.mode}: files=${r.total} ${opts.apply ? 'stripped' : 'wouldStrip'}=${r.changed}  (${hitStr})`
        );
        for (let i = 0; i < STRIP_KEYS.length; i++) {
            const k = STRIP_KEYS[i];
            totals[k] += r.keyHits[k] || 0;
        }
    }

    console.log(
        `  totals: ${STRIP_KEYS.map((k) => `${k}=${totals[k]}`).join(' ')}`
    );

    if (!opts.apply) {
        console.log(
            totalChanged
                ? `\nDry-run only. Re-run with --apply to strip ${totalChanged} file(s).`
                : '\nNo creature files have the listed dead fields.'
        );
    } else {
        console.log(`\nUpdated ${totalChanged} file(s).`);
    }
}

main();
