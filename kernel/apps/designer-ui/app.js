/**
 * Designer Rule UI — Phase 2–5: catalog, folder, piece-pack CRUD,
 * soft refs, kernel validate, and relation Select pickers
 * (catalog asset id + thumb, spell shape).
 * Form: @json-editor/json-editor (CDN) + dungeon_piece + dungeon_profile
 * + catalog_asset_id aliases.
 * Writes via php/api.php presets_*.
 */

'use strict';

const { appUrl } = require('../../core/lib/app_paths.js');
const {
    setPreferredContentModeId,
    resolvePreferredContentModeId
} = require('../../core/lib/ui_preferences.js');
const { prettyJson } = require('../../core/lib/json_format.js');
const { registerPieceGridEditor } = require('./piece_grid_editor.js');
const { registerDungeonProfileEditor } = require('./dungeon_profile_editor.js');
const {
    registerRelationPickers,
    setRelationPickerContext
} = require('./relation_pickers.js');
const { preserveLiveEntity } = require('./live_value_preserve.js');
const { patchJsonEditorNumberStartval } = require('./json_editor_number_startval.js');

const ID_RE = /^[a-z][a-z0-9_]{0,79}$/;

/** Page size for kinds that paginate (creatures). */
const PAGE_SIZE = 100;

/**
 * @typedef {{
 *   label: string,
 *   shape: 'catalog'|'folder'|'nested_pack',
 *   group: 'combat'|'dungeon',
 *   schemaFile: string,
 *   defKey: string|null,
 *   pathFile?: string,
 *   dir?: string,
 *   icon: string,
 *   paginate?: boolean,
 *   canValidate?: boolean
 * }} KindMeta
 */

/** @type {Record<string, KindMeta>} */
const KIND_META = {
    spells: {
        label: 'Spells',
        shape: 'catalog',
        group: 'combat',
        schemaFile: 'spells.schema.json',
        defKey: 'spell',
        pathFile: 'spells.json',
        icon: 'fa-wand-magic-sparkles'
    },
    classes: {
        label: 'Classes',
        shape: 'catalog',
        group: 'combat',
        schemaFile: 'classes.schema.json',
        defKey: 'classDef',
        pathFile: 'classes.json',
        icon: 'fa-shield-halved'
    },
    equipment: {
        label: 'Equipment',
        shape: 'catalog',
        group: 'combat',
        schemaFile: 'equipment.schema.json',
        defKey: 'equipmentItem',
        pathFile: 'equipment.json',
        icon: 'fa-gavel'
    },
    strategies: {
        label: 'Strategies',
        shape: 'catalog',
        group: 'combat',
        schemaFile: 'strategies.schema.json',
        defKey: 'strategy',
        pathFile: 'strategies.json',
        icon: 'fa-brain'
    },
    creatures: {
        label: 'Creatures',
        shape: 'folder',
        group: 'combat',
        schemaFile: 'creatures.schema.json',
        defKey: null,
        dir: 'creatures',
        icon: 'fa-dragon',
        paginate: true
    },
    player_profiles: {
        label: 'Base Profiles',
        shape: 'folder',
        group: 'combat',
        schemaFile: 'player_profiles.schema.json',
        defKey: null,
        dir: 'player_profiles',
        icon: 'fa-user-gear'
    },
    parties: {
        label: 'Parties',
        shape: 'folder',
        group: 'combat',
        schemaFile: 'parties.schema.json',
        defKey: null,
        dir: 'parties',
        icon: 'fa-users-gear'
    },
    biomes: {
        label: 'Biomes',
        shape: 'folder',
        group: 'dungeon',
        schemaFile: 'biomes.schema.json',
        defKey: null,
        dir: 'biomes',
        icon: 'fa-mountain',
        canValidate: true
    },
    art_sets: {
        label: 'Art sets',
        shape: 'folder',
        group: 'dungeon',
        schemaFile: 'art_sets.schema.json',
        defKey: null,
        dir: 'art_sets',
        icon: 'fa-palette'
    },
    dungeons: {
        label: 'Dungeons',
        shape: 'folder',
        group: 'dungeon',
        schemaFile: 'dungeons.schema.json',
        defKey: null,
        dir: 'dungeons',
        icon: 'fa-dungeon',
        canValidate: true
    },
    populations: {
        label: 'Populations',
        shape: 'folder',
        group: 'dungeon',
        schemaFile: 'populations.schema.json',
        defKey: null,
        dir: 'populations',
        icon: 'fa-users'
    },
    markers: {
        label: 'Markers',
        shape: 'folder',
        group: 'dungeon',
        schemaFile: 'markers.schema.json',
        defKey: null,
        dir: 'markers',
        icon: 'fa-map-pin'
    },
    pieces: {
        label: 'Piece packs',
        shape: 'nested_pack',
        group: 'dungeon',
        schemaFile: 'pieces.schema.json',
        defKey: null,
        dir: 'pieces',
        icon: 'fa-border-all',
        canValidate: true
    }
};

const KIND_GROUPS = [
    { id: 'combat', label: 'Combat' },
    { id: 'dungeon', label: 'Dungeon generator' }
];

/**
 * Relation enums injected into forms (kind → property path → presets_ids kind).
 * Nested paths use dots (e.g. profiles.procedural).
 * Optional filterField + filterValue narrow the presets_ids query for catalog
 * kinds (e.g. equipment filtered by slot).
 * @type {Record<string, Array<{ path: string, idsKind: string, arrayItems?: boolean, filterField?: string, filterValue?: string }>>}
 */
const RELATION_FIELDS = {
    spells: [
        { path: 'vocations', idsKind: 'classes', arrayItems: true }
    ],
    classes: [
        { path: 'spells', idsKind: 'spells', arrayItems: true },
        { path: 'autoAttack', idsKind: 'spells' }
    ],
    strategies: [
        { path: 'healSpellId', idsKind: 'spells' },
        { path: 'spellPriority', idsKind: 'spells', arrayItems: true }
    ],
    // Creatures: offense is attacks[]; stand-off is flags.targetDistance.
    // No autoAttack / atk / skill relation fields on monster templates.
    creatures: [],
    player_profiles: [
        { path: 'vocation', idsKind: 'classes' },
        { path: 'strategyId', idsKind: 'strategies' },
        { path: 'equipment.head', idsKind: 'equipment', filterField: 'slot', filterValue: 'helmet' },
        { path: 'equipment.chest', idsKind: 'equipment', filterField: 'slot', filterValue: 'armor' },
        { path: 'equipment.legs', idsKind: 'equipment', filterField: 'slot', filterValue: 'legs' },
        { path: 'equipment.boots', idsKind: 'equipment', filterField: 'slot', filterValue: 'boots' },
        { path: 'equipment.weapon', idsKind: 'equipment', filterField: 'slot', filterValue: 'rightHand' },
        { path: 'equipment.shield', idsKind: 'equipment', filterField: 'slot', filterValue: 'leftHand' },
        { path: 'equipment.amulet', idsKind: 'equipment', filterField: 'slot', filterValue: 'amulet' },
        { path: 'equipment.ring', idsKind: 'equipment', filterField: 'slot', filterValue: 'ring' },
        { path: 'equipment.backpack', idsKind: 'equipment', filterField: 'slot', filterValue: 'backpack' }
    ],
    parties: [
        { path: 'members.profileId', idsKind: 'player_profiles' },
        { path: 'members.vocation', idsKind: 'classes' },
        { path: 'members.strategyId', idsKind: 'strategies' }
    ],
    biomes: [
        { path: 'piecePack', idsKind: 'pieces' },
        { path: 'populationId', idsKind: 'populations' },
        { path: 'markersId', idsKind: 'markers' },
        { path: 'artSet', idsKind: 'art_sets' },
        { path: 'profiles.procedural', idsKind: 'dungeons', arrayItems: true },
        { path: 'profiles.fixed', idsKind: 'dungeons', arrayItems: true }
    ],
    dungeons: [
        { path: 'piecePack', idsKind: 'pieces' },
        { path: 'populationId', idsKind: 'populations' },
        { path: 'markersId', idsKind: 'markers' }
    ]
};

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
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @param {{ method?: string }} [opts]
 */
async function apiCall(action, params = {}, opts = {}) {
    const writeActions = new Set([
        'presets_save',
        'presets_rename',
        'presets_delete'
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
 * Deep-clone a JSON-compatible value.
 * @param {unknown} v
 * @returns {unknown}
 */
function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
}

/**
 * Resolve a dotted path on an object (creates intermediate objects).
 * @param {Record<string, unknown>} root
 * @param {string} path
 * @returns {{ parent: Record<string, unknown>, key: string }|null}
 */
function resolvePath(root, path) {
    const parts = path.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!cur[p] || typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
            cur[p] = {};
        }
        cur = /** @type {Record<string, unknown>} */ (cur[p]);
    }
    const key = parts[parts.length - 1];
    return { parent: cur, key };
}

/**
 * Safely read a value from a nested object/array given a JSONEditor error path (e.g. "root.equipment.head").
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown}
 */
function getValueByPath(obj, path) {
    if (!obj || typeof obj !== 'object') return undefined;
    const cleanPath = path.replace(/^root\./, '').replace(/^root$/, '');
    if (!cleanPath) return obj;
    const parts = cleanPath.split('.');
    let curr = obj;
    for (const p of parts) {
        if (curr && typeof curr === 'object' && p in curr) {
            curr = /** @type {Record<string, unknown>} */ (curr)[p];
        } else {
            return undefined;
        }
    }
    return curr;
}

/** Shown under form + header id: save never renames. */
const ENTITY_ID_DESCRIPTION =
    'Snake_case entity id (file stem or catalog row). ' +
    'To change id on a saved entity, use toolbar Rename (updates soft refs) — Save does not rename.';

/**
 * Ensure top-level properties.id has a description (json-editor description text).
 * Expands $ref so draft-07 does not drop sibling description keywords.
 * @param {Record<string, unknown>} schema
 * @returns {Record<string, unknown>}
 */
function annotateEntityIdDescription(schema) {
    const out = /** @type {Record<string, unknown>} */ (cloneJson(schema));
    const props = /** @type {Record<string, unknown>|undefined} */ (
        out.properties
    );
    if (!props || typeof props !== 'object') return out;

    const idProp = props.id;
    if (!idProp || typeof idProp !== 'object') {
        props.id = {
            type: 'string',
            description: ENTITY_ID_DESCRIPTION
        };
        return out;
    }

    const idObj = /** @type {Record<string, unknown>} */ (cloneJson(idProp));
    if (
        typeof idObj.$ref === 'string' &&
        idObj.$ref === '#/definitions/entityId'
    ) {
        const defs = /** @type {Record<string, unknown>} */ (
            out.definitions || {}
        );
        const entityIdDef = defs.entityId;
        if (entityIdDef && typeof entityIdDef === 'object') {
            props.id = {
                .../** @type {object} */ (cloneJson(entityIdDef)),
                description: ENTITY_ID_DESCRIPTION
            };
            return out;
        }
    }
    idObj.description = ENTITY_ID_DESCRIPTION;
    props.id = idObj;
    return out;
}

/**
 * Build a single-entity schema from a catalog document schema, or pass through folder schemas.
 * @param {Record<string, unknown>} schemaDoc
 * @param {string|null} defKey
 * @returns {Record<string, unknown>}
 */
function entitySchemaFromDoc(schemaDoc, defKey) {
    if (!defKey) {
        // Folder entity schema is already the entity shape.
        return annotateEntityIdDescription(
            /** @type {Record<string, unknown>} */ (cloneJson(schemaDoc))
        );
    }
    const defs = /** @type {Record<string, unknown>} */ (
        schemaDoc.definitions || {}
    );
    const def = defs[defKey];
    if (!def || typeof def !== 'object') {
        return annotateEntityIdDescription({
            type: 'object',
            additionalProperties: true,
            properties: {
                id: { type: 'string' },
                label: { type: 'string' }
            },
            required: ['id']
        });
    }
    return annotateEntityIdDescription({
        $schema: 'http://json-schema.org/draft-07/schema#',
        title: String(/** @type {{ title?: string }} */ (def).title || defKey),
        definitions: cloneJson(defs),
        .../** @type {object} */ (cloneJson(def))
    });
}

/**
 * Inject enum lists for relation fields on a cloned entity schema.
 * @param {Record<string, unknown>} schema
 * @param {Array<{ path: string, idsKind: string, arrayItems?: boolean }>} fields
 * @param {Record<string, string[]>} idsByKind
 * @returns {Record<string, unknown>}
 */
function injectRelationEnums(schema, fields, idsByKind) {
    const out = /** @type {Record<string, unknown>} */ (cloneJson(schema));
    const props = /** @type {Record<string, unknown>} */ (out.properties || {});
    out.properties = props;

    for (const field of fields) {
        const ids = idsByKind[field.idsKind];
        if (!ids || ids.length === 0) continue;

        const resolved = resolvePath(
            /** @type {Record<string, unknown>} */ ({ properties: props }),
            'properties.' + field.path
        );
        if (!resolved) continue;

        // Work on schema properties tree: path is relative to entity properties.
        const parts = field.path.split('.');
        let parent = props;
        for (let i = 0; i < parts.length - 1; i++) {
            const p = parts[i];
            let node = parent[p];
            if (!node || typeof node !== 'object') {
                node = { type: 'object', properties: {} };
                parent[p] = node;
            }
            const n = /** @type {Record<string, unknown>} */ (node);
            if (n.type === 'array' || n.items) {
                if (!n.items || typeof n.items !== 'object') {
                    n.items = { type: 'object', properties: {} };
                }
                const itemsObj = /** @type {Record<string, unknown>} */ (n.items);
                if (!itemsObj.properties || typeof itemsObj.properties !== 'object') {
                    itemsObj.properties = {};
                }
                parent = /** @type {Record<string, unknown>} */ (itemsObj.properties);
            } else {
                if (!n.properties || typeof n.properties !== 'object') {
                    n.properties = {};
                }
                parent = /** @type {Record<string, unknown>} */ (n.properties);
            }
        }
        const key = parts[parts.length - 1];
        let node = parent[key];
        if (!node || typeof node !== 'object') {
            node = { type: field.arrayItems ? 'array' : 'string' };
            parent[key] = node;
        }
        const n = /** @type {Record<string, unknown>} */ (node);
        if (field.arrayItems) {
            let items = n.items;
            if (!items || typeof items !== 'object') {
                items = { type: 'string' };
                n.items = items;
            }
            const it = /** @type {Record<string, unknown>} */ (items);
            it.enum = ids.slice();
            it.type = 'string';
        } else {
            // Optional relation selects must keep "" so a no-op Save cannot
            // coerce an empty profile slot into the first catalog id.
            const nonempty = ids.filter((id) => id !== '');
            n.enum = [''].concat(nonempty);
            n.type = 'string';
            if (n.default === undefined) n.default = '';
        }
    }
    return out;
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
    const el = document.getElementById('duError');
    if (!el) return;
    if (!msg) {
        el.hidden = true;
        el.textContent = '';
        return;
    }
    el.hidden = false;
    el.textContent = msg;
}

/**
 * @returns {Promise<void>}
 */
async function initDesignerUiApp() {
    /** Parse initial URL parameters */
    const initialParams =
        typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
    const urlMode = initialParams.get('mode');
    const urlKind = initialParams.get('kind');
    const urlId = initialParams.get('id');

    /** @type {{ id: string, label: string, isDefault?: boolean, genre?: string }[]} */
    let modes =
        typeof window !== 'undefined' && Array.isArray(window.__MODES__)
            ? window.__MODES__.slice()
            : [];

    /** @type {string} */
    let modeId = resolvePreferredContentModeId({
        fallback:
            urlMode ||
            (typeof window !== 'undefined' && window.__CONTENT_MODE__
                ? String(window.__CONTENT_MODE__)
                : 'standard'),
        defaultId: 'standard'
    });

    /**
     * Genre for catalog asset thumbs / pickers when the entity has no genre.
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

    /**
     * Sync state (modeId, kind, loadedId) to URL query params using replaceState or pushState.
     * @param {{ replace?: boolean }} [opts]
     */
    function updateUrlParams(opts = {}) {
        if (typeof window === 'undefined' || !window.history) return;
        const replace = opts.replace !== false;
        const url = new URL(window.location.href);

        if (modeId) {
            url.searchParams.set('mode', modeId);
        } else {
            url.searchParams.delete('mode');
        }

        if (kind) {
            url.searchParams.set('kind', kind);
        } else {
            url.searchParams.delete('kind');
        }

        if (loadedId && !isNew) {
            url.searchParams.set('id', loadedId);
        } else {
            url.searchParams.delete('id');
        }

        const newSearch = url.searchParams.toString();
        const newUrl = url.pathname + (newSearch ? '?' + newSearch : '') + url.hash;
        const currentUrl = window.location.pathname + window.location.search + window.location.hash;

        if (newUrl !== currentUrl) {
            if (replace) {
                window.history.replaceState({ mode: modeId, kind, id: loadedId && !isNew ? loadedId : null }, '', newUrl);
            } else {
                window.history.pushState({ mode: modeId, kind, id: loadedId && !isNew ? loadedId : null }, '', newUrl);
            }
        }
    }

    /** @type {string} */
    let kind = urlKind && KIND_META[urlKind] ? urlKind : 'spells';

    /** @type {Array<Record<string, unknown>>} */
    let items = [];

    /** @type {number} */
    let listTotal = 0;

    /** @type {number} */
    let listOffset = 0;

    /** @type {number|null} */
    let listLimit = null;

    /** @type {string|null} */
    let loadedId = null;

    /**
     * Last committed entity (disk load, Raw→Form, or post-save remount).
     * Form getValue() is reconciled against this so hidden dependency keys
     * and invented enum / tuple defaults cannot change combat on Save.
     * @type {object|null}
     */
    let loadedEntity = null;

    /** @type {boolean} */
    let isNew = false;

    /** @type {boolean} */
    let dirty = false;

    /** @type {boolean} */
    let suppressDirty = false;

    /**
     * Stable JSON snapshot of the last clean editor state (id + entity).
     * @type {string|null}
     */
    let cleanSnapshot = null;

    /** @type {'form'|'raw'} */
    let viewMode = 'form';

    /** @type {Record<string, Record<string, unknown>>} */
    const schemaCache = {};

    /** @type {Record<string, string[]>} */
    const idsCache = {};

    /** @type {any} */
    let jsonEditor = null;

    /** Bumps on each mount so stale ready/change handlers no-op. */
    let editorGeneration = 0;

    const els = {
        modeSelect: /** @type {HTMLSelectElement|null} */ (
            document.getElementById('duModeSelect')
        ),
        kindNav: document.getElementById('duKindNav'),
        listTitle: document.getElementById('duListTitle'),
        filter: /** @type {HTMLInputElement|null} */ (
            document.getElementById('duFilter')
        ),
        list: document.getElementById('duEntityList'),
        pager: document.getElementById('duPager'),
        form: document.getElementById('duForm'),
        empty: document.getElementById('duEmpty'),
        id: /** @type {HTMLInputElement|null} */ (document.getElementById('duId')),
        idHint: document.getElementById('duIdHint'),
        editorHolder: document.getElementById('duEditorHolder'),
        json: /** @type {HTMLTextAreaElement|null} */ (
            document.getElementById('duJson')
        ),
        editingId: document.getElementById('duEditingId'),
        pathHint: document.getElementById('duPathHint'),
        saveHint: document.getElementById('duSaveHint'),
        dirtyBadge: document.getElementById('duDirtyBadge'),
        statusMeta: document.getElementById('duStatusMeta'),
        saveBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duSaveBtn')
        ),
        deleteBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duDeleteBtn')
        ),
        duplicateBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duDuplicateBtn')
        ),
        renameBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duRenameBtn')
        ),
        formatBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duFormatBtn')
        ),
        viewFormBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duViewFormBtn')
        ),
        viewRawBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duViewRawBtn')
        ),
        newBtn: document.getElementById('duNewBtn'),
        emptyNewBtn: document.getElementById('duEmptyNewBtn'),
        validateBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duValidateBtn')
        ),
        validateGroup: document.getElementById('duValidateGroup'),
        validateLevel: /** @type {HTMLSelectElement|null} */ (
            document.getElementById('duValidateLevel')
        ),
        validateReport: document.getElementById('duValidateReport'),
        refsStrip: document.getElementById('duRefsStrip'),
        huntEditorLink: /** @type {HTMLAnchorElement|null} */ (
            document.getElementById('duHuntEditorLink')
        ),
        previewProfileBtn: /** @type {HTMLButtonElement|null} */ (
            document.getElementById('duPreviewProfileBtn')
        )
    };

    /** @type {Window|null} */
    let profilePreviewWin = null;

    function updatePreviewProfileBtn() {
        const isProfile = kind === 'player_profiles';
        if (els.previewProfileBtn) {
            els.previewProfileBtn.hidden = !isProfile;
            els.previewProfileBtn.disabled = !isProfile || (!loadedId && !isNew);
        }
    }

    function getEntityForPreview() {
        if (viewMode === 'raw') {
            if (els.json && els.json.value) {
                try {
                    const parsed = JSON.parse(els.json.value);
                    if (parsed && typeof parsed === 'object') return parsed;
                } catch (_) {}
            }
        }
        if (jsonEditor) {
            try {
                let val = jsonEditor.getValue();
                if (loadedEntity) val = preserveLiveEntity(loadedEntity, val);
                if (val && typeof val === 'object') {
                    const cloned = JSON.parse(JSON.stringify(val));
                    if (!cloned.id && els.id) {
                        cloned.id = els.id.value.trim().toLowerCase() || loadedId || 'new_profile';
                    }
                    return cloned;
                }
            } catch (_) {}
        }
        try {
            return parseEditorBody().entity;
        } catch (_) {
            return { id: loadedId || 'new_profile' };
        }
    }

    function notifyProfilePreview() {
        if (kind !== 'player_profiles' || !profilePreviewWin || profilePreviewWin.closed) return;
        const entity = getEntityForPreview();
        try {
            profilePreviewWin.postMessage(
                {
                    type: 'PROFILE_PREVIEW_DATA',
                    mode: modeId,
                    profile: entity,
                    live: false,
                    source: 'designer'
                },
                window.location.origin
            );
        } catch (_) {}
    }

    function openProfilePreview() {
        if (kind !== 'player_profiles') return;
        const entity = getEntityForPreview();

        const url =
            appUrl('html/widgets/profile_preview/profile_preview.html') +
            '?mode=' +
            encodeURIComponent(modeId) +
            '&id=' +
            encodeURIComponent(entity.id || loadedId || '');

        // Shared window name with Hunt / Scenario Lab equipment Details
        const win = window.open(
            url,
            'hdl_profile_preview',
            'width=840,height=880,resizable=yes,scrollbars=yes'
        );
        if (win) {
            profilePreviewWin = win;
            try {
                win.focus();
            } catch (_) {}

            const sendData = () => {
                if (profilePreviewWin && !profilePreviewWin.closed) {
                    try {
                        profilePreviewWin.postMessage(
                            {
                                type: 'PROFILE_PREVIEW_DATA',
                                mode: modeId,
                                profile: entity,
                                live: false,
                                source: 'designer'
                            },
                            window.location.origin
                        );
                    } catch (_) {}
                }
            };
            setTimeout(sendData, 250);
            setTimeout(sendData, 700);
        }
    }

    function setDirty(v) {
        dirty = !!v;
        if (els.dirtyBadge) els.dirtyBadge.hidden = !dirty;
        if (els.saveBtn) els.saveBtn.disabled = !dirty && !isNew;
        if (!suppressDirty) notifyProfilePreview();
    }

    /**
     * @param {unknown} value
     * @returns {string}
     */
    function stableStringify(value) {
        return JSON.stringify(value);
    }

    /**
     * @returns {{ id: string, entity: object }}
     */
    function readUiSnapshot() {
        const id = els.id ? els.id.value.trim() : '';
        let entity;
        if (viewMode === 'raw') {
            if (!els.json) throw new Error('Editor not ready');
            entity = JSON.parse(els.json.value);
        } else if (jsonEditor) {
            entity = jsonEditor.getValue();
            if (loadedEntity) entity = preserveLiveEntity(loadedEntity, entity);
        } else if (els.json && els.json.value) {
            entity = JSON.parse(els.json.value);
        } else {
            throw new Error('Editor not ready');
        }
        if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
            throw new Error('Entity must be an object');
        }
        return { id, entity };
    }

    function captureCleanSnapshot() {
        try {
            cleanSnapshot = stableStringify(readUiSnapshot());
        } catch (_) {
            cleanSnapshot = null;
        }
    }

    function recomputeDirty() {
        if (suppressDirty) return;
        if (isNew) {
            setDirty(true);
            return;
        }
        if (cleanSnapshot === null) {
            setDirty(false);
            return;
        }
        try {
            const cur = stableStringify(readUiSnapshot());
            setDirty(cur !== cleanSnapshot);
        } catch (_) {
            setDirty(true);
        }
    }

    function markDirty() {
        recomputeDirty();
    }

    function kindMeta() {
        return KIND_META[kind] || null;
    }

    function kindLabel() {
        const m = kindMeta();
        return (m && m.label) || kind;
    }

    function entityRelPath(id) {
        const m = kindMeta();
        if (!m) return `presets/${modeId}/…`;
        if (m.shape === 'folder' || m.shape === 'nested_pack') {
            return `presets/${modeId}/${m.dir}/${id || '<id>'}.json`;
        }
        return `presets/${modeId}/${m.pathFile}`;
    }

    function pathHintText(id) {
        const m = kindMeta();
        const path = entityRelPath(id);
        if (m && m.shape === 'catalog') {
            return `${path} · row ${id || '<id>'}`;
        }
        if (m && m.shape === 'nested_pack') {
            return `${path} · pack (pieces[])`;
        }
        return path;
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
        syncPickerContext();
    }

    function buildKindNav() {
        if (!els.kindNav) return;
        const parts = [];
        for (const g of KIND_GROUPS) {
            parts.push(
                `<div class="du-kind-group-label">${escapeHtml(g.label)}</div>`
            );
            for (const [id, meta] of Object.entries(KIND_META)) {
                if (meta.group !== g.id) continue;
                const active = id === kind ? ' is-active' : '';
                parts.push(
                    `<button type="button" class="du-kind-btn${active}" data-kind="${escapeHtml(id)}">` +
                        `<i class="fa-solid ${escapeHtml(meta.icon)}"></i> ${escapeHtml(meta.label)}` +
                        `</button>`
                );
            }
        }
        els.kindNav.innerHTML = parts.join('');
    }

    function updateKindNav() {
        if (!els.kindNav) return;
        els.kindNav.querySelectorAll('[data-kind]').forEach((btn) => {
            const k = btn.getAttribute('data-kind');
            btn.classList.toggle('is-active', k === kind);
        });
        if (els.listTitle) els.listTitle.textContent = kindLabel();
        if (els.saveHint) {
            const m = kindMeta();
            if (m && m.shape === 'nested_pack') {
                els.saveHint.textContent =
                    'Save writes the whole piece pack file (all pieces[] + grids) atomically.';
            } else if (m && m.shape === 'folder') {
                els.saveHint.textContent =
                    'Save writes one JSON file under the kind folder (atomic replace).';
            } else {
                els.saveHint.textContent =
                    'Save rewrites the whole catalog file atomically (one row create/update).';
            }
        }
        updateValidateBtn();
        updatePreviewProfileBtn();
    }

    function updateValidateBtn() {
        const m = kindMeta();
        const show = !!(m && m.canValidate);
        const enabled = show && !isNew && !!loadedId;
        if (els.validateGroup) els.validateGroup.hidden = !show;
        if (els.validateBtn) {
            els.validateBtn.hidden = false;
            els.validateBtn.disabled = !enabled;
        }
        // Stress level only for dungeon profiles (layout seeds via runDungeonTests).
        if (els.validateLevel) {
            const showLevel = show && kind === 'dungeons';
            els.validateLevel.hidden = !showLevel;
            els.validateLevel.disabled = !enabled || !showLevel;
        }
    }

    function renderPager() {
        if (!els.pager) return;
        const m = kindMeta();
        const usePager = m && m.paginate && listTotal > (listLimit || PAGE_SIZE);
        // Also show when offset > 0 or partial page for paginated kinds.
        const show =
            m &&
            m.paginate &&
            (listTotal > (listLimit || PAGE_SIZE) || listOffset > 0);
        if (!show) {
            els.pager.hidden = true;
            els.pager.innerHTML = '';
            return;
        }
        const limit = listLimit || PAGE_SIZE;
        const page = Math.floor(listOffset / limit) + 1;
        const pages = Math.max(1, Math.ceil(listTotal / limit));
        const canPrev = listOffset > 0;
        const canNext = listOffset + items.length < listTotal;
        els.pager.hidden = false;
        els.pager.innerHTML =
            `<button type="button" class="btn btn-retro btn-secondary btn-sm" id="duPrevPage" ${canPrev ? '' : 'disabled'}>Prev</button>` +
            `<span class="du-pager-meta small text-muted">${page} / ${pages} · ${listTotal}</span>` +
            `<button type="button" class="btn btn-retro btn-secondary btn-sm" id="duNextPage" ${canNext ? '' : 'disabled'}>Next</button>`;
        const prev = document.getElementById('duPrevPage');
        const next = document.getElementById('duNextPage');
        if (prev) {
            prev.addEventListener('click', () => {
                listOffset = Math.max(0, listOffset - limit);
                refreshList().catch((e) => showError(e.message || String(e)));
            });
        }
        if (next) {
            next.addEventListener('click', () => {
                listOffset = listOffset + limit;
                refreshList().catch((e) => showError(e.message || String(e)));
            });
        }
    }

    /**
     * @param {Array<Record<string, unknown>>} rows
     */
    function renderList(rows) {
        if (!els.list) return;
        // Server already filtered when paginating; client filter only for non-paginated.
        const m = kindMeta();
        const q = (els.filter && els.filter.value ? els.filter.value : '')
            .trim()
            .toLowerCase();
        let filtered = rows;
        if (q && !(m && m.paginate)) {
            filtered = rows.filter((h) => {
                const id = String(h.id || '').toLowerCase();
                const label = String(h.label || '').toLowerCase();
                return id.includes(q) || label.includes(q);
            });
        }

        if (filtered.length === 0) {
            els.list.innerHTML =
                '<div class="du-list-empty text-muted small px-1 py-2">No items</div>';
            renderPager();
            return;
        }

        els.list.innerHTML = filtered
            .map((h) => {
                const id = String(h.id || '');
                const label = String(h.label || id);
                const active = loadedId === id && !isNew ? ' is-active' : '';
                return (
                    `<button type="button" class="du-list-item${active}" data-id="${escapeHtml(id)}" role="option">` +
                    `<span class="du-list-id">${escapeHtml(id)}</span>` +
                    `<span class="du-list-label">${escapeHtml(label)}</span>` +
                    `</button>`
                );
            })
            .join('');
        renderPager();
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
        if (els.editorHolder) els.editorHolder.innerHTML = '';
    }

    /**
     * @param {string} schemaFile
     * @returns {Promise<Record<string, unknown>>}
     */
    async function loadSchemaDoc(schemaFile) {
        if (schemaCache[schemaFile]) return schemaCache[schemaFile];
        const url = `${schemasRoot()}/${schemaFile}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
            throw new Error(`Failed to load schema ${schemaFile} (HTTP ${res.status})`);
        }
        const data = await res.json();
        schemaCache[schemaFile] = data;
        return data;
    }

    /**
     * @param {string} idsKind
     * @param {{ filterField?: string, filterValue?: string }} [filter]
     * @returns {Promise<string[]>}
     */
    async function loadIds(idsKind, filter) {
        const filterSuffix = filter && filter.filterField
            ? `:${filter.filterField}=${filter.filterValue}` : '';
        const cacheKey = `${modeId}:${idsKind}${filterSuffix}`;
        if (idsCache[cacheKey]) return idsCache[cacheKey];
        // Skip kinds we don't manage (e.g. piece packs) — only known KINDS.
        if (!KIND_META[idsKind]) return [];
        try {
            /** @type {Record<string, unknown>} */
            const params = { mode: modeId, kind: idsKind };
            if (filter && filter.filterField) {
                params.filterField = filter.filterField;
                params.filterValue = filter.filterValue;
            }
            const data = await apiCall('presets_ids', params);
            const ids = Array.isArray(data.ids) ? data.ids.map(String) : [];
            idsCache[cacheKey] = ids;
            return ids;
        } catch (_) {
            return [];
        }
    }

    function clearIdsCache() {
        for (const k of Object.keys(idsCache)) delete idsCache[k];
    }

    /**
     * @param {Record<string, unknown>} baseSchema
     * @returns {Promise<Record<string, unknown>>}
     */
    async function enrichSchema(baseSchema) {
        const fields = RELATION_FIELDS[kind];
        if (!fields || fields.length === 0) return baseSchema;

        /**
         * Each field may have its own filter, so we build a per-field id map
         * keyed by a composite key (idsKind + filter) to avoid collisions.
         * @type {Record<string, string[]>}
         */
        const idsByKey = {};
        /** Deduplicate fetch requests by composite key. */
        const seen = new Set();
        const fetches = [];
        for (const f of fields) {
            const filterSuffix = f.filterField
                ? `:${f.filterField}=${f.filterValue}` : '';
            const key = `${f.idsKind}${filterSuffix}`;
            if (seen.has(key)) continue;
            seen.add(key);
            fetches.push(
                loadIds(f.idsKind, f.filterField
                    ? { filterField: f.filterField, filterValue: f.filterValue }
                    : undefined
                ).then((ids) => { idsByKey[key] = ids; })
            );
        }

        await Promise.all(fetches);
        // Build the idsByKind map that injectRelationEnums expects: per-field
        // override when a filter is present, otherwise normal kind key.
        /** @type {Record<string, string[]>} */
        const idsByKind = {};
        for (const f of fields) {
            const filterSuffix = f.filterField
                ? `:${f.filterField}=${f.filterValue}` : '';
            const key = `${f.idsKind}${filterSuffix}`;
            // For filtered fields, store under a unique key per path so
            // injectRelationEnums can find the right list.
            if (f.filterField) {
                idsByKind[`${f.idsKind}__${f.path}`] = idsByKey[key] || [];
            } else if (!idsByKind[f.idsKind]) {
                idsByKind[f.idsKind] = idsByKey[key] || [];
            }
        }
        // Remap filtered fields so the idsKind matches the composite key.
        const mappedFields = fields.map((f) => {
            if (f.filterField) {
                return { ...f, idsKind: `${f.idsKind}__${f.path}` };
            }
            return f;
        });
        return injectRelationEnums(baseSchema, mappedFields, idsByKind);
    }

    /**
     * @param {object} entity
     * @param {{ captureClean?: boolean }} [opts]
     */
    async function mountEditor(entity, opts = {}) {
        const captureClean = opts.captureClean !== false;
        destroyEditor();
        loadedEntity =
            entity && typeof entity === 'object' && !Array.isArray(entity)
                ? JSON.parse(JSON.stringify(entity))
                : null;
        if (!els.editorHolder) return;

        const meta = kindMeta();
        if (!meta) throw new Error('Unknown kind: ' + kind);

        if (typeof window.JSONEditor !== 'function') {
            viewMode = 'raw';
            applyViewMode();
            if (els.json) els.json.value = prettyJson(entity);
            if (captureClean) captureCleanSnapshot();
            return;
        }

        patchJsonEditorNumberStartval(window.JSONEditor);

        // Custom widgets: piece grid, dungeon profile, relation Select pickers
        registerPieceGridEditor();
        registerDungeonProfileEditor();
        registerRelationPickers();

        const schemaDoc = await loadSchemaDoc(meta.schemaFile);
        let schema = entitySchemaFromDoc(schemaDoc, meta.defKey);
        try {
            schema = await enrichSchema(schema);
        } catch (_) {
            // Relations are optional; keep base schema.
        }

        suppressDirty = true;
        const gen = editorGeneration;
        await new Promise((resolve, reject) => {
            try {
                jsonEditor = new window.JSONEditor(els.editorHolder, {
                    schema,
                    startval: entity,
                    theme: 'bootstrap5',
                    iconlib: 'fontawesome5',
                    disable_collapse: false,
                    disable_edit_json: true,
                    disable_properties: false,
                    no_additional_properties: false,
                    required_by_default: false,
                    // Invented 0 / first-enum would change combat. Number startval
                    // needs patchJsonEditorNumberStartval (json-editor 2.15 wipe).
                    use_default_values: false,
                    keep_oneof_values: false,
                    show_errors: 'interaction',
                    object_layout: 'normal',
                    object_background: '',
                    object_text: ''
                });

                const origValidate = jsonEditor.validate.bind(jsonEditor);
                jsonEditor.validate = function (value) {
                    const rawErrors = origValidate(value);
                    if (!rawErrors || !rawErrors.length) return rawErrors;
                    const currentVal =
                        value !== undefined ? value : jsonEditor.getValue();
                    return rawErrors.filter((err) => {
                        if (
                            err.property === 'enum' ||
                            (err.message && err.message.toLowerCase().includes('enum'))
                        ) {
                            const val = getValueByPath(currentVal, err.path || '');
                            if (val === '') return false;
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
                        if (captureClean) {
                            captureCleanSnapshot();
                            setDirty(!!isNew);
                        } else {
                            recomputeDirty();
                        }
                        suppressDirty = false;
                        resolve();
                    }, 0);
                });
            });
            jsonEditor.on('change', () => {
                if (gen !== editorGeneration) return;
                if (suppressDirty) {
                    if (captureClean) captureCleanSnapshot();
                    return;
                }
                recomputeDirty();
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
        if (els.formatBtn) els.formatBtn.disabled = form;
    }

    /**
     * @returns {object}
     */
    function readEntityFromUi() {
        if (viewMode === 'raw') {
            if (!els.json) throw new Error('Editor not ready');
            let entity;
            try {
                entity = JSON.parse(els.json.value);
            } catch (e) {
                throw new Error('Raw JSON is not valid: ' + (e && e.message));
            }
            if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
                throw new Error('Entity JSON must be an object');
            }
            return entity;
        }
        if (!jsonEditor) throw new Error('Form editor not ready');
        const errors = jsonEditor.validate();
        if (errors && errors.length) {
            const msg = errors
                .slice(0, 5)
                .map((e) => (e.path || '') + ' ' + (e.message || ''))
                .join('; ');
            throw new Error('Schema validation: ' + msg);
        }
        let entity = jsonEditor.getValue();
        if (loadedEntity) entity = preserveLiveEntity(loadedEntity, entity);
        return entity;
    }

    function clearValidateReport() {
        if (!els.validateReport) return;
        els.validateReport.hidden = true;
        els.validateReport.innerHTML = '';
        els.validateReport.className = 'du-validate-report';
    }

    function clearRefsStrip() {
        if (!els.refsStrip) return;
        els.refsStrip.hidden = true;
        els.refsStrip.innerHTML = '';
    }

    /**
     * Soft-ref banner for the open entity (best-effort; never blocks edit).
     * @param {string|null} id
     */
    async function loadRefsStrip(id) {
        clearRefsStrip();
        if (!id || isNew || !els.refsStrip) return;
        try {
            const data = await apiCall('presets_refs', {
                mode: modeId,
                kind,
                id
            });
            const refs = Array.isArray(data.refs) ? data.refs : [];
            if (!refs.length) return;
            const max = 8;
            const bits = refs.slice(0, max).map((r) => {
                const k = r && r.kind != null ? String(r.kind) : '?';
                const rid = r && r.id != null ? String(r.id) : '?';
                const field = r && r.field != null ? String(r.field) : '';
                return `<code>${escapeHtml(k)}/${escapeHtml(rid)}</code>` +
                    (field ? ` <span class="text-muted">(${escapeHtml(field)})</span>` : '');
            });
            const more =
                refs.length > max
                    ? ` <span class="text-muted">+${refs.length - max} more</span>`
                    : '';
            els.refsStrip.innerHTML =
                `<strong>Referenced by</strong> (${refs.length}): ` +
                bits.join(' · ') +
                more;
            els.refsStrip.hidden = false;
        } catch (_) {
            /* refs are best-effort */
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
     * Render structured validate result in the form panel.
     * @param {Record<string, unknown>} data
     */
    function renderValidateReport(data) {
        if (!els.validateReport) return;
        const ok = !!data.ok;
        const errs = Array.isArray(data.errors) ? data.errors : [];
        const warns = Array.isArray(data.warnings) ? data.warnings : [];
        const level = data.level != null ? String(data.level) : 'layout';
        const ms =
            data.durationMs != null && Number.isFinite(Number(data.durationMs))
                ? Math.round(Number(data.durationMs))
                : null;
        const detail =
            data.detail && typeof data.detail === 'object'
                ? /** @type {Record<string, unknown>} */ (data.detail)
                : null;

        els.validateReport.className =
            'du-validate-report ' + (ok ? 'is-ok' : 'is-fail');
        /** @type {string[]} */
        const parts = [];
        parts.push(
            `<div class="du-validate-report-head">` +
                `<span class="du-validate-badge">${ok ? 'OK' : 'FAIL'}</span>` +
                `<span>${escapeHtml(kind)}/<code>${escapeHtml(String(loadedId || ''))}</code></span>` +
                `<span class="text-muted">level=${escapeHtml(level)}</span>` +
                (ms != null
                    ? `<span class="text-muted">${ms} ms</span>`
                    : '') +
                `</div>`
        );

        if (detail && kind === 'dungeons') {
            const passed = detail.passed != null ? detail.passed : '—';
            const failed = detail.failed != null ? detail.failed : '—';
            const rate = detail.failureRate != null ? detail.failureRate : null;
            const iters = detail.iterations != null ? detail.iterations : null;
            parts.push(
                `<div class="du-validate-report-meta">` +
                    `seeds passed ${escapeHtml(String(passed))} / failed ${escapeHtml(String(failed))}` +
                    (iters != null ? ` · iterations ${escapeHtml(String(iters))}` : '') +
                    (rate != null ? ` · rate ${escapeHtml(String(rate))}` : '') +
                    (detail.layoutType
                        ? ` · type ${escapeHtml(String(detail.layoutType))}`
                        : '') +
                    `</div>`
            );
        }

        if (errs.length) {
            parts.push(
                `<ul class="du-validate-list du-validate-list--err">` +
                    errs
                        .slice(0, 12)
                        .map((e) => `<li>${escapeHtml(String(e))}</li>`)
                        .join('') +
                    (errs.length > 12
                        ? `<li class="text-muted">…and ${errs.length - 12} more</li>`
                        : '') +
                    `</ul>`
            );
        }
        if (warns.length) {
            parts.push(
                `<ul class="du-validate-list du-validate-list--warn">` +
                    warns
                        .slice(0, 8)
                        .map((w) => `<li>${escapeHtml(String(w))}</li>`)
                        .join('') +
                    (warns.length > 8
                        ? `<li class="text-muted">…and ${warns.length - 8} more</li>`
                        : '') +
                    `</ul>`
            );
        }
        if (ok && !warns.length && !errs.length) {
            parts.push(
                `<p class="mb-0 small text-muted">No structural issues found.</p>`
            );
        }

        els.validateReport.innerHTML = parts.join('');
        els.validateReport.hidden = false;
    }

    function updateHuntEditorLink() {
        if (!els.huntEditorLink) return;
        try {
            const base = els.huntEditorLink.getAttribute('href') || 'hunt-editor.php';
            const url = new URL(base, window.location.href);
            url.searchParams.set('mode', modeId);
            els.huntEditorLink.href = url.pathname + url.search + url.hash;
        } catch (_) {
            els.huntEditorLink.href =
                (els.huntEditorLink.getAttribute('href') || 'hunt-editor.php').split('?')[0] +
                '?mode=' +
                encodeURIComponent(modeId);
        }
    }

    /**
     * @param {{ updateUrl?: boolean, replaceUrl?: boolean }} [opts]
     */
    function showEmpty(opts = {}) {
        loadedId = null;
        loadedEntity = null;
        isNew = false;
        cleanSnapshot = null;
        destroyEditor();
        if (els.form) els.form.hidden = true;
        if (els.empty) els.empty.hidden = false;
        if (els.editingId) els.editingId.textContent = '—';
        if (els.pathHint) els.pathHint.textContent = '';
        if (els.deleteBtn) els.deleteBtn.disabled = true;
        if (els.duplicateBtn) els.duplicateBtn.disabled = true;
        if (els.renameBtn) els.renameBtn.disabled = true;
        if (els.formatBtn) els.formatBtn.disabled = true;
        if (els.saveBtn) els.saveBtn.disabled = true;
        if (els.viewFormBtn) els.viewFormBtn.disabled = true;
        if (els.viewRawBtn) els.viewRawBtn.disabled = true;
        clearValidateReport();
        clearRefsStrip();
        updateValidateBtn();
        updatePreviewProfileBtn();
        setDirty(false);
        renderList(items);
        if (opts.updateUrl !== false) {
            updateUrlParams({ replace: opts.replaceUrl !== false });
        }
    }

    /**
     * @param {object} entity
     * @param {{ id: string|null, isNew: boolean, path?: string }} meta
     * @param {{ updateUrl?: boolean, replaceUrl?: boolean }} [opts]
     */
    async function showEditor(entity, meta, opts = {}) {
        suppressDirty = true;
        loadedId = meta.id;
        isNew = !!meta.isNew;
        cleanSnapshot = null;
        if (els.empty) els.empty.hidden = true;
        if (els.form) els.form.hidden = false;

        const id = String(entity.id || meta.id || '');
        const idLocked = !isNew && !!meta.id;
        if (els.id) {
            els.id.value = id;
            els.id.readOnly = idLocked;
            els.id.title = idLocked
                ? 'Id is locked. Use Rename to change it (updates soft references).'
                : 'Snake_case entity id (e.g. fire_wave)';
        }
        if (els.idHint) {
            els.idHint.innerHTML = idLocked
                ? 'Id is locked. Use toolbar <strong>Rename</strong> to change it (updates soft refs). Save does not rename.'
                : 'snake_case id (e.g. <code>fire_wave</code>). Use <strong>Rename</strong> to change id on a saved entity (updates soft refs).';
        }

        if (els.editingId) {
            els.editingId.textContent = isNew ? `(new) ${id || '…'}` : id;
        }
        if (els.pathHint) {
            els.pathHint.textContent = meta.path
                ? meta.path + (kindMeta() && kindMeta().shape === 'catalog' ? ` · row ${id}` : '')
                : pathHintText(id);
        }
        if (els.deleteBtn) els.deleteBtn.disabled = isNew;
        if (els.duplicateBtn) els.duplicateBtn.disabled = isNew;
        // Rename only for already-saved entities (id is locked in the form).
        if (els.renameBtn) els.renameBtn.disabled = isNew || !meta.id;
        if (els.saveBtn) els.saveBtn.disabled = false;
        clearValidateReport();
        updateValidateBtn();
        updatePreviewProfileBtn();

        if (els.json) els.json.value = prettyJson(entity);
        applyViewMode();
        await mountEditor(entity, { captureClean: true });
        if (!jsonEditor) {
            captureCleanSnapshot();
            setDirty(!!isNew);
            suppressDirty = false;
        }
        renderList(items);
        // Soft refs after paint (do not block editor open).
        loadRefsStrip(isNew ? null : loadedId).catch(() => {});

        if (opts.updateUrl !== false) {
            updateUrlParams({ replace: opts.replaceUrl !== false });
        }
    }

    async function refreshList() {
        const m = kindMeta();
        /** @type {Record<string, unknown>} */
        const params = { mode: modeId, kind };
        if (m && m.paginate) {
            const q = els.filter && els.filter.value ? els.filter.value.trim() : '';
            if (q) params.q = q;
            params.limit = PAGE_SIZE;
            params.offset = listOffset;
        }
        const data = await apiCall('presets_list', params);
        items = Array.isArray(data.items) ? data.items : [];
        listTotal = typeof data.total === 'number' ? data.total : items.length;
        listOffset = typeof data.offset === 'number' ? data.offset : 0;
        listLimit =
            data.limit === null || data.limit === undefined
                ? null
                : Number(data.limit);
        if (els.statusMeta) {
            const shown =
                m && m.paginate && listTotal !== items.length
                    ? `${items.length} of ${listTotal}`
                    : String(listTotal);
            els.statusMeta.textContent = `${modeId} / ${kind}: ${shown} item(s)`;
        }
        renderList(items);
    }

    /**
     * @param {string} id
     * @param {{ updateUrl?: boolean, replaceUrl?: boolean }} [opts]
     */
    async function loadEntity(id, opts = {}) {
        if (dirty) {
            const ok = window.confirm('Discard unsaved changes?');
            if (!ok) return;
        }
        showError(null);
        status(`Loading ${id}…`);
        const data = await apiCall('presets_get', { mode: modeId, kind, id });
        await showEditor(data.entity, {
            id: data.id,
            isNew: false,
            path: data.path
        }, opts);
        status(`Loaded ${id}`);
    }

    /**
     * @param {object|null} seedFrom
     * @param {{ updateUrl?: boolean, replaceUrl?: boolean }} [opts]
     */
    async function startNew(seedFrom, opts = {}) {
        if (dirty) {
            const ok = window.confirm('Discard unsaved changes?');
            if (!ok) return;
        }
        showError(null);
        let entity;
        if (seedFrom && typeof seedFrom === 'object') {
            entity = JSON.parse(JSON.stringify(seedFrom));
            const base = String(entity.id || 'new_item').replace(/_copy\d*$/, '');
            let candidate = `${base}_copy`;
            const existing = new Set(items.map((h) => String(h.id)));
            // For paginated lists, also check server? Soft check only.
            let n = 2;
            while (existing.has(candidate)) {
                candidate = `${base}_copy${n}`;
                n += 1;
            }
            entity.id = candidate;
            if (entity.label != null) {
                entity.label = String(entity.label || base) + ' (copy)';
            }
        } else {
            const data = await apiCall('presets_template', {
                kind,
                id: 'new_item'
            });
            entity = data.entity;
        }
        await showEditor(entity, {
            id: null,
            isNew: true
        }, opts);
        if (els.id) {
            els.id.readOnly = false;
            els.id.focus();
            els.id.select();
        }
        const singular = kindLabel().replace(/s$/, '');
        status(`New ${singular.toLowerCase()} — set id and save`);
    }

    function parseEditorBody() {
        if (!els.id) throw new Error('Editor not ready');
        const id = els.id.value.trim().toLowerCase();
        if (!ID_RE.test(id)) {
            throw new Error('Invalid entity id (snake_case, e.g. fire_wave)');
        }
        let entity = readEntityFromUi();
        // Prevent mutation corruption of json-editor internal state
        if (entity && typeof entity === 'object') {
            entity = JSON.parse(JSON.stringify(entity));
        }
        entity.id = id;
        if (
            entity.label !== undefined &&
            (!entity.label || String(entity.label).trim() === '')
        ) {
            entity.label = id;
        }
        return { id, entity };
    }

    async function switchToRaw() {
        if (viewMode === 'raw') return;
        try {
            const entity = readEntityFromUi();
            suppressDirty = true;
            if (els.json) {
                els.json.value = prettyJson(entity);
            }
            viewMode = 'raw';
            applyViewMode();
            suppressDirty = false;
            recomputeDirty();
        } catch (e) {
            showError(e.message || String(e));
        }
    }

    async function switchToForm() {
        if (viewMode === 'form') return;
        try {
            if (!els.json) return;
            let entity;
            try {
                entity = JSON.parse(els.json.value);
            } catch (e) {
                throw new Error('Fix raw JSON before switching to form: ' + (e && e.message));
            }
            if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
                throw new Error('Entity JSON must be an object');
            }
            if (els.id && entity.id) {
                els.id.value = String(entity.id);
            }
            viewMode = 'form';
            applyViewMode();
            await mountEditor(entity, { captureClean: false });
        } catch (e) {
            showError(e.message || String(e));
        }
    }

    async function save() {
        showError(null);
        let parsed;
        try {
            parsed = parseEditorBody();
        } catch (e) {
            const msg = e.message || String(e);
            showError(msg);
            status('Fix validation errors');
            alert('Validation Error:\n' + msg);
            console.log('Validation Error:\n' + msg);
            return;
        }

        // Save never renames: id changes go through renameEntity() so soft refs update.
        if (!isNew && loadedId && parsed.id !== loadedId) {
            showError(
                `Entity id is locked to "${loadedId}". Use Rename to change it (and update references).`
            );
            status('Use Rename to change id');
            if (els.id) els.id.value = loadedId;
            return;
        }

        status(`Saving ${parsed.id}…`);
        try {
            const data = await apiCall('presets_save', {
                mode: modeId,
                kind,
                id: parsed.id,
                entity: parsed.entity
            });
            clearIdsCache();
            await refreshList();
            await showEditor(parsed.entity, {
                id: data.id,
                isNew: false,
                path: data.path
            }, { updateUrl: true, replaceUrl: true });
            const m = kindMeta();
            const where =
                m && (m.shape === 'folder' || m.shape === 'nested_pack')
                    ? data.path
                    : `${kind} catalog (${data.count != null ? data.count + ' rows' : 'ok'})`;
            status(
                data.created
                    ? `Created ${data.id} → ${where}`
                    : `Saved ${data.id} → ${where}`
            );
        } catch (e) {
            const msg = e.message || String(e);
            showError(msg);
            status('Save failed');
            alert('Save failed:\n' + msg);
        }
    }

    /**
     * Explicit rename for a saved entity: changes file/row id and rewrites soft refs.
     */
    async function renameEntity() {
        if (isNew || !loadedId) {
            showError('Save the entity before renaming.');
            return;
        }
        if (dirty) {
            showError('Save or discard unsaved changes before renaming.');
            status('Save before rename');
            return;
        }

        const fromId = loadedId;
        const suggested = fromId;
        const raw = window.prompt(
            `Rename ${kind} "${fromId}" to a new snake_case id.\nSoft references (populations, parties, hunts, …) will be updated.`,
            suggested
        );
        if (raw == null) return;
        const toId = String(raw).trim().toLowerCase();
        if (!toId || toId === fromId) {
            status('Rename cancelled');
            return;
        }
        if (!ID_RE.test(toId)) {
            showError('Invalid entity id (snake_case, e.g. fire_wave)');
            return;
        }

        /** @type {Array<{kind?: string, id?: string, field?: string}>} */
        let refs = [];
        try {
            const refData = await apiCall('presets_refs', {
                mode: modeId,
                kind,
                id: fromId
            });
            refs = Array.isArray(refData.refs) ? refData.refs : [];
        } catch (_) {
            refs = [];
        }

        const refLines =
            refs.length > 0
                ? '\n\nWill update ' +
                  refs.length +
                  ' soft reference(s):\n- ' +
                  refs
                      .slice(0, 12)
                      .map((r) => {
                          const k = r && r.kind != null ? String(r.kind) : '?';
                          const rid = r && r.id != null ? String(r.id) : '?';
                          const field = r && r.field != null ? String(r.field) : '';
                          return `${k}/${rid}` + (field ? ` (${field})` : '');
                      })
                      .join('\n- ') +
                  (refs.length > 12 ? `\n…and ${refs.length - 12} more` : '')
                : '\n\nNo soft references found for this id.';

        const ok = window.confirm(
            `Rename ${kind} "${fromId}" → "${toId}"?${refLines}`
        );
        if (!ok) {
            status('Rename cancelled');
            return;
        }

        showError(null);
        status(`Renaming ${fromId} → ${toId}…`);
        try {
            const data = await apiCall('presets_rename', {
                mode: modeId,
                kind,
                from: fromId,
                to: toId,
                updateRefs: true
            });
            clearIdsCache();
            await refreshList();
            await loadEntity(String(data.id || toId), {
                updateUrl: true,
                replaceUrl: true
            });
            const n =
                typeof data.refsUpdatedCount === 'number'
                    ? data.refsUpdatedCount
                    : Array.isArray(data.refsUpdated)
                      ? data.refsUpdated.length
                      : 0;
            status(
                `Renamed ${fromId} → ${data.id || toId}` +
                    (n > 0 ? ` · updated ${n} reference(s)` : '')
            );
        } catch (e) {
            const msg = e.message || String(e);
            showError(msg);
            status('Rename failed');
            alert('Rename failed:\n' + msg);
        }
    }

    async function remove() {
        if (isNew || !loadedId) return;

        let warnLines = '';
        try {
            const refData = await apiCall('presets_refs', {
                mode: modeId,
                kind,
                id: loadedId
            });
            if (Array.isArray(refData.warnings) && refData.warnings.length) {
                warnLines =
                    '\n\nSoft reference warnings:\n- ' +
                    refData.warnings.slice(0, 12).join('\n- ') +
                    (refData.warnings.length > 12
                        ? `\n…and ${refData.warnings.length - 12} more`
                        : '');
            }
        } catch (_) {
            /* refs are best-effort */
        }

        const m = kindMeta();
        const target =
            m && (m.shape === 'folder' || m.shape === 'nested_pack')
                ? entityRelPath(loadedId)
                : `${entityRelPath(loadedId)} (row ${loadedId})`;
        const ok = window.confirm(
            `Delete ${kind} "${loadedId}" from mode "${modeId}"?\n\nThis removes ${target}.${warnLines}`
        );
        if (!ok) return;
        showError(null);
        status(`Deleting ${loadedId}…`);
        try {
            const data = await apiCall('presets_delete', {
                mode: modeId,
                kind,
                id: loadedId
            });
            clearIdsCache();
            await refreshList();
            showEmpty({ updateUrl: true, replaceUrl: true });
            const extra =
                Array.isArray(data.warnings) && data.warnings.length
                    ? ` (${data.warnings.length} ref warning(s) before delete)`
                    : '';
            status(`Deleted ${loadedId}${extra}`);
        } catch (e) {
            showError(e.message || String(e));
            status('Delete failed');
        }
    }

    function formatJson() {
        if (!els.json || viewMode !== 'raw') return;
        try {
            const obj = JSON.parse(els.json.value);
            suppressDirty = true;
            els.json.value = prettyJson(obj);
            suppressDirty = false;
            recomputeDirty();
            status('Formatted JSON');
        } catch (e) {
            showError('Cannot format: ' + (e && e.message));
        }
    }

    /**
     * Optional kernel validate (pieces / biomes / dungeons).
     * Uses saved disk state — save first if the form is dirty.
     */
    async function runValidate() {
        const m = kindMeta();
        if (!m || !m.canValidate) return;
        if (isNew || !loadedId) {
            showError('Save the entity before validating.');
            return;
        }
        if (dirty) {
            const ok = window.confirm(
                'Validate runs against the saved file on disk.\n\nYou have unsaved changes — validate the last saved version anyway?'
            );
            if (!ok) return;
        }
        let level = 'layout';
        if (kind === 'dungeons' && els.validateLevel && !els.validateLevel.hidden) {
            level = els.validateLevel.value === 'stress' ? 'stress' : 'layout';
        }
        showError(null);
        clearValidateReport();
        if (els.validateBtn) els.validateBtn.disabled = true;
        status(`Validating ${kind}/${loadedId} (${level})…`);
        const t0 = performance.now ? performance.now() : Date.now();
        try {
            const data = await apiCall('presets_validate', {
                mode: modeId,
                kind,
                id: loadedId,
                level
            });
            const clientMs = Math.round(
                (performance.now ? performance.now() : Date.now()) - t0
            );
            if (data.durationMs == null) data.durationMs = clientMs;
            renderValidateReport(data);
            const errs = Array.isArray(data.errors) ? data.errors : [];
            const warns = Array.isArray(data.warnings) ? data.warnings : [];
            const msLabel =
                data.durationMs != null ? ` · ${data.durationMs} ms` : '';
            if (data.ok) {
                const extra =
                    warns.length > 0
                        ? ` · ${warns.length} warning(s)`
                        : '';
                status(`Validate OK: ${kind}/${loadedId} (${level})${extra}${msLabel}`);
                showError(null);
            } else {
                // Keep status bar short; details live in the report panel.
                status(
                    `Validate failed: ${kind}/${loadedId} (${level}) · ${errs.length} error(s)${msLabel}`
                );
                if (errs.length && !els.validateReport) {
                    showError(errs.slice(0, 12).join('\n'));
                }
            }
        } catch (e) {
            clearValidateReport();
            showError(e.message || String(e));
            status('Validate failed');
        } finally {
            updateValidateBtn();
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
            clearIdsCache();
            listOffset = 0;
            showError(null);
            updateHuntEditorLink();
            try {
                await refreshList();
                showEmpty({ updateUrl: true, replaceUrl: false });
                status(`Mode: ${modeId}`);
            } catch (e) {
                showError(e.message || String(e));
            }
        });
    }

    if (els.kindNav) {
        els.kindNav.addEventListener('click', async (ev) => {
            const btn = /** @type {HTMLElement} */ (ev.target).closest
                ? /** @type {HTMLElement} */ (ev.target).closest('[data-kind]')
                : null;
            if (!btn) return;
            const next = btn.getAttribute('data-kind');
            if (!next || next === kind || !KIND_META[next]) return;
            if (dirty) {
                const ok = window.confirm('Discard unsaved changes and switch category?');
                if (!ok) return;
            }
            kind = next;
            listOffset = 0;
            updateKindNav();
            showError(null);
            try {
                await refreshList();
                showEmpty({ updateUrl: true, replaceUrl: false });
                status(`Category: ${kindLabel()}`);
            } catch (e) {
                showError(e.message || String(e));
            }
        });
    }

    let filterTimer = null;
    if (els.filter) {
        els.filter.addEventListener('input', () => {
            const m = kindMeta();
            if (m && m.paginate) {
                // Debounce server-side filter for large lists.
                if (filterTimer) clearTimeout(filterTimer);
                filterTimer = setTimeout(() => {
                    listOffset = 0;
                    refreshList().catch((e) => showError(e.message || String(e)));
                }, 250);
            } else {
                renderList(items);
            }
        });
    }

    if (els.list) {
        els.list.addEventListener('click', (ev) => {
            const btn = ev.target && /** @type {HTMLElement} */ (ev.target).closest
                ? /** @type {HTMLElement} */ (ev.target).closest('[data-id]')
                : null;
            if (!btn) return;
            const id = btn.getAttribute('data-id');
            if (id) loadEntity(id, { updateUrl: true, replaceUrl: false }).catch((e) => showError(e.message || String(e)));
        });
    }

    if (els.id) {
        els.id.addEventListener('input', () => {
            markDirty();
            if (els.editingId) {
                els.editingId.textContent = isNew
                    ? `(new) ${els.id.value.trim() || '…'}`
                    : els.id.value.trim() || loadedId || '—';
            }
            if (els.pathHint) {
                els.pathHint.textContent = pathHintText(els.id.value.trim() || '<id>');
            }
        });
    }

    if (els.json) {
        els.json.addEventListener('input', markDirty);
    }

    if (els.viewFormBtn) {
        els.viewFormBtn.addEventListener('click', () => {
            switchToForm().catch((e) => showError(e.message || String(e)));
        });
    }
    if (els.viewRawBtn) {
        els.viewRawBtn.addEventListener('click', () => {
            switchToRaw().catch((e) => showError(e.message || String(e)));
        });
    }

    if (els.saveBtn) els.saveBtn.addEventListener('click', () => save());
    if (els.deleteBtn) els.deleteBtn.addEventListener('click', () => remove());
    if (els.formatBtn) els.formatBtn.addEventListener('click', () => formatJson());
    if (els.validateBtn) {
        els.validateBtn.addEventListener('click', () => {
            runValidate().catch((e) => showError(e.message || String(e)));
        });
    }
    if (els.duplicateBtn) {
        els.duplicateBtn.addEventListener('click', async () => {
            try {
                const { entity } = parseEditorBody();
                await startNew(entity, { updateUrl: true, replaceUrl: false });
            } catch (e) {
                showError(e.message || String(e));
            }
        });
    }
    if (els.renameBtn) {
        els.renameBtn.addEventListener('click', () => {
            renameEntity().catch((e) => showError(e.message || String(e)));
        });
    }
    if (els.newBtn) {
        els.newBtn.addEventListener('click', () => {
            startNew(null, { updateUrl: true, replaceUrl: false }).catch((e) => showError(e.message || String(e)));
        });
    }
    if (els.emptyNewBtn) {
        els.emptyNewBtn.addEventListener('click', () => {
            startNew(null, { updateUrl: true, replaceUrl: false }).catch((e) => showError(e.message || String(e)));
        });
    }
    if (els.previewProfileBtn) {
        els.previewProfileBtn.addEventListener('click', () => {
            openProfilePreview();
        });
    }

    window.addEventListener('message', (ev) => {
        if (ev.origin !== window.location.origin) return;
        if (ev.data && ev.data.type === 'PROFILE_PREVIEW_READY') {
            notifyProfilePreview();
        }
    });

    window.addEventListener('popstate', async () => {
        const params = new URLSearchParams(window.location.search);
        const popMode = params.get('mode');
        const popKind = params.get('kind');
        const popId = params.get('id');

        let modeChanged = false;
        let kindChanged = false;

        if (popMode && modes.some((m) => m.id === popMode) && popMode !== modeId) {
            modeId = popMode;
            if (els.modeSelect) els.modeSelect.value = modeId;
            setPreferredContentModeId(modeId);
            syncPickerContext();
            clearIdsCache();
            updateHuntEditorLink();
            modeChanged = true;
        }

        if (popKind && KIND_META[popKind] && popKind !== kind) {
            kind = popKind;
            updateKindNav();
            kindChanged = true;
        }

        if (modeChanged || kindChanged) {
            listOffset = 0;
            showError(null);
            try {
                await refreshList();
            } catch (e) {
                showError(e.message || String(e));
            }
        }

        if (popId) {
            if (popId !== loadedId || isNew) {
                try {
                    await loadEntity(popId, { updateUrl: false });
                } catch (e) {
                    showError(e.message || String(e));
                    showEmpty({ updateUrl: false });
                }
            }
        } else {
            if (loadedId !== null || isNew) {
                showEmpty({ updateUrl: false });
            }
        }
    });

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
            // Keep shared preferred mode; only use server default as fallback.
            modeId = resolvePreferredContentModeId({
                fallback:
                    (urlMode && modes.some((m) => m.id === urlMode) ? urlMode : null) ||
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
        buildKindNav();
        updateKindNav();
        updateHuntEditorLink();
        await refreshList();

        if (urlId) {
            try {
                await loadEntity(urlId, { updateUrl: false });
            } catch (e) {
                showError(`Could not load preset "${urlId}": ${e.message || String(e)}`);
                showEmpty({ updateUrl: false });
            }
        } else {
            showEmpty({ updateUrl: false });
        }
        updateUrlParams({ replace: true });
        status('Ready');
    } catch (e) {
        showError(e.message || String(e));
        status('Failed to load designer data');
        fillModes();
        syncPickerContext();
        buildKindNav();
        updateKindNav();
        updateHuntEditorLink();
        showEmpty({ updateUrl: false });
        updateUrlParams({ replace: true });
    }
}

module.exports = {
    initDesignerUiApp,
    injectRelationEnums
};
