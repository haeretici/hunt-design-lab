#!/usr/bin/env node
/**
 * Populate spell.damageAmplitude for melee_strike / magic_strike from legacy
 * min/max spread vs option-B mean at a fixed reference loadout.
 *
 * Reference (docs/09):
 *   character level 100, skill 50 (magic or melee), atk 50 (melee only)
 *
 *   a = (legacyMax - legacyMin) / (2 * meanB)   // half-width fraction
 *
 * Usage:
 *   node bin/populate_spell_amplitude.js              # dry-run standard
 *   node bin/populate_spell_amplitude.js --apply      # write presets
 *   node bin/populate_spell_amplitude.js --file path  # custom catalog
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
    computeLegacyMagicStrikeRange,
    computeLegacyMeleeStrikeRange,
    computeMagicMean,
    computeMeleeMean,
    amplitudeFromLegacySpread
} = require('../kernel/core/lib/combat/damage.js');

/** Character level for levelBonus (not skill). */
const REF_LEVEL = 100;
/** Skill level reference (magic or melee skill). */
const REF_SKILL = 50;
/** Weapon atk reference for melee strikes. */
const REF_ATK = 50;

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILES = [
    path.join(ROOT, 'presets/standard/spells.json')
];

function parseArgs(argv) {
    const out = { apply: false, files: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--file' && argv[i + 1]) {
            out.files.push(path.resolve(argv[++i]));
        } else if (a === '--help' || a === '-h') {
            out.help = true;
        }
    }
    if (!out.files.length) out.files = DEFAULT_FILES.slice();
    return out;
}

/**
 * @param {object} spell
 * @returns {{ amplitude: number, legacy: {min:number,max:number}, mean: number }|null}
 */
function computeSpellAmplitude(spell) {
    const curve = spell.powerCurve;
    const bp = spell.basePower;
    if (curve !== 'magic_strike' && curve !== 'melee_strike') return null;
    if (bp == null) return null;

    if (curve === 'magic_strike') {
        const attacker = { level: REF_LEVEL, magic: REF_SKILL };
        const legacy = computeLegacyMagicStrikeRange(attacker, bp);
        const mean = computeMagicMean(attacker, bp);
        const amplitude = amplitudeFromLegacySpread(
            legacy.min,
            legacy.max,
            mean
        );
        return { amplitude, legacy, mean };
    }

    const attacker = { level: REF_LEVEL, skill: REF_SKILL, atk: REF_ATK };
    const legacy = computeLegacyMeleeStrikeRange(attacker, bp);
    const mean = computeMeleeMean(attacker, bp);
    const amplitude = amplitudeFromLegacySpread(legacy.min, legacy.max, mean);
    return { amplitude, legacy, mean };
}

function processFile(filePath, apply) {
    if (!fs.existsSync(filePath)) {
        console.warn('skip missing', filePath);
        return { updated: 0, skipped: 0 };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const doc = JSON.parse(raw);
    const spells = Array.isArray(doc.spells) ? doc.spells : null;
    if (!spells) {
        console.warn('no spells[] in', filePath);
        return { updated: 0, skipped: 0 };
    }

    let updated = 0;
    let skipped = 0;
    const rows = [];

    for (const spell of spells) {
        if (!spell || !spell.id) {
            skipped++;
            continue;
        }
        const result = computeSpellAmplitude(spell);
        if (!result) {
            skipped++;
            continue;
        }
        const prev = spell.damageAmplitude;
        spell.damageAmplitude = result.amplitude;
        updated++;
        rows.push({
            id: spell.id,
            curve: spell.powerCurve,
            bp: spell.basePower,
            amplitude: result.amplitude,
            prev: prev != null ? prev : null,
            legacy: result.legacy,
            mean: Math.round(result.mean * 100) / 100
        });
    }

    console.log(
        `\n${path.relative(ROOT, filePath)}: ${updated} strikes, ${skipped} skipped`
    );
    for (const r of rows) {
        console.log(
            `  ${r.id}  ${r.curve} bp=${r.bp}  a=${r.amplitude}` +
                `  legacy=${r.legacy.min}-${r.legacy.max} meanB≈${r.mean}` +
                (r.prev != null && r.prev !== r.amplitude
                    ? `  (was ${r.prev})`
                    : '')
        );
    }

    if (apply && updated > 0) {
        // Preserve readable formatting similar to existing packs.
        fs.writeFileSync(
            filePath,
            JSON.stringify(doc, null, 4) + '\n',
            'utf8'
        );
        console.log(`  wrote ${filePath}`);
    }

    return { updated, skipped };
}

function main() {
    const args = parseArgs(process.argv);
    if (args.help) {
        console.log(
            'Usage: node bin/populate_spell_amplitude.js [--apply] [--file path]\n' +
                `Ref loadout: level=${REF_LEVEL}, skill=${REF_SKILL}, atk=${REF_ATK}`
        );
        process.exit(0);
    }

    console.log(
        `Reference loadout: level=${REF_LEVEL}, skill=${REF_SKILL}, atk=${REF_ATK}` +
            (args.apply ? '  [APPLY]' : '  [dry-run]')
    );

    let total = 0;
    for (const f of args.files) {
        total += processFile(f, args.apply).updated;
    }
    console.log(
        `\nDone. ${total} spell(s) ${args.apply ? 'updated' : 'would update'}.`
    );
    if (!args.apply && total > 0) {
        console.log('Re-run with --apply to write files.');
    }
}

main();
