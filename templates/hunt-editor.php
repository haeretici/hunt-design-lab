<?php
/**
 * Hunt Editor page — list / create / edit / delete mode hunt JSON packs.
 * Expects $appRoot and optional $pageTitle.
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Hunt Editor — Hunt Design Lab';
$appRoot = isset($appRoot) ? rtrim((string) $appRoot, '/') : '';
$asset = static function (string $path) use ($appRoot): string {
    $path = ltrim($path, '/');
    return ($appRoot === '' ? '' : $appRoot) . '/' . $path;
};
$apiUrl = $asset('php/api.php');
$cssUrl = $asset('build/app.css');
$bundleUrl = $asset('build/app.bundle.js');
$schemasRoot = $asset('schemas');
$contentMode = function_exists('hdl_default_mode_id') ? hdl_default_mode_id() : 'standard';
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
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.6.2" rel="stylesheet">
</head>
<body id="hunt-editor-app">

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
<?php $activeNav = 'hunt-editor'; require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <span class="badge-retro" id="heDirtyBadge" hidden>UNSAVED</span>
            <span class="badge-retro">Hunts</span>
        </div>
    </header>

    <div class="editor-workspace editor-workspace--split">
        <aside class="am-sidebar he-sidebar">
            <div class="am-sidebar-body">
                <div id="heError" class="alert alert-danger py-2 px-2 small mb-2" hidden></div>

                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Content mode</h2>
                    <select class="form-select form-select-retro w-100 mb-2" id="heModeSelect" title="Active content mode pack"></select>
                    <p class="small text-muted mb-0">Edits write under <code>presets/&lt;mode&gt;/hunts/</code> and update <code>mode.json</code> browser list.</p>
                </div>

                <div class="am-sidebar-section">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <h2 class="am-sidebar-title mb-0">Hunts</h2>
                        <button type="button" class="btn btn-retro btn-retro-cyan btn-sm" id="heNewBtn" title="Create new hunt">
                            <i class="fa-solid fa-plus"></i> New
                        </button>
                    </div>
                    <input type="search" class="form-control form-control-retro w-100 mb-2" id="heFilter" placeholder="Filter…" autocomplete="off">
                    <div id="heHuntList" class="he-hunt-list" role="listbox" aria-label="Hunt list"></div>
                </div>
            </div>
        </aside>

        <main class="am-main he-main">
            <div class="he-toolbar">
                <div class="he-toolbar-meta">
                    <span class="label-retro">Editing</span>
                    <strong id="heEditingId" class="he-editing-id">—</strong>
                    <span id="hePathHint" class="small text-muted ms-2"></span>
                </div>
                <div class="he-toolbar-actions d-flex gap-2 flex-wrap">
                    <div class="btn-group btn-group-sm" role="group" aria-label="Editor mode">
                        <button type="button" class="btn btn-retro btn-secondary is-active" id="heViewFormBtn" disabled>Form</button>
                        <button type="button" class="btn btn-retro btn-secondary" id="heViewRawBtn" disabled>Raw JSON</button>
                    </div>
                    <button type="button" class="btn btn-retro btn-secondary btn-sm" id="heDuplicateBtn" disabled title="Duplicate as new id">
                        <i class="fa-solid fa-copy"></i> Duplicate
                    </button>
                    <button type="button" class="btn btn-retro btn-secondary btn-sm" id="heFormatBtn" disabled title="Pretty-print JSON">
                        <i class="fa-solid fa-indent"></i> Format
                    </button>
                    <button type="button" class="btn btn-retro btn-danger btn-sm" id="heDeleteBtn" disabled>
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                    <button type="button" class="btn btn-retro btn-primary btn-sm" id="heSaveBtn" disabled>
                        <i class="fa-solid fa-floppy-disk"></i> Save
                    </button>
                </div>
            </div>

            <div class="he-scroll">
                <div class="he-form" id="heForm" hidden>
                    <div class="row g-2 mb-2">
                        <div class="col-md-4">
                            <label class="label-retro" for="heId">Hunt id</label>
                            <input type="text" class="form-control form-control-retro w-100 font-monospace" id="heId" pattern="[a-z][a-z0-9_]*" maxlength="80" spellcheck="false" autocomplete="off">
                            <div class="form-text text-muted small">snake_case file name (e.g. <code>cave_crawl_generated</code>)</div>
                        </div>
                        <div class="col-md-5">
                            <label class="label-retro" for="heLabel">Label</label>
                            <input type="text" class="form-control form-control-retro w-100" id="heLabel" maxlength="200" autocomplete="off">
                        </div>
                        <div class="col-md-3 d-flex flex-column justify-content-end gap-1 pb-1">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="heInBrowser" checked>
                                <label class="form-check-label small" for="heInBrowser">In browser catalog</label>
                            </div>
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="heSetDefault">
                                <label class="form-check-label small" for="heSetDefault">Default hunt for mode</label>
                            </div>
                        </div>
                    </div>

                    <div id="heEditorHolder" class="he-editor-holder"></div>
                    <textarea class="form-control form-control-retro he-json font-monospace" id="heJson" style="min-height: 500px;" spellcheck="false" wrap="off" hidden></textarea>
                    <p class="small text-muted mt-2 mb-0">
                        Writes <code>presets/&lt;mode&gt;/hunts/&lt;id&gt;.json</code>. Checking “In browser catalog” updates <code>mode.json → browser.hunts</code> so Hunt Simulator can preload it.
                    </p>
                </div>

                <div class="he-empty" id="heEmpty">
                    <p class="text-muted mb-2">Select a hunt on the left, or create a new one.</p>
                    <button type="button" class="btn btn-retro btn-retro-cyan" id="heEmptyNewBtn">
                        <i class="fa-solid fa-plus"></i> New hunt
                    </button>
                </div>
            </div>
        </main>
    </div>

    <footer class="editor-statusbar">
        <span id="statusMsg">Ready</span>
        <span class="ms-auto small text-muted" id="heStatusMeta"></span>
    </footer>
</div>

<script src="https://cdn.jsdelivr.net/npm/@json-editor/json-editor@2.15.1/dist/jsoneditor.min.js"></script>
<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.6.2"></script>
</body>
</html>

