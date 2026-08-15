/**
 * Hunt Editor — CRUD for presets/<mode>/hunts/*.json + mode.json browser.hunts.
 * Schema-driven JSON Editor (@json-editor/json-editor) with attribute dependencies.
 */

'use strict';

const { appUrl } = require('../../core/lib/app_paths.js');
const {
    setPreferredContentModeId,
    resolvePreferredContentModeId
} = require('../../core/lib/ui_preferences.js');
const { prettyJson } = require('../../core/lib/json_format.js');
const {
    registerRelationPickers,
    setRelationPickerContext
} = require('../designer-ui/relation_pickers.js');
const {
    registerWaveRegionsEditor,
    normalizeRegions
} = require('./wave_regions_editor.js');

const ID_RE = /^[a-z][a-z0-9_]{0,79}$/;

/**
 * @returns {string}
 */
function apiUrl() {
    if (typeof window !== 'undefined' && window.__API_URL__) {
        return String(window.__API_URL__);
    }
    return appUrl('php/api.php');
}

/**
 * @returns {string}
 */
function schemasRoot() {
    if (typeof window !== 'undefined' && window.__SCHEMAS_ROOT__) {
        return String(window.__SCHEMAS_ROOT__).replace(/\/$/, '');
    }
    return appUrl('schemas').replace(/\/$/, '');
}

/**
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function cloneJson(obj) {
    if (obj === undefined) return undefined;
    return JSON.parse(JSON.stringify(obj));
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @param {{ method?: string }} [opts]
 */
async function apiCall(action, params = {}, opts = {}) {
    const writeActions = new Set(['hunts_save', 'hunts_delete']);
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
 * Read a nested value from a json-editor path like "root.layout.type".
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
function getValueByPath(obj, path) {
    if (!obj || typeof obj !== 'object') return undefined;
    const cleanPath = String(path || '')
        .replace(/^root\./, '')
        .replace(/^root$/, '');
    if (!cleanPath) return obj;
    const parts = cleanPath.split('.');
    let curr = obj;
    for (const p of parts) {
        if (curr && typeof curr === 'object' && p in /** @type {object} */ (curr)) {
            curr = /** @type {Record<string, unknown>} */ (curr)[p];
        } else {
            return undefined;
        }
    }
    return curr;
}

/**
 * @param {string} msg
 */
function status(msg) {
    const el = document.getElementById('statusMsg');
    if (el) el.textContent = msg;
}

/**
 * @param {string|null} msg
 */
function showError(msg) {
    const el = document.getElementById('heError');
    if (!el) return;
    if (!msg) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = msg;
}

/** Cache for loaded hunts schema document */
let huntSchemaCache = null;

/** Cache for relation IDs per mode */
const relationIdsCache = {};

async function loadHuntSchemaDoc() {
    if (huntSchemaCache) return huntSchemaCache;
    const url = `${schemasRoot()}/hunts.schema.json`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`Failed to load hunts schema (HTTP ${res.status})`);
    }
    huntSchemaCache = await res.json();
    return huntSchemaCache;
}

async function fetchRelationIds(modeId) {
    // creatures: format creature_id + Select picker (not enum dropdown)
    const kinds = ['art_sets', 'dungeons', 'populations', 'classes', 'strategies'];
    const idsByKind = {};
    for (const kind of kinds) {
        try {
            const data = await apiCall('presets_ids', { mode: modeId, kind });
            if (Array.isArray(data.ids)) {
                idsByKind[kind] = data.ids;
            }
        } catch (_) {
            idsByKind[kind] = [];
        }
    }
    return idsByKind;
}

function enrichHuntSchema(schemaDoc, idsByKind) {
    const out = cloneJson(schemaDoc);

    // id / label are edited in the hunt-editor header (#heId / #heLabel).
    // Hide the duplicate schema fields so Save cannot clobber header edits
    // (or vice-versa: form Label changes were overwritten by a stale header).
    if (out.properties && out.properties.id) {
        out.properties.id.options = Object.assign({}, out.properties.id.options, {
            hidden: true
        });
    }
    if (out.properties && out.properties.label) {
        out.properties.label.options = Object.assign({}, out.properties.label.options, {
            hidden: true
        });
    }

    if (idsByKind.art_sets && idsByKind.art_sets.length > 0) {
        if (out.properties && out.properties.artSet) {
            out.properties.artSet.enum = idsByKind.art_sets;
        }
    }
    if (idsByKind.dungeons && idsByKind.dungeons.length > 0) {
        if (out.properties && out.properties.layout && out.properties.layout.properties && out.properties.layout.properties.profileId) {
            out.properties.layout.properties.profileId.enum = idsByKind.dungeons;
        }
    }
    if (idsByKind.populations && idsByKind.populations.length > 0) {
        if (out.properties && out.properties.spawnSource && out.properties.spawnSource.properties && out.properties.spawnSource.properties.populationId) {
            out.properties.spawnSource.properties.populationId.enum = idsByKind.populations;
        }
    }
    // creatureId / spawnSource.creatures use schema format creature_id +
    // openCreaturePicker (shared Wiki browser). Do not inject giant enums.
    if (idsByKind.classes && idsByKind.classes.length > 0) {
        if (out.definitions && out.definitions.partyMember && out.definitions.partyMember.properties && out.definitions.partyMember.properties.classId) {
            out.definitions.partyMember.properties.classId.enum = idsByKind.classes;
        }
    }
    if (idsByKind.strategies && idsByKind.strategies.length > 0) {
        if (out.definitions && out.definitions.partyMember && out.definitions.partyMember.properties && out.definitions.partyMember.properties.strategyId) {
            out.definitions.partyMember.properties.strategyId.enum = idsByKind.strategies;
        }
    }

    return out;
}

/**
 * Sanitize hunt for authoring: migrate legacy waves.region → waves.regions.
 * @param {object} hunt
 * @returns {object}
 */
function sanitizeHuntForEditor(hunt) {
    if (!hunt || typeof hunt !== 'object' || Array.isArray(hunt)) return hunt;
    const out = cloneJson(hunt);

    if (out.waves && typeof out.waves === 'object' && !Array.isArray(out.waves)) {
        const waves = /** @type {Record<string, unknown>} */ (out.waves);
        let regions = Array.isArray(waves.regions)
            ? normalizeRegions(waves.regions)
            : [];
        if (!regions.length && waves.region && typeof waves.region === 'object') {
            regions = normalizeRegions([waves.region]);
        }
        if (regions.length) {
            waves.regions = regions;
        } else {
            delete waves.regions;
        }
        delete waves.region;
    }
    return out;
}

/**
 * @returns {Promise<void>}
 */
async function initHuntEditorApp() {
    /** @type {{ id: string, label: string, isDefault?: boolean }[]} */
    let modes =
        typeof window !== 'undefined' && Array.isArray(window.__MODES__)
            ? window.__MODES__.slice()
            : [];

    /** @type {string} */
    let modeId = resolvePreferredContentModeId({
        fallback:
            typeof window !== 'undefined' && window.__CONTENT_MODE__
                ? String(window.__CONTENT_MODE__)
                : 'standard',
        defaultId: 'standard'
    });

    if (typeof window !== 'undefined' && window.location && window.location.search) {
        try {
            const q = new URLSearchParams(window.location.search).get('mode');
            if (q && /^[a-z][a-z0-9_]{0,63}$/.test(q)) {
                modeId = q;
                setPreferredContentModeId(modeId);
            }
        } catch (_) {
            /* ignore */
        }
    }

    /** @type {Array<Record<string, unknown>>} */
    let hunts = [];

    /** Currently loaded disk id (null = new unsaved) */
    /** @type {string|null} */
    let loadedId = null;

    /** @type {boolean} */
    let isNew = false;

    /** @type {boolean} */
    let dirty = false;

    /** @type {boolean} */
    let suppressDirty = false;

    /** @type {'form' | 'raw'} */
    let viewMode = 'form';

    let jsonEditor = null;
    let editorGeneration = 0;

    const els = {
        modeSelect: /** @type {HTMLSelectElement|null} */ (
            document.getElementById('heModeSelect')
        ),
        filter: /** @type {HTMLInputElement|null} */ (
            document.getElementById('heFilter')
        ),
        list: document.getElementById('heHuntList'),
        form: document.getElementById('heForm'),
        empty: document.getElementById('heEmpty'),
        id: /** @type {HTMLInputElement|null} */ (document.getElementById('heId')),
        label: /** @type {HTMLInputElement|null} */ (
            document.getElementById('heLabel')
        ),
        json: /** @type {HTMLTextAreaElement|null} */ (
            document.getElementById('heJson')
        ),
        editorHolder: document.getElementById('heEditorHolder'),
        inBrowser: /** @type {HTMLInputElement|null} */ (
            document.getElementById('heInBrowser')
        ),
        setDefault: /** @type {HTMLInputElement|null} */ (
            document.getElementById('heSetDefault')
        ),
        editingId: document.getElementById('heEditingId'),
        pathHint: document.getElementById('hePathHint'),
        dirtyBadge: document.getElementById('heDirtyBadge'),
        statusMeta: document.getElementById('heStatusMeta'),
        saveBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('heSaveBtn')
        ),
        deleteBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('heDeleteBtn')
        ),
        duplicateBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('heDuplicateBtn')
        ),
        formatBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('heFormatBtn')
        ),
        viewFormBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('heViewFormBtn')
        ),
        viewRawBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('heViewRawBtn')
        ),
        newBtn: document.getElementById('heNewBtn'),
        emptyNewBtn: document.getElementById('heEmptyNewBtn')
    };

    function setDirty(v) {
        dirty = !!v;
        if (els.dirtyBadge) els.dirtyBadge.hidden = !dirty;
        if (els.saveBtn) els.saveBtn.disabled = !dirty && !isNew;
    }

    function markDirty() {
        if (suppressDirty) return;
        setDirty(true);
    }

    function destroyEditor() {
        editorGeneration += 1;
        if (jsonEditor) {
            try {
                jsonEditor.destroy();
            } catch (_) {
                /* ignore */
            }
            jsonEditor = null;
        }
    }

    /**
     * Genre for creature thumb previews / picker when mode has genre.
     * @returns {string}
     */
    function modeGenre() {
        const m = modes.find((x) => x && x.id === modeId);
        if (m && m.genre) return String(m.genre);
        return 'rpg_fantasy';
    }

    function syncPickerContext() {
        setRelationPickerContext({ modeGenre: modeGenre(), modeId: modeId });
    }

    async function mountEditor(huntObj) {
        destroyEditor();
        if (!els.editorHolder) return;

        if (typeof window.JSONEditor !== 'function') {
            viewMode = 'raw';
            applyViewMode();
            if (els.json) els.json.value = prettyJson(huntObj);
            return;
        }

        registerRelationPickers();
        registerWaveRegionsEditor();
        syncPickerContext();

        const schemaDoc = await loadHuntSchemaDoc();
        if (!relationIdsCache[modeId]) {
            relationIdsCache[modeId] = await fetchRelationIds(modeId);
        }
        const schema = enrichHuntSchema(schemaDoc, relationIdsCache[modeId] || {});
        const startval = sanitizeHuntForEditor(huntObj);

        suppressDirty = true;
        const gen = editorGeneration;
        await new Promise((resolve, reject) => {
            try {
                jsonEditor = new window.JSONEditor(els.editorHolder, {
                    schema,
                    startval,
                    theme: 'bootstrap5',
                    iconlib: 'fontawesome5',
                    disable_collapse: false,
                    disable_edit_json: true,
                    disable_properties: false,
                    no_additional_properties: false,
                    required_by_default: false,
                    keep_oneof_values: false,
                    show_errors: 'interaction',
                    object_layout: 'normal',
                    object_background: '',
                    object_text: ''
                });

                // Optional enum selects often report empty string as invalid.
                // Same filter as Designer UI so Save is not blocked on unset optionals.
                const origValidate = jsonEditor.validate.bind(jsonEditor);
                jsonEditor.validate = function (value) {
                    const rawErrors = origValidate(value);
                    if (!rawErrors || !rawErrors.length) return rawErrors;
                    const currentVal =
                        value !== undefined ? value : jsonEditor.getValue();
                    return rawErrors.filter((err) => {
                        if (
                            err.property === 'enum' ||
                            (err.message &&
                                String(err.message).toLowerCase().includes('enum'))
                        ) {
                            const val = getValueByPath(currentVal, err.path || '');
                            if (val === '' || val === undefined || val === null) {
                                return false;
                            }
                        }
                        return true;
                    });
                };
            } catch (e) {
                suppressDirty = false;
                reject(e);
                return;
            }

            jsonEditor.on('ready', () => {
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        if (gen !== editorGeneration) {
                            resolve();
                            return;
                        }
                        setDirty(!!isNew);
                        suppressDirty = false;
                        resolve();
                    }, 0);
                });
            });

            jsonEditor.on('change', () => {
                if (gen !== editorGeneration) return;
                if (suppressDirty) return;
                markDirty();
            });
        });
    }

    function applyViewMode() {
        const form = viewMode === 'form';
        if (els.editorHolder) els.editorHolder.hidden = !form;
        if (els.json) els.json.hidden = form;
        if (els.viewFormBtn) {
            els.viewFormBtn.classList.toggle('is-active', form);
            els.viewFormBtn.disabled = false;
        }
        if (els.viewRawBtn) {
            els.viewRawBtn.classList.toggle('is-active', !form);
            els.viewRawBtn.disabled = false;
        }
    }

    function syncHeaderIntoObj(obj) {
        applyHeaderIdentity(obj);
    }

    async function setViewMode(targetMode) {
        if (viewMode === targetMode) return;
        showError(null);
        if (targetMode === 'raw') {
            let currentObj = null;
            if (jsonEditor) {
                currentObj = jsonEditor.getValue();
            } else if (els.json && els.json.value) {
                try {
                    currentObj = JSON.parse(els.json.value);
                } catch (_) {
                    /* leave raw text */
                }
            }
            if (currentObj) {
                syncHeaderIntoObj(currentObj);
                if (els.json) els.json.value = prettyJson(currentObj);
            }
            viewMode = 'raw';
            applyViewMode();
        } else {
            let parsed = null;
            if (els.json) {
                try {
                    parsed = JSON.parse(els.json.value);
                } catch (e) {
                    showError('Cannot switch to form view: Invalid JSON in text area (' + (e && e.message) + ')');
                    return;
                }
            }
            viewMode = 'form';
            applyViewMode();
            if (parsed) {
                syncHeaderIntoObj(parsed);
                await mountEditor(parsed);
            }
        }
    }

    function fillModes() {
        if (!els.modeSelect) return;
        els.modeSelect.innerHTML = '';
        if (modes.length === 0) {
            modes = [
                { id: 'standard', label: 'Standard', isDefault: true },
                { id: 'legacy', label: 'Legacy (dev port)', isDefault: false }
            ];
        }
        modeId = resolvePreferredContentModeId({
            fallback: modeId,
            availableIds: modes.map((m) => m.id),
            defaultId: 'standard'
        });
        for (const m of modes) {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.label || m.id;
            if (m.id === modeId) opt.selected = true;
            els.modeSelect.appendChild(opt);
        }
        if (!modes.some((m) => m.id === modeId) && modes[0]) {
            modeId = modes[0].id;
            els.modeSelect.value = modeId;
        }
        setPreferredContentModeId(modeId);
    }

    /**
     * @param {Array<Record<string, unknown>>} rows
     */
    function renderList(rows) {
        if (!els.list) return;
        const q = (els.filter && els.filter.value ? els.filter.value : '')
            .trim()
            .toLowerCase();
        const filtered = !q
            ? rows
            : rows.filter((h) => {
                  const id = String(h.id || '').toLowerCase();
                  const label = String(h.label || '').toLowerCase();
                  return id.includes(q) || label.includes(q);
              });

        if (filtered.length === 0) {
            els.list.innerHTML =
                '<div class="he-list-empty text-muted small px-1 py-2">No hunts</div>';
            return;
        }

        els.list.innerHTML = filtered
            .map((h) => {
                const id = String(h.id || '');
                const label = String(h.label || id);
                const active = loadedId === id && !isNew ? ' is-active' : '';
                const badges = [];
                if (h.inBrowser) badges.push('<span class="he-badge he-badge--browser" title="In browser.hunts">web</span>');
                if (h.isDefault) badges.push('<span class="he-badge he-badge--default" title="Mode default">default</span>');
                return (
                    `<button type="button" class="he-list-item${active}" data-id="${escapeHtml(id)}" role="option">` +
                    `<span class="he-list-id">${escapeHtml(id)}</span>` +
                    `<span class="he-list-label">${escapeHtml(label)}</span>` +
                    `<span class="he-list-badges">${badges.join('')}</span>` +
                    `</button>`
                );
            })
            .join('');
    }

    function showEmpty() {
        loadedId = null;
        isNew = false;
        destroyEditor();
        if (els.form) els.form.hidden = true;
        if (els.empty) els.empty.hidden = false;
        if (els.editingId) els.editingId.textContent = '—';
        if (els.pathHint) els.pathHint.textContent = '';
        if (els.deleteBtn) els.deleteBtn.disabled = true;
        if (els.duplicateBtn) els.duplicateBtn.disabled = true;
        if (els.formatBtn) els.formatBtn.disabled = true;
        if (els.saveBtn) els.saveBtn.disabled = true;
        if (els.viewFormBtn) els.viewFormBtn.disabled = true;
        if (els.viewRawBtn) els.viewRawBtn.disabled = true;
        setDirty(false);
        renderList(hunts);
    }

    /**
     * @param {object} hunt
     * @param {{ id: string|null, isNew: boolean, inBrowser?: boolean, isDefault?: boolean, path?: string }} meta
     */
    async function showEditor(hunt, meta) {
        suppressDirty = true;
        loadedId = meta.id;
        isNew = !!meta.isNew;
        if (els.empty) els.empty.hidden = true;
        if (els.form) els.form.hidden = false;

        const id = String(hunt.id || meta.id || '');
        if (els.id) {
            els.id.value = id;
            els.id.readOnly = !isNew && !!meta.id;
        }
        if (els.label) els.label.value = String(hunt.label || id);
        if (els.json) els.json.value = prettyJson(hunt);
        if (els.inBrowser) els.inBrowser.checked = meta.inBrowser !== false;
        if (els.setDefault) els.setDefault.checked = !!meta.isDefault;

        if (els.editingId) {
            els.editingId.textContent = isNew ? `(new) ${id || '…'}` : id;
        }
        if (els.pathHint) {
            els.pathHint.textContent = meta.path
                ? meta.path
                : `presets/${modeId}/hunts/${id || '<id>'}.json`;
        }
        if (els.deleteBtn) els.deleteBtn.disabled = isNew;
        if (els.duplicateBtn) els.duplicateBtn.disabled = isNew;
        if (els.formatBtn) els.formatBtn.disabled = false;
        if (els.saveBtn) els.saveBtn.disabled = false;

        applyViewMode();
        if (viewMode === 'form') {
            try {
                await mountEditor(hunt);
            } catch (e) {
                console.warn('Failed to mount JSONEditor, falling back to raw view:', e);
                viewMode = 'raw';
                applyViewMode();
            }
        }

        setDirty(isNew);
        suppressDirty = false;
        renderList(hunts);
    }

    async function refreshList() {
        const data = await apiCall('hunts_list', { mode: modeId });
        hunts = Array.isArray(data.hunts) ? data.hunts : [];
        if (els.statusMeta) {
            els.statusMeta.textContent = `${modeId}: ${hunts.length} hunt(s)`;
        }
        renderList(hunts);
    }

    /**
     * @param {string} id
     */
    async function loadHunt(id) {
        if (dirty) {
            const ok = window.confirm('Discard unsaved changes?');
            if (!ok) return;
        }
        showError(null);
        status(`Loading ${id}…`);
        const data = await apiCall('hunts_get', { mode: modeId, id });
        await showEditor(data.hunt, {
            id: data.id,
            isNew: false,
            inBrowser: data.inBrowser,
            isDefault: data.isDefault,
            path: data.path
        });
        status(`Loaded ${id}`);
    }

    async function startNew(seedFrom) {
        if (dirty) {
            const ok = window.confirm('Discard unsaved changes?');
            if (!ok) return;
        }
        showError(null);
        let hunt;
        if (seedFrom && typeof seedFrom === 'object') {
            hunt = JSON.parse(JSON.stringify(seedFrom));
            const base = String(hunt.id || 'new_hunt').replace(/_copy$/, '');
            let candidate = `${base}_copy`;
            const existing = new Set(hunts.map((h) => String(h.id)));
            let n = 2;
            while (existing.has(candidate)) {
                candidate = `${base}_copy${n}`;
                n += 1;
            }
            hunt.id = candidate;
            hunt.label = String(hunt.label || base) + ' (copy)';
        } else {
            const data = await apiCall('hunts_template', { id: 'new_hunt' });
            hunt = data.hunt;
        }
        await showEditor(hunt, {
            id: null,
            isNew: true,
            inBrowser: true,
            isDefault: false
        });
        if (els.id) {
            els.id.readOnly = false;
            els.id.focus();
            els.id.select();
        }
        status('New hunt — set id and save');
    }

    /**
     * Header (#heId / #heLabel) is the sole identity UI. Push those values into
     * the form model (and raw JSON) so getValue / save never keep a stale label.
     */
    function applyHeaderIdentity(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
        if (els.id && els.id.value.trim()) {
            obj.id = els.id.value.trim().toLowerCase();
        }
        if (els.label) {
            const lab = els.label.value.trim();
            // Header is authoritative when non-empty; empty falls back to body/id later.
            if (lab) obj.label = lab;
        }
        return obj;
    }

    function syncLabelIntoJson() {
        if (viewMode === 'form' && jsonEditor) {
            try {
                // Prefer path editors so identity sticks inside json-editor state
                // (mutating getValue() alone does not update the live model).
                if (els.id && els.id.value.trim()) {
                    const idEd = jsonEditor.getEditor('root.id');
                    if (idEd) idEd.setValue(els.id.value.trim().toLowerCase());
                }
                if (els.label && els.label.value.trim()) {
                    const labelEd = jsonEditor.getEditor('root.label');
                    if (labelEd) labelEd.setValue(els.label.value.trim());
                }
                const val = applyHeaderIdentity(jsonEditor.getValue());
                if (val && els.json) els.json.value = prettyJson(val);
            } catch (_) {
                /* ignore */
            }
            return;
        }

        if (!els.json || !els.label) return;
        try {
            const obj = JSON.parse(els.json.value);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                applyHeaderIdentity(obj);
                if (!obj.label) obj.label = obj.id || 'hunt';
                suppressDirty = true;
                els.json.value = prettyJson(obj);
                suppressDirty = false;
            }
        } catch (_) {
            // leave raw JSON; save will validate
        }
    }

    function parseEditorBody() {
        if (!els.id) {
            throw new Error('Editor not ready');
        }
        const id = els.id.value.trim().toLowerCase();
        if (!ID_RE.test(id)) {
            throw new Error('Invalid hunt id (snake_case, e.g. cave_crawl_generated)');
        }

        // Keep form model in sync before validate/getValue (label used to lag).
        if (viewMode === 'form' && jsonEditor) {
            syncLabelIntoJson();
        }

        let hunt;
        if (viewMode === 'form') {
            if (!jsonEditor) throw new Error('Form editor not ready');
            const errors = jsonEditor.validate();
            if (errors && errors.length > 0) {
                const msg = errors.map((e) => `${e.path}: ${e.message}`).join('\n');
                throw new Error('Schema validation error:\n' + msg);
            }
            hunt = jsonEditor.getValue();
        } else {
            if (!els.json) throw new Error('JSON input not ready');
            try {
                hunt = JSON.parse(els.json.value);
            } catch (e) {
                throw new Error('Hunt JSON is not valid JSON: ' + (e && e.message));
            }
        }

        if (!hunt || typeof hunt !== 'object' || Array.isArray(hunt)) {
            throw new Error('Hunt JSON must be an object');
        }

        // Header always wins for identity — never trust a stale form copy of label.
        hunt.id = id;
        const headerLabel = els.label ? els.label.value.trim() : '';
        if (headerLabel) {
            hunt.label = headerLabel;
        } else if (!hunt.label || typeof hunt.label !== 'string' || !String(hunt.label).trim()) {
            hunt.label = id;
        } else {
            hunt.label = String(hunt.label).trim();
        }

        hunt = sanitizeHuntForEditor(hunt);

        return { id, hunt };
    }

    async function save() {
        showError(null);
        let parsed;
        try {
            syncLabelIntoJson();
            parsed = parseEditorBody();
        } catch (e) {
            showError(e.message || String(e));
            status('Fix validation errors');
            return;
        }

        const renameFrom =
            !isNew && loadedId && loadedId !== parsed.id ? loadedId : null;

        status(`Saving ${parsed.id}…`);
        try {
            const data = await apiCall('hunts_save', {
                mode: modeId,
                id: parsed.id,
                hunt: parsed.hunt,
                inBrowser: !!(els.inBrowser && els.inBrowser.checked),
                setDefault: !!(els.setDefault && els.setDefault.checked),
                renameFrom: renameFrom || undefined
            });
            await refreshList();
            await showEditor(parsed.hunt, {
                id: data.id,
                isNew: false,
                inBrowser: data.inBrowser,
                isDefault: data.isDefault,
                path: data.path
            });
            setDirty(false);
            status(
                data.created
                    ? `Created ${data.id}`
                    : `Saved ${data.id}` +
                          (data.inBrowser ? ' · browser.hunts updated' : ' · removed from browser.hunts')
            );
        } catch (e) {
            showError(e.message || String(e));
            status('Save failed');
        }
    }

    async function remove() {
        if (isNew || !loadedId) return;
        const ok = window.confirm(
            `Delete hunt "${loadedId}" from mode "${modeId}"?\n\nThis removes the JSON file and drops it from browser.hunts.`
        );
        if (!ok) return;
        showError(null);
        status(`Deleting ${loadedId}…`);
        try {
            await apiCall('hunts_delete', { mode: modeId, id: loadedId });
            await refreshList();
            showEmpty();
            status(`Deleted ${loadedId}`);
        } catch (e) {
            showError(e.message || String(e));
            status('Delete failed');
        }
    }

    function formatJson() {
        if (viewMode === 'form' && jsonEditor) {
            try {
                const obj = jsonEditor.getValue();
                if (els.json) els.json.value = prettyJson(obj);
                status('Formatted JSON');
            } catch (e) {
                showError('Cannot format: ' + (e && e.message));
            }
            return;
        }

        if (!els.json) return;
        try {
            const obj = JSON.parse(els.json.value);
            suppressDirty = true;
            els.json.value = prettyJson(obj);
            suppressDirty = false;
            markDirty();
            status('Formatted JSON');
        } catch (e) {
            showError('Cannot format: ' + (e && e.message));
        }
    }

    // Wire events
    if (els.modeSelect) {
        els.modeSelect.addEventListener('change', async () => {
            if (dirty) {
                const ok = window.confirm('Discard unsaved changes and switch mode?');
                if (!ok) {
                    els.modeSelect.value = modeId;
                    return;
                }
            }
            modeId = els.modeSelect.value;
            setPreferredContentModeId(modeId);
            syncPickerContext();
            showError(null);
            try {
                await refreshList();
                showEmpty();
                status(`Mode: ${modeId}`);
            } catch (e) {
                showError(e.message || String(e));
            }
        });
    }

    if (els.filter) {
        els.filter.addEventListener('input', () => renderList(hunts));
    }

    if (els.list) {
        els.list.addEventListener('click', (ev) => {
            const btn = ev.target && /** @type {HTMLElement} */ (ev.target).closest
                ? /** @type {HTMLElement} */ (ev.target).closest('[data-id]')
                : null;
            if (!btn) return;
            const id = btn.getAttribute('data-id');
            if (id) loadHunt(id).catch((e) => showError(e.message || String(e)));
        });
    }

    for (const el of [els.id, els.label, els.json, els.inBrowser, els.setDefault]) {
        if (!el) continue;
        el.addEventListener('input', markDirty);
        el.addEventListener('change', markDirty);
    }

    // Keep hidden form identity fields in lockstep with the header as the user types.
    if (els.label) {
        els.label.addEventListener('input', () => {
            if (viewMode !== 'form' || !jsonEditor) return;
            try {
                const lab = els.label.value.trim();
                if (!lab) return;
                const labelEd = jsonEditor.getEditor('root.label');
                if (labelEd) labelEd.setValue(lab);
            } catch (_) {
                /* ignore */
            }
        });
    }

    if (els.id) {
        els.id.addEventListener('input', () => {
            if (isNew) {
                if (els.editingId) {
                    els.editingId.textContent = `(new) ${els.id.value.trim() || '…'}`;
                }
                if (els.pathHint) {
                    const id = els.id.value.trim() || '<id>';
                    els.pathHint.textContent = `presets/${modeId}/hunts/${id}.json`;
                }
            }
            if (viewMode !== 'form' || !jsonEditor) return;
            try {
                const next = els.id.value.trim().toLowerCase();
                if (!next) return;
                const idEd = jsonEditor.getEditor('root.id');
                if (idEd) idEd.setValue(next);
            } catch (_) {
                /* ignore */
            }
        });
    }

    if (els.viewFormBtn) {
        els.viewFormBtn.addEventListener('click', () => {
            setViewMode('form').catch((e) => showError(e.message || String(e)));
        });
    }
    if (els.viewRawBtn) {
        els.viewRawBtn.addEventListener('click', () => {
            setViewMode('raw').catch((e) => showError(e.message || String(e)));
        });
    }

    if (els.saveBtn) els.saveBtn.addEventListener('click', () => save());
    if (els.deleteBtn) els.deleteBtn.addEventListener('click', () => remove());
    if (els.formatBtn) els.formatBtn.addEventListener('click', () => formatJson());
    if (els.duplicateBtn) {
        els.duplicateBtn.addEventListener('click', async () => {
            try {
                const { hunt } = parseEditorBody();
                await startNew(hunt);
            } catch (e) {
                showError(e.message || String(e));
            }
        });
    }
    if (els.newBtn) {
        els.newBtn.addEventListener('click', () => {
            startNew(null).catch((e) => showError(e.message || String(e)));
        });
    }
    if (els.emptyNewBtn) {
        els.emptyNewBtn.addEventListener('click', () => {
            startNew(null).catch((e) => showError(e.message || String(e)));
        });
    }

    document.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
            ev.preventDefault();
            if (!els.form || els.form.hidden) return;
            save();
        }
    });

    // Boot
    try {
        if (modes.length === 0) {
            const data = await apiCall('modes_list');
            modes = Array.isArray(data.modes) ? data.modes : [];
            modeId = resolvePreferredContentModeId({
                fallback:
                    modeId ||
                    (data.defaultMode ? String(data.defaultMode) : 'standard'),
                availableIds: modes.map((m) => m.id),
                defaultId: data.defaultMode
                    ? String(data.defaultMode)
                    : 'standard'
            });
        }
        fillModes();
        syncPickerContext();
        await refreshList();
        showEmpty();
        status('Ready');
    } catch (e) {
        showError(e.message || String(e));
        status('Failed to load hunts');
        fillModes();
        syncPickerContext();
        showEmpty();
    }
}

module.exports = {
    initHuntEditorApp
};
