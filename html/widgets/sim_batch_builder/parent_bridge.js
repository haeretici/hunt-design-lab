/**
 * Parent-side bridge: open Hunt Sim Batch Builder as a real browser popup
 * and prefill form values via postMessage (seed / hunt / party draft).
 *
 * Child works alone without opener — prefill is convenience only.
 * Never executes Node batches from the parent tab.
 */

'use strict';

const {
    SIM_BATCH_CHANNEL,
    SIM_BATCH_WINDOW_NAME,
    SIM_BATCH_URL_PATH
} = require('./protocol.js');
const { appUrl } = require('../../../kernel/core/lib/app_paths.js');

/**
 * Pure: merge parent prefill into a form-shaped object (for unit tests).
 * Only known keys are applied; unknown keys ignored.
 * @param {object} form current form bag
 * @param {object|null|undefined} state parent state snapshot
 * @returns {object} new form with state applied
 */
function mergeSimBatchPrefill(form, state) {
    const next = Object.assign({}, form || {});
    if (!state || typeof state !== 'object') return next;

    if (state.seed != null && Number.isFinite(Number(state.seed))) {
        next.seed = Math.max(1, Math.floor(Number(state.seed)));
    }
    if (state.huntId != null && String(state.huntId).trim() !== '') {
        next.huntId = String(state.huntId).trim();
    }
    if (
        state.iterations != null &&
        Number.isFinite(Number(state.iterations))
    ) {
        next.iterations = Math.max(1, Math.floor(Number(state.iterations)));
    }
    if (
        state.concurrency != null &&
        Number.isFinite(Number(state.concurrency))
    ) {
        next.concurrency = Math.max(1, Math.floor(Number(state.concurrency)));
    }
    if (state.outDir != null && String(state.outDir).trim() !== '') {
        next.outDir = String(state.outDir).trim();
    }
    if (state.frames != null && Number.isFinite(Number(state.frames))) {
        next.frames = Math.max(1, Math.floor(Number(state.frames)));
    }
    if (state.maxKills != null && Number.isFinite(Number(state.maxKills))) {
        next.maxKills = Math.max(1, Math.floor(Number(state.maxKills)));
    }
    if (state.maxTicks != null && Number.isFinite(Number(state.maxTicks))) {
        next.maxTicks = Math.max(1, Math.floor(Number(state.maxTicks)));
    }
    if (state.strategyOverride != null) {
        next.strategyOverride = String(state.strategyOverride).trim();
    }
    if (Array.isArray(state.members)) {
        next.members = state.members.slice();
    }
    if (typeof state.quiet === 'boolean') {
        next.quiet = state.quiet;
    }
    return next;
}

/**
 * @param {{ getState: () => object }} ctx
 *   getState() returns { seed, huntId, members?, … } snapshot for prefill
 */
function createSimBatchParentBridge(ctx) {
    const getState = ctx && typeof ctx.getState === 'function' ? ctx.getState : () => ({});
    let popup = null;
    let bound = false;

    function postToPopup(msg) {
        if (!popup || popup.closed) return;
        try {
            popup.postMessage(
                { channel: SIM_BATCH_CHANNEL, ...msg },
                window.location.origin
            );
        } catch (err) {
            console.warn('Sim Batch postMessage failed:', err);
        }
    }

    function sendState() {
        let state = {};
        try {
            state = getState() || {};
        } catch (err) {
            console.warn('Sim Batch getState failed:', err);
            state = {};
        }
        postToPopup({ type: 'state', state });
    }

    function applyMessage(data, source) {
        if (!data || data.channel !== SIM_BATCH_CHANNEL) return;
        switch (data.type) {
            case 'ready':
                if (source) {
                    popup = source;
                    sendState();
                }
                break;
            case 'closing':
                if (!popup || popup.closed || (source && source !== popup)) {
                    if (popup && popup.closed) popup = null;
                } else {
                    const ref = popup;
                    setTimeout(() => {
                        if (popup === ref && popup.closed) popup = null;
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
     * Open popup, or if already open: focus + re-send live prefill (no full reload).
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
            return popup;
        }

        const features = [
            'width=920',
            'height=860',
            'menubar=no',
            'toolbar=no',
            'location=no',
            'status=no',
            'resizable=yes',
            'scrollbars=yes'
        ].join(',');

        const url = appUrl(SIM_BATCH_URL_PATH);
        popup = window.open(url, SIM_BATCH_WINDOW_NAME, features);
        if (!popup) {
            console.warn(
                'Sim Batch popup blocked — allow popups for this site.'
            );
            return null;
        }
        try {
            popup.focus();
        } catch (_) {
            /* ignore */
        }
        return popup;
    }

    return {
        open,
        sendState,
        get popup() {
            return popup;
        }
    };
}

module.exports = {
    createSimBatchParentBridge,
    mergeSimBatchPrefill,
    SIM_BATCH_CHANNEL,
    SIM_BATCH_WINDOW_NAME,
    SIM_BATCH_URL_PATH
};
