#!/usr/bin/env node
/**
 * Phase A/B: pure progression math + skill derive tooling.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    getExpForLevel,
    expToNext,
    levelFromExp,
    getReqSkillTries,
    totalSkillTries,
    getReqMana,
    totalManaForMagicLevel,
    skillTryCost,
    applyTrainingPointModifiers,
    exercisePointsPerSec,
    estimateSkillTraining,
    EXERCISE_POINTS_PER_SEC,
    EXERCISE_DUMMY_FACTOR,
    SKILL_FLOOR,
    BLOOD_HIT_BUCKET,
    partyShareMultiplier,
    partySharePerMember,
    applyPersonalExpRates,
    normalizeExpRates,
    applyExpProgression,
    seedPlayerExperience,
    freezeExpSessionConfig,
    setActiveSessionConfig,
    uniqueVocationCount,
    applySkillTries,
    applyManaTowardMagic,
    classifyAttackBlockType,
    processAttackSkillProgression,
    processManaSkillProgression,
    getPlayerSkillLevel,
    resolveWeaponSkillBag
} = require('../kernel/core/lib/character/progression.js');
const { Party } = require('../kernel/core/entities/party.js');
const {
    deriveSkills,
    FLOOR_SKILLS,
    interpolateAnchors,
    isStandardProfileSkillBag
} = require('../kernel/core/lib/character/skill_derive.js');
const fs = require('fs');
const path = require('path');
const presets = require('../kernel/core/lib/presets.js');
const { DEFAULT_SKILLS, buildEffectiveStats, rollupEquipment } = require('../kernel/core/lib/character/stats.js');

const verbose = process.env.VERBOSE === '1';
function log(...args) {
    if (verbose) console.log(...args);
}

function testExpCurve() {
    assert.strictEqual(getExpForLevel(1), 0);
    assert.strictEqual(getExpForLevel(2), 100);
    assert.strictEqual(getExpForLevel(50), 1847300);
    assert.strictEqual(expToNext(50), 117700);
    assert.strictEqual(getExpForLevel(51) - getExpForLevel(50), expToNext(50));
    assert.strictEqual(levelFromExp(0), 1);
    assert.strictEqual(levelFromExp(1847300), 50);
    assert.strictEqual(levelFromExp(1847299), 49);
    assert.strictEqual(levelFromExp(1847300 + 117700 - 1), 50);
    assert.strictEqual(levelFromExp(1847300 + 117700), 51);
    log('exp curve ok');
}

function testSkillTriesGuardian() {
    const rates = { melee: 1.1, fist: 1.1, distance: 1.4, shielding: 1.1, magic: 3.0 };
    // Total tries 10 → 50: base * (m^40 - 1)/(m-1)
    const total = totalSkillTries('melee', 50, rates);
    assert.strictEqual(total, 22129);
    assert.strictEqual(totalSkillTries('sword', 50, rates), total, 'sword → melee bag');
    assert.strictEqual(getReqSkillTries('melee', 10, rates), 0);
    assert.strictEqual(getReqSkillTries('melee', 11, rates), 50); // base * m^0
    // Sum of per-level req should match cumulative (allowing floor drift of 0 since we floor each step separately)
    let sum = 0;
    for (let s = 11; s <= 50; s++) sum += getReqSkillTries('melee', s, rates);
    assert.ok(Math.abs(sum - total) <= 40, `sum ${sum} vs total ${total}`);
    log('guardian melee tries ok', { total, sum });
}

function testMagicManaAdept() {
    const rates = { magic: 1.1 };
    assert.strictEqual(getReqMana(1, rates), 1600);
    assert.strictEqual(getReqMana(2, rates), Math.floor(1600 * 1.1));
    const total50 = totalManaForMagicLevel(50, rates);
    assert.strictEqual(total50, 1862225);
    assert.strictEqual(totalManaForMagicLevel(0, rates), 0);
    log('adept ML mana ok', total50);
}

function testMysticProductRates() {
    const cls = presets.getClass('mystic');
    assert.ok(cls && cls.skillRates, 'mystic has skillRates');
    assert.strictEqual(cls.skillRates.melee, 1.4);
    assert.strictEqual(cls.skillRates.shielding, 1.15);
    assert.strictEqual(cls.skillRates.magic, 1.25);
    // Product mystic (1.4) is cheaper melee than alternate 1.5 at skill 50
    const product = totalSkillTries('melee', 50, cls.skillRates);
    const alternate = totalSkillTries('melee', 50, { melee: 1.5 });
    assert.ok(product < alternate, 'product mystic melee cheaper than 1.5 mult');
    log('mystic product rates ok', { product, alternate });
}

function testClassFloors() {
    assert.strictEqual(DEFAULT_SKILLS.magic, 0);
    assert.strictEqual(DEFAULT_SKILLS.melee, 10);
    assert.strictEqual(FLOOR_SKILLS.magic, 0);

    for (const id of ['guardian', 'scout', 'mystic', 'adept', 'warden', 'adventurer']) {
        const cls = presets.getClass(id);
        assert.ok(cls, id);
        assert.strictEqual(cls.skills.melee, 10, `${id} melee floor`);
        assert.strictEqual(cls.skills.distance, 10, `${id} distance floor`);
        assert.strictEqual(cls.skills.shielding, 10, `${id} shielding floor`);
        assert.strictEqual(cls.skills.magic, 0, `${id} magic floor`);
        assert.ok(cls.skillRates && cls.skillRates.melee > 1, `${id} skillRates`);
    }

    const g = presets.getClass('guardian');
    const naked = buildEffectiveStats(g, rollupEquipment({}, null), { level: 50 });
    assert.strictEqual(naked.skill, 10);
    assert.strictEqual(naked.skills.magic, 0);
    log('class floors ok');
}

function testDeriveSkills() {
    const g50 = deriveSkills('guardian', 50, { format: 'engine' });
    assert.strictEqual(g50.classId, 'guardian');
    assert.strictEqual(g50.level, 50);
    assert.ok(g50.skills.melee >= 55 && g50.skills.melee <= 65, `guardian L50 melee ${g50.skills.melee}`);
    assert.ok(g50.skills.shielding >= 45 && g50.skills.shielding <= 55);
    assert.strictEqual(g50.skills.magic, 0);
    // Engine bags carry subtypes (standard policy) — not melee-only
    assert.strictEqual(g50.skills.sword, g50.skills.melee, 'guardian primary → sword');
    assert.ok(g50.skills.axe < g50.skills.sword, 'off-melee axe below primary');
    assert.ok(g50.skills.club < g50.skills.sword, 'off-melee club below primary');

    const a90 = deriveSkills({ id: 'adept', skillRates: { magic: 1.1 } }, 90, {
        format: 'legacy',
        includeCosts: true
    });
    assert.strictEqual(a90.skills.magicLevel, 80);
    assert.ok(a90.costs && a90.costs.magicMana > 0);
    assert.ok(isStandardProfileSkillBag(a90.skills), 'legacy derive is standard profile bag');

    const leg = deriveSkills('scout', 12, { format: 'legacy' });
    assert.ok(leg.skills.distance >= 20);
    assert.ok(leg.skills.sword != null);

    assert.strictEqual(interpolateAnchors([[10, 10], [20, 30]], 15), 20);
    log('derive skills ok', { g50: g50.skills, a90: a90.skills });
}

/**
 * Product + test profiles under presets/standard must author subtype bags
 * (sword/axe/club/fist/…), not melee-only collapse.
 */
function testStandardProfilesSubtypePolicy() {
    const dir = path.join(
        __dirname,
        '..',
        'presets',
        'standard',
        'player_profiles'
    );
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length >= 12, 'expected standard player_profiles');
    const bad = [];
    for (const f of files) {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!isStandardProfileSkillBag(p.skills)) {
            bad.push(f + ' keys=' + Object.keys(p.skills || {}).join(','));
        }
    }
    assert.strictEqual(
        bad.length,
        0,
        'profiles missing standard subtype skills: ' + bad.join('; ')
    );
    // Melee-only bag must fail the gate
    assert.strictEqual(
        isStandardProfileSkillBag({ melee: 60, distance: 10, shielding: 10, magic: 0 }),
        false
    );
    log('standard profiles subtype policy ok', { count: files.length });
}

function testPartyShareFormula() {
    assert.ok(Math.abs(partyShareMultiplier(1, 2) - 1.2) < 1e-9);
    assert.ok(Math.abs(partyShareMultiplier(2, 2) - 1.3) < 1e-9);
    assert.ok(Math.abs(partyShareMultiplier(3, 3) - 1.6) < 1e-9);
    assert.ok(Math.abs(partyShareMultiplier(4, 4) - 2.0) < 1e-9);
    assert.ok(Math.abs(partyShareMultiplier(4, 3) - 2.1) < 1e-9);

    const solo = partySharePerMember(1000, { partySize: 1, uniqueVocations: 1 });
    assert.strictEqual(solo.personalRaw, 1000);
    assert.strictEqual(solo.shareMul, 1);

    // 4 unique vocations, N=4 → mul 2.0 → ceil(1000*2/4)=500
    const full = partySharePerMember(1000, {
        partySize: 4,
        uniqueVocations: 4
    });
    assert.strictEqual(full.personalRaw, 500);
    assert.ok(Math.abs(full.shareMul - 2.0) < 1e-9);

    // Duo same vocation: mul 1.2 → ceil(1000*1.2/2)=600
    const duo = partySharePerMember(1000, {
        members: [{ classId: 'guardian' }, { classId: 'guardian' }]
    });
    assert.strictEqual(duo.personalRaw, 600);
    assert.strictEqual(uniqueVocationCount([{ classId: 'guardian' }, { classId: 'adept' }]), 2);

    const plain = partySharePerMember(1000, {
        partySize: 4,
        uniqueVocations: 4,
        partyShareEnabled: false
    });
    assert.strictEqual(plain.personalRaw, 250);
    log('party share formula ok');
}

function testPersonalRatesAndRaw() {
    const rates = normalizeExpRates({
        baseRate: 2,
        eventMult: 1,
        staminaMult: 1.5,
        additiveBonus: 0.1,
        prey: 0.05,
        xpBoost: 0.05
    });
    // floor(1000 * (1+0.1+0.05+0.05) * 2 * 1 * 1.5) = floor(1000*1.2*3)=3600
    assert.strictEqual(applyPersonalExpRates(1000, rates), 3600);
    assert.strictEqual(applyPersonalExpRates(1000, null), 1000);
    log('personal rates ok');
}

function testLevelUpFromExp() {
    const player = {
        level: 50,
        experience: null,
        _loadoutOpts: { level: 50 },
        _rebuildCombatStatsFromLoadout() {
            this.rebuilt = true;
        }
    };
    seedPlayerExperience(player);
    assert.strictEqual(player.experience, getExpForLevel(50));

    const need = expToNext(50);
    const r = applyExpProgression(player, need);
    assert.strictEqual(r.levelUps, 1);
    assert.strictEqual(player.level, 51);
    assert.strictEqual(player.rebuilt, true);
    assert.strictEqual(player._loadoutOpts.level, 51);

    // Without progression credit path: multi-level
    const p2 = { level: 1, experience: 0 };
    const r2 = applyExpProgression(p2, getExpForLevel(5));
    assert.strictEqual(r2.newLevel, 5);
    assert.strictEqual(r2.levelUps, 4);
    log('level-up ok');
}

function testAwardKillRawVsAwarded() {
    const party = new Party({ name: 'T', waypoints: [{ x: 0, y: 0, z: 0 }] });
    const mk = (classId) => ({
        classId,
        alive: true,
        hp: { current: 100, max: 100 },
        expGained: 0,
        rawExpGained: 0,
        kills: 0,
        level: 50,
        experience: getExpForLevel(50),
        levelUps: 0
    });
    // 4 unique classes → shareMul 2.0, personalRaw = ceil(1000*2/4)=500
    const members = [
        mk('guardian'),
        mk('scout'),
        mk('adept'),
        mk('warden')
    ];
    // Lightweight roster (no GameObject scene graph)
    party.members = members;

    const result = party.awardKill(1000, 0, {
        expProgression: false,
        expRates: { baseRate: 2, staminaMult: 1, eventMult: 1 }
    });
    assert.strictEqual(result.personalRaw, 500);
    assert.strictEqual(result.rawTotal, 2000); // 500 * 4
    assert.strictEqual(result.awardedTotal, 4000); // floor(500*2)*4
    assert.strictEqual(members[0].rawExpGained, 500);
    assert.strictEqual(members[0].expGained, 1000);
    assert.strictEqual(members[0].level, 50, 'no level-up when flag off');
    assert.strictEqual(party.rawExpGained, 2000);
    assert.strictEqual(party.expGained, 4000);

    // Progression on: credit experience
    const soloParty = new Party({ name: 'S', waypoints: [{ x: 0, y: 0 }] });
    const solo = mk('guardian');
    solo.level = 1;
    solo.experience = 0;
    soloParty.members = [solo];
    const r2 = soloParty.awardKill(getExpForLevel(3), 0, {
        expProgression: true,
        expRates: {}
    });
    assert.ok(r2.levelUps >= 1);
    assert.ok(solo.level >= 2);
    assert.strictEqual(solo.rawExpGained, getExpForLevel(3));
    log('awardKill raw vs awarded ok');
}

function testFreezeSessionConfig() {
    const frozen = freezeExpSessionConfig({
        expProgression: true,
        expRates: { baseRate: 3, prey: 0.1 }
    });
    assert.strictEqual(frozen.expProgression, true);
    assert.strictEqual(frozen.expRates.baseRate, 3);
    assert.strictEqual(frozen.expRates.prey, 0.1);
    assert.strictEqual(frozen.skillProgression, false);
    assert.strictEqual(frozen.skillRates.stageMult, 1);
    assert.strictEqual(frozen.skillRates.skillPrey, 0);
    log('freeze session config ok');
}

function mkPlayer(overrides) {
    return Object.assign(
        {
            type: 'player',
            classId: 'guardian',
            skills: { melee: 10, sword: 10, shielding: 10, magic: 0, fist: 10 },
            skillTriesGained: Object.create(null),
            bloodHitCount: 0,
            shieldBlockCount: 0,
            skillLevelsGained: 0,
            magicLevelsGained: 0,
            manaSpentTowardMagic: 0,
            _skillTryProgress: Object.create(null),
            _manaTowardMagic: 0,
            combatStats: {
                weaponSkill: 'sword',
                skillKey: 'sword',
                hasShield: true,
                maxBlock: 20
            },
            _loadoutClassDef: {
                skillRates: {
                    melee: 1.1,
                    fist: 1.1,
                    distance: 1.4,
                    shielding: 1.1,
                    magic: 3.0
                }
            }
        },
        overrides || {}
    );
}

function testBloodBucketAndMeleeTries() {
    setActiveSessionConfig(null);
    const atk = mkPlayer();
    const def = mkPlayer({ combatStats: { hasShield: true, maxBlock: 20 } });

    // Full damage → +1 sword try, blood=30, defender shield bucket=30
    const r1 = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 40,
            breakdown: { shieldBlock: 0, armorReduction: 0 },
            spell: { id: 'melee_auto', kind: 'auto', isMelee: true }
        },
        { skillProgression: false }
    );
    assert.strictEqual(r1.blockType, 'none');
    assert.strictEqual(r1.weaponTries, 1);
    assert.strictEqual(r1.weaponSkill, 'sword');
    assert.strictEqual(atk.bloodHitCount, BLOOD_HIT_BUCKET);
    assert.strictEqual(def.shieldBlockCount, BLOOD_HIT_BUCKET);
    assert.ok((atk.skillTriesGained.sword || 0) >= 1, 'try counter always');
    assert.strictEqual(atk.skills.melee, 10, 'flag off: no skill level drift');

    // 30 defense outcomes while bucket allows
    for (let i = 0; i < 30; i++) {
        const r = processAttackSkillProgression(
            atk,
            def,
            {
                ok: true,
                hit: true,
                final: 0,
                breakdown: { shieldBlock: 5, armorReduction: 0 },
                spell: { id: 'melee_auto', kind: 'auto', isMelee: true }
            },
            { skillProgression: false, blockChargeSpent: false }
        );
        assert.strictEqual(r.weaponTries, 1, `defense try ${i}`);
    }
    assert.strictEqual(atk.bloodHitCount, 0);
    // 31st without blood → no try
    const rDry = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 0,
            breakdown: { shieldBlock: 5, armorReduction: 0 },
            spell: { id: 'melee_auto', kind: 'auto', isMelee: true }
        },
        { skillProgression: false }
    );
    assert.strictEqual(rDry.weaponTries, 0, 'bucket empty → no weapon try');
    log('blood bucket + melee tries ok');
}

function testDistanceTries() {
    setActiveSessionConfig(null);
    const atk = mkPlayer({
        combatStats: { weaponSkill: 'distance', skillKey: 'distance' }
    });
    const def = { type: 'creature', alive: true };

    const full = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 25,
            breakdown: {},
            spell: { id: 'distance_auto', kind: 'auto' }
        },
        { skillProgression: false }
    );
    assert.strictEqual(full.weaponTries, 2);
    assert.strictEqual(full.weaponSkill, 'distance');

    const deflected = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 0,
            breakdown: { armorReduction: 10 },
            spell: { id: 'distance_auto', kind: 'auto' }
        },
        { skillProgression: false }
    );
    assert.strictEqual(deflected.weaponTries, 1);

    // Empty bucket after draining
    atk.bloodHitCount = 0;
    const none = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 0,
            breakdown: { armorReduction: 10 },
            spell: { id: 'distance_auto', kind: 'auto' }
        },
        { skillProgression: false }
    );
    assert.strictEqual(none.weaponTries, 0);
    log('distance 2/1/0 ok');
}

function testShieldFullZeroOnly() {
    setActiveSessionConfig(null);
    const atk = { type: 'creature' };
    const def = mkPlayer({ shieldBlockCount: 30 });

    // Partial damage with charge spent → no shield try
    const partial = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 5,
            breakdown: { shieldBlock: 10, armorReduction: 0 },
            spell: { id: 'melee_auto', kind: 'auto', isMelee: true }
        },
        { skillProgression: false, blockChargeSpent: true }
    );
    assert.strictEqual(partial.shieldTries, 0, 'partial hit: no shield try');
    // Blood refill still happens on full damage
    assert.strictEqual(def.shieldBlockCount, BLOOD_HIT_BUCKET);

    // Full zero + charge + bucket → +1 shielding
    def.shieldBlockCount = 5;
    const fullZero = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 0,
            breakdown: { shieldBlock: 15, armorReduction: 0 },
            spell: { id: 'melee_auto', kind: 'auto', isMelee: true }
        },
        { skillProgression: false, blockChargeSpent: true }
    );
    assert.strictEqual(fullZero.shieldTries, 1);
    assert.strictEqual(def.shieldBlockCount, 4);
    assert.ok((def.skillTriesGained.shielding || 0) >= 1);

    // Full zero without charge spent → no try
    const noCharge = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 0,
            breakdown: { shieldBlock: 0, armorReduction: 20 },
            spell: { id: 'melee_auto', kind: 'auto', isMelee: true }
        },
        { skillProgression: false, blockChargeSpent: false }
    );
    assert.strictEqual(noCharge.shieldTries, 0);

    // No shield equipped → no try
    def.combatStats.hasShield = false;
    def.equipment = {};
    def.shieldBlockCount = 10;
    const noShield = processAttackSkillProgression(
        atk,
        def,
        {
            ok: true,
            hit: true,
            final: 0,
            breakdown: { shieldBlock: 10 },
            spell: { id: 'melee_auto', kind: 'auto', isMelee: true }
        },
        { skillProgression: false, blockChargeSpent: true }
    );
    assert.strictEqual(noShield.shieldTries, 0);
    log('shield full-zero only ok');
}

function testManaNoHitAndFlagOnSkillUp() {
    setActiveSessionConfig(null);
    const p = mkPlayer({
        skills: { melee: 10, distance: 10, shielding: 10, magic: 0, fist: 10 }
    });
    // Flag off: counter only
    const m0 = applyManaTowardMagic(p, 1600, { skillProgression: false });
    assert.strictEqual(m0.levelsGained, 0);
    assert.strictEqual(p.skills.magic, 0);
    assert.ok(p.manaSpentTowardMagic >= 1600);

    // Flag on: ML up (adept rates would be 1.1; guardian magic 3.0)
    // getReqMana(1, magic:3) = floor(1600 * 3^0) = 1600
    const p2 = mkPlayer({
        skills: { melee: 10, distance: 10, shielding: 10, magic: 0, fist: 10 },
        manaSpentTowardMagic: 0,
        _manaTowardMagic: 0
    });
    const m1 = applyManaTowardMagic(p2, 1600, { skillProgression: true });
    assert.strictEqual(m1.levelsGained, 1);
    assert.strictEqual(p2.skills.magic, 1);
    assert.strictEqual(p2.magicLevelsGained, 1);

    // Weapon skill up with flag on (cheap: skill 10→11 needs 50 tries at m=1.1)
    const p3 = mkPlayer({
        skills: { melee: 10, sword: 10, shielding: 10, magic: 0, fist: 10, sword: 10 }
    });
    const need = getReqSkillTries('sword', 11, p3._loadoutClassDef.skillRates);
    assert.strictEqual(need, 50);
    const adv = applySkillTries(p3, 'sword', need, { skillProgression: true });
    assert.strictEqual(adv.levelsGained, 1);
    assert.strictEqual(getPlayerSkillLevel(p3, 'sword'), 11);
    assert.strictEqual(p3.skills.sword, 11);
    log('mana + skill flag on/off ok');
}

function testWandNoWeaponTry() {
    const bag = resolveWeaponSkillBag(
        { combatStats: { weaponSkill: 'magic' } },
        { id: 'wand_auto', kind: 'auto' }
    );
    assert.strictEqual(bag, null);
    const spellBag = resolveWeaponSkillBag(
        { combatStats: { weaponSkill: 'sword' } },
        { id: 'flame_strike', kind: 'spell' }
    );
    assert.strictEqual(spellBag, null);
    log('wand/spell no weapon try ok');
}

function testClassifyBlockType() {
    assert.strictEqual(
        classifyAttackBlockType({ hit: false, final: 0 }),
        'miss'
    );
    assert.strictEqual(
        classifyAttackBlockType({ hit: true, final: 10, breakdown: {} }),
        'none'
    );
    assert.strictEqual(
        classifyAttackBlockType({
            hit: true,
            final: 0,
            breakdown: { shieldBlock: 5 }
        }),
        'defense'
    );
    assert.strictEqual(
        classifyAttackBlockType({
            hit: true,
            final: 0,
            breakdown: { armorReduction: 3 }
        }),
        'armor'
    );
    assert.strictEqual(
        classifyAttackBlockType({ hit: true, final: 0, breakdown: {} }),
        'immunity'
    );
    log('classify block type ok');
}

function testProductPartySkillGate() {
    const {
        memberHasAuthoredSkills,
        assertPartyMembersHaveSkillSource,
        expandPartyMember,
        materializePartyMember,
        defaultProfileIdForClass,
        DEFAULT_STARTER_PROFILE_BY_CLASS
    } = require('../kernel/core/lib/character/player_profile.js');
    const { resolveSessionParties } = require('../kernel/core/lib/character/party_resolve.js');
    const {
        normalizeMember,
        membersToPartyConfig,
        emptyMember
    } = require('../kernel/apps/game/party_form.js');

    assert.strictEqual(memberHasAuthoredSkills({ skills: { sword: 50 } }), true);
    assert.strictEqual(memberHasAuthoredSkills({ classId: 'guardian' }), false);
    assert.strictEqual(memberHasAuthoredSkills({ skills: {} }), false);
    assert.strictEqual(defaultProfileIdForClass('guardian'), 'guardian_starter');
    assert.strictEqual(defaultProfileIdForClass('adept'), 'adept_starter');
    assert.strictEqual(defaultProfileIdForClass('mystic'), null);
    assert.strictEqual(
        DEFAULT_STARTER_PROFILE_BY_CLASS.scout,
        'scout_starter'
    );

    // Assert still rejects skill-less bags (call after materialize in product paths)
    assert.throws(
        () =>
            assertPartyMembersHaveSkillSource({
                members: [{ name: 'Naked', classId: 'guardian' }]
            }),
        /authored skills/
    );

    // Create-char analog: class-only row materializes into starter profile skills
    const matured = materializePartyMember(
        { name: 'Tank', classId: 'guardian', isLeader: true },
        { loadPlayerProfile: (id) => presets.loadPlayerProfile(id) }
    );
    assert.ok(memberHasAuthoredSkills(matured), 'materialize binds starter skills');
    assert.strictEqual(matured.profileId, 'guardian_starter');
    assert.ok(matured.skills.sword > 0);

    // Explicit skills skip rebinding
    const explicit = materializePartyMember(
        { classId: 'guardian', skills: { sword: 99 } },
        { loadPlayerProfile: (id) => presets.loadPlayerProfile(id) }
    );
    assert.strictEqual(explicit.skills.sword, 99);

    // Session resolve auto-materializes class-only members before assert
    const parties = resolveSessionParties({
        members: [{ name: 'Solo', classId: 'scout', isLeader: true }]
    });
    assert.ok(parties[0].members[0].skills);
    assert.strictEqual(parties[0].members[0].profileId, 'scout_starter');

    // Form empty slot is profile-backed
    const empty = emptyMember(0);
    assert.strictEqual(empty.profileId, 'guardian_starter');
    const formRow = normalizeMember({ enabled: true, classId: 'warden', isLeader: true }, 0);
    assert.ok(formRow.skills, 'normalizeMember materializes class-only');
    assert.strictEqual(formRow.profileId, 'warden_starter');
    const cfg = membersToPartyConfig([formRow]);
    assert.ok(cfg[0].skills);

    // Standard parties expand with skills
    const duo = presets.loadParty('starter_duo');
    assertPartyMembersHaveSkillSource(duo, { context: 'starter_duo' });
    assert.ok(memberHasAuthoredSkills(duo.members[0]));

    const expanded = expandPartyMember(
        { profileId: 'guardian_starter', isLeader: true },
        { loadPlayerProfile: (id) => presets.loadPlayerProfile(id) }
    );
    assert.ok(memberHasAuthoredSkills(expanded));
    log('product party skill gate ok');
}

function testSkillTrainingCostAndExerciseEta() {
    const rates = { melee: 1.1, fist: 1.1, distance: 1.4, shielding: 1.1, magic: 3.0 };
    // Floor → 50 matches totalSkillTries
    assert.strictEqual(skillTryCost('melee', 10, 50, rates), totalSkillTries('melee', 50, rates));
    assert.strictEqual(skillTryCost('sword', 10, 50, rates), 22129);
    assert.strictEqual(
        skillTryCost('melee', 20, 50, rates),
        totalSkillTries('melee', 50, rates) - totalSkillTries('melee', 20, rates)
    );
    assert.strictEqual(skillTryCost('magic', 0, 50, { magic: 1.1 }), totalManaForMagicLevel(50, { magic: 1.1 }));

    assert.strictEqual(applyTrainingPointModifiers(1000, { loyalty: 0 }), 1000);
    assert.strictEqual(applyTrainingPointModifiers(1000, { loyalty: 50 }), Math.round(1000 / 1.5));
    assert.strictEqual(applyTrainingPointModifiers(1000, { double: true }), 500);

    // Exercise equalizes delivery across primary weapon families
    assert.strictEqual(exercisePointsPerSec('sword'), EXERCISE_POINTS_PER_SEC.default);
    assert.strictEqual(exercisePointsPerSec('distance'), EXERCISE_POINTS_PER_SEC.default);
    assert.strictEqual(exercisePointsPerSec('axe'), exercisePointsPerSec('club'));
    assert.strictEqual(exercisePointsPerSec('shielding'), EXERCISE_POINTS_PER_SEC.shielding);
    assert.strictEqual(exercisePointsPerSec('magic'), EXERCISE_POINTS_PER_SEC.magic);

    const g = estimateSkillTraining({
        skill: 'sword',
        from: 10,
        to: 50,
        rates
    });
    assert.strictEqual(g.unit, 'tries');
    assert.strictEqual(g.points, 22129);
    assert.strictEqual(g.online.pointsPerSec, 0.5);
    assert.ok(g.online.totalSeconds > 0);
    assert.ok(g.exercise && g.exercise.pointsPerSec === 3.6);
    assert.ok(Math.abs(g.exercise.totalSeconds - 22129 / 3.6) < 1e-6);
    assert.ok(g.exercise.weapons && g.exercise.weapons.lasting >= 0);
    assert.ok(g.offline && g.offline.pointsPerDay === 10800);
    // No shop prices
    assert.strictEqual(g.exercise.gp, undefined);
    assert.strictEqual(g.exercise_tc_total, undefined);

    const withDummy = estimateSkillTraining({
        skill: 'sword',
        from: 10,
        to: 50,
        rates,
        dummy: true
    });
    assert.strictEqual(
        withDummy.exercise.points,
        Math.round(22129 / EXERCISE_DUMMY_FACTOR)
    );
    assert.ok(withDummy.exercise.totalSeconds < g.exercise.totalSeconds);

    // Distance and sword share exercise pts/s; vocation still changes try totals
    const dist = estimateSkillTraining({
        skill: 'distance',
        from: 10,
        to: 50,
        rates: { distance: 1.1 }
    });
    assert.strictEqual(dist.exercise.pointsPerSec, g.exercise.pointsPerSec);
    assert.notStrictEqual(dist.points, g.points, 'base 30 vs 50 → different try totals');

    const ml = estimateSkillTraining({
        skill: 'magic',
        from: 0,
        to: 10,
        rates: { magic: 1.1 },
        manaPerSec: 500
    });
    assert.strictEqual(ml.unit, 'mana');
    assert.strictEqual(ml.points, totalManaForMagicLevel(10, { magic: 1.1 }));
    assert.strictEqual(ml.online.pointsPerSec, 500);
    assert.strictEqual(ml.exercise.pointsPerSec, 305);

    log('skill training cost / exercise ETA ok', {
        sword50: g.points,
        exerciseSec: g.exercise.totalSeconds
    });
}

function testProgressionPrefsNormalize() {
    const {
        normalizeProgressionPrefs,
        applyProgressionPrefs,
        snapshotProgressionPrefs
    } = require('../html/widgets/engine_tweakings/bind.js');

    const empty = normalizeProgressionPrefs(null);
    assert.strictEqual(empty.features.expProgression, false);
    assert.strictEqual(empty.features.skillProgression, false);
    assert.strictEqual(empty.expRates.baseRate, 1);
    assert.strictEqual(empty.skillRates.stageMult, 1);

    const bag = normalizeProgressionPrefs({
        features: { expProgression: true, skillProgression: 1 },
        expRates: { baseRate: 2, prey: 0.25, junk: 9 },
        skillRates: { stageMult: 1.5, skillPrey: 0.1 }
    });
    assert.strictEqual(bag.features.expProgression, true);
    assert.strictEqual(bag.features.skillProgression, false, 'strict boolean only');
    assert.strictEqual(bag.expRates.baseRate, 2);
    assert.strictEqual(bag.expRates.prey, 0.25);
    assert.strictEqual(bag.expRates.junk, undefined);
    assert.strictEqual(bag.skillRates.stageMult, 1.5);

    const fakeSettings = {
        features: {},
        expRates: {},
        skillRates: {}
    };
    applyProgressionPrefs(fakeSettings, bag);
    assert.strictEqual(fakeSettings.features.expProgression, true);
    assert.strictEqual(fakeSettings.expRates.baseRate, 2);
    const snap = snapshotProgressionPrefs(fakeSettings);
    assert.strictEqual(snap.expRates.prey, 0.25);
    log('progression prefs normalize ok');
}

function main() {
    testExpCurve();
    testSkillTriesGuardian();
    testMagicManaAdept();
    testMysticProductRates();
    testClassFloors();
    testDeriveSkills();
    testStandardProfilesSubtypePolicy();
    testPartyShareFormula();
    testPersonalRatesAndRaw();
    testLevelUpFromExp();
    testAwardKillRawVsAwarded();
    testFreezeSessionConfig();
    testClassifyBlockType();
    testBloodBucketAndMeleeTries();
    testDistanceTries();
    testShieldFullZeroOnly();
    testManaNoHitAndFlagOnSkillUp();
    testWandNoWeaponTry();
    testProductPartySkillGate();
    testSkillTrainingCostAndExerciseEta();
    testProgressionPrefsNormalize();
    setActiveSessionConfig(null);
    console.log('progression tests ok');
}

main();
