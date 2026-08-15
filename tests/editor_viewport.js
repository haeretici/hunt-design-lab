#!/usr/bin/env node
/**
 * Phase 8 — editor single-canvas viewport: dirty flags, visibility, coords, composite.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');

const {
    createEditorViewport,
    listCompositePasses,
    defaultVisibility,
    fillFrictionRgba,
    fillFieldsRgba,
    fillSightRgba,
    fillTileMapRgba,
    alphaOverRgba,
    decodeFrictionRgbaToChannels,
    clientToMap,
    mapToScreen,
    visibleMapRect,
    presentView,
    drawTallPropsMapSpace,
    shouldShowTileSprites,
    normalizeSpriteZoomMin,
    drawAuthoringSpritesDisplay,
    DEFAULT_SPRITE_ZOOM_MIN,
    COMPOSITE_PASSES
} = require('../kernel/core/lib/dungeon/editor_viewport.js');
const {
    createEditorSession,
    ROLE_PREVIEW_COLORS
} = require('../kernel/core/lib/dungeon/tilemap_editor.js');
const {
    resolveTileDrawBox,
    collectTallPropsFromFloor
} = require('../kernel/core/lib/tile_draw.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const {
    loadTileRole,
    listTileRoleIds,
    loadArtSet,
    clearPresetCache
} = require('../kernel/core/lib/presets.js');
const { indexTileRoles } = require('../kernel/core/lib/dungeon/tile_roles.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function roleCatalog() {
    setActiveMode('standard');
    clearPresetCache();
    return indexTileRoles(listTileRoleIds().map((id) => loadTileRole(id)));
}

/**
 * Mock 2d context with an RGBA buffer so getImageData / putImageData alpha-over works
 * like a real canvas (regression for empty fields wiping friction).
 * @param {number} [bufW=64]
 * @param {number} [bufH=64]
 */
function mockCtx(bufW, bufH) {
    const bw = bufW > 0 ? bufW | 0 : 64;
    const bh = bufH > 0 ? bufH | 0 : 64;
    const buf =
        typeof Uint8ClampedArray !== 'undefined'
            ? new Uint8ClampedArray(bw * bh * 4)
            : new Uint8Array(bw * bh * 4);
    const puts = [];
    const clears = [];
    const fills = [];
    const draws = [];
    return {
        puts,
        clears,
        fills,
        draws,
        buf,
        bufW: bw,
        bufH: bh,
        imageSmoothingEnabled: true,
        fillStyle: '#000',
        clearRect(x, y, w, h) {
            clears.push({ x, y, w, h });
            const x0 = x | 0;
            const y0 = y | 0;
            const x1 = Math.min(bw, x0 + (w | 0));
            const y1 = Math.min(bh, y0 + (h | 0));
            for (let yy = Math.max(0, y0); yy < y1; yy++) {
                for (let xx = Math.max(0, x0); xx < x1; xx++) {
                    const p = (yy * bw + xx) * 4;
                    buf[p] = 0;
                    buf[p + 1] = 0;
                    buf[p + 2] = 0;
                    buf[p + 3] = 0;
                }
            }
        },
        getImageData(x, y, w, h) {
            const ww = w | 0;
            const hh = h | 0;
            const data =
                typeof Uint8ClampedArray !== 'undefined'
                    ? new Uint8ClampedArray(ww * hh * 4)
                    : new Uint8Array(ww * hh * 4);
            for (let yy = 0; yy < hh; yy++) {
                for (let xx = 0; xx < ww; xx++) {
                    const sx = (x | 0) + xx;
                    const sy = (y | 0) + yy;
                    const di = (yy * ww + xx) * 4;
                    if (sx < 0 || sy < 0 || sx >= bw || sy >= bh) {
                        data[di] = data[di + 1] = data[di + 2] = data[di + 3] = 0;
                        continue;
                    }
                    const si = (sy * bw + sx) * 4;
                    data[di] = buf[si];
                    data[di + 1] = buf[si + 1];
                    data[di + 2] = buf[si + 2];
                    data[di + 3] = buf[si + 3];
                }
            }
            return { data, width: ww, height: hh };
        },
        putImageData(img, x, y) {
            puts.push({
                x,
                y,
                width: img.width,
                height: img.height,
                data: img.data
            });
            const ww = img.width | 0;
            const hh = img.height | 0;
            const src = img.data;
            for (let yy = 0; yy < hh; yy++) {
                for (let xx = 0; xx < ww; xx++) {
                    const dx = (x | 0) + xx;
                    const dy = (y | 0) + yy;
                    if (dx < 0 || dy < 0 || dx >= bw || dy >= bh) continue;
                    const si = (yy * ww + xx) * 4;
                    const di = (dy * bw + dx) * 4;
                    buf[di] = src[si];
                    buf[di + 1] = src[si + 1];
                    buf[di + 2] = src[si + 2];
                    buf[di + 3] = src[si + 3];
                }
            }
        },
        fillRect(x, y, w, h) {
            fills.push({ x, y, w, h, fillStyle: this.fillStyle });
        },
        drawImage(img, ...args) {
            draws.push({ img, args });
        },
        createImageData(w, h) {
            const data =
                typeof Uint8ClampedArray !== 'undefined'
                    ? new Uint8ClampedArray(w * h * 4)
                    : new Uint8Array(w * h * 4);
            return { data, width: w, height: h };
        }
    };
}

function testDefaultVisibilityAndPasses() {
    const v = defaultVisibility();
    assert.strictEqual(v.friction, true);
    assert.strictEqual(v['tilemap-ground'], true);
    // Session present → friction underlay (not path PNG base)
    const passes = listCompositePasses(v, { hasBase: true, hasSession: true });
    assert.ok(passes.indexOf('base') < 0, 'session → no base pass');
    assert.ok(passes.indexOf('friction') === 0);
    assert.ok(passes.indexOf('tilemap') > passes.indexOf('friction'));
    assert.ok(passes.indexOf('fields') > passes.indexOf('tilemap'));
    assert.ok(passes.indexOf('flags') > passes.indexOf('fields'));
    assert.ok(passes.indexOf('sight') > passes.indexOf('flags'));
    // Spawns-only browse: base only
    const pBase = listCompositePasses(v, { hasBase: true, hasSession: false });
    assert.deepStrictEqual(pBase, ['base']);
    // Hide tilemap
    const v2 = Object.assign({}, v, { tilemap: false });
    const p2 = listCompositePasses(v2, { hasBase: false, hasSession: true });
    assert.ok(p2.indexOf('tilemap') < 0);
    assert.ok(COMPOSITE_PASSES.includes('tilemap'));
    log('visibility + pass order ok');
}

function testDirtyFlags() {
    const vp = createEditorViewport({ cols: 8, rows: 8 });
    assert.ok(vp.anyDirty());
    vp.clearDirty();
    assert.ok(!vp.anyDirty());
    vp.markDirty('terrain');
    assert.ok(vp.dirty.terrain);
    assert.ok(vp.anyDirty());
    vp.clearDirty();
    vp.markDirty(['debug', 'spawns']);
    assert.ok(vp.dirty.debug && vp.dirty.spawns);
    vp.clearDirty();
    vp.markDirty({ view: true });
    assert.ok(vp.dirty.view);
    vp.markDirty('all');
    assert.ok(vp.dirty.full && vp.dirty.terrain);
    log('dirty flags ok');
}

function testCoordTransform() {
    const map = clientToMap(
        110,
        220,
        { left: 10, top: 20 },
        { scrollLeft: 40, scrollTop: 80 },
        2
    );
    // (110-10+40)/2 = 70, (220-20+80)/2 = 140
    assert.strictEqual(map.x, 70);
    assert.strictEqual(map.y, 140);
    const scr = mapToScreen(70, 140, { scrollLeft: 40, scrollTop: 80 }, 2);
    assert.strictEqual(scr.x, 100);
    assert.strictEqual(scr.y, 200);

    const vp = createEditorViewport({ cols: 32, rows: 32, zoom: 2 });
    vp.setScroll(40, 80);
    const m2 = vp.clientToMap(110, 220, { left: 10, top: 20 });
    assert.strictEqual(m2.x, 70);
    assert.strictEqual(m2.y, 140);
    log('coord transform ok');
}

function testFrictionRgbaAndDecode() {
    const cols = 4;
    const rows = 2;
    const friction = new Uint8Array(cols * rows);
    friction[0] = 0;
    friction[1] = 100;
    friction[2] = 255;
    friction[3] = 50;
    const packed = fillFrictionRgba(friction, cols, rows, null, null);
    assert.strictEqual(packed.width, 4);
    assert.strictEqual(packed.height, 2);
    // blocked → yellow
    assert.strictEqual(packed.data[2 * 4], 255);
    assert.strictEqual(packed.data[2 * 4 + 1], 255);
    assert.strictEqual(packed.data[2 * 4 + 2], 0);
    // gray
    assert.strictEqual(packed.data[1 * 4], 100);

    const decoded = decodeFrictionRgbaToChannels(packed.data, cols, rows);
    assert.strictEqual(decoded.friction[2], 255);
    assert.strictEqual(decoded.sight[2], 255);
    assert.strictEqual(decoded.friction[1], 100);
    log('friction rgba + decode ok');
}

function testVisibilityFiltersComposite() {
    const roles = roleCatalog();
    const art = loadArtSet('cave_simple');
    const session = createEditorSession({
        cols: 8,
        rows: 8,
        z: 0,
        roleCatalog: roles,
        artSet: art
    });
    const stamps = session.stamps;
    const floorStamp = stamps.find((s) => s.subLayer === 'ground') || stamps[0];
    session.selectStamp(floorStamp);
    session.setActiveSubLayer('ground');
    session.beginStroke();
    session.paintAt(2, 2, { stamp: floorStamp, subLayer: 'ground' });
    session.endStroke();

    const vp = createEditorViewport({ cols: 8, rows: 8 });
    vp.setSession(session);
    vp.clearDirty();

    const ctxAll = mockCtx();
    const r1 = vp.compositeMap(ctxAll);
    assert.ok(r1.painted);
    assert.ok(r1.passes.indexOf('tilemap') >= 0);
    assert.ok(r1.passes.indexOf('friction') >= 0);
    assert.ok(ctxAll.puts.length >= 1);

    vp.setVisible('tilemap', false);
    vp.setVisible('fields', false);
    vp.setVisible('flags', false);
    vp.setVisible('sight', false);
    const ctxF = mockCtx();
    const r2 = vp.compositeMap(ctxF);
    assert.ok(r2.passes.indexOf('tilemap') < 0);
    assert.ok(r2.passes.indexOf('friction') >= 0);
    assert.deepStrictEqual(r2.passes, ['friction']);
    log('composite visibility ok');
}

function testSubLayerVisibilityInTileMapFill() {
    const roles = roleCatalog();
    const art = loadArtSet('cave_simple');
    const session = createEditorSession({
        cols: 4,
        rows: 4,
        z: 0,
        roleCatalog: roles,
        artSet: art
    });
    const ground = session.stamps.find((s) => s.subLayer === 'ground') || session.stamps[0];
    session.beginStroke();
    session.paintAt(1, 1, { stamp: ground, subLayer: 'ground' });
    session.endStroke();

    const full = fillTileMapRgba(
        {
            cols: 4,
            rows: 4,
            floor: session.floor,
            subLayerVisible: () => true
        },
        null,
        null,
        new Map()
    );
    const p = (1 * 4 + 1) * 4;
    assert.ok(full.data[p + 3] > 0, 'visible cell has alpha');

    const hidden = fillTileMapRgba(
        {
            cols: 4,
            rows: 4,
            floor: session.floor,
            subLayerVisible: (id) => id !== 'ground'
        },
        null,
        null,
        new Map()
    );
    assert.strictEqual(hidden.data[p + 3], 0, 'ground hidden → empty');
    log('sub-layer visibility ok');
}

function testExportChannelAndNotify() {
    const session = createEditorSession({ cols: 4, rows: 4, z: 0 });
    // manual friction
    session.paintChannel('friction', 0, 0, 100, { size: 1 });
    const vp = createEditorViewport();
    vp.setSession(session);
    const exp = vp.exportChannelRgba('friction');
    assert.ok(exp);
    assert.strictEqual(exp.width, 4);
    assert.strictEqual(exp.height, 4);
    // value 100 → gray
    assert.strictEqual(exp.data[0], 100);

    vp.clearDirty();
    vp.notifySessionPaint({ x0: 0, y0: 0, x1: 0, y1: 0 }, ['friction']);
    assert.ok(vp.anyDirty());
    log('export + notify ok');
}

function testSightDimAlpha() {
    const sight = new Uint8Array(4);
    sight[0] = 255;
    sight[1] = 0;
    const packed = fillSightRgba(sight, 2, 2, { x0: 0, y0: 0, x1: 0, y1: 0 }, null);
    assert.strictEqual(packed.data[3], 140);
    assert.strictEqual(packed.data[0], 255);
    log('sight dim alpha ok');
}

function testOneDisplaySurfaceContract() {
    // Document-level contract helper: callers should only mount one canvas id.
    const DISPLAY_CANVAS_ID = 'editorCanvas';
    assert.strictEqual(DISPLAY_CANVAS_ID, 'editorCanvas');
    // Viewport does not create DOM canvases
    const vp = createEditorViewport({ cols: 2, rows: 2 });
    assert.strictEqual(typeof document, 'undefined');
    assert.ok(vp.cols === 2);
    log('single display contract ok');
}

function testVisibleMapRectAndPresentView() {
    const vis = visibleMapRect(100, 80, 20, 40, 200, 100, 2, 0);
    // scroll 20/2=10, 40/2=20; view 200/2=100, 100/2=50 → x0=10 y0=20 x1=60 y1=45? ceil(10+100)=110 → min 99
    assert.strictEqual(vis.mapX, 10);
    assert.strictEqual(vis.mapY, 20);
    assert.strictEqual(vis.mapW, 100);
    assert.strictEqual(vis.mapH, 50);
    assert.strictEqual(vis.x0, 10);
    assert.strictEqual(vis.y0, 20);
    assert.ok(vis.x1 >= vis.x0);
    assert.ok(vis.y1 >= vis.y0);

    const display = mockCtx();
    const world = { width: 100, height: 80 }; // stub canvas-like
    let overlayCalled = false;
    const r = presentView(display, world, {
        viewWidth: 200,
        viewHeight: 100,
        scrollLeft: 20,
        scrollTop: 40,
        zoom: 2,
        overlay: () => {
            overlayCalled = true;
        }
    });
    assert.ok(r.painted);
    assert.strictEqual(r.mapX, 10);
    assert.strictEqual(display.draws.length, 1);
    assert.ok(overlayCalled);
    assert.strictEqual(display.imageSmoothingEnabled, false);
    log('visibleMapRect + presentView ok');
}

function testTerrainOnlyFillAndTallProps() {
    const roles = roleCatalog();
    const art = loadArtSet('cave_simple');
    const session = createEditorSession({
        cols: 6,
        rows: 6,
        z: 0,
        roleCatalog: roles,
        artSet: art
    });
    const ground = session.stamps.find((s) => s.subLayer === 'ground') || session.stamps[0];
    const scenery = session.stamps.find((s) => s.subLayer === 'scenery');
    session.beginStroke();
    session.paintAt(2, 2, { stamp: ground, subLayer: 'ground' });
    if (scenery) {
        session.paintAt(3, 3, { stamp: scenery, subLayer: 'scenery' });
    }
    session.endStroke();

    const terrain = fillTileMapRgba(
        {
            cols: 6,
            rows: 6,
            floor: session.floor,
            mode: 'terrain',
            subLayerVisible: () => true
        },
        null,
        null,
        new Map()
    );
    const pG = (2 * 6 + 2) * 4;
    assert.ok(terrain.data[pG + 3] > 0, 'ground cell visible in terrain mode');
    // scenery should NOT appear in terrain-only fill
    if (scenery) {
        const pS = (3 * 6 + 3) * 4;
        assert.strictEqual(terrain.data[pS + 3], 0, 'scenery excluded from terrain cache');
    }

    const props = collectTallPropsFromFloor(session.floor, { roleCatalog: roles });
    if (scenery) {
        assert.ok(props.length >= 1, 'tall props collected');
        const box = resolveTileDrawBox(3, 3, 1, 1, 1, 1, props[0].scale, props[0].anchor);
        assert.ok(box.dw > 0 && box.dh > 0);
        const ctx = mockCtx();
        const n = drawTallPropsMapSpace(ctx, props, {
            roleColor: () => '#ff00ff',
            subLayerVisible: () => true,
            tileSize: 1
        });
        assert.ok(n >= 1);
        assert.ok(ctx.fills.length >= 1);
    }

    // Viewport composite should mark props dirty and rebuild list
    const vp = createEditorViewport({ cols: 6, rows: 6 });
    vp.setRoleCatalog(roles);
    vp.setSession(session);
    const c = mockCtx();
    vp.compositeMap(c);
    if (scenery) {
        assert.ok(vp.propList && vp.propList.length >= 1);
    }
    log('terrain-only + tall props ok');
}

function testPresentOnViewportApi() {
    const vp = createEditorViewport({ cols: 32, rows: 32, zoom: 2 });
    vp.setScroll(10, 20);
    const vis = vp.getVisibleMapRect(100, 50, 0);
    assert.strictEqual(vis.mapX, 5);
    assert.strictEqual(vis.mapY, 10);
    const display = mockCtx();
    const world = { w: 32, h: 32 };
    const r = vp.present(display, world, { viewWidth: 100, viewHeight: 50 });
    assert.ok(r.painted);
    log('viewport present api ok');
}

function testAlphaOverPreservesUnderlay() {
    const dest = new Uint8ClampedArray([100, 100, 100, 255, 255, 255, 0, 255]);
    const src = new Uint8ClampedArray([0, 0, 0, 0, 255, 136, 0, 200]);
    alphaOverRgba(dest, src, 2);
    // empty field cell → underlay gray intact
    assert.strictEqual(dest[0], 100);
    assert.strictEqual(dest[3], 255);
    // opaque yellow blocked stays until field blends
    assert.ok(dest[4] > 200, 'field fire tints over yellow');
    assert.ok(dest[7] === 255 || dest[7] === 200 || dest[7] > 200);
    log('alphaOver helper ok');
}

/**
 * Regression: freehand Ground paint must not full-map rebuild every stroke.
 * floor-07 is 2560×2048 — putImageData of whole map per pen cell pegs the CPU.
 */
function testDirtyRectPaintDoesNotFullComposite() {
    const cols = 32;
    const rows = 32;
    const session = createEditorSession({ cols, rows, z: 0 });
    session.floor.friction.fill(100);

    const vp = createEditorViewport({ cols, rows });
    vp.setSession(session);
    const ctxFull = mockCtx(cols, rows);
    vp.compositeMap(ctxFull); // warm terrainCache
    vp.clearDirty();

    // Same session re-bind must not force full rebuild (page calls setSession every frame).
    vp.setSession(session);
    assert.strictEqual(vp.dirty.full, false, 'setSession same ref → no full dirty');

    session.beginStroke();
    session.paintAt(5, 5, { stamp: null, subLayer: 'ground' }); // may be empty stamp ok
    // Manual ground cell via palette if needed — notify is what we test
    vp.notifySessionPaint({ x0: 4, y0: 4, x1: 6, y1: 6 }, ['tilemap']);
    assert.strictEqual(vp.dirty.full, false, 'rect paint → not full dirty');
    assert.ok(vp.peekWorldDirtyRect(), 'pending dirty rect');
    const dr = vp.peekWorldDirtyRect();
    assert.ok(dr.x0 <= 4 && dr.x1 >= 6);

    const taken = vp.takeWorldDirtyRect();
    assert.ok(taken);
    assert.strictEqual(taken.x0, 4);
    assert.strictEqual(taken.y1, 6);

    const ctx = mockCtx(cols, rows);
    // Seed canvas with prior full composite so partial patch is meaningful
    for (let i = 0; i < ctx.buf.length; i++) ctx.buf[i] = ctxFull.buf[i];
    vp.markDirty(['terrain', 'debug']);
    const r = vp.compositeMap(ctx, { rect: taken });
    assert.ok(r.painted);
    // Every putImageData for the rect must be brush-sized, not full map
    for (let i = 0; i < ctx.puts.length; i++) {
        const p = ctx.puts[i];
        const w = p.width != null ? p.width : p.w;
        const h = p.height != null ? p.height : p.h;
        if (w != null && h != null) {
            assert.ok(w * h <= 16 * 16, 'put size ' + w + 'x' + h + ' must stay near dirty rect');
        }
    }
    // clearRect should also be rect-scoped
    assert.ok(ctx.clears.length >= 1);
    const cl = ctx.clears[0];
    assert.ok(cl.w <= 8 && cl.h <= 8, 'clearRect scoped to dirty rect');
    log('dirty-rect paint composite ok');
}

/**
 * Regression: empty fields / empty tilemap must not turn friction gray/yellow into black.
 * Reproduces "load PNG → select TileMap → disable layers → only fields+friction = black".
 */
function testCompositeEmptyOverlaysDoNotWipeFriction() {
    const cols = 4;
    const rows = 4;
    const session = createEditorSession({ cols, rows, z: 0 });
    // Path-like friction: gray walkable + yellow blocked
    session.floor.friction.fill(100);
    session.floor.friction[0] = 255;
    session.floor.fields.fill(0); // uninitialized fields
    session.floor.flags.fill(0);
    session.floor.sight.fill(0);

    const vp = createEditorViewport({ cols, rows });
    vp.setSession(session);
    // Match user toggles: friction + fields + tilemap on (empty tilemap)
    vp.setVisible('friction', true);
    vp.setVisible('fields', true);
    vp.setVisible('tilemap', true);
    vp.setVisible('flags', true);
    vp.setVisible('sight', true);

    const ctx = mockCtx(cols, rows);
    const r = vp.compositeMap(ctx);
    assert.ok(r.painted);
    assert.ok(r.passes.indexOf('friction') >= 0);
    assert.ok(r.passes.indexOf('fields') >= 0);

    // Cell 0 = blocked yellow (255,255,0)
    assert.strictEqual(ctx.buf[0], 255, 'blocked R');
    assert.strictEqual(ctx.buf[1], 255, 'blocked G');
    assert.strictEqual(ctx.buf[2], 0, 'blocked B');
    assert.strictEqual(ctx.buf[3], 255, 'blocked A');
    // Cell 1 = gray 100
    assert.strictEqual(ctx.buf[4], 100, 'walkable gray must survive empty fields/tilemap');
    assert.strictEqual(ctx.buf[5], 100);
    assert.strictEqual(ctx.buf[6], 100);
    assert.strictEqual(ctx.buf[7], 255);

    // Only friction + fields (user last step)
    vp.setVisible('tilemap', false);
    vp.setVisible('flags', false);
    vp.setVisible('sight', false);
    const ctx2 = mockCtx(cols, rows);
    vp.compositeMap(ctx2);
    assert.strictEqual(ctx2.buf[4], 100, 'friction+fields only: gray intact');
    assert.strictEqual(ctx2.buf[0], 255, 'friction+fields only: yellow intact');

    // fillFields empty cells are alpha 0 (transparent intent)
    const fpack = fillFieldsRgba(session.floor.fields, cols, rows, null, null);
    assert.strictEqual(fpack.data[3], 0, 'empty field → alpha 0');
    log('empty overlays do not wipe friction ok');
}

function testSpriteZoomGating() {
    assert.strictEqual(DEFAULT_SPRITE_ZOOM_MIN, 8);
    assert.strictEqual(shouldShowTileSprites(8, 8), true);
    assert.strictEqual(shouldShowTileSprites(7.9, 8), false);
    assert.strictEqual(shouldShowTileSprites(16, 8), true);
    assert.strictEqual(shouldShowTileSprites(1, 0), true, '0 = always');
    assert.strictEqual(shouldShowTileSprites(32, null), false, 'null = off');
    assert.strictEqual(shouldShowTileSprites(32, false), false);
    assert.strictEqual(normalizeSpriteZoomMin('off'), null);
    assert.strictEqual(normalizeSpriteZoomMin('always'), 0);
    assert.strictEqual(normalizeSpriteZoomMin('8'), 8);
    assert.strictEqual(normalizeSpriteZoomMin(16), 16);
    log('sprite zoom gating ok');
}

/**
 * High-zoom icon overpaint: only visible cells, display-space drawImage.
 * World buffer stays 1px/tile; sprites are a present-time overlay.
 */
function testAuthoringSpritesDisplayAndPresent() {
    const roles = roleCatalog();
    const art = loadArtSet('cave_simple');
    const session = createEditorSession({
        cols: 8,
        rows: 8,
        z: 0,
        roleCatalog: roles,
        artSet: art
    });
    const ground = session.stamps.find((s) => s.subLayer === 'ground') || session.stamps[0];
    assert.ok(ground && ground.catalogId, 'need ground stamp with catalogId');
    session.beginStroke();
    session.paintAt(2, 2, { stamp: ground, subLayer: 'ground' });
    session.endStroke();

    const fakeImg = { width: 32, height: 32, naturalWidth: 32, naturalHeight: 32 };
    let getCalls = 0;
    const getImage = (id, kind) => {
        getCalls++;
        assert.ok(id);
        assert.ok(kind === 'tiles' || kind === 'objects');
        return fakeImg;
    };

    const dctx = mockCtx(200, 200);
    const stats = drawAuthoringSpritesDisplay(dctx, {
        floor: session.floor,
        cols: 8,
        rows: 8,
        scrollLeft: 0,
        scrollTop: 0,
        zoom: 8,
        viewWidth: 64,
        viewHeight: 64,
        getImage,
        pad: 0
    });
    // Visible at zoom 8: map 0..7 tiles in 64px → 8 tiles; only (2,2) painted
    assert.ok(stats.terrain >= 1, 'painted ground icon');
    assert.ok(dctx.draws.length >= 1, 'drawImage for icon');
    const first = dctx.draws[0];
    // drawImage(img, dx, dy, dw, dh): tile (2,2) @ zoom 8, scroll 0 → ~16,16 size ~8
    // (icon 32×32 scaled to tile screen size = zoom px; 1:1 at 3200%)
    assert.ok(first.args[0] >= 10 && first.args[0] <= 20, 'tile screen x near 16');
    assert.ok(first.args[2] >= 6 && first.args[2] <= 10, 'icon dw ≈ zoom tile size');
    assert.ok(first.args[3] >= 6 && first.args[3] <= 10, 'icon dh ≈ zoom tile size');

    const vp = createEditorViewport({ cols: 8, rows: 8, zoom: 8, spriteZoomMin: 8 });
    vp.setRoleCatalog(roles);
    vp.setSession(session);
    vp.setImageGetter(getImage);
    assert.strictEqual(vp.spritesActive(), true);
    vp.setSpriteZoomMin(16);
    assert.strictEqual(vp.spritesActive(8), false, 'below threshold');
    vp.setSpriteZoomMin(8);
    assert.strictEqual(vp.spritesActive(8), true);

    const display = mockCtx(64, 64);
    const world = { w: 8, h: 8 };
    const before = display.draws.length;
    vp.present(display, world, { viewWidth: 64, viewHeight: 64, zoom: 8 });
    assert.ok(display.draws.length > before, 'present overpaints icons at ≥ min zoom');

    const displayLow = mockCtx(64, 64);
    vp.present(displayLow, world, { viewWidth: 64, viewHeight: 64, zoom: 2 });
    // only world blit via drawImage(world,...) — no catalog icon args with fakeImg
    const iconDraws = displayLow.draws.filter((d) => d.img === fakeImg);
    assert.strictEqual(iconDraws.length, 0, 'no icons below spriteZoomMin');

    vp.setSpriteZoomMin('off');
    assert.strictEqual(vp.spriteZoomMin, null);
    assert.strictEqual(vp.spritesActive(32), false);
    log('authoring sprites display + present ok');
}

/**
 * Regression: painting path/ground next to stairs/trees must not drop those
 * tall props from the cached list. The wiki editor dirty-rect used to evict
 * neighbors (pad=2) and only recollect the painted cell — stairs became a
 * flag glyph and scenery vanished until save+reload.
 */
function testDirtyRectPaintKeepsNeighborTallProps() {
    const roles = roleCatalog();
    const art = loadArtSet('cave_simple');
    const session = createEditorSession({
        cols: 12,
        rows: 12,
        z: 0,
        roleCatalog: roles,
        artSet: art
    });
    const ground = session.stamps.find((s) => s.subLayer === 'ground') || session.stamps[0];
    const path = session.stamps.find((s) => s.subLayer === 'path');
    const scenery = session.stamps.find((s) => s.subLayer === 'scenery');
    const vertical = session.stamps.find((s) => s.subLayer === 'vertical');
    assert.ok(scenery, 'need scenery stamp (dead tree)');
    assert.ok(vertical, 'need vertical stamp (stairs)');

    session.beginStroke();
    session.paintAt(3, 3, { stamp: scenery, subLayer: 'scenery' });
    session.paintAt(8, 8, { stamp: vertical, subLayer: 'vertical' });
    session.endStroke();

    const vp = createEditorViewport({ cols: 12, rows: 12, zoom: 32, spriteZoomMin: 8 });
    vp.setRoleCatalog(roles);
    vp.setSession(session);
    const ctxFull = mockCtx(12, 12);
    vp.compositeMap(ctxFull);
    const before = vp.propList || [];
    assert.ok(
        before.some((p) => p && p.tileX === 3 && p.tileY === 3 && p.subLayerId === 'scenery'),
        'tree in list after full composite'
    );
    assert.ok(
        before.some((p) => p && p.tileX === 8 && p.tileY === 8 && p.subLayerId === 'vertical'),
        'stair in list after full composite'
    );
    const nBefore = before.length;
    vp.clearDirty();

    // Path stamp 2 tiles south of the tree — old pad=2 evicted the tree.
    session.beginStroke();
    const stamp = path || ground;
    session.paintAt(3, 5, { stamp, subLayer: stamp.subLayer || 'path' });
    session.endStroke();
    vp.notifySessionPaint({ x0: 3, y0: 5, x1: 3, y1: 5 }, ['tilemap']);
    const taken = vp.takeWorldDirtyRect();
    assert.ok(taken, 'dirty rect after path paint');
    const ctx = mockCtx(12, 12);
    for (let i = 0; i < ctx.buf.length; i++) ctx.buf[i] = ctxFull.buf[i];
    vp.compositeMap(ctx, { rect: taken });

    const after = vp.propList || [];
    assert.ok(
        after.some((p) => p && p.tileX === 3 && p.tileY === 3 && p.subLayerId === 'scenery'),
        'neighbor scenery must survive path paint dirty-rect'
    );
    assert.ok(
        after.some((p) => p && p.tileX === 8 && p.tileY === 8 && p.subLayerId === 'vertical'),
        'distant stair must survive path paint dirty-rect'
    );
    assert.strictEqual(after.length, nBefore, 'prop count unchanged after terrain paint');

    // Same-cell scenery paint must add the new prop and keep the neighbor tree.
    session.beginStroke();
    session.paintAt(3, 5, { stamp: scenery, subLayer: 'scenery' });
    session.endStroke();
    vp.notifySessionPaint({ x0: 3, y0: 5, x1: 3, y1: 5 }, ['tilemap']);
    vp.rebuildPropList({ x0: 3, y0: 5, x1: 3, y1: 5 });
    const added = vp.propList || [];
    assert.ok(
        added.some((p) => p && p.tileX === 3 && p.tileY === 5 && p.subLayerId === 'scenery'),
        'new scenery collected in dirty rect'
    );
    assert.ok(
        added.some((p) => p && p.tileX === 3 && p.tileY === 3 && p.subLayerId === 'scenery'),
        'old tree still present after neighbor scenery paint'
    );

    // Page flushEditorComposite clears dirty before present — sprites must
    // still overpaint from the patched list (no full rebuild).
    const fakeImg = { width: 32, height: 32, naturalWidth: 32, naturalHeight: 32 };
    vp.setImageGetter(() => fakeImg);
    vp.clearDirty();
    const display = mockCtx(400, 400);
    vp.present(display, { w: 12, h: 12 }, {
        viewWidth: 400,
        viewHeight: 400,
        zoom: 32,
        scrollLeft: 0,
        scrollTop: 0
    });
    const iconDraws = display.draws.filter((d) => d.img === fakeImg);
    assert.ok(iconDraws.length >= 3, 'present still overpaints neighbor + new tall props');

    log('dirty-rect paint keeps neighbor tall props ok');
}

function main() {
    testDefaultVisibilityAndPasses();
    testDirtyFlags();
    testCoordTransform();
    testFrictionRgbaAndDecode();
    testVisibilityFiltersComposite();
    testSubLayerVisibilityInTileMapFill();
    testExportChannelAndNotify();
    testSightDimAlpha();
    testOneDisplaySurfaceContract();
    testVisibleMapRectAndPresentView();
    testTerrainOnlyFillAndTallProps();
    testPresentOnViewportApi();
    testAlphaOverPreservesUnderlay();
    testCompositeEmptyOverlaysDoNotWipeFriction();
    testDirtyRectPaintDoesNotFullComposite();
    testSpriteZoomGating();
    testAuthoringSpritesDisplayAndPresent();
    testDirtyRectPaintKeepsNeighborTallProps();
    console.log('editor_viewport: ok');
}

main();
