<?php
/**
 * Hunt Design Lab web entry — Hunt Simulator (default).
 * Dev server: php -d memory_limit=512M -S 127.0.0.1:8080 -t ./
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Hunt Simulator — Hunt Design Lab';

require HDL_TEMPLATES . '/game.php';
