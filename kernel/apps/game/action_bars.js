/**
 * Action Bars core UI & keymap dispatcher for manual hunt and combat execution.
 * Handles slot assignment, hotkey mapping, Smart Cast preference, macro dispatching,
 * shared combat cooldown overlays (primary/group/spell/item), and dirty-only paint.
 */

'use strict';

const {
    countItemIdInInventoryTree,
    itemIsMultiUse
} = require('../../core/lib/character/inventory.js');
const { findItem } = require('../../core/lib/character/stats.js');
const {
    isSelfCenteredAreaSpell,
    spellHasShape
} = require('../../core/lib/combat/area.js');
const Cooldowns = require('../../core/lib/combat/cooldowns.js');
const { enterTargetCursorMode, loadGeneralHotkeys } = require('./ui_state.js');
const { resolveItemSpriteUrl } = require('./equipment_panel.js');
const { getUiPreferences, createDebouncedPrefsSaver } = require('../../core/lib/ui_preferences.js');

/** Canonical localStorage + IndexedDB prefs key. */
const LS_KEY_V2 = 'hdl_action_bars';
const PREFS_KEY = 'hdl_action_bars';
/** Legacy keys — read for migration only, then pruned. */
const LS_KEY_LEGACY_LAYOUT = 'huntdl_action_bars_layout';
const LS_KEY_LEGACY_ALIAS = 'hdl_keymap';

/** Live poll while hunting; idle/tab-hidden use slower cadence (CPU). */
const POLL_MS_LIVE = 250;
const POLL_MS_IDLE = 2000;
const POLL_MS_HIDDEN = 4000;

/**
 * @typedef {object} ActionBarSlot
 * @property {string} id
 * @property {number} index
 * @property {string} hotkey
 * @property {'empty'|'item'|'spell'|'command'} actionType
 * @property {string|null} [itemId]
 * @property {string|null} [spellId]
 * @property {string|null} [command]
 * @property {'smart_target'|'cursor_prompt'|'self'} targetMode
 */

/**
 * @typedef {object} ActionBar
 * @property {string} id
 * @property {'horizontal'|'vertical'} orientation
 * @property {ActionBarSlot[]} slots
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
    /** @type {Map<string, string>} normalized hotkey -> slot id */
    hotkeysMap: new Map(),
    /** @type {Map<string, ActionBarSlot>} slot id -> slot */
    slotsById: new Map(),
    /** @type {Map<string, string>} slot id -> dirty signature */
    lastSignatures: new Map(),
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
 * Create a fresh action bar.
 * @param {string} id
 * @param {number} slotCount
 * @param {string[]} defaultHotkeys
 * @param {'horizontal'|'vertical'} orientation
 * @returns {ActionBar}
 */
function createBar(id, slotCount, defaultHotkeys, orientation) {
    const slots = [];
    for (let i = 0; i < slotCount; i++) {
        slots.push({
            id: `${id}_slot_${i}`,
            index: i,
            hotkey: defaultHotkeys[i] ? normalizeHotkey(defaultHotkeys[i]) : '',
            actionType: 'empty',
            itemId: null,
            spellId: null,
            command: null,
            targetMode: 'smart_target'
        });
    }
    return { id, orientation, slots };
}

/**
 * Create initial out-of-the-box dock layout object.
 * @returns {Record<string, ActionBar[]>}
 */
function initDefaultDocksData() {
    return {
        top: [
            createBar('top_1', 12, ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'], 'horizontal')
        ],
        bottom: [
            createBar('bottom_1', 12, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='], 'horizontal')
        ],
        left: [
            createBar('left_1', 10, ['Shift+1', 'Shift+2', 'Shift+3', 'Shift+4', 'Shift+5', 'Shift+6', 'Shift+7', 'Shift+8', 'Shift+9', 'Shift+0'], 'vertical')
        ],
        right: [
            createBar('right_1', 10, ['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7', 'Ctrl+8', 'Ctrl+9', 'Ctrl+0'], 'vertical')
        ]
    };
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
    const defaultData = initDefaultDocksData();
    const defClass = getDefaultProfileId();
    state.profiles = { [defClass]: defaultData };
    state.activeProfileId = defClass;
    state.docks = state.profiles[defClass];
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
        state.profiles[pid] = initDefaultDocksData();
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
 * Persist profiles to the canonical localStorage key and prune legacy keys.
 * Also kicks the debounced IndexedDB prefs saver.
 */
function saveToStorage() {
    if (state.activeProfileId) {
        state.profiles[state.activeProfileId] = state.docks;
    }
    if (state.debouncedIdbSaver) {
        state.debouncedIdbSaver();
    }
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const payloadV2 = JSON.stringify({
            profiles: state.profiles,
            activeProfileId: state.activeProfileId
        });
        window.localStorage.setItem(LS_KEY_V2, payloadV2);
        try { window.localStorage.removeItem(LS_KEY_LEGACY_ALIAS); } catch (_) {}
        try { window.localStorage.removeItem(LS_KEY_LEGACY_LAYOUT); } catch (_) {}
    } catch (_) {}
}

/**
 * Migrate legacy 'default' profile into active character class profile.
 * @param {Record<string, Record<string, ActionBar[]>>} profiles
 * @param {string} activeId
 */
function migrateLegacyProfiles(profiles, activeId) {
    const defClass = getDefaultProfileId();
    let targetActive = (typeof activeId === 'string' && activeId && activeId !== 'default' && activeId !== 'undefined')
        ? activeId.toLowerCase()
        : defClass;

    const resProfiles = Object.assign({}, profiles || {});
    if (resProfiles.default) {
        if (!resProfiles[targetActive]) {
            resProfiles[targetActive] = resProfiles.default;
        }
        delete resProfiles.default;
    }
    if (!resProfiles[targetActive]) {
        resProfiles[targetActive] = initDefaultDocksData();
    }
    return { profiles: resProfiles, activeProfileId: targetActive };
}

/**
 * Load customized layout from localStorage or migrate legacy format.
 * After a successful load, rewrites the canonical key and prunes aliases.
 */
function loadFromStorage() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
        const rawV2 =
            window.localStorage.getItem(LS_KEY_V2) ||
            window.localStorage.getItem(LS_KEY_LEGACY_ALIAS);
        if (rawV2) {
            const parsed = JSON.parse(rawV2);
            if (parsed && typeof parsed === 'object' && parsed.profiles && typeof parsed.profiles === 'object') {
                const migrated = migrateLegacyProfiles(parsed.profiles, parsed.activeProfileId);
                state.profiles = migrated.profiles;
                state.activeProfileId = migrated.activeProfileId;
                state.docks = state.profiles[state.activeProfileId] || initDefaultDocksData();
                saveToStorage();
                return;
            }
        }
        const rawV1 = window.localStorage.getItem(LS_KEY_LEGACY_LAYOUT);
        if (rawV1) {
            const parsed = JSON.parse(rawV1);
            if (parsed && typeof parsed === 'object') {
                const legacyData = initDefaultDocksData();
                const areas = ['top', 'bottom', 'left', 'right'];
                for (let i = 0; i < areas.length; i++) {
                    const k = areas[i];
                    if (Array.isArray(parsed[k])) legacyData[k] = parsed[k];
                }
                const defClass = getDefaultProfileId();
                state.profiles = { [defClass]: legacyData };
                state.activeProfileId = defClass;
                state.docks = legacyData;
                saveToStorage();
            }
        }
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
 * Resolve the combat cooldown spec for a bar slot (spell, rune item, or item.use).
 * Shared primary/group keys make related slots show overlay together.
 * @param {ActionBarSlot} slot
 * @param {Record<string, object>|object[]|null|undefined} spellBook
 * @param {object|null|undefined} itemDb
 * @returns {object|null}
 */
function resolveSlotCooldownSpec(slot, spellBook, itemDb) {
    if (!slot || slot.actionType === 'empty' || slot.actionType === 'command') return null;
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
    if (!entity || !spec || typeof spec !== 'object') return 0;
    let max = 0;
    const buckets = Cooldowns.BUCKETS || ['auto', 'primary', 'secondary', 'spell', 'item'];
    for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        const names = Object.keys(keys);
        for (let k = 0; k < names.length; k++) {
            const rem = Cooldowns.getRemaining(entity, bucket, names[k]);
            if (rem > max) max = rem;
        }
    }
    return max;
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
        const isMulti = itemIsMultiUse(item) || (item && String(item.type).toLowerCase() === 'rune');

        if (slot.targetMode === 'smart_target' && isMulti) {
            if (player.target && player.target.id != null && player.target.alive !== false) {
                player.commandQueue.push({
                    type: 'USE_ITEM_WITH',
                    itemId: slot.itemId,
                    target: { kind: 'entity', id: player.target.id }
                });
                return;
            }
        }

        if (slot.targetMode === 'cursor_prompt' || (isMulti && slot.targetMode !== 'self')) {
            enterTargetCursorMode({ type: 'USE_ITEM_WITH', itemId: slot.itemId });
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
            enterTargetCursorMode({ type: 'CAST_SPELL', spellId: slot.spellId });
            return;
        }

        // smart_target (default): only fire targeted spells when a target is selected.
        // Do NOT fall through to self — that self-damaged fireballs/strikes.
        if (hasTarget) {
            player.commandQueue.push({
                type: 'CAST_SPELL',
                spellId: slot.spellId,
                target: { kind: 'entity', id: player.target.id }
            });
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
    }
}

/**
 * Assign an item or spell to a slot by ID.
 * @param {string} slotId
 * @param {'empty'|'item'|'spell'|'command'} type
 * @param {object} cfg
 */
function assignSlot(slotId, type, cfg) {
    const slot = state.slotsById.get(slotId);
    if (!slot) return false;
    slot.actionType = type;
    slot.itemId = type === 'item' ? (cfg.itemId || null) : null;
    slot.spellId = type === 'spell' ? (cfg.spellId || null) : null;
    slot.command = type === 'command' ? (cfg.command || null) : null;
    if (cfg && cfg.targetMode) slot.targetMode = cfg.targetMode;
    if (cfg && cfg.hotkey !== undefined) {
        const norm = normalizeHotkey(cfg.hotkey);
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
 * Ensure the inline customization modal exists in DOM (pure CSS pattern).
 * @returns {{ root: HTMLElement, title: HTMLElement, body: HTMLElement }|null}
 */
function ensureActionEditorModal() {
    if (typeof document === 'undefined') return null;
    let root = document.getElementById('actionSlotEditorModal');
    if (!root) {
        root = document.createElement('div');
        root.id = 'actionSlotEditorModal';
        root.className = 'party-details-modal action-slot-editor-modal';
        root.hidden = true;
        root.setAttribute('aria-hidden', 'true');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.innerHTML = `
            <div class="party-details-dialog" style="max-width: 440px;">
                <div class="party-details-header">
                    <h2 id="actionSlotEditorTitle" class="party-details-title">Customize Action Slot</h2>
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-action-close aria-label="Close">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <div id="actionSlotEditorBody" class="party-details-body"></div>
            </div>
        `;
        document.body.appendChild(root);

        const close = () => { if (root) root.hidden = true; };
        root.addEventListener('click', (ev) => {
            const t = /** @type {HTMLElement} */ (ev.target);
            if (t === root || (t && t.closest && t.closest('[data-action-close]'))) {
                close();
            }
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && root && !root.hidden) close();
        });
    }
    const title = /** @type {HTMLElement} */ (root.querySelector('#actionSlotEditorTitle'));
    const body = /** @type {HTMLElement} */ (root.querySelector('#actionSlotEditorBody'));
    return { root, title, body };
}

/**
 * Open customization editor modal for a slot.
 * @param {ActionBarSlot} slot
 */
function showActionSlotEditorModal(slot) {
    if (!slot || typeof document === 'undefined') return;
    const m = ensureActionEditorModal();
    if (!m) return;
    m.title.textContent = `Customize Slot (${slot.hotkey || 'Unbound'})`;

    const rawSpells = state.getSpellBook ? state.getSpellBook() : {};
    const spellList = Array.isArray(rawSpells)
        ? rawSpells
        : (rawSpells && typeof rawSpells === 'object' ? Object.keys(rawSpells).map(key => Object.assign({ id: key }, rawSpells[key], { id: rawSpells[key] && rawSpells[key].id ? rawSpells[key].id : key })) : []);

    let spellsOptions = '<option value="">(Select Spell)</option>';
    for (let i = 0; i < spellList.length; i++) {
        const sp = spellList[i];
        if (!sp || !sp.id) continue;
        const id = String(sp.id);
        const label = sp.label || sp.name;
        const name = label ? `${label} (${id})` : id;
        spellsOptions += `<option value="${escapeHtml(id)}" ${slot.spellId === id ? 'selected' : ''}>${escapeHtml(name)}</option>`;
    }

    m.body.innerHTML = `
        <form id="actionSlotEditForm" class="text-start small">
            <div class="mb-3">
                <label class="form-label text-muted">Action Type</label>
                <select id="editorActionType" class="form-select bg-dark text-light border-secondary">
                    <option value="empty" ${slot.actionType === 'empty' ? 'selected' : ''}>Empty (Unassigned)</option>
                    <option value="item" ${slot.actionType === 'item' ? 'selected' : ''}>Use Item / Rune</option>
                    <option value="spell" ${slot.actionType === 'spell' ? 'selected' : ''}>Cast Spell</option>
                    <option value="command" ${slot.actionType === 'command' ? 'selected' : ''}>Command / Macro</option>
                </select>
            </div>
            <div id="editorItemSection" class="mb-3" ${slot.actionType !== 'item' ? 'style="display:none;"' : ''}>
                <label class="form-label text-muted">Item Template ID</label>
                <input type="text" id="editorItemId" class="form-control bg-dark text-light border-secondary font-monospace" placeholder="e.g. rune_fireball, potion_healing" value="${escapeHtml(slot.itemId || '')}">
            </div>
            <div id="editorSpellSection" class="mb-3" ${slot.actionType !== 'spell' ? 'style="display:none;"' : ''}>
                <label class="form-label text-muted">Spell</label>
                <select id="editorSpellId" class="form-select bg-dark text-light border-secondary font-monospace">
                    ${spellsOptions}
                </select>
            </div>
            <div id="editorCommandSection" class="mb-3" ${slot.actionType !== 'command' ? 'style="display:none;"' : ''}>
                <label class="form-label text-muted">Command</label>
                <input type="text" id="editorCommandStr" class="form-control bg-dark text-light border-secondary font-monospace" placeholder="e.g. auto_chase, stop" value="${escapeHtml(slot.command || '')}">
            </div>
            <div class="mb-3">
                <label class="form-label text-muted">Targeting Preference</label>
                <select id="editorTargetMode" class="form-select bg-dark text-light border-secondary">
                    <option value="smart_target" ${slot.targetMode === 'smart_target' ? 'selected' : ''}>Smart Cast on Active Target (Recommended)</option>
                    <option value="cursor_prompt" ${slot.targetMode === 'cursor_prompt' ? 'selected' : ''}>Default / Cursor Prompt</option>
                    <option value="self" ${slot.targetMode === 'self' ? 'selected' : ''}>Cast on Self</option>
                </select>
            </div>
            <div class="mb-4">
                <label class="form-label text-muted">Hotkey Binding</label>
                <input type="text" id="editorHotkey" class="form-control bg-dark text-light border-secondary font-monospace" value="${escapeHtml(slot.hotkey || '')}">
                <div class="form-text text-muted">e.g. F1, SHIFT+1, CTRL+F1</div>
            </div>
            <div class="d-flex justify-content-between">
                <button type="button" class="btn btn-sm btn-outline-danger" id="btnEditorClear">Clear Slot</button>
                <div class="d-flex gap-2">
                    <button type="button" class="btn btn-sm btn-secondary" data-action-close>Cancel</button>
                    <button type="submit" class="btn btn-sm btn-primary">Save Changes</button>
                </div>
            </div>
        </form>
    `;

    const form = /** @type {HTMLFormElement} */ (m.body.querySelector('#actionSlotEditForm'));
    const typeSelect = /** @type {HTMLSelectElement} */ (m.body.querySelector('#editorActionType'));
    const itemSec = /** @type {HTMLElement} */ (m.body.querySelector('#editorItemSection'));
    const spellSec = /** @type {HTMLElement} */ (m.body.querySelector('#editorSpellSection'));
    const cmdSec = /** @type {HTMLElement} */ (m.body.querySelector('#editorCommandSection'));
    const btnClear = /** @type {HTMLButtonElement} */ (m.body.querySelector('#btnEditorClear'));

    typeSelect.addEventListener('change', () => {
        itemSec.style.display = typeSelect.value === 'item' ? 'block' : 'none';
        spellSec.style.display = typeSelect.value === 'spell' ? 'block' : 'none';
        cmdSec.style.display = typeSelect.value === 'command' ? 'block' : 'none';
    });

    btnClear.addEventListener('click', (ev) => {
        ev.preventDefault();
        assignSlot(slot.id, 'empty', { hotkey: slot.hotkey });
        m.root.hidden = true;
    });

    form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const t = typeSelect.value || 'empty';
        const itemId = /** @type {HTMLInputElement} */ (m.body.querySelector('#editorItemId')).value.trim();
        const spellId = /** @type {HTMLSelectElement} */ (m.body.querySelector('#editorSpellId')).value.trim();
        const command = /** @type {HTMLInputElement} */ (m.body.querySelector('#editorCommandStr')).value.trim();
        const targetMode = /** @type {HTMLSelectElement} */ (m.body.querySelector('#editorTargetMode')).value;
        const hotkey = /** @type {HTMLInputElement} */ (m.body.querySelector('#editorHotkey')).value.trim();

        assignSlot(slot.id, /** @type {any} */ (t), {
            itemId,
            spellId,
            command,
            targetMode: /** @type {any} */ (targetMode),
            hotkey
        });
        m.root.hidden = true;
    });

    m.root.hidden = false;
    m.root.setAttribute('aria-hidden', 'false');
}

/**
 * Mount DOM elements for docks around canvas container.
 */
function mountDocks() {
    if (typeof document === 'undefined') return;
    state.lastSignatures.clear();
    const areas = ['top', 'bottom', 'left', 'right'];
    for (let i = 0; i < areas.length; i++) {
        const area = areas[i];
        const container = document.getElementById(`actionBarDock${area.charAt(0).toUpperCase() + area.slice(1)}`);
        if (!container) continue;
        container.innerHTML = '';
        const bars = state.docks[area] || [];
        for (let j = 0; j < bars.length; j++) {
            const bar = bars[j];
            const barEl = document.createElement('div');
            barEl.className = `action-bar action-bar--${bar.orientation}`;
            barEl.id = `actionBar_${bar.id}`;
            for (let k = 0; k < bar.slots.length; k++) {
                const slot = bar.slots[k];
                const slotEl = document.createElement('div');
                slotEl.className = 'action-bar-slot action-bar-slot--empty';
                slotEl.id = `actionBarSlot_${slot.id}`;
                slotEl.setAttribute('data-slot-id', slot.id);
                if (slot.hotkey) slotEl.setAttribute('data-hotkey', slot.hotkey);

                slotEl.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    executeSlot(slot);
                });

                slotEl.addEventListener('contextmenu', (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    showActionSlotEditorModal(slot);
                });

                barEl.appendChild(slotEl);
            }
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

    const slots = state.slotsById.values();
    for (const slot of slots) {
        let count = 0;
        if (slot.actionType === 'item' && slot.itemId && player && player.inventory) {
            count = countItemIdInInventoryTree(player.inventory, slot.itemId);
        }
        const isAlive = player && player.alive !== false ? 1 : 0;
        const cdSpec = resolveSlotCooldownSpec(slot, spellBook, itemDb);
        const cdRem = player ? getSpecRemainingSeconds(player, cdSpec) : 0;
        // ~100ms buckets keep overlay smooth without rewriting every frame
        const cdBucket = cdRem > 0 ? Math.ceil(cdRem * 10) : 0;
        const sig = `${slot.actionType}:${slot.itemId || slot.spellId || slot.command || ''}:${slot.hotkey}:${count}:${isAlive}:${cdBucket}:${slot.targetMode}`;

        if (sig === state.lastSignatures.get(slot.id)) continue;
        state.lastSignatures.set(slot.id, sig);

        const el = document.getElementById(`actionBarSlot_${slot.id}`);
        if (!el) continue;

        el.className = 'action-bar-slot';
        if (slot.actionType === 'empty') el.classList.add('action-bar-slot--empty');
        if (cdBucket > 0) el.classList.add('action-bar-slot--on-cooldown');
        if (slot.hotkey) el.setAttribute('data-hotkey', slot.hotkey);

        let html = '';
        if (slot.hotkey) {
            html += `<div class="slot-hotkey-badge">${escapeHtml(slot.hotkey)}</div>`;
        }

        if (slot.actionType === 'item' && slot.itemId) {
            const item = findItem(itemDb, slot.itemId);
            const url = resolveItemSpriteUrl ? resolveItemSpriteUrl(item || { id: slot.itemId, name: slot.itemId }, genre) : null;
            if (url) {
                html += `<img class="slot-icon-thumb" src="${escapeHtml(url)}" alt="">`;
            } else {
                html += `<div class="slot-icon-thumb" title="${escapeHtml(slot.itemId)}"><i class="fa-solid fa-box"></i></div>`;
            }
            if (count > 0 || (item && !itemIsMultiUse(item))) {
                html += `<div class="slot-count-badge">${count > 999 ? '999+' : count}</div>`;
            }
        } else if (slot.actionType === 'spell' && slot.spellId) {
            let spellTitle = slot.spellId;
            if (Array.isArray(spellBook)) {
                const sp = spellBook.find(s => s && s.id === slot.spellId);
                if (sp && (sp.label || sp.name)) spellTitle = `${sp.label || sp.name} (${slot.spellId})`;
            } else if (spellBook && typeof spellBook === 'object' && spellBook[slot.spellId]) {
                const sp = spellBook[slot.spellId];
                if (sp && (sp.label || sp.name)) spellTitle = `${sp.label || sp.name} (${slot.spellId})`;
            }
            html += `<div class="slot-icon-thumb" title="${escapeHtml(spellTitle)}"><i class="fa-solid fa-wand-magic-sparkles"></i></div>`;
        } else if (slot.actionType === 'command' && slot.command) {
            html += `<div class="slot-icon-thumb" title="${escapeHtml(slot.command)}"><i class="fa-solid fa-terminal"></i></div>`;
        }

        html += `<div class="slot-cooldown-overlay"></div>`;
        el.innerHTML = html;
    }
}

/**
 * Adaptive action-bar paint schedule: fast while a live hunt is running, slow when idle/hidden.
 */
function scheduleActionBarPoll() {
    if (typeof setTimeout === 'undefined') return;
    if (state.pollTimer) {
        clearTimeout(state.pollTimer);
        state.pollTimer = null;
    }
    const hidden = typeof document !== 'undefined' && document.hidden;
    const live = typeof state.getIsSessionLive === 'function' ? !!state.getIsSessionLive() : false;
    const ms = hidden ? POLL_MS_HIDDEN : (live ? POLL_MS_LIVE : POLL_MS_IDLE);
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
 */
function initActionBars(opts) {
    state.getActivePlayer = (opts && opts.getActivePlayer) || null;
    state.getItemDb = (opts && opts.getItemDb) || null;
    state.getSpellBook = (opts && opts.getSpellBook) || null;
    state.getGenre = (opts && opts.getGenre) || (() => 'rpg_fantasy');
    state.getIsSessionLive = (opts && opts.getIsSessionLive) || null;
    state.onProfileChange = (opts && opts.onProfileChange) || null;

    if (!state.debouncedIdbSaver && typeof window !== 'undefined' && typeof createDebouncedPrefsSaver === 'function') {
        state.debouncedIdbSaver = createDebouncedPrefsSaver(PREFS_KEY, () => ({
            profiles: state.profiles,
            activeProfileId: state.activeProfileId
        }));
    }

    initDefaultDocks();
    loadFromStorage();
    rebuildMaps();
    state.lastSeenPlayerClass = getDefaultProfileId() || null;

    if (typeof window !== 'undefined' && typeof getUiPreferences === 'function') {
        getUiPreferences(PREFS_KEY).then((data) => {
            if (data && data.profiles && typeof data.profiles === 'object') {
                const migrated = migrateLegacyProfiles(/** @type {any} */ (data.profiles), data.activeProfileId);
                state.profiles = migrated.profiles;
                state.activeProfileId = migrated.activeProfileId;
                state.docks = state.profiles[state.activeProfileId] || initDefaultDocksData();
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
    initDefaultDocks,
    rebuildMaps,
    lookupSpell,
    findSpellForItemId,
    resolveSlotCooldownSpec,
    getSpecRemainingSeconds,
    spellCastsOnSelfByDefault,
    spellRequiresSelectedTarget,
    migrateLegacyProfiles,
    saveToStorage,
    LS_KEY_V2,
    state
};
