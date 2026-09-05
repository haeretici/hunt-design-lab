/**
 * Balance sweeps + class viability matrix (Stage 8) + strategy eval (Stage 12F).
 *
 * Varies one knob (creature HP, spell power, armor, spawn density, …),
 * runs headless hunt batches, aggregates outcomes, writes JSON/TSV for
 * the simulation-analysis UI. Strategy eval ranks AI presets on a fixed hunt.
 *
 * Node-only runner. Pure chart helpers live in balance_analysis.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const presets = require('./presets.js');
const {
    SWEEP_SCHEMA_VERSION,
    KNOB_META,
    listKnobs,
    parseValueList,
    metricsFromAggregate,
    sweepToTsv,
    classMatrixToTsv,
    strategyEvalToTsv,
    normalizeAnalysisDocument,
    chartSeriesFromDocument,
    stableStringify
} = require('./balance_analysis.js');
const {
    runHeadlessHuntBatch,
    aggregateSummaries,
    defaultSimOutDir
} = require('../../providers/simulator/headless_runner.js');
const { ROOT } = require('../../settings.js');

/**
 * @typedef {object} KnobDef
 * @property {string} id
 * @property {string} label
 * @property {string} unit
 * @property {number[]} defaultValues
 * @property {(baseInput: object, value: number) => object} apply
 */

/**
 * Shallow clone of plain input (drops functions).
 * @param {object} input
 * @returns {object}
 */
function clonePlainInput(input) {
    const src = input || {};
    const out = Object.assign({}, src);
    delete out.creatureLoader;
    delete out.classLoader;
    delete out.itemDb;
    delete out.spellBook;
    delete out.strategyTable;
    delete out.onIteration;
    delete out.iterations;
    delete out.seeds;
    delete out.outDir;
    delete out.writeFiles;
    delete out.quiet;
    delete out.knob;
    delete out.knobValue;
    return out;
}

/**
 * Deep-ish clone of JSON-safe data.
 * @param {any} v
 * @returns {any}
 */
function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
}

/**
 * Default creature loader from disk/cache.
 * @param {string} id
 * @returns {object|null}
 */
function defaultCreatureLoader(id) {
    try {
        return presets.loadCreatureTemplate(id);
    } catch (_) {
        return null;
    }
}

/**
 * Scale numeric fields on a creature template.
 * @param {object|null} template
 * @param {number} scale
 * @param {string[]} fields
 * @returns {object|null}
 */
function scaleCreatureFields(template, scale, fields) {
    if (!template) return null;
    const t = cloneJson(template);
    const s = Number(scale);
    if (!(s >= 0)) return t;
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        if (t[f] != null && Number.isFinite(Number(t[f]))) {
            t[f] = Math.max(0, Math.round(Number(t[f]) * s));
        }
    }
    if (fields.indexOf('hp') >= 0 || fields.indexOf('hpMax') >= 0) {
        if (t.hpMax == null && t.hp != null) t.hpMax = t.hp;
        if (t.hp == null && t.hpMax != null) t.hp = t.hpMax;
        if (t.hp != null) t.hp = Math.max(1, t.hp);
        if (t.hpMax != null) t.hpMax = Math.max(1, t.hpMax);
    }
    return t;
}

/**
 * Build a spell book (array) with basePower scaled.
 * @param {number} scale
 * @param {string|null} [spellId] when set, only that spell
 * @returns {object[]}
 */
function scaledSpellBook(scale, spellId) {
    const data = presets.loadSpells();
    const list = cloneJson(data.spells || data || []);
    const s = Number(scale);
    if (!(s >= 0) || !Array.isArray(list)) return list;
    for (let i = 0; i < list.length; i++) {
        const sp = list[i];
        if (!sp) continue;
        if (spellId && sp.id !== spellId) continue;
        if (sp.basePower != null) {
            sp.basePower = Math.max(0, Math.round(Number(sp.basePower) * s));
        }
    }
    return list;
}

/**
 * Scale armor (and related defense) on equipment items.
 * @param {number} scale
 * @returns {object[]}
 */
function scaledItemDb(scale) {
    const data = presets.loadEquipment();
    const list = cloneJson(data.items || data || []);
    const s = Number(scale);
    if (!(s >= 0) || !Array.isArray(list)) return list;
    for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!it) continue;
        if (it.armor != null) {
            it.armor = Math.max(0, Math.round(Number(it.armor) * s));
        }
        if (it.defense != null) {
            it.defense = Math.max(0, Math.round(Number(it.defense) * s));
        }
    }
    return list;
}

/**
 * Rescale spawn table density.
 * density 1 = original; 2 = each entry twice; 0.5 ≈ half the entries (round).
 * @param {object[]} spawns
 * @param {number} density
 * @returns {object[]}
 */
function scaleSpawnDensity(spawns, density) {
    const list = Array.isArray(spawns) ? spawns : [];
    const d = Number(density);
    if (!(d > 0) || !list.length) return [];
    if (d === 1) return list.map((s) => Object.assign({}, s));

    if (d >= 1) {
        const whole = Math.floor(d);
        const frac = d - whole;
        const out = [];
        for (let n = 0; n < whole; n++) {
            for (let i = 0; i < list.length; i++) {
                out.push(Object.assign({}, list[i]));
            }
        }
        if (frac > 0.001) {
            const extra = Math.max(1, Math.round(list.length * frac));
            for (let i = 0; i < extra; i++) {
                out.push(Object.assign({}, list[i % list.length]));
            }
        }
        return out;
    }

    const keep = Math.max(1, Math.round(list.length * d));
    const out = [];
    for (let i = 0; i < keep; i++) {
        const idx = Math.min(
            list.length - 1,
            Math.floor((i * list.length) / keep)
        );
        out.push(Object.assign({}, list[idx]));
    }
    return out;
}

/** @type {Record<string, KnobDef>} */
const KNOBS = {
    creature_hp: Object.assign({}, KNOB_META.creature_hp, {
        apply(baseInput, value) {
            const plain = clonePlainInput(baseInput);
            plain.knob = 'creature_hp';
            plain.knobValue = value;
            plain.creatureLoader = (id) =>
                scaleCreatureFields(defaultCreatureLoader(id), value, [
                    'hp',
                    'hpMax'
                ]);
            return plain;
        }
    }),
    creature_armor: Object.assign({}, KNOB_META.creature_armor, {
        apply(baseInput, value) {
            const plain = clonePlainInput(baseInput);
            plain.knob = 'creature_armor';
            plain.knobValue = value;
            plain.creatureLoader = (id) =>
                scaleCreatureFields(defaultCreatureLoader(id), value, [
                    'armor',
                    'mitigation'
                ]);
            return plain;
        }
    }),
    spell_power: Object.assign({}, KNOB_META.spell_power, {
        apply(baseInput, value) {
            const plain = clonePlainInput(baseInput);
            plain.knob = 'spell_power';
            plain.knobValue = value;
            plain.spellBook = scaledSpellBook(value, null);
            return plain;
        }
    }),
    equipment_armor: Object.assign({}, KNOB_META.equipment_armor, {
        apply(baseInput, value) {
            const plain = clonePlainInput(baseInput);
            plain.knob = 'equipment_armor';
            plain.knobValue = value;
            plain.itemDb = scaledItemDb(value);
            return plain;
        }
    }),
    spawn_density: Object.assign({}, KNOB_META.spawn_density, {
        apply(baseInput, value) {
            const plain = clonePlainInput(baseInput);
            plain.knob = 'spawn_density';
            plain.knobValue = value;
            let spawns = plain.spawns;
            if (!Array.isArray(spawns) || !spawns.length) {
                try {
                    const huntId = plain.huntId || 'cave_crawl_generated';
                    const seed =
                        plain.seed != null ? plain.seed >>> 0 || 1 : 1;
                    const hunt =
                        plain.hunt ||
                        presets.loadHunt(huntId, { seed });
                    spawns = (hunt && hunt.spawns) || [];
                } catch (_) {
                    spawns = [];
                }
            }
            plain.spawns = scaleSpawnDensity(spawns, value);
            return plain;
        }
    }),
    /** Stage 11.1: scale population totalPacks before resolve (when no explicit spawns). */
    population_density: Object.assign({}, KNOB_META.population_density, {
        apply(baseInput, value) {
            const plain = clonePlainInput(baseInput);
            plain.knob = 'population_density';
            plain.knobValue = value;
            plain.populationDensity = Number(value);
            // Force re-resolve: drop pre-baked spawns when hunt uses a table.
            if (
                plain.hunt &&
                (plain.hunt.populationId || plain.hunt.population)
            ) {
                const h = Object.assign({}, plain.hunt);
                delete h.spawns;
                delete h.populationMeta;
                h.populationDensity = Number(value);
                h._hadAuthoredSpawns = false;
                plain.hunt = h;
                delete plain.spawns;
            } else if (plain.huntId && !plain.spawns) {
                plain.populationDensity = Number(value);
            }
            return plain;
        }
    })
};

/**
 * @param {string} id
 * @returns {KnobDef}
 */
function getKnob(id) {
    const k = KNOBS[id];
    if (!k) {
        throw new Error(
            `Unknown balance knob "${id}". Known: ${Object.keys(KNOBS).join(', ')}`
        );
    }
    return k;
}

/**
 * Default strategy id for a class role.
 * @param {string} classId
 * @returns {string}
 */
function defaultStrategyForClass(classId) {
    const map = {
        guardian: 'guardian_aggro',
        scout: 'scout_kite',
        adept: 'adept_caster',
        warden: 'balanced'
    };
    return map[classId] || 'balanced';
}

/**
 * Minimal kit so classes are not naked.
 * @param {string} classId
 * @returns {object}
 */
function defaultEquipmentForClass(classId) {
    if (classId === 'adept') {
        return {
            rightHand: 'scorcher_wand',
            armor: 'steel_plate',
            boots: 'leather_boots'
        };
    }
    if (classId === 'warden') {
        return {
            rightHand: 'frostbite_wand',
            armor: 'steel_plate',
            boots: 'leather_boots'
        };
    }
    if (classId === 'scout') {
        return {
            rightHand: 'iron_longsword',
            boots: 'leather_boots'
        };
    }
    return {
        rightHand: 'iron_longsword',
        leftHand: 'oak_shield',
        armor: 'steel_plate',
        helmet: 'steel_helm',
        legs: 'steel_greaves',
        boots: 'leather_boots'
    };
}

/**
 * Build a single-member party config for class viability.
 * @param {string} classId
 * @param {object} [opts]
 * @returns {object[]}
 */
function soloPartyForClass(classId, opts) {
    const o = opts || {};
    const level = o.level != null ? o.level : 50;
    const strategyId = o.strategyId || defaultStrategyForClass(classId);
    const equipment = o.equipment || defaultEquipmentForClass(classId);
    return [
        {
            name: `Solo_${classId}`,
            id: `solo_${classId}`,
            members: [
                {
                    name: classId,
                    classId,
                    isLeader: true,
                    strategyId,
                    level,
                    equipment
                }
            ]
        }
    ];
}

/**
 * Run a one-knob balance sweep.
 *
 * @param {object} [opts]
 * @returns {Promise<object>} sweep result document
 */
async function runBalanceSweep(opts) {
    const o = opts || {};
    const knob = getKnob(o.knob || 'creature_hp');
    const values =
        parseValueList(o.values) ||
        (Array.isArray(o.values) ? o.values : null) ||
        knob.defaultValues.slice();
    const iterations = Math.max(1, parseInt(o.iterations, 10) || 1);
    const seed = (o.seed !== undefined ? o.seed : 1) >>> 0 || 1;
    const huntId =
        o.huntId || (o.baseInput && o.baseInput.huntId) || 'cave_crawl_generated';
    const writeFiles = o.writeFiles !== false;
    const quiet = o.quiet !== false;
    const outDir = writeFiles
        ? path.resolve(
              o.outDir ||
                  path.join(
                      defaultSimOutDir(),
                      'sweeps',
                      `${knob.id}_${Date.now()}`
                  )
          )
        : null;

    const base = Object.assign(
        { huntId, seed },
        clonePlainInput(o.baseInput || {})
    );
    if (o.frames != null) base.frames = o.frames;
    if (o.maxKills != null) base.maxKills = o.maxKills;
    if (o.maxSeconds != null) base.maxSeconds = o.maxSeconds;
    if (o.maxTicks != null) base.maxTicks = o.maxTicks;
    base.huntId = huntId;

    const rows = [];

    for (let vi = 0; vi < values.length; vi++) {
        const value = values[vi];
        const huntInput = knob.apply(base, value);
        huntInput.iterations = iterations;
        huntInput.seed = seed;
        huntInput.writeFiles = false;
        huntInput.quiet = true;

        const batch = await runHeadlessHuntBatch(huntInput);
        const metrics = metricsFromAggregate(batch.aggregate);
        rows.push({
            value,
            label: String(value),
            metrics,
            aggregate: batch.aggregate
        });

        if (!quiet) {
            console.log(
                JSON.stringify({
                    knob: knob.id,
                    value,
                    routeCompleteRate: metrics.routeCompleteRate,
                    meanKills: metrics.meanKills,
                    meanExpPerHour: metrics.meanExpPerHour
                })
            );
        }
    }

    const result = {
        schemaVersion: SWEEP_SCHEMA_VERSION,
        kind: 'sweep',
        knob: knob.id,
        knobLabel: knob.label,
        unit: knob.unit,
        huntId,
        seed,
        iterationsPerValue: iterations,
        values: values.slice(),
        generatedAt: new Date().toISOString(),
        rows,
        chartMetrics: [
            'routeCompleteRate',
            'partyWipeRate',
            'meanKills',
            'meanExpPerHour',
            'meanTimeToClear',
            'meanDamageDealt'
        ]
    };

    if (writeFiles && outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        const jsonPath = path.join(outDir, 'sweep.json');
        const tsvPath = path.join(outDir, 'sweep.tsv');
        fs.writeFileSync(jsonPath, stableStringify(result) + '\n', 'utf8');
        fs.writeFileSync(tsvPath, sweepToTsv(result), 'utf8');
        result.outDir = outDir;
        result.files = { json: jsonPath, tsv: tsvPath };
    }

    return result;
}

/**
 * Class viability matrix: each class solo vs one hunt.
 * Optional sideSwap: also run duo with baseline companion in both
 * leader orientations and average (soccer-style side-swap fairness).
 *
 * @param {object} [opts]
 * @returns {Promise<object>}
 */
async function runClassViabilityMatrix(opts) {
    const o = opts || {};
    const huntId = o.huntId || 'cave_crawl_generated';
    const seed = (o.seed !== undefined ? o.seed : 1) >>> 0 || 1;
    const iterations = Math.max(1, parseInt(o.iterations, 10) || 1);
    const writeFiles = o.writeFiles !== false;
    const quiet = o.quiet !== false;
    const sideSwap = !!o.sideSwap;
    const baselineClassId = o.baselineClassId || o.baseline || 'adventurer';

    let classIds = o.classIds;
    if (!Array.isArray(classIds) || !classIds.length) {
        const data = presets.loadClasses();
        const list = data.classes || data || [];
        classIds = list.map((c) => c.id).filter(Boolean);
    }

    const outDir = writeFiles
        ? path.resolve(
              o.outDir ||
                  path.join(
                      defaultSimOutDir(),
                      'sweeps',
                      `class_matrix_${Date.now()}`
                  )
          )
        : null;

    const rows = [];
    for (let i = 0; i < classIds.length; i++) {
        const classId = classIds[i];
        let metrics;
        let aggregate;
        let side = null;

        if (sideSwap) {
            const swapped = await runCompositionSideSwap({
                huntId,
                seed,
                iterations,
                classA: classId,
                classB: baselineClassId === classId ? 'guardian' : baselineClassId,
                frames: o.frames,
                maxKills: o.maxKills,
                maxSeconds: o.maxSeconds,
                maxTicks: o.maxTicks,
                writeFiles: false,
                quiet: true,
                level: o.level,
                equipment: o.equipment
            });
            metrics = swapped.averagedMetrics;
            aggregate = swapped.averagedAggregate;
            side = {
                forward: swapped.forward,
                swap: swapped.swap,
                baselineClassId:
                    baselineClassId === classId ? 'guardian' : baselineClassId
            };
        } else {
            const parties = soloPartyForClass(classId, o);
            const batch = await runHeadlessHuntBatch({
                huntId,
                seed,
                iterations,
                parties,
                frames: o.frames,
                maxKills: o.maxKills,
                maxSeconds: o.maxSeconds,
                maxTicks: o.maxTicks,
                writeFiles: false,
                quiet: true
            });
            metrics = metricsFromAggregate(batch.aggregate);
            aggregate = batch.aggregate;
        }

        rows.push({
            classId,
            label: classId,
            metrics,
            aggregate,
            sideSwap: side
        });
        if (!quiet) {
            console.log(
                JSON.stringify({
                    classId,
                    sideSwap: !!sideSwap,
                    routeCompleteRate: metrics.routeCompleteRate,
                    meanKills: metrics.meanKills,
                    meanExpPerHour: metrics.meanExpPerHour
                })
            );
        }
    }

    const result = {
        schemaVersion: SWEEP_SCHEMA_VERSION,
        kind: 'class_matrix',
        huntId,
        seed,
        iterationsPerValue: iterations,
        classIds: classIds.slice(),
        sideSwap,
        baselineClassId: sideSwap ? baselineClassId : null,
        generatedAt: new Date().toISOString(),
        rows,
        chartMetrics: [
            'routeCompleteRate',
            'partyWipeRate',
            'meanKills',
            'meanExpPerHour',
            'meanTimeToClear',
            'meanDamageDealt'
        ]
    };

    if (writeFiles && outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        const jsonPath = path.join(outDir, 'class_matrix.json');
        const tsvPath = path.join(outDir, 'class_matrix.tsv');
        fs.writeFileSync(jsonPath, stableStringify(result) + '\n', 'utf8');
        fs.writeFileSync(tsvPath, classMatrixToTsv(result), 'utf8');
        result.outDir = outDir;
        result.files = { json: jsonPath, tsv: tsvPath };
    }

    return result;
}

/**
 * Duo party: classA leader + classB follower (or solo if same / missing B).
 * @param {string} classA
 * @param {string} classB
 * @param {object} [opts]
 * @returns {object[]}
 */
function duoPartyForClasses(classA, classB, opts) {
    const o = opts || {};
    const level = o.level != null ? o.level : 50;
    const members = [
        {
            name: classA,
            classId: classA,
            isLeader: true,
            strategyId: o.strategyA || defaultStrategyForClass(classA),
            level,
            equipment: o.equipmentA || defaultEquipmentForClass(classA)
        }
    ];
    if (classB && classB !== classA) {
        members.push({
            name: classB,
            classId: classB,
            isLeader: false,
            strategyId: o.strategyB || defaultStrategyForClass(classB),
            level,
            equipment: o.equipmentB || defaultEquipmentForClass(classB)
        });
    }
    return [
        {
            name: `Duo_${classA}_${classB || 'solo'}`,
            id: `duo_${classA}_${classB || 'solo'}`,
            members
        }
    ];
}

/**
 * Reverse member order within each party; first member becomes leader.
 * Cancels leader-slot bias (soccer side-swap analogue for compositions).
 *
 * @param {object[]} parties
 * @returns {object[]}
 */
function mirrorPartyComposition(parties) {
    if (!Array.isArray(parties)) return [];
    return parties.map((p) => {
        const src = Array.isArray(p.members) ? p.members : [];
        const members = src
            .slice()
            .reverse()
            .map((m, i) => {
                const copy = cloneJson(m);
                copy.isLeader = i === 0;
                return copy;
            });
        const out = cloneJson(p);
        out.members = members;
        return out;
    });
}

/**
 * Average two metrics objects (numeric fields + outcome counts).
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
function averageMetrics(a, b) {
    const keys = [
        'routeCompleteRate',
        'partyWipeRate',
        'timeoutRate',
        'killCapRate',
        'wavesCompleteRate',
        'meanKills',
        'meanDeaths',
        'meanDamageDealt',
        'meanDamageTaken',
        'meanExpGained',
        'meanExpPerHour',
        'meanTimeToClear',
        'meanTickCount'
    ];
    const out = {
        iterations: ((a && a.iterations) || 0) + ((b && b.iterations) || 0)
    };
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const va = (a && a[k]) || 0;
        const vb = (b && b[k]) || 0;
        out[k] = (va + vb) / 2;
    }
    const oa = (a && a.outcomes) || {};
    const ob = (b && b.outcomes) || {};
    out.outcomes = {
        routeComplete: (oa.routeComplete || 0) + (ob.routeComplete || 0),
        partyWipe: (oa.partyWipe || 0) + (ob.partyWipe || 0),
        timeout: (oa.timeout || 0) + (ob.timeout || 0),
        killCap: (oa.killCap || 0) + (ob.killCap || 0),
        wavesComplete: (oa.wavesComplete || 0) + (ob.wavesComplete || 0)
    };
    return out;
}

/**
 * Average two aggregateSummaries blobs.
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
function averageAggregates(a, b) {
    const aa = a || {};
    const bb = b || {};
    const nA = aa.iterations || 0;
    const nB = bb.iterations || 0;
    const n = nA + nB;
    const meansKeys = [
        'kills',
        'deaths',
        'damageDealt',
        'damageTaken',
        'expGained',
        'lootGained',
        'tickCount',
        'timeToClear',
        'expPerHour'
    ];
    const means = {};
    for (let i = 0; i < meansKeys.length; i++) {
        const k = meansKeys[i];
        const ma = (aa.means && aa.means[k]) || 0;
        const mb = (bb.means && bb.means[k]) || 0;
        means[k] = (ma + mb) / 2;
    }
    const ocA = aa.outcomes || {};
    const ocB = bb.outcomes || {};
    return {
        iterations: n,
        means,
        outcomes: {
            routeComplete: (ocA.routeComplete || 0) + (ocB.routeComplete || 0),
            partyWipe: (ocA.partyWipe || 0) + (ocB.partyWipe || 0),
            timeout: (ocA.timeout || 0) + (ocB.timeout || 0),
            killCap: (ocA.killCap || 0) + (ocB.killCap || 0),
            wavesComplete: (ocA.wavesComplete || 0) + (ocB.wavesComplete || 0)
        },
        totals: {
            kills: ((aa.totals && aa.totals.kills) || 0) + ((bb.totals && bb.totals.kills) || 0),
            deaths:
                ((aa.totals && aa.totals.deaths) || 0) +
                ((bb.totals && bb.totals.deaths) || 0)
        }
    };
}

/**
 * Composition side-swap eval (soccer preset side-swap analogue).
 *
 * Runs the same seeds twice:
 *   forward — classA leader + classB follower
 *   swap    — classB leader + classA follower
 * Averages metrics so leader-slot bias cancels.
 *
 * @param {object} [opts]
 * @param {string} [opts.classA='guardian']
 * @param {string} [opts.classB='scout']
 * @returns {Promise<object>}
 */
async function runCompositionSideSwap(opts) {
    const o = opts || {};
    const huntId = o.huntId || 'cave_crawl_generated';
    const seed = (o.seed !== undefined ? o.seed : 1) >>> 0 || 1;
    const iterations = Math.max(1, parseInt(o.iterations, 10) || 1);
    const classA = o.classA || o.primary || 'guardian';
    const classB = o.classB || o.secondary || 'scout';
    const writeFiles = o.writeFiles !== false;
    const quiet = o.quiet !== false;

    const forwardParties = duoPartyForClasses(classA, classB, o);
    const swapParties = mirrorPartyComposition(forwardParties);

    const batchOpts = {
        huntId,
        seed,
        iterations,
        frames: o.frames,
        maxKills: o.maxKills,
        maxSeconds: o.maxSeconds,
        maxTicks: o.maxTicks,
        writeFiles: false,
        quiet: true
    };

    const forwardBatch = await runHeadlessHuntBatch(
        Object.assign({}, batchOpts, { parties: forwardParties })
    );
    const swapBatch = await runHeadlessHuntBatch(
        Object.assign({}, batchOpts, { parties: swapParties })
    );

    const forwardMetrics = metricsFromAggregate(forwardBatch.aggregate);
    const swapMetrics = metricsFromAggregate(swapBatch.aggregate);
    const averagedMetrics = averageMetrics(forwardMetrics, swapMetrics);
    const averagedAggregate = averageAggregates(
        forwardBatch.aggregate,
        swapBatch.aggregate
    );

    const result = {
        schemaVersion: SWEEP_SCHEMA_VERSION,
        kind: 'side_swap',
        huntId,
        seed,
        iterationsPerSide: iterations,
        classA,
        classB,
        generatedAt: new Date().toISOString(),
        forward: {
            parties: forwardParties,
            metrics: forwardMetrics,
            aggregate: forwardBatch.aggregate
        },
        swap: {
            parties: swapParties,
            metrics: swapMetrics,
            aggregate: swapBatch.aggregate
        },
        averagedMetrics,
        averagedAggregate,
        rows: [
            {
                label: `${classA}+${classB} (avg side-swap)`,
                classId: classA,
                partnerClassId: classB,
                metrics: averagedMetrics,
                aggregate: averagedAggregate
            }
        ],
        chartMetrics: [
            'routeCompleteRate',
            'partyWipeRate',
            'meanKills',
            'meanExpPerHour',
            'meanTimeToClear',
            'meanDamageDealt'
        ]
    };

    if (writeFiles) {
        const outDir = path.resolve(
            o.outDir ||
                path.join(
                    defaultSimOutDir(),
                    'sweeps',
                    `side_swap_${classA}_${classB}_${Date.now()}`
                )
        );
        fs.mkdirSync(outDir, { recursive: true });
        const jsonPath = path.join(outDir, 'side_swap.json');
        const tsvPath = path.join(outDir, 'side_swap.tsv');
        fs.writeFileSync(jsonPath, stableStringify(result) + '\n', 'utf8');
        // Reuse class matrix TSV shape (class_id column = duo label)
        const tsvDoc = {
            rows: [
                {
                    classId: `${classA}+${classB}`,
                    label: `${classA}+${classB}`,
                    metrics: averagedMetrics
                },
                {
                    classId: `${classA}+${classB}_forward`,
                    label: 'forward',
                    metrics: forwardMetrics
                },
                {
                    classId: `${classB}+${classA}_swap`,
                    label: 'swap',
                    metrics: swapMetrics
                }
            ]
        };
        fs.writeFileSync(tsvPath, classMatrixToTsv(tsvDoc), 'utf8');
        result.outDir = outDir;
        result.files = { json: jsonPath, tsv: tsvPath };
    }

    if (!quiet) {
        console.log(
            JSON.stringify({
                kind: 'side_swap',
                classA,
                classB,
                avgRoute: averagedMetrics.routeCompleteRate,
                avgKills: averagedMetrics.meanKills,
                forwardRoute: forwardMetrics.routeCompleteRate,
                swapRoute: swapMetrics.routeCompleteRate
            })
        );
    }

    return result;
}

/**
 * Default out dir for documented sample sweeps (committed fixtures).
 * @returns {string}
 */
function sampleAnalysisDir() {
    return path.join(
        ROOT || process.cwd(),
        'presets',
        'standard',
        'analysis'
    );
}

/**
 * List strategy preset ids from disk (presets/strategies.json).
 * @returns {string[]}
 */
function listStrategyIds() {
    const data = presets.loadStrategies();
    const list = data.strategies || data || [];
    if (!Array.isArray(list)) return Object.keys(list);
    return list.map((s) => s && s.id).filter(Boolean);
}

/**
 * Clone hunt parties and force every member onto one strategy id.
 * Keeps hunt default classes / equipment / levels (Stage 12F open decision).
 *
 * @param {object[]} parties
 * @param {string} strategyId
 * @returns {object[]}
 */
function partiesWithStrategy(parties, strategyId) {
    const src = Array.isArray(parties) ? parties : [];
    return src.map((p) => {
        const out = cloneJson(p);
        const members = Array.isArray(out.members) ? out.members : [];
        out.members = members.map((m) => {
            const copy = Object.assign({}, m);
            copy.strategyId = strategyId;
            return copy;
        });
        return out;
    });
}

/**
 * Load party roster for strategy eval (party preset, not hunt-embedded).
 * @param {string} huntId unused (kept for call-site compat)
 * @param {object} [opts]
 * @param {string} [opts.classId] when set, replace party with solo of that class
 * @param {string} [opts.partyId] party preset id (default mode defaults / starter_duo)
 * @returns {object[]}
 */
function loadHuntPartiesForEval(huntId, opts) {
    const o = opts || {};
    if (o.classId) {
        return soloPartyForClass(o.classId, {
            strategyId: o.strategyId || defaultStrategyForClass(o.classId),
            level: o.level,
            equipment: o.equipment
        });
    }
    const {
        resolveSessionParties,
        DEFAULT_PARTY_ID
    } = require('./character/party_resolve.js');
    const partyId =
        o.partyId != null && String(o.partyId).trim() !== ''
            ? String(o.partyId).trim()
            : // Prefer frozen CI duo for eval stability when not overridden
              'test_cave_duo';
    try {
        const parties = resolveSessionParties(
            { partyId },
            { waypoints: [] }
        );
        if (Array.isArray(parties) && parties.length) return cloneJson(parties);
    } catch (_) {
        /* fall through */
    }
    try {
        const parties = resolveSessionParties(
            { partyId: DEFAULT_PARTY_ID },
            { waypoints: [] }
        );
        if (Array.isArray(parties) && parties.length) return cloneJson(parties);
    } catch (_) {
        /* fall through */
    }
    return soloPartyForClass('guardian', o);
}

/**
 * Numeric rank key for strategy rows (higher is better unless lowerIsBetter).
 * @param {object} metrics
 * @param {string} rankBy
 * @returns {number}
 */
function rankMetricValue(metrics, rankBy) {
    const m = metrics || {};
    const key = rankBy || 'meanExpPerHour';
    const v = m[key];
    return Number.isFinite(Number(v)) ? Number(v) : 0;
}

/**
 * Sort strategy eval rows and assign rank (1 = best).
 * @param {object[]} rows
 * @param {string} [rankBy='meanExpPerHour']
 * @param {boolean} [lowerIsBetter=false]
 * @returns {object[]}
 */
function rankStrategyRows(rows, rankBy, lowerIsBetter) {
    const key = rankBy || 'meanExpPerHour';
    const lower = !!lowerIsBetter;
    const sorted = rows.slice().sort((a, b) => {
        // Prefer higher route complete, then rank metric
        const rcA = (a.metrics && a.metrics.routeCompleteRate) || 0;
        const rcB = (b.metrics && b.metrics.routeCompleteRate) || 0;
        if (Math.abs(rcA - rcB) > 1e-9) return rcB - rcA;
        const va = rankMetricValue(a.metrics, key);
        const vb = rankMetricValue(b.metrics, key);
        if (lower) return va - vb;
        return vb - va;
    });
    for (let i = 0; i < sorted.length; i++) {
        sorted[i].rank = i + 1;
    }
    return sorted;
}

/**
 * Lightweight viability notes for strategy rows (tune feedback, not auto-edit).
 * @param {object[]} rows ranked rows
 * @returns {object[]}
 */
function strategyViabilityNotes(rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    const bestExp = Math.max(
        0,
        ...list.map((r) => (r.metrics && r.metrics.meanExpPerHour) || 0)
    );
    const notes = [];
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const m = r.metrics || {};
        const flags = [];
        if ((m.routeCompleteRate || 0) < 0.25 && (m.meanKills || 0) < 0.5) {
            flags.push('rarely clears or kills');
        }
        if ((m.partyWipeRate || 0) >= 0.75) {
            flags.push('high wipe rate');
        }
        if (
            bestExp > 0 &&
            (m.meanExpPerHour || 0) < bestExp * 0.15 &&
            r.strategyId !== 'pacifist'
        ) {
            flags.push('very low exp/h vs top');
        }
        if (r.strategyId === 'pacifist' && (m.meanKills || 0) > 0.1) {
            flags.push('pacifist unexpectedly killing');
        }
        if (flags.length) {
            notes.push({ strategyId: r.strategyId, flags });
        }
    }
    return notes;
}

/**
 * Strategy preset eval: each strategy on hunt default party classes
 * (swap strategy only). Writes ranking JSON/TSV under var/sim/strategy_eval/.
 *
 * Optional classId forces a solo party of that class (class matrix style).
 * Optional sideSwap for multi-member parties: run with member order mirrored
 * and average metrics (leader-slot fairness when strategies differ by slot —
 * with whole-party same strategy this mainly stabilizes leader bias noise).
 *
 * @param {object} [opts]
 * @param {string} [opts.huntId='cave_crawl_generated']
 * @param {string[]} [opts.strategyIds] default: all strategies in presets
 * @param {string} [opts.classId] force solo class (else hunt default roster)
 * @param {number} [opts.seed=1]
 * @param {number} [opts.iterations=1]
 * @param {string} [opts.rankBy='meanExpPerHour']
 * @param {boolean} [opts.lowerIsBetter]
 * @param {boolean} [opts.sideSwap]
 * @param {boolean} [opts.writeFiles=true]
 * @param {string} [opts.outDir]
 * @returns {Promise<object>}
 */
async function runStrategyEval(opts) {
    const o = opts || {};
    const huntId = o.huntId || 'cave_crawl_generated';
    const seed = (o.seed !== undefined ? o.seed : 1) >>> 0 || 1;
    const iterations = Math.max(1, parseInt(o.iterations, 10) || 1);
    const writeFiles = o.writeFiles !== false;
    const quiet = o.quiet !== false;
    const sideSwap = !!o.sideSwap;
    const rankBy = o.rankBy || 'meanExpPerHour';
    const lowerIsBetter =
        o.lowerIsBetter != null
            ? !!o.lowerIsBetter
            : rankBy === 'meanTimeToClear' ||
              rankBy === 'meanTickCount' ||
              rankBy === 'meanDeaths' ||
              rankBy === 'meanDamageTaken' ||
              rankBy === 'partyWipeRate';

    let strategyIds = o.strategyIds;
    if (!Array.isArray(strategyIds) || !strategyIds.length) {
        strategyIds = listStrategyIds();
    }
    if (!strategyIds.length) {
        throw new Error('No strategy ids to evaluate (presets/strategies.json empty?)');
    }

    const baseParties = loadHuntPartiesForEval(huntId, {
        classId: o.classId || null,
        level: o.level,
        equipment: o.equipment
    });

    const outDir = writeFiles
        ? path.resolve(
              o.outDir ||
                  path.join(
                      defaultSimOutDir(),
                      'strategy_eval',
                      `eval_${Date.now()}`
                  )
          )
        : null;

    const rawRows = [];
    for (let i = 0; i < strategyIds.length; i++) {
        const strategyId = strategyIds[i];
        const parties = partiesWithStrategy(baseParties, strategyId);

        let metrics;
        let aggregate;
        let side = null;

        if (sideSwap && parties[0] && (parties[0].members || []).length > 1) {
            const forwardParties = parties;
            const swapParties = mirrorPartyComposition(forwardParties);
            const batchOpts = {
                huntId,
                seed,
                iterations,
                frames: o.frames,
                maxKills: o.maxKills,
                maxSeconds: o.maxSeconds,
                maxTicks: o.maxTicks,
                writeFiles: false,
                quiet: true
            };
            const forwardBatch = await runHeadlessHuntBatch(
                Object.assign({}, batchOpts, { parties: forwardParties })
            );
            const swapBatch = await runHeadlessHuntBatch(
                Object.assign({}, batchOpts, { parties: swapParties })
            );
            const forwardMetrics = metricsFromAggregate(forwardBatch.aggregate);
            const swapMetrics = metricsFromAggregate(swapBatch.aggregate);
            metrics = averageMetrics(forwardMetrics, swapMetrics);
            aggregate = averageAggregates(
                forwardBatch.aggregate,
                swapBatch.aggregate
            );
            side = { forward: forwardMetrics, swap: swapMetrics };
        } else {
            const batch = await runHeadlessHuntBatch({
                huntId,
                seed,
                iterations,
                parties,
                frames: o.frames,
                maxKills: o.maxKills,
                maxSeconds: o.maxSeconds,
                maxTicks: o.maxTicks,
                writeFiles: false,
                quiet: true
            });
            metrics = metricsFromAggregate(batch.aggregate);
            aggregate = batch.aggregate;
        }

        const stratMeta = presets.getStrategy(strategyId);
        rawRows.push({
            strategyId,
            label: (stratMeta && stratMeta.label) || strategyId,
            metrics,
            aggregate,
            sideSwap: side
        });

        if (!quiet) {
            console.log(
                JSON.stringify({
                    strategyId,
                    routeCompleteRate: metrics.routeCompleteRate,
                    meanKills: metrics.meanKills,
                    meanExpPerHour: metrics.meanExpPerHour,
                    meanTimeToClear: metrics.meanTimeToClear,
                    partyWipeRate: metrics.partyWipeRate
                })
            );
        }
    }

    const rows = rankStrategyRows(rawRows, rankBy, lowerIsBetter);
    const notes = strategyViabilityNotes(rows);

    const result = {
        schemaVersion: SWEEP_SCHEMA_VERSION,
        kind: 'strategy_eval',
        huntId,
        seed,
        iterationsPerStrategy: iterations,
        strategyIds: strategyIds.slice(),
        classId: o.classId || null,
        partyMode: o.classId ? 'solo_class' : 'hunt_default',
        sideSwap,
        rankBy,
        lowerIsBetter,
        generatedAt: new Date().toISOString(),
        rows,
        notes,
        chartMetrics: [
            'routeCompleteRate',
            'partyWipeRate',
            'meanKills',
            'meanDeaths',
            'meanExpPerHour',
            'meanTimeToClear',
            'meanDamageTaken',
            'meanDamageDealt'
        ]
    };

    if (writeFiles && outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        const jsonPath = path.join(outDir, 'strategy_eval.json');
        const tsvPath = path.join(outDir, 'strategy_eval.tsv');
        fs.writeFileSync(jsonPath, stableStringify(result) + '\n', 'utf8');
        fs.writeFileSync(tsvPath, strategyEvalToTsv(result), 'utf8');
        result.outDir = outDir;
        result.files = { json: jsonPath, tsv: tsvPath };
    }

    return result;
}

/**
 * Strategy tune pass: larger default batch + viability notes (soccer tune analogue).
 * Does not auto-edit presets/strategies.json — emits ranking for human edit loop.
 *
 * @param {object} [opts] same as runStrategyEval; default iterations 8
 * @returns {Promise<object>}
 */
async function runStrategyTune(opts) {
    const o = Object.assign({}, opts || {});
    if (o.iterations == null) o.iterations = 8;
    if (o.sideSwap == null) o.sideSwap = true;
    const result = await runStrategyEval(o);
    result.kind = 'strategy_eval';
    result.tune = true;
    return result;
}

module.exports = {
    SWEEP_SCHEMA_VERSION,
    KNOBS,
    KNOB_META,
    getKnob,
    listKnobs,
    parseValueList,
    clonePlainInput,
    scaleCreatureFields,
    scaleSpawnDensity,
    scaledSpellBook,
    scaledItemDb,
    metricsFromAggregate,
    runBalanceSweep,
    runClassViabilityMatrix,
    runCompositionSideSwap,
    runStrategyEval,
    runStrategyTune,
    listStrategyIds,
    partiesWithStrategy,
    loadHuntPartiesForEval,
    rankStrategyRows,
    strategyViabilityNotes,
    mirrorPartyComposition,
    duoPartyForClasses,
    averageMetrics,
    sweepToTsv,
    classMatrixToTsv,
    strategyEvalToTsv,
    soloPartyForClass,
    defaultStrategyForClass,
    defaultEquipmentForClass,
    normalizeAnalysisDocument,
    chartSeriesFromDocument,
    sampleAnalysisDir,
    aggregateSummaries
};
