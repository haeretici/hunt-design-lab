/**
 * Designer relation pickers: json-editor formats + window.open popups.
 *
 * Formats:
 *   catalog_asset_id — reusable string id + catalog Select + alpha thumb
 *   tile_id          — alias of catalog_asset_id with assetKind=tiles
 *   creature_sprite_id — alias with assetKind=creatures (art Custom Sprite)
 *   creature_id      — combat creature template id (Wiki Creatures / openCreaturePicker)
 *   equipment_id     — combat equipment catalog (openEquipmentPicker)
 *   spell_shape      — object (spell.shape) → shape catalog with matrix preview
 *
 * Protocol: postMessage channel hunt-design-lab-designer-picker
 * (see html/widgets/designer_pickers/*).
 *
 * To add a new asset-id property later:
 *   1. Schema: `"format": "catalog_asset_id"` (+ optional `options.assetKind`)
 *      or a format alias (`tile_id` / `creature_sprite_id` / `creature_id` / `equipment_id`).
 *   2. Optional `options.previewVariant` (default `alpha`), `options.genre`.
 * Genre: root.customSpriteGenre / baseSpriteGenre → root.genre → mode genre
 * (setRelationPickerContext) → rpg_fantasy.
 */

'use strict';

const { ASSET_KINDS } = require('../../settings.js');
const { appUrl } = require('../../core/lib/app_paths.js');
const { resolveSpriteUrl } = require('../../core/lib/creature_sprites.js');
const {
    inferRoleKeyFromPath,
    defaultCatalogKindForRole,
    catalogCategoryForRole,
    normalizeCatalogKind,
    artSetPickFields
} = require('../../core/lib/dungeon/art_set_context.js');
const {
    listShapeCatalog,
    catalogIdForShape,
    formatShapeSummary
} = require('../../core/lib/shapes.js');
const {
    DESIGNER_PICKER_CHANNEL,
    TILE_PICKER_WINDOW,
    EQUIPMENT_PICKER_WINDOW,
    CREATURE_PICKER_WINDOW,
    SHAPE_PICKER_WINDOW,
    TILE_PICKER_URL_PATH,
    EQUIPMENT_PICKER_URL_PATH,
    CREATURE_PICKER_URL_PATH,
    SHAPE_PICKER_URL_PATH,
    MSG,
    PARENT_MSG,
    popupFeatures
} = require('../../../html/widgets/designer_pickers/protocol.js');

/** @type {Map<string, { kind: string, apply: (value: unknown) => void, win?: Window|null, initPayload?: Record<string, unknown> }>} */
const pending = new Map();

let requestSeq = 0;
let listenerBound = false;

/**
 * Designer shell context (mode genre, mode id, etc.). Updated from app.js on mode change.
 * @type {{ modeGenre: string, modeId: string }}
 */
let pickerContext = {
    modeGenre: 'rpg_fantasy',
    modeId: 'standard'
};

/**
 * @param {{ modeGenre?: string, modeId?: string }} partial
 */
function setRelationPickerContext(partial) {
    if (!partial || typeof partial !== 'object') return;
    if (partial.modeGenre != null && String(partial.modeGenre).trim()) {
        pickerContext.modeGenre = String(partial.modeGenre).trim();
    }
    if (partial.modeId != null && String(partial.modeId).trim()) {
        pickerContext.modeId = String(partial.modeId).trim();
    }
}

/**
 * @returns {{ modeGenre: string, modeId: string }}
 */
function getRelationPickerContext() {
    return Object.assign({}, pickerContext);
}

/**
 * @returns {string}
 */
function nextRequestId() {
    requestSeq += 1;
    return `du-pick-${Date.now()}-${requestSeq}`;
}

/**
 * Infer catalog category from json-editor path (e.g. root.roles.floor.0.id).
 * Scenery/furniture map to the objects family (no forced object category).
 * @param {string} path
 * @returns {string}
 */
function inferCategoryFromPath(path) {
    const roleKey = inferRoleKeyFromPath(path);
    const kind = defaultCatalogKindForRole(roleKey) || 'tiles';
    return catalogCategoryForRole(kind, roleKey);
}

/**
 * Walk json-editor parents for the weighted role entry (has id, not pack root).
 * @param {any} editor
 * @param {string} [path]
 * @returns {Record<string, unknown>|null}
 */
function findRoleEntryValue(editor, path) {
    const p = String(path || (editor && editor.path) || '');
    if (!/\.roles\./.test(p)) return null;
    let node = editor;
    while (node) {
        try {
            if (typeof node.getValue === 'function') {
                const v = node.getValue();
                if (
                    v &&
                    typeof v === 'object' &&
                    !Array.isArray(v) &&
                    v.id != null &&
                    v.roles == null
                ) {
                    return /** @type {Record<string, unknown>} */ (v);
                }
            }
        } catch (_) {
            /* ignore */
        }
        node = node.parent;
    }
    return null;
}

/**
 * Resolve catalog family + category for an art-set role field.
 * Priority: entry.kind → role key / roleId → schema fallback.
 * Pack-level kind (almost always tiles) is ignored — scenery is objects.
 * @param {any} editor
 * @param {string} [path]
 * @param {string} [fallbackKind]
 * @returns {{
 *   assetKind: string,
 *   category: string,
 *   roleKey: string,
 *   roleId: string,
 *   entry: Record<string, unknown>|null
 * }}
 */
function resolvePickerContext(editor, path, fallbackKind) {
    const fieldPath = String(path || (editor && editor.path) || '');
    const roleKey = inferRoleKeyFromPath(fieldPath);
    const entry = findRoleEntryValue(editor, fieldPath);
    const entryKind = entry ? normalizeCatalogKind(entry.kind) : '';
    const roleId =
        entry && entry.roleId != null ? String(entry.roleId) : '';
    const fromRole = defaultCatalogKindForRole(roleKey, roleId);
    const assetKind = entryKind || fromRole || fallbackKind || 'tiles';
    const category = catalogCategoryForRole(assetKind, roleKey);
    return { assetKind, category, roleKey, roleId, entry };
}

/**
 * @param {string} kind
 * @returns {string[]}
 */
function catalogCategoriesForKind(kind) {
    const meta = ASSET_KINDS[kind];
    if (meta && Array.isArray(meta.categories)) {
        return meta.categories.slice();
    }
    return [];
}

/**
 * Write a sibling property on a role-entry object editor.
 * @param {any} editor
 * @param {string} key
 * @param {unknown} value
 */
function setSiblingField(editor, key, value) {
    if (!editor || !key) return;
    try {
        const parent = editor.parent;
        if (parent && parent.editors && parent.editors[key]) {
            const child = parent.editors[key];
            if (child && typeof child.setValue === 'function') {
                child.setValue(value);
                return;
            }
        }
        const parentPath = String(editor.path || '').replace(/\.[^.]+$/, '');
        const root = editor.jsoneditor;
        if (parentPath && root && typeof root.getEditor === 'function') {
            const child = root.getEditor(parentPath + '.' + key);
            if (child && typeof child.setValue === 'function') {
                child.setValue(value);
                return;
            }
        }
        if (
            parent &&
            typeof parent.getValue === 'function' &&
            typeof parent.setValue === 'function'
        ) {
            const v = parent.getValue();
            if (
                v &&
                typeof v === 'object' &&
                !Array.isArray(v) &&
                v.roles == null
            ) {
                const next = Object.assign({}, v);
                next[key] = value;
                parent.setValue(next);
            }
        }
    } catch (_) {
        /* ignore */
    }
}

/**
 * Resolve genre for catalog pickers / thumbs.
 * Priority: schema override → root.customSpriteGenre / baseSpriteGenre →
 * root.genre → mode genre → fallback.
 * (customSpriteGenre / baseSpriteGenre let templates browse sprites from another genre.)
 * @param {any} editor
 * @param {string} [fallback]
 * @param {string} [schemaGenre]
 * @returns {string}
 */
function resolveGenre(editor, fallback, schemaGenre) {
    if (schemaGenre && String(schemaGenre).trim()) {
        return String(schemaGenre).trim();
    }
    try {
        const root = editor && editor.jsoneditor;
        if (root && typeof root.getValue === 'function') {
            const v = root.getValue();
            if (v && typeof v === 'object') {
                if (
                    v.customSpriteGenre != null &&
                    String(v.customSpriteGenre).trim()
                ) {
                    return String(v.customSpriteGenre).trim();
                }
                if (
                    v.baseSpriteGenre != null &&
                    String(v.baseSpriteGenre).trim()
                ) {
                    return String(v.baseSpriteGenre).trim();
                }
                if (v.genre != null && String(v.genre).trim()) {
                    return String(v.genre).trim();
                }
            }
        }
    } catch (_) {
        /* ignore */
    }
    if (pickerContext.modeGenre) return pickerContext.modeGenre;
    return fallback || 'rpg_fantasy';
}

/**
 * Infer catalog family for a field (art-set role context, else schema fallback).
 * @param {any} editor
 * @param {string} [fallback]
 * @returns {string}
 */
function resolveAssetKind(editor, fallback) {
    return resolvePickerContext(
        editor,
        editor && editor.path,
        fallback
    ).assetKind;
}

/**
 * Infer equipment slot from json-editor path (e.g. root.equipment.head).
 * @param {string} path
 * @returns {string}
 */
function inferSlotFromPath(path) {
    const p = String(path || '').toLowerCase();
    if (p.endsWith('.head')) return 'helmet';
    if (p.endsWith('.chest')) return 'armor';
    if (p.endsWith('.legs')) return 'legs';
    if (p.endsWith('.boots')) return 'boots';
    if (p.endsWith('.weapon')) return 'rightHand';
    if (p.endsWith('.shield')) return 'leftHand';
    if (p.endsWith('.amulet')) return 'amulet';
    if (p.endsWith('.ring')) return 'ring';
    if (p.endsWith('.backpack')) return 'backpack';
    return '';
}

/**
 * Normalize catalog asset field config from schema + format alias.
 * @param {object|null|undefined} schema
 * @returns {{
 *   assetKind: string,
 *   previewVariant: string,
 *   genre?: string,
 *   showCategoryFilter: boolean,
 *   inferCategoryFromPath: boolean,
 *   selectLabel: string
 * }}
 */
function catalogAssetConfig(schema) {
    const s = schema && typeof schema === 'object' ? schema : {};
    const opt =
        s.options && typeof s.options === 'object' && !Array.isArray(s.options)
            ? s.options
            : {};
    const format = String(s.format || '');

    let assetKind = String(opt.assetKind || s.assetKind || '').trim();
    if (!assetKind) {
        if (format === 'tile_id') assetKind = 'tiles';
        else if (format === 'creature_sprite_id') assetKind = 'creatures';
        else if (format === 'creature_id') assetKind = 'creatures';
        else if (format === 'equipment_id') assetKind = 'equipment';
        else assetKind = 'tiles';
    }

    const previewVariant = String(
        opt.previewVariant || s.previewVariant || 'alpha'
    ).trim() || 'alpha';

    const genreRaw = opt.genre != null ? opt.genre : s.genre;
    const genre =
        genreRaw != null && String(genreRaw).trim()
            ? String(genreRaw).trim()
            : undefined;

    const showCategoryFilter =
        opt.showCategoryFilter != null
            ? !!opt.showCategoryFilter
            : assetKind === 'tiles';

    const inferCategory =
        opt.inferCategoryFromPath != null
            ? !!opt.inferCategoryFromPath
            : assetKind === 'tiles';

    let selectLabel = String(opt.selectLabel || '').trim();
    if (!selectLabel) {
        if (format === 'creature_id') selectLabel = 'Select creature';
        else if (format === 'equipment_id') selectLabel = 'Select equipment';
        else if (assetKind === 'tiles') selectLabel = 'Browse tiles';
        else if (assetKind === 'creatures') selectLabel = 'Browse creature sprites';
        else if (assetKind === 'equipment') selectLabel = 'Browse equipment';
        else if (assetKind === 'ui') selectLabel = 'Browse UI art';
        else if (assetKind === 'objects') selectLabel = 'Browse objects';
        else if (assetKind === 'overlays') selectLabel = 'Browse overlays';
        else selectLabel = 'Browse catalog';
    }

    return {
        assetKind,
        previewVariant,
        genre,
        showCategoryFilter,
        inferCategoryFromPath: inferCategory,
        selectLabel
    };
}

/**
 * Open a named popup; reuses the window if still open.
 * @param {string} url
 * @param {string} name
 * @param {string} features
 * @returns {Window|null}
 */
function openPickerWindow(url, name, features) {
    let win = null;
    try {
        win = window.open(url, name, features);
        if (win && !win.closed) {
            try {
                win.location.href = url;
            } catch (_) {
                /* first open / still loading */
            }
        }
    } catch (err) {
        console.warn('relation picker popup failed', err);
        return null;
    }
    if (!win) {
        console.warn('relation picker blocked — allow popups for this site');
        return null;
    }
    try {
        win.focus();
    } catch (_) {
        /* ignore */
    }
    return win;
}

/**
 * @param {MessageEvent} ev
 */
function onMessage(ev) {
    if (ev.origin !== window.location.origin) return;
    const data = ev.data;
    if (!data || data.channel !== DESIGNER_PICKER_CHANNEL) return;

    const kind = data.kind;
    const type = data.type;
    const requestId = data.requestId != null ? String(data.requestId) : '';

    // ready: parent must send init (child may not know requestId yet)
    if (type === MSG.READY) {
        // Find the pending session for this kind whose window is the source
        for (const [rid, session] of pending.entries()) {
            if (session.kind !== kind) continue;
            if (session.win && !session.win.closed && ev.source === session.win) {
                try {
                    session.win.postMessage(
                        {
                            channel: DESIGNER_PICKER_CHANNEL,
                            type: PARENT_MSG.INIT,
                            kind,
                            requestId: rid,
                            ...session.initPayload
                        },
                        window.location.origin
                    );
                } catch (err) {
                    console.warn('picker init postMessage failed', err);
                }
                return;
            }
        }
        // Fallback: most recent pending of this kind
        let last = null;
        for (const [rid, session] of pending.entries()) {
            if (session.kind === kind) last = { rid, session };
        }
        if (last && last.session.win && !last.session.win.closed) {
            try {
                last.session.win.postMessage(
                    {
                        channel: DESIGNER_PICKER_CHANNEL,
                        type: PARENT_MSG.INIT,
                        kind,
                        requestId: last.rid,
                        ...last.session.initPayload
                    },
                    window.location.origin
                );
            } catch (err) {
                console.warn('picker init postMessage failed', err);
            }
        }
        return;
    }

    if (type === MSG.SELECT) {
        const session = requestId ? pending.get(requestId) : null;
        if (session && typeof session.apply === 'function') {
            session.apply(data.value);
        } else if (!requestId) {
            // Best-effort: apply to last matching kind
            for (const [, s] of [...pending.entries()].reverse()) {
                if (s.kind === kind && typeof s.apply === 'function') {
                    s.apply(data.value);
                    break;
                }
            }
        }
        if (requestId) pending.delete(requestId);
        return;
    }

    if (type === MSG.CANCEL || type === MSG.CLOSING) {
        if (requestId) pending.delete(requestId);
    }
}

function ensureListener() {
    if (listenerBound || typeof window === 'undefined') return;
    window.addEventListener('message', onMessage);
    listenerBound = true;
}

/**
 * @param {object} opts
 * @param {string} opts.kind 'tile' | 'shape' | catalog picker kind key
 * @param {string} opts.urlPath
 * @param {string} opts.windowName
 * @param {string} opts.features
 * @param {Record<string, unknown>} opts.initPayload
 * @param {(value: unknown) => void} opts.apply
 * @param {Record<string, string>} [opts.query]
 */
function openPickerSession(opts) {
    ensureListener();
    const requestId = nextRequestId();
    const params = new URLSearchParams({ requestId, ...(opts.query || {}) });
    const url = appUrl(opts.urlPath) + '?' + params.toString();
    const win = openPickerWindow(url, opts.windowName, opts.features);
    if (!win) return null;

    pending.set(requestId, {
        kind: opts.kind,
        apply: opts.apply,
        win,
        initPayload: opts.initPayload
    });

    // If child already loaded and posted ready before we registered, re-push shortly.
    setTimeout(() => {
        const session = pending.get(requestId);
        if (!session || !session.win || session.win.closed) return;
        try {
            session.win.postMessage(
                {
                    channel: DESIGNER_PICKER_CHANNEL,
                    type: PARENT_MSG.INIT,
                    kind: opts.kind,
                    requestId,
                    ...session.initPayload
                },
                window.location.origin
            );
        } catch (_) {
            /* ignore */
        }
    }, 400);

    return requestId;
}

/**
 * Open genre catalog picker (tiles / creatures / equipment / objects).
 * Same popup shell as the former tile-only picker; `assetKind` selects catalog.
 * @param {{
 *   genre?: string,
 *   assetKind?: string,
 *   currentId?: string,
 *   category?: string,
 *   slotFilter?: string,
 *   previewVariant?: string,
 *   showCategoryFilter?: boolean,
 *   categories?: string[],
 *   fieldPath?: string,
 *   title?: string,
 *   onSelect: (id: string, meta?: Record<string, unknown>) => void
 * }} opts
 */
function openCatalogAssetPicker(opts) {
    const genre = opts.genre || 'rpg_fantasy';
    const assetKind = opts.assetKind || 'tiles';
    const currentId = opts.currentId || '';
    const category = opts.category || '';
    const slotFilter = opts.slotFilter || '';
    const previewVariant = opts.previewVariant || 'alpha';
    const categories = Array.isArray(opts.categories)
        ? opts.categories.map((c) => String(c)).filter(Boolean)
        : catalogCategoriesForKind(assetKind);
    const showCategoryFilter =
        opts.showCategoryFilter != null
            ? !!opts.showCategoryFilter
            : assetKind === 'tiles' ||
              assetKind === 'objects' ||
              assetKind === 'overlays';
    // Window name is shared so one catalog browser is reused; navigation reloads params.
    const windowName =
        assetKind === 'tiles' ? TILE_PICKER_WINDOW : `du_catalog_${assetKind}`;
    return openPickerSession({
        kind: 'catalog',
        urlPath: TILE_PICKER_URL_PATH,
        windowName,
        features: popupFeatures(960, 720),
        query: {
            genre,
            kind: assetKind,
            id: currentId,
            category,
            categories: categories.join(','),
            slotFilter,
            previewVariant,
            showCategoryFilter: showCategoryFilter ? '1' : '0',
            fieldPath: opts.fieldPath || '',
            title: opts.title || ''
        },
        initPayload: {
            genre,
            assetKind,
            currentId,
            category,
            categories,
            slotFilter,
            previewVariant,
            showCategoryFilter,
            fieldPath: opts.fieldPath || '',
            title: opts.title || ''
        },
        apply: (value) => {
            if (!value || typeof value !== 'object') return;
            const id = /** @type {{id?: unknown}} */ (value).id;
            if (id == null || String(id) === '') return;
            opts.onSelect(String(id), /** @type {Record<string, unknown>} */ (value));
        }
    });
}

/**
 * Open equipment preset catalog picker (select mode of the shared browser).
 * Same UI as Wiki → Equipments (`uiMode=view`).
 * @param {{
 *   mode?: string,
 *   genre?: string,
 *   currentId?: string,
 *   slotFilter?: string,
 *   fieldPath?: string,
 *   title?: string,
 *   onSelect: (id: string, meta?: Record<string, unknown>) => void
 * }} opts
 */
function openEquipmentPicker(opts) {
    const mode = opts.mode || pickerContext.modeId || 'standard';
    const genre = opts.genre || pickerContext.modeGenre || 'rpg_fantasy';
    const currentId = opts.currentId || '';
    const slotFilter = opts.slotFilter || '';
    return openPickerSession({
        kind: 'equipment',
        urlPath: EQUIPMENT_PICKER_URL_PATH,
        windowName: EQUIPMENT_PICKER_WINDOW,
        features: popupFeatures(980, 720),
        query: {
            mode,
            genre,
            id: currentId,
            slotFilter,
            fieldPath: opts.fieldPath || '',
            title: opts.title || '',
            uiMode: 'select'
        },
        initPayload: {
            mode,
            genre,
            currentId,
            slotFilter,
            fieldPath: opts.fieldPath || '',
            title: opts.title || '',
            uiMode: 'select'
        },
        apply: (value) => {
            if (!value || typeof value !== 'object') return;
            const id = /** @type {{id?: unknown}} */ (value).id;
            if (id == null || String(id) === '') return;
            opts.onSelect(String(id), /** @type {Record<string, unknown>} */ (value));
        }
    });
}

/**
 * Open combat creature preset catalog picker (select mode of the shared browser).
 * Same UI as Wiki → Creatures (`uiMode=view`). Not the art-catalog sprite picker.
 * @param {{
 *   mode?: string,
 *   genre?: string,
 *   currentId?: string,
 *   fieldPath?: string,
 *   title?: string,
 *   onSelect: (id: string, meta?: Record<string, unknown>) => void
 * }} opts
 */
function openCreaturePicker(opts) {
    const mode = opts.mode || pickerContext.modeId || 'standard';
    const genre = opts.genre || pickerContext.modeGenre || 'rpg_fantasy';
    const currentId = opts.currentId || '';
    return openPickerSession({
        kind: 'creature',
        urlPath: CREATURE_PICKER_URL_PATH,
        windowName: CREATURE_PICKER_WINDOW,
        features: popupFeatures(980, 720),
        query: {
            mode,
            genre,
            id: currentId,
            fieldPath: opts.fieldPath || '',
            title: opts.title || 'Select creature',
            uiMode: 'select'
        },
        initPayload: {
            mode,
            genre,
            currentId,
            fieldPath: opts.fieldPath || '',
            title: opts.title || 'Select creature',
            uiMode: 'select'
        },
        apply: (value) => {
            if (!value || typeof value !== 'object') return;
            const id = /** @type {{id?: unknown}} */ (value).id;
            if (id == null || String(id) === '') return;
            opts.onSelect(String(id), /** @type {Record<string, unknown>} */ (value));
        }
    });
}

/**
 * Open tile catalog picker (compat wrapper).
 * @param {{
 *   genre?: string,
 *   currentId?: string,
 *   category?: string,
 *   fieldPath?: string,
 *   onSelect: (id: string, meta?: Record<string, unknown>) => void
 * }} opts
 */
function openTilePicker(opts) {
    return openCatalogAssetPicker({
        genre: opts.genre,
        assetKind: 'tiles',
        currentId: opts.currentId,
        category: opts.category,
        previewVariant: 'alpha',
        showCategoryFilter: true,
        fieldPath: opts.fieldPath,
        title: 'Select tile',
        onSelect: opts.onSelect
    });
}

/**
 * Open spell shape picker.
 * @param {{
 *   current?: Record<string, unknown>|null,
 *   fieldPath?: string,
 *   onSelect: (shape: Record<string, unknown>) => void
 * }} opts
 */
function openShapePicker(opts) {
    const catalog = listShapeCatalog();
    const current = opts.current || null;
    const currentId = current ? catalogIdForShape(current) : null;
    return openPickerSession({
        kind: 'shape',
        urlPath: SHAPE_PICKER_URL_PATH,
        windowName: SHAPE_PICKER_WINDOW,
        features: popupFeatures(900, 640),
        query: {
            fieldPath: opts.fieldPath || ''
        },
        initPayload: {
            catalog,
            current,
            currentId: currentId || '',
            fieldPath: opts.fieldPath || ''
        },
        apply: (value) => {
            if (!value || typeof value !== 'object') return;
            const shape = /** @type {{shape?: unknown}} */ (value).shape;
            if (!shape || typeof shape !== 'object') return;
            opts.onSelect(/** @type {Record<string, unknown>} */ (shape));
        }
    });
}

/**
 * Register custom json-editor editors (safe to call multiple times).
 * @returns {boolean}
 */
function registerRelationPickers() {
    if (typeof window === 'undefined' || typeof window.JSONEditor !== 'function') {
        return false;
    }
    if (window.__DU_RELATION_PICKERS_REGISTERED__) return true;

    ensureListener();

    const JE = window.JSONEditor;
    const Abstract = JE.AbstractEditor;

    /**
     * Reusable string field: [alpha thumb | id input + Select catalog].
     * Driven by schema format aliases + options.assetKind / previewVariant.
     */
    class CatalogAssetIdEditor extends Abstract {
        build() {
            this.cfg = catalogAssetConfig(this.schema);

            this.title = this.header = this.label = this.theme.getFormInputLabel(
                this.getTitle()
            );
            const format = String((this.schema && this.schema.format) || '');
            let defaultDesc = 'Genre catalog id. Use Select to browse assets.';
            if (format === 'creature_id') {
                defaultDesc =
                    'Combat creature template id. Use Select to browse the creature catalog.';
            } else if (format === 'creature_sprite_id' || this.cfg.assetKind === 'creatures') {
                defaultDesc =
                    'Catalog sprite id. Use Select to browse creature art (for templates without a matching sprite under their own id).';
            } else if (format === 'equipment_id') {
                defaultDesc =
                    'Equipment catalog id. Use Select to browse equipment.';
            }
            this.description = this.theme.getFormInputDescription(
                this.schema.description || defaultDesc
            );

            // Outer row: thumb | controls
            this.row = document.createElement('div');
            this.row.className = 'du-asset-id-field';

            this.thumbWrap = document.createElement('div');
            this.thumbWrap.className = 'du-asset-id-thumb';
            this.thumbWrap.setAttribute('aria-hidden', 'true');
            this.thumbImg = document.createElement('img');
            this.thumbImg.alt = '';
            this.thumbImg.decoding = 'async';
            this.thumbImg.hidden = true;
            this.thumbMissing = document.createElement('span');
            this.thumbMissing.className = 'du-asset-id-thumb-missing';
            this.thumbMissing.textContent = '—';
            this.thumbWrap.appendChild(this.thumbImg);
            this.thumbWrap.appendChild(this.thumbMissing);

            this.control = document.createElement('div');
            this.control.className = 'du-rel-field du-asset-id-controls';

            this.input = this.theme.getFormInputField('text');
            this.input.classList.add('form-control', 'font-monospace');
            this.input.setAttribute('spellcheck', 'false');
            this.input.setAttribute('autocomplete', 'off');

            this.selectBtn = document.createElement('button');
            this.selectBtn.type = 'button';
            this.selectBtn.className =
                'btn btn-sm btn-retro btn-retro-secondary du-rel-select-btn';
            {
                const format = String((this.schema && this.schema.format) || '');
                let icon = 'fa-image';
                if (format === 'creature_id') icon = 'fa-dragon';
                else if (format === 'equipment_id') icon = 'fa-shield-halved';
                this.selectBtn.innerHTML =
                    `<i class="fa-solid ${icon}"></i> Select`;
            }
            this.selectBtn.title = this.cfg.selectLabel;

            const inputWrap = document.createElement('div');
            inputWrap.className = 'du-rel-field-input';
            inputWrap.appendChild(this.input);
            this.control.appendChild(inputWrap);
            this.control.appendChild(this.selectBtn);

            this.row.appendChild(this.thumbWrap);
            this.row.appendChild(this.control);

            this.container.appendChild(this.header);
            if (this.description) this.container.appendChild(this.description);
            this.container.appendChild(this.row);

            this.input.addEventListener('change', () => {
                this.value = this.input.value;
                this.refreshThumb();
                this.onChange(true);
            });
            this.input.addEventListener('input', () => {
                this.value = this.input.value;
                this.refreshThumb();
                this.onChange(true);
            });
            this.selectBtn.addEventListener('click', () => {
                if (this.disabled) return;
                this.openPicker();
            });

            this.thumbImg.addEventListener('error', () => {
                if (this._tryOriginalThumb()) return;
                this.showThumbMissing();
            });
            this.thumbImg.addEventListener('load', () => {
                if (this.thumbImg && this.thumbImg.src) {
                    this.thumbImg.hidden = false;
                    if (this.thumbMissing) this.thumbMissing.hidden = true;
                }
            });

            // Re-resolve thumb when sibling genre fields change
            // (genre / customSpriteGenre / baseSpriteGenre).
            if (this.jsoneditor && typeof this.jsoneditor.on === 'function') {
                this._onRootChange = () => {
                    if (this.input) this.refreshThumb();
                };
                this.jsoneditor.on('change', this._onRootChange);
            }
        }

        /**
         * @returns {string}
         */
        currentGenre() {
            return resolveGenre(this, 'rpg_fantasy', this.cfg && this.cfg.genre);
        }

        currentAssetKind() {
            return this.pickerContext().assetKind;
        }

        pickerContext() {
            return resolvePickerContext(
                this,
                this.path || '',
                (this.cfg && this.cfg.assetKind) || 'tiles'
            );
        }

        refreshSelectChrome() {
            if (!this.selectBtn) return;
            const format = String((this.schema && this.schema.format) || '');
            const kind = this.currentAssetKind();
            let icon = 'fa-image';
            let title = (this.cfg && this.cfg.selectLabel) || 'Browse catalog';
            if (format === 'creature_id') {
                icon = 'fa-dragon';
            } else if (format === 'equipment_id') {
                icon = 'fa-shield-halved';
            } else if (kind === 'objects') {
                icon = 'fa-tree';
                title = 'Browse objects';
            } else if (kind === 'overlays') {
                icon = 'fa-layer-group';
                title = 'Browse overlays';
            } else if (kind === 'ui') {
                icon = 'fa-icons';
                title = (this.cfg && this.cfg.selectLabel) || 'Browse UI art';
            } else if (kind === 'tiles') {
                icon = 'fa-border-all';
                title = 'Browse tiles';
            }
            this.selectBtn.innerHTML = `<i class="fa-solid ${icon}"></i> Select`;
            this.selectBtn.title = title;
        }

        openPicker() {
            const path = this.path || '';
            const ctx = this.pickerContext();
            const assetKind = ctx.assetKind;
            const category =
                this.cfg.inferCategoryFromPath !== false ? ctx.category : '';
            const slotFilter =
                assetKind === 'equipment' ? inferSlotFromPath(path) : '';
            const genre = this.currentGenre();
            const showCategoryFilter =
                this.cfg.showCategoryFilter != null
                    ? !!this.cfg.showCategoryFilter
                    : assetKind === 'tiles' ||
                      assetKind === 'objects' ||
                      assetKind === 'overlays';
            const title =
                assetKind === 'objects'
                    ? 'Select object'
                    : assetKind === 'overlays'
                      ? 'Select overlay'
                      : assetKind === 'tiles'
                        ? 'Select tile'
                        : this.cfg.selectLabel;
            openCatalogAssetPicker({
                genre,
                assetKind,
                currentId: String(this.value || ''),
                category,
                categories: catalogCategoriesForKind(assetKind),
                slotFilter,
                previewVariant: this.cfg.previewVariant,
                showCategoryFilter,
                fieldPath: path,
                title,
                onSelect: (id, meta) => {
                    if (/\.roles\./.test(path)) {
                        const fields = artSetPickFields(id, meta);
                        this.setValue(fields.id);
                        setSiblingField(this, 'kind', fields.kind);
                        setSiblingField(this, 'wangFamily', fields.wangFamily);
                        setSiblingField(this, 'wallFamily', fields.wallFamily);
                        setSiblingField(this, 'wallAlign', fields.wallAlign);
                    } else {
                        this.setValue(id);
                    }
                    this.onChange(true);
                }
            });
        }

        showThumbMissing() {
            if (this.thumbImg) {
                this.thumbImg.hidden = true;
                this.thumbImg.removeAttribute('src');
            }
            if (this.thumbMissing) {
                this.thumbMissing.hidden = false;
                this.thumbMissing.textContent = this.value ? 'no img' : '—';
            }
        }

        /**
         * original_only catalog items (e.g. simple_dead_tree) have no alpha.
         * @returns {boolean}
         */
        _tryOriginalThumb() {
            if (this._thumbTriedOriginal || !this.thumbImg) return false;
            const id = String(this.value || '').trim();
            if (!id) return false;
            const orig = resolveSpriteUrl({
                genre: this.currentGenre(),
                kind: this.currentAssetKind(),
                id,
                variant: 'original'
            });
            if (!orig || orig === this.thumbImg.src) return false;
            this._thumbTriedOriginal = true;
            this.thumbImg.src = orig;
            return true;
        }

        refreshThumb() {
            if (!this.thumbWrap) return;
            this.refreshSelectChrome();
            const id = String(this.value || '').trim();
            if (!id) {
                this.showThumbMissing();
                if (this.thumbMissing) this.thumbMissing.textContent = '—';
                return;
            }
            const preferred = this.cfg.previewVariant || 'alpha';
            const url = resolveSpriteUrl({
                genre: this.currentGenre(),
                kind: this.currentAssetKind(),
                id,
                variant: preferred
            });
            if (!url) {
                this.showThumbMissing();
                return;
            }
            this._thumbTriedOriginal = preferred === 'original';
            if (this.thumbMissing) {
                this.thumbMissing.hidden = false;
                this.thumbMissing.textContent = '…';
            }
            if (this.thumbImg) {
                // Force reload when id changes to the same URL stem with new stem
                this.thumbImg.hidden = true;
                this.thumbImg.src = url;
            }
        }

        enable() {
            if (!this.always_disabled) {
                this.input.disabled = false;
                this.selectBtn.disabled = false;
                super.enable();
            }
        }

        disable(alwaysDisabled) {
            if (alwaysDisabled) this.always_disabled = true;
            this.input.disabled = true;
            this.selectBtn.disabled = true;
            super.disable(alwaysDisabled);
        }

        setValue(value, initial) {
            this.value = value == null ? '' : String(value);
            if (this.input) this.input.value = this.value;
            this.refreshThumb();
            this.onChange(!initial);
        }

        getValue() {
            return this.input ? this.input.value : this.value || '';
        }

        destroy() {
            if (this.row) {
                this.row.innerHTML = '';
                this.row = null;
            }
            this.thumbWrap = null;
            this.thumbImg = null;
            this.thumbMissing = null;
            this.control = null;
            super.destroy();
        }
    }

    /**
     * Equipment ID field editor using dedicated equipment picker modal.
     */
    class EquipmentIdEditor extends CatalogAssetIdEditor {
        openPicker() {
            const path = this.path || '';
            const slotFilter = inferSlotFromPath(path);
            const genre = this.currentGenre();
            openEquipmentPicker({
                genre,
                currentId: String(this.value || ''),
                slotFilter,
                fieldPath: path,
                title: (this.cfg && this.cfg.selectLabel) || 'Select Equipment',
                onSelect: (id) => {
                    this.setValue(id);
                    this.onChange(true);
                }
            });
        }
    }

    /**
     * Combat creature template ID — shared browser with Wiki → Creatures
     * (select mode). Not the art catalog (creature_sprite_id).
     */
    class CreatureIdEditor extends CatalogAssetIdEditor {
        openPicker() {
            const path = this.path || '';
            openCreaturePicker({
                currentId: String(this.value || ''),
                fieldPath: path,
                title: (this.cfg && this.cfg.selectLabel) || 'Select creature',
                onSelect: (id) => {
                    this.setValue(id);
                    this.onChange(true);
                }
            });
        }
    }

    /**
     * Object field for spell.shape with summary + Select popup.
     */
    class SpellShapeEditor extends Abstract {
        build() {
            this.title = this.header = this.label = this.theme.getFormInputLabel(
                this.getTitle()
            );
            this.description = this.theme.getFormInputDescription(
                this.schema.description ||
                    'AoE / wave shape. Select opens a catalog with matrix preview (area code or wave spread×length).'
            );

            this.root = document.createElement('div');
            this.root.className = 'du-shape-field';

            this.summary = document.createElement('code');
            this.summary.className = 'du-shape-summary';
            this.summary.textContent = '—';

            this.selectBtn = document.createElement('button');
            this.selectBtn.type = 'button';
            this.selectBtn.className =
                'btn btn-sm btn-retro btn-retro-secondary du-rel-select-btn';
            this.selectBtn.innerHTML =
                '<i class="fa-solid fa-draw-polygon"></i> Select';
            this.selectBtn.title = 'Browse spell shapes';

            this.clearBtn = document.createElement('button');
            this.clearBtn.type = 'button';
            this.clearBtn.className = 'btn btn-sm btn-outline-secondary du-rel-clear-btn';
            this.clearBtn.textContent = 'Clear';
            this.clearBtn.title = 'Remove shape';

            const row = document.createElement('div');
            row.className = 'du-shape-field-row';
            row.appendChild(this.summary);
            row.appendChild(this.selectBtn);
            row.appendChild(this.clearBtn);
            this.root.appendChild(row);

            this.container.appendChild(this.header);
            if (this.description) this.container.appendChild(this.description);
            this.container.appendChild(this.root);

            this.value = null;

            this.selectBtn.addEventListener('click', () => {
                if (this.disabled) return;
                openShapePicker({
                    current:
                        this.value && typeof this.value === 'object'
                            ? /** @type {Record<string, unknown>} */ (this.value)
                            : null,
                    fieldPath: this.path || '',
                    onSelect: (shape) => {
                        this.setValue(shape);
                        this.onChange(true);
                    }
                });
            });
            this.clearBtn.addEventListener('click', () => {
                if (this.disabled) return;
                this.setValue(undefined);
                this.onChange(true);
            });
        }

        refreshSummary() {
            if (!this.summary) return;
            this.summary.textContent = formatShapeSummary(this.value);
        }

        enable() {
            if (!this.always_disabled) {
                this.selectBtn.disabled = false;
                this.clearBtn.disabled = false;
                super.enable();
            }
        }

        disable(alwaysDisabled) {
            if (alwaysDisabled) this.always_disabled = true;
            this.selectBtn.disabled = true;
            this.clearBtn.disabled = true;
            super.disable(alwaysDisabled);
        }

        setValue(value, initial) {
            if (
                value == null ||
                value === '' ||
                (typeof value === 'object' && !Object.keys(value).length)
            ) {
                this.value = undefined;
            } else if (typeof value === 'object') {
                this.value = JSON.parse(JSON.stringify(value));
            } else {
                this.value = undefined;
            }
            this.refreshSummary();
            this.onChange(!initial);
        }

        getValue() {
            if (this.value == null) return undefined;
            return JSON.parse(JSON.stringify(this.value));
        }

        destroy() {
            if (this.root) {
                this.root.innerHTML = '';
                this.root = null;
            }
            super.destroy();
        }
    }

    // One editor class; format aliases all resolve here.
    JE.defaults.editors.catalog_asset_id = CatalogAssetIdEditor;
    JE.defaults.editors.tile_id = CatalogAssetIdEditor;
    JE.defaults.editors.creature_sprite_id = CatalogAssetIdEditor;
    JE.defaults.editors.creature_id = CreatureIdEditor;
    JE.defaults.editors.equipment_id = EquipmentIdEditor;
    JE.defaults.editors.spell_shape = SpellShapeEditor;

    JE.defaults.resolvers.unshift((schema) => {
        if (!schema || typeof schema !== 'object') return;
        if (schema.format === 'catalog_asset_id') return 'catalog_asset_id';
        if (schema.format === 'tile_id') return 'tile_id';
        if (schema.format === 'creature_sprite_id') return 'creature_sprite_id';
        if (schema.format === 'creature_id') return 'creature_id';
        if (schema.format === 'equipment_id') return 'equipment_id';
        if (schema.format === 'spell_shape') return 'spell_shape';
    });

    window.__DU_RELATION_PICKERS_REGISTERED__ = true;
    return true;
}

module.exports = {
    registerRelationPickers,
    setRelationPickerContext,
    getRelationPickerContext,
    openCatalogAssetPicker,
    openEquipmentPicker,
    openCreaturePicker,
    openTilePicker,
    openShapePicker,
    catalogAssetConfig,
    inferCategoryFromPath,
    inferSlotFromPath,
    resolveGenre,
    resolveAssetKind,
    resolvePickerContext
};
