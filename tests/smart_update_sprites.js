#!/usr/bin/env node
/**
 * Wiki Smart Update Sprites — spells backlog uses catalogRows (spells[]),
 * not equipment's items[] key. Dry-run only (does not patch presets or enqueue).
 * Standard spells currently all own customUISprite === id; empty selection
 * must throw, and a selected row must not pad the 4×4 sheet from backlog.
 */

'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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
        maxBuffer: 8 * 1024 * 1024,
        cwd: ROOT
    });
    return JSON.parse(out);
}

let failed = 0;
let passed = 0;

/**
 * @param {string} name
 * @param {() => void} fn
 */
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

test('entityIdToTechnical title-cases snake_case ids', () => {
    const data = phpEval(`
echo json_encode([
  'invisible' => \\De\\SmartUpdateSprites::entityIdToTechnical('invisible'),
  'heal_ultimate' => \\De\\SmartUpdateSprites::entityIdToTechnical('heal_ultimate'),
  'great_energy_beam' => \\De\\SmartUpdateSprites::entityIdToTechnical('great_energy_beam'),
]);
`);
    assert.strictEqual(data.invisible, 'Invisible');
    assert.strictEqual(data.heal_ultimate, 'Heal Ultimate');
    assert.strictEqual(data.great_energy_beam, 'Great Energy Beam');
});

test('needsOwnSprite treats missing / other id as needing art', () => {
    const data = phpEval(`
echo json_encode([
  'null' => \\De\\SmartUpdateSprites::needsOwnSprite('invisible', null),
  'empty' => \\De\\SmartUpdateSprites::needsOwnSprite('invisible', ''),
  'same' => \\De\\SmartUpdateSprites::needsOwnSprite('invisible', 'invisible'),
  'other' => \\De\\SmartUpdateSprites::needsOwnSprite('invisible', 'haste'),
]);
`);
    assert.strictEqual(data.null, true);
    assert.strictEqual(data.empty, true);
    assert.strictEqual(data.same, false);
    assert.strictEqual(data.other, true);
});

test('PresetCrud::catalogRows reads spells[] (not items[])', () => {
    const rows = phpEval(`
echo json_encode(\\De\\PresetCrud::catalogRows('standard', 'spells'));
`);
    assert.ok(Array.isArray(rows) && rows.length > 0, 'spells rows');
    assert.ok(
        rows.some((r) => r && r.id === 'invisible'),
        'includes invisible'
    );
    const eq = phpEval(`
echo json_encode(\\De\\PresetCrud::catalogRows('standard', 'equipment'));
`);
    assert.ok(Array.isArray(eq) && eq.length > 0, 'equipment rows');
});

test('spells empty selection errors when customUISprite backlog is empty', () => {
    const data = phpEval(`
try {
  \\De\\SmartUpdateSprites::run([
    'mode' => 'standard',
    'kind' => 'spells',
    'genre' => 'rpg_fantasy',
    'dry_run' => true,
    'items' => [],
  ], new \\De\\JobRunner());
  echo json_encode(['threw' => false]);
} catch (\\InvalidArgumentException $e) {
  echo json_encode(['threw' => true, 'message' => $e->getMessage()]);
}
`);
    assert.strictEqual(data.threw, true);
    assert.match(
        String(data.message || ''),
        /No entities need a dedicated sprite/
    );
});

test('spells selected item does not pad the sheet when backlog is empty', () => {
    const data = phpEval(`
echo json_encode(\\De\\SmartUpdateSprites::run([
  'mode' => 'standard',
  'kind' => 'spells',
  'genre' => 'rpg_fantasy',
  'dry_run' => true,
  'items' => [['id' => 'melee_auto', 'alias' => 'Melee Auto Attack']],
], new \\De\\JobRunner()));
`);
    assert.strictEqual(data.kind, 'spells');
    assert.strictEqual(data.dry_run, true);
    assert.strictEqual(data.selected, 1);
    assert.strictEqual(data.backlog_filled, 0);
    assert.strictEqual(data.updated.length, 1);
    assert.strictEqual(data.updated[0].id, 'melee_auto');
    assert.strictEqual(data.updated[0].technical, 'Melee Auto');
    assert.strictEqual(data.updated[0].customSprite, 'melee_auto');
    assert.strictEqual(data.updated[0].source, 'selected');
    assert.strictEqual(data.job, null);
});

test('equipment dry-run still reads items[] via catalogRows', () => {
    const rows = phpEval(`
echo json_encode(\\De\\PresetCrud::catalogRows('standard', 'equipment'));
`);
    const first = (rows || []).find((r) => r && r.id);
    assert.ok(first, 'at least one equipment row');
    const data = phpEval(`
echo json_encode(\\De\\SmartUpdateSprites::run([
  'mode' => 'standard',
  'kind' => 'equipment',
  'genre' => 'rpg_fantasy',
  'dry_run' => true,
  'items' => [['id' => ${JSON.stringify(first.id)}, 'alias' => ${JSON.stringify(first.label || first.id)}]],
], new \\De\\JobRunner()));
`);
    assert.strictEqual(data.kind, 'equipment');
    assert.strictEqual(data.selected, 1);
    assert.strictEqual(data.updated[0].id, first.id);
    assert.strictEqual(data.updated[0].source, 'selected');
    assert.ok(data.updated.length >= 1);
    assert.ok(data.updated.length <= 16);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
