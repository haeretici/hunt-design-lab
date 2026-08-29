/**
 * Legacy port: converters + assets/legacy fixtures; optional presets/legacy pack.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { ROOT, PATHS, mapPathPng } = require('../kernel/settings.js');
const {
    slugifyMonsterName,
    absDamageRange,
    convertElementsToResists,
    convertMonsterToTemplate,
    convertAttack,
    convertCondition,
    convertDefenseSpell,
    convertBestiary,
    convertSummon,
    convertMonsterFlags,
    convertMonsterCrit,
    applyLegacyMonsterMetadata,
    convertSpawn,
    analyzeNavmesh,
    convertWaypointPresets,
    convertWikiEquipmentItem,
    convertEquipmentList,
    mergeWikiItemPair,
    mergeWikiItemCatalogs,
    parseSpeedBonus,
    parseDurationSec,
    parseSkillBonuses,
    parseResists
} = require('../kernel/core/lib/content/legacy_monster_port.js');
const {
    applyCondition,
    tickConditions,
    isInvisible,
    hasHaste
} = require('../kernel/core/lib/combat/conditions.js');
const {
    tryDefenseSpells,
    tryMonsterSummons,
    ensureCreatureKit,
    isSummon,
    normalizeSummonConfig
} = require('../kernel/core/lib/ai/creature_kit.js');
const { rollupEquipment } = require('../kernel/core/lib/character/stats.js');
const {
    loadFloorSpawns,
    filterFloorSpawns,
    filterSpawnList,
    toHuntSpawns,
    resolveSpawnSource,
    resolveHuntSpawnDefs,
    loadSpawnIndex,
    loadNavmeshAnalysis,
    legacyPath,
    parseSpawnRows,
    loadFloorSpawnsFromDocs,
    resolveCreatureSpawnId,
    makeEditorSpawnPin,
    DEFAULT_EDITOR_SPAWN_RESPAWN,
    parseSpawnFloorZ,
    planSpawnFloorMove,
    applySpawnFloorMove
} = require('../kernel/core/lib/content/legacy_assets.js');
const presets = require('../kernel/core/lib/presets.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { hasMode } = require('./helpers/modes.js');
const {
    normalizeCreatureKit,
    attackToSpell
} = require('../kernel/core/lib/ai/creature_kit.js');

function log(msg, extra) {
    if (extra !== undefined) console.log('  ✓', msg, extra);
    else console.log('  ✓', msg);
}

function testConverters() {
    assert.strictEqual(slugifyMonsterName('Cave Rat'), 'cave_rat');
    assert.strictEqual(slugifyMonsterName('a weak spot'), 'a_weak_spot');

    const dmg = absDamageRange({ minDamage: 0, maxDamage: -10 });
    assert.deepStrictEqual(dmg, { min: 0, max: 10 });

    const resists = convertElementsToResists({
        physical: 100,
        fire: 110,
        earth: 0,
        ice: 80
    });
    assert.strictEqual(resists.physical, 0);
    assert.strictEqual(resists.fire, -10);
    assert.strictEqual(resists.earth, 100);
    assert.strictEqual(resists.ice, 20);

    const atk = convertAttack(
        {
            name: 'melee',
            interval: 2000,
            chance: 100,
            minDamage: 0,
            maxDamage: -10
        },
        0
    );
    assert.ok(atk);
    assert.strictEqual(atk.kind, 'melee');
    assert.strictEqual(atk.min, 0);
    assert.strictEqual(atk.max, 10);
    assert.strictEqual(atk.intervalMs, 2000);

    const ranged = convertAttack(
        {
            name: 'combat',
            interval: 2000,
            chance: 20,
            type: 'fire',
            minDamage: -20,
            maxDamage: -40,
            range: 7,
            radius: 1,
            target: true
        },
        1
    );
    assert.ok(ranged);
    assert.strictEqual(ranged.kind, 'ranged');
    assert.strictEqual(ranged.element, 'fire');
    assert.strictEqual(ranged.max, 40);

    const mon = {
        name: 'cave rat',
        description: 'a cave rat',
        experience: 10,
        health: 30,
        maxHealth: 30,
        speed: 75,
        manaCost: 250,
        strategiesTarget: { nearest: 100 },
        flags: {
            hostile: true,
            attackable: true,
            summonable: true,
            pushable: true,
            canPushItems: false,
            canWalkOnFire: false,
            isBlockable: true,
            targetDistance: 1,
            runHealth: 3,
            staticAttackChance: 90
        },
        defenses: { armor: 1, mitigation: 0.1 },
        elements: { physical: 100, fire: 110, earth: 100 },
        attacks: [
            {
                name: 'melee',
                interval: 2000,
                chance: 100,
                minDamage: 0,
                maxDamage: -10
            }
        ],
        Bestiary: {
            class: 'Mammal',
            Stars: 1,
            toKill: 25,
            FirstUnlock: 5,
            SecondUnlock: 10,
            CharmsPoints: 1,
            Occurrence: 0,
            Locations: 'Rookgaard sewers.'
        },
        summon: {
            maxSummons: 2,
            summons: [
                { name: 'Bonebeast', chance: 10, interval: 2000, count: 2 }
            ]
        }
    };
    const nameMap = new Map([
        [
            'bonebeast',
            { standardName: 'Bone Beast', standardId: 'bone_beast' }
        ]
    ]);
    const t = convertMonsterToTemplate(mon, { nameMap });
    assert.strictEqual(t.id, 'cave_rat');
    assert.strictEqual(t.hp, 30);
    assert.strictEqual(t.source, 'legacy');
    assert.strictEqual(t.flags.runHealth, 3);
    assert.strictEqual(t.flags.summonable, true);
    assert.strictEqual(t.flags.pushable, true);
    assert.strictEqual(t.flags.canWalkOnFire, false);
    assert.strictEqual(t.canBlock, true);
    assert.strictEqual(t.manaCost, 250);
    assert.strictEqual(t.resists.fire, -10);
    assert.strictEqual(t.attacks.length, 1);
    assert.strictEqual(t.attacks[0].max, 10);
    assert.ok(t.bestiary);
    assert.strictEqual(t.bestiary.class, 'Mammal');
    assert.strictEqual(t.bestiary.stars, 1);
    assert.strictEqual(t.bestiary.toKill, 25);
    assert.strictEqual(t.bestiary.firstUnlock, 5);
    assert.strictEqual(t.bestiary.secondUnlock, 10);
    assert.strictEqual(t.bestiary.charmsPoints, 1);
    assert.strictEqual(t.bestiary.occurrence, 0);
    assert.strictEqual(t.bestiary.Locations, undefined);
    assert.strictEqual(t.bestiary.locations, undefined);
    assert.ok(t.summon);
    assert.strictEqual(t.summon.maxSummons, 2);
    assert.strictEqual(t.summon.summons[0].name, 'Bone Beast');
    assert.strictEqual(t.summon.summons[0].id, 'bone_beast');

    // Metadata-only patch preserves combat fields
    const existing = {
        id: 'cave_rat',
        label: 'Cave Rat',
        hp: 999,
        level: 42,
        canBlock: false,
        flags: { aggroRange: 9, loseTargetDistance: 15 },
        customSprite: 'keep_me'
    };
    applyLegacyMonsterMetadata(existing, mon, { nameMap });
    assert.strictEqual(existing.hp, 999);
    assert.strictEqual(existing.level, 42);
    assert.strictEqual(existing.customSprite, 'keep_me');
    assert.strictEqual(existing.canBlock, true);
    assert.strictEqual(existing.manaCost, 250);
    assert.strictEqual(existing.flags.aggroRange, 9);
    assert.strictEqual(existing.flags.summonable, true);
    assert.strictEqual(existing.bestiary.toKill, 25);
    assert.strictEqual(existing.summon.summons[0].id, 'bone_beast');

    const bOnly = convertBestiary({
        class: 'Undead',
        Stars: 3,
        Locations: 'somewhere'
    });
    assert.deepStrictEqual(bOnly, { class: 'Undead', stars: 3 });
    assert.strictEqual(convertBestiary(null), null);

    const flags = convertMonsterFlags({
        hostile: true,
        summonable: false,
        targetDistance: 4,
        runHealth: 10
    });
    assert.strictEqual(flags.hostile, true);
    assert.strictEqual(flags.summonable, false);
    assert.strictEqual(flags.targetDistance, 4);
    assert.strictEqual(flags.aggroRange, 7);
    assert.strictEqual(flags.critChance, undefined);

    const critBag = convertMonsterCrit({ critChance: 10, hostile: true });
    assert.deepStrictEqual(critBag, { critChance: 10, critDamage: 10 });
    assert.strictEqual(convertMonsterCrit({ hostile: true }), null);
    assert.strictEqual(convertMonsterCrit({ critChance: 0 }), null);

    const critTpl = convertMonsterToTemplate({
        name: 'Antenna',
        health: 10,
        flags: { hostile: true, attackable: true, critChance: 10 }
    });
    assert.strictEqual(critTpl.critChance, 10);
    assert.strictEqual(critTpl.critDamage, 10);
    assert.strictEqual(critTpl.flags.critChance, undefined);

    const noCritTpl = convertMonsterToTemplate({
        name: 'Cave Rat',
        health: 10,
        flags: { hostile: true }
    });
    assert.strictEqual(noCritTpl.critChance, undefined);
    assert.strictEqual(noCritTpl.critDamage, undefined);

    // Without nameMap: slug fallback kept (legacy pack path)
    const unmappedNoMap = convertSummon({
        maxSummons: 1,
        summons: [{ name: 'zamulosh2', chance: 5, interval: 2000, count: 1 }]
    });
    assert.ok(unmappedNoMap);
    assert.strictEqual(unmappedNoMap.summons[0].id, 'zamulosh2');

    // With nameMap: unmapped summon rows are dropped
    const emptyMap = new Map();
    assert.strictEqual(
        convertSummon(
            {
                maxSummons: 1,
                summons: [
                    { name: 'zamulosh2', chance: 5, interval: 2000, count: 1 }
                ]
            },
            emptyMap
        ),
        null
    );
    const partialMap = new Map([
        [
            'bonebeast',
            { standardName: 'Bone Beast', standardId: 'bone_beast' }
        ]
    ]);
    const filtered = convertSummon(
        {
            maxSummons: 3,
            summons: [
                { name: 'Bonebeast', chance: 10, interval: 2000, count: 2 },
                { name: 'zamulosh2', chance: 5, interval: 2000, count: 1 }
            ]
        },
        partialMap
    );
    assert.ok(filtered);
    assert.strictEqual(filtered.summons.length, 1);
    assert.strictEqual(filtered.summons[0].id, 'bone_beast');

    const kit = normalizeCreatureKit(t);
    assert.strictEqual(kit.attacks[0].max, 10);
    assert.strictEqual(kit.flags.runHealth, 3);

    // ── defense_spells + conditions ───────────────────────────────────
    const healSpell = convertDefenseSpell(
        {
            name: 'combat',
            interval: 2000,
            chance: 10,
            type: 'healing',
            minDamage: 50,
            maxDamage: 100,
            effect: 'me_magic_blue',
            target: false
        },
        0
    );
    assert.ok(healSpell);
    assert.strictEqual(healSpell.kind, 'heal');
    assert.strictEqual(healSpell.min, 50);
    assert.strictEqual(healSpell.max, 100);

    const hasteSpell = convertDefenseSpell(
        {
            name: 'speed',
            interval: 2000,
            chance: 15,
            speedChange: 300,
            duration: 5000,
            effect: 'me_magic_red',
            target: false
        },
        1
    );
    assert.ok(hasteSpell);
    assert.strictEqual(hasteSpell.kind, 'haste');
    assert.strictEqual(hasteSpell.speedChange, 300);
    assert.strictEqual(hasteSpell.durationSec, 5);

    const invisSpell = convertDefenseSpell(
        {
            name: 'invisible',
            interval: 2000,
            chance: 5,
            effect: 'me_magic_blue',
            duration: 2000
        },
        2
    );
    assert.ok(invisSpell);
    assert.strictEqual(invisSpell.kind, 'invisible');
    assert.strictEqual(invisSpell.durationSec, 2);

    // Outfit / summon skipped
    assert.strictEqual(
        convertDefenseSpell(
            { name: 'outfit', interval: 4000, chance: 10, duration: 5000 },
            3
        ),
        null
    );

    const slowAtk = convertAttack(
        {
            name: 'speed',
            interval: 2000,
            chance: 15,
            speedChange: -700,
            length: 5,
            duration: 15000,
            effect: 'me_smallplants',
            target: false
        },
        0
    );
    assert.ok(slowAtk);
    assert.strictEqual(slowAtk.kind, 'status');
    assert.ok(slowAtk.statusOnly);
    assert.strictEqual(slowAtk.condition.type, 'slow');
    assert.strictEqual(slowAtk.condition.speedChange, -700);
    assert.strictEqual(slowAtk.condition.durationSec, 15);

    const poisonMelee = convertAttack(
        {
            name: 'melee',
            interval: 2000,
            chance: 100,
            minDamage: 0,
            maxDamage: -20,
            condition: {
                type: 'CONDITION_POISON',
                totalDamage: 30,
                interval: 4000
            }
        },
        0
    );
    assert.ok(poisonMelee);
    assert.strictEqual(poisonMelee.max, 20);
    assert.ok(poisonMelee.condition);
    assert.strictEqual(poisonMelee.condition.type, 'poison');
    assert.strictEqual(poisonMelee.condition.totalDamage, 30);
    assert.strictEqual(poisonMelee.condition.intervalMs, 4000);

    // Pure name:"condition" — min/max are DoT pool, not hit damage (F-prep)
    const purePoison = convertAttack(
        {
            name: 'condition',
            type: 'CONDITION_POISON',
            interval: 2000,
            chance: 15,
            minDamage: -400,
            maxDamage: -640,
            range: 7,
            radius: 7,
            effect: 'me_hitbypoison',
            target: false
        },
        2
    );
    assert.ok(purePoison);
    assert.strictEqual(purePoison.kind, 'area');
    assert.ok(purePoison.statusOnly);
    assert.strictEqual(purePoison.min, 0);
    assert.strictEqual(purePoison.max, 0);
    assert.strictEqual(purePoison.condition.type, 'poison');
    assert.strictEqual(purePoison.condition.totalDamage, 640);
    assert.strictEqual(purePoison.condition.intervalMs, 2000);
    assert.strictEqual(purePoison.element, 'earth');

    const pureBleed = convertAttack(
        {
            name: 'condition',
            type: 'CONDITION_BLEEDING',
            interval: 2000,
            chance: 10,
            minDamage: -300,
            maxDamage: -400,
            radius: 3,
            target: false
        },
        3
    );
    assert.ok(pureBleed);
    assert.strictEqual(pureBleed.condition.type, 'bleed');
    assert.strictEqual(pureBleed.condition.totalDamage, 400);
    assert.strictEqual(pureBleed.element, 'physical');

    const pureEnergy = convertAttack(
        {
            name: 'condition',
            type: 'CONDITION_ENERGY',
            interval: 2000,
            chance: 20,
            minDamage: -300,
            maxDamage: -600,
            range: 6,
            radius: 4,
            target: true
        },
        1
    );
    assert.ok(pureEnergy);
    assert.strictEqual(pureEnergy.condition.type, 'energy');
    assert.strictEqual(pureEnergy.element, 'energy');

    const pureCurse = convertAttack(
        {
            name: 'condition',
            type: 'CONDITION_CURSED',
            interval: 3000,
            chance: 15,
            minDamage: -54,
            maxDamage: -54,
            range: 1,
            target: false
        },
        4
    );
    assert.ok(pureCurse);
    assert.strictEqual(pureCurse.condition.type, 'curse');
    assert.strictEqual(pureCurse.element, 'death');

    // Runtime applies new DoT kinds
    const dotDummy = {
        alive: true,
        speed: 100,
        baseSpeed: 100,
        conditions: [],
        hp: { current: 500, max: 500 },
        applyHpDelta(amount) {
            this.hp.current = Math.max(0, this.hp.current - amount);
        }
    };
    applyCondition(dotDummy, {
        type: 'bleed',
        totalDamage: 40,
        intervalMs: 1000
    });
    assert.strictEqual(dotDummy.conditions[0].kind, 'bleed');
    assert.strictEqual(dotDummy.conditions[0].element, 'physical');
    applyCondition(dotDummy, {
        type: 'energy',
        totalDamage: 20,
        intervalMs: 1000
    });
    assert.ok(dotDummy.conditions.some((c) => c.kind === 'energy'));
    applyCondition(dotDummy, {
        type: 'curse',
        totalDamage: 15,
        intervalMs: 1000
    });
    assert.ok(dotDummy.conditions.some((c) => c.kind === 'curse'));

    const monWithDef = {
        name: 'Water Elemental',
        health: 550,
        maxHealth: 550,
        experience: 450,
        speed: 100,
        defenses: { armor: 20, mitigation: 1 },
        elements: { physical: 100, fire: 0 },
        flags: { targetDistance: 1, staticAttackChance: 90 },
        attacks: [
            {
                name: 'melee',
                interval: 2000,
                chance: 100,
                minDamage: 0,
                maxDamage: -100
            }
        ],
        defense_spells: [
            {
                name: 'speed',
                interval: 2000,
                chance: 15,
                speedChange: 300,
                effect: 'me_magic_red',
                target: false,
                duration: 5000
            },
            {
                name: 'combat',
                interval: 2000,
                chance: 10,
                type: 'healing',
                minDamage: 50,
                maxDamage: 80,
                effect: 'me_magic_blue',
                target: false
            }
        ]
    };
    const tDef = convertMonsterToTemplate(monWithDef);
    assert.ok(tDef.defenseSpells);
    assert.strictEqual(tDef.defenseSpells.length, 2);
    assert.strictEqual(tDef.defenseSpells[0].kind, 'haste');
    assert.strictEqual(tDef.defenseSpells[1].kind, 'heal');

    const kitDef = normalizeCreatureKit(tDef);
    assert.strictEqual(kitDef.defenseSpells.length, 2);

    // Runtime: conditions DoT + haste
    const dummy = {
        alive: true,
        speed: 100,
        baseSpeed: 100,
        conditions: [],
        hp: { current: 100, max: 100 },
        applyHpDelta(amount, element) {
            if (element === 'healing') {
                this.hp.current = Math.min(
                    this.hp.max,
                    this.hp.current + amount
                );
            } else {
                this.hp.current = Math.max(0, this.hp.current - amount);
                if (this.hp.current <= 0) this.alive = false;
            }
        }
    };
    applyCondition(dummy, {
        type: 'poison',
        totalDamage: 30,
        intervalMs: 1000
    });
    assert.ok(dummy.conditions.length === 1);
    // Advance past first tick interval
    tickConditions(dummy, 1.0);
    assert.ok(dummy.hp.current < 100, 'poison should deal damage');

    applyCondition(dummy, {
        type: 'haste',
        speedChange: 50,
        durationSec: 5
    });
    assert.ok(hasHaste(dummy));
    assert.strictEqual(dummy.speed, 150);

    applyCondition(dummy, {
        type: 'invisible',
        durationSec: 2
    });
    assert.ok(isInvisible(dummy));

    // Runtime defense heal
    const healer = {
        alive: true,
        speed: 100,
        baseSpeed: 100,
        conditions: [],
        hp: { current: 40, max: 100 },
        attacks: [],
        defenseSpells: [
            {
                id: 'heal_0',
                kind: 'heal',
                intervalMs: 100,
                chance: 100,
                min: 20,
                max: 20,
                hpBelow: 0.7
            }
        ]
    };
    ensureCreatureKit(healer);
    const defRes = tryDefenseSpells(healer, { rng: () => 0 });
    assert.ok(defRes.fired, 'heal should fire under threshold');
    assert.strictEqual(defRes.kind, 'heal');
    assert.ok(healer.hp.current > 40);

    // Runtime: monster auto-summon (kit + mock spawn)
    const summonCfg = normalizeSummonConfig({
        maxSummons: 3,
        summons: [
            {
                name: 'Slime',
                id: 'slime',
                chance: 100,
                interval: 2000,
                count: 3
            }
        ]
    });
    assert.ok(summonCfg);
    assert.strictEqual(summonCfg.maxSummons, 3);
    assert.strictEqual(summonCfg.summons[0].intervalSec, 2);
    assert.strictEqual(summonCfg.summons[0].id, 'slime');

    const master = {
        id: 10,
        alive: true,
        type: 'creature',
        creatureType: 'slime',
        name: 'Slime',
        inBattle: true,
        tile: { x: 5, y: 5, z: 0 },
        hp: { current: 100, max: 100 },
        attacks: [],
        summon: {
            maxSummons: 2,
            summons: [
                {
                    name: 'Slime',
                    id: 'slime',
                    chance: 100,
                    interval: 100,
                    count: 2
                }
            ]
        },
        summonIds: []
    };
    ensureCreatureKit(master);
    assert.ok(master.kit.summon);
    assert.strictEqual(master.kit.summon.maxSummons, 2);

    /** @type {object[]} */
    const spawned = [];
    let nextId = 100;
    const entities = new Map([[master.id, master]]);
    const mockSim = {
        entityById: entities,
        getEntityById(id) {
            return entities.get(id) || null;
        },
        spawnSummon(opts) {
            const s = {
                id: nextId++,
                alive: true,
                type: 'creature',
                creatureType: opts.creatureId,
                name: 'Slime',
                masterId: master.id,
                hp: { current: 50, max: 50 },
                tile: { x: 6, y: 5, z: 0 }
            };
            entities.set(s.id, s);
            master.summonIds.push(s.id);
            spawned.push(s);
            return s;
        }
    };
    const player = {
        id: 1,
        alive: true,
        type: 'player',
        hp: { current: 100, max: 100 },
        tile: { x: 6, y: 5, z: 0 }
    };
    const sumRes = tryMonsterSummons(master, { sim: mockSim, rng: () => 0 }, player);
    assert.ok(sumRes.fired, 'summon should fire when engaged + chance 100');
    assert.strictEqual(sumRes.summonId, 'slime');
    assert.strictEqual(spawned.length, 1);
    assert.ok(isSummon(spawned[0]));
    assert.strictEqual(master.summonIds.length, 1);

    // Second tick: interval not ready yet (100ms window just opened)
    const sumRes2 = tryMonsterSummons(master, { sim: mockSim, rng: () => 0 }, player);
    assert.strictEqual(sumRes2.fired, false, 'interval gate should block immediate re-summon');

    // Feature off
    const sumOff = tryMonsterSummons(
        master,
        { sim: mockSim, rng: () => 0, monsterSummons: false },
        player
    );
    assert.strictEqual(sumOff.fired, false);

    // Nested summons blocked
    master._summonReadyIn[0] = 0;
    const nestedMaster = spawned[0];
    nestedMaster.summon = master.summon;
    nestedMaster.summonIds = [];
    nestedMaster.inBattle = true;
    ensureCreatureKit(nestedMaster);
    nestedMaster._summonReadyIn = [0];
    const nested = tryMonsterSummons(
        nestedMaster,
        { sim: mockSim, rng: () => 0 },
        player
    );
    assert.strictEqual(nested.fired, false, 'summons must not nest');

    // Cap maxSummons: force ready and fill
    master._summonReadyIn[0] = 0;
    tryMonsterSummons(master, { sim: mockSim, rng: () => 0 }, player);
    assert.strictEqual(master.summonIds.length, 2, 'should reach maxSummons 2');
    master._summonReadyIn[0] = 0;
    const capped = tryMonsterSummons(master, { sim: mockSim, rng: () => 0 }, player);
    assert.strictEqual(capped.fired, false, 'maxSummons cap');

    const spawn = convertSpawn({
        x: 10,
        y: 20,
        z: '07',
        name: 'Cave Rat',
        spawntime: 90
    });
    assert.strictEqual(spawn.creatureId, 'cave_rat');
    assert.strictEqual(spawn.z, 7);
    assert.strictEqual(spawn.respawn, 90);

    const analysis = analyzeNavmesh({
        points: [
            { x: 1, y: 1, z: '00', properties: { icon: 'down' } },
            { x: 1, y: 1, z: '01', properties: { icon: 'up' } },
            { x: 2, y: 2, z: '01', properties: {} }
        ],
        connections: [
            [0, 1],
            [1, 2]
        ]
    });
    assert.strictEqual(analysis.crossFloorEdges, 1);
    assert.strictEqual(analysis.icons.down, 1);
    assert.strictEqual(analysis.icons.up, 1);

    const wps = convertWaypointPresets({
        'Test Route': [
            { x: 1, y: 2, z: '07' },
            { x: 3, y: 4, z: '07' }
        ]
    });
    assert.strictEqual(wps.length, 1);
    assert.strictEqual(wps[0].id, 'test_route');
    assert.strictEqual(wps[0].waypoints.length, 2);

    log('pure converters');
}

/**
 * Phase 1: wiki v1/v2 equipment merge + normalized combat fields.
 */
function testEquipmentConverters() {
    assert.strictEqual(parseSpeedBonus('speed +30', {}), 30);
    assert.strictEqual(parseSpeedBonus('', { speed: '20' }), 20);
    assert.strictEqual(parseSpeedBonus('speed +5', { speed: '20' }), 20, 'data.speed wins');

    assert.strictEqual(parseDurationSec({ duration: '10 minutes' }, {}), 600);
    assert.strictEqual(parseDurationSec({ duration: '7.5 minutes' }, {}), 450);
    assert.strictEqual(parseDurationSec({ duration: '2 hours' }, {}), 7200);
    assert.strictEqual(parseDurationSec({}, { duration: '600' }), 600);

    const skills = parseSkillBonuses('axe fighting +4, magic level +2');
    assert.strictEqual(skills.axe, 4);
    assert.strictEqual(skills.magic, 2);

    const resists = parseResists('physical +20%, fire +20%, earth +10%');
    assert.strictEqual(resists.physical, 20);
    assert.strictEqual(resists.fire, 20);
    assert.strictEqual(resists.earth, 10);

    // Time Ring: speed + duration only in attributes/data (classic bug case)
    const timeRing = convertWikiEquipmentItem({
        name: 'Time Ring',
        type: ['ring'],
        weight: 0.9,
        attributes: 'speed +30',
        duration: '10 minutes',
        data: {
            primarytype: 'rings',
            speed: '30',
            duration: '600',
            weight: '90',
            transformdeequipto: '3053'
        }
    });
    assert.strictEqual(timeRing.id, 'time_ring');
    assert.strictEqual(timeRing.speed, 30);
    assert.strictEqual(timeRing.durationSec, 600);
    assert.strictEqual(timeRing.slot, 'ring');
    assert.strictEqual(timeRing.weight, 90);
    assert.ok(!timeRing.data, 'raw data blob dropped');
    assert.ok(!timeRing.attributes, 'raw attributes string dropped');

    // Might Ring: absorbs → resists, charges
    const might = convertWikiEquipmentItem({
        name: 'Might Ring',
        type: ['ring'],
        weight: 1,
        charges: 20,
        resists:
            'physical +20%, fire +20%, earth +20%, energy +20%, ice +20%, holy +20%, death +20%',
        data: {
            absorbpercentphysical: '20',
            absorbpercentfire: '20',
            absorbpercentpoison: '20',
            absorbpercentenergy: '20',
            absorbpercentice: '20',
            absorbpercentholy: '20',
            absorbpercentdeath: '20',
            charges: '20',
            weight: '100'
        }
    });
    assert.strictEqual(might.charges, 20);
    assert.strictEqual(might.resists.physical, 20);
    assert.strictEqual(might.resists.earth, 20, 'poison absorb → earth');
    assert.strictEqual(might.resists.death, 20);

    // Boots of Haste
    const boh = convertWikiEquipmentItem({
        name: 'Boots of Haste',
        type: ['boots'],
        weight: 7.5,
        attributes: 'speed +20',
        data: { speed: '20', weight: '750', imbuementslot: '1' }
    });
    assert.strictEqual(boh.speed, 20);
    assert.strictEqual(boh.imbuementSlots, 1);

    // Energy Ring → mana shield flag
    const energy = convertWikiEquipmentItem({
        name: 'Energy Ring',
        type: ['ring'],
        weight: 0.8,
        attributes: 'magic shield',
        duration: '10 minutes',
        data: { manashield: '1', duration: '600', weight: '80' }
    });
    assert.ok(energy.flags && energy.flags.manaShield);
    assert.strictEqual(energy.durationSec, 600);

    // Life Ring → regen
    const life = convertWikiEquipmentItem({
        name: 'Life Ring',
        type: ['ring'],
        weight: 0.8,
        attributes: 'faster regeneration',
        duration: '20 minutes',
        data: {
            healthgain: '2',
            healthticks: '6000',
            managain: '8',
            manaticks: '6000',
            duration: '1200',
            weight: '80'
        }
    });
    assert.strictEqual(life.durationSec, 1200);
    assert.strictEqual(life.regen.hp, 2);
    assert.strictEqual(life.regen.mp, 8);
    assert.strictEqual(life.regen.hpTicksMs, 6000);

    // Split elemental weapon (Cobra Axe shape)
    const cobra = convertWikiEquipmentItem({
        name: 'Cobra Axe',
        type: ['axe'],
        weight: 40,
        attack: 8,
        'ice attack': 44,
        defense: 29,
        'defense modifier': '+2',
        attributes: 'axe fighting +2',
        data: {
            elementice: '44',
            skillaxe: '2',
            attack: '8',
            extradef: '2',
            defense: '29',
            weight: '4000'
        }
    });
    assert.strictEqual(cobra.atk, 8);
    assert.strictEqual(cobra.extraAtk, 44);
    assert.strictEqual(cobra.extraAtkElement, 'ice');
    assert.strictEqual(cobra.defenseBonus, 2);
    assert.strictEqual(cobra.skillBonuses.axe, 2);

    // data.skill* wins over attributes string when both present
    const power = convertWikiEquipmentItem({
        name: 'Power Ring',
        type: ['ring'],
        weight: 0.8,
        attributes: 'fist fighting +4',
        duration: '30 minutes',
        data: { skillfist: '6', duration: '1800', weight: '80' }
    });
    assert.strictEqual(power.skillBonuses.fist, 6, 'data.skillfist overrides attributes');

    // Merge: v1 without data + v2 with data
    const merged = mergeWikiItemPair(
        { name: 'Time Ring', type: ['ring'], weight: 0.9, attributes: 'speed +30' },
        {
            name: 'Time Ring',
            type: ['ring'],
            weight: 0.9,
            data: { speed: '30', duration: '600', weight: '90' }
        }
    );
    assert.strictEqual(merged.data.speed, '30');
    assert.strictEqual(merged.attributes, 'speed +30');

    const catalog = mergeWikiItemCatalogs(
        [{ name: 'Only V1', type: ['ring'], weight: 1 }],
        [
            { name: 'Only V2', type: ['shield'], weight: 2, data: { defense: '10' } },
            {
                name: 'Only V1',
                type: ['ring'],
                weight: 1,
                data: { speed: '5' }
            }
        ]
    );
    assert.strictEqual(catalog.length, 2);
    const onlyV1 = catalog.find((i) => i.name === 'Only V1');
    assert.ok(onlyV1.data && onlyV1.data.speed === '5');

    // Full catalog convert from on-disk sources when present
    const itemsPath = path.join(ROOT, 'legacy', 'source', 'items.json');
    const itemsV2Path = path.join(ROOT, 'legacy', 'source', 'items-v2.json');
    if (fs.existsSync(itemsPath) && fs.existsSync(itemsV2Path)) {
        const v1 = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
        const v2 = JSON.parse(fs.readFileSync(itemsV2Path, 'utf8'));
        const list = convertEquipmentList(v1, v2);
        assert.ok(list.length >= 1500, `expected large catalog, got ${list.length}`);
        const byId = Object.create(null);
        for (const it of list) byId[it.id] = it;

        assert.strictEqual(byId.time_ring.speed, 30);
        assert.strictEqual(byId.time_ring.durationSec, 600);
        assert.strictEqual(byId.boots_of_swiftness.speed, 20);
        assert.ok(byId.power_band.resists && byId.power_band.resists.fire === 20);
        assert.ok(!byId.time_ring.data && !byId.time_ring.attributes);

        const gear = rollupEquipment({ ring: 'time_ring', boots: 'boots_of_swiftness' }, list);
        assert.strictEqual(gear.speed, 50, 'time ring + boots of swiftness speed stack in rollup');

        // Phase 4: defenseBonus (extradef) only with shield; regen / manaShield surface
        const { getTotalDefense } = require('../kernel/core/lib/character/stats.js');
        if (byId.cobra_axe) {
            assert.strictEqual(byId.cobra_axe.defenseBonus, 2);
            const shieldDb = list.concat([
                {
                    id: '_test_shield',
                    slot: 'leftHand',
                    category: 'shield',
                    defense: 20
                }
            ]);
            const withDef = rollupEquipment(
                { rightHand: 'cobra_axe', leftHand: '_test_shield' },
                shieldDb
            );
            assert.strictEqual(withDef.defenseBonus, 2);
            assert.strictEqual(getTotalDefense(withDef), 22, '20 shield + 2 cobra extradef');
        }
        if (byId.vitality_ring && byId.vitality_ring.regen) {
            const lifeGear = rollupEquipment({ ring: 'vitality_ring' }, list);
            assert.strictEqual(lifeGear.regen.hp, byId.vitality_ring.regen.hp);
            assert.strictEqual(lifeGear.regen.mp, byId.vitality_ring.regen.mp);
        }
        if (byId.voltaic_ring && byId.voltaic_ring.flags && byId.voltaic_ring.flags.manaShield) {
            const energyGear = rollupEquipment({ ring: 'voltaic_ring' }, list);
            assert.strictEqual(energyGear.flags.manaShield, true);
        }

        log('equipment converters (on-disk catalog)', {
            items: list.length,
            withSpeed: list.filter((i) => i.speed != null).length,
            withDurationSec: list.filter((i) => i.durationSec != null).length,
            withDefenseBonus: list.filter((i) => i.defenseBonus != null).length
        });
    } else {
        log('equipment converters (fixtures only; wiki JSON missing)');
    }

    log('equipment converters');
}

function testOnDisk() {
    const map07 = mapPathPng(7);
    assert.ok(fs.existsSync(map07), `expected map at ${map07}`);
    assert.ok(
        map07.includes(path.join('assets', 'legacy', 'map')),
        'mapPathPng points at assets/legacy/map'
    );

    // floors 0–15 expected after full port
    let pathPngs = 0;
    for (let z = 0; z <= 15; z++) {
        if (fs.existsSync(mapPathPng(z))) pathPngs++;
    }
    assert.ok(pathPngs >= 1, 'at least floor-07 path png');
    log('map path PNGs', { count: pathPngs, sample: path.relative(ROOT, map07) });

    setActiveMode('standard');
    const cave = presets.loadCreatureTemplate('cave_rat');
    assert.strictEqual(cave.id, 'cave_rat');
    assert.ok(cave.attacks && cave.attacks.length >= 1);
    assert.ok(cave.attacks[0].max > 0, 'positive damage after port');
    log('cave_rat preset', { hp: cave.hp, maxDmg: cave.attacks[0].max });

    const dummy = presets.loadCreatureTemplate('dummy');
    assert.ok(dummy.hp >= 500, 'hand-authored dummy preserved');

    const idx = loadSpawnIndex();
    assert.ok(idx && idx.total > 0, 'spawn index');
    const f7 = loadFloorSpawns(7);
    assert.ok(f7.length > 0, 'floor 07 spawns');
    const hybrid07 = JSON.parse(
        fs.readFileSync(
            legacyPath('map', 'hybrid', 'floor-07', 'map.json'),
            'utf8'
        )
    );
    assert.ok(Array.isArray(hybrid07.spawns) && hybrid07.spawns.length > 0);
    assert.strictEqual(
        f7.length,
        hybrid07.spawns.length,
        'floor 07 load uses hybrid map.json pins'
    );
    assert.deepStrictEqual(f7[0], hybrid07.spawns[0]);

    const f0 = loadFloorSpawns(0);
    assert.ok(f0.length > 0, 'floor 00 falls back to by_floor');
    assert.ok(
        !fs.existsSync(legacyPath('map', 'hybrid', 'floor-00', 'map.json')),
        'floor 00 has no hybrid pack'
    );
    const rats = filterFloorSpawns(7, { creatureId: 'cave_rat', limit: 5 });
    assert.ok(rats.length >= 1, 'cave_rat spawns on floor 07');
    const huntRows = toHuntSpawns(rats, { respawn: 0 });
    assert.strictEqual(huntRows[0].creatureId, 'cave_rat');
    assert.strictEqual(huntRows[0].respawn, 0, 'respawn override');

    // keep row respawn when no override
    const withRow = toHuntSpawns([{ creatureId: 'a', x: 1, y: 2, z: 7, respawn: 90 }]);
    assert.strictEqual(withRow[0].respawn, 90);

    // filterSpawnList pure (browser path)
    const pure = filterSpawnList(f7, { creatureId: 'cave_rat', limit: 3 });
    assert.ok(pure.length <= 3);
    assert.ok(pure.every((s) => s.creatureId === 'cave_rat'));

    // spawnSource.legacy_floor → defs only
    // Real cave_rat dens sit around x~400–540, y~800–900 (not the hand y=96 corridor)
    const resolved = resolveSpawnSource(
        {
            type: 'legacy_floor',
            floors: [7],
            creatureId: 'cave_rat',
            xMin: 0,
            xMax: 40000,
            yMin: 0,
            yMax: 40000,
            limit: 10,
            respawn: 60,
            spawnMode: 'on_demand'
        },
        { floor: 7 }
    );
    assert.strictEqual(resolved.meta.type, 'legacy_floor');
    assert.ok(resolved.spawns.length >= 1, 'legacy_floor yields defs');
    assert.ok(resolved.spawns.length <= 10);
    assert.strictEqual(resolved.spawns[0].creatureId, 'cave_rat');
    assert.strictEqual(resolved.spawns[0].respawn, 60);
    assert.strictEqual(resolved.spawnMode, 'on_demand');
    assert.ok(resolved.meta.creatureIds.indexOf('cave_rat') >= 0);
    // no live instances — plain JSON rows only
    assert.strictEqual(resolved.spawns[0].alive, undefined);
    assert.strictEqual(resolved.spawns[0].hp, undefined);

    const huntExpanded = resolveHuntSpawnDefs({
        floor: 7,
        floors: [7],
        spawnSource: {
            type: 'legacy_floor',
            floors: [7],
            creatureId: 'cave_rat',
            limit: 4
        }
    });
    assert.ok(Array.isArray(huntExpanded.spawns));
    assert.strictEqual(huntExpanded.spawns.length, 4);
    assert.ok(huntExpanded.spawnSourceSpec);
    assert.strictEqual(huntExpanded.spawnSource, undefined);

    // Expand path still resolves spawnSource without a dual-maintained dens hunt fixture.
    setActiveMode(hasMode('legacy') ? 'legacy' : 'standard');
    const expandedInline = presets.expandHuntDefinition(
        {
            id: 'spawn_source_unit',
            floor: 7,
            floors: [7],
            spawnMode: 'on_demand',
            spawnSource: {
                type: 'legacy_floor',
                floors: [7],
                creatureId: 'cave_rat',
                xMin: 0,
                xMax: 40000,
                yMin: 0,
                yMax: 40000,
                limit: 12,
                respawn: 60
            },
            waypoints: [
                { x: 420, y: 845, z: 7 },
                { x: 450, y: 845, z: 7 }
            ],
            parties: []
        },
        { seed: 7 }
    );
    assert.ok(
        expandedInline.spawns && expandedInline.spawns.length >= 1,
        'inline dens spawnSource expands to defs'
    );
    assert.ok(expandedInline.spawns.length <= 12);
    assert.strictEqual(expandedInline.spawnMode, 'on_demand');
    assert.ok(expandedInline.spawns.every((s) => s.creatureId === 'cave_rat'));
    assert.ok(expandedInline.spawnSourceSpec);
    assert.strictEqual(expandedInline.spawnSource, undefined);

    // Play/CI path is generator-owned after dens fixture retirement.
    const generated = presets.loadHunt('cave_crawl_generated');
    assert.ok(generated.layout && generated.layout.type === 'procedural');
    assert.ok(!generated.spawnSource, 'generated hunt has no bulk dens source');
    setActiveMode('standard');

    log('spawns', {
        total: idx.total,
        floor07: f7.length,
        sampleRats: rats.length,
        sourceDefs: resolved.spawns.length,
        inlineDens: expandedInline.spawns.length
    });

    const navAnalysis = loadNavmeshAnalysis();
    assert.ok(navAnalysis, 'navmesh analysis.json');
    // Synthetic OSS reference graph (not a full-world dump)
    assert.ok(navAnalysis.pointCount >= 5, 'reference navmesh has points');
    assert.ok(navAnalysis.pointCount < 500, 'reference navmesh stays small');
    assert.ok(navAnalysis.crossFloorEdges > 0, 'cross-floor edges (stairs/teleports)');
    assert.ok(navAnalysis.icons && navAnalysis.icons.down > 0);
    log('navmesh analysis', {
        points: navAnalysis.pointCount,
        edges: navAnalysis.connectionCount,
        crossFloor: navAnalysis.crossFloorEdges
    });

    const merged = path.join(PATHS.navmesh, 'merged.json');
    assert.ok(fs.existsSync(merged), 'merged navmesh');
    const corridor = path.join(PATHS.navmesh, 'floor07_corridor.json');
    assert.ok(fs.existsSync(corridor), 'floor07_corridor sample');
    log('legacy assets layout ok');
}

/**
 * Code check: dragon lord attacks/stats match monsters.json and expose wave shape.
 */
function testDragonLordEquivalency() {
    const monstersPath = path.join(
        ROOT,
        'legacy',
        'source',
        'assets',
        'monsters.json'
    );
    if (!fs.existsSync(monstersPath)) {
        log('skip dragon lord equivalency (no legacy monsters.json)');
        return;
    }
    const bag = JSON.parse(fs.readFileSync(monstersPath, 'utf8'));
    const list = Array.isArray(bag) ? bag : Object.values(bag);
    const raw = list.find(
        (m) => m && String(m.name || '').toLowerCase() === 'dragon lord'
    );
    assert.ok(raw, 'dragon lord in monsters.json');

    const converted = convertMonsterToTemplate(raw);
    assert.strictEqual(converted.id, 'dragon_lord');
    assert.strictEqual(converted.hp, raw.health);
    assert.strictEqual(converted.exp, raw.experience);
    assert.strictEqual(converted.speed, raw.speed);
    assert.strictEqual(converted.armor, raw.defenses.armor);
    assert.strictEqual(converted.mitigation, raw.defenses.mitigation);
    assert.strictEqual(converted.resists.fire, 100, 'fire immune');
    assert.strictEqual(converted.resists.ice, -10, 'ice weak');
    assert.strictEqual(converted.flags.runHealth, raw.flags.runHealth);
    assert.strictEqual(
        converted.flags.staticAttackChance,
        raw.flags.staticAttackChance
    );

    assert.strictEqual(converted.attacks.length, raw.attacks.length);
    const wave = converted.attacks.find((a) => a.kind === 'wave');
    assert.ok(wave, 'wave breath ported');
    assert.strictEqual(wave.length, 8);
    assert.strictEqual(wave.spread, 3);
    assert.strictEqual(wave.element, 'fire');
    assert.strictEqual(wave.min, 150);
    assert.strictEqual(wave.max, 270);
    assert.strictEqual(wave.target, false);
    assert.strictEqual(wave.chance, 22);

    const area = converted.attacks.find((a) => a.kind === 'area' && a.max > 0);
    assert.ok(area, 'fire ball area ported');
    assert.strictEqual(area.radius, 4);
    assert.strictEqual(area.range, 7);

    // On-disk preset (if historical pack installed) must stay equivalent
    if (hasMode('legacy')) {
        setActiveMode('legacy');
        const disk = presets.loadCreatureTemplate('dragon_lord');
        assert.strictEqual(disk.hp, raw.health);
        assert.ok(disk.attacks.some((a) => a.kind === 'wave' && a.length === 8));

        const kit = normalizeCreatureKit(disk);
        const kitWave = kit.attacks.find((a) => a.kind === 'wave');
        assert.ok(kitWave);
        const spell = attackToSpell(kitWave);
        assert.ok(spell.shape && spell.shape.type === 'wave');
        assert.strictEqual(spell.shape.length, 8);
        assert.strictEqual(spell.shape.spread, 3);
        setActiveMode('standard');
    } else {
        // Converter path alone is enough when pack is absent
        const kit = normalizeCreatureKit(converted);
        const kitWave = kit.attacks.find((a) => a.kind === 'wave');
        assert.ok(kitWave);
        const spell = attackToSpell(kitWave);
        assert.ok(spell.shape && spell.shape.type === 'wave');
    }

    log('dragon lord equivalency', {
        hp: converted.hp,
        attacks: converted.attacks.map((a) => a.kind).join(','),
        wave: `${wave.min}-${wave.max} L${wave.length}S${wave.spread}`
    });
}

function testSpawnPinHelpers() {
    const presets = {
        frost_imp: { id: 'frost_imp', label: 'Frost Imp' },
        town_guide: { id: 'town_guide', label: 'Guide' }
    };
    assert.strictEqual(resolveCreatureSpawnId('frost_imp', presets), 'frost_imp');
    assert.strictEqual(resolveCreatureSpawnId('frost imp', presets), 'frost_imp');
    assert.strictEqual(resolveCreatureSpawnId('Frost Imp', presets), 'frost_imp');
    assert.strictEqual(resolveCreatureSpawnId('Guide', presets), 'town_guide');
    assert.strictEqual(resolveCreatureSpawnId('cave rat', {}), 'cave_rat');

    const pin = makeEditorSpawnPin(
        { creatureId: 'frost imp', x: 10.4, y: 20.6 },
        presets,
        { z: 7 }
    );
    assert.deepStrictEqual(pin, {
        creatureId: 'frost_imp',
        x: 10,
        y: 21,
        z: 7,
        respawn: DEFAULT_EDITOR_SPAWN_RESPAWN
    });
    const oneShot = makeEditorSpawnPin(
        { creatureId: 'cave_rat', x: 1, y: 2, z: 7, respawn: 0 },
        presets
    );
    assert.strictEqual(oneShot.respawn, 0);
    assert.strictEqual(makeEditorSpawnPin({ creatureId: 'x' }, presets), null);

    const hybridWins = loadFloorSpawnsFromDocs(
        { spawns: [{ creatureId: 'from_hybrid', x: 1, y: 1, z: 7, respawn: 60 }] },
        { spawns: [{ creatureId: 'from_by_floor', x: 2, y: 2, z: 7, respawn: 60 }] }
    );
    assert.strictEqual(hybridWins[0].creatureId, 'from_hybrid');
    const emptyHybrid = loadFloorSpawnsFromDocs({ version: 2, spawns: [] }, {
        spawns: [{ creatureId: 'ignored', x: 0, y: 0, z: 0, respawn: 0 }]
    });
    assert.strictEqual(emptyHybrid.length, 0);
    const fallback = loadFloorSpawnsFromDocs(null, {
        floor: 0,
        count: 1,
        spawns: [{ creatureId: 'by_floor', x: 3, y: 4, z: 0, respawn: 90 }]
    });
    assert.strictEqual(fallback[0].creatureId, 'by_floor');
    assert.deepStrictEqual(parseSpawnRows({ spawns: fallback }), fallback);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-hybrid-first-'));
    try {
        const hybridDir = path.join(tmp, 'map', 'hybrid', 'floor-03');
        const byDir = path.join(tmp, 'spawns', 'by_floor');
        fs.mkdirSync(hybridDir, { recursive: true });
        fs.mkdirSync(byDir, { recursive: true });
        fs.writeFileSync(
            path.join(hybridDir, 'map.json'),
            JSON.stringify({
                version: 2,
                id: 'floor_03',
                floors: [],
                spawns: [
                    { creatureId: 'hybrid_pin', x: 8, y: 9, z: 3, respawn: 60 }
                ]
            })
        );
        fs.writeFileSync(
            path.join(byDir, '03.json'),
            JSON.stringify({
                floor: 3,
                count: 1,
                spawns: [
                    { creatureId: 'stale_by_floor', x: 1, y: 1, z: 3, respawn: 1 }
                ]
            })
        );
        fs.writeFileSync(
            path.join(byDir, '04.json'),
            JSON.stringify({
                floor: 4,
                count: 1,
                spawns: [
                    { creatureId: 'only_by_floor', x: 5, y: 6, z: 4, respawn: 30 }
                ]
            })
        );
        const fromHybrid = loadFloorSpawns(3, { legacyRoot: tmp });
        assert.strictEqual(fromHybrid.length, 1);
        assert.strictEqual(fromHybrid[0].creatureId, 'hybrid_pin');
        const fromBy = loadFloorSpawns(4, { legacyRoot: tmp });
        assert.strictEqual(fromBy[0].creatureId, 'only_by_floor');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    assert.strictEqual(parseSpawnFloorZ('07'), 7);
    assert.strictEqual(parseSpawnFloorZ(16), null);
    assert.strictEqual(planSpawnFloorMove(7, 7).reason, 'same');
    assert.strictEqual(planSpawnFloorMove(7, 99).reason, 'invalid');
    const movePlan = planSpawnFloorMove('07', 6);
    assert.strictEqual(movePlan.ok, true);
    assert.strictEqual(movePlan.fromZ, 7);
    assert.strictEqual(movePlan.toZ, 6);
    const pinA = { creatureId: 'frost_imp', x: 10, y: 20, z: 7, respawn: 60 };
    const pinB = { creatureId: 'rat', x: 1, y: 2, z: 7, respawn: 30 };
    const dest = [{ creatureId: 'bat', x: 3, y: 4, z: 6, respawn: 60 }];
    const moved = applySpawnFloorMove([pinA, pinB], dest, pinA, 6);
    assert.strictEqual(moved.fromList.length, 1);
    assert.strictEqual(moved.fromList[0], pinB);
    assert.strictEqual(moved.destList.length, 2);
    assert.strictEqual(moved.moved.z, 6);
    assert.strictEqual(moved.moved.creatureId, 'frost_imp');
    assert.strictEqual(dest.length, 1, 'applySpawnFloorMove must not mutate dest');
    assert.strictEqual(applySpawnFloorMove([pinB], dest, pinA, 6), null);
    log('spawn pin helpers + hybrid-first load');
}

function testLegacyEquipmentPreset() {
    if (!hasMode('legacy')) {
        log('skip legacy equipment preset (presets/legacy not installed)');
        return;
    }
    const equipPath = path.join(ROOT, 'presets', 'legacy', 'equipment.json');
    assert.ok(fs.existsSync(equipPath), 'presets/legacy/equipment.json present');
    const doc = JSON.parse(fs.readFileSync(equipPath, 'utf8'));
    const items = doc.items || doc;
    assert.ok(Array.isArray(items) && items.length >= 1500, 'legacy equipment catalog size');
    const byId = Object.create(null);
    for (const it of items) {
        if (it && it.id) byId[it.id] = it;
    }
    assert.ok(byId.time_ring, 'time_ring present');
    assert.strictEqual(byId.time_ring.speed, 30, 'time_ring speed promoted');
    assert.strictEqual(byId.time_ring.durationSec, 600, 'time_ring durationSec');
    assert.ok(!byId.time_ring.data, 'no raw data blob on time_ring');
    assert.ok(!byId.time_ring.attributes, 'no raw attributes on time_ring');
    if (byId.boots_of_haste) {
        assert.strictEqual(byId.boots_of_haste.speed, 20);
    }
    if (byId.power_band) {
        assert.ok(byId.power_band.resists && byId.power_band.resists.fire === 20);
    }
    const withSpeed = items.filter((i) => i.speed != null).length;
    assert.ok(withSpeed >= 30, `expected many speed items, got ${withSpeed}`);
    log('legacy equipment preset', {
        items: items.length,
        version: doc.version,
        withSpeed
    });
}

function main() {
    console.log('tests/legacy_port.js');
    testConverters();
    testEquipmentConverters();
    testOnDisk();
    testSpawnPinHelpers();
    testLegacyEquipmentPreset();
    testDragonLordEquivalency();
    console.log('All legacy_port tests passed.');
}

main();
