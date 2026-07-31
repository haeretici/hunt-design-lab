<?php
/**
 * Wiki — Equipment browser (view mode of the shared equipment catalog UI).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Wiki · Equipments — Hunt Design Lab';
$wikiKind = 'equipment';
$activeNav = 'wiki-equipment';

require HDL_TEMPLATES . '/wiki.php';
