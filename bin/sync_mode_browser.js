#!/usr/bin/env node
/**
 * Keep mode.json browser lists in sync with folder entity ids on disk.
 *
 * Full-mirror lists (every stem under presets/<mode>/<dir>/ must appear in
 * mode.json → browser.<key>). Browser packs cannot directory-list over HTTP.
 *
 * Currently: browser.creatures ↔ creatures/*.json
 *
 * Usage:
 *   node bin/sync_mode_browser.js --check [--mode standard|all|<id>]
 *   node bin/sync_mode_browser.js --write [--mode standard|all|<id>]
 *
 * --check (default): exit 1 if any list is out of sync.
 * --write: rewrite browser lists from disk (sorted unique).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { formatJson } = require('../kernel/core/lib/json_format.js');

/**
 * Designer / mode browser full mirrors.
 * @type {{ kind: string, dir: string, browserKey: string }[]}
 */
const FULL_MIRRORS = [
    { kind: 'creatures', dir: 'creatures', browserKey: 'creatures' },
];

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

Default action is --check when neither flag is set.`);
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
 * @returns {string[]}
 */
function listModes() {
    const presetsDir = path.join(ROOT, 'presets');
    return fs
        .readdirSync(presetsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .filter((d) => fs.existsSync(path.join(presetsDir, d.name, 'mode.json')))
        .map((d) => d.name)
        .sort();
}

/**
 * @param {string} modeId
 * @param {string} dirRel
 * @returns {string[]}
 */
function listFolderStems(modeId, dirRel) {
    const dir = path.join(ROOT, 'presets', modeId, dirRel);
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
    out.sort();
    return out;
}

/**
 * @param {string} modeId
 * @param {{ write: boolean }} opts
 * @returns {{ mode: string, ok: boolean, changes: string[] }}
 */
function processMode(modeId, opts) {
    const modePath = path.join(ROOT, 'presets', modeId, 'mode.json');
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

    for (const mirror of FULL_MIRRORS) {
        const disk = listFolderStems(modeId, mirror.dir);
        const listed = normalizeIdList(data.browser[mirror.browserKey]);
        const diskSet = new Set(disk);
        const listSet = new Set(listed);
        const onlyDisk = disk.filter((id) => !listSet.has(id));
        const onlyList = listed.filter((id) => !diskSet.has(id));
        const orderMismatch =
            onlyDisk.length === 0 &&
            onlyList.length === 0 &&
            JSON.stringify(listed) !== JSON.stringify(disk);

        if (onlyDisk.length || onlyList.length || orderMismatch) {
            const bits = [];
            if (onlyDisk.length) {
                bits.push(
                    `+${onlyDisk.length} on disk missing from browser.${mirror.browserKey}` +
                        (onlyDisk.length <= 8
                            ? ` (${onlyDisk.join(', ')})`
                            : ` (e.g. ${onlyDisk.slice(0, 5).join(', ')}…)`)
                );
            }
            if (onlyList.length) {
                bits.push(
                    `-${onlyList.length} in browser.${mirror.browserKey} missing on disk` +
                        (onlyList.length <= 8
                            ? ` (${onlyList.join(', ')})`
                            : ` (e.g. ${onlyList.slice(0, 5).join(', ')}…)`)
                );
            }
            if (orderMismatch && !onlyDisk.length && !onlyList.length) {
                bits.push(`browser.${mirror.browserKey} needs sort/dedupe`);
            }
            changes.push(`${mirror.kind}: ${bits.join('; ')}`);
            if (opts.write) {
                data.browser[mirror.browserKey] = disk;
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
        changes,
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
            console.log(`OK    ${modeId} browser full-mirror lists match disk`);
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
    console.log(`\nChecked ${modes.length} mode(s); all browser full-mirrors OK.`);
    process.exit(0);
}

main();
