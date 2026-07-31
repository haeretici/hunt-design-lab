#!/usr/bin/env node
/**
 * Rebuild presets/standard/classes.json from presets/legacy/classes.json +
 * other/content_maps/vocation_map.csv (commercial-safe ids/labels).
 *
 *   node bin/map_standard_vocations.js
 *   node bin/map_standard_vocations.js --dry-run
 *   node bin/map_standard_vocations.js --no-write-csv
 *   node bin/map_standard_vocations.js --strip-legacy   # also strip legacy classes.json fingerprints
 *
 * Sources:
 *   presets/legacy/classes.json
 *   other/content_maps/vocation_map.csv
 *   other/content_maps/spell_map.csv (optional; remaps class spell book ids)
 * Dest:
 *   presets/standard/classes.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_PATH = path.join(ROOT, 'presets', 'legacy', 'classes.json');
const STANDARD_PATH = path.join(ROOT, 'presets', 'standard', 'classes.json');
function resolveMapCsv(name) {
    const cands = [
        path.join(ROOT, 'other', 'content_maps', name),
        path.join(ROOT, 'other', name)
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    return cands[0];
}
const VOCATION_CSV = resolveMapCsv('vocation_map.csv');
const SPELL_CSV = resolveMapCsv('spell_map.csv');

const {
    parseVocationMapCsv,
    formatVocationMapCsv,
    parseSpellMapCsv,
    mapLegacyClassesToStandard,
    buildSpellIdMap,
    stripClassLegacyFields
} = require('../kernel/core/lib/content/standard_catalog_map.js');

function parseArgs(argv) {
    const opts = {
        dryRun: false,
        writeCsv: true,
        stripLegacy: false,
        quiet: false
    };
    for (const a of argv) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--no-write-csv') opts.writeCsv = false;
        else if (a === '--write-csv') opts.writeCsv = true;
        else if (a === '--strip-legacy') opts.stripLegacy = true;
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/map_standard_vocations.js [options]
  --dry-run         Report only (no writes)
  --write-csv       Rewrite other/content_maps/vocation_map.csv (default)
  --no-write-csv    Leave vocation_map.csv unchanged
  --strip-legacy    Also strip vocationMap / legacyVocation from legacy classes.json
  --quiet           Less logging

CSV: other/content_maps/vocation_map.csv
  legacy_vocation,legacy_label,standard_id,standard_label`);
            process.exit(0);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!fs.existsSync(LEGACY_PATH)) {
        console.error(`Missing ${LEGACY_PATH}`);
        console.error('Restore with: git checkout legacy -- presets/legacy (historical pack lives on the legacy branch).');
        process.exit(1);
    }
    if (!fs.existsSync(VOCATION_CSV)) {
        console.error(`Missing ${VOCATION_CSV}`);
        process.exit(1);
    }

    const legacyDoc = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
    const mapRows = parseVocationMapCsv(fs.readFileSync(VOCATION_CSV, 'utf8'));

    let spellIdMap = null;
    if (fs.existsSync(SPELL_CSV)) {
        spellIdMap = buildSpellIdMap(parseSpellMapCsv(fs.readFileSync(SPELL_CSV, 'utf8')));
    }

    const result = mapLegacyClassesToStandard(legacyDoc, mapRows, { spellIdMap });

    if (!opts.quiet) {
        console.log('map standard vocations (classes)');
        console.log(`  csv:           ${path.relative(ROOT, VOCATION_CSV)}`);
        console.log(`  legacy classes:${(legacyDoc.classes || []).length}`);
        console.log(`  csv rows in:   ${mapRows.length}`);
        console.log(
            `  standard out:  ${result.stats.total} (fromMap=${result.stats.fromMap}, ` +
                `generated=${result.stats.generated})`
        );
        console.log(
            `  spell remap:   ${spellIdMap ? `${spellIdMap.size} ids from spell_map.csv` : 'none'}`
        );
    }

    if (opts.dryRun) {
        if (!opts.quiet) console.log('  dry-run: no files written');
        return;
    }

    fs.writeFileSync(STANDARD_PATH, formatJson(result.doc), 'utf8');
    if (!opts.quiet) console.log(`  wrote ${path.relative(ROOT, STANDARD_PATH)}`);

    if (opts.writeCsv) {
        fs.writeFileSync(VOCATION_CSV, formatVocationMapCsv(result.mapRows), 'utf8');
        if (!opts.quiet) console.log(`  wrote ${path.relative(ROOT, VOCATION_CSV)}`);
    }

    if (opts.stripLegacy) {
        const cleaned = stripClassLegacyFields(legacyDoc);
        if (cleaned.notes && /vocation tables/i.test(cleaned.notes)) {
            cleaned.notes =
                'Class labels for legacy mode. HP/MP level gains match classic vocation tables; ' +
                'baseHp/baseMp are the level-8 baseline (185/35). Spell ids reference ' +
                'presets/legacy/spells.json. Archetype map: other/content_maps/vocation_map.csv.';
        }
        fs.writeFileSync(LEGACY_PATH, formatJson(cleaned), 'utf8');
        if (!opts.quiet) {
            console.log(`  stripped fingerprints in ${path.relative(ROOT, LEGACY_PATH)}`);
        }
    }
}

main();
