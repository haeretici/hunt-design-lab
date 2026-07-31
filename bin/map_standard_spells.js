#!/usr/bin/env node
/**
 * Rebuild presets/standard/spells.json from presets/legacy/spells.json +
 * other/content_maps/spell_map.csv (commercial-safe ids/labels).
 *
 *   node bin/map_standard_spells.js
 *   node bin/map_standard_spells.js --dry-run
 *   node bin/map_standard_spells.js --no-write-csv
 *   node bin/map_standard_spells.js --strip-legacy-names  # drop legacyName from legacy pack too
 *
 * Sources:
 *   presets/legacy/spells.json
 *   other/content_maps/spell_map.csv
 *   other/content_maps/vocation_map.csv (optional; remaps spell.vocations[])
 * Dest:
 *   presets/standard/spells.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_PATH = path.join(ROOT, 'presets', 'legacy', 'spells.json');
const STANDARD_PATH = path.join(ROOT, 'presets', 'standard', 'spells.json');
function resolveMapCsv(name) {
    const cands = [
        path.join(ROOT, 'other', 'content_maps', name),
        path.join(ROOT, 'other', name)
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    return cands[0];
}
const SPELL_CSV = resolveMapCsv('spell_map.csv');
const VOCATION_CSV = resolveMapCsv('vocation_map.csv');

const {
    parseSpellMapCsv,
    formatSpellMapCsv,
    parseVocationMapCsv,
    mapLegacySpellsToStandard,
    buildVocationIdMap,
    stripSpellLegacyFields
} = require('../kernel/core/lib/content/standard_catalog_map.js');

function parseArgs(argv) {
    const opts = {
        dryRun: false,
        writeCsv: true,
        stripLegacyNames: false,
        quiet: false
    };
    for (const a of argv) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--no-write-csv') opts.writeCsv = false;
        else if (a === '--write-csv') opts.writeCsv = true;
        else if (a === '--strip-legacy-names') opts.stripLegacyNames = true;
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/map_standard_spells.js [options]
  --dry-run              Report only (no writes)
  --write-csv            Rewrite other/content_maps/spell_map.csv (default)
  --no-write-csv         Leave spell_map.csv unchanged
  --strip-legacy-names   Also drop legacyName from presets/legacy/spells.json
  --quiet                Less logging

CSV: other/content_maps/spell_map.csv
  legacy_id,legacy_label,standard_id,standard_label`);
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
    if (!fs.existsSync(SPELL_CSV)) {
        console.error(`Missing ${SPELL_CSV}`);
        process.exit(1);
    }

    const legacyDoc = JSON.parse(fs.readFileSync(LEGACY_PATH, 'utf8'));
    const mapRows = parseSpellMapCsv(fs.readFileSync(SPELL_CSV, 'utf8'));

    let vocationIdMap = null;
    if (fs.existsSync(VOCATION_CSV)) {
        vocationIdMap = buildVocationIdMap(
            parseVocationMapCsv(fs.readFileSync(VOCATION_CSV, 'utf8'))
        );
    }

    const result = mapLegacySpellsToStandard(legacyDoc, mapRows, { vocationIdMap });

    if (!opts.quiet) {
        console.log('map standard spells');
        console.log(`  csv:           ${path.relative(ROOT, SPELL_CSV)}`);
        console.log(`  legacy spells: ${(legacyDoc.spells || []).length}`);
        console.log(`  csv rows in:   ${mapRows.length}`);
        console.log(
            `  standard out:  ${result.stats.total} (fromMap=${result.stats.fromMap}, ` +
                `generated=${result.stats.generated})`
        );
        const withLegacyName = (legacyDoc.spells || []).filter((s) => s && s.legacyName).length;
        console.log(`  legacyName in: ${withLegacyName} (stripped on standard output)`);
    }

    if (opts.dryRun) {
        if (!opts.quiet) console.log('  dry-run: no files written');
        return;
    }

    fs.writeFileSync(STANDARD_PATH, formatJson(result.doc), 'utf8');
    if (!opts.quiet) console.log(`  wrote ${path.relative(ROOT, STANDARD_PATH)}`);

    if (opts.writeCsv) {
        fs.writeFileSync(SPELL_CSV, formatSpellMapCsv(result.mapRows), 'utf8');
        if (!opts.quiet) console.log(`  wrote ${path.relative(ROOT, SPELL_CSV)}`);
    }

    if (opts.stripLegacyNames) {
        const cleaned = stripSpellLegacyFields(legacyDoc);
        if (cleaned.notes) {
            cleaned.notes =
                'Legacy spell book (MagicSpells / MeleeSpells / DistanceSpells lineage) ' +
                '(MagicSpells, MeleeSpells, DistanceSpells). Commercial-safe labels. ' +
                'Original name map: other/content_maps/spell_map.csv. Schema: id, element, mana, range, ' +
                'powerCurve, basePower, cooldowns (auto/primary/secondary/spell/item), moveLock, ' +
                'optional shape/rune/chain. Runes cost mana 0 (inventory not simulated).';
        }
        fs.writeFileSync(LEGACY_PATH, formatJson(cleaned), 'utf8');
        if (!opts.quiet) {
            console.log(`  stripped legacyName in ${path.relative(ROOT, LEGACY_PATH)}`);
        }
    }
}

main();
