/**
 * Chain (multi-hop) spell resolution — legacy Combat::pickChainTargets parity.
 *
 * Legacy: getChainValue → (maxTargets, chainDistance, backtracking);
 * greedy closest-neighbor hops with Chebyshev box + Euclidean pick + LoS.
 *
 * Catalog: spell.chain = N | { maxTargets, distance?, backtracking? }
 * Engine maxTargets = total creatures damaged (including primary).
 * Default hop distance = 3 (chain_rebuke / executioners_throw family).
 */

'use strict';

const { hasLineOfSight } = require('../shapes.js');
const {
    resolveAttack,
    hasMana,
    spendMana,
    resolveMoveLock,
    applyMoveLock
} = require('./resolve.js');
const Cooldowns = require('./cooldowns.js');

/** Default Chebyshev hop radius when catalog omits distance. */
const DEFAULT_CHAIN_DISTANCE = 3;

/**
 * @param {object|null|undefined} spell
 * @returns {{ maxTargets: number, distance: number, backtracking: boolean }|null}
 */
function normalizeChainSpec(spell) {
    if (!spell || spell.chain == null) return null;
    const c = spell.chain;
    if (typeof c === 'number' && Number.isFinite(c)) {
        const n = Math.max(1, Math.floor(c));
        return {
            maxTargets: n,
            distance: DEFAULT_CHAIN_DISTANCE,
            backtracking: false
        };
    }
    if (typeof c === 'object') {
        const raw =
            c.maxTargets != null
                ? c.maxTargets
                : c.targets != null
                  ? c.targets
                  : c.max != null
                    ? c.max
                    : null;
        if (raw == null || !Number.isFinite(Number(raw))) return null;
        const maxTargets = Math.max(1, Math.floor(Number(raw)));
        const distance =
            c.distance != null && Number.isFinite(Number(c.distance))
                ? Math.max(1, Math.floor(Number(c.distance)))
                : DEFAULT_CHAIN_DISTANCE;
        return {
            maxTargets,
            distance,
            backtracking: c.backtracking === true
        };
    }
    return null;
}

/**
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function spellHasChain(spell) {
    return normalizeChainSpec(spell) != null;
}

/**
 * @param {{x:number,y:number}|null|undefined} a
 * @param {{x:number,y:number}|null|undefined} b
 * @returns {number}
 */
function chebyshevTiles(a, b) {
    if (!a || !b) return Infinity;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * @param {{x:number,y:number}|null|undefined} a
 * @param {{x:number,y:number}|null|undefined} b
 * @returns {number}
 */
function euclideanTiles(a, b) {
    if (!a || !b) return Infinity;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Default hop eligibility (living, same floor, not caster).
 * Callers may pass isValidTarget for invis / party rules.
 *
 * @param {object} caster
 * @param {object} candidate
 * @returns {boolean}
 */
function defaultChainPickable(caster, candidate) {
    if (!candidate || candidate === caster) return false;
    if (candidate.alive === false) return false;
    if (candidate.hp && candidate.hp.current <= 0) return false;
    if (!candidate.tile || !caster || !caster.tile) return false;
    if (String(candidate.tile.z) !== String(caster.tile.z)) return false;
    return true;
}

/**
 * Pick ordered chain hops (legacy greedy closest + optional backtracking).
 *
 * With a primary ≠ caster: primary is hop 0; grow until maxTargets.
 * Without usable primary (self-origin / monster chains): search from caster;
 * caster is never damaged.
 *
 * @param {object} opts
 * @param {object} opts.caster
 * @param {object|null} [opts.primary]
 * @param {object[]} [opts.candidates]
 * @param {number} opts.maxTargets total creatures damaged
 * @param {number} [opts.distance=3] Chebyshev hop radius
 * @param {boolean} [opts.backtracking=false]
 * @param {object|null} [opts.tileMap] for LoS walls
 * @param {(caster:object, candidate:object)=>boolean} [opts.canPick]
 * @returns {{ hops: object[], links: {from:{x,y,z?},to:{x,y,z?},fromId?:*,toId?:*}[] }}
 */
function pickChainTargets(opts) {
    const o = opts || {};
    const caster = o.caster;
    const maxTargets = Math.max(1, Math.floor(Number(o.maxTargets) || 1));
    const distance = Math.max(
        1,
        Math.floor(Number(o.distance) || DEFAULT_CHAIN_DISTANCE)
    );
    const backtracking = o.backtracking === true;
    const tileMap = o.tileMap || null;
    const canPick =
        typeof o.canPick === 'function' ? o.canPick : defaultChainPickable;

    /** @type {object[]} */
    const hops = [];
    /** @type {{from:{x,y,z?},to:{x,y,z?},fromId?:*,toId?:*}[]} */
    const links = [];
    if (!caster || !caster.tile) {
        return { hops, links };
    }

    const pool = Array.isArray(o.candidates) ? o.candidates.slice() : [];
    const primary = o.primary || null;
    if (primary && pool.indexOf(primary) < 0) pool.push(primary);

    /** @type {Set<object>} */
    const visited = new Set();

    /**
     * @param {object} fromEntity entity whose tile is the hop origin
     * @returns {object|null}
     */
    function closestFrom(fromEntity) {
        if (!fromEntity || !fromEntity.tile) return null;
        const fromTile = fromEntity.tile;
        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < pool.length; i++) {
            const cand = pool[i];
            if (!cand || visited.has(cand)) continue;
            if (!cand.tile) continue;
            if (String(cand.tile.z) !== String(fromTile.z)) continue;
            if (chebyshevTiles(fromTile, cand.tile) > distance) continue;
            if (!canPick(caster, cand)) {
                visited.add(cand);
                continue;
            }
            if (
                !hasLineOfSight(
                    fromTile.x,
                    fromTile.y,
                    fromTile.z,
                    cand.tile.x,
                    cand.tile.y,
                    cand.tile.z,
                    tileMap
                )
            ) {
                continue;
            }
            const d = euclideanTiles(fromTile, cand.tile);
            if (d < bestDist) {
                bestDist = d;
                best = cand;
            }
        }
        return best;
    }

    // Seed: primary hop (legacy always accepts initialTarget ≠ caster without
    // chain-picker) or self-origin search from caster (monster chains).
    /** @type {object[]} path stack for backtracking (includes origin when self) */
    const stack = [];
    const primaryOk =
        primary &&
        primary !== caster &&
        primary.tile &&
        primary.alive !== false &&
        !(primary.hp && primary.hp.current <= 0) &&
        String(primary.tile.z) === String(caster.tile.z);

    if (primaryOk) {
        hops.push(primary);
        visited.add(primary);
        stack.push(primary);
        links.push({
            from: {
                x: caster.tile.x,
                y: caster.tile.y,
                z: caster.tile.z
            },
            to: {
                x: primary.tile.x,
                y: primary.tile.y,
                z: primary.tile.z
            },
            fromId: caster.id,
            toId: primary.id
        });
    } else {
        // Legacy: start search from caster; caster is not a damage target.
        stack.push(caster);
        visited.add(caster);
    }

    let backtrackingAttempts = 10;
    while (
        stack.length > 0 &&
        hops.length < maxTargets &&
        backtrackingAttempts > 0
    ) {
        const current = stack[stack.length - 1];
        const next = closestFrom(current);
        if (next) {
            hops.push(next);
            visited.add(next);
            stack.push(next);
            links.push({
                from: {
                    x: current.tile.x,
                    y: current.tile.y,
                    z: current.tile.z
                },
                to: {
                    x: next.tile.x,
                    y: next.tile.y,
                    z: next.tile.z
                },
                fromId: current.id,
                toId: next.id
            });
            continue;
        }
        if (backtracking) {
            stack.pop();
            backtrackingAttempts--;
            continue;
        }
        break;
    }

    // Safety cap (loop should already honor maxTargets).
    if (hops.length > maxTargets) {
        hops.length = maxTargets;
        links.length = 0;
        let prev = caster;
        for (let i = 0; i < hops.length; i++) {
            const h = hops[i];
            if (!prev || !prev.tile || !h.tile) continue;
            links.push({
                from: {
                    x: prev.tile.x,
                    y: prev.tile.y,
                    z: prev.tile.z
                },
                to: { x: h.tile.x, y: h.tile.y, z: h.tile.z },
                fromId: prev.id,
                toId: h.id
            });
            prev = h;
        }
    }

    return { hops, links };
}

/**
 * Resolve a chain spell: mana/CD once, full damage per hop (no split).
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object|null} [opts.primary]
 * @param {object} opts.spell spell with .chain
 * @param {object[]} [opts.candidates]
 * @param {object|null} [opts.tileMap]
 * @param {object|null} [opts.spellBook]
 * @param {function():number} [opts.rng]
 * @param {boolean} [opts.apply=true]
 * @param {boolean} [opts.skipCooldown]
 * @param {boolean} [opts.skipMana]
 * @param {(caster:object, candidate:object)=>boolean} [opts.canPick]
 * @param {object} [opts.sessionConfig]
 * @param {object} [opts.skillProgression]
 * @returns {object}
 */
function resolveChainAttack(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const spell = o.spell;
    if (!attacker || !spell) {
        return failChain('missing_combatant', null);
    }
    const spec = normalizeChainSpec(spell);
    if (!spec) {
        return failChain('no_chain', spell);
    }

    if (!o.skipCooldown) {
        Cooldowns.ensureCooldowns(attacker);
        if (!Cooldowns.canUse(attacker, spell.cooldowns)) {
            return failChain('cooldown', spell);
        }
    }
    const manaCost = spell.mana != null ? spell.mana : 0;
    if (!o.skipMana && !hasMana(attacker, manaCost)) {
        return failChain('mana', spell);
    }

    const picked = pickChainTargets({
        caster: attacker,
        primary: o.primary || null,
        candidates: o.candidates || [],
        maxTargets: spec.maxTargets,
        distance: spec.distance,
        backtracking: spec.backtracking,
        tileMap: o.tileMap || null,
        canPick: o.canPick
    });

    const hops = picked.hops;
    if (!hops.length) {
        return failChain('no_targets', spell);
    }

    const applyMutations = o.apply !== false;
    const moveLock = resolveMoveLock(spell);
    /** @type {object|null} */
    let chainManaProgress = null;

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
                chainManaProgress = processManaSkillProgression(
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
    }

    /** @type {object[]} */
    const results = [];
    let anyHit = false;
    let anyCrit = false;
    let totalFinal = 0;
    let totalHpDelta = 0;
    let primaryResult = null;

    for (let i = 0; i < hops.length; i++) {
        const defender = hops[i];
        const r = resolveAttack({
            attacker,
            defender,
            spell,
            spellBook: o.spellBook,
            rng: o.rng,
            skipCooldown: true,
            skipMana: true,
            apply: applyMutations,
            grantWeaponSkillTry: defender === o.primary,
            sessionConfig: o.sessionConfig,
            skillProgression: o.skillProgression
        });
        results.push(r);
        if (r && r.ok) {
            if (r.hit) anyHit = true;
            if (r.critical) anyCrit = true;
            totalFinal += r.final || 0;
            totalHpDelta += r.hpDelta || 0;
        }
        if (defender === o.primary || (i === 0 && !primaryResult)) {
            primaryResult = r;
        }
    }

    const summary = primaryResult || results[0] || null;
    const affectedTiles = hops
        .filter((h) => h && h.tile)
        .map((h) => ({
            x: h.tile.x,
            y: h.tile.y,
            z: h.tile.z
        }));

    return {
        ok: true,
        reason: null,
        spell,
        hit: anyHit,
        critical: anyCrit,
        final: summary ? summary.final : totalFinal,
        hpDelta: summary ? summary.hpDelta : totalHpDelta,
        breakdown: summary ? summary.breakdown : null,
        range: summary ? summary.range : null,
        moveLock,
        multi: true,
        chain: true,
        chainSpec: spec,
        chainLinks: picked.links,
        affectedTiles,
        center: o.primary && o.primary.tile ? o.primary.tile : affectedTiles[0] || null,
        direction: { x: 1, y: 0 },
        results,
        hits: hops,
        skillProgress: summary ? summary.skillProgress : null,
        manaProgress: chainManaProgress
    };
}

/**
 * @param {string} reason
 * @param {object|null} spell
 */
function failChain(reason, spell) {
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
        chain: true,
        chainLinks: [],
        affectedTiles: [],
        center: null,
        direction: { x: 1, y: 0 },
        results: [],
        hits: []
    };
}

module.exports = {
    DEFAULT_CHAIN_DISTANCE,
    normalizeChainSpec,
    spellHasChain,
    chebyshevTiles,
    euclideanTiles,
    defaultChainPickable,
    pickChainTargets,
    resolveChainAttack
};
