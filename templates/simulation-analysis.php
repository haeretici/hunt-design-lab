<?php
/**
 * Simulation Analysis page (Stage 8 + I7 folder view).
 * Folder-first browser for var/sim + presets/analysis; multi-seed charts.
 * Expects $appRoot and optional $pageTitle.
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Simulation Analysis — Hunt Design Lab';
$appRoot = isset($appRoot) ? rtrim((string) $appRoot, '/') : '';
$asset = static function (string $path) use ($appRoot): string {
    $path = ltrim($path, '/');
    return ($appRoot === '' ? '' : $appRoot) . '/' . $path;
};
$apiUrl = $asset('php/api.php');
$cssUrl = $asset('build/app.css');
$bundleUrl = $asset('build/app.bundle.js');
?>
<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($pageTitle, ENT_QUOTES, 'UTF-8') ?></title>
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon-32.png?v=4'), ENT_QUOTES, 'UTF-8') ?>" type="image/png" sizes="32x32">
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon.svg?v=4'), ENT_QUOTES, 'UTF-8') ?>" type="image/svg+xml">
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon.ico?v=4'), ENT_QUOTES, 'UTF-8') ?>" sizes="any">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.9.0" rel="stylesheet">
</head>
<body id="simulation-analysis-app">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
</script>

<div class="editor-app-container">

    <header class="editor-header-bar">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
<?php $activeNav = 'analysis'; require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <span class="badge-retro">Balance</span>
        </div>
    </header>

    <div class="editor-workspace editor-workspace--split">
        <aside class="am-sidebar sa-sidebar">
            <div class="am-sidebar-body">
                <div id="saLoadError" class="alert alert-danger py-2 px-2 small mb-2" hidden></div>

                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Result folders</h2>
                    <p class="text-muted text-xxs mb-2">
                        Load a <strong>whole folder</strong> (batch seeds, sweep, strategy eval) —
                        not one JSON at a time. Roots:
                        <code class="sa-code">var/sim/</code>,
                        <code class="sa-code">presets/…/analysis/</code>.
                    </p>
                    <label class="label-retro" for="saFolderSelect">Select folder</label>
                    <select class="form-select form-select-retro w-100 mb-2" id="saFolderSelect" size="10" style="min-height: 175px;">
                        <option value="">(loading…)</option>
                    </select>
                    <div class="d-flex flex-wrap gap-1 mb-2">
                        <button type="button" class="btn btn-retro btn-primary flex-grow-1" id="saLoadFolder">
                            <i class="fa-solid fa-folder-open"></i> Load folder
                        </button>
                        <button type="button" class="btn btn-retro btn-secondary" id="saRefreshDisk" title="Rescan disk">
                            <i class="fa-solid fa-rotate"></i>
                        </button>
                    </div>
                    <p class="text-muted text-xxs mb-1" id="saFolderMeta">—</p>
                    <div class="sa-folder-files text-xxs mb-2" id="saFolderFiles" hidden></div>
                </div>

                <details class="am-sidebar-section sa-import-panel">
                    <summary class="sa-import-summary">
                        <span class="am-sidebar-title mb-0">Single file</span>
                        <span class="text-muted text-xxs">advanced</span>
                    </summary>
                    <div class="sa-import-body mt-2">
                        <label class="label-retro" for="saDiskSelect">File on disk</label>
                        <select class="form-select form-select-retro w-100 mb-2" id="saDiskSelect" size="5">
                            <option value="">(loading…)</option>
                        </select>
                        <button type="button" class="btn btn-retro btn-secondary w-100 mb-2" id="saLoadDisk">
                            Load file
                        </button>
                        <label class="label-retro" for="saFile">Open local file</label>
                        <input type="file" class="form-control form-control-retro w-100 mb-2" id="saFile" accept=".json,application/json">
                        <label class="label-retro" for="saPaste">Paste JSON</label>
                        <textarea class="form-control form-control-retro w-100 sa-paste" id="saPaste" rows="4" placeholder='{ "kind": "sweep", "rows": [...] }'></textarea>
                        <button type="button" class="btn btn-retro btn-secondary w-100 mt-2" id="saLoadPaste">
                            Parse paste
                        </button>
                    </div>
                </details>

                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Samples &amp; tools</h2>
                    <button type="button" class="btn btn-retro btn-secondary w-100 mb-1" id="saLoadSample">
                        <i class="fa-solid fa-chart-column"></i> Sample HP sweep
                    </button>
                    <button type="button" class="btn btn-retro btn-secondary w-100 mb-1" id="saLoadSampleGolden">
                        Sample golden batch
                    </button>
                    <button type="button" class="btn btn-retro btn-secondary w-100 mb-1" id="saLoadSampleMatrix">
                        Sample class matrix
                    </button>
                    <button type="button" class="btn btn-retro btn-secondary w-100 mb-1" id="saOpenSimBatchBtn" title="Open Hunt Sim Batch Builder popup">
                        <i class="fa-solid fa-layer-group"></i> Sim Batch / recipes
                    </button>
                    <span class="d-block text-muted game-popup-hint" id="saSimBatchPopupHint" hidden></span>
                    <p class="text-muted text-xxs mt-2 mb-0">
                        I6 recipes: <code class="sa-code">sim-batch-builder.php</code>
                        · cookbook in <code class="sa-code">docs/12</code>
                    </p>
                </div>

                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Knobs</h2>
                    <ul class="sa-knobs-list text-xxs" id="saKnobsList"></ul>
                </div>
            </div>
        </aside>

        <main class="sa-main">
            <div class="sa-header">
                <h1 class="sa-heading" id="saTitle">Simulation Analysis</h1>
                <p class="text-muted small mb-1" id="saMeta">Pick a results folder to chart the full set.</p>
                <p class="small mb-0" id="saStatus">Ready.</p>
            </div>

            <div class="sa-summary-cards" id="saSummaryCards" hidden></div>

            <div class="sa-chart-panel">
                <div class="sa-metrics-bar" id="saMetrics"></div>
                <div class="sa-canvas-wrap">
                    <canvas id="saChart" width="800" height="360" aria-label="Balance chart"></canvas>
                </div>
            </div>

            <div class="sa-table-panel">
                <h2 class="am-sidebar-title">Table</h2>
                <div id="saTable"></div>
            </div>
        </main>
    </div>

    <footer class="editor-status-bar">
        <span>I6 cookbook · I7 folder view · TELEMETRY INTEGRATION RULE</span>
        <span id="saFooterHint" class="text-muted">var/sim · presets/analysis</span>
    </footer>
</div>

<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.9.0"></script>
</body>
</html>
