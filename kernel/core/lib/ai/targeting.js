/**
 * Target selection helpers for hunt AI (Stage 5).
 * Pure-ish: reads entity tiles / alive flags; no DOM.
 *
 * Etapa 4: queryWithinRange / findNearestInRange prefer SpatialIndex when
 * provided so engage/aggro scans stay O(local chunks), not O(full list).
 */

const { tileDistance } = require('../movement.js');
const { canSeeCreature } = require('../combat/conditions.js');

/**
 * Living combatants from a list.
 * @param {object[]} list
 * @returns {object[]}
 */
function living(list) {
    if (!list || !list.length) return [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (e && e.alive !== false && e.hp && e.hp.current > 0) out.push(e);
    }
    return out;
}

/**
 * True when entity looks like a living combatant.
 * @param {object|null|undefined} e
 * @returns {boolean}
 */
function isLivingCombatant(e) {
    if (!e || e.alive === false) return false;
    if (e.hp && e.hp.current <= 0) return false;
    return true;
}

/**
 * Entities within Chebyshev range of origin (same floor).
 * Linear scan over the provided candidate list (no spatial index).
 * @param {object} origin entity with tile
 * @param {object[]} candidates
 * @param {number} range
 * @returns {object[]}
 */
function entitiesWithinRange(origin, candidates, range) {
    if (!origin || !origin.tile || !candidates) return [];
    const r = range != null ? range : 7;
    const out = [];
    for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (!e || !e.tile || e.alive === false) continue;
        if (e.hp && e.hp.current <= 0) continue;
        if (String(e.tile.z) !== String(origin.tile.z)) continue;
        if (tileDistance(origin.tile, e.tile) <= r) out.push(e);
    }
    return out;
}

/**
 * Unified AOI query: living entities within Chebyshev of origin.
 *
 * Preference order:
 *   1. opts.index (SpatialIndex) → chunk gather + exact refine
 *   2. opts.candidates → linear entitiesWithinRange
 *   3. empty
 *
 * Deterministic id order when using SpatialIndex.
 *
 * @param {object} origin entity with tile
 * @param {number} range Chebyshev radius
 * @param {{
 *   index?: { queryAround?: Function, queryChebyshev?: Function },
 *   candidates?: object[],
 *   filter?: (e: object) => boolean,
 *   includeOrigin?: boolean,
 *   excludeSelf?: boolean
 * }} [opts]
 * @returns {object[]}
 */
function queryWithinRange(origin, range, opts) {
    if (!origin || !origin.tile) return [];
    const o = opts || {};
    const r = range != null ? Number(range) : 7;
    if (!Number.isFinite(r) || r < 0) return [];

    const excludeSelf = o.excludeSelf !== false;
    const selfId = origin.id;

    /** @type {(e: object) => boolean} */
    const wrapFilter = (e) => {
        if (!e) return false;
        if (excludeSelf && selfId != null && e.id === selfId) return false;
        if (o.filter && !o.filter(e)) return false;
        return true;
    };

    const idx = o.index;
    if (idx && typeof idx.queryAround === 'function') {
        return idx.queryAround(origin, r, {
            livingOnly: true,
            includeOrigin: o.includeOrigin === true,
            filter: wrapFilter
        });
    }
    if (idx && typeof idx.queryChebyshev === 'function') {
        return idx.queryChebyshev(
            origin.tile.x,
            origin.tile.y,
            origin.tile.z,
            r,
            {
                livingOnly: true,
                includeOrigin: o.includeOrigin === true,
                filter: wrapFilter
            }
        );
    }

    const list = entitiesWithinRange(origin, o.candidates || [], r);
    if (!o.filter && !excludeSelf) return list;
    const out = [];
    for (let i = 0; i < list.length; i++) {
        if (wrapFilter(list[i])) out.push(list[i]);
    }
    return out;
}

/**
 * Closest living candidate (Chebyshev). Optional filter.
 * @param {object} origin
 * @param {object[]} candidates
 * @param {(e: object) => boolean} [filter]
 * @returns {object|null}
 */
function findNearest(origin, candidates, filter) {
    if (!origin || !origin.tile) return null;
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (!e || !e.tile || e.alive === false) continue;
        if (e.hp && e.hp.current <= 0) continue;
        if (filter && !filter(e)) continue;
        if (String(e.tile.z) !== String(origin.tile.z)) continue;
        const d = tileDistance(origin.tile, e.tile);
        if (d < bestD) {
            bestD = d;
            best = e;
        }
    }
    return best;
}

/**
 * Nearest living entity via unified AOI (index preferred).
 * @param {object} origin
 * @param {number} range
 * @param {{
 *   index?: object,
 *   candidates?: object[],
 *   filter?: (e: object) => boolean
 * }} [opts]
 * @returns {object|null}
 */
function findNearestInRange(origin, range, opts) {
    const near = queryWithinRange(origin, range, opts);
    return findNearest(origin, near, opts && opts.filter);
}

/**
 * Resolve target by id from a registry map or list.
 * @param {number|string|null} id
 * @param {Map|object[]|Record<string, object>} registry
 * @returns {object|null}
 */
function resolveById(id, registry) {
    if (id == null || id === '') return null;
    if (!registry) return null;
    if (typeof registry.get === 'function') {
        return registry.get(id) || registry.get(Number(id)) || null;
    }
    if (Array.isArray(registry)) {
        for (let i = 0; i < registry.length; i++) {
            if (registry[i] && registry[i].id === id) return registry[i];
        }
        return null;
    }
    return registry[id] || registry[String(id)] || null;
}

/**
 * Whether target is still a valid living enemy on the same floor.
 * @param {object} self
 * @param {object|null} target
 * @returns {boolean}
 */
function isValidTarget(self, target) {
    if (!self || !target) return false;
    if (target.alive === false) return false;
    if (target.hp && target.hp.current <= 0) return false;
    if (!self.tile || !target.tile) return false;
    if (String(self.tile.z) !== String(target.tile.z)) return false;
    // Invisible targets: only observers that can see invis keep them (legacy canSeeCreature).
    // Most monsters with immunities.invisible can see; players typically cannot.
    if (!canSeeCreature(self, target)) return false;
    return true;
}

/**
 * Chebyshev distance or Infinity.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function distBetween(a, b) {
    if (!a || !b || !a.tile || !b.tile) return Infinity;
    if (String(a.tile.z) !== String(b.tile.z)) return Infinity;
    return tileDistance(a.tile, b.tile);
}

/**
 * Collect all living party members from simulator parties.
 * @param {{ parties?: { members?: object[] }[] }} sim
 * @returns {object[]}
 */
function allPartyMembers(sim) {
    const out = [];
    if (!sim || !sim.parties) return out;
    for (let i = 0; i < sim.parties.length; i++) {
        const p = sim.parties[i];
        if (!p || !p.enabled || !p.members) continue;
        for (let j = 0; j < p.members.length; j++) {
            out.push(p.members[j]);
        }
    }
    return out;
}

module.exports = {
    living,
    isLivingCombatant,
    entitiesWithinRange,
    queryWithinRange,
    findNearest,
    findNearestInRange,
    resolveById,
    isValidTarget,
    distBetween,
    allPartyMembers
};
