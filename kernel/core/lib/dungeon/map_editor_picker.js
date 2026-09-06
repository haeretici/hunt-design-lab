/**
 * Map editor dock palette helpers (Phase A): stamp filter, short labels,
 * RAW catalog stamps, World recents from Designer picker Apply.
 * Pure — no DOM. Wiki page wires thumbs + popups.
 */

'use strict';

const { parseWangId } = require('../overlay_wang.js');
const { parseWallId } = require('../wall_wang.js');
const { autoTileOf } = require('../overlay_border.js');

const RAW_KIND_TILES = 'tiles';
const RAW_KIND_OVERLAYS = 'overlays';
const RAW_KIND_OBJECTS = 'objects';

/**
 * @param {string|null|undefined} subLayer
 * @returns {'tiles'|'overlays'|'objects'}
 */
function defaultRawKindForSubLayer(subLayer) {
    const sub = String(subLayer || '');
    if (sub === 'path') return RAW_KIND_OVERLAYS;
    if (sub === 'ground') return RAW_KIND_TILES;
    return RAW_KIND_OBJECTS;
}

/**
 * @param {string|null|undefined} kind
 * @returns {'tiles'|'overlays'|'objects'}
 */
function normalizeRawKind(kind) {
    const k = String(kind || '').trim().toLowerCase();
    if (k === RAW_KIND_OBJECTS || k === RAW_KIND_OVERLAYS) return k;
    return RAW_KIND_TILES;
}

/**
 * @param {object|null|undefined} stamp
 * @returns {string}
 */
function stampSearchText(stamp) {
    if (!stamp || typeof stamp !== 'object') return '';
    return [
        stamp.catalogId,
        stamp.label,
        stamp.wangFamily,
        stamp.wallFamily,
        stamp.autoTile && stamp.autoTile.family,
        stamp.roleId,
        stamp.artRole,
        stamp.kind
    ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
}

/**
 * @param {object|null|undefined} stamp
 * @param {string} [query]
 * @returns {boolean}
 */
function stampMatchesFilter(stamp, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    return stampSearchText(stamp).indexOf(q) !== -1;
}

/**
 * @param {object[]} stamps
 * @param {string} [query]
 * @returns {object[]}
 */
function filterStamps(stamps, query) {
    const list = Array.isArray(stamps) ? stamps : [];
    if (!String(query || '').trim()) return list.slice();
    return list.filter((s) => stampMatchesFilter(s, query));
}

/**
 * Short dock label. Tooltip stays the catalog id.
 * @param {object|null|undefined} stamp
 * @returns {string}
 */
function stampDockLabel(stamp) {
    if (!stamp || typeof stamp !== 'object') return '';
    if (stamp.wangFamily) return String(stamp.wangFamily);
    if (stamp.wallFamily) return String(stamp.wallFamily);
    if (stamp.autoTile && stamp.autoTile.family) return String(stamp.autoTile.family);
    const label = String(stamp.label || stamp.catalogId || '').trim();
    if (label.length <= 16) return label;
    const id = String(stamp.catalogId || label);
    const parts = id.split('_').filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join('_');
    return label.slice(0, 16);
}

/**
 * RAW catalog stamp (wiki Apply / picker Apply). Overlay/wall ids lock resolve.
 * Variation fill / border12 fill / wallFront mid / rect9 center stay family
 * brushes (not locked). Edge / alt / wallFront cap+extra / rect9 non-center
 * ids lock. `autoTile.kind: none` scenery objects stamp as-is.
 * @param {{
 *   catalogId?: string,
 *   kind?: string,
 *   subLayer?: string,
 *   category?: string,
 *   autoTile?: object|null,
 *   anim?: { frames: number, fps?: number }|null,
 *   autoTileIndex?: object|null,
 *   previewColors?: Record<string, string>
 * }} opts
 * @returns {object|null}
 */
function makeRawCatalogStamp(opts) {
    const o = opts || {};
    const catalogId = String(o.catalogId || '').trim();
    if (!catalogId) return null;
    let kind = normalizeRawKind(o.kind);
    const sub = String(o.subLayer || 'ground');
    const parsed = kind === RAW_KIND_OVERLAYS ? parseWangId(catalogId) : null;
    const wallParsed = kind === RAW_KIND_OBJECTS ? parseWallId(catalogId) : null;
    const at = autoTileOf(o.autoTile ? { catalogId, autoTile: o.autoTile } : catalogId, o.autoTileIndex);
    if (at && at.kind === 'border12' && at.slot !== 'fill') kind = RAW_KIND_OVERLAYS;
    if (at && ((at.kind === 'border12' && at.slot === 'fill') || at.kind === 'variation')) {
        kind = RAW_KIND_TILES;
    }
    if (at && at.kind === 'wallFront') kind = RAW_KIND_OBJECTS;
    if (at && at.kind === 'rect9') {
        kind = o.kind === RAW_KIND_OBJECTS ? RAW_KIND_OBJECTS : RAW_KIND_OVERLAYS;
    }
    if (at && at.kind === 'none') kind = normalizeRawKind(o.kind);
    const category = String(o.category || '').trim().toLowerCase();
    const roleId =
        at && at.kind === 'wallFront'
            ? 'wall'
            : at && at.kind === 'rect9'
              ? kind === RAW_KIND_OBJECTS
                  ? 'scenery_blocking'
                  : 'path'
              : at && at.kind === 'none'
                ? category === 'rock'
                    ? 'scenery_blocking'
                    : category === 'deco' || category === 'tree'
                      ? 'scenery_cover'
                      : kind === RAW_KIND_OBJECTS
                        ? 'scenery_cover'
                        : null
                : at && at.kind === 'border12' && at.slot === 'fill'
                  ? 'water'
                  : at && at.kind === 'variation'
                    ? 'floor'
                    : kind === RAW_KIND_OVERLAYS
                      ? parsed && parsed.family === 'water'
                          ? 'water'
                          : 'path'
                      : wallParsed
                        ? 'wall'
                        : category === 'water'
                          ? 'water'
                          : sub === 'ground'
                            ? 'floor'
                            : null;
    const colors = o.previewColors && typeof o.previewColors === 'object' ? o.previewColors : {};
    const familyBrush = !!(
        at &&
        ((at.kind === 'border12' && at.slot === 'fill') ||
            (at.kind === 'variation' && at.slot === 'fill') ||
            (at.kind === 'wallFront' && at.slot === 'mid') ||
            (at.kind === 'rect9' && at.slot === 'c'))
    );
    const lockResolve =
        !familyBrush &&
        (!!(kind === RAW_KIND_OVERLAYS && parsed) ||
            !!wallParsed ||
            !!(at && at.kind === 'border12' && at.slot !== 'fill') ||
            !!(at && at.kind === 'variation' && at.slot !== 'fill') ||
            !!(at && at.kind === 'wallFront' && at.slot !== 'mid') ||
            !!(at && at.kind === 'rect9' && at.slot !== 'c'));
    return {
        catalogId,
        kind,
        roleId,
        subLayer:
            at && at.kind === 'wallFront'
                ? 'vertical'
                : at && at.kind === 'rect9'
                  ? kind === RAW_KIND_OBJECTS
                      ? 'scenery'
                      : 'path'
                  : at && at.kind === 'none' && kind === RAW_KIND_OBJECTS
                    ? 'scenery'
                    : at && at.kind === 'border12' && at.slot === 'fill'
                      ? 'ground'
                      : at && at.kind === 'variation'
                        ? 'ground'
                        : kind === RAW_KIND_OVERLAYS
                          ? 'path'
                          : wallParsed
                            ? 'vertical'
                            : sub,
        wangFamily: parsed ? parsed.family : undefined,
        wangMask: parsed ? parsed.mask : undefined,
        wallFamily: wallParsed && !(at && at.kind === 'wallFront') ? wallParsed.family : undefined,
        wallAlign: wallParsed && !(at && at.kind === 'wallFront') ? wallParsed.align : undefined,
        autoTile: at || undefined,
        anim:
            o.anim && typeof o.anim === 'object' && Number(o.anim.frames) > 0
                ? {
                      frames: Number(o.anim.frames) | 0,
                      fps: Number(o.anim.fps) > 0 ? Number(o.anim.fps) : 4
                  }
                : undefined,
        wangLocked: lockResolve,
        borderLocked: !!(at && at.kind === 'border12' && at.slot !== 'fill'),
        wangResolve: lockResolve ? false : familyBrush ? true : false,
        label: catalogId + (familyBrush ? '' : ' (RAW)'),
        previewColor: (roleId && colors[roleId]) || '#666666'
    };
}

/**
 * @param {unknown} value
 * @param {string} [catalogKind]
 * @returns {{ id: string, name: string, catalogKind: 'objects'|'equipment' }|null}
 */
function worldPaletteItemFromPick(value, catalogKind) {
    if (value == null) return null;
    if (typeof value === 'string') {
        const id = value.trim();
        if (!id) return null;
        const kind = catalogKind === 'equipment' ? 'equipment' : 'objects';
        return { id, name: id, catalogKind: kind };
    }
    if (typeof value !== 'object') return null;
    const rec = /** @type {Record<string, unknown>} */ (value);
    const id = String(rec.id || '').trim();
    if (!id) return null;
    const name = String(rec.label || rec.name || id);
    const rawKind = catalogKind || rec.assetKind || rec.catalogKind || 'objects';
    const kind = rawKind === 'equipment' ? 'equipment' : 'objects';
    return { id, name, catalogKind: kind };
}

/**
 * @param {object[]} list
 * @param {{ id: string, name?: string, catalogKind?: string }} item
 * @returns {{ list: object[], item: object, added: boolean }}
 */
function upsertWorldPalette(list, item) {
    if (!item || !item.id) {
        return { list: Array.isArray(list) ? list.slice() : [], item: null, added: false };
    }
    const next = Array.isArray(list) ? list.slice() : [];
    for (let i = 0; i < next.length; i++) {
        const row = next[i];
        if (row && row.id === item.id) {
            if (item.name) row.name = item.name;
            if (item.catalogKind) row.catalogKind = item.catalogKind;
            return { list: next, item: row, added: false };
        }
    }
    next.push(item);
    return { list: next, item, added: true };
}

const ART_SET_ID_RE = /^[a-z][a-z0-9_]{0,79}$/;

/**
 * @param {unknown} raw
 * @param {string[]} [allowed]
 * @returns {string}
 */
function normalizeArtSetId(raw, allowed) {
    const id = String(raw || '').trim();
    if (!ART_SET_ID_RE.test(id)) return '';
    if (Array.isArray(allowed) && allowed.length && allowed.indexOf(id) < 0) return '';
    return id;
}

/**
 * Pick the art set to show: per-map store, then map id if it is an art set,
 * then last-used (page reload), then keep/fallback.
 * @param {{
 *   mapId?: string,
 *   byMap?: Record<string, string>,
 *   lastId?: string,
 *   keepId?: string,
 *   preferKeep?: boolean,
 *   allowed?: string[],
 *   fallback?: string
 * }} [opts]
 * @returns {string}
 */
function pickStoredArtSetId(opts) {
    const o = opts || {};
    const allowed = Array.isArray(o.allowed) ? o.allowed : [];
    const fallback = normalizeArtSetId(o.fallback, allowed) || 'cave_simple';
    const byMap = o.byMap && typeof o.byMap === 'object' ? o.byMap : {};
    const mapId = String(o.mapId || '');
    const fromMap = normalizeArtSetId(byMap[mapId], allowed);
    if (fromMap) return fromMap;
    const sameName = normalizeArtSetId(mapId, allowed);
    if (sameName) return sameName;
    if (o.preferKeep) {
        const keep = normalizeArtSetId(o.keepId, allowed);
        if (keep) return keep;
    }
    const last = normalizeArtSetId(o.lastId, allowed);
    if (last) return last;
    return fallback;
}

/**
 * @param {Record<string, string>|null|undefined} prev
 * @param {string} mapId
 * @param {string} artSetId
 * @returns {Record<string, string>}
 */
function mergeArtSetByMap(prev, mapId, artSetId) {
    const next = prev && typeof prev === 'object' ? Object.assign({}, prev) : {};
    const m = String(mapId || '').trim();
    const a = String(artSetId || '').trim();
    if (!m || !a) return next;
    next[m] = a;
    return next;
}

/**
 * Unique hybrid palette intern rows (index 0 empty skipped).
 * @param {Array<object|null|undefined>|null|undefined} palette
 * @returns {object[]}
 */
function collectPaletteCatalogEntries(palette) {
    /** @type {object[]} */
    const out = [];
    const seen = Object.create(null);
    const list = Array.isArray(palette) ? palette : [];
    for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || typeof e !== 'object') continue;
        const catalogId = String(e.catalogId || e.id || '').trim();
        if (!catalogId || seen[catalogId]) continue;
        seen[catalogId] = true;
        out.push({
            catalogId,
            kind: normalizeRawKind(e.kind),
            roleId: e.roleId || null,
            wangLocked: !!e.wangLocked,
            borderLocked: !!e.borderLocked,
            autoTile: e.autoTile || null,
            anim: e.anim || null,
            category: e.category || null
        });
    }
    return out;
}

/**
 * @param {object[]} list
 * @param {object|null|undefined} entry
 * @returns {{ list: object[], item: object|null, added: boolean }}
 */
function upsertRawRecent(list, entry) {
    if (!entry || !entry.catalogId) {
        return { list: Array.isArray(list) ? list.slice() : [], item: null, added: false };
    }
    const next = Array.isArray(list) ? list.slice() : [];
    for (let i = 0; i < next.length; i++) {
        const row = next[i];
        if (row && row.catalogId === entry.catalogId) {
            if (entry.kind) row.kind = entry.kind;
            if (entry.roleId) row.roleId = entry.roleId;
            if (entry.autoTile) row.autoTile = entry.autoTile;
            if (entry.anim) row.anim = entry.anim;
            row.wangLocked = !!entry.wangLocked;
            row.borderLocked = !!entry.borderLocked;
            return { list: next, item: row, added: false };
        }
    }
    next.push(entry);
    return { list: next, item: entry, added: true };
}

/**
 * Unique world-pin catalog ids (palette items).
 * @param {Array<object|null|undefined>|null|undefined} pins
 * @returns {object[]}
 */
function collectWorldCatalogItems(pins) {
    /** @type {object[]} */
    const out = [];
    const seen = Object.create(null);
    const list = Array.isArray(pins) ? pins : [];
    for (let i = 0; i < list.length; i++) {
        const pin = list[i];
        if (!pin) continue;
        const item = worldPaletteItemFromPick(
            pin.catalogId != null ? String(pin.catalogId) : pin,
            pin.catalogKind
        );
        if (!item || seen[item.id]) continue;
        seen[item.id] = true;
        out.push(item);
    }
    return out;
}

/**
 * @param {object[]} palette
 * @param {Array<object|null|undefined>|null|undefined} pins
 * @returns {object[]}
 */
function seedWorldPaletteFromPins(palette, pins) {
    let next = Array.isArray(palette) ? palette.slice() : [];
    const items = collectWorldCatalogItems(pins);
    for (let i = 0; i < items.length; i++) {
        next = upsertWorldPalette(next, items[i]).list;
    }
    return next;
}

module.exports = {
    defaultRawKindForSubLayer,
    normalizeRawKind,
    stampSearchText,
    stampMatchesFilter,
    filterStamps,
    stampDockLabel,
    makeRawCatalogStamp,
    worldPaletteItemFromPick,
    upsertWorldPalette,
    ART_SET_ID_RE,
    normalizeArtSetId,
    pickStoredArtSetId,
    mergeArtSetByMap,
    collectPaletteCatalogEntries,
    upsertRawRecent,
    collectWorldCatalogItems,
    seedWorldPaletteFromPins
};
