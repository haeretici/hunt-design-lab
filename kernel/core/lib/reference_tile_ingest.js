/**
 * Placeholder tile ingest (map editor Phase B–F).
 * Reads an archaeology manifest, nearest-scales dump PNGs into catalog sprites,
 * stamps replaceable catalog extras. Frame 0 is the catalog PNG; extra `anim`
 * frames are `Stem_N.png` (dump `_N`). Autotile resolve is the editor.
 * No image-gen.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const { ROOT, genrePaths } = require('../../settings.js');
const { appendDoneFile } = require('./batch_builder.js');
const {
    SOURCES,
    emptyCatalog,
    findById,
    fileStemToTechnical,
    loadCatalog,
    saveCatalog,
    upsertCreature
} = require('./creature_manifest.js');
const { idToFileStem } = require('./creature_sprites.js');

const FILE_MODE = 0o664;
const DIR_MODE = 0o775;

const DEFAULT_MANIFEST_REL = 'other/tiles/ingest_manifest.json';
const DEFAULT_NATIVE_PX = 83;
const DEFAULT_ORIGINAL_PX = 256;
const DEFAULT_ICON_PX = 32;
const DEFAULT_SOURCE_PACK = 'mobile_ref';

const AUTO_TILE_KINDS = Object.freeze([
    'none',
    'variation',
    'border12',
    'rect9',
    'wallTop15',
    'wallFront',
    'wang16'
]);

const ASSET_KINDS = Object.freeze(['tiles', 'overlays', 'objects']);

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
 * @param {string} abs
 * @returns {{ width: number, height: number, data: Buffer }}
 */
function readPng(abs) {
    const png = PNG.sync.read(fs.readFileSync(abs));
    return { width: png.width, height: png.height, data: png.data };
}

/**
 * Nearest-neighbor scale. Non-integer factors (83→32 / 83→256) are required.
 * @param {Uint8Array|Buffer} src
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} destW
 * @param {number} destH
 * @returns {Uint8Array}
 */
function nearestScaleRgba(src, srcW, srcH, destW, destH) {
    const dw = destW | 0;
    const dh = destH | 0;
    const sw = srcW | 0;
    const sh = srcH | 0;
    if (dw < 1 || dh < 1 || sw < 1 || sh < 1) {
        throw new Error(`nearestScaleRgba: bad size ${sw}x${sh} → ${dw}x${dh}`);
    }
    const out = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
        const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
            const si = (sy * sw + sx) * 4;
            const di = (y * dw + x) * 4;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
            out[di + 3] = src[si + 3];
        }
    }
    return out;
}

/**
 * @param {string} folder
 * @param {string} stem
 * @returns {string}
 */
function dumpFileName(stem) {
    const s = String(stem || '').trim().replace(/\.png$/i, '');
    if (!s) throw new Error('dump stem is empty');
    return `${s}.png`;
}

/**
 * @param {string} dumpRoot
 * @param {string} folder
 * @param {string} stem
 * @returns {string}
 */
function dumpPngPath(dumpRoot, folder, stem) {
    return path.join(dumpRoot, String(folder || ''), dumpFileName(stem));
}

/**
 * @param {unknown} raw
 * @param {string} manifestPath
 * @returns {object}
 */
function normalizeManifest(raw, manifestPath) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`ingest manifest must be an object (${manifestPath})`);
    }
    const rec = /** @type {Record<string, unknown>} */ (raw);
    const items = Array.isArray(rec.items) ? rec.items : null;
    if (!items || items.length === 0) {
        throw new Error(`ingest manifest has no items (${manifestPath})`);
    }
    const genre = String(rec.genre || 'rpg_fantasy').trim() || 'rpg_fantasy';
    const dumpRootRel = String(rec.dumpRoot || 'other/tiles').trim() || 'other/tiles';
    const nativePx = Number(rec.nativePx) > 0 ? Number(rec.nativePx) : DEFAULT_NATIVE_PX;
    const originalPx =
        Number(rec.originalPx) > 0 ? Number(rec.originalPx) : DEFAULT_ORIGINAL_PX;
    const iconPx = Number(rec.iconPx) > 0 ? Number(rec.iconPx) : DEFAULT_ICON_PX;
    const scaleFilter = rec.scaleFilter === 'lanczos' ? 'lanczos' : 'nearest';
    const source =
        String(rec.source || SOURCES.REFERENCE_PLACEHOLDER).trim() ||
        SOURCES.REFERENCE_PLACEHOLDER;
    const sourcePack = String(rec.sourcePack || DEFAULT_SOURCE_PACK).trim() || DEFAULT_SOURCE_PACK;
    const replaceable = rec.replaceable === false ? false : true;
    return {
        version: Number(rec.version) || 1,
        genre,
        dumpRootRel,
        nativePx,
        originalPx,
        iconPx,
        scaleFilter,
        source,
        sourcePack,
        replaceable,
        items
    };
}

/**
 * @param {string} absPath
 * @returns {object}
 */
function loadManifest(absPath) {
    const file = path.resolve(absPath);
    if (!fs.existsSync(file)) {
        throw new Error(`ingest manifest not found: ${file}`);
    }
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        throw new Error(`ingest manifest JSON: ${err && err.message ? err.message : err}`);
    }
    return normalizeManifest(raw, file);
}

/**
 * @param {unknown} autoTile
 * @returns {{ kind: string, family: string, slot: string }}
 */
function normalizeAutoTile(autoTile) {
    if (!autoTile || typeof autoTile !== 'object' || Array.isArray(autoTile)) {
        throw new Error('item.autoTile must be { kind, family, slot }');
    }
    const rec = /** @type {Record<string, unknown>} */ (autoTile);
    const kind = String(rec.kind || '').trim();
    if (AUTO_TILE_KINDS.indexOf(kind) < 0) {
        throw new Error(`unknown autoTile.kind "${kind}"`);
    }
    const family = String(rec.family || '').trim();
    if (!family) throw new Error('autoTile.family is required');
    const slot = String(rec.slot || '').trim();
    if (!slot) throw new Error('autoTile.slot is required');
    return { kind, family, slot };
}

/**
 * @param {unknown} anim
 * @returns {{ frames: number, fps: number }|undefined}
 */
function normalizeAnim(anim) {
    if (anim == null) return undefined;
    if (typeof anim !== 'object' || Array.isArray(anim)) {
        throw new Error('item.anim must be { frames, fps }');
    }
    const rec = /** @type {Record<string, unknown>} */ (anim);
    const frames = Number(rec.frames);
    const fps = Number(rec.fps);
    if (!(frames > 0) || !(fps > 0)) {
        throw new Error('item.anim needs frames > 0 and fps > 0');
    }
    return { frames, fps };
}

/**
 * @param {unknown} raw
 * @param {object} defaults
 * @returns {object}
 */
function normalizeItem(raw, defaults) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('ingest item must be an object');
    }
    const rec = /** @type {Record<string, unknown>} */ (raw);
    const id = String(rec.id || '').trim();
    if (!id) throw new Error('ingest item.id is required');
    if (!/^ref_/.test(id)) {
        throw new Error(`ingest id must use ref_ prefix (${id})`);
    }
    const folder = rec.folder == null ? '' : String(rec.folder).trim();
    const stem = String(rec.stem || '').trim().replace(/\.png$/i, '');
    if (!stem) throw new Error(`ingest item.stem is required (${id})`);
    const kind = String(rec.kind || 'tiles').trim();
    if (ASSET_KINDS.indexOf(kind) < 0) {
        throw new Error(`ingest item.kind must be tiles|overlays|objects (${id})`);
    }
    const category = String(rec.category || '').trim();
    if (!category) throw new Error(`ingest item.category is required (${id})`);
    const autoTile = normalizeAutoTile(rec.autoTile);
    const anim = normalizeAnim(rec.anim);
    const opaqueAlpha =
        rec.opaqueAlpha === false ? false : rec.opaqueAlpha === true ? true : kind === 'tiles';
    const technical =
        String(rec.technical || '').trim() || fileStemToTechnical(idToFileStem(id));
    const alias =
        String(rec.alias || '').trim() ||
        fileStemToTechnical(idToFileStem(id).replace(/^Ref_/, ''));
    const tags = Array.isArray(rec.tags)
        ? rec.tags.map((t) => String(t)).filter(Boolean)
        : [category, autoTile.family].filter((t, i, a) => t && a.indexOf(t) === i);
    return {
        id,
        folder,
        stem,
        kind,
        category,
        autoTile,
        anim,
        opaqueAlpha,
        technical,
        alias,
        tags,
        nativePx:
            Number(rec.nativePx) > 0 ? Number(rec.nativePx) : defaults.nativePx,
        scaleFilter: rec.scaleFilter === 'lanczos' ? 'lanczos' : defaults.scaleFilter || 'nearest',
        source: String(rec.source || defaults.source).trim() || defaults.source,
        sourcePack: String(rec.sourcePack || defaults.sourcePack).trim() || defaults.sourcePack,
        replaceable: rec.replaceable === false ? false : defaults.replaceable !== false
    };
}

/**
 * @param {string} doneFile
 * @returns {Set<string>}
 */
function loadDoneTechnicals(doneFile) {
    /** @type {Set<string>} */
    const set = new Set();
    if (!doneFile || !fs.existsSync(doneFile)) return set;
    const text = fs.readFileSync(doneFile, 'utf8');
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
 * @param {string} id
 */
function insertSortedById(catalog, id) {
    const rec = findById(catalog, id);
    if (!rec) return;
    const list = catalog.creatures;
    const idx = list.indexOf(rec);
    if (idx < 0) return;
    list.splice(idx, 1);
    let at = list.findIndex((c) => String(c.id).localeCompare(id) > 0);
    if (at < 0) at = list.length;
    list.splice(at, 0, rec);
}

/**
 * @param {object} opts
 * @returns {{ original: string, icon: string, doneFile: string, manifest: string }}
 */
function resolveKindPaths(kind, opts) {
    if (opts.spriteRoot) {
        const kindRoot = path.join(opts.spriteRoot, kind);
        return {
            original: path.join(kindRoot, 'original'),
            icon: path.join(kindRoot, 'icon'),
            doneFile: opts.doneFile || null,
            manifest: opts.catalogPath || null
        };
    }
    const p = genrePaths(opts.genre, kind);
    return {
        original: p.original,
        icon: p.icon,
        doneFile: p.doneFile,
        manifest: p.manifest
    };
}

/**
 * @param {{
 *   manifestPath?: string,
 *   manifest?: object,
 *   dumpRoot?: string,
 *   genre?: string,
 *   spriteRoot?: string,
 *   catalogByKind?: Record<string, object>,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   only?: string[]|Set<string>|null,
 *   save?: boolean
 * }} opts
 * @returns {{
 *   items: object[],
 *   wrote: number,
 *   skipped: number,
 *   catalogUpserts: number,
 *   warnings: string[]
 * }}
 */
function ingestReferenceTiles(opts) {
    const o = opts || {};
    const manifestPath = o.manifestPath
        ? path.resolve(o.manifestPath)
        : path.join(ROOT, DEFAULT_MANIFEST_REL);
    const manifest = o.manifest
        ? normalizeManifest(o.manifest, o.manifestPath || '<inline>')
        : loadManifest(manifestPath);
    const genre = o.genre || manifest.genre || 'rpg_fantasy';
    const dumpRoot = o.dumpRoot
        ? path.resolve(o.dumpRoot)
        : path.join(ROOT, manifest.dumpRootRel || 'other/tiles');
    const dryRun = !!o.dryRun;
    const force = !!o.force;
    const save = o.save !== false && !dryRun;
    const only = o.only
        ? o.only instanceof Set
            ? o.only
            : new Set((Array.isArray(o.only) ? o.only : String(o.only).split(',')).map((s) => String(s).trim()).filter(Boolean))
        : null;

    /** @type {object[]} */
    const items = [];
    for (let i = 0; i < manifest.items.length; i++) {
        items.push(normalizeItem(manifest.items[i], manifest));
    }

    /** @type {Record<string, object>} */
    const catalogs = o.catalogByKind || Object.create(null);
    /** @type {Set<string>} */
    const touchedKinds = new Set();
    /** @type {string[]} */
    const warnings = [];
    let wrote = 0;
    let skipped = 0;
    let catalogUpserts = 0;

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (only && only.size && !only.has(item.id)) continue;
        const frameCount = item.anim && item.anim.frames > 1 ? item.anim.frames | 0 : 1;
        const paths = resolveKindPaths(item.kind, {
            genre,
            spriteRoot: o.spriteRoot,
            catalogPath: o.catalogPath,
            doneFile: o.doneFile
        });
        const stem = idToFileStem(item.id);
        const file = `${stem}.png`;
        const originalAbs = path.join(paths.original, file);
        const iconAbs = path.join(paths.icon, file);
        const originalRel = o.spriteRoot
            ? path.posix.join(item.kind, 'original', file)
            : path.relative(ROOT, originalAbs).split(path.sep).join('/');

        for (let fi = 0; fi < frameCount; fi++) {
            const dumpStem = fi <= 0 ? item.stem : `${item.stem}_${fi}`;
            const srcPath = dumpPngPath(dumpRoot, item.folder, dumpStem);
            if (!fs.existsSync(srcPath)) {
                throw new Error(`dump PNG missing: ${srcPath} (${item.id} frame ${fi})`);
            }
            const src = readPng(srcPath);
            if (src.width !== item.nativePx || src.height !== item.nativePx) {
                warnings.push(
                    `${item.id} frame ${fi}: dump ${src.width}x${src.height} (expected ${item.nativePx})`
                );
            }
            const destStem = fi <= 0 ? stem : `${stem}_${fi}`;
            const destFile = `${destStem}.png`;
            const frameSlots = [
                [path.join(paths.original, destFile), paths.original, manifest.originalPx],
                [path.join(paths.icon, destFile), paths.icon, manifest.iconPx]
            ];
            for (let s = 0; s < frameSlots.length; s++) {
                const abs = frameSlots[s][0];
                const dir = frameSlots[s][1];
                const size = frameSlots[s][2];
                if (!force && fs.existsSync(abs)) {
                    skipped += 1;
                    continue;
                }
                if (!dryRun) {
                    ensureDir(dir);
                    const rgba = nearestScaleRgba(src.data, src.width, src.height, size, size);
                    writePng(abs, size, size, rgba);
                }
                wrote += 1;
            }
        }

        if (!catalogs[item.kind]) {
            if (o.catalogByKind && o.catalogByKind[item.kind]) {
                catalogs[item.kind] = o.catalogByKind[item.kind];
            } else if (o.spriteRoot) {
                catalogs[item.kind] = emptyCatalog(genre, item.kind);
            } else if (fs.existsSync(paths.manifest)) {
                catalogs[item.kind] = loadCatalog(genre, { kind: item.kind });
            } else {
                catalogs[item.kind] = emptyCatalog(genre, item.kind);
            }
        }
        const catalog = catalogs[item.kind];
        const partial = {
            id: item.id,
            technical: item.technical,
            alias: item.alias,
            genre,
            kind: item.kind,
            category: item.category,
            opaqueAlpha: item.opaqueAlpha,
            scaleFilter: item.scaleFilter,
            tags: item.tags,
            source: item.source,
            replaceable: item.replaceable,
            sourcePack: item.sourcePack,
            sourceFolder: item.folder,
            sourceStem: item.stem,
            nativePx: item.nativePx,
            autoTile: item.autoTile,
            sprites: { original: originalRel, transformed: null },
            status: 'original_only'
        };
        if (item.anim) partial.anim = item.anim;
        upsertCreature(catalog, partial);
        insertSortedById(catalog, item.id);
        touchedKinds.add(item.kind);
        catalogUpserts += 1;
    }

    if (save) {
        for (const kind of touchedKinds) {
            const catalog = catalogs[kind];
            const paths = resolveKindPaths(kind, {
                genre,
                spriteRoot: o.spriteRoot,
                catalogPath: o.catalogPath,
                doneFile: o.doneFile
            });
            if (o.spriteRoot && o.catalogPath) {
                saveCatalog(catalog, { kind, path: o.catalogPath });
            } else if (!o.spriteRoot) {
                saveCatalog(catalog, { kind });
                tryChmod(paths.manifest, FILE_MODE);
                const done = loadDoneTechnicals(paths.doneFile);
                /** @type {object[]} */
                const add = [];
                for (let i = 0; i < catalog.creatures.length; i++) {
                    const rec = catalog.creatures[i];
                    if (!rec || rec.source !== SOURCES.REFERENCE_PLACEHOLDER) continue;
                    if (only && only.size && !only.has(rec.id)) continue;
                    if (done.has(rec.technical)) continue;
                    add.push(rec);
                    done.add(rec.technical);
                }
                if (add.length) {
                    appendDoneFile(paths.doneFile, add);
                    tryChmod(paths.doneFile, FILE_MODE);
                }
            }
        }
    }

    return {
        items,
        wrote,
        skipped,
        catalogUpserts,
        warnings,
        catalogs
    };
}

function defaultManifestPath() {
    return path.join(ROOT, DEFAULT_MANIFEST_REL);
}

module.exports = {
    DEFAULT_MANIFEST_REL,
    DEFAULT_NATIVE_PX,
    DEFAULT_ORIGINAL_PX,
    DEFAULT_ICON_PX,
    AUTO_TILE_KINDS,
    nearestScaleRgba,
    readPng,
    writePng,
    dumpPngPath,
    loadManifest,
    normalizeManifest,
    normalizeItem,
    ingestReferenceTiles,
    defaultManifestPath
};
