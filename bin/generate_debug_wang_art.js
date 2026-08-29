#!/usr/bin/env node
/**
 * Procedural Wang sprites for map-editor path overlays + vertical walls.
 * Playable 32×32 pixel art (not batch image-gen). Optional --labels for QA.
 *
 * Writes icon/ (32), small/ (64), medium/ (128), alpha/ + original/ (256)
 * nearest-from-32. Real alpha. No green plate.
 *
 *   node bin/generate_debug_wang_art.js --force --family dirt --mask 15,05
 *   node bin/generate_debug_wang_art.js --force --family water --mask 15
 *   node bin/generate_debug_wang_art.js --force --family stone_wall --align pole,horizontal,vertical,corner
 *   node bin/generate_debug_wang_art.js --force --family dirt --labels
 *
 * Families: overlay dirt + water (16 masks + 4 inners each); objects
 * stone_wall (4 shipped faces by default; --align extra for the other 12).
 * Walls are canvas A: 32×32 S/E edge pieces. Cobble is not shipped.
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
    wangInnerTechnical,
    wangInnerAlias,
    buildWangFamilyRoster
} = require('../kernel/core/lib/overlay_wang.js');
const {
    WALL_ALIGN_ALL,
    WALL_ALIGN_SHIPPED,
    WALL_ALIGN_EXTRA,
    WALL_ALIGN_FULL,
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
    dirt: {
        fill: [196, 120, 58, 255],
        dark: [124, 68, 28, 255],
        edge: [90, 46, 14, 255],
        light: [210, 160, 96, 255],
        speck: [150, 122, 88, 255],
        ink: [255, 228, 180, 255]
    },
    water: {
        fill: [36, 128, 230, 255],
        dark: [16, 72, 156, 255],
        edge: [8, 48, 112, 255],
        light: [120, 190, 230, 255],
        speck: [186, 220, 240, 255],
        ink: [210, 236, 255, 255]
    }
});

const WALL_PALETTE = Object.freeze({
    cap: [186, 184, 172, 255],
    capHi: [214, 212, 198, 255],
    capLo: [148, 146, 136, 255],
    south: [118, 108, 94, 255],
    southHi: [142, 130, 112, 255],
    southLo: [86, 78, 66, 255],
    east: [150, 144, 132, 255],
    eastHi: [170, 164, 150, 255],
    eastLo: [112, 106, 96, 255],
    mortar: [58, 52, 46, 255],
    outline: [34, 30, 26, 255],
    ink: [255, 236, 180, 255]
});

/** Canvas A occupancy (px). South face + cap along the south; east face + cap along the east. */
const SOUTH_FACE_H = 10;
const CAP_H = 5;
const SOUTH_TOP = ICON - SOUTH_FACE_H - CAP_H;
const SOUTH_FACE_Y = ICON - SOUTH_FACE_H;
const EAST_FACE_W = 7;
const CAP_W = 5;
const EAST_LEFT = ICON - EAST_FACE_W - CAP_W;
const EAST_FACE_X = ICON - EAST_FACE_W;
const POLE_X = 22;
const POLE_Y = 18;
const POLE_EAST_X = 28;
const POLE_CAP_H = 5;
/** Brick row height. Must divide 32 so V–V mortar continues across tiles. */
const BRICK_H = 4;
const BRICK_W = 8;

const PREVIEW_FLOOR = Object.freeze([92, 72, 52, 255]);

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
 * @param {string} raw
 * @returns {string[]}
 */
function parseList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * @param {string} raw
 * @returns {number}
 */
function parseMaskToken(raw) {
    const n = Number.parseInt(String(raw).replace(/^0+/, '') || '0', 10);
    if (!Number.isInteger(n) || n < 0 || n > 15) {
        throw new Error(`Invalid wang mask "${raw}" (want 0–15)`);
    }
    return n;
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    const opts = {
        force: false,
        help: false,
        labels: false,
        canvas: 32,
        families: null,
        masks: null,
        inners: null,
        aligns: null,
        preview: null
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            i += 1;
            if (i >= argv.length) throw new Error(`${a} needs a value`);
            return argv[i];
        };
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--force') opts.force = true;
        else if (a === '--labels') opts.labels = true;
        else if (a === '--family' || a === '--families')
            opts.families = (opts.families || []).concat(parseList(next()));
        else if (a.startsWith('--family='))
            opts.families = (opts.families || []).concat(parseList(a.slice(9)));
        else if (a === '--mask' || a === '--masks')
            opts.masks = (opts.masks || []).concat(parseList(next()).map(parseMaskToken));
        else if (a.startsWith('--mask='))
            opts.masks = (opts.masks || []).concat(parseList(a.slice(7)).map(parseMaskToken));
        else if (a === '--align') opts.aligns = (opts.aligns || []).concat(parseList(next()));
        else if (a.startsWith('--align=')) opts.aligns = (opts.aligns || []).concat(parseList(a.slice(8)));
        else if (a === '--inner') opts.inners = parseList(next());
        else if (a.startsWith('--inner=')) opts.inners = parseList(a.slice(8));
        else if (a === '--canvas') opts.canvas = Number(next());
        else if (a.startsWith('--canvas=')) opts.canvas = Number(a.slice(9));
        else if (a === '--preview') opts.preview = next();
        else if (a.startsWith('--preview=')) opts.preview = a.slice(10);
        else throw new Error(`Unknown argument: ${a}`);
    }
    if (opts.canvas !== 32 && opts.canvas !== 64) {
        throw new Error(`--canvas must be 32 or 64 (got ${opts.canvas})`);
    }
    if (opts.families) {
        opts.families = opts.families.map((f) => {
            if (f === 'wall' || f === 'walls') return WALL_FAMILY;
            if (f === 'overlay' || f === 'overlays') return null;
            if (f !== 'dirt' && f !== 'water' && f !== WALL_FAMILY) {
                throw new Error(`Unknown --family ${f}`);
            }
            return f;
        });
        if (opts.families.includes(null)) {
            opts.families = OVERLAY_FAMILIES.slice();
        }
    }
    if (opts.aligns) {
        /** @type {string[]} */
        const expanded = [];
        for (let i = 0; i < opts.aligns.length; i++) {
            const a = opts.aligns[i];
            if (a === 'all') expanded.push(...WALL_ALIGN_ALL);
            else if (a === 'extra' || a === 'extras') expanded.push(...WALL_ALIGN_EXTRA);
            else if (a === 'shipped' || a === 'four') expanded.push(...WALL_ALIGN_SHIPPED);
            else if (!WALL_ALIGN_ALL.includes(a)) {
                throw new Error(
                    `Unknown --align ${a}. Known: ${WALL_ALIGN_ALL.join(', ')} (or extra|all|shipped)`
                );
            } else expanded.push(a);
        }
        const seen = new Set();
        opts.aligns = expanded.filter((a) => {
            if (seen.has(a)) return false;
            seen.add(a);
            return true;
        });
    }
    if (opts.inners) {
        for (let i = 0; i < opts.inners.length; i++) {
            if (!WANG_INNERS.includes(opts.inners[i])) {
                throw new Error(`Unknown --inner ${opts.inners[i]}`);
            }
        }
    }
    return opts;
}

function printHelp() {
    console.log(`Playable Wang art (32×32 pixel art). No image-gen.

Usage:
  node bin/generate_debug_wang_art.js [--force] [--labels]
       [--family dirt|water|stone_wall] [--mask 15,05] [--inner nw,ne]
       [--align pole,horizontal,vertical,corner|extra|all|shipped] [--canvas 32]
       [--preview dir]

Writes rpg_fantasy overlay dirt/water and stone_wall faces into
icon/small/medium/alpha/original. Default is playable (no digits).
--labels stamps mask/face ids on top. --force overwrites existing PNGs.

Walls are canvas A: 32×32 south+east edge pieces, scale 1, variant icon.
Default --family stone_wall writes all 16 faces. --align shipped is the
four AI faces (pole / horizontal / vertical / corner). --align extra is
the other 12 (ends, diagonals, T, intersection).
--canvas 64 is refused (locked A in other/33_path_and_vertical_playable_sprites_plan.md).
`);
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function hash2(x, y) {
    let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    n = (n ^ (n >>> 13)) >>> 0;
    n = Math.imul(n, 1274126177) >>> 0;
    return n >>> 0;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} salt
 * @returns {number} 0..1
 */
function tone(x, y, salt) {
    return (hash2(x + salt * 17, y + salt * 31) % 1000) / 999;
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @param {number} t
 * @returns {number[]}
 */
function mixRgb(a, b, t) {
    const u = t < 0 ? 0 : t > 1 ? 1 : t;
    return [
        (a[0] + (b[0] - a[0]) * u + 0.5) | 0,
        (a[1] + (b[1] - a[1]) * u + 0.5) | 0,
        (a[2] + (b[2] - a[2]) * u + 0.5) | 0,
        255
    ];
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
 * @returns {boolean[][]}
 */
function emptyGrid() {
    /** @type {boolean[][]} */
    const g = new Array(ICON);
    for (let y = 0; y < ICON; y++) g[y] = new Array(ICON).fill(false);
    return g;
}


/**
 * Out-of-bounds along a connected edge counts as filled so stacked arms do
 * not paint a seam line.
 * @param {boolean[][]} grid
 * @param {number} x
 * @param {number} y
 * @param {number} mask
 * @returns {boolean}
 */
function occupiedExt(grid, x, y, mask) {
    if (x >= 0 && y >= 0 && x < ICON && y < ICON) return grid[y][x];
    if (mask === 15) return true;
    if (y < 0 && mask & WANG_BITS.N && x >= 0 && x < ICON) return grid[0][x];
    if (y >= ICON && mask & WANG_BITS.S && x >= 0 && x < ICON) return grid[ICON - 1][x];
    if (x >= ICON && mask & WANG_BITS.E && y >= 0 && y < ICON) return grid[y][ICON - 1];
    if (x < 0 && mask & WANG_BITS.W && y >= 0 && y < ICON) return grid[y][0];
    return false;
}

/**
 * N/S corridor half-width. Function of x only so stacked 05 tiles meet.
 * @param {number} x
 * @returns {number}
 */
function armHalfX(x) {
    return 5 + (hash2(x, 91) % 3) - 1;
}

/**
 * E/W corridor half-width. Function of y only so side-by-side 10 tiles meet.
 * @param {number} y
 * @returns {number}
 */
function armHalfY(y) {
    return 5 + (hash2(73, y) % 3) - 1;
}

/**
 * Wang blob: center always; arms to connected edges; mask 15 = full cell.
 * Softened plus — not a hard rectangle.
 * @param {number} mask
 * @returns {boolean[][]}
 */
function wangGrid(mask) {
    const g = emptyGrid();
    if (mask === 15) {
        for (let y = 0; y < ICON; y++) {
            for (let x = 0; x < ICON; x++) g[y][x] = true;
        }
        return g;
    }
    const cx = 16;
    const cy = 16;
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const dx = x + 0.5 - cx;
            const dy = y + 0.5 - cy;
            const rad = mask === 0 ? 5.6 : 6.4;
            let on = dx * dx + dy * dy <= rad * rad;
            if (mask !== 0) {
                if (mask & WANG_BITS.N && y <= cy && Math.abs(x - cx) < armHalfX(x)) on = true;
                if (mask & WANG_BITS.S && y >= cy && Math.abs(x - cx) < armHalfX(x)) on = true;
                if (mask & WANG_BITS.E && x >= cx && Math.abs(y - cy) < armHalfY(y)) on = true;
                if (mask & WANG_BITS.W && x <= cx && Math.abs(y - cy) < armHalfY(y)) on = true;
            }
            g[y][x] = on;
        }
    }
    if (mask & WANG_BITS.N) {
        for (let x = 0; x < ICON; x++) {
            if (Math.abs(x - cx) < armHalfX(x)) g[0][x] = true;
        }
    }
    if (mask & WANG_BITS.S) {
        for (let x = 0; x < ICON; x++) {
            if (Math.abs(x - cx) < armHalfX(x)) g[ICON - 1][x] = true;
        }
    }
    if (mask & WANG_BITS.E) {
        for (let y = 0; y < ICON; y++) {
            if (Math.abs(y - cy) < armHalfY(y)) g[y][ICON - 1] = true;
        }
    }
    if (mask & WANG_BITS.W) {
        for (let y = 0; y < ICON; y++) {
            if (Math.abs(y - cy) < armHalfY(y)) g[y][0] = true;
        }
    }
    return g;
}

/**
 * Full fill with one diagonal notch (inner-corner stamp).
 * @param {string} inner
 * @returns {boolean[][]}
 */
function innerGrid(inner) {
    const g = emptyGrid();
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) g[y][x] = true;
    }
    let nx = 0;
    let ny = 0;
    if (inner === 'ne') nx = ICON - 1;
    else if (inner === 'se') {
        nx = ICON - 1;
        ny = ICON - 1;
    } else if (inner === 'sw') ny = ICON - 1;
    const rad = 13;
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const dx = x - nx;
            const dy = y - ny;
            const nibble = (hash2(x, y) % 5) - 2;
            if (dx * dx + dy * dy < (rad + nibble) * (rad + nibble)) g[y][x] = false;
        }
    }
    return g;
}

/**
 * @param {boolean[][]} grid
 * @param {number} mask
 * @param {typeof FAMILY_PALETTE.dirt} pal
 * @param {string} family
 * @returns {Uint8Array}
 */
function paintOverlay(grid, mask, pal, family) {
    const data = makeRgba(ICON, ICON);
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            if (!grid[y][x]) continue;
            const n = occupiedExt(grid, x, y - 1, mask);
            const e = occupiedExt(grid, x + 1, y, mask);
            const s = occupiedExt(grid, x, y + 1, mask);
            const w = occupiedExt(grid, x - 1, y, mask);
            const fringe = !n || !e || !s || !w;
            const fine = tone(x, y, 1);
            const coarse = tone(x >> 1, y >> 1, 2);
            const t = 0.42 * fine + 0.58 * coarse;
            let col;
            if (family === 'water') {
                const wave = tone(x, (y >> 2) + 3, 4);
                col = mixRgb(pal.dark, pal.fill, 0.35 + 0.5 * t);
                if (wave > 0.72 && (y + (hash2(x, 0) % 3)) % 8 === 3) {
                    col = mixRgb(col, pal.light, 0.55);
                }
                if (fine > 0.965) col = pal.speck;
            } else {
                col = mixRgb(pal.dark, pal.fill, 0.4 + 0.5 * t);
                if (t > 0.78) col = mixRgb(col, pal.light, 0.55);
                if (fine > 0.97) col = pal.speck;
                else if (fine < 0.035) col = pal.edge;
            }
            if (fringe) col = mixRgb(col, pal.edge, family === 'water' ? 0.55 : 0.45);
            setPx(data, ICON, x, y, col);
        }
    }
    return data;
}

/**
 * Canvas A occupancy. South face along south; east face along east.
 * Missing W insets the south face (no fake west arm). Missing N insets
 * the east face (no fake north arm). A single-face end (east_end /
 * south_end) keeps the full front and adds SE thickness so an open
 * stroke terminates with a cap, not a pole tile.
 * Shipped pole / horizontal / vertical / corner occupancy is unchanged.
 * @param {string} align
 * @returns {{
 *   pole: boolean,
 *   south: boolean,
 *   east: boolean,
 *   westCap: boolean,
 *   northCap: boolean,
 *   eastCap: boolean,
 *   southCap: boolean,
 *   cross: boolean
 * }}
 */
function wallParts(align) {
    if (align === 'pole') {
        return {
            pole: true,
            south: false,
            east: false,
            westCap: false,
            northCap: false,
            eastCap: false,
            southCap: false,
            cross: false
        };
    }
    const mask = maskForWallAlign(align);
    const hasN = !!(mask & WANG_BITS.N);
    const hasE = !!(mask & WANG_BITS.E);
    const hasS = !!(mask & WANG_BITS.S);
    const hasW = !!(mask & WANG_BITS.W);
    const south = hasE || hasW;
    const east = hasN || hasS;
    return {
        pole: false,
        south,
        east,
        westCap: south && !hasW,
        northCap: east && !hasN,
        eastCap: south && !east && !hasE,
        southCap: east && !south && !hasS,
        cross: hasN && hasE && hasS && hasW
    };
}

/**
 * @param {ReturnType<typeof wallParts>} parts
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function wallOccupiedAt(parts, x, y) {
    if (x < 0 || y < 0 || x >= ICON || y >= ICON) return false;
    if (parts.pole) return x >= POLE_X && y >= POLE_Y;
    let on = false;
    if (parts.south) {
        const x0 = parts.westCap ? POLE_X : 0;
        if (y >= SOUTH_TOP && x >= x0) on = true;
    }
    if (parts.east) {
        const y0 = parts.northCap ? POLE_Y : 0;
        if (x >= EAST_LEFT && y >= y0) on = true;
    }
    if (
        parts.cross &&
        x >= EAST_LEFT - CAP_W &&
        x < EAST_LEFT &&
        y >= SOUTH_TOP - CAP_H &&
        y < SOUTH_TOP
    ) {
        on = true;
    }
    return on;
}

/**
 * Continuing faces treat the tile edge as occupied so H–H / V–V share mortar.
 * Caps do not continue off the free side.
 * @param {ReturnType<typeof wallParts>} parts
 * @param {number} x
 * @param {number} y
 */
function wallOccupiedExt(parts, x, y) {
    if (x >= 0 && y >= 0 && x < ICON && y < ICON) return wallOccupiedAt(parts, x, y);
    if (parts.pole) return false;
    if (parts.south && y >= SOUTH_TOP && y < ICON) {
        if (x < 0) return !parts.westCap;
        if (x >= ICON) return !parts.eastCap;
    }
    if (parts.east && x >= EAST_LEFT && x < ICON) {
        if (y < 0) return !parts.northCap;
        if (y >= ICON) return !parts.southCap;
    }
    return false;
}

/**
 * @param {ReturnType<typeof wallParts>} parts
 * @param {number} x
 * @param {number} y
 * @returns {'cap'|'south'|'east'|null}
 */
function wallSurfaceAt(parts, x, y) {
    if (!wallOccupiedAt(parts, x, y)) return null;
    if (parts.pole) {
        if (x >= POLE_EAST_X) return 'east';
        if (y < POLE_Y + POLE_CAP_H) return 'cap';
        return 'south';
    }
    if (parts.eastCap && x >= POLE_EAST_X && y >= POLE_Y) return 'east';
    // Vertical does not extend north of the south face: keep an east rim so
    // NE-style joins still read as S/E brick (not a plain horizontal).
    if (parts.northCap && parts.south && x >= EAST_FACE_X && y >= POLE_Y) return 'east';
    if (parts.southCap && y >= SOUTH_FACE_Y && x >= POLE_X) return 'south';
    if (
        parts.cross &&
        x >= EAST_LEFT - CAP_W &&
        x < EAST_LEFT &&
        y >= SOUTH_TOP - CAP_H &&
        y < SOUTH_TOP
    ) {
        return 'cap';
    }
    const inSouth = parts.south && y >= SOUTH_TOP && x >= (parts.westCap ? POLE_X : 0);
    const inEast = parts.east && x >= EAST_LEFT && y >= (parts.northCap ? POLE_Y : 0);
    if (inSouth) {
        if (y >= SOUTH_FACE_Y) return 'south';
        return 'cap';
    }
    if (inEast) {
        if (x >= EAST_FACE_X) return 'east';
        return 'cap';
    }
    return null;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function southMortar(x, y) {
    if (y % BRICK_H === 0) return true;
    const row = (y / BRICK_H) | 0;
    const off = (row % 2) * (BRICK_W / 2);
    return (x + off) % BRICK_W === 0;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function eastMortar(x, y) {
    if (y % BRICK_H === 0) return true;
    const row = (y / BRICK_H) | 0;
    const off = (row % 2) * 2;
    return (x + off) % 4 === 0;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function capJoint(x, y) {
    return x % 4 === 0 || y % 4 === 0;
}

/**
 * @param {number[]} base
 * @param {number[]} hi
 * @param {number[]} lo
 * @param {number} x
 * @param {number} y
 * @param {number} salt
 * @returns {number[]}
 */
function brickTone(base, hi, lo, x, y, salt) {
    const row = (y / BRICK_H) | 0;
    const col = (x / BRICK_W) | 0;
    const t = tone(col + salt, row, 8);
    if (t > 0.72) return hi;
    if (t < 0.22) return lo;
    return mixRgb(base, hi, 0.15 + 0.2 * tone(x, y, 3));
}

/**
 * Canvas A: bricks on south + east; rest alpha. Floor shows in the NW of the cell.
 * @param {string} align
 * @param {typeof WALL_PALETTE} pal
 * @returns {Uint8Array}
 */
function paintWall(align, pal) {
    const parts = wallParts(align);
    const data = makeRgba(ICON, ICON);
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const surf = wallSurfaceAt(parts, x, y);
            if (!surf) continue;
            const n = wallOccupiedExt(parts, x, y - 1);
            const e = wallOccupiedExt(parts, x + 1, y);
            const s = wallOccupiedExt(parts, x, y + 1);
            const w = wallOccupiedExt(parts, x - 1, y);
            if (!n || !e || !s || !w) {
                setPx(data, ICON, x, y, pal.outline);
                continue;
            }
            let col;
            if (surf === 'cap') {
                col = capJoint(x, y) ? pal.capLo : mixRgb(pal.cap, pal.capHi, tone(x, y, 5) * 0.45);
                if (!wallOccupiedExt(parts, x, y - 1) || y === SOUTH_TOP || (parts.pole && y === POLE_Y)) {
                    col = pal.capHi;
                }
            } else if (surf === 'south') {
                if (southMortar(x, y)) col = pal.mortar;
                else col = brickTone(pal.south, pal.southHi, pal.southLo, x, y, 1);
                if (y === ICON - 1) col = pal.southLo;
                if (y === SOUTH_FACE_Y) col = pal.outline;
            } else {
                if (eastMortar(x, y)) col = pal.mortar;
                else col = brickTone(pal.east, pal.eastHi, pal.eastLo, x, y, 2);
                if (x === ICON - 1) col = pal.eastLo;
            }
            setPx(data, ICON, x, y, col);
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
 * @param {number} size
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
 * @param {number} mode
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
function writePngRect(dest, w, h, rgba) {
    const png = new PNG({ width: w, height: h, colorType: 6 });
    png.data.set(rgba);
    fs.writeFileSync(dest, PNG.sync.write(png, { colorType: 6 }));
    tryChmod(dest, FILE_MODE);
}

/**
 * @param {string} dest
 * @param {number} size
 * @param {Uint8Array} rgba
 */
function writePng(dest, size, rgba) {
    writePngRect(dest, size, size, rgba);
}

/**
 * @param {Uint8Array} data
 * @param {number[]} rgba
 */
function fillRgba(data, rgba) {
    for (let i = 0; i < data.length; i += 4) {
        data[i] = rgba[0];
        data[i + 1] = rgba[1];
        data[i + 2] = rgba[2];
        data[i + 3] = rgba[3];
    }
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {(Uint8Array|null)[]} tiles
 * @param {number} cols
 * @param {number} [gap]
 */
function writeSheet(dir, name, tiles, cols, gap) {
    const g = gap || 0;
    const rows = Math.ceil(tiles.length / cols);
    const step = ICON + g;
    const w = cols * ICON + Math.max(0, cols - 1) * g;
    const h = rows * ICON + Math.max(0, rows - 1) * g;
    const out = makeRgba(w, h);
    fillRgba(out, PREVIEW_FLOOR);
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        if (!tile) continue;
        const tx = i % cols;
        const ty = (i / cols) | 0;
        blitTileOnFloor(tile, out, w, tx * step, ty * step, PREVIEW_FLOOR);
    }
    writePngRect(path.join(dir, name), w, h, out);
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

/**
 * @param {string[]|null} families
 * @param {string} family
 */
function wantsFamily(families, family) {
    return !families || families.includes(family);
}

/**
 * @param {Uint8Array} tile
 * @param {Uint8Array} dest
 * @param {number} dw
 * @param {number} dx
 * @param {number} dy
 * @param {number[]} floor
 */
function blitTileOnFloor(tile, dest, dw, dx, dy, floor) {
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const si = (y * ICON + x) * 4;
            const di = ((dy + y) * dw + (dx + x)) * 4;
            const a = tile[si + 3];
            if (a < 16) {
                dest[di] = floor[0];
                dest[di + 1] = floor[1];
                dest[di + 2] = floor[2];
                dest[di + 3] = 255;
            } else {
                dest[di] = tile[si];
                dest[di + 1] = tile[si + 1];
                dest[di + 2] = tile[si + 2];
                dest[di + 3] = 255;
            }
        }
    }
}

/**
 * @param {Map<string, Uint8Array>} icons
 * @param {string} align
 * @returns {Uint8Array}
 */
function wallPreviewTile(icons, align) {
    const id = wallCatalogId(WALL_FAMILY, align);
    return icons.get(id) || paintWall(align, WALL_PALETTE);
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {(Uint8Array|null)[][]} grid
 */
function writeLayoutSheet(dir, name, grid) {
    const cols = grid[0].length;
    /** @type {(Uint8Array|null)[]} */
    const tiles = [];
    for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < cols; c++) tiles.push(grid[r][c] || null);
    }
    writeSheet(dir, name, tiles, cols, 0);
}

/**
 * @param {Map<string, Uint8Array>} icons
 * @param {string} dir
 */
function writePreviews(icons, dir) {
    ensureDir(dir);
    const dirt15 = icons.get('dirt_wang_15');
    const dirt05 = icons.get('dirt_wang_05');
    const water15 = icons.get('water_wang_15');

    /** @type {Uint8Array[]} */
    const dirtMasks = [];
    for (let m = 0; m < WANG_MASK_COUNT; m++) {
        const tile = icons.get(wangCatalogId('dirt', m));
        if (!tile) continue;
        dirtMasks.push(tile);
        writePng(path.join(dir, `${wangCatalogId('dirt', m)}.png`), ICON, tile);
    }
    if (dirtMasks.length === WANG_MASK_COUNT) {
        writeSheet(dir, 'dirt_atlas_4x4.png', dirtMasks, 4, 0);
        writeSheet(
            dir,
            'dirt_hstroke_4.png',
            [
                icons.get('dirt_wang_02'),
                icons.get('dirt_wang_10'),
                icons.get('dirt_wang_10'),
                icons.get('dirt_wang_08')
            ],
            4,
            0
        );
        writeSheet(
            dir,
            'dirt_square_3x3.png',
            [
                icons.get('dirt_wang_06'),
                icons.get('dirt_wang_14'),
                icons.get('dirt_wang_12'),
                icons.get('dirt_wang_07'),
                icons.get('dirt_wang_15'),
                icons.get('dirt_wang_13'),
                icons.get('dirt_wang_03'),
                icons.get('dirt_wang_11'),
                icons.get('dirt_wang_09')
            ],
            3,
            0
        );
    }
    /** @type {Uint8Array[]} */
    const dirtInners = [];
    for (let i = 0; i < WANG_INNERS.length; i++) {
        const id = wangInnerCatalogId('dirt', WANG_INNERS[i]);
        const tile = icons.get(id);
        if (!tile) continue;
        dirtInners.push(tile);
        writePng(path.join(dir, `${id}.png`), ICON, tile);
    }
    if (dirtInners.length === WANG_INNERS.length) {
        writeSheet(dir, 'dirt_inners.png', dirtInners, 4, 4);
        if (dirtMasks.length === WANG_MASK_COUNT) {
            writeSheet(
                dir,
                'dirt_inner_nw_3x3.png',
                [
                    null,
                    icons.get('dirt_wang_06'),
                    icons.get('dirt_wang_12'),
                    icons.get('dirt_wang_06'),
                    icons.get('dirt_wang_inner_nw'),
                    icons.get('dirt_wang_13'),
                    icons.get('dirt_wang_03'),
                    icons.get('dirt_wang_11'),
                    icons.get('dirt_wang_09')
                ],
                3,
                0
            );
        }
    }

    /** @type {Uint8Array[]} */
    const waterMasks = [];
    for (let m = 0; m < WANG_MASK_COUNT; m++) {
        const tile = icons.get(wangCatalogId('water', m));
        if (!tile) continue;
        waterMasks.push(tile);
        writePng(path.join(dir, `${wangCatalogId('water', m)}.png`), ICON, tile);
    }
    if (waterMasks.length === WANG_MASK_COUNT) {
        writeSheet(dir, 'water_atlas_4x4.png', waterMasks, 4, 0);
        writeSheet(
            dir,
            'water_hstroke_4.png',
            [
                icons.get('water_wang_02'),
                icons.get('water_wang_10'),
                icons.get('water_wang_10'),
                icons.get('water_wang_08')
            ],
            4,
            0
        );
        writeSheet(
            dir,
            'water_05_pair.png',
            [icons.get('water_wang_05'), icons.get('water_wang_05')],
            1,
            0
        );
        writeSheet(
            dir,
            'water_square_3x3.png',
            [
                icons.get('water_wang_06'),
                icons.get('water_wang_14'),
                icons.get('water_wang_12'),
                icons.get('water_wang_07'),
                icons.get('water_wang_15'),
                icons.get('water_wang_13'),
                icons.get('water_wang_03'),
                icons.get('water_wang_11'),
                icons.get('water_wang_09')
            ],
            3,
            0
        );
        writeSheet(
            dir,
            'water_lake_4x4.png',
            [
                icons.get('water_wang_06'),
                icons.get('water_wang_14'),
                icons.get('water_wang_14'),
                icons.get('water_wang_12'),
                icons.get('water_wang_07'),
                icons.get('water_wang_15'),
                icons.get('water_wang_15'),
                icons.get('water_wang_13'),
                icons.get('water_wang_07'),
                icons.get('water_wang_15'),
                icons.get('water_wang_15'),
                icons.get('water_wang_13'),
                icons.get('water_wang_03'),
                icons.get('water_wang_11'),
                icons.get('water_wang_11'),
                icons.get('water_wang_09')
            ],
            4,
            0
        );
        const dirtPal = FAMILY_PALETTE.dirt;
        const dirt00 = icons.get('dirt_wang_00') || paintOverlay(wangGrid(0), 0, dirtPal, 'dirt');
        const dirt02 = icons.get('dirt_wang_02') || paintOverlay(wangGrid(2), 2, dirtPal, 'dirt');
        writeSheet(
            dir,
            'water_dirt_touch.png',
            [dirt00, dirt02, icons.get('water_wang_08'), icons.get('water_wang_00')],
            4,
            0
        );
    }
    /** @type {Uint8Array[]} */
    const waterInners = [];
    for (let i = 0; i < WANG_INNERS.length; i++) {
        const id = wangInnerCatalogId('water', WANG_INNERS[i]);
        const tile = icons.get(id);
        if (!tile) continue;
        waterInners.push(tile);
        writePng(path.join(dir, `${id}.png`), ICON, tile);
    }
    if (waterInners.length === WANG_INNERS.length) {
        writeSheet(dir, 'water_inners.png', waterInners, 4, 4);
        if (waterMasks.length === WANG_MASK_COUNT) {
            writeSheet(
                dir,
                'water_inner_nw_3x3.png',
                [
                    null,
                    icons.get('water_wang_06'),
                    icons.get('water_wang_12'),
                    icons.get('water_wang_06'),
                    icons.get('water_wang_inner_nw'),
                    icons.get('water_wang_13'),
                    icons.get('water_wang_03'),
                    icons.get('water_wang_11'),
                    icons.get('water_wang_09')
                ],
                3,
                0
            );
        }
    }

    if (dirt15) {
        const w = ICON * 2;
        const out = makeRgba(w, w);
        for (const [tx, ty] of [
            [0, 0],
            [ICON, 0],
            [0, ICON],
            [ICON, ICON]
        ]) {
            blitTileOnFloor(dirt15, out, w, tx, ty, PREVIEW_FLOOR);
        }
        writePng(path.join(dir, 'dirt_15_repeat_2x2.png'), w, out);
    }
    if (dirt05) {
        writeSheet(dir, 'dirt_05_pair.png', [dirt05, dirt05], 1, 0);
    }
    if (water15) {
        const w = ICON * 2;
        const out = makeRgba(w, w);
        for (const [tx, ty] of [
            [0, 0],
            [ICON, 0],
            [0, ICON],
            [ICON, ICON]
        ]) {
            blitTileOnFloor(water15, out, w, tx, ty, PREVIEW_FLOOR);
        }
        writePng(path.join(dir, 'water_15_repeat_2x2.png'), w, out);
    }
    const anyWall = [...icons.keys()].some((k) => k.startsWith('stone_wall_'));
    if (anyWall) {
        const tileOf = (a) => wallPreviewTile(icons, a);
        const poleTile = tileOf('pole');
        const horTile = tileOf('horizontal');
        const verTile = tileOf('vertical');
        const cornerTile = tileOf('corner');
        for (const [id, rgba] of icons) {
            if (!id.startsWith('stone_wall_')) continue;
            writePng(path.join(dir, `${id}.png`), ICON, rgba);
        }

        const faces = [poleTile, horTile, verTile, cornerTile];
        const fourW = ICON * 4 + 12;
        const fourOut = makeRgba(fourW, ICON);
        for (let i = 0; i < 4; i++) {
            blitTileOnFloor(faces[i], fourOut, fourW, i * (ICON + 4), 0, PREVIEW_FLOOR);
        }
        writePngRect(path.join(dir, 'walls_four.png'), fourW, ICON, fourOut);

        writeSheet(dir, 'walls_pole.png', [poleTile], 1, 0);
        writeSheet(dir, 'walls_hstroke_4.png', [poleTile, horTile, horTile, poleTile], 4, 0);
        writeSheet(dir, 'walls_h_pair.png', [horTile, horTile], 2, 0);
        writeSheet(dir, 'walls_vstroke_4.png', [poleTile, verTile, verTile, poleTile], 1, 0);

        const hasExtra = WALL_ALIGN_EXTRA.some((a) => icons.has(wallCatalogId(WALL_FAMILY, a)));
        if (!hasExtra) {
            writeLayoutSheet(dir, 'walls_room_3x3.png', [
                [cornerTile, horTile, cornerTile],
                [verTile, null, verTile],
                [cornerTile, horTile, cornerTile]
            ]);
        } else {
            const seDiag = tileOf('southeast_diagonal');
            const swDiag = tileOf('southwest_diagonal');
            const neDiag = tileOf('northeast_diagonal');
            const southEnd = tileOf('south_end');
            const eastEnd = tileOf('east_end');
            const westEnd = tileOf('west_end');
            const northEnd = tileOf('north_end');
            const southT = tileOf('south_t');
            const eastT = tileOf('east_t');
            const westT = tileOf('west_t');
            const northT = tileOf('north_t');
            const inter = tileOf('intersection');

            writeSheet(dir, 'walls_extras.png', WALL_ALIGN_EXTRA.map(tileOf), 4, 4);
            writeSheet(dir, 'walls_atlas_4x4.png', WALL_ALIGN_FULL.map(tileOf), 4, 0);
            writeSheet(dir, 'walls_hstroke_caps.png', [westEnd, horTile, horTile, eastEnd], 4, 0);
            writeSheet(dir, 'walls_vstroke_caps.png', [northEnd, verTile, verTile, southEnd], 1, 0);
            writeLayoutSheet(dir, 'walls_plus.png', [
                [null, northEnd, null],
                [westEnd, inter, eastEnd],
                [null, southEnd, null]
            ]);
            writeLayoutSheet(dir, 'walls_room_3x3.png', [
                [seDiag, horTile, swDiag],
                [verTile, null, verTile],
                [neDiag, horTile, cornerTile]
            ]);
            writeLayoutSheet(dir, 'walls_t_south.png', [
                [null, northEnd, null],
                [westEnd, southT, eastEnd],
                [null, null, null]
            ]);
            writeLayoutSheet(dir, 'walls_t_west.png', [
                [null, northEnd, null],
                [null, westT, eastEnd],
                [null, southEnd, null]
            ]);
            writeLayoutSheet(dir, 'walls_t_east.png', [
                [null, northEnd, null],
                [westEnd, eastT, null],
                [null, southEnd, null]
            ]);
            writeLayoutSheet(dir, 'walls_t_north.png', [
                [null, null, null],
                [westEnd, northT, eastEnd],
                [null, southEnd, null]
            ]);
        }
    }
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        printHelp();
        return;
    }
    if (opts.canvas === 64) {
        throw new Error(
            'canvas 64 refused: Phase 0 locked canvas A (32×32 S/E). See other/33_path_and_vertical_playable_sprites_plan.md'
        );
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
    /** @type {Map<string, Uint8Array>} */
    const previewIcons = new Map();

    let pngWrote = 0;
    let pngSkipped = 0;
    let overlayTouched = false;
    let wallTouched = false;

    for (let fi = 0; fi < OVERLAY_FAMILIES.length; fi++) {
        const family = OVERLAY_FAMILIES[fi];
        if (!wantsFamily(opts.families, family)) continue;
        overlayTouched = true;
        const pal = FAMILY_PALETTE[family];
        const roster = buildWangFamilyRoster(family, GENRE);
        const masks = opts.masks || Array.from({ length: WANG_MASK_COUNT }, (_, m) => m);
        const inners = opts.inners || (opts.masks ? [] : WANG_INNERS.slice());
        for (let mi = 0; mi < masks.length; mi++) {
            const mask = masks[mi];
            const id = wangCatalogId(family, mask);
            const icon = paintOverlay(wangGrid(mask), mask, pal, family);
            if (opts.labels) blitLabel(icon, String(mask).padStart(2, '0'), pal.ink);
            const written = writePair('overlays', id, icon, opts.force);
            previewIcons.set(id, icon);
            if (written.wrote) pngWrote += 1;
            else pngSkipped += 1;
            const item = roster[mask];
            upsertArt(overlayCatalog, item, written.originalRel);
            if (!overlayDone.has(item.technical)) {
                overlayDoneAdd.push(item);
                overlayDone.add(item.technical);
            }
        }
        for (let ii = 0; ii < inners.length; ii++) {
            const inner = inners[ii];
            const id = wangInnerCatalogId(family, inner);
            const icon = paintOverlay(innerGrid(inner), 15, pal, family);
            if (opts.labels) blitLabel(icon, inner, pal.ink);
            const written = writePair('overlays', id, icon, opts.force);
            previewIcons.set(id, icon);
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

    if (overlayTouched) {
        overlayCatalog.creatures.sort((a, b) => a.id.localeCompare(b.id));
        saveCatalog(overlayCatalog, { kind: 'overlays' });
        if (overlayDoneAdd.length) appendDoneFile(overlayPaths.doneFile, overlayDoneAdd);
        if (fs.existsSync(overlayPaths.doneFile)) tryChmod(overlayPaths.doneFile, FILE_MODE);
        if (fs.existsSync(overlayPaths.manifest)) tryChmod(overlayPaths.manifest, FILE_MODE);
    }

    if (wantsFamily(opts.families, WALL_FAMILY)) {
        wallTouched = true;
        const wallRoster = buildWallFamilyFullRoster(WALL_FAMILY, GENRE);
        const aligns = opts.aligns || WALL_ALIGN_ALL.slice();
        const rosterByAlign = Object.create(null);
        for (let i = 0; i < wallRoster.length; i++) {
            rosterByAlign[WALL_ALIGN_ALL[i]] = wallRoster[i];
        }
        for (let i = 0; i < aligns.length; i++) {
            const align = aligns[i];
            const id = wallCatalogId(WALL_FAMILY, align);
            const icon = paintWall(align, WALL_PALETTE);
            if (opts.labels) {
                blitLabel(icon, String(maskForWallAlign(align)).padStart(2, '0'), WALL_PALETTE.ink);
            }
            const written = writePair('objects', id, icon, opts.force);
            previewIcons.set(id, icon);
            if (written.wrote) pngWrote += 1;
            else pngSkipped += 1;
            const item = rosterByAlign[align];
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
    }

    if (opts.preview) {
        const previewDir = path.isAbsolute(opts.preview)
            ? opts.preview
            : path.join(ROOT, opts.preview);
        writePreviews(previewIcons, previewDir);
    }

    const faceNote = wallTouched
        ? (opts.aligns ? opts.aligns.length : WALL_ALIGN_SHIPPED.length)
        : 0;
    console.log(
        `playable wang art: png wrote=${pngWrote} skipped=${pngSkipped} ` +
            `overlays=${overlayTouched ? overlayCatalog.creatures.length : '-'} ` +
            `wall_faces=${wallTouched ? faceNote : '-'} ` +
            `canvas=32 labels=${opts.labels ? 1 : 0} ` +
            `done+overlays=${overlayDoneAdd.length} done+objects=${objectDoneAdd.length}`
    );
}

if (require.main === module) {
    main();
}

module.exports = {
    ICON,
    FAMILY_PALETTE,
    WALL_PALETTE,
    wangGrid,
    innerGrid,
    paintOverlay,
    paintWall,
    writePreviews,
    blitTileOnFloor,
    PREVIEW_FLOOR,
    makeRgba,
    writePng,
    ensureDir
};
