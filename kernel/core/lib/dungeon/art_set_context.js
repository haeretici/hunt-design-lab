/**
 * Art-set role → catalog family (tiles / objects / overlays) + picker category.
 * Scenery / furniture are objects; terrain roles are tiles unless entry.kind
 * says overlays (path/water families) or objects + wallFamily (P4 faces).
 * Pack-level `kind` (usually tiles) is NOT the scenery default.
 * Bind still treats omitted path/water kind as tiles (existing packs).
 */

'use strict';

const { parseWangId, wangCatalogId } = require('../overlay_wang.js');
const { parseWallId, wallCatalogId } = require('../wall_wang.js');

const OBJECT_ROLE_KEYS = Object.freeze({
    scenery: true,
    furniture: true
});

/** Tile catalog category to preselect from a pack role key. */
const TILE_CATEGORY_BY_ROLE = Object.freeze({
    floor: 'floor',
    path: 'path',
    wall: 'wall',
    water: 'water',
    special: 'special',
    stairs: 'special',
    stairs_up: 'special',
    stairs_down: 'special',
    hole: 'special',
    rope_spot: 'special',
    shovel_spot: 'special'
});

/** Object catalog category to preselect (scenery stays unfiltered). */
const OBJECT_CATEGORY_BY_ROLE = Object.freeze({
    furniture: 'furniture',
    wall: 'wall'
});

/** Overlay family to preselect from a pack role key. */
const OVERLAY_CATEGORY_BY_ROLE = Object.freeze({
    path: 'dirt',
    water: 'water'
});

/**
 * @param {unknown} raw
 * @returns {''|'tiles'|'objects'|'overlays'}
 */
function normalizeCatalogKind(raw) {
    const k = String(raw || '')
        .trim()
        .toLowerCase();
    if (k === 'objects' || k === 'object') return 'objects';
    if (k === 'tiles' || k === 'tile') return 'tiles';
    if (k === 'overlays' || k === 'overlay') return 'overlays';
    return '';
}

/**
 * @param {string} [path] json-editor path e.g. root.roles.scenery.0.id
 * @returns {string}
 */
function inferRoleKeyFromPath(path) {
    const m = String(path || '').match(/\.roles\.([a-zA-Z0-9_]+)/);
    return m ? m[1].toLowerCase() : '';
}

/**
 * Default catalog family for a pack role key / tile role id.
 * Empty when there is no role context (caller uses pack/schema fallback).
 * @param {string} [roleKey]
 * @param {string} [roleId]
 * @returns {''|'tiles'|'objects'|'overlays'}
 */
function defaultCatalogKindForRole(roleKey, roleId) {
    const r = String(roleKey || '').toLowerCase();
    const rid = String(roleId || '').toLowerCase();
    if (
        OBJECT_ROLE_KEYS[r] ||
        r.indexOf('scenery') === 0 ||
        r.indexOf('furniture') === 0
    ) {
        return 'objects';
    }
    if (rid.indexOf('scenery') === 0 || rid.indexOf('furniture') === 0) {
        return 'objects';
    }
    if (r || rid) return 'tiles';
    return '';
}

/**
 * @param {string} assetKind
 * @param {string} [roleKey]
 * @returns {string}
 */
function catalogCategoryForRole(assetKind, roleKey) {
    const r = String(roleKey || '').toLowerCase();
    if (assetKind === 'objects') {
        return OBJECT_CATEGORY_BY_ROLE[r] || '';
    }
    if (assetKind === 'overlays') {
        return OVERLAY_CATEGORY_BY_ROLE[r] || '';
    }
    if (assetKind === 'tiles') {
        return TILE_CATEGORY_BY_ROLE[r] || '';
    }
    return '';
}

/**
 * Fields to write on an art-set role entry after a catalog pick.
 * Overlay → kind overlays + wangFamily + *_wang_15.
 * Wall face → kind objects + wallFamily + wallAlign pole + *_pole.
 * Else → kind tiles|objects and clear family keys.
 * @param {unknown} pickedId
 * @param {Record<string, unknown>|null|undefined} [meta]
 * @returns {{
 *   id: string,
 *   kind: 'tiles'|'objects'|'overlays',
 *   wangFamily: string,
 *   wallFamily: string,
 *   wallAlign: string
 * }}
 */
function artSetPickFields(pickedId, meta) {
    const id = String(pickedId || '').trim();
    const kindFromMeta = normalizeCatalogKind(
        meta && (meta.assetKind != null ? meta.assetKind : meta.kind)
    );
    const category = String((meta && meta.category) || '')
        .trim()
        .toLowerCase();
    const parsedWang = parseWangId(id);
    const parsedWall = parseWallId(id);

    if (kindFromMeta === 'overlays' || parsedWang) {
        const family = parsedWang
            ? parsedWang.family
            : category === 'dirt' || category === 'water' || category === 'cobble'
              ? category
              : '';
        return {
            id: family ? wangCatalogId(family, 15) : id,
            kind: 'overlays',
            wangFamily: family,
            wallFamily: '',
            wallAlign: ''
        };
    }

    if (parsedWall && kindFromMeta !== 'tiles') {
        return {
            id: wallCatalogId(parsedWall.family, 'pole'),
            kind: 'objects',
            wangFamily: '',
            wallFamily: parsedWall.family,
            wallAlign: 'pole'
        };
    }

    return {
        id,
        kind: kindFromMeta || 'tiles',
        wangFamily: '',
        wallFamily: '',
        wallAlign: ''
    };
}

module.exports = {
    OBJECT_ROLE_KEYS,
    TILE_CATEGORY_BY_ROLE,
    OBJECT_CATEGORY_BY_ROLE,
    OVERLAY_CATEGORY_BY_ROLE,
    normalizeCatalogKind,
    inferRoleKeyFromPath,
    defaultCatalogKindForRole,
    catalogCategoryForRole,
    artSetPickFields
};
