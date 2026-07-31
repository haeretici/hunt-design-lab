#!/usr/bin/env node
/**
 * Phase 3: rebuild presets/standard/equipment.json from normalized legacy
 * equipment + other/content_maps/equipment_map.csv (commercial-safe ids/labels).
 *
 *   node bin/map_standard_equipment.js
 *   node bin/map_standard_equipment.js --dry-run
 *   node bin/map_standard_equipment.js --write-csv   # also rewrite the CSV
 *   node bin/map_standard_equipment.js --no-write-csv
 *
 * Sources:
 *   presets/legacy/equipment.json
 *   other/content_maps/equipment_map.csv  (fallback: root equipment_map.csv)
 * Dest:
 *   presets/standard/equipment.json
 *   other/content_maps/equipment_map.csv (only with --write-csv, default on)
 *
 * Identity rewrite (copy-fingerprint surface):
 *   Every standard item gets `id` + `label` exclusively from CSV
 *   `standard_id` / `standard_label` (or sanitize fallback). Legacy ids/labels
 *   and other name fingerprint keys are never left on standard items.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_PATH = path.join(ROOT, 'presets', 'legacy', 'equipment.json');
const STANDARD_PATH = path.join(ROOT, 'presets', 'standard', 'equipment.json');
const CSV_CANDIDATES = [
    path.join(ROOT, 'other', 'content_maps', 'equipment_map.csv'),
    path.join(ROOT, 'other', 'equipment_map.csv'),
    path.join(ROOT, 'equipment_map.csv')
];

const {
    parseEquipmentMapCsv,
    formatEquipmentMapCsv,
    mapLegacyEquipmentToStandard
} = require('../kernel/core/lib/content/legacy_monster_port.js');

function resolveCsvPath() {
    for (let i = 0; i < CSV_CANDIDATES.length; i++) {
        if (fs.existsSync(CSV_CANDIDATES[i])) return CSV_CANDIDATES[i];
    }
    return CSV_CANDIDATES[0];
}

function parseArgs(argv) {
    const opts = { dryRun: false, writeCsv: true, quiet: false };
    for (const a of argv) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--no-write-csv') opts.writeCsv = false;
        else if (a === '--write-csv') opts.writeCsv = true;
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/map_standard_equipment.js [options]
  --dry-run         Report only (no writes)
  --write-csv       Rewrite equipment_map.csv to match output (default)
  --no-write-csv    Leave equipment_map.csv unchanged
  --quiet           Less logging

CSV path: other/content_maps/equipment_map.csv (preferred) or root equipment_map.csv.
Standard items always receive commercial-safe id + label from the map.`);
            process.exit(0);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(LEGACY_PATH)) {
        console.error(`Missing ${LEGACY_PATH} — expected presets/legacy/equipment.json`);
        console.error('Restore with: git checkout legacy -- presets/legacy (historical pack lives on the legacy branch).');
        process.exit(1);
    }
    const csvPath = resolveCsvPath();
    if (!fs.existsSync(csvPath)) {
        console.error(`Missing equipment map CSV (tried ${CSV_CANDIDATES.join(', ')})`);
        process.exit(1);
    }

    const legacyDoc = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
    const legacyItems = Array.isArray(legacyDoc.items) ? legacyDoc.items : [];
    const mapRows = parseEquipmentMapCsv(fs.readFileSync(csvPath, 'utf8'));

    const result = mapLegacyEquipmentToStandard(legacyItems, mapRows);
    const withSpeed = result.items.filter((it) => it.speed != null).length;
    const withDuration = result.items.filter((it) => it.durationSec != null).length;
    const withSkills = result.items.filter((it) => it.skillBonuses).length;
    const withResists = result.items.filter((it) => it.resists).length;

    // Identity rewrite stats: how many items left the legacy id/label behind.
    let idRemapped = 0;
    let labelRemapped = 0;
    const byLegacyId = new Map();
    for (let i = 0; i < legacyItems.length; i++) {
        const leg = legacyItems[i];
        if (leg && leg.id != null) byLegacyId.set(String(leg.id), leg);
    }
    for (let i = 0; i < result.mapRows.length; i++) {
        const row = result.mapRows[i];
        const leg = byLegacyId.get(row.legacy_id);
        if (!leg) continue;
        if (String(leg.id) !== String(row.standard_id)) idRemapped++;
        if (String(leg.label || '') !== String(row.standard_label || '')) labelRemapped++;
    }

    if (!opts.quiet) {
        console.log('map standard equipment');
        console.log(`  csv:           ${path.relative(ROOT, csvPath)}`);
        console.log(`  legacy items:  ${legacyItems.length}`);
        console.log(`  csv rows in:   ${mapRows.length}`);
        console.log(
            `  standard out:  ${result.stats.total} (fromMap=${result.stats.fromMap}, ` +
                `generated=${result.stats.generated}, remappedLegacyIds=${result.stats.remappedLegacyIds})`
        );
        console.log(
            `  identity:      id remapped=${idRemapped}, label remapped=${labelRemapped} ` +
                `(standard items always set id+label from map; never keep legacy identity)`
        );
        console.log(
            `  fields:        speed=${withSpeed}, durationSec=${withDuration}, ` +
                `skillBonuses=${withSkills}, resists=${withResists}`
        );
    }

    const standardDoc = {
        version: 2,
        notes:
            'Standard mode equipment: combat fields from presets/legacy/equipment.json ' +
            '(normalized v1∪v2); id and label exclusively from other/content_maps/equipment_map.csv ' +
            '(commercial-safe standard_id / standard_label).',
        items: result.items
    };

    if (opts.dryRun) {
        if (!opts.quiet) console.log('  dry-run: no files written');
        return;
    }

    fs.writeFileSync(STANDARD_PATH, formatJson(standardDoc), 'utf8');
    if (!opts.quiet) console.log(`  wrote ${path.relative(ROOT, STANDARD_PATH)}`);

    if (opts.writeCsv) {
        // Prefer writing next to the source CSV we read (other/ when present).
        fs.writeFileSync(csvPath, formatEquipmentMapCsv(result.mapRows), 'utf8');
        if (!opts.quiet) {
            console.log(
                `  wrote ${path.relative(ROOT, csvPath)} (${result.mapRows.length} rows)`
            );
        }
    }
}

main();
