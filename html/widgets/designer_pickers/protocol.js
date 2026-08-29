/**
 * Shared constants for Designer / Wiki catalog browsers
 * (equipment, combat creatures, tile catalog, spell shape).
 * Parent (bundled) and child popups must agree on channel / message types.
 *
 * Catalog picker (tile_picker.html) is kind-agnostic: tiles, creatures sprites, etc.
 * Message kind for catalog sessions is `catalog`.
 *
 * Equipment + combat creature browsers support dual uiMode:
 *   select — popup picker (Cancel / Select footer, postMessage on confirm)
 *   view   — wiki / browse (no picker footer; same grid + detail sidebar)
 */

'use strict';

const DESIGNER_PICKER_CHANNEL = 'hunt-design-lab-designer-picker';

const TILE_PICKER_WINDOW = 'du_tile_picker';
const EQUIPMENT_PICKER_WINDOW = 'du_equipment_picker';
const CREATURE_PICKER_WINDOW = 'du_creature_picker';
const SHAPE_PICKER_WINDOW = 'du_shape_picker';

/** Paths from repo root (resolve with appUrl in the parent). */
const TILE_PICKER_URL_PATH = 'html/widgets/designer_pickers/tile_picker.html';
const EQUIPMENT_PICKER_URL_PATH = 'html/widgets/designer_pickers/equipment_picker.html';
const CREATURE_PICKER_URL_PATH = 'html/widgets/designer_pickers/creature_picker.html';
const SHAPE_PICKER_URL_PATH = 'html/widgets/designer_pickers/shape_picker.html';

/** Dual-mode catalog browsers (equipment + combat creatures). */
const UI_MODE = {
    SELECT: 'select',
    VIEW: 'view'
};

/** Child → parent */
const MSG = {
    READY: 'ready',
    SELECT: 'select',
    CANCEL: 'cancel',
    CLOSING: 'closing'
};

/** Parent → child */
const PARENT_MSG = {
    INIT: 'init'
};

/**
 * Popup window features (similar to Free Edit / Engine Tweakings).
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function popupFeatures(w, h) {
    return [
        `width=${w}`,
        `height=${h}`,
        'menubar=no',
        'toolbar=no',
        'location=no',
        'status=no',
        'resizable=yes',
        'scrollbars=yes'
    ].join(',');
}

/**
 * Normalize dual-mode UI flag.
 * @param {unknown} raw
 * @returns {'select'|'view'}
 */
function normalizeUiMode(raw) {
    const s = String(raw || '')
        .trim()
        .toLowerCase();
    if (s === UI_MODE.VIEW || s === 'browse' || s === 'wiki') return UI_MODE.VIEW;
    return UI_MODE.SELECT;
}

module.exports = {
    DESIGNER_PICKER_CHANNEL,
    TILE_PICKER_WINDOW,
    EQUIPMENT_PICKER_WINDOW,
    CREATURE_PICKER_WINDOW,
    SHAPE_PICKER_WINDOW,
    TILE_PICKER_URL_PATH,
    EQUIPMENT_PICKER_URL_PATH,
    CREATURE_PICKER_URL_PATH,
    SHAPE_PICKER_URL_PATH,
    UI_MODE,
    MSG,
    PARENT_MSG,
    popupFeatures,
    normalizeUiMode
};
