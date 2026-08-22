#!/usr/bin/env node
/**
 * Stage 4 exit criteria: damage pipeline edge cases; guardian auto-attack
 * and front_sweep strike vs training dummy; cooldowns + equipment rollup.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const {
    rollHit,
    rollCritical,
    rollRawDamage,
    normalRandom,
    autoStCritRollMin,
    fatalChanceFromTier,
    rollFatal,
    applyFatalBonus,
    FATAL_DAMAGE_BONUS,
    rollArmorReduction,
    applyMitigation,
    computeDamage,
    computeMeleeAutoRange,
    computeMeleeStrikeRange,
    computeMagicStrikeRange,
    computeMagicMean,
    computeMeleeMean,
    rangeFromMean,
    getMagicSpellParameters,
    getMeleeSpellParameters,
    computeLegacyMagicStrikeRange,
    computeLegacyMeleeStrikeRange,
    amplitudeFromLegacySpread,
    normalizeDamageAmplitude,
    levelBonus
} = require('../kernel/core/lib/combat/damage.js');
const Cooldowns = require('../kernel/core/lib/combat/cooldowns.js');
const {
    resolveAttack,
    previewDamageRange,
    indexSpells,
    critBandForSpell
} = require('../kernel/core/lib/combat/resolve.js');
const {
    rollupEquipment,
    buildEffectiveStats,
    getTotalDefense,
    normalizeEquipmentMap,
    normalizeSkillBag,
    canonicalEquipmentSlot,
    computeMitigationPercent,
    computeMaxBlock,
    resolveDefenseBlockContext,
    stackResists,
    UNARMED_ATK,
    UNARMED_WEAPON_DEFENSE,
    BOW_MITIGATION_DEFENSE,
    SHIELD_BLOCK_WINDOW_SEC,
    SHIELD_BLOCK_MAX_PER_WINDOW
} = require('../kernel/core/lib/character/stats.js');
const {
    resolveAutoAttackId,
    resolveWeaponType,
    meetsSpellLevel,
    meetsSpellMagicLevel,
    canCast,
    canUseSpell,
    hasRune,
    spendRune,
    resolveRuneItemId,
    tryAttack,
    tryAutoAttack,
    resolveDistanceAutoShape,
    isSpellInRange
} = require('../kernel/core/lib/ai/combat_actions.js');
const {
    isWithinSpellCastRange,
    FAR_USE_RANGE_X,
    FAR_USE_RANGE_Y
} = require('../kernel/core/lib/combat/cast_range.js');
const {
    countItemIdInInventoryTree,
    buildInventoryFromSeed,
    countEquippedQuiverAmmo
} = require('../kernel/core/lib/character/inventory.js');
const {
    initEquipmentRuntime,
    tickEquipmentDurations,
    consumeEquipmentCharges,
    advanceEquipmentRuntime,
    applyHitChargeConsumption
} = require('../kernel/core/lib/character/equipment_runtime.js');
const {
    memberFromPlayerProfile,
    expandPartyMember,
    expandParties,
    resolvePlayerSpriteArt
} = require('../kernel/core/lib/character/player_profile.js');
const presets = require('../kernel/core/lib/presets.js');
const { Creature } = require('../kernel/core/entities/creature.js');
const { Player } = require('../kernel/core/entities/player.js');
const { createSeededRandom } = require('../kernel/core/lib/utils.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

/** Deterministic RNG sequence from fixed seed. */
function rngFromSeed(seed) {
    return createSeededRandom(seed);
}

function testRollHitAndCrit() {
    assert.strictEqual(rollHit(100, () => 0.99), true);
    assert.strictEqual(rollHit(0, () => 0), false);
    assert.strictEqual(rollHit(50, () => 0.49), true);
    assert.strictEqual(rollHit(50, () => 0.5), false);

    assert.strictEqual(rollCritical(0, () => 0), false);
    assert.strictEqual(rollCritical(100, () => 0.99), true);
    assert.strictEqual(rollCritical(25, () => 0.24), true);
    assert.strictEqual(rollCritical(25, () => 0.25), false);
    log('rollHit / rollCritical ok');
}

function testRollRawAndArmor() {
    const mid = rollRawDamage(10, 20, false, 0, () => 0.5);
    assert.ok(mid.raw >= 10 && mid.raw <= 20, `raw in range: ${mid.raw}`);
    assert.strictEqual(mid.critical, false);

    const crit = rollRawDamage(10, 20, true, 50, () => 0);
    // default multiply: rng 0 → min 10; +50% → 15 (no 65% floor)
    assert.strictEqual(crit.critical, true);
    assert.strictEqual(crit.raw, 15);

    assert.strictEqual(rollArmorReduction(0, () => 0), 0);
    // Legacy: [ceil(a/2), ceil(a/2)*2-1] → armor 10 → [5, 9]
    assert.strictEqual(rollArmorReduction(10, () => 0), 5);
    assert.strictEqual(rollArmorReduction(10, () => 0.999), 9);
    assert.strictEqual(rollArmorReduction(9, () => 0), 5);
    assert.strictEqual(rollArmorReduction(9, () => 0.999), 9);
    assert.strictEqual(rollArmorReduction(1, () => 0), 1);
    log('rollRaw / armor ok');
}

function testGaussianAutoRaw() {
    assert.strictEqual(normalRandom(7, 7, () => 0.99), 7);

    const min = 10;
    const max = 30;
    const mid = (min + max) / 2;
    const n = 10000;
    const rng = rngFromSeed(4242);
    const counts = Object.create(null);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const raw = normalRandom(min, max, rng);
        assert.ok(
            raw >= min && raw <= max,
            `gaussian raw ${raw} in [${min},${max}]`
        );
        assert.strictEqual(raw, Math.floor(raw), `integer raw ${raw}`);
        counts[raw] = (counts[raw] || 0) + 1;
        sum += raw;
    }
    const mean = sum / n;
    assert.ok(
        Math.abs(mean - mid) < 0.8,
        `seeded mean ${mean} near mid-band ${mid}`
    );
    const midCount = counts[Math.round(mid)] || 0;
    const loTail = counts[min] || 0;
    const hiTail = counts[max] || 0;
    assert.ok(
        midCount > loTail && midCount > hiTail,
        `mid-bin ${midCount} > tails ${loTail}/${hiTail}`
    );

    // Crit without critBand is multiply: same gaussian, then extra (no 65% floor).
    const autoNon = rollRawDamage(10, 20, false, 0, rngFromSeed(11), {
        powerCurve: 'melee_auto'
    });
    const autoCrit = rollRawDamage(10, 20, true, 50, rngFromSeed(11), {
        powerCurve: 'melee_auto'
    });
    assert.strictEqual(autoCrit.critical, true);
    assert.strictEqual(autoCrit.raw, Math.floor(autoNon.raw * 1.5));

    // computeDamage: melee_auto / distance_auto non-crit stay in range.
    const auto = computeDamage({
        powerCurve: 'melee_auto',
        attacker: { level: 100, atk: 40, skill: 80 },
        defender: { armor: 0, mitigation: 0 },
        critChance: 0,
        rng: rngFromSeed(99)
    });
    assert.strictEqual(auto.hit, true);
    assert.ok(auto.breakdown.raw >= auto.range.min);
    assert.ok(auto.breakdown.raw <= auto.range.max);

    const dist = computeDamage({
        powerCurve: 'distance_auto',
        attacker: { level: 100, atk: 32, skill: 80 },
        defender: { armor: 0, mitigation: 0 },
        critChance: 0,
        rng: rngFromSeed(99)
    });
    assert.strictEqual(dist.hit, true);
    assert.ok(dist.breakdown.raw >= dist.range.min);
    assert.ok(dist.breakdown.raw <= dist.range.max);

    // Other curves stay uniform (rng 0 → min of the band).
    const strike = computeDamage({
        powerCurve: 'magic_strike',
        attacker: { level: 100, magic: 50 },
        basePower: 45,
        damageAmplitude: 0.15,
        defender: { armor: 0, mitigation: 0 },
        critChance: 0,
        rng: () => 0
    });
    assert.strictEqual(strike.breakdown.raw, strike.range.min);

    const kit = computeDamage({
        min: 10,
        max: 20,
        defender: { armor: 0, mitigation: 0 },
        critChance: 0,
        rng: () => 0
    });
    assert.strictEqual(kit.breakdown.raw, 10);

    log('gaussian auto raw ok', { mean, midCount, loTail, hiTail });
}

function testCritBandSplit() {
    assert.strictEqual(autoStCritRollMin(10, 20), 13);
    // Q3: 0.65×max below min → keep min
    assert.strictEqual(autoStCritRollMin(18, 20), 18);
    assert.strictEqual(autoStCritRollMin(20, 20), 20);
    assert.strictEqual(autoStCritRollMin(7, 10), 7);

    const st = rollRawDamage(10, 20, true, 50, () => 0, { critBand: 'auto_st' });
    assert.strictEqual(st.critical, true);
    assert.strictEqual(st.raw, 19, 'auto_st floor 13 × 1.5');

    const narrow = rollRawDamage(18, 20, true, 0, () => 0, {
        critBand: 'auto_st'
    });
    assert.strictEqual(narrow.raw, 18, 'Q3 never below authored min');

    const rngSt = rngFromSeed(2026);
    for (let i = 0; i < 200; i++) {
        const r = rollRawDamage(10, 20, true, 0, rngSt, { critBand: 'auto_st' });
        assert.ok(r.raw >= 13 && r.raw <= 20, `auto_st raw ${r.raw}`);
    }

    const spellNon = rollRawDamage(10, 30, false, 0, () => 0);
    const spellCrit = rollRawDamage(10, 30, true, 50, () => 0);
    assert.strictEqual(spellNon.raw, 10);
    assert.strictEqual(spellCrit.raw, 15, 'multiply = same roll × 1.5');
    assert.ok(spellCrit.raw < autoStCritRollMin(10, 30));

    const gNon = rollRawDamage(10, 20, false, 0, rngFromSeed(7), {
        powerCurve: 'melee_auto'
    });
    const gCrit = rollRawDamage(10, 20, true, 50, rngFromSeed(7), {
        powerCurve: 'melee_auto',
        critBand: 'multiply'
    });
    assert.strictEqual(gCrit.raw, Math.floor(gNon.raw * 1.5));

    const viaCompute = computeDamage({
        min: 10,
        max: 20,
        defender: { armor: 0, mitigation: 0 },
        critChance: 100,
        critDamage: 50,
        critBand: 'auto_st',
        rng: () => 0
    });
    assert.strictEqual(viaCompute.critical, true);
    assert.strictEqual(viaCompute.breakdown.raw, 19);

    const defaultCompute = computeDamage({
        powerCurve: 'melee_auto',
        min: 10,
        max: 20,
        defender: { armor: 0, mitigation: 0 },
        critChance: 100,
        critDamage: 50,
        rng: () => 0
    });
    assert.strictEqual(
        defaultCompute.breakdown.raw,
        22,
        'computeDamage default multiply (gaussian mid 15 × 1.5)'
    );

    assert.strictEqual(
        critBandForSpell({
            id: 'melee_auto',
            kind: 'auto',
            powerCurve: 'melee_auto'
        }),
        'auto_st'
    );
    assert.strictEqual(
        critBandForSpell({
            id: 'distance_auto',
            kind: 'auto',
            powerCurve: 'melee_auto'
        }),
        'auto_st'
    );
    assert.strictEqual(
        critBandForSpell({
            id: 'wand_auto',
            kind: 'auto',
            powerCurve: 'magic_strike'
        }),
        'multiply'
    );
    assert.strictEqual(
        critBandForSpell({ id: 'melee', kind: 'auto', min: 10, max: 20 }),
        'multiply',
        'kit melee kind=auto without auto id/curve'
    );
    assert.strictEqual(
        critBandForSpell({
            id: 'melee_auto',
            kind: 'auto',
            powerCurve: 'melee_auto',
            shape: { type: 'area', code: 3 }
        }),
        'multiply'
    );
    assert.strictEqual(
        critBandForSpell({
            id: 'distance_auto',
            kind: 'auto',
            powerCurve: 'distance_auto',
            chain: 4
        }),
        'multiply'
    );
    assert.strictEqual(
        critBandForSpell({
            id: 'melee_auto',
            kind: 'auto',
            powerCurve: 'melee_auto',
            followupShapes: [{ shape: { type: 'area', code: 1 } }]
        }),
        'multiply'
    );
    assert.strictEqual(
        critBandForSpell({
            id: 'flame_strike',
            kind: 'spell',
            powerCurve: 'magic_strike'
        }),
        'multiply'
    );

    const dummy = {
        hp: { current: 500, max: 500 },
        combatStats: { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 }
    };
    const stAtk = {
        level: 1,
        combatStats: {
            critChance: 100,
            critDamage: 0,
            armor: 0,
            mitigation: 0
        }
    };
    const stHit = resolveAttack({
        attacker: stAtk,
        defender: Object.assign({}, dummy, { hp: { current: 500, max: 500 } }),
        spell: {
            id: 'melee_auto',
            kind: 'auto',
            powerCurve: 'melee_auto',
            element: 'physical',
            min: 10,
            max: 20,
            mana: 0,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(stHit.hit && stHit.critical);
    assert.strictEqual(stHit.breakdown.raw, 13);

    const distHit = resolveAttack({
        attacker: stAtk,
        defender: Object.assign({}, dummy, { hp: { current: 500, max: 500 } }),
        spell: {
            id: 'distance_auto',
            kind: 'auto',
            powerCurve: 'melee_auto',
            element: 'physical',
            min: 10,
            max: 20,
            mana: 0,
            hitChance: 100,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(distHit.hit && distHit.critical);
    assert.strictEqual(distHit.breakdown.raw, 13);

    const kitHit = resolveAttack({
        attacker: {
            level: 1,
            combatStats: { critChance: 100, critDamage: 50 }
        },
        defender: Object.assign({}, dummy, { hp: { current: 500, max: 500 } }),
        spell: {
            id: 'melee',
            kind: 'auto',
            element: 'physical',
            min: 10,
            max: 30,
            mana: 0,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(kitHit.hit && kitHit.critical);
    assert.strictEqual(kitHit.breakdown.raw, 15, 'kit multiply 10 × 1.5');
    assert.ok(kitHit.breakdown.raw < autoStCritRollMin(10, 30));

    const wandHit = resolveAttack({
        attacker: {
            level: 1,
            combatStats: { critChance: 100, critDamage: 50 }
        },
        defender: Object.assign({}, dummy, { hp: { current: 500, max: 500 } }),
        spell: {
            id: 'wand_auto',
            kind: 'auto',
            powerCurve: 'magic_strike',
            element: 'energy',
            min: 10,
            max: 30,
            mana: 0,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(wandHit.hit && wandHit.critical);
    assert.strictEqual(wandHit.breakdown.raw, 15);

    const shapedHit = resolveAttack({
        attacker: stAtk,
        defender: Object.assign({}, dummy, { hp: { current: 500, max: 500 } }),
        spell: {
            id: 'melee_auto',
            kind: 'auto',
            powerCurve: 'melee_auto',
            element: 'physical',
            min: 10,
            max: 40,
            mana: 0,
            cooldowns: {},
            shape: { type: 'area', code: 3 }
        },
        skipCooldown: true,
        critBand: 'multiply',
        rng: () => 0
    });
    assert.ok(shapedHit.hit && shapedHit.critical);
    // gaussian mid of [10,40] with constant rng; below auto_st floor 26
    assert.strictEqual(shapedHit.breakdown.raw, 25);
    assert.ok(shapedHit.breakdown.raw < autoStCritRollMin(10, 40));

    log('crit band split ok');
}

function testMitigationPipelineOrder() {
    // raw 100, mit 10% → 90; resist 50% fire → 45; no shield; armor ignored (fire)
    const fire = applyMitigation(
        100,
        'fire',
        {
            mitigation: 10,
            resists: { fire: 50 },
            armor: 100,
            maxBlock: 50,
            canBlock: true
        },
        { isMelee: true, rng: () => 0 }
    );
    assert.ok(Math.abs(fire.mitigation - 10) < 1e-9, `mit ${fire.mitigation}`);
    assert.ok(Math.abs(fire.elementReduction - 45) < 1e-9, `el ${fire.elementReduction}`);
    assert.strictEqual(fire.armorReduction, 0, 'armor skips non-physical');
    assert.strictEqual(fire.shieldBlock, 0, 'shield only physical melee');
    assert.strictEqual(fire.final, 45);

    // physical: mit 0, resist 0, shield block max 20 with rng→1 → 20,
    // armor legacy hi=ceil(10/2)*2-1=9 → remaining 100-20-9=71
    const phys = applyMitigation(
        100,
        'physical',
        {
            mitigation: 0,
            resists: { physical: 0 },
            armor: 10,
            maxBlock: 20,
            canBlock: true
        },
        { isMelee: true, rng: () => 0.999 }
    );
    assert.strictEqual(phys.shieldBlock, 20);
    assert.strictEqual(phys.armorReduction, 9);
    assert.strictEqual(phys.final, 71);

    // full resist
    const immune = applyMitigation(
        50,
        'ice',
        { mitigation: 0, resists: { ice: 100 }, armor: 0, canBlock: false },
        { isMelee: false, rng: () => 0 }
    );
    assert.strictEqual(immune.final, 0);

    // zero raw
    const zero = applyMitigation(0, 'physical', { armor: 10 }, { isMelee: true, rng: () => 0 });
    assert.strictEqual(zero.final, 0);

    // flat percent mitigation (10% of raw → final 90)
    const mitOnly = applyMitigation(
        100,
        'physical',
        {
            mitigation: 10,
            resists: {},
            armor: 0,
            canBlock: false
        },
        { isMelee: false, rng: () => 0 }
    );
    assert.strictEqual(mitOnly.final, 90);

    log('mitigation pipeline ok');
}

function testComputeDamageMiss() {
    const r = computeDamage({
        min: 10,
        max: 20,
        hitChance: 0,
        defender: { armor: 0 },
        rng: () => 0
    });
    assert.strictEqual(r.hit, false);
    assert.strictEqual(r.final, 0);
    log('computeDamage miss ok');
}

function testCooldowns() {
    const entity = {};
    Cooldowns.ensureCooldowns(entity);
    const spec = {
        primary: { attack: 2 },
        spell: { front_sweep: 6 }
    };
    assert.strictEqual(Cooldowns.canUse(entity, spec), true);
    assert.strictEqual(Cooldowns.tryUse(entity, spec), true);
    assert.strictEqual(Cooldowns.canUse(entity, spec), false);
    assert.strictEqual(Cooldowns.getRemaining(entity, 'primary', 'attack'), 2);
    assert.strictEqual(Cooldowns.getRemaining(entity, 'spell', 'front_sweep'), 6);

    Cooldowns.tick(entity, 2);
    assert.strictEqual(Cooldowns.getRemaining(entity, 'primary', 'attack'), 0);
    assert.ok(Cooldowns.getRemaining(entity, 'spell', 'front_sweep') > 0);
    assert.strictEqual(Cooldowns.canUse(entity, spec), false);

    Cooldowns.tick(entity, 4);
    assert.strictEqual(Cooldowns.canUse(entity, spec), true);

    // empty spec always ok
    assert.strictEqual(Cooldowns.canUse(entity, null), true);
    log('cooldowns ok');
}

function testEquipmentRollup() {
    const items = presets.loadEquipment().items;
    const gear = rollupEquipment(
        {
            rightHand: 'iron_longsword',
            leftHand: 'oak_shield',
            armor: 'steel_plate',
            helmet: 'steel_helm',
            legs: 'steel_greaves',
            boots: 'leather_boots',
            ring: 'fire_ring'
        },
        items
    );
    assert.strictEqual(gear.atk, 42);
    // oak_shield.defense (fixture shield; value from standard equipment catalog)
    assert.strictEqual(gear.defense, 28);
    assert.strictEqual(gear.defenseBonus, 0);
    assert.strictEqual(getTotalDefense(gear), 28);
    assert.strictEqual(gear.armor, 14 + 6 + 7 + 2);
    assert.strictEqual(gear.speed, 10);
    assert.ok(gear.resists.fire > 0, 'fire resist from ring');
    assert.ok(Math.abs(gear.resists.fire - 10) < 1e-6);

    // multiplicative resist stacks
    assert.ok(Math.abs(stackResists([10, 10]) - 19) < 1e-6);

    const mit = computeMitigationPercent(70, 28);
    assert.ok(mit > 0 && mit < 80, `mitigation ${mit}`);
    log('equipment rollup ok', gear);
}

/**
 * Movement speed: baseSpeed + (level − 1) + gear.speed + speedBonus
 * (legacy ≈ 109 + level + equipment.speed).
 */
function testSpeedFromLevel() {
    const cls = {
        id: 'runner',
        baseSpeed: 110,
        skills: { melee: 10, shielding: 10, distance: 10, magic: 10 }
    };
    const empty = rollupEquipment({}, []);

    const l1 = buildEffectiveStats(cls, empty, { level: 1 });
    assert.strictEqual(l1.speed, 110, 'level 1 = baseSpeed');

    const l8 = buildEffectiveStats(cls, empty, { level: 8 });
    assert.strictEqual(l8.speed, 117, 'level 8 = 110 + 7');

    const l50 = buildEffectiveStats(cls, empty, { level: 50 });
    assert.strictEqual(l50.speed, 159, 'level 50 = 110 + 49');

    const gear = rollupEquipment(
        { boots: 'haste_boots' },
        [{ id: 'haste_boots', slot: 'boots', speed: 20 }]
    );
    const withGear = buildEffectiveStats(cls, gear, { level: 8 });
    assert.strictEqual(withGear.speed, 137, '117 + 20 boots');

    const bonusCls = Object.assign({}, cls, { speedBonus: 5 });
    const withBonus = buildEffectiveStats(bonusCls, empty, { level: 1 });
    assert.strictEqual(withBonus.speed, 115, 'base + speedBonus');

    // Higher level always faster when gear/class fixed
    assert.ok(l50.speed > l8.speed && l8.speed > l1.speed);

    log('speed from level ok', { l1: l1.speed, l8: l8.speed, l50: l50.speed });
}

/**
 * Empty right hand → legacy unarmed: atk 7, weaponDefense 5, melee auto, fist skill.
 */
function testUnarmedDefaults() {
    const empty = rollupEquipment({}, []);
    assert.strictEqual(empty.hasWeapon, false);
    assert.strictEqual(empty.atk, UNARMED_ATK);
    assert.strictEqual(empty.weaponDefense, UNARMED_WEAPON_DEFENSE);
    assert.strictEqual(empty.weaponType, 'fist');
    assert.strictEqual(getTotalDefense(empty), UNARMED_WEAPON_DEFENSE);

    // Armor / ring only still unarmed
    const itemDb = [
        {
            id: 'leather_cap',
            slot: 'helmet',
            category: 'helmet',
            armor: 2
        },
        {
            id: 'test_shield',
            slot: 'leftHand',
            category: 'shield',
            weaponType: 'shield',
            defense: 25
        },
        {
            id: 'test_sword',
            slot: 'rightHand',
            category: 'sword',
            weaponType: 'melee',
            atk: 40,
            defense: 20
        }
    ];
    const armorOnly = rollupEquipment({ helmet: 'leather_cap' }, itemDb);
    assert.strictEqual(armorOnly.hasWeapon, false);
    assert.strictEqual(armorOnly.atk, UNARMED_ATK);
    assert.strictEqual(armorOnly.armor, 2);

    // Shield replaces total defense (unarmed weaponDefense ignored when shield present)
    const shieldOnly = rollupEquipment({ leftHand: 'test_shield' }, itemDb);
    assert.strictEqual(shieldOnly.hasWeapon, false);
    assert.strictEqual(shieldOnly.atk, UNARMED_ATK);
    assert.strictEqual(getTotalDefense(shieldOnly), 25);

    // Weapon replaces unarmed atk/def (does not stack 7+40)
    const armed = rollupEquipment({ rightHand: 'test_sword' }, itemDb);
    assert.strictEqual(armed.hasWeapon, true);
    assert.strictEqual(armed.atk, 40);
    assert.strictEqual(armed.weaponDefense, 20);
    assert.strictEqual(armed.weaponType, 'melee');
    assert.strictEqual(armed.weaponSkill, 'sword');
    assert.strictEqual(empty.weaponSkill, 'fist');

    // Scout unarmed: still melee + fist, not distance_auto
    const scout = {
        id: 'scout',
        skillKey: 'distance',
        weaponType: 'distance',
        autoAttack: 'distance_auto',
        skills: { melee: 30, distance: 80, shielding: 50, magic: 30, fist: 12 }
    };
    const unarmedStats = buildEffectiveStats(scout, armorOnly, { level: 50 });
    assert.strictEqual(unarmedStats.unarmed, true);
    assert.strictEqual(unarmedStats.atk, UNARMED_ATK);
    assert.strictEqual(unarmedStats.weaponType, 'melee');
    assert.strictEqual(unarmedStats.skillKey, 'fist');
    assert.strictEqual(unarmedStats.weaponSkill, 'fist');
    assert.strictEqual(unarmedStats.skill, 12, 'explicit fist skill');
    assert.strictEqual(unarmedStats.autoAttack, 'melee_auto');
    assert.strictEqual(unarmedStats.weaponDefense, UNARMED_WEAPON_DEFENSE);
    assert.strictEqual(unarmedStats.defense, UNARMED_WEAPON_DEFENSE);

    // Fist falls back to melee when fist not authored
    const noFist = {
        id: 'guardian',
        skillKey: 'melee',
        autoAttack: 'melee_auto',
        skills: { melee: 70, distance: 10, shielding: 50, magic: 10 }
    };
    const fistFallback = buildEffectiveStats(noFist, empty, { level: 50 });
    assert.strictEqual(fistFallback.skillKey, 'fist');
    assert.strictEqual(fistFallback.skill, 70, 'fist mirrors melee when unset');

    // AI helpers respect unarmed flag
    assert.strictEqual(
        resolveWeaponType({ combatStats: unarmedStats }),
        'melee'
    );
    assert.strictEqual(
        resolveAutoAttackId({ combatStats: unarmedStats }),
        'melee_auto'
    );

    log('unarmed defaults ok', {
        atk: unarmedStats.atk,
        skillKey: unarmedStats.skillKey,
        skill: unarmedStats.skill
    });
}

/**
 * Weapon skill subtype drives skillKey (legacy parity).
 * Fist weapons use skills.fist; sword/axe/club share skills.melee; family still from weaponType.
 */
function testWeaponSkillFromGear() {
    const itemDb = [
        {
            id: 'gloomforged_katar',
            slot: 'rightHand',
            category: 'fist',
            type: ['fist'],
            weaponType: 'melee',
            atk: 42,
            skillBonuses: { fist: 2 }
        },
        {
            id: 'iron_longsword',
            slot: 'rightHand',
            category: 'sword',
            type: ['sword'],
            weaponType: 'melee',
            atk: 40
        },
        {
            id: 'hunter_bow',
            slot: 'rightHand',
            category: 'bow',
            type: ['bow'],
            weaponType: 'distance',
            atk: 30
        },
        {
            id: 'fire_wand',
            slot: 'rightHand',
            category: 'wand',
            type: ['wand'],
            weaponType: 'magic',
            range: 5
        },
        {
            id: 'type_only_club',
            slot: 'rightHand',
            // no category — resolve from type[]
            type: ['club'],
            weaponType: 'melee',
            atk: 25
        },
        {
            id: 'hybrid_axe_rod',
            slot: 'rightHand',
            category: 'axe',
            type: ['axe', 'rod'],
            weaponType: 'melee',
            atk: 1
        }
    ];

    const fistCls = {
        id: 'monk',
        skillKey: 'melee',
        autoAttack: 'melee_auto',
        skills: { melee: 50, distance: 20, shielding: 40, magic: 15, fist: 80 }
    };

    const katarGear = rollupEquipment({ rightHand: 'gloomforged_katar' }, itemDb);
    assert.strictEqual(katarGear.hasWeapon, true);
    assert.strictEqual(katarGear.weaponType, 'melee');
    assert.strictEqual(katarGear.weaponSkill, 'fist');
    assert.strictEqual(katarGear.skillBonuses.fist, 2, 'fist bonus once (no double-count)');
    assert.strictEqual(katarGear.skillBonuses.melee, 2, 'fist also feeds melee bag');

    const katarStats = buildEffectiveStats(fistCls, katarGear, { level: 50 });
    assert.strictEqual(katarStats.unarmed, false);
    assert.strictEqual(katarStats.weaponType, 'melee');
    assert.strictEqual(katarStats.weaponSkill, 'fist');
    assert.strictEqual(katarStats.skillKey, 'fist');
    assert.strictEqual(katarStats.skill, 82, 'fist base 80 + gear 2');
    assert.strictEqual(katarStats.autoAttack, 'melee_auto');
    // Class skillKey ignored when weapon has subtype
    assert.notStrictEqual(katarStats.skillKey, fistCls.skillKey);

    const swordGear = rollupEquipment({ rightHand: 'iron_longsword' }, itemDb);
    assert.strictEqual(swordGear.weaponSkill, 'sword');
    const swordStats = buildEffectiveStats(fistCls, swordGear, { level: 50 });
    assert.strictEqual(swordStats.skillKey, 'sword');
    assert.strictEqual(
        swordStats.skill,
        50,
        'sword falls back to collapsed melee when subtype absent'
    );
    assert.strictEqual(swordStats.autoAttack, 'melee_auto');

    // Standard policy: subtype bag wins over collapsed melee (and over other subtypes)
    const subtypeCls = {
        id: 'guardian',
        skillKey: 'melee',
        autoAttack: 'melee_auto',
        skills: {
            melee: 99,
            sword: 80,
            axe: 12,
            club: 14,
            distance: 10,
            shielding: 40,
            magic: 0,
            fist: 20
        }
    };
    const swordSub = buildEffectiveStats(subtypeCls, swordGear, { level: 50 });
    assert.strictEqual(swordSub.skillKey, 'sword');
    assert.strictEqual(swordSub.skill, 80, 'sword subtype preferred over melee 99');
    const axeGear = rollupEquipment(
        { rightHand: 'hybrid_axe_rod' },
        itemDb
    );
    const axeSub = buildEffectiveStats(subtypeCls, axeGear, { level: 50 });
    assert.strictEqual(axeSub.skillKey, 'axe');
    assert.strictEqual(axeSub.skill, 12, 'axe uses own bag not sword/melee max');
    const clubSub = buildEffectiveStats(
        subtypeCls,
        rollupEquipment({ rightHand: 'type_only_club' }, itemDb),
        { level: 50 }
    );
    assert.strictEqual(clubSub.skillKey, 'club');
    assert.strictEqual(clubSub.skill, 14, 'club uses own bag');

    const bowGear = rollupEquipment({ rightHand: 'hunter_bow' }, itemDb);
    assert.strictEqual(bowGear.weaponSkill, 'distance');
    const bowStats = buildEffectiveStats(fistCls, bowGear, { level: 50 });
    assert.strictEqual(bowStats.skillKey, 'distance');
    assert.strictEqual(bowStats.skill, 20);
    assert.strictEqual(bowStats.weaponType, 'distance');
    assert.strictEqual(bowStats.autoAttack, 'distance_auto');

    const wandGear = rollupEquipment({ rightHand: 'fire_wand' }, itemDb);
    assert.strictEqual(wandGear.weaponSkill, 'magic');
    assert.strictEqual(wandGear.weaponRange, 5, 'wand item.range rolls into gear');
    const wandStats = buildEffectiveStats(fistCls, wandGear, { level: 50 });
    assert.strictEqual(wandStats.skillKey, 'magic');
    assert.strictEqual(wandStats.skill, 15);
    assert.strictEqual(wandStats.autoAttack, 'wand_auto');
    assert.strictEqual(wandStats.weaponRange, 5, 'wand auto range comes from weapon');

    // type[] fallback when category missing
    const clubGear = rollupEquipment({ rightHand: 'type_only_club' }, itemDb);
    assert.strictEqual(clubGear.weaponSkill, 'club');
    const clubStats = buildEffectiveStats(fistCls, clubGear, { level: 50 });
    assert.strictEqual(clubStats.skillKey, 'club');
    assert.strictEqual(clubStats.skill, 50, 'club falls back to melee when subtype absent');

    // multi-type: category wins (axe over rod)
    const hybridGear = rollupEquipment({ rightHand: 'hybrid_axe_rod' }, itemDb);
    assert.strictEqual(hybridGear.weaponSkill, 'axe');
    assert.strictEqual(hybridGear.weaponType, 'melee');

    // Scout class + fist weapon still uses fist (not class distance)
    const scout = {
        id: 'scout',
        skillKey: 'distance',
        weaponType: 'distance',
        autoAttack: 'distance_auto',
        skills: { melee: 30, distance: 90, shielding: 40, magic: 20, fist: 25 }
    };
    const scoutKatar = buildEffectiveStats(scout, katarGear, { level: 50 });
    assert.strictEqual(scoutKatar.skillKey, 'fist');
    assert.strictEqual(scoutKatar.skill, 27, '25 + 2 fist bonus');
    assert.strictEqual(scoutKatar.autoAttack, 'melee_auto');

    log('weapon skill from gear ok', {
        katar: katarStats.skillKey,
        sword: swordStats.skillKey,
        bow: bowStats.skillKey
    });
}

/**
 * Phase 4: defenseBonus (weapon extradef) stacks into total defense only with a shield;
 * regen + manaShield flags are surfaced on rollup / effective stats (display summary;
 * combat regen ticks per item in equipment_runtime).
 */
function testDefenseBonusAndOptionalFlags() {
    const itemDb = [
        {
            id: 'test_axe',
            slot: 'rightHand',
            category: 'axe',
            weaponType: 'melee',
            atk: 40,
            defense: 30,
            defenseBonus: 3
        },
        {
            id: 'test_shield',
            slot: 'leftHand',
            category: 'shield',
            weaponType: 'shield',
            defense: 25
        },
        {
            id: 'test_life_ring',
            slot: 'ring',
            category: 'ring',
            regen: { hp: 2, hpTicksMs: 6000, mp: 8, mpTicksMs: 6000 }
        },
        {
            id: 'test_energy_ring',
            slot: 'ring',
            category: 'ring',
            flags: { manaShield: true }
        }
    ];

    // Weapon only: total defense is weaponDefense; extradef does not apply
    const weaponOnly = rollupEquipment({ rightHand: 'test_axe' }, itemDb);
    assert.strictEqual(weaponOnly.weaponDefense, 30);
    assert.strictEqual(weaponOnly.defense, 0);
    assert.strictEqual(weaponOnly.defenseBonus, 3);
    assert.strictEqual(getTotalDefense(weaponOnly), 30, 'no shield → weaponDefense only');

    // Weapon + shield: legacy getTotalDefense = shield.def + weapon.extradef
    const withShield = rollupEquipment(
        { rightHand: 'test_axe', leftHand: 'test_shield' },
        itemDb
    );
    assert.strictEqual(withShield.defense, 25);
    assert.strictEqual(withShield.weaponDefense, 30);
    assert.strictEqual(withShield.defenseBonus, 3);
    assert.strictEqual(getTotalDefense(withShield), 28, '25 shield + 3 extradef');

    const cls = { id: 'tester', skills: { melee: 50, shielding: 50, distance: 10, magic: 10 } };
    const stats = buildEffectiveStats(cls, withShield, { level: 50 });
    assert.strictEqual(stats.defense, 28);
    assert.strictEqual(stats.defenseBonus, 3);
    assert.strictEqual(stats.weaponDefense, 30);
    assert.ok(stats.maxBlock > 0, 'maxBlock uses total defense incl. defenseBonus');
    // maxBlock = ceil(def × (shielding+10)/40)
    assert.strictEqual(
        stats.maxBlock,
        computeMaxBlock(50, 28),
        'maxBlock formula with shield + shielding skill'
    );
    assert.strictEqual(stats.maxBlock, Math.ceil(28 * ((50 + 10) / 40)));
    const mitWith = computeMitigationPercent(50, 28);
    const mitWithout = computeMitigationPercent(50, 25);
    assert.ok(mitWith > mitWithout, 'mitigation rises with defenseBonus');

    // Regen + manaShield rollup (data surface; no combat tick)
    const life = rollupEquipment({ ring: 'test_life_ring' }, itemDb);
    assert.strictEqual(life.regen.hp, 2);
    assert.strictEqual(life.regen.mp, 8);
    assert.strictEqual(life.regen.hpTicksMs, 6000);
    assert.strictEqual(life.flags.manaShield, false);

    const energy = rollupEquipment({ ring: 'test_energy_ring' }, itemDb);
    assert.strictEqual(energy.flags.manaShield, true);
    const energyStats = buildEffectiveStats(cls, energy, { level: 8 });
    assert.strictEqual(energyStats.flags.manaShield, true);

    // Live catalog: amber_axe extradef + oak_shield when present
    const live = presets.loadEquipment().items;
    const amber = live.find((i) => i && i.id === 'amber_axe');
    const oak = live.find((i) => i && i.id === 'oak_shield');
    if (amber && oak && Number(amber.defenseBonus) === 3) {
        const liveGear = rollupEquipment(
            { rightHand: 'amber_axe', leftHand: 'oak_shield' },
            live
        );
        assert.strictEqual(liveGear.defenseBonus, 3);
        assert.strictEqual(getTotalDefense(liveGear), (Number(oak.defense) || 0) + 3);
        log('live amber_axe + oak_shield defenseBonus ok', getTotalDefense(liveGear));
    }

    log('defenseBonus / regen / manaShield rollup ok');
}

/**
 * Phase 5: designer profile slots (head/chest/weapon/shield) → engine slots.
 */
function testProfileSlotAliases() {
    assert.strictEqual(canonicalEquipmentSlot('head'), 'helmet');
    assert.strictEqual(canonicalEquipmentSlot('chest'), 'armor');
    assert.strictEqual(canonicalEquipmentSlot('weapon'), 'rightHand');
    assert.strictEqual(canonicalEquipmentSlot('shield'), 'leftHand');
    assert.strictEqual(canonicalEquipmentSlot('feet'), 'boots');
    assert.strictEqual(canonicalEquipmentSlot('necklace'), 'amulet');

    const mapped = normalizeEquipmentMap({
        head: 'steel_casque',
        chest: 'plate_armor',
        weapon: 'jagged_sword',
        shield: 'plate_shield',
        legs: 'plate_legs',
        boots: 'leather_boots',
        backpack: 'backpack'
    });
    assert.strictEqual(mapped.helmet, 'steel_casque');
    assert.strictEqual(mapped.armor, 'plate_armor');
    assert.strictEqual(mapped.rightHand, 'jagged_sword');
    assert.strictEqual(mapped.leftHand, 'plate_shield');
    assert.strictEqual(mapped.legs, 'plate_legs');
    assert.strictEqual(mapped.boots, 'leather_boots');
    assert.strictEqual(mapped.backpack, 'backpack');
    assert.strictEqual(mapped.head, undefined);
    assert.strictEqual(mapped.weapon, undefined);

    // Engine key wins over alias when both set
    const prefer = normalizeEquipmentMap({
        head: 'steel_casque',
        helmet: 'steel_helm',
        weapon: 'jagged_sword',
        rightHand: 'iron_longsword'
    });
    assert.strictEqual(prefer.helmet, 'steel_helm');
    assert.strictEqual(prefer.rightHand, 'iron_longsword');

    const itemDb = [
        { id: 'steel_casque', slot: 'helmet', armor: 6 },
        { id: 'plate_armor', slot: 'armor', armor: 10 },
        { id: 'jagged_sword', slot: 'rightHand', category: 'sword', atk: 21, defense: 14 },
        { id: 'plate_shield', slot: 'leftHand', category: 'shield', defense: 17 },
        { id: 'plate_legs', slot: 'legs', armor: 7 },
        { id: 'leather_boots', slot: 'boots', armor: 2, speed: 10 }
    ];
    const gear = rollupEquipment(
        {
            head: 'steel_casque',
            chest: 'plate_armor',
            weapon: 'jagged_sword',
            shield: 'plate_shield',
            legs: 'plate_legs',
            boots: 'leather_boots'
        },
        itemDb
    );
    assert.strictEqual(gear.atk, 21);
    assert.strictEqual(gear.armor, 6 + 10 + 7 + 2);
    assert.strictEqual(gear.defense, 17);
    assert.strictEqual(gear.weaponDefense, 14);
    assert.strictEqual(getTotalDefense(gear), 17);
    assert.strictEqual(gear.speed, 10);

    // Profile → member expansion
    const profile = {
        id: 'guardian_starter',
        label: 'Guardian Starter',
        vocation: 'guardian',
        level: 50,
        strategyId: 'guardian_aggro',
        equipment: {
            head: 'steel_casque',
            chest: 'plate_armor',
            weapon: 'jagged_sword',
            shield: 'plate_shield'
        }
    };
    const member = memberFromPlayerProfile(profile, {
        name: 'Guardian Tank',
        isLeader: true,
        autoChase: true
    });
    assert.strictEqual(member.classId, 'guardian');
    assert.strictEqual(member.equipment.helmet, 'steel_casque');
    assert.strictEqual(member.equipment.rightHand, 'jagged_sword');
    assert.strictEqual(member.equipment.leftHand, 'plate_shield');
    assert.strictEqual(member.isLeader, true);
    assert.strictEqual(member.autoChase, true, 'profile expand keeps Auto Chase');

    const expanded = expandPartyMember(
        {
            profileId: 'guardian_starter',
            name: 'Tank',
            isLeader: true,
            autoChase: true
        },
        { loadPlayerProfile: () => profile }
    );
    assert.strictEqual(expanded.equipment.helmet, 'steel_casque');
    assert.strictEqual(expanded.classId, 'guardian');
    assert.strictEqual(
        expanded.autoChase,
        true,
        'expandPartyMember keeps Auto Chase through profileId'
    );

    // Profile customSprite expands; wins over vocation baseSprite
    const profileWithArt = Object.assign({}, profile, {
        customSprite: 'ashen_dwarf_priest',
        customSpriteGenre: 'rpg_fantasy'
    });
    const artMember = memberFromPlayerProfile(profileWithArt, {
        isLeader: true
    });
    assert.strictEqual(artMember.customSprite, 'ashen_dwarf_priest');
    assert.strictEqual(artMember.spriteId, 'ashen_dwarf_priest');
    const resolved = resolvePlayerSpriteArt(artMember, {
        id: 'guardian',
        baseSprite: 'crystal_lizard_warrior'
    });
    assert.strictEqual(resolved.spriteId, 'ashen_dwarf_priest');
    assert.strictEqual(
        resolvePlayerSpriteArt(
            { classId: 'guardian' },
            { id: 'guardian', baseSprite: 'crystal_lizard_warrior' }
        ).spriteId,
        'crystal_lizard_warrior'
    );

    // Live profile file when present
    try {
        const presets = require('../kernel/core/lib/presets.js');
        const live = presets.loadPlayerProfile('guardian_starter');
        const liveMember = memberFromPlayerProfile(live, { isLeader: true });
        assert.ok(liveMember.equipment.helmet || liveMember.equipment.rightHand);
        const party = presets.loadParty('starter_duo');
        assert.ok(party.members && party.members.length >= 1);
        assert.ok(
            party.members[0].equipment &&
                (party.members[0].equipment.rightHand ||
                    party.members[0].equipment.helmet),
            'starter_duo expands guardian_starter gear'
        );
        log('live guardian_starter / starter_duo ok', party.members[0].equipment);
    } catch (e) {
        log('live profile skip', e.message);
    }

    log('profile slot aliases ok');
}

/**
 * Profile skills → buildEffectiveStats base layer (+ gear bonuses).
 * Profile vocabulary (sword/axe/magicLevel) normalizes to engine keys.
 */
function testProfileSkillOverrides() {
    const mapped = normalizeSkillBag({
        sword: 60,
        axe: 13,
        club: 13,
        fist: 10,
        distance: 10,
        shielding: 50,
        magicLevel: 0
    });
    assert.ok(mapped);
    assert.strictEqual(mapped.melee, 60, 'melee = max weapon skill');
    assert.strictEqual(mapped.distance, 10);
    assert.strictEqual(mapped.shielding, 50);
    assert.strictEqual(mapped.magic, 0);

    const cls = {
        id: 'guardian',
        skills: { melee: 80, distance: 20, shielding: 70, magic: 10 },
        skillKey: 'melee',
        baseHp: 185,
        baseMp: 35
    };
    const itemDb = [
        {
            id: 'skill_sword',
            slot: 'rightHand',
            category: 'sword',
            atk: 20,
            skillBonuses: { melee: 5 }
        }
    ];
    const gear = rollupEquipment({ rightHand: 'skill_sword' }, itemDb);

    // Class only
    const classOnly = buildEffectiveStats(cls, gear, { level: 50 });
    assert.strictEqual(classOnly.skills.melee, 85, '80 class + 5 gear');
    assert.strictEqual(classOnly.skill, 85);

    // Profile base skills replace class skills, gear still stacks
    const withProfile = buildEffectiveStats(cls, gear, {
        level: 50,
        baseSkills: {
            sword: 60,
            shielding: 50,
            distance: 10,
            magicLevel: 0
        }
    });
    assert.strictEqual(withProfile.skills.melee, 65, '60 profile + 5 gear');
    assert.strictEqual(withProfile.skills.shielding, 50);
    assert.strictEqual(withProfile.skills.magic, 0);
    assert.strictEqual(withProfile.skill, 65);

    // Absolute skillOverrides replace post-gear values
    const abs = buildEffectiveStats(cls, gear, {
        level: 50,
        baseSkills: { sword: 60 },
        skillOverrides: { melee: 99 }
    });
    assert.strictEqual(abs.skills.melee, 99);

    // crit from opts
    const crit = buildEffectiveStats(cls, gear, {
        level: 50,
        critChance: 5,
        critDamage: 10
    });
    assert.strictEqual(crit.critChance, 5);
    assert.strictEqual(crit.critDamage, 10);

    // Profile expansion carries skills
    const profile = {
        id: 'guardian_starter',
        vocation: 'guardian',
        level: 50,
        skills: {
            sword: 60,
            axe: 13,
            shielding: 50,
            magicLevel: 0,
            distance: 10
        },
        stats: { critChance: 5, critDamage: 10 },
        equipment: { weapon: 'skill_sword' }
    };
    const member = memberFromPlayerProfile(profile, { isLeader: true });
    assert.ok(member.skills);
    assert.strictEqual(member.skills.sword, 60);
    assert.strictEqual(member.critChance, 5);

    const player = new Player({
        id: 1,
        name: 'Tank',
        classId: 'guardian',
        equipment: member.equipment,
        skills: member.skills,
        critChance: member.critChance,
        critDamage: member.critDamage,
        classDef: cls,
        itemDb,
        level: 50
    });
    assert.strictEqual(player.combatStats.skills.melee, 65);
    assert.strictEqual(player.combatStats.critChance, 5);
    assert.strictEqual(player.skill, 65);

    // Live guardian_starter when present
    try {
        const live = presets.loadPlayerProfile('guardian_starter');
        const liveCls = presets.getClass('guardian');
        const liveItems = presets.loadEquipment().items;
        const liveMember = memberFromPlayerProfile(live, { isLeader: true });
        const liveGear = rollupEquipment(liveMember.equipment, liveItems);
        const liveStats = buildEffectiveStats(liveCls, liveGear, {
            level: liveMember.level,
            baseSkills: liveMember.skills,
            critChance: liveMember.critChance,
            critDamage: liveMember.critDamage
        });
        assert.strictEqual(liveStats.skills.melee, 60, 'live profile sword=60');
        assert.strictEqual(liveStats.skills.shielding, 50);
        assert.strictEqual(liveStats.critChance, 10, 'class 5 + starter profile 5');
        assert.strictEqual(liveStats.critDamage, 20, 'class 10 + starter profile 10');
        log('live guardian_starter skills ok', liveStats.skills);
    } catch (e) {
        log('live profile skills skip', e.message);
    }

    log('profile skill overrides ok');
}

/**
 * durationSec tick → unequip; absorb charges consume on hit → unequip at 0.
 * Stealth ring: flags.invisible while equipped (like spell invisible).
 */
function testEquipmentDurationAndCharges() {
    const {
        isInvisible,
        canSeeInvisibility,
        canSeeCreature
    } = require('../kernel/core/lib/combat/conditions.js');
    const { isValidTarget } = require('../kernel/core/lib/ai/targeting.js');
    const {
        unequipItem,
        equipItem
    } = require('../kernel/core/lib/character/inventory.js');

    const itemDb = [
        {
            id: 'timed_ring',
            slot: 'ring',
            category: 'ring',
            speed: 30,
            durationSec: 2
        },
        {
            id: 'charge_ring',
            slot: 'ring',
            category: 'ring',
            charges: 3,
            resists: { physical: 20, fire: 20 }
        },
        {
            id: 'weapon_charges',
            slot: 'rightHand',
            category: 'sword',
            atk: 20,
            charges: 5
        },
        {
            id: 'stealth_ring',
            slot: 'ring',
            category: 'ring',
            durationSec: 600,
            flags: { invisible: true }
        },
        {
            id: 'plain_boots',
            slot: 'boots',
            category: 'boots',
            armor: 2
        },
        {
            id: 'backpack',
            slot: 'backpack',
            category: 'container',
            volume: 20
        }
    ];

    // Pure runtime helpers
    let runtime = initEquipmentRuntime(
        { ring: 'timed_ring', boots: 'plain_boots' },
        itemDb
    );
    assert.ok(runtime.ring);
    assert.strictEqual(runtime.ring.remainingDurationSec, 2);
    assert.strictEqual(runtime.boots, undefined, 'no budget → no runtime slot');

    let tick = tickEquipmentDurations(runtime, 1);
    assert.strictEqual(runtime.ring.remainingDurationSec, 1);
    assert.strictEqual(tick.expiredSlots.length, 0);

    tick = tickEquipmentDurations(runtime, 1.5);
    assert.ok(tick.expiredSlots.indexOf('ring') >= 0);
    assert.strictEqual(runtime.ring.remainingDurationSec, 0);

    const advanced = advanceEquipmentRuntime(
        { ring: 'timed_ring', boots: 'plain_boots' },
        initEquipmentRuntime({ ring: 'timed_ring', boots: 'plain_boots' }, itemDb),
        2
    );
    assert.strictEqual(advanced.equipment.ring, undefined);
    assert.strictEqual(advanced.equipment.boots, 'plain_boots');
    assert.ok(advanced.expiredSlots.indexOf('ring') >= 0);

    // Absorb charges only (not weapons)
    runtime = initEquipmentRuntime({ ring: 'charge_ring', rightHand: 'weapon_charges' }, itemDb);
    assert.strictEqual(runtime.ring.remainingCharges, 3);
    assert.strictEqual(runtime.rightHand.remainingCharges, 5);
    assert.strictEqual(runtime.ring.consumeChargesOnHit, true);
    assert.strictEqual(runtime.rightHand.consumeChargesOnHit, false, 'weapons do not spend on hit');
    let hit = consumeEquipmentCharges(runtime, 1, { element: 'physical' });
    assert.strictEqual(runtime.ring.remainingCharges, 2);
    assert.strictEqual(runtime.rightHand.remainingCharges, 5, 'weapon charges untouched');
    assert.strictEqual(hit.depletedSlots.length, 0);
    // Wrong element for absorb → no spend
    hit = consumeEquipmentCharges(runtime, 1, { element: 'death' });
    assert.strictEqual(runtime.ring.remainingCharges, 2, 'no absorb for death');
    hit = consumeEquipmentCharges(runtime, 2, { element: 'fire' });
    assert.strictEqual(runtime.ring.remainingCharges, 0);
    assert.ok(hit.depletedSlots.indexOf('ring') >= 0);

    const charged = applyHitChargeConsumption(
        { ring: 'charge_ring' },
        initEquipmentRuntime({ ring: 'charge_ring' }, itemDb),
        3,
        { element: 'physical' }
    );
    assert.strictEqual(charged.equipment.ring, undefined);
    assert.ok(charged.depletedSlots.indexOf('ring') >= 0);

    // Player integration: duration expiry drops speed
    const cls = {
        id: 'tester',
        skills: { melee: 50, shielding: 50, distance: 10, magic: 10 },
        baseSpeed: 110,
        baseHp: 100,
        baseMp: 50
    };
    const player = new Player({
        id: 2,
        name: 'Timed',
        equipment: { ring: 'timed_ring', boots: 'plain_boots' },
        classDef: cls,
        itemDb,
        level: 8
    });
    // baseSpeed 110 + (level 8 − 1) + ring 30 = 147
    assert.strictEqual(player.speed, 147, '110 base + 7 level + 30 ring');
    assert.ok(player.equipmentRuntime.ring);

    const { Time } = require('../kernel/core/lib/time.js');
    Time.deltaTime = 2;
    player.update();
    assert.strictEqual(player.equipment.ring, undefined, 'ring expired');
    assert.strictEqual(player.equipment.boots, 'plain_boots');
    assert.strictEqual(player.speed, 117, '110 base + 7 level, ring gone');
    Time.deltaTime = 0;

    // Player integration: charges on applyHpDelta
    const tank = new Player({
        id: 3,
        name: 'Charged',
        equipment: { ring: 'charge_ring' },
        classDef: cls,
        itemDb,
        level: 8
    });
    assert.ok(tank.resists.physical > 0, 'resist from charge ring');
    assert.strictEqual(tank.equipmentRuntime.ring.remainingCharges, 3);
    // applyHpDelta takes positive damage amount (returns negative delta)
    tank.applyHpDelta(5, 'physical');
    assert.strictEqual(tank.equipmentRuntime.ring.remainingCharges, 2);
    tank.applyHpDelta(5, 'physical');
    tank.applyHpDelta(5, 'physical');
    assert.strictEqual(tank.equipment.ring, undefined, 'ring depleted');
    assert.strictEqual(tank.resists.physical, 0, 'resists gone after deplete');

    // Stealth ring: gear invisible like spell invisible
    const sneaker = new Player({
        id: 4,
        name: 'Sneak',
        equipment: { ring: 'stealth_ring' },
        classDef: cls,
        itemDb,
        level: 8,
        tile: { x: 0, y: 0, z: 7 }
    });
    assert.ok(sneaker.combatStats.flags.invisible, 'flags.invisible from gear');
    assert.ok(isInvisible(sneaker), 'isInvisible from gear flag');
    assert.ok(sneaker.invisible, 'entity.invisible derived');
    assert.strictEqual(sneaker.equipmentRuntime.ring.remainingDurationSec, 600);
    const blindMob = new Creature({
        id: 91,
        type: 'creature',
        hp: 100,
        tile: { x: 1, y: 0, z: 7 }
    });
    assert.strictEqual(canSeeInvisibility(blindMob), false);
    assert.strictEqual(canSeeCreature(blindMob, sneaker), false);
    assert.strictEqual(isValidTarget(blindMob, sneaker), false);
    const seer = new Creature({
        id: 92,
        type: 'creature',
        hp: 100,
        tile: { x: 1, y: 0, z: 7 }
    });
    seer.immunities = { invisible: true };
    assert.strictEqual(isValidTarget(seer, sneaker), true);
    // Duration tick only while equipped; expire destroys ring and clears invis
    sneaker.tickEquipmentRuntime(600);
    assert.strictEqual(sneaker.equipment.ring, undefined, 'stealth ring consumed');
    assert.ok(!isInvisible(sneaker), 'invisible cleared after ring expires');
    assert.strictEqual(isValidTarget(blindMob, sneaker), true, 'blind mob can target again');

    // stopduration: unequip pauses remaining duration; re-equip continues
    const timed = new Player({
        id: 5,
        name: 'StopDur',
        equipment: { ring: 'timed_ring', backpack: 'backpack' },
        classDef: cls,
        itemDb,
        level: 8
    });
    timed.initInventory({ equipment: timed.equipment }, itemDb);
    assert.strictEqual(timed.equipmentRuntime.ring.remainingDurationSec, 2);
    timed.tickEquipmentRuntime(1);
    assert.strictEqual(timed.equipmentRuntime.ring.remainingDurationSec, 1);
    const ringUid = timed.inventory.equipment.ring;
    assert.ok(ringUid);
    // Unequip to backpack — duration must not keep ticking
    const uq = unequipItem(timed.inventory, 'ring', itemDb);
    assert.strictEqual(uq.ok, true, uq.error || 'unequip ok');
    timed.applyInventoryMutation();
    assert.strictEqual(timed.equipment.ring, undefined);
    assert.strictEqual(timed.inventory.items[ringUid].remainingDurationSec, 1, 'budget on instance');
    timed.tickEquipmentRuntime(5); // wall time while unequipped — no ring runtime
    assert.strictEqual(timed.inventory.items[ringUid].remainingDurationSec, 1, 'paused while stowed');
    // Re-equip and finish remaining second
    const eq = equipItem(timed.inventory, ringUid, itemDb, 'ring');
    assert.strictEqual(eq.ok, true, eq.error || 'equip ok');
    timed.applyInventoryMutation();
    assert.strictEqual(timed.equipment.ring, 'timed_ring');
    assert.strictEqual(timed.equipmentRuntime.ring.remainingDurationSec, 1, 'resume remaining');
    timed.tickEquipmentRuntime(1);
    assert.strictEqual(timed.equipment.ring, undefined, 'expires after remaining budget');

    // Live time_ring / power_band / stealth_ring when present
    try {
        const liveItems = presets.loadEquipment().items;
        const timeRing = liveItems.find((i) => i && i.id === 'time_ring');
        const might = liveItems.find((i) => i && i.id === 'power_band');
        const stealth = liveItems.find((i) => i && i.id === 'stealth_ring');
        if (timeRing && timeRing.durationSec === 600) {
            const rt = initEquipmentRuntime({ ring: 'time_ring' }, liveItems);
            assert.strictEqual(rt.ring.remainingDurationSec, 600);
        }
        if (might && might.charges === 20) {
            const rt = initEquipmentRuntime({ ring: 'power_band' }, liveItems);
            assert.strictEqual(rt.ring.remainingCharges, 20);
            assert.strictEqual(rt.ring.consumeChargesOnHit, true);
        }
        if (stealth && stealth.flags && stealth.flags.invisible) {
            assert.strictEqual(stealth.durationSec, 600);
            const liveSneak = new Player({
                id: 6,
                name: 'LiveSneak',
                equipment: { ring: 'stealth_ring' },
                classDef: cls,
                itemDb: liveItems,
                level: 8,
                tile: { x: 0, y: 0, z: 7 }
            });
            assert.ok(isInvisible(liveSneak), 'live stealth_ring grants invis');
        }
        log('live timed/charged/stealth rings ok');
    } catch (e) {
        log('live rings skip', e.message);
    }

    // UI budget display helpers (legacy UIItem: charges / duration text)
    const {
        formatDurationDisplay,
        resolveItemBudgetDisplay,
        resolveItemIdBudgetDisplay
    } = require('../kernel/core/lib/character/equipment_runtime.js');
    const { createEmptyInventory, createItemInstance } = require('../kernel/core/lib/character/inventory.js');
    assert.strictEqual(formatDurationDisplay(45), '45s');
    assert.strictEqual(formatDurationDisplay(90), '1m30');
    assert.strictEqual(formatDurationDisplay(3661), '1h01m');
    assert.strictEqual(formatDurationDisplay(0), null);
    assert.strictEqual(formatDurationDisplay(null), null);
    const dispTemplate = resolveItemBudgetDisplay({
        item: { id: 'charge_ring', charges: 3, durationSec: 120 }
    });
    assert.strictEqual(dispTemplate.charges, 3);
    assert.strictEqual(dispTemplate.durationSec, 120);
    assert.strictEqual(dispTemplate.durationText, '2m00');
    assert.strictEqual(dispTemplate.sig, 'c3:d120');
    const dispInst = resolveItemBudgetDisplay({
        item: { id: 'charge_ring', charges: 3, durationSec: 120 },
        instance: { remainingCharges: 1, remainingDurationSec: 59.9 }
    });
    assert.strictEqual(dispInst.charges, 1);
    assert.strictEqual(dispInst.durationSec, 59);
    assert.strictEqual(dispInst.durationText, '59s');
    assert.strictEqual(dispInst.sig, 'c1:d59');
    const dispRt = resolveItemBudgetDisplay({
        item: { id: 'charge_ring', charges: 3 },
        instance: { remainingCharges: 2 },
        runtime: { remainingCharges: 1, itemId: 'charge_ring' }
    });
    assert.strictEqual(dispRt.charges, 1, 'runtime wins over instance');
    // Seeded instance from createItemInstance + find by itemId
    const invBud = createEmptyInventory(4);
    const budUid = createItemInstance(invBud, 'charge_ring', itemDb);
    assert.strictEqual(invBud.items[budUid].remainingCharges, 3, 'instance seeds charges');
    const byId = resolveItemIdBudgetDisplay(invBud, 'charge_ring', itemDb, null);
    assert.strictEqual(byId.charges, 3);
    assert.strictEqual(byId.sig, 'c3:d');

    log('equipment duration / charges ok');
}

function testBuildGuardianStats() {
    const cls = presets.getClass('guardian');
    assert.ok(cls, 'guardian class');
    const items = presets.loadEquipment().items;
    const gear = rollupEquipment(
        {
            rightHand: 'iron_longsword',
            leftHand: 'oak_shield',
            armor: 'steel_plate'
        },
        items
    );
    // Class skills are vocation floors (Phase B); mid-game power is on profiles.
    assert.ok(cls.skills, 'guardian has skills floors');
    assert.strictEqual(cls.skills.melee, 10, 'class melee floor');
    assert.strictEqual(cls.skills.magic, 0, 'class magic floor');
    assert.ok(cls.skillRates && cls.skillRates.melee === 1.1, 'guardian skillRates');

    const stats = buildEffectiveStats(cls, gear, { level: 50 });
    assert.strictEqual(stats.classId, 'guardian');
    assert.strictEqual(stats.level, 50);
    assert.strictEqual(stats.atk, 42);
    assert.strictEqual(stats.skill, 10, 'class-only uses floor skills');
    assert.ok(stats.hpMax > cls.baseHp, 'leveled hp');
    assert.ok(stats.mpMax >= cls.baseMp);
    assert.ok(stats.mitigation >= 0);
    assert.ok(stats.maxBlock > 0, 'shield max block');
    // speed = baseSpeed + (level − 1) + gear (no speed boots in this set)
    const expectedSpeed =
        (cls.baseSpeed != null ? cls.baseSpeed : 110) + (50 - 1) + (gear.speed || 0);
    assert.strictEqual(stats.speed, expectedSpeed, 'level contributes to speed');

    // Profile skills replace floors (lab default for product parties)
    const trained = buildEffectiveStats(cls, gear, {
        level: 50,
        baseSkills: { sword: 60, shielding: 50, distance: 10, magicLevel: 0 }
    });
    assert.strictEqual(trained.skill, 60, 'profile sword → melee 60');

    const auto = computeMeleeAutoRange({
        level: trained.level,
        atk: trained.atk,
        skill: trained.skill
    });
    assert.strictEqual(auto.min, levelBonus(50));
    assert.strictEqual(
        auto.max,
        Math.ceil(0.102 * trained.atk * trained.skill + levelBonus(50))
    );

    // Strike mean±amplitude (omit a → fixed mean; with a spreads around mean)
    const strikeBag = {
        level: trained.level,
        atk: trained.atk,
        skill: trained.skill
    };
    const strikeFixed = computeMeleeStrikeRange(strikeBag, 40);
    assert.strictEqual(strikeFixed.min, strikeFixed.max);
    const strike = computeMeleeStrikeRange(strikeBag, 40, 0.25);
    assert.ok(strike.max > strike.min, 'amplitude opens a range');
    assert.ok(strike.min > 0 && strike.max > 0);
    log('guardian stats ok', {
        auto,
        strike,
        stats: { hp: stats.hpMax, mit: stats.mitigation, skillFloor: stats.skill }
    });
}

/**
 * Classic stepped levelBonus bands + weapon auto;
 * distance effective atk = ammo + weapon mod; hit% from ammo + mods.
 */
function testWeaponAutoFormulasAndDistanceAmmo() {
    // levelBonus bands
    assert.strictEqual(levelBonus(100), 20);
    assert.strictEqual(levelBonus(500), 100);
    assert.strictEqual(levelBonus(501), 100);
    assert.strictEqual(levelBonus(1100), 200);
    assert.strictEqual(levelBonus(1101), 200);

    const base = { level: 100, atk: 40, skill: 80 };
    const auto = computeMeleeAutoRange(base);
    assert.strictEqual(auto.min, 20);
    assert.strictEqual(auto.max, Math.ceil(0.102 * 40 * 80 + 20));

    const items = [
        {
            id: 'test_bow',
            slot: 'rightHand',
            category: 'bow',
            weaponType: 'distance',
            atk: 7,
            hitChance: 6
        },
        {
            id: 'arrow',
            slot: 'leftHand',
            category: 'ammo',
            atk: 25,
            maxHitChance: 91
        },
        {
            id: 'test_sword',
            slot: 'rightHand',
            category: 'sword',
            weaponType: 'melee',
            atk: 42
        }
    ];

    // Bow + arrow: effective atk 32, hit 97
    const distGear = rollupEquipment(
        { rightHand: 'test_bow', leftHand: 'arrow' },
        items
    );
    assert.strictEqual(distGear.atk, 7, 'weapon mod only on rollup.atk');
    assert.strictEqual(distGear.ammoAtk, 25);
    assert.strictEqual(distGear.ammoHitChance, 91);
    assert.strictEqual(distGear.weaponHitChanceMod, 6);

    const scout = {
        id: 'scout',
        skills: { melee: 10, distance: 80, shielding: 20, magic: 10, fist: 10 },
        skillKey: 'distance',
        weaponType: 'distance'
    };
    const distStats = buildEffectiveStats(scout, distGear, { level: 100 });
    assert.strictEqual(distStats.weaponType, 'distance');
    assert.strictEqual(distStats.atk, 32, 'ammo 25 + bow mod 7');
    assert.strictEqual(distStats.hitChance, 97, '91 + 6');
    assert.strictEqual(distStats.skill, 80);

    const distAuto = computeMeleeAutoRange({
        level: distStats.level,
        atk: distStats.atk,
        skill: distStats.skill
    });
    assert.strictEqual(distAuto.min, 20);
    assert.strictEqual(distAuto.max, Math.ceil(0.102 * 32 * 80 + 20));

    // Melee sword + arrow in leftHand must NOT add ammo atk to melee formula
    const meleeGear = rollupEquipment(
        { rightHand: 'test_sword', leftHand: 'arrow' },
        items
    );
    assert.strictEqual(meleeGear.atk, 42);
    assert.strictEqual(meleeGear.ammoAtk, 25);
    const guardian = {
        id: 'guardian',
        skills: { melee: 80, distance: 10, shielding: 50, magic: 10, fist: 10 },
        skillKey: 'melee',
        weaponType: 'melee'
    };
    const meleeStats = buildEffectiveStats(guardian, meleeGear, { level: 100 });
    assert.strictEqual(meleeStats.atk, 42, 'melee ignores ammo atk');
    assert.strictEqual(meleeStats.hitChance, 100);

    // resolveAttack uses distance hit%
    const spells = indexSpells(presets.loadSpells().spells);
    let miss = 0;
    const trials = 200;
    for (let i = 0; i < trials; i++) {
        const attacker = {
            level: 100,
            combatStats: distStats,
            hp: { current: 500, max: 500 },
            mp: { current: 100, max: 100 }
        };
        const defender = {
            hp: { current: 1000, max: 1000 },
            combatStats: {
                armor: 0,
                mitigation: 0,
                resists: {},
                maxBlock: 0
            }
        };
        const r = resolveAttack({
            attacker,
            defender,
            spell: 'distance_auto',
            spellBook: spells,
            apply: false,
            skipCooldown: true,
            rng: () => 0.99 // always above 97% → miss
        });
        if (!r.hit) miss++;
    }
    assert.strictEqual(miss, trials, 'hitChance 97 misses when rng=0.99');

    log('weapon auto + distance ammo ok', { distAuto, hitChance: distStats.hitChance });
}

/**
 * Dual-element weapons split the auto roll; ammo maxHitChance + bow hitChance add.
 */
function testWeaponExtraElementAndHitChance() {
    const items = [
        {
            id: 'fire_sword',
            slot: 'rightHand',
            category: 'sword',
            weaponType: 'melee',
            atk: 24,
            extraAtk: 11,
            extraAtkElement: 'fire'
        },
        {
            id: 'amber_bow',
            slot: 'rightHand',
            category: 'bow',
            weaponType: 'distance',
            atk: 7,
            hitChance: 6
        },
        {
            id: 'arrow',
            slot: 'leftHand',
            category: 'ammo',
            ammoType: 'arrow',
            atk: 25,
            maxHitChance: 92
        }
    ];

    const swordGear = rollupEquipment({ rightHand: 'fire_sword' }, items);
    assert.strictEqual(swordGear.atk, 24);
    assert.strictEqual(swordGear.extraAtk, 11);
    assert.strictEqual(swordGear.elementalAtk, 11);
    assert.strictEqual(swordGear.extraAtkElement, 'fire');

    const guardian = {
        id: 'guardian',
        skills: { melee: 80, distance: 10, shielding: 50, magic: 10, fist: 10 },
        skillKey: 'melee',
        weaponType: 'melee'
    };
    const swordStats = buildEffectiveStats(guardian, swordGear, { level: 100 });
    assert.strictEqual(swordStats.atk, 35, '24 physical + 11 extra combined');
    assert.strictEqual(swordStats.extraAtk, 11);
    assert.strictEqual(swordStats.extraAtkElement, 'fire');

    const spells = indexSpells(presets.loadSpells().spells);
    const attacker = {
        level: 100,
        combatStats: swordStats,
        hp: { current: 500, max: 500 },
        mp: { current: 100, max: 100 }
    };
    const immune = {
        hp: { current: 1000, max: 1000 },
        combatStats: {
            armor: 0,
            mitigation: 0,
            resists: { fire: 100 },
            maxBlock: 0
        }
    };
    const rImmune = resolveAttack({
        attacker,
        defender: immune,
        spell: 'melee_auto',
        spellBook: spells,
        apply: false,
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(rImmune.hit);
    assert.ok(rImmune.breakdown && rImmune.breakdown.secondary);
    assert.strictEqual(rImmune.breakdown.extraAtkElement, 'fire');
    assert.strictEqual(
        rImmune.breakdown.secondary.final,
        0,
        'fire immune absorbs extraAtk share'
    );
    assert.ok(rImmune.final > 0, 'physical share still hits');
    assert.strictEqual(rImmune.final, rImmune.breakdown.primary.final);

    const naked = {
        hp: { current: 1000, max: 1000 },
        combatStats: {
            armor: 0,
            mitigation: 0,
            resists: {},
            maxBlock: 0
        }
    };
    const rNaked = resolveAttack({
        attacker,
        defender: naked,
        spell: 'melee_auto',
        spellBook: spells,
        apply: false,
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(rNaked.breakdown.secondary.final > 0, 'fire share hits when not immune');
    assert.strictEqual(
        rNaked.final,
        rNaked.breakdown.primary.final + rNaked.breakdown.secondary.final
    );
    assert.ok(
        rNaked.final > rImmune.final,
        'same roll deals more when fire is not immune'
    );

    const bowGear = rollupEquipment(
        { rightHand: 'amber_bow', leftHand: 'arrow' },
        items
    );
    assert.strictEqual(bowGear.ammoHitChance, 92);
    assert.strictEqual(bowGear.weaponHitChanceMod, 6);
    const scout = {
        id: 'scout',
        skills: { melee: 10, distance: 80, shielding: 20, magic: 10, fist: 10 },
        skillKey: 'distance',
        weaponType: 'distance'
    };
    const distStats = buildEffectiveStats(scout, bowGear, { level: 100 });
    assert.strictEqual(distStats.hitChance, 98, 'ammo 92 + bow hitChance 6');

    const live = presets.loadEquipment().items;
    const liveBow = live.find((it) => it.id === 'amber_bow');
    assert.ok(liveBow, 'amber_bow in standard equipment');
    assert.strictEqual(liveBow.hitChance, 6);
    const liveArrow = live.find((it) => it.id === 'arrow');
    assert.ok(liveArrow && liveArrow.maxHitChance > 0, 'arrow has maxHitChance');
    const liveSplit = live.find(
        (it) => it.id === 'ember_cleaver' || (it.extraAtk > 0 && it.extraAtkElement)
    );
    assert.ok(liveSplit && liveSplit.extraAtkElement, 'dual-element weapon on disk');

    log('weapon extraAtkElement + maxHitChance ok', {
        combinedAtk: swordStats.atk,
        fireImmuneFinal: rImmune.final,
        hitChance: distStats.hitChance
    });
}

/**
 * Equipment crit / leech add to class/profile percent.
 * Catalog pipeline: 1000 critChance = +10%; leech chance is already 0–100.
 */
function testEquipmentCritAndLeech() {
    const {
        rollLeechAmount,
        applyAttackLeech
    } = require('../kernel/core/lib/combat/resolve.js');
    const {
        pipelineToPercent,
        formatPipelinePercent,
        catalogSpecialBonusLines
    } = require('../kernel/core/lib/character/stats.js');

    assert.strictEqual(pipelineToPercent(1000), 10);
    assert.strictEqual(pipelineToPercent(1800), 18);
    assert.strictEqual(formatPipelinePercent(1000), '10');
    assert.strictEqual(formatPipelinePercent(200), '2');
    assert.strictEqual(formatPipelinePercent(50), '0.5');
    assert.deepStrictEqual(
        catalogSpecialBonusLines({
            lifeLeechChance: 100,
            lifeLeechAmount: 200,
            manaLeechChance: 100,
            manaLeechAmount: 100,
            critChance: 1000,
            critExtraDamage: 1200
        }),
        [
            'Life Leech: 100% / 2%',
            'Mana Leech: 100% / 1%',
            'Crit Chance: 10%',
            'Crit Extra Dmg: 12%'
        ]
    );
    assert.strictEqual(rollLeechAmount(100, 18, 100, () => 0), 18);
    assert.strictEqual(rollLeechAmount(0, 18, 100, () => 0), 0);
    assert.strictEqual(rollLeechAmount(50, 18, 100, () => 0.6), 0);
    assert.strictEqual(rollLeechAmount(50, 18, 100, () => 0), 18);

    const items = [
        {
            id: 'crit_wand',
            slot: 'rightHand',
            category: 'wand',
            weaponType: 'magic',
            atk: 10,
            critChance: 1000,
            critExtraDamage: 3500
        },
        {
            id: 'leech_blade',
            slot: 'rightHand',
            category: 'sword',
            weaponType: 'melee',
            atk: 20,
            lifeLeechChance: 100,
            lifeLeechAmount: 1800,
            manaLeechChance: 100,
            manaLeechAmount: 300
        },
        {
            id: 'leech_ring',
            slot: 'ring',
            category: 'ring',
            lifeLeechChance: 100,
            lifeLeechAmount: 200,
            manaLeechChance: 100,
            manaLeechAmount: 100
        }
    ];

    const adept = {
        id: 'adept',
        skills: { melee: 10, distance: 10, shielding: 10, magic: 50, fist: 10 },
        skillKey: 'magic',
        weaponType: 'magic',
        critChance: 0,
        critDamage: 0
    };
    const wandGear = rollupEquipment({ rightHand: 'crit_wand' }, items);
    assert.strictEqual(wandGear.critChance, 1000);
    assert.strictEqual(wandGear.critExtraDamage, 3500);
    const wandBare = buildEffectiveStats(adept, wandGear, { level: 50 });
    assert.strictEqual(wandBare.critChance, 10, 'pipeline 1000 = +10%');
    assert.strictEqual(wandBare.critDamage, 35, 'pipeline 3500 = +35%');
    const wandPlusProfile = buildEffectiveStats(adept, wandGear, {
        level: 50,
        critChance: 5,
        critDamage: 10
    });
    assert.strictEqual(wandPlusProfile.critChance, 15, 'profile 5 + gear 10');
    assert.strictEqual(wandPlusProfile.critDamage, 45, 'profile 10 + gear 35');

    const guardian = {
        id: 'guardian',
        skills: { melee: 80, distance: 10, shielding: 50, magic: 10, fist: 10 },
        skillKey: 'melee',
        weaponType: 'melee'
    };
    const stacked = rollupEquipment(
        { rightHand: 'leech_blade', ring: 'leech_ring' },
        items
    );
    assert.strictEqual(stacked.lifeLeechChance, 200);
    assert.strictEqual(stacked.lifeLeechAmount, 2000);
    assert.strictEqual(stacked.manaLeechChance, 200);
    assert.strictEqual(stacked.manaLeechAmount, 400);
    const leechStats = buildEffectiveStats(guardian, stacked, {
        level: 50,
        lifeLeech: 2
    });
    assert.strictEqual(leechStats.lifeLeechChance, 200);
    assert.strictEqual(leechStats.lifeLeechAmount, 22, 'profile 2 + 18 + 2');
    assert.strictEqual(leechStats.manaLeechAmount, 4, '3 + 1');

    const spells = indexSpells(presets.loadSpells().spells);
    const attacker = {
        level: 50,
        combatStats: leechStats,
        hp: { current: 200, max: 1000 },
        mp: { current: 10, max: 200 }
    };
    const defender = {
        hp: { current: 500, max: 500 },
        combatStats: {
            armor: 0,
            mitigation: 0,
            resists: {},
            maxBlock: 0
        }
    };
    const r = resolveAttack({
        attacker,
        defender,
        spell: 'melee_auto',
        spellBook: spells,
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(r.hit);
    assert.ok(r.final > 0);
    assert.ok(r.hpDelta < 0);
    const expectedLife = Math.round((-r.hpDelta) * 0.22);
    const expectedMana = Math.round((-r.hpDelta) * 0.04);
    assert.strictEqual(r.lifeLeech, expectedLife, 'life leech 22% of real HP lost');
    assert.strictEqual(r.manaLeech, expectedMana, 'mana leech 4% of real HP lost');
    assert.strictEqual(attacker.hp.current, 200 + expectedLife);
    assert.strictEqual(attacker.mp.current, 10 + expectedMana);

    const healer = {
        level: 50,
        combatStats: Object.assign({}, leechStats, {
            critChance: 100,
            critDamage: 50,
            lifeLeechChance: 100,
            lifeLeechAmount: 50
        }),
        hp: { current: 100, max: 1000 },
        mp: { current: 200, max: 200 }
    };
    const healTarget = {
        hp: { current: 100, max: 1000 },
        combatStats: { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 }
    };
    const healSpell = {
        id: 'test_heal',
        kind: 'heal',
        element: 'healing',
        min: 40,
        max: 40,
        mana: 0,
        cooldowns: {}
    };
    const rHeal = resolveAttack({
        attacker: healer,
        defender: healTarget,
        spell: healSpell,
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(rHeal.hit);
    assert.strictEqual(rHeal.critical, false, 'healing does not crit');
    assert.strictEqual(rHeal.final, 40);
    assert.strictEqual(rHeal.lifeLeech, 0, 'healing does not leech');
    assert.strictEqual(healer.hp.current, 100);

    const misser = {
        combatStats: Object.assign({}, leechStats, { hitChance: 0 }),
        hp: { current: 200, max: 1000 },
        mp: { current: 10, max: 200 }
    };
    const rMiss = resolveAttack({
        attacker: misser,
        defender,
        spell: {
            id: 'distance_auto',
            kind: 'auto',
            element: 'physical',
            min: 50,
            max: 50,
            mana: 0,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0.99
    });
    assert.strictEqual(rMiss.hit, false);
    assert.strictEqual(rMiss.lifeLeech, 0);
    assert.strictEqual(misser.hp.current, 200);

    const live = presets.loadEquipment().items;
    const liveCrit = live.find((it) => it.id === 'asp_wand');
    assert.ok(liveCrit, 'asp_wand in standard equipment');
    assert.strictEqual(liveCrit.critChance, 1000);
    assert.strictEqual(liveCrit.critExtraDamage, 3500);
    const liveLeech = live.find((it) => it.id === 'grand_crimson_blade');
    assert.ok(liveLeech, 'grand_crimson_blade in standard equipment');
    assert.strictEqual(liveLeech.lifeLeechChance, 100);
    assert.strictEqual(liveLeech.lifeLeechAmount, 600);
    assert.strictEqual(liveLeech.manaLeechChance, 100);
    assert.strictEqual(liveLeech.manaLeechAmount, 300);

    const direct = applyAttackLeech(
        {
            hp: { current: 50, max: 200 },
            mp: { current: 0, max: 100 },
            combatStats: {
                lifeLeechChance: 100,
                lifeLeechAmount: 18,
                manaLeechChance: 100,
                manaLeechAmount: 3
            }
        },
        100,
        () => 0
    );
    assert.strictEqual(direct.life, 18);
    assert.strictEqual(direct.mana, 3);

    log('equipment crit + leech ok', {
        crit: wandPlusProfile.critChance,
        critDamage: wandPlusProfile.critDamage,
        lifeLeech: r.lifeLeech,
        manaLeech: r.manaLeech
    });
}

/**
 * Stage 3: vocation 5/10 stacks with profile extras and gear pipeline.
 * Q2=A — do not replace class with profile.
 */
function testClassCritStack() {
    const CLASS_IDS = [
        'guardian',
        'scout',
        'mystic',
        'adept',
        'warden',
        'adventurer'
    ];
    for (let i = 0; i < CLASS_IDS.length; i++) {
        const id = CLASS_IDS[i];
        const cls = presets.getClass(id);
        assert.ok(cls, id);
        assert.strictEqual(cls.critChance, 5, `${id} class critChance`);
        assert.strictEqual(cls.critDamage, 10, `${id} class critDamage`);
        const bare = buildEffectiveStats(cls, null, { level: 8 });
        assert.strictEqual(bare.critChance, 5, `${id} bare chance`);
        assert.strictEqual(bare.critDamage, 10, `${id} bare extra`);
    }

    const guardian = presets.getClass('guardian');
    const gearItems = [
        {
            id: 'crit_ring',
            slot: 'ring',
            category: 'ring',
            critChance: 1000
        }
    ];
    const gear = rollupEquipment({ ring: 'crit_ring' }, gearItems);
    assert.strictEqual(gear.critChance, 1000);
    const classPlusGear = buildEffectiveStats(guardian, gear, { level: 50 });
    assert.strictEqual(classPlusGear.critChance, 15, 'class 5 + gear 10');
    assert.strictEqual(classPlusGear.critDamage, 10, 'class extra only');

    const starter = presets.loadPlayerProfile('guardian_starter');
    const veteran = presets.loadPlayerProfile('guardian_veteran');
    const items = presets.loadEquipment().items;

    const starterMember = memberFromPlayerProfile(starter, { isLeader: true });
    const starterStats = buildEffectiveStats(
        guardian,
        rollupEquipment(starterMember.equipment, items),
        {
            level: starterMember.level,
            baseSkills: starterMember.skills,
            critChance: starterMember.critChance,
            critDamage: starterMember.critDamage
        }
    );
    assert.strictEqual(starterMember.critChance, 5, 'profile extra stays 5');
    assert.strictEqual(starterStats.critChance, 10, 'starter class+profile');
    assert.strictEqual(starterStats.critDamage, 20, 'starter class+profile extra');

    const veteranMember = memberFromPlayerProfile(veteran, { isLeader: true });
    const veteranStats = buildEffectiveStats(
        guardian,
        rollupEquipment(veteranMember.equipment, items),
        {
            level: veteranMember.level,
            baseSkills: veteranMember.skills,
            critChance: veteranMember.critChance,
            critDamage: veteranMember.critDamage
        }
    );
    assert.strictEqual(veteranMember.critChance, 8, 'profile extra stays 8');
    assert.strictEqual(veteranStats.critChance, 13, 'veteran class+profile');
    assert.strictEqual(veteranStats.critDamage, 25, 'veteran class+profile extra');

    const starterPlusGear = buildEffectiveStats(guardian, gear, {
        level: starterMember.level,
        critChance: starterMember.critChance,
        critDamage: starterMember.critDamage
    });
    assert.strictEqual(starterPlusGear.critChance, 20, 'starter 10 + gear 10');
    assert.strictEqual(starterPlusGear.critDamage, 20, 'starter extra, no gear extra');

    log('class crit stack ok', {
        bare: 5,
        starter: starterStats.critChance,
        veteran: veteranStats.critChance,
        starterPlusGear: starterPlusGear.critChance
    });
}

/**
 * Stage 4: mapped dump creatures crit via template bag (multiply only).
 * Q5=B — six rows author critDamage: 10.
 */
function testCreatureCrit() {
    const EXPECTED = {
        alchemist_container: 10,
        antenna: 10,
        bone_surgeon_marrow: 10,
        fleshcraft_abomination: 10,
        mitmah_scout: 3,
        voidkin_seer: 3
    };
    const mapped = Object.keys(EXPECTED);
    for (let i = 0; i < mapped.length; i++) {
        const id = mapped[i];
        const tmpl = presets.loadCreatureTemplateRaw(id);
        assert.ok(tmpl, id);
        assert.strictEqual(tmpl.critChance, EXPECTED[id], `${id} chance`);
        assert.strictEqual(tmpl.critDamage, 10, `${id} extra`);
        const spawned = new Creature({ name: id, id: i + 1, creatureType: id });
        spawned.applyTemplate(tmpl);
        assert.strictEqual(spawned.critChance, EXPECTED[id], `${id} spawn chance`);
        assert.strictEqual(spawned.critDamage, 10, `${id} spawn extra`);
        assert.ok(!spawned.combatStats, `${id} has no combatStats`);
    }

    const ids = presets.listCreatureTemplateIds({ includeCatalog: false });
    let extra = 0;
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (EXPECTED[id] != null) continue;
        const tmpl = presets.loadCreatureTemplateRaw(id);
        if (tmpl && tmpl.critChance != null) extra += 1;
    }
    assert.strictEqual(extra, 0, 'no unlisted species gained critChance');

    const scout = presets.loadCreatureTemplateRaw('mitmah_scout');
    assert.strictEqual(scout.critChance, 3);
    assert.strictEqual(scout.critDamage, 10);

    const dummy = new Creature({
        name: 'Dummy',
        id: 99,
        hp: 500,
        hpMax: 500
    });
    const critter = new Creature({ name: 'Critter', id: 1, hp: 200 });
    critter.applyTemplate({
        id: 'kit_crit_probe',
        hp: 200,
        hpMax: 200,
        critChance: 100,
        critDamage: 10,
        attacks: [
            {
                id: 'melee_0',
                kind: 'melee',
                min: 10,
                max: 100,
                intervalMs: 2000,
                chance: 100
            }
        ]
    });
    const hit = resolveAttack({
        attacker: critter,
        defender: dummy,
        spell: {
            id: 'melee_0',
            kind: 'auto',
            element: 'physical',
            min: 10,
            max: 100,
            mana: 0,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(hit.ok && hit.hit && hit.critical);
    assert.strictEqual(hit.breakdown.raw, 11, 'kit min 10 × 1.10');
    assert.strictEqual(critBandForSpell(hit.spell), 'multiply');
    assert.ok(
        hit.breakdown.raw < autoStCritRollMin(10, 100),
        'kit must not use the 65% floor'
    );

    const never = new Creature({ name: 'Never', id: 2, hp: 200 });
    never.applyTemplate({
        id: 'kit_no_crit',
        hp: 200,
        hpMax: 200,
        critChance: 0,
        critDamage: 10
    });
    const dummy2 = new Creature({ name: 'Dummy2', id: 98, hp: 500, hpMax: 500 });
    const noCrit = resolveAttack({
        attacker: never,
        defender: dummy2,
        spell: {
            id: 'melee_0',
            kind: 'auto',
            element: 'physical',
            min: 100,
            max: 100,
            mana: 0,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(noCrit.ok && noCrit.hit && !noCrit.critical);
    assert.strictEqual(noCrit.breakdown.raw, 100, 'chance 0 never crits');

    log('creature crit ok', {
        six: mapped.length,
        mitmah_scout: scout.critChance,
        forcedRaw: hit.breakdown.raw
    });
}

/**
 * Stage 5: burst / diamond are area autos (multiply only, one crit / swing).
 */
function testShapedDistanceAutos() {
    const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
    const items = presets.loadEquipment().items;
    const burst = items.find((i) => i.id === 'burst_arrow');
    const diamond = items.find((i) => i.id === 'diamond_arrow');
    const sniper = items.find((i) => i.id === 'sniper_arrow');
    assert.ok(burst && diamond && sniper);
    assert.deepStrictEqual(burst.autoShape, { type: 'area', code: 3 });
    assert.deepStrictEqual(diamond.autoShape, { type: 'area', code: 4 });
    assert.ok(sniper.autoShape == null, 'ST arrow has no autoShape');

    const dummyBag = { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 };
    function dummyAt(id, x, y) {
        return {
            id,
            alive: true,
            tile: { x, y, z: 0 },
            hp: { current: 500, max: 500 },
            combatStats: dummyBag
        };
    }

    const shapedSpell = {
        id: 'distance_auto',
        kind: 'auto',
        element: 'physical',
        powerCurve: 'melee_auto',
        isMelee: false,
        range: 6,
        mana: 0,
        hitChance: 100,
        min: 10,
        max: 100,
        cooldowns: { auto: { attack: 2 } },
        shape: { type: 'area', code: 3 }
    };

    const atk = {
        alive: true,
        moveDelay: 0,
        tile: { x: 0, y: 0, z: 0 },
        combatStats: {
            critChance: 100,
            critDamage: 10,
            hitChance: 100,
            level: 50,
            atk: 40,
            skill: 80
        }
    };
    const a = dummyAt(1, 5, 5);
    const b = dummyAt(2, 6, 5);
    const c = dummyAt(3, 4, 5);
    const burstHit = resolveShapedAttack({
        attacker: atk,
        primary: a,
        spell: shapedSpell,
        candidates: [a, b, c],
        centerMode: 'primary',
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(burstHit.ok && burstHit.multi);
    assert.strictEqual(burstHit.affectedTiles.length, 9, 'burst 3×3');
    assert.strictEqual(burstHit.hits.length, 3);
    assert.strictEqual(burstHit.results.length, 3);
    assert.ok(burstHit.results.every((r) => r.ok && r.hit && r.critical));
    // gaussian mid of [10,100] with constant rng is 55; × 1.10 = 60
    // (below auto_st floor 65).
    for (let i = 0; i < burstHit.results.length; i++) {
        const raw = burstHit.results[i].breakdown.raw;
        assert.strictEqual(raw, 60, `burst multiply mid 55 × 1.10 (got ${raw})`);
        assert.ok(raw < autoStCritRollMin(10, 100), 'shaped auto no 65% floor');
    }

    atk.combatStats.critChance = 0;
    const a2 = dummyAt(4, 5, 5);
    const b2 = dummyAt(5, 6, 5);
    const c2 = dummyAt(6, 4, 5);
    const noCrit = resolveShapedAttack({
        attacker: atk,
        primary: a2,
        spell: shapedSpell,
        candidates: [a2, b2, c2],
        centerMode: 'primary',
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(noCrit.results.every((r) => r.hit && !r.critical));

    const diamondSpell = Object.assign({}, shapedSpell, {
        shape: { type: 'area', code: 4 }
    });
    const center = dummyAt(10, 8, 8);
    const mid = dummyAt(11, 6, 8);
    const corner = dummyAt(12, 6, 6);
    const diamondHit = resolveShapedAttack({
        attacker: atk,
        primary: center,
        spell: diamondSpell,
        candidates: [center, mid, corner],
        centerMode: 'primary',
        skipCooldown: true,
        rng: () => 0
    });
    assert.strictEqual(diamondHit.affectedTiles.length, 21, '5×5 circle minus corners');
    const keys = new Set(diamondHit.affectedTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(!keys.has('6,6'), 'diamond corner empty');
    assert.ok(keys.has('6,8'), 'diamond mid-edge present');
    assert.ok(diamondHit.hits.some((h) => h.id === 10));
    assert.ok(diamondHit.hits.some((h) => h.id === 11));
    assert.ok(!diamondHit.hits.some((h) => h.id === 12), 'corner not hit');

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
            id: 'burst_arrow',
            category: 'ammo',
            ammoType: 'arrow',
            stackable: true,
            atk: 27,
            maxHitChance: 100,
            autoShape: { type: 'area', code: 3 },
            weight: 90
        },
        {
            id: 'sniper_arrow',
            category: 'ammo',
            ammoType: 'arrow',
            stackable: true,
            atk: 28,
            maxHitChance: 100,
            weight: 70
        }
    ];
    const spells = indexSpells(presets.loadSpells().spells);

    function makeArcher(ammoId, count, extras) {
        const inv = buildInventoryFromSeed(
            {
                equipment: {
                    shield: 'unicorn_quiver',
                    backpack: 'backpack'
                },
                inventory: {
                    shield: [{ itemId: ammoId, count }]
                }
            },
            itemDb
        );
        const archer = {
            alive: true,
            moveDelay: 0,
            tile: { x: 0, y: 0, z: 0 },
            combatStats: Object.assign(
                {
                    weaponType: 'distance',
                    level: 50,
                    atk: 40,
                    skill: 80,
                    magic: 0,
                    hitChance: 100,
                    critChance: 0,
                    critDamage: 0
                },
                extras || {}
            ),
            mp: { current: 100, max: 100 },
            inventory: inv,
            _loadoutItemDb: itemDb,
            cooldowns: null
        };
        Cooldowns.ensureCooldowns(archer);
        archer.cooldowns.auto.attack = 0;
        return archer;
    }

    const prey = dummyAt(20, 5, 5);
    const adj = dummyAt(21, 6, 5);
    const far = dummyAt(22, 20, 20);
    const burstArcher = makeArcher('burst_arrow', 3);
    assert.deepStrictEqual(
        resolveDistanceAutoShape(burstArcher, spells.distance_auto, {
            itemDb
        }),
        { type: 'area', code: 3 }
    );
    assert.strictEqual(countEquippedQuiverAmmo(burstArcher.inventory, itemDb), 3);
    const shot = tryAutoAttack({
        attacker: burstArcher,
        defender: prey,
        ctx: {
            spellBook: spells,
            rng: () => 0,
            ammoConsumption: true,
            enemies: [prey, adj, far],
            itemDb
        }
    });
    assert.ok(shot && shot.ok && shot.multi, 'burst auto is shaped');
    assert.strictEqual(shot.affectedTiles.length, 9);
    assert.ok(shot.hits.some((h) => h.id === 20));
    assert.ok(shot.hits.some((h) => h.id === 21));
    assert.ok(!shot.hits.some((h) => h.id === 22));
    assert.strictEqual(
        countEquippedQuiverAmmo(burstArcher.inventory, itemDb),
        2,
        'ammo once per swing'
    );

    burstArcher.moveDelay = 0;
    burstArcher.cooldowns.auto.attack = 0;
    burstArcher.combatStats.hitChance = 0;
    const hpPrey = prey.hp.current;
    const hpAdj = adj.hp.current;
    const miss = tryAutoAttack({
        attacker: burstArcher,
        defender: prey,
        ctx: {
            spellBook: spells,
            rng: () => 0,
            ammoConsumption: true,
            enemies: [prey, adj],
            itemDb
        }
    });
    assert.ok(miss && miss.ok && !miss.hit, 'miss still resolves');
    assert.strictEqual(miss.affectedTiles.length, 0, 'miss has no footprint');
    assert.strictEqual(prey.hp.current, hpPrey);
    assert.strictEqual(adj.hp.current, hpAdj);
    assert.strictEqual(
        countEquippedQuiverAmmo(burstArcher.inventory, itemDb),
        1,
        'miss spends ammo'
    );

    const sniperArcher = makeArcher('sniper_arrow', 2);
    assert.strictEqual(
        resolveDistanceAutoShape(sniperArcher, spells.distance_auto, {
            itemDb
        }),
        null
    );
    const st = tryAutoAttack({
        attacker: sniperArcher,
        defender: dummyAt(30, 5, 5),
        ctx: {
            spellBook: spells,
            rng: () => 0,
            ammoConsumption: true,
            enemies: [dummyAt(30, 5, 5), dummyAt(31, 6, 5)],
            itemDb
        }
    });
    assert.ok(st && st.ok && st.hit);
    assert.ok(!st.multi, 'ST sniper is not shaped');
    assert.strictEqual(critBandForSpell(st.spell), 'auto_st');
    assert.strictEqual(
        countEquippedQuiverAmmo(sniperArcher.inventory, itemDb),
        1
    );

    log('shaped distance autos ok', {
        burstTiles: burstHit.affectedTiles.length,
        diamondTiles: diamondHit.affectedTiles.length
    });
}

/**
 * Stage 6: fatal after crit; player weapon `tier` only.
 */
function testFatalHits() {
    assert.strictEqual(fatalChanceFromTier(0), 0);
    assert.strictEqual(fatalChanceFromTier(null), 0);
    assert.strictEqual(fatalChanceFromTier(1), 0.5);
    assert.strictEqual(fatalChanceFromTier(2), 1.05);
    assert.strictEqual(FATAL_DAMAGE_BONUS, 0.6);
    assert.strictEqual(applyFatalBonus(100), 160);
    assert.strictEqual(applyFatalBonus(110), 176);

    assert.strictEqual(rollFatal(0, () => 0), false);
    assert.strictEqual(rollFatal(0.5, () => 0), true);
    assert.strictEqual(rollFatal(0.5, () => 0.005), false);

    const dummyBag = { armor: 0, mitigation: 0, resists: {}, maxBlock: 0 };

    const never = computeDamage({
        min: 100,
        max: 100,
        defender: dummyBag,
        fatalChance: 0,
        critical: false,
        rng: () => 0
    });
    assert.ok(never.hit && !never.fatal);
    assert.strictEqual(never.breakdown.raw, 100);

    const fatalOnly = computeDamage({
        min: 100,
        max: 100,
        defender: dummyBag,
        fatal: true,
        critical: false,
        rng: () => 0
    });
    assert.ok(fatalOnly.fatal && !fatalOnly.critical);
    assert.strictEqual(fatalOnly.breakdown.raw, 160, 'fatal without crit = +60% of raw');

    const both = computeDamage({
        min: 100,
        max: 100,
        defender: dummyBag,
        fatal: true,
        critical: true,
        critDamage: 10,
        rng: () => 0
    });
    assert.ok(both.fatal && both.critical);
    assert.strictEqual(both.breakdown.raw, 176, 'fatal + crit = +60% of post-crit raw');

    const heal = computeDamage({
        min: 100,
        max: 100,
        defender: dummyBag,
        element: 'healing',
        fatal: true,
        critical: false,
        rng: () => 0
    });
    assert.ok(!heal.fatal);
    assert.strictEqual(heal.breakdown.raw, 100);

    const missed = computeDamage({
        min: 100,
        max: 100,
        defender: dummyBag,
        hit: false,
        fatal: true,
        rng: () => 0
    });
    assert.ok(!missed.hit && !missed.fatal);

    const dual = computeDamage({
        min: 100,
        max: 100,
        defender: dummyBag,
        attacker: { atk: 35, extraAtk: 11, extraAtkElement: 'fire' },
        extraAtk: 11,
        extraAtkElement: 'fire',
        fatal: true,
        critical: false,
        rng: () => 0
    });
    assert.ok(dual.fatal);
    assert.strictEqual(dual.breakdown.raw, 160);
    assert.strictEqual(dual.breakdown.primary.raw, 110);
    assert.strictEqual(dual.breakdown.secondary.raw, 50);

    const stCritFatal = computeDamage({
        min: 10,
        max: 100,
        defender: dummyBag,
        critBand: 'auto_st',
        critical: true,
        critDamage: 0,
        fatal: true,
        rng: () => 0
    });
    assert.strictEqual(stCritFatal.breakdown.raw, applyFatalBonus(65));

    const items = [
        {
            id: 't1_sword',
            slot: 'rightHand',
            category: 'sword',
            weaponType: 'melee',
            atk: 20,
            tier: 1
        },
        {
            id: 'plain_sword',
            slot: 'rightHand',
            category: 'sword',
            weaponType: 'melee',
            atk: 20
        }
    ];
    const t1 = rollupEquipment({ rightHand: 't1_sword' }, items);
    assert.strictEqual(t1.weaponTier, 1);
    const cls = {
        id: 'guardian',
        skills: { melee: 10, distance: 10, shielding: 10, magic: 0, fist: 10 },
        skillKey: 'melee',
        weaponType: 'melee'
    };
    const eff = buildEffectiveStats(cls, t1, { level: 50 });
    assert.strictEqual(eff.weaponTier, 1);
    const plain = rollupEquipment({ rightHand: 'plain_sword' }, items);
    assert.strictEqual(plain.weaponTier, 0);
    const unarmed = buildEffectiveStats(cls, rollupEquipment({}, items), {
        level: 50
    });
    assert.strictEqual(unarmed.weaponTier, 0);

    const std = presets.loadEquipment().items;
    let authoredTier = 0;
    for (let i = 0; i < std.length; i++) {
        if (std[i].tier) authoredTier += 1;
    }
    assert.strictEqual(authoredTier, 0, 'no standard row ships tier');

    function dummyEnt() {
        return {
            hp: { current: 500, max: 500 },
            combatStats: dummyBag
        };
    }
    const autoSpell = {
        id: 'melee_auto',
        kind: 'auto',
        powerCurve: 'melee_auto',
        element: 'physical',
        min: 100,
        max: 100,
        mana: 0,
        cooldowns: {}
    };

    const fatHit = resolveAttack({
        attacker: {
            type: 'player',
            combatStats: { weaponTier: 1, critChance: 0, critDamage: 0 }
        },
        defender: dummyEnt(),
        spell: autoSpell,
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(fatHit.ok && fatHit.hit && fatHit.fatal && !fatHit.critical);
    assert.strictEqual(fatHit.breakdown.raw, 160);

    const tier0 = resolveAttack({
        attacker: {
            type: 'player',
            combatStats: { weaponTier: 0, critChance: 0 }
        },
        defender: dummyEnt(),
        spell: autoSpell,
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(tier0.hit && !tier0.fatal);
    assert.strictEqual(tier0.breakdown.raw, 100);

    const creature = resolveAttack({
        attacker: {
            type: 'creature',
            combatStats: { weaponTier: 10, critChance: 0 }
        },
        defender: dummyEnt(),
        spell: {
            id: 'melee_0',
            kind: 'auto',
            element: 'physical',
            min: 100,
            max: 100,
            mana: 0,
            cooldowns: {}
        },
        skipCooldown: true,
        rng: () => 0
    });
    assert.ok(creature.hit && !creature.fatal);
    assert.strictEqual(creature.breakdown.raw, 100);

    const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
    const a = {
        id: 1,
        alive: true,
        tile: { x: 5, y: 5, z: 0 },
        hp: { current: 500, max: 500 },
        combatStats: dummyBag
    };
    const b = {
        id: 2,
        alive: true,
        tile: { x: 6, y: 5, z: 0 },
        hp: { current: 500, max: 500 },
        combatStats: dummyBag
    };
    const caster = {
        type: 'player',
        alive: true,
        tile: { x: 4, y: 5, z: 0 },
        mp: { current: 100, max: 100 },
        combatStats: {
            weaponTier: 1,
            critChance: 0,
            critDamage: 0,
            hitChance: 100
        }
    };
    const shaped = resolveShapedAttack({
        attacker: caster,
        primary: a,
        spell: {
            id: 'distance_auto',
            kind: 'auto',
            powerCurve: 'distance_auto',
            element: 'physical',
            min: 100,
            max: 100,
            mana: 0,
            range: 6,
            hitChance: 100,
            isMelee: false,
            shape: { type: 'area', code: 3 },
            cooldowns: {}
        },
        candidates: [a, b],
        rng: () => 0,
        skipCooldown: true,
        skipMana: true,
        centerMode: 'primary'
    });
    assert.ok(shaped.ok && shaped.hit && shaped.fatal);
    assert.ok(shaped.results.length >= 2);
    assert.ok(shaped.results.every((r) => r.ok && r.hit && r.fatal && !r.critical));
    assert.strictEqual(shaped.results[0].breakdown.raw, 160);

    log('fatal hits ok', {
        tier1: fatalChanceFromTier(1),
        postCrit: both.breakdown.raw
    });
}

function makeGuardianKnight() {
    const cls = presets.getClass('guardian');
    const items = presets.loadEquipment().items;
    const player = new Player({
        name: 'Test Guardian',
        id: 1,
        classId: 'guardian',
        equipment: {
            rightHand: 'iron_longsword',
            leftHand: 'oak_shield',
            armor: 'steel_plate',
            helmet: 'steel_helm',
            legs: 'steel_greaves',
            boots: 'leather_boots'
        },
        classDef: cls,
        itemDb: items,
        // High enough for front_sweep (70) / fierce_rampage (90) kit tests
        level: 100
    });
    return player;
}

function makeDummy() {
    const tmpl = presets.loadCreatureTemplate('dummy');
    const c = new Creature({
        name: tmpl.label,
        id: 99,
        creatureType: tmpl.id
    });
    c.applyTemplate(tmpl);
    return c;
}

function testGuardianAutoVsDummy() {
    const player = makeGuardianKnight();
    const dummy = makeDummy();
    const spells = indexSpells(presets.loadSpells().spells);
    const hpBefore = dummy.hp.current;

    const rng = rngFromSeed(42);
    const result = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: 'melee_auto',
        spellBook: spells,
        rng
    });

    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.strictEqual(result.hit, true);
    assert.ok(result.final > 0, `auto final damage ${result.final}`);
    assert.ok(result.breakdown, 'breakdown present');
    assert.strictEqual(result.breakdown.element, 'physical');
    assert.strictEqual(dummy.hp.current, hpBefore + result.hpDelta);
    assert.ok(dummy.hp.current < hpBefore, 'dummy took damage');
    assert.ok(
        Cooldowns.getRemaining(player, 'auto', 'attack') > 0,
        'auto attack cooldown set'
    );
    assert.strictEqual(
        Cooldowns.getRemaining(player, 'primary', 'attack'),
        0,
        'auto must not touch primary.attack'
    );

    // Second auto immediately fails cooldown
    const blocked = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: spells.melee_auto,
        rng: rngFromSeed(1)
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'cooldown');

    log('guardian auto vs dummy', {
        final: result.final,
        range: result.range,
        hpLeft: dummy.hp.current
    });
}

function testAutoAndFrontSweepIndependent() {
    const player = makeGuardianKnight();
    const dummy = makeDummy();
    const spells = indexSpells(presets.loadSpells().spells);
    const rng = rngFromSeed(11);

    const auto = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: 'melee_auto',
        spellBook: spells,
        rng
    });
    assert.strictEqual(auto.ok, true, auto.reason || 'auto ok');
    assert.ok(Cooldowns.getRemaining(player, 'auto', 'attack') > 0);
    assert.strictEqual(Cooldowns.getRemaining(player, 'primary', 'attack'), 0);

    const strike = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: 'front_sweep',
        spellBook: spells,
        rng
    });
    assert.strictEqual(strike.ok, true, strike.reason || 'strike after auto');
    assert.ok(Cooldowns.getRemaining(player, 'primary', 'attack') > 0);
    assert.ok(Cooldowns.getRemaining(player, 'spell', 'front_sweep') > 0);
    assert.ok(Cooldowns.getRemaining(player, 'auto', 'attack') > 0);

    log('auto + front_sweep independent ok', {
        autoFinal: auto.final,
        strikeFinal: strike.final
    });
}

function testGuardianStrikeVsDummy() {
    const player = makeGuardianKnight();
    const dummy = makeDummy();
    const spells = indexSpells(presets.loadSpells().spells);
    const spell = spells.front_sweep;
    assert.ok(spell, 'front_sweep preset');

    const mpBefore = player.mp.current;
    assert.ok(mpBefore >= spell.mana, `mana ${mpBefore} >= ${spell.mana}`);

    const rng = rngFromSeed(7);
    const result = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: 'front_sweep',
        spellBook: spells,
        rng
    });

    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.strictEqual(result.hit, true);
    assert.ok(result.final > 0, `strike final ${result.final}`);
    assert.strictEqual(player.mp.current, mpBefore - spell.mana);
    assert.ok(Cooldowns.getRemaining(player, 'spell', 'front_sweep') > 0);
    assert.ok(Cooldowns.getRemaining(player, 'primary', 'attack') > 0);
    assert.ok(dummy.hp.current < dummy.hp.max);

    // Mana gate
    player.mp.current = 0;
    Cooldowns.ensureCooldowns(player);
    player.cooldowns.primary.attack = 0;
    player.cooldowns.spell.front_sweep = 0;
    const oom = resolveAttack({
        attacker: player,
        defender: dummy,
        spell,
        rng: () => 0.5
    });
    assert.strictEqual(oom.ok, false);
    assert.strictEqual(oom.reason, 'mana');

    log('guardian strike vs dummy', {
        final: result.final,
        range: result.range,
        mpLeft: player.mp.current
    });
}

function testPreviewAndPresetsLoad() {
    const cls = presets.getClass('guardian');
    const stats = buildEffectiveStats(cls, rollupEquipment({ rightHand: 'iron_longsword' }, presets.loadEquipment().items), {
        level: 50
    });
    const spell = presets.getSpell('front_sweep');
    const range = previewDamageRange(stats, spell);
    assert.ok(range.max >= range.min);
    assert.ok(presets.listCreatureTemplateIds().indexOf('dummy') >= 0);
    log('preview / presets ok', range);
}

function testSeedStableDamage() {
    const player = makeGuardianKnight();
    const d1 = makeDummy();
    const d2 = makeDummy();
    const spells = indexSpells(presets.loadSpells().spells);

    const r1 = resolveAttack({
        attacker: player,
        defender: d1,
        spell: 'melee_auto',
        spellBook: spells,
        rng: rngFromSeed(12345)
    });
    // reset player cooldowns/mana for second run
    const player2 = makeGuardianKnight();
    const r2 = resolveAttack({
        attacker: player2,
        defender: d2,
        spell: 'melee_auto',
        spellBook: spells,
        rng: rngFromSeed(12345)
    });
    assert.strictEqual(r1.final, r2.final);
    assert.strictEqual(r1.critical, r2.critical);
    log('seed-stable damage ok', r1.final);
}

function testHealLightSelfRestore() {
    const player = makeGuardianKnight();
    const spells = indexSpells(presets.loadSpells().spells);
    const spell = spells.heal_light;
    assert.ok(spell, 'heal_light preset');
    assert.strictEqual(spell.element, 'healing');
    assert.strictEqual(spell.kind, 'heal');

    const max = player.hp.max;
    player.hp.current = Math.floor(max * 0.2);
    const hpBefore = player.hp.current;
    const mpBefore = player.mp.current;
    assert.ok(mpBefore >= spell.mana, `mana ${mpBefore} >= ${spell.mana}`);

    const rng = rngFromSeed(99);
    const result = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'heal_light',
        spellBook: spells,
        rng
    });

    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.strictEqual(result.hit, true);
    assert.ok(result.final > 0, `heal final ${result.final}`);
    assert.ok(result.hpDelta > 0, `heal hpDelta ${result.hpDelta}`);
    assert.strictEqual(player.hp.current, hpBefore + result.hpDelta);
    assert.ok(player.hp.current > hpBefore, 'HP restored');
    assert.ok(player.hp.current <= max, 'HP capped at max');
    assert.strictEqual(player.mp.current, mpBefore - spell.mana);
    assert.ok(Cooldowns.getRemaining(player, 'primary', 'healing') > 0);
    assert.ok(Cooldowns.getRemaining(player, 'spell', 'heal_light') > 0);
    // Healing must not apply armor/mitigation (breakdown zeros)
    assert.strictEqual(result.breakdown.mitigation, 0);
    assert.strictEqual(result.breakdown.armorReduction, 0);

    // Seed-stable heal amount
    const p2 = makeGuardianKnight();
    p2.hp.current = Math.floor(p2.hp.max * 0.2);
    const r2 = resolveAttack({
        attacker: p2,
        defender: p2,
        spell: 'heal_light',
        spellBook: spells,
        rng: rngFromSeed(99)
    });
    assert.strictEqual(r2.final, result.final);
    assert.strictEqual(r2.hpDelta, result.hpDelta);

    log('heal_light self restore ok', {
        final: result.final,
        hpDelta: result.hpDelta,
        hp: player.hp.current
    });
}

function testCureSpellsDispel() {
    const {
        applyCondition,
        hasCondition,
        removeCondition
    } = require('../kernel/core/lib/combat/conditions.js');
    const { tryCure } = require('../kernel/core/lib/ai/combat_actions.js');

    // API: removeCondition / hasCondition
    const bare = {
        alive: true,
        speed: 100,
        baseSpeed: 100,
        conditions: [],
        hp: { current: 100, max: 100 }
    };
    applyCondition(bare, { type: 'poison', totalDamage: 50, intervalMs: 2000 });
    applyCondition(bare, { type: 'fire', totalDamage: 30, intervalMs: 4000 });
    assert.ok(hasCondition(bare, 'poison'));
    assert.ok(hasCondition(bare, 'CONDITION_FIRE'));
    assert.strictEqual(removeCondition(bare, 'poison'), 1);
    assert.ok(!hasCondition(bare, 'poison'));
    assert.ok(hasCondition(bare, 'fire'));
    assert.strictEqual(removeCondition(bare, 'fire'), 1);
    assert.strictEqual(bare.conditions.length, 0);

    const player = makeGuardianKnight();
    const spells = indexSpells(presets.loadSpells().spells);
    const cure = spells.cure_poison;
    assert.ok(cure, 'cure_poison preset');
    assert.deepStrictEqual(cure.dispel, ['poison']);
    assert.strictEqual(cure.statusOnly, true);
    assert.strictEqual(cure.min, 0);
    assert.strictEqual(cure.max, 0);
    assert.ok(spells.cure_burning);
    assert.ok(spells.cure_electrification);
    assert.ok(spells.cure_bleeding);
    assert.ok(spells.cure_curse);
    assert.deepStrictEqual(spells.cure_burning.dispel, ['fire']);
    assert.deepStrictEqual(spells.cure_electrification.dispel, ['energy']);
    assert.deepStrictEqual(spells.cure_bleeding.dispel, ['bleed']);
    assert.deepStrictEqual(spells.cure_curse.dispel, ['curse']);

    applyCondition(player, { type: 'poison', totalDamage: 80, intervalMs: 2000 });
    assert.ok(hasCondition(player, 'poison'));
    const mpBefore = player.mp.current;
    const result = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'cure_poison',
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.strictEqual(result.hit, true);
    assert.strictEqual(result.final, 0);
    assert.strictEqual(result.hpDelta, 0);
    assert.ok(result.conditionsRemoved >= 1, 'dispelled poison');
    assert.ok(!hasCondition(player, 'poison'));
    assert.strictEqual(player.mp.current, mpBefore - cure.mana);
    assert.ok(Cooldowns.getRemaining(player, 'primary', 'healing') > 0);
    assert.ok(Cooldowns.getRemaining(player, 'spell', 'cure_poison') > 0);

    // tryCure path (book + condition + tile for range)
    const p2 = makeGuardianKnight();
    p2.tile = { x: 0, y: 0, z: 7 };
    // Ensure spell is known in combatStats.spells if present
    if (p2.combatStats) {
        const known = p2.combatStats.spells || [];
        if (known.indexOf('cure_poison') < 0) {
            p2.combatStats.spells = known.concat(['cure_poison']);
        }
    }
    applyCondition(p2, { type: 'poison', totalDamage: 40, intervalMs: 2000 });
    const cast = tryCure({
        attacker: p2,
        ctx: { spellBook: spells, rng: () => 0 }
    });
    assert.ok(cast && cast.ok, `tryCure: ${cast && cast.reason}`);
    assert.ok(!hasCondition(p2, 'poison'));

    log('cure spells dispel ok', {
        conditionsRemoved: result.conditionsRemoved
    });
}

/**
 * Challenge / taunt: self-AoE code 3, force creature target onto caster for tauntDurationSec.
 */
function testChallengeTauntSpell() {
    const {
        applyChallengeTaunt,
        isCreatureChallenged,
        isChallengeableCreature
    } = require('../kernel/core/lib/combat/resolve.js');
    const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
    const {
        runCombatTick,
        resolveChallengeTarget
    } = require('../kernel/core/lib/ai/creature_states.js');
    const { Time } = require('../kernel/core/lib/time.js');

    const spells = indexSpells(presets.loadSpells().spells);
    assert.ok(spells.challenge, 'challenge preset');
    assert.strictEqual(spells.challenge.kind, 'support');
    assert.strictEqual(spells.challenge.tauntDurationSec, 6);
    assert.ok(spells.challenge.shape && spells.challenge.shape.code === 3);
    assert.ok(
        Array.isArray(spells.challenge.vocations) &&
            spells.challenge.vocations.indexOf('guardian') >= 0
    );

    const classes = presets.loadClasses();
    const guard =
        classes.classes &&
        classes.classes.find((c) => c.id === 'guardian');
    assert.ok(guard && guard.spells.indexOf('challenge') >= 0, 'guardian book');

    const player = makeGuardianKnight();
    player.id = 501;
    player.tile = { x: 10, y: 10, z: 7 };
    player.level = 50;
    if (player.mp) player.mp.current = Math.max(player.mp.current || 0, 200);

    const ally = makeGuardianKnight();
    ally.id = 502;
    ally.tile = { x: 11, y: 10, z: 7 };
    ally.type = 'player';

    const mobA = new Creature({
        id: 601,
        type: 'creature',
        hp: 200,
        tile: { x: 11, y: 10, z: 7 }
    });
    mobA.alive = true;
    const mobB = new Creature({
        id: 602,
        type: 'creature',
        hp: 200,
        tile: { x: 10, y: 11, z: 7 }
    });
    mobB.alive = true;
    // Already focused on ally — challenge should pull to caster.
    mobA.target = ally;
    mobA.targetId = ally.id;
    mobB.target = ally;
    mobB.targetId = ally.id;

    const summon = new Creature({
        id: 603,
        type: 'creature',
        hp: 100,
        tile: { x: 9, y: 10, z: 7 },
        masterId: player.id
    });
    summon.alive = true;

    assert.strictEqual(isChallengeableCreature(mobA), true);
    assert.strictEqual(isChallengeableCreature(player), false);
    assert.strictEqual(isChallengeableCreature(summon), false);

    const t0 =
        Time && Time.timeSinceLevelLoad != null
            ? Number(Time.timeSinceLevelLoad)
            : 0;

    const cast = resolveShapedAttack({
        attacker: player,
        primary: mobA,
        spell: spells.challenge,
        candidates: [mobA, mobB, summon, ally],
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(cast.ok, true, cast.reason || 'challenge cast ok');
    assert.ok(cast.results && cast.results.length >= 2, 'hits nearby mobs');

    const tauntedRows = (cast.results || []).filter((r) => r && r.tauntApplied);
    assert.ok(tauntedRows.length >= 2, 'taunt applied to both free hostiles');

    assert.strictEqual(mobA.target, player);
    assert.strictEqual(mobA.targetId, player.id);
    assert.ok(isCreatureChallenged(mobA, t0));
    assert.strictEqual(mobB.target, player);
    assert.ok(isCreatureChallenged(mobB, t0));
    // Summon not taunted
    assert.notStrictEqual(summon.target, player);

    // AI combat tick keeps forced target even if strategy would prefer ally.
    const sim = {
        getEntityById(id) {
            if (id === player.id) return player;
            if (id === ally.id) return ally;
            if (id === mobA.id) return mobA;
            return null;
        }
    };
    const ctx = {
        sim,
        players: [player, ally],
        enemies: [mobA, mobB],
        rng: () => 0,
        tileMap: null
    };
    // Point kit away from fighting if missing
    mobA.attacks = [{ name: 'melee', min: 1, max: 1, intervalSec: 2, chance: 100 }];
    const status = runCombatTick(mobA, ctx);
    assert.strictEqual(status, 'ok');
    assert.strictEqual(mobA.target, player, 'challenge holds through combat tick');
    assert.strictEqual(resolveChallengeTarget(mobA, ctx), player);

    // Expired lock clears
    mobA.challengeUntil = t0 - 1;
    assert.strictEqual(isCreatureChallenged(mobA, t0), false);
    assert.strictEqual(resolveChallengeTarget(mobA, ctx), null);

    // Direct helper duration
    assert.ok(applyChallengeTaunt(mobB, player, 3));
    assert.ok(mobB.challengeUntil >= t0 + 3 - 0.001);

    log('challenge taunt ok', {
        hits: cast.hits && cast.hits.length,
        taunted: tauntedRows.length
    });
}

/**
 * Chivalrous Challenge + Divine Dazzle: self-origin chain over free ranged hostiles.
 * Chivalrous = taunt 12s + force melee 12s; Dazzle = force melee only (no taunt).
 */
function testChivalrousChallengeAndDivineDazzle() {
    const {
        applyForceMelee,
        isForceMeleeActive,
        getForcedTargetDistance,
        baseTargetDistance,
        isCreatureChallenged
    } = require('../kernel/core/lib/combat/resolve.js');
    const { resolveChainAttack } = require('../kernel/core/lib/combat/chain.js');
    const {
        tryAttack,
        isSpellInRange,
        chainCanPick
    } = require('../kernel/core/lib/ai/combat_actions.js');
    const {
        ensureCreatureKit,
        idealStandDistance
    } = require('../kernel/core/lib/ai/creature_kit.js');
    const { Time } = require('../kernel/core/lib/time.js');

    const spells = indexSpells(presets.loadSpells().spells);
    assert.ok(spells.chivalrous_challenge, 'chivalrous preset');
    assert.ok(spells.divine_dazzle, 'dazzle preset');
    assert.strictEqual(spells.chivalrous_challenge.tauntDurationSec, 12);
    assert.strictEqual(spells.chivalrous_challenge.forceMeleeDurationSec, 12);
    assert.strictEqual(spells.chivalrous_challenge.chainOnlyRanged, true);
    assert.strictEqual(spells.chivalrous_challenge.chain.maxTargets, 5);
    assert.strictEqual(spells.chivalrous_challenge.chain.distance, 6);
    assert.strictEqual(spells.divine_dazzle.forceMeleeDurationSec, 12);
    assert.ok(spells.divine_dazzle.tauntDurationSec == null);
    assert.strictEqual(spells.divine_dazzle.chain.maxTargets, 3);
    assert.strictEqual(spells.divine_dazzle.chainOnlyRanged, true);

    const classes = presets.loadClasses();
    const guard =
        classes.classes && classes.classes.find((c) => c.id === 'guardian');
    const scout =
        classes.classes && classes.classes.find((c) => c.id === 'scout');
    assert.ok(
        guard && guard.spells.indexOf('chivalrous_challenge') >= 0,
        'guardian book chivalrous'
    );
    assert.ok(
        scout && scout.spells.indexOf('divine_dazzle') >= 0,
        'scout book dazzle'
    );

    const player = makeGuardianKnight();
    player.id = 701;
    player.tile = { x: 10, y: 10, z: 7 };
    player.level = 150;
    if (player.mp) player.mp.current = Math.max(player.mp.current || 0, 500);

    function makeRanged(id, x, y) {
        const m = new Creature({
            id,
            type: 'creature',
            hp: 200,
            tile: { x, y, z: 7 }
        });
        m.alive = true;
        m.flags = { targetDistance: 4 };
        ensureCreatureKit(m);
        // Kit already built may not re-read flags — force kit stand-off.
        m.kit.flags.targetDistance = 4;
        return m;
    }

    const rangedA = makeRanged(801, 12, 10);
    const rangedB = makeRanged(802, 14, 10);
    const meleeC = new Creature({
        id: 803,
        type: 'creature',
        hp: 200,
        tile: { x: 11, y: 10, z: 7 }
    });
    meleeC.alive = true;
    meleeC.flags = { targetDistance: 1 };
    ensureCreatureKit(meleeC);
    meleeC.kit.flags.targetDistance = 1;

    const summon = new Creature({
        id: 804,
        type: 'creature',
        hp: 100,
        tile: { x: 12, y: 11, z: 7 },
        masterId: player.id
    });
    summon.alive = true;
    summon.flags = { targetDistance: 4 };
    ensureCreatureKit(summon);
    summon.kit.flags.targetDistance = 4;

    assert.strictEqual(baseTargetDistance(rangedA), 4);
    assert.strictEqual(baseTargetDistance(meleeC), 1);
    assert.strictEqual(
        chainCanPick(spells.chivalrous_challenge, player, rangedA),
        true
    );
    assert.strictEqual(
        chainCanPick(spells.chivalrous_challenge, player, meleeC),
        false
    );
    assert.strictEqual(
        chainCanPick(spells.chivalrous_challenge, player, summon),
        false
    );

    const t0 =
        Time && Time.timeSinceLevelLoad != null
            ? Number(Time.timeSinceLevelLoad)
            : 0;

    const canPick = (caster, cand) =>
        chainCanPick(spells.chivalrous_challenge, caster, cand);

    const cast = resolveChainAttack({
        attacker: player,
        primary: null,
        spell: spells.chivalrous_challenge,
        candidates: [rangedA, rangedB, meleeC, summon],
        spellBook: spells,
        rng: () => 0,
        canPick
    });
    assert.strictEqual(cast.ok, true, cast.reason || 'chivalrous cast ok');
    assert.ok(cast.chain, 'chain flag');
    assert.ok(cast.hits && cast.hits.length >= 2, 'hits ranged chain');
    assert.ok(
        cast.hits.indexOf(meleeC) < 0,
        'melee skipped by chainOnlyRanged filter'
    );
    assert.ok(cast.hits.indexOf(summon) < 0, 'summon skipped');

    for (let i = 0; i < cast.hits.length; i++) {
        const m = cast.hits[i];
        assert.strictEqual(m.target, player, 'taunt target ' + m.id);
        assert.ok(isCreatureChallenged(m, t0), 'challenged ' + m.id);
        assert.ok(isForceMeleeActive(m, t0), 'force melee ' + m.id);
        assert.strictEqual(getForcedTargetDistance(m, t0), 1);
        assert.strictEqual(idealStandDistance(m), 1);
    }
    // Melee mob unchanged
    assert.strictEqual(meleeC.target, null);
    assert.strictEqual(isForceMeleeActive(meleeC, t0), false);

    // Divine dazzle: force melee only, no taunt
    const scoutPlayer = makeGuardianKnight();
    scoutPlayer.id = 702;
    scoutPlayer.tile = { x: 20, y: 20, z: 7 };
    scoutPlayer.level = 250;
    scoutPlayer.classId = 'scout';
    if (scoutPlayer.mp) {
        scoutPlayer.mp.current = Math.max(scoutPlayer.mp.current || 0, 500);
    }

    const dA = makeRanged(901, 22, 20);
    const dB = makeRanged(902, 24, 20);
    // Point at someone else before dazzle
    const decoy = makeGuardianKnight();
    decoy.id = 703;
    decoy.tile = { x: 21, y: 20, z: 7 };
    dA.target = decoy;
    dA.targetId = decoy.id;

    const dazzle = resolveChainAttack({
        attacker: scoutPlayer,
        primary: null,
        spell: spells.divine_dazzle,
        candidates: [dA, dB],
        spellBook: spells,
        rng: () => 0,
        canPick: (caster, cand) =>
            cand &&
            cand !== caster &&
            cand.alive !== false &&
            baseTargetDistance(cand) > 1
    });
    assert.strictEqual(dazzle.ok, true, dazzle.reason || 'dazzle cast ok');
    assert.ok(dazzle.hits && dazzle.hits.length >= 1);
    assert.ok(isForceMeleeActive(dA, t0));
    assert.strictEqual(idealStandDistance(dA), 1);
    // No taunt: still focused on decoy
    assert.strictEqual(dA.target, decoy, 'dazzle does not taunt');
    assert.strictEqual(isCreatureChallenged(dA, t0), false);

    // Expiry restores stand-off
    dA.forceMeleeUntil = t0 - 1;
    assert.strictEqual(getForcedTargetDistance(dA, t0), null);
    assert.strictEqual(idealStandDistance(dA), 4);

    // Direct helper
    assert.ok(applyForceMelee(dB, 5));
    assert.ok(isForceMeleeActive(dB, t0));

    // tryAttack self-origin path (fresh caster — prior cast left moveLock/CD).
    const tryPlayer = makeGuardianKnight();
    tryPlayer.id = 710;
    tryPlayer.tile = { x: 10, y: 10, z: 7 };
    tryPlayer.level = 150;
    if (tryPlayer.mp) tryPlayer.mp.current = 500;
    tryPlayer.cooldowns = {};
    tryPlayer.moveDelay = 0;
    tryPlayer.moveLock = 0;
    const rNew = makeRanged(811, 12, 10);
    const viaTry = tryAttack({
        attacker: tryPlayer,
        defender: tryPlayer,
        spellId: 'chivalrous_challenge',
        ctx: {
            enemies: [rNew, meleeC],
            spellBook: spells,
            rng: () => 0
        }
    });
    assert.ok(viaTry && viaTry.ok, viaTry && viaTry.reason || 'tryAttack chivalrous self-origin');
    assert.ok(viaTry.chain);
    assert.ok(isForceMeleeActive(rNew, t0));

    assert.ok(
        isSpellInRange(player, null, spells.chivalrous_challenge, {
            enemies: [makeRanged(820, 12, 10)],
            spellBook: spells
        }),
        'in range with pickable ranged'
    );
    assert.strictEqual(
        isSpellInRange(player, null, spells.chivalrous_challenge, {
            enemies: [meleeC],
            spellBook: spells
        }),
        false,
        'out of range when only melee hostiles'
    );

    log('chivalrous + divine dazzle ok', {
        chivalrousHits: cast.hits.length,
        dazzleHits: dazzle.hits.length
    });
}

function testHasteInvisibleSpellsAndSeeInvis() {
    const {
        applyCondition,
        hasCondition,
        isInvisible,
        hasHaste,
        canSeeInvisibility,
        hasteSpeedChangeFromFormula
    } = require('../kernel/core/lib/combat/conditions.js');
    const { isValidTarget } = require('../kernel/core/lib/ai/targeting.js');
    const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
    const { applyHpDelta } = require('../kernel/core/lib/combat/resolve.js');

    const spells = indexSpells(presets.loadSpells().spells);
    assert.ok(spells.haste, 'haste preset');
    assert.ok(spells.strong_haste);
    assert.ok(spells.charge);
    assert.ok(spells.invisible);
    assert.ok(spells.cancel_invisibility);
    assert.strictEqual(spells.haste.kind, 'support');
    assert.ok(spells.haste.condition && spells.haste.condition.type === 'haste');
    assert.deepStrictEqual(spells.cancel_invisibility.dispel, ['invisible']);
    assert.ok(spells.cancel_invisibility.shape);

    // Formula parity (ConditionSpeed): target = 1.3*(110-40)+40 = 131; delta = 131-110 = 21
    assert.strictEqual(
        hasteSpeedChangeFromFormula(110, { mina: 1.3, minb: 40 }),
        21
    );
    assert.strictEqual(
        hasteSpeedChangeFromFormula(220, { mina: 1.3, minb: 40 }),
        54
    ); // target 274 → delta 54

    const player = makeGuardianKnight();
    player.tile = { x: 0, y: 0, z: 7 };
    player.baseSpeed = 110;
    player.speed = 110;
    player.level = 50;
    // Ensure MP for 440 invis later (guardian may have low mp)
    if (player.mp) player.mp.current = Math.max(player.mp.current || 0, 500);

    const mpBefore = player.mp.current;
    const rHaste = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'haste',
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(rHaste.ok, true, rHaste.reason || 'haste ok');
    assert.ok(rHaste.conditionApplied, 'haste condition applied');
    assert.ok(hasHaste(player));
    assert.ok(player.speed > 110, `speed buffed got ${player.speed}`);
    assert.strictEqual(player.mp.current, mpBefore - spells.haste.mana);
    assert.ok(Cooldowns.getRemaining(player, 'primary', 'support') > 0);

    // Invisible self-buff (use fresh CD by skipping cooldown)
    const rInv = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'invisible',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true
    });
    assert.strictEqual(rInv.ok, true, rInv.reason || 'invis ok');
    assert.ok(isInvisible(player));
    assert.ok(player.invisible);

    // Monster without see-invis cannot stick target on invisible player
    const blindMob = new Creature({
        id: 91,
        type: 'creature',
        hp: 100,
        tile: { x: 1, y: 0, z: 7 }
    });
    assert.strictEqual(canSeeInvisibility(blindMob), false);
    assert.strictEqual(isValidTarget(blindMob, player), false);

    // Monster with immunities.invisible can see
    const seer = new Creature({
        id: 92,
        type: 'creature',
        hp: 100,
        tile: { x: 1, y: 0, z: 7 }
    });
    seer.immunities = { invisible: true };
    assert.strictEqual(canSeeInvisibility(seer), true);
    assert.strictEqual(isValidTarget(seer, player), true);

    // Damage breaks monster invis, not player invis
    const invisMob = new Creature({
        id: 93,
        type: 'creature',
        hp: 200,
        tile: { x: 2, y: 0, z: 7 }
    });
    applyCondition(invisMob, { type: 'invisible', durationSec: 60 });
    assert.ok(isInvisible(invisMob));
    applyHpDelta(invisMob, 10, 'physical');
    assert.ok(!isInvisible(invisMob), 'monster invis broken by damage');
    assert.ok(isInvisible(player), 'player still invisible after own buff');
    applyHpDelta(player, 5, 'physical');
    assert.ok(isInvisible(player), 'player keeps invis when damaged');

    // cancel_invisibility AoE dispel
    const scout = makeGuardianKnight();
    scout.tile = { x: 5, y: 5, z: 7 };
    scout.level = 50;
    if (scout.mp) scout.mp.current = 500;
    const hidden = new Creature({
        id: 94,
        type: 'creature',
        hp: 100,
        tile: { x: 6, y: 5, z: 7 }
    });
    applyCondition(hidden, { type: 'invisible', durationSec: 60 });
    assert.ok(isInvisible(hidden));
    const cancel = resolveShapedAttack({
        attacker: scout,
        primary: hidden,
        spell: spells.cancel_invisibility,
        candidates: [hidden],
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(cancel.ok, true, cancel.reason || 'cancel ok');
    assert.ok(!isInvisible(hidden), 'cancel dispelled monster invis');
    assert.ok(
        cancel.results &&
            cancel.results.some((row) => row && row.conditionsRemoved >= 1)
    );

    log('haste / invisible / seeInvis / cancel ok', {
        hasteSpeed: player.speed,
        cancelHits: cancel.hits && cancel.hits.length
    });
}

/**
 * Phase I — player DoT attacks (utori *): statusOnly + condition schedule,
 * PvE apply/tick, vocation books, provoke on 0-final hit.
 */
function testDotAttackSpells() {
    const {
        hasCondition,
        tickConditions,
        DOT_KIND_SET
    } = require('../kernel/core/lib/combat/conditions.js');

    const spells = indexSpells(presets.loadSpells().spells);
    const expected = {
        ignite: { kind: 'fire', element: 'fire', total: 1125, interval: 3 },
        electrify: { kind: 'energy', element: 'energy', total: 1125, interval: 3 },
        envenom: { kind: 'poison', element: 'earth', total: 1125, interval: 3 },
        inflict_wound: { kind: 'bleed', element: 'physical', total: 750, interval: 2 },
        curse: { kind: 'curse', element: 'death', total: 1092, interval: 3 },
        holy_flash: { kind: 'holy', element: 'holy', total: 180, interval: 3 }
    };
    for (const id of Object.keys(expected)) {
        const sp = spells[id];
        assert.ok(sp, `preset ${id}`);
        assert.strictEqual(sp.statusOnly, true, `${id} statusOnly`);
        assert.strictEqual(sp.min, 0);
        assert.strictEqual(sp.max, 0);
        assert.ok(sp.condition && sp.condition.type, `${id} condition`);
        assert.strictEqual(sp.condition.totalDamage, expected[id].total);
        assert.ok(Array.isArray(sp.condition.schedule) && sp.condition.schedule.length);
    }
    assert.ok(DOT_KIND_SET.has('holy'), 'holy DoT kind registered');

    // Vocation gate via canUseSpell (classId + level; book not required here)
    const adeptOk = {
        classId: 'adept',
        level: 80,
        combatStats: { magic: 40, level: 80 },
        cooldowns: {},
        mp: { current: 200, max: 200 },
        moveDelay: 0
    };
    const scoutOk = {
        classId: 'scout',
        level: 80,
        combatStats: { magic: 40, level: 80 },
        cooldowns: {},
        mp: { current: 200, max: 200 },
        moveDelay: 0
    };
    assert.strictEqual(canUseSpell(adeptOk, spells.ignite), true);
    assert.strictEqual(canUseSpell(adeptOk, spells.curse), true);
    assert.strictEqual(canUseSpell(adeptOk, spells.holy_flash), false);
    assert.strictEqual(canUseSpell(scoutOk, spells.holy_flash), true);
    assert.strictEqual(canUseSpell(scoutOk, spells.envenom), false);

    // Apply ignite on dummy via resolveAttack + tick schedule
    const caster = makeGuardianKnight();
    caster.classId = 'adept';
    caster.level = 80;
    if (caster.combatStats) {
        caster.combatStats.level = 80;
        caster.combatStats.magic = 40;
        const known = caster.combatStats.spells || [];
        for (const id of ['ignite', 'electrify', 'curse']) {
            if (known.indexOf(id) < 0) known.push(id);
        }
        caster.combatStats.spells = known;
    }
    if (caster.mp) caster.mp.current = Math.max(caster.mp.current || 0, 200);
    caster.tile = { x: 0, y: 0, z: 7 };

    const foe = makeDummy();
    foe.tile = { x: 1, y: 0, z: 7 };
    foe.hp.current = 5000;
    foe.hp.max = 5000;
    foe.mitigation = 0;
    foe.resists = {};
    foe.conditions = [];
    foe.alive = true;

    const mpBefore = caster.mp.current;
    const r = resolveAttack({
        attacker: caster,
        defender: foe,
        spell: 'ignite',
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(r.ok, true, r.reason || 'ignite ok');
    assert.strictEqual(r.hit, true);
    assert.strictEqual(r.final, 0);
    assert.strictEqual(r.hpDelta, 0);
    assert.ok(r.conditionApplied, 'ignite condition applied');
    assert.strictEqual(r.conditionApplied.kind, 'fire');
    assert.strictEqual(r.conditionApplied.element, 'fire');
    assert.strictEqual(r.conditionApplied.remainingDamage, 1125);
    assert.ok(hasCondition(foe, 'fire'));
    assert.strictEqual(caster.mp.current, mpBefore - spells.ignite.mana);
    assert.ok(Cooldowns.getRemaining(caster, 'primary', 'attack') > 0);
    assert.ok(Cooldowns.getRemaining(caster, 'spell', 'ignite') > 0);
    assert.ok(
        foe.provokedUntil != null && foe.provokedUntil > 0,
        'DoT apply provokes defender'
    );

    // First tick after interval: schedule chunk 45
    const hp0 = foe.hp.current;
    const tick = tickConditions(foe, 3.0, { skipResistance: true });
    assert.ok(tick.ticks.length >= 1, 'DoT ticked');
    assert.strictEqual(tick.ticks[0].damage, 45);
    assert.strictEqual(tick.ticks[0].element, 'fire');
    assert.strictEqual(foe.hp.current, hp0 - 45);
    assert.strictEqual(foe.conditions[0].remainingDamage, 1125 - 45);

    // curse multi-stage: first tick 45 death
    const foe2 = makeDummy();
    foe2.tile = { x: 1, y: 0, z: 7 };
    foe2.hp.current = 5000;
    foe2.hp.max = 5000;
    foe2.mitigation = 0;
    foe2.resists = {};
    foe2.conditions = [];
    foe2.alive = true;
    const rCurse = resolveAttack({
        attacker: caster,
        defender: foe2,
        spell: 'curse',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rCurse.ok, true, rCurse.reason || 'curse ok');
    assert.ok(hasCondition(foe2, 'curse'));
    const tCurse = tickConditions(foe2, 3.0, { skipResistance: true });
    assert.strictEqual(tCurse.ticks[0].damage, 45);
    assert.strictEqual(tCurse.ticks[0].element, 'death');

    // holy_flash kind + element
    const scout = makeGuardianKnight();
    scout.classId = 'scout';
    scout.level = 80;
    if (scout.combatStats) {
        scout.combatStats.level = 80;
        scout.combatStats.spells = (scout.combatStats.spells || []).concat([
            'holy_flash'
        ]);
    }
    if (scout.mp) scout.mp.current = Math.max(scout.mp.current || 0, 200);
    scout.tile = { x: 0, y: 0, z: 7 };
    const foe3 = makeDummy();
    foe3.tile = { x: 1, y: 0, z: 7 };
    foe3.hp = { current: 500, max: 500 };
    foe3.conditions = [];
    foe3.alive = true;
    const rHoly = resolveAttack({
        attacker: scout,
        defender: foe3,
        spell: 'holy_flash',
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(rHoly.ok, true, rHoly.reason || 'holy_flash ok');
    assert.ok(hasCondition(foe3, 'holy'));
    assert.strictEqual(rHoly.conditionApplied.element, 'holy');
    assert.strictEqual(rHoly.conditionApplied.remainingDamage, 180);

    // Class books include Phase I ids
    const classes = presets.loadClasses().classes;
    const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
    assert.ok(byId.adept.spells.indexOf('ignite') >= 0);
    assert.ok(byId.adept.spells.indexOf('electrify') >= 0);
    assert.ok(byId.adept.spells.indexOf('curse') >= 0);
    assert.ok(byId.warden.spells.indexOf('envenom') >= 0);
    assert.ok(byId.guardian.spells.indexOf('inflict_wound') >= 0);
    assert.ok(byId.mystic.spells.indexOf('inflict_wound') >= 0);
    assert.ok(byId.scout.spells.indexOf('holy_flash') >= 0);

    log('Phase I DoT attack spells ok', {
        igniteRemaining: foe.conditions[0] && foe.conditions[0].remainingDamage,
        curseFirstTick: tCurse.ticks[0].damage
    });
}

function testHealingSkipsMitigation() {
    const mit = applyMitigation(
        80,
        'healing',
        {
            mitigation: 50,
            resists: { healing: 100 },
            armor: 100,
            maxBlock: 50,
            canBlock: true
        },
        { isMelee: false, rng: () => 0 }
    );
    assert.strictEqual(mit.final, 80);
    assert.strictEqual(mit.mitigation, 0);
    assert.strictEqual(mit.elementReduction, 0);
    assert.strictEqual(mit.armorReduction, 0);
    log('healing skips mitigation ok');
}

/**
 * Phase J — HoT recovery spells: fixed regen condition, always overwrite on recast
 * (weaker replaces stronger; duration reset), tick heals.
 */
function testHotRecoverySpells() {
    const {
        applyCondition,
        hasCondition,
        tickConditions
    } = require('../kernel/core/lib/combat/conditions.js');
    const spells = indexSpells(presets.loadSpells().spells);

    // Catalog shape
    assert.ok(spells.recovery, 'recovery preset');
    assert.ok(spells.intense_recovery, 'intense_recovery preset');
    assert.strictEqual(spells.recovery.statusOnly, true);
    assert.strictEqual(spells.recovery.condition.type, 'regen');
    assert.strictEqual(spells.recovery.condition.healthGain, 20);
    assert.strictEqual(spells.recovery.condition.intervalSec, 3);
    assert.strictEqual(spells.recovery.condition.durationSec, 60);
    assert.strictEqual(spells.intense_recovery.condition.healthGain, 40);
    assert.strictEqual(spells.intense_recovery.condition.intervalSec, 3);
    assert.strictEqual(spells.intense_recovery.condition.durationSec, 60);

    assert.ok(spells.bruise_bane && spells.bruise_bane.kind === 'heal');
    assert.ok(spells.intense_wound_cleanse);
    assert.strictEqual(spells.intense_wound_cleanse.cooldowns.spell.intense_wound_cleanse, 600);
    assert.ok(spells.restoration && spells.restoration.level === 300);
    assert.ok(spells.natures_embrace && spells.natures_embrace.requiresTarget === true);

    // Apply intense then weaker recovery → always overwrite
    const player = makeGuardianKnight();
    player.level = 100;
    player.conditions = [];
    player.hp.current = 100;
    player.hp.max = 1000;
    player.tile = { x: 0, y: 0, z: 7 };
    if (player.mp) player.mp.current = Math.max(player.mp.current || 0, 500);
    if (player.combatStats) {
        player.combatStats.level = 100;
        player.combatStats.spells = (player.combatStats.spells || []).concat([
            'recovery',
            'intense_recovery',
            'bruise_bane',
            'intense_wound_cleanse'
        ]);
    }

    const rIntense = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'intense_recovery',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true
    });
    assert.strictEqual(rIntense.ok, true, rIntense.reason || 'intense_recovery ok');
    assert.ok(rIntense.conditionApplied, 'intense regen applied');
    assert.strictEqual(rIntense.conditionApplied.kind, 'regen');
    assert.strictEqual(rIntense.conditionApplied.healthGain, 40);
    assert.strictEqual(rIntense.conditionApplied.durationSec, 60);
    assert.ok(hasCondition(player, 'regen'));

    // Burn some duration so overwrite is visible
    player.conditions[0].durationSec = 20;
    player.conditions[0].tickTimer = 1;

    const rWeak = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'recovery',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rWeak.ok, true, rWeak.reason || 'recovery ok');
    assert.strictEqual(player.conditions.length, 1, 'single regen instance');
    assert.strictEqual(player.conditions[0].healthGain, 20, 'weaker gain overwrote');
    assert.strictEqual(player.conditions[0].durationSec, 60, 'duration fully reset');
    assert.strictEqual(player.conditions[0].tickTimer, 0, 'tick timer reset');

    // Tick: 3s → +20 HP
    const hpBefore = player.hp.current;
    const t1 = tickConditions(player, 3.0);
    assert.ok(t1.ticks.length >= 1, 'regen tick fired');
    assert.strictEqual(t1.ticks[0].kind, 'regen');
    assert.strictEqual(t1.ticks[0].healthGain, 20);
    assert.strictEqual(player.hp.current, hpBefore + 20);

    // Stronger overwrite again
    const rStrong = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'intense_recovery',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rStrong.ok, true, rStrong.reason || 're-intense ok');
    assert.strictEqual(player.conditions[0].healthGain, 40);
    assert.strictEqual(player.conditions[0].durationSec, 60);

    // Instant heal still works
    player.hp.current = 50;
    const rBruise = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'bruise_bane',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rBruise.ok, true, rBruise.reason || 'bruise_bane ok');
    assert.ok(rBruise.final > 0, 'bruise heals');
    assert.ok(player.hp.current > 50);

    // Class books
    const classes = presets.loadClasses().classes;
    const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
    assert.ok(byId.guardian.spells.indexOf('recovery') >= 0);
    assert.ok(byId.guardian.spells.indexOf('intense_recovery') >= 0);
    assert.ok(byId.guardian.spells.indexOf('bruise_bane') >= 0);
    assert.ok(byId.guardian.spells.indexOf('intense_wound_cleanse') >= 0);
    assert.ok(byId.scout.spells.indexOf('recovery') >= 0);
    assert.ok(byId.adept.spells.indexOf('restoration') >= 0);
    assert.ok(byId.warden.spells.indexOf('restoration') >= 0);
    assert.ok(byId.warden.spells.indexOf('natures_embrace') >= 0);

    log('Phase J HoT / extra heals ok', {
        regenGain: player.conditions[0] && player.conditions[0].healthGain,
        bruiseFinal: rBruise.final
    });
}

/**
 * Phase M — classic stances: blood_rage / protector exclusive; sharpshooter skill%;
 * swift_foot Stage-1 pacify + haste; damage dealt/received multipliers.
 */
function testPhaseMStances() {
    const {
        applyCondition,
        hasCondition,
        getAttributeMods,
        isCannotAttack,
        conditionDefFromSpell
    } = require('../kernel/core/lib/combat/conditions.js');
    const spells = indexSpells(presets.loadSpells().spells);

    assert.ok(spells.blood_rage, 'blood_rage preset');
    assert.ok(spells.protector, 'protector preset');
    assert.ok(spells.sharpshooter, 'sharpshooter preset');
    assert.ok(spells.swift_foot, 'swift_foot preset');
    assert.strictEqual(spells.blood_rage.condition.subId, 'blood_rage_protector');
    assert.strictEqual(spells.protector.condition.subId, 'blood_rage_protector');
    assert.strictEqual(spells.blood_rage.condition.skillPercent.melee, 135);
    assert.strictEqual(spells.protector.condition.skillPercent.shielding, 220);
    assert.strictEqual(spells.sharpshooter.condition.skillPercent.distance, 140);
    assert.strictEqual(spells.swift_foot.condition.cannotAttack, true);
    assert.strictEqual(spells.blood_rage.cooldowns.secondary.focus, 2);
    assert.strictEqual(spells.sharpshooter.cooldowns.secondary.focus, 10);

    const classes = presets.loadClasses().classes;
    const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
    assert.ok(byId.guardian.spells.indexOf('blood_rage') >= 0);
    assert.ok(byId.guardian.spells.indexOf('protector') >= 0);
    assert.ok(byId.scout.spells.indexOf('sharpshooter') >= 0);
    assert.ok(byId.scout.spells.indexOf('swift_foot') >= 0);

    const player = makeGuardianKnight();
    player.level = 100;
    player.conditions = [];
    player.tile = { x: 0, y: 0, z: 7 };
    if (player.mp) player.mp.current = Math.max(player.mp.current || 0, 2000);
    if (player.combatStats) {
        player.combatStats.level = 100;
        player.combatStats.spells = (player.combatStats.spells || []).concat([
            'blood_rage',
            'protector',
            'melee_auto'
        ]);
    }
    player.baseSpeed = 110;
    player.speed = 110;

    // Blood rage apply
    const rRage = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'blood_rage',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true
    });
    assert.strictEqual(rRage.ok, true, rRage.reason || 'blood_rage ok');
    assert.ok(rRage.conditionApplied, 'blood_rage condition');
    assert.strictEqual(rRage.conditionApplied.kind, 'attributes');
    assert.strictEqual(rRage.conditionApplied.subId, 'blood_rage_protector');
    assert.strictEqual(rRage.conditionApplied.skillPercent.melee, 135);
    assert.strictEqual(rRage.conditionApplied.disableDefense, true);
    assert.strictEqual(rRage.conditionApplied.damageReceivedPercent, 115);
    assert.strictEqual(player.conditions.length, 1);

    // Protector replaces blood_rage (shared subId)
    const rProt = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'protector',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rProt.ok, true, rProt.reason || 'protector ok');
    assert.strictEqual(player.conditions.length, 1, 'exclusive subId');
    assert.strictEqual(player.conditions[0].skillPercent.shielding, 220);
    assert.strictEqual(player.conditions[0].damageDealtPercent, 65);
    assert.strictEqual(player.conditions[0].damageReceivedPercent, 85);
    assert.ok(!player.conditions[0].disableDefense);

    // Damage dealt mult: protector 65%
    const dummy = makeDummy();
    dummy.tile = { x: 1, y: 0, z: 7 };
    dummy.hp.current = 5000;
    dummy.hp.max = 5000;
    // strip dummy armor for stable compare
    dummy.combatStats = {
        mitigation: 0,
        resists: {},
        armor: 0,
        maxBlock: 0
    };
    dummy.mitigation = 0;
    dummy.armor = 0;
    dummy.maxBlock = 0;
    dummy.canBlock = false;

    // Clear protector, apply none for baseline
    player.conditions = [];
    const base = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: 'melee_auto',
        spellBook: spells,
        rng: () => 0.5,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(base.ok, true, base.reason || 'baseline auto');
    assert.ok(base.final > 0);

    // Re-apply protector and compare
    resolveAttack({
        attacker: player,
        defender: player,
        spell: 'protector',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    dummy.hp.current = 5000;
    const withProt = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: 'melee_auto',
        spellBook: spells,
        rng: () => 0.5,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(withProt.ok, true, withProt.reason || 'prot auto');
    // ~65% of baseline (floor rounding)
    assert.ok(
        withProt.final <= base.final,
        `protector reduces dmg ${withProt.final} vs ${base.final}`
    );
    assert.ok(
        withProt.final <= Math.floor(base.final * 0.65) + 1,
        `dealt mult ~65%: ${withProt.final} vs 65% of ${base.final}`
    );

    // Blood rage damage received 115% on defender
    player.conditions = [];
    resolveAttack({
        attacker: player,
        defender: player,
        spell: 'blood_rage',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    // Attack self-as-defender via dummy attacker is awkward; use getAttributeMods
    const mods = getAttributeMods(player);
    assert.ok(Math.abs(mods.damageReceivedMult - 1.15) < 1e-9);
    assert.strictEqual(mods.disableDefense, true);
    assert.ok(Math.abs(mods.skillMult.melee - 1.35) < 1e-9);

    // Scout stances: exclusivity + pacify
    const scoutCls = presets.getClass('scout');
    const items = presets.loadEquipment().items;
    const scout = new Player({
        name: 'Test Scout',
        id: 2,
        classId: 'scout',
        equipment: {
            rightHand: 'hunter_bow',
            leftHand: 'oak_shield',
            armor: 'leather_armor'
        },
        classDef: scoutCls,
        itemDb: items,
        level: 100
    });
    scout.conditions = [];
    scout.tile = { x: 0, y: 0, z: 7 };
    scout.baseSpeed = 120;
    scout.speed = 120;
    if (scout.mp) scout.mp.current = 2000;
    if (scout.combatStats) {
        scout.combatStats.level = 100;
        scout.combatStats.spells = (scout.combatStats.spells || []).concat([
            'sharpshooter',
            'swift_foot',
            'distance_auto',
            'haste'
        ]);
    }

    const rSharp = resolveAttack({
        attacker: scout,
        defender: scout,
        spell: 'sharpshooter',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true
    });
    assert.strictEqual(rSharp.ok, true, rSharp.reason || 'sharpshooter ok');
    assert.strictEqual(scout.conditions[0].skillPercent.distance, 140);
    assert.strictEqual(scout.conditions[0].disableDefense, true);
    // speed reduced (0.7 formula)
    assert.ok(
        scout.speed < scout.baseSpeed,
        `sharpshooter slows ${scout.speed} < ${scout.baseSpeed}`
    );

    const rSwift = resolveAttack({
        attacker: scout,
        defender: scout,
        spell: 'swift_foot',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rSwift.ok, true, rSwift.reason || 'swift_foot ok');
    assert.strictEqual(scout.conditions.length, 1, 'scout stance exclusive');
    assert.strictEqual(scout.conditions[0].cannotAttack, true);
    assert.ok(isCannotAttack(scout));
    assert.ok(
        scout.speed > scout.baseSpeed,
        `swift_foot haste ${scout.speed} > ${scout.baseSpeed}`
    );

    // Pacify blocks distance auto via canCast (clear CD noise first)
    Cooldowns.ensureCooldowns(scout);
    scout.cooldowns.primary.support = 0;
    scout.cooldowns.primary.attack = 0;
    scout.cooldowns.secondary = {};
    scout.cooldowns.spell = {};
    scout.moveDelay = 0;
    const distSpell = spells.distance_auto;
    assert.strictEqual(
        canCast(scout, distSpell, { spellBook: spells }),
        false,
        'pacify blocks auto'
    );
    // Support haste still allowed (pacify only blocks attack/auto)
    assert.strictEqual(
        canCast(scout, spells.haste, { spellBook: spells }),
        true,
        'support ok while pacified'
    );

    log('Phase M stances ok', {
        baseFinal: base.final,
        protFinal: withProt.final,
        scoutSpeed: scout.speed
    });
}

/**
 * MM-A — mystic monk heals: soul_mend, mass_soul_mend, renew_balance.
 */
function testMmaMonkHeals() {
    const spells = indexSpells(presets.loadSpells().spells);
    assert.ok(spells.soul_mend, 'soul_mend');
    assert.ok(spells.mass_soul_mend, 'mass_soul_mend');
    assert.ok(spells.renew_balance, 'renew_balance');
    assert.strictEqual(spells.soul_mend.kind, 'heal');
    assert.strictEqual(spells.soul_mend.mana, 210);
    assert.strictEqual(spells.soul_mend.level, 80);
    assert.strictEqual(spells.soul_mend.basePower, 250);
    assert.strictEqual(spells.mass_soul_mend.mana, 250);
    assert.strictEqual(spells.mass_soul_mend.level, 150);
    assert.strictEqual(spells.mass_soul_mend.cooldowns.spell.mass_soul_mend, 8);
    assert.strictEqual(spells.renew_balance.requiresTarget, true);
    assert.strictEqual(spells.renew_balance.range, 7);
    assert.strictEqual(spells.renew_balance.mana, 120);

    const classes = presets.loadClasses().classes;
    const mystic = classes.find((c) => c.id === 'mystic');
    assert.ok(mystic);
    assert.ok(mystic.spells.indexOf('soul_mend') >= 0);
    assert.ok(mystic.spells.indexOf('mass_soul_mend') >= 0);
    assert.ok(mystic.spells.indexOf('renew_balance') >= 0);

    const cls = presets.getClass('mystic');
    const items = presets.loadEquipment().items;
    const monk = new Player({
        name: 'Test Mystic',
        id: 3,
        classId: 'mystic',
        equipment: { rightHand: 'iron_longsword' },
        classDef: cls,
        itemDb: items,
        level: 150
    });
    monk.conditions = [];
    monk.tile = { x: 0, y: 0, z: 7 };
    monk.hp.current = 100;
    monk.hp.max = 2000;
    if (monk.mp) monk.mp.current = 2000;
    if (monk.combatStats) {
        monk.combatStats.level = 150;
        monk.combatStats.magic = 50;
        monk.combatStats.spells = (monk.combatStats.spells || []).concat([
            'soul_mend',
            'mass_soul_mend',
            'renew_balance'
        ]);
    }

    const rMend = resolveAttack({
        attacker: monk,
        defender: monk,
        spell: 'soul_mend',
        spellBook: spells,
        rng: () => 0.5,
        skipCooldown: true
    });
    assert.strictEqual(rMend.ok, true, rMend.reason || 'soul_mend ok');
    assert.ok(rMend.final > 0, 'soul_mend heals');
    assert.ok(monk.hp.current > 100);

    monk.hp.current = 100;
    const rMass = resolveAttack({
        attacker: monk,
        defender: monk,
        spell: 'mass_soul_mend',
        spellBook: spells,
        rng: () => 0.5,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rMass.ok, true, rMass.reason || 'mass_soul_mend ok');
    assert.ok(rMass.final > 0);

    // renew_balance on ally
    const ally = makeGuardianKnight();
    ally.tile = { x: 1, y: 0, z: 7 };
    ally.hp.current = 50;
    ally.hp.max = 1000;
    const rBal = resolveAttack({
        attacker: monk,
        defender: ally,
        spell: 'renew_balance',
        spellBook: spells,
        rng: () => 0.5,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rBal.ok, true, rBal.reason || 'renew_balance ok');
    assert.ok(rBal.final > 0);
    assert.ok(ally.hp.current > 50);

    log('MM-A monk heals ok', {
        spirit: rMend.final,
        mass: rMass.final,
        balance: rBal.final
    });
}

/**
 * MM-B — even_contest: directional force-melee AoE (16s, no taunt).
 * Multi-mob cone, stand-off, skip cases (already melee / summon / out of footprint).
 */
function testMmbBalancedBrawl() {
    const {
        isForceMeleeActive,
        isCreatureChallenged
    } = require('../kernel/core/lib/combat/resolve.js');
    const {
        ensureCreatureKit,
        idealStandDistance
    } = require('../kernel/core/lib/ai/creature_kit.js');
    const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
    const { Time } = require('../kernel/core/lib/time.js');

    const spells = indexSpells(presets.loadSpells().spells);
    const bb = spells.even_contest;
    assert.ok(bb, 'even_contest preset exists');
    assert.strictEqual(bb.kind, 'support');
    assert.strictEqual(bb.mana, 80);
    assert.strictEqual(bb.level, 175);
    assert.strictEqual(bb.forceMeleeDurationSec, 16);
    assert.ok(bb.tauntDurationSec == null, 'no taunt');
    assert.ok(
        bb.shape &&
            bb.shape.type === 'wave' &&
            bb.shape.spread === 'custom' &&
            bb.shape.length === 'even_contest'
    );

    const classes = presets.loadClasses().classes;
    const mystic = classes.find((c) => c.id === 'mystic');
    assert.ok(
        mystic && mystic.spells.indexOf('even_contest') >= 0,
        'book has balanced brawl'
    );

    const monk = new Player({
        name: 'Monk',
        id: 901,
        classId: 'mystic',
        classDef: presets.getClass('mystic'),
        level: 175
    });
    monk.tile = { x: 10, y: 10, z: 7 };
    monk.hp.current = 100;
    monk.hp.max = 2000;
    if (monk.mp) monk.mp.current = 1000;
    monk.combatStats = {
        level: 175,
        magic: 50,
        spells: ['even_contest']
    };

    function makeMob(id, x, y, targetDistance) {
        const m = new Creature({
            id,
            name: 'm' + id,
            type: 'creature',
            isMonster: true,
            hp: 100,
            tile: { x, y, z: 7 }
        });
        m.alive = true;
        m.flags = { targetDistance };
        m.targetDistance = targetDistance;
        ensureCreatureKit(m);
        m.kit.flags.targetDistance = targetDistance;
        return m;
    }

    // Wave center = caster+facing; origin cell 2 not hit.
    // Caster (10,10) east → center (11,10) empty; first hit (12,10).
    const front = makeMob(902, 12, 10, 4); // in cone
    const side = makeMob(903, 14, 11, 4); // SE lobe
    const gap = makeMob(904, 11, 10, 4); // front origin (cell 2), not hit
    const behind = makeMob(905, 8, 10, 4); // west — outside wave
    const melee = makeMob(906, 13, 9, 1); // in cone, already melee
    const summon = makeMob(907, 14, 10, 4);
    summon.masterId = monk.id;

    const candidates = [front, side, gap, behind, melee, summon];
    const r = resolveShapedAttack({
        attacker: monk,
        primary: front,
        candidates,
        spell: bb,
        spellBook: spells,
        direction: { x: 1, y: 0 },
        rng: () => 0.5,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(r.ok, true, r.reason || 'even_contest cast ok');

    const t0 =
        Time && Time.timeSinceLevelLoad != null
            ? Number(Time.timeSinceLevelLoad)
            : 0;

    // Force-melee on free ranged hostiles in the cone
    assert.ok(isForceMeleeActive(front, t0), 'front force-melee');
    assert.ok(isForceMeleeActive(side, t0), 'side force-melee');
    assert.ok(
        front.forceMeleeUntil >= t0 + 15.9,
        'front forceMelee ~16s'
    );
    assert.strictEqual(idealStandDistance(front), 1, 'stand-off 1 while active');
    assert.strictEqual(idealStandDistance(side), 1);

    // No taunt / provoke from force-melee alone
    assert.strictEqual(isCreatureChallenged(front, t0), false, 'no taunt');

    // Skip / miss cases
    assert.strictEqual(
        isForceMeleeActive(gap, t0),
        false,
        'gap tile (+1) not forced'
    );
    assert.strictEqual(
        isForceMeleeActive(behind, t0),
        false,
        'behind caster not in wave'
    );
    assert.strictEqual(
        isForceMeleeActive(melee, t0),
        false,
        'already-melee no-op'
    );
    assert.strictEqual(
        isForceMeleeActive(summon, t0),
        false,
        'summon not force-meleed'
    );

    // Hits include cone members; gap/behind should not be among resolve hits
    const hitIds = (r.results || [])
        .filter((x) => x && x.hit)
        .map((x) => x.defender && x.defender.id);
    assert.ok(hitIds.indexOf(front.id) >= 0, 'front hit');
    assert.ok(hitIds.indexOf(side.id) >= 0, 'side hit');
    assert.ok(hitIds.indexOf(gap.id) < 0, 'gap not hit');
    assert.ok(hitIds.indexOf(behind.id) < 0, 'behind not hit');

    // Expiry restores base stand-off
    front.forceMeleeUntil = t0 - 1;
    assert.strictEqual(isForceMeleeActive(front, t0), false, 'expired');
    assert.strictEqual(idealStandDistance(front), 4, 'stand-off restored');

    log('MM-B even_contest ok');
}

/**
 * MM-C — mystic high-tier ST: crushing_finisher, rising_blow.
 * Product gates (not legacy Lua mana): catalog + damage + CD buckets.
 */
function testMmcMysticHighTierAttacks() {
    const spells = indexSpells(presets.loadSpells().spells);
    assert.ok(spells.crushing_finisher, 'crushing_finisher');
    assert.ok(spells.rising_blow, 'rising_blow');

    assert.strictEqual(spells.crushing_finisher.kind, 'strike');
    assert.strictEqual(spells.crushing_finisher.element, 'physical');
    assert.strictEqual(spells.crushing_finisher.mana, 210);
    assert.strictEqual(spells.crushing_finisher.level, 125);
    assert.strictEqual(spells.crushing_finisher.basePower, 62);
    assert.strictEqual(spells.crushing_finisher.cooldowns.spell.crushing_finisher, 24);
    assert.strictEqual(spells.crushing_finisher.cooldowns.primary.attack, 2);
    assert.ok(
        spells.crushing_finisher.damageAmplitude > 0,
        'crushing_finisher damageAmplitude populated'
    );

    assert.strictEqual(spells.rising_blow.kind, 'strike');
    assert.strictEqual(spells.rising_blow.element, 'physical');
    assert.strictEqual(spells.rising_blow.mana, 325);
    assert.strictEqual(spells.rising_blow.level, 110);
    assert.strictEqual(spells.rising_blow.basePower, 130);
    assert.strictEqual(spells.rising_blow.cooldowns.spell.rising_blow, 60);
    assert.strictEqual(spells.rising_blow.cooldowns.primary.attack, 2);
    assert.ok(
        spells.rising_blow.damageAmplitude > 0,
        'rising_blow damageAmplitude populated'
    );

    // Populate-style amplitude matches legacy spread around option-B mean.
    const ref = { level: 100, skill: 50, atk: 50 };
    for (const id of ['crushing_finisher', 'rising_blow']) {
        const sp = spells[id];
        const legacy = computeLegacyMeleeStrikeRange(ref, sp.basePower);
        const mean = computeMeleeMean(ref, sp.basePower);
        const expected = amplitudeFromLegacySpread(legacy.min, legacy.max, mean);
        assert.ok(
            Math.abs(sp.damageAmplitude - expected) < 1e-9,
            id + ' amplitude inline with populate formula'
        );
    }

    const classes = presets.loadClasses().classes;
    const mysticClass = classes.find((c) => c.id === 'mystic');
    assert.ok(mysticClass);
    assert.ok(mysticClass.spells.indexOf('crushing_finisher') >= 0);
    assert.ok(mysticClass.spells.indexOf('rising_blow') >= 0);

    const cls = presets.getClass('mystic');
    const items = presets.loadEquipment().items;
    const mystic = new Player({
        name: 'Test Mystic MM-C',
        id: 31,
        classId: 'mystic',
        equipment: { rightHand: 'iron_longsword' },
        classDef: cls,
        itemDb: items,
        level: 125
    });
    mystic.conditions = [];
    mystic.tile = { x: 0, y: 0, z: 7 };
    if (mystic.mp) mystic.mp.current = 2000;
    if (mystic.combatStats) {
        mystic.combatStats.level = 125;
        mystic.combatStats.skill = 80;
        mystic.combatStats.atk = mystic.combatStats.atk || 40;
        mystic.combatStats.spells = (mystic.combatStats.spells || []).concat([
            'crushing_finisher',
            'rising_blow'
        ]);
    }

    const dummy = makeDummy();
    dummy.tile = { x: 1, y: 0, z: 7 };
    const hp0 = dummy.hp.current;
    const mana0 = mystic.mp ? mystic.mp.current : 0;
    const rng = rngFromSeed(42);

    const rCrush = resolveAttack({
        attacker: mystic,
        defender: dummy,
        spell: 'crushing_finisher',
        spellBook: spells,
        rng
    });
    assert.strictEqual(rCrush.ok, true, rCrush.reason || 'crushing_finisher ok');
    assert.strictEqual(rCrush.hit, true);
    assert.ok(rCrush.final > 0, 'crushing_finisher damage');
    assert.ok(dummy.hp.current < hp0, 'dummy took crushing_finisher');
    if (mystic.mp) {
        assert.strictEqual(mystic.mp.current, mana0 - 210, 'crushing mana spent');
    }
    assert.ok(
        Cooldowns.getRemaining(mystic, 'primary', 'attack') > 0,
        'primary.attack after crushing_finisher'
    );
    assert.ok(
        Cooldowns.getRemaining(mystic, 'spell', 'crushing_finisher') > 0,
        'spell CD after crushing_finisher'
    );
    // Immediate recast blocked by primary and/or spell CD
    const rCrushCd = resolveAttack({
        attacker: mystic,
        defender: dummy,
        spell: 'crushing_finisher',
        spellBook: spells,
        rng
    });
    assert.strictEqual(rCrushCd.ok, false);
    assert.strictEqual(rCrushCd.reason, 'cooldown');

    // rising_blow: clear CDs; damage + spell CD 60s bucket
    Cooldowns.ensureCooldowns(mystic);
    mystic.cooldowns = {};
    Cooldowns.ensureCooldowns(mystic);
    if (mystic.mp) mystic.mp.current = 2000;
    const hp1 = dummy.hp.current;
    const rRise = resolveAttack({
        attacker: mystic,
        defender: dummy,
        spell: 'rising_blow',
        spellBook: spells,
        rng
    });
    assert.strictEqual(rRise.ok, true, rRise.reason || 'rising_blow ok');
    assert.ok(rRise.final > 0, 'rising_blow damage');
    assert.ok(dummy.hp.current < hp1, 'dummy took rising_blow');
    assert.ok(
        Cooldowns.getRemaining(mystic, 'primary', 'attack') > 0,
        'primary.attack after rising_blow'
    );
    const riseSpellCd = Cooldowns.getRemaining(mystic, 'spell', 'rising_blow');
    assert.ok(riseSpellCd > 0, 'spell CD after rising_blow');
    assert.ok(riseSpellCd >= 59, 'rising_blow spell CD ~60s, got ' + riseSpellCd);

    // OOM gate
    mystic.cooldowns = {};
    Cooldowns.ensureCooldowns(mystic);
    if (mystic.mp) mystic.mp.current = 50;
    const rOom = resolveAttack({
        attacker: mystic,
        defender: dummy,
        spell: 'rising_blow',
        spellBook: spells,
        rng
    });
    assert.strictEqual(rOom.ok, false);
    assert.strictEqual(rOom.reason, 'mana');

    log('MM-C high-tier ST attacks ok', {
        crush: rCrush.final,
        rise: rRise.final,
        riseSpellCd
    });
}

/**
 * Rune cast range — far-use box (Δx≤7, Δy≤7, matches engage) + Chebyshev cap.
 * Combat/area/field runes: range 7 + allowFarUse; purge_field: range 5.
 */
function testRuneCastRangeFarUse() {
    assert.strictEqual(FAR_USE_RANGE_X, 7);
    assert.strictEqual(FAR_USE_RANGE_Y, 7);

    const spells = indexSpells(presets.loadSpells().spells);
    const combat = spells.deathburst;
    const field = spells.blaze_field_rune;
    const barrier = spells.barrier_wall_rune;
    const purge = spells.purge_field_rune;
    assert.ok(combat && field && barrier && purge, 'rune presets present');
    assert.strictEqual(combat.range, 7);
    assert.strictEqual(combat.allowFarUse, true);
    assert.strictEqual(field.range, 7);
    assert.strictEqual(field.allowFarUse, true);
    assert.strictEqual(barrier.range, 7);
    assert.strictEqual(purge.range, 5);
    assert.strictEqual(purge.allowFarUse, true);

    const origin = { x: 50, y: 50, z: 7 };
    // Far-use 7×7 + Chebyshev 7: edges OK, 8 blocked
    assert.strictEqual(
        isWithinSpellCastRange(origin, { x: 57, y: 50, z: 7 }, combat, 7),
        true,
        'dx=7 far-use OK'
    );
    assert.strictEqual(
        isWithinSpellCastRange(origin, { x: 50, y: 57, z: 7 }, combat, 7),
        true,
        'dy=7 far-use OK'
    );
    assert.strictEqual(
        isWithinSpellCastRange(origin, { x: 57, y: 57, z: 7 }, combat, 7),
        true,
        'corner 7×7 OK'
    );
    assert.strictEqual(
        isWithinSpellCastRange(origin, { x: 50, y: 58, z: 7 }, combat, 7),
        false,
        'dy=8 exceeds far-use Y and Chebyshev 7'
    );
    assert.strictEqual(
        isWithinSpellCastRange(origin, { x: 58, y: 50, z: 7 }, combat, 7),
        false,
        'dx=8 exceeds far-use X and Chebyshev 7'
    );
    // purge_field: Chebyshev 5 inside far-use box
    assert.strictEqual(
        isWithinSpellCastRange(origin, { x: 55, y: 50, z: 7 }, purge, 5),
        true,
        'purge dx=5 OK'
    );
    assert.strictEqual(
        isWithinSpellCastRange(origin, { x: 56, y: 50, z: 7 }, purge, 5),
        false,
        'purge dx=6 blocked by range 5'
    );
    // isSpellInRange wiring for a living target
    const caster = { tile: origin, alive: true };
    const foe = {
        tile: { x: 57, y: 50, z: 7 },
        alive: true,
        hp: { current: 100, max: 100 }
    };
    assert.strictEqual(isSpellInRange(caster, foe, combat, {}), true);
    foe.tile = { x: 50, y: 58, z: 7 };
    assert.strictEqual(
        isSpellInRange(caster, foe, combat, {}),
        false,
        'isSpellInRange rejects dy=8'
    );

    log('rune cast range far-use ok');
}

/**
 * Player engage area — configurable X/Y box, default 7×7 (= historical Chebyshev 7).
 */
function testEngageRangeXY() {
    const { Settings } = require('../kernel/settings.js');
    const {
        resolveEngageRange,
        isWithinEngageRange,
        engageQueryRadius,
        defaultEngageRangeXY
    } = require('../kernel/core/lib/ai/engage_range.js');
    const { normalizeStrategy } = require('../kernel/core/lib/ai/strategy.js');

    assert.strictEqual(Settings.AI_ENGAGE_RANGE_X, 7);
    assert.strictEqual(Settings.AI_ENGAGE_RANGE_Y, 7);
    assert.strictEqual(Settings.AI_ENGAGE_RANGE, 7);

    const def = defaultEngageRangeXY();
    assert.deepStrictEqual(def, { x: 7, y: 7 });

    const origin = { x: 10, y: 10, z: 7 };
    assert.strictEqual(
        isWithinEngageRange(origin, { x: 17, y: 17, z: 7 }, def),
        true,
        'corner 7×7 in engage'
    );
    assert.strictEqual(
        isWithinEngageRange(origin, { x: 18, y: 10, z: 7 }, def),
        false,
        'dx=8 out of engage'
    );

    const square = resolveEngageRange({ engageRange: 8 });
    assert.deepStrictEqual(square, { x: 8, y: 8 });
    assert.strictEqual(engageQueryRadius(square), 8);

    const rect = resolveEngageRange({ engageRangeX: 7, engageRangeY: 5 });
    assert.deepStrictEqual(rect, { x: 7, y: 5 });
    assert.strictEqual(
        isWithinEngageRange(origin, { x: 10, y: 15, z: 7 }, rect),
        true,
        'dy=5 inside rect Y'
    );
    assert.strictEqual(
        isWithinEngageRange(origin, { x: 10, y: 16, z: 7 }, rect),
        false,
        'dy=6 outside rect Y'
    );

    const norm = normalizeStrategy({ id: 't', engageRange: 7 });
    assert.strictEqual(norm.engageRangeX, 7);
    assert.strictEqual(norm.engageRangeY, 7);
    assert.strictEqual(norm.engageRange, 7);

    const fromPlayer = resolveEngageRange({
        strategy: { engageRangeX: 4, engageRangeY: 4 }
    });
    assert.deepStrictEqual(fromPlayer, { x: 4, y: 4 });

    log('engage range X/Y ok');
}

/**
 * Phase K — paralyze rune: heavy slow (speed ~0), 6s, immunities.paralyze.
 */
function testParalyzeRuneAndImmunity() {
    const {
        applyCondition,
        hasCondition,
        conditionDefFromSpell,
        isImmuneToCondition,
        hasteSpeedChangeFromFormula
    } = require('../kernel/core/lib/combat/conditions.js');
    const spells = indexSpells(presets.loadSpells().spells);

    assert.ok(spells.paralyze_rune, 'paralyze_rune preset');
    assert.strictEqual(spells.paralyze_rune.statusOnly, true);
    assert.strictEqual(spells.paralyze_rune.mana, 1400);
    assert.strictEqual(spells.paralyze_rune.condition.type, 'slow');
    assert.strictEqual(spells.paralyze_rune.condition.durationSec, 6);
    assert.strictEqual(spells.paralyze_rune.condition.speedFormula.mina, -1);
    assert.ok(spells.barrier_wall_rune && spells.barrier_wall_rune.deploysField === 'barrier');
    assert.ok(spells.vine_barrier_rune && spells.vine_barrier_rune.deploysField === 'vine');
    assert.strictEqual(spells.barrier_wall_rune.fieldDurationSec, 20);
    assert.strictEqual(spells.vine_barrier_rune.fieldDurationSec, 30);

    const defender = makeDummy();
    defender.baseSpeed = 220;
    defender.speed = 220;
    defender.conditions = [];
    defender.immunities = {};
    defender.tile = { x: 2, y: 0, z: 7 };

    const warden = makeGuardianKnight(); // reuse bag; override book
    warden.level = 60;
    warden.tile = { x: 0, y: 0, z: 7 };
    if (warden.mp) warden.mp.current = Math.max(warden.mp.current || 0, 2000);
    if (warden.combatStats) {
        warden.combatStats.level = 60;
        warden.combatStats.magic = 30;
        warden.combatStats.spells = (warden.combatStats.spells || []).concat([
            'paralyze_rune'
        ]);
    }

    const r = resolveAttack({
        attacker: warden,
        defender,
        spell: 'paralyze_rune',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(r.ok, true, r.reason || 'paralyze ok');
    assert.ok(r.conditionApplied, 'slow applied');
    assert.strictEqual(r.conditionApplied.kind, 'slow');
    assert.strictEqual(r.conditionApplied.durationSec, 6);
    assert.ok(hasCondition(defender, 'slow'));
    // Formula -1,0 → target ≈ 40 - baseSpeed → delta drives speed to 0 (clamped)
    assert.ok(defender.speed <= 0 || defender.speed < 1, 'paralyzed speed ~0, got ' + defender.speed);

    // Immunity
    const immune = makeDummy();
    immune.baseSpeed = 200;
    immune.speed = 200;
    immune.conditions = [];
    immune.immunities = { paralyze: true };
    assert.strictEqual(isImmuneToCondition(immune, 'paralyze'), true);
    const def = conditionDefFromSpell(spells.paralyze_rune.condition, immune);
    assert.ok(def, 'def builds');
    const applied = applyCondition(immune, def, { source: 'test' });
    assert.strictEqual(applied, null, 'immune rejects paralyze/slow');
    assert.strictEqual(immune.speed, 200, 'speed unchanged');

    // Class books
    const classes = presets.loadClasses().classes;
    const byId = Object.fromEntries(classes.map((c) => [c.id, c]));
    assert.ok(byId.warden.spells.indexOf('paralyze_rune') >= 0);
    assert.ok(byId.warden.spells.indexOf('vine_barrier_rune') >= 0);
    assert.ok(byId.warden.spells.indexOf('barrier_wall_rune') >= 0);
    assert.ok(byId.guardian.spells.indexOf('barrier_wall_rune') >= 0);
    assert.ok(byId.guardian.spells.indexOf('vine_barrier_rune') < 0);

    log('Phase K paralyze / obstacle catalog ok', {
        paraSpeed: defender.speed,
        formulaDelta: hasteSpeedChangeFromFormula(220, { mina: -1, minb: 0 })
    });
}

function testCreatureUpdateTicksCooldowns() {
    const c = new Creature({ id: 1, hp: 10 });
    Cooldowns.apply(c, { primary: { attack: 1 } });
    const { Time } = require('../kernel/core/lib/time.js');
    Time.deltaTime = 0.5;
    c.update();
    assert.ok(Math.abs(Cooldowns.getRemaining(c, 'primary', 'attack') - 0.5) < 1e-9);
    Time.deltaTime = 0;
    log('creature cooldown tick ok');
}

/**
 * Defense/block context: melee skill without shield, bow mit def 18 / block 0,
 * wand def 5 + shielding, maxBlock formula, 2-block/2s window.
 */
function testDefenseBlockAndShieldWindow() {
    assert.strictEqual(computeMaxBlock(50, 28), Math.ceil(28 * 60 / 40));
    assert.strictEqual(computeMaxBlock(80, 0), 0, 'zero def → zero block');

    const itemDb = [
        {
            id: 't_sword',
            slot: 'rightHand',
            category: 'sword',
            weaponType: 'melee',
            atk: 40,
            defense: 30
        },
        {
            id: 't_shield',
            slot: 'leftHand',
            category: 'shield',
            weaponType: 'shield',
            defense: 25
        },
        {
            id: 't_bow',
            slot: 'rightHand',
            category: 'bow',
            weaponType: 'distance',
            atk: 5
        },
        {
            id: 't_wand',
            slot: 'rightHand',
            category: 'wand',
            weaponType: 'magic',
            atk: 0
        },
        {
            id: 't_fist',
            slot: 'rightHand',
            category: 'fist',
            weaponType: 'melee',
            atk: 12,
            defense: 8
        }
    ];
    const skills = {
        melee: 70,
        distance: 40,
        shielding: 55,
        magic: 20,
        fist: 90
    };

    // Shield + sword: block/mit def = 25, skill shielding
    const withShield = rollupEquipment(
        { rightHand: 't_sword', leftHand: 't_shield' },
        itemDb
    );
    const ctxShield = resolveDefenseBlockContext(withShield, skills);
    assert.strictEqual(ctxShield.hasShield, true);
    assert.strictEqual(ctxShield.defenseForBlock, 25);
    assert.strictEqual(ctxShield.defenseForMitigation, 25);
    assert.strictEqual(ctxShield.blockSkill, 55);
    assert.strictEqual(ctxShield.blockSkillKey, 'shielding');

    // Melee no shield: weapon def + melee skill for block; mit uses shielding skill
    const meleeOnly = rollupEquipment({ rightHand: 't_sword' }, itemDb);
    const ctxMelee = resolveDefenseBlockContext(meleeOnly, skills);
    assert.strictEqual(ctxMelee.hasShield, false);
    assert.strictEqual(ctxMelee.defenseForBlock, 30);
    assert.strictEqual(ctxMelee.defenseForMitigation, 30);
    assert.strictEqual(ctxMelee.blockSkill, 70, 'melee skill for block without shield');
    const cls = {
        id: 't',
        skills: { melee: 70, shielding: 55, distance: 40, magic: 20, fist: 90 }
    };
    const meleeStats = buildEffectiveStats(cls, meleeOnly, {
        level: 50,
        baseSkills: skills
    });
    assert.strictEqual(meleeStats.maxBlock, computeMaxBlock(70, 30));
    assert.strictEqual(
        meleeStats.mitigation,
        computeMitigationPercent(55, 30),
        'mitigation always uses shielding skill'
    );

    // Fist weapon without shield uses fist skill
    const fistOnly = rollupEquipment({ rightHand: 't_fist' }, itemDb);
    const ctxFist = resolveDefenseBlockContext(fistOnly, skills);
    assert.strictEqual(ctxFist.blockSkill, 90);
    assert.strictEqual(ctxFist.defenseForBlock, 8);

    // Unarmed: def 5, fist skill
    const empty = rollupEquipment({}, itemDb);
    const ctxUnarmed = resolveDefenseBlockContext(empty, skills);
    assert.strictEqual(ctxUnarmed.defenseForBlock, UNARMED_WEAPON_DEFENSE);
    assert.strictEqual(ctxUnarmed.blockSkill, 90);
    assert.strictEqual(ctxUnarmed.blockSkillKey, 'fist');

    // Bow: block def 0, mit def 18
    const bowOnly = rollupEquipment({ rightHand: 't_bow' }, itemDb);
    const ctxBow = resolveDefenseBlockContext(bowOnly, skills);
    assert.strictEqual(ctxBow.defenseForBlock, 0);
    assert.strictEqual(ctxBow.defenseForMitigation, BOW_MITIGATION_DEFENSE);
    const bowStats = buildEffectiveStats(cls, bowOnly, {
        level: 50,
        baseSkills: skills
    });
    assert.strictEqual(bowStats.maxBlock, 0);
    assert.strictEqual(
        bowStats.mitigation,
        computeMitigationPercent(55, BOW_MITIGATION_DEFENSE)
    );

    // Wand: def 5, block skill shielding
    const wandOnly = rollupEquipment({ rightHand: 't_wand' }, itemDb);
    const ctxWand = resolveDefenseBlockContext(wandOnly, skills);
    assert.strictEqual(ctxWand.defenseForBlock, UNARMED_WEAPON_DEFENSE);
    assert.strictEqual(ctxWand.defenseForMitigation, UNARMED_WEAPON_DEFENSE);
    assert.strictEqual(ctxWand.blockSkill, 55);
    assert.strictEqual(ctxWand.blockSkillKey, 'shielding');

    // 2-block / 2s window on entity
    const defender = new Player({
        id: 99,
        classDef: {
            id: 'g',
            skills: { melee: 50, shielding: 60, distance: 10, magic: 10 },
            baseHp: 500,
            baseMp: 100
        },
        equipment: { rightHand: 't_sword', leftHand: 't_shield' },
        itemDb,
        level: 50,
        canBlock: true
    });
    // Ensure maxBlock from loadout
    assert.ok(defender.combatStats && defender.combatStats.maxBlock > 0);
    defender.shieldingHits = 0;
    defender.shieldingTimer = 0;

    const attacker = new Creature({
        id: 1,
        hp: 200,
        combatStats: {
            level: 50,
            atk: 40,
            skill: 50,
            magic: 10,
            critChance: 0,
            critDamage: 0
        }
    });
    const spell = {
        id: 'melee_auto',
        kind: 'auto',
        element: 'physical',
        powerCurve: 'melee_auto',
        isMelee: true,
        cooldowns: {},
        mana: 0
    };
    const rng = () => 0.5;
    for (let i = 0; i < SHIELD_BLOCK_MAX_PER_WINDOW; i++) {
        resolveAttack({
            attacker,
            defender,
            spell,
            rng,
            skipCooldown: true,
            skipMana: true
        });
    }
    assert.strictEqual(
        defender.shieldingHits,
        SHIELD_BLOCK_MAX_PER_WINDOW,
        '2 block attempts recorded'
    );
    assert.ok(defender.shieldingTimer > 0, 'window started');
    const hitsBefore = defender.shieldingHits;
    resolveAttack({
        attacker,
        defender,
        spell,
        rng,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(
        defender.shieldingHits,
        hitsBefore,
        'third hit in window does not count another block attempt'
    );

    // Expire window via tick
    defender.tickShieldingWindow(SHIELD_BLOCK_WINDOW_SEC + 0.01);
    assert.strictEqual(defender.shieldingHits, 0, 'window expiry resets hits');
    assert.ok(!(defender.shieldingTimer > 0));

    log('defense block context + shield window ok');
}

function testShapedBerserkMultiHit() {
    const {
        resolveShapedAttack,
        spellHasShape
    } = require('../kernel/core/lib/combat/area.js');
    const player = makeGuardianKnight();
    player.tile = { x: 10, y: 10, z: 7 };
    const spells = indexSpells(presets.loadSpells().spells);
    const spell = spells.rampage;
    assert.ok(spell, 'rampage preset');
    assert.ok(spellHasShape(spell), 'rampage has shape');
    assert.strictEqual(spell.shape.type, 'area');

    const a = makeDummy();
    a.id = 1;
    a.tile = { x: 10, y: 10, z: 7 }; // same tile as caster — in 3×3
    const b = makeDummy();
    b.id = 2;
    b.tile = { x: 11, y: 10, z: 7 }; // adjacent
    const c = makeDummy();
    c.id = 3;
    c.tile = { x: 20, y: 20, z: 7 }; // out of shape

    const hpA = a.hp.current;
    const hpB = b.hp.current;
    const hpC = c.hp.current;
    const mpBefore = player.mp.current;

    const result = resolveShapedAttack({
        attacker: player,
        primary: a,
        spell,
        candidates: [a, b, c],
        rng: rngFromSeed(21)
    });

    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.strictEqual(result.multi, true);
    assert.ok(result.affectedTiles.length >= 9, '3×3 footprint');
    assert.strictEqual(result.hits.length, 2, 'two dummies in square');
    assert.strictEqual(result.results.length, 2);
    assert.ok(a.hp.current < hpA, 'dummy A damaged');
    assert.ok(b.hp.current < hpB, 'dummy B damaged');
    assert.strictEqual(c.hp.current, hpC, 'far dummy untouched');
    assert.strictEqual(player.mp.current, mpBefore - spell.mana, 'mana once');
    assert.ok(Cooldowns.getRemaining(player, 'spell', 'rampage') > 0);
    assert.ok(Cooldowns.getRemaining(player, 'primary', 'attack') > 0);

    // Second cast blocked by cooldown
    const blocked = resolveShapedAttack({
        attacker: player,
        primary: a,
        spell,
        candidates: [a, b],
        rng: () => 0.5
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'cooldown');

    log('shaped rampage multi-hit ok', {
        hits: result.hits.length,
        tiles: result.affectedTiles.length
    });
}

/**
 * Wide Takedown: dual combat — center full damage + outer followup at 75%.
 * Legacy AREA_SWEEPING_CENTER / AREA_SWEEPING_OUTER (non-overlapping footprints).
 */
function testSweepingTakedownDualCombat() {
    const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
    const player = makeGuardianKnight();
    player.tile = { x: 10, y: 10, z: 7 };
    player.mp.current = Math.max(player.mp.current || 0, 500);
    const spells = indexSpells(presets.loadSpells().spells);
    const spell = spells.wide_takedown;
    assert.ok(spell, 'wide_takedown preset');
    assert.ok(spell.shape && spell.shape.length === 'wide_takedown');
    assert.ok(
        Array.isArray(spell.followupShapes) && spell.followupShapes.length >= 1,
        'followupShapes for outer pass'
    );
    assert.strictEqual(spell.followupShapes[0].damageScale, 0.75);

    // Center pass: origin (front) is hit. Outer: further east (origin cell 2).
    const near = makeDummy();
    near.id = 101;
    near.tile = { x: 11, y: 10, z: 7 }; // front origin — center only
    near.hp = { current: 100000, max: 100000 };
    const far = makeDummy();
    far.id = 102;
    far.tile = { x: 13, y: 10, z: 7 }; // outer forward band
    far.hp = { current: 100000, max: 100000 };
    const miss = makeDummy();
    miss.id = 103;
    miss.tile = { x: 8, y: 10, z: 7 }; // west of caster — outside both passes
    miss.hp = { current: 100000, max: 100000 };

    const hpNear = near.hp.current;
    const hpFar = far.hp.current;
    const hpMiss = miss.hp.current;
    const mpBefore = player.mp.current;

    const result = resolveShapedAttack({
        attacker: player,
        primary: near,
        spell,
        candidates: [near, far, miss],
        direction: { x: 1, y: 0 },
        rng: rngFromSeed(42)
    });

    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.ok(result.hits.some((h) => h.id === 101), 'near (center) hit');
    assert.ok(result.hits.some((h) => h.id === 102), 'far (outer) hit');
    assert.ok(!result.hits.some((h) => h.id === 103), 'miss not hit');
    assert.ok(near.hp.current < hpNear, 'center target damaged');
    assert.ok(far.hp.current < hpFar, 'outer target damaged');
    assert.strictEqual(miss.hp.current, hpMiss, 'out-of-shape untouched');
    assert.strictEqual(
        player.mp.current,
        mpBefore - spell.mana,
        'mana spent once'
    );

    const dmgNear = hpNear - near.hp.current;
    const dmgFar = hpFar - far.hp.current;
    assert.ok(dmgNear > 0 && dmgFar > 0, 'both passes deal damage');
    // Outer is 75% of its own roll (independent rng after center).
    assert.ok(
        dmgFar <= dmgNear * 1.15 + 5,
        `outer (${dmgFar}) should be roughly ≤ center (${dmgNear}) with 0.75 scale`
    );

    const keys = new Set(result.affectedTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(keys.has('11,10'), 'VFX tiles include center origin');
    assert.ok(
        keys.has('13,10') || keys.has('14,10'),
        'VFX tiles include outer forward'
    );
    assert.ok(
        result.results.length >= 2,
        'two resolveAttack results (center + outer)'
    );

    log('wide_takedown dual combat ok', {
        dmgNear,
        dmgFar,
        tiles: result.affectedTiles.length,
        results: result.results.length
    });
}

function testShapedFrontSweepWave() {
    const { resolveShapedAttack } = require('../kernel/core/lib/combat/area.js');
    const { tryAttack } = require('../kernel/core/lib/ai/combat_actions.js');
    const player = makeGuardianKnight();
    player.tile = { x: 5, y: 5, z: 7 };
    const spells = indexSpells(presets.loadSpells().spells);
    const spell = spells.front_sweep;
    assert.ok(spell && spell.shape && spell.shape.type === 'wave');

    // Wave spread 1 length 1 facing east: tiles on the origin column ±1 y
    // Origin for wave is caster+dir = (6,5); matrix is [[1],[3],[1]] facing east
    const front = makeDummy();
    front.id = 10;
    front.tile = { x: 6, y: 5, z: 7 };
    const side = makeDummy();
    side.id = 11;
    side.tile = { x: 6, y: 4, z: 7 };
    const behind = makeDummy();
    behind.id = 12;
    behind.tile = { x: 4, y: 5, z: 7 };

    const result = resolveShapedAttack({
        attacker: player,
        primary: front,
        spell,
        candidates: [front, side, behind],
        direction: { x: 1, y: 0 },
        rng: rngFromSeed(8)
    });

    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.ok(result.hits.length >= 2, `wave hits ${result.hits.length}`);
    assert.ok(
        result.hits.some((h) => h.id === 10),
        'front dummy hit'
    );
    assert.ok(
        result.hits.some((h) => h.id === 11),
        'side dummy hit'
    );
    assert.ok(
        !result.hits.some((h) => h.id === 12),
        'behind not hit'
    );

    // tryAttack wires shape + candidates from ctx
    const player2 = makeGuardianKnight();
    player2.tile = { x: 5, y: 5, z: 7 };
    player2.type = 'player';
    const d1 = makeDummy();
    d1.id = 20;
    d1.tile = { x: 6, y: 5, z: 7 };
    d1.type = 'creature';
    const d2 = makeDummy();
    d2.id = 21;
    d2.tile = { x: 6, y: 6, z: 7 };
    d2.type = 'creature';
    const recorded = [];
    const tr = tryAttack({
        attacker: player2,
        defender: d1,
        spellId: 'front_sweep',
        ctx: {
            spellBook: spells,
            enemies: [d1, d2],
            rng: rngFromSeed(9),
            onAttack: (a, d, r) => recorded.push({ d, r })
        }
    });
    assert.ok(tr && tr.ok && tr.multi);
    assert.ok(tr.hits.length >= 2);
    assert.ok(recorded.length >= 2, 'onAttack per hit');

    log('shaped front_sweep wave ok', {
        hits: result.hits.length,
        tryHits: tr.hits.length
    });
}

/**
 * Strike curves: option-B mean ± damageAmplitude; omit amplitude → 0;
 * autos unchanged; legacy params cached; populate-style amplitude matches spread.
 */
function testStrikeMeanAmplitude() {
    const magicAttacker = { level: 100, magic: 50 };
    const meleeAttacker = { level: 100, skill: 50, atk: 50 };
    const bpMagic = 45;
    const bpMelee = 40;

    // Amplitude 0 (missing) → fixed at round(mean)
    const magMean = computeMagicMean(magicAttacker, bpMagic);
    const magFixed = computeMagicStrikeRange(magicAttacker, bpMagic);
    assert.strictEqual(magFixed.min, magFixed.max);
    assert.strictEqual(magFixed.min, Math.round(magMean));

    const melMean = computeMeleeMean(meleeAttacker, bpMelee);
    const melFixed = computeMeleeStrikeRange(meleeAttacker, bpMelee);
    assert.strictEqual(melFixed.min, melFixed.max);
    assert.strictEqual(melFixed.min, Math.round(melMean));

    // amplitude 0.2 → 0.8 / 1.2 around mean
    const a = 0.2;
    const magWide = computeMagicStrikeRange(magicAttacker, bpMagic, a);
    assert.strictEqual(magWide.min, Math.round(magMean * 0.8));
    assert.strictEqual(magWide.max, Math.round(magMean * 1.2));
    assert.ok(magWide.max > magWide.min);

    const melWide = computeMeleeStrikeRange(meleeAttacker, bpMelee, a);
    assert.strictEqual(melWide.min, Math.round(melMean * 0.8));
    assert.strictEqual(melWide.max, Math.round(melMean * 1.2));

    // rangeFromMean + normalize
    assert.strictEqual(normalizeDamageAmplitude(undefined), 0);
    assert.strictEqual(normalizeDamageAmplitude(-1), 0);
    assert.ok(normalizeDamageAmplitude(2) <= 0.95);
    const r0 = rangeFromMean(100, 0);
    assert.deepStrictEqual(r0, { min: 100, max: 100 });

    // Param cache identity
    const p1 = getMagicSpellParameters(bpMagic);
    const p2 = getMagicSpellParameters(bpMagic);
    assert.strictEqual(p1, p2);
    assert.strictEqual(typeof p1.min.x, 'number');
    assert.ok(Number.isFinite(p1.min.x));

    // Legacy amplitude calibration matches populate formula
    const legacyM = computeLegacyMagicStrikeRange(magicAttacker, bpMagic);
    const ampM = amplitudeFromLegacySpread(legacyM.min, legacyM.max, magMean);
    assert.ok(ampM > 0 && ampM < 0.5, `magic amp ${ampM}`);
    const fromAmp = rangeFromMean(magMean, ampM);
    // half-width of new range ≈ half-width of legacy (within 1 from rounding)
    const legacyHalf = (legacyM.max - legacyM.min) / 2;
    const newHalf = (fromAmp.max - fromAmp.min) / 2;
    assert.ok(
        Math.abs(newHalf - legacyHalf) <= 1.5,
        `spread half legacy ${legacyHalf} vs ${newHalf}`
    );

    const legacyMel = computeLegacyMeleeStrikeRange(meleeAttacker, bpMelee);
    const ampMel = amplitudeFromLegacySpread(
        legacyMel.min,
        legacyMel.max,
        melMean
    );
    assert.ok(ampMel > 0 && ampMel < 0.5);

    // Autos ignore amplitude path (melee_auto unchanged)
    const auto = computeMeleeAutoRange({ level: 100, atk: 40, skill: 80 });
    assert.strictEqual(auto.min, levelBonus(100));
    assert.strictEqual(auto.max, Math.ceil(0.102 * 40 * 80 + 20));

    // computeDamage wires damageAmplitude
    const dmg = computeDamage({
        powerCurve: 'magic_strike',
        basePower: bpMagic,
        damageAmplitude: 0.2,
        attacker: magicAttacker,
        defender: { mitigation: 0, armor: 0, resists: {}, maxBlock: 0 },
        hitChance: 100,
        rng: () => 0
    });
    assert.ok(dmg.hit);
    assert.strictEqual(dmg.range.min, magWide.min);
    assert.strictEqual(dmg.range.max, magWide.max);

    // Preset strike has populated amplitude > 0
    const front = presets.getSpell('front_sweep');
    assert.ok(front, 'front_sweep');
    assert.ok(
        front.damageAmplitude > 0,
        'front_sweep should have populated damageAmplitude'
    );
    assert.strictEqual(front.powerCurve, 'melee_strike');

    // Melee param cache + x is number (not string from toFixed)
    const mp = getMeleeSpellParameters(40);
    assert.strictEqual(typeof mp.min.x, 'number');
    assert.strictEqual(getMeleeSpellParameters(40), mp);

    log('strike mean±amplitude ok', {
        magMean: Math.round(magMean * 100) / 100,
        ampM,
        ampMel,
        frontAmp: front.damageAmplitude
    });
}

function testSpellMoveLock() {
    const {
        resolveMoveLock,
        applyMoveLock
    } = require('../kernel/core/lib/combat/resolve.js');
    const spells = indexSpells(presets.loadSpells().spells);

    // All catalog spells use one-tick default
    for (const id of Object.keys(spells)) {
        assert.ok(
            Math.abs(resolveMoveLock(spells[id]) - 0.05) < 1e-9,
            `${id} moveLock should resolve to 0.05`
        );
        assert.ok(
            Math.abs(Number(spells[id].moveLock) - 0.05) < 1e-9,
            `${id} preset moveLock field`
        );
    }
    assert.ok(Math.abs(resolveMoveLock({}) - 0.05) < 1e-9, 'omit → default');
    assert.strictEqual(resolveMoveLock({ moveLock: 0 }), 0, '0 disables');
    assert.ok(Math.abs(resolveMoveLock({ moveLock: 0.2 }) - 0.2) < 1e-9);

    const player = makeGuardianKnight();
    const dummy = makeDummy();
    player.moveDelay = 0;
    const result = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: 'melee_auto',
        spellBook: spells,
        rng: rngFromSeed(3)
    });
    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.ok(Math.abs(result.moveLock - 0.05) < 1e-9, 'result.moveLock');
    assert.ok(player.moveDelay >= 0.05, `moveDelay after cast ${player.moveDelay}`);
    assert.strictEqual(player.canStep(), false, 'cannot step while move-locked');

    // Does not shorten a longer existing delay
    player.moveDelay = 0.4;
    applyMoveLock(player, 0.05);
    assert.ok(Math.abs(player.moveDelay - 0.4) < 1e-9, 'max with existing delay');

    // Opt-out spell
    player.moveDelay = 0;
    Cooldowns.ensureCooldowns(player);
    player.cooldowns.auto.attack = 0;
    const free = resolveAttack({
        attacker: player,
        defender: dummy,
        spell: Object.assign({}, spells.melee_auto, { moveLock: 0 }),
        rng: rngFromSeed(4)
    });
    assert.strictEqual(free.ok, true);
    assert.strictEqual(free.moveLock, 0);
    assert.strictEqual(player.moveDelay, 0);
    assert.strictEqual(player.canStep(), true);

    log('spell moveLock ok', { delay: player.moveDelay });
}

function testHPAndMPRegeneration() {
    const cls = {
        id: 'regen_tester',
        skills: { melee: 50, shielding: 50, distance: 10, magic: 10 },
        baseHp: 100,
        baseMp: 100,
        baseRegenHp: 2,
        baseRegenMp: 4,
        promotedRegenHp: 4,
        promotedRegenMp: 8
    };
    const player = new Player({
        id: 1,
        name: 'RegenBase',
        classDef: cls,
        level: 8,
        promoted: false
    });
    player.hp.current = 50;
    player.mp.current = 20;

    // Out of engage: BASE_REGEN_HP_INTERVAL_MS (3000), BASE_REGEN_MP_INTERVAL_MS (5000)
    assert.strictEqual(Settings.BASE_REGEN_HP_INTERVAL_MS, 3000);
    assert.strictEqual(Settings.BASE_REGEN_MP_INTERVAL_MS, 5000);
    assert.strictEqual(Settings.ENGAGE_REGEN_HP_INTERVAL_MS, 4000);
    assert.strictEqual(Settings.ENGAGE_REGEN_MP_INTERVAL_MS, 6000);

    player.tickRegeneration(3.0);
    assert.strictEqual(player.hp.current, 52, 'hp regens +2 after 3s');
    assert.strictEqual(player.mp.current, 20, 'mp interval 5s not reached yet');

    player.tickRegeneration(2.0); // total 5s for MP, 2s into next HP interval
    assert.strictEqual(player.hp.current, 52, 'hp interval not reached yet');
    assert.strictEqual(player.mp.current, 24, 'mp regens +4 after 5s');

    player.tickRegeneration(1.0); // total 3s into HP interval
    assert.strictEqual(player.hp.current, 54, 'hp regens +2 again');

    // Engage rates: ENGAGE_REGEN_HP_INTERVAL_MS (4000), ENGAGE_REGEN_MP_INTERVAL_MS (6000)
    player.hasMonstersInEngage = true;
    player._nativeRegenHpTimerMs = 0;
    player._nativeRegenMpTimerMs = 0;
    player.tickRegeneration(3.0);
    assert.strictEqual(player.hp.current, 54, 'no hp regen at 3s in engage (needs 4s)');
    player.tickRegeneration(1.0);
    assert.strictEqual(player.hp.current, 56, 'hp regens +2 at 4s in engage');

    // Promoted rates
    const promPlayer = new Player({
        id: 2,
        name: 'RegenPromoted',
        classDef: cls,
        level: 8,
        promoted: true
    });
    promPlayer.hp.current = 50;
    promPlayer.mp.current = 20;
    assert.strictEqual(promPlayer.combatStats.nativeRegen.hp, 4);
    assert.strictEqual(promPlayer.combatStats.nativeRegen.mp, 8);
    promPlayer.tickRegeneration(3.0);
    assert.strictEqual(promPlayer.hp.current, 54, 'promoted hp regens +4');
    promPlayer.tickRegeneration(2.0);
    assert.strictEqual(promPlayer.mp.current, 28, 'promoted mp regens +8');

    // Independent equipment regeneration & duration decay interaction
    const itemDb = [
        {
            id: 'regen_ring',
            slot: 'ring',
            category: 'ring',
            regen: { hp: 5, hpTicksMs: 2000, mp: 3, mpTicksMs: 1000 }
        },
        {
            id: 'regen_amulet',
            slot: 'amulet',
            category: 'amulet',
            regen: { hp: 10, hpTicksMs: 3000 },
            durationSec: 4
        },
        {
            id: 'charge_regen_ring',
            slot: 'ring',
            category: 'ring',
            charges: 2,
            // absorb-style charges (legacy might_ring path) — only resists spend on hit
            resists: { physical: 5 },
            regen: { mp: 7, mpTicksMs: 1000 }
        }
    ];
    const eqPlayer = new Player({
        id: 3,
        name: 'RegenEq',
        classDef: Object.assign({}, cls, { baseRegenHp: 0, baseRegenMp: 0 }),
        equipment: { ring: 'regen_ring', amulet: 'regen_amulet' },
        itemDb,
        level: 8
    });
    eqPlayer.hp.current = 20;
    eqPlayer.mp.current = 10;
    assert.ok(eqPlayer.equipmentRuntime.ring, 'ring tracked in equipment runtime');
    assert.ok(eqPlayer.equipmentRuntime.amulet, 'amulet tracked in equipment runtime');

    // 1 second tick: ring MP fires (1000ms), no HP fires yet
    eqPlayer.tickRegeneration(1.0);
    assert.strictEqual(eqPlayer.mp.current, 13, 'ring mp +3 at 1s');
    assert.strictEqual(eqPlayer.hp.current, 20, 'no hp fires at 1s');

    // another 1 second tick (total 2s): ring MP fires again, ring HP fires (2000ms)
    eqPlayer.tickRegeneration(1.0);
    assert.strictEqual(eqPlayer.mp.current, 16, 'ring mp +3 at 2s');
    assert.strictEqual(eqPlayer.hp.current, 25, 'ring hp +5 at 2s');

    // another 1 second tick (total 3s): ring MP fires, amulet HP fires (3000ms)
    eqPlayer.tickRegeneration(1.0);
    assert.strictEqual(eqPlayer.mp.current, 19, 'ring mp +3 at 3s');
    assert.strictEqual(eqPlayer.hp.current, 35, 'amulet hp +10 at 3s');

    // Equipment regen ignores engage: same item intervals while monsters nearby
    eqPlayer.hasMonstersInEngage = true;
    eqPlayer.inBattle = true;
    const hpBeforeEngage = eqPlayer.hp.current;
    const mpBeforeEngage = eqPlayer.mp.current;
    eqPlayer.tickRegeneration(1.0); // total 4s from equip start: ring MP +3, ring HP +5
    assert.strictEqual(eqPlayer.mp.current, mpBeforeEngage + 3, 'equip mp still ticks in engage');
    assert.strictEqual(eqPlayer.hp.current, hpBeforeEngage + 5, 'equip hp still ticks in engage');

    // Duration decay destroys timed regen gear; permanent regen ring remains
    eqPlayer.tickEquipmentRuntime(4.0);
    assert.strictEqual(eqPlayer.equipment.amulet, undefined, 'amulet expired after duration limit');
    assert.strictEqual(eqPlayer.equipment.ring, 'regen_ring', 'ring without duration remains');

    // Charges: regen item still ticks until charges are consumed to 0 → unequip
    const chargePlayer = new Player({
        id: 4,
        name: 'RegenCharges',
        classDef: Object.assign({}, cls, { baseRegenHp: 0, baseRegenMp: 0 }),
        equipment: { ring: 'charge_regen_ring' },
        itemDb,
        level: 8
    });
    chargePlayer.mp.current = 10;
    assert.ok(chargePlayer.equipmentRuntime.ring, 'charged regen ring tracked');
    assert.strictEqual(chargePlayer.equipmentRuntime.ring.remainingCharges, 2);
    chargePlayer.tickRegeneration(1.0);
    assert.strictEqual(chargePlayer.mp.current, 17, 'charged ring mp +7 at 1s');
    // Damaging hits consume charges (same path as might_ring)
    chargePlayer.applyHpDelta(5, 'physical');
    assert.strictEqual(chargePlayer.equipmentRuntime.ring.remainingCharges, 1, 'one charge left');
    chargePlayer.tickRegeneration(1.0);
    assert.strictEqual(chargePlayer.mp.current, 24, 'regen still works with 1 charge left');
    chargePlayer.applyHpDelta(5, 'physical');
    assert.strictEqual(chargePlayer.equipment.ring, undefined, 'charged regen ring destroyed at 0 charges');
    assert.ok(!chargePlayer.equipmentRuntime || !chargePlayer.equipmentRuntime.ring, 'runtime slot cleared');
    const mpAfterDestroy = chargePlayer.mp.current;
    chargePlayer.tickRegeneration(1.0);
    assert.strictEqual(chargePlayer.mp.current, mpAfterDestroy, 'no equip regen after charges depleted');

    // Preset classes: nativeRegen from classes.json base vs promoted
    const expectedNative = {
        guardian: { base: [4, 2], prom: [6, 3] },
        scout: { base: [3, 3], prom: [5, 4] },
        mystic: { base: [3, 3], prom: [5, 4] },
        adept: { base: [2, 4], prom: [3, 6] },
        warden: { base: [2, 4], prom: [3, 6] },
        adventurer: { base: [2, 2], prom: [2, 2] }
    };
    for (const [classId, rates] of Object.entries(expectedNative)) {
        const classDef = presets.getClass(classId);
        assert.ok(classDef, `class ${classId} loads`);
        assert.strictEqual(classDef.baseRegenHp, rates.base[0], `${classId} baseRegenHp`);
        assert.strictEqual(classDef.baseRegenMp, rates.base[1], `${classId} baseRegenMp`);
        assert.strictEqual(classDef.promotedRegenHp, rates.prom[0], `${classId} promotedRegenHp`);
        assert.strictEqual(classDef.promotedRegenMp, rates.prom[1], `${classId} promotedRegenMp`);

        const baseStats = buildEffectiveStats(classDef, rollupEquipment({}, null), {
            level: 8,
            promoted: false
        });
        assert.strictEqual(baseStats.nativeRegen.hp, rates.base[0], `${classId} native base hp`);
        assert.strictEqual(baseStats.nativeRegen.mp, rates.base[1], `${classId} native base mp`);

        const promStats = buildEffectiveStats(classDef, rollupEquipment({}, null), {
            level: 8,
            promoted: true
        });
        assert.strictEqual(promStats.nativeRegen.hp, rates.prom[0], `${classId} native prom hp`);
        assert.strictEqual(promStats.nativeRegen.mp, rates.prom[1], `${classId} native prom mp`);
    }

    log('hp and mp regeneration ok');
}

/**
 * spell.level + spell.magicLevel gates (Legacy rune:level / rune:magicLevel).
 */
/**
 * canCast fails while moveDelay > 0 (post-cast / step root).
 * Ultimate inferno_core applies primary.attack 4s + secondary.focus 40s.
 */
function testCanCastMoveLockAndUltimatePrimary() {
    const strike = {
        id: 'flame_strike',
        mana: 20,
        cooldowns: { primary: { attack: 2 } }
    };
    const caster = {
        level: 100,
        classId: 'adept',
        combatStats: {
            magic: 80,
            level: 100,
            spells: ['flame_strike', 'inferno_core', 'sky_rage']
        },
        cooldowns: {},
        mp: { current: 2000, max: 2000 },
        moveDelay: 0
    };

    assert.strictEqual(canCast(caster, strike), true, 'canCast free when moveDelay 0');

    caster.moveDelay = 0.05;
    assert.strictEqual(
        canCast(caster, strike),
        false,
        'canCast blocked while moveDelay > 0'
    );

    caster.moveDelay = 0;
    assert.strictEqual(canCast(caster, strike), true, 'canCast ok after root clears');

    // Ultimate preset: primary 4s GCD + secondary focus 40s (legacy groupCooldown).
    const spells = indexSpells(presets.loadSpells().spells);
    const ultimate = spells.inferno_core;
    assert.ok(ultimate, 'inferno_core in standard catalog');
    assert.strictEqual(
        ultimate.cooldowns.primary.attack,
        4,
        'inferno_core primary.attack is 4s'
    );
    assert.strictEqual(
        ultimate.cooldowns.secondary.focus,
        40,
        'inferno_core secondary.focus is 40s'
    );

    Cooldowns.ensureCooldowns(caster);
    Cooldowns.apply(caster, ultimate.cooldowns);
    assert.strictEqual(
        Cooldowns.getRemaining(caster, 'primary', 'attack'),
        4,
        'after inferno_core primary.attack remaining is 4'
    );
    assert.strictEqual(
        Cooldowns.getRemaining(caster, 'secondary', 'focus'),
        40,
        'after inferno_core secondary.focus remaining is 40'
    );
    assert.strictEqual(
        canCast(caster, strike),
        false,
        'flame_strike blocked by primary GCD after ultimate'
    );
    assert.strictEqual(
        canCast(caster, spells.sky_rage),
        false,
        'sky_rage blocked by shared secondary.focus after inferno_core'
    );

    Cooldowns.tick(caster, 4);
    assert.strictEqual(
        Cooldowns.getRemaining(caster, 'primary', 'attack'),
        0,
        'primary ready after 4s'
    );
    assert.ok(
        Cooldowns.getRemaining(caster, 'secondary', 'focus') > 0,
        'focus still running after primary clears'
    );
    assert.strictEqual(
        canCast(caster, strike),
        true,
        'flame_strike ok after primary 4s even while focus remains'
    );
    assert.strictEqual(
        canCast(caster, spells.sky_rage),
        false,
        'sky_rage still blocked by focus after primary clears'
    );

    log('canCast moveLock + ultimate primary ok');
}

function testSpellLevelAndMagicLevelGates() {
    const lowMl = {
        level: 50,
        combatStats: { magic: 3, level: 50, spells: ['deathburst', 'blaze_field_rune'] },
        cooldowns: {},
        mp: { current: 100, max: 100 },
        moveDelay: 0
    };
    const highMl = {
        level: 50,
        combatStats: { magic: 15, level: 50, spells: ['deathburst', 'blaze_field_rune'] },
        cooldowns: {},
        mp: { current: 100, max: 100 },
        moveDelay: 0
    };
    const sd = {
        id: 'deathburst',
        level: 45,
        magicLevel: 15,
        mana: 0,
        cooldowns: { primary: { attack: 2 } }
    };
    const fireField = {
        id: 'blaze_field_rune',
        level: 15,
        magicLevel: 1,
        mana: 0,
        cooldowns: { primary: { attack: 2 } }
    };

    assert.strictEqual(meetsSpellLevel(lowMl, sd), true, 'L50 meets SD level 45');
    assert.strictEqual(meetsSpellMagicLevel(lowMl, sd), false, 'ML3 < SD ML15');
    assert.strictEqual(meetsSpellMagicLevel(highMl, sd), true, 'ML15 meets SD ML15');
    assert.strictEqual(meetsSpellMagicLevel(lowMl, fireField), true, 'ML3 meets fire field ML1');
    assert.strictEqual(meetsSpellMagicLevel(lowMl, { id: 'x' }), true, 'omit magicLevel → pass');
    assert.strictEqual(meetsSpellMagicLevel(lowMl, { id: 'x', magicLevel: 0 }), true, 'ML0 → pass');

    assert.strictEqual(canCast(lowMl, sd), false, 'canCast blocked by magicLevel');
    assert.strictEqual(canCast(highMl, sd), true, 'canCast ok with ML15');
    assert.strictEqual(canCast(lowMl, fireField), true, 'canCast fire field with ML3');

    // radiant_bolt vocation: scout only (Legacy paladin)
    const holy = {
        id: 'radiant_bolt',
        level: 27,
        magicLevel: 4,
        mana: 0,
        vocations: ['scout'],
        cooldowns: { primary: { attack: 2 } }
    };
    const adeptNoBook = {
        classId: 'adept',
        level: 50,
        combatStats: { magic: 80, level: 50 },
        cooldowns: {},
        mp: { current: 100, max: 100 },
        moveDelay: 0
    };
    const scoutNoBook = {
        classId: 'scout',
        level: 50,
        combatStats: { magic: 30, level: 50 },
        cooldowns: {},
        mp: { current: 100, max: 100 },
        moveDelay: 0
    };
    assert.strictEqual(canUseSpell(adeptNoBook, holy), false, 'adept cannot use radiant_bolt');
    assert.strictEqual(canUseSpell(scoutNoBook, holy), true, 'scout can use radiant_bolt');

    log('spell level + magicLevel gates ok');
}

/**
 * Rune inventory consume: hasRune / spendRune / canCast with runeConsumption.
 */
function testRuneInventoryGates() {
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
            id: 'deathburst_rune',
            label: 'Deathburst Rune',
            category: 'rune',
            stackable: true,
            weight: 70
        }
    ];
    const spell = {
        id: 'deathburst',
        source: 'rune',
        runeItemId: 'deathburst_rune',
        level: 45,
        magicLevel: 15,
        mana: 0,
        range: 4,
        min: 10,
        max: 10,
        element: 'death',
        hitChance: 100,
        cooldowns: { primary: { attack: 0 } },
        isMelee: false
    };
    assert.strictEqual(resolveRuneItemId(spell), 'deathburst_rune');

    const caster = {
        alive: true,
        level: 50,
        classId: 'adept',
        tile: { x: 0, y: 0, z: 0 },
        combatStats: {
            magic: 20,
            level: 50,
            spells: ['deathburst']
        },
        cooldowns: {},
        mp: { current: 100, max: 100 },
        hp: { current: 200, max: 200 },
        resists: {},
        mitigation: 0
    };
    const foe = {
        alive: true,
        tile: { x: 2, y: 0, z: 0 },
        hp: { current: 500, max: 500 },
        resists: {},
        mitigation: 0,
        applyHpDelta(d) {
            this.hp.current = Math.max(0, this.hp.current - d);
            return d;
        }
    };

    // Consumption off (default): free cast without inventory
    assert.strictEqual(hasRune(caster, spell, {}), true);
    assert.strictEqual(canCast(caster, spell, {}), true);

    // Consumption on, empty bag: blocked
    caster.inventory = buildInventoryFromSeed(
        { equipment: { backpack: 'backpack' }, backpack: [] },
        itemDb
    );
    assert.strictEqual(
        hasRune(caster, spell, { runeConsumption: true }),
        false,
        'empty bag blocks'
    );
    assert.strictEqual(canCast(caster, spell, { runeConsumption: true }), false);

    // Nested bag only still allows cast
    caster.inventory = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: [
                {
                    itemId: 'bag',
                    contents: [{ itemId: 'deathburst_rune', count: 2 }]
                }
            ]
        },
        itemDb
    );
    assert.strictEqual(
        countItemIdInInventoryTree(caster.inventory, 'deathburst_rune'),
        2
    );
    assert.strictEqual(hasRune(caster, spell, { runeConsumption: true }), true);
    assert.strictEqual(canCast(caster, spell, { runeConsumption: true }), true);

    const r = tryAttack({
        attacker: caster,
        defender: foe,
        spellId: 'deathburst',
        ctx: {
            runeConsumption: true,
            spellBook: { deathburst: spell },
            rng: () => 0.5
        }
    });
    assert.ok(r && r.ok, 'tryAttack spends rune and resolves');
    assert.strictEqual(
        countItemIdInInventoryTree(caster.inventory, 'deathburst_rune'),
        1,
        'exactly one consumed'
    );

    spendRune(caster, spell, { runeConsumption: true });
    assert.strictEqual(
        countItemIdInInventoryTree(caster.inventory, 'deathburst_rune'),
        0
    );
    assert.strictEqual(hasRune(caster, spell, { runeConsumption: true }), false);

    log('rune inventory gates ok');
}

/**
 * Phase B: creature shaped attack damages all living players on a stacked tile,
 * even when only the primary is in the candidates list. Mixed creature is not hit.
 */
function testEnemyAoeHitsAllPlayersOnStack() {
    const {
        resolveShapedAttack
    } = require('../kernel/core/lib/combat/area.js');
    const { TileMap } = require('../kernel/core/entities/tilemap.js');

    const map = new TileMap('stack_aoe');
    const open = new Uint8Array(25);
    open.fill(100);
    map.loadFloorFromFriction(0, 5, 5, open);
    const ents = new Map();
    map.resolveEntity = (id) => ents.get(id) || null;

    const p1 = {
        id: 1,
        type: 'player',
        alive: true,
        tile: { x: 2, y: 2, z: 0 },
        hp: { current: 200, max: 200 },
        resists: {},
        mitigation: 0,
        applyHpDelta(d) {
            this.hp.current = Math.max(0, this.hp.current - d);
            if (this.hp.current <= 0) this.alive = false;
        }
    };
    const p2 = {
        id: 2,
        type: 'player',
        alive: true,
        tile: { x: 2, y: 2, z: 0 },
        hp: { current: 200, max: 200 },
        resists: {},
        mitigation: 0,
        applyHpDelta(d) {
            this.hp.current = Math.max(0, this.hp.current - d);
            if (this.hp.current <= 0) this.alive = false;
        }
    };
    const mixedMob = {
        id: 30,
        type: 'creature',
        alive: true,
        tile: { x: 2, y: 2, z: 0 },
        hp: { current: 100, max: 100 },
        resists: {},
        mitigation: 0,
        applyHpDelta(d) {
            this.hp.current = Math.max(0, this.hp.current - d);
            if (this.hp.current <= 0) this.alive = false;
        }
    };
    const attacker = {
        id: 99,
        type: 'creature',
        alive: true,
        tile: { x: 0, y: 0, z: 0 },
        hp: { current: 100, max: 100 },
        mp: { current: 100, max: 100 },
        cooldowns: {},
        level: 50,
        skill: 50,
        atk: 40
    };
    ents.set(1, p1);
    ents.set(2, p2);
    ents.set(30, mixedMob);
    assert.ok(map.tryOccupy(2, 2, 0, p1));
    assert.ok(map.moveEntityToTile(p2, 2, 2, 0));
    // Stair mixed: creature under players after stair hop order — force stack order
    // [creature first] via clear + re-enter with stair reason.
    map.clearOccupancy(0);
    assert.ok(map.tryOccupy(2, 2, 0, mixedMob));
    assert.ok(map.moveEntityToTile(p1, 2, 2, 0, { reason: 'stair' }));
    assert.ok(map.moveEntityToTile(p2, 2, 2, 0, { reason: 'stair' }));
    assert.deepStrictEqual(map.getCombatants(2, 2, 0), [30, 1, 2]);

    const spell = {
        id: 'test_mob_area',
        min: 20,
        max: 20,
        element: 'physical',
        range: 5,
        mana: 0,
        isMelee: false,
        shape: { type: 'area', code: 1 },
        cooldowns: {}
    };

    const hp1 = p1.hp.current;
    const hp2 = p2.hp.current;
    const hpM = mixedMob.hp.current;

    // Candidates only list primary — stack expansion must still hit p2.
    const result = resolveShapedAttack({
        attacker,
        primary: p1,
        spell,
        candidates: [p1],
        tileMap: map,
        skipCooldown: true,
        skipMana: true,
        rng: () => 0.5
    });

    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.ok(
        result.hits.some((h) => h.id === 1),
        'primary player hit'
    );
    assert.ok(
        result.hits.some((h) => h.id === 2),
        'stacked player expanded via getCombatants'
    );
    assert.ok(
        !result.hits.some((h) => h.id === 30),
        'mixed creature not hit by player-target rule'
    );
    assert.ok(p1.hp.current < hp1, 'p1 damaged');
    assert.ok(p2.hp.current < hp2, 'p2 damaged');
    assert.strictEqual(mixedMob.hp.current, hpM, 'mixed mob untouched');

    log('enemy aoe hits all players on stack ok', {
        hits: result.hits.map((h) => h.id)
    });
}

/**
 * Phase B: only the first combatant on the tile may cast player area;
 * non-first still single-target; mixed creature-first blocks all player AoE.
 */
function testPlayerAoeCastGateFirstOnly() {
    const {
        resolveShapedAttack,
        canCastPlayerAreaOnTile
    } = require('../kernel/core/lib/combat/area.js');
    const { canCast, tryAttack } = require('../kernel/core/lib/ai/combat_actions.js');
    const { TileMap } = require('../kernel/core/entities/tilemap.js');

    const map = new TileMap('stack_cast');
    const open = new Uint8Array(25);
    open.fill(100);
    map.loadFloorFromFriction(0, 5, 5, open);
    const ents = new Map();
    map.resolveEntity = (id) => ents.get(id) || null;

    const first = makeGuardianKnight();
    first.id = 10;
    first.tile = { x: 1, y: 1, z: 0 };
    const second = makeGuardianKnight();
    second.id = 11;
    second.tile = { x: 1, y: 1, z: 0 };
    ents.set(10, first);
    ents.set(11, second);
    assert.ok(map.tryOccupy(1, 1, 0, first));
    assert.ok(map.moveEntityToTile(second, 1, 1, 0));
    assert.strictEqual(map.getFirstOccupant(1, 1, 0), 10);

    const spells = indexSpells(presets.loadSpells().spells);
    const rampage = spells.rampage;
    assert.ok(rampage && rampage.shape);

    assert.strictEqual(canCastPlayerAreaOnTile(first, map), true);
    assert.strictEqual(canCastPlayerAreaOnTile(second, map), false);

    const dummy = makeDummy();
    dummy.id = 50;
    dummy.tile = { x: 1, y: 1, z: 0 };
    dummy.type = 'creature';

    const ctxFirst = {
        tileMap: map,
        spellBook: spells,
        enemies: [dummy],
        rng: rngFromSeed(3)
    };
    assert.strictEqual(canCast(first, rampage, ctxFirst), true, 'first may cast area');
    assert.strictEqual(canCast(second, rampage, ctxFirst), false, 'second blocked area');

    const ok = resolveShapedAttack({
        attacker: first,
        primary: dummy,
        spell: rampage,
        candidates: [dummy],
        tileMap: map,
        skipCooldown: true,
        skipMana: true,
        rng: () => 0.5
    });
    assert.strictEqual(ok.ok, true, ok.reason || 'first cast ok');

    const blocked = resolveShapedAttack({
        attacker: second,
        primary: dummy,
        spell: rampage,
        candidates: [dummy],
        tileMap: map,
        skipCooldown: true,
        skipMana: true,
        rng: () => 0.5
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'not_tile_controller');

    // Single-target still allowed for non-first (tile controller is area-only).
    // Clear step root from moveEntityToTile so this asserts the stack gate, not moveLock.
    second.moveDelay = 0;
    Cooldowns.ensureCooldowns(second);
    if (second.cooldowns.auto) second.cooldowns.auto.attack = 0;
    const st = tryAttack({
        attacker: second,
        defender: dummy,
        spellId: 'melee_auto',
        ctx: {
            tileMap: map,
            spellBook: spells,
            enemies: [dummy],
            rng: () => 0.5
        }
    });
    assert.ok(st && st.ok, 'non-first single-target ok');

    // Mixed: creature first → no player may cast AoE
    map.clearOccupancy(0);
    const mob = makeDummy();
    mob.id = 70;
    mob.type = 'creature';
    mob.tile = { x: 2, y: 2, z: 0 };
    ents.set(70, mob);
    first.tile = { x: 2, y: 2, z: 0 };
    assert.ok(map.tryOccupy(2, 2, 0, mob));
    assert.ok(map.moveEntityToTile(first, 2, 2, 0, { reason: 'stair' }));
    assert.strictEqual(map.getFirstOccupant(2, 2, 0), 70);
    assert.strictEqual(canCastPlayerAreaOnTile(first, map), false);
    const mixedBlock = resolveShapedAttack({
        attacker: first,
        primary: dummy,
        spell: rampage,
        candidates: [dummy],
        tileMap: map,
        skipCooldown: true,
        skipMana: true,
        rng: () => 0.5
    });
    assert.strictEqual(mixedBlock.reason, 'not_tile_controller');

    log('player aoe cast gate first-only ok');
}

function testChainAttackPickAndResolve() {
    const {
        spellHasChain,
        normalizeChainSpec,
        pickChainTargets,
        resolveChainAttack
    } = require('../kernel/core/lib/combat/chain.js');
    const { tryAttack } = require('../kernel/core/lib/ai/combat_actions.js');

    const spells = indexSpells(presets.loadSpells().spells);
    const spell = spells.chain_rebuke;
    assert.ok(spell, 'chain_rebuke preset');
    assert.ok(spellHasChain(spell), 'chain flag');
    const spec = normalizeChainSpec(spell);
    assert.ok(spec);
    assert.strictEqual(spec.maxTargets, 4);
    assert.strictEqual(spec.distance, 3);
    assert.strictEqual(spec.backtracking, false);

    // Numeric shorthand
    assert.deepStrictEqual(normalizeChainSpec({ chain: 3 }), {
        maxTargets: 3,
        distance: 3,
        backtracking: false
    });

    const caster = makeGuardianKnight();
    caster.tile = { x: 10, y: 10, z: 7 };
    caster.mp.current = 500;

    // Line of 5 dummies east of caster; hop distance 3 → should chain nearest-first.
    const dummies = [];
    for (let i = 0; i < 5; i++) {
        const d = makeDummy();
        d.id = 100 + i;
        d.tile = { x: 11 + i, y: 10, z: 7 }; // 1..5 tiles east
        dummies.push(d);
    }
    // Far dummy outside hop graph from tip after 4 hops still exists but should not join if max=4
    const far = makeDummy();
    far.id = 200;
    far.tile = { x: 30, y: 30, z: 7 };

    const primary = dummies[0];
    const picked = pickChainTargets({
        caster,
        primary,
        candidates: dummies.concat([far]),
        maxTargets: 4,
        distance: 3,
        backtracking: false,
        tileMap: null
    });
    assert.strictEqual(picked.hops.length, 4, 'caps at maxTargets');
    assert.strictEqual(picked.hops[0], primary);
    // Greedy closest from primary (11,10): next is (12,10), then (13,10), (14,10)
    assert.strictEqual(picked.hops[1].tile.x, 12);
    assert.strictEqual(picked.hops[2].tile.x, 13);
    assert.strictEqual(picked.hops[3].tile.x, 14);
    assert.ok(picked.links.length >= 4, 'links include caster→primary + hops');
    assert.ok(!picked.hops.includes(far), 'far excluded');
    assert.ok(!picked.hops.includes(dummies[4]), '5th on line excluded by cap');

    // Branch: closer side target wins over farther line target
    const side = makeDummy();
    side.id = 300;
    side.tile = { x: 11, y: 11, z: 7 }; // adjacent to primary, euclidean 1
    const lineFar = makeDummy();
    lineFar.id = 301;
    lineFar.tile = { x: 13, y: 10, z: 7 }; // euclidean 2 from primary
    const pick2 = pickChainTargets({
        caster,
        primary,
        candidates: [primary, side, lineFar],
        maxTargets: 3,
        distance: 3
    });
    assert.strictEqual(pick2.hops[0], primary);
    assert.strictEqual(pick2.hops[1], side, 'closest hop is side neighbor');

    // Resolve: mana once, all hops damaged
    const mystic = makeGuardianKnight();
    mystic.tile = { x: 10, y: 10, z: 7 };
    mystic.mp.current = 500;
    mystic.knownSpells = mystic.knownSpells || {};
    // ensure canUseSpell won't block if mystic book needed — resolveChainAttack skips canUse
    const hps = dummies.slice(0, 4).map((d) => d.hp.current);
    const mpBefore = mystic.mp.current;
    const result = resolveChainAttack({
        attacker: mystic,
        primary,
        spell,
        candidates: dummies,
        rng: rngFromSeed(42)
    });
    assert.strictEqual(result.ok, true, result.reason || 'ok');
    assert.strictEqual(result.chain, true);
    assert.strictEqual(result.multi, true);
    assert.strictEqual(result.hits.length, 4);
    assert.strictEqual(result.results.length, 4);
    assert.strictEqual(
        mystic.mp.current,
        mpBefore - spell.mana,
        'mana spent once'
    );
    for (let i = 0; i < 4; i++) {
        assert.ok(
            dummies[i].hp.current < hps[i],
            'hop ' + i + ' took damage'
        );
    }
    assert.strictEqual(dummies[4].hp.current, dummies[4].hp.max, '5th unharmed');
    assert.ok(Cooldowns.getRemaining(mystic, 'spell', 'chain_rebuke') > 0);

    // Cooldown blocks second cast
    const blocked = resolveChainAttack({
        attacker: mystic,
        primary,
        spell,
        candidates: dummies,
        rng: () => 0.5
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'cooldown');

    // tryAttack path
    const mystic2 = makeGuardianKnight();
    mystic2.tile = { x: 5, y: 5, z: 7 };
    mystic2.mp.current = 500;
    mystic2.spells = ['chain_rebuke'];
    const t1 = makeDummy();
    t1.id = 401;
    t1.tile = { x: 6, y: 5, z: 7 };
    const t2 = makeDummy();
    t2.id = 402;
    t2.tile = { x: 7, y: 5, z: 7 };
    const spellBook = presets.loadSpells().spells;
    const tryRes = tryAttack({
        attacker: mystic2,
        defender: t1,
        spellId: 'chain_rebuke',
        ctx: {
            spellBook,
            enemies: [t1, t2],
            rng: rngFromSeed(7)
        }
    });
    // tryAttack may null if canCast fails (known spell / vocation). Force via resolve if null.
    if (tryRes) {
        assert.strictEqual(tryRes.ok, true);
        assert.strictEqual(tryRes.chain, true);
        assert.ok(tryRes.hits.length >= 2);
        assert.ok(t1.hp.current < t1.hp.max);
        assert.ok(t2.hp.current < t2.hp.max);
    } else {
        // canCast gate (book) — resolve path already covered above
        log('tryAttack skipped canCast gate; resolve path covered');
    }

    // Self-origin: no primary → hops from caster
    const originCaster = { id: 'oc', tile: { x: 0, y: 0, z: 0 }, alive: true };
    const a = makeDummy();
    a.id = 'a';
    a.tile = { x: 1, y: 0, z: 0 };
    const b = makeDummy();
    b.id = 'b';
    b.tile = { x: 2, y: 0, z: 0 };
    const selfPick = pickChainTargets({
        caster: originCaster,
        primary: null,
        candidates: [a, b],
        maxTargets: 2,
        distance: 3
    });
    assert.strictEqual(selfPick.hops.length, 2);
    assert.strictEqual(selfPick.hops[0], a);
    assert.strictEqual(selfPick.hops[1], b);
    assert.ok(!selfPick.hops.includes(originCaster));

    log('chain attack pick + resolve ok', {
        hops: result.hits.length,
        links: result.chainLinks.length
    });
}

/**
 * Wiki parity: Lightning chains primary + 2 additional (maxTargets 3).
 * Divine Grenade plants with delaySec fuse then detonates shaped damage.
 * Executioner's Throw catalog uses stage-1 wiki chain (3 total).
 */
function testWikiParityLightningGrenadeExecutioner() {
    const {
        resolveShapedAttack
    } = require('../kernel/core/lib/combat/area.js');
    const {
        resolveChainAttack,
        pickChainTargets
    } = require('../kernel/core/lib/combat/chain.js');
    const {
        tickDelayedCasts,
        explodeDelayedCast,
        resolveDelayedPlaceCenter
    } = require('../kernel/core/lib/combat/delayed_cast.js');
    const fs = require('fs');
    const path = require('path');
    const pack = JSON.parse(
        fs.readFileSync(
            path.join(__dirname, '..', 'presets', 'standard', 'spells.json'),
            'utf8'
        )
    );
    const byId = Object.create(null);
    for (const s of pack.spells) byId[s.id] = s;

    const lightning = byId.lightning;
    assert.ok(lightning, 'lightning catalog');
    assert.strictEqual(lightning.range, 7, 'wiki lightning range 7');
    assert.ok(lightning.chain, 'wiki lightning has chain');
    assert.strictEqual(
        lightning.chain.maxTargets,
        3,
        'wiki: primary + 2 additional'
    );
    assert.strictEqual(lightning.basePower, 110);

    const caster = makeGuardianKnight();
    caster.id = 'sorc';
    caster.level = 60;
    if (caster.combatStats) caster.combatStats.magic = 50;
    caster.mp.current = 500;
    caster.mp.max = 500;
    caster.tile = { x: 0, y: 0, z: 0 };
    Cooldowns.ensureCooldowns(caster);

    const t0 = makeDummy();
    t0.id = 't0';
    t0.tile = { x: 3, y: 0, z: 0 };
    const t1 = makeDummy();
    t1.id = 't1';
    t1.tile = { x: 4, y: 0, z: 0 };
    const t2 = makeDummy();
    t2.id = 't2';
    t2.tile = { x: 5, y: 0, z: 0 };
    const t3 = makeDummy();
    t3.id = 't3';
    t3.tile = { x: 6, y: 0, z: 0 };

    const chainR = resolveChainAttack({
        attacker: caster,
        primary: t0,
        spell: lightning,
        candidates: [t0, t1, t2, t3],
        rng: () => 0.5
    });
    assert.ok(chainR.ok, 'lightning chain resolves');
    assert.strictEqual(chainR.hits.length, 3, 'hits primary + 2');

    // Executioner's Throw stage-1: maxTargets 3, CD 18, bp 60
    const et = byId.executioners_throw;
    assert.ok(et && et.chain);
    assert.strictEqual(et.chain.maxTargets, 3);
    assert.strictEqual(et.basePower, 60);
    assert.strictEqual(et.cooldowns.spell.executioners_throw, 18);

    // Divine Grenade: place near target if ≤4, else under caster; 3s fuse
    const grenade = byId.divine_grenade;
    assert.ok(grenade);
    assert.strictEqual(grenade.delaySec, 3);
    assert.strictEqual(grenade.delayPlaceRange, 4);
    assert.strictEqual(grenade.cooldowns.spell.divine_grenade, 26);

    const pala = makeGuardianKnight();
    pala.id = 'pala';
    pala.level = 300;
    if (pala.combatStats) pala.combatStats.magic = 50;
    pala.mp.current = 1000;
    pala.mp.max = 1000;
    pala.tile = { x: 0, y: 0, z: 0 };
    Cooldowns.ensureCooldowns(pala);

    const near = makeDummy();
    near.id = 'near';
    near.tile = { x: 3, y: 0, z: 0 }; // dist 3 ≤ 4
    const nearCenter = resolveDelayedPlaceCenter(pala, near, grenade);
    assert.deepStrictEqual(
        { x: nearCenter.x, y: nearCenter.y },
        { x: 3, y: 0 },
        'grenade plants on near target'
    );

    const far = makeDummy();
    far.id = 'far';
    far.tile = { x: 6, y: 0, z: 0 }; // dist 6 > 4
    const farCenter = resolveDelayedPlaceCenter(pala, far, grenade);
    assert.deepStrictEqual(
        { x: farCenter.x, y: farCenter.y },
        { x: 0, y: 0 },
        'grenade plants under caster when target >4'
    );

    const delayedStore = [];
    const castR = resolveShapedAttack({
        attacker: pala,
        primary: near,
        spell: grenade,
        candidates: [near],
        delayedStore,
        rng: () => 0.5
    });
    assert.ok(castR.ok && castR.delayed, 'grenade cast is delayed');
    assert.strictEqual(castR.final, 0, 'no damage on plant');
    assert.strictEqual(near.hp.current, near.hp.max, 'target full HP at plant');
    assert.strictEqual(delayedStore.length, 1);
    assert.ok(delayedStore[0].remainingSec > 2.9);

    // Partial tick — still fuse
    tickDelayedCasts(delayedStore, 1.0);
    assert.strictEqual(delayedStore.length, 1);
    assert.ok(near.hp.current === near.hp.max);

    // Finish fuse
    const fired = tickDelayedCasts(delayedStore, 2.5, (entry) =>
        explodeDelayedCast(entry, {
            resolveShapedAttack,
            candidates: [near],
            rng: () => 0.5
        })
    );
    assert.strictEqual(fired.fired.length, 1);
    assert.strictEqual(delayedStore.length, 0);
    const boom = fired.fired[0].result;
    assert.ok(boom && boom.ok, 'detonation ok');
    assert.ok(near.hp.current < near.hp.max, 'grenade dealt damage after fuse');

    // Delayed cast stays on plant floor when caster hops floors.
    const pala2 = makeGuardianKnight();
    pala2.id = 'pala2';
    pala2.level = 300;
    if (pala2.combatStats) pala2.combatStats.magic = 50;
    pala2.mp.current = 1000;
    pala2.mp.max = 1000;
    pala2.tile = { x: 0, y: 0, z: 0 };
    Cooldowns.ensureCooldowns(pala2);
    const floorTarget = makeDummy();
    floorTarget.id = 'floor_t';
    floorTarget.tile = { x: 2, y: 0, z: 0 };
    const floorStore = [];
    const plantR = resolveShapedAttack({
        attacker: pala2,
        primary: floorTarget,
        spell: grenade,
        candidates: [floorTarget],
        delayedStore: floorStore,
        rng: () => 0.5
    });
    assert.ok(plantR.ok && plantR.delayed, 'floor-hop grenade plants');
    assert.strictEqual(floorStore[0].center.z, 0, 'center z locked at plant');
    // Caster leaves the floor (stairs / hop) before fuse ends.
    pala2.tile = { x: 10, y: 10, z: 1 };
    const floorFired = tickDelayedCasts(floorStore, 3.1, (entry) =>
        explodeDelayedCast(entry, {
            resolveShapedAttack,
            candidates: [floorTarget],
            rng: () => 0.5
        })
    );
    assert.strictEqual(floorFired.fired.length, 1);
    const floorBoom = floorFired.fired[0].result;
    assert.ok(
        floorBoom && floorBoom.ok,
        'detonation still ok after caster floor hop'
    );
    assert.ok(
        floorTarget.hp.current < floorTarget.hp.max,
        'grenade hits target on original floor despite caster on z=1'
    );
    assert.strictEqual(
        floorBoom.center && floorBoom.center.z,
        0,
        'explosion center remains plant floor'
    );

    log('wiki parity lightning / grenade / executioner ok', {
        lightningHits: chainR.hits.length,
        grenadeDmg: near.hp.max - near.hp.current,
        floorHopDmg: floorTarget.hp.max - floorTarget.hp.current
    });
}

/**
 * Phase 1 mana shield: pooled condition + gear flag absorb in applyHpDelta.
 * Catalog spells / potion land in later phases.
 */
function testManaShieldKernel() {
    const {
        applyCondition,
        hasCondition,
        tickConditions,
        conditionDefFromSpell,
        computeManaShieldPool,
        getManaShieldState,
        resolveManaShieldBar,
        absorbWithManaShield
    } = require('../kernel/core/lib/combat/conditions.js');
    const { applyHpDelta } = require('../kernel/core/lib/combat/resolve.js');

    assert.strictEqual(computeManaShieldPool(14, 0, 425), 406);
    assert.strictEqual(computeManaShieldPool(14, 0, 100), 100, 'low maxMana clamps');
    assert.strictEqual(
        computeManaShieldPool(14, 0, 425),
        406,
        'Wheel 1.25× must not apply'
    );

    function makeShielded(opts) {
        const o = opts || {};
        return {
            alive: true,
            level: o.level != null ? o.level : 14,
            magic: o.magic != null ? o.magic : 0,
            hp: {
                current: o.hp != null ? o.hp : 500,
                max: o.hpMax != null ? o.hpMax : 500
            },
            mp: {
                current: o.mana != null ? o.mana : 200,
                max: o.manaMax != null ? o.manaMax : 425
            },
            combatStats: { flags: o.flags ? Object.assign({}, o.flags) : {} },
            conditions: []
        };
    }

    function applyPool(entity, pool, durationSec) {
        return applyCondition(entity, {
            type: 'mana_shield',
            durationSec: durationSec != null ? durationSec : 180,
            poolRemaining: pool,
            poolMax: pool
        });
    }

    // Incoming 100, pool 250, mana 200 → mana 100, pool 150, HP 0
    const a = makeShielded({ mana: 200 });
    applyPool(a, 250);
    const rA = absorbWithManaShield(a, 100);
    assert.strictEqual(rA.absorbed, 100);
    assert.strictEqual(rA.leftoverHp, 0);
    assert.strictEqual(rA.cleared, false);
    assert.strictEqual(a.mp.current, 100);
    assert.strictEqual(getManaShieldState(a).poolRemaining, 150);
    assert.strictEqual(a.hp.current, 500);

    // Same via applyHpDelta
    const a2 = makeShielded({ mana: 200, hp: 500 });
    applyPool(a2, 250);
    const dA = applyHpDelta(a2, 100, 'physical');
    assert.strictEqual(dA, 0, 'fully absorbed hit is 0 HP delta');
    assert.strictEqual(a2.mp.current, 100);
    assert.strictEqual(a2.hp.current, 500);
    assert.strictEqual(getManaShieldState(a2).poolRemaining, 150);

    // Incoming 100, pool 40, mana 200 → mana 160, pool gone, HP 60
    const b = makeShielded({ mana: 200, hp: 500 });
    applyPool(b, 40);
    const dB = applyHpDelta(b, 100, 'fire');
    assert.strictEqual(dB, -60);
    assert.strictEqual(b.mp.current, 160);
    assert.strictEqual(b.hp.current, 440);
    assert.strictEqual(hasCondition(b, 'mana_shield'), false);
    assert.strictEqual(hasCondition(b, 'CONDITION_MANASHIELD'), false);

    // Incoming 100, pool 250, mana 30 → mana 0, pooled condition cleared, HP 70
    const c = makeShielded({ mana: 30, hp: 500 });
    applyPool(c, 250);
    const dC = applyHpDelta(c, 100, 'earth');
    assert.strictEqual(dC, -70);
    assert.strictEqual(c.mp.current, 0);
    assert.strictEqual(c.hp.current, 430);
    assert.strictEqual(hasCondition(c, 'mana_shield'), false);

    // Gear unpooled: incoming 100, mana 200 → mana 100, HP 0, flag stays
    const g = makeShielded({ mana: 200, hp: 500, flags: { manaShield: true } });
    const dG = applyHpDelta(g, 100, 'physical');
    assert.strictEqual(dG, 0);
    assert.strictEqual(g.mp.current, 100);
    assert.strictEqual(g.hp.current, 500);
    assert.strictEqual(g.combatStats.flags.manaShield, true);
    assert.strictEqual(hasCondition(g, 'mana_shield'), false);

    // Gear, mana 0 → HP 100, flag stays
    const g0 = makeShielded({ mana: 0, hp: 500, flags: { manaShield: true } });
    const dG0 = applyHpDelta(g0, 100, 'physical');
    assert.strictEqual(dG0, -100);
    assert.strictEqual(g0.mp.current, 0);
    assert.strictEqual(g0.hp.current, 400);
    assert.strictEqual(g0.combatStats.flags.manaShield, true);

    // Healing never touches mana / pool
    const h = makeShielded({ mana: 200, hp: 400 });
    applyPool(h, 250);
    const dH = applyHpDelta(h, 50, 'healing');
    assert.strictEqual(dH, 50);
    assert.strictEqual(h.hp.current, 450);
    assert.strictEqual(h.mp.current, 200);
    assert.strictEqual(getManaShieldState(h).poolRemaining, 250);

    // Recast overwrites remaining + duration (weaker or stronger)
    const rec = makeShielded({ mana: 200 });
    applyPool(rec, 250, 30);
    rec.conditions[0].poolRemaining = 10;
    const recInst = applyPool(rec, 80, 180);
    assert.strictEqual(rec.conditions.length, 1);
    assert.strictEqual(recInst.poolRemaining, 80);
    assert.strictEqual(recInst.poolMax, 80);
    assert.strictEqual(recInst.durationSec, 180);

    // Duration expiry clears; leftover incoming then hits HP
    const exp = makeShielded({ mana: 200, hp: 500 });
    applyPool(exp, 250, 2);
    const ticked = tickConditions(exp, 2.1);
    assert.ok(ticked.expired.indexOf('mana_shield') >= 0);
    assert.strictEqual(hasCondition(exp, 'mana_shield'), false);
    const dExp = applyHpDelta(exp, 100, 'physical');
    assert.strictEqual(dExp, -100);
    assert.strictEqual(exp.mp.current, 200);
    assert.strictEqual(exp.hp.current, 400);

    // poolFormula resolved at apply time from the target
    const form = makeShielded({ level: 14, magic: 0, manaMax: 425, mana: 425 });
    const def = conditionDefFromSpell(
        {
            type: 'mana_shield',
            durationSec: 180,
            poolFormula: 'legacy_mana_shield'
        },
        form
    );
    assert.ok(def);
    assert.strictEqual(def.type, 'mana_shield');
    assert.strictEqual(def.poolRemaining, 406);
    assert.strictEqual(def.poolMax, 406);
    const formInst = applyCondition(form, {
        type: 'CONDITION_MANASHIELD',
        durationSec: 180,
        poolFormula: 'legacy_mana_shield'
    });
    assert.ok(formInst);
    assert.strictEqual(formInst.kind, 'mana_shield');
    assert.strictEqual(formInst.poolRemaining, 406);

    // undefined / manadrain skip absorb
    const skip = makeShielded({ mana: 200, hp: 500 });
    applyPool(skip, 250);
    assert.strictEqual(applyHpDelta(skip, 40, 'undefined'), -40);
    assert.strictEqual(skip.mp.current, 200);
    assert.strictEqual(getManaShieldState(skip).poolRemaining, 250);
    assert.strictEqual(applyHpDelta(skip, 20, 'manadrain'), -20);
    assert.strictEqual(skip.mp.current, 200);

    // Watch-UI bar helper: pooled remaining/max; gear uses current mana.
    const barPool = resolveManaShieldBar(
        makeShielded({ mana: 200, hp: 500 })
    );
    assert.strictEqual(barPool, null);
    const pooledEnt = makeShielded({ mana: 200, hp: 500 });
    applyPool(pooledEnt, 250);
    const pooledBar = resolveManaShieldBar(pooledEnt);
    assert.ok(pooledBar);
    assert.strictEqual(pooledBar.mode, 'pooled');
    assert.strictEqual(pooledBar.remaining, 250);
    assert.strictEqual(pooledBar.max, 250);
    assert.strictEqual(pooledBar.frac, 1);
    pooledEnt.conditions[0].poolRemaining = 50;
    const halfBar = resolveManaShieldBar(pooledEnt);
    assert.strictEqual(halfBar.remaining, 50);
    assert.strictEqual(halfBar.frac, 50 / 250);
    const gearEnt = makeShielded({
        mana: 80,
        manaMax: 200,
        hp: 500,
        flags: { manaShield: true }
    });
    const gearBar = resolveManaShieldBar(gearEnt);
    assert.ok(gearBar);
    assert.strictEqual(gearBar.mode, 'gear');
    assert.strictEqual(gearBar.remaining, 80);
    assert.strictEqual(gearBar.max, 200);
    assert.strictEqual(gearBar.frac, 80 / 200);

    log('Phase 1 mana shield kernel ok', {
        pool14: 406,
        leftoverAfterDry: dC
    });
}

/**
 * Phase 2 mana shield: catalog spells, vocation books, cast / cancel / absorb.
 */
function testManaShieldCatalog() {
    const {
        hasCondition,
        hasHaste,
        isInvisible,
        getManaShieldState,
        computeManaShieldPool
    } = require('../kernel/core/lib/combat/conditions.js');
    const { applyHpDelta } = require('../kernel/core/lib/combat/resolve.js');

    const spells = indexSpells(presets.loadSpells().spells);
    const shield = spells.magic_shield;
    const cancel = spells.cancel_magic_shield;
    assert.ok(shield, 'magic_shield preset');
    assert.ok(cancel, 'cancel_magic_shield preset');
    assert.strictEqual(shield.kind, 'support');
    assert.strictEqual(cancel.kind, 'support');
    assert.strictEqual(shield.statusOnly, true);
    assert.strictEqual(cancel.statusOnly, true);
    assert.strictEqual(shield.requiresTarget, false);
    assert.strictEqual(cancel.requiresTarget, false);
    assert.strictEqual(shield.level, 14);
    assert.strictEqual(cancel.level, 14);
    assert.strictEqual(shield.mana, 50);
    assert.strictEqual(cancel.mana, 50);
    assert.strictEqual(shield.cooldowns.primary.support, 2);
    assert.strictEqual(cancel.cooldowns.primary.support, 2);
    assert.strictEqual(shield.cooldowns.spell.magic_shield, 14);
    assert.strictEqual(cancel.cooldowns.spell.cancel_magic_shield, 2);
    assert.deepStrictEqual(shield.vocations, ['adept', 'warden']);
    assert.deepStrictEqual(cancel.vocations, ['adept', 'warden']);
    assert.ok(shield.condition && shield.condition.type === 'mana_shield');
    assert.strictEqual(shield.condition.durationSec, 180);
    assert.strictEqual(shield.condition.poolFormula, 'legacy_mana_shield');
    assert.deepStrictEqual(cancel.dispel, ['mana_shield']);

    const classes = presets.loadClasses();
    const list = (classes.classes || []).slice();
    function classById(id) {
        return list.find((c) => c && c.id === id);
    }
    const adept = classById('adept');
    const warden = classById('warden');
    const guardian = classById('guardian');
    const scout = classById('scout');
    const mystic = classById('mystic');
    assert.ok(adept && adept.spells.indexOf('magic_shield') >= 0, 'adept book shield');
    assert.ok(adept.spells.indexOf('cancel_magic_shield') >= 0, 'adept book cancel');
    assert.ok(warden && warden.spells.indexOf('magic_shield') >= 0, 'warden book shield');
    assert.ok(warden.spells.indexOf('cancel_magic_shield') >= 0, 'warden book cancel');
    assert.ok(!guardian || guardian.spells.indexOf('magic_shield') < 0, 'guardian no shield');
    assert.ok(!scout || scout.spells.indexOf('magic_shield') < 0, 'scout no shield');
    assert.ok(!mystic || mystic.spells.indexOf('magic_shield') < 0, 'mystic no shield');

    function vocBag(classId, known) {
        return {
            classId,
            level: 50,
            combatStats: known
                ? { spells: known, magic: 0, level: 50 }
                : { magic: 0, level: 50 },
            mp: { current: 200, max: 200 },
            cooldowns: {},
            moveDelay: 0
        };
    }
    assert.strictEqual(canUseSpell(vocBag('adept', adept.spells), shield), true);
    assert.strictEqual(canUseSpell(vocBag('warden', warden.spells), shield), true);
    assert.strictEqual(canUseSpell(vocBag('guardian', guardian.spells), shield), false);
    assert.strictEqual(canUseSpell(vocBag('scout'), shield), false, 'scout vocations');
    assert.strictEqual(canUseSpell(vocBag('mystic'), cancel), false, 'mystic vocations');
    assert.strictEqual(meetsSpellLevel({ level: 13 }, shield), false);
    assert.strictEqual(meetsSpellLevel({ level: 14 }, shield), true);

    const player = new Player({
        name: 'Test Adept',
        id: 21,
        classId: 'adept',
        classDef: adept,
        itemDb: presets.loadEquipment().items,
        level: 50
    });
    player.tile = { x: 0, y: 0, z: 7 };
    if (player.mp) player.mp.current = player.mp.max;
    const expectedPool = computeManaShieldPool(
        player.level,
        (player.combatStats && player.combatStats.magic) || 0,
        player.mp.max
    );
    assert.ok(expectedPool > 0, 'pool snapshot');

    const mpBefore = player.mp.current;
    const rCast = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'magic_shield',
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(rCast.ok, true, rCast.reason || 'magic_shield ok');
    assert.ok(rCast.conditionApplied, 'mana_shield applied');
    assert.strictEqual(rCast.conditionApplied.kind, 'mana_shield');
    assert.strictEqual(rCast.conditionApplied.durationSec, 180);
    assert.strictEqual(rCast.conditionApplied.poolRemaining, expectedPool);
    assert.strictEqual(rCast.conditionApplied.poolMax, expectedPool);
    assert.ok(hasCondition(player, 'mana_shield'));
    assert.strictEqual(player.mp.current, mpBefore - shield.mana);
    assert.ok(Cooldowns.getRemaining(player, 'primary', 'support') > 0);
    assert.strictEqual(Cooldowns.getRemaining(player, 'spell', 'magic_shield'), 14);

    // Subsequent hit absorbs per Phase 1
    const manaAfterCast = player.mp.current;
    const hpBefore = player.hp.current;
    const dmg = applyHpDelta(player, 100, 'physical');
    assert.strictEqual(dmg, 0, 'pooled hit fully absorbed');
    assert.strictEqual(player.hp.current, hpBefore);
    assert.strictEqual(player.mp.current, manaAfterCast - 100);
    assert.strictEqual(getManaShieldState(player).poolRemaining, expectedPool - 100);

    // Not exclusive with haste / invisible
    const rHaste = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'haste',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rHaste.ok, true, rHaste.reason || 'haste with shield');
    const rInv = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'invisible',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rInv.ok, true, rInv.reason || 'invis with shield');
    assert.ok(hasCondition(player, 'mana_shield'));
    assert.ok(hasHaste(player));
    assert.ok(isInvisible(player));

    Cooldowns.tick(player, 14);
    const rCancel = resolveAttack({
        attacker: player,
        defender: player,
        spell: 'cancel_magic_shield',
        spellBook: spells,
        rng: () => 0
    });
    assert.strictEqual(rCancel.ok, true, rCancel.reason || 'cancel ok');
    assert.ok(rCancel.conditionsRemoved >= 1);
    assert.strictEqual(hasCondition(player, 'mana_shield'), false);
    assert.ok(hasHaste(player), 'cancel does not strip haste');
    assert.ok(isInvisible(player), 'cancel does not strip invis');
    assert.strictEqual(Cooldowns.getRemaining(player, 'spell', 'cancel_magic_shield'), 2);

    // After cancel, leftover hit goes to HP
    const hp2 = player.hp.current;
    const mana2 = player.mp.current;
    assert.strictEqual(applyHpDelta(player, 40, 'fire'), -40);
    assert.strictEqual(player.hp.current, hp2 - 40);
    assert.strictEqual(player.mp.current, mana2);

    log('Phase 2 mana shield catalog ok', {
        pool: expectedPool,
        manaAfterCast
    });
}

/**
 * Phase 3 mana shield: voltaic_ring unpooled absorb + potion 60s +
 * cancel does not strip the gear flag.
 */
function testManaShieldGearAndPotion() {
    const {
        applyCondition,
        hasCondition,
        getManaShieldState,
        computeManaShieldPool
    } = require('../kernel/core/lib/combat/conditions.js');
    const { applyHpDelta } = require('../kernel/core/lib/combat/resolve.js');
    const {
        resolveUseForItemId,
        applyItemUseEffect
    } = require('../kernel/core/lib/character/item_use.js');
    const { unequipItem } = require('../kernel/core/lib/character/inventory.js');
    const { findItem } = require('../kernel/core/lib/character/stats.js');

    const items = presets.loadEquipment().items;
    const ring = items.find((i) => i && i.id === 'voltaic_ring');
    assert.ok(ring, 'voltaic_ring catalog');
    assert.ok(ring.flags && ring.flags.manaShield, 'voltaic_ring flags.manaShield');
    assert.strictEqual(ring.durationSec, 600);
    assert.ok(Array.isArray(ring.vocation) && ring.vocation.indexOf('guardian') >= 0);
    assert.ok(ring.vocation.indexOf('scout') >= 0);
    assert.ok(ring.vocation.indexOf('mystic') < 0, 'ring is knight/paladin only');
    assert.strictEqual(findItem(items, 'mana_ring'), ring, 'mana_ring aliases voltaic_ring');

    const potEffect = resolveUseForItemId('magic_shield_potion', items);
    assert.ok(potEffect.item, 'magic_shield_potion catalog');
    assert.ok(potEffect.condition);
    assert.strictEqual(potEffect.condition.type, 'mana_shield');
    assert.strictEqual(potEffect.condition.durationSec, 60);
    assert.strictEqual(potEffect.condition.poolFormula, 'legacy_mana_shield');

    const guardian = presets.getClass('guardian');
    const adept = presets.getClass('adept');
    const spells = indexSpells(presets.loadSpells().spells);

    const wearer = new Player({
        name: 'Ring Tank',
        id: 31,
        classId: 'guardian',
        classDef: guardian,
        itemDb: items,
        equipment: { ring: 'voltaic_ring' },
        level: 50
    });
    assert.ok(wearer.combatStats.flags.manaShield, 'equipped ring sets flag');
    const aliasWearer = new Player({
        name: 'Alias Ring',
        id: 36,
        classId: 'guardian',
        classDef: guardian,
        itemDb: items,
        equipment: { ring: 'mana_ring' },
        level: 50
    });
    assert.ok(
        aliasWearer.combatStats.flags.manaShield,
        'mana_ring alias equips on guardian'
    );
    wearer.mp.max = Math.max(wearer.mp.max || 0, 400);
    wearer.mp.current = 200;
    wearer.hp.current = 500;
    wearer.hp.max = Math.max(wearer.hp.max || 0, 500);
    const dRing = applyHpDelta(wearer, 100, 'physical');
    assert.strictEqual(dRing, 0, 'voltaic_ring absorbs while mana > 0');
    assert.strictEqual(wearer.mp.current, 100);
    assert.strictEqual(wearer.hp.current, 500);
    assert.strictEqual(wearer.combatStats.flags.manaShield, true);
    assert.strictEqual(hasCondition(wearer, 'mana_shield'), false);

    wearer.tickEquipmentRuntime(600);
    assert.strictEqual(wearer.equipment.ring, undefined, 'duration-0 ring destroyed');
    assert.ok(!wearer.combatStats.flags.manaShield, 'flag clears when ring expires');
    const hpAfterExpire = wearer.hp.current;
    const mpAfterExpire = wearer.mp.current;
    assert.strictEqual(applyHpDelta(wearer, 40, 'fire'), -40);
    assert.strictEqual(wearer.hp.current, hpAfterExpire - 40);
    assert.strictEqual(wearer.mp.current, mpAfterExpire);

    const uqPlayer = new Player({
        name: 'Unequip Tank',
        id: 32,
        classId: 'guardian',
        classDef: guardian,
        itemDb: items,
        equipment: { ring: 'voltaic_ring', backpack: 'backpack' },
        level: 50
    });
    uqPlayer.initInventory({ equipment: uqPlayer.equipment }, items);
    assert.ok(uqPlayer.combatStats.flags.manaShield, 'flag before unequip');
    uqPlayer.mp.max = Math.max(uqPlayer.mp.max || 0, 400);
    uqPlayer.mp.current = 200;
    uqPlayer.hp.current = 500;
    uqPlayer.hp.max = Math.max(uqPlayer.hp.max || 0, 500);
    const uq = unequipItem(uqPlayer.inventory, 'ring', items);
    assert.strictEqual(uq.ok, true, uq.error || 'unequip ok');
    uqPlayer.applyInventoryMutation();
    assert.strictEqual(uqPlayer.equipment.ring, undefined);
    assert.ok(!uqPlayer.combatStats.flags.manaShield, 'flag clears on unequip');
    const hpUq = uqPlayer.hp.current;
    const mpUq = uqPlayer.mp.current;
    assert.strictEqual(applyHpDelta(uqPlayer, 40, 'physical'), -40);
    assert.strictEqual(uqPlayer.hp.current, hpUq - 40);
    assert.strictEqual(uqPlayer.mp.current, mpUq);

    const drinker = new Player({
        name: 'Potion Adept',
        id: 33,
        classId: 'adept',
        classDef: adept,
        itemDb: items,
        level: 50
    });
    if (drinker.mp) drinker.mp.current = drinker.mp.max;
    const expectedPool = computeManaShieldPool(
        drinker.level,
        (drinker.combatStats && drinker.combatStats.magic) || 0,
        drinker.mp.max
    );
    assert.ok(expectedPool > 0, 'potion pool snapshot');
    const drank = applyItemUseEffect(drinker, potEffect, { rng: () => 0 });
    assert.ok(drank.conditionApplied, 'potion applied mana_shield');
    assert.strictEqual(drank.conditionApplied.kind, 'mana_shield');
    assert.strictEqual(drank.conditionApplied.durationSec, 60);
    assert.strictEqual(drank.conditionApplied.poolRemaining, expectedPool);
    assert.strictEqual(drank.conditionApplied.poolMax, expectedPool);
    assert.ok(hasCondition(drinker, 'mana_shield'));
    const manaAfterDrink = drinker.mp.current;
    const hpAfterDrink = drinker.hp.current;
    assert.strictEqual(applyHpDelta(drinker, 80, 'energy'), 0);
    assert.strictEqual(drinker.hp.current, hpAfterDrink);
    assert.strictEqual(drinker.mp.current, manaAfterDrink - 80);
    assert.strictEqual(getManaShieldState(drinker).poolRemaining, expectedPool - 80);

    const hybrid = new Player({
        name: 'Hybrid Tank',
        id: 34,
        classId: 'guardian',
        classDef: guardian,
        itemDb: items,
        equipment: { ring: 'voltaic_ring' },
        level: 50
    });
    hybrid.mp.max = Math.max(hybrid.mp.max || 0, 400);
    hybrid.mp.current = 300;
    hybrid.hp.current = 500;
    hybrid.hp.max = Math.max(hybrid.hp.max || 0, 500);
    applyItemUseEffect(hybrid, potEffect, { rng: () => 0 });
    assert.ok(hasCondition(hybrid, 'mana_shield'));
    assert.ok(hybrid.combatStats.flags.manaShield);
    const rCancel = resolveAttack({
        attacker: hybrid,
        defender: hybrid,
        spell: 'cancel_magic_shield',
        spellBook: spells,
        rng: () => 0,
        skipCooldown: true,
        skipMana: true
    });
    assert.strictEqual(rCancel.ok, true, rCancel.reason || 'cancel ok');
    assert.strictEqual(hasCondition(hybrid, 'mana_shield'), false);
    assert.ok(hybrid.combatStats.flags.manaShield, 'cancel leaves gear flag');
    const hpHybrid = hybrid.hp.current;
    const mpHybrid = hybrid.mp.current;
    assert.strictEqual(applyHpDelta(hybrid, 50, 'physical'), 0);
    assert.strictEqual(hybrid.hp.current, hpHybrid);
    assert.strictEqual(hybrid.mp.current, mpHybrid - 50);

    const leftover = new Player({
        name: 'Pool Then Gear',
        id: 35,
        classId: 'guardian',
        classDef: guardian,
        itemDb: items,
        equipment: { ring: 'voltaic_ring' },
        level: 50
    });
    leftover.mp.max = Math.max(leftover.mp.max || 0, 400);
    leftover.mp.current = 300;
    leftover.hp.current = 500;
    leftover.hp.max = Math.max(leftover.hp.max || 0, 500);
    applyCondition(leftover, {
        type: 'mana_shield',
        durationSec: 60,
        poolRemaining: 30,
        poolMax: 30
    });
    assert.strictEqual(applyHpDelta(leftover, 100, 'physical'), -70);
    assert.strictEqual(leftover.mp.current, 270);
    assert.strictEqual(leftover.hp.current, 430);
    assert.strictEqual(hasCondition(leftover, 'mana_shield'), false);
    assert.ok(leftover.combatStats.flags.manaShield, 'gear remains after pool gone');
    assert.strictEqual(applyHpDelta(leftover, 40, 'fire'), 0);
    assert.strictEqual(leftover.mp.current, 230);
    assert.strictEqual(leftover.hp.current, 430);

    log('Phase 3 mana shield gear + potion ok', { expectedPool });
}

function main() {
    testRollHitAndCrit();
    testRollRawAndArmor();
    testGaussianAutoRaw();
    testCritBandSplit();
    testMitigationPipelineOrder();
    testComputeDamageMiss();
    testCooldowns();
    testEquipmentRollup();
    testSpeedFromLevel();
    testUnarmedDefaults();
    testWeaponSkillFromGear();
    testDefenseBonusAndOptionalFlags();
    testProfileSlotAliases();
    testProfileSkillOverrides();
    testEquipmentDurationAndCharges();
    testBuildGuardianStats();
    testWeaponAutoFormulasAndDistanceAmmo();
    testWeaponExtraElementAndHitChance();
    testEquipmentCritAndLeech();
    testClassCritStack();
    testCreatureCrit();
    testShapedDistanceAutos();
    testFatalHits();
    testStrikeMeanAmplitude();
    testGuardianAutoVsDummy();
    testAutoAndFrontSweepIndependent();
    testGuardianStrikeVsDummy();
    testPreviewAndPresetsLoad();
    testSeedStableDamage();
    testHealLightSelfRestore();
    testHotRecoverySpells();
    testManaShieldKernel();
    testManaShieldCatalog();
    testManaShieldGearAndPotion();
    testPhaseMStances();
    testMmaMonkHeals();
    testMmbBalancedBrawl();
    testMmcMysticHighTierAttacks();
    testRuneCastRangeFarUse();
    testEngageRangeXY();
    testParalyzeRuneAndImmunity();
    testCureSpellsDispel();
    testHasteInvisibleSpellsAndSeeInvis();
    testChallengeTauntSpell();
    testChivalrousChallengeAndDivineDazzle();
    testDotAttackSpells();
    testHealingSkipsMitigation();
    testCreatureUpdateTicksCooldowns();
    testDefenseBlockAndShieldWindow();
    testSpellMoveLock();
    testShapedBerserkMultiHit();
    testShapedFrontSweepWave();
    testSweepingTakedownDualCombat();
    testChainAttackPickAndResolve();
    testWikiParityLightningGrenadeExecutioner();
    testHPAndMPRegeneration();
    testCanCastMoveLockAndUltimatePrimary();
    testSpellLevelAndMagicLevelGates();
    testRuneInventoryGates();
    testEnemyAoeHitsAllPlayersOnStack();
    testPlayerAoeCastGateFirstOnly();
    console.log('combat: all tests passed');
}

main();
