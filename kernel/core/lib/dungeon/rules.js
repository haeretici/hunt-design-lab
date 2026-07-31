/**
 * Stage 11.4 — Procedural rule program (JSON first).
 *
 * Designers express layout intent as ops (AddHub, AddRoom, AddExit,
 * SelectEvent, optional AddCorridor). Counts may be scalars or [min, max].
 */

'use strict';

/** Supported ops (case-insensitive at normalize). */
const RULE_OPS = {
    AddHub: 'AddHub',
    AddRoom: 'AddRoom',
    AddCorridor: 'AddCorridor',
    AddExit: 'AddExit',
    SelectEvent: 'SelectEvent'
};

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
 * Normalize [min, max], {min,max}, or scalar → [min, max] with min<=max.
 * @param {*} raw
 * @param {number} fallbackMin
 * @param {number} fallbackMax
 * @returns {[number, number]}
 */
function pairMinMax(raw, fallbackMin, fallbackMax) {
    let lo = fallbackMin;
    let hi = fallbackMax;
    if (Array.isArray(raw) && raw.length >= 1) {
        lo = Number(raw[0]);
        hi = raw.length >= 2 ? Number(raw[1]) : lo;
    } else if (raw && typeof raw === 'object') {
        if (raw.min != null) lo = Number(raw.min);
        if (raw.max != null) hi = Number(raw.max);
        else if (raw.min != null) hi = lo;
    } else if (raw != null && raw !== '') {
        lo = Number(raw);
        hi = lo;
    }
    if (!Number.isFinite(lo)) lo = fallbackMin;
    if (!Number.isFinite(hi)) hi = fallbackMax;
    lo = Math.floor(lo);
    hi = Math.floor(hi);
    if (hi < lo) {
        const t = lo;
        lo = hi;
        hi = t;
    }
    return [lo, hi];
}

/**
 * @param {() => number} rng
 * @param {number} min inclusive
 * @param {number} max inclusive
 * @returns {number}
 */
function randInt(rng, min, max) {
    const lo = Math.floor(min);
    const hi = Math.floor(max);
    if (hi <= lo) return lo;
    return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Normalize one rule row.
 * @param {object} raw
 * @param {number} index
 * @returns {object|null}
 */
function normalizeRule(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const opRaw =
        raw.op != null
            ? String(raw.op)
            : raw.type != null
              ? String(raw.type)
              : raw.rule != null
                ? String(raw.rule)
                : '';
    // Accept "AddHub", "add_hub", "add-hub", "hub"
    const lower = opRaw.toLowerCase().replace(/[_\s-]/g, '');
    let op = null;
    if (lower === 'addhub' || lower === 'hub') op = RULE_OPS.AddHub;
    else if (lower === 'addroom' || lower === 'room') op = RULE_OPS.AddRoom;
    else if (lower === 'addcorridor' || lower === 'corridor') {
        op = RULE_OPS.AddCorridor;
    } else if (lower === 'addexit' || lower === 'exit') op = RULE_OPS.AddExit;
    else if (
        lower === 'selectevent' ||
        lower === 'event' ||
        lower === 'selectevents'
    ) {
        op = RULE_OPS.SelectEvent;
    }
    if (!op) return null;

    const tags = Array.isArray(raw.tags)
        ? raw.tags.map((t) => String(t)).filter(Boolean)
        : raw.tag != null
          ? [String(raw.tag)]
          : [];

    let defaultCount = [1, 1];
    if (op === RULE_OPS.AddRoom) defaultCount = [3, 5];
    if (op === RULE_OPS.AddCorridor) defaultCount = [0, 2];
    if (op === RULE_OPS.SelectEvent) defaultCount = [1, 1];
    if (op === RULE_OPS.AddHub) defaultCount = [1, 1];
    if (op === RULE_OPS.AddExit) defaultCount = [1, 1];

    const count = pairMinMax(
        raw.count != null ? raw.count : raw.n,
        defaultCount[0],
        defaultCount[1]
    );

    const events = Array.isArray(raw.events)
        ? raw.events.map((e) => String(e)).filter(Boolean)
        : raw.event != null
          ? [String(raw.event)]
          : [];

    // Prefer tags defaults per op when designer omits them
    let resolvedTags = tags.slice();
    if (!resolvedTags.length) {
        if (op === RULE_OPS.AddHub) resolvedTags = ['hub'];
        else if (op === RULE_OPS.AddRoom) resolvedTags = ['room'];
        else if (op === RULE_OPS.AddCorridor) resolvedTags = ['corridor'];
        else if (op === RULE_OPS.AddExit) resolvedTags = ['deadend', 'exit'];
    }

    return {
        op,
        tags: resolvedTags,
        count,
        events,
        index: index | 0,
        // Optional: require all tags (AND) vs any (OR). Default AND for growth tags.
        tagMode:
            raw.tagMode === 'any' || raw.tagMatch === 'any' ? 'any' : 'all',
        // Prefer excluding hub when growing rooms (hub already placed by AddHub)
        excludeTags: Array.isArray(raw.excludeTags)
            ? raw.excludeTags.map((t) => String(t))
            : op === RULE_OPS.AddRoom
              ? ['hub']
              : []
    };
}

/**
 * Normalize a full rule program / dungeon profile shell (rules only).
 * @param {object|object[]|null|undefined} raw
 * @returns {object|null}
 */
function normalizeRuleProgram(raw) {
    if (!raw) return null;

    let rulesRaw = null;
    let id = null;
    let seeded = true;
    let meta = {};

    if (Array.isArray(raw)) {
        rulesRaw = raw;
    } else if (typeof raw === 'object') {
        id = raw.id != null ? String(raw.id) : null;
        seeded = raw.seeded !== false;
        rulesRaw = Array.isArray(raw.rules) ? raw.rules : null;
        meta = {
            biome:
                raw.biome != null
                    ? String(raw.biome).trim().toLowerCase() || null
                    : null,
            piecePack:
                raw.piecePack != null
                    ? String(raw.piecePack)
                    : raw.piecePackId != null
                      ? String(raw.piecePackId)
                      : null,
            populationId:
                raw.populationId != null ? String(raw.populationId) : null,
            markersId:
                raw.markersId != null
                    ? String(raw.markersId)
                    : raw.markerRules != null && typeof raw.markerRules === 'string'
                      ? String(raw.markerRules)
                      : null,
            pacingBudgetId:
                raw.pacingBudgetId != null ? String(raw.pacingBudgetId) : null,
            pacingBudget:
                raw.pacingBudget && typeof raw.pacingBudget === 'object'
                    ? raw.pacingBudget
                    : null,
            floor: raw.floor != null ? raw.floor : 0,
            maxAttempts:
                numOrNull(raw.maxAttempts) != null
                    ? Math.max(1, Math.floor(Number(raw.maxAttempts)))
                    : 32,
            maxPieces:
                numOrNull(raw.maxPieces) != null
                    ? Math.max(1, Math.floor(Number(raw.maxPieces)))
                    : 40,
            capOpenExits: raw.capOpenExits !== false,
            connectorTags: Array.isArray(raw.connectorTags)
                ? raw.connectorTags.map((t) => String(t))
                : ['corridor']
        };
    }

    if (!rulesRaw || !rulesRaw.length) {
        // Bare profile with defaults when rules omitted
        if (meta.piecePack) {
            rulesRaw = [
                { op: 'AddHub', tags: ['hub'], count: 1 },
                { op: 'AddRoom', tags: ['room'], count: [2, 4] },
                { op: 'AddExit', count: 1 }
            ];
        } else {
            return null;
        }
    }

    const rules = [];
    for (let i = 0; i < rulesRaw.length; i++) {
        const r = normalizeRule(rulesRaw[i], i);
        if (r) rules.push(r);
    }
    if (!rules.length) return null;

    return {
        id,
        seeded,
        rules,
        ...meta
    };
}

/**
 * Resolve concrete counts for each rule under rng.
 * @param {object} program normalizeRuleProgram result
 * @param {() => number} rng
 * @returns {{ op: string, tags: string[], n: number, events: string[], tagMode: string, excludeTags: string[], index: number }[]}
 */
function materializeRuleCounts(program, rng) {
    const out = [];
    const list = (program && program.rules) || [];
    for (let i = 0; i < list.length; i++) {
        const r = list[i];
        const n = randInt(rng, r.count[0], r.count[1]);
        out.push({
            op: r.op,
            tags: r.tags.slice(),
            n,
            events: r.events.slice(),
            tagMode: r.tagMode,
            excludeTags: (r.excludeTags || []).slice(),
            index: r.index
        });
    }
    return out;
}

/**
 * Whether a piece matches rule tag filter.
 * @param {object} piece
 * @param {string[]} tags
 * @param {string} tagMode 'all'|'any'
 * @param {string[]} excludeTags
 * @returns {boolean}
 */
function pieceMatchesTags(piece, tags, tagMode, excludeTags) {
    const have = (piece && piece.tags) || [];
    const excl = excludeTags || [];
    for (let i = 0; i < excl.length; i++) {
        if (have.indexOf(excl[i]) >= 0) return false;
    }
    const need = tags || [];
    if (!need.length) return true;
    if (tagMode === 'any') {
        for (let i = 0; i < need.length; i++) {
            if (have.indexOf(need[i]) >= 0) return true;
        }
        return false;
    }
    for (let i = 0; i < need.length; i++) {
        if (have.indexOf(need[i]) < 0) return false;
    }
    return true;
}

/**
 * Pieces matching any of several tag groups (e.g. deadend OR exit).
 * When tags list is used with tagMode any, pieceMatchesTags already covers it.
 * Special for AddExit: tags often mean "prefer deadend, else exit".
 * @param {object[]} pieces
 * @param {string[]} tags
 * @param {string} tagMode
 * @param {string[]} excludeTags
 * @returns {object[]}
 */
function filterPiecesForRule(pieces, tags, tagMode, excludeTags) {
    const list = Array.isArray(pieces) ? pieces : [];
    // AddExit default tags are ['deadend','exit'] meaning ANY of those
    const mode =
        tagMode ||
        (tags &&
        tags.length > 1 &&
        tags.indexOf('deadend') >= 0 &&
        tags.indexOf('exit') >= 0
            ? 'any'
            : 'all');
    return list.filter((p) => pieceMatchesTags(p, tags, mode, excludeTags));
}

module.exports = {
    RULE_OPS,
    pairMinMax,
    randInt,
    normalizeRule,
    normalizeRuleProgram,
    materializeRuleCounts,
    pieceMatchesTags,
    filterPiecesForRule
};
