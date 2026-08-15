<?php
/**
 * Wiki shell — embeds dual-mode catalog browsers (creatures / equipment) in view mode.
 *
 * Expects:
 *   $appRoot, $pageTitle, $wikiKind ('creatures'|'equipment'), $activeNav
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Wiki — Hunt Design Lab';
$appRoot = isset($appRoot) ? rtrim((string) $appRoot, '/') : '';
$wikiKind = isset($wikiKind) && in_array($wikiKind, ['equipment', 'spells']) ? $wikiKind : 'creatures';
$activeNav = $activeNav ?? 'wiki-' . $wikiKind;
$asset = static function (string $path) use ($appRoot): string {
    $path = ltrim($path, '/');
    return ($appRoot === '' ? '' : $appRoot) . '/' . $path;
};
$apiUrl = $asset('php/api.php');
$cssUrl = $asset('build/app.css');
$bundleUrl = $asset('build/app.bundle.js');
$contentMode = isset($_GET['mode']) && is_string($_GET['mode']) && preg_match('/^[a-z][a-z0-9_-]{0,79}$/', $_GET['mode'])
    ? $_GET['mode']
    : (function_exists('hdl_default_mode_id') ? hdl_default_mode_id() : 'standard');
$modesList = function_exists('hdl_list_modes') ? hdl_list_modes() : [
    ['id' => 'standard', 'label' => 'Standard', 'isDefault' => true, 'genre' => 'rpg_fantasy'],
    ['id' => 'legacy', 'label' => 'Legacy (dev port)', 'isDefault' => false, 'genre' => 'rpg_fantasy'],
];
$kindLabel = $wikiKind === 'equipment' ? 'Equipments' : ($wikiKind === 'spells' ? 'Spells' : 'Creatures');
$kindIcon = $wikiKind === 'equipment' ? 'fa-shield-halved' : ($wikiKind === 'spells' ? 'fa-wand-magic-sparkles' : 'fa-dragon');
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
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.15.0" rel="stylesheet">
</head>
<body id="wiki-app" data-wiki-kind="<?= htmlspecialchars($wikiKind, ENT_QUOTES, 'UTF-8') ?>">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
    window.__CONTENT_MODE__ = <?= json_encode($contentMode, JSON_UNESCAPED_SLASHES) ?>;
    window.__MODES__ = <?= json_encode($modesList, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>;
    window.__WIKI_KIND__ = <?= json_encode($wikiKind, JSON_UNESCAPED_SLASHES) ?>;
</script>

<div class="editor-app-container">
    <header class="editor-header-bar">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
<?php require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <label class="visually-hidden" for="wikiModeSelect">Content mode</label>
            <select class="form-select form-select-retro" id="wikiModeSelect" title="Content mode pack" style="min-width: 9rem;"></select>
            <span class="badge-retro"><i class="fa-solid <?= htmlspecialchars($kindIcon, ENT_QUOTES, 'UTF-8') ?>"></i> Wiki · <?= htmlspecialchars($kindLabel, ENT_QUOTES, 'UTF-8') ?></span>
        </div>
    </header>

    <div class="editor-workspace wiki-workspace">
        <iframe
            id="wikiFrame"
            class="wiki-frame"
            title="Wiki catalog browser"
            src="about:blank"
        ></iframe>
    </div>
</div>

<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.15.0"></script>
</body>
</html>
