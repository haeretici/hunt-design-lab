#!/usr/bin/env node
/**
 * PHP legacy map packs: list/resolve (M2) + create (M4). Does not mutate v01.
 */

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'assets/legacy/maps/manifest.json');

/**
 * @param {string} phpBody
 * @returns {unknown}
 */
function phpEval(phpBody) {
    const php = `
require '${ROOT.replace(/\\/g, '/')}/php/bootstrap.php';
${phpBody}
`;
    const out = execFileSync('php', ['-r', php], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        cwd: ROOT
    });
    return JSON.parse(out);
}

/**
 * @param {string} name
 * @param {() => void} fn
 */
let failed = 0;
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('ok', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

function main() {
    test('listMaps returns v01', () => {
        const data = phpEval(`
echo json_encode(\\De\\LegacyMapEditor::listMaps());
`);
        assert.strictEqual(data.defaultId, 'v01');
        assert.ok(Array.isArray(data.maps));
        const v01 = data.maps.find((m) => m && m.id === 'v01');
        assert.ok(v01, 'v01 listed');
        assert.ok(typeof v01.label === 'string' && v01.label.length > 0);
        assert.ok(!('folder' in v01));
    });

    test('resolvePack omit / unknown-read / invalid / unknown-write', () => {
        const data = phpEval(`
$out = [];
$out['omit'] = \\De\\LegacyMapEditor::resolvePack();
$out['unknownRead'] = \\De\\LegacyMapEditor::resolvePack('missing_pack', false);
try {
    \\De\\LegacyMapEditor::resolvePack('V01');
    $out['invalid'] = null;
} catch (\\InvalidArgumentException $e) {
    $out['invalid'] = $e->getMessage();
}
try {
    \\De\\LegacyMapEditor::resolvePack('../x');
    $out['traverse'] = null;
} catch (\\InvalidArgumentException $e) {
    $out['traverse'] = $e->getMessage();
}
try {
    \\De\\LegacyMapEditor::resolvePack('missing_pack', true);
    $out['unknownWrite'] = null;
} catch (\\InvalidArgumentException $e) {
    $out['unknownWrite'] = $e->getMessage();
}
$out['v01'] = \\De\\LegacyMapEditor::resolvePack('v01', true);
echo json_encode($out);
`);
        assert.strictEqual(data.omit.id, 'v01');
        assert.strictEqual(data.omit.mapsRel, 'assets/legacy/maps/v01');
        assert.strictEqual(data.unknownRead.id, 'v01');
        assert.ok(data.invalid && /invalid map id/i.test(data.invalid));
        assert.ok(data.traverse && /invalid map id/i.test(data.traverse));
        assert.ok(data.unknownWrite && /unknown map id/i.test(data.unknownWrite));
        assert.strictEqual(data.v01.id, 'v01');
        assert.strictEqual(data.v01.mapsRel, 'assets/legacy/maps/v01');
        assert.strictEqual(data.v01.spawnsRel, 'assets/legacy/maps/v01/spawns');
    });

    test('loadHybrid mapId=v01 round-trips pack path', () => {
        const data = phpEval(`
echo json_encode(\\De\\LegacyMapEditor::loadHybrid(['floor' => '07', 'mapId' => 'v01']));
`);
        assert.strictEqual(data.success, true);
        assert.strictEqual(data.mapId, 'v01');
        assert.strictEqual(data.floor, '07');
        if (data.present) {
            assert.ok(
                String(data.dir).includes('assets/legacy/maps/v01/hybrid/floor-07'),
                'hybrid dir under maps/v01'
            );
        }
    });

    test('saveSpawns refuses unknown / invalid mapId (no write)', () => {
        const data = phpEval(`
$out = [];
try {
    \\De\\LegacyMapEditor::saveSpawns([
        'mapId' => 'not_a_pack',
        'floor' => '07',
        'spawns' => [],
    ]);
    $out['unknown'] = null;
} catch (\\InvalidArgumentException $e) {
    $out['unknown'] = $e->getMessage();
}
try {
    \\De\\LegacyMapEditor::saveSpawns([
        'mapId' => '../x',
        'floor' => '07',
        'spawns' => [],
    ]);
    $out['traverse'] = null;
} catch (\\InvalidArgumentException $e) {
    $out['traverse'] = $e->getMessage();
}
echo json_encode($out);
`);
        assert.ok(data.unknown && /unknown map id/i.test(data.unknown));
        assert.ok(data.traverse && /invalid map id/i.test(data.traverse));
    });

    test('createMap rejects invalid / duplicate ids (no write)', () => {
        const orig = fs.readFileSync(MANIFEST_PATH, 'utf8');
        const data = phpEval(`
$out = [];
foreach (['', '../x', 'V01', 'v01'] as $id) {
    try {
        \\De\\LegacyMapEditor::createMap(['id' => $id, 'width' => 8, 'height' => 8]);
        $out[$id === '' ? 'empty' : $id] = null;
    } catch (\\InvalidArgumentException $e) {
        $out[$id === '' ? 'empty' : $id] = $e->getMessage();
    }
}
try {
    \\De\\LegacyMapEditor::createMap(['id' => 'room_ok', 'width' => 7, 'height' => 8]);
    $out['tinyW'] = null;
} catch (\\InvalidArgumentException $e) {
    $out['tinyW'] = $e->getMessage();
}
try {
    \\De\\LegacyMapEditor::createMap(['id' => 'room_ok', 'width' => 8, 'height' => 2049]);
    $out['hugeH'] = null;
} catch (\\InvalidArgumentException $e) {
    $out['hugeH'] = $e->getMessage();
}
echo json_encode($out);
`);
        assert.ok(data.empty && /invalid map id/i.test(data.empty));
        assert.ok(data['../x'] && /invalid map id/i.test(data['../x']));
        assert.ok(data.V01 && /invalid map id/i.test(data.V01));
        assert.ok(data.v01 && /already exists/i.test(data.v01));
        assert.ok(data.tinyW && /width/i.test(data.tinyW));
        assert.ok(data.hugeH && /height/i.test(data.hugeH));
        assert.strictEqual(fs.readFileSync(MANIFEST_PATH, 'utf8'), orig);
        assert.ok(!fs.existsSync(path.join(ROOT, 'assets/legacy/maps/room_ok')));
    });

    test('createMap writes yellow pack + manifest, then test deletes it', () => {
        const id = 'hdl_m4_tmp';
        const packDir = path.join(ROOT, 'assets/legacy/maps', id);
        fs.rmSync(packDir, { recursive: true, force: true });
        let orig = fs.readFileSync(MANIFEST_PATH, 'utf8');
        const live = JSON.parse(orig);
        const maps = (live.maps || []).filter((m) => !m || m.id !== id);
        if (maps.length !== (live.maps || []).length) {
            live.maps = maps;
            orig = JSON.stringify(live, null, 4) + '\n';
            fs.writeFileSync(MANIFEST_PATH, orig);
        }
        try {
            const data = phpEval(`
$created = \\De\\LegacyMapEditor::createMap([
    'id' => 'hdl_m4_tmp',
    'label' => 'M4 throwaway',
    'width' => 8,
    'height' => 8,
]);
$png = HDL_ROOT . '/assets/legacy/maps/hdl_m4_tmp/floor-07-path.png';
$im = imagecreatefrompng($png);
$rgb = imagecolorat($im, 0, 0);
if (imageistruecolor($im)) {
    $created['pixel'] = [($rgb >> 16) & 255, ($rgb >> 8) & 255, $rgb & 255];
} else {
    $c = imagecolorsforindex($im, $rgb);
    $created['pixel'] = [$c['red'], $c['green'], $c['blue']];
}
imagedestroy($im);
$created['pngW'] = getimagesize($png)[0];
$created['pngH'] = getimagesize($png)[1];
$created['listed'] = \\De\\LegacyMapEditor::listMaps();
$created['resolved'] = \\De\\LegacyMapEditor::resolvePack('hdl_m4_tmp', true);
echo json_encode($created);
`);
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.id, id);
            assert.strictEqual(data.label, 'M4 throwaway');
            assert.strictEqual(data.mapsRel, 'assets/legacy/maps/hdl_m4_tmp');
            assert.strictEqual(data.width, 8);
            assert.strictEqual(data.height, 8);
            assert.strictEqual(data.pngW, 8);
            assert.strictEqual(data.pngH, 8);
            assert.deepStrictEqual(data.pixel, [255, 255, 0]);
            assert.ok(fs.existsSync(path.join(packDir, 'bounds.json')));
            assert.ok(fs.existsSync(path.join(packDir, 'spawns/index.json')));
            assert.ok(!fs.existsSync(path.join(packDir, 'hybrid')));
            assert.ok(!fs.existsSync(path.join(packDir, 'navmesh')));
            assert.ok(!fs.existsSync(path.join(packDir, 'REFERENCE.md')));
            for (let z = 0; z <= 15; z++) {
                const pad = String(z).padStart(2, '0');
                assert.ok(fs.existsSync(path.join(packDir, `floor-${pad}-path.png`)));
                const spawn = JSON.parse(
                    fs.readFileSync(path.join(packDir, 'spawns/by_floor', `${pad}.json`), 'utf8')
                );
                assert.strictEqual(spawn.floor, z);
                assert.strictEqual(spawn.count, 0);
                assert.deepStrictEqual(spawn.spawns, []);
            }
            const bounds = JSON.parse(fs.readFileSync(path.join(packDir, 'bounds.json'), 'utf8'));
            assert.strictEqual(bounds.xMin, 0);
            assert.strictEqual(bounds.yMin, 0);
            assert.strictEqual(bounds.xMax, 8);
            assert.strictEqual(bounds.yMax, 8);
            assert.strictEqual(bounds.width, 8);
            assert.strictEqual(bounds.height, 8);
            assert.strictEqual(bounds.zMin, 0);
            assert.strictEqual(bounds.zMax, 15);
            assert.strictEqual(bounds.floorIDs.length, 16);
            const listed = data.listed.maps.find((m) => m && m.id === id);
            assert.ok(listed, 'new id listed in manifest');
            assert.strictEqual(listed.label, 'M4 throwaway');
            assert.strictEqual(data.resolved.id, id);
            assert.strictEqual(data.resolved.mapsRel, 'assets/legacy/maps/hdl_m4_tmp');
            const dup = phpEval(`
try {
    \\De\\LegacyMapEditor::createMap(['id' => 'hdl_m4_tmp', 'width' => 8, 'height' => 8]);
    echo json_encode(['msg' => null]);
} catch (\\InvalidArgumentException $e) {
    echo json_encode(['msg' => $e->getMessage()]);
}
`);
            assert.ok(dup.msg && /already exists/i.test(dup.msg));
        } finally {
            fs.rmSync(packDir, { recursive: true, force: true });
            fs.writeFileSync(MANIFEST_PATH, orig);
        }
        const after = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        assert.ok(!(after.maps || []).some((m) => m && m.id === id));
        assert.ok(!fs.existsSync(packDir));
    });

    test('createMap fromSelection crops PNG, spawns, hybrid; rejects bad origin', () => {
        const srcId = 'hdl_src_sel';
        const dstId = 'hdl_dst_sel';
        const srcDir = path.join(ROOT, 'assets/legacy/maps', srcId);
        const dstDir = path.join(ROOT, 'assets/legacy/maps', dstId);
        const orig = fs.readFileSync(MANIFEST_PATH, 'utf8');
        fs.rmSync(srcDir, { recursive: true, force: true });
        fs.rmSync(dstDir, { recursive: true, force: true });
        try {
            const data = phpEval(`
$srcId = 'hdl_src_sel';
$dstId = 'hdl_dst_sel';
$srcDir = HDL_ROOT . '/assets/legacy/maps/' . $srcId;
\\De\\LegacyMapEditor::createMap([
    'id' => $srcId,
    'label' => 'Crop source',
    'width' => 16,
    'height' => 16,
]);
$png = $srcDir . '/floor-07-path.png';
$im = imagecreatefrompng($png);
$cyan = imagecolorallocate($im, 0, 255, 255);
imagesetpixel($im, 5, 6, $cyan);
imagepng($im, $png);
imagedestroy($im);
\\De\\JsonFile::write($srcDir . '/spawns/by_floor/07.json', [
    'floor' => 7,
    'count' => 2,
    'spawns' => [
        ['creatureId' => 'wolf', 'x' => 5, 'y' => 6, 'z' => 7, 'respawn' => 60],
        ['creatureId' => 'bear', 'x' => 0, 'y' => 0, 'z' => 7, 'respawn' => 60],
    ],
]);
$n = 16 * 16;
$fr = str_repeat("\\xFF", $n);
$fr[6 * 16 + 5] = "\\x64";
$gz = gzencode($fr, 6);
$hy = $srcDir . '/hybrid/floor-07/floors/7';
if (!is_dir($hy)) {
    mkdir($hy, 0775, true);
}
file_put_contents($hy . '/friction.u8.gz', $gz);
\\De\\JsonFile::write($srcDir . '/hybrid/floor-07/map.json', [
    'version' => 2,
    'id' => $srcId,
    'label' => 'Crop source',
    'floors' => [[
        'z' => 7,
        'cols' => 16,
        'rows' => 16,
        'palette' => [null],
        'subLayers' => [
            ['id' => 'ground', 'zOrder' => 0, 'blob' => null, 'empty' => true],
        ],
        'channels' => ['friction' => 'floors/7/friction.u8.gz'],
        'overrideMask' => null,
        'stairs' => [
            ['x' => 5, 'y' => 6, 'z' => 7, 'dir' => 'center', 'type' => 'stairs', 'deltaZ' => -1, 'to' => ['x' => 5, 'y' => 6, 'z' => 6]],
            ['x' => 7, 'y' => 7, 'z' => 7, 'dir' => 'south', 'type' => 'stairs', 'deltaZ' => -1, 'to' => ['x' => 0, 'y' => 0, 'z' => 6]],
        ],
    ]],
    'spawns' => [
        ['creatureId' => 'wolf', 'x' => 5, 'y' => 6, 'z' => 7, 'respawn' => 60],
        ['creatureId' => 'bear', 'x' => 0, 'y' => 0, 'z' => 7, 'respawn' => 60],
    ],
    'world' => [
        ['id' => 'crate_a', 'kind' => 'container', 'catalogId' => 'crate', 'x' => 5, 'y' => 6, 'z' => 7],
        ['id' => 'crate_b', 'kind' => 'container', 'catalogId' => 'crate', 'x' => 1, 'y' => 1, 'z' => 7],
    ],
]);
$created = \\De\\LegacyMapEditor::createMap([
    'id' => $dstId,
    'label' => 'Crop dest',
    'width' => 8,
    'height' => 8,
    'fromSelection' => true,
    'sourceMapId' => $srcId,
    'x' => 4,
    'y' => 4,
]);
$outPng = HDL_ROOT . '/assets/legacy/maps/' . $dstId . '/floor-07-path.png';
$im2 = imagecreatefrompng($outPng);
$rgb = imagecolorat($im2, 1, 2);
if (imageistruecolor($im2)) {
    $created['pixel'] = [($rgb >> 16) & 255, ($rgb >> 8) & 255, $rgb & 255];
} else {
    $c = imagecolorsforindex($im2, $rgb);
    $created['pixel'] = [$c['red'], $c['green'], $c['blue']];
}
imagedestroy($im2);
$created['pngW'] = getimagesize($outPng)[0];
$created['pngH'] = getimagesize($outPng)[1];
$by = json_decode(file_get_contents(HDL_ROOT . '/assets/legacy/maps/' . $dstId . '/spawns/by_floor/07.json'), true);
$created['spawnCount'] = $by['count'];
$created['spawn'] = $by['spawns'][0] ?? null;
$hyMeta = json_decode(file_get_contents(HDL_ROOT . '/assets/legacy/maps/' . $dstId . '/hybrid/floor-07/map.json'), true);
$created['hyCols'] = $hyMeta['floors'][0]['cols'];
$created['hyRows'] = $hyMeta['floors'][0]['rows'];
$created['hyId'] = $hyMeta['id'];
$created['stairs'] = $hyMeta['floors'][0]['stairs'];
$created['world'] = $hyMeta['world'];
$created['hySpawns'] = $hyMeta['spawns'];
$frGz = file_get_contents(HDL_ROOT . '/assets/legacy/maps/' . $dstId . '/hybrid/floor-07/floors/7/friction.u8.gz');
$frRaw = gzdecode($frGz);
$created['frictionAt'] = ord($frRaw[2 * 8 + 1]);
$created['frictionLen'] = strlen($frRaw);
$idx = json_decode(file_get_contents(HDL_ROOT . '/assets/legacy/maps/' . $dstId . '/spawns/index.json'), true);
$created['indexTotal'] = $idx['total'];
$created['creatureIds'] = $idx['creatureIds'];
try {
    \\De\\LegacyMapEditor::createMap([
        'id' => 'hdl_bad_sel',
        'width' => 8,
        'height' => 8,
        'fromSelection' => true,
        'sourceMapId' => $srcId,
        'x' => 16,
        'y' => 0,
    ]);
    $created['oob'] = null;
} catch (\\InvalidArgumentException $e) {
    $created['oob'] = $e->getMessage();
}
try {
    \\De\\LegacyMapEditor::createMap([
        'id' => 'hdl_bad_sel2',
        'width' => 8,
        'height' => 8,
        'fromSelection' => true,
        'sourceMapId' => '',
        'x' => 0,
        'y' => 0,
    ]);
    $created['noSrc'] = null;
} catch (\\InvalidArgumentException $e) {
    $created['noSrc'] = $e->getMessage();
}
echo json_encode($created);
`);
            assert.strictEqual(data.success, true);
            assert.strictEqual(data.id, dstId);
            assert.strictEqual(data.fromSelection, true);
            assert.strictEqual(data.sourceMapId, srcId);
            assert.strictEqual(data.x, 4);
            assert.strictEqual(data.y, 4);
            assert.strictEqual(data.width, 8);
            assert.strictEqual(data.height, 8);
            assert.strictEqual(data.pngW, 8);
            assert.strictEqual(data.pngH, 8);
            assert.deepStrictEqual(data.pixel, [0, 255, 255]);
            assert.strictEqual(data.spawnCount, 1);
            assert.strictEqual(data.spawn.creatureId, 'wolf');
            assert.strictEqual(data.spawn.x, 1);
            assert.strictEqual(data.spawn.y, 2);
            assert.strictEqual(data.hyCols, 8);
            assert.strictEqual(data.hyRows, 8);
            assert.strictEqual(data.hyId, dstId);
            assert.strictEqual(data.frictionLen, 64);
            assert.strictEqual(data.frictionAt, 0x64);
            assert.strictEqual(data.indexTotal, 1);
            assert.deepStrictEqual(data.creatureIds, ['wolf']);
            assert.strictEqual(data.hySpawns.length, 1);
            assert.strictEqual(data.hySpawns[0].x, 1);
            assert.strictEqual(data.hySpawns[0].y, 2);
            assert.ok(Array.isArray(data.stairs));
            const inHop = data.stairs.find((s) => s && s.x === 1 && s.y === 2);
            assert.ok(inHop);
            assert.deepStrictEqual(inHop.to, { x: 1, y: 2, z: 6 });
            const edgeHop = data.stairs.find((s) => s && s.x === 3 && s.y === 3);
            assert.ok(edgeHop);
            assert.ok(edgeHop.to == null);
            assert.strictEqual(data.world.length, 1);
            assert.strictEqual(data.world[0].x, 1);
            assert.strictEqual(data.world[0].y, 2);
            assert.ok(data.oob && /outside/i.test(data.oob));
            assert.ok(data.noSrc && /sourceMapId/i.test(data.noSrc));
            assert.ok(!fs.existsSync(path.join(ROOT, 'assets/legacy/maps', 'hdl_bad_sel')));
        } finally {
            fs.rmSync(srcDir, { recursive: true, force: true });
            fs.rmSync(dstDir, { recursive: true, force: true });
            fs.writeFileSync(MANIFEST_PATH, orig);
        }
        const after = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        assert.ok(!(after.maps || []).some((m) => m && (m.id === srcId || m.id === dstId)));
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main();
