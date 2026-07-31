#!/usr/bin/env node
/**
 * Stage 12G.3: combat VFX classify + headless no-op + watch queue.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const {
    CombatEffectsScript,
    effectsFromAttack,
    elementColor,
    AMMO_ART_TIP_ANGLE,
    PROJECTILE_SPRITE_SCALE,
    usesAmmoProjectileSprite,
    resolveAmmoProjectileSprite,
    projectileRotation
} = require('../kernel/core/scripts/combat_effects.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function tile(x, y, z) {
    return { x, y, z: z != null ? z : 7 };
}

function testElementColor() {
    assert.strictEqual(elementColor('fire'), '#f97316');
    assert.strictEqual(elementColor('unknown_elem'), '#e5e7eb');
    log('elementColor ok');
}

function testEffectsFromAttackRangedProjectile() {
    const attacker = { tile: tile(10, 10), type: 'player', alive: true };
    const defender = { tile: tile(14, 10), type: 'creature', alive: true };
    const result = {
        ok: true,
        hit: true,
        final: 12,
        spell: {
            id: 'ember_bolt',
            element: 'fire',
            range: 4,
            isMelee: false,
            kind: 'spell'
        }
    };
    const fx = effectsFromAttack(attacker, defender, result);
    assert.strictEqual(fx.length, 1, 'ranged hit → projectile only');
    assert.strictEqual(fx[0].type, 'projectile');
    assert.strictEqual(fx[0].x0, 10);
    assert.strictEqual(fx[0].x1, 14);
    assert.strictEqual(fx[0].sx, 10);
    assert.strictEqual(fx[0].sy, 10);
    assert.strictEqual(fx[0].color, '#f97316');
    assert.strictEqual(fx[0].spellId, 'ember_bolt', 'spell id for debug label');
    log('ranged projectile ok');
}

function testEffectsFromAttackMeleeAutoSlash() {
    const attacker = { tile: tile(5, 5), type: 'player', alive: true };
    const defender = { tile: tile(6, 5), type: 'creature', alive: true };
    const result = {
        ok: true,
        hit: true,
        final: 8,
        spell: {
            id: 'melee_auto',
            element: 'physical',
            range: 1,
            isMelee: true,
            kind: 'auto'
        }
    };
    const fx = effectsFromAttack(attacker, defender, result);
    assert.strictEqual(fx.length, 1, 'melee auto → hit slash VFX');
    assert.strictEqual(fx[0].type, 'melee');
    assert.strictEqual(fx[0].x0, 5);
    assert.strictEqual(fx[0].y0, 5);
    assert.strictEqual(fx[0].x1, 6);
    assert.strictEqual(fx[0].y1, 5);
    assert.strictEqual(fx[0].sx, 5);
    assert.strictEqual(fx[0].sy, 5);
    assert.strictEqual(fx[0].color, '#e5e7eb');
    assert.strictEqual(fx[0].z, 7, 'floor z from defender tile');
    assert.strictEqual(
        fx[0].spellId,
        undefined,
        'auto attacks omit spellId (plain hit:melee label)'
    );
    log('melee auto slash ok');
}

function testCombatFxFloorCullOnGui() {
    const prev = Settings.HEADLESS;
    const prevCamZ = Settings.cameraTileZ;
    Settings.HEADLESS = false;
    try {
        const script = new CombatEffectsScript();
        script.push({
            type: 'death',
            x: 2,
            y: 2,
            z: 0,
            life: 1
        });
        script.push({
            type: 'death',
            x: 3,
            y: 3,
            z: 1,
            life: 1
        });
        assert.strictEqual(script.entries.length, 2);

        let strokeCalls = 0;
        const g = {
            globalAlpha: 1,
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 1,
            beginPath() {},
            arc() {},
            fill() {},
            stroke() {
                strokeCalls += 1;
            },
            fillRect() {},
            strokeRect() {},
            save() {},
            restore() {},
            moveTo() {},
            lineTo() {},
            closePath() {}
        };
        const sim = {
            tileMap: {
                _viewOriginX: 0,
                _viewOriginY: 0,
                _viewZ: '1'
            }
        };
        script.level = sim;
        script.onGUI(g);
        assert.ok(strokeCalls > 0, 'same-floor death draws');

        sim.tileMap._viewZ = '0';
        strokeCalls = 0;
        script.onGUI(g);
        assert.ok(strokeCalls > 0, 'floor 0 death draws');

        // Wrong floor: neither entry matches z=9
        sim.tileMap._viewZ = '9';
        strokeCalls = 0;
        script.onGUI(g);
        assert.strictEqual(strokeCalls, 0, 'other-floor VFX culled');
        log('combat fx floor cull ok');
    } finally {
        Settings.HEADLESS = prev;
        Settings.cameraTileZ = prevCamZ;
    }
}

function testEffectsFromAttackDeathFlash() {
    const attacker = { tile: tile(5, 5), type: 'player', alive: true };
    const defender = {
        tile: tile(6, 5),
        type: 'creature',
        alive: false
    };
    const result = {
        ok: true,
        hit: true,
        final: 99,
        spell: {
            id: 'melee_auto',
            element: 'physical',
            range: 1,
            isMelee: true
        }
    };
    const fx = effectsFromAttack(attacker, defender, result);
    // melee slash + death flash
    assert.strictEqual(fx.length, 2);
    const types = fx.map((e) => e.type).sort();
    assert.deepStrictEqual(types, ['death', 'melee']);
    const death = fx.find((e) => e.type === 'death');
    assert.strictEqual(death.x, 6);
    assert.strictEqual(death.y, 5);
    assert.strictEqual(death.sx, 5);
    assert.strictEqual(death.sy, 5);
    log('death flash ok');
}

function testEffectsFromAttackAoe() {
    const attacker = { tile: tile(0, 0), type: 'creature', alive: true };
    const defender = { tile: tile(3, 3), type: 'player', alive: true };
    const result = {
        ok: true,
        hit: true,
        final: 20,
        spell: {
            id: 'fire_bomb',
            element: 'fire',
            range: 5,
            isMelee: false,
            attackKind: 'area',
            radius: 2,
            kind: 'spell'
        }
    };
    const fx = effectsFromAttack(attacker, defender, result);
    const types = fx.map((e) => e.type).sort();
    // area skips projectile; aoe only (defender still alive)
    assert.deepStrictEqual(types, ['aoe']);
    assert.strictEqual(fx[0].radius, 2);
    assert.strictEqual(fx[0].x, 3);
    assert.strictEqual(fx[0].spellId, 'fire_bomb');
    log('aoe footprint ok');
}

function testEffectsFromAttackFailedResult() {
    assert.deepStrictEqual(
        effectsFromAttack(null, null, { ok: false, reason: 'mana' }),
        []
    );
    assert.deepStrictEqual(effectsFromAttack(null, null, null), []);
    log('failed result ok');
}

function testHeadlessNoOp() {
    const prev = Settings.HEADLESS;
    Settings.HEADLESS = true;
    try {
        const script = new CombatEffectsScript();
        script.push({
            type: 'death',
            x: 1,
            y: 2,
            color: '#fff'
        });
        assert.strictEqual(script.entries.length, 0);
        script.pushFromAttack(
            { tile: tile(0, 0) },
            { tile: tile(1, 0), alive: false },
            {
                ok: true,
                hit: true,
                spell: { range: 1, isMelee: true, element: 'physical' }
            }
        );
        assert.strictEqual(script.entries.length, 0);
    } finally {
        Settings.HEADLESS = prev;
    }
    log('headless no-op ok');
}

function testWatchQueueAndUpdate() {
    const prev = Settings.HEADLESS;
    Settings.HEADLESS = false;
    try {
        const script = new CombatEffectsScript();
        script.push({
            type: 'projectile',
            x0: 0,
            y0: 0,
            x1: 3,
            y1: 0,
            life: 0.1
        });
        script.push({ type: 'aoe', x: 3, y: 0, radius: 1, life: 0.5 });
        script.push({
            type: 'melee',
            x0: 1,
            y0: 1,
            x1: 2,
            y1: 1,
            sx: 1,
            sy: 1,
            life: 0.05
        });
        assert.strictEqual(script.entries.length, 3);
        assert.strictEqual(script.entries[2].type, 'melee');
        assert.strictEqual(script.entries[2].sx, 1);

        const prevDt = Time.deltaTime;
        Time.deltaTime = 0.12;
        script.update();
        // projectile + melee expired; aoe remains
        assert.strictEqual(script.entries.length, 1);
        assert.strictEqual(script.entries[0].type, 'aoe');
        Time.deltaTime = prevDt;

        script.clear();
        assert.strictEqual(script.entries.length, 0);
    } finally {
        Settings.HEADLESS = prev;
    }
    log('watch queue/update ok');
}

function testSimulatorRecordAttackWiresVfx() {
    const prev = Settings.HEADLESS;
    Settings.HEADLESS = false;
    try {
        const sim = new Simulator({ seed: 1, combatAi: false });
        assert.ok(sim.combatEffects, 'combatEffects script attached');
        assert.ok(
            sim.scripts.indexOf(sim.combatEffects) >= 0,
            'script inserted'
        );

        const attacker = {
            type: 'player',
            tile: tile(10, 10),
            alive: true,
            damageDealt: 0
        };
        const defender = {
            type: 'creature',
            tile: tile(14, 10),
            alive: true,
            expValue: 0,
            lootValue: 0
        };
        sim.recordAttack(attacker, defender, {
            ok: true,
            hit: true,
            final: 5,
            critical: false,
            spell: {
                id: 'ember_bolt',
                element: 'fire',
                range: 4,
                isMelee: false,
                kind: 'spell',
                mana: 0
            }
        });
        assert.ok(
            sim.combatEffects.entries.some((e) => e.type === 'projectile'),
            'projectile queued from recordAttack'
        );

        // Headless must not enqueue
        Settings.HEADLESS = true;
        sim.combatEffects.clear();
        sim.recordAttack(attacker, defender, {
            ok: true,
            hit: true,
            final: 5,
            spell: {
                id: 'ember_bolt',
                element: 'fire',
                range: 4,
                isMelee: false
            }
        });
        assert.strictEqual(sim.combatEffects.entries.length, 0);
        sim.destroy();
    } finally {
        Settings.HEADLESS = prev;
    }
    log('simulator wire ok');
}

function testMaxEntriesCap() {
    const prev = Settings.HEADLESS;
    Settings.HEADLESS = false;
    try {
        const script = new CombatEffectsScript();
        script.maxEntries = 3;
        for (let i = 0; i < 5; i++) {
            script.push({ type: 'death', x: i, y: 0 });
        }
        assert.strictEqual(script.entries.length, 3);
        assert.strictEqual(script.entries[0].x, 2);
        assert.strictEqual(script.entries[2].x, 4);
    } finally {
        Settings.HEADLESS = prev;
    }
    log('max entries ok');
}

function testAmmoProjectileSpriteOnDistanceAuto() {
    const attacker = {
        tile: tile(10, 10),
        type: 'player',
        alive: true,
        combatStats: {
            weaponType: 'distance',
            ammoSprite: 'arrow',
            ammoSpriteGenre: 'rpg_fantasy',
            ammoId: 'arrow'
        }
    };
    const defender = { tile: tile(14, 12), type: 'creature', alive: true };
    const result = {
        ok: true,
        hit: true,
        final: 10,
        spell: {
            id: 'distance_auto',
            element: 'physical',
            range: 6,
            isMelee: false,
            kind: 'auto',
            requiresAmmo: true
        }
    };
    const fx = effectsFromAttack(attacker, defender, result);
    assert.strictEqual(fx.length, 1);
    assert.strictEqual(fx[0].type, 'projectile');
    assert.strictEqual(fx[0].spriteId, 'arrow');
    assert.strictEqual(fx[0].spriteGenre, 'rpg_fantasy');
    assert.strictEqual(fx[0].spriteKind, 'equipment');
    assert.strictEqual(fx[0].spriteScale, PROJECTILE_SPRITE_SCALE);
    assert.strictEqual(fx[0].x0, 10);
    assert.strictEqual(fx[0].y0, 10);
    assert.strictEqual(fx[0].x1, 14);
    assert.strictEqual(fx[0].y1, 12);
    log('ammo projectile sprite on distance_auto ok');
}

function testSpellProjectileOmitsAmmoSprite() {
    const attacker = {
        tile: tile(1, 1),
        type: 'player',
        alive: true,
        combatStats: {
            weaponType: 'distance',
            ammoSprite: 'arrow'
        }
    };
    const defender = { tile: tile(5, 1), type: 'creature', alive: true };
    const result = {
        ok: true,
        hit: true,
        final: 12,
        spell: {
            id: 'ember_bolt',
            element: 'fire',
            range: 4,
            isMelee: false,
            kind: 'spell'
        }
    };
    const fx = effectsFromAttack(attacker, defender, result);
    assert.strictEqual(fx[0].type, 'projectile');
    assert.strictEqual(
        fx[0].spriteId,
        undefined,
        'magic bolts keep abstract streak (no ammo art)'
    );
    log('spell projectile omits ammo sprite ok');
}

function testProjectileRotationCompensatesArtTip() {
    // Art tip at −45° (up-right). Flight right (0°) → rotate +45° (π/4).
    const right = projectileRotation(1, 0);
    assert.ok(
        Math.abs(right - Math.PI / 4) < 1e-9,
        `right flight rot expected π/4, got ${right}`
    );
    // Flight up (−π/2) → rot = −π/2 − (−π/4) = −π/4
    const up = projectileRotation(0, -1);
    assert.ok(
        Math.abs(up - -Math.PI / 4) < 1e-9,
        `up flight rot expected −π/4, got ${up}`
    );
    // Flight down-right: atan2(1,1)=π/4 → rot = π/4 − (−π/4) = π/2
    const downRight = projectileRotation(1, 1);
    assert.ok(
        Math.abs(downRight - Math.PI / 2) < 1e-9,
        `down-right rot expected π/2, got ${downRight}`
    );
    assert.strictEqual(AMMO_ART_TIP_ANGLE, -Math.PI / 4);
    log('projectile rotation ok');
}

function testResolveAmmoSpriteHelpers() {
    assert.strictEqual(
        usesAmmoProjectileSprite({ id: 'distance_auto', requiresAmmo: true }, null),
        true
    );
    assert.strictEqual(
        usesAmmoProjectileSprite({ id: 'ember_bolt', kind: 'spell' }, null),
        false
    );
    const spr = resolveAmmoProjectileSprite(
        {
            combatStats: {
                ammoSprite: 'onyx_arrow',
                ammoSpriteGenre: 'rpg_fantasy'
            }
        },
        { id: 'distance_auto', requiresAmmo: true }
    );
    assert.ok(spr);
    assert.strictEqual(spr.spriteId, 'onyx_arrow');
    assert.strictEqual(spr.spriteKind, 'equipment');
    log('resolve ammo sprite helpers ok');
}

function testPushStoresSpriteFields() {
    const prev = Settings.HEADLESS;
    Settings.HEADLESS = false;
    try {
        const script = new CombatEffectsScript();
        script.push({
            type: 'projectile',
            x0: 0,
            y0: 0,
            x1: 2,
            y1: 1,
            spriteId: 'bolt',
            spriteGenre: 'rpg_fantasy',
            spriteKind: 'equipment',
            spriteScale: 0.8
        });
        assert.strictEqual(script.entries.length, 1);
        assert.strictEqual(script.entries[0].spriteId, 'bolt');
        assert.strictEqual(script.entries[0].spriteGenre, 'rpg_fantasy');
        assert.strictEqual(script.entries[0].spriteScale, 0.8);
    } finally {
        Settings.HEADLESS = prev;
    }
    log('push stores sprite fields ok');
}

function main() {
    testElementColor();
    testEffectsFromAttackRangedProjectile();
    testEffectsFromAttackMeleeAutoSlash();
    testCombatFxFloorCullOnGui();
    testEffectsFromAttackDeathFlash();
    testEffectsFromAttackAoe();
    testEffectsFromAttackFailedResult();
    testHeadlessNoOp();
    testWatchQueueAndUpdate();
    testSimulatorRecordAttackWiresVfx();
    testMaxEntriesCap();
    testAmmoProjectileSpriteOnDistanceAuto();
    testSpellProjectileOmitsAmmoSprite();
    testProjectileRotationCompensatesArtTip();
    testResolveAmmoSpriteHelpers();
    testPushStoresSpriteFields();
    console.log('combat_effects: ok');
}

main();
