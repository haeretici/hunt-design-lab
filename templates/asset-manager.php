<?php
/**
 * Sprite Manager page template — creature catalog browser.
 * Expects $appRoot (web path to project root, usually '') and optional $pageTitle.
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Sprite Manager — Hunt Design Lab';
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
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.4.0" rel="stylesheet">
</head>
<body id="asset-manager-app">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
</script>

<div class="editor-app-container">

    <header class="editor-header-bar">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
<?php require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <button type="button" class="btn btn-retro btn-secondary btn-sm" id="amOpenBatchBuilderBtn"
                    title="Open Sprite Batch Builder in a popup window">
                <i class="fa-solid fa-layer-group"></i> Batch Builder
            </button>
            <span class="d-none d-md-inline badge-retro">Catalog</span>
            <span class="d-block text-muted game-popup-hint" id="amBatchBuilderPopupHint" hidden></span>
        </div>
    </header>

    <div class="editor-workspace editor-workspace--split">
        <!-- Filters -->
        <aside class="am-sidebar">
            <div class="am-sidebar-body">
                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Genre</h2>
                    <select class="form-select form-select-retro w-100" id="amGenre" title="Genre"></select>
                </div>
                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Asset kind</h2>
                    <select class="form-select form-select-retro w-100" id="amKind" title="Asset kind"></select>
                </div>
                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Browse</h2>
                    <label class="label-retro" for="amLimit">Show newest</label>
                    <select class="form-select form-select-retro w-100 mb-2" id="amLimit">
                        <option value="48">48</option>
                        <option value="96" selected>96</option>
                        <option value="192">192</option>
                        <option value="0">All</option>
                    </select>
                    <label class="label-retro" for="amThumbSize">Thumb size</label>
                    <select class="form-select form-select-retro w-100" id="amThumbSize">
                        <option value="icon">Icon 32</option>
                        <option value="small" selected>Small 64</option>
                        <option value="medium">Medium</option>
                        <option value="alpha">Alpha full</option>
                        <option value="original">Original</option>
                    </select>
                </div>
                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Summary</h2>
                    <div class="d-flex flex-wrap gap-1" id="amGenreStats"></div>
                </div>
                <div class="am-sidebar-section">
                    <button class="btn btn-retro btn-retro-secondary w-100" id="amRefreshBtn" type="button">
                        <i class="fa-solid fa-rotate"></i> Refresh
                    </button>
                </div>
                <div class="am-sidebar-section am-sidebar-selection" id="amSelectionPanel">
                    <h2 class="am-sidebar-title">Selection</h2>
                    <div id="amSelectionBody" class="am-selection-empty text-xxs text-muted">
                        Select an asset in the grid.
                    </div>
                </div>
            </div>
        </aside>

        <!-- Grid -->
        <main class="am-main">
            <div class="am-toolbar">
                <input type="search" class="form-control form-control-retro am-toolbar-search" id="amSearch"
                       placeholder="Filter name…" autocomplete="off">
                <span class="stat-chip">Shown <strong id="amShownCount">0</strong></span>
                <span class="stat-chip">Total <strong id="amTotalCount">0</strong></span>
                <span class="stat-chip am-checked-chip" id="amCheckedChip" hidden>
                    Checked <strong id="amCheckedCount">0</strong>
                </span>
                <button type="button" class="btn btn-retro btn-retro-secondary btn-sm" id="amFixGreenBtn"
                        title="Neutralize accentuated green (high G, low R/B → R=B=G) on original/, then reprocess checked tiles" disabled>
                    <i class="fa-solid fa-droplet"></i> Fix Green
                </button>
                <button type="button" class="btn btn-retro btn-retro-secondary btn-sm" id="amFlipBtn"
                        title="Flip horizontal original/ for all checked tiles, then reprocess" disabled>
                    <i class="fa-solid fa-left-right"></i> Flip
                </button>
                <button type="button" class="btn btn-retro btn-retro-secondary btn-sm" id="amRegenBtn"
                        title="Reprocess alpha/medium/retro/small/icon for checked tiles" disabled>
                    <i class="fa-solid fa-arrows-rotate"></i> Regen
                </button>
                <button type="button" class="btn btn-retro btn-retro-danger btn-sm" id="amDeleteBtn"
                        title="Delete original + variants and catalog rows for checked tiles" disabled>
                    <i class="fa-solid fa-trash"></i> Delete
                </button>
            </div>
            <div class="am-grid-wrap">
                <div class="am-grid" id="amGrid"></div>
            </div>
        </main>

        <!-- Detail / actions -->
        <aside class="am-detail">
            <div class="am-detail-body" id="amDetail">
                <div class="am-detail-empty">
                    Select an asset to preview and run actions.
                </div>
            </div>
        </aside>
    </div>

    <footer class="editor-statusbar">
        <div class="status-group">
            <div class="status-item">
                <i class="fa-solid fa-circle text-info" style="font-size: 0.45rem;"></i>
                <span id="statusMsg">Sprite Manager</span>
            </div>
        </div>
        <div class="status-item">
            <span>alpha previews · php/api.php catalog</span>
        </div>
    </footer>
</div>

<div id="amModalHost"></div>

<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.3.0"></script>
</body>
</html>
