#!/usr/bin/env node
/**
 * Phase 5 Verification: Manual Replay Parity, TAS Piano Roll Branching & Batch AI Switch.
 * Ensures deterministic manual action replay, timeline branching on scrub, and batch AI fallback.
 */

'use strict';

const assert = require('assert');
const { Simulator } = require('../kernel/providers/simulator/simulator.js');
const {
    resolveHuntConfig,
    pickInjectors,
    runHeadlessHunt,
    runBatchSlice
} = require('../kernel/providers/simulator/headless_runner.js');
const { Time } = require('../kernel/core/lib/time.js');
const { Settings } = require('../kernel/settings.js');
const { summaryCore, stableStringify } = require('../kernel/core/lib/telemetry.js');

let failed = 0;
let passed = 0;

async function testAsync(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('ok', name);
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

async function runTests() {
    Settings.HEADLESS = true;

    await testAsync('TAS Piano Roll Timeline Branching on Scrub', async () => {
        const seed = 12345;
        const resolved = resolveHuntConfig({
            seed,
            huntId: 'cave_crawl_generated',
            frames: 20
        });
        if (resolved.parties && resolved.parties[0] && resolved.parties[0].members) {
            resolved.parties[0].members.forEach((m) => {
                m.controlMode = 'manual';
            });
        }
        const inject = pickInjectors({});
        const sim = new Simulator(Object.assign({}, resolved, inject));
        await sim.start();
        sim.active = true;

        const party = sim.parties[0];
        const leader = party.members[0];

        // Advance to tick 2 and issue SET_TARGET
        for (let i = 0; i < 2; i++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
        }
        leader.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: true });
        Time.advanceFixedLogicStep();
        sim.updateAll();

        assert.strictEqual(sim.commandHistory.length, 1, 'first action recorded in commandHistory');

        // Advance to tick 10 and issue STOP_AUTOWALK
        while (sim.tickCount < 10) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
        }
        leader.commandQueue.push({ type: 'STOP_AUTOWALK' });
        Time.advanceFixedLogicStep();
        sim.updateAll();

        assert.strictEqual(sim.commandHistory.length, 2, 'second action recorded at tick 10');
        const originalHistory = JSON.parse(JSON.stringify(sim.commandHistory));

        // Scrub backward to tick 5
        await sim.seekToTick(5);
        assert.strictEqual(sim.tickCount, 5, 'scrubbed to tick 5');
        assert.strictEqual(sim.commandHistory.length, 2, 'history preserved before branching');

        // Now issue a new manual action at tick 5 (TAS Piano Roll overwrite)
        const currentLeader = sim.parties[0].members[0];
        currentLeader.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: false });
        Time.advanceFixedLogicStep();
        sim.updateAll();

        assert.strictEqual(sim.commandHistory.length, 2, 'history branched and truncated');
        assert.strictEqual(sim.commandHistory[0].type, 'SET_AUTO_CHASE', 'earlier command intact');
        assert.strictEqual(sim.commandHistory[1].type, 'SET_AUTO_CHASE', 'new action overwritten previous action at tick 10');
        assert.strictEqual(sim.commandHistory[1].enabled, false, 'new action state correct');
    });

    await testAsync('Deterministic Replay Parity Across Headless Hunts', async () => {
        const seed = 9999;
        const recordedHistory = [
            { tick: 2, type: 'SET_AUTO_CHASE', enabled: true, partyIdx: 0, memberIdx: 0 },
            { tick: 5, type: 'STOP_AUTOWALK', partyIdx: 0, memberIdx: 0 }
        ];

        const configA = {
            seed,
            huntId: 'cave_crawl_generated',
            frames: 15,
            commandHistory: recordedHistory,
            members: [{ id: 'p1', type: 'player', name: 'Hero', controlMode: 'manual', stats: { maxHp: 100, hp: 100, speed: 4 }, skills: { combat_vitality: 1 } }]
        };

        const summaryA = await runHeadlessHunt(configA);
        const summaryB = await runHeadlessHunt(configA);

        const coreA = summaryCore(summaryA);
        const coreB = summaryCore(summaryB);

        assert.strictEqual(stableStringify(coreA), stableStringify(coreB), 'deterministic parity preserved across replays');
        assert.deepStrictEqual(summaryA.commandHistory, recordedHistory, 'command history exported in summary');
    });

    await testAsync('Batch Analysis Manual Benchmark & AI Override', async () => {
        const seed = 4242;
        const recordedHistory = [
            { tick: 1, type: 'STOP_AUTOWALK', partyIdx: 0, memberIdx: 0 }
        ];
        const config = {
            seed,
            huntId: 'cave_crawl_generated',
            frames: 10,
            commandHistory: recordedHistory,
            members: [{ id: 'p1', type: 'player', name: 'Hero', controlMode: 'manual', stats: { maxHp: 100, hp: 100, speed: 4 }, skills: { combat_vitality: 1 } }]
        };

        const results = await runBatchSlice(config, 0, 3);
        assert.strictEqual(results.length, 3, 'batch completed 3 runs');

        // Iteration 0: Manual Benchmark
        assert.strictEqual(results[0].batchIndex, 0);
        assert.deepStrictEqual(results[0].commandHistory, recordedHistory, 'iteration 0 executes manual benchmark');
        assert.strictEqual(results[0].config && results[0].config.forceAiControl, false, 'iteration 0 not forced to AI');

        // Iteration 1 & 2: Autonomous AI switch
        assert.strictEqual(results[1].batchIndex, 1);
        assert.strictEqual(results[1].config.forceAiControl, true, 'iteration 1 switched to autonomous AI');
        assert.strictEqual(results[1].commandHistory.length, 0, 'iteration 1 has no manual command history');

        assert.strictEqual(results[2].batchIndex, 2);
        assert.strictEqual(results[2].config.forceAiControl, true, 'iteration 2 switched to autonomous AI');
        assert.strictEqual(results[2].commandHistory.length, 0, 'iteration 2 has no manual command history');
    });

    await testAsync('Manual Cast Spell Execution without errors', async () => {
        const seed = 12345;
        const resolved = resolveHuntConfig({
            seed,
            huntId: 'cave_crawl_generated',
            frames: 20
        });
        if (resolved.parties && resolved.parties[0] && resolved.parties[0].members) {
            resolved.parties[0].members.forEach((m) => {
                m.controlMode = 'manual';
            });
        }
        const inject = pickInjectors({});
        const sim = new Simulator(Object.assign({}, resolved, inject));
        await sim.start();
        sim.active = true;

        const party = sim.parties[0];
        const leader = party.members[0];

        leader.commandQueue.push({ type: 'CAST_SPELL', spellId: 'heal_light', target: { kind: 'self' } });
        Time.advanceFixedLogicStep();
        sim.updateAll();
        assert.strictEqual(sim.commandHistory[0].type, 'CAST_SPELL', 'CAST_SPELL recorded and executed properly');
    });

    await testAsync('SET_CONTROL_MODE recorded and replayed deterministically', async () => {
        const seed = 7777;
        const resolved = resolveHuntConfig({
            seed,
            huntId: 'cave_crawl_generated',
            frames: 20
        });
        if (resolved.parties && resolved.parties[0] && resolved.parties[0].members) {
            resolved.parties[0].members.forEach((m) => {
                m.controlMode = 'manual';
            });
        }
        const inject = pickInjectors({});
        const sim = new Simulator(Object.assign({}, resolved, inject));
        await sim.start();
        sim.active = true;

        const leader = sim.parties[0].members[0];
        assert.strictEqual(leader.controlMode, 'manual', 'starts manual');

        for (let i = 0; i < 2; i++) {
            Time.advanceFixedLogicStep();
            sim.updateAll();
        }
        leader.commandQueue.push({ type: 'SET_CONTROL_MODE', mode: 'ai' });
        Time.advanceFixedLogicStep();
        sim.updateAll();
        assert.strictEqual(leader.controlMode, 'ai', 'live flip to AI');
        assert.strictEqual(sim.commandHistory.length, 1, 'mode flip recorded');
        assert.strictEqual(sim.commandHistory[0].type, 'SET_CONTROL_MODE');
        assert.strictEqual(sim.commandHistory[0].mode, 'ai');

        // Re-enter manual and issue a chase toggle only valid while manual
        leader.commandQueue.push({ type: 'SET_CONTROL_MODE', mode: 'manual' });
        Time.advanceFixedLogicStep();
        sim.updateAll();
        assert.strictEqual(leader.controlMode, 'manual', 'live flip back to manual');
        leader.commandQueue.push({ type: 'SET_AUTO_CHASE', enabled: true });
        Time.advanceFixedLogicStep();
        sim.updateAll();
        assert.strictEqual(leader.autoChase, true, 'chase applied while manual');
        assert.strictEqual(sim.commandHistory.length, 3, 'mode + chase history');

        const recordedHistory = JSON.parse(JSON.stringify(sim.commandHistory));
        const config = {
            seed,
            huntId: 'cave_crawl_generated',
            frames: 15,
            commandHistory: recordedHistory,
            members: [
                {
                    id: 'p1',
                    type: 'player',
                    name: 'Hero',
                    controlMode: 'manual',
                    stats: { maxHp: 100, hp: 100, speed: 4 },
                    skills: { combat_vitality: 1 }
                }
            ]
        };
        const summaryA = await runHeadlessHunt(config);
        const summaryB = await runHeadlessHunt(config);
        assert.strictEqual(
            stableStringify(summaryCore(summaryA)),
            stableStringify(summaryCore(summaryB)),
            'control-mode history preserves replay parity'
        );
        assert.deepStrictEqual(
            summaryA.commandHistory,
            recordedHistory,
            'SET_CONTROL_MODE entries exported in summary'
        );
    });

    if (failed > 0) {
        console.error(`\n${failed} test(s) failed out of ${failed + passed}`);
        process.exit(1);
    } else {
        console.log(`\nAll ${passed} Phase 5 Replay tests passed successfully.`);
        process.exit(0);
    }
}

runTests();
