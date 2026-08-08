/**
 * Scenario Lab UI — watch named hunt fixtures with scenario-specific knobs.
 * Layout mirrors Hunt Simulator but drops party editor / scrubber; fixtures
 * come from presets/scenarios via hunt_scenarios.js (Stage 12G.2 shell).
 */

'use strict';

const { Settings, DEFAULT_GENRE } = require('../../settings.js');
const { Application } = require('../../engine.js');
const { Simulator } = require('../../providers/simulator/simulator.js');
const {
    loadBrowserPresets,
    buildPresetInjectors,
    getScenarioLists,
    getCatalogLists,
    listModesForBrowser,
    mapUrlForFloor,
    DEFAULT_MODE_ID,
    getActiveModeId,
    apiUrl: gameApiUrl
} = require('../game/presets_loader.js');
const { getActiveMode } = require('../../core/lib/modes.js');
const {
    bindLivePanelElements,
    startLivePanelPoll,
    bindPartyDetailsModal
} = require('../game/live_panel.js');
const { bindEquipmentPanel, getActivePlayerFromSim } = require('../game/equipment_panel.js');
const { bindInventoryPanel } = require('../game/inventory_panel.js');
const actionBarsModule = require('../game/action_bars.js');
const { initActionBars } = actionBarsModule;
const { createActionBarParentBridge } = require('../../../html/widgets/action_bar_config/parent_bridge.js');
const {
    initTargetCursorListeners,
    initManualKeyboardControls,
    initMouseButtonTracking,
    clearActiveMoveKeys,
    loadMouseControls
} = require('../game/ui_state.js');
const {
    transferManualControlOnSlotChange,
    syncActiveControlToggle: syncActiveControlToggleUi,
    applyControlModeChange,
    bindManualCanvasClick,
    wireManualControlToggles
} = require('../game/manual_control.js');
const {
    bindCollapsiblePanels,
    bindRosterPanels,
    cycleCombatTarget
} = require('../game/combat_panel.js');
const { bindBugReportModal } = require('../game/bug_report.js');
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
    openScenarioSettings,
    getScenarioMeta,
    SCENARIO_SETTINGS_KEYS
} = require('../../core/lib/hunt_scenarios.js');
const {
    formDefaultsForScenario,
    buildScenarioSimulatorOpts,
    partySummaryFromResolved
} = require('./session.js');
const {
    MAX_PARTY_SLOTS,
    partyFormFromPartyId,
    partyFormFromParty,
    normalizeMember,
    ensureSingleLeader,
    leaderFormSlot,
    enabledMemberIndexForSlot
} = require('../game/party_form.js');
const { loadParty } = require('../../core/lib/presets.js');
const { DEFAULT_PARTY_ID } = require('../../core/lib/character/party_resolve.js');
const {
    prefetchHuntSprites
} = require('../../core/lib/creature_sprites.js');
const {
    bindCanvasFullscreen,
    DEFAULT_CANVAS_W,
    DEFAULT_CANVAS_H
} = require('../../core/lib/canvas_fullscreen.js');
const {
    setPreferredContentModeId,
    resolvePreferredContentModeId
} = require('../../core/lib/ui_preferences.js');

/** localStorage key for last scenario id */
const STORAGE_SCENARIO = 'scenario_lab_id';
const STORAGE_SPEED = 'scenario_lab_speed';

/**
 * @param {string|number} floorId
 * @returns {string}
 */
function mapUrlFromFloor(floorId) {
    return mapUrlForFloor(floorId);
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
 * @param {HTMLSelectElement|null} select
 * @param {{ id: string, label: string }[]} options
 * @param {string} [selected]
 */
function fillSelect(select, options, selected) {
    if (!select) return;
    const parts = [];
    for (let i = 0; i < options.length; i++) {
        const o = options[i];
        const sel = o.id === selected ? ' selected' : '';
        parts.push(
            `<option value="${escapeHtml(o.id)}"${sel}>${escapeHtml(
                o.label || o.id
            )}</option>`
        );
    }
    select.innerHTML = parts.join('');
}

/**
 * Build dynamic settings knobs for the selected scenario.
 * @param {object|null} meta from getScenarioMeta
 * @param {Record<string, number|boolean>|null} current
 */
function renderSettingsKnobs(meta, current) {
    const root = document.getElementById('scenarioSettingsKnobs');
    if (!root) return;

    const settings = (current || (meta && meta.settings) || null) || null;
    if (!settings || !Object.keys(settings).length) {
        root.innerHTML =
            '<p class="text-muted text-xxs mb-0">No scenario Settings knobs for this fixture.</p>';
        return;
    }

    const parts = [];
    for (const key of Object.keys(settings)) {
        if (!SCENARIO_SETTINGS_KEYS.has(key)) continue;
        const val = settings[key];
        const inputId = `scen-set-${key}`;
        parts.push(`
<div class="mb-2">
  <label class="label-retro" for="${inputId}">${escapeHtml(key)}</label>
  <input type="number" class="form-control form-control-retro w-100 scen-setting"
    id="${inputId}" data-setting-key="${escapeHtml(key)}"
    value="${escapeHtml(String(val))}" step="any">
</div>`);
    }
    root.innerHTML = parts.join('');
}

/**
 * @returns {Record<string, number|boolean>|null}
 */
function readSettingsFromDom() {
    const root = document.getElementById('scenarioSettingsKnobs');
    if (!root) return null;
    /** @type {Record<string, number|boolean>} */
    const out = Object.create(null);
    let any = false;
    root.querySelectorAll('.scen-setting').forEach((el) => {
        const key = el.getAttribute('data-setting-key');
        if (!key || !SCENARIO_SETTINGS_KEYS.has(key)) return;
        const n = Number(el.value);
        if (Number.isFinite(n)) {
            out[key] = n;
            any = true;
        }
    });
    return any ? out : null;
}

/**
 * Resolved party snapshot under the slim editor (after Play).
 * @param {object} resolved from buildScenarioSimulatorOpts
 */
function renderPartySummary(resolved) {
    const el = document.getElementById('scenarioPartySummary');
    if (!el) return;
    const rows = partySummaryFromResolved(resolved);
    if (!rows.length) {
        el.hidden = false;
        el.innerHTML =
            '<p class="text-muted small mb-0">Party from base hunt</p>';
        return;
    }
    el.hidden = false;
    el.innerHTML = rows
        .map(
            (m) =>
                `<div class="live-member">` +
                `<span class="live-member-name">${escapeHtml(m.name)}</span>` +
                `<span class="live-member-meta">Lv ${escapeHtml(
                    String(m.level)
                )} · ${escapeHtml(m.classId)} · ${escapeHtml(
                    m.strategyId
                )}</span>` +
                `</div>`
        )
        .join('');
}

/**
 * Fill Active label / Set Active button for each party slot header.
 * Disabled slots get no control (they are not in the session party).
 * @param {HTMLElement} root #partySlots
 * @param {number} activeSlot
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
 * Slim party editor: enable / leader + Active view + read-only name/class.
 * @param {object} catalog from getCatalogLists()
 * @param {object[]} members
 * @param {() => void} onChange
 * @param {{ activeSlot?: number, onSetActive?: (slot: number) => void }} [viewOpts]
 */
function renderPartyEditor(catalog, members, onChange, viewOpts) {
    const root = document.getElementById('partySlots');
    if (!root) return;
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
      <span>${escapeHtml(m.name || `Slot ${i + 1}`)}</span>
    </label>
    <div class="party-slot-header-right">
      <span class="party-slot-active-wrap" data-slot="${i}"></span>
      <label class="party-slot-leader">
        <input type="radio" name="scenarioPartyLeader" class="pf-leader" data-slot="${i}"${
            m.isLeader ? ' checked' : ''
        }>
        Leader
      </label>
    </div>
  </div>
  <div class="party-slot-body d-flex justify-content-between align-items-center mt-1">
    <p class="text-muted text-xxs mb-0">
      Lv ${escapeHtml(String(m.level))} · ${escapeHtml(m.classId || '?')} · ${escapeHtml(
          m.strategyId || 'balanced'
      )}
    </p>
    <select class="form-select form-select-retro form-select-sm pf-control" style="width: 85px;" data-slot="${i}">
      <option value="ai"${m.controlMode === 'manual' ? '' : ' selected'}>AI</option>
      <option value="manual"${m.controlMode === 'manual' ? ' selected' : ''}>Manual</option>
    </select>
  </div>
</div>`);
    }
    root.innerHTML = html.join('');
    syncActiveViewControls(root, activeSlot, onSetActive);
    const notify = () => {
        if (typeof onChange === 'function') onChange();
    };
    root.querySelectorAll('input, select').forEach((el) => {
        el.addEventListener('change', (ev) => {
            const t = ev.target;
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
            if (t && t.classList && t.classList.contains('pf-enabled')) {
                const enSlot = parseInt(t.getAttribute('data-slot'), 10);
                let nextActive = activeSlot;
                if (
                    Number.isFinite(enSlot) &&
                    enSlot === activeSlot &&
                    !t.checked
                ) {
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
    });
}

/**
 * @returns {object[]}
 */
function readPartyForm() {
    const root = document.getElementById('partySlots');
    const members = [];
    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
        const base = formMembers[i] || normalizeMember(null, i);
        if (!root) {
            members.push(base);
            continue;
        }
        const enabledEl = root.querySelector(`.pf-enabled[data-slot="${i}"]`);
        const controlEl = root.querySelector(`.pf-control[data-slot="${i}"]`);
        const leaderEl = root.querySelector(`.pf-leader[data-slot="${i}"]`);
        members.push(
            normalizeMember(
                Object.assign({}, base, {
                    enabled: enabledEl ? enabledEl.checked : base.enabled,
                    controlMode: controlEl ? controlEl.value : (base.controlMode || 'ai'),
                    isLeader: leaderEl ? leaderEl.checked : base.isLeader
                }),
                i
            )
        );
    }
    ensureSingleLeader(members);
    return members;
}

/**
 * @param {boolean} locked
 */
function setFormLocked(locked) {
    const ids = [
        'scenarioSelect',
        'seedInput',
        'partySelect',
        'resetPartyBtn',
        'modeSelect'
    ];
    for (let i = 0; i < ids.length; i++) {
        const el = document.getElementById(ids[i]);
        if (el) el.disabled = !!locked;
    }
    const knobs = document.getElementById('scenarioSettingsKnobs');
    if (knobs) {
        knobs.querySelectorAll('input').forEach((el) => {
            el.disabled = !!locked;
        });
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

/** @type {object[]} */
let formMembers = partyFormFromPartyId(DEFAULT_PARTY_ID).members;
/** @type {string} */
let formPartyId = DEFAULT_PARTY_ID;
/** Form slot for watch camera (independent of Leader). @type {number} */
let activeViewSlot = leaderFormSlot(formMembers);

async function initScenarioLabApp() {
    const canvas = document.getElementById('gameCanvas');
    const playBtn = document.getElementById('playBtn');
    const pauseBtn = document.getElementById('pauseBtn');
    const stopBtn = document.getElementById('stopBtn');
    const speedSlider = document.getElementById('speedSlider');
    const speedVal = document.getElementById('speedVal');
    const seedInput = document.getElementById('seedInput');
    const scenarioSelect = document.getElementById('scenarioSelect');
    const scenarioDescription = document.getElementById('scenarioDescription');
    const statusBadge = document.getElementById('sessionStateBadge');
    const loadError = document.getElementById('gameLoadError');

    const setStatus = (text) => {
        if (statusBadge) statusBadge.textContent = text;
    };

    setStatus('LOADING');

    const modeSelect = document.getElementById('modeSelect');
    const partySelect = document.getElementById('partySelect');
    const resetPartyBtn = document.getElementById('resetPartyBtn');
    let injectors = null;
    let sessionLive = false;
    /** @type {null|(() => void)} */
    let restoreScenarioSettings = null;
    let stopPanelPoll = null;
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
    /** @type {object[]} */
    let catalog = [];
    /** @type {object|null} */
    let partyCatalog = null;

    /** @type {string} */
    let activeModeId =
        (typeof window !== 'undefined' && window.__CONTENT_MODE__) ||
        DEFAULT_MODE_ID;

    /**
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
            formMember: formMembers[activeViewSlot]
        });
    };

    /**
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
        activeViewSlot = s;
        const root = document.getElementById('partySlots');
        syncActiveViewControls(root, activeViewSlot, setActiveViewSlot);
        if (sessionLive && Application.currentLevel) {
            applyCameraFocusToSim(Application.currentLevel, formMembers);
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
        renderPartyEditor(partyCatalog || {}, members, () => {}, {
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

    /**
     * @param {string} [partyId]
     */
    function applyPartyDefaults(partyId) {
        const id =
            partyId ||
            (partySelect && partySelect.value) ||
            formPartyId ||
            DEFAULT_PARTY_ID;
        formPartyId = id;
        if (partySelect) {
            const opt = Array.from(partySelect.options || []).some(
                (o) => o.value === id
            );
            if (opt) partySelect.value = id;
        }
        formMembers = partyFormFromPartyId(id, { loadParty }).members;
        activeViewSlot = leaderFormSlot(formMembers);
        paintPartyEditor(formMembers);
    }

    /**
     * @param {string} modeId
     * @returns {Promise<object[]>}
     */
    async function applyContentMode(modeId) {
        await loadBrowserPresets(modeId);
        activeModeId = getActiveModeId();
        setPreferredContentModeId(activeModeId);
        injectors = buildPresetInjectors();
        catalog = getScenarioLists();
        partyCatalog = getCatalogLists();
        const mode = getActiveMode();
        let selectedId =
            (mode.defaults && mode.defaults.scenarioId) ||
            (catalog[0] && catalog[0].id) ||
            'choke_pack';
        try {
            const saved = localStorage.getItem(STORAGE_SCENARIO);
            if (saved && catalog.some((c) => c.id === saved)) {
                selectedId = saved;
            }
        } catch (_) {
            /* ignore */
        }
        if (scenarioSelect) {
            fillSelect(
                scenarioSelect,
                catalog.length
                    ? catalog
                    : [{ id: selectedId, label: selectedId }],
                selectedId
            );
        }
        if (partySelect && partyCatalog) {
            const partyIds =
                partyCatalog.parties && partyCatalog.parties.length
                    ? partyCatalog.parties
                    : [{ id: DEFAULT_PARTY_ID, label: DEFAULT_PARTY_ID }];
            const defaultParty =
                (mode.defaults && mode.defaults.partyId) || DEFAULT_PARTY_ID;
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

    try {
        const modes = await listModesForBrowser();
        const modeIds = modes.map((m) => m.id);
        const modeToLoad = resolvePreferredContentModeId({
            fallback: activeModeId,
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
        await applyContentMode(modeToLoad);
    } catch (err) {
        console.error('Failed to load presets for Scenario Lab:', err);
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

    let selectedId =
        (scenarioSelect && scenarioSelect.value) ||
        (catalog[0] && catalog[0].id) ||
        'choke_pack';

    Settings.TIME_SPEED = Settings.DEFAULT_PLAY_SPEED;
    try {
        const savedSpeed = localStorage.getItem(STORAGE_SPEED);
        if (savedSpeed != null) {
            const n = parseFloat(savedSpeed);
            if (Number.isFinite(n) && n >= 0.25 && n <= 20) {
                Settings.TIME_SPEED = n;
            }
        }
    } catch (_) {
        /* ignore */
    }
    if (speedSlider) speedSlider.value = String(Settings.TIME_SPEED);
    if (speedVal) speedVal.textContent = Settings.TIME_SPEED.toFixed(2);

    loadPersistedDebugAI(Settings);
    loadPersistedCamera(Settings);
    loadPersistedProgression(Settings);
    // docs/29 Stage 3: mouse control mode + loot stub prefs
    loadMouseControls();
    const engineTweaksBridge = createEngineTweakingsParentBridge({
        Settings,
        Application,
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

    const applyScenarioUi = (id) => {
        const defaults = formDefaultsForScenario(id);
        if (seedInput) seedInput.value = String(defaults.seed);
        if (scenarioDescription) {
            const meta = getScenarioMeta(id);
            scenarioDescription.textContent = meta.notes || '';
        }
        renderSettingsKnobs(getScenarioMeta(id), defaults.settings);
        // Fixture-authored members (inventory sandbox, etc.) replace party form
        if (Array.isArray(defaults.members) && defaults.members.length) {
            const { members } = partyFormFromParty({
                members: defaults.members
            });
            formMembers = members;
            formPartyId =
                defaults.partyId ||
                (partySelect && partySelect.value) ||
                formPartyId ||
                DEFAULT_PARTY_ID;
            if (partySelect && defaults.partyId) {
                partySelect.value = defaults.partyId;
            }
            paintPartyEditor(formMembers);
            return;
        }
        // Scenario may pin a fixture partyId; otherwise keep current selection
        const partyId =
            defaults.partyId ||
            (partySelect && partySelect.value) ||
            formPartyId ||
            DEFAULT_PARTY_ID;
        applyPartyDefaults(partyId);
    };

    applyScenarioUi(selectedId);

    if (partySelect) {
        partySelect.addEventListener('change', () => {
            if (sessionLive) return;
            applyPartyDefaults(partySelect.value);
        });
    }
    if (resetPartyBtn) {
        resetPartyBtn.addEventListener('click', () => {
            if (sessionLive) return;
            applyPartyDefaults(
                (partySelect && partySelect.value) || formPartyId
            );
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
                selectedId =
                    (scenarioSelect && scenarioSelect.value) ||
                    (catalog[0] && catalog[0].id) ||
                    selectedId;
                applyScenarioUi(selectedId);
                setStatus('READY');
            } catch (err) {
                console.error('Mode switch failed:', err);
                setStatus('ERROR');
            }
        });
    }

    if (scenarioSelect) {
        scenarioSelect.addEventListener('change', () => {
            if (sessionLive) return;
            selectedId = scenarioSelect.value;
            try {
                localStorage.setItem(STORAGE_SCENARIO, selectedId);
            } catch (_) {
                /* ignore */
            }
            applyScenarioUi(selectedId);
        });
    }

    if (speedSlider) {
        speedSlider.addEventListener('input', () => {
            const val = parseFloat(speedSlider.value);
            Settings.TIME_SPEED = Number.isFinite(val) ? val : 1;
            if (speedVal) {
                speedVal.textContent = Settings.TIME_SPEED.toFixed(2);
            }
            try {
                localStorage.setItem(STORAGE_SPEED, String(Settings.TIME_SPEED));
            } catch (_) {
                /* ignore */
            }
        });
    }

    const liveEls = bindLivePanelElements(document);
    const onLiveFloorHop = (hops) => {
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
    };
    stopPanelPoll = startLivePanelPoll({
        getSim: () => Application.currentLevel,
        isPaused: () => !!Application.paused,
        els: liveEls,
        intervalMs: 250,
        onFloorHop: onLiveFloorHop
    });
    equipmentPanelCtl = bindEquipmentPanel({
        getSim: () => Application.currentLevel,
        getIdleMember: () => {
            const m = formMembers[activeViewSlot];
            return m && m.enabled !== false
                ? m
                : formMembers.find((x) => x && x.enabled !== false) || null;
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
            if (
                equipmentPanelCtl &&
                typeof equipmentPanelCtl.refresh === 'function'
            ) {
                equipmentPanelCtl.refresh();
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
                source: 'scenario',
                modeId:
                    (modeSelect && modeSelect.value) ||
                    getActiveModeId() ||
                    DEFAULT_MODE_ID,
                seed,
                scenarioId:
                    (scenarioSelect && scenarioSelect.value) || selectedId,
                partyId:
                    (partySelect && partySelect.value) ||
                    formPartyId ||
                    DEFAULT_PARTY_ID,
                members: readPartyForm(),
                sim: Application.currentLevel,
                timeSpeed: Settings.TIME_SPEED,
                scenarioSettings: readSettingsFromDom()
            };
        }
    });

    const clearSettingsPatch = () => {
        if (typeof restoreScenarioSettings === 'function') {
            restoreScenarioSettings();
        }
        restoreScenarioSettings = null;
    };

    const stopSession = () => {
        Application.quit();
        Settings.cameraTileX = null;
        Settings.cameraTileY = null;
        Settings.cameraTileZ = null;
        clearSettingsPatch();
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
        const partySummaryEl = document.getElementById('scenarioPartySummary');
        if (partySummaryEl) {
            partySummaryEl.hidden = true;
            partySummaryEl.innerHTML =
                '<p class="text-muted small mb-0">—</p>';
        }
        setStatus('STOPPED');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = Settings.screenColor;
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#8b9bb4';
                ctx.font = '14px monospace';
                ctx.fillText('Press Play — Scenario Lab', 24, 40);
                ctx.fillText(
                    'Named fixtures · short combat · no full corridor',
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
        clearSettingsPatch();

        const id = scenarioSelect ? scenarioSelect.value : selectedId;
        let seed = 1;
        if (seedInput && seedInput.value.trim() !== '') {
            const parsed = parseInt(seedInput.value.trim(), 10);
            if (Number.isFinite(parsed)) seed = parsed >>> 0 || 1;
        } else {
            seed = (Math.floor(Math.random() * 999999) + 1) >>> 0;
            if (seedInput) seedInput.value = String(seed);
        }

        const settings = readSettingsFromDom();
        formMembers = readPartyForm();
        const partyId =
            (partySelect && partySelect.value) ||
            formPartyId ||
            DEFAULT_PARTY_ID;
        formPartyId = partyId;
        let built;
        try {
            built = buildScenarioSimulatorOpts(
                {
                    scenarioId: id,
                    seed,
                    settings,
                    partyId,
                    members: formMembers
                },
                injectors,
                null
            );
        } catch (err) {
            console.error(err);
            setStatus('ERROR');
            throw err;
        }

        const floor =
            built.simOpts.floor != null ? built.simOpts.floor : 7;
        // Stage 11.4/11.5: keep generated floorFriction; only set PNG for path hunts
        if (!built.simOpts.floorFriction && !built.simOpts.floorLayers) {
            built.simOpts.mapPath = mapUrlFromFloor(floor);
        }

        Settings.HEADLESS = false;
        // Tile size (camera zoom) from Engine Tweakings / localStorage
        Application.paused = false;
        setStatus('LOADING');

        restoreScenarioSettings = openScenarioSettings(built.scenarioSettings);

        try {
            const genre = built.simOpts.genre || DEFAULT_GENRE;
            /** @type {Record<string, object>} */
            const templates = Object.create(null);
            const spawnList = Array.isArray(built.simOpts.spawns)
                ? built.simOpts.spawns
                : [];
            for (let i = 0; i < spawnList.length; i++) {
                const sid =
                    spawnList[i] &&
                    (spawnList[i].creatureId || spawnList[i].id);
                if (!sid || templates[sid] || !injectors.creatureLoader) {
                    continue;
                }
                try {
                    const tpl = injectors.creatureLoader(sid);
                    if (tpl) templates[sid] = tpl;
                } catch (_) {
                    /* ignore */
                }
            }
            const members =
                built.simOpts.parties &&
                built.simOpts.parties[0] &&
                built.simOpts.parties[0].members
                    ? built.simOpts.parties[0].members
                    : [];
            prefetchHuntSprites({
                genre,
                spawns: spawnList,
                members,
                templates,
                classLoader: injectors.classLoader || null,
                itemDb: injectors.itemDb || null
            });
        } catch (_) {
            /* never block session start on art */
        }

        const sim = new Simulator(built.simOpts);
        applyCameraFocusToSim(sim, formMembers);
        const w = canvas ? canvas.width || 720 : 720;
        const h = canvas ? canvas.height || 480 : 480;

        try {
            await Application.run('gameCanvas', sim, w, h);
        } catch (err) {
            console.error('Failed to start scenario session:', err);
            clearSettingsPatch();
            sessionLive = false;
            setFormLocked(false);
            if (pauseBtn) {
                pauseBtn.disabled = true;
                pauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
            }
            setStatus('ERROR');
            throw err;
        }
        // Application.run succeeded — keep sessionLive true even if sidebar UI fails
        sessionLive = true;
        applyCameraFocusToSim(sim, formMembers);
        syncActiveControlToggle();
        setFormLocked(true);
        if (pauseBtn) pauseBtn.disabled = false;
        setStatus('RUNNING');
        try {
            renderPartySummary(built.resolved);
        } catch (err) {
            console.warn('Scenario party summary UI failed:', err);
        }
    };

    const togglePause = () => {
        if (!sessionLive || !Application.currentLevel) return;
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
    };

    if (playBtn) {
        playBtn.addEventListener('click', () => {
            const sim = Application.currentLevel;
            // Resume only while still running; ended sessions restart on Play.
            if (
                sessionLive &&
                Application.paused &&
                sim &&
                !isSessionTerminal(sim.sessionState)
            ) {
                togglePause();
                return;
            }
            if (
                sessionLive &&
                sim &&
                !Application.paused &&
                !isSessionTerminal(sim.sessionState)
            ) {
                return;
            }
            startSession().catch(() => {});
        });
    }
    if (pauseBtn) {
        pauseBtn.addEventListener('click', togglePause);
        pauseBtn.disabled = true;
    }
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            stopSession();
        });
    }

    wireManualControlToggles({
        getActiveViewSlot: () => activeViewSlot,
        getFormMembers: () => formMembers,
        getSessionLive: () => sessionLive,
        getLivePlayer: () =>
            sessionLive && Application.currentLevel
                ? getActivePlayerFromSim(Application.currentLevel)
                : null
    });

    if (canvas) {
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

    // Idle canvas hint
    if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.fillStyle = Settings.screenColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#8b9bb4';
            ctx.font = '14px monospace';
            ctx.fillText('Press Play — Scenario Lab', 24, 40);
            ctx.fillText(
                'Named fixtures · short combat · no full corridor',
                24,
                62
            );
        }
    }

    setStatus('READY');

    return {
        fullscreenCtl,
        equipmentPanelCtl,
        inventoryPanelCtl,
        rosterPanelsCtl,
        collapsiblePanelsCtl,
        stop: () => {
            if (stopPanelPoll) stopPanelPoll();
            if (equipmentPanelCtl && equipmentPanelCtl.dispose) {
                equipmentPanelCtl.dispose();
            }
            if (inventoryPanelCtl && inventoryPanelCtl.dispose) {
                inventoryPanelCtl.dispose();
            }
            if (rosterPanelsCtl && rosterPanelsCtl.dispose) {
                rosterPanelsCtl.dispose();
            }
            if (collapsiblePanelsCtl && collapsiblePanelsCtl.dispose) {
                collapsiblePanelsCtl.dispose();
            }
            if (actionBarsCtl && actionBarsCtl.dispose) {
                actionBarsCtl.dispose();
            }
            stopSession();
            if (fullscreenCtl && fullscreenCtl.dispose) {
                fullscreenCtl.dispose();
            }
            if (engineTweaksBridge && engineTweaksBridge.dispose) {
                engineTweaksBridge.dispose();
            }
        }
    };
}

module.exports = {
    initScenarioLabApp,
    mapUrlFromFloor
};
