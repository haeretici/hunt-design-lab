#!/usr/bin/env node
/**
 * Phase 3 (+ 2b) — map creature level 1..1000 from analytical threatDps and patch presets.
 *
 * Formula (per mode catalog):
 *   x = log(threatDps + ε)
 *   // endpoints: winsorized percentiles of x among scale-eligible creatures
 *   t = clamp((x - x_lo) / (x_hi - x_lo), 0, 1)
 *   levelNew = 1 + round(999 * t)
 *
 * Phase 2b — exclude outliers from the *scale only* (still receive a mapped level):
 *   - default: hp <= 1 (summons / phase shells / VFX-like templates)
 *   - optional: --exclude id1,id2  and id patterns (echo_of_*, energy_pulse, …)
 *   - zero threat never contributes samples (and maps to level 1)
 *
 * Zero / non-positive threatDps → level 1 always.
 * Writes only the top-level `level` field (never atk / attacks / exp).
 *
 * Usage:
 *   node bin/map_creature_levels.js                  # dry-run, all modes
 *   node bin/map_creature_levels.js --apply          # patch presets
 *   node bin/map_creature_levels.js --mode standard --apply
 *   node bin/map_creature_levels.js --winsorize 0     # pure min/max of positive DPS
 *   node bin/map_creature_levels.js --exclude-hp-max 0  # disable hp shell rule
 *   node bin/map_creature_levels.js --from-report reports
 *   npm run map:levels
 *   npm run map:levels -- --apply
 *
 * Writes (always, under --out):
 *   creature_level_map_<mode>.json
 *   creature_level_map_<mode>.csv
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const { loadModeCreatures } = require('./measure_creature_threat.js');

const MODES = ['standard', 'legacy'];
const DEFAULT_EPS = 1e-6;
const DEFAULT_WINSORIZE = 0.01;
/** Default: shell/summon templates with hp ≤ this value are omitted from scale endpoints. */
const DEFAULT_EXCLUDE_HP_MAX = 1;
const LEVEL_MIN = 1;
const LEVEL_MAX = 1000;

/**
 * Always-omitted from scale endpoints (still mapped). Effects / non-species ids.
 * hp≤1 already covers most of these; list is an explicit safety net.
 * @type {ReadonlySet<string>}
 */
const DEFAULT_SCALE_EXCLUDE_IDS = new Set([
    'energy_pulse',
    'dummy',
    'training_dummy',
    'floor_blob'
]);

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
    return Math.round((num / Math.sqrt(dx * dy)) * 1e4) / 1e4;
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

/**
 * Log transform used for the level map.
 * @param {number} threatDps
 * @param {number} eps
 * @returns {number}
 */
function threatLog(threatDps, eps) {
    const d = Number(threatDps) || 0;
    const e = eps > 0 ? eps : DEFAULT_EPS;
    return Math.log(Math.max(0, d) + e);
}

/**
 * Compute scale endpoints from log-threat samples.
 * @param {number[]} xs log values
 * @param {number} winsorize 0 = pure min/max; 0.01 = p1/p99
 * @returns {{ xLo: number, xHi: number, method: string }}
 */
function scaleEndpoints(xs, winsorize) {
    if (!xs.length) return { xLo: 0, xHi: 1, method: 'empty' };
    const sorted = xs.slice().sort((a, b) => a - b);
    const w = Math.max(0, Math.min(0.49, Number(winsorize) || 0));
    if (w <= 0) {
        return { xLo: sorted[0], xHi: sorted[sorted.length - 1], method: 'minmax' };
    }
    return {
        xLo: percentile(sorted, w),
        xHi: percentile(sorted, 1 - w),
        method: `winsorize_p${Math.round(w * 100)}_p${Math.round((1 - w) * 100)}`
    };
}

/**
 * Map one threatDps to level 1..1000.
 * @param {number} threatDps
 * @param {{ xLo: number, xHi: number, eps?: number }} scale
 * @returns {number}
 */
function mapThreatToLevel(threatDps, scale) {
    const d = Number(threatDps) || 0;
    if (!(d > 0)) return LEVEL_MIN;
    const eps = scale.eps != null && scale.eps > 0 ? scale.eps : DEFAULT_EPS;
    const x = threatLog(d, eps);
    const span = scale.xHi - scale.xLo;
    let t;
    if (!(span > 0) || !Number.isFinite(span)) t = 0;
    else t = (x - scale.xLo) / span;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    const lv = LEVEL_MIN + Math.round((LEVEL_MAX - LEVEL_MIN) * t);
    if (lv < LEVEL_MIN) return LEVEL_MIN;
    if (lv > LEVEL_MAX) return LEVEL_MAX;
    return lv | 0;
}

/**
 * Decide whether a creature is omitted from scale endpoints (Phase 2b).
 * Still receives a mapped levelNew; only x_lo/x_hi ignore it.
 *
 * @param {object} row measure row (id, threatDps, hp, …)
 * @param {{
 *   excludeIds?: Set<string>,
 *   excludeHpMax?: number|null,
 *   excludePatterns?: boolean
 * }} [opts]
 * @returns {{ exclude: boolean, reasons: string[] }}
 */
function scaleExcludeDecision(row, opts) {
    const o = opts || {};
    const id = String(row.id || '');
    const hp = row.hp != null ? Number(row.hp) || 0 : 0;
    /** @type {string[]} */
    const reasons = [];

    const excludeIds = o.excludeIds instanceof Set ? o.excludeIds : new Set();
    if (DEFAULT_SCALE_EXCLUDE_IDS.has(id)) reasons.push('default_id');
    if (excludeIds.has(id)) reasons.push('cli_id');

    const hpMax =
        o.excludeHpMax === null || o.excludeHpMax === undefined
            ? DEFAULT_EXCLUDE_HP_MAX
            : Number(o.excludeHpMax);
    // hpMax < 0 disables the rule; 0 means only hp<=0 (rare).
    if (Number.isFinite(hpMax) && hpMax >= 0 && hp <= hpMax) {
        reasons.push(`hp<=${hpMax}`);
    }

    // Name patterns for known non-species shells (even if hp was fixed later).
    const usePatterns = o.excludePatterns !== false;
    if (usePatterns) {
        if (id === 'energy_pulse' || id.endsWith('_pulse')) reasons.push('pattern:pulse');
        if (id.startsWith('echo_of_')) reasons.push('pattern:echo');
        if (
            id === 'powerful_soul' ||
            id === 'strong_soul' ||
            id === 'hateful_soul' ||
            id.endsWith('_soul')
        ) {
            // Only shells: avoid excluding e.g. soul_war themed bosses with real HP.
            if (hp <= Math.max(hpMax >= 0 ? hpMax : 1, 1)) reasons.push('pattern:soul_shell');
        }
    }

    // De-dupe reasons
    const uniq = [...new Set(reasons)];
    return { exclude: uniq.length > 0, reasons: uniq };
}

/**
 * Build level proposals for a mode's creature rows (from measureTemplate shape).
 * @param {object[]} rows
 * @param {{
 *   winsorize?: number,
 *   eps?: number,
 *   excludeIds?: Set<string>,
 *   excludeHpMax?: number|null,
 *   excludePatterns?: boolean
 * }} [opts]
 * @returns {{ rows: object[], scale: object, summary: object }}
 */
function proposeLevels(rows, opts) {
    const o = opts || {};
    const eps = o.eps != null && Number(o.eps) > 0 ? Number(o.eps) : DEFAULT_EPS;
    const winsorize =
        o.winsorize != null ? Number(o.winsorize) : DEFAULT_WINSORIZE;
    const excludeIds = o.excludeIds instanceof Set ? o.excludeIds : new Set();
    const excludeHpMax =
        o.excludeHpMax === null || o.excludeHpMax === undefined
            ? DEFAULT_EXCLUDE_HP_MAX
            : o.excludeHpMax;
    const excludePatterns = o.excludePatterns !== false;
    const ruleOpts = { excludeIds, excludeHpMax, excludePatterns };

    /** @type {{ id: string, threatDps: number, hp: number, reasons: string[] }[]} */
    const excludedList = [];
    /** Log samples that define the scale (positive DPS, not excluded). */
    const scaleLogs = [];
    /** @type {Map<string, { exclude: boolean, reasons: string[] }>} */
    const decisionById = new Map();

    for (const r of rows) {
        const dec = scaleExcludeDecision(r, ruleOpts);
        decisionById.set(String(r.id), dec);
        if (!(r.threatDps > 0)) continue;
        if (dec.exclude) {
            excludedList.push({
                id: String(r.id),
                threatDps: r.threatDps,
                hp: r.hp != null ? Number(r.hp) || 0 : 0,
                reasons: dec.reasons
            });
            continue;
        }
        scaleLogs.push(threatLog(r.threatDps, eps));
    }
    // Fallback: if every positive row was excluded, use all positive.
    let usedFallback = false;
    if (!scaleLogs.length) {
        usedFallback = true;
        for (const r of rows) {
            if (!(r.threatDps > 0)) continue;
            scaleLogs.push(threatLog(r.threatDps, eps));
        }
    }

    const ends = scaleEndpoints(scaleLogs, winsorize);
    const scale = {
        eps,
        winsorize: Math.max(0, Math.min(0.49, winsorize)),
        xLo: ends.xLo,
        xHi: ends.xHi,
        method: ends.method,
        nScale: scaleLogs.length,
        usedFallbackAllPositive: usedFallback,
        excludeHpMax:
            excludeHpMax === null || excludeHpMax === undefined
                ? DEFAULT_EXCLUDE_HP_MAX
                : excludeHpMax,
        excludePatterns,
        excludeIds: [...excludeIds].sort(),
        defaultExcludeIds: [...DEFAULT_SCALE_EXCLUDE_IDS].sort(),
        nExcludedFromScale: excludedList.length,
        excludedFromScale: excludedList
            .slice()
            .sort((a, b) => b.threatDps - a.threatDps || a.id.localeCompare(b.id))
    };

    /** @type {object[]} */
    const out = [];
    for (const r of rows) {
        const levelOld = r.levelOld != null ? Number(r.levelOld) || 0 : 0;
        const levelNew = mapThreatToLevel(r.threatDps, scale);
        const dec = decisionById.get(String(r.id)) || { exclude: false, reasons: [] };
        out.push({
            id: r.id,
            mode: r.mode,
            file: r.file,
            threatDps: r.threatDps,
            avgHit: r.avgHit,
            burstDps: r.burstDps,
            maxHit: r.maxHit,
            hp: r.hp,
            atk: r.atk,
            nAttacks: r.nAttacks,
            levelOld,
            levelNew,
            delta: levelNew - levelOld,
            scaleExcluded: !!(dec.exclude && r.threatDps > 0),
            scaleExcludeReasons: dec.exclude ? dec.reasons.join('|') : ''
        });
    }

    // Stable sort: threat desc, then id
    out.sort((a, b) => {
        if (b.threatDps !== a.threatDps) return b.threatDps - a.threatDps;
        return String(a.id).localeCompare(String(b.id));
    });

    const levelsNew = out.map((r) => r.levelNew);
    const levelsOld = out.map((r) => r.levelOld);
    const dps = out.map((r) => r.threatDps);
    const logs = out.map((r) => threatLog(r.threatDps, eps));
    const changed = out.filter((r) => r.levelNew !== r.levelOld).length;
    const zero = out.filter((r) => !(r.threatDps > 0)).length;
    const scaleExcluded = out.filter((r) => r.scaleExcluded).length;

    // Correlation among scale-eligible only (cleaner 2b signal).
    const eligible = out.filter((r) => r.threatDps > 0 && !r.scaleExcluded);
    const corrEligibleLevelThreat = pearson(
        eligible.map((r) => r.levelNew),
        eligible.map((r) => r.threatDps)
    );
    const corrEligibleLevelLog = pearson(
        eligible.map((r) => r.levelNew),
        eligible.map((r) => threatLog(r.threatDps, eps))
    );

    const summary = {
        count: out.length,
        changed,
        unchanged: out.length - changed,
        zeroThreat: zero,
        scaleExcluded,
        levelNew: {
            min: out.length ? Math.min(...levelsNew) : 0,
            max: out.length ? Math.max(...levelsNew) : 0,
            mean: out.length
                ? Math.round((levelsNew.reduce((s, v) => s + v, 0) / out.length) * 100) / 100
                : 0,
            unique: new Set(levelsNew).size
        },
        corrOldLevelThreatDps: pearson(levelsOld, dps),
        corrNewLevelThreatDps: pearson(levelsNew, dps),
        corrNewLevelLogThreat: pearson(levelsNew, logs),
        corrEligibleLevelThreatDps: corrEligibleLevelThreat,
        corrEligibleLevelLogThreat: corrEligibleLevelLog,
        histogram100: histBuckets(levelsNew, 100),
        topByNew: out.slice(0, 20).map(briefMapRow),
        topScaleEligible: out
            .filter((r) => r.threatDps > 0 && !r.scaleExcluded)
            .slice(0, 15)
            .map(briefMapRow),
        topScaleExcluded: out
            .filter((r) => r.scaleExcluded)
            .slice(0, 15)
            .map(briefMapRow),
        bottomByNew: out
            .slice()
            .sort((a, b) => {
                if (a.levelNew !== b.levelNew) return a.levelNew - b.levelNew;
                if (a.threatDps !== b.threatDps) return a.threatDps - b.threatDps;
                return String(a.id).localeCompare(String(b.id));
            })
            .slice(0, 20)
            .map(briefMapRow),
        biggestUp: out
            .slice()
            .sort((a, b) => b.delta - a.delta || String(a.id).localeCompare(String(b.id)))
            .slice(0, 15)
            .map(briefMapRow),
        biggestDown: out
            .slice()
            .sort((a, b) => a.delta - b.delta || String(a.id).localeCompare(String(b.id)))
            .slice(0, 15)
            .map(briefMapRow)
    };

    return { rows: out, scale, summary };
}

/**
 * @param {number[]} levels
 * @param {number} width
 */
function histBuckets(levels, width) {
    /** @type {Record<string, number>} */
    const h = {};
    const w = width > 0 ? width : 100;
    for (let b = LEVEL_MIN; b <= LEVEL_MAX; b += w) {
        const hi = Math.min(LEVEL_MAX, b + w - 1);
        const key = `${b}-${hi}`;
        h[key] = 0;
    }
    for (const lv of levels) {
        const bucketStart = Math.floor((lv - LEVEL_MIN) / w) * w + LEVEL_MIN;
        const hi = Math.min(LEVEL_MAX, bucketStart + w - 1);
        const key = `${bucketStart}-${hi}`;
        if (h[key] == null) h[key] = 0;
        h[key]++;
    }
    return h;
}

function briefMapRow(r) {
    return {
        id: r.id,
        threatDps: r.threatDps,
        levelOld: r.levelOld,
        levelNew: r.levelNew,
        delta: r.delta,
        hp: r.hp,
        scaleExcluded: !!r.scaleExcluded,
        scaleExcludeReasons: r.scaleExcludeReasons || ''
    };
}

/**
 * Load rows either by re-measuring or from an existing threat report.
 * @param {string} mode
 * @param {{ fromReportDir?: string|null }} [opts]
 * @returns {object[]}
 */
function loadRows(mode, opts) {
    const o = opts || {};
    if (o.fromReportDir) {
        const p = path.join(o.fromReportDir, `creature_threat_${mode}.json`);
        if (!fs.existsSync(p)) {
            throw new Error(`Threat report missing: ${p} (run npm run measure:threat first)`);
        }
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = Array.isArray(doc.creatures) ? doc.creatures : [];
        return list.map((r) => ({
            ...r,
            mode: r.mode || mode,
            file: r.file || `${r.id}.json`,
            levelOld: r.levelOld != null ? r.levelOld : r.level != null ? r.level : 0
        }));
    }
    return loadModeCreatures(mode, {});
}

/**
 * Patch creature JSON files: write only `level`.
 * @param {string} mode
 * @param {object[]} mappedRows
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ written: number, skipped: number, missing: string[] }}
 */
function applyLevelPatch(mode, mappedRows, opts) {
    const dryRun = !!(opts && opts.dryRun);
    const dir = path.join(ROOT, 'presets', mode, 'creatures');
    let written = 0;
    let skipped = 0;
    /** @type {string[]} */
    const missing = [];

    for (const r of mappedRows) {
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
        const oldLv = raw.level != null ? Number(raw.level) || 0 : 0;
        const newLv = r.levelNew | 0;
        if (oldLv === newLv) {
            skipped++;
            continue;
        }
        if (!dryRun) {
            raw.level = newLv;
            fs.writeFileSync(full, formatJson(raw), {
                encoding: 'utf8',
                mode: 0o664
            });
        }
        written++;
    }
    return { written, skipped, missing };
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
        'avgHit',
        'burstDps',
        'maxHit',
        'hp',
        'atk',
        'nAttacks',
        'levelOld',
        'levelNew',
        'delta',
        'scaleExcluded',
        'scaleExcludeReasons'
    ];
    const lines = [headers.join(',')];
    for (const r of rows) {
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
function parseArgs(argv) {
    const opts = {
        mode: 'all',
        out: path.join(ROOT, 'reports'),
        apply: false,
        dryRun: true,
        winsorize: DEFAULT_WINSORIZE,
        eps: DEFAULT_EPS,
        fromReport: null,
        excludeIds: [],
        excludeHpMax: DEFAULT_EXCLUDE_HP_MAX,
        excludePatterns: true,
        printTop: 15,
        help: false
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
            case '--apply':
                opts.apply = true;
                opts.dryRun = false;
                break;
            case '--dry-run':
                opts.apply = false;
                opts.dryRun = true;
                break;
            case '--winsorize':
                opts.winsorize = Number(next());
                break;
            case '--eps':
                opts.eps = Number(next());
                break;
            case '--from-report':
                opts.fromReport = path.resolve(next());
                break;
            case '--exclude':
            case '--exclude-ids':
                opts.excludeIds = next()
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                break;
            case '--exclude-hp-max':
                opts.excludeHpMax = Number(next());
                break;
            case '--no-exclude-hp':
                opts.excludeHpMax = -1;
                break;
            case '--no-exclude-patterns':
                opts.excludePatterns = false;
                break;
            case '--top':
                opts.printTop = Math.max(0, parseInt(next(), 10) || 0);
                break;
            default:
                if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
        }
    }
    return opts;
}

function printHelp() {
    console.log(`Map creature level 1..1000 from threatDps (Phase 3 + 2b scale outliers).

Usage:
  node bin/map_creature_levels.js [options]
  npm run map:levels
  npm run map:levels -- --apply

Options:
  --mode <id>            standard | legacy | all   (default: all)
  --out <dir>            report directory          (default: reports/)
  --apply                write level into presets/…/creatures/*.json
  --dry-run              propose only (default)
  --winsorize <p>        endpoint percentile (default: ${DEFAULT_WINSORIZE} = p1/p99; 0 = pure min/max)
  --eps <n>              log(threatDps + eps)      (default: ${DEFAULT_EPS})
  --from-report <dir>    reuse creature_threat_<mode>.json instead of re-measure
  --exclude <ids>        extra comma ids omitted from scale endpoints (still mapped)
  --exclude-hp-max <n>   omit hp<=n from scale (default: ${DEFAULT_EXCLUDE_HP_MAX}; use -1 to disable)
  --no-exclude-hp        alias for --exclude-hp-max -1
  --no-exclude-patterns  disable name patterns (echo_of_*, *_pulse, soul shells)
  --top <n>              console top/bottom         (default: 15)
  -h, --help

Formula:
  x = log(threatDps + eps)
  // scale samples = positive DPS creatures NOT excluded (Phase 2b)
  t = clamp((x - x_lo) / (x_hi - x_lo), 0, 1)
  levelNew = 1 + round(999 * t)
  zero threatDps → level 1

Phase 2b defaults: hp<=1, default ids (energy_pulse, dummy, …), echo/pulse/soul-shell patterns.
Excluded creatures still get a level (usually 1000 if high DPS); they just do not set the ruler.

Only the top-level "level" field is patched. atk / attacks / exp are never rewritten.
`);
}

/**
 * @param {string} mode
 * @param {object} cli
 */
function runMode(mode, cli) {
    const rows = loadRows(mode, { fromReportDir: cli.fromReport });
    const proposed = proposeLevels(rows, {
        winsorize: cli.winsorize,
        eps: cli.eps,
        excludeIds: new Set(cli.excludeIds || []),
        excludeHpMax: cli.excludeHpMax,
        excludePatterns: cli.excludePatterns
    });

    const report = {
        generatedAt: new Date().toISOString(),
        mode,
        phase: '3+2b',
        applied: !!cli.apply,
        formula: {
            x: 'log(threatDps + eps)',
            levelNew: '1 + round(999 * clamp((x - x_lo)/(x_hi - x_lo), 0, 1))',
            zeroThreat: 'level 1',
            scaleExclude:
                'hp<=excludeHpMax (default 1); default ids; echo/pulse/soul-shell patterns; --exclude ids'
        },
        scale: {
            ...proposed.scale,
            // keep full exclude list in JSON but print summary only
            excludedFromScale: proposed.scale.excludedFromScale
        },
        summary: proposed.summary,
        creatures: proposed.rows
    };

    if (!fs.existsSync(cli.out)) {
        fs.mkdirSync(cli.out, { recursive: true, mode: 0o775 });
    }
    const base = path.join(cli.out, `creature_level_map_${mode}`);
    fs.writeFileSync(base + '.json', formatJson(report), 'utf8');
    fs.writeFileSync(base + '.csv', toCsv(proposed.rows), 'utf8');

    const s = proposed.summary;
    console.log(`\n=== ${mode} level map (${s.count} creatures)  phase 3+2b ===`);
    console.log(
        `scale ${proposed.scale.method}  xLo=${round6(proposed.scale.xLo)}  xHi=${round6(proposed.scale.xHi)}  nScale=${proposed.scale.nScale}  excludedFromScale=${proposed.scale.nExcludedFromScale}  excludeHpMax=${proposed.scale.excludeHpMax}  eps=${proposed.scale.eps}`
    );
    console.log(
        `levelNew  min=${s.levelNew.min}  max=${s.levelNew.max}  mean=${s.levelNew.mean}  unique=${s.levelNew.unique}`
    );
    console.log(
        `changed=${s.changed}  unchanged=${s.unchanged}  zeroThreat=${s.zeroThreat}  scaleExcluded=${s.scaleExcluded}`
    );
    console.log(
        `corr(levelNew,threatDps)=${s.corrNewLevelThreatDps}  corr(levelNew,logThreat)=${s.corrNewLevelLogThreat}  corr(eligible,logThreat)=${s.corrEligibleLevelLogThreat}`
    );
    console.log(`histogram100: ${JSON.stringify(s.histogram100)}`);
    console.log(`wrote ${base}.json`);
    console.log(`wrote ${base}.csv`);

    const topN = cli.printTop != null ? cli.printTop : 15;
    if (topN > 0) {
        console.log(`\nTop ${topN} scale-eligible by threatDps → levelNew:`);
        const elig = proposed.rows.filter((r) => r.threatDps > 0 && !r.scaleExcluded);
        for (const r of elig.slice(0, topN)) {
            console.log(
                `  dps=${pad(r.threatDps, 10)}  lv ${pad(r.levelOld, 4)}→${pad(r.levelNew, 4)}  (Δ${pad(r.delta, 5)})  ${r.id}`
            );
        }
        console.log(`\nTop ${Math.min(10, topN)} scale-EXCLUDED (still mapped, do not set ruler):`);
        const excl = proposed.rows.filter((r) => r.scaleExcluded);
        for (const r of excl.slice(0, Math.min(10, topN))) {
            console.log(
                `  dps=${pad(r.threatDps, 10)}  lv ${pad(r.levelOld, 4)}→${pad(r.levelNew, 4)}  hp=${pad(r.hp, 5)}  ${r.id}  [${r.scaleExcludeReasons}]`
            );
        }
    }

    const patch = applyLevelPatch(mode, proposed.rows, { dryRun: !cli.apply });
    if (cli.apply) {
        console.log(
            `APPLIED: wrote level on ${patch.written} files; skipped ${patch.skipped} (already mapped)`
        );
    } else {
        console.log(
            `DRY-RUN: would write level on ${patch.written} files; ${patch.skipped} already match`
        );
    }
    if (patch.missing.length) {
        console.warn(`missing files (${patch.missing.length}): ${patch.missing.slice(0, 5).join(', ')}`);
    }

    return { report, patch };
}

function pad(v, n) {
    return String(v).padStart(n);
}

function round6(n) {
    return Math.round(Number(n) * 1e6) / 1e6;
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

    console.log(
        `Phase 3+2b map levels 1..${LEVEL_MAX}  winsorize=${opts.winsorize}  excludeHpMax=${opts.excludeHpMax}  patterns=${opts.excludePatterns}  apply=${!!opts.apply}  fromReport=${opts.fromReport || '(live measure)'}`
    );

    for (const mode of modes) {
        runMode(mode, opts);
    }

    if (!opts.apply) {
        console.log('\nNo presets modified (dry-run). Re-run with --apply to patch level.');
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
    LEVEL_MIN,
    LEVEL_MAX,
    DEFAULT_EPS,
    DEFAULT_WINSORIZE,
    DEFAULT_EXCLUDE_HP_MAX,
    DEFAULT_SCALE_EXCLUDE_IDS,
    threatLog,
    scaleEndpoints,
    mapThreatToLevel,
    scaleExcludeDecision,
    proposeLevels,
    applyLevelPatch,
    loadRows,
    main
};
