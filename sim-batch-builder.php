<?php
/**
 * Hunt Simulation Batch Builder page entry (Stage 12I).
 * Full page or popup (?popup=1) — composes headless hunt CLI config.
 * Distinct from sprite Batch Builder (sprite-batch-builder.php).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Hunt Batch Builder — Hunt Design Lab';

require HDL_TEMPLATES . '/sim-batch-builder.php';
