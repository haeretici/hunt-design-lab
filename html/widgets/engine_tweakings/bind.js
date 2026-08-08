/**
 * Parent-side helpers for Engine Tweakings (no DOM binding — popup uses postMessage).
 */

'use strict';

const {
    ensureDebugAI,
    applyDebugAIPatch,
    DEBUG_AI_DEFAULTS
} = require('../../../kernel/core/lib/ai_debug_draw.js');

const STORAGE_KEY_DEBUG_AI = 'ai_debug_overlays';
/** localStorage key for camera zoom (tile px scale) — soccer-oss camera_settings parity. */
const STORAGE_KEY_CAMERA = 'camera_settings';
/**
 * Shell-shared progression prefs (Simulator + Scenario Lab).
 * Shape: { features: { expProgression, skillProgression }, expRates: {...}, skillRates: {...} }
 */
const STORAGE_KEY_PROGRESSION = 'hdl_progression_prefs';

/** Browser default tile px (matches Settings.tileWidth/Height = 32 → small thumbs). */
const TILE_SCALE_DEFAULT = 32;
const TILE_SCALE_MIN = 8;
const TILE_SCALE_MAX = 48;

const DEFAULT_EXP_RATES = {
    baseRate: 1,
    eventMult: 1,
    staminaMult: 1,
    additiveBonus: 0,
    prey: 0,
    xpBoost: 0
};

const DEFAULT_SKILL_RATES = {
    stageMult: 1,
    skillPrey: 0
};

const EXP_RATE_KEYS = Object.keys(DEFAULT_EXP_RATES);
const SKILL_RATE_KEYS = Object.keys(DEFAULT_SKILL_RATES);

/**
 * Normalize a progression prefs bag (pure; no Settings side effects).
 * @param {object|null|undefined} raw
 * @returns {{
 *   features: { expProgression: boolean, skillProgression: boolean },
 *   expRates: object,
 *   skillRates: object
 * }}
 */
function normalizeProgressionPrefs(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const feat =
        src.features && typeof src.features === 'object' ? src.features : {};
    const er = src.expRates && typeof src.expRates === 'object' ? src.expRates : {};
    const sr =
        src.skillRates && typeof src.skillRates === 'object' ? src.skillRates : {};
    /** @type {Record<string, number>} */
    const expRates = Object.assign({}, DEFAULT_EXP_RATES);
    for (let i = 0; i < EXP_RATE_KEYS.length; i++) {
        const k = EXP_RATE_KEYS[i];
        if (typeof er[k] === 'number' && Number.isFinite(er[k])) {
            expRates[k] = er[k];
        }
    }
    /** @type {Record<string, number>} */
    const skillRates = Object.assign({}, DEFAULT_SKILL_RATES);
    for (let i = 0; i < SKILL_RATE_KEYS.length; i++) {
        const k = SKILL_RATE_KEYS[i];
        if (typeof sr[k] === 'number' && Number.isFinite(sr[k])) {
            skillRates[k] = sr[k];
        }
    }
    return {
        features: {
            expProgression: feat.expProgression === true,
            skillProgression: feat.skillProgression === true
        },
        expRates,
        skillRates
    };
}

/**
 * Snapshot progression fields from Settings (or a Settings-like bag).
 * @param {object|null|undefined} Settings
 * @returns {ReturnType<typeof normalizeProgressionPrefs>}
 */
function snapshotProgressionPrefs(Settings) {
    const S = Settings && typeof Settings === 'object' ? Settings : {};
    return normalizeProgressionPrefs({
        features: S.features,
        expRates: S.expRates,
        skillRates: S.skillRates
    });
}

/**
 * Apply a progression prefs bag onto Settings (mutates).
 * @param {object} Settings
 * @param {object|null|undefined} prefs
 * @returns {ReturnType<typeof normalizeProgressionPrefs>} applied bag
 */
function applyProgressionPrefs(Settings, prefs) {
    const bag = normalizeProgressionPrefs(prefs);
    if (!Settings || typeof Settings !== 'object') return bag;
    if (!Settings.features || typeof Settings.features !== 'object') {
        Settings.features = {};
    }
    Settings.features.expProgression = bag.features.expProgression;
    Settings.features.skillProgression = bag.features.skillProgression;
    if (!Settings.expRates || typeof Settings.expRates !== 'object') {
        Settings.expRates = {};
    }
    for (let i = 0; i < EXP_RATE_KEYS.length; i++) {
        const k = EXP_RATE_KEYS[i];
        Settings.expRates[k] = bag.expRates[k];
    }
    if (!Settings.skillRates || typeof Settings.skillRates !== 'object') {
        Settings.skillRates = {};
    }
    for (let i = 0; i < SKILL_RATE_KEYS.length; i++) {
        const k = SKILL_RATE_KEYS[i];
        Settings.skillRates[k] = bag.skillRates[k];
    }
    return bag;
}

/**
 * Load progression prefs from localStorage into Settings (browser only).
 * Missing key leaves Settings defaults (mode product false).
 * @param {object} Settings
 */
function loadPersistedProgression(Settings) {
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(STORAGE_KEY_PROGRESSION);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') return;
        applyProgressionPrefs(Settings, saved);
    } catch (e) {
        console.warn('Failed to load progression prefs:', e);
    }
}

/**
 * Persist progression flags + rates from Settings (browser only).
 * @param {object} Settings
 */
function persistProgression(Settings) {
    if (typeof localStorage === 'undefined') return;
    try {
        const bag = snapshotProgressionPrefs(Settings);
        localStorage.setItem(STORAGE_KEY_PROGRESSION, JSON.stringify(bag));
    } catch (_) {
        /* ignore quota / private mode */
    }
}

/**
 * Clamp tile pixel scale used as camera zoom.
 * @param {number} n
 * @returns {number}
 */
function clampTileScale(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return TILE_SCALE_DEFAULT;
    return Math.max(TILE_SCALE_MIN, Math.min(TILE_SCALE_MAX, v));
}

/**
 * Apply square tile size (zoom) on Settings.
 * @param {object} Settings
 * @param {number} scale
 * @returns {number} clamped scale written
 */
function applyTileScale(Settings, scale) {
    const s = clampTileScale(scale);
    Settings.tileWidth = s;
    Settings.tileHeight = s;
    return s;
}

/**
 * Load persisted AI debug overlays into Settings (browser only).
 * @param {object} Settings
 */
function loadPersistedDebugAI(Settings) {
    ensureDebugAI();
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(STORAGE_KEY_DEBUG_AI);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') return;
        applyDebugAIPatch(saved);
    } catch (e) {
        console.warn('Failed to load AI debug overlays prefs:', e);
    }
}

/**
 * Persist current debugAI flags (browser only).
 * @param {object} Settings
 */
function persistDebugAI(Settings) {
    if (typeof localStorage === 'undefined') return;
    try {
        const d = Settings.debugAI || DEBUG_AI_DEFAULTS;
        localStorage.setItem(STORAGE_KEY_DEBUG_AI, JSON.stringify(d));
    } catch (_) {
        /* ignore quota / private mode */
    }
}

/**
 * Load camera zoom (tile scale) from localStorage into Settings.
 * On first visit, applies browser default (32px tiles → small sprite thumbs).
 * @param {object} Settings
 */
function loadPersistedCamera(Settings) {
    if (typeof localStorage === 'undefined') {
        applyTileScale(Settings, TILE_SCALE_DEFAULT);
        return;
    }
    try {
        const raw = localStorage.getItem(STORAGE_KEY_CAMERA);
        if (!raw) {
            applyTileScale(Settings, TILE_SCALE_DEFAULT);
            return;
        }
        const saved = JSON.parse(raw);
        if (saved && typeof saved.scale === 'number') {
            applyTileScale(Settings, saved.scale);
            return;
        }
        applyTileScale(Settings, TILE_SCALE_DEFAULT);
    } catch (e) {
        console.warn('Failed to load camera settings:', e);
        applyTileScale(Settings, TILE_SCALE_DEFAULT);
    }
}

/**
 * Persist camera zoom (browser only).
 * @param {object} Settings
 */
function persistCamera(Settings) {
    if (typeof localStorage === 'undefined') return;
    try {
        const scale = clampTileScale(
            Settings.tileWidth != null ? Settings.tileWidth : TILE_SCALE_DEFAULT
        );
        localStorage.setItem(STORAGE_KEY_CAMERA, JSON.stringify({ scale }));
    } catch (_) {
        /* ignore quota / private mode */
    }
}

module.exports = {
    STORAGE_KEY_DEBUG_AI,
    STORAGE_KEY_CAMERA,
    STORAGE_KEY_PROGRESSION,
    TILE_SCALE_DEFAULT,
    TILE_SCALE_MIN,
    TILE_SCALE_MAX,
    DEFAULT_EXP_RATES,
    DEFAULT_SKILL_RATES,
    EXP_RATE_KEYS,
    SKILL_RATE_KEYS,
    clampTileScale,
    applyTileScale,
    loadPersistedDebugAI,
    persistDebugAI,
    loadPersistedCamera,
    persistCamera,
    normalizeProgressionPrefs,
    snapshotProgressionPrefs,
    applyProgressionPrefs,
    loadPersistedProgression,
    persistProgression
};
