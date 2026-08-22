#!/usr/bin/env node
/**
 * Phase 2 — measure creature threatDps from fixed kits (analytical, no ticks).
 *
 * Protocol (single-target naked dummy, always in range):
 *   for each attack with damage band or DoT:
 *     avgHit  = (min+max)/2
 *     p       = (chance/100) * (hitChance/100)
 *     rate    = p / intervalSec
 *     hitDps += avgHit * rate
 *     if condition.totalDamage (poison/fire/ice):
 *       dotDps += totalDamage * rate   // full payload per application
 *   threatDps = hitDps + dotDps   (sustained expected DPS)
 *
 *   avgHit    = rate-weighted mean of per-attack (min+max)/2 (hit rows only)
 *   maxHit    = max of attack.max across damaging rows
 *   burst     = all CDs ready at t=0; fires at 0, I, 2I, … while t < W
 *               nFires_i = floor((W-ε)/I_i) + 1
 *               burstDamage = sum_i nFires_i * p_i * (avgHit_i + dotTotal_i)
 *               burstDps    = burstDamage / W   (default W = 2s)
 *
 * Status-only rows (min=max=0, no totalDamage) contribute 0.
 * Area/wave counted as single-target (one body on dummy).
 * Template `critChance` / `critDamage` are live-only (multiply after the kit
 * roll). This measure uses (min+max)/2 and does **not** include crit EV
 * (~+1% at 10/10, ~+0.3% at 3/10). Cache does not need --apply for that bump.
 *
 * Usage:
 *   node bin/measure_creature_threat.js
 *   node bin/measure_creature_threat.js --mode standard
 *   node bin/measure_creature_threat.js --mode all --out reports --burst-window 2
 *   node bin/measure_creature_threat.js --apply   # patch threat fields on creature JSON
 *   npm run measure:threat
 *   npm run measure:threat -- --apply
 *
 * Writes (per mode):
 *   <out>/creature_threat_<mode>.json
 *   <out>/creature_threat_<mode>.csv
 *
 * With --apply, also patches top-level derived cache on presets/<mode>/creatures/*.json:
 *   threatDps, burstDps, avgHit, maxHit  (never attacks / level / hp / art)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { normalizeAttack } = require('../kernel/core/lib/ai/creature_kit.js');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const MODES = ['standard', 'legacy'];
const DOT_TYPES = new Set(['poison', 'fire', 'ice']);
/** Default opening window for burstDps (seconds). Matches common auto/GCD. */
const DEFAULT_BURST_WINDOW_SEC = 2;

/**
 * Top-level derived fields written by --apply (wiki / picker cache).
 * Not combat inputs — source of truth remains attacks[].
 * @type {ReadonlyArray<string>}
 */
const APPLY_THREAT_FIELDS = ['threatDps', 'burstDps', 'avgHit', 'maxHit'];

/**
 * @param {object|null|undefined} condition
 * @returns {number} totalDamage for DoT kinds, else 0
 */
function conditionDotTotal(condition) {
    if (!condition || typeof condition !== 'object') return 0;
    const type = String(condition.type || condition.kind || '').toLowerCase();
    if (!DOT_TYPES.has(type)) return 0;
    const td = condition.totalDamage;
    if (td == null) return 0;
    const n = Math.abs(Number(td) || 0);
    return n > 0 ? n : 0;
}

/**
 * How many times an attack can fire in [0, windowSec) when ready at t=0.
 * Fires at 0, I, 2I, … while t < windowSec.
 * @param {number} intervalSec
 * @param {number} windowSec
 * @returns {number}
 */
function firesInWindow(intervalSec, windowSec) {
    const I = Math.max(0.05, Number(intervalSec) || 2);
    const W = Math.max(0, Number(windowSec) || 0);
    if (!(W > 0)) return 0;
    return Math.floor((W - 1e-9) / I) + 1;
}

/**
 * Expected DPS / burst components for one normalized attack row.
 * @param {object} atk NormalizedAttack (+ optional condition)
 * @param {number} [burstWindowSec]
 * @returns {object}
 */
function attackThreat(atk, burstWindowSec) {
    if (!atk) {
        return {
            hitDps: 0,
            dotDps: 0,
            avgHit: 0,
            max: 0,
            p: 0,
            rate: 0,
            intervalSec: 2,
            burstHit: 0,
            burstDot: 0,
            statusOnly: true
        };
    }
    const intervalSec = Math.max(0.05, Number(atk.intervalSec) || 2);
    const chance = Math.max(0, Math.min(100, Number(atk.chance) || 0));
    const hitChance = Math.max(0, Math.min(100, Number(atk.hitChance) || 100));
    const p = (chance / 100) * (hitChance / 100);
    const rate = p / intervalSec;

    const min = Number(atk.min) || 0;
    const max = Number(atk.max) || 0;
    const avgHit = (min + max) / 2;
    const hitDps = avgHit > 0 ? avgHit * rate : 0;

    const dotTotal = conditionDotTotal(atk.condition);
    const dotDps = dotTotal > 0 ? dotTotal * rate : 0;

    const W =
        burstWindowSec != null && Number(burstWindowSec) > 0
            ? Number(burstWindowSec)
            : DEFAULT_BURST_WINDOW_SEC;
    const nFires = firesInWindow(intervalSec, W);
    const expectedFires = nFires * p;
    const burstHit = avgHit > 0 ? avgHit * expectedFires : 0;
    const burstDot = dotTotal > 0 ? dotTotal * expectedFires : 0;

    const statusOnly =
        !!atk.statusOnly ||
        (hitDps <= 0 &&
            dotDps <= 0 &&
            min === 0 &&
            max === 0 &&
            !(dotTotal > 0));

    return {
        hitDps,
        dotDps,
        avgHit,
        max,
        p,
        rate,
        intervalSec,
        burstHit,
        burstDot,
        nFires,
        statusOnly
    };
}

/**
 * Measure threat metrics for one creature template (raw JSON).
 * @param {object} template
 * @param {{ burstWindowSec?: number }} [opts]
 * @returns {object}
 */
function measureTemplate(template, opts) {
    const o = opts || {};
    const burstWindowSec =
        o.burstWindowSec != null && Number(o.burstWindowSec) > 0
            ? Number(o.burstWindowSec)
            : DEFAULT_BURST_WINDOW_SEC;

    const t = template && typeof template === 'object' ? template : {};
    const id = t.id != null ? String(t.id) : '';
    const rawList = Array.isArray(t.attacks) ? t.attacks : [];
    /** @type {object[]} */
    const components = [];
    let hitDps = 0;
    let dotDps = 0;
    let hitsPerSec = 0;
    let weightedHitSum = 0;
    let damageWeight = 0;
    let burstHit = 0;
    let burstDot = 0;
    let maxHit = 0;
    let nAttacks = 0;
    let nOffensive = 0;

    for (let i = 0; i < rawList.length; i++) {
        const norm = normalizeAttack(rawList[i], i, t);
        if (!norm) continue;
        nAttacks++;
        const tr = attackThreat(norm, burstWindowSec);
        if (tr.hitDps > 0 || tr.dotDps > 0) nOffensive++;
        hitDps += tr.hitDps;
        dotDps += tr.dotDps;
        burstHit += tr.burstHit;
        burstDot += tr.burstDot;
        if (tr.max > maxHit) maxHit = tr.max;
        if (tr.avgHit > 0 && tr.rate > 0) {
            hitsPerSec += tr.rate;
            weightedHitSum += tr.avgHit * tr.rate;
            damageWeight += tr.rate;
        }
        components.push({
            id: norm.id,
            kind: norm.kind,
            min: norm.min,
            max: norm.max,
            intervalSec: norm.intervalSec,
            chance: norm.chance,
            hitChance: norm.hitChance,
            avgHit: round4(tr.avgHit),
            rate: round6(tr.rate),
            hitDps: round4(tr.hitDps),
            dotDps: round4(tr.dotDps),
            burstHit: round4(tr.burstHit),
            burstDot: round4(tr.burstDot),
            nFires: tr.nFires,
            statusOnly: tr.statusOnly
        });
    }

    const threatDps = hitDps + dotDps;
    const avgHit = damageWeight > 0 ? weightedHitSum / damageWeight : 0;
    const burstDamage = burstHit + burstDot;
    const burstDps = burstWindowSec > 0 ? burstDamage / burstWindowSec : 0;

    return {
        id,
        label: t.label != null ? String(t.label) : id,
        threatDps: round4(threatDps),
        hitDps: round4(hitDps),
        dotDps: round4(dotDps),
        /** Rate-weighted mean of (min+max)/2 across damaging attacks. */
        avgHit: round4(avgHit),
        /** Highest attack.max on the kit (peak single roll ceiling). */
        maxHit: round4(maxHit),
        hitsPerSec: round6(hitsPerSec),
        burstWindowSec,
        /** Expected damage in [0, W) with all CDs ready at t=0. */
        burstDamage: round4(burstDamage),
        /** burstDamage / burstWindowSec — opening pressure vs sustained threatDps. */
        burstDps: round4(burstDps),
        levelOld: t.level != null ? Number(t.level) || 0 : 0,
        atk: t.atk != null ? Number(t.atk) || 0 : 0,
        hp: t.hp != null ? Number(t.hp) || 0 : t.hpMax != null ? Number(t.hpMax) || 0 : 0,
        exp: t.exp != null ? Number(t.exp) || 0 : 0,
        nAttacks,
        nOffensive,
        components
    };
}

/**
 * @param {string} mode
 * @returns {string}
 */
function creaturesDir(mode) {
    return path.join(ROOT, 'presets', mode, 'creatures');
}

/**
 * @param {string} mode
 * @param {{ burstWindowSec?: number }} [opts]
 * @returns {object[]}
 */
function loadModeCreatures(mode, opts) {
    const dir = creaturesDir(mode);
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
        const full = path.join(dir, f);
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (e) {
            console.warn(`skip bad json: ${mode}/${f}: ${e.message}`);
            continue;
        }
        if (!raw || typeof raw !== 'object') continue;
        if (raw.id == null) raw.id = path.basename(f, '.json');
        const row = measureTemplate(raw, opts);
        row.mode = mode;
        row.file = f;
        out.push(row);
    }
    return out;
}

/**
 * @param {object[]} rows sorted by threatDps desc later
 * @returns {object}
 */
function buildSummary(rows) {
    const n = rows.length;
    const dps = rows.map((r) => r.threatDps).sort((a, b) => a - b);
    const zero = rows.filter((r) => !(r.threatDps > 0)).length;
    const noKit = rows.filter((r) => r.nAttacks === 0).length;
    const levels = rows.map((r) => r.levelOld);
    return {
        count: n,
        zeroThreat: zero,
        noAttacks: noKit,
        threatDps: {
            min: n ? dps[0] : 0,
            p50: n ? percentile(dps, 0.5) : 0,
            p90: n ? percentile(dps, 0.9) : 0,
            p99: n ? percentile(dps, 0.99) : 0,
            max: n ? dps[n - 1] : 0,
            mean: n ? mean(dps) : 0
        },
        corrLevelThreatDps: pearson(levels, rows.map((r) => r.threatDps)),
        corrAtkThreatDps: pearson(
            rows.map((r) => r.atk),
            rows.map((r) => r.threatDps)
        ),
        top10: rows
            .slice()
            .sort(cmpThreatDesc)
            .slice(0, 10)
            .map(briefRow),
        bottom10: rows
            .slice()
            .sort(cmpThreatAsc)
            .slice(0, 10)
            .map(briefRow)
    };
}

/**
 * @param {object} r
 */
function briefRow(r) {
    return {
        id: r.id,
        threatDps: r.threatDps,
        avgHit: r.avgHit,
        maxHit: r.maxHit,
        burstDps: r.burstDps,
        burstDamage: r.burstDamage,
        levelOld: r.levelOld,
        atk: r.atk,
        hp: r.hp,
        nAttacks: r.nAttacks
    };
}

function cmpThreatDesc(a, b) {
    if (b.threatDps !== a.threatDps) return b.threatDps - a.threatDps;
    return String(a.id).localeCompare(String(b.id));
}

function cmpThreatAsc(a, b) {
    if (a.threatDps !== b.threatDps) return a.threatDps - b.threatDps;
    return String(a.id).localeCompare(String(b.id));
}

/**
 * @param {number[]} sorted
 * @param {number} p 0..1
 */
function percentile(sorted, p) {
    if (!sorted.length) return 0;
    if (sorted.length === 1) return sorted[0];
    const idx = (sorted.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const t = idx - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function mean(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

/**
 * Pearson correlation; returns null if undefined.
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number|null}
 */
function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return null;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
        sx += xs[i];
        sy += ys[i];
    }
    const mx = sx / n;
    const my = sy / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
        const a = xs[i] - mx;
        const b = ys[i] - my;
        num += a * b;
        dx += a * a;
        dy += b * b;
    }
    if (!(dx > 0) || !(dy > 0)) return null;
    return round4(num / Math.sqrt(dx * dy));
}

function round4(n) {
    return Math.round(Number(n) * 1e4) / 1e4;
}

function round6(n) {
    return Math.round(Number(n) * 1e6) / 1e6;
}

/**
 * @param {object[]} rows
 * @returns {string}
 */
function toCsv(rows) {
    const headers = [
        'id',
        'mode',
        'threatDps',
        'hitDps',
        'dotDps',
        'avgHit',
        'maxHit',
        'hitsPerSec',
        'burstWindowSec',
        'burstDamage',
        'burstDps',
        'levelOld',
        'atk',
        'hp',
        'exp',
        'nAttacks',
        'nOffensive'
    ];
    const lines = [headers.join(',')];
    const sorted = rows.slice().sort(cmpThreatDesc);
    for (const r of sorted) {
        lines.push(
            headers
                .map((h) => {
                    const v = r[h];
                    if (v == null) return '';
                    if (typeof v === 'string' && /[",\n]/.test(v)) {
                        return `"${v.replace(/"/g, '""')}"`;
                    }
                    return String(v);
                })
                .join(',')
        );
    }
    return lines.join('\n') + '\n';
}

/**
 * @param {string[]} argv
 */
/**
 * @param {number|undefined|null} a
 * @param {number|undefined|null} b
 * @returns {boolean}
 */
function sameThreatNum(a, b) {
    const na = a == null || a === '' ? null : Number(a);
    const nb = b == null || b === '' ? null : Number(b);
    if (na == null && nb == null) return true;
    if (na == null || nb == null) return false;
    if (!Number.isFinite(na) || !Number.isFinite(nb)) return false;
    // Values are already round4 from measureTemplate.
    return Math.abs(na - nb) < 1e-9;
}

/**
 * Patch creature JSON: write derived threat cache fields only.
 * @param {string} mode
 * @param {object[]} rows measure rows (must include file / id)
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ written: number, skipped: number, missing: string[] }}
 */
function applyThreatPatch(mode, rows, opts) {
    const dryRun = !!(opts && opts.dryRun);
    const dir = creaturesDir(mode);
    let written = 0;
    let skipped = 0;
    /** @type {string[]} */
    const missing = [];

    for (const r of rows) {
        const file = r.file || `${r.id}.json`;
        const full = path.join(dir, file);
        if (!fs.existsSync(full)) {
            missing.push(`${mode}/${file}`);
            continue;
        }
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (e) {
            missing.push(`${mode}/${file} (parse: ${e.message})`);
            continue;
        }
        if (!raw || typeof raw !== 'object') {
            missing.push(`${mode}/${file} (not object)`);
            continue;
        }

        let changed = false;
        for (const key of APPLY_THREAT_FIELDS) {
            const next = r[key] != null ? Number(r[key]) || 0 : 0;
            if (!sameThreatNum(raw[key], next)) {
                changed = true;
                break;
            }
        }
        if (!changed) {
            skipped++;
            continue;
        }
        if (!dryRun) {
            for (const key of APPLY_THREAT_FIELDS) {
                raw[key] = r[key] != null ? Number(r[key]) || 0 : 0;
            }
            fs.writeFileSync(full, formatJson(raw), {
                encoding: 'utf8',
                mode: 0o664
            });
        }
        written++;
    }
    return { written, skipped, missing };
}

function parseArgs(argv) {
    const opts = {
        mode: 'all',
        out: path.join(ROOT, 'reports'),
        help: false,
        printTop: 15,
        burstWindowSec: DEFAULT_BURST_WINDOW_SEC,
        apply: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`Missing value after ${a}`);
            return v;
        };
        switch (a) {
            case '-h':
            case '--help':
                opts.help = true;
                break;
            case '--mode':
                opts.mode = next();
                break;
            case '--out':
                opts.out = path.resolve(next());
                break;
            case '--top':
                opts.printTop = Math.max(0, parseInt(next(), 10) || 0);
                break;
            case '--burst-window':
            case '--burstWindow':
                opts.burstWindowSec = Math.max(0.05, Number(next()) || DEFAULT_BURST_WINDOW_SEC);
                break;
            case '--apply':
                opts.apply = true;
                break;
            default:
                if (a.startsWith('-')) {
                    throw new Error(`Unknown flag: ${a}`);
                }
        }
    }
    return opts;
}

function printHelp() {
    console.log(`Measure analytical threatDps for creature kits (Phase 2).

Usage:
  node bin/measure_creature_threat.js [options]

Options:
  --mode <id>            standard | legacy | all   (default: all)
  --out <dir>            output directory          (default: reports/)
  --burst-window <sec>   opening window for burstDps (default: ${DEFAULT_BURST_WINDOW_SEC})
  --top <n>              print top/bottom n        (default: 15)
  --apply                patch threatDps/burstDps/avgHit/maxHit on creature JSON
  -h, --help             show help

Metrics:
  threatDps   sustained expected DPS (hit + DoT application rate)
  avgHit      rate-weighted mean of (min+max)/2
  maxHit      highest attack.max on the kit
  burstDps    expected damage in [0,W) / W with all CDs ready at t=0

Output per mode:
  creature_threat_<mode>.json
  creature_threat_<mode>.csv

With --apply also writes derived cache fields on presets/<mode>/creatures/*.json
(threatDps, burstDps, avgHit, maxHit). Never rewrites attacks / level / hp / art.
`);
}

/**
 * @param {string} mode
 * @param {string} outDir
 * @param {{ printTop?: number, burstWindowSec?: number, apply?: boolean }} [opts]
 */
function runMode(mode, outDir, opts) {
    const o = opts || {};
    const burstWindowSec =
        o.burstWindowSec != null && Number(o.burstWindowSec) > 0
            ? Number(o.burstWindowSec)
            : DEFAULT_BURST_WINDOW_SEC;
    const rows = loadModeCreatures(mode, { burstWindowSec });
    rows.sort(cmpThreatDesc);
    // rank 1 = highest threat (for Phase 3 convenience; not written back as rank)
    for (let i = 0; i < rows.length; i++) {
        rows[i].rankByThreat = i + 1;
    }
    const summary = buildSummary(rows);
    const report = {
        generatedAt: new Date().toISOString(),
        mode,
        protocol: {
            target: 'single-target naked dummy (armor/mitigation/resist = 0)',
            burstWindowSec,
            formula: {
                threatDps:
                    'sum_i ((min+max)/2 * rate) + sum_i (dotTotal * rate); rate = p/intervalSec; p=(chance/100)*(hitChance/100)',
                avgHit: 'rate-weighted mean of (min+max)/2 over damaging attacks',
                maxHit: 'max of attack.max on kit',
                burstDps:
                    'burstDamage/W; each attack fires nFires=floor((W-ε)/I)+1 times from t=0 with all CDs ready; expected = nFires*p*(avgHit+dotTotal)'
            },
            notes: [
                'Analytical expected value; no Monte Carlo ticks',
                'DoT uses full totalDamage per application (refresh overcount possible)',
                'Area/wave treated as one body on dummy',
                'Status-only (slow/haste/invisible) excluded from DPS',
                'burstDps > threatDps flags long-CD high-alpha openers',
                'Derived cache fields threatDps/burstDps/avgHit/maxHit may be written with --apply'
            ]
        },
        summary,
        creatures: rows
    };

    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true, mode: 0o775 });
    }
    const base = path.join(outDir, `creature_threat_${mode}`);
    fs.writeFileSync(base + '.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(base + '.csv', toCsv(rows), 'utf8');

    console.log(`\n=== ${mode} (${rows.length} creatures)  burstWindow=${burstWindowSec}s ===`);
    console.log(
        `threatDps  min=${summary.threatDps.min}  p50=${round4(summary.threatDps.p50)}  p90=${round4(summary.threatDps.p90)}  p99=${round4(summary.threatDps.p99)}  max=${summary.threatDps.max}  mean=${round4(summary.threatDps.mean)}`
    );
    console.log(
        `zeroThreat=${summary.zeroThreat}  noAttacks=${summary.noAttacks}  corr(level,threatDps)=${summary.corrLevelThreatDps}  corr(atk,threatDps)=${summary.corrAtkThreatDps}`
    );
    console.log(`wrote ${base}.json`);
    console.log(`wrote ${base}.csv`);

    const topN = o.printTop != null ? o.printTop : 15;
    if (topN > 0) {
        console.log(`\nTop ${topN} by threatDps:`);
        for (const r of rows.slice(0, topN)) {
            console.log(
                `  ${String(r.rankByThreat).padStart(4)}  dps=${String(r.threatDps).padStart(10)}  avgHit=${String(r.avgHit).padStart(8)}  burst=${String(r.burstDps).padStart(10)}  lv=${String(r.levelOld).padStart(4)}  hp=${String(r.hp).padStart(6)}  ${r.id}`
            );
        }
        console.log(`\nBottom ${topN} by threatDps:`);
        const bot = rows.slice().sort(cmpThreatAsc).slice(0, topN);
        for (const r of bot) {
            console.log(
                `  rank=${String(r.rankByThreat).padStart(4)}  dps=${String(r.threatDps).padStart(10)}  avgHit=${String(r.avgHit).padStart(8)}  burst=${String(r.burstDps).padStart(10)}  lv=${String(r.levelOld).padStart(4)}  hp=${String(r.hp).padStart(6)}  ${r.id}`
            );
        }
    }

    if (o.apply) {
        const patch = applyThreatPatch(mode, rows, { dryRun: false });
        console.log(
            `apply: wrote=${patch.written}  unchanged=${patch.skipped}  missing=${patch.missing.length}`
        );
        if (patch.missing.length) {
            console.warn(`  missing (first 10): ${patch.missing.slice(0, 10).join(', ')}`);
        }
        report.apply = patch;
    } else {
        console.log('No presets modified (dry-run reports only). Re-run with --apply to patch threat fields.');
    }

    return report;
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        printHelp();
        return 0;
    }
    let modes;
    if (opts.mode === 'all') modes = MODES.slice();
    else if (MODES.includes(opts.mode)) modes = [opts.mode];
    else {
        console.error(`Unknown mode "${opts.mode}" (use standard|legacy|all)`);
        return 1;
    }

    for (const mode of modes) {
        runMode(mode, opts.out, {
            printTop: opts.printTop,
            burstWindowSec: opts.burstWindowSec,
            apply: opts.apply
        });
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
    DEFAULT_BURST_WINDOW_SEC,
    APPLY_THREAT_FIELDS,
    measureTemplate,
    attackThreat,
    firesInWindow,
    conditionDotTotal,
    loadModeCreatures,
    buildSummary,
    applyThreatPatch,
    runMode,
    main
};
