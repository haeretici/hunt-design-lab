#!/usr/bin/env node
/**
 * Verification of elemental fields (firefield, poisonfield, energyfield)
 * according to contract in docs/26_elemental_fields_design.md.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Time } = require('../kernel/core/lib/time.js');
const {
    FIELD_SOURCES,
    FIELD_MASKS,
    ACTIVE_FIELD_MAX_DURATION_SEC,
    getFieldState,
    deployFieldToTile,
    getFieldOnTile,
    applyFieldEntryEffects,
    checkAndCleanExpiredTileFields,
    onEntityTileTransition,
    isEntityImmuneToField,
    isFieldInActiveRegistry,
    purgeExpiredFields,
    getFieldKind,
    computeEntityAvoidFieldMask,
    removeFieldFromTile,
    isTileFieldHazardForEntity,
    isObstacleFieldKind,
    isObstacleField
} = require('../kernel/core/lib/combat/elemental_fields.js');
const { TileMap, FRICTION_BLOCKED } = require('../kernel/core/entities/tilemap.js');
const { findPath } = require('../kernel/core/lib/pathfinder.js');
const {
    createGroundStore,
    dropItemToGround,
    pickupItemFromGround,
    getStack
} = require('../kernel/core/lib/character/ground_items.js');
const {
    createEmptyInventory,
    createItemInstance
} = require('../kernel/core/lib/character/inventory.js');
const { applyCondition, tickConditions } = require('../kernel/core/lib/combat/conditions.js');
const { Player } = require('../kernel/core/entities/player.js');
const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
const {
    attackToSpell,
    tryCreatureAttacks
} = require('../kernel/core/lib/ai/creature_kit.js');
const { tryAttack } = require('../kernel/core/lib/ai/combat_actions.js');
const {
    buildInventoryFromSeed,
    countItemIdInInventoryTree
} = require('../kernel/core/lib/character/inventory.js');
const { findSpawnTile } = require('../kernel/providers/simulator/simulator.js');

const VERBOSE = !!process.env.VERBOSE;
function log(...args) {
    if (VERBOSE) console.log(...args);
}

function mockEntity(name, hp = 100, isPlayer = false) {
    return {
        name,
        type: isPlayer ? 'player' : 'creature',
        alive: true,
        hp: { current: hp, max: hp },
        resists: {},
        mitigation: 0,
        conditions: [],
        applyHpDelta(delta, element) {
            this.hp.current = Math.max(0, this.hp.current - delta);
            if (this.hp.current <= 0) this.alive = false;
            return delta;
        }
    };
}

function testFieldKindAndDurations() {
    log('Running testFieldKindAndDurations...');
    assert.strictEqual(getFieldKind('firefield_4'), 'fire');
    assert.strictEqual(getFieldKind('poisonfield_2'), 'poison');
    assert.strictEqual(getFieldKind('energyfield_1'), 'energy');
    assert.strictEqual(getFieldKind('fire'), 'fire');

    const fireField = { fieldKind: 'fire', createdAt: 0, isField: true };
    assert.strictEqual(getFieldState(fireField, 0).stage, 1, 'Fire stage 1 at t=0');
    assert.strictEqual(getFieldState(fireField, 199).stage, 1, 'Fire stage 1 at t=199s');
    assert.strictEqual(getFieldState(fireField, 200).stage, 2, 'Fire stage 2 at t=200s');
    assert.strictEqual(getFieldState(fireField, 347).stage, 2, 'Fire stage 2 at t=347s');
    assert.strictEqual(getFieldState(fireField, 348).stage, 3, 'Fire stage 3 at t=348s');
    assert.strictEqual(getFieldState(fireField, 348).active, false, 'Fire stage 3 inactive');
    assert.strictEqual(getFieldState(fireField, 445).stage, 3, 'Fire stage 3 at t=445s');
    assert.strictEqual(getFieldState(fireField, 446).expired, true, 'Fire expired at t=446s');

    const poisonField = { fieldKind: 'poison', createdAt: 0, isField: true };
    assert.strictEqual(getFieldState(poisonField, 0).active, true);
    assert.strictEqual(getFieldState(poisonField, 247).expired, false);
    assert.strictEqual(getFieldState(poisonField, 248).expired, true);

    const energyField = { fieldKind: 'energy', createdAt: 0, isField: true };
    assert.strictEqual(getFieldState(energyField, 0).active, true);
    assert.strictEqual(getFieldState(energyField, 97).expired, false);
    assert.strictEqual(getFieldState(energyField, 98).expired, true);
    log('testFieldKindAndDurations: ok');
}

function testFieldSingleTileReplacement() {
    log('Running testFieldSingleTileReplacement...');
    const ground = createGroundStore();
    deployFieldToTile(ground, 10, 10, 7, { kind: 'fire', createdAt: 10 });
    assert.strictEqual(getFieldOnTile(ground, 10, 10, 7).fieldKind, 'fire');
    assert.strictEqual(getFieldOnTile(ground, 10, 10, 7).createdAt, 10);
    assert.strictEqual(getFieldOnTile(ground, 10, 10, 7).itemId, 'fire_field');

    deployFieldToTile(ground, 10, 10, 7, { kind: 'energy', createdAt: 50 });
    assert.strictEqual(getFieldOnTile(ground, 10, 10, 7).fieldKind, 'energy', 'Replaced by energy');
    assert.strictEqual(getFieldOnTile(ground, 10, 10, 7).createdAt, 50, 'Timer reset to t=50');
    assert.strictEqual(getStack(ground, 10, 10, 7).length, 1, 'No accumulation of field items');
    log('testFieldSingleTileReplacement: ok');
}

function testStackOrderFieldOnTop() {
    log('Running testStackOrderFieldOnTop...');
    const ground = createGroundStore();
    // 1) field, 2) drop item on top, 3) new field on top of item, 4) another item on top
    const f1 = deployFieldToTile(ground, 5, 5, 7, { kind: 'fire', createdAt: 0 });
    assert.ok(f1 && f1.uid);
    let stack = getStack(ground, 5, 5, 7);
    assert.strictEqual(stack[stack.length - 1], f1.uid, 'Initial field is top');

    const playerInv = createEmptyInventory({ rootSlots: 10 });
    const player = new Player({ name: 'Hero', tile: { x: 5, y: 5, z: 7 } });
    const coinUid = createItemInstance(playerInv, 'gold_coin', null, { count: 10 });
    const drop1 = dropItemToGround({
        playerInv,
        ground,
        uid: coinUid,
        player,
        tileMap: {
            isWalkable: () => true,
            getTerrain: () => null,
            isStair: () => false
        },
        x: 5,
        y: 5,
        z: 7
    });
    assert.strictEqual(drop1.ok, true, 'Coin drop ok');
    stack = getStack(ground, 5, 5, 7);
    assert.strictEqual(stack.length, 2);
    assert.strictEqual(stack[stack.length - 1], drop1.groundUid, 'Coin on top of field');
    assert.strictEqual(getFieldOnTile(ground, 5, 5, 7).fieldKind, 'fire');

    const f2 = deployFieldToTile(ground, 5, 5, 7, { kind: 'poison', createdAt: 20 });
    stack = getStack(ground, 5, 5, 7);
    assert.strictEqual(stack.length, 2, 'Old field removed; coin remains under new field');
    assert.strictEqual(stack[stack.length - 1], f2.uid, 'New field is top of stack');
    assert.strictEqual(stack[0], drop1.groundUid, 'Coin still under field');
    assert.strictEqual(getFieldOnTile(ground, 5, 5, 7).fieldKind, 'poison');

    const coin2 = createItemInstance(playerInv, 'gold_coin', null, { count: 1 });
    const drop2 = dropItemToGround({
        playerInv,
        ground,
        uid: coin2,
        player,
        tileMap: {
            isWalkable: () => true,
            getTerrain: () => null,
            isStair: () => false
        },
        x: 5,
        y: 5,
        z: 7
    });
    assert.strictEqual(drop2.ok, true);
    stack = getStack(ground, 5, 5, 7);
    assert.strictEqual(stack[stack.length - 1], drop2.groundUid, 'Newest item on top of field');
    log('testStackOrderFieldOnTop: ok');
}

function testGroundStoreIntegrationAndImmobility() {
    log('Running testGroundStoreIntegrationAndImmobility...');
    const ground = createGroundStore();
    deployFieldToTile(ground, 5, 5, 7, { kind: 'fire', createdAt: 0 });
    const stackBefore = getStack(ground, 5, 5, 7);
    const fieldUid = stackBefore[0];

    const playerInv = createEmptyInventory({ rootSlots: 10 });
    const player = new Player({ name: 'Hero', tile: { x: 5, y: 5, z: 7 } });

    const pickupRes = pickupItemFromGround({
        ground,
        playerInv,
        uid: fieldUid,
        player
    });
    assert.strictEqual(pickupRes.ok, false, 'Pickup must fail for elemental fields');
    assert.strictEqual(pickupRes.error, 'immovable_item', 'Error reason is immovable_item');
    assert.strictEqual(getFieldOnTile(ground, 5, 5, 7).fieldKind, 'fire', 'Field remains');
    log('testGroundStoreIntegrationAndImmobility: ok');
}

function testFriendlyFireAndSourceRules() {
    log('Running testFriendlyFireAndSourceRules...');
    const player = mockEntity('Paladin', 100, true);
    const monster = mockEntity('Dragon', 100, false);

    assert.strictEqual(isEntityImmuneToField(player, FIELD_SOURCES.PLAYER), true);
    assert.strictEqual(isEntityImmuneToField(monster, FIELD_SOURCES.PLAYER), false);
    assert.strictEqual(isEntityImmuneToField(player, FIELD_SOURCES.CREATURE), false);
    assert.strictEqual(isEntityImmuneToField(player, FIELD_SOURCES.SCENARIO), false);

    const ground = createGroundStore();
    const pField = deployFieldToTile(ground, 0, 0, 0, {
        kind: 'energy',
        source: FIELD_SOURCES.PLAYER
    });
    const pRes = applyFieldEntryEffects(player, pField, 0);
    assert.strictEqual(pRes.applied, false);
    assert.strictEqual(player.hp.current, 100);

    const mRes = applyFieldEntryEffects(monster, pField, 0);
    assert.strictEqual(mRes.applied, true);
    assert.strictEqual(monster.hp.current, 70, 'Monster took 30 energy');
    log('testFriendlyFireAndSourceRules: ok');
}

function testFieldEntryAndDoTSchedules() {
    log('Running testFieldEntryAndDoTSchedules...');
    const target = mockEntity('Orc', 200, false);
    const ground = createGroundStore();
    const fire = deployFieldToTile(ground, 1, 1, 7, { kind: 'fire', source: 'scenario' });

    applyFieldEntryEffects(target, fire, 0);
    assert.strictEqual(target.hp.current, 180, 'Took 20 immediate fire damage');
    assert.strictEqual(target.conditions.length, 1);
    const burn = target.conditions[0];
    assert.strictEqual(burn.kind, 'fire');
    assert.strictEqual(burn.tickIntervalSec, 9);

    const tickRes = tickConditions(target, 9);
    assert.strictEqual(tickRes.ticks.length, 1);
    assert.strictEqual(tickRes.ticks[0].damage, 10);
    assert.strictEqual(target.hp.current, 170);

    target.conditions[0].remainingDamage = 150;
    applyFieldEntryEffects(target, fire, 0);
    assert.strictEqual(target.conditions[0].remainingDamage, 70, 'Force override');

    const pTarget = mockEntity('Troll', 200, false);
    const poison = deployFieldToTile(ground, 2, 2, 7, { kind: 'poison', source: 'scenario' });
    applyFieldEntryEffects(pTarget, poison, 0);
    assert.strictEqual(pTarget.hp.current, 195, 'Took 5 immediate earth');
    assert.strictEqual(pTarget.conditions[0].remainingDamage, 100);

    for (let i = 0; i < 4; i++) tickConditions(pTarget, 2);
    assert.strictEqual(pTarget.hp.current, 195 - 20);
    const t5 = tickConditions(pTarget, 2);
    assert.strictEqual(t5.ticks[0].damage, 4, 'Stage 2 = 4 dmg');
    assert.strictEqual(pTarget.hp.current, 175 - 4);
    log('testFieldEntryAndDoTSchedules: ok');
}

function testEnergyFieldEntryAndExit() {
    log('Running testEnergyFieldEntryAndExit...');
    const ground = createGroundStore();
    deployFieldToTile(ground, 10, 10, 7, { kind: 'energy', source: 'scenario' });
    deployFieldToTile(ground, 10, 11, 7, { kind: 'energy', source: 'scenario' });
    const knight = mockEntity('Knight', 200, false);

    onEntityTileTransition(knight, { x: 10, y: 9, z: 7 }, { x: 10, y: 10, z: 7 }, ground, 0);
    assert.strictEqual(knight.hp.current, 170, '30 entry A');

    onEntityTileTransition(knight, { x: 10, y: 10, z: 7 }, { x: 10, y: 11, z: 7 }, ground, 2);
    assert.strictEqual(knight.hp.current, 140, '30 entry B, no exit');

    onEntityTileTransition(knight, { x: 10, y: 11, z: 7 }, { x: 10, y: 12, z: 7 }, ground, 4);
    assert.strictEqual(knight.hp.current, 115, '25 exit');

    deployFieldToTile(ground, 20, 20, 7, { kind: 'energy', source: 'scenario' });
    onEntityTileTransition(knight, { x: 19, y: 20, z: 7 }, { x: 20, y: 20, z: 7 }, ground, 10);
    assert.strictEqual(knight.hp.current, 85);
    onEntityTileTransition(knight, { x: 20, y: 20, z: 7 }, { x: 20, y: 20, z: 6 }, ground, 12);
    assert.strictEqual(knight.hp.current, 60, 'floor change exit 25');

    deployFieldToTile(ground, 30, 30, 7, {
        kind: 'energy',
        source: 'scenario',
        createdAt: 0
    });
    onEntityTileTransition(knight, null, { x: 30, y: 30, z: 7 }, ground, 0);
    assert.strictEqual(knight.hp.current, 30);
    const expired = checkAndCleanExpiredTileFields(ground, 30, 30, 7, 98, [knight]);
    assert.strictEqual(expired, true);
    assert.strictEqual(knight.hp.current, 5, '25 underfoot exit');
    assert.strictEqual(getFieldOnTile(ground, 30, 30, 7), null);
    log('testEnergyFieldEntryAndExit: ok');
}

function testElementalResistanceFloorToZero() {
    log('Running testElementalResistanceFloorToZero...');
    const dwarf = mockEntity('Dwarf', 100, false);
    dwarf.resists.earth = 20;

    applyCondition(dwarf, {
        type: 'poison',
        schedule: [{ turns: 2, damage: 1, intervalSec: 2 }],
        totalDamage: 2
    });

    const res = tickConditions(dwarf, 2);
    assert.strictEqual(res.ticks.length, 1);
    assert.strictEqual(res.ticks[0].rawDamage, 1);
    assert.strictEqual(res.ticks[0].damage, 0, '1 * 0.8 floored to 0');
    assert.strictEqual(dwarf.hp.current, 100);
    log('testElementalResistanceFloorToZero: ok');
}

function testMitigationPercentOnDoT() {
    log('Running testMitigationPercentOnDoT...');
    const tank = mockEntity('Tank', 100, false);
    tank.mitigation = 50; // 50% flat mitigation
    applyCondition(tank, {
        type: 'fire',
        schedule: [{ turns: 1, damage: 10, intervalSec: 9 }],
        totalDamage: 10
    });
    const res = tickConditions(tank, 9);
    assert.strictEqual(res.ticks[0].rawDamage, 10);
    assert.strictEqual(res.ticks[0].damage, 5, '50% mit floors to 5');
    assert.strictEqual(tank.hp.current, 95);
    log('testMitigationPercentOnDoT: ok');
}

function testActiveRegistryAndLongLivedScenario() {
    log('Running testActiveRegistryAndLongLivedScenario...');
    const ground = createGroundStore();
    deployFieldToTile(ground, 1, 1, 0, { kind: 'fire', createdAt: 0 });
    assert.strictEqual(
        isFieldInActiveRegistry(ground, 1, 1, 0),
        true,
        'Default fire (446s) is registered'
    );

    const long = deployFieldToTile(ground, 2, 2, 0, {
        kind: 'fire',
        source: 'scenario',
        createdAt: 0,
        durationSec: ACTIVE_FIELD_MAX_DURATION_SEC + 60
    });
    assert.ok(long);
    assert.strictEqual(
        isFieldInActiveRegistry(ground, 2, 2, 0),
        false,
        'Scenario field >24h skips active registry'
    );
    assert.strictEqual(getFieldOnTile(ground, 2, 2, 0).fieldKind, 'fire');
    assert.strictEqual(getFieldState(long, 1000).active, true, 'Long field still active');

    // Short energy expires via purge heap
    deployFieldToTile(ground, 3, 3, 0, { kind: 'energy', createdAt: 0 });
    assert.strictEqual(isFieldInActiveRegistry(ground, 3, 3, 0), true);
    const n = purgeExpiredFields(ground, 98, () => []);
    assert.ok(n >= 1, 'purge removed expired energy');
    assert.strictEqual(getFieldOnTile(ground, 3, 3, 0), null);
    // Fire at 1,1 not yet expired
    assert.ok(getFieldOnTile(ground, 1, 1, 0));
    log('testActiveRegistryAndLongLivedScenario: ok');
}

function testResolveShapedAttackDeploysEmptyTiles() {
    log('Running testResolveShapedAttackDeploysEmptyTiles...');
    const ground = createGroundStore();
    const attacker = mockEntity('Mage', 100, false);
    attacker.tile = { x: 5, y: 5, z: 0 };
    attacker.mp = { current: 100, max: 100 };
    attacker.cooldowns = {};

    const tileMap = {
        isWalkable: () => true,
        groundStore: ground,
        // shapes LoS: treat as open
        getFriction: () => 100
    };

    const spell = {
        id: 'firefield_1',
        field: 'fire',
        deploysField: 'fire',
        kind: 'spell',
        element: 'physical',
        min: 0,
        max: 0,
        range: 7,
        mana: 0,
        shape: { type: 'area', code: 1 },
        cooldowns: {}
    };

    const result = resolveShapedAttack({
        attacker,
        spell,
        candidates: [],
        tileMap,
        groundStore: ground,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(result.ok, true);
    assert.ok(result.affectedTiles.length > 0, 'has footprint tiles');
    let deployed = 0;
    for (let i = 0; i < result.affectedTiles.length; i++) {
        const t = result.affectedTiles[i];
        if (getFieldOnTile(ground, t.x, t.y, 0)) deployed += 1;
    }
    assert.ok(deployed > 0, 'fields on empty tiles without hits');
    log('testResolveShapedAttackDeploysEmptyTiles: ok');
}

function testAttackToSpellMarksField() {
    log('Running testAttackToSpellMarksField...');
    const spell = attackToSpell({
        id: 'firefield_4',
        kind: 'area',
        radius: 3,
        range: 7,
        min: 0,
        max: 0,
        intervalSec: 2,
        isMelee: false
    });
    assert.strictEqual(spell.deploysField, 'fire');
    assert.strictEqual(spell.field, 'fire');

    const rangedSpell = attackToSpell({
        id: 'firefield_3',
        kind: 'ranged',
        radius: 1,
        range: 7,
        min: 0,
        max: 0,
        intervalSec: 2,
        isMelee: false
    });
    assert.strictEqual(rangedSpell.deploysField, 'fire');
    assert.deepStrictEqual(rangedSpell.shape, { type: 'area', code: 1 });
    log('testAttackToSpellMarksField: ok');
}

function testPlayerFieldRuneDeployAndDestroy() {
    log('Running testPlayerFieldRuneDeployAndDestroy...');
    const ground = createGroundStore();
    const player = mockEntity('Hero', 200, true);
    player.tile = { x: 0, y: 0, z: 0 };
    player.mp = { current: 100, max: 100 };
    player.cooldowns = {};
    player.classId = 'adept';

    const creature = mockEntity('Rat', 100, false);
    creature.tile = { x: 3, y: 0, z: 0 };

    const ally = mockEntity('Buddy', 200, true);
    ally.tile = { x: 3, y: 0, z: 0 };
    ally.classId = 'guardian';

    const tileMap = {
        isWalkable: () => true,
        groundStore: ground,
        getFriction: () => 100
    };

    const fireField = {
        id: 'blaze_field_rune',
        source: 'rune',
        field: 'fire',
        deploysField: 'fire',
        statusOnly: true,
        min: 0,
        max: 0,
        element: 'fire',
        range: 7,
        mana: 0,
        isMelee: false,
        shape: { type: 'area', code: 1 },
        cooldowns: {}
    };

    const deploy = resolveShapedAttack({
        attacker: player,
        primary: creature,
        spell: fireField,
        candidates: [creature, ally],
        tileMap,
        groundStore: ground,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(deploy.ok, true);
    const field = getFieldOnTile(ground, 3, 0, 0);
    assert.ok(field, 'player fire field on target tile');
    assert.strictEqual(field.source, 'player', 'source tag player');

    // Creature takes entry damage; ally player is immune to player-sourced fields
    assert.ok(creature.hp.current < 100, 'creature entry damage from player field');
    assert.strictEqual(ally.hp.current, 200, 'party immune to player field');

    // Destroy field rune clears the tile
    const destroySpell = {
        id: 'purge_field_rune',
        source: 'rune',
        destroysField: true,
        statusOnly: true,
        min: 0,
        max: 0,
        element: 'physical',
        range: 5,
        mana: 0,
        isMelee: false,
        shape: { type: 'area', code: 1 },
        cooldowns: {}
    };
    const cleared = resolveShapedAttack({
        attacker: player,
        primary: creature,
        spell: destroySpell,
        candidates: [creature],
        tileMap,
        groundStore: ground,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(cleared.ok, true);
    assert.strictEqual(
        getFieldOnTile(ground, 3, 0, 0),
        null,
        'destroy_field removes field'
    );

    // Bomb footprint deploys multiple tiles
    const bomb = {
        id: 'blaze_bomb_rune',
        source: 'rune',
        field: 'fire',
        deploysField: 'fire',
        statusOnly: true,
        min: 0,
        max: 0,
        element: 'fire',
        range: 7,
        mana: 0,
        isMelee: false,
        shape: { type: 'area', code: 3 },
        cooldowns: {}
    };
    creature.tile = { x: 10, y: 10, z: 0 };
    const bombR = resolveShapedAttack({
        attacker: player,
        primary: creature,
        spell: bomb,
        candidates: [creature],
        tileMap,
        groundStore: ground,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(bombR.ok, true);
    let bombTiles = 0;
    for (let i = 0; i < bombR.affectedTiles.length; i++) {
        const t = bombR.affectedTiles[i];
        if (getFieldOnTile(ground, t.x, t.y, 0)) bombTiles += 1;
    }
    assert.ok(bombTiles >= 5, 'fire bomb covers multi-tile footprint');
    log('testPlayerFieldRuneDeployAndDestroy: ok');
}

/**
 * Ranged area center modes:
 * - castWith tile aim / Active Target (primary): pin on aimed tile or target
 * - Smart Cast / AI (maximize): findTopAreaCenters multi-hit ranking
 * Regression: equal-hit ranking by distance-to-caster must not steal a lone
 * empty-tile aim into a pack pivot between char and target.
 */
function testRangedAreaCenterModes() {
    log('Running testRangedAreaCenterModes...');
    const {
        computeSpellFootprint,
        resolveAreaCenter
    } = require('../kernel/core/lib/combat/area.js');
    const gfb = {
        id: 'grand_fireburst_rune',
        source: 'rune',
        allowFarUse: true,
        range: 7,
        mana: 0,
        isMelee: false,
        min: 10,
        max: 20,
        element: 'fire',
        shape: { type: 'area', code: 5 },
        cooldowns: {}
    };
    const attacker = { tile: { x: 0, y: 0, z: 0 }, type: 'player' };
    // Empty-tile castWith aim far from caster (no creature on aim sqm)
    const aimOnly = {
        tile: { x: 5, y: 0, z: 0 },
        alive: true,
        _aimOnly: true
    };
    // Nearby pack between caster and aim — must not pull castWith center
    const midA = {
        tile: { x: 2, y: 0, z: 0 },
        alive: true,
        hp: { current: 50, max: 50 },
        type: 'creature'
    };
    const midB = {
        tile: { x: 2, y: 1, z: 0 },
        alive: true,
        hp: { current: 50, max: 50 },
        type: 'creature'
    };

    const centerAim = resolveAreaCenter({
        attacker,
        primary: aimOnly,
        spell: gfb,
        candidates: [midA, midB]
    });
    assert.ok(centerAim, 'aim-only center exists');
    assert.strictEqual(centerAim.x, 5, 'castWith tile center x = clicked sqm');
    assert.strictEqual(centerAim.y, 0, 'castWith tile center y = clicked sqm');

    const footAim = computeSpellFootprint({
        attacker,
        primary: aimOnly,
        spell: gfb,
        candidates: [midA, midB]
    });
    assert.strictEqual(footAim.center.x, 5);
    assert.strictEqual(footAim.center.y, 0);
    const aimKeys = new Set(footAim.affectedTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(aimKeys.has('5,0'), 'footprint includes clicked aim tile');

    // Active Target: pin blast on the sticky creature even when a denser pack exists
    const sticky = {
        tile: { x: 6, y: 2, z: 0 },
        alive: true,
        hp: { current: 80, max: 80 },
        type: 'creature'
    };
    const centerActive = resolveAreaCenter({
        attacker,
        primary: sticky,
        spell: gfb,
        candidates: [midA, midB, sticky],
        centerMode: 'primary'
    });
    assert.strictEqual(centerActive.x, 6, 'active target center x = target creature');
    assert.strictEqual(centerActive.y, 2, 'active target center y = target creature');

    // Smart Cast / AI: maximize hits among in-range hostiles (mid pack = 2 hits)
    const centerSmart = resolveAreaCenter({
        attacker,
        primary: sticky,
        spell: gfb,
        candidates: [midA, midB, sticky],
        centerMode: 'maximize'
    });
    assert.ok(centerSmart, 'maximize center exists');
    // GFB (code 5) multi-hit pivot should cover both mid pack tiles — not sticky alone
    const footSmart = computeSpellFootprint({
        attacker,
        primary: sticky,
        spell: gfb,
        candidates: [midA, midB, sticky],
        centerMode: 'maximize'
    });
    const smartKeys = new Set(footSmart.affectedTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(smartKeys.has('2,0'), 'smart cast covers midA');
    assert.ok(smartKeys.has('2,1'), 'smart cast covers midB');

    // Default without primary: same multi-hit ranking
    const centerNoPrimary = resolveAreaCenter({
        attacker,
        primary: null,
        spell: gfb,
        candidates: [midA, midB]
    });
    assert.ok(centerNoPrimary, 'no-primary still resolves a center');
    assert.ok(
        centerNoPrimary.x !== 5 || centerNoPrimary.y !== 0,
        'no-primary path is not stuck on the aim tile used above'
    );

    log('testRangedAreaCenterModes: ok');
}

/**
 * Wall runes: center must stay on the sticky target so diagonal aim picks the
 * stair companion (not findTopAreaCenters' unoriented east line).
 */
function testEnergyWallDiagonalCentersOnTarget() {
    log('Running testEnergyWallDiagonalCentersOnTarget...');
    const { computeSpellFootprint } = require('../kernel/core/lib/combat/area.js');
    const wallSpell = {
        id: 'spark_wall_rune',
        source: 'rune',
        field: 'energy',
        deploysField: 'energy',
        statusOnly: true,
        min: 0,
        max: 0,
        element: 'energy',
        range: 7,
        mana: 0,
        isMelee: false,
        shape: { type: 'area', code: 'wall_field_energy' },
        cooldowns: {}
    };
    const attacker = { tile: { x: 0, y: 3, z: 0 }, type: 'player' };
    const primary = {
        tile: { x: 3, y: 2, z: 0 },
        alive: true,
        hp: { current: 50, max: 50 },
        type: 'creature'
    };
    // Extra same-row body so unoriented top-center would prefer a collinear
    // pivot and collapse facing to pure east if the old path ran.
    const decoy = {
        tile: { x: 2, y: 3, z: 0 },
        alive: true,
        hp: { current: 50, max: 50 },
        type: 'creature'
    };

    const foot = computeSpellFootprint({
        attacker,
        primary,
        spell: wallSpell,
        candidates: [primary, decoy]
    });
    assert.ok(foot.center, 'wall has a center');
    assert.strictEqual(foot.center.x, 3, 'center x = sticky target');
    assert.strictEqual(foot.center.y, 2, 'center y = sticky target');
    assert.deepStrictEqual(
        foot.direction,
        { x: 1, y: -1 },
        'caster→target is NE diagonal'
    );
    assert.strictEqual(
        foot.affectedTiles.length,
        12,
        'diagonal energy wall uses 7×7 stair (12 hit cells)'
    );
    const keys = new Set(foot.affectedTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(keys.has('3,2'), 'footprint includes target tile');
    // Pure cardinal E line through target would be y=2 x=0..6 only; stair
    // must leave that row for off-axis cells.
    assert.ok(
        [...keys].some((k) => !k.endsWith(',2')),
        'diagonal stair is not a pure horizontal line'
    );

    // Cardinal regression: same-row target → horizontal 7-line
    const eastTarget = {
        tile: { x: 3, y: 3, z: 0 },
        alive: true,
        hp: { current: 50, max: 50 },
        type: 'creature'
    };
    const eastFoot = computeSpellFootprint({
        attacker,
        primary: eastTarget,
        spell: wallSpell,
        candidates: [eastTarget]
    });
    assert.deepStrictEqual(eastFoot.direction, { x: 1, y: 0 });
    assert.strictEqual(eastFoot.affectedTiles.length, 7);
    assert.strictEqual(eastFoot.center.x, 3);
    assert.strictEqual(eastFoot.center.y, 3);

    log('testEnergyWallDiagonalCentersOnTarget: ok');
}

/**
 * S04-01: empty footprint must not accept cast (no CD / mana / field).
 * Multi-tile area LoS caster→center fails → affectedTiles [].
 */
function testEmptyFootprintFailsNoSpend() {
    log('Running testEmptyFootprintFailsNoSpend...');
    const ground = createGroundStore();
    const attacker = mockEntity('Mage', 100, false);
    attacker.tile = { x: 0, y: 0, z: 0 };
    attacker.mp = { current: 50, max: 50 };
    attacker.cooldowns = {};

    const primary = mockEntity('Target', 100, false);
    primary.tile = { x: 5, y: 0, z: 0 };

    // Block intermediate tiles so area LoS caster→center fails (dx>1).
    // FRICTION_BLOCKED = 255 (shapes.js).
    const tileMap = {
        isWalkable: () => true,
        getFriction: (x) => (x === 2 || x === 3 ? 255 : 100),
        groundStore: ground
    };

    const bomb = {
        id: 'blaze_bomb_rune',
        source: 'rune',
        field: 'fire',
        deploysField: 'fire',
        statusOnly: true,
        min: 0,
        max: 0,
        element: 'fire',
        range: 7,
        mana: 10,
        isMelee: false,
        shape: { type: 'area', code: 3 },
        cooldowns: { spell: { blaze_bomb_rune: 2 }, primary: { attack: 1 } }
    };

    const result = resolveShapedAttack({
        attacker,
        primary,
        spell: bomb,
        candidates: [primary],
        tileMap,
        groundStore: ground
    });
    assert.strictEqual(result.ok, false, 'empty footprint fails');
    assert.strictEqual(result.reason, 'no_tiles');
    assert.strictEqual(attacker.mp.current, 50, 'mana not spent');
    assert.strictEqual(
        getFieldOnTile(ground, 5, 0, 0),
        null,
        'no field deployed'
    );
    log('testEmptyFootprintFailsNoSpend: ok');
}

/**
 * S04-03: tryAttack + runeConsumption spends nested-bag fire field rune once.
 */
function testTryAttackFieldRuneConsumesNestedBag() {
    log('Running testTryAttackFieldRuneConsumesNestedBag...');
    const itemDb = [
        {
            id: 'backpack',
            label: 'Backpack',
            category: 'container',
            slot: 'backpack',
            volume: 20,
            weight: 1800
        },
        {
            id: 'bag',
            label: 'Bag',
            category: 'container',
            volume: 8,
            weight: 800
        },
        {
            id: 'blaze_field_rune',
            label: 'Blaze Field Rune',
            category: 'rune',
            stackable: true,
            weight: 70
        }
    ];
    const spell = {
        id: 'blaze_field_rune',
        source: 'rune',
        runeItemId: 'blaze_field_rune',
        field: 'fire',
        deploysField: 'fire',
        statusOnly: true,
        min: 0,
        max: 0,
        element: 'fire',
        range: 7,
        mana: 0,
        isMelee: false,
        level: 1,
        magicLevel: 1,
        shape: { type: 'area', code: 1 },
        cooldowns: {}
    };

    const ground = createGroundStore();
    const caster = mockEntity('Hero', 200, true);
    caster.tile = { x: 0, y: 0, z: 0 };
    caster.mp = { current: 100, max: 100 };
    caster.cooldowns = {};
    caster.classId = 'adept';
    caster.level = 50;
    caster.combatStats = {
        magic: 20,
        level: 50,
        spells: ['blaze_field_rune']
    };
    caster.inventory = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                {
                    itemId: 'bag',
                    contents: [{ itemId: 'blaze_field_rune', count: 2 }]
                }
            ]
        },
        itemDb
    );

    const foe = mockEntity('Rat', 100, false);
    foe.tile = { x: 3, y: 0, z: 0 };

    const tileMap = {
        isWalkable: () => true,
        getFriction: () => 100,
        groundStore: ground
    };

    assert.strictEqual(
        countItemIdInInventoryTree(caster.inventory, 'blaze_field_rune'),
        2
    );

    const r = tryAttack({
        attacker: caster,
        defender: foe,
        spellId: 'blaze_field_rune',
        ctx: {
            runeConsumption: true,
            spellBook: { blaze_field_rune: spell },
            tileMap,
            groundStore: ground,
            enemies: [foe],
            rng: () => 0.5
        }
    });
    assert.ok(r && r.ok, 'tryAttack accepts field rune cast');
    assert.ok(getFieldOnTile(ground, 3, 0, 0), 'fire field deployed');
    assert.strictEqual(
        countItemIdInInventoryTree(caster.inventory, 'blaze_field_rune'),
        1,
        'exactly one nested rune consumed'
    );

    // Empty footprint via blocked LoS on multi-tile bomb must not spend.
    const bomb = {
        id: 'blaze_bomb_rune',
        source: 'rune',
        runeItemId: 'blaze_field_rune',
        field: 'fire',
        deploysField: 'fire',
        statusOnly: true,
        min: 0,
        max: 0,
        element: 'fire',
        range: 7,
        mana: 0,
        isMelee: false,
        level: 1,
        magicLevel: 1,
        shape: { type: 'area', code: 3 },
        cooldowns: {}
    };
    caster.combatStats.spells = ['blaze_field_rune', 'blaze_bomb_rune'];
    const blockedMap = {
        isWalkable: () => true,
        getFriction: (x) => (x === 2 || x === 3 ? 255 : 100),
        groundStore: ground
    };
    const far = mockEntity('Far', 100, false);
    far.tile = { x: 5, y: 0, z: 0 };
    const fail = tryAttack({
        attacker: caster,
        defender: far,
        spellId: 'blaze_bomb_rune',
        ctx: {
            runeConsumption: true,
            spellBook: {
                blaze_field_rune: spell,
                blaze_bomb_rune: bomb
            },
            tileMap: blockedMap,
            groundStore: ground,
            enemies: [far],
            rng: () => 0.5
        }
    });
    assert.strictEqual(fail, null, 'tryAttack returns null on no_tiles');
    assert.strictEqual(
        countItemIdInInventoryTree(caster.inventory, 'blaze_field_rune'),
        1,
        'failed cast does not spend rune'
    );

    log('testTryAttackFieldRuneConsumesNestedBag: ok');
}

function testPlayerTicksConditionsViaSuper() {
    log('Running testPlayerTicksConditionsViaSuper...');
    const player = new Player({
        name: 'Hero',
        hp: 200,
        tile: { x: 0, y: 0, z: 0 }
    });
    applyCondition(player, {
        type: 'fire',
        schedule: [{ turns: 1, damage: 10, intervalSec: 9 }],
        totalDamage: 10
    });
    const before = player.hp.current;
    // Drive Creature.update path
    const prevDt = Time.deltaTime;
    Time.deltaTime = 9;
    player.update();
    Time.deltaTime = prevDt;
    assert.ok(player.hp.current < before, 'Player DoT ticked via super.update');
    log('testPlayerTicksConditionsViaSuper: ok');
}

function testTileMapSyncAndAvoidanceDerivation() {
    log('Running testTileMapSyncAndAvoidanceDerivation...');
    const monster = {
        flags: { canWalkOnFire: true },
        resists: { energy: 100, earth: 10 }
    };
    const mAvoid = computeEntityAvoidFieldMask(monster);
    assert.strictEqual(mAvoid.avoidFieldMask, 2, 'Only poison field avoids (mask = 2)');
    assert.strictEqual(mAvoid.ignorePlayerFields, false, 'Monster does not ignore player fields by default');

    const player = { type: 'player', resists: {} };
    const pAvoid = computeEntityAvoidFieldMask(player);
    assert.strictEqual(pAvoid.avoidFieldMask, 7, 'Player avoids all damaging fields by default (mask = 1|2|4 = 7)');
    assert.strictEqual(pAvoid.ignorePlayerFields, true, 'Player ignores player-sourced fields');

    // Test GroundStore tileMap synchronization
    const ground = createGroundStore();
    let lastSetMask = null;
    let lastCoord = null;
    const mockTileMap = {
        setTileFieldMask: (x, y, z, mask) => {
            lastSetMask = mask;
            lastCoord = { x, y, z };
        }
    };
    ground.tileMap = mockTileMap;

    deployFieldToTile(ground, 10, 15, 7, { kind: 'fire', source: FIELD_SOURCES.PLAYER });
    assert.strictEqual(lastSetMask, 9, 'Fire field (1) + Player source (8) = mask 9 synced to TileMap');
    assert.deepStrictEqual(lastCoord, { x: 10, y: 15, z: 7 });

    removeFieldFromTile(ground, 10, 15, 7);
    assert.strictEqual(lastSetMask, 0, 'Removal resets tile field mask to 0');
    log('testTileMapSyncAndAvoidanceDerivation: ok');
}

/**
 * Phase B: field deploy underfoot hits all combatants on a stacked tile
 * (not only getOccupant first).
 */
function testFieldDeployHitsAllCombatantsOnStack() {
    log('Running testFieldDeployHitsAllCombatantsOnStack...');
    const { TileMap } = require('../kernel/core/entities/tilemap.js');
    const { deployFieldAndTriggerOccupants } = require('../kernel/core/lib/combat/elemental_fields.js');
    const { combatantsOnTileForField } = require('../kernel/core/lib/combat/area.js');

    const ground = createGroundStore();
    const map = new TileMap('field_stack');
    const open = new Uint8Array(9);
    open.fill(100);
    map.loadFloorFromFriction(0, 3, 3, open);
    map.groundStore = ground;
    const ents = new Map();
    map.resolveEntity = (id) => ents.get(id) || null;

    const p1 = mockEntity('P1', 200, true);
    p1.id = 1;
    p1.tile = { x: 1, y: 1, z: 0 };
    const p2 = mockEntity('P2', 200, true);
    p2.id = 2;
    p2.tile = { x: 1, y: 1, z: 0 };
    const mob = mockEntity('Mob', 100, false);
    mob.id = 3;
    mob.tile = { x: 1, y: 1, z: 0 };
    ents.set(1, p1);
    ents.set(2, p2);
    ents.set(3, mob);

    assert.ok(map.tryOccupy(1, 1, 0, mob));
    assert.ok(map.moveEntityToTile(p1, 1, 1, 0, { reason: 'stair' }));
    assert.ok(map.moveEntityToTile(p2, 1, 1, 0, { reason: 'stair' }));
    assert.deepStrictEqual(map.getCombatants(1, 1, 0), [3, 1, 2]);

    const occs = combatantsOnTileForField(map, 1, 1, 0, []);
    assert.strictEqual(occs.length, 3, 'all three combatants');

    deployFieldAndTriggerOccupants(
        ground,
        1,
        1,
        0,
        { kind: 'fire', source: 'scenario' },
        occs,
        0
    );
    // Fire entry: 20 each (no resists)
    assert.strictEqual(p1.hp.current, 180);
    assert.strictEqual(p2.hp.current, 180);
    assert.strictEqual(mob.hp.current, 80);

    // Player-sourced field: players immune, creature hit
    const ground2 = createGroundStore();
    const pA = mockEntity('A', 200, true);
    pA.id = 11;
    const pB = mockEntity('B', 200, true);
    pB.id = 12;
    const rat = mockEntity('Rat', 100, false);
    rat.id = 13;
    deployFieldAndTriggerOccupants(
        ground2,
        0,
        0,
        0,
        { kind: 'fire', source: 'player' },
        [pA, pB, rat],
        0
    );
    assert.strictEqual(pA.hp.current, 200, 'player immune to player field');
    assert.strictEqual(pB.hp.current, 200);
    assert.strictEqual(rat.hp.current, 80, 'creature takes player field');

    log('testFieldDeployHitsAllCombatantsOnStack: ok');
}

/**
 * Phase B: energy field expire underfoot applies exit damage to all combatants.
 */
function testEnergyExpireUnderfootAllCombatants() {
    log('Running testEnergyExpireUnderfootAllCombatants...');
    const ground = createGroundStore();
    deployFieldToTile(ground, 5, 5, 0, {
        kind: 'energy',
        source: 'scenario',
        createdAt: 0
    });
    const a = mockEntity('A', 100, true);
    a.id = 1;
    const b = mockEntity('B', 100, true);
    b.id = 2;
    const c = mockEntity('C', 100, false);
    c.id = 3;

    // Entry damage first (optional for realism) — skip; expire exit only.
    const purged = checkAndCleanExpiredTileFields(
        ground,
        5,
        5,
        0,
        98,
        [a, b, c]
    );
    assert.strictEqual(purged, true);
    // Energy exit = 25 each
    assert.strictEqual(a.hp.current, 75);
    assert.strictEqual(b.hp.current, 75);
    assert.strictEqual(c.hp.current, 75);
    assert.strictEqual(getFieldOnTile(ground, 5, 5, 0), null);

    log('testEnergyExpireUnderfootAllCombatants: ok');
}

/**
 * Phase K — barrier / vine solid obstacles: path block, duration, floor stick,
 * no entry damage, replace, destroy.
 */
function testObstacleBarrierAndVine() {
    log('Running testObstacleBarrierAndVine...');
    assert.strictEqual(getFieldKind('barrier_wall'), 'barrier');
    assert.strictEqual(getFieldKind('magic_wall'), 'barrier');
    assert.strictEqual(getFieldKind('wild_growth'), 'vine');
    assert.strictEqual(getFieldKind('vine_barrier'), 'vine');
    assert.ok(isObstacleFieldKind('barrier'));
    assert.ok(isObstacleFieldKind('vine'));
    assert.ok(!isObstacleFieldKind('fire'));

    // Open 8×8 floor
    const friction = new Uint8Array(8 * 8);
    friction.fill(100);
    const tileMap = new TileMap();
    tileMap.loadFloorFromFriction(7, 8, 8, friction);
    const ground = createGroundStore();
    ground.tileMap = tileMap;
    tileMap.groundStore = ground;

    // Deploy barrier at (3,3,7)
    const b = deployFieldToTile(ground, 3, 3, 7, {
        kind: 'barrier',
        source: FIELD_SOURCES.PLAYER,
        createdAt: 0
    });
    assert.ok(b, 'barrier deployed');
    assert.strictEqual(b.fieldKind, 'barrier');
    assert.strictEqual(b.isObstacle, true);
    assert.strictEqual(b.durationSec, 20, 'default barrier 20s');
    assert.strictEqual(b.location.z, 7, 'floor stick z=7');
    assert.ok(isObstacleField(b));
    assert.strictEqual(tileMap.isWalkable(3, 3, 7), false, 'tile not walkable');
    assert.strictEqual(
        tileMap.getFriction(3, 3, 7),
        FRICTION_BLOCKED,
        'friction blocked'
    );
    assert.ok(
        (tileMap.getTileFieldMask(3, 3, 7) & FIELD_MASKS.OBSTACLE) !== 0,
        'OBSTACLE mask bit'
    );

    // No entry damage
    const rat = mockEntity('Rat', 50, false);
    const entry = applyFieldEntryEffects(rat, b, 0);
    assert.strictEqual(entry.damage || 0, 0, 'no obstacle damage');
    assert.strictEqual(rat.hp.current, 50);

    // A* cannot path through or onto barrier
    const path = findPath(
        tileMap,
        { x: 1, y: 3, z: 7 },
        { x: 5, y: 3, z: 7 },
        { allowDiagonal: false }
    );
    assert.ok(path === null || path.every((p) => !(p.x === 3 && p.y === 3)),
        'path avoids barrier tile');
    const onto = findPath(
        tileMap,
        { x: 1, y: 3, z: 7 },
        { x: 3, y: 3, z: 7 },
        { allowDiagonal: false }
    );
    assert.strictEqual(onto, null, 'cannot path onto barrier as goal');

    // Floor stick: second floor empty; barrier stays only on z=7
    const friction6 = new Uint8Array(8 * 8);
    friction6.fill(100);
    tileMap.loadFloorFromFriction(6, 8, 8, friction6);
    assert.strictEqual(getFieldOnTile(ground, 3, 3, 7).fieldKind, 'barrier');
    assert.strictEqual(getFieldOnTile(ground, 3, 3, 6), null, 'not on other floor');

    // Vine replaces barrier; duration 30s
    const v = deployFieldToTile(ground, 3, 3, 7, {
        kind: 'vine',
        source: FIELD_SOURCES.PLAYER,
        createdAt: 5
    });
    assert.strictEqual(getFieldOnTile(ground, 3, 3, 7).fieldKind, 'vine');
    assert.strictEqual(v.durationSec, 30);
    assert.strictEqual(tileMap.isWalkable(3, 3, 7), false);

    // Expire restores friction
    const now = 5 + 30;
    const cleaned = checkAndCleanExpiredTileFields(ground, 3, 3, 7, now, []);
    assert.strictEqual(cleaned, true, 'expired vine purged');
    assert.strictEqual(getFieldOnTile(ground, 3, 3, 7), null);
    assert.strictEqual(tileMap.isWalkable(3, 3, 7), true, 'friction restored');
    assert.strictEqual(tileMap.getFriction(3, 3, 7), 100);

    // resolveShapedAttack deploys barrier on empty footprint center (no creature).
    const caster = mockEntity('Caster', 100, true);
    caster.tile = { x: 1, y: 1, z: 7 };
    caster.mp = { current: 0, max: 0 };
    caster.cooldowns = {};
    const spell = {
        id: 'barrier_wall_rune',
        statusOnly: true,
        min: 0,
        max: 0,
        range: 7,
        mana: 0,
        hitChance: 100,
        shape: { type: 'area', code: 1 },
        deploysField: 'barrier',
        field: 'barrier',
        fieldDurationSec: 20,
        cooldowns: { primary: { attack: 2 } }
    };
    const res = resolveShapedAttack({
        attacker: caster,
        spell,
        candidates: [],
        tileMap,
        groundStore: ground,
        center: { x: 4, y: 4, z: 7 },
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(res.ok, true, res.reason || 'barrier cast ok');
    const planted = getFieldOnTile(ground, 4, 4, 7);
    assert.ok(planted, 'barrier planted via shaped attack');
    assert.strictEqual(planted.fieldKind, 'barrier');
    assert.strictEqual(planted.durationSec, 20);
    assert.strictEqual(planted.location.z, 7);

    // Cannot place on creature-occupied tile
    const monster = mockEntity('Blocker', 10, false);
    monster.tile = { x: 2, y: 2, z: 7 };
    monster.alive = true;
    resolveShapedAttack({
        attacker: caster,
        primary: monster,
        spell,
        candidates: [monster],
        tileMap,
        groundStore: ground,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(
        getFieldOnTile(ground, 2, 2, 7),
        null,
        'no barrier under creature'
    );

    log('testObstacleBarrierAndVine: ok');
}

/**
 * Floor-stick contract: fields and barriers keep duration + step effects on the
 * plant floor after the caster hops away (legacy createItem at Position).
 */
function testFieldAndBarrierFloorStickAfterCasterHop() {
    log('Running testFieldAndBarrierFloorStickAfterCasterHop...');

    const friction0 = new Uint8Array(8 * 8);
    friction0.fill(100);
    const friction1 = new Uint8Array(8 * 8);
    friction1.fill(100);
    const tileMap = new TileMap();
    tileMap.loadFloorFromFriction(0, 8, 8, friction0);
    tileMap.loadFloorFromFriction(1, 8, 8, friction1);
    const ground = createGroundStore();
    ground.tileMap = tileMap;
    tileMap.groundStore = ground;

    // --- Fire field: plant on z=0, caster hops to z=1 ---
    const fire = deployFieldToTile(ground, 4, 4, 0, {
        kind: 'fire',
        source: FIELD_SOURCES.PLAYER,
        createdAt: 0,
        durationSec: 12
    });
    assert.ok(fire);
    assert.strictEqual(fire.location.z, 0);
    assert.strictEqual(fire.expireAt, 12);

    // Caster leaves the plant floor (stairs hop). Field must not move.
    const caster = mockEntity('Caster', 100, true);
    caster.tile = { x: 0, y: 0, z: 0 };
    caster.tile = { x: 1, y: 1, z: 1 };

    assert.ok(getFieldOnTile(ground, 4, 4, 0), 'fire stays on plant floor');
    assert.strictEqual(
        getFieldOnTile(ground, 4, 4, 1),
        null,
        'fire does not follow caster to z=1'
    );

    // Step-on still damages a creature on plant floor while caster is elsewhere.
    const rat = mockEntity('Rat', 100, false);
    rat.tile = { x: 4, y: 4, z: 0 };
    const entry = applyFieldEntryEffects(rat, fire, 1);
    assert.ok(entry.damage > 0, 'entry damage while caster on other floor');
    assert.ok(rat.hp.current < 100);

    // Duration still expires on plant floor (purge heap path).
    let purged = purgeExpiredFields(ground, 11, () => []);
    assert.strictEqual(purged, 0, 'not yet expired at t=11');
    assert.ok(getFieldOnTile(ground, 4, 4, 0));
    purged = purgeExpiredFields(ground, 12.01, () => [rat]);
    assert.ok(purged >= 1, 'expired after duration on plant floor');
    assert.strictEqual(getFieldOnTile(ground, 4, 4, 0), null);

    // --- Barrier wall: plant on z=0, caster on z=1, block + expire ---
    const wall = deployFieldToTile(ground, 5, 5, 0, {
        kind: 'barrier',
        source: FIELD_SOURCES.PLAYER,
        createdAt: 20,
        durationSec: 20
    });
    assert.ok(wall);
    assert.strictEqual(wall.location.z, 0);
    assert.strictEqual(tileMap.isWalkable(5, 5, 0), false);
    assert.strictEqual(tileMap.isWalkable(5, 5, 1), true, 'other floor open');

    // Caster still on z=1 — barrier must remain blocked on z=0 for full duration.
    assert.ok(getFieldOnTile(ground, 5, 5, 0));
    assert.strictEqual(getFieldOnTile(ground, 5, 5, 1), null);

    purged = purgeExpiredFields(ground, 39.9, () => []);
    assert.strictEqual(purged, 0, 'barrier still active near end of duration');
    assert.strictEqual(tileMap.isWalkable(5, 5, 0), false);

    purged = purgeExpiredFields(ground, 40.01, () => []);
    assert.ok(purged >= 1, 'barrier expires on plant floor');
    assert.strictEqual(getFieldOnTile(ground, 5, 5, 0), null);
    assert.strictEqual(tileMap.isWalkable(5, 5, 0), true, 'friction restored');

    // --- Vine via shaped cast then caster hop ---
    const planter = mockEntity('Planter', 100, true);
    planter.tile = { x: 1, y: 1, z: 0 };
    planter.mp = { current: 0, max: 0 };
    planter.cooldowns = {};
    const vineSpell = {
        id: 'vine_barrier_rune',
        statusOnly: true,
        min: 0,
        max: 0,
        range: 7,
        mana: 0,
        hitChance: 100,
        shape: { type: 'area', code: 1 },
        deploysField: 'vine',
        fieldDurationSec: 30,
        cooldowns: { primary: { attack: 2 } }
    };
    const planted = resolveShapedAttack({
        attacker: planter,
        spell: vineSpell,
        candidates: [],
        tileMap,
        groundStore: ground,
        center: { x: 2, y: 2, z: 0 },
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.ok(planted.ok, planted.reason || 'vine cast');
    const vine = getFieldOnTile(ground, 2, 2, 0);
    assert.ok(vine && vine.fieldKind === 'vine');
    assert.strictEqual(vine.location.z, 0);
    planter.tile = { x: 0, y: 0, z: 1 };
    assert.ok(
        getFieldOnTile(ground, 2, 2, 0),
        'vine remains after caster floor hop'
    );
    assert.strictEqual(tileMap.isWalkable(2, 2, 0), false);

    log('testFieldAndBarrierFloorStickAfterCasterHop: ok');
}

function main() {
    testFieldKindAndDurations();
    testFieldSingleTileReplacement();
    testStackOrderFieldOnTop();
    testGroundStoreIntegrationAndImmobility();
    testFriendlyFireAndSourceRules();
    testFieldEntryAndDoTSchedules();
    testEnergyFieldEntryAndExit();
    testElementalResistanceFloorToZero();
    testMitigationPercentOnDoT();
    testActiveRegistryAndLongLivedScenario();
    testResolveShapedAttackDeploysEmptyTiles();
    testAttackToSpellMarksField();
    testPlayerFieldRuneDeployAndDestroy();
    testRangedAreaCenterModes();
    testEnergyWallDiagonalCentersOnTarget();
    testEmptyFootprintFailsNoSpend();
    testTryAttackFieldRuneConsumesNestedBag();
    testPlayerTicksConditionsViaSuper();
    testTileMapSyncAndAvoidanceDerivation();
    testCreatureRangedFieldDeployment();
    testCreatureFieldAffectsOtherCreaturesAndSummonSpawn();
    testFindSpawnTileRejectsHazardForSummon();
    testFieldDeployHitsAllCombatantsOnStack();
    testEnergyExpireUnderfootAllCombatants();
    testObstacleBarrierAndVine();
    testFieldAndBarrierFloorStickAfterCasterHop();
    console.log('elemental_fields: ok');
}

function testCreatureRangedFieldDeployment() {
    log('Running testCreatureRangedFieldDeployment...');
    const ground = createGroundStore();
    const demon = mockEntity('Demon', 500, false);
    demon.tile = { x: 0, y: 0, z: 0 };
    demon.creatureType = 'Demon';
    demon._kitTemplate = {
        attacks: [
            {
                id: 'firefield_3',
                kind: 'ranged',
                radius: 1,
                range: 7,
                interval: 2000,
                chance: 100,
                min: 0,
                max: 0,
                target: true,
                shootEffect: 'fire'
            }
        ]
    };
    demon.attacks = demon._kitTemplate.attacks;

    const player = mockEntity('Hero', 200, true);
    player.tile = { x: 3, y: 0, z: 0 };

    const tileMap = {
        isWalkable: () => true,
        groundStore: ground,
        getFriction: () => 100
    };

    const res = tryCreatureAttacks(demon, player, {
        players: [player],
        tileMap,
        groundStore: ground,
        rng: () => 0.1
    });

    assert.strictEqual(res.fired, true, 'Demon fired firefield_3');
    const field = getFieldOnTile(ground, 3, 0, 0);
    assert.ok(field, 'Fire field deployed onto target tile (x: 3, y: 0)');
    assert.strictEqual(field.fieldKind, 'fire', 'Field kind is fire');
    assert.strictEqual(field.source, 'creature', 'Field source is creature');
    log('testCreatureRangedFieldDeployment: ok');
}

function testCreatureFieldAffectsOtherCreaturesAndSummonSpawn() {
    log('Running testCreatureFieldAffectsOtherCreaturesAndSummonSpawn...');
    const ground = createGroundStore();
    const fireField = deployFieldToTile(ground, 5, 5, 0, {
        kind: 'fire',
        source: FIELD_SOURCES.CREATURE
    });

    // 1. Check immunity and damage for another creature stepping into creature field
    const rat = mockEntity('Cave Rat', 50, false);
    rat.flags = { canWalkOnFire: false };
    assert.strictEqual(isEntityImmuneToField(rat, FIELD_SOURCES.CREATURE), false, 'Creature is not immune to creature-created field');
    const res = applyFieldEntryEffects(rat, fireField, 0);
    assert.strictEqual(res.applied, true, 'Field effects applied to cave rat');

    // 2. Check hazard detection for entity with canWalkOnFire: false
    const tileMap = {
        getTileFieldMask: (x, y, z) => (x === 5 && y === 5 ? 1 : 0) // 1 = fire mask
    };
    const isHazard = isTileFieldHazardForEntity(tileMap, 5, 5, 0, rat);
    assert.strictEqual(isHazard, true, 'Fire field tile is a hazard for Cave Rat with canWalkOnFire false');

    // 3. Check hazard detection for immune creature (e.g. Fire Elemental)
    const fireEle = mockEntity('Fire Elemental', 200, false);
    fireEle.flags = { canWalkOnFire: true };
    const isHazardEle = isTileFieldHazardForEntity(tileMap, 5, 5, 0, fireEle);
    assert.strictEqual(isHazardEle, false, 'Fire field tile is NOT a hazard for Fire Elemental');

    log('testCreatureFieldAffectsOtherCreaturesAndSummonSpawn: ok');
}

/**
 * findSpawnTile (used by spawnSummon) must skip field hazards for non-immune
 * templates and may land on the same tile when the template is immune.
 */
function testFindSpawnTileRejectsHazardForSummon() {
    log('Running testFindSpawnTileRejectsHazardForSummon...');

    // Master at (5,5); only that cell has fire mask. All tiles walkable.
    const tileMap = {
        canEnter: () => true,
        getTileFieldMask: (x, y) => (x === 5 && y === 5 ? 1 : 0)
    };

    const fragile = { template: { flags: { canWalkOnFire: false } } };
    // memberIndex 1 = summon spiral (skip exact master tile); if spiral were broken
    // and only (5,5) considered free of hazard checks, would incorrectly return it.
    const fragileTile = findSpawnTile(tileMap, 5, 5, 0, 1, fragile);
    assert.ok(fragileTile, 'findSpawnTile finds an alternate free tile');
    assert.notStrictEqual(
        fragileTile.x === 5 && fragileTile.y === 5,
        true,
        'non-immune summon must not spawn on fire hazard under master'
    );
    assert.strictEqual(
        isTileFieldHazardForEntity(tileMap, fragileTile.x, fragileTile.y, 0, fragile),
        false,
        'chosen spawn tile is not a hazard for non-immune template'
    );

    // When every free tile is fire, spawn fails (null).
    const allFire = {
        canEnter: () => true,
        getTileFieldMask: () => 1
    };
    const none = findSpawnTile(allFire, 0, 0, 0, 1, fragile);
    assert.strictEqual(none, null, 'no spawn tile when all free cells are fire hazards');

    // Immune template may spawn on fire (memberIndex 0 accepts origin).
    const immune = { template: { flags: { canWalkOnFire: true } } };
    const onFire = findSpawnTile(tileMap, 5, 5, 0, 0, immune);
    assert.ok(onFire, 'immune template can use fire tile');
    assert.strictEqual(onFire.x, 5);
    assert.strictEqual(onFire.y, 5);

    log('testFindSpawnTileRejectsHazardForSummon: ok');
}

main();
