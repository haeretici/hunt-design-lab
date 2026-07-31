<?php
/**
 * Scenario Lab page entry — watch named hunt fixtures (Stage 12G.2 shell).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Scenario Lab — Hunt Design Lab';

require HDL_TEMPLATES . '/scenario-lab.php';
