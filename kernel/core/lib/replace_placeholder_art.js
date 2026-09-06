/**
 * Phase H — replace dump placeholder pixels with original 32px art.
 * Ids, autoTile, and anim stay. Catalog source → pipeline, replaceable false.
 * Geometry (border12 / variation / wallFront / rect9) is code, not image-gen.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const { ROOT, genrePaths } = require('../../settings.js');
const { SOURCES, loadCatalog, saveCatalog, findById, upsertCreature } = require('./creature_manifest.js');
const { idToFileStem } = require('./creature_sprites.js');
const { tileAnimFileStem } = require('./tile_anim.js');

const ICON = 32;
const ORIGINAL = 256;
const SMALL = 64;
const MEDIUM = 128;
const FILE_MODE = 0o664;
const DIR_MODE = 0o775;
const GENRE = 'rpg_fantasy';
const KINDS = Object.freeze(['tiles', 'overlays', 'objects']);

const PAL = Object.freeze({
    grass: {
        fill: [52, 128, 40, 255],
        dark: [32, 84, 26, 255],
        light: [90, 168, 60, 255],
        blade: [40, 108, 32, 255],
        flower: [196, 72, 88, 255]
    },
    sand: {
        fill: [214, 186, 114, 255],
        dark: [176, 144, 78, 255],
        light: [236, 216, 156, 255],
        blade: [196, 164, 96, 255],
        flower: [188, 124, 72, 255]
    },
    dirt: {
        fill: [132, 92, 52, 255],
        dark: [92, 60, 32, 255],
        light: [168, 124, 72, 255],
        blade: [110, 78, 42, 255],
        flower: [150, 122, 88, 255]
    },
    water: {
        fill: [36, 114, 196, 255],
        dark: [16, 68, 140, 255],
        light: [92, 168, 220, 255],
        speck: [180, 216, 236, 255]
    },
    beach: {
        fill: [214, 186, 114, 255],
        dark: [176, 144, 78, 255],
        light: [236, 216, 156, 255],
        foam: [236, 216, 156, 255],
        foamDark: [196, 164, 96, 255]
    },

    lava: {
        fill: [220, 70, 20, 255],
        dark: [170, 40, 10, 255],
        light: [240, 120, 40, 255],
        speck: [255, 200, 100, 255],
        foam: [180, 100, 60, 255],       // Hot rock / dark magma
        foamDark: [140, 80, 50, 255],    // Hot rock / dark magma
        shoreFill: [120, 90, 70, 255],   // Brownish rock
        shoreDark: [80, 60, 40, 255],
        shoreLight: [150, 120, 100, 255]
    },
    green_lake: {
        fill: [40, 140, 60, 255],
        dark: [20, 90, 40, 255],
        light: [80, 180, 100, 255],
        speck: [140, 220, 160, 255],
        foam: [110, 100, 80, 255],
        foamDark: [90, 70, 50, 255],
        shoreFill: [80, 60, 40, 255],     // Dark brown rock
        shoreDark: [50, 30, 20, 255],
        shoreLight: [110, 90, 70, 255]
    },
    water_pool: {
        fill: [120, 200, 140, 255],
        dark: [80, 160, 100, 255],
        light: [160, 240, 180, 255],
        speck: [200, 255, 220, 255],
        foam: [180, 255, 200, 255],
        foamDark: [140, 220, 160, 255]
    },
    carpet: {
        fill: [148, 48, 52, 255],
        dark: [96, 28, 32, 255],
        light: [176, 72, 76, 255],
        trim: [196, 156, 72, 255],
        trimDark: [140, 104, 40, 255]
    },
    wall: {
        cap: [196, 176, 148, 255],
        capHi: [220, 204, 176, 255],
        capLo: [156, 140, 116, 255],
        face: [168, 108, 68, 255],
        faceHi: [188, 128, 84, 255],
        faceLo: [128, 80, 48, 255],
        mortar: [86, 58, 42, 255],
        outline: [48, 32, 24, 255],
        window: [40, 56, 80, 255],
        windowHi: [72, 96, 128, 255],
        frame: [196, 176, 120, 255],
        statue: [164, 156, 148, 255],
        statueLo: [112, 104, 96, 255]
    },
    fence: {
        wood: [140, 92, 48, 255],
        woodHi: [168, 116, 64, 255],
        woodLo: [96, 60, 28, 255],
        outline: [52, 32, 16, 255],
        metal: [92, 92, 96, 255]
    },
    mountain: {
        fill: [148, 148, 156, 255],
        dark: [88, 88, 96, 255],
        light: [188, 188, 196, 255],
        outline: [48, 48, 56, 255],
        snow: [232, 236, 240, 255],
        snowLo: [196, 204, 212, 255]
    },
    lake: {
        fill: [36, 114, 196, 255],
        dark: [16, 68, 140, 255],
        light: [92, 168, 220, 255],
        sand: [214, 186, 114, 255],
        foam: [236, 236, 228, 255]
    }
});

const WALL_TOP = 0;
const WALL_CAP_H = 6;
const WALL_FACE_Y = WALL_TOP + WALL_CAP_H;
const BRICK_W = 8;
const BRICK_H = 4;
const PILLAR_W = 6;
const PREVIEW_FLOOR = Object.freeze([72, 112, 52, 255]);

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
 * @returns {Uint8Array}
 */
function makeRgba(w, h) {
    return new Uint8Array((w || ICON) * (h || ICON) * 4);
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
 * @param {Uint8Array} data
 * @param {number} w
 * @param {number} x
 * @param {number} y
 * @returns {number[]}
 */
function getPx(data, w, x, y) {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

/**
 * @param {number} n
 * @returns {number}
 */
function wrap32(n) {
    return ((n % ICON) + ICON) % ICON;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function wrapDelta(a, b) {
    let d = a - b;
    if (d > 16) d -= ICON;
    if (d < -16) d += ICON;
    return d;
}

/**
 * Shore thickness along an edge (wrap-safe so n-n tiles meet).
 * @param {number} t
 * @returns {number}
 */
function shoreWidth(t) {
    return 6 + (hash2(wrap32(t), 401) % 4);
}

/**
 * 1px foam, plus a 2px bump that travels along the shore (not per-pixel noise).
 * @param {number} t
 * @param {number} frame
 * @returns {number}
 */
function foamDepth(t, frame) {
    const phase = wrap32((t | 0) + (frame | 0));
    return 1 + ((phase & 3) === 0 ? 1 : 0);
}

/**
 * @param {string} slot
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function cornerBlob(slot, x, y) {
    const cx = slot.indexOf('e') >= 0 ? ICON - 1 : 0;
    const cy = slot.indexOf('s') >= 0 ? ICON - 1 : 0;
    const dx = x - cx;
    const dy = y - cy;
    const r = 8 + (hash2(cx + 3, cy + 7) % 3);
    return dx * dx + dy * dy <= r * r;
}

/**
 * @param {string} slot
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function inShore(slot, x, y) {
    const n = y < shoreWidth(x);
    const s = y >= ICON - shoreWidth(x);
    const w = x < shoreWidth(y);
    const e = x >= ICON - shoreWidth(y);
    switch (slot) {
        case 'n':
            return n;
        case 's':
            return s;
        case 'w':
            return w;
        case 'e':
            return e;
        case 'dnw':
            return n || w;
        case 'dne':
            return n || e;
        case 'dsw':
            return s || w;
        case 'dse':
            return s || e;
        case 'cnw':
        case 'cne':
        case 'cse':
        case 'csw':
            return cornerBlob(slot, x, y);
        default:
            return false;
    }
}

/**
 * Water-facing foam on a shore pixel.
 * @param {string} slot
 * @param {number} x
 * @param {number} y
 * @param {number} frame
 * @returns {boolean}
 */
function isFoam(slot, x, y, frame) {
    if (!inShore(slot, x, y)) return false;
    const fi = frame | 0;
    const nF = y < foamDepth(x, fi);
    const sF = y >= ICON - foamDepth(x, fi);
    const wF = x < foamDepth(y, fi);
    const eF = x >= ICON - foamDepth(y, fi);
    switch (slot) {
        case 'n':
            return nF;
        case 's':
            return sF;
        case 'w':
            return wF;
        case 'e':
            return eF;
        case 'dnw':
            return nF || wF;
        case 'dne':
            return nF || eF;
        case 'dsw':
            return sF || wF;
        case 'dse':
            return sF || eF;
        case 'cnw':
        case 'cne':
        case 'cse':
        case 'csw': {
            // c* blobs are ~8px — a 2–3px foam band strobed the sand.
            const cx = slot.indexOf('e') >= 0 ? ICON - 1 : 0;
            const cy = slot.indexOf('s') >= 0 ? ICON - 1 : 0;
            const dx = x - cx;
            const dy = y - cy;
            const dist2 = dx * dx + dy * dy;
            const r = 8 + (hash2(cx + 3, cy + 7) % 3);
            const ring = (r - 1) * (r - 1);
            if (dist2 < (r - 2) * (r - 2)) return false;
            if (dist2 >= ring) return true;
            return ((x + y + fi * 2) & 3) === 0;
        }
        default:
            return false;
    }
}

/**
 * Seamless ground (grass / sand / dirt). Salt picks variation alts.
 * @param {string} family
 * @param {number} salt
 * @returns {Uint8Array}
 */
function paintGroundFill(family, salt) {
    const pal = PAL[family] || PAL.grass;
    const s = salt | 0;
    const data = makeRgba();
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const t = tone(x, y, 3 + s);
            let col = mixRgb(pal.fill, pal.dark, t * 0.55);
            if (tone(x, y, 11 + s) > 0.82) col = mixRgb(col, pal.light, 0.45);
            if (tone(x, y, 19 + s) > 0.9) col = pal.blade;
            setPx(data, ICON, x, y, col);
        }
    }
    if (s <= 0) return data;
    const tuftCount = family === 'grass' ? 4 : 3;
    for (let i = 0; i < tuftCount; i++) {
        const cx = hash2(s * 13 + i, 90) % ICON;
        const cy = hash2(s * 17 + i, 91) % ICON;
        const r = family === 'dirt' ? 1 : 2;
        for (let y = 0; y < ICON; y++) {
            for (let x = 0; x < ICON; x++) {
                const dx = wrapDelta(x, cx);
                const dy = wrapDelta(y, cy);
                if (dx * dx + dy * dy > r * r) continue;
                const col = tone(x, y, 40 + i + s) > 0.5 ? pal.blade : pal.dark;
                setPx(data, ICON, x, y, col);
            }
        }
        if (family === 'grass' && s > 0 && i === 0) {
            setPx(data, ICON, cx, cy, pal.flower);
        }
        if (family === 'sand' && s > 0 && i === 1) {
            setPx(data, ICON, cx, cy, pal.light);
        }
        if (family === 'dirt' && s > 0 && i === 2) {
            setPx(data, ICON, cx, cy, pal.flower);
        }
    }
    return data;
}

/**
 * Opaque water fill. Frame shifts highlight bands.
 * @param {number} frame
 * @returns {Uint8Array}
 */
function paintWater(frame, family) {
    // beach family's fill is water
    const pal = family === 'beach' ? PAL.water : (PAL[family] || PAL.water);
    const fi = frame | 0;
    const data = makeRgba();
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const band = (y + fi * 3 + (hash2(x, 7) % 3)) & 7;
            let col = pal.fill;
            if (band < 2) col = mixRgb(pal.fill, pal.light, 0.55);
            else if (band > 5) col = mixRgb(pal.fill, pal.dark, 0.5);
            if (tone(x, y, 21 + fi) > 0.93) col = pal.speck;
            if (tone(x, y, 5) > 0.88) col = mixRgb(col, pal.dark, 0.35);
            setPx(data, ICON, x, y, col);
        }
    }
    return data;
}

/**
 * 12-piece beach overlay. Transparent interior; sand+foam on the water edge.
 * @param {string} slot
 * @param {number} frame
 * @returns {Uint8Array}
 */
function paintBeachEdge(slot, frame, family) {
    const pal = PAL[family] || PAL.beach;
    const pFill = pal.shoreFill || pal.fill;
    const pDark = pal.shoreDark || pal.dark;
    const pLight = pal.shoreLight || pal.light;
    // Freeze animation for lava borders to prevent the rock from strobing/blinking
    const fi = family === 'lava' ? 0 : (frame | 0);
    const data = makeRgba();
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            if (!inShore(slot, x, y)) continue;
            if (isFoam(slot, x, y, fi)) {
                // For lava, maybe foam should be lava colored?
                // Let's use pal.foam if present, else pLight.
                const foamCol = pal.foam || pLight;
                const foamDark = pal.foamDark || mixRgb(pFill, pDark, 0.35);
                const col = tone(x, y, 8) > 0.55 ? foamCol : foamDark;
                setPx(data, ICON, x, y, col);
                continue;
            }
            const t = tone(x, y, 4);
            let col = mixRgb(pFill, pDark, t * 0.45);
            if (tone(x, y, 15) > 0.85) col = pLight;
            setPx(data, ICON, x, y, col);
        }
    }
    return data;
}

/**
 * 9-piece carpet. Trim sits on the outer edge of the piece.
 * @param {string} slot
 * @returns {Uint8Array}
 */
function paintRect9(slot) {
    const pal = PAL.carpet;
    const data = makeRgba();
    const trimN = slot === 'n' || slot === 'nw' || slot === 'ne';
    const trimS = slot === 's' || slot === 'sw' || slot === 'se';
    const trimW = slot === 'w' || slot === 'nw' || slot === 'sw';
    const trimE = slot === 'e' || slot === 'ne' || slot === 'se';
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const t = tone(x, y, 6);
            let col = mixRgb(pal.fill, pal.dark, t * 0.4);
            if (tone(x, y, 18) > 0.88) col = mixRgb(col, pal.light, 0.5);
            const onTrim =
                (trimN && y < 3) ||
                (trimS && y >= ICON - 3) ||
                (trimW && x < 3) ||
                (trimE && x >= ICON - 3);
            if (onTrim) {
                const edge =
                    (trimN && y === 0) ||
                    (trimS && y === ICON - 1) ||
                    (trimW && x === 0) ||
                    (trimE && x === ICON - 1);
                col = edge ? pal.trimDark : pal.trim;
            }
            setPx(data, ICON, x, y, col);
        }
    }
    return data;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function brickMortar(x, y) {
    const ly = y - WALL_FACE_Y;
    if (ly < 0) return false;
    const row = (ly / BRICK_H) | 0;
    const shift = row & 1 ? BRICK_W / 2 : 0;
    return ly % BRICK_H === 0 || (x + shift) % BRICK_W === 0;
}

/**
 * ¾ south village strip. Alpha above the cap so the floor shows.
 * @param {string} slot
 * @returns {Uint8Array}
 */
function paintWallFront(slot) {
    const pal = PAL.wall;
    const data = makeRgba();
    const leftCap = slot === 'left' || slot === 'left_statue';
    const rightCap = slot === 'right' || slot === 'right_statue';
    const window = slot === 'mid_window';
    const statue = slot === 'left_statue' || slot === 'right_statue';
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            if (y < WALL_TOP) continue;
            const pillar =
                (leftCap && x < PILLAR_W) || (rightCap && x >= ICON - PILLAR_W);
            const n = y > WALL_TOP;
            const s = y < ICON - 1;
            const w = x > 0 || !leftCap;
            const e = x < ICON - 1 || !rightCap;
            if (!n || !s || !w || !e || y === WALL_TOP || y === ICON - 1) {
                setPx(data, ICON, x, y, pal.outline);
                continue;
            }
            if (y < WALL_FACE_Y) {
                let col = mixRgb(pal.cap, pal.capHi, tone(x, y, 5) * 0.5);
                if (y === WALL_TOP + 1) col = pal.capHi;
                if (pillar) col = mixRgb(col, pal.capLo, 0.4);
                setPx(data, ICON, x, y, col);
                continue;
            }
            if (window && x >= 11 && x <= 20 && y >= 10 && y <= 20) {
                const frame = x === 11 || x === 20 || y === 10 || y === 20;
                const mull = x === 15 || y === 15;
                setPx(data, ICON, x, y, frame || mull ? pal.frame : pal.window);
                if (!frame && !mull && tone(x, y, 9) > 0.7) {
                    setPx(data, ICON, x, y, pal.windowHi);
                }
                continue;
            }
            if (pillar) {
                const col = mixRgb(pal.faceLo, pal.face, tone(x, y, 2) * 0.4);
                setPx(data, ICON, x, y, x === 0 || x === ICON - 1 ? pal.outline : col);
                continue;
            }
            if (brickMortar(x, y)) {
                setPx(data, ICON, x, y, pal.mortar);
                continue;
            }
            setPx(
                data,
                ICON,
                x,
                y,
                mixRgb(pal.face, pal.faceHi, tone(x, y, 1) * 0.45)
            );
        }
    }
    if (statue) {
        const sx = slot === 'left_statue' ? 10 : 16;
        for (let y = 2; y <= 16; y++) {
            for (let x = sx; x < sx + 6; x++) {
                const inHead = y <= 6 && x >= sx + 1 && x <= sx + 4;
                const inBody = y > 6 && y <= 14 && x >= sx && x <= sx + 5;
                const inBase = y > 14 && x >= sx + 1 && x <= sx + 4;
                if (!inHead && !inBody && !inBase) continue;
                const edge =
                    (inHead && (x === sx + 1 || x === sx + 4 || y === 2)) ||
                    (inBody && (x === sx || x === sx + 5));
                setPx(data, ICON, x, y, edge ? pal.statueLo : pal.statue);
            }
        }
    }
    return data;
}

/**
 * @param {Uint8Array} data
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {number[]} fill
 * @param {number[]} edge
 */
function fillRectOutline(data, x0, y0, x1, y1, fill, edge) {
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const on = x === x0 || x === x1 || y === y0 || y === y1;
            setPx(data, ICON, x, y, on ? edge : fill);
        }
    }
}

/**
 * Isolated wooden fence pieces (kind none).
 * @param {string} slot
 * @returns {Uint8Array}
 */
function paintFence(slot) {
    const pal = PAL.fence;
    const data = makeRgba();
    const post = (x0, y0, x1, y1) =>
        fillRectOutline(data, x0, y0, x1, y1, pal.wood, pal.outline);
    const railH = (x0, x1, y) => {
        for (let x = x0; x <= x1; x++) {
            setPx(data, ICON, x, y, pal.outline);
            setPx(data, ICON, x, y + 1, pal.woodHi);
            setPx(data, ICON, x, y + 2, pal.wood);
        }
    };
    const railV = (y0, y1, x) => {
        for (let y = y0; y <= y1; y++) {
            setPx(data, ICON, x, y, pal.outline);
            setPx(data, ICON, x + 1, y, pal.woodHi);
            setPx(data, ICON, x + 2, y, pal.wood);
        }
    };
    if (slot === 'v' || slot === 'v_alt') {
        const ox = slot === 'v_alt' ? 1 : 0;
        post(14 + ox, 0, 17 + ox, 31);
        railH(12 + ox, 19 + ox, 8);
        railH(12 + ox, 19 + ox, 16);
        railH(12 + ox, 19 + ox, 24);
    } else if (slot === 'v_post') {
        post(13, 6, 18, 31);
    } else if (slot === 'h' || slot === 'h_south') {
        const y = slot === 'h_south' ? 22 : 16;
        post(0, y - 4, 3, y + 10);
        post(28, y - 4, 31, y + 10);
        railH(0, 31, y);
        railH(0, 31, y + 6);
    } else if (slot === 'h_gate') {
        post(0, 12, 3, 26);
        post(28, 12, 31, 26);
        post(10, 12, 13, 26);
        post(18, 12, 21, 26);
        railH(0, 10, 16);
        railH(21, 31, 16);
        railH(0, 10, 22);
        railH(21, 31, 22);
        for (let y = 14; y <= 24; y++) {
            setPx(data, ICON, 15, y, pal.metal);
            setPx(data, ICON, 16, y, pal.metal);
        }
    } else if (slot === 'nw') {
        post(12, 12, 17, 31);
        railV(0, 14, 13);
        railH(14, 31, 16);
        railH(14, 31, 22);
    } else if (slot === 'ne') {
        post(14, 12, 19, 31);
        railV(0, 14, 15);
        railH(0, 16, 16);
        railH(0, 16, 22);
    } else if (slot === 'sw') {
        post(12, 8, 17, 31);
        railV(16, 31, 13);
        railH(14, 31, 16);
        railH(14, 31, 22);
    } else if (slot === 'se') {
        post(14, 8, 19, 31);
        railV(16, 31, 15);
        railH(0, 16, 16);
        railH(0, 16, 22);
    } else {
        post(14, 4, 17, 31);
        railH(12, 19, 16);
    }
    return data;
}

/**
 * Isolated mountain / rock silhouette. Slot 01–14 vary size and peaks.
 * @param {string} slot
 * @returns {Uint8Array}
 */
function paintMountain(slot) {
    const pal = PAL.mountain;
    const n = parseInt(String(slot), 10) || 1;
    const data = makeRgba();
    const peakCount = 1 + (n % 3);
    const baseY = 28;
    /** @type {{ x: number, h: number, w: number }[]} */
    const peaks = [];
    for (let i = 0; i < peakCount; i++) {
        const x = 8 + ((n * 5 + i * 9) % 16);
        const h = 10 + ((n + i * 3) % 8) * 2;
        const w = 7 + ((n + i) % 5);
        peaks.push({ x, h, w });
    }
    for (let x = 0; x < ICON; x++) {
        let h = 0;
        for (let i = 0; i < peaks.length; i++) {
            const p = peaks[i];
            const dx = Math.abs(x - p.x);
            if (dx > p.w) continue;
            const t = 1 - dx / p.w;
            const ph = (p.h * t + 0.5) | 0;
            if (ph > h) h = ph;
        }
        if (h < 3) continue;
        const yTop = baseY - h;
        for (let y = yTop; y <= baseY; y++) {
            if (y < 0) continue;
            const edge = y === yTop || x === 0 || x === ICON - 1;
            const snow = y <= yTop + 3 && h >= 16;
            let col;
            if (edge) col = pal.outline;
            else if (snow) col = mixRgb(pal.snow, pal.snowLo, tone(x, y, n) * 0.4);
            else col = mixRgb(pal.fill, pal.dark, tone(x, y, n) * 0.5);
            if (!edge && !snow && tone(x, y, n + 4) > 0.85) col = pal.light;
            setPx(data, ICON, x, y, col);
        }
    }
    return data;
}

/**
 * Single-cell lake doodad (alpha outside the oval).
 * @returns {Uint8Array}
 */
function paintLake() {
    const pal = PAL.lake;
    const data = makeRgba();
    const cx = 15.5;
    const cy = 16.5;
    const rx = 13.2;
    const ry = 11.4;
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const dx = (x + 0.5 - cx) / rx;
            const dy = (y + 0.5 - cy) / ry;
            const d = dx * dx + dy * dy;
            if (d > 1.05) continue;
            if (d > 0.82) {
                setPx(data, ICON, x, y, d > 0.94 ? pal.foam : pal.sand);
                continue;
            }
            const band = (y + (hash2(x, 3) % 2)) & 7;
            let col = pal.fill;
            if (band < 2) col = pal.light;
            else if (band > 5) col = pal.dark;
            setPx(data, ICON, x, y, col);
        }
    }
    return data;
}

/**
 * @param {object} item
 * @param {number} [frame]
 * @returns {Uint8Array}
 */
function paintItem(item, frame) {
    const at = item && item.autoTile;
    if (!at || !at.kind) {
        throw new Error(`paintItem: missing autoTile (${item && item.id})`);
    }
    const slot = String(at.slot || '');
    const family = String(at.family || '');
    const fi = frame | 0;
    if (at.kind === 'variation') {
        const salt = slot === 'fill' ? 0 : parseInt(slot, 10) || 1;
        return paintGroundFill(family, salt);
    }
    if (at.kind === 'border12') {
        if (slot === 'fill') return paintWater(fi, family);
        return paintBeachEdge(slot, fi, family);
    }
    if (at.kind === 'rect9') return paintRect9(slot);
    if (at.kind === 'wallFront') return paintWallFront(slot);
    if (at.kind === 'none') {
        if (family === 'fence') return paintFence(slot);
        if (family === 'mountain') return paintMountain(slot);
        if (family === 'lake') return paintLake();
    }
    throw new Error(`paintItem: no painter for ${item.id} (${at.kind}/${family}/${slot})`);
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
        /* volume may reject chmod */
    }
}

/**
 * @param {string} dir
 */
function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    tryChmod(dir, DIR_MODE);
}

/**
 * @param {string} dest
 * @param {number} w
 * @param {number} h
 * @param {Uint8Array} rgba
 */
function writePng(dest, w, h, rgba) {
    const png = new PNG({ width: w, height: h, colorType: 6 });
    png.data.set(rgba);
    fs.writeFileSync(dest, PNG.sync.write(png, { colorType: 6 }));
    tryChmod(dest, FILE_MODE);
}

/**
 * @param {string} kind
 * @param {object} opts
 */
function resolveKindPaths(kind, opts) {
    if (opts.spriteRoot) {
        const kindRoot = path.join(opts.spriteRoot, kind);
        return {
            icon: path.join(kindRoot, 'icon'),
            small: path.join(kindRoot, 'small'),
            medium: path.join(kindRoot, 'medium'),
            alpha: path.join(kindRoot, 'alpha'),
            original: path.join(kindRoot, 'original'),
            manifest: opts.catalogPath || null
        };
    }
    const p = genrePaths(opts.genre || GENRE, kind);
    return {
        icon: p.icon,
        small: p.small,
        medium: p.medium,
        alpha: p.alpha,
        original: p.original,
        manifest: p.manifest
    };
}

/**
 * @param {string} kind
 * @param {string} stem
 * @param {Uint8Array} iconRgba
 * @param {object} opts
 * @returns {{ wrote: number, skipped: number, originalRel: string }}
 */
function writeSpriteSet(kind, stem, iconRgba, opts) {
    const paths = resolveKindPaths(kind, opts);
    const file = `${stem}.png`;
    const originalAbs = path.join(paths.original, file);
    const originalRel = opts.spriteRoot
        ? path.posix.join(kind, 'original', file)
        : path.relative(ROOT, originalAbs).split(path.sep).join('/');
    if (!opts.force && fs.existsSync(originalAbs)) {
        return { wrote: 0, skipped: 5, originalRel };
    }
    const slots = [
        [paths.icon, ICON],
        [paths.small, SMALL],
        [paths.medium, MEDIUM],
        [paths.alpha, ORIGINAL],
        [paths.original, ORIGINAL]
    ];
    /** @type {Record<number, Uint8Array>} */
    const scaled = Object.create(null);
    scaled[ICON] = iconRgba;
    let wrote = 0;
    if (!opts.dryRun) {
        for (let i = 0; i < slots.length; i++) {
            const dir = slots[i][0];
            const size = slots[i][1];
            const abs = path.join(dir, file);
            ensureDir(dir);
            if (!scaled[size]) scaled[size] = upscaleTo(iconRgba, size);
            writePng(abs, size, size, scaled[size]);
            wrote += 1;
        }
    } else {
        wrote = slots.length;
    }
    return { wrote, skipped: 0, originalRel };
}

/**
 * @param {object} [opts]
 * @returns {object[]}
 */
function listPlaceholderItems(opts) {
    const o = opts || {};
    const genre = o.genre || GENRE;
    const provided = o.catalogByKind;
    const kindList = provided ? KINDS.filter((k) => provided[k]) : KINDS;
    /** @type {object[]} */
    const items = [];
    for (let k = 0; k < kindList.length; k++) {
        const kind = kindList[k];
        const catalog = (provided && provided[kind]) || loadCatalog(genre, { kind });
        const list = catalog.creatures || [];
        for (let i = 0; i < list.length; i++) {
            const rec = list[i];
            if (!rec || !rec.autoTile) continue;
            if (!String(rec.id || '').startsWith('ref_')) continue;
            items.push(rec);
        }
    }
    return items;
}

/**
 * @param {unknown} only
 * @returns {Set<string>|null}
 */
function parseOnly(only) {
    if (!only) return null;
    if (only instanceof Set) return only;
    const arr = Array.isArray(only) ? only : String(only).split(',');
    const set = new Set(arr.map((s) => String(s).trim()).filter(Boolean));
    return set.size ? set : null;
}

/**
 * @param {Uint8Array} tile
 * @param {Uint8Array} dest
 * @param {number} dw
 * @param {number} dx
 * @param {number} dy
 * @param {number[]} floor
 */
function blitOnFloor(tile, dest, dw, dx, dy, floor) {
    for (let y = 0; y < ICON; y++) {
        for (let x = 0; x < ICON; x++) {
            const si = (y * ICON + x) * 4;
            const di = ((dy + y) * dw + (dx + x)) * 4;
            const a = tile[si + 3];
            if (a < 16) {
                if (!floor) continue;
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
 * @param {string} dir
 * @param {string} name
 * @param {(Uint8Array|null)[]} tiles
 * @param {number} cols
 * @param {number[]} [floor]
 */
function writeSheet(dir, name, tiles, cols, floor) {
    const fl = floor || PREVIEW_FLOOR;
    const rows = Math.ceil(tiles.length / cols);
    const w = cols * ICON;
    const h = rows * ICON;
    const out = makeRgba(w, h);
    for (let i = 0; i < w * h; i++) {
        const p = i * 4;
        out[p] = fl[0];
        out[p + 1] = fl[1];
        out[p + 2] = fl[2];
        out[p + 3] = 255;
    }
    for (let i = 0; i < tiles.length; i++) {
        const tile = tiles[i];
        if (!tile) continue;
        const tx = i % cols;
        const ty = (i / cols) | 0;
        blitOnFloor(tile, out, w, tx * ICON, ty * ICON, fl);
    }
    writePng(path.join(dir, name), w, h, out);
}

/**
 * @param {string} dir
 */
function writePreviewSheets(dir) {
    ensureDir(dir);
    const grass = [];
    grass.push(paintGroundFill('grass', 0));
    for (let i = 1; i <= 6; i++) grass.push(paintGroundFill('grass', i));
    writeSheet(dir, 'grass.png', grass, 7);
    const sand = [paintGroundFill('sand', 0)];
    for (let i = 1; i <= 6; i++) sand.push(paintGroundFill('sand', i));
    writeSheet(dir, 'sand.png', sand, 7);
    const dirt = [paintGroundFill('dirt', 0)];
    for (let i = 1; i <= 6; i++) dirt.push(paintGroundFill('dirt', i));
    writeSheet(dir, 'dirt.png', dirt, 7);
    writeSheet(
        dir,
        'water.png',
        [paintWater(0), paintWater(1), paintWater(2), paintWater(3)],
        4
    );
    const slots = [
        'n',
        'e',
        's',
        'w',
        'cnw',
        'cne',
        'cse',
        'csw',
        'dnw',
        'dne',
        'dse',
        'dsw'
    ];
    writeSheet(
        dir,
        'beach.png',
        slots.map((s) => paintBeachEdge(s, 0)),
        4
    );
    const rect = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'].map(paintRect9);
    writeSheet(dir, 'square.png', rect, 3);
    writeSheet(
        dir,
        'village_front.png',
        [
            paintWallFront('left'),
            paintWallFront('mid'),
            paintWallFront('right'),
            paintWallFront('left_statue'),
            paintWallFront('mid_window'),
            paintWallFront('right_statue')
        ],
        3
    );
    writeSheet(
        dir,
        'fences.png',
        [
            'v',
            'v_alt',
            'v_post',
            'h',
            'h_south',
            'h_gate',
            'nw',
            'ne',
            'sw',
            'se'
        ].map(paintFence),
        5
    );
    const mts = [];
    for (let i = 1; i <= 14; i++) {
        mts.push(paintMountain(String(i).padStart(2, '0')));
    }
    writeSheet(dir, 'mountains.png', mts, 7);
    writeSheet(dir, 'lake.png', [paintLake()], 1);

    const islandW = 5 * ICON;
    const island = makeRgba(islandW, islandW);
    const water0 = paintWater(0);
    const grass0 = paintGroundFill('grass', 0);
    const overlay = {
        '1,1': 'dnw',
        '2,1': 'n',
        '3,1': 'dne',
        '1,2': 'w',
        '3,2': 'e',
        '1,3': 'dsw',
        '2,3': 's',
        '3,3': 'dse'
    };
    for (let ty = 0; ty < 5; ty++) {
        for (let tx = 0; tx < 5; tx++) {
            const land = tx >= 1 && tx <= 3 && ty >= 1 && ty <= 3;
            blitOnFloor(
                land ? grass0 : water0,
                island,
                islandW,
                tx * ICON,
                ty * ICON,
                PREVIEW_FLOOR
            );
            const edge = overlay[`${tx},${ty}`];
            if (edge) {
                blitOnFloor(
                    paintBeachEdge(edge, 0),
                    island,
                    islandW,
                    tx * ICON,
                    ty * ICON,
                    null
                );
            }
        }
    }
    writePng(path.join(dir, 'island.png'), islandW, islandW, island);
}

/**
 * Overwrite placeholder sprites and flip catalog source / replaceable.
 * @param {object} [opts]
 */
function replacePlaceholderTiles(opts) {
    const o = opts || {};
    const genre = o.genre || GENRE;
    const dryRun = !!o.dryRun;
    const force = !!o.force;
    const save = o.save !== false && !dryRun;
    const only = parseOnly(o.only);
    const catalogs = o.catalogByKind || Object.create(null);
    const items = listPlaceholderItems({
        genre,
        catalogByKind: o.catalogByKind
    });
    let wrote = 0;
    let skipped = 0;
    let catalogUpserts = 0;
    /** @type {Set<string>} */
    const touched = new Set();
    /** @type {string[]} */
    const ids = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (only && !only.has(item.id)) continue;
        ids.push(item.id);
        const frameCount = item.anim && item.anim.frames > 1 ? item.anim.frames | 0 : 1;
        let originalRel = item.sprites && item.sprites.original;
        let wroteThis = 0;
        for (let fi = 0; fi < frameCount; fi++) {
            const rgba = paintItem(item, fi);
            const stem = tileAnimFileStem(item.id, fi);
            const result = writeSpriteSet(item.kind, stem, rgba, {
                genre,
                spriteRoot: o.spriteRoot,
                catalogPath: o.catalogPath,
                force,
                dryRun
            });
            wrote += result.wrote;
            skipped += result.skipped;
            wroteThis += result.wrote;
            if (fi === 0) originalRel = result.originalRel;
        }
        if (!force && !dryRun && wroteThis === 0) continue;
        if (!catalogs[item.kind]) {
            catalogs[item.kind] = loadCatalog(genre, { kind: item.kind });
        }
        const catalog = catalogs[item.kind];
        upsertCreature(catalog, {
            id: item.id,
            kind: item.kind,
            source: SOURCES.PIPELINE,
            replaceable: false,
            nativePx: ICON,
            autoTile: item.autoTile,
            anim: item.anim,
            sourcePack: item.sourcePack,
            sourceFolder: item.sourceFolder,
            sourceStem: item.sourceStem,
            scaleFilter: 'nearest',
            opaqueAlpha: item.opaqueAlpha,
            sprites: { original: originalRel, transformed: null },
            status: 'original_only'
        });
        touched.add(item.kind);
        catalogUpserts += 1;
    }

    if (save) {
        for (const kind of touched) {
            const catalog = catalogs[kind];
            if (o.spriteRoot && o.catalogPath) {
                saveCatalog(catalog, { kind, path: o.catalogPath });
            } else if (!o.spriteRoot) {
                saveCatalog(catalog, { kind });
                const paths = resolveKindPaths(kind, { genre });
                tryChmod(paths.manifest, FILE_MODE);
            }
        }
    }

    if (o.previewDir && !dryRun) writePreviewSheets(o.previewDir);

    return {
        items: ids,
        wrote,
        skipped,
        catalogUpserts,
        catalogs
    };
}

module.exports = {
    ICON,
    ORIGINAL,
    PAL,
    paintGroundFill,
    paintWater,
    paintBeachEdge,
    paintRect9,
    paintWallFront,
    paintFence,
    paintMountain,
    paintLake,
    paintItem,
    inShore,
    isFoam,
    upscaleTo,
    getPx,
    listPlaceholderItems,
    replacePlaceholderTiles,
    writePreviewSheets
};
