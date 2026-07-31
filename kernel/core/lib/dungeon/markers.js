/**
 * Stage 11.2 — Gizmo / marker props (Blueprint Phase 4 gizmos + Phase 1 micro-loop).
 *
 * Marker sockets (letter A/B/…) + pool rules (min/max spawn, object ids, effect)
 * resolve to concrete prop defs under seed. Explicit hunt `props` win (fixtures).
 * Sim interaction is thin: break / loot / heal → telemetry `prop` events.
 */

'use strict';

const { createSeededRandom } = require('../utils.js');

/** Salt so marker RNG is seed-stable and independent of population packs. */
const MARKER_SEED_SALT = 0x4d4b5250; // "MKRP"

/** Known interact effects (v1). */
const PROP_EFFECTS = {
    break: true,
    loot: true,
    heal: true,
    well: true
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
 * Normalize one marker-letter pool.
 * @param {string} markerId
 * @param {object} raw
 * @returns {object}
 */
function normalizePool(markerId, raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const objectIds = Array.isArray(r.objectIds)
        ? r.objectIds.map((c) => String(c)).filter(Boolean)
        : r.objectId != null
          ? [String(r.objectId)]
          : [];
    let effect = r.effect != null ? String(r.effect).toLowerCase() : 'break';
    if (!PROP_EFFECTS[effect]) effect = 'break';
    // "well" is a heal variant for mid-loop tagging
    if (effect === 'well') {
        /* keep */
    }
    const lootValue = pairMinMax(
        r.lootValue != null ? r.lootValue : r.loot,
        0,
        0
    );
    const healAmount = pairMinMax(
        r.healAmount != null ? r.healAmount : r.heal,
        effect === 'heal' || effect === 'well' ? 20 : 0,
        effect === 'heal' || effect === 'well' ? 20 : 0
    );
    return {
        id: String(markerId),
        objectIds: objectIds.length ? objectIds : ['barrel'],
        spawnCount: pairMinMax(r.spawnCount, 0, 0),
        effect,
        lootValue,
        healAmount,
        blocking: r.blocking === true,
        weight: Math.max(0, Number(r.weight) || 1),
        pacingTag:
            r.pacingTag != null
                ? String(r.pacingTag)
                : effect === 'well'
                  ? 'well'
                  : effect === 'heal'
                    ? 'heal'
                    : effect
    };
}

/**
 * Normalize a marker rules preset (file or inline hunt.markers / markerRules).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeMarkerRules(raw) {
    if (!raw || typeof raw !== 'object') return null;

    /** @type {Record<string, object>} */
    const pools = Object.create(null);

    const src =
        raw.pools && typeof raw.pools === 'object' && !Array.isArray(raw.pools)
            ? raw.pools
            : raw.rules && typeof raw.rules === 'object' && !Array.isArray(raw.rules)
              ? raw.rules
              : null;

    if (src) {
        const keys = Object.keys(src);
        for (let i = 0; i < keys.length; i++) {
            const id = keys[i];
            pools[String(id)] = normalizePool(id, src[id]);
        }
    } else if (Array.isArray(raw.pools)) {
        for (let i = 0; i < raw.pools.length; i++) {
            const p = raw.pools[i];
            if (!p) continue;
            const id = p.id != null ? String(p.id) : `M${i}`;
            pools[id] = normalizePool(id, p);
        }
    }

    if (!Object.keys(pools).length) return null;

    return {
        id: raw.id != null ? String(raw.id) : null,
        biome:
            raw.biome != null
                ? String(raw.biome).trim().toLowerCase() || null
                : null,
        pools,
        density: numOrNull(raw.density) != null ? Number(raw.density) : 1
    };
}

/**
 * Normalize socket rows: { id, x, y, z }[].
 * @param {object[]} sockets
 * @param {number|string|null|undefined} defaultZ
 * @returns {{ id: string, x: number, y: number, z: number|string }[]}
 */
function normalizeSockets(sockets, defaultZ) {
    const out = [];
    const list = Array.isArray(sockets) ? sockets : [];
    const z0 = defaultZ != null ? defaultZ : 0;
    for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!s || s.x == null || s.y == null) continue;
        const x = Math.round(Number(s.x));
        const y = Math.round(Number(s.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const id =
            s.id != null
                ? String(s.id)
                : s.markerId != null
                  ? String(s.markerId)
                  : s.letter != null
                    ? String(s.letter)
                    : 'A';
        const z = s.z != null ? s.z : z0;
        out.push({ id, x, y, z });
    }
    return out;
}

/**
 * Derive marker resolve seed from hunt seed (independent of population LCG).
 * @param {number} seed
 * @returns {number}
 */
function markerSeedFrom(seed) {
    const s = seed != null ? seed >>> 0 || 1 : 1;
    return (s ^ MARKER_SEED_SALT) >>> 0 || 1;
}

/**
 * Core resolver: rules + sockets + seed → prop defs.
 *
 * @param {{
 *   rules: object,
 *   sockets?: object[],
 *   seed?: number,
 *   density?: number,
 *   defaultZ?: number|string
 * }} opts
 * @returns {{ props: object[], meta: object }}
 */
function resolveMarkers(opts) {
    const o = opts || {};
    const rules = normalizeMarkerRules(o.rules);
    if (!rules) {
        return {
            props: [],
            meta: {
                markersId: null,
                seed: markerSeedFrom(o.seed),
                propCount: 0,
                poolCounts: {},
                socketCandidates: 0,
                socketsUsed: 0,
                density: 1,
                reason: 'missing_rules'
            }
        };
    }

    const seed = markerSeedFrom(o.seed);
    const rng = createSeededRandom(seed);
    const density =
        o.density != null && Number(o.density) > 0
            ? Number(o.density)
            : rules.density > 0
              ? rules.density
              : 1;
    const defaultZ = o.defaultZ != null ? o.defaultZ : 0;
    const sockets = normalizeSockets(o.sockets, defaultZ);

    /** @type {Record<string, object[]>} */
    const byMarker = Object.create(null);
    for (let i = 0; i < sockets.length; i++) {
        const s = sockets[i];
        if (!byMarker[s.id]) byMarker[s.id] = [];
        byMarker[s.id].push(s);
    }

    /** @type {object[]} */
    const props = [];
    /** @type {Record<string, number>} */
    const poolCounts = Object.create(null);
    const poolIds = Object.keys(rules.pools).sort();

    for (let pi = 0; pi < poolIds.length; pi++) {
        const poolId = poolIds[pi];
        const pool = rules.pools[poolId];
        const candidates = (byMarker[poolId] || []).slice();
        if (!candidates.length) {
            poolCounts[poolId] = 0;
            continue;
        }
        shuffleInPlace(rng, candidates);

        let [lo, hi] = pool.spawnCount;
        // Density scales target count (ceil), still capped by sockets and hi after scale.
        let target = randInt(rng, lo, hi);
        if (density !== 1) {
            target = Math.max(0, Math.round(target * density));
        }
        if (target > candidates.length) target = candidates.length;
        // Respect absolute max after density (spawnCount max * density still ok via round)
        const hardMax = Math.max(hi, Math.ceil(hi * density));
        if (target > hardMax) target = hardMax;
        if (target < 0) target = 0;

        poolCounts[poolId] = target;

        for (let t = 0; t < target; t++) {
            const slot = candidates[t];
            const objectId =
                pool.objectIds[
                    Math.floor(rng() * pool.objectIds.length)
                ] || pool.objectIds[0];
            const loot = randInt(rng, pool.lootValue[0], pool.lootValue[1]);
            const heal = randInt(rng, pool.healAmount[0], pool.healAmount[1]);
            props.push({
                kind: 'prop',
                objectId: String(objectId),
                markerId: pool.id,
                x: slot.x,
                y: slot.y,
                z: slot.z,
                effect: pool.effect,
                lootValue: loot,
                healAmount: heal,
                blocking: !!pool.blocking,
                pacingTag: pool.pacingTag,
                id: `prop_${seed}_${props.length}_${slot.x}_${slot.y}`
            });
        }
    }

    // Deterministic order for seed-stable compares (by tile then id)
    props.sort((a, b) => {
        if (a.z !== b.z) return String(a.z).localeCompare(String(b.z));
        if (a.y !== b.y) return a.y - b.y;
        if (a.x !== b.x) return a.x - b.x;
        return String(a.id).localeCompare(String(b.id));
    });

    return {
        props,
        meta: {
            markersId: rules.id,
            seed,
            propCount: props.length,
            poolCounts,
            socketCandidates: sockets.length,
            socketsUsed: props.length,
            density,
            reason: 'ok'
        }
    };
}

/**
 * Whether a hunt carries marker rules / sockets intent.
 * @param {object|null|undefined} hunt
 * @returns {boolean}
 */
function huntHasMarkers(hunt) {
    if (!hunt || typeof hunt !== 'object') return false;
    if (hunt.markersId || hunt.markerRulesId) return true;
    if (hunt.markers && typeof hunt.markers === 'object') return true;
    if (hunt.markerRules && typeof hunt.markerRules === 'object') return true;
    if (Array.isArray(hunt.markerSockets) && hunt.markerSockets.length) {
        return true;
    }
    if (Array.isArray(hunt.markers) && hunt.markers.length) {
        // Socket array form without separate sockets field
        return true;
    }
    return false;
}

/**
 * Explicit authored props that must win over marker resolve.
 * @param {object} hunt
 * @returns {boolean}
 */
function huntHasExplicitProps(hunt) {
    if (!hunt || typeof hunt !== 'object') return false;
    if (hunt._hadAuthoredProps === true) return true;
    if (hunt._hadAuthoredProps === false) return false;
    if (hunt.markersMeta) return false;
    return Array.isArray(hunt.props) && hunt.props.length > 0;
}

/**
 * Collect marker sockets from hunt fields.
 * Supports markerSockets, markers[] as sockets, or markersMeta candidates.
 * @param {object} hunt
 * @returns {object[]}
 */
function collectMarkerSockets(hunt) {
    const defaultZ = hunt.floor != null ? hunt.floor : 0;
    if (Array.isArray(hunt.markerSockets) && hunt.markerSockets.length) {
        return normalizeSockets(hunt.markerSockets, defaultZ);
    }
    if (
        hunt.markersMeta &&
        Array.isArray(hunt.markersMeta.socketList) &&
        hunt.markersMeta.socketList.length
    ) {
        return normalizeSockets(hunt.markersMeta.socketList, defaultZ);
    }
    // markers as socket list: [{id,x,y,z}, ...]
    if (Array.isArray(hunt.markers) && hunt.markers.length) {
        const first = hunt.markers[0];
        if (first && first.x != null && first.y != null) {
            return normalizeSockets(hunt.markers, defaultZ);
        }
    }
    return [];
}

/**
 * Expand hunt marker rules → hunt.props defs.
 * Skips when explicit fixture props are present.
 *
 * @param {object} hunt
 * @param {{
 *   seed?: number,
 *   markerDensity?: number,
 *   loadMarkerRules?: (id: string) => object
 * }} [opts]
 * @returns {object}
 */
function resolveHuntMarkerDefs(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    if (!huntHasMarkers(hunt) && !huntHasExplicitProps(hunt)) return hunt;

    const o = opts || {};

    if (huntHasExplicitProps(hunt) && !hunt.markersMeta) {
        // Authored props without prior marker expand — fixtures win.
        // Still allow markers if only markersId is set alongside empty props? No.
        if (Array.isArray(hunt.props) && hunt.props.length) {
            const out = Object.assign({}, hunt);
            out.markersSkipped = 'explicit_props';
            out._hadAuthoredProps = true;
            return out;
        }
    }

    if (!huntHasMarkers(hunt)) return hunt;

    let rulesRaw = null;
    if (hunt.markerRules && typeof hunt.markerRules === 'object') {
        rulesRaw = hunt.markerRules;
    } else if (
        hunt.markers &&
        typeof hunt.markers === 'object' &&
        !Array.isArray(hunt.markers)
    ) {
        rulesRaw = hunt.markers;
    }

    const rulesId =
        hunt.markersId != null
            ? String(hunt.markersId)
            : hunt.markerRulesId != null
              ? String(hunt.markerRulesId)
              : null;

    if (!rulesRaw && rulesId && typeof o.loadMarkerRules === 'function') {
        rulesRaw = o.loadMarkerRules(rulesId);
    }

    if (!rulesRaw) {
        const out = Object.assign({}, hunt);
        out.markersSkipped = 'missing_rules';
        out.props = Array.isArray(out.props) ? out.props : [];
        return out;
    }

    const sockets = collectMarkerSockets(hunt);
    if (!sockets.length) {
        const out = Object.assign({}, hunt);
        out.markersSkipped = 'missing_sockets';
        out.props = Array.isArray(out.props) ? out.props : [];
        return out;
    }

    const seed = o.seed != null ? o.seed : hunt.seed != null ? hunt.seed : 1;
    const density =
        o.markerDensity != null
            ? o.markerDensity
            : hunt.markerDensity != null
              ? hunt.markerDensity
              : null;

    const result = resolveMarkers({
        rules: rulesRaw,
        sockets,
        seed,
        density: density != null ? density : undefined,
        defaultZ: hunt.floor
    });

    const out = Object.assign({}, hunt);
    out.props = result.props;
    out.markersMeta = Object.assign({}, result.meta, {
        socketList: sockets.map((s) => ({
            id: s.id,
            x: s.x,
            y: s.y,
            z: s.z
        }))
    });
    if (!out.markersId && result.meta.markersId) {
        out.markersId = result.meta.markersId;
    }
    out._hadAuthoredProps = false;
    delete out.markersSkipped;
    return out;
}

module.exports = {
    PROP_EFFECTS,
    MARKER_SEED_SALT,
    normalizeMarkerRules,
    normalizeSockets,
    normalizePool,
    resolveMarkers,
    resolveHuntMarkerDefs,
    huntHasMarkers,
    huntHasExplicitProps,
    collectMarkerSockets,
    markerSeedFrom,
    pairMinMax,
    randInt,
    shuffleInPlace
};
