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

/** Browser default tile px (matches Settings.tileWidth/Height = 32 → small thumbs). */
const TILE_SCALE_DEFAULT = 32;
const TILE_SCALE_MIN = 8;
const TILE_SCALE_MAX = 48;

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
    TILE_SCALE_DEFAULT,
    TILE_SCALE_MIN,
    TILE_SCALE_MAX,
    clampTileScale,
    applyTileScale,
    loadPersistedDebugAI,
    persistDebugAI,
    loadPersistedCamera,
    persistCamera
};
