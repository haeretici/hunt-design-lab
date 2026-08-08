#!/usr/bin/env node
/**
 * Propose skill bags for tests / new player profiles (Phase B tooling),
 * or print try-budget + training ETA (cost mode; no shop GP/TC).
 *
 *   node bin/derive_skills.js --class guardian --level 50
 *   node bin/derive_skills.js --class adept --level 90 --focus primary --format legacy
 *   node bin/derive_skills.js --class scout --level 50 --costs
 *   node bin/derive_skills.js --class guardian --level 50 --format legacy --write drafts/guardian_L50_skills.json
 *
 * Cost / exercise ETA (legacy-shaped; alleviates derive vs try-economy gap):
 *   node bin/derive_skills.js --cost --class guardian --skill sword --from 10 --to 130
 *   node bin/derive_skills.js --cost --class adept --skill magic --from 0 --to 80 --dummy
 *   node bin/derive_skills.js --cost --class scout --skill distance --from 10 --to 100 --loyalty 10
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
const {
    estimateSkillTraining,
    SKILL_FLOOR,
    MAGIC_FLOOR
} = require('../kernel/core/lib/character/progression.js');

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
        costMode: false,
        skill: 'sword',
        from: null,
        to: null,
        loyalty: 0,
        double: false,
        dummy: false,
        accuracy: 100,
        hits: 2,
        manaPerSec: 500,
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
        else if (a === '--cost') opts.costMode = true;
        else if (a === '--skill' || a === '-s') opts.skill = String(argv[++i] || 'sword');
        else if (a === '--from') opts.from = Number(argv[++i]);
        else if (a === '--to') opts.to = Number(argv[++i]);
        else if (a === '--loyalty') opts.loyalty = Number(argv[++i]) || 0;
        else if (a === '--double') opts.double = true;
        else if (a === '--dummy') opts.dummy = true;
        else if (a === '--accuracy') opts.accuracy = Number(argv[++i]) || 100;
        else if (a === '--hits') opts.hits = Number(argv[++i]) || 2;
        else if (a === '--mana-per-sec' || a === '--mana') {
            opts.manaPerSec = Number(argv[++i]) || 500;
        } else if (a === '--write' || a === '-w') opts.write = String(argv[++i] || '');
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/derive_skills.js [options]

Derive (level→skill anchors, policy v1):
  --class, -c <id>     Class id (default guardian)
  --level, -l <n>      Level (default 50)
  --focus, -f <name>   primary | hybrid | tank (default primary)
  --format <name>      engine | legacy (default engine)
  --costs              Include try/mana cost summary for derived bag
  --write, -w <path>   Write JSON to path (explicit only; no golden auto-write)
  --quiet, -q          Skills object only on stdout

Cost / training ETA (try-budget + online/offline/exercise; no shop GP/TC):
  --cost               Enable cost mode (ignores level anchors)
  --skill, -s <name>   sword|axe|club|fist|distance|shielding|magic|melee
  --from <n>           Start skill / ML (default: floor 10 or ML 0)
  --to <n>             Target skill / ML (required in --cost mode)
  --loyalty <0-50>     Loyalty bonus % on point budget
  --double             Double-skill event (halves points)
  --dummy              Exercise dummy (+10% efficiency on exercise ETA only)
  --accuracy <1-100>   Online distance hit % (default 100)
  --hits <1-2>         Online shielding hits per window (default 2)
  --mana-per-sec <n>   Online mana/s for ML (default 500)

Examples:
  node bin/derive_skills.js --class guardian --level 50 --costs
  node bin/derive_skills.js --cost --class guardian --skill sword --from 10 --to 130
  node bin/derive_skills.js --cost --class adept --skill magic --from 0 --to 80 --dummy`);
            process.exit(0);
        }
    }
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const cls = loadClass(opts.classId);

    let out;
    if (opts.costMode) {
        const skill = opts.skill || 'sword';
        const isMagic =
            String(skill).toLowerCase() === 'magic' ||
            String(skill).toLowerCase() === 'ml' ||
            String(skill).toLowerCase() === 'magiclevel';
        const from =
            opts.from != null && Number.isFinite(opts.from)
                ? opts.from
                : isMagic
                  ? MAGIC_FLOOR
                  : SKILL_FLOOR;
        if (opts.to == null || !Number.isFinite(opts.to)) {
            console.error('--cost mode requires --to <target skill or ML>');
            process.exit(1);
        }
        out = estimateSkillTraining({
            skill,
            from,
            to: opts.to,
            rates: cls.skillRates || {},
            loyalty: opts.loyalty,
            double: opts.double,
            dummy: opts.dummy,
            accuracy: opts.accuracy,
            hits: opts.hits,
            manaPerSec: opts.manaPerSec
        });
        out.classId = cls.id || opts.classId;
        if (cls.skillRates) out.skillRates = cls.skillRates;
    } else {
        const result = deriveSkills(cls, opts.level, {
            focus: opts.focus,
            format: opts.format,
            includeCosts: opts.costs,
            rates: cls.skillRates
        });
        out = opts.quiet ? result.skills : result;
    }

    const text = JSON.stringify(out, null, 4) + '\n';

    if (opts.write) {
        const abs = path.isAbsolute(opts.write)
            ? opts.write
            : path.join(ROOT, opts.write);
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
