/**
 * Simulation Analysis UI (Stage 8 + I7 folder view).
 * Loads whole result folders (batch seeds / sweeps / strategy eval) from disk,
 * sample fixtures, paste, or local file. Clear multi-series charts + summary cards.
 */

'use strict';

const {
    normalizeAnalysisDocument,
    chartSeriesFromDocument,
    listKnobs,
    metricLabel,
    groupResultFilesByFolder,
    documentFromFolderEntries
} = require('../../core/lib/balance_analysis.js');
const { appUrl } = require('../../core/lib/app_paths.js');
const {
    createSimBatchParentBridge
} = require('../../../html/widgets/sim_batch_builder/parent_bridge.js');

/**
 * Job / results API base URL (php/api.php).
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
    const method = (opts.method || 'GET').toUpperCase();
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
 * Escape for text content.
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
 * Simple multi-series bar chart on canvas (no chart library).
 * @param {HTMLCanvasElement} canvas
 * @param {{ labels: string[], series: Record<string, number[]> }} data
 * @param {string[]} metricKeys which series to draw
 * @param {Record<string, string>} colors
 */
function drawBarChart(canvas, data, metricKeys, colors) {
    if (!canvas || !data) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 640;
    const cssH = canvas.clientHeight || 320;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW;
    const H = cssH;
    const pad = { top: 32, right: 16, bottom: 52, left: 56 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, W, H);

    const labels = data.labels || [];
    const keys = metricKeys.filter((k) => data.series[k]);
    if (!labels.length || !keys.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '13px Outfit, sans-serif';
        ctx.fillText('No series to plot — load a folder or sample', pad.left, pad.top + 20);
        return;
    }

    // Rate metrics (0–1) vs absolute means use separate max when mixed is hard;
    // keep single scale for simplicity but mark rates in legend.
    let maxY = 0;
    for (let k = 0; k < keys.length; k++) {
        const arr = data.series[keys[k]] || [];
        for (let i = 0; i < arr.length; i++) {
            let v = arr[i];
            // Plot rates as percent (0–100) so they share scale with small means better
            if (isRateMetric(keys[k])) v = v * 100;
            if (v > maxY) maxY = v;
        }
    }
    if (maxY <= 0) maxY = 1;
    maxY *= 1.12;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '11px JetBrains Mono, monospace';
    ctx.lineWidth = 1;
    const gridLines = 4;
    for (let g = 0; g <= gridLines; g++) {
        const t = g / gridLines;
        const y = pad.top + plotH * (1 - t);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        const val = maxY * t;
        const label =
            val >= 100 ? String(Math.round(val)) : val.toFixed(val >= 1 ? 1 : 2);
        ctx.fillText(label, 6, y + 4);
    }

    const n = labels.length;
    const groupW = plotW / n;
    const barGap = 2;
    const barW = Math.max(
        2,
        (groupW - 12) / Math.max(1, keys.length) - barGap
    );

    for (let i = 0; i < n; i++) {
        const gx = pad.left + i * groupW + 6;
        for (let k = 0; k < keys.length; k++) {
            let v = (data.series[keys[k]] || [])[i] || 0;
            if (isRateMetric(keys[k])) v = v * 100;
            const h = (v / maxY) * plotH;
            const x = gx + k * (barW + barGap);
            const y = pad.top + plotH - h;
            ctx.fillStyle = colors[keys[k]] || '#00f2fe';
            ctx.fillRect(x, y, barW, Math.max(1, h));
        }
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = '10px JetBrains Mono, monospace';
        const lx = pad.left + i * groupW + groupW / 2;
        ctx.textAlign = 'center';
        const lab = String(labels[i]);
        const short = lab.length > 14 ? lab.slice(0, 12) + '…' : lab;
        ctx.fillText(short, lx, H - 22);
        ctx.textAlign = 'left';
    }

    let lx = pad.left;
    ctx.font = '11px Outfit, sans-serif';
    for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        ctx.fillStyle = colors[key] || '#00f2fe';
        ctx.fillRect(lx, 8, 10, 10);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        const label = metricLabel(key) + (isRateMetric(key) ? ' (×100)' : '');
        ctx.fillText(label, lx + 14, 17);
        lx += ctx.measureText(label).width + 28;
    }
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function isRateMetric(key) {
    return /Rate$/.test(key);
}

const METRIC_COLORS = {
    routeCompleteRate: '#6dffb0',
    partyWipeRate: '#ff7b7b',
    timeoutRate: '#ffb700',
    noAttackTimeoutRate: '#ff9f40',
    meanKills: '#00f2fe',
    meanExpPerHour: '#c77dff',
    meanTimeToClear: '#ffcc00',
    meanDamageDealt: '#7bb3ff',
    meanDeaths: '#ff9f7b',
    wavesCompleteRate: '#6dffd0',
    killCapRate: '#d0d0d0'
};

const DEFAULT_PLOT = [
    'meanKills',
    'partyWipeRate',
    'noAttackTimeoutRate',
    'meanTimeToClear'
];

/**
 * @param {object} doc
 * @param {object} els
 * @param {string} [sourceHint]
 */
function renderDocument(doc, els, sourceHint) {
    const normalized = normalizeAnalysisDocument(doc);
    if (!normalized) {
        setStatus(
            els,
            'Invalid document (expected sweep / class_matrix / batch / hunt summary / folder set).',
            true
        );
        return;
    }

    const chart = chartSeriesFromDocument(normalized);
    const titleParts = [];
    if (normalized.kind === 'class_matrix') {
        titleParts.push('Class viability matrix');
    } else if (normalized.kind === 'strategy_eval') {
        titleParts.push('Strategy ranking');
    } else if (normalized.kind === 'batch_folder') {
        titleParts.push('Batch folder (per seed)');
    } else if (normalized.kind === 'side_swap') {
        titleParts.push('Side-swap composition');
    } else if (normalized.knobLabel) {
        titleParts.push(normalized.knobLabel);
    } else if (normalized.kind === 'sweep') {
        titleParts.push(`Sweep: ${normalized.knob || '?'}`);
    } else {
        titleParts.push(String(normalized.kind || 'Analysis'));
    }
    if (normalized.huntId) titleParts.push(`hunt ${normalized.huntId}`);
    if (normalized.seed != null && normalized.kind !== 'batch_folder') {
        titleParts.push(`seed ${normalized.seed}`);
    }
    if (normalized.folderPath) titleParts.push(normalized.folderPath);

    if (els.title) els.title.textContent = titleParts.join(' · ');
    if (els.meta) {
        const bits = [
            `kind=${normalized.kind}`,
            normalized.iterationsPerValue != null
                ? `iters/row=${normalized.iterationsPerValue}`
                : null,
            normalized.iterations != null
                ? `batch n=${normalized.iterations}`
                : null,
            Array.isArray(normalized.rows)
                ? `${normalized.rows.length} row(s)`
                : null,
            normalized.generatedAt ? `at ${normalized.generatedAt}` : null,
            sourceHint || null
        ].filter(Boolean);
        els.meta.textContent = bits.join(' · ');
    }

    if (els.footerHint && sourceHint) {
        els.footerHint.textContent = sourceHint;
    }

    renderSummaryCards(normalized, els);

    const available = Object.keys(chart.series).filter((k) => {
        const arr = chart.series[k] || [];
        return arr.some((v) => Number(v) !== 0) || availableAlways(k);
    });
    const preferred = (normalized.chartMetrics || DEFAULT_PLOT).filter(
        (k) => available.indexOf(k) >= 0 || (chart.series[k] && chart.series[k].length)
    );
    const keys =
        preferred.length > 0
            ? preferred.slice(0, 4)
            : DEFAULT_PLOT.filter((k) => chart.series[k]).slice(0, 4);

    const allKeys = Object.keys(chart.series);

    if (els.metricChecks) {
        els.metricChecks.innerHTML = allKeys
            .map((k) => {
                const checked = keys.indexOf(k) >= 0 ? ' checked' : '';
                return `<label class="sa-metric-check"><input type="checkbox" data-metric="${escapeHtml(
                    k
                )}"${checked}> ${escapeHtml(metricLabel(k))}</label>`;
            })
            .join('');
        els.metricChecks.querySelectorAll('input').forEach((inp) => {
            inp.addEventListener('change', () => {
                const selected = Array.from(
                    els.metricChecks.querySelectorAll('input:checked')
                ).map((el) => el.getAttribute('data-metric'));
                drawBarChart(els.canvas, chart, selected, METRIC_COLORS);
            });
        });
    }

    drawBarChart(els.canvas, chart, keys, METRIC_COLORS);
    renderTable(normalized, els);
    setStatus(
        els,
        `Loaded ${chart.labels.length} series row(s)${sourceHint ? ` · ${sourceHint}` : ''}.`,
        false
    );
}

/**
 * @param {string} k
 * @returns {boolean}
 */
function availableAlways(k) {
    return DEFAULT_PLOT.indexOf(k) >= 0;
}

/**
 * Headline cards from aggregate or row averages.
 * @param {object} doc
 * @param {object} els
 */
function renderSummaryCards(doc, els) {
    if (!els.summaryCards) return;
    const m =
        doc.aggregateMetrics ||
        (doc.rows && doc.rows.length === 1 ? doc.rows[0].metrics : null) ||
        averageMetrics(doc.rows);

    if (!m) {
        els.summaryCards.hidden = true;
        els.summaryCards.innerHTML = '';
        return;
    }

    const cards = [
        { label: 'Mean kills', value: num(m.meanKills), tone: 'cyan' },
        { label: 'Wipe %', value: pct(m.partyWipeRate), tone: 'red' },
        { label: 'NAT %', value: pct(m.noAttackTimeoutRate), tone: 'orange' },
        { label: 'Route %', value: pct(m.routeCompleteRate), tone: 'green' },
        { label: 'Mean time', value: num(m.meanTimeToClear) + 's', tone: 'yellow' },
        { label: 'Exp/h', value: num(m.meanExpPerHour), tone: 'purple' }
    ];

    els.summaryCards.hidden = false;
    els.summaryCards.innerHTML = cards
        .map(
            (c) =>
                `<div class="sa-summary-card sa-summary-card--${c.tone}">` +
                `<div class="sa-summary-value">${escapeHtml(String(c.value))}</div>` +
                `<div class="sa-summary-label">${escapeHtml(c.label)}</div>` +
                `</div>`
        )
        .join('');
}

/**
 * @param {object[]|undefined} rows
 * @returns {object|null}
 */
function averageMetrics(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const keys = [
        'meanKills',
        'partyWipeRate',
        'noAttackTimeoutRate',
        'routeCompleteRate',
        'meanTimeToClear',
        'meanExpPerHour',
        'meanDeaths',
        'meanDamageDealt'
    ];
    /** @type {Record<string, number>} */
    const acc = {};
    for (let k = 0; k < keys.length; k++) acc[keys[k]] = 0;
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
        const m = rows[i] && rows[i].metrics;
        if (!m) continue;
        n += 1;
        for (let k = 0; k < keys.length; k++) {
            acc[keys[k]] += Number(m[keys[k]]) || 0;
        }
    }
    if (!n) return null;
    for (let k = 0; k < keys.length; k++) acc[keys[k]] /= n;
    return acc;
}

/**
 * @param {object} doc
 * @param {object} els
 */
function renderTable(doc, els) {
    if (!els.table) return;
    const rows = doc.rows || [];
    if (!rows.length) {
        els.table.innerHTML = '<p class="text-muted small">No rows.</p>';
        return;
    }

    const isMatrix = doc.kind === 'class_matrix';
    const isStrategy = doc.kind === 'strategy_eval';
    const head = isMatrix
        ? ['Class', 'Route %', 'Wipe %', 'Kills', 'Exp/h', 'Time', 'Dmg']
        : isStrategy
          ? ['Strategy', 'Route %', 'Wipe %', 'Kills', 'Exp/h', 'Time', 'Dmg']
          : [
                doc.kind === 'batch_folder' ? 'Seed / run' : 'Value',
                'Route %',
                'Wipe %',
                'NAT %',
                'Kills',
                'Exp/h',
                'Time',
                'Dmg'
            ];

    let html =
        '<div class="table-responsive"><table class="table table-sm table-dark sa-table"><thead><tr>' +
        head.map((h) => `<th>${h}</th>`).join('') +
        '</tr></thead><tbody>';

    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const m = r.metrics || {};
        const label = isMatrix
            ? r.classId || r.label
            : isStrategy
              ? r.strategyId || r.label
              : r.label != null
                ? r.label
                : r.value != null
                  ? r.value
                  : r.classId || r.strategyId || i;
        const cells =
            isMatrix || isStrategy
                ? [
                      label,
                      pct(m.routeCompleteRate),
                      pct(m.partyWipeRate),
                      num(m.meanKills),
                      num(m.meanExpPerHour),
                      num(m.meanTimeToClear),
                      num(m.meanDamageDealt)
                  ]
                : [
                      label,
                      pct(m.routeCompleteRate),
                      pct(m.partyWipeRate),
                      pct(m.noAttackTimeoutRate),
                      num(m.meanKills),
                      num(m.meanExpPerHour),
                      num(m.meanTimeToClear),
                      num(m.meanDamageDealt)
                  ];
        html +=
            '<tr>' +
            cells.map((c) => `<td>${escapeHtml(String(c))}</td>`).join('') +
            '</tr>';
    }
    html += '</tbody></table></div>';

    if (doc.notes) {
        html +=
            `<p class="text-muted text-xxs mt-2 mb-0"><em>Notes:</em> ${escapeHtml(String(doc.notes))}</p>`;
    }
    els.table.innerHTML = html;
}

/**
 * @param {number} r
 * @returns {string}
 */
function pct(r) {
    if (r == null || !Number.isFinite(Number(r))) return '—';
    return (Number(r) * 100).toFixed(0) + '%';
}

/**
 * @param {number} n
 * @returns {string}
 */
function num(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    const v = Number(n);
    if (Math.abs(v) >= 100) return String(Math.round(v));
    return String(Math.round(v * 100) / 100);
}

/**
 * @param {object} els
 * @param {string} msg
 * @param {boolean} isError
 */
function setStatus(els, msg, isError) {
    if (!els.status) return;
    els.status.textContent = msg;
    els.status.classList.toggle('text-danger', !!isError);
    els.status.classList.toggle('text-muted', !isError);
}

/**
 * Load sample JSON from presets/standard/analysis/.
 * @param {string} name
 * @returns {Promise<object>}
 */
async function loadSampleDoc(name) {
    const url = appUrl(`presets/standard/analysis/${name}`);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`Sample fetch failed (${res.status}): ${url}`);
    }
    return res.json();
}

/**
 * @returns {Promise<object|null>}
 */
async function loadSampleSweep() {
    return loadSampleDoc('sample_creature_hp_sweep.json');
}

/**
 * @param {HTMLSelectElement|null} select
 * @param {Array<{ path: string, label?: string }>} folders
 * @param {string} [selectedPath]
 */
function fillFolderSelect(select, folders, selectedPath) {
    if (!select) return;
    const list = Array.isArray(folders) ? folders : [];
    if (!list.length) {
        select.innerHTML =
            '<option value="">(no folders under var/sim or presets/analysis)</option>';
        return;
    }
    select.innerHTML = list
        .map((f) => {
            const path = f.path || '';
            const label = f.label || path;
            const sel = path === selectedPath ? ' selected' : '';
            return `<option value="${escapeHtml(path)}"${sel}>${escapeHtml(label)}</option>`;
        })
        .join('');
}

/**
 * @param {HTMLSelectElement|null} select
 * @param {Array<{ path: string, label?: string, name?: string }>} files
 * @param {string} [selectedPath]
 */
function fillDiskSelect(select, files, selectedPath) {
    if (!select) return;
    const list = Array.isArray(files) ? files : [];
    if (!list.length) {
        select.innerHTML =
            '<option value="">(no JSON under var/sim or presets/analysis)</option>';
        return;
    }
    select.innerHTML = list
        .map((f) => {
            const path = f.path || '';
            const label = f.label || f.path || f.name || path;
            const sel = path === selectedPath ? ' selected' : '';
            return `<option value="${escapeHtml(path)}"${sel}>${escapeHtml(label)}</option>`;
        })
        .join('');
}

/**
 * @returns {Promise<void>}
 */
async function initSimulationAnalysisApp() {
    const els = {
        title: document.getElementById('saTitle'),
        meta: document.getElementById('saMeta'),
        status: document.getElementById('saStatus'),
        canvas: document.getElementById('saChart'),
        table: document.getElementById('saTable'),
        metricChecks: document.getElementById('saMetrics'),
        summaryCards: document.getElementById('saSummaryCards'),
        paste: document.getElementById('saPaste'),
        file: document.getElementById('saFile'),
        loadSampleBtn: document.getElementById('saLoadSample'),
        loadSampleGoldenBtn: document.getElementById('saLoadSampleGolden'),
        loadSampleMatrixBtn: document.getElementById('saLoadSampleMatrix'),
        loadPasteBtn: document.getElementById('saLoadPaste'),
        knobsList: document.getElementById('saKnobsList'),
        error: document.getElementById('saLoadError'),
        diskSelect: /** @type {HTMLSelectElement|null} */ (
            document.getElementById('saDiskSelect')
        ),
        folderSelect: /** @type {HTMLSelectElement|null} */ (
            document.getElementById('saFolderSelect')
        ),
        loadDiskBtn: document.getElementById('saLoadDisk'),
        loadFolderBtn: document.getElementById('saLoadFolder'),
        refreshDiskBtn: document.getElementById('saRefreshDisk'),
        folderMeta: document.getElementById('saFolderMeta'),
        folderFiles: document.getElementById('saFolderFiles'),
        footerHint: document.getElementById('saFooterHint')
    };

    /** @type {Array<{ path: string, label?: string, fileCount?: number, primaryName?: string }>} */
    let folderList = [];

    if (els.knobsList) {
        try {
            const knobs = listKnobs();
            els.knobsList.innerHTML = knobs
                .map(
                    (k) =>
                        `<li><code>${escapeHtml(k.id)}</code> — ${escapeHtml(
                            k.label
                        )} <span class="text-muted">(${escapeHtml(
                            k.defaultValues.join(', ')
                        )})</span></li>`
                )
                .join('');
        } catch (_) {
            els.knobsList.innerHTML = '<li class="text-muted">Knobs unavailable</li>';
        }
    }

    const showErr = (err) => {
        if (els.error) {
            els.error.hidden = false;
            els.error.textContent = err && err.message ? err.message : String(err);
        }
        setStatus(els, 'Load failed.', true);
    };

    const clearErr = () => {
        if (els.error) {
            els.error.hidden = true;
            els.error.textContent = '';
        }
    };

    /**
     * @param {string} [preferFolder]
     * @param {string} [preferFile]
     */
    async function refreshDiskList(preferFolder, preferFile) {
        const data = await apiCall('sim_results_list');
        const files = data.files || [];
        folderList =
            Array.isArray(data.folders) && data.folders.length
                ? data.folders
                : groupResultFilesByFolder(files);

        fillFolderSelect(els.folderSelect, folderList, preferFolder);
        fillDiskSelect(els.diskSelect, files, preferFile);

        if (els.folderMeta) {
            els.folderMeta.textContent = folderList.length
                ? `${folderList.length} folder(s) · ${files.length} file(s) listed`
                : 'No result folders yet — run an I6 recipe from Sim Batch.';
        }

        return { files, folders: folderList };
    }

    async function loadFromDisk(path) {
        if (!path) {
            throw new Error('Select a result file first');
        }
        const data = await apiCall('sim_results_get', { path });
        const doc = data.document;
        renderDocument(doc, els, data.path || path);
    }

    /**
     * Load every JSON in a folder and chart the combined set.
     * @param {string} folderPath
     */
    async function loadFolder(folderPath) {
        if (!folderPath) {
            throw new Error('Select a results folder first');
        }
        const data = await apiCall('sim_results_folder', { path: folderPath });
        const entries = data.files || [];
        if (!entries.length) {
            throw new Error(`No JSON files in ${folderPath}`);
        }

        if (els.folderFiles) {
            els.folderFiles.hidden = false;
            const primary = data.primary || '';
            els.folderFiles.innerHTML =
                `<div class="mb-1"><strong>${escapeHtml(String(entries.length))}</strong> file(s)` +
                (primary
                    ? ` · primary <code>${escapeHtml(primary)}</code>`
                    : '') +
                `</div>` +
                `<ul class="sa-file-list mb-0">` +
                entries
                    .map((f) => {
                        const mark =
                            f.name === primary
                                ? ' <span class="text-info">★</span>'
                                : '';
                        return `<li><code>${escapeHtml(f.name || '')}</code>${mark}</li>`;
                    })
                    .join('') +
                `</ul>`;
        }

        const combined = documentFromFolderEntries(entries, data.path || folderPath);
        if (!combined) {
            // Fall back to primary single file
            const primaryName = data.primary;
            const primaryEntry = primaryName
                ? entries.find((e) => e.name === primaryName)
                : entries[0];
            if (primaryEntry && primaryEntry.document) {
                renderDocument(
                    primaryEntry.document,
                    els,
                    primaryEntry.path || folderPath
                );
                return;
            }
            throw new Error('Could not build analysis document from folder');
        }
        renderDocument(combined, els, data.path || folderPath);
    }

    if (els.loadFolderBtn) {
        els.loadFolderBtn.addEventListener('click', async () => {
            clearErr();
            try {
                const path = els.folderSelect ? els.folderSelect.value : '';
                await loadFolder(path);
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.folderSelect) {
        els.folderSelect.addEventListener('dblclick', async () => {
            clearErr();
            try {
                const path = els.folderSelect.value;
                if (path) await loadFolder(path);
            } catch (err) {
                showErr(err);
            }
        });
        els.folderSelect.addEventListener('change', () => {
            if (els.folderMeta && els.folderSelect) {
                const f = folderList.find((x) => x.path === els.folderSelect.value);
                if (f) {
                    els.folderMeta.textContent = f.label || f.path;
                }
            }
        });
    }

    if (els.loadSampleBtn) {
        els.loadSampleBtn.addEventListener('click', async () => {
            clearErr();
            try {
                const doc = await loadSampleSweep();
                renderDocument(
                    doc,
                    els,
                    'presets/standard/analysis/sample_creature_hp_sweep.json'
                );
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.loadSampleGoldenBtn) {
        els.loadSampleGoldenBtn.addEventListener('click', async () => {
            clearErr();
            try {
                const doc = await loadSampleDoc('sample_golden_cave_crawl_batch.json');
                renderDocument(
                    doc,
                    els,
                    'presets/standard/analysis/sample_golden_cave_crawl_batch.json'
                );
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.loadSampleMatrixBtn) {
        els.loadSampleMatrixBtn.addEventListener('click', async () => {
            clearErr();
            try {
                const doc = await loadSampleDoc(
                    'sample_standard_arena_class_matrix.json'
                );
                renderDocument(
                    doc,
                    els,
                    'presets/standard/analysis/sample_standard_arena_class_matrix.json'
                );
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.loadDiskBtn) {
        els.loadDiskBtn.addEventListener('click', async () => {
            clearErr();
            try {
                const path = els.diskSelect ? els.diskSelect.value : '';
                await loadFromDisk(path);
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.diskSelect) {
        els.diskSelect.addEventListener('dblclick', async () => {
            clearErr();
            try {
                const path = els.diskSelect.value;
                if (path) await loadFromDisk(path);
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.refreshDiskBtn) {
        els.refreshDiskBtn.addEventListener('click', async () => {
            clearErr();
            try {
                const curF = els.folderSelect ? els.folderSelect.value : '';
                const cur = els.diskSelect ? els.diskSelect.value : '';
                await refreshDiskList(curF, cur);
                setStatus(els, 'Results list refreshed.', false);
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.loadPasteBtn && els.paste) {
        els.loadPasteBtn.addEventListener('click', () => {
            clearErr();
            try {
                const doc = JSON.parse(els.paste.value);
                renderDocument(doc, els, 'pasted JSON');
            } catch (err) {
                showErr(err);
            }
        });
    }

    if (els.file) {
        els.file.addEventListener('change', () => {
            clearErr();
            const f = els.file.files && els.file.files[0];
            if (!f) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const doc = JSON.parse(String(reader.result || ''));
                    renderDocument(doc, els, f.name || 'local file');
                } catch (err) {
                    showErr(err);
                }
            };
            reader.onerror = () => showErr(new Error('File read failed'));
            reader.readAsText(f);
        });
    }

    const simBatchBridge = createSimBatchParentBridge({
        getState: () => ({
            seed: 1,
            huntId: 'golden_cave_crawl',
            iterations: 5,
            outDir: 'var/sim/i6_band_pressure'
        })
    });
    const openSimBatchBtn = document.getElementById('saOpenSimBatchBtn');
    const simBatchHint = document.getElementById('saSimBatchPopupHint');
    if (openSimBatchBtn) {
        openSimBatchBtn.addEventListener('click', () => {
            const win = simBatchBridge.open();
            if (!win && simBatchHint) {
                simBatchHint.hidden = false;
                simBatchHint.textContent =
                    'Popup blocked — allow popups for this site, then try again.';
            } else if (simBatchHint) {
                simBatchHint.hidden = true;
            }
        });
    }

    // Prefer a real results folder; fall back to sample
    try {
        const { files, folders } = await refreshDiskList();
        const preferFolder =
            folders.find((f) => f.path && f.path.indexOf('golden_cave_crawl') >= 0) ||
            folders.find((f) => f.primaryName === 'batch_aggregate.json') ||
            folders.find((f) => f.path && f.path.indexOf('presets/standard/analysis') >= 0) ||
            folders[0];

        if (preferFolder && preferFolder.path) {
            if (els.folderSelect) els.folderSelect.value = preferFolder.path;
            await loadFolder(preferFolder.path);
        } else if (files.length) {
            const samplePath =
                'presets/standard/analysis/sample_creature_hp_sweep.json';
            const pick = files.find((f) => f.path === samplePath) || files[0];
            if (els.diskSelect) els.diskSelect.value = pick.path;
            await loadFromDisk(pick.path);
        } else {
            const doc = await loadSampleSweep();
            renderDocument(
                doc,
                els,
                'presets/standard/analysis/sample_creature_hp_sweep.json'
            );
        }
    } catch (err) {
        try {
            const doc = await loadSampleSweep();
            renderDocument(
                doc,
                els,
                'presets/standard/analysis/sample_creature_hp_sweep.json'
            );
        } catch (err2) {
            setStatus(
                els,
                'No results loaded — run an I6 recipe from Sim Batch, or load a sample.',
                false
            );
            if (els.error) {
                els.error.hidden = false;
                els.error.textContent =
                    (err2 && err2.message) ||
                    (err && err.message) ||
                    'Could not load results';
            }
        }
    }
}

module.exports = {
    initSimulationAnalysisApp,
    drawBarChart,
    renderDocument,
    appUrl,
    apiUrl,
    loadSampleSweep,
    groupResultFilesByFolder,
    documentFromFolderEntries
};
