/**
 * Stage 11.8 — Multi-floor biome chains.
 *
 * Chain single-floor generators (procedural / fixed) into stacked floorLayers
 * linked by stair sockets → stairLinks + navmesh edges. Output speaks the same
 * TileMap / SpawnManager contract as single-floor layouts.
 *
 * Stair placement:
 * 1. Prefer piece sockets.stairs (dir up|down, optional link id)
 * 2. Else synthesize from entrance/exit so consecutive floors always connect
 */

'use strict';

const {
    generateProceduralLayout,
    normalizeDungeonProfile
} = require('./procedural.js');
const { generateFixedLayout } = require('./fixed.js');
const { normalizePiecePack } = require('../pieces.js');

/** Salt so multi-floor floor seeds diverge from layout/population streams. */
const MULTIFLOOR_SEED_SALT = 0x4d464c52; // "MFLR"

/**
 * Detect single-floor layout type (mirrors tester.detectLayoutType; no import cycle).
 * @param {object|null|undefined} raw
 * @returns {'procedural'|'fixed'|null}
 */
function detectFloorLayoutType(raw) {
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
 * @param {number} seed
 * @param {number} floorIndex
 * @returns {number}
 */
function floorSeed(seed, floorIndex) {
    const base = (seed >>> 0) ^ MULTIFLOOR_SEED_SALT;
    return (base + ((floorIndex + 1) * 0x9e3779b9)) >>> 0 || 1;
}

/**
 * Normalize one floor-chain entry.
 * Accepts string profile id or object with profileId / z / artSet / etc.
 *
 * @param {*} raw
 * @param {number} index
 * @returns {object|null}
 */
function normalizeFloorEntry(raw, index) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string' || typeof raw === 'number') {
        const id = String(raw).trim();
        if (!id) return null;
        return {
            z: index,
            profileId: id,
            profile: null,
            piecePack: null,
            populationId: null,
            markersId: null,
            artSet: null,
            biomeId: null,
            role: null,
            type: null,
            macroTransition: false
        };
    }
    if (typeof raw !== 'object') return null;

    const profileId =
        raw.profileId != null
            ? String(raw.profileId)
            : raw.id != null && !raw.rules && !raw.placements
              ? String(raw.id)
              : null;

    let z = index;
    if (raw.z != null && Number.isFinite(Number(raw.z))) {
        z = Number(raw.z);
    } else if (raw.floor != null && Number.isFinite(Number(raw.floor))) {
        z = Number(raw.floor);
    }

    // Inline profile object (rules / placements)
    let profile = null;
    if (raw.profile && typeof raw.profile === 'object') {
        profile = raw.profile;
    } else if (
        Array.isArray(raw.rules) ||
        Array.isArray(raw.placements) ||
        raw.friction != null
    ) {
        profile = raw;
    }

    return {
        z,
        profileId,
        profile,
        piecePack:
            raw.piecePack != null
                ? String(raw.piecePack)
                : raw.piecePackId != null
                  ? String(raw.piecePackId)
                  : null,
        populationId:
            raw.populationId != null
                ? String(raw.populationId)
                : raw.population != null && typeof raw.population === 'string'
                  ? String(raw.population)
                  : null,
        markersId:
            raw.markersId != null
                ? String(raw.markersId)
                : raw.markerRules != null && typeof raw.markerRules === 'string'
                  ? String(raw.markerRules)
                  : null,
        artSet: raw.artSet != null ? String(raw.artSet) : null,
        // Stage 11.10: per-floor biome for macro multi-biome transitions
        biomeId:
            raw.biomeId != null
                ? String(raw.biomeId).trim().toLowerCase() || null
                : raw.biome != null && typeof raw.biome === 'string'
                  ? String(raw.biome).trim().toLowerCase() || null
                  : null,
        role: raw.role != null ? String(raw.role) : null,
        type: raw.type != null ? String(raw.type) : raw.kind != null ? String(raw.kind) : null,
        maxAttempts: raw.maxAttempts != null ? Number(raw.maxAttempts) : null,
        macroTransition: !!raw.macroTransition
    };
}

/**
 * Normalize a floor chain array (biome.floors or layout.floors).
 * @param {*} raw
 * @returns {object[]|null}
 */
function normalizeFloorChain(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    /** @type {object[]} */
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const e = normalizeFloorEntry(raw[i], i);
        if (e) out.push(e);
    }
    return out.length ? out : null;
}

/**
 * @param {object} gen single-floor generate result
 * @param {'up'|'down'} dir
 * @param {number|string} z
 * @param {string|null} link
 * @returns {object|null}
 */
function synthesizeStair(gen, dir, z, link) {
    if (!gen || !gen.ok) return null;
    let pt = null;
    if (dir === 'down') {
        pt = gen.exit || null;
        if (!pt && gen.waypoints && gen.waypoints.length) {
            pt = gen.waypoints[gen.waypoints.length - 1];
        }
    } else {
        pt = gen.entrance || null;
        if (!pt && gen.waypoints && gen.waypoints.length) {
            pt = gen.waypoints[0];
        }
    }
    if (!pt && gen.sockets && gen.sockets.spawns && gen.sockets.spawns.length) {
        pt = gen.sockets.spawns[0];
    }
    if (!pt) return null;
    return {
        x: Math.floor(Number(pt.x)),
        y: Math.floor(Number(pt.y)),
        z,
        dir,
        link: link != null ? String(link) : null,
        synthesized: true
    };
}

/**
 * Collect stairs for a generated floor; synthesize if missing and needed.
 *
 * @param {object} gen
 * @param {number|string} z
 * @param {{ needDown?: boolean, needUp?: boolean, link?: string|null }} needs
 * @returns {object[]}
 */
function ensureStairs(gen, z, needs) {
    const n = needs || {};
    /** @type {object[]} */
    let stairs =
        gen.sockets && Array.isArray(gen.sockets.stairs)
            ? gen.sockets.stairs.map((s) =>
                  Object.assign({}, s, { z: s.z != null ? s.z : z })
              )
            : [];

    const hasDown = stairs.some((s) => s.dir === 'down');
    const hasUp = stairs.some((s) => s.dir === 'up');
    const link = n.link != null ? n.link : 'main';

    if (n.needDown && !hasDown) {
        const s = synthesizeStair(gen, 'down', z, link);
        if (s) stairs.push(s);
    }
    if (n.needUp && !hasUp) {
        const s = synthesizeStair(gen, 'up', z, link);
        if (s) stairs.push(s);
    }

    // Mirror into gen sockets for consumers
    if (gen.sockets) {
        gen.sockets.stairs = stairs.slice();
    }
    return stairs;
}

/**
 * Pair down stairs on upper floor with up stairs on lower floor.
 *
 * @param {object[]} upperStairs stairs with dir down on zA
 * @param {object[]} lowerStairs stairs with dir up on zB
 * @returns {{ from: object, to: object, link: string|null }[]}
 */
function pairStairLinks(upperStairs, lowerStairs) {
    const downs = (upperStairs || []).filter((s) => s && s.dir === 'down');
    const ups = (lowerStairs || []).filter((s) => s && s.dir === 'up');
    /** @type {{ from: object, to: object, link: string|null }[]} */
    const links = [];
    const usedUp = Object.create(null);

    // Match by link id first
    for (let i = 0; i < downs.length; i++) {
        const d = downs[i];
        if (d.link == null) continue;
        for (let j = 0; j < ups.length; j++) {
            if (usedUp[j]) continue;
            const u = ups[j];
            if (u.link != null && String(u.link) === String(d.link)) {
                usedUp[j] = true;
                links.push({
                    from: { x: d.x, y: d.y, z: d.z },
                    to: { x: u.x, y: u.y, z: u.z },
                    link: String(d.link)
                });
                downs[i] = null;
                break;
            }
        }
    }

    // Remaining by index order
    const freeDowns = downs.filter(Boolean);
    const freeUps = [];
    for (let j = 0; j < ups.length; j++) {
        if (!usedUp[j]) freeUps.push(ups[j]);
    }
    const n = Math.min(freeDowns.length, freeUps.length);
    for (let k = 0; k < n; k++) {
        const d = freeDowns[k];
        const u = freeUps[k];
        links.push({
            from: { x: d.x, y: d.y, z: d.z },
            to: { x: u.x, y: u.y, z: u.z },
            link: d.link != null ? String(d.link) : u.link != null ? String(u.link) : null
        });
    }
    return links;
}

/**
 * Build navmesh data from multi-floor waypoints + stair links.
 * Prefer friction-aware bake when floorLayers are available; fall back to
 * spine + stair edges only.
 *
 * @param {object[]} waypoints
 * @param {{ from: object, to: object }[]} stairLinks
 * @param {{
 *   floorLayers?: Record<string, { cols: number, rows: number, friction: Uint8Array }>,
 *   socketsByFloor?: Record<string, object>,
 *   includeSpawns?: boolean
 * }} [opts]
 * @returns {{ points: object[], connections: number[][], id: string, meta?: object }}
 */
function buildMultiFloorNavmesh(waypoints, stairLinks, opts) {
    const o = opts || {};
    const layers = o.floorLayers || null;

    if (layers && typeof layers === 'object') {
        try {
            const {
                bakeMultiFloorNavmesh,
                toNavmeshData
            } = require('../navbake.js');

            /** @type {object[]} */
            const floors = [];
            const wps = Array.isArray(waypoints) ? waypoints : [];
            const socketsByFloor = o.socketsByFloor || Object.create(null);

            for (const zk of Object.keys(layers)) {
                const layer = layers[zk];
                if (!layer || !layer.friction) continue;
                const zNum = Number(zk);
                const z = Number.isFinite(zNum) ? zNum : zk;
                const floorWps = wps.filter(
                    (w) => w && String(w.z) === String(z)
                );
                const sock = socketsByFloor[String(zk)] || {
                    waypoints: floorWps,
                    spawns: [],
                    stairs: [],
                    markers: []
                };
                floors.push({
                    z,
                    friction: layer.friction,
                    cols: layer.cols,
                    rows: layer.rows,
                    sockets: sock,
                    waypoints: floorWps
                });
            }

            if (floors.length) {
                const baked = bakeMultiFloorNavmesh({
                    floors,
                    stairLinks,
                    includeSpawns: o.includeSpawns !== false,
                    id: 'generated_multifloor',
                    label: 'generated multi-floor'
                });
                const data = toNavmeshData(baked);
                data.meta = baked.meta;
                return data;
            }
        } catch (_e) {
            /* fall through to spine-only */
        }
    }

    // Fallback: consecutive same-floor waypoint edges + free stair links
    /** @type {object[]} */
    const points = [];
    /** @type {number[][]} */
    const connections = [];
    const keyOf = (p) => `${p.x},${p.y},${p.z}`;
    const indexByKey = Object.create(null);

    function addPoint(p, props) {
        if (!p || p.x == null || p.y == null) return -1;
        const row = {
            x: Math.floor(Number(p.x)),
            y: Math.floor(Number(p.y)),
            z: p.z != null ? p.z : 0,
            properties: props || {}
        };
        const k = keyOf(row);
        if (indexByKey[k] != null) return indexByKey[k];
        const idx = points.length;
        indexByKey[k] = idx;
        points.push(row);
        return idx;
    }

    function addEdge(a, b) {
        if (a < 0 || b < 0 || a === b) return;
        connections.push([a, b]);
    }

    const wps = Array.isArray(waypoints) ? waypoints : [];
    for (let i = 0; i < wps.length; i++) {
        const idx = addPoint(wps[i], { waypoint: true });
        if (i > 0) {
            const prev = addPoint(wps[i - 1], { waypoint: true });
            if (
                String(wps[i - 1].z) === String(wps[i].z) &&
                prev >= 0 &&
                idx >= 0
            ) {
                addEdge(prev, idx);
            }
        }
    }

    const links = Array.isArray(stairLinks) ? stairLinks : [];
    for (let i = 0; i < links.length; i++) {
        const L = links[i];
        if (!L || !L.from || !L.to) continue;
        const a = addPoint(L.from, { stair: 'down' });
        const b = addPoint(L.to, { stair: 'up' });
        addEdge(a, b);
    }

    return {
        id: 'generated_multifloor',
        points,
        connections,
        meta: { reason: 'spine_fallback', anchorCount: points.length }
    };
}

/**
 * Merge single-floor generation results into multi-floor hunt payload fields.
 *
 * @param {object[]} floorGens [{ entry, gen, stairs }]
 * @param {{ from: object, to: object, link: string|null }[]} stairLinks
 * @returns {object}
 */
function mergeFloorResults(floorGens, stairLinks) {
    /** @type {Record<string, { cols: number, rows: number, friction: Uint8Array }>} */
    const floorLayers = Object.create(null);
    /** @type {(number|string)[]} */
    const floors = [];
    /** @type {object[]} */
    const waypoints = [];
    /** @type {object[]} */
    const populationSlots = [];
    /** @type {object[]} */
    const markerSockets = [];
    /** @type {object[]} */
    const allStairs = [];
    /** @type {object[]} */
    const floorMeta = [];
    let totalPieces = 0;
    let totalWalkable = 0;

    for (let i = 0; i < floorGens.length; i++) {
        const row = floorGens[i];
        const entry = row.entry;
        const gen = row.gen;
        const z = entry.z;
        floors.push(z);
        floorLayers[String(z)] = {
            cols: gen.cols,
            rows: gen.rows,
            friction: gen.friction
        };
        totalPieces +=
            (gen.meta && gen.meta.pieceCount) ||
            (gen.placements && gen.placements.length) ||
            0;
        if (gen.validation && gen.validation.walkable != null) {
            totalWalkable += gen.validation.walkable;
        }

        // Waypoints: full spine per floor; stair hop inserted between floors
        const spine = Array.isArray(gen.waypoints) ? gen.waypoints : [];
        for (let w = 0; w < spine.length; w++) {
            const p = spine[w];
            waypoints.push({
                x: p.x,
                y: p.y,
                z: p.z != null ? p.z : z
            });
        }

        // After this floor's spine, if there is a stair down to next floor,
        // ensure down-stair then up-stair appear as consecutive waypoints.
        if (i + 1 < floorGens.length) {
            const link = stairLinks.find(
                (L) => L && String(L.from.z) === String(z)
            );
            if (link) {
                const last = waypoints[waypoints.length - 1];
                if (
                    !last ||
                    last.x !== link.from.x ||
                    last.y !== link.from.y ||
                    String(last.z) !== String(link.from.z)
                ) {
                    waypoints.push({
                        x: link.from.x,
                        y: link.from.y,
                        z: link.from.z
                    });
                }
                waypoints.push({
                    x: link.to.x,
                    y: link.to.y,
                    z: link.to.z
                });
            }
        }

        const spawns = (gen.sockets && gen.sockets.spawns) || [];
        for (let s = 0; s < spawns.length; s++) {
            const p = spawns[s];
            populationSlots.push({
                x: p.x,
                y: p.y,
                z: p.z != null ? p.z : z
            });
        }
        // Fixed layouts may put slots on populationSlots
        if (Array.isArray(gen.populationSlots)) {
            for (let s = 0; s < gen.populationSlots.length; s++) {
                const p = gen.populationSlots[s];
                populationSlots.push({
                    x: p.x,
                    y: p.y,
                    z: p.z != null ? p.z : z,
                    cutoutId: p.cutoutId,
                    eventId: p.eventId
                });
            }
        }

        const markers =
            (gen.sockets && gen.sockets.markers) ||
            gen.markerSockets ||
            [];
        for (let m = 0; m < markers.length; m++) {
            const p = markers[m];
            markerSockets.push({
                id: p.id != null ? p.id : 'A',
                x: p.x,
                y: p.y,
                z: p.z != null ? p.z : z
            });
        }

        for (let s = 0; s < row.stairs.length; s++) {
            allStairs.push(row.stairs[s]);
        }

        floorMeta.push({
            z,
            profileId: gen.profileId || entry.profileId,
            cols: gen.cols,
            rows: gen.rows,
            pieceCount:
                (gen.meta && gen.meta.pieceCount) ||
                (gen.placements && gen.placements.length) ||
                0,
            artSet: entry.artSet,
            biomeId: entry.biomeId || null,
            populationId: entry.populationId || null,
            markersId: entry.markersId || null,
            piecePack: entry.piecePack || null,
            role: entry.role,
            macroTransition: !!entry.macroTransition,
            validation: gen.validation
                ? { ok: gen.validation.ok, walkable: gen.validation.walkable }
                : null
        });
    }

    // Dedupe consecutive identical waypoints (stair hop may re-add entrance)
    {
        /** @type {object[]} */
        const cleaned = [];
        for (let i = 0; i < waypoints.length; i++) {
            const w = waypoints[i];
            const prev = cleaned[cleaned.length - 1];
            if (
                prev &&
                prev.x === w.x &&
                prev.y === w.y &&
                String(prev.z) === String(w.z)
            ) {
                continue;
            }
            cleaned.push(w);
        }
        waypoints.length = 0;
        for (let i = 0; i < cleaned.length; i++) waypoints.push(cleaned[i]);
    }

    // Per-floor sockets for richer nav bake (spawns + stairs + waypoints)
    /** @type {Record<string, object>} */
    const socketsByFloor = Object.create(null);
    for (let i = 0; i < floorGens.length; i++) {
        const row = floorGens[i];
        const z = row.entry.z;
        const zk = String(z);
        const gen = row.gen;
        const rawSock =
            gen.sockets && typeof gen.sockets === 'object' ? gen.sockets : null;
        socketsByFloor[zk] = {
            waypoints: (rawSock && rawSock.waypoints
                ? rawSock.waypoints
                : waypoints.filter((w) => w && String(w.z) === zk)
            ).map((w) =>
                Object.assign({}, w, { z: w.z != null ? w.z : z })
            ),
            spawns: (rawSock && rawSock.spawns
                ? rawSock.spawns
                : populationSlots.filter((s) => s && String(s.z) === zk)
            ).map((s) =>
                Object.assign({}, s, { z: s.z != null ? s.z : z })
            ),
            markers: (rawSock && rawSock.markers
                ? rawSock.markers
                : markerSockets.filter((m) => m && String(m.z) === zk)
            ).map((m) =>
                Object.assign({}, m, { z: m.z != null ? m.z : z })
            ),
            stairs: (row.stairs || []).map((s) =>
                Object.assign({}, s, { z: s.z != null ? s.z : z })
            )
        };
    }

    const firstZ = floors.length ? floors[0] : 0;
    const firstLayer = floorLayers[String(firstZ)];

    return {
        floors,
        floorLayers,
        floorFriction: firstLayer
            ? {
                  z: firstZ,
                  cols: firstLayer.cols,
                  rows: firstLayer.rows,
                  friction: firstLayer.friction
              }
            : null,
        waypoints,
        populationSlots,
        markerSockets,
        stairs: allStairs,
        stairLinks,
        navmesh: buildMultiFloorNavmesh(waypoints, stairLinks, {
            floorLayers,
            socketsByFloor,
            includeSpawns: true
        }),
        floorMeta,
        totalPieces,
        totalWalkable
    };
}

/**
 * Generate one floor entry (procedural or fixed).
 *
 * @param {object} entry normalized floor entry
 * @param {object} pack normalized piece pack
 * @param {object} profileRaw raw profile
 * @param {number} seed
 * @param {object} [opts]
 * @returns {object} generate result
 */
function generateOneFloor(entry, pack, profileRaw, seed, opts) {
    const o = opts || {};
    const typeHint =
        entry.type ||
        detectFloorLayoutType(profileRaw) ||
        'procedural';
    const t = String(typeHint).toLowerCase();
    const isFixed =
        t === 'fixed' ||
        t === 'fixed_cutout' ||
        t === 'fixed+cutouts' ||
        t === 'cutout' ||
        t === 'cutouts';

    if (isFixed) {
        return generateFixedLayout({
            profile: profileRaw,
            pack,
            seed,
            floor: entry.z,
            z: entry.z,
            loadPopulation: o.loadPopulation
        });
    }

    const program = normalizeDungeonProfile(profileRaw) || profileRaw;
    return generateProceduralLayout({
        profile: Object.assign({}, profileRaw, program),
        pack,
        seed,
        floor: entry.z,
        z: entry.z,
        maxAttempts:
            entry.maxAttempts != null
                ? entry.maxAttempts
                : program && program.maxAttempts
    });
}

/**
 * Generate a multi-floor dungeon from a floor chain.
 *
 * @param {{
 *   floors: object[],
 *   seed?: number,
 *   loadDungeonProfile?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   normalizePiecePack?: (raw: object) => object|null,
 *   loadPopulation?: (id: string) => object,
 *   defaultPiecePack?: string|null,
 *   defaultArtSet?: string|null
 * }} opts
 * @returns {object}
 */
function generateMultiFloorLayout(opts) {
    const o = opts || {};
    const seed = o.seed != null ? o.seed >>> 0 || 1 : 1;
    const chain = normalizeFloorChain(o.floors);
    if (!chain || chain.length < 1) {
        return {
            ok: false,
            seed,
            error: {
                code: 'invalid_floors',
                message: 'Multi-floor layout needs floors[] with ≥1 entry'
            }
        };
    }

    const normPack =
        typeof o.normalizePiecePack === 'function'
            ? o.normalizePiecePack
            : normalizePiecePack;

    /** @type {{ entry: object, gen: object, stairs: object[] }[]} */
    const floorGens = [];

    for (let i = 0; i < chain.length; i++) {
        const entry = chain[i];
        let profileRaw = entry.profile;
        if (!profileRaw && entry.profileId && typeof o.loadDungeonProfile === 'function') {
            try {
                profileRaw = o.loadDungeonProfile(entry.profileId);
            } catch (_e) {
                profileRaw = null;
            }
        }
        if (!profileRaw) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'missing_profile',
                    message: `Floor ${entry.z}: missing profile ${entry.profileId || '(inline)'}`
                },
                floorIndex: i
            };
        }

        const packId =
            entry.piecePack ||
            profileRaw.piecePack ||
            o.defaultPiecePack ||
            null;
        let packRaw = null;
        if (packId && typeof o.loadPiecePack === 'function') {
            try {
                packRaw = o.loadPiecePack(packId);
            } catch (_e) {
                packRaw = null;
            }
        }
        const pack = packRaw ? normPack(packRaw) : null;
        if (!pack) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'missing_piece_pack',
                    message: `Floor ${entry.z}: piece pack not found: ${packId || '(none)'}`
                },
                floorIndex: i
            };
        }

        // Inherit artSet from default when floor omits it
        if (!entry.artSet && o.defaultArtSet) {
            entry.artSet = o.defaultArtSet;
        }

        const fSeed = floorSeed(seed, i);
        const gen = generateOneFloor(entry, pack, profileRaw, fSeed, {
            loadPopulation: o.loadPopulation
        });
        if (!gen.ok) {
            return {
                ok: false,
                seed,
                error: gen.error || {
                    code: 'generate_failed',
                    message: `Floor ${entry.z} generation failed`
                },
                floorIndex: i,
                attempts: gen.attempts
            };
        }

        const needDown = i + 1 < chain.length;
        const needUp = i > 0;
        const stairs = ensureStairs(gen, entry.z, {
            needDown,
            needUp,
            link: `f${i}_${i + 1}`
        });

        floorGens.push({ entry, gen, stairs });
    }

    // Pair consecutive floors
    /** @type {{ from: object, to: object, link: string|null }[]} */
    const stairLinks = [];
    for (let i = 0; i + 1 < floorGens.length; i++) {
        const upper = floorGens[i];
        const lower = floorGens[i + 1];
        const pairs = pairStairLinks(upper.stairs, lower.stairs);
        if (!pairs.length) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'stair_pair_failed',
                    message: `No stair link between z=${upper.entry.z} and z=${lower.entry.z}`
                },
                floorIndex: i
            };
        }
        for (let p = 0; p < pairs.length; p++) {
            stairLinks.push(pairs[p]);
        }
    }

    const merged = mergeFloorResults(floorGens, stairLinks);

    return {
        ok: true,
        seed,
        type: 'multifloor',
        floors: merged.floors,
        floorLayers: merged.floorLayers,
        floorFriction: merged.floorFriction,
        waypoints: merged.waypoints,
        populationSlots: merged.populationSlots,
        markerSockets: merged.markerSockets,
        stairs: merged.stairs,
        stairLinks: merged.stairLinks,
        navmesh: merged.navmesh,
        floorMeta: merged.floorMeta,
        sockets: {
            spawns: merged.populationSlots,
            markers: merged.markerSockets,
            waypoints: merged.waypoints,
            stairs: merged.stairs
        },
        meta: {
            type: 'multifloor',
            floorCount: floorGens.length,
            pieceCount: merged.totalPieces,
            walkable: merged.totalWalkable,
            stairLinkCount: stairLinks.length,
            reason: 'ok'
        },
        validation: {
            ok: floorGens.every(
                (r) => !r.gen.validation || r.gen.validation.ok
            ),
            floors: floorGens.map((r) => ({
                z: r.entry.z,
                ok: !r.gen.validation || r.gen.validation.ok
            }))
        }
    };
}

/**
 * Apply multi-floor generation onto a hunt object.
 *
 * @param {object} hunt
 * @param {object} gen generateMultiFloorLayout result
 * @param {number} seed
 * @param {object} [chainMeta]
 * @returns {object}
 */
function applyMultiFloorToHunt(hunt, gen, seed, chainMeta) {
    const out = Object.assign({}, hunt);
    const firstZ = gen.floors && gen.floors.length ? gen.floors[0] : 0;
    out.floor = firstZ;
    out.floors = gen.floors.slice();
    out.floorLayers = gen.floorLayers;
    out.floorFriction = gen.floorFriction;
    delete out.mapPath;
    delete out.mapPaths;

    // Route is owned by the multi-floor generator (not the hunt JSON).
    out.waypoints = (gen.waypoints || []).map((w) => ({
        x: w.x,
        y: w.y,
        z: w.z
    }));

    if (!Array.isArray(out.populationSlots) || !out.populationSlots.length) {
        out.populationSlots = (gen.populationSlots || []).map((s) => ({
            x: s.x,
            y: s.y,
            z: s.z
        }));
    }

    if (!Array.isArray(out.markerSockets) || !out.markerSockets.length) {
        out.markerSockets = (gen.markerSockets || []).map((m) => ({
            id: m.id != null ? m.id : 'A',
            x: m.x,
            y: m.y,
            z: m.z
        }));
    }

    out.stairLinks = (gen.stairLinks || []).map((L) => ({
        from: { x: L.from.x, y: L.from.y, z: L.from.z },
        to: { x: L.to.x, y: L.to.y, z: L.to.z },
        link: L.link
    }));
    out.stairs = (gen.stairs || []).slice();
    out.navmeshData = gen.navmesh || null;

    const cm = chainMeta || {};
    // Inherit content pointers from chain meta or first floor profile
    const firstMeta =
        gen.floorMeta && gen.floorMeta.length ? gen.floorMeta[0] : null;
    if (!out.populationId && !out.population) {
        if (cm.populationId) {
            out.populationId = cm.populationId;
        } else if (cm.profilePopulationId) {
            out.populationId = cm.profilePopulationId;
        }
    }
    if (!out.markersId && !out.markerRules && !out.markers) {
        if (cm.markersId) {
            out.markersId = cm.markersId;
        } else if (cm.profileMarkersId) {
            out.markersId = cm.profileMarkersId;
        }
    }
    if (!out.pacingBudget && cm.pacingBudget) {
        out.pacingBudget = cm.pacingBudget;
    }
    if (!out.artSet && cm.artSet) {
        out.artSet = cm.artSet;
    }

    out.layoutMeta = {
        reason: 'ok',
        type: 'multifloor',
        seed,
        floorCount: gen.floors.length,
        floors: gen.floors.slice(),
        floorMeta: gen.floorMeta,
        stairLinkCount: (gen.stairLinks && gen.stairLinks.length) || 0,
        pieceCount: gen.meta && gen.meta.pieceCount,
        artSet: cm.artSet || (firstMeta && firstMeta.artSet) || null,
        validation: gen.validation
    };
    delete out.layoutSkipped;
    delete out.layoutError;
    return out;
}

/**
 * Expand hunt.layout multifloor → floorLayers, stairs, nav edges.
 *
 * @param {object} hunt
 * @param {object} [opts] same loaders as resolveHuntLayout
 * @returns {object}
 */
function resolveMultiFloorHuntLayout(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    const layout = hunt.layout;
    if (!layout || typeof layout !== 'object') return hunt;

    // Already expanded
    if (
        hunt.layoutMeta &&
        hunt.layoutMeta.reason === 'ok' &&
        hunt.layoutMeta.type === 'multifloor' &&
        hunt.floorLayers
    ) {
        return hunt;
    }

    const o = opts || {};
    const seed =
        o.seed != null
            ? o.seed >>> 0 || 1
            : hunt.seed != null
              ? hunt.seed >>> 0 || 1
              : 1;

    let floorsRaw = null;
    if (Array.isArray(layout.floors) && layout.floors.length) {
        floorsRaw = layout.floors;
    } else if (Array.isArray(hunt.biomeFloors) && hunt.biomeFloors.length) {
        floorsRaw = hunt.biomeFloors;
    }

    // Optional: pull floors from biome pack
    let defaultArtSet =
        layout.artSet != null
            ? String(layout.artSet)
            : hunt.artSet != null
              ? String(hunt.artSet)
              : null;
    let defaultPiecePack =
        layout.piecePack != null ? String(layout.piecePack) : null;
    let populationId =
        layout.populationId != null
            ? String(layout.populationId)
            : hunt.populationId != null
              ? String(hunt.populationId)
              : null;
    let markersId =
        layout.markersId != null
            ? String(layout.markersId)
            : hunt.markersId != null
              ? String(hunt.markersId)
              : null;

    if (
        !floorsRaw &&
        (layout.biomeId || layout.biome) &&
        typeof o.loadBiomePack === 'function'
    ) {
        const bid = String(layout.biomeId || layout.biome);
        try {
            const biome = o.loadBiomePack(bid);
            if (biome) {
                if (Array.isArray(biome.floors) && biome.floors.length) {
                    floorsRaw = biome.floors;
                }
                if (!defaultArtSet && biome.artSet) {
                    defaultArtSet = String(biome.artSet);
                }
                if (!defaultPiecePack && biome.piecePack) {
                    defaultPiecePack = String(biome.piecePack);
                }
                if (!populationId && biome.populationId) {
                    populationId = String(biome.populationId);
                }
                if (!markersId && biome.markersId) {
                    markersId = String(biome.markersId);
                }
            }
        } catch (_e) {
            /* biome missing */
        }
    }

    if (!floorsRaw || !floorsRaw.length) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = 'missing_floors';
        out.layoutError = {
            code: 'missing_floors',
            message:
                'Multi-floor layout needs layout.floors[] or biome.floors'
        };
        return out;
    }

    const gen = generateMultiFloorLayout({
        floors: floorsRaw,
        seed,
        loadDungeonProfile: o.loadDungeonProfile,
        loadPiecePack: o.loadPiecePack,
        normalizePiecePack: o.normalizePiecePack,
        loadPopulation: o.loadPopulation,
        defaultPiecePack,
        defaultArtSet
    });

    if (!gen.ok) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = gen.error ? gen.error.code : 'generate_failed';
        out.layoutError = gen.error || {
            code: 'generate_failed',
            message: 'Multi-floor generation failed'
        };
        out.layoutMeta = {
            reason: 'failed',
            type: 'multifloor',
            seed,
            floorIndex: gen.floorIndex
        };
        return out;
    }

    // Pull population/markers from first floor profile when hunt omits them
    let profilePopulationId = populationId;
    let profileMarkersId = markersId;
    let profilePacing = layout.pacingBudget || null;
    if (gen.floorMeta && gen.floorMeta.length && typeof o.loadDungeonProfile === 'function') {
        const pid = gen.floorMeta[0].profileId;
        if (pid) {
            try {
                const pr = o.loadDungeonProfile(pid);
                if (pr) {
                    if (!profilePopulationId && pr.populationId) {
                        profilePopulationId = String(pr.populationId);
                    }
                    if (!profileMarkersId && pr.markersId) {
                        profileMarkersId = String(pr.markersId);
                    }
                    if (!profilePacing && pr.pacingBudget) {
                        profilePacing = pr.pacingBudget;
                    }
                }
            } catch (_e) {
                /* optional */
            }
        }
    }

    return applyMultiFloorToHunt(hunt, gen, seed, {
        populationId: profilePopulationId,
        markersId: profileMarkersId,
        profilePopulationId,
        profileMarkersId,
        artSet: defaultArtSet,
        pacingBudget: profilePacing
    });
}

module.exports = {
    MULTIFLOOR_SEED_SALT,
    floorSeed,
    normalizeFloorEntry,
    normalizeFloorChain,
    synthesizeStair,
    ensureStairs,
    pairStairLinks,
    buildMultiFloorNavmesh,
    generateMultiFloorLayout,
    applyMultiFloorToHunt,
    resolveMultiFloorHuntLayout
};
