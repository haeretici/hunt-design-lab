/**
 * Shared parent host for Designer / Wiki catalog popups.
 * Map editor and json-editor fields both call openPickerSession — do not fork
 * a second picker page.
 *
 * Protocol: html/widgets/designer_pickers/protocol.js
 */

'use strict';

const { appUrl } = require('../../../kernel/core/lib/app_paths.js');
const {
    DESIGNER_PICKER_CHANNEL,
    TILE_PICKER_WINDOW,
    EQUIPMENT_PICKER_WINDOW,
    TILE_PICKER_URL_PATH,
    EQUIPMENT_PICKER_URL_PATH,
    MSG,
    PARENT_MSG,
    popupFeatures
} = require('./protocol.js');

/** @type {Map<string, { kind: string, apply: (value: unknown) => void, win?: Window|null, initPayload?: Record<string, unknown> }>} */
const pending = new Map();

let requestSeq = 0;
let listenerBound = false;
/** @type {ReturnType<typeof setTimeout>[]} */
const reinitTimers = [];

/**
 * @param {string} kind
 * @returns {string[]}
 */
function catalogCategoriesForKind(kind) {
    if (kind === 'objects') {
        return ['tree', 'rock', 'house', 'wall', 'door', 'furniture', 'container', 'deco'];
    }
    if (kind === 'tiles') {
        return ['floor', 'path', 'wall', 'water', 'special'];
    }
    if (kind === 'overlays') {
        return ['dirt', 'water', 'cobble'];
    }
    return [];
}

/**
 * @returns {string}
 */
function nextRequestId() {
    requestSeq += 1;
    return `du-pick-${Date.now()}-${requestSeq}`;
}

/**
 * Open a named popup; reuses the window if still open.
 * @param {string} url
 * @param {string} name
 * @param {string} features
 * @returns {Window|null}
 */
function openPickerWindow(url, name, features) {
    if (typeof window === 'undefined') return null;
    let win = null;
    try {
        win = window.open(url, name, features);
        if (win && !win.closed) {
            try {
                win.location.href = url;
            } catch (_) {
                /* first open / still loading */
            }
        }
    } catch (err) {
        console.warn('catalog picker popup failed', err);
        return null;
    }
    if (!win) {
        console.warn('catalog picker blocked — allow popups for this site');
        return null;
    }
    try {
        win.focus();
    } catch (_) {
        /* ignore */
    }
    return win;
}

/**
 * @param {string} origin
 * @returns {boolean}
 */
function originOk(origin) {
    if (typeof window === 'undefined') return false;
    try {
        return origin === window.location.origin;
    } catch (_) {
        return false;
    }
}

/**
 * @param {MessageEvent} ev
 */
function handlePickerMessage(ev) {
    if (!ev || !originOk(ev.origin)) return;
    const data = ev.data;
    if (!data || data.channel !== DESIGNER_PICKER_CHANNEL) return;

    const kind = data.kind;
    const type = data.type;
    const requestId = data.requestId != null ? String(data.requestId) : '';

    if (type === MSG.READY) {
        for (const [rid, session] of pending.entries()) {
            if (session.kind !== kind) continue;
            if (session.win && !session.win.closed && ev.source === session.win) {
                try {
                    session.win.postMessage(
                        {
                            channel: DESIGNER_PICKER_CHANNEL,
                            type: PARENT_MSG.INIT,
                            kind,
                            requestId: rid,
                            ...session.initPayload
                        },
                        window.location.origin
                    );
                } catch (err) {
                    console.warn('picker init postMessage failed', err);
                }
                return;
            }
        }
        let last = null;
        for (const [rid, session] of pending.entries()) {
            if (session.kind === kind) last = { rid, session };
        }
        if (last && last.session.win && !last.session.win.closed) {
            try {
                last.session.win.postMessage(
                    {
                        channel: DESIGNER_PICKER_CHANNEL,
                        type: PARENT_MSG.INIT,
                        kind,
                        requestId: last.rid,
                        ...last.session.initPayload
                    },
                    window.location.origin
                );
            } catch (err) {
                console.warn('picker init postMessage failed', err);
            }
        }
        return;
    }

    if (type === MSG.SELECT) {
        const session = requestId ? pending.get(requestId) : null;
        if (session && typeof session.apply === 'function') {
            session.apply(data.value);
        } else if (!requestId) {
            for (const [, s] of [...pending.entries()].reverse()) {
                if (s.kind === kind && typeof s.apply === 'function') {
                    s.apply(data.value);
                    break;
                }
            }
        }
        if (requestId) pending.delete(requestId);
        return;
    }

    if (type === MSG.CANCEL || type === MSG.CLOSING) {
        if (requestId) pending.delete(requestId);
    }
}

function ensureListener() {
    if (listenerBound || typeof window === 'undefined') return;
    window.addEventListener('message', handlePickerMessage);
    listenerBound = true;
}

/**
 * @param {object} opts
 * @param {string} opts.kind
 * @param {string} opts.urlPath
 * @param {string} opts.windowName
 * @param {string} opts.features
 * @param {Record<string, unknown>} opts.initPayload
 * @param {(value: unknown) => void} opts.apply
 * @param {Record<string, string>} [opts.query]
 * @returns {string|null}
 */
function openPickerSession(opts) {
    ensureListener();
    const requestId = nextRequestId();
    const params = new URLSearchParams({ requestId, ...(opts.query || {}) });
    const url = appUrl(opts.urlPath) + '?' + params.toString();
    const win = openPickerWindow(url, opts.windowName, opts.features);
    if (!win) return null;

    pending.set(requestId, {
        kind: opts.kind,
        apply: opts.apply,
        win,
        initPayload: opts.initPayload
    });

    const timer = setTimeout(() => {
        const session = pending.get(requestId);
        if (!session || !session.win || session.win.closed) return;
        try {
            session.win.postMessage(
                {
                    channel: DESIGNER_PICKER_CHANNEL,
                    type: PARENT_MSG.INIT,
                    kind: opts.kind,
                    requestId,
                    ...session.initPayload
                },
                window.location.origin
            );
        } catch (_) {
            /* ignore */
        }
    }, 400);
    reinitTimers.push(timer);

    return requestId;
}

/**
 * Open genre catalog picker (tiles / creatures / equipment / objects / overlays).
 * @param {{
 *   genre?: string,
 *   assetKind?: string,
 *   currentId?: string,
 *   category?: string,
 *   slotFilter?: string,
 *   previewVariant?: string,
 *   showCategoryFilter?: boolean,
 *   categories?: string[],
 *   fieldPath?: string,
 *   title?: string,
 *   onSelect: (id: string, meta?: Record<string, unknown>) => void
 * }} opts
 * @returns {string|null}
 */
function openCatalogAssetPicker(opts) {
    const genre = opts.genre || 'rpg_fantasy';
    const assetKind = opts.assetKind || 'tiles';
    const currentId = opts.currentId || '';
    const category = opts.category || '';
    const slotFilter = opts.slotFilter || '';
    const previewVariant = opts.previewVariant || 'alpha';
    const categories = Array.isArray(opts.categories)
        ? opts.categories.map((c) => String(c)).filter(Boolean)
        : catalogCategoriesForKind(assetKind);
    const showCategoryFilter =
        opts.showCategoryFilter != null
            ? !!opts.showCategoryFilter
            : assetKind === 'tiles' ||
              assetKind === 'objects' ||
              assetKind === 'overlays';
    const windowName =
        assetKind === 'tiles' ? TILE_PICKER_WINDOW : `du_catalog_${assetKind}`;
    return openPickerSession({
        kind: 'catalog',
        urlPath: TILE_PICKER_URL_PATH,
        windowName,
        features: popupFeatures(960, 720),
        query: {
            genre,
            kind: assetKind,
            id: currentId,
            category,
            categories: categories.join(','),
            slotFilter,
            previewVariant,
            showCategoryFilter: showCategoryFilter ? '1' : '0',
            fieldPath: opts.fieldPath || '',
            title: opts.title || ''
        },
        initPayload: {
            genre,
            assetKind,
            currentId,
            category,
            categories,
            slotFilter,
            previewVariant,
            showCategoryFilter,
            fieldPath: opts.fieldPath || '',
            title: opts.title || ''
        },
        apply: (value) => {
            if (!value || typeof value !== 'object') return;
            const id = /** @type {{id?: unknown}} */ (value).id;
            if (id == null || String(id) === '') return;
            opts.onSelect(String(id), /** @type {Record<string, unknown>} */ (value));
        }
    });
}

/**
 * Open equipment preset catalog picker (select mode).
 * @param {{
 *   mode?: string,
 *   genre?: string,
 *   currentId?: string,
 *   slotFilter?: string,
 *   fieldPath?: string,
 *   title?: string,
 *   onSelect: (id: string, meta?: Record<string, unknown>) => void
 * }} opts
 * @returns {string|null}
 */
function openEquipmentPicker(opts) {
    const mode = opts.mode || 'standard';
    const genre = opts.genre || 'rpg_fantasy';
    const currentId = opts.currentId || '';
    const slotFilter = opts.slotFilter || '';
    return openPickerSession({
        kind: 'equipment',
        urlPath: EQUIPMENT_PICKER_URL_PATH,
        windowName: EQUIPMENT_PICKER_WINDOW,
        features: popupFeatures(980, 720),
        query: {
            mode,
            genre,
            id: currentId,
            slotFilter,
            fieldPath: opts.fieldPath || '',
            title: opts.title || '',
            uiMode: 'select'
        },
        initPayload: {
            mode,
            genre,
            currentId,
            slotFilter,
            fieldPath: opts.fieldPath || '',
            title: opts.title || '',
            uiMode: 'select'
        },
        apply: (value) => {
            if (!value || typeof value !== 'object') return;
            const id = /** @type {{id?: unknown}} */ (value).id;
            if (id == null || String(id) === '') return;
            opts.onSelect(String(id), /** @type {Record<string, unknown>} */ (value));
        }
    });
}

/**
 * Test helper: drop pending sessions (does not unbind window listeners).
 */
function resetPickerHostForTests() {
    pending.clear();
    requestSeq = 0;
    while (reinitTimers.length) {
        clearTimeout(reinitTimers.pop());
    }
}

module.exports = {
    openPickerSession,
    openCatalogAssetPicker,
    openEquipmentPicker,
    handlePickerMessage,
    ensureListener,
    catalogCategoriesForKind,
    resetPickerHostForTests,
    DESIGNER_PICKER_CHANNEL,
    MSG,
    PARENT_MSG
};
