/**
 * Pure shape catalog / getAreaArray / getAffectedTiles (Designer + combat AoE).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    getAreaArray,
    matrixFromShape,
    listShapeCatalog,
    catalogIdForShape,
    formatShapeSummary,
    matrixToAscii,
    getAffectedTiles,
    hasLineOfSight,
    entitiesOnTiles,
    findTopAreaCenters,
    findOriginInMatrix,
    cardinalDirection,
    octantDirection,
    rotateOffset,
    areaShapeUsesDirection,
    mirrorMatrix,
    flipMatrix,
    orientDiagonalWallMatrix
} = require('../kernel/core/lib/shapes.js');

function hasOrigin(matrix) {
    return matrix.some((row) => row.some((c) => c === 3 || c === 2));
}

function testAreaMatrices() {
    const m5 = getAreaArray('area', 5);
    assert.ok(Array.isArray(m5) && m5.length === 7);
    assert.ok(hasOrigin(m5));

    const single = getAreaArray('area', 1);
    assert.deepStrictEqual(single, [[3]]);

    const ew = getAreaArray('area', 'glacial_cataclysm');
    assert.ok(ew.length === 11);
    assert.ok(hasOrigin(ew));

    const fromShape = matrixFromShape({ type: 'area', code: 3 });
    assert.strictEqual(fromShape.length, 3);
    assert.ok(hasOrigin(fromShape));
}

function testWaveMatrices() {
    const beam = getAreaArray('wave', { spread: 0, length: 4 });
    assert.deepStrictEqual(beam, [[3, 1, 1, 1]]);

    const wave = getAreaArray('wave', { spread: 2, length: 4 });
    assert.ok(wave.length === 5);
    assert.ok(hasOrigin(wave));

    const custom = getAreaArray('wave', {
        type: 'wave',
        spread: 'custom',
        length: 'rapid_strikes'
    });
    assert.ok(custom.length === 5, 'legacy flurry east has 5 rows');
    assert.ok(hasOrigin(custom));

    const bb = getAreaArray('wave', {
        type: 'wave',
        spread: 'custom',
        length: 'even_contest'
    });
    assert.ok(bb.length === 13);
    assert.ok(hasOrigin(bb));
    const bbOrigin = findOriginInMatrix(bb);
    assert.ok(bbOrigin && bbOrigin.cell === 2, 'even_contest origin is cell 2');
    assert.strictEqual(bb[bbOrigin.row][bbOrigin.col], 2);
    // Origin row: [0, 2, 1, …] — front not hit, first hit at origin+1 along axis
    assert.strictEqual(bb[bbOrigin.row][bbOrigin.col + 1], 1);

    const flurry = getAreaArray('wave', {
        type: 'wave',
        spread: 'custom',
        length: 'rapid_strikes'
    });
    const fo = findOriginInMatrix(flurry);
    assert.ok(fo && fo.cell === 3);
    // Legacy flurry: origin is hit; cells behind origin (toward caster) exist as side hits only
    assert.strictEqual(flurry[fo.row][fo.col], 3);

    const empty = getAreaArray('wave', { spread: 99, length: 99 });
    assert.deepStrictEqual(empty, []);
}

/**
 * Legacy-aligned wave footprints (center = caster+facing).
 * even_contest: origin cell 2 not hit; flurry: origin hit, caster tile not hit.
 */
function testLegacyMonkWaveFootprints() {
    const caster = { x: 10, y: 10, z: 7 };
    const front = { x: 11, y: 10, z: 7 };
    const dir = { x: 1, y: 0 };

    const bbTiles = getAffectedTiles({
        caster,
        center: front,
        shape: { type: 'wave', spread: 'custom', length: 'even_contest' },
        direction: dir
    });
    const bbKeys = new Set(bbTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(!bbKeys.has('10,10'), 'bb: caster not hit');
    assert.ok(!bbKeys.has('11,10'), 'bb: front origin (cell 2) not hit');
    assert.ok(bbKeys.has('12,10'), 'bb: first hit one step past origin');

    const flurryTiles = getAffectedTiles({
        caster,
        center: front,
        shape: { type: 'wave', spread: 'custom', length: 'rapid_strikes' },
        direction: dir
    });
    const fk = new Set(flurryTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(fk.has('11,10'), 'flurry: front origin is hit');
    assert.ok(!fk.has('10,10'), 'flurry: caster tile not hit');

    // Berserk / rampage square: center is a hit tile (self filtered at resolve)
    const square = getAffectedTiles({
        caster,
        center: caster,
        shape: { type: 'area', code: 3 }
    });
    assert.ok(square.some((t) => t.x === 10 && t.y === 10), 'square1x1 center hit tile');

    // Wide Takedown: center full + outer 75% (separate matrices, no tile overlap)
    const stCenter = getAffectedTiles({
        caster,
        center: front,
        shape: { type: 'wave', spread: 'custom', length: 'wide_takedown' },
        direction: dir
    });
    const stOuter = getAffectedTiles({
        caster,
        center: front,
        shape: {
            type: 'wave',
            spread: 'custom',
            length: 'wide_takedown_outer'
        },
        direction: dir
    });
    const ck = new Set(stCenter.map((t) => `${t.x},${t.y}`));
    const ok = new Set(stOuter.map((t) => `${t.x},${t.y}`));
    assert.ok(ck.has('11,10'), 'sweeping center: front origin is hit');
    assert.ok(!ok.has('11,10'), 'sweeping outer: origin cell 2 not hit');
    assert.ok(ok.has('13,10') || ok.has('14,10'), 'sweeping outer: forward tiles hit');
    for (const k of ck) {
        assert.ok(!ok.has(k), `center/outer no overlap: ${k}`);
    }
}

function testCatalog() {
    const cat = listShapeCatalog();
    assert.ok(cat.length > 20);
    for (const e of cat) {
        assert.ok(e.id && e.label && e.type && e.shape);
        assert.ok(Array.isArray(e.matrix));
        assert.ok(hasOrigin(e.matrix) || e.matrix.length === 0);
    }

    const gfb = cat.find((e) => e.id === 'area:5');
    assert.ok(gfb);
    assert.strictEqual(gfb.shape.type, 'area');
    assert.strictEqual(gfb.shape.code, 5);

    const wave = cat.find((e) => e.id === 'wave:2:4');
    assert.ok(wave);
    assert.strictEqual(wave.shape.spread, 2);
    assert.strictEqual(wave.shape.length, 4);

    assert.strictEqual(
        catalogIdForShape({ type: 'area', code: 5 }),
        'area:5'
    );
    assert.strictEqual(
        catalogIdForShape({ type: 'wave', spread: 2, length: 4 }),
        'wave:2:4'
    );
    assert.strictEqual(
        catalogIdForShape({ type: 'wave', spread: 'custom', length: 'rapid_strikes' }),
        'wave:custom:rapid_strikes'
    );
}

function testSummaryAndAscii() {
    assert.strictEqual(
        formatShapeSummary({ type: 'area', code: 5 }),
        'area · code 5'
    );
    assert.ok(formatShapeSummary({ type: 'wave', spread: 1, length: 3 }).includes('wave'));
    const ascii = matrixToAscii([[0, 1], [3, 1]]);
    assert.strictEqual(ascii, '.#\n@#');
    assert.strictEqual(matrixToAscii([[2, 0, 1]]), '*.#');
}

function testRotateAndCardinal() {
    assert.deepStrictEqual(cardinalDirection({ x: 0, y: 0 }, { x: 5, y: 1 }), {
        x: 1,
        y: 0
    });
    assert.deepStrictEqual(cardinalDirection({ x: 0, y: 0 }, { x: 1, y: 5 }), {
        x: 0,
        y: 1
    });
    // East authored offset (2,0) → west becomes (-2,0)
    assert.deepStrictEqual(rotateOffset(2, 0, { x: -1, y: 0 }), { x: -2, y: 0 });
    // East (2,0) → north becomes (0,-2)
    assert.deepStrictEqual(rotateOffset(2, 0, { x: 0, y: -1 }), { x: 0, y: -2 });
}

function testGetAffectedTilesArea() {
    // Square 1×1 (code 3): 3×3 centered on origin
    const tiles = getAffectedTiles({
        caster: { x: 10, y: 10, z: 7 },
        center: { x: 10, y: 10, z: 7 },
        shape: { type: 'area', code: 3 }
    });
    assert.strictEqual(tiles.length, 9);
    const keys = new Set(tiles.map((t) => `${t.x},${t.y}`));
    assert.ok(keys.has('10,10'));
    assert.ok(keys.has('9,9'));
    assert.ok(keys.has('11,11'));

    const single = getAffectedTiles({
        center: { x: 5, y: 5, z: 0 },
        shape: { type: 'area', code: 1 }
    });
    assert.deepStrictEqual(single, [{ x: 5, y: 5, z: 0 }]);
}

function testGetAffectedTilesWave() {
    // Beam length 4 facing east: origin + 3 more east of center
    // center is origin cell (3); matrix [[3,1,1,1]]
    const tiles = getAffectedTiles({
        caster: { x: 0, y: 0, z: 7 },
        center: { x: 1, y: 0, z: 7 },
        shape: { type: 'wave', spread: 0, length: 4 },
        direction: { x: 1, y: 0 }
    });
    assert.strictEqual(tiles.length, 4);
    const xs = tiles.map((t) => t.x).sort((a, b) => a - b);
    assert.deepStrictEqual(xs, [1, 2, 3, 4]);

    // Facing west from center
    const west = getAffectedTiles({
        center: { x: 10, y: 5, z: 7 },
        shape: { type: 'wave', spread: 0, length: 3 },
        direction: { x: -1, y: 0 }
    });
    const wxs = west.map((t) => t.x).sort((a, b) => a - b);
    assert.deepStrictEqual(wxs, [8, 9, 10]);
}

function testLineOfSightBlocked() {
    const blocked = {
        getFriction(x, y) {
            // Wall at (2,0)
            if (x === 2 && y === 0) return 255;
            return 0;
        }
    };
    assert.strictEqual(
        hasLineOfSight(0, 0, 7, 1, 0, 7, blocked),
        true,
        'adjacent-ish clear'
    );
    assert.strictEqual(
        hasLineOfSight(0, 0, 7, 4, 0, 7, blocked),
        false,
        'blocked by wall'
    );
    assert.strictEqual(
        hasLineOfSight(0, 0, 7, 4, 0, 7, null),
        true,
        'no map → open'
    );

    // Area filters out blocked tiles
    const foot = getAffectedTiles({
        caster: { x: 5, y: 5, z: 7 },
        center: { x: 5, y: 5, z: 7 },
        shape: { type: 'area', code: 3 },
        tileMap: {
            getFriction(x, y) {
                if (x === 6 && y === 5) return 255;
                return 0;
            }
        }
    });
    assert.ok(!foot.some((t) => t.x === 6 && t.y === 5));
    assert.ok(foot.length < 9);

    // Water: walk blocked, sight open — LoS crosses
    const waterMap = {
        isWalkable(x, y) {
            if (x === 2 && y === 0) return false;
            return true;
        },
        blocksSight(x, y) {
            return false;
        },
        getFriction(x, y) {
            if (x === 2 && y === 0) return 255;
            return 0;
        }
    };
    assert.strictEqual(
        hasLineOfSight(0, 0, 7, 4, 0, 7, waterMap),
        true,
        'LoS over water'
    );

    // Grate: walk open, sight blocked
    const grateMap = {
        isWalkable() {
            return true;
        },
        blocksSight(x, y) {
            return x === 2 && y === 0;
        }
    };
    assert.strictEqual(
        hasLineOfSight(0, 0, 7, 4, 0, 7, grateMap),
        false,
        'LoS blocked by grate'
    );
}

function testEntitiesOnTilesAndCenters() {
    const tiles = [
        { x: 1, y: 1 },
        { x: 2, y: 1 }
    ];
    const ents = [
        { tile: { x: 1, y: 1, z: 7 }, alive: true, hp: { current: 10 } },
        { tile: { x: 9, y: 9, z: 7 }, alive: true, hp: { current: 10 } },
        { tile: { x: 2, y: 1, z: 8 }, alive: true, hp: { current: 10 } }
    ];
    const hit = entitiesOnTiles(ents, tiles, 7);
    assert.strictEqual(hit.length, 1);
    assert.strictEqual(hit[0].tile.x, 1);

    const ranked = findTopAreaCenters(
        { x: 0, y: 0 },
        [
            { tile: { x: 5, y: 5 } },
            { tile: { x: 6, y: 5 } },
            { tile: { x: 5, y: 6 } }
        ],
        { type: 'area', code: 3 },
        3
    );
    assert.ok(ranked.length >= 1);
    assert.ok(ranked[0].hits >= 3, `best hits ${ranked[0].hits}`);
}

function testWallFieldMatrices() {
    const wall = getAreaArray('area', 'wall_field');
    assert.deepStrictEqual(wall, [[1, 1, 3, 1, 1]]);
    assert.ok(hasOrigin(wall));
    assert.strictEqual(matrixToAscii(wall), '##@##');

    const energy = getAreaArray('area', 'wall_field_energy');
    assert.deepStrictEqual(energy, [[1, 1, 1, 3, 1, 1, 1]]);
    assert.ok(hasOrigin(energy));
    assert.strictEqual(matrixToAscii(energy), '###@###');

    assert.ok(areaShapeUsesDirection({ type: 'area', code: 'wall_field' }));
    assert.ok(areaShapeUsesDirection({ type: 'area', code: 'wall_field_energy' }));
    assert.ok(!areaShapeUsesDirection({ type: 'area', code: 5 }));

    const cat = listShapeCatalog();
    const wallEntry = cat.find((e) => e.id === 'area:wall_field');
    const energyEntry = cat.find((e) => e.id === 'area:wall_field_energy');
    assert.ok(wallEntry, 'catalog lists wall_field');
    assert.ok(energyEntry, 'catalog lists wall_field_energy');
    assert.strictEqual(catalogIdForShape({ type: 'area', code: 'wall_field' }), 'area:wall_field');

    // Default east: horizontal 5-tile line through center
    const east = getAffectedTiles({
        center: { x: 10, y: 10, z: 7 },
        shape: { type: 'area', code: 'wall_field' },
        direction: { x: 1, y: 0 }
    });
    assert.strictEqual(east.length, 5);
    const eastKeys = new Set(east.map((t) => `${t.x},${t.y}`));
    assert.deepStrictEqual(
        [...eastKeys].sort(),
        ['10,10', '11,10', '12,10', '8,10', '9,10'].sort()
    );

    // North facing rotates line to vertical
    const north = getAffectedTiles({
        center: { x: 10, y: 10, z: 7 },
        shape: { type: 'area', code: 'wall_field' },
        direction: { x: 0, y: -1 }
    });
    assert.strictEqual(north.length, 5);
    const northKeys = new Set(north.map((t) => `${t.x},${t.y}`));
    assert.deepStrictEqual(
        [...northKeys].sort(),
        ['10,10', '10,11', '10,12', '10,8', '10,9'].sort()
    );

    const energyTiles = getAffectedTiles({
        center: { x: 0, y: 0, z: 0 },
        shape: { type: 'area', code: 'wall_field_energy' },
        direction: { x: 1, y: 0 }
    });
    assert.strictEqual(energyTiles.length, 7);
}

function testDiagonalWallMatrices() {
    const diag = getAreaArray('area', 'wall_field_diag');
    assert.deepStrictEqual(diag, [
        [0, 0, 0, 0, 1],
        [0, 0, 0, 1, 1],
        [0, 1, 3, 1, 0],
        [1, 1, 0, 0, 0],
        [1, 0, 0, 0, 0]
    ]);
    assert.ok(hasOrigin(diag));
    assert.strictEqual(
        matrixToAscii(diag),
        ['....#', '...##', '.#@#.', '##...', '#....'].join('\n')
    );

    const energyDiag = getAreaArray('area', 'wall_field_energy_diag');
    assert.deepStrictEqual(energyDiag, [
        [0, 0, 0, 0, 0, 0, 1],
        [0, 0, 0, 0, 0, 1, 1],
        [0, 0, 0, 0, 1, 1, 0],
        [0, 0, 1, 3, 1, 0, 0],
        [0, 1, 1, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0, 0, 0]
    ]);
    assert.ok(hasOrigin(energyDiag));

    const cat = listShapeCatalog();
    assert.ok(cat.find((e) => e.id === 'area:wall_field_diag'));
    assert.ok(cat.find((e) => e.id === 'area:wall_field_energy_diag'));

    // Legacy setupExtArea: NW base → NE mirror / SW flip / SE mirror(flip)
    const nw = diag;
    assert.deepStrictEqual(orientDiagonalWallMatrix(nw, { x: -1, y: -1 }), nw);
    assert.deepStrictEqual(
        orientDiagonalWallMatrix(nw, { x: 1, y: -1 }),
        mirrorMatrix(nw)
    );
    assert.deepStrictEqual(
        orientDiagonalWallMatrix(nw, { x: -1, y: 1 }),
        flipMatrix(nw)
    );
    assert.deepStrictEqual(
        orientDiagonalWallMatrix(nw, { x: 1, y: 1 }),
        mirrorMatrix(flipMatrix(nw))
    );

    // 8-dir facing: off-axis (any both-nonzero) is diagonal, not 4-way collapse
    assert.deepStrictEqual(octantDirection({ x: 0, y: 0 }, { x: 3, y: 1 }), {
        x: 1,
        y: 1
    });
    assert.deepStrictEqual(octantDirection({ x: 5, y: 5 }, { x: 2, y: 1 }), {
        x: -1,
        y: -1
    });
    assert.deepStrictEqual(octantDirection({ x: 0, y: 0 }, { x: 4, y: 0 }), {
        x: 1,
        y: 0
    });
    // cardinalDirection would pick E here (|dx|>|dy|); octant keeps SE
    assert.deepStrictEqual(cardinalDirection({ x: 0, y: 0 }, { x: 3, y: 1 }), {
        x: 1,
        y: 0
    });

    // NW diagonal footprint via wall_field (auto companion pick)
    const nwTiles = getAffectedTiles({
        center: { x: 10, y: 10, z: 7 },
        shape: { type: 'area', code: 'wall_field' },
        direction: { x: -1, y: -1 }
    });
    assert.strictEqual(nwTiles.length, 9, 'NW stair has 9 hit cells');
    const nwKeys = new Set(nwTiles.map((t) => `${t.x},${t.y}`));
    // Relative to origin: see AREA_DIAGONAL_WALLFIELD
    for (const key of [
        '10,10',
        '12,8',
        '11,9',
        '12,9',
        '9,10',
        '11,10',
        '8,11',
        '9,11',
        '8,12'
    ]) {
        assert.ok(nwKeys.has(key), `NW wall missing ${key}`);
    }
    // Must not collapse to pure axis-aligned 5-line
    assert.ok(!nwKeys.has('10,8') || nwKeys.size > 5);
    assert.ok(
        nwKeys.has('12,8') && nwKeys.has('8,12'),
        'NW stair corners present'
    );

    // SE is 180° of NW for this matrix (same stair family as NW)
    const seTiles = getAffectedTiles({
        center: { x: 10, y: 10, z: 7 },
        shape: { type: 'area', code: 'wall_field' },
        direction: { x: 1, y: 1 }
    });
    assert.strictEqual(seTiles.length, 9);

    // NE stair is the other diagonal orientation
    const neTiles = getAffectedTiles({
        center: { x: 10, y: 10, z: 7 },
        shape: { type: 'area', code: 'wall_field' },
        direction: { x: 1, y: -1 }
    });
    assert.strictEqual(neTiles.length, 9);
    const neKeys = new Set(neTiles.map((t) => `${t.x},${t.y}`));
    assert.ok(neKeys.has('8,8') && neKeys.has('12,12'), 'NE stair corners');

    // Energy diagonal: 12 hit cells (1+3 in Legacy 7×7 stair)
    const energyNw = getAffectedTiles({
        center: { x: 0, y: 0, z: 0 },
        shape: { type: 'area', code: 'wall_field_energy' },
        direction: { x: -1, y: -1 }
    });
    assert.strictEqual(energyNw.length, 12);

    // Cardinal regression: pure E still 5-line (not stair)
    const east = getAffectedTiles({
        center: { x: 10, y: 10, z: 7 },
        shape: { type: 'area', code: 'wall_field' },
        direction: { x: 1, y: 0 }
    });
    assert.strictEqual(east.length, 5);
    assert.deepStrictEqual(
        [...new Set(east.map((t) => `${t.x},${t.y}`))].sort(),
        ['10,10', '11,10', '12,10', '8,10', '9,10'].sort()
    );
}

function testEnergyBeamShapes() {
    const beam5 = matrixFromShape({ type: 'wave', spread: 0, length: 5 });
    assert.deepStrictEqual(beam5, [[3, 1, 1, 1, 1]]);
    assert.ok(hasOrigin(beam5));

    const beam8 = matrixFromShape({ type: 'wave', spread: 0, length: 8 });
    assert.deepStrictEqual(beam8, [[3, 1, 1, 1, 1, 1, 1, 1]]);
    assert.ok(hasOrigin(beam8));

    // Former bug: spread 1 has no length 5/8 → empty
    assert.deepStrictEqual(matrixFromShape({ type: 'wave', spread: 1, length: 5 }), []);
    assert.deepStrictEqual(matrixFromShape({ type: 'wave', spread: 1, length: 8 }), []);

    const foot5 = getAffectedTiles({
        center: { x: 1, y: 0, z: 7 },
        shape: { type: 'wave', spread: 0, length: 5 },
        direction: { x: 1, y: 0 }
    });
    assert.strictEqual(foot5.length, 5);

    const foot8 = getAffectedTiles({
        center: { x: 1, y: 0, z: 7 },
        shape: { type: 'wave', spread: 0, length: 8 },
        direction: { x: 1, y: 0 }
    });
    assert.strictEqual(foot8.length, 8);
}

/**
 * Guardrail: every shaped entry in standard spells.json must resolve to a
 * non-empty matrix with an origin cell (2 or 3).
 */
function testAllStandardSpellShapesResolve() {
    const spellsPath = path.join(
        __dirname,
        '..',
        'presets',
        'standard',
        'spells.json'
    );
    const pack = JSON.parse(fs.readFileSync(spellsPath, 'utf8'));
    const spells = Array.isArray(pack.spells) ? pack.spells : pack;
    assert.ok(Array.isArray(spells) && spells.length > 0);

    let shaped = 0;
    for (const spell of spells) {
        if (!spell || !spell.shape || typeof spell.shape !== 'object') continue;
        shaped += 1;
        const matrix = matrixFromShape(spell.shape);
        assert.ok(
            Array.isArray(matrix) && matrix.length > 0,
            `spell ${spell.id} shape resolves empty: ${JSON.stringify(spell.shape)}`
        );
        assert.ok(
            hasOrigin(matrix),
            `spell ${spell.id} shape missing origin cell (2/3)`
        );
    }
    assert.ok(shaped >= 1, 'expected at least one shaped spell in standard pack');

    // Explicit regression for the beam fix
    const energyBeam = spells.find((s) => s.id === 'energy_beam');
    const greatBeam = spells.find((s) => s.id === 'great_energy_beam');
    assert.ok(energyBeam && energyBeam.shape);
    assert.strictEqual(energyBeam.shape.spread, 0);
    assert.strictEqual(energyBeam.shape.length, 5);
    assert.ok(greatBeam && greatBeam.shape);
    assert.strictEqual(greatBeam.shape.spread, 0);
    assert.strictEqual(greatBeam.shape.length, 8);
}

function main() {
    testAreaMatrices();
    testWaveMatrices();
    testLegacyMonkWaveFootprints();
    testCatalog();
    testSummaryAndAscii();
    testRotateAndCardinal();
    testGetAffectedTilesArea();
    testGetAffectedTilesWave();
    testLineOfSightBlocked();
    testEntitiesOnTilesAndCenters();
    testWallFieldMatrices();
    testDiagonalWallMatrices();
    testEnergyBeamShapes();
    testAllStandardSpellShapesResolve();
    console.log('shapes: ok');
}

main();
