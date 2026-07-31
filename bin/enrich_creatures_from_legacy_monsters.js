#!/usr/bin/env node
/**
 * Enrich presets/standard/creatures with metadata from legacy/monsters.json,
 * using other/content_maps/legacy_to_standard_names.csv for identity + summon names.
 *
 * Updates (only these fields; combat kits / levels / art stay intact):
 *   - bestiary (all Bestiary keys except Locations)
 *   - strategiesTarget
 *   - canBlock (from flags.isBlockable)
 *   - manaCost
 *   - flags: summonable, attackable, hostile, convinceable, pushable, rewardBoss,
 *            illusionable, canPushItems, canPushCreatures, healthHidden,
 *            canWalkOnEnergy, canWalkOnFire, canWalkOnPoison
 *            (+ refreshes targetDistance / runHealth / staticAttackChance when present)
 *   - summon (maxSummons + summons[]; names/ids mapped via CSV;
 *     unmapped summon names are omitted)
 *
 * Hand-authored: dummy, venom_spitter (skipped).
 *
 *   node bin/enrich_creatures_from_legacy_monsters.js
 *   node bin/enrich_creatures_from_legacy_monsters.js --dry-run
 *   node bin/enrich_creatures_from_legacy_monsters.js --quiet
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');
const {
    applyLegacyMonsterMetadata
} = require('../kernel/core/lib/content/legacy_monster_port.js');

const ROOT = path.resolve(__dirname, '..');
const STANDARD_DIR = path.join(ROOT, 'presets', 'standard', 'creatures');
const MONSTERS_PATH = path.join(ROOT, 'legacy', 'monsters.json');

function resolveNameCsv() {
    const cands = [
        path.join(ROOT, 'other', 'content_maps', 'legacy_to_standard_names.csv'),
        path.join(ROOT, 'other', 'legacy_to_standard_names.csv')
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    return cands[0];
}

const CSV_PATH = resolveNameCsv();

/** Never overwrite these standard ids (hand-authored). */
const PRESERVE_IDS = new Set(['dummy', 'venom_spitter']);

function parseArgs(argv) {
    const opts = { dryRun: false, quiet: false };
    for (const a of argv) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/enrich_creatures_from_legacy_monsters.js [options]
  --dry-run   Report only (no writes)
  --quiet     Less logging`);
            process.exit(0);
        }
    }
    return opts;
}

/** Minimal CSV line parser for quoted fields. */
function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQ = false;
                }
            } else {
                cur += ch;
            }
        } else if (ch === '"') {
            inQ = true;
        } else if (ch === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

/**
 * @param {string} text
 * @returns {{ legacyName: string, standardName: string, standardId: string }[]}
 */
function parseNameMapCsv(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCsvLine(line);
        if (cols.length < 3) continue;
        rows.push({
            legacyName: cols[0],
            standardName: cols[1],
            standardId: cols[2]
        });
    }
    return rows;
}

function normKey(a) {
    return String(a || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

/**
 * @param {{ legacyName: string, standardName: string, standardId: string }[]} rows
 * @returns {Map<string, { standardName: string, standardId: string }>}
 */
function buildLegacyLookup(rows) {
    /** @type {Map<string, { standardName: string, standardId: string }>} */
    const map = new Map();
    for (const r of rows) {
        const key = normKey(r.legacyName);
        if (!key) continue;
        if (!map.has(key)) {
            map.set(key, {
                standardName: r.standardName,
                standardId: r.standardId
            });
        }
    }
    return map;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const log = opts.quiet ? () => {} : (...a) => console.log(...a);

    if (!fs.existsSync(MONSTERS_PATH)) {
        console.error(`Missing ${MONSTERS_PATH}`);
        process.exit(1);
    }
    if (!fs.existsSync(CSV_PATH)) {
        console.error(`Missing ${CSV_PATH}`);
        process.exit(1);
    }
    if (!fs.existsSync(STANDARD_DIR)) {
        console.error(`Missing ${STANDARD_DIR}`);
        process.exit(1);
    }

    const rows = parseNameMapCsv(fs.readFileSync(CSV_PATH, 'utf8'));
    const nameMap = buildLegacyLookup(rows);
    log(`Name map: ${nameMap.size} legacy → standard ids (${path.relative(ROOT, CSV_PATH)})`);

    /** @type {object[]} */
    const monsters = JSON.parse(fs.readFileSync(MONSTERS_PATH, 'utf8'));
    if (!Array.isArray(monsters)) {
        console.error('legacy/monsters.json must be an array');
        process.exit(1);
    }
    log(`Legacy monsters: ${monsters.length}`);

    let updated = 0;
    let unchanged = 0;
    let skippedNoMap = 0;
    let skippedMissingFile = 0;
    let skippedPreserve = 0;
    let withSummon = 0;
    let withBestiary = 0;
    let withMana = 0;
    let canBlockTrue = 0;
    /** @type {string[]} */
    const unmappedSummons = [];
    /** @type {string[]} */
    const samples = [];

    // Collapse dump rows onto unique standard ids (last wins). The dump has
    // duplicate display names (butterfly, wasp, …) with slightly different
    // rows; writing every row would thrash the same file and break idempotency.
    /** @type {Map<string, { mon: object, identity: { standardName: string, standardId: string } }>} */
    const byStandardId = new Map();
    for (let i = 0; i < monsters.length; i++) {
        const mon = monsters[i];
        if (!mon || mon.name == null) {
            skippedNoMap += 1;
            continue;
        }
        const identity = nameMap.get(normKey(mon.name));
        if (!identity || !identity.standardId) {
            skippedNoMap += 1;
            continue;
        }
        const standardId = String(identity.standardId).trim();
        if (PRESERVE_IDS.has(standardId)) {
            skippedPreserve += 1;
            continue;
        }
        byStandardId.set(standardId, { mon, identity });
    }

    for (const [standardId, { mon, identity }] of byStandardId) {
        const filePath = path.join(STANDARD_DIR, `${standardId}.json`);
        if (!fs.existsSync(filePath)) {
            skippedMissingFile += 1;
            continue;
        }

        let template;
        try {
            template = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (e) {
            console.error(`  ! parse fail ${standardId}: ${e.message || e}`);
            continue;
        }
        if (!template || typeof template !== 'object') continue;

        const before = formatJson(template);
        applyLegacyMonsterMetadata(template, mon, { nameMap });
        // Standard pack owns commercial id/label; never rewrite from legacy dump name.
        if (template.id !== standardId) template.id = standardId;

        if (template.summon) {
            withSummon += 1;
        }
        // Report dump summon names dropped because they have no CSV identity.
        const rawList =
            mon.summon && Array.isArray(mon.summon.summons)
                ? mon.summon.summons
                : [];
        for (const raw of rawList) {
            if (!raw || raw.name == null) continue;
            if (!nameMap.has(normKey(raw.name))) {
                unmappedSummons.push(
                    `${standardId}: dropped "${raw.name}" (no CSV row)`
                );
            }
        }
        if (template.bestiary) withBestiary += 1;
        if (template.manaCost != null) withMana += 1;
        if (template.canBlock) canBlockTrue += 1;

        const after = formatJson(template);
        if (before === after) {
            unchanged += 1;
            continue;
        }
        updated += 1;
        if (samples.length < 8) {
            samples.push(
                `${standardId} (legacy: ${mon.name})` +
                    (template.bestiary
                        ? ` bestiary=${template.bestiary.class}`
                        : '') +
                    (template.summon
                        ? ` summons=${template.summon.summons.length}`
                        : '') +
                    (template.manaCost ? ` mana=${template.manaCost}` : '') +
                    (template.canBlock ? ' canBlock' : '')
            );
        }
        if (!opts.dryRun) {
            fs.writeFileSync(filePath, after, 'utf8');
        }
    }

    log('');
    log(
        opts.dryRun
            ? `Dry-run: would update ${updated} creatures (${unchanged} already current)`
            : `Updated ${updated} creatures (${unchanged} already current)`
    );
    log(`  bestiary set: ${withBestiary}`);
    log(`  manaCost set: ${withMana}`);
    log(`  canBlock true: ${canBlockTrue}`);
    log(`  with summon: ${withSummon}`);
    log(`  skipped (no CSV map): ${skippedNoMap}`);
    log(`  skipped (missing standard file): ${skippedMissingFile}`);
    log(`  skipped (preserve): ${skippedPreserve}`);
    if (samples.length) {
        log('  samples:');
        for (const s of samples) log(`    - ${s}`);
    }
    if (unmappedSummons.length) {
        const unique = [...new Set(unmappedSummons)].sort();
        log(`  dropped unmapped summon rows (${unique.length}):`);
        for (const s of unique.slice(0, 20)) log(`    - ${s}`);
        if (unique.length > 20) log(`    … +${unique.length - 20} more`);
    }
}

main();
