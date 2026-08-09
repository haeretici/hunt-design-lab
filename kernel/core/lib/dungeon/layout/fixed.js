/**
 * Stage 11.5 — Fixed layouts + cutouts (Blueprint Phase 3, fixed).
 *
 * Authored piece graphs (or a small inline friction grid) form a stable base
 * map. Only cutout regions randomize events / population under seed; pathing
 * outside cutouts is identical across seeds.
 *
 * Not for full-world legacy continents — generator-owned bases only.
 */

'use strict';

const { createSeededRandom } = require('../../utils.js');
const {
    normalizePiece,
    normalizePiecePack,
    parseFrictionGrid,
    FRICTION_BLOCKED,
    DEFAULT_WALK_FRICTION
} = require('../pieces.js');
const { stitch } = require('../stitch.js');
const { validateLayout } = require('../validate.js');
const { resolvePopulation, normalizeSlots } = require('../population.js');

/** Salt so fixed/cutout RNG is independent of population/marker streams. */
const FIXED_SEED_SALT = 0x46584443; // "FXDC"

/**
 * @param {number} seed
 * @returns {number}
 */
function fixedLayoutSeed(seed) {
    return ((seed >>> 0) ^ FIXED_SEED_SALT) >>> 0 || 1;
}

/**
 * Per-cutout salt so each pocket is independent under the same run seed.
 * @param {number} seed
 * @param {string} cutoutId
 * @returns {number}
 */
function cutoutSeed(seed, cutoutId) {
    let h = (seed >>> 0) ^ FIXED_SEED_SALT;
    const s = String(cutoutId || '');
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
    }
    return h || 1;
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
 * Normalize [min,max] / scalar / {min,max}.
 * @param {*} raw
 * @param {number} lo0
 * @param {number} hi0
 * @returns {[number, number]}
 */
function pairMinMax(raw, lo0, hi0) {
    let lo = lo0;
    let hi = hi0;
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
    if (!Number.isFinite(lo)) lo = lo0;
    if (!Number.isFinite(hi)) hi = hi0;
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
 * Normalize bbox: {x,y,w,h} or {x,y,width,height} or [x,y,w,h].
 * @param {*} raw
 * @returns {{ x: number, y: number, w: number, h: number }|null}
 */
function normalizeBBox(raw) {
    if (raw == null) return null;
    if (Array.isArray(raw) && raw.length >= 4) {
        const x = Math.floor(Number(raw[0]));
        const y = Math.floor(Number(raw[1]));
        const w = Math.max(1, Math.floor(Number(raw[2]) || 1));
        const h = Math.max(1, Math.floor(Number(raw[3]) || 1));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x, y, w, h };
    }
    if (typeof raw !== 'object') return null;
    const x = Math.floor(Number(raw.x));
    const y = Math.floor(Number(raw.y));
    const w = Math.max(
        1,
        Math.floor(
            Number(raw.w != null ? raw.w : raw.width != null ? raw.width : 1) ||
                1
        )
    );
    const h = Math.max(
        1,
        Math.floor(
            Number(raw.h != null ? raw.h : raw.height != null ? raw.height : 1) ||
                1
        )
    );
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, w, h };
}

/**
 * Normalize polygon as [{x,y}|[x,y], ...].
 * @param {*} raw
 * @returns {{ x: number, y: number }[]|null}
 */
function normalizePolygon(raw) {
    if (!Array.isArray(raw) || raw.length < 3) return null;
    const pts = [];
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (Array.isArray(p) && p.length >= 2) {
            const x = Math.floor(Number(p[0]));
            const y = Math.floor(Number(p[1]));
            if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
        } else if (p && typeof p === 'object' && p.x != null && p.y != null) {
            const x = Math.floor(Number(p.x));
            const y = Math.floor(Number(p.y));
            if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
        }
    }
    return pts.length >= 3 ? pts : null;
}

/**
 * Point-in-polygon (ray cast). Inclusive on edges via bbox precheck optional.
 * @param {number} x
 * @param {number} y
 * @param {{ x: number, y: number }[]} poly
 * @returns {boolean}
 */
function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        const intersect =
            yi > y !== yj > y &&
            x < ((xj - xi) * (y - yi)) / (yj - yi + 0.0) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {object} cutout normalized
 * @returns {boolean}
 */
function pointInCutout(x, y, cutout) {
    if (!cutout) return false;
    if (cutout.bbox) {
        const b = cutout.bbox;
        if (x < b.x || y < b.y || x >= b.x + b.w || y >= b.y + b.h) {
            return false;
        }
        // bbox alone is enough when no polygon
        if (!cutout.polygon) return true;
    }
    if (cutout.polygon) {
        return pointInPolygon(x, y, cutout.polygon);
    }
    return false;
}

/**
 * Normalize one cutout region.
 * @param {object|null|undefined} raw
 * @param {number} index
 * @returns {object|null}
 */
function normalizeCutout(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const bbox = normalizeBBox(
        raw.bbox != null
            ? raw.bbox
            : raw.rect != null
              ? raw.rect
              : raw.region
    );
    const polygon = normalizePolygon(
        raw.polygon != null ? raw.polygon : raw.poly
    );
    if (!bbox && !polygon) return null;

    // If only polygon, derive bbox for sampling
    let box = bbox;
    if (!box && polygon) {
        let minX = polygon[0].x;
        let minY = polygon[0].y;
        let maxX = polygon[0].x;
        let maxY = polygon[0].y;
        for (let i = 1; i < polygon.length; i++) {
            minX = Math.min(minX, polygon[i].x);
            minY = Math.min(minY, polygon[i].y);
            maxX = Math.max(maxX, polygon[i].x);
            maxY = Math.max(maxY, polygon[i].y);
        }
        box = {
            x: minX,
            y: minY,
            w: Math.max(1, maxX - minX + 1),
            h: Math.max(1, maxY - minY + 1)
        };
    }

    const events = Array.isArray(raw.events)
        ? raw.events.map((e) => String(e)).filter(Boolean)
        : raw.event != null
          ? [String(raw.event)]
          : [];

    const [packsLo, packsHi] = pairMinMax(
        raw.maxPacks != null
            ? raw.maxPacks
            : raw.packs != null
              ? raw.packs
              : raw.totalPacks,
        1,
        4
    );

    return {
        id:
            raw.id != null
                ? String(raw.id)
                : raw.name != null
                  ? String(raw.name)
                  : `cutout_${index}`,
        bbox: box,
        polygon,
        events,
        populationId:
            raw.populationId != null ? String(raw.populationId) : null,
        population:
            raw.population && typeof raw.population === 'object'
                ? raw.population
                : null,
        markersId: raw.markersId != null ? String(raw.markersId) : null,
        density: numOrNull(raw.density) != null ? Number(raw.density) : null,
        maxPacks: [packsLo, packsHi],
        /** When true (default), use piece spawn sockets inside region. */
        useSockets: raw.useSockets !== false,
        /** Sample walkable cells when sockets empty / as supplement. */
        sampleWalkable: raw.sampleWalkable === true || raw.sample === true,
        sampleStep: Math.max(
            1,
            Math.floor(Number(raw.sampleStep) || 2)
        )
    };
}

/**
 * Normalize placement list for fixed stitch.
 * @param {*} raw
 * @returns {object[]}
 */
function normalizePlacements(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (!p || typeof p !== 'object') continue;
        const x = Math.floor(Number(p.x));
        const y = Math.floor(Number(p.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const row = {
            x,
            y,
            z: p.z != null ? p.z : 0
        };
        if (p.piece && typeof p.piece === 'object') {
            row.piece = p.piece;
        }
        if (p.pieceId != null) row.pieceId = String(p.pieceId);
        else if (p.id != null && !row.piece) row.pieceId = String(p.id);
        out.push(row);
    }
    return out;
}

/**
 * Normalize authored point {x,y,z?}.
 * @param {*} raw
 * @returns {{ x: number, y: number, z?: * }|null}
 */
function normalizePoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const x = Math.floor(Number(raw.x));
    const y = Math.floor(Number(raw.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const pt = { x, y };
    if (raw.z != null) pt.z = raw.z;
    return pt;
}

/**
 * Normalize fixed dungeon profile.
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeFixedProfile(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const placements = normalizePlacements(
        raw.placements != null ? raw.placements : raw.pieces
    );

    const cutoutsRaw = Array.isArray(raw.cutouts)
        ? raw.cutouts
        : Array.isArray(raw.regions)
          ? raw.regions
          : [];
    const cutouts = [];
    for (let i = 0; i < cutoutsRaw.length; i++) {
        const c = normalizeCutout(cutoutsRaw[i], i);
        if (c) cutouts.push(c);
    }

    let waypoints = null;
    if (Array.isArray(raw.waypoints) && raw.waypoints.length) {
        waypoints = [];
        for (let i = 0; i < raw.waypoints.length; i++) {
            const w = normalizePoint(raw.waypoints[i]);
            if (w) waypoints.push(w);
        }
        if (!waypoints.length) waypoints = null;
    }

    const entrance =
        normalizePoint(raw.entrance) ||
        (waypoints && waypoints[0] ? Object.assign({}, waypoints[0]) : null);
    const exit =
        normalizePoint(raw.exit) ||
        (waypoints && waypoints.length
            ? Object.assign({}, waypoints[waypoints.length - 1])
            : null);

    // Optional inline friction base (no pieces)
    let inlineBase = null;
    if (raw.friction != null || (raw.base && raw.base.friction != null)) {
        const src = raw.base && raw.base.friction != null ? raw.base : raw;
        let w = 1;
        let h = 1;
        if (src.cols != null) w = Math.max(1, Math.floor(Number(src.cols) || 1));
        if (src.rows != null) h = Math.max(1, Math.floor(Number(src.rows) || 1));
        if (src.size && typeof src.size === 'object') {
            w = Math.max(1, Math.floor(Number(src.size.w) || w));
            h = Math.max(1, Math.floor(Number(src.size.h) || h));
        }
        const fr = src.friction;
        if (Array.isArray(fr) && fr.length && typeof fr[0] === 'string') {
            h = Math.max(h, fr.length);
            for (let i = 0; i < fr.length; i++) {
                if (typeof fr[i] === 'string') w = Math.max(w, fr[i].length);
            }
        }
        const friction = parseFrictionGrid(
            fr,
            w,
            h,
            DEFAULT_WALK_FRICTION
        );
        const sockSrc =
            src.sockets && typeof src.sockets === 'object'
                ? src.sockets
                : raw.sockets && typeof raw.sockets === 'object'
                  ? raw.sockets
                  : {};
        inlineBase = {
            cols: w,
            rows: h,
            friction,
            sockets: {
                spawns: normalizeSlots(sockSrc.spawns || [], 0).map((s) =>
                    Object.assign({}, s)
                ),
                markers: (Array.isArray(sockSrc.markers)
                    ? sockSrc.markers
                    : []
                )
                    .map((m) => {
                        if (!m || m.x == null || m.y == null) return null;
                        return {
                            id:
                                m.id != null
                                    ? String(m.id)
                                    : m.letter != null
                                      ? String(m.letter)
                                      : 'A',
                            x: Math.round(Number(m.x)),
                            y: Math.round(Number(m.y)),
                            z: m.z != null ? m.z : 0
                        };
                    })
                    .filter(Boolean),
                waypoints: normalizeSlots(sockSrc.waypoints || [], 0)
            }
        };
    }

    if (!placements.length && !inlineBase) return null;

    return {
        id: raw.id != null ? String(raw.id) : null,
        type: 'fixed',
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
                : raw.markerRules != null
                  ? String(raw.markerRules)
                  : null,
        floor: raw.floor != null ? raw.floor : 0,
        placements,
        cutouts,
        waypoints,
        entrance,
        exit,
        inlineBase,
        pacingBudget:
            raw.pacingBudget && typeof raw.pacingBudget === 'object'
                ? raw.pacingBudget
                : null,
        /** When true, also fill non-cutout spawn sockets with profile population (seed-stable via fixed salt). Default false: cutouts only. */
        fillBasePopulation: raw.fillBasePopulation === true,
        notes: raw.notes != null ? String(raw.notes) : null
    };
}

/**
 * Filter points that fall inside a cutout.
 * @param {object[]} points
 * @param {object} cutout
 * @returns {object[]}
 */
function filterPointsInCutout(points, cutout) {
    const list = Array.isArray(points) ? points : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p) continue;
        if (pointInCutout(p.x, p.y, cutout)) out.push(p);
    }
    return out;
}

/**
 * Points outside every cutout.
 * @param {object[]} points
 * @param {object[]} cutouts
 * @returns {object[]}
 */
function filterPointsOutsideCutouts(points, cutouts) {
    const list = Array.isArray(points) ? points : [];
    const regions = Array.isArray(cutouts) ? cutouts : [];
    if (!regions.length) return list.slice();
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p) continue;
        let inside = false;
        for (let c = 0; c < regions.length; c++) {
            if (pointInCutout(p.x, p.y, regions[c])) {
                inside = true;
                break;
            }
        }
        if (!inside) out.push(p);
    }
    return out;
}

/**
 * Sample walkable cells inside cutout region (grid step).
 * @param {Uint8Array} friction
 * @param {number} cols
 * @param {number} rows
 * @param {object} cutout
 * @param {number|string} z
 * @returns {{ x: number, y: number, z: * }[]}
 */
function sampleWalkableInCutout(friction, cols, rows, cutout, z) {
    const box = cutout.bbox;
    if (!box) return [];
    const step = cutout.sampleStep || 2;
    const out = [];
    for (let y = box.y; y < box.y + box.h; y += step) {
        for (let x = box.x; x < box.x + box.w; x += step) {
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
            if (!pointInCutout(x, y, cutout)) continue;
            if (friction[y * cols + x] === FRICTION_BLOCKED) continue;
            out.push({ x, y, z });
        }
    }
    return out;
}

/**
 * Pick event id from cutout.events under rng (null if empty).
 * @param {object} cutout
 * @param {() => number} rng
 * @returns {string|null}
 */
function pickCutoutEvent(cutout, rng) {
    const events = cutout.events || [];
    if (!events.length) return null;
    return events[Math.floor(rng() * events.length)] || events[0];
}

/**
 * Build base map from placements or inline friction.
 * @param {object} profile normalized fixed
 * @param {object|null} pack normalized piece pack
 * @param {number|string} z
 * @returns {{
 *   ok: boolean,
 *   error?: object,
 *   cols?: number,
 *   rows?: number,
 *   friction?: Uint8Array,
 *   sockets?: object,
 *   placements?: object[],
 *   origin?: {x:number,y:number}
 * }}
 */
function buildFixedBase(profile, pack, z) {
    if (profile.inlineBase) {
        const b = profile.inlineBase;
        const friction = new Uint8Array(b.friction);
        const sockets = {
            spawns: (b.sockets.spawns || []).map((s) =>
                Object.assign({}, s, { z: s.z != null ? s.z : z })
            ),
            markers: (b.sockets.markers || []).map((m) =>
                Object.assign({}, m, { z: m.z != null ? m.z : z })
            ),
            waypoints: (b.sockets.waypoints || []).map((w) =>
                Object.assign({}, w, { z: w.z != null ? w.z : z })
            )
        };
        return {
            ok: true,
            cols: b.cols,
            rows: b.rows,
            friction,
            sockets,
            placements: [],
            origin: { x: 0, y: 0 }
        };
    }

    if (!profile.placements.length) {
        return {
            ok: false,
            error: {
                code: 'empty_layout',
                message: 'Fixed profile has no placements or inline base'
            }
        };
    }

    if (!pack || !pack.pieces || !pack.pieces.length) {
        // Allow fully inline pieces on placements
        const hasInline = profile.placements.some(
            (p) => p.piece && typeof p.piece === 'object'
        );
        if (!hasInline) {
            return {
                ok: false,
                error: {
                    code: 'missing_piece_pack',
                    message: 'Fixed piece placements need a piece pack'
                }
            };
        }
    }

    const stitched = stitch(profile.placements, {
        pack: pack || undefined,
        z,
        shiftOrigin: true
    });

    if (!stitched.meta || stitched.meta.reason === 'empty') {
        return {
            ok: false,
            error: {
                code: 'empty_layout',
                message: 'Fixed stitch produced empty map'
            }
        };
    }

    return {
        ok: true,
        cols: stitched.cols,
        rows: stitched.rows,
        friction: stitched.friction,
        sight: stitched.sight || null,
        flags: stitched.flags || null,
        sockets: stitched.sockets,
        placements: stitched.placements,
        origin: stitched.origin
    };
}

/**
 * Resolve entrance/exit/waypoints from profile or base sockets.
 * @param {object} profile
 * @param {object} base
 * @param {number|string} z
 */
function resolveSpine(profile, base, z) {
    let waypoints = null;
    if (profile.waypoints && profile.waypoints.length) {
        waypoints = profile.waypoints.map((w) =>
            Object.assign({}, w, { z: w.z != null ? w.z : z })
        );
    } else {
        const sock = (base.sockets && base.sockets.waypoints) || [];
        if (sock.length) {
            // Prefer first and last socket as spine; keep intermediate unique
            waypoints = sock.map((w) =>
                Object.assign({}, w, { z: w.z != null ? w.z : z })
            );
        }
    }

    let entrance = profile.entrance
        ? Object.assign({}, profile.entrance, {
              z: profile.entrance.z != null ? profile.entrance.z : z
          })
        : null;
    let exit = profile.exit
        ? Object.assign({}, profile.exit, {
              z: profile.exit.z != null ? profile.exit.z : z
          })
        : null;

    if (!entrance && waypoints && waypoints.length) {
        entrance = Object.assign({}, waypoints[0]);
    }
    if (!exit && waypoints && waypoints.length) {
        exit = Object.assign({}, waypoints[waypoints.length - 1]);
    }

    // Fallback: first/last walkable along mid-row
    if (!entrance || !exit) {
        const { friction, cols, rows } = base;
        let first = null;
        let last = null;
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < cols; x++) {
                if (friction[y * cols + x] === FRICTION_BLOCKED) continue;
                if (!first) first = { x, y, z };
                last = { x, y, z };
            }
        }
        if (!entrance && first) entrance = first;
        if (!exit && last) exit = last;
    }

    if (
        entrance &&
        exit &&
        (!waypoints || waypoints.length < 2)
    ) {
        waypoints = [entrance, exit];
    }

    return { waypoints: waypoints || [], entrance, exit };
}

/**
 * Collect spawn slots for one cutout.
 * @returns {object[]}
 */
function collectCutoutSlots(base, cutout, z) {
    const slots = [];
    if (cutout.useSockets !== false) {
        const sock = filterPointsInCutout(
            (base.sockets && base.sockets.spawns) || [],
            cutout
        );
        for (let i = 0; i < sock.length; i++) {
            slots.push({
                x: sock[i].x,
                y: sock[i].y,
                z: sock[i].z != null ? sock[i].z : z
            });
        }
    }
    if (cutout.sampleWalkable || !slots.length) {
        const sampled = sampleWalkableInCutout(
            base.friction,
            base.cols,
            base.rows,
            cutout,
            z
        );
        const seen = Object.create(null);
        for (let i = 0; i < slots.length; i++) {
            seen[`${slots[i].x},${slots[i].y}`] = true;
        }
        for (let i = 0; i < sampled.length; i++) {
            const k = `${sampled[i].x},${sampled[i].y}`;
            if (seen[k]) continue;
            seen[k] = true;
            slots.push(sampled[i]);
        }
    }
    return slots;
}

/**
 * Generate a fixed layout with seed-driven cutout fills.
 *
 * @param {{
 *   profile: object,
 *   pack?: object,
 *   seed?: number,
 *   floor?: number|string,
 *   z?: number|string,
 *   loadPopulation?: (id: string) => object
 * }} opts
 * @returns {object}
 */
function generateFixedLayout(opts) {
    const o = opts || {};
    const seed = o.seed != null ? o.seed >>> 0 || 1 : 1;
    const rng = createSeededRandom(fixedLayoutSeed(seed));

    // Always normalize so cutouts/placements are consistent
    const profile = normalizeFixedProfile(o.profile);
    if (!profile) {
        return {
            ok: false,
            seed,
            profileId: null,
            error: {
                code: 'invalid_profile',
                message: 'Missing or invalid fixed layout profile'
            }
        };
    }

    const z =
        o.z != null
            ? o.z
            : o.floor != null
              ? o.floor
              : profile.floor != null
                ? profile.floor
                : 0;

    let pack = o.pack || null;
    if (pack && !pack.byId) {
        pack = normalizePiecePack(pack);
    }

    const base = buildFixedBase(profile, pack, z);
    if (!base.ok) {
        return {
            ok: false,
            seed,
            profileId: profile.id,
            error: base.error
        };
    }

    const spine = resolveSpine(profile, base, z);
    const validation = validateLayout(
        {
            cols: base.cols,
            rows: base.rows,
            friction: base.friction,
            sockets: base.sockets
        },
        {
            entrance: spine.entrance,
            exit: spine.exit,
            requireEntranceExit: !!(spine.entrance && spine.exit),
            requireSpawnWalkable: false
        }
    );

    if (!validation.ok) {
        const first = validation.errors[0];
        return {
            ok: false,
            seed,
            profileId: profile.id,
            error: {
                code: first ? first.code : 'validation_failed',
                message: first ? first.message : 'Fixed base validation failed',
                detail: validation.errors
            },
            cols: base.cols,
            rows: base.rows,
            friction: base.friction
        };
    }

    // Fill cutouts (seed-dependent)
    const cutoutResults = [];
    const populationSlots = [];
    const markerSockets = [];
    const spawns = [];
    /** @type {Record<string, number>} */
    const groupCounts = Object.create(null);
    let creatureCount = 0;

    for (let i = 0; i < profile.cutouts.length; i++) {
        const cutout = profile.cutouts[i];
        // Draw event from shared layout stream first (order-stable)
        const eventId = pickCutoutEvent(cutout, rng);
        const slots = collectCutoutSlots(base, cutout, z);
        const cMarkers = filterPointsInCutout(
            (base.sockets && base.sockets.markers) || [],
            cutout
        ).map((m) =>
            Object.assign({}, m, {
                z: m.z != null ? m.z : z,
                cutoutId: cutout.id,
                eventId
            })
        );
        for (let m = 0; m < cMarkers.length; m++) {
            markerSockets.push(cMarkers[m]);
        }

        for (let s = 0; s < slots.length; s++) {
            populationSlots.push(
                Object.assign({}, slots[s], {
                    cutoutId: cutout.id,
                    eventId
                })
            );
        }

        // Resolve population for this cutout under per-cutout seed
        let popRaw =
            cutout.population && typeof cutout.population === 'object'
                ? cutout.population
                : null;
        if (
            !popRaw &&
            cutout.populationId &&
            typeof o.loadPopulation === 'function'
        ) {
            popRaw = o.loadPopulation(cutout.populationId);
        }
        if (
            !popRaw &&
            profile.populationId &&
            typeof o.loadPopulation === 'function'
        ) {
            popRaw = o.loadPopulation(profile.populationId);
        }
        if (!popRaw && o.population && typeof o.population === 'object') {
            popRaw = o.population;
        }

        let cutoutSpawns = [];
        let popMeta = null;
        if (popRaw && slots.length) {
            // Cap total packs via cutout.maxPacks by cloning limits
            const popForResolve = Object.assign({}, popRaw);
            if (!popForResolve.limits) popForResolve.limits = {};
            else {
                popForResolve.limits = Object.assign({}, popForResolve.limits);
            }
            popForResolve.limits.totalPacks = cutout.maxPacks;

            const cSeed = cutoutSeed(seed, cutout.id);
            const resolved = resolvePopulation({
                population: popForResolve,
                slots,
                seed: cSeed,
                density: cutout.density != null ? cutout.density : undefined,
                defaultZ: z
            });
            cutoutSpawns = resolved.spawns.map((s) =>
                Object.assign({}, s, {
                    cutoutId: cutout.id,
                    eventId: eventId || undefined
                })
            );
            popMeta = resolved.meta;
            for (let s = 0; s < cutoutSpawns.length; s++) {
                spawns.push(cutoutSpawns[s]);
            }
            creatureCount += cutoutSpawns.length;
            if (popMeta && popMeta.groupCounts) {
                const gids = Object.keys(popMeta.groupCounts);
                for (let g = 0; g < gids.length; g++) {
                    const id = gids[g];
                    groupCounts[id] =
                        (groupCounts[id] || 0) + popMeta.groupCounts[id];
                }
            }
        }

        cutoutResults.push({
            id: cutout.id,
            eventId,
            bbox: cutout.bbox,
            slotCount: slots.length,
            markerCount: cMarkers.length,
            spawnCount: cutoutSpawns.length,
            populationId: popMeta ? popMeta.populationId : cutout.populationId,
            seed: cutoutSeed(seed, cutout.id)
        });
    }

    // Optional base (non-cutout) population — uses fixed salt so outside path
    // does not depend on hunt seed (pathing invariant). Spawns still optional.
    if (profile.fillBasePopulation && profile.populationId) {
        const baseSlots = filterPointsOutsideCutouts(
            (base.sockets && base.sockets.spawns) || [],
            profile.cutouts
        );
        if (
            baseSlots.length &&
            typeof o.loadPopulation === 'function'
        ) {
            const popRaw = o.loadPopulation(profile.populationId);
            if (popRaw) {
                const resolved = resolvePopulation({
                    population: popRaw,
                    slots: baseSlots,
                    seed: FIXED_SEED_SALT, // seed-independent base fill
                    defaultZ: z
                });
                for (let i = 0; i < resolved.spawns.length; i++) {
                    spawns.push(
                        Object.assign({}, resolved.spawns[i], {
                            cutoutId: null,
                            base: true
                        })
                    );
                }
                creatureCount += resolved.spawns.length;
            }
        }
    }

    return {
        ok: true,
        seed,
        profileId: profile.id,
        cols: base.cols,
        rows: base.rows,
        friction: base.friction,
        sockets: base.sockets,
        placements: base.placements,
        waypoints: spine.waypoints,
        entrance: spine.entrance,
        exit: spine.exit,
        cutouts: cutoutResults,
        populationSlots,
        markerSockets,
        spawns,
        populationMeta: {
            populationId: profile.populationId,
            seed,
            packCount: Object.keys(groupCounts).reduce(
                (s, k) => s + groupCounts[k],
                0
            ),
            creatureCount,
            groupCounts,
            slotsUsed: spawns.length,
            reason: 'fixed_cutouts'
        },
        validation,
        origin: base.origin,
        meta: {
            type: 'fixed',
            pieceCount: (base.placements && base.placements.length) || 0,
            cutoutCount: cutoutResults.length,
            piecePackId: pack ? pack.id : null,
            floor: z,
            reason: 'ok'
        }
    };
}

/**
 * Apply fixed layout result onto a hunt object (floorFriction, sockets, spawns).
 * @param {object} hunt
 * @param {object} gen generateFixedLayout result
 * @param {object} profile normalized
 * @param {number} seed
 * @param {number|string} floor
 * @returns {object}
 */
function applyFixedToHunt(hunt, gen, profile, seed, floor) {
    const out = Object.assign({}, hunt);
    out.floor = floor;
    out.floors = [floor];
    out.floorFriction = {
        z: floor,
        cols: gen.cols,
        rows: gen.rows,
        friction: gen.friction,
        sight: gen.sight || null,
        flags: gen.flags || null
    };
    delete out.mapPath;
    delete out.mapPaths;

    // Route is owned by the dungeon profile (not the hunt JSON).
    out.waypoints = (gen.waypoints || []).map((w) => ({
        x: w.x,
        y: w.y,
        z: w.z != null ? w.z : floor
    }));

    // Cutout-only slots for any downstream consumer; spawns already filled
    out.populationSlots = (gen.populationSlots || []).map((s) => ({
        x: s.x,
        y: s.y,
        z: s.z != null ? s.z : floor,
        cutoutId: s.cutoutId,
        eventId: s.eventId
    }));

    if (!Array.isArray(out.markerSockets) || !out.markerSockets.length) {
        out.markerSockets = (gen.markerSockets || []).map((m) => ({
            id: m.id != null ? m.id : 'A',
            x: m.x,
            y: m.y,
            z: m.z != null ? m.z : floor
        }));
    }

    // Prefer layout-resolved spawns (cutouts / optional base fill). Keep authored
    // fixture spawns when the layout produced none (wave hunts on a fixed shell).
    // When layout spawns are applied — including an intentional empty cutout roll —
    // set spawnsFilled so population expand does not re-roll the whole map.
    const genSpawns = Array.isArray(gen.spawns) ? gen.spawns : null;
    const huntHasAuthoredSpawns =
        Array.isArray(hunt.spawns) && hunt.spawns.length > 0;
    const applyLayoutSpawns =
        genSpawns != null && (genSpawns.length > 0 || !huntHasAuthoredSpawns);

    if (applyLayoutSpawns) {
        out.spawns = genSpawns.map((s) => Object.assign({}, s));
        out.populationMeta = gen.populationMeta;
    }

    if (!out.populationId && !out.population && profile.populationId) {
        out.populationId = profile.populationId;
    }
    if (
        !out.markersId &&
        !out.markerRules &&
        !out.markers &&
        profile.markersId
    ) {
        out.markersId = profile.markersId;
    }
    if (!out.pacingBudget && profile.pacingBudget) {
        out.pacingBudget = profile.pacingBudget;
    }

    out.layoutMeta = {
        reason: 'ok',
        type: 'fixed',
        seed,
        profileId: gen.profileId,
        piecePackId: gen.meta && gen.meta.piecePackId,
        pieceCount: gen.meta && gen.meta.pieceCount,
        cutoutCount: gen.meta && gen.meta.cutoutCount,
        cols: gen.cols,
        rows: gen.rows,
        entrance: gen.entrance,
        exit: gen.exit,
        cutouts: gen.cutouts,
        spawnsFilled: applyLayoutSpawns,
        validation: {
            ok: gen.validation.ok,
            walkable: gen.validation.walkable,
            pathLength:
                gen.validation.connectivity &&
                gen.validation.connectivity.pathLength
        }
    };
    out.layoutPlacements = gen.placements;
    out.layoutCutouts = gen.cutouts;

    // Auto-bake coarse navmesh for long routes on fixed layouts
    if (!out.navmeshData) {
        try {
            const {
                bakeStitchedNavmesh,
                toNavmeshData
            } = require('../navbake.js');
            const baked = bakeStitchedNavmesh(
                {
                    cols: gen.cols,
                    rows: gen.rows,
                    friction: gen.friction,
                    sockets: gen.sockets || {
                        waypoints: gen.waypoints,
                        markers: gen.markerSockets,
                        spawns: gen.populationSlots
                    },
                    placements: gen.placements
                },
                {
                    z: floor,
                    waypoints: out.waypoints,
                    id: `fixed_${gen.profileId || 'layout'}`
                }
            );
            out.navmeshData = toNavmeshData(baked);
            out.layoutMeta.navmesh = baked.meta || null;
        } catch (_e) {
            /* bake is optional infrastructure */
        }
    }

    delete out.layoutSkipped;
    delete out.layoutError;
    return out;
}

/**
 * Expand hunt.layout type fixed → friction + cutout spawns.
 *
 * @param {object} hunt
 * @param {{
 *   seed?: number,
 *   loadDungeonProfile?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   normalizePiecePack?: (raw: object) => object|null,
 *   loadPopulation?: (id: string) => object
 * }} [opts]
 * @returns {object}
 */
function resolveFixedHuntLayout(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    const layout = hunt.layout;
    if (!layout || typeof layout !== 'object') return hunt;

    if (hunt.layoutMeta && hunt.layoutMeta.reason === 'ok' && hunt.floorFriction) {
        return hunt;
    }

    const o = opts || {};
    const seed =
        o.seed != null
            ? o.seed >>> 0 || 1
            : hunt.seed != null
              ? hunt.seed >>> 0 || 1
              : 1;

    let profileRaw = null;
    if (layout.profile && typeof layout.profile === 'object') {
        profileRaw = layout.profile;
    } else if (layout.placements || layout.cutouts || layout.friction) {
        profileRaw = layout;
    } else {
        const profileId =
            layout.profileId != null
                ? String(layout.profileId)
                : layout.id != null
                  ? String(layout.id)
                  : hunt.dungeonProfileId != null
                    ? String(hunt.dungeonProfileId)
                    : null;
        if (profileId && typeof o.loadDungeonProfile === 'function') {
            profileRaw = o.loadDungeonProfile(profileId);
        }
    }

    if (!profileRaw) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = 'missing_profile';
        out.layoutError = {
            code: 'missing_profile',
            message: 'Fixed layout needs profileId or inline profile'
        };
        return out;
    }

    // Merge layout-level cutouts/placements overrides onto profile
    const merged = Object.assign({}, profileRaw);
    if (layout.placements) merged.placements = layout.placements;
    if (layout.cutouts) merged.cutouts = layout.cutouts;
    if (layout.waypoints) merged.waypoints = layout.waypoints;
    if (layout.entrance) merged.entrance = layout.entrance;
    if (layout.exit) merged.exit = layout.exit;
    if (layout.piecePack) merged.piecePack = layout.piecePack;
    if (layout.populationId) merged.populationId = layout.populationId;
    if (layout.markersId) merged.markersId = layout.markersId;

    const profile = normalizeFixedProfile(merged);
    if (!profile) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = 'invalid_profile';
        out.layoutError = {
            code: 'invalid_profile',
            message: 'Fixed dungeon profile failed to normalize'
        };
        return out;
    }

    const packId =
        layout.piecePack != null
            ? String(layout.piecePack)
            : profile.piecePack != null
              ? profile.piecePack
              : null;

    let packRaw = layout.pack || null;
    if (!packRaw && packId && typeof o.loadPiecePack === 'function') {
        packRaw = o.loadPiecePack(packId);
    }
    const normPack =
        typeof o.normalizePiecePack === 'function'
            ? o.normalizePiecePack
            : normalizePiecePack;
    const pack = packRaw ? normPack(packRaw) : null;
    const hasInlinePieces = profile.placements.some(
        (p) => p.piece && typeof p.piece === 'object'
    );

    if (profile.placements.length && !pack && !hasInlinePieces && !profile.inlineBase) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = 'missing_piece_pack';
        out.layoutError = {
            code: 'missing_piece_pack',
            message: `Piece pack not found: ${packId || '(none)'}`
        };
        return out;
    }

    const floor =
        hunt.floor != null
            ? hunt.floor
            : profile.floor != null
              ? profile.floor
              : 0;

    const gen = generateFixedLayout({
        profile,
        pack,
        seed,
        floor,
        z: floor,
        loadPopulation: o.loadPopulation,
        population: hunt.population
    });

    if (!gen.ok) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = gen.error ? gen.error.code : 'generate_failed';
        out.layoutError = gen.error || {
            code: 'generate_failed',
            message: 'Fixed layout generation failed'
        };
        out.layoutMeta = {
            reason: 'failed',
            type: 'fixed',
            seed,
            profileId: gen.profileId
        };
        return out;
    }

    return applyFixedToHunt(hunt, gen, profile, seed, floor);
}

module.exports = {
    FIXED_SEED_SALT,
    fixedLayoutSeed,
    cutoutSeed,
    normalizeBBox,
    normalizePolygon,
    normalizeCutout,
    normalizeFixedProfile,
    pointInCutout,
    pointInPolygon,
    filterPointsInCutout,
    filterPointsOutsideCutouts,
    sampleWalkableInCutout,
    buildFixedBase,
    generateFixedLayout,
    resolveFixedHuntLayout,
    applyFixedToHunt,
    // re-export helpers for tests
    normalizePiece,
    pairMinMax
};
