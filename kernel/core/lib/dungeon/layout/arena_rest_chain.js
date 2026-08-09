/**
 * Arena ↔ rest chain layout (selective portals, per-floor routes).
 *
 * Independent fixed floors (no stock multifloor stair pairing). Product
 * deathPortal mode emits only rest→next-arena links; debug mode also emits
 * resolve-time arena→rest exits. First-class resolve branch must run before
 * multi_biome / multifloor so alternating artSets never hijack macro expand.
 */

'use strict';

const { createSeededRandom } = require('../../utils.js');
const {
    normalizePiecePack,
    FRICTION_BLOCKED
} = require('../pieces.js');
const { generateFixedLayout } = require('./fixed.js');
const { floorSeed } = require('./multifloor.js');

/** Salt so piece pick + arena floors diverge from other layout streams. */
const ARENA_REST_SALT = 0x41525354; // "ARST"

/** Hard cap on pre-generated arenas (abuse / memory). */
const MAX_ARENAS_CAP = 8;

/**
 * Deterministic index from seed + role + ordinal.
 * @param {number} seed
 * @param {string} role
 * @param {number} index
 * @returns {number}
 */
function seededIndex(seed, role, index) {
    let h = ((seed >>> 0) ^ ARENA_REST_SALT) >>> 0;
    const s = String(role || '');
    for (let i = 0; i < s.length; i++) {
        h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
    }
    h = (h + ((Math.floor(Number(index) || 0) + 1) * 0x9e3779b9)) >>> 0;
    return h || 1;
}

/**
 * Axis-aligned bbox of walkable friction cells; optional 1-cell inset.
 * @param {Uint8Array|number[]} friction
 * @param {number} cols
 * @param {number} rows
 * @param {number|string} z
 * @returns {{ x: number, y: number, w: number, h: number, z: * }}
 */
function walkableAabb(friction, cols, rows, z) {
    const c = Math.max(0, Math.floor(Number(cols) || 0));
    const r = Math.max(0, Math.floor(Number(rows) || 0));
    let minX = c;
    let minY = r;
    let maxX = -1;
    let maxY = -1;
    if (friction && c > 0 && r > 0) {
        for (let y = 0; y < r; y++) {
            for (let x = 0; x < c; x++) {
                if (friction[y * c + x] === FRICTION_BLOCKED) continue;
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < minX || maxY < minY) {
        return {
            x: 0,
            y: 0,
            w: Math.max(1, c),
            h: Math.max(1, r),
            z
        };
    }
    // Optional inset 1 when the shrunk box remains valid
    let x0 = minX;
    let y0 = minY;
    let x1 = maxX;
    let y1 = maxY;
    if (x1 - x0 >= 2 && y1 - y0 >= 2) {
        x0 += 1;
        y0 += 1;
        x1 -= 1;
        y1 -= 1;
    }
    return {
        x: x0,
        y: y0,
        w: x1 - x0 + 1,
        h: y1 - y0 + 1,
        z
    };
}

/**
 * Normalize arenaLoop authoring block.
 * @param {object|null|undefined} raw
 * @returns {object}
 */
function normalizeArenaLoop(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    let maxArenas = Math.floor(Number(r.maxArenas != null ? r.maxArenas : 2));
    if (!Number.isFinite(maxArenas) || maxArenas < 1) maxArenas = 1;
    if (maxArenas > MAX_ARENAS_CAP) maxArenas = MAX_ARENAS_CAP;

    let wavesPerArena = Math.floor(
        Number(r.wavesPerArena != null ? r.wavesPerArena : 1)
    );
    if (!Number.isFinite(wavesPerArena) || wavesPerArena < 1) wavesPerArena = 1;

    const artSets = Array.isArray(r.artSets)
        ? r.artSets.map((a) => String(a)).filter(Boolean)
        : [];
    const resolvedArtSets = artSets.length
        ? artSets
        : ['cave_simple', 'ice_simple'];

    return {
        enabled: r.enabled !== false,
        wavesPerArena,
        maxArenas,
        artSets: resolvedArtSets,
        restArtSet:
            r.restArtSet != null && r.restArtSet !== ''
                ? String(r.restArtSet)
                : null,
        arenaProfileId:
            r.arenaProfileId != null
                ? String(r.arenaProfileId)
                : 'arena_combat_shell',
        restProfileId:
            r.restProfileId != null
                ? String(r.restProfileId)
                : 'rest_area_shell',
        arenaPackId:
            r.arenaPackId != null
                ? String(r.arenaPackId)
                : r.arenaPiecePack != null
                  ? String(r.arenaPiecePack)
                  : null,
        restPackId:
            r.restPackId != null
                ? String(r.restPackId)
                : r.restPiecePack != null
                  ? String(r.restPiecePack)
                  : null,
        portalNearRadius: Math.max(
            0,
            Math.floor(
                Number(r.portalNearRadius != null ? r.portalNearRadius : 2) || 0
            )
        ),
        /** Product default true: no resolve-time arena exits. false = debug hybrid. */
        deathPortal: r.deathPortal !== false,
        oneWayDeathPortal: r.oneWayDeathPortal !== false,
        pauseCombatUntilPortal: r.pauseCombatUntilPortal !== false
    };
}

/**
 * Pick first stair socket with dir down (prefer) or up, stamped with z.
 * @param {object} gen generateFixedLayout result
 * @param {number|string} z
 * @returns {{ x: number, y: number, z: *, dir: string, link: string|null }|null}
 */
function pickPortalSocket(gen, z) {
    const stairs =
        (gen && gen.sockets && Array.isArray(gen.sockets.stairs)
            ? gen.sockets.stairs
            : null) ||
        (gen && Array.isArray(gen.stairs) ? gen.stairs : null) ||
        [];
    let fallback = null;
    for (let i = 0; i < stairs.length; i++) {
        const s = stairs[i];
        if (!s || s.x == null || s.y == null) continue;
        const dir = String(s.dir || '').toLowerCase();
        // Force floor z: fixed/stitch piece sockets often keep piece-local z=0.
        const pt = {
            x: Math.floor(Number(s.x)),
            y: Math.floor(Number(s.y)),
            z,
            dir: dir || 'down',
            link: s.link != null ? String(s.link) : null
        };
        if (dir === 'down') return pt;
        if (!fallback) fallback = pt;
    }
    return fallback;
}

/**
 * Local waypoints stamped with floor z (ignore piece-local z=0).
 * @param {object} gen
 * @param {number|string} z
 * @returns {{ x: number, y: number, z: * }[]}
 */
function localWaypoints(gen, z) {
    const raw = Array.isArray(gen.waypoints) ? gen.waypoints : [];
    return raw.map((w) => ({
        x: w.x,
        y: w.y,
        z
    }));
}

/**
 * Entrance point for a generated floor; always stamped with floor z.
 * @param {object} gen
 * @param {number|string} z
 * @param {{ x: number, y: number, z: * }[]} wps
 * @returns {{ x: number, y: number, z: * }}
 */
function floorEntrance(gen, z, wps) {
    if (gen && gen.entrance && gen.entrance.x != null && gen.entrance.y != null) {
        return {
            x: Math.floor(Number(gen.entrance.x)),
            y: Math.floor(Number(gen.entrance.y)),
            z
        };
    }
    if (wps && wps.length) {
        return { x: wps[0].x, y: wps[0].y, z };
    }
    return { x: 1, y: 1, z };
}

/**
 * Load + normalize piece pack.
 * @param {string|null} packId
 * @param {object} o opts with loaders
 * @returns {object|null}
 */
function loadNormPack(packId, o) {
    if (!packId || typeof o.loadPiecePack !== 'function') return null;
    let packRaw = null;
    try {
        packRaw = o.loadPiecePack(packId);
    } catch (_e) {
        packRaw = null;
    }
    if (!packRaw) return null;
    const norm =
        typeof o.normalizePiecePack === 'function'
            ? o.normalizePiecePack
            : normalizePiecePack;
    return norm(packRaw);
}

/**
 * Load dungeon shell profile (fixed).
 * @param {string} profileId
 * @param {object} o
 * @returns {object|null}
 */
function loadShell(profileId, o) {
    if (!profileId || typeof o.loadDungeonProfile !== 'function') return null;
    try {
        return o.loadDungeonProfile(profileId);
    } catch (_e) {
        return null;
    }
}

/**
 * Seeded piece id from pack.
 * @param {object} pack normalized
 * @param {number} seed
 * @param {string} role
 * @param {number} index
 * @returns {string|null}
 */
function pickPieceId(pack, seed, role, index) {
    if (!pack || !Array.isArray(pack.pieces) || !pack.pieces.length) return null;
    const n = pack.pieces.length;
    const idx = seededIndex(seed, role, index) % n;
    const p = pack.pieces[idx];
    return p && p.id != null ? String(p.id) : null;
}

/**
 * Generate one fixed floor via shell + seeded piece pick.
 * Live fixed API keys only: { profile, pack, seed, z }.
 *
 * @param {{
 *   shell: object,
 *   pack: object,
 *   packId: string,
 *   pieceId: string,
 *   seed: number,
 *   z: number|string
 * }} args
 * @returns {object} generateFixedLayout result
 */
function generateShellFloor(args) {
    const a = args || {};
    const shell = a.shell && typeof a.shell === 'object' ? a.shell : {};
    const profile = Object.assign({}, shell, {
        type: 'fixed',
        piecePack: a.packId || shell.piecePack || null,
        populationId: null,
        placements: [{ pieceId: a.pieceId, x: 0, y: 0 }]
    });
    // Shells omit entrance/exit/waypoints so piece sockets drive the spine
    delete profile.entrance;
    delete profile.exit;
    delete profile.waypoints;
    return generateFixedLayout({
        profile,
        pack: a.pack,
        seed: a.seed,
        z: a.z
    });
}

/**
 * Generate arena_rest_chain floors with selective stairLinks.
 *
 * @param {{
 *   seed?: number,
 *   arenaLoop?: object,
 *   loadDungeonProfile?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   normalizePiecePack?: (raw: object) => object|null
 * }} opts
 * @returns {object}
 */
function generateArenaRestChain(opts) {
    const o = opts || {};
    const seed = o.seed != null ? o.seed >>> 0 || 1 : 1;
    const loop = normalizeArenaLoop(o.arenaLoop);

    const maxArenas = loop.maxArenas;
    if (maxArenas < 1) {
        return {
            ok: false,
            seed,
            error: {
                code: 'invalid_max_arenas',
                message: 'maxArenas must be ≥ 1'
            }
        };
    }

    const arenaShell = loadShell(loop.arenaProfileId, o);
    const restShell = loadShell(loop.restProfileId, o);
    if (!arenaShell) {
        return {
            ok: false,
            seed,
            error: {
                code: 'missing_profile',
                message: `Arena shell not found: ${loop.arenaProfileId}`
            }
        };
    }
    if (!restShell && maxArenas > 1) {
        return {
            ok: false,
            seed,
            error: {
                code: 'missing_profile',
                message: `Rest shell not found: ${loop.restProfileId}`
            }
        };
    }

    const arenaPackId =
        loop.arenaPackId ||
        (arenaShell.piecePack != null ? String(arenaShell.piecePack) : null) ||
        'arena_combat_v1';
    const restPackId =
        loop.restPackId ||
        (restShell && restShell.piecePack != null
            ? String(restShell.piecePack)
            : null) ||
        'rest_area_v1';

    const arenaPack = loadNormPack(arenaPackId, o);
    if (!arenaPack || !arenaPack.pieces || !arenaPack.pieces.length) {
        return {
            ok: false,
            seed,
            error: {
                code: 'missing_piece_pack',
                message: `Arena piece pack not found: ${arenaPackId}`
            }
        };
    }
    let restPack = null;
    if (maxArenas > 1) {
        restPack = loadNormPack(restPackId, o);
        if (!restPack || !restPack.pieces || !restPack.pieces.length) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'missing_piece_pack',
                    message: `Rest piece pack not found: ${restPackId}`
                }
            };
        }
    }

    /** @type {Record<string, { cols: number, rows: number, friction: Uint8Array }>} */
    const floorLayers = Object.create(null);
    /** @type {(number|string)[]} */
    const floors = [];
    /** @type {object[]} */
    const floorMeta = [];
    /** @type {Record<string, object[]>} */
    const perFloorWaypoints = Object.create(null);
    /** @type {object[]} */
    const populationSlots = [];
    /** @type {object[]} */
    const markerSockets = [];
    /** @type {object[]} */
    const allStairs = [];

    /** Arena rows: { z, arenaIndex, artSet, entrance, waypoints, metaIndex } */
    const arenas = [];
    /** Rest rows: { z, arenaIndex, artSet, entrance, portalSocket, waypoints, metaIndex } */
    const rests = [];

    let z = 0;
    let totalPieces = 0;

    for (let arenaIndex = 0; arenaIndex < maxArenas; arenaIndex++) {
        const artSet = loop.artSets[arenaIndex % loop.artSets.length];
        const pieceId = pickPieceId(arenaPack, seed, 'arena', arenaIndex);
        if (!pieceId) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'no_piece',
                    message: `No arena piece for index ${arenaIndex}`
                }
            };
        }
        const fSeed = floorSeed(seed, z);
        const gen = generateShellFloor({
            shell: arenaShell,
            pack: arenaPack,
            packId: arenaPackId,
            pieceId,
            seed: fSeed,
            z
        });
        if (!gen.ok) {
            return {
                ok: false,
                seed,
                error: gen.error || {
                    code: 'generate_failed',
                    message: `Arena ${arenaIndex} (z=${z}) generation failed`
                },
                floorIndex: z
            };
        }

        const wps = localWaypoints(gen, z);
        const entrance = floorEntrance(gen, z, wps);
        const spawnBounds = walkableAabb(gen.friction, gen.cols, gen.rows, z);

        floors.push(z);
        floorLayers[String(z)] = {
            cols: gen.cols,
            rows: gen.rows,
            friction: gen.friction,
            sight: gen.sight || null,
            flags: gen.flags || null
        };
        perFloorWaypoints[String(z)] = wps.slice();
        totalPieces +=
            (gen.meta && gen.meta.pieceCount) ||
            (gen.placements && gen.placements.length) ||
            1;

        const sockSpawns = (gen.sockets && gen.sockets.spawns) || [];
        for (let s = 0; s < sockSpawns.length; s++) {
            const p = sockSpawns[s];
            populationSlots.push({
                x: p.x,
                y: p.y,
                z: p.z != null ? p.z : z
            });
        }
        const sockMarkers = (gen.sockets && gen.sockets.markers) || [];
        for (let m = 0; m < sockMarkers.length; m++) {
            const p = sockMarkers[m];
            markerSockets.push({
                id: p.id != null ? p.id : 'A',
                x: p.x,
                y: p.y,
                z: p.z != null ? p.z : z
            });
        }

        const meta = {
            z,
            role: 'arena',
            arenaIndex,
            artSet,
            biomeId:
                arenaShell.biome != null
                    ? String(arenaShell.biome)
                    : null,
            profileId: loop.arenaProfileId,
            pieceId,
            piecePack: arenaPackId,
            spawnBounds,
            entrance: Object.assign({}, entrance),
            portalSocket: null,
            waypoints: wps.slice(),
            cols: gen.cols,
            rows: gen.rows
        };
        floorMeta.push(meta);
        arenas.push({
            z,
            arenaIndex,
            artSet,
            entrance: Object.assign({}, entrance),
            waypoints: wps.slice(),
            metaIndex: floorMeta.length - 1
        });
        z += 1;

        if (arenaIndex >= maxArenas - 1) break;

        // Rest floor between this arena and the next
        const restArt =
            loop.restArtSet != null ? loop.restArtSet : artSet;
        const restPieceId = pickPieceId(restPack, seed, 'rest', arenaIndex);
        if (!restPieceId) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'no_piece',
                    message: `No rest piece for arenaIndex ${arenaIndex}`
                }
            };
        }
        const rSeed = floorSeed(seed, z);
        const genR = generateShellFloor({
            shell: restShell,
            pack: restPack,
            packId: restPackId,
            pieceId: restPieceId,
            seed: rSeed,
            z
        });
        if (!genR.ok) {
            return {
                ok: false,
                seed,
                error: genR.error || {
                    code: 'generate_failed',
                    message: `Rest ${arenaIndex} (z=${z}) generation failed`
                },
                floorIndex: z
            };
        }

        const portalSocket = pickPortalSocket(genR, z);
        if (!portalSocket) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'missing_portal_socket',
                    message: `Rest piece ${restPieceId} has no stair portal socket (dir down|up)`
                },
                floorIndex: z
            };
        }

        const rWps = localWaypoints(genR, z);
        const rEntrance = floorEntrance(genR, z, rWps);
        const rBounds = walkableAabb(genR.friction, genR.cols, genR.rows, z);

        floors.push(z);
        floorLayers[String(z)] = {
            cols: genR.cols,
            rows: genR.rows,
            friction: genR.friction,
            sight: genR.sight || null,
            flags: genR.flags || null
        };
        perFloorWaypoints[String(z)] = rWps.slice();
        totalPieces +=
            (genR.meta && genR.meta.pieceCount) ||
            (genR.placements && genR.placements.length) ||
            1;

        allStairs.push({
            x: portalSocket.x,
            y: portalSocket.y,
            z: portalSocket.z,
            dir: portalSocket.dir || 'down',
            link: portalSocket.link
        });

        const rMeta = {
            z,
            role: 'rest',
            arenaIndex,
            artSet: restArt,
            biomeId:
                restShell.biome != null ? String(restShell.biome) : null,
            profileId: loop.restProfileId,
            pieceId: restPieceId,
            piecePack: restPackId,
            spawnBounds: rBounds,
            entrance: Object.assign({}, rEntrance),
            portalSocket: {
                x: portalSocket.x,
                y: portalSocket.y,
                z: portalSocket.z
            },
            waypoints: rWps.slice(),
            cols: genR.cols,
            rows: genR.rows
        };
        floorMeta.push(rMeta);
        rests.push({
            z,
            arenaIndex,
            artSet: restArt,
            entrance: Object.assign({}, rEntrance),
            portalSocket: {
                x: portalSocket.x,
                y: portalSocket.y,
                z: portalSocket.z
            },
            waypoints: rWps.slice(),
            metaIndex: floorMeta.length - 1
        });
        z += 1;
    }

    // Selective stair pairing (never stock consecutive multifloor pairing)
    /** @type {{ from: object, to: object, link: string, dir: string }[]} */
    const stairLinks = [];
    const deathPortal = loop.deathPortal;

    for (let i = 0; i < rests.length; i++) {
        const rest = rests[i];
        const nextArena = arenas[i + 1];
        if (!nextArena) continue;

        // Always: rest portal → next arena entrance
        stairLinks.push({
            from: {
                x: rest.portalSocket.x,
                y: rest.portalSocket.y,
                z: rest.portalSocket.z
            },
            to: {
                x: nextArena.entrance.x,
                y: nextArena.entrance.y,
                z: nextArena.entrance.z
            },
            link: `portal_arena_${nextArena.arenaIndex}`,
            dir: 'down'
        });

        // Debug hybrid only: static arena → rest so PR4a can hop without death pad
        if (deathPortal === false) {
            const arena = arenas[i];
            stairLinks.push({
                from: {
                    x: arena.entrance.x,
                    y: arena.entrance.y,
                    z: arena.entrance.z
                },
                to: {
                    x: rest.entrance.x,
                    y: rest.entrance.y,
                    z: rest.entrance.z
                },
                link: `debug_portal_rest_${arena.arenaIndex}`,
                dir: 'down'
            });
        }
    }

    // Invariant asserts (branch on deathPortal)
    const expectedProduct = Math.max(0, maxArenas - 1);
    const expectedDebug = 2 * expectedProduct;
    if (deathPortal !== false) {
        if (stairLinks.length !== expectedProduct) {
            return {
                ok: false,
                seed,
                error: {
                    code: 'stair_link_count',
                    message: `deathPortal true: expected ${expectedProduct} stairLinks, got ${stairLinks.length}`
                }
            };
        }
        for (let i = 0; i < stairLinks.length; i++) {
            const fromZ = stairLinks[i].from.z;
            const fm = floorMeta.find((m) => String(m.z) === String(fromZ));
            if (fm && fm.role === 'arena') {
                return {
                    ok: false,
                    seed,
                    error: {
                        code: 'arena_origin_link',
                        message: `deathPortal true: stairLink must not originate on role=arena (z=${fromZ})`
                    }
                };
            }
        }
    } else if (stairLinks.length !== expectedDebug) {
        return {
            ok: false,
            seed,
            error: {
                code: 'stair_link_count',
                message: `deathPortal false: expected ${expectedDebug} stairLinks, got ${stairLinks.length}`
            }
        };
    }

    // Export waypoints = arena_0 only (host rebinds per phase)
    const arena0 = arenas[0];
    const waypoints = arena0 ? arena0.waypoints.slice() : [];

    const firstZ = floors.length ? floors[0] : 0;
    const firstLayer = floorLayers[String(firstZ)];

    return {
        ok: true,
        seed,
        type: 'arena_rest_chain',
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
        perFloorWaypoints,
        populationSlots,
        markerSockets,
        stairs: allStairs,
        stairLinks,
        floorMeta,
        sockets: {
            spawns: populationSlots,
            markers: markerSockets,
            waypoints,
            stairs: allStairs
        },
        meta: {
            type: 'arena_rest_chain',
            deathPortal,
            maxArenas,
            wavesPerArena: loop.wavesPerArena,
            floorCount: floors.length,
            pieceCount: totalPieces,
            stairLinkCount: stairLinks.length,
            artSets: loop.artSets.slice(),
            reason: 'ok'
        },
        arenaLoop: loop
    };
}

/**
 * Stamp waves.* from arenaLoop; fail closed on list length.
 * @param {object} hunt
 * @param {object} loop normalizeArenaLoop result
 * @returns {{ ok: true, waves: object }|{ ok: false, error: object }}
 */
function stampWavesFromArenaLoop(hunt, loop) {
    const waves =
        hunt.waves && typeof hunt.waves === 'object' && !Array.isArray(hunt.waves)
            ? Object.assign({}, hunt.waves)
            : Array.isArray(hunt.waves)
              ? { list: hunt.waves.slice() }
              : {};

    waves.wavesPerArena = loop.wavesPerArena;
    // Boundary pause is product default when pauseCombatUntilPortal is on
    waves.pauseOnArenaBoundary =
        loop.pauseCombatUntilPortal === true ||
        waves.pauseOnArenaBoundary === true;

    const list = Array.isArray(waves.list) ? waves.list : [];
    const expected = loop.wavesPerArena * loop.maxArenas;
    if (list.length > 0 && list.length !== expected) {
        return {
            ok: false,
            error: {
                code: 'waves_list_length',
                message: `waves.list length ${list.length} !== wavesPerArena(${loop.wavesPerArena}) * maxArenas(${loop.maxArenas}) = ${expected}`
            }
        };
    }

    return { ok: true, waves };
}

/**
 * Apply arena_rest_chain gen onto a hunt object.
 * @param {object} hunt
 * @param {object} gen
 * @param {number} seed
 * @param {object} loop
 * @returns {object}
 */
function applyArenaRestChainToHunt(hunt, gen, seed, loop) {
    const out = Object.assign({}, hunt);
    const firstZ = gen.floors && gen.floors.length ? gen.floors[0] : 0;
    out.floor = firstZ;
    out.floors = gen.floors.slice();
    out.floorLayers = gen.floorLayers;
    out.floorFriction = gen.floorFriction;
    delete out.mapPath;
    delete out.mapPaths;

    // Initial route = arena_0 only; host setPartyRoute per phase
    out.waypoints = (gen.waypoints || []).map((w) => ({
        x: w.x,
        y: w.y,
        z: w.z != null ? w.z : firstZ
    }));
    out.perFloorWaypoints = gen.perFloorWaypoints || Object.create(null);

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
        link: L.link,
        dir: L.dir
    }));
    out.stairs = (gen.stairs || []).slice();

    const stamp = stampWavesFromArenaLoop(out, loop);
    if (!stamp.ok) {
        out.layoutSkipped = stamp.error.code;
        out.layoutError = stamp.error;
        out.layoutMeta = {
            reason: 'failed',
            type: 'arena_rest_chain',
            seed
        };
        return out;
    }
    out.waves = stamp.waves;

    // Keep authored arenaLoop; ensure normalized flags visible
    out.arenaLoop = Object.assign({}, loop);

    if (!out.artSet && loop.artSets && loop.artSets.length) {
        out.artSet = loop.artSets[0];
    }

    out.layoutMeta = {
        reason: 'ok',
        type: 'arena_rest_chain',
        seed,
        deathPortal: loop.deathPortal,
        maxArenas: loop.maxArenas,
        wavesPerArena: loop.wavesPerArena,
        floorCount: gen.floors.length,
        floors: gen.floors.slice(),
        floorMeta: gen.floorMeta,
        stairLinkCount: (gen.stairLinks && gen.stairLinks.length) || 0,
        pieceCount: gen.meta && gen.meta.pieceCount,
        artSets: loop.artSets.slice()
    };
    delete out.layoutSkipped;
    delete out.layoutError;
    return out;
}

/**
 * Expand hunt.layout type arena_rest_chain.
 * @param {object} hunt
 * @param {object} [opts]
 * @returns {object}
 */
function resolveArenaRestChainHuntLayout(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    const layout = hunt.layout;
    if (!layout || typeof layout !== 'object') return hunt;

    if (
        hunt.layoutMeta &&
        hunt.layoutMeta.reason === 'ok' &&
        hunt.layoutMeta.type === 'arena_rest_chain' &&
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

    const loopRaw =
        (hunt.arenaLoop && typeof hunt.arenaLoop === 'object'
            ? hunt.arenaLoop
            : null) ||
        (layout.arenaLoop && typeof layout.arenaLoop === 'object'
            ? layout.arenaLoop
            : null) ||
        {};
    const loop = normalizeArenaLoop(loopRaw);

    // Fail closed before generation when list length is wrong
    const preStamp = stampWavesFromArenaLoop(hunt, loop);
    if (!preStamp.ok) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = preStamp.error.code;
        out.layoutError = preStamp.error;
        out.layoutMeta = {
            reason: 'failed',
            type: 'arena_rest_chain',
            seed
        };
        return out;
    }

    let loadDungeonProfile = o.loadDungeonProfile;
    let loadPiecePack = o.loadPiecePack;
    if (
        typeof loadDungeonProfile !== 'function' ||
        typeof loadPiecePack !== 'function'
    ) {
        try {
            const presets = require('../../presets.js');
            if (typeof loadDungeonProfile !== 'function' && presets.loadDungeonProfile) {
                loadDungeonProfile = presets.loadDungeonProfile.bind(presets);
            }
            if (typeof loadPiecePack !== 'function' && presets.loadPiecePack) {
                loadPiecePack = presets.loadPiecePack.bind(presets);
            }
        } catch (_e) {
            /* optional */
        }
    }

    const gen = generateArenaRestChain({
        seed,
        arenaLoop: loop,
        loadDungeonProfile,
        loadPiecePack,
        normalizePiecePack:
            typeof o.normalizePiecePack === 'function'
                ? o.normalizePiecePack
                : normalizePiecePack
    });

    if (!gen.ok) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = gen.error ? gen.error.code : 'generate_failed';
        out.layoutError = gen.error || {
            code: 'generate_failed',
            message: 'arena_rest_chain generation failed'
        };
        out.layoutMeta = {
            reason: 'failed',
            type: 'arena_rest_chain',
            seed,
            floorIndex: gen.floorIndex
        };
        return out;
    }

    return applyArenaRestChainToHunt(hunt, gen, seed, loop);
}

module.exports = {
    ARENA_REST_SALT,
    MAX_ARENAS_CAP,
    seededIndex,
    walkableAabb,
    normalizeArenaLoop,
    pickPortalSocket,
    floorEntrance,
    localWaypoints,
    generateArenaRestChain,
    resolveArenaRestChainHuntLayout,
    applyArenaRestChainToHunt,
    stampWavesFromArenaLoop
};
