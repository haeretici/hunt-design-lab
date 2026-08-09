<?php
/**
 * Wiki — Legacy Map browser.
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Wiki · Legacy Map — Hunt Design Lab';
$activeNav = 'wiki-legacy-map';

require HDL_TEMPLATES . '/wiki-legacy-map.php';
