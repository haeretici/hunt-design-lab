/**
 * Stage 9 content integration — catalog bridges, combat defaults, waypoints.
 */

'use strict';

const defaults = require('./defaults.js');
const creatureBridge = require('./creature_bridge.js');
const equipmentBridge = require('./equipment_bridge.js');
const waypoints = require('./waypoints.js');
const legacyMonsterPort = require('./legacy_monster_port.js');
const legacyAssets = require('./legacy_assets.js');

module.exports = {
    // defaults
    DEFAULT_CREATURE_COMBAT: defaults.DEFAULT_CREATURE_COMBAT,
    resolveCreatureSpeed: defaults.resolveCreatureSpeed,
    CREATURE_TIER_SCALES: defaults.CREATURE_TIER_SCALES,
    EQUIPMENT_CATEGORY_DEFAULTS: defaults.EQUIPMENT_CATEGORY_DEFAULTS,
    CREATURE_COMBAT_KEYS: defaults.CREATURE_COMBAT_KEYS,
    EQUIPMENT_COMBAT_KEYS: defaults.EQUIPMENT_COMBAT_KEYS,
    // creatures
    tierScaleFor: creatureBridge.tierScaleFor,
    applyTierScale: creatureBridge.applyTierScale,
    fillCreatureCombatDefaults: creatureBridge.fillCreatureCombatDefaults,
    catalogEntryToCombatTemplate: creatureBridge.catalogEntryToCombatTemplate,
    findCatalogCreature: creatureBridge.findCatalogCreature,
    resolveCreatureTemplate: creatureBridge.resolveCreatureTemplate,
    // equipment
    categoryDefaults: equipmentBridge.categoryDefaults,
    fillEquipmentCombatDefaults: equipmentBridge.fillEquipmentCombatDefaults,
    catalogItemToCombatItem: equipmentBridge.catalogItemToCombatItem,
    indexById: equipmentBridge.indexById,
    buildItemDb: equipmentBridge.buildItemDb,
    resolveEquipmentItem: equipmentBridge.resolveEquipmentItem,
    // waypoints
    normalizeWaypoints: waypoints.normalizeWaypoints,
    resolveHuntWaypoints: waypoints.resolveHuntWaypoints,
    // legacy port (dev)
    slugifyMonsterName: legacyMonsterPort.slugifyMonsterName,
    convertMonsterToTemplate: legacyMonsterPort.convertMonsterToTemplate,
    convertMonsterList: legacyMonsterPort.convertMonsterList,
    convertSpawnTable: legacyMonsterPort.convertSpawnTable,
    analyzeNavmesh: legacyMonsterPort.analyzeNavmesh,
    loadFloorSpawns: legacyAssets.loadFloorSpawns,
    parseSpawnRows: legacyAssets.parseSpawnRows,
    loadFloorSpawnsFromDocs: legacyAssets.loadFloorSpawnsFromDocs,
    resolveCreatureSpawnId: legacyAssets.resolveCreatureSpawnId,
    makeEditorSpawnPin: legacyAssets.makeEditorSpawnPin,
    DEFAULT_EDITOR_SPAWN_RESPAWN: legacyAssets.DEFAULT_EDITOR_SPAWN_RESPAWN,
    parseSpawnFloorZ: legacyAssets.parseSpawnFloorZ,
    planSpawnFloorMove: legacyAssets.planSpawnFloorMove,
    applySpawnFloorMove: legacyAssets.applySpawnFloorMove,
    padFloorId: legacyAssets.padFloorId,
    normalizeSpawnFilter: legacyAssets.normalizeSpawnFilter,
    filterSpawnList: legacyAssets.filterSpawnList,
    filterFloorSpawns: legacyAssets.filterFloorSpawns,
    toHuntSpawns: legacyAssets.toHuntSpawns,
    resolveSpawnSource: legacyAssets.resolveSpawnSource,
    resolveHuntSpawnDefs: legacyAssets.resolveHuntSpawnDefs,
    floorsFromSpawnSource: legacyAssets.floorsFromSpawnSource,
    loadSpawnIndex: legacyAssets.loadSpawnIndex,
    loadNavmeshAnalysis: legacyAssets.loadNavmeshAnalysis,
    legacyPath: legacyAssets.legacyPath
};
