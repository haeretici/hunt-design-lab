<?php
/**
 * Sprite Batch Builder page template.
 * Full page or popup (?popup=1). Expects $appRoot and optional $pageTitle.
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Sprite Batch Builder — Hunt Design Lab';
$appRoot = isset($appRoot) ? rtrim((string) $appRoot, '/') : '';
$asset = static function (string $path) use ($appRoot): string {
    $path = ltrim($path, '/');
    return ($appRoot === '' ? '' : $appRoot) . '/' . $path;
};
$apiUrl = $asset('php/api.php');
$cssUrl = $asset('build/app.css');
$bundleUrl = $asset('build/app.bundle.js');
$activeNav = 'sprites';
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
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.3.0" rel="stylesheet">
</head>
<body id="batch-builder-app">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
</script>

<div class="editor-app-container">

    <header class="editor-header-bar sprite-batch-header">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
<?php $navExtraClass = 'sprite-batch-nav'; require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <span class="badge-retro">Sprite batch</span>
        </div>
    </header>

    <div class="editor-workspace editor-workspace--scroll">
        <div class="editor-content">
            <p class="text-muted text-xxs mb-3">
                Plan asset spritesheets: pick genre, asset kind (creatures, equipment, tiles, overlays, objects),
                optional category, seed and iterations, preview the first sheet roster,
                then <strong>Run batch</strong> from this page (or copy the CLI flags). The server validates
                arguments and runs <code>node bin/generate_sprite.js</code> in the background —
                image gen (<code>agy</code> / <code>grok</code>) → split → process → catalog JSON
                once per iteration. Poll job status below while it runs.
            </p>

            <div class="row g-3">
                <!-- Settings -->
                <div class="col-lg-5">
                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-gears me-1"></i> Batch Settings
                            </h5>
                            <div class="row g-2">
                                <div class="col-md-6">
                                    <label class="label-retro" for="genre">Genre</label>
                                    <select class="form-select form-select-retro" id="genre"></select>
                                </div>
                                <div class="col-md-6">
                                    <label class="label-retro" for="kind">Asset kind</label>
                                    <select class="form-select form-select-retro" id="kind"></select>
                                </div>
                                <div class="col-12">
                                    <label class="label-retro" for="category">Category <span class="text-muted">(optional)</span></label>
                                    <select class="form-select form-select-retro" id="category">
                                        <option value="">Any / mixed</option>
                                    </select>
                                </div>
                                <div class="col-3">
                                    <label class="label-retro" for="rows">Rows</label>
                                    <input type="number" class="form-control form-control-retro" id="rows" min="1" max="8" value="4">
                                </div>
                                <div class="col-3">
                                    <label class="label-retro" for="cols">Cols</label>
                                    <input type="number" class="form-control form-control-retro" id="cols" min="1" max="8" value="4">
                                </div>
                                <div class="col-3">
                                    <label class="label-retro" for="seed">Seed</label>
                                    <input type="number" class="form-control form-control-retro" id="seed" placeholder="random" value="42">
                                </div>
                                <div class="col-3">
                                    <label class="label-retro" for="iterations" title="Number of 4×4 sheets to generate">Iters</label>
                                    <input type="number" class="form-control form-control-retro" id="iterations" min="1" max="64" value="1">
                                </div>
                                <div class="col-12">
                                    <label class="label-retro" for="model" title="Gemini → agy; Grok 4.6 → grok headless">image model</label>
                                    <select class="form-select form-select-retro" id="model"></select>
                                </div>
                                <div class="col-12">
                                    <div class="form-check mt-1">
                                        <input class="form-check-input" type="checkbox" id="opaqueAlpha" value="1">
                                        <label class="form-check-label text-xxs" for="opaqueAlpha" title="Applies to every item in this batch">
                                            Opaque alpha (copy original → alpha/, no chroma key)
                                        </label>
                                    </div>
                                    <div class="form-check mt-1">
                                        <input class="form-check-input" type="checkbox" id="scaleFilterNearest" value="1">
                                        <label class="form-check-label text-xxs" for="scaleFilterNearest" title="Stamps catalog scaleFilter=nearest; process_sprites uses NEAREST for small/icon (32/64 originals expand to 256)">
                                            Nearest scale (pixel art 32/64)
                                        </label>
                                    </div>
                                    <div class="form-check mt-1">
                                        <input class="form-check-input" type="checkbox" id="dryRun" value="1">
                                        <label class="form-check-label text-xxs" for="dryRun">
                                            Dry run (plan only — no image gen or file writes)
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div class="d-flex flex-wrap gap-2 align-items-center mt-3">
                                <span class="stat-chip">Grid <strong id="gridCount">16</strong></span>
                                <span class="stat-chip">Iters <strong id="iterCount">1</strong></span>
                                <span class="stat-chip">Total <strong id="totalCount">16</strong></span>
                                <span class="stat-chip">Done list <strong id="doneCount">0</strong></span>
                                <span class="stat-chip text-warning" id="injectChip" hidden title="Roster seeded from Sprite Manager selection">Inject</span>
                            </div>

                            <div class="d-flex flex-wrap gap-2 mt-3">
                                <button class="btn btn-retro btn-retro-primary" id="generateBtn" type="button">
                                    <i class="fa-solid fa-wand-magic-sparkles"></i> Generate roster
                                </button>
                                <button class="btn btn-retro btn-retro-secondary" id="reshuffleBtn" type="button">
                                    <i class="fa-solid fa-shuffle"></i> New seed
                                </button>
                                <button class="btn btn-retro btn-retro-warning" id="runBatchBtn" type="button" title="Validate args and run generate_sprite.js in the background">
                                    <i class="fa-solid fa-play"></i> Run batch
                                </button>
                            </div>

                            <div class="genre-meta mt-3 pt-2 border-top border-secondary border-opacity-25" id="genreMeta"></div>
                        </div>
                    </div>

                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-list me-1"></i> Roster
                                <span class="text-muted text-xxs fw-normal">(iteration 1 preview)</span>
                            </h5>
                            <div class="roster-scroll">
                                <table class="roster-table">
                                    <thead>
                                        <tr>
                                            <th>#</th>
                                            <th>Cell</th>
                                            <th>Technical</th>
                                            <th>Alias</th>
                                            <th>File stem</th>
                                        </tr>
                                    </thead>
                                    <tbody id="rosterBody"></tbody>
                                </table>
                            </div>
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

                <!-- Previews -->
                <div class="col-lg-7">
                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-terminal me-1"></i> CLI Command
                            </h5>
                            <p class="text-xxs text-muted mb-2">
                                Flags only (genre, seed, grid, iterations, model). The CLI regenerates
                                the same roster as iteration&nbsp;1 from seed + done list — no JSON needed.
                                <strong>Copy CLI</strong> copies the pipeline line only.
                                Prefer <strong>Run batch</strong> when the PHP dev server is up.
                            </p>
                            <pre class="cmd-block cmd-block--tall" id="cliCommand"></pre>
                            <button class="btn btn-retro btn-retro-cyan" id="copyCliBtn" type="button">Copy CLI</button>
                        </div>
                    </div>

                    <div class="card glass-panel mb-3">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-code me-1"></i> JSON Config Preview
                            </h5>
                            <p class="text-xxs text-muted mb-2">
                                First iteration only (not passed to the CLI).
                            </p>
                            <pre class="cmd-block cmd-block--tall" id="jsonPreview"></pre>
                            <button class="btn btn-retro btn-retro-cyan me-1" id="copyJsonBtn" type="button">Copy JSON</button>
                            <button class="btn btn-retro btn-retro-secondary" id="downloadConfigBtn" type="button">Download batch.json</button>
                        </div>
                    </div>

                    <div class="card glass-panel">
                        <div class="card-body">
                            <h5 class="card-title text-info">
                                <i class="fa-solid fa-scroll me-1"></i> Image Prompt Preview
                            </h5>
                            <p class="text-xxs text-muted mb-2">
                                First iteration only. Further iterations are built by the CLI after updating the done list.
                            </p>
                            <pre class="cmd-block cmd-block--prompt" id="promptPreview"></pre>
                            <button class="btn btn-retro btn-retro-cyan" id="copyPromptBtn" type="button">Copy prompt</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <footer class="editor-statusbar">
        <div class="status-group">
            <div class="status-item">
                <i class="fa-solid fa-circle text-info" style="font-size: 0.45rem;"></i>
                <span id="statusMsg">Sprite Batch Builder</span>
            </div>
        </div>
        <div class="status-item">
            <span>php/api.php · node bin/generate_sprite.js</span>
        </div>
    </footer>
</div>

<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.2.0"></script>
</body>
</html>
