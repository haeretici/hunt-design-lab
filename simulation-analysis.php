<?php
/**
 * Simulation Analysis page entry (Stage 8 balance sweeps + charts).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Simulation Analysis — Hunt Design Lab';

require HDL_TEMPLATES . '/simulation-analysis.php';
