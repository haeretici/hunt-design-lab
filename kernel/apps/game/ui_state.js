/**
 * Global runtime UI state for manual interaction, targeting cursors, and mouse control preferences.
 * Emulates legacy responsiveness (mouseControlMode = 1 Classic Control default, mode 0 Regular Control optional).
 * Mouse prefs persist in browser localStorage (`hdl_mouse_controls`) — see docs/29 Stage 3.
 */

'use strict';

const { Settings } = require('../../settings.js');

/** Browser localStorage key for mouse control prefs (shell-shared, not per-party). */
const STORAGE_KEY_MOUSE_CONTROLS = 'hdl_mouse_controls';

/** Browser localStorage key for Auto Chase (shell-shared, not per-party). */
const STORAGE_KEY_AUTO_CHASE = 'hdl_auto_chase';

/**
 * Product defaults (docs/29 Q0.1 / Stage 3–4).
 * Modes 0/1/2 all valid; default remains Classic (1).
 */
const DEFAULT_MOUSE_CONTROLS = Object.freeze({
    mouseControlMode: 1,
    lootControlMode: 0,
    talkOnRightClick: false,
    moveStack: false
});

const uiState = {
    /** @type {{ type: string, sourceUid?: string, itemId?: string, spellId?: string } | null} */
    activeActionCursor: null,
    /**
     * Mouse control mode (see docs/29):
     * 1 = Classic Control (default): unshifted RMB = attack / open·use / pickup / walk;
     *     Ctrl+click = context menu (any tile); Shift = Look; Alt = attack (non-NPC).
     * 0 = Regular Control: LMB target/walk; unshifted RMB = context menu always;
     *     Ctrl = use/open; Shift = Look; Alt = attack (non-NPC).
     * 2 = Left Smart-Click: unshifted LMB = smart default (attack / use / pickup / walk);
     *     unshifted RMB = context menu; Ctrl = open world container/corpse or menu.
     * @type {number}
     */
    mouseControlMode: DEFAULT_MOUSE_CONTROLS.mouseControlMode,
    /**
     * Classic-only loot sub-mode (docs/29 §1.2). Stub until Stage 5b corpses/quickloot.
     * 0 = Loot: Right, 1 = Loot: SHIFT+Right, 2 = Loot: Left.
     * @type {number}
     */
    lootControlMode: DEFAULT_MOUSE_CONTROLS.lootControlMode,
    /**
     * Regular mode: unshifted RMB on NPC talks when true (Stage 6b).
     * Default false — Regular RMB stays context menu. Setter persists.
     * @type {boolean}
     */
    talkOnRightClick: DEFAULT_MOUSE_CONTROLS.talkOnRightClick,
    /**
     * Stack drag quantity preference (Stage 7). Default false:
     * plain drag opens amount modal; Ctrl moves full (Ctrl XOR moveStack).
     * @type {boolean}
     */
    moveStack: DEFAULT_MOUSE_CONTROLS.moveStack,
    /** @type {string|null} */
    hoveredEntityKey: null,
    /** @type {number|string|null} */
    hoveredEntityId: null,
    /** @type {object|null} */
    hoveredEntity: null
};

/**
 * Normalize a mouse-controls prefs bag (pure; no side effects).
 * Invalid / missing fields fall back to product defaults.
 * @param {object|null|undefined} raw
 * @returns {{
 *   mouseControlMode: number,
 *   lootControlMode: number,
 *   talkOnRightClick: boolean,
 *   moveStack: boolean
 * }}
 */
function normalizeMouseControls(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    let mode = Number(src.mouseControlMode);
    if (!Number.isFinite(mode)) mode = DEFAULT_MOUSE_CONTROLS.mouseControlMode;
    mode = Math.floor(mode);
    // 0 Regular, 1 Classic, 2 Left Smart-Click
    if (mode !== 0 && mode !== 1 && mode !== 2) {
        mode = DEFAULT_MOUSE_CONTROLS.mouseControlMode;
    }
    let loot = Number(src.lootControlMode);
    if (!Number.isFinite(loot)) loot = DEFAULT_MOUSE_CONTROLS.lootControlMode;
    loot = Math.floor(loot);
    if (loot !== 0 && loot !== 1 && loot !== 2) {
        loot = DEFAULT_MOUSE_CONTROLS.lootControlMode;
    }
    return {
        mouseControlMode: mode,
        lootControlMode: loot,
        talkOnRightClick: src.talkOnRightClick === true,
        moveStack: src.moveStack === true
    };
}

/**
 * Snapshot current mouse prefs from uiState.
 * @returns {ReturnType<typeof normalizeMouseControls>}
 */
function snapshotMouseControls() {
    return normalizeMouseControls({
        mouseControlMode: uiState.mouseControlMode,
        lootControlMode: uiState.lootControlMode,
        talkOnRightClick: uiState.talkOnRightClick,
        moveStack: uiState.moveStack
    });
}

/**
 * Apply a prefs bag onto uiState (mutates). Does not persist.
 * @param {object|null|undefined} prefs
 * @returns {ReturnType<typeof normalizeMouseControls>} applied bag
 */
function applyMouseControls(prefs) {
    const bag = normalizeMouseControls(prefs);
    uiState.mouseControlMode = bag.mouseControlMode;
    uiState.lootControlMode = bag.lootControlMode;
    uiState.talkOnRightClick = bag.talkOnRightClick;
    uiState.moveStack = bag.moveStack;
    return bag;
}

/**
 * Persist current mouse prefs to localStorage (browser only).
 */
function saveMouseControls() {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(
            STORAGE_KEY_MOUSE_CONTROLS,
            JSON.stringify(snapshotMouseControls())
        );
    } catch (_) {
        /* ignore quota / private mode */
    }
}

/**
 * Load mouse prefs from localStorage into uiState (browser only).
 * Missing key leaves product defaults.
 */
function loadMouseControls() {
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(STORAGE_KEY_MOUSE_CONTROLS);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (!saved || typeof saved !== 'object') return;
        applyMouseControls(saved);
    } catch (e) {
        console.warn('Failed to load mouse control prefs:', e);
    }
}

/**
 * Read persisted Auto Chase (shell pref). Missing / unreadable → false.
 * @returns {boolean}
 */
function readPersistedAutoChase() {
    try {
        if (typeof localStorage !== 'undefined' && localStorage) {
            return localStorage.getItem(STORAGE_KEY_AUTO_CHASE) === 'true';
        }
        if (typeof window !== 'undefined' && window.localStorage) {
            return window.localStorage.getItem(STORAGE_KEY_AUTO_CHASE) === 'true';
        }
    } catch (_) {
        /* ignore quota / private mode */
    }
    return false;
}

/**
 * Persist Auto Chase for the next page load / Play spawn.
 * @param {boolean} enabled
 */
function writePersistedAutoChase(enabled) {
    const val = enabled ? 'true' : 'false';
    try {
        if (typeof localStorage !== 'undefined' && localStorage) {
            localStorage.setItem(STORAGE_KEY_AUTO_CHASE, val);
            return;
        }
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(STORAGE_KEY_AUTO_CHASE, val);
        }
    } catch (_) {
        /* ignore quota / private mode */
    }
}

/**
 * Enter target cursor mode for a multi-use item or spell (crosshair).
 * Prefer `enterActionCursor` from action_bars.js so `allowTileAim` is set from the spell book.
 * @param {{ type: string, sourceUid?: string, itemId?: string, spellId?: string, allowTileAim?: boolean }} cursor
 *   allowTileAim: false → single-target (creature only); true/omit → empty tile aim OK (AoE / tools)
 */
function enterTargetCursorMode(cursor) {
    uiState.activeActionCursor = cursor;
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.classList.add('cursor-targeting');
    }
}

/**
 * Cancel / exit target cursor mode cleanly (restores default cursor).
 */
function clearTargetCursorMode() {
    uiState.activeActionCursor = null;
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.classList.remove('cursor-targeting');
    }
}

/**
 * Hotkeys bound to "Stop Autowalk / Cancel Action" (Settings.MANUAL_CONTROL_SHORTCUTS.stopAutowalk).
 * Default is ESCAPE; players can rebind in Action Bar Config → General Hotkeys.
 * @returns {string[]}
 */
function getStopCancelHotkeys() {
    const shortcuts =
        Settings && Settings.MANUAL_CONTROL_SHORTCUTS
            ? Settings.MANUAL_CONTROL_SHORTCUTS
            : {};
    return Array.isArray(shortcuts.stopAutowalk) && shortcuts.stopAutowalk.length
        ? shortcuts.stopAutowalk
        : ['ESCAPE'];
}

/**
 * Whether this keyboard event matches the Stop Autowalk / Cancel Action hotkey.
 * @param {KeyboardEvent|null|undefined} ev
 * @returns {boolean}
 */
function isStopCancelHotkeyEvent(ev) {
    if (!ev || !ev.key) return false;
    return matchesKey(getStopCancelHotkeys(), ev.key, ev.code, ev);
}

/**
 * Cancel use-with / cast crosshair if active.
 * @returns {boolean} true if a cursor was cleared
 */
function cancelTargetCursorIfActive() {
    if (!uiState.activeActionCursor) return false;
    clearTargetCursorMode();
    return true;
}

/**
 * Cancel Action + RMB cancellation for targeting mode.
 *
 * Keyboard: uses the **Stop Autowalk / Cancel Action** hotkey (default Escape; rebindable),
 * not a hard-coded Escape-only path.
 *
 * Mouse: any RMB (contextmenu capture) cancels the crosshair in **all** mouse modes
 * (Classic / Regular / Smart). Legacy mouse-grabber ends aim on non-use release the same way;
 * mode only changes how you *enter* use-with (Classic unshifted RMB vs Regular menu/Ctrl).
 */
function initTargetCursorListeners() {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.addEventListener('keydown', (ev) => {
            if (!uiState.activeActionCursor) return;
            if (!isStopCancelHotkeyEvent(ev)) return;
            ev.preventDefault();
            clearTargetCursorMode();
        });
        // RMB cancel is mode-independent while crosshair is active
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
 * Set active mouse control mode (0 Regular, 1 Classic, 2 Left Smart-Click).
 * Persists to localStorage when available.
 * @param {number} mode
 */
function setMouseControlMode(mode) {
    applyMouseControls({
        ...snapshotMouseControls(),
        mouseControlMode: mode
    });
    saveMouseControls();
}

/**
 * Set classic loot sub-mode (0/1/2). Stub until Stage 5b — value persists only.
 * @param {number} mode
 */
function setLootControlMode(mode) {
    applyMouseControls({
        ...snapshotMouseControls(),
        lootControlMode: mode
    });
    saveMouseControls();
}

/**
 * Set Regular-mode RMB talk preference (Stage 6b). Persists when available.
 * @param {boolean} enabled
 */
function setTalkOnRightClick(enabled) {
    applyMouseControls({
        ...snapshotMouseControls(),
        talkOnRightClick: !!enabled
    });
    saveMouseControls();
}

/**
 * Set stack-drag preference (Stage 7). Persists when available.
 * @param {boolean} enabled
 */
function setMoveStack(enabled) {
    applyMouseControls({
        ...snapshotMouseControls(),
        moveStack: !!enabled
    });
    saveMouseControls();
}

/** @type {{ left: boolean, right: boolean }} */
const mouseButtonState = { left: false, right: false };

/** After Classic LMB+RMB Look chord, skip the would-be contextmenu of the second button. */
let suppressNextContextMenu = false;

/**
 * After canvas ground-item drag (Stage 9), skip the synthetic click that would
 * otherwise START_AUTOWALK / re-run the LMB dispatcher on the release tile.
 */
let suppressNextCanvasClick = false;

/**
 * @param {'left'|'right'} button
 * @returns {boolean}
 */
function isMouseButtonDown(button) {
    if (button === 'right') return !!mouseButtonState.right;
    return !!mouseButtonState.left;
}

/**
 * @returns {{ left: boolean, right: boolean }}
 */
function getMouseButtonState() {
    return { left: !!mouseButtonState.left, right: !!mouseButtonState.right };
}

/**
 * Mark that the next contextmenu should be swallowed (chord Look).
 */
function armSuppressNextContextMenu() {
    suppressNextContextMenu = true;
}

/**
 * Consume suppress flag (true once if armed).
 * @returns {boolean}
 */
function consumeSuppressNextContextMenu() {
    if (!suppressNextContextMenu) return false;
    suppressNextContextMenu = false;
    return true;
}

/**
 * Mark that the next canvas LMB click should be swallowed (ground drag).
 */
function armSuppressNextCanvasClick() {
    suppressNextCanvasClick = true;
}

/**
 * Consume canvas-click suppress flag (true once if armed).
 * @returns {boolean}
 */
function consumeSuppressNextCanvasClick() {
    if (!suppressNextCanvasClick) return false;
    suppressNextCanvasClick = false;
    return true;
}

let mouseButtonTrackingInitialized = false;

/**
 * Track LMB/RMB held state for Classic Look chord (docs/29 Q7.1).
 * Call once from app bootstrap (browser).
 */
function initMouseButtonTracking() {
    if (mouseButtonTrackingInitialized) return;
    if (typeof window === 'undefined') return;
    mouseButtonTrackingInitialized = true;

    const setBtn = (button, down) => {
        if (button === 0) mouseButtonState.left = down;
        else if (button === 2) mouseButtonState.right = down;
    };

    window.addEventListener(
        'pointerdown',
        (ev) => {
            setBtn(ev.button, true);
        },
        true
    );
    window.addEventListener(
        'pointerup',
        (ev) => {
            setBtn(ev.button, false);
        },
        true
    );
    window.addEventListener(
        'pointercancel',
        (ev) => {
            setBtn(ev.button, false);
        },
        true
    );
    window.addEventListener('blur', () => {
        mouseButtonState.left = false;
        mouseButtonState.right = false;
        suppressNextContextMenu = false;
        suppressNextCanvasClick = false;
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            mouseButtonState.left = false;
            mouseButtonState.right = false;
            suppressNextContextMenu = false;
            suppressNextCanvasClick = false;
        }
    });
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
            const stopKeys = getStopCancelHotkeys();
            const chaseKeys = Array.isArray(shortcuts.toggleAutoChase) ? shortcuts.toggleAutoChase : ['T', 'KEYT'];

            const cycleTarget = manualControlsOpts && manualControlsOpts.cycleTarget;

            if (matchesKey(prevKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                ev.stopPropagation();
                if (typeof cycleTarget === 'function') cycleTarget(sim, player, -1);
                return;
            }
            if (matchesKey(nextKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                ev.stopPropagation();
                if (typeof cycleTarget === 'function') cycleTarget(sim, player, 1);
                return;
            }
            // "Stop Autowalk / Cancel Action": clear use-with crosshair and stop walk
            if (matchesKey(stopKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                ev.stopPropagation();
                cancelTargetCursorIfActive();
                player.commandQueue.push({ type: 'STOP_AUTOWALK' });
                return;
            }
            if (matchesKey(chaseKeys, ev.key, ev.code, ev)) {
                ev.preventDefault();
                const currentChase = !player.autoChase;
                player.autoChase = currentChase;
                player.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: currentChase });
                writePersistedAutoChase(currentChase);
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
        }, { capture: true });

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
        }, { capture: true });

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
    STORAGE_KEY_MOUSE_CONTROLS,
    STORAGE_KEY_AUTO_CHASE,
    DEFAULT_MOUSE_CONTROLS,
    readPersistedAutoChase,
    writePersistedAutoChase,
    normalizeMouseControls,
    snapshotMouseControls,
    applyMouseControls,
    loadMouseControls,
    saveMouseControls,
    setMouseControlMode,
    setLootControlMode,
    setTalkOnRightClick,
    setMoveStack,
    isMouseButtonDown,
    getMouseButtonState,
    armSuppressNextContextMenu,
    consumeSuppressNextContextMenu,
    armSuppressNextCanvasClick,
    consumeSuppressNextCanvasClick,
    initMouseButtonTracking,
    enterTargetCursorMode,
    clearTargetCursorMode,
    cancelTargetCursorIfActive,
    getStopCancelHotkeys,
    isStopCancelHotkeyEvent,
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
