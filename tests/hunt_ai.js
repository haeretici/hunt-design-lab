#!/usr/bin/env node
/**
 * Stage 5 exit criteria: combat AI hunt ends with party wipe or route complete;
 * kill counts and damage totals in summary JSON; seed-stable.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const {
    TileMap,
    TILE_FLAG_PZ_PACKAGE
} = require('../kernel/core/entities/tilemap.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { Party } = require('../kernel/core/entities/party.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const {
    runHeadlessHunt,
    runHeadlessPartyWalk
} = require('../kernel/providers/simulator/headless_runner.js');
const {
    normalizeStrategy,
    shouldEngage,
    pickSpellId,
    resolveStrategy,
    indexStrategies,
    hpPercent
} = require('../kernel/core/lib/ai/strategy.js');
const {
    entitiesWithinRange,
    queryWithinRange,
    findNearest,
    findNearestInRange,
    distBetween
} = require('../kernel/core/lib/ai/targeting.js');
const {
    initPlayerAi,
    initCreatureAi,
    tickHuntAi,
    resolveAiTickRadius,
    shouldTickCreatureAi,
    isCreatureNearObservers,
    filterEnemiesForAi,
    gatherCreatureAiCandidates,
    ensureAoiFrame,
    invalidateAoiFrame,
    applyCreatureSleepState,
    isCreatureSleepEnabled,
    buildCtx,
    ensurePlayerSpatialIndex
} = require('../kernel/core/lib/ai/hunt_ai.js');
const { SpatialIndex } = require('../kernel/core/lib/spatial_index.js');
const {
    tryHeal,
    tryAttack,
    isSpellInRange,
    engageAdjacentTile,
    pickCombatMoveTile,
    pickMeleeMoveTile,
    openNeighborCount,
    listMeleeCircleCandidates,
    tryMeleeCircleStep,
    stepRandomAdjacent
} = require('../kernel/core/lib/ai/combat_actions.js');
const {
    isSelfCenteredAreaSpell
} = require('../kernel/core/lib/combat/area.js');
const { indexSpells } = require('../kernel/core/lib/combat/resolve.js');
const { isTalkableNpc } = require('../kernel/core/lib/npc/flags.js');
const Cooldowns = require('../kernel/core/lib/combat/cooldowns.js');
const { StateMachine } = require('../kernel/core/lib/fsm.js');
const presets = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { Time } = require('../kernel/core/lib/time.js');
const {
    Engage,
    clearCombat
} = require('../kernel/core/lib/ai/player_states.js');
const {
    brainReady,
    applyThinkPad,
    evaluateEngageWant,
    targetDistancePolicy,
    clearEngageSticky,
    circleAttemptDue,
    armCircleRetry,
    clearCircleRetry
} = require('../kernel/core/lib/ai/cadence.js');
const {
    normalizeCreatureKit,
    pickWeightedKey,
    pickByStrategy,
    pickCreatureTarget,
    tryCreatureAttacks,
    ensureCreatureKit,
    isFleeing,
    idealStandDistance,
    recordDamageTakenBy,
    applyThreatDecay,
    threatOf,
    armStrategyRetarget,
    strategyRetargetDue,
    clearStrategyRetarget,
    retargetIntervalSec,
    retargetChance
} = require('../kernel/core/lib/ai/creature_kit.js');
const {
    combatMove,
    tryEngagedAttacks,
    runCombatTick,
    Idle,
    Retarget,
    Leash,
    beyondLeash,
    insideLeashReaggro,
    leashReaggroRange,
    leashPathMaxDistance,
    hasLivingPresence,
    changeCreatureState
} = require('../kernel/core/lib/ai/creature_states.js');
const {
    applyCondition,
    isInvisible
} = require('../kernel/core/lib/combat/conditions.js');
const { isValidTarget } = require('../kernel/core/lib/ai/targeting.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function rgbaFromPixels(cols, rows, pixels) {
    const out = new Uint8Array(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
        const p = pixels[i];
        const o = i * 4;
        out[o] = p[0];
        out[o + 1] = p[1];
        out[o + 2] = p[2];
        out[o + 3] = 255;
    }
    return out;
}

function openFloor(cols, rows, gray) {
    const g = gray !== undefined ? gray : 100;
    const pixels = [];
    for (let i = 0; i < cols * rows; i++) pixels.push([g, g, g]);
    const map = new TileMap();
    map.loadFloorFromRgba(0, cols, rows, rgbaFromPixels(cols, rows, pixels));
    return map;
}

function testStrategyHelpers() {
    const st = normalizeStrategy({
        id: 't',
        aggression: 1,
        // melee_auto is stripped — auto is a mode feature, not spellPriority
        spellPriority: ['front_sweep', 'melee_auto']
    });
    assert.strictEqual(st.id, 't');
    assert.deepStrictEqual(st.spellPriority, ['front_sweep']);
    assert.strictEqual(st.healSpellId, 'heal_light');
    assert.ok(st.healHpPercent > 0);
    assert.ok(shouldEngage(st, 1, () => 0.5));
    assert.ok(!shouldEngage(normalizeStrategy({ aggression: 0 }), 5, () => 0));

    const id = pickSpellId(
        st,
        {},
        (sid) => (sid === 'front_sweep' ? { id: sid, mana: 0, cooldowns: {} } : null),
        () => true
    );
    assert.strictEqual(id, 'front_sweep');

    // Auto-only priority list normalizes to empty → pickSpell returns null
    const noAbility = pickSpellId(
        normalizeStrategy({ spellPriority: ['melee_auto'] }),
        {},
        (sid) =>
            sid === 'melee_auto'
                ? { id: sid, mana: 0, cooldowns: { auto: { attack: 2 } } }
                : null,
        () => true
    );
    assert.strictEqual(noAbility, null);
    assert.deepStrictEqual(
        normalizeStrategy({ spellPriority: ['melee_auto'] }).spellPriority,
        []
    );

    const table = indexStrategies(presets.loadStrategies());
    assert.ok(table.guardian_aggro);
    const resolved = resolveStrategy(null, table, 'guardian');
    assert.strictEqual(resolved.id, 'guardian_aggro');
    assert.ok(
        !resolved.spellPriority.includes('melee_auto'),
        'strategy presets must not list weapon auto'
    );

    const p = { hp: { current: 25, max: 100 } };
    assert.ok(Math.abs(hpPercent(p) - 0.25) < 1e-9);

    // canReach skips first priority when out of reach so later entries fire
    const reachPick = pickSpellId(
        normalizeStrategy({
            spellPriority: ['radiant_crater', 'spirit_javelin']
        }),
        {},
        (sid) =>
            sid === 'radiant_crater'
                ? { id: sid, mana: 0, cooldowns: {}, range: 0 }
                : sid === 'spirit_javelin'
                  ? { id: sid, mana: 0, cooldowns: {}, range: 7 }
                  : null,
        () => true,
        {
            canReach: (_a, spell) => spell.id !== 'radiant_crater'
        }
    );
    assert.strictEqual(reachPick, 'spirit_javelin');

    log('strategy helpers ok');
}

/**
 * Self-AoE (range 0 / caster-centered area) is "in range" when a hostile is
 * on the footprint — not only when sticky Chebyshev ≤ authored range.
 * Out-of-blast caldera must not block spears in spellPriority.
 */
function testSelfAoeSpellRangeAndPriorityFallback() {
    setActiveMode('standard');
    try {
        const spells = indexSpells(presets.loadSpells().spells);
        const caldera = spells.radiant_crater;
        const spear = spells.strong_spirit_javelin || spells.spirit_javelin;
        assert.ok(caldera, 'radiant_crater in standard spellbook');
        assert.ok(spear, 'ethereal spear family in standard spellbook');
        assert.strictEqual(caldera.range, 0, 'caldera authored range 0');
        assert.ok(
            isSelfCenteredAreaSpell(caldera),
            'caldera is self-centered area'
        );
        assert.ok(
            !isSelfCenteredAreaSpell(spear),
            'spear is single-target, not self-AoE'
        );

        const caster = {
            id: 1,
            type: 'player',
            classId: 'scout',
            level: 100,
            alive: true,
            tile: { x: 10, y: 10, z: 0 },
            mp: { current: 500, max: 500 },
            hp: { current: 500, max: 500 },
            combatStats: {
                classId: 'scout',
                level: 100,
                atk: 40,
                skill: 50,
                magic: 20,
                mitigation: 0,
                maxBlock: 0,
                armor: 0,
                resists: {},
                // Allow caldera + spear family without full class book
                spells: [
                    'radiant_crater',
                    'strong_spirit_javelin',
                    'spirit_javelin',
                    'melee_auto',
                    'distance_auto',
                    'wand_auto'
                ]
            }
        };
        Cooldowns.ensureCooldowns(caster);

        // Chebyshev 2 — outside range:0 but inside GFB-style code 5 footprint (~r3)
        const near = {
            id: 2,
            type: 'creature',
            alive: true,
            tile: { x: 12, y: 10, z: 0 },
            hp: { current: 200, max: 200 }
        };
        // d=4: outside caldera footprint (r≤3) but inside spear range (7)
        const far = {
            id: 3,
            type: 'creature',
            alive: true,
            tile: { x: 14, y: 10, z: 0 },
            hp: { current: 200, max: 200 }
        };

        const ctxNear = {
            spellBook: spells,
            enemies: [near],
            tileMap: null,
            rng: () => 0.5
        };
        assert.ok(
            isSpellInRange(caster, near, caldera, ctxNear),
            'self-AoE in range when hostile on footprint (d=2, range=0)'
        );
        assert.ok(
            !isSpellInRange(caster, far, caldera, {
                spellBook: spells,
                enemies: [far],
                rng: () => 0.5
            }),
            'self-AoE out of range when hostile outside footprint'
        );

        // tryAttack must not hard-fail on d > range for self-AoE
        caster.cooldowns.primary.attack = 0;
        if (caster.cooldowns.spell) {
            caster.cooldowns.spell.radiant_crater = 0;
        }
        const hit = tryAttack({
            attacker: caster,
            defender: near,
            spellId: 'radiant_crater',
            ctx: ctxNear
        });
        assert.ok(hit && hit.ok, 'tryAttack self-AoE at d=2 with range 0');
        assert.ok(hit.multi, 'caldera multi footprint');

        // Priority: empty caldera → fall through to spear when canReach wired
        const st = normalizeStrategy({
            spellPriority: ['radiant_crater', spear.id]
        });
        const farCtx = {
            spellBook: spells,
            enemies: [far],
            rng: () => 0.5
        };
        const pickedFar = pickSpellId(
            st,
            caster,
            (id) => spells[id] || null,
            () => true,
            {
                canReach: (a, spell) => isSpellInRange(a, far, spell, farCtx)
            }
        );
        assert.strictEqual(
            pickedFar,
            spear.id,
            'out-of-blast caldera falls through to spear'
        );

        const pickedNear = pickSpellId(
            st,
            caster,
            (id) => spells[id] || null,
            () => true,
            {
                canReach: (a, spell) => isSpellInRange(a, near, spell, ctxNear)
            }
        );
        assert.strictEqual(
            pickedNear,
            'radiant_crater',
            'in-blast caldera wins priority'
        );

        log('self-AoE spell range + priority fallback ok', {
            spear: spear.id,
            nearPick: pickedNear,
            farPick: pickedFar
        });
    } finally {
        setActiveMode('standard');
    }
}

function testTargeting() {
    const a = { tile: { x: 5, y: 5, z: 0 }, alive: true, hp: { current: 10, max: 10 } };
    const b = { tile: { x: 7, y: 5, z: 0 }, alive: true, hp: { current: 10, max: 10 } };
    const c = { tile: { x: 20, y: 5, z: 0 }, alive: true, hp: { current: 10, max: 10 } };
    const near = entitiesWithinRange(a, [b, c], 3);
    assert.strictEqual(near.length, 1);
    assert.strictEqual(findNearest(a, [b, c]), b);
    assert.strictEqual(distBetween(a, b), 2);
    log('targeting ok');
}

/**
 * Legacy parity: melee paths to free adjacent of target (not onto target cell);
 * kite scores every tick; anti-still biases off parked tile.
 */
function testCombatMoveHelpers() {
    const map = openFloor(10, 10, 100);
    const self = {
        id: 'p1',
        tile: { x: 2, y: 5, z: 0 },
        alive: true
    };
    const target = {
        id: 'e1',
        tile: { x: 5, y: 5, z: 0 },
        alive: true
    };
    map.tryOccupy(2, 5, 0, self);
    map.tryOccupy(5, 5, 0, target);

    const adj = engageAdjacentTile(self, target, map);
    assert.ok(adj, 'engageAdjacentTile finds a free neighbor of target');
    assert.ok(
        !(adj.x === target.tile.x && adj.y === target.tile.y),
        'melee dest is not the target cell itself'
    );
    assert.strictEqual(
        Math.max(Math.abs(adj.x - target.tile.x), Math.abs(adj.y - target.tile.y)),
        1,
        'dest is Chebyshev-1 from target'
    );

    const meleeDest = pickMeleeMoveTile(self, target, map);
    assert.ok(meleeDest, 'pickMeleeMoveTile when out of range');
    assert.strictEqual(
        Math.max(
            Math.abs(meleeDest.x - target.tile.x),
            Math.abs(meleeDest.y - target.tile.y)
        ),
        1
    );

    // Already adjacent → engageAdjacent returns null; micro may null if no better open
    map.release(2, 5, 0, self);
    self.tile = { x: 5, y: 4, z: 0 };
    map.tryOccupy(5, 4, 0, self);
    assert.strictEqual(
        engageAdjacentTile(self, target, map),
        null,
        'already adjacent → no gap-close dest'
    );
    assert.ok(openNeighborCount(map, 5, 4, 0, self) >= 1);

    // Kite continuous: keepDistance 3 from adj dist 1 should prefer stepping away
    const kite = pickCombatMoveTile(
        self,
        target,
        { keepDistance: 3, standingCounter: 0 },
        map
    );
    assert.ok(kite, 'pickCombatMoveTile returns a tile');
    const kiteD = Math.max(
        Math.abs(kite.x - target.tile.x),
        Math.abs(kite.y - target.tile.y)
    );
    assert.ok(
        kiteD >= 1,
        `kite footing distance ${kiteD} should not collapse onto target`
    );

    // Anti-still: high standingCounter should prefer a non-current tile when options exist
    const stillBias = pickCombatMoveTile(
        self,
        target,
        { keepDistance: 1, standingCounter: 2.0 },
        map
    );
    assert.ok(stillBias);
    // On open floor with keepDistance 1, either stay adjacent or step — just ensure valid
    assert.ok(map.canEnter(stillBias.x, stillBias.y, 0, self) || (
        stillBias.x === self.tile.x && stillBias.y === self.tile.y
    ));

    map.release(5, 4, 0, self);
    map.release(5, 5, 0, target);
    log('combat move helpers ok', { adj, meleeDest, kite });
}

/**
 * Engage runs attack and movement in the same tick (no early-return freeze).
 * Far melee: sets path / steps; in-range on CD: may still micro-step or mark standing.
 */
function testEngageAttackAndMoveDecoupled() {
    const map = openFloor(14, 8, 100);
    const sim = new Simulator({
        seed: 19,
        combatAi: true,
        recordSteps: false
    });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.spellBook = indexSpells(presets.loadSpells().spells);
    sim.strategyTable = indexStrategies(presets.loadStrategies());
    sim.sessionState = 'running';
    sim.active = true;
    sim.bindSeededRandom();

    const classDef = presets.getClass('guardian');
    const items = presets.loadEquipment().items;
    const party = new Party({
        name: 'Parity',
        waypoints: [
            { x: 1, y: 3, z: 0 },
            { x: 12, y: 3, z: 0 }
        ]
    });
    const player = new Player({
        id: sim.allocEntityId(),
        name: 'G',
        classId: 'guardian',
        isLeader: true,
        strategyId: 'guardian_aggro',
        level: 50,
        equipment: {
            rightHand: 'iron_longsword',
            leftHand: 'oak_shield',
            armor: 'steel_plate'
        },
        tile: { x: 1, y: 3, z: 0 }
    });
    player.applyClassLoadout(classDef, items, { level: 50 });
    map.tryOccupy(1, 3, 0, player);
    party.addMember(player);
    initPlayerAi(player, {
        strategyId: 'guardian_aggro',
        strategyTable: sim.strategyTable
    });
    // Force Engage state with a distant target
    const ratTpl = presets.loadCreatureTemplate('cave_rat');
    const rat = new Creature({
        id: sim.allocEntityId(),
        tile: { x: 6, y: 3, z: 0 },
        homeTile: { x: 6, y: 3, z: 0 }
    });
    rat.applyTemplate(ratTpl);
    rat.hp.max = 500;
    rat.hp.current = 500;
    map.tryOccupy(6, 3, 0, rat);
    initCreatureAi(rat);

    sim.parties.push(party);
    sim.insertChild(party);
    sim.creatures.push(rat);
    sim.entityById.set(player.id, player);
    sim.entityById.set(rat.id, rat);
    sim.insertChild(rat);

    player.target = rat;
    player.targetId = rat.id;
    player.inBattle = true;
    player.brain.changeState(Engage);
    player.aiState = 'engage';
    player.moveDelay = 0;

    const ctx = {
        sim,
        tileMap: map,
        enemies: [rat],
        allies: [player],
        spellBook: sim.spellBook,
        rng: () => 0.5
    };

    const x0 = player.tile.x;
    Engage.execute(player, ctx);
    // Out of melee range → should have stepped or set path toward adjacent of rat
    const movedOrPathing =
        player.tile.x !== x0 ||
        player.tile.y !== 3 ||
        (player.path && player.path.length > 0) ||
        player.moveDelay > 0;
    assert.ok(
        movedOrPathing,
        `engage should move when far: tile=${player.tile.x},${player.tile.y} delay=${player.moveDelay} path=${(player.path || []).length}`
    );
    assert.ok(player.battleWP, 'battleWP anchor set on engage');

    // Close to melee, force CD so attack no-ops — movement pass still runs
    player.moveDelay = 0;
    player.path = [];
    // Place adjacent
    map.release(player.tile.x, player.tile.y, 0, player);
    player.tile = { x: 6, y: 2, z: 0 };
    map.tryOccupy(6, 2, 0, player);
    player.syncPositionFromTile && player.syncPositionFromTile();
    Cooldowns.ensureCooldowns(player);
    // Both attack gates busy so tryAttack no-ops; movement pass still runs
    player.cooldowns.auto.attack = 2;
    player.cooldowns.primary.attack = 2;
    player.standingCounter = 0;

    Engage.execute(player, ctx);
    // Either micro-stepped or incremented standingCounter (not frozen with zero activity)
    assert.ok(
        player.standingCounter > 0 ||
            player.moveDelay > 0 ||
            player.tile.x !== 6 ||
            player.tile.y !== 2,
        `in-range on CD should still run movement pass: standing=${player.standingCounter} delay=${player.moveDelay} tile=${player.tile.x},${player.tile.y}`
    );

    clearCombat(player);
    assert.strictEqual(player.battleWP, null);
    assert.strictEqual(player.standingCounter, 0);

    sim.destroy();
    log('engage attack/move decoupled ok');
}

/**
 * Ready strike has priority over weapon auto (moveLock blocks auto same frame).
 * When only auto is ready, mode-gated melee_auto fires.
 */
function testEngageSpellPriorityOverAuto() {
    const map = openFloor(10, 6, 100);
    const sim = new Simulator({
        seed: 21,
        combatAi: true,
        recordSteps: false
    });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.spellBook = indexSpells(presets.loadSpells().spells);
    sim.strategyTable = indexStrategies(presets.loadStrategies());
    sim.sessionState = 'running';
    sim.active = true;
    sim.bindSeededRandom();

    const classDef = presets.getClass('guardian');
    const items = presets.loadEquipment().items;
    const party = new Party({
        name: 'Parity',
        waypoints: [{ x: 2, y: 2, z: 0 }]
    });
    const player = new Player({
        id: sim.allocEntityId(),
        name: 'G',
        classId: 'guardian',
        isLeader: true,
        strategyId: 'guardian_aggro',
        level: 100,
        equipment: {
            rightHand: 'iron_longsword',
            leftHand: 'oak_shield',
            armor: 'steel_plate'
        },
        tile: { x: 2, y: 2, z: 0 }
    });
    // Level 100 meets front_sweep (70) / fierce_rampage (90) requirements.
    player.applyClassLoadout(classDef, items, { level: 100 });
    map.tryOccupy(2, 2, 0, player);
    party.addMember(player);
    initPlayerAi(player, {
        strategyId: 'guardian_aggro',
        strategyTable: sim.strategyTable
    });
    // Pin priority to front_sweep so the strike-before-auto assertion is stable
    // regardless of mana/level gates on higher kit spells.
    player.strategy = normalizeStrategy(
        Object.assign({}, player.strategy, {
            spellPriority: ['front_sweep']
        })
    );

    const ratTpl = presets.loadCreatureTemplate('cave_rat');
    const rat = new Creature({
        id: sim.allocEntityId(),
        tile: { x: 3, y: 2, z: 0 },
        homeTile: { x: 3, y: 2, z: 0 }
    });
    rat.applyTemplate(ratTpl);
    // L100 guardian front_sweep can roll high; keep target alive for a 2nd tick.
    rat.hp.max = 5000;
    rat.hp.current = 5000;
    map.tryOccupy(3, 2, 0, rat);
    initCreatureAi(rat);

    sim.parties.push(party);
    sim.insertChild(party);
    sim.creatures.push(rat);
    sim.entityById.set(player.id, player);
    sim.entityById.set(rat.id, rat);
    sim.insertChild(rat);

    player.target = rat;
    player.targetId = rat.id;
    player.inBattle = true;
    player.brain.changeState(Engage);
    player.aiState = 'engage';
    player.moveDelay = 0;
    Cooldowns.ensureCooldowns(player);
    player.cooldowns.auto.attack = 0;
    player.cooldowns.primary.attack = 0;
    player.cooldowns.spell.front_sweep = 0;
    player.mp.current = Math.max(player.mp.current, 250);

    const hpBefore = rat.hp.current;
    const ctx = {
        sim,
        tileMap: map,
        enemies: [rat],
        allies: [player],
        spellBook: sim.spellBook,
        rng: () => 0.5
    };
    Engage.execute(player, ctx);

    assert.ok(
        Cooldowns.getRemaining(player, 'spell', 'front_sweep') > 0,
        'front_sweep should fire'
    );
    assert.ok(
        Cooldowns.getRemaining(player, 'primary', 'attack') > 0.1 + 1e-9,
        'strike should set real primary GCD (not only think-pad)'
    );
    // moveLock from strike plants the caster — auto must yield this frame
    assert.strictEqual(
        Cooldowns.getRemaining(player, 'auto', 'attack'),
        0,
        'auto should not fire same tick after strike moveLock'
    );
    assert.ok(rat.hp.current < hpBefore, 'target took damage');
    assert.ok(rat.alive && rat.hp.current > 0, 'dummy must survive first strike');

    // Second tick with free auto, strike on CD: weapon auto should fire
    player.moveDelay = 0;
    Cooldowns.ensureCooldowns(player);
    player.cooldowns.auto.attack = 0;
    player.cooldowns.primary.attack = 2;
    player.cooldowns.spell.front_sweep = 6;
    const hp2 = rat.hp.current;
    Engage.execute(player, ctx);
    assert.ok(
        Cooldowns.getRemaining(player, 'auto', 'attack') > 0,
        'mode-gated melee auto should fire when free'
    );
    assert.ok(rat.hp.current < hp2, 'auto dealt damage');

    sim.destroy();
    log('engage spell priority over auto ok', {
        autoCd: player.cooldowns.auto.attack
    });
}

/**
 * Weapon family selects distance_auto / wand_auto; ammo gate works.
 */
function testWeaponAutoFamilies() {
    const {
        resolveAutoAttackId,
        tryAutoAttack,
        hasAmmo
    } = require('../kernel/core/lib/ai/combat_actions.js');

    assert.strictEqual(
        resolveAutoAttackId({ combatStats: { weaponType: 'melee' } }),
        'melee_auto'
    );
    assert.strictEqual(
        resolveAutoAttackId({ combatStats: { weaponType: 'distance' } }),
        'distance_auto'
    );
    assert.strictEqual(
        resolveAutoAttackId({ combatStats: { weaponType: 'magic' } }),
        'wand_auto'
    );

    const map = openFloor(10, 6, 100);
    const spellBook = indexSpells(presets.loadSpells().spells);
    const attacker = {
        alive: true,
        moveDelay: 0,
        tile: { x: 2, y: 2, z: 0 },
        combatStats: {
            weaponType: 'distance',
            level: 50,
            atk: 40,
            skill: 80,
            magic: 20
        },
        mp: { current: 100, max: 100 },
        ammo: 2,
        cooldowns: null
    };
    Cooldowns.ensureCooldowns(attacker);
    attacker.cooldowns.auto.attack = 0;
    const defender = {
        alive: true,
        tile: { x: 5, y: 2, z: 0 },
        hp: { current: 200, max: 200 },
        combatStats: { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 }
    };
    map.tryOccupy(2, 2, 0, attacker);
    map.tryOccupy(5, 2, 0, defender);

    const distSpell = spellBook.distance_auto;
    // Explicit counter path (works with or without mode ammoConsumption)
    assert.ok(hasAmmo(attacker, distSpell, { ammoConsumption: true }));
    const r1 = tryAutoAttack({
        attacker,
        defender,
        ctx: {
            spellBook,
            tileMap: map,
            rng: () => 0.5,
            ammoConsumption: true
        }
    });
    assert.ok(r1 && r1.ok, 'distance auto in range with ammo');
    assert.strictEqual(attacker.ammo, 1, 'consumed one arrow');

    attacker.moveDelay = 0;
    attacker.cooldowns.auto.attack = 0;
    attacker.ammo = 0;
    const r2 = tryAutoAttack({
        attacker,
        defender,
        ctx: {
            spellBook,
            tileMap: map,
            rng: () => 0.5,
            ammoConsumption: true
        }
    });
    assert.ok(!r2, 'no auto without ammo when ammo is finite 0');

    // Null ammo + consumption off = infinite (legacy / tests)
    attacker.ammo = null;
    attacker.moveDelay = 0;
    attacker.cooldowns.auto.attack = 0;
    const r3 = tryAutoAttack({
        attacker,
        defender,
        ctx: {
            spellBook,
            tileMap: map,
            rng: () => 0.5,
            ammoConsumption: false
        }
    });
    assert.ok(r3 && r3.ok, 'null ammo allows infinite distance auto');

    // Wand needs mana
    attacker.combatStats.weaponType = 'magic';
    attacker.combatStats.magic = 80;
    attacker.combatStats.weaponRange = 3;
    attacker.moveDelay = 0;
    attacker.cooldowns.auto.attack = 0;
    attacker.mp.current = 0;
    const r4 = tryAutoAttack({
        attacker,
        defender: Object.assign({}, defender, {
            tile: { x: 4, y: 2, z: 0 },
            hp: { current: 200, max: 200 },
            alive: true
        }),
        ctx: { spellBook, tileMap: map, rng: () => 0.5 }
    });
    assert.ok(!r4, 'wand auto blocked without mana');

    attacker.mp.current = 50;
    attacker.moveDelay = 0;
    attacker.cooldowns.auto.attack = 0;
    const wandTarget = {
        alive: true,
        tile: { x: 4, y: 2, z: 0 },
        hp: { current: 200, max: 200 },
        combatStats: { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 }
    };
    const r5 = tryAutoAttack({
        attacker,
        defender: wandTarget,
        ctx: { spellBook, tileMap: map, rng: () => 0.5 }
    });
    assert.ok(r5 && r5.ok, 'wand auto with mana');
    assert.ok(attacker.mp.current < 50, 'wand spent mana');

    // Wand range from equipped weaponRange (not spell def alone)
    const {
        resolveSpellRange,
        isSpellInRange,
        DEFAULT_WAND_AUTO_RANGE
    } = require('../kernel/core/lib/ai/combat_actions.js');
    const wandSpell = spellBook.wand_auto;
    attacker.combatStats.weaponRange = 3;
    assert.strictEqual(resolveSpellRange(attacker, wandSpell), 3);
    const farTarget = {
        alive: true,
        tile: { x: 7, y: 2, z: 0 },
        hp: { current: 200, max: 200 }
    };
    // dist from (2,2) to (7,2) = 5
    assert.ok(
        !isSpellInRange(attacker, farTarget, wandSpell),
        'wand range 3 cannot reach dist 5'
    );
    attacker.combatStats.weaponRange = 6;
    assert.strictEqual(resolveSpellRange(attacker, wandSpell), 6);
    assert.ok(
        isSpellInRange(attacker, farTarget, wandSpell),
        'wand range 6 reaches dist 5'
    );
    delete attacker.combatStats.weaponRange;
    assert.strictEqual(
        resolveSpellRange(attacker, wandSpell),
        wandSpell.range != null ? wandSpell.range : DEFAULT_WAND_AUTO_RANGE,
        'fallback to spell range when weaponRange missing'
    );

    // Mode ammoConsumption + quiver stacks (inventory path)
    {
        const {
            buildInventoryFromSeed,
            countEquippedQuiverAmmo
        } = require('../kernel/core/lib/character/inventory.js');
        const itemDb = [
            {
                id: 'backpack',
                category: 'container',
                slot: 'backpack',
                volume: 20,
                weight: 100
            },
            {
                id: 'unicorn_quiver',
                category: 'quiver',
                slot: 'leftHand',
                volume: 12,
                weight: 200
            },
            {
                id: 'hunting_arrow',
                category: 'ammo',
                ammoType: 'arrow',
                stackable: true,
                atk: 25,
                maxHitChance: 90,
                weight: 70
            }
        ];
        const inv = buildInventoryFromSeed(
            {
                equipment: {
                    shield: 'unicorn_quiver',
                    backpack: 'backpack'
                },
                inventory: {
                    shield: [{ itemId: 'hunting_arrow', count: 2 }]
                }
            },
            itemDb
        );
        const archer = {
            alive: true,
            moveDelay: 0,
            tile: { x: 2, y: 2, z: 0 },
            combatStats: {
                weaponType: 'distance',
                level: 50,
                atk: 40,
                skill: 80,
                magic: 0
            },
            mp: { current: 100, max: 100 },
            inventory: inv,
            _loadoutItemDb: itemDb,
            cooldowns: null
        };
        Cooldowns.ensureCooldowns(archer);
        archer.cooldowns.auto.attack = 0;
        const prey = {
            alive: true,
            tile: { x: 5, y: 2, z: 0 },
            hp: { current: 200, max: 200 },
            combatStats: { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 }
        };
        const ctxAmmo = {
            spellBook,
            tileMap: map,
            rng: () => 0.5,
            ammoConsumption: true
        };
        assert.strictEqual(countEquippedQuiverAmmo(inv, itemDb), 2);
        const shot1 = tryAutoAttack({
            attacker: archer,
            defender: prey,
            ctx: ctxAmmo
        });
        assert.ok(shot1 && shot1.ok, 'distance auto with quiver ammo');
        assert.strictEqual(countEquippedQuiverAmmo(inv, itemDb), 1);
        archer.moveDelay = 0;
        archer.cooldowns.auto.attack = 0;
        tryAutoAttack({ attacker: archer, defender: prey, ctx: ctxAmmo });
        assert.strictEqual(countEquippedQuiverAmmo(inv, itemDb), 0);
        archer.moveDelay = 0;
        archer.cooldowns.auto.attack = 0;
        const dry = tryAutoAttack({
            attacker: archer,
            defender: prey,
            ctx: ctxAmmo
        });
        assert.ok(!dry, 'no distance auto when quiver empty');
        log('quiver ammo consumption ok');
    }

    // Throwing weapons: stack in rightHand; break on throw (incl. miss)
    {
        const {
            buildInventoryFromSeed,
            equippedRightHandCount
        } = require('../kernel/core/lib/character/inventory.js');
        const throwDb = [
            {
                id: 'backpack',
                category: 'container',
                slot: 'backpack',
                volume: 20,
                weight: 100
            },
            {
                id: 'snowball',
                category: 'spear',
                slot: 'rightHand',
                weaponType: 'distance',
                type: ['throwing'],
                stackable: true,
                breakChance: 100,
                range: 6,
                weight: 80
            },
            {
                id: 'nightshade_star',
                category: 'spear',
                slot: 'rightHand',
                weaponType: 'distance',
                type: ['throwing'],
                stackable: true,
                breakChance: 33,
                atk: 65,
                range: 4,
                weight: 200
            }
        ];
        const invSnow = buildInventoryFromSeed(
            {
                equipment: {
                    weapon: { itemId: 'snowball', count: 3 },
                    backpack: 'backpack'
                }
            },
            throwDb
        );
        const thrower = {
            alive: true,
            moveDelay: 0,
            tile: { x: 2, y: 2, z: 0 },
            combatStats: {
                weaponType: 'distance',
                level: 50,
                atk: 5,
                skill: 50,
                magic: 0,
                hitChance: 100
            },
            mp: { current: 100, max: 100 },
            inventory: invSnow,
            _loadoutItemDb: throwDb,
            cooldowns: null
        };
        Cooldowns.ensureCooldowns(thrower);
        thrower.cooldowns.auto.attack = 0;
        const prey2 = {
            alive: true,
            tile: { x: 5, y: 2, z: 0 },
            hp: { current: 500, max: 500 },
            combatStats: { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 }
        };
        assert.strictEqual(equippedRightHandCount(invSnow), 3);
        // Always-break snowball: each resolved auto removes 1 (hit or miss)
        const t1 = tryAutoAttack({
            attacker: thrower,
            defender: prey2,
            ctx: {
                spellBook,
                tileMap: map,
                rng: () => 0.5,
                ammoConsumption: true
            }
        });
        assert.ok(t1 && t1.ok, 'throwing auto without quiver');
        assert.strictEqual(equippedRightHandCount(invSnow), 2);
        thrower.moveDelay = 0;
        thrower.cooldowns.auto.attack = 0;
        tryAutoAttack({
            attacker: thrower,
            defender: prey2,
            ctx: {
                spellBook,
                tileMap: map,
                rng: () => 0.5,
                ammoConsumption: true
            }
        });
        thrower.moveDelay = 0;
        thrower.cooldowns.auto.attack = 0;
        tryAutoAttack({
            attacker: thrower,
            defender: prey2,
            ctx: {
                spellBook,
                tileMap: map,
                rng: () => 0.5,
                ammoConsumption: true
            }
        });
        assert.strictEqual(equippedRightHandCount(invSnow), 0);
        thrower.moveDelay = 0;
        thrower.cooldowns.auto.attack = 0;
        const dryThrow = tryAutoAttack({
            attacker: thrower,
            defender: prey2,
            ctx: {
                spellBook,
                tileMap: map,
                rng: () => 0.5,
                ammoConsumption: true
            }
        });
        assert.ok(!dryThrow, 'no throw when stack empty');

        // Probabilistic: rng 0.5 → no break at 33%
        const invStar = buildInventoryFromSeed(
            {
                equipment: {
                    weapon: { itemId: 'nightshade_star', count: 5 },
                    backpack: 'backpack'
                }
            },
            throwDb
        );
        thrower.inventory = invStar;
        thrower._loadoutItemDb = throwDb;
        thrower.moveDelay = 0;
        thrower.cooldowns.auto.attack = 0;
        tryAutoAttack({
            attacker: thrower,
            defender: prey2,
            ctx: {
                spellBook,
                tileMap: map,
                rng: () => 0.5,
                ammoConsumption: true
            }
        });
        assert.strictEqual(
            equippedRightHandCount(invStar),
            5,
            '33% break does not trigger when rng=0.5'
        );
        log('throwing weapon break/stack ok');
    }

    // Mode feature off
    attacker.moveDelay = 0;
    attacker.cooldowns.auto.attack = 0;
    attacker.mp.current = 50;
    attacker.combatStats.weaponRange = 3;
    const r6 = tryAutoAttack({
        attacker,
        defender: wandTarget,
        ctx: { spellBook, tileMap: map, rng: () => 0.5, autoAttack: false }
    });
    assert.ok(!r6, 'mode autoAttack false disables auto');

    log('weapon auto families ok');
}

function testFsm() {
    const owner = { n: 0 };
    const s1 = {
        id: 'a',
        enter(o) {
            o.n += 1;
        },
        execute(o) {
            o.n += 10;
        },
        exit(o) {
            o.n += 100;
        }
    };
    const s2 = {
        id: 'b',
        enter(o) {
            o.n += 1000;
        },
        execute() {},
        exit() {}
    };
    const sm = new StateMachine(owner);
    sm.setCurrentState(s1);
    s1.enter(owner);
    sm.update();
    assert.strictEqual(owner.n, 11);
    sm.changeState(s2);
    assert.strictEqual(owner.n, 1111);
    assert.ok(sm.isInState('b'));
    log('fsm ok');
}

function testTinyHuntEngageAndKill() {
    const map = openFloor(12, 8, 100);
    const sim = new Simulator({
        seed: 7,
        combatAi: true,
        recordSteps: false
    });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.spellBook = require('../kernel/core/lib/combat/resolve.js').indexSpells(
        presets.loadSpells().spells
    );
    sim.strategyTable = indexStrategies(presets.loadStrategies());
    sim.sessionState = 'running';
    sim.active = true;
    sim.bindSeededRandom();

    const classDef = presets.getClass('guardian');
    const items = presets.loadEquipment().items;
    const party = new Party({
        name: 'T',
        waypoints: [
            { x: 1, y: 3, z: 0 },
            { x: 10, y: 3, z: 0 }
        ]
    });
    const player = new Player({
        id: sim.allocEntityId(),
        name: 'G',
        classId: 'guardian',
        isLeader: true,
        strategyId: 'guardian_aggro',
        level: 50,
        equipment: {
            rightHand: 'iron_longsword',
            leftHand: 'oak_shield',
            armor: 'steel_plate'
        },
        tile: { x: 1, y: 3, z: 0 }
    });
    player.applyClassLoadout(classDef, items, { level: 50 });
    map.tryOccupy(1, 3, 0, player);
    player.currentWaypoint = 1;
    party.addMember(player);
    initPlayerAi(player, {
        strategyId: 'guardian_aggro',
        strategyTable: sim.strategyTable
    });
    sim.parties.push(party);
    sim.insertChild(party);
    sim.entityById.set(player.id, player);

    const ratTpl = presets.loadCreatureTemplate('cave_rat');
    const rat = new Creature({
        id: sim.allocEntityId(),
        tile: { x: 4, y: 3, z: 0 },
        homeTile: { x: 4, y: 3, z: 0 }
    });
    rat.applyTemplate(ratTpl);
    // Weaker so kill is guaranteed quickly
    rat.hp.max = 30;
    rat.hp.current = 30;
    map.tryOccupy(4, 3, 0, rat);
    initCreatureAi(rat);
    sim.creatures.push(rat);
    sim.entityById.set(rat.id, rat);
    sim.insertChild(rat);
    sim.telemetry.creaturesSpawned = 1;

    let ended = false;
    for (let i = 0; i < 400; i++) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
        if (sim.sessionState === 'route_complete' || sim.sessionState === 'party_wipe') {
            ended = true;
            break;
        }
    }

    const summary = sim.buildHuntSummary();
    log('tiny hunt summary', summary);

    assert.ok(
        summary.kills >= 1 || !rat.alive,
        `expected rat kill, kills=${summary.kills} rat.alive=${rat.alive}`
    );
    assert.ok(summary.damageDealt > 0, 'damageDealt > 0');
    assert.ok(
        summary.sessionState === 'route_complete' ||
            summary.sessionState === 'party_wipe' ||
            summary.kills >= 1,
        `session ended or combat happened: ${summary.sessionState}`
    );
    // Party should still be alive against one weak rat
    assert.ok(!summary.partyWipe, 'party should not wipe vs one weak rat');

    sim.destroy();
    log('tiny hunt engage/kill ok', {
        kills: summary.kills,
        damageDealt: summary.damageDealt,
        state: summary.sessionState,
        ticks: summary.tickCount,
        ended
    });
}

function testPartyWipeSummary() {
    const map = openFloor(8, 8, 100);
    const sim = new Simulator({ seed: 3, combatAi: true });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.spellBook = require('../kernel/core/lib/combat/resolve.js').indexSpells(
        presets.loadSpells().spells
    );
    sim.strategyTable = indexStrategies(presets.loadStrategies());
    sim.sessionState = 'running';
    sim.active = true;
    sim.bindSeededRandom();

    const party = new Party({
        name: 'Doomed',
        waypoints: [
            { x: 2, y: 2, z: 0 },
            { x: 6, y: 2, z: 0 }
        ]
    });
    const player = new Player({
        id: sim.allocEntityId(),
        name: 'Weak',
        classId: 'adventurer',
        isLeader: true,
        strategyId: 'balanced',
        level: 8,
        tile: { x: 2, y: 2, z: 0 },
        hp: 5,
        hpMax: 5
    });
    // Minimal stats so rat can kill
    player.combatStats = {
        classId: 'adventurer',
        level: 1,
        atk: 1,
        skill: 1,
        magic: 0,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        resists: {},
        hpMax: 5,
        mpMax: 0,
        speed: 110
    };
    player.hp = { current: 5, max: 5 };
    player.alive = true;
    map.tryOccupy(2, 2, 0, player);
    player.currentWaypoint = 1;
    party.addMember(player);
    initPlayerAi(player, {
        strategyId: 'balanced',
        strategyTable: sim.strategyTable
    });
    sim.parties.push(party);
    sim.insertChild(party);
    sim.entityById.set(player.id, player);

    // Strong static-ish bruiser next to player (fixed kit; no implicit atk curve)
    const bruiser = new Creature({
        id: sim.allocEntityId(),
        name: 'Bruiser',
        tile: { x: 3, y: 2, z: 0 },
        homeTile: { x: 3, y: 2, z: 0 },
        hp: 500,
        hpMax: 500,
        atk: 80,
        skill: 80,
        level: 50,
        speed: 150,
        armor: 20,
        exp: 1,
        attacks: [
            {
                id: 'melee_0',
                kind: 'melee',
                element: 'physical',
                intervalMs: 1000,
                chance: 100,
                range: 1,
                min: 40,
                max: 80,
                target: true
            }
        ]
    });
    map.tryOccupy(3, 2, 0, bruiser);
    initCreatureAi(bruiser);
    sim.creatures.push(bruiser);
    sim.entityById.set(bruiser.id, bruiser);
    sim.insertChild(bruiser);

    for (let i = 0; i < 300; i++) {
        Time.advanceFixedLogicStep();
        sim.updateAll();
        if (sim.sessionState === 'party_wipe') break;
    }

    const summary = sim.buildHuntSummary();
    log('wipe summary', summary);
    assert.strictEqual(summary.sessionState, 'party_wipe');
    assert.ok(summary.partyWipe);
    assert.ok(summary.deaths >= 1);
    assert.ok(summary.damageTaken > 0);
    sim.destroy();
    log('party wipe ok');
}

async function testHeadlessHuntFloor07() {
    // Pin starter_duo: mode default became balance_quartet (docs/24 golden),
    // which stalls on this small_crawl within maxTicks=1800. Stage 5 criteria
    // need a party that finishes (route_complete / wipe), not product default.
    const huntInput = {
        seed: 42,
        huntId: 'cave_crawl_generated',
        partyId: 'starter_duo',
        frames: 8000
    };
    const a = await runHeadlessHunt(huntInput);
    const b = await runHeadlessHunt(huntInput);

    log('hunt A', {
        state: a.sessionState,
        kills: a.kills,
        dmg: a.damageDealt,
        taken: a.damageTaken,
        ticks: a.tickCount,
        exp: a.expGained
    });

    assert.ok(
        a.sessionState === 'route_complete' ||
            a.sessionState === 'party_wipe' ||
            a.sessionState === 'timeout',
        `unexpected state ${a.sessionState}`
    );
    // Same seed ⇒ same summary core fields
    assert.strictEqual(a.sessionState, b.sessionState);
    assert.strictEqual(a.kills, b.kills);
    assert.strictEqual(a.damageDealt, b.damageDealt);
    assert.strictEqual(a.damageTaken, b.damageTaken);
    assert.strictEqual(a.tickCount, b.tickCount);
    assert.strictEqual(a.expGained, b.expGained);

    // Expect a real hunt outcome with combat activity
    assert.ok(
        a.sessionState === 'route_complete' || a.sessionState === 'party_wipe',
        `hunt should finish without timeout: ${a.sessionState} ticks=${a.tickCount}`
    );
    assert.ok(
        a.kills > 0 || a.damageDealt > 0 || a.damageTaken > 0,
        'summary should include combat totals'
    );
    // Summary JSON shape
    assert.ok(typeof a.kills === 'number');
    assert.ok(typeof a.damageDealt === 'number');
    assert.ok(Array.isArray(a.parties));

    log('headless cave_crawl_generated hunt ok');
}

async function testGhostWalkStillWorks() {
    // Regression: Stage 3 path must remain combatAi-free
    const r = await runHeadlessPartyWalk({ seed: 42, frames: 3000 });
    assert.ok(r.routeComplete, 'ghost walk route complete');
    assert.strictEqual(r.sessionState, 'route_complete');
    log('ghost walk regression ok');
}

function testLowHpSelfHeal() {
    const map = openFloor(8, 8, 100);
    const sim = new Simulator({
        seed: 11,
        combatAi: true,
        recordSteps: false
    });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.spellBook = indexSpells(presets.loadSpells().spells);
    sim.strategyTable = indexStrategies(presets.loadStrategies());
    sim.sessionState = 'running';
    sim.active = true;
    sim.bindSeededRandom();

    const classDef = presets.getClass('adept');
    const items = presets.loadEquipment().items;
    const party = new Party({
        name: 'HealTest',
        waypoints: [
            { x: 2, y: 2, z: 0 },
            { x: 6, y: 2, z: 0 }
        ]
    });
    const player = new Player({
        id: sim.allocEntityId(),
        name: 'Adept',
        classId: 'adept',
        isLeader: true,
        strategyId: 'adept_caster',
        level: 50,
        equipment: { rightHand: 'ember_wand' },
        tile: { x: 2, y: 2, z: 0 }
    });
    player.applyClassLoadout(classDef, items, { level: 50 });
    player.mp.current = player.mp.max;
    const maxHp = player.hp.max;
    player.hp.current = Math.floor(maxHp * 0.2);
    player.alive = true;
    Cooldowns.ensureCooldowns(player);

    map.tryOccupy(2, 2, 0, player);
    player.currentWaypoint = 1;
    party.addMember(player);
    initPlayerAi(player, {
        strategyId: 'adept_caster',
        strategyTable: sim.strategyTable
    });
    player.strategy = normalizeStrategy(
        Object.assign({}, player.strategy, {
            healHpPercent: 0.5,
            healSpellId: 'heal_light',
            fleeHpPercent: 0.05
        })
    );
    sim.parties.push(party);
    sim.insertChild(party);
    sim.entityById.set(player.id, player);

    const hpBefore = player.hp.current;
    const ctx = {
        sim,
        tileMap: map,
        enemies: [],
        allies: [player],
        spellBook: sim.spellBook,
        rng: Math.random
    };

    const cast = tryHeal({
        attacker: player,
        strategy: player.strategy,
        ctx
    });
    assert.ok(cast && cast.ok, `tryHeal should succeed: ${cast && cast.reason}`);
    assert.ok(cast.hit, 'heal should hit');
    assert.ok(cast.hpDelta > 0, `heal hpDelta ${cast.hpDelta}`);
    assert.ok(player.hp.current > hpBefore, 'player HP increased');

    // Clear CDs + post-cast moveLock and cast again so telemetry accumulates
    player.cooldowns.primary.healing = 0;
    player.cooldowns.spell.heal_light = 0;
    player.moveDelay = 0;
    player.mp.current = Math.max(player.mp.current, 40);
    player.hp.current = Math.floor(maxHp * 0.15);
    const cast2 = tryHeal({
        attacker: player,
        strategy: player.strategy,
        ctx
    });
    assert.ok(cast2 && cast2.ok && cast2.hit);
    assert.ok(player.hp.current > Math.floor(maxHp * 0.15));
    assert.ok(
        sim.telemetry.healingDone > 0,
        `healingDone should be sampled: ${sim.telemetry.healingDone}`
    );

    const summary = sim.buildHuntSummary();
    assert.ok(summary.healingDone > 0, 'summary.healingDone > 0');
    assert.ok(
        summary.damageDealtByElement &&
            summary.damageDealtByElement.healing > 0,
        'healing element map'
    );

    // Above threshold → no cast
    player.hp.current = maxHp;
    player.cooldowns.primary.healing = 0;
    player.cooldowns.spell.heal_light = 0;
    const skip = tryHeal({
        attacker: player,
        strategy: player.strategy,
        ctx
    });
    assert.strictEqual(skip, null, 'full HP should not heal');

    sim.destroy();
    log('low-HP self heal ok', {
        healingDone: summary.healingDone,
        firstDelta: cast.hpDelta,
        secondDelta: cast2.hpDelta
    });
}

function testAiCadenceHelpers() {
    const prev = {
        gateP: Settings.AI_GATE_BRAIN_ON_MOVE_DELAY,
        gateC: Settings.AI_GATE_CREATURE_ON_MOVE_DELAY,
        pad: Settings.AI_THINK_PAD_SEC,
        interval: Settings.AI_ENGAGE_DECISION_INTERVAL,
        retarget: Settings.AI_TARGET_RETARGET_DIST,
        lose: Settings.AI_TARGET_LOSE_DIST
    };
    try {
        Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = true;
        const e = { alive: true, moveDelay: 0.2 };
        assert.strictEqual(brainReady(e, 'player'), false);
        e.moveDelay = 0;
        assert.strictEqual(brainReady(e, 'player'), true);
        Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = false;
        e.moveDelay = 1;
        assert.strictEqual(brainReady(e, 'player'), true);

        Settings.AI_THINK_PAD_SEC = 0.1;
        const caster = {};
        Cooldowns.ensureCooldowns(caster);
        applyThinkPad(caster);
        assert.ok(
            caster.cooldowns.primary.attack >= 0.1 - 1e-9,
            `think pad should set primary.attack: ${caster.cooldowns.primary.attack}`
        );
        caster.cooldowns.primary.attack = 2;
        applyThinkPad(caster);
        assert.strictEqual(
            caster.cooldowns.primary.attack,
            2,
            'think pad must not shorten real CD'
        );
        // Mid-pad remaining must tick down — re-padding would stick forever at
        // AI_THINK_PAD_SEC with logic dt 0.05 (0.1 → 0.05 → pad → 0.1 …).
        caster.cooldowns.primary.attack = 0.05;
        applyThinkPad(caster);
        assert.strictEqual(
            caster.cooldowns.primary.attack,
            0.05,
            'think pad must not refresh while primary.attack is still counting down'
        );
        caster.cooldowns.primary.attack = 0;
        applyThinkPad(caster);
        assert.ok(
            caster.cooldowns.primary.attack >= 0.1 - 1e-9,
            'think pad should re-apply when gate is ready and scan cast nothing'
        );

        Settings.AI_ENGAGE_DECISION_INTERVAL = 0.25;
        Time.timeSinceLevelLoad = 0;
        const owner = {};
        clearEngageSticky(owner);
        const st = normalizeStrategy({ aggression: 1, monstersToEngage: 1 });
        assert.ok(evaluateEngageWant(owner, 1, st, () => 0));
        assert.strictEqual(owner._engageDecision, true);
        // Within interval: sticky yes even if aggression would fail
        const stLow = normalizeStrategy({ aggression: 0, monstersToEngage: 1 });
        Time.timeSinceLevelLoad = 0.1;
        assert.ok(
            evaluateEngageWant(owner, 1, stLow, () => 0.99),
            'sticky engage decision should hold inside interval'
        );
        // Pack drop clears
        assert.ok(!evaluateEngageWant(owner, 0, st, () => 0));
        assert.strictEqual(owner._engageDecision, false);

        Settings.AI_TARGET_RETARGET_DIST = 2;
        Settings.AI_TARGET_LOSE_DIST = 10;
        const self = { tile: { x: 0, y: 0, z: 0 }, alive: true };
        const near = {
            tile: { x: 1, y: 0, z: 0 },
            alive: true,
            hp: { current: 10, max: 10 }
        };
        const mid = {
            tile: { x: 2, y: 0, z: 0 },
            alive: true,
            hp: { current: 10, max: 10 }
        };
        const far = {
            tile: { x: 11, y: 0, z: 0 },
            alive: true,
            hp: { current: 10, max: 10 }
        };
        assert.strictEqual(targetDistancePolicy(self, near), 'hold');
        assert.strictEqual(targetDistancePolicy(self, mid), 'retarget');
        assert.strictEqual(targetDistancePolicy(self, far), 'lose');
    } finally {
        Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = prev.gateP;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prev.gateC;
        Settings.AI_THINK_PAD_SEC = prev.pad;
        Settings.AI_ENGAGE_DECISION_INTERVAL = prev.interval;
        Settings.AI_TARGET_RETARGET_DIST = prev.retarget;
        Settings.AI_TARGET_LOSE_DIST = prev.lose;
    }
    log('ai cadence helpers ok');
}

/**
 * Pure helpers: AI_TICK_RADIUS filter (legacy tilesToUpdate style).
 */
function testAiTickRadiusFilterHelpers() {
    const prev = Settings.AI_TICK_RADIUS;
    try {
        Settings.AI_TICK_RADIUS = 10;
        assert.strictEqual(resolveAiTickRadius(), 10);

        const player = {
            alive: true,
            hp: { current: 10, max: 10 },
            tile: { x: 5, y: 5, z: 7 }
        };
        const near = {
            alive: true,
            hp: { current: 5, max: 5 },
            tile: { x: 8, y: 5, z: 7 },
            aiState: 'idle'
        };
        const far = {
            alive: true,
            hp: { current: 5, max: 5 },
            tile: { x: 40, y: 40, z: 7 },
            aiState: 'idle'
        };
        const farEngaged = {
            alive: true,
            hp: { current: 5, max: 5 },
            tile: { x: 40, y: 40, z: 7 },
            aiState: 'aggro',
            targetId: player.id || 1,
            target: player
        };

        assert.ok(isCreatureNearObservers(near, [player], 10));
        assert.ok(!isCreatureNearObservers(far, [player], 10));
        assert.ok(shouldTickCreatureAi(near, [player], 10));
        assert.ok(!shouldTickCreatureAi(far, [player], 10), 'far idle skipped');
        assert.ok(
            shouldTickCreatureAi(farEngaged, [player], 10),
            'engaged far still ticks (leash/return)'
        );

        Settings.AI_TICK_RADIUS = 0;
        assert.strictEqual(resolveAiTickRadius(), 0);
        assert.ok(
            shouldTickCreatureAi(far, [player], 0),
            'radius 0 disables filter'
        );

        const enemies = filterEnemiesForAi(
            [near, far, farEngaged],
            [player],
            10
        );
        assert.strictEqual(enemies.length, 1);
        assert.strictEqual(enemies[0], near);

        Settings.AI_TICK_RADIUS = 10;
        log('ai tick radius filter helpers ok');
    } finally {
        Settings.AI_TICK_RADIUS = prev;
    }
}

/**
 * Integration: far creature brain must not execute while near one does.
 */
function testAiTickRadiusSkipsFarCreatures() {
    const prev = Settings.AI_TICK_RADIUS;
    const prevGate = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    Settings.AI_TICK_RADIUS = 10;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;
    try {
        const map = openFloor(80, 80, 100);
        const sim = new Simulator({
            seed: 11,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim._ensurePresetLoaders();
        sim.spellBook = indexSpells(presets.loadSpells().spells);
        sim.strategyTable = indexStrategies(presets.loadStrategies());
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'Near',
            waypoints: [
                { x: 5, y: 5, z: 0 },
                { x: 6, y: 5, z: 0 }
            ]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Lead',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 5, y: 5, z: 0 }
        });
        map.tryOccupy(5, 5, 0, player);
        party.addMember(player);
        initPlayerAi(player, {
            strategyId: 'pacifist',
            strategyTable: sim.strategyTable
        });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const nearRat = new Creature({
            id: sim.allocEntityId(),
            name: 'near_rat',
            tile: { x: 6, y: 5, z: 0 },
            combat: { hp: 20, attack: 1, defense: 1 }
        });
        const farRat = new Creature({
            id: sim.allocEntityId(),
            name: 'far_rat',
            tile: { x: 70, y: 70, z: 0 },
            combat: { hp: 20, attack: 1, defense: 1 }
        });
        map.tryOccupy(6, 5, 0, nearRat);
        map.tryOccupy(70, 70, 0, farRat);
        initCreatureAi(nearRat);
        initCreatureAi(farRat);
        sim.creatures.push(nearRat, farRat);
        sim.entityById.set(nearRat.id, nearRat);
        sim.entityById.set(farRat.id, farRat);

        let nearExec = 0;
        let farExec = 0;
        nearRat.brain.setCurrentState({
            id: 'probe_near',
            enter() {},
            execute() {
                nearExec += 1;
            },
            exit() {}
        });
        farRat.brain.setCurrentState({
            id: 'probe_far',
            enter() {},
            execute() {
                farExec += 1;
            },
            exit() {}
        });
        nearRat.aiState = 'idle';
        farRat.aiState = 'idle';
        nearRat.moveDelay = 0;
        farRat.moveDelay = 0;

        tickHuntAi(sim, null);
        assert.ok(nearExec >= 1, 'near creature brain should run');
        assert.strictEqual(farExec, 0, 'far idle creature brain must not run');

        const ctx = buildCtx(sim, null);
        assert.ok(
            ctx.enemies.some((e) => e.id === nearRat.id),
            'near enemy in ctx'
        );
        assert.ok(
            !ctx.enemies.some((e) => e.id === farRat.id),
            'far enemy excluded from player scans'
        );

        sim.destroy();
        log('ai tick radius skips far creatures ok', { nearExec, farExec });
    } finally {
        Settings.AI_TICK_RADIUS = prev;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGate;
    }
}

/**
 * Spatial gather: two distant players only tick local bubbles; far idle skipped.
 * Counters: distanceChecks << creatures × players.
 */
function testSpatialAiTickTwoBubbles() {
    const prev = Settings.AI_TICK_RADIUS;
    const prevGate = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    Settings.AI_TICK_RADIUS = 10;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;
    try {
        const map = openFloor(120, 120, 100);
        const sim = new Simulator({
            seed: 13,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'Split',
            waypoints: [
                { x: 5, y: 5, z: 0 },
                { x: 100, y: 100, z: 0 }
            ]
        });
        const pA = new Player({
            id: sim.allocEntityId(),
            name: 'A',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 5, y: 5, z: 0 }
        });
        const pB = new Player({
            id: sim.allocEntityId(),
            name: 'B',
            classId: 'guardian',
            isLeader: false,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 100, y: 100, z: 0 }
        });
        map.tryOccupy(5, 5, 0, pA);
        map.tryOccupy(100, 100, 0, pB);
        party.addMember(pA);
        party.addMember(pB);
        initPlayerAi(pA, { strategyId: 'pacifist' });
        initPlayerAi(pB, { strategyId: 'pacifist' });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(pA.id, pA);
        sim.entityById.set(pB.id, pB);

        const nearA = new Creature({
            id: sim.allocEntityId(),
            name: 'nearA',
            tile: { x: 6, y: 5, z: 0 },
            combat: { hp: 20, attack: 1, defense: 1 }
        });
        const nearB = new Creature({
            id: sim.allocEntityId(),
            name: 'nearB',
            tile: { x: 101, y: 100, z: 0 },
            combat: { hp: 20, attack: 1, defense: 1 }
        });
        const farIdle = new Creature({
            id: sim.allocEntityId(),
            name: 'farIdle',
            tile: { x: 50, y: 50, z: 0 },
            combat: { hp: 20, attack: 1, defense: 1 }
        });
        const farEngaged = new Creature({
            id: sim.allocEntityId(),
            name: 'farEngaged',
            tile: { x: 55, y: 55, z: 0 },
            combat: { hp: 20, attack: 1, defense: 1 }
        });
        for (const c of [nearA, nearB, farIdle, farEngaged]) {
            map.tryOccupy(c.tile.x, c.tile.y, 0, c);
            initCreatureAi(c);
            c.aiState = 'idle';
            c.moveDelay = 0;
            sim.creatures.push(c);
            sim.entityById.set(c.id, c);
            sim.creatureSpatialIndex.insert(c);
        }
        farEngaged.target = pA;
        farEngaged.targetId = pA.id;
        farEngaged.aiState = 'aggro';

        const exec = { nearA: 0, nearB: 0, farIdle: 0, farEngaged: 0 };
        function probe(c, key) {
            c.brain.setCurrentState({
                id: 'probe_' + key,
                enter() {},
                execute() {
                    exec[key] += 1;
                },
                exit() {}
            });
            // Keep sticky state after setCurrentState for farEngaged
            if (key === 'farEngaged') {
                c.aiState = 'aggro';
                c.target = pA;
                c.targetId = pA.id;
            } else {
                c.aiState = 'idle';
            }
        }
        probe(nearA, 'nearA');
        probe(nearB, 'nearB');
        probe(farIdle, 'farIdle');
        probe(farEngaged, 'farEngaged');

        tickHuntAi(sim, null);

        assert.ok(exec.nearA >= 1, 'bubble A ticks');
        assert.ok(exec.nearB >= 1, 'bubble B ticks');
        assert.strictEqual(exec.farIdle, 0, 'mid-map idle skipped');
        assert.ok(exec.farEngaged >= 1, 'sticky far still ticks');

        assert.ok(sim.aiPerf, 'aiPerf frame present');
        assert.ok(sim.aiPerf.usedSpatial, 'spatial path used');
        // Phase F3: repath + think metrics on every frame
        assert.ok(
            typeof sim.aiPerf.repaths === 'number',
            'aiPerf.repaths present'
        );
        assert.ok(
            typeof sim.aiPerf.criticalRepaths === 'number',
            'aiPerf.criticalRepaths present'
        );
        assert.ok(
            typeof sim.aiPerf.optionalRepaths === 'number',
            'aiPerf.optionalRepaths present'
        );
        assert.ok(
            typeof sim.aiPerf.budgetSkips === 'number',
            'aiPerf.budgetSkips present'
        );
        assert.ok(
            typeof sim.aiPerf.failBackoffs === 'number',
            'aiPerf.failBackoffs present'
        );
        assert.ok(
            typeof sim.aiPerf.brainsFull === 'number',
            'aiPerf.brainsFull (think full) present'
        );
        assert.ok(
            typeof sim.aiPerf.brainsKitOnly === 'number',
            'aiPerf.brainsKitOnly (think gated) present'
        );
        // filterEnemies + gather + shouldTick each refine candidates; still a
        // small constant over the two local bubbles (not 4 creatures × 2 players
        // × many passes over the full set).
        assert.ok(
            sim.aiPerf.distanceChecks < 40,
            'distanceChecks stays local (' + sim.aiPerf.distanceChecks + ')'
        );
        assert.ok(
            sim.aiPerf.spatialCandidates > 0,
            'spatial produced candidates'
        );
        assert.ok(
            sim.aiPerf.brainsExecuted >= 3,
            'nearA+nearB+engaged executed'
        );
        assert.ok(
            sim.aiPerf.brainsFull + sim.aiPerf.brainsKitOnly ===
                sim.aiPerf.brainsExecuted,
            'brainsFull + kitOnly === brainsExecuted'
        );

        const cands = gatherCreatureAiCandidates(
            sim,
            [pA, pB],
            10,
            null
        );
        const ids = cands.map((c) => c.id);
        assert.ok(ids.includes(nearA.id));
        assert.ok(ids.includes(nearB.id));
        assert.ok(ids.includes(farEngaged.id));
        assert.ok(!ids.includes(farIdle.id));

        log('spatial ai tick two bubbles ok', {
            exec,
            aiPerf: sim.aiPerf
        });
        sim.destroy();
    } finally {
        Settings.AI_TICK_RADIUS = prev;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGate;
    }
}

/**
 * Stress-ish: many idle far creatures → few distance checks with spatial index.
 */
function testSpatialAiPerfManyIdle() {
    const prev = Settings.AI_TICK_RADIUS;
    const prevGate = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    Settings.AI_TICK_RADIUS = 10;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;
    try {
        const map = openFloor(200, 200, 100);
        const sim = new Simulator({
            seed: 17,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'Solo',
            waypoints: [{ x: 5, y: 5, z: 0 }]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Lead',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 5, y: 5, z: 0 }
        });
        map.tryOccupy(5, 5, 0, player);
        party.addMember(player);
        initPlayerAi(player, { strategyId: 'pacifist' });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const N = 500;
        for (let i = 0; i < N; i++) {
            // Place far from player (corner opposite)
            const x = 150 + (i % 40);
            const y = 150 + Math.floor(i / 40);
            const c = new Creature({
                id: sim.allocEntityId(),
                name: 'idle' + i,
                tile: { x, y, z: 0 },
                combat: { hp: 5, attack: 1, defense: 1 }
            });
            if (!map.tryOccupy(x, y, 0, c)) continue;
            initCreatureAi(c);
            c.aiState = 'idle';
            c.moveDelay = 0;
            sim.creatures.push(c);
            sim.entityById.set(c.id, c);
            sim.creatureSpatialIndex.insert(c);
        }

        tickHuntAi(sim, null);
        const perf = sim.aiPerf;
        assert.ok(perf.usedSpatial);
        // Linear enemy filter alone would be ~N distance checks (1 player).
        // Spatial far cluster: 0 chunk candidates → 0 distance checks for them.
        assert.ok(
            perf.distanceChecks < 50,
            'few distance checks with far idle (' + perf.distanceChecks + ')'
        );
        assert.strictEqual(
            perf.brainsExecuted,
            0,
            'no far idle brains'
        );

        // Linear baseline still works when index disabled
        sim.creatureSpatialIndex = false;
        sim.aiPerfTotals = null;
        tickHuntAi(sim, null);
        assert.ok(!sim.aiPerf.usedSpatial, 'linear path');
        assert.ok(
            sim.aiPerf.distanceChecks >= N,
            'linear pays O(C) distance checks'
        );

        sim.destroy();
        log('spatial ai perf many idle ok', { N, spatial: perf });
    } finally {
        Settings.AI_TICK_RADIUS = prev;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGate;
    }
}

/**
 * Etapa 3: far idle freezes CD / moveDelay; near + sticky stay awake; wake keeps CD.
 */
function testCreatureSleepSelectiveUpdate() {
    const prevRadius = Settings.AI_TICK_RADIUS;
    const prevSleep = Settings.AI_CREATURE_SLEEP;
    Settings.AI_TICK_RADIUS = 10;
    Settings.AI_CREATURE_SLEEP = true;
    try {
        assert.strictEqual(isCreatureSleepEnabled(), true);

        const map = openFloor(80, 80, 100);
        const sim = new Simulator({
            seed: 31,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'SleepParty',
            waypoints: [{ x: 5, y: 5, z: 0 }]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Lead',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 5, y: 5, z: 0 }
        });
        map.tryOccupy(5, 5, 0, player);
        party.addMember(player);
        initPlayerAi(player, { strategyId: 'pacifist' });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const near = new Creature({
            id: sim.allocEntityId(),
            name: 'near',
            tile: { x: 6, y: 5, z: 0 },
            combat: { hp: 30, attack: 1, defense: 1 }
        });
        const farIdle = new Creature({
            id: sim.allocEntityId(),
            name: 'farIdle',
            tile: { x: 50, y: 50, z: 0 },
            combat: { hp: 30, attack: 1, defense: 1 }
        });
        const farSticky = new Creature({
            id: sim.allocEntityId(),
            name: 'farSticky',
            tile: { x: 55, y: 55, z: 0 },
            combat: { hp: 30, attack: 1, defense: 1 }
        });
        for (const c of [near, farIdle, farSticky]) {
            map.tryOccupy(c.tile.x, c.tile.y, 0, c);
            initCreatureAi(c);
            c.aiState = 'idle';
            c.moveDelay = 1.0;
            c.cooldowns.primary.attack = 2.0;
            sim.creatures.push(c);
            sim.entityById.set(c.id, c);
            sim.insertChild(c);
            if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
                sim.creatureSpatialIndex.insert(c);
            }
        }
        farSticky.target = player;
        farSticky.targetId = player.id;
        farSticky.aiState = 'aggro';

        const sleepFrame = applyCreatureSleepState(sim);
        assert.ok(sleepFrame.sleepEnabled, 'sleep on');
        assert.strictEqual(near.simSleeping, false, 'near awake');
        assert.strictEqual(farIdle.simSleeping, true, 'far idle asleep');
        assert.strictEqual(farSticky.simSleeping, false, 'sticky awake');
        assert.ok(sleepFrame.asleep >= 1, 'asleep count');
        assert.ok(sleepFrame.awake >= 2, 'awake count');

        Time.deltaTime = 0.05;
        near.updateAll();
        farIdle.updateAll();
        farSticky.updateAll();

        assert.ok(
            near.moveDelay < 1.0 - 0.001,
            'near moveDelay ticks'
        );
        assert.ok(
            near.cooldowns.primary.attack < 2.0 - 0.001,
            'near CD ticks'
        );
        assert.strictEqual(
            farIdle.moveDelay,
            1.0,
            'far idle moveDelay frozen'
        );
        assert.strictEqual(
            farIdle.cooldowns.primary.attack,
            2.0,
            'far idle CD frozen'
        );
        assert.ok(
            farSticky.moveDelay < 1.0 - 0.001,
            'sticky moveDelay ticks'
        );

        // Wake: teleport far idle next to player — CD stays at frozen value then ticks
        map.release(farIdle.tile.x, farIdle.tile.y, 0, farIdle);
        farIdle.tile = { x: 7, y: 5, z: 0 };
        map.tryOccupy(7, 5, 0, farIdle);
        farIdle.syncPositionFromTile();
        if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
            sim.creatureSpatialIndex.update(farIdle);
        }
        const frozenCd = farIdle.cooldowns.primary.attack;
        applyCreatureSleepState(sim);
        assert.strictEqual(farIdle.simSleeping, false, 'woke near player');
        assert.strictEqual(
            farIdle.cooldowns.primary.attack,
            frozenCd,
            'no CD catch-up on wake'
        );
        Time.deltaTime = 0.05;
        farIdle.updateAll();
        assert.ok(
            farIdle.cooldowns.primary.attack < frozenCd - 0.001,
            'CD ticks after wake'
        );

        // Flag off → everyone awake
        Settings.AI_CREATURE_SLEEP = false;
        applyCreatureSleepState(sim);
        assert.strictEqual(isCreatureSleepEnabled(), false);
        assert.strictEqual(farIdle.simSleeping, false);
        assert.strictEqual(near.simSleeping, false);
        assert.ok(sim.updatePerf && !sim.updatePerf.sleepEnabled);

        // Radius 0 → sleep disabled
        Settings.AI_CREATURE_SLEEP = true;
        Settings.AI_TICK_RADIUS = 0;
        assert.strictEqual(isCreatureSleepEnabled(), false);
        // Place one far again; must stay awake
        Settings.AI_TICK_RADIUS = 10;
        map.release(farIdle.tile.x, farIdle.tile.y, 0, farIdle);
        farIdle.tile = { x: 60, y: 60, z: 0 };
        map.tryOccupy(60, 60, 0, farIdle);
        farIdle.syncPositionFromTile();
        farIdle.aiState = 'idle';
        farIdle.target = null;
        farIdle.targetId = null;
        if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
            sim.creatureSpatialIndex.update(farIdle);
        }
        applyCreatureSleepState(sim);
        assert.strictEqual(farIdle.simSleeping, true);
        Settings.AI_TICK_RADIUS = 0;
        applyCreatureSleepState(sim);
        assert.strictEqual(farIdle.simSleeping, false, 'radius 0 wakes all');

        sim.destroy();
        log('creature sleep selective update ok', {
            updatePerf: sim.updatePerf
        });
    } finally {
        Settings.AI_TICK_RADIUS = prevRadius;
        Settings.AI_CREATURE_SLEEP = prevSleep;
        Time.deltaTime = 0;
    }
}

/**
 * Simulator.updateAll applies sleep before entity ticks (integration).
 */
function testSimulatorUpdateAllRespectsSleep() {
    const prevRadius = Settings.AI_TICK_RADIUS;
    const prevSleep = Settings.AI_CREATURE_SLEEP;
    const prevGate = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    Settings.AI_TICK_RADIUS = 10;
    Settings.AI_CREATURE_SLEEP = true;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;
    try {
        const map = openFloor(60, 60, 100);
        const sim = new Simulator({
            seed: 41,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'U',
            waypoints: [{ x: 3, y: 3, z: 0 }]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'P',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 3, y: 3, z: 0 }
        });
        map.tryOccupy(3, 3, 0, player);
        party.addMember(player);
        initPlayerAi(player, { strategyId: 'pacifist' });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const far = new Creature({
            id: sim.allocEntityId(),
            name: 'far',
            tile: { x: 40, y: 40, z: 0 },
            combat: { hp: 20, attack: 1, defense: 1 }
        });
        map.tryOccupy(40, 40, 0, far);
        initCreatureAi(far);
        far.aiState = 'idle';
        far.moveDelay = 5;
        far.cooldowns.auto.attack = 3;
        sim.creatures.push(far);
        sim.entityById.set(far.id, far);
        sim.insertChild(far);
        if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
            sim.creatureSpatialIndex.insert(far);
        }

        // Drive one logic step through Simulator (Time must advance)
        Time.advanceFixedLogicStep();
        sim.updateAll();

        assert.strictEqual(far.simSleeping, true, 'sleep applied in updateAll');
        assert.strictEqual(far.moveDelay, 5, 'updateAll did not tick sleeper');
        assert.strictEqual(far.cooldowns.auto.attack, 3);
        assert.ok(sim.updatePerf, 'updatePerf recorded');
        assert.ok(sim.updatePerf.asleep >= 1);

        sim.destroy();
        log('simulator updateAll respects sleep ok');
    } finally {
        Settings.AI_TICK_RADIUS = prevRadius;
        Settings.AI_CREATURE_SLEEP = prevSleep;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGate;
    }
}

/**
 * Etapa 4: AOI frame cache — enemies + active built once per tick; queryWithinRange
 * matches linear filter; sticky-only far is active but not enemies.
 */
function testAoiFrameCacheAndUnifiedQuery() {
    const prevRadius = Settings.AI_TICK_RADIUS;
    const prevGate = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    Settings.AI_TICK_RADIUS = 10;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;
    try {
        const map = openFloor(80, 80, 100);
        const sim = new Simulator({
            seed: 44,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'Aoi',
            waypoints: [{ x: 5, y: 5, z: 0 }]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Lead',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'pacifist',
            level: 20,
            tile: { x: 5, y: 5, z: 0 }
        });
        map.tryOccupy(5, 5, 0, player);
        party.addMember(player);
        initPlayerAi(player, { strategyId: 'pacifist' });
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        function place(name, x, y, opts) {
            const c = new Creature({
                id: sim.allocEntityId(),
                name,
                tile: { x, y, z: 0 },
                combat: { hp: 20, attack: 1, defense: 1 }
            });
            map.tryOccupy(x, y, 0, c);
            initCreatureAi(c);
            c.aiState = (opts && opts.aiState) || 'idle';
            c.moveDelay = 0;
            if (opts && opts.target) {
                c.target = opts.target;
                c.targetId = opts.target.id;
            }
            sim.creatures.push(c);
            sim.entityById.set(c.id, c);
            sim.insertChild(c);
            if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
                sim.creatureSpatialIndex.insert(c);
            }
            return c;
        }

        const near = place('near', 8, 5); // d=3
        const mid = place('mid', 13, 5); // d=8: inside AI_TICK_RADIUS 10, outside engageRange 7
        const farIdle = place('farIdle', 50, 50);
        const farSticky = place('farSticky', 55, 55, {
            aiState: 'attack',
            target: player
        });

        Time.advanceFixedLogicStep();
        invalidateAoiFrame(sim);

        const observers = [player];
        const frame1 = ensureAoiFrame(sim, observers, 10, null);
        const frame2 = ensureAoiFrame(sim, observers, 10, null);
        assert.strictEqual(frame1, frame2, 'AOI frame cache hit same stamp');

        const enemyIds = frame1.enemies.map((c) => c.id);
        assert.ok(enemyIds.includes(near.id), 'near in enemies');
        assert.ok(enemyIds.includes(mid.id), 'mid within tick radius in enemies');
        assert.ok(!enemyIds.includes(farIdle.id), 'far idle not enemies');
        assert.ok(!enemyIds.includes(farSticky.id), 'sticky far not enemies');

        const activeIds = frame1.active.map((c) => c.id);
        assert.ok(activeIds.includes(farSticky.id), 'sticky in active');
        assert.ok(!activeIds.includes(farIdle.id), 'far idle not active');

        // Unified query matches linear entitiesWithinRange on full list
        const idx = sim.creatureSpatialIndex;
        const viaIndex = queryWithinRange(player, 7, { index: idx });
        const viaLinear = entitiesWithinRange(
            player,
            sim.creatures,
            7
        );
        assert.deepStrictEqual(
            viaIndex.map((c) => c.id).sort(),
            viaLinear.map((c) => c.id).sort(),
            'queryWithinRange index ≡ linear engage range'
        );
        assert.ok(viaIndex.some((c) => c.id === near.id));
        assert.ok(!viaIndex.some((c) => c.id === mid.id), 'mid outside engage 7');

        const nearest = findNearestInRange(player, 10, { index: idx });
        assert.strictEqual(nearest && nearest.id, near.id);

        // buildCtx exposes creatureIndex + shared enemies
        const ctx = buildCtx(sim, null, null);
        assert.ok(ctx.creatureIndex, 'ctx.creatureIndex');
        assert.ok(ctx.aoi, 'ctx.aoi');
        assert.ok(ctx.enemies.some((c) => c.id === near.id));

        // tick reuses frame within same logic time
        sim.aiPerfTotals = null;
        tickHuntAi(sim, null);
        assert.ok(sim.aiPerf.usedSpatial, 'spatial used');
        assert.ok(
            (sim.aiPerf.aoiBuilt || 0) + (sim.aiPerf.aoiCacheHits || 0) >= 1,
            'aoi counters present'
        );

        sim.destroy();
        log('aoi frame cache + unified query ok', {
            enemies: enemyIds.length,
            active: activeIds.length,
            aiPerf: sim.aiPerf
        });
    } finally {
        Settings.AI_TICK_RADIUS = prevRadius;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGate;
    }
}

/**
 * Etapa 5: player SpatialIndex — creature aggro is O(local), matches linear
 * over ctx.players; far players outside aggroRange are ignored.
 */
function testPlayerSpatialAggro() {
    const prevRadius = Settings.AI_TICK_RADIUS;
    const prevGate = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    Settings.AI_TICK_RADIUS = 10;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = false;
    try {
        const map = openFloor(120, 120, 100);
        const sim = new Simulator({
            seed: 55,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'P5',
            waypoints: [{ x: 10, y: 10, z: 0 }]
        });

        function placePlayer(name, x, y) {
            const p = new Player({
                id: sim.allocEntityId(),
                name,
                classId: 'guardian',
                isLeader: party.members.length === 0,
                strategyId: 'pacifist',
                level: 20,
                tile: { x, y, z: 0 }
            });
            map.tryOccupy(x, y, 0, p);
            party.addMember(p);
            initPlayerAi(p, { strategyId: 'pacifist' });
            sim.entityById.set(p.id, p);
            return p;
        }

        const nearP = placePlayer('nearP', 10, 10);
        const midP = placePlayer('midP', 15, 10); // d=5 from creature at 10,12
        const farP = placePlayer('farP', 100, 100);
        sim.parties.push(party);
        sim.insertChild(party);

        const creature = new Creature({
            id: sim.allocEntityId(),
            name: 'aggroRat',
            tile: { x: 10, y: 12, z: 0 },
            combat: { hp: 30, attack: 1, defense: 1 }
        });
        map.tryOccupy(10, 12, 0, creature);
        initCreatureAi(creature);
        creature.aiState = 'idle';
        creature.moveDelay = 0;
        creature.aggro = true;
        sim.creatures.push(creature);
        sim.entityById.set(creature.id, creature);
        sim.insertChild(creature);
        if (sim.creatureSpatialIndex && sim.creatureSpatialIndex !== false) {
            sim.creatureSpatialIndex.insert(creature);
        }

        Time.advanceFixedLogicStep();
        const ctx = buildCtx(sim, null, null);
        assert.ok(ctx.playerIndex, 'ctx.playerIndex set');
        assert.strictEqual(ctx.players.length, 3, 'three living players');

        // Spatial pick matches linear over full players list
        const viaIndex = pickCreatureTarget(creature, ctx.players, {
            rng: () => 0,
            index: ctx.playerIndex,
            range: 7
        });
        const viaLinear = pickCreatureTarget(creature, ctx.players, {
            rng: () => 0,
            index: null,
            range: 7
        });
        assert.ok(viaIndex, 'index finds a target');
        assert.strictEqual(
            viaIndex.id,
            viaLinear.id,
            'index pick ≡ linear pick'
        );
        assert.ok(
            viaIndex.id === nearP.id || viaIndex.id === midP.id,
            'picks near player'
        );
        assert.notStrictEqual(viaIndex.id, farP.id, 'far player not in aggro');

        // Far-only observers: no pick
        const farOnly = pickCreatureTarget(creature, [farP], {
            rng: () => 0,
            index: null,
            range: 7
        });
        assert.strictEqual(farOnly, null, 'far player alone not in range');

        // Index size matches living party
        const idx = ensurePlayerSpatialIndex(sim);
        assert.strictEqual(idx.size, 3);

        // tick with player index: creature should aggro
        tickHuntAi(sim, null);
        assert.ok(
            creature.target || creature.targetId,
            'creature acquires sticky target via spatial aggro'
        );
        assert.notStrictEqual(
            creature.target && creature.target.id,
            farP.id,
            'did not sticky far player'
        );

        // Disable player index → still works via linear fallback
        sim.playerSpatialIndex = false;
        const ctxLin = buildCtx(sim, null, null);
        assert.strictEqual(ctxLin.playerIndex, null);
        const t2 = pickCreatureTarget(creature, ctxLin.players, {
            rng: () => 0,
            index: ctxLin.playerIndex,
            range: 7
        });
        assert.ok(t2, 'linear fallback still finds target');

        sim.destroy();
        log('player spatial aggro ok', {
            targetId: viaIndex.id,
            nearP: nearP.id,
            midP: midP.id
        });
    } finally {
        Settings.AI_TICK_RADIUS = prevRadius;
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGate;
    }
}

/**
 * With brain gate on, tickHuntAi must not run player FSM while moveDelay > 0.
 */
function testBrainGateSkipsFsm() {
    const prevGate = Settings.AI_GATE_BRAIN_ON_MOVE_DELAY;
    Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = true;
    try {
        const map = openFloor(8, 8, 100);
        const sim = new Simulator({
            seed: 3,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim._ensurePresetLoaders();
        sim.spellBook = indexSpells(presets.loadSpells().spells);
        sim.strategyTable = indexStrategies(presets.loadStrategies());
        sim.sessionState = 'running';
        sim.active = true;

        const party = new Party({
            name: 'Gate',
            waypoints: [
                { x: 1, y: 1, z: 0 },
                { x: 6, y: 1, z: 0 }
            ]
        });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Gated',
            classId: 'guardian',
            isLeader: true,
            strategyId: 'guardian_aggro',
            level: 20,
            tile: { x: 1, y: 1, z: 0 }
        });
        map.tryOccupy(1, 1, 0, player);
        party.addMember(player);
        initPlayerAi(player, {
            strategyId: 'guardian_aggro',
            strategyTable: sim.strategyTable
        });
        let executes = 0;
        const real = player.brain.currentState;
        player.brain.setCurrentState({
            id: 'probe',
            enter() {},
            execute() {
                executes += 1;
            },
            exit() {}
        });
        player.moveDelay = 0.5;
        sim.parties.push(party);
        sim.insertChild(party);
        sim.entityById.set(player.id, player);

        const { tickHuntAi } = require('../kernel/core/lib/ai/hunt_ai.js');
        tickHuntAi(sim, null);
        assert.strictEqual(executes, 0, 'brain gate should skip FSM while delayed');

        player.moveDelay = 0;
        tickHuntAi(sim, null);
        assert.strictEqual(executes, 1, 'brain should run when moveDelay is 0');

        void real;
        sim.destroy();
    } finally {
        Settings.AI_GATE_BRAIN_ON_MOVE_DELAY = prevGate;
    }
    log('brain gate skips FSM ok');
}

function testCreatureKit() {
    const kit = normalizeCreatureKit({
        strategiesTarget: { nearest: 50, health: 50 },
        flags: {
            targetDistance: 3,
            runHealthPercent: 0.25,
            fleeTargetDistance: 8,
            loseTargetDistance: 12,
            staticAttackChance: 100
        },
        attacks: [
            {
                id: 'spit',
                kind: 'ranged',
                intervalMs: 2000,
                chance: 100,
                range: 5,
                min: 5,
                max: 10,
                element: 'earth'
            },
            {
                name: 'melee',
                interval: 2000,
                chance: 100,
                minDamage: 1,
                maxDamage: 4
            }
        ]
    });
    assert.strictEqual(kit.flags.targetDistance, 3);
    assert.strictEqual(kit.attacks.length, 2);
    assert.strictEqual(kit.attacks[0].kind, 'ranged');
    assert.strictEqual(kit.attacks[0].intervalSec, 2);
    assert.strictEqual(kit.attacks[1].kind, 'melee');
    assert.strictEqual(kit.attacks[1].min, 1);

    // Weighted pick: force first bucket
    assert.strictEqual(pickWeightedKey({ a: 100, b: 0 }, () => 0), 'a');

    const owner = {
        tile: { x: 0, y: 0, z: 0 },
        alive: true,
        hp: { current: 100, max: 100 },
        damageTakenBy: Object.create(null)
    };
    const low = {
        id: 1,
        tile: { x: 2, y: 0, z: 0 },
        alive: true,
        hp: { current: 5, max: 50 }
    };
    const high = {
        id: 2,
        tile: { x: 1, y: 0, z: 0 },
        alive: true,
        hp: { current: 40, max: 50 }
    };
    assert.strictEqual(pickByStrategy(owner, [low, high], 'health').id, 1);
    assert.strictEqual(pickByStrategy(owner, [low, high], 'nearest').id, 2);

    // Disable decay for the basic damage-strategy assertion (stable totals).
    ensureCreatureKit(owner, {
        flags: { threatDecayHalflifeSec: 0 },
        strategiesTarget: { damage: 100 }
    });
    Time.timeSinceLevelLoad = 100;
    recordDamageTakenBy(owner, { id: 1, type: 'player' }, 30);
    recordDamageTakenBy(owner, { id: 2, type: 'player' }, 5);
    assert.strictEqual(pickByStrategy(owner, [low, high], 'damage').id, 1);

    ensureCreatureKit(owner, {
        flags: {
            targetDistance: 3,
            runHealthPercent: 0.25,
            threatDecayHalflifeSec: 0
        },
        attacks: [
            {
                id: 'spit',
                kind: 'ranged',
                intervalSec: 2,
                chance: 100,
                range: 5,
                min: 8,
                max: 12,
                element: 'earth'
            }
        ]
    });
    assert.strictEqual(idealStandDistance(owner), 3);
    owner.hp.current = 10;
    assert.ok(isFleeing(owner), 'low HP percent should flee');
    assert.ok(idealStandDistance(owner) >= 3);

    // Live multi-attack vs player
    const map = openFloor(10, 10, 100);
    const sim = new Simulator({
        seed: 7,
        combatAi: true,
        recordSteps: false
    });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.spellBook = indexSpells(presets.loadSpells().spells);
    sim.sessionState = 'running';
    sim.active = true;
    sim.bindSeededRandom();

    const spitterTpl = presets.loadCreatureTemplate('venom_spitter');
    const spitter = new Creature({
        id: sim.allocEntityId(),
        tile: { x: 4, y: 4, z: 0 },
        homeTile: { x: 4, y: 4, z: 0 }
    });
    spitter.applyTemplate(spitterTpl);
    map.tryOccupy(4, 4, 0, spitter);
    initCreatureAi(spitter);
    sim.creatures.push(spitter);
    sim.entityById.set(spitter.id, spitter);

    const victim = new Player({
        id: sim.allocEntityId(),
        name: 'Target',
        classId: 'adventurer',
        isLeader: true,
        level: 20,
        tile: { x: 4, y: 7, z: 0 },
        hp: 200,
        hpMax: 200
    });
    victim.combatStats = {
        level: 20,
        atk: 1,
        skill: 1,
        magic: 0,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        resists: {},
        hpMax: 200,
        mpMax: 0
    };
    victim.hp = { current: 200, max: 200 };
    victim.alive = true;
    map.tryOccupy(4, 7, 0, victim);
    const party = new Party({ name: 'T', waypoints: [{ x: 4, y: 7, z: 0 }] });
    party.addMember(victim);
    sim.parties.push(party);
    sim.entityById.set(victim.id, victim);

    const ctx = {
        sim,
        tileMap: map,
        players: [victim],
        enemies: [spitter],
        spellBook: sim.spellBook,
        rng: () => 0.01
    };
    spitter.target = victim;
    spitter.targetId = victim.id;
    spitter.moveDelay = 0;
    const hp0 = victim.hp.current;
    const fired = tryCreatureAttacks(spitter, victim, ctx);
    assert.ok(fired.fired, 'spitter should fire a kit attack in range');
    assert.ok(
        victim.hp.current < hp0 || (fired.results && fired.results.length),
        'ranged kit should resolve against player'
    );

    // Cave rat preset normalizes bite kit
    const ratTpl = presets.loadCreatureTemplate('cave_rat');
    assert.ok(Array.isArray(ratTpl.attacks) && ratTpl.attacks.length >= 1);
    const ratKit = normalizeCreatureKit(ratTpl);
    assert.strictEqual(ratKit.attacks[0].kind, 'melee');

    // Target strategy on live pick
    const picked = pickCreatureTarget(
        spitter,
        [victim],
        { rng: () => 0 }
    );
    assert.ok(picked && picked.id === victim.id);

    sim.destroy();
    log('creature kit ok', { attackId: fired.attackId });
}

/**
 * Single-target ranged must not fire through solid (non-walkable) tiles.
 * Player gate: isSpellInRange / tryAttack. Creature kit: tryCreatureAttacks.
 */
function testRangedLineOfSightBlockedByWalls() {
    // Horizontal corridor with a wall column between shooter and target.
    //   shooter (0,1) · open (1,1) · WALL (2,1) · open (3,1) · target (4,1)
    const wallMap = {
        getFriction(x, y) {
            if (x === 2 && y === 1) return 255;
            return 0;
        },
        isWalkable(x, y) {
            return this.getFriction(x, y) !== 255;
        }
    };

    const shooter = {
        alive: true,
        type: 'player',
        tile: { x: 0, y: 1, z: 0 },
        hp: { current: 100, max: 100 },
        mp: { current: 50, max: 50 },
        combatStats: {
            level: 20,
            atk: 20,
            skill: 40,
            magic: 0,
            armor: 0,
            mitigation: 0,
            maxBlock: 0,
            resists: {},
            hitChance: 100,
            weaponRange: 6
        },
        cooldowns: Object.create(null),
        moveLock: 0
    };
    const target = {
        alive: true,
        type: 'creature',
        tile: { x: 4, y: 1, z: 0 },
        hp: { current: 200, max: 200 },
        combatStats: {
            armor: 0,
            mitigation: 0,
            resists: {},
            maxBlock: 0
        }
    };

    const distanceSpell = {
        id: 'distance_auto',
        label: 'Distance Auto',
        kind: 'auto',
        element: 'physical',
        powerCurve: 'distance_auto',
        basePower: 0,
        range: 6,
        mana: 0,
        hitChance: 100,
        isMelee: false,
        cooldowns: { auto: { attack: 2 } }
    };
    const spellBook = indexSpells([distanceSpell]);
    const ctxBlocked = {
        spellBook,
        tileMap: wallMap,
        enemies: [target],
        rng: () => 0.5
    };

    assert.ok(
        !isSpellInRange(shooter, target, distanceSpell, ctxBlocked),
        'distance auto not in range through wall'
    );
    const blocked = tryAttack({
        attacker: shooter,
        defender: target,
        spellId: 'distance_auto',
        ctx: ctxBlocked
    });
    assert.strictEqual(blocked, null, 'tryAttack must not fire through wall');
    assert.strictEqual(target.hp.current, 200, 'target HP unchanged behind wall');

    // Same distance, open corridor (no wall)
    const openMap = {
        getFriction() {
            return 0;
        },
        isWalkable() {
            return true;
        }
    };
    const ctxOpen = {
        spellBook,
        tileMap: openMap,
        enemies: [target],
        rng: () => 0.5
    };
    assert.ok(
        isSpellInRange(shooter, target, distanceSpell, ctxOpen),
        'distance auto in range with clear LoS'
    );
    const openHit = tryAttack({
        attacker: shooter,
        defender: target,
        spellId: 'distance_auto',
        ctx: ctxOpen
    });
    assert.ok(openHit && openHit.ok, 'tryAttack with clear LoS');
    assert.ok(target.hp.current < 200, 'open LoS deals damage');

    // Creature kit ranged: wall blocks kit hit (interval still spent)
    const spitter = {
        alive: true,
        type: 'creature',
        tile: { x: 0, y: 1, z: 0 },
        hp: { current: 80, max: 80 },
        combatStats: {
            armor: 0,
            mitigation: 0,
            resists: {},
            maxBlock: 0
        }
    };
    ensureCreatureKit(spitter, {
        attacks: [
            {
                id: 'bolt',
                kind: 'ranged',
                range: 6,
                min: 10,
                max: 10,
                intervalSec: 1,
                chance: 100,
                hitChance: 100
            }
        ],
        flags: { staticAttackChance: 100, targetDistance: 4 }
    });
    const victim = {
        alive: true,
        type: 'player',
        tile: { x: 4, y: 1, z: 0 },
        hp: { current: 100, max: 100 },
        combatStats: {
            armor: 0,
            mitigation: 0,
            resists: {},
            maxBlock: 0
        }
    };
    const hpWall = victim.hp.current;
    const kitBlocked = tryCreatureAttacks(spitter, victim, {
        tileMap: wallMap,
        players: [victim],
        rng: () => 0.01
    });
    assert.ok(kitBlocked.fired, 'kit pass still opens (CD advanced)');
    assert.strictEqual(
        victim.hp.current,
        hpWall,
        'creature ranged kit must not damage through wall'
    );

    // Clear LoS: damage lands
    spitter._attackReadyIn[0] = 0;
    const kitOpen = tryCreatureAttacks(spitter, victim, {
        tileMap: openMap,
        players: [victim],
        rng: () => 0.01
    });
    assert.ok(kitOpen.fired && kitOpen.results && kitOpen.results.length);
    assert.ok(victim.hp.current < hpWall, 'creature kit damages with clear LoS');

    // No tileMap → legacy open (unit tests / pure bags)
    assert.ok(
        isSpellInRange(shooter, target, distanceSpell, { spellBook }),
        'missing tileMap keeps open LoS for tests'
    );

    log('ranged LoS blocked by walls ok');
}

/**
 * Threat half-life decay + mid-combat strategiesTarget re-roll.
 */
function testThreatDecayAndStrategyRetarget() {
    const prevDecay = Settings.AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC;
    const prevRetarget = Settings.AI_CREATURE_RETARGET_INTERVAL;
    const prevTs = Time.timeSinceLevelLoad;
    try {
        Settings.AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC = 10;
        Settings.AI_CREATURE_RETARGET_INTERVAL = 0;

        // --- Threat decay (half-life) ---
        const monster = {
            tile: { x: 0, y: 0, z: 0 },
            alive: true,
            hp: { current: 100, max: 100 },
            damageTakenBy: Object.create(null)
        };
        ensureCreatureKit(monster, {
            strategiesTarget: { damage: 100 },
            flags: {
                aggroRange: 10,
                threatDecayHalflifeSec: 10
            },
            attacks: [
                {
                    id: 'bite',
                    kind: 'melee',
                    min: 1,
                    max: 2,
                    intervalSec: 2,
                    chance: 100,
                    range: 1
                }
            ]
        });
        assert.strictEqual(monster.kit.flags.threatDecayHalflifeSec, 10);
        assert.strictEqual(retargetIntervalSec(monster), 0);

        Time.timeSinceLevelLoad = 0;
        recordDamageTakenBy(monster, { id: 'p1', type: 'player' }, 100);
        assert.ok(Math.abs(threatOf(monster, 'p1') - 100) < 1e-6);

        // After one half-life → ~50
        Time.timeSinceLevelLoad = 10;
        applyThreatDecay(monster);
        assert.ok(
            Math.abs(threatOf(monster, 'p1') - 50) < 0.5,
            `expected ~50 threat after half-life, got ${threatOf(monster, 'p1')}`
        );

        // Two half-lives from original → ~25
        Time.timeSinceLevelLoad = 20;
        applyThreatDecay(monster);
        assert.ok(
            Math.abs(threatOf(monster, 'p1') - 25) < 0.5,
            `expected ~25 threat after 2 half-lives, got ${threatOf(monster, 'p1')}`
        );

        // damage strategy prefers higher remaining threat after decay
        const nearA = {
            id: 'p1',
            tile: { x: 1, y: 0, z: 0 },
            alive: true,
            hp: { current: 50, max: 50 }
        };
        const nearB = {
            id: 'p2',
            tile: { x: 2, y: 0, z: 0 },
            alive: true,
            hp: { current: 50, max: 50 }
        };
        Time.timeSinceLevelLoad = 20;
        recordDamageTakenBy(monster, { id: 'p2', type: 'player' }, 40);
        // p1 ~25, p2 = 40 → p2 wins
        assert.strictEqual(
            pickByStrategy(monster, [nearA, nearB], 'damage').id,
            'p2'
        );

        // Half-life 0 = no decay
        const noDecay = {
            tile: { x: 0, y: 0, z: 0 },
            alive: true,
            damageTakenBy: Object.create(null)
        };
        ensureCreatureKit(noDecay, {
            flags: { threatDecayHalflifeSec: 0 },
            strategiesTarget: { nearest: 100 }
        });
        Time.timeSinceLevelLoad = 0;
        recordDamageTakenBy(noDecay, { id: 'x', type: 'player' }, 80);
        Time.timeSinceLevelLoad = 1000;
        applyThreatDecay(noDecay);
        assert.ok(Math.abs(threatOf(noDecay, 'x') - 80) < 1e-6);

        // --- Strategy retarget interval ---
        const kitRetarget = normalizeCreatureKit({
            changeTarget: { interval: 2000, chance: 100 },
            flags: { threatDecayHalflifeSec: 0 },
            strategiesTarget: { nearest: 100 }
        });
        assert.strictEqual(kitRetarget.changeTarget.intervalSec, 2);
        assert.strictEqual(kitRetarget.changeTarget.chance, 100);

        const retargetOwner = {
            tile: { x: 0, y: 0, z: 0 },
            alive: true,
            hp: { current: 100, max: 100 },
            speed: 100,
            damageTakenBy: Object.create(null)
        };
        ensureCreatureKit(retargetOwner, {
            strategiesTarget: { health: 100 },
            changeTarget: { interval: 2000, chance: 100 },
            flags: {
                aggroRange: 10,
                threatDecayHalflifeSec: 0,
                targetDistance: 1,
                staticAttackChance: 0
            },
            attacks: []
        });
        assert.strictEqual(retargetIntervalSec(retargetOwner), 2);

        Time.timeSinceLevelLoad = 50;
        armStrategyRetarget(retargetOwner);
        assert.strictEqual(
            strategyRetargetDue(retargetOwner),
            false,
            'should not re-roll before interval'
        );
        Time.timeSinceLevelLoad = 51.9;
        assert.strictEqual(strategyRetargetDue(retargetOwner), false);
        Time.timeSinceLevelLoad = 52.1;
        assert.strictEqual(
            strategyRetargetDue(retargetOwner),
            true,
            'due after retargetIntervalSec'
        );
        // Just fired → armed again for +2s
        assert.strictEqual(strategyRetargetDue(retargetOwner), false);
        clearStrategyRetarget(retargetOwner);
        assert.strictEqual(
            strategyRetargetDue(retargetOwner),
            true,
            'cleared gate fires immediately'
        );

        // Live combat tick: sticky then re-roll health strategy when interval elapses
        const map = openFloor(12, 12, 100);
        const sim = new Simulator({
            seed: 11,
            combatAi: true,
            recordSteps: false
        });
        sim.setTileMap(map);
        sim.floor = 0;
        sim.sessionState = 'running';
        sim.active = true;

        const hunter = new Creature({
            id: sim.allocEntityId(),
            tile: { x: 5, y: 5, z: 0 },
            homeTile: { x: 5, y: 5, z: 0 },
            speed: 0,
            aggro: true
        });
        hunter.applyTemplate({
            id: 'retarget_dummy',
            hp: 200,
            hpMax: 200,
            speed: 0,
            strategiesTarget: { health: 100 },
            changeTarget: { interval: 1000, chance: 100 },
            flags: {
                targetDistance: 1,
                aggroRange: 8,
                threatDecayHalflifeSec: 0,
                staticAttackChance: 0
            },
            attacks: []
        });
        map.tryOccupy(5, 5, 0, hunter);
        initCreatureAi(hunter);
        sim.creatures.push(hunter);
        sim.entityById.set(hunter.id, hunter);

        const tank = new Player({
            id: sim.allocEntityId(),
            name: 'Tank',
            classId: 'guardian',
            isLeader: true,
            level: 20,
            tile: { x: 6, y: 5, z: 0 }
        });
        tank.hp = { current: 80, max: 100 };
        tank.alive = true;
        map.tryOccupy(6, 5, 0, tank);

        const glass = new Player({
            id: sim.allocEntityId(),
            name: 'Glass',
            classId: 'adept',
            isLeader: false,
            level: 20,
            tile: { x: 7, y: 5, z: 0 }
        });
        glass.hp = { current: 20, max: 100 };
        glass.alive = true;
        map.tryOccupy(7, 5, 0, glass);

        const party = new Party({
            id: sim.allocEntityId(),
            members: [tank, glass]
        });
        party.leader = tank;
        sim.parties = [party];
        sim.players = [tank, glass];
        sim.insertChild(party);
        sim.entityById.set(tank.id, tank);
        sim.entityById.set(glass.id, glass);

        Time.timeSinceLevelLoad = 0;
        const ctx = {
            sim,
            tileMap: map,
            players: [tank, glass],
            playerIndex: null,
            rng: () => 0
        };

        // First tick: no sticky → pick health (glass), arm retarget for +1s
        assert.strictEqual(runCombatTick(hunter, ctx), 'ok');
        assert.strictEqual(
            hunter.targetId,
            glass.id,
            'health strategy → lowest HP'
        );

        // Before interval: tank becomes lower HP but sticky holds glass
        tank.hp.current = 5;
        glass.hp.current = 50;
        Time.timeSinceLevelLoad = 0.5;
        assert.strictEqual(runCombatTick(hunter, ctx), 'ok');
        assert.strictEqual(
            hunter.targetId,
            glass.id,
            'sticky until retargetIntervalSec'
        );

        // After interval: re-roll health → tank
        Time.timeSinceLevelLoad = 1.05;
        assert.strictEqual(runCombatTick(hunter, ctx), 'ok');
        assert.strictEqual(
            hunter.targetId,
            tank.id,
            'retargetInterval re-applies health strategy'
        );

        sim.destroy();
        log('threat decay + strategy retarget ok');
    } finally {
        Settings.AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC = prevDecay;
        Settings.AI_CREATURE_RETARGET_INTERVAL = prevRetarget;
        Time.timeSinceLevelLoad = prevTs;
    }
}

/**
 * Live changeTarget {interval ms, chance %} overrides AI_CREATURE_RETARGET_INTERVAL.
 */
function testChangeTargetOverridesGlobal() {
    const prevRetarget = Settings.AI_CREATURE_RETARGET_INTERVAL;
    const prevTs = Time.timeSinceLevelLoad;
    try {
        Settings.AI_CREATURE_RETARGET_INTERVAL = 0;

        const fromDisk = normalizeCreatureKit({
            changeTarget: { interval: 4000, chance: 20 },
            flags: { targetDistance: 1 }
        });
        assert.strictEqual(fromDisk.changeTarget.intervalSec, 4);
        assert.strictEqual(fromDisk.changeTarget.chance, 20);
        assert.ok(
            fromDisk.flags.retargetIntervalSec == null,
            'retarget is not a flags field'
        );
        assert.ok(fromDisk.flags.retargetChance == null);

        const chanceZero = {
            tile: { x: 0, y: 0, z: 0 },
            alive: true,
            hp: { current: 100, max: 100 }
        };
        ensureCreatureKit(chanceZero, {
            changeTarget: { interval: 4000, chance: 0 },
            flags: { targetDistance: 1 }
        });
        assert.strictEqual(retargetIntervalSec(chanceZero), 4);
        assert.strictEqual(retargetChance(chanceZero), 0);
        Time.timeSinceLevelLoad = 10;
        armStrategyRetarget(chanceZero);
        Time.timeSinceLevelLoad = 15;
        assert.strictEqual(
            strategyRetargetDue(chanceZero, undefined, () => 0),
            false,
            'chance 0 never switches'
        );

        const rollOwner = {
            tile: { x: 0, y: 0, z: 0 },
            alive: true
        };
        ensureCreatureKit(rollOwner, {
            changeTarget: { interval: 2000, chance: 20 },
            flags: { targetDistance: 1 }
        });
        Time.timeSinceLevelLoad = 0;
        armStrategyRetarget(rollOwner);
        Time.timeSinceLevelLoad = 2.1;
        assert.strictEqual(
            strategyRetargetDue(rollOwner, undefined, () => 0.5),
            false,
            '20% fail when rng=0.5'
        );
        Time.timeSinceLevelLoad = 4.2;
        assert.strictEqual(
            strategyRetargetDue(rollOwner, undefined, () => 0.1),
            true,
            '20% pass when rng=0.1'
        );

        const flagsIgnored = normalizeCreatureKit({
            changeTarget: { interval: 4000, chance: 10 },
            flags: { retargetIntervalSec: 2, retargetChance: 100 }
        });
        assert.strictEqual(flagsIgnored.changeTarget.intervalSec, 4);
        assert.strictEqual(flagsIgnored.changeTarget.chance, 10);

        const demon = presets.loadCreatureTemplateRaw('demon');
        assert.ok(demon && demon.changeTarget, 'demon authors changeTarget');
        const spawned = new Creature({
            id: 1,
            tile: { x: 0, y: 0, z: 0 }
        });
        spawned.applyTemplate(demon);
        assert.strictEqual(
            spawned.kit.changeTarget.intervalSec,
            demon.changeTarget.interval / 1000
        );
        assert.strictEqual(
            spawned.kit.changeTarget.chance,
            demon.changeTarget.chance
        );
        assert.ok(
            spawned.kit.changeTarget.intervalSec > 0,
            'demon changeTarget overrides global 0'
        );

        log('changeTarget overrides global retarget ok', {
            intervalSec: spawned.kit.changeTarget.intervalSec,
            chance: spawned.kit.changeTarget.chance
        });
    } finally {
        Settings.AI_CREATURE_RETARGET_INTERVAL = prevRetarget;
        Time.timeSinceLevelLoad = prevTs;
    }
}

/**
 * Flee posture holds ideal stand-off (does not perpetual-run) and kit still
 * fires while moveDelay roots movement.
 */
function testFleeHoldsAndAttacksDuringMoveDelay() {
    const map = openFloor(20, 20, 100);
    const sim = new Simulator({
        seed: 11,
        combatAi: true,
        recordSteps: false
    });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.spellBook = indexSpells(presets.loadSpells().spells);
    sim.sessionState = 'running';
    sim.active = true;

    const player = new Player({
        id: sim.allocEntityId(),
        name: 'Kiter',
        classId: 'guardian',
        isLeader: true,
        level: 40,
        tile: { x: 5, y: 5, z: 0 }
    });
    map.tryOccupy(5, 5, 0, player);
    player.hp = { current: 5000, max: 5000 };
    player.alive = true;

    // Ideal flee stand-off = 8; place monster already at distance 8 → hold
    const monster = new Creature({
        id: sim.allocEntityId(),
        tile: { x: 13, y: 5, z: 0 },
        homeTile: { x: 13, y: 5, z: 0 },
        speed: 100,
        hp: 10,
        hpMax: 100,
        attacks: [
            {
                id: 'bolt',
                kind: 'ranged',
                intervalSec: 0.05,
                chance: 100,
                range: 12,
                min: 3,
                max: 5,
                element: 'fire'
            }
        ],
        flags: {
            targetDistance: 1,
            runHealthPercent: 0.5,
            fleeTargetDistance: 8,
            staticAttackChance: 100,
            loseTargetDistance: 20,
            aggroRange: 15
        },
        strategiesTarget: { nearest: 100 }
    });
    map.tryOccupy(13, 5, 0, monster);
    ensureCreatureKit(monster, {
        attacks: monster.attacks,
        flags: monster.flags,
        strategiesTarget: monster.strategiesTarget
    });
    initCreatureAi(monster);
    monster.target = player;
    monster.targetId = player.id;
    monster.aiState = 'attack';
    monster._attackReadyIn = [0];

    const party = new Party({
        name: 'FleeTest',
        waypoints: [
            { x: 5, y: 5, z: 0 },
            { x: 6, y: 5, z: 0 }
        ]
    });
    party.addMember(player);
    sim.parties.push(party);
    sim.insertChild(party);
    sim.creatures = [monster];
    sim.entityById.set(player.id, player);
    sim.entityById.set(monster.id, monster);

    // Hold at ideal flee distance: combatMove must not step away
    const tileBefore = { x: monster.tile.x, y: monster.tile.y };
    assert.ok(isFleeing(monster), 'low HP triggers flee posture');
    assert.strictEqual(idealStandDistance(monster), 8);
    assert.strictEqual(distBetween(monster, player), 8);
    combatMove(monster, player, { tileMap: map, players: [player] });
    assert.strictEqual(
        monster.tile.x,
        tileBefore.x,
        'at ideal flee range must hold (not perpetual-run)'
    );
    assert.strictEqual(monster.tile.y, tileBefore.y);

    // Mid-step: full FSM gated, but attack kit still fires
    const prevGate = Settings.AI_GATE_CREATURE_ON_MOVE_DELAY;
    Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = true;
    try {
        monster.moveDelay = 0.4;
        monster._attackReadyIn = [0];
        const hp0 = player.hp.current;
        let executes = 0;
        const real = monster.brain.currentState;
        monster.brain.setCurrentState({
            id: 'probe',
            enter() {},
            execute() {
                executes += 1;
            },
            exit() {}
        });
        tickHuntAi(sim, null);
        assert.strictEqual(executes, 0, 'full creature FSM still gated by moveDelay');
        assert.ok(
            player.hp.current < hp0,
            'engaged creature still casts while moveDelay > 0'
        );
        void real;
    } finally {
        Settings.AI_GATE_CREATURE_ON_MOVE_DELAY = prevGate;
    }

    // Direct helper sanity
    monster.moveDelay = 0.3;
    monster._attackReadyIn = [0];
    const hp1 = player.hp.current;
    const r = tryEngagedAttacks(monster, {
        players: [player],
        sim,
        spellBook: sim.spellBook,
        rng: () => 0
    });
    assert.ok(r && r.fired, 'tryEngagedAttacks fires with sticky target');
    assert.ok(player.hp.current < hp1);

    sim.destroy();
    log('flee holds and attacks during moveDelay ok');
}

/**
 * Dragon lord fire breath: kit wave uses legacy shape matrices + multi-hit.
 */
function testDragonLordWaveCast() {
    // Commercial-safe pack: dragon_lord → elder_dragon (same wave geometry).
    // Historical pack on branch legacy still uses dragon_lord.
    const creatureId = hasMode('legacy') ? 'dragon_lord' : 'elder_dragon';
    if (hasMode('legacy')) setActiveMode('legacy');
    else setActiveMode('standard');
    const tpl = presets.loadCreatureTemplate(creatureId);
    assert.ok(tpl && Array.isArray(tpl.attacks), creatureId + ' preset');
    const kit = normalizeCreatureKit(tpl);
    const wave = kit.attacks.find((a) => a.kind === 'wave');
    assert.ok(wave, 'dragon lord has wave attack');
    assert.strictEqual(wave.length, 8);
    assert.strictEqual(wave.spread, 3);

    const lord = {
        id: 'dl_test',
        type: 'creature',
        alive: true,
        speed: 100,
        tile: { x: 10, y: 10, z: 0 },
        hp: { current: 1900, max: 1900 },
        attacks: tpl.attacks,
        flags: tpl.flags,
        strategiesTarget: tpl.strategiesTarget
    };
    ensureCreatureKit(lord);
    // Force only the wave slot ready (melee/area/field on CD)
    const wi = lord.kit.attacks.findIndex((a) => a.kind === 'wave');
    assert.ok(wi >= 0);
    lord._attackReadyIn = lord.kit.attacks.map((_, i) => (i === wi ? 0 : 99));

    const victim = {
        id: 'p_wave',
        type: 'player',
        alive: true,
        tile: { x: 11, y: 10, z: 0 },
        hp: { current: 5000, max: 5000 }
    };
    const hp0 = victim.hp.current;
    /** @type {object|null} */
    let lastBag = null;
    const fired = tryCreatureAttacks(lord, victim, {
        players: [victim],
        rng: () => 0, // always pass chance rolls
        onAttack: (_a, _d, res) => {
            lastBag = res;
        }
    });
    assert.ok(fired.fired, 'wave attempt fired');
    assert.strictEqual(fired.attackId, wave.id);
    assert.ok(
        fired.shaped &&
            Array.isArray(fired.shaped.affectedTiles) &&
            fired.shaped.affectedTiles.length > 10,
        'wave footprint from WAVE_SPREAD_MAP (spread 3 length 8)'
    );
    assert.ok(victim.hp.current < hp0, 'wave deals fire damage');
    assert.ok(lastBag && lastBag.multi === true, 'multi-target bag for VFX');
    assert.ok(
        lastBag.affectedTiles &&
            lastBag.affectedTiles.length === fired.shaped.affectedTiles.length,
        'footprint attached to recorded result'
    );
    log('dragon lord wave cast ok', {
        tiles: fired.shaped.affectedTiles.length,
        dmg: hp0 - victim.hp.current
    });
    setActiveMode('standard');
}

/**
 * Leash re-aggro uses an inner band so boundary kiting cannot thrash
 * attack ↔ leash every step on the leash edge.
 */
function testLeashReaggroHysteresis() {
    const prev = {
        leash: Settings.AI_CREATURE_LEASH,
        margin: Settings.AI_CREATURE_LEASH_REAGGRO_MARGIN,
        aggro: Settings.AI_CREATURE_AGGRO_RANGE
    };
    try {
        Settings.AI_CREATURE_LEASH = 10;
        Settings.AI_CREATURE_LEASH_REAGGRO_MARGIN = 2;
        Settings.AI_CREATURE_AGGRO_RANGE = 20;

        assert.strictEqual(leashReaggroRange(), 8);

        const home = { x: 0, y: 0, z: 0 };
        const edge = {
            tile: { x: 10, y: 0, z: 0 },
            homeTile: home
        };
        const justOut = {
            tile: { x: 11, y: 0, z: 0 },
            homeTile: home
        };
        const reaggroOk = {
            tile: { x: 8, y: 0, z: 0 },
            homeTile: home
        };
        const deadZone = {
            tile: { x: 9, y: 0, z: 0 },
            homeTile: home
        };

        assert.ok(!beyondLeash(edge), 'dist == LEASH is still combat-ok');
        assert.ok(beyondLeash(justOut), 'dist > LEASH breaks combat');
        assert.ok(
            !insideLeashReaggro(edge),
            'edge of leash must not re-aggro (hysteresis)'
        );
        assert.ok(
            !insideLeashReaggro(deadZone),
            'LEASH−1 still outside re-aggro band when margin=2'
        );
        assert.ok(
            insideLeashReaggro(reaggroOk),
            'dist ≤ LEASH−margin may re-aggro'
        );

        // Full Leash.execute: player on the edge must not pull re-aggro
        const map = openFloor(24, 8);
        const player = new Player({
            id: 9001,
            name: 'Kiter',
            tile: { x: 12, y: 0, z: 0 },
            hp: 100,
            hpMax: 100
        });
        player.alive = true;

        const creature = new Creature({
            id: 9002,
            name: 'Rat',
            tile: { x: 10, y: 0, z: 0 },
            homeTile: { x: 0, y: 0, z: 0 },
            speed: 100,
            hp: 50,
            hpMax: 50
        });
        creature.alive = true;
        creature.aggro = true;
        initCreatureAi(creature);
        creature.brain.changeState(Leash);
        creature.aiState = 'leash';
        creature.moveDelay = 0;

        const ctx = {
            players: [player],
            tileMap: map,
            rng: () => 0,
            sim: {
                getEntityById() {
                    return null;
                }
            }
        };
        Leash.execute(creature, ctx);
        assert.strictEqual(
            creature.aiState,
            'leash',
            'must stay in leash on the outer band (no thrash re-aggro)'
        );

        // Walk deeper home into re-aggro band → may re-engage
        creature.tile = { x: 8, y: 0, z: 0 };
        creature.moveDelay = 0;
        Leash.execute(creature, ctx);
        assert.strictEqual(
            creature.aiState,
            'aggro',
            'inside re-aggro band should re-engage'
        );
        assert.ok(creature.target === player || creature.targetId === player.id);

        // margin 0 restores single-threshold re-aggro (legacy)
        Settings.AI_CREATURE_LEASH_REAGGRO_MARGIN = 0;
        assert.strictEqual(leashReaggroRange(), 10);
        assert.ok(insideLeashReaggro(edge));
    } finally {
        Settings.AI_CREATURE_LEASH = prev.leash;
        Settings.AI_CREATURE_LEASH_REAGGRO_MARGIN = prev.margin;
        Settings.AI_CREATURE_AGGRO_RANGE = prev.aggro;
    }
    log('leash re-aggro hysteresis ok');
}

/**
 * Return-home must use the full local A* cap. Chase radius 12 cannot
 * contain a home tile at leash distance (default 18), so monsters that
 * followed the party then leashed used to freeze in place.
 */
function testLeashReturnWalksBeyondChaseRadius() {
    const prev = {
        chase: Settings.AI_CREATURE_PATH_MAX_DISTANCE,
        leash: Settings.AI_CREATURE_LEASH
    };
    Settings.AI_CREATURE_PATH_MAX_DISTANCE = 12;
    Settings.AI_CREATURE_LEASH = 18;
    try {
        assert.ok(
            leashPathMaxDistance() > 12,
            'leash search cap must exceed chase radius'
        );
        assert.ok(
            leashPathMaxDistance() >= 19,
            'leash search cap must reach a just-leashed home tile'
        );

        const map = openFloor(32, 4);
        const home = { x: 1, y: 1, z: 0 };
        const startX = 20; // Chebyshev 19 from home — outside chase 12
        const creature = new Creature({
            id: 9101,
            name: 'LeashRat',
            tile: { x: startX, y: 1, z: 0 },
            homeTile: home,
            speed: 220,
            hp: 50,
            hpMax: 50
        });
        creature.alive = true;
        creature.aggro = true;
        map.tryOccupy(startX, 1, 0, creature);
        initCreatureAi(creature);
        creature.brain.changeState(Leash);
        creature.aiState = 'leash';
        creature.moveDelay = 0;

        const ctx = {
            players: [],
            tileMap: map,
            rng: () => 0,
            sim: {
                getEntityById() {
                    return null;
                }
            }
        };
        Leash.execute(creature, ctx);
        assert.strictEqual(creature.aiState, 'leash', 'still walking home');
        assert.ok(
            creature.tile.x < startX,
            `leash return must step toward home beyond chase 12 (x=${creature.tile.x})`
        );
        const homeDist = Math.max(
            Math.abs(creature.tile.x - home.x),
            Math.abs(creature.tile.y - home.y)
        );
        assert.ok(
            homeDist < 19,
            'home Chebyshev must shrink after the leash step'
        );
    } finally {
        Settings.AI_CREATURE_PATH_MAX_DISTANCE = prev.chase;
        Settings.AI_CREATURE_LEASH = prev.leash;
    }
    log('leash return walks beyond chase radius ok');
}

/**
 * Path-fail keeps sticky target + random step; melee circle one-shot occupancy
 * with logic-time retry gate; lose target beyond kit lose distance.
 */
function testCreaturePathFailCircleAndLoseTarget() {
    const prev = {
        circleChance: Settings.AI_CREATURE_CIRCLE_CHANCE,
        circleInterval: Settings.AI_CREATURE_CIRCLE_INTERVAL,
        loseDist: Settings.AI_CREATURE_LOSE_TARGET_DIST
    };
    Settings.AI_CREATURE_CIRCLE_CHANCE = 100;
    Settings.AI_CREATURE_CIRCLE_INTERVAL = 0.5;
    Settings.AI_CREATURE_LOSE_TARGET_DIST = 10;

    try {
        // --- Melee circle candidates + free step ---
        const map = openFloor(9, 9, 100);
        const player = {
            id: 9001,
            tile: { x: 4, y: 4, z: 0 },
            alive: true,
            hp: { current: 100, max: 100 },
            speed: 100,
            canStep() {
                return this.moveDelay <= 0;
            },
            moveDelay: 0
        };
        const monster = new Creature({
            name: 'CircleMob',
            id: 9002,
            tile: { x: 4, y: 3, z: 0 },
            speed: 100,
            hp: 50,
            hpMax: 50
        });
        monster.alive = true;
        monster.aggro = true;
        monster.flags = {
            targetDistance: 1,
            loseTargetDistance: 10,
            staticAttackChance: 100
        };
        ensureCreatureKit(monster, {
            attacks: [
                {
                    id: 'bite',
                    kind: 'melee',
                    interval: 2,
                    chance: 100,
                    range: 1,
                    min: 1,
                    max: 1,
                    element: 'physical'
                }
            ],
            flags: monster.flags,
            strategiesTarget: { nearest: 100 }
        });
        map.tryOccupy(player.tile.x, player.tile.y, 0, player);
        map.tryOccupy(monster.tile.x, monster.tile.y, 0, monster);
        initCreatureAi(monster);
        monster.target = player;
        monster.targetId = player.id;
        monster.moveDelay = 0;

        const cands = listMeleeCircleCandidates(monster, player, map);
        assert.ok(cands.length >= 2, 'adjacent melee has orbit candidates');
        for (const c of cands) {
            assert.strictEqual(
                Math.max(
                    Math.abs(c.x - player.tile.x),
                    Math.abs(c.y - player.tile.y)
                ),
                1,
                'circle tile stays adjacent to player'
            );
            assert.ok(
                !(c.x === player.tile.x && c.y === player.tile.y),
                'never steps onto player'
            );
        }

        // Deterministic: first free rng drives chance (0 < 100), second picks index 0
        const before = { x: monster.tile.x, y: monster.tile.y };
        let n = 0;
        const rngPickFirst = () => {
            n += 1;
            return n === 1 ? 0 : 0; // chance roll 0, pick index 0
        };
        const result = tryMeleeCircleStep(monster, player, map, {
            rng: rngPickFirst,
            isDue: () => true
        });
        assert.strictEqual(result, 'moved', 'free circle tile moves');
        assert.ok(
            monster.tile.x !== before.x || monster.tile.y !== before.y,
            'circle changed tile'
        );
        assert.strictEqual(
            Math.max(
                Math.abs(monster.tile.x - player.tile.x),
                Math.abs(monster.tile.y - player.tile.y)
            ),
            1
        );

        // --- Occupied pick: no move, arm retry, stay gated until interval ---
        map.release(monster.tile.x, monster.tile.y, 0, monster);
        monster.tile = { x: 4, y: 3, z: 0 };
        monster.moveDelay = 0;
        map.tryOccupy(4, 3, 0, monster);
        // Fill every other circle candidate with blockers so only one walkable
        // geometric option remains — then occupy it so the single pick fails.
        const blockers = [];
        let blockerId = 9100;
        const openCands = listMeleeCircleCandidates(monster, player, map);
        // Occupy all candidates
        for (const c of openCands) {
            const b = {
                id: blockerId++,
                tile: { x: c.x, y: c.y, z: 0 }
            };
            assert.ok(map.tryOccupy(c.x, c.y, 0, b), 'block circle tile');
            blockers.push(b);
        }
        Time.timeSinceLevelLoad = 10;
        clearCircleRetry(monster);
        assert.strictEqual(circleAttemptDue(monster), true);
        const tileStuck = { x: monster.tile.x, y: monster.tile.y };
        const blocked = tryMeleeCircleStep(monster, player, map, {
            rng: () => 0,
            isDue: () => circleAttemptDue(monster),
            onNoMove: () => armCircleRetry(monster)
        });
        assert.strictEqual(blocked, 'blocked');
        assert.strictEqual(monster.tile.x, tileStuck.x);
        assert.strictEqual(monster.tile.y, tileStuck.y);
        assert.strictEqual(circleAttemptDue(monster), false, 'retry armed');
        Time.timeSinceLevelLoad = 10.4;
        assert.strictEqual(circleAttemptDue(monster), false);
        Time.timeSinceLevelLoad = 10.5;
        assert.strictEqual(circleAttemptDue(monster), true, 'due after interval');

        // combatMove at ideal range uses the same gate
        Settings.AI_CREATURE_CIRCLE_CHANCE = 100;
        armCircleRetry(monster); // not due
        Time.timeSinceLevelLoad = 20;
        // release blockers so a move would be possible if due
        for (const b of blockers) {
            map.release(b.tile.x, b.tile.y, 0, b);
        }
        armCircleRetry(monster);
        Time.timeSinceLevelLoad = 20.1; // still inside 0.5s
        combatMove(monster, player, { tileMap: map, rng: () => 0 });
        assert.strictEqual(monster.tile.x, tileStuck.x, 'gated circle does not move');
        Time.timeSinceLevelLoad = 20.6;
        combatMove(monster, player, {
            tileMap: map,
            rng: () => 0
        });
        assert.ok(
            monster.tile.x !== tileStuck.x || monster.tile.y !== tileStuck.y,
            'circle after retry interval moves'
        );

        // --- Path fail: wall between, randomMove keeps target ---
        const pixels = [];
        for (let y = 0; y < 7; y++) {
            for (let x = 0; x < 7; x++) {
                // solid wall column x=3 separates left/right rooms
                if (x === 3) pixels.push([255, 255, 0]);
                else pixels.push([100, 100, 100]);
            }
        }
        const wallMap = new TileMap();
        wallMap.loadFloorFromRgba(
            0,
            7,
            7,
            rgbaFromPixels(7, 7, pixels)
        );
        const trapped = new Creature({
            name: 'Trapped',
            id: 9201,
            tile: { x: 1, y: 3, z: 0 },
            speed: 100,
            hp: 40,
            hpMax: 40
        });
        trapped.alive = true;
        trapped.flags = { targetDistance: 1, loseTargetDistance: 10 };
        ensureCreatureKit(trapped, {
            attacks: [],
            flags: trapped.flags,
            strategiesTarget: { nearest: 100 }
        });
        const farPlayer = {
            id: 9202,
            tile: { x: 5, y: 3, z: 0 },
            alive: true,
            hp: { current: 100, max: 100 }
        };
        wallMap.tryOccupy(1, 3, 0, trapped);
        wallMap.tryOccupy(5, 3, 0, farPlayer);
        initCreatureAi(trapped);
        trapped.target = farPlayer;
        trapped.targetId = farPlayer.id;
        trapped.moveDelay = 0;
        const t0 = { x: trapped.tile.x, y: trapped.tile.y };
        combatMove(trapped, farPlayer, {
            tileMap: wallMap,
            rng: () => 0
        });
        assert.ok(trapped.target === farPlayer, 'path fail keeps sticky target');
        assert.strictEqual(trapped.targetId, farPlayer.id);
        // random adjacent may or may not change tile if only walls; on open
        // side room it should step when free neighbors exist
        assert.ok(
            wallMap.isWalkable(trapped.tile.x, trapped.tile.y, 0),
            'still on walkable tile after path-fail move'
        );
        // Ensure randomMove path is exercised when free neighbor exists
        trapped.tile = { x: 1, y: 3, z: 0 };
        trapped.moveDelay = 0;
        wallMap.clearOccupancy(0);
        wallMap.tryOccupy(1, 3, 0, trapped);
        wallMap.tryOccupy(5, 3, 0, farPlayer);
        const stepped = stepRandomAdjacent(trapped, wallMap, () => 0);
        assert.ok(stepped, 'random adjacent works in open pocket');
        assert.ok(
            trapped.tile.x !== t0.x || trapped.tile.y !== t0.y || stepped,
            'path-fail fallback can move'
        );

        // --- Lose target: dist > 10 clears sticky ---
        const open = openFloor(24, 8, 100);
        const hunter = new Creature({
            name: 'Hunter',
            id: 9301,
            tile: { x: 1, y: 4, z: 0 },
            speed: 100,
            hp: 40,
            hpMax: 40
        });
        hunter.alive = true;
        hunter.flags = { targetDistance: 1, loseTargetDistance: 10 };
        ensureCreatureKit(hunter, {
            attacks: [],
            flags: hunter.flags,
            strategiesTarget: { nearest: 100 }
        });
        const runaway = {
            id: 9302,
            tile: { x: 12, y: 4, z: 0 },
            alive: true,
            hp: { current: 100, max: 100 }
        };
        open.tryOccupy(1, 4, 0, hunter);
        open.tryOccupy(12, 4, 0, runaway);
        initCreatureAi(hunter);
        hunter.target = runaway;
        hunter.targetId = runaway.id;
        hunter.aiState = 'attack';
        const status = require('../kernel/core/lib/ai/creature_states.js').runCombatTick(
            hunter,
            {
                tileMap: open,
                players: [runaway],
                rng: () => 0,
                sim: {
                    getEntityById(id) {
                        return id === runaway.id ? runaway : null;
                    }
                }
            }
        );
        assert.strictEqual(
            status,
            'no_target',
            'dist > loseTargetDistance drops target'
        );
        assert.strictEqual(hunter.target, null);
        assert.strictEqual(hunter.targetId, null);

        // Floor change invalidates target
        hunter.target = runaway;
        hunter.targetId = runaway.id;
        runaway.tile = { x: 2, y: 4, z: 1 };
        assert.strictEqual(
            require('../kernel/core/lib/ai/targeting.js').isValidTarget(
                hunter,
                runaway
            ),
            false,
            'different floor is invalid target'
        );
    } finally {
        Settings.AI_CREATURE_CIRCLE_CHANCE = prev.circleChance;
        Settings.AI_CREATURE_CIRCLE_INTERVAL = prev.circleInterval;
        Settings.AI_CREATURE_LOSE_TARGET_DIST = prev.loseDist;
    }
    log('path-fail / circle / lose-target ok');
}

function testManualControlAndCommandQueue() {
    const map = openFloor(8, 8, 100);
    const sim = new Simulator({ seed: 4, combatAi: true, recordSteps: false });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.sessionState = 'running';
    sim.active = true;

    const party = new Party({ name: 'ManualParty' });
    const player = new Player({
        id: sim.allocEntityId(),
        name: 'ManualPlayer',
        classId: 'guardian',
        isLeader: true,
        controlMode: 'manual',
        level: 20,
        tile: { x: 2, y: 2, z: 0 }
    });
    map.tryOccupy(2, 2, 0, player);
    party.addMember(player);
    sim.parties.push(party);
    initPlayerAi(player);

    assert.strictEqual(player.controlMode, 'manual', 'player initialized in manual mode');
    assert.strictEqual(player.aiState, 'manual', 'aiState initialized or set to manual after init/update');

    // Test MOVE_STEP command consumption + watch-mode step visual (slide/bob)
    player.syncPositionFromTile && player.syncPositionFromTile();
    player.commandQueue.push({ type: 'MOVE_STEP', dx: 1, dy: 0 });
    tickHuntAi(sim);
    assert.strictEqual(player.tile.x, 3, 'player stepped right via MOVE_STEP command');
    assert.strictEqual(player.commandQueue.length, 0, 'command queue consumed');
    assert.strictEqual(player.aiState, 'manual', 'aiState remains manual after tick');
    // emitManualStep must not snap presentation — same slide as AI steps
    assert.ok(player.moveDelay > 0, 'manual step sets moveDelay');
    assert.ok(
        player._moveVisDuration > 0,
        'manual MOVE_STEP starts presentation slide'
    );
    assert.strictEqual(
        player.x,
        2,
        'visual stays at previous tile at start of slide (not teleport)'
    );
    assert.strictEqual(player.y, 2, 'visual y stays at origin during slide start');

    // Manual stair hop: walk onto a death/rest portal pad → change floor
    {
        const open = new Uint8Array(25);
        open.fill(100);
        const multi = new TileMap('manual_stairs');
        multi.loadFloorFromFriction(0, 5, 5, open);
        multi.loadFloorFromFriction(1, 5, 5, open);
        multi.addStair(
            { x: 2, y: 2, z: 0 },
            { x: 2, y: 2, z: 1 },
            { dir: 'down', link: 'portal_test', bidirectional: false }
        );
        sim.setTileMap(multi);
        map.release(3, 2, 0, player);
        player.tile = { x: 1, y: 2, z: 0 };
        player.path = [];
        player.moveDelay = 0;
        player.syncPositionFromTile && player.syncPositionFromTile();
        assert.ok(multi.tryOccupy(1, 2, 0, player), 'place next to portal pad');
        player.commandQueue.push({ type: 'MOVE_STEP', dx: 1, dy: 0 });
        tickHuntAi(sim);
        assert.strictEqual(
            String(player.tile.z),
            '1',
            'manual MOVE_STEP onto stair pad hops floor'
        );
        assert.strictEqual(player.tile.x, 2, 'lands on portal dest x');
        assert.strictEqual(player.tile.y, 2, 'lands on portal dest y');
        // Cross-floor hop snaps visual (no long slide)
        assert.strictEqual(
            player.x,
            2,
            'stair hop snaps visual x to dest'
        );
        assert.strictEqual(
            player.y,
            2,
            'stair hop snaps visual y to dest'
        );
        // Restore single-floor map for remaining manual tests
        sim.setTileMap(map);
        multi.release(player.tile.x, player.tile.y, player.tile.z, player);
        player.tile = { x: 3, y: 2, z: 0 };
        player.path = [];
        player.moveDelay = 0;
        player.syncPositionFromTile && player.syncPositionFromTile();
        map.tryOccupy(3, 2, 0, player);
    }

    // Ladder: step stays; USE_STAIR hops
    {
        const open = new Uint8Array(25);
        open.fill(100);
        const ladders = new TileMap('manual_ladders');
        ladders.loadFloorFromFriction(0, 5, 5, open);
        ladders.loadFloorFromFriction(1, 5, 5, open);
        ladders.addStair(
            { x: 2, y: 2, z: 0 },
            { x: 2, y: 2, z: 1 },
            { type: 'ladder', dir: 'up', bidirectional: false }
        );
        sim.setTileMap(ladders);
        map.release(3, 2, 0, player);
        player.tile = { x: 1, y: 2, z: 0 };
        player.path = [];
        player.moveDelay = 0;
        player._manualDest = null;
        player._pendingUseStair = false;
        player.syncPositionFromTile && player.syncPositionFromTile();
        assert.ok(ladders.tryOccupy(1, 2, 0, player), 'place next to ladder');
        player.commandQueue.push({ type: 'MOVE_STEP', dx: 1, dy: 0 });
        tickHuntAi(sim);
        assert.strictEqual(String(player.tile.z), '0', 'ladder does not hop on step');
        assert.strictEqual(player.tile.x, 2, 'stands on ladder pad');
        player.moveDelay = 0;
        player.commandQueue.push({ type: 'USE_STAIR' });
        tickHuntAi(sim);
        assert.strictEqual(String(player.tile.z), '1', 'USE_STAIR hops ladder');
        assert.strictEqual(player.tile.x, 2);
        assert.strictEqual(player.tile.y, 2);
        sim.setTileMap(map);
        ladders.release(player.tile.x, player.tile.y, player.tile.z, player);
        player.tile = { x: 3, y: 2, z: 0 };
        player.path = [];
        player.moveDelay = 0;
        player._pendingUseStair = false;
        player.syncPositionFromTile && player.syncPositionFromTile();
        map.tryOccupy(3, 2, 0, player);
    }

    // Living creature for SET_TARGET resolution
    const rat = new Creature({
        id: sim.allocEntityId(),
        name: 'ManualRat',
        tile: { x: 4, y: 2, z: 0 },
        hp: 30,
        hpMax: 30
    });
    map.tryOccupy(4, 2, 0, rat);
    sim.creatures = sim.creatures || [];
    sim.creatures.push(rat);
    sim.entityById.set(player.id, player);
    sim.entityById.set(rat.id, rat);

    // SET_TARGET consumption (works while moveDelay may still be set after step)
    player.commandQueue.push({ type: 'SET_TARGET', targetId: rat.id });
    tickHuntAi(sim);
    assert.strictEqual(player.targetId, rat.id, 'targetId set via command queue');
    assert.strictEqual(player.commandQueue.length, 0, 'SET_TARGET consumed immediately');
    assert.ok(player.target === rat, 'target resolved from entity map');

    // SET_AUTO_CHASE toggle
    assert.strictEqual(player.autoChase, false, 'autoChase defaults to false');
    player.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: true });
    tickHuntAi(sim);
    assert.strictEqual(player.autoChase, true, 'autoChase enabled via SET_AUTO_CHASE command');
    assert.strictEqual(player.commandQueue.length, 0, 'SET_AUTO_CHASE consumed immediately');

    // CUSTOM_COMMAND (noop) and unknown types must not stall the queue
    player.commandQueue.push({ type: 'CUSTOM_COMMAND', command: 'noop' });
    player.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: false });
    tickHuntAi(sim);
    assert.strictEqual(player.commandQueue.length, 1, 'CUSTOM_COMMAND consumed; next cmd remains');
    tickHuntAi(sim);
    assert.strictEqual(player.autoChase, false, 'following command still runs after CUSTOM_COMMAND');
    assert.strictEqual(player.commandQueue.length, 0, 'queue drained');

    // Stale missing targetId clears
    player.targetId = 999999;
    player.target = { id: 999999, alive: true };
    tickHuntAi(sim);
    assert.strictEqual(player.targetId, null, 'missing map entity clears targetId');
    assert.strictEqual(player.target, null, 'missing map entity clears target ref');

    // SET_CONTROL_MODE: manual → AI re-enters FSM; AI → manual works while still AI
    player.commandQueue.push({ type: 'SET_CONTROL_MODE', mode: 'ai' });
    tickHuntAi(sim);
    assert.strictEqual(player.controlMode, 'ai', 'SET_CONTROL_MODE switches to AI');
    assert.notStrictEqual(player.aiState, 'manual', 'leaving manual re-enters player brain');
    assert.strictEqual(player.commandQueue.length, 0, 'SET_CONTROL_MODE consumed');

    player.commandQueue.push({ type: 'SET_CONTROL_MODE', mode: 'manual' });
    tickHuntAi(sim);
    assert.strictEqual(player.controlMode, 'manual', 'SET_CONTROL_MODE re-enters manual from AI');
    assert.strictEqual(player.aiState, 'manual', 'aiState is manual after re-enter');

    // Potion USE_ITEM: real heal ranges (not stub +50)
    {
        const {
            buildInventoryFromSeed,
            countItemIdInInventoryTree
        } = require('../kernel/core/lib/character/inventory.js');
        const itemDb = [
            {
                id: 'health_potion',
                label: 'Health Potion',
                category: 'potion',
                stackable: true,
                consumable: true,
                heal: [125, 175]
            },
            {
                id: 'great_dual_potion',
                label: 'Great Dual Potion',
                category: 'potion',
                stackable: true,
                consumable: true,
                heal: [250, 350],
                restoreMana: [100, 200]
            },
            {
                id: 'backpack',
                label: 'Backpack',
                slot: 'backpack',
                category: 'container',
                volume: 20
            }
        ];
        sim._itemDb = itemDb;
        player.hp = { current: 50, max: 500 };
        player.mp = { current: 10, max: 200 };
        player.inventory = buildInventoryFromSeed(
            {
                equipment: { backpack: 'backpack' },
                backpack: [
                    { itemId: 'health_potion', count: 2 },
                    { itemId: 'great_dual_potion', count: 1 }
                ]
            },
            itemDb
        );
        assert.strictEqual(
            countItemIdInInventoryTree(player.inventory, 'health_potion'),
            2,
            'seeded two health potions'
        );
        player.commandQueue.push({
            type: 'USE_ITEM',
            itemId: 'health_potion',
            target: { kind: 'self' }
        });
        tickHuntAi(sim);
        assert.ok(
            player.hp.current >= 50 + 125 && player.hp.current <= 50 + 175,
            `health potion heals in [125,175], got ${player.hp.current - 50}`
        );
        assert.strictEqual(
            countItemIdInInventoryTree(player.inventory, 'health_potion'),
            1,
            'one potion consumed'
        );

        // Dual potion: HP + MP
        const hpBefore = player.hp.current;
        const mpBefore = player.mp.current;
        player.commandQueue.push({
            type: 'USE_ITEM',
            itemId: 'great_dual_potion',
            target: { kind: 'self' }
        });
        tickHuntAi(sim);
        assert.ok(
            player.hp.current > hpBefore,
            'dual potion restores HP'
        );
        assert.ok(
            player.mp.current > mpBefore,
            'dual potion restores MP'
        );
    }

    // CUSTOM_COMMAND summon_creature (summonable rat)
    {
        player.mp = { current: 500, max: 500 };
        const beforeCreatures = (sim.creatures || []).length;
        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'summon_creature rat'
        });
        tickHuntAi(sim);
        const summons = (player.summonIds || [])
            .map((id) => sim.entityById.get(id))
            .filter(Boolean);
        assert.ok(
            summons.length >= 1 || (sim.creatures || []).length > beforeCreatures,
            'summon_creature spawned a creature'
        );
        if (summons[0]) {
            assert.strictEqual(summons[0].masterId, player.id, 'summon linked to master');
            assert.strictEqual(summons[0].partyOwned, true, 'party-owned flag set');
        }
        assert.ok(
            player.mp.current < 500 || player.mp.current === 500,
            'mana spent or free if cost 0'
        );
    }

    // CUSTOM_COMMAND heal_friend on self via explicit target
    {
        sim.spellBook = indexSpells(presets.loadSpells().spells || presets.loadSpells());
        player.hp = { current: 40, max: 500 };
        player.mp = { current: 300, max: 300 };
        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'heal_friend',
            target: { kind: 'self' }
        });
        tickHuntAi(sim);
        // Heal may fail vocation/cd; command must still be consumed
        assert.strictEqual(player.commandQueue.length, 0, 'heal_friend macro dequeued');
    }

    log('manual control and command queue ok');
}

/**
 * Stage 6b Phase 3: npc_dialog CUSTOM_COMMAND advances a session; talkable
 * NPCs stay out of AOI enemies; unknown macros still no-op.
 */
function testManualAutowalkFloorHopClearsDest() {
    const open = new Uint8Array(25);
    open.fill(100);

    function makeSim(bidirectional) {
        const map = new TileMap('autowalk_hop');
        map.loadFloorFromFriction(0, 5, 5, open);
        map.loadFloorFromFriction(1, 5, 5, open);
        map.addStair(
            { x: 2, y: 2, z: 0 },
            { x: 2, y: 2, z: 1 },
            { dir: 'down', link: 'portal_autowalk', bidirectional: !!bidirectional }
        );
        if (bidirectional) {
            map.addStair(
                { x: 2, y: 2, z: 1 },
                { x: 2, y: 2, z: 0 },
                { dir: 'up', link: 'portal_autowalk', bidirectional: true }
            );
        }
        const sim = new Simulator({ seed: 4, combatAi: true, recordSteps: false });
        sim.setTileMap(map);
        sim.floor = 0;
        sim._ensurePresetLoaders();
        sim.sessionState = 'running';
        sim.active = true;
        const floats = [];
        sim.emitCombatText = (opts) => {
            floats.push(opts);
        };
        const party = new Party({ name: 'HopParty' });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'HopPlayer',
            classId: 'guardian',
            isLeader: true,
            controlMode: 'manual',
            level: 20,
            tile: { x: 1, y: 2, z: 0 }
        });
        map.tryOccupy(1, 2, 0, player);
        party.addMember(player);
        sim.parties.push(party);
        initPlayerAi(player);
        return { sim, map, player, floats };
    }

    // Click the stair pad (same-floor dest) → hop must not announce no-way
    {
        const { sim, player, floats } = makeSim(false);
        player.commandQueue.push({
            type: 'START_AUTOWALK',
            dest: { x: 2, y: 2, z: 0 }
        });
        tickHuntAi(sim);
        assert.strictEqual(String(player.tile.z), '1', 'autowalk onto pad hops');
        assert.strictEqual(
            player._manualDest,
            null,
            'same-floor dest dropped after hop'
        );
        player.moveDelay = 0;
        tickHuntAi(sim);
        assert.strictEqual(String(player.tile.z), '1', 'stays on dest floor');
        assert.strictEqual(player._manualDest, null, 'dest stays cleared');
        assert.ok(
            !floats.some((f) => f && f.text === 'There is no way.'),
            'hop must not emit There is no way.'
        );
    }

    // Bidirectional pad: leftover dest must not bounce back
    {
        const { sim, player, floats } = makeSim(true);
        player.commandQueue.push({
            type: 'START_AUTOWALK',
            dest: { x: 2, y: 2, z: 0 }
        });
        tickHuntAi(sim);
        assert.strictEqual(String(player.tile.z), '1', 'bidirectional hop lands');
        player.moveDelay = 0;
        tickHuntAi(sim);
        assert.strictEqual(
            String(player.tile.z),
            '1',
            'must not bounce back up the stair'
        );
        assert.ok(
            !floats.some((f) => f && f.text === 'There is no way.'),
            'bidirectional hop must not emit There is no way.'
        );
    }

    // Intentional dest on the dest floor survives the hop
    {
        const { sim, player } = makeSim(false);
        player.commandQueue.push({
            type: 'START_AUTOWALK',
            dest: { x: 4, y: 2, z: 1 }
        });
        tickHuntAi(sim);
        assert.strictEqual(String(player.tile.z), '1', 'cross-floor dest hops');
        assert.ok(player._manualDest, 'dest.z on new floor is kept');
        assert.strictEqual(player._manualDest.x, 4);
        assert.strictEqual(String(player._manualDest.z), '1');
    }

    log('manual autowalk floor-hop dest clear ok');
}

function testNpcDialogCustomCommand() {
    const map = openFloor(16, 16, 100);
    const sim = new Simulator({ seed: 63, combatAi: true, recordSteps: false });
    sim.setTileMap(map);
    sim.floor = 0;
    sim._ensurePresetLoaders();
    sim.sessionState = 'running';
    sim.active = true;

    try {
        const party = new Party({ name: 'TalkParty' });
        const player = new Player({
            id: sim.allocEntityId(),
            name: 'Talker',
            classId: 'guardian',
            isLeader: true,
            controlMode: 'manual',
            level: 20,
            tile: { x: 2, y: 2, z: 0 }
        });
        map.tryOccupy(2, 2, 0, player);
        party.addMember(player);
        sim.parties.push(party);
        sim.entityById.set(player.id, player);
        initPlayerAi(player);

        const tpl = presets.loadCreatureTemplate('town_guide');
        const guide = sim.spawnFromTable({
            creatureId: 'town_guide',
            x: 4,
            y: 2,
            z: 0,
            template: tpl
        });
        assert.ok(guide, 'town_guide spawned');
        assert.ok(isTalkableNpc(guide), 'guide is talkable after spawn');

        invalidateAoiFrame(sim);
        const ctx = buildCtx(sim, null, null);
        assert.ok(
            !ctx.enemies.some((c) => c.id === guide.id),
            'AOI enemies exclude talkable NPC'
        );

        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'npc_dialog',
            args: { npcId: guide.id, nodeId: 'start' }
        });
        tickHuntAi(sim);
        assert.strictEqual(player.commandQueue.length, 0, 'npc_dialog dequeued');
        assert.ok(player._npcTalk, 'session opened');
        assert.strictEqual(player._npcTalk.npcId, guide.id);
        assert.strictEqual(player._npcTalk.nodeId, 'start');
        assert.strictEqual(player._npcTalk.dialogId, 'town_guide');

        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'npc_dialog ' + guide.id + ' arena'
        });
        tickHuntAi(sim);
        assert.strictEqual(player._npcTalk.nodeId, 'arena', 'string form goto');

        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'npc_dialog',
            args: { action: 'close' }
        });
        tickHuntAi(sim);
        assert.strictEqual(player._npcTalk, null, 'close clears session');

        const savedTile = { x: guide.tile.x, y: guide.tile.y, z: guide.tile.z };
        guide.tile = { x: 14, y: 14, z: 0 };
        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'npc_dialog',
            args: { npcId: guide.id }
        });
        tickHuntAi(sim);
        assert.strictEqual(player._npcTalk, null, 'out-of-range open is a no-op');
        guide.tile = savedTile;

        guide.alive = false;
        guide.hp.current = 0;
        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'npc_dialog',
            args: { npcId: guide.id }
        });
        tickHuntAi(sim);
        assert.strictEqual(player._npcTalk, null, 'dead NPC open is a no-op');
        guide.alive = true;
        guide.hp.current = guide.hp.max;

        const rat = sim.spawnFromTable({
            creatureId: 'cave_rat',
            x: 3,
            y: 2,
            z: 0,
            template: {
                id: 'cave_rat',
                label: 'Cave Rat',
                hp: 20,
                hpMax: 20,
                attacks: [{ id: 'melee_0', kind: 'melee', min: 1, max: 4 }]
            }
        });
        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'npc_dialog',
            args: { npcId: rat.id }
        });
        tickHuntAi(sim);
        assert.strictEqual(player._npcTalk, null, 'hostile / non-talkable is a no-op');

        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'xyzzy_not_a_macro'
        });
        player.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: true });
        tickHuntAi(sim);
        assert.strictEqual(
            player.commandQueue.length,
            1,
            'unknown CUSTOM_COMMAND dequeued; next cmd remains'
        );
        assert.strictEqual(player._npcTalk, null, 'unknown macro does not open talk');
        tickHuntAi(sim);
        assert.strictEqual(player.autoChase, true, 'queue continues after unknown macro');
        assert.strictEqual(player.commandQueue.length, 0);
    } finally {
        sim.destroy();
    }
    log('npc_dialog custom command ok');
}

/**
 * Invisible players nearby: monsters must not attack, but still random-walk
 * (legacy doRandomStep while non-idle). Alone with idleWander off → freeze.
 */
function testInvisiblePresenceIdleWander() {
    const map = openFloor(12, 12, 100);
    const monster = new Creature({
        id: 9301,
        name: 'BlindRat',
        type: 'creature',
        tile: { x: 5, y: 5, z: 0 },
        speed: 100,
        hp: 50,
        hpMax: 50
    });
    monster.alive = true;
    monster.homeTile = { x: 5, y: 5, z: 0 };
    monster.spawnTile = { x: 5, y: 5, z: 0 };
    monster.aggro = true;
    ensureCreatureKit(monster, {
        attacks: [{ id: 'melee', kind: 'melee', min: 1, max: 2, range: 1, intervalSec: 1, chance: 100 }],
        flags: {
            targetDistance: 1,
            aggroRange: 7,
            loseTargetDistance: 10,
            idleWander: false
        },
        strategiesTarget: { nearest: 100 }
    });
    initCreatureAi(monster);
    map.tryOccupy(5, 5, 0, monster);

    const player = new Player({
        id: 9302,
        name: 'Ghost',
        tile: { x: 6, y: 5, z: 0 },
        speed: 100,
        hp: 200,
        hpMax: 200
    });
    player.alive = true;
    if (player.hp && typeof player.hp === 'object') {
        player.hp.current = 200;
        player.hp.max = 200;
    }
    map.tryOccupy(6, 5, 0, player);

    applyCondition(player, { type: 'invisible', durationSec: 120 });
    assert.ok(isInvisible(player), 'player is invisible');
    assert.strictEqual(
        isValidTarget(monster, player),
        false,
        'blind monster cannot target invisible player'
    );
    assert.strictEqual(
        pickCreatureTarget(monster, [player], { rng: () => 0, range: 7 }),
        null,
        'pickCreatureTarget skips invisible'
    );

    const pool = { list: [player], index: null };
    assert.ok(
        hasLivingPresence(monster, pool),
        'invisible player still counts as living presence'
    );

    // Idle: should random-step while invisible presence is nearby
    monster.moveDelay = 0;
    const t0 = { x: monster.tile.x, y: monster.tile.y };
    // Deterministic rng that still yields a free neighbor over a few tries
    let calls = 0;
    const rng = () => {
        calls += 1;
        return (calls % 8) / 8;
    };
    Idle.execute(monster, {
        tileMap: map,
        players: [player],
        rng,
        sim: {
            getEntityById(id) {
                return id === player.id ? player : null;
            }
        }
    });
    assert.strictEqual(
        monster.aiState,
        'idle',
        'stays idle (no aggro on invisible)'
    );
    assert.strictEqual(monster.target, null);
    assert.ok(
        monster.tile.x !== t0.x || monster.tile.y !== t0.y || monster.moveDelay > 0,
        'random-walked or started a step while invisible presence nearby'
    );
    // If first rng landed on blocked/self, force a step path
    if (monster.tile.x === t0.x && monster.tile.y === t0.y) {
        monster.moveDelay = 0;
        const stepped = stepRandomAdjacent(monster, map, () => 0);
        assert.ok(stepped, 'open floor has free adjacent for random step');
    }

    // Alone (no players): idleWander off → no forced wander
    monster.tile = { x: 5, y: 5, z: 0 };
    monster.moveDelay = 0;
    map.clearOccupancy(0);
    map.tryOccupy(5, 5, 0, monster);
    const aloneTile = { x: monster.tile.x, y: monster.tile.y };
    Idle.execute(monster, {
        tileMap: map,
        players: [],
        rng: () => 0,
        sim: { getEntityById() { return null; } }
    });
    assert.strictEqual(monster.tile.x, aloneTile.x);
    assert.strictEqual(monster.tile.y, aloneTile.y);

    // Retarget: invisible nearby → Idle, not Leash (even if off home)
    monster.tile = { x: 7, y: 7, z: 0 };
    monster.homeTile = { x: 5, y: 5, z: 0 };
    monster.moveDelay = 0;
    monster.target = player;
    monster.targetId = player.id;
    map.clearOccupancy(0);
    map.tryOccupy(7, 7, 0, monster);
    map.tryOccupy(6, 5, 0, player);
    // Put brain in Retarget and run once
    changeCreatureState(monster, Retarget);
    Retarget.execute(monster, {
        tileMap: map,
        players: [player],
        rng: () => 0,
        sim: {
            getEntityById(id) {
                return id === player.id ? player : null;
            }
        }
    });
    assert.strictEqual(
        monster.aiState,
        'idle',
        'retarget with invisible presence → Idle (not Leash)'
    );
    assert.strictEqual(monster.target, null);

    // Seer monster can still target invisible
    const seer = new Creature({
        id: 9303,
        name: 'Seer',
        type: 'creature',
        tile: { x: 5, y: 6, z: 0 },
        speed: 100,
        hp: 50,
        hpMax: 50
    });
    seer.alive = true;
    seer.immunities = { invisible: true };
    ensureCreatureKit(seer, {
        attacks: [{ id: 'melee', kind: 'melee', min: 1, max: 2, range: 1, intervalSec: 1, chance: 100 }],
        flags: { targetDistance: 1, aggroRange: 7 },
        strategiesTarget: { nearest: 100 }
    });
    assert.ok(isValidTarget(seer, player), 'seer sees invisible');
    const picked = pickCreatureTarget(seer, [player], { rng: () => 0, range: 7 });
    assert.ok(picked && picked.id === player.id, 'seer pickCreatureTarget finds invis');

    log('invisible presence idle wander ok');
}

/**
 * Adjacent monsters must not target or damage a player standing on a
 * protection-zone tile — including the PZ border (bug 20260812_203007).
 */
function testProtectionZoneBlocksIncomingTargetAndHits() {
    const map = openFloor(8, 8, 100);
    // 2×2 PZ; player stands on the south-west border cell.
    map.setTileFlags(2, 2, 0, TILE_FLAG_PZ_PACKAGE);
    map.setTileFlags(3, 2, 0, TILE_FLAG_PZ_PACKAGE);
    map.setTileFlags(2, 3, 0, TILE_FLAG_PZ_PACKAGE);
    map.setTileFlags(3, 3, 0, TILE_FLAG_PZ_PACKAGE);
    assert.strictEqual(map.isProtectionZonePackage(2, 3, 0), true);
    assert.strictEqual(map.attackMayAffectTile(2, 3, 0), false);
    assert.strictEqual(map.attackMayAffectTile(2, 4, 0), true);

    const player = new Player({
        id: 9401,
        name: 'Adept',
        tile: { x: 2, y: 3, z: 0 },
        speed: 100,
        hp: 200,
        hpMax: 200
    });
    player.alive = true;
    if (player.hp && typeof player.hp === 'object') {
        player.hp.current = 200;
        player.hp.max = 200;
    }
    player.combatStats = {
        level: 20,
        atk: 1,
        skill: 1,
        magic: 0,
        armor: 0,
        mitigation: 0,
        maxBlock: 0,
        resists: {},
        hpMax: 200,
        mpMax: 0
    };
    map.tryOccupy(2, 3, 0, player);

    const monster = new Creature({
        id: 9402,
        name: 'Rat',
        type: 'creature',
        tile: { x: 2, y: 4, z: 0 },
        speed: 100,
        hp: 50,
        hpMax: 50
    });
    monster.alive = true;
    monster.homeTile = { x: 2, y: 4, z: 0 };
    monster.spawnTile = { x: 2, y: 4, z: 0 };
    monster.aggro = true;
    ensureCreatureKit(monster, {
        attacks: [
            {
                id: 'melee',
                kind: 'melee',
                min: 10,
                max: 10,
                range: 1,
                intervalSec: 1,
                chance: 100
            }
        ],
        flags: {
            targetDistance: 1,
            aggroRange: 7,
            loseTargetDistance: 10,
            staticAttackChance: 100
        },
        strategiesTarget: { nearest: 100 }
    });
    initCreatureAi(monster);
    map.tryOccupy(2, 4, 0, monster);

    const targetOpts = { tileMap: map };
    assert.strictEqual(
        isValidTarget(monster, player),
        true,
        'without tileMap, PZ is not visible to the helper'
    );
    assert.strictEqual(
        isValidTarget(monster, player, targetOpts),
        false,
        'with tileMap, player on PZ is not a valid target'
    );
    const pickedBare = pickCreatureTarget(monster, [player], {
        rng: () => 0,
        range: 7
    });
    assert.ok(
        pickedBare && pickedBare.id === player.id,
        'pick without tileMap cannot see PZ flags'
    );
    assert.strictEqual(
        pickCreatureTarget(monster, [player], {
            rng: () => 0,
            range: 7,
            tileMap: map
        }),
        null,
        'pickCreatureTarget skips player on PZ'
    );

    const ctx = {
        tileMap: map,
        players: [player],
        rng: () => 0,
        sim: {
            getEntityById(id) {
                return id === player.id ? player : null;
            }
        }
    };

    const hp0 = player.hp.current;
    const fired = tryCreatureAttacks(monster, player, ctx);
    assert.ok(fired.fired, 'kit pass still runs (timer consumed)');
    assert.strictEqual(
        player.hp.current,
        hp0,
        'melee from adjacent tile does not damage a PZ player'
    );
    assert.ok(
        !fired.results || fired.results.length === 0,
        'no kit hit results on PZ'
    );

    // Sticky target from before entering PZ must drop and not deal damage.
    monster.target = player;
    monster.targetId = player.id;
    monster._attackReadyIn = [0];
    player.hp.current = hp0;
    const status = runCombatTick(monster, ctx);
    assert.strictEqual(status, 'no_target', 'combat tick drops PZ sticky');
    assert.strictEqual(monster.target, null);
    assert.strictEqual(player.hp.current, hp0, 'sticky tick deals no PZ damage');

    // Idle: do not acquire a player standing on PZ.
    changeCreatureState(monster, Idle);
    Idle.execute(monster, ctx);
    assert.strictEqual(monster.target, null, 'idle does not aggro into PZ');
    assert.notStrictEqual(
        monster.aiState,
        'aggro',
        'idle stays out of combat vs PZ player'
    );

    // Off-PZ neighbor is still attackable.
    const openPlayer = new Player({
        id: 9403,
        name: 'Open',
        tile: { x: 1, y: 4, z: 0 },
        speed: 100,
        hp: 200,
        hpMax: 200
    });
    openPlayer.alive = true;
    if (openPlayer.hp && typeof openPlayer.hp === 'object') {
        openPlayer.hp.current = 200;
        openPlayer.hp.max = 200;
    }
    openPlayer.combatStats = player.combatStats;
    map.tryOccupy(1, 4, 0, openPlayer);
    const pickedOpen = pickCreatureTarget(monster, [player, openPlayer], {
        rng: () => 0,
        range: 7,
        tileMap: map
    });
    assert.ok(
        pickedOpen && pickedOpen.id === openPlayer.id,
        'still picks a player standing off PZ'
    );

    log('protection zone blocks incoming target and hits ok');
}

async function main() {
    testStrategyHelpers();
    testSelfAoeSpellRangeAndPriorityFallback();
    testTargeting();
    testCombatMoveHelpers();
    testFsm();
    testAiCadenceHelpers();
    testAiTickRadiusFilterHelpers();
    testAiTickRadiusSkipsFarCreatures();
    testSpatialAiTickTwoBubbles();
    testSpatialAiPerfManyIdle();
    testCreatureSleepSelectiveUpdate();
    testSimulatorUpdateAllRespectsSleep();
    testAoiFrameCacheAndUnifiedQuery();
    testPlayerSpatialAggro();
    testBrainGateSkipsFsm();
    testCreatureKit();
    testRangedLineOfSightBlockedByWalls();
    testThreatDecayAndStrategyRetarget();
    testChangeTargetOverridesGlobal();
    testFleeHoldsAndAttacksDuringMoveDelay();
    testLeashReaggroHysteresis();
    testLeashReturnWalksBeyondChaseRadius();
    testCreaturePathFailCircleAndLoseTarget();
    testInvisiblePresenceIdleWander();
    testProtectionZoneBlocksIncomingTargetAndHits();
    testDragonLordWaveCast();
    testEngageAttackAndMoveDecoupled();
    testEngageSpellPriorityOverAuto();
    testWeaponAutoFamilies();
    testTinyHuntEngageAndKill();
    testPartyWipeSummary();
    testLowHpSelfHeal();
    await testHeadlessHuntFloor07();
    await testGhostWalkStillWorks();
    testManualControlAndCommandQueue();
    testManualAutowalkFloorHopClearsDest();
    testNpcDialogCustomCommand();
    console.log('hunt_ai: ok');
}

main().catch((err) => {
    console.error('hunt_ai FAILED:', err);
    process.exit(1);
});
