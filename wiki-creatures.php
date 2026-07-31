<?php
/**
 * Wiki — Creatures browser (view mode of the shared creature catalog UI).
 */

declare(strict_types=1);

require_once __DIR__ . '/php/bootstrap.php';

hdl_redirect_trailing_slash_if_needed();

$appRoot = hdl_web_app_root();
$pageTitle = 'Wiki · Creatures — Hunt Design Lab';
$wikiKind = 'creatures';
$activeNav = 'wiki-creatures';

require HDL_TEMPLATES . '/wiki.php';
