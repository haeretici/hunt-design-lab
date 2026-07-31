/**
 * Hunt Simulation Batch Builder (Stage 12I + web run + I6 recipes).
 *
 * Composes headless hunt JSON + CLI for `npm run sim:batch` / SIMULATION.sh,
 * and I6 analysis recipes (class matrix / strategy eval / threat CLI).
 * Can also queue batch jobs via php/api.php (`script: sim_batch`).
 * Distinct from the sprite Batch Builder (`sprite-batch-builder.php`).
 */

'use strict';

const { appUrl } = require('../core/lib/app_paths.js');
const {
    resolvePreferredContentModeId
} = require('../core/lib/ui_preferences.js');
const {
    SIM_BATCH_CHANNEL
} = require('../../html/widgets/sim_batch_builder/protocol.js');
const {
    mergeSimBatchPrefill
} = require('../../html/widgets/sim_batch_builder/parent_bridge.js');
const {
    membersToPartyConfig
} = require('./game/party_form.js');
const {
    listAnalysisRecipes,
    getAnalysisRecipe,
    formatRecipeCli,
    ANALYSIS_MINI_TUTORIAL
} = require('../core/lib/analysis_recipes.js');

/** Guideline from SIMULATION.sh / Stage 12A: warn above this (web run hard-caps at this). */
const LARGE_BATCH_ITERATIONS = 900;

/** Web API poll interval (matches sprite Batch Builder). */
const POLL_MS = 2000;

/**
 * Job API base URL (php/api.php).
 * @returns {string}
 */
function apiUrl() {
    if (typeof window !== 'undefined' && window.__API_URL__) {
        return String(window.__API_URL__);
    }
    return appUrl('php/api.php');
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} [params]
 * @param {{ method?: string }} [opts]
 */
async function apiCall(action, params = {}, opts = {}) {
    const method = (opts.method || (action === 'run' ? 'POST' : 'GET')).toUpperCase();
    const url = new URL(apiUrl(), window.location.href);
    url.searchParams.set('action', action);

    /** @type {RequestInit} */
    const init = { method, headers: {}, cache: 'no-store' };

    if (method === 'GET' || method === 'HEAD') {
        for (const [k, v] of Object.entries(params)) {
            if (v === undefined || v === null) continue;
            url.searchParams.set(k, String(v));
        }
    } else {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify({ action, ...params });
    }

    const res = await fetch(url.href, init);
    let data;
    try {
        data = await res.json();
    } catch (_) {
        throw new Error(`API ${action}: invalid JSON (HTTP ${res.status})`);
    }
    if (!res.ok || data.ok === false) {
        throw new Error((data && data.error) || `API ${action} failed (HTTP ${res.status})`);
    }
    return data;
}

/**
 * Build PHP job payload from a normalized form / config.
 * @param {object} rawForm
 * @returns {Record<string, unknown>}
 */
function buildSimBatchRunPayload(rawForm) {
    const cfg = buildSimBatchConfig(rawForm);
    /** @type {Record<string, unknown>} */
    const payload = {
        script: 'sim_batch',
        iterations: cfg.iterations,
        seed: cfg.seed,
        concurrency: cfg.concurrency,
        huntId: cfg.huntId,
        outDir: cfg.outDir,
        quiet: cfg.quiet !== false
    };
    if (cfg.frames != null) payload.frames = cfg.frames;
    if (cfg.maxKills != null) payload.maxKills = cfg.maxKills;
    if (cfg.maxTicks != null) payload.maxTicks = cfg.maxTicks;
    if (Array.isArray(cfg.members) && cfg.members.length) {
        payload.members = cfg.members;
    }
    return payload;
}

/**
 * @param {string} st
 */
function setJobBadge(st) {
    const badge = document.getElementById('jobStatusBadge');
    if (!badge) return;
    badge.textContent = st;
    badge.setAttribute('data-status', st);
}

/** Defaults for form + pure helpers. */
const DEFAULT_SIM_BATCH_FORM = {
    iterations: 10,
    seed: 42,
    concurrency: 1,
    huntId: 'cave_crawl_generated',
    outDir: 'var/sim',
    frames: null,
    maxKills: null,
    maxTicks: null,
    strategyOverride: '',
    quiet: true,
    members: null
};

/**
 * Fallback hunt ids when presets cannot be listed in the browser.
 * Includes product / I6 cookbook hunts.
 * @type {string[]}
 */
const FALLBACK_HUNT_IDS = [
    'golden_cave_crawl',
    'standard_arena_waves',
    'rising_pressure_macro',
    'cave_band_low',
    'cave_band_mid',
    'crypt_band_high',
    'cave_crawl_generated',
    'catalog_crawl_generated',
    'outskirts_camp_fixed',
    'cave_crawl_multifloor'
];

/**
 * Normalize raw form / prefill bag into a stable form object.
 * @param {object|null|undefined} raw
 * @returns {object}
 */
function normalizeSimBatchForm(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const iterations = parseInt(r.iterations, 10);
    const seed = parseInt(r.seed, 10);
    const concurrency = parseInt(r.concurrency, 10);
    const frames =
        r.frames === '' || r.frames == null ? null : parseInt(r.frames, 10);
    const maxKills =
        r.maxKills === '' || r.maxKills == null
            ? null
            : parseInt(r.maxKills, 10);
    const maxTicks =
        r.maxTicks === '' || r.maxTicks == null
            ? null
            : parseInt(r.maxTicks, 10);

    return {
        iterations:
            Number.isFinite(iterations) && iterations >= 1
                ? iterations
                : DEFAULT_SIM_BATCH_FORM.iterations,
        seed:
            Number.isFinite(seed) && seed >= 1
                ? seed
                : DEFAULT_SIM_BATCH_FORM.seed,
        concurrency:
            Number.isFinite(concurrency) && concurrency >= 1
                ? concurrency
                : DEFAULT_SIM_BATCH_FORM.concurrency,
        huntId:
            r.huntId != null && String(r.huntId).trim() !== ''
                ? String(r.huntId).trim()
                : DEFAULT_SIM_BATCH_FORM.huntId,
        outDir:
            r.outDir != null && String(r.outDir).trim() !== ''
                ? String(r.outDir).trim()
                : DEFAULT_SIM_BATCH_FORM.outDir,
        frames:
            frames != null && Number.isFinite(frames) && frames >= 1
                ? frames
                : null,
        maxKills:
            maxKills != null && Number.isFinite(maxKills) && maxKills >= 1
                ? maxKills
                : null,
        maxTicks:
            maxTicks != null && Number.isFinite(maxTicks) && maxTicks >= 1
                ? maxTicks
                : null,
        strategyOverride:
            r.strategyOverride != null
                ? String(r.strategyOverride).trim()
                : '',
        quiet: r.quiet !== false && r.quiet !== 0 && r.quiet !== '0',
        members: Array.isArray(r.members) ? r.members.slice() : null
    };
}

/**
 * Build party members for headless config when form has members and/or
 * a global strategy override.
 * @param {object} form normalized form
 * @returns {object[]|null} members array for resolveHuntConfig, or null
 */
function buildMembersForConfig(form) {
    const f = form || {};
    let members = Array.isArray(f.members) ? f.members : null;
    if (!members || !members.length) {
        if (!f.strategyOverride) return null;
        // Strategy-only override without a party draft: leave hunt default party.
        return null;
    }

    // Form rows may be editor-shaped (enabled flags) or already headless-shaped.
    const hasEnabledFlag = members.some(
        (m) => m && Object.prototype.hasOwnProperty.call(m, 'enabled')
    );
    let partyMembers = hasEnabledFlag
        ? membersToPartyConfig(members)
        : (() => {
              const {
                  expandPartyMember
              } = require('../core/lib/character/player_profile.js');
              let loadPlayerProfile = null;
              try {
                  loadPlayerProfile =
                      require('../core/lib/presets.js').loadPlayerProfile;
              } catch (_) {
                  loadPlayerProfile = null;
              }
              return members
                  .filter((m) => m && m.enabled !== false)
                  .map((m) => {
                      const expanded = expandPartyMember(m, {
                          loadPlayerProfile: loadPlayerProfile || undefined
                      });
                      const src = expanded || m;
                      return {
                          name: src.name || 'Member',
                          classId: src.classId || src.vocation || 'adventurer',
                          strategyId: src.strategyId || 'balanced',
                          level: src.level != null ? src.level : 50,
                          isLeader: !!src.isLeader,
                          equipment:
                              src.equipment && typeof src.equipment === 'object'
                                  ? src.equipment
                                  : {},
                          profileId: src.profileId || m.profileId || undefined
                      };
                  });
          })();

    if (f.strategyOverride) {
        partyMembers = partyMembers.map((m) =>
            Object.assign({}, m, { strategyId: f.strategyOverride })
        );
    }
    return partyMembers.length ? partyMembers : null;
}

/**
 * Form values → JSON config accepted by `scripts/batch_worker.js` /
 * `runHeadlessHuntBatch` (resolveHuntConfig field names).
 * @param {object|null|undefined} rawForm
 * @returns {object}
 */
function buildSimBatchConfig(rawForm) {
    const form = normalizeSimBatchForm(rawForm);
    const cfg = {
        iterations: form.iterations,
        seed: form.seed,
        concurrency: form.concurrency,
        huntId: form.huntId,
        outDir: form.outDir,
        quiet: form.quiet
    };
    if (form.frames != null) cfg.frames = form.frames;
    if (form.maxKills != null) cfg.maxKills = form.maxKills;
    if (form.maxTicks != null) cfg.maxTicks = form.maxTicks;

    const members = buildMembersForConfig(form);
    if (members) cfg.members = members;

    return cfg;
}

/**
 * @param {object} config
 * @returns {string} npm run sim:batch -- '<json>'
 */
function formatSimBatchCliJson(config) {
    const compact = JSON.stringify(config || {});
    return `npm run sim:batch -- '${compact}'`;
}

/**
 * Flag form when optional JSON-only fields are absent; falls back to JSON
 * when members / maxTicks need the payload object.
 * @param {object} config
 * @returns {string}
 */
function formatSimBatchCliFlags(config) {
    const c = config || {};
    // Members and maxTicks are JSON-only in batch_worker today.
    if (Array.isArray(c.members) && c.members.length) {
        return formatSimBatchCliJson(c);
    }
    if (c.maxTicks != null) {
        return formatSimBatchCliJson(c);
    }

    const parts = ['npm run sim:batch --'];
    if (c.iterations != null) parts.push(`--iterations ${c.iterations}`);
    if (c.seed != null) parts.push(`--seed ${c.seed}`);
    if (c.concurrency != null) parts.push(`--concurrency ${c.concurrency}`);
    if (c.huntId) parts.push(`--hunt ${shellQuote(c.huntId)}`);
    if (c.outDir) parts.push(`--out ${shellQuote(c.outDir)}`);
    if (c.frames != null) parts.push(`--frames ${c.frames}`);
    if (c.quiet) parts.push('--quiet');
    // maxKills only via JSON in batch_worker — fold into JSON if set
    if (c.maxKills != null) {
        return formatSimBatchCliJson(c);
    }
    return parts.join(' ');
}

/**
 * Minimal shell quoting for safe display/copy (single-quoted when needed).
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
    const t = String(s);
    if (/^[A-Za-z0-9_./:@+=,-]+$/.test(t)) return t;
    return `'${t.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {number} iterations
 * @returns {boolean}
 */
function isLargeBatch(iterations) {
    const n = parseInt(iterations, 10);
    return Number.isFinite(n) && n > LARGE_BATCH_ITERATIONS;
}

/**
 * Hint line for large campaigns.
 * @param {object} config
 * @returns {string}
 */
function formatLargeBatchHint(config) {
    const compact = JSON.stringify(config || {});
    return (
        `Iterations > ${LARGE_BATCH_ITERATIONS}: save JSON and run ` +
        `./SIMULATION.sh path/to/config.json (or DRY_RUN=1 ./SIMULATION.sh). ` +
        `Payload: ${compact}`
    );
}

/**
 * @param {string} text
 */
function copyText(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return;
    }
    fallbackCopy(text);
}

/**
 * @param {string} text
 */
function fallbackCopy(text) {
    if (typeof document === 'undefined') return;
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
    } catch (_) {
        /* ignore */
    }
    document.body.removeChild(ta);
}

/**
 * @param {HTMLSelectElement|null} select
 * @param {string[]} ids
 * @param {string} selected
 */
function fillHuntSelect(select, ids, selected) {
    if (!select) return;
    const list = ids && ids.length ? ids : FALLBACK_HUNT_IDS;
    select.innerHTML = list
        .map((id) => {
            const sel = id === selected ? ' selected' : '';
            return `<option value="${escapeAttr(id)}"${sel}>${escapeHtml(id)}</option>`;
        })
        .join('');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

/**
 * Read current form DOM into a raw bag.
 * @returns {object}
 */
function readFormDom() {
    const num = (id) => {
        const el = document.getElementById(id);
        if (!el || el.value === '') return null;
        return el.value;
    };
    const str = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : '';
    };
    const quietEl = document.getElementById('quiet');
    return {
        iterations: num('iterations'),
        seed: num('seed'),
        concurrency: num('concurrency'),
        huntId: str('huntId'),
        outDir: str('outDir'),
        frames: num('frames'),
        maxKills: num('maxKills'),
        maxTicks: num('maxTicks'),
        strategyOverride: str('strategyOverride'),
        quiet: quietEl ? quietEl.checked : true,
        members: window.__SIM_BATCH_MEMBERS__ || null
    };
}

/**
 * Apply normalized form values onto the DOM.
 * @param {object} form
 */
function writeFormDom(form) {
    const f = normalizeSimBatchForm(form);
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') {
            el.checked = !!val;
            return;
        }
        el.value = val == null ? '' : String(val);
    };
    set('iterations', f.iterations);
    set('seed', f.seed);
    set('concurrency', f.concurrency);
    set('huntId', f.huntId);
    set('outDir', f.outDir);
    set('frames', f.frames);
    set('maxKills', f.maxKills);
    set('maxTicks', f.maxTicks);
    set('strategyOverride', f.strategyOverride);
    set('quiet', f.quiet);
    if (Array.isArray(f.members)) {
        window.__SIM_BATCH_MEMBERS__ = f.members;
    }
    const partyNote = document.getElementById('partyPrefillNote');
    if (partyNote) {
        if (Array.isArray(f.members) && f.members.length) {
            const n = f.members.filter((m) => m && m.enabled !== false).length;
            partyNote.hidden = false;
            partyNote.textContent = `Party draft prefilled from Hunt Simulator (${n} member(s) in config).`;
        }
    }
}

/**
 * Browser entry for `#sim-batch-builder-app`.
 */
async function initSimBatchBuilderApp() {
    const params =
        typeof window !== 'undefined' && window.location
            ? new URLSearchParams(window.location.search)
            : new URLSearchParams();
    const isPopup =
        params.get('popup') === '1' ||
        (typeof window !== 'undefined' && !!window.opener);

    if (isPopup && document.body) {
        document.body.classList.add('sim-batch-popup');
    }

    /** @type {string|null} */
    let activeRecipeId = null;

    // Hunt list for select
    let huntIds = FALLBACK_HUNT_IDS.slice();
    try {
        const modeId = resolvePreferredContentModeId({
            fallback:
                (typeof window !== 'undefined' && window.__CONTENT_MODE__) ||
                'standard',
            defaultId: 'standard'
        });
        // Prefer browser pack hunt list when available
        const packRes = await fetch(
            apiUrl() +
                '?action=presets_browser_pack&mode=' +
                encodeURIComponent(modeId),
            { cache: 'no-store' }
        ).catch(() => null);
        if (packRes && packRes.ok) {
            const pack = await packRes.json();
            const fromPack =
                pack &&
                pack.browser &&
                Array.isArray(pack.browser.hunts)
                    ? pack.browser.hunts.map((h) =>
                          typeof h === 'string' ? h : h && h.id
                      ).filter(Boolean)
                    : pack && Array.isArray(pack.huntIds)
                      ? pack.huntIds
                      : null;
            if (fromPack && fromPack.length) {
                huntIds = Array.from(new Set(fromPack.concat(FALLBACK_HUNT_IDS)));
            }
        }
    } catch (_) {
        /* keep fallbacks */
    }

    const huntSelect = document.getElementById('huntId');
    fillHuntSelect(huntSelect, huntIds, DEFAULT_SIM_BATCH_FORM.huntId);

    // I6 recipes + mini-tutorial
    paintRecipeCards();
    paintMiniTutorial();

    // Strategy ids (optional override)
    const stratSelect = document.getElementById('strategyOverride');
    if (stratSelect) {
        try {
            const res = await fetch(appUrl('presets/strategies.json'));
            if (res.ok) {
                const data = await res.json();
                const list = Array.isArray(data.strategies) ? data.strategies : [];
                const opts = ['<option value="">(hunt default)</option>'];
                for (let i = 0; i < list.length; i++) {
                    const s = list[i];
                    if (!s || !s.id) continue;
                    const label = s.label || s.id;
                    opts.push(
                        `<option value="${escapeAttr(s.id)}">${escapeHtml(label)}</option>`
                    );
                }
                stratSelect.innerHTML = opts.join('');
            }
        } catch (err) {
            console.warn('Sim Batch: failed to load strategies', err);
        }
    }

    writeFormDom(DEFAULT_SIM_BATCH_FORM);

    const runBatchBtn = /** @type {HTMLButtonElement|null} */ (
        document.getElementById('runBatchBtn')
    );
    const refreshJobBtn = /** @type {HTMLButtonElement|null} */ (
        document.getElementById('refreshJobBtn')
    );
    const copyJobIdBtn = /** @type {HTMLButtonElement|null} */ (
        document.getElementById('copyJobIdBtn')
    );

    /** @type {string|null} */
    let activeJobId = null;
    let logOffset = 0;
    let logBuffer = '';
    /** @type {ReturnType<typeof setInterval>|null} */
    let pollTimer = null;

    function status(msg) {
        const el = document.getElementById('simBatchStatus');
        if (el) el.textContent = msg;
    }

    /**
     * Paint I6 recipe buttons into #recipeCards.
     */
    function paintRecipeCards() {
        const host = document.getElementById('recipeCards');
        if (!host) return;
        const recipes = listAnalysisRecipes();
        host.innerHTML = recipes
            .map((r) => {
                const active = r.id === activeRecipeId ? ' is-active' : '';
                const badge = r.webRunnable
                    ? '<span class="recipe-badge recipe-badge--web">web run</span>'
                    : '<span class="recipe-badge recipe-badge--cli">CLI</span>';
                return (
                    `<button type="button" class="recipe-card${active}" data-recipe="${escapeAttr(r.id)}">` +
                    `<span class="recipe-card-title">${escapeHtml(r.label)} ${badge}</span>` +
                    `<span class="recipe-card-q">${escapeHtml(r.question)}</span>` +
                    `</button>`
                );
            })
            .join('');
        host.querySelectorAll('[data-recipe]').forEach((btn) => {
            btn.addEventListener('click', () => {
                applyRecipe(btn.getAttribute('data-recipe') || '');
            });
        });
    }

    function paintMiniTutorial() {
        const host = document.getElementById('miniTutorialSteps');
        if (!host) return;
        host.innerHTML = ANALYSIS_MINI_TUTORIAL.map(
            (step) =>
                `<li><strong>${escapeHtml(step.title)}</strong> ${escapeHtml(step.body)}</li>`
        ).join('');
    }

    /**
     * Apply an I6 recipe to the form + previews.
     * @param {string} id
     */
    function applyRecipe(id) {
        const recipe = getAnalysisRecipe(id);
        if (!recipe) return;
        activeRecipeId = recipe.id;
        paintRecipeCards();

        if (recipe.form) {
            const merged = normalizeSimBatchForm(
                Object.assign({}, readFormDom(), recipe.form)
            );
            writeFormDom(merged);
            if (huntSelect && recipe.form.huntId) {
                const exists = Array.from(huntSelect.options).some(
                    (o) => o.value === recipe.form.huntId
                );
                if (!exists) {
                    const opt = document.createElement('option');
                    opt.value = recipe.form.huntId;
                    opt.textContent = recipe.form.huntId;
                    huntSelect.appendChild(opt);
                }
                huntSelect.value = recipe.form.huntId;
            }
        }

        const detail = document.getElementById('recipeDetail');
        if (detail) {
            detail.hidden = false;
            detail.innerHTML =
                `<p class="mb-1"><strong>${escapeHtml(recipe.label)}</strong></p>` +
                `<p class="text-muted text-xxs mb-1"><em>Question:</em> ${escapeHtml(recipe.question)}</p>` +
                `<p class="text-xxs mb-1">${escapeHtml(recipe.why)}</p>` +
                `<p class="text-xxs mb-1"><em>How to read:</em> ${escapeHtml(recipe.howToRead)}</p>` +
                `<p class="text-xxs mb-0 text-info"><i class="fa-solid fa-chart-column me-1"></i>${escapeHtml(recipe.analysisHint)}</p>`;
        }

        updatePreview();
        status(
            recipe.webRunnable
                ? `Recipe “${recipe.label}” — adjust settings, then Run batch or copy CLI`
                : `Recipe “${recipe.label}” — CLI only; copy command and run in project root`
        );
    }

    function updatePreview() {
        const form = normalizeSimBatchForm(readFormDom());
        const cfg = buildSimBatchConfig(form);
        const recipe = activeRecipeId ? getAnalysisRecipe(activeRecipeId) : null;
        const jsonEl = document.getElementById('jsonPreview');
        const cliEl = document.getElementById('cliCommand');
        const flagsEl = document.getElementById('cliFlagsCommand');
        const warnEl = document.getElementById('largeBatchWarn');
        const kindNote = document.getElementById('recipeKindNote');

        if (recipe && recipe.kind !== 'batch') {
            const cli = formatRecipeCli(recipe, form);
            if (jsonEl) {
                jsonEl.textContent = JSON.stringify(
                    {
                        recipe: recipe.id,
                        kind: recipe.kind,
                        note: 'CLI-only recipe — not a sim:batch JSON payload',
                        command: cli,
                        form: {
                            huntId: form.huntId,
                            seed: form.seed,
                            iterations: form.iterations,
                            outDir: form.outDir
                        }
                    },
                    null,
                    2
                );
            }
            if (cliEl) cliEl.textContent = cli;
            if (flagsEl) flagsEl.textContent = cli;
            if (kindNote) {
                kindNote.hidden = false;
                kindNote.textContent =
                    'This recipe is CLI-only (sweep / strategy eval / threat). Copy the command — Run batch is disabled.';
            }
            if (runBatchBtn) runBatchBtn.disabled = true;
        } else {
            if (jsonEl) jsonEl.textContent = JSON.stringify(cfg, null, 2);
            if (cliEl) cliEl.textContent = formatSimBatchCliJson(cfg);
            if (flagsEl) flagsEl.textContent = formatSimBatchCliFlags(cfg);
            if (kindNote) {
                kindNote.hidden = true;
                kindNote.textContent = '';
            }
            if (runBatchBtn && !activeJobId) runBatchBtn.disabled = false;
        }

        if (warnEl) {
            if (isLargeBatch(form.iterations) && (!recipe || recipe.kind === 'batch')) {
                warnEl.hidden = false;
                warnEl.textContent = formatLargeBatchHint(cfg);
            } else {
                warnEl.hidden = true;
                warnEl.textContent = '';
            }
        }
        if (!activeJobId && (!recipe || recipe.kind === 'batch')) {
            status(
                `Config ready · ${cfg.iterations}× ${cfg.huntId} · seed ${cfg.seed}`
            );
        }
    }

    /**
     * @param {Record<string, unknown>} job
     * @param {{ content?: string, offset?: number }} [log]
     */
    function paintJob(job, log) {
        const st = String(job.status || 'unknown');
        setJobBadge(st);

        const metaEl = document.getElementById('jobMeta');
        if (metaEl) {
            const parts = [
                `<div><span class="text-muted">Id:</span> <code>${escapeHtml(String(job.id || ''))}</code></div>`,
                `<div><span class="text-muted">Status:</span> ${escapeHtml(st)}` +
                    (job.exit_code != null
                        ? ` · exit ${escapeHtml(String(job.exit_code))}`
                        : '') +
                    `</div>`,
                job.command
                    ? `<div><span class="text-muted">Cmd:</span> <code>${escapeHtml(String(job.command))}</code></div>`
                    : '',
                job.error
                    ? `<div class="text-danger"><span class="text-muted">Error:</span> ${escapeHtml(String(job.error))}</div>`
                    : '',
                job.created_at
                    ? `<div><span class="text-muted">Created:</span> ${escapeHtml(String(job.created_at))}</div>`
                    : '',
                job.finished_at
                    ? `<div><span class="text-muted">Finished:</span> ${escapeHtml(String(job.finished_at))}</div>`
                    : ''
            ];
            metaEl.innerHTML = parts.filter(Boolean).join('');
        }

        if (log && typeof log.content === 'string' && log.content.length) {
            logBuffer += log.content;
            if (typeof log.offset === 'number') {
                logOffset = log.offset;
            }
        }
        const logEl = document.getElementById('jobLog');
        if (logEl) {
            logEl.textContent = logBuffer || '—';
            logEl.scrollTop = logEl.scrollHeight;
        }

        if (refreshJobBtn) refreshJobBtn.disabled = !activeJobId;
        if (copyJobIdBtn) copyJobIdBtn.disabled = !activeJobId;

        const terminal = st === 'completed' || st === 'failed';
        if (runBatchBtn) {
            runBatchBtn.disabled = st === 'queued' || st === 'running';
        }
        if (terminal) {
            stopPolling();
            if (st === 'completed') {
                const form = normalizeSimBatchForm(readFormDom());
                status(
                    `Job completed · summaries in ${form.outDir} · open Analysis to chart`
                );
            } else {
                status(
                    `Job failed${job.exit_code != null ? ` (exit ${job.exit_code})` : ''}`
                );
            }
        }
    }

    function stopPolling() {
        if (pollTimer != null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function pollJobOnce() {
        if (!activeJobId) return;
        try {
            const data = await apiCall('status', {
                id: activeJobId,
                offset: logOffset
            });
            paintJob(data.job || {}, data.log || {});
        } catch (e) {
            status(`Status poll error: ${e.message || e}`);
            console.error(e);
        }
    }

    function startPolling() {
        stopPolling();
        pollTimer = setInterval(() => {
            pollJobOnce().catch(() => {});
        }, POLL_MS);
    }

    async function runBatch() {
        const recipe = activeRecipeId ? getAnalysisRecipe(activeRecipeId) : null;
        if (recipe && recipe.kind !== 'batch') {
            status(
                `Recipe “${recipe.label}” is CLI-only — copy the command below.`
            );
            return;
        }
        const form = normalizeSimBatchForm(readFormDom());
        if (isLargeBatch(form.iterations)) {
            status(
                `Iterations > ${LARGE_BATCH_ITERATIONS}: use ./SIMULATION.sh (web run is capped).`
            );
            return;
        }
        // Web outDir must stay under var/sim (PHP whitelist)
        if (
            form.outDir !== 'var/sim' &&
            !String(form.outDir).startsWith('var/sim/')
        ) {
            status('Output dir for web run must be under var/sim/');
            return;
        }

        const payload = buildSimBatchRunPayload(form);
        if (runBatchBtn) runBatchBtn.disabled = true;
        status('Queueing hunt batch…');
        logBuffer = '';
        logOffset = 0;
        const logEl = document.getElementById('jobLog');
        if (logEl) logEl.textContent = 'Starting…';

        try {
            const data = await apiCall('run', payload, { method: 'POST' });
            const job = data.job || {};
            activeJobId = job.id ? String(job.id) : null;
            paintJob(job, { content: '', offset: 0 });
            status(
                activeJobId
                    ? `Job ${activeJobId.slice(0, 8)}… ${job.status || 'queued'}`
                    : 'Job queued'
            );
            if (activeJobId) {
                startPolling();
                await pollJobOnce();
            }
        } catch (e) {
            setJobBadge('failed');
            status(`Run failed: ${e.message || e}`);
            if (runBatchBtn) runBatchBtn.disabled = false;
            console.error(e);
        }
    }

    const fieldIds = [
        'iterations',
        'seed',
        'concurrency',
        'huntId',
        'outDir',
        'frames',
        'maxKills',
        'maxTicks',
        'strategyOverride',
        'quiet'
    ];
    for (let i = 0; i < fieldIds.length; i++) {
        const el = document.getElementById(fieldIds[i]);
        if (!el) continue;
        el.addEventListener('input', updatePreview);
        el.addEventListener('change', updatePreview);
    }

    const copyJsonBtn = document.getElementById('copyJsonBtn');
    if (copyJsonBtn) {
        copyJsonBtn.addEventListener('click', () => {
            const el = document.getElementById('jsonPreview');
            if (el) copyText(el.textContent || '');
        });
    }
    const copyCliBtn = document.getElementById('copyCliBtn');
    if (copyCliBtn) {
        copyCliBtn.addEventListener('click', () => {
            const el = document.getElementById('cliCommand');
            if (el) copyText(el.textContent || '');
        });
    }
    const copyFlagsBtn = document.getElementById('copyFlagsBtn');
    if (copyFlagsBtn) {
        copyFlagsBtn.addEventListener('click', () => {
            const el = document.getElementById('cliFlagsCommand');
            if (el) copyText(el.textContent || '');
        });
    }
    const downloadBtn = document.getElementById('downloadConfigBtn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            const el = document.getElementById('jsonPreview');
            const text = el ? el.textContent || '{}' : '{}';
            const blob = new Blob([text], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'hunt_batch_config.json';
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }
    const copySimShBtn = document.getElementById('copySimShBtn');
    if (copySimShBtn) {
        copySimShBtn.addEventListener('click', () => {
            const cfg = buildSimBatchConfig(readFormDom());
            const snippet =
                `#!/usr/bin/env bash\n` +
                `set -euo pipefail\n` +
                `cd "$(dirname "$0")"\n` +
                `# Save as e.g. var/sim/my_batch.json then:\n` +
                `./SIMULATION.sh var/sim/my_batch.json\n` +
                `# JSON:\n` +
                `# ${JSON.stringify(cfg)}\n`;
            copyText(snippet);
        });
    }

    runBatchBtn?.addEventListener('click', () => {
        runBatch();
    });
    refreshJobBtn?.addEventListener('click', () => {
        pollJobOnce().catch((e) =>
            status(`Refresh failed: ${e.message || e}`)
        );
    });
    copyJobIdBtn?.addEventListener('click', () => {
        if (activeJobId) copyText(activeJobId);
    });

    // Optional parent prefill bridge
    function onParentMessage(event) {
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (!data || data.channel !== SIM_BATCH_CHANNEL) return;
        if (data.type === 'state' && data.state) {
            const current = normalizeSimBatchForm(readFormDom());
            const merged = mergeSimBatchPrefill(current, data.state);
            writeFormDom(merged);
            // Ensure hunt select has the prefilled id
            if (huntSelect && merged.huntId) {
                const exists = Array.from(huntSelect.options).some(
                    (o) => o.value === merged.huntId
                );
                if (!exists) {
                    const opt = document.createElement('option');
                    opt.value = merged.huntId;
                    opt.textContent = merged.huntId;
                    huntSelect.appendChild(opt);
                }
                huntSelect.value = merged.huntId;
            }
            updatePreview();
        }
    }
    window.addEventListener('message', onParentMessage);

    if (window.opener) {
        try {
            window.opener.postMessage(
                { channel: SIM_BATCH_CHANNEL, type: 'ready' },
                window.location.origin
            );
        } catch (err) {
            console.warn('Sim Batch ready postMessage failed:', err);
        }
        window.addEventListener('beforeunload', () => {
            try {
                if (window.opener && !window.opener.closed) {
                    window.opener.postMessage(
                        { channel: SIM_BATCH_CHANNEL, type: 'closing' },
                        window.location.origin
                    );
                }
            } catch (_) {
                /* ignore */
            }
        });
    }

    setJobBadge('idle');
    updatePreview();
}

module.exports = {
    initSimBatchBuilderApp,
    normalizeSimBatchForm,
    buildSimBatchConfig,
    buildMembersForConfig,
    buildSimBatchRunPayload,
    formatSimBatchCliJson,
    formatSimBatchCliFlags,
    isLargeBatch,
    formatLargeBatchHint,
    LARGE_BATCH_ITERATIONS,
    DEFAULT_SIM_BATCH_FORM,
    FALLBACK_HUNT_IDS,
    shellQuote,
    apiUrl,
    listAnalysisRecipes,
    getAnalysisRecipe,
    formatRecipeCli
};
