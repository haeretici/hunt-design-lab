/**
 * Sprite Manager (browser UI) — creature catalog browser with remove / rename / flip / replace / free-edit.
 * Entry: sprite-manager.php (Asset Manager → Sprites).
 */

'use strict';

const {
    GENRES,
    DEFAULT_GENRE,
    DEFAULT_KIND,
    ASSET_KINDS,
    listKindIds,
    resolveSpriteEditorUrl
} = require('../settings.js');
const {
    getUiPreferences,
    createDebouncedPrefsSaver
} = require('../core/lib/ui_preferences.js');

/** IndexedDB scope key for this page's UI filters. */
const PREFS_KEY = 'assetManager';

/** Named window for the Sprite Batch Builder popup (reused on re-open). */
const SPRITE_BATCH_WINDOW_NAME = 'hunt_design_lab_sprite_batch';
const SPRITE_BATCH_URL_PATH = 'sprite-batch-builder.php?popup=1';

/**
 * localStorage key for handing multi-selected catalog sprites to Batch Builder.
 * Shared across windows (sessionStorage is not); Batch Builder consumes and clears.
 */
const BATCH_INJECT_STORAGE_KEY = 'hdl_sprite_batch_inject_v1';

const THUMB_SIZES = new Set(['icon', 'small', 'medium', 'alpha', 'original']);
const LIMIT_VALUES = new Set(['48', '96', '192', '0']);

/** Free Edit parent protocol (same origin as sprite-manager/layout_free_edit.html). */
const FREE_EDIT_MSG = Object.freeze({
    READY: 'FREE_EDIT_READY',
    LOAD: 'FREE_EDIT_LOAD',
    SAVE: 'FREE_EDIT_SAVE',
    CANCEL: 'FREE_EDIT_CANCEL'
});

const { appUrl } = require('../core/lib/app_paths.js');

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
    const writeActions = new Set([
        'creature_remove',
        'creature_rename',
        'creature_flip',
        'creature_replace',
        'creature_opaque_alpha',
        'creature_reprocess',
        'creature_fix_green',
        'run'
    ]);
    const method = (
        opts.method || (writeActions.has(action) ? 'POST' : 'GET')
    ).toUpperCase();
    const url = new URL(apiUrl(), window.location.href);
    url.searchParams.set('action', action);

    /** @type {RequestInit} */
    const init = { method, headers: {}, cache: 'no-store' };

    if (method === 'GET' || method === 'HEAD') {
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null || v === '') continue;
            url.searchParams.set(k, String(v));
        }
    } else if (opts.formData instanceof FormData) {
        // Multipart (file replace) — do not set Content-Type; browser adds boundary
        const fd = opts.formData;
        if (!fd.has('action')) fd.append('action', action);
        init.body = fd;
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

function status(msg) {
    const el = document.getElementById('statusMsg');
    if (el) el.textContent = msg;
}

/**
 * Cache-busted asset URL (after flip/rename).
 * @param {string|null|undefined} rel
 * @param {string|number} [bust]
 */
function spriteUrl(rel, bust) {
    if (!rel) return null;
    const base = appUrl(rel);
    if (bust == null) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}t=${bust}`;
}

/**
 * Pick best available preview path for a size key.
 * Prefer alpha variants (transparent BG) over original, except when size is "original".
 * @param {object} creature
 * @param {'icon'|'small'|'medium'|'alpha'|'original'} sizeKey
 */
function pickPreviewPath(creature, sizeKey) {
    const s = creature.sprites || {};
    const order = {
        icon: ['icon', 'small', 'medium', 'alpha'],
        small: ['small', 'icon', 'medium', 'alpha'],
        medium: ['medium', 'alpha', 'small', 'icon'],
        alpha: ['alpha', 'medium', 'small', 'icon'],
        original: ['original', 'alpha', 'medium', 'small', 'icon']
    };
    for (const key of order[sizeKey] || order.small) {
        if (s[key]) return s[key];
    }
    return null;
}

function formatWhen(creature) {
    if (creature.mtime) {
        try {
            const d = new Date(creature.mtime);
            if (!Number.isNaN(d.getTime())) {
                return d.toISOString().slice(0, 16).replace('T', ' ');
            }
        } catch (_) {
            /* ignore */
        }
        return String(creature.mtime).slice(0, 16);
    }
    return creature.createdAt || '—';
}

/**
 * @param {Blob|ArrayBuffer} data
 * @returns {Promise<string>} raw base64 (no data: prefix)
 */
async function toBase64(data) {
    const buf =
        data instanceof ArrayBuffer
            ? data
            : await /** @type {Blob} */ (data).arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/**
 * @param {string} b64 raw or data-URL base64
 * @param {string} [filename]
 * @param {string} [mimeType]
 * @returns {File}
 */
function base64ToPngFile(b64, filename, mimeType) {
    const s = String(b64 || '').replace(/^data:image\/\w+;base64,/, '');
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const type = mimeType || 'image/png';
    return new File([bytes], filename || 'edited.png', { type });
}

/**
 * @returns {Promise<void>}
 */
async function initAssetManagerApp() {
    /** @type {object[]} */
    let creatures = [];
    /** @type {object|null} */
    let selected = null;
    /** Multi-select (checkboxes) — independent of the primary detail selection. */
    /** @type {Set<string>} */
    let checkedIds = new Set();
    let cacheBust = Date.now();
    let busy = false;

    /**
     * Active Free Edit popup session (parent side).
     * @type {{
     *   win: Window,
     *   creature: object,
     *   genre: string,
     *   kind: string,
     *   imagePath: string,
     *   filename: string
     * } | null}
     */
    let freeEditSession = null;

    const elGenre = document.getElementById('amGenre');
    const elKind = document.getElementById('amKind');
    const elLimit = document.getElementById('amLimit');
    const elThumb = document.getElementById('amThumbSize');
    const elSearch = document.getElementById('amSearch');
    const elGrid = document.getElementById('amGrid');
    const elDetail = document.getElementById('amDetail');
    const elShown = document.getElementById('amShownCount');
    const elTotal = document.getElementById('amTotalCount');
    const elStats = document.getElementById('amGenreStats');
    const elRefresh = document.getElementById('amRefreshBtn');
    const elSelectionBody = document.getElementById('amSelectionBody');
    const elModalHost = document.getElementById('amModalHost');
    const elCheckedChip = document.getElementById('amCheckedChip');
    const elCheckedCount = document.getElementById('amCheckedCount');
    const elFixGreen = document.getElementById('amFixGreenBtn');
    const elFlipBtn = document.getElementById('amFlipBtn');
    const elRegen = document.getElementById('amRegenBtn');
    const elDelete = document.getElementById('amDeleteBtn');

    if (!elGenre || !elGrid || !elDetail) {
        console.error('Sprite Manager DOM missing');
        return;
    }

    // Populate genre select
    for (const [id, g] of Object.entries(GENRES)) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = g.label;
        if (id === DEFAULT_GENRE) opt.selected = true;
        elGenre.appendChild(opt);
    }

    // Populate kind select
    if (elKind) {
        for (const id of listKindIds()) {
            const k = ASSET_KINDS[id];
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = k.label;
            if (id === DEFAULT_KIND) opt.selected = true;
            elKind.appendChild(opt);
        }
    }

    /**
     * Snapshot of filter controls persisted to IndexedDB.
     * @returns {{ genre: string, kind: string, limit: string, thumbSize: string }}
     */
    function collectPrefs() {
        return {
            genre: elGenre.value || DEFAULT_GENRE,
            kind: (elKind && elKind.value) || DEFAULT_KIND,
            limit: elLimit ? String(elLimit.value || '96') : '96',
            thumbSize: elThumb ? String(elThumb.value || 'small') : 'small'
        };
    }

    const schedulePrefsSave = createDebouncedPrefsSaver(PREFS_KEY, collectPrefs);

    /**
     * Apply stored prefs to controls (unknown values ignored).
     * @param {Record<string, unknown>|null} prefs
     */
    function applyPrefs(prefs) {
        if (!prefs || typeof prefs !== 'object') return;
        if (typeof prefs.genre === 'string' && GENRES[prefs.genre]) {
            elGenre.value = prefs.genre;
        }
        if (elKind && typeof prefs.kind === 'string' && ASSET_KINDS[prefs.kind]) {
            elKind.value = prefs.kind;
        }
        if (elLimit && (typeof prefs.limit === 'string' || typeof prefs.limit === 'number')) {
            const limitStr = String(prefs.limit);
            if (LIMIT_VALUES.has(limitStr)) elLimit.value = limitStr;
        }
        if (elThumb && typeof prefs.thumbSize === 'string' && THUMB_SIZES.has(prefs.thumbSize)) {
            elThumb.value = prefs.thumbSize;
        }
    }

    function currentGenre() {
        return elGenre.value || DEFAULT_GENRE;
    }

    function currentKind() {
        return (elKind && elKind.value) || DEFAULT_KIND;
    }

    function thumbKey() {
        return /** @type {'icon'|'small'|'medium'|'alpha'|'original'} */ (
            elThumb?.value || 'small'
        );
    }

    function setBusy(on, msg) {
        busy = on;
        if (msg) status(msg);
        document
            .querySelectorAll(
                '.am-actions .btn-retro, #amRefreshBtn, #amReplaceDrop, #amReplaceFile, #amActEdit, #amFixGreenBtn, #amFlipBtn, #amRegenBtn, #amDeleteBtn'
            )
            .forEach((el) => {
                if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) {
                    // Multi-select actions stay disabled when nothing is checked
                    if (
                        (el.id === 'amRegenBtn' ||
                            el.id === 'amDeleteBtn' ||
                            el.id === 'amFixGreenBtn' ||
                            el.id === 'amFlipBtn') &&
                        !on
                    ) {
                        el.disabled = checkedIds.size === 0;
                    } else {
                        el.disabled = on;
                    }
                } else if (el instanceof HTMLElement) {
                    el.classList.toggle('is-disabled', on);
                    el.setAttribute('aria-disabled', on ? 'true' : 'false');
                }
            });
        // Checkbox inputs on cards
        elGrid?.querySelectorAll('.am-card-check-input').forEach((input) => {
            if (input instanceof HTMLInputElement) input.disabled = on;
        });
    }

    function updateCheckedUi() {
        const n = checkedIds.size;
        if (elCheckedCount) elCheckedCount.textContent = String(n);
        if (elCheckedChip) elCheckedChip.hidden = n === 0;
        if (elFixGreen instanceof HTMLButtonElement) {
            elFixGreen.disabled = busy || n === 0;
        }
        if (elFlipBtn instanceof HTMLButtonElement) {
            elFlipBtn.disabled = busy || n === 0;
        }
        if (elRegen instanceof HTMLButtonElement) {
            elRegen.disabled = busy || n === 0;
        }
        if (elDelete instanceof HTMLButtonElement) {
            elDelete.disabled = busy || n === 0;
        }
    }

    /**
     * @param {string} id
     * @param {boolean} on
     */
    function setChecked(id, on) {
        if (!id) return;
        if (on) checkedIds.add(id);
        else checkedIds.delete(id);
        updateCheckedUi();
    }

    function clearChecked() {
        checkedIds.clear();
        updateCheckedUi();
    }

    async function loadGenreStats() {
        if (!elStats) return;
        try {
            const data = await apiCall('catalog_genres', { kind: currentKind() });
            elStats.innerHTML = '';
            for (const g of data.genres || []) {
                const chip = document.createElement('span');
                chip.className = 'stat-chip';
                chip.title = g.label;
                chip.innerHTML = `<span>${g.id.replace(/_/g, ' ')}</span> <strong>${g.withOriginal}</strong>`;
                chip.style.cursor = 'pointer';
                chip.addEventListener('click', () => {
                    elGenre.value = g.id;
                    schedulePrefsSave();
                    loadCatalog();
                });
                elStats.appendChild(chip);
            }
        } catch (err) {
            console.warn('catalog_genres', err);
        }
    }

    async function loadCatalog() {
        const genre = currentGenre();
        const kind = currentKind();
        const limitRaw = elLimit ? parseInt(elLimit.value, 10) : 96;
        const limit = limitRaw > 0 ? limitRaw : null;
        const query = elSearch ? elSearch.value.trim() : '';

        status(`Loading ${genre}/${kind}…`);
        setBusy(true);

        try {
            /** @type {Record<string, unknown>} */
            const params = { genre, kind };
            if (limit != null) params.limit = limit;
            if (query) params.query = query;

            const data = await apiCall('catalog_list', params);
            creatures = data.creatures || [];
            if (elShown) elShown.textContent = String(creatures.length);
            if (elTotal) elTotal.textContent = String(data.total ?? creatures.length);

            // Keep selection if still present
            if (selected) {
                selected = creatures.find((c) => c.id === selected.id) || null;
            }

            // Drop multi-select ids no longer in the loaded list
            if (checkedIds.size) {
                const live = new Set(creatures.map((c) => c.id));
                for (const id of [...checkedIds]) {
                    if (!live.has(id)) checkedIds.delete(id);
                }
            }

            renderGrid();
            renderDetail();
            updateCheckedUi();
            status(
                `${creatures.length} of ${data.total ?? creatures.length} · ${genre}/${kind}`
            );
        } catch (err) {
            status(`Error: ${err.message || err}`);
            creatures = [];
            renderGrid();
            renderDetail();
        } finally {
            setBusy(false);
        }
    }

    function renderGrid() {
        const size = thumbKey();
        elGrid.dataset.thumb = size;
        elGrid.innerHTML = '';
        if (!creatures.length) {
            const empty = document.createElement('div');
            empty.className = 'am-empty';
            empty.textContent = 'No creatures match this filter.';
            elGrid.appendChild(empty);
            return;
        }

        const frag = document.createDocumentFragment();

        for (const c of creatures) {
            const isPrimary = selected && selected.id === c.id;
            const isChecked = checkedIds.has(c.id);
            // div (not button) so nested checkbox stays valid HTML
            const card = document.createElement('div');
            card.className =
                'am-card' +
                (isPrimary ? ' is-selected' : '') +
                (isChecked ? ' is-checked' : '');
            card.dataset.id = c.id;
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.title = `${c.technical}\n${formatWhen(c)}`;

            const checkWrap = document.createElement('label');
            checkWrap.className = 'am-card-check';
            checkWrap.title = 'Multi-select for toolbar actions';
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.className = 'am-card-check-input form-check-input';
            check.checked = isChecked;
            check.disabled = busy;
            check.setAttribute('aria-label', `Select ${c.alias || c.technical}`);
            check.addEventListener('click', (ev) => {
                // Keep focus/selection independent of multi-check
                ev.stopPropagation();
            });
            check.addEventListener('change', (ev) => {
                ev.stopPropagation();
                setChecked(c.id, check.checked);
                card.classList.toggle('is-checked', check.checked);
            });
            checkWrap.addEventListener('click', (ev) => ev.stopPropagation());
            checkWrap.appendChild(check);

            const thumb = document.createElement('div');
            thumb.className = 'am-card-thumb';
            const path = pickPreviewPath(c, size);
            if (path) {
                const img = document.createElement('img');
                img.src = spriteUrl(path, cacheBust);
                img.alt = c.alias || c.technical;
                img.loading = 'lazy';
                img.decoding = 'async';
                img.addEventListener('error', () => {
                    thumb.innerHTML = '<span class="am-card-missing">no img</span>';
                });
                thumb.appendChild(img);
            } else {
                thumb.innerHTML = '<span class="am-card-missing">no α</span>';
            }

            const name = document.createElement('div');
            name.className = 'am-card-name';
            name.textContent = c.alias || c.technical;

            const meta = document.createElement('div');
            meta.className = 'am-card-meta';
            meta.textContent = formatWhen(c).slice(0, 10);

            card.appendChild(checkWrap);
            card.appendChild(thumb);
            card.appendChild(name);
            card.appendChild(meta);

            const selectPrimary = () => {
                selected = c;
                renderGrid();
                renderDetail();
            };
            card.addEventListener('click', selectPrimary);
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    selectPrimary();
                }
            });
            frag.appendChild(card);
        }
        elGrid.appendChild(frag);
    }

    /**
     * Resolve natural pixel size of the selected asset's source PNG into #amSelectionDims.
     * Prefers original (catalog source); falls back to alpha / other variants.
     * @param {object} creature
     */
    function fillSelectionDimensions(creature) {
        const el = document.getElementById('amSelectionDims');
        if (!el) return;

        const s = creature.sprites || {};
        const path =
            s.original ||
            s.alpha ||
            pickPreviewPath(creature, 'original') ||
            pickPreviewPath(creature, 'alpha');
        if (!path) {
            el.textContent = '—';
            return;
        }

        const expectedId = creature.id;
        const img = new Image();
        img.onload = () => {
            if (!selected || selected.id !== expectedId) return;
            const dd = document.getElementById('amSelectionDims');
            if (!dd) return;
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            dd.textContent =
                w > 0 && h > 0 ? `${w} × ${h}` : '—';
        };
        img.onerror = () => {
            if (!selected || selected.id !== expectedId) return;
            const dd = document.getElementById('amSelectionDims');
            if (dd) dd.textContent = '—';
        };
        img.src = spriteUrl(path, cacheBust) || '';
    }

    /**
     * Left sidebar: metadata + opaque alpha + rename for the selection.
     */
    function renderSelectionPanel() {
        if (!elSelectionBody) return;
        if (!selected) {
            elSelectionBody.className = 'am-selection-empty text-xxs text-muted';
            elSelectionBody.innerHTML = 'Select an asset in the grid.';
            return;
        }
        const c = selected;
        const opaque = c.opaqueAlpha === true;
        elSelectionBody.className = 'am-selection-body';
        elSelectionBody.innerHTML = `
            <div class="am-selection-title">${escapeHtml(c.alias || c.technical)}</div>
            <div class="am-selection-sub text-xxs text-muted mb-2">${escapeHtml(c.technical)}</div>
            <dl class="am-kv am-kv--sidebar">
                <dt>Id</dt><dd class="font-monospace">${escapeHtml(c.id)}</dd>
                <dt>Stem</dt><dd class="font-monospace">${escapeHtml(c.stem || '—')}</dd>
                <dt>Dimensions</dt><dd id="amSelectionDims" class="font-monospace">…</dd>
                <dt>Status</dt><dd>${escapeHtml(c.status || '—')}</dd>
                <dt>Source</dt><dd>${escapeHtml(c.source || '—')}</dd>
                <dt>Kind</dt><dd>${escapeHtml(c.kind || currentKind())}</dd>
                <dt>Category</dt><dd>${escapeHtml(c.category || '—')}</dd>
                <dt>Created</dt><dd>${escapeHtml(c.createdAt || '—')}</dd>
                <dt>Mtime</dt><dd>${escapeHtml(formatWhen(c))}</dd>
            </dl>
            <div class="form-check am-opaque-check mt-2">
                <input class="form-check-input" type="checkbox" id="amOpaqueAlpha"
                       ${opaque ? 'checked' : ''} ${busy ? 'disabled' : ''}>
                <label class="form-check-label text-xxs" for="amOpaqueAlpha"
                       title="When on, alpha/ is an opaque RGBA copy (no chroma key)">
                    Opaque alpha
                </label>
            </div>
            <p class="text-xxs text-muted mt-1 mb-2">
                Fallback if unset: <strong>on for tiles</strong>, off otherwise. Changing reprocesses variants.
            </p>
            <button type="button" class="btn btn-retro btn-retro-secondary w-100" id="amActRename"
                    title="Rename" ${busy ? 'disabled' : ''}>
                <i class="fa-solid fa-i-cursor"></i> Rename
            </button>
        `;
        fillSelectionDimensions(c);
        document.getElementById('amActRename')?.addEventListener('click', () => openRename(c));
        const opaqueEl = /** @type {HTMLInputElement|null} */ (
            document.getElementById('amOpaqueAlpha')
        );
        if (opaqueEl) {
            opaqueEl.addEventListener('change', () => {
                const next = opaqueEl.checked;
                // Revert UI until modal confirms
                opaqueEl.checked = !next;
                openOpaqueAlphaConfirm(c, next);
            });
        }
    }

    function renderDetail() {
        renderSelectionPanel();

        if (!selected) {
            elDetail.innerHTML =
                '<div class="am-detail-empty">Select an asset to preview and run actions.</div>';
            return;
        }

        const c = selected;
        // Detail pane always shows the alpha (transparent) variant when available
        const previewPath = pickPreviewPath(c, 'alpha');
        const downloadPath =
            (c.sprites && c.sprites.alpha) || previewPath || (c.sprites && c.sprites.original) || null;
        const downloadName = `${c.stem || c.id}_alpha.png`;
        // Free Edit prefers alpha (ready cutout); fall back so edit still works pre-process
        const editPath =
            (c.sprites && c.sprites.alpha) ||
            pickPreviewPath(c, 'alpha') ||
            (c.sprites && c.sprites.original) ||
            null;
        const variants = ['original', 'alpha', 'medium', 'retro', 'small', 'icon'];
        const chips = variants
            .map((v) => {
                const ok = c.present && c.present[v];
                return `<span class="am-variant-chip ${ok ? 'is-present' : 'is-missing'}">${v}</span>`;
            })
            .join('');

        elDetail.innerHTML = `
            <div class="am-detail-preview">
                ${
                    previewPath
                        ? `<img src="${spriteUrl(previewPath, cacheBust)}" alt="${escapeHtml(c.alias || c.technical)} alpha">`
                        : '<span class="text-muted text-xxs">No alpha preview</span>'
                }
            </div>
            <div class="am-detail-title-row">
                <h3 class="am-detail-title">${escapeHtml(c.alias || c.technical)}</h3>
                <button type="button" class="btn btn-retro btn-retro-secondary am-detail-edit-btn" id="amActEdit"
                        title="Edit alpha in Free Edit" aria-label="Edit alpha PNG"
                        ${busy || !editPath ? 'disabled' : ''}>
                    <i class="fa-solid fa-pen"></i>
                </button>
            </div>
            <div class="am-detail-sub">${escapeHtml(c.technical)}</div>
            <div class="am-variant-chips">${chips}</div>
            <div class="am-actions">
                <button type="button" class="btn btn-retro btn-retro-cyan am-action-tile" id="amActFlip" title="Flip horizontal" ${busy ? 'disabled' : ''}>
                    <i class="fa-solid fa-left-right"></i>
                    <span>Flip</span>
                </button>
                <button type="button" class="btn btn-retro btn-retro-secondary am-action-tile" id="amActDownload" title="Download alpha PNG" ${busy || !downloadPath ? 'disabled' : ''}>
                    <i class="fa-solid fa-download"></i>
                    <span>Download</span>
                </button>
                <button type="button" class="btn btn-retro btn-retro-danger am-action-tile" id="amActRemove" title="Remove" ${busy ? 'disabled' : ''}>
                    <i class="fa-solid fa-trash"></i>
                    <span>Remove</span>
                </button>
            </div>
            <div class="am-replace-drop ${busy ? 'is-disabled' : ''}" id="amReplaceDrop" role="button" tabindex="0" aria-label="Replace original image" aria-disabled="${busy ? 'true' : 'false'}">
                <i class="fa-solid fa-cloud-arrow-up"></i>
                <span class="am-replace-title">Replace original</span>
                <span class="am-replace-hint">Drop image or click · regenerates thumbs</span>
                <input type="file" id="amReplaceFile" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp" ${busy ? 'disabled' : ''} hidden>
            </div>
        `;

        document.getElementById('amActFlip')?.addEventListener('click', () => doFlip(c));
        document.getElementById('amActRemove')?.addEventListener('click', () => doRemove(c));
        document.getElementById('amActEdit')?.addEventListener('click', () => openFreeEdit(c));
        document.getElementById('amActDownload')?.addEventListener('click', () => {
            if (!downloadPath) return;
            downloadSprite(downloadPath, downloadName);
        });
        bindReplaceDrop(c);
    }

    /**
     * Trigger browser download of a sprite asset.
     * @param {string} rel
     * @param {string} filename
     */
    function downloadSprite(rel, filename) {
        const href = spriteUrl(rel, cacheBust);
        if (!href) return;
        const a = document.createElement('a');
        a.href = href;
        a.download = filename || 'sprite.png';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        status(`Download: ${filename}`);
    }

    /**
     * @param {object} c
     */
    function bindReplaceDrop(c) {
        const zone = document.getElementById('amReplaceDrop');
        const input = document.getElementById('amReplaceFile');
        if (!(zone instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return;

        const pick = () => {
            if (busy || zone.classList.contains('is-disabled')) return;
            input.click();
        };

        zone.addEventListener('click', (ev) => {
            if (ev.target === input) return;
            pick();
        });
        zone.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                pick();
            }
        });

        zone.addEventListener('dragenter', (ev) => {
            ev.preventDefault();
            if (!busy) zone.classList.add('is-dragover');
        });
        zone.addEventListener('dragover', (ev) => {
            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
            if (!busy) zone.classList.add('is-dragover');
        });
        zone.addEventListener('dragleave', (ev) => {
            if (ev.target === zone) zone.classList.remove('is-dragover');
        });
        zone.addEventListener('drop', (ev) => {
            ev.preventDefault();
            zone.classList.remove('is-dragover');
            if (busy) return;
            const file = ev.dataTransfer?.files?.[0];
            if (file) doReplace(c, file);
        });

        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            input.value = '';
            if (file) doReplace(c, file);
        });
    }

    /**
     * @param {object} c
     * @param {File} file
     */
    async function doReplace(c, file) {
        if (busy || !file) return;
        if (!/^image\//i.test(file.type) && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) {
            status('Replace failed: drop an image file (PNG/JPEG/WebP)');
            return;
        }
        if (
            !window.confirm(
                `Replace original for "${c.technical}" with "${file.name}"?\nThis overwrites original/ and regenerates alpha/medium/retro/small/icon.`
            )
        ) {
            return;
        }
        setBusy(true, `Replacing ${c.id}…`);
        try {
            const fd = new FormData();
            fd.append('action', 'creature_replace');
            fd.append('genre', currentGenre());
            fd.append('kind', currentKind());
            fd.append('id', c.id);
            fd.append('file', file, file.name);
            await apiCall('creature_replace', {}, { method: 'POST', formData: fd });
            cacheBust = Date.now();
            status(`Replaced original for ${c.technical}`);
            await loadCatalog();
        } catch (err) {
            status(`Replace failed: ${err.message || err}`);
            setBusy(false);
        }
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
     * @param {object} c
     */
    async function doFlip(c) {
        if (busy) return;
        if (!window.confirm(`Flip horizontal "${c.technical}"?\nThis rewrites original/ and reprocesses variants.`)) {
            return;
        }
        setBusy(true, `Flipping ${c.id}…`);
        try {
            await apiCall('creature_flip', {
                genre: currentGenre(),
                kind: currentKind(),
                id: c.id
            });
            cacheBust = Date.now();
            status(`Flipped ${c.technical}`);
            await loadCatalog();
        } catch (err) {
            status(`Flip failed: ${err.message || err}`);
            setBusy(false);
        }
    }

    /**
     * Horizontal flip of original/ + reprocess for all multi-checked tiles.
     */
    async function doFlipChecked() {
        if (busy) return;
        const ids = [...checkedIds];
        if (!ids.length) {
            status('Check one or more tiles first');
            return;
        }
        const labels = ids
            .map((id) => {
                const c = creatures.find((x) => x.id === id);
                return c ? c.technical || c.id : id;
            })
            .slice(0, 8);
        const more = ids.length > 8 ? `\n…and ${ids.length - 8} more` : '';
        if (
            !window.confirm(
                `Flip horizontal ${ids.length} asset(s)?\n` +
                    `Rewrites original/ and reprocesses variants for:\n` +
                    labels.map((t) => `  · ${t}`).join('\n') +
                    more
            )
        ) {
            return;
        }

        const genre = currentGenre();
        const kind = currentKind();
        setBusy(true, `Flip 0/${ids.length}…`);
        let ok = 0;
        /** @type {string[]} */
        const failed = [];
        try {
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                status(`Flip ${i + 1}/${ids.length}: ${id}…`);
                try {
                    await apiCall('creature_flip', { genre, kind, id });
                    ok += 1;
                } catch (err) {
                    failed.push(`${id}: ${err.message || err}`);
                }
            }
            cacheBust = Date.now();
            if (failed.length) {
                status(`Flip done: ${ok} ok, ${failed.length} failed · ${failed[0]}`);
            } else {
                status(`Flip: ${ok} asset(s) flipped`);
            }
            clearChecked();
            await loadCatalog();
        } catch (err) {
            status(`Flip failed: ${err.message || err}`);
            setBusy(false);
        }
    }

    /**
     * Reprocess variants (alpha/medium/retro/small/icon) for multi-checked tiles.
     */
    async function doRegen() {
        if (busy) return;
        const ids = [...checkedIds];
        if (!ids.length) {
            status('Check one or more tiles first');
            return;
        }
        const labels = ids
            .map((id) => {
                const c = creatures.find((x) => x.id === id);
                return c ? c.technical || c.id : id;
            })
            .slice(0, 8);
        const more = ids.length > 8 ? `\n…and ${ids.length - 8} more` : '';
        if (
            !window.confirm(
                `Regen ${ids.length} asset(s)?\n` +
                    `Re-runs process_sprites on original/ for:\n` +
                    labels.map((t) => `  · ${t}`).join('\n') +
                    more
            )
        ) {
            return;
        }

        const genre = currentGenre();
        const kind = currentKind();
        setBusy(true, `Regen 0/${ids.length}…`);
        let ok = 0;
        /** @type {string[]} */
        const failed = [];
        try {
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                status(`Regen ${i + 1}/${ids.length}: ${id}…`);
                try {
                    await apiCall('creature_reprocess', { genre, kind, id });
                    ok += 1;
                } catch (err) {
                    failed.push(`${id}: ${err.message || err}`);
                }
            }
            cacheBust = Date.now();
            if (failed.length) {
                status(`Regen done: ${ok} ok, ${failed.length} failed · ${failed[0]}`);
            } else {
                status(`Regen: ${ok} asset(s) reprocessed`);
            }
            clearChecked();
            await loadCatalog();
        } catch (err) {
            status(`Regen failed: ${err.message || err}`);
            setBusy(false);
        }
    }

    /**
     * Delete original + variants + catalog row for multi-checked tiles.
     */
    async function doDeleteChecked() {
        if (busy) return;
        const ids = [...checkedIds];
        if (!ids.length) {
            status('Check one or more tiles first');
            return;
        }
        const labels = ids
            .map((id) => {
                const c = creatures.find((x) => x.id === id);
                return c ? c.technical || c.id : id;
            })
            .slice(0, 8);
        const more = ids.length > 8 ? `\n…and ${ids.length - 8} more` : '';
        if (
            !window.confirm(
                `Delete ${ids.length} asset(s)?\n` +
                    `Removes original + alpha/medium/retro/small/icon and catalog rows for:\n` +
                    labels.map((t) => `  · ${t}`).join('\n') +
                    more
            )
        ) {
            return;
        }

        const genre = currentGenre();
        const kind = currentKind();
        setBusy(true, `Delete 0/${ids.length}…`);
        let ok = 0;
        /** @type {string[]} */
        const failed = [];
        try {
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                status(`Delete ${i + 1}/${ids.length}: ${id}…`);
                try {
                    await apiCall('creature_remove', { genre, kind, id });
                    ok += 1;
                    if (selected && selected.id === id) selected = null;
                } catch (err) {
                    failed.push(`${id}: ${err.message || err}`);
                }
            }
            cacheBust = Date.now();
            if (failed.length) {
                status(`Delete done: ${ok} ok, ${failed.length} failed · ${failed[0]}`);
            } else {
                status(`Delete: ${ok} asset(s) removed`);
            }
            clearChecked();
            await loadCatalog();
            await loadGenreStats();
        } catch (err) {
            status(`Delete failed: ${err.message || err}`);
            setBusy(false);
        }
    }

    /**
     * Neutralize accentuated green on original/ (R=B=G), then reprocess checked tiles.
     */
    async function doFixGreen() {
        if (busy) return;
        const ids = [...checkedIds];
        if (!ids.length) {
            status('Check one or more tiles first');
            return;
        }
        const labels = ids
            .map((id) => {
                const c = creatures.find((x) => x.id === id);
                return c ? c.technical || c.id : id;
            })
            .slice(0, 8);
        const more = ids.length > 8 ? `\n…and ${ids.length - 8} more` : '';
        if (
            !window.confirm(
                `Fix Green on ${ids.length} asset(s)?\n` +
                    `Sets R=B=G on strong green pixels (high G, low R/B), then reprocesses:\n` +
                    labels.map((t) => `  · ${t}`).join('\n') +
                    more
            )
        ) {
            return;
        }

        const genre = currentGenre();
        const kind = currentKind();
        setBusy(true, `Fix Green 0/${ids.length}…`);
        let ok = 0;
        /** @type {string[]} */
        const failed = [];
        try {
            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                status(`Fix Green ${i + 1}/${ids.length}: ${id}…`);
                try {
                    await apiCall('creature_fix_green', { genre, kind, id });
                    ok += 1;
                } catch (err) {
                    failed.push(`${id}: ${err.message || err}`);
                }
            }
            cacheBust = Date.now();
            if (failed.length) {
                status(`Fix Green done: ${ok} ok, ${failed.length} failed · ${failed[0]}`);
            } else {
                status(`Fix Green: ${ok} asset(s) updated`);
            }
            clearChecked();
            await loadCatalog();
        } catch (err) {
            status(`Fix Green failed: ${err.message || err}`);
            setBusy(false);
        }
    }

    /**
     * Open sprite-manager Free Edit with this creature's alpha PNG.
     * On Save, FREE_EDIT_SAVE → replace original + reprocess variants (same as Replace).
     * @param {object} c
     */
    function openFreeEdit(c) {
        if (busy) return;
        const imagePath =
            (c.sprites && c.sprites.alpha) ||
            pickPreviewPath(c, 'alpha') ||
            (c.sprites && c.sprites.original) ||
            null;
        if (!imagePath) {
            status('Edit failed: no alpha/original image');
            return;
        }

        const editUrl = resolveSpriteEditorUrl(undefined, appUrl);
        let win = null;
        try {
            // Named window is reused across creatures; force navigation so READY/LOAD re-run.
            win = window.open(editUrl, 'amFreeEdit', 'width=1100,height=720');
            if (win && !win.closed) {
                try {
                    win.location.href = editUrl;
                } catch (_) {
                    /* first open / still loading — ignore */
                }
            }
        } catch (err) {
            status(`Edit failed: popup blocked (${err.message || err})`);
            return;
        }
        if (!win) {
            status('Edit failed: popup blocked by the browser');
            return;
        }

        freeEditSession = {
            win,
            creature: c,
            genre: currentGenre(),
            kind: currentKind(),
            imagePath,
            filename: `${c.stem || c.id}_alpha.png`
        };
        status(`Free Edit: ${c.technical}…`);
        try {
            win.focus();
        } catch (_) {
            /* ignore */
        }
    }

    /**
     * Load alpha PNG into Free Edit child after FREE_EDIT_READY.
     * @param {Window} target
     * @param {{ imagePath: string, filename: string }} session
     */
    async function sendFreeEditLoad(target, session) {
        const href = spriteUrl(session.imagePath, cacheBust);
        if (!href) throw new Error('No image URL');
        const res = await fetch(href, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status} loading alpha`);
        const buf = await res.arrayBuffer();
        const pngBase64 = await toBase64(buf);
        target.postMessage(
            {
                type: FREE_EDIT_MSG.LOAD,
                filename: session.filename,
                pngBase64
            },
            window.location.origin
        );
    }

    /**
     * Apply Free Edit save: write as new original + reprocess variants.
     * @param {object} c
     * @param {{ pngBase64?: string, filename?: string, mimeType?: string }} payload
     * @param {string} genre
     * @param {string} [kind]
     */
    async function applyFreeEditSave(c, payload, genre, kind) {
        if (!payload || !payload.pngBase64) {
            throw new Error('FREE_EDIT_SAVE missing pngBase64');
        }
        const file = base64ToPngFile(
            payload.pngBase64,
            payload.filename || `${c.stem || c.id}_edited.png`,
            payload.mimeType || 'image/png'
        );
        const fd = new FormData();
        fd.append('action', 'creature_replace');
        fd.append('genre', genre);
        fd.append('kind', kind || DEFAULT_KIND);
        fd.append('id', c.id);
        fd.append('file', file, file.name);
        await apiCall('creature_replace', {}, { method: 'POST', formData: fd });
        cacheBust = Date.now();
        status(`Saved edit for ${c.technical}`);
        await loadCatalog();
    }

    window.addEventListener('message', (event) => {
        if (!event || !event.data) return;
        if (event.origin !== window.location.origin) return;
        if (!freeEditSession) return;

        const session = freeEditSession;
        if (event.source && session.win && event.source !== session.win) return;

        const msg = event.data;
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === FREE_EDIT_MSG.READY) {
            sendFreeEditLoad(session.win, session).catch((err) => {
                status(`Edit load failed: ${err.message || err}`);
                freeEditSession = null;
            });
            return;
        }

        if (msg.type === FREE_EDIT_MSG.CANCEL) {
            freeEditSession = null;
            status(`Edit cancelled · ${session.creature.technical}`);
            return;
        }

        if (msg.type === FREE_EDIT_MSG.SAVE) {
            freeEditSession = null;
            if (busy) return;
            setBusy(true, `Saving edit for ${session.creature.id}…`);
            applyFreeEditSave(
                session.creature,
                msg,
                session.genre,
                session.kind
            ).catch((err) => {
                status(`Edit save failed: ${err.message || err}`);
                setBusy(false);
            });
        }
    });

    /**
     * @param {object} c
     */
    async function doRemove(c) {
        if (busy) return;
        if (
            !window.confirm(
                `Remove "${c.technical}"?\nDeletes original + alpha/medium/retro/small/icon and updates creatures.json.`
            )
        ) {
            return;
        }
        setBusy(true, `Removing ${c.id}…`);
        try {
            await apiCall('creature_remove', {
                genre: currentGenre(),
                kind: currentKind(),
                id: c.id
            });
            selected = null;
            checkedIds.delete(c.id);
            status(`Removed ${c.technical}`);
            await loadCatalog();
            await loadGenreStats();
        } catch (err) {
            status(`Remove failed: ${err.message || err}`);
            setBusy(false);
        }
    }

    /**
     * @param {object} c
     */
    /**
     * Confirm opaqueAlpha change (reprocesses alpha/medium/retro/small/icon).
     * @param {object} c
     * @param {boolean} next
     */
    function openOpaqueAlphaConfirm(c, next) {
        if (!elModalHost || busy) return;
        const mode = next
            ? 'Opaque alpha: alpha/ will be a full-opacity RGBA copy (no chroma key).'
            : 'Chroma key: alpha/ will re-key the green/solid background.';
        elModalHost.innerHTML = `
            <div class="am-modal-backdrop" id="amModalBg">
                <div class="am-modal" role="dialog" aria-modal="true">
                    <h3>Change opaque alpha</h3>
                    <p class="text-xxs mb-2">
                        Asset: <strong>${escapeHtml(c.technical)}</strong>
                    </p>
                    <p class="text-xxs mb-2">
                        Set <code>opaqueAlpha</code> to
                        <strong>${next ? 'true' : 'false'}</strong>?
                    </p>
                    <p class="text-xxs text-muted mb-0">
                        ${escapeHtml(mode)}
                        Existing alpha/medium/retro/small/icon will be regenerated.
                    </p>
                    <div class="am-modal-actions">
                        <button type="button" class="btn btn-retro btn-retro-secondary" id="amOpaqueCancel">Cancel</button>
                        <button type="button" class="btn btn-retro btn-retro-primary" id="amOpaqueOk">Confirm</button>
                    </div>
                </div>
            </div>
        `;
        const close = () => {
            elModalHost.innerHTML = '';
            renderSelectionPanel();
        };
        document.getElementById('amOpaqueCancel')?.addEventListener('click', close);
        document.getElementById('amModalBg')?.addEventListener('click', (ev) => {
            if (ev.target && /** @type {HTMLElement} */ (ev.target).id === 'amModalBg') close();
        });
        document.getElementById('amOpaqueOk')?.addEventListener('click', async () => {
            close();
            setBusy(true, `Setting opaqueAlpha=${next} for ${c.id}…`);
            try {
                await apiCall('creature_opaque_alpha', {
                    genre: currentGenre(),
                    kind: currentKind(),
                    id: c.id,
                    opaque_alpha: next
                });
                selected = { ...c, opaqueAlpha: next };
                cacheBust = Date.now();
                status(`opaqueAlpha=${next} · reprocessed ${c.technical}`);
                await loadCatalog();
            } catch (err) {
                status(`Opaque alpha failed: ${err.message || err}`);
                setBusy(false);
                renderSelectionPanel();
            }
        });
    }

    function openRename(c) {
        if (!elModalHost || busy) return;
        elModalHost.innerHTML = `
            <div class="am-modal-backdrop" id="amModalBg">
                <div class="am-modal" role="dialog" aria-modal="true">
                    <h3>Rename asset</h3>
                    <label class="label-retro" for="amRenameName">Technical name</label>
                    <input class="form-control form-control-retro w-100 mb-2" id="amRenameName"
                           value="${escapeHtml(c.technical)}" autocomplete="off">
                    <label class="label-retro" for="amRenameAlias">Alias (optional)</label>
                    <input class="form-control form-control-retro w-100" id="amRenameAlias"
                           value="${escapeHtml(c.alias || '')}" autocomplete="off">
                    <p class="text-xxs text-muted mt-2 mb-0">
                        Renames PNG stems in all variant folders and updates the catalog + done list.
                    </p>
                    <div class="am-modal-actions">
                        <button type="button" class="btn btn-retro btn-retro-secondary" id="amRenameCancel">Cancel</button>
                        <button type="button" class="btn btn-retro btn-retro-primary" id="amRenameOk">Rename</button>
                    </div>
                </div>
            </div>
        `;

        const close = () => {
            elModalHost.innerHTML = '';
        };
        document.getElementById('amRenameCancel')?.addEventListener('click', close);
        document.getElementById('amModalBg')?.addEventListener('click', (ev) => {
            if (ev.target && /** @type {HTMLElement} */ (ev.target).id === 'amModalBg') close();
        });
        document.getElementById('amRenameOk')?.addEventListener('click', async () => {
            const nameEl = document.getElementById('amRenameName');
            const aliasEl = document.getElementById('amRenameAlias');
            const name = nameEl instanceof HTMLInputElement ? nameEl.value.trim() : '';
            const alias = aliasEl instanceof HTMLInputElement ? aliasEl.value.trim() : '';
            if (!name) {
                status('Technical name required');
                return;
            }
            close();
            setBusy(true, `Renaming ${c.id}…`);
            try {
                /** @type {Record<string, unknown>} */
                const params = {
                    genre: currentGenre(),
                    kind: currentKind(),
                    id: c.id,
                    name
                };
                if (alias) params.alias = alias;
                const result = await apiCall('creature_rename', params);
                const newId = result.to?.id || c.id;
                selected = { ...c, id: newId };
                cacheBust = Date.now();
                status(`Renamed → ${name}`);
                await loadCatalog();
            } catch (err) {
                status(`Rename failed: ${err.message || err}`);
                setBusy(false);
            }
        });
        const nameInput = document.getElementById('amRenameName');
        if (nameInput instanceof HTMLInputElement) {
            nameInput.focus();
            nameInput.select();
        }
    }

    // Events
    elGenre.addEventListener('change', () => {
        selected = null;
        clearChecked();
        schedulePrefsSave();
        loadCatalog();
    });
    elKind?.addEventListener('change', () => {
        selected = null;
        clearChecked();
        schedulePrefsSave();
        loadGenreStats();
        loadCatalog();
    });
    elFixGreen?.addEventListener('click', () => {
        doFixGreen();
    });
    elFlipBtn?.addEventListener('click', () => {
        doFlipChecked();
    });
    elRegen?.addEventListener('click', () => {
        doRegen();
    });
    elDelete?.addEventListener('click', () => {
        doDeleteChecked();
    });
    elLimit?.addEventListener('change', () => {
        schedulePrefsSave();
        loadCatalog();
    });
    elThumb?.addEventListener('change', () => {
        schedulePrefsSave();
        renderGrid();
        renderDetail();
    });

    let searchTimer = null;
    elSearch?.addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => loadCatalog(), 280);
    });

    elRefresh?.addEventListener('click', () => {
        cacheBust = Date.now();
        loadCatalog();
        loadGenreStats();
    });

    // Sprite Batch Builder popup (header right actions — same window.open style as Sim Batch)
    const openBatchBtn = document.getElementById('amOpenBatchBuilderBtn');
    const batchPopupHint = document.getElementById('amBatchBuilderPopupHint');
    let spriteBatchPopup = null;

    /**
     * Clear any pending roster inject payload (open without inject).
     */
    function clearBatchInjectPayload() {
        try {
            localStorage.removeItem(BATCH_INJECT_STORAGE_KEY);
        } catch (_) {
            /* private mode / quota */
        }
    }

    /**
     * Persist selected sprites for Batch Builder to load into the roster.
     * Full list is stored; Batch Builder caps to the current grid size.
     * @param {Array<{technical: string, alias: string, category?: string}>} items
     */
    function writeBatchInjectPayload(items) {
        const payload = {
            ts: Date.now(),
            genre: currentGenre(),
            kind: currentKind(),
            items
        };
        localStorage.setItem(BATCH_INJECT_STORAGE_KEY, JSON.stringify(payload));
    }

    /**
     * Multi-checked catalog rows in grid order (stable), mapped for buildBatch inject.
     * @returns {Array<{technical: string, alias: string, category?: string}>}
     */
    function selectedItemsForBatchInject() {
        const out = [];
        for (const c of creatures) {
            if (!checkedIds.has(c.id)) continue;
            const technical = String(c.technical || c.id || '').trim();
            if (!technical) continue;
            /** @type {{technical: string, alias: string, category?: string}} */
            const row = {
                technical,
                alias: String(c.alias || technical).trim() || technical
            };
            if (c.category) row.category = String(c.category);
            out.push(row);
        }
        return out;
    }

    /**
     * Open (or focus/reload) the Sprite Batch Builder popup.
     * @param {{ inject?: boolean, forceReload?: boolean }} [opts]
     */
    function openSpriteBatchBuilder(opts = {}) {
        const inject = !!opts.inject;
        const forceReload = !!opts.forceReload || inject;

        if (!inject) {
            clearBatchInjectPayload();
        }

        if (spriteBatchPopup && !spriteBatchPopup.closed) {
            try {
                if (forceReload) {
                    spriteBatchPopup.location.href = appUrl(SPRITE_BATCH_URL_PATH);
                }
                spriteBatchPopup.focus();
            } catch (_) {
                /* ignore cross-window focus/nav failures */
            }
            if (batchPopupHint) batchPopupHint.hidden = true;
            return;
        }

        const features = [
            'width=920',
            'height=860',
            'menubar=no',
            'toolbar=no',
            'location=no',
            'status=no',
            'resizable=yes',
            'scrollbars=yes'
        ].join(',');
        spriteBatchPopup = window.open(
            appUrl(SPRITE_BATCH_URL_PATH),
            SPRITE_BATCH_WINDOW_NAME,
            features
        );
        if (!spriteBatchPopup) {
            if (batchPopupHint) {
                batchPopupHint.hidden = false;
                batchPopupHint.textContent =
                    'Popup blocked — allow popups for this site, then try again.';
            }
            if (inject) clearBatchInjectPayload();
            return;
        }
        if (batchPopupHint) batchPopupHint.hidden = true;
        try {
            spriteBatchPopup.focus();
        } catch (_) {
            /* ignore */
        }
    }

    /**
     * When multi-select is non-empty, ask whether to inject into the Batch Builder roster.
     */
    function openBatchBuilderInjectModal() {
        if (!elModalHost) {
            openSpriteBatchBuilder({ inject: false });
            return;
        }
        const items = selectedItemsForBatchInject();
        const n = items.length;
        if (n === 0) {
            openSpriteBatchBuilder({ inject: false });
            return;
        }

        elModalHost.innerHTML = `
            <div class="am-modal-backdrop" id="amModalBg">
                <div class="am-modal" role="dialog" aria-modal="true" aria-labelledby="amBatchInjectTitle">
                    <h3 id="amBatchInjectTitle">Inject selection into Batch Builder?</h3>
                    <p class="text-xxs mb-2">
                        You have <strong>${n}</strong> sprite${n === 1 ? '' : 's'} selected.
                        Inject them into the Batch Builder roster for update?
                    </p>
                    <p class="text-xxs text-muted mb-0">
                        The Batch Builder will load these names into the roster
                        (up to 16; grid auto-fits). Then click
                        <strong>Run update</strong> there to regenerate the PNGs —
                        inject alone does not rewrite files.
                    </p>
                    <div class="am-modal-actions">
                        <button type="button" class="btn btn-retro btn-retro-secondary" id="amBatchInjectCancel">Cancel</button>
                        <button type="button" class="btn btn-retro btn-retro-secondary" id="amBatchInjectSkip">Open without inject</button>
                        <button type="button" class="btn btn-retro btn-retro-primary" id="amBatchInjectOk">Inject and open</button>
                    </div>
                </div>
            </div>
        `;

        const close = () => {
            elModalHost.innerHTML = '';
        };
        document.getElementById('amBatchInjectCancel')?.addEventListener('click', close);
        document.getElementById('amModalBg')?.addEventListener('click', (ev) => {
            if (ev.target && /** @type {HTMLElement} */ (ev.target).id === 'amModalBg') close();
        });
        document.getElementById('amBatchInjectSkip')?.addEventListener('click', () => {
            close();
            openSpriteBatchBuilder({ inject: false });
        });
        document.getElementById('amBatchInjectOk')?.addEventListener('click', () => {
            close();
            try {
                writeBatchInjectPayload(items);
            } catch (err) {
                status(`Could not prepare inject: ${err.message || err}`);
                openSpriteBatchBuilder({ inject: false });
                return;
            }
            openSpriteBatchBuilder({ inject: true });
            status(
                `Opening Batch Builder with ${n} selected sprite${n === 1 ? '' : 's'} (capped by grid)…`
            );
        });
    }

    if (openBatchBtn) {
        openBatchBtn.addEventListener('click', () => {
            if (checkedIds.size > 0) {
                openBatchBuilderInjectModal();
                return;
            }
            openSpriteBatchBuilder({ inject: false });
        });
    }

    // Restore UI prefs before first catalog fetch
    try {
        applyPrefs(await getUiPreferences(PREFS_KEY));
    } catch (err) {
        console.warn('Sprite Manager prefs load failed', err);
    }

    await loadGenreStats();
    await loadCatalog();
}

module.exports = { initAssetManagerApp };
