<?php
/**
 * Hunt Editor — CRUD for mode hunt packages (JSON + browser.hunts).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Hunt Editor — Hunt Design Lab';

require HDL_TEMPLATES . '/hunt-editor.php';
