/**
 * Stage 11.4 — Procedural layout assembler (constrained growth).
 *
 * Place hub → grow rooms/corridors by open exits → stamp exit →
 * optional event tags → stitch + validate. Failures retry under budget
 * and return structured error codes.
 */

'use strict';

const { createSeededRandom } = require('../../utils.js');
const {
    CARDINALS,
    OPPOSITE,
    canConnect,
    normalizePiecePack
} = require('../pieces.js');
const { stitch, attachOrigin } = require('../stitch.js');
const {
    RULE_OPS,
    normalizeRuleProgram,
    materializeRuleCounts,
    filterPiecesForRule,
    randInt
} = require('../rules.js');
const { validateLayout } = require('../validate.js');

/** Salt so layout RNG is independent of population/marker streams. */
const LAYOUT_SEED_SALT = 0x4c415954; // "LAYT"

/**
 * @param {number} seed
 * @returns {number}
 */
function layoutSeed(seed) {
    return ((seed >>> 0) ^ LAYOUT_SEED_SALT) >>> 0 || 1;
}

/**
 * AABB interior overlap (edge-touch allowed).
 * @returns {boolean}
 */
function boxesOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * @param {{x:number,y:number,piece:object}[]} placed
 * @param {object} piece
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function placementFits(placed, piece, x, y) {
    const w = piece.size.w;
    const h = piece.size.h;
    for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        if (
            boxesOverlap(
                x,
                y,
                w,
                h,
                p.x,
                p.y,
                p.piece.size.w,
                p.piece.size.h
            )
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Open exit slots on a placement graph.
 * @typedef {{ pi: number, dir: string }} OpenExit
 */

/**
 * Rebuild open exits from placed pieces + connections.
 * @param {object[]} placed { piece, x, y, connections: {N,S,E,W?} }
 * @returns {OpenExit[]}
 */
function collectOpenExits(placed) {
    const open = [];
    for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        const ex = p.piece.exits || {};
        const conn = p.connections || {};
        for (let d = 0; d < CARDINALS.length; d++) {
            const dir = CARDINALS[d];
            if (ex[dir] && !conn[dir]) {
                open.push({ pi: i, dir });
            }
        }
    }
    return open;
}

/**
 * @param {() => number} rng
 * @param {any[]} arr
 * @returns {any[]}
 */
function shuffleCopy(rng, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
    }
    return a;
}

/**
 * Try attach pieceB onto placed[pi] in direction dir.
 * @returns {{ x: number, y: number }|null}
 */
function tryAttach(placed, pi, dir, pieceB) {
    const parent = placed[pi];
    if (!canConnect(parent.piece, dir, pieceB)) return null;
    const origin = attachOrigin(
        parent.piece,
        parent.x,
        parent.y,
        dir,
        pieceB
    );
    if (!origin) return null;
    if (!placementFits(placed, pieceB, origin.x, origin.y)) return null;
    return origin;
}

/**
 * Commit attachment; wire mutual connections.
 * @returns {number} new placement index
 */
function commitPlacement(placed, pi, dir, pieceB, origin, role, eventId) {
    const parent = placed[pi];
    if (!parent.connections) parent.connections = {};
    parent.connections[dir] = true;

    const opp = OPPOSITE[dir];
    const row = {
        piece: pieceB,
        pieceId: pieceB.id,
        x: origin.x,
        y: origin.y,
        connections: {},
        role: role || 'growth',
        eventId: eventId || null
    };
    row.connections[opp] = true;
    placed.push(row);
    return placed.length - 1;
}

/**
 * Filter candidates that can attach somewhere to open exits.
 * @returns {{ open: OpenExit, piece: object, origin: {x,y} }[]}
 */
function gatherAttachOptions(placed, openExits, candidates, rng) {
    const options = [];
    const opens = shuffleCopy(rng, openExits);
    const pieces = shuffleCopy(rng, candidates);
    for (let oi = 0; oi < opens.length; oi++) {
        const open = opens[oi];
        for (let pi = 0; pi < pieces.length; pi++) {
            const piece = pieces[pi];
            const origin = tryAttach(placed, open.pi, open.dir, piece);
            if (origin) {
                options.push({ open, piece, origin });
            }
        }
    }
    return options;
}

/**
 * Place first hub (or fallback first pack piece) at origin.
 * @returns {{ ok: boolean, error?: object }}
 */
function placeHub(placed, pack, rule, rng) {
    const candidates = filterPiecesForRule(
        pack.pieces,
        rule.tags,
        rule.tagMode,
        rule.excludeTags
    );
    let pool = candidates.length ? candidates : pack.pieces.slice();
    if (!pool.length) {
        return {
            ok: false,
            error: {
                code: 'no_compatible_piece',
                message: 'No pieces available for AddHub',
                detail: { tags: rule.tags }
            }
        };
    }
    pool = shuffleCopy(rng, pool);
    const piece = pool[0];
    placed.push({
        piece,
        pieceId: piece.id,
        x: 0,
        y: 0,
        connections: {},
        role: 'hub',
        eventId: null
    });
    return { ok: true };
}

/**
 * Grow N pieces matching rule tags; use connectors when direct attach fails.
 * @returns {{ ok: boolean, placedCount: number, error?: object }}
 */
function growByRule(placed, pack, rule, rng, opts) {
    const o = opts || {};
    const connectorTags = o.connectorTags || ['corridor'];
    const maxPieces = o.maxPieces != null ? o.maxPieces : 40;
    let placedCount = 0;
    const role =
        rule.op === RULE_OPS.AddRoom
            ? 'room'
            : rule.op === RULE_OPS.AddCorridor
              ? 'corridor'
              : rule.op === RULE_OPS.AddExit
                ? 'exit'
                : 'growth';

    const targetTags = rule.tags;
    const targetMode =
        rule.op === RULE_OPS.AddExit ? 'any' : rule.tagMode || 'all';

    for (let n = 0; n < rule.n; n++) {
        if (placed.length >= maxPieces) {
            return {
                ok: false,
                placedCount,
                error: {
                    code: 'budget_exceeded',
                    message: `maxPieces ${maxPieces} reached while applying ${rule.op}`,
                    detail: { maxPieces, placed: placed.length }
                }
            };
        }

        let openExits = collectOpenExits(placed);
        if (!openExits.length) {
            return {
                ok: false,
                placedCount,
                error: {
                    code: 'no_open_exit',
                    message: `No open exits for ${rule.op}`,
                    detail: { need: rule.n - n }
                }
            };
        }

        const targets = filterPiecesForRule(
            pack.pieces,
            targetTags,
            targetMode,
            rule.excludeTags
        );
        let options = gatherAttachOptions(placed, openExits, targets, rng);

        // If no direct attach, try a connector corridor first, then target.
        if (!options.length) {
            const connectors = filterPiecesForRule(
                pack.pieces,
                connectorTags,
                'any',
                []
            );
            const connOpts = gatherAttachOptions(
                placed,
                openExits,
                connectors,
                rng
            );
            if (connOpts.length) {
                const pick = connOpts[Math.floor(rng() * connOpts.length)];
                commitPlacement(
                    placed,
                    pick.open.pi,
                    pick.open.dir,
                    pick.piece,
                    pick.origin,
                    'corridor',
                    null
                );
                // Retry target attach after connector
                openExits = collectOpenExits(placed);
                options = gatherAttachOptions(
                    placed,
                    openExits,
                    targets,
                    rng
                );
            }
        }

        // Still nothing: for rooms, accept any corridor growth once
        if (!options.length && rule.op === RULE_OPS.AddRoom) {
            const anyGrowth = filterPiecesForRule(
                pack.pieces,
                ['corridor', 'room'],
                'any',
                rule.excludeTags
            );
            options = gatherAttachOptions(
                placed,
                openExits,
                anyGrowth,
                rng
            );
        }

        // AddExit: allow single-exit pieces (dead-end) with any tag if needed
        if (!options.length && rule.op === RULE_OPS.AddExit) {
            const deadish = pack.pieces.filter((p) => {
                const ex = p.exits || {};
                let c = 0;
                for (let i = 0; i < CARDINALS.length; i++) {
                    if (ex[CARDINALS[i]]) c++;
                }
                return c === 1;
            });
            options = gatherAttachOptions(placed, openExits, deadish, rng);
        }

        if (!options.length) {
            return {
                ok: false,
                placedCount,
                error: {
                    code: 'no_compatible_piece',
                    message: `No compatible piece for ${rule.op}`,
                    detail: {
                        tags: targetTags,
                        openExits: openExits.length,
                        remaining: rule.n - n
                    }
                }
            };
        }

        const pick = options[Math.floor(rng() * options.length)];
        commitPlacement(
            placed,
            pick.open.pi,
            pick.open.dir,
            pick.piece,
            pick.origin,
            role,
            null
        );
        placedCount++;
    }
    return { ok: true, placedCount };
}

/**
 * Cap leftover open exits with dead-end pieces (best effort).
 */
function capOpenExits(placed, pack, rng, maxPieces) {
    const deadends = filterPiecesForRule(
        pack.pieces,
        ['deadend', 'exit'],
        'any',
        []
    );
    const singleExit = pack.pieces.filter((p) => {
        const ex = p.exits || {};
        let c = 0;
        for (let i = 0; i < CARDINALS.length; i++) {
            if (ex[CARDINALS[i]]) c++;
        }
        return c === 1;
    });
    const pool = deadends.length ? deadends : singleExit;
    if (!pool.length) return;

    let guard = 0;
    while (guard++ < 64 && placed.length < maxPieces) {
        const openExits = collectOpenExits(placed);
        if (!openExits.length) break;
        const options = gatherAttachOptions(placed, openExits, pool, rng);
        if (!options.length) break;
        const pick = options[Math.floor(rng() * options.length)];
        commitPlacement(
            placed,
            pick.open.pi,
            pick.open.dir,
            pick.piece,
            pick.origin,
            'cap',
            null
        );
    }
}

/**
 * Assign SelectEvent labels onto room/hub placements.
 * @returns {object[]}
 */
function assignEvents(placed, rule, rng) {
    const events = [];
    if (!rule.events.length || rule.n <= 0) return events;
    const candidates = [];
    for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        if (p.role === 'room' || p.role === 'hub' || p.role === 'exit') {
            candidates.push(i);
        }
    }
    if (!candidates.length) {
        for (let i = 0; i < placed.length; i++) candidates.push(i);
    }
    const shuffled = shuffleCopy(rng, candidates);
    const n = Math.min(rule.n, shuffled.length, rule.events.length * 4);
    for (let i = 0; i < n; i++) {
        const eventId = rule.events[i % rule.events.length];
        const pi = shuffled[i];
        placed[pi].eventId = eventId;
        events.push({
            placementIndex: pi,
            pieceId: placed[pi].pieceId,
            eventId,
            x: placed[pi].x,
            y: placed[pi].y
        });
    }
    return events;
}

/**
 * Build waypoint spine: hub entrance → along placement tree → exit.
 * @param {object[]} placed
 * @param {{ cols, rows, sockets }} stitched
 * @returns {{ waypoints: object[], entrance: object|null, exit: object|null }}
 */
function buildWaypointSpine(placed, stitched) {
    const sockWps = (stitched.sockets && stitched.sockets.waypoints) || [];
    const byPlacement = Object.create(null);
    for (let i = 0; i < sockWps.length; i++) {
        const w = sockWps[i];
        const pi = w.placementIndex;
        if (pi == null) continue;
        if (!byPlacement[pi]) byPlacement[pi] = [];
        byPlacement[pi].push(w);
    }

    // Order placements by BFS from hub (index 0)
    const order = [];
    const seen = Object.create(null);
    const q = [0];
    seen[0] = true;
    // Build adjacency from connections (symmetric via parent links during growth)
    // Reconstruct from open connection maps + geometry
    const adj = Object.create(null);
    for (let i = 0; i < placed.length; i++) adj[i] = [];
    for (let i = 0; i < placed.length; i++) {
        const a = placed[i];
        const conn = a.connections || {};
        for (let d = 0; d < CARDINALS.length; d++) {
            const dir = CARDINALS[d];
            if (!conn[dir]) continue;
            // Find neighbor in that direction by AABB abutment
            for (let j = 0; j < placed.length; j++) {
                if (i === j) continue;
                const b = placed[j];
                const ox = attachOrigin(a.piece, a.x, a.y, dir, b.piece);
                if (ox && ox.x === b.x && ox.y === b.y) {
                    adj[i].push(j);
                }
            }
        }
    }
    while (q.length) {
        const i = q.shift();
        order.push(i);
        const nbrs = adj[i] || [];
        for (let k = 0; k < nbrs.length; k++) {
            const j = nbrs[k];
            if (seen[j]) continue;
            seen[j] = true;
            q.push(j);
        }
    }
    // Append any disconnected
    for (let i = 0; i < placed.length; i++) {
        if (!seen[i]) order.push(i);
    }

    const waypoints = [];
    for (let oi = 0; oi < order.length; oi++) {
        const pi = order[oi];
        const list = byPlacement[pi] || [];
        // Prefer one representative waypoint per piece (center-most)
        if (!list.length) continue;
        let best = list[0];
        let bestScore = Infinity;
        for (let i = 0; i < list.length; i++) {
            const w = list[i];
            const cx = placed[pi].x + placed[pi].piece.size.w / 2;
            const cy = placed[pi].y + placed[pi].piece.size.h / 2;
            const score = Math.abs(w.x - cx) + Math.abs(w.y - cy);
            if (score < bestScore) {
                bestScore = score;
                best = w;
            }
        }
        waypoints.push({
            x: best.x,
            y: best.y,
            z: best.z != null ? best.z : 0,
            pieceId: best.pieceId,
            placementIndex: pi
        });
    }

    // Entrance: hub north-ish or first waypoint; exit: last exit-role or last wp
    let entrance = waypoints[0] || null;
    let exit = waypoints.length ? waypoints[waypoints.length - 1] : null;
    let exitPi = -1;
    for (let i = placed.length - 1; i >= 0; i--) {
        if (placed[i].role === 'exit') {
            exitPi = i;
            break;
        }
    }
    if (exitPi >= 0 && byPlacement[exitPi] && byPlacement[exitPi].length) {
        const list = byPlacement[exitPi];
        exit = {
            x: list[0].x,
            y: list[0].y,
            z: list[0].z != null ? list[0].z : 0,
            pieceId: list[0].pieceId,
            placementIndex: exitPi
        };
        // Ensure exit is last in spine
        const filtered = waypoints.filter((w) => w.placementIndex !== exitPi);
        filtered.push(exit);
        return { waypoints: filtered, entrance, exit };
    }

    return { waypoints, entrance, exit };
}

/**
 * One generation attempt.
 * @returns {{ ok: boolean, error?: object, placed?: object[], events?: object[] }}
 */
function tryGrow(pack, program, materialized, rng) {
    /** @type {object[]} */
    const placed = [];
    /** @type {object[]} */
    const events = [];
    const maxPieces = program.maxPieces || 40;

    for (let ri = 0; ri < materialized.length; ri++) {
        const rule = materialized[ri];
        if (rule.op === RULE_OPS.AddHub) {
            for (let h = 0; h < Math.max(1, rule.n); h++) {
                if (placed.length && h > 0) {
                    // Extra hubs grow as rooms with hub tags
                    const r = growByRule(
                        placed,
                        pack,
                        Object.assign({}, rule, {
                            op: RULE_OPS.AddRoom,
                            n: 1
                        }),
                        rng,
                        {
                            connectorTags: program.connectorTags,
                            maxPieces
                        }
                    );
                    if (!r.ok) return { ok: false, error: r.error, placed };
                } else {
                    const hub = placeHub(placed, pack, rule, rng);
                    if (!hub.ok) return { ok: false, error: hub.error, placed };
                }
            }
        } else if (
            rule.op === RULE_OPS.AddRoom ||
            rule.op === RULE_OPS.AddCorridor ||
            rule.op === RULE_OPS.AddExit
        ) {
            const r = growByRule(placed, pack, rule, rng, {
                connectorTags: program.connectorTags,
                maxPieces
            });
            if (!r.ok) return { ok: false, error: r.error, placed };
        } else if (rule.op === RULE_OPS.SelectEvent) {
            const ev = assignEvents(placed, rule, rng);
            for (let i = 0; i < ev.length; i++) events.push(ev[i]);
        }
    }

    if (!placed.length) {
        return {
            ok: false,
            error: {
                code: 'empty_layout',
                message: 'No pieces placed'
            }
        };
    }

    if (program.capOpenExits !== false) {
        capOpenExits(placed, pack, rng, maxPieces);
    }

    return { ok: true, placed, events };
}

/**
 * Generate a procedural dungeon layout.
 *
 * @param {{
 *   profile?: object,
 *   rules?: object[]|object,
 *   pack: object,
 *   seed?: number,
 *   floor?: number|string,
 *   z?: number|string,
 *   maxAttempts?: number
 * }} opts
 * @returns {{
 *   ok: boolean,
 *   seed: number,
 *   profileId: string|null,
 *   cols?: number,
 *   rows?: number,
 *   friction?: Uint8Array,
 *   sockets?: object,
 *   placements?: object[],
 *   waypoints?: object[],
 *   entrance?: object|null,
 *   exit?: object|null,
 *   events?: object[],
 *   validation?: object,
 *   meta?: object,
 *   error?: { code: string, message: string, detail?: * },
 *   attempts?: number
 * }}
 */
function generateProceduralLayout(opts) {
    const o = opts || {};
    const seed = o.seed != null ? o.seed >>> 0 || 1 : 1;
    const rng = createSeededRandom(layoutSeed(seed));

    let program = null;
    if (o.profile) {
        program = normalizeRuleProgram(o.profile);
    } else if (o.rules) {
        program = normalizeRuleProgram(
            Array.isArray(o.rules) ? { rules: o.rules } : o.rules
        );
    }
    if (!program) {
        return {
            ok: false,
            seed,
            profileId: null,
            error: {
                code: 'invalid_rules',
                message: 'Missing or empty rule program / profile'
            },
            attempts: 0
        };
    }

    let pack = o.pack;
    if (pack && !pack.byId) {
        pack = normalizePiecePack(pack);
    }
    if (!pack || !pack.pieces || !pack.pieces.length) {
        return {
            ok: false,
            seed,
            profileId: program.id,
            error: {
                code: 'missing_piece_pack',
                message: 'Piece pack required for procedural layout'
            },
            attempts: 0
        };
    }

    const maxAttempts =
        o.maxAttempts != null
            ? Math.max(1, Math.floor(o.maxAttempts))
            : program.maxAttempts || 32;
    const z =
        o.z != null
            ? o.z
            : o.floor != null
              ? o.floor
              : program.floor != null
                ? program.floor
                : 0;

    let lastError = {
        code: 'budget_exceeded',
        message: `Failed after ${maxAttempts} attempts`
    };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Fresh materialize each attempt so counts vary under seed stream
        const materialized = materializeRuleCounts(program, rng);
        const grown = tryGrow(pack, program, materialized, rng);
        if (!grown.ok) {
            lastError = grown.error || lastError;
            continue;
        }

        const stitchPlacements = grown.placed.map((p) => ({
            piece: p.piece,
            x: p.x,
            y: p.y,
            z
        }));
        const stitched = stitch(stitchPlacements, {
            pack,
            z,
            shiftOrigin: true
        });

        // Re-map placement roles onto shifted coords
        const placementMeta = stitched.placements.map((pm, i) => {
            const src = grown.placed[i] || {};
            return Object.assign({}, pm, {
                role: src.role || null,
                eventId: src.eventId || null
            });
        });

        const spine = buildWaypointSpine(grown.placed, stitched);
        // Shift spine waypoints already in stitched space (sockets offset by stitch)
        // buildWaypointSpine uses stitched sockets — already origin-shifted.

        const validation = validateLayout(stitched, {
            entrance: spine.entrance,
            exit: spine.exit,
            requireEntranceExit: true,
            requireSpawnWalkable: true
        });

        if (!validation.ok) {
            const disc = validation.errors.find((e) => e.code === 'disconnected');
            lastError = disc
                ? {
                      code: 'disconnected',
                      message: disc.message,
                      detail: disc.detail
                  }
                : {
                      code: validation.errors[0]
                          ? validation.errors[0].code
                          : 'validation_failed',
                      message: validation.errors[0]
                          ? validation.errors[0].message
                          : 'Validation failed',
                      detail: validation.errors
                  };
            continue;
        }

        // Ensure party spine has at least entrance + exit
        let waypoints = spine.waypoints;
        if (spine.entrance && spine.exit) {
            if (!waypoints.length) {
                waypoints = [spine.entrance, spine.exit];
            } else {
                // Force first/last
                if (
                    waypoints[0].x !== spine.entrance.x ||
                    waypoints[0].y !== spine.entrance.y
                ) {
                    waypoints = [spine.entrance].concat(waypoints);
                }
                const last = waypoints[waypoints.length - 1];
                if (last.x !== spine.exit.x || last.y !== spine.exit.y) {
                    waypoints = waypoints.concat([spine.exit]);
                }
            }
        }

        // Shift event coords if stitch shifted origin
        const ox = stitched.origin.x;
        const oy = stitched.origin.y;
        const events = (grown.events || []).map((ev) =>
            Object.assign({}, ev, {
                x: ev.x - ox,
                y: ev.y - oy
            })
        );

        return {
            ok: true,
            seed,
            profileId: program.id,
            cols: stitched.cols,
            rows: stitched.rows,
            friction: stitched.friction,
            sockets: stitched.sockets,
            placements: placementMeta,
            waypoints,
            entrance: spine.entrance,
            exit: spine.exit,
            events,
            validation,
            origin: stitched.origin,
            meta: {
                pieceCount: placementMeta.length,
                attempts: attempt + 1,
                piecePackId: pack.id,
                floor: z,
                rules: materialized.map((r) => ({
                    op: r.op,
                    n: r.n,
                    tags: r.tags
                })),
                reason: 'ok'
            },
            attempts: attempt + 1
        };
    }

    return {
        ok: false,
        seed,
        profileId: program.id,
        error: lastError,
        attempts: maxAttempts
    };
}

/**
 * Normalize dungeon profile (rules + content pointers).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeDungeonProfile(raw) {
    return normalizeRuleProgram(raw);
}

/**
 * Expand hunt.layout procedural → friction floors, waypoints, sockets.
 * Must run before population/marker expand so slots exist.
 *
 * @param {object} hunt
 * @param {{
 *   seed?: number,
 *   loadDungeonProfile?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   normalizePiecePack?: (raw: object) => object|null
 * }} [opts]
 * @returns {object}
 */
function resolveHuntLayout(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    const layout = hunt.layout;
    if (!layout || typeof layout !== 'object') return hunt;

    const type = String(layout.type || layout.kind || '').toLowerCase();

    // Arena ↔ rest chain (must run before multi_biome / multifloor so
    // alternating artSets never hijack resolveMultiBiomeHuntLayout).
    if (type === 'arena_rest_chain' || type === 'arena-rest-chain') {
        const {
            resolveArenaRestChainHuntLayout
        } = require('./arena_rest_chain.js');
        return resolveArenaRestChainHuntLayout(hunt, opts);
    }

    // Stage 11.10 multi-biome macro chains (before plain multifloor)
    if (
        type === 'multi_biome' ||
        type === 'multibiome' ||
        type === 'macro' ||
        type === 'macro_biome' ||
        (Array.isArray(layout.segments) && layout.segments.length > 0) ||
        (Array.isArray(layout.biomeIds) && layout.biomeIds.length >= 2)
    ) {
        const { resolveMultiBiomeHuntLayout } = require('./macro.js');
        const o = opts || {};
        let loadBiomePack = o.loadBiomePack;
        if (typeof loadBiomePack !== 'function') {
            try {
                const presets = require('../../presets.js');
                if (typeof presets.loadBiomePack === 'function') {
                    loadBiomePack = presets.loadBiomePack.bind(presets);
                }
            } catch (_e) {
                /* optional */
            }
        }
        return resolveMultiBiomeHuntLayout(
            hunt,
            Object.assign({}, o, { loadBiomePack })
        );
    }

    // Stage 11.8 multi-floor biome chains
    if (
        type === 'multifloor' ||
        type === 'multi_floor' ||
        type === 'multi-floor' ||
        type === 'floors' ||
        (Array.isArray(layout.floors) && layout.floors.length > 0)
    ) {
        const { resolveMultiFloorHuntLayout } = require('./multifloor.js');
        const o = opts || {};
        let loadBiomePack = o.loadBiomePack;
        if (typeof loadBiomePack !== 'function') {
            try {
                const presets = require('../../presets.js');
                if (typeof presets.loadBiomePack === 'function') {
                    loadBiomePack = presets.loadBiomePack.bind(presets);
                }
            } catch (_e) {
                /* optional */
            }
        }
        // When floors carry distinct biomeId / artSet, treat as macro multi-biome
        const floors = layout.floors;
        if (Array.isArray(floors) && floors.length >= 2) {
            const biomeKeys = new Set();
            for (let i = 0; i < floors.length; i++) {
                const f = floors[i];
                if (!f || typeof f !== 'object') continue;
                const bid =
                    f.biomeId != null
                        ? String(f.biomeId)
                        : f.biome != null
                          ? String(f.biome)
                          : '';
                const art = f.artSet != null ? String(f.artSet) : '';
                const pop =
                    f.populationId != null ? String(f.populationId) : '';
                if (bid || art) biomeKeys.add(`${bid}|${art}|${pop}`);
            }
            if (biomeKeys.size >= 2) {
                const { resolveMultiBiomeHuntLayout } = require('./macro.js');
                return resolveMultiBiomeHuntLayout(
                    hunt,
                    Object.assign({}, o, { loadBiomePack })
                );
            }
        }
        return resolveMultiFloorHuntLayout(
            hunt,
            Object.assign({}, o, { loadBiomePack })
        );
    }

    // Stage 11.5 fixed layouts + cutouts
    if (
        type === 'fixed' ||
        type === 'fixed_cutout' ||
        type === 'fixed+cutouts' ||
        type === 'cutout' ||
        type === 'cutouts'
    ) {
        const { resolveFixedHuntLayout } = require('./fixed.js');
        const o = opts || {};
        let loadPopulation = o.loadPopulation;
        if (typeof loadPopulation !== 'function') {
            try {
                const presets = require('../../presets.js');
                if (typeof presets.loadPopulation === 'function') {
                    loadPopulation = presets.loadPopulation.bind(presets);
                }
            } catch (_e) {
                /* optional */
            }
        }
        return resolveFixedHuntLayout(
            hunt,
            Object.assign({}, o, { loadPopulation })
        );
    }

    if (type && type !== 'procedural' && type !== 'proc' && type !== 'drlg') {
        // Unknown layout type — leave hunt unchanged
        return hunt;
    }

    // Already expanded
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
    } else if (layout.rules) {
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
            message: 'Procedural layout needs profileId or inline profile'
        };
        return out;
    }

    const program = normalizeDungeonProfile(profileRaw);
    if (!program) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = 'invalid_profile';
        out.layoutError = {
            code: 'invalid_rules',
            message: 'Dungeon profile failed to normalize'
        };
        return out;
    }

    const packId =
        layout.piecePack != null
            ? String(layout.piecePack)
            : program.piecePack != null
              ? program.piecePack
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
    if (!pack) {
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
            : program.floor != null
              ? program.floor
              : 0;

    const gen = generateProceduralLayout({
        profile: Object.assign({}, profileRaw, program),
        pack,
        seed,
        floor,
        z: floor,
        maxAttempts: layout.maxAttempts || program.maxAttempts
    });

    if (!gen.ok) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = gen.error ? gen.error.code : 'generate_failed';
        out.layoutError = gen.error || {
            code: 'generate_failed',
            message: 'Procedural generation failed'
        };
        out.layoutMeta = {
            reason: 'failed',
            attempts: gen.attempts,
            seed,
            profileId: gen.profileId
        };
        return out;
    }

    const out = Object.assign({}, hunt);
    out.floor = floor;
    out.floors = [floor];
    // In-memory friction for Simulator (no path PNG)
    out.floorFriction = {
        z: floor,
        cols: gen.cols,
        rows: gen.rows,
        friction: gen.friction
    };
    // Clear map path so sim does not load continent PNG
    delete out.mapPath;
    delete out.mapPaths;

    // Route is owned by the dungeon profile / generator (not the hunt JSON).
    out.waypoints = (gen.waypoints || []).map((w) => ({
        x: w.x,
        y: w.y,
        z: w.z != null ? w.z : floor
    }));

    // Population from piece sockets
    if (
        !Array.isArray(out.populationSlots) ||
        !out.populationSlots.length
    ) {
        out.populationSlots = (gen.sockets.spawns || []).map((s) => ({
            x: s.x,
            y: s.y,
            z: s.z != null ? s.z : floor
        }));
    }

    // Markers from piece sockets
    if (!Array.isArray(out.markerSockets) || !out.markerSockets.length) {
        out.markerSockets = (gen.sockets.markers || []).map((m) => ({
            id: m.id != null ? m.id : 'A',
            x: m.x,
            y: m.y,
            z: m.z != null ? m.z : floor
        }));
    }

    // Inherit content ids from profile when hunt omits them
    if (!out.populationId && !out.population && program.populationId) {
        out.populationId = program.populationId;
    }
    if (
        !out.markersId &&
        !out.markerRules &&
        !out.markers &&
        program.markersId
    ) {
        out.markersId = program.markersId;
    }
    if (!out.pacingBudget && program.pacingBudget) {
        out.pacingBudget = program.pacingBudget;
    }

    out.layoutMeta = {
        reason: 'ok',
        type: 'procedural',
        seed,
        profileId: gen.profileId,
        piecePackId: pack.id,
        pieceCount: gen.meta.pieceCount,
        attempts: gen.attempts,
        cols: gen.cols,
        rows: gen.rows,
        entrance: gen.entrance,
        exit: gen.exit,
        events: gen.events,
        validation: {
            ok: gen.validation.ok,
            walkable: gen.validation.walkable,
            pathLength:
                gen.validation.connectivity &&
                gen.validation.connectivity.pathLength
        }
    };
    out.layoutPlacements = gen.placements;

    // Auto-bake coarse navmesh (waypoints + spawn sockets + walkable edges)
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
                    sockets: gen.sockets,
                    placements: gen.placements
                },
                {
                    z: floor,
                    waypoints: out.waypoints,
                    piecesById: pack.byId,
                    usePlacements: true,
                    id: `proc_${gen.profileId || 'layout'}`
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
 * Whether hunt requests procedural (or any) layout generation.
 * @param {object|null|undefined} hunt
 * @returns {boolean}
 */
function huntHasLayout(hunt) {
    if (!hunt || typeof hunt !== 'object') return false;
    if (hunt.layout && typeof hunt.layout === 'object') return true;
    if (hunt.dungeonProfileId) return true;
    return false;
}

module.exports = {
    LAYOUT_SEED_SALT,
    layoutSeed,
    generateProceduralLayout,
    normalizeDungeonProfile,
    resolveHuntLayout,
    huntHasLayout,
    // internals exposed for tests
    boxesOverlap,
    placementFits,
    collectOpenExits,
    tryAttach,
    buildWaypointSpine
};
