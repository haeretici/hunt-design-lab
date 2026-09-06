/**
 * Hunt tile animation (map editor Phase F).
 *
 * Catalog `anim: { frames, fps }`. Frame 0 is the base PNG; frames 1..n-1 are
 * sibling files `Stem_1.png` … matching dump `_N` suffixes. Editor stays on
 * frame 0. Hunt cycles on ground/path after the static terrain cache blit.
 */

'use strict';

const { idToFileStem } = require('./creature_sprites.js');

/** Catalog default when `anim.fps` is omitted or invalid. */
const DEFAULT_TILE_ANIM_FPS = 4;

/**
 * @param {unknown} raw
 * @returns {{ frames: number, fps: number }|null}
 */
function normalizeTileAnim(raw) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rec = /** @type {Record<string, unknown>} */ (raw);
    const frames = Math.floor(Number(rec.frames));
    if (!(frames > 0)) return null;
    let fps = Number(rec.fps);
    if (!(fps > 0)) fps = DEFAULT_TILE_ANIM_FPS;
    return { frames, fps };
}

/**
 * @param {{ frames?: number, fps?: number }|null|undefined} anim
 * @returns {boolean}
 */
function isCyclingTileAnim(anim) {
    return !!(anim && anim.frames > 1);
}

/**
 * Frame index for Hunt playback. Editor always uses 0 (do not call).
 * @param {{ frames: number, fps: number }|null|undefined} anim
 * @param {number} timeSec
 * @returns {number}
 */
function tileAnimFrameIndex(anim, timeSec) {
    if (!anim || !(anim.frames > 1)) return 0;
    const fps = anim.fps > 0 ? anim.fps : DEFAULT_TILE_ANIM_FPS;
    const t = Number(timeSec);
    if (!Number.isFinite(t) || t <= 0) return 0;
    const frames = anim.frames | 0;
    return Math.floor(t * fps) % frames;
}

/**
 * Dump PNG stem for frame i (0 = `5806`, 1 = `5806_1`).
 * @param {string} sourceStem
 * @param {number} frameIndex
 * @returns {string}
 */
function tileAnimDumpStem(sourceStem, frameIndex) {
    const stem = String(sourceStem || '')
        .trim()
        .replace(/\.png$/i, '');
    const fi = frameIndex | 0;
    if (fi <= 0) return stem;
    return `${stem}_${fi}`;
}

/**
 * Catalog sprite stem for frame i (`ref_water_fill` → `Ref_Water_Fill_1`).
 * @param {string} catalogId
 * @param {number} frameIndex
 * @returns {string}
 */
function tileAnimFileStem(catalogId, frameIndex) {
    const stem = idToFileStem(catalogId);
    const fi = frameIndex | 0;
    if (fi <= 0) return stem;
    return `${stem}_${fi}`;
}

/**
 * Resolve anim from a palette placement or catalog id, then an optional index.
 * @param {object|string|null|undefined} placementOrId
 * @param {Map<string, { frames: number, fps: number }>|Record<string, { frames: number, fps: number }>|null|undefined} [index]
 * @returns {{ frames: number, fps: number }|null}
 */
function animOf(placementOrId, index) {
    if (placementOrId && typeof placementOrId === 'object') {
        const direct = normalizeTileAnim(placementOrId.anim);
        if (direct) return direct;
    }
    const id =
        typeof placementOrId === 'string'
            ? placementOrId
            : placementOrId && typeof placementOrId === 'object'
              ? String(placementOrId.catalogId || placementOrId.id || '').trim()
              : '';
    if (!id || !index) return null;
    const hit =
        typeof index.get === 'function'
            ? index.get(id)
            : index[id];
    return normalizeTileAnim(hit);
}

/**
 * id → { frames, fps } from one or more catalogs (`creatures` or `items`).
 * @param {Array<object|null|undefined>|object|null|undefined} catalogs
 * @returns {Record<string, { frames: number, fps: number }>}
 */
function buildTileAnimIndex(catalogs) {
    /** @type {Record<string, { frames: number, fps: number }>} */
    const out = Object.create(null);
    const list = Array.isArray(catalogs) ? catalogs : catalogs ? [catalogs] : [];
    for (let c = 0; c < list.length; c++) {
        const cat = list[c];
        if (!cat || typeof cat !== 'object') continue;
        const rows = Array.isArray(cat.creatures)
            ? cat.creatures
            : Array.isArray(cat.items)
              ? cat.items
              : [];
        for (let i = 0; i < rows.length; i++) {
            const rec = rows[i];
            if (!rec || typeof rec !== 'object') continue;
            const id = String(rec.id || rec.catalogId || '').trim();
            if (!id) continue;
            const anim = normalizeTileAnim(rec.anim);
            if (!anim || !(anim.frames > 1)) continue;
            out[id] = anim;
        }
    }
    return out;
}

/**
 * Copy missing `anim` onto palette entries from an index. Does not overwrite.
 * @param {Array<object|null|undefined>} palette
 * @param {ReturnType<typeof buildTileAnimIndex>|null|undefined} index
 * @returns {number} rows filled
 */
function enrichPaletteAnim(palette, index) {
    if (!Array.isArray(palette) || !index) return 0;
    let n = 0;
    for (let i = 1; i < palette.length; i++) {
        const e = palette[i];
        if (!e || typeof e !== 'object') continue;
        if (normalizeTileAnim(e.anim)) continue;
        const anim = animOf(e, index);
        if (!anim) continue;
        e.anim = { frames: anim.frames, fps: anim.fps };
        n += 1;
    }
    return n;
}

module.exports = {
    DEFAULT_TILE_ANIM_FPS,
    normalizeTileAnim,
    isCyclingTileAnim,
    tileAnimFrameIndex,
    tileAnimDumpStem,
    tileAnimFileStem,
    animOf,
    buildTileAnimIndex,
    enrichPaletteAnim
};
