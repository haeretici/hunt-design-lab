/**
 * Pure balance-analysis helpers (Stage 8).
 * Browser-safe: no fs, no headless runner. Shared by CLI, tests, and Analysis UI.
 */

'use strict';

/** Result schema for analysis UI + CLI. */
const SWEEP_SCHEMA_VERSION = 1;

/**
 * Human-readable labels for chart legend / table headers.
 * @type {Record<string, string>}
 */
const METRIC_LABELS = {
    routeCompleteRate: 'Route complete %',
    partyWipeRate: 'Party wipe %',
    timeoutRate: 'Timeout %',
    noAttackTimeoutRate: 'No-attack timeout %',
    killCapRate: 'Kill cap %',
    wavesCompleteRate: 'Waves complete %',
    meanKills: 'Mean kills',
    meanDeaths: 'Mean deaths',
    meanDamageDealt: 'Mean damage dealt',
    meanDamageTaken: 'Mean damage taken',
    meanExpGained: 'Mean exp',
    meanExpPerHour: 'Mean exp/h',
    meanTimeToClear: 'Mean time (s)',
    meanTickCount: 'Mean ticks'
};

/**
 * Preferred primary filenames when loading a results folder.
 * First match wins for “set document” kinds.
 * @type {string[]}
 */
const FOLDER_PRIMARY_NAMES = [
    'class_matrix.json',
    'strategy_eval.json',
    'sweep.json',
    'batch_aggregate.json',
    'sample_standard_arena_class_matrix.json',
    'sample_standard_arena_strategy_eval.json',
    'sample_creature_hp_sweep.json',
    'sample_golden_cave_crawl_batch.json',
    'sample_standard_arena_tier_compare.json'
];

/**
 * Knob metadata (apply lives in balance_sweep.js — Node only).
 * @type {Record<string, { id: string, label: string, unit: string, defaultValues: number[] }>}
 */
const KNOB_META = {
    creature_hp: {
        id: 'creature_hp',
        label: 'Creature HP scale',
        unit: '×',
        // Wide range so floor07 rats show clear time/damage curves
        defaultValues: [1, 5, 10, 20, 50]
    },
    creature_armor: {
        id: 'creature_armor',
        label: 'Creature armor scale',
        unit: '×',
        defaultValues: [0, 0.5, 1, 2, 4]
    },
    spell_power: {
        id: 'spell_power',
        label: 'Spell basePower scale',
        unit: '×',
        defaultValues: [0.5, 1, 1.5, 2, 3]
    },
    equipment_armor: {
        id: 'equipment_armor',
        label: 'Equipment armor scale',
        unit: '×',
        defaultValues: [0, 0.5, 1, 2, 3]
    },
    spawn_density: {
        id: 'spawn_density',
        label: 'Spawn density',
        unit: '×',
        defaultValues: [0.5, 1, 1.5, 2, 3]
    },
    population_density: {
        id: 'population_density',
        label: 'Population density',
        unit: '×',
        defaultValues: [0.5, 1, 1.5, 2]
    }
};

/**
 * @returns {{ id: string, label: string, unit: string, defaultValues: number[] }[]}
 */
function listKnobs() {
    return Object.keys(KNOB_META).map((id) => {
        const k = KNOB_META[id];
        return {
            id: k.id,
            label: k.label,
            unit: k.unit,
            defaultValues: k.defaultValues.slice()
        };
    });
}

/**
 * Parse comma/space separated numeric list: "0.5,1,2" or "0.5 1 2".
 * @param {string|number[]|null|undefined} raw
 * @returns {number[]|null}
 */
function parseValueList(raw) {
    if (raw == null || raw === '') return null;
    if (Array.isArray(raw)) {
        return raw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    }
    const parts = String(raw)
        .split(/[\s,;]+/)
        .filter(Boolean);
    const out = [];
    for (let i = 0; i < parts.length; i++) {
        const n = Number(parts[i]);
        if (Number.isFinite(n)) out.push(n);
    }
    return out.length ? out : null;
}

/**
 * Metrics row for one knob value (from aggregateSummaries).
 * @param {object} aggregate
 * @returns {object}
 */
function metricsFromAggregate(aggregate) {
    const n = (aggregate && aggregate.iterations) || 0;
    const outcomes = (aggregate && aggregate.outcomes) || {};
    const means = (aggregate && aggregate.means) || {};
    return {
        iterations: n,
        routeCompleteRate: n ? (outcomes.routeComplete || 0) / n : 0,
        partyWipeRate: n ? (outcomes.partyWipe || 0) / n : 0,
        timeoutRate: n ? (outcomes.timeout || 0) / n : 0,
        noAttackTimeoutRate: n ? (outcomes.noAttackTimeout || 0) / n : 0,
        killCapRate: n ? (outcomes.killCap || 0) / n : 0,
        wavesCompleteRate: n ? (outcomes.wavesComplete || 0) / n : 0,
        meanKills: means.kills || 0,
        meanDeaths: means.deaths || 0,
        meanDamageDealt: means.damageDealt || 0,
        meanDamageTaken: means.damageTaken || 0,
        meanExpGained: means.expGained || 0,
        meanExpPerHour: means.expPerHour || 0,
        meanTimeToClear: means.timeToClear || 0,
        meanTickCount: means.tickCount || 0,
        outcomes: {
            routeComplete: outcomes.routeComplete || 0,
            partyWipe: outcomes.partyWipe || 0,
            timeout: outcomes.timeout || 0,
            noAttackTimeout: outcomes.noAttackTimeout || 0,
            killCap: outcomes.killCap || 0,
            wavesComplete: outcomes.wavesComplete || 0
        }
    };
}

/**
 * @param {string} key
 * @returns {string}
 */
function metricLabel(key) {
    if (!key) return '';
    return METRIC_LABELS[key] || key;
}

/**
 * Group flat result file entries by directory for folder-first UI.
 * @param {Array<{ path?: string, dir?: string, name?: string, label?: string, mtime?: number, size?: number }>} files
 * @returns {Array<{
 *   path: string,
 *   fileCount: number,
 *   mtime: number,
 *   primaryName: string|null,
 *   files: Array<object>,
 *   label: string
 * }>}
 */
function groupResultFilesByFolder(files) {
    const list = Array.isArray(files) ? files : [];
    /** @type {Map<string, { path: string, files: object[], mtime: number }>} */
    const map = new Map();

    for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!f) continue;
        const dir =
            f.dir ||
            (f.path && f.path.lastIndexOf('/') >= 0
                ? f.path.slice(0, f.path.lastIndexOf('/'))
                : f.path) ||
            '';
        if (!dir) continue;
        let bucket = map.get(dir);
        if (!bucket) {
            bucket = { path: dir, files: [], mtime: 0 };
            map.set(dir, bucket);
        }
        bucket.files.push(f);
        const mt = Number(f.mtime) || 0;
        if (mt > bucket.mtime) bucket.mtime = mt;
    }

    const folders = [];
    for (const bucket of map.values()) {
        const names = bucket.files.map((f) => f.name || baseName(f.path || ''));
        let primaryName = null;
        for (let p = 0; p < FOLDER_PRIMARY_NAMES.length; p++) {
            if (names.indexOf(FOLDER_PRIMARY_NAMES[p]) >= 0) {
                primaryName = FOLDER_PRIMARY_NAMES[p];
                break;
            }
        }
        const short = bucket.path.split('/').filter(Boolean).slice(-2).join('/');
        folders.push({
            path: bucket.path,
            fileCount: bucket.files.length,
            mtime: bucket.mtime,
            primaryName,
            files: bucket.files,
            label: `${short} · ${bucket.files.length} file${bucket.files.length === 1 ? '' : 's'}${primaryName ? ` · ${primaryName}` : ''}`
        });
    }

    folders.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    return folders;
}

/**
 * @param {string} p
 * @returns {string}
 */
function baseName(p) {
    const s = String(p || '');
    const i = s.lastIndexOf('/');
    return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Metrics from a single hunt summary document.
 * @param {object} doc
 * @returns {object|null}
 */
function metricsFromHuntSummary(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const state =
        doc.sessionState != null
            ? String(doc.sessionState)
            : doc.endReason != null
              ? String(doc.endReason)
              : null;
    if (state == null && doc.kills == null && doc.tickCount == null) return null;

    return {
        iterations: 1,
        routeCompleteRate: state === 'route_complete' ? 1 : 0,
        partyWipeRate: state === 'party_wipe' ? 1 : 0,
        timeoutRate: state === 'timeout' ? 1 : 0,
        noAttackTimeoutRate: state === 'no_attack_timeout' ? 1 : 0,
        killCapRate: state === 'kill_cap' ? 1 : 0,
        wavesCompleteRate: state === 'waves_complete' ? 1 : 0,
        meanKills: doc.kills || 0,
        meanDeaths: doc.deaths || 0,
        meanDamageDealt: doc.damageDealt || 0,
        meanDamageTaken: doc.damageTaken || 0,
        meanExpGained: doc.expGained || 0,
        meanExpPerHour: doc.expPerHour || 0,
        meanTimeToClear: doc.timeToClear || 0,
        meanTickCount: doc.tickCount || 0,
        outcomes: {
            routeComplete: state === 'route_complete' ? 1 : 0,
            partyWipe: state === 'party_wipe' ? 1 : 0,
            timeout: state === 'timeout' ? 1 : 0,
            noAttackTimeout: state === 'no_attack_timeout' ? 1 : 0,
            killCap: state === 'kill_cap' ? 1 : 0,
            wavesComplete: state === 'waves_complete' ? 1 : 0
        }
    };
}

/**
 * Build one chartable analysis document from all JSON docs in a folder.
 * Prefers sweep/matrix/strategy_eval primaries; otherwise multi-seed rows
 * from hunt summaries + optional batch_aggregate headline.
 *
 * @param {Array<{ path?: string, name?: string, document?: object }>} entries
 * @param {string} [folderPath]
 * @returns {object|null}
 */
function documentFromFolderEntries(entries, folderPath) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return null;

    /** @type {Map<string, object>} */
    const byName = new Map();
    const docs = [];
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const doc = e && e.document;
        if (!doc || typeof doc !== 'object') continue;
        const name = e.name || baseName(e.path || '');
        byName.set(name, doc);
        docs.push({ name, path: e.path || name, document: doc });
    }
    if (!docs.length) return null;

    // Prefer primary multi-row analysis docs (skip batch_aggregate — expand seeds)
    for (let p = 0; p < FOLDER_PRIMARY_NAMES.length; p++) {
        const name = FOLDER_PRIMARY_NAMES[p];
        if (!byName.has(name)) continue;
        if (name === 'batch_aggregate.json') continue;
        const primary = byName.get(name);
        // Sample golden batch is kind:batch — normalize separately
        if (primary && primary.kind === 'batch') {
            const normBatch = normalizeAnalysisDocument(primary);
            if (normBatch) {
                normBatch.folderPath = folderPath || null;
                normBatch.sourceFile = name;
                return normBatch;
            }
            continue;
        }
        const norm = normalizeAnalysisDocument(primary);
        if (norm && Array.isArray(norm.rows) && norm.rows.length) {
            norm.folderPath = folderPath || null;
            norm.sourceFile = name;
            return norm;
        }
    }

    // Multi-seed: individual hunt summaries
    const seedRows = [];
    let huntId = null;
    for (let i = 0; i < docs.length; i++) {
        const { name, document: doc } = docs[i];
        if (name === 'batch_aggregate.json') continue;
        if (
            doc.kind === 'sweep' ||
            doc.kind === 'class_matrix' ||
            doc.kind === 'strategy_eval' ||
            doc.kind === 'side_swap' ||
            doc.kind === 'batch'
        ) {
            continue;
        }
        // Skip aggregate-shaped without session
        if (doc.means && doc.outcomes && doc.iterations != null && !doc.sessionState) {
            continue;
        }
        const metrics = metricsFromHuntSummary(doc);
        if (!metrics) continue;
        const seed =
            doc.seed != null
                ? doc.seed
                : doc.config && doc.config.seed != null
                  ? doc.config.seed
                  : null;
        if (!huntId) {
            huntId =
                doc.huntId ||
                (doc.config && doc.config.huntId) ||
                null;
        }
        seedRows.push({
            value: seed != null ? seed : seedRows.length,
            label: seed != null ? `seed ${seed}` : name.replace(/\.json$/i, ''),
            metrics,
            sourceFile: name
        });
    }

    seedRows.sort((a, b) => {
        const av = Number(a.value);
        const bv = Number(b.value);
        if (Number.isFinite(av) && Number.isFinite(bv)) return av - bv;
        return String(a.label).localeCompare(String(b.label));
    });

    const aggDoc = byName.get('batch_aggregate.json') || null;

    if (seedRows.length) {
        const chartMetrics = [
            'meanKills',
            'partyWipeRate',
            'noAttackTimeoutRate',
            'meanTimeToClear',
            'meanExpPerHour',
            'routeCompleteRate'
        ];
        /** @type {object} */
        const out = {
            schemaVersion: SWEEP_SCHEMA_VERSION,
            kind: 'batch_folder',
            knob: 'seed',
            knobLabel: 'Per-seed runs',
            huntId,
            folderPath: folderPath || null,
            iterationsPerValue: 1,
            chartMetrics,
            rows: seedRows
        };
        if (aggDoc && aggDoc.means && aggDoc.outcomes) {
            out.aggregateMetrics = metricsFromAggregate(aggDoc);
            out.iterations = aggDoc.iterations;
            out.seeds = aggDoc.seeds;
        }
        return out;
    }

    if (aggDoc && aggDoc.means && aggDoc.outcomes) {
        const norm = normalizeAnalysisDocument(aggDoc);
        if (norm) {
            norm.folderPath = folderPath || null;
            return norm;
        }
    }

    // Last resort: first normalizable doc
    for (let i = 0; i < docs.length; i++) {
        const norm = normalizeAnalysisDocument(docs[i].document);
        if (norm) {
            norm.folderPath = folderPath || null;
            norm.sourceFile = docs[i].name;
            return norm;
        }
    }
    return null;
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmtNum(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    const v = Number(n);
    if (Math.abs(v) >= 100 || Number.isInteger(v)) {
        return String(Math.round(v * 1000) / 1000);
    }
    return String(Math.round(v * 10000) / 10000);
}

/**
 * TSV for spreadsheet / analysis UI table.
 * @param {object} sweepResult
 * @returns {string}
 */
function sweepToTsv(sweepResult) {
    const headers = [
        'value',
        'iterations',
        'route_complete_rate',
        'party_wipe_rate',
        'timeout_rate',
        'mean_kills',
        'mean_deaths',
        'mean_damage_dealt',
        'mean_damage_taken',
        'mean_exp',
        'mean_exp_per_hour',
        'mean_time_to_clear',
        'mean_ticks',
        'route_complete',
        'party_wipe',
        'timeout',
        'kill_cap',
        'waves_complete'
    ];
    const lines = [headers.join('\t')];
    const rows = (sweepResult && sweepResult.rows) || [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const m = r.metrics || {};
        const oc = m.outcomes || {};
        lines.push(
            [
                r.value,
                m.iterations != null ? m.iterations : '',
                fmtNum(m.routeCompleteRate),
                fmtNum(m.partyWipeRate),
                fmtNum(m.timeoutRate),
                fmtNum(m.meanKills),
                fmtNum(m.meanDeaths),
                fmtNum(m.meanDamageDealt),
                fmtNum(m.meanDamageTaken),
                fmtNum(m.meanExpGained),
                fmtNum(m.meanExpPerHour),
                fmtNum(m.meanTimeToClear),
                fmtNum(m.meanTickCount),
                oc.routeComplete != null ? oc.routeComplete : '',
                oc.partyWipe != null ? oc.partyWipe : '',
                oc.timeout != null ? oc.timeout : '',
                oc.killCap != null ? oc.killCap : '',
                oc.wavesComplete != null ? oc.wavesComplete : ''
            ].join('\t')
        );
    }
    return lines.join('\n') + '\n';
}

/**
 * @param {object} matrixResult
 * @returns {string}
 */
function classMatrixToTsv(matrixResult) {
    const headers = [
        'class_id',
        'iterations',
        'route_complete_rate',
        'party_wipe_rate',
        'mean_kills',
        'mean_deaths',
        'mean_exp_per_hour',
        'mean_time_to_clear',
        'mean_damage_dealt',
        'route_complete',
        'party_wipe'
    ];
    const lines = [headers.join('\t')];
    const rows = (matrixResult && matrixResult.rows) || [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const m = r.metrics || {};
        const oc = m.outcomes || {};
        lines.push(
            [
                r.classId || r.label || '',
                m.iterations != null ? m.iterations : '',
                fmtNum(m.routeCompleteRate),
                fmtNum(m.partyWipeRate),
                fmtNum(m.meanKills),
                fmtNum(m.meanDeaths),
                fmtNum(m.meanExpPerHour),
                fmtNum(m.meanTimeToClear),
                fmtNum(m.meanDamageDealt),
                oc.routeComplete != null ? oc.routeComplete : '',
                oc.partyWipe != null ? oc.partyWipe : ''
            ].join('\t')
        );
    }
    return lines.join('\n') + '\n';
}

/**
 * TSV for strategy preset eval ranking (Stage 12F).
 * @param {object} evalResult
 * @returns {string}
 */
function strategyEvalToTsv(evalResult) {
    const headers = [
        'rank',
        'strategy_id',
        'iterations',
        'route_complete_rate',
        'party_wipe_rate',
        'timeout_rate',
        'mean_kills',
        'mean_deaths',
        'mean_damage_dealt',
        'mean_damage_taken',
        'mean_exp_per_hour',
        'mean_time_to_clear',
        'mean_ticks',
        'route_complete',
        'party_wipe',
        'timeout',
        'kill_cap',
        'waves_complete'
    ];
    const lines = [headers.join('\t')];
    const rows = (evalResult && evalResult.rows) || [];
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const m = r.metrics || {};
        const oc = m.outcomes || {};
        lines.push(
            [
                r.rank != null ? r.rank : i + 1,
                r.strategyId || r.label || '',
                m.iterations != null ? m.iterations : '',
                fmtNum(m.routeCompleteRate),
                fmtNum(m.partyWipeRate),
                fmtNum(m.timeoutRate),
                fmtNum(m.meanKills),
                fmtNum(m.meanDeaths),
                fmtNum(m.meanDamageDealt),
                fmtNum(m.meanDamageTaken),
                fmtNum(m.meanExpPerHour),
                fmtNum(m.meanTimeToClear),
                fmtNum(m.meanTickCount),
                oc.routeComplete != null ? oc.routeComplete : '',
                oc.partyWipe != null ? oc.partyWipe : '',
                oc.timeout != null ? oc.timeout : '',
                oc.killCap != null ? oc.killCap : '',
                oc.wavesComplete != null ? oc.wavesComplete : ''
            ].join('\t')
        );
    }
    return lines.join('\n') + '\n';
}

/**
 * Normalize a loaded sweep / matrix / raw batch for the chart UI.
 * Accepts balance sweep docs, class matrix, batch_aggregate.json, and single hunt summaries.
 * @param {object|string} data
 * @returns {object|null}
 */
function normalizeAnalysisDocument(data) {
    let doc = data;
    if (typeof data === 'string') {
        try {
            doc = JSON.parse(data);
        } catch (_) {
            return null;
        }
    }
    if (!doc || typeof doc !== 'object') return null;

    if (
        doc.kind === 'sweep' ||
        doc.kind === 'class_matrix' ||
        doc.kind === 'side_swap' ||
        doc.kind === 'strategy_eval' ||
        doc.kind === 'batch_folder'
    ) {
        return doc;
    }

    // Documented product batch sample (kind: batch + nested aggregate)
    if (doc.kind === 'batch' && doc.aggregate && doc.aggregate.means) {
        const metrics = metricsFromAggregate(doc.aggregate);
        return {
            schemaVersion: SWEEP_SCHEMA_VERSION,
            kind: 'sweep',
            knob: 'batch',
            knobLabel: doc.label || doc.recipe || 'Batch sample',
            huntId: doc.huntId || null,
            seed: doc.seed,
            iterationsPerValue: doc.iterations || doc.aggregate.iterations,
            generatedAt: doc.generatedAt || null,
            notes: doc.notes || null,
            recipe: doc.recipe || null,
            chartMetrics: [
                'meanKills',
                'partyWipeRate',
                'noAttackTimeoutRate',
                'meanTimeToClear',
                'routeCompleteRate'
            ],
            rows: [
                {
                    value: 'aggregate',
                    label: `n=${doc.iterations || doc.aggregate.iterations}`,
                    metrics
                }
            ]
        };
    }

    if (Array.isArray(doc.rows)) {
        let kind = 'class_matrix';
        if (doc.knob) kind = 'sweep';
        else if (
            doc.rows[0] &&
            (doc.rows[0].strategyId != null || doc.kind === 'strategy_eval')
        ) {
            kind = 'strategy_eval';
        }
        return Object.assign(
            {
                schemaVersion: SWEEP_SCHEMA_VERSION,
                kind,
                chartMetrics: doc.chartMetrics || [
                    'routeCompleteRate',
                    'meanKills',
                    'meanExpPerHour'
                ]
            },
            doc
        );
    }

    // batch_aggregate.json from runHeadlessHuntBatch
    if (doc.means && doc.outcomes && doc.iterations != null && !doc.rows) {
        const metrics = metricsFromAggregate(doc);
        return {
            schemaVersion: SWEEP_SCHEMA_VERSION,
            kind: 'sweep',
            knob: 'batch',
            knobLabel: 'Batch aggregate',
            huntId: doc.huntId || null,
            seed: Array.isArray(doc.seeds) ? doc.seeds[0] : doc.seed,
            iterationsPerValue: doc.iterations,
            generatedAt: doc.generatedAt || null,
            chartMetrics: [
                'routeCompleteRate',
                'meanKills',
                'meanExpPerHour',
                'meanTimeToClear',
                'noAttackTimeoutRate',
                'partyWipeRate'
            ],
            rows: [
                {
                    value: 'aggregate',
                    label: `n=${doc.iterations}`,
                    metrics
                }
            ]
        };
    }

    // Single headless hunt summary
    if (
        (doc.sessionState != null || doc.endReason != null) &&
        (doc.kills != null || doc.tickCount != null) &&
        !doc.rows
    ) {
        const metrics = metricsFromHuntSummary(doc);
        if (!metrics) return null;
        const seed =
            doc.seed != null
                ? doc.seed
                : doc.config && doc.config.seed != null
                  ? doc.config.seed
                  : null;
        const huntId =
            doc.huntId ||
            (doc.config && doc.config.huntId) ||
            null;
        const seedLabel = seed != null ? `seed ${seed}` : huntId || 'hunt';
        return {
            schemaVersion: SWEEP_SCHEMA_VERSION,
            kind: 'sweep',
            knob: 'hunt',
            knobLabel: 'Hunt summary',
            huntId,
            seed,
            iterationsPerValue: 1,
            chartMetrics: [
                'routeCompleteRate',
                'meanKills',
                'meanExpPerHour',
                'meanTimeToClear',
                'noAttackTimeoutRate',
                'partyWipeRate'
            ],
            rows: [
                {
                    value: seed != null ? seed : 0,
                    label: seedLabel,
                    metrics
                }
            ]
        };
    }

    return null;
}

/**
 * Series for charting: { labels, series: { metric: number[] } }.
 * @param {object} doc normalizeAnalysisDocument result
 * @param {string[]} [metrics]
 * @returns {{ labels: string[], series: Record<string, number[]>, kind: string }}
 */
function chartSeriesFromDocument(doc, metrics) {
    const rows = (doc && doc.rows) || [];
    const keys =
        metrics && metrics.length
            ? metrics
            : (doc && doc.chartMetrics) || [
                  'routeCompleteRate',
                  'meanKills',
                  'meanExpPerHour'
              ];
    const labels = [];
    /** @type {Record<string, number[]>} */
    const series = Object.create(null);
    for (let k = 0; k < keys.length; k++) series[keys[k]] = [];

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        labels.push(
            r.label != null
                ? String(r.label)
                : r.strategyId != null
                  ? String(r.strategyId)
                  : r.value != null
                    ? String(r.value)
                    : r.classId != null
                      ? String(r.classId)
                      : String(i)
        );
        const m = r.metrics || r;
        for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            const v = m[key];
            series[key].push(Number.isFinite(Number(v)) ? Number(v) : 0);
        }
    }

    return {
        labels,
        series,
        kind: (doc && doc.kind) || 'sweep'
    };
}

/**
 * Stable JSON stringify (same contract as telemetry; local copy for browser).
 * @param {any} value
 * @returns {string}
 */
function stableStringify(value) {
    return JSON.stringify(value, null, 2);
}

module.exports = {
    SWEEP_SCHEMA_VERSION,
    KNOB_META,
    METRIC_LABELS,
    FOLDER_PRIMARY_NAMES,
    listKnobs,
    parseValueList,
    metricsFromAggregate,
    metricsFromHuntSummary,
    metricLabel,
    groupResultFilesByFolder,
    documentFromFolderEntries,
    fmtNum,
    sweepToTsv,
    classMatrixToTsv,
    strategyEvalToTsv,
    normalizeAnalysisDocument,
    chartSeriesFromDocument,
    stableStringify
};
