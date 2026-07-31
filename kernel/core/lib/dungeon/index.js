/**
 * Stage 11 dungeon generator modules.
 * 11.0: pacing metrics + budget evaluation (Blueprint Phase 1).
 * 11.1: weighted population tables → spawn defs (Blueprint Phase 4, monsters).
 * 11.2: gizmo / marker props → prop defs + micro-loop interact.
 * 11.3: modular friction pieces + stitch (Blueprint Phase 2, logic-only).
 * 11.4: procedural layout assembler (rules + constrained growth + validate).
 * 11.5: fixed layouts + cutouts (static base, seed-driven pockets).
 * 11.6: headless N-iter stress tester + report.
 * 11.7: biome packs (mode-local piece+pop+marker+profile bundles).
 * 11.8: multi-floor biome chains (stair sockets, biome.floors, nav edges) + artSet.
 * 11.9: art tile binding (artSet → genre tiles catalog cells on friction).
 * 11.10: macro 15‑min multi-biome transitions (segments → floors + art/pop).
 * 11.11: deeper art volume + additional biome art packs (swamp / ice / ruins).
 * 11.12+: NavMesh bake per piece / floor (walkability-validated coarse graphs).
 */

'use strict';

const pacing = require('./pacing.js');
const population = require('./population.js');
const markers = require('./markers.js');
const pieces = require('./pieces.js');
const stitch = require('./stitch.js');
const rules = require('./rules.js');
const validate = require('./validate.js');
const procedural = require('./layout/procedural.js');
const fixed = require('./layout/fixed.js');
const multifloor = require('./layout/multifloor.js');
const macro = require('./layout/macro.js');
const tester = require('./tester.js');
const biome = require('./biome.js');
const art = require('./art.js');
const navbake = require('./navbake.js');

module.exports = {
    pacing,
    normalizeBudget: pacing.normalizeBudget,
    buildPacingMetrics: pacing.buildPacingMetrics,
    buildMacroMetrics: pacing.buildMacroMetrics,
    evaluatePacing: pacing.evaluatePacing,
    pacingTagFromEntity: pacing.pacingTagFromEntity,

    population,
    normalizePopulation: population.normalizePopulation,
    resolvePopulation: population.resolvePopulation,
    resolveHuntPopulationDefs: population.resolveHuntPopulationDefs,
    sampleSlotsAlongWaypoints: population.sampleSlotsAlongWaypoints,
    huntHasPopulation: population.huntHasPopulation,

    markers,
    normalizeMarkerRules: markers.normalizeMarkerRules,
    resolveMarkers: markers.resolveMarkers,
    resolveHuntMarkerDefs: markers.resolveHuntMarkerDefs,
    huntHasMarkers: markers.huntHasMarkers,
    normalizeSockets: markers.normalizeSockets,

    pieces,
    normalizePiece: pieces.normalizePiece,
    normalizePiecePack: pieces.normalizePiecePack,
    canConnect: pieces.canConnect,
    matchingDirections: pieces.matchingDirections,
    filterByTags: pieces.filterByTags,
    filterByExits: pieces.filterByExits,
    parseFrictionGrid: pieces.parseFrictionGrid,
    DEFAULT_WALK_FRICTION: pieces.DEFAULT_WALK_FRICTION,
    CARDINALS: pieces.CARDINALS,
    OPPOSITE: pieces.OPPOSITE,

    stitch: stitch.stitch,
    stitchModule: stitch,
    frictionToRgba: stitch.frictionToRgba,
    attachOrigin: stitch.attachOrigin,
    waypointSocketEdges: stitch.waypointSocketEdges,

    rules,
    RULE_OPS: rules.RULE_OPS,
    normalizeRuleProgram: rules.normalizeRuleProgram,
    normalizeRule: rules.normalizeRule,
    materializeRuleCounts: rules.materializeRuleCounts,

    validate,
    validateLayout: validate.validateLayout,
    canReach: validate.canReach,

    procedural,
    generateProceduralLayout: procedural.generateProceduralLayout,
    normalizeDungeonProfile: procedural.normalizeDungeonProfile,
    resolveHuntLayout: procedural.resolveHuntLayout,
    huntHasLayout: procedural.huntHasLayout,

    fixed,
    generateFixedLayout: fixed.generateFixedLayout,
    normalizeFixedProfile: fixed.normalizeFixedProfile,
    normalizeCutout: fixed.normalizeCutout,
    resolveFixedHuntLayout: fixed.resolveFixedHuntLayout,
    pointInCutout: fixed.pointInCutout,

    multifloor,
    generateMultiFloorLayout: multifloor.generateMultiFloorLayout,
    normalizeFloorChain: multifloor.normalizeFloorChain,
    normalizeFloorEntry: multifloor.normalizeFloorEntry,
    pairStairLinks: multifloor.pairStairLinks,
    resolveMultiFloorHuntLayout: multifloor.resolveMultiFloorHuntLayout,
    floorSeed: multifloor.floorSeed,

    macro,
    DEFAULT_TARGET_SEGMENT_SEC: macro.DEFAULT_TARGET_SEGMENT_SEC,
    normalizeMacroSegment: macro.normalizeMacroSegment,
    normalizeMacroSegments: macro.normalizeMacroSegments,
    expandSegmentsToFloors: macro.expandSegmentsToFloors,
    generateMultiBiomeLayout: macro.generateMultiBiomeLayout,
    resolveMultiBiomeHuntLayout: macro.resolveMultiBiomeHuntLayout,
    huntHasMultiBiome: macro.huntHasMultiBiome,
    buildMacroMeta: macro.buildMacroMeta,

    tester,
    runDungeonTests: tester.runDungeonTests,
    assessGeneration: tester.assessGeneration,
    generateOnce: tester.generateOnce,
    detectLayoutType: tester.detectLayoutType,

    biome,
    normalizeBiomeId: biome.normalizeBiomeId,
    normalizeArtSet: biome.normalizeArtSet,
    normalizeBiomePack: biome.normalizeBiomePack,
    validateBiomeConsistency: biome.validateBiomeConsistency,
    resolveBiomePack: biome.resolveBiomePack,
    listBiomeIdsFromPacks: biome.listBiomeIdsFromPacks,

    art,
    normalizeArtSetPack: art.normalizeArtSetPack,
    listArtSetTileIds: art.listArtSetTileIds,
    artSetVolume: art.artSetVolume,
    artSetRoleCounts: art.artSetRoleCounts,
    evaluateArtSetVolume: art.evaluateArtSetVolume,
    MIN_ART_SET_VOLUME: art.MIN_ART_SET_VOLUME,
    TARGET_ART_SET_VOLUME: art.TARGET_ART_SET_VOLUME,
    bindArtToFriction: art.bindArtToFriction,
    bindHuntArt: art.bindHuntArt,
    resolveArtSetId: art.resolveArtSetId,
    tileIdAt: art.tileIdAt,
    tileIdAtXY: art.tileIdAtXY,
    artSeed: art.artSeed,

    navbake,
    bakeFloorNavmesh: navbake.bakeFloorNavmesh,
    bakePieceNavmesh: navbake.bakePieceNavmesh,
    bakeFromPlacements: navbake.bakeFromPlacements,
    bakeMultiFloorNavmesh: navbake.bakeMultiFloorNavmesh,
    bakeStitchedNavmesh: navbake.bakeStitchedNavmesh,
    mergeNavmeshes: navbake.mergeNavmeshes,
    toNavmeshData: navbake.toNavmeshData,
    DEFAULT_NAV_MAX_EDGE: navbake.DEFAULT_MAX_EDGE
};
