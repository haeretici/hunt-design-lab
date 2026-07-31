#!/usr/bin/env node
/**
 * Stage 0 exit criteria: empty Simulator ticks N frames headless with fixed seed.
 * Quiet on success; VERBOSE=1 for detail.
 */

'use strict';

const assert = require('assert');
const { Time, LOGIC_DT, LOGIC_UPS } = require('../kernel/core/lib/time.js');
const { Settings } = require('../kernel/settings.js');
const { Utils } = require('../kernel/core/lib/utils.js');
const { GameObject } = require('../kernel/core/entities/gameobject.js');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const { runHeadlessTicks } = require('../kernel/providers/simulator/headless_runner.js');

const VERBOSE = !!process.env.VERBOSE;

function log(...args) {
    if (VERBOSE) console.log(...args);
}

async function testTimeFixedStep() {
    Time.resetTimeSinceLevelLoad();
    Time.time = 0;
    for (let i = 0; i < 40; i++) {
        Time.advanceFixedLogicStep();
    }
    assert.strictEqual(LOGIC_UPS, 20);
    assert.ok(Math.abs(Time.deltaTime - LOGIC_DT) < 1e-12);
    assert.ok(Math.abs(Time.timeSinceLevelLoad - 2) < 1e-9, '40 ticks @ 20 UPS = 2s');
    log('time fixed step ok');
}

async function testSeededRandomDeterminism() {
    const a = Utils.createSeededRandom(42);
    const b = Utils.createSeededRandom(42);
    const c = Utils.createSeededRandom(99);
    const seqA = [a(), a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b(), b()];
    const seqC = [c(), c(), c(), c(), c()];
    assert.deepStrictEqual(seqA, seqB, 'same seed ⇒ same sequence');
    assert.notDeepStrictEqual(seqA, seqC, 'different seed ⇒ different sequence');
    assert.strictEqual(typeof a.getState, 'function', 'LCG exposes getState');
    assert.strictEqual(typeof a.getDrawCount, 'function', 'LCG exposes getDrawCount');
    assert.strictEqual(a.getDrawCount(), 5, 'draw count after 5 draws');
    assert.strictEqual(a.getState(), b.getState(), 'same seed ⇒ same state after N draws');
    log('seeded random ok', seqA.slice(0, 2));
}

async function testGameObjectSceneGraph() {
    const root = new GameObject('root');
    const child = new GameObject('child');
    let childTicks = 0;
    child.update = function () {
        childTicks += 1;
    };
    root.insertChild(child);
    root.updateAll();
    root.updateAll();
    assert.strictEqual(childTicks, 2);
    assert.strictEqual(child.parent, root);
    assert.strictEqual(child.getRoot(), root);
    log('scene graph ok');
}

async function testHeadlessEmptySimulator() {
    const frames = 100;
    const seed = 4242;

    const run1 = await runHeadlessTicks({ seed, frames, sampleEvery: 5 });
    const run2 = await runHeadlessTicks({ seed, frames, sampleEvery: 5 });

    assert.strictEqual(run1.tickCount, frames);
    assert.strictEqual(run2.tickCount, frames);
    assert.ok(
        Math.abs(run1.timeSinceLevelLoad - frames * LOGIC_DT) < 1e-9,
        'sim time = frames * LOGIC_DT'
    );
    assert.deepStrictEqual(
        run1.randomSamples,
        run2.randomSamples,
        'same seed ⇒ same random samples across runs'
    );
    assert.strictEqual(run1.sessionState, 'running');

    const runOther = await runHeadlessTicks({ seed: seed + 1, frames, sampleEvery: 5 });
    assert.notDeepStrictEqual(
        run1.randomSamples,
        runOther.randomSamples,
        'different seed ⇒ different samples'
    );

    // Math.random restored after runner
    assert.strictEqual(typeof Math.random(), 'number');
    assert.ok(Settings.HEADLESS === false, 'HEADLESS reset after runner');

    log('headless empty sim ok', {
        tickCount: run1.tickCount,
        time: run1.timeSinceLevelLoad,
        samples: run1.randomSamples.length
    });
}

async function testSimulatorBindsDuringUpdate() {
    const { NATIVE_MATH_RANDOM } = require('../kernel/core/lib/utils.js');
    const sim = new Simulator({ seed: 7 });
    await sim.start();
    const bound = sim.seededRandom;
    assert.strictEqual(typeof bound, 'function');
    assert.strictEqual(
        Math.random,
        NATIVE_MATH_RANDOM,
        'Math.random is native after start() (soccer contract)'
    );

    // updateAll must re-bind for the tick body only
    let seen = null;
    const probe = new GameObject('probe');
    probe.update = function () {
        seen = Math.random;
    };
    sim.insertChild(probe);
    sim.updateAll();
    assert.strictEqual(seen, bound, 'Math.random is session RNG during updateAll');
    assert.strictEqual(
        Math.random,
        NATIVE_MATH_RANDOM,
        'Math.random is native after updateAll'
    );
    sim.destroy();
    assert.strictEqual(Math.random, NATIVE_MATH_RANDOM, 'native after destroy');
    log('bind during update ok');
}

async function testScriptBase() {
    const { Script } = require('../kernel/core/scripts/script.js');
    const root = new GameObject('root');
    const script = new Script();
    let ticks = 0;
    script.update = function () {
        ticks += 1;
    };
    root.insertScript(script);
    root.updateAll();
    root.updateAll();
    assert.strictEqual(ticks, 2);
    assert.strictEqual(script.parent, root);
    script.destroy();
    assert.strictEqual(root.scripts.length, 0);
    log('script base ok');
}

async function testAppPaths() {
    const { appUrl, getAppRoot, ensureTrailingSlash } = require(
        '../kernel/core/lib/app_paths.js'
    );
    assert.strictEqual(ensureTrailingSlash('foo'), 'foo/');
    assert.strictEqual(getAppRoot(), '/');
    assert.strictEqual(appUrl('presets/x.json'), '/presets/x.json');
    assert.strictEqual(appUrl('/assets/a.png'), '/assets/a.png');
    log('app_paths ok');
}

async function main() {
    await testTimeFixedStep();
    await testSeededRandomDeterminism();
    await testGameObjectSceneGraph();
    await testHeadlessEmptySimulator();
    await testSimulatorBindsDuringUpdate();
    await testScriptBase();
    await testAppPaths();
    console.log('kernel_shell: ok');
}

main().catch((err) => {
    console.error('kernel_shell: FAIL');
    console.error(err);
    process.exit(1);
});
