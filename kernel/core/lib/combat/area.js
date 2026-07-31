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
const Cooldowns = require('./cooldowns.js');
const {
    getFieldKind,
    deployFieldAndTriggerOccupants,
    removeFieldFromTile,
    isPlayerEntity
} = require('./elemental_fields.js');

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
 * Ranged: best multi-hit center with LoS, else primary target tile.
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object|null} opts.primary
 * @param {object} opts.spell
 * @param {object[]} [opts.candidates]
 * @param {object|null} [opts.tileMap]
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

    // Prefer centers that maximize hits among targets in spell range
    const inRange = [];
    for (let i = 0; i < candidates.length; i++) {
        const e = candidates[i];
        if (!e || !e.tile || e.alive === false) continue;
        if (e.hp && e.hp.current <= 0) continue;
        if (String(e.tile.z) !== String(z)) continue;
        const dx = Math.abs(e.tile.x - attacker.tile.x);
        const dy = Math.abs(e.tile.y - attacker.tile.y);
        if (Math.max(dx, dy) <= range) inRange.push(e);
    }
    if (primary && primary.tile && String(primary.tile.z) === String(z)) {
        let hasP = false;
        for (let i = 0; i < inRange.length; i++) {
            if (inRange[i] === primary) {
                hasP = true;
                break;
            }
        }
        if (!hasP) {
            const dx = Math.abs(primary.tile.x - attacker.tile.x);
            const dy = Math.abs(primary.tile.y - attacker.tile.y);
            if (Math.max(dx, dy) <= range) inRange.push(primary);
        }
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
            if (
                hasLineOfSight(
                    attacker.tile.x,
                    attacker.tile.y,
                    z,
                    e.tile.x,
                    e.tile.y,
                    z,
                    tileMap
                )
            ) {
                return {
                    x: e.tile.x,
                    y: e.tile.y,
                    z: e.tile.z !== undefined ? e.tile.z : z
                };
            }
        }
    }

    if (spell.shape && inRange.length && !areaShapeUsesDirection(spell.shape)) {
        const ranked = findTopAreaCenters(
            attacker.tile,
            inRange,
            spell.shape,
            12
        );
        for (let i = 0; i < ranked.length; i++) {
            const c = ranked[i];
            if (
                hasLineOfSight(
                    attacker.tile.x,
                    attacker.tile.y,
                    z,
                    c.x,
                    c.y,
                    z,
                    tileMap
                )
            ) {
                return { x: c.x, y: c.y, z };
            }
        }
    }

    if (primary && primary.tile) {
        return {
            x: primary.tile.x,
            y: primary.tile.y,
            z: primary.tile.z !== undefined ? primary.tile.z : z
        };
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
                tileMap: o.tileMap || null
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

    const affectedTiles = getAffectedTiles({
        caster: attacker.tile,
        center,
        shape: spell.shape,
        direction,
        tileMap: o.tileMap || null
    });

    return { spellType, center, direction, affectedTiles };
}

/**
 * Resolve a shaped spell against all living candidates on the footprint.
 * Mana / cooldowns / moveLock applied once when the cast is accepted
 * (even if zero defenders are hit — empty field tiles still deploy).
 * Zero footprint tiles → `ok: false`, reason `no_tiles` (no CD/mana/rune).
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

    const foot = computeSpellFootprint({
        attacker,
        primary: o.primary || null,
        spell,
        candidates: o.candidates || [],
        tileMap: o.tileMap || null,
        direction: o.direction,
        center: o.center
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

    const hits = entitiesOnTiles(pool, foot.affectedTiles, z);
    const applyMutations = o.apply !== false;
    const moveLock = resolveMoveLock(spell);

    if (applyMutations) {
        if (!o.skipCooldown) {
            Cooldowns.apply(attacker, spell.cooldowns);
        }
        if (!o.skipMana) {
            spendMana(attacker, manaCost);
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

                for (let k = 0; k < foot.affectedTiles.length; k++) {
                    const t = foot.affectedTiles[k];
                    const walkable =
                        !o.tileMap ||
                        typeof o.tileMap.isWalkable !== 'function' ||
                        o.tileMap.isWalkable(t.x, t.y, z);
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
                    const key =
                        String(z) +
                        ':' +
                        Math.round(t.x) +
                        ':' +
                        Math.round(t.y);
                    const tileOccs = (occByKey[key] || []).slice();
                    if (o.tileMap && typeof o.tileMap.getOccupant === 'function' && typeof o.tileMap.resolveOccupant === 'function') {
                        const occId = o.tileMap.getOccupant(t.x, t.y, z);
                        if (occId) {
                            const ent = o.tileMap.resolveOccupant(occId);
                            if (ent && tileOccs.indexOf(ent) < 0) {
                                tileOccs.push(ent);
                            }
                        }
                    }
                    deployFieldAndTriggerOccupants(
                        groundStore,
                        t.x,
                        t.y,
                        z,
                        { kind: fieldKind, source, id: spell.id || spell.name },
                        tileOccs
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
            apply: applyMutations
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
        hits
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
    resolveWaveDirection,
    resolveAreaCenter,
    waveOriginFromCaster,
    computeSpellFootprint,
    resolveShapedAttack
};
