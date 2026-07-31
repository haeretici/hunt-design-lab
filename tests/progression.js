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
    SKILL_FLOOR,
    partyShareMultiplier,
    partySharePerMember,
    applyPersonalExpRates,
    normalizeExpRates,
    applyExpProgression,
    seedPlayerExperience,
    freezeExpSessionConfig,
    uniqueVocationCount
} = require('../kernel/core/lib/character/progression.js');
const { Party } = require('../kernel/core/entities/party.js');
const {
    deriveSkills,
    FLOOR_SKILLS,
    interpolateAnchors
} = require('../kernel/core/lib/character/skill_derive.js');
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

    const a90 = deriveSkills({ id: 'adept', skillRates: { magic: 1.1 } }, 90, {
        format: 'legacy',
        includeCosts: true
    });
    assert.strictEqual(a90.skills.magicLevel, 80);
    assert.ok(a90.costs && a90.costs.magicMana > 0);

    const leg = deriveSkills('scout', 12, { format: 'legacy' });
    assert.ok(leg.skills.distance >= 20);
    assert.ok(leg.skills.sword != null);

    assert.strictEqual(interpolateAnchors([[10, 10], [20, 30]], 15), 20);
    log('derive skills ok', { g50: g50.skills, a90: a90.skills });
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
    log('freeze session config ok');
}

function main() {
    testExpCurve();
    testSkillTriesGuardian();
    testMagicManaAdept();
    testMysticProductRates();
    testClassFloors();
    testDeriveSkills();
    testPartyShareFormula();
    testPersonalRatesAndRaw();
    testLevelUpFromExp();
    testAwardKillRawVsAwarded();
    testFreezeSessionConfig();
    console.log('progression tests ok');
}

main();
