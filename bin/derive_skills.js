#!/usr/bin/env node
/**
 * Propose skill bags for tests / new player profiles (Phase B tooling).
 *
 *   node bin/derive_skills.js --class guardian --level 50
 *   node bin/derive_skills.js --class adept --level 90 --focus primary --format legacy
 *   node bin/derive_skills.js --class scout --level 50 --costs
 *   node bin/derive_skills.js --class guardian --level 50 --format legacy --write drafts/guardian_L50_skills.json
 *
 * Does NOT auto-overwrite golden profiles under presets/.../player_profiles/.
 * --write only when the path is explicit.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
    deriveSkills
} = require('../kernel/core/lib/character/skill_derive.js');

function loadClass(classId) {
    const p = path.join(ROOT, 'presets', 'standard', 'classes.json');
    if (!fs.existsSync(p)) return { id: classId };
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = doc && Array.isArray(doc.classes) ? doc.classes : [];
    const found = list.find((c) => c && c.id === classId);
    return found || { id: classId };
}

function parseArgs(argv) {
    const opts = {
        classId: 'guardian',
        level: 50,
        focus: 'primary',
        format: 'engine',
        costs: false,
        write: null,
        quiet: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--class' || a === '-c') opts.classId = String(argv[++i] || '');
        else if (a === '--level' || a === '-l') opts.level = Number(argv[++i]) || 50;
        else if (a === '--focus' || a === '-f') opts.focus = String(argv[++i] || 'primary');
        else if (a === '--format') opts.format = String(argv[++i] || 'engine');
        else if (a === '--costs') opts.costs = true;
        else if (a === '--write' || a === '-w') opts.write = String(argv[++i] || '');
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/derive_skills.js [options]
  --class, -c <id>     Class id (default guardian)
  --level, -l <n>      Level (default 50)
  --focus, -f <name>   primary | hybrid | tank (default primary)
  --format <name>      engine | legacy (default engine)
  --costs              Include try/mana cost summary from class skillRates
  --write, -w <path>   Write JSON to path (explicit only; no golden auto-write)
  --quiet, -q          Skills object only on stdout`);
            process.exit(0);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const cls = loadClass(opts.classId);
    const result = deriveSkills(cls, opts.level, {
        focus: opts.focus,
        format: opts.format,
        includeCosts: opts.costs,
        rates: cls.skillRates
    });

    const out = opts.quiet ? result.skills : result;
    const text = JSON.stringify(out, null, 4) + '\n';

    if (opts.write) {
        const abs = path.isAbsolute(opts.write)
            ? opts.write
            : path.join(ROOT, opts.write);
        // Guard: refuse silent overwrite of golden profile files without explicit path outside? Allow any explicit path.
        const profilesDir = path.join(ROOT, 'presets', 'standard', 'player_profiles');
        if (abs.startsWith(profilesDir + path.sep) || abs === profilesDir) {
            console.error(
                'Refusing to write into presets/standard/player_profiles/ — golden profiles stay pinned. Write a draft path instead.'
            );
            process.exit(2);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, text, 'utf8');
        if (!opts.quiet) {
            console.error(`Wrote ${path.relative(ROOT, abs)}`);
        }
    }

    process.stdout.write(text);
}

main();
