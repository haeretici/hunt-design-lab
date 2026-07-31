<?php
/**
 * Hunt Simulation Batch Builder template (Stage 12I + web run).
 * Compose headless hunt JSON + CLI; optionally queue via php/api.php (sim_batch).
 * Expects $appRoot and optional $pageTitle.
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Hunt Batch Builder — Hunt Design Lab';
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
<body id="sim-batch-builder-app">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
</script>

<div class="editor-app-container">

    <header class="editor-header-bar sim-batch-header">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
<?php
            $activeNav = 'sim-batch';
            $navExtraClass = 'sim-batch-nav';
            require __DIR__ . '/partials/header_nav.php';
        ?>
        <div class="global-actions">
            <span class="badge-retro">Hunt sim</span>
        </div>
    </header>

    <div class="editor-workspace editor-workspace--scroll">
        <div class="editor-content">
            <p class="text-muted text-xxs mb-3">
                Plan <strong>headless hunt</strong> iterations and <strong>I6 analysis recipes</strong>:
                pick a recipe (or hunt preset), seed, concurrency, optional limits / party overrides.
                Prefer <strong>Run batch</strong> when the PHP dev server is up (same Node stack as
                <code>npm run sim:batch</code>). Class matrix / strategy eval / threat recipes are
                <strong>CLI-only</strong> — copy the command. Large campaigns (&gt;900 iters) still use
                <code>./SIMULATION.sh</code>. After a run, open
                <a href="<?= htmlspecialchars($asset('simulation-analysis.php'), ENT_QUOTES, 'UTF-8') ?>">Analysis</a>
                and load the <em>results folder</em> (not one seed file).
            </p>

            <div class="row g-3">
                <div class="col-lg-5">
                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-flask me-1"></i> I6 Analysis recipes
                            </h5>
                            <p class="text-muted text-xxs mb-2">
                                One question per recipe. Click to prefill hunt, seeds, and output path.
                            </p>
                            <div class="recipe-cards" id="recipeCards"></div>
                            <div class="recipe-detail mt-2" id="recipeDetail" hidden></div>
                            <div class="alert alert-info py-2 px-2 small mt-2 mb-0" id="recipeKindNote" hidden></div>
                        </div>
                    </div>

                    <details class="card glass-panel mb-3 sim-batch-tutorial">
                        <summary class="card-body py-2">
                            <h5 class="card-title text-info mb-0 d-inline">
                                <i class="fa-solid fa-book-open me-1"></i> Mini-tutorial
                            </h5>
                            <span class="text-muted text-xxs ms-1">how to run &amp; read results</span>
                        </summary>
                        <div class="card-body pt-0">
                            <ol class="sim-batch-tutorial-steps text-xxs mb-2" id="miniTutorialSteps"></ol>
                            <p class="text-muted text-xxs mb-0">
                                Full cookbook: <code>docs/12_balance_and_analysis.md</code>
                                (I6 section) · limitations log: <code>docs/24</code>.
                            </p>
                        </div>
                    </details>

                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-gears me-1"></i> Hunt Batch Settings
                            </h5>
                            <div class="row g-2">
                                <div class="col-6">
                                    <label class="label-retro" for="iterations">Iterations</label>
                                    <input type="number" class="form-control form-control-retro" id="iterations" min="1" max="900" value="10"
                                           title="Web run max 900; use SIMULATION.sh for larger campaigns.">
                                </div>
                                <div class="col-6">
                                    <label class="label-retro" for="seed">Seed</label>
                                    <input type="number" class="form-control form-control-retro" id="seed" min="1" value="42">
                                </div>
                                <div class="col-6">
                                    <label class="label-retro" for="concurrency">Concurrency</label>
                                    <input type="number" class="form-control form-control-retro" id="concurrency" min="1" max="16" value="1"
                                           title="Node worker processes (1 = sequential).">
                                </div>
                                <div class="col-6">
                                    <label class="label-retro" for="huntId">Hunt preset</label>
                                    <select class="form-select form-select-retro" id="huntId"></select>
                                </div>
                                <div class="col-6">
                                    <label class="label-retro" for="frames">Max frames</label>
                                    <input type="number" class="form-control form-control-retro" id="frames" min="1" placeholder="(hunt default)" title="Optional safety cap (logic frames)">
                                </div>
                                <div class="col-6">
                                    <label class="label-retro" for="maxKills">Max kills</label>
                                    <input type="number" class="form-control form-control-retro" id="maxKills" min="1" placeholder="(optional)">
                                </div>
                                <div class="col-6">
                                    <label class="label-retro" for="maxTicks">Max ticks</label>
                                    <input type="number" class="form-control form-control-retro" id="maxTicks" min="1" placeholder="(optional)">
                                </div>
                                <div class="col-6">
                                    <label class="label-retro" for="strategyOverride">Strategy override</label>
                                    <select class="form-select form-select-retro" id="strategyOverride">
                                        <option value="">(hunt default)</option>
                                    </select>
                                </div>
                                <div class="col-12">
                                    <label class="label-retro" for="outDir">Output directory</label>
                                    <input type="text" class="form-control form-control-retro" id="outDir" value="var/sim"
                                           title="Must stay under var/sim/ for web runs.">
                                </div>
                                <div class="col-12">
                                    <div class="form-check">
                                        <input class="form-check-input" type="checkbox" id="quiet" checked>
                                        <label class="form-check-label label-retro" for="quiet">Quiet (no per-iteration stdout)</label>
                                    </div>
                                </div>
                            </div>
                            <p class="text-muted text-xxs mt-2 mb-0" id="partyPrefillNote" hidden></p>
                            <div class="alert alert-warning py-2 px-2 small mt-2 mb-0" id="largeBatchWarn" hidden></div>
                        </div>
                    </div>

                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-play me-1"></i> Actions
                            </h5>
                            <div class="d-flex flex-wrap gap-2">
                                <button type="button" class="btn btn-retro btn-retro-warning" id="runBatchBtn"
                                        title="Queue scripts/batch_worker.js via php/api.php">
                                    <i class="fa-solid fa-play"></i> Run batch
                                </button>
                                <button type="button" class="btn btn-retro btn-retro-cyan" id="copyCliBtn">
                                    <i class="fa-solid fa-copy"></i> Copy CLI (JSON)
                                </button>
                                <button type="button" class="btn btn-retro btn-secondary" id="copyFlagsBtn">
                                    Copy CLI (flags)
                                </button>
                                <button type="button" class="btn btn-retro btn-secondary" id="copyJsonBtn">
                                    Copy JSON
                                </button>
                                <button type="button" class="btn btn-retro btn-secondary" id="downloadConfigBtn">
                                    Download JSON
                                </button>
                                <button type="button" class="btn btn-retro btn-secondary" id="copySimShBtn" title="Snippet for large batches">
                                    Copy SIMULATION.sh hint
                                </button>
                                <a class="btn btn-retro btn-secondary" href="<?= htmlspecialchars($asset('simulation-analysis.php'), ENT_QUOTES, 'UTF-8') ?>" id="openAnalysisLink">
                                    <i class="fa-solid fa-chart-column"></i> Analysis
                                </a>
                            </div>
                            <p class="text-muted text-xxs mt-2 mb-0" id="simBatchStatus">Ready.</p>
                        </div>
                    </div>

                    <div class="card glass-panel">
                        <div class="card-body">
                            <h5 class="card-title text-info d-flex align-items-center justify-content-between gap-2">
                                <span>
                                    <i class="fa-solid fa-server me-1"></i> Job status
                                </span>
                                <span class="job-status-badge" id="jobStatusBadge">idle</span>
                            </h5>
                            <p class="text-xxs text-muted mb-2">
                                After <strong>Run batch</strong>, this panel polls the PHP API for progress and log output.
                            </p>
                            <div class="job-meta text-xxs mb-2" id="jobMeta">
                                No job yet.
                            </div>
                            <pre class="cmd-block cmd-block--job-log" id="jobLog">—</pre>
                            <div class="d-flex flex-wrap gap-2">
                                <button class="btn btn-retro btn-retro-secondary" id="refreshJobBtn" type="button" disabled>
                                    <i class="fa-solid fa-rotate"></i> Refresh
                                </button>
                                <button class="btn btn-retro btn-retro-cyan" id="copyJobIdBtn" type="button" disabled>
                                    Copy job id
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="col-lg-7">
                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-code me-1"></i> JSON config
                            </h5>
                            <pre class="sim-batch-pre" id="jsonPreview">{}</pre>
                        </div>
                    </div>
                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-play me-1"></i> CLI (JSON arg)
                            </h5>
                            <pre class="sim-batch-pre sim-batch-pre--cli" id="cliCommand">npm run sim:batch -- '{}'</pre>
                        </div>
                    </div>
                    <div class="card glass-panel">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-flag me-1"></i> CLI (flags)
                            </h5>
                            <pre class="sim-batch-pre sim-batch-pre--cli" id="cliFlagsCommand">npm run sim:batch --</pre>
                            <p class="text-muted text-xxs mt-2 mb-0">
                                Flag form is used when the config has no <code>members</code> /
                                <code>maxTicks</code> / <code>maxKills</code>. Otherwise the JSON CLI is preferred.
                            </p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</div>

<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.9.0"></script>
</body>
</html>
