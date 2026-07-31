#!/usr/bin/env node
/**
 * Smart Update Sprites — multi-sheet sprite batch for a frozen entity roster.
 *
 * Accepts one JSON config arg (same shape as web JobRunner argv_mode=json_config):
 *   {
 *     genre, kind, category?, seed?, model?,
 *     rows?: 4, cols?: 4,   // preferred full-sheet grid (default 4×4)
 *     dry_run?: bool,
 *     items: [{ technical, alias? }, ...]   // selected + backlog (any length)
 *   }
 *
 * Chunks selection into full grids (default 4×4 = 16). Short final sheets are
 * frozen as-is (no random name-gen fill); grid shrinks to fit the item count.
 * Wiki Smart Update fills short sheets from library backlog in PHP before
 * enqueue — this script only freezes whatever roster it receives.
 *
 * Usage:
 *   node bin/smart_update_sprites.js '{"genre":"rpg_fantasy","kind":"creatures","items":[...]}'
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    DEFAULT_GENRE,
    DEFAULT_KIND,
    ROOT,
    listKindIds
} = require('../kernel/settings.js');
const {
    buildBatch,
    batchToConfigJson,
    DEFAULT_MODEL,
    listGenreIds
} = require('../kernel/core/lib/batch_builder.js');

const DEFAULT_ROWS = 4;
const DEFAULT_COLS = 4;

/**
 * @param {string} raw
 * @returns {Record<string, unknown>}
 */
function parseConfig(raw) {
    let cfg;
    try {
        cfg = JSON.parse(raw);
    } catch (e) {
        throw new Error('Invalid JSON config: ' + (e && e.message ? e.message : e));
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('Config must be a JSON object');
    }
    return cfg;
}

/**
 * @param {unknown} raw
 * @returns {Array<{technical: string, alias: string}>}
 */
function normalizeItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('items must be a non-empty array');
    }
    if (raw.length > 512) {
        throw new Error('items: too many entries (max 512)');
    }
    /** @type {Array<{technical: string, alias: string}>} */
    const out = [];
    const seen = new Set();
    for (let i = 0; i < raw.length; i++) {
        const row = raw[i];
        if (!row || typeof row !== 'object') {
            throw new Error(`items[${i}]: expected object`);
        }
        const technical = String(
            /** @type {{technical?: unknown, id?: unknown}} */ (row).technical ||
                /** @type {{id?: unknown}} */ (row).id ||
                ''
        ).trim();
        if (!technical) {
            throw new Error(`items[${i}]: missing technical`);
        }
        const key = technical.toLowerCase();
        if (seen.has(key)) {
            throw new Error(`items[${i}]: duplicate technical "${technical}"`);
        }
        seen.add(key);
        const aliasRaw = /** @type {{alias?: unknown}} */ (row).alias;
        const alias =
            aliasRaw != null && String(aliasRaw).trim() !== ''
                ? String(aliasRaw).trim()
                : technical;
        out.push({ technical, alias });
    }
    return out;
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(arr, size) {
    /** @type {T[][]} */
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

/**
 * Pick rows×cols with rows*cols === n (no random pad). Prefer near-square;
 * fall back to 1×n. Caps at 16 per axis (full sheet is 4×4).
 * @param {number} n
 * @returns {{ rows: number, cols: number }}
 */
function gridForCount(n) {
    if (n <= 0) {
        throw new Error('gridForCount: n must be positive');
    }
    if (n === 16) {
        return { rows: 4, cols: 4 };
    }
    /** @type {{ rows: number, cols: number } | null} */
    let best = null;
    for (let rows = 1; rows <= n; rows++) {
        if (n % rows !== 0) continue;
        const cols = n / rows;
        if (rows > 16 || cols > 16) continue;
        if (
            !best ||
            Math.abs(rows - cols) < Math.abs(best.rows - best.cols) ||
            (Math.abs(rows - cols) === Math.abs(best.rows - best.cols) &&
                rows * cols === n &&
                rows <= best.rows)
        ) {
            best = { rows, cols };
        }
    }
    if (!best) {
        best = { rows: 1, cols: n };
    }
    return best;
}

/**
 * @param {string[]} cmd
 * @param {{ dryRun?: boolean }} [opts]
 */
function runNode(cmd, opts = {}) {
    console.log('> ' + cmd.map((t) => (/\s/.test(t) ? JSON.stringify(t) : t)).join(' '));
    if (opts.dryRun) {
        return;
    }
    const r = spawnSync(cmd[0], cmd.slice(1), {
        encoding: 'utf8',
        stdio: 'inherit',
        cwd: ROOT,
        env: process.env
    });
    if (r.error) {
        throw r.error;
    }
    if (r.status !== 0) {
        throw new Error(`${cmd[0]} exited with code ${r.status}`);
    }
}

function main() {
    const rawArg = process.argv[2];
    if (!rawArg || rawArg === '-h' || rawArg === '--help') {
        console.log(`Smart Update Sprites — frozen roster → one or more sheets.

Usage:
  node bin/smart_update_sprites.js '<json-config>'

JSON keys:
  genre, kind, items[{technical,alias?}], category?, seed?, model?,
  rows? (default 4), cols? (default 4), dry_run?

Short sheets freeze as-is (no random name-gen fill); grid shrinks to fit.

Example:
  node bin/smart_update_sprites.js '${JSON.stringify({
      genre: 'rpg_fantasy',
      kind: 'creatures',
      seed: 42,
      items: [{ technical: 'My Orc', alias: 'Orc' }]
  })}'
`);
        process.exit(rawArg ? 0 : 1);
    }

    const cfg = parseConfig(rawArg);
    const genre = String(cfg.genre || DEFAULT_GENRE);
    const kind = String(cfg.kind || DEFAULT_KIND);
    if (!listGenreIds().includes(genre)) {
        throw new Error(`Unknown genre: ${genre}`);
    }
    if (!listKindIds().includes(kind)) {
        throw new Error(`Unknown kind: ${kind}`);
    }

    const prefRows = Math.max(1, Math.min(8, Number(cfg.rows) || DEFAULT_ROWS));
    const prefCols = Math.max(1, Math.min(8, Number(cfg.cols) || DEFAULT_COLS));
    const slot = prefRows * prefCols;
    const seed =
        cfg.seed != null && cfg.seed !== ''
            ? Number(cfg.seed)
            : null;
    const model = cfg.model != null ? String(cfg.model) : DEFAULT_MODEL;
    const category =
        cfg.category != null && String(cfg.category).trim() !== ''
            ? String(cfg.category).trim()
            : null;
    const dryRun = cfg.dry_run === true || cfg.dryRun === true;
    const selected = normalizeItems(cfg.items);

    const batches = chunk(selected, slot);
    console.log(
        `Smart Update Sprites: ${selected.length} item(s) → ${batches.length} batch(es) of up to ${slot} (${prefRows}×${prefCols})`
    );
    console.log(`genre=${genre} kind=${kind}` + (category ? ` category=${category}` : ''));
    console.log(`model=${model}` + (seed != null && !isNaN(seed) ? ` seed=${seed}` : ''));
    if (dryRun) {
        console.log('[dry-run] Each batch will invoke generate_sprite --dry-run (no image gen / writes).');
    }

    const cfgDir = path.join(ROOT, 'var', 'batch_configs');
    fs.mkdirSync(cfgDir, { recursive: true });
    const stamp = Date.now().toString(36);

    for (let i = 0; i < batches.length; i++) {
        const partial = batches[i];
        const tag = `[batch ${i + 1}/${batches.length}]`;
        const grid =
            partial.length === slot
                ? { rows: prefRows, cols: prefCols }
                : gridForCount(partial.length);

        console.log(
            `\n${tag} Frozen ${partial.length} item(s) · grid ${grid.rows}×${grid.cols}` +
                (partial.length < slot
                    ? ' (short sheet — no random fill)'
                    : '')
        );

        // Full inject: length === rows*cols so buildBatch does not name-gen fill.
        const batch = buildBatch({
            genre,
            kind,
            category: category || undefined,
            seed: seed != null && !isNaN(seed) ? seed : null,
            rows: grid.rows,
            cols: grid.cols,
            model,
            items: partial
        });

        console.log(
            `${tag} Roster: ${batch.items.map((c) => c.technical).join(' | ')}`
        );

        const cfgPath = path.join(cfgDir, `smart_${stamp}_${i + 1}.json`);
        const frozen = batchToConfigJson(batch, { includePrompt: false });
        fs.writeFileSync(cfgPath, JSON.stringify(frozen, null, 2) + '\n', 'utf8');
        console.log(`${tag} Wrote config ${path.relative(ROOT, cfgPath)}`);

        const genScript = path.join(ROOT, 'bin', 'generate_sprite.js');
        /** @type {string[]} */
        const cmd = [process.execPath, genScript, '--config', cfgPath];
        if (dryRun) {
            cmd.push('--dry-run');
        }

        try {
            runNode(cmd, { dryRun: false });
        } catch (e) {
            console.error(`${tag} Failed: ${e.message || e}`);
            process.exit(1);
        }
    }

    console.log(
        `\nDone. Smart update completed ${batches.length} spritesheet batch(es) for ${selected.length} item(s).`
    );
}

try {
    main();
} catch (e) {
    console.error('Error: ' + (e && e.message ? e.message : e));
    process.exit(1);
}
