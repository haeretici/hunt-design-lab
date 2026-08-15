#!/usr/bin/env node
/**
 * mode.json browser index sync (bin/sync_mode_browser.js).
 *
 * mirror: creatures / dialogs / waypoints / populations
 * prune:  hunts / scenarios (opt-in catalogs)
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    BROWSER_INDEXES,
    listFolderStems,
    processMode
} = require('../bin/sync_mode_browser.js');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');

let failed = 0;
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed += 1;
    } catch (err) {
        failed += 1;
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
    }
}

/**
 * @param {string} dir
 */
function rmrf(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * @param {string} filePath
 * @param {unknown} data
 */
function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, formatJson(data));
}

test('BROWSER_INDEXES covers mirror + prune kinds', () => {
    const byKind = Object.create(null);
    for (const e of BROWSER_INDEXES) byKind[e.kind] = e.policy;
    assert.strictEqual(byKind.creatures, 'mirror');
    assert.strictEqual(byKind.dialogs, 'mirror');
    assert.strictEqual(byKind.waypoints, 'mirror');
    assert.strictEqual(byKind.populations, 'mirror');
    assert.strictEqual(byKind.hunts, 'prune');
    assert.strictEqual(byKind.scenarios, 'prune');
});

test('standard mirror lists match disk (or report the delta)', () => {
    const result = processMode('standard', { write: false }, ROOT);
    if (!result.ok) {
        // Check must not fail the suite before a write; assert only that
        // prune kinds are not asking to *add* hunts (opt-in).
        for (const line of result.changes) {
            assert.ok(
                !line.startsWith('hunts: +'),
                'hunts stay prune-only: ' + line
            );
            assert.ok(
                !line.startsWith('scenarios: +'),
                'scenarios stay prune-only: ' + line
            );
        }
    }
    const popsDisk = listFolderStems('standard', 'populations', ROOT);
    assert.ok(popsDisk.includes('cave_mid_mixed'));
    assert.ok(popsDisk.includes('ice_rats'));
});

test('write mirrors folder stems and prunes stale curated ids', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-sync-mode-'));
    try {
        const modeId = 'fixture';
        const modeDir = path.join(tmp, 'presets', modeId);
        writeJson(path.join(modeDir, 'creatures', 'rat.json'), { id: 'rat' });
        writeJson(path.join(modeDir, 'creatures', 'bat.json'), { id: 'bat' });
        writeJson(path.join(modeDir, 'dialogs', 'guide.json'), { id: 'guide' });
        writeJson(path.join(modeDir, 'waypoints', 'loop.json'), { id: 'loop' });
        writeJson(path.join(modeDir, 'populations', 'cave.json'), { id: 'cave' });
        writeJson(path.join(modeDir, 'populations', 'crypt.json'), {
            id: 'crypt'
        });
        writeJson(path.join(modeDir, 'hunts', 'keep.json'), { id: 'keep' });
        writeJson(path.join(modeDir, 'hunts', 'draft.json'), { id: 'draft' });
        writeJson(path.join(modeDir, 'scenarios', 'lab.json'), { id: 'lab' });
        writeJson(path.join(modeDir, 'mode.json'), {
            id: modeId,
            browser: {
                creatures: ['rat', 'ghost'],
                dialogs: [],
                waypoints: ['loop'],
                populations: ['cave'],
                hunts: ['keep', 'gone'],
                scenarios: ['lab', 'missing']
            }
        });

        const check = processMode(modeId, { write: false }, tmp);
        assert.strictEqual(check.ok, false);
        assert.ok(check.changes.some((c) => c.startsWith('creatures:')));
        assert.ok(check.changes.some((c) => c.startsWith('dialogs:')));
        assert.ok(check.changes.some((c) => c.startsWith('populations:')));
        assert.ok(check.changes.some((c) => c.startsWith('hunts:')));
        assert.ok(check.changes.some((c) => c.startsWith('scenarios:')));
        assert.ok(
            !check.changes.some((c) => /hunts:.*\+/.test(c)),
            'prune must not add unlisted hunts'
        );

        const written = processMode(modeId, { write: true }, tmp);
        assert.strictEqual(written.ok, false, 'write reports what changed');
        const after = JSON.parse(
            fs.readFileSync(path.join(modeDir, 'mode.json'), 'utf8')
        );
        assert.deepStrictEqual(after.browser.creatures, ['bat', 'rat']);
        assert.deepStrictEqual(after.browser.dialogs, ['guide']);
        assert.deepStrictEqual(after.browser.waypoints, ['loop']);
        assert.deepStrictEqual(after.browser.populations, ['cave', 'crypt']);
        assert.deepStrictEqual(after.browser.hunts, ['keep']);
        assert.deepStrictEqual(after.browser.scenarios, ['lab']);
        assert.ok(
            !after.browser.hunts.includes('draft'),
            'new hunt file stays out until Hunt Editor opts in'
        );

        const again = processMode(modeId, { write: false }, tmp);
        assert.strictEqual(again.ok, true);
        assert.deepStrictEqual(again.changes, []);
    } finally {
        rmrf(tmp);
    }
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
