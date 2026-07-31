/**
 * Parent-side bridge: open Action Bar Configuration as a real browser popup and apply
 * bindings and keymaps received via postMessage.
 */

'use strict';

const {
    ACTION_BAR_CHANNEL,
    ACTION_BAR_WINDOW_NAME,
    ACTION_BAR_URL_PATH
} = require('./protocol.js');
const { appUrl } = require('../../../kernel/core/lib/app_paths.js');
const { Settings } = require('../../../kernel/settings.js');
const { loadGeneralHotkeys, saveGeneralHotkeys } = require('../../../kernel/apps/game/ui_state.js');

/**
 * @param {object} opts
 * @param {object} opts.actionBars kernel action_bars module
 * @param {() => Record<string, object>|null} [opts.getSpellBook]
 * @param {() => object|null} [opts.getItemDb]
 * @param {() => string} [opts.getGenre]
 * @param {() => object|null} [opts.getActivePlayer]
 */
function createActionBarParentBridge(opts) {
    const actionBars = opts && opts.actionBars;
    const getSpellBook = (opts && opts.getSpellBook) || (() => null);
    const getItemDb = (opts && opts.getItemDb) || (() => null);
    const getGenre = (opts && opts.getGenre) || (() => 'rpg_fantasy');
    const getActivePlayer = (opts && opts.getActivePlayer) || (() => null);

    /** @type {Window|null} */
    let popup = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    let pollTimer = null;
    let bound = false;
    /** @type {string|null} */
    let lastStateSig = null;

    function snapshotState() {
        if (!actionBars || !actionBars.state) return {};
        const state = actionBars.state;
        const player = getActivePlayer() || {};
        const classId = player.classId || player.vocation || state.activeProfileId || 'guardian';
        
        let spellBook = {};
        try {
            const rawSpells = getSpellBook();
            if (Array.isArray(rawSpells)) {
                for (let i = 0; i < rawSpells.length; i++) {
                    const sp = rawSpells[i];
                    if (sp && sp.id) spellBook[sp.id] = sp;
                }
            } else if (rawSpells && typeof rawSpells === 'object' && Array.isArray(rawSpells.spells)) {
                for (let i = 0; i < rawSpells.spells.length; i++) {
                    const sp = rawSpells.spells[i];
                    if (sp && sp.id) spellBook[sp.id] = sp;
                }
            } else if (rawSpells && typeof rawSpells === 'object') {
                spellBook = rawSpells;
            }
        } catch (_) {}
        
        let itemDb = null;
        try {
            const db = getItemDb();
            if (Array.isArray(db)) {
                itemDb = db;
            } else if (db && typeof db === 'object' && Array.isArray(db.items)) {
                itemDb = db.items;
            } else if (db && typeof db === 'object') {
                itemDb = Object.values(db);
            }
        } catch (_) {}

        const activePid = state.activeProfileId || 'guardian';
        loadGeneralHotkeys(activePid);
        return {
            activeProfileId: activePid,
            activePlayerClass: String(classId).toLowerCase(),
            docks: state.docks || {},
            profiles: Object.keys(state.profiles || {}),
            spellBook: spellBook || {},
            itemDb: itemDb || [],
            genre: getGenre(),
            generalHotkeys: (Settings && Settings.MANUAL_CONTROL_SHORTCUTS) || {}
        };
    }

    /**
     * Compute a stable signature of the action bar state.
     * Skips sending redundant state messages on poll when nothing changed.
     * @param {object|null} stateObj
     * @returns {string}
     */
    function computeStateSignature(stateObj) {
        if (!stateObj) return '';
        const docksSig = {};
        const areas = Object.keys(stateObj.docks || {});
        for (let i = 0; i < areas.length; i++) {
            const bars = stateObj.docks[areas[i]];
            if (!Array.isArray(bars)) continue;
            docksSig[areas[i]] = bars.map(b => ({
                id: b.id,
                orientation: b.orientation,
                slots: (b.slots || []).map(s => ({
                    id: s.id,
                    index: s.index,
                    hotkey: s.hotkey,
                    actionType: s.actionType,
                    itemId: s.itemId,
                    spellId: s.spellId,
                    command: s.command,
                    targetMode: s.targetMode
                }))
            }));
        }
        return JSON.stringify({
            activeProfileId: stateObj.activeProfileId,
            activePlayerClass: stateObj.activePlayerClass,
            docks: docksSig,
            profiles: stateObj.profiles,
            spellBook: stateObj.spellBook,
            itemDb: stateObj.itemDb,
            genre: stateObj.genre,
            generalHotkeys: stateObj.generalHotkeys
        });
    }

    function postToPopup(msg) {
        if (!popup || popup.closed) return;
        try {
            const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '*';
            popup.postMessage(
                { channel: ACTION_BAR_CHANNEL, ...msg },
                origin
            );
        } catch (err) {
            console.warn('Action bar config postMessage failed:', err);
        }
    }

    function sendState(force) {
        if (!popup || popup.closed) {
            lastStateSig = null;
            return;
        }
        const state = snapshotState();
        const sig = computeStateSignature(state);
        if (!force && lastStateSig !== null && sig === lastStateSig) {
            return;
        }
        lastStateSig = sig;
        postToPopup({ type: 'state', state });
    }

    function onPopupClosed() {
        stopPoll();
        if (popup && !popup.closed) {
            try { popup.close(); } catch (_) {}
        }
        popup = null;
        lastStateSig = null;
        if (actionBars && actionBars.state) {
            actionBars.state.lastSeenPlayerClass = null;
            if (typeof actionBars.updateActionBars === 'function') {
                actionBars.updateActionBars();
            }
        }
    }

    function stopPoll() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    function startPoll() {
        if (pollTimer) return;
        pollTimer = setInterval(() => {
            if (!popup || popup.closed) {
                onPopupClosed();
                return;
            }
            sendState(false);
        }, 500);
    }

    function applyMessage(data, source) {
        if (!data || data.channel !== ACTION_BAR_CHANNEL) return;
        if (!actionBars || !actionBars.state) return;

        switch (data.type) {
            case 'ready':
                if (source) {
                    popup = source;
                    sendState(true);
                    startPoll();
                }
                break;
            case 'switch_profile':
                if (data.profileId && typeof actionBars.switchProfile === 'function') {
                    actionBars.switchProfile(data.profileId);
                    loadGeneralHotkeys(data.profileId);
                    sendState(true);
                }
                break;
            case 'assign_slot':
                if (data.slotId && typeof actionBars.assignSlot === 'function') {
                    actionBars.assignSlot(data.slotId, data.actionType || 'empty', data.cfg || {});
                    sendState(true);
                }
                break;
            case 'patch_docks':
                if (data.docks && typeof data.docks === 'object') {
                    const areas = ['top', 'bottom', 'left', 'right'];
                    for (let i = 0; i < areas.length; i++) {
                        const k = areas[i];
                        if (Array.isArray(data.docks[k])) {
                            actionBars.state.docks[k] = data.docks[k];
                        }
                    }
                    if (typeof actionBars.rebuildMaps === 'function') {
                        actionBars.rebuildMaps();
                    }
                    if (actionBars.state.activeProfileId) {
                        actionBars.state.profiles[actionBars.state.activeProfileId] = actionBars.state.docks;
                    }
                    if (typeof actionBars.mountDocks === 'function') {
                        actionBars.mountDocks();
                    }
                    if (typeof actionBars.updateActionBars === 'function') {
                        actionBars.state.lastSignatures.clear();
                        actionBars.updateActionBars();
                    }
                    // Persist via action_bars canonical saver (hdl_action_bars only)
                    if (typeof actionBars.saveToStorage === 'function') {
                        actionBars.saveToStorage();
                    } else {
                        try {
                            const LS_KEY_V2 = 'hdl_action_bars';
                            if (typeof window !== 'undefined' && window.localStorage) {
                                const payloadV2 = JSON.stringify({
                                    profiles: actionBars.state.profiles,
                                    activeProfileId: actionBars.state.activeProfileId
                                });
                                window.localStorage.setItem(LS_KEY_V2, payloadV2);
                                try { window.localStorage.removeItem('hdl_keymap'); } catch (_) {}
                                try { window.localStorage.removeItem('huntdl_action_bars_layout'); } catch (_) {}
                            }
                            if (actionBars.state.debouncedIdbSaver) {
                                actionBars.state.debouncedIdbSaver();
                            }
                        } catch (_) {}
                    }
                    sendState(true);
                }
                break;
            case 'patch_general_hotkeys':
                if (data.shortcuts && typeof data.shortcuts === 'object' && Settings && Settings.MANUAL_CONTROL_SHORTCUTS) {
                    for (const k of Object.keys(data.shortcuts)) {
                        if (Array.isArray(data.shortcuts[k])) {
                            Settings.MANUAL_CONTROL_SHORTCUTS[k] = data.shortcuts[k];
                        }
                    }
                    saveGeneralHotkeys(actionBars && actionBars.state ? actionBars.state.activeProfileId : null);
                    sendState(true);
                }
                break;
            case 'copy_general_hotkeys_to_all_profiles':
                if (data.shortcuts && typeof data.shortcuts === 'object' && Settings && Settings.MANUAL_CONTROL_SHORTCUTS) {
                    for (const k of Object.keys(data.shortcuts)) {
                        if (Array.isArray(data.shortcuts[k])) {
                            Settings.MANUAL_CONTROL_SHORTCUTS[k] = JSON.parse(JSON.stringify(data.shortcuts[k]));
                        }
                    }
                    const profilesList = Object.keys((actionBars && actionBars.state && actionBars.state.profiles) || {});
                    saveGeneralHotkeys(actionBars && actionBars.state ? actionBars.state.activeProfileId : null, data.shortcuts, profilesList);
                    sendState(true);
                }
                break;
            case 'closing':
                if (!popup || popup.closed || (source && source !== popup)) {
                    if (popup && popup.closed) {
                        onPopupClosed();
                    }
                } else {
                    const ref = popup;
                    setTimeout(() => {
                        if (popup === ref && popup.closed) {
                            onPopupClosed();
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
            onPopupClosed();
        };
        window.addEventListener('beforeunload', closePopup);
        window.addEventListener('pagehide', closePopup);
    }

    function open() {
        bindListeners();
        if (popup && !popup.closed) {
            try {
                popup.focus();
            } catch (_) {}
            sendState(true);
            startPoll();
            return popup;
        }

        const features = [
            'width=880',
            'height=760',
            'menubar=no',
            'toolbar=no',
            'location=no',
            'status=no',
            'resizable=yes',
            'scrollbars=yes'
        ].join(',');

        const url = appUrl(ACTION_BAR_URL_PATH);
        popup = window.open(url, ACTION_BAR_WINDOW_NAME, features);
        if (!popup) {
            console.warn('Action Bar Config popup blocked — allow popups for this site.');
            return null;
        }
        try {
            popup.focus();
        } catch (_) {}
        startPoll();
        return popup;
    }

    function dispose() {
        onPopupClosed();
        if (bound) {
            window.removeEventListener('message', onMessage);
            bound = false;
        }
    }

    return {
        open,
        dispose,
        sendState,
        applyMessage,
        snapshotState,
        isOpen: () => !!(popup && !popup.closed)
    };
}

module.exports = {
    createActionBarParentBridge
};
