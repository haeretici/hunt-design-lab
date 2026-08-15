#!/usr/bin/env node
/**
 * Designer Phase 3–4: engine validate for piece packs, biomes, dungeon layouts,
 * and tile roles (influence / vertical).
 * Called by PHP PresetCrud::validate — prints one JSON object to stdout.
 *
 * Usage:
 *   node bin/presets_validate.js --mode standard --kind pieces --id cave_v1
 *   node bin/presets_validate.js --mode standard --kind biomes --id cave
 *   node bin/presets_validate.js --mode standard --kind dungeons --id small_crawl
 *   node bin/presets_validate.js --mode standard --kind dungeons --id small_crawl --level stress
 *   node bin/presets_validate.js --mode standard --kind tile_roles --id wall
 *
 * Levels:
 *   layout (default) — structural / few-seed layout check (fast)
 *   stress           — more seeds via runDungeonTests (still bounded; not full CI 10k)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** Layout: quick designer feedback. */
const LAYOUT_ITERATIONS = 8;
/** Stress: still web-safe; full 10k stays on `npm run dungeon:test`. */
const STRESS_ITERATIONS = 50;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ mode: string, kind: string, id: string, level: string }} */
    const out = { mode: 'standard', kind: '', id: '', level: 'layout' };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--mode' && argv[i + 1]) out.mode = String(argv[++i]);
        else if (a === '--kind' && argv[i + 1]) out.kind = String(argv[++i]);
        else if (a === '--id' && argv[i + 1]) out.id = String(argv[++i]);
        else if (a === '--level' && argv[i + 1]) {
            const lv = String(argv[++i]).toLowerCase();
            out.level = lv === 'stress' ? 'stress' : 'layout';
        } else if (a === '--help' || a === '-h') {
            console.log(
                'Usage: node bin/presets_validate.js --mode <id> --kind pieces|biomes|dungeons|tile_roles --id <entityId> [--level layout|stress]'
            );
            process.exit(0);
        }
    }
    return out;
}

/**
 * @param {string} rel
 */
function readJson(rel) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
        throw new Error('Missing file: ' + rel);
    }
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

/**
 * Soft structural checks on a piece pack (normalize + walkability).
 * @param {object} raw
 * @returns {{ ok: boolean, errors: string[], warnings: string[], detail: object }}
 */
function validatePiecePack(raw) {
    const {
        normalizePiecePack,
        FRICTION_BLOCKED,
        frictionToRowStrings
    } = require(path.join(ROOT, 'kernel/core/lib/dungeon/pieces.js'));
    const { validateWalkablePoints } = require(path.join(
        ROOT,
        'kernel/core/lib/dungeon/validate.js'
    ));

    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];

    const pack = normalizePiecePack(raw);
    if (!pack || !pack.pieces || !pack.pieces.length) {
        return {
            ok: false,
            errors: ['piece_pack_empty_or_invalid'],
            warnings: [],
            detail: null
        };
    }

    if (!pack.id) {
        warnings.push('piece_pack_missing_id');
    }

    /** @type {object[]} */
    const pieceReports = [];

    for (let i = 0; i < pack.pieces.length; i++) {
        const p = pack.pieces[i];
        const w = p.size.w;
        const h = p.size.h;
        const friction = p.friction;
        /** @type {string[]} */
        const pe = [];
        /** @type {string[]} */
        const pw = [];

        if (!p.id) pe.push('missing_id');
        if (friction.length !== w * h) {
            pe.push(`friction_length_mismatch:${friction.length}!=${w * h}`);
        }

        let walkable = 0;
        for (let j = 0; j < friction.length; j++) {
            if (friction[j] !== FRICTION_BLOCKED) walkable += 1;
        }
        if (walkable < 1) pe.push('no_walkable_cells');

        // Exit edges should have at least one open cell on that border.
        const exits = p.exits || {};
        const edgeOpen = (dir) => {
            if (dir === 'N') {
                for (let x = 0; x < w; x++) {
                    if (friction[x] !== FRICTION_BLOCKED) return true;
                }
            } else if (dir === 'S') {
                for (let x = 0; x < w; x++) {
                    if (friction[(h - 1) * w + x] !== FRICTION_BLOCKED) return true;
                }
            } else if (dir === 'W') {
                for (let y = 0; y < h; y++) {
                    if (friction[y * w] !== FRICTION_BLOCKED) return true;
                }
            } else if (dir === 'E') {
                for (let y = 0; y < h; y++) {
                    if (friction[y * w + (w - 1)] !== FRICTION_BLOCKED) return true;
                }
            }
            return false;
        };
        for (const d of ['N', 'S', 'E', 'W']) {
            if (exits[d] && !edgeOpen(d)) {
                pe.push(`exit_${d}_blocked_on_edge`);
            }
        }

        const socks = p.sockets || {};
        for (const key of ['spawns', 'markers', 'waypoints', 'stairs']) {
            const pts = socks[key] || [];
            const r = validateWalkablePoints(friction, w, h, pts);
            if (!r.ok) {
                pe.push(
                    `socket_${key}_not_walkable:${JSON.stringify(r.bad.slice(0, 4))}`
                );
            }
        }

        if (!exits.N && !exits.S && !exits.E && !exits.W) {
            pw.push('no_exits');
        }

        const rows = frictionToRowStrings(friction, w, h, p.walkFriction);
        pieceReports.push({
            id: p.id,
            size: { w, h },
            walkable,
            errors: pe,
            warnings: pw,
            sampleRows: rows.slice(0, 3)
        });

        for (const e of pe) errors.push(`${p.id || i}:${e}`);
        for (const wmsg of pw) warnings.push(`${p.id || i}:${wmsg}`);
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        detail: {
            packId: pack.id,
            pieceCount: pack.pieces.length,
            pieces: pieceReports
        }
    };
}

/**
 * @param {string} mode
 * @param {string} biomeId
 */
function validateBiome(mode, biomeId) {
    const { validateBiomeConsistency } = require(path.join(
        ROOT,
        'kernel/core/lib/dungeon/biome.js'
    ));
    const { normalizePiecePack } = require(path.join(
        ROOT,
        'kernel/core/lib/dungeon/pieces.js'
    ));

    const manifest = readJson(`presets/${mode}/biomes/${biomeId}.json`);
    /** @type {object|null} */
    let piecePack = null;
    if (manifest.piecePack) {
        const packPath = `presets/${mode}/pieces/${manifest.piecePack}.json`;
        if (fs.existsSync(path.join(ROOT, packPath))) {
            piecePack = normalizePiecePack(readJson(packPath));
        }
    }
    /** @type {object|null} */
    let population = null;
    if (manifest.populationId) {
        const popPath = `presets/${mode}/populations/${manifest.populationId}.json`;
        if (fs.existsSync(path.join(ROOT, popPath))) {
            population = readJson(popPath);
        }
    }
    /** @type {object|null} */
    let markers = null;
    if (manifest.markersId) {
        const mPath = `presets/${mode}/markers/${manifest.markersId}.json`;
        if (fs.existsSync(path.join(ROOT, mPath))) {
            markers = readJson(mPath);
        }
    }

    const result = validateBiomeConsistency({
        biomeId,
        manifest,
        piecePack,
        population,
        markers
    });

    /** @type {string[]} */
    const errors = (result.errors || []).map(String);
    /** @type {string[]} */
    const warnings = (result.warnings || []).map(String);

    if (manifest.piecePack && !piecePack) {
        errors.push(`piece_pack_missing_file:${manifest.piecePack}`);
    } else if (piecePack) {
        const packCheck = validatePiecePack(
            readJson(`presets/${mode}/pieces/${manifest.piecePack}.json`)
        );
        for (const e of packCheck.errors) {
            errors.push(`piecePack:${e}`);
        }
        for (const w of packCheck.warnings) {
            warnings.push(`piecePack:${w}`);
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        detail: {
            biomeId,
            piecePack: manifest.piecePack || null,
            populationId: manifest.populationId || null
        }
    };
}

/**
 * Generate a few (or more) layouts and re-validate connectivity / population.
 * @param {string} mode
 * @param {string} profileId
 * @param {'layout'|'stress'} level
 */
function validateDungeon(mode, profileId, level) {
    const { setActiveMode } = require(path.join(
        ROOT,
        'kernel/core/lib/modes.js'
    ));
    const {
        loadDungeonProfile,
        loadPiecePack,
        loadPopulation,
        loadMarkerRules
    } = require(path.join(ROOT, 'kernel/core/lib/presets.js'));
    const { runDungeonTests } = require(path.join(
        ROOT,
        'kernel/core/lib/dungeon/tester.js'
    ));

    setActiveMode(mode);

    const iterations = level === 'stress' ? STRESS_ITERATIONS : LAYOUT_ITERATIONS;
    const report = runDungeonTests({
        profileId,
        iterations,
        seedStart: 1,
        maxFailSamples: level === 'stress' ? 10 : 5,
        progressEvery: 0,
        failRateThreshold: 0,
        checkPopulation: true,
        checkPacing: level === 'stress',
        loadDungeonProfile: (id) => loadDungeonProfile(id),
        loadPiecePack: (id) => loadPiecePack(id),
        loadPopulation: (id) => loadPopulation(id),
        loadMarkerRules: (id) => loadMarkerRules(id)
    });

    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const warnings = [];

    if (report.Successful === false && report.failed === 0 && report.passed === 0) {
        // Missing profile / pack / unknown layout — already in errorLog
        const lines = report.errorLogLines || [];
        if (lines.length) {
            for (const line of lines.slice(0, 8)) errors.push(String(line));
        } else if (report.errorCodes) {
            for (const [code, n] of Object.entries(report.errorCodes)) {
                errors.push(`${code}×${n}`);
            }
        } else {
            errors.push('dungeon_validate_failed');
        }
    } else if (report.failed > 0) {
        const rate = report.failureRate != null ? report.failureRate : 0;
        errors.push(
            `layout_failures:${report.failed}/${report.passed + report.failed} (rate=${rate})`
        );
        const codes = report.errorCodes || {};
        for (const [code, n] of Object.entries(codes)) {
            errors.push(`error_code:${code}×${n}`);
        }
        const samples = report.errorLogLines || [];
        for (const line of samples.slice(0, 6)) {
            warnings.push(`sample:${line}`);
        }
    }

    if (level === 'layout' && report.Successful) {
        warnings.push(
            `layout_ok_${iterations}_seeds (use --level stress for ${STRESS_ITERATIONS})`
        );
    }

    return {
        ok: errors.length === 0 && report.Successful !== false,
        errors,
        warnings,
        detail: {
            profileId,
            level,
            iterations,
            passed: report.passed,
            failed: report.failed,
            failureRate: report.failureRate,
            errorCodes: report.errorCodes || {},
            layoutType: report.layoutType || null,
            durationMs: report.durationMs != null ? report.durationMs : null,
            sampleFailures: (report.errorLogLines || []).slice(0, 5)
        }
    };
}

function main() {
    const args = parseArgs(process.argv);
    if (!args.kind || !args.id) {
        console.log(
            JSON.stringify({
                ok: false,
                errors: ['missing --kind and/or --id'],
                warnings: [],
                level: args.level,
                durationMs: 0
            })
        );
        process.exit(1);
    }

    const t0 = Date.now();
    try {
        let result;
        if (args.kind === 'pieces') {
            const raw = readJson(`presets/${args.mode}/pieces/${args.id}.json`);
            result = validatePiecePack(raw);
        } else if (args.kind === 'biomes') {
            result = validateBiome(args.mode, args.id);
        } else if (args.kind === 'dungeons') {
            result = validateDungeon(args.mode, args.id, args.level);
        } else if (args.kind === 'tile_roles') {
            const { validateTileRole } = require(path.join(
                ROOT,
                'kernel/core/lib/dungeon/tile_roles.js'
            ));
            const raw = readJson(`presets/${args.mode}/tile_roles/${args.id}.json`);
            result = validateTileRole(raw);
        } else {
            result = {
                ok: false,
                errors: [
                    `validate_not_supported_for_kind:${args.kind} (supported: pieces, biomes, dungeons, tile_roles)`
                ],
                warnings: [],
                detail: null
            };
        }
        const durationMs = Date.now() - t0;
        console.log(
            JSON.stringify({
                ...result,
                level: args.level,
                durationMs
            })
        );
        process.exit(result.ok ? 0 : 2);
    } catch (err) {
        console.log(
            JSON.stringify({
                ok: false,
                errors: [err && err.message ? err.message : String(err)],
                warnings: [],
                level: args.level,
                durationMs: Date.now() - t0
            })
        );
        process.exit(1);
    }
}

main();
