<?php
/**
 * Designer Rule UI — mode-scoped preset CRUD (Phase 1: spells + classes).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Designer — Hunt Design Lab';

require HDL_TEMPLATES . '/designer-ui.php';
