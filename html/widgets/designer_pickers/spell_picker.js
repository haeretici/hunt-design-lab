/**
 * Spells catalog browser (dual-mode).
 * Source: presets/<mode>/spells.json
 *
 * uiMode:
 *   select — popup picker (Cancel / Select, postMessage on confirm) [default]
 *   view   — Wiki / browse (same grid/table + detail sidebar; no confirm chrome)
 *
 * Layout: grid | table (DataTables). Preference: localStorage `hdl_spell_browser_layout`.
 * Filters: text, slot, category, weapon type, vocation, level min/max — client-side.
 *
 * Channel: `hunt-design-lab-designer-picker` (select mode only).
 */

(function () {
    'use strict';

    const CHANNEL = 'hunt-design-lab-designer-picker';
    /** Same convention as content mode / creature browser — shell-shared localStorage. */
    const LAYOUT_STORAGE_KEY = 'hdl_spell_browser_layout';
    const LAYOUTS = { grid: 'grid', table: 'table' };

    function appRoot() {
        const path = window.location.pathname;
        const idx = path.indexOf('/html/widgets/');
        if (idx >= 0) return path.slice(0, idx + 1);
        return '/';
    }

    function apiUrl() {
        return new URL('php/api.php', window.location.origin + appRoot()).href;
    }

    async function apiCall(action, params) {
        const url = new URL(apiUrl());
        url.searchParams.set('action', action);
        for (const [k, v] of Object.entries(params || {})) {
            if (v === undefined || v === null || v === '') continue;
            url.searchParams.set(k, String(v));
        }
        const res = await fetch(url.href, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
            throw new Error((data && data.error) || `API ${action} failed`);
        }
        return data;
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** Matches kernel/core/lib/character/stats.js pipelineToPercent. */
    const COMBAT_PIPELINE_PER_PERCENT = 100;

    /**
     * Compact percent number for UI (no % suffix). 1000 → "10".
     * @param {unknown} n
     * @returns {string}
     */
    function formatPipelinePercent(n) {
        const v = (Number(n) || 0) / COMBAT_PIPELINE_PER_PERCENT;
        if (!Number.isFinite(v)) return '0';
        return String(Math.round(v * 1000) / 1000);
    }

    /**
     * Player-facing crit / leech lines. Pipeline units ÷ 100; chance stays 0–100.
     * @param {Record<string, unknown>|null|undefined} item
     * @returns {string[]}
     */
    function catalogSpecialBonusLines(item) {
        const row = item && typeof item === 'object' ? item : {};
        const lines = [];
        if (row.lifeLeech) lines.push(`Life Leech: ${row.lifeLeech}%`);
        if (row.lifeLeechChance != null && row.lifeLeechAmount != null) {
            lines.push(
                `Life Leech: ${row.lifeLeechChance}% / ${formatPipelinePercent(row.lifeLeechAmount)}%`
            );
        }
        if (row.manaLeech) lines.push(`Mana Leech: ${row.manaLeech}%`);
        if (row.manaLeechChance != null && row.manaLeechAmount != null) {
            lines.push(
                `Mana Leech: ${row.manaLeechChance}% / ${formatPipelinePercent(row.manaLeechAmount)}%`
            );
        }
        if (row.critChance) {
            lines.push(`Crit Chance: ${formatPipelinePercent(row.critChance)}%`);
        }
        if (row.critDamage) lines.push(`Crit Damage: ${row.critDamage}%`);
        if (row.critExtraDamage != null) {
            lines.push(`Crit Extra Dmg: ${formatPipelinePercent(row.critExtraDamage)}%`);
        }
        return lines;
    }

    /**
     * Slug/ID → Title_Case stem for sprite lookup
     * e.g. "steel_plate" → "Steel_Plate"
     */
    function idToFileStem(id) {
        return String(id || '')
            .trim()
            .replace(/\.png$/i, '')
            .split(/[_\s-]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
            .join('_');
    }

    function resolveSpriteUrl(id, genre) {
        if (!id) return null;
        const stem = idToFileStem(id);
        const g = genre || 'rpg_fantasy';
        return new URL(
            `assets/sprites/${g}/ui/alpha/${stem}.png`,
            window.location.origin + appRoot()
        ).href;
    }

    /**
     * Art id + genre for wiki thumbs.
     * Priority: customSprite → spriteId → entity id;
     * genre: customSpriteGenre → customGenre → item.genre → init.genre → rpg_fantasy.
     * @param {Record<string, unknown>|null|undefined} item
     * @returns {string|null}
     */
    function resolveItemSpriteUrl(item) {
        if (!item || typeof item !== 'object') return null;
        const artId = trimStr(
            item.customUISprite || item.customSprite || item.spriteId || item.id
        );
        if (!artId) return null;
        const genre = trimStr(
            item.customSpriteGenre ||
                item.customGenre ||
                item.spriteGenre ||
                item.genre ||
                (init && init.genre) ||
                'rpg_fantasy'
        );
        return resolveSpriteUrl(artId, genre || 'rpg_fantasy');
    }

    /** @param {unknown} v @returns {string} */
    function trimStr(v) {
        if (v == null) return '';
        return String(v).trim();
    }

    /**
     * @param {string} [fallback='grid']
     * @returns {'grid'|'table'}
     */
    function getPreferredLayout(fallback) {
        const fb = fallback === LAYOUTS.table ? LAYOUTS.table : LAYOUTS.grid;
        try {
            if (typeof localStorage !== 'undefined') {
                const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
                if (raw === LAYOUTS.table || raw === LAYOUTS.grid) return raw;
            }
        } catch (_) {
            /* private mode / blocked storage */
        }
        return fb;
    }

    /**
     * @param {'grid'|'table'|string} layout
     * @returns {boolean}
     */
    function setPreferredLayout(layout) {
        const v = layout === LAYOUTS.table ? LAYOUTS.table : LAYOUTS.grid;
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(LAYOUT_STORAGE_KEY, v);
                return true;
            }
        } catch (_) {
            /* ignore */
        }
        return false;
    }

    let init = null;
    /** @type {'select'|'view'} */
    let uiMode = 'select';
    /** @type {'grid'|'table'} */
    let layoutMode = LAYOUTS.grid;
    /** @type {Array<Record<string, unknown>>} */
    let items = [];
    /** @type {Record<string, unknown>|null} */
    let selected = null;
    let filter = '';
    let kindFilter = '';
    let elementFilter = '';
    let weaponTypeFilter = '';
    let vocationFilter = '';
    /** @type {number|null} */
    let minLevel = null;
    /** @type {number|null} */
    let maxLevel = null;
    let sortBy = 'level_asc';
    let filterDebounce = null;
    /** @type {import('datatables.net').Api|null} */
    let dataTable = null;
    let tableBound = false;
    /** Last DataTables order to restore after filter re-render (do not reset on row click).
     * Columns: 0=batch check, 1=thumb, 2=name, … */
    let tableOrder = [[2, 'asc']];

    /** @type {ReturnType<typeof window.DeSmartUpdate.createController>|null} */
    let batchActions = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function ensureBatchActions() {
        if (batchActions) return batchActions;
        if (!window.DeSmartUpdate || typeof window.DeSmartUpdate.createController !== 'function') {
            return null;
        }
        batchActions = window.DeSmartUpdate.createController({
            kind: 'spells',
            getMode: () => (init && init.mode) || 'standard',
            getGenre: () => (init && init.genre) || 'rpg_fantasy',
            getCategory: () => elementFilter || '',
            isViewMode: () => uiMode === 'view',
            getItemMeta: (id) => {
                const item = items.find((t) => String(t.id) === String(id));
                return item
                    ? { alias: item.label || item.id, label: item.label }
                    : { alias: id };
            },
            apiRoot: () => appRoot(),
            statusEl: () => byId('eqSelection'),
            onPatched: (updated) => {
                const map = new Map(
                    (updated || []).map((u) => [String(u.id), u])
                );
                items.forEach((item) => {
                    const u = map.get(String(item.id));
                    if (!u) return;
                    item.customUISprite = u.customSprite;
                    delete item.customSpriteGenre;
                    delete item.customGenre;
                });
                if (selected && map.has(String(selected.id))) {
                    const u = map.get(String(selected.id));
                    selected.customUISprite = u.customSprite;
                    delete selected.customSpriteGenre;
                    delete selected.customGenre;
                }
                render();
            }
        });
        return batchActions;
    }

    function normalizeUiMode(raw) {
        const s = String(raw || '')
            .trim()
            .toLowerCase();
        if (s === 'view' || s === 'browse' || s === 'wiki') return 'view';
        return 'select';
    }

    function applyUiMode(mode) {
        uiMode = normalizeUiMode(mode);
        document.body.classList.remove('ui-mode-select', 'ui-mode-view');
        document.body.classList.add(uiMode === 'view' ? 'ui-mode-view' : 'ui-mode-select');
        if (uiMode === 'view') {
            const titleEl = byId('eqTitle');
            if (titleEl && (!init || !init.title)) {
                titleEl.textContent = 'Spells';
            }
            document.title = 'Spells wiki — Hunt Design Lab';
        }
    }

    function isSelectMode() {
        return uiMode !== 'view';
    }

    /**
     * @param {'grid'|'table'|string} mode
     * @param {{ persist?: boolean }} [opts]
     */
    function applyLayout(mode, opts) {
        const next = mode === LAYOUTS.table ? LAYOUTS.table : LAYOUTS.grid;
        layoutMode = next;
        document.body.classList.remove('layout-grid', 'layout-table');
        document.body.classList.add(next === LAYOUTS.table ? 'layout-table' : 'layout-grid');

        const gridBtn = byId('eqLayoutGrid');
        const tableBtn = byId('eqLayoutTable');
        if (gridBtn) gridBtn.classList.toggle('is-active', next === LAYOUTS.grid);
        if (tableBtn) tableBtn.classList.toggle('is-active', next === LAYOUTS.table);

        const sortEl = byId('eqSort');
        if (sortEl) {
            // Table uses DataTables column sort; card sort still useful for grid.
            sortEl.disabled = next === LAYOUTS.table;
            sortEl.title =
                next === LAYOUTS.table
                    ? 'Sort via table column headers'
                    : 'Sort order (card layout)';
        }

        const tableWrap = byId('eqTableWrap');
        if (tableWrap) tableWrap.hidden = next !== LAYOUTS.table;

        // Default: persist (user toggle). Pass { persist: false } only when restoring on load.
        const shouldPersist = !opts || opts.persist !== false;
        if (shouldPersist) {
            setPreferredLayout(next);
        }
    }

    function parseQuery() {
        const params = new URLSearchParams(window.location.search);
        return {
            mode: params.get('mode') || 'standard',
            genre: params.get('genre') || 'rpg_fantasy',
            kindFilter: params.get('kindFilter') || params.get('slot') || '',
            currentId: params.get('id') || '',
            fieldPath: params.get('fieldPath') || '',
            title: params.get('title') || '',
            uiMode: params.get('uiMode') || params.get('mode_ui') || 'select'
        };
    }

    function post(msg) {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage({ channel: CHANNEL, ...msg }, '*');
        }
    }

    function formatNum(n) {
        if (n == null || n === '') return '—';
        const v = Number(n);
        if (isNaN(v)) return String(n);
        return v.toLocaleString();
    }

    function itemLevel(item) {
        if (!item || item.level == null || item.level === '') return null;
        const n = Number(item.level);
        return isNaN(n) ? null : n;
    }

    function itemElement(item) {
        if (!item || item.element == null) return '';
        return String(item.element).trim().toLowerCase();
    }

    function itemKind(item) {
        if (!item || item.kind == null) return '';
        return String(item.kind).trim().toLowerCase();
    }

    /**
     * @param {Record<string, unknown>} item
     * @returns {string[]} lowercased vocation ids
     */
    function itemVocations(item) {
        if (!item) return [];
        const v = item.vocation != null ? item.vocation : item.vocations;
        if (v == null) return [];
        if (Array.isArray(v)) {
            return v.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
        }
        const s = String(v).trim().toLowerCase();
        return s ? [s] : [];
    }

    function matchesKind(item) {
        if (!kindFilter) return true;
        const target = kindFilter.toLowerCase();
        return itemKind(item) === target;
    }

    /**
     * Apply text / slot / category / weapon type / vocation / level filters.
     * @returns {Array<Record<string, unknown>>}
     */
    function filteredItems() {
        const q = String(filter || '')
            .trim()
            .toLowerCase();
        const cat = String(elementFilter || '')
            .trim()
            .toLowerCase();
        const voc = String(vocationFilter || '')
            .trim()
            .toLowerCase();
        const minL = minLevel != null && !isNaN(minLevel) ? minLevel : null;
        const maxL = maxLevel != null && !isNaN(maxLevel) ? maxLevel : null;

        return items.filter((item) => {
            if (!matchesKind(item)) return false;

            if (cat && itemElement(item) !== cat) return false;

            if (voc) {
                const vocs = itemVocations(item);
                // Items with no vocation restriction are usable by all — keep them.
                if (vocs.length > 0 && !vocs.includes(voc)) return false;
            }

            if (minL != null || maxL != null) {
                const lvl = itemLevel(item);
                // Level-gated filters: items without level are treated as 1 (common default).
                const effective = lvl != null ? lvl : 1;
                if (minL != null && effective < minL) return false;
                if (maxL != null && effective > maxL) return false;
            }

            if (q) {
                const hay = [
                    item.id,
                    item.label,
                    item.element,
                    item.kind,
                    item.level != null ? `lvl ${item.level}` : ''
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
                if (!hay.includes(q)) return false;
            }

            return true;
        });
    }

    function sortItems(list) {
        const sort = sortBy || 'level_asc';
        return list.slice().sort((a, b) => {
            if (sort === 'level_asc') {
                const la = itemLevel(a) != null ? itemLevel(a) : 1;
                const lb = itemLevel(b) != null ? itemLevel(b) : 1;
                if (la !== lb) return la - lb;
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'level_desc') {
                const la = itemLevel(a) != null ? itemLevel(a) : 1;
                const lb = itemLevel(b) != null ? itemLevel(b) : 1;
                if (lb !== la) return lb - la;
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'name_asc') {
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'stat_desc') {
                const sa = Number(a.basePower) || 0;
                const sb = Number(b.basePower) || 0;
                if (sb !== sa) return sb - sa;
                return (itemLevel(b) || 1) - (itemLevel(a) || 1);
            }
            if (sort === 'element_asc') {
                const ca = itemElement(a) || '\uffff';
                const cb = itemElement(b) || '\uffff';
                if (ca !== cb) return ca.localeCompare(cb);
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'kind_asc') {
                const sa = String(a.kind || '').toLowerCase() || '\uffff';
                const sb = String(b.kind || '').toLowerCase() || '\uffff';
                if (sa !== sb) return sa.localeCompare(sb);
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            return 0;
        });
    }

    function rebuildCategoryOptions() {
        const sel = byId('eqElement');
        if (!sel) return;
        const prev = elementFilter;
        const cats = new Set();
        items.forEach((item) => {
            const c = itemElement(item);
            if (c) cats.add(c);
        });
        const sorted = Array.from(cats).sort((a, b) => a.localeCompare(b));
        const opts = ['<option value="">All categories</option>'];
        sorted.forEach((c) => {
            opts.push(`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`);
        });
        sel.innerHTML = opts.join('');
        if (prev && cats.has(prev)) {
            sel.value = prev;
            elementFilter = prev;
        } else {
            sel.value = '';
            elementFilter = '';
        }
    }

    function rebuildVocationOptions() {
        const sel = byId('eqVocation');
        if (!sel) return;
        const prev = vocationFilter;
        const vocs = new Set();
        items.forEach((item) => {
            itemVocations(item).forEach((v) => vocs.add(v));
        });
        const sorted = Array.from(vocs).sort((a, b) => a.localeCompare(b));
        const opts = ['<option value="">All vocations</option>'];
        sorted.forEach((v) => {
            opts.push(`<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`);
        });
        sel.innerHTML = opts.join('');
        if (prev && vocs.has(prev)) {
            sel.value = prev;
            vocationFilter = prev;
        } else {
            sel.value = '';
            vocationFilter = '';
        }
    }

    function captureTableOrder() {
        if (!dataTable) return;
        try {
            const o = dataTable.order();
            if (o && o.length) {
                tableOrder = o.map((pair) => [pair[0], pair[1]]);
            }
        } catch (_) {
            /* ignore */
        }
    }

    function destroyDataTable() {
        captureTableOrder();
        if (dataTable) {
            try {
                dataTable.destroy();
            } catch (_) {
                /* ignore */
            }
            dataTable = null;
        }
        const body = byId('eqTableBody');
        if (body) body.innerHTML = '';
    }

    /**
     * Highlight selected row/card without destroying DataTables (keeps column sort).
     */
    function refreshSelectionUi() {
        const selId = selected ? String(selected.id) : null;
        const tableEl = byId('eqTable');
        if (tableEl) {
            tableEl.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
                tr.classList.toggle(
                    'is-selected',
                    !!selId && tr.getAttribute('data-id') === selId
                );
            });
        }
        const grid = byId('eqGrid');
        if (grid) {
            grid.querySelectorAll('.eq-card[data-id]').forEach((card) => {
                card.classList.toggle(
                    'is-selected',
                    !!selId && card.getAttribute('data-id') === selId
                );
            });
        }
        updateSelectionChrome();
        renderSidebar();
    }

    function updateSelectionChrome() {
        const selEl = byId('eqSelection');
        const selectBtn = byId('eqSelect');
        if (selEl) {
            if (uiMode === 'view') {
                selEl.textContent = selected
                    ? `${selected.label || selected.id} (${selected.id})`
                    : 'Select an item to view details';
            } else {
                selEl.textContent = selected
                    ? `Selected: ${selected.label || selected.id} (${selected.id})`
                    : 'Nothing selected';
            }
        }
        if (selectBtn) {
            selectBtn.disabled = !selected || !isSelectMode();
        }
    }

    /**
     * @param {string|null} id
     */
    function selectItem(id) {
        if (!id) {
            selected = null;
            refreshSelectionUi();
            return;
        }
        selected = items.find((t) => String(t.id) === String(id)) || null;
        refreshSelectionUi();
    }

    /**
     * @param {Array<Record<string, unknown>>} list
     */
    function renderTable(list) {
        const wrap = byId('eqTableWrap');
        const tableEl = byId('eqTable');
        if (!wrap || !tableEl) return;

        destroyDataTable();

        const body = byId('eqTableBody');
        if (!body) return;

        const batch = ensureBatchActions();
        body.innerHTML = list
            .map((item) => {
                const isSel = selected && String(selected.id) === String(item.id);
                const imgUrl = resolveItemSpriteUrl(item);
                const lvl = itemLevel(item);
                const mana = item.mana != null ? Number(item.mana) : null;
                const pwr = item.basePower != null ? Number(item.basePower) : null;
                const kind = item.kind != null ? String(item.kind) : '';
                const element = item.element != null ? String(item.element) : '';
                const thumb = imgUrl
                    ? `<span class="eq-table-thumb"><img src="${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\\'missing\\'>—</span>'"></span>`
                    : `<span class="eq-table-thumb"><span class="missing">—</span></span>`;
                const checkTd =
                    uiMode === 'view' && batch
                        ? `<td class="eq-table-check">${batch.checkboxHtml(item.id)}</td>`
                        : '<td class="eq-table-check"></td>';

                return `<tr class="${isSel ? 'is-selected' : ''}" data-id="${escapeHtml(item.id)}">
                    ${checkTd}
                    <td>${thumb}</td>
                    <td class="eq-table-name">${escapeHtml(item.label || item.id)}</td>
                    <td class="eq-table-id">${escapeHtml(item.id)}</td>
                    <td>${kind ? escapeHtml(kind) : '<span class="text-muted">—</span>'}</td>
                    <td>${element ? escapeHtml(element) : '<span class="text-muted">—</span>'}</td>
                    <td class="eq-num" data-order="${lvl != null ? lvl : -1}">${lvl != null ? lvl : '—'}</td>
                    <td class="eq-num" data-order="${mana != null && !isNaN(mana) ? mana : -1}">${mana != null && !isNaN(mana) ? formatNum(mana) : '—'}</td>
                    <td class="eq-num" data-order="${pwr != null && !isNaN(pwr) ? pwr : -1}">${pwr != null && !isNaN(pwr) ? formatNum(pwr) : '—'}</td>
                </tr>`;
            })
            .join('');

        if (typeof window.DataTable !== 'function') {
            console.warn('DataTables not loaded — plain table fallback');
            return;
        }

        const order =
            Array.isArray(tableOrder) && tableOrder.length
                ? tableOrder
                : [[2, 'asc']];

        dataTable = new window.DataTable(tableEl, {
            pageLength: 25,
            lengthMenu: [10, 25, 50, 100, 250],
            order,
            columnDefs: [
                { orderable: false, targets: [0, 1], width: '48px' },
                { type: 'num', targets: [6, 7, 8] }
            ],
            language: {
                search: 'Search table:',
                lengthMenu: 'Show _MENU_',
                info: '_START_–_END_ of _TOTAL_',
                infoEmpty: '0 items',
                zeroRecords: 'No spells match this filter.'
            },
            drawCallback: function () {
                if (!selected) return;
                const id = String(selected.id);
                tableEl.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
                    tr.classList.toggle(
                        'is-selected',
                        tr.getAttribute('data-id') === id
                    );
                });
            }
        });

        dataTable.on('order', function () {
            captureTableOrder();
        });

        if (!tableBound) {
            tableBound = true;
            // Delegate: DataTables rewrites tbody. Do NOT call full render() —
            // that would destroy/recreate the table and reset column sort.
            jQuery(tableEl).on('click', 'tbody tr[data-id]', function (ev) {
                if (ev.target && ev.target.closest && ev.target.closest('th')) {
                    return;
                }
                if (
                    ev.target &&
                    ev.target.closest &&
                    ev.target.closest('.de-batch-check-wrap')
                ) {
                    return;
                }
                const id = this.getAttribute('data-id');
                if (id) selectItem(id);
            });
            jQuery(tableEl).on('dblclick', 'tbody tr[data-id]', function (ev) {
                if (
                    ev.target &&
                    ev.target.closest &&
                    ev.target.closest('.de-batch-check-wrap')
                ) {
                    return;
                }
                const id = this.getAttribute('data-id');
                if (!id) return;
                selectItem(id);
                if (isSelectMode()) confirmSelection();
            });
        }
    }

    /**
     * @param {Array<Record<string, unknown>>} list
     */
    function renderGrid(list) {
        const grid = byId('eqGrid');
        if (!grid) return;

        grid.innerHTML = list
            .map((item) => {
                const isSel = selected && String(selected.id) === String(item.id);
                const imgUrl = resolveItemSpriteUrl(item);

                const lvl = itemLevel(item);
                const mana = item.mana != null ? Number(item.mana) : null;
                const pwr = item.basePower != null ? Number(item.basePower) : null;
                const kind = item.kind != null ? String(item.kind) : '';
                const element = item.element != null ? String(item.element) : '';

                const badges = [];
                if (lvl != null) badges.push(`<span class="eq-badge eq-badge-lvl">Lvl ${lvl}</span>`);
                if (kind) {
                    badges.push(
                        `<span class="eq-badge eq-badge-cat">${escapeHtml(kind)}</span>`
                    );
                }
                if (element) {
                    badges.push(`<span class="eq-badge eq-badge-element" style="color: #a5d6ff; border-color: rgba(165,214,255,0.25); background: rgba(165,214,255,0.08);">${escapeHtml(element)}</span>`);
                }
                if (pwr != null && !isNaN(pwr)) {
                    badges.push(`<span class="eq-badge eq-badge-atk">Pwr ${formatNum(pwr)}</span>`);
                }

                const batch = ensureBatchActions();
                const checkHtml =
                    uiMode === 'view' && batch ? batch.checkboxHtml(item.id) : '';

                return `
                    <div class="eq-card ${isSel ? 'is-selected' : ''}" data-id="${escapeHtml(item.id)}">
                        ${checkHtml}
                        <div class="eq-thumb">
                            ${imgUrl ? `<img src="${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\\'missing\\'>no img</span>'">` : '<span class="missing">no img</span>'}
                        </div>
                        <div class="eq-name" title="${escapeHtml(item.label || item.id)}">${escapeHtml(item.label || item.id)}</div>
                        <div class="eq-id" title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</div>
                        ${badges.length > 0 ? `<div class="eq-stats">${badges.join('')}</div>` : ''}
                    </div>
                `;
            })
            .join('');

        grid.querySelectorAll('.eq-card').forEach((card) => {
            const id = card.getAttribute('data-id');
            card.addEventListener('click', (ev) => {
                if (ev.target && ev.target.closest && ev.target.closest('.de-batch-check-wrap')) {
                    return;
                }
                selectItem(id);
            });
            card.addEventListener('dblclick', (ev) => {
                if (ev.target && ev.target.closest && ev.target.closest('.de-batch-check-wrap')) {
                    return;
                }
                selectItem(id);
                if (isSelectMode()) {
                    confirmSelection();
                }
            });
        });
    }

    function renderSidebar() {
        const empty = byId('eqSidebarEmpty');
        const content = byId('eqSidebarContent');
        if (!empty || !content) return;

        if (!selected) {
            empty.hidden = false;
            content.hidden = true;
            content.innerHTML = '';
            return;
        }

        empty.hidden = true;
        content.hidden = false;

        const imgUrl = resolveItemSpriteUrl(selected);

        const lvl = selected.level != null ? Number(selected.level) : null;
        const mana = selected.mana != null ? Number(selected.mana) : null;
        const pwr = selected.basePower != null ? Number(selected.basePower) : null;
        const kind = selected.kind != null ? String(selected.kind) : '';
        const element = selected.element != null ? String(selected.element) : '';
        const range = selected.range != null ? Number(selected.range) : null;
        const vocs = itemVocations(selected);

        let html = `
            <div class="eq-detail-header">
                <div class="eq-detail-thumb">
                    ${imgUrl ? `<img src="${escapeHtml(imgUrl)}" alt="" onerror="this.parentElement.innerHTML='<span class=\\'missing\\'>no img</span>'">` : '<span class="missing">no img</span>'}
                </div>
                <h2 class="eq-detail-title">${escapeHtml(selected.label || selected.id)}</h2>
                <div class="eq-detail-id">${escapeHtml(selected.id)}</div>
            </div>
            <div class="eq-detail-section">
                <div class="eq-detail-section-title"><i class="fa-solid fa-chart-simple"></i> Core Attributes</div>
                <div class="eq-stat-list">
                    <div class="eq-stat-row">
                        <div class="eq-stat-label"><i class="fa-solid fa-cube text-primary"></i> Kind</div>
                        <div class="eq-stat-val eq-val-slot">${escapeHtml(kind || '—')}</div>
                    </div>
                    <div class="eq-stat-row">
                        <div class="eq-stat-label"><i class="fa-solid fa-tag text-success"></i> Element</div>
                        <div class="eq-stat-val eq-val-cat">${escapeHtml(element || '—')}</div>
                    </div>
                    ${lvl != null && !isNaN(lvl) ? `
                    <div class="eq-stat-row">
                        <div class="eq-stat-label"><i class="fa-solid fa-shield-cat text-warning"></i> Min Level</div>
                        <div class="eq-stat-val eq-val-lvl">Lvl ${lvl}</div>
                    </div>` : ''}
                    ${mana != null ? `
                    <div class="eq-stat-row">
                        <div class="eq-stat-label"><i class="fa-solid fa-droplet text-info"></i> Mana</div>
                        <div class="eq-stat-val eq-val-speed">${mana}</div>
                    </div>` : ''}
                    ${pwr != null ? `
                    <div class="eq-stat-row">
                        <div class="eq-stat-label"><i class="fa-solid fa-burst text-danger"></i> Base Power</div>
                        <div class="eq-stat-val eq-val-atk">${pwr}</div>
                    </div>` : ''}
                    ${range != null ? `
                    <div class="eq-stat-row">
                        <div class="eq-stat-label"><i class="fa-solid fa-arrows-left-right text-secondary"></i> Range</div>
                        <div class="eq-stat-val eq-val-wgt">${range}</div>
                    </div>` : ''}
                </div>
            </div>
        `;

        if (vocs.length > 0) {
            html += `
                <div class="eq-detail-section">
                    <div class="eq-detail-section-title"><i class="fa-solid fa-user-shield"></i> Vocations</div>
                    <div class="eq-pills-wrap">
                        ${vocs.map((v) => `<span class="eq-pill">${escapeHtml(v)}</span>`).join('')}
                    </div>
                </div>
            `;
        }

        const bonuses = catalogSpecialBonusLines(selected);
        if (Array.isArray(selected.imbuements)) {
            selected.imbuements.forEach((b) => bonuses.push(`Imbuement: ${b}`));
        }
        if (selected.imbuementSlots != null && Number(selected.imbuementSlots) > 0) {
            bonuses.push(`Imbuement slots: ${selected.imbuementSlots}`);
        }

        if (bonuses.length > 0) {
            html += `
                <div class="eq-detail-section">
                    <div class="eq-detail-section-title"><i class="fa-solid fa-wand-magic-sparkles"></i> Special Bonuses</div>
                    <div class="eq-pills-wrap">
                        ${bonuses.map((b) => `<span class="eq-pill eq-pill-bonus">${escapeHtml(b)}</span>`).join('')}
                    </div>
                </div>
            `;
        }

        const skillBonuses =
            selected.skillBonuses && typeof selected.skillBonuses === 'object'
                ? selected.skillBonuses
                : null;
        if (skillBonuses) {
            const pills = Object.keys(skillBonuses)
                .filter((k) => Number(skillBonuses[k]) !== 0)
                .map((k) => {
                    const v = Number(skillBonuses[k]);
                    const sign = v > 0 ? '+' : '';
                    return `<span class="eq-pill">${escapeHtml(k)}: ${sign}${v}</span>`;
                });
            if (pills.length) {
                html += `
                    <div class="eq-detail-section">
                        <div class="eq-detail-section-title"><i class="fa-solid fa-crosshairs"></i> Skill Bonuses</div>
                        <div class="eq-pills-wrap">${pills.join('')}</div>
                    </div>
                `;
            }
        }

        const resists =
            selected.resists && typeof selected.resists === 'object'
                ? selected.resists
                : null;
        if (resists) {
            const pills = Object.keys(resists)
                .filter((k) => Number(resists[k]) !== 0)
                .map((k) => {
                    const v = Number(resists[k]);
                    const sign = v > 0 ? '+' : '';
                    return `<span class="eq-pill">${escapeHtml(k)}: ${sign}${v}%</span>`;
                });
            if (pills.length) {
                html += `
                    <div class="eq-detail-section">
                        <div class="eq-detail-section-title"><i class="fa-solid fa-shield"></i> Resistances</div>
                        <div class="eq-pills-wrap">${pills.join('')}</div>
                    </div>
                `;
            }
        }

        const artSprite = trimStr(selected.customSprite || selected.spriteId);
        const artGenre = trimStr(
            selected.customSpriteGenre ||
                selected.customGenre ||
                selected.spriteGenre
        );
        if (artSprite || artGenre) {
            html += `
                <div class="eq-detail-section">
                    <div class="eq-detail-section-title"><i class="fa-solid fa-image"></i> Art</div>
                    <div class="eq-stat-list">
                        ${artSprite ? `
                        <div class="eq-stat-row">
                            <div class="eq-stat-label">Custom Sprite</div>
                            <div class="eq-stat-val font-monospace small">${escapeHtml(artSprite)}</div>
                        </div>` : ''}
                        ${artGenre ? `
                        <div class="eq-stat-row">
                            <div class="eq-stat-label">Sprite Genre</div>
                            <div class="eq-stat-val font-monospace small">${escapeHtml(artGenre)}</div>
                        </div>` : ''}
                    </div>
                </div>
            `;
        }

        content.innerHTML = html;
    }

    function render() {
        const empty = byId('eqEmpty');
        const meta = byId('eqMeta');
        const grid = byId('eqGrid');
        if (!grid) return;

        const filtered = filteredItems();
        const list =
            layoutMode === LAYOUTS.table ? filtered : sortItems(filtered);

        if (meta) {
            const total = items.length;
            const shown = list.length;
            if (shown === total) {
                meta.textContent = `${shown} items`;
            } else {
                meta.textContent = `${shown} shown · ${total} total`;
            }
        }

        if (list.length === 0) {
            grid.innerHTML = '';
            destroyDataTable();
            if (empty) {
                empty.classList.remove('is-error');
                empty.hidden = false;
                empty.textContent = 'No spells match this filter.';
            }
            updateSelectionChrome();
            renderSidebar();
            return;
        }

        if (empty) {
            empty.hidden = true;
            empty.classList.remove('is-error');
        }

        if (layoutMode === LAYOUTS.table) {
            grid.innerHTML = '';
            renderTable(list);
        } else {
            destroyDataTable();
            renderGrid(list);
        }

        updateSelectionChrome();
        renderSidebar();
    }

    function confirmSelection() {
        if (!selected || !isSelectMode()) return;
        post({
            type: 'select',
            requestId: init && init.requestId,
            fieldPath: init && init.fieldPath,
            value: {
                id: String(selected.id),
                label: String(selected.label || selected.id),
                slot: selected.slot != null ? String(selected.slot) : undefined,
                category:
                    selected.category != null ? String(selected.category) : undefined
            }
        });
        try {
            window.close();
        } catch (_) {
            /* ignore */
        }
    }

    async function loadItems() {
        const mode = (init && init.mode) || 'standard';
        const doc = await apiCall('presets_get', {
            mode,
            kind: 'spells'
        });
        const dataArray = (doc && doc.document && doc.document.spells) || (doc && doc.document && doc.document.items);
        items = Array.isArray(dataArray) ? dataArray : [];
        rebuildCategoryOptions();
        rebuildVocationOptions();

        render();
        const currentId = init && init.currentId ? String(init.currentId) : '';
        if (currentId) {
            selectItem(currentId);
        }
    }

    function parseOptionalInt(raw) {
        const s = String(raw == null ? '' : raw).trim();
        if (s === '') return null;
        const n = parseInt(s, 10);
        return isNaN(n) ? null : n;
    }

    function scheduleFilterRender() {
        if (filterDebounce) clearTimeout(filterDebounce);
        filterDebounce = setTimeout(() => {
            filterDebounce = null;
            render();
        }, 120);
    }

    function applyInit(payload) {
        init = payload || {};
        const q = parseQuery();
        init.mode = init.mode || q.mode;
        init.genre = init.genre || q.genre;
        init.kindFilter = init.kindFilter || q.kindFilter;
        init.currentId = init.currentId || q.currentId;
        init.fieldPath = init.fieldPath || q.fieldPath;
        init.title = init.title || q.title;
        init.uiMode = init.uiMode || q.uiMode;

        applyUiMode(init.uiMode);
        applyLayout(getPreferredLayout(LAYOUTS.grid), { persist: false });

        if (init.title) {
            const titleEl = byId('eqTitle');
            if (titleEl) titleEl.textContent = init.title;
        } else if (uiMode === 'view') {
            const titleEl = byId('eqTitle');
            if (titleEl) titleEl.textContent = 'Spells';
        }

        if (init.kindFilter) {
            kindFilter = String(init.kindFilter);
            const slotEl = byId('eqKind');
            if (slotEl) slotEl.value = kindFilter;
        }

        loadItems().catch((err) => {
            const empty = byId('eqEmpty');
            if (empty) {
                empty.hidden = false;
                empty.classList.add('is-error');
                empty.textContent =
                    'Failed to load spells catalog: ' + (err.message || err);
            }
        });
    }

    function bindEvents() {
        const filterInput = byId('eqFilter');
        if (filterInput) {
            filterInput.addEventListener('input', () => {
                filter = filterInput.value.trim();
                scheduleFilterRender();
            });
        }

        const slotEl = byId('eqKind');
        if (slotEl) {
            slotEl.addEventListener('change', () => {
                kindFilter = slotEl.value;
                render();
            });
        }

        const catEl = byId('eqElement');
        if (catEl) {
            catEl.addEventListener('change', () => {
                elementFilter = String(catEl.value || '')
                    .trim()
                    .toLowerCase();
                render();
            });
        }


        const vocEl = byId('eqVocation');
        if (vocEl) {
            vocEl.addEventListener('change', () => {
                vocationFilter = String(vocEl.value || '')
                    .trim()
                    .toLowerCase();
                render();
            });
        }

        const minLvlEl = byId('eqMinLevel');
        if (minLvlEl) {
            minLvlEl.addEventListener('input', () => {
                minLevel = parseOptionalInt(minLvlEl.value);
                scheduleFilterRender();
            });
            minLvlEl.addEventListener('change', () => {
                minLevel = parseOptionalInt(minLvlEl.value);
                render();
            });
        }

        const maxLvlEl = byId('eqMaxLevel');
        if (maxLvlEl) {
            maxLvlEl.addEventListener('input', () => {
                maxLevel = parseOptionalInt(maxLvlEl.value);
                scheduleFilterRender();
            });
            maxLvlEl.addEventListener('change', () => {
                maxLevel = parseOptionalInt(maxLvlEl.value);
                render();
            });
        }

        const sortEl = byId('eqSort');
        if (sortEl) {
            sortEl.addEventListener('change', () => {
                sortBy = sortEl.value;
                if (layoutMode === LAYOUTS.grid) render();
            });
        }

        const gridBtn = byId('eqLayoutGrid');
        if (gridBtn) {
            gridBtn.addEventListener('click', () => {
                if (layoutMode === LAYOUTS.grid) return;
                applyLayout(LAYOUTS.grid);
                render();
            });
        }

        const tableBtn = byId('eqLayoutTable');
        if (tableBtn) {
            tableBtn.addEventListener('click', () => {
                if (layoutMode === LAYOUTS.table) return;
                applyLayout(LAYOUTS.table);
                render();
            });
        }

        const cancelBtn = byId('eqCancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (!isSelectMode()) return;
                post({ type: 'cancel', requestId: init && init.requestId });
                window.close();
            });
        }

        const selectBtn = byId('eqSelect');
        if (selectBtn) {
            selectBtn.addEventListener('click', confirmSelection);
        }

        window.addEventListener('message', (ev) => {
            if (!ev.data || ev.data.channel !== CHANNEL) return;
            if (ev.data.type === 'init') {
                applyInit(ev.data);
            }
        });
    }

    document.addEventListener('DOMContentLoaded', () => {
        bindEvents();
        const batch = ensureBatchActions();
        if (batch) batch.bind();
        applyInit(parseQuery());
        // Only announce readiness when opened as a selection popup.
        if (isSelectMode() && window.opener && !window.opener.closed) {
            post({ type: 'ready', kind: 'spells' });
        }
    });
})();
