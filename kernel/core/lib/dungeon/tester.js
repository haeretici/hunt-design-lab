/**
 * Stage 11.6 — Headless dungeon generator stress tester (Blueprint Phase 5).
 *
 * Generate N layouts without rendering; report Successful / detailed error log.
 * Checks: rule completion, entrance→exit connectivity, spawn walkability,
 * population capacity/limits, optional pacing-feasibility heuristics.
 */

'use strict';

const { generateProceduralLayout } = require('./layout/procedural.js');
const {
    generateFixedLayout,
    normalizeFixedProfile
} = require('./layout/fixed.js');
const { normalizeRuleProgram } = require('./rules.js');
const {
    validateLayout,
    isWalkableCell,
    validateWalkablePoints
} = require('./validate.js');
const {
    normalizePopulation,
    resolvePopulation
} = require('./population.js');
const { normalizeMarkerRules } = require('./markers.js');
const { normalizePiecePack } = require('./pieces.js');
const { RULE_OPS } = require('./rules.js');

/** Default CI-friendly iteration count. */
const DEFAULT_CI_ITERATIONS = 100;
/** Blueprint stress default when CLI does not override. */
const DEFAULT_STRESS_ITERATIONS = 10000;
/** Cap how many failing seeds are kept in the report error log. */
const DEFAULT_MAX_FAIL_SAMPLES = 50;

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
 * Detect layout type from a raw dungeon profile.
 * @param {object|null|undefined} raw
 * @returns {'procedural'|'fixed'|null}
 */
function detectLayoutType(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const t = String(raw.type || raw.kind || '').toLowerCase();
    if (
        t === 'fixed' ||
        t === 'fixed_cutout' ||
        t === 'fixed+cutouts' ||
        t === 'cutout' ||
        t === 'cutouts'
    ) {
        return 'fixed';
    }
    if (t === 'procedural' || t === 'proc' || t === 'drlg') {
        return 'procedural';
    }
    // Heuristic: fixed bases carry placements / inline friction / cutouts
    if (
        Array.isArray(raw.placements) ||
        Array.isArray(raw.pieces) ||
        raw.friction != null ||
        (raw.base && raw.base.friction != null) ||
        (Array.isArray(raw.cutouts) && raw.cutouts.length)
    ) {
        return 'fixed';
    }
    if (Array.isArray(raw.rules) && raw.rules.length) return 'procedural';
    return null;
}

/**
 * @param {object[]} placements
 * @returns {Record<string, number>}
 */
function countRoles(placements) {
    /** @type {Record<string, number>} */
    const counts = Object.create(null);
    const list = Array.isArray(placements) ? placements : [];
    for (let i = 0; i < list.length; i++) {
        const r = list[i] && list[i].role != null ? String(list[i].role) : 'unknown';
        counts[r] = (counts[r] || 0) + 1;
    }
    return counts;
}

/**
 * Push a structured check result.
 * @param {object[]} checks
 * @param {string} code
 * @param {boolean} ok
 * @param {string} message
 * @param {*} [detail]
 */
function pushCheck(checks, code, ok, message, detail) {
    const row = { code, ok, message };
    if (detail !== undefined) row.detail = detail;
    checks.push(row);
}

/**
 * Rule-completion / structural checks after a successful generate.
 * @param {object} gen
 * @param {'procedural'|'fixed'} layoutType
 * @param {object[]} checks
 * @param {object[]} errors
 */
function checkRuleCompletion(gen, layoutType, checks, errors) {
    if (layoutType === 'fixed') {
        const pieceCount =
            (gen.meta && gen.meta.pieceCount) ||
            (gen.placements && gen.placements.length) ||
            0;
        const ok = pieceCount > 0 || (gen.cols > 0 && gen.rows > 0);
        pushCheck(
            checks,
            'rule_completion',
            ok,
            ok
                ? `Fixed base ready (${pieceCount} placement(s), ${(gen.cutouts && gen.cutouts.length) || 0} cutout(s))`
                : 'Fixed base empty'
        );
        if (!ok) {
            errors.push({
                code: 'rule_incomplete',
                message: 'Fixed layout produced empty base',
                detail: { pieceCount }
            });
        }
        return;
    }

    // Procedural: generation success already required full tryGrow; verify roles
    const rules = (gen.meta && gen.meta.rules) || [];
    const roles = countRoles(gen.placements || []);
    let ok = true;
    const detail = { rules, roles, events: (gen.events && gen.events.length) || 0 };

    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        if (!r || r.n <= 0) continue;
        if (r.op === RULE_OPS.AddHub) {
            if ((roles.hub || 0) < 1) {
                ok = false;
                errors.push({
                    code: 'rule_incomplete',
                    message: `AddHub expected hub placement, got ${roles.hub || 0}`,
                    detail: r
                });
            }
        } else if (r.op === RULE_OPS.AddRoom) {
            if ((roles.room || 0) < r.n) {
                ok = false;
                errors.push({
                    code: 'rule_incomplete',
                    message: `AddRoom expected ${r.n} room(s), got ${roles.room || 0}`,
                    detail: r
                });
            }
        } else if (r.op === RULE_OPS.AddCorridor) {
            // Cap/connectors may also place corridors; only require minimum
            if ((roles.corridor || 0) < r.n) {
                ok = false;
                errors.push({
                    code: 'rule_incomplete',
                    message: `AddCorridor expected ${r.n}, got ${roles.corridor || 0}`,
                    detail: r
                });
            }
        } else if (r.op === RULE_OPS.AddExit) {
            if ((roles.exit || 0) < r.n) {
                ok = false;
                errors.push({
                    code: 'rule_incomplete',
                    message: `AddExit expected ${r.n} exit piece(s), got ${roles.exit || 0}`,
                    detail: r
                });
            }
        } else if (r.op === RULE_OPS.SelectEvent) {
            const nEvents = (gen.events && gen.events.length) || 0;
            // assignEvents may cap by candidate count
            if (nEvents < 1 && r.n > 0 && (roles.room || 0) + (roles.hub || 0) > 0) {
                ok = false;
                errors.push({
                    code: 'rule_incomplete',
                    message: `SelectEvent expected events, got ${nEvents}`,
                    detail: r
                });
            }
        }
    }

    if (!rules.length && !(gen.placements && gen.placements.length)) {
        ok = false;
        errors.push({
            code: 'rule_incomplete',
            message: 'No rules materialized and no placements'
        });
    }

    pushCheck(
        checks,
        'rule_completion',
        ok,
        ok ? 'Rule program completed' : 'Rule program incomplete',
        detail
    );
}

/**
 * Connectivity + walkability re-validation (does not trust gen.validation alone).
 * @param {object} gen
 * @param {object[]} checks
 * @param {object[]} errors
 */
function checkConnectivityAndWalkability(gen, checks, errors) {
    const validation = validateLayout(
        {
            cols: gen.cols,
            rows: gen.rows,
            friction: gen.friction,
            sockets: gen.sockets
        },
        {
            entrance: gen.entrance,
            exit: gen.exit,
            requireEntranceExit: true,
            requireSpawnWalkable: true
        }
    );

    // Split connectivity from walkability for clearer logs
    const connErr = (validation.errors || []).find(
        (e) =>
            e.code === 'disconnected' ||
            e.code === 'missing_entrance_exit' ||
            e.code === 'too_few_walkable' ||
            e.code === 'bad_bounds' ||
            e.code === 'empty_layout'
    );
    const spawnErr = (validation.errors || []).find(
        (e) => e.code === 'spawn_blocked' || e.code === 'marker_blocked'
    );

    const reachOk = !connErr && !!(validation.connectivity && validation.connectivity.ok);
    pushCheck(
        checks,
        'connectivity',
        reachOk,
        reachOk
            ? `Entrance→exit path length ${validation.connectivity.pathLength}`
            : (connErr && connErr.message) || 'Entrance cannot reach exit',
        validation.connectivity || connErr
    );
    if (!reachOk) {
        errors.push(
            connErr || {
                code: 'disconnected',
                message: 'Entrance cannot reach exit',
                detail: validation.connectivity
            }
        );
    }

    const walkOk = !spawnErr;
    pushCheck(
        checks,
        'spawn_walkability',
        walkOk,
        walkOk
            ? 'Spawn/marker sockets walkable'
            : (spawnErr && spawnErr.message) || 'Blocked sockets',
        spawnErr && spawnErr.detail
    );
    if (!walkOk && spawnErr) {
        errors.push(spawnErr);
    }

    // Explicit spawn point re-check (fixed layouts may skip walkability at gen time)
    if (Array.isArray(gen.spawns) && gen.spawns.length && gen.friction) {
        const sv = validateWalkablePoints(
            gen.friction,
            gen.cols,
            gen.rows,
            gen.spawns
        );
        if (!sv.ok) {
            pushCheck(
                checks,
                'spawn_def_walkability',
                false,
                `${sv.bad.length} spawn def(s) not walkable`,
                sv.bad.slice(0, 8)
            );
            errors.push({
                code: 'spawn_blocked',
                message: `${sv.bad.length} resolved spawn(s) not walkable`,
                detail: sv.bad.slice(0, 8)
            });
        } else {
            pushCheck(
                checks,
                'spawn_def_walkability',
                true,
                `${gen.spawns.length} spawn def(s) walkable`
            );
        }
    }

    return validation;
}

/**
 * Population capacity + limit checks.
 *
 * Hard fails: zero sockets when packs are required; resolved packs above max.
 * Capacity under table mins is reported as a soft check (warn) — cutouts and
 * small procedural layouts often intentionally under-fill corridor tables.
 *
 * @param {object} gen
 * @param {object|null} population normalized or raw
 * @param {number} seed
 * @param {object[]} checks
 * @param {object[]} errors
 * @returns {object|null} resolve meta
 */
function checkPopulation(gen, population, seed, checks, errors) {
    const pop = normalizePopulation(population);
    if (!pop) {
        pushCheck(checks, 'population_limits', true, 'No population table (skipped)');
        return null;
    }

    const slots =
        (gen.populationSlots && gen.populationSlots.length
            ? gen.populationSlots
            : null) ||
        (gen.sockets && gen.sockets.spawns) ||
        [];
    const slotCount = slots.length;

    const [tMin, tMax] = pop.limits.totalPacks;
    const packLimits = pop.limits.packLimits || {};
    const gids = Object.keys(packLimits);
    let minGroupPacks = 0;
    for (let i = 0; i < gids.length; i++) {
        minGroupPacks += Math.max(0, packLimits[gids[i]][0] || 0);
    }
    const tableMinPacks = Math.max(tMin, minGroupPacks);

    // Fixed cutouts already resolve with maxPacks caps — capacity vs full table mins
    // would false-fail intentional sparse pockets.
    const prefilled = !!(gen.populationMeta && Array.isArray(gen.spawns));

    if (!prefilled) {
        if (tableMinPacks > 0 && slotCount === 0) {
            pushCheck(
                checks,
                'population_capacity',
                false,
                'No spawn sockets for population table',
                { slotCount, tableMinPacks }
            );
            errors.push({
                code: 'population_capacity',
                message: 'No spawn sockets for population table',
                detail: { populationId: pop.id, tableMinPacks }
            });
        } else {
            const coversMins = tableMinPacks === 0 || slotCount >= tableMinPacks;
            pushCheck(
                checks,
                'population_capacity',
                true,
                coversMins
                    ? `Spawn sockets ${slotCount} (table min packs ${tableMinPacks})`
                    : `Spawn sockets ${slotCount} < table min packs ${tableMinPacks} (soft)`,
                { slotCount, tableMinPacks, soft: !coversMins }
            );
        }
    } else {
        pushCheck(
            checks,
            'population_capacity',
            true,
            `Prefilled layout spawns (${gen.spawns.length}); slots ${slotCount}`,
            { slotCount, creatureCount: gen.spawns.length }
        );
    }

    // Resolve for limit verification
    let meta = null;
    if (prefilled) {
        meta = gen.populationMeta;
    } else if (slotCount > 0) {
        const resolved = resolvePopulation({
            population: pop,
            slots,
            seed,
            defaultZ: gen.meta && gen.meta.floor != null ? gen.meta.floor : 0
        });
        meta = resolved.meta;
        if (gen.friction && resolved.spawns.length) {
            const sv = validateWalkablePoints(
                gen.friction,
                gen.cols,
                gen.rows,
                resolved.spawns
            );
            if (!sv.ok) {
                errors.push({
                    code: 'spawn_blocked',
                    message: `${sv.bad.length} population spawn(s) not walkable`,
                    detail: sv.bad.slice(0, 8)
                });
                pushCheck(
                    checks,
                    'population_spawn_walkability',
                    false,
                    'Population spawns blocked',
                    sv.bad.slice(0, 8)
                );
            }
        }
    }

    if (!meta) {
        if (tableMinPacks === 0 || slotCount === 0) {
            // already recorded capacity if needed
            pushCheck(
                checks,
                'population_limits',
                tableMinPacks === 0 || slotCount > 0,
                'No population resolve meta',
                { slotCount }
            );
        }
        return null;
    }

    const groupCounts = meta.groupCounts || {};
    let limitsOk = true;
    const limitDetail = { groupCounts, packLimits, prefilled };

    // Hard: never exceed table maxes (prefilled cutouts override total via maxPacks)
    for (let i = 0; i < gids.length; i++) {
        const id = gids[i];
        const hi = packLimits[id][1];
        const got = groupCounts[id] || 0;
        if (got > hi) {
            limitsOk = false;
            errors.push({
                code: 'population_limit',
                message: `Group ${id} packs ${got} > max ${hi}`,
                detail: { groupId: id, got, max: hi }
            });
        }
    }

    const packCount = meta.packCount || 0;
    // Prefilled cutouts cap total below table max; only enforce table max when not prefilled
    if (!prefilled && packCount > tMax) {
        limitsOk = false;
        errors.push({
            code: 'population_limit',
            message: `Total packs ${packCount} > max ${tMax}`,
            detail: { packCount, max: tMax }
        });
    }

    pushCheck(
        checks,
        'population_limits',
        limitsOk,
        limitsOk
            ? `Population packs within max limits (${packCount} packs)`
            : 'Population packs outside limits',
        limitDetail
    );

    return meta;
}

/**
 * Pacing feasibility: enough sockets for marker pools / micro interactivity.
 * Heuristic only — does not run a hunt.
 * @param {object} gen
 * @param {object|null} markerRules raw or normalized
 * @param {object|null} pacingBudget
 * @param {object[]} checks
 * @param {object[]} errors
 */
function checkPacingFeasibility(gen, markerRules, pacingBudget, checks, errors) {
    const rules = normalizeMarkerRules(markerRules);
    const markerSocks =
        (gen.markerSockets && gen.markerSockets.length
            ? gen.markerSockets
            : null) ||
        (gen.sockets && gen.sockets.markers) ||
        [];
    const spawnSocks =
        (gen.populationSlots && gen.populationSlots.length
            ? gen.populationSlots
            : null) ||
        (gen.sockets && gen.sockets.spawns) ||
        [];

    /** @type {Record<string, number>} */
    const byId = Object.create(null);
    for (let i = 0; i < markerSocks.length; i++) {
        const id =
            markerSocks[i].id != null
                ? String(markerSocks[i].id)
                : 'A';
        byId[id] = (byId[id] || 0) + 1;
    }

    let ok = true;
    const detail = {
        markerSockets: markerSocks.length,
        spawnSockets: spawnSocks.length,
        byMarkerId: byId
    };

    if (rules) {
        const poolIds = Object.keys(rules.pools);
        for (let i = 0; i < poolIds.length; i++) {
            const id = poolIds[i];
            const pool = rules.pools[id];
            const minSpawn = pool.spawnCount[0];
            if (minSpawn <= 0) continue;
            const available = byId[id] || 0;
            if (available < minSpawn) {
                ok = false;
                errors.push({
                    code: 'pacing_feasibility',
                    message: `Marker pool ${id} needs min ${minSpawn} socket(s), have ${available}`,
                    detail: { markerId: id, min: minSpawn, available }
                });
            }
        }
    }

    // Micro budget: need some interactive sockets if a micro target is set
    const micro =
        pacingBudget && pacingBudget.micro && typeof pacingBudget.micro === 'object'
            ? pacingBudget.micro
            : null;
    const targetGap = micro ? numOrNull(micro.targetGapSec) : null;
    if (targetGap != null && targetGap > 0) {
        const interact = spawnSocks.length + markerSocks.length;
        // Very soft: at least 2 interact opportunities for a micro loop
        if (interact < 2) {
            ok = false;
            errors.push({
                code: 'pacing_feasibility',
                message: `Micro budget set but only ${interact} interact socket(s)`,
                detail: { interact, targetGapSec: targetGap }
            });
        }
        detail.interactSockets = interact;
        detail.targetGapSec = targetGap;
    }

    pushCheck(
        checks,
        'pacing_feasibility',
        ok,
        ok
            ? 'Pacing feasibility heuristic passed'
            : 'Pacing feasibility heuristic failed',
        detail
    );
}

/**
 * Assess one generation result (ok or failed generate).
 *
 * @param {object} gen generateProceduralLayout / generateFixedLayout result
 * @param {{
 *   layoutType: 'procedural'|'fixed',
 *   population?: object|null,
 *   markerRules?: object|null,
 *   pacingBudget?: object|null,
 *   checkPopulation?: boolean,
 *   checkPacing?: boolean
 * }} ctx
 * @returns {{
 *   successful: boolean,
 *   Successful: boolean,
 *   seed: number,
 *   profileId: string|null,
 *   errors: object[],
 *   checks: object[],
 *   errorLog: string[],
 *   stats?: object
 * }}
 */
function assessGeneration(gen, ctx) {
    const c = ctx || {};
    const layoutType = c.layoutType || 'procedural';
    /** @type {object[]} */
    const errors = [];
    /** @type {object[]} */
    const checks = [];
    const seed = gen && gen.seed != null ? gen.seed : 0;
    const profileId = gen && gen.profileId != null ? gen.profileId : null;

    if (!gen || !gen.ok) {
        const err = (gen && gen.error) || {
            code: 'generate_failed',
            message: 'Generation failed'
        };
        errors.push(err);
        pushCheck(
            checks,
            'generate',
            false,
            err.message || err.code || 'Generation failed',
            err
        );
        // Rule completion failed if generator could not finish
        pushCheck(
            checks,
            'rule_completion',
            false,
            'Generation did not complete rule program',
            err
        );
        return {
            successful: false,
            Successful: false,
            seed,
            profileId,
            errors,
            checks,
            errorLog: formatErrorLog(seed, errors),
            attempts: gen && gen.attempts
        };
    }

    pushCheck(checks, 'generate', true, 'Layout generated', {
        cols: gen.cols,
        rows: gen.rows,
        attempts: gen.attempts
    });

    checkRuleCompletion(gen, layoutType, checks, errors);
    const validation = checkConnectivityAndWalkability(gen, checks, errors);

    let popMeta = null;
    if (c.checkPopulation !== false) {
        popMeta = checkPopulation(
            gen,
            c.population || null,
            seed,
            checks,
            errors
        );
    }

    if (c.checkPacing !== false) {
        checkPacingFeasibility(
            gen,
            c.markerRules || null,
            c.pacingBudget || null,
            checks,
            errors
        );
    }

    const successful = errors.length === 0;
    const stats = {
        cols: gen.cols,
        rows: gen.rows,
        walkable: validation && validation.walkable,
        pieceCount:
            (gen.meta && gen.meta.pieceCount) ||
            (gen.placements && gen.placements.length) ||
            0,
        spawnSockets:
            (gen.sockets && gen.sockets.spawns && gen.sockets.spawns.length) ||
            (gen.populationSlots && gen.populationSlots.length) ||
            0,
        markerSockets:
            (gen.sockets && gen.sockets.markers && gen.sockets.markers.length) ||
            (gen.markerSockets && gen.markerSockets.length) ||
            0,
        attempts: gen.attempts || 1,
        pathLength:
            validation &&
            validation.connectivity &&
            validation.connectivity.pathLength,
        packCount: popMeta ? popMeta.packCount : null,
        creatureCount: popMeta ? popMeta.creatureCount : null
    };

    return {
        successful,
        Successful: successful,
        seed,
        profileId,
        errors,
        checks,
        errorLog: formatErrorLog(seed, errors),
        stats,
        attempts: gen.attempts
    };
}

/**
 * Human-readable error log lines (blueprint "detailed error log").
 * @param {number} seed
 * @param {object[]} errors
 * @returns {string[]}
 */
function formatErrorLog(seed, errors) {
    const lines = [];
    const list = Array.isArray(errors) ? errors : [];
    if (!list.length) {
        lines.push(`seed=${seed} Successful`);
        return lines;
    }
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const code = e && e.code != null ? e.code : 'error';
        const msg = e && e.message != null ? e.message : String(e);
        lines.push(`seed=${seed} [${code}] ${msg}`);
    }
    return lines;
}

/**
 * Generate one layout for a profile (procedural or fixed).
 *
 * @param {{
 *   profile: object,
 *   pack?: object|null,
 *   seed: number,
 *   layoutType?: 'procedural'|'fixed',
 *   loadPopulation?: (id: string) => object,
 *   population?: object|null
 * }} opts
 * @returns {object}
 */
function generateOnce(opts) {
    const o = opts || {};
    const raw = o.profile;
    if (!raw || typeof raw !== 'object') {
        return {
            ok: false,
            seed: o.seed != null ? o.seed >>> 0 || 1 : 1,
            profileId: null,
            error: {
                code: 'invalid_profile',
                message: 'Missing dungeon profile'
            }
        };
    }

    const layoutType = o.layoutType || detectLayoutType(raw) || 'procedural';
    const seed = o.seed != null ? o.seed >>> 0 || 1 : 1;

    let pack = o.pack || null;
    if (pack && !pack.byId) {
        pack = normalizePiecePack(pack);
    }

    if (layoutType === 'fixed') {
        return generateFixedLayout({
            profile: raw,
            pack,
            seed,
            loadPopulation: o.loadPopulation,
            population: o.population
        });
    }

    return generateProceduralLayout({
        profile: raw,
        pack,
        seed,
        maxAttempts: raw.maxAttempts
    });
}

/**
 * Run N-iteration dungeon generation stress test.
 *
 * @param {{
 *   profileId?: string,
 *   profile?: object,
 *   pack?: object,
 *   population?: object|null,
 *   markerRules?: object|null,
 *   iterations?: number,
 *   seedStart?: number,
 *   failRateThreshold?: number,
 *   maxFailSamples?: number,
 *   checkPopulation?: boolean,
 *   checkPacing?: boolean,
 *   loadDungeonProfile?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   loadPopulation?: (id: string) => object,
 *   loadMarkers?: (id: string) => object,
 *   onProgress?: (info: object) => void,
 *   progressEvery?: number,
 *   quiet?: boolean
 * }} opts
 * @returns {{
 *   Successful: boolean,
 *   successful: boolean,
 *   profileId: string|null,
 *   layoutType: string|null,
 *   iterations: number,
 *   seedStart: number,
 *   seedEnd: number,
 *   passed: number,
 *   failed: number,
 *   failureRate: number,
 *   failRateThreshold: number,
 *   errorCodes: Record<string, number>,
 *   errorLog: object[],
 *   errorLogLines: string[],
 *   stats: object,
 *   durationMs: number,
 *   runs?: object[]
 * }}
 */
function runDungeonTests(opts) {
    const o = opts || {};
    const iterations = Math.max(
        1,
        Math.floor(
            o.iterations != null ? o.iterations : DEFAULT_CI_ITERATIONS
        )
    );
    const seedStart =
        o.seedStart != null
            ? o.seedStart >>> 0 || 1
            : o.seed != null
              ? o.seed >>> 0 || 1
              : 1;
    const failRateThreshold =
        o.failRateThreshold != null ? Number(o.failRateThreshold) : 0;
    const maxFailSamples =
        o.maxFailSamples != null
            ? Math.max(0, Math.floor(o.maxFailSamples))
            : DEFAULT_MAX_FAIL_SAMPLES;
    const progressEvery =
        o.progressEvery != null
            ? Math.max(0, Math.floor(o.progressEvery))
            : iterations >= 1000
              ? Math.floor(iterations / 20)
              : 0;

    let profile = o.profile || null;
    let profileId =
        o.profileId != null
            ? String(o.profileId)
            : profile && profile.id != null
              ? String(profile.id)
              : null;

    if (!profile && profileId && typeof o.loadDungeonProfile === 'function') {
        try {
            profile = o.loadDungeonProfile(profileId);
        } catch (e) {
            return emptyFailReport({
                profileId,
                iterations,
                seedStart,
                failRateThreshold,
                message: `Dungeon profile not found: ${profileId}${e && e.message ? ` (${e.message})` : ''}`,
                code: 'missing_profile'
            });
        }
    }
    if (!profile) {
        return emptyFailReport({
            profileId,
            iterations,
            seedStart,
            failRateThreshold,
            message: profileId
                ? `Dungeon profile not found: ${profileId}`
                : 'profileId or profile required',
            code: 'missing_profile'
        });
    }
    if (!profileId && profile.id != null) profileId = String(profile.id);

    const layoutType = detectLayoutType(profile);
    if (!layoutType) {
        return emptyFailReport({
            profileId,
            iterations,
            seedStart,
            failRateThreshold,
            message: 'Could not detect layout type (procedural|fixed)',
            code: 'unknown_layout_type'
        });
    }

    // Piece pack
    let pack = o.pack || null;
    const piecePackId =
        profile.piecePack != null
            ? String(profile.piecePack)
            : profile.piecePackId != null
              ? String(profile.piecePackId)
              : null;
    if (!pack && piecePackId && typeof o.loadPiecePack === 'function') {
        pack = o.loadPiecePack(piecePackId);
    }
    if (pack && !pack.byId) {
        pack = normalizePiecePack(pack);
    }
    if (layoutType === 'procedural' && (!pack || !pack.pieces || !pack.pieces.length)) {
        return emptyFailReport({
            profileId,
            iterations,
            seedStart,
            failRateThreshold,
            message: piecePackId
                ? `Piece pack missing or empty: ${piecePackId}`
                : 'Piece pack required for procedural profile',
            code: 'missing_piece_pack'
        });
    }

    // Population / markers (optional checks)
    let population = o.population || null;
    if (
        !population &&
        profile.populationId &&
        typeof o.loadPopulation === 'function'
    ) {
        try {
            population = o.loadPopulation(String(profile.populationId));
        } catch (_e) {
            population = null;
        }
    }

    let markerRules = o.markerRules || null;
    if (
        !markerRules &&
        profile.markersId &&
        typeof o.loadMarkers === 'function'
    ) {
        try {
            markerRules = o.loadMarkers(String(profile.markersId));
        } catch (_e) {
            markerRules = null;
        }
    }

    const pacingBudget =
        profile.pacingBudget && typeof profile.pacingBudget === 'object'
            ? profile.pacingBudget
            : null;

    const loadPopulation =
        typeof o.loadPopulation === 'function' ? o.loadPopulation : null;

    const t0 =
        typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint
            ? process.hrtime.bigint()
            : Date.now();

    let passed = 0;
    let failed = 0;
    /** @type {Record<string, number>} */
    const errorCodes = Object.create(null);
    /** @type {object[]} */
    const errorLog = [];
    /** @type {string[]} */
    const errorLogLines = [];
    /** @type {object[]} */
    const sampleRuns = [];

    // Aggregate stats
    let sumPieces = 0;
    let sumWalkable = 0;
    let sumAttempts = 0;
    let sumSpawnSocks = 0;
    let sumPath = 0;
    let statN = 0;

    const assessCtx = {
        layoutType,
        population,
        markerRules,
        pacingBudget,
        checkPopulation: o.checkPopulation !== false,
        checkPacing: o.checkPacing !== false
    };

    for (let i = 0; i < iterations; i++) {
        const seed = (seedStart + i) >>> 0 || 1;
        const gen = generateOnce({
            profile,
            pack,
            seed,
            layoutType,
            loadPopulation,
            population
        });
        const assessment = assessGeneration(gen, assessCtx);

        if (assessment.successful) {
            passed++;
        } else {
            failed++;
            for (let e = 0; e < assessment.errors.length; e++) {
                const code =
                    assessment.errors[e].code != null
                        ? String(assessment.errors[e].code)
                        : 'error';
                errorCodes[code] = (errorCodes[code] || 0) + 1;
            }
            if (errorLog.length < maxFailSamples) {
                errorLog.push({
                    seed,
                    Successful: false,
                    successful: false,
                    errors: assessment.errors,
                    errorLog: assessment.errorLog,
                    checks: assessment.checks
                });
            }
            for (let L = 0; L < assessment.errorLog.length; L++) {
                if (errorLogLines.length < maxFailSamples * 4) {
                    errorLogLines.push(assessment.errorLog[L]);
                }
            }
        }

        if (assessment.stats) {
            statN++;
            sumPieces += assessment.stats.pieceCount || 0;
            sumWalkable += assessment.stats.walkable || 0;
            sumAttempts += assessment.stats.attempts || 0;
            sumSpawnSocks += assessment.stats.spawnSockets || 0;
            sumPath += assessment.stats.pathLength || 0;
        }

        // Keep first few full runs for debug (ok + fail)
        if (sampleRuns.length < 3) {
            sampleRuns.push({
                seed,
                successful: assessment.successful,
                errors: assessment.errors,
                stats: assessment.stats
            });
        }

        if (
            progressEvery > 0 &&
            typeof o.onProgress === 'function' &&
            ((i + 1) % progressEvery === 0 || i + 1 === iterations)
        ) {
            o.onProgress({
                done: i + 1,
                iterations,
                passed,
                failed,
                seed
            });
        }
    }

    const t1 =
        typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint
            ? process.hrtime.bigint()
            : Date.now();
    const durationMs =
        typeof t0 === 'bigint'
            ? Number(t1 - t0) / 1e6
            : Number(t1) - Number(t0);

    const failureRate = iterations > 0 ? failed / iterations : 0;
    // Blueprint "Successful": failure rate at or under threshold (0 ⇒ all must pass).
    const successful = failureRate <= failRateThreshold + 1e-12;

    const report = {
        Successful: successful,
        successful,
        profileId,
        layoutType,
        piecePackId,
        populationId: profile.populationId != null ? String(profile.populationId) : null,
        markersId: profile.markersId != null ? String(profile.markersId) : null,
        iterations,
        seedStart,
        seedEnd: (seedStart + iterations - 1) >>> 0 || 1,
        passed,
        failed,
        failureRate,
        failRateThreshold,
        errorCodes,
        errorLog,
        errorLogLines,
        stats: {
            avgPieceCount: statN ? sumPieces / statN : 0,
            avgWalkable: statN ? sumWalkable / statN : 0,
            avgAttempts: statN ? sumAttempts / statN : 0,
            avgSpawnSockets: statN ? sumSpawnSocks / statN : 0,
            avgPathLength: statN ? sumPath / statN : 0,
            samples: statN
        },
        durationMs,
        runsPerSec: durationMs > 0 ? (iterations / durationMs) * 1000 : 0,
        sampleRuns
    };

    return report;
}

/**
 * @param {object} p
 * @returns {object}
 */
function emptyFailReport(p) {
    const err = {
        code: p.code || 'error',
        message: p.message || 'Test setup failed'
    };
    return {
        Successful: false,
        successful: false,
        profileId: p.profileId || null,
        layoutType: null,
        piecePackId: null,
        populationId: null,
        markersId: null,
        iterations: p.iterations || 0,
        seedStart: p.seedStart || 1,
        seedEnd: p.seedStart || 1,
        passed: 0,
        failed: p.iterations || 1,
        failureRate: 1,
        failRateThreshold: p.failRateThreshold != null ? p.failRateThreshold : 0,
        errorCodes: { [err.code]: 1 },
        errorLog: [
            {
                seed: p.seedStart || 1,
                Successful: false,
                successful: false,
                errors: [err],
                errorLog: [
                    `seed=${p.seedStart || 1} [${err.code}] ${err.message}`
                ],
                checks: []
            }
        ],
        errorLogLines: [
            `seed=${p.seedStart || 1} [${err.code}] ${err.message}`
        ],
        stats: {
            avgPieceCount: 0,
            avgWalkable: 0,
            avgAttempts: 0,
            avgSpawnSockets: 0,
            avgPathLength: 0,
            samples: 0
        },
        durationMs: 0,
        runsPerSec: 0,
        sampleRuns: []
    };
}

module.exports = {
    DEFAULT_CI_ITERATIONS,
    DEFAULT_STRESS_ITERATIONS,
    DEFAULT_MAX_FAIL_SAMPLES,
    detectLayoutType,
    generateOnce,
    assessGeneration,
    runDungeonTests,
    formatErrorLog,
    checkRuleCompletion,
    checkConnectivityAndWalkability,
    checkPopulation,
    checkPacingFeasibility,
    // re-exports handy for tests
    normalizeFixedProfile,
    normalizeRuleProgram,
    isWalkableCell
};
