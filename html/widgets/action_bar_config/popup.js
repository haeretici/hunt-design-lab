/**
 * Action Bar & Keymaps Config Popup interface script.
 * Handles interactive slot editing, key capture with conflict detection,
 * drag and drop binding from catalogs, and syncing with parent game window.
 */

'use strict';

(function () {
    const CHANNEL = 'hunt-design-lab-action-bar';
    let appState = {
        activeProfileId: 'guardian',
        activePlayerClass: 'guardian',
        docks: {},
        profiles: [],
        spellBook: {},
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
                for (let k = 0; k < bar.slots.length; k++) {
                    if (bar.slots[k].id === slotId) return bar.slots[k];
                }
            }
        }
        return null;
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
                for (let k = 0; k < bar.slots.length; k++) {
                    const slot = bar.slots[k];
                    if (slot.id !== excludeSlotId && slot.hotkey && normalizeHotkey(slot.hotkey) === norm) {
                        return slot;
                    }
                }
            }
        }
        return null;
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

    function renderSlotsGrid() {
        const grid = document.getElementById('slotsGrid');
        if (!grid) return;
        grid.innerHTML = '';

        const bars = (appState.docks && appState.docks[currentDock]) || [];
        if (!bars.length) {
            grid.innerHTML = '<div class="text-muted small p-3 text-center">No bars configured for this dock.</div>';
            return;
        }

        bars.forEach(bar => {
            bar.slots.forEach((slot, idx) => {
                const card = document.createElement('div');
                card.className = 'action-slot-card d-flex justify-content-between align-items-center';
                if (slot.id === selectedSlotId) card.classList.add('active');
                card.dataset.slotId = slot.id;

                // Title / Assignment info
                let iconHtml = '<i class="fa-solid fa-circle text-secondary me-2"></i>';
                let actionText = '<span class="text-muted">Empty Slot</span>';
                if (slot.actionType === 'item' && slot.itemId) {
                    iconHtml = '<i class="fa-solid fa-flask text-success me-2"></i>';
                    let itemLabel = slot.itemId;
                    if (Array.isArray(appState.itemDb)) {
                        const match = appState.itemDb.find(it => it && it.id === slot.itemId);
                        if (match) itemLabel = match.label || match.name || slot.itemId;
                    }
                    actionText = `<span class="fw-semibold text-light">${itemLabel}</span>`;
                } else if (slot.actionType === 'spell' && slot.spellId) {
                    iconHtml = '<i class="fa-solid fa-wand-magic-sparkles text-warning me-2"></i>';
                    let spellLabel = slot.spellId;
                    const rawSpells = appState.spellBook || {};
                    if (Array.isArray(rawSpells)) {
                        const match = rawSpells.find(s => s && s.id === slot.spellId);
                        if (match) spellLabel = match.label || match.name || slot.spellId;
                    } else if (rawSpells[slot.spellId]) {
                        const s = rawSpells[slot.spellId];
                        spellLabel = s.label || s.name || slot.spellId;
                    }
                    actionText = `<span class="fw-semibold text-light">${spellLabel}</span>`;
                } else if (slot.actionType === 'command' && slot.command) {
                    iconHtml = '<i class="fa-solid fa-terminal text-info me-2"></i>';
                    actionText = `<span class="fw-semibold text-light">CMD: ${slot.command}</span>`;
                }

                if (slot.actionType !== 'empty' && slot.targetMode) {
                    const modeLabel = slot.targetMode === 'smart_target' ? 'Smart Cast' : (slot.targetMode === 'self' ? 'Self' : 'Cursor');
                    actionText += ` <span class="badge bg-dark border border-secondary text-xxs ms-1">${modeLabel}</span>`;
                }

                const leftCol = document.createElement('div');
                leftCol.className = 'd-flex align-items-center text-truncate pe-2';
                leftCol.innerHTML = `${iconHtml}<span class="text-muted text-xs me-2">#${idx + 1}</span>${actionText}`;

                const rightCol = document.createElement('div');
                rightCol.className = 'flex-shrink-0';
                rightCol.innerHTML = `<span class="hotkey-badge">${slot.hotkey || 'No Key'}</span>`;

                card.appendChild(leftCol);
                card.appendChild(rightCol);

                card.addEventListener('click', () => {
                    selectedSlotId = slot.id;
                    renderSlotsGrid();
                    renderInspector();
                });

                // Drag & drop handlers
                card.addEventListener('dragover', (ev) => {
                    ev.preventDefault();
                    card.classList.add('drag-over');
                });
                card.addEventListener('dragleave', () => {
                    card.classList.remove('drag-over');
                });
                card.addEventListener('drop', (ev) => {
                    ev.preventDefault();
                    card.classList.remove('drag-over');
                    try {
                        const payload = JSON.parse(ev.dataTransfer.getData('application/json') || '{}');
                        if (payload && (payload.type === 'spell' || payload.type === 'item' || payload.type === 'command')) {
                            const actionType = payload.type;
                            const cfg = {
                                targetMode: slot.targetMode || 'smart_target',
                                hotkey: slot.hotkey || ''
                            };
                            if (actionType === 'spell') cfg.spellId = payload.spellId;
                            if (actionType === 'item') cfg.itemId = payload.itemId;
                            if (actionType === 'command') cfg.command = payload.command;
                            
                            postToParent({ type: 'assign_slot', slotId: slot.id, actionType, cfg });
                            selectedSlotId = slot.id;
                        }
                    } catch (_) {}
                });

                grid.appendChild(card);
            });
        });
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

        badge.textContent = `Slot: ${slot.id}`;
        let html = `
            <div class="d-flex flex-column gap-2 text-start">
                <div>
                    <label class="form-label text-xs text-muted mb-1 d-block">Hotkey Binding</label>
                    <button id="recordHotkeyBtn" type="button" class="btn btn-sm btn-outline-info w-100 font-monospace text-center">
                        <i class="fa-solid fa-keyboard me-1"></i> Hotkey: [${slot.hotkey || 'None'}] — Click to Bind
                    </button>
                    <div id="hotkeyConflictContainer"></div>
                </div>
                <div>
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectActionType">Action Type</label>
                    <select id="inspectActionType" class="form-select form-select-sm bg-black text-white border-secondary">
                        <option value="empty" ${slot.actionType === 'empty' ? 'selected' : ''}>Empty Slot</option>
                        <option value="spell" ${slot.actionType === 'spell' ? 'selected' : ''}>Cast Spell</option>
                        <option value="item" ${slot.actionType === 'item' ? 'selected' : ''}>Use Item / Rune</option>
                        <option value="command" ${slot.actionType === 'command' ? 'selected' : ''}>Execute Command</option>
                    </select>
                </div>
                <div id="inspectTargetInputContainer" style="display: ${slot.actionType === 'empty' ? 'none' : 'block'};">
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectActionVal">Identifier / Command</label>
                    <input type="text" id="inspectActionVal" class="form-control form-control-sm bg-black text-white border-secondary mb-2" value="${slot.spellId || slot.itemId || slot.command || ''}" placeholder="spell_id, item_id, or auto_chase">
                    
                    <label class="form-label text-xs text-muted mb-1 d-block" for="inspectTargetMode">Targeting Behavior</label>
                    <select id="inspectTargetMode" class="form-select form-select-sm bg-black text-white border-secondary">
                        <option value="smart_target" ${!slot.targetMode || slot.targetMode === 'smart_target' ? 'selected' : ''}>Smart Cast on Active Target</option>
                        <option value="cursor_prompt" ${slot.targetMode === 'cursor_prompt' ? 'selected' : ''}>Cursor Prompt (Crosshair)</option>
                        <option value="self" ${slot.targetMode === 'self' ? 'selected' : ''}>Cast on Self / User</option>
                    </select>
                </div>
                <div class="d-flex gap-2 mt-2">
                    <button id="saveSlotBtn" type="button" class="btn btn-sm btn-primary flex-grow-1"><i class="fa-solid fa-check me-1"></i> Save Binding</button>
                    <button id="clearSlotBtn" type="button" class="btn btn-sm btn-outline-danger"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;

        body.innerHTML = html;

        // Bind interactive key capture button
        const recordBtn = document.getElementById('recordHotkeyBtn');
        if (recordBtn) {
            recordBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                isCapturingKey = true;
                recordBtn.innerHTML = '<i class="fa-solid fa-circle-dot text-warning me-1"></i> Press any key... (Esc to cancel)';
                recordBtn.classList.add('capture-active');
                document.addEventListener('keydown', handleKeyCapture, { capture: true, once: false });
            });
        }

        const typeSel = document.getElementById('inspectActionType');
        const inputCont = document.getElementById('inspectTargetInputContainer');
        if (typeSel && inputCont) {
            typeSel.addEventListener('change', () => {
                inputCont.style.display = typeSel.value === 'empty' ? 'none' : 'block';
            });
        }

        const saveBtn = document.getElementById('saveSlotBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                const actionType = typeSel ? typeSel.value : 'empty';
                const valInput = document.getElementById('inspectActionVal');
                const modeSel = document.getElementById('inspectTargetMode');
                const val = valInput ? valInput.value.trim() : '';
                const cfg = {
                    targetMode: modeSel ? modeSel.value : 'smart_target',
                    hotkey: slot.hotkey || ''
                };
                if (actionType === 'spell') cfg.spellId = val;
                if (actionType === 'item') cfg.itemId = val;
                if (actionType === 'command') cfg.command = val;
                postToParent({ type: 'assign_slot', slotId: slot.id, actionType, cfg });
            });
        }

        const clearBtn = document.getElementById('clearSlotBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                postToParent({ type: 'assign_slot', slotId: slot.id, actionType: 'empty', cfg: { hotkey: slot.hotkey || '' } });
            });
        }
    }

    function handleKeyCapture(ev) {
        if (!isCapturingKey || !selectedSlotId) {
            document.removeEventListener('keydown', handleKeyCapture, { capture: true });
            return;
        }
        ev.preventDefault();
        ev.stopPropagation();

        const key = ev.key;
        if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
            return; // Wait for non-modifier key
        }

        isCapturingKey = false;
        document.removeEventListener('keydown', handleKeyCapture, { capture: true });
        const recordBtn = document.getElementById('recordHotkeyBtn');
        if (recordBtn) recordBtn.classList.remove('capture-active');

        if (key === 'Escape') {
            renderInspector();
            return;
        }

        let keyName = key.toUpperCase();
        if (key === ' ') keyName = 'SPACE';
        const mods = [];
        if (ev.ctrlKey) mods.push('CTRL');
        if (ev.shiftKey) mods.push('SHIFT');
        if (ev.altKey) mods.push('ALT');
        const hotkeyStr = mods.length ? `${mods.join('+')}+${keyName}` : keyName;
        const norm = normalizeHotkey(hotkeyStr);

        const slot = findSlotById(selectedSlotId);
        if (!slot) return;

        // Check conflict
        const conflict = checkConflict(norm, selectedSlotId);
        const conflictContainer = document.getElementById('hotkeyConflictContainer');
        if (conflict && conflictContainer) {
            conflictContainer.innerHTML = `
                <div class="alert alert-warning p-2 text-xs mb-2 mt-1 border-warning">
                    <div class="fw-bold mb-1"><i class="fa-solid fa-triangle-exclamation me-1"></i> Hotkey Conflict Detected</div>
                    <div><strong>[${norm}]</strong> is already bound to <strong>Slot #${conflict.index + 1}</strong> (${conflict.id}).</div>
                    <div class="d-flex gap-2 mt-2">
                        <button type="button" id="confirmRebindBtn" class="btn btn-xs btn-warning w-50">Rebind & Clear Other</button>
                        <button type="button" id="cancelRebindBtn" class="btn btn-xs btn-outline-secondary w-50">Cancel</button>
                    </div>
                </div>
            `;
            const confirmBtn = document.getElementById('confirmRebindBtn');
            const cancelBtn = document.getElementById('cancelRebindBtn');
            if (confirmBtn) {
                confirmBtn.addEventListener('click', () => {
                    // Clear conflicting slot first
                    const confCfg = {
                        targetMode: conflict.targetMode || 'smart_target',
                        hotkey: ''
                    };
                    if (conflict.spellId) confCfg.spellId = conflict.spellId;
                    if (conflict.itemId) confCfg.itemId = conflict.itemId;
                    if (conflict.command) confCfg.command = conflict.command;
                    postToParent({ type: 'assign_slot', slotId: conflict.id, actionType: conflict.actionType || 'empty', cfg: confCfg });

                    // Now assign to current slot
                    const currCfg = {
                        targetMode: slot.targetMode || 'smart_target',
                        hotkey: norm
                    };
                    if (slot.spellId) currCfg.spellId = slot.spellId;
                    if (slot.itemId) currCfg.itemId = slot.itemId;
                    if (slot.command) currCfg.command = slot.command;
                    postToParent({ type: 'assign_slot', slotId: slot.id, actionType: slot.actionType || 'empty', cfg: currCfg });
                    conflictContainer.innerHTML = '';
                });
            }
            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => {
                    renderInspector();
                });
            }
            return;
        }

        // No conflict -> immediately apply keybinding
        const cfg = {
            targetMode: slot.targetMode || 'smart_target',
            hotkey: norm
        };
        if (slot.spellId) cfg.spellId = slot.spellId;
        if (slot.itemId) cfg.itemId = slot.itemId;
        if (slot.command) cfg.command = slot.command;
        postToParent({ type: 'assign_slot', slotId: slot.id, actionType: slot.actionType || 'empty', cfg });
    }

    function renderCatalog() {
        const list = document.getElementById('catalogList');
        if (!list) return;
        list.innerHTML = '';

        if (currentCatalog === 'spells') {
            const spellsMap = appState.spellBook || {};
            const spellList = Array.isArray(spellsMap)
                ? spellsMap
                : Object.keys(spellsMap).map(id => Object.assign({ id }, spellsMap[id], { id: spellsMap[id] && spellsMap[id].id ? spellsMap[id].id : id }));

            let spells = spellList.filter(sp => sp && sp.id).map(sp => {
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
                return { id, name, cost, cd, vocations: sp.vocations || null };
            });

            const showAllEl = /** @type {HTMLInputElement|null} */ (document.getElementById('showAllSpellsToggle'));
            const showAll = showAllEl ? showAllEl.checked : false;

            if (!showAll) {
                // By default filter to active profile vocation / player class
                const targetVoc = (appState.activeProfileId || 'default').toLowerCase();
                if (targetVoc !== 'default') {
                    spells = spells.filter(sp => !Array.isArray(sp.vocations) || sp.vocations.length === 0 || sp.vocations.map(v => String(v).toLowerCase()).indexOf(targetVoc) >= 0);
                }
            }

            const searchEl = /** @type {HTMLInputElement|null} */ (document.getElementById('spellSearchInput'));
            const query = searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : '';
            if (query) {
                spells = spells.filter(sp => sp.id.toLowerCase().indexOf(query) >= 0 || sp.name.toLowerCase().indexOf(query) >= 0);
            }

            if (!spells.length) {
                list.innerHTML = '<div class="text-muted small p-3 text-center">No matching spells found.</div>';
                return;
            }

            spells.forEach(sp => {
                const div = document.createElement('div');
                div.className = 'catalog-item d-flex justify-content-between align-items-center';
                div.draggable = true;
                div.innerHTML = `
                    <div class="text-truncate pe-2">
                        <i class="fa-solid fa-wand-magic-sparkles text-warning me-2"></i>
                        <span class="fw-bold text-light">${sp.name}</span>
                        <span class="text-muted text-xxs d-block font-monospace">${sp.id} | Cost: ${sp.cost} | CD: ${sp.cd}s</span>
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
                            postToParent({
                                type: 'assign_slot',
                                slotId: selectedSlotId,
                                actionType: 'spell',
                                cfg: { spellId: sp.id, targetMode: slot.targetMode || 'smart_target', hotkey: slot.hotkey || '' }
                            });
                        }
                    });
                }
                list.appendChild(div);
            });
        } else {
            // Items & Runes Catalog
            let items = Array.isArray(appState.itemDb) ? appState.itemDb : [];
            const catSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('itemCategoryFilter'));
            const catFilter = catSel && catSel.value ? catSel.value : 'all';
            
            if (catFilter !== 'all') {
                items = items.filter(it => {
                    const t = String(it.type || it.category || '').toLowerCase();
                    if (catFilter === 'rune') return t.indexOf('rune') >= 0 || String(it.id).indexOf('rune') >= 0;
                    if (catFilter === 'potion') return t.indexOf('potion') >= 0 || t.indexOf('consumable') >= 0 || String(it.id).indexOf('potion') >= 0;
                    return t.indexOf('weapon') >= 0 || t.indexOf('armor') >= 0 || t.indexOf('shield') >= 0;
                });
            }

            const searchEl = /** @type {HTMLInputElement|null} */ (document.getElementById('itemSearchInput'));
            const query = searchEl && searchEl.value ? searchEl.value.trim().toLowerCase() : '';
            if (query) {
                items = items.filter(it => String(it.id || '').toLowerCase().indexOf(query) >= 0 || String(it.name || '').toLowerCase().indexOf(query) >= 0);
            }

            if (!items.length) {
                list.innerHTML = '<div class="text-muted small p-3 text-center">No matching items or consumables found.</div>';
                return;
            }

            items.slice(0, 80).forEach(it => {
                const div = document.createElement('div');
                div.className = 'catalog-item d-flex justify-content-between align-items-center';
                div.draggable = true;
                const name = it.name || it.id;
                div.innerHTML = `
                    <div class="text-truncate pe-2">
                        <i class="fa-solid fa-flask text-success me-2"></i>
                        <span class="fw-bold text-light">${name}</span>
                        <span class="text-muted text-xxs d-block font-monospace">${it.id} | Type: ${it.type || 'Consumable'}</span>
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
                            postToParent({
                                type: 'assign_slot',
                                slotId: selectedSlotId,
                                actionType: 'item',
                                cfg: { itemId: it.id, targetMode: slot.targetMode || 'smart_target', hotkey: slot.hotkey || '' }
                            });
                        }
                    });
                }
                list.appendChild(div);
            });
        }
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
                    <span><i class="fa-solid fa-keyboard animate-pulse me-2"></i> Press any key to bind to <strong>${action}</strong>... (Press ESC to cancel)</span>
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

        let keyName = key.toUpperCase();
        if (key === ' ' || key === 'Spacebar') keyName = 'SPACE';
        else if (ev.code && ev.code.startsWith('Digit') && key.length === 1) keyName = ev.code.slice(5);
        else if (ev.code && ev.code.startsWith('Numpad')) keyName = ev.code.toUpperCase();
        else if (ev.code && ev.code.startsWith('Key') && key.length === 1) keyName = ev.code.slice(3);
        
        const mods = [];
        if (ev.ctrlKey && key !== 'Control') mods.push('CTRL');
        if (ev.shiftKey && key !== 'Shift') mods.push('SHIFT');
        if (ev.altKey && key !== 'Alt') mods.push('ALT');
        
        const hotkeyStr = mods.length ? `${mods.join('+')}+${keyName}` : keyName;
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
                    <span><i class="fa-solid fa-circle-info text-info me-2"></i> Key <strong>[${norm}]</strong> was reassigned from <strong>${reassignedFrom}</strong> to <strong>${targetAction}</strong>.</span>
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

        const itemSearch = document.getElementById('itemSearchInput');
        if (itemSearch) itemSearch.addEventListener('input', renderCatalog);
        const itemCat = document.getElementById('itemCategoryFilter');
        if (itemCat) itemCat.addEventListener('change', renderCatalog);
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
                activeProfileId: data.state.activeProfileId
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
