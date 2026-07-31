<?php
/**
 * Sprite Batch Builder page entry (popup from Sprite Manager, or full page).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Sprite Batch Builder — Hunt Design Lab';

require HDL_TEMPLATES . '/sprite-batch-builder.php';
