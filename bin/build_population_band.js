#!/usr/bin/env node
/**
 * Build a population table by selecting creature templates in a level / threat band.
 *
 * Content campaign ([24]): activate the ranked catalog without hand-picking every id.
 * Output is a normal populations/*.json (groups + limits) — resolvePopulation unchanged.
 *
 * Selection (defaults match measure/map shell filters):
 *   - level in [levelMin, levelMax]
 *   - optional threatDps min/max
 *   - exclude hp ≤ excludeHpMax (default 1)
 *   - exclude known shells + echo_of_* / *_pulse / low-hp *_soul patterns
 *   - exclude physical resist ≥ 100 and multi-element full immunes (default on)
 *   - exclude flags.attackable === false (default on; not attackable by party)
 *   - even spread across the sorted band (seed only shuffles when --randomize)
 *
 * Usage:
 *   node bin/build_population_band.js --id cave_trash_low --level-min 1 --level-max 150
 *   node bin/build_population_band.js --id cave_mid_mixed --level-min 200 --level-max 400 --apply
 *   npm run build:population-band -- --id cave_trash_low --level-min 1 --level-max 150 --apply
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');
const { createSeededRandom } = require('../kernel/core/lib/utils.js');

const ROOT = path.resolve(__dirname, '..');

const DEFAULT_EXCLUDE_IDS = new Set([
    'energy_pulse',
    'dummy',
    'training_dummy',
    'floor_blob'
]);

/** Combat resist keys checked for physical / multi-immune filters. */
const RESIST_ELEMENTS = Object.freeze([
    'physical',
    'fire',
    'ice',
    'energy',
    'earth',
    'holy',
    'death'
]);

/** Default: ≥ this many full (100%) element resists ⇒ multi-immune shell. */
const DEFAULT_MULTI_IMMUNE_MIN = 5;

/**
 * @param {object|null|undefined} resists
 * @returns {{ physical: number, fullCount: number, fullElements: string[] }}
 */
function resistProfile(resists) {
    const r = resists && typeof resists === 'object' ? resists : {};
    /** @type {string[]} */
    const fullElements = [];
    for (let i = 0; i < RESIST_ELEMENTS.length; i++) {
        const el = RESIST_ELEMENTS[i];
        const v = Number(r[el]);
        if (Number.isFinite(v) && v >= 100) fullElements.push(el);
    }
    const physical = Number(r.physical);
    return {
        physical: Number.isFinite(physical) ? physical : 0,
        fullCount: fullElements.length,
        fullElements
    };
}

/**
 * Physical-immune and multi-element full-immune templates stall physical/holy
 * starter parties (see bugs/bug_20260730_234212 — lovely_scorpion).
 *
 * @param {object} c creature row (needs resists or resist fields)
 * @param {object} o parseArgs result
 * @returns {{ exclude: boolean, reasons: string[] }}
 */
function immuneDecision(c, o) {
    const reasons = [];
    if (o.excludeImmune === false) return { exclude: false, reasons };
    const profile = resistProfile(c.resists);
    if (profile.physical >= 100) {
        reasons.push('physical_immune');
    }
    const multiMin =
        o.multiImmuneMin != null && Number.isFinite(o.multiImmuneMin)
            ? Math.max(1, Math.floor(o.multiImmuneMin))
            : DEFAULT_MULTI_IMMUNE_MIN;
    if (profile.fullCount >= multiMin) {
        reasons.push(`multi_immune:${profile.fullCount}`);
    }
    return { exclude: reasons.length > 0, reasons };
}

/**
 * Explicit flags.attackable === false (legacy non-target props / phase shells).
 * Missing attackable is treated as attackable (port default).
 *
 * @param {object} c creature row (needs attackable or flags.attackable)
 * @param {object} o parseArgs result
 * @returns {{ exclude: boolean, reasons: string[] }}
 */
function unattackableDecision(c, o) {
    const reasons = [];
    if (o.excludeUnattackable === false) return { exclude: false, reasons };
    const flags = c.flags && typeof c.flags === 'object' ? c.flags : null;
    const attackable =
        c.attackable !== undefined
            ? c.attackable
            : flags && flags.attackable !== undefined
              ? flags.attackable
              : undefined;
    if (attackable === false) {
        reasons.push('unattackable');
    }
    return { exclude: reasons.length > 0, reasons };
}

/**
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
    const o = {
        mode: 'standard',
        id: null,
        biome: 'cave',
        label: null,
        levelMin: 1,
        levelMax: 1000,
        threatMin: 0.01,
        threatMax: null,
        count: 16,
        championCount: 4,
        eliteCount: 2,
        excludeHpMax: 1,
        excludePatterns: true,
        excludeImmune: true,
        excludeUnattackable: true,
        multiImmuneMin: DEFAULT_MULTI_IMMUNE_MIN,
        excludeIds: new Set(DEFAULT_EXCLUDE_IDS),
        seed: 42,
        randomize: false,
        totalPacks: [4, 8],
        championPacks: [1, 2],
        elitePacks: [0, 1],
        packSizeNormal: [1, 3],
        packSizeChampion: [1, 2],
        packSizeElite: [1, 1],
        weightNormal: 80,
        weightChampion: 15,
        weightElite: 5,
        apply: false,
        out: null,
        dryRun: true
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--mode') o.mode = String(next() || 'standard');
        else if (a === '--id') o.id = String(next() || '');
        else if (a === '--biome') o.biome = String(next() || 'cave');
        else if (a === '--label') o.label = String(next() || '');
        else if (a === '--level-min') o.levelMin = Number(next());
        else if (a === '--level-max') o.levelMax = Number(next());
        else if (a === '--threat-min') o.threatMin = Number(next());
        else if (a === '--threat-max') o.threatMax = Number(next());
        else if (a === '--allow-zero-threat') o.threatMin = null;
        else if (a === '--count') o.count = Math.max(1, Math.floor(Number(next()) || 16));
        else if (a === '--champion-count') {
            o.championCount = Math.max(0, Math.floor(Number(next()) || 0));
        } else if (a === '--elite-count') {
            o.eliteCount = Math.max(0, Math.floor(Number(next()) || 0));
        } else if (a === '--exclude-hp-max') {
            o.excludeHpMax = Number(next());
        } else if (a === '--no-exclude-patterns') o.excludePatterns = false;
        else if (a === '--no-exclude-immune') o.excludeImmune = false;
        else if (a === '--no-exclude-unattackable') o.excludeUnattackable = false;
        else if (a === '--multi-immune-min') {
            o.multiImmuneMin = Math.max(1, Math.floor(Number(next()) || DEFAULT_MULTI_IMMUNE_MIN));
        } else if (a === '--exclude') {
            String(next() || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .forEach((id) => o.excludeIds.add(id));
        } else if (a === '--seed') o.seed = Math.floor(Number(next()) || 42);
        else if (a === '--randomize') o.randomize = true;
        else if (a === '--total-packs') {
            const [lo, hi] = String(next() || '4,8').split(',').map(Number);
            o.totalPacks = [lo, hi != null && Number.isFinite(hi) ? hi : lo];
        } else if (a === '--apply') {
            o.apply = true;
            o.dryRun = false;
        } else if (a === '--out') o.out = String(next() || '');
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a.startsWith('-')) {
            throw new Error(`Unknown flag: ${a}`);
        }
    }
    return o;
}

/**
 * @param {object} c creature template
 * @param {object} o parseArgs result
 * @returns {{ exclude: boolean, reasons: string[] }}
 */
function shellDecision(c, o) {
    const reasons = [];
    const id = String(c.id || '');
    const hp = Number(c.hp != null ? c.hp : c.hpMax) || 0;
    if (o.excludeIds.has(id)) reasons.push('exclude_id');
    if (Number.isFinite(o.excludeHpMax) && o.excludeHpMax >= 0 && hp <= o.excludeHpMax) {
        reasons.push('hp_shell');
    }
    if (o.excludePatterns) {
        if (id.startsWith('echo_of_')) reasons.push('pattern:echo');
        if (id.endsWith('_pulse')) reasons.push('pattern:pulse');
        if (id.endsWith('_soul') && hp <= Math.max(o.excludeHpMax >= 0 ? o.excludeHpMax : 1, 1)) {
            reasons.push('pattern:soul_shell');
        }
    }
    const unattackable = unattackableDecision(c, o);
    for (let i = 0; i < unattackable.reasons.length; i++) {
        reasons.push(unattackable.reasons[i]);
    }
    const immune = immuneDecision(c, o);
    for (let i = 0; i < immune.reasons.length; i++) {
        reasons.push(immune.reasons[i]);
    }
    return { exclude: reasons.length > 0, reasons };
}

/**
 * @param {string} mode
 * @returns {object[]}
 */
function loadCreatureRows(mode) {
    const dir = path.join(ROOT, 'presets', mode, 'creatures');
    if (!fs.existsSync(dir)) {
        throw new Error(`Creatures dir missing: ${dir}`);
    }
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort();
    /** @type {object[]} */
    const out = [];
    for (const f of files) {
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch (e) {
            console.warn(`skip bad json: ${mode}/${f}: ${e.message}`);
            continue;
        }
        if (!raw || typeof raw !== 'object') continue;
        const id = raw.id != null ? String(raw.id) : path.basename(f, '.json');
        out.push({
            id,
            level: Number(raw.level) || 0,
            threatDps: Number(raw.threatDps) || 0,
            burstDps: Number(raw.burstDps) || 0,
            hp: Number(raw.hp != null ? raw.hp : raw.hpMax) || 0,
            label: raw.label != null ? String(raw.label) : id,
            resists:
                raw.resists && typeof raw.resists === 'object'
                    ? raw.resists
                    : null,
            flags:
                raw.flags && typeof raw.flags === 'object' ? raw.flags : null,
            attackable:
                raw.flags && typeof raw.flags === 'object' && raw.flags.attackable !== undefined
                    ? raw.flags.attackable
                    : raw.attackable
        });
    }
    return out;
}

/**
 * Evenly sample `count` items from a sorted array (stable).
 * @param {object[]} sorted
 * @param {number} count
 * @returns {object[]}
 */
function evenSample(sorted, count) {
    if (!sorted.length || count <= 0) return [];
    if (sorted.length <= count) return sorted.slice();
    /** @type {object[]} */
    const out = [];
    const n = sorted.length;
    for (let i = 0; i < count; i++) {
        const idx = Math.min(n - 1, Math.round((i * (n - 1)) / Math.max(count - 1, 1)));
        out.push(sorted[idx]);
    }
    // de-dupe while preserving order (rounding can collide)
    const seen = new Set();
    /** @type {object[]} */
    const uniq = [];
    for (const row of out) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        uniq.push(row);
    }
    // fill gaps if de-dupe shrank the set
    for (let i = 0; i < n && uniq.length < count; i++) {
        if (seen.has(sorted[i].id)) continue;
        seen.add(sorted[i].id);
        uniq.push(sorted[i]);
    }
    return uniq;
}

/**
 * @param {object[]} pool
 * @param {() => number} rng
 * @returns {object[]}
 */
function shuffleCopy(pool, rng) {
    const arr = pool.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
    }
    return arr;
}

/**
 * @param {object} o
 * @returns {{ population: object, meta: object }}
 */
function buildBandPopulation(o) {
    if (!o.id || !/^[a-z][a-z0-9_]{0,79}$/.test(o.id)) {
        throw new Error('--id required (entity id: ^[a-z][a-z0-9_]{0,79}$)');
    }
    const levelMin = Number(o.levelMin);
    const levelMax = Number(o.levelMax);
    if (!Number.isFinite(levelMin) || !Number.isFinite(levelMax) || levelMax < levelMin) {
        throw new Error('invalid --level-min / --level-max');
    }

    const all = loadCreatureRows(o.mode);
    /** @type {object[]} */
    const eligible = [];
    let nShell = 0;
    let nImmune = 0;
    let nUnattackable = 0;
    for (const c of all) {
        const decision = shellDecision(c, o);
        if (decision.exclude) {
            nShell++;
            if (
                decision.reasons.some(
                    (r) => r === 'physical_immune' || r.startsWith('multi_immune')
                )
            ) {
                nImmune++;
            }
            if (decision.reasons.some((r) => r === 'unattackable')) {
                nUnattackable++;
            }
            continue;
        }
        if (c.level < levelMin || c.level > levelMax) continue;
        if (o.threatMin != null && Number.isFinite(o.threatMin) && c.threatDps < o.threatMin) {
            continue;
        }
        if (o.threatMax != null && Number.isFinite(o.threatMax) && c.threatDps > o.threatMax) {
            continue;
        }
        // Prefer real combat kits; zero threat still allowed if level is in band
        eligible.push(c);
    }

    eligible.sort((a, b) => {
        if (a.level !== b.level) return a.level - b.level;
        if (a.threatDps !== b.threatDps) return a.threatDps - b.threatDps;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const rng = createSeededRandom(o.seed >>> 0);
    let pool = evenSample(eligible, o.count);
    if (o.randomize) {
        pool = evenSample(shuffleCopy(eligible, rng), o.count);
        pool.sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
    }

    if (!pool.length) {
        throw new Error(
            `no creatures in band level ${levelMin}..${levelMax} (mode=${o.mode}, eligible raw=${eligible.length})`
        );
    }

    const byThreat = pool.slice().sort((a, b) => b.threatDps - a.threatDps || a.id.localeCompare(b.id));
    const eliteIds = byThreat.slice(0, Math.min(o.eliteCount, byThreat.length)).map((r) => r.id);
    const eliteSet = new Set(eliteIds);
    const champIds = byThreat
        .filter((r) => !eliteSet.has(r.id))
        .slice(0, Math.min(o.championCount, byThreat.length))
        .map((r) => r.id);
    const normalIds = pool.map((r) => r.id);

    const levelLo = Math.min(...pool.map((r) => r.level));
    const levelHi = Math.max(...pool.map((r) => r.level));
    const threatLo = Math.min(...pool.map((r) => r.threatDps));
    const threatHi = Math.max(...pool.map((r) => r.threatDps));

    const label =
        o.label ||
        `${o.id.replace(/_/g, ' ')} (L${levelMin}–${levelMax})`;

    const notes =
        `Threat-banded population (docs/24). Auto-selected ${pool.length} of ${eligible.length} ` +
        `eligible templates in level ${levelMin}..${levelMax}` +
        (o.threatMin != null || o.threatMax != null
            ? ` threatDps [${o.threatMin ?? '−∞'}..${o.threatMax ?? '+∞'}]`
            : '') +
        `. seed=${o.seed} even-spread` +
        (o.randomize ? '+shuffle' : '') +
        (o.excludeImmune !== false
            ? `; excluded physical≥100 / multi-immune (≥${o.multiImmuneMin != null ? o.multiImmuneMin : DEFAULT_MULTI_IMMUNE_MIN} full resists)`
            : '') +
        (o.excludeUnattackable !== false ? '; excluded flags.attackable===false' : '') +
        `. Champion/elite ids = top threatDps in pool; affix mults still applied at resolve.`;

    const groups = {
        normal: {
            weight: o.weightNormal,
            creatureIds: normalIds,
            packSize: o.packSizeNormal
        }
    };
    if (champIds.length && o.weightChampion > 0) {
        groups.champion = {
            weight: o.weightChampion,
            creatureIds: champIds,
            packSize: o.packSizeChampion,
            affixes: ['champion']
        };
    }
    if (eliteIds.length && o.weightElite > 0) {
        groups.elite = {
            weight: o.weightElite,
            creatureIds: eliteIds,
            packSize: o.packSizeElite,
            affixes: ['elite']
        };
    }

    const population = {
        id: o.id,
        label,
        biome: o.biome,
        notes,
        band: {
            levelMin,
            levelMax,
            threatMin: o.threatMin,
            threatMax: o.threatMax,
            count: pool.length,
            seed: o.seed,
            selectedLevelRange: [levelLo, levelHi],
            selectedThreatRange: [threatLo, threatHi]
        },
        defaultRespawn: 0,
        groups,
        limits: {
            totalPacks: o.totalPacks,
            championPacks: o.championPacks,
            elitePacks: o.elitePacks
        }
    };

    return {
        population,
        meta: {
            mode: o.mode,
            catalogSize: all.length,
            nShellExcluded: nShell,
            nImmuneExcluded: nImmune,
            nUnattackableExcluded: nUnattackable,
            nEligibleInBand: eligible.length,
            nSelected: pool.length,
            normalIds,
            champIds,
            eliteIds,
            pool: pool.map((r) => ({
                id: r.id,
                level: r.level,
                threatDps: r.threatDps,
                hp: r.hp
            }))
        }
    };
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
    const o = parseArgs(argv);
    if (o.help) {
        console.log(`Usage: node bin/build_population_band.js --id <id> --level-min N --level-max M [options]

Options:
  --mode standard|legacy   (default standard)
  --biome <id>             (default cave)
  --count N                creatures in normal pool (default 16)
  --champion-count N       (default 4)
  --elite-count N          (default 2)
  --threat-min / --threat-max
  --exclude-hp-max N       (default 1)
  --exclude id1,id2
  --no-exclude-patterns
  --no-exclude-immune      keep physical≥100 / multi-immune templates
  --no-exclude-unattackable  keep flags.attackable===false templates
  --multi-immune-min N     full resists to treat as multi-immune (default 5)
  --seed N                 (default 42; used with --randomize)
  --randomize              shuffle eligible before even sample
  --total-packs min,max    (default 4,8)
  --apply                  write presets/<mode>/populations/<id>.json
  --out path               write path (implies write; still needs content)
`);
        return 0;
    }

    const { population, meta } = buildBandPopulation(o);
    const text = formatJson(population);
    const defaultPath = path.join(
        ROOT,
        'presets',
        o.mode,
        'populations',
        `${population.id}.json`
    );
    const outPath = o.out ? path.resolve(o.out) : defaultPath;

    console.log(
        JSON.stringify(
            {
                dryRun: !o.apply && !o.out,
                out: outPath,
                id: population.id,
                mode: meta.mode,
                eligible: meta.nEligibleInBand,
                selected: meta.nSelected,
                shellExcluded: meta.nShellExcluded,
                immuneExcluded: meta.nImmuneExcluded,
                unattackableExcluded: meta.nUnattackableExcluded,
                levelBand: [o.levelMin, o.levelMax],
                selectedLevelRange: population.band.selectedLevelRange,
                selectedThreatRange: population.band.selectedThreatRange,
                normal: meta.normalIds.length,
                champion: meta.champIds.length,
                elite: meta.eliteIds.length,
                sample: meta.pool.slice(0, 8)
            },
            null,
            2
        )
    );

    if (o.apply || o.out) {
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, text, 'utf8');
        console.log(`wrote ${outPath}`);
    } else {
        console.log('(dry-run; pass --apply to write population JSON)');
    }
    return 0;
}

if (require.main === module) {
    try {
        process.exit(main(process.argv.slice(2)));
    } catch (e) {
        console.error(e && e.stack ? e.stack : e);
        process.exit(1);
    }
}

module.exports = {
    parseArgs,
    buildBandPopulation,
    loadCreatureRows,
    evenSample,
    shellDecision,
    immuneDecision,
    unattackableDecision,
    resistProfile,
    RESIST_ELEMENTS,
    DEFAULT_MULTI_IMMUNE_MIN,
    main
};
