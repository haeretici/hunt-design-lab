/**
 * Browser entry for the legacy map editor (Phase 5 TileMap UX + Phase 8 viewport polish).
 * Bundled to build/map-editor.bundle.js — exposes window.HdlTileMapEditor.
 */

'use strict';

const tilemapEditor = require('../../core/lib/dungeon/tilemap_editor.js');
const tilemapBake = require('../../core/lib/dungeon/tilemap_bake.js');
const tileRoles = require('../../core/lib/dungeon/tile_roles.js');
const editorViewport = require('../../core/lib/dungeon/editor_viewport.js');
const tileDraw = require('../../core/lib/tile_draw.js');
const spawnRows = require('../../core/lib/content/spawn_rows.js');
const mapEditorWorkflow = require('../../core/lib/dungeon/map_editor_workflow.js');
const overlayWang = require('../../core/lib/overlay_wang.js');
const wallWang = require('../../core/lib/wall_wang.js');

/** Catalog id → Title_Case stem (same rules as creature_sprites.idToFileStem). */
function idToFileStem(id) {
    return String(id || '')
        .trim()
        .replace(/\.png$/i, '')
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => {
            if (!part) return part;
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        })
        .join('_');
}

/**
 * Repo-relative sprite path (no appUrl — browser prepends ASSET_ROOT).
 * Layout: assets/sprites/<genre>/<kind>/<variant>/<Stem>.png
 */
function resolveSpriteRelPath(opts) {
    const o = opts || {};
    const genre = o.genre || 'rpg_fantasy';
    const kind =
        o.kind === 'objects' || o.kind === 'overlays' || o.kind === 'creatures'
            ? o.kind
            : 'tiles';
    const variant = o.variant || 'icon';
    const stem = o.stem || idToFileStem(o.id || o.catalogId || '');
    if (!stem) return null;
    return 'assets/sprites/' + genre + '/' + kind + '/' + variant + '/' + stem + '.png';
}

window.HdlTileMapEditor = {
    createEditorSession: tilemapEditor.createEditorSession,
    buildStampsFromArtSet: tilemapEditor.buildStampsFromArtSet,
    MAP_FIELD_DEFAULT_TTL_SEC: tilemapEditor.MAP_FIELD_DEFAULT_TTL_SEC,
    UI_SUB_LAYER_ORDER: tilemapEditor.UI_SUB_LAYER_ORDER,
    ROLE_PREVIEW_COLORS: tilemapEditor.ROLE_PREVIEW_COLORS,
    flagPaletteEntries: tilemapEditor.flagPaletteEntries,
    frictionPreviewColor: tilemapEditor.frictionPreviewColor,
    flagsPreviewColor: tilemapEditor.flagsPreviewColor,
    SUB_LAYER_IDS: tilemapEditor.SUB_LAYER_IDS,
    SUB_LAYER_DEFS: tilemapEditor.SUB_LAYER_DEFS,
    OVERRIDE_FRICTION: tilemapEditor.OVERRIDE_FRICTION,
    OVERRIDE_SIGHT: tilemapEditor.OVERRIDE_SIGHT,
    OVERRIDE_FLAGS: tilemapEditor.OVERRIDE_FLAGS,
    TILE_FLAG_PZ_PACKAGE: tilemapEditor.TILE_FLAG_PZ_PACKAGE,
    TILE_FLAG_NO_CAST: tilemapEditor.TILE_FLAG_NO_CAST,
    TILE_FLAG_NO_CREATURE: tilemapEditor.TILE_FLAG_NO_CREATURE,
    indexTileRoles: tileRoles.indexTileRoles,
    normalizeTileRole: tileRoles.normalizeTileRole,
    FRICTION_BLOCKED: tileRoles.FRICTION_BLOCKED,
    DEFAULT_OPEN_FRICTION: tileRoles.DEFAULT_OPEN_FRICTION,
    // bake helpers if UI needs them directly
    createEmptyTileMapFloor: tilemapBake.createEmptyTileMapFloor,
    serializeHybridPack: tilemapBake.serializeHybridPack,
    deserializeHybridPack: tilemapBake.deserializeHybridPack,
    bakeTileMapFloor: tilemapBake.bakeTileMapFloor,
    gzipBytes: tilemapBake.gzipBytes,
    gunzipBytes: tilemapBake.gunzipBytes,
    HYBRID_VERSION: tilemapBake.HYBRID_VERSION,
    // Phase 8: single-canvas viewport (+ polish)
    createEditorViewport: editorViewport.createEditorViewport,
    listCompositePasses: editorViewport.listCompositePasses,
    defaultVisibility: editorViewport.defaultVisibility,
    decodeFrictionRgbaToChannels: editorViewport.decodeFrictionRgbaToChannels,
    fillFrictionRgba: editorViewport.fillFrictionRgba,
    fillSightRgba: editorViewport.fillSightRgba,
    fillFlagsRgba: editorViewport.fillFlagsRgba,
    fillFieldsRgba: editorViewport.fillFieldsRgba,
    fillTileMapRgba: editorViewport.fillTileMapRgba,
    clientToMap: editorViewport.clientToMap,
    mapToScreen: editorViewport.mapToScreen,
    visibleMapRect: editorViewport.visibleMapRect,
    presentView: editorViewport.presentView,
    drawTallPropsMapSpace: editorViewport.drawTallPropsMapSpace,
    drawAuthoringSpritesDisplay: editorViewport.drawAuthoringSpritesDisplay,
    shouldShowTileSprites: editorViewport.shouldShowTileSprites,
    normalizeSpriteZoomMin: editorViewport.normalizeSpriteZoomMin,
    DEFAULT_SPRITE_ZOOM_MIN: editorViewport.DEFAULT_SPRITE_ZOOM_MIN,
    COMPOSITE_PASSES: editorViewport.COMPOSITE_PASSES,
    // tile_draw (tall props / scale-anchor)
    resolveTileDrawBox: tileDraw.resolveTileDrawBox,
    collectTallPropsFromFloor: tileDraw.collectTallPropsFromFloor,
    TERRAIN_SUB_LAYER_IDS: tileDraw.TERRAIN_SUB_LAYER_IDS,
    TALL_PROP_SUB_LAYER_IDS: tileDraw.TALL_PROP_SUB_LAYER_IDS,
    // lightweight path helpers (avoid bundling ImageDB / node fs)
    resolveSpriteRelPath,
    idToFileStem,
    // spawn pin helpers (slug + z/respawn)
    resolveCreatureSpawnId: spawnRows.resolveCreatureSpawnId,
    makeEditorSpawnPin: spawnRows.makeEditorSpawnPin,
    parseSpawnRows: spawnRows.parseSpawnRows,
    loadFloorSpawnsFromDocs: spawnRows.loadFloorSpawnsFromDocs,
    DEFAULT_EDITOR_SPAWN_RESPAWN: spawnRows.DEFAULT_EDITOR_SPAWN_RESPAWN,
    parseSpawnFloorZ: spawnRows.parseSpawnFloorZ,
    planSpawnFloorMove: spawnRows.planSpawnFloorMove,
    applySpawnFloorMove: spawnRows.applySpawnFloorMove,
    parseGotoQuery: mapEditorWorkflow.parseGotoQuery,
    spawnPinSignature: mapEditorWorkflow.spawnPinSignature,
    markSpawnBaseline: mapEditorWorkflow.markSpawnBaseline,
    isModifiedSpawn: mapEditorWorkflow.isModifiedSpawn,
    spawnIsNpc: mapEditorWorkflow.spawnIsNpc,
    spawnMatchesQuery: mapEditorWorkflow.spawnMatchesQuery,
    classifySpawnPin: mapEditorWorkflow.classifySpawnPin,
    filterEditorSpawns: mapEditorWorkflow.filterEditorSpawns,
    searchSpawns: mapEditorWorkflow.searchSpawns,
    findSpawnHits: mapEditorWorkflow.findSpawnHits,
    copySpawnPins: mapEditorWorkflow.copySpawnPins,
    pasteSpawnPins: mapEditorWorkflow.pasteSpawnPins,
    spawnAtTile: mapEditorWorkflow.spawnAtTile,
    mapToMinimap: mapEditorWorkflow.mapToMinimap,
    minimapToMap: mapEditorWorkflow.minimapToMap,
    fillMinimapRgba: mapEditorWorkflow.fillMinimapRgba,
    MINIMAP_DEFAULT_W: mapEditorWorkflow.MINIMAP_DEFAULT_W,
    MINIMAP_DEFAULT_H: mapEditorWorkflow.MINIMAP_DEFAULT_H,
    FIND_ISSUE_UNKNOWN: mapEditorWorkflow.FIND_ISSUE_UNKNOWN,
    FIND_ISSUE_BLOCKED: mapEditorWorkflow.FIND_ISSUE_BLOCKED,
    FIND_ISSUE_EMPTY: mapEditorWorkflow.FIND_ISSUE_EMPTY,
    parseWangId: overlayWang.parseWangId,
    wangFamilyOf: overlayWang.wangFamilyOf,
    wangCatalogId: overlayWang.wangCatalogId,
    parseWallId: wallWang.parseWallId,
    wallFamilyOf: wallWang.wallFamilyOf,
    wallCatalogId: wallWang.wallCatalogId,
    preferredSubLayer: tilemapEditor.preferredSubLayer
};
