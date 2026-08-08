/**
 * Multi-target spell resolution for shapes (area / wave / beam).
 *
 * Pure combat: mana + cooldowns applied once; damage rolled per defender.
 * Tile footprint via kernel/core/lib/shapes.js (inject tileMap for walls/LoS).
 */

'use strict';

const {
    getAffectedTiles,
    entitiesOnTiles,
    spellTypeFromShape,
    areaShapeUsesDirection,
    cardinalDirection,
    octantDirection,
    findTopAreaCenters,
    hasLineOfSight
} = require('../shapes.js');
const {
    resolveAttack,
    hasMana,
    spendMana,
    resolveMoveLock,
    applyMoveLock
} = require('./resolve.js');
const { isWithinSpellCastRange } = require('./cast_range.js');
const Cooldowns = require('./cooldowns.js');
const {
    getFieldKind,
    deployFieldAndTriggerOccupants,
    removeFieldFromTile,
    isPlayerEntity,
    isObstacleFieldKind
} = require('./elemental_fields.js');
const {
    spellHasDelay,
    resolveDelaySec,
    resolveDelayedPlaceCenter,
    getDelayedCastStore,
    scheduleDelayedCast
} = require('./delayed_cast.js');

/**
 * Whether a spell def has a multi-tile shape.
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function spellHasShape(spell) {
    if (!spell || !spell.shape || typeof spell.shape !== 'object') return false;
    const t = String(spell.shape.type || '');
    return t === 'area' || t === 'wave' || t === 'beam';
}

/**
 * Pick wave/beam facing from attacker toward aim (or candidate centroid).
 * @param {{tile?: {x:number,y:number}}} attacker
 * @param {{tile?: {x:number,y:number}}|null} primary
 * @param {object[]} [candidates]
 * @param {number} [range]
 * @returns {{x:number,y:number}}
 */
function resolveWaveDirection(attacker, primary, candidates, range) {
    if (!attacker || !attacker.tile) return { x: 1, y: 0 };

    const r = range != null ? range : Infinity;
    const near = [];
    if (candidates && candidates.length) {
        for (let i = 0; i < candidates.length; i++) {
            const e = candidates[i];
            if (!e || !e.tile || e.alive === false) continue;
            if (e.hp && e.hp.current <= 0) continue;
            if (String(e.tile.z) !== String(attacker.tile.z)) continue;
            const dx = Math.abs(e.tile.x - attacker.tile.x);
            const dy = Math.abs(e.tile.y - attacker.tile.y);
            const d = Math.max(dx, dy);
            if (d <= r) near.push(e);
        }
    }

    if (near.length > 0) {
        let ax = 0;
        let ay = 0;
        for (let i = 0; i < near.length; i++) {
            ax += near[i].tile.x;
            ay += near[i].tile.y;
        }
        ax /= near.length;
        ay /= near.length;
        return cardinalDirection(attacker.tile, { x: ax, y: ay });
    }

    if (primary && primary.tile) {
        return cardinalDirection(attacker.tile, primary.tile);
    }
    return { x: 1, y: 0 };
}

/**
 * Whether an *area* spell blasts from the caster tile (self-AoE).
 * Mirrors the caster-center branch of {@link resolveAreaCenter}.
 * Waves/beams are never self-centered even at range 0–1.
 *
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function isSelfCenteredAreaSpell(spell) {
    if (!spellHasShape(spell)) return false;
    const t = String(spell.shape.type || '');
    if (t !== 'area') return false;
    const range = spell.range != null ? Number(spell.range) : 1;
    const isMelee =
        spell.isMelee === true ||
        (spell.isMelee == null &&
            (spell.kind === 'auto' ||
                spell.powerCurve === 'melee_auto' ||
                spell.powerCurve === 'melee_strike' ||
                range <= 1));
    return isMelee || range <= 1;
}

/**
 * Choose blast center for an area shape.
 * Melee / self-centered (range ≤ 1): caster tile.
 * Ranged modes (`centerMode`):
 * - **primary** — center on primary tile when LoS is clear (manual castWith
 *   tile aim, action-bar Active Target, wall lines). Legacy
 *   Combat::doCombat(caster, toPos).
 * - **maximize** — multi-hit ranking via `findTopAreaCenters` (action-bar
 *   Smart Cast, player/creature AI). Default when no primary is set.
 * Manual empty-tile aim (`primary._aimOnly`) always forces primary mode so
 * the clicked sqm is the matrix origin (not a pack pivot nearer the caster).
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object|null} opts.primary
 * @param {object} opts.spell
 * @param {object[]} [opts.candidates]
 * @param {object|null} [opts.tileMap]
 * @param {'primary'|'maximize'} [opts.centerMode]
 * @returns {{x:number,y:number,z?:*}|null}
 */
function resolveAreaCenter(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const spell = o.spell;
    if (!attacker || !attacker.tile || !spell) return null;

    const range = spell.range != null ? Number(spell.range) : 1;
    const isMelee =
        spell.isMelee === true ||
        (spell.isMelee == null &&
            (spell.kind === 'auto' ||
                spell.powerCurve === 'melee_auto' ||
                spell.powerCurve === 'melee_strike' ||
                range <= 1));

    if (isMelee || range <= 1) {
        return {
            x: attacker.tile.x,
            y: attacker.tile.y,
            z: attacker.tile.z
        };
    }

    const primary = o.primary;
    const candidates = o.candidates || [];
    const tileMap = o.tileMap || null;
    const z = attacker.tile.z;
    // Tile aim always pins the blast; otherwise honor explicit mode, then
    // maximize when we have hostiles to rank, else fall back to primary tile.
    const aimOnly = !!(primary && primary._aimOnly);
    let centerMode = o.centerMode === 'primary' || o.centerMode === 'maximize'
        ? o.centerMode
        : null;
    if (aimOnly) {
        centerMode = 'primary';
    } else if (!centerMode) {
        centerMode = primary ? 'primary' : 'maximize';
    }

    // Candidates in cast range (Chebyshev + optional far-use box for runes).
    // Used by wall fallbacks and multi-hit ranking.
    const inRange = [];
    for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (!e || !e.tile || e.alive === false) continue;
        if (e.hp && e.hp.current <= 0) continue;
        if (String(e.tile.z) !== String(z)) continue;
        if (isWithinSpellCastRange(attacker.tile, e.tile, spell, range)) {
            inRange.push(e);
        }
    }
    if (primary && primary.tile && !primary._aimOnly && String(primary.tile.z) === String(z)) {
        let hasP = false;
        for (let i = 0; i < inRange.length; i++) {
            if (inRange[i] === primary) {
                hasP = true;
                break;
            }
        }
        if (
            !hasP &&
            isWithinSpellCastRange(attacker.tile, primary.tile, spell, range)
        ) {
            inRange.push(primary);
        }
    }

    /**
     * Clear LoS from caster to a tile (or open when no map).
     * @param {{x:number,y:number,z?:*}} tile
     * @returns {boolean}
     */
    function clearLosTo(tile) {
        if (!tile) return false;
        const tz = tile.z !== undefined ? tile.z : z;
        if (!tileMap) return true;
        return hasLineOfSight(
            attacker.tile.x,
            attacker.tile.y,
            z,
            tile.x,
            tile.y,
            tz,
            tileMap
        );
    }

    // Wall fields (and other direction-oriented area lines): center on the
    // sticky / best target tile. findTopAreaCenters scores the east-authored
    // matrix only — on diagonal aim it picks a same-column/row center and
    // collapses octant facing to pure cardinal, missing the stair companion.
    // Legacy wall runes are cast on the target square; mirror that here.
    if (spell.shape && areaShapeUsesDirection(spell.shape) && inRange.length) {
        /** @type {object[]} */
        const wallOrder = [];
        if (primary && inRange.indexOf(primary) >= 0) {
            wallOrder.push(primary);
        }
        for (let i = 0; i < inRange.length; i++) {
            if (inRange[i] !== primary) wallOrder.push(inRange[i]);
        }
        for (let i = 0; i < wallOrder.length; i++) {
            const e = wallOrder[i];
            if (!e || !e.tile) continue;
            if (clearLosTo(e.tile)) {
                return {
                    x: e.tile.x,
                    y: e.tile.y,
                    z: e.tile.z !== undefined ? e.tile.z : z
                };
            }
        }
    }

    // Maximize hits (Smart Cast / AI): rank multi-hit pivots among in-range
    // hostiles. Skip for pure aim-only primaries (no living candidates).
    if (
        centerMode === 'maximize' &&
        spell.shape &&
        inRange.length &&
        !areaShapeUsesDirection(spell.shape)
    ) {
        const ranked = findTopAreaCenters(
            attacker.tile,
            inRange,
            spell.shape,
            12
        );
        for (let i = 0; i < ranked.length; i++) {
            const c = ranked[i];
            if (clearLosTo(c)) {
                return { x: c.x, y: c.y, z };
            }
        }
    }

    // Primary mode (Active Target, castWith tile, maximize fallback).
    if (primary && primary.tile) {
        const pz = primary.tile.z !== undefined ? primary.tile.z : z;
        if (clearLosTo(primary.tile)) {
            return {
                x: primary.tile.x,
                y: primary.tile.y,
                z: pz
            };
        }
        // Aimed tile blocked — do not invent a different center.
        return null;
    }

    return { x: attacker.tile.x, y: attacker.tile.y, z };
}

/**
 * Wave/beam origin = one step in front of caster (legacy).
 * @param {{x:number,y:number,z?:*}} casterTile
 * @param {{x:number,y:number}} direction
 * @returns {{x:number,y:number,z?:*}}
 */
function waveOriginFromCaster(casterTile, direction) {
    const dir = direction || { x: 1, y: 0 };
    return {
        x: casterTile.x + (dir.x || 0),
        y: casterTile.y + (dir.y || 0),
        z: casterTile.z
    };
}

/**
 * Compute footprint tiles for a shaped spell without resolving damage.
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object|null} [opts.primary]
 * @param {object} opts.spell
 * @param {object[]} [opts.candidates]
 * @param {object|null} [opts.tileMap]
 * @param {{x:number,y:number}} [opts.direction] override wave facing
 * @param {{x:number,y:number,z?:*}} [opts.center] override blast center
 * @param {'primary'|'maximize'} [opts.centerMode] area blast center policy
 * @param {boolean} [opts.skipCasterLos=false] when true (delayed detonate),
 *   expand from planted center without re-checking caster→center LoS / floor
 * @returns {{
 *   spellType: 'area'|'wave',
 *   center: {x:number,y:number,z?:*}|null,
 *   direction: {x:number,y:number},
 *   affectedTiles: {x:number,y:number,z?:*}[]
 * }}
 */
function computeSpellFootprint(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const spell = o.spell;
    const empty = {
        spellType: /** @type {'area'|'wave'} */ ('area'),
        center: null,
        direction: { x: 1, y: 0 },
        affectedTiles: []
    };
    if (!attacker || !attacker.tile || !spell || !spellHasShape(spell)) {
        return empty;
    }

    const spellType = spellTypeFromShape(spell.shape);
    const range = spell.range != null ? Number(spell.range) : 1;
    let direction =
        o.direction ||
        resolveWaveDirection(
            attacker,
            o.primary || null,
            o.candidates || [],
            range
        );
    let center = o.center || null;

    if (spellType === 'wave') {
        if (!center) {
            center = waveOriginFromCaster(attacker.tile, direction);
        }
    } else {
        if (!center) {
            center = resolveAreaCenter({
                attacker,
                primary: o.primary || null,
                spell,
                candidates: o.candidates || [],
                tileMap: o.tileMap || null,
                centerMode: o.centerMode
            });
        }
        // Most area matrices are rotation-invariant; wall fields are lines and
        // must face with caster → center (8-dir: cardinal line or diagonal stair).
        if (areaShapeUsesDirection(spell.shape)) {
            if (!o.direction && center && attacker.tile) {
                direction = octantDirection(attacker.tile, center);
            }
        } else {
            direction = { x: 1, y: 0 };
        }
    }

    if (!center) return empty;

    // Delayed detonations keep the planted center (incl. floor). Requiring
    // LoS from the caster's *current* tile would cancel the blast after a
    // floor hop or walk-away — fuse already paid for placement.
    const affectedTiles = getAffectedTiles({
        caster: o.skipCasterLos ? null : attacker.tile,
        center,
        shape: spell.shape,
        direction,
        tileMap: o.tileMap || null
    });

    return { spellType, center, direction, affectedTiles };
}

/**
 * Whether a player may cast a shaped (area/wave/beam) spell on their tile.
 * Caster must be the **first** combatant (join order / tile controller).
 * When first is a creature (mixed stack), no player may cast player-AoE.
 * Without tileMap / unregistered occupancy, gate is open (unit tests / pre-occupy).
 *
 * @param {object|null|undefined} attacker
 * @param {object|null|undefined} tileMap
 * @returns {boolean}
 */
function canCastPlayerAreaOnTile(attacker, tileMap) {
    if (!attacker || !isPlayerEntity(attacker)) return true;
    if (!tileMap || !attacker.tile) return true;
    if (typeof tileMap.getFirstOccupant !== 'function') return true;
    const tx = attacker.tile.x;
    const ty = attacker.tile.y;
    const tz =
        attacker.tile.z !== undefined && attacker.tile.z !== null
            ? attacker.tile.z
            : 0;
    const first = tileMap.getFirstOccupant(tx, ty, tz) | 0;
    if (first === 0) return true;
    const id = attacker.id != null ? attacker.id | 0 : 0;
    return id !== 0 && first === id;
}

/**
 * Living entity eligible for shaped damage (alive + HP).
 * @param {object|null|undefined} e
 * @returns {boolean}
 */
function isLivingCombatant(e) {
    if (!e || e.alive === false) return false;
    if (e.hp && e.hp.current <= 0) return false;
    return true;
}

/**
 * Expand shaped hit list from tile stacks (Phase B).
 * Creature attacker → all living **players** on each footprint tile (B1/B5).
 * Mixed-stack creatures are not player targets of that rule.
 * Candidate list remains the base filter; stack fills missing co-located players.
 *
 * @param {object[]} hits
 * @param {{x:number,y:number,z?:*}[]} affectedTiles
 * @param {string|number} z
 * @param {object} attacker
 * @param {object|null|undefined} tileMap
 * @returns {object[]}
 */
function expandShapedHitsWithStacks(hits, affectedTiles, z, attacker, tileMap) {
    if (!tileMap || !affectedTiles || !affectedTiles.length) {
        return hits || [];
    }
    if (typeof tileMap.getCombatantEntities !== 'function') {
        return hits || [];
    }
    // Only creature-shaped attacks expand to all players on tile.
    if (isPlayerEntity(attacker)) {
        return hits || [];
    }

    /** @type {object[]} */
    const out = Array.isArray(hits) ? hits.slice() : [];
    const seen = new Set();
    for (let i = 0; i < out.length; i++) {
        const e = out[i];
        if (e && e.id != null) seen.add(e.id | 0);
    }

    for (let t = 0; t < affectedTiles.length; t++) {
        const tile = affectedTiles[t];
        if (!tile) continue;
        const ents = tileMap.getCombatantEntities(tile.x, tile.y, z) || [];
        for (let i = 0; i < ents.length; i++) {
            const e = ents[i];
            if (!isLivingCombatant(e) || e === attacker) continue;
            if (!isPlayerEntity(e)) continue;
            const id = e.id != null ? e.id | 0 : 0;
            if (id !== 0 && seen.has(id)) continue;
            if (id !== 0) seen.add(id);
            out.push(e);
        }
    }
    return out;
}

/**
 * Occupants on a footprint tile for field deploy underfoot (all combatants).
 * Prefers getCombatantEntities; falls back to first occupant only.
 *
 * @param {object|null|undefined} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {object[]} [seed]
 * @returns {object[]}
 */
function combatantsOnTileForField(tileMap, x, y, z, seed) {
    /** @type {object[]} */
    const out = Array.isArray(seed) ? seed.slice() : [];
    if (!tileMap) return out;

    if (typeof tileMap.getCombatantEntities === 'function') {
        const ents = tileMap.getCombatantEntities(x, y, z) || [];
        for (let i = 0; i < ents.length; i++) {
            const ent = ents[i];
            if (ent && out.indexOf(ent) < 0) out.push(ent);
        }
        return out;
    }

    if (
        typeof tileMap.getOccupant === 'function' &&
        typeof tileMap.resolveOccupant === 'function'
    ) {
        const occId = tileMap.getOccupant(x, y, z);
        if (occId) {
            const ent = tileMap.resolveOccupant(occId);
            if (ent && out.indexOf(ent) < 0) out.push(ent);
        }
    }
    return out;
}

/**
 * Resolve a shaped spell against all living candidates on the footprint.
 * Mana / cooldowns / moveLock applied once when the cast is accepted
 * (even if zero defenders are hit — empty field tiles still deploy).
 * Zero footprint tiles → `ok: false`, reason `no_tiles` (no CD/mana/rune).
 * Player casters must be first on their tile (`not_tile_controller` if not).
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object|null} [opts.primary] preferred target (range check / center)
 * @param {object} opts.spell spell def with .shape
 * @param {object[]} [opts.candidates] entities that may be hit
 * @param {object|null} [opts.tileMap]
 * @param {object} [opts.spellBook]
 * @param {boolean} [opts.skipCooldown=false]
 * @param {boolean} [opts.skipMana=false]
 * @param {boolean} [opts.apply=true]
 * @param {() => number} [opts.rng]
 * @param {{x:number,y:number}} [opts.direction]
 * @param {{x:number,y:number,z?:*}} [opts.center]
 * @param {object|null} [opts.sim] optional sim for underfoot creature pool
 * @param {boolean} [opts.skipDelay=false] when true, ignore spell.delaySec (detonate path)
 * @param {object[]} [opts.delayedStore] optional pending-cast array override
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   spell: object|null,
 *   hit: boolean,
 *   critical: boolean,
 *   final: number,
 *   hpDelta: number,
 *   breakdown: object|null,
 *   range: object|null,
 *   moveLock: number,
 *   multi: true,
 *   delayed?: boolean,
 *   delaySec?: number,
 *   affectedTiles: {x:number,y:number,z?:*}[],
 *   center: {x:number,y:number,z?:*}|null,
 *   direction: {x:number,y:number},
 *   results: object[],
 *   hits: object[]
 * }}
 */
function resolveShapedAttack(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const spell = o.spell;
    if (!attacker || !spell) {
        return failShape('missing_combatant', null);
    }
    if (!spellHasShape(spell)) {
        return failShape('no_shape', spell);
    }

    // Phase B: player area cast gate — first combatant only (before CD/mana spend).
    // Detonation path already paid the gate at plant time; caster may have moved floors.
    if (!o.skipDelay && !canCastPlayerAreaOnTile(attacker, o.tileMap || null)) {
        return failShape('not_tile_controller', spell);
    }

    if (!o.skipCooldown) {
        Cooldowns.ensureCooldowns(attacker);
        if (!Cooldowns.canUse(attacker, spell.cooldowns)) {
            return failShape('cooldown', spell);
        }
    }
    const manaCost = spell.mana != null ? spell.mana : 0;
    if (!o.skipMana && !hasMana(attacker, manaCost)) {
        return failShape('mana', spell);
    }

    // Delayed fuse (e.g. divine grenade): plant center, spend resources, no damage yet.
    const delaySec = o.skipDelay ? 0 : resolveDelaySec(spell);
    if (delaySec > 0) {
        const placeCenter =
            o.center ||
            resolveDelayedPlaceCenter(attacker, o.primary || null, spell);
        if (!placeCenter) {
            return failShape('no_tiles', spell);
        }
        const moveLock = resolveMoveLock(spell);
        const applyMutations = o.apply !== false;
        /** @type {object|null} */
        let shapedManaProgress = null;
        if (applyMutations) {
            if (!o.skipCooldown) {
                Cooldowns.apply(attacker, spell.cooldowns);
            }
            if (!o.skipMana) {
                spendMana(attacker, manaCost);
                if (manaCost > 0) {
                    const {
                        processManaSkillProgression
                    } = require('../character/progression.js');
                    shapedManaProgress = processManaSkillProgression(
                        attacker,
                        manaCost,
                        {
                            sessionConfig: o.sessionConfig,
                            skillProgression: o.skillProgression
                        }
                    );
                }
            }
            applyMoveLock(attacker, moveLock);
            const store = getDelayedCastStore(
                o.sim || null,
                attacker,
                o.delayedStore || null
            );
            scheduleDelayedCast(store, {
                remainingSec: delaySec,
                spell,
                center: placeCenter,
                attacker,
                direction: o.direction || { x: 1, y: 0 },
                spellBook: o.spellBook || null,
                sessionConfig: o.sessionConfig,
                skillProgression: o.skillProgression
            });
        }
        const markerTile = {
            x: placeCenter.x,
            y: placeCenter.y,
            z: placeCenter.z
        };
        return {
            ok: true,
            spell,
            hit: false,
            critical: false,
            final: 0,
            hpDelta: 0,
            breakdown: null,
            range: null,
            moveLock,
            multi: true,
            delayed: true,
            delaySec,
            affectedTiles: [markerTile],
            center: placeCenter,
            direction: o.direction || { x: 1, y: 0 },
            results: [],
            hits: [],
            skillProgress: null,
            manaProgress: shapedManaProgress
        };
    }

    // skipDelay detonation: footprint must use planted center floor, not
    // re-require LoS from the caster's current tile (floor hop / walk-away).
    const foot = computeSpellFootprint({
        attacker,
        primary: o.primary || null,
        spell,
        candidates: o.candidates || [],
        tileMap: o.tileMap || null,
        direction: o.direction,
        center: o.center,
        centerMode: o.centerMode,
        skipCasterLos: o.skipDelay === true
    });

    // Accept cast only when the footprint has at least one tile. Empty
    // footprints (no center, failed area LoS caster→center, unknown shape
    // matrix) must not spend CD / mana / rune via tryAttack.
    if (!foot.affectedTiles || foot.affectedTiles.length === 0) {
        return failShape('no_tiles', spell);
    }

    const z =
        foot.center && foot.center.z !== undefined
            ? foot.center.z
            : attacker.tile
              ? attacker.tile.z
              : 0;

    // Build hit list: candidates on tiles; ensure primary is considered
    let pool = o.candidates ? o.candidates.slice() : [];
    if (o.primary && pool.indexOf(o.primary) < 0) {
        pool.push(o.primary);
    }
    // Never hit self with damage shapes (heals are single-target elsewhere)
    pool = pool.filter((e) => e && e !== attacker);

    let hits = entitiesOnTiles(pool, foot.affectedTiles, z);
    // Phase B: creature shaped hit expands to all living players on tile stacks.
    hits = expandShapedHitsWithStacks(
        hits,
        foot.affectedTiles,
        z,
        attacker,
        o.tileMap || null
    );
    const applyMutations = o.apply !== false;
    const moveLock = resolveMoveLock(spell);
    /** @type {object|null} */
    let shapedManaProgress = null;

    if (applyMutations) {
        if (!o.skipCooldown) {
            Cooldowns.apply(attacker, spell.cooldowns);
        }
        if (!o.skipMana) {
            spendMana(attacker, manaCost);
            // Phase D: mana → ML once for multi-target (skipMana on per-target resolve)
            if (manaCost > 0) {
                const {
                    processManaSkillProgression
                } = require('../character/progression.js');
                shapedManaProgress = processManaSkillProgression(
                    attacker,
                    manaCost,
                    {
                        sessionConfig: o.sessionConfig,
                        skillProgression: o.skillProgression
                    }
                );
            }
        }
        applyMoveLock(attacker, moveLock);

        // Field deploy / destroy is tile-driven (empty tiles still get a field).
        const groundStore =
            o.groundStore ||
            (o.tileMap && (o.tileMap.groundStore || o.tileMap.groundItems)) ||
            null;
        const fieldKind =
            getFieldKind(spell.deploysField) ||
            getFieldKind(spell.field) ||
            getFieldKind(spell);
        const destroysField = spell.destroysField === true;

        if (groundStore && foot.affectedTiles && foot.affectedTiles.length) {
            if (destroysField) {
                for (let k = 0; k < foot.affectedTiles.length; k++) {
                    const t = foot.affectedTiles[k];
                    removeFieldFromTile(groundStore, t.x, t.y, z);
                }
            } else if (fieldKind) {
                const source = isPlayerEntity(attacker) ? 'player' : 'creature';
                // O(candidates) index once — avoid O(tiles × candidates) filter per tile.
                /** @type {Record<string, object[]>} */
                const occByKey = Object.create(null);
                const poolOcc = (o.candidates || []).slice();
                if (o.primary && poolOcc.indexOf(o.primary) < 0) {
                    poolOcc.push(o.primary);
                }
                if (attacker && poolOcc.indexOf(attacker) < 0) {
                    poolOcc.push(attacker);
                }
                const sim = o.sim || (o.tileMap && o.tileMap.sim) || (groundStore && groundStore.sim);
                if (sim && Array.isArray(sim.creatures)) {
                    for (let c = 0; c < sim.creatures.length; c++) {
                        const cr = sim.creatures[c];
                        if (cr && poolOcc.indexOf(cr) < 0) poolOcc.push(cr);
                    }
                }
                for (let i = 0; i < poolOcc.length; i++) {
                    const e = poolOcc[i];
                    if (!e || !e.tile) continue;
                    const ez =
                        e.tile.z !== undefined && e.tile.z !== null ? e.tile.z : 0;
                    if (String(ez) !== String(z)) continue;
                    const k =
                        String(z) +
                        ':' +
                        Math.round(e.tile.x) +
                        ':' +
                        Math.round(e.tile.y);
                    if (!occByKey[k]) occByKey[k] = [];
                    occByKey[k].push(e);
                }

                const obstacleDeploy = isObstacleFieldKind(fieldKind);
                // Optional per-spell duration (barrier 20s / vine 30s; elemental defaults).
                const fieldDurationSec =
                    spell.fieldDurationSec != null &&
                    Number.isFinite(Number(spell.fieldDurationSec))
                        ? Math.max(0, Number(spell.fieldDurationSec))
                        : spell.durationSec != null &&
                            Number.isFinite(Number(spell.durationSec)) &&
                            obstacleDeploy
                          ? Math.max(0, Number(spell.durationSec))
                          : null;

                for (let k = 0; k < foot.affectedTiles.length; k++) {
                    const t = foot.affectedTiles[k];
                    // Obstacles: reject stairs / floor-change tiles (legacy TILESTATE_FLOORCHANGE).
                    if (
                        obstacleDeploy &&
                        o.tileMap &&
                        typeof o.tileMap.isStair === 'function' &&
                        o.tileMap.isStair(t.x, t.y, z)
                    ) {
                        continue;
                    }
                    // Obstacles may land on empty or player-occupied tiles only
                    // (legacy: top creature must be player or none).
                    const key =
                        String(z) +
                        ':' +
                        Math.round(t.x) +
                        ':' +
                        Math.round(t.y);
                    const tileOccs = combatantsOnTileForField(
                        o.tileMap,
                        t.x,
                        t.y,
                        z,
                        occByKey[key] || []
                    );
                    if (obstacleDeploy) {
                        let blockedByCreature = false;
                        for (let oi = 0; oi < tileOccs.length; oi++) {
                            const occ = tileOccs[oi];
                            if (!occ || !occ.alive) continue;
                            if (!isPlayerEntity(occ)) {
                                blockedByCreature = true;
                                break;
                            }
                        }
                        if (blockedByCreature) continue;
                    }
                    // Reject map walls. Existing obstacle fields are replaceable
                    // (friction already blocked by prior barrier/vine).
                    let walkable = true;
                    if (o.tileMap && typeof o.tileMap.isWalkable === 'function') {
                        walkable = o.tileMap.isWalkable(t.x, t.y, z);
                        if (!walkable && obstacleDeploy) {
                            const mask =
                                typeof o.tileMap.getTileFieldMask === 'function'
                                    ? o.tileMap.getTileFieldMask(t.x, t.y, z)
                                    : 0;
                            // bit 16 = FIELD_MASKS.OBSTACLE — allow replace on obstacle tiles
                            if ((mask & 16) !== 0) walkable = true;
                        }
                    }
                    const los =
                        !o.tileMap ||
                        !foot.center ||
                        hasLineOfSight(
                            foot.center.x,
                            foot.center.y,
                            z,
                            t.x,
                            t.y,
                            z,
                            o.tileMap
                        );
                    if (!walkable || !los) continue;
                    /** @type {object} */
                    const deployOpts = {
                        kind: fieldKind,
                        source,
                        id: spell.id || spell.name
                    };
                    if (fieldDurationSec != null) {
                        deployOpts.durationSec = fieldDurationSec;
                    }
                    deployFieldAndTriggerOccupants(
                        groundStore,
                        t.x,
                        t.y,
                        z,
                        deployOpts,
                        // Obstacles deal no entry damage; skip underfoot triggers.
                        obstacleDeploy ? [] : tileOccs
                    );
                }
            }
        }
    }

    /** @type {object[]} */
    const results = [];
    let anyHit = false;
    let anyCrit = false;
    let totalFinal = 0;
    let totalHpDelta = 0;
    let primaryResult = null;

    for (let i = 0; i < hits.length; i++) {
        const defender = hits[i];
        // Per-target: skip CD/mana (already spent); still apply HP
        const r = resolveAttack({
            attacker,
            defender,
            spell,
            spellBook: o.spellBook,
            rng: o.rng,
            skipCooldown: true,
            skipMana: true,
            apply: applyMutations,
            // Phase D: weapon skill tries on primary target only
            grantWeaponSkillTry: defender === o.primary,
            sessionConfig: o.sessionConfig,
            skillProgression: o.skillProgression
        });
        results.push(r);
        if (r.ok && r.hit) {
            anyHit = true;
            if (r.critical) anyCrit = true;
            totalFinal += r.final || 0;
            totalHpDelta += r.hpDelta || 0;
        }
        if (defender === o.primary) primaryResult = r;
    }

    // Prefer primary result for single-target-compatible summary fields
    const summary = primaryResult || results[0] || null;

    return {
        ok: true,
        spell,
        hit: anyHit,
        critical: anyCrit,
        final: summary ? summary.final : totalFinal,
        hpDelta: summary ? summary.hpDelta : totalHpDelta,
        breakdown: summary ? summary.breakdown : null,
        range: summary ? summary.range : null,
        moveLock,
        multi: true,
        affectedTiles: foot.affectedTiles,
        center: foot.center,
        direction: foot.direction,
        results,
        hits,
        skillProgress: summary ? summary.skillProgress : null,
        manaProgress: shapedManaProgress
    };
}

/**
 * @param {string} reason
 * @param {object|null} spell
 */
function failShape(reason, spell) {
    return {
        ok: false,
        reason,
        spell: spell || null,
        hit: false,
        critical: false,
        final: 0,
        hpDelta: 0,
        breakdown: null,
        range: null,
        moveLock: 0,
        multi: true,
        affectedTiles: [],
        center: null,
        direction: { x: 1, y: 0 },
        results: [],
        hits: []
    };
}

module.exports = {
    spellHasShape,
    isSelfCenteredAreaSpell,
    canCastPlayerAreaOnTile,
    expandShapedHitsWithStacks,
    combatantsOnTileForField,
    resolveWaveDirection,
    resolveAreaCenter,
    waveOriginFromCaster,
    computeSpellFootprint,
    resolveShapedAttack
};
