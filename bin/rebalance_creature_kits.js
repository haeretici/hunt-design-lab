#!/usr/bin/env node
/**
 * Phase 5 — rebalance creature kits (attacks[] damage only).
 *
 * Goal: make kit threatDps intentional vs durability (HP), without inventing
 * player power curves. Relative kit shape is preserved (intervals, chances,
 * multi-hit ratios); only min/max and condition.totalDamage are scaled.
 *
 * Target model (fit per mode on scale-eligible creatures):
 *   log(threatDps) ≈ a + b * log(hp)
 *   targetDps(hp) = exp(a + b * log(hp))
 *
 * Scale-eligible for the fit:
 *   - threatDps > 0
 *   - hp > excludeHpMax (default 1 — shells stay out of the curve)
 *   - not in non-combat skip set
 *
 * Actions per creature:
 *   - skip: non-combat ids, hp shells (hp≤1), already ~on target (mult≈1)
 *   - scale: positive threat → multiply attack damage bands by target/current
 *   - repair: zero threat but looks combat-ready → inject/fill a melee band
 *             sized to targetDps (first zero-damage row, else append)
 *
 * Does NOT rewrite: level, hp, armor, flags, intervals, chances, structure.
 * After apply, re-run: npm run measure:threat && npm run map:levels -- --apply
 *
 * Usage:
 *   node bin/rebalance_creature_kits.js                  # dry-run
 *   node bin/rebalance_creature_kits.js --apply
 *   node bin/rebalance_creature_kits.js --mode standard --apply
 *   node bin/rebalance_creature_kits.js --mult-min 0.5 --mult-max 2   # soft
 *   node bin/rebalance_creature_kits.js --no-repair
 *   node bin/rebalance_creature_kits.js --from-report reports
 *   npm run rebalance:kits
 *   npm run rebalance:kits -- --apply
 *
 * Writes under --out (always):
 *   creature_kit_rebalance_<mode>.{json,csv}
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const {
    measureTemplate,
    loadModeCreatures
} = require('./measure_creature_threat.js');

const MODES = ['standard', 'legacy'];

/**
 * Intentional non-combat / prop / pet / dummy templates — leave kits alone.
 * @type {ReadonlySet<string>}
 */
const DEFAULT_NON_COMBAT_IDS = new Set([
    'dummy',
    'training_dummy',
    'training_machine',
    'floor_blob',
    'cat',
    'wild_dog',
    'halloween_hare',
    'the_halloween_hare',
    'chocolate_blob',
    'cream_blob',
    'death_thrower',
    'deaththrower',
    'spectral_scum',
    'weakened_demon'
]);

const DEFAULT_EXCLUDE_HP_MAX = 1;
/** Skip scale/repair when |log mult| is tiny (already on curve). */
const DEFAULT_MULT_EPS = 0.02;
/** Floor/ceiling for mult when soft rebalance is requested (null = full snap). */
const DEFAULT_MULT_MIN = null;
const DEFAULT_MULT_MAX = null;
const DEFAULT_MIN_TARGET_DPS = 0.5;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {object} */
    const opts = {
        apply: false,
        modes: MODES.slice(),
        out: path.join(ROOT, 'reports'),
        fromReportDir: null,
        excludeHpMax: DEFAULT_EXCLUDE_HP_MAX,
        multMin: DEFAULT_MULT_MIN,
        multMax: DEFAULT_MULT_MAX,
        multEps: DEFAULT_MULT_EPS,
        repair: true,
        minTargetDps: DEFAULT_MIN_TARGET_DPS,
        help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') opts.apply = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a === '--no-repair') opts.repair = false;
        else if (a === '--mode' && argv[i + 1]) {
            opts.modes = [String(argv[++i])];
        } else if (a === '--out' && argv[i + 1]) {
            opts.out = path.resolve(String(argv[++i]));
        } else if (a === '--from-report' && argv[i + 1]) {
            opts.fromReportDir = path.resolve(String(argv[++i]));
        } else if (a === '--exclude-hp-max' && argv[i + 1]) {
            opts.excludeHpMax = Number(argv[++i]);
        } else if (a === '--mult-min' && argv[i + 1]) {
            opts.multMin = Number(argv[++i]);
        } else if (a === '--mult-max' && argv[i + 1]) {
            opts.multMax = Number(argv[++i]);
        } else if (a === '--mult-eps' && argv[i + 1]) {
            opts.multEps = Number(argv[++i]);
        } else if (a === '--min-target-dps' && argv[i + 1]) {
            opts.minTargetDps = Number(argv[++i]);
        }
    }
    return opts;
}

/**
 * OLS: y = a + b * x
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {{ a: number, b: number, n: number }|null}
 */
function fitLogLinear(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return null;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
        const x = xs[i];
        const y = ys[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
    }
    const denom = n * sxx - sx * sx;
    if (!(Math.abs(denom) > 1e-12)) return null;
    const b = (n * sxy - sx * sy) / denom;
    const a = (sy - b * sx) / n;
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { a, b, n };
}

/**
 * @param {{ a: number, b: number }} fit
 * @param {number} hp
 * @param {number} minTarget
 * @returns {number}
 */
function targetDpsFromFit(fit, hp, minTarget) {
    const h = Math.max(1, Number(hp) || 1);
    const t = Math.exp(fit.a + fit.b * Math.log(h));
    const floor = minTarget > 0 ? minTarget : DEFAULT_MIN_TARGET_DPS;
    if (!Number.isFinite(t) || !(t > 0)) return floor;
    return Math.max(floor, t);
}

/**
 * @param {number} mult
 * @param {number|null} multMin
 * @param {number|null} multMax
 * @returns {number}
 */
function clampMult(mult, multMin, multMax) {
    let m = Number(mult);
    if (!(m > 0) || !Number.isFinite(m)) return 1;
    if (multMin != null && Number.isFinite(multMin) && m < multMin) m = multMin;
    if (multMax != null && Number.isFinite(multMax) && m > multMax) m = multMax;
    return m;
}

/**
 * Scale attack damage bands in place (template JSON attacks[]).
 * @param {object[]} attacks
 * @param {number} mult
 * @returns {number} rows touched
 */
function scaleAttacksDamage(attacks, mult) {
    const m = Number(mult);
    if (!Array.isArray(attacks) || !(m > 0) || m === 1) return 0;
    let touched = 0;
    for (let i = 0; i < attacks.length; i++) {
        const a = attacks[i];
        if (!a || typeof a !== 'object') continue;
        let row = false;
        if (a.min != null && Number.isFinite(Number(a.min))) {
            a.min = Math.max(0, Math.round(Number(a.min) * m));
            row = true;
        }
        if (a.max != null && Number.isFinite(Number(a.max))) {
            a.max = Math.max(0, Math.round(Number(a.max) * m));
            row = true;
        }
        if (
            a.min != null &&
            a.max != null &&
            Number(a.max) < Number(a.min)
        ) {
            const t = a.min;
            a.min = a.max;
            a.max = t;
        }
        if (
            a.condition &&
            typeof a.condition === 'object' &&
            a.condition.totalDamage != null &&
            Number.isFinite(Number(a.condition.totalDamage))
        ) {
            a.condition.totalDamage = Math.max(
                0,
                Math.round(Number(a.condition.totalDamage) * m)
            );
            row = true;
        }
        if (row) touched++;
    }
    return touched;
}

/**
 * Resolve attack interval in seconds from raw template fields.
 * @param {object} raw
 * @returns {number}
 */
function rawIntervalSec(raw) {
    if (!raw || typeof raw !== 'object') return 2;
    if (raw.intervalSec != null && Number(raw.intervalSec) > 0) {
        return Math.max(0.05, Number(raw.intervalSec));
    }
    if (raw.intervalMs != null && Number(raw.intervalMs) > 0) {
        return Math.max(0.05, Number(raw.intervalMs) / 1000);
    }
    if (raw.interval != null && Number(raw.interval) > 0) {
        const n = Number(raw.interval);
        // Legacy often stores ms when large
        return Math.max(0.05, n >= 50 ? n / 1000 : n);
    }
    return 2;
}

/**
 * min=0 band: threatDps ≈ (max/2) * (chance/100) / intervalSec
 * ⇒ max ≈ 2 * target * intervalSec / p
 * @param {number} targetDps
 * @param {{ intervalSec?: number, chance?: number }} [opts]
 * @returns {number}
 */
function maxForTargetDps(targetDps, opts) {
    const t = Math.max(
        DEFAULT_MIN_TARGET_DPS,
        Number(targetDps) || DEFAULT_MIN_TARGET_DPS
    );
    const o = opts || {};
    const intervalSec = Math.max(0.05, Number(o.intervalSec) || 2);
    const chance = Math.max(1, Math.min(100, Number(o.chance) || 100));
    const p = chance / 100;
    const max = (2 * t * intervalSec) / p;
    return Math.max(1, Math.round(max));
}

/**
 * Build a single melee band with expected threat ≈ targetDps (2s / chance 100).
 * @param {number} targetDps
 * @param {string} [id]
 * @returns {object}
 */
function makeMeleeForTarget(targetDps, id) {
    return {
        id: id || 'melee_0',
        kind: 'melee',
        intervalMs: 2000,
        chance: 100,
        range: 1,
        element: 'physical',
        min: 0,
        max: maxForTargetDps(targetDps, { intervalSec: 2, chance: 100 })
    };
}

/**
 * Fill first zero-damage row or append melee so measureTemplate threat ≈ target.
 * Uses the row's existing interval/chance when filling so the band matches targetDps.
 * @param {object} template
 * @param {number} targetDps
 * @returns {'filled'|'appended'|'none'}
 */
function repairZeroKit(template, targetDps) {
    if (!template || typeof template !== 'object') return 'none';
    if (!Array.isArray(template.attacks)) template.attacks = [];
    const attacks = template.attacks;

    // Prefer first row that is zero-band (including statusOnly with no damage).
    for (let i = 0; i < attacks.length; i++) {
        const a = attacks[i];
        if (!a || typeof a !== 'object') continue;
        const min = Number(a.min) || 0;
        const max = Number(a.max) || 0;
        const td =
            a.condition && a.condition.totalDamage != null
                ? Math.abs(Number(a.condition.totalDamage) || 0)
                : 0;
        if (min === 0 && max === 0 && !(td > 0)) {
            if (a.chance == null) a.chance = 100;
            if (
                a.intervalMs == null &&
                a.interval == null &&
                a.intervalSec == null
            ) {
                a.intervalMs = 2000;
            }
            const intervalSec = rawIntervalSec(a);
            const chance = Math.max(1, Math.min(100, Number(a.chance) || 100));
            a.min = 0;
            a.max = maxForTargetDps(targetDps, { intervalSec, chance });
            if (a.kind == null) a.kind = 'melee';
            if (a.statusOnly) delete a.statusOnly;
            return 'filled';
        }
    }
    attacks.push(makeMeleeForTarget(targetDps, 'melee_rebalance_0'));
    return 'appended';
}

/**
 * @param {object} row measure row
 * @param {object} opts
 * @returns {boolean}
 */
function isNonCombat(row, opts) {
    const id = String(row.id || '');
    if (DEFAULT_NON_COMBAT_IDS.has(id)) return true;
    if (opts.extraNonCombat instanceof Set && opts.extraNonCombat.has(id)) {
        return true;
    }
    return false;
}

/**
 * @param {object} row
 * @param {number} excludeHpMax
 * @returns {boolean}
 */
function isShell(row, excludeHpMax) {
    const hp = row.hp != null ? Number(row.hp) || 0 : 0;
    const cap =
        excludeHpMax != null && Number.isFinite(Number(excludeHpMax))
            ? Number(excludeHpMax)
            : DEFAULT_EXCLUDE_HP_MAX;
    return hp <= cap;
}

/**
 * Fit + propose rebalance actions for one mode.
 * @param {object[]} rows measure rows
 * @param {object} [opts]
 * @returns {{ fit: object, proposals: object[], summary: object }}
 */
function proposeRebalance(rows, opts) {
    const o = opts || {};
    const excludeHpMax =
        o.excludeHpMax != null ? Number(o.excludeHpMax) : DEFAULT_EXCLUDE_HP_MAX;
    const multMin = o.multMin != null ? o.multMin : null;
    const multMax = o.multMax != null ? o.multMax : null;
    const multEps =
        o.multEps != null && Number(o.multEps) >= 0
            ? Number(o.multEps)
            : DEFAULT_MULT_EPS;
    const repair = o.repair !== false;
    const minTarget =
        o.minTargetDps != null && Number(o.minTargetDps) > 0
            ? Number(o.minTargetDps)
            : DEFAULT_MIN_TARGET_DPS;

    /** @type {number[]} */
    const xs = [];
    /** @type {number[]} */
    const ys = [];
    for (const r of rows) {
        if (!(r.threatDps > 0)) continue;
        if (isShell(r, excludeHpMax)) continue;
        if (isNonCombat(r, o)) continue;
        const hp = Math.max(1, Number(r.hp) || 1);
        xs.push(Math.log(hp));
        ys.push(Math.log(r.threatDps));
    }

    let fit = fitLogLinear(xs, ys);
    // Fallback: global median ratio if fit fails
    if (!fit) {
        const ratios = [];
        for (const r of rows) {
            if (!(r.threatDps > 0) || isShell(r, excludeHpMax) || isNonCombat(r, o)) {
                continue;
            }
            const hp = Math.max(1, Number(r.hp) || 1);
            ratios.push(r.threatDps / Math.sqrt(hp));
        }
        ratios.sort((a, b) => a - b);
        const med =
            ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : 1;
        // threat ≈ med * sqrt(hp) → log t = log(med) + 0.5 log(hp)
        fit = { a: Math.log(Math.max(1e-6, med)), b: 0.5, n: ratios.length, fallback: true };
    } else {
        fit = Object.assign({}, fit, { fallback: false });
    }

    /** @type {object[]} */
    const proposals = [];
    let nScale = 0;
    let nRepair = 0;
    let nSkip = 0;
    let nSkipNear = 0;

    for (const r of rows) {
        const id = String(r.id || '');
        const hp = r.hp != null ? Number(r.hp) || 0 : 0;
        const threat = Number(r.threatDps) || 0;
        const target = targetDpsFromFit(fit, Math.max(1, hp), minTarget);

        /** @type {object} */
        const prop = {
            id,
            mode: r.mode,
            file: r.file || `${id}.json`,
            hp,
            exp: r.exp != null ? Number(r.exp) || 0 : 0,
            threatDps: threat,
            targetDps: round4(target),
            mult: 1,
            action: 'skip',
            reason: '',
            nAttacks: r.nAttacks,
            nOffensive: r.nOffensive
        };

        if (isNonCombat(r, o)) {
            prop.reason = 'non_combat';
            nSkip++;
            proposals.push(prop);
            continue;
        }
        if (isShell(r, excludeHpMax)) {
            prop.reason = `hp_shell<=${excludeHpMax}`;
            nSkip++;
            proposals.push(prop);
            continue;
        }

        if (threat > 0) {
            let mult = target / threat;
            mult = clampMult(mult, multMin, multMax);
            prop.mult = round6(mult);
            // Near target after clamp?
            const err = Math.abs(Math.log(mult));
            if (!(err > multEps)) {
                prop.action = 'skip';
                prop.reason = 'near_target';
                nSkipNear++;
                proposals.push(prop);
                continue;
            }
            prop.action = 'scale';
            prop.reason = multMin != null || multMax != null ? 'scale_clamped' : 'scale_full';
            nScale++;
            proposals.push(prop);
            continue;
        }

        // Zero threat
        if (!repair) {
            prop.reason = 'zero_no_repair';
            nSkip++;
            proposals.push(prop);
            continue;
        }
        // Harmless zero-exp critters already in non-combat; remaining zeros get repair.
        prop.action = 'repair';
        prop.reason = 'zero_offense';
        prop.mult = 1;
        prop.targetDps = round4(target);
        nRepair++;
        proposals.push(prop);
    }

    const summary = {
        count: rows.length,
        fit: {
            a: round6(fit.a),
            b: round6(fit.b),
            n: fit.n,
            fallback: !!fit.fallback,
            formula: 'threatDps ≈ exp(a + b * log(hp))'
        },
        nScale,
        nRepair,
        nSkip,
        nSkipNear,
        multMin,
        multMax,
        multEps,
        excludeHpMax,
        repair
    };

    return { fit, proposals, summary };
}

/**
 * Apply one proposal to a template object (mutates attacks[]).
 * @param {object} template
 * @param {object} prop
 * @returns {{ ok: boolean, detail: string }}
 */
function applyProposalToTemplate(template, prop) {
    if (!template || !prop) return { ok: false, detail: 'missing' };
    if (prop.action === 'scale') {
        if (!Array.isArray(template.attacks)) {
            return { ok: false, detail: 'no_attacks' };
        }
        const n = scaleAttacksDamage(template.attacks, prop.mult);
        return { ok: n > 0, detail: `scaled_rows=${n}` };
    }
    if (prop.action === 'repair') {
        const how = repairZeroKit(template, prop.targetDps);
        return { ok: how !== 'none', detail: how };
    }
    return { ok: false, detail: 'skip' };
}

/**
 * @param {string} mode
 * @param {object[]} proposals
 * @param {{ apply: boolean }} opts
 * @returns {{ written: number, skipped: number, missing: string[], errors: string[] }}
 */
function applyProposals(mode, proposals, opts) {
    const apply = !!(opts && opts.apply);
    const dir = path.join(ROOT, 'presets', mode, 'creatures');
    let written = 0;
    let skipped = 0;
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const errors = [];

    for (const prop of proposals) {
        if (prop.action === 'skip') {
            skipped++;
            continue;
        }
        const file = prop.file || `${prop.id}.json`;
        const full = path.join(dir, file);
        if (!fs.existsSync(full)) {
            missing.push(`${mode}/${file}`);
            continue;
        }
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (e) {
            errors.push(`${mode}/${file}: ${e.message}`);
            continue;
        }
        if (!raw || typeof raw !== 'object') {
            errors.push(`${mode}/${file}: not object`);
            continue;
        }
        const before = measureTemplate(raw);
        const result = applyProposalToTemplate(raw, prop);
        if (!result.ok) {
            errors.push(`${mode}/${file}: ${result.detail}`);
            continue;
        }
        const after = measureTemplate(raw);
        prop.threatDpsAfter = after.threatDps;
        prop.detail = result.detail;
        prop.threatDpsBefore = before.threatDps;

        if (apply) {
            const out = formatJson(raw);
            fs.writeFileSync(full, out, 'utf8');
            try {
                fs.chmodSync(full, 0o664);
            } catch (_) {
                /* ignore */
            }
            written++;
        } else {
            // dry-run: still count as would-write
            written++;
        }
    }
    return { written, skipped, missing, errors };
}

/**
 * Load measure rows for a mode.
 * @param {string} mode
 * @param {{ fromReportDir?: string|null }} [opts]
 */
function loadRows(mode, opts) {
    const o = opts || {};
    if (o.fromReportDir) {
        const p = path.join(o.fromReportDir, `creature_threat_${mode}.json`);
        if (!fs.existsSync(p)) {
            throw new Error(
                `Threat report missing: ${p} (run npm run measure:threat first)`
            );
        }
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        const list = Array.isArray(doc.creatures) ? doc.creatures : [];
        return list.map((r) => ({
            ...r,
            mode: r.mode || mode,
            file: r.file || `${r.id}.json`
        }));
    }
    return loadModeCreatures(mode, {});
}

/**
 * @param {number} n
 */
function round4(n) {
    return Math.round(Number(n) * 1e4) / 1e4;
}

/**
 * @param {number} n
 */
function round6(n) {
    return Math.round(Number(n) * 1e6) / 1e6;
}

/**
 * @param {object[]} proposals
 * @returns {string}
 */
function proposalsToCsv(proposals) {
    const cols = [
        'id',
        'action',
        'reason',
        'hp',
        'threatDps',
        'targetDps',
        'mult',
        'threatDpsAfter',
        'nAttacks',
        'nOffensive',
        'exp'
    ];
    const lines = [cols.join(',')];
    for (const p of proposals) {
        lines.push(
            cols
                .map((c) => {
                    const v = p[c];
                    if (v == null) return '';
                    const s = String(v);
                    return s.includes(',') || s.includes('"')
                        ? `"${s.replace(/"/g, '""')}"`
                        : s;
                })
                .join(',')
        );
    }
    return lines.join('\n') + '\n';
}

/**
 * @param {string} mode
 * @param {object} opts
 */
function runMode(mode, opts) {
    const rows = loadRows(mode, { fromReportDir: opts.fromReportDir });
    const { fit, proposals, summary } = proposeRebalance(rows, {
        excludeHpMax: opts.excludeHpMax,
        multMin: opts.multMin,
        multMax: opts.multMax,
        multEps: opts.multEps,
        repair: opts.repair,
        minTargetDps: opts.minTargetDps
    });

    // For dry-run, simulate after-threat via mult only (scale) / target (repair)
    if (!opts.apply) {
        for (const p of proposals) {
            if (p.action === 'scale') {
                p.threatDpsAfter = round4(p.threatDps * p.mult);
            } else if (p.action === 'repair') {
                p.threatDpsAfter = p.targetDps;
            } else {
                p.threatDpsAfter = p.threatDps;
            }
        }
    }

    const applyResult = applyProposals(mode, proposals, { apply: opts.apply });

    if (!fs.existsSync(opts.out)) {
        fs.mkdirSync(opts.out, { recursive: true });
    }
    const doc = {
        generatedAt: new Date().toISOString(),
        phase: 5,
        mode,
        apply: !!opts.apply,
        fit: summary.fit,
        summary: Object.assign({}, summary, {
            written: applyResult.written,
            skippedFiles: applyResult.skipped,
            missing: applyResult.missing.length,
            errors: applyResult.errors.length
        }),
        missing: applyResult.missing,
        errors: applyResult.errors.slice(0, 50),
        proposals
    };
    const jsonPath = path.join(opts.out, `creature_kit_rebalance_${mode}.json`);
    const csvPath = path.join(opts.out, `creature_kit_rebalance_${mode}.csv`);
    fs.writeFileSync(jsonPath, formatJson(doc), 'utf8');
    fs.writeFileSync(csvPath, proposalsToCsv(proposals), 'utf8');

    console.log(`\n=== ${mode} kit rebalance (Phase 5) apply=${!!opts.apply} ===`);
    console.log(
        `fit: threatDps ≈ exp(${summary.fit.a} + ${summary.fit.b} * log(hp))  n=${summary.fit.n}` +
            (summary.fit.fallback ? '  [fallback sqrt]' : '')
    );
    console.log(
        `actions: scale=${summary.nScale} repair=${summary.nRepair} skipNear=${summary.nSkipNear} skipOther=${summary.nSkip}`
    );
    console.log(
        `${opts.apply ? 'wrote' : 'wouldWrite'}=${applyResult.written}  missing=${applyResult.missing.length}  errors=${applyResult.errors.length}`
    );
    if (applyResult.errors.length) {
        console.log('  errors sample:', applyResult.errors.slice(0, 5).join(' | '));
    }
    // Sample largest mults
    const scales = proposals
        .filter((p) => p.action === 'scale')
        .slice()
        .sort((a, b) => b.mult - a.mult);
    console.log('Top scale-ups:');
    scales.slice(0, 8).forEach((p) => {
        console.log(
            `  ×${String(p.mult).padStart(8)}  ${p.threatDps} → ~${p.threatDpsAfter || p.targetDps}  hp=${p.hp}  ${p.id}`
        );
    });
    console.log('Top scale-downs:');
    scales
        .slice()
        .sort((a, b) => a.mult - b.mult)
        .slice(0, 8)
        .forEach((p) => {
            console.log(
                `  ×${String(p.mult).padStart(8)}  ${p.threatDps} → ~${p.threatDpsAfter || p.targetDps}  hp=${p.hp}  ${p.id}`
            );
        });
    const repairs = proposals.filter((p) => p.action === 'repair');
    if (repairs.length) {
        console.log(`Repairs (${repairs.length}):`);
        repairs.slice(0, 12).forEach((p) => {
            console.log(`  ${p.id}  hp=${p.hp}  targetDps=${p.targetDps}`);
        });
    }
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${csvPath}`);
    return doc;
}

/**
 * @param {string[]} argv
 */
function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        console.log(`Phase 5 — rebalance creature kit damage (attacks[] only).

Usage:
  node bin/rebalance_creature_kits.js [--mode standard|legacy] [--apply]
  node bin/rebalance_creature_kits.js --mult-min 0.5 --mult-max 2
  node bin/rebalance_creature_kits.js --from-report reports --apply
  node bin/rebalance_creature_kits.js --no-repair

Target: threatDps ≈ exp(a + b * log(hp)) fitted on positive-DPS non-shells.
Scales min/max + DoT totalDamage; repairs zero-offense combat templates.
Skips: dummy/pet/prop ids, hp≤1 shells.

After --apply:
  npm run measure:threat
  npm run map:levels -- --apply`);
        return 0;
    }

    console.log(
        `Phase 5 kit rebalance  apply=${opts.apply}  modes=${opts.modes.join(',')}  ` +
            `multMin=${opts.multMin} multMax=${opts.multMax} repair=${opts.repair}`
    );

    for (const mode of opts.modes) {
        runMode(mode, opts);
    }

    if (!opts.apply) {
        console.log(
            '\nDry-run only. Re-run with --apply to write attacks[] patches.'
        );
    } else {
        console.log(
            '\nKits updated. Next: npm run measure:threat && npm run map:levels -- --apply'
        );
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
    DEFAULT_NON_COMBAT_IDS,
    proposeRebalance,
    scaleAttacksDamage,
    repairZeroKit,
    makeMeleeForTarget,
    maxForTargetDps,
    fitLogLinear,
    targetDpsFromFit,
    main
};
