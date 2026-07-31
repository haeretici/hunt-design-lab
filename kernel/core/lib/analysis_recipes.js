/**
 * I6 analysis cookbook recipes — pure helpers for CLI strings, Batch Builder
 * prefills, and docs. Browser-safe (no fs).
 *
 * Campaign contract: docs/24 · prioritization: docs/22 · balance CLI: docs/12
 */

'use strict';

/**
 * @typedef {'batch'|'sweep_matrix'|'strategy_eval'|'threat'} RecipeKind
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   kind: RecipeKind,
 *   question: string,
 *   why: string,
 *   howToRead: string,
 *   webRunnable: boolean,
 *   form?: {
 *     iterations?: number,
 *     seed?: number,
 *     concurrency?: number,
 *     huntId?: string,
 *     outDir?: string,
 *     frames?: number|null,
 *     quiet?: boolean,
 *     strategyOverride?: string
 *   },
 *   cliExtras?: {
 *     classes?: string,
 *     rankBy?: string,
 *     strategies?: string|null
 *   },
 *   samplePath?: string,
 *   analysisHint: string
 * }} AnalysisRecipe
 */

/** @type {AnalysisRecipe[]} */
const ANALYSIS_RECIPES = [
    {
        id: 'band_pressure',
        label: 'Band pressure (golden crawl)',
        kind: 'batch',
        question: 'Does mid-band cave pressure hold across a handful of seeds?',
        why: 'Multi-seed batch on the product golden crawl — baseline for wipe/NAT/kills before changing kits or pops.',
        howToRead:
            'Expect few/no party wipes on balance_quartet. High no_attack_timeout after pack clear is known (route stall). Compare mean kills and time across seeds; large seed swings mean the band sample is noisy.',
        webRunnable: true,
        form: {
            iterations: 5,
            seed: 1,
            concurrency: 1,
            huntId: 'golden_cave_crawl',
            outDir: 'var/sim/i6_band_pressure',
            quiet: true,
            strategyOverride: ''
        },
        samplePath: 'presets/standard/analysis/sample_golden_cave_crawl_batch.json',
        analysisHint:
            'Open Analysis → load folder var/sim/i6_band_pressure (batch_aggregate + per-seed rows).'
    },
    {
        id: 'class_matrix',
        label: 'Class matrix (arena)',
        kind: 'sweep_matrix',
        question: 'Which vocations clear the standard arena ladder?',
        why: 'Solo each class on standard_arena_waves — viability ladder, not party synergy.',
        howToRead:
            'Rank by mean kills or wavesComplete rate. Mid quartet often wipes the wave-9 boss (intentional); veterans clear. Pacifist-like failure modes show as wipe/timeout with ~0 kills.',
        webRunnable: false,
        form: {
            iterations: 1,
            seed: 1,
            huntId: 'standard_arena_waves',
            outDir: 'var/sim/sweeps/i6_arena_matrix',
            quiet: true
        },
        cliExtras: {
            classes: 'guardian,scout,adept,warden'
        },
        samplePath: 'presets/standard/analysis/sample_standard_arena_class_matrix.json',
        analysisHint:
            'Open Analysis → load folder var/sim/sweeps/i6_arena_matrix (class_matrix.json).'
    },
    {
        id: 'strategy_rank',
        label: 'Strategy rank (arena)',
        kind: 'strategy_eval',
        question: 'Do combat strategies outrank pacifist on the arena hunt?',
        why: 'Same hunt roster; only strategyId swaps — ranks AI presets for tune loops.',
        howToRead:
            'Sort is route-complete first, then rank-by (default meanKills on arena). Pacifist should sit near the bottom on kills. Use --tune for higher iterations before editing strategies.json.',
        webRunnable: false,
        form: {
            iterations: 1,
            seed: 1,
            huntId: 'standard_arena_waves',
            outDir: 'var/sim/strategy_eval/i6_arena',
            quiet: true
        },
        cliExtras: {
            rankBy: 'meanKills'
        },
        samplePath: 'presets/standard/analysis/sample_standard_arena_strategy_eval.json',
        analysisHint:
            'Open Analysis → load folder var/sim/strategy_eval/i6_arena (strategy_eval.json).'
    },
    {
        id: 'threat_sanity',
        label: 'Threat sanity (catalog)',
        kind: 'threat',
        question: 'Are creature threatDps / level ranks still coherent after kit edits?',
        why: 'Analytical kit DPS report — not a hunt sim. Re-run after rebalance:kits or large port.',
        howToRead:
            'Check corr(level, threatDps) and percentile gaps. Outliers (dummies, pulses) are excluded from scale. Use --apply only when you intend to patch cache fields on creature JSON.',
        webRunnable: false,
        form: {
            outDir: 'reports'
        },
        analysisHint:
            'Reports land under reports/ (gitignored). Not loaded by Analysis UI — open CSV/JSON locally.'
    }
];

/**
 * Mini-tutorial steps shown in Sim Batch Builder (I6).
 * @type {{ title: string, body: string }[]}
 */
const ANALYSIS_MINI_TUTORIAL = [
    {
        title: '1. Pick a recipe',
        body: 'Each recipe answers one balance question. Choosing it fills hunt, seed, iterations, and output folder so commands stay comparable over time.'
    },
    {
        title: '2. Copy CLI or Run batch',
        body: 'Band pressure can Run in the browser (PHP job → same Node batch worker). Class matrix, strategy rank, and threat are CLI-only — copy the command and run in the project root.'
    },
    {
        title: '3. Inspect the folder in Analysis',
        body: 'Open simulation-analysis.php and load the whole results folder (not one seed file). Charts compare seeds / classes / strategies side by side.'
    },
    {
        title: '4. Log limits with evidence',
        body: 'If a run fails for a system reason (pathing, telemetry lie, stall), add a row to the limitations log in docs/24 with seed, hunt, and observation — only then promote kernel work in docs/22.'
    }
];

/**
 * @param {string} id
 * @returns {AnalysisRecipe|null}
 */
function getAnalysisRecipe(id) {
    const key = String(id || '');
    for (let i = 0; i < ANALYSIS_RECIPES.length; i++) {
        if (ANALYSIS_RECIPES[i].id === key) return ANALYSIS_RECIPES[i];
    }
    return null;
}

/**
 * @returns {AnalysisRecipe[]}
 */
function listAnalysisRecipes() {
    return ANALYSIS_RECIPES.slice();
}

/**
 * Build the primary CLI string for a recipe (flags style preferred).
 * @param {AnalysisRecipe|string} recipeOrId
 * @param {object} [formOverride] optional form bag merged over recipe.form
 * @returns {string}
 */
function formatRecipeCli(recipeOrId, formOverride) {
    const recipe =
        typeof recipeOrId === 'string'
            ? getAnalysisRecipe(recipeOrId)
            : recipeOrId;
    if (!recipe) return '';

    const form = Object.assign({}, recipe.form || {}, formOverride || {});
    const extras = recipe.cliExtras || {};

    if (recipe.kind === 'batch') {
        const parts = ['npm run sim:batch --'];
        if (form.iterations != null) parts.push(`--iterations ${form.iterations}`);
        if (form.seed != null) parts.push(`--seed ${form.seed}`);
        if (form.concurrency != null) parts.push(`--concurrency ${form.concurrency}`);
        if (form.huntId) parts.push(`--hunt ${shellQuoteSafe(form.huntId)}`);
        if (form.outDir) parts.push(`--out ${shellQuoteSafe(form.outDir)}`);
        if (form.frames != null) parts.push(`--frames ${form.frames}`);
        if (form.quiet !== false) parts.push('--quiet');
        return parts.join(' ');
    }

    if (recipe.kind === 'sweep_matrix') {
        const parts = [
            'npm run sim:sweep --',
            '--matrix',
            `--hunt ${shellQuoteSafe(form.huntId || 'standard_arena_waves')}`,
            `--seed ${form.seed != null ? form.seed : 1}`,
            `--iterations ${form.iterations != null ? form.iterations : 1}`
        ];
        if (extras.classes) parts.push(`--classes ${extras.classes}`);
        if (form.outDir) parts.push(`--out ${shellQuoteSafe(form.outDir)}`);
        if (form.quiet !== false) parts.push('--quiet');
        return parts.join(' ');
    }

    if (recipe.kind === 'strategy_eval') {
        const parts = [
            'npm run sim:eval-strategies --',
            `--hunt ${shellQuoteSafe(form.huntId || 'standard_arena_waves')}`,
            `--seed ${form.seed != null ? form.seed : 1}`,
            `--iterations ${form.iterations != null ? form.iterations : 1}`,
            `--rank-by ${extras.rankBy || 'meanKills'}`
        ];
        if (extras.strategies) parts.push(`--strategies ${extras.strategies}`);
        if (form.outDir) parts.push(`--out ${shellQuoteSafe(form.outDir)}`);
        if (form.quiet !== false) parts.push('--quiet');
        return parts.join(' ');
    }

    if (recipe.kind === 'threat') {
        return 'npm run measure:threat';
    }

    return '';
}

/**
 * Minimal shell quote for display/copy.
 * @param {string} s
 * @returns {string}
 */
function shellQuoteSafe(s) {
    const t = String(s);
    if (/^[A-Za-z0-9_./:@+=,-]+$/.test(t)) return t;
    return `'${t.replace(/'/g, `'\\''`)}'`;
}

/**
 * Short one-liner for recipe cards.
 * @param {AnalysisRecipe} recipe
 * @returns {string}
 */
function formatRecipeSummary(recipe) {
    if (!recipe) return '';
    return `${recipe.label} — ${recipe.question}`;
}

module.exports = {
    ANALYSIS_RECIPES,
    ANALYSIS_MINI_TUTORIAL,
    listAnalysisRecipes,
    getAnalysisRecipe,
    formatRecipeCli,
    formatRecipeSummary,
    shellQuoteSafe
};
