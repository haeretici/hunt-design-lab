/**
 * Action Bars core UI & keymap dispatcher for manual hunt and combat execution.
 * Handles slot assignment, hotkey mapping, Smart Cast preference, macro dispatching,
 * shared combat cooldown overlays (primary/group/spell/item), and dirty-only paint.
 */

'use strict';

const {
    countItemIdInInventoryTree,
    equipItem,
    unequipItem,
    itemIsEquipable,
    itemIsMultiUse,
    isRuntimeInventory,
    preferredEquipSlot,
    getStackCount
} = require('../../core/lib/character/inventory.js');
const {
    resolveItemIdBudgetDisplay
} = require('../../core/lib/character/equipment_runtime.js');
const { findItem } = require('../../core/lib/character/stats.js');
const {
    isSelfCenteredAreaSpell,
    spellHasShape
} = require('../../core/lib/combat/area.js');
const Cooldowns = require('../../core/lib/combat/cooldowns.js');
const { enterTargetCursorMode, loadGeneralHotkeys } = require('./ui_state.js');
const { resolveItemSpriteUrl } = require('./equipment_panel.js');
const { getUiPreferences, createDebouncedPrefsSaver } = require('../../core/lib/ui_preferences.js');
const {
    showSlotContextMenu,
    hideSlotContextMenu,
    cancelItemPickMode,
    emitActionBarFloat
} = require('./action_bar_modals.js');

/** Canonical localStorage + IndexedDB prefs key. */
const LS_KEY = 'hdl_action_bars';
const PREFS_KEY = 'hdl_action_bars';
/** @deprecated alias — same as LS_KEY */
const LS_KEY_V2 = LS_KEY;

/** Live poll while hunting; faster while any slot is on cooldown (clock wipe). */
const POLL_MS_LIVE = 250;
const POLL_MS_LIVE_COOLDOWN = 100;
const POLL_MS_IDLE = 2000;
const POLL_MS_HIDDEN = 4000;

/** Logical slots per bar (legacy-style capacity; carousel navigates the window). */
const SLOTS_PER_BAR = 50;
/** Max toolbars per dock side (top/bottom/left/right). */
const MAX_BARS_PER_DOCK = 3;
/** Multi-action sub-slot depth. */
const MULTI_ACTION_DEPTH = 3;
/**
 * Visible slots per bar in the hunt window (carousel window size).
 * Setup popup still lists all logical slots.
 */
const VISIBLE_CAP_HORIZONTAL = 12;
const VISIBLE_CAP_VERTICAL = 10;

const DOCK_AREAS = ['top', 'bottom', 'left', 'right'];
const VALID_ACTION_TYPES = new Set(['empty', 'item', 'spell', 'command', 'text', 'passive', 'multi']);
const VALID_TARGET_MODES = new Set([
    'smart_target',
    'active_target',
    'cursor_prompt',
    'self'
]);
const VALID_SUB_ACTION_TYPES = new Set(['empty', 'item', 'spell', 'text']);

/**
 * @typedef {object} ActionBarSubSlot
 * @property {'empty'|'item'|'spell'|'text'} actionType
 * @property {string|null} [itemId]
 * @property {string|null} [spellId]
 * @property {string|null} [text]
 * @property {'smart_target'|'active_target'|'cursor_prompt'|'self'} [targetMode]
 */

/**
 * @typedef {object} ActionBarSlot
 * @property {string} id
 * @property {number} index
 * @property {string} hotkey
 * @property {'empty'|'item'|'spell'|'command'|'text'|'passive'|'multi'} actionType
 * @property {string|null} [itemId]
 * @property {string|null} [spellId]
 * @property {string|null} [command]
 * @property {string|null} [text]
 * @property {string|null} [passiveId]
 * @property {ActionBarSubSlot[]|null} [multiActions]
 * @property {'smart_target'|'active_target'|'cursor_prompt'|'self'} targetMode
 */

/**
 * @typedef {object} ActionBar
 * @property {string} id
 * @property {'horizontal'|'vertical'} orientation
 * @property {number} [pageOffset]
 * @property {boolean} [locked]
 * @property {ActionBarSlot[]} slots
 */

/**
 * @typedef {object} LayoutCounts
 * @property {number} top
 * @property {number} bottom
 * @property {number} left
 * @property {number} right
 */

const state = {
    /** @type {string} */
    activeProfileId: 'guardian',
    /** @type {string|null} */
    lastSeenPlayerClass: null,
    /** @type {Record<string, Record<string, ActionBar[]>>} profile ID (vocation/class) -> docks */
    profiles: {},
    /** @type {Record<string, ActionBar[]>} current active docks */
    docks: {
        top: [],
        bottom: [],
        left: [],
        right: []
    },
    /** Bars per dock (0–3). Shared across profiles; default 1×1×1×1 until Engine Tweakings UI. */
    /** @type {LayoutCounts} */
    layoutCounts: { top: 1, bottom: 1, left: 1, right: 1 },
    /**
     * Hidden bars when layoutCounts shrinks (preserve assignments until explicit clear).
     * profileId -> area -> ActionBar[]
     * @type {Record<string, Record<string, ActionBar[]>>}
     */
    barStash: {},
    /** @type {Map<string, string>} normalized hotkey -> slot id */
    hotkeysMap: new Map(),
    /** @type {Map<string, ActionBarSlot>} slot id -> slot */
    slotsById: new Map(),
    /** @type {Map<string, string>} slot id -> dirty signature */
    lastSignatures: new Map(),
    /** True when any painted slot is mid-cooldown (drives faster poll). */
    anySlotOnCooldown: false,
    /** @type {(() => object|null)|null} */
    getActivePlayer: null,
    /** @type {(() => object|null)|null} */
    getItemDb: null,
    /** @type {(() => Record<string, object>|null)|null} */
    getSpellBook: null,
    /** @type {(() => string)|null} */
    getGenre: null,
    /** @type {(() => boolean)|null} */
    getIsSessionLive: null,
    /** @type {(() => object|null)|null} */
    getSimulator: null,
    /** @type {((profileId: string) => void)|null} */
    onProfileChange: null,
    /** @type {(() => void)|null} */
    debouncedIdbSaver: null,
    /** @type {ReturnType<typeof setTimeout>|null} */
    pollTimer: null,
    visibilityBound: false,
    inited: false,
    keyDispatcherBound: false
};

/**
 * Normalize hotkey representation for reliable matching (e.g. "SHIFT+1", "F1", "CTRL+F1").
 * @param {string} str
 * @returns {string}
 */
function normalizeHotkey(str) {
    if (!str) return '';
    return String(str).trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * @returns {LayoutCounts}
 */
function defaultLayoutCounts() {
    return { top: 1, bottom: 1, left: 1, right: 1 };
}

/**
 * Clamp a dock bar count to 0..MAX_BARS_PER_DOCK.
 * @param {*} n
 * @returns {number}
 */
function clampBarCount(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 1;
    return Math.max(0, Math.min(MAX_BARS_PER_DOCK, Math.floor(v)));
}

/**
 * @param {object|null|undefined} raw
 * @returns {LayoutCounts}
 */
function normalizeLayoutCounts(raw) {
    const d = defaultLayoutCounts();
    if (!raw || typeof raw !== 'object') return d;
    return {
        top: raw.top !== undefined ? clampBarCount(raw.top) : d.top,
        bottom: raw.bottom !== undefined ? clampBarCount(raw.bottom) : d.bottom,
        left: raw.left !== undefined ? clampBarCount(raw.left) : d.left,
        right: raw.right !== undefined ? clampBarCount(raw.right) : d.right
    };
}

/**
 * Default hotkeys for bar 1 only (bars 2–3 start unbound).
 * @param {string} area
 * @param {number} barIndex1Based
 * @returns {string[]}
 */
function defaultHotkeysFor(area, barIndex1Based) {
    if (barIndex1Based !== 1) return [];
    if (area === 'top') {
        return ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
    }
    if (area === 'bottom') {
        return ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
    }
    if (area === 'left') {
        return ['Shift+1', 'Shift+2', 'Shift+3', 'Shift+4', 'Shift+5', 'Shift+6', 'Shift+7', 'Shift+8', 'Shift+9', 'Shift+0'];
    }
    if (area === 'right') {
        return ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9', 'Ctrl+0'];
    }
    return [];
}

/**
 * @param {string} area
 * @returns {'horizontal'|'vertical'}
 */
function orientationForArea(area) {
    return (area === 'left' || area === 'right') ? 'vertical' : 'horizontal';
}

/**
 * @returns {ActionBarSubSlot}
 */
function createEmptySubSlot() {
    return {
        actionType: 'empty',
        itemId: null,
        spellId: null,
        text: null,
        targetMode: 'smart_target'
    };
}

/**
 * Normalize multi-action sub-slots to fixed depth.
 * @param {*} raw
 * @returns {ActionBarSubSlot[]}
 */
function normalizeMultiActions(raw) {
    const out = [];
    for (let i = 0; i < MULTI_ACTION_DEPTH; i++) {
        const r = Array.isArray(raw) ? raw[i] : null;
        if (!r || typeof r !== 'object') {
            out.push(createEmptySubSlot());
            continue;
        }
        const t = VALID_SUB_ACTION_TYPES.has(r.actionType) ? r.actionType : 'empty';
        const sub = createEmptySubSlot();
        sub.actionType = t;
        if (t === 'item') {
            sub.itemId = r.itemId != null ? String(r.itemId) : null;
        } else if (t === 'spell') {
            sub.spellId = r.spellId != null ? String(r.spellId) : null;
        } else if (t === 'text') {
            sub.text = r.text != null ? String(r.text) : null;
        }
        if (r.targetMode && VALID_TARGET_MODES.has(r.targetMode)) {
            sub.targetMode = r.targetMode;
        }
        out.push(sub);
    }
    return out;
}

/**
 * Create a fresh empty slot.
 * @param {string} barId
 * @param {number} index
 * @param {string} [hotkey]
 * @returns {ActionBarSlot}
 */
function createEmptySlot(barId, index, hotkey) {
    return {
        id: `${barId}_slot_${index}`,
        index,
        hotkey: hotkey ? normalizeHotkey(hotkey) : '',
        actionType: 'empty',
        itemId: null,
        spellId: null,
        command: null,
        text: null,
        passiveId: null,
        multiActions: null,
        targetMode: 'smart_target'
    };
}

/**
 * Normalize one slot from storage / partial assign payload.
 * @param {object|null|undefined} raw
 * @param {string} barId
 * @param {number} index
 * @returns {ActionBarSlot}
 */
function normalizeSlot(raw, barId, index) {
    const fallbackHotkey = '';
    const base = createEmptySlot(barId, index, fallbackHotkey);
    if (!raw || typeof raw !== 'object') return base;
    if (raw.id != null && String(raw.id).trim() !== '') {
        base.id = String(raw.id);
    }
    base.index = index;
    base.hotkey = normalizeHotkey(raw.hotkey || '');
    const t = VALID_ACTION_TYPES.has(raw.actionType) ? raw.actionType : 'empty';
    base.actionType = t;
    base.targetMode = VALID_TARGET_MODES.has(raw.targetMode) ? raw.targetMode : 'smart_target';
    if (t === 'item') {
        base.itemId = raw.itemId != null && raw.itemId !== '' ? String(raw.itemId) : null;
    } else if (t === 'spell') {
        base.spellId = raw.spellId != null && raw.spellId !== '' ? String(raw.spellId) : null;
    } else if (t === 'command') {
        base.command = raw.command != null && raw.command !== '' ? String(raw.command) : null;
    } else if (t === 'text') {
        base.text = raw.text != null ? String(raw.text) : null;
    } else if (t === 'passive') {
        base.passiveId = raw.passiveId != null && raw.passiveId !== '' ? String(raw.passiveId) : null;
    } else if (t === 'multi') {
        base.multiActions = normalizeMultiActions(raw.multiActions);
    }
    return base;
}

/**
 * Create a fresh action bar with SLOTS_PER_BAR logical slots.
 * @param {string} id
 * @param {number} [_slotCount] ignored — always SLOTS_PER_BAR (kept for call-site compat)
 * @param {string[]} [defaultHotkeys]
 * @param {'horizontal'|'vertical'} [orientation]
 * @returns {ActionBar}
 */
function createBar(id, _slotCount, defaultHotkeys, orientation) {
    const keys = Array.isArray(defaultHotkeys) ? defaultHotkeys : [];
    const slots = [];
    for (let i = 0; i < SLOTS_PER_BAR; i++) {
        slots.push(createEmptySlot(id, i, keys[i] || ''));
    }
    return {
        id,
        orientation: orientation === 'vertical' ? 'vertical' : 'horizontal',
        slots,
        pageOffset: 0,
        locked: false
    };
}

/**
 * Normalize one bar; pad slots to SLOTS_PER_BAR preserving leading assignments.
 * @param {object|null|undefined} raw
 * @param {string} area
 * @param {number} barIndex1Based
 * @returns {ActionBar}
 */
function normalizeBar(raw, area, barIndex1Based) {
    const orientation = orientationForArea(area);
    const id = (raw && raw.id != null && String(raw.id).trim() !== '')
        ? String(raw.id)
        : `${area}_${barIndex1Based}`;
    const defaultKeys = defaultHotkeysFor(area, barIndex1Based);
    const rawSlots = (raw && Array.isArray(raw.slots)) ? raw.slots : [];
    const slots = [];
    for (let i = 0; i < SLOTS_PER_BAR; i++) {
        if (rawSlots[i]) {
            slots.push(normalizeSlot(rawSlots[i], id, i));
        } else {
            // Pad only: keep classic default hotkeys on empty trailing slots of bar 1
            slots.push(createEmptySlot(id, i, defaultKeys[i] || ''));
        }
    }
    const resolvedOrientation = (raw && raw.orientation === 'vertical')
        ? 'vertical'
        : (raw && raw.orientation === 'horizontal')
            ? 'horizontal'
            : orientation;
    const cap = resolvedOrientation === 'vertical' ? VISIBLE_CAP_VERTICAL : VISIBLE_CAP_HORIZONTAL;
    const maxOff = Math.max(0, SLOTS_PER_BAR - cap);
    let pageOffset = 0;
    if (raw && raw.pageOffset != null && Number.isFinite(Number(raw.pageOffset))) {
        pageOffset = Math.max(0, Math.min(maxOff, Math.floor(Number(raw.pageOffset))));
    }
    return {
        id,
        orientation: resolvedOrientation,
        slots,
        pageOffset,
        locked: !!(raw && raw.locked)
    };
}

/**
 * Build docks for the given layout counts (empty bars with defaults).
 * @param {LayoutCounts|null|undefined} [layoutCounts]
 * @returns {Record<string, ActionBar[]>}
 */
function initDefaultDocksData(layoutCounts) {
    const counts = layoutCounts || state.layoutCounts || defaultLayoutCounts();
    return normalizeDocks(null, counts);
}

/**
 * Coerce docks to current schema: fixed bar counts and SLOTS_PER_BAR per bar.
 * @param {object|null|undefined} rawDocks
 * @param {LayoutCounts} layoutCounts
 * @returns {Record<string, ActionBar[]>}
 */
function normalizeDocks(rawDocks, layoutCounts) {
    const counts = layoutCounts || defaultLayoutCounts();
    /** @type {Record<string, ActionBar[]>} */
    const docks = {};
    for (let a = 0; a < DOCK_AREAS.length; a++) {
        const area = DOCK_AREAS[a];
        const n = counts[area];
        const rawBars = (rawDocks && Array.isArray(rawDocks[area])) ? rawDocks[area] : [];
        /** @type {ActionBar[]} */
        const bars = [];
        for (let i = 0; i < n; i++) {
            bars.push(normalizeBar(rawBars[i] || null, area, i + 1));
        }
        docks[area] = bars;
    }
    return docks;
}

/**
 * Coerce barStash entries to current bar shape (drop junk).
 * @param {object|null|undefined} rawStashRoot
 * @returns {Record<string, Record<string, ActionBar[]>>}
 */
function normalizeBarStash(rawStashRoot) {
    /** @type {Record<string, Record<string, ActionBar[]>>} */
    const out = {};
    if (!rawStashRoot || typeof rawStashRoot !== 'object') return out;
    const pids = Object.keys(rawStashRoot);
    for (let p = 0; p < pids.length; p++) {
        const pid = pids[p];
        const areaMap = rawStashRoot[pid];
        if (!areaMap || typeof areaMap !== 'object') continue;
        /** @type {Record<string, ActionBar[]>} */
        const cleaned = {};
        for (let a = 0; a < DOCK_AREAS.length; a++) {
            const area = DOCK_AREAS[a];
            const list = areaMap[area];
            if (!Array.isArray(list) || !list.length) continue;
            cleaned[area] = list.map((bar, i) => normalizeBar(bar, area, i + 1));
        }
        if (Object.keys(cleaned).length) out[pid] = cleaned;
    }
    return out;
}

/**
 * Resolve default profile ID from active player class or fallback to guardian.
 * @returns {string}
 */
function getDefaultProfileId() {
    if (typeof state.getActivePlayer === 'function') {
        const p = state.getActivePlayer();
        if (p) {
            const cid = p.classId != null ? String(p.classId) : (p.vocation != null ? String(p.vocation) : null);
            if (cid && typeof cid === 'string' && cid !== 'undefined' && cid.trim() !== '') {
                return cid.trim().toLowerCase();
            }
        }
    }
    return 'guardian';
}

/**
 * Reset docks and profiles to default state.
 */
function initDefaultDocks() {
    state.layoutCounts = defaultLayoutCounts();
    state.barStash = {};
    const defaultData = initDefaultDocksData(state.layoutCounts);
    const defClass = getDefaultProfileId();
    state.profiles = { [defClass]: defaultData };
    state.activeProfileId = defClass;
    state.docks = state.profiles[defClass];
}

/**
 * Persistable payload snapshot (localStorage / IndexedDB).
 * Current schema only — no versioned migrations (project not stable).
 * @returns {object}
 */
function buildStoragePayload() {
    if (state.activeProfileId) {
        state.profiles[state.activeProfileId] = state.docks;
    }
    return {
        layoutCounts: state.layoutCounts,
        profiles: state.profiles,
        activeProfileId: state.activeProfileId,
        barStash: state.barStash
    };
}

/**
 * Coerce a prefs blob to the current in-memory schema (no multi-version migration).
 * @param {object|null|undefined} parsed
 * @returns {{ layoutCounts: LayoutCounts, profiles: Record<string, Record<string, ActionBar[]>>, activeProfileId: string, barStash: Record<string, Record<string, ActionBar[]>> }|null}
 */
function coerceStoredPayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || !parsed.profiles || typeof parsed.profiles !== 'object') {
        return null;
    }
    const layoutCounts = normalizeLayoutCounts(parsed.layoutCounts);
    let activeProfileId = (typeof parsed.activeProfileId === 'string' && parsed.activeProfileId.trim() !== '' &&
        parsed.activeProfileId !== 'undefined')
        ? parsed.activeProfileId.trim().toLowerCase()
        : getDefaultProfileId();

    /** @type {Record<string, Record<string, ActionBar[]>>} */
    const profiles = {};
    const pids = Object.keys(parsed.profiles);
    for (let i = 0; i < pids.length; i++) {
        const pid = pids[i];
        if (!pid || pid === 'undefined') continue;
        profiles[pid] = normalizeDocks(parsed.profiles[pid], layoutCounts);
    }
    if (!profiles[activeProfileId]) {
        const keys = Object.keys(profiles);
        if (keys.length) activeProfileId = keys[0];
        else profiles[activeProfileId] = initDefaultDocksData(layoutCounts);
    }

    return {
        layoutCounts,
        profiles,
        activeProfileId,
        barStash: normalizeBarStash(parsed.barStash)
    };
}

/**
 * Apply a storage payload into live state.
 * @param {object|null|undefined} payload
 * @returns {boolean}
 */
function applyStoredPayload(payload) {
    const coerced = coerceStoredPayload(payload);
    if (!coerced) return false;
    state.layoutCounts = coerced.layoutCounts;
    state.profiles = coerced.profiles;
    state.activeProfileId = coerced.activeProfileId;
    state.barStash = coerced.barStash;
    state.docks = state.profiles[state.activeProfileId];
    return true;
}

/** @deprecated use applyStoredPayload */
function applyNormalizedPayload(payload) {
    return applyStoredPayload(payload);
}

/**
 * Ensure barStash buckets exist for a profile.
 * @param {string} profileId
 * @returns {Record<string, ActionBar[]>}
 */
function ensureProfileStash(profileId) {
    const pid = profileId || state.activeProfileId || 'guardian';
    if (!state.barStash[pid]) {
        state.barStash[pid] = { top: [], bottom: [], left: [], right: [] };
    }
    const stash = state.barStash[pid];
    for (let a = 0; a < DOCK_AREAS.length; a++) {
        const area = DOCK_AREAS[a];
        if (!Array.isArray(stash[area])) stash[area] = [];
    }
    return stash;
}

/**
 * Resize one docks object to match layoutCounts, stashing excess bars.
 * @param {string} profileId
 * @param {Record<string, ActionBar[]>} docks
 * @param {LayoutCounts} counts
 */
function applyLayoutCountsToDocks(profileId, docks, counts) {
    const stash = ensureProfileStash(profileId);
    for (let a = 0; a < DOCK_AREAS.length; a++) {
        const area = DOCK_AREAS[a];
        const n = counts[area];
        if (!Array.isArray(docks[area])) docks[area] = [];
        if (!Array.isArray(stash[area])) stash[area] = [];
        while (docks[area].length > n) {
            const removed = docks[area].pop();
            if (removed) stash[area].unshift(removed);
        }
        while (docks[area].length < n) {
            if (stash[area].length > 0) {
                docks[area].push(/** @type {ActionBar} */ (stash[area].shift()));
            } else {
                const idx = docks[area].length + 1;
                docks[area].push(createBar(
                    `${area}_${idx}`,
                    SLOTS_PER_BAR,
                    defaultHotkeysFor(area, idx),
                    orientationForArea(area)
                ));
            }
        }
        // Keep bar ids stable for newly created bars
        for (let i = 0; i < docks[area].length; i++) {
            const bar = docks[area][i];
            if (!bar.id) bar.id = `${area}_${i + 1}`;
            if (!Array.isArray(bar.slots) || bar.slots.length !== SLOTS_PER_BAR) {
                docks[area][i] = normalizeBar(bar, area, i + 1);
            }
        }
    }
}

/**
 * Set toolbars-per-dock counts (0–3). Preserves hidden bars in barStash.
 * @param {Partial<LayoutCounts>} partial
 * @param {{ remount?: boolean }} [opts]
 * @returns {LayoutCounts}
 */
function setLayoutCounts(partial, opts) {
    const next = normalizeLayoutCounts(Object.assign({}, state.layoutCounts, partial || {}));
    if (state.activeProfileId) {
        state.profiles[state.activeProfileId] = state.docks;
    }
    state.layoutCounts = next;
    const pids = Object.keys(state.profiles);
    for (let i = 0; i < pids.length; i++) {
        const pid = pids[i];
        applyLayoutCountsToDocks(pid, state.profiles[pid], next);
    }
    state.docks = state.profiles[state.activeProfileId] || state.docks;
    rebuildMaps();
    saveToStorage();
    const remount = !opts || opts.remount !== false;
    if (remount && typeof document !== 'undefined' && typeof window !== 'undefined') {
        mountDocks();
        state.lastSignatures.clear();
        if (typeof updateActionBars === 'function') updateActionBars();
    }
    return {
        top: state.layoutCounts.top,
        bottom: state.layoutCounts.bottom,
        left: state.layoutCounts.left,
        right: state.layoutCounts.right
    };
}

/**
 * Re-index all slots for rapid lookup by ID and normalized hotkey.
 */
function rebuildMaps() {
    state.hotkeysMap.clear();
    state.slotsById.clear();
    const areas = Object.keys(state.docks);
    for (let i = 0; i < areas.length; i++) {
        const bars = state.docks[areas[i]];
        if (!Array.isArray(bars)) continue;
        for (let j = 0; j < bars.length; j++) {
            const bar = bars[j];
            for (let k = 0; k < bar.slots.length; k++) {
                const slot = bar.slots[k];
                state.slotsById.set(slot.id, slot);
                if (slot.hotkey) {
                    state.hotkeysMap.set(normalizeHotkey(slot.hotkey), slot.id);
                }
            }
        }
    }
}

/**
 * Switch active action bars profile (vocation / class).
 * @param {string} profileId
 * @returns {boolean}
 */
function switchProfile(profileId) {
    const rawPid = (profileId != null && String(profileId).trim() !== '') ? String(profileId).trim().toLowerCase() : '';
    const pid = (rawPid && rawPid !== 'default' && rawPid !== 'undefined') ? rawPid : getDefaultProfileId();
    if (pid === state.activeProfileId) return false;
    if (state.activeProfileId) {
        state.profiles[state.activeProfileId] = state.docks;
    }
    state.activeProfileId = pid;
    if (typeof loadGeneralHotkeys === 'function') loadGeneralHotkeys(pid);
    if (!state.profiles[pid]) {
        state.profiles[pid] = initDefaultDocksData(state.layoutCounts);
    } else {
        applyLayoutCountsToDocks(pid, state.profiles[pid], state.layoutCounts);
    }
    state.docks = state.profiles[pid];
    rebuildMaps();
    saveToStorage();
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
        if (typeof mountDocks === 'function') mountDocks();
        if (typeof updateActionBars === 'function') {
            state.lastSignatures.clear();
            updateActionBars();
        }
    }
    if (typeof state.onProfileChange === 'function') {
        state.onProfileChange(pid);
    }
    return true;
}

/**
 * Check if a hotkey is already assigned to a slot in the current profile.
 * @param {string} hotkey
 * @param {string} [excludeSlotId]
 * @returns {ActionBarSlot|null}
 */
function checkHotkeyConflict(hotkey, excludeSlotId) {
    const norm = normalizeHotkey(hotkey);
    if (!norm) return null;
    const existingSlotId = state.hotkeysMap.get(norm);
    if (existingSlotId && existingSlotId !== excludeSlotId) {
        return state.slotsById.get(existingSlotId) || null;
    }
    return null;
}

/**
 * Persist profiles to the canonical localStorage key.
 * Also kicks the debounced IndexedDB prefs saver.
 */
function saveToStorage() {
    if (state.debouncedIdbSaver) {
        state.debouncedIdbSaver();
    }
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        window.localStorage.setItem(LS_KEY, JSON.stringify(buildStoragePayload()));
    } catch (_) {}
}

/**
 * Load action-bar prefs from the canonical key only (current schema).
 * Corrupt or missing blobs keep the in-memory defaults from initDefaultDocks.
 */
function loadFromStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        applyStoredPayload(parsed);
    } catch (_) {}
}

/**
 * Find a spell entry for a rune item id (or direct spell id).
 * @param {string} itemId
 * @param {Record<string, object>|object[]|null|undefined} spellBook
 * @returns {object|null}
 */
function findSpellForItemId(itemId, spellBook) {
    if (!itemId || !spellBook) return null;
    const direct = lookupSpell(itemId, spellBook);
    if (direct) return direct;
    if (Array.isArray(spellBook)) {
        for (let i = 0; i < spellBook.length; i++) {
            const s = spellBook[i];
            if (!s) continue;
            if (String(s.source || '').toLowerCase() === 'rune' &&
                (s.runeItemId === itemId || s.id === itemId)) {
                return s;
            }
        }
        return null;
    }
    const ids = Object.keys(spellBook);
    for (let i = 0; i < ids.length; i++) {
        const s = spellBook[ids[i]];
        if (!s) continue;
        if (String(s.source || '').toLowerCase() === 'rune' &&
            (s.runeItemId === itemId || s.id === itemId)) {
            return s;
        }
    }
    return null;
}

/**
 * Mana cost from a spell catalog entry (if present).
 * @param {object|null|undefined} spell
 * @returns {number|null}
 */
function getSpellManaCost(spell) {
    if (!spell) return null;
    const raw = spell.mana != null ? spell.mana : spell.manaCost != null ? spell.manaCost : spell.cost;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Cooldown spec for a multi-action sub-slot (spell / item only).
 * @param {ActionBarSubSlot|null|undefined} sub
 * @param {Record<string, object>|object[]|null|undefined} spellBook
 * @param {object|null|undefined} itemDb
 * @returns {object|null}
 */
function resolveSubActionCooldownSpec(sub, spellBook, itemDb) {
    if (!sub || sub.actionType === 'empty' || sub.actionType === 'text') return null;
    if (sub.actionType === 'spell' && sub.spellId) {
        const sp = lookupSpell(sub.spellId, spellBook);
        return (sp && sp.cooldowns) || null;
    }
    if (sub.actionType === 'item' && sub.itemId) {
        const runeSpell = findSpellForItemId(sub.itemId, spellBook);
        if (runeSpell && runeSpell.cooldowns) return runeSpell.cooldowns;
        const item = findItem(itemDb, sub.itemId);
        if (item && item.cooldowns) return item.cooldowns;
        return null;
    }
    return null;
}

/**
 * Engine equipment slot holding `itemId`, or null.
 * @param {object|null|undefined} inv
 * @param {string} itemId
 * @returns {string|null}
 */
function findEquippedSlotForItemId(inv, itemId) {
    if (!inv || !inv.equipment || !inv.items || itemId == null || itemId === '') return null;
    const want = String(itemId);
    const slots = inv.equipment;
    for (const slot of Object.keys(slots)) {
        const uid = slots[slot];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (inst && String(inst.itemId) === want) return slot;
    }
    return null;
}

/**
 * First backpack-tree instance uid for `itemId` (BFS, same order as consume).
 * @param {object|null|undefined} inv
 * @param {string} itemId
 * @returns {string|null}
 */
function findFirstContainerUidForItemId(inv, itemId) {
    if (!inv || !inv.items || !inv.containers || itemId == null || itemId === '') return null;
    const want = String(itemId);
    const start = inv.rootUid;
    if (!start) return null;
    /** @type {string[]} */
    const queue = [start];
    /** @type {Set<string>} */
    const seen = new Set();
    while (queue.length) {
        const cuid = queue.shift();
        if (!cuid || seen.has(cuid)) continue;
        seen.add(cuid);
        const cont = inv.containers[cuid];
        if (!cont || !Array.isArray(cont.slots)) continue;
        for (let i = 0; i < cont.slots.length; i++) {
            const uid = cont.slots[i];
            if (!uid) continue;
            const inst = inv.items[uid];
            if (!inst) continue;
            if (String(inst.itemId) === want) return uid;
            if (inv.containers[uid]) queue.push(uid);
        }
    }
    return null;
}

/**
 * Stack count of `itemId` in backpack tree **plus** equipped slots (action-bar gear badge).
 * @param {object|null|undefined} inv
 * @param {string} itemId
 * @returns {number}
 */
function countItemIdCarried(inv, itemId) {
    let total = countItemIdInInventoryTree(inv, itemId);
    if (!inv || !inv.equipment || !inv.items || itemId == null || itemId === '') return total;
    const want = String(itemId);
    const slots = inv.equipment;
    for (const slot of Object.keys(slots)) {
        const uid = slots[slot];
        if (!uid) continue;
        const inst = inv.items[uid];
        if (inst && String(inst.itemId) === want) {
            total += getStackCount(inst);
        }
    }
    return total;
}

/**
 * Whether a catalog item should toggle equip from the action bar (legacy Equip use type).
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemIsActionBarEquipable(item) {
    if (!itemIsEquipable(item)) return false;
    // Prefer explicit preferred slot so free-form `slot` alone is not enough without mapping.
    return preferredEquipSlot(item) != null;
}

/**
 * Toggle equip/unequip by template id (legacy `g_game.equipItemId` parity).
 * Equipped matching instance → unequip into backpack; else equip first backpack match.
 * @param {object} player
 * @param {string} itemId
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @returns {{ ok: boolean, error?: string, action?: 'equip'|'unequip', slot?: string|null }}
 */
function toggleEquipByItemId(player, itemId, itemDb) {
    if (!player || !itemId) return { ok: false, error: 'bad_args' };
    const inv = player.inventory;
    if (!isRuntimeInventory(inv)) return { ok: false, error: 'no_inventory' };
    const id = String(itemId);
    const eqSlot = findEquippedSlotForItemId(inv, id);
    if (eqSlot) {
        const r = unequipItem(inv, eqSlot, itemDb, { containerUid: inv.rootUid });
        if (!r.ok) return { ok: false, error: r.error || 'unequip_failed', action: 'unequip', slot: eqSlot };
        return { ok: true, action: 'unequip', slot: eqSlot };
    }
    const uid = findFirstContainerUidForItemId(inv, id);
    if (!uid) return { ok: false, error: 'not_found' };
    const r = equipItem(inv, uid, itemDb);
    if (!r.ok) return { ok: false, error: r.error || 'equip_failed', action: 'equip' };
    return { ok: true, action: 'equip', slot: findEquippedSlotForItemId(inv, id) };
}

/**
 * Whether a multi sub-action is ready to fire (CD, inventory count, mana when known).
 * @param {ActionBarSubSlot|null|undefined} sub
 * @param {{ player?: object|null, spellBook?: object|object[]|null, itemDb?: object|null }} [ctx]
 * @returns {boolean}
 */
function isSubActionAvailable(sub, ctx) {
    if (!sub || sub.actionType === 'empty') return false;
    const player = ctx && ctx.player ? ctx.player : null;
    const spellBook = ctx && ctx.spellBook != null ? ctx.spellBook : null;
    const itemDb = ctx && ctx.itemDb != null ? ctx.itemDb : null;

    if (sub.actionType === 'text') {
        return !!(sub.text && String(sub.text).trim());
    }

    if (sub.actionType === 'spell' && sub.spellId) {
        const spec = resolveSubActionCooldownSpec(sub, spellBook, itemDb);
        if (player && !Cooldowns.canUse(player, spec)) return false;
        if (player && player.mp && typeof player.mp === 'object') {
            const sp = lookupSpell(sub.spellId, spellBook);
            const cost = getSpellManaCost(sp);
            if (cost != null) {
                const cur = Number(player.mp.current);
                if (Number.isFinite(cur) && cur < cost) return false;
            }
        }
        return true;
    }

    if (sub.actionType === 'item' && sub.itemId) {
        if (player && player.inventory) {
            // Gear may only be equipped (not in backpack tree) — still available to toggle.
            const item = findItem(itemDb, sub.itemId);
            const count = itemIsActionBarEquipable(item)
                ? countItemIdCarried(player.inventory, sub.itemId)
                : countItemIdInInventoryTree(player.inventory, sub.itemId);
            if (count <= 0) return false;
        }
        // Equipable gear has no combat CD gate for toggle (legacy equip packet is free).
        if (itemIsActionBarEquipable(findItem(itemDb, sub.itemId))) return true;
        const spec = resolveSubActionCooldownSpec(sub, spellBook, itemDb);
        if (player && !Cooldowns.canUse(player, spec)) return false;
        return true;
    }

    return false;
}

/**
 * First ready multi sub-index; if none ready, first non-empty (for icon/CD paint); else -1.
 * Skips empty middle slots. Legacy-style `findNextAvailableAction`.
 * @param {ActionBarSlot|null|undefined} slot
 * @param {{ player?: object|null, spellBook?: object|object[]|null, itemDb?: object|null }} [ctx]
 * @returns {number}
 */
function findNextAvailableMultiIndex(slot, ctx) {
    if (!slot || slot.actionType !== 'multi' || !Array.isArray(slot.multiActions)) return -1;
    const multi = slot.multiActions;
    let firstFilled = -1;
    for (let i = 0; i < multi.length; i++) {
        const sub = multi[i];
        if (!sub || sub.actionType === 'empty') continue;
        if (sub.actionType === 'spell' && !sub.spellId) continue;
        if (sub.actionType === 'item' && !sub.itemId) continue;
        if (sub.actionType === 'text' && !(sub.text && String(sub.text).trim())) continue;
        if (firstFilled < 0) firstFilled = i;
        if (isSubActionAvailable(sub, ctx)) return i;
    }
    return firstFilled;
}

/**
 * Active multi sub-action for paint / execute (may be on CD when nothing is ready).
 * @param {ActionBarSlot|null|undefined} slot
 * @param {{ player?: object|null, spellBook?: object|object[]|null, itemDb?: object|null }} [ctx]
 * @returns {{ index: number, sub: ActionBarSubSlot }|null}
 */
function getActiveMultiSubAction(slot, ctx) {
    const idx = findNextAvailableMultiIndex(slot, ctx);
    if (idx < 0 || !slot || !Array.isArray(slot.multiActions)) return null;
    const sub = slot.multiActions[idx];
    if (!sub) return null;
    return { index: idx, sub };
}

/**
 * Build a pseudo slot so multi sub-actions reuse item/spell/text executors.
 * @param {ActionBarSlot} parent
 * @param {ActionBarSubSlot} sub
 * @returns {ActionBarSlot}
 */
function multiSubAsSlot(parent, sub) {
    return {
        id: parent.id,
        index: parent.index,
        hotkey: parent.hotkey || '',
        actionType: sub.actionType,
        itemId: sub.itemId || null,
        spellId: sub.spellId || null,
        command: null,
        text: sub.text || null,
        passiveId: null,
        multiActions: null,
        targetMode: (sub.targetMode && VALID_TARGET_MODES.has(sub.targetMode))
            ? sub.targetMode
            : 'smart_target'
    };
}

/**
 * Resolve the combat cooldown spec for a bar slot (spell, rune item, or item.use).
 * Shared primary/group keys make related slots show overlay together.
 * Multi slots resolve the active (rotation) sub-action.
 * @param {ActionBarSlot} slot
 * @param {Record<string, object>|object[]|null|undefined} spellBook
 * @param {object|null|undefined} itemDb
 * @param {object|null|undefined} [player] used for multi rotation
 * @returns {object|null}
 */
function resolveSlotCooldownSpec(slot, spellBook, itemDb, player) {
    if (!slot || slot.actionType === 'empty' || slot.actionType === 'command' ||
        slot.actionType === 'text' || slot.actionType === 'passive') {
        return null;
    }
    if (slot.actionType === 'multi') {
        const active = getActiveMultiSubAction(slot, { player: player || null, spellBook, itemDb });
        if (!active) return null;
        return resolveSubActionCooldownSpec(active.sub, spellBook, itemDb);
    }
    if (slot.actionType === 'spell' && slot.spellId) {
        const sp = lookupSpell(slot.spellId, spellBook);
        return (sp && sp.cooldowns) || null;
    }
    if (slot.actionType === 'item' && slot.itemId) {
        const runeSpell = findSpellForItemId(slot.itemId, spellBook);
        if (runeSpell && runeSpell.cooldowns) return runeSpell.cooldowns;
        const item = findItem(itemDb, slot.itemId);
        if (item && item.cooldowns) return item.cooldowns;
        return null;
    }
    return null;
}

/**
 * Max remaining seconds across every bucket key listed in a cooldown spec.
 * @param {object|null|undefined} entity
 * @param {object|null|undefined} spec
 * @returns {number}
 */
function getSpecRemainingSeconds(entity, spec) {
    return getSpecCooldownDisplay(entity, spec).remaining;
}

/**
 * Remaining time + progress for the longest-blocking key in a cooldown spec.
 * Progress matches legacy UIProgressRect: 0% at cast (full cover) → 100% when ready.
 * Duration comes from the slot's own spec for the blocking key (shared primary/group).
 * @param {object|null|undefined} entity
 * @param {object|null|undefined} spec
 * @returns {{ remaining: number, duration: number, progress: number }}
 */
function getSpecCooldownDisplay(entity, spec) {
    if (!entity || !spec || typeof spec !== 'object') {
        return { remaining: 0, duration: 0, progress: 100 };
    }
    let maxRem = 0;
    let maxDur = 0;
    const buckets = Cooldowns.BUCKETS || ['auto', 'primary', 'secondary', 'spell', 'item'];
    for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        const names = Object.keys(keys);
        for (let k = 0; k < names.length; k++) {
            const name = names[k];
            const rem = Cooldowns.getRemaining(entity, bucket, name);
            if (rem > maxRem) {
                maxRem = rem;
                maxDur = Number(keys[name]) || 0;
            }
        }
    }
    if (maxRem <= 0) return { remaining: 0, duration: maxDur, progress: 100 };
    // Shared bucket may outlast this slot's listed duration — keep full cover until catch-up
    if (maxRem > maxDur) maxDur = maxRem;
    const progress = maxDur > 0
        ? Math.min(100, Math.max(0, ((maxDur - maxRem) / maxDur) * 100))
        : 100;
    return { remaining: maxRem, duration: maxDur, progress };
}

/**
 * Format remaining cooldown for action-bar timer text (legacy client parity).
 * ≥10s → "12s"; ≥1s → "1.5s"; else → "0.25s".
 * @param {number} remainingSec
 * @returns {string}
 */
function formatCooldownTimer(remainingSec) {
    const rem = Number(remainingSec) || 0;
    if (rem <= 0) return '';
    // Match UIProgressRect: round remaining ms to seconds display units
    const seconds = Math.round(rem * 1000) / 1000;
    if (seconds >= 10) return `${Math.round(seconds)}s`;
    if (seconds >= 1) return `${seconds.toFixed(1)}s`;
    return `${seconds.toFixed(2)}s`;
}

/**
 * Resolve a spell id against the active spell book map.
 * @param {string} spellId
 * @param {Record<string, object>|object[]|null|undefined} spellBook
 * @returns {object|null}
 */
function lookupSpell(spellId, spellBook) {
    if (!spellId || !spellBook) return null;
    if (!Array.isArray(spellBook) && spellBook[spellId]) return spellBook[spellId];
    if (Array.isArray(spellBook)) {
        for (let i = 0; i < spellBook.length; i++) {
            if (spellBook[i] && spellBook[i].id === spellId) return spellBook[i];
        }
    }
    return null;
}

/**
 * Healing and caster-centered AoE always resolve on the player (no smart-cast self-harm).
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function spellCastsOnSelfByDefault(spell) {
    if (!spell) return false;
    if (String(spell.element || '').toLowerCase() === 'healing') return true;
    if (isSelfCenteredAreaSpell(spell)) return true;
    // Support buffs (haste / invisible) and other self-only utility
    if (spell.requiresTarget === false && !spellHasShape(spell)) return true;
    if (spell.kind === 'support' && spell.requiresTarget === false) return true;
    return false;
}

/**
 * Whether smart-cast requires a selected combat target (strikes, ranged-area centers).
 * Waves/beams aim from the caster and may fire without a target.
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function spellRequiresSelectedTarget(spell) {
    if (spellCastsOnSelfByDefault(spell)) return false;
    if (!spell) return true;
    if (spellHasShape(spell)) {
        const t = String(spell.shape.type || '');
        if (t === 'wave' || t === 'beam') return false;
        // Ranged area (e.g. field/bomb style) needs an aim point or entity
        return true;
    }
    return true;
}

/**
 * Whether crosshair aim may resolve on an empty map tile (vs creature-only).
 * Shaped / area runes & spells → tile OK; single-target bolts → entity only;
 * tools / unknown multi-use (no spell) → tile OK (holes, fields, use-with).
 *
 * @param {object} [opts]
 * @param {string} [opts.itemId]
 * @param {string} [opts.spellId]
 * @param {Record<string, object>|object[]|null|undefined} [opts.spellBook]
 * @returns {boolean}
 */
function resolveAllowTileAim(opts) {
    const o = opts || {};
    let spell = null;
    if (o.spellId) {
        spell = lookupSpell(o.spellId, o.spellBook);
    }
    if (!spell && o.itemId) {
        spell = findSpellForItemId(o.itemId, o.spellBook);
    }
    if (spell) {
        return spellHasShape(spell);
    }
    // Rope/shovel/etc. multi-use: aim at a tile
    return true;
}

/**
 * Enter use-with / cast crosshair with correct tile-vs-entity policy.
 * @param {{ type: string, sourceUid?: string, itemId?: string, spellId?: string, allowTileAim?: boolean }} cursor
 * @param {{ spellBook?: object|object[]|null }} [opts]
 */
function enterActionCursor(cursor, opts) {
    const c = cursor && typeof cursor === 'object' ? Object.assign({}, cursor) : {};
    if (c.allowTileAim === undefined) {
        c.allowTileAim = resolveAllowTileAim({
            itemId: c.itemId,
            spellId: c.spellId,
            spellBook: opts && opts.spellBook
        });
    }
    enterTargetCursorMode(c);
}

/**
 * Execute action assigned to a slot.
 * @param {ActionBarSlot} slot
 * @param {object} [opts] optional execution context overrides
 */
function executeSlot(slot, opts) {
    if (!slot || slot.actionType === 'empty') return;
    const player = (opts && opts.player) || (state.getActivePlayer ? state.getActivePlayer() : null);
    if (!player || player.alive === false) return;
    // Action bars only drive manual control; ignore AI-controlled members.
    if (String(player.controlMode || 'ai') !== 'manual') return;
    if (!Array.isArray(player.commandQueue)) player.commandQueue = [];

    if (slot.actionType === 'item' && slot.itemId) {
        const itemDb = (opts && opts.itemDb) || (state.getItemDb ? state.getItemDb() : null);
        const item = findItem(itemDb, slot.itemId);

        // Equipable gear: toggle equip / unequip (legacy UseTypes.Equip → equipItemId).
        if (itemIsActionBarEquipable(item)) {
            const r = toggleEquipByItemId(player, slot.itemId, itemDb);
            if (r.ok) {
                if (typeof player.applyInventoryMutation === 'function') {
                    player.applyInventoryMutation();
                }
            } else if (r.error === 'full' || r.error === 'no_room') {
                const sim =
                    (opts && opts.sim) ||
                    (state.getSimulator ? state.getSimulator() : null) ||
                    (player.level || null);
                emitActionBarFloat(player, 'There are no room', '#f59e0b', sim);
            }
            // not_found / no_inventory: silent like legacy zero-count guard
            return;
        }

        const isMulti = itemIsMultiUse(item) || (item && String(item.type).toLowerCase() === 'rune');
        // Smart Cast + Active Target both fire on the selected combat target.
        // Smart Cast maximizes AoE hits; Active Target pins the blast center.
        const usesActiveTarget =
            slot.targetMode === 'smart_target' ||
            slot.targetMode === 'active_target';

        if (usesActiveTarget && isMulti) {
            if (player.target && player.target.id != null && player.target.alive !== false) {
                /** @type {{ type: string, itemId: string, target: object, centerMode?: string }} */
                const cmd = {
                    type: 'USE_ITEM_WITH',
                    itemId: slot.itemId,
                    target: { kind: 'entity', id: player.target.id }
                };
                // Ranged area runes honor this in resolveAreaCenter.
                cmd.centerMode =
                    slot.targetMode === 'active_target' ? 'primary' : 'maximize';
                player.commandQueue.push(cmd);
                return;
            }
        }

        if (slot.targetMode === 'cursor_prompt' || (isMulti && slot.targetMode !== 'self')) {
            enterActionCursor(
                { type: 'USE_ITEM_WITH', itemId: slot.itemId },
                {
                    spellBook:
                        (opts && opts.spellBook) ||
                        (state.getSpellBook ? state.getSpellBook() : null)
                }
            );
            return;
        }

        player.commandQueue.push({
            type: 'USE_ITEM',
            itemId: slot.itemId,
            target: { kind: 'self' }
        });
        return;
    }

    if (slot.actionType === 'spell' && slot.spellId) {
        const spellBook =
            (opts && opts.spellBook) ||
            (state.getSpellBook ? state.getSpellBook() : null);
        const spell = lookupSpell(slot.spellId, spellBook);
        const hasTarget =
            player.target &&
            player.target.id != null &&
            player.target.alive !== false;

        // Healing + self-centered AoE always cast on the character (ignore smart-cast aim).
        if (spellCastsOnSelfByDefault(spell) || slot.targetMode === 'self') {
            player.commandQueue.push({
                type: 'CAST_SPELL',
                spellId: slot.spellId,
                target: { kind: 'self' }
            });
            return;
        }

        if (slot.targetMode === 'cursor_prompt') {
            enterActionCursor(
                { type: 'CAST_SPELL', spellId: slot.spellId },
                { spellBook }
            );
            return;
        }

        // smart_target / active_target: only fire when a combat target is selected.
        // Do NOT fall through to self — that self-damaged fireballs/strikes.
        // Smart Cast → maximize AoE hits; Active Target → pin center on target.
        if (hasTarget) {
            /** @type {{ type: string, spellId: string, target: object, centerMode?: string }} */
            const cmd = {
                type: 'CAST_SPELL',
                spellId: slot.spellId,
                target: { kind: 'entity', id: player.target.id }
            };
            cmd.centerMode =
                slot.targetMode === 'active_target' ? 'primary' : 'maximize';
            player.commandQueue.push(cmd);
            return;
        }

        if (spellRequiresSelectedTarget(spell)) {
            return;
        }

        // Waves/beams without a target: cast relative to the character (default facing).
        player.commandQueue.push({
            type: 'CAST_SPELL',
            spellId: slot.spellId,
            target: { kind: 'self' }
        });
        return;
    }

    if (slot.actionType === 'command' && slot.command) {
        const cmdStr = String(slot.command).toLowerCase().trim();
        if (cmdStr === 'auto_chase' || cmdStr === 'chase') {
            player.commandQueue.push({ type: 'SET_AUTO_CHASE' });
        } else if (cmdStr === 'stop') {
            player.commandQueue.push({ type: 'STOP_AUTOWALK' });
        } else if (cmdStr === 'heal_friend' || cmdStr.startsWith('heal_friend ')) {
            // Macro → cast Heal Friend on current target (or entity named in free text later)
            const hasTarget =
                player.target && player.target.id != null && player.target.alive !== false;
            player.commandQueue.push({
                type: 'CUSTOM_COMMAND',
                command: slot.command,
                target: hasTarget
                    ? { kind: 'entity', id: player.target.id }
                    : undefined
            });
        } else {
            // summon_creature <id>, other free-text macros — hunt_ai.executeCustomCommand
            player.commandQueue.push({ type: 'CUSTOM_COMMAND', command: slot.command });
        }
        return;
    }

    // Text → floating combat / system text on the player (watch mode).
    if (slot.actionType === 'text' && slot.text) {
        const sim =
            (opts && opts.sim) ||
            (state.getSimulator ? state.getSimulator() : null) ||
            (player.level || null);
        emitActionBarFloat(player, slot.text, '#93c5fd', sim);
        return;
    }

    // Passive stub until combat subsystem exists.
    if (slot.actionType === 'passive') {
        const sim =
            (opts && opts.sim) ||
            (state.getSimulator ? state.getSimulator() : null) ||
            (player.level || null);
        const label = slot.passiveId ? String(slot.passiveId) : 'Passive';
        emitActionBarFloat(player, `Passive not available (${label})`, '#f59e0b', sim);
        return;
    }

    // Multi-action: rotate to first ready sub-action (spell / item / text).
    if (slot.actionType === 'multi') {
        const spellBook =
            (opts && opts.spellBook) ||
            (state.getSpellBook ? state.getSpellBook() : null);
        const itemDb =
            (opts && opts.itemDb) ||
            (state.getItemDb ? state.getItemDb() : null);
        const active = getActiveMultiSubAction(slot, { player, spellBook, itemDb });
        if (!active || !active.sub || active.sub.actionType === 'empty') return;
        // Only fire when the candidate is actually ready (skip pure CD paint fallback).
        if (!isSubActionAvailable(active.sub, { player, spellBook, itemDb })) return;
        executeSlot(multiSubAsSlot(slot, active.sub), opts);
        return;
    }
}

/**
 * Compact signature fragment for multi-action paint/dirty.
 * @param {ActionBarSubSlot[]|null|undefined} multi
 * @returns {string}
 */
function multiActionsSig(multi) {
    if (!Array.isArray(multi)) return '';
    return multi.map((s) => {
        if (!s || s.actionType === 'empty') return 'e';
        if (s.actionType === 'item') return `i:${s.itemId || ''}`;
        if (s.actionType === 'spell') return `s:${s.spellId || ''}`;
        if (s.actionType === 'text') return `t:${s.text || ''}`;
        return s.actionType;
    }).join('|');
}

/**
 * Assign an action to a slot by ID.
 * @param {string} slotId
 * @param {'empty'|'item'|'spell'|'command'|'text'|'passive'|'multi'} type
 * @param {object} [cfg]
 * @returns {boolean}
 */
function assignSlot(slotId, type, cfg) {
    const slot = state.slotsById.get(slotId);
    if (!slot) return false;
    // Stage G: locked bars block assign / edit (execute still allowed).
    if (isSlotBarLocked(slotId)) return false;
    const t = VALID_ACTION_TYPES.has(type) ? type : 'empty';
    const c = cfg || {};

    slot.actionType = t;
    slot.itemId = null;
    slot.spellId = null;
    slot.command = null;
    slot.text = null;
    slot.passiveId = null;
    slot.multiActions = null;

    if (t === 'item') {
        slot.itemId = c.itemId != null && c.itemId !== '' ? String(c.itemId) : null;
    } else if (t === 'spell') {
        slot.spellId = c.spellId != null && c.spellId !== '' ? String(c.spellId) : null;
    } else if (t === 'command') {
        slot.command = c.command != null && c.command !== '' ? String(c.command) : null;
    } else if (t === 'text') {
        slot.text = c.text != null ? String(c.text) : null;
    } else if (t === 'passive') {
        slot.passiveId = c.passiveId != null && c.passiveId !== '' ? String(c.passiveId) : null;
    } else if (t === 'multi') {
        slot.multiActions = normalizeMultiActions(c.multiActions);
    }

    if (c.targetMode && VALID_TARGET_MODES.has(c.targetMode)) {
        slot.targetMode = c.targetMode;
    }
    if (c.hotkey !== undefined) {
        const norm = normalizeHotkey(c.hotkey);
        // Clear any other slot that currently claims this hotkey (last assign wins).
        if (norm) {
            const conflictId = state.hotkeysMap.get(norm);
            if (conflictId && conflictId !== slotId) {
                const other = state.slotsById.get(conflictId);
                if (other) other.hotkey = '';
            }
        }
        slot.hotkey = norm;
    }
    rebuildMaps();
    saveToStorage();
    state.lastSignatures.delete(slotId);
    if (typeof updateActionBars === 'function') updateActionBars();
    return true;
}

/**
 * Escape string for HTML rendering.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Deps bag for in-game assign modals / context menu (Stage B).
 * @returns {import('./action_bar_modals.js').ActionBarModalDeps}
 */
function modalDeps() {
    return {
        assignSlot,
        checkHotkeyConflict,
        normalizeHotkey,
        getSpellBook: () => (state.getSpellBook ? state.getSpellBook() : null),
        getItemDb: () => (state.getItemDb ? state.getItemDb() : null),
        getActivePlayer: () => (state.getActivePlayer ? state.getActivePlayer() : null),
        getGenre: () => (state.getGenre ? state.getGenre() : 'rpg_fantasy'),
        getActiveProfileId: () => state.activeProfileId,
        getSimulator: () => (state.getSimulator ? state.getSimulator() : null),
        resolveItemSpriteUrl,
        isSlotBarLocked,
        setBarLocked,
        findBarForSlotId,
        toggleBarLocked
    };
}

/**
 * Open Stage B context menu for a slot (replaces the mega-form editor).
 * Locked bars: menu offers unlock only (no assign).
 * @param {ActionBarSlot} slot
 * @param {number} [clientX]
 * @param {number} [clientY]
 */
function showActionSlotEditorModal(slot, clientX, clientY) {
    if (!slot || typeof document === 'undefined') return;
    const x = clientX != null ? clientX : 40;
    const y = clientY != null ? clientY : 40;
    showSlotContextMenu(x, y, slot, modalDeps());
}

/**
 * Visible slot window size (carousel page length).
 * @param {ActionBar|null|undefined} bar
 * @returns {number}
 */
function visibleCapForBar(bar) {
    if (bar && bar.orientation === 'vertical') return VISIBLE_CAP_VERTICAL;
    return VISIBLE_CAP_HORIZONTAL;
}

/**
 * Max pageOffset so the window still shows `cap` slots (or all remaining).
 * @param {ActionBar|null|undefined} bar
 * @returns {number}
 */
function maxPageOffsetForBar(bar) {
    const cap = visibleCapForBar(bar);
    const n = bar && Array.isArray(bar.slots) ? bar.slots.length : SLOTS_PER_BAR;
    return Math.max(0, n - cap);
}

/**
 * Clamp bar.pageOffset in place; return the clamped value.
 * @param {ActionBar|null|undefined} bar
 * @returns {number}
 */
function clampBarPageOffset(bar) {
    if (!bar) return 0;
    const max = maxPageOffsetForBar(bar);
    let off = bar.pageOffset;
    if (off == null || !Number.isFinite(Number(off))) off = 0;
    else off = Math.floor(Number(off));
    if (off < 0) off = 0;
    if (off > max) off = max;
    bar.pageOffset = off;
    return off;
}

/**
 * Find a bar by id in the active docks.
 * @param {string} barId
 * @returns {ActionBar|null}
 */
function findBarById(barId) {
    if (!barId) return null;
    const id = String(barId);
    for (let a = 0; a < DOCK_AREAS.length; a++) {
        const bars = state.docks[DOCK_AREAS[a]];
        if (!Array.isArray(bars)) continue;
        for (let j = 0; j < bars.length; j++) {
            if (bars[j] && bars[j].id === id) return bars[j];
        }
    }
    return null;
}

/**
 * Find the bar that owns a slot id (active docks).
 * @param {string} slotId
 * @returns {ActionBar|null}
 */
function findBarForSlotId(slotId) {
    if (!slotId) return null;
    const id = String(slotId);
    // Fast path: default ids are `${barId}_slot_${index}`
    const m = /^(.+)_slot_\d+$/.exec(id);
    if (m) {
        const bar = findBarById(m[1]);
        if (bar) {
            for (let k = 0; k < bar.slots.length; k++) {
                if (bar.slots[k] && bar.slots[k].id === id) return bar;
            }
        }
    }
    for (let a = 0; a < DOCK_AREAS.length; a++) {
        const bars = state.docks[DOCK_AREAS[a]];
        if (!Array.isArray(bars)) continue;
        for (let j = 0; j < bars.length; j++) {
            const bar = bars[j];
            if (!bar || !Array.isArray(bar.slots)) continue;
            for (let k = 0; k < bar.slots.length; k++) {
                if (bar.slots[k] && bar.slots[k].id === id) return bar;
            }
        }
    }
    return null;
}

/**
 * Whether the bar that owns this slot is locked (blocks assign/edit; execute still works).
 * @param {string} slotId
 * @returns {boolean}
 */
function isSlotBarLocked(slotId) {
    const bar = findBarForSlotId(slotId);
    return !!(bar && bar.locked);
}

/**
 * Lock or unlock a bar. Locked bars block assign/edit and drops; execute/hotkey fire still work.
 * @param {string} barId
 * @param {boolean} locked
 * @param {{ remount?: boolean, save?: boolean }} [opts]
 * @returns {boolean} true if applied
 */
function setBarLocked(barId, locked, opts) {
    const bar = findBarById(barId);
    if (!bar) return false;
    const next = !!locked;
    if (bar.locked === next) {
        if (opts && opts.remount) {
            if (typeof document !== 'undefined') {
                mountDocks();
                state.lastSignatures.clear();
                if (typeof updateActionBars === 'function') updateActionBars();
            }
        }
        return true;
    }
    bar.locked = next;
    if (!opts || opts.save !== false) saveToStorage();
    const remount = !opts || opts.remount !== false;
    if (remount && typeof document !== 'undefined') {
        mountDocks();
        state.lastSignatures.clear();
        if (typeof updateActionBars === 'function') updateActionBars();
    }
    return true;
}

/**
 * Toggle bar lock.
 * @param {string} barId
 * @param {{ remount?: boolean, save?: boolean }} [opts]
 * @returns {boolean|null} new locked state, or null if bar missing
 */
function toggleBarLocked(barId, opts) {
    const bar = findBarById(barId);
    if (!bar) return null;
    setBarLocked(barId, !bar.locked, opts);
    return !!bar.locked;
}

/**
 * Clear all slot actions on a bar (assignments → empty). Keeps hotkeys by default.
 * Blocked when the bar is locked (unlock first).
 * @param {string} barId
 * @param {{ clearHotkeys?: boolean, remount?: boolean, save?: boolean }} [opts]
 * @returns {number} number of slots cleared, or -1 if bar missing / locked
 */
function clearBar(barId, opts) {
    const bar = findBarById(barId);
    if (!bar) return -1;
    if (bar.locked) return -1;
    const clearHotkeys = !!(opts && opts.clearHotkeys);
    let n = 0;
    for (let i = 0; i < bar.slots.length; i++) {
        const slot = bar.slots[i];
        if (!slot) continue;
        const hadAction = slot.actionType && slot.actionType !== 'empty';
        const hadHotkey = clearHotkeys && slot.hotkey;
        if (!hadAction && !hadHotkey) continue;
        slot.actionType = 'empty';
        slot.itemId = null;
        slot.spellId = null;
        slot.command = null;
        slot.text = null;
        slot.passiveId = null;
        slot.multiActions = null;
        slot.targetMode = 'smart_target';
        if (clearHotkeys) slot.hotkey = '';
        state.lastSignatures.delete(slot.id);
        n++;
    }
    rebuildMaps();
    if (!opts || opts.save !== false) saveToStorage();
    const remount = !opts || opts.remount !== false;
    if (remount && typeof document !== 'undefined') {
        mountDocks();
        state.lastSignatures.clear();
        if (typeof updateActionBars === 'function') updateActionBars();
    } else if (typeof updateActionBars === 'function') {
        updateActionBars();
    }
    return n;
}

/**
 * Short human label for a slot (aria / tooltips).
 * @param {ActionBarSlot} slot
 * @param {object|null|undefined} [spellBook]
 * @param {object|null|undefined} [itemDb]
 * @returns {string}
 */
function describeSlotAction(slot, spellBook, itemDb) {
    if (!slot || slot.actionType === 'empty') return 'Empty';
    if (slot.actionType === 'spell' && slot.spellId) {
        if (Array.isArray(spellBook)) {
            const sp = spellBook.find((s) => s && s.id === slot.spellId);
            if (sp && (sp.label || sp.name)) return String(sp.label || sp.name);
        } else if (spellBook && spellBook[slot.spellId]) {
            const sp = spellBook[slot.spellId];
            if (sp && (sp.label || sp.name)) return String(sp.label || sp.name);
        }
        return String(slot.spellId);
    }
    if (slot.actionType === 'item' && slot.itemId) {
        const item = findItem(itemDb, slot.itemId);
        if (item && (item.label || item.name)) return String(item.label || item.name);
        return String(slot.itemId);
    }
    if (slot.actionType === 'command' && slot.command) return `Command ${slot.command}`;
    if (slot.actionType === 'text' && slot.text) {
        const t = String(slot.text);
        return t.length > 40 ? `${t.slice(0, 40)}…` : t;
    }
    if (slot.actionType === 'passive' && slot.passiveId) return `Passive ${slot.passiveId}`;
    if (slot.actionType === 'multi') {
        const filled = Array.isArray(slot.multiActions)
            ? slot.multiActions.filter((s) => s && s.actionType !== 'empty').length
            : 0;
        return `Multi-action (${filled}/${MULTI_ACTION_DEPTH})`;
    }
    return slot.actionType || 'Empty';
}

/**
 * Accessible name for a slot button.
 * @param {ActionBarSlot} slot
 * @param {object|null|undefined} [spellBook]
 * @param {object|null|undefined} [itemDb]
 * @returns {string}
 */
function slotAriaLabel(slot, spellBook, itemDb) {
    const n = (slot && slot.index != null ? slot.index : 0) + 1;
    const action = describeSlotAction(slot, spellBook, itemDb);
    const hk = slot && slot.hotkey ? `, hotkey ${slot.hotkey}` : '';
    return `Slot ${n}: ${action}${hk}`;
}

/**
 * Native hover tooltip for a slot button (action title).
 * Empty unlocked slots omit a tooltip; locked bars append a short note.
 * @param {ActionBarSlot} slot
 * @param {object|null|undefined} [spellBook]
 * @param {object|null|undefined} [itemDb]
 * @param {{ locked?: boolean, paintType?: string, paintItemId?: string|null, paintSpellId?: string|null, paintText?: string|null }} [opts]
 * @returns {string}
 */
function slotHoverTitle(slot, spellBook, itemDb, opts) {
    const locked = !!(opts && opts.locked);
    if (!slot || slot.actionType === 'empty') {
        return locked ? 'Bar locked — execute only (unlock to edit)' : '';
    }
    let action = describeSlotAction(slot, spellBook, itemDb);
    // Multi: prefer the rotated active sub-action name when known from paint.
    if (
        slot.actionType === 'multi' &&
        opts &&
        opts.paintType &&
        opts.paintType !== 'empty' &&
        opts.paintType !== 'multi'
    ) {
        const subLabel = describeSlotAction(
            {
                actionType: opts.paintType,
                itemId: opts.paintItemId || null,
                spellId: opts.paintSpellId || null,
                text: opts.paintText || null
            },
            spellBook,
            itemDb
        );
        if (subLabel && subLabel !== 'Empty') {
            action = `${subLabel} · ${action}`;
        }
    }
    if (slot.hotkey) action += ` (${slot.hotkey})`;
    if (locked) action += ' — bar locked';
    return action;
}

/**
 * Visible index range for a bar's carousel window.
 * @param {ActionBar} bar
 * @returns {{ start: number, end: number, cap: number, maxOffset: number, offset: number }}
 */
function visibleRangeForBar(bar) {
    const cap = visibleCapForBar(bar);
    const n = bar && Array.isArray(bar.slots) ? bar.slots.length : 0;
    const maxOffset = Math.max(0, n - cap);
    const offset = clampBarPageOffset(bar);
    const start = Math.min(offset, Math.max(0, n > 0 ? n - 1 : 0));
    const end = Math.min(n, start + cap);
    return { start, end, cap, maxOffset, offset };
}

/**
 * Set carousel pageOffset for a bar (logical slots stay 50; remounts viewport).
 * @param {string} barId
 * @param {number} offset
 * @param {{ remount?: boolean, save?: boolean }} [opts]
 * @returns {number|null} clamped offset, or null if bar missing
 */
function setBarPageOffset(barId, offset, opts) {
    const bar = findBarById(barId);
    if (!bar) return null;
    bar.pageOffset = offset;
    const clamped = clampBarPageOffset(bar);
    if (!opts || opts.save !== false) saveToStorage();
    const remount = !opts || opts.remount !== false;
    if (remount && typeof document !== 'undefined' && typeof window !== 'undefined') {
        mountDocks();
        state.lastSignatures.clear();
        if (typeof updateActionBars === 'function') updateActionBars();
    }
    return clamped;
}

/**
 * Move carousel by delta steps (usually ±1). First/last use setBarPageOffset(0|max).
 * @param {string} barId
 * @param {number} delta
 * @param {{ remount?: boolean, save?: boolean }} [opts]
 * @returns {number|null}
 */
function shiftBarPage(barId, delta, opts) {
    const bar = findBarById(barId);
    if (!bar) return null;
    const cur = clampBarPageOffset(bar);
    const d = Number(delta);
    const step = Number.isFinite(d) ? Math.trunc(d) : 0;
    return setBarPageOffset(barId, cur + step, opts);
}

/**
 * @param {string} title
 * @param {string} iconClass fa-solid class without prefix
 * @param {() => void} onClick
 * @param {boolean} [disabled]
 * @returns {HTMLButtonElement}
 */
function createCarouselNavButton(title, iconClass, onClick, disabled) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'action-bar-nav-btn';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.disabled = !!disabled;
    btn.innerHTML = `<i class="fa-solid ${iconClass}" aria-hidden="true"></i>`;
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (btn.disabled) return;
        onClick();
    });
    return btn;
}

/**
 * Build first/prev or next/last cluster for a bar.
 * @param {ActionBar} bar
 * @param {'start'|'end'} side
 * @param {number} offset
 * @param {number} maxOffset
 * @param {boolean} vertical
 * @returns {HTMLElement}
 */
function createCarouselNavCluster(bar, side, offset, maxOffset, vertical) {
    const wrap = document.createElement('div');
    wrap.className = `action-bar-nav action-bar-nav--${side}`;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', side === 'start' ? 'Scroll bar earlier' : 'Scroll bar later');

    const barId = bar.id;
    if (side === 'start') {
        wrap.appendChild(createCarouselNavButton(
            'First slots',
            vertical ? 'fa-angles-up' : 'fa-angles-left',
            () => setBarPageOffset(barId, 0),
            offset <= 0
        ));
        wrap.appendChild(createCarouselNavButton(
            'Previous slot',
            vertical ? 'fa-angle-up' : 'fa-angle-left',
            () => shiftBarPage(barId, -1),
            offset <= 0
        ));
    } else {
        wrap.appendChild(createCarouselNavButton(
            'Next slot',
            vertical ? 'fa-angle-down' : 'fa-angle-right',
            () => shiftBarPage(barId, 1),
            offset >= maxOffset
        ));
        wrap.appendChild(createCarouselNavButton(
            'Last slots',
            vertical ? 'fa-angles-down' : 'fa-angles-right',
            () => setBarPageOffset(barId, maxOffset),
            offset >= maxOffset
        ));
    }
    return wrap;
}

/**
 * Mount one slot element into a bar (visible window only).
 * @param {HTMLElement} parent
 * @param {ActionBarSlot} slot
 * @param {{ locked?: boolean }} [barOpts]
 */
function mountSlotElement(parent, slot, barOpts) {
    const slotEl = document.createElement('div');
    slotEl.className = 'action-bar-slot action-bar-slot--empty';
    slotEl.id = `actionBarSlot_${slot.id}`;
    slotEl.setAttribute('data-slot-id', slot.id);
    slotEl.setAttribute('data-slot-index', String(slot.index));
    slotEl.setAttribute('role', 'button');
    slotEl.setAttribute('tabindex', '0');
    const spellBook = state.getSpellBook ? state.getSpellBook() : null;
    const itemDb = state.getItemDb ? state.getItemDb() : null;
    const locked = !!(barOpts && barOpts.locked);
    slotEl.setAttribute('aria-label', slotAriaLabel(slot, spellBook, itemDb));
    if (locked) {
        slotEl.setAttribute('aria-disabled', 'false'); // execute still allowed
    }
    const hoverTitle = slotHoverTitle(slot, spellBook, itemDb, { locked });
    if (hoverTitle) slotEl.title = hoverTitle;
    else slotEl.removeAttribute('title');
    if (slot.hotkey) slotEl.setAttribute('data-hotkey', slot.hotkey);

    slotEl.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        executeSlot(slot);
    });

    slotEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            ev.stopPropagation();
            executeSlot(slot);
        }
    });

    slotEl.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        showActionSlotEditorModal(slot, ev.clientX, ev.clientY);
    });

    parent.appendChild(slotEl);
}

/**
 * Lock toggle (+ optional tools) for a bar chrome strip.
 * @param {ActionBar} bar
 * @returns {HTMLElement}
 */
function createBarToolsCluster(bar) {
    const wrap = document.createElement('div');
    wrap.className = 'action-bar-tools';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', `Bar ${bar.id} tools`);

    const lockBtn = document.createElement('button');
    lockBtn.type = 'button';
    lockBtn.className = 'action-bar-nav-btn action-bar-lock-btn' + (bar.locked ? ' is-locked' : '');
    lockBtn.title = bar.locked ? 'Unlock bar (allow assign)' : 'Lock bar (block assign)';
    lockBtn.setAttribute('aria-label', lockBtn.title);
    lockBtn.setAttribute('aria-pressed', bar.locked ? 'true' : 'false');
    lockBtn.innerHTML = bar.locked
        ? '<i class="fa-solid fa-lock" aria-hidden="true"></i>'
        : '<i class="fa-solid fa-lock-open" aria-hidden="true"></i>';
    lockBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        toggleBarLocked(bar.id);
    });
    wrap.appendChild(lockBtn);
    return wrap;
}

/**
 * Mount DOM elements for docks around canvas container.
 * Each bar: [first/prev] [visible slots] [next/last]; only VISIBLE_CAP slots in DOM.
 * Hotkeys still resolve all logical slots via hotkeysMap.
 */
function mountDocks() {
    if (typeof document === 'undefined') return;
    state.lastSignatures.clear();
    for (let i = 0; i < DOCK_AREAS.length; i++) {
        const area = DOCK_AREAS[i];
        const container = document.getElementById(`actionBarDock${area.charAt(0).toUpperCase() + area.slice(1)}`);
        if (!container) continue;
        container.innerHTML = '';
        const bars = state.docks[area] || [];
        const count = state.layoutCounts[area] != null
            ? state.layoutCounts[area]
            : bars.length;
        for (let j = 0; j < bars.length && j < count; j++) {
            const bar = bars[j];
            const vertical = bar.orientation === 'vertical';
            const range = visibleRangeForBar(bar);
            const { start, end, maxOffset, offset } = range;

            const barEl = document.createElement('div');
            barEl.className = `action-bar action-bar--${bar.orientation}` +
                (bar.locked ? ' action-bar--locked' : '');
            barEl.id = `actionBar_${bar.id}`;
            barEl.setAttribute('data-bar-id', bar.id);
            barEl.setAttribute('data-dock', area);
            barEl.setAttribute('data-page-offset', String(offset));
            barEl.setAttribute('data-page-max', String(maxOffset));
            barEl.setAttribute('data-locked', bar.locked ? '1' : '0');
            barEl.setAttribute(
                'aria-label',
                `Action bar ${bar.id}${bar.locked ? ' (locked)' : ''}`
            );

            barEl.appendChild(createBarToolsCluster(bar));
            barEl.appendChild(createCarouselNavCluster(bar, 'start', offset, maxOffset, vertical));

            const slotsWrap = document.createElement('div');
            slotsWrap.className = 'action-bar-slots';
            slotsWrap.setAttribute('role', 'toolbar');
            slotsWrap.setAttribute(
                'aria-label',
                `Action bar ${bar.id} slots ${start + 1}–${Math.max(start, end)} of ${bar.slots.length}` +
                    (bar.locked ? ' (locked)' : '')
            );

            for (let k = start; k < end; k++) {
                mountSlotElement(slotsWrap, bar.slots[k], { locked: !!bar.locked });
            }
            barEl.appendChild(slotsWrap);

            barEl.appendChild(createCarouselNavCluster(bar, 'end', offset, maxOffset, vertical));

            // Optional wheel: scroll through logical slots (Shift+wheel also works on trackpads)
            barEl.addEventListener('wheel', (ev) => {
                if (maxPageOffsetForBar(bar) <= 0) return;
                const raw = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
                if (!raw) return;
                ev.preventDefault();
                const step = raw > 0 ? 1 : -1;
                shiftBarPage(bar.id, step);
            }, { passive: false });

            container.appendChild(barEl);
        }
    }
}

/**
 * Reconcile Action Bar slots with inventory counts and shared combat cooldowns (dirty signatures).
 */
function updateActionBars() {
    if (typeof document === 'undefined') return;
    const player = state.getActivePlayer ? state.getActivePlayer() : null;
    if (player) {
        const cid = player.classId != null ? String(player.classId) : (player.vocation != null ? String(player.vocation) : null);
        if (cid && typeof cid === 'string' && cid !== 'undefined' && cid.trim() !== '') {
            const normCid = cid.trim().toLowerCase();
            if (state.lastSeenPlayerClass !== normCid) {
                state.lastSeenPlayerClass = normCid;
                if (normCid !== state.activeProfileId) {
                    switchProfile(normCid);
                    return;
                }
            }
        }
    }
    const itemDb = state.getItemDb ? state.getItemDb() : null;
    const spellBook = state.getSpellBook ? state.getSpellBook() : null;
    const genre = state.getGenre ? state.getGenre() : 'rpg_fantasy';

    let anyOnCooldown = false;
    const slots = state.slotsById.values();
    for (const slot of slots) {
        let count = 0;
        /** @type {{ charges: number|null, durationSec: number|null, durationText: string|null, sig: string }} */
        let budget = { charges: null, durationSec: null, durationText: null, sig: 'c:d' };
        const multiCtx = { player: player || null, spellBook, itemDb };
        const multiActive =
            slot.actionType === 'multi' ? getActiveMultiSubAction(slot, multiCtx) : null;
        /** Effective paint payload: multi uses rotated sub-action for icon/count/CD. */
        let paintType = slot.actionType;
        let paintItemId = slot.itemId;
        let paintSpellId = slot.spellId;
        let paintText = slot.text;
        if (multiActive && multiActive.sub) {
            paintType = multiActive.sub.actionType;
            paintItemId = multiActive.sub.itemId;
            paintSpellId = multiActive.sub.spellId;
            paintText = multiActive.sub.text;
        }
        let isEquipped = false;
        if (paintType === 'item' && paintItemId && player && player.inventory) {
            const paintItem = findItem(itemDb, paintItemId);
            // Gear badge includes equipped instances (legacy inventory count + checked state).
            count = itemIsActionBarEquipable(paintItem)
                ? countItemIdCarried(player.inventory, paintItemId)
                : countItemIdInInventoryTree(player.inventory, paintItemId);
            isEquipped = findEquippedSlotForItemId(player.inventory, paintItemId) != null;
            budget = resolveItemIdBudgetDisplay(
                player.inventory,
                paintItemId,
                itemDb,
                player.equipmentRuntime || null
            );
        }
        const isAlive = player && player.alive !== false ? 1 : 0;
        const cdSpec = resolveSlotCooldownSpec(slot, spellBook, itemDb, player);
        const cdDisp = player
            ? getSpecCooldownDisplay(player, cdSpec)
            : { remaining: 0, duration: 0, progress: 100 };
        const cdRem = cdDisp.remaining;
        if (cdRem > 0) anyOnCooldown = true;
        // ~100ms remaining + 1% progress buckets keep clock wipe smooth without per-frame DOM
        const cdBucket = cdRem > 0 ? Math.ceil(cdRem * 10) : 0;
        const cdProgressBucket = cdRem > 0 ? Math.floor(cdDisp.progress) : 100;
        const payloadKey = slot.itemId || slot.spellId || slot.command || slot.text || slot.passiveId || multiActionsSig(slot.multiActions) || '';
        const multiIdx = multiActive ? multiActive.index : -1;
        const equipFlag = isEquipped ? 1 : 0;
        const structureSig = `${slot.actionType}:${payloadKey}:${slot.hotkey}:${count}:${isAlive}:${slot.targetMode}:${budget.sig}:m${multiIdx}:${paintType}:e${equipFlag}`;
        const cdSig = `${cdBucket}:${cdProgressBucket}`;
        const sig = `${structureSig}|${cdSig}`;

        if (sig === state.lastSignatures.get(slot.id)) continue;

        const el = document.getElementById(`actionBarSlot_${slot.id}`);
        if (!el) continue;

        const prevSig = state.lastSignatures.get(slot.id) || '';
        const prevStructure = prevSig.includes('|') ? prevSig.split('|')[0] : prevSig;
        const structureChanged = structureSig !== prevStructure || !el.querySelector('.slot-cooldown-overlay');
        state.lastSignatures.set(slot.id, sig);

        if (structureChanged) {
            el.className = 'action-bar-slot';
            if (slot.actionType === 'empty') el.classList.add('action-bar-slot--empty');
            if (slot.actionType === 'multi') el.classList.add('action-bar-slot--multi');
            if (isEquipped) el.classList.add('action-bar-slot--equipped');
            if (slot.hotkey) el.setAttribute('data-hotkey', slot.hotkey);
            else el.removeAttribute('data-hotkey');
            el.setAttribute('aria-label', slotAriaLabel(slot, spellBook, itemDb));
            el.setAttribute('role', 'button');
            if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
            const hoverTitle = slotHoverTitle(slot, spellBook, itemDb, {
                locked: isSlotBarLocked(slot.id),
                paintType,
                paintItemId,
                paintSpellId,
                paintText
            });
            if (hoverTitle) el.title = hoverTitle;
            else el.removeAttribute('title');

            let html = '';
            if (slot.hotkey) {
                html += `<div class="slot-hotkey-badge">${escapeHtml(slot.hotkey)}</div>`;
            }

            if (paintType === 'item' && paintItemId) {
                const item = findItem(itemDb, paintItemId);
                const url = resolveItemSpriteUrl ? resolveItemSpriteUrl(item || { id: paintItemId, name: paintItemId }, genre) : null;
                if (url) {
                    html += `<img class="slot-icon-thumb" src="${escapeHtml(url)}" alt="">`;
                } else {
                    html += `<div class="slot-icon-thumb" title="${escapeHtml(paintItemId)}"><i class="fa-solid fa-box"></i></div>`;
                }
                // Charges top-right (hotkey owns top-left); duration bottom-left; stack bottom-right
                if (budget.charges != null && budget.charges > 0) {
                    html += `<div class="item-charges-badge item-charges-badge--action">${budget.charges}</div>`;
                }
                if (budget.durationText) {
                    html += `<div class="item-duration-badge">${escapeHtml(budget.durationText)}</div>`;
                }
                if (count > 0 || (item && !itemIsMultiUse(item))) {
                    html += `<div class="slot-count-badge">${count > 999 ? '999+' : count}</div>`;
                }
            } else if (paintType === 'spell' && paintSpellId) {
                let spellTitle = paintSpellId;
                if (Array.isArray(spellBook)) {
                    const sp = spellBook.find(s => s && s.id === paintSpellId);
                    if (sp && (sp.label || sp.name)) spellTitle = `${sp.label || sp.name} (${paintSpellId})`;
                } else if (spellBook && typeof spellBook === 'object' && spellBook[paintSpellId]) {
                    const sp = spellBook[paintSpellId];
                    if (sp && (sp.label || sp.name)) spellTitle = `${sp.label || sp.name} (${paintSpellId})`;
                }
                html += `<div class="slot-icon-thumb" title="${escapeHtml(spellTitle)}"><i class="fa-solid fa-wand-magic-sparkles"></i></div>`;
            } else if (slot.actionType === 'command' && slot.command) {
                html += `<div class="slot-icon-thumb" title="${escapeHtml(slot.command)}"><i class="fa-solid fa-terminal"></i></div>`;
            } else if (paintType === 'text' && paintText) {
                const preview = paintText.length > 24 ? `${paintText.slice(0, 24)}…` : paintText;
                html += `<div class="slot-icon-thumb" title="${escapeHtml(paintText)}"><i class="fa-solid fa-comment"></i></div>`;
                html += `<div class="slot-text-preview">${escapeHtml(preview)}</div>`;
            } else if (slot.actionType === 'passive' && slot.passiveId) {
                html += `<div class="slot-icon-thumb" title="${escapeHtml(slot.passiveId)}"><i class="fa-solid fa-shield-heart"></i></div>`;
            } else if (slot.actionType === 'multi') {
                const filled = Array.isArray(slot.multiActions)
                    ? slot.multiActions.filter((s) => s && s.actionType !== 'empty').length
                    : 0;
                html += `<div class="slot-icon-thumb" title="Multi-action (${filled}/${MULTI_ACTION_DEPTH})"><i class="fa-solid fa-layer-group"></i></div>`;
            }

            if (slot.actionType === 'multi') {
                const filled = Array.isArray(slot.multiActions)
                    ? slot.multiActions.filter((s) => s && s.actionType !== 'empty').length
                    : 0;
                if (filled >= 2) {
                    html += `<div class="slot-multi-badge">${filled}</div>`;
                }
            }

            html += `<div class="slot-cooldown-overlay" aria-hidden="true"><span class="slot-cooldown-timer"></span></div>`;
            el.innerHTML = html;
        }

        paintSlotCooldownOverlay(el, cdDisp);
    }
    state.anySlotOnCooldown = anyOnCooldown;
}

/**
 * Apply legacy-style clock wipe + remaining timer on a slot's cooldown overlay.
 * @param {HTMLElement} el
 * @param {{ remaining: number, progress: number }} cdDisp
 */
function paintSlotCooldownOverlay(el, cdDisp) {
    if (!el) return;
    const rem = cdDisp && cdDisp.remaining > 0 ? cdDisp.remaining : 0;
    const progress = rem > 0 && cdDisp ? cdDisp.progress : 100;
    const overlay = el.querySelector('.slot-cooldown-overlay');
    if (rem > 0) {
        el.classList.add('action-bar-slot--on-cooldown');
        if (overlay) {
            overlay.style.setProperty('--cd-progress', String(Math.round(progress * 10) / 10));
            const timer = overlay.querySelector('.slot-cooldown-timer');
            if (timer) timer.textContent = formatCooldownTimer(rem);
        }
    } else {
        el.classList.remove('action-bar-slot--on-cooldown');
        if (overlay) {
            overlay.style.removeProperty('--cd-progress');
            const timer = overlay.querySelector('.slot-cooldown-timer');
            if (timer) timer.textContent = '';
        }
    }
}

/**
 * Adaptive action-bar paint schedule: fast while a live hunt is running,
 * ~100ms while any slot shows a cooldown wipe, slow when idle/hidden.
 */
function scheduleActionBarPoll() {
    if (typeof setTimeout === 'undefined') return;
    if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
    }
    const hidden = typeof document !== 'undefined' && document.hidden;
    const live = typeof state.getIsSessionLive === 'function' ? !!state.getIsSessionLive() : false;
    const anyCd = !!state.anySlotOnCooldown;
    let ms = POLL_MS_IDLE;
    if (hidden) ms = POLL_MS_HIDDEN;
    else if (live && anyCd) ms = POLL_MS_LIVE_COOLDOWN;
    else if (live) ms = POLL_MS_LIVE;
    state.pollTimer = setTimeout(() => {
        state.pollTimer = null;
        updateActionBars();
        scheduleActionBarPoll();
    }, ms);
}

function stopActionBarPoll() {
    if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
    }
}

/**
 * Global keyboard dispatcher intercepting bound hotkeys when inputs are not focused.
 * @param {KeyboardEvent} ev
 */
function onDocumentKeyDown(ev) {
    if (!ev || !ev.key || typeof document === 'undefined') return;
    const target = ev.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT')) {
        return;
    }

    const parts = [];
    if (ev.ctrlKey && ev.key !== 'Control') parts.push('CTRL');
    if (ev.altKey && ev.key !== 'Alt') parts.push('ALT');
    if (ev.shiftKey && ev.key !== 'Shift') parts.push('SHIFT');

    if (ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Shift' || ev.key === 'Meta') return;

    let k = ev.key;
    if (ev.code && ev.code.startsWith('Digit')) k = ev.code.slice(5);
    else if (ev.code && ev.code.startsWith('Key')) k = ev.code.slice(3);
    else if (k === ' ') k = 'SPACE';

    parts.push(String(k).toUpperCase());
    const shortcut = normalizeHotkey(parts.join('+'));
    const slotId = state.hotkeysMap.get(shortcut);
    if (!slotId) return;

    const slot = state.slotsById.get(slotId);
    if (!slot || slot.actionType === 'empty') return;

    ev.preventDefault();
    executeSlot(slot);
}

/**
 * Initialize action bars layout, state, and event dispatchers.
 * @param {object} opts
 * @param {() => object|null} [opts.getActivePlayer]
 * @param {() => object|null} [opts.getItemDb]
 * @param {() => Record<string, object>|null} [opts.getSpellBook]
 * @param {() => string} [opts.getGenre]
 * @param {() => boolean} [opts.getIsSessionLive]
 * @param {() => object|null} [opts.getSimulator]
 */
function initActionBars(opts) {
    state.getActivePlayer = (opts && opts.getActivePlayer) || null;
    state.getItemDb = (opts && opts.getItemDb) || null;
    state.getSpellBook = (opts && opts.getSpellBook) || null;
    state.getSimulator = (opts && opts.getSimulator) || null;
    state.getGenre = (opts && opts.getGenre) || (() => 'rpg_fantasy');
    state.getIsSessionLive = (opts && opts.getIsSessionLive) || null;
    state.onProfileChange = (opts && opts.onProfileChange) || null;

    if (!state.debouncedIdbSaver && typeof window !== 'undefined' && typeof createDebouncedPrefsSaver === 'function') {
        state.debouncedIdbSaver = createDebouncedPrefsSaver(PREFS_KEY, () => buildStoragePayload());
    }

    initDefaultDocks();
    loadFromStorage();
    rebuildMaps();
    state.lastSeenPlayerClass = getDefaultProfileId() || null;

    if (typeof window !== 'undefined' && typeof getUiPreferences === 'function') {
        getUiPreferences(PREFS_KEY).then((data) => {
            if (data && applyStoredPayload(data)) {
                rebuildMaps();
                if (typeof document !== 'undefined') {
                    mountDocks();
                    state.lastSignatures.clear();
                    updateActionBars();
                }
            }
        }).catch(() => {});
    }

    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
        mountDocks();
        updateActionBars();
        if (!state.keyDispatcherBound) {
            window.addEventListener('keydown', onDocumentKeyDown);
            state.keyDispatcherBound = true;
        }
        if (!state.visibilityBound) {
            document.addEventListener('visibilitychange', () => {
                scheduleActionBarPoll();
            });
            state.visibilityBound = true;
        }
        scheduleActionBarPoll();
    }
    state.inited = true;

    return {
        refresh: () => {
            state.lastSignatures.clear();
            updateActionBars();
        },
        dispose: () => {
            stopActionBarPoll();
            hideSlotContextMenu();
            cancelItemPickMode();
            if (state.keyDispatcherBound && typeof window !== 'undefined') {
                window.removeEventListener('keydown', onDocumentKeyDown);
                state.keyDispatcherBound = false;
            }
        }
    };
}

/**
 * Handle dropping an item element over an action bar slot.
 * @param {HTMLElement} element
 * @param {string} itemId
 * @returns {boolean}
 */
function tryHandleSlotDrop(element, itemId) {
    if (!element || !itemId || !element.closest) return false;
    const slotEl = element.closest('.action-bar-slot');
    if (!slotEl) return false;
    const slotId = slotEl.getAttribute('data-slot-id');
    if (!slotId) return false;
    if (isSlotBarLocked(slotId)) return false;
    const slot = state.slotsById.get(slotId);
    if (!slot) return false;
    return assignSlot(slotId, 'item', { itemId, hotkey: slot.hotkey, targetMode: slot.targetMode });
}

module.exports = {
    initActionBars,
    updateActionBars,
    mountDocks,
    executeSlot,
    assignSlot,
    tryHandleSlotDrop,
    switchProfile,
    checkHotkeyConflict,
    initDefaultDocksData,
    normalizeHotkey,
    createBar,
    createEmptySlot,
    createEmptySubSlot,
    normalizeSlot,
    normalizeBar,
    normalizeDocks,
    normalizeMultiActions,
    normalizeLayoutCounts,
    defaultLayoutCounts,
    defaultHotkeysFor,
    clampBarCount,
    setLayoutCounts,
    coerceStoredPayload,
    buildStoragePayload,
    applyStoredPayload,
    applyNormalizedPayload,
    initDefaultDocks,
    rebuildMaps,
    lookupSpell,
    findSpellForItemId,
    resolveAllowTileAim,
    enterActionCursor,
    resolveSlotCooldownSpec,
    getSpecRemainingSeconds,
    getSpecCooldownDisplay,
    formatCooldownTimer,
    paintSlotCooldownOverlay,
    spellCastsOnSelfByDefault,
    spellRequiresSelectedTarget,
    saveToStorage,
    visibleCapForBar,
    maxPageOffsetForBar,
    clampBarPageOffset,
    findBarById,
    findBarForSlotId,
    isSlotBarLocked,
    setBarLocked,
    toggleBarLocked,
    clearBar,
    describeSlotAction,
    slotAriaLabel,
    slotHoverTitle,
    visibleRangeForBar,
    setBarPageOffset,
    shiftBarPage,
    multiActionsSig,
    getSpellManaCost,
    resolveSubActionCooldownSpec,
    isSubActionAvailable,
    findNextAvailableMultiIndex,
    getActiveMultiSubAction,
    multiSubAsSlot,
    findEquippedSlotForItemId,
    findFirstContainerUidForItemId,
    countItemIdCarried,
    itemIsActionBarEquipable,
    toggleEquipByItemId,
    showActionSlotEditorModal,
    modalDeps,
    hideSlotContextMenu,
    cancelItemPickMode,
    LS_KEY,
    LS_KEY_V2,
    PREFS_KEY,
    SLOTS_PER_BAR,
    MAX_BARS_PER_DOCK,
    MULTI_ACTION_DEPTH,
    VISIBLE_CAP_HORIZONTAL,
    VISIBLE_CAP_VERTICAL,
    state
};
