/**
 * Stage 11.1 — Dynamic population tables (Blueprint Phase 4, monsters).
 *
 * Weighted groups + min/max pack limits → concrete spawn defs for SpawnManager.
 * Deterministic under seed. Explicit hunt `spawns` still win at resolve time
 * (fixtures); otherwise populationId / inline population + candidate slots.
 */

'use strict';

const { createSeededRandom } = require('../utils.js');

/** Default HP/atk/exp mults for affix stubs (v1 — stat mult only). */
const DEFAULT_AFFIX_STATS = {
    champion: { hpMult: 2, atkMult: 1.5, expMult: 2 },
    elite: { hpMult: 3, atkMult: 2, expMult: 3 },
    boss: { hpMult: 5, atkMult: 2.5, expMult: 5 },
    rare: { hpMult: 1.5, atkMult: 1.25, expMult: 1.5 }
};

/** Mid-loop group ids that get pack-count limits by default naming. */
const LIMITED_GROUP_HINTS = {
    champion: true,
    elite: true,
    boss: true,
    rare: true
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
 * @param {*} v
 * @returns {number|null}
 */
function intOrNull(v) {
    const n = numOrNull(v);
    if (n == null) return null;
    return Math.floor(n);
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
 * @param {() => number} rng
 * @param {Array<{ weight: number }>} items
 * @returns {object|null}
 */
function pickWeighted(rng, items) {
    if (!items || !items.length) return null;
    let total = 0;
    for (let i = 0; i < items.length; i++) {
        const w = Number(items[i].weight) || 0;
        if (w > 0) total += w;
    }
    if (total <= 0) {
        return items[Math.floor(rng() * items.length)] || null;
    }
    let r = rng() * total;
    for (let i = 0; i < items.length; i++) {
        const w = Number(items[i].weight) || 0;
        if (w <= 0) continue;
        r -= w;
        if (r < 0) return items[i];
    }
    return items[items.length - 1];
}

/**
 * Fisher–Yates shuffle (in place).
 * @param {() => number} rng
 * @param {any[]} arr
 * @returns {any[]}
 */
function shuffleInPlace(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
    }
    return arr;
}

/**
 * @param {string} groupId
 * @param {string[]} affixes
 * @param {string|null|undefined} rarity
 * @returns {string|null}
 */
function inferRarity(groupId, affixes, rarity) {
    if (rarity != null && String(rarity)) return String(rarity).toLowerCase();
    const id = String(groupId || '').toLowerCase();
    if (LIMITED_GROUP_HINTS[id]) return id;
    for (let i = 0; i < (affixes || []).length; i++) {
        const a = String(affixes[i]).toLowerCase();
        if (LIMITED_GROUP_HINTS[a]) return a;
    }
    return null;
}

/**
 * @param {string} id
 * @param {object} raw
 * @returns {object}
 */
function normalizeGroup(id, raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const creatureIds = Array.isArray(r.creatureIds)
        ? r.creatureIds.map((c) => String(c)).filter(Boolean)
        : r.creatureId != null
          ? [String(r.creatureId)]
          : [];
    const affixes = Array.isArray(r.affixes)
        ? r.affixes.map((a) => String(a))
        : [];
    const rarity = inferRarity(id, affixes, r.rarity);
    // If group is named champion/elite/… and affixes empty, stamp that affix.
    if (rarity && affixes.indexOf(rarity) < 0 && LIMITED_GROUP_HINTS[rarity]) {
        affixes.push(rarity);
    }
    return {
        id: String(id),
        weight: Math.max(0, Number(r.weight) || 0),
        creatureIds,
        packSize: pairMinMax(r.packSize, 1, 1),
        affixes,
        rarity,
        respawn: numOrNull(r.respawn)
    };
}

/**
 * Read per-group pack limit from limits object.
 * Supports championPacks, packs.champion, groups.champion.
 * @param {object} limits
 * @param {string} groupId
 * @returns {[number, number]|null}
 */
function groupPackLimit(limits, groupId) {
    if (!limits || typeof limits !== 'object') return null;
    const id = String(groupId);
    const key = `${id}Packs`;
    if (limits[key] != null) return pairMinMax(limits[key], 0, 0);
    if (limits.packs && limits.packs[id] != null) {
        return pairMinMax(limits.packs[id], 0, 0);
    }
    if (limits.groups && limits.groups[id] != null) {
        return pairMinMax(limits.groups[id], 0, 0);
    }
    // Already-normalized populations store mins/maxes under packLimits
    if (limits.packLimits && limits.packLimits[id] != null) {
        return pairMinMax(limits.packLimits[id], 0, 0);
    }
    return null;
}

/**
 * Normalize a population preset (file or inline hunt.population).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizePopulation(raw) {
    if (!raw || typeof raw !== 'object') return null;

    /** @type {Record<string, object>} */
    const groups = Object.create(null);
    if (raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups)) {
        const keys = Object.keys(raw.groups);
        for (let i = 0; i < keys.length; i++) {
            const id = keys[i];
            groups[id] = normalizeGroup(id, raw.groups[id]);
        }
    } else if (Array.isArray(raw.groups)) {
        for (let i = 0; i < raw.groups.length; i++) {
            const g = raw.groups[i];
            if (!g) continue;
            const id = g.id != null ? String(g.id) : `group_${i}`;
            groups[id] = normalizeGroup(id, g);
        }
    }

    const lim = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
    const totalPacks = pairMinMax(
        lim.totalPacks != null ? lim.totalPacks : raw.totalPacks,
        1,
        8
    );

    /** @type {Record<string, [number, number]>} */
    const packLimits = Object.create(null);
    const gids = Object.keys(groups);
    for (let i = 0; i < gids.length; i++) {
        const id = gids[i];
        const pl = groupPackLimit(lim, id);
        if (pl) packLimits[id] = pl;
    }

    const affixStats = Object.assign(
        {},
        DEFAULT_AFFIX_STATS,
        raw.affixStats && typeof raw.affixStats === 'object' ? raw.affixStats : {},
        lim.affixStats && typeof lim.affixStats === 'object' ? lim.affixStats : {}
    );

    return {
        id: raw.id != null ? String(raw.id) : null,
        biome: raw.biome != null ? String(raw.biome).trim().toLowerCase() || null : null,
        groups,
        limits: {
            totalPacks,
            packLimits
        },
        defaultRespawn:
            raw.defaultRespawn != null
                ? Math.max(0, Number(raw.defaultRespawn) || 0)
                : raw.respawn != null
                  ? Math.max(0, Number(raw.respawn) || 0)
                  : 0,
        density: numOrNull(raw.density) != null ? Number(raw.density) : 1,
        affixStats
    };
}

/**
 * Normalize slot-like rows to {x,y,z}[].
 * @param {object[]} slots
 * @param {number|string|null|undefined} defaultZ
 * @returns {{ x: number, y: number, z: number|string }[]}
 */
function normalizeSlots(slots, defaultZ) {
    const out = [];
    const list = Array.isArray(slots) ? slots : [];
    const z0 = defaultZ != null ? defaultZ : 0;
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || s.x == null || s.y == null) continue;
        const x = Math.round(Number(s.x));
        const y = Math.round(Number(s.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const z = s.z != null ? s.z : z0;
        out.push({ x, y, z });
    }
    return out;
}

/**
 * Sample evenly spaced points along a waypoint polyline.
 * @param {object[]} waypoints
 * @param {number} count
 * @param {number|string|null|undefined} defaultZ
 * @returns {{ x: number, y: number, z: number|string }[]}
 */
function sampleSlotsAlongWaypoints(waypoints, count, defaultZ) {
    const wps = Array.isArray(waypoints) ? waypoints : [];
    const n = Math.max(0, Math.floor(count));
    if (n <= 0 || wps.length === 0) return [];
    if (wps.length === 1) {
        const p = wps[0];
        const slot = {
            x: Math.round(Number(p.x)),
            y: Math.round(Number(p.y)),
            z: p.z != null ? p.z : defaultZ != null ? defaultZ : 0
        };
        const out = [];
        for (let i = 0; i < n; i++) out.push(Object.assign({}, slot));
        return out;
    }

    // Segment lengths
    const segLen = [];
    let total = 0;
    for (let i = 0; i < wps.length - 1; i++) {
        const a = wps[i];
        const b = wps[i + 1];
        const dx = Number(b.x) - Number(a.x);
        const dy = Number(b.y) - Number(a.y);
        const len = Math.sqrt(dx * dx + dy * dy) || 0;
        segLen.push(len);
        total += len;
    }
    if (total <= 0) {
        return normalizeSlots(wps.slice(0, n), defaultZ);
    }

    const out = [];
    for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        let dist = t * total;
        let si = 0;
        while (si < segLen.length - 1 && dist > segLen[si]) {
            dist -= segLen[si];
            si++;
        }
        const a = wps[si];
        const b = wps[Math.min(si + 1, wps.length - 1)];
        const len = segLen[si] || 1;
        const u = dist / len;
        const x = Number(a.x) + (Number(b.x) - Number(a.x)) * u;
        const y = Number(a.y) + (Number(b.y) - Number(a.y)) * u;
        const z =
            a.z != null
                ? a.z
                : b.z != null
                  ? b.z
                  : defaultZ != null
                    ? defaultZ
                    : 0;
        out.push({ x: Math.round(x), y: Math.round(y), z });
    }
    return out;
}

/**
 * Resolve rarity / affixes / hp·atk·exp mults for a spawn-like row
 * (population group or arena wave entry). Shared so dungeon packs and
 * sequential waves apply the same DEFAULT_AFFIX_STATS table.
 *
 * Explicit `hpMult` / `atkMult` / `expMult` on the row override table values.
 *
 * @param {{ rarity?: *, affixes?: *, hpMult?: *, atkMult?: *, expMult?: * }} row
 * @param {object} [affixStats] defaults to DEFAULT_AFFIX_STATS
 * @returns {{
 *   rarity: string|null,
 *   affixes: string[],
 *   hpMult: number,
 *   atkMult: number,
 *   expMult: number
 * }}
 */
function resolveSpawnAffixFields(row, affixStats) {
    const r = row && typeof row === 'object' ? row : {};
    const stats =
        affixStats && typeof affixStats === 'object'
            ? affixStats
            : DEFAULT_AFFIX_STATS;

    let affixes = Array.isArray(r.affixes)
        ? r.affixes.map((a) => String(a)).filter(Boolean)
        : [];
    let rarity =
        r.rarity != null && String(r.rarity)
            ? String(r.rarity).toLowerCase()
            : null;

    if (!rarity) {
        for (let i = 0; i < affixes.length; i++) {
            const a = String(affixes[i]).toLowerCase();
            if (LIMITED_GROUP_HINTS[a] || stats[a]) {
                rarity = a;
                break;
            }
        }
    }
    if (
        rarity &&
        affixes.map((a) => String(a).toLowerCase()).indexOf(rarity) < 0
    ) {
        affixes = affixes.concat([rarity]);
    }

    let hpMult = 1;
    let atkMult = 1;
    let expMult = 1;
    const keys = [];
    if (rarity) keys.push(rarity);
    for (let i = 0; i < affixes.length; i++) {
        keys.push(String(affixes[i]).toLowerCase());
    }
    const seen = Object.create(null);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (!k || seen[k]) continue;
        seen[k] = true;
        const m = stats[k];
        if (!m || typeof m !== 'object') continue;
        if (m.hpMult != null) hpMult *= Number(m.hpMult) || 1;
        if (m.atkMult != null) atkMult *= Number(m.atkMult) || 1;
        if (m.expMult != null) expMult *= Number(m.expMult) || 1;
    }

    // Explicit overrides win (author or population post-process)
    if (r.hpMult != null && Number.isFinite(Number(r.hpMult))) {
        hpMult = Number(r.hpMult);
    }
    if (r.atkMult != null && Number.isFinite(Number(r.atkMult))) {
        atkMult = Number(r.atkMult);
    }
    if (r.expMult != null && Number.isFinite(Number(r.expMult))) {
        expMult = Number(r.expMult);
    }

    return { rarity, affixes, hpMult, atkMult, expMult };
}

/**
 * Resolve affix → stat mults (group rarity / affix list).
 * @param {object} population normalized
 * @param {object} group normalized group
 * @returns {{ hpMult: number, atkMult: number, expMult: number }}
 */
function resolveAffixMults(population, group) {
    const fields = resolveSpawnAffixFields(
        group,
        (population && population.affixStats) || DEFAULT_AFFIX_STATS
    );
    return {
        hpMult: fields.hpMult,
        atkMult: fields.atkMult,
        expMult: fields.expMult
    };
}

/**
 * Plan how many packs of each group (respect min/max + total + density).
 * @param {object} population normalized
 * @param {() => number} rng
 * @param {number} density
 * @param {number} maxPacks hard cap (from available slots)
 * @returns {{ groupId: string, count: number }[]}
 */
function planGroupCounts(population, rng, density, maxPacks) {
    const groups = population.groups;
    const ids = Object.keys(groups);
    const usable = ids.filter(
        (id) =>
            groups[id].creatureIds.length > 0 &&
            (groups[id].weight > 0 ||
                (population.limits.packLimits[id] &&
                    population.limits.packLimits[id][0] > 0))
    );

    const [tMin, tMax] = population.limits.totalPacks;
    let target = randInt(rng, tMin, tMax);
    const d = density > 0 ? density : 1;
    target = Math.max(0, Math.round(target * d));
    if (maxPacks >= 0) target = Math.min(target, maxPacks);

    /** @type {Record<string, number>} */
    const minQ = Object.create(null);
    /** @type {Record<string, number>} */
    const maxQ = Object.create(null);
    for (let i = 0; i < usable.length; i++) {
        const id = usable[i];
        const lim = population.limits.packLimits[id];
        if (lim) {
            minQ[id] = Math.max(0, lim[0]);
            maxQ[id] = Math.max(minQ[id], lim[1]);
        } else {
            minQ[id] = 0;
            maxQ[id] = Number.POSITIVE_INFINITY;
        }
    }

    let minSum = 0;
    for (let i = 0; i < usable.length; i++) {
        minSum += minQ[usable[i]] || 0;
    }
    if (minSum > target) {
        // Prefer honoring mins (mid-loop champions) over the rolled total.
        target = minSum;
        if (maxPacks >= 0) target = Math.min(target, maxPacks);
    }

    // If still over maxPacks after cap, scale mins down proportionally.
    if (maxPacks >= 0 && minSum > maxPacks) {
        let left = maxPacks;
        for (let i = 0; i < usable.length; i++) {
            const id = usable[i];
            if (i === usable.length - 1) {
                minQ[id] = Math.max(0, left);
            } else {
                const share = Math.floor(
                    ((minQ[id] || 0) / minSum) * maxPacks
                );
                minQ[id] = share;
                left -= share;
            }
        }
        minSum = maxPacks;
        target = maxPacks;
    }

    /** @type {Record<string, number>} */
    const counts = Object.create(null);
    for (let i = 0; i < usable.length; i++) {
        counts[usable[i]] = minQ[usable[i]] || 0;
    }
    let remaining = Math.max(0, target - minSum);

    while (remaining > 0) {
        const candidates = [];
        for (let i = 0; i < usable.length; i++) {
            const id = usable[i];
            const g = groups[id];
            const c = counts[id] || 0;
            const max = maxQ[id];
            if (c >= max) continue;
            if (g.weight <= 0 && c >= (minQ[id] || 0)) continue;
            candidates.push(g);
        }
        if (!candidates.length) break;
        const pick = pickWeighted(rng, candidates);
        if (!pick) break;
        counts[pick.id] = (counts[pick.id] || 0) + 1;
        remaining -= 1;
    }

    const plan = [];
    for (let i = 0; i < usable.length; i++) {
        const id = usable[i];
        const c = counts[id] || 0;
        if (c > 0) plan.push({ groupId: id, count: c });
    }
    return plan;
}

/**
 * Core resolver: population + seed + slots → spawn defs.
 *
 * @param {{
 *   population: object,
 *   slots?: object[],
 *   waypoints?: object[],
 *   seed?: number,
 *   density?: number,
 *   defaultZ?: number|string,
 *   defaultRespawn?: number|null
 * }} opts
 * @returns {{
 *   spawns: object[],
 *   meta: object
 * }}
 */
function resolvePopulation(opts) {
    const o = opts || {};
    const population = normalizePopulation(o.population);
    if (!population) {
        return {
            spawns: [],
            meta: {
                populationId: null,
                seed: (o.seed >>> 0) || 1,
                packCount: 0,
                creatureCount: 0,
                groupCounts: {},
                slotCandidates: [],
                slotsUsed: 0,
                density: 1,
                reason: 'missing_population'
            }
        };
    }

    const seed = o.seed != null ? o.seed >>> 0 || 1 : 1;
    const rng = createSeededRandom(seed);
    const density =
        o.density != null && Number(o.density) > 0
            ? Number(o.density)
            : population.density > 0
              ? population.density
              : 1;
    const defaultZ = o.defaultZ != null ? o.defaultZ : 0;
    const defaultRespawn =
        o.defaultRespawn != null
            ? Math.max(0, Number(o.defaultRespawn) || 0)
            : population.defaultRespawn;

    let slotCandidates = normalizeSlots(o.slots, defaultZ);
    // Estimate max packs for waypoint sampling (upper total * max pack size).
    const [, tMax] = population.limits.totalPacks;
    let maxPackSize = 1;
    const gids = Object.keys(population.groups);
    for (let i = 0; i < gids.length; i++) {
        const ps = population.groups[gids[i]].packSize;
        if (ps[1] > maxPackSize) maxPackSize = ps[1];
    }
    const slotBudget = Math.max(
        1,
        Math.ceil(tMax * density) * maxPackSize + maxPackSize
    );

    if (!slotCandidates.length && Array.isArray(o.waypoints) && o.waypoints.length) {
        slotCandidates = sampleSlotsAlongWaypoints(
            o.waypoints,
            slotBudget,
            defaultZ
        );
    }

    // Unique slots (same tile only once) while preserving order, then shuffle.
    const seenKey = Object.create(null);
    const uniqueSlots = [];
    for (let i = 0; i < slotCandidates.length; i++) {
        const s = slotCandidates[i];
        const k = `${s.x},${s.y},${s.z}`;
        if (seenKey[k]) continue;
        seenKey[k] = true;
        uniqueSlots.push(s);
    }
    const slotPool = shuffleInPlace(rng, uniqueSlots.slice());

    const maxPacks = slotPool.length > 0 ? slotPool.length : 0;
    const groupPlan = planGroupCounts(population, rng, density, maxPacks);

    /** @type {object[]} ordered packs */
    const packs = [];
    for (let i = 0; i < groupPlan.length; i++) {
        const gp = groupPlan[i];
        for (let j = 0; j < gp.count; j++) {
            packs.push({ groupId: gp.groupId });
        }
    }
    shuffleInPlace(rng, packs);

    /** @type {Record<string, number>} */
    const groupCounts = Object.create(null);
    /** @type {object[]} */
    const spawns = [];
    let slotIdx = 0;

    for (let p = 0; p < packs.length; p++) {
        const group = population.groups[packs[p].groupId];
        if (!group || !group.creatureIds.length) continue;
        if (slotIdx >= slotPool.length) break;

        let packSize = randInt(rng, group.packSize[0], group.packSize[1]);
        const remainingSlots = slotPool.length - slotIdx;
        if (packSize > remainingSlots) packSize = remainingSlots;
        if (packSize <= 0) break;

        const creatureId =
            group.creatureIds[
                Math.floor(rng() * group.creatureIds.length)
            ] || group.creatureIds[0];
        const mults = resolveAffixMults(population, group);
        const respawn =
            group.respawn != null ? group.respawn : defaultRespawn;

        for (let m = 0; m < packSize; m++) {
            const slot = slotPool[slotIdx++];
            const def = {
                creatureId: String(creatureId),
                x: slot.x,
                y: slot.y,
                z: slot.z,
                respawn,
                groupId: group.id,
                id: `pop_${seed}_${spawns.length}_${slot.x}_${slot.y}`
            };
            if (group.rarity) def.rarity = group.rarity;
            if (group.affixes && group.affixes.length) {
                def.affixes = group.affixes.slice();
            }
            if (mults.hpMult !== 1) def.hpMult = mults.hpMult;
            if (mults.atkMult !== 1) def.atkMult = mults.atkMult;
            if (mults.expMult !== 1) def.expMult = mults.expMult;
            spawns.push(def);
        }
        groupCounts[group.id] = (groupCounts[group.id] || 0) + 1;
    }

    return {
        spawns,
        meta: {
            populationId: population.id,
            seed,
            packCount: Object.keys(groupCounts).reduce(
                (s, k) => s + groupCounts[k],
                0
            ),
            creatureCount: spawns.length,
            groupCounts,
            slotCandidates: uniqueSlots.map((s) => ({
                x: s.x,
                y: s.y,
                z: s.z
            })),
            slotsUsed: spawns.length,
            density,
            reason: 'ok'
        }
    };
}

/**
 * Whether a hunt object carries a population table reference.
 * @param {object|null|undefined} hunt
 * @returns {boolean}
 */
function huntHasPopulation(hunt) {
    if (!hunt || typeof hunt !== 'object') return false;
    if (hunt.populationId) return true;
    if (hunt.population && typeof hunt.population === 'object') return true;
    // Stage 11.10: multi-biome per-floor population map
    if (hunt.populationByFloor && typeof hunt.populationByFloor === 'object') {
        if (Object.keys(hunt.populationByFloor).length) return true;
    }
    if (
        hunt.layoutMeta &&
        Array.isArray(hunt.layoutMeta.floorMeta) &&
        hunt.layoutMeta.floorMeta.some((f) => f && f.populationId)
    ) {
        return true;
    }
    return false;
}

/**
 * Detect authored fixture spawns that must win over population.
 * @param {object} hunt
 * @returns {boolean}
 */
function huntHasExplicitSpawns(hunt) {
    if (!hunt || typeof hunt !== 'object') return false;
    if (hunt._hadAuthoredSpawns === true) return true;
    if (hunt._hadAuthoredSpawns === false) return false;
    // After expand: spawnSourceSpec / populationMeta imply spawns are not fixtures
    if (hunt.spawnSourceSpec || hunt.populationMeta) return false;
    if (hunt.spawnSource) return false;
    return Array.isArray(hunt.spawns) && hunt.spawns.length > 0;
}

/**
 * Collect candidate slots for a hunt (slots field, source rows, prior meta, waypoints).
 *
 * @param {object} hunt
 * @param {{
 *   loadFloorSpawns?: Function,
 *   resolveSpawnSource?: Function
 * }} [opts]
 * @returns {{ slots: object[], waypoints: object[]|null }}
 */
function collectPopulationSlots(hunt, opts) {
    const o = opts || {};
    const defaultZ = hunt.floor != null ? hunt.floor : 0;

    if (Array.isArray(hunt.populationSlots) && hunt.populationSlots.length) {
        return {
            slots: normalizeSlots(hunt.populationSlots, defaultZ),
            waypoints: null
        };
    }

    if (
        hunt.populationMeta &&
        Array.isArray(hunt.populationMeta.slotCandidates) &&
        hunt.populationMeta.slotCandidates.length
    ) {
        return {
            slots: normalizeSlots(hunt.populationMeta.slotCandidates, defaultZ),
            waypoints: null
        };
    }

    if (hunt.spawnSourceSpec && typeof o.resolveSpawnSource === 'function') {
        const floors =
            Array.isArray(hunt.floors) && hunt.floors.length
                ? hunt.floors
                : hunt.floor != null
                  ? [hunt.floor]
                  : [];
        const resolved = o.resolveSpawnSource(hunt.spawnSourceSpec, {
            floors,
            floor: hunt.floor,
            loadFloorSpawns: o.loadFloorSpawns
        });
        return {
            slots: normalizeSlots(resolved.spawns || [], defaultZ),
            waypoints: null
        };
    }

    // Spawns present but not yet population-resolved (e.g. just expanded spawnSource)
    if (
        Array.isArray(hunt.spawns) &&
        hunt.spawns.length &&
        !hunt.populationMeta
    ) {
        return {
            slots: normalizeSlots(hunt.spawns, defaultZ),
            waypoints: null
        };
    }

    if (Array.isArray(hunt.waypoints) && hunt.waypoints.length) {
        return { slots: [], waypoints: hunt.waypoints };
    }

    return { slots: [], waypoints: null };
}

/**
 * Expand hunt.populationId / hunt.population → hunt.spawns defs.
 * Skips when explicit fixture spawns are present.
 *
 * @param {object} hunt
 * @param {{
 *   seed?: number,
 *   populationDensity?: number,
 *   loadPopulation?: (id: string) => object,
 *   loadFloorSpawns?: Function,
 *   resolveSpawnSource?: Function
 * }} [opts]
 * @returns {object}
 */
/**
 * Stage 11.10: resolve population per floor when populationByFloor / floorMeta
 * carries distinct population ids (multi-biome).
 *
 * @param {object} hunt
 * @param {object} o opts
 * @returns {object|null} expanded hunt or null if single-table path should run
 */
function resolveMultiFloorPopulations(hunt, o) {
    /** @type {Record<string, string>|null} */
    let byZ = null;
    if (hunt.populationByFloor && typeof hunt.populationByFloor === 'object') {
        byZ = hunt.populationByFloor;
    } else if (
        hunt.layoutMeta &&
        Array.isArray(hunt.layoutMeta.floorMeta) &&
        hunt.layoutMeta.floorMeta.length
    ) {
        byZ = Object.create(null);
        let distinct = 0;
        let first = null;
        for (let i = 0; i < hunt.layoutMeta.floorMeta.length; i++) {
            const fm = hunt.layoutMeta.floorMeta[i];
            if (!fm || !fm.populationId) continue;
            const pid = String(fm.populationId);
            byZ[String(fm.z)] = pid;
            if (first == null) first = pid;
            else if (pid !== first) distinct += 1;
        }
        if (!first || (distinct === 0 && !hunt.multiBiomePopulation)) {
            // Single population across floors — fall through to default path
            if (first && !hunt.populationId) {
                // still useful as default id; leave byZ null
            }
            byZ = null;
        }
    }
    if (!byZ || typeof o.loadPopulation !== 'function') return null;

    const ids = Object.keys(byZ);
    if (ids.length < 1) return null;
    // Need at least two distinct ids OR explicit multiBiome flag
    const unique = new Set(ids.map((z) => byZ[z]));
    if (unique.size < 2 && !hunt.multiBiomePopulation) return null;

    const { slots, waypoints } = collectPopulationSlots(hunt, o);
    const seed = o.seed != null ? o.seed : hunt.seed != null ? hunt.seed : 1;
    const density =
        o.populationDensity != null
            ? o.populationDensity
            : hunt.populationDensity != null
              ? hunt.populationDensity
              : null;
    const defaultRespawn =
        hunt.spawnSourceSpec && hunt.spawnSourceSpec.respawn != null
            ? hunt.spawnSourceSpec.respawn
            : undefined;

    /** @type {object[]} */
    const allSpawns = [];
    /** @type {object[]} */
    const floorMetas = [];
    const defaultZ = hunt.floor != null ? hunt.floor : 0;

    // Group slots by z
    /** @type {Record<string, object[]>} */
    const slotsByZ = Object.create(null);
    for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const zKey = String(s.z != null ? s.z : defaultZ);
        if (!slotsByZ[zKey]) slotsByZ[zKey] = [];
        slotsByZ[zKey].push(s);
    }

    // Ensure every populationByFloor z is visited even without slots
    for (let i = 0; i < ids.length; i++) {
        if (!slotsByZ[ids[i]]) slotsByZ[ids[i]] = [];
    }

    const zKeys = Object.keys(slotsByZ);
    for (let i = 0; i < zKeys.length; i++) {
        const zKey = zKeys[i];
        const popId = byZ[zKey] || hunt.populationId;
        if (!popId) continue;
        let populationRaw = null;
        try {
            populationRaw = o.loadPopulation(String(popId));
        } catch (_e) {
            populationRaw = null;
        }
        if (!populationRaw) continue;

        // Floor-local seed so streams stay independent
        const floorSeed =
            ((seed >>> 0) + (Number(zKey) || 0) * 0x9e3779b9 + 0x504f50) >>>
                0 || 1;
        const floorSlots = slotsByZ[zKey] || [];
        // Waypoints on this floor only (optional sampling)
        let floorWps = null;
        if ((!floorSlots.length || floorSlots.length < 2) && waypoints) {
            floorWps = (waypoints || []).filter(
                (w) => String(w.z != null ? w.z : defaultZ) === zKey
            );
        } else if (
            !floorSlots.length &&
            Array.isArray(hunt.waypoints)
        ) {
            floorWps = hunt.waypoints.filter(
                (w) => String(w.z != null ? w.z : defaultZ) === zKey
            );
        }

        const result = resolvePopulation({
            population: populationRaw,
            slots: floorSlots,
            waypoints: floorWps,
            seed: floorSeed,
            density: density != null ? density : undefined,
            defaultZ: Number.isFinite(Number(zKey)) ? Number(zKey) : zKey,
            defaultRespawn
        });
        for (let s = 0; s < result.spawns.length; s++) {
            allSpawns.push(result.spawns[s]);
        }
        floorMetas.push({
            z: zKey,
            populationId: result.meta.populationId || popId,
            packCount: result.meta.packCount,
            spawnCount: result.spawns.length
        });
    }

    const out = Object.assign({}, hunt);
    out.spawns = allSpawns;
    out.populationMeta = {
        populationId: hunt.populationId || (byZ[ids[0]] || null),
        seed: seed >>> 0 || 1,
        multiBiome: true,
        floors: floorMetas,
        packCount: floorMetas.reduce(
            (n, f) => n + (f.packCount || 0),
            0
        ),
        spawnCount: allSpawns.length
    };
    out.populationByFloor = byZ;
    out._hadAuthoredSpawns = false;
    delete out.populationSkipped;
    return out;
}

function resolveHuntPopulationDefs(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;

    const o = opts || {};

    // Stage 11.5: fixed layout already filled cutout spawns under seed
    if (hunt.layoutMeta && hunt.layoutMeta.spawnsFilled === true) {
        const out = Object.assign({}, hunt);
        out.populationSkipped = 'layout_filled';
        return out;
    }

    if (huntHasExplicitSpawns(hunt)) {
        const out = Object.assign({}, hunt);
        out.populationSkipped = 'explicit_spawns';
        out._hadAuthoredSpawns = true;
        return out;
    }

    // Stage 11.10: per-floor populations for multi-biome
    const multi = resolveMultiFloorPopulations(hunt, o);
    if (multi) return multi;

    if (!huntHasPopulation(hunt)) return hunt;

    let populationRaw = hunt.population && typeof hunt.population === 'object'
        ? hunt.population
        : null;
    if (!populationRaw && hunt.populationId && typeof o.loadPopulation === 'function') {
        populationRaw = o.loadPopulation(String(hunt.populationId));
    }
    // floorMeta may supply a single shared populationId
    if (
        !populationRaw &&
        hunt.layoutMeta &&
        Array.isArray(hunt.layoutMeta.floorMeta) &&
        typeof o.loadPopulation === 'function'
    ) {
        for (let i = 0; i < hunt.layoutMeta.floorMeta.length; i++) {
            const fm = hunt.layoutMeta.floorMeta[i];
            if (fm && fm.populationId) {
                try {
                    populationRaw = o.loadPopulation(String(fm.populationId));
                } catch (_e) {
                    populationRaw = null;
                }
                if (populationRaw) break;
            }
        }
    }
    if (!populationRaw) {
        const out = Object.assign({}, hunt);
        out.populationSkipped = 'missing_table';
        out.spawns = Array.isArray(out.spawns) ? out.spawns : [];
        return out;
    }

    const { slots, waypoints } = collectPopulationSlots(hunt, o);
    const seed = o.seed != null ? o.seed : hunt.seed != null ? hunt.seed : 1;
    const density =
        o.populationDensity != null
            ? o.populationDensity
            : hunt.populationDensity != null
              ? hunt.populationDensity
              : null;

    const result = resolvePopulation({
        population: populationRaw,
        slots,
        waypoints: waypoints || hunt.waypoints,
        seed,
        density: density != null ? density : undefined,
        defaultZ: hunt.floor,
        defaultRespawn:
            hunt.spawnSourceSpec && hunt.spawnSourceSpec.respawn != null
                ? hunt.spawnSourceSpec.respawn
                : undefined
    });

    const out = Object.assign({}, hunt);
    out.spawns = result.spawns;
    out.populationMeta = result.meta;
    if (!out.populationId && result.meta.populationId) {
        out.populationId = result.meta.populationId;
    }
    out._hadAuthoredSpawns = false;
    delete out.populationSkipped;
    return out;
}

module.exports = {
    DEFAULT_AFFIX_STATS,
    resolveSpawnAffixFields,
    resolveAffixMults,
    normalizePopulation,
    normalizeSlots,
    sampleSlotsAlongWaypoints,
    resolvePopulation,
    resolveHuntPopulationDefs,
    huntHasPopulation,
    huntHasExplicitSpawns,
    collectPopulationSlots,
    planGroupCounts,
    pairMinMax,
    randInt,
    pickWeighted,
    shuffleInPlace
};
