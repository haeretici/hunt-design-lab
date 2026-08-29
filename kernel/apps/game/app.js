/**
 * Hunt Simulator UI (Stage 7).
 * Party editor + hunt preset + play/pause/stop + live telemetry panel.
 * Game state lives in Simulator; DOM only reads summaries outside the logic loop.
 */

'use strict';

const { Settings, DEFAULT_GENRE } = require('../../settings.js');
const { Application } = require('../../engine.js');
const { Simulator } = require('../../providers/simulator/simulator.js');
const {
    initTargetCursorListeners,
    initManualKeyboardControls,
    initMouseButtonTracking,
    clearActiveMoveKeys,
    loadMouseControls
} = require('./ui_state.js');
const {
    transferManualControlOnSlotChange,
    syncActiveControlToggle: syncActiveControlToggleUi,
    applyControlModeChange,
    applyPersistedAutoChaseToMembers,
    bindManualCanvasClick,
    wireManualControlToggles
} = require('./manual_control.js');
const {
    getUiPreferences,
    createDebouncedPrefsSaver,
    getPreferredContentModeId,
    setPreferredContentModeId,
    resolvePreferredContentModeId
} = require('../../core/lib/ui_preferences.js');
const {
    appUrl,
    apiUrl: gameApiUrl,
    loadBrowserPresets,
    buildPresetInjectors,
    getHuntDef,
    getCatalogLists,
    listModesForBrowser,
    mapUrlForFloor,
    fetchHybridPackForFloors,
    getBrowserHuntIds,
    getActiveModeId,
    DEFAULT_MODE_ID
} = require('./presets_loader.js');
const { getActiveMode } = require('../../core/lib/modes.js');
const {
    MAX_PARTY_SLOTS,
    EDITOR_EQUIPMENT_SLOTS,
    defaultStrategyForClass,
    defaultProfileIdForClass,
    partyFormFromPartyId,
    normalizeMember,
    ensureSingleLeader,
    leaderFormSlot,
    resolveActiveViewSlot,
    enabledMemberIndexForSlot,
    buildSimulatorOpts,
    collectPrefsState,
    applyPrefsState
} = require('./party_form.js');
const { loadParty } = require('../../core/lib/presets.js');
const { DEFAULT_PARTY_ID } = require('../../core/lib/character/party_resolve.js');
const {
    bindLivePanelElements,
    startLivePanelPoll,
    bindPartyDetailsModal
} = require('./live_panel.js');
const { bindEquipmentPanel, getActivePlayerFromSim } = require('./equipment_panel.js');
const { bindInventoryPanel } = require('./inventory_panel.js');
const actionBarsModule = require('./action_bars.js');
const { initActionBars } = actionBarsModule;
const { createActionBarParentBridge } = require('../../../html/widgets/action_bar_config/parent_bridge.js');
const {
    bindCollapsiblePanels,
    bindRosterPanels,
    cycleCombatTarget
} = require('./combat_panel.js');
const { bindBugReportModal } = require('./bug_report.js');
const {
    isSessionTerminal
} = require('../../providers/simulator/hunt_opts.js');
const {
    loadPersistedDebugAI,
    loadPersistedCamera,
    loadPersistedProgression
} = require('../../../html/widgets/engine_tweakings/bind.js');
const {
    createEngineTweakingsParentBridge
} = require('../../../html/widgets/engine_tweakings/parent_bridge.js');
const {
    createSimBatchParentBridge
} = require('../../../html/widgets/sim_batch_builder/parent_bridge.js');
const {
    prefetchHuntSprites,
    prefetchSprite,
    defaultVariantForDisplay
} = require('../../core/lib/creature_sprites.js');
const {
    bindCanvasFullscreen,
    DEFAULT_CANVAS_W,
    DEFAULT_CANVAS_H
} = require('../../core/lib/canvas_fullscreen.js');

/** IndexedDB scope key for Hunt Simulator form defaults. */
const PREFS_KEY = 'huntSimulator';

/**
 * Browser-reachable URL for a floor path PNG.
 * @param {string|number} floorId
 * @param {string} [mapId] hunt `legacyMapId`
 * @returns {string}
 */
function mapUrlFromFloor(floorId, mapId) {
    return mapUrlForFloor(floorId, mapId);
}

// Re-export mapUrl for tests / external callers
const mapUrl = mapUrlFromFloor;

/**
 * @param {HTMLSelectElement|null} select
 * @param {{ id: string, label: string }[]} options
 * @param {string} [selected]
 * @param {boolean} [includeEmpty]
 */
function fillSelect(select, options, selected, includeEmpty) {
    if (!select) return;
    const parts = [];
    if (includeEmpty) {
        parts.push('<option value="">—</option>');
    }
    for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const sel = o.id === selected ? ' selected' : '';
        parts.push(
            `<option value="${escapeAttr(o.id)}"${sel}>${escapeHtml(
                o.label || o.id
            )}</option>`
        );
    }
    select.innerHTML = parts.join('');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

/**
 * Fill Active label / Set Active button for each party slot header.
 * Independent of Leader radio — only changes watch camera focus.
 * Disabled slots get no control (they are not in the session party).
 * @param {HTMLElement} root #partySlots
 * @param {number} activeSlot form slot index
 * @param {(slot: number) => void} onSetActive
 */
function syncActiveViewControls(root, activeSlot, onSetActive) {
    if (!root) return;
    const wraps = root.querySelectorAll('.party-slot-active-wrap');
    for (let i = 0; i < wraps.length; i++) {
        const wrap = wraps[i];
        const slot = parseInt(wrap.getAttribute('data-slot'), 10);
        if (!Number.isFinite(slot)) continue;
        const enabledEl = root.querySelector(`.pf-enabled[data-slot="${slot}"]`);
        const enabled = enabledEl ? enabledEl.checked : slot === 0;
        if (!enabled) {
            wrap.innerHTML = '';
            continue;
        }
        if (slot === activeSlot) {
            wrap.innerHTML =
                '<span class="party-slot-active-label" title="Camera follows this member">Active</span>';
        } else {
            wrap.innerHTML = `<button type="button" class="btn btn-xs btn-retro party-slot-set-active pf-set-active" data-slot="${slot}" title="Follow this member with the camera">Set Active</button>`;
        }
    }
    root.querySelectorAll('.pf-set-active').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            const slot = parseInt(btn.getAttribute('data-slot'), 10);
            if (!Number.isFinite(slot)) return;
            if (typeof onSetActive === 'function') onSetActive(slot);
        });
    });
}

/**
 * Build party editor DOM into #partySlots.
 * @param {object} catalog from getCatalogLists()
 * @param {object[]} members
 * @param {() => void} onChange
 * @param {{ activeSlot?: number, onSetActive?: (slot: number) => void }} [viewOpts]
 */
function renderPartyEditor(catalog, members, onChange, viewOpts) {
    const root = document.getElementById('partySlots');
    if (!root) return;

    const classOpts = catalog.classes || [];
    const stratOpts = catalog.strategies || [];
    const itemsBySlot = catalog.itemsBySlot || {};
    const activeSlot =
        viewOpts && viewOpts.activeSlot != null
            ? viewOpts.activeSlot
            : leaderFormSlot(members);
    const onSetActive =
        viewOpts && typeof viewOpts.onSetActive === 'function'
            ? viewOpts.onSetActive
            : null;

    const html = [];
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
        const m = members[i] || normalizeMember(null, i);
        html.push(`
<div class="party-slot" data-slot="${i}">
  <div class="party-slot-header">
    <label class="party-slot-enable">
      <input type="checkbox" class="pf-enabled" data-slot="${i}"${
          m.enabled ? ' checked' : ''
      }>
      <span>Slot ${i + 1}</span>
    </label>
    <div class="party-slot-header-right">
      <span class="party-slot-active-wrap" data-slot="${i}"></span>
      <label class="party-slot-leader">
        <input type="radio" name="partyLeader" class="pf-leader" data-slot="${i}"${
            m.isLeader ? ' checked' : ''
        }>
        Leader
      </label>
    </div>
  </div>
  <div class="party-slot-body">
    <div class="party-field-row">
      <div class="party-field">
        <label class="label-retro" for="pf-name-${i}">Name</label>
        <input type="text" class="form-control form-control-retro pf-name" id="pf-name-${i}" data-slot="${i}" value="${escapeAttr(
            m.name
        )}" maxlength="24">
      </div>
      <div class="party-field">
        <label class="label-retro" for="pf-level-${i}">Lv</label>
        <input type="number" class="form-control form-control-retro pf-level" id="pf-level-${i}" data-slot="${i}" value="${
            m.level
        }" min="1" max="999" step="1">
      </div>
    </div>
    <div class="party-field-row">
      <div class="party-field">
        <label class="label-retro" for="pf-class-${i}">Class</label>
        <select class="form-select form-select-retro pf-class" id="pf-class-${i}" data-slot="${i}"></select>
      </div>
      <div class="party-field">
        <label class="label-retro" for="pf-strat-${i}">Strategy</label>
        <select class="form-select form-select-retro pf-strat" id="pf-strat-${i}" data-slot="${i}"></select>
      </div>
      <div class="party-field">
        <label class="label-retro" for="pf-control-${i}">Control</label>
        <select class="form-select form-select-retro pf-control" id="pf-control-${i}" data-slot="${i}">
          <option value="ai"${m.controlMode === 'manual' ? '' : ' selected'}>AI</option>
          <option value="manual"${m.controlMode === 'manual' ? ' selected' : ''}>Manual</option>
        </select>
      </div>
    </div>
    <details class="party-gear">
      <summary class="label-retro">Equipment</summary>
      <div class="party-gear-grid" data-slot="${i}">
        ${EDITOR_EQUIPMENT_SLOTS.map(
            (slot) => `
          <div class="party-field">
            <label class="label-retro" for="pf-eq-${i}-${slot}">${slot}</label>
            <select class="form-select form-select-retro pf-eq" id="pf-eq-${i}-${slot}" data-slot="${i}" data-eq-slot="${slot}"></select>
          </div>`
        ).join('')}
      </div>
    </details>
  </div>
</div>`);
    }
    root.innerHTML = html.join('');
    syncActiveViewControls(root, activeSlot, onSetActive);

    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
        const m = members[i] || normalizeMember(null, i);
        fillSelect(
            root.querySelector(`.pf-class[data-slot="${i}"]`),
            classOpts,
            m.classId
        );
        fillSelect(
            root.querySelector(`.pf-strat[data-slot="${i}"]`),
            stratOpts,
            m.strategyId
        );
        for (let s = 0; s < EDITOR_EQUIPMENT_SLOTS.length; s++) {
            const slot = EDITOR_EQUIPMENT_SLOTS[s];
            const items = (itemsBySlot[slot] || []).map((it) => ({
                id: it.id,
                label: it.label || it.id
            }));
            fillSelect(
                root.querySelector(
                    `.pf-eq[data-slot="${i}"][data-eq-slot="${slot}"]`
                ),
                items,
                m.equipment && m.equipment[slot] ? m.equipment[slot] : '',
                true
            );
        }
    }

    const notify = () => {
        if (typeof onChange === 'function') onChange();
    };

    root.querySelectorAll('input, select').forEach((el) => {
        el.addEventListener('change', (ev) => {
            const t = ev.target;
            if (t && t.classList && t.classList.contains('pf-class')) {
                const slot = parseInt(t.getAttribute('data-slot'), 10);
                const strat = root.querySelector(
                    `.pf-strat[data-slot="${slot}"]`
                );
                if (strat) {
                    const preferred = defaultStrategyForClass(t.value);
                    if (
                        Array.from(strat.options).some(
                            (o) => o.value === preferred
                        )
                    ) {
                        strat.value = preferred;
                    }
                }
            }
            if (t && t.classList && t.classList.contains('pf-leader')) {
                root.querySelectorAll('.pf-leader').forEach((r) => {
                    if (r !== t) r.checked = false;
                });
            }
            if (t && t.classList && t.classList.contains('pf-control')) {
                const slot = parseInt(t.getAttribute('data-slot'), 10);
                if (viewOpts && typeof viewOpts.onControlChange === 'function') {
                    viewOpts.onControlChange(slot, t.value);
                }
            }
            // Enable toggle: refresh Active / Set Active (disabled slots hide it)
            if (t && t.classList && t.classList.contains('pf-enabled')) {
                const enSlot = parseInt(t.getAttribute('data-slot'), 10);
                let nextActive = activeSlot;
                if (
                    Number.isFinite(enSlot) &&
                    enSlot === activeSlot &&
                    !t.checked
                ) {
                    // Active slot disabled → fall back to current leader radio
                    const leaderRadio = root.querySelector(
                        '.pf-leader:checked'
                    );
                    nextActive = leaderRadio
                        ? parseInt(leaderRadio.getAttribute('data-slot'), 10) ||
                          0
                        : 0;
                    if (typeof onSetActive === 'function') {
                        onSetActive(nextActive);
                    }
                } else {
                    syncActiveViewControls(root, nextActive, onSetActive);
                }
            }
            notify();
        });
        el.addEventListener('input', notify);
    });
}

/**
 * Read party form DOM into members array.
 * @param {object[]} [prevMembers] prior form rows (keeps profileId/skills)
 * @returns {object[]}
 */
function readPartyForm(prevMembers) {
    const root = document.getElementById('partySlots');
    const prevList = Array.isArray(prevMembers) ? prevMembers : [];
    const members = [];
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
        if (!root) {
            members.push(normalizeMember(null, i));
            continue;
        }
        const enabledEl = root.querySelector(`.pf-enabled[data-slot="${i}"]`);
        const nameEl = root.querySelector(`.pf-name[data-slot="${i}"]`);
        const levelEl = root.querySelector(`.pf-level[data-slot="${i}"]`);
        const classEl = root.querySelector(`.pf-class[data-slot="${i}"]`);
        const stratEl = root.querySelector(`.pf-strat[data-slot="${i}"]`);
        const controlEl = root.querySelector(`.pf-control[data-slot="${i}"]`);
        const leaderEl = root.querySelector(`.pf-leader[data-slot="${i}"]`);
        const equipment = Object.create(null);
        for (let s = 0; s < EDITOR_EQUIPMENT_SLOTS.length; s++) {
            const slot = EDITOR_EQUIPMENT_SLOTS[s];
            const eq = root.querySelector(
                `.pf-eq[data-slot="${i}"][data-eq-slot="${slot}"]`
            );
            if (eq && eq.value) equipment[slot] = eq.value;
        }
        const classId = classEl ? classEl.value : 'guardian';
        // DOM has no profile/skills fields. Same vocation → keep in-memory
        // character bag. Class change → rebind default starter (create-char).
        const prev = prevList[i] || null;
        /** @type {Record<string, any>} */
        const bag = {
            enabled: enabledEl ? enabledEl.checked : i === 0,
            name: nameEl ? nameEl.value : '',
            level: levelEl ? levelEl.value : 50,
            classId,
            strategyId: stratEl ? stratEl.value : 'balanced',
            controlMode: controlEl ? controlEl.value : (prev && prev.controlMode ? prev.controlMode : 'ai'),
            autoChase: prev && prev.autoChase != null ? !!prev.autoChase : undefined,
            isLeader: leaderEl ? leaderEl.checked : i === 0,
            equipment
        };
        if (prev && prev.classId === classId) {
            if (prev.profileId) bag.profileId = prev.profileId;
            if (prev.skills && typeof prev.skills === 'object') {
                bag.skills = prev.skills;
            }
            if (prev.critChance != null) bag.critChance = prev.critChance;
            if (prev.critDamage != null) bag.critDamage = prev.critDamage;
            if (prev.lifeLeech != null) bag.lifeLeech = prev.lifeLeech;
            if (prev.manaLeech != null) bag.manaLeech = prev.manaLeech;
            if (prev.lifeLeechChance != null) bag.lifeLeechChance = prev.lifeLeechChance;
            if (prev.manaLeechChance != null) bag.manaLeechChance = prev.manaLeechChance;
            if (prev.inventory != null) bag.inventory = prev.inventory;
            if (prev.backpack != null) bag.backpack = prev.backpack;
            if (prev.inventorySandbox === true) bag.inventorySandbox = true;
        } else {
            const starterId = defaultProfileIdForClass(classId);
            if (starterId) bag.profileId = starterId;
        }
        members.push(normalizeMember(bag, i));
    }
    ensureSingleLeader(members);
    return members;
}

/**
 * Set form controls enabled/disabled while a hunt is live.
 * @param {boolean} locked
 */
function setFormLocked(locked) {
    const ids = [
        'seedInput',
        'modeSelect',
        'huntSelect',
        'partySelect',
        'resetPartyBtn'
    ];
    for (let i = 0; i < ids.length; i++) {
        const el = document.getElementById(ids[i]);
        if (el) el.disabled = !!locked;
    }
    const root = document.getElementById('partySlots');
    if (root) {
        root.querySelectorAll('input, select').forEach((el) => {
            if (!el.classList.contains('pf-control')) {
                el.disabled = !!locked;
            }
        });
    }
}

async function initGameApp() {
    const canvas = document.getElementById('gameCanvas');
    const playBtn = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const speedSlider = document.getElementById('speedSlider');
    const speedVal = document.getElementById('speedVal');
    const seedInput = document.getElementById('seedInput');
    const huntSelect = document.getElementById('huntSelect');
    const partySelect = document.getElementById('partySelect');
    const resetPartyBtn = document.getElementById('resetPartyBtn');
    const statusBadge = document.getElementById('sessionStateBadge');
    const loadError = document.getElementById('gameLoadError');
    const playbackSlider = document.getElementById('playbackSlider');
    const playbackFrameVal = document.getElementById('playbackFrameVal');

    /** Last status string shown in the header badge (also pushed to Engine Tweakings). */
    let lastStatus = 'LOADING';

    const setStatus = (text) => {
        lastStatus = text != null ? String(text) : '';
        if (statusBadge) statusBadge.textContent = lastStatus;
    };

    /** Reset scrubber DOM when no live session. */
    const resetScrubberUI = () => {
        if (playbackSlider) {
            playbackSlider.min = '0';
            playbackSlider.max = '0';
            playbackSlider.value = '0';
            playbackSlider.disabled = true;
        }
        if (playbackFrameVal) playbackFrameVal.textContent = '0 / 0';
    };

    setStatus('LOADING');

    const modeSelect = document.getElementById('modeSelect');
    let catalog = null;
    let injectors = null;
    /** @type {object[]} */
    let formMembers = partyFormFromPartyId(DEFAULT_PARTY_ID).members;
    /** @type {string} */
    let formPartyId = DEFAULT_PARTY_ID;
    /**
     * Form slot whose view the watch camera follows (independent of Leader).
     * Defaults to the leader slot; "Set Active" updates this mid-session.
     * @type {number}
     */
    let activeViewSlot = leaderFormSlot(formMembers);
    let stopPanelPoll = null;
    let sessionLive = false;
    /** @type {{ refresh: () => void, dispose: () => void }|null} */
    let equipmentPanelCtl = null;
    /** @type {{ refresh: () => void, dispose: () => void }|null} */
    let inventoryPanelCtl = null;
    /** @type {{ refresh: () => void, dispose: () => void }|null} */
    let rosterPanelsCtl = null;
    /** @type {{ dispose: () => void }|null} */
    let collapsiblePanelsCtl = null;
    /** @type {{ refresh: () => void, dispose: () => void }|null} */
    let actionBarsCtl = null;

    /**
     * Apply camera focus for the current activeViewSlot on a live Simulator.
     * @param {object|null|undefined} sim
     * @param {object[]} [members]
     */
    const applyCameraFocusToSim = (sim, members) => {
        if (!sim || typeof sim.setCameraFocusMemberIndex !== 'function') return;
        const list = members || formMembers;
        const partyIdx = enabledMemberIndexForSlot(list, activeViewSlot);
        sim.setCameraFocusMemberIndex(
            partyIdx != null ? partyIdx : null
        );
        if (typeof sim._updateCamera === 'function') {
            sim._updateCamera();
        }
    };

    const syncActiveControlToggle = () => {
        const livePlayer =
            sessionLive && Application.currentLevel
                ? getActivePlayerFromSim(Application.currentLevel)
                : null;
        syncActiveControlToggleUi({
            sessionLive,
            livePlayer,
            formMember: formMembers[activeViewSlot],
            formMembers
        });
    };

    /**
     * Switch the Active view to a form slot (UI + live camera).
     * Does not change Leader.
     * @param {number} slot
     */
    const setActiveViewSlot = (slot) => {
        const s = Math.floor(Number(slot));
        if (!Number.isFinite(s) || s < 0 || s >= MAX_PARTY_SLOTS) return;
        if (s !== activeViewSlot && formMembers[activeViewSlot]) {
            const oldSlot = activeViewSlot;
            transferManualControlOnSlotChange({
                formMembers,
                oldSlot,
                newSlot: s,
                sessionLive,
                enabledMemberIndexForSlot,
                getLiveParty: () =>
                    Application.currentLevel &&
                    Application.currentLevel.parties &&
                    Application.currentLevel.parties[0]
                        ? Application.currentLevel.parties[0]
                        : null
            });
        }
        if (s === activeViewSlot) return;
        activeViewSlot = s;
        schedulePrefsSave();
        const root = document.getElementById('partySlots');
        syncActiveViewControls(root, activeViewSlot, setActiveViewSlot);
        if (sessionLive && Application.currentLevel) {
            applyCameraFocusToSim(Application.currentLevel, formMembers);
            // Paint immediately so the floor hop is visible while paused
            if (typeof Application.paintOnce === 'function') {
                Application.paintOnce();
            }
        }
        if (equipmentPanelCtl && typeof equipmentPanelCtl.refresh === 'function') {
            equipmentPanelCtl.refresh();
        }
        if (inventoryPanelCtl && typeof inventoryPanelCtl.refresh === 'function') {
            inventoryPanelCtl.refresh();
        }
        if (rosterPanelsCtl && typeof rosterPanelsCtl.refresh === 'function') {
            rosterPanelsCtl.refresh();
        }
        syncActiveControlToggle();
    };

    /**
     * @param {object[]} members
     */
    const paintPartyEditor = (members) => {
        renderPartyEditor(catalog, members, schedulePrefsSave, {
            activeSlot: activeViewSlot,
            onSetActive: setActiveViewSlot,
            onControlChange: (slot, newMode) => {
                let livePlayer = null;
                if (sessionLive && Application.currentLevel) {
                    const partyIdx = enabledMemberIndexForSlot(formMembers, slot);
                    if (
                        partyIdx != null &&
                        Application.currentLevel.parties &&
                        Application.currentLevel.parties[0]
                    ) {
                        livePlayer =
                            Application.currentLevel.parties[0].members[partyIdx] || null;
                    }
                }
                applyControlModeChange({
                    newMode,
                    activeViewSlot: slot,
                    formMembers,
                    sessionLive,
                    livePlayer,
                    onSynced: () => {
                        if (slot === activeViewSlot) syncActiveControlToggle();
                    }
                });
            }
        });
        if (equipmentPanelCtl && typeof equipmentPanelCtl.refresh === 'function') {
            equipmentPanelCtl.refresh();
        }
        if (inventoryPanelCtl && typeof inventoryPanelCtl.refresh === 'function') {
            inventoryPanelCtl.refresh();
        }
        if (rosterPanelsCtl && typeof rosterPanelsCtl.refresh === 'function') {
            rosterPanelsCtl.refresh();
        }
        syncActiveControlToggle();
    };

    /** @type {string} */
    let activeModeId =
        (typeof window !== 'undefined' && window.__CONTENT_MODE__) ||
        DEFAULT_MODE_ID;

    /**
     * Load presets for a content mode and refresh hunt dropdown.
     * @param {string} modeId
     * @param {string} [preferredHuntId]
     */
    async function applyContentMode(modeId, preferredHuntId) {
        await loadBrowserPresets(modeId);
        activeModeId = getActiveModeId();
        setPreferredContentModeId(activeModeId);
        injectors = buildPresetInjectors();
        catalog = getCatalogLists();
        const mode = getActiveMode();
        const defaultHunt =
            preferredHuntId ||
            (mode.defaults && mode.defaults.huntId) ||
            (catalog.hunts[0] && catalog.hunts[0].id) ||
            'cave_crawl_generated';
        if (huntSelect) {
            const huntIds = catalog.hunts.length
                ? catalog.hunts
                : getBrowserHuntIds().map((id) => ({ id, label: id }));
            const selected =
                huntIds.some((h) => h.id === defaultHunt)
                    ? defaultHunt
                    : huntIds[0]
                      ? huntIds[0].id
                      : defaultHunt;
            fillSelect(huntSelect, huntIds, selected);
        }
        if (partySelect) {
            const partyIds =
                catalog.parties && catalog.parties.length
                    ? catalog.parties
                    : [{ id: DEFAULT_PARTY_ID, label: DEFAULT_PARTY_ID }];
            const defaultParty =
                (mode.defaults && mode.defaults.partyId) ||
                DEFAULT_PARTY_ID;
            const selectedParty = partyIds.some((p) => p.id === defaultParty)
                ? defaultParty
                : partyIds[0]
                  ? partyIds[0].id
                  : DEFAULT_PARTY_ID;
            fillSelect(partySelect, partyIds, selectedParty);
            formPartyId = selectedParty;
        }
        return catalog;
    }

    // IndexedDB prefs first so mode + hunt survive reload
    /** @type {Record<string, unknown>|null} */
    let storedPrefs = null;
    try {
        storedPrefs = await getUiPreferences(PREFS_KEY);
    } catch (err) {
        console.warn('Hunt Simulator prefs load failed', err);
        storedPrefs = null;
    }

    // Shared content-mode preference (all shells) wins over hunt-only IndexedDB.
    // Migrate older huntSimulator.modeId → localStorage when shared key is empty.
    const pageModeFallback =
        (storedPrefs &&
            typeof storedPrefs.modeId === 'string' &&
            storedPrefs.modeId.trim()) ||
        activeModeId;
    if (!getPreferredContentModeId(null) && pageModeFallback) {
        setPreferredContentModeId(pageModeFallback);
    }
    const preferredHuntId =
        storedPrefs &&
        typeof storedPrefs.huntId === 'string' &&
        storedPrefs.huntId.trim()
            ? storedPrefs.huntId.trim()
            : null;

    try {
        const modes = await listModesForBrowser();
        const modeIds = modes.map((m) => m.id);
        const modeToLoad = resolvePreferredContentModeId({
            fallback: pageModeFallback,
            availableIds: modeIds,
            defaultId: DEFAULT_MODE_ID
        });
        if (modeSelect) {
            fillSelect(
                modeSelect,
                modes.map((m) => ({ id: m.id, label: m.label })),
                modeToLoad
            );
        }
        await applyContentMode(modeToLoad, preferredHuntId || undefined);
    } catch (err) {
        console.error('Failed to load hunt presets:', err);
        setStatus('ERROR');
        if (loadError) {
            const detail =
                err && err.message ? String(err.message) : String(err);
            loadError.textContent =
                `Could not load presets over HTTP (${detail}). ` +
                'Serve the project root (npm run dev) so /presets/<mode>/ resolves.';
            loadError.hidden = false;
        }
        return { error: err };
    }

    Settings.TIME_SPEED = Settings.DEFAULT_PLAY_SPEED;
    if (speedSlider) {
        speedSlider.value = String(Settings.DEFAULT_PLAY_SPEED);
    }
    if (speedVal) {
        speedVal.textContent = Settings.DEFAULT_PLAY_SPEED.toFixed(2);
    }

    // Late-bound session API for Engine Tweakings transport (play/pause/stop/seek)
    /** @type {{ getState: () => object, play: () => void, pause: () => void, stop: () => void, seek: (tick: number) => void }} */
    const tweaksSessionApi = {
        getState: () => ({
            live: false,
            paused: false,
            seeking: false,
            status: lastStatus || 'READY',
            playback: { current: 0, max: 0 }
        }),
        play: () => {},
        pause: () => {},
        stop: () => {},
        seek: () => {}
    };

    // Stage 12B: restore AI debug flags + camera zoom + Engine Tweakings popup
    loadPersistedDebugAI(Settings);
    loadPersistedCamera(Settings);
    loadPersistedProgression(Settings);
    // docs/29 Stage 3: mouse control mode + loot stub prefs
    loadMouseControls();
    const engineTweaksBridge = createEngineTweakingsParentBridge({
        Settings,
        Application,
        session: tweaksSessionApi,
        actionBars: actionBarsModule
    });
    const openEngineTweakingsBtn = document.getElementById(
        'openEngineTweakingsBtn'
    );
    const popupHint = document.getElementById('engineTweakingsPopupHint');
    if (openEngineTweakingsBtn) {
        openEngineTweakingsBtn.addEventListener('click', () => {
            const win = engineTweaksBridge.open();
            if (!win && popupHint) {
                popupHint.hidden = false;
                popupHint.textContent =
                    'Popup blocked — allow popups for this site, then try again.';
            } else if (popupHint) {
                popupHint.hidden = true;
            }
        });
    }

    // Stage 12I: Hunt Sim Batch Builder popup (prefill seed / hunt / party)
    const simBatchBridge = createSimBatchParentBridge({
        getState: () => {
            const seedEl = document.getElementById('seedInput');
            const huntEl = document.getElementById('huntSelect');
            let seed = 42;
            if (seedEl) {
                const n = parseInt(seedEl.value, 10);
                if (Number.isFinite(n) && n >= 1) seed = n;
            }
            return {
                seed,
                huntId: huntEl && huntEl.value ? huntEl.value : 'cave_crawl_generated',
                members: readPartyForm(formMembers)
            };
        }
    });
    const openSimBatchBtn = document.getElementById('openSimBatchBtn');
    const simBatchHint = document.getElementById('simBatchPopupHint');
    if (openSimBatchBtn) {
        openSimBatchBtn.addEventListener('click', () => {
            const win = simBatchBridge.open();
            if (!win && simBatchHint) {
                simBatchHint.hidden = false;
                simBatchHint.textContent =
                    'Popup blocked — allow popups for this site, then try again.';
            } else if (simBatchHint) {
                simBatchHint.hidden = true;
            }
        });
    }

    const collectPrefs = () =>
        collectPrefsState({
            seed: seedInput ? seedInput.value : '42',
            speed: Settings.TIME_SPEED,
            modeId:
                (modeSelect && modeSelect.value) ||
                activeModeId ||
                DEFAULT_MODE_ID,
            huntId: huntSelect ? huntSelect.value : 'cave_crawl_generated',
            partyId:
                (partySelect && partySelect.value) ||
                formPartyId ||
                DEFAULT_PARTY_ID,
            members: readPartyForm(formMembers),
            activeViewSlot
        });

    const schedulePrefsSave = createDebouncedPrefsSaver(PREFS_KEY, collectPrefs);

    /**
     * Reload form members from the selected party preset.
     * @param {string} [partyId]
     */
    const applyPartyDefaults = (partyId) => {
        const id =
            partyId ||
            (partySelect && partySelect.value) ||
            formPartyId ||
            DEFAULT_PARTY_ID;
        formPartyId = id;
        if (partySelect && partySelect.value !== id) {
            const opt = Array.from(partySelect.options || []).some(
                (o) => o.value === id
            );
            if (opt) partySelect.value = id;
        }
        const form = partyFormFromPartyId(id, { loadParty });
        formMembers = form.members;
        formPartyId = form.partyId || id;
        activeViewSlot = leaderFormSlot(formMembers);
        paintPartyEditor(formMembers);
    };

    // Apply seed / speed / party from prefs (mode + hunt already restored above)
    try {
        const defaultPartyId =
            (partySelect && partySelect.value) ||
            (getActiveMode().defaults && getActiveMode().defaults.partyId) ||
            DEFAULT_PARTY_ID;
        let defaultMembers = partyFormFromPartyId(defaultPartyId, {
            loadParty
        }).members;
        const defaults = collectPrefsState({
            seed: '42',
            speed: Settings.DEFAULT_PLAY_SPEED,
            modeId: activeModeId || DEFAULT_MODE_ID,
            huntId:
                (huntSelect && huntSelect.value) || 'cave_crawl_generated',
            partyId: defaultPartyId,
            members: defaultMembers,
            activeViewSlot: leaderFormSlot(defaultMembers)
        });
        const applied = applyPrefsState(storedPrefs, defaults);
        if (seedInput) seedInput.value = applied.seed;
        if (speedSlider) speedSlider.value = String(applied.speed);
        Settings.TIME_SPEED = applied.speed;
        if (speedVal) speedVal.textContent = applied.speed.toFixed(2);
        // Hunt select already set by applyContentMode; re-assert if option still present
        if (huntSelect && applied.huntId) {
            const opt = Array.from(huntSelect.options).some(
                (o) => o.value === applied.huntId
            );
            if (opt) huntSelect.value = applied.huntId;
        }
        if (partySelect && applied.partyId) {
            const opt = Array.from(partySelect.options).some(
                (o) => o.value === applied.partyId
            );
            if (opt) {
                partySelect.value = applied.partyId;
                formPartyId = applied.partyId;
            }
        }
        // Prefer restored members when they match prefs; otherwise reload party
        if (
            storedPrefs &&
            Array.isArray(storedPrefs.members) &&
            storedPrefs.members.length
        ) {
            formMembers = applied.members;
            formPartyId = applied.partyId || formPartyId;
            activeViewSlot = resolveActiveViewSlot(
                formMembers,
                applied.activeViewSlot
            );
            paintPartyEditor(formMembers);
        } else {
            applyPartyDefaults(applied.partyId || defaultPartyId);
            // Party preset reset wipes Active; still restore stored Active if valid.
            if (storedPrefs && storedPrefs.activeViewSlot != null) {
                activeViewSlot = resolveActiveViewSlot(
                    formMembers,
                    storedPrefs.activeViewSlot
                );
                paintPartyEditor(formMembers);
            }
        }
    } catch (err) {
        console.warn('Hunt Simulator prefs apply failed', err);
        applyPartyDefaults(
            (partySelect && partySelect.value) || DEFAULT_PARTY_ID
        );
    }

    if (speedSlider) {
        speedSlider.addEventListener('input', () => {
            const val = parseFloat(speedSlider.value);
            Settings.TIME_SPEED = Number.isFinite(val) ? val : 1;
            if (speedVal) {
                speedVal.textContent = Settings.TIME_SPEED.toFixed(2);
            }
            schedulePrefsSave();
            if (
                engineTweaksBridge &&
                typeof engineTweaksBridge.sendState === 'function'
            ) {
                engineTweaksBridge.sendState();
            }
        });
    }

    if (seedInput) {
        seedInput.addEventListener('change', schedulePrefsSave);
        seedInput.addEventListener('input', schedulePrefsSave);
    }

    if (huntSelect) {
        huntSelect.addEventListener('change', () => {
            if (sessionLive) return;
            schedulePrefsSave();
        });
    }

    if (partySelect) {
        partySelect.addEventListener('change', () => {
            if (sessionLive) return;
            applyPartyDefaults(partySelect.value);
            schedulePrefsSave();
        });
    }

    if (modeSelect) {
        modeSelect.addEventListener('change', async () => {
            if (sessionLive) return;
            const next = modeSelect.value || DEFAULT_MODE_ID;
            setPreferredContentModeId(next);
            setStatus('LOADING');
            try {
                await applyContentMode(next);
                applyPartyDefaults(
                    (partySelect && partySelect.value) || DEFAULT_PARTY_ID
                );
                schedulePrefsSave();
                setStatus('READY');
            } catch (err) {
                console.error('Mode switch failed:', err);
                setStatus('ERROR');
                if (loadError) {
                    loadError.textContent = `Failed to load mode "${next}".`;
                    loadError.hidden = false;
                }
            }
        });
    }

    if (resetPartyBtn) {
        resetPartyBtn.addEventListener('click', () => {
            if (sessionLive) return;
            applyPartyDefaults(
                (partySelect && partySelect.value) || formPartyId
            );
            schedulePrefsSave();
        });
    }

    const liveEls = bindLivePanelElements(document);
    /**
     * Opt-in only: auto-pause on each stair hop for multi-floor isolation.
     * Product play leaves this false. `window.__HUNT_TEST__.setHopAutoPause(true)`
     * or configure({ hopAutoPause: true }) for manual triage (docs/25).
     * @type {boolean}
     */
    let hopAutoPause = false;
    /**
     * Opt-in split-floor combat/RNG log (`Simulator.parityTrace`). Product Play
     * leaves this unset. `bin/browser_parity.js` arms via
     * `configure({ parityTrace: true })` so live parityTickLog matches headless.
     * @type {boolean|object|undefined}
     */
    let testParityTrace = undefined;
    /**
     * When hopAutoPause is on: pause live sim on stair hop so tick/z can be
     * inspected without scrubbing.
     * @param {object[]} hops
     * @param {object} snap
     */
    const onLiveFloorHop = (hops, snap) => {
        if (!hopAutoPause) return;
        if (!sessionLive || !Application.currentLevel) return;
        if (Application.currentLevel._seekInProgress) return;
        if (isSessionTerminal(Application.currentLevel.sessionState)) return;
        if (Application.paused) return;
        Application.paused = true;
        if (pauseBtn) {
            pauseBtn.innerHTML =
                '<i class="fa-solid fa-play"></i> Resume';
        }
        const last = hops && hops.length ? hops[hops.length - 1] : null;
        const hopHint = last
            ? `FLOOR HOP t${last.tick} ${last.name} z${last.fromZ}→${last.toZ}`
            : 'FLOOR HOP';
        setStatus(`PAUSED · ${hopHint}`);
        if (
            engineTweaksBridge &&
            typeof engineTweaksBridge.sendState === 'function'
        ) {
            engineTweaksBridge.sendState();
        }
        void snap;
    };
    stopPanelPoll = startLivePanelPoll({
        getSim: () => Application.currentLevel,
        isPaused: () => !!Application.paused,
        els: liveEls,
        // 250ms is enough for telemetry; 100ms burned idle CPU on the hunt page
        intervalMs: 250,
        onFloorHop: onLiveFloorHop
    });
    equipmentPanelCtl = bindEquipmentPanel({
        getSim: () => Application.currentLevel,
        getIdleMember: () => {
            const m = formMembers[activeViewSlot];
            return m && m.enabled !== false ? m : formMembers.find((x) => x && x.enabled !== false) || null;
        },
        getItemDb: () => (injectors && injectors.itemDb) || null,
        getModeId: () => activeModeId || getActiveModeId() || DEFAULT_MODE_ID,
        getGenre: () => {
            try {
                const mode = getActiveMode();
                return (mode && mode.genre) || DEFAULT_GENRE;
            } catch (_) {
                return DEFAULT_GENRE;
            }
        },
        isSessionLive: () => !!sessionLive
    });
    inventoryPanelCtl = bindInventoryPanel({
        getSim: () => Application.currentLevel,
        getItemDb: () => (injectors && injectors.itemDb) || null,
        getGenre: () => {
            try {
                const mode = getActiveMode();
                return (mode && mode.genre) || DEFAULT_GENRE;
            } catch (_) {
                return DEFAULT_GENRE;
            }
        },
        isSessionLive: () => !!sessionLive,
        onMutation: () => {
            if (equipmentPanelCtl && typeof equipmentPanelCtl.refresh === 'function') {
                equipmentPanelCtl.refresh();
            }
        },
        onMutationPaint: () => {
            if (typeof Application.paintOnce === 'function') {
                Application.paintOnce();
            }
        }
    });
    collapsiblePanelsCtl = bindCollapsiblePanels();
    rosterPanelsCtl = bindRosterPanels({
        getSim: () => Application.currentLevel,
        getIdleMembers: () => formMembers.filter((x) => x && x.enabled !== false),
        getIdleMember: () => {
            const m = formMembers[activeViewSlot];
            if (m && m.enabled !== false) return m;
            return formMembers.find((x) => x && x.enabled !== false) || null;
        },
        isSessionLive: () => !!sessionLive,
        getGenre: () => {
            try {
                const mode = getActiveMode();
                return (mode && mode.genre) || DEFAULT_GENRE;
            } catch (_) {
                return DEFAULT_GENRE;
            }
        }
    });
    actionBarsCtl = initActionBars({
        getActivePlayer: () => {
            const sim = Application.currentLevel;
            const m = getActivePlayerFromSim(sim) || formMembers[activeViewSlot];
            return m && m.enabled !== false ? m : formMembers.find((x) => x && x.enabled !== false) || null;
        },
        getItemDb: () => (injectors && injectors.itemDb) || null,
        getSpellBook: () => (injectors && injectors.spellBook) || (Application.currentLevel && (Application.currentLevel.spellBook || Application.currentLevel._spellBook)) || null,
        getGenre: () => {
            try {
                const mode = getActiveMode();
                return (mode && mode.genre) || DEFAULT_GENRE;
            } catch (_) {
                return DEFAULT_GENRE;
            }
        },
        getIsSessionLive: () => !!sessionLive,
        getSimulator: () => Application.currentLevel || null
    });
    const openActionBarConfigBtn = document.getElementById('openActionBarConfigBtn');
    const actionBarHint = document.getElementById('actionBarConfigPopupHint');
    const actionBarBridge = createActionBarParentBridge({
        actionBars: actionBarsModule,
        getActivePlayer: () => {
            const sim = Application.currentLevel;
            const m = getActivePlayerFromSim(sim) || formMembers[activeViewSlot];
            return m && m.enabled !== false ? m : formMembers.find((x) => x && x.enabled !== false) || null;
        },
        getItemDb: () => (injectors && injectors.itemDb) || null,
        getSpellBook: () => (injectors && injectors.spellBook) || (Application.currentLevel && (Application.currentLevel.spellBook || Application.currentLevel._spellBook)) || null,
        getGenre: () => {
            try {
                const mode = getActiveMode();
                return (mode && mode.genre) || DEFAULT_GENRE;
            } catch (_) {
                return DEFAULT_GENRE;
            }
        }
    });
    if (openActionBarConfigBtn) {
        openActionBarConfigBtn.addEventListener('click', () => {
            const win = actionBarBridge.open();
            if (!win && actionBarHint) {
                actionBarHint.hidden = false;
                actionBarHint.textContent = 'Popup blocked — allow popups for this site, then try again.';
            } else if (actionBarHint) {
                actionBarHint.hidden = true;
            }
        });
    }
    bindPartyDetailsModal({
        getSim: () => Application.currentLevel,
        els: liveEls
    });
    bindBugReportModal({
        getApiUrl: () => gameApiUrl(),
        getContext: () => {
            let seed = 1;
            if (seedInput && seedInput.value.trim() !== '') {
                const parsed = parseInt(seedInput.value.trim(), 10);
                if (Number.isFinite(parsed)) seed = parsed >>> 0 || 1;
            }
            return {
                source: 'hunt',
                modeId:
                    (modeSelect && modeSelect.value) ||
                    activeModeId ||
                    DEFAULT_MODE_ID,
                seed,
                huntId: huntSelect ? huntSelect.value : null,
                partyId:
                    (partySelect && partySelect.value) ||
                    formPartyId ||
                    DEFAULT_PARTY_ID,
                members: readPartyForm(formMembers),
                sim: Application.currentLevel,
                timeSpeed: Settings.TIME_SPEED
            };
        }
    });

    const stopSession = () => {
        Application.quit();
        Settings.cameraTileX = null;
        Settings.cameraTileY = null;
        Settings.cameraTileZ = null;
        sessionLive = false;
        clearActiveMoveKeys();
        syncActiveControlToggle();
        setFormLocked(false);
        Application.paused = false;
        if (pauseBtn) {
            pauseBtn.disabled = true;
            pauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
        }
        if (playBtn) playBtn.disabled = false;
        if (speedSlider) speedSlider.disabled = false;
        resetScrubberUI();
        setStatus('STOPPED');
        if (engineTweaksBridge && typeof engineTweaksBridge.sendState === 'function') {
            engineTweaksBridge.sendState();
        }
        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = Settings.screenColor;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#8b9bb4';
                ctx.font = '14px monospace';
                ctx.fillText('Press Play — hunt watch mode', 24, 40);
                ctx.fillText(
                    '(catalog sprites when present; else cyan/orange/red markers)',
                    24,
                    62
                );
            }
        }
    };

    const startSession = async () => {
        if (Application.currentLevel) {
            Application.quit();
        }

        let seed = 1;
        if (seedInput && seedInput.value.trim() !== '') {
            const parsed = parseInt(seedInput.value.trim(), 10);
            if (Number.isFinite(parsed)) seed = parsed >>> 0 || 1;
        } else {
            seed = (Math.floor(Math.random() * 999999) + 1) >>> 0;
            if (seedInput) seedInput.value = String(seed);
        }

        const huntId = huntSelect ? huntSelect.value : 'cave_crawl_generated';
        let hunt;
        try {
            // Re-expand under the session seed so layout/spawns match headless
            // (browser pack pre-expands at seed 1 for catalog only).
            hunt = getHuntDef(huntId, { seed });
        } catch (err) {
            console.error(err);
            setStatus('ERROR');
            throw err;
        }

        const members = readPartyForm(formMembers);
        applyPersistedAutoChaseToMembers(members);
        formMembers = members;

        Settings.HEADLESS = false;
        // Tile size (camera zoom) comes from Engine Tweakings / localStorage —
        // loadPersistedCamera on init; do not reset here so live zoom sticks.
        Application.paused = false;
        setStatus('LOADING');

        const floor = hunt.floor != null ? hunt.floor : 7;
        // Generated layouts (11.4/11.5) carry floorFriction — do not load
        // continent path PNGs or spawn fails at generator waypoints.
        const hasGeneratedFloor = !!(
            (hunt.floorFriction && hunt.floorFriction.friction) ||
            hunt.floorLayers
        );
        const partyId =
            (partySelect && partySelect.value) ||
            formPartyId ||
            DEFAULT_PARTY_ID;
        formPartyId = partyId;
        // Prefer editor hybrid packs (map fields + channels) when present
        let hybridMapPack = null;
        const huntMapId =
            (hunt.legacyMapPack && hunt.legacyMapPack.id) || hunt.legacyMapId;
        if (!hasGeneratedFloor) {
            const floorList =
                Array.isArray(hunt.floors) && hunt.floors.length
                    ? hunt.floors
                    : [floor];
            try {
                hybridMapPack = await fetchHybridPackForFloors(
                    floorList,
                    huntMapId
                );
            } catch (err) {
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('hybrid map load failed', err);
                }
                hybridMapPack = null;
            }
        }
        const simOpts = buildSimulatorOpts({
            seed,
            hunt,
            huntId,
            partyId,
            members,
            mapPath: hasGeneratedFloor
                ? null
                : mapUrlFromFloor(floor, huntMapId),
            hybridMapPack,
            injectors,
            ...(testParityTrace !== undefined
                ? { parityTrace: testParityTrace }
                : {})
        });

        // Kick off catalog PNG loads before the first frame (non-blocking).
        // Missing assets fail quietly; markers stay until ImageDB is ready.
        try {
            const genre = hunt.genre || DEFAULT_GENRE;
            /** @type {Record<string, object>} */
            const templates = Object.create(null);
            const spawnList = Array.isArray(hunt.spawns) ? hunt.spawns : [];
            /** @type {string[]} */
            const creatureIds = [];
            for (let i = 0; i < spawnList.length; i++) {
                const sid = spawnList[i] && (spawnList[i].creatureId || spawnList[i].id);
                if (!sid || templates[sid] || !injectors.creatureLoader) continue;
                try {
                    const tpl = injectors.creatureLoader(sid);
                    if (tpl) templates[sid] = tpl;
                } catch (_) {
                    /* ignore */
                }
            }
            // Wave hunts: prefetch every creature that can appear in any pack.
            if (hunt.waves != null) {
                try {
                    const {
                        collectWaveCreatureIds
                    } = require('../../core/lib/wave_manager.js');
                    const waveIds = collectWaveCreatureIds(hunt.waves);
                    for (let wi = 0; wi < waveIds.length; wi++) {
                        const sid = waveIds[wi];
                        if (!sid) continue;
                        creatureIds.push(sid);
                        if (templates[sid] || !injectors.creatureLoader) continue;
                        try {
                            const tpl = injectors.creatureLoader(sid);
                            if (tpl) templates[sid] = tpl;
                        } catch (_) {
                            /* ignore */
                        }
                    }
                } catch (_) {
                    /* optional */
                }
            }
            prefetchHuntSprites({
                genre,
                spawns: spawnList,
                creatureIds,
                members,
                templates,
                classLoader: injectors.classLoader || null,
                itemDb: injectors.itemDb || null
            });
            // Stage 11.9: prefetch tile catalog cells used by art layers
            if (hunt.artLayers || hunt.floorArt) {
                const variant = defaultVariantForDisplay();
                const layers = hunt.artLayers
                    ? Object.keys(hunt.artLayers).map((k) => hunt.artLayers[k])
                    : [hunt.floorArt];
                for (let li = 0; li < layers.length; li++) {
                    const layer = layers[li];
                    if (!layer || !layer.palette) continue;
                    const g = layer.genre || genre || DEFAULT_GENRE;
                    const kind = layer.kind || 'tiles';
                    for (let p = 1; p < layer.palette.length; p++) {
                        const tid = layer.palette[p];
                        if (!tid) continue;
                        prefetchSprite({
                            genre: g,
                            kind,
                            id: tid,
                            variant
                        });
                    }
                }
            }
        } catch (_) {
            /* never block session start on art */
        }

        const sim = new Simulator(simOpts);
        // Camera starts on the Active member (leader by default until Set Active)
        applyCameraFocusToSim(sim, members);

        const w = canvas ? canvas.width || 720 : 720;
        const h = canvas ? canvas.height || 480 : 480;

        try {
            await Application.run('gameCanvas', sim, w, h);
            sessionLive = true;
            // Re-apply after start in case bootstrap recreated parties
            applyCameraFocusToSim(sim, members);
            syncActiveControlToggle();
            setFormLocked(true);
            if (pauseBtn) pauseBtn.disabled = false;
            setStatus('RUNNING');
            schedulePrefsSave();
            if (engineTweaksBridge && typeof engineTweaksBridge.sendState === 'function') {
                engineTweaksBridge.sendState();
            }
        } catch (err) {
            console.error('Failed to start session:', err);
            sessionLive = false;
            setFormLocked(false);
            setStatus('ERROR');
            if (engineTweaksBridge && typeof engineTweaksBridge.sendState === 'function') {
                engineTweaksBridge.sendState();
            }
            throw err;
        }
    };

    const togglePause = () => {
        if (!sessionLive || !Application.currentLevel) return;
        if (Application.currentLevel._seekInProgress) return;
        // Ended hunts are frozen; Pause/Resume only applies while still running.
        if (isSessionTerminal(Application.currentLevel.sessionState)) {
            setStatus(String(Application.currentLevel.sessionState).toUpperCase());
            return;
        }
        Application.paused = !Application.paused;
        if (pauseBtn) {
            pauseBtn.innerHTML = Application.paused
                ? '<i class="fa-solid fa-play"></i> Resume'
                : '<i class="fa-solid fa-pause"></i> Pause';
        }
        setStatus(Application.paused ? 'PAUSED' : 'RUNNING');
        if (engineTweaksBridge && typeof engineTweaksBridge.sendState === 'function') {
            engineTweaksBridge.sendState();
        }
    };

    // Stage 12E: playback scrubber — reseed from session seed to selected tick
    // Shared by sidebar scrubber + Engine Tweakings popup.
    let seekDebounceTimer = null;
    let pendingSeekTarget = null;

    const setSeekingUi = (seeking) => {
        if (pauseBtn) pauseBtn.disabled = seeking || !sessionLive;
        if (speedSlider) speedSlider.disabled = !!seeking;
        if (playbackSlider) playbackSlider.disabled = !!seeking;
        if (engineTweaksBridge && typeof engineTweaksBridge.sendState === 'function') {
            engineTweaksBridge.sendState();
        }
    };

    const runPlaybackSeek = async (sim, targetTicks) => {
        if (!sim || typeof sim.seekToTick !== 'function' || !sim.replayConfig) {
            return;
        }
        if (sim._seekInProgress) {
            pendingSeekTarget = targetTicks;
            return;
        }

        setSeekingUi(true);
        setStatus('SEEKING');
        try {
            await sim.seekToTick(targetTicks);
            if (typeof sim.updateScrubberUI === 'function') {
                sim.updateScrubberUI();
            }
            // Frozen sessions skip CanvasLoop paint — show sought frame once.
            if (typeof Application.paintOnce === 'function') {
                Application.paintOnce();
            }
        } catch (err) {
            console.error('Seek failed:', err);
            setStatus('ERROR');
        } finally {
            setSeekingUi(false);
            if (sessionLive) {
                // Stay paused after scrub so the frame is inspectable
                Application.paused = true;
                if (pauseBtn) {
                    pauseBtn.disabled = false;
                    pauseBtn.innerHTML =
                        '<i class="fa-solid fa-play"></i> Resume';
                }
                setStatus('PAUSED');
            }
            if (engineTweaksBridge && typeof engineTweaksBridge.sendState === 'function') {
                engineTweaksBridge.sendState();
            }
        }

        if (pendingSeekTarget !== null && pendingSeekTarget !== targetTicks) {
            const nextTarget = pendingSeekTarget;
            pendingSeekTarget = null;
            await runPlaybackSeek(sim, nextTarget);
        } else {
            pendingSeekTarget = null;
        }
    };

    const queuePlaybackSeek = (targetTicks, immediate) => {
        const sim = Application.currentLevel;
        if (
            !sessionLive ||
            !sim ||
            typeof sim.seekToTick !== 'function' ||
            !sim.replayConfig
        ) {
            return;
        }

        Application.paused = true;
        if (pauseBtn) {
            pauseBtn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
        }
        clearTimeout(seekDebounceTimer);

        if (immediate) {
            void runPlaybackSeek(sim, targetTicks);
            return;
        }

        seekDebounceTimer = setTimeout(() => {
            void runPlaybackSeek(sim, targetTicks);
        }, 200);
    };

    if (playbackSlider) {
        playbackSlider.addEventListener('input', (e) => {
            const t = parseInt(e.target.value, 10);
            if (playbackFrameVal && Application.currentLevel) {
                const max =
                    Application.currentLevel.playbackMaxElapsedTicks || 0;
                playbackFrameVal.textContent = `${t} / ${max}`;
            }
            queuePlaybackSeek(t, false);
        });

        playbackSlider.addEventListener('change', (e) => {
            queuePlaybackSeek(parseInt(e.target.value, 10), true);
        });
    }

    const handlePlayClick = () => {
        // Paused mid-hunt → resume. Ended or idle → start (or restart) from form.
        const sim = Application.currentLevel;
        if (
            sessionLive &&
            Application.paused &&
            sim &&
            !isSessionTerminal(sim.sessionState)
        ) {
            togglePause();
            return;
        }
        startSession().catch((err) => {
            console.error('Failed to start session:', err);
            setStatus('ERROR');
        });
    };

    if (playBtn) {
        playBtn.addEventListener('click', handlePlayClick);
    }
    if (pauseBtn) {
        pauseBtn.disabled = true;
        pauseBtn.addEventListener('click', togglePause);
    }
    if (stopBtn) {
        stopBtn.addEventListener('click', stopSession);
    }

    wireManualControlToggles({
        getActiveViewSlot: () => activeViewSlot,
        getFormMembers: () => formMembers,
        getSessionLive: () => sessionLive,
        getLivePlayer: () =>
            sessionLive && Application.currentLevel
                ? getActivePlayerFromSim(Application.currentLevel)
                : null,
        schedulePrefsSave
    });

    // Wire Engine Tweakings transport after session helpers exist
    tweaksSessionApi.getState = () => {
        const sim = Application.currentLevel;
        return {
            live: !!sessionLive,
            paused: !!(sessionLive && Application.paused),
            seeking: !!(sim && sim._seekInProgress),
            status: lastStatus || (sessionLive ? 'RUNNING' : 'READY'),
            playback: {
                current: sim ? Math.max(0, sim.playbackElapsedTicks | 0) : 0,
                max: sim ? Math.max(0, sim.playbackMaxElapsedTicks | 0) : 0
            }
        };
    };
    tweaksSessionApi.play = handlePlayClick;
    tweaksSessionApi.pause = togglePause;
    tweaksSessionApi.stop = stopSession;
    tweaksSessionApi.seek = (tick) => {
        queuePlaybackSeek(tick, true);
    };

    resetScrubberUI();

    // Full-screen: CSS-scale canvas to viewport (soccer-oss parity)
    const fullscreenCtl = bindCanvasFullscreen({
        container: document.getElementById('gameCanvasContainer')
            || document.querySelector('.canvas-container')
            || document.querySelector('.game-canvas-wrap'),
        canvas,
        toggleBtn: document.getElementById('fullscreenToggleBtn'),
        logicalW: canvas ? (canvas.width || DEFAULT_CANVAS_W) : DEFAULT_CANVAS_W,
        logicalH: canvas ? (canvas.height || DEFAULT_CANVAS_H) : DEFAULT_CANVAS_H
    });

    // Idle canvas splash
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.fillStyle = Settings.screenColor;
            ctx.fillRect(0, 0, canvas.width || 720, canvas.height || 480);
            ctx.fillStyle = '#8b9bb4';
            ctx.font = '14px monospace';
            ctx.fillText('Press Play — hunt watch mode', 24, 40);
            ctx.fillText(
                '(catalog sprites when present; else cyan/orange/red markers)',
                24,
                62
            );
        }

        bindManualCanvasClick(canvas, {
            getSessionLive: () => sessionLive,
            getSim: () => Application.currentLevel,
            getActivePlayer: (sim) => getActivePlayerFromSim(sim),
            onAdapterIntent: (intent, ctx) => {
                if (
                    inventoryPanelCtl &&
                    typeof inventoryPanelCtl.handleCanvasAdapterIntent ===
                        'function'
                ) {
                    inventoryPanelCtl.handleCanvasAdapterIntent(intent, ctx);
                }
            }
        });
    }

    // Manual control: keyboard continuous single-step movement & targeting
    if (typeof window !== 'undefined') {
        initTargetCursorListeners();
        initMouseButtonTracking();
        initManualKeyboardControls({
            getSessionLive: () => sessionLive,
            getSim: () => Application.currentLevel,
            getActivePlayer: (sim) => getActivePlayerFromSim(sim),
            cycleTarget: (sim, player, dir) => cycleCombatTarget(sim, player, dir)
        });
    }
    setStatus('READY');

    /**
     * Stable automation surface for browser parity (docs/25).
     * Used by `bin/browser_parity.js` via puppeteer — no art / scrape needed.
     */
    if (typeof window !== 'undefined') {
        window.__HUNT_TEST__ = {
            version: 1,
            ready: true,
            /** @param {boolean} v */
            setHopAutoPause(v) {
                hopAutoPause = !!v;
            },
            getHopAutoPause() {
                return hopAutoPause;
            },
            /**
             * @param {number} speed
             */
            setSpeed(speed) {
                const s = Math.max(0.25, Math.min(20, Number(speed) || 1));
                Settings.TIME_SPEED = s;
                if (speedSlider) speedSlider.value = String(s);
                if (speedVal) speedVal.textContent = s.toFixed(2);
            },
            /**
             * Configure form before play (stops a live session first).
             * @param {{
             *   modeId?: string,
             *   huntId?: string,
             *   partyId?: string,
             *   seed?: number,
             *   speed?: number,
             *   hopAutoPause?: boolean,
             *   parityTrace?: boolean|object
             * }} [opts]
             */
            async configure(opts) {
                const o = opts || {};
                if (sessionLive) {
                    stopSession();
                }
                if (o.modeId && modeSelect) {
                    const next = String(o.modeId);
                    if (modeSelect.value !== next) {
                        modeSelect.value = next;
                        setPreferredContentModeId(next);
                        await applyContentMode(next, o.huntId);
                    }
                }
                if (o.huntId && huntSelect) {
                    huntSelect.value = String(o.huntId);
                }
                if (o.partyId && partySelect) {
                    partySelect.value = String(o.partyId);
                    applyPartyDefaults(String(o.partyId));
                }
                if (o.seed != null && seedInput) {
                    const seed = Math.floor(Number(o.seed)) >>> 0 || 1;
                    seedInput.value = String(seed);
                }
                if (o.speed != null) {
                    window.__HUNT_TEST__.setSpeed(o.speed);
                }
                if (o.hopAutoPause != null) {
                    hopAutoPause = !!o.hopAutoPause;
                }
                if (o.parityTrace !== undefined) {
                    // true → auto hop window; false → off; {fromTick,toTick} → fixed
                    testParityTrace = o.parityTrace;
                }
                schedulePrefsSave();
                return window.__HUNT_TEST__.snapshot();
            },
            async play() {
                await startSession();
                return window.__HUNT_TEST__.snapshot();
            },
            resume() {
                if (!sessionLive || !Application.currentLevel) return;
                if (Application.paused) {
                    Application.paused = false;
                    if (pauseBtn) {
                        pauseBtn.innerHTML =
                            '<i class="fa-solid fa-pause"></i> Pause';
                    }
                    setStatus('RUNNING');
                }
            },
            pause() {
                if (!sessionLive || !Application.currentLevel) return;
                if (!Application.paused) {
                    Application.paused = true;
                    if (pauseBtn) {
                        pauseBtn.innerHTML =
                            '<i class="fa-solid fa-play"></i> Resume';
                    }
                    setStatus('PAUSED');
                }
            },
            stop() {
                stopSession();
            },
            /**
             * Logic-only snapshot for parity diffs (no canvas pixels).
             * @returns {object}
             */
            snapshot() {
                const sim = Application.currentLevel;
                if (!sim || !sessionLive) {
                    return {
                        live: false,
                        ready: true,
                        status: lastStatus,
                        hopAutoPause
                    };
                }
                const t = sim.telemetry || {};
                /** @type {object[]} */
                let party = [];
                if (typeof sim.getPartyPositions === 'function') {
                    const parties = sim.getPartyPositions();
                    if (parties[0] && Array.isArray(parties[0].members)) {
                        party = parties[0].members.map((m) => ({
                            name: m.name,
                            x: m.x,
                            y: m.y,
                            z: m.z,
                            hp: m.hp,
                            hpMax: m.hpMax,
                            alive: m.alive,
                            aiState: m.aiState || '',
                            damageDealt: m.damageDealt || 0,
                            kills: m.kills || 0
                        }));
                    }
                }
                return {
                    live: true,
                    ready: true,
                    status: lastStatus,
                    hopAutoPause,
                    timeSpeed: Settings.TIME_SPEED,
                    tick: sim.tickCount | 0,
                    sessionState: sim.sessionState || 'idle',
                    kills: t.kills || 0,
                    deaths: t.deaths || 0,
                    expGained: t.expGained || 0,
                    damageDealt: t.damageDealt || 0,
                    damageTaken: t.damageTaken || 0,
                    manaSpent: t.manaSpent || 0,
                    party,
                    floorHopLog: Array.isArray(sim.floorHopLog)
                        ? sim.floorHopLog.map((h) => ({
                              tick: h.tick,
                              name: h.name,
                              fromZ: h.fromZ,
                              toZ: h.toZ,
                              x: h.x,
                              y: h.y
                          }))
                        : [],
                    parityTickLog: Array.isArray(sim.parityTickLog)
                        ? sim.parityTickLog.slice()
                        : [],
                    parityWindow: sim._parityWindow
                        ? {
                              from: sim._parityWindow.from,
                              to: sim._parityWindow.to,
                              mode: sim._parityTraceMode
                          }
                        : null
                };
            }
        };
    }

    return {
        appUrl,
        mapUrl: mapUrlFromFloor,
        startSession,
        stopSession,
        togglePause,
        readPartyForm,
        collectPrefs,
        stopPanelPoll,
        equipmentPanelCtl,
        inventoryPanelCtl,
        rosterPanelsCtl,
        collapsiblePanelsCtl,
        actionBarsCtl,
        engineTweaksBridge,
        fullscreenCtl
    };
}

module.exports = {
    initGameApp,
    appUrl,
    mapUrl,
    PREFS_KEY,
    readPartyForm,
    fillSelect
};
