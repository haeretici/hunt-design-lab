/**
 * Creature spritesheet Batch Builder (browser UI).
 * Composes a batch plan via kernel buildBatch and exports CLI flags / previews.
 * Can queue generate_sprite via the PHP job API and poll status by AJAX.
 */

'use strict';

const {
    GENRES,
    DEFAULT_GENRE,
    DEFAULT_KIND,
    ASSET_KINDS,
    subjectLineFor,
    categoryLabel
} = require('../settings.js');
const {
    buildBatch,
    batchToConfigJson,
    formatGenerateCommand,
    DEFAULT_GRID,
    DEFAULT_MODEL,
    IMAGE_MODELS,
    listGenreIds,
    listKindIds
} = require('../core/lib/batch_builder.js');
const { parseDoneList } = require('../core/lib/creature_names.js');
const {
    getUiPreferences,
    createDebouncedPrefsSaver
} = require('../core/lib/ui_preferences.js');

/** IndexedDB scope key for Batch Builder form defaults. */
const PREFS_KEY = 'batchBuilder';

/**
 * localStorage key written by Sprite Manager when injecting multi-selected sprites.
 * Must match asset-manager.js `BATCH_INJECT_STORAGE_KEY`.
 */
const BATCH_INJECT_STORAGE_KEY = 'hdl_sprite_batch_inject_v1';

/** Ignore inject payloads older than this (ms). */
const BATCH_INJECT_MAX_AGE_MS = 5 * 60 * 1000;

const POLL_MS = 2000;

const { appUrl } = require('../core/lib/app_paths.js');

/**
 * Job API base URL (php/api.php).
 */
function apiUrl() {
    if (typeof window !== 'undefined' && window.__API_URL__) {
        return String(window.__API_URL__);
    }
    return appUrl('php/api.php');
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @param {{ method?: string }} [opts]
 */
async function apiCall(action, params = {}, opts = {}) {
    const method = (opts.method || (action === 'run' ? 'POST' : 'GET')).toUpperCase();
    const url = new URL(apiUrl(), window.location.href);
    url.searchParams.set('action', action);

    /** @type {RequestInit} */
    const init = { method, headers: {}, cache: 'no-store' };

    if (method === 'GET' || method === 'HEAD') {
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null) continue;
            url.searchParams.set(k, String(v));
        }
    } else {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify({ action, ...params });
    }

    const res = await fetch(url.href, init);
    let data;
    try {
        data = await res.json();
    } catch (_) {
        throw new Error(`API ${action}: invalid JSON (HTTP ${res.status})`);
    }
    if (!res.ok || data.ok === false) {
        throw new Error((data && data.error) || `API ${action} failed (HTTP ${res.status})`);
    }
    return data;
}

/**
 * @param {string} genreId
 * @param {string} [kindId]
 * @returns {Promise<Set<string>>}
 */
async function fetchDoneSet(genreId, kindId = DEFAULT_KIND) {
    const kind = ASSET_KINDS[kindId] || ASSET_KINDS[DEFAULT_KIND];
    const url = appUrl(`assets/data/${genreId}/${kind.doneFileName}`);
    try {
        const res = await fetch(url);
        if (!res.ok) return new Set();
        return parseDoneList(await res.text());
    } catch (_) {
        return new Set();
    }
}

/**
 * @param {HTMLElement|null} el
 * @param {string} text
 */
function setText(el, text) {
    if (el) el.textContent = text;
}

/**
 * @param {string} text
 * @param {string} label
 */
async function copyText(text, label) {
    try {
        await navigator.clipboard.writeText(text);
        return `${label} copied`;
    } catch (_) {
        return `Could not copy ${label}`;
    }
}

/**
 * Flash status bar message.
 * @param {string} msg
 */
function status(msg) {
    const el = document.getElementById('statusMsg');
    if (el) el.textContent = msg;
}

/**
 * Minimal flags object for formatGenerateCommand (CLI does not need a full roster).
 * @param {ReturnType<typeof readForm>} form
 */
function cliFlagsFromForm(form) {
    return {
        genreId: form.genre,
        kindId: form.kind,
        category: form.category,
        seed: form.seed,
        rows: form.rows,
        cols: form.cols,
        model: form.model,
        opaqueAlpha: form.opaqueAlpha
    };
}

/**
 * Ready-to-paste one-shot from project root (flags only).
 * @param {{ genreId: string, kindId?: string, category?: string|null, seed: number|null, rows: number, cols: number, model: string }} flags
 * @param {number} iterations
 * @param {{ dryRun?: boolean }} [opts]
 */
function formatCli(flags, iterations, opts = {}) {
    return [
        '# From project root — full pipeline per iteration:',
        '# image gen (agy or grok) → split → process_sprites → catalog JSON',
        '# Same seed + growing done-list → unique sheets. Append --dry-run to preview.',
        '# Or use Run batch in the web UI (php/api.php).',
        formatGenerateCommand(flags, { iterations, dryRun: !!opts.dryRun })
    ].join('\n');
}

/**
 * Copyable payload: the full pipeline command only (no comments).
 * @param {{ genreId: string, kindId?: string, category?: string|null, seed: number|null, rows: number, cols: number, model: string }} flags
 * @param {number} iterations
 * @param {{ dryRun?: boolean }} [opts]
 */
function formatCliCopy(flags, iterations, opts = {}) {
    return formatGenerateCommand(flags, { iterations, dryRun: !!opts.dryRun });
}

/**
 * Read and clear a Sprite Manager inject payload from localStorage.
 * @returns {{ genre?: string, kind?: string, items: Array<{technical: string, alias: string, category?: string}> }|null}
 */
function consumeBatchInjectPayload() {
    if (typeof localStorage === 'undefined') return null;
    let raw;
    try {
        raw = localStorage.getItem(BATCH_INJECT_STORAGE_KEY);
    } catch (_) {
        return null;
    }
    if (!raw) return null;
    try {
        localStorage.removeItem(BATCH_INJECT_STORAGE_KEY);
    } catch (_) {
        /* ignore */
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (_) {
        return null;
    }
    if (!data || typeof data !== 'object') return null;
    if (typeof data.ts === 'number' && Date.now() - data.ts > BATCH_INJECT_MAX_AGE_MS) {
        return null;
    }
    const itemsIn = Array.isArray(data.items) ? data.items : [];
    /** @type {Array<{technical: string, alias: string, category?: string}>} */
    const items = [];
    for (const row of itemsIn) {
        if (!row || typeof row !== 'object') continue;
        const technical = String(row.technical || '').trim();
        if (!technical) continue;
        /** @type {{technical: string, alias: string, category?: string}} */
        const item = {
            technical,
            alias: String(row.alias || technical).trim() || technical
        };
        if (row.category) item.category = String(row.category);
        items.push(item);
    }
    if (!items.length) return null;
    return {
        genre: typeof data.genre === 'string' ? data.genre : undefined,
        kind: typeof data.kind === 'string' ? data.kind : undefined,
        items
    };
}

/**
 * @param {ReturnType<typeof buildBatch>} batch
 */
function renderRoster(batch) {
    const tbody = document.getElementById('rosterBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    batch.creatures.forEach((c, i) => {
        const tr = document.createElement('tr');
        const row = Math.floor(i / batch.cols) + 1;
        const col = (i % batch.cols) + 1;
        tr.innerHTML =
            `<td class="text-muted">${i + 1}</td>` +
            `<td class="text-muted">R${row}C${col}</td>` +
            `<td class="font-monospace">${escapeHtml(c.technical)}</td>` +
            `<td class="font-monospace text-info">${escapeHtml(c.alias)}</td>` +
            `<td class="font-monospace text-muted">${escapeHtml(batch.fileStems[i])}</td>`;
        tbody.appendChild(tr);
    });
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Read form → batch options + iterations + dry-run.
 */
function readForm() {
    const genre = /** @type {HTMLSelectElement} */ (document.getElementById('genre')).value;
    const kindEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('kind'));
    const kind = (kindEl && kindEl.value) || DEFAULT_KIND;
    const catEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('category'));
    const categoryRaw = catEl ? catEl.value.trim() : '';
    const category = categoryRaw || null;
    const rows = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('rows')).value, 10) || DEFAULT_GRID.rows;
    const cols = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('cols')).value, 10) || DEFAULT_GRID.cols;
    const seedRaw = /** @type {HTMLInputElement} */ (document.getElementById('seed')).value.trim();
    const seed = seedRaw === '' ? null : parseInt(seedRaw, 10);
    const iterRaw = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('iterations')).value, 10);
    const iterations = Number.isFinite(iterRaw) && iterRaw >= 1 ? iterRaw : 1;
    const model = /** @type {HTMLSelectElement} */ (document.getElementById('model')).value || DEFAULT_MODEL;
    const dryRunEl = /** @type {HTMLInputElement|null} */ (document.getElementById('dryRun'));
    const dryRun = !!(dryRunEl && dryRunEl.checked);
    const opaqueEl = /** @type {HTMLInputElement|null} */ (document.getElementById('opaqueAlpha'));
    const opaqueAlpha = !!(opaqueEl && opaqueEl.checked);
    return {
        genre,
        kind,
        category,
        rows,
        cols,
        seed: Number.isFinite(seed) ? seed : null,
        iterations,
        model,
        opaqueAlpha,
        dryRun
    };
}

/**
 * @param {string} st
 */
function setJobBadge(st) {
    const badge = document.getElementById('jobStatusBadge');
    if (!badge) return;
    badge.textContent = st;
    badge.setAttribute('data-status', st);
}

async function initBatchBuilderApp() {
    const params =
        typeof window !== 'undefined' && window.location
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
    const isPopup =
        params.get('popup') === '1' ||
        (typeof window !== 'undefined' && !!window.opener);
    if (isPopup && document.body) {
        document.body.classList.add('sprite-batch-popup');
    }

    const genreSelect = /** @type {HTMLSelectElement} */ (document.getElementById('genre'));
    const kindSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('kind'));
    const categorySelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('category'));
    const modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById('model'));
    const countLbl = document.getElementById('gridCount');
    const iterCountLbl = document.getElementById('iterCount');
    const totalCountLbl = document.getElementById('totalCount');
    const doneCountLbl = document.getElementById('doneCount');
    const genreMeta = document.getElementById('genreMeta');
    const runBatchBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('runBatchBtn'));
    const refreshJobBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('refreshJobBtn'));
    const copyJobIdBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('copyJobIdBtn'));

    /** @type {ReturnType<typeof buildBatch>|null} */
    let currentBatch = null;
    /** @type {number} */
    let currentIterations = 1;
    /** @type {Set<string>} */
    let doneSet = new Set();

    /**
     * Fixed roster entries from Sprite Manager multi-select inject.
     * Full list kept; each generate() slices to current grid size (rows×cols).
     * @type {Array<{technical: string, alias: string, category?: string}>|null}
     */
    let injectedItems = null;

    /** @type {string|null} */
    let activeJobId = null;
    /** @type {number} */
    let logOffset = 0;
    /** @type {string} */
    let logBuffer = '';
    /** @type {ReturnType<typeof setInterval>|null} */
    let pollTimer = null;

    // Populate genres
    genreSelect.innerHTML = '';
    for (const id of listGenreIds()) {
        const g = GENRES[id];
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = g.label;
        if (id === DEFAULT_GENRE) opt.selected = true;
        genreSelect.appendChild(opt);
    }

    // Populate asset kinds
    if (kindSelect) {
        kindSelect.innerHTML = '';
        for (const id of listKindIds()) {
            const k = ASSET_KINDS[id];
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = k.label;
            if (id === DEFAULT_KIND) opt.selected = true;
            kindSelect.appendChild(opt);
        }
    }

    /**
     * Rebuild category options for the selected kind.
     * @param {string} kindId
     * @param {string} [preserve]
     */
    function refreshCategoryOptions(kindId, preserve) {
        if (!categorySelect) return;
        const cats = (ASSET_KINDS[kindId] && ASSET_KINDS[kindId].categories) || [];
        const prev = preserve != null ? preserve : categorySelect.value;
        categorySelect.innerHTML = '';
        const any = document.createElement('option');
        any.value = '';
        any.textContent = cats.length ? 'Any / mixed' : '—';
        categorySelect.appendChild(any);
        for (const c of cats) {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = categoryLabel(kindId, c);
            categorySelect.appendChild(opt);
        }
        categorySelect.disabled = cats.length === 0;
        if (prev && cats.includes(prev)) {
            categorySelect.value = prev;
        } else {
            categorySelect.value = '';
        }
    }

    if (kindSelect) {
        refreshCategoryOptions(kindSelect.value || DEFAULT_KIND);
    }

    // Populate image models (agy Gemini + Grok 4.6)
    modelSelect.innerHTML = '';
    for (const name of IMAGE_MODELS) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === DEFAULT_MODEL) opt.selected = true;
        modelSelect.appendChild(opt);
    }

    /**
     * Snapshot of batch form fields persisted to IndexedDB.
     * @returns {Record<string, unknown>}
     */
    function collectPrefs() {
        const form = readForm();
        return {
            genre: form.genre,
            kind: form.kind,
            category: form.category,
            rows: form.rows,
            cols: form.cols,
            seed: form.seed,
            iterations: form.iterations,
            model: form.model,
            opaqueAlpha: form.opaqueAlpha,
            dryRun: form.dryRun
        };
    }

    const schedulePrefsSave = createDebouncedPrefsSaver(PREFS_KEY, collectPrefs);

    /**
     * Apply stored prefs to form controls (invalid values ignored).
     * @param {Record<string, unknown>|null} prefs
     */
    function applyPrefs(prefs) {
        if (!prefs || typeof prefs !== 'object') return;

        if (typeof prefs.genre === 'string' && GENRES[prefs.genre]) {
            genreSelect.value = prefs.genre;
        }
        if (kindSelect && typeof prefs.kind === 'string' && ASSET_KINDS[prefs.kind]) {
            kindSelect.value = prefs.kind;
            refreshCategoryOptions(
                prefs.kind,
                typeof prefs.category === 'string' ? prefs.category : ''
            );
        } else if (typeof prefs.category === 'string' && categorySelect) {
            refreshCategoryOptions(
                (kindSelect && kindSelect.value) || DEFAULT_KIND,
                prefs.category
            );
        }

        const rowsEl = /** @type {HTMLInputElement|null} */ (document.getElementById('rows'));
        const colsEl = /** @type {HTMLInputElement|null} */ (document.getElementById('cols'));
        const seedEl = /** @type {HTMLInputElement|null} */ (document.getElementById('seed'));
        const iterEl = /** @type {HTMLInputElement|null} */ (document.getElementById('iterations'));
        const dryEl = /** @type {HTMLInputElement|null} */ (document.getElementById('dryRun'));
        const opaqueEl = /** @type {HTMLInputElement|null} */ (document.getElementById('opaqueAlpha'));

        if (rowsEl && prefs.rows != null) {
            const n = parseInt(String(prefs.rows), 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) rowsEl.value = String(n);
        }
        if (colsEl && prefs.cols != null) {
            const n = parseInt(String(prefs.cols), 10);
            if (Number.isFinite(n) && n >= 1 && n <= 8) colsEl.value = String(n);
        }
        if (seedEl && prefs.seed != null && prefs.seed !== '') {
            const n = parseInt(String(prefs.seed), 10);
            if (Number.isFinite(n)) seedEl.value = String(n);
        }
        if (iterEl && prefs.iterations != null) {
            const n = parseInt(String(prefs.iterations), 10);
            if (Number.isFinite(n) && n >= 1 && n <= 64) iterEl.value = String(n);
        }
        if (typeof prefs.model === 'string' && IMAGE_MODELS.includes(prefs.model)) {
            modelSelect.value = prefs.model;
        }
        if (dryEl && typeof prefs.dryRun === 'boolean') {
            dryEl.checked = prefs.dryRun;
        }
        if (opaqueEl && typeof prefs.opaqueAlpha === 'boolean') {
            opaqueEl.checked = prefs.opaqueAlpha;
        }
    }

    /**
     * Default opaque-alpha checkbox from asset kind (tiles → on).
     * Only when the user has not set a preference this session via prefs load.
     * @param {string} kindId
     */
    function applyKindOpaqueDefault(kindId) {
        const opaqueEl = /** @type {HTMLInputElement|null} */ (document.getElementById('opaqueAlpha'));
        if (!opaqueEl) return;
        const k = ASSET_KINDS[kindId];
        const overlay = kindId === 'overlays';
        // Full-bleed terrain benefits from opaque alpha; overlays MUST keep alpha.
        opaqueEl.checked = !overlay && !!(k && k.compose === 'tile');
        opaqueEl.disabled = overlay;
        if (overlay) {
            const rowsEl = /** @type {HTMLInputElement|null} */ (document.getElementById('rows'));
            const colsEl = /** @type {HTMLInputElement|null} */ (document.getElementById('cols'));
            if (rowsEl) rowsEl.value = '4';
            if (colsEl) colsEl.value = '4';
            updateCounts();
        }
    }

    function updateCounts() {
        const rows = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('rows')).value, 10) || 0;
        const cols = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('cols')).value, 10) || 0;
        const iterRaw = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('iterations')).value, 10);
        const iterations = Number.isFinite(iterRaw) && iterRaw >= 1 ? iterRaw : 1;
        const grid = rows * cols;
        setText(countLbl, String(grid));
        setText(iterCountLbl, String(iterations));
        setText(totalCountLbl, String(grid * iterations));
    }

    function updateGenreMeta() {
        const id = genreSelect.value;
        const kindId = (kindSelect && kindSelect.value) || DEFAULT_KIND;
        const g = GENRES[id];
        const k = ASSET_KINDS[kindId];
        if (!g || !genreMeta) return;
        const subject = subjectLineFor(id, kindId);
        genreMeta.innerHTML =
            `<div><span class="text-muted">Kind:</span> ${escapeHtml(k ? k.label : kindId)}</div>` +
            `<div><span class="text-muted">Subject:</span> ${escapeHtml(subject)}</div>` +
            `<div><span class="text-muted">Perspective:</span> ${escapeHtml(g.perspective)}</div>` +
            `<div><span class="text-muted">Style:</span> ${escapeHtml(g.styleExtra)}</div>` +
            `<div class="mt-1"><span class="text-muted">Sprites:</span> ` +
            `<code>assets/sprites/${escapeHtml(id)}/${escapeHtml(k ? k.folder : kindId)}/</code></div>`;
    }

    async function refreshDoneCount() {
        const kindId = (kindSelect && kindSelect.value) || DEFAULT_KIND;
        doneSet = await fetchDoneSet(genreSelect.value, kindId);
        setText(doneCountLbl, String(doneSet.size));
    }

    /**
     * Keep the CLI box in sync with live form values (flags only; no roster rebuild).
     */
    function refreshCliCommand() {
        const form = readForm();
        currentIterations = form.iterations;
        setText(
            document.getElementById('cliCommand'),
            formatCli(cliFlagsFromForm(form), form.iterations, { dryRun: form.dryRun })
        );
    }

    /**
     * @param {ReturnType<typeof buildBatch>} batch
     * @param {number} iterations
     * @param {{ dryRun?: boolean }} [opts]
     */
    function paintBatch(batch, iterations, opts = {}) {
        currentBatch = batch;
        currentIterations = iterations;
        const cfg = batchToConfigJson(batch);
        setText(document.getElementById('jsonPreview'), JSON.stringify(cfg, null, 2));
        setText(document.getElementById('promptPreview'), batch.prompt);
        setText(
            document.getElementById('cliCommand'),
            formatCli(
                {
                    genreId: batch.genreId,
                    kindId: batch.kindId,
                    category: batch.category,
                    seed: batch.seed,
                    rows: batch.rows,
                    cols: batch.cols,
                    model: batch.model,
                    opaqueAlpha: batch.opaqueAlpha
                },
                iterations,
                { dryRun: !!opts.dryRun }
            )
        );
        renderRoster(batch);
        const total = batch.count * iterations;
        status(
            `Preview iter 1 — ${batch.count} ${batch.kindId || 'items'}` +
                (iterations > 1 ? ` × ${iterations} iters (= ${total})` : '') +
                ` · ${batch.genre.label}` +
                (batch.seed != null ? ` · seed ${batch.seed}` : ' · random seed')
        );
    }

    /**
     * Compact grid that fits n fixed roster entries (≤4×4) with minimal empty/auto-fill.
     * @param {number} n
     * @returns {{ rows: number, cols: number }}
     */
    function gridForInjectCount(n) {
        const k = Math.max(1, Math.min(16, Math.floor(n) || 1));
        if (k <= 1) return { rows: 1, cols: 1 };
        if (k <= 2) return { rows: 1, cols: 2 };
        if (k <= 4) return { rows: 2, cols: 2 };
        if (k <= 6) return { rows: 2, cols: 3 };
        if (k <= 9) return { rows: 3, cols: 3 };
        if (k <= 12) return { rows: 3, cols: 4 };
        return { rows: 4, cols: 4 };
    }

    /**
     * Injected entries that fit the current grid (same slice used by generate + run).
     * @returns {Array<{technical: string, alias: string, category?: string}>}
     */
    function injectedItemsForGrid() {
        if (!injectedItems || !injectedItems.length) return [];
        const form = readForm();
        const count = form.rows * form.cols;
        return injectedItems.slice(0, count);
    }

    function paintNoInjectUi() {
        const chip = document.getElementById('injectChip');
        if (chip) chip.hidden = true;
        if (runBatchBtn) {
            runBatchBtn.innerHTML =
                '<i class="fa-solid fa-play"></i> Run batch';
            runBatchBtn.title =
                'Validate args and run generate_sprite.js in the background';
        }
    }

    /**
     * Clear Sprite Manager inject and rebuild a normal (generated) roster.
     */
    function clearInject() {
        injectedItems = null;
        paintNoInjectUi();
    }

    /**
     * Update the inject status chip + Run button label for update mode.
     * @param {number} used
     * @param {number} available
     * @param {number} grid
     */
    function paintInjectChip(used, available, grid) {
        const chip = document.getElementById('injectChip');
        if (chip) {
            chip.hidden = false;
            const dropped = Math.max(0, available - used);
            chip.textContent =
                `Inject: ${used}/${grid} slot${grid === 1 ? '' : 's'}` +
                (dropped > 0 ? ` · ${dropped} selected dropped` : '') +
                (used < grid ? ` · ${grid - used} auto-fill` : '');
            chip.title =
                'Roster seeded from Sprite Manager selection. ' +
                'Click Run update to regenerate those sprites. ' +
                'Generate roster keeps inject; New seed clears it.';
        }
        if (runBatchBtn) {
            runBatchBtn.innerHTML =
                '<i class="fa-solid fa-play"></i> Run update';
            runBatchBtn.title =
                'Regenerate the injected roster via smart_update_sprites (frozen names)';
        }
    }

    async function generate() {
        const form = readForm();
        updateCounts();
        try {
            await refreshDoneCount();
            const count = form.rows * form.cols;
            /** @type {Array<{technical: string, alias: string, category?: string}>|undefined} */
            let items;
            if (injectedItems && injectedItems.length) {
                items = injectedItems.slice(0, count);
                paintInjectChip(items.length, injectedItems.length, count);
            } else {
                paintNoInjectUi();
            }
            const batch = buildBatch({
                genre: form.genre,
                kind: form.kind,
                category: form.category,
                rows: form.rows,
                cols: form.cols,
                seed: form.seed,
                model: form.model,
                opaqueAlpha: form.opaqueAlpha,
                exclude: [...doneSet],
                items
            });
            paintBatch(batch, form.iterations, { dryRun: form.dryRun });
            if (items && items.length) {
                const dropped = Math.max(0, (injectedItems || []).length - items.length);
                const fill = count - items.length;
                status(
                    `Ready to update ${items.length} sprite${items.length === 1 ? '' : 's'}` +
                        (dropped > 0 ? ` · ${dropped} selection dropped (over grid)` : '') +
                        (fill > 0 ? ` · ${fill} auto-filled` : '') +
                        ` · click Run update · ${batch.genre.label}`
                );
            }
        } catch (e) {
            status(`Error: ${e.message || e}`);
            console.error(e);
        }
    }

    function stopPolling() {
        if (pollTimer != null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    /**
     * @param {Record<string, unknown>} job
     * @param {{ content?: string, offset?: number }} [log]
     */
    function paintJob(job, log) {
        const st = String(job.status || 'unknown');
        setJobBadge(st);

        const metaEl = document.getElementById('jobMeta');
        if (metaEl) {
            const parts = [
                `<div><span class="text-muted">Id:</span> <code>${escapeHtml(String(job.id || ''))}</code></div>`,
                `<div><span class="text-muted">Status:</span> ${escapeHtml(st)}` +
                    (job.exit_code != null ? ` · exit ${escapeHtml(String(job.exit_code))}` : '') +
                    `</div>`,
                job.command
                    ? `<div><span class="text-muted">Cmd:</span> <code>${escapeHtml(String(job.command))}</code></div>`
                    : '',
                job.error
                    ? `<div class="text-danger"><span class="text-muted">Error:</span> ${escapeHtml(String(job.error))}</div>`
                    : '',
                job.created_at
                    ? `<div><span class="text-muted">Created:</span> ${escapeHtml(String(job.created_at))}</div>`
                    : '',
                job.finished_at
                    ? `<div><span class="text-muted">Finished:</span> ${escapeHtml(String(job.finished_at))}</div>`
                    : ''
            ];
            metaEl.innerHTML = parts.filter(Boolean).join('');
        }

        if (log && typeof log.content === 'string' && log.content.length) {
            logBuffer += log.content;
            if (typeof log.offset === 'number') {
                logOffset = log.offset;
            }
        }
        const logEl = document.getElementById('jobLog');
        if (logEl) {
            logEl.textContent = logBuffer || '—';
            logEl.scrollTop = logEl.scrollHeight;
        }

        if (refreshJobBtn) refreshJobBtn.disabled = !activeJobId;
        if (copyJobIdBtn) copyJobIdBtn.disabled = !activeJobId;

        const terminal = st === 'completed' || st === 'failed';
        if (runBatchBtn) {
            runBatchBtn.disabled = st === 'queued' || st === 'running';
        }
        if (terminal) {
            stopPolling();
            if (st === 'completed') {
                status('Job completed');
                refreshDoneCount().catch(() => {});
            } else {
                status(`Job failed${job.exit_code != null ? ` (exit ${job.exit_code})` : ''}`);
            }
        }
    }

    async function pollJobOnce() {
        if (!activeJobId) return;
        try {
            const data = await apiCall('status', { id: activeJobId, offset: logOffset });
            paintJob(data.job || {}, data.log || {});
        } catch (e) {
            status(`Status poll error: ${e.message || e}`);
            console.error(e);
        }
    }

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(() => {
            pollJobOnce().catch(() => {});
        }, POLL_MS);
    }

    async function runBatch() {
        const form = readForm();
        const fixed = injectedItemsForGrid();

        /** @type {Record<string, unknown>} */
        let payload;
        if (fixed.length) {
            // Frozen roster update — same pipeline as Wiki Smart Update Sprites.
            // generate_sprite (flags-only) would ignore the inject and mint new names.
            payload = {
                script: 'smart_update_sprites',
                genre: form.genre,
                kind: form.kind,
                rows: form.rows,
                cols: form.cols,
                model: form.model,
                dry_run: form.dryRun,
                items: fixed.map((c) => ({
                    technical: c.technical,
                    alias: c.alias || c.technical
                }))
            };
            if (form.seed != null) payload.seed = form.seed;
            if (form.category) payload.category = form.category;
        } else {
            payload = {
                script: 'generate_sprite',
                genre: form.genre,
                kind: form.kind,
                rows: form.rows,
                cols: form.cols,
                iterations: form.iterations,
                model: form.model,
                dry_run: form.dryRun,
                opaque_alpha: form.opaqueAlpha
            };
            if (form.seed != null) payload.seed = form.seed;
            if (form.category) payload.category = form.category;
        }

        if (runBatchBtn) runBatchBtn.disabled = true;
        status(
            fixed.length
                ? form.dryRun
                    ? `Queueing dry-run update for ${fixed.length} sprite(s)…`
                    : `Queueing update for ${fixed.length} sprite(s)…`
                : form.dryRun
                  ? 'Queueing dry-run…'
                  : 'Queueing batch…'
        );
        logBuffer = '';
        logOffset = 0;
        setText(document.getElementById('jobLog'), 'Starting…');

        try {
            const data = await apiCall('run', payload, { method: 'POST' });
            const job = data.job || {};
            activeJobId = job.id ? String(job.id) : null;
            paintJob(job, { content: '', offset: 0 });
            status(
                activeJobId
                    ? `Job ${activeJobId.slice(0, 8)}… ${job.status || 'queued'}` +
                          (fixed.length ? ` · updating ${fixed.length} injected` : '')
                    : 'Job queued'
            );
            if (activeJobId) {
                startPolling();
                await pollJobOnce();
            }
        } catch (e) {
            setJobBadge('failed');
            status(`Run failed: ${e.message || e}`);
            if (runBatchBtn) runBatchBtn.disabled = false;
            console.error(e);
        }
    }

    // Events — settings changes update counts / CLI immediately; roster needs Generate
    document.getElementById('rows')?.addEventListener('input', () => {
        updateCounts();
        refreshCliCommand();
        schedulePrefsSave();
    });
    document.getElementById('cols')?.addEventListener('input', () => {
        updateCounts();
        refreshCliCommand();
        schedulePrefsSave();
    });
    document.getElementById('iterations')?.addEventListener('input', () => {
        updateCounts();
        refreshCliCommand();
        schedulePrefsSave();
    });
    document.getElementById('seed')?.addEventListener('input', () => {
        refreshCliCommand();
        schedulePrefsSave();
    });
    document.getElementById('dryRun')?.addEventListener('change', () => {
        refreshCliCommand();
        schedulePrefsSave();
    });
    document.getElementById('opaqueAlpha')?.addEventListener('change', () => {
        refreshCliCommand();
        schedulePrefsSave();
    });
    modelSelect.addEventListener('change', () => {
        refreshCliCommand();
        schedulePrefsSave();
    });
    genreSelect.addEventListener('change', async () => {
        updateGenreMeta();
        refreshCliCommand();
        schedulePrefsSave();
        await refreshDoneCount();
    });
    kindSelect?.addEventListener('change', async () => {
        refreshCategoryOptions(kindSelect.value || DEFAULT_KIND);
        applyKindOpaqueDefault(kindSelect.value || DEFAULT_KIND);
        updateGenreMeta();
        refreshCliCommand();
        schedulePrefsSave();
        await refreshDoneCount();
    });
    categorySelect?.addEventListener('change', () => {
        applyKindOpaqueDefault(kindSelect.value || DEFAULT_KIND);
        refreshCliCommand();
        schedulePrefsSave();
    });

    document.getElementById('generateBtn')?.addEventListener('click', () => {
        // Keep inject if present — rebuild prompt / re-slice to current grid
        generate();
    });

    document.getElementById('reshuffleBtn')?.addEventListener('click', () => {
        // New seed = intentional fresh random roster; drop inject
        clearInject();
        const seedEl = /** @type {HTMLInputElement} */ (document.getElementById('seed'));
        seedEl.value = String(Math.floor(Math.random() * 1e9));
        schedulePrefsSave();
        generate();
    });

    runBatchBtn?.addEventListener('click', () => {
        runBatch();
    });

    refreshJobBtn?.addEventListener('click', () => {
        pollJobOnce().catch((e) => status(`Refresh failed: ${e.message || e}`));
    });

    copyJobIdBtn?.addEventListener('click', async () => {
        if (!activeJobId) return;
        status(await copyText(activeJobId, 'Job id'));
    });

    document.getElementById('copyJsonBtn')?.addEventListener('click', async () => {
        if (!currentBatch) return;
        status(await copyText(JSON.stringify(batchToConfigJson(currentBatch), null, 2), 'JSON'));
    });

    document.getElementById('downloadConfigBtn')?.addEventListener('click', () => {
        if (!currentBatch) return;
        const cfg = batchToConfigJson(currentBatch);
        const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `batch_${cfg.genre}_${cfg.seed != null ? cfg.seed : 'rand'}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        status('Config downloaded');
    });

    document.getElementById('copyCliBtn')?.addEventListener('click', async () => {
        const form = readForm();
        status(
            await copyText(
                formatCliCopy(cliFlagsFromForm(form), form.iterations, { dryRun: form.dryRun }),
                'CLI command'
            )
        );
    });

    document.getElementById('copyPromptBtn')?.addEventListener('click', async () => {
        if (!currentBatch) return;
        status(await copyText(currentBatch.prompt, 'Prompt'));
    });

    // Restore form prefs before first roster generate
    try {
        applyPrefs(await getUiPreferences(PREFS_KEY));
    } catch (err) {
        console.warn('Batch Builder prefs load failed', err);
    }

    // Sprite Manager multi-select → inject fixed roster entries (overrides genre/kind prefs)
    const inject = consumeBatchInjectPayload();
    if (inject) {
        injectedItems = inject.items;
        if (inject.genre && GENRES[inject.genre]) {
            genreSelect.value = inject.genre;
        }
        if (kindSelect && inject.kind && ASSET_KINDS[inject.kind]) {
            kindSelect.value = inject.kind;
            refreshCategoryOptions(inject.kind);
        }
        // Prefer a single iteration when updating a fixed roster
        const iterEl = /** @type {HTMLInputElement|null} */ (document.getElementById('iterations'));
        if (iterEl) iterEl.value = '1';

        // Fit grid to selection (e.g. 1 sprite → 1×1) so Run update does not mint 15 fillers
        const g = gridForInjectCount(inject.items.length);
        const rowsEl = /** @type {HTMLInputElement|null} */ (document.getElementById('rows'));
        const colsEl = /** @type {HTMLInputElement|null} */ (document.getElementById('cols'));
        if (rowsEl) rowsEl.value = String(g.rows);
        if (colsEl) colsEl.value = String(g.cols);
    }

    updateCounts();
    updateGenreMeta();
    setJobBadge('idle');
    await refreshDoneCount();
    await generate();
}

module.exports = { initBatchBuilderApp, appUrl, apiUrl };
