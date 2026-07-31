<?php
/**
 * Designer Rule UI — mode-scoped preset CRUD (catalog, folder, piece packs).
 * Expects $appRoot and optional $pageTitle.
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Designer — Hunt Design Lab';
$appRoot = isset($appRoot) ? rtrim((string) $appRoot, '/') : '';
$asset = static function (string $path) use ($appRoot): string {
    $path = ltrim($path, '/');
    return ($appRoot === '' ? '' : $appRoot) . '/' . $path;
};
$apiUrl = $asset('php/api.php');
$cssUrl = $asset('build/app.css');
$bundleUrl = $asset('build/app.bundle.js');
$schemasRoot = $asset('schemas');
$contentMode = isset($_GET['mode']) && is_string($_GET['mode']) && preg_match('/^[a-z][a-z0-9_-]{0,79}$/', $_GET['mode'])
    ? $_GET['mode']
    : (function_exists('hdl_default_mode_id') ? hdl_default_mode_id() : 'standard');
$modesList = function_exists('hdl_list_modes') ? hdl_list_modes() : [
    ['id' => 'standard', 'label' => 'Standard', 'isDefault' => true],
    ['id' => 'legacy', 'label' => 'Legacy (dev port)', 'isDefault' => false],
];
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
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.14.1" rel="stylesheet">
</head>
<body id="designer-ui-app">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
    window.__CONTENT_MODE__ = <?= json_encode($contentMode, JSON_UNESCAPED_SLASHES) ?>;
    window.__MODES__ = <?= json_encode($modesList, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>;
    window.__SCHEMAS_ROOT__ = <?= json_encode($schemasRoot, JSON_UNESCAPED_SLASHES) ?>;
</script>

<div class="editor-app-container">

    <header class="editor-header-bar">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
<?php $activeNav = 'designer-ui'; require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <span class="badge-retro" id="duDirtyBadge" hidden>UNSAVED</span>
            <span class="badge-retro">Designer</span>
        </div>
    </header>

    <div class="editor-workspace editor-workspace--split">
        <aside class="am-sidebar du-sidebar">
            <div class="am-sidebar-body du-sidebar-body">
                <div id="duError" class="alert alert-danger py-2 px-2 small mb-2 du-sidebar-error" hidden></div>

                <div class="am-sidebar-section du-sidebar-mode">
                    <h2 class="am-sidebar-title">Content mode</h2>
                    <select class="form-select form-select-retro w-100 mb-2" id="duModeSelect" title="Active content mode pack"></select>
                </div>

                <!-- Stacked below lg; at Bootstrap xl (≥1200px) kinds | list side-by-side -->
                <div class="du-sidebar-nav-row">
                    <div class="am-sidebar-section du-sidebar-kinds">
                        <h2 class="am-sidebar-title">Category</h2>
                        <nav class="du-kind-nav" id="duKindNav" aria-label="Preset categories">
                            <!-- Filled by app.js from KIND_META groups -->
                        </nav>
                        <p class="small text-muted mt-2 mb-0 du-sidebar-kinds-hint">
                            Mode presets under <code>presets/&lt;mode&gt;/</code>.
                            Hunts stay in
                            <a id="duHuntEditorLink" href="<?= htmlspecialchars($asset('hunt-editor.php'), ENT_QUOTES, 'UTF-8') ?>">Hunt Editor</a>.
                            Piece packs include a friction grid; dungeons can Validate layout/stress.
                        </p>
                    </div>

                    <div class="am-sidebar-section du-sidebar-list">
                        <div class="d-flex justify-content-between align-items-center mb-2">
                            <h2 class="am-sidebar-title mb-0" id="duListTitle">Spells</h2>
                            <button type="button" class="btn btn-retro btn-retro-cyan btn-sm" id="duNewBtn" title="Create new">
                                <i class="fa-solid fa-plus"></i> New
                            </button>
                        </div>
                        <input type="search" class="form-control form-control-retro w-100 mb-2" id="duFilter" placeholder="Filter…" autocomplete="off">
                        <div id="duEntityList" class="du-entity-list" role="listbox" aria-label="Entity list"></div>
                        <div id="duPager" class="du-pager" hidden></div>
                    </div>
                </div>
            </div>
        </aside>

        <main class="am-main du-main">
            <div class="du-toolbar">
                <div class="du-toolbar-meta">
                    <span class="label-retro">Editing</span>
                    <strong id="duEditingId" class="du-editing-id">—</strong>
                    <span id="duPathHint" class="small text-muted ms-2"></span>
                </div>
                <div class="du-toolbar-actions d-flex gap-2 flex-wrap">
                    <div class="btn-group btn-group-sm" role="group" aria-label="Editor mode">
                        <button type="button" class="btn btn-retro btn-secondary is-active" id="duViewFormBtn" disabled>Form</button>
                        <button type="button" class="btn btn-retro btn-secondary" id="duViewRawBtn" disabled>Raw JSON</button>
                    </div>
                    <button type="button" class="btn btn-retro btn-retro-cyan btn-sm" id="duPreviewProfileBtn" hidden title="Open character profile preview">
                        <i class="fa-solid fa-eye"></i> Preview
                    </button>
                    <button type="button" class="btn btn-retro btn-secondary btn-sm" id="duDuplicateBtn" disabled title="Duplicate as new id">
                        <i class="fa-solid fa-copy"></i> Duplicate
                    </button>
                    <button type="button" class="btn btn-retro btn-secondary btn-sm" id="duFormatBtn" disabled title="Pretty-print raw JSON">
                        <i class="fa-solid fa-indent"></i> Format
                    </button>
                    <div class="du-validate-group" id="duValidateGroup" hidden>
                        <select class="form-select form-select-retro form-select-sm du-validate-level" id="duValidateLevel" title="Validate depth" hidden>
                            <option value="layout">Layout (fast)</option>
                            <option value="stress">Stress (50 seeds)</option>
                        </select>
                        <button type="button" class="btn btn-retro btn-secondary btn-sm" id="duValidateBtn" disabled title="Run kernel checks against the saved file on disk">
                            <i class="fa-solid fa-check-double"></i> Validate
                        </button>
                    </div>
                    <button type="button" class="btn btn-retro btn-danger btn-sm" id="duDeleteBtn" disabled>
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                    <button type="button" class="btn btn-retro btn-primary btn-sm" id="duSaveBtn" disabled>
                        <i class="fa-solid fa-floppy-disk"></i> Save
                    </button>
                </div>
            </div>

            <!-- Isolated scroll region: split shell + body use overflow:hidden and clip tall forms. -->
            <div class="du-scroll">
                <div class="du-form" id="duForm" hidden>
                    <div class="row g-2 mb-2">
                        <div class="col-md-4">
                            <label class="label-retro" for="duId">Entity id</label>
                            <input type="text" class="form-control form-control-retro w-100 font-monospace" id="duId" pattern="[a-z][a-z0-9_]*" maxlength="80" spellcheck="false" autocomplete="off">
                            <div class="form-text text-muted small">snake_case id (e.g. <code>fire_wave</code>)</div>
                        </div>
                        <div class="col-md-8 d-flex align-items-end">
                            <p class="small text-muted mb-1" id="duSaveHint">
                                Save rewrites the whole catalog file atomically (one row create/update).
                            </p>
                        </div>
                    </div>

                    <div id="duRefsStrip" class="du-refs-strip" hidden></div>
                    <div id="duValidateReport" class="du-validate-report" hidden></div>

                    <div id="duEditorHolder" class="du-editor-holder"></div>
                    <textarea class="form-control form-control-retro du-json font-monospace" id="duJson" spellcheck="false" wrap="off" hidden></textarea>
                </div>

                <div class="du-empty" id="duEmpty">
                    <p class="text-muted mb-2">Select an entity on the left, or create a new one.</p>
                    <button type="button" class="btn btn-retro btn-retro-cyan" id="duEmptyNewBtn">
                        <i class="fa-solid fa-plus"></i> New entity
                    </button>
                </div>
            </div>
        </main>
    </div>

    <footer class="editor-statusbar">
        <span id="statusMsg">Ready</span>
        <span class="ms-auto small text-muted" id="duStatusMeta"></span>
    </footer>
</div>

<script src="https://cdn.jsdelivr.net/npm/@json-editor/json-editor@2.15.1/dist/jsoneditor.min.js"></script>
<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.13.0"></script>
</body>
</html>
