#!/usr/bin/env node
/**
 * Stage 11.2 — Gizmo / marker props (Blueprint Phase 4 + Phase 1 micro-loop).
 * - normalizeMarkerRules / resolveMarkers unit tests
 * - same seed ⇒ same prop set; spawnCount min/max enforced
 * - explicit props win over marker resolve
 * - standard + legacy hunts resolve + headless prop telemetry
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const { hasMode } = require('./helpers/modes.js');

const assert = require('assert');
const {
    normalizeMarkerRules,
    resolveMarkers,
    huntHasMarkers,
    huntHasExplicitProps
} = require('../kernel/core/lib/dungeon/markers.js');
const {
    loadMarkerRules,
    listMarkerRuleIds,
    expandHuntDefinition
} = require('../kernel/core/lib/presets.js');
const {
    runHeadlessHunt,
    resolveHuntConfig
} = require('../kernel/providers/simulator/headless_runner.js');
const { setActiveMode } = require('../kernel/core/lib/modes.js');
const { summaryCore, stableStringify } = require('../kernel/core/lib/telemetry.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

function makeSockets(n, markerId, baseX, y, z) {
    const out = [];
    for (let i = 0; i < n; i++) {
        out.push({ id: markerId, x: baseX + i * 2, y, z });
    }
    return out;
}

function testNormalizeAndResolveUnit() {
    const raw = {
        id: 'unit_clickies',
        pools: {
            A: {
                objectIds: ['barrel', 'crate'],
                spawnCount: [4, 8],
                effect: 'break',
                lootValue: [1, 2],
                blocking: false
            },
            B: {
                objectIds: ['rest_well'],
                spawnCount: [0, 1],
                effect: 'well',
                healAmount: [20, 40]
            }
        }
    };
    const norm = normalizeMarkerRules(raw);
    assert.ok(norm);
    assert.strictEqual(norm.id, 'unit_clickies');
    assert.deepStrictEqual(norm.pools.A.spawnCount, [4, 8]);
    assert.strictEqual(norm.pools.B.effect, 'well');
    assert.strictEqual(norm.pools.B.pacingTag, 'well');

    const sockets = makeSockets(20, 'A', 100, 50, 7).concat(
        makeSockets(2, 'B', 150, 51, 7)
    );

    const a = resolveMarkers({ rules: raw, sockets, seed: 42 });
    const b = resolveMarkers({ rules: raw, sockets, seed: 42 });
    assert.strictEqual(
        stableStringify(a.props),
        stableStringify(b.props),
        'same seed ⇒ same prop set'
    );
    assert.ok(a.props.length >= 4, 'min A props');
    assert.ok(a.props.length <= 9, 'max A + B props');
    assert.ok(a.meta.poolCounts.A >= 4 && a.meta.poolCounts.A <= 8);
    assert.ok(a.meta.poolCounts.B <= 1);
    assert.strictEqual(a.meta.reason, 'ok');

    for (let i = 0; i < a.props.length; i++) {
        const p = a.props[i];
        assert.strictEqual(p.kind, 'prop');
        assert.ok(p.objectId);
        assert.ok(p.markerId === 'A' || p.markerId === 'B');
    }

    const c = resolveMarkers({ rules: raw, sockets, seed: 99 });
    assert.ok(c.props.length >= 1);
    log('unit resolve ok', {
        seed42: a.props.length,
        seed99: c.props.length,
        pools: a.meta.poolCounts
    });
}

function testExplicitPropsWin() {
    setActiveMode('standard');
    const fixture = {
        id: 'fixture',
        floor: 7,
        markersId: 'cave_clickies',
        markerSockets: makeSockets(10, 'A', 1, 2, 7),
        props: [
            {
                kind: 'prop',
                objectId: 'barrel',
                x: 1,
                y: 2,
                z: 7,
                effect: 'break',
                lootValue: 5
            }
        ]
    };
    const expanded = expandHuntDefinition(fixture, { seed: 1 });
    assert.strictEqual(expanded.markersSkipped, 'explicit_props');
    assert.strictEqual(expanded.props.length, 1);
    assert.strictEqual(expanded.props[0].lootValue, 5);
    assert.ok(huntHasExplicitProps(fixture));
    assert.ok(huntHasMarkers(fixture));
    log('explicit props win ok');
}

function testStandardMarkerPreset() {
    setActiveMode('standard');
    const ids = listMarkerRuleIds();
    assert.ok(ids.indexOf('cave_clickies') >= 0, 'standard generator markers preset');
    const table = loadMarkerRules('cave_clickies');
    assert.strictEqual(table.id, 'cave_clickies');
    assert.ok(ids.indexOf('floor07_clickies') < 0, 'hand floor07_clickies retired');

    // Generator-owned standard path (hand floor07_markers hunt retired).
    const r1 = resolveHuntConfig({ seed: 42, huntId: 'cave_crawl_generated' });
    const r2 = resolveHuntConfig({ seed: 42, huntId: 'cave_crawl_generated' });
    assert.ok(r1.props.length >= 1, 'marker hunt has props');
    assert.strictEqual(
        stableStringify(r1.props),
        stableStringify(r2.props),
        'resolveHuntConfig seed-stable props'
    );
    assert.ok(r1.hunt.markersMeta, 'markersMeta on expanded hunt');
    assert.strictEqual(r1.hunt.markersMeta.markersId, 'cave_clickies');
    assert.ok(
        (r1.hunt.markersMeta.poolCounts.A || 0) +
            (r1.hunt.markersMeta.poolCounts.B || 0) >=
            1,
        'at least one pool placed props'
    );
    assert.ok(
        (r1.hunt.markersMeta.poolCounts.A || 0) <= 4,
        'A spawnCount within cave_clickies range'
    );
    assert.ok((r1.hunt.markersMeta.poolCounts.B || 0) <= 1, 'B max 1 well');

    const dense = resolveHuntConfig({
        seed: 42,
        huntId: 'cave_crawl_generated',
        markerDensity: 2
    });
    assert.ok(
        dense.props.length >= r1.props.length,
        'higher density ⇒ at least as many props'
    );

    log('standard marker preset ok', {
        props: r1.props.length,
        pools: r1.hunt.markersMeta.poolCounts,
        dense: dense.props.length
    });
}

function testLegacyMarkerPreset() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    const ids = listMarkerRuleIds();
    assert.ok(ids.indexOf('cave_clickies') >= 0, 'legacy generator markers preset');
    // Hand corridor marker tables retired with dens + standard floor07_* hunts.
    assert.ok(ids.indexOf('floor07_clickies') < 0, 'legacy floor07_clickies retired');

    const r1 = resolveHuntConfig({
        seed: 7,
        huntId: 'cave_crawl_generated'
    });
    const r2 = resolveHuntConfig({
        seed: 7,
        huntId: 'cave_crawl_generated'
    });
    assert.ok(r1.props.length >= 1, 'legacy generated markers yield props');
    assert.strictEqual(
        stableStringify(r1.props),
        stableStringify(r2.props),
        'legacy markers seed-stable'
    );
    assert.ok(r1.hunt.markersMeta);
    assert.strictEqual(r1.hunt.markersMeta.markersId, 'cave_clickies');
    assert.ok(
        (r1.hunt.markersMeta.poolCounts.A || 0) +
            (r1.hunt.markersMeta.poolCounts.B || 0) >=
            1,
        'at least one pool placed props'
    );

    log('legacy marker preset ok', {
        props: r1.props.length,
        pools: r1.hunt.markersMeta.poolCounts
    });
}

async function testStandardHeadless() {
    setActiveMode('standard');
    // Pin starter_duo: mode default balance_quartet stalls on small_crawl
    // before micro-loop prop pickup (propsUsed stays 0).
    const huntInput = {
        seed: 42,
        huntId: 'cave_crawl_generated',
        partyId: 'starter_duo',
        frames: 8000
    };
    const a = await runHeadlessHunt(huntInput);
    const b = await runHeadlessHunt(huntInput);
    assert.strictEqual(
        stableStringify(summaryCore(a)),
        stableStringify(summaryCore(b)),
        'same seed ⇒ same summary core (marker hunt)'
    );
    assert.ok(a.propsSpawned >= 1, 'props spawned in session');
    assert.ok(
        a.propsUsed >= 1,
        'party auto-used at least one prop (micro-loop)'
    );
    const propEvents = (a.pacing && a.pacing.events
        ? a.pacing.events
        : []
    ).filter((e) => e.kind === 'prop' || e.kind === 'well');
    assert.ok(propEvents.length >= 1, 'telemetry prop/well events');
    log('standard headless markers ok', {
        state: a.sessionState,
        propsSpawned: a.propsSpawned,
        propsUsed: a.propsUsed,
        kills: a.kills,
        propEvents: propEvents.length
    });
}

async function testLegacyHeadless() {
    if (!hasMode('legacy')) return;
    setActiveMode('legacy');
    const summary = await runHeadlessHunt({
        seed: 7,
        huntId: 'cave_crawl_generated',
        frames: 4000,
        maxSeconds: 25
    });
    assert.ok(summary);
    assert.ok(typeof summary.propsSpawned === 'number');
    assert.ok(summary.propsSpawned >= 1);
    assert.ok(summary.pacing);
    log('legacy headless markers ok', {
        state: summary.sessionState,
        propsSpawned: summary.propsSpawned,
        propsUsed: summary.propsUsed,
        kills: summary.kills
    });
}

function testEntityMarkersHoverHighlight() {
    const { uiState } = require('../kernel/apps/game/ui_state.js');
    const { EntityMarkersScript } = require('../kernel/core/scripts/entity_markers.js');
    
    uiState.hoveredEntityKey = null;
    uiState.hoveredEntityId = null;
    uiState.hoveredEntity = null;

    const mockEntity = {
        id: 101,
        name: 'Goblin Scout',
        tile: { x: 5, y: 5, z: 0 },
        alive: true,
        hp: { current: 30, max: 30 }
    };
    const mockSim = {
        tileMap: { _viewOriginX: 0, _viewOriginY: 0, _viewCols: 20, _viewRows: 20, _viewZ: '0' },
        creatures: [mockEntity],
        parties: [],
        props: [],
        getCameraFocusMember: () => null
    };

    const markersScript = new EntityMarkersScript({ getSim: () => mockSim });

    let strokeStyles = [];
    const mockCtx = {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        shadowColor: '',
        shadowBlur: 0,
        globalAlpha: 1,
        font: '',
        textAlign: '',
        textBaseline: '',
        fillRect: () => {},
        strokeRect: (x, y, w, h) => {
            strokeStyles.push(mockCtx.strokeStyle);
        },
        strokeText: () => {},
        fillText: () => {},
        save: () => {},
        restore: () => {},
        beginPath: () => {},
        ellipse: () => {},
        fill: () => {}
    };

    // Before hover: no #ffd700 highlight stroke
    strokeStyles = [];
    markersScript.onGUI(mockCtx);
    assert.strictEqual(strokeStyles.includes('#ffd700'), false, 'no gold hover stroke when nothing hovered');

    // Set hover state for mockEntity
    uiState.hoveredEntityId = 101;
    strokeStyles = [];
    markersScript.onGUI(mockCtx);
    assert.strictEqual(strokeStyles.includes('#ffd700'), true, 'gold hover stroke present when entity hovered');

    // Clean up hover state
    uiState.hoveredEntityId = null;
    log('hover highlight unit test ok');
}

async function main() {
    testNormalizeAndResolveUnit();
    testExplicitPropsWin();
    testStandardMarkerPreset();
    testLegacyMarkerPreset();
    testEntityMarkersHoverHighlight();
    await testStandardHeadless();
    await testLegacyHeadless();
    console.log('markers: ok');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
