/**
 * In-game action-bar context menu and assign modals (Stage B).
 * Spell / object / text / passive / hotkey assignment without the setup popup.
 * Pure helpers are exported for unit tests; DOM paths no-op under Node.
 */

'use strict';

const { Settings } = require('../../settings.js');
const { getItem } = require('../../core/lib/character/inventory.js');
const {
    enterTargetCursorMode,
    clearTargetCursorMode,
    uiState
} = require('./ui_state.js');

/** Max length for action-bar text (FCT). */
const TEXT_MAX_LEN = 255;

/** Stub passives until a real passive combat subsystem exists. */
const KNOWN_PASSIVES = [
    {
        id: 'gift_of_life',
        label: 'Gift of Life',
        description: 'Not available in combat yet (stub).'
    }
];

/** Bare keys that must not bind as action-bar hotkeys (movement / reserved). */
const BLOCKED_BARE_KEYS = new Set([
    'ESCAPE',
    'TAB',
    'ENTER',
    'ARROWUP',
    'ARROWDOWN',
    'ARROWLEFT',
    'ARROWRIGHT',
    'W',
    'A',
    'S',
    'D'
]);

/** Always blocked regardless of modifiers. */
const BLOCKED_ALWAYS = new Set(['ESCAPE', 'TAB']);

/** @type {HTMLElement|null} */
let ctxMenuEl = null;
/** @type {HTMLElement|null} */
let modalRoot = null;
/** @type {((ev: KeyboardEvent) => void)|null} */
let hotkeyCaptureHandler = null;
/** @type {{ onPick: (itemId: string) => void, onCancel: () => void, getActivePlayer?: () => object|null|undefined }|null} */
let itemPickSession = null;
/** @type {((ev: MouseEvent) => void)|null} */
let itemPickClickHandler = null;
/** @type {((ev: KeyboardEvent) => void)|null} */
let itemPickKeyHandler = null;
/** @type {HTMLElement|null} */
let pickBannerEl = null;

/**
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
 * Normalize spell book (map or array) to a flat list with ids.
 * @param {Record<string, object>|object[]|null|undefined} spellBook
 * @returns {object[]}
 */
function spellBookToList(spellBook) {
    if (!spellBook) return [];
    if (Array.isArray(spellBook)) {
        return spellBook.filter((s) => s && s.id).map((s) => Object.assign({}, s, { id: String(s.id) }));
    }
    if (typeof spellBook === 'object') {
        return Object.keys(spellBook).map((key) => {
            const sp = spellBook[key] || {};
            const id = sp.id != null && sp.id !== '' ? String(sp.id) : String(key);
            return Object.assign({}, sp, { id });
        });
    }
    return [];
}

/**
 * Filter + sort spells for assign UI.
 * @param {object[]} spells
 * @param {object} [opts]
 * @param {string} [opts.query]
 * @param {string|null} [opts.vocation] class/profile id; ignored when showAll
 * @param {boolean} [opts.showAll]
 * @param {'name'|'level'|'group'} [opts.sort]
 * @returns {object[]}
 */
function filterSpells(spells, opts) {
    const o = opts || {};
    const query = o.query != null ? String(o.query).trim().toLowerCase() : '';
    const showAll = !!o.showAll;
    const vocation = o.vocation != null ? String(o.vocation).trim().toLowerCase() : '';
    const sort = o.sort === 'level' || o.sort === 'group' ? o.sort : 'name';

    let list = Array.isArray(spells) ? spells.slice() : [];
    list = list.filter((sp) => sp && sp.id);

    if (!showAll && vocation && vocation !== 'default' && vocation !== 'common') {
        list = list.filter((sp) => {
            const vocs = sp.vocations;
            if (!Array.isArray(vocs) || vocs.length === 0) return true;
            for (let i = 0; i < vocs.length; i++) {
                if (String(vocs[i]).toLowerCase() === vocation) return true;
            }
            return false;
        });
    }

    if (query) {
        list = list.filter((sp) => {
            const id = String(sp.id).toLowerCase();
            const name = String(sp.label || sp.name || '').toLowerCase();
            const words = sp.words != null ? String(sp.words).toLowerCase() : '';
            const group = String(sp.group || sp.kind || '').toLowerCase();
            return (
                id.indexOf(query) >= 0 ||
                name.indexOf(query) >= 0 ||
                words.indexOf(query) >= 0 ||
                group.indexOf(query) >= 0
            );
        });
    }

    list.sort((a, b) => {
        if (sort === 'level') {
            const la = Number(a.level != null ? a.level : a.minLevel) || 0;
            const lb = Number(b.level != null ? b.level : b.minLevel) || 0;
            if (la !== lb) return la - lb;
        } else if (sort === 'group') {
            const ga = String(a.group || a.kind || '');
            const gb = String(b.group || b.kind || '');
            if (ga !== gb) return ga.localeCompare(gb);
        }
        const na = String(a.label || a.name || a.id);
        const nb = String(b.label || b.name || b.id);
        return na.localeCompare(nb);
    });

    return list;
}

/**
 * @returns {{ id: string, label: string, description: string }[]}
 */
function listKnownPassives() {
    return KNOWN_PASSIVES.map((p) => Object.assign({}, p));
}

/**
 * @param {string} hotkey normalized or raw
 * @returns {boolean}
 */
function isBlockedHotkey(hotkey) {
    const n = String(hotkey || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
    if (!n) return true;
    const parts = n.split('+');
    const base = parts[parts.length - 1] || '';
    if (BLOCKED_ALWAYS.has(base) || BLOCKED_ALWAYS.has(n)) return true;
    if (parts.length === 1 && BLOCKED_BARE_KEYS.has(base)) return true;
    return false;
}

/**
 * Whether a hotkey collides with a general movement/target shortcut.
 * @param {string} hotkey
 * @param {object|null|undefined} [shortcuts] Settings.MANUAL_CONTROL_SHORTCUTS-like
 * @returns {string|null} action name if conflict, else null
 */
function findGeneralHotkeyConflict(hotkey, shortcuts) {
    const n = String(hotkey || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
    if (!n) return null;
    const sc =
        shortcuts ||
        (Settings && Settings.MANUAL_CONTROL_SHORTCUTS ? Settings.MANUAL_CONTROL_SHORTCUTS : null);
    if (!sc || typeof sc !== 'object') return null;
    const keys = Object.keys(sc);
    for (let i = 0; i < keys.length; i++) {
        const action = keys[i];
        const arr = sc[action];
        if (!Array.isArray(arr)) continue;
        for (let j = 0; j < arr.length; j++) {
            const stored = String(arr[j] || '')
                .trim()
                .toUpperCase()
                .replace(/\s+/g, '');
            if (stored && stored === n) return action;
        }
    }
    return null;
}

/**
 * Build normalized hotkey string from a KeyboardEvent (no modifiers-only).
 * @param {KeyboardEvent} ev
 * @returns {string} empty if modifier-only
 */
function eventToHotkeyString(ev) {
    if (!ev || !ev.key) return '';
    const key = ev.key;
    if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return '';
    let keyName = key.toUpperCase();
    if (key === ' ') keyName = 'SPACE';
    else if (ev.code && ev.code.startsWith('Digit')) keyName = ev.code.slice(5);
    else if (ev.code && ev.code.startsWith('Key') && key.length === 1) keyName = ev.code.slice(3);
    const mods = [];
    if (ev.ctrlKey) mods.push('CTRL');
    if (ev.shiftKey) mods.push('SHIFT');
    if (ev.altKey) mods.push('ALT');
    return mods.length ? `${mods.join('+')}+${keyName}` : keyName;
}

function hideSlotContextMenu() {
    if (ctxMenuEl && ctxMenuEl.parentNode) {
        ctxMenuEl.parentNode.removeChild(ctxMenuEl);
    }
    ctxMenuEl = null;
}

/**
 * Shared modal shell (party-details style).
 * @returns {{ root: HTMLElement, title: HTMLElement, body: HTMLElement }|null}
 */
function ensureModalShell() {
    if (typeof document === 'undefined') return null;
    if (!modalRoot) {
        modalRoot = document.createElement('div');
        modalRoot.id = 'actionBarAssignModal';
        modalRoot.className = 'party-details-modal action-bar-assign-modal';
        modalRoot.hidden = true;
        modalRoot.setAttribute('aria-hidden', 'true');
        modalRoot.setAttribute('role', 'dialog');
        modalRoot.setAttribute('aria-modal', 'true');
        modalRoot.innerHTML = `
            <div class="party-details-dialog action-bar-assign-dialog" style="max-width: 480px;">
                <div class="party-details-header">
                    <h2 id="actionBarAssignTitle" class="party-details-title">Assign</h2>
                    <button type="button" class="btn btn-sm btn-outline-secondary" data-ab-modal-close aria-label="Close">
                        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                    </button>
                </div>
                <div id="actionBarAssignBody" class="party-details-body"></div>
            </div>
        `;
        document.body.appendChild(modalRoot);
        modalRoot.addEventListener('click', (ev) => {
            const t = /** @type {HTMLElement} */ (ev.target);
            if (t === modalRoot || (t && t.closest && t.closest('[data-ab-modal-close]'))) {
                closeModal();
            }
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && modalRoot && !modalRoot.hidden) {
                // Hotkey capture handles Escape itself while capturing
                if (hotkeyCaptureHandler) return;
                closeModal();
            }
        });
    }
    const title = /** @type {HTMLElement} */ (modalRoot.querySelector('#actionBarAssignTitle'));
    const body = /** @type {HTMLElement} */ (modalRoot.querySelector('#actionBarAssignBody'));
    return { root: modalRoot, title, body };
}

function stopHotkeyCapture() {
    if (hotkeyCaptureHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', hotkeyCaptureHandler, { capture: true });
    }
    hotkeyCaptureHandler = null;
}

function closeModal() {
    stopHotkeyCapture();
    if (modalRoot) {
        modalRoot.hidden = true;
        modalRoot.setAttribute('aria-hidden', 'true');
        const body = modalRoot.querySelector('#actionBarAssignBody');
        if (body) body.innerHTML = '';
    }
}

/**
 * @param {string} titleText
 * @param {string|HTMLElement} bodyContent
 */
/**
 * Focus first focusable control inside the assign modal; Tab cycles within dialog.
 * @param {HTMLElement} root
 */
function trapModalFocus(root) {
    if (!root || typeof document === 'undefined') return;
    const dialog = root.querySelector('.action-bar-assign-dialog') || root;
    const focusables = () => Array.from(dialog.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null || el === document.activeElement);

    const list = focusables();
    if (list.length) {
        try { list[0].focus(); } catch (_) {}
    }

    if (root._abFocusTrap) {
        root.removeEventListener('keydown', root._abFocusTrap, true);
    }
    root._abFocusTrap = (ev) => {
        if (ev.key !== 'Tab' || root.hidden) return;
        const els = focusables();
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (ev.shiftKey) {
            if (document.activeElement === first || !dialog.contains(document.activeElement)) {
                ev.preventDefault();
                last.focus();
            }
        } else if (document.activeElement === last) {
            ev.preventDefault();
            first.focus();
        }
    };
    root.addEventListener('keydown', root._abFocusTrap, true);
}

function openModal(titleText, bodyContent) {
    const m = ensureModalShell();
    if (!m) return null;
    stopHotkeyCapture();
    hideSlotContextMenu();
    m.title.textContent = titleText;
    m.root.setAttribute('aria-labelledby', 'actionBarAssignTitle');
    if (typeof bodyContent === 'string') {
        m.body.innerHTML = bodyContent;
    } else if (bodyContent) {
        m.body.innerHTML = '';
        m.body.appendChild(bodyContent);
    }
    m.root.hidden = false;
    m.root.setAttribute('aria-hidden', 'false');
    // Defer focus so layout settles
    setTimeout(() => trapModalFocus(m.root), 0);
    return m;
}

/**
 * @typedef {object} ActionBarModalDeps
 * @property {(slotId: string, type: string, cfg?: object) => boolean} assignSlot
 * @property {(hotkey: string, excludeSlotId?: string) => object|null} checkHotkeyConflict
 * @property {(str: string) => string} normalizeHotkey
 * @property {() => Record<string, object>|object[]|null|undefined} [getSpellBook]
 * @property {() => object|null|undefined} [getItemDb]
 * @property {() => object|null|undefined} [getActivePlayer]
 * @property {() => string} [getGenre]
 * @property {() => string} [getActiveProfileId]
 * @property {() => object|null|undefined} [getSimulator]
 * @property {(item: object, genre?: string) => string|null} [resolveItemSpriteUrl]
 * @property {(slotId: string) => boolean} [isSlotBarLocked]
 * @property {(barId: string, locked: boolean) => boolean} [setBarLocked]
 * @property {(slotId: string) => object|null} [findBarForSlotId]
 * @property {(barId: string) => boolean|null} [toggleBarLocked]
 */

/**
 * RMB context menu for an action-bar slot.
 * Locked bars: unlock only + disabled assign entries (execute still works via LMB).
 * @param {number} x
 * @param {number} y
 * @param {object} slot
 * @param {ActionBarModalDeps} deps
 */
function showSlotContextMenu(x, y, slot, deps) {
    if (typeof document === 'undefined' || !slot || !deps) return;
    hideSlotContextMenu();
    cancelItemPickMode();

    ctxMenuEl = document.createElement('div');
    ctxMenuEl.className = 'inv-context-menu action-bar-context-menu';
    ctxMenuEl.setAttribute('role', 'menu');
    ctxMenuEl.setAttribute('aria-label', 'Action bar slot menu');
    ctxMenuEl.style.left = `${x}px`;
    ctxMenuEl.style.top = `${y}px`;

    /**
     * @param {string} label
     * @param {() => void} fn
     * @param {boolean} [disabled]
     */
    const addItem = (label, fn, disabled) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'inv-context-item';
        btn.setAttribute('role', 'menuitem');
        btn.textContent = label;
        if (disabled) {
            btn.disabled = true;
            btn.setAttribute('aria-disabled', 'true');
        } else {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                hideSlotContextMenu();
                fn();
            });
        }
        ctxMenuEl.appendChild(btn);
    };

    const bar = deps.findBarForSlotId ? deps.findBarForSlotId(slot.id) : null;
    const locked = deps.isSlotBarLocked
        ? !!deps.isSlotBarLocked(slot.id)
        : !!(bar && bar.locked);

    if (locked) {
        addItem('Bar locked — unlock to edit', () => {}, true);
        if (bar && deps.setBarLocked) {
            addItem('Unlock Bar', () => {
                deps.setBarLocked(bar.id, false);
            });
        }
    } else {
        const isAssigned = slot.actionType && slot.actionType !== 'empty';
        const editPrefix = isAssigned ? 'Edit' : 'Assign';

        addItem(`${editPrefix} Spell…`, () => openAssignSpellModal(slot, deps));
        addItem(`${editPrefix} Object…`, () => openAssignObjectModal(slot, deps));
        addItem(`${editPrefix} Text…`, () => openAssignTextModal(slot, deps));
        addItem(`${editPrefix} Passive Ability…`, () => openAssignPassiveModal(slot, deps));
        addItem(`${editPrefix} Multi-Action…`, () => openAssignMultiModal(slot, deps));
        addItem(`${editPrefix} Hotkey…`, () => openAssignHotkeyModal(slot, deps));
        if (isAssigned) {
            addItem('Clear Action', () => {
                deps.assignSlot(slot.id, 'empty', { hotkey: slot.hotkey || '' });
            });
        }
        if (bar && deps.setBarLocked) {
            addItem('Lock Bar', () => {
                deps.setBarLocked(bar.id, true);
            });
        }
    }

    document.body.appendChild(ctxMenuEl);

    // Keep on-screen
    const rect = ctxMenuEl.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - rect.width - 8);
    if (top + rect.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - rect.height - 8);
    ctxMenuEl.style.left = `${left}px`;
    ctxMenuEl.style.top = `${top}px`;

    const onDoc = (ev) => {
        if (!ctxMenuEl) return;
        const t = /** @type {Node} */ (ev.target);
        if (ctxMenuEl.contains(t)) return;
        hideSlotContextMenu();
        document.removeEventListener('mousedown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (ev) => {
        if (ev.key === 'Escape') {
            hideSlotContextMenu();
            document.removeEventListener('mousedown', onDoc, true);
            document.removeEventListener('keydown', onKey, true);
        }
    };
    // Defer so the opening contextmenu event does not immediately close
    setTimeout(() => {
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
}

/**
 * @param {object} slot
 * @param {ActionBarModalDeps} deps
 */
function openAssignSpellModal(slot, deps) {
    if (!slot || !deps) return;
    const raw = deps.getSpellBook ? deps.getSpellBook() : null;
    const allSpells = spellBookToList(raw);
    const profileId = deps.getActiveProfileId ? deps.getActiveProfileId() : '';
    const player = deps.getActivePlayer ? deps.getActivePlayer() : null;
    const vocation =
        profileId ||
        (player && (player.classId || player.vocation)) ||
        '';

    let selectedId = slot.actionType === 'spell' && slot.spellId ? String(slot.spellId) : '';
    let targetMode = slot.targetMode || 'smart_target';
    let showAll = false;
    let sort = 'name';
    let query = '';

    const m = openModal(
        `Assign Spell — slot ${slot.index + 1}`,
        `
        <div class="action-bar-assign-form">
            <div class="d-flex flex-wrap gap-2 mb-2 align-items-center">
                <input type="search" id="abSpellSearch" class="form-control form-control-sm bg-dark text-light border-secondary flex-grow-1"
                    placeholder="Search name / id…" value="" autocomplete="off">
                <select id="abSpellSort" class="form-select form-select-sm bg-dark text-light border-secondary" style="max-width:8rem;">
                    <option value="name">Name</option>
                    <option value="level">Level</option>
                    <option value="group">Group</option>
                </select>
            </div>
            <div class="form-check mb-2">
                <input class="form-check-input" type="checkbox" id="abSpellShowAll">
                <label class="form-check-label text-muted small" for="abSpellShowAll">Show all classes</label>
            </div>
            <div id="abSpellList" class="action-bar-assign-list mb-2" role="listbox"></div>
            <div class="mb-3">
                <label class="form-label text-muted small mb-1">Targeting</label>
                <select id="abSpellTarget" class="form-select form-select-sm bg-dark text-light border-secondary">
                    <option value="smart_target">Smart Cast (max hits)</option>
                    <option value="active_target">Active Target (center on target)</option>
                    <option value="cursor_prompt">Cursor prompt</option>
                    <option value="self">Self</option>
                </select>
            </div>
            <div class="d-flex justify-content-end gap-2">
                <button type="button" class="btn btn-sm btn-secondary" data-ab-modal-close>Cancel</button>
                <button type="button" class="btn btn-sm btn-outline-primary" id="abSpellApply" disabled>Apply</button>
                <button type="button" class="btn btn-sm btn-primary" id="abSpellOk" disabled>Ok</button>
            </div>
        </div>
        `
    );
    if (!m) return;

    const listEl = /** @type {HTMLElement} */ (m.body.querySelector('#abSpellList'));
    const searchEl = /** @type {HTMLInputElement} */ (m.body.querySelector('#abSpellSearch'));
    const sortEl = /** @type {HTMLSelectElement} */ (m.body.querySelector('#abSpellSort'));
    const showAllEl = /** @type {HTMLInputElement} */ (m.body.querySelector('#abSpellShowAll'));
    const targetEl = /** @type {HTMLSelectElement} */ (m.body.querySelector('#abSpellTarget'));
    const btnApply = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abSpellApply'));
    const btnOk = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abSpellOk'));

    targetEl.value = targetMode;

    const save = () => {
        if (!selectedId) return false;
        targetMode = targetEl.value || 'smart_target';
        return deps.assignSlot(slot.id, 'spell', {
            spellId: selectedId,
            targetMode,
            hotkey: slot.hotkey || ''
        });
    };

    const paintList = () => {
        const filtered = filterSpells(allSpells, {
            query,
            vocation: String(vocation || ''),
            showAll,
            sort: /** @type {any} */ (sort)
        });
        listEl.innerHTML = '';
        if (!filtered.length) {
            listEl.innerHTML = '<div class="text-muted small p-2 text-center">No matching spells.</div>';
            return;
        }
        for (let i = 0; i < filtered.length; i++) {
            const sp = filtered[i];
            const id = String(sp.id);
            const name = sp.label || sp.name || id;
            const mana = sp.mana != null ? sp.mana : sp.manaCost != null ? sp.manaCost : sp.cost;
            const lvl = sp.level != null ? sp.level : sp.minLevel;
            const row = document.createElement('button');
            row.type = 'button';
            row.className =
                'action-bar-assign-list-item' + (selectedId === id ? ' is-selected' : '');
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', selectedId === id ? 'true' : 'false');
            row.innerHTML = `
                <span class="ab-spell-name"><i class="fa-solid fa-wand-magic-sparkles text-warning me-1"></i>${escapeHtml(String(name))}</span>
                <span class="ab-spell-meta font-monospace text-muted">${escapeHtml(id)}${mana != null ? ` · ${mana} mana` : ''}${lvl != null ? ` · L${lvl}` : ''}</span>
            `;
            row.addEventListener('click', () => {
                selectedId = id;
                paintList();
                btnApply.disabled = false;
                btnOk.disabled = false;
            });
            listEl.appendChild(row);
        }
    };

    searchEl.addEventListener('input', () => {
        query = searchEl.value || '';
        paintList();
    });
    sortEl.addEventListener('change', () => {
        sort = sortEl.value || 'name';
        paintList();
    });
    showAllEl.addEventListener('change', () => {
        showAll = !!showAllEl.checked;
        paintList();
    });
    btnApply.addEventListener('click', () => {
        save();
    });
    btnOk.addEventListener('click', () => {
        if (save()) closeModal();
    });

    if (selectedId) {
        btnApply.disabled = false;
        btnOk.disabled = false;
    }
    paintList();
    searchEl.focus();
}

/**
 * @param {object} slot
 * @param {ActionBarModalDeps} deps
 * @param {string} [prefillItemId]
 */
function openAssignObjectModal(slot, deps, prefillItemId) {
    if (!slot || !deps) return;
    let itemId =
        prefillItemId != null && prefillItemId !== ''
            ? String(prefillItemId)
            : slot.actionType === 'item' && slot.itemId
              ? String(slot.itemId)
              : '';
    let targetMode = slot.targetMode || 'smart_target';

    const m = openModal(
        `Assign Object — slot ${slot.index + 1}`,
        `
        <div class="action-bar-assign-form">
            <p class="text-muted small mb-2">Pick an item from inventory / equipment, or type a template id.</p>
            <div class="d-flex gap-2 mb-2">
                <button type="button" class="btn btn-sm btn-outline-info" id="abObjPick">
                    <i class="fa-solid fa-crosshairs me-1"></i>Pick from inventory
                </button>
            </div>
            <div class="mb-2">
                <label class="form-label text-muted small mb-1">Item template id</label>
                <input type="text" id="abObjItemId" class="form-control form-control-sm bg-dark text-light border-secondary font-monospace"
                    placeholder="e.g. rune_fireball, potion_healing" value="${escapeHtml(itemId)}" autocomplete="off">
            </div>
            <div class="mb-3">
                <label class="form-label text-muted small mb-1">Use mode</label>
                <select id="abObjTarget" class="form-select form-select-sm bg-dark text-light border-secondary">
                    <option value="smart_target">Smart Cast (max AoE hits; recommended for runes)</option>
                    <option value="active_target">Active Target (center on attack target)</option>
                    <option value="cursor_prompt">Select target (crosshair)</option>
                    <option value="self">Use on yourself</option>
                </select>
                <p class="text-muted small mt-1 mb-0">Wearable gear (weapons, armor, …) always equip/unequip on click, regardless of use mode. Smart Cast ranks the blast to hit as many hostiles as possible; Active Target plants the center on your selected target.</p>
            </div>
            <div class="d-flex justify-content-end gap-2">
                <button type="button" class="btn btn-sm btn-secondary" data-ab-modal-close>Cancel</button>
                <button type="button" class="btn btn-sm btn-outline-primary" id="abObjApply">Apply</button>
                <button type="button" class="btn btn-sm btn-primary" id="abObjOk">Ok</button>
            </div>
        </div>
        `
    );
    if (!m) return;

    const idEl = /** @type {HTMLInputElement} */ (m.body.querySelector('#abObjItemId'));
    const targetEl = /** @type {HTMLSelectElement} */ (m.body.querySelector('#abObjTarget'));
    const pickBtn = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abObjPick'));
    const btnApply = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abObjApply'));
    const btnOk = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abObjOk'));
    targetEl.value = targetMode;

    const save = () => {
        const id = (idEl.value || '').trim();
        if (!id) return false;
        targetMode = targetEl.value || 'smart_target';
        return deps.assignSlot(slot.id, 'item', {
            itemId: id,
            targetMode,
            hotkey: slot.hotkey || ''
        });
    };

    pickBtn.addEventListener('click', () => {
        closeModal();
        startItemPickMode({
            onPick: (pickedId) => {
                openAssignObjectModal(slot, deps, pickedId);
            },
            onCancel: () => {
                openAssignObjectModal(slot, deps, itemId);
            },
            getActivePlayer: deps.getActivePlayer
        });
    });

    btnApply.addEventListener('click', () => {
        save();
    });
    btnOk.addEventListener('click', () => {
        if (save()) closeModal();
    });
    idEl.focus();
    idEl.select();
}

/**
 * @param {{ onPick: (itemId: string) => void, onCancel: () => void, getActivePlayer?: () => object|null|undefined }} session
 */
function startItemPickMode(session) {
    if (typeof document === 'undefined' || !session) return;
    cancelItemPickMode();
    itemPickSession = session;

    // Reuse targeting cursor chrome
    enterTargetCursorMode({ type: 'ASSIGN_ITEM_PICK' });

    pickBannerEl = document.createElement('div');
    pickBannerEl.className = 'action-bar-pick-banner';
    pickBannerEl.setAttribute('role', 'status');
    pickBannerEl.innerHTML =
        '<i class="fa-solid fa-crosshairs me-2"></i>Click an inventory or equipment item to assign. <kbd>Esc</kbd> cancels.';
    document.body.appendChild(pickBannerEl);

    itemPickClickHandler = (ev) => {
        if (!itemPickSession) return;
        const t = /** @type {HTMLElement} */ (ev.target);
        if (!t || !t.closest) return;
        const slotEl = /** @type {HTMLElement|null} */ (
            t.closest(
                '.backpack-slot[data-item-uid], .inv-slot[data-item-uid], .slot-item[data-item-uid], .inv-equip-slot[data-item-uid]'
            )
        );
        if (!slotEl) return;
        const uid = slotEl.getAttribute('data-item-uid');
        if (!uid) return;
        ev.preventDefault();
        ev.stopPropagation();

        const itemId = resolveItemIdFromUid(uid, slotEl, itemPickSession.getActivePlayer);
        if (!itemId) return;

        const onPick = itemPickSession.onPick;
        cancelItemPickMode();
        onPick(itemId);
    };

    itemPickKeyHandler = (ev) => {
        if (ev.key === 'Escape' && itemPickSession) {
            ev.preventDefault();
            const onCancel = itemPickSession.onCancel;
            cancelItemPickMode();
            if (typeof onCancel === 'function') onCancel();
        }
    };

    document.addEventListener('click', itemPickClickHandler, true);
    document.addEventListener('keydown', itemPickKeyHandler, true);
}

/**
 * @param {string} uid
 * @param {HTMLElement|null} slotEl
 * @param {(() => object|null|undefined)|undefined} getActivePlayer
 * @returns {string}
 */
function resolveItemIdFromUid(uid, slotEl, getActivePlayer) {
    if (slotEl) {
        const di = slotEl.getAttribute('data-item-id');
        if (di) return String(di);
    }
    let player = null;
    if (typeof getActivePlayer === 'function') {
        try {
            player = getActivePlayer();
        } catch (_) {
            player = null;
        }
    }
    if (player && player.inventory) {
        try {
            const inst = getItem(player.inventory, uid);
            if (inst && inst.itemId) return String(inst.itemId);
        } catch (_) {}
        if (player.inventory.items && player.inventory.items[uid]) {
            const inst = player.inventory.items[uid];
            if (inst && inst.itemId) return String(inst.itemId);
        }
    }
    return '';
}

function cancelItemPickMode() {
    if (itemPickClickHandler && typeof document !== 'undefined') {
        document.removeEventListener('click', itemPickClickHandler, true);
    }
    if (itemPickKeyHandler && typeof document !== 'undefined') {
        document.removeEventListener('keydown', itemPickKeyHandler, true);
    }
    itemPickClickHandler = null;
    itemPickKeyHandler = null;
    itemPickSession = null;
    if (pickBannerEl && pickBannerEl.parentNode) {
        pickBannerEl.parentNode.removeChild(pickBannerEl);
    }
    pickBannerEl = null;
    if (uiState && uiState.activeActionCursor && uiState.activeActionCursor.type === 'ASSIGN_ITEM_PICK') {
        clearTargetCursorMode();
    }
}

/**
 * @param {object} slot
 * @param {ActionBarModalDeps} deps
 */
function openAssignTextModal(slot, deps) {
    if (!slot || !deps) return;
    const initial = slot.actionType === 'text' && slot.text != null ? String(slot.text) : '';
    const m = openModal(
        `Assign Text — slot ${slot.index + 1}`,
        `
        <div class="action-bar-assign-form">
            <p class="text-muted small mb-2">Shown as floating text (FCT) on the player when triggered. Does not cast spells.</p>
            <div class="mb-3">
                <label class="form-label text-muted small mb-1">Text</label>
                <textarea id="abTextBody" class="form-control form-control-sm bg-dark text-light border-secondary" rows="3"
                    maxlength="${TEXT_MAX_LEN}" placeholder="e.g. Pulling south">${escapeHtml(initial)}</textarea>
                <div class="form-text text-muted">Max ${TEXT_MAX_LEN} characters.</div>
            </div>
            <div class="d-flex justify-content-end gap-2">
                <button type="button" class="btn btn-sm btn-secondary" data-ab-modal-close>Cancel</button>
                <button type="button" class="btn btn-sm btn-outline-primary" id="abTextApply">Apply</button>
                <button type="button" class="btn btn-sm btn-primary" id="abTextOk">Ok</button>
            </div>
        </div>
        `
    );
    if (!m) return;
    const ta = /** @type {HTMLTextAreaElement} */ (m.body.querySelector('#abTextBody'));
    const save = () => {
        const text = (ta.value || '').slice(0, TEXT_MAX_LEN);
        if (!text.trim()) return false;
        return deps.assignSlot(slot.id, 'text', { text, hotkey: slot.hotkey || '' });
    };
    m.body.querySelector('#abTextApply').addEventListener('click', () => {
        save();
    });
    m.body.querySelector('#abTextOk').addEventListener('click', () => {
        if (save()) closeModal();
    });
    ta.focus();
}

/**
 * @param {object} slot
 * @param {ActionBarModalDeps} deps
 */
function openAssignPassiveModal(slot, deps) {
    if (!slot || !deps) return;
    const passives = listKnownPassives();
    let selectedId =
        slot.actionType === 'passive' && slot.passiveId ? String(slot.passiveId) : '';

    let rows = '';
    for (let i = 0; i < passives.length; i++) {
        const p = passives[i];
        const checked = selectedId === p.id ? 'checked' : '';
        rows += `
            <label class="action-bar-assign-list-item d-flex align-items-start gap-2">
                <input type="radio" name="abPassive" value="${escapeHtml(p.id)}" ${checked}>
                <span>
                    <span class="ab-spell-name">${escapeHtml(p.label)}</span>
                    <span class="ab-spell-meta text-muted d-block">${escapeHtml(p.description || p.id)}</span>
                </span>
            </label>
        `;
    }

    const m = openModal(
        `Assign Passive — slot ${slot.index + 1}`,
        `
        <div class="action-bar-assign-form">
            <p class="text-muted small mb-2">Passives are stubbed until the combat subsystem exists.</p>
            <div class="action-bar-assign-list mb-3">${rows || '<div class="text-muted small p-2">No passives registered.</div>'}</div>
            <div class="d-flex justify-content-end gap-2">
                <button type="button" class="btn btn-sm btn-secondary" data-ab-modal-close>Cancel</button>
                <button type="button" class="btn btn-sm btn-outline-primary" id="abPasApply" ${selectedId ? '' : 'disabled'}>Apply</button>
                <button type="button" class="btn btn-sm btn-primary" id="abPasOk" ${selectedId ? '' : 'disabled'}>Ok</button>
            </div>
        </div>
        `
    );
    if (!m) return;

    const btnApply = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abPasApply'));
    const btnOk = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abPasOk'));
    const radios = m.body.querySelectorAll('input[name="abPassive"]');
    radios.forEach((r) => {
        r.addEventListener('change', () => {
            selectedId = /** @type {HTMLInputElement} */ (r).value;
            btnApply.disabled = !selectedId;
            btnOk.disabled = !selectedId;
        });
    });
    const save = () => {
        if (!selectedId) return false;
        return deps.assignSlot(slot.id, 'passive', {
            passiveId: selectedId,
            hotkey: slot.hotkey || ''
        });
    };
    btnApply.addEventListener('click', () => {
        save();
    });
    btnOk.addEventListener('click', () => {
        if (save()) closeModal();
    });
}

/**
 * @param {object} slot
 * @param {ActionBarModalDeps} deps
 */
function openAssignHotkeyModal(slot, deps) {
    if (!slot || !deps) return;
    let captured = slot.hotkey ? deps.normalizeHotkey(slot.hotkey) : '';
    let capturing = true;

    const m = openModal(
        `Assign Hotkey — slot ${slot.index + 1}`,
        `
        <div class="action-bar-assign-form">
            <p class="text-muted small mb-2">Press a key combination. Esc cancels capture (use Clear to remove).</p>
            <div id="abHotkeyDisplay" class="action-bar-hotkey-display mb-2">${captured ? escapeHtml(captured) : '<span class="text-muted">Waiting for key…</span>'}</div>
            <div id="abHotkeyWarn" class="mb-2"></div>
            <div class="d-flex justify-content-between gap-2">
                <button type="button" class="btn btn-sm btn-outline-danger" id="abHotkeyClear">Clear</button>
                <div class="d-flex gap-2">
                    <button type="button" class="btn btn-sm btn-secondary" data-ab-modal-close>Cancel</button>
                    <button type="button" class="btn btn-sm btn-primary" id="abHotkeyOk" ${captured && !isBlockedHotkey(captured) ? '' : 'disabled'}>Ok</button>
                </div>
            </div>
        </div>
        `
    );
    if (!m) return;

    const display = /** @type {HTMLElement} */ (m.body.querySelector('#abHotkeyDisplay'));
    const warn = /** @type {HTMLElement} */ (m.body.querySelector('#abHotkeyWarn'));
    const btnOk = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abHotkeyOk'));
    const btnClear = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abHotkeyClear'));

    const paintWarn = () => {
        warn.innerHTML = '';
        btnOk.disabled = true;
        if (!captured) return;
        if (isBlockedHotkey(captured)) {
            warn.innerHTML = `<div class="alert alert-danger py-1 px-2 small mb-0">Key <strong>${escapeHtml(captured)}</strong> is reserved and cannot be bound.</div>`;
            return;
        }
        let html = '';
        const barConflict = deps.checkHotkeyConflict(captured, slot.id);
        if (barConflict) {
            html += `<div class="alert alert-warning py-1 px-2 small mb-1">Already on <strong>slot ${barConflict.index + 1}</strong> (${escapeHtml(barConflict.id)}). Ok steals the binding.</div>`;
        }
        const gen = findGeneralHotkeyConflict(captured);
        if (gen) {
            html += `<div class="alert alert-warning py-1 px-2 small mb-0">Also used as general shortcut <strong>${escapeHtml(gen)}</strong>. Action-bar binding still allowed (general keys take priority when both fire).</div>`;
        }
        warn.innerHTML = html;
        btnOk.disabled = false;
    };

    paintWarn();

    hotkeyCaptureHandler = (ev) => {
        if (!capturing) return;
        if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta') {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.key === 'Escape') {
            // Cancel modal without applying
            closeModal();
            return;
        }
        const raw = eventToHotkeyString(ev);
        if (!raw) return;
        captured = deps.normalizeHotkey(raw);
        display.textContent = captured || '';
        paintWarn();
    };
    document.addEventListener('keydown', hotkeyCaptureHandler, { capture: true });

    btnClear.addEventListener('click', () => {
        deps.assignSlot(slot.id, slot.actionType || 'empty', {
            itemId: slot.itemId,
            spellId: slot.spellId,
            command: slot.command,
            text: slot.text,
            passiveId: slot.passiveId,
            multiActions: slot.multiActions,
            targetMode: slot.targetMode,
            hotkey: ''
        });
        closeModal();
    });

    btnOk.addEventListener('click', () => {
        if (!captured || isBlockedHotkey(captured)) return;
        // assignSlot steals conflicting bar hotkeys
        deps.assignSlot(slot.id, slot.actionType || 'empty', {
            itemId: slot.itemId,
            spellId: slot.spellId,
            command: slot.command,
            text: slot.text,
            passiveId: slot.passiveId,
            multiActions: slot.multiActions,
            targetMode: slot.targetMode,
            hotkey: captured
        });
        closeModal();
    });
}

/**
 * Roman labels for multi sub-slots (I / II / III).
 * @param {number} index0
 * @returns {string}
 */
function multiSubLabel(index0) {
    const labels = ['I', 'II', 'III'];
    return labels[index0] || String(index0 + 1);
}

/**
 * Normalize draft multi sub-actions for the assign UI (depth 3).
 * @param {object[]|null|undefined} raw
 * @returns {object[]}
 */
function draftMultiActions(raw) {
    const out = [];
    for (let i = 0; i < 3; i++) {
        const r = Array.isArray(raw) ? raw[i] : null;
        if (!r || typeof r !== 'object' || r.actionType === 'empty' || !r.actionType) {
            out.push({
                actionType: 'empty',
                itemId: null,
                spellId: null,
                text: null,
                targetMode: 'smart_target'
            });
            continue;
        }
        const t = r.actionType === 'item' || r.actionType === 'spell' || r.actionType === 'text'
            ? r.actionType
            : 'empty';
        out.push({
            actionType: t,
            itemId: t === 'item' && r.itemId != null ? String(r.itemId) : null,
            spellId: t === 'spell' && r.spellId != null ? String(r.spellId) : null,
            text: t === 'text' && r.text != null ? String(r.text) : null,
            targetMode:
                r.targetMode === 'cursor_prompt' ||
                r.targetMode === 'self' ||
                r.targetMode === 'active_target'
                    ? r.targetMode
                    : 'smart_target'
        });
    }
    return out;
}

/**
 * Human summary for a multi draft sub-row.
 * @param {object} sub
 * @returns {string}
 */
function multiSubSummary(sub) {
    if (!sub || sub.actionType === 'empty') return 'Empty';
    if (sub.actionType === 'spell') return sub.spellId ? `Spell: ${sub.spellId}` : 'Spell (none)';
    if (sub.actionType === 'item') return sub.itemId ? `Object: ${sub.itemId}` : 'Object (none)';
    if (sub.actionType === 'text') {
        const t = sub.text ? String(sub.text) : '';
        if (!t) return 'Text (none)';
        return t.length > 36 ? `Text: ${t.slice(0, 36)}…` : `Text: ${t}`;
    }
    return sub.actionType;
}

/**
 * Assign / edit multi-action (3 sub-slots: spell, object, or text).
 * @param {object} slot
 * @param {ActionBarModalDeps} deps
 */
function openAssignMultiModal(slot, deps) {
    if (!slot || !deps) return;
    const draft = draftMultiActions(
        slot.actionType === 'multi' && Array.isArray(slot.multiActions)
            ? slot.multiActions
            : null
    );
    /** @type {number|null} index being edited in nested picker, or null on main form */
    let editIndex = null;
    /** @type {'spell'|'item'|'text'|null} */
    let editKind = null;

    const renderMain = () => {
        editIndex = null;
        editKind = null;
        let rows = '';
        for (let i = 0; i < draft.length; i++) {
            const sub = draft[i];
            const summary = multiSubSummary(sub);
            rows += `
                <div class="action-bar-multi-row" data-multi-idx="${i}">
                    <div class="action-bar-multi-row-head">
                        <span class="action-bar-multi-roman">${multiSubLabel(i)}</span>
                        <span class="action-bar-multi-summary font-monospace small">${escapeHtml(summary)}</span>
                    </div>
                    <div class="action-bar-multi-row-actions btn-group btn-group-sm" role="group">
                        <button type="button" class="btn btn-outline-warning" data-multi-spell="${i}" title="Set spell">Spell</button>
                        <button type="button" class="btn btn-outline-info" data-multi-item="${i}" title="Set object">Object</button>
                        <button type="button" class="btn btn-outline-secondary" data-multi-text="${i}" title="Set text">Text</button>
                        <button type="button" class="btn btn-outline-danger" data-multi-clear="${i}" title="Clear sub-slot">Clear</button>
                    </div>
                </div>
            `;
        }
        const m = openModal(
            `Assign Multi-Action — slot ${slot.index + 1}`,
            `
            <div class="action-bar-assign-form action-bar-multi-form">
                <p class="text-muted small mb-2">
                    Up to three sub-actions. On use, the bar rotates to the first ready action
                    (skips cooldowns, empty slots, and items with no stack).
                </p>
                <div class="action-bar-multi-rows mb-3">${rows}</div>
                <div class="d-flex justify-content-end gap-2">
                    <button type="button" class="btn btn-sm btn-secondary" data-ab-modal-close>Cancel</button>
                    <button type="button" class="btn btn-sm btn-outline-primary" id="abMultiApply">Apply</button>
                    <button type="button" class="btn btn-sm btn-primary" id="abMultiOk">Ok</button>
                </div>
            </div>
            `
        );
        if (!m) return;

        const save = () => {
            // Drop trailing empties are fine — assignSlot normalizes to depth 3
            const hasAny = draft.some(
                (s) =>
                    s &&
                    s.actionType !== 'empty' &&
                    ((s.actionType === 'spell' && s.spellId) ||
                        (s.actionType === 'item' && s.itemId) ||
                        (s.actionType === 'text' && s.text && String(s.text).trim()))
            );
            if (!hasAny) return false;
            return deps.assignSlot(slot.id, 'multi', {
                multiActions: draft.map((s) => ({
                    actionType: s.actionType,
                    itemId: s.itemId,
                    spellId: s.spellId,
                    text: s.text,
                    targetMode: s.targetMode
                })),
                hotkey: slot.hotkey || ''
            });
        };

        m.body.querySelectorAll('[data-multi-spell]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-multi-spell'));
                if (!Number.isFinite(idx)) return;
                renderSpellPicker(idx);
            });
        });
        m.body.querySelectorAll('[data-multi-item]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-multi-item'));
                if (!Number.isFinite(idx)) return;
                renderItemPicker(idx);
            });
        });
        m.body.querySelectorAll('[data-multi-text]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-multi-text'));
                if (!Number.isFinite(idx)) return;
                renderTextPicker(idx);
            });
        });
        m.body.querySelectorAll('[data-multi-clear]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.getAttribute('data-multi-clear'));
                if (!Number.isFinite(idx) || idx < 0 || idx >= draft.length) return;
                draft[idx] = {
                    actionType: 'empty',
                    itemId: null,
                    spellId: null,
                    text: null,
                    targetMode: 'smart_target'
                };
                renderMain();
            });
        });
        m.body.querySelector('#abMultiApply').addEventListener('click', () => {
            save();
        });
        m.body.querySelector('#abMultiOk').addEventListener('click', () => {
            if (save()) closeModal();
        });
    };

    /**
     * @param {number} idx
     */
    const renderSpellPicker = (idx) => {
        editIndex = idx;
        editKind = 'spell';
        const raw = deps.getSpellBook ? deps.getSpellBook() : null;
        const allSpells = spellBookToList(raw);
        const profileId = deps.getActiveProfileId ? deps.getActiveProfileId() : '';
        const player = deps.getActivePlayer ? deps.getActivePlayer() : null;
        const vocation =
            profileId ||
            (player && (player.classId || player.vocation)) ||
            '';
        let selectedId =
            draft[idx] && draft[idx].actionType === 'spell' && draft[idx].spellId
                ? String(draft[idx].spellId)
                : '';
        let targetMode =
            draft[idx] && draft[idx].targetMode ? draft[idx].targetMode : 'smart_target';
        let showAll = false;
        let sort = 'name';
        let query = '';

        const m = openModal(
            `Multi ${multiSubLabel(idx)} — Spell`,
            `
            <div class="action-bar-assign-form">
                <div class="d-flex flex-wrap gap-2 mb-2 align-items-center">
                    <input type="search" id="abMultiSpellSearch" class="form-control form-control-sm bg-dark text-light border-secondary flex-grow-1"
                        placeholder="Search name / id…" value="" autocomplete="off">
                    <select id="abMultiSpellSort" class="form-select form-select-sm bg-dark text-light border-secondary" style="max-width:8rem;">
                        <option value="name">Name</option>
                        <option value="level">Level</option>
                        <option value="group">Group</option>
                    </select>
                </div>
                <div class="form-check mb-2">
                    <input class="form-check-input" type="checkbox" id="abMultiSpellShowAll">
                    <label class="form-check-label text-muted small" for="abMultiSpellShowAll">Show all classes</label>
                </div>
                <div id="abMultiSpellList" class="action-bar-assign-list mb-2" role="listbox"></div>
                <div class="mb-3">
                    <label class="form-label text-muted small mb-1">Targeting</label>
                    <select id="abMultiSpellTarget" class="form-select form-select-sm bg-dark text-light border-secondary">
                        <option value="smart_target">Smart Cast (max hits)</option>
                        <option value="active_target">Active Target</option>
                        <option value="cursor_prompt">Cursor prompt</option>
                        <option value="self">Self</option>
                    </select>
                </div>
                <div class="d-flex justify-content-between gap-2">
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="abMultiSpellBack">Back</button>
                    <button type="button" class="btn btn-sm btn-primary" id="abMultiSpellOk" disabled>Set spell</button>
                </div>
            </div>
            `
        );
        if (!m) return;
        const listEl = /** @type {HTMLElement} */ (m.body.querySelector('#abMultiSpellList'));
        const searchEl = /** @type {HTMLInputElement} */ (m.body.querySelector('#abMultiSpellSearch'));
        const sortEl = /** @type {HTMLSelectElement} */ (m.body.querySelector('#abMultiSpellSort'));
        const showAllEl = /** @type {HTMLInputElement} */ (m.body.querySelector('#abMultiSpellShowAll'));
        const targetEl = /** @type {HTMLSelectElement} */ (m.body.querySelector('#abMultiSpellTarget'));
        const btnOk = /** @type {HTMLButtonElement} */ (m.body.querySelector('#abMultiSpellOk'));
        targetEl.value = targetMode;

        const paintList = () => {
            const filtered = filterSpells(allSpells, {
                query,
                vocation: String(vocation || ''),
                showAll,
                sort: /** @type {any} */ (sort)
            });
            listEl.innerHTML = '';
            if (!filtered.length) {
                listEl.innerHTML = '<div class="text-muted small p-2 text-center">No matching spells.</div>';
                return;
            }
            for (let i = 0; i < filtered.length; i++) {
                const sp = filtered[i];
                const id = String(sp.id);
                const name = sp.label || sp.name || id;
                const row = document.createElement('button');
                row.type = 'button';
                row.className =
                    'action-bar-assign-list-item' + (selectedId === id ? ' is-selected' : '');
                row.innerHTML = `
                    <span class="ab-spell-name"><i class="fa-solid fa-wand-magic-sparkles text-warning me-1"></i>${escapeHtml(String(name))}</span>
                    <span class="ab-spell-meta font-monospace text-muted">${escapeHtml(id)}</span>
                `;
                row.addEventListener('click', () => {
                    selectedId = id;
                    paintList();
                    btnOk.disabled = false;
                });
                listEl.appendChild(row);
            }
        };

        searchEl.addEventListener('input', () => {
            query = searchEl.value || '';
            paintList();
        });
        sortEl.addEventListener('change', () => {
            sort = sortEl.value || 'name';
            paintList();
        });
        showAllEl.addEventListener('change', () => {
            showAll = !!showAllEl.checked;
            paintList();
        });
        m.body.querySelector('#abMultiSpellBack').addEventListener('click', () => {
            renderMain();
        });
        btnOk.addEventListener('click', () => {
            if (!selectedId) return;
            draft[idx] = {
                actionType: 'spell',
                spellId: selectedId,
                itemId: null,
                text: null,
                targetMode: targetEl.value || 'smart_target'
            };
            renderMain();
        });
        if (selectedId) btnOk.disabled = false;
        paintList();
        searchEl.focus();
    };

    /**
     * @param {number} idx
     * @param {string} [prefillItemId]
     */
    const renderItemPicker = (idx, prefillItemId) => {
        editIndex = idx;
        editKind = 'item';
        let itemId =
            prefillItemId != null && prefillItemId !== ''
                ? String(prefillItemId)
                : draft[idx] && draft[idx].actionType === 'item' && draft[idx].itemId
                  ? String(draft[idx].itemId)
                  : '';
        let targetMode =
            draft[idx] && draft[idx].targetMode ? draft[idx].targetMode : 'smart_target';

        const m = openModal(
            `Multi ${multiSubLabel(idx)} — Object`,
            `
            <div class="action-bar-assign-form">
                <div class="d-flex gap-2 mb-2">
                    <button type="button" class="btn btn-sm btn-outline-info" id="abMultiObjPick">
                        <i class="fa-solid fa-crosshairs me-1"></i>Pick from inventory
                    </button>
                </div>
                <div class="mb-2">
                    <label class="form-label text-muted small mb-1">Item template id</label>
                    <input type="text" id="abMultiObjItemId" class="form-control form-control-sm bg-dark text-light border-secondary font-monospace"
                        value="${escapeHtml(itemId)}" autocomplete="off">
                </div>
                <div class="mb-3">
                    <label class="form-label text-muted small mb-1">Use mode</label>
                    <select id="abMultiObjTarget" class="form-select form-select-sm bg-dark text-light border-secondary">
                        <option value="smart_target">Smart Cast (max hits)</option>
                        <option value="active_target">Active Target</option>
                        <option value="cursor_prompt">Select target (crosshair)</option>
                        <option value="self">Use on yourself</option>
                    </select>
                </div>
                <div class="d-flex justify-content-between gap-2">
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="abMultiObjBack">Back</button>
                    <button type="button" class="btn btn-sm btn-primary" id="abMultiObjOk">Set object</button>
                </div>
            </div>
            `
        );
        if (!m) return;
        const idEl = /** @type {HTMLInputElement} */ (m.body.querySelector('#abMultiObjItemId'));
        const targetEl = /** @type {HTMLSelectElement} */ (m.body.querySelector('#abMultiObjTarget'));
        targetEl.value = targetMode;

        m.body.querySelector('#abMultiObjPick').addEventListener('click', () => {
            closeModal();
            startItemPickMode({
                onPick: (pickedId) => {
                    renderItemPicker(idx, pickedId);
                },
                onCancel: () => {
                    renderItemPicker(idx, itemId);
                },
                getActivePlayer: deps.getActivePlayer
            });
        });
        m.body.querySelector('#abMultiObjBack').addEventListener('click', () => {
            renderMain();
        });
        m.body.querySelector('#abMultiObjOk').addEventListener('click', () => {
            const id = (idEl.value || '').trim();
            if (!id) return;
            draft[idx] = {
                actionType: 'item',
                itemId: id,
                spellId: null,
                text: null,
                targetMode: targetEl.value || 'smart_target'
            };
            renderMain();
        });
        idEl.focus();
        idEl.select();
    };

    /**
     * @param {number} idx
     */
    const renderTextPicker = (idx) => {
        editIndex = idx;
        editKind = 'text';
        const initial =
            draft[idx] && draft[idx].actionType === 'text' && draft[idx].text != null
                ? String(draft[idx].text)
                : '';
        const m = openModal(
            `Multi ${multiSubLabel(idx)} — Text`,
            `
            <div class="action-bar-assign-form">
                <div class="mb-3">
                    <label class="form-label text-muted small mb-1">Text (FCT)</label>
                    <textarea id="abMultiTextBody" class="form-control form-control-sm bg-dark text-light border-secondary" rows="3"
                        maxlength="${TEXT_MAX_LEN}">${escapeHtml(initial)}</textarea>
                </div>
                <div class="d-flex justify-content-between gap-2">
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="abMultiTextBack">Back</button>
                    <button type="button" class="btn btn-sm btn-primary" id="abMultiTextOk">Set text</button>
                </div>
            </div>
            `
        );
        if (!m) return;
        const ta = /** @type {HTMLTextAreaElement} */ (m.body.querySelector('#abMultiTextBody'));
        m.body.querySelector('#abMultiTextBack').addEventListener('click', () => {
            renderMain();
        });
        m.body.querySelector('#abMultiTextOk').addEventListener('click', () => {
            const text = (ta.value || '').slice(0, TEXT_MAX_LEN);
            if (!text.trim()) return;
            draft[idx] = {
                actionType: 'text',
                text,
                itemId: null,
                spellId: null,
                targetMode: 'smart_target'
            };
            renderMain();
        });
        ta.focus();
    };

    // Silence unused (kept for future nested focus restore)
    void editIndex;
    void editKind;

    renderMain();
}

/**
 * Emit watch-mode FCT above a player (text / passive stubs).
 * @param {object|null|undefined} player
 * @param {string} text
 * @param {string} [color]
 * @param {object|null|undefined} [sim]
 */
function emitActionBarFloat(player, text, color, sim) {
    if (!text) return;
    let s = sim;
    if (!s && player && player.level && typeof player.level.emitCombatText === 'function') {
        s = player.level;
    }
    if (!s || typeof s.emitCombatText !== 'function') return;
    const tile = player && player.tile ? player.tile : null;
    s.emitCombatText({
        x: tile ? tile.x : 0,
        y: tile ? tile.y : 0,
        z: tile && tile.z !== undefined && tile.z !== null ? tile.z : undefined,
        text: String(text),
        color: color || '#93c5fd',
        life: 1.2
    });
}

module.exports = {
    TEXT_MAX_LEN,
    KNOWN_PASSIVES,
    spellBookToList,
    filterSpells,
    listKnownPassives,
    isBlockedHotkey,
    findGeneralHotkeyConflict,
    eventToHotkeyString,
    showSlotContextMenu,
    hideSlotContextMenu,
    openAssignSpellModal,
    openAssignObjectModal,
    openAssignTextModal,
    openAssignPassiveModal,
    openAssignHotkeyModal,
    openAssignMultiModal,
    draftMultiActions,
    multiSubLabel,
    multiSubSummary,
    startItemPickMode,
    cancelItemPickMode,
    closeModal,
    emitActionBarFloat
};
