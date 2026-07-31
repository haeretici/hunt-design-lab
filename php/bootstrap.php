<?php
/**
 * Shared bootstrap for hunt-design-lab PHP entry points.
 * Sets project root, job storage paths, and a simple class autoloader.
 */

declare(strict_types=1);

define('HDL_ROOT', dirname(__DIR__));
define('HDL_PHP', HDL_ROOT . '/php');
define('HDL_TEMPLATES', HDL_ROOT . '/templates');
define('HDL_VAR', HDL_ROOT . '/var');
define('HDL_JOBS', HDL_VAR . '/jobs');

/** Absolute path to the Node binary used for CLI scripts. */
define('HDL_NODE_BIN', getenv('HDL_NODE_BIN') ?: 'node');

/** Absolute path to PHP CLI used to spawn background job workers. */
define('HDL_PHP_BIN', getenv('HDL_PHP_BIN') ?: PHP_BINARY);

/**
 * Ensure var/jobs exists with restrictive defaults (web server writable).
 */
function hdl_ensure_storage(): void
{
    foreach ([HDL_VAR, HDL_JOBS] as $dir) {
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new RuntimeException('Cannot create storage directory: ' . $dir);
            }
        }
    }
}

/**
 * Web path of the project root (no trailing slash). Empty string = domain root.
 *
 * Detected from SCRIPT_NAME so the UI works under a subfolder, e.g.
 *   /index.php                → ''
 *   /hunt-design-lab/index.php → '/hunt-design-lab'
 *
 * Override with env HDL_APP_ROOT (with or without leading slash) when the
 * server rewrites SCRIPT_NAME incorrectly.
 */
function hdl_web_app_root(): string
{
    $env = getenv('HDL_APP_ROOT');
    if ($env !== false && trim((string) $env) !== '') {
        $root = '/' . trim(str_replace('\\', '/', (string) $env), '/');
        return $root === '/' ? '' : $root;
    }

    $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? ''));
    if ($script === '') {
        return '';
    }

    $dir = rtrim(str_replace('\\', '/', dirname($script)), '/');
    if ($dir === '' || $dir === '/' || $dir === '.') {
        return '';
    }
    if ($dir[0] !== '/') {
        $dir = '/' . $dir;
    }
    return $dir;
}

/**
 * Redirect directory-style URLs missing a trailing slash to the slash form.
 *
 * Example: /hunt-design-lab → /hunt-design-lab/
 * Relative asset links then resolve under the app folder instead of the parent.
 * No-op for root, explicit files (*.php), or when already slashed.
 */
function hdl_redirect_trailing_slash_if_needed(): void
{
    $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if ($method !== 'GET' && $method !== 'HEAD') {
        return;
    }

    $uri = (string) ($_SERVER['REQUEST_URI'] ?? '');
    if ($uri === '') {
        return;
    }

    $parts = parse_url($uri);
    if ($parts === false) {
        return;
    }
    $path = $parts['path'] ?? '';
    if ($path === '' || $path === '/' || str_ends_with($path, '/')) {
        return;
    }

    // Explicit file (index.php, sprite-manager.php, assets, …)
    $base = basename($path);
    if (str_contains($base, '.')) {
        return;
    }

    $appRoot = hdl_web_app_root();
    if ($appRoot === '' || $path !== $appRoot) {
        return;
    }

    $query = isset($parts['query']) && $parts['query'] !== ''
        ? '?' . $parts['query']
        : '';
    header('Location: ' . $path . '/' . $query, true, 301);
    exit;
}

/**
 * PSR-4-ish autoload for classes under php/lib/ (namespace De\).
 * Example: De\JobStore → php/lib/JobStore.php
 */
spl_autoload_register(static function (string $class): void {
    $prefix = 'De\\';
    if (strncmp($prefix, $class, strlen($prefix)) !== 0) {
        return;
    }
    $relative = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = HDL_PHP . '/lib/' . $relative . '.php';
    if (is_file($file)) {
        require_once $file;
    }
});

require_once HDL_PHP . '/config.php';
require_once HDL_PHP . '/lib/ModeRegistry.php';
