<?php
/**
 * Sprite Manager page entry (catalog browser under Asset Manager).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Sprite Manager — Hunt Design Lab';

require HDL_TEMPLATES . '/asset-manager.php';
