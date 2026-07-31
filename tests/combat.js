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
    indexSpells
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
    tryAttack
} = require('../kernel/core/lib/ai/combat_actions.js');
const {
    countItemIdInInventoryTree,
    buildInventoryFromSeed
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
    // crit floor ~0.65*20=13; rng 0 → 13; +50% → 19
    assert.strictEqual(crit.critical, true);
    assert.ok(crit.raw >= 13, `crit floor: ${crit.raw}`);

    assert.strictEqual(rollArmorReduction(0, () => 0), 0);
    // Legacy: [ceil(a/2), ceil(a/2)*2-1] → armor 10 → [5, 9]
    assert.strictEqual(rollArmorReduction(10, () => 0), 5);
    assert.strictEqual(rollArmorReduction(10, () => 0.999), 9);
    assert.strictEqual(rollArmorReduction(9, () => 0), 5);
    assert.strictEqual(rollArmorReduction(9, () => 0.999), 9);
    assert.strictEqual(rollArmorReduction(1, () => 0), 1);
    log('rollRaw / armor ok');
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
    assert.strictEqual(swordStats.skill, 50, 'sword uses collapsed melee bag');
    assert.strictEqual(swordStats.autoAttack, 'melee_auto');

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
    assert.strictEqual(clubStats.skill, 50);

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
        isLeader: true
    });
    assert.strictEqual(member.classId, 'guardian');
    assert.strictEqual(member.equipment.helmet, 'steel_casque');
    assert.strictEqual(member.equipment.rightHand, 'jagged_sword');
    assert.strictEqual(member.equipment.leftHand, 'plate_shield');
    assert.strictEqual(member.isLeader, true);

    const expanded = expandPartyMember(
        { profileId: 'guardian_starter', name: 'Tank', isLeader: true },
        { loadPlayerProfile: () => profile }
    );
    assert.strictEqual(expanded.equipment.helmet, 'steel_casque');
    assert.strictEqual(expanded.classId, 'guardian');

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
        assert.strictEqual(liveStats.critChance, 5);
        log('live guardian_starter skills ok', liveStats.skills);
    } catch (e) {
        log('live profile skills skip', e.message);
    }

    log('profile skill overrides ok');
}

/**
 * durationSec tick → unequip; charges consume on hit → unequip at 0.
 */
function testEquipmentDurationAndCharges() {
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
            id: 'plain_boots',
            slot: 'boots',
            category: 'boots',
            armor: 2
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

    // Charges
    runtime = initEquipmentRuntime({ ring: 'charge_ring' }, itemDb);
    assert.strictEqual(runtime.ring.remainingCharges, 3);
    let hit = consumeEquipmentCharges(runtime, 1);
    assert.strictEqual(runtime.ring.remainingCharges, 2);
    assert.strictEqual(hit.depletedSlots.length, 0);
    hit = consumeEquipmentCharges(runtime, 2);
    assert.strictEqual(runtime.ring.remainingCharges, 0);
    assert.ok(hit.depletedSlots.indexOf('ring') >= 0);

    const charged = applyHitChargeConsumption(
        { ring: 'charge_ring' },
        initEquipmentRuntime({ ring: 'charge_ring' }, itemDb),
        3
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

    // Live time_ring / power_band (commercial rename of might_ring) when present
    try {
        const liveItems = presets.loadEquipment().items;
        const timeRing = liveItems.find((i) => i && i.id === 'time_ring');
        const might = liveItems.find((i) => i && i.id === 'power_band');
        if (timeRing && timeRing.durationSec === 600) {
            const rt = initEquipmentRuntime({ ring: 'time_ring' }, liveItems);
            assert.strictEqual(rt.ring.remainingDurationSec, 600);
        }
        if (might && might.charges === 20) {
            const rt = initEquipmentRuntime({ ring: 'power_band' }, liveItems);
            assert.strictEqual(rt.ring.remainingCharges, 20);
        }
        log('live timed/charged rings ok');
    } catch (e) {
        log('live rings skip', e.message);
    }

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
        // High enough for front_sweep (70) / fierce_berserk (90) kit tests
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
    const spell = spells.berserk;
    assert.ok(spell, 'berserk preset');
    assert.ok(spellHasShape(spell), 'berserk has shape');
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
    assert.ok(Cooldowns.getRemaining(player, 'spell', 'berserk') > 0);
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

    log('shaped berserk multi-hit ok', {
        hits: result.hits.length,
        tiles: result.affectedTiles.length
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
function testSpellLevelAndMagicLevelGates() {
    const lowMl = {
        level: 50,
        combatStats: { magic: 3, level: 50, spells: ['deathburst', 'blaze_field_rune'] },
        cooldowns: {},
        mp: { current: 100, max: 100 }
    };
    const highMl = {
        level: 50,
        combatStats: { magic: 15, level: 50, spells: ['deathburst', 'blaze_field_rune'] },
        cooldowns: {},
        mp: { current: 100, max: 100 }
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
        mp: { current: 100, max: 100 }
    };
    const scoutNoBook = {
        classId: 'scout',
        level: 50,
        combatStats: { magic: 30, level: 50 },
        cooldowns: {},
        mp: { current: 100, max: 100 }
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

function main() {
    testRollHitAndCrit();
    testRollRawAndArmor();
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
    testStrikeMeanAmplitude();
    testGuardianAutoVsDummy();
    testAutoAndFrontSweepIndependent();
    testGuardianStrikeVsDummy();
    testPreviewAndPresetsLoad();
    testSeedStableDamage();
    testHealLightSelfRestore();
    testHealingSkipsMitigation();
    testCreatureUpdateTicksCooldowns();
    testDefenseBlockAndShieldWindow();
    testSpellMoveLock();
    testShapedBerserkMultiHit();
    testShapedFrontSweepWave();
    testHPAndMPRegeneration();
    testSpellLevelAndMagicLevelGates();
    testRuneInventoryGates();
    console.log('combat: all tests passed');
}

main();
