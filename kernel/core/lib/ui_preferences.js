/**
 * App-wide UI preferences in IndexedDB (browser only).
 *
 * One database for Hunt Design Lab web apps; each page stores a keyed object
 * (e.g. assetManager, batchBuilder) so filters and form defaults survive reload.
 *
 * Content mode selection is shared across shells via localStorage so Hunt,
 * Scenario Lab, Hunt Editor, and Designer keep the same pack selected.
 */

'use strict';

const DB_NAME = 'HuntDesignLab';
const DB_VERSION = 1;
const STORE = 'preferences';

/** localStorage key for the last content mode pack the user selected. */
const CONTENT_MODE_STORAGE_KEY = 'hdl_content_mode';

/**
 * Creature browser (Wiki / Select picker) layout preference.
 * Values: `grid` | `table`. Standalone picker writes this key directly
 * (html/widgets/designer_pickers/creature_picker.js); helpers below keep the
 * contract documented next to content mode.
 */
const CREATURE_BROWSER_LAYOUT_KEY = 'hdl_creature_browser_layout';

/**
 * Equipment browser (Wiki / Select picker) layout preference.
 * Values: `grid` | `table`. Standalone picker writes this key directly
 * (html/widgets/designer_pickers/equipment_picker.js).
 */
const EQUIPMENT_BROWSER_LAYOUT_KEY = 'hdl_equipment_browser_layout';

/** mode.json id shape (matches ModeRegistry / hunt-editor deep-links). */
const CONTENT_MODE_ID_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * @param {unknown} layout
 * @returns {boolean}
 */
function isValidBrowserLayout(layout) {
    return layout === 'grid' || layout === 'table';
}

/** @deprecated Use isValidBrowserLayout */
function isValidCreatureBrowserLayout(layout) {
    return isValidBrowserLayout(layout);
}

/**
 * @param {'grid'|'table'} [fallback='grid']
 * @returns {'grid'|'table'}
 */
function getCreatureBrowserLayout(fallback = 'grid') {
    const fb = isValidBrowserLayout(fallback) ? fallback : 'grid';
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(CREATURE_BROWSER_LAYOUT_KEY);
            if (isValidBrowserLayout(raw)) return /** @type {'grid'|'table'} */ (raw);
        }
    } catch (_) {
        /* private mode / blocked storage */
    }
    return fb;
}

/**
 * @param {string} layout
 * @returns {boolean}
 */
function setCreatureBrowserLayout(layout) {
    if (!isValidBrowserLayout(layout)) return false;
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(CREATURE_BROWSER_LAYOUT_KEY, layout);
            return true;
        }
    } catch (_) {
        /* ignore */
    }
    return false;
}

/**
 * @param {'grid'|'table'} [fallback='grid']
 * @returns {'grid'|'table'}
 */
function getEquipmentBrowserLayout(fallback = 'grid') {
    const fb = isValidBrowserLayout(fallback) ? fallback : 'grid';
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(EQUIPMENT_BROWSER_LAYOUT_KEY);
            if (isValidBrowserLayout(raw)) return /** @type {'grid'|'table'} */ (raw);
        }
    } catch (_) {
        /* private mode / blocked storage */
    }
    return fb;
}

/**
 * @param {string} layout
 * @returns {boolean}
 */
function setEquipmentBrowserLayout(layout) {
    if (!isValidBrowserLayout(layout)) return false;
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(EQUIPMENT_BROWSER_LAYOUT_KEY, layout);
            return true;
        }
    } catch (_) {
        /* ignore */
    }
    return false;
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidContentModeId(id) {
    return typeof id === 'string' && CONTENT_MODE_ID_RE.test(id.trim());
}

/**
 * Last content mode chosen in any web shell (localStorage).
 * Returns `fallback` when unset / unavailable (pass null to mean "no preference").
 *
 * @param {string|null} [fallback=null]
 * @returns {string|null}
 */
function getPreferredContentModeId(fallback = null) {
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(CONTENT_MODE_STORAGE_KEY);
            if (raw != null && isValidContentModeId(raw)) {
                return String(raw).trim();
            }
        }
    } catch (_) {
        /* private mode / blocked storage */
    }
    if (fallback != null && isValidContentModeId(fallback)) {
        return String(fallback).trim();
    }
    return null;
}

/**
 * Persist content mode for all shells (Hunt, Designer, …).
 * @param {string} modeId
 * @returns {boolean} true when written
 */
function setPreferredContentModeId(modeId) {
    if (!isValidContentModeId(modeId)) return false;
    const id = String(modeId).trim();
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(CONTENT_MODE_STORAGE_KEY, id);
            return true;
        }
    } catch (_) {
        /* ignore */
    }
    return false;
}

/**
 * Pick a mode id: shared preference → page fallback → first available → default.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.fallback] — e.g. window.__CONTENT_MODE__ or page prefs
 * @param {string[]} [opts.availableIds] — installed mode ids; preferred must be in list
 * @param {string} [opts.defaultId='standard']
 * @returns {string}
 */
function resolvePreferredContentModeId(opts) {
    const o = opts || {};
    const defaultId =
        o.defaultId && isValidContentModeId(o.defaultId)
            ? String(o.defaultId).trim()
            : 'standard';
    const available = Array.isArray(o.availableIds)
        ? o.availableIds.filter((id) => isValidContentModeId(id))
        : null;

    const candidates = [
        getPreferredContentModeId(null),
        o.fallback != null && isValidContentModeId(o.fallback)
            ? String(o.fallback).trim()
            : null,
        defaultId
    ];

    for (const id of candidates) {
        if (!id) continue;
        if (!available || available.length === 0 || available.indexOf(id) >= 0) {
            return id;
        }
    }
    if (available && available.length) return available[0];
    return defaultId;
}

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is not available'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        req.onblocked = () => {
            console.warn('[ui_preferences] open blocked — close other tabs using Hunt Design Lab');
        };
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                db.createObjectStore(STORE, { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
    });
    // Allow a later open attempt if this one fails (e.g. private mode quirks)
    dbPromise.catch(() => {
        dbPromise = null;
    });
    return dbPromise;
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function requestToPromise(req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
}

/**
 * Load preferences for a scope key (e.g. "assetManager").
 * @param {string} id
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function getUiPreferences(id) {
    if (!id) return null;
    try {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readonly');
        const row = await requestToPromise(tx.objectStore(STORE).get(id));
        if (!row || typeof row !== 'object') return null;
        if (row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
            return { ...row.data };
        }
        const { id: _id, updatedAt, data, ...rest } = row;
        void _id;
        void updatedAt;
        void data;
        return Object.keys(rest).length ? rest : null;
    } catch (err) {
        console.warn('[ui_preferences] get failed', id, err);
        return null;
    }
}

/**
 * Replace preferences for a scope key.
 * @param {string} id
 * @param {Record<string, unknown>} prefs
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function putUiPreferences(id, prefs) {
    if (!id) return null;
    try {
        const db = await openDb();
        const record = {
            id,
            updatedAt: Date.now(),
            data: { ...(prefs || {}) }
        };
        const tx = db.transaction(STORE, 'readwrite');
        await requestToPromise(tx.objectStore(STORE).put(record));
        await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        return record.data;
    } catch (err) {
        console.warn('[ui_preferences] put failed', id, err);
        return null;
    }
}

/**
 * Merge a partial update into existing prefs for a scope key.
 * @param {string} id
 * @param {Record<string, unknown>} patch
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function patchUiPreferences(id, patch) {
    const current = (await getUiPreferences(id)) || {};
    return putUiPreferences(id, { ...current, ...(patch || {}) });
}

/**
 * Debounced writer for a scope (one timer per key).
 * @param {string} id
 * @param {() => Record<string, unknown>} collect
 * @param {number} [ms]
 * @returns {() => void} schedule save
 */
function createDebouncedPrefsSaver(id, collect, ms = 200) {
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    return function schedulePrefsSave() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            let data;
            try {
                data = collect();
            } catch (err) {
                console.warn('[ui_preferences] collect failed', id, err);
                return;
            }
            putUiPreferences(id, data).catch(() => {});
        }, ms);
    };
}

module.exports = {
    DB_NAME,
    DB_VERSION,
    STORE,
    CONTENT_MODE_STORAGE_KEY,
    CREATURE_BROWSER_LAYOUT_KEY,
    EQUIPMENT_BROWSER_LAYOUT_KEY,
    isValidContentModeId,
    getPreferredContentModeId,
    setPreferredContentModeId,
    resolvePreferredContentModeId,
    isValidBrowserLayout,
    isValidCreatureBrowserLayout,
    getCreatureBrowserLayout,
    setCreatureBrowserLayout,
    getEquipmentBrowserLayout,
    setEquipmentBrowserLayout,
    getUiPreferences,
    putUiPreferences,
    patchUiPreferences,
    createDebouncedPrefsSaver
};
