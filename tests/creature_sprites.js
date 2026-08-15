/**
 * Stage 12D — catalog sprite path resolver + ImageDB unit tests.
 * Quiet by default; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const {
    technicalToFileStem,
    idToFileStem,
    genreFolder,
    normalizeVariant,
    rewriteVariantPath,
    resolveFileStem,
    resolveSpriteRelPath,
    resolveSpriteUrl,
    entitySpriteOpts,
    resolveEntitySpriteScale,
    defaultVariantForDisplay,
    defaultTileVariantForDisplay,
    resolveTileVariantForDisplay,
    getSpriteLoadState,
    isSpritePending,
    prefetchHuntSprites,
    getReadySpriteImage,
    getCachedImageSize,
    measureEntitySprite,
    drawEntitySprite,
    SPRITE_VARIANTS
} = require('../kernel/core/lib/creature_sprites.js');
const { ImageDB, isDrawableReady } = require('../kernel/core/lib/imagedb.js');
const { Settings } = require('../kernel/settings.js');

const VERBOSE = process.env.VERBOSE === '1';
const log = (...args) => {
    if (VERBOSE) console.log(...args);
};

let failed = 0;
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        log('ok', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

test('technicalToFileStem and idToFileStem', () => {
    assert.strictEqual(
        technicalToFileStem('Ashen Dwarf Priest'),
        'Ashen_Dwarf_Priest'
    );
    assert.strictEqual(idToFileStem('ashen_dwarf_priest'), 'Ashen_Dwarf_Priest');
    assert.strictEqual(idToFileStem('Obsidian_Dwarf_Warden'), 'Obsidian_Dwarf_Warden');
    // Numbered variants must keep digits (smart update / Gazer 2 → Gazer_2, not Gazer)
    assert.strictEqual(technicalToFileStem('Gazer 2'), 'Gazer_2');
    assert.strictEqual(idToFileStem('gazer_2'), 'Gazer_2');
});

test('genreFolder and normalizeVariant', () => {
    assert.strictEqual(genreFolder('rpg_fantasy'), 'rpg_fantasy');
    assert.strictEqual(genreFolder(undefined), 'rpg_fantasy');
    assert.strictEqual(normalizeVariant('ICON'), 'icon');
    assert.strictEqual(normalizeVariant('transformed'), 'retro');
    assert.strictEqual(normalizeVariant('nope'), 'small');
    assert.ok(SPRITE_VARIANTS.indexOf('small') >= 0);
});

test('rewriteVariantPath swaps variant segment', () => {
    const orig =
        'assets/sprites/rpg_fantasy/creatures/original/Ashen_Dwarf_Priest.png';
    assert.strictEqual(
        rewriteVariantPath(orig, 'small'),
        'assets/sprites/rpg_fantasy/creatures/small/Ashen_Dwarf_Priest.png'
    );
    assert.strictEqual(
        rewriteVariantPath(orig, 'icon'),
        'assets/sprites/rpg_fantasy/creatures/icon/Ashen_Dwarf_Priest.png'
    );
    assert.strictEqual(rewriteVariantPath('', 'small'), null);
});

test('resolveSpriteRelPath from id + genre', () => {
    const rel = resolveSpriteRelPath({
        genre: 'rpg_fantasy',
        id: 'ashen_dwarf_priest',
        variant: 'small'
    });
    assert.strictEqual(
        rel,
        'assets/sprites/rpg_fantasy/creatures/small/Ashen_Dwarf_Priest.png'
    );
});

test('resolveSpriteRelPath prefers sprites bag rewrite', () => {
    const rel = resolveSpriteRelPath({
        genre: 'steampunk',
        id: 'ignored_id',
        sprites: {
            original:
                'assets/sprites/rpg_fantasy/creatures/original/Ashen_Dwarf_Priest.png'
        },
        variant: 'medium'
    });
    assert.strictEqual(
        rel,
        'assets/sprites/rpg_fantasy/creatures/medium/Ashen_Dwarf_Priest.png'
    );
});

test('resolveSpriteRelPath uses explicit variant path when present', () => {
    const rel = resolveSpriteRelPath({
        sprites: {
            original: 'assets/sprites/x/creatures/original/A.png',
            small: 'assets/sprites/x/creatures/small/Custom.png'
        },
        variant: 'small'
    });
    assert.strictEqual(rel, 'assets/sprites/x/creatures/small/Custom.png');
});

test('resolveSpriteRelPath uses ported sprite.legacy GIF path', () => {
    const gif = 'assets/legacy/monsters/images/frazzlemaw.gif';
    assert.strictEqual(
        resolveSpriteRelPath({
            id: 'frazzlemaw',
            genre: 'rpg_fantasy',
            variant: 'small',
            sprite: { legacy: gif }
        }),
        gif
    );
    assert.strictEqual(
        resolveSpriteRelPath({
            id: 'frazzlemaw',
            sprites: { legacy: gif },
            variant: 'icon'
        }),
        gif
    );
    // Catalog original still wins over legacy when both present
    assert.strictEqual(
        resolveSpriteRelPath({
            sprites: {
                original:
                    'assets/sprites/rpg_fantasy/creatures/original/Frazzlemaw.png',
                legacy: gif
            },
            variant: 'small'
        }),
        'assets/sprites/rpg_fantasy/creatures/small/Frazzlemaw.png'
    );
});

test('resolveSpriteRelPath from technical', () => {
    const rel = resolveSpriteRelPath({
        genre: 'rpg_fantasy',
        technical: 'Obsidian Dwarf Warden',
        variant: 'icon'
    });
    assert.strictEqual(
        rel,
        'assets/sprites/rpg_fantasy/creatures/icon/Obsidian_Dwarf_Warden.png'
    );
});

test('resolveSpriteRelPath returns null without identity', () => {
    assert.strictEqual(resolveSpriteRelPath({ genre: 'rpg_fantasy' }), null);
    assert.strictEqual(resolveFileStem({}), null);
});

test('resolveSpriteUrl is root-relative via appUrl', () => {
    const url = resolveSpriteUrl({
        genre: 'rpg_fantasy',
        id: 'ashen_dwarf_priest',
        variant: 'small'
    });
    assert.strictEqual(
        url,
        '/assets/sprites/rpg_fantasy/creatures/small/Ashen_Dwarf_Priest.png'
    );
});

test('entitySpriteOpts maps creature fields', () => {
    const opts = entitySpriteOpts(
        {
            creatureType: 'ashen_dwarf_priest',
            genre: 'rpg_fantasy',
            technical: 'Ashen Dwarf Priest',
            sprites: {
                original:
                    'assets/sprites/rpg_fantasy/creatures/original/Ashen_Dwarf_Priest.png'
            }
        },
        { variant: 'small' }
    );
    assert.strictEqual(opts.id, 'ashen_dwarf_priest');
    assert.strictEqual(opts.genre, 'rpg_fantasy');
    assert.strictEqual(opts.variant, 'small');
    assert.ok(opts.sprites);
});

test('entitySpriteOpts merges singular sprite.legacy', () => {
    const opts = entitySpriteOpts({
        creatureType: 'frazzlemaw',
        sprite: {
            legacy: 'assets/legacy/monsters/images/frazzlemaw.gif'
        }
    });
    assert.strictEqual(
        opts.sprites && opts.sprites.legacy,
        'assets/legacy/monsters/images/frazzlemaw.gif'
    );
    assert.strictEqual(
        resolveSpriteRelPath(opts),
        'assets/legacy/monsters/images/frazzlemaw.gif'
    );
});

test('ImageDB register/get and isReady', () => {
    ImageDB.clear();
    const mock = { complete: true, naturalWidth: 64, naturalHeight: 64 };
    ImageDB.register('test://sprite', mock);
    assert.strictEqual(ImageDB.get('test://sprite'), mock);
    assert.strictEqual(ImageDB.isReady('test://sprite'), true);
    assert.strictEqual(isDrawableReady(mock), true);
    assert.strictEqual(isDrawableReady({ complete: false, naturalWidth: 0 }), false);
    ImageDB.clear();
    assert.strictEqual(ImageDB.get('test://sprite'), null);
});

test('getReadySpriteImage respects HEADLESS and useEntitySprites', () => {
    ImageDB.clear();
    const prevHeadless = Settings.HEADLESS;
    const prevSprites = Settings.useEntitySprites;
    try {
        Settings.HEADLESS = true;
        Settings.useEntitySprites = true;
        assert.strictEqual(
            getReadySpriteImage({ id: 'ashen_dwarf_priest', genre: 'rpg_fantasy' }),
            null
        );

        Settings.HEADLESS = false;
        Settings.useEntitySprites = false;
        ImageDB.register(
            '/assets/sprites/rpg_fantasy/creatures/small/Ashen_Dwarf_Priest.png',
            { complete: true, naturalWidth: 64, width: 64, height: 64 }
        );
        assert.strictEqual(
            getReadySpriteImage({
                id: 'ashen_dwarf_priest',
                genre: 'rpg_fantasy',
                variant: 'small'
            }),
            null
        );

        Settings.useEntitySprites = true;
        const img = getReadySpriteImage({
            id: 'ashen_dwarf_priest',
            genre: 'rpg_fantasy',
            variant: 'small'
        });
        assert.ok(img);
        assert.strictEqual(img.naturalWidth, 64);
    } finally {
        Settings.HEADLESS = prevHeadless;
        Settings.useEntitySprites = prevSprites;
        ImageDB.clear();
    }
});

test('prefetchHuntSprites no-ops when HEADLESS', () => {
    const prev = Settings.HEADLESS;
    try {
        Settings.HEADLESS = true;
        const urls = prefetchHuntSprites({
            genre: 'rpg_fantasy',
            creatureIds: ['ashen_dwarf_priest'],
            spawns: [{ creatureId: 'obsidian_dwarf_warden' }]
        });
        assert.deepStrictEqual(urls, []);
    } finally {
        Settings.HEADLESS = prev;
    }
});

test('applyTemplate copies sprite meta onto creature', () => {
    const { Creature } = require('../kernel/core/entities/creature.js');
    const c = new Creature({ name: 'Mob' });
    c.applyTemplate({
        id: 'ashen_dwarf_priest',
        label: 'Dwarf Priest',
        genre: 'rpg_fantasy',
        technical: 'Ashen Dwarf Priest',
        sprites: {
            original:
                'assets/sprites/rpg_fantasy/creatures/original/Ashen_Dwarf_Priest.png'
        },
        hp: 100,
        hpMax: 100
    });
    assert.strictEqual(c.creatureType, 'ashen_dwarf_priest');
    assert.strictEqual(c.genre, 'rpg_fantasy');
    assert.ok(c.sprites && c.sprites.original);

    const leg = new Creature({ name: 'LegacyMob' });
    leg.applyTemplate({
        id: 'frazzlemaw',
        label: 'Frazzlemaw',
        source: 'legacy',
        sprite: {
            legacy: 'assets/legacy/monsters/images/frazzlemaw.gif'
        },
        hp: 50,
        hpMax: 50
    });
    assert.strictEqual(
        leg.sprite && leg.sprite.legacy,
        'assets/legacy/monsters/images/frazzlemaw.gif'
    );
    assert.strictEqual(
        resolveSpriteRelPath(entitySpriteOpts(leg)),
        'assets/legacy/monsters/images/frazzlemaw.gif'
    );
    assert.strictEqual(c.technical, 'Ashen Dwarf Priest');
    assert.ok(c.sprites && c.sprites.original);
    assert.strictEqual(c.hp.max, 100);
});

test('customSprite overrides art id and ignores legacy sprite bag', () => {
    const { Creature } = require('../kernel/core/entities/creature.js');
    const c = new Creature({ name: 'MissingArt' });
    c.applyTemplate({
        id: 'no_sprite_creature',
        label: 'No Sprite',
        genre: 'rpg_fantasy',
        customSprite: 'ashen_dwarf_priest',
        sprite: {
            legacy: 'assets/legacy/monsters/images/cave rat.gif'
        },
        hp: 10,
        hpMax: 10
    });
    assert.strictEqual(c.creatureType, 'no_sprite_creature');
    assert.strictEqual(c.spriteId, 'ashen_dwarf_priest');
    const opts = entitySpriteOpts(c, { variant: 'alpha' });
    assert.strictEqual(opts.id, 'ashen_dwarf_priest');
    assert.strictEqual(opts.sprites, null);
    assert.strictEqual(
        resolveSpriteRelPath(opts),
        'assets/sprites/rpg_fantasy/creatures/alpha/Ashen_Dwarf_Priest.png'
    );
});

test('customSpriteGenre wins over hunt genre for custom sprite path', () => {
    const { Creature } = require('../kernel/core/entities/creature.js');
    const c = new Creature({ name: 'CrossGenre' });
    c.applyTemplate({
        id: 'no_sprite_creature',
        label: 'No Sprite',
        customSpriteGenre: 'steampunk',
        customSprite: 'ashen_dwarf_priest',
        hp: 10,
        hpMax: 10
    });
    assert.strictEqual(c.spriteId, 'ashen_dwarf_priest');
    assert.strictEqual(c.spriteGenre, 'steampunk');
    // Hunt/scene genre must not override customSpriteGenre
    const opts = entitySpriteOpts(c, {
        genre: 'rpg_fantasy',
        variant: 'alpha'
    });
    assert.strictEqual(opts.id, 'ashen_dwarf_priest');
    assert.strictEqual(opts.genre, 'steampunk');
    assert.strictEqual(
        resolveSpriteRelPath(opts),
        'assets/sprites/steampunk/creatures/alpha/Ashen_Dwarf_Priest.png'
    );
});

test('player art: customSprite wins over vocation baseSprite', () => {
    const {
        resolvePlayerSpriteArt,
        memberFromPlayerProfile
    } = require('../kernel/core/lib/character/player_profile.js');
    const { Player } = require('../kernel/core/entities/player.js');

    const classDef = {
        id: 'guardian',
        baseSprite: 'crystal_lizard_warrior',
        baseSpriteGenre: 'rpg_fantasy'
    };
    // No profile art → vocation base
    const fromClass = resolvePlayerSpriteArt(
        { classId: 'guardian' },
        classDef
    );
    assert.strictEqual(fromClass.spriteId, 'crystal_lizard_warrior');
    assert.strictEqual(fromClass.spriteGenre, 'rpg_fantasy');

    // Profile customSprite wins
    const profile = {
        id: 'hero',
        vocation: 'guardian',
        customSprite: 'ashen_dwarf_priest',
        customSpriteGenre: 'steampunk'
    };
    const member = memberFromPlayerProfile(profile, { isLeader: true });
    assert.strictEqual(member.customSprite, 'ashen_dwarf_priest');
    assert.strictEqual(member.spriteId, 'ashen_dwarf_priest');
    const fromProfile = resolvePlayerSpriteArt(member, classDef);
    assert.strictEqual(fromProfile.spriteId, 'ashen_dwarf_priest');
    assert.strictEqual(fromProfile.spriteGenre, 'steampunk');

    // None → null (polygon fallback)
    assert.deepStrictEqual(
        resolvePlayerSpriteArt({ classId: 'guardian' }, { id: 'guardian' }),
        { spriteId: null, spriteGenre: null }
    );

    // Entity opts use spriteId when set (Player constructor)
    const p = new Player({
        name: 'Tank',
        classId: 'guardian',
        spriteId: fromProfile.spriteId,
        spriteGenre: fromProfile.spriteGenre
    });
    const opts = entitySpriteOpts(p, {
        genre: 'rpg_fantasy',
        variant: 'alpha'
    });
    assert.strictEqual(opts.id, 'ashen_dwarf_priest');
    assert.strictEqual(opts.genre, 'steampunk');
    assert.strictEqual(
        resolveSpriteRelPath(opts),
        'assets/sprites/steampunk/creatures/alpha/Ashen_Dwarf_Priest.png'
    );
});

test('getCachedImageSize caches natural size on the drawable', () => {
    const img = {
        naturalWidth: 64,
        naturalHeight: 96,
        width: 64,
        height: 96
    };
    const a = getCachedImageSize(img);
    assert.deepStrictEqual(a, { iw: 64, ih: 96 });
    assert.strictEqual(img._spriteIw, 64);
    assert.strictEqual(img._spriteIh, 96);
    // Corrupt live fields; cache must still win
    img.naturalWidth = 0;
    img.naturalHeight = 0;
    img.width = 0;
    img.height = 0;
    const b = getCachedImageSize(img);
    assert.deepStrictEqual(b, { iw: 64, ih: 96 });
});

test('getReadySpriteImage falls back to icon after small 404', () => {
    ImageDB.clear();
    const prevHeadless = Settings.HEADLESS;
    const prevSprites = Settings.useEntitySprites;
    try {
        Settings.HEADLESS = false;
        Settings.useEntitySprites = true;
        const smallUrl = resolveSpriteUrl({
            id: 'stone_wall_pole',
            kind: 'objects',
            genre: 'rpg_fantasy',
            variant: 'small'
        });
        const iconUrl = resolveSpriteUrl({
            id: 'stone_wall_pole',
            kind: 'objects',
            genre: 'rpg_fantasy',
            variant: 'icon'
        });
        ImageDB.failed[smallUrl] = true;
        ImageDB.register(iconUrl, {
            complete: true,
            naturalWidth: 32,
            width: 32,
            height: 32
        });
        const img = getReadySpriteImage({
            id: 'stone_wall_pole',
            kind: 'objects',
            genre: 'rpg_fantasy',
            variant: 'small'
        });
        assert.ok(img, 'icon fallback must resolve');
        assert.strictEqual(img.naturalWidth, 32);
        assert.strictEqual(
            getSpriteLoadState({
                id: 'stone_wall_pole',
                kind: 'objects',
                genre: 'rpg_fantasy',
                variant: 'small'
            }),
            'ready'
        );
        ImageDB.clear();
        ImageDB.failed[smallUrl] = true;
        ImageDB.failed[iconUrl] = true;
        const origUrl = resolveSpriteUrl({
            id: 'stone_wall_pole',
            kind: 'objects',
            genre: 'rpg_fantasy',
            variant: 'original'
        });
        ImageDB.failed[origUrl] = true;
        assert.strictEqual(
            getSpriteLoadState({
                id: 'stone_wall_pole',
                kind: 'objects',
                genre: 'rpg_fantasy',
                variant: 'small'
            }),
            'failed'
        );
        assert.strictEqual(
            isSpritePending({
                id: 'stone_wall_pole',
                kind: 'objects',
                genre: 'rpg_fantasy',
                variant: 'small'
            }),
            false,
            'failed is not pending'
        );
    } finally {
        Settings.HEADLESS = prevHeadless;
        Settings.useEntitySprites = prevSprites;
        ImageDB.clear();
    }
});

test('resolveTileVariantForDisplay prefers role then size default', () => {
    const prevTw = Settings.tileWidth;
    const prevVar = Settings.tileSpriteVariant;
    try {
        Settings.tileSpriteVariant = null;
        Settings.tileWidth = 32;
        assert.strictEqual(resolveTileVariantForDisplay(null), 'icon');
        assert.strictEqual(resolveTileVariantForDisplay('small'), 'small');
        Settings.tileSpriteVariant = 'retro';
        assert.strictEqual(resolveTileVariantForDisplay('small'), 'retro');
    } finally {
        Settings.tileWidth = prevTw;
        Settings.tileSpriteVariant = prevVar;
    }
});

test('defaultTileVariantForDisplay uses icon at 32px tiles', () => {
    const prevTw = Settings.tileWidth;
    const prevVar = Settings.tileSpriteVariant;
    try {
        Settings.tileSpriteVariant = null;
        Settings.tileWidth = 32;
        assert.strictEqual(defaultTileVariantForDisplay(), 'icon');
        Settings.tileWidth = 48;
        assert.strictEqual(defaultTileVariantForDisplay(), 'small');
    } finally {
        Settings.tileWidth = prevTw;
        Settings.tileSpriteVariant = prevVar;
    }
});

test('defaultVariantForDisplay uses small at 32px tiles', () => {
    const prevTw = Settings.tileWidth;
    const prevVar = Settings.entitySpriteVariant;
    Settings.tileWidth = 32;
    Settings.entitySpriteVariant = null;
    assert.strictEqual(defaultVariantForDisplay(), 'small');
    Settings.tileWidth = 16;
    assert.strictEqual(defaultVariantForDisplay(), 'icon');
    Settings.tileWidth = prevTw;
    Settings.entitySpriteVariant = prevVar;
});

test('resolveEntitySpriteScale: base 1×, affix up to max, override', () => {
    const prevBase = Settings.entitySpriteScale;
    const prevMax = Settings.entitySpriteScaleMax;
    const prevTable = Settings.entitySpriteScaleByAffix;
    Settings.entitySpriteScale = 1;
    Settings.entitySpriteScaleMax = 2;
    Settings.entitySpriteScaleByAffix = {
        rare: 1.15,
        champion: 1.35,
        elite: 1.6,
        boss: 2
    };
    assert.strictEqual(resolveEntitySpriteScale(null), 1);
    assert.strictEqual(resolveEntitySpriteScale({}), 1);
    assert.strictEqual(
        resolveEntitySpriteScale({ rarity: 'rare' }),
        1.15
    );
    assert.strictEqual(
        resolveEntitySpriteScale({ affixes: ['champion'] }),
        1.35
    );
    // Highest affix wins
    assert.strictEqual(
        resolveEntitySpriteScale({
            rarity: 'rare',
            affixes: ['elite', 'champion']
        }),
        1.6
    );
    assert.strictEqual(
        resolveEntitySpriteScale({ rarity: 'boss' }),
        2
    );
    // Explicit override (still clamped to max)
    assert.strictEqual(
        resolveEntitySpriteScale({ spriteScale: 1.8 }),
        1.8
    );
    assert.strictEqual(
        resolveEntitySpriteScale({ spriteScale: 9, rarity: 'boss' }),
        2
    );
    // displayScale multiplies role/affix; cap scales with species size
    assert.strictEqual(
        resolveEntitySpriteScale({ displayScale: 1.5 }),
        1.5
    );
    assert.strictEqual(
        resolveEntitySpriteScale({ displayScale: 1.5, rarity: 'elite' }),
        1.5 * 1.6
    );
    assert.strictEqual(
        resolveEntitySpriteScale({ displayScale: 1.5, rarity: 'boss' }),
        3
    );
    assert.strictEqual(
        resolveEntitySpriteScale({
            displayScale: 1.5,
            spriteScale: 9
        }),
        3
    );
    Settings.entitySpriteScale = prevBase;
    Settings.entitySpriteScaleMax = prevMax;
    Settings.entitySpriteScaleByAffix = prevTable;
});

test('applyTemplate copies displayScale onto creature', () => {
    const { Creature } = require('../kernel/core/entities/creature.js');
    const c = new Creature({ name: 'Big' });
    assert.strictEqual(c.displayScale, 1);
    c.applyTemplate({
        id: 'dragon_lord',
        label: 'Dragon Lord',
        displayScale: 1.75,
        hp: 100,
        hpMax: 100
    });
    assert.strictEqual(c.displayScale, 1.75);
    assert.strictEqual(
        resolveEntitySpriteScale({
            displayScale: c.displayScale,
            rarity: 'elite'
        }),
        1.75 * 1.6
    );
});

test('measureEntitySprite bottom-centers with scale', () => {
    const img = { naturalWidth: 64, naturalHeight: 64, width: 64, height: 64 };
    const tw = 32;
    const th = 32;
    const tilePxX = 100;
    const tilePxY = 200;
    const layout1 = measureEntitySprite(img, tilePxX, tilePxY, tw, th, 1);
    assert.ok(layout1);
    assert.strictEqual(layout1.scaledH, th);
    assert.strictEqual(layout1.scaledW, tw);
    assert.strictEqual(layout1.py, tilePxY);
    assert.ok(
        Math.abs(layout1.px + layout1.scaledW / 2 - (tilePxX + tw / 2)) < 1e-9
    );

    const layout2 = measureEntitySprite(img, tilePxX, tilePxY, tw, th, 2);
    assert.ok(layout2);
    assert.strictEqual(layout2.scaledH, th * 2);
    assert.strictEqual(layout2.bottomY, tilePxY + th);
    // Feet still on tile bottom; top extends above tile
    assert.strictEqual(layout2.py, tilePxY + th - layout2.scaledH);
    assert.ok(layout2.topY < tilePxY);
});

test('drawEntitySprite returns layout and draws at measured position', () => {
    const img = { naturalWidth: 64, naturalHeight: 64, width: 64, height: 64 };
    const calls = [];
    const g = {
        drawImage(i, x, y, w, h) {
            calls.push({ i, x, y, w, h });
        }
    };
    const tw = 32;
    const th = 32;
    const layout = drawEntitySprite(g, img, 0, 0, tw, th, 1);
    assert.ok(layout);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].x, Math.floor(layout.px));
    assert.strictEqual(calls[0].y, Math.floor(layout.py));
    assert.strictEqual(calls[0].w, layout.scaledW);
    assert.strictEqual(calls[0].h, layout.scaledH);
    // Bottom-aligned at 1×: py + scaledH === th
    assert.strictEqual(layout.py + layout.scaledH, th);
    assert.ok(Math.abs(layout.px + layout.scaledW / 2 - tw / 2) < 1e-9);
});

test('drawEntitySprite flipH mirrors around sprite center', () => {
    const img = { naturalWidth: 64, naturalHeight: 64, width: 64, height: 64 };
    const ops = [];
    const g = {
        save() {
            ops.push('save');
        },
        restore() {
            ops.push('restore');
        },
        translate(x, y) {
            ops.push(['translate', x, y]);
        },
        scale(x, y) {
            ops.push(['scale', x, y]);
        },
        drawImage(i, x, y, w, h) {
            ops.push(['drawImage', x, y, w, h]);
        }
    };
    const layout = drawEntitySprite(g, img, 0, 0, 32, 32, 1, true);
    assert.ok(layout);
    assert.strictEqual(ops[0], 'save');
    assert.deepStrictEqual(ops[1], [
        'translate',
        Math.floor(layout.px) + layout.scaledW / 2,
        0
    ]);
    assert.deepStrictEqual(ops[2], ['scale', -1, 1]);
    assert.ok(ops.some((o) => Array.isArray(o) && o[0] === 'drawImage'));
    assert.strictEqual(ops[ops.length - 1], 'restore');

    // No flip → plain drawImage only
    const plain = [];
    const g2 = {
        drawImage(i, x, y, w, h) {
            plain.push({ x, y, w, h });
        },
        save() {
            plain.push('save');
        }
    };
    drawEntitySprite(g2, img, 0, 0, 32, 32, 1, false);
    assert.strictEqual(plain.length, 1);
    assert.ok(typeof plain[0] === 'object' && plain[0].w != null);
});

if (failed) {
    console.error(`creature_sprites: ${failed} failed, ${passed} passed`);
    process.exit(1);
}
console.log(`creature_sprites: ok (${passed})`);
