/**
 * Per-genre + asset-kind catalog (manifest) — load, save, inventory, lookups.
 * Shared by Node CLIs and browser tooling under kernel/.
 *
 * Schema: docs/05_creature_manifest.md (creatures) and docs/06_asset_kinds.md
 *
 * In-memory catalogs always expose `.creatures` as the entry array (historical name).
 * On disk, kind=creatures uses `creatures.json` + key `creatures`; other kinds use
 * `<kind>.json` + key `items` and a `kind` field.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    PATHS,
    getGenre,
    getAssetKind,
    genrePaths,
    GENRES,
    DEFAULT_KIND,
    listKindIds
} = require('../../settings.js');
const { formatJson } = require('./json_format.js');
const { parseWangId } = require('./overlay_wang.js');
const { parseWallId } = require('./wall_wang.js');

const CATALOG_VERSION = 1;

/** Catalog `scaleFilter` values. Missing → lanczos. */
const SCALE_FILTERS = Object.freeze({
    LANCZOS: 'lanczos',
    NEAREST: 'nearest'
});
const DEFAULT_SCALE_FILTER = SCALE_FILTERS.LANCZOS;

/**
 * Resolve catalog `opaqueAlpha` for process_sprites / UI.
 * Explicit true/false always win. When missing:
 *   - kind `tiles` → true (opaque full-bleed; default for terrain)
 *   - other kinds → false (overlays + chroma families)
 * @param {unknown} value
 * @param {string} [kindId]
 * @returns {boolean}
 */
function resolveOpaqueAlpha(value, kindId) {
    if (value === false || value === 0 || value === 'false' || value === '0') {
        return false;
    }
    if (value === true || value === 1 || value === 'true' || value === '1') {
        return true;
    }
    // Missing / unknown
    return kindId === 'tiles';
}

/**
 * Resolve catalog `scaleFilter` for process_sprites / UI.
 * Missing / unknown → lanczos (smooth). `nearest` keeps 32/64 pixel art blocky
 * when original is expanded to 256 and small/icon are written.
 * @param {unknown} value
 * @returns {'lanczos'|'nearest'}
 */
function resolveScaleFilter(value) {
    if (value == null || value === '') {
        return DEFAULT_SCALE_FILTER;
    }
    const v = String(value).trim().toLowerCase();
    if (v === 'nearest' || v === 'nearest-neighbor' || v === 'nn') {
        return SCALE_FILTERS.NEAREST;
    }
    if (v === 'lanczos' || v === 'smooth') {
        return SCALE_FILTERS.LANCZOS;
    }
    return DEFAULT_SCALE_FILTER;
}

/**
 * Place `scaleFilter` after `opaqueAlpha` when not the default. Omit lanczos.
 * @param {object} record
 * @param {'lanczos'|'nearest'} scaleFilter
 * @returns {object}
 */
function withOptionalScaleFilter(record, scaleFilter) {
    if (scaleFilter === DEFAULT_SCALE_FILTER) {
        return record;
    }
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(record)) {
        out[key] = record[key];
        if (key === 'opaqueAlpha') {
            out.scaleFilter = scaleFilter;
        }
    }
    if (!Object.prototype.hasOwnProperty.call(out, 'scaleFilter')) {
        out.scaleFilter = scaleFilter;
    }
    return out;
}

/** @typedef {'planned'|'original_only'|'ready'|'legacy_transformed'} CreatureStatus */
/** @typedef {'pipeline'|'legacy'|'manual'} CreatureSource */

const STATUSES = Object.freeze({
    PLANNED: 'planned',
    ORIGINAL_ONLY: 'original_only',
    READY: 'ready',
    LEGACY_TRANSFORMED: 'legacy_transformed'
});

const SOURCES = Object.freeze({
    PIPELINE: 'pipeline',
    LEGACY: 'legacy',
    MANUAL: 'manual'
});

/**
 * Technical phrase → stable id (`Ashen Dwarf Priest` → `ashen_dwarf_priest`).
 * @param {string} technical
 * @returns {string}
 */
function technicalToId(technical) {
    return String(technical)
        .trim()
        .replace(/['']/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();
}

/**
 * Technical phrase → PNG file stem (`Ashen Dwarf Priest` → `Ashen_Dwarf_Priest`).
 * @param {string} technical
 * @returns {string}
 */
function technicalToFileStem(technical) {
    return String(technical)
        .trim()
        .replace(/['']/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * File stem → technical phrase (`Ashen_Dwarf_Priest` → `Ashen Dwarf Priest`).
 * @param {string} stem
 * @returns {string}
 */
function fileStemToTechnical(stem) {
    return String(stem)
        .replace(/\.png$/i, '')
        .replace(/_+/g, ' ')
        .trim();
}

/**
 * Heuristic short alias when none is stored (inventory of existing art).
 * 1–2 words: full technical; 3+: drop the leading adjective token.
 * @param {string} technical
 * @returns {string}
 */
function deriveAliasFromTechnical(technical) {
    const words = String(technical).trim().split(/\s+/).filter(Boolean);
    if (words.length <= 2) {
        return words.join(' ');
    }
    return words.slice(1).join(' ');
}

/**
 * Repo-relative path using POSIX separators (stable in JSON).
 * @param {...string} parts path segments under repo root
 * @returns {string}
 */
function repoPath(...parts) {
    return path.posix.join(...parts.map((p) => String(p).replace(/\\/g, '/')));
}

/**
 * Absolute filesystem path for a repo-relative sprite path.
 * @param {string} relativePath
 * @returns {string}
 */
function absoluteSpritePath(relativePath) {
    if (!relativePath) {
        throw new Error('absoluteSpritePath: empty path');
    }
    if (path.isAbsolute(relativePath)) {
        return relativePath;
    }
    return path.join(PATHS.root, relativePath);
}

/**
 * @param {string} genreId
 * @param {string} [kindId]
 * @returns {{ version: number, genre: string, kind: string, updatedAt: string|null, creatures: object[] }}
 */
function emptyCatalog(genreId, kindId = DEFAULT_KIND) {
    getGenre(genreId);
    const kind = getAssetKind(kindId);
    return {
        version: CATALOG_VERSION,
        genre: genreId,
        kind: kind.id,
        updatedAt: null,
        creatures: []
    };
}

/**
 * Infer status from sprite path presence.
 * @param {{ original?: string|null, transformed?: string|null }} sprites
 * @returns {CreatureStatus}
 */
function statusFromSprites(sprites) {
    const hasO = Boolean(sprites && sprites.original);
    const hasT = Boolean(sprites && sprites.transformed);
    if (hasO && hasT) return STATUSES.READY;
    if (hasO) return STATUSES.ORIGINAL_ONLY;
    if (hasT) return STATUSES.LEGACY_TRANSFORMED;
    return STATUSES.PLANNED;
}

/**
 * Load genre+kind catalog from disk. Missing file → empty catalog.
 * @param {string} genreId
 * @param {{ path?: string, kind?: string }} [options]
 */
function loadCatalog(genreId, options = {}) {
    getGenre(genreId);
    const kindId = options.kind || DEFAULT_KIND;
    const kind = getAssetKind(kindId);
    const file = options.path || genrePaths(genreId, kindId).manifest;
    if (!fs.existsSync(file)) {
        return emptyCatalog(genreId, kindId);
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Invalid catalog JSON: ${file}`);
    }
    if (raw.genre && raw.genre !== genreId) {
        throw new Error(
            `Catalog genre mismatch: file has "${raw.genre}", expected "${genreId}" (${file})`
        );
    }
    // Disk may use `creatures` (legacy/creatures kind) or `items` (other kinds).
    const entries = Array.isArray(raw.creatures)
        ? raw.creatures
        : Array.isArray(raw.items)
          ? raw.items
          : [];
    return {
        version: raw.version || CATALOG_VERSION,
        genre: genreId,
        kind: kind.id,
        updatedAt: raw.updatedAt || null,
        creatures: entries.slice()
    };
}

/**
 * Write catalog JSON (pretty, trailing newline).
 * @param {{ version?: number, genre: string, kind?: string, creatures: object[] }} catalog
 * @param {{ path?: string, kind?: string }} [options]
 * @returns {string} path written
 */
function saveCatalog(catalog, options = {}) {
    const genreId = catalog.genre;
    getGenre(genreId);
    const kindId = options.kind || catalog.kind || DEFAULT_KIND;
    const kind = getAssetKind(kindId);
    const file = options.path || genrePaths(genreId, kindId).manifest;
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });

    const arrayKey = kind.catalogArrayKey || 'items';
    /** @type {Record<string, unknown>} */
    const out = {
        version: catalog.version || CATALOG_VERSION,
        genre: genreId,
        kind: kind.id,
        updatedAt: new Date().toISOString(),
        [arrayKey]: catalog.creatures || []
    };

    fs.writeFileSync(file, formatJson(out), 'utf8');
    catalog.updatedAt = out.updatedAt;
    catalog.kind = kind.id;
    return file;
}

/**
 * @param {{ creatures: object[] }} catalog
 * @param {string} id
 */
function findById(catalog, id) {
    return (catalog.creatures || []).find((c) => c.id === id) || null;
}

/**
 * Case-insensitive match on technical name.
 * @param {{ creatures: object[] }} catalog
 * @param {string} technical
 */
function findByTechnical(catalog, technical) {
    const key = String(technical).trim().toLowerCase();
    return (
        (catalog.creatures || []).find(
            (c) => String(c.technical).trim().toLowerCase() === key
        ) || null
    );
}

/**
 * @param {{ creatures: object[] }} catalog
 * @param {{ status?: string, source?: string, tag?: string }} [filter]
 */
function listCreatures(catalog, filter = {}) {
    let list = catalog.creatures || [];
    if (filter.status) {
        list = list.filter((c) => c.status === filter.status);
    }
    if (filter.source) {
        list = list.filter((c) => c.source === filter.source);
    }
    if (filter.tag) {
        list = list.filter((c) => Array.isArray(c.tags) && c.tags.includes(filter.tag));
    }
    return list;
}

/**
 * Insert or merge a creature record by `id` (or derived from technical).
 * @param {{ creatures: object[] }} catalog
 * @param {object} partial
 * @returns {object} the stored record
 */
function upsertCreature(catalog, partial) {
    if (!partial || (!partial.id && !partial.technical)) {
        throw new Error('upsertCreature requires id or technical');
    }
    const technical = partial.technical
        ? String(partial.technical).trim()
        : fileStemToTechnical(partial.id);
    const id = partial.id || technicalToId(technical);
    const genre = partial.genre || catalog.genre;

    const sprites = {
        original:
            partial.sprites && 'original' in partial.sprites
                ? partial.sprites.original
                : null,
        transformed:
            partial.sprites && 'transformed' in partial.sprites
                ? partial.sprites.transformed
                : null
    };

    const existing = findById(catalog, id);
    const mergedSprites = existing
        ? {
              original:
                  partial.sprites && 'original' in partial.sprites
                      ? partial.sprites.original
                      : existing.sprites?.original ?? null,
              transformed:
                  partial.sprites && 'transformed' in partial.sprites
                      ? partial.sprites.transformed
                      : existing.sprites?.transformed ?? null
          }
        : sprites;

    const status =
        partial.status ||
        statusFromSprites(mergedSprites);

    let scaleFilter = DEFAULT_SCALE_FILTER;
    if (Object.prototype.hasOwnProperty.call(partial, 'scaleFilter')) {
        scaleFilter = resolveScaleFilter(partial.scaleFilter);
    } else if (existing && Object.prototype.hasOwnProperty.call(existing, 'scaleFilter')) {
        scaleFilter = resolveScaleFilter(existing.scaleFilter);
    }
    const record = withOptionalScaleFilter(
        {
            id,
            technical: existing && !partial.technical ? existing.technical : technical,
            alias:
                partial.alias ||
                existing?.alias ||
                deriveAliasFromTechnical(technical),
            genre,
            kind: partial.kind || existing?.kind || catalog.kind || DEFAULT_KIND,
            category:
                partial.category != null
                    ? partial.category
                    : existing?.category ?? null,
            opaqueAlpha:
                partial.opaqueAlpha !== undefined
                    ? Boolean(partial.opaqueAlpha)
                    : existing && existing.opaqueAlpha !== undefined
                      ? Boolean(existing.opaqueAlpha)
                      : resolveOpaqueAlpha(
                            undefined,
                            partial.kind || existing?.kind || catalog.kind
                        ),
            status,
            sprites: mergedSprites,
            tags: Array.isArray(partial.tags)
                ? partial.tags.slice()
                : existing?.tags
                  ? existing.tags.slice()
                  : [],
            source: partial.source || existing?.source || SOURCES.PIPELINE,
            createdAt:
                partial.createdAt ||
                existing?.createdAt ||
                new Date().toISOString().slice(0, 10)
        },
        scaleFilter
    );
    const wang =
        parseWangId(id) ||
        parseWangId(record.technical) ||
        (partial.wangFamily != null || existing?.wangFamily != null
            ? {
                  family: partial.wangFamily || existing.wangFamily,
                  mask:
                      partial.wangMask != null
                          ? partial.wangMask
                          : existing?.wangMask
              }
            : null);
    if (wang && wang.family != null && wang.mask != null) {
        record.wangFamily = wang.family;
        record.wangMask = wang.mask;
        if (wang.inner) record.wangInner = wang.inner;
        else if (partial.wangInner) record.wangInner = String(partial.wangInner).toLowerCase();
        if (!record.category) record.category = wang.family;
    }
    const wall =
        parseWallId(id) ||
        parseWallId(record.technical) ||
        (partial.wallFamily != null ||
        existing?.wallFamily != null ||
        partial.wallAlign != null ||
        existing?.wallAlign != null
            ? {
                  family: partial.wallFamily || existing?.wallFamily,
                  align: partial.wallAlign || existing?.wallAlign
              }
            : null);
    if (wall && wall.family && wall.align && record.kind === 'objects') {
        record.wallFamily = wall.family;
        record.wallAlign = wall.align;
        if (!record.category) record.category = 'wall';
        delete record.wangFamily;
    }

    if (existing) {
        const idx = catalog.creatures.findIndex((c) => c.id === id);
        catalog.creatures[idx] = record;
    } else {
        catalog.creatures.push(record);
    }
    return record;
}

/**
 * List PNG basenames (no path) in a directory; empty if missing.
 * @param {string} dir
 * @returns {string[]}
 */
function listPngStems(dir) {
    if (!fs.existsSync(dir)) {
        return [];
    }
    return fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.png'))
        .map((f) => f.replace(/\.png$/i, ''))
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Sole category id when the kind declares exactly one (e.g. ui → spells).
 * Multi-category kinds stay unset so inventory does not guess.
 * @param {{ categories?: string[] }} kind
 * @returns {string|null}
 */
function defaultCategoryForKind(kind) {
    const cats = Array.isArray(kind && kind.categories) ? kind.categories : [];
    return cats.length === 1 && cats[0] ? String(cats[0]) : null;
}

/**
 * technical (lowercased) → alias from `technical\\talias` done-list lines.
 * @param {string} doneFile
 * @returns {Map<string, string>}
 */
function loadDoneAliasMap(doneFile) {
    /** @type {Map<string, string>} */
    const map = new Map();
    if (!doneFile || !fs.existsSync(doneFile)) {
        return map;
    }
    let text = '';
    try {
        text = fs.readFileSync(doneFile, 'utf8');
    } catch {
        return map;
    }
    for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tab = trimmed.indexOf('\t');
        if (tab < 0) continue;
        const technical = trimmed.slice(0, tab).trim();
        const alias = trimmed.slice(tab + 1).trim();
        if (!technical || !alias) continue;
        map.set(technical.toLowerCase(), alias);
    }
    return map;
}

/**
 * ISO date from file mtime (YYYY-MM-DD).
 * @param {string} filePath
 */
function dateFromMtime(filePath) {
    try {
        const st = fs.statSync(filePath);
        return st.mtime.toISOString().slice(0, 10);
    } catch {
        return new Date().toISOString().slice(0, 10);
    }
}

/**
 * Scan original/ PNGs for a genre+kind and build a merged catalog.
 * The transformed/ folder is intentionally ignored (not inventoried).
 * Existing catalog entries keep alias, tags, source, createdAt, scaleFilter when id matches.
 *
 * @param {string} genreId
 * @param {{ merge?: boolean, existing?: object, kind?: string }} [options]
 * @returns {{
 *   catalog: object,
 *   stats: { original: number, added: number, updated: number, total: number }
 * }}
 */
function inventoryGenre(genreId, options = {}) {
    const merge = options.merge !== false;
    const kindId = options.kind || DEFAULT_KIND;
    const kind = getAssetKind(kindId);
    const paths = genrePaths(genreId, kindId);
    const folder = paths.genre.folder;
    const kindFolder = kind.folder;

    const existing = merge
        ? options.existing || loadCatalog(genreId, { kind: kindId })
        : emptyCatalog(genreId, kindId);

    const originalStems = listPngStems(paths.original);
    const originalIds = new Set(originalStems.map((s) => s.toLowerCase()));
    const doneAliases = loadDoneAliasMap(paths.doneFile);
    const defaultCategory = defaultCategoryForKind(kind);

    /** @type {Map<string, object>} */
    const byId = new Map();

    // Seed merge only with planned/manual concepts or rows that match an original stem.
    if (merge) {
        for (const c of existing.creatures) {
            const keep =
                originalIds.has(c.id) ||
                c.status === STATUSES.PLANNED ||
                c.source === SOURCES.MANUAL;
            if (!keep) continue;
            byId.set(c.id, {
                ...c,
                sprites: {
                    original: c.sprites?.original ?? null,
                    transformed: null
                }
            });
        }
    }

    let added = 0;
    let updated = 0;

    for (const stem of originalStems) {
        const id = stem.toLowerCase();
        const technical = fileStemToTechnical(stem);
        const rel = repoPath(
            'assets',
            'sprites',
            folder,
            kindFolder,
            'original',
            `${stem}.png`
        );
        const abs = path.join(paths.original, `${stem}.png`);

        let rec = byId.get(id);
        const doneAlias = doneAliases.get(technical.toLowerCase()) || null;
        const wang = parseWangId(stem) || parseWangId(id);
        const wall = kindId === 'objects' ? parseWallId(stem) || parseWallId(id) : null;
        if (!rec) {
            rec = {
                id,
                technical,
                alias: doneAlias || deriveAliasFromTechnical(technical),
                genre: genreId,
                kind: kindId,
                category:
                    (wang && wang.family) ||
                    (wall ? 'wall' : null) ||
                    defaultCategory,
                status: STATUSES.ORIGINAL_ONLY,
                sprites: { original: rel, transformed: null },
                tags: wang
                    ? [wang.family]
                    : wall
                      ? [wall.family]
                      : defaultCategory
                        ? [defaultCategory]
                        : [],
                opaqueAlpha: resolveOpaqueAlpha(undefined, kindId),
                source: SOURCES.PIPELINE,
                createdAt: dateFromMtime(abs)
            };
            if (wang) {
                rec.wangFamily = wang.family;
                rec.wangMask = wang.mask;
                if (wang.inner) rec.wangInner = wang.inner;
            }
            if (wall) {
                rec.wallFamily = wall.family;
                rec.wallAlign = wall.align;
                rec.category = rec.category || 'wall';
                delete rec.wangFamily;
            }
            byId.set(id, rec);
            added += 1;
        } else {
            updated += 1;
            if (!rec.technical) rec.technical = technical;
            if (!rec.alias) {
                rec.alias = doneAlias || deriveAliasFromTechnical(rec.technical);
            } else if (
                doneAlias &&
                rec.alias === deriveAliasFromTechnical(rec.technical)
            ) {
                rec.alias = doneAlias;
            }
            if (!rec.genre) rec.genre = genreId;
            if (!rec.kind) rec.kind = kindId;
            if (wang) {
                if (!rec.wangFamily) rec.wangFamily = wang.family;
                if (rec.wangMask == null) rec.wangMask = wang.mask;
                if (wang.inner && !rec.wangInner) rec.wangInner = wang.inner;
                if (!rec.category) rec.category = wang.family;
            }
            if (wall) {
                if (!rec.wallFamily) rec.wallFamily = wall.family;
                if (!rec.wallAlign) rec.wallAlign = wall.align;
                if (!rec.category) rec.category = 'wall';
                if (rec.wallFamily) delete rec.wangFamily;
            }
            if (!rec.category && defaultCategory) rec.category = defaultCategory;
            if (!Array.isArray(rec.tags)) rec.tags = [];
            if (rec.category && rec.tags.length === 0) rec.tags = [rec.category];
            rec.sprites = { original: rel, transformed: null };
            rec.status = STATUSES.ORIGINAL_ONLY;
            if (!rec.source || rec.source === SOURCES.LEGACY) {
                rec.source = SOURCES.PIPELINE;
            }
        }
    }

    for (const rec of byId.values()) {
        if (!rec.sprites?.original) {
            rec.sprites = {
                original: null,
                transformed: null
            };
            rec.status = STATUSES.PLANNED;
        } else {
            rec.sprites.transformed = null;
            rec.status = STATUSES.ORIGINAL_ONLY;
        }
    }

    const creatures = Array.from(byId.values()).sort((a, b) =>
        a.id.localeCompare(b.id)
    );

    const catalog = {
        version: CATALOG_VERSION,
        genre: genreId,
        kind: kindId,
        updatedAt: existing.updatedAt || null,
        creatures
    };

    return {
        catalog,
        stats: {
            original: originalStems.length,
            added,
            updated,
            total: creatures.length
        }
    };
}

/**
 * Inventory every registered genre (default kind) or every genre×kind.
 * @param {{ merge?: boolean, kind?: string, allKinds?: boolean }} [options]
 */
function inventoryAll(options = {}) {
    /** @type {Record<string, ReturnType<typeof inventoryGenre>>} */
    const out = {};
    const kinds = options.allKinds
        ? listKindIds()
        : [options.kind || DEFAULT_KIND];
    for (const genreId of Object.keys(GENRES)) {
        for (const kindId of kinds) {
            const key = options.allKinds ? `${genreId}/${kindId}` : genreId;
            out[key] = inventoryGenre(genreId, { ...options, kind: kindId });
        }
    }
    return out;
}

module.exports = {
    CATALOG_VERSION,
    STATUSES,
    SOURCES,
    SCALE_FILTERS,
    DEFAULT_SCALE_FILTER,
    resolveOpaqueAlpha,
    resolveScaleFilter,
    technicalToId,
    technicalToFileStem,
    fileStemToTechnical,
    deriveAliasFromTechnical,
    repoPath,
    absoluteSpritePath,
    emptyCatalog,
    statusFromSprites,
    loadCatalog,
    saveCatalog,
    findById,
    findByTechnical,
    listCreatures,
    upsertCreature,
    listPngStems,
    defaultCategoryForKind,
    loadDoneAliasMap,
    inventoryGenre,
    inventoryAll
};
