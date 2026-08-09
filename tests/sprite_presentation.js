#!/usr/bin/env node
/**
 * Watch-mode cheap sprite dynamics: bob, hit flash/recoil, face target, shadow, rarity aura.
 */

'use strict';

const assert = require('assert');
const { Settings } = require('../kernel/settings.js');
const { Time } = require('../kernel/core/lib/time.js');
const { beginStepVisual, tickStepVisual } = require('../kernel/core/lib/movement.js');
const {
    HIT_FLASH_SEC,
    HIT_RECOIL_SEC,
    RARITY_AURA,
    stepBobOffsetPx,
    beginHitFeedback,
    hitFlashStrength,
    getHitRecoilOffset,
    faceSpriteTowardTarget,
    drawEntityShadow,
    drawSpriteHitFlash,
    resolveEntityRarityTier,
    drawEntityRarityAura,
    drawRectRarityAura,
    clearRarityAuraCache,
    clearSpriteOpaqueFootCache,
    getSpriteOpaqueFoot,
    buildSpriteOpaqueFoot,
    FOOT_BAND_FRAC
} = require('../kernel/core/lib/sprite_presentation.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        console.error(`FAIL ${name}:`, e.message || e);
    }
}

test('stepBobOffsetPx peaks mid-slide and is zero at ends', () => {
    const prevJump = Settings.spriteJumpHeight;
    Settings.spriteJumpHeight = 0.12;
    try {
        const ent = {
            tile: { x: 2, y: 0, z: 0 },
            x: 1,
            y: 0,
            _moveVisDuration: 0,
            _moveVisElapsed: 0
        };
        beginStepVisual(ent, { x: 1, y: 0, z: 0 }, 0.4);
        assert.strictEqual(stepBobOffsetPx(ent, 0, 32), 0, 't=0 no bob');

        // Force mid progress via elapsed
        ent._moveVisElapsed = 0.2;
        const mid = stepBobOffsetPx(ent, 0, 32);
        const expected = -32 * Settings.spriteJumpHeight;
        assert.ok(mid < 0, 'bob lifts sprite (negative Y)');
        assert.ok(
            Math.abs(mid - expected) < 1e-9,
            `mid bob expected ${expected} got ${mid}`
        );

        ent._moveVisElapsed = 0.4;
        assert.strictEqual(stepBobOffsetPx(ent, 0, 32), 0, 't=1 no bob');

        tickStepVisual(ent, 0.001);
        assert.strictEqual(stepBobOffsetPx(ent, 0, 32), 0, 'after land no bob');
    } finally {
        Settings.spriteJumpHeight = prevJump;
    }
});

test('stepBobOffsetPx respects Settings.spriteJumpHeight', () => {
    const prevJump = Settings.spriteJumpHeight;
    Settings.spriteJumpHeight = 0.25;
    try {
        const ent = {
            tile: { x: 2, y: 0, z: 0 },
            x: 1,
            y: 0,
            _moveVisDuration: 0,
            _moveVisElapsed: 0
        };
        beginStepVisual(ent, { x: 1, y: 0, z: 0 }, 0.4);
        ent._moveVisElapsed = 0.2;
        const mid = stepBobOffsetPx(ent, 0, 32);
        assert.ok(Math.abs(mid - -32 * 0.25) < 1e-9, `mid bob at 0.25 got ${mid}`);
    } finally {
        Settings.spriteJumpHeight = prevJump;
    }
});

test('beginHitFeedback sets flash and recoil away from attacker', () => {
    const prevHeadless = Settings.HEADLESS;
    Settings.HEADLESS = false;
    const t0 = Time.timeSinceLevelLoad;
    const def = {
        tile: { x: 5, y: 3, z: 0 },
        spriteFacing: 1
    };
    const atk = { tile: { x: 3, y: 3, z: 0 } };
    beginHitFeedback(def, atk, t0);
    assert.ok(def._hitFlashUntil > t0);
    assert.ok(def._hitRecoilUntil > t0);
    assert.ok(def._hitRecoilDx > 0, 'recoil to the right of attacker');
    assert.ok(Math.abs(def._hitRecoilDy) < 1e-9);

    assert.ok(hitFlashStrength(def, t0) > 0.99);
    assert.strictEqual(hitFlashStrength(def, t0 + HIT_FLASH_SEC), 0);

    const r0 = getHitRecoilOffset(def, t0);
    assert.ok(r0.x > 0);
    const rEnd = getHitRecoilOffset(def, t0 + HIT_RECOIL_SEC);
    assert.strictEqual(rEnd.x, 0);
    assert.strictEqual(rEnd.y, 0);

    Settings.HEADLESS = true;
    const def2 = { tile: { x: 1, y: 1, z: 0 } };
    beginHitFeedback(def2, atk, t0);
    assert.strictEqual(def2._hitFlashUntil, undefined, 'headless no-op');
    Settings.HEADLESS = prevHeadless;
});

test('faceSpriteTowardTarget sets facing; mid-slide keeps step facing', () => {
    const ent = {
        tile: { x: 2, y: 2, z: 0 },
        spriteFacing: 1,
        _moveVisDuration: 0,
        target: { tile: { x: 0, y: 2, z: 0 }, alive: true }
    };
    faceSpriteTowardTarget(ent);
    assert.strictEqual(ent.spriteFacing, -1, 'face left toward target');

    ent.target.tile.x = 4;
    faceSpriteTowardTarget(ent);
    assert.strictEqual(ent.spriteFacing, 1, 'face right toward target');

    ent.spriteFacing = -1;
    ent._moveVisDuration = 0.3;
    ent.target.tile.x = 9;
    faceSpriteTowardTarget(ent);
    assert.strictEqual(ent.spriteFacing, -1, 'mid-slide does not override');

    ent._moveVisDuration = 0;
    ent.target.alive = false;
    ent.spriteFacing = -1;
    faceSpriteTowardTarget(ent);
    assert.strictEqual(ent.spriteFacing, -1, 'dead target ignored');
});

test('drawEntityShadow uses ellipse when available', () => {
    const ops = [];
    const g = {
        save() {
            ops.push('save');
        },
        restore() {
            ops.push('restore');
        },
        beginPath() {
            ops.push('beginPath');
        },
        ellipse(cx, cy, rx, ry) {
            ops.push(['ellipse', cx, cy, rx, ry]);
        },
        fill() {
            ops.push('fill');
        },
        fillRect() {
            ops.push('fillRect');
        },
        globalAlpha: 1,
        fillStyle: ''
    };
    drawEntityShadow(g, 0, 0, 32, 32, 1);
    assert.ok(ops.includes('save'));
    assert.ok(ops.some((o) => Array.isArray(o) && o[0] === 'ellipse'));
    assert.ok(ops.includes('fill'));
    assert.strictEqual(ops[ops.length - 1], 'restore');
    // No img → default just above tile bottom
    const el = ops.find((o) => Array.isArray(o) && o[0] === 'ellipse');
    assert.strictEqual(el[1], 16, 'cx tile center');
    assert.ok(Math.abs(el[2] - (32 - 32 * 0.1)) < 1e-9, 'cy default tile feet');
});

test('combat target shadow fades dark red ↔ bright red', () => {
    const colors = [];
    const g = {
        save() {},
        restore() {},
        beginPath() {},
        ellipse() {},
        fill() {},
        fillRect() {},
        globalAlpha: 1,
        _fs: '',
        get fillStyle() {
            return this._fs;
        },
        set fillStyle(v) {
            this._fs = v;
            colors.push(v);
        },
        shadowBlur: 0,
        shadowColor: '',
        shadowOffsetX: 0,
        shadowOffsetY: 0
    };
    // cos fade: t=0 → bright #ff0000 (TARGET_SHADOW_HZ = 2.5/3)
    drawEntityShadow(g, 0, 0, 32, 32, 1, null, false, {
        combatTargetHighlight: true,
        now: 0
    });
    assert.ok(colors.includes('#ff0000'), 'bright red at t=0');
    colors.length = 0;
    // Half period (1.5 / 2.5 = 0.6s) → dark #aa0000
    drawEntityShadow(g, 0, 0, 32, 32, 1, null, false, {
        combatTargetHighlight: true,
        now: 0.6
    });
    assert.ok(colors.includes('#aa0000'), 'dark red at half period');
    colors.length = 0;
    // Midway (quarter period = 0.3s) should be between the two ends
    drawEntityShadow(g, 0, 0, 32, 32, 1, null, false, {
        combatTargetHighlight: true,
        now: 0.3
    });
    const mid = colors.find((c) => /^#[0-9a-f]{6}$/i.test(c));
    assert.ok(mid, 'mid pulse has hex fill');
    const r = parseInt(mid.slice(1, 3), 16);
    assert.ok(r > 0xaa && r < 0xff, `mid red channel between aa and ff, got ${r}`);
    colors.length = 0;
    // Without highlight stays black only
    drawEntityShadow(g, 0, 0, 32, 32, 1, null, false, { now: 0 });
    assert.ok(colors.includes('#000000'));
    assert.ok(!colors.includes('#ff0000'), 'no red without highlight');
});

/**
 * Minimal OffscreenCanvas stub so opaque-foot scan works in Node tests.
 * Image supplies `_pixels` (RGBA) + natural size.
 */
function withMockCanvas(run) {
    const prevOff = global.OffscreenCanvas;
    const prevDoc = global.document;
    class MockCtx {
        constructor(w, h) {
            this._w = w;
            this._h = h;
            this._data = new Uint8ClampedArray(w * h * 4);
        }
        clearRect() {
            this._data.fill(0);
        }
        drawImage(img) {
            if (img && img._pixels && img._pixels.length === this._data.length) {
                this._data.set(img._pixels);
            }
        }
        getImageData() {
            return {
                data: this._data,
                width: this._w,
                height: this._h
            };
        }
        putImageData() {}
        createImageData(w, h) {
            return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
        }
    }
    global.OffscreenCanvas = class {
        constructor(w, h) {
            this.width = w;
            this.height = h;
            this._ctx = new MockCtx(w, h);
        }
        getContext() {
            return this._ctx;
        }
    };
    try {
        run();
    } finally {
        if (prevOff === undefined) delete global.OffscreenCanvas;
        else global.OffscreenCanvas = prevOff;
        if (prevDoc === undefined) delete global.document;
        else global.document = prevDoc;
    }
}

test('opaque foot scan finds lowest alpha pixels; shadow sits under them', () => {
    clearSpriteOpaqueFootCache();
    withMockCanvas(() => {
        const iw = 8;
        const ih = 8;
        // Transparent padding on bottom 2 rows; solid block on rows 0..5, cols 2..5
        const pixels = new Uint8ClampedArray(iw * ih * 4);
        for (let y = 0; y <= 5; y++) {
            for (let x = 2; x <= 5; x++) {
                const p = (y * iw + x) * 4;
                pixels[p] = 255;
                pixels[p + 1] = 0;
                pixels[p + 2] = 0;
                pixels[p + 3] = 255;
            }
        }
        const img = {
            naturalWidth: iw,
            naturalHeight: ih,
            width: iw,
            height: ih,
            src: 'test://padded-feet.png',
            _pixels: pixels
        };

        const foot = buildSpriteOpaqueFoot(img);
        assert.ok(foot, 'foot metrics built');
        assert.strictEqual(foot.top, 0, 'highest opaque row');
        assert.strictEqual(foot.bottom, 5, 'lowest opaque row');
        // opaqueH=6 → band = round(6*0.33)=2 → rows 4..5, cols 2..5 → mean 3.5
        assert.strictEqual(Math.round(6 * FOOT_BAND_FRAC), 2);
        assert.ok(Math.abs(foot.footCx - 3.5) < 1e-9, `footCx expected 3.5 got ${foot.footCx}`);

        const cached = getSpriteOpaqueFoot(img);
        assert.strictEqual(cached.bottom, 5);

        const ops = [];
        const g = {
            save() {},
            restore() {},
            beginPath() {},
            ellipse(cx, cy, rx, ry) {
                ops.push(['ellipse', cx, cy, rx, ry]);
            },
            fill() {},
            globalAlpha: 1,
            fillStyle: ''
        };
        // scale 1, tile 32 → scaledH=32, image bottom on tile bottom
        // content bottom Y = 0 + ((5+1)/8)*32 = 24; cy = 24 - 32*0.04
        drawEntityShadow(g, 0, 0, 32, 32, 1, img, false);
        assert.strictEqual(ops.length, 1);
        const [, cx, cy] = ops[0];
        const expectedCy = ((5 + 1) / 8) * 32 - 32 * 0.04;
        assert.ok(
            Math.abs(cy - expectedCy) < 1e-6,
            `shadow cy under opaque feet expected ~${expectedCy} got ${cy}`
        );
        // Without scan, default would be 32 - 3.2 = 28.8 (below true feet)
        assert.ok(cy < 32 - 32 * 0.1, 'shadow raised vs image-box feet');
        // foot mass 3.5 → local (3.5+0.5)/8 * 32
        assert.ok(cx > 10 && cx < 22, `foot-centered cx got ${cx}`);
    });
    clearSpriteOpaqueFootCache();
});

test('footCx uses bottom 33% of opaque height, not head mass', () => {
    clearSpriteOpaqueFootCache();
    withMockCanvas(() => {
        const iw = 10;
        const ih = 10;
        const pixels = new Uint8ClampedArray(iw * ih * 4);
        const paint = (x0, x1, y0, y1) => {
            for (let y = y0; y <= y1; y++) {
                for (let x = x0; x <= x1; x++) {
                    const p = (y * iw + x) * 4;
                    pixels[p] = 255;
                    pixels[p + 3] = 255;
                }
            }
        };
        // Opaque span rows 0..8 (opaqueH=9). Bottom 33% → round(9*0.33)=3 → rows 6..8
        // Head (left-heavy): rows 0..5 cols 0..2
        // Feet (right-heavy): rows 6..8 cols 7..9
        paint(0, 2, 0, 5);
        paint(7, 9, 6, 8);

        const img = {
            naturalWidth: iw,
            naturalHeight: ih,
            width: iw,
            height: ih,
            src: 'test://asymmetric-feet.png',
            _pixels: pixels
        };
        const foot = buildSpriteOpaqueFoot(img);
        assert.strictEqual(foot.top, 0);
        assert.strictEqual(foot.bottom, 8);
        // Mean of cols 7,8,9 across band → 8
        assert.ok(
            Math.abs(foot.footCx - 8) < 1e-9,
            `footCx should ignore left head mass, got ${foot.footCx}`
        );
        assert.ok(foot.footCx > 5, 'shadow X pulled toward feet, not head');
    });
    clearSpriteOpaqueFootCache();
});

test('drawSpriteHitFlash paints white rect at strength', () => {
    const ops = [];
    const g = {
        save() {
            ops.push('save');
        },
        restore() {
            ops.push('restore');
        },
        fillRect(x, y, w, h) {
            ops.push(['fillRect', x, y, w, h]);
        },
        globalAlpha: 1,
        fillStyle: ''
    };
    drawSpriteHitFlash(g, { px: 1.2, py: 2.8, scaledW: 20, scaledH: 30 }, 1);
    assert.ok(ops.includes('save'));
    assert.deepStrictEqual(ops[1], ['fillRect', 1, 2, 20, 30]);
    assert.strictEqual(ops[ops.length - 1], 'restore');

    const empty = [];
    const g2 = {
        save() {
            empty.push('save');
        },
        fillRect() {
            empty.push('fill');
        }
    };
    drawSpriteHitFlash(g2, { px: 0, py: 0, scaledW: 1, scaledH: 1 }, 0);
    assert.strictEqual(empty.length, 0);
});

test('resolveEntityRarityTier ranks affixes; skips players and normals', () => {
    assert.strictEqual(resolveEntityRarityTier(null), null);
    assert.strictEqual(resolveEntityRarityTier({}), null);
    assert.strictEqual(resolveEntityRarityTier({ rarity: 'normal' }), null);
    assert.strictEqual(resolveEntityRarityTier({ rarity: 'rare' }), 'rare');
    assert.strictEqual(
        resolveEntityRarityTier({ affixes: ['champion'] }),
        'champion'
    );
    assert.strictEqual(
        resolveEntityRarityTier({ rarity: 'rare', affixes: ['elite'] }),
        'elite',
        'highest rank wins'
    );
    assert.strictEqual(
        resolveEntityRarityTier({ rarity: 'boss', affixes: ['rare'] }),
        'boss'
    );
    assert.strictEqual(
        resolveEntityRarityTier({ type: 'player', rarity: 'boss' }),
        null,
        'players never get mob aura'
    );
    assert.strictEqual(
        resolveEntityRarityTier({ isPlayer: true, affixes: ['elite'] }),
        null
    );
    assert.strictEqual(resolveEntityRarityTier({ isBoss: true }), 'boss');
    assert.ok(RARITY_AURA.rare.color);
    assert.ok(RARITY_AURA.champion.color);
    assert.ok(RARITY_AURA.elite.color);
    assert.ok(RARITY_AURA.boss.color);
});

test('drawEntityRarityAura no-ops without tier; drawRectRarityAura strokes', () => {
    clearRarityAuraCache();
    const ops = [];
    const g = {
        save() {
            ops.push('save');
        },
        restore() {
            ops.push('restore');
        },
        translate() {},
        scale() {},
        drawImage() {
            ops.push('drawImage');
        },
        strokeRect(x, y, w, h) {
            ops.push(['strokeRect', x, y, w, h]);
        },
        globalAlpha: 1,
        shadowColor: '',
        shadowBlur: 0,
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        strokeStyle: '',
        lineWidth: 1
    };
    const layout = { px: 0, py: 0, scaledW: 32, scaledH: 32, scale: 1 };
    const img = { width: 32, height: 32, src: 'test://mob.png' };

    drawEntityRarityAura(g, img, layout, false, null);
    assert.strictEqual(ops.length, 0, 'no tier → no draw');

    drawEntityRarityAura(g, img, layout, false, 'rare');
    // Without browser canvas bake, falls back to shadowBlur drawImage
    assert.ok(ops.includes('save'));
    assert.ok(ops.includes('drawImage'));
    assert.ok(ops.includes('restore'));

    const rectOps = [];
    const g2 = {
        save() {
            rectOps.push('save');
        },
        restore() {
            rectOps.push('restore');
        },
        strokeRect() {
            rectOps.push('stroke');
        },
        globalAlpha: 1,
        strokeStyle: '',
        lineWidth: 1
    };
    drawRectRarityAura(g2, 1, 2, 10, 12, 'elite');
    assert.ok(rectOps.includes('stroke'));
    drawRectRarityAura(g2, 1, 2, 10, 12, null);
    assert.strictEqual(rectOps.filter((o) => o === 'stroke').length, 1);
});

if (failed) {
    console.error(`sprite_presentation: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`sprite_presentation: ${passed} passed`);
