/**
 * Global runtime UI state for manual interaction, targeting cursors, and mouse control preferences.
 * Emulates legacy responsiveness (mouseControlMode = 1 Classic Control default, mode 0 Regular Control optional).
 */

'use strict';

const { Settings } = require('../../settings.js');

const uiState = {
    /** @type {{ type: string, sourceUid?: string, itemId?: string, spellId?: string } | null} */
    activeActionCursor: null,
    /**
     * Mouse control mode:
     * 1 = Classic Control (default): unshifted RMB performs direct action / attacks enemy / uses item. Shift+RMB opens context menu.
     * 0 = Regular Control: Left click selects/attacks, double-left click uses/opens, unshifted RMB opens context menu.
     * @type {number}
     */
    mouseControlMode: 1,
    /** @type {string|null} */
    hoveredEntityKey: null,
    /** @type {number|string|null} */
    hoveredEntityId: null,
    /** @type {object|null} */
    hoveredEntity: null
};

/**
 * Enter target cursor mode for a multi-use item or spell.
 * @param {{ type: string, sourceUid?: string, itemId?: string, spellId?: string }} cursor
 */
function enterTargetCursorMode(cursor) {
    uiState.activeActionCursor = cursor;
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.classList.add('cursor-targeting');
    }
}

/**
 * Cancel / exit target cursor mode cleanly.
 */
function clearTargetCursorMode() {
    uiState.activeActionCursor = null;
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.classList.remove('cursor-targeting');
    }
}

/**
 * Global keyboard escape & RMB cancellation for targeting mode.
 */
function initTargetCursorListeners() {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && uiState.activeActionCursor) {
                clearTargetCursorMode();
            }
        });
        window.addEventListener('contextmenu', (ev) => {
            if (uiState.activeActionCursor) {
                ev.preventDefault();
                ev.stopPropagation();
                clearTargetCursorMode();
            }
        }, true);
    }
}

/**
 * Set active mouse control mode (e.g. 1 for Classic, 0 for Regular).
 * @param {number} mode
 */
function setMouseControlMode(mode) {
    uiState.mouseControlMode = Number(mode);
}

const activeMoveKeys = new Map();
let manualControlsOpts = null;
let manualControlsInitialized = false;
let manualControlsTimer = null;

function normalizeGeneralKey(str) {
    if (!str) return '';
    let s = String(str).trim().toUpperCase().replace(/\s+/g, '');
    if (s === 'SPACEBAR' || s === ' ') s = 'SPACE';
    if (s === 'SHIFT+SPACEBAR' || s === 'SHIFT+ ') s = 'SHIFT+SPACE';
    if (s.startsWith('KEY') && s.length === 4) s = s.slice(3);
    if (s.startsWith('DIGIT') && s.length === 6) s = s.slice(5);
    return s;
}

function matchesKey(actionKeys, key, code, ev = null) {
    if (!Array.isArray(actionKeys) || actionKeys.length === 0) return false;
    const k = normalizeGeneralKey(key || '');
    const c = normalizeGeneralKey(code || '');
    
    const mods = [];
    if (ev) {
        if (ev.ctrlKey && ev.key !== 'Control') mods.push('CTRL');
        if (ev.altKey && ev.key !== 'Alt') mods.push('ALT');
        if (ev.shiftKey && ev.key !== 'Shift') mods.push('SHIFT');
    }
    const hasMods = mods.length > 0;
    
    let baseName = k;
    if (baseName === 'SPACE' || k === '') {
        baseName = k || c;
    }

    const combFromKey = hasMods ? `${mods.join('+')}+${k}` : k;
    const combFromCode = hasMods && c ? `${mods.join('+')}+${c}` : (c || k);

    for (let i = 0; i < actionKeys.length; i++) {
        const stored = normalizeGeneralKey(actionKeys[i]);
        if (!stored) continue;
        const storedHasMods = stored.includes('CTRL+') || stored.includes('ALT+') || stored.includes('SHIFT+');

        if (hasMods && !storedHasMods) {
            continue;
        }
        if (stored === combFromKey || stored === combFromCode || (!hasMods && (stored === k || stored === c))) {
            return true;
        }
    }
    return false;
}

let currentGeneralHotkeysProfile = 'guardian';

function loadGeneralHotkeys(profileId = null) {
    if (profileId != null && typeof profileId === 'string' && profileId.trim() !== '' && profileId !== 'undefined') {
        currentGeneralHotkeysProfile = profileId.trim().toLowerCase();
    }
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const raw = window.localStorage.getItem('hdl_general_hotkeys');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && Settings && Settings.MANUAL_CONTROL_SHORTCUTS) {
                let sourceShortcuts = null;
                if (parsed.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)) {
                    sourceShortcuts = parsed.profiles[currentGeneralHotkeysProfile] || parsed.profiles._default || null;
                    if (!sourceShortcuts) {
                        const keys = Object.keys(parsed.profiles);
                        if (keys.length > 0) sourceShortcuts = parsed.profiles[keys[0]];
                    }
                } else {
                    sourceShortcuts = parsed;
                }

                if (sourceShortcuts && typeof sourceShortcuts === 'object') {
                    for (const k of Object.keys(sourceShortcuts)) {
                        if (Array.isArray(sourceShortcuts[k])) {
                            Settings.MANUAL_CONTROL_SHORTCUTS[k] = JSON.parse(JSON.stringify(sourceShortcuts[k]));
                        }
                    }
                }
            }
        }
    } catch (_) {}
}

function saveGeneralHotkeys(profileId = null, shortcutsToCopy = null, allProfilesList = null) {
    if (profileId != null && typeof profileId === 'string' && profileId.trim() !== '' && profileId !== 'undefined') {
        currentGeneralHotkeysProfile = profileId.trim().toLowerCase();
    }
    if (typeof window === 'undefined' || !window.localStorage || !Settings || !Settings.MANUAL_CONTROL_SHORTCUTS) return;
    try {
        let storageData = { profiles: {} };
        const raw = window.localStorage.getItem('hdl_general_hotkeys');
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                if (parsed.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)) {
                    storageData.profiles = parsed.profiles;
                } else {
                    const legacy = {};
                    for (const k of Object.keys(parsed)) {
                        if (Array.isArray(parsed[k])) legacy[k] = parsed[k];
                    }
                    if (Object.keys(legacy).length > 0) {
                        storageData.profiles[currentGeneralHotkeysProfile] = legacy;
                        storageData.profiles._default = JSON.parse(JSON.stringify(legacy));
                    }
                }
            }
        }

        const source = shortcutsToCopy || Settings.MANUAL_CONTROL_SHORTCUTS;
        const snapshot = JSON.parse(JSON.stringify(source));

        if (Array.isArray(allProfilesList)) {
            for (const existingPid of Object.keys(storageData.profiles)) {
                storageData.profiles[existingPid] = JSON.parse(JSON.stringify(snapshot));
            }
            for (let i = 0; i < allProfilesList.length; i++) {
                const pid = String(allProfilesList[i]).trim().toLowerCase();
                if (pid) {
                    storageData.profiles[pid] = JSON.parse(JSON.stringify(snapshot));
                }
            }
            storageData.profiles._default = JSON.parse(JSON.stringify(snapshot));
        } else {
            storageData.profiles[currentGeneralHotkeysProfile] = snapshot;
            if (!storageData.profiles._default) {
                storageData.profiles._default = JSON.parse(JSON.stringify(snapshot));
            }
        }

        window.localStorage.setItem('hdl_general_hotkeys', JSON.stringify(storageData));
    } catch (_) {}
}

/**
 * Convert keyboard event key/code to a movement direction delta.
 * @param {string} [key]
 * @param {string} [code]
 * @param {KeyboardEvent} [ev]
 * @returns {{ dx: number, dy: number } | null}
 */
function getMoveDeltaFromKey(key, code, ev = null) {
    const shortcuts = Settings && Settings.MANUAL_CONTROL_SHORTCUTS ? Settings.MANUAL_CONTROL_SHORTCUTS : {};
    const north = Array.isArray(shortcuts.moveNorth) ? shortcuts.moveNorth : ['ARROWUP', 'W'];
    const south = Array.isArray(shortcuts.moveSouth) ? shortcuts.moveSouth : ['ARROWDOWN', 'S'];
    const west = Array.isArray(shortcuts.moveWest) ? shortcuts.moveWest : ['ARROWLEFT', 'A'];
    const east = Array.isArray(shortcuts.moveEast) ? shortcuts.moveEast : ['ARROWRIGHT', 'D'];
    // Empty defaults: diagonals are produced by holding two cardinals (e.g. W+A).
    const nw = Array.isArray(shortcuts.moveNorthWest) ? shortcuts.moveNorthWest : [];
    const ne = Array.isArray(shortcuts.moveNorthEast) ? shortcuts.moveNorthEast : [];
    const sw = Array.isArray(shortcuts.moveSouthWest) ? shortcuts.moveSouthWest : [];
    const se = Array.isArray(shortcuts.moveSouthEast) ? shortcuts.moveSouthEast : [];

    if (matchesKey(north, key, code, ev)) return { dx: 0, dy: -1 };
    if (matchesKey(south, key, code, ev)) return { dx: 0, dy: 1 };
    if (matchesKey(west, key, code, ev)) return { dx: -1, dy: 0 };
    if (matchesKey(east, key, code, ev)) return { dx: 1, dy: 0 };
    if (matchesKey(nw, key, code, ev)) return { dx: -1, dy: -1 };
    if (matchesKey(ne, key, code, ev)) return { dx: 1, dy: -1 };
    if (matchesKey(sw, key, code, ev)) return { dx: -1, dy: 1 };
    if (matchesKey(se, key, code, ev)) return { dx: 1, dy: 1 };
    return null;
}

/**
 * Compute combined movement delta using latest-win input priority per axis.
 * Avoids dead-stops when switching directions or overlapping keypresses.
 * @returns {{ dx: number, dy: number }}
 */
function getCombinedMoveDelta() {
    let dx = 0;
    let dy = 0;
    for (const delta of activeMoveKeys.values()) {
        if (delta.dx !== 0) dx = delta.dx;
        if (delta.dy !== 0) dy = delta.dy;
    }
    return { dx, dy };
}

/**
 * Queue or update a MOVE_STEP command based on currently held movement keys.
 * Continuous queueing overcomes OS key-repeat latency after an initial step.
 * @param {object} player
 */
function feedManualMovementCommand(player) {
    if (!player || player.controlMode !== 'manual' || !player.alive) return;
    if (!Array.isArray(player.commandQueue)) player.commandQueue = [];

    const { dx, dy } = getCombinedMoveDelta();
    if (dx === 0 && dy === 0) return;

    const existing = player.commandQueue.find((cmd) => cmd && cmd.type === 'MOVE_STEP');
    if (existing) {
        existing.dx = dx;
        existing.dy = dy;
    } else {
        player.commandQueue.push({ type: 'MOVE_STEP', dx, dy });
    }
}

/**
 * Clear all tracked held movement keys when losing focus or ending sessions.
 */
function clearActiveMoveKeys() {
    activeMoveKeys.clear();
}

/**
 * Initialize global keyboard controls for manual continuous movement and target cycling.
 * @param {{
 *   getSessionLive?: () => boolean,
 *   getSim?: () => object|null,
 *   getActivePlayer?: (sim: object) => object|null,
 *   cycleTarget?: (sim: object, player: object, dir: number) => void
 * }} [opts]
 */
function initManualKeyboardControls(opts = {}) {
    manualControlsOpts = opts;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    if (!manualControlsInitialized) {
        manualControlsInitialized = true;
        loadGeneralHotkeys();

        window.addEventListener('keydown', (ev) => {
            const getSessionLive = manualControlsOpts && manualControlsOpts.getSessionLive;
            if (typeof getSessionLive === 'function' && !getSessionLive()) return;
            if (!ev.key) return;
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT')) {
                return;
            }

            const getSim = manualControlsOpts && manualControlsOpts.getSim;
            const sim = typeof getSim === 'function' ? getSim() : null;
            if (!sim) return;

            const getActivePlayer = manualControlsOpts && manualControlsOpts.getActivePlayer;
            const player = typeof getActivePlayer === 'function' ? getActivePlayer(sim) : null;
            if (!player || player.controlMode !== 'manual' || !player.alive) return;

            if (!Array.isArray(player.commandQueue)) player.commandQueue = [];

            const shortcuts = Settings && Settings.MANUAL_CONTROL_SHORTCUTS ? Settings.MANUAL_CONTROL_SHORTCUTS : {};
            const nextKeys = Array.isArray(shortcuts.targetNext) ? shortcuts.targetNext : ['SPACE', 'SPACEBAR', ' '];
            const prevKeys = Array.isArray(shortcuts.targetPrev) ? shortcuts.targetPrev : ['SHIFT+SPACE', 'SHIFT+SPACEBAR', 'SHIFT+ '];
            const stopKeys = Array.isArray(shortcuts.stopAutowalk) ? shortcuts.stopAutowalk : ['ESCAPE'];
            const chaseKeys = Array.isArray(shortcuts.toggleAutoChase) ? shortcuts.toggleAutoChase : ['T', 'KEYT'];

            const cycleTarget = manualControlsOpts && manualControlsOpts.cycleTarget;

            if (matchesKey(prevKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                if (typeof cycleTarget === 'function') cycleTarget(sim, player, -1);
                return;
            }
            if (matchesKey(nextKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                if (typeof cycleTarget === 'function') cycleTarget(sim, player, 1);
                return;
            }
            if (matchesKey(stopKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                player.commandQueue.push({ type: 'STOP_AUTOWALK' });
                return;
            }
            if (matchesKey(chaseKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                const currentChase = !player.autoChase;
                player.autoChase = currentChase;
                player.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: currentChase });
                if (typeof window !== 'undefined' && window.localStorage) {
                    window.localStorage.setItem('hdl_auto_chase', currentChase ? 'true' : 'false');
                }
                if (typeof document !== 'undefined') {
                    const autoChaseEl = /** @type {HTMLInputElement|null} */ (document.getElementById('autoChaseToggle'));
                    if (autoChaseEl && autoChaseEl.checked !== undefined) autoChaseEl.checked = currentChase;
                }
                return;
            }

            const delta = getMoveDeltaFromKey(ev.key, ev.code, ev);
            if (delta) {
                ev.preventDefault();
                const keyId = ev.code || ev.key.toLowerCase();
                activeMoveKeys.delete(keyId);
                activeMoveKeys.set(keyId, delta);
                feedManualMovementCommand(player);
            }
        });

        window.addEventListener('keyup', (ev) => {
            if (!ev.key && !ev.code) return;
            const keyId = ev.code || (ev.key && ev.key.toLowerCase());
            if (!activeMoveKeys.has(keyId)) return;
            activeMoveKeys.delete(keyId);

            const getSim = manualControlsOpts && manualControlsOpts.getSim;
            const sim = typeof getSim === 'function' ? getSim() : null;
            const getActivePlayer = manualControlsOpts && manualControlsOpts.getActivePlayer;
            const player = typeof getActivePlayer === 'function' && sim ? getActivePlayer(sim) : null;
            if (!player || !player.alive || player.controlMode !== 'manual') return;

            if (activeMoveKeys.size > 0) {
                feedManualMovementCommand(player);
            } else if (Number(player.moveDelay) > 0 && Array.isArray(player.commandQueue)) {
                player.commandQueue = player.commandQueue.filter((cmd) => cmd && cmd.type !== 'MOVE_STEP');
            }
        });

        window.addEventListener('blur', () => {
            activeMoveKeys.clear();
        });

        document.addEventListener('visibilitychange', () => {
            if (typeof document !== 'undefined' && document.hidden) {
                activeMoveKeys.clear();
            }
        });

        if (!manualControlsTimer && typeof setInterval === 'function') {
            manualControlsTimer = setInterval(() => {
                if (activeMoveKeys.size === 0) return;
                const getSessionLive = manualControlsOpts && manualControlsOpts.getSessionLive;
                if (typeof getSessionLive === 'function' && !getSessionLive()) {
                    activeMoveKeys.clear();
                    return;
                }
                const getSim = manualControlsOpts && manualControlsOpts.getSim;
                const sim = typeof getSim === 'function' ? getSim() : null;
                const getActivePlayer = manualControlsOpts && manualControlsOpts.getActivePlayer;
                const player = typeof getActivePlayer === 'function' && sim ? getActivePlayer(sim) : null;
                if (!player || !player.alive || player.controlMode !== 'manual') {
                    activeMoveKeys.clear();
                    return;
                }
                feedManualMovementCommand(player);
            }, 25);
        }
    }
}

module.exports = {
    uiState,
    setMouseControlMode,
    enterTargetCursorMode,
    clearTargetCursorMode,
    initTargetCursorListeners,
    initManualKeyboardControls,
    clearActiveMoveKeys,
    getMoveDeltaFromKey,
    getCombinedMoveDelta,
    feedManualMovementCommand,
    activeMoveKeys,
    normalizeGeneralKey,
    matchesKey,
    loadGeneralHotkeys,
    saveGeneralHotkeys
};
