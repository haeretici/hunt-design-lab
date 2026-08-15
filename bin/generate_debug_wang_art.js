#!/usr/bin/env node
/**
 * Procedural debug sprites for map-editor Wang checks (not batch image-gen).
 *
 * Writes icon/ (32), small/ (64), medium/ (128), alpha/ + original/ (256)
 * nearest-from-32 so Hunt (icon at 32px tiles; small fallback) and the
 * editor can both resolve the stem. Real alpha. No green plate.
 *
 *   node bin/generate_debug_wang_art.js
 *   node bin/generate_debug_wang_art.js --force
 *
 * Families: overlay dirt + water (16 masks + 4 inners each); objects
 * stone_wall (16 full[] faces: 4 shipped + 12 extras). Cobble is not shipped.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const { genrePaths, ROOT } = require('../kernel/settings.js');
const {
    emptyCatalog,
    loadCatalog,
    saveCatalog,
    upsertCreature,
    findById
} = require('../kernel/core/lib/creature_manifest.js');
const { appendDoneFile } = require('../kernel/core/lib/batch_builder.js');
const { idToFileStem } = require('../kernel/core/lib/creature_sprites.js');
const {
    WANG_BITS,
    WANG_INNERS,
    WANG_MASK_COUNT,
    wangCatalogId,
    wangInnerCatalogId,
    wangTechnical,
    wangAlias,
    wangInnerTechnical,
    wangInnerAlias,
    buildWangFamilyRoster
} = require('../kernel/core/lib/overlay_wang.js');
const {
    WALL_ALIGN_ALL,
    wallCatalogId,
    maskForWallAlign,
    buildWallFamilyFullRoster
} = require('../kernel/core/lib/wall_wang.js');

const ICON = 32;
const SCALE = 8;
const ORIGINAL = ICON * SCALE;
const SMALL = 64;
const MEDIUM = 128;
const FILE_MODE = 0o664;
const DIR_MODE = 0o775;

const OVERLAY_FAMILIES = Object.freeze(['dirt', 'water']);
const WALL_FAMILY = 'stone_wall';
const GENRE = 'rpg_fantasy';

const FAMILY_PALETTE = Object.freeze({
    dirt: { fill: [196, 120, 58, 255], edge: [90, 46, 14, 255], ink: [255, 228, 180, 255] },
    water: { fill: [36, 128, 230, 255], edge: [8, 48, 112, 255], ink: [210, 236, 255, 255] }
});

const WALL_PALETTE = Object.freeze({
    fill: [156, 156, 162, 255],
    edge: [40, 40, 46, 255],
    hi: [210, 210, 216, 255],
    mortar: [92, 92, 98, 255],
    ink: [255, 236, 180, 255]
});

/** 3×5 digits for mask labels (row-major, 1 = ink). */
const FONT3 = Object.freeze({
    0: ['111', '101', '101', '101', '111'],
    1: ['010', '110', '010', '010', '111'],
    2: ['111', '001', '111', '100', '111'],
    3: ['111', '001', '111', '001', '111'],
    4: ['101', '101', '111', '001', '001'],
    5: ['111', '100', '111', '001', '111'],
    6: ['111', '100', '111', '101', '111'],
    7: ['111', '001', '001', '001', '001'],
    8: ['111', '101', '111', '101', '111'],
    9: ['111', '101', '111', '001', '111'],
    n: ['101', '111', '101', '101', '101'],
    w: ['101', '101', '101', '111', '101'],
    e: ['111', '100', '111', '100', '111'],
    s: ['111', '100', '111', '001', '111']
});

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = { force: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--force') opts.force = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return opts;
}

function printHelp() {
    console.log(`Procedural debug Wang art for the map editor (no image-gen).

Usage:
  node bin/generate_debug_wang_art.js [--force]

Writes rpg_fantasy overlay dirt/water (16+4) and stone_wall faces (16)
into icon/small/medium/alpha/original. --force overwrites existing PNGs.
`);
}

/**
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array} RGBA
 */
function makeRgba(w, h) {
    return new Uint8Array(w * h * 4);
}

/**
 * @param {Uint8Array} data
 * @param {number} w
 * @param {number} x
 * @param {number} y
 * @param {number[]} rgba
 */
function setPx(data, w, x, y, rgba) {
    if (x < 0 || y < 0 || x >= w || y >= ICON) return;
    const i = (y * w + x) * 4;
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
}

/**
 * @param {boolean[][]} grid
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 */
function fillRect(grid, x0, y0, x1, y1) {
    const xa = Math.max(0, Math.min(x0, x1));
    const xb = Math.min(ICON, Math.max(x0, x1));
    const ya = Math.max(0, Math.min(y0, y1));
    const yb = Math.min(ICON, Math.max(y0, y1));
    for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) grid[y][x] = true;
    }
}

/**
 * @param {boolean[][]} grid
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 */
function clearRect(grid, x0, y0, x1, y1) {
    const xa = Math.max(0, Math.min(x0, x1));
    const xb = Math.min(ICON, Math.max(x0, x1));
    const ya = Math.max(0, Math.min(y0, y1));
    const yb = Math.min(ICON, Math.max(y0, y1));
    for (let y = ya; y < yb; y++) {
        for (let x = xa; x < xb; x++) grid[y][x] = false;
    }
}

/**
 * @returns {boolean[][]}
 */
function emptyGrid() {
    /** @type {boolean[][]} */
    const g = new Array(ICON);
    for (let y = 0; y < ICON; y++) g[y] = new Array(ICON).fill(false);
    return g;
}

/**
 * Wang blob: center always; arms to connected edges; mask 15 = full cell.
 * @param {number} mask
 * @returns {boolean[][]}
 */
function wangGrid(mask) {
    const g = emptyGrid();
    if (mask === 15) {
        fillRect(g, 0, 0, ICON, ICON);
        return g;
    }
    fillRect(g, 12, 12, 20, 20);
    if (mask & WANG_BITS.N) fillRect(g, 12, 0, 20, 16);
    if (mask & WANG_BITS.E) fillRect(g, 16, 12, ICON, 20);
    if (mask & WANG_BITS.S) fillRect(g, 12, 16, 20, ICON);
    if (mask & WANG_BITS.W) fillRect(g, 0, 12, 16, 20);
    return g;
}

/**
 * Full fill with one diagonal notch (inner-corner stamp).
 * @param {string} inner
 * @returns {boolean[][]}
 */
function innerGrid(inner) {
    const g = emptyGrid();
    fillRect(g, 0, 0, ICON, ICON);
    if (inner === 'nw') clearRect(g, 0, 0, 14, 14);
    else if (inner === 'ne') clearRect(g, 18, 0, ICON, 14);
    else if (inner === 'se') clearRect(g, 18, 18, ICON, ICON);
    else if (inner === 'sw') clearRect(g, 0, 18, 14, ICON);
    return g;
}

/**
 * Wall segment for one full[] face. Same 4-neighbor bits as overlays:
 * center hub + arms to connected edges so adjacent cells tile.
 * Isolated pole stays inset (floor shows around it).
 * @param {string} align
 * @returns {boolean[][]}
 */
function wallGrid(align) {
    const g = emptyGrid();
    const mask = maskForWallAlign(align);
    const a = 11;
    const b = 21;
    fillRect(g, a, a, b, b);
    if (mask === 0) {
        fillRect(g, a, 6, b, 26);
        return g;
    }
    if (mask & WANG_BITS.N) fillRect(g, a, 0, b, b);
    if (mask & WANG_BITS.E) fillRect(g, a, a, ICON, b);
    if (mask & WANG_BITS.S) fillRect(g, a, a, b, ICON);
    if (mask & WANG_BITS.W) fillRect(g, 0, a, b, b);
    return g;
}

/**
 * @param {boolean[][]} grid
 * @param {typeof WALL_PALETTE} pal
 * @returns {Uint8Array}
 */
function paintWall(grid, pal) {
    const data = paintGrid(grid, pal.fill, pal.edge, pal.hi);
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            if (!grid[y][x]) continue;
            if (!occupied(grid, x, y - 1) || !occupied(grid, x + 1, y) || !occupied(grid, x, y + 1) || !occupied(grid, x - 1, y)) {
                continue;
            }
            const row = (y / 5) | 0;
            const offset = (row % 2) * 4;
            if (y % 5 === 0 || (x + offset) % 8 === 0) {
                setPx(data, ICON, x, y, pal.mortar);
            }
        }
    }
    return data;
}

/**
 * @param {boolean[][]} grid
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function occupied(grid, x, y) {
    return x >= 0 && y >= 0 && x < ICON && y < ICON && grid[y][x];
}

/**
 * @param {boolean[][]} grid
 * @param {number[]} fill
 * @param {number[]} edge
 * @param {number[]|null} hi
 * @returns {Uint8Array}
 */
function paintGrid(grid, fill, edge, hi) {
    const data = makeRgba(ICON, ICON);
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            if (!grid[y][x]) continue;
            const n = occupied(grid, x, y - 1);
            const e = occupied(grid, x + 1, y);
            const s = occupied(grid, x, y + 1);
            const w = occupied(grid, x - 1, y);
            if (!n || !e || !s || !w) {
                setPx(data, ICON, x, y, !n && hi ? hi : edge);
            } else {
                setPx(data, ICON, x, y, fill);
            }
        }
    }
    return data;
}

/**
 * @param {Uint8Array} data
 * @param {number} x
 * @param {number} y
 * @param {string} ch
 * @param {number[]} rgba
 */
function blitGlyph(data, x, y, ch, rgba) {
    const rows = FONT3[ch];
    if (!rows) return;
    for (let gy = 0; gy < 5; gy++) {
        for (let gx = 0; gx < 3; gx++) {
            if (rows[gy].charAt(gx) === '1') setPx(data, ICON, x + gx, y + gy, rgba);
        }
    }
}

/**
 * @param {Uint8Array} data
 * @param {string} text
 * @param {number[]} rgba
 */
function blitLabel(data, text, rgba) {
    const t = String(text || '');
    const w = t.length * 4 - 1;
    const x0 = Math.max(1, Math.floor((ICON - w) / 2));
    const y0 = 13;
    for (let i = 0; i < t.length; i++) {
        blitGlyph(data, x0 + i * 4, y0, t.charAt(i), rgba);
    }
}

/**
 * @param {Uint8Array} icon
 * @returns {Uint8Array}
 */
function upscaleTo(icon, size) {
    const factor = (size / ICON) | 0;
    if (factor < 1) return icon;
    const out = makeRgba(size, size);
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const si = (y * ICON + x) * 4;
            const r = icon[si];
            const g = icon[si + 1];
            const b = icon[si + 2];
            const a = icon[si + 3];
            for (let dy = 0; dy < factor; dy++) {
                for (let dx = 0; dx < factor; dx++) {
                    const di = ((y * factor + dy) * size + (x * factor + dx)) * 4;
                    out[di] = r;
                    out[di + 1] = g;
                    out[di + 2] = b;
                    out[di + 3] = a;
                }
            }
        }
    }
    return out;
}

/**
 * @param {string} dest
 * @param {number} size
 * @param {Uint8Array} rgba
 */
/**
 * @param {string} dest
 */
function tryChmod(dest, mode) {
    try {
        fs.chmodSync(dest, mode);
    } catch (_err) {
        /* existing files on this volume may reject chmod */
    }
}

/**
 * @param {string} dest
 * @param {number} size
 * @param {Uint8Array} rgba
 */
function writePng(dest, size, rgba) {
    const png = new PNG({ width: size, height: size, colorType: 6 });
    png.data.set(rgba);
    fs.writeFileSync(dest, PNG.sync.write(png, { colorType: 6 }));
    tryChmod(dest, FILE_MODE);
}

/**
 * @param {string} dir
 */
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    tryChmod(dir, DIR_MODE);
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {Uint8Array} iconRgba
 * @param {boolean} force
 * @returns {{ stem: string, originalRel: string, wrote: boolean }}
 */
function writePair(kind, id, iconRgba, force) {
    const paths = genrePaths(GENRE, kind);
    const stem = idToFileStem(id);
    const file = `${stem}.png`;
    const slots = [
        [paths.icon, ICON],
        [paths.small, SMALL],
        [paths.medium, MEDIUM],
        [paths.alpha, ORIGINAL],
        [paths.original, ORIGINAL]
    ];
    const originalAbs = path.join(paths.original, file);
    const originalRel = path
        .relative(ROOT, originalAbs)
        .split(path.sep)
        .join('/');
    /** @type {Record<number, Uint8Array>} */
    const scaled = Object.create(null);
    scaled[ICON] = iconRgba;
    let wrote = false;
    for (let i = 0; i < slots.length; i++) {
        const dir = slots[i][0];
        const size = slots[i][1];
        ensureDir(dir);
        const abs = path.join(dir, file);
        if (!force && fs.existsSync(abs)) continue;
        if (!scaled[size]) scaled[size] = upscaleTo(iconRgba, size);
        writePng(abs, size, scaled[size]);
        wrote = true;
    }
    return { stem, originalRel, wrote };
}

/**
 * @param {string} file
 * @returns {Set<string>}
 */
function loadDoneTechnicals(file) {
    /** @type {Set<string>} */
    const set = new Set();
    if (!file || !fs.existsSync(file)) return set;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const tab = t.indexOf('\t');
        set.add((tab < 0 ? t : t.slice(0, tab)).trim());
    }
    return set;
}

/**
 * @param {object} catalog
 * @param {object} item
 * @param {string} originalRel
 */
function upsertArt(catalog, item, originalRel) {
    upsertCreature(catalog, {
        ...item,
        sprites: { original: originalRel, transformed: null },
        status: 'original_only',
        source: 'pipeline',
        opaqueAlpha: false,
        tags: item.wangFamily
            ? [item.wangFamily]
            : item.wallFamily
              ? [item.wallFamily]
              : item.tags || []
    });
}

/**
 * @param {object} catalog
 * @param {string} id
 */
function insertSorted(catalog, id) {
    const rec = findById(catalog, id);
    if (!rec) return;
    const list = catalog.creatures;
    const idx = list.indexOf(rec);
    if (idx < 0) return;
    list.splice(idx, 1);
    let at = list.findIndex((c) => c.id.localeCompare(id) > 0);
    if (at < 0) at = list.length;
    list.splice(at, 0, rec);
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        printHelp();
        return;
    }

    const overlayPaths = genrePaths(GENRE, 'overlays');
    const objectPaths = genrePaths(GENRE, 'objects');
    const overlayCatalog = fs.existsSync(overlayPaths.manifest)
        ? loadCatalog(GENRE, { kind: 'overlays' })
        : emptyCatalog(GENRE, 'overlays');
    const objectCatalog = loadCatalog(GENRE, { kind: 'objects' });

    const overlayDone = loadDoneTechnicals(overlayPaths.doneFile);
    const objectDone = loadDoneTechnicals(objectPaths.doneFile);
    /** @type {object[]} */
    const overlayDoneAdd = [];
    /** @type {object[]} */
    const objectDoneAdd = [];

    let pngWrote = 0;
    let pngSkipped = 0;

    for (let fi = 0; fi < OVERLAY_FAMILIES.length; fi++) {
        const family = OVERLAY_FAMILIES[fi];
        const pal = FAMILY_PALETTE[family];
        const roster = buildWangFamilyRoster(family, GENRE);
        for (let mask = 0; mask < WANG_MASK_COUNT; mask++) {
            const id = wangCatalogId(family, mask);
            const icon = paintGrid(wangGrid(mask), pal.fill, pal.edge, null);
            blitLabel(icon, String(mask).padStart(2, '0'), pal.ink);
            const written = writePair('overlays', id, icon, opts.force);
            if (written.wrote) pngWrote += 1;
            else pngSkipped += 1;
            const item = roster[mask];
            upsertArt(overlayCatalog, item, written.originalRel);
            if (!overlayDone.has(item.technical)) {
                overlayDoneAdd.push(item);
                overlayDone.add(item.technical);
            }
        }
        for (let ii = 0; ii < WANG_INNERS.length; ii++) {
            const inner = WANG_INNERS[ii];
            const id = wangInnerCatalogId(family, inner);
            const icon = paintGrid(innerGrid(inner), pal.fill, pal.edge, null);
            blitLabel(icon, inner, pal.ink);
            const written = writePair('overlays', id, icon, opts.force);
            if (written.wrote) pngWrote += 1;
            else pngSkipped += 1;
            const item = {
                technical: wangInnerTechnical(family, inner),
                alias: wangInnerAlias(family, inner),
                genre: GENRE,
                kind: 'overlays',
                category: family,
                wangFamily: family,
                wangMask: 15,
                wangInner: inner,
                opaqueAlpha: false
            };
            upsertArt(overlayCatalog, item, written.originalRel);
            if (!overlayDone.has(item.technical)) {
                overlayDoneAdd.push(item);
                overlayDone.add(item.technical);
            }
        }
    }

    overlayCatalog.creatures.sort((a, b) => a.id.localeCompare(b.id));
    saveCatalog(overlayCatalog, { kind: 'overlays' });
    if (overlayDoneAdd.length) appendDoneFile(overlayPaths.doneFile, overlayDoneAdd);
    if (fs.existsSync(overlayPaths.doneFile)) tryChmod(overlayPaths.doneFile, FILE_MODE);
    if (fs.existsSync(overlayPaths.manifest)) tryChmod(overlayPaths.manifest, FILE_MODE);

    const wallRoster = buildWallFamilyFullRoster(WALL_FAMILY, GENRE);
    for (let i = 0; i < WALL_ALIGN_ALL.length; i++) {
        const align = WALL_ALIGN_ALL[i];
        const id = wallCatalogId(WALL_FAMILY, align);
        const icon = paintWall(wallGrid(align), WALL_PALETTE);
        blitLabel(icon, String(maskForWallAlign(align)).padStart(2, '0'), WALL_PALETTE.ink);
        const written = writePair('objects', id, icon, opts.force);
        if (written.wrote) pngWrote += 1;
        else pngSkipped += 1;
        const item = wallRoster[i];
        upsertArt(objectCatalog, item, written.originalRel);
        insertSorted(objectCatalog, id);
        if (!objectDone.has(item.technical)) {
            objectDoneAdd.push(item);
            objectDone.add(item.technical);
        }
    }
    saveCatalog(objectCatalog, { kind: 'objects' });
    if (objectDoneAdd.length) appendDoneFile(objectPaths.doneFile, objectDoneAdd);
    if (fs.existsSync(objectPaths.doneFile)) tryChmod(objectPaths.doneFile, FILE_MODE);
    if (fs.existsSync(objectPaths.manifest)) tryChmod(objectPaths.manifest, FILE_MODE);

    console.log(
        `debug wang art: png wrote=${pngWrote} skipped=${pngSkipped} ` +
            `overlays=${overlayCatalog.creatures.length} ` +
            `wall_faces=${WALL_ALIGN_ALL.length} ` +
            `done+overlays=${overlayDoneAdd.length} done+objects=${objectDoneAdd.length}`
    );
}

main();
