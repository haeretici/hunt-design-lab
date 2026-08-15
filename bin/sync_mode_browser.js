#!/usr/bin/env node
/**
 * Keep mode.json browser lists in sync with folder entity ids on disk.
 *
 * Browser packs cannot directory-list over HTTP, so mode.json → browser.*
 * is the catalog index. `npm run build` / `npm run sync:mode-browser` rewrite
 * those lists when disk and the index disagree.
 *
 * Policies:
 *   mirror — every stem under presets/<mode>/<dir>/ must appear (sorted unique).
 *            creatures, dialogs, waypoints, populations.
 *   prune  — drop listed ids whose files are gone; do not add unlisted files.
 *            hunts / scenarios stay opt-in (Hunt Editor / Scenario Lab).
 *
 * Usage:
 *   node bin/sync_mode_browser.js --check [--mode standard|all|<id>]
 *   node bin/sync_mode_browser.js --write [--mode standard|all|<id>]
 *
 * --check (default as CLI): exit 1 if any list is out of sync.
 * --write: rewrite lists from disk. Used by `npm run build`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { formatJson } = require('../kernel/core/lib/json_format.js');

/**
 * @typedef {{ kind: string, dir: string, browserKey: string, policy: 'mirror'|'prune' }} BrowserIndex
 */

/**
 * Designer / mode browser indexes.
 * @type {BrowserIndex[]}
 */
const BROWSER_INDEXES = [
    { kind: 'creatures', dir: 'creatures', browserKey: 'creatures', policy: 'mirror' },
    { kind: 'dialogs', dir: 'dialogs', browserKey: 'dialogs', policy: 'mirror' },
    { kind: 'waypoints', dir: 'waypoints', browserKey: 'waypoints', policy: 'mirror' },
    { kind: 'populations', dir: 'populations', browserKey: 'populations', policy: 'mirror' },
    { kind: 'hunts', dir: 'hunts', browserKey: 'hunts', policy: 'prune' },
    { kind: 'scenarios', dir: 'scenarios', browserKey: 'scenarios', policy: 'prune' }
];

/** @deprecated use BROWSER_INDEXES — kept for callers that filtered full-mirrors */
const FULL_MIRRORS = BROWSER_INDEXES.filter((e) => e.policy === 'mirror');

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    let mode = 'standard';
    let write = false;
    let check = false;
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--write' || a === '--fix') write = true;
        else if (a === '--check') check = true;
        else if (a === '--mode' && argv[i + 1]) mode = argv[++i];
        else if (a === '--help' || a === '-h') {
            console.log(`Usage:
  node bin/sync_mode_browser.js --check [--mode standard|all|<id>]
  node bin/sync_mode_browser.js --write [--mode standard|all|<id>]

Default action is --check when neither flag is set.
--write is what \`npm run build\` / \`npm run sync:mode-browser\` run.`);
            process.exit(0);
        }
    }
    if (!write && !check) check = true;
    if (write && check) {
        // Write wins if both given after repair+verify pattern.
        check = false;
    }
    return { mode, write, check };
}

/**
 * @param {string} [root]
 * @returns {string[]}
 */
function listModes(root) {
    const presetsDir = path.join(root || ROOT, 'presets');
    if (!fs.existsSync(presetsDir)) return [];
    return fs
        .readdirSync(presetsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .filter((d) =>
            fs.existsSync(path.join(presetsDir, d.name, 'mode.json'))
        )
        .map((d) => d.name)
        .sort();
}

/**
 * @param {string} modeId
 * @param {string} dirRel
 * @param {string} [root]
 * @returns {string[]}
 */
function listFolderStems(modeId, dirRel, root) {
    const dir = path.join(root || ROOT, 'presets', modeId, dirRel);
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5).toLowerCase())
        .filter((id) => id.length > 0)
        .sort();
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeIdList(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (typeof item !== 'string' || item.trim() === '') continue;
        const id = item.trim().toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * Sorted unique copy (mirror lists).
 * @param {string[]} ids
 * @returns {string[]}
 */
function sortedUnique(ids) {
    return normalizeIdList(ids).slice().sort();
}

/**
 * @param {string} modeId
 * @param {{ write: boolean }} opts
 * @param {string} [root]
 * @returns {{ mode: string, ok: boolean, changes: string[] }}
 */
function processMode(modeId, opts, root) {
    const base = root || ROOT;
    const modePath = path.join(base, 'presets', modeId, 'mode.json');
    if (!fs.existsSync(modePath)) {
        return { mode: modeId, ok: false, changes: [`missing mode.json`] };
    }
    const data = JSON.parse(fs.readFileSync(modePath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { mode: modeId, ok: false, changes: [`invalid mode.json`] };
    }
    if (!data.browser || typeof data.browser !== 'object') {
        data.browser = {};
    }

    /** @type {string[]} */
    const changes = [];
    let dirty = false;

    for (const index of BROWSER_INDEXES) {
        const disk = listFolderStems(modeId, index.dir, base);
        const listed = normalizeIdList(data.browser[index.browserKey]);
        const diskSet = new Set(disk);
        const listSet = new Set(listed);
        const onlyDisk = disk.filter((id) => !listSet.has(id));
        const onlyList = listed.filter((id) => !diskSet.has(id));

        if (index.policy === 'prune') {
            if (!onlyList.length) continue;
            const bits = [
                `-${onlyList.length} in browser.${index.browserKey} missing on disk` +
                    (onlyList.length <= 8
                        ? ` (${onlyList.join(', ')})`
                        : ` (e.g. ${onlyList.slice(0, 5).join(', ')}…)`)
            ];
            changes.push(`${index.kind}: ${bits.join('; ')}`);
            if (opts.write) {
                data.browser[index.browserKey] = listed.filter((id) =>
                    diskSet.has(id)
                );
                dirty = true;
            }
            continue;
        }

        const sortedListed = listed.slice().sort();
        const orderMismatch =
            onlyDisk.length === 0 &&
            onlyList.length === 0 &&
            JSON.stringify(sortedListed) !== JSON.stringify(disk);

        if (onlyDisk.length || onlyList.length || orderMismatch) {
            const bits = [];
            if (onlyDisk.length) {
                bits.push(
                    `+${onlyDisk.length} on disk missing from browser.${index.browserKey}` +
                        (onlyDisk.length <= 8
                            ? ` (${onlyDisk.join(', ')})`
                            : ` (e.g. ${onlyDisk.slice(0, 5).join(', ')}…)`)
                );
            }
            if (onlyList.length) {
                bits.push(
                    `-${onlyList.length} in browser.${index.browserKey} missing on disk` +
                        (onlyList.length <= 8
                            ? ` (${onlyList.join(', ')})`
                            : ` (e.g. ${onlyList.slice(0, 5).join(', ')}…)`)
                );
            }
            if (orderMismatch && !onlyDisk.length && !onlyList.length) {
                bits.push(`browser.${index.browserKey} needs sort/dedupe`);
            }
            changes.push(`${index.kind}: ${bits.join('; ')}`);
            if (opts.write) {
                data.browser[index.browserKey] = disk;
                dirty = true;
            }
        }
    }

    if (opts.write && dirty) {
        fs.writeFileSync(modePath, formatJson(data));
        try {
            fs.chmodSync(modePath, 0o664);
        } catch (_) {
            /* ignore */
        }
    }

    return {
        mode: modeId,
        ok: changes.length === 0,
        changes
    };
}

function main() {
    const { mode: modeArg, write } = parseArgs(process.argv);
    const modes = modeArg === 'all' ? listModes() : [modeArg];

    let failed = 0;
    let fixed = 0;
    for (const modeId of modes) {
        const result = processMode(modeId, { write });
        if (result.ok) {
            console.log(`OK    ${modeId} browser indexes match disk`);
            continue;
        }
        if (write) {
            fixed += 1;
            console.log(`FIXED ${modeId}`);
            for (const c of result.changes) console.log(`  - ${c}`);
        } else {
            failed += 1;
            console.error(`FAIL  ${modeId}`);
            for (const c of result.changes) console.error(`  - ${c}`);
        }
    }

    if (write) {
        console.log(
            `\nSynced ${modes.length} mode(s); ${fixed} file(s) updated.`
        );
        process.exit(0);
    }

    if (failed) {
        console.error(
            `\n${failed} mode(s) out of sync. Repair with:\n  npm run sync:mode-browser`
        );
        process.exit(1);
    }
    console.log(`\nChecked ${modes.length} mode(s); all browser indexes OK.`);
    process.exit(0);
}

if (require.main === module) {
    main();
}

module.exports = {
    BROWSER_INDEXES,
    FULL_MIRRORS,
    listModes,
    listFolderStems,
    normalizeIdList,
    sortedUnique,
    processMode
};
