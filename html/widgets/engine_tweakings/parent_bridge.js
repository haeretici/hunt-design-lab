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
    applyTileScale,
    clampTileScale,
    TILE_SCALE_DEFAULT
} = require('./bind.js');
const {
    ensureDebugAI,
    applyDebugAIPatch,
    snapshotDebugAI
} = require('../../../kernel/core/lib/ai_debug_draw.js');
const { appUrl } = require('../../../kernel/core/lib/app_paths.js');

const DEBUG_AI_SHAPE = {
    enabled: false,
    states: false,
    paths: false,
    targets: false,
    ranges: false,
    spawns: false,
    hitSources: false
};

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
    const next = {
        debugAI: Object.assign({}, DEBUG_AI_SHAPE, baseDebug),
        TIME_SPEED:
            state && typeof state.TIME_SPEED === 'number'
                ? state.TIME_SPEED
                : 1,
        camera: {
            scale: clampTileScale(
                baseCam.scale != null ? baseCam.scale : TILE_SCALE_DEFAULT
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
        }
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
    }
    next.features = Object.assign(
        { expProgression: false, skillProgression: false },
        state && state.features && typeof state.features === 'object'
            ? state.features
            : {}
    );
    next.expRates = Object.assign(
        {
            baseRate: 1,
            eventMult: 1,
            staminaMult: 1,
            additiveBonus: 0,
            prey: 0,
            xpBoost: 0
        },
        state && state.expRates && typeof state.expRates === 'object'
            ? state.expRates
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
        const rateKeys = [
            'baseRate',
            'eventMult',
            'staminaMult',
            'additiveBonus',
            'prey',
            'xpBoost'
        ];
        for (let i = 0; i < rateKeys.length; i++) {
            const k = rateKeys[i];
            if (
                typeof patch.expRates[k] === 'number' &&
                Number.isFinite(patch.expRates[k])
            ) {
                next.expRates[k] = patch.expRates[k];
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
    return next;
}

/**
 * @param {{
 *   Settings: object,
 *   Application?: object,
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
    const { Settings, session: sessionApi } = ctx;
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

    function snapshotProgression() {
        const f = Settings.features || {};
        const r = Settings.expRates || {};
        return {
            features: {
                expProgression: f.expProgression === true,
                skillProgression: f.skillProgression === true
            },
            expRates: {
                baseRate: typeof r.baseRate === 'number' ? r.baseRate : 1,
                eventMult: typeof r.eventMult === 'number' ? r.eventMult : 1,
                staminaMult: typeof r.staminaMult === 'number' ? r.staminaMult : 1,
                additiveBonus:
                    typeof r.additiveBonus === 'number' ? r.additiveBonus : 0,
                prey: typeof r.prey === 'number' ? r.prey : 0,
                xpBoost: typeof r.xpBoost === 'number' ? r.xpBoost : 0
            }
        };
    }

    function snapshotState() {
        ensureDebugAI();
        const scale = clampTileScale(
            Settings.tileWidth != null ? Settings.tileWidth : TILE_SCALE_DEFAULT
        );
        const prog = snapshotProgression();
        return {
            debugAI: snapshotDebugAI(),
            TIME_SPEED:
                typeof Settings.TIME_SPEED === 'number' ? Settings.TIME_SPEED : 1,
            camera: { scale },
            session: readSessionSnapshot(),
            features: prog.features,
            expRates: prog.expRates
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
        }

        // Progression: only apply when session is not live (UI also disables controls)
        const sessionSnap = readSessionSnapshot();
        const progressionLocked = !!sessionSnap.live;
        if (!progressionLocked) {
            if (patch.features && typeof patch.features === 'object') {
                if (!Settings.features || typeof Settings.features !== 'object') {
                    Settings.features = {};
                }
                if (typeof patch.features.expProgression === 'boolean') {
                    Settings.features.expProgression = patch.features.expProgression;
                }
                if (typeof patch.features.skillProgression === 'boolean') {
                    Settings.features.skillProgression =
                        patch.features.skillProgression;
                }
            }
            if (patch.expRates && typeof patch.expRates === 'object') {
                if (!Settings.expRates || typeof Settings.expRates !== 'object') {
                    Settings.expRates = {};
                }
                const keys = [
                    'baseRate',
                    'eventMult',
                    'staminaMult',
                    'additiveBonus',
                    'prey',
                    'xpBoost'
                ];
                for (let i = 0; i < keys.length; i++) {
                    const k = keys[i];
                    if (
                        typeof patch.expRates[k] === 'number' &&
                        Number.isFinite(patch.expRates[k])
                    ) {
                        Settings.expRates[k] = patch.expRates[k];
                    }
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
    ENGINE_TWEAKS_CHANNEL,
    ENGINE_TWEAKS_WINDOW_NAME,
    ENGINE_TWEAKS_URL_PATH
};
