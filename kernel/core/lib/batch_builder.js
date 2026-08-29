/**
 * Multi-kind sprite batch builder (creatures, equipment, tiles, overlays, objects).
 *
 * Builds a configurable image-gen prompt and destination paths for
 * genre + asset-kind spritesheets.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_GENRE,
    DEFAULT_KIND,
    getGenre,
    getAssetKind,
    genrePaths,
    subjectLineFor,
    categoryLabel,
    categoryPromptFocus,
    GENRES,
    ASSET_KINDS,
    listKindIds
} = require('../../settings.js');
const { generateAssetNames, parseDoneList } = require('./asset_names.js');
const { technicalToFileStem } = require('./creature_manifest.js');
const {
    parseWangId,
    wangMaskHint,
    WANG_MASK_COUNT
} = require('./overlay_wang.js');
const { parseWallId, WALL_ALIGN_COUNT } = require('./wall_wang.js');

const DEFAULT_GRID = { rows: 4, cols: 4 };

/** Allowed Google Antigravity (`agy --model`) values. */
const AGY_MODELS = [
    'Gemini 3.7 Flash (Low)',
    'Gemini 3.7 Flash (Medium)',
    'Gemini 3.7 Flash (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)'
];

/**
 * Grok Build headless models (`grok -m grok-4.6 --reasoning-effort …`).
 * Labels match Batch Builder select; effort is low | medium | high.
 */
const GROK_MODELS = [
    'Grok 4.6 (Low)',
    'Grok 4.6 (Medium)',
    'Grok 4.6 (High)'
];

/** Full model list for Batch Builder select (agy + grok). */
const IMAGE_MODELS = [...AGY_MODELS, ...GROK_MODELS];

const DEFAULT_MODEL = 'Gemini 3.7 Flash (High)';

/** CLI model id for Grok Build image generation. */
const GROK_CLI_MODEL = 'grok-4.6';

const BASE_STYLE_PIXEL =
    'TRUE 16-bit SNES bitmap pixel art: visible square pixels, limited palette per sprite, ' +
    'hard stair-step edges, dithering OK. ';

/** Default camera for creatures, weapons, props, mixed sheets. */
const BASE_STYLE_CAMERA_DEFAULT =
    'Orthographic top-down / slight ¾ game sprite look. ';

/**
 * Wearable plate slots: face the camera square-on so inventory icons match
 * Classic equipment helmet/armor/shield presentation (not creature front-right).
 */
const BASE_STYLE_CAMERA_FRONT_ITEM =
    'Orthographic front-facing inventory icon look (straight-on; no ¾ turn, no front-right yaw). ';

/**
 * Terrain tiles: pure top-down (no ¾) so opposite edges can match when repeated.
 */
const BASE_STYLE_CAMERA_TILE =
    'Orthographic pure top-down terrain view (flat map cell; no ¾, no perspective foreshortening, no horizon). ';

const BASE_STYLE_NEGATIVES =
    'NOT vector, NOT SVG, NOT flat illustration, NOT cel-shaded anime, NOT smooth anti-aliased edges, ' +
    'NOT glossy 3D renders, NOT icon-set or emoji style. No Bezier-smooth outlines. ' +
    'No names, labels, or text on the image.';

/** Full default style string (pixel + default camera + negatives). */
const BASE_STYLE =
    BASE_STYLE_PIXEL + BASE_STYLE_CAMERA_DEFAULT + BASE_STYLE_NEGATIVES;

/**
 * Equipment categories that must face straight front (orthographic inventory view).
 * Weapons/jewelry keep slight ¾; creatures keep front-right stance.
 */
const FRONT_FACING_EQUIPMENT_CATEGORIES = new Set([
    'helmet',
    'armor',
    'legs',
    'shield',
    'boots'
]);

/**
 * @param {string|null|undefined} category
 * @returns {boolean}
 */
function isFrontFacingEquipmentCategory(category) {
    return Boolean(category && FRONT_FACING_EQUIPMENT_CATEGORIES.has(category));
}

const ITEM_TECHNICAL_PREFIX =
    'Single high-resolution PNG spritesheet. Solid pure green background (#00FF00) outside items. ' +
    'Exact uniform grid: equal cell size, no borders, gutters, or chrome; no overlapping tiles. ' +
    'One isolated equipment item per cell, centered, ';

const ITEM_CAMERA_FRONT =
    'strict front-facing orthographic inventory/icon view ' +
    '(camera dead-on the item face; no yaw, no front-right angle, no ¾ turn — square to the viewer), ';

const ITEM_CAMERA_THREE_QUARTER =
    'inventory/icon view (slight ¾ or orthographic), ';

const ITEM_CAMERA_MIXED =
    'inventory/icon view: helmet/armor/legs/shield/boots must be strict front-facing orthographic ' +
    '(no ¾/yaw); weapons and jewelry may use slight ¾ or orthographic. ';

const ITEM_TECHNICAL_SUFFIX =
    'no wearer/hand/character, no floor/scene, no cast shadow. Item fills about 60–85% of cell height. ' +
    'Readable silhouette at small size; consistent lighting and scale across cells.';

/**
 * Keep leg armor (pants) distinct from boots so models do not merge the slots.
 * @param {string|null|undefined} category
 * @returns {string}
 */
function itemWearableSlotNote(category) {
    if (category === 'legs') {
        return (
            ' Each item is pants / leg armor only (waist-to-ankle: pants, leggings, greaves, cuisses); ' +
            'no boots, shoes, or footwear.'
        );
    }
    if (category === 'boots') {
        return ' Each item is footwear only; no pants, leggings, or full leg armor.';
    }
    if (!category) {
        return (
            ' Wearable slots stay distinct: legs = pants/leggings/greaves (no boots); ' +
            'boots = footwear only.'
        );
    }
    return '';
}

/**
 * Equipment item camera clause from optional category.
 * @param {string|null|undefined} category
 * @returns {string}
 */
function itemCameraClause(category) {
    if (isFrontFacingEquipmentCategory(category)) return ITEM_CAMERA_FRONT;
    if (category) return ITEM_CAMERA_THREE_QUARTER;
    return ITEM_CAMERA_MIXED;
}

/**
 * Full Technical line for a compose family (item is category-aware).
 * @param {string} compose
 * @param {string|null|undefined} category
 * @returns {string}
 */
function composeTechnicalFor(compose, category) {
    if (compose === 'item') {
        return (
            ITEM_TECHNICAL_PREFIX +
            itemCameraClause(category) +
            ITEM_TECHNICAL_SUFFIX +
            itemWearableSlotNote(category)
        );
    }
    return COMPOSE_TECHNICAL[compose] || COMPOSE_TECHNICAL.character;
}

/**
 * Subject-line suffix when a category is selected (kind-aware wording).
 * @param {string} kindId
 * @param {string|null|undefined} category
 * @returns {string}
 */
function categoryFocusNote(kindId, category) {
    if (!category || kindId === 'creatures') return '';
    const focus = categoryPromptFocus(kindId, category);
    if (focus) return ` Focus this sheet on ${focus}.`;
    return ` Focus this sheet on the "${category}" category only.`;
}

/**
 * Style line: override global ¾ camera for front-facing wearables and tiles.
 * @param {import('../../settings.js').GenreConfig} genre
 * @param {string} compose
 * @param {string|null|undefined} category
 * @returns {string}
 */
function styleLineFor(genre, compose, category) {
    let camera = BASE_STYLE_CAMERA_DEFAULT;
    if (compose === 'tile' || compose === 'overlay') {
        camera = BASE_STYLE_CAMERA_TILE;
    } else if (compose === 'item' && isFrontFacingEquipmentCategory(category)) {
        camera = BASE_STYLE_CAMERA_FRONT_ITEM;
    }
    return (
        BASE_STYLE_PIXEL +
        camera +
        BASE_STYLE_NEGATIVES +
        ' ' +
        (genre.styleExtra || '')
    ).trim();
}

/**
 * Recap tail; front-facing wearables mention straight-on icons.
 * @param {string} compose
 * @param {string|null|undefined} category
 * @returns {string}
 */
function composeRecapFor(compose, category) {
    if (compose === 'item' && isFrontFacingEquipmentCategory(category)) {
        return 'isolated front-facing equipment icons on green key, no text, no vector art.';
    }
    if (compose === 'item' && !category) {
        return (
            'isolated equipment icons on green key (wearables front-facing; weapons may be ¾), ' +
            'no text, no vector art.'
        );
    }
    return COMPOSE_RECAP[compose] || COMPOSE_RECAP.character;
}

/** Composition-specific technical constraints (static defaults; item uses ¾). */
const COMPOSE_TECHNICAL = {
    character:
        'Single high-resolution PNG spritesheet. Solid pure green background (#00FF00) outside characters. ' +
        'Exact uniform grid: equal cell size, no borders, gutters, or chrome; no overlapping tiles. ' +
        'One full-body character per cell, front-right fighting stance, consistent camera scale across cells; ' +
        'each character fills most of its cell height (about 70–90%), not a tiny icon in empty green. ' +
        'Consistent proportions; full body always visible.',
    item: ITEM_TECHNICAL_PREFIX + ITEM_CAMERA_THREE_QUARTER + ITEM_TECHNICAL_SUFFIX,
    tile:
        'Single high-resolution PNG terrain tileset sheet. ' +
        'Exact uniform grid: equal cell size, no borders, gutters, labels, frames, or chrome. ' +
        'Each cell is ONE independent SEAMLESS tileable terrain texture filled EDGE-TO-EDGE ' +
        '(content to every pixel of the cell; no empty margin inside the cell). ' +
        'CRITICAL seamless wrapping: each tile must tile with itself without visible seams — ' +
        'left edge must match the right edge and top edge must match the bottom edge as if the ' +
        'texture wraps (like a seamless repeating texture / wrap-around pattern). ' +
        'Uniform stochastic texture: even density and value across the cell; pattern continues ' +
        'off every edge; no large-scale gradients that would checkerboard when repeated. ' +
        'Anonymous surface only: no unique landmarks, no single rock/flower/crack you could ' +
        'spot twice in a 2×2 repeat, no mini-scenes, props, characters, or readable symbols. ' +
        'Neutral pure top-down lighting, no strong directional shadows or cast light that ' +
        'encodes a light direction. ' +
        'NO pure green #00FF00 inside tile content (full opaque fill preferred).',
    overlay:
        'Single high-resolution PNG terrain OVERLAY sheet (Wang-16, one material family). ' +
        'Exact uniform grid: equal cell size, no borders, gutters, labels, frames, or chrome. ' +
        'Each cell is ONE overlay stamp of the SAME material (dirt or water or cobble). ' +
        'This is NOT a seamless wrap-around tile and NOT an opaque full-bleed ground fill. ' +
        'Where the overlay does not cover the cell, the pixel MUST be transparent PNG alpha ' +
        '(preferred) or solid magenta #FF00FF plate — holes show the ground underneath. ' +
        'MUST NOT use pure green #00FF00 anywhere (fights grass). ' +
        'Connected edges (N/E/S/W per the roster mask) must read as the same material continuing ' +
        'into the neighbor cell; unconnected edges fade or blob inside the cell. ' +
        'Mask 15 is a full-cell opaque fill of that material. Mask 0 is an isolated island. ' +
        'Neutral pure top-down lighting. No characters, props, text, or unique landmarks.',
    prop:
        'Single high-resolution PNG spritesheet. Solid pure green background (#00FF00) outside props. ' +
        'Exact uniform grid: equal cell size, no borders, gutters, or chrome; no overlapping tiles. ' +
        'One isolated scenario object per cell (building, tree, wall piece, furniture, deco), ' +
        'centered, top-down / slight ¾ RPG prop view, no ground plane or baked ground shadow. ' +
        'Object fills about 65–90% of cell height; consistent camera scale across cells. ' +
        'No characters, no readable text or logos on signs/banners.'
};

const COMPOSE_RECAP = {
    character:
        'full-body characters filling cells, no text, no vector art.',
    item:
        'isolated equipment icons on green key, no text, no vector art.',
    tile:
        'edge-to-edge SEAMLESS wrap-around terrain tiles (left=right, top=bottom), ' +
        'anonymous uniform texture, no text, no vector art.',
    overlay:
        'alpha Wang-16 overlay stamps (holes show ground), no green #00FF00, ' +
        'no seamless wrap, no text, no vector art.',
    prop:
        'isolated map props on green key, no text, no vector art.'
};

/**
 * @typedef {Object} BatchOptions
 * @property {string} [genre]
 * @property {string} [kind] asset kind id
 * @property {string|null} [category] optional subcategory (equipment sword, tiles floor, …)
 * @property {number} [count] defaults to rows*cols
 * @property {number} [rows]
 * @property {number} [cols]
 * @property {number|null} [seed]
 * @property {string} [doneFile] override path
 * @property {boolean} [appendDone] default true when materializing
 * @property {string} [model] image model label (agy Gemini * or Grok 4.6 *)
 * @property {string[]} [exclude] extra technical names to skip
 * @property {boolean} [opaqueAlpha] when true, process_sprites writes opaque alpha copies (no chroma)
 * @property {'lanczos'|'nearest'|null} [scaleFilter] when nearest, stamp catalog + process_sprites NEAREST
 * @property {Array<{technical:string,alias:string,category?:string}>} [creatures] inject fixed list (legacy name)
 * @property {Array<{technical:string,alias:string,category?:string}>} [items] inject fixed list (preferred).
 *   Length may be &lt; count: remaining slots are auto-filled via generateAssetNames (seed + done/exclude).
 *   Length must not exceed count.
 */

/**
 * @typedef {Object} ImageGenInvocation
 * @property {'agy'|'grok'} provider
 * @property {string} command binary to spawn
 * @property {string[]} args argv after the binary
 * @property {string} model display / select label
 * @property {string} [effort] grok reasoning effort when provider is grok
 */

/**
 * Whether the model label is a Grok Build option.
 * @param {string} model
 * @returns {boolean}
 */
function isGrokModel(model) {
    return typeof model === 'string' && model.startsWith('Grok ');
}

/**
 * Map Batch Builder model label → Grok reasoning effort (low|medium|high).
 * @param {string} model
 * @returns {'low'|'medium'|'high'|null}
 */
function grokEffortFromModel(model) {
    if (!isGrokModel(model)) return null;
    const m = model.match(/\((Low|Medium|High)\)\s*$/i);
    if (!m) return 'medium';
    return /** @type {'low'|'medium'|'high'} */ (m[1].toLowerCase());
}

/**
 * Headless prompt for Grok: generate via image_gen, then copy to dest path.
 * @param {string} artPrompt
 * @param {string} spritesheetPath absolute destination
 * @returns {string}
 */
function buildGrokImagePrompt(artPrompt, spritesheetPath) {
    return [
        'Generate one game spritesheet image, then save it to the exact filesystem path below.',
        '1. Call image_gen with aspect_ratio 1:1 using the IMAGE PROMPT verbatim as the prompt.',
        '2. Copy or move the generated PNG to DEST (create parent directories if needed).',
        '3. Verify DEST exists and is a non-empty PNG, then stop. Do not edit project source code.',
        '',
        `DEST: ${spritesheetPath}`,
        '',
        'IMAGE PROMPT:',
        artPrompt
    ].join('\n');
}

/**
 * Build spawn plan for image generation (agy or grok).
 * @param {string} model Batch Builder model label
 * @param {string} prompt art / subject prompt
 * @param {string} spritesheetPath absolute path expected on disk after gen
 * @returns {ImageGenInvocation}
 */
function buildImageGenInvocation(model, prompt, spritesheetPath) {
    const label = model || DEFAULT_MODEL;
    if (isGrokModel(label)) {
        const effort = grokEffortFromModel(label) || 'medium';
        const headlessPrompt = buildGrokImagePrompt(prompt, spritesheetPath);
        return {
            provider: 'grok',
            command: 'grok',
            model: label,
            effort,
            args: [
                '-p',
                headlessPrompt,
                '-m',
                GROK_CLI_MODEL,
                '--reasoning-effort',
                effort,
                '--always-approve',
                '--max-turns',
                '12'
            ]
        };
    }
    return {
        provider: 'agy',
        command: 'agy',
        model: label,
        args: ['--model', label, '-p', prompt]
    };
}

/**
 * Load technical names already generated for a genre+kind (done list).
 * @param {string} doneFile
 * @returns {Set<string>}
 */
function loadDoneSet(doneFile) {
    if (!doneFile || !fs.existsSync(doneFile)) {
        return new Set();
    }
    return parseDoneList(fs.readFileSync(doneFile, 'utf8'));
}

/**
 * Append technical names (and aliases) to the done file.
 * Format: technical\\talias per line (tab-separated); alias optional.
 * @param {string} doneFile
 * @param {Array<{technical:string, alias?:string}>} items
 */
function appendDoneFile(doneFile, items) {
    const dir = path.dirname(doneFile);
    fs.mkdirSync(dir, { recursive: true });
    const lines = items.map((c) =>
        c.alias ? `${c.technical}\t${c.alias}` : c.technical
    );
    fs.appendFileSync(doneFile, lines.join('\n') + '\n', 'utf8');
}

/**
 * Group technical names into row strings.
 * @param {Array<{technical:string}>} items
 * @param {number} cols
 * @returns {string[]}
 */
function buildRows(items, cols) {
    /** @type {string[]} */
    const rows = [];
    for (let i = 0; i < items.length; i += cols) {
        const slice = items.slice(i, i + cols);
        rows.push(slice.map((c) => c.technical).join(', '));
    }
    return rows;
}

/**
 * Build the image-generation subject prompt for a compose family.
 * @param {object} params
 * @param {import('../../settings.js').GenreConfig} params.genre
 * @param {import('../../settings.js').AssetKindConfig} params.kind
 * @param {string} params.spritesheetPath
 * @param {string[]} params.rows
 * @param {number} [params.gridRows]
 * @param {number} [params.gridCols]
 * @param {string|null} [params.category]
 */
function buildPrompt({
    genre,
    kind,
    spritesheetPath,
    rows,
    gridRows,
    gridCols,
    category
}) {
    const nRows = gridRows ?? rows.length;
    const nCols =
        gridCols ??
        (rows[0] ? rows[0].split(', ').length : DEFAULT_GRID.cols);
    const minSide = Math.max(nRows, nCols) * 256;
    const compose = kind.compose || 'character';
    const rowBlock = rows
        .map((r, i) => {
            if (compose !== 'overlay') return `Row ${i + 1}: ${r}`;
            const labeled = r.split(', ').map((tech) => {
                const parsed = parseWangId(tech);
                if (!parsed) return tech;
                return `${tech} (mask ${parsed.mask}: ${wangMaskHint(parsed.mask)})`;
            });
            return `Row ${i + 1}: ${labeled.join(', ')}`;
        })
        .join('\n');
    const technical = composeTechnicalFor(compose, category);
    const recapTail = composeRecapFor(compose, category);
    const subject = subjectLineFor(genre.id, kind.id);
    const catNote = categoryFocusNote(kind.id, category);
    const recapPlate =
        compose === 'tile'
            ? 'edge-to-edge SEAMLESS wrap-around tiles (each cell self-tileable), '
            : compose === 'overlay'
              ? 'alpha overlay stamps (transparent or magenta #FF00FF holes; NEVER green #00FF00), '
              : 'pure green #00FF00 key, ';

    return [
        `Generate a 2D ${kind.sheetNoun} in ${spritesheetPath}`,
        `Perspective: ${genre.perspective}`,
        subject + catNote,
        `Style: ${styleLineFor(genre, compose, category)}`,
        `Layout: Clean ${nRows}×${nCols} grid, no borders or gutters. ` +
            `Target total size at least ${minSide}×${minSide} ` +
            `(each cell about 256×256 or larger).`,
        `Technical: ${technical}`,
        '',
        `${kind.rosterLabel} (one per cell, left to right, top to bottom):`,
        rowBlock,
        '',
        `Recap: pixel-art ${nRows}×${nCols} spritesheet, ` +
            recapPlate +
            `cells ≥256px, ${recapTail}`
    ].join('\n');
}

/**
 * Sanitize technical name for filesystem (letters only → underscores).
 * @param {string} name
 */
/**
 * Technical phrase → PNG file stem. Keeps digits so numbered variants
 * (`Gazer 2` → `Gazer_2`) do not collide with the base name (`Gazer`).
 * Delegates to technicalToFileStem (same rules as catalog / inventory).
 * @param {string} name
 * @returns {string}
 */
function cleanFileStem(name) {
    return technicalToFileStem(name);
}

/**
 * Stamp wangFamily / wangMask on overlay roster rows (from fields or id/stem).
 * @param {object} item
 * @param {string} kindId
 * @param {string|null} category
 * @returns {object}
 */
function decorateOverlayItem(item, kindId, category) {
    if (kindId !== 'overlays') return item;
    const parsed = parseWangId(item.technical) || parseWangId(item.alias);
    const wangFamily = item.wangFamily || parsed?.family || category || undefined;
    const wangMask = item.wangMask != null ? item.wangMask : parsed ? parsed.mask : undefined;
    const wangInner =
        item.wangInner != null ? item.wangInner : parsed && parsed.inner ? parsed.inner : undefined;
    return {
        ...item,
        kind: 'overlays',
        category: item.category || wangFamily || category || undefined,
        wangFamily,
        wangMask,
        wangInner,
        opaqueAlpha: false
    };
}

/**
 * Wall family id from generate options. `wangFamily` is a CLI/config alias.
 * @param {{ wallFamily?: unknown, wangFamily?: unknown }} options
 * @returns {string|null}
 */
function resolveWallFamilyOption(options) {
    const raw =
        options.wallFamily != null && String(options.wallFamily).trim()
            ? options.wallFamily
            : options.wangFamily;
    if (raw == null || !String(raw).trim()) return null;
    return String(raw).trim().toLowerCase();
}

/**
 * Stamp wallFamily / wallAlign on object wall-family roster rows.
 * @param {object} item
 * @param {string} kindId
 * @param {string|null} category
 * @param {string|null} [family]
 * @returns {object}
 */
function decorateWallItem(item, kindId, category, family) {
    if (kindId !== 'objects') return item;
    const parsed = parseWallId(item.technical) || parseWallId(item.alias);
    const wallFamily =
        item.wallFamily || parsed?.family || family || undefined;
    const wallAlign =
        item.wallAlign != null ? item.wallAlign : parsed ? parsed.align : undefined;
    if (!wallFamily && !wallAlign) return item;
    const next = {
        ...item,
        kind: 'objects',
        category: item.category || category || 'wall',
        wallFamily,
        wallAlign,
        opaqueAlpha: false
    };
    delete next.wangFamily;
    return next;
}

/**
 * Core: resolve options → batch plan (items, paths, prompt, image gen).
 * Does not write the done file or call image gen.
 *
 * @param {BatchOptions} [options]
 */
function buildBatch(options = {}) {
    const genreId = options.genre || DEFAULT_GENRE;
    const kindId = options.kind || DEFAULT_KIND;
    const genre = getGenre(genreId);
    const kind = getAssetKind(kindId);
    const paths = genrePaths(genreId, kindId);
    const category = options.category || null;
    const wallFamilyOpt = resolveWallFamilyOption(options);
    const wangFamilyOpt = wallFamilyOpt;
    const wallFamilyMode = kindId === 'objects' && !!wallFamilyOpt;

    const rows = options.rows ?? DEFAULT_GRID.rows;
    const cols = options.cols ?? DEFAULT_GRID.cols;
    const count = options.count ?? rows * cols;

    if (count !== rows * cols) {
        throw new Error(
            `count (${count}) must equal rows*cols (${rows}*${cols}=${rows * cols}) for a full grid`
        );
    }
    if (kindId === 'overlays' && options.opaqueAlpha === true) {
        throw new Error(
            'overlays MUST NOT use --opaque-alpha (keep PNG alpha on icon/small/medium)'
        );
    }
    if (wallFamilyMode && options.opaqueAlpha === true) {
        throw new Error(
            'wall families MUST NOT use --opaque-alpha (keep PNG alpha so ground shows)'
        );
    }
    if (wallFamilyMode && count !== WALL_ALIGN_COUNT) {
        throw new Error(
            `wall families generate as 4 faces (count must be ${WALL_ALIGN_COUNT}, got ${count})`
        );
    }

    const doneFile = options.doneFile || paths.doneFile;
    const exclude = new Set([
        ...loadDoneSet(doneFile),
        ...(options.exclude || [])
    ]);

    const injected = options.items || options.creatures;
    let items;
    if (injected && injected.length) {
        if (kindId === 'overlays' && injected.length !== count) {
            throw new Error(
                `overlays inject must be a full Wang-16 family (${WANG_MASK_COUNT} items); got ${injected.length}`
            );
        }
        if (wallFamilyMode && injected.length !== count) {
            throw new Error(
                `wall family inject must be 4 faces (${WALL_ALIGN_COUNT} items); got ${injected.length}`
            );
        }
        if (injected.length > count) {
            throw new Error(
                `Injected items length ${injected.length} exceeds count ${count}`
            );
        }
        const fixed = injected.map((c) =>
            decorateWallItem(
                decorateOverlayItem(
                    {
                        technical: c.technical,
                        alias: c.alias || c.technical,
                        genre: genreId,
                        kind: kindId,
                        category: c.category || category || undefined,
                        wangFamily: c.wangFamily,
                        wangMask: c.wangMask,
                        wallFamily: c.wallFamily || wangFamilyOpt || undefined,
                        wallAlign: c.wallAlign,
                        opaqueAlpha:
                            kindId === 'overlays' || wallFamilyMode
                                ? false
                                : options.opaqueAlpha === true
                    },
                    kindId,
                    category
                ),
                kindId,
                category,
                wangFamilyOpt
            )
        );
        if (fixed.length === count) {
            items = fixed;
        } else {
            // Partial inject: fill remaining slots with generated names (smart update / sparse roster).
            const excludeAll = new Set(exclude);
            for (const c of fixed) {
                excludeAll.add(c.technical);
            }
            const fillers = generateAssetNames({
                genre: genreId,
                kind: kindId,
                category,
                wallFamily: wangFamilyOpt || undefined,
                count: count - fixed.length,
                exclude: excludeAll,
                seed: options.seed ?? null
            }).map((c) =>
                decorateWallItem(
                    decorateOverlayItem(
                        {
                            ...c,
                            opaqueAlpha:
                                kindId === 'overlays' || wallFamilyMode
                                    ? false
                                    : options.opaqueAlpha === true
                        },
                        kindId,
                        category
                    ),
                    kindId,
                    category,
                    wangFamilyOpt
                )
            );
            items = fixed.concat(fillers);
        }
    } else {
        if (kindId === 'overlays' && count !== WANG_MASK_COUNT) {
            throw new Error(
                `overlays generate as a Wang-16 family sheet (count must be ${WANG_MASK_COUNT}, got ${count})`
            );
        }
        items = generateAssetNames({
            genre: genreId,
            kind: kindId,
            category,
            wallFamily: wangFamilyOpt || undefined,
            count,
            exclude,
            seed: options.seed ?? null
        }).map((c) =>
            decorateWallItem(
                decorateOverlayItem(
                    {
                        ...c,
                        opaqueAlpha:
                            kindId === 'overlays' || wallFamilyMode
                                ? false
                                : options.opaqueAlpha === true
                    },
                    kindId,
                    category
                ),
                kindId,
                category,
                wangFamilyOpt
            )
        );
    }

    // Alias for BC with code that still says batch.creatures
    const creatures = items;

    const rowLabels = buildRows(items, cols);
    const spritesheetPath = paths.spritesheet;
    const prompt = buildPrompt({
        genre,
        kind,
        spritesheetPath,
        rows: rowLabels,
        gridRows: rows,
        gridCols: cols,
        category
    });

    const model = options.model || DEFAULT_MODEL;
    const imageGen = buildImageGenInvocation(model, prompt, spritesheetPath);
    // Explicit boolean; default false for character/item chroma unless caller sets true.
    // Tiles usually want true (batch UI defaults by kind).
    const opaqueAlpha =
        kindId === 'overlays' || wallFamilyMode
            ? false
            : options.opaqueAlpha === true || kindId === 'tiles';
    const scaleFilter =
        options.scaleFilter === 'nearest' || options.scaleFilter === 'lanczos'
            ? options.scaleFilter
            : null;

    return {
        genre,
        genreId,
        kind,
        kindId,
        category,
        wallFamily: wallFamilyMode ? wallFamilyOpt : undefined,
        wangFamily: wallFamilyMode ? undefined : wangFamilyOpt,
        opaqueAlpha,
        scaleFilter,
        paths,
        doneFile,
        rows,
        cols,
        count,
        seed: options.seed ?? null,
        model,
        /** Preferred name for roster entries. */
        items,
        /** @deprecated use items — kept for older callers / config */
        creatures,
        rowLabels,
        prompt,
        /** Spawn plan for agy or grok (preferred). */
        imageGen,
        /**
         * Legacy agy-only argv (provider agy). Prefer `imageGen`.
         * @deprecated use imageGen.command + imageGen.args
         */
        agyArgs:
            imageGen.provider === 'agy'
                ? imageGen.args
                : ['--model', model, '-p', prompt],
        fileStems: items.map((c) => cleanFileStem(c.technical))
    };
}

/**
 * Human-readable terminal summary.
 * @param {ReturnType<typeof buildBatch>} batch
 */
function formatBatchSummary(batch) {
    const lines = [
        `Genre: ${batch.genre.label} (${batch.genreId})`,
        `Kind:  ${batch.kind.label} (${batch.kindId})` +
            (batch.category
                ? ` · category ${categoryLabel(batch.kindId, batch.category)} (${batch.category})`
                : ''),
        `Items: ${batch.count} (${batch.rows}×${batch.cols})`,
        `Opaque alpha: ${
            batch.opaqueAlpha
                ? 'yes (no chroma)'
                : batch.kindId === 'overlays'
                  ? 'no (keep alpha)'
                  : 'no (chroma key)'
        }`,
        `Scale filter: ${
            batch.scaleFilter === 'nearest'
                ? 'nearest (pixel art)'
                : batch.scaleFilter === 'lanczos'
                  ? 'lanczos'
                  : 'lanczos (default)'
        }`,
        `Destination: ${batch.paths.spritesheet}`,
        `Done file: ${batch.doneFile}`,
        batch.seed != null ? `Seed: ${batch.seed}` : 'Seed: (random)',
        '---------------------------------------------------',
        'Batch roster (technical → alias):'
    ];
    batch.items.forEach((c, i) => {
        const cat = c.category ? ` {${c.category}}` : '';
        lines.push(
            `  ${String(i + 1).padStart(2, ' ')}. ${c.technical}  [${c.alias}]${cat}`
        );
    });
    lines.push('---------------------------------------------------');
    batch.rowLabels.forEach((r, i) => {
        lines.push(`  Row ${i + 1}: ${r}`);
    });
    return lines.join('\n');
}

/**
 * Serialize batch config for CLI / web batch-builder UI.
 * Paths are project-relative so browser exports run cleanly under Node.
 * @param {ReturnType<typeof buildBatch>} batch
 * @param {{ relativePaths?: boolean, includePrompt?: boolean }} [opts]
 */
function batchToConfigJson(batch, opts = {}) {
    const relative = opts.relativePaths !== false;
    const includePrompt = opts.includePrompt !== false;
    const g = batch.genreId;
    const k = batch.kindId;
    const destDir = relative
        ? path.join('assets', 'sprites', g, batch.kind.folder)
        : batch.paths.kindRoot;
    const spritesheet = relative
        ? path.join(destDir, 'sprites.png')
        : batch.paths.spritesheet;
    const doneFile = relative
        ? path.join('assets', 'data', g, batch.kind.doneFileName)
        : batch.doneFile;

    /** @type {Record<string, unknown>} */
    const cfg = {
        genre: batch.genreId,
        kind: batch.kindId,
        category: batch.category,
        rows: batch.rows,
        cols: batch.cols,
        count: batch.count,
        seed: batch.seed,
        model: batch.model,
        opaqueAlpha: Boolean(batch.opaqueAlpha),
        scaleFilter: batch.scaleFilter || undefined,
        destDir,
        spritesheet,
        doneFile,
        items: batch.items.map((c) => ({
            technical: c.technical,
            alias: c.alias,
            category: c.category || undefined,
            wangFamily: c.wangFamily || undefined,
            wangMask: c.wangMask,
            wallFamily: c.wallFamily || undefined,
            wallAlign: c.wallAlign || undefined,
            opaqueAlpha: Boolean(c.opaqueAlpha ?? batch.opaqueAlpha),
            scaleFilter: c.scaleFilter || batch.scaleFilter || undefined
        })),
        // BC for tools that still read creatures[]
        creatures: batch.items.map((c) => ({
            technical: c.technical,
            alias: c.alias
        }))
    };
    if (includePrompt) {
        cfg.prompt = batch.prompt;
    }
    return cfg;
}

/**
 * Compact config for export / debug (no prompt).
 * @param {ReturnType<typeof buildBatch>} batch
 */
function batchToCliConfig(batch) {
    return batchToConfigJson(batch, { includePrompt: false });
}

/**
 * Shell-escape a string for single-quoted bash argument.
 * @param {string} s
 */
function shellSingleQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * One-shot CLI from project root: flags only (no JSON).
 *
 * @param {ReturnType<typeof buildBatch>|{ genreId: string, kindId?: string, category?: string|null, seed: number|null, rows: number, cols: number, model: string, opaqueAlpha?: boolean, scaleFilter?: string|null }} batch
 * @param {{ dryRun?: boolean, iterations?: number, extraArgs?: string[] }} [opts]
 * @returns {string}
 */
function formatGenerateCommand(batch, opts = {}) {
    const iterations = Math.max(1, opts.iterations ?? 1);
    const kindId = batch.kindId || DEFAULT_KIND;
    const parts = [
        'node bin/generate_sprite.js',
        '-g',
        batch.genreId
    ];
    if (kindId && kindId !== DEFAULT_KIND) {
        parts.push('--kind', kindId);
    }
    if (batch.category) {
        parts.push('--category', batch.category);
    }
    if (batch.wallFamily) {
        parts.push('--wall-family', batch.wallFamily);
    }
    if (batch.seed != null) {
        parts.push('--seed', String(batch.seed));
    }
    if (batch.rows !== DEFAULT_GRID.rows) {
        parts.push('--rows', String(batch.rows));
    }
    if (batch.cols !== DEFAULT_GRID.cols) {
        parts.push('--cols', String(batch.cols));
    }
    if (iterations > 1) {
        parts.push('--iterations', String(iterations));
    }
    if (batch.model) {
        parts.push('--model', shellSingleQuote(batch.model));
    }
    if (batch.opaqueAlpha) {
        parts.push('--opaque-alpha');
    }
    if (batch.scaleFilter === 'nearest' || batch.scaleFilter === 'lanczos') {
        parts.push('--scale-filter', batch.scaleFilter);
    }
    if (opts.dryRun) {
        parts.push('--dry-run');
    }
    if (opts.extraArgs && opts.extraArgs.length) {
        parts.push(...opts.extraArgs);
    }
    return parts.join(' ');
}

/**
 * @returns {string[]}
 */
function listGenreIds() {
    return Object.keys(GENRES);
}

module.exports = {
    DEFAULT_GRID,
    DEFAULT_MODEL,
    AGY_MODELS,
    GROK_MODELS,
    IMAGE_MODELS,
    GROK_CLI_MODEL,
    BASE_STYLE,
    BASE_STYLE_CAMERA_FRONT_ITEM,
    COMPOSE_TECHNICAL,
    FRONT_FACING_EQUIPMENT_CATEGORIES,
    isFrontFacingEquipmentCategory,
    itemCameraClause,
    itemWearableSlotNote,
    categoryFocusNote,
    composeTechnicalFor,
    styleLineFor,
    composeRecapFor,
    isGrokModel,
    grokEffortFromModel,
    buildGrokImagePrompt,
    buildImageGenInvocation,
    loadDoneSet,
    appendDoneFile,
    buildRows,
    buildPrompt,
    cleanFileStem,
    decorateOverlayItem,
    buildBatch,
    formatBatchSummary,
    batchToConfigJson,
    batchToCliConfig,
    shellSingleQuote,
    formatGenerateCommand,
    listGenreIds,
    listKindIds,
    ASSET_KINDS
};
