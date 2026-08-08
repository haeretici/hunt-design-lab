/**
 * Action Bar & Keymaps Config Popup interface script.
 * Handles interactive slot editing, key capture with conflict detection,
 * drag and drop binding from catalogs, and syncing with parent game window.
 * Stage F: spell filter/sort/bound badges, multi/text/passive inspector,
 * layoutCounts read-only mirror, conflict UX aligned with in-game hotkey modal.
 * Stage G: per-bar lock / clear, locked inspector gate.
 */

'use strict';

(function () {
    const CHANNEL = 'hunt-design-lab-action-bar';

    /** Bare keys that must not bind as action-bar hotkeys (movement / reserved). Stage B parity. */
    const BLOCKED_BARE_KEYS = new Set([
        'ESCAPE', 'TAB', 'ENTER',
        'ARROWUP', 'ARROWDOWN', 'ARROWLEFT', 'ARROWRIGHT',
        'W', 'A', 'S', 'D'
    ]);
    const BLOCKED_ALWAYS = new Set(['ESCAPE', 'TAB']);

    /** Stub passives until a real passive combat subsystem exists. */
    const KNOWN_PASSIVES = [
        { id: 'gift_of_life', label: 'Gift of Life', description: 'Not available in combat yet (stub).' }
    ];

    const TEXT_MAX_LEN = 255;

    let appState = {
        activeProfileId: 'guardian',
        activePlayerClass: 'guardian',
        docks: {},
        layoutCounts: { top: 1, bottom: 1, left: 1, right: 1 },
        profiles: [],
        spellBook: {},
        itemDb: [],
        genre: 'rpg_fantasy',
        generalHotkeys: {
            moveNorth: ['ARROWUP', 'W'],
            moveSouth: ['ARROWDOWN', 'S'],
            moveWest: ['ARROWLEFT', 'A'],
            moveEast: ['ARROWRIGHT', 'D'],
            moveNorthWest: [],
            moveNorthEast: [],
            moveSouthWest: [],
            moveSouthEast: [],
            targetNext: ['SPACE', 'SPACEBAR', ' '],
            targetPrev: ['SHIFT+SPACE', 'SHIFT+SPACEBAR', 'SHIFT+ '],
            toggleAutoChase: ['T', 'KEYT'],
            stopAutowalk: ['ESCAPE']
        }
    };

    let currentDock = 'top';
    let currentCatalog = 'spells';
    let currentMainTab = 'action_bars';
    let selectedSlotId = null;
    let isCapturingKey = false;
    let isCapturingGeneralKey = null;

    function normalizeHotkey(str) {
        if (!str || typeof str !== 'string') return '';
        const parts = str.toUpperCase().split('+').map(p => p.trim()).filter(Boolean);
        const mods = [];
        let key = '';
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p === 'CTRL' || p === 'CONTROL') {
                if (mods.indexOf('CTRL') === -1) mods.push('CTRL');
            } else if (p === 'SHIFT') {
                if (mods.indexOf('SHIFT') === -1) mods.push('SHIFT');
            } else if (p === 'ALT') {
                if (mods.indexOf('ALT') === -1) mods.push('ALT');
            } else {
                key = p;
            }
        }
        mods.sort();
        if (!key) return mods.join('+');
        return mods.length ? `${mods.join('+')}+${key}` : key;
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isBlockedHotkey(hotkey) {
        const n = String(hotkey || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!n) return true;
        const parts = n.split('+');
        const base = parts[parts.length - 1] || '';
        if (BLOCKED_ALWAYS.has(base) || BLOCKED_ALWAYS.has(n)) return true;
        if (parts.length === 1 && BLOCKED_BARE_KEYS.has(base)) return true;
        return false;
    }

    function findGeneralHotkeyConflict(hotkey, shortcuts) {
        const n = String(hotkey || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!n) return null;
        const sc = shortcuts || appState.generalHotkeys || null;
        if (!sc || typeof sc !== 'object') return null;
        const keys = Object.keys(sc);
        for (let i = 0; i < keys.length; i++) {
            const action = keys[i];
            const arr = sc[action];
            if (!Array.isArray(arr)) continue;
            for (let j = 0; j < arr.length; j++) {
                const stored = String(arr[j] || '').trim().toUpperCase().replace(/\s+/g, '');
                if (stored && stored === n) return action;
            }
        }
        return null;
    }

    function eventToHotkeyString(ev) {
        if (!ev || !ev.key) return '';
        const key = ev.key;
        if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return '';
        let keyName = key.toUpperCase();
        if (key === ' ' || key === 'Spacebar') keyName = 'SPACE';
        else if (ev.code && ev.code.startsWith('Digit') && key.length === 1) keyName = ev.code.slice(5);
        else if (ev.code && ev.code.startsWith('Numpad')) keyName = ev.code.toUpperCase();
        else if (ev.code && ev.code.startsWith('Key') && key.length === 1) keyName = ev.code.slice(3);
        const mods = [];
        if (ev.ctrlKey && key !== 'Control') mods.push('CTRL');
        if (ev.shiftKey && key !== 'Shift') mods.push('SHIFT');
        if (ev.altKey && key !== 'Alt') mods.push('ALT');
        return mods.length ? `${mods.join('+')}+${keyName}` : keyName;
    }

    function postToParent(msg) {
        if (!window.opener || window.opener.closed) return;
        try {
            window.opener.postMessage(
                { channel: CHANNEL, ...msg },
                window.location.origin
            );
        } catch (err) {
            console.warn('Action bar config postMessage failed:', err);
        }
    }

    function findSlotById(slotId) {
        if (!slotId || !appState.docks) return null;
        const areas = Object.keys(appState.docks);
        for (let i = 0; i < areas.length; i++) {
            const bars = appState.docks[areas[i]];
            if (!Array.isArray(bars)) continue;
            for (let j = 0; j < bars.length; j++) {
                const bar = bars[j];
                for (let k = 0; k < (bar.slots || []).length; k++) {
                    if (bar.slots[k].id === slotId) return bar.slots[k];
                }
            }
        }
        return null;
    }

    function findBarForSlotId(slotId) {
        if (!slotId || !appState.docks) return null;
        const areas = Object.keys(appState.docks);
        for (let i = 0; i < areas.length; i++) {
            const bars = appState.docks[areas[i]];
            if (!Array.isArray(bars)) continue;
            for (let j = 0; j < bars.length; j++) {
                const bar = bars[j];
                if (!bar || !Array.isArray(bar.slots)) continue;
                for (let k = 0; k < bar.slots.length; k++) {
                    if (bar.slots[k] && bar.slots[k].id === slotId) return bar;
                }
            }
        }
        return null;
    }

    function isSlotBarLocked(slotId) {
        const bar = findBarForSlotId(slotId);
        return !!(bar && bar.locked);
    }

    function postSetBarLocked(barId, locked) {
        postToParent({ type: 'set_bar_locked', barId, locked: !!locked });
    }

    function postClearBar(barId, clearHotkeys) {
        postToParent({ type: 'clear_bar', barId, clearHotkeys: !!clearHotkeys });
    }

    function checkConflict(hotkey, excludeSlotId) {
        const norm = normalizeHotkey(hotkey);
        if (!norm) return null;
        const areas = Object.keys(appState.docks || {});
        for (let i = 0; i < areas.length; i++) {
            const bars = appState.docks[areas[i]];
            if (!Array.isArray(bars)) continue;
            for (let j = 0; j < bars.length; j++) {
                const bar = bars[j];
                for (let k = 0; k < (bar.slots || []).length; k++) {
                    const slot = bar.slots[k];
                    if (slot.id !== excludeSlotId && slot.hotkey && normalizeHotkey(slot.hotkey) === norm) {
                        return slot;
                    }
                }
            }
        }
        return null;
    }

    /**
     * Build assign cfg from a slot, preserving multi/text/passive fields.
     * @param {object} slot
     * @param {object} [overrides]
     */
    function slotCfgFromSlot(slot, overrides) {
        const cfg = {
            targetMode: (slot && slot.targetMode) || 'smart_target',
            hotkey: (slot && slot.hotkey) || '',
            itemId: slot ? slot.itemId : null,
            spellId: slot ? slot.spellId : null,
            command: slot ? slot.command : null,
            text: slot ? slot.text : null,
            passiveId: slot ? slot.passiveId : null,
            multiActions: slot && Array.isArray(slot.multiActions) ? slot.multiActions : null
        };
        if (overrides && typeof overrides === 'object') {
            Object.keys(overrides).forEach((k) => {
                cfg[k] = overrides[k];
            });
        }
        return cfg;
    }

    function postAssign(slotId, actionType, cfg) {
        if (isSlotBarLocked(slotId)) return;
        postToParent({ type: 'assign_slot', slotId, actionType, cfg });
    }

    function spellLabel(spellId) {
        if (!spellId) return '';
        const raw = appState.spellBook || {};
        if (Array.isArray(raw)) {
            const match = raw.find(s => s && s.id === spellId);
            if (match) return match.label || match.name || spellId;
        } else if (raw[spellId]) {
            const s = raw[spellId];
            return s.label || s.name || spellId;
        }
        return String(spellId);
    }

    function itemLabel(itemId) {
        if (!itemId) return '';
        if (Array.isArray(appState.itemDb)) {
            const match = appState.itemDb.find(it => it && it.id === itemId);
            if (match) return match.label || match.name || itemId;
        }
        return String(itemId);
    }

    function slotDisplayName(slot) {
        if (!slot) return 'Empty';
        if (slot.actionType === 'item' && slot.itemId) return itemLabel(slot.itemId);
        if (slot.actionType === 'spell' && slot.spellId) return spellLabel(slot.spellId);
        if (slot.actionType === 'command' && slot.command) return `CMD: ${slot.command}`;
        if (slot.actionType === 'text' && slot.text) {
            const t = String(slot.text);
            return t.length > 28 ? `${t.slice(0, 28)}…` : t;
        }
        if (slot.actionType === 'passive' && slot.passiveId) return slot.passiveId;
        if (slot.actionType === 'multi') {
            const filled = Array.isArray(slot.multiActions)
                ? slot.multiActions.filter(s => s && s.actionType !== 'empty').length
                : 0;
            return `Multi (${filled}/3)`;
        }
        return 'Empty Slot';
    }

    /** Spell ids currently bound on any bar in the active profile. */
    function collectBoundSpellIds() {
        const set = new Set();
        const areas = Object.keys(appState.docks || {});
        for (let i = 0; i < areas.length; i++) {
            const bars = appState.docks[areas[i]];
            if (!Array.isArray(bars)) continue;
            for (let j = 0; j < bars.length; j++) {
                const slots = bars[j].slots || [];
                for (let k = 0; k < slots.length; k++) {
                    const s = slots[k];
                    if (s.actionType === 'spell' && s.spellId) set.add(String(s.spellId));
                    if (s.actionType === 'multi' && Array.isArray(s.multiActions)) {
                        for (let m = 0; m < s.multiActions.length; m++) {
                            const sub = s.multiActions[m];
                            if (sub && sub.actionType === 'spell' && sub.spellId) {
                                set.add(String(sub.spellId));
                            }
                        }
                    }
                }
            }
        }
        return set;
    }

    function spellBookToList(spellBook) {
        if (!spellBook) return [];
        if (Array.isArray(spellBook)) {
            return spellBook.filter(s => s && s.id).map(s => Object.assign({}, s, { id: String(s.id) }));
        }
        if (typeof spellBook === 'object') {
            return Object.keys(spellBook).map(key => {
                const sp = spellBook[key] || {};
                const id = sp.id != null && sp.id !== '' ? String(sp.id) : String(key);
                return Object.assign({}, sp, { id });
            });
        }
        return [];
    }

    /**
     * Filter + sort spells (aligned with action_bar_modals.filterSpells + bound filter).
     */
    function filterSpellsList(spells, opts) {
        const o = opts || {};
        const query = o.query != null ? String(o.query).trim().toLowerCase() : '';
        const showAll = !!o.showAll;
        const vocation = o.vocation != null ? String(o.vocation).trim().toLowerCase() : '';
        const sort = o.sort === 'level' || o.sort === 'group' ? o.sort : 'name';
        const kind = o.kind && o.kind !== 'all' ? String(o.kind).toLowerCase() : '';
        const boundFilter = o.boundFilter || 'all';
        const boundIds = o.boundIds || new Set();

        let list = Array.isArray(spells) ? spells.slice() : [];
        list = list.filter(sp => sp && sp.id);

        if (!showAll && vocation && vocation !== 'default' && vocation !== 'common') {
            list = list.filter(sp => {
                const vocs = sp.vocations;
                if (!Array.isArray(vocs) || vocs.length === 0) return true;
                for (let i = 0; i < vocs.length; i++) {
                    if (String(vocs[i]).toLowerCase() === vocation) return true;
                }
                return false;
            });
        }

        if (kind) {
            list = list.filter(sp => {
                const g = String(sp.group || sp.kind || '').toLowerCase();
                return g === kind;
            });
        }

        if (boundFilter === 'bound') {
            list = list.filter(sp => boundIds.has(String(sp.id)));
        } else if (boundFilter === 'unbound') {
            list = list.filter(sp => !boundIds.has(String(sp.id)));
        }

        if (query) {
            list = list.filter(sp => {
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

    function updateProfileSelect() {
        const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('profileSelect'));
        if (sel && appState.activeProfileId) {
            const val = appState.activeProfileId.toLowerCase();
            let opt = sel.querySelector(`option[value="${val}"]`);
            if (!opt && val && val !== 'undefined') {
                opt = document.createElement('option');
                opt.value = val;
                opt.textContent = val.charAt(0).toUpperCase() + val.slice(1);
                sel.appendChild(opt);
            }
            sel.value = val;
        }
    }

    function renderLayoutCounts() {
        const lc = appState.layoutCounts || { top: 1, bottom: 1, left: 1, right: 1 };
        const text = document.getElementById('layoutCountsText');
        if (text) {
            text.textContent =
                `Top ${lc.top ?? 1} · Bottom ${lc.bottom ?? 1} · Left ${lc.left ?? 1} · Right ${lc.right ?? 1}`;
        }
        document.querySelectorAll('[data-dock-count]').forEach(el => {
            const dock = el.getAttribute('data-dock-count');
            const n = lc[dock] != null ? lc[dock] : 1;
            el.textContent = String(n);
        });
    }

    function getSlotListFilters() {
        const searchEl = /** @type {HTMLInputElement|null} */ (document.getElementById('slotSearchInput'));
        const typeEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('slotTypeFilter'));
        const sortEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('slotSortSelect'));
        return {
            query: searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : '',
            type: typeEl && typeEl.value ? typeEl.value : 'all',
            sort: sortEl && sortEl.value ? sortEl.value : 'index'
        };
    }

    function renderBarToolbar() {
        const host = document.getElementById('barToolbar');
        if (!host) return;
        host.innerHTML = '';
        const bars = (appState.docks && appState.docks[currentDock]) || [];
        if (!bars.length) return;

        bars.forEach((bar, barIdx) => {
            const row = document.createElement('div');
            row.className = 'd-flex align-items-center justify-content-between gap-2 border border-secondary rounded px-2 py-1 bg-black';
            if (bar.locked) row.classList.add('border-warning');

            const left = document.createElement('div');
            left.className = 'small text-light font-monospace';
            left.innerHTML = bar.locked
                ? `<i class="fa-solid fa-lock text-warning me-1" aria-hidden="true"></i>Bar ${barIdx + 1} <span class="text-muted text-xxs">(${escapeHtml(bar.id)})</span> <span class="badge bg-warning text-dark text-xxs ms-1">Locked</span>`
                : `<i class="fa-solid fa-lock-open text-muted me-1" aria-hidden="true"></i>Bar ${barIdx + 1} <span class="text-muted text-xxs">(${escapeHtml(bar.id)})</span>`;

            const actions = document.createElement('div');
            actions.className = 'd-flex gap-1 flex-shrink-0';

            const lockBtn = document.createElement('button');
            lockBtn.type = 'button';
            lockBtn.className = 'btn btn-sm ' + (bar.locked ? 'btn-warning' : 'btn-outline-secondary');
            lockBtn.setAttribute('aria-pressed', bar.locked ? 'true' : 'false');
            lockBtn.setAttribute('aria-label', bar.locked ? `Unlock bar ${barIdx + 1}` : `Lock bar ${barIdx + 1}`);
            lockBtn.title = bar.locked ? 'Unlock (allow assign)' : 'Lock (block assign; execute still works)';
            lockBtn.innerHTML = bar.locked
                ? '<i class="fa-solid fa-lock" aria-hidden="true"></i> Unlock'
                : '<i class="fa-solid fa-lock-open" aria-hidden="true"></i> Lock';
            lockBtn.addEventListener('click', () => {
                postSetBarLocked(bar.id, !bar.locked);
            });

            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'btn btn-sm btn-outline-danger';
            clearBtn.disabled = !!bar.locked;
            clearBtn.setAttribute('aria-label', `Clear all actions on bar ${barIdx + 1}`);
            clearBtn.title = bar.locked
                ? 'Unlock the bar before clearing'
                : 'Clear all slot actions (keeps hotkeys)';
            clearBtn.innerHTML = '<i class="fa-solid fa-broom" aria-hidden="true"></i> Clear';
            clearBtn.addEventListener('click', () => {
                if (bar.locked) return;
                const ok = window.confirm(
                    `Clear all actions on Bar ${barIdx + 1} (${bar.id})?\nHotkeys are kept. This cannot be undone from here.`
                );
                if (!ok) return;
                postClearBar(bar.id, false);
                selectedSlotId = null;
            });

            actions.appendChild(lockBtn);
            actions.appendChild(clearBtn);
            row.appendChild(left);
            row.appendChild(actions);
            host.appendChild(row);
        });
    }

    function renderSlotsGrid() {
        const grid = document.getElementById('slotsGrid');
        if (!grid) return;
        grid.innerHTML = '';
        renderLayoutCounts();
        renderBarToolbar();

        const bars = (appState.docks && appState.docks[currentDock]) || [];
        if (!bars.length) {
            grid.innerHTML = '<div class="text-muted small p-3 text-center">No bars configured for this dock. Set counts in Engine Tweakings (0–3 per side).</div>';
            return;
        }

        const filters = getSlotListFilters();
        let entries = [];
        bars.forEach((bar, barIdx) => {
            (bar.slots || []).forEach((slot, idx) => {
                entries.push({ bar, barIdx, slot, idx });
            });
        });

        if (filters.type !== 'all') {
            if (filters.type === 'bound') {
                entries = entries.filter(e => e.slot.hotkey);
            } else if (filters.type === 'unbound') {
                entries = entries.filter(e => !e.slot.hotkey);
            } else {
                entries = entries.filter(e => e.slot.actionType === filters.type);
            }
        }

        if (filters.query) {
            entries = entries.filter(e => {
                const name = slotDisplayName(e.slot).toLowerCase();
                const id = String(e.slot.id || '').toLowerCase();
                const hk = String(e.slot.hotkey || '').toLowerCase();
                const type = String(e.slot.actionType || '').toLowerCase();
                const payload = String(
                    e.slot.spellId || e.slot.itemId || e.slot.command || e.slot.text || e.slot.passiveId || ''
                ).toLowerCase();
                return (
                    name.indexOf(filters.query) >= 0 ||
                    id.indexOf(filters.query) >= 0 ||
                    hk.indexOf(filters.query) >= 0 ||
                    type.indexOf(filters.query) >= 0 ||
                    payload.indexOf(filters.query) >= 0 ||
                    String(e.idx + 1).indexOf(filters.query) >= 0
                );
            });
        }

        if (filters.sort === 'type') {
            entries.sort((a, b) => String(a.slot.actionType).localeCompare(String(b.slot.actionType)) || a.idx - b.idx);
        } else if (filters.sort === 'hotkey') {
            entries.sort((a, b) => String(a.slot.hotkey || '~~~').localeCompare(String(b.slot.hotkey || '~~~')) || a.idx - b.idx);
        } else if (filters.sort === 'name') {
            entries.sort((a, b) => slotDisplayName(a.slot).localeCompare(slotDisplayName(b.slot)) || a.idx - b.idx);
        } else {
            entries.sort((a, b) => a.barIdx - b.barIdx || a.idx - b.idx);
        }

        if (!entries.length) {
            grid.innerHTML = '<div class="text-muted small p-3 text-center">No slots match the current filter.</div>';
            return;
        }

        entries.forEach(({ bar, barIdx, slot, idx }) => {
            const card = document.createElement('div');
            card.className = 'action-slot-card d-flex justify-content-between align-items-center';
            if (slot.id === selectedSlotId) card.classList.add('active');
            if (bar.locked) card.classList.add('opacity-75');
            card.dataset.slotId = slot.id;
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute(
                'aria-label',
                `Bar ${barIdx + 1} slot ${idx + 1}: ${slotDisplayName(slot)}` +
                    (bar.locked ? ' (bar locked)' : '')
            );

            let iconHtml = '<i class="fa-solid fa-circle text-secondary me-2"></i>';
            let actionText = '<span class="text-muted">Empty Slot</span>';
            const type = slot.actionType || 'empty';

            if (type === 'item' && slot.itemId) {
                iconHtml = '<i class="fa-solid fa-flask text-success me-2"></i>';
                actionText = `<span class="fw-semibold text-light">${escapeHtml(itemLabel(slot.itemId))}</span>`;
            } else if (type === 'spell' && slot.spellId) {
                iconHtml = '<i class="fa-solid fa-wand-magic-sparkles text-warning me-2"></i>';
                actionText = `<span class="fw-semibold text-light">${escapeHtml(spellLabel(slot.spellId))}</span>`;
            } else if (type === 'command' && slot.command) {
                iconHtml = '<i class="fa-solid fa-terminal text-info me-2"></i>';
                actionText = `<span class="fw-semibold text-light">CMD: ${escapeHtml(slot.command)}</span>`;
            } else if (type === 'text') {
                iconHtml = '<i class="fa-solid fa-comment-dots text-primary me-2"></i>';
                const t = slot.text ? escapeHtml(String(slot.text).slice(0, 40)) : '<span class="text-muted">Text…</span>';
                actionText = `<span class="fw-semibold text-light">${t}</span>`;
            } else if (type === 'passive') {
                iconHtml = '<i class="fa-solid fa-shield-heart text-danger me-2"></i>';
                actionText = `<span class="fw-semibold text-light">${escapeHtml(slot.passiveId || 'Passive')}</span>`;
            } else if (type === 'multi') {
                iconHtml = '<i class="fa-solid fa-layer-group text-info me-2"></i>';
                const filled = Array.isArray(slot.multiActions)
                    ? slot.multiActions.filter(s => s && s.actionType !== 'empty').length
                    : 0;
                actionText = `<span class="fw-semibold text-light">Multi-Action</span> <span class="badge bg-dark border border-info text-xxs ms-1">${filled}/3</span>`;
            }

            if (type !== 'empty' && type !== 'text' && type !== 'passive' && type !== 'multi' && slot.targetMode) {
                const modeLabel = slot.targetMode === 'smart_target' ? 'Smart Cast'
                    : (slot.targetMode === 'self' ? 'Self' : 'Cursor');
                actionText += ` <span class="badge bg-dark border border-secondary text-xxs ms-1">${modeLabel}</span>`;
            }

            const leftCol = document.createElement('div');
            leftCol.className = 'd-flex align-items-center text-truncate pe-2';
            const barHint = bars.length > 1 ? `<span class="text-muted text-xxs me-1">B${barIdx + 1}</span>` : '';
            leftCol.innerHTML = `${iconHtml}${barHint}<span class="text-muted text-xs me-2">#${idx + 1}</span>${actionText}`;

            const rightCol = document.createElement('div');
            rightCol.className = 'flex-shrink-0';
            rightCol.innerHTML = `<span class="hotkey-badge">${escapeHtml(slot.hotkey || 'No Key')}</span>`;

            card.appendChild(leftCol);
            card.appendChild(rightCol);

            card.addEventListener('click', () => {
                selectedSlotId = slot.id;
                renderSlotsGrid();
                renderInspector();
            });
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    selectedSlotId = slot.id;
                    renderSlotsGrid();
                    renderInspector();
                }
            });

            card.addEventListener('dragover', (ev) => {
                if (bar.locked) return;
                ev.preventDefault();
                card.classList.add('drag-over');
            });
            card.addEventListener('dragleave', () => {
                card.classList.remove('drag-over');
            });
            card.addEventListener('drop', (ev) => {
                ev.preventDefault();
                card.classList.remove('drag-over');
                if (bar.locked) return;
                try {
                    const payload = JSON.parse(ev.dataTransfer.getData('application/json') || '{}');
                    if (payload && (payload.type === 'spell' || payload.type === 'item' || payload.type === 'command')) {
                        const actionType = payload.type;
                        const cfg = slotCfgFromSlot(slot, {
                            targetMode: slot.targetMode || 'smart_target',
                            hotkey: slot.hotkey || '',
                            spellId: null,
                            itemId: null,
                            command: null,
                            text: null,
                            passiveId: null,
                            multiActions: null
                        });
                        if (actionType === 'spell') cfg.spellId = payload.spellId;
                        if (actionType === 'item') cfg.itemId = payload.itemId;
                        if (actionType === 'command') cfg.command = payload.command;
                        postAssign(slot.id, actionType, cfg);
                        selectedSlotId = slot.id;
                    }
                } catch (_) {}
            });

            grid.appendChild(card);
        });
    }

    function emptyMultiActions() {
        return [
            { actionType: 'empty', itemId: null, spellId: null, text: null, targetMode: 'smart_target' },
            { actionType: 'empty', itemId: null, spellId: null, text: null, targetMode: 'smart_target' },
            { actionType: 'empty', itemId: null, spellId: null, text: null, targetMode: 'smart_target' }
        ];
    }

    function renderInspector() {
        const body = document.getElementById('inspectorBody');
        const badge = document.getElementById('inspectorSlotId');
        if (!body || !badge) return;

        const slot = findSlotById(selectedSlotId);
        if (!slot) {
            badge.textContent = 'No Slot Selected';
            body.innerHTML = 'Click a slot in the layout to edit its assignment and bind keys.';
            return;
        }

        const ownerBar = findBarForSlotId(slot.id);
        if (ownerBar && ownerBar.locked) {
            badge.textContent = `Slot: ${slot.id}`;
            body.innerHTML = `
                <div class="text-start">
                    <div class="alert alert-warning border-warning py-2 px-2 small mb-2">
                        <i class="fa-solid fa-lock me-1" aria-hidden="true"></i>
                        This bar is <strong>locked</strong>. Unlock it to edit assignments or hotkeys.
                        In-game execute (click / hotkey) still works.
                    </div>
                    <button type="button" class="btn btn-sm btn-warning" id="inspectorUnlockBarBtn">
                        <i class="fa-solid fa-lock-open me-1" aria-hidden="true"></i>Unlock Bar
                    </button>
                </div>`;
            const unlockBtn = document.getElementById('inspectorUnlockBarBtn');
            if (unlockBtn) {
                unlockBtn.addEventListener('click', () => postSetBarLocked(ownerBar.id, false));
            }
            return;
        }

        badge.textContent = `Slot: ${slot.id}`;
        const at = slot.actionType || 'empty';
        const multi = Array.isArray(slot.multiActions) ? slot.multiActions : emptyMultiActions();
        const multiRows = [0, 1, 2].map(i => {
            const sub = multi[i] || { actionType: 'empty' };
            const st = sub.actionType || 'empty';
            const val = st === 'spell' ? (sub.spellId || '')
                : st === 'item' ? (sub.itemId || '')
                : st === 'text' ? (sub.text || '')
                : '';
            const roman = ['I', 'II', 'III'][i];
            return `
                <div class="border border-secondary rounded p-2 mb-2 multi-sub-row" data-multi-idx="${i}">
                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <span class="text-xxs text-info font-monospace fw-bold">Sub ${roman}</span>
                        <select class="form-select form-select-sm bg-black text-white border-secondary multi-sub-type" style="width: auto; min-width: 7rem;">
                            <option value="empty" ${st === 'empty' ? 'selected' : ''}>Empty</option>
                            <option value="spell" ${st === 'spell' ? 'selected' : ''}>Spell</option>
                            <option value="item" ${st === 'item' ? 'selected' : ''}>Item</option>
                            <option value="text" ${st === 'text' ? 'selected' : ''}>Text</option>
                        </select>
                    </div>
                    <input type="text" class="form-control form-control-sm bg-black text-white border-secondary multi-sub-val mb-1"
                        value="${escapeHtml(val)}" placeholder="spell_id / item_id / text"
                        ${st === 'empty' ? 'disabled' : ''}>
                    <select class="form-select form-select-sm bg-black text-white border-secondary multi-sub-target"
                        style="display: ${st === 'spell' || st === 'item' ? 'block' : 'none'};">
                        <option value="smart_target" ${!sub.targetMode || sub.targetMode === 'smart_target' ? 'selected' : ''}>Smart Cast</option>
                        <option value="cursor_prompt" ${sub.targetMode === 'cursor_prompt' ? 'selected' : ''}>Cursor</option>
                        <option value="self" ${sub.targetMode === 'self' ? 'selected' : ''}>Self</option>
                    </select>
                </div>
            `;
        }).join('');

        const passiveOpts = KNOWN_PASSIVES.map(p =>
            `<option value="${escapeHtml(p.id)}" ${slot.passiveId === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`
        ).join('');

        let html = `
            <div class="d-flex flex-column gap-2 text-start">
                <div>
                    <label class="form-label text-xs text-muted mb-1 d-block">Hotkey Binding</label>
                    <div class="d-flex gap-1">
                        <button id="recordHotkeyBtn" type="button" class="btn btn-sm btn-outline-info flex-grow-1 font-monospace text-center">
                            <i class="fa-solid fa-keyboard me-1"></i> Hotkey: [${escapeHtml(slot.hotkey || 'None')}] — Click to Bind
                        </button>
                        <button id="clearHotkeyBtn" type="button" class="btn btn-sm btn-outline-secondary" title="Clear hotkey only">
                            <i class="fa-solid fa-eraser"></i>
                        </button>
                    </div>
                    <div id="hotkeyConflictContainer"></div>
                </div>
                <div>
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectActionType">Action Type</label>
                    <select id="inspectActionType" class="form-select form-select-sm bg-black text-white border-secondary">
                        <option value="empty" ${at === 'empty' ? 'selected' : ''}>Empty Slot</option>
                        <option value="spell" ${at === 'spell' ? 'selected' : ''}>Cast Spell</option>
                        <option value="item" ${at === 'item' ? 'selected' : ''}>Use Item / Rune</option>
                        <option value="command" ${at === 'command' ? 'selected' : ''}>Execute Command</option>
                        <option value="text" ${at === 'text' ? 'selected' : ''}>Text (FCT)</option>
                        <option value="passive" ${at === 'passive' ? 'selected' : ''}>Passive Ability</option>
                        <option value="multi" ${at === 'multi' ? 'selected' : ''}>Multi-Action</option>
                    </select>
                </div>

                <div id="inspectStandardFields" style="display: ${at === 'spell' || at === 'item' || at === 'command' ? 'block' : 'none'};">
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectActionVal">Identifier / Command</label>
                    <input type="text" id="inspectActionVal" class="form-control form-control-sm bg-black text-white border-secondary mb-2"
                        value="${escapeHtml(slot.spellId || slot.itemId || slot.command || '')}"
                        placeholder="spell_id, item_id, or auto_chase">
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectTargetMode">Targeting Behavior</label>
                    <select id="inspectTargetMode" class="form-select form-select-sm bg-black text-white border-secondary">
                        <option value="smart_target" ${!slot.targetMode || slot.targetMode === 'smart_target' ? 'selected' : ''}>Smart Cast on Active Target</option>
                        <option value="cursor_prompt" ${slot.targetMode === 'cursor_prompt' ? 'selected' : ''}>Cursor Prompt (Crosshair)</option>
                        <option value="self" ${slot.targetMode === 'self' ? 'selected' : ''}>Cast on Self / User</option>
                    </select>
                </div>

                <div id="inspectTextFields" style="display: ${at === 'text' ? 'block' : 'none'};">
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectTextVal">Text (shows as FCT on player)</label>
                    <textarea id="inspectTextVal" class="form-control form-control-sm bg-black text-white border-secondary" rows="2" maxlength="${TEXT_MAX_LEN}" placeholder="Hello party…">${escapeHtml(slot.text || '')}</textarea>
                    <div class="text-xxs text-muted mt-1">Max ${TEXT_MAX_LEN} chars. No chat console — FCT only.</div>
                </div>

                <div id="inspectPassiveFields" style="display: ${at === 'passive' ? 'block' : 'none'};">
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectPassiveId">Passive Ability</label>
                    <select id="inspectPassiveId" class="form-select form-select-sm bg-black text-white border-secondary">
                        <option value="">— Select —</option>
                        ${passiveOpts}
                    </select>
                    <div class="text-xxs text-muted mt-1">Stub list; combat passives not wired yet.</div>
                </div>

                <div id="inspectMultiFields" style="display: ${at === 'multi' ? 'block' : 'none'};">
                    <label class="form-label text-xs text-muted mb-1 d-block">Multi-Action Sub-slots (I–III)</label>
                    <div class="text-xxs text-muted mb-2">At runtime the bar rotates to the first ready sub-action (cooldown / stack aware).</div>
                    ${multiRows}
                </div>

                <div class="d-flex gap-2 mt-2">
                    <button id="saveSlotBtn" type="button" class="btn btn-sm btn-primary flex-grow-1"><i class="fa-solid fa-check me-1"></i> Save Binding</button>
                    <button id="clearSlotBtn" type="button" class="btn btn-sm btn-outline-danger" title="Clear action (keeps hotkey)"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;

        body.innerHTML = html;

        const recordBtn = document.getElementById('recordHotkeyBtn');
        if (recordBtn) {
            recordBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                isCapturingKey = true;
                recordBtn.innerHTML = '<i class="fa-solid fa-circle-dot text-warning me-1"></i> Press any key… (Esc cancel)';
                recordBtn.classList.add('capture-active');
                const cont = document.getElementById('hotkeyConflictContainer');
                if (cont) cont.innerHTML = '';
                document.addEventListener('keydown', handleKeyCapture, { capture: true, once: false });
            });
        }

        const clearHkBtn = document.getElementById('clearHotkeyBtn');
        if (clearHkBtn) {
            clearHkBtn.addEventListener('click', () => {
                postAssign(slot.id, slot.actionType || 'empty', slotCfgFromSlot(slot, { hotkey: '' }));
            });
        }

        const typeSel = document.getElementById('inspectActionType');
        const showPanels = () => {
            const v = typeSel ? typeSel.value : 'empty';
            const std = document.getElementById('inspectStandardFields');
            const txt = document.getElementById('inspectTextFields');
            const pas = document.getElementById('inspectPassiveFields');
            const mul = document.getElementById('inspectMultiFields');
            if (std) std.style.display = (v === 'spell' || v === 'item' || v === 'command') ? 'block' : 'none';
            if (txt) txt.style.display = v === 'text' ? 'block' : 'none';
            if (pas) pas.style.display = v === 'passive' ? 'block' : 'none';
            if (mul) mul.style.display = v === 'multi' ? 'block' : 'none';
        };
        if (typeSel) typeSel.addEventListener('change', showPanels);

        body.querySelectorAll('.multi-sub-row').forEach(row => {
            const typeEl = row.querySelector('.multi-sub-type');
            const valEl = /** @type {HTMLInputElement|null} */ (row.querySelector('.multi-sub-val'));
            const tgtEl = /** @type {HTMLElement|null} */ (row.querySelector('.multi-sub-target'));
            if (typeEl) {
                typeEl.addEventListener('change', () => {
                    const v = typeEl.value;
                    if (valEl) valEl.disabled = v === 'empty';
                    if (tgtEl) tgtEl.style.display = (v === 'spell' || v === 'item') ? 'block' : 'none';
                });
            }
        });

        const saveBtn = document.getElementById('saveSlotBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const actionType = typeSel ? typeSel.value : 'empty';
                const cfg = slotCfgFromSlot(slot, {
                    hotkey: slot.hotkey || '',
                    itemId: null,
                    spellId: null,
                    command: null,
                    text: null,
                    passiveId: null,
                    multiActions: null
                });

                if (actionType === 'spell' || actionType === 'item' || actionType === 'command') {
                    const valInput = document.getElementById('inspectActionVal');
                    const modeSel = document.getElementById('inspectTargetMode');
                    const val = valInput ? valInput.value.trim() : '';
                    cfg.targetMode = modeSel ? modeSel.value : 'smart_target';
                    if (actionType === 'spell') cfg.spellId = val;
                    if (actionType === 'item') cfg.itemId = val;
                    if (actionType === 'command') cfg.command = val;
                } else if (actionType === 'text') {
                    const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('inspectTextVal'));
                    let t = ta ? ta.value : '';
                    if (t.length > TEXT_MAX_LEN) t = t.slice(0, TEXT_MAX_LEN);
                    cfg.text = t;
                } else if (actionType === 'passive') {
                    const pSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('inspectPassiveId'));
                    cfg.passiveId = pSel ? pSel.value : '';
                } else if (actionType === 'multi') {
                    const multiActions = emptyMultiActions();
                    body.querySelectorAll('.multi-sub-row').forEach(row => {
                        const i = parseInt(row.getAttribute('data-multi-idx') || '0', 10);
                        const typeEl = /** @type {HTMLSelectElement|null} */ (row.querySelector('.multi-sub-type'));
                        const valEl = /** @type {HTMLInputElement|null} */ (row.querySelector('.multi-sub-val'));
                        const tgtEl = /** @type {HTMLSelectElement|null} */ (row.querySelector('.multi-sub-target'));
                        const st = typeEl ? typeEl.value : 'empty';
                        const sub = multiActions[i];
                        sub.actionType = st;
                        const val = valEl ? valEl.value.trim() : '';
                        if (st === 'spell') {
                            sub.spellId = val || null;
                            sub.targetMode = tgtEl ? tgtEl.value : 'smart_target';
                        } else if (st === 'item') {
                            sub.itemId = val || null;
                            sub.targetMode = tgtEl ? tgtEl.value : 'smart_target';
                        } else if (st === 'text') {
                            sub.text = val;
                        }
                    });
                    cfg.multiActions = multiActions;
                    cfg.targetMode = 'smart_target';
                }

                postAssign(slot.id, actionType, cfg);
            });
        }

        const clearBtn = document.getElementById('clearSlotBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                postAssign(slot.id, 'empty', { hotkey: slot.hotkey || '', targetMode: 'smart_target' });
            });
        }
    }

    function paintHotkeyWarnings(norm, conflict, conflictContainer) {
        if (!conflictContainer) return;
        let html = '';
        if (isBlockedHotkey(norm)) {
            html = `
                <div class="alert alert-danger p-2 text-xs mb-2 mt-1 border-danger">
                    <div class="fw-bold mb-1"><i class="fa-solid fa-ban me-1"></i> Reserved key</div>
                    <div><strong>[${escapeHtml(norm)}]</strong> cannot be bound (movement / system key). Use a modifier (e.g. Shift+W) or another key.</div>
                    <button type="button" id="cancelRebindBtn" class="btn btn-xs btn-outline-secondary mt-2 w-100">Dismiss</button>
                </div>
            `;
            conflictContainer.innerHTML = html;
            const cancelBtn = document.getElementById('cancelRebindBtn');
            if (cancelBtn) cancelBtn.addEventListener('click', () => renderInspector());
            return 'blocked';
        }

        if (conflict) {
            html += `
                <div class="alert alert-warning p-2 text-xs mb-1 mt-1 border-warning">
                    <div class="fw-bold mb-1"><i class="fa-solid fa-triangle-exclamation me-1"></i> Already on another bar slot</div>
                    <div><strong>[${escapeHtml(norm)}]</strong> is on <strong>slot #${conflict.index + 1}</strong> (${escapeHtml(conflict.id)}). Confirm steals the binding (Stage B parity).</div>
                </div>
            `;
        }
        const gen = findGeneralHotkeyConflict(norm);
        if (gen) {
            html += `
                <div class="alert alert-warning p-2 text-xs mb-1 ${conflict ? '' : 'mt-1'} border-warning">
                    <div class="fw-bold mb-1"><i class="fa-solid fa-circle-info me-1"></i> General shortcut clash</div>
                    <div>Also used as general shortcut <strong>${escapeHtml(gen)}</strong>. Action-bar binding is still allowed (general keys take priority when both fire).</div>
                </div>
            `;
        }

        if (conflict || gen) {
            html += `
                <div class="d-flex gap-2 mt-1 mb-1">
                    <button type="button" id="confirmRebindBtn" class="btn btn-xs btn-warning flex-grow-1">${conflict ? 'Steal & Bind' : 'Bind Anyway'}</button>
                    <button type="button" id="cancelRebindBtn" class="btn btn-xs btn-outline-secondary flex-grow-1">Cancel</button>
                </div>
            `;
            conflictContainer.innerHTML = html;
            return 'warn';
        }

        conflictContainer.innerHTML = '';
        return 'ok';
    }

    function applyHotkeyToSlot(slot, norm) {
        postAssign(slot.id, slot.actionType || 'empty', slotCfgFromSlot(slot, { hotkey: norm }));
    }

    function handleKeyCapture(ev) {
        if (!isCapturingKey || !selectedSlotId) {
            document.removeEventListener('keydown', handleKeyCapture, { capture: true });
            return;
        }
        if (ev.key === 'Shift' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Meta') {
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();

        isCapturingKey = false;
        document.removeEventListener('keydown', handleKeyCapture, { capture: true });
        const recordBtn = document.getElementById('recordHotkeyBtn');
        if (recordBtn) recordBtn.classList.remove('capture-active');

        if (ev.key === 'Escape') {
            renderInspector();
            return;
        }

        const raw = eventToHotkeyString(ev);
        const norm = normalizeHotkey(raw);
        const slot = findSlotById(selectedSlotId);
        if (!slot || !norm) return;

        const conflict = checkConflict(norm, selectedSlotId);
        const conflictContainer = document.getElementById('hotkeyConflictContainer');
        const status = paintHotkeyWarnings(norm, conflict, conflictContainer);

        if (status === 'blocked') {
            if (recordBtn) {
                recordBtn.innerHTML = `<i class="fa-solid fa-keyboard me-1"></i> Hotkey: [${escapeHtml(slot.hotkey || 'None')}] — Click to Bind`;
            }
            return;
        }

        if (status === 'warn') {
            if (recordBtn) {
                recordBtn.innerHTML = `<i class="fa-solid fa-keyboard me-1"></i> Hotkey: [${escapeHtml(norm)}] — pending`;
            }
            const confirmBtn = document.getElementById('confirmRebindBtn');
            const cancelBtn = document.getElementById('cancelRebindBtn');
            if (confirmBtn) {
                confirmBtn.addEventListener('click', () => {
                    // assignSlot on parent steals conflicting bar hotkeys automatically
                    applyHotkeyToSlot(slot, norm);
                    if (conflictContainer) conflictContainer.innerHTML = '';
                });
            }
            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => renderInspector());
            }
            return;
        }

        applyHotkeyToSlot(slot, norm);
    }

    function renderCatalog() {
        const list = document.getElementById('catalogList');
        if (!list) return;
        list.innerHTML = '';

        if (currentCatalog === 'spells') {
            const rawList = spellBookToList(appState.spellBook);
            const showAllEl = /** @type {HTMLInputElement|null} */ (document.getElementById('showAllSpellsToggle'));
            const searchEl = /** @type {HTMLInputElement|null} */ (document.getElementById('spellSearchInput'));
            const sortEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('spellSortSelect'));
            const kindEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('spellKindFilter'));
            const boundEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('spellBoundFilter'));

            const boundIds = collectBoundSpellIds();
            const targetVoc = (appState.activePlayerClass || appState.activeProfileId || 'default').toLowerCase();

            const spells = filterSpellsList(rawList, {
                query: searchEl && searchEl.value ? searchEl.value : '',
                showAll: showAllEl ? showAllEl.checked : false,
                vocation: targetVoc,
                sort: sortEl && sortEl.value ? sortEl.value : 'name',
                kind: kindEl && kindEl.value ? kindEl.value : 'all',
                boundFilter: boundEl && boundEl.value ? boundEl.value : 'all',
                boundIds
            }).map(sp => {
                const id = String(sp.id);
                const name = sp.label || sp.name || id;
                const cost = sp.mana != null ? sp.mana : (sp.manaCost != null ? sp.manaCost : (sp.cost || 0));
                let cd = 0;
                if (sp.cooldown != null || sp.cd != null) {
                    cd = sp.cooldown != null ? sp.cooldown : sp.cd;
                } else if (sp.cooldowns && typeof sp.cooldowns === 'object') {
                    if (sp.cooldowns.primary && sp.cooldowns.primary.attack != null) cd = sp.cooldowns.primary.attack;
                    else if (sp.cooldowns.spell != null) cd = sp.cooldowns.spell;
                    else if (sp.cooldowns.auto && sp.cooldowns.auto.attack != null) cd = sp.cooldowns.auto.attack;
                }
                const level = Number(sp.level != null ? sp.level : sp.minLevel) || 0;
                const kind = String(sp.group || sp.kind || '');
                return { id, name, cost, cd, level, kind, bound: boundIds.has(id) };
            });

            if (!spells.length) {
                list.innerHTML = '<div class="text-muted small p-3 text-center">No matching spells found.</div>';
                return;
            }

            spells.forEach(sp => {
                const div = document.createElement('div');
                div.className = 'catalog-item d-flex justify-content-between align-items-center';
                div.draggable = true;
                const badges = [];
                if (sp.level > 0) badges.push(`<span class="badge bg-dark border border-secondary text-xxs">L${sp.level}</span>`);
                if (sp.kind) badges.push(`<span class="badge bg-dark border border-secondary text-xxs">${escapeHtml(sp.kind)}</span>`);
                if (sp.bound) badges.push('<span class="badge bg-success text-xxs">Bound</span>');
                div.innerHTML = `
                    <div class="text-truncate pe-2">
                        <i class="fa-solid fa-wand-magic-sparkles text-warning me-2"></i>
                        <span class="fw-bold text-light">${escapeHtml(sp.name)}</span>
                        <span class="ms-1">${badges.join(' ')}</span>
                        <span class="text-muted text-xxs d-block font-monospace">${escapeHtml(sp.id)} | MP ${sp.cost} | CD ${sp.cd}s</span>
                    </div>
                    <button type="button" class="btn btn-xxs btn-outline-secondary flex-shrink-0" title="Assign to selected slot"><i class="fa-solid fa-plus"></i></button>
                `;
                div.addEventListener('dragstart', (ev) => {
                    ev.dataTransfer.setData('application/json', JSON.stringify({ type: 'spell', spellId: sp.id, name: sp.name }));
                });
                const btn = div.querySelector('button');
                if (btn) {
                    btn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        if (!selectedSlotId) {
                            alert('Please select a dock slot first before assigning.');
                            return;
                        }
                        const slot = findSlotById(selectedSlotId);
                        if (slot) {
                            postAssign(selectedSlotId, 'spell', slotCfgFromSlot(slot, {
                                spellId: sp.id,
                                itemId: null,
                                command: null,
                                text: null,
                                passiveId: null,
                                multiActions: null,
                                targetMode: slot.targetMode || 'smart_target',
                                hotkey: slot.hotkey || ''
                            }));
                        }
                    });
                }
                list.appendChild(div);
            });
        } else {
            let items = Array.isArray(appState.itemDb) ? appState.itemDb : [];
            const catSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('itemCategoryFilter'));
            const catFilter = catSel && catSel.value ? catSel.value : 'all';

            if (catFilter !== 'all') {
                items = items.filter(it => {
                    const t = String(it.type || it.category || '').toLowerCase();
                    if (catFilter === 'rune') return t.indexOf('rune') >= 0 || String(it.id).indexOf('rune') >= 0;
                    if (catFilter === 'potion') return t.indexOf('potion') >= 0 || t.indexOf('consumable') >= 0 || String(it.id).indexOf('potion') >= 0;
                    return t.indexOf('weapon') >= 0 || t.indexOf('armor') >= 0 || t.indexOf('shield') >= 0 || t.indexOf('equipment') >= 0;
                });
            }

            const searchEl = /** @type {HTMLInputElement|null} */ (document.getElementById('itemSearchInput'));
            const query = searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : '';
            if (query) {
                items = items.filter(it =>
                    String(it.id || '').toLowerCase().indexOf(query) >= 0 ||
                    String(it.name || it.label || '').toLowerCase().indexOf(query) >= 0
                );
            }

            if (!items.length) {
                list.innerHTML = '<div class="text-muted small p-3 text-center">No matching items or consumables found.</div>';
                return;
            }

            items.slice(0, 80).forEach(it => {
                const div = document.createElement('div');
                div.className = 'catalog-item d-flex justify-content-between align-items-center';
                div.draggable = true;
                const name = it.name || it.label || it.id;
                div.innerHTML = `
                    <div class="text-truncate pe-2">
                        <i class="fa-solid fa-flask text-success me-2"></i>
                        <span class="fw-bold text-light">${escapeHtml(name)}</span>
                        <span class="text-muted text-xxs d-block font-monospace">${escapeHtml(it.id)} | Type: ${escapeHtml(it.type || 'Consumable')}</span>
                    </div>
                    <button type="button" class="btn btn-xxs btn-outline-secondary flex-shrink-0" title="Assign to selected slot"><i class="fa-solid fa-plus"></i></button>
                `;
                div.addEventListener('dragstart', (ev) => {
                    ev.dataTransfer.setData('application/json', JSON.stringify({ type: 'item', itemId: it.id, name }));
                });
                const btn = div.querySelector('button');
                if (btn) {
                    btn.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        if (!selectedSlotId) {
                            alert('Please select a dock slot first before assigning.');
                            return;
                        }
                        const slot = findSlotById(selectedSlotId);
                        if (slot) {
                            postAssign(selectedSlotId, 'item', slotCfgFromSlot(slot, {
                                itemId: it.id,
                                spellId: null,
                                command: null,
                                text: null,
                                passiveId: null,
                                multiActions: null,
                                targetMode: slot.targetMode || 'smart_target',
                                hotkey: slot.hotkey || ''
                            }));
                        }
                    });
                }
                list.appendChild(div);
            });
        }
    }

    const GENERAL_HOTKEY_GROUPS = [
        {
            title: "Movement Controls",
            description: "Configure directional keys for continuous manual movement in the game world. Multiple keys can be assigned per direction.",
            icon: "fa-arrows-up-down-left-right text-info",
            actions: [
                { id: "moveNorth", label: "Move North (Up)", icon: "fa-arrow-up" },
                { id: "moveSouth", label: "Move South (Down)", icon: "fa-arrow-down" },
                { id: "moveWest", label: "Move West (Left)", icon: "fa-arrow-left" },
                { id: "moveEast", label: "Move East (Right)", icon: "fa-arrow-right" },
                { id: "moveNorthWest", label: "Move North-West", icon: "fa-arrow-trend-up fa-flip-horizontal" },
                { id: "moveNorthEast", label: "Move North-East", icon: "fa-arrow-trend-up" },
                { id: "moveSouthWest", label: "Move South-West", icon: "fa-arrow-trend-down fa-flip-horizontal" },
                { id: "moveSouthEast", label: "Move South-East", icon: "fa-arrow-trend-down" }
            ]
        },
        {
            title: "Targeting & Combat Controls",
            description: "Configure shortcuts for selecting enemies and managing combat automation.",
            icon: "fa-crosshairs text-danger",
            actions: [
                { id: "targetNext", label: "Attack Next Target", icon: "fa-forward-step" },
                { id: "targetPrev", label: "Attack Previous Target", icon: "fa-backward-step" },
                { id: "toggleAutoChase", label: "Toggle Auto Chase", icon: "fa-person-running text-warning" },
                { id: "stopAutowalk", label: "Stop Autowalk / Cancel Action", icon: "fa-hand-held" }
            ]
        }
    ];

    function renderGeneralHotkeys() {
        const host = document.getElementById('generalHotkeysHost');
        if (!host) return;

        const shortcuts = appState.generalHotkeys || {};
        const activeProf = (appState.activeProfileId || 'guardian').toUpperCase();
        const profCount = Array.isArray(appState.profiles) && appState.profiles.length > 0 ? appState.profiles.length : 1;

        let html = `
            <div class="card bg-dark border-secondary mb-4 shadow-sm">
                <div class="card-body p-3 d-flex align-items-center justify-content-between bg-dark-subtle rounded">
                    <div>
                        <h6 class="mb-1 fw-bold text-info font-monospace text-uppercase d-flex align-items-center">
                            <i class="fa-solid fa-clone me-2"></i>Profile Synchronization
                        </h6>
                        <div class="text-muted small">
                            Currently editing hotkeys for profile <strong class="text-light">[${escapeHtml(activeProf)}]</strong>. Copy these general hotkeys to all ${profCount} profile(s).
                        </div>
                    </div>
                    <button type="button" class="btn btn-sm btn-outline-info font-monospace fw-bold text-uppercase px-3 py-2 ms-3 text-nowrap transition-all shadow-sm" id="copyToAllProfilesBtn" title="Copy general hotkeys to all profiles">
                        <i class="fa-solid fa-copy me-2"></i>Copy to All Profiles
                    </button>
                </div>
            </div>
        `;

        GENERAL_HOTKEY_GROUPS.forEach(group => {
            html += `
                <div class="card bg-dark border-secondary mb-4 shadow-sm">
                    <div class="card-header bg-dark-subtle border-bottom border-secondary p-3 d-flex align-items-center justify-content-between">
                        <div class="d-flex align-items-center gap-2">
                            <i class="fa-solid ${group.icon} fs-5"></i>
                            <h6 class="mb-0 fw-bold text-light text-uppercase font-monospace">${group.title}</h6>
                        </div>
                        <span class="text-muted small">${group.description}</span>
                    </div>
                    <div class="list-group list-group-flush">
            `;

            group.actions.forEach(act => {
                const keys = Array.isArray(shortcuts[act.id]) ? shortcuts[act.id] : [];
                let keysHtml = '';

                keys.forEach((kStr, idx) => {
                    const isCapturingThis = isCapturingGeneralKey && isCapturingGeneralKey.action === act.id && isCapturingGeneralKey.index === idx;
                    const badgeText = isCapturingThis ? 'PRESS KEY...' : kStr;
                    keysHtml += `
                        <div class="btn-group btn-group-sm general-key-group me-2 mb-1" role="group">
                            <button type="button" class="btn ${isCapturingThis ? 'btn-warning text-dark' : 'btn-secondary text-info'} fw-bold font-monospace px-2 py-1 update-general-key-btn ${isCapturingThis ? 'capture-active' : ''}" data-action="${act.id}" data-index="${idx}" title="Click to rebind this key">
                                ${escapeHtml(badgeText)}
                            </button>
                            <button type="button" class="btn btn-outline-secondary text-danger px-2 py-1 remove-general-key-btn" data-action="${act.id}" data-index="${idx}" title="Remove key binding" ${isCapturingThis ? 'disabled' : ''}>
                                <i class="fa-solid fa-xmark"></i>
                            </button>
                        </div>
                    `;
                });

                const isCapturingNew = isCapturingGeneralKey && isCapturingGeneralKey.action === act.id && isCapturingGeneralKey.index === -1;
                const addBtnText = isCapturingNew ? '<i class="fa-solid fa-spinner fa-spin me-1"></i> Press key...' : '<i class="fa-solid fa-plus text-info"></i> Add Key';
                const addBtnClass = isCapturingNew ? 'btn-warning text-dark capture-active' : 'btn-outline-info text-info border-dashed';

                html += `
                    <div class="d-flex align-items-center justify-content-between p-3 border-bottom border-secondary-subtle hover-row transition-all">
                        <div class="d-flex align-items-center gap-2" style="min-width: 240px;">
                            <i class="fa-solid ${act.icon} text-muted me-2 width-20 text-center"></i>
                            <span class="fw-semibold text-light">${act.label}</span>
                        </div>
                        <div class="d-flex flex-wrap align-items-center justify-content-end flex-grow-1">
                            ${keysHtml}
                            <button type="button" class="btn btn-sm ${addBtnClass} font-monospace text-xs py-1 px-3 rounded-pill add-general-key-btn ms-1" data-action="${act.id}">
                                ${addBtnText}
                            </button>
                        </div>
                    </div>
                `;
            });

            html += `
                    </div>
                </div>
            `;
        });

        host.innerHTML = html;

        host.querySelectorAll('.update-general-key-btn').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const action = btn.getAttribute('data-action');
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                startGeneralKeyCapture(action, idx);
            });
        });

        host.querySelectorAll('.remove-general-key-btn').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const action = btn.getAttribute('data-action');
                const idx = parseInt(btn.getAttribute('data-index'), 10);
                removeGeneralKey(action, idx);
            });
        });

        host.querySelectorAll('.add-general-key-btn').forEach(btn => {
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                const action = btn.getAttribute('data-action');
                startGeneralKeyCapture(action, -1);
            });
        });

        const copyAllBtn = host.querySelector('#copyToAllProfilesBtn');
        if (copyAllBtn) {
            copyAllBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                postToParent({ type: 'copy_general_hotkeys_to_all_profiles', shortcuts: appState.generalHotkeys || {} });
                const alertHost = document.getElementById('generalHotkeysAlertHost');
                if (alertHost) {
                    const names = (appState.profiles && appState.profiles.length > 0)
                        ? appState.profiles.map(p => String(p).toUpperCase()).join(', ')
                        : (appState.activeProfileId || 'guardian').toUpperCase();
                    alertHost.innerHTML = `
                        <div class="alert alert-success py-2 px-3 mb-3 d-flex align-items-center justify-content-between font-monospace text-xs shadow-sm">
                            <span><i class="fa-solid fa-circle-check text-success me-2"></i> General hotkeys copied to all profiles: <strong>${escapeHtml(names)}</strong>.</span>
                            <button type="button" class="btn-close btn-close-white" onclick="this.parentElement.remove()"></button>
                        </div>
                    `;
                    setTimeout(() => { if (alertHost) alertHost.innerHTML = ''; }, 5000);
                }
            });
        }
    }

    function removeGeneralKey(action, idx) {
        if (!appState.generalHotkeys || !Array.isArray(appState.generalHotkeys[action])) return;
        appState.generalHotkeys[action].splice(idx, 1);
        postToParent({ type: 'patch_general_hotkeys', shortcuts: appState.generalHotkeys });
        renderGeneralHotkeys();
    }

    function startGeneralKeyCapture(action, idx) {
        if (isCapturingGeneralKey) {
            document.removeEventListener('keydown', handleGeneralKeyCapture, { capture: true });
        }
        isCapturingGeneralKey = { action, index: idx };
        renderGeneralHotkeys();

        const alertHost = document.getElementById('generalHotkeysAlertHost');
        if (alertHost) {
            alertHost.innerHTML = `
                <div class="alert alert-warning py-2 px-3 mb-3 d-flex align-items-center justify-content-between font-monospace small shadow-sm">
                    <span><i class="fa-solid fa-keyboard animate-pulse me-2"></i> Press any key to bind to <strong>${escapeHtml(action)}</strong>... (Press ESC to cancel)</span>
                    <button type="button" class="btn btn-sm btn-outline-dark py-0 px-2 cancel-general-capture-btn">Cancel</button>
                </div>
            `;
            const cancelBtn = alertHost.querySelector('.cancel-general-capture-btn');
            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => {
                    cancelGeneralKeyCapture();
                });
            }
        }

        document.addEventListener('keydown', handleGeneralKeyCapture, { capture: true });
    }

    function cancelGeneralKeyCapture() {
        if (!isCapturingGeneralKey) return;
        document.removeEventListener('keydown', handleGeneralKeyCapture, { capture: true });
        isCapturingGeneralKey = null;
        const alertHost = document.getElementById('generalHotkeysAlertHost');
        if (alertHost) alertHost.innerHTML = '';
        renderGeneralHotkeys();
    }

    function handleGeneralKeyCapture(ev) {
        ev.preventDefault();
        ev.stopPropagation();

        const key = ev.key;
        if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
            return;
        }

        document.removeEventListener('keydown', handleGeneralKeyCapture, { capture: true });
        const captureTarget = isCapturingGeneralKey;
        isCapturingGeneralKey = null;
        const alertHost = document.getElementById('generalHotkeysAlertHost');
        if (alertHost) alertHost.innerHTML = '';

        if (key === 'Escape') {
            renderGeneralHotkeys();
            return;
        }

        const hotkeyStr = eventToHotkeyString(ev);
        const norm = normalizeHotkey(hotkeyStr);

        if (!captureTarget) {
            renderGeneralHotkeys();
            return;
        }

        if (!appState.generalHotkeys) appState.generalHotkeys = {};
        const targetAction = captureTarget.action;
        if (!Array.isArray(appState.generalHotkeys[targetAction])) {
            appState.generalHotkeys[targetAction] = [];
        }

        const keysArray = appState.generalHotkeys[targetAction];

        const existingIndex = keysArray.indexOf(norm);
        if (existingIndex !== -1 && captureTarget.index === -1) {
            renderGeneralHotkeys();
            return;
        }

        let reassignedFrom = null;
        for (const actKey of Object.keys(appState.generalHotkeys)) {
            if (actKey !== targetAction && Array.isArray(appState.generalHotkeys[actKey])) {
                const idx = appState.generalHotkeys[actKey].indexOf(norm);
                if (idx !== -1) {
                    appState.generalHotkeys[actKey].splice(idx, 1);
                    reassignedFrom = actKey;
                }
            }
        }

        if (captureTarget.index === -1) {
            keysArray.push(norm);
        } else {
            keysArray[captureTarget.index] = norm;
        }

        postToParent({ type: 'patch_general_hotkeys', shortcuts: appState.generalHotkeys });
        renderGeneralHotkeys();

        if (reassignedFrom && alertHost) {
            alertHost.innerHTML = `
                <div class="alert alert-info py-2 px-3 mb-3 d-flex align-items-center justify-content-between font-monospace text-xs shadow-sm">
                    <span><i class="fa-solid fa-circle-info text-info me-2"></i> Key <strong>[${escapeHtml(norm)}]</strong> was reassigned from <strong>${escapeHtml(reassignedFrom)}</strong> to <strong>${escapeHtml(targetAction)}</strong>.</span>
                    <button type="button" class="btn-close btn-close-white" onclick="this.parentElement.remove()"></button>
                </div>
            `;
            setTimeout(() => { if (alertHost) alertHost.innerHTML = ''; }, 4000);
        }
    }

    function bindUI() {
        const mainTabBtns = document.querySelectorAll('#hotkeysMainTabs .nav-link');
        const abPane = document.getElementById('actionBarsTabPane');
        const genPane = document.getElementById('generalHotkeysTabPane');
        const profWrap = document.getElementById('profileSelectWrapper');

        mainTabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                mainTabBtns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                currentMainTab = btn.getAttribute('data-maintab') || 'action_bars';

                if (currentMainTab === 'general') {
                    if (abPane) {
                        abPane.style.display = 'none';
                        abPane.classList.remove('active', 'show');
                    }
                    if (genPane) {
                        genPane.style.display = 'block';
                        genPane.classList.add('active', 'show');
                    }
                    if (profWrap) profWrap.style.display = '';
                    renderGeneralHotkeys();
                } else {
                    if (abPane) {
                        abPane.style.display = 'block';
                        abPane.classList.add('active', 'show');
                    }
                    if (genPane) {
                        genPane.style.display = 'none';
                        genPane.classList.remove('active', 'show');
                    }
                    if (profWrap) profWrap.style.display = '';
                }
            });
        });

        const profSel = document.getElementById('profileSelect');
        if (profSel) {
            profSel.addEventListener('change', () => {
                postToParent({ type: 'switch_profile', profileId: profSel.value });
            });
        }

        const dockTabBtns = document.querySelectorAll('#dockTabs .nav-link');
        dockTabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                dockTabBtns.forEach(b => { b.classList.remove('active', 'bg-primary', 'text-white'); b.setAttribute('aria-selected', 'false'); });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                currentDock = btn.getAttribute('data-dock') || 'top';
                renderSlotsGrid();
            });
        });

        const catalogTabBtns = document.querySelectorAll('#catalogTabs .nav-link');
        catalogTabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                catalogTabBtns.forEach(b => {
                    b.classList.remove('active', 'text-info', 'border-bottom');
                    b.classList.add('text-muted');
                });
                btn.classList.add('active', 'text-info', 'border-bottom');
                btn.classList.remove('text-muted');
                currentCatalog = btn.getAttribute('data-catalog') || 'spells';

                const sTool = document.getElementById('spellsToolbar');
                const iTool = document.getElementById('itemsToolbar');
                if (sTool && iTool) {
                    sTool.style.display = currentCatalog === 'spells' ? 'block' : 'none';
                    iTool.style.display = currentCatalog === 'items' ? 'block' : 'none';
                }
                renderCatalog();
            });
        });

        const spellSearch = document.getElementById('spellSearchInput');
        if (spellSearch) spellSearch.addEventListener('input', renderCatalog);
        const spellShowAll = document.getElementById('showAllSpellsToggle');
        if (spellShowAll) spellShowAll.addEventListener('change', renderCatalog);
        const spellSort = document.getElementById('spellSortSelect');
        if (spellSort) spellSort.addEventListener('change', renderCatalog);
        const spellKind = document.getElementById('spellKindFilter');
        if (spellKind) spellKind.addEventListener('change', renderCatalog);
        const spellBound = document.getElementById('spellBoundFilter');
        if (spellBound) spellBound.addEventListener('change', renderCatalog);

        const itemSearch = document.getElementById('itemSearchInput');
        if (itemSearch) itemSearch.addEventListener('input', renderCatalog);
        const itemCat = document.getElementById('itemCategoryFilter');
        if (itemCat) itemCat.addEventListener('change', renderCatalog);

        const slotSearch = document.getElementById('slotSearchInput');
        if (slotSearch) slotSearch.addEventListener('input', renderSlotsGrid);
        const slotType = document.getElementById('slotTypeFilter');
        if (slotType) slotType.addEventListener('change', renderSlotsGrid);
        const slotSort = document.getElementById('slotSortSelect');
        if (slotSort) slotSort.addEventListener('change', renderSlotsGrid);
    }

    let lastReceivedStateSig = null;
    let lastCatalogDataSig = null;

    function onMessage(ev) {
        const data = ev.data;
        if (!data || data.channel !== CHANNEL) return;
        if (data.type === 'state' && data.state) {
            const newSig = JSON.stringify(data.state);
            if (lastReceivedStateSig !== null && newSig === lastReceivedStateSig) {
                return;
            }
            lastReceivedStateSig = newSig;

            const catalogSig = JSON.stringify({
                spellBook: data.state.spellBook,
                itemDb: data.state.itemDb,
                genre: data.state.genre,
                activeProfileId: data.state.activeProfileId,
                activePlayerClass: data.state.activePlayerClass,
                docks: data.state.docks
            });
            const catalogDirty = lastCatalogDataSig === null || catalogSig !== lastCatalogDataSig;
            lastCatalogDataSig = catalogSig;

            appState = Object.assign({}, appState, data.state);
            updateProfileSelect();
            if (!isCapturingKey && !isCapturingGeneralKey) {
                renderSlotsGrid();
                renderInspector();
                if (catalogDirty) {
                    renderCatalog();
                }
                if (currentMainTab === 'general') {
                    renderGeneralHotkeys();
                }
            }
        }
    }

    window.addEventListener('message', onMessage);
    window.addEventListener('beforeunload', () => {
        postToParent({ type: 'closing' });
    });

    bindUI();
    postToParent({ type: 'ready' });
})();
