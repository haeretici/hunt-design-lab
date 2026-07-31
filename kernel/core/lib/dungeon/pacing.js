/**
 * Stage 11.0 — Pacing foundation (Blueprint Phase 1, metrics only).
 * Stage 11.10 — Macro 15‑min multi-biome: budget.macro + layout/event evaluation.
 *
 * Pure helpers: normalize budgets, derive encounter/idle metrics from
 * session event timestamps, evaluate pass/warn/fail against a budget.
 * No geometry / DRLG.
 */

'use strict';

/** Event kinds that count as "interactive" for the micro-loop (~20s). */
const INTERACTIVE_KINDS = {
    combat: true,
    consumable: true,
    prop: true,
    well: true
};

/** Mid-loop tags counted from kill / special events. */
const MID_TAGS = ['champion', 'elite', 'boss', 'well'];

/**
 * @param {number[]} values sorted ascending
 * @returns {number}
 */
function medianSorted(values) {
    const n = values.length;
    if (n === 0) return 0;
    const mid = Math.floor(n / 2);
    if (n % 2 === 1) return values[mid];
    return (values[mid - 1] + values[mid]) / 2;
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
    if (!values.length) return 0;
    let s = 0;
    for (let i = 0; i < values.length; i++) s += values[i];
    return s / values.length;
}

/**
 * Normalize a pacing budget from hunt JSON / runner overrides.
 * Missing knobs stay null (not evaluated).
 *
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeBudget(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const micro = raw.micro && typeof raw.micro === 'object' ? raw.micro : {};
    const mid = raw.mid && typeof raw.mid === 'object' ? raw.mid : {};
    const session = raw.session && typeof raw.session === 'object' ? raw.session : {};
    const macro = raw.macro && typeof raw.macro === 'object' ? raw.macro : {};

    return {
        id: raw.id != null ? String(raw.id) : null,
        /** Target interactive spacing (design intent, not a hard gate). */
        micro: {
            targetGapSec: numOrNull(micro.targetGapSec),
            minGapSec: numOrNull(micro.minGapSec),
            /** Soft: gap above this → warn */
            warnGapSec: numOrNull(micro.warnGapSec),
            /** Hard: gap above this → fail */
            maxGapSec: numOrNull(micro.maxGapSec),
            /** Soft: mean gap below this → warn (too dense) */
            minMeanGapSec: numOrNull(micro.minMeanGapSec),
            maxMeanGapSec: numOrNull(micro.maxMeanGapSec)
        },
        mid: {
            minKills: intOrNull(mid.minKills),
            maxKills: intOrNull(mid.maxKills),
            minChampions: intOrNull(mid.minChampions),
            maxChampions: intOrNull(mid.maxChampions),
            minElites: intOrNull(mid.minElites),
            maxElites: intOrNull(mid.maxElites),
            minBosses: intOrNull(mid.minBosses),
            maxBosses: intOrNull(mid.maxBosses),
            minWells: intOrNull(mid.minWells),
            maxWells: intOrNull(mid.maxWells)
        },
        session: {
            minTimeSec: numOrNull(session.minTimeSec),
            maxTimeSec: numOrNull(session.maxTimeSec),
            warnMinTimeSec: numOrNull(session.warnMinTimeSec),
            warnMaxTimeSec: numOrNull(session.warnMaxTimeSec),
            minKillsPerMin: numOrNull(session.minKillsPerMin),
            maxKillsPerMin: numOrNull(session.maxKillsPerMin),
            minEventsPerMin: numOrNull(session.minEventsPerMin),
            maxEventsPerMin: numOrNull(session.maxEventsPerMin)
        },
        /**
         * Stage 11.10 — macro ~15‑min biome / art-set transitions.
         * Evaluated from layoutMeta.macro (authored structure) and/or
         * telemetry biome_transition events when present.
         */
        macro: {
            /** Design target seconds per biome segment (default 900). */
            targetSegmentSec: numOrNull(macro.targetSegmentSec),
            /** Soft: mean/planned segment above this → warn */
            warnSegmentSec: numOrNull(macro.warnSegmentSec),
            /** Hard: planned segment above this → fail */
            maxSegmentSec: numOrNull(macro.maxSegmentSec),
            minSegmentSec: numOrNull(macro.minSegmentSec),
            /** Required distinct biome / art transitions in the layout */
            minTransitions: intOrNull(macro.minTransitions),
            maxTransitions: intOrNull(macro.maxTransitions),
            minBiomes: intOrNull(macro.minBiomes),
            maxBiomes: intOrNull(macro.maxBiomes),
            minArtSets: intOrNull(macro.minArtSets),
            maxArtSets: intOrNull(macro.maxArtSets)
        }
    };
}

/**
 * @param {*} v
 * @returns {number|null}
 */
function numOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * @param {*} v
 * @returns {number|null}
 */
function intOrNull(v) {
    if (v == null || v === '') return null;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : null;
}

/**
 * Sort event list by sim-seconds, stable for equal times.
 * @param {object[]} events
 * @returns {object[]}
 */
function sortEvents(events) {
    if (!Array.isArray(events) || !events.length) return [];
    return events
        .slice()
        .map((e, i) => ({ e, i }))
        .sort((a, b) => {
            const ta = Number(a.e.t) || 0;
            const tb = Number(b.e.t) || 0;
            if (ta !== tb) return ta - tb;
            return a.i - b.i;
        })
        .map((x) => x.e);
}

/**
 * Build pacing metrics from telemetry event log + session totals.
 *
 * @param {object} opts
 * @param {object[]} [opts.events]
 * @param {number} [opts.timeSec]
 * @param {number} [opts.kills]
 * @returns {object}
 */
function buildPacingMetrics(opts) {
    const o = opts || {};
    const timeSec = Math.max(0, Number(o.timeSec) || 0);
    const kills =
        o.kills != null ? Math.max(0, Math.floor(Number(o.kills) || 0)) : null;
    const events = sortEvents(o.events || []);

    /** @type {number[]} */
    const encounterTimestamps = [];
    /** @type {number[]} */
    const interactiveTimestamps = [];
    const midCounts = {
        champion: 0,
        elite: 0,
        boss: 0,
        well: 0
    };

    let combatCount = 0;
    let killEventCount = 0;
    let consumableCount = 0;

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        const t = Number(ev.t) || 0;
        const kind = ev.kind || 'other';
        const tag = ev.tag ? String(ev.tag) : null;

        if (kind === 'combat') combatCount += 1;
        if (kind === 'kill') killEventCount += 1;
        if (kind === 'consumable') consumableCount += 1;

        if (kind === 'kill' || kind === 'combat') {
            encounterTimestamps.push(t);
        }
        if (INTERACTIVE_KINDS[kind]) {
            interactiveTimestamps.push(t);
        }

        if (tag && midCounts[tag] != null) {
            midCounts[tag] += 1;
        } else if (kind === 'well') {
            midCounts.well += 1;
        }
    }

    // Micro-loop fallback: if no combat/prop events yet, use kills as interactive.
    let microTimes = interactiveTimestamps.slice();
    let microSource = 'interactive';
    if (microTimes.length === 0) {
        microTimes = events
            .filter((e) => e.kind === 'kill')
            .map((e) => Number(e.t) || 0);
        microSource = microTimes.length ? 'kills' : 'none';
    }

    /** Gaps between successive micro events (sim seconds). */
    const gapsSec = [];
    for (let i = 1; i < microTimes.length; i++) {
        gapsSec.push(Math.max(0, microTimes[i] - microTimes[i - 1]));
    }

    // Trailing idle from last interactive (or session start) to end.
    const lastInteractive =
        microTimes.length > 0 ? microTimes[microTimes.length - 1] : null;
    const secondsSinceLastInteractive =
        lastInteractive != null ? Math.max(0, timeSec - lastInteractive) : timeSec;
    if (microTimes.length > 0 && secondsSinceLastInteractive > 0) {
        // Trailing stretch is an idle gap for longest-idle analysis only
    } else if (microTimes.length === 0 && timeSec > 0) {
        // whole session idle
    }

    const idleStretches = [];
    if (microTimes.length === 0 && timeSec > 0) {
        idleStretches.push({ start: 0, end: timeSec, duration: timeSec });
    } else {
        let cursor = 0;
        for (let i = 0; i < microTimes.length; i++) {
            const t = microTimes[i];
            if (t > cursor) {
                idleStretches.push({
                    start: cursor,
                    end: t,
                    duration: t - cursor
                });
            }
            cursor = t;
        }
        if (timeSec > cursor) {
            idleStretches.push({
                start: cursor,
                end: timeSec,
                duration: timeSec - cursor
            });
        }
    }

    let longestIdleSec = 0;
    for (let i = 0; i < idleStretches.length; i++) {
        if (idleStretches[i].duration > longestIdleSec) {
            longestIdleSec = idleStretches[i].duration;
        }
    }

    const gapsSorted = gapsSec.slice().sort((a, b) => a - b);
    const killCount = kills != null ? kills : killEventCount;
    const minutes = timeSec > 0 ? timeSec / 60 : 0;
    const killsPerMinute = minutes > 0 ? killCount / minutes : 0;
    const eventsPerMinute =
        minutes > 0 ? (events.length > 0 ? events.length / minutes : 0) : 0;
    const interactivePerMinute =
        minutes > 0 ? microTimes.length / minutes : 0;

    // Stage 11.10: macro biome transition timestamps from events
    /** @type {number[]} */
    const biomeTransitionTimestamps = [];
    /** @type {object[]} */
    const biomeTransitions = [];
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev) continue;
        const kind = ev.kind || '';
        if (
            kind === 'biome_transition' ||
            kind === 'macro_transition' ||
            kind === 'biome' ||
            (kind === 'floor' && ev.tag === 'biome_transition')
        ) {
            const t = Number(ev.t) || 0;
            biomeTransitionTimestamps.push(t);
            biomeTransitions.push({
                t,
                fromBiomeId: ev.fromBiomeId || ev.from || null,
                toBiomeId: ev.toBiomeId || ev.to || ev.biomeId || null,
                fromArtSet: ev.fromArtSet || null,
                toArtSet: ev.toArtSet || ev.artSet || null
            });
        }
    }
    /** @type {number[]} */
    const biomeGapsSec = [];
    for (let i = 1; i < biomeTransitionTimestamps.length; i++) {
        biomeGapsSec.push(
            Math.max(
                0,
                biomeTransitionTimestamps[i] - biomeTransitionTimestamps[i - 1]
            )
        );
    }

    return {
        eventCount: events.length,
        combatEventCount: combatCount,
        killEventCount: killEventCount,
        consumableEventCount: consumableCount,
        microSource,
        encounterTimestamps,
        interactiveTimestamps: microTimes.slice(),
        gapsSec: gapsSec.slice(),
        minGapSec: gapsSorted.length ? gapsSorted[0] : null,
        maxGapSec: gapsSorted.length ? gapsSorted[gapsSorted.length - 1] : null,
        meanGapSec: gapsSec.length ? mean(gapsSec) : null,
        medianGapSec: gapsSorted.length ? medianSorted(gapsSorted) : null,
        idleStretches,
        longestIdleSec,
        secondsSinceLastInteractive,
        killsPerMinute,
        eventsPerMinute,
        interactivePerMinute,
        midCounts,
        timeSec,
        biomeTransitionTimestamps,
        biomeTransitions,
        biomeGapsSec,
        biomeTransitionCount: biomeTransitions.length
    };
}

/**
 * Build macro metrics from layoutMeta.macro and/or runtime events.
 *
 * @param {{
 *   layoutMacro?: object|null,
 *   metrics?: object|null,
 *   events?: object[],
 *   timeSec?: number
 * }} opts
 * @returns {object}
 */
function buildMacroMetrics(opts) {
    const o = opts || {};
    const layout = o.layoutMacro || null;
    const metrics = o.metrics || null;
    const timeSec =
        o.timeSec != null
            ? Math.max(0, Number(o.timeSec) || 0)
            : metrics && metrics.timeSec != null
              ? metrics.timeSec
              : 0;

    const segments =
        layout && Array.isArray(layout.segments) ? layout.segments : [];
    const transitions =
        layout && Array.isArray(layout.transitions) ? layout.transitions : [];
    const biomeIds =
        layout && Array.isArray(layout.biomeIds) ? layout.biomeIds.slice() : [];
    const artSets =
        layout && Array.isArray(layout.artSets) ? layout.artSets.slice() : [];

    const plannedTargets = segments.map((s) => Number(s.targetMinSec) || 0);
    let plannedTotalSec = 0;
    for (let i = 0; i < plannedTargets.length; i++) {
        plannedTotalSec += plannedTargets[i];
    }
    const meanPlannedSegmentSec =
        plannedTargets.length > 0
            ? plannedTotalSec / plannedTargets.length
            : null;

    const runtimeTransitions =
        metrics && Array.isArray(metrics.biomeTransitions)
            ? metrics.biomeTransitions
            : [];
    const runtimeGaps =
        metrics && Array.isArray(metrics.biomeGapsSec)
            ? metrics.biomeGapsSec.slice()
            : [];

    return {
        segmentCount: segments.length,
        transitionCount: Math.max(
            transitions.length,
            runtimeTransitions.length
        ),
        layoutTransitionCount: transitions.length,
        runtimeTransitionCount: runtimeTransitions.length,
        biomeIds,
        artSets,
        biomeCount: biomeIds.length,
        artSetCount: artSets.length,
        plannedTargets,
        plannedTotalSec,
        meanPlannedSegmentSec,
        runtimeGapsSec: runtimeGaps,
        meanRuntimeGapSec: runtimeGaps.length ? mean(runtimeGaps) : null,
        timeSec
    };
}

/**
 * @param {string} id
 * @param {'pass'|'warn'|'fail'} status
 * @param {string} message
 * @param {object} [detail]
 * @returns {object}
 */
function check(id, status, message, detail) {
    const c = { id, status, message };
    if (detail != null) c.detail = detail;
    return c;
}

/**
 * Compare value against min/max with optional warn band.
 * @returns {'pass'|'warn'|'fail'|null} null if no bounds set
 */
function rangeStatus(value, hardMin, hardMax, warnMin, warnMax) {
    if (
        hardMin == null &&
        hardMax == null &&
        warnMin == null &&
        warnMax == null
    ) {
        return null;
    }
    if (hardMin != null && value < hardMin) return 'fail';
    if (hardMax != null && value > hardMax) return 'fail';
    if (warnMin != null && value < warnMin) return 'warn';
    if (warnMax != null && value > warnMax) return 'warn';
    return 'pass';
}

/**
 * Worst of pass < warn < fail.
 * @param {'pass'|'warn'|'fail'} a
 * @param {'pass'|'warn'|'fail'} b
 * @returns {'pass'|'warn'|'fail'}
 */
function worse(a, b) {
    const rank = { pass: 0, warn: 1, fail: 2 };
    return rank[b] > rank[a] ? b : a;
}

/**
 * Evaluate pacing metrics (or a hunt summary that embeds them) against a budget.
 * Never ends a session — for analysis / CI only.
 *
 * @param {object} summaryOrMetrics buildHuntSummary result or metrics object
 * @param {object|null|undefined} budget raw or normalized budget
 * @returns {{
 *   status: 'pass'|'warn'|'fail'|'skipped',
 *   budgetId: string|null,
 *   checks: object[],
 *   metrics: object|null
 * }}
 */
function evaluatePacing(summaryOrMetrics, budget) {
    const b = normalizeBudget(budget);
    if (!b) {
        return {
            status: 'skipped',
            budgetId: null,
            checks: [],
            metrics: null
        };
    }

    const metrics =
        summaryOrMetrics && summaryOrMetrics.pacing && summaryOrMetrics.pacing.metrics
            ? summaryOrMetrics.pacing.metrics
            : summaryOrMetrics && summaryOrMetrics.metrics
              ? summaryOrMetrics.metrics
              : summaryOrMetrics && summaryOrMetrics.gapsSec != null
                ? summaryOrMetrics
                : buildPacingMetrics({
                      events:
                          (summaryOrMetrics &&
                              summaryOrMetrics.pacing &&
                              summaryOrMetrics.pacing.events) ||
                          (summaryOrMetrics && summaryOrMetrics.events) ||
                          [],
                      timeSec:
                          (summaryOrMetrics && summaryOrMetrics.timeToClear) != null
                              ? summaryOrMetrics.timeToClear
                              : summaryOrMetrics && summaryOrMetrics.timeSec,
                      kills: summaryOrMetrics && summaryOrMetrics.kills
                  });

    /** @type {object[]} */
    const checks = [];
    let status = 'pass';

    // --- session length ---
    const timeSec = metrics.timeSec != null ? metrics.timeSec : 0;
    const sessionSt = rangeStatus(
        timeSec,
        b.session.minTimeSec,
        b.session.maxTimeSec,
        b.session.warnMinTimeSec,
        b.session.warnMaxTimeSec
    );
    if (sessionSt) {
        checks.push(
            check(
                'session.timeSec',
                sessionSt,
                `session time ${timeSec.toFixed(2)}s`,
                { value: timeSec, bounds: b.session }
            )
        );
        status = worse(status, sessionSt);
    }

    // --- density ---
    const kpmSt = rangeStatus(
        metrics.killsPerMinute,
        b.session.minKillsPerMin,
        b.session.maxKillsPerMin,
        null,
        null
    );
    if (kpmSt) {
        checks.push(
            check(
                'session.killsPerMin',
                kpmSt,
                `kills/min ${metrics.killsPerMinute.toFixed(2)}`,
                { value: metrics.killsPerMinute }
            )
        );
        status = worse(status, kpmSt);
    }

    const epmSt = rangeStatus(
        metrics.eventsPerMinute,
        b.session.minEventsPerMin,
        b.session.maxEventsPerMin,
        null,
        null
    );
    if (epmSt) {
        checks.push(
            check(
                'session.eventsPerMin',
                epmSt,
                `events/min ${metrics.eventsPerMinute.toFixed(2)}`,
                { value: metrics.eventsPerMinute }
            )
        );
        status = worse(status, epmSt);
    }

    // --- micro: longest idle / max gap ---
    const longestIdle = metrics.longestIdleSec || 0;
    if (b.micro.maxGapSec != null || b.micro.warnGapSec != null) {
        let st = 'pass';
        if (b.micro.maxGapSec != null && longestIdle > b.micro.maxGapSec) {
            st = 'fail';
        } else if (
            b.micro.warnGapSec != null &&
            longestIdle > b.micro.warnGapSec
        ) {
            st = 'warn';
        }
        checks.push(
            check(
                'micro.longestIdleSec',
                st,
                `longest idle ${longestIdle.toFixed(2)}s (target ~${
                    b.micro.targetGapSec != null ? b.micro.targetGapSec : 20
                }s)`,
                {
                    value: longestIdle,
                    targetGapSec: b.micro.targetGapSec,
                    warnGapSec: b.micro.warnGapSec,
                    maxGapSec: b.micro.maxGapSec
                }
            )
        );
        status = worse(status, st);
    }

    // Inter-event max gap (excluding pure leading idle if desired — use gapsSec)
    if (
        metrics.maxGapSec != null &&
        (b.micro.maxGapSec != null || b.micro.warnGapSec != null)
    ) {
        let st = 'pass';
        if (b.micro.maxGapSec != null && metrics.maxGapSec > b.micro.maxGapSec) {
            st = 'fail';
        } else if (
            b.micro.warnGapSec != null &&
            metrics.maxGapSec > b.micro.warnGapSec
        ) {
            st = 'warn';
        }
        checks.push(
            check(
                'micro.maxGapSec',
                st,
                `max inter-event gap ${metrics.maxGapSec.toFixed(2)}s`,
                { value: metrics.maxGapSec }
            )
        );
        status = worse(status, st);
    }

    if (metrics.minGapSec != null && b.micro.minGapSec != null) {
        const st = metrics.minGapSec < b.micro.minGapSec ? 'warn' : 'pass';
        checks.push(
            check(
                'micro.minGapSec',
                st,
                `min inter-event gap ${metrics.minGapSec.toFixed(2)}s`,
                { value: metrics.minGapSec, minGapSec: b.micro.minGapSec }
            )
        );
        status = worse(status, st);
    }

    if (metrics.meanGapSec != null) {
        const st = rangeStatus(
            metrics.meanGapSec,
            b.micro.minMeanGapSec,
            b.micro.maxMeanGapSec,
            null,
            null
        );
        if (st) {
            checks.push(
                check(
                    'micro.meanGapSec',
                    st,
                    `mean gap ${metrics.meanGapSec.toFixed(2)}s`,
                    { value: metrics.meanGapSec }
                )
            );
            status = worse(status, st);
        }
    }

    // --- mid: kills + tagged specials ---
    const killCount =
        summaryOrMetrics && summaryOrMetrics.kills != null
            ? summaryOrMetrics.kills
            : metrics.killEventCount;
    const killSt = rangeStatus(
        killCount,
        b.mid.minKills,
        b.mid.maxKills,
        null,
        null
    );
    if (killSt) {
        checks.push(
            check('mid.kills', killSt, `kills ${killCount}`, {
                value: killCount
            })
        );
        status = worse(status, killSt);
    }

    const midPairs = [
        ['champion', b.mid.minChampions, b.mid.maxChampions],
        ['elite', b.mid.minElites, b.mid.maxElites],
        ['boss', b.mid.minBosses, b.mid.maxBosses],
        ['well', b.mid.minWells, b.mid.maxWells]
    ];
    for (let i = 0; i < midPairs.length; i++) {
        const tag = midPairs[i][0];
        const minV = midPairs[i][1];
        const maxV = midPairs[i][2];
        if (minV == null && maxV == null) continue;
        const value =
            (metrics.midCounts && metrics.midCounts[tag]) != null
                ? metrics.midCounts[tag]
                : 0;
        const st = rangeStatus(value, minV, maxV, null, null);
        if (st) {
            checks.push(
                check(`mid.${tag}`, st, `${tag} count ${value}`, {
                    value,
                    min: minV,
                    max: maxV
                })
            );
            status = worse(status, st);
        }
    }

    // --- Stage 11.10 macro: biome / art-set transitions ---
    const layoutMacro =
        (summaryOrMetrics &&
            summaryOrMetrics.layoutMeta &&
            summaryOrMetrics.layoutMeta.macro) ||
        (summaryOrMetrics && summaryOrMetrics.macro) ||
        (summaryOrMetrics &&
            summaryOrMetrics.pacing &&
            summaryOrMetrics.pacing.macro) ||
        null;
    const hasMacroKnobs =
        b.macro &&
        (b.macro.targetSegmentSec != null ||
            b.macro.warnSegmentSec != null ||
            b.macro.maxSegmentSec != null ||
            b.macro.minSegmentSec != null ||
            b.macro.minTransitions != null ||
            b.macro.maxTransitions != null ||
            b.macro.minBiomes != null ||
            b.macro.maxBiomes != null ||
            b.macro.minArtSets != null ||
            b.macro.maxArtSets != null);

    let macroMetrics = null;
    if (hasMacroKnobs || layoutMacro) {
        macroMetrics = buildMacroMetrics({
            layoutMacro,
            metrics,
            timeSec
        });
        metrics.macro = macroMetrics;
    }

    if (hasMacroKnobs && macroMetrics) {
        const tr = macroMetrics.transitionCount;
        const trSt = rangeStatus(
            tr,
            b.macro.minTransitions,
            b.macro.maxTransitions,
            null,
            null
        );
        if (trSt) {
            checks.push(
                check(
                    'macro.transitions',
                    trSt,
                    `biome transitions ${tr}`,
                    { value: tr, bounds: b.macro }
                )
            );
            status = worse(status, trSt);
        }

        const bc = macroMetrics.biomeCount;
        const bcSt = rangeStatus(
            bc,
            b.macro.minBiomes,
            b.macro.maxBiomes,
            null,
            null
        );
        if (bcSt) {
            checks.push(
                check('macro.biomes', bcSt, `distinct biomes ${bc}`, {
                    value: bc,
                    biomeIds: macroMetrics.biomeIds
                })
            );
            status = worse(status, bcSt);
        }

        const ac = macroMetrics.artSetCount;
        const acSt = rangeStatus(
            ac,
            b.macro.minArtSets,
            b.macro.maxArtSets,
            null,
            null
        );
        if (acSt) {
            checks.push(
                check('macro.artSets', acSt, `distinct art sets ${ac}`, {
                    value: ac,
                    artSets: macroMetrics.artSets
                })
            );
            status = worse(status, acSt);
        }

        // Prefer runtime gaps when present; else planned segment targets
        const segmentSec =
            macroMetrics.meanRuntimeGapSec != null
                ? macroMetrics.meanRuntimeGapSec
                : macroMetrics.meanPlannedSegmentSec;
        if (segmentSec != null) {
            let st = rangeStatus(
                segmentSec,
                b.macro.minSegmentSec,
                b.macro.maxSegmentSec,
                null,
                b.macro.warnSegmentSec
            );
            // Also soft-check against target when only target is set
            if (
                st == null &&
                b.macro.targetSegmentSec != null &&
                b.macro.warnSegmentSec == null &&
                b.macro.maxSegmentSec == null
            ) {
                // Informational pass — design intent only
                st = 'pass';
            }
            if (st) {
                checks.push(
                    check(
                        'macro.segmentSec',
                        st,
                        `mean segment ${segmentSec.toFixed(1)}s (target ~${
                            b.macro.targetSegmentSec != null
                                ? b.macro.targetSegmentSec
                                : 900
                        }s)`,
                        {
                            value: segmentSec,
                            targetSegmentSec: b.macro.targetSegmentSec,
                            source:
                                macroMetrics.meanRuntimeGapSec != null
                                    ? 'runtime'
                                    : 'planned'
                        }
                    )
                );
                status = worse(status, st);
            }
        }
    }

    if (checks.length === 0) {
        return {
            status: 'pass',
            budgetId: b.id,
            checks: [
                check('budget', 'pass', 'budget declared but no knobs to evaluate')
            ],
            metrics
        };
    }

    return {
        status,
        budgetId: b.id,
        checks,
        metrics
    };
}

/**
 * Infer mid-loop tag from a creature / entity (champion/elite/boss).
 * @param {object|null|undefined} entity
 * @returns {string|null}
 */
function pacingTagFromEntity(entity) {
    if (!entity) return null;
    if (entity.pacingTag) return String(entity.pacingTag);
    if (entity.rarity) {
        const r = String(entity.rarity).toLowerCase();
        if (r === 'champion' || r === 'elite' || r === 'boss') return r;
    }
    if (Array.isArray(entity.affixes)) {
        for (let i = 0; i < entity.affixes.length; i++) {
            const a = String(entity.affixes[i]).toLowerCase();
            if (a === 'champion' || a === 'elite' || a === 'boss') return a;
        }
    }
    if (entity.isBoss || entity.boss) return 'boss';
    if (entity.isChampion || entity.champion) return 'champion';
    if (entity.isElite || entity.elite) return 'elite';
    return null;
}

module.exports = {
    INTERACTIVE_KINDS,
    MID_TAGS,
    normalizeBudget,
    buildPacingMetrics,
    buildMacroMetrics,
    evaluatePacing,
    pacingTagFromEntity,
    sortEvents
};
