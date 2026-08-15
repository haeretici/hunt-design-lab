#!/usr/bin/env node
/**
 * Stage 9 exit criteria: catalog → combat templates (defaults fill gaps);
 * equipment category stats; waypoint presets; multi-floor load; hunt fully
 * from repo data files with no hard-coded monster names in engine code.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { ROOT, mapPathPng, DEFAULT_GENRE } = require('../kernel/settings.js');
const { TileMap } = require('../kernel/core/entities/tilemap.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const presets = require('../kernel/core/lib/presets.js');
const {
    fillCreatureCombatDefaults,
    catalogEntryToCombatTemplate,
    resolveCreatureTemplate,
    fillEquipmentCombatDefaults,
    buildItemDb,
    normalizeWaypoints,
    resolveHuntWaypoints,
    DEFAULT_CREATURE_COMBAT,
    resolveCreatureSpeed,
    EQUIPMENT_CATEGORY_DEFAULTS,
    convertMonsterToTemplate
} = require('../kernel/core/lib/content/index.js');
const { rollupEquipment } = require('../kernel/core/lib/character/stats.js');
const { loadCatalog, findById } = require('../kernel/core/lib/creature_manifest.js');
const { Creature } = require('../kernel/core/entities/creature.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function testCreatureDefaults() {
    const filled = fillCreatureCombatDefaults({});
    assert.strictEqual(filled.hp, DEFAULT_CREATURE_COMBAT.hp);
    assert.ok(Array.isArray(filled.attacks) && filled.attacks.length >= 1);
    assert.strictEqual(filled.attacks[0].max, DEFAULT_CREATURE_COMBAT.attacks[0].max);
    assert.ok(filled.atk == null, 'atk is not a default combat field');
    assert.ok(filled.resists && typeof filled.resists.physical === 'number');

    const partial = fillCreatureCombatDefaults({ hp: 200, attacks: [{ id: 'm', min: 1, max: 5 }] });
    assert.strictEqual(partial.hp, 200);
    assert.strictEqual(partial.hpMax, 200);
    assert.strictEqual(partial.attacks[0].max, 5);
    assert.strictEqual(partial.speed, DEFAULT_CREATURE_COMBAT.speed);

    // Explicit empty kit stays empty (no invent from atk).
    const emptyKit = fillCreatureCombatDefaults({ attacks: [] });
    assert.strictEqual(emptyKit.attacks.length, 0);

    // Dead monster fields are not filled from defaults / keys.
    const legacyPartial = fillCreatureCombatDefaults({
        atk: 40,
        skill: 20,
        autoAttack: 'melee_auto',
        attackRange: 4,
        magic: 15
    });
    assert.ok(legacyPartial.atk == null, 'atk not a combat key');
    assert.ok(legacyPartial.skill == null, 'skill not a combat key');
    assert.ok(legacyPartial.autoAttack == null, 'autoAttack not a combat key');
    assert.ok(legacyPartial.attackRange == null, 'attackRange not a combat key');
    assert.ok(legacyPartial.magic == null, 'magic not a combat key (player skill only)');
    assert.ok(legacyPartial.attacks.length >= 1, 'still injects default melee when attacks missing');
    assert.ok(
        legacyPartial.flags && legacyPartial.flags.targetDistance === 1,
        'default flags.targetDistance'
    );

    log('creature defaults', {
        hp: filled.hp,
        meleeMax: filled.attacks[0].max,
        targetDistance: filled.flags && filled.flags.targetDistance
    });
}

/**
 * Creature move speed is absolute (template field). Level and combat tier
 * never change it — unlike players (baseSpeed + level − 1 + gear).
 */
function testCreatureSpeedAbsolute() {
    assert.strictEqual(resolveCreatureSpeed(undefined), 100);
    assert.strictEqual(resolveCreatureSpeed(null), 100);
    assert.strictEqual(resolveCreatureSpeed(75), 75);
    assert.strictEqual(resolveCreatureSpeed(0), 0, '0 = stationary dummy');
    assert.strictEqual(resolveCreatureSpeed('180'), 180);
    assert.strictEqual(resolveCreatureSpeed('nope'), 100);

    // Ctor default matches DEFAULT_CREATURE_COMBAT (not player 110)
    const bare = new Creature({ id: 1 });
    assert.strictEqual(bare.speed, DEFAULT_CREATURE_COMBAT.speed);

    // Template speed wins; high level does not add speed
    const rat = new Creature({ id: 2 });
    rat.applyTemplate({
        id: 'fast_bug',
        speed: 75,
        level: 99,
        hp: 30,
        hpMax: 30
    });
    assert.strictEqual(rat.speed, 75);
    assert.strictEqual(rat.level, 99);

    // Stationary dummy
    const dummy = new Creature({ id: 3 });
    dummy.applyTemplate({ id: 'dummy', speed: 0, hp: 500, hpMax: 500 });
    assert.strictEqual(dummy.speed, 0);

    // Omitting speed keeps ctor default
    const partial = new Creature({ id: 4 });
    partial.applyTemplate({ id: 'no_speed', hp: 10, hpMax: 10, level: 40 });
    assert.strictEqual(partial.speed, DEFAULT_CREATURE_COMBAT.speed);

    // Tier scales hp + kit min/max but not speed
    const baseTpl = catalogEntryToCombatTemplate({
        id: 'tier_probe',
        alias: 'Tier Probe',
        combat: {
            hp: 100,
            speed: 120,
            attacks: [{ id: 'm', kind: 'melee', min: 0, max: 20 }]
        }
    });
    const eliteTpl = catalogEntryToCombatTemplate({
        id: 'tier_probe',
        alias: 'Tier Probe',
        combatTier: 'elite',
        combat: {
            hp: 100,
            speed: 120,
            attacks: [{ id: 'm', kind: 'melee', min: 0, max: 20 }]
        }
    });
    assert.ok(eliteTpl.hp > baseTpl.hp);
    assert.ok(eliteTpl.attacks[0].max > baseTpl.attacks[0].max);
    assert.strictEqual(eliteTpl.speed, baseTpl.speed);
    assert.strictEqual(eliteTpl.speed, 120);

    // Port: missing mon.speed → default 100; explicit values preserved
    const noSpeed = convertMonsterToTemplate({ name: 'No Speed Mob', health: 50 });
    assert.strictEqual(noSpeed.speed, DEFAULT_CREATURE_COMBAT.speed);
    const withSpeed = convertMonsterToTemplate({
        name: 'Swift Mob',
        health: 50,
        speed: 180
    });
    assert.strictEqual(withSpeed.speed, 180);

    // Preset cave_rat keeps authored speed through applyTemplate
    const ratTpl = resolveCreatureTemplate('cave_rat', {
        loadPresetTemplate: (id) => presets.loadCreatureTemplateRaw(id)
    });
    if (ratTpl && ratTpl.speed != null) {
        const c = new Creature({ id: 9 });
        c.applyTemplate(ratTpl);
        assert.strictEqual(c.speed, ratTpl.speed);
        assert.ok(c.speed > 0);
    }

    log('creature speed absolute ok', {
        default: DEFAULT_CREATURE_COMBAT.speed,
        bare: bare.speed,
        rat: rat.speed
    });
}

function testCatalogCreatureTemplate() {
    const catalog = loadCatalog(DEFAULT_GENRE, { kind: 'creatures' });
    const entry = findById(catalog, 'ashen_dwarf_priest');
    assert.ok(entry, 'catalog has ashen_dwarf_priest');

    const tpl = catalogEntryToCombatTemplate(entry);
    assert.strictEqual(tpl.id, 'ashen_dwarf_priest');
    assert.ok(tpl.label);
    assert.ok(tpl.hp > 0);
    assert.ok(Array.isArray(tpl.attacks) && tpl.attacks.length >= 1);
    assert.ok(tpl.attacks[0].max > 0, 'catalog default melee has damage');
    assert.strictEqual(tpl.source, 'catalog');
    assert.ok(tpl.sprites);

    const elite = catalogEntryToCombatTemplate(
        Object.assign({}, entry, { combatTier: 'elite' })
    );
    assert.ok(elite.hp > tpl.hp, 'elite tier scales hp');
    assert.ok(
        elite.attacks[0].max > tpl.attacks[0].max,
        'elite tier scales kit damage'
    );

    const withCombat = catalogEntryToCombatTemplate(
        Object.assign({}, entry, {
            combat: {
                hp: 999,
                attacks: [{ id: 'm', kind: 'melee', min: 5, max: 77 }]
            }
        })
    );
    assert.strictEqual(withCombat.hp, 999);
    assert.strictEqual(withCombat.attacks[0].max, 77);
    log('catalog creature', {
        id: tpl.id,
        label: tpl.label,
        hp: tpl.hp,
        eliteHp: elite.hp,
        meleeMax: tpl.attacks[0].max
    });
}

function testResolveCreatureTemplate() {
    // Explicit preset still wins
    const rat = resolveCreatureTemplate('cave_rat', {
        loadPresetTemplate: (id) => presets.loadCreatureTemplateRaw(id)
    });
    assert.ok(rat);
    assert.strictEqual(rat.id, 'cave_rat');
    // Stats from legacy combat template via standard name map (source: pipeline)
    assert.strictEqual(rat.hp, 30);
    assert.strictEqual(rat.source, 'pipeline');

    const viaPresets = presets.loadCreatureTemplate('cave_rat');
    assert.strictEqual(viaPresets.hp, 30);

    // Catalog id with no preset file
    const priest = presets.loadCreatureTemplate('ashen_dwarf_priest');
    assert.strictEqual(priest.id, 'ashen_dwarf_priest');
    assert.ok(priest.hp > 0);
    assert.strictEqual(priest.source, 'catalog');

    assert.throws(() => presets.loadCreatureTemplate('definitely_missing_xyz_99'), /unknown/);
    log('resolve creature', { ratHp: rat.hp, priestHp: priest.hp });
}

function testEquipmentCategoryDefaults() {
    assert.ok(EQUIPMENT_CATEGORY_DEFAULTS.sword);
    const sword = fillEquipmentCombatDefaults({
        id: 'ancient_broadsword',
        category: 'sword',
        alias: 'Broadsword'
    });
    assert.strictEqual(sword.slot, 'rightHand');
    assert.strictEqual(sword.weaponType, 'melee');
    assert.ok(sword.atk > 0);
    assert.strictEqual(sword.label, 'Broadsword');

    const shield = fillEquipmentCombatDefaults({
        id: 'ancient_wall_shield',
        category: 'shield'
    });
    assert.strictEqual(shield.slot, 'leftHand');
    assert.ok(shield.defense > 0);

    const override = fillEquipmentCombatDefaults({
        id: 'custom',
        category: 'sword',
        combat: { atk: 99 }
    });
    assert.strictEqual(override.atk, 99);
    log('equipment defaults', { swordAtk: sword.atk, shieldDef: shield.defense });
}

function testBuildItemDb() {
    const db = presets.loadCombatItemDb({ genre: DEFAULT_GENRE });
    assert.ok(db.length > 20, 'merged db has preset + catalog items');

    const iron = db.find((i) => i.id === 'iron_longsword');
    assert.ok(iron, 'preset iron_longsword present');
    assert.strictEqual(iron.atk, 42);

    const broad = db.find((i) => i.id === 'ancient_broadsword');
    assert.ok(broad, 'catalog sword present');
    assert.ok(broad.atk > 0);
    assert.strictEqual(broad.slot, 'rightHand');

    // Rollup with catalog gear
    const rollup = rollupEquipment(
        {
            rightHand: 'ancient_broadsword',
            leftHand: 'ancient_wall_shield',
            armor: 'ancient_scale_mail'
        },
        db
    );
    assert.ok(rollup.atk > 0);
    assert.ok(rollup.armor > 0 || rollup.defense > 0);
    log('item db', { size: db.length, rollupAtk: rollup.atk, armor: rollup.armor });
}

function testWaypointPresets() {
    // Standard ships wp_test_1 (Designer pack). Corridor fixtures stay injected.
    const unitPreset = {
        id: 'unit_corridor',
        floor: 0,
        waypoints: [
            { x: 0, y: 3, z: 0 },
            { x: 5, y: 3, z: 0 },
            { x: 10, y: 3, z: 0 }
        ]
    };
    const expanded = resolveHuntWaypoints(
        { id: 't', waypointPreset: 'unit_corridor' },
        { loadWaypointPreset: (id) => {
            assert.strictEqual(id, 'unit_corridor');
            return unitPreset;
        } }
    );
    assert.ok(expanded.waypoints.length >= 3);
    assert.strictEqual(expanded.floor, 0);

    // Inline waypoints win over preset
    const inline = resolveHuntWaypoints({
        waypointPreset: 'unit_corridor',
        waypoints: [{ x: 1, y: 2, z: 0 }]
    }, { loadWaypointPreset: () => unitPreset });
    assert.strictEqual(inline.waypoints.length, 1);
    assert.strictEqual(inline.waypoints[0].x, 1);

    const norm = normalizeWaypoints([{ x: 1.6, y: 2.4 }], 9);
    assert.deepStrictEqual(norm[0], { x: 2, y: 2, z: 9 });

    const fromDisk = resolveHuntWaypoints({
        id: 'wp_test_1',
        floor: 6,
        waypointPreset: 'wp_test_1'
    });
    assert.strictEqual(fromDisk._waypointPresetId, 'wp_test_1');
    assert.strictEqual(fromDisk.waypoints.length, 2);
    assert.deepStrictEqual(fromDisk.waypoints[0], { x: 296, y: 910, z: 6 });
    log('waypoints', { count: unitPreset.waypoints.length, disk: fromDisk.waypoints.length });
}

function testHuntFromDataFiles() {
    const hunt = presets.loadHunt('cave_crawl_generated', { seed: 42 });
    assert.ok(hunt.waypoints && hunt.waypoints.length, 'generated waypoints present');
    assert.ok(hunt.spawns && hunt.spawns.length);
    for (let i = 0; i < hunt.spawns.length; i++) {
        assert.ok(hunt.spawns[i].creatureId, 'spawn has creatureId from data');
    }

    const catalogHunt = presets.loadHunt('catalog_crawl_generated', { seed: 7 });
    assert.strictEqual(catalogHunt.id, 'catalog_crawl_generated');
    assert.ok(catalogHunt.waypoints.length >= 1);
    const spawnIds = catalogHunt.spawns.map((s) => s.creatureId);
    assert.ok(
        spawnIds.indexOf('ashen_dwarf_priest') >= 0 ||
            spawnIds.indexOf('ashen_desert_dwarf_cultist') >= 0 ||
            spawnIds.indexOf('obsidian_dwarf_warden') >= 0,
        'catalog population yields catalog creature ids'
    );

    const resolved = resolveHuntConfig({ huntId: 'catalog_crawl_generated', seed: 7 });
    assert.strictEqual(resolved.huntId, 'catalog_crawl_generated');
    assert.ok(resolved.floors.length >= 1);
    assert.ok(resolved.spawns.every((s) => s.creatureId));
    // No cave_rat hard-code path: catalog hunt uses catalog ids only
    assert.ok(resolved.spawns.every((s) => s.creatureId !== 'cave_rat'));
    log('hunt data', { sampleWps: hunt.waypoints.length, catalogSpawns: spawnIds });
}

function testNoHardcodedMonstersInEngine() {
    const engineFiles = [
        path.join(ROOT, 'kernel/providers/simulator/headless_runner.js'),
        path.join(ROOT, 'kernel/providers/simulator/simulator.js'),
        path.join(ROOT, 'kernel/providers/simulator/default_waypoints.js')
    ];
    for (let i = 0; i < engineFiles.length; i++) {
        const text = fs.readFileSync(engineFiles[i], 'utf8');
        // Allow comments mentioning names; ban string literals used as spawn defaults
        assert.ok(
            !/creatureId:\s*['"]cave_rat['"]/.test(text),
            `${path.basename(engineFiles[i])} must not hard-code cave_rat spawns`
        );
        assert.ok(
            !/creatureId:\s*['"]dummy['"]/.test(text),
            `${path.basename(engineFiles[i])} must not hard-code dummy spawns`
        );
    }
    log('no hard-coded monster spawn literals in engine');
}

async function testMultiFloorLoad() {
    const mapPath = mapPathPng(7);
    assert.ok(fs.existsSync(mapPath), 'floor-07-path.png present');

    const sim = new Simulator({
        seed: 1,
        floors: [7, 8],
        mapPaths: {
            '7': mapPath,
            // same art under z=8 for API smoke (stairs deferred)
            '8': mapPath
        }
    });
    await sim.loadMaps();
    assert.ok(sim.tileMap);
    assert.ok(sim.tileMap.getLayer(7), 'layer 7 loaded');
    assert.ok(sim.tileMap.getLayer(8), 'layer 8 loaded');
    assert.ok(sim.tileMap.getLayer(7).cols > 0);
    assert.strictEqual(sim.floor, 7);
    const cols = sim.tileMap.getLayer(7).cols;
    sim.destroy();
    log('multi-floor', { cols, floors: [7, 8] });

    // Pure TileMap multi-layer without PNG for unit isolation
    const tm = new TileMap();
    const rgba = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
        rgba[i * 4] = 100;
        rgba[i * 4 + 1] = 100;
        rgba[i * 4 + 2] = 100;
        rgba[i * 4 + 3] = 255;
    }
    tm.loadFloorFromRgba(1, 4, 4, rgba);
    tm.loadFloorFromRgba(2, 4, 4, rgba);
    assert.ok(tm.getLayer(1));
    assert.ok(tm.getLayer(2));
    assert.ok(tm.isWalkable(1, 1, 1));
    assert.ok(tm.isWalkable(1, 1, 2));
}

async function testCatalogHeadlessHunt() {
    const summary = await runHeadlessHunt({
        seed: 42,
        huntId: 'catalog_crawl_generated',
        frames: 4000
    });
    assert.ok(summary);
    assert.ok(
        summary.endReason === 'route_complete' ||
            summary.endReason === 'party_wipe' ||
            summary.endReason === 'timeout' ||
            summary.endReason === 'kill_cap',
        `unexpected endReason ${summary.endReason}`
    );
    // Party with catalog gear should deal damage or finish route
    assert.ok(summary.tickCount > 0);
    log('catalog hunt', {
        endReason: summary.endReason,
        ticks: summary.tickCount,
        kills: summary.kills,
        damageDealt: summary.damageDealt
    });
}

async function testSampleHuntStillWorks() {
    const summary = await runHeadlessHunt({
        seed: 1,
        huntId: 'cave_crawl_generated',
        frames: 4000
    });
    assert.ok(summary.tickCount > 0);
    assert.ok(
        summary.endReason === 'route_complete' ||
            summary.endReason === 'party_wipe' ||
            summary.endReason === 'timeout' ||
            summary.endReason === 'kill_cap'
    );
    log('sample hunt', {
        endReason: summary.endReason,
        kills: summary.kills
    });
}

async function main() {
    testCreatureDefaults();
    testCreatureSpeedAbsolute();
    testCatalogCreatureTemplate();
    testResolveCreatureTemplate();
    testEquipmentCategoryDefaults();
    testBuildItemDb();
    testWaypointPresets();
    testHuntFromDataFiles();
    testNoHardcodedMonstersInEngine();
    await testMultiFloorLoad();
    await testSampleHuntStillWorks();
    await testCatalogHeadlessHunt();
    console.log('ok content_integration');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
