/**
 * Shared manual-control helpers for Hunt Simulator and Scenario Lab shells.
 * Keeps control-mode transfer, canvas click-to-walk/target, and toggle wiring
 * in one place so the two apps cannot drift.
 */

'use strict';

const { Settings } = require('../../settings.js');
const {
    uiState,
    clearTargetCursorMode,
    consumeSuppressNextCanvasClick
} = require('./ui_state.js');
const {
    findCreatureAtTile,
    resolveCanvasHit,
    processMouseAction,
    applyCommandIntents
} = require('./mouse_dispatcher.js');

/**
 * Normalize and queue a control-mode flip for TAS / deterministic replay.
 * Optimistic `player.controlMode` is set immediately (like SET_AUTO_CHASE).
 *
 * @param {object|null|undefined} player
 * @param {string} newMode
 */
function queueSetControlMode(player, newMode) {
    if (!player) return;
    const mode = newMode === 'manual' ? 'manual' : 'ai';
    player.controlMode = mode;
    if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
    player.commandQueue.push({ type: 'SET_CONTROL_MODE', mode });
}

/**
 * When the camera active slot changes, previous manual member returns to AI
 * and manual control transfers to the new slot when the previous was manual.
 * Live flips are queued as SET_CONTROL_MODE so commandHistory stays TAS-complete.
 *
 * @param {object} opts
 * @param {object[]} opts.formMembers
 * @param {number} opts.oldSlot
 * @param {number} opts.newSlot
 * @param {boolean} opts.sessionLive
 * @param {(members: object[], slot: number) => number|null|undefined} opts.enabledMemberIndexForSlot
 * @param {() => { members?: object[] }|null|undefined} [opts.getLiveParty]
 */
function transferManualControlOnSlotChange(opts) {
    const o = opts || {};
    const formMembers = o.formMembers;
    const oldSlot = o.oldSlot;
    const newSlot = o.newSlot;
    if (!formMembers || !formMembers[oldSlot]) return;

    const wasManual = formMembers[oldSlot].controlMode === 'manual';
    formMembers[oldSlot].controlMode = 'ai';
    const oldPfCtrl =
        typeof document !== 'undefined'
            ? document.querySelector(`.pf-control[data-slot="${oldSlot}"]`)
            : null;
    if (oldPfCtrl) oldPfCtrl.value = 'ai';

    if (wasManual && formMembers[newSlot]) {
        formMembers[newSlot].controlMode = 'manual';
        const newPfCtrl =
            typeof document !== 'undefined'
                ? document.querySelector(`.pf-control[data-slot="${newSlot}"]`)
                : null;
        if (newPfCtrl) newPfCtrl.value = 'manual';
    }

    if (!o.sessionLive || typeof o.getLiveParty !== 'function') return;
    const party = o.getLiveParty();
    if (!party || !Array.isArray(party.members)) return;
    const idxFn = o.enabledMemberIndexForSlot;
    if (typeof idxFn !== 'function') return;

    const oldIdx = idxFn(formMembers, oldSlot);
    if (oldIdx != null && party.members[oldIdx]) {
        queueSetControlMode(party.members[oldIdx], 'ai');
    }
    if (wasManual) {
        const newIdx = idxFn(formMembers, newSlot);
        if (newIdx != null && party.members[newIdx]) {
            queueSetControlMode(party.members[newIdx], 'manual');
        }
    }
}

/**
 * Read control mode + auto-chase for the active slot (live player preferred).
 *
 * @param {object} opts
 * @param {boolean} opts.sessionLive
 * @param {object|null|undefined} [opts.livePlayer]
 * @param {object|null|undefined} [opts.formMember]
 * @returns {{ mode: string, autoChase: boolean }}
 */
function readActiveControlState(opts) {
    const o = opts || {};
    let mode = 'ai';
    if (o.sessionLive && o.livePlayer && o.livePlayer.controlMode) {
        mode = o.livePlayer.controlMode;
    } else if (o.formMember && o.formMember.controlMode) {
        mode = o.formMember.controlMode;
    }

    let autoChase = false;
    if (o.sessionLive && o.livePlayer && o.livePlayer.autoChase !== undefined) {
        autoChase = !!o.livePlayer.autoChase;
    } else if (o.formMember && o.formMember.autoChase !== undefined) {
        autoChase = !!o.formMember.autoChase;
    } else {
        try {
            if (typeof window !== 'undefined' && window.localStorage) {
                autoChase = window.localStorage.getItem('hdl_auto_chase') === 'true';
            }
        } catch (_) {}
    }
    return { mode, autoChase };
}

/**
 * Sync Active Control radios + Auto Chase checkbox from form/live state.
 *
 * @param {object} opts
 * @param {boolean} opts.sessionLive
 * @param {object|null|undefined} [opts.livePlayer]
 * @param {object|null|undefined} [opts.formMember]
 */
function syncActiveControlToggle(opts) {
    if (typeof document === 'undefined') return;
    const aiRadio = document.getElementById('controlModeAi');
    const manualRadio = document.getElementById('controlModeManual');
    if (!aiRadio || !manualRadio) return;

    const { mode, autoChase } = readActiveControlState(opts || {});
    if (mode === 'manual') {
        manualRadio.checked = true;
    } else {
        aiRadio.checked = true;
    }
    const optsEl = document.getElementById('manualControlOptions');
    if (optsEl) {
        optsEl.style.display = mode === 'manual' ? '' : 'none';
    }
    const autoChaseEl = /** @type {HTMLInputElement|null} */ (
        document.getElementById('autoChaseToggle')
    );
    if (autoChaseEl) {
        autoChaseEl.checked = autoChase;
    }
}

/**
 * Apply AI/Manual radio / dropdown change to form row + live player.
 * Live sessions queue SET_CONTROL_MODE for commandHistory (TAS / replay).
 *
 * @param {object} opts
 * @param {string} opts.newMode
 * @param {number} opts.activeViewSlot
 * @param {object[]} opts.formMembers
 * @param {boolean} opts.sessionLive
 * @param {object|null|undefined} [opts.livePlayer]
 * @param {() => void} [opts.onSynced]
 */
function applyControlModeChange(opts) {
    const o = opts || {};
    const newMode = o.newMode === 'manual' ? 'manual' : 'ai';
    const slot = o.activeViewSlot;
    const formMembers = o.formMembers;
    if (formMembers && formMembers[slot]) {
        formMembers[slot].controlMode = newMode;
    }
    if (typeof document !== 'undefined') {
        const pfCtrl = document.querySelector(`.pf-control[data-slot="${slot}"]`);
        if (pfCtrl && pfCtrl.value !== newMode) {
            pfCtrl.value = newMode;
        }
    }
    if (o.sessionLive && o.livePlayer) {
        queueSetControlMode(o.livePlayer, newMode);
    }
    if (typeof o.onSynced === 'function') o.onSynced();
}

/**
 * Apply Auto Chase checkbox / form state + queue SET_AUTO_CHASE when live.
 *
 * @param {object} opts
 * @param {boolean} opts.enabled
 * @param {number} opts.activeViewSlot
 * @param {object[]} opts.formMembers
 * @param {boolean} opts.sessionLive
 * @param {object|null|undefined} [opts.livePlayer]
 */
function applyAutoChaseChange(opts) {
    const o = opts || {};
    const enabled = !!o.enabled;
    try {
        if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem('hdl_auto_chase', enabled ? 'true' : 'false');
        }
    } catch (_) {}
    if (o.formMembers && o.formMembers[o.activeViewSlot]) {
        o.formMembers[o.activeViewSlot].autoChase = enabled;
    }
    if (o.sessionLive && o.livePlayer) {
        const player = o.livePlayer;
        player.autoChase = enabled;
        if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
        player.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled });
    }
}

/**
 * Convert a canvas click to world tile coordinates using sim view origin.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} sim
 * @param {MouseEvent} ev
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function canvasEventToTile(canvas, sim, ev) {
    if (!canvas || !sim || !sim.tileMap || !ev) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const scaleX = (canvas.width || rect.width) / rect.width;
    const scaleY = (canvas.height || rect.height) / rect.height;
    const cx = (ev.clientX - rect.left) * scaleX;
    const cy = (ev.clientY - rect.top) * scaleY;
    const tw = Settings.tileWidth || 32;
    const th = Settings.tileHeight || 32;
    const ox = sim.tileMap._viewOriginX || 0;
    const oy = sim.tileMap._viewOriginY || 0;
    const x = Math.floor(cx / tw) + ox;
    const y = Math.floor(cy / th) + oy;
    const z =
        sim.tileMap._viewZ != null
            ? sim.tileMap._viewZ
            : Settings.cameraTileZ != null
              ? Settings.cameraTileZ
              : 0;
    return { x, y, z };
}

/**
 * Queue manual canvas LMB actions via mouse_dispatcher (Stage 2 matrix).
 * Adapter-only intents (LOOK, OPEN_CONTEXT_MENU, …) are returned for the caller.
 *
 * @param {object} opts
 * @param {object} opts.player
 * @param {object} opts.sim
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {string|number} opts.z
 * @param {object[]|Record<string, object>|null|undefined} [opts.itemDb]
 * @param {{ shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean }} [opts.modifiers]
 * @param {(intent: object, ctx: { player: object, sim: object, clientX?: number, clientY?: number }) => void} [opts.onAdapterIntent]
 * @param {number} [opts.clientX]
 * @param {number} [opts.clientY]
 * @returns {boolean} true if a command was queued or an adapter intent was produced
 */
function handleManualCanvasTileAction(opts) {
    const o = opts || {};
    const player = o.player;
    const sim = o.sim;
    const x = o.x;
    const y = o.y;
    const z = o.z;
    if (!player || player.controlMode !== 'manual' || !player.alive) return false;

    const hit = resolveCanvasHit({
        sim,
        player,
        tile: { x, y, z },
        itemDb: o.itemDb
    });
    if (!hit) return false;

    const intents = processMouseAction({
        button: 'left',
        hit,
        mode: uiState && uiState.mouseControlMode != null ? uiState.mouseControlMode : 1,
        lootMode:
            uiState && uiState.lootControlMode != null
                ? uiState.lootControlMode
                : 0,
        talkOnRightClick: !!(uiState && uiState.talkOnRightClick),
        modifiers: o.modifiers || {},
        activeCursor: uiState && uiState.activeActionCursor,
        playerControlMode: player.controlMode,
        playerAlive: !!player.alive,
        hasInventory: !!player.inventory,
        hasGroundItems: !!(sim && sim.groundItems),
        playerTile: player.tile || null
    });

    const beforeLen = Array.isArray(player.commandQueue)
        ? player.commandQueue.length
        : 0;
    const remaining = applyCommandIntents(player, intents, {
        clearActionCursor: clearTargetCursorMode
    });
    if (typeof o.onAdapterIntent === 'function') {
        const ctx = {
            player,
            sim,
            clientX: o.clientX,
            clientY: o.clientY
        };
        for (let i = 0; i < remaining.length; i++) {
            o.onAdapterIntent(remaining[i], ctx);
        }
    }
    const afterLen = Array.isArray(player.commandQueue)
        ? player.commandQueue.length
        : 0;
    return afterLen > beforeLen || remaining.length > 0;
}

/**
 * Bind left-click manual control on the hunt canvas.
 *
 * @param {HTMLCanvasElement|null|undefined} canvas
 * @param {object} opts
 * @param {() => boolean} opts.getSessionLive
 * @param {() => object|null|undefined} opts.getSim
 * @param {(sim: object) => object|null|undefined} opts.getActivePlayer
 */
function bindManualCanvasClick(canvas, opts) {
    if (!canvas || typeof canvas.addEventListener !== 'function') return;
    const o = opts || {};
    canvas.addEventListener('click', (ev) => {
        if (ev.button !== 0) return;
        // Stage 9: ground-item drag used pointerdown/up; swallow the follow-up click
        // so walk / smart LMB does not steal the gesture after a map drag.
        if (consumeSuppressNextCanvasClick()) return;
        if (typeof o.getSessionLive === 'function' && !o.getSessionLive()) return;
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        if (!sim || !sim.tileMap) return;
        const player =
            typeof o.getActivePlayer === 'function' ? o.getActivePlayer(sim) : null;
        if (!player || player.controlMode !== 'manual' || !player.alive) return;
        const tile = canvasEventToTile(canvas, sim, ev);
        if (!tile) return;
        handleManualCanvasTileAction({
            player,
            sim,
            x: tile.x,
            y: tile.y,
            z: tile.z,
            clientX: ev.clientX,
            clientY: ev.clientY,
            modifiers: {
                shift: !!ev.shiftKey,
                ctrl: !!(ev.ctrlKey || ev.metaKey),
                alt: !!ev.altKey
            },
            onAdapterIntent:
                typeof o.onAdapterIntent === 'function'
                    ? o.onAdapterIntent
                    : undefined
        });
    });
}

/**
 * Wire Active Control radios + Auto Chase checkbox once.
 *
 * @param {object} opts
 * @param {() => number} opts.getActiveViewSlot
 * @param {() => object[]} opts.getFormMembers
 * @param {() => boolean} opts.getSessionLive
 * @param {() => object|null|undefined} opts.getLivePlayer
 * @param {() => void} [opts.onAfterChange]
 * @param {() => void} [opts.schedulePrefsSave]
 */
function wireManualControlToggles(opts) {
    if (typeof document === 'undefined') return;
    const o = opts || {};

    const refreshSync = () => {
        const slot =
            typeof o.getActiveViewSlot === 'function' ? o.getActiveViewSlot() : 0;
        const formMembers =
            typeof o.getFormMembers === 'function' ? o.getFormMembers() : [];
        syncActiveControlToggle({
            sessionLive:
                typeof o.getSessionLive === 'function' ? !!o.getSessionLive() : false,
            livePlayer:
                typeof o.getLivePlayer === 'function' ? o.getLivePlayer() : null,
            formMember: formMembers[slot]
        });
    };

    const handleControlToggleChange = (ev) => {
        if (!ev.target || !ev.target.checked) return;
        const slot =
            typeof o.getActiveViewSlot === 'function' ? o.getActiveViewSlot() : 0;
        applyControlModeChange({
            newMode: ev.target.value,
            activeViewSlot: slot,
            formMembers:
                typeof o.getFormMembers === 'function' ? o.getFormMembers() : [],
            sessionLive:
                typeof o.getSessionLive === 'function' ? !!o.getSessionLive() : false,
            livePlayer:
                typeof o.getLivePlayer === 'function' ? o.getLivePlayer() : null,
            onSynced: refreshSync
        });
        if (typeof o.schedulePrefsSave === 'function') o.schedulePrefsSave();
        if (typeof o.onAfterChange === 'function') o.onAfterChange();
    };

    const controlAiEl = document.getElementById('controlModeAi');
    const controlManualEl = document.getElementById('controlModeManual');
    if (controlAiEl) controlAiEl.addEventListener('change', handleControlToggleChange);
    if (controlManualEl) {
        controlManualEl.addEventListener('change', handleControlToggleChange);
    }

    const autoChaseToggleEl = document.getElementById('autoChaseToggle');
    if (autoChaseToggleEl) {
        autoChaseToggleEl.addEventListener('change', (ev) => {
            const slot =
                typeof o.getActiveViewSlot === 'function' ? o.getActiveViewSlot() : 0;
            applyAutoChaseChange({
                enabled: !!(ev.target && ev.target.checked),
                activeViewSlot: slot,
                formMembers:
                    typeof o.getFormMembers === 'function' ? o.getFormMembers() : [],
                sessionLive:
                    typeof o.getSessionLive === 'function' ? !!o.getSessionLive() : false,
                livePlayer:
                    typeof o.getLivePlayer === 'function' ? o.getLivePlayer() : null
            });
            if (typeof o.schedulePrefsSave === 'function') o.schedulePrefsSave();
            if (typeof o.onAfterChange === 'function') o.onAfterChange();
        });
    }

    return { sync: refreshSync };
}

module.exports = {
    queueSetControlMode,
    transferManualControlOnSlotChange,
    readActiveControlState,
    syncActiveControlToggle,
    applyControlModeChange,
    applyAutoChaseChange,
    canvasEventToTile,
    findCreatureAtTile,
    handleManualCanvasTileAction,
    bindManualCanvasClick,
    wireManualControlToggles
};
