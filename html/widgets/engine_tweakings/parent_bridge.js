/**
 * Parent-side bridge: open Engine Tweakings as a real browser popup and apply
 * settings received via postMessage (same Settings object as the running hunt).
 *
 * Optional session handlers drive play / pause / stop / seek from the popup
 * (multi-monitor transport controls).
 */

'use strict';

const {
    ENGINE_TWEAKS_CHANNEL,
    ENGINE_TWEAKS_WINDOW_NAME,
    ENGINE_TWEAKS_URL_PATH
} = require('./protocol.js');
const {
    persistDebugAI,
    persistCamera,
    persistProgression,
    applyTileScale,
    applySpriteJumpHeight,
    clampTileScale,
    clampSpriteJumpHeight,
    TILE_SCALE_DEFAULT,
    SPRITE_JUMP_HEIGHT_DEFAULT,
    snapshotProgressionPrefs,
    DEFAULT_EXP_RATES,
    DEFAULT_SKILL_RATES,
    EXP_RATE_KEYS,
    SKILL_RATE_KEYS
} = require('./bind.js');
const {
    ensureDebugAI,
    applyDebugAIPatch,
    snapshotDebugAI
} = require('../../../kernel/core/lib/ai_debug_draw.js');
const { appUrl } = require('../../../kernel/core/lib/app_paths.js');
const {
    snapshotMouseControls,
    applyMouseControls,
    saveMouseControls
} = require('../../../kernel/apps/game/ui_state.js');

const DEBUG_AI_SHAPE = {
    enabled: false,
    states: false,
    paths: false,
    targets: false,
    ranges: false,
    spawns: false,
    hitSources: false
};

/** Default toolbars per dock when action_bars is unavailable. */
const DEFAULT_LAYOUT_COUNTS = { top: 1, bottom: 1, left: 1, right: 1 };

/**
 * Clamp a single dock bar count to 0..3 (Stage C).
 * @param {*} n
 * @returns {number}
 */
function clampLayoutBarCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(3, Math.floor(v)));
}

/**
 * @param {object|null|undefined} raw
 * @returns {{ top: number, bottom: number, left: number, right: number }}
 */
function normalizeLayoutCountsPatch(raw) {
    const d = DEFAULT_LAYOUT_COUNTS;
    if (!raw || typeof raw !== 'object') {
        return { top: d.top, bottom: d.bottom, left: d.left, right: d.right };
    }
    return {
        top: raw.top !== undefined ? clampLayoutBarCount(raw.top) : d.top,
        bottom: raw.bottom !== undefined ? clampLayoutBarCount(raw.bottom) : d.bottom,
        left: raw.left !== undefined ? clampLayoutBarCount(raw.left) : d.left,
        right: raw.right !== undefined ? clampLayoutBarCount(raw.right) : d.right
    };
}

/**
 * Default empty session snapshot for the popup (no live hunt).
 * @returns {object}
 */
function emptySessionSnapshot() {
    return {
        live: false,
        paused: false,
        seeking: false,
        status: 'READY',
        playback: { current: 0, max: 0 }
    };
}

/**
 * Pure: merge a protocol patch into a snapshot-like bag (for unit tests).
 * Only known keys are applied; unknown keys ignored.
 * @param {object} state current snapshot-shaped object
 * @param {object} patch
 * @returns {object} new state with patch applied
 */
function mergeTweaksPatch(state, patch) {
    const baseDebug =
        state && state.debugAI && typeof state.debugAI === 'object'
            ? state.debugAI
            : {};
    const baseCam =
        state && state.camera && typeof state.camera === 'object'
            ? state.camera
            : {};
    const baseSession =
        state && state.session && typeof state.session === 'object'
            ? state.session
            : emptySessionSnapshot();
    const baseLayout =
        state && state.layoutCounts && typeof state.layoutCounts === 'object'
            ? state.layoutCounts
            : DEFAULT_LAYOUT_COUNTS;
    const next = {
        debugAI: Object.assign({}, DEBUG_AI_SHAPE, baseDebug),
        TIME_SPEED:
            state && typeof state.TIME_SPEED === 'number'
                ? state.TIME_SPEED
                : 1,
        camera: {
            scale: clampTileScale(
                baseCam.scale != null ? baseCam.scale : TILE_SCALE_DEFAULT
            ),
            spriteJumpHeight: clampSpriteJumpHeight(
                baseCam.spriteJumpHeight != null
                    ? baseCam.spriteJumpHeight
                    : SPRITE_JUMP_HEIGHT_DEFAULT
            )
        },
        session: {
            live: !!baseSession.live,
            paused: !!baseSession.paused,
            seeking: !!baseSession.seeking,
            status: baseSession.status || 'READY',
            playback: {
                current:
                    baseSession.playback &&
                    typeof baseSession.playback.current === 'number'
                        ? baseSession.playback.current
                        : 0,
                max:
                    baseSession.playback &&
                    typeof baseSession.playback.max === 'number'
                        ? baseSession.playback.max
                        : 0
            }
        },
        layoutCounts: normalizeLayoutCountsPatch(baseLayout)
    };
    if (!patch || typeof patch !== 'object') return next;
    if (patch.debugAI && typeof patch.debugAI === 'object') {
        for (const k of Object.keys(DEBUG_AI_SHAPE)) {
            if (typeof patch.debugAI[k] === 'boolean') {
                next.debugAI[k] = patch.debugAI[k];
            }
        }
    }
    if (typeof patch.TIME_SPEED === 'number' && Number.isFinite(patch.TIME_SPEED)) {
        next.TIME_SPEED = Math.max(0.25, Math.min(20, patch.TIME_SPEED));
    }
    if (patch.camera && typeof patch.camera === 'object') {
        if (typeof patch.camera.scale === 'number' && Number.isFinite(patch.camera.scale)) {
            next.camera.scale = clampTileScale(patch.camera.scale);
        }
        if (typeof patch.camera.spriteJumpHeight === 'number' && Number.isFinite(patch.camera.spriteJumpHeight)) {
            next.camera.spriteJumpHeight = clampSpriteJumpHeight(patch.camera.spriteJumpHeight);
        }
    }
    next.features = Object.assign(
        { expProgression: false, skillProgression: false },
        state && state.features && typeof state.features === 'object'
            ? state.features
            : {}
    );
    next.expRates = Object.assign(
        {},
        DEFAULT_EXP_RATES,
        state && state.expRates && typeof state.expRates === 'object'
            ? state.expRates
            : {}
    );
    next.skillRates = Object.assign(
        {},
        DEFAULT_SKILL_RATES,
        state && state.skillRates && typeof state.skillRates === 'object'
            ? state.skillRates
            : {}
    );
    if (patch.features && typeof patch.features === 'object') {
        if (typeof patch.features.expProgression === 'boolean') {
            next.features.expProgression = patch.features.expProgression;
        }
        if (typeof patch.features.skillProgression === 'boolean') {
            next.features.skillProgression = patch.features.skillProgression;
        }
    }
    if (patch.expRates && typeof patch.expRates === 'object') {
        for (let i = 0; i < EXP_RATE_KEYS.length; i++) {
            const k = EXP_RATE_KEYS[i];
            if (
                typeof patch.expRates[k] === 'number' &&
                Number.isFinite(patch.expRates[k])
            ) {
                next.expRates[k] = patch.expRates[k];
            }
        }
    }
    if (patch.skillRates && typeof patch.skillRates === 'object') {
        for (let i = 0; i < SKILL_RATE_KEYS.length; i++) {
            const k = SKILL_RATE_KEYS[i];
            if (
                typeof patch.skillRates[k] === 'number' &&
                Number.isFinite(patch.skillRates[k])
            ) {
                next.skillRates[k] = patch.skillRates[k];
            }
        }
    }
    if (patch.session && typeof patch.session === 'object') {
        if (typeof patch.session.live === 'boolean') next.session.live = patch.session.live;
        if (typeof patch.session.paused === 'boolean') {
            next.session.paused = patch.session.paused;
        }
        if (typeof patch.session.seeking === 'boolean') {
            next.session.seeking = patch.session.seeking;
        }
        if (typeof patch.session.status === 'string') {
            next.session.status = patch.session.status;
        }
        if (patch.session.playback && typeof patch.session.playback === 'object') {
            if (typeof patch.session.playback.current === 'number') {
                next.session.playback.current = Math.max(
                    0,
                    patch.session.playback.current | 0
                );
            }
            if (typeof patch.session.playback.max === 'number') {
                next.session.playback.max = Math.max(
                    0,
                    patch.session.playback.max | 0
                );
            }
        }
    }
    if (patch.layoutCounts && typeof patch.layoutCounts === 'object') {
        next.layoutCounts = normalizeLayoutCountsPatch(
            Object.assign({}, next.layoutCounts, patch.layoutCounts)
        );
    }
    return next;
}

/**
 * @param {{
 *   Settings: object,
 *   Application?: object,
 *   actionBars?: {
 *     state?: { layoutCounts?: object },
 *     setLayoutCounts?: (partial: object, opts?: object) => object
 *   },
 *   session?: {
 *     getState?: () => object,
 *     play?: () => void|Promise<void>,
 *     pause?: () => void,
 *     stop?: () => void,
 *     seek?: (tick: number) => void|Promise<void>
 *   }
 * }} ctx
 */
function createEngineTweakingsParentBridge(ctx) {
    const { Settings, session: sessionApi, actionBars } = ctx;
    let popup = null;
    let bound = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    let pollTimer = null;

    function readSessionSnapshot() {
        if (sessionApi && typeof sessionApi.getState === 'function') {
            try {
                const snap = sessionApi.getState();
                if (snap && typeof snap === 'object') {
                    return {
                        live: !!snap.live,
                        paused: !!snap.paused,
                        seeking: !!snap.seeking,
                        status:
                            typeof snap.status === 'string' && snap.status
                                ? snap.status
                                : snap.live
                                  ? snap.paused
                                      ? 'PAUSED'
                                      : 'RUNNING'
                                  : 'READY',
                        playback: {
                            current:
                                snap.playback &&
                                typeof snap.playback.current === 'number'
                                    ? Math.max(0, snap.playback.current | 0)
                                    : 0,
                            max:
                                snap.playback &&
                                typeof snap.playback.max === 'number'
                                    ? Math.max(0, snap.playback.max | 0)
                                    : 0
                        }
                    };
                }
            } catch (err) {
                console.warn('Engine tweakings session getState failed:', err);
            }
        }
        return emptySessionSnapshot();
    }

    function readLayoutCounts() {
        if (
            actionBars &&
            actionBars.state &&
            actionBars.state.layoutCounts &&
            typeof actionBars.state.layoutCounts === 'object'
        ) {
            return normalizeLayoutCountsPatch(actionBars.state.layoutCounts);
        }
        return normalizeLayoutCountsPatch(DEFAULT_LAYOUT_COUNTS);
    }

    function snapshotState() {
        ensureDebugAI();
        const scale = clampTileScale(
            Settings.tileWidth != null ? Settings.tileWidth : TILE_SCALE_DEFAULT
        );
        const spriteJumpHeight = clampSpriteJumpHeight(Settings.spriteJumpHeight);
        const prog = snapshotProgressionPrefs(Settings);
        return {
            debugAI: snapshotDebugAI(),
            TIME_SPEED:
                typeof Settings.TIME_SPEED === 'number' ? Settings.TIME_SPEED : 1,
            camera: { scale, spriteJumpHeight },
            session: readSessionSnapshot(),
            features: prog.features,
            expRates: prog.expRates,
            skillRates: prog.skillRates,
            mouseControls: snapshotMouseControls(),
            layoutCounts: readLayoutCounts()
        };
    }

    function postToPopup(msg) {
        if (!popup || popup.closed) return;
        try {
            popup.postMessage(
                { channel: ENGINE_TWEAKS_CHANNEL, ...msg },
                window.location.origin
            );
        } catch (err) {
            console.warn('Engine tweakings postMessage failed:', err);
        }
    }

    function sendState() {
        postToPopup({ type: 'state', state: snapshotState() });
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startPoll() {
        if (pollTimer) return;
        // Keep scrubber / pause labels live while the popup is open
        pollTimer = setInterval(() => {
            if (!popup || popup.closed) {
                stopPoll();
                popup = null;
                return;
            }
            sendState();
        }, 250);
    }

    function applyPatch(patch) {
        if (!patch || typeof patch !== 'object') return;

        if (patch.debugAI && typeof patch.debugAI === 'object') {
            applyDebugAIPatch(patch.debugAI);
            persistDebugAI(Settings);
        }

        if (
            typeof patch.TIME_SPEED === 'number' &&
            Number.isFinite(patch.TIME_SPEED)
        ) {
            Settings.TIME_SPEED = Math.max(0.25, Math.min(20, patch.TIME_SPEED));
            // Keep hunt page speed slider in sync when present
            try {
                const slider = document.getElementById('speedSlider');
                const valEl = document.getElementById('speedVal');
                if (slider) slider.value = String(Settings.TIME_SPEED);
                if (valEl) valEl.textContent = Settings.TIME_SPEED.toFixed(2);
            } catch (_) {
                /* ignore */
            }
        }

        // Camera zoom → square tile px (soccer-oss Settings.camera.scale parity)
        if (patch.camera && typeof patch.camera === 'object') {
            if (
                typeof patch.camera.scale === 'number' &&
                Number.isFinite(patch.camera.scale)
            ) {
                applyTileScale(Settings, patch.camera.scale);
                persistCamera(Settings);
            }
            if (
                typeof patch.camera.spriteJumpHeight === 'number' &&
                Number.isFinite(patch.camera.spriteJumpHeight)
            ) {
                applySpriteJumpHeight(Settings, patch.camera.spriteJumpHeight);
                persistCamera(Settings);
            }
        }

        // Progression: only apply when session is not live (UI also disables controls)
        const sessionSnap = readSessionSnapshot();
        const progressionLocked = !!sessionSnap.live;
        if (!progressionLocked) {
            let progressionDirty = false;
            if (patch.features && typeof patch.features === 'object') {
                if (!Settings.features || typeof Settings.features !== 'object') {
                    Settings.features = {};
                }
                if (typeof patch.features.expProgression === 'boolean') {
                    Settings.features.expProgression = patch.features.expProgression;
                    progressionDirty = true;
                }
                if (typeof patch.features.skillProgression === 'boolean') {
                    Settings.features.skillProgression =
                        patch.features.skillProgression;
                    progressionDirty = true;
                }
            }
            if (patch.expRates && typeof patch.expRates === 'object') {
                if (!Settings.expRates || typeof Settings.expRates !== 'object') {
                    Settings.expRates = {};
                }
                for (let i = 0; i < EXP_RATE_KEYS.length; i++) {
                    const k = EXP_RATE_KEYS[i];
                    if (
                        typeof patch.expRates[k] === 'number' &&
                        Number.isFinite(patch.expRates[k])
                    ) {
                        Settings.expRates[k] = patch.expRates[k];
                        progressionDirty = true;
                    }
                }
            }
            if (patch.skillRates && typeof patch.skillRates === 'object') {
                if (!Settings.skillRates || typeof Settings.skillRates !== 'object') {
                    Settings.skillRates = {};
                }
                for (let i = 0; i < SKILL_RATE_KEYS.length; i++) {
                    const k = SKILL_RATE_KEYS[i];
                    if (
                        typeof patch.skillRates[k] === 'number' &&
                        Number.isFinite(patch.skillRates[k])
                    ) {
                        Settings.skillRates[k] = patch.skillRates[k];
                        progressionDirty = true;
                    }
                }
            }
            if (progressionDirty) {
                persistProgression(Settings);
            }
        }

        // Mouse controls (docs/29 Stage 3) — live; independent of session freeze
        if (patch.mouseControls && typeof patch.mouseControls === 'object') {
            const prev = snapshotMouseControls();
            applyMouseControls({
                mouseControlMode:
                    patch.mouseControls.mouseControlMode !== undefined
                        ? patch.mouseControls.mouseControlMode
                        : prev.mouseControlMode,
                lootControlMode:
                    patch.mouseControls.lootControlMode !== undefined
                        ? patch.mouseControls.lootControlMode
                        : prev.lootControlMode,
                talkOnRightClick:
                    patch.mouseControls.talkOnRightClick !== undefined
                        ? patch.mouseControls.talkOnRightClick
                        : prev.talkOnRightClick,
                moveStack:
                    patch.mouseControls.moveStack !== undefined
                        ? patch.mouseControls.moveStack
                        : prev.moveStack
            });
            saveMouseControls();
        }

        // Action bar toolbars per dock (Stage C) — live remount + hdl_action_bars persist
        if (patch.layoutCounts && typeof patch.layoutCounts === 'object') {
            if (actionBars && typeof actionBars.setLayoutCounts === 'function') {
                try {
                    actionBars.setLayoutCounts(patch.layoutCounts);
                } catch (err) {
                    console.warn('Engine tweakings setLayoutCounts failed:', err);
                }
            }
        }
    }

    /**
     * @param {object} data
     */
    function handleCommand(data) {
        if (!sessionApi || !data || typeof data.command !== 'string') return;
        const cmd = data.command;
        try {
            if (cmd === 'play' && typeof sessionApi.play === 'function') {
                void sessionApi.play();
            } else if (cmd === 'pause' && typeof sessionApi.pause === 'function') {
                sessionApi.pause();
            } else if (cmd === 'stop' && typeof sessionApi.stop === 'function') {
                sessionApi.stop();
            } else if (cmd === 'seek' && typeof sessionApi.seek === 'function') {
                const tick =
                    typeof data.tick === 'number' && Number.isFinite(data.tick)
                        ? Math.max(0, data.tick | 0)
                        : 0;
                void sessionApi.seek(tick);
            }
        } catch (err) {
            console.warn('Engine tweakings session command failed:', cmd, err);
        }
        // Immediate UI feedback; poll continues for live scrubber ticks
        sendState();
    }

    function applyMessage(data, source) {
        if (!data || data.channel !== ENGINE_TWEAKS_CHANNEL) return;
        switch (data.type) {
            case 'ready':
                // Always re-bind popup to the message source (handles reloads / second open)
                if (source) {
                    popup = source;
                    sendState();
                    startPoll();
                }
                break;
            case 'patch':
                applyPatch(data.patch || {});
                sendState();
                break;
            case 'command':
                handleCommand(data);
                break;
            case 'closing':
                // Do NOT null popup immediately on reload (beforeunload fires mid-nav).
                if (!popup || popup.closed || (source && source !== popup)) {
                    if (popup && popup.closed) {
                        popup = null;
                        stopPoll();
                    }
                } else {
                    const ref = popup;
                    setTimeout(() => {
                        if (popup === ref && popup.closed) {
                            popup = null;
                            stopPoll();
                        }
                    }, 250);
                }
                break;
            default:
                break;
        }
    }

    function onMessage(event) {
        if (event.origin !== window.location.origin) return;
        if (popup && !popup.closed && event.source && event.source !== popup) {
            return;
        }
        applyMessage(event.data, event.source);
    }

    function bindListeners() {
        if (bound) return;
        bound = true;
        window.addEventListener('message', onMessage);
        const closePopup = () => {
            stopPoll();
            if (popup && !popup.closed) {
                try {
                    popup.close();
                } catch (_) {
                    /* ignore */
                }
            }
            popup = null;
        };
        window.addEventListener('beforeunload', closePopup);
        window.addEventListener('pagehide', closePopup);
    }

    /**
     * Open popup, or if already open: focus + re-send live Settings (no full reload).
     * @returns {Window|null}
     */
    function open() {
        bindListeners();

        if (popup && !popup.closed) {
            try {
                popup.focus();
            } catch (_) {
                /* ignore */
            }
            sendState();
            startPoll();
            return popup;
        }

        const features = [
            'width=520',
            'height=720',
            'menubar=no',
            'toolbar=no',
            'location=no',
            'status=no',
            'resizable=yes',
            'scrollbars=yes'
        ].join(',');

        const url = appUrl(ENGINE_TWEAKS_URL_PATH);
        popup = window.open(url, ENGINE_TWEAKS_WINDOW_NAME, features);
        if (!popup) {
            console.warn(
                'Engine Tweakings popup blocked — allow popups for this site.'
            );
            return null;
        }
        try {
            popup.focus();
        } catch (_) {
            /* ignore */
        }
        startPoll();
        return popup;
    }

    function dispose() {
        stopPoll();
        if (popup && !popup.closed) {
            try {
                popup.close();
            } catch (_) {
                /* ignore */
            }
        }
        popup = null;
        if (bound) {
            window.removeEventListener('message', onMessage);
            bound = false;
        }
    }

    return {
        open,
        sendState,
        applyPatch,
        snapshotState,
        dispose,
        get popup() {
            return popup;
        }
    };
}

module.exports = {
    createEngineTweakingsParentBridge,
    mergeTweaksPatch,
    emptySessionSnapshot,
    normalizeLayoutCountsPatch,
    clampLayoutBarCount,
    DEFAULT_LAYOUT_COUNTS,
    ENGINE_TWEAKS_CHANNEL,
    ENGINE_TWEAKS_WINDOW_NAME,
    ENGINE_TWEAKS_URL_PATH
};
