/**
 * Combat creature catalog browser (dual-mode).
 * Source: presets/<mode>/creatures/*.json (folder kind; full summary load).
 *
 * uiMode:
 *   select — popup picker (Cancel / Select, postMessage on confirm) [default]
 *   view   — Wiki / browse (same grid/table + detail sidebar; no picker footer)
 *
 * Layout: grid | table (DataTables). Preference: localStorage `hdl_creature_browser_layout`.
 * Filters: text (name/id), race, bestiary class, level min/max — client-side on loaded summaries.
 *
 * Channel: `hunt-design-lab-designer-picker` (select mode only).
 */

(function () {
    'use strict';

    const CHANNEL = 'hunt-design-lab-designer-picker';
    /** Same convention as content mode (`hdl_content_mode`) — shell-shared localStorage. */
    const LAYOUT_STORAGE_KEY = 'hdl_creature_browser_layout';
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
            `assets/sprites/${g}/creatures/alpha/${stem}.png`,
            window.location.origin + appRoot()
        ).href;
    }

    /**
     * Art id + genre for wiki thumbs — mirrors runtime (creature_sprites / template).
     * Priority: customSprite → spriteId → entity id;
     * genre: customSpriteGenre → customGenre → item.genre → init.genre → rpg_fantasy.
     * @param {Record<string, unknown>|null|undefined} item
     * @returns {string|null}
     */
    function resolveItemSpriteUrl(item) {
        if (!item || typeof item !== 'object') return null;
        const artId = trimStr(
            item.customSprite || item.spriteId || item.id
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
        const fb =
            fallback === LAYOUTS.table ? LAYOUTS.table : LAYOUTS.grid;
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
    /** Full list from API (one load per mode). @type {Array<Record<string, unknown>>} */
    let allItems = [];
    /** @type {Record<string, unknown>|null} */
    let selected = null;
    /** Full entity for sidebar (from presets_get). */
    let selectedDetail = null;
    let filter = '';
    let raceFilter = '';
    let bestiaryClassFilter = '';
    /** @type {number|null} */
    let levelMin = null;
    /** @type {number|null} */
    let levelMax = null;
    let sortBy = 'name_asc';
    let listLoading = false;
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
            kind: 'creatures',
            getMode: () => (init && init.mode) || 'standard',
            getGenre: () => (init && init.genre) || 'rpg_fantasy',
            isViewMode: () => uiMode === 'view',
            getItemMeta: (id) => {
                const item = allItems.find((t) => String(t.id) === String(id));
                return item
                    ? { alias: item.label || item.id, label: item.label }
                    : { alias: id };
            },
            apiRoot: () => appRoot(),
            statusEl: () => byId('crMeta'),
            onPatched: (updated) => {
                const map = new Map(
                    (updated || []).map((u) => [String(u.id), u])
                );
                allItems.forEach((item) => {
                    const u = map.get(String(item.id));
                    if (!u) return;
                    item.customSprite = u.customSprite;
                    delete item.customSpriteGenre;
                    delete item.customGenre;
                });
                if (selected && map.has(String(selected.id))) {
                    const u = map.get(String(selected.id));
                    selected.customSprite = u.customSprite;
                    delete selected.customSpriteGenre;
                    delete selected.customGenre;
                    if (selectedDetail) {
                        selectedDetail.customSprite = u.customSprite;
                        delete selectedDetail.customSpriteGenre;
                        delete selectedDetail.customGenre;
                    }
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
            const titleEl = byId('crTitle');
            if (titleEl && (!init || !init.title)) {
                titleEl.textContent = 'Creatures';
            }
            document.title = 'Creature wiki — Hunt Design Lab';
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

        const gridBtn = byId('crLayoutGrid');
        const tableBtn = byId('crLayoutTable');
        if (gridBtn) gridBtn.classList.toggle('is-active', next === LAYOUTS.grid);
        if (tableBtn) tableBtn.classList.toggle('is-active', next === LAYOUTS.table);

        const sortEl = byId('crSort');
        if (sortEl) {
            // Table uses DataTables column sort; card sort still useful for grid.
            sortEl.disabled = next === LAYOUTS.table;
            sortEl.title =
                next === LAYOUTS.table
                    ? 'Sort via table column headers'
                    : 'Sort order (card layout)';
        }

        const tableWrap = byId('crTableWrap');
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

    /**
     * @param {Record<string, unknown>} item
     * @returns {number|null}
     */
    function itemLevel(item) {
        if (!item || item.level == null || item.level === '') return null;
        const n = Number(item.level);
        return isNaN(n) ? null : n;
    }

    /**
     * @param {Record<string, unknown>} item
     * @returns {string}
     */
    function itemRace(item) {
        if (!item || item.race == null) return '';
        return String(item.race).trim().toLowerCase();
    }

    /**
     * Bestiary class from list summary (`bestiaryClass`) or nested detail.
     * @param {Record<string, unknown>} item
     * @returns {string} lowercased for filter compare; empty if missing
     */
    function itemBestiaryClass(item) {
        if (!item) return '';
        if (item.bestiaryClass != null && String(item.bestiaryClass).trim() !== '') {
            return String(item.bestiaryClass).trim().toLowerCase();
        }
        const b = item.bestiary;
        if (b && typeof b === 'object' && b.class != null) {
            return String(b.class).trim().toLowerCase();
        }
        return '';
    }

    /**
     * Display label for bestiary class (preserves original casing when present).
     * @param {Record<string, unknown>} item
     * @returns {string}
     */
    function itemBestiaryClassLabel(item) {
        if (!item) return '';
        if (item.bestiaryClass != null && String(item.bestiaryClass).trim() !== '') {
            return String(item.bestiaryClass).trim();
        }
        const b = item.bestiary;
        if (b && typeof b === 'object' && b.class != null) {
            return String(b.class).trim();
        }
        return '';
    }

    /**
     * Apply text / race / bestiary class / level filters to the full loaded set.
     * @returns {Array<Record<string, unknown>>}
     */
    function filteredItems() {
        const q = String(filter || '')
            .trim()
            .toLowerCase();
        const race = String(raceFilter || '')
            .trim()
            .toLowerCase();
        const bc = String(bestiaryClassFilter || '')
            .trim()
            .toLowerCase();
        const minL = levelMin != null && !isNaN(levelMin) ? levelMin : null;
        const maxL = levelMax != null && !isNaN(levelMax) ? levelMax : null;

        return allItems.filter((item) => {
            if (q) {
                const id = String(item.id || '').toLowerCase();
                const label = String(item.label || '').toLowerCase();
                if (!id.includes(q) && !label.includes(q)) return false;
            }
            if (race) {
                if (itemRace(item) !== race) return false;
            }
            if (bc) {
                if (itemBestiaryClass(item) !== bc) return false;
            }
            if (minL != null || maxL != null) {
                const lvl = itemLevel(item);
                if (lvl == null) return false;
                if (minL != null && lvl < minL) return false;
                if (maxL != null && lvl > maxL) return false;
            }
            return true;
        });
    }

    /**
     * @param {Array<Record<string, unknown>>} list
     * @returns {Array<Record<string, unknown>>}
     */
    function sortItems(list) {
        const sort = sortBy || 'name_asc';
        return list.slice().sort((a, b) => {
            if (sort === 'name_desc') {
                return String(b.label || b.id).localeCompare(String(a.label || a.id));
            }
            if (sort === 'level_desc') {
                const la = itemLevel(a) || 0;
                const lb = itemLevel(b) || 0;
                if (lb !== la) return lb - la;
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'level_asc') {
                const la = itemLevel(a) || 0;
                const lb = itemLevel(b) || 0;
                if (la !== lb) return la - lb;
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'hp_desc') {
                const ha = Number(a.hp) || 0;
                const hb = Number(b.hp) || 0;
                if (hb !== ha) return hb - ha;
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'exp_desc') {
                const ea = Number(a.exp) || 0;
                const eb = Number(b.exp) || 0;
                if (eb !== ea) return eb - ea;
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'race_asc') {
                const ra = itemRace(a) || '\uffff';
                const rb = itemRace(b) || '\uffff';
                if (ra !== rb) return ra.localeCompare(rb);
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            if (sort === 'bestiary_asc') {
                const ba = itemBestiaryClass(a) || '\uffff';
                const bb = itemBestiaryClass(b) || '\uffff';
                if (ba !== bb) return ba.localeCompare(bb);
                return String(a.label || a.id).localeCompare(String(b.label || b.id));
            }
            // name_asc
            return String(a.label || a.id).localeCompare(String(b.label || b.id));
        });
    }

    function rebuildRaceOptions() {
        const sel = byId('crRace');
        if (!sel) return;
        const prev = raceFilter;
        const races = new Set();
        allItems.forEach((item) => {
            const r = itemRace(item);
            if (r) races.add(r);
        });
        const sorted = Array.from(races).sort((a, b) => a.localeCompare(b));
        const opts = ['<option value="">All races</option>'];
        sorted.forEach((r) => {
            opts.push(
                `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`
            );
        });
        sel.innerHTML = opts.join('');
        if (prev && races.has(prev)) {
            sel.value = prev;
            raceFilter = prev;
        } else {
            sel.value = '';
            raceFilter = '';
        }
    }

    function rebuildBestiaryClassOptions() {
        const sel = byId('crBestiaryClass');
        if (!sel) return;
        const prev = bestiaryClassFilter;
        /** @type {Map<string, string>} lower → display label */
        const classes = new Map();
        allItems.forEach((item) => {
            const key = itemBestiaryClass(item);
            if (!key) return;
            if (!classes.has(key)) {
                classes.set(key, itemBestiaryClassLabel(item) || key);
            }
        });
        const sorted = Array.from(classes.keys()).sort((a, b) => a.localeCompare(b));
        const opts = ['<option value="">All bestiary classes</option>'];
        sorted.forEach((key) => {
            const label = classes.get(key) || key;
            opts.push(
                `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`
            );
        });
        sel.innerHTML = opts.join('');
        if (prev && classes.has(prev)) {
            sel.value = prev;
            bestiaryClassFilter = prev;
        } else {
            sel.value = '';
            bestiaryClassFilter = '';
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
        const body = byId('crTableBody');
        if (body) body.innerHTML = '';
    }

    /**
     * Highlight selected row/card without destroying DataTables (keeps column sort).
     */
    function refreshSelectionUi() {
        const selId = selected ? String(selected.id) : null;
        const tableEl = byId('crTable');
        if (tableEl) {
            tableEl.querySelectorAll('tbody tr[data-id]').forEach((tr) => {
                tr.classList.toggle(
                    'is-selected',
                    !!selId && tr.getAttribute('data-id') === selId
                );
            });
        }
        const grid = byId('crGrid');
        if (grid) {
            grid.querySelectorAll('.cr-card[data-id]').forEach((card) => {
                card.classList.toggle(
                    'is-selected',
                    !!selId && card.getAttribute('data-id') === selId
                );
            });
        }
        updateSelectionChrome();
        renderSidebar();
    }

    /**
     * @param {Array<Record<string, unknown>>} list
     */
    function renderTable(list) {
        const wrap = byId('crTableWrap');
        const tableEl = byId('crTable');
        if (!wrap || !tableEl) return;

        destroyDataTable();

        const body = byId('crTableBody');
        if (!body) return;

        const batch = ensureBatchActions();
        body.innerHTML = list
            .map((item) => {
                const isSel = selected && String(selected.id) === String(item.id);
                const imgUrl = resolveItemSpriteUrl(item);
                const lvl = itemLevel(item);
                const hp = item.hp != null ? Number(item.hp) : null;
                const threatDps = item.threatDps != null ? Number(item.threatDps) : null;
                const avgHit = item.avgHit != null ? Number(item.avgHit) : null;
                const maxHit = item.maxHit != null ? Number(item.maxHit) : null;
                const exp = item.exp != null ? Number(item.exp) : null;
                const race = item.race != null ? String(item.race) : '';
                const bClass = itemBestiaryClassLabel(item);
                const thumb = imgUrl
                    ? `<span class="cr-table-thumb"><img src="${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\\'missing\\'>—</span>'"></span>`
                    : `<span class="cr-table-thumb"><span class="missing">—</span></span>`;
                const checkTd =
                    uiMode === 'view' && batch
                        ? `<td class="cr-table-check">${batch.checkboxHtml(item.id)}</td>`
                        : '<td class="cr-table-check"></td>';

                return `<tr class="${isSel ? 'is-selected' : ''}" data-id="${escapeHtml(item.id)}">
                    ${checkTd}
                    <td>${thumb}</td>
                    <td class="cr-table-name">${escapeHtml(item.label || item.id)}</td>
                    <td class="cr-table-id">${escapeHtml(item.id)}</td>
                    <td>${race ? escapeHtml(race) : '<span class="text-muted">—</span>'}</td>
                    <td>${bClass ? escapeHtml(bClass) : '<span class="text-muted">—</span>'}</td>
                    <td class="cr-num" data-order="${lvl != null ? lvl : -1}">${lvl != null ? lvl : '—'}</td>
                    <td class="cr-num" data-order="${hp != null && !isNaN(hp) ? hp : -1}">${hp != null && !isNaN(hp) ? formatNum(hp) : '—'}</td>
                    <td class="cr-num" data-order="${threatDps != null && !isNaN(threatDps) ? threatDps : -1}">${threatDps != null && !isNaN(threatDps) ? formatNum(threatDps) : '—'}</td>
                    <td class="cr-num" data-order="${avgHit != null && !isNaN(avgHit) ? avgHit : -1}">${avgHit != null && !isNaN(avgHit) ? formatNum(avgHit) : '—'}</td>
                    <td class="cr-num" data-order="${maxHit != null && !isNaN(maxHit) ? maxHit : -1}">${maxHit != null && !isNaN(maxHit) ? formatNum(maxHit) : '—'}</td>
                    <td class="cr-num" data-order="${exp != null && !isNaN(exp) ? exp : -1}">${exp != null && !isNaN(exp) ? formatNum(exp) : '—'}</td>
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
                // Lvl, HP, Threat, Avg Hit, Max Hit, Exp
                { type: 'num', targets: [6, 7, 8, 9, 10, 11] }
            ],
            language: {
                search: 'Search table:',
                lengthMenu: 'Show _MENU_',
                info: '_START_–_END_ of _TOTAL_',
                infoEmpty: '0 creatures',
                zeroRecords: 'No creatures match this filter.'
            },
            drawCallback: function () {
                // Re-apply selection highlight after page/sort redraw.
                if (!selected) return;
                const id = String(selected.id);
                const rows = tableEl.querySelectorAll('tbody tr[data-id]');
                rows.forEach((tr) => {
                    tr.classList.toggle(
                        'is-selected',
                        tr.getAttribute('data-id') === id
                    );
                });
            }
        });

        // Keep tableOrder in sync when user clicks column headers.
        dataTable.on('order', function () {
            captureTableOrder();
        });

        if (!tableBound) {
            tableBound = true;
            // Delegate: DataTables rewrites tbody. Do NOT call full render() —
            // that would destroy/recreate the table and reset column sort.
            jQuery(tableEl).on('click', 'tbody tr[data-id]', function (ev) {
                // Avoid any header/sort side-effects from nested controls.
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
                if (id) selectCreature(id);
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
                selectCreature(id).then(() => {
                    if (isSelectMode()) confirmSelection();
                });
            });
        }
    }

    /**
     * @param {Array<Record<string, unknown>>} list
     */
    function renderGrid(list) {
        const grid = byId('crGrid');
        if (!grid) return;

        grid.innerHTML = list
            .map((item) => {
                const isSel = selected && String(selected.id) === String(item.id);
                const imgUrl = resolveItemSpriteUrl(item);

                const lvl = itemLevel(item);
                const hp = item.hp != null ? Number(item.hp) : null;
                const exp = item.exp != null ? Number(item.exp) : null;
                const threatDps = item.threatDps != null ? Number(item.threatDps) : null;
                const avgHit = item.avgHit != null ? Number(item.avgHit) : null;
                const race = item.race != null ? String(item.race) : '';
                const bClass = itemBestiaryClassLabel(item);

                const badges = [];
                if (lvl != null) {
                    badges.push(`<span class="cr-badge cr-badge-lvl">Lvl ${lvl}</span>`);
                }
                if (race) {
                    badges.push(
                        `<span class="cr-badge cr-badge-race">${escapeHtml(race)}</span>`
                    );
                }
                if (bClass) {
                    badges.push(
                        `<span class="cr-badge cr-badge-bestiary" title="Bestiary class">${escapeHtml(bClass)}</span>`
                    );
                }
                if (hp != null && !isNaN(hp) && hp > 0) {
                    badges.push(
                        `<span class="cr-badge cr-badge-hp">HP ${formatNum(hp)}</span>`
                    );
                }
                if (threatDps != null && !isNaN(threatDps) && threatDps > 0) {
                    badges.push(
                        `<span class="cr-badge cr-badge-threat" title="Sustained kit threat DPS">DPS ${formatNum(threatDps)}</span>`
                    );
                }
                if (avgHit != null && !isNaN(avgHit) && avgHit > 0) {
                    badges.push(
                        `<span class="cr-badge cr-badge-avghit" title="Rate-weighted mean hit">Hit ${formatNum(avgHit)}</span>`
                    );
                }
                if (exp != null && !isNaN(exp) && exp > 0) {
                    badges.push(
                        `<span class="cr-badge cr-badge-exp">Exp ${formatNum(exp)}</span>`
                    );
                }

                const batch = ensureBatchActions();
                const checkHtml =
                    uiMode === 'view' && batch ? batch.checkboxHtml(item.id) : '';

                return `
                    <div class="cr-card ${isSel ? 'is-selected' : ''}" data-id="${escapeHtml(item.id)}">
                        ${checkHtml}
                        <div class="cr-thumb">
                            ${imgUrl ? `<img src="${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='<span class=\\'missing\\'>no img</span>'">` : '<span class="missing">no img</span>'}
                        </div>
                        <div class="cr-name" title="${escapeHtml(item.label || item.id)}">${escapeHtml(item.label || item.id)}</div>
                        <div class="cr-id" title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</div>
                        ${badges.length > 0 ? `<div class="cr-stats">${badges.join('')}</div>` : ''}
                    </div>
                `;
            })
            .join('');

        grid.querySelectorAll('.cr-card').forEach((card) => {
            const id = card.getAttribute('data-id');
            card.addEventListener('click', (ev) => {
                if (ev.target && ev.target.closest && ev.target.closest('.de-batch-check-wrap')) {
                    return;
                }
                selectCreature(id);
            });
            card.addEventListener('dblclick', (ev) => {
                if (ev.target && ev.target.closest && ev.target.closest('.de-batch-check-wrap')) {
                    return;
                }
                selectCreature(id).then(() => {
                    if (isSelectMode()) confirmSelection();
                });
            });
        });
    }

    function renderSidebar() {
        const empty = byId('crSidebarEmpty');
        const content = byId('crSidebarContent');
        if (!empty || !content) return;

        if (!selected) {
            empty.hidden = false;
            content.hidden = true;
            content.innerHTML = '';
            return;
        }

        empty.hidden = true;
        content.hidden = false;

        const detail = selectedDetail || selected;
        // Prefer full entity fields (customSprite / customSpriteGenre) over list summary.
        const imgUrl = resolveItemSpriteUrl(
            Object.assign({}, selected || {}, detail || {})
        );

        const lvl = detail.level != null ? Number(detail.level) : null;
        const hp = detail.hp != null ? Number(detail.hp) : null;
        const threatDps = detail.threatDps != null ? Number(detail.threatDps) : null;
        const burstDps = detail.burstDps != null ? Number(detail.burstDps) : null;
        const avgHit = detail.avgHit != null ? Number(detail.avgHit) : null;
        const maxHit = detail.maxHit != null ? Number(detail.maxHit) : null;
        const arm = detail.armor != null ? Number(detail.armor) : null;
        const spd = detail.speed != null ? Number(detail.speed) : null;
        const exp = detail.exp != null ? Number(detail.exp) : null;
        const race = detail.race != null ? String(detail.race) : '';
        const notes = detail.notes != null ? String(detail.notes) : '';

        let html = `
            <div class="cr-detail-header">
                <div class="cr-detail-thumb">
                    ${imgUrl ? `<img src="${escapeHtml(imgUrl)}" alt="" onerror="this.parentElement.innerHTML='<span class=\\'missing\\'>no img</span>'">` : '<span class="missing">no img</span>'}
                </div>
                <h2 class="cr-detail-title">${escapeHtml(detail.label || selected.id)}</h2>
                <div class="cr-detail-id">${escapeHtml(selected.id)}</div>
            </div>
            <div class="cr-detail-section">
                <div class="cr-detail-section-title"><i class="fa-solid fa-chart-simple"></i> Combat</div>
                <div class="cr-stat-list">
                    ${lvl != null && !isNaN(lvl) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-shield-cat text-warning"></i> Level</div>
                        <div class="cr-stat-val cr-val-lvl">${formatNum(lvl)}</div>
                    </div>` : ''}
                    ${hp != null && !isNaN(hp) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-heart text-danger"></i> HP</div>
                        <div class="cr-stat-val cr-val-hp">${formatNum(hp)}</div>
                    </div>` : ''}
                    ${threatDps != null && !isNaN(threatDps) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-burst text-warning"></i> Threat DPS</div>
                        <div class="cr-stat-val cr-val-threat">${formatNum(threatDps)}</div>
                    </div>` : ''}
                    ${burstDps != null && !isNaN(burstDps) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-bolt-lightning text-warning"></i> Burst DPS</div>
                        <div class="cr-stat-val cr-val-burst">${formatNum(burstDps)}</div>
                    </div>` : ''}
                    ${avgHit != null && !isNaN(avgHit) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-hand-fist text-warning"></i> Avg Hit</div>
                        <div class="cr-stat-val cr-val-avghit">${formatNum(avgHit)}</div>
                    </div>` : ''}
                    ${maxHit != null && !isNaN(maxHit) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-crosshairs text-danger"></i> Max Hit</div>
                        <div class="cr-stat-val cr-val-maxhit">${formatNum(maxHit)}</div>
                    </div>` : ''}
                    ${arm != null && !isNaN(arm) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-shield-halved text-success"></i> Armor</div>
                        <div class="cr-stat-val cr-val-arm">${formatNum(arm)}</div>
                    </div>` : ''}
                    ${spd != null && !isNaN(spd) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-bolt text-info"></i> Speed</div>
                        <div class="cr-stat-val cr-val-spd">${formatNum(spd)}</div>
                    </div>` : ''}
                    ${exp != null && !isNaN(exp) ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-star text-info"></i> Experience</div>
                        <div class="cr-stat-val cr-val-exp">${formatNum(exp)}</div>
                    </div>` : ''}
                    ${race ? `
                    <div class="cr-stat-row">
                        <div class="cr-stat-label"><i class="fa-solid fa-paw text-success"></i> Race</div>
                        <div class="cr-stat-val cr-val-race">${escapeHtml(race)}</div>
                    </div>` : ''}
                </div>
            </div>
        `;

        const resists = detail.resists && typeof detail.resists === 'object' ? detail.resists : null;
        if (resists) {
            const pills = Object.keys(resists)
                .filter((k) => Number(resists[k]) !== 0)
                .map((k) => {
                    const v = Number(resists[k]);
                    const sign = v > 0 ? '+' : '';
                    return `<span class="cr-pill">${escapeHtml(k)}: ${sign}${v}%</span>`;
                });
            if (pills.length) {
                html += `
                    <div class="cr-detail-section">
                        <div class="cr-detail-section-title"><i class="fa-solid fa-shield"></i> Resistances</div>
                        <div class="cr-pills-wrap">${pills.join('')}</div>
                    </div>
                `;
            }
        }

        const bestiary = detail.bestiary && typeof detail.bestiary === 'object' ? detail.bestiary : null;
        if (bestiary && bestiary.class) {
            html += `
                <div class="cr-detail-section">
                    <div class="cr-detail-section-title"><i class="fa-solid fa-book"></i> Bestiary</div>
                    <div class="cr-stat-list">
                        <div class="cr-stat-row">
                            <div class="cr-stat-label">Class</div>
                            <div class="cr-stat-val">${escapeHtml(String(bestiary.class))}</div>
                        </div>
                    </div>
                </div>
            `;
        }

        const artSprite = trimStr(detail.customSprite || detail.spriteId);
        const artGenre = trimStr(
            detail.customSpriteGenre || detail.customGenre || detail.spriteGenre
        );
        if (artSprite || artGenre) {
            html += `
                <div class="cr-detail-section">
                    <div class="cr-detail-section-title"><i class="fa-solid fa-image"></i> Art</div>
                    <div class="cr-stat-list">
                        ${artSprite ? `
                        <div class="cr-stat-row">
                            <div class="cr-stat-label">Custom Sprite</div>
                            <div class="cr-stat-val font-monospace small">${escapeHtml(artSprite)}</div>
                        </div>` : ''}
                        ${artGenre ? `
                        <div class="cr-stat-row">
                            <div class="cr-stat-label">Sprite Genre</div>
                            <div class="cr-stat-val font-monospace small">${escapeHtml(artGenre)}</div>
                        </div>` : ''}
                    </div>
                </div>
            `;
        }

        if (notes) {
            html += `
                <div class="cr-detail-section">
                    <div class="cr-detail-section-title"><i class="fa-solid fa-note-sticky"></i> Notes</div>
                    <div class="cr-notes">${escapeHtml(notes)}</div>
                </div>
            `;
        }

        if (!selectedDetail && selected) {
            html += `<div class="cr-notes text-muted"><i class="fa-solid fa-spinner fa-spin"></i> Loading full template…</div>`;
        }

        content.innerHTML = html;
    }

    function updateSelectionChrome() {
        const selEl = byId('crSelection');
        const selectBtn = byId('crSelect');
        if (selEl) {
            if (uiMode === 'view') {
                selEl.textContent = selected
                    ? `${selected.label || selected.id} (${selected.id})`
                    : 'Select a creature to view details';
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

    function render() {
        const empty = byId('crEmpty');
        const meta = byId('crMeta');
        const grid = byId('crGrid');
        if (!grid) return;

        const filtered = filteredItems();
        const list =
            layoutMode === LAYOUTS.table ? filtered : sortItems(filtered);

        if (meta) {
            const total = allItems.length;
            const shown = list.length;
            if (listLoading && total === 0) {
                meta.textContent = 'Loading…';
            } else if (shown === total) {
                meta.textContent = `${shown} creatures`;
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
                empty.textContent = listLoading
                    ? 'Loading creatures…'
                    : 'No creatures match this filter.';
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

    /**
     * @param {string|null} id
     * @returns {Promise<void>}
     */
    async function selectCreature(id) {
        if (!id) {
            selected = null;
            selectedDetail = null;
            // Selection-only update: keep DataTables sort / page intact.
            refreshSelectionUi();
            return;
        }
        selected =
            allItems.find((t) => String(t.id) === String(id)) || {
                id,
                label: id
            };
        selectedDetail = null;
        refreshSelectionUi();

        try {
            const mode = (init && init.mode) || 'standard';
            const doc = await apiCall('presets_get', {
                mode,
                kind: 'creatures',
                id: String(id)
            });
            const full =
                doc && doc.entity && typeof doc.entity === 'object'
                    ? doc.entity
                    : selected;
            if (selected && String(selected.id) === String(id)) {
                selectedDetail = full;
                const bClass =
                    full.bestiary &&
                    typeof full.bestiary === 'object' &&
                    full.bestiary.class != null
                        ? String(full.bestiary.class).trim()
                        : selected.bestiaryClass;
                selected = Object.assign({}, selected, {
                    label: full.label || selected.label,
                    level: full.level != null ? full.level : selected.level,
                    hp: full.hp != null ? full.hp : selected.hp,
                    exp: full.exp != null ? full.exp : selected.exp,
                    threatDps:
                        full.threatDps != null ? full.threatDps : selected.threatDps,
                    burstDps:
                        full.burstDps != null ? full.burstDps : selected.burstDps,
                    avgHit: full.avgHit != null ? full.avgHit : selected.avgHit,
                    maxHit: full.maxHit != null ? full.maxHit : selected.maxHit,
                    race: full.race != null ? full.race : selected.race,
                    bestiaryClass:
                        bClass != null && String(bClass).trim() !== ''
                            ? String(bClass).trim()
                            : selected.bestiaryClass
                });
                const idx = allItems.findIndex((t) => String(t.id) === String(id));
                if (idx >= 0) {
                    allItems[idx] = Object.assign({}, allItems[idx], selected);
                }
                refreshSelectionUi();
            }
        } catch (err) {
            console.warn('creature detail load failed', err);
            if (selected && String(selected.id) === String(id)) {
                selectedDetail = selected;
                refreshSelectionUi();
            }
        }
    }

    function confirmSelection() {
        if (!selected || !isSelectMode()) return;
        const detail = selectedDetail || selected;
        post({
            type: 'select',
            requestId: init && init.requestId,
            fieldPath: init && init.fieldPath,
            value: {
                id: String(selected.id),
                label: String(detail.label || selected.label || selected.id),
                level: detail.level != null ? Number(detail.level) : undefined,
                hp: detail.hp != null ? Number(detail.hp) : undefined,
                race: detail.race != null ? String(detail.race) : undefined
            }
        });
        try {
            window.close();
        } catch (_) {
            /* ignore */
        }
    }

    async function loadItems() {
        if (listLoading) return;
        listLoading = true;
        allItems = [];
        render();

        try {
            const mode = (init && init.mode) || 'standard';
            // limit=0 → all (PresetCrud). Full summaries so race/level filters work.
            const data = await apiCall('presets_list', {
                mode,
                kind: 'creatures',
                limit: 0
            });
            allItems = Array.isArray(data.items) ? data.items.slice() : [];
            rebuildRaceOptions();
            rebuildBestiaryClassOptions();

            // One list paint; selection only updates highlight (keeps DT sort).
            render();
            const currentId = init && init.currentId ? String(init.currentId) : '';
            if (currentId) {
                await selectCreature(currentId);
            }
        } catch (err) {
            const empty = byId('crEmpty');
            if (empty) {
                empty.hidden = false;
                empty.classList.add('is-error');
                empty.textContent =
                    'Failed to load creatures: ' + (err.message || err);
            }
        } finally {
            listLoading = false;
            const meta = byId('crMeta');
            if (meta && allItems.length) {
                const shown = filteredItems().length;
                const total = allItems.length;
                meta.textContent =
                    shown === total
                        ? `${shown} creatures`
                        : `${shown} shown · ${total} total`;
            }
        }
    }

    function scheduleFilterRender() {
        if (filterDebounce) clearTimeout(filterDebounce);
        filterDebounce = setTimeout(() => {
            filterDebounce = null;
            render();
        }, 120);
    }

    function parseOptionalInt(raw) {
        const s = String(raw == null ? '' : raw).trim();
        if (s === '') return null;
        const n = parseInt(s, 10);
        return isNaN(n) ? null : n;
    }

    function applyInit(payload) {
        init = payload || {};
        const q = parseQuery();
        init.mode = init.mode || q.mode;
        init.genre = init.genre || q.genre;
        init.currentId = init.currentId || q.currentId;
        init.fieldPath = init.fieldPath || q.fieldPath;
        init.title = init.title || q.title;
        init.uiMode = init.uiMode || q.uiMode;

        applyUiMode(init.uiMode);
        applyLayout(getPreferredLayout(LAYOUTS.grid), { persist: false });

        if (init.title) {
            const titleEl = byId('crTitle');
            if (titleEl) titleEl.textContent = init.title;
        } else if (uiMode === 'view') {
            const titleEl = byId('crTitle');
            if (titleEl) titleEl.textContent = 'Creatures';
        }

        loadItems();
    }

    function bindEvents() {
        const filterInput = byId('crFilter');
        if (filterInput) {
            filterInput.addEventListener('input', () => {
                filter = filterInput.value.trim();
                scheduleFilterRender();
            });
        }

        const raceEl = byId('crRace');
        if (raceEl) {
            raceEl.addEventListener('change', () => {
                raceFilter = String(raceEl.value || '').trim().toLowerCase();
                render();
            });
        }

        const bestiaryEl = byId('crBestiaryClass');
        if (bestiaryEl) {
            bestiaryEl.addEventListener('change', () => {
                bestiaryClassFilter = String(bestiaryEl.value || '')
                    .trim()
                    .toLowerCase();
                render();
            });
        }

        const levelMinEl = byId('crLevelMin');
        if (levelMinEl) {
            levelMinEl.addEventListener('input', () => {
                levelMin = parseOptionalInt(levelMinEl.value);
                scheduleFilterRender();
            });
            levelMinEl.addEventListener('change', () => {
                levelMin = parseOptionalInt(levelMinEl.value);
                render();
            });
        }

        const levelMaxEl = byId('crLevelMax');
        if (levelMaxEl) {
            levelMaxEl.addEventListener('input', () => {
                levelMax = parseOptionalInt(levelMaxEl.value);
                scheduleFilterRender();
            });
            levelMaxEl.addEventListener('change', () => {
                levelMax = parseOptionalInt(levelMaxEl.value);
                render();
            });
        }

        const sortEl = byId('crSort');
        if (sortEl) {
            sortEl.addEventListener('change', () => {
                sortBy = sortEl.value;
                if (layoutMode === LAYOUTS.grid) render();
            });
        }

        const gridBtn = byId('crLayoutGrid');
        if (gridBtn) {
            gridBtn.addEventListener('click', () => {
                if (layoutMode === LAYOUTS.grid) return;
                applyLayout(LAYOUTS.grid);
                render();
            });
        }

        const tableBtn = byId('crLayoutTable');
        if (tableBtn) {
            tableBtn.addEventListener('click', () => {
                if (layoutMode === LAYOUTS.table) return;
                applyLayout(LAYOUTS.table);
                render();
            });
        }

        const cancelBtn = byId('crCancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (!isSelectMode()) return;
                post({ type: 'cancel', requestId: init && init.requestId });
                window.close();
            });
        }

        const selectBtn = byId('crSelect');
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
        applyLayout(getPreferredLayout(LAYOUTS.grid), { persist: false });
        applyInit(parseQuery());
        if (isSelectMode() && window.opener && !window.opener.closed) {
            post({ type: 'ready', kind: 'creature' });
        }
    });
})();
