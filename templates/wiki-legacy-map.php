<?php
/**
 * Wiki shell — Legacy Map
 */
declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Wiki · Legacy Map — Hunt Design Lab';
$appRoot = isset($appRoot) ? rtrim((string) $appRoot, '/') : '';
$activeNav = $activeNav ?? 'wiki-legacy-map';
$asset = static function (string $path) use ($appRoot): string {
    $path = ltrim($path, '/');
    return ($appRoot === '' ? '' : $appRoot) . '/' . $path;
};
$apiUrl = $asset('php/api.php');
$cssUrl = $asset('build/app.css');
?>
<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($pageTitle, ENT_QUOTES, 'UTF-8') ?></title>
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon-32.png?v=4'), ENT_QUOTES, 'UTF-8') ?>" type="image/png" sizes="32x32">
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon.svg?v=4'), ENT_QUOTES, 'UTF-8') ?>" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.15.0" rel="stylesheet">
    <style>
        body, html {
            height: 100%;
            overflow: hidden;
            background-color: var(--bs-body-bg);
        }
        .map-viewer-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
            background-color: #000;
        }
        #imageContainer {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            overflow: scroll;
            cursor: grab;
        }
        #imageContainer.panning {
            cursor: grabbing;
        }
        /* Scroll sizer only — display is viewport-sized #editorCanvas overlay */
        #mapScrollSizer {
            position: relative;
            pointer-events: none;
        }
        #editorCanvas {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            image-rendering: pixelated;
            z-index: 2;
            user-select: none;
        }
        #viewportArea.is-map-loading {
            cursor: wait;
        }
        #imageContainer.is-map-loading {
            pointer-events: none;
        }
        .map-load-overlay {
            position: absolute;
            inset: 0;
            z-index: 20;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.62);
            pointer-events: auto;
        }
        .map-load-overlay[hidden] {
            display: none !important;
        }
        .map-load-overlay-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 0.75rem;
            color: #dee2e6;
            font-size: 0.9rem;
        }

        .sidebar-panel {
            width: 260px;
            min-width: 260px;
            background: var(--bs-gray-900);
            display: flex;
            flex-direction: column;
            overflow-y: auto;
        }
        .map-layout {
            display: flex;
            flex: 1;
            overflow: hidden;
            height: calc(100vh - 48px); /* minus header */
        }
        .tree-item {
            user-select: none;
            transition: background-color 0.15s, color 0.15s;
        }
        .tree-item:hover {
            background-color: rgba(255, 255, 255, 0.05);
        }
        .tree-item.active {
            background-color: rgba(13, 110, 253, 0.15);
            color: #fff !important;
        }
        .tool-btn.active {
            background-color: var(--bs-primary);
            border-color: var(--bs-primary);
            color: #fff;
        }
        .editor-header-bar .global-actions .btn {
            font-size: 0.7rem;
            padding: 0.15rem 0.5rem;
            line-height: 1.2;
            white-space: nowrap;
        }
        .floor-selector .btn {
            font-size: 0.8rem;
        }
        .floor-panel-title {
            letter-spacing: 0.04em;
        }
        /* Equal 50/50 pairs — short "Z" vs long "Respawn" must not size the columns. */
        #propsContent .prop-pair {
            display: flex;
            gap: 0.5rem;
        }
        #propsContent .prop-pair > div {
            flex: 1 1 0;
            min-width: 0;
        }
        #propsContent .prop-pair input {
            width: 100%;
            min-width: 0;
        }
        .sidebar-panel-left {
            overflow: hidden;
        }
        .map-tool-strip .tool-btn {
            flex: 1 1 0;
            min-width: 0;
        }
        .map-toolbar {
            flex: 0 0 auto;
        }
        .map-toolbar-filters {
            flex-wrap: wrap;
        }
        .sidebar-panel-left .object-tree {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
        }
        .map-minimap-dock {
            flex: 0 0 auto;
        }
        #mapMinimap {
            display: block;
            width: 100%;
            height: auto;
            image-rendering: pixelated;
            cursor: crosshair;
            background: #111;
            border: 1px solid #495057;
        }
        #findResultsList .find-hit {
            cursor: pointer;
        }
        #findResultsList .find-hit:hover {
            background: rgba(255, 255, 255, 0.06);
        }
    </style>
</head>
<body id="wiki-legacy-map-app">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
</script>

<div class="editor-app-container d-flex flex-column h-100">
    <header class="editor-header-bar">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
        <?php require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <button type="button" class="btn btn-sm btn-outline-success" id="btnSaveMap" title="Save Map (Ctrl+S)">
                <i class="fa-solid fa-floppy-disk"></i> Save Map
            </button>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="btnExportPng" title="Export friction channel as PNG">
                <i class="fa-solid fa-file-image"></i> Export PNG
            </button>
            <span class="badge-retro"><i class="fa-solid fa-map"></i> Wiki · Legacy Map</span>
        </div>
    </header>

    <div class="map-layout">
        <!-- Object Browser Sidebar: floor selector + layers of current floor -->
        <div class="sidebar-panel sidebar-panel-left border-end border-secondary px-3 py-2">
            <div class="map-tool-strip d-flex align-items-center gap-1 mb-2" role="toolbar" aria-label="Map tools">
                <button type="button" class="btn btn-sm btn-outline-primary tool-btn active" data-tool="select" title="Select (M)">
                    <i class="fa-solid fa-arrow-pointer"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-secondary tool-btn" data-tool="pen" title="Pen (P)">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-secondary tool-btn" data-tool="bucket" title="Bucket (G)">
                    <i class="fa-solid fa-fill-drip"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-secondary tool-btn" data-tool="eyedropper" title="Eyedropper (I) · Alt+click">
                    <i class="fa-solid fa-eye-dropper"></i>
                </button>
            </div>
            <h6 class="text-uppercase text-secondary small fw-bold mb-2 sr-only" style="letter-spacing: 0.05em;">Object Browser</h6>

            <div class="text-secondary small mb-1 sr-only">Floor</div>
            <div class="mb-2 floor-selector">
                <div class="btn-group btn-group-sm w-100">
                    <button type="button" class="btn btn-outline-secondary" id="floorOutBtn" title="Previous floor"><i class="fa-solid fa-minus"></i></button>
                    <button type="button" class="btn btn-outline-secondary dropdown-toggle" id="floorDropdown" data-bs-toggle="dropdown" aria-expanded="false" style="min-width: 96px;">Floor 07</button>
                    <ul class="dropdown-menu dropdown-menu-dark shadow-sm" id="floorDropdownMenu">
                        <?php for ($i = 0; $i <= 15; $i++):
                            $floor = str_pad((string)$i, 2, '0', STR_PAD_LEFT);
                            $isActive = $i === 7;
                        ?>
                        <li><a class="dropdown-item floor-option<?= $isActive ? ' active' : '' ?>" href="#" data-floor="<?= $floor ?>">Floor <?= $floor ?></a></li>
                        <?php endfor; ?>
                    </ul>
                    <button type="button" class="btn btn-outline-secondary" id="floorInBtn" title="Next floor"><i class="fa-solid fa-plus"></i></button>
                </div>
            </div>

            <div class="floor-panel-title text-uppercase text-secondary small fw-bold mb-2">
                Floor <span id="floorPanelLabel">07</span> · layers
            </div>
            <div class="object-tree" style="font-size: 0.85rem;" id="objectBrowserTree">
                <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                     data-target="world" data-action="select-layer">
                    <i class="fa-solid fa-box fa-sm text-muted"></i>
                    <span>World <span id="world-count" class="text-info fw-bold ms-1" style="font-size: 0.75rem;"></span></span>
                    <span class="ms-auto visibility-toggle" data-layer-suffix="world" title="Toggle World">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </span>
                </div>
                <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                     data-target="spawns" data-action="select-layer">
                    <i class="fa-solid fa-ghost fa-sm text-muted"></i>
                    <span>Spawns <span id="floor-count" class="text-info fw-bold ms-1" style="font-size: 0.75rem;"></span></span>
                    <span class="ms-auto visibility-toggle" data-layer-suffix="spawns" title="Toggle Spawns">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </span>
                </div>
                <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                     data-target="fields" data-action="select-layer">
                    <i class="fa-solid fa-fire fa-sm text-muted"></i>
                    <span>Fields</span>
                    <span class="ms-auto visibility-toggle" data-layer-suffix="fields" title="Toggle Fields">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </span>
                </div>
                <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                     data-target="tilemap" data-action="select-layer">
                    <i class="fa-solid fa-cubes fa-sm text-muted"></i>
                    <span>TileMap</span>
                    <span class="ms-auto visibility-toggle" data-layer-suffix="tilemap" title="Toggle TileMap">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </span>
                </div>
                <div class="tree-children ps-3 border-start border-secondary ms-2 mt-1 mb-1" id="tilemap-children">
                    <?php foreach (['vertical', 'furniture', 'scenery', 'path', 'ground'] as $sub): ?>
                    <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                         data-target="tilemap:<?= $sub ?>" data-action="select-layer">
                        <i class="fa-solid fa-square fa-xs text-muted"></i>
                        <span><?= htmlspecialchars(ucfirst($sub), ENT_QUOTES, 'UTF-8') ?></span>
                        <span class="ms-auto visibility-toggle" data-layer-suffix="tilemap-<?= $sub ?>" title="Toggle <?= htmlspecialchars($sub, ENT_QUOTES, 'UTF-8') ?>">
                            <i class="fa-solid fa-eye fa-sm"></i>
                        </span>
                    </div>
                    <?php endforeach; ?>
                </div>
                <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                     data-target="flags" data-action="select-layer">
                    <i class="fa-regular fa-flag fa-sm text-muted"></i>
                    <span>Flags</span>
                    <span class="ms-auto visibility-toggle" data-layer-suffix="flags" title="Toggle Flags">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </span>
                </div>
                <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                     data-target="sight" data-action="select-layer">
                    <i class="fa-regular fa-eye fa-sm text-muted"></i>
                    <span>Sight</span>
                    <span class="ms-auto visibility-toggle" data-layer-suffix="sight" title="Toggle Sight">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </span>
                </div>
                <div class="tree-item d-flex align-items-center gap-2 px-2 py-1 rounded cursor-pointer text-secondary"
                     data-target="friction" data-action="select-layer">
                    <i class="fa-regular fa-image fa-sm text-muted"></i>
                    <span>Friction</span>
                    <span class="ms-auto visibility-toggle" data-layer-suffix="friction" title="Toggle Friction">
                        <i class="fa-solid fa-eye fa-sm"></i>
                    </span>
                </div>
            </div>
            <div class="map-minimap-dock mt-2 pt-2 border-top border-secondary">
                <div class="d-flex align-items-center justify-content-between mb-1">
                    <span class="text-uppercase text-secondary small fw-bold" style="letter-spacing: 0.04em;">Minimap</span>
                    <span class="small text-secondary" id="minimapHint">click to jump</span>
                </div>
                <canvas id="mapMinimap" width="248" height="198" title="Click to center"></canvas>
            </div>
        </div>

        <!-- Center Viewport -->
        <div class="map-viewer-container bg-black">
            <!-- Toolbar -->
            <div class="map-toolbar border-bottom border-secondary bg-dark">
                <div class="d-flex align-items-center gap-2 px-2 pt-2 pb-1">
                <button type="button" class="btn btn-sm btn-outline-secondary tool-btn" data-tool="pan" title="Pan (H) · MMB / Space">
                    <i class="fa-solid fa-hand"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="btnGoto" title="Goto XYZ or creature id (Ctrl+G)">
                    <i class="fa-solid fa-location-crosshairs"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="btnFind" title="Find unknown / blocked / id (Ctrl+F)">
                    <i class="fa-solid fa-magnifying-glass"></i>
                </button>
                <div class="vr mx-1 bg-secondary"></div>
                <div class="btn-group btn-group-sm">
                    <button class="btn btn-outline-secondary dropdown-toggle" type="button" id="brushShapeDropdown" data-bs-toggle="dropdown" aria-expanded="false" title="Brush Shape"><i class="fa-solid fa-paint-brush"></i> Square</button>
                    <ul class="dropdown-menu dropdown-menu-dark shadow-sm">
                        <li><a class="dropdown-item brush-shape active" href="#" data-shape="square">Square</a></li>
                        <li><a class="dropdown-item brush-shape" href="#" data-shape="circle">Circle</a></li>
                        <li><a class="dropdown-item brush-shape" href="#" data-shape="diamond">Diamond</a></li>
                        <li><a class="dropdown-item brush-shape" href="#" data-shape="cross">Cross</a></li>
                        <li><a class="dropdown-item brush-shape" href="#" data-shape="dither">Dither 50%</a></li>
                        <li><a class="dropdown-item brush-shape" href="#" data-shape="spray">Spray</a></li>
                    </ul>
                </div>
                <div class="btn-group btn-group-sm ms-1">
                    <button class="btn btn-outline-secondary dropdown-toggle" type="button" id="brushSizeDropdown" data-bs-toggle="dropdown" aria-expanded="false" title="Brush Size"><i class="fa-solid fa-maximize"></i> 1x1</button>
                    <ul class="dropdown-menu dropdown-menu-dark shadow-sm">
                        <li><a class="dropdown-item brush-size active" href="#" data-size="1">1x1</a></li>
                        <li><a class="dropdown-item brush-size" href="#" data-size="2">2x2</a></li>
                        <li><a class="dropdown-item brush-size" href="#" data-size="3">3x3</a></li>
                        <li><a class="dropdown-item brush-size" href="#" data-size="4">4x4</a></li>
                        <li><a class="dropdown-item brush-size" href="#" data-size="5">5x5</a></li>
                        <li><a class="dropdown-item brush-size" href="#" data-size="7">7x7</a></li>
                        <li><a class="dropdown-item brush-size" href="#" data-size="9">9x9</a></li>
                    </ul>
                </div>
                <button type="button" class="btn btn-sm btn-outline-secondary ms-1" id="btnToggleGrid" title="Toggle Grid">
                    <i class="fa-solid fa-border-all"></i>
                </button>
                <div class="vr mx-1 bg-secondary"></div>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="btnUndo" title="Undo (Ctrl+Z)" disabled>
                    <i class="fa-solid fa-rotate-left"></i>
                </button>
                <button type="button" class="btn btn-sm btn-outline-secondary" id="btnRedo" title="Redo (Ctrl+Y)" disabled>
                    <i class="fa-solid fa-rotate-right"></i>
                </button>
                <div class="vr mx-1 bg-secondary"></div>
                <div class="btn-group btn-group-sm">
                    <button class="btn btn-outline-secondary" id="zoomOutBtn" title="Zoom Out"><i class="fa-solid fa-minus"></i></button>
                    <button class="btn btn-outline-secondary dropdown-toggle" type="button" id="zoomDropdown" data-bs-toggle="dropdown" aria-expanded="false" style="min-width: 80px;">100%</button>
                    <ul class="dropdown-menu dropdown-menu-dark shadow-sm">
                        <li><a class="dropdown-item image-zoom active" href="#" data-zoom="1">100%</a></li>
                        <li><a class="dropdown-item image-zoom" href="#" data-zoom="2">200%</a></li>
                        <li><a class="dropdown-item image-zoom" href="#" data-zoom="4">400%</a></li>
                        <li><a class="dropdown-item image-zoom" href="#" data-zoom="8">800%</a></li>
                        <li><a class="dropdown-item image-zoom" href="#" data-zoom="16">1600%</a></li>
                        <li><a class="dropdown-item image-zoom" href="#" data-zoom="32">3200%</a></li>
                    </ul>
                    <button class="btn btn-outline-secondary" id="zoomInBtn" title="Zoom In"><i class="fa-solid fa-plus"></i></button>
                </div>
                <div class="btn-group btn-group-sm ms-1">
                    <button class="btn btn-outline-secondary dropdown-toggle" type="button" id="spriteZoomDropdown" data-bs-toggle="dropdown" aria-expanded="false" title="Show catalog tile icons (32×32) from this zoom upward. World stays 1px/tile role colors for performance." style="min-width: 7.5rem;">Icons ≥800%</button>
                    <ul class="dropdown-menu dropdown-menu-dark shadow-sm" id="spriteZoomMenu">
                        <li><a class="dropdown-item sprite-zoom-opt" href="#" data-sprite-zoom="0">Always</a></li>
                        <li><a class="dropdown-item sprite-zoom-opt" href="#" data-sprite-zoom="4">≥400%</a></li>
                        <li><a class="dropdown-item sprite-zoom-opt active" href="#" data-sprite-zoom="8">≥800%</a></li>
                        <li><a class="dropdown-item sprite-zoom-opt" href="#" data-sprite-zoom="16">≥1600%</a></li>
                        <li><a class="dropdown-item sprite-zoom-opt" href="#" data-sprite-zoom="32">≥3200%</a></li>
                        <li><hr class="dropdown-divider border-secondary"></li>
                        <li><a class="dropdown-item sprite-zoom-opt" href="#" data-sprite-zoom="off">Off (role colors)</a></li>
                    </ul>
                </div>
                </div>
                <div class="map-toolbar-filters d-flex align-items-center gap-3 px-2 pb-2 py-1">
                    <div class="form-check mb-0">
                        <input class="form-check-input" type="checkbox" id="mouseZoom" checked>
                        <label class="form-check-label small text-secondary" for="mouseZoom">Mouse Wheel Zoom</label>
                    </div>
                    <div class="form-check mb-0">
                        <input class="form-check-input" type="checkbox" id="filterOnlyNpcs">
                        <label class="form-check-label small text-secondary" for="filterOnlyNpcs" title="Show only pins whose template is an NPC">NPCs</label>
                    </div>
                    <div class="form-check mb-0">
                        <input class="form-check-input" type="checkbox" id="filterOnlyModified">
                        <label class="form-check-label small text-secondary" for="filterOnlyModified" title="Show only pins added or edited since load/save">Modified</label>
                    </div>
                    <div class="form-check mb-0">
                        <input class="form-check-input" type="checkbox" id="showMapCenter">
                        <label class="form-check-label small text-secondary" for="showMapCenter" title="Mark the center of the current viewport with a cross">Show Center</label>
                    </div>
                    <input type="text" class="form-control form-control-sm bg-black border-secondary text-white ms-auto" placeholder="Filter id…" id="monster-name" style="width: 140px;" title="Filter overlay by creature id / label">
                </div>
            </div>

            <!-- Canvas (Phase 8 polish: viewport-sized display; world cache detached; spawns on same canvas) -->
            <div class="flex-grow-1 position-relative overflow-hidden is-map-loading" id="viewportArea">
                <div id="imageContainer" class="is-map-loading" data-floor="07">
                    <div id="mapScrollSizer"></div>
                </div>
                <canvas id="editorCanvas" class="map-layer"></canvas>
                <div id="mapLoadOverlay" class="map-load-overlay" aria-busy="true" aria-live="polite">
                    <div class="map-load-overlay-card">
                        <div class="spinner-border text-light" role="status" aria-hidden="true"></div>
                        <div class="map-load-overlay-text">Loading map…</div>
                    </div>
                </div>
            </div>

            <!-- Status Bar -->
            <div class="px-2 py-1 border-top border-secondary bg-dark small text-secondary font-monospace d-flex align-items-center">
                <span id="statusBar">Ready</span>
                <span class="ms-auto" id="monster-results"></span>
            </div>
        </div>

        <!-- Properties Mock Sidebar -->
        <div class="sidebar-panel border-start border-secondary p-3">
            <h6 class="text-uppercase text-secondary small fw-bold mb-3" style="letter-spacing: 0.05em;">Properties</h6>
            <div id="layer-props" class="small mb-3" style="display:none;"></div>
            <div id="propsContent" class="small text-muted">
                Select an object to view properties.
            </div>
            <datalist id="monsterDatalist"></datalist>
        </div>
    </div>
</div>

<!-- Modal -->
<div class="modal fade" id="monsterModal" tabindex="-1" aria-labelledby="monsterModalLabel" aria-hidden="true">
  <div class="modal-dialog modal-lg modal-dialog-centered">
    <div class="modal-content">
      <div class="modal-header">
        <h5 class="modal-title" id="monsterModalLabel">Monster Stats</h5>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body" id="monsterModalBody">
      </div>
    </div>
  </div>
</div>

<div class="modal fade" id="spawnFloorMoveModal" tabindex="-1" aria-labelledby="spawnFloorMoveModalLabel" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content bg-dark text-white">
      <div class="modal-header border-secondary">
        <h5 class="modal-title" id="spawnFloorMoveModalLabel">Move spawn to another floor?</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body" id="spawnFloorMoveModalBody"></div>
      <div class="modal-footer border-secondary">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
        <button type="button" class="btn btn-primary" id="spawnFloorMoveModalOk">Move and save</button>
      </div>
    </div>
  </div>
</div>

<div class="modal fade" id="gotoModal" tabindex="-1" aria-labelledby="gotoModalLabel" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content bg-dark text-white">
      <div class="modal-header border-secondary">
        <h5 class="modal-title" id="gotoModalLabel">Goto</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body">
        <label class="form-label small text-secondary" for="gotoInput">x,y[,z] or creature id</label>
        <input type="text" class="form-control bg-black border-secondary text-white" id="gotoInput" placeholder="2099, 26, 7" autocomplete="off">
        <div class="small text-secondary mt-2">Enter jumps. Repeat search to cycle matches.</div>
      </div>
      <div class="modal-footer border-secondary">
        <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Close</button>
        <button type="button" class="btn btn-primary" id="gotoModalGo">Go</button>
      </div>
    </div>
  </div>
</div>

<div class="modal fade" id="findModal" tabindex="-1" aria-labelledby="findModalLabel" aria-hidden="true">
  <div class="modal-dialog modal-lg modal-dialog-centered modal-dialog-scrollable">
    <div class="modal-content bg-dark text-white">
      <div class="modal-header border-secondary">
        <h5 class="modal-title" id="findModalLabel">Find on map</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body">
        <div class="d-flex gap-2 mb-2">
          <input type="text" class="form-control bg-black border-secondary text-white" id="findInput" placeholder="creature id or label" autocomplete="off">
          <button type="button" class="btn btn-outline-primary" id="findBtnSearch">Search</button>
          <button type="button" class="btn btn-outline-warning" id="findBtnUnknown">Unknown</button>
          <button type="button" class="btn btn-outline-danger" id="findBtnBlocked">Blocked</button>
        </div>
        <div class="form-check mb-2">
          <input class="form-check-input" type="checkbox" id="findCurrentFloorOnly">
          <label class="form-check-label small text-secondary" for="findCurrentFloorOnly">Current floor only</label>
        </div>
        <div class="small text-secondary mb-2" id="findStatus">Unknown: empty or uncatalogued ids (no name needed). Blocked: pins on unwalkable tiles of the open floor.</div>
        <div id="findResultsList" class="small"></div>
      </div>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script src="<?= htmlspecialchars($asset('build/map-editor.bundle.js'), ENT_QUOTES, 'UTF-8') ?>?v=1.0.10"></script>
<script>
/**
 * Legacy Map wiki viewer.
 *
 * Coordinate contract (must match engine + hybrid / by_floor pins):
 *   - Pin rows store MAP-LOCAL tile coords (pixel = tile on floor-*-path.png).
 *   - Hybrid `floor-XX/map.json` `spawns` is SoT when that pack exists;
 *     `by_floor/XX.json` is fallback only.
 *   - Hybrid `world` is SoT for World pins (no by_floor analog).
 *   - Same conversion as assets/legacy/monsters/js/map-spawn.js:
 *       localX = worldX - bounds.xMin, localY = worldY - bounds.yMin
 *   - Engine spawnSource.legacy_floor filters those local x/y directly — do NOT
 *     re-subtract bounds here or rewrite pin files.
 *   - ?point=x,y,z,zoomPct uses LOCAL coords (same as map-spawn.js deep-links).
 */
document.addEventListener("DOMContentLoaded", () => {
    const ASSET_ROOT = window.__APP_ROOT__ || '/';

    const imageContainer = document.getElementById('imageContainer');
    const viewportArea = document.getElementById('viewportArea');
    const mapScrollSizer = document.getElementById('mapScrollSizer');
    /** Phase 8 polish: viewport-sized display (world = detached; session = truth). */
    const editorCanvas = document.getElementById('editorCanvas');
    /** @type {HTMLCanvasElement|null} map-space world buffer (not in DOM) */
    let worldCanvas = null;
    /** Compat alias: map pixel size source for legacy paint paths without session. */
    let selectedImage = null;

    /** @type {any} */
    const HdlTM = window.HdlTileMapEditor || null;
    /** @type {any} */
    let tilemapSession = null;
    /** Generation token so a stale floor/hybrid fetch cannot apply after a switch. */
    let mapLoadGen = 0;
    let mapEditReady = false;
    let floorPngReady = false;
    /** @type {Promise<any>|null} */
    let sessionLoadPromise = null;
    let sessionLoadGen = -1;
    let tilemapRoleCatalog = null;
    let tilemapArtSetId = 'cave_simple';
    let tilemapArtGenre = 'rpg_fantasy';
    let tilemapEraseMode = false;
    let tileClipboard = null;
    let tilemapRawStamp = null;
    let selectedFlagPackage = null;
    let selectedFlagBits = null;
    let selectedFieldValue = null;
    const TILEMAP_SUBS = (HdlTM && HdlTM.UI_SUB_LAYER_ORDER) || ['vertical', 'furniture', 'scenery', 'path', 'ground'];
    /** @type {any} */
    const editorViewport =
        HdlTM && typeof HdlTM.createEditorViewport === 'function'
            ? HdlTM.createEditorViewport({ cols: 0, rows: 0, zoom: 1 })
            : null;
    const mapLoadOverlay = document.getElementById('mapLoadOverlay');
    const mapLoadOverlayText =
        mapLoadOverlay && mapLoadOverlay.querySelector('.map-load-overlay-text');

    function setMapLoading(on, message) {
        mapEditReady = !on;
        if (mapLoadOverlay) {
            mapLoadOverlay.hidden = !on;
            mapLoadOverlay.setAttribute('aria-busy', on ? 'true' : 'false');
        }
        if (mapLoadOverlayText && message) {
            mapLoadOverlayText.textContent = message;
        }
        if (viewportArea) viewportArea.classList.toggle('is-map-loading', !!on);
        if (imageContainer) imageContainer.classList.toggle('is-map-loading', !!on);
        if (on) {
            const sb = document.getElementById('statusBar');
            if (sb) sb.textContent = message || 'Loading map…';
        }
    }

    function beginMapLoad(message) {
        mapLoadGen += 1;
        setMapLoading(true, message || 'Loading map…');
        return mapLoadGen;
    }

    function finishMapLoad(gen) {
        if (gen !== mapLoadGen) return false;
        setMapLoading(false);
        return true;
    }

    function isMapEditReady() {
        return !!mapEditReady;
    }

    function canBootstrapFromPng() {
        if (editorViewport && editorViewport.baseRgba && editorViewport.baseRgba.data) {
            return (editorViewport.baseRgba.width | 0) > 0 && (editorViewport.baseRgba.height | 0) > 0;
        }
        return !!(editorCanvas && editorCanvas.width);
    }

    function layerNeedsEditorSession(layer) {
        return isTileMapLayer(layer) || ['friction', 'sight', 'flags', 'fields'].includes(layer);
    }

    /** Min zoom for catalog icon overpaint (null = off). Persisted. Default 800%. */
    const SPRITE_ZOOM_STORAGE_KEY = 'hdl.mapEditor.spriteZoomMin';
    function loadSpriteZoomMinPref() {
        try {
            const raw = localStorage.getItem(SPRITE_ZOOM_STORAGE_KEY);
            if (raw == null || raw === '') return 8;
            if (typeof HdlTM !== 'undefined' && HdlTM && typeof HdlTM.normalizeSpriteZoomMin === 'function') {
                return HdlTM.normalizeSpriteZoomMin(raw, 8);
            }
            if (raw === 'off' || raw === 'null') return null;
            const n = parseFloat(raw);
            return Number.isFinite(n) ? n : 8;
        } catch (_e) {
            return 8;
        }
    }
    function saveSpriteZoomMinPref(v) {
        try {
            if (v == null) localStorage.setItem(SPRITE_ZOOM_STORAGE_KEY, 'off');
            else localStorage.setItem(SPRITE_ZOOM_STORAGE_KEY, String(v));
        } catch (_e) {
            /* private mode */
        }
    }
    function spriteZoomLabel(v) {
        if (v == null) return 'Icons off';
        if (v <= 0) return 'Icons always';
        return 'Icons ≥' + Math.round(v * 100) + '%';
    }
    function applySpriteZoomMin(v, opts) {
        const o = opts || {};
        let next = v;
        if (HdlTM && typeof HdlTM.normalizeSpriteZoomMin === 'function') {
            next = HdlTM.normalizeSpriteZoomMin(v, 8);
        } else if (v === 'off' || v === false) {
            next = null;
        } else {
            next = v == null ? null : +v;
            if (!Number.isFinite(next) && next !== null) next = 8;
        }
        if (editorViewport && typeof editorViewport.setSpriteZoomMin === 'function') {
            editorViewport.setSpriteZoomMin(next === null ? 'off' : next);
            next = editorViewport.spriteZoomMin;
        }
        if (!o.skipSave) saveSpriteZoomMinPref(next);
        const dd = document.getElementById('spriteZoomDropdown');
        if (dd) dd.textContent = spriteZoomLabel(next);
        document.querySelectorAll('.sprite-zoom-opt').forEach((el) => {
            const raw = el.getAttribute('data-sprite-zoom');
            let match = false;
            if (raw === 'off') match = next == null;
            else if (raw === '0') match = next === 0 || next === 0.0;
            else match = next != null && Math.abs(+raw - next) < 1e-6;
            el.classList.toggle('active', match);
        });
        if (!o.skipMark) markDirty();
        return next;
    }
    if (editorViewport) {
        applySpriteZoomMin(loadSpriteZoomMinPref(), { skipSave: true, skipMark: true });
    }

    /** Detached export surface (not in DOM). */
    let exportCanvas = null;
    /** Display context (viewport-sized #editorCanvas). */
    const canvas = editorCanvas;
    const ctx = canvas ? canvas.getContext('2d') : null;
    let canvasDirty = false;
    const imageCache = new Map();
    /** Catalog tile/object images for authoring blits. */
    const tileImageCache = new Map();

    function mapPixelWidth() {
        if (editorViewport && editorViewport.cols) return editorViewport.cols;
        if (worldCanvas && worldCanvas.width) return worldCanvas.width;
        return bounds.width || 2560;
    }
    function mapPixelHeight() {
        if (editorViewport && editorViewport.rows) return editorViewport.rows;
        if (worldCanvas && worldCanvas.height) return worldCanvas.height;
        return bounds.height || 2048;
    }

    function ensureWorldCanvas(cols, rows) {
        const c = Math.max(1, cols | 0);
        const r = Math.max(1, rows | 0);
        if (!worldCanvas) {
            worldCanvas = document.createElement('canvas');
        }
        if (worldCanvas.width !== c || worldCanvas.height !== r) {
            worldCanvas.width = c;
            worldCanvas.height = r;
        }
        selectedImage = worldCanvas;
        return worldCanvas;
    }

    function updateScrollSizer() {
        if (!mapScrollSizer) return;
        const w = mapPixelWidth() * zoomValue;
        const h = mapPixelHeight() * zoomValue;
        mapScrollSizer.style.width = Math.max(1, Math.round(w)) + 'px';
        mapScrollSizer.style.height = Math.max(1, Math.round(h)) + 'px';
    }

    /**
     * Lazy catalog image for terrain/prop blits.
     * Variant comes from placement → role.render.variant → icon (32px default).
     * @param {string} catalogId
     * @param {string} kind
     * @param {string} [variant]
     */
    function getAuthoringImage(catalogId, kind, variant) {
        if (!catalogId) return null;
        const k = kind === 'objects' || kind === 'overlays' ? kind : 'tiles';
        const v = variant && String(variant).trim() ? String(variant).trim() : 'icon';
        const key = tilemapArtGenre + '|' + k + '|' + v + '|' + catalogId;
        let entry = tileImageCache.get(key);
        if (!entry) {
            let rel = null;
            if (HdlTM && typeof HdlTM.resolveSpriteRelPath === 'function') {
                rel = HdlTM.resolveSpriteRelPath({
                    genre: tilemapArtGenre,
                    kind: k,
                    id: catalogId,
                    variant: v
                });
            }
            if (!rel) {
                const stem =
                    HdlTM && typeof HdlTM.idToFileStem === 'function'
                        ? HdlTM.idToFileStem(catalogId)
                        : String(catalogId);
                rel = 'assets/sprites/' + tilemapArtGenre + '/' + k + '/' + v + '/' + stem + '.png';
            }
            const url = ASSET_ROOT + rel;
            entry = { image: new Image(), loaded: false, error: false };
            entry.image.onload = () => {
                entry.loaded = true;
                if (editorViewport) editorViewport.markDirty(['props', 'terrain', 'full']);
                markDirty();
            };
            entry.image.onerror = () => {
                entry.error = true;
            };
            entry.image.src = url;
            tileImageCache.set(key, entry);
        }
        return entry.loaded ? entry.image : null;
    }

    if (editorViewport && typeof editorViewport.setImageGetter === 'function') {
        editorViewport.setImageGetter(getAuthoringImage);
    }

    function renderLoop() {
        if (canvasDirty) {
            flushEditorComposite();
            canvasDirty = false;
        }
        requestAnimationFrame(renderLoop);
    }
    requestAnimationFrame(renderLoop);

    function markDirty() {
        canvasDirty = true;
        if (editorViewport) editorViewport.markDirty('view');
        scheduleMinimap();
    }

    function currentZoomPct() {
        return Math.max(100, Math.round(zoomValue * 100));
    }

    function isTypingTarget(el) {
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }

    /**
     * Resolve a Font Awesome solid glyph so canvas fillText can paint it.
     * @param {string} iconClass e.g. fa-stairs
     * @returns {string}
     */
    function faGlyphFromClass(iconClass) {
        if (!iconClass || typeof document === 'undefined') return '';
        const i = document.createElement('i');
        i.className = 'fa-solid ' + iconClass;
        i.style.cssText = 'position:absolute;left:-9999px;visibility:hidden;pointer-events:none;';
        document.body.appendChild(i);
        const content = window.getComputedStyle(i, '::before').getPropertyValue('content');
        document.body.removeChild(i);
        if (!content || content === 'none' || content === 'normal') return '';
        return content.replace(/['"]/g, '');
    }

    /**
     * Hex color → FA glyph, keyed the same way as flagsPreviewColor.
     * @param {boolean} [force]
     */
    function ensureFlagIconUnicodes(force) {
        if (window.flagIconUnicodes && !force) return window.flagIconUnicodes;
        const map = Object.create(null);
        const entries = (HdlTM && typeof HdlTM.flagPaletteEntries === 'function')
            ? HdlTM.flagPaletteEntries()
            : [];
        for (const f of entries) {
            if (!f || !f.icon || !f.color || f.color === '#000000') continue;
            const glyph = faGlyphFromClass(f.icon);
            if (glyph) map[f.color] = glyph;
        }
        window.flagIconUnicodes = map;
        return map;
    }

    function flagsIconsActive(z) {
        const min = editorViewport ? editorViewport.spriteZoomMin : 8;
        if (HdlTM && typeof HdlTM.shouldShowTileSprites === 'function') {
            return HdlTM.shouldShowTileSprites(z, min);
        }
        if (min == null || min === false) return false;
        const m = +min;
        if (!Number.isFinite(m)) return false;
        if (!(z > 0)) return false;
        if (m <= 0) return true;
        return z >= m;
    }

    ensureFlagIconUnicodes();
    if (document.fonts) {
        const ready = document.fonts.ready
            ? document.fonts.ready
            : Promise.resolve();
        const loadFa = document.fonts.load
            ? document.fonts.load('900 16px "Font Awesome 6 Free"')
            : Promise.resolve();
        Promise.all([ready, loadFa]).then(() => {
            ensureFlagIconUnicodes(true);
            markDirty();
        }).catch(() => {});
    }

    /**
     * Rebuild map-space world buffer (if needed), blit to viewport display, draw overlays.
     * @param {{ x0: number, y0: number, x1: number, y1: number }|null} [rect]
     */
    function flushEditorComposite(rect) {
        if (!editorCanvas || !ctx) return;
        const cols = mapPixelWidth();
        const rows = mapPixelHeight();
        if (!cols || !rows) return;

        // Viewport-sized display
        const parent = viewportArea || editorCanvas.parentElement;
        const pr = parent.getBoundingClientRect();
        const vw = Math.max(1, Math.floor(pr.width));
        const vh = Math.max(1, Math.floor(pr.height));
        if (editorCanvas.width !== vw || editorCanvas.height !== vh) {
            editorCanvas.width = vw;
            editorCanvas.height = vh;
        }

        ensureWorldCanvas(cols, rows);
        const wctx = worldCanvas.getContext('2d', { willReadFrequently: true });
        const sl = imageContainer.scrollLeft;
        const st = imageContainer.scrollTop;

        if (editorViewport) {
            editorViewport.setMapSize(cols, rows);
            editorViewport.setZoom(zoomValue);
            editorViewport.setScroll(sl, st);
            if (tilemapSession) editorViewport.setSession(tilemapSession);

            // Session path: world buffer is a pure composite of session/base.
            // Spawns-only / no-session: worldCanvas is truth (PNG bootstrap + direct paint).
            // IMPORTANT: paint strokes must composite only the dirty rect — floor-07 is
            // 2560×2048; full re-composite per pen cell pegs the CPU even with one floor.
            const d = editorViewport.dirty;
            const partial =
                rect ||
                (typeof editorViewport.takeWorldDirtyRect === 'function'
                    ? editorViewport.takeWorldDirtyRect()
                    : null);
            const needWorld =
                !!tilemapSession &&
                (d.full || d.terrain || d.props || d.debug || partial != null);
            if (needWorld) {
                // d.full or no partial → full map; otherwise patch the brush AABB only.
                const paintRect = d.full ? null : partial;
                editorViewport.compositeMap(wctx, { rect: paintRect });
            }
            editorViewport.clearDirty();
            editorViewport.present(ctx, worldCanvas, {
                viewWidth: vw,
                viewHeight: vh,
                scrollLeft: sl,
                scrollTop: st,
                zoom: zoomValue,
                overlay: (dctx, info) => drawDisplayOverlay(dctx, info)
            });
        } else {
            ctx.clearRect(0, 0, vw, vh);
            const z = zoomValue > 0 ? zoomValue : 1;
            const mapX = sl / z;
            const mapY = st / z;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(worldCanvas, mapX, mapY, vw / z, vh / z, 0, 0, vw, vh);
            drawDisplayOverlay(ctx, {
                zoom: z,
                scrollLeft: sl,
                scrollTop: st,
                viewWidth: vw,
                viewHeight: vh
            });
        }
        updateScrollSizer();
    }

    /**
     * After session paint: invalidate viewport and schedule composite.
     * Coalesces to rAF so freehand strokes do one dirty-rect composite per frame
     * (not one full-map rebuild per mouse event).
     * @param {{ x0: number, y0: number, x1: number, y1: number }|null} [rect]
     * @param {string[]} [layers]
     */
    function syncViewFromSession(rect, layers) {
        if (editorViewport) {
            editorViewport.notifySessionPaint(rect, layers);
            if (tilemapSession) editorViewport.setSession(tilemapSession);
        }
        markDirty();
    }

    function resizeCanvas() {
        markDirty();
    }
    const resizeObserver = new ResizeObserver(resizeCanvas);
    if (viewportArea) resizeObserver.observe(viewportArea);
    imageContainer.addEventListener('scroll', markDirty);
    const monsterNameInput = document.getElementById('monster-name');
    const monsterResults = document.getElementById('monster-results');
    const mouseZoom = document.getElementById('mouseZoom');

    let monsterModal = null;
    const modalEl = document.getElementById('monsterModal');
    if (modalEl) {
        monsterModal = new bootstrap.Modal(modalEl);
    }
    const monsterModalBody = document.getElementById('monsterModalBody');
    const monsterModalTitle = document.querySelector('#monsterModal .modal-title');

    let currentFloor = '07';
    let currentLayer = null;
    let mapPalette = [];
    let selectedPaletteItem = null;
    let selectedMapSpawn = null;
    let selectedMapSpawns = [];
    let selectedStairPad = null;
    let pickStairDest = false;
    let pendingStairDests = [];
    let selectionRect = null;
    let isSelecting = false;
    let wasDragging = false;
    let wasDraggingPan = false;
    let zoomValue = 1;
    let currentTool = 'select';
    let layerVisibility = {};
    let hasUnsavedChanges = false;
    let viewOnlyNpcs = false;
    let viewOnlyModified = false;
    let showMapCenter = false;
    let spawnClipboard = null;
    let lastMapTile = { x: 1129, y: 767 };
    let gotoSearchKey = '';
    let gotoSearchHits = [];
    let gotoSearchIndex = 0;
    let lastFindKind = '';
    let minimapRaf = 0;

    function setDirty(isDirty) {
        hasUnsavedChanges = isDirty;
        markDirty();
        const baseTitle = 'Wiki · Legacy Map — Hunt Design Lab';
        const btnSaveMap = document.getElementById('btnSaveMap');
        if (isDirty) {
            document.title = '*' + baseTitle;
            if (btnSaveMap) {
                btnSaveMap.classList.remove('btn-outline-success');
                btnSaveMap.classList.add('btn-success');
            }
            document.getElementById('statusBar').textContent = 'Unsaved changes';
        } else {
            document.title = baseTitle;
            if (btnSaveMap) {
                btnSaveMap.classList.remove('btn-success');
                btnSaveMap.classList.add('btn-outline-success');
            }
            document.getElementById('statusBar').textContent = 'All changes saved';
        }
    }

    for (let i = 0; i <= 15; i++) {
        let f = String(i).padStart(2, '0');
        layerVisibility[`floor-${f}`] = true;
        layerVisibility[`floor-${f}-friction`] = true;
        layerVisibility[`floor-${f}-sight`] = true;
        layerVisibility[`floor-${f}-flags`] = true;
        layerVisibility[`floor-${f}-fields`] = true;
        layerVisibility[`floor-${f}-tilemap`] = true;
        layerVisibility[`floor-${f}-spawns`] = true;
        layerVisibility[`floor-${f}-world`] = true;
        TILEMAP_SUBS.forEach((sub) => {
            layerVisibility[`floor-${f}-tilemap-${sub}`] = true;
        });
    }

    function isTileMapLayer(layer) {
        return layer === 'tilemap' || (typeof layer === 'string' && layer.startsWith('tilemap:'));
    }

    function isWorldLayer(layer) {
        return layer === 'world';
    }

    function isSpawnLayer(layer) {
        return layer === 'spawns';
    }

    function isOverlayPinLayer(layer) {
        return layer === 'spawns' || layer === 'world';
    }

    function tileMapSubFromLayer(layer) {
        if (layer === 'tilemap') return null;
        if (typeof layer === 'string' && layer.startsWith('tilemap:')) {
            return layer.slice('tilemap:'.length);
        }
        return null;
    }

    function hexToRgb(hex) {
        const h = String(hex || '').replace('#', '');
        if (h.length !== 6) return { r: 0, g: 0, b: 0 };
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16)
        };
    }

    /** Cache hex → rgba for flag preview colors (avoid per-cell string parse). */
    const flagRgbaCache = Object.create(null);
    const rolePreviewRgbaCache = Object.create(null);

    function hexToRgbaCached(hex, alpha, cache) {
        const key = hex + '|' + alpha;
        let c = cache[key];
        if (c) return c;
        const rgb = hexToRgb(hex);
        c = { r: rgb.r, g: rgb.g, b: rgb.b, a: alpha };
        cache[key] = c;
        return c;
    }

    /**
     * Session → single display canvas (Phase 8). Replaces multi-canvas putImageData sync.
     * @param {{ x0: number, y0: number, x1: number, y1: number }|null} [rect]
     * @param {{ layers?: string[] }} [opts]
     */
    function syncCanvasesFromSession(rect, opts) {
        const layers = (opts && opts.layers) || ['friction', 'sight', 'flags', 'fields', 'tilemap'];
        if (tilemapSession && editorViewport) {
            editorViewport.setSession(tilemapSession);
            editorViewport.setMapSize(tilemapSession.cols, tilemapSession.rows);
        }
        syncViewFromSession(rect || null, layers);
    }

    /** Ensure display canvas matches floor size. */
    function ensureTilemapCanvasSize() {
        if (!tilemapSession || !editorCanvas) return;
        const cols = tilemapSession.cols;
        const rows = tilemapSession.rows;
        if (editorCanvas.width !== cols || editorCanvas.height !== rows) {
            editorCanvas.width = cols;
            editorCanvas.height = rows;
        }
        if (editorViewport) editorViewport.setMapSize(cols, rows);
    }

    /**
     * Decode base path RGBA / optional side-channel images → seed session (legacy bootstrap).
     * @param {{
     *   cols: number,
     *   rows: number,
     *   frictionRgba: Uint8ClampedArray|Uint8Array,
     *   sightRgba?: Uint8ClampedArray|Uint8Array|null,
     *   flagsRgba?: Uint8ClampedArray|Uint8Array|null,
     *   fieldsRgba?: Uint8ClampedArray|Uint8Array|null
     * }} pack
     */
    function bootstrapSessionFromChannelRgba(pack) {
        if (!HdlTM || !pack || !pack.cols || !pack.rows || !pack.frictionRgba) return;
        const cols = pack.cols | 0;
        const rows = pack.rows | 0;
        let friction, sight, flags, fields;
        if (typeof HdlTM.decodeFrictionRgbaToChannels === 'function') {
            const ch = HdlTM.decodeFrictionRgbaToChannels(pack.frictionRgba, cols, rows, {
                noCastBit: HdlTM.TILE_FLAG_NO_CAST || 1
            });
            friction = ch.friction;
            sight = ch.sight;
            flags = ch.flags;
            fields = ch.fields;
        } else {
            const n = cols * rows;
            friction = new Uint8Array(n);
            sight = new Uint8Array(n);
            flags = new Uint8Array(n);
            fields = new Uint8Array(n);
        }
        const mergeLayer = (key, rgba) => {
            if (!rgba) return;
            const n = cols * rows;
            for (let i = 0; i < n; i++) {
                const p = i * 4;
                const r = rgba[p],
                    g = rgba[p + 1],
                    b = rgba[p + 2],
                    a = rgba[p + 3];
                if (key === 'sight' && a > 0) {
                    sight[i] = r;
                } else if (key === 'flags' && a > 0 && (r || g || b)) {
                    if (r === 0 && g === 255 && b === 0) {
                        flags[i] = HdlTM.TILE_FLAG_PZ_PACKAGE || 65;
                    } else if (HdlTM.flagPaletteEntries) {
                        const hex = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
                        const ent = HdlTM.flagPaletteEntries().find((e) => e.color === hex);
                        if (ent) flags[i] = ent.bits & 0xff;
                    }
                } else if (key === 'fields' && a > 0) {
                    if (r > 200 && g > 100 && b < 50) fields[i] = 1;
                    else if (g > 150 && r < 80) fields[i] = 2;
                    else if (b > 150 && r > 100) fields[i] = 4;
                }
            }
        };
        mergeLayer('sight', pack.sightRgba);
        mergeLayer('flags', pack.flagsRgba);
        mergeLayer('fields', pack.fieldsRgba);

        if (!tilemapSession) {
            tilemapSession = HdlTM.createEditorSession({
                cols,
                rows,
                z: parseInt(currentFloor, 10) || 0,
                roleCatalog: tilemapRoleCatalog,
                artSet: window.__tilemapArtSet || null
            });
        }
        tilemapSession.bootstrapFromChannels({
            cols,
            rows,
            friction,
            sight,
            flags,
            fields,
            z: parseInt(currentFloor, 10) || 0
        });
        if (window.__tilemapArtSet) {
            tilemapSession.setArtSet(window.__tilemapArtSet, tilemapRoleCatalog);
        }
        if (editorViewport) {
            editorViewport.setSession(tilemapSession);
            editorViewport.setMapSize(cols, rows);
            editorViewport.setBaseRgba(pack.frictionRgba, cols, rows);
        }
        ensureTilemapCanvasSize();
        syncViewFromSession(null, ['friction', 'sight', 'flags', 'fields', 'tilemap']);
    }

    /**
     * Decode friction/base display → seed session (legacy bootstrap when no hybrid).
     */
    function bootstrapSessionFromFrictionCanvas() {
        if (!HdlTM || !editorCanvas || !editorCanvas.width) return;
        // Prefer viewport base RGBA (path PNG); else read display canvas.
        let rgba = null;
        let cols = editorCanvas.width;
        let rows = editorCanvas.height;
        if (editorViewport && editorViewport.baseRgba && editorViewport.baseRgba.data) {
            rgba = editorViewport.baseRgba.data;
            cols = editorViewport.baseRgba.width;
            rows = editorViewport.baseRgba.height;
        } else {
            const ectx = editorCanvas.getContext('2d', { willReadFrequently: true });
            rgba = ectx.getImageData(0, 0, cols, rows).data;
        }
        // Side-channel PNGs loaded into window.__pngChannelRgba if present
        const side = window.__pngChannelRgba || {};
        bootstrapSessionFromChannelRgba({
            cols,
            rows,
            frictionRgba: rgba,
            sightRgba: side.sight || null,
            flagsRgba: side.flags || null,
            fieldsRgba: side.fields || null
        });
    }

    /**
     * Normalize a fetched hybrid blob to on-disk gzip bytes.
     * Some servers set Content-Encoding for *.gz and the browser already gunzips;
     * re-wrap so deserializeHybridPack (strict gzip) still works.
     * @param {Uint8Array} u8
     * @param {string} rel
     * @returns {Uint8Array}
     */
    function ensureHybridGzipBytes(u8, rel) {
        if (u8 && u8.byteLength >= 2 && u8[0] === 0x1f && u8[1] === 0x8b) {
            return u8;
        }
        if (HdlTM && typeof HdlTM.gzipBytes === 'function') {
            console.warn('hybrid blob was not gzip on the wire; re-wrapping', rel);
            return HdlTM.gzipBytes(u8);
        }
        throw new Error('Hybrid blob is not gzip and gzipBytes unavailable: ' + rel);
    }

    /**
     * @param {{ preferHybridOnly?: boolean }} [opts]
     *   preferHybridOnly — load hybrid if present; do not PNG-bootstrap
     *   (kept for callers that only want an existing pack).
     */
    async function ensureTilemapSession(opts) {
        const preferHybridOnly = !!(opts && opts.preferHybridOnly);
        if (!HdlTM) {
            console.warn('HdlTileMapEditor bundle missing');
            return null;
        }
        if (tilemapSession && tilemapSession.cols > 0) {
            applyPendingStairDests();
            return tilemapSession;
        }

        const gen = mapLoadGen;
        if (sessionLoadPromise && sessionLoadGen === gen) {
            return sessionLoadPromise;
        }

        sessionLoadGen = gen;
        sessionLoadPromise = (async () => {
            // Hybrid pack is source of truth when present (overrides path PNG canvases).
            try {
                const res = await fetch(
                    window.__API_URL__ +
                        '?action=legacy_map_load_hybrid&floor=' +
                        encodeURIComponent(padFloor(currentFloor))
                );
                if (gen !== mapLoadGen) return null;
                if (res.ok) {
                    const body = await res.json();
                    const data = body.data || body;
                    if (data && data.present && data.meta) {
                        const blobs = {};
                        // Prefer asset binary fetch; fall back to embedded base64 (small packs)
                        const paths = Array.isArray(data.blobPaths) ? data.blobPaths : Object.keys(data.blobsBase64 || {});
                        if (data.dir && paths.length) {
                            await Promise.all(
                                paths.map(async (rel) => {
                                    const url = ASSET_ROOT + data.dir + '/' + rel + '?v=' + Date.now();
                                    const br = await fetch(url, { cache: 'no-store' });
                                    if (!br.ok) throw new Error('Failed to fetch hybrid blob ' + rel + ' (' + br.status + ')');
                                    const raw = new Uint8Array(await br.arrayBuffer());
                                    blobs[rel] = ensureHybridGzipBytes(raw, rel);
                                })
                            );
                        } else if (data.blobsBase64) {
                            Object.assign(blobs, data.blobsBase64);
                        }
                        if (gen !== mapLoadGen) return null;
                        tilemapSession = HdlTM.createEditorSession({
                            cols: 32,
                            rows: 32,
                            z: parseInt(currentFloor, 10) || 0,
                            roleCatalog: tilemapRoleCatalog
                        });
                        tilemapSession.loadHybridTransport(data.meta, blobs);
                        if (window.__tilemapArtSet) {
                            tilemapSession.setArtSet(window.__tilemapArtSet, tilemapRoleCatalog);
                        }
                        if (editorViewport) {
                            editorViewport.clearBaseRgba();
                            editorViewport.setSession(tilemapSession);
                            editorViewport.setMapSize(tilemapSession.cols, tilemapSession.rows);
                        }
                        ensureTilemapCanvasSize();
                        setZoom(zoomValue);
                        syncCanvasesFromSession(null, {
                            layers: ['friction', 'sight', 'flags', 'fields', 'tilemap']
                        });
                        return tilemapSession;
                    }
                }
            } catch (e) {
                console.warn('hybrid load failed', e);
                if (gen !== mapLoadGen) return null;
                tilemapSession = null;
            }

            if (preferHybridOnly) {
                return null;
            }

            if (gen !== mapLoadGen) return null;
            if (!canBootstrapFromPng()) {
                return null;
            }
            bootstrapSessionFromFrictionCanvas();
            return tilemapSession;
        })();

        try {
            const sess = await sessionLoadPromise;
            applyPendingStairDests();
            return sess;
        } finally {
            if (sessionLoadGen === gen) sessionLoadPromise = null;
        }
    }

    async function loadTilemapPresets() {
        if (!HdlTM) return;
        try {
            // Load tile roles from presets (list via mode files)
            const roleIds = [
                'floor', 'path', 'wall', 'water', 'void', 'protection', 'grate',
                'scenery_blocking', 'scenery_cover', 'furniture_blocking',
                'stairs_up', 'stairs_down', 'hole', 'rope_spot', 'shovel_spot'
            ];
            const roles = [];
            await Promise.all(roleIds.map(async (id) => {
                try {
                    const r = await fetch(ASSET_ROOT + 'presets/standard/tile_roles/' + id + '.json', { cache: 'no-store' });
                    if (r.ok) roles.push(await r.json());
                } catch (_e) { /* skip */ }
            }));
            tilemapRoleCatalog = HdlTM.indexTileRoles(roles);
            if (editorViewport && typeof editorViewport.setRoleCatalog === 'function') {
                editorViewport.setRoleCatalog(tilemapRoleCatalog);
            }

            const artRes = await fetch(ASSET_ROOT + 'presets/standard/art_sets/' + tilemapArtSetId + '.json');
            if (artRes.ok) {
                const art = await artRes.json();
                if (art.genre) tilemapArtGenre = String(art.genre);
                window.__tilemapArtSet = art;
                if (tilemapSession) {
                    tilemapSession.setRoleCatalog(tilemapRoleCatalog);
                    tilemapSession.setArtSet(art, tilemapRoleCatalog);
                }
                if (editorViewport) {
                    editorViewport.markDirty(['props', 'terrain', 'full']);
                    markDirty();
                }
            }
        } catch (e) {
            console.warn('tilemap presets', e);
        }
    }
    let mapSpawnsCache = {};
    let currentMapSpawns = [];
    let mapWorldCache = {};
    let currentMapWorld = [];
    let worldCatalog = {};
    let worldPalette = [];
    let selectedWorldPalette = null;
    let selectedWorldPin = null;
    let selectedWorldPins = [];
    let worldClipboard = null;
    let selectedWorldKind = 'container';
    /** Full official creature JSON, keyed by id (`presets/standard/creatures/<id>.json`). */
    let creatureJsonCache = {};
    /** Art lookup: creatureId → { customSprite, customSpriteGenre, … } */
    let standardPresets = {};

    // bounds.json is only for world↔local when needed (URL world-coords heuristic).
    // Path PNG / hybrid pins / by_floor fallback / engine all use map-local tiles.
    let bounds = { xMin: 31744, yMin: 30976, width: 2560, height: 2048 };

    let viewPortX = 0;
    let viewPortY = 0;
    let viewPortWidth = 0;
    let viewPortHeight = 0;

    let undoStack = [];
    let redoStack = [];

    function saveState() {
        // TileMap session owns its undo stack for tilemap + channel overrides
        if (isTileMapLayer(currentLayer) || (tilemapSession && ['friction', 'sight', 'flags', 'fields'].includes(currentLayer))) {
            // no-op for image undo; session handles TileMap; channel paint pushes session undo
            updateUndoRedoUI();
            setDirty(true);
            return;
        }
        let state = { floor: currentFloor, layer: currentLayer };
        if (currentLayer === 'spawns') {
            state.spawns = JSON.parse(JSON.stringify(currentMapSpawns));
        } else if (currentLayer === 'world') {
            state.world = JSON.parse(JSON.stringify(currentMapWorld));
        } else if (['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) {
            ensureWorldCanvas(mapPixelWidth(), mapPixelHeight());
            const wctx = worldCanvas.getContext('2d', { willReadFrequently: true });
            state.imageData = wctx.getImageData(0, 0, worldCanvas.width, worldCanvas.height);
        }
        undoStack.push(state);
        redoStack = [];
        updateUndoRedoUI();
        setDirty(true);
    }

    function restoreState(state) {
        if (state.layer === 'spawns') {
            mapSpawnsCache[state.floor] = JSON.parse(JSON.stringify(state.spawns));
            currentMapSpawns = mapSpawnsCache[state.floor];
            selectedMapSpawn = null;
            selectedMapSpawns = [];
            renderSpawns();
            updateFloorCounts();
            renderSpawnProperties();
        } else if (state.layer === 'world') {
            mapWorldCache[state.floor] = JSON.parse(JSON.stringify(state.world));
            currentMapWorld = mapWorldCache[state.floor];
            selectedWorldPin = null;
            selectedWorldPins = [];
            renderSpawns();
            updateFloorCounts();
            renderWorldProperties();
        } else if (state.imageData) {
            ensureWorldCanvas(state.imageData.width, state.imageData.height);
            const wctx = worldCanvas.getContext('2d', { willReadFrequently: true });
            wctx.putImageData(state.imageData, 0, 0);
            setDirty(true);
            markDirty();
        }
    }

    function undo() {
        if (tilemapSession && (isTileMapLayer(currentLayer) || tilemapSession.canUndo)) {
            if (tilemapSession.undo()) {
                // Undo can touch any channel; dirty rect unknown → staggered full sync
                syncCanvasesFromSession(null, {
                    layers: ['friction', 'sight', 'flags', 'fields', 'tilemap']
                });
                updateUndoRedoUI();
                setDirty(true);
                return;
            }
        }
        if (undoStack.length === 0) return;
        let currentState = { floor: currentFloor, layer: currentLayer };
        if (currentLayer === 'spawns') {
            currentState.spawns = JSON.parse(JSON.stringify(currentMapSpawns));
        } else if (currentLayer === 'world') {
            currentState.world = JSON.parse(JSON.stringify(currentMapWorld));
        } else if (['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) {
            ensureWorldCanvas(mapPixelWidth(), mapPixelHeight());
            const wctx = worldCanvas.getContext('2d', { willReadFrequently: true });
            currentState.imageData = wctx.getImageData(0, 0, worldCanvas.width, worldCanvas.height);
        }
        redoStack.push(currentState);
        
        const state = undoStack.pop();
        if (state.floor !== currentFloor || state.layer !== currentLayer) {
            selectFloorAndLayer(state.floor, state.layer, () => restoreState(state));
        } else {
            restoreState(state);
        }
        updateUndoRedoUI();
        setDirty(true);
    }

    function redo() {
        if (tilemapSession && (isTileMapLayer(currentLayer) || tilemapSession.canRedo)) {
            if (tilemapSession.redo()) {
                syncCanvasesFromSession(null, {
                    layers: ['friction', 'sight', 'flags', 'fields', 'tilemap']
                });
                updateUndoRedoUI();
                setDirty(true);
                return;
            }
        }
        if (redoStack.length === 0) return;
        let currentState = { floor: currentFloor, layer: currentLayer };
        if (currentLayer === 'spawns') {
            currentState.spawns = JSON.parse(JSON.stringify(currentMapSpawns));
        } else if (currentLayer === 'world') {
            currentState.world = JSON.parse(JSON.stringify(currentMapWorld));
        } else if (['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) {
            ensureWorldCanvas(mapPixelWidth(), mapPixelHeight());
            const wctx = worldCanvas.getContext('2d', { willReadFrequently: true });
            currentState.imageData = wctx.getImageData(0, 0, worldCanvas.width, worldCanvas.height);
        }
        undoStack.push(currentState);
        
        const state = redoStack.pop();
        if (state.floor !== currentFloor || state.layer !== currentLayer) {
            selectFloorAndLayer(state.floor, state.layer, () => restoreState(state));
        } else {
            restoreState(state);
        }
        updateUndoRedoUI();
        setDirty(true);
    }

    function updateUndoRedoUI() {
        const btnUndo = document.getElementById('btnUndo');
        const btnRedo = document.getElementById('btnRedo');
        const canU = undoStack.length > 0 || !!(tilemapSession && tilemapSession.canUndo);
        const canR = redoStack.length > 0 || !!(tilemapSession && tilemapSession.canRedo);
        if (btnUndo) btnUndo.disabled = !canU;
        if (btnRedo) btnRedo.disabled = !canR;
    }

    const btnUndo = document.getElementById('btnUndo');
    const btnRedo = document.getElementById('btnRedo');
    if (btnUndo) btnUndo.addEventListener('click', undo);
    if (btnRedo) btnRedo.addEventListener('click', redo);

    window.showGrid = false;
    const btnToggleGrid = document.getElementById('btnToggleGrid');
    if (btnToggleGrid) {
        btnToggleGrid.addEventListener('click', () => {
            window.showGrid = !window.showGrid;
            if (window.showGrid) {
                btnToggleGrid.classList.remove('btn-outline-secondary');
                btnToggleGrid.classList.add('btn-primary');
            } else {
                btnToggleGrid.classList.add('btn-outline-secondary');
                btnToggleGrid.classList.remove('btn-primary');
            }
            renderSpawns();
        });
    }

    document.querySelectorAll('.brush-size').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.brush-size').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            window.currentBrushSize = parseInt(btn.dataset.size, 10);
            const drop = document.getElementById('brushSizeDropdown');
            if (drop) {
                drop.innerHTML = '<i class="fa-solid fa-maximize"></i> ' + btn.textContent;
            }
        });
    });

    window.currentBrushShape = 'square';
    document.querySelectorAll('.brush-shape').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.brush-shape').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            window.currentBrushShape = btn.dataset.shape;
            const drop = document.getElementById('brushShapeDropdown');
            if (drop) {
                drop.innerHTML = '<i class="fa-solid fa-paint-brush"></i> ' + btn.textContent;
            }
        });
    });

    function padFloor(z) {
        return String(z).padStart(2, '0');
    }

    /** Title_Case stem for assets/sprites/.../creatures/small/<stem>.png */
    function spriteStem(artId) {
        return String(artId || '')
            .trim()
            .replace(/\.png$/i, '')
            .split(/[\s_]+/)
            .filter(Boolean)
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase())
            .join('_');
    }

    /**
     * Normalize deep-link / zoom targets to map-local tiles.
     * Pin rows are ALWAYS local (engine contract) — never run this on them.
     * Old wiki bookmarks used world OTBM coords (e.g. 32873,31743); map-spawn.js
     * and the fixed wiki use local (e.g. 1129,767). Detect world by range.
     */
    function deepLinkToLocal(x, y) {
        const nx = Number(x);
        const ny = Number(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
            return { x: 0, y: 0 };
        }
        const w = bounds.width || 2560;
        const h = bounds.height || 2048;
        // World OTBM coords (~31k) dwarf the PNG canvas; local fit ~0..width/height.
        if (nx > w * 2 || ny > h * 2) {
            return { x: nx - bounds.xMin, y: ny - bounds.yMin };
        }
        return { x: nx, y: ny };
    }

    function resolveCreatureId(raw) {
        if (HdlTM && typeof HdlTM.resolveCreatureSpawnId === 'function') {
            return HdlTM.resolveCreatureSpawnId(raw, standardPresets);
        }
        return String(raw || '')
            .trim()
            .toLowerCase()
            .replace(/['’]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .replace(/_+/g, '_') || 'unknown';
    }

    function paletteItemId(item) {
        if (!item) return '';
        return item.id || resolveCreatureId(item.name);
    }

    function resolvePaletteItem(val) {
        const id = resolveCreatureId(val);
        const std = standardPresets[id];
        return { id, name: (std && std.label) || id };
    }

    function defaultSpawnRespawn() {
        if (HdlTM && HdlTM.DEFAULT_EDITOR_SPAWN_RESPAWN != null) {
            return HdlTM.DEFAULT_EDITOR_SPAWN_RESPAWN;
        }
        return 60;
    }

    /**
     * Confirm moving a pin to another floor file (saves both lists).
     * Falls back to window.confirm if Bootstrap is unavailable.
     * @param {string} message
     * @returns {Promise<boolean>}
     */
    function confirmSpawnFloorMove(message) {
        const el = document.getElementById('spawnFloorMoveModal');
        const body = document.getElementById('spawnFloorMoveModalBody');
        const okBtn = document.getElementById('spawnFloorMoveModalOk');
        if (!el || !body || !okBtn || typeof bootstrap === 'undefined' || !bootstrap.Modal) {
            return Promise.resolve(window.confirm(message));
        }
        return new Promise((resolve) => {
            body.textContent = message;
            const modal = bootstrap.Modal.getOrCreateInstance(el);
            let settled = false;
            function finish(ok) {
                if (settled) return;
                settled = true;
                okBtn.removeEventListener('click', onOk);
                el.removeEventListener('hidden.bs.modal', onHide);
                resolve(ok);
            }
            function onOk() {
                finish(true);
                modal.hide();
            }
            function onHide() {
                finish(false);
            }
            okBtn.addEventListener('click', onOk);
            el.addEventListener('hidden.bs.modal', onHide);
            modal.show();
        });
    }

    function planFloorMove(fromZ, toZ) {
        if (HdlTM && typeof HdlTM.planSpawnFloorMove === 'function') {
            return HdlTM.planSpawnFloorMove(fromZ, toZ);
        }
        const from = Math.round(Number(fromZ));
        const to = Math.round(Number(toZ));
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > 15 || to < 0 || to > 15) {
            return { ok: false, reason: 'invalid' };
        }
        if (from === to) return { ok: false, reason: 'same' };
        return { ok: true, fromZ: from, toZ: to };
    }

    function applyFloorMove(fromList, destList, pin, destZ) {
        if (HdlTM && typeof HdlTM.applySpawnFloorMove === 'function') {
            return HdlTM.applySpawnFloorMove(fromList, destList, pin, destZ);
        }
        const from = Array.isArray(fromList) ? fromList.slice() : [];
        const dest = Array.isArray(destList) ? destList.slice() : [];
        const idx = from.indexOf(pin);
        if (idx < 0) return null;
        from.splice(idx, 1);
        const moved = Object.assign({}, pin, { z: destZ });
        dest.push(moved);
        return { fromList: from, destList: dest, moved };
    }

    async function ensureFloorSpawnsLoaded(floor) {
        const id = padFloor(floor);
        if (!mapSpawnsCache[id] || !mapWorldCache[id]) {
            try {
                const docs = await fetchFloorPinDocs(id);
                if (!mapSpawnsCache[id]) mapSpawnsCache[id] = docs.spawns;
                if (!mapWorldCache[id]) mapWorldCache[id] = docs.world;
            } catch (e) {
                console.error(e);
                if (!mapSpawnsCache[id]) mapSpawnsCache[id] = [];
                if (!mapWorldCache[id]) mapWorldCache[id] = [];
            }
        }
        return mapSpawnsCache[id];
    }

    /**
     * Move pin to dest floor SoT, save both files, stay on the current floor.
     * @param {object} spawn
     * @param {{ x: number, y: number, z: number, respawn: number }} fields
     */
    async function moveSpawnToFloor(spawn, fields) {
        const fromFloor = currentFloor;
        const destFloor = padFloor(fields.z);
        const statusBar = document.getElementById('statusBar');
        const fromSnap = JSON.parse(JSON.stringify(mapSpawnsCache[fromFloor] || currentMapSpawns || []));
        await ensureFloorSpawnsLoaded(destFloor);
        const destSnap = JSON.parse(JSON.stringify(mapSpawnsCache[destFloor] || []));

        spawn.x = fields.x;
        spawn.y = fields.y;
        spawn.z = fields.z;
        spawn.respawn = fields.respawn;
        if (spawn.creatureId) {
            spawn.creatureId = resolveCreatureId(spawn.creatureId);
        }

        const result = applyFloorMove(
            mapSpawnsCache[fromFloor] || currentMapSpawns,
            mapSpawnsCache[destFloor] || [],
            spawn,
            fields.z
        );
        if (!result) {
            alert('Could not move spawn — pin not found on this floor');
            return;
        }

        mapSpawnsCache[fromFloor] = result.fromList;
        mapSpawnsCache[destFloor] = result.destList;
        currentMapSpawns = result.fromList;
        selectedMapSpawns = selectedMapSpawns.filter((s) => s !== spawn);
        if (selectedMapSpawn === spawn) {
            selectedMapSpawn = selectedMapSpawns.length > 0 ? selectedMapSpawns[0] : null;
        }
        renderSpawns();
        updateFloorCounts();
        renderSpawnProperties();

        try {
            if (statusBar) statusBar.textContent = 'Saving floors ' + fromFloor + ' and ' + destFloor + '…';
            await saveFloorSpawns(destFloor);
            await saveFloorSpawns(fromFloor);
            setDirty(false);
            if (statusBar) {
                statusBar.textContent = 'Moved spawn to floor ' + destFloor + ' and saved both floors';
            }
        } catch (e) {
            console.error(e);
            mapSpawnsCache[fromFloor] = fromSnap;
            mapSpawnsCache[destFloor] = destSnap;
            currentMapSpawns = mapSpawnsCache[fromFloor];
            selectedMapSpawns = [];
            selectedMapSpawn = null;
            renderSpawns();
            updateFloorCounts();
            renderSpawnProperties();
            alert('Error saving floor move: ' + e.message);
            if (statusBar) statusBar.textContent = 'Error saving floor move';
        }
    }

    function makeNewSpawnPin(x, y, rawId) {
        if (HdlTM && typeof HdlTM.makeEditorSpawnPin === 'function') {
            return HdlTM.makeEditorSpawnPin(
                { creatureId: rawId, x, y },
                standardPresets,
                { z: parseInt(currentFloor, 10) || 0 }
            );
        }
        return {
            creatureId: resolveCreatureId(rawId),
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
            z: parseInt(currentFloor, 10) || 0,
            respawn: defaultSpawnRespawn()
        };
    }

    function spawnDisplayName(spawn) {
        const id = spawn && spawn.creatureId;
        const std = id ? standardPresets[id] : null;
        if (std && std.label) return String(std.label).toLowerCase();
        return String((spawn && (spawn.legacyName || spawn.creatureId)) || '').toLowerCase();
    }

    function matchesFilter(spawn, filterText) {
        if (HdlTM && typeof HdlTM.filterEditorSpawns === 'function') {
            return HdlTM.filterEditorSpawns([spawn], {
                query: filterText,
                onlyNpcs: viewOnlyNpcs,
                onlyModified: viewOnlyModified,
                presets: standardPresets
            }).length > 0;
        }
        if (viewOnlyNpcs || viewOnlyModified) return false;
        if (!filterText) return true;
        const q = filterText.toLowerCase();
        const id = String((spawn && spawn.creatureId) || '').toLowerCase();
        return spawnDisplayName(spawn).indexOf(q) !== -1 || id.indexOf(q) !== -1;
    }

    // --- Data loads ----------------------------------------------------------

    fetch(ASSET_ROOT + 'assets/legacy/map/bounds.json')
        .then((res) => res.json())
        .then((data) => {
            if (data && typeof data === 'object') {
                bounds = {
                    xMin: Number(data.xMin) || bounds.xMin,
                    yMin: Number(data.yMin) || bounds.yMin,
                    width: Number(data.width) || bounds.width,
                    height: Number(data.height) || bounds.height
                };
            }
        })
        .catch(() => { /* keep defaults */ });

    function fillMonsterDatalist() {
        const dl = document.getElementById('monsterDatalist');
        if (!dl) return;
        dl.innerHTML = '';
        const ids = Object.keys(standardPresets).sort();
        for (const id of ids) {
            const preset = standardPresets[id];
            const label = (preset && preset.label) || id;
            const opt = document.createElement('option');
            opt.value = label;
            if (label !== id) opt.label = id;
            dl.appendChild(opt);
        }
    }

    function indexWorldCatalogRow(row, catalogKind) {
        if (!row || typeof row !== 'object') return;
        const id = String(row.id || '').trim();
        if (!id) return;
        worldCatalog[id] = {
            id,
            label: row.label || row.alias || row.technical || id,
            kind: catalogKind,
            category: row.category || '',
            volume: row.volume != null ? Number(row.volume) : (row.capacity != null ? Number(row.capacity) : null)
        };
    }

    function fillWorldCatalogDatalist() {
        const dl = document.getElementById('worldCatalogDatalist');
        if (!dl) return;
        dl.innerHTML = '';
        const ids = Object.keys(worldCatalog).sort();
        for (let i = 0; i < ids.length; i++) {
            const row = worldCatalog[ids[i]];
            const opt = document.createElement('option');
            opt.value = ids[i];
            if (row.label && row.label !== ids[i]) opt.label = row.label;
            dl.appendChild(opt);
        }
    }

    function loadWorldCatalogs() {
        const genre = tilemapArtGenre || 'rpg_fantasy';
        Promise.all([
            fetch(ASSET_ROOT + 'assets/data/' + genre + '/objects.json', { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null),
            fetch(ASSET_ROOT + 'presets/standard/equipment.json', { cache: 'no-store' })
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null)
        ]).then(([objectsDoc, equipDoc]) => {
            const objs = objectsDoc && Array.isArray(objectsDoc.items) ? objectsDoc.items : [];
            for (let i = 0; i < objs.length; i++) indexWorldCatalogRow(objs[i], 'objects');
            const eqs = equipDoc && Array.isArray(equipDoc.items) ? equipDoc.items : [];
            for (let i = 0; i < eqs.length; i++) indexWorldCatalogRow(eqs[i], 'equipment');
            fillWorldCatalogDatalist();
            if (currentLayer === 'world') renderWorldPaletteUI();
        });
    }
    loadWorldCatalogs();

    // presets_list returns { ok, items: [...], total } — not data.data.
    // limit=0 → all rows (paginate kinds default to page size 100 otherwise).
    fetch(
        window.__API_URL__ +
            '?action=presets_list&mode=standard&kind=creatures&limit=0'
    )
        .then((res) => res.json())
        .then((data) => {
            if (!data || !data.ok) return;
            const rows = data.items || data.data || [];
            rows.forEach((preset) => {
                if (preset && preset.id) {
                    standardPresets[preset.id] = preset;
                }
            });
            fillMonsterDatalist();
            if (currentLayer === 'spawns') renderPaletteUI();
            if (currentMapSpawns.length > 0) {
                renderSpawns();
            }
        })
        .catch((err) => console.error('Error loading standard presets', err));

    /** Accept canonical { floor, count, spawns } or bare spawn-row list (legacy save bug). */
    function spawnsFromByFloorDoc(data) {
        if (HdlTM && typeof HdlTM.parseSpawnRows === 'function') {
            return HdlTM.parseSpawnRows(data);
        }
        if (Array.isArray(data)) return data;
        if (data && Array.isArray(data.spawns)) return data.spawns;
        return [];
    }

    function hybridSpawnUrl(floor) {
        return ASSET_ROOT + 'assets/legacy/map/hybrid/floor-' + floor + '/map.json';
    }

    function byFloorSpawnUrl(floor) {
        return ASSET_ROOT + 'assets/legacy/spawns/by_floor/' + floor + '.json';
    }

    /**
     * Hybrid pack present → SoT even if `spawns` / `world` is empty.
     * Else by_floor for spawns only (World has no analog).
     * @param {string} floor padded id
     * @returns {Promise<{ spawns: object[], world: object[] }>}
     */
    async function fetchFloorPinDocs(floor) {
        try {
            const res = await fetch(hybridSpawnUrl(floor), { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    const spawns = Array.isArray(data.spawns) ? data.spawns : [];
                    const world = Array.isArray(data.world) ? data.world : [];
                    if (HdlTM && typeof HdlTM.markSpawnBaseline === 'function') {
                        HdlTM.markSpawnBaseline(spawns);
                    }
                    if (HdlTM && typeof HdlTM.markWorldBaseline === 'function') {
                        HdlTM.markWorldBaseline(world);
                    }
                    return { spawns, world };
                }
            }
        } catch (e) {
            /* pack missing — fall back */
        }
        let spawns = [];
        try {
            const res = await fetch(byFloorSpawnUrl(floor));
            if (res.ok) {
                spawns = spawnsFromByFloorDoc(await res.json());
                if (HdlTM && typeof HdlTM.markSpawnBaseline === 'function') {
                    HdlTM.markSpawnBaseline(spawns);
                }
            }
        } catch (e) {
            console.error(e);
        }
        return { spawns, world: [] };
    }

    async function fetchFloorSpawnRows(floor) {
        const docs = await fetchFloorPinDocs(floor);
        if (!mapWorldCache[floor]) mapWorldCache[floor] = docs.world;
        return docs.spawns;
    }

    function prefetchAllFloors() {
        const promises = [];
        for (let i = 0; i <= 15; i++) {
            const floor = padFloor(i);
            if (mapSpawnsCache[floor] && mapWorldCache[floor]) continue;
            promises.push(
                fetchFloorPinDocs(floor)
                    .then((docs) => {
                        if (!mapSpawnsCache[floor]) mapSpawnsCache[floor] = docs.spawns;
                        if (!mapWorldCache[floor]) mapWorldCache[floor] = docs.world;
                    })
                    .catch((e) => {
                        console.error(e);
                        if (!mapSpawnsCache[floor]) mapSpawnsCache[floor] = [];
                        if (!mapWorldCache[floor]) mapWorldCache[floor] = [];
                    })
            );
        }
        Promise.all(promises).then(() => {
            if (monsterNameInput.value.trim() !== '') {
                updateFloorCounts();
            }
        });
    }
    prefetchAllFloors();

    // --- Pan / zoom (aligned with map-spawn.js) ------------------------------

    let isSpaceDown = false;
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
            e.preventDefault();
            if (!isSpaceDown) {
                isSpaceDown = true;
                if (currentTool !== 'pan' && !imageContainer.classList.contains('panning')) {
                    imageContainer.style.cursor = 'grab';
                }
            }
        }
        
        if (!isTypingTarget(e.target)) {
            if (e.code === 'KeyM') {
                const btn = document.querySelector('.tool-btn[data-tool="select"]');
                if (btn) btn.click();
            } else if (e.code === 'KeyH') {
                const btn = document.querySelector('.tool-btn[data-tool="pan"]');
                if (btn) btn.click();
            } else if (e.code === 'KeyP') {
                const btn = document.querySelector('.tool-btn[data-tool="pen"]');
                if (btn) btn.click();
            } else if (e.code === 'KeyG' && !e.ctrlKey && !e.metaKey) {
                const btn = document.querySelector('.tool-btn[data-tool="bucket"]');
                if (btn) btn.click();
            } else if (e.code === 'KeyI') {
                const btn = document.querySelector('.tool-btn[data-tool="eyedropper"]');
                if (btn) btn.click();
            } else if (e.code === 'Escape') {
                selectionRect = null;
                selectedMapSpawns = [];
                selectedMapSpawn = null;
                if (pickStairDest) {
                    pickStairDest = false;
                    imageContainer.style.cursor = 'default';
                } else {
                    selectedStairPad = null;
                }
                renderSpawns();
                renderSpawnProperties();
            }
        }

        if (e.ctrlKey || e.metaKey) {
            if (e.code === 'KeyS') {
                e.preventDefault();
                if (isMapEditReady() && typeof saveCurrentMap === 'function') {
                    saveCurrentMap();
                }
            } else if (e.code === 'KeyZ') {
                if (e.shiftKey) {
                    redo();
                } else {
                    undo();
                }
                e.preventDefault();
            } else if (e.code === 'KeyY') {
                redo();
                e.preventDefault();
            } else if (e.code === 'KeyG') {
                e.preventDefault();
                openGotoModal();
            } else if (e.code === 'KeyF') {
                e.preventDefault();
                openFindModal();
            } else if (e.code === 'KeyC' && !isTypingTarget(e.target)) {
                if (isTileMapLayer(currentLayer) && copySelectedTiles()) e.preventDefault();
                else if (currentLayer === 'world' && copySelectedWorld()) e.preventDefault();
                else if (copySelectedSpawns()) e.preventDefault();
            } else if (e.code === 'KeyV' && !isTypingTarget(e.target)) {
                if (isTileMapLayer(currentLayer) && tileClipboard && pasteTileClipboard()) e.preventDefault();
                else if (currentLayer === 'world' && pasteWorldClipboard()) e.preventDefault();
                else if (pasteSpawnClipboard()) e.preventDefault();
            }
        }
    });
    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            isSpaceDown = false;
            if (currentTool !== 'pan' && !imageContainer.classList.contains('panning')) {
                imageContainer.style.cursor = 'default';
            }
        }
    });

    // Tools
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tool-btn').forEach(b => {
                b.classList.remove('active', 'btn-outline-primary');
                b.classList.add('btn-outline-secondary');
            });
            btn.classList.add('active', 'btn-outline-primary');
            btn.classList.remove('btn-outline-secondary');
            currentTool = btn.dataset.tool;

            if (currentTool === 'pan' || isSpaceDown) {
                imageContainer.style.cursor = 'grab';
                document.getElementById('statusBar').textContent = 'Pan tool active (drag to move)';
            } else if (currentTool === 'eyedropper') {
                imageContainer.style.cursor = 'crosshair';
                document.getElementById('statusBar').textContent = 'Eyedropper — click a stamp or pin';
            } else {
                imageContainer.style.cursor = 'default';
                document.getElementById('statusBar').textContent = 'Ready';
            }
        });
    });

    let startX, startY, startScrollLeft, startScrollTop;

    function updateStatusBarCoordinates(clientX, clientY) {
        const rect = imageContainer.getBoundingClientRect();
        const x = (clientX - rect.left + imageContainer.scrollLeft) / zoomValue;
        const y = (clientY - rect.top + imageContainer.scrollTop) / zoomValue;
        lastMapTile = { x: Math.floor(x), y: Math.floor(y) };
        const panX = imageContainer.scrollLeft;
        const panY = imageContainer.scrollTop;
        const w = imageContainer.clientWidth;
        const h = imageContainer.clientHeight;
        document.getElementById('statusBar').textContent = 
            `(${x.toFixed(1)}, ${y.toFixed(1)}) · pan (${panX.toFixed(0)}, ${panY.toFixed(0)}) · ${w}×${h}px view`;
    }

    let selectStartXLocal = 0, selectStartYLocal = 0;
    function onMouseMove(event) {
        if (imageContainer.classList.contains('panning')) {
            imageContainer.scrollLeft = startScrollLeft - (event.clientX - startX);
            imageContainer.scrollTop = startScrollTop - (event.clientY - startY);
            if (Math.abs(event.clientX - startX) > 3 || Math.abs(event.clientY - startY) > 3) {
                wasDraggingPan = true;
            }
        } else if (isSelecting) {
            const rect = imageContainer.getBoundingClientRect();
            const currentXLocal = (event.clientX - rect.left + imageContainer.scrollLeft) / zoomValue;
            const currentYLocal = (event.clientY - rect.top + imageContainer.scrollTop) / zoomValue;
            selectionRect = {
                x: Math.min(selectStartXLocal, currentXLocal),
                y: Math.min(selectStartYLocal, currentYLocal),
                w: Math.abs(currentXLocal - selectStartXLocal),
                h: Math.abs(currentYLocal - selectStartYLocal)
            };
            if (selectionRect.w > 3 || selectionRect.h > 3) {
                wasDragging = true;
            }
            renderSpawns();
        }
        updateStatusBarCoordinates(event.clientX, event.clientY);
    }
    function onMouseUp(event) {
        let isSimpleClick = false;

        if (isSelecting) {
            isSelecting = false;
            if (wasDragging && selectionRect) {
                if (currentLayer === 'spawns' && layerVisibility[`floor-${currentFloor}-spawns`]) {
                    const filterText = monsterNameInput.value.toLowerCase().trim();
                    selectedMapSpawns = [];
                    for (const spawn of currentMapSpawns) {
                        if (!matchesFilter(spawn, filterText)) continue;
                        if ((spawn.x + 0.5) >= selectionRect.x && (spawn.x + 0.5) <= selectionRect.x + selectionRect.w &&
                            (spawn.y + 0.5) >= selectionRect.y && (spawn.y + 0.5) <= selectionRect.y + selectionRect.h) {
                            selectedMapSpawns.push(spawn);
                        }
                    }
                    if (selectedMapSpawns.length > 0) {
                        selectedMapSpawn = selectedMapSpawns[0];
                        selectedPaletteItem = null;
                        if (currentLayer === 'spawns') renderPaletteUI();
                        renderSpawnProperties();
                    } else {
                        selectedMapSpawns = [];
                        selectedMapSpawn = null;
                        renderSpawnProperties();
                    }
                } else if (currentLayer === 'world' && layerVisibility[`floor-${currentFloor}-world`]) {
                    selectedWorldPins = [];
                    for (const pin of currentMapWorld) {
                        if ((pin.x + 0.5) >= selectionRect.x && (pin.x + 0.5) <= selectionRect.x + selectionRect.w &&
                            (pin.y + 0.5) >= selectionRect.y && (pin.y + 0.5) <= selectionRect.y + selectionRect.h) {
                            selectedWorldPins.push(pin);
                        }
                    }
                    selectedWorldPin = selectedWorldPins[0] || null;
                    if (selectedWorldPin) selectedWorldPalette = null;
                    if (currentLayer === 'world') renderWorldPaletteUI();
                    renderWorldProperties();
                }
            } else {
                selectionRect = null;
                isSimpleClick = true;
            }
        }

        if (imageContainer.classList.contains('panning')) {
            imageContainer.classList.remove('panning');
            if (!wasDraggingPan) {
                isSimpleClick = true;
            }
        }

        if (isSimpleClick) {
            const rect = imageContainer.getBoundingClientRect();
            const clickCanvasX = event.clientX - rect.left + imageContainer.scrollLeft;
            const clickCanvasY = event.clientY - rect.top + imageContainer.scrollTop;
            const clickX = clickCanvasX / zoomValue;
            const clickY = clickCanvasY / zoomValue;
            
            const url = new URL(window.location.href);
            url.searchParams.set('point', `${Math.floor(clickX)},${Math.floor(clickY)},${currentFloor},${Math.round(zoomValue * 100)}`);
            window.history.replaceState({}, '', url.toString());

            if (currentLayer === 'spawns' && layerVisibility[`floor-${currentFloor}-spawns`]) {
                const filterText = monsterNameInput.value.toLowerCase().trim();
                let clickedSpawn = null;
                let minDistanceSq = Infinity;
                for (let i = currentMapSpawns.length - 1; i >= 0; i--) {
                    const spawn = currentMapSpawns[i];
                    if (!matchesFilter(spawn, filterText)) continue;
                    
                    const art = resolveSpawnArt(spawn);
                    const img = imageCache.get(art.standardUrl);
                    const w = (img && img.loaded) ? (img.image.naturalWidth || 32) : 32;
                    const h = (img && img.loaded) ? (img.image.naturalHeight || 32) : 32;
                    
                    const spawnCanvasX = spawn.x * zoomValue;
                    const spawnCanvasY = spawn.y * zoomValue;
                    
                    if (clickCanvasX >= spawnCanvasX && clickCanvasX <= spawnCanvasX + w &&
                        clickCanvasY >= spawnCanvasY && clickCanvasY <= spawnCanvasY + h) {
                        const cx = spawnCanvasX + w / 2;
                        const cy = spawnCanvasY + h / 2;
                        const distSq = (clickCanvasX - cx) * (clickCanvasX - cx) + (clickCanvasY - cy) * (clickCanvasY - cy);
                        if (distSq < minDistanceSq) {
                            minDistanceSq = distSq;
                            clickedSpawn = spawn;
                        }
                    }
                }
                if (clickedSpawn) {
                    selectedMapSpawns = [clickedSpawn];
                    selectedMapSpawn = clickedSpawn;
                    selectedPaletteItem = null;
                    selectedStairPad = null;
                    pickStairDest = false;
                    renderPaletteUI();
                    renderSpawnProperties();
                } else {
                    selectedMapSpawns = [];
                    selectedMapSpawn = null;
                    trySelectStairPadAt(Math.floor(clickX), Math.floor(clickY));
                    renderSpawnProperties();
                }
            } else {
                trySelectStairPadAt(Math.floor(clickX), Math.floor(clickY));
                renderSpawnProperties();
            }
        }

        if (currentTool === 'pan' || isSpaceDown) {
            imageContainer.style.cursor = 'grab';
        } else {
            imageContainer.style.cursor = 'default';
        }
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        renderSpawns();
    }
    imageContainer.addEventListener('mousedown', (e) => {
        if (!isMapEditReady()) return;
        if (e.button === 0 && !isSpaceDown && pickStairDest && selectedStairPad) {
            const rect = imageContainer.getBoundingClientRect();
            const localX = Math.floor((e.clientX - rect.left + imageContainer.scrollLeft) / zoomValue);
            const localY = Math.floor((e.clientY - rect.top + imageContainer.scrollTop) / zoomValue);
            lastMapTile = { x: localX, y: localY };
            const zEl = document.getElementById('pad-dest-z');
            const destZ = zEl && zEl.value !== ''
                ? Number(zEl.value)
                : (selectedStairPad.to && selectedStairPad.to.z != null
                    ? selectedStairPad.to.z
                    : selectedStairPad.z);
            applySelectedPadDest({ x: localX, y: localY, z: destZ });
            pickStairDest = false;
            imageContainer.style.cursor = 'default';
            wasDragging = true;
            e.preventDefault();
            return;
        }
        if (e.button === 0 && !isSpaceDown && (currentTool === 'eyedropper' || e.altKey)) {
            const rect = imageContainer.getBoundingClientRect();
            const localX = Math.floor((e.clientX - rect.left + imageContainer.scrollLeft) / zoomValue);
            const localY = Math.floor((e.clientY - rect.top + imageContainer.scrollTop) / zoomValue);
            lastMapTile = { x: localX, y: localY };
            applyEyedropper(localX, localY, e);
            wasDragging = true;
            return;
        }
        if (e.button === 0 && !isSpaceDown && (currentTool === 'pen' || currentTool === 'bucket')) {
            const rect = imageContainer.getBoundingClientRect();
            const localX = Math.floor((e.clientX - rect.left + imageContainer.scrollLeft) / zoomValue);
            const localY = Math.floor((e.clientY - rect.top + imageContainer.scrollTop) / zoomValue);
            
            if (currentTool === 'pen') {
                saveState();
                window.isPainting = true;
                paintStrokeLast = null;
                if (tilemapSession && (isTileMapLayer(currentLayer) || ['friction', 'sight', 'flags', 'fields'].includes(currentLayer))) {
                    tilemapSession.beginStroke();
                }
                paintStrokeTo(localX, localY);
                document.addEventListener('mousemove', onPaintMove);
                document.addEventListener('mouseup', onPaintUp);
            } else if (currentTool === 'bucket') {
                saveState();
                applyBucket(localX, localY);
            }
            return;
        }

        if (currentTool === 'select' && e.button === 0 && !isSpaceDown) {
            isSelecting = true;
            wasDragging = false;
            const rect = imageContainer.getBoundingClientRect();
            selectStartXLocal = (e.clientX - rect.left + imageContainer.scrollLeft) / zoomValue;
            selectStartYLocal = (e.clientY - rect.top + imageContainer.scrollTop) / zoomValue;
            selectionRect = { x: selectStartXLocal, y: selectStartYLocal, w: 0, h: 0 };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            return;
        }

        if (e.button === 1 || isSpaceDown || (currentTool === 'pan' && e.button === 0)) {
            e.preventDefault();
            imageContainer.classList.add('panning');
            wasDraggingPan = false;
            startX = e.clientX;
            startY = e.clientY;
            startScrollLeft = imageContainer.scrollLeft;
            startScrollTop = imageContainer.scrollTop;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
    });

    imageContainer.addEventListener('mousemove', (e) => {
        if (imageContainer.classList.contains('panning')) return;
        updateStatusBarCoordinates(e.clientX, e.clientY);
    });

    imageContainer.addEventListener('mouseleave', () => {
        if (currentTool === 'pan' || isSpaceDown) {
            document.getElementById('statusBar').textContent = 'Pan tool active (drag to move)';
        } else {
            document.getElementById('statusBar').textContent = 'Ready';
        }
    });

    const zoomButtons = document.querySelectorAll('.image-zoom');
    const zoomDropdown = document.getElementById('zoomDropdown');
    zoomButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
            if (e) e.preventDefault();
            zoomButtons.forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            if (zoomDropdown) zoomDropdown.textContent = btn.textContent;
            setZoom(parseFloat(btn.dataset.zoom));
        });
    });

    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomInBtn = document.getElementById('zoomInBtn');
    if (zoomOutBtn) {
        zoomOutBtn.addEventListener('click', () => {
            const activeBtn = document.querySelector('.image-zoom.active');
            const activeIndex = Array.from(zoomButtons).indexOf(activeBtn);
            const nextIndex = Math.max(activeIndex - 1, 0);
            if (nextIndex !== activeIndex) {
                zoomButtons[nextIndex].click();
            }
        });
    }
    if (zoomInBtn) {
        zoomInBtn.addEventListener('click', () => {
            const activeBtn = document.querySelector('.image-zoom.active');
            const activeIndex = Array.from(zoomButtons).indexOf(activeBtn);
            const nextIndex = Math.min(activeIndex + 1, zoomButtons.length - 1);
            if (nextIndex !== activeIndex) {
                zoomButtons[nextIndex].click();
            }
        });
    }

    imageContainer.addEventListener('wheel', (e) => {
        if (!mouseZoom.checked) return;
        e.preventDefault();
        const activeBtn = document.querySelector('.image-zoom.active');
        const activeIndex = Array.from(zoomButtons).indexOf(activeBtn);
        let nextIndex = activeIndex;
        if (e.deltaY < 0) {
            nextIndex = Math.min(activeIndex + 1, zoomButtons.length - 1);
        } else if (e.deltaY > 0) {
            nextIndex = Math.max(activeIndex - 1, 0);
        }
        if (nextIndex !== activeIndex) {
            zoomButtons[nextIndex].click();
        }
    });

    function setZoom(newZoom) {
        const scrollContainer = imageContainer;
        const clientWidth = scrollContainer.clientWidth;
        const clientHeight = scrollContainer.clientHeight;
        const centerX = scrollContainer.scrollLeft + clientWidth / 2;
        const centerY = scrollContainer.scrollTop + clientHeight / 2;

        const scalingFactor = newZoom / zoomValue;
        zoomValue = newZoom;
        if (editorViewport) editorViewport.setZoom(zoomValue);

        updateScrollSizer();

        scrollContainer.scrollLeft = centerX * scalingFactor - clientWidth / 2;
        scrollContainer.scrollTop = centerY * scalingFactor - clientHeight / 2;
        if (editorViewport) {
            editorViewport.setScroll(scrollContainer.scrollLeft, scrollContainer.scrollTop);
        }

        renderSpawns();
    }

    // Catalog icon tiles from zoom threshold (icon/ 32×32); adjustable anytime.
    document.querySelectorAll('.sprite-zoom-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            applySpriteZoomMin(btn.getAttribute('data-sprite-zoom'));
        });
    });

    /** Resolve visibility key for current floor from data-layer-suffix (e.g. "spawns", "tilemap-ground"). */
    function layerIdFromSuffix(suffix) {
        return `floor-${currentFloor}-${suffix}`;
    }

    function syncFloorSelectorUI() {
        const label = `Floor ${currentFloor}`;
        const floorDropdown = document.getElementById('floorDropdown');
        if (floorDropdown) floorDropdown.textContent = label;
        const panelLabel = document.getElementById('floorPanelLabel');
        if (panelLabel) panelLabel.textContent = currentFloor;
        document.querySelectorAll('.floor-option').forEach((opt) => {
            opt.classList.toggle('active', opt.dataset.floor === currentFloor);
        });
    }

    function updateObjectTreeUI() {
        syncFloorSelectorUI();

        document.querySelectorAll('#objectBrowserTree .tree-item').forEach((el) => {
            el.classList.remove('active', 'text-light');
            el.classList.add('text-secondary');
            if (currentLayer && el.dataset.target === currentLayer) {
                el.classList.add('active', 'text-light');
                el.classList.remove('text-secondary');
            }
        });

        document.querySelectorAll('.visibility-toggle').forEach((el) => {
            const suffix = el.dataset.layerSuffix;
            // data-layer-suffix is always present (may be empty string for whole floor)
            if (suffix === undefined) return;
            const id = layerIdFromSuffix(suffix);
            el.dataset.layerId = id;
            const isVisible = layerVisibility[id] !== false;
            const icon = el.querySelector('i');
            if (!icon) return;
            if (isVisible) {
                icon.classList.remove('fa-eye-slash');
                icon.classList.add('fa-eye');
                el.classList.remove('text-muted');
            } else {
                icon.classList.remove('fa-eye');
                icon.classList.add('fa-eye-slash');
                el.classList.add('text-muted');
            }
        });

        updateFloorCounts();
    }

    function updateVisibility() {
        // Phase 8: visibility filters composite passes (no DOM show/hide of N canvases).
        if (editorViewport) {
            const floorOn = layerVisibility[`floor-${currentFloor}`] !== false;
            editorViewport.setVisible('floor', floorOn);
            ['friction', 'sight', 'flags', 'fields', 'tilemap', 'spawns', 'world'].forEach((l) => {
                const on =
                    floorOn && layerVisibility[`floor-${currentFloor}-${l}`] !== false;
                editorViewport.setVisible(l, on);
            });
            TILEMAP_SUBS.forEach((sub) => {
                const on =
                    floorOn &&
                    layerVisibility[`floor-${currentFloor}-tilemap-${sub}`] !== false;
                editorViewport.setVisible('tilemap-' + sub, on);
            });
            markDirty();
            // Force composite so layer toggles paint immediately
            if (editorViewport.anyDirty()) flushEditorComposite();
        }
        renderSpawns();
    }

    /**
     * Load a legacy PNG into memory (base path → display; side channels → __pngChannelRgba).
     * Does not attach one canvas per channel.
     */
    function loadLayerImage(floor, layerKey, onLoadCallback) {
        if (layerKey === 'tilemap') {
            if (onLoadCallback) onLoadCallback();
            return;
        }
        let targetSuffix = 'path';
        if (layerKey === 'sight' || layerKey === 'flags' || layerKey === 'fields') {
            targetSuffix = layerKey;
        } else if (layerKey === 'friction') {
            targetSuffix = 'path';
        }

        const imgSrc = ASSET_ROOT + 'assets/legacy/map/floor-' + floor + '-' + targetSuffix + '.png';
        const img = new Image();
        img.onload = () => {
            const w = img.naturalWidth;
            const h = img.naturalHeight;
            // Decode via temporary detached canvas
            const off = document.createElement('canvas');
            off.width = w;
            off.height = h;
            const octx = off.getContext('2d', { willReadFrequently: true });
            octx.drawImage(img, 0, 0);
            const rgba = octx.getImageData(0, 0, w, h).data;
            if (!window.__pngChannelRgba) window.__pngChannelRgba = {};
            if (layerKey === 'friction') {
                ensureWorldCanvas(w, h);
                worldCanvas.getContext('2d').drawImage(img, 0, 0);
                if (editorViewport) {
                    editorViewport.setBaseRgba(rgba, w, h);
                    editorViewport.setMapSize(w, h);
                }
                updateScrollSizer();
                markDirty();
            } else {
                window.__pngChannelRgba[layerKey] = rgba;
            }
            if (onLoadCallback) onLoadCallback();
        };
        img.onerror = () => {
            const w = bounds.width || 2560;
            const h = bounds.height || 2048;
            if (layerKey === 'friction') {
                ensureWorldCanvas(w, h);
                const wctx = worldCanvas.getContext('2d');
                wctx.fillStyle = '#000000';
                wctx.fillRect(0, 0, w, h);
                if (editorViewport) {
                    const blank =
                        typeof Uint8ClampedArray !== 'undefined'
                            ? new Uint8ClampedArray(w * h * 4)
                            : new Uint8Array(w * h * 4);
                    for (let i = 3; i < blank.length; i += 4) blank[i] = 255;
                    editorViewport.setBaseRgba(blank, w, h);
                    editorViewport.setMapSize(w, h);
                }
                updateScrollSizer();
                markDirty();
            }
            if (onLoadCallback) onLoadCallback();
        };
        img.src = imgSrc;
    }

    function refreshLayerPalette() {
        const layerProps = document.getElementById('layer-props');
        if (!layerProps) return;
        if (currentLayer === 'spawns') {
            layerProps.style.display = '';
            renderPaletteUI();
        } else if (currentLayer === 'world') {
            layerProps.style.display = '';
            renderWorldPaletteUI();
        } else if (isTileMapLayer(currentLayer)) {
            layerProps.style.display = '';
            const sub = tileMapSubFromLayer(currentLayer);
            if (tilemapSession && sub) tilemapSession.setActiveSubLayer(sub);
            renderTileMapPaletteUI();
        } else if (currentLayer === 'friction') {
            layerProps.style.display = '';
            renderFrictionPaletteUI();
        } else if (currentLayer === 'sight') {
            layerProps.style.display = '';
            renderSightPaletteUI();
        } else if (currentLayer === 'flags') {
            layerProps.style.display = '';
            renderFlagsPaletteUI();
        } else if (currentLayer === 'fields') {
            layerProps.style.display = '';
            renderFieldsPaletteUI();
        } else {
            layerProps.style.display = 'none';
        }
    }

    function selectFloorAndLayer(floor, layer, onLoadCallback) {
        const floorChanged = currentFloor !== floor || !window.__initialLayersLoaded;
        // Parent "TileMap" row → default into ground so a concrete sub-layer is always active.
        if (layer === 'tilemap') layer = 'tilemap:ground';

        if (floorChanged) {
            const gen = beginMapLoad('Loading map…');
            currentFloor = floor;
            imageContainer.dataset.floor = currentFloor;
            loadFloorSpawns(currentFloor);
            window.__initialLayersLoaded = true;
            tilemapSession = null; // rebuild per floor
            floorPngReady = false;
            window.__pngChannelRgba = {};
            if (editorViewport) {
                editorViewport.setSession(null);
                editorViewport.clearBaseRgba();
            }

            let loadedCount = 0;
            const pngKeys = ['friction', 'sight', 'flags', 'fields'];
            const totalLayers = pngKeys.length;
            const cb = () => {
                loadedCount++;
                if (loadedCount !== totalLayers) return;
                if (gen !== mapLoadGen) return;
                floorPngReady = true;
                setZoom(zoomValue);
                // Wait for hybrid or path-PNG bootstrap so paint cannot start on empty channels.
                ensureTilemapSession()
                    .catch((e) => console.warn('floor session load failed', e))
                    .finally(() => {
                        if (gen !== mapLoadGen) return;
                        if (!tilemapSession && editorViewport && editorViewport.hasBase) {
                            flushEditorComposite();
                        }
                        finishMapLoad(gen);
                        refreshLayerPalette();
                        updateVisibility();
                        const sb = document.getElementById('statusBar');
                        if (sb) {
                            sb.textContent =
                                `Switched to Floor ${currentFloor}` +
                                (currentLayer ? ` (${currentLayer})` : '');
                        }
                        if (onLoadCallback) onLoadCallback();
                    });
            };
            pngKeys.forEach((l) => {
                loadLayerImage(currentFloor, l, cb);
            });
        }

        currentLayer = layer;

        window.selectedDrawColor = null;
        window.selectedFrictionValue = null;
        selectedFlagPackage = null;
        selectedFlagBits = null;
        selectedFieldValue = null;
        document.querySelectorAll('.tile-swatch').forEach((s) => (s.style.borderColor = 'transparent'));

        if (worldCanvas) selectedImage = worldCanvas;
        else ensureWorldCanvas(mapPixelWidth(), mapPixelHeight());
        if (isTileMapLayer(layer)) {
            const sub = tileMapSubFromLayer(layer);
            if (tilemapSession && sub) tilemapSession.setActiveSubLayer(sub);
        }

        if (!floorChanged) {
            if (layerNeedsEditorSession(layer) && !(tilemapSession && tilemapSession.cols > 0)) {
                if (!floorPngReady) {
                    setMapLoading(true, 'Loading map…');
                } else {
                    const gen = mapLoadGen;
                    setMapLoading(true, 'Preparing editor…');
                    ensureTilemapSession()
                        .catch((e) => console.warn('session prepare failed', e))
                        .finally(() => {
                            if (gen !== mapLoadGen) return;
                            finishMapLoad(gen);
                            refreshLayerPalette();
                            if (onLoadCallback) onLoadCallback();
                        });
                }
            } else {
                refreshLayerPalette();
                if (onLoadCallback) onLoadCallback();
            }
        }
        
        if (floor && isMapEditReady()) {
            document.getElementById('statusBar').textContent = `Switched to Floor ${floor}` + (layer ? ` (${layer})` : '');
        }
        
        document.querySelectorAll('.sidebar-nav-link').forEach(link => {
            link.classList.remove('active');
            if (link.dataset.layer === layer) {
                link.classList.add('active');
            }
        });

        const penBtn = document.querySelector('.tool-btn[data-tool="pen"]');
        const bucketBtn = document.querySelector('.tool-btn[data-tool="bucket"]');
        if (layer === 'spawns' || layer === 'world') {
            if (penBtn) penBtn.disabled = true;
            if (bucketBtn) bucketBtn.disabled = true;
            if (currentTool === 'pen' || currentTool === 'bucket') {
                const panBtn = document.querySelector('.tool-btn[data-tool="pan"]');
                if (panBtn) panBtn.click();
            }
        } else {
            if (penBtn) penBtn.disabled = false;
            if (bucketBtn) bucketBtn.disabled = false;
        }

        // +/−, dropdown, undo, and deep-links all go through here — keep
        // Object Browser chrome (dropdown + "Floor NN · layers") in sync.
        updateObjectTreeUI();
    }

    function renderTileMapPaletteUI() {
        if (!document.getElementById('layer-props')) return;
        if (!HdlTM) {
            document.getElementById('layer-props').innerHTML =
                '<div class="small text-warning">Map editor bundle not loaded.</div>';
            return;
        }
        const sub = tileMapSubFromLayer(currentLayer) || (tilemapSession && tilemapSession.activeSubLayer) || 'ground';
        let stamps = (tilemapSession && tilemapSession.stamps) || [];
        if ((!stamps || !stamps.length) && window.__tilemapArtSet) {
            stamps = HdlTM.buildStampsFromArtSet(window.__tilemapArtSet, tilemapRoleCatalog);
            if (tilemapSession) tilemapSession.setArtSet(window.__tilemapArtSet, tilemapRoleCatalog);
            stamps = (tilemapSession && tilemapSession.stamps) || stamps;
        }
        const filtered = stamps.filter((s) => !sub || s.subLayer === sub || currentLayer === 'tilemap');

        const subNav = TILEMAP_SUBS.map((id) => {
            const active = id === sub && currentLayer !== 'tilemap';
            const label = id.charAt(0).toUpperCase() + id.slice(1);
            return `<button type="button" class="btn btn-sm ${active ? 'btn-primary' : 'btn-outline-secondary'} tilemap-sub-btn" data-sub="${id}">${label}</button>`;
        }).join('');

        let html = `<div class="mb-2">
            <label class="form-label small text-uppercase text-secondary fw-bold mb-1">TileMap · ${sub}</label>
            <div class="d-flex flex-wrap gap-1 mb-2" id="tilemap-sub-nav">${subNav}</div>
            <div class="small text-muted mb-2">Pick a sub-layer, then a stamp. Overlay families resolve Wang-16 on Path at stroke-end. RAW writes one catalog id (no resolve). Copy/paste the selection (Ctrl+C / Ctrl+V). PNG / hybrid friction stays until you paint a cell.</div>
            <div class="mb-2">
                <label class="form-label small text-muted mb-0">Art set</label>
                <select id="tilemap-artset" class="form-select form-select-sm bg-black border-secondary text-white">
                    <option value="cave_simple">cave_simple</option>
                    <option value="cave">cave</option>
                    <option value="crypt">crypt</option>
                    <option value="swamp">swamp</option>
                    <option value="ice_simple">ice_simple</option>
                    <option value="ice">ice</option>
                    <option value="ruins">ruins</option>
                </select>
            </div>
            <div class="form-check mb-2">
                <input class="form-check-input" type="checkbox" id="tilemap-erase" ${tilemapEraseMode ? 'checked' : ''}>
                <label class="form-check-label small" for="tilemap-erase">Erase (clear cell)</label>
            </div>
            <div class="d-flex flex-wrap gap-1 mb-2" id="tilemap-stamps">`;

        filtered.forEach((stamp, index) => {
            const sel = tilemapSession && tilemapSession.selectedStamp === stamp;
            const color = stamp.previewColor || '#666';
            html += `<button type="button" class="btn btn-sm ${sel ? 'btn-primary' : 'btn-outline-secondary'} tilemap-stamp-btn"
                data-index="${index}" title="${stamp.catalogId} (${stamp.roleId || stamp.artRole})"
                style="min-width:28px;border-left:4px solid ${color};">${stamp.label || stamp.catalogId}</button>`;
        });

        if (sub === 'vertical') {
            html += `</div>
            <div class="small mt-2 border-top border-secondary pt-2">
                <label class="form-label small text-muted">Vertical hop (selected stamp)</label>
                <div class="d-flex gap-1 mb-1">
                    <select id="hop-dir" class="form-select form-select-sm bg-black border-secondary text-white">
                        <option value="center">center</option>
                        <option value="north">north</option>
                        <option value="south">south</option>
                        <option value="east">east</option>
                        <option value="west">west</option>
                    </select>
                    <select id="hop-dz" class="form-select form-select-sm bg-black border-secondary text-white">
                        <option value="-1">up (z−1)</option>
                        <option value="1">down (z+1)</option>
                    </select>
                </div>
            </div>`;
        } else {
            html += `</div>`;
        }

        const rawKindDefault = sub === 'path' ? 'overlays' : (sub === 'ground' ? 'tiles' : 'objects');
        const rawSel = tilemapRawStamp && tilemapSession && tilemapSession.selectedStamp === tilemapRawStamp;
        html += `<div class="small mt-2 border-top border-secondary pt-2">
                <label class="form-label small text-muted mb-0">RAW catalog id</label>
                <div class="d-flex gap-1 mb-1">
                    <input type="text" id="tilemap-raw-id" class="form-control form-control-sm bg-black border-secondary text-white" placeholder="dirt_wang_05" value="${rawSel && tilemapRawStamp ? (tilemapRawStamp.catalogId || '') : ''}">
                    <select id="tilemap-raw-kind" class="form-select form-select-sm bg-black border-secondary text-white" style="max-width:7.5rem;">
                        <option value="overlays"${rawKindDefault === 'overlays' ? ' selected' : ''}>overlays</option>
                        <option value="tiles"${rawKindDefault === 'tiles' ? ' selected' : ''}>tiles</option>
                        <option value="objects"${rawKindDefault === 'objects' ? ' selected' : ''}>objects</option>
                    </select>
                    <button type="button" class="btn btn-sm ${rawSel ? 'btn-primary' : 'btn-outline-secondary'}" id="tilemap-raw-apply" title="Stamp this catalog id without Wang resolve">Use</button>
                </div>
            </div>
            <div class="small text-muted mt-2">Paint stamps on the active sub-layer. Overlay family brushes re-resolve a 1-ring. Bake updates friction / sight / flags. Fields stay independent.</div></div>`;
        document.getElementById('layer-props').innerHTML = html;

        document.querySelectorAll('.tilemap-sub-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.sub;
                if (!id) return;
                selectFloorAndLayer(currentFloor, 'tilemap:' + id);
            });
        });
        const artSel = document.getElementById('tilemap-artset');
        if (artSel) {
            artSel.value = tilemapArtSetId;
            artSel.addEventListener('change', async () => {
                tilemapArtSetId = artSel.value;
                try {
                    const r = await fetch(ASSET_ROOT + 'presets/standard/art_sets/' + tilemapArtSetId + '.json');
                    if (r.ok) {
                        const art = await r.json();
                        window.__tilemapArtSet = art;
                        if (art.genre) tilemapArtGenre = String(art.genre);
                        if (tilemapSession) tilemapSession.setArtSet(art, tilemapRoleCatalog);
                        if (editorViewport) {
                            editorViewport.markDirty(['props', 'terrain', 'full']);
                            markDirty();
                        }
                        renderTileMapPaletteUI();
                    }
                } catch (e) {
                    console.warn(e);
                }
            });
        }
        const eraseEl = document.getElementById('tilemap-erase');
        if (eraseEl) {
            eraseEl.addEventListener('change', () => {
                tilemapEraseMode = !!eraseEl.checked;
            });
        }
        document.querySelectorAll('.tilemap-stamp-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const stamp = filtered[idx];
                tilemapRawStamp = null;
                if (tilemapSession) tilemapSession.selectStamp(stamp);
                tilemapEraseMode = false;
                renderTileMapPaletteUI();
            });
        });
        const rawApply = document.getElementById('tilemap-raw-apply');
        if (rawApply) {
            rawApply.addEventListener('click', () => applyRawCatalogStamp());
        }
        const rawIdEl = document.getElementById('tilemap-raw-id');
        if (rawIdEl) {
            rawIdEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    applyRawCatalogStamp();
                }
            });
        }
        const hopDir = document.getElementById('hop-dir');
        const hopDz = document.getElementById('hop-dz');
        if (hopDir && hopDz && tilemapSession && tilemapSession.selectedStamp) {
            const st = tilemapSession.selectedStamp;
            if (st.hop) {
                hopDir.value = st.hop.dir || 'center';
                hopDz.value = String(st.hop.deltaZ != null ? st.hop.deltaZ : -1);
            }
            const applyHop = () => {
                if (!tilemapSession.selectedStamp) return;
                tilemapSession.selectedStamp.hop = {
                    dir: hopDir.value,
                    deltaZ: parseInt(hopDz.value, 10)
                };
            };
            hopDir.addEventListener('change', applyHop);
            hopDz.addEventListener('change', applyHop);
        }
    }

    const frictionBreakpoints = [70, 90, 95, 100, 110, 120, 121, 125, 130, 140, 150, 160, 170, 180, 200, 250, 255];
    function getFrictionColor(val) {
        if (val === 255) return '#ffff00';
        const hex = val.toString(16).padStart(2, '0');
        return `#${hex}${hex}${hex}`;
    }

    function renderFrictionPaletteUI() {
        if (!document.getElementById('layer-props')) return;
        let html = `<div class="mb-2">
            <label class="form-label small text-uppercase text-secondary fw-bold mb-2">Friction Values</label>
            <div class="d-flex flex-wrap gap-2">`;
            
        frictionBreakpoints.forEach(val => {
            const color = getFrictionColor(val);
            html += `<div class="tile-swatch" style="width:24px; height:24px; border-radius:4px; cursor:pointer; border:2px solid transparent; background-color:${color};" title="Friction: ${val}" data-value="${val}"></div>`;
        });
        
        html += `</div>
            <div class="small mt-2 text-muted">Select a friction value to paint.</div>
        </div>`;
        
        document.getElementById('layer-props').innerHTML = html;
        document.querySelectorAll('.tile-swatch').forEach(sw => {
            sw.addEventListener('click', (e) => {
                document.querySelectorAll('.tile-swatch').forEach(s => s.style.borderColor = 'transparent');
                sw.style.borderColor = '#0d6efd';
                window.selectedFrictionValue = parseInt(sw.dataset.value, 10);
                window.selectedFrictionColor = sw.style.backgroundColor;
                window.selectedDrawColor = sw.style.backgroundColor;
            });
        });
    }

    function renderSightPaletteUI() {
        if (!document.getElementById('layer-props')) return;
        let html = `<div class="mb-2">
            <label class="form-label small text-uppercase text-secondary fw-bold mb-2">Sight Values</label>
            <div class="d-flex flex-wrap gap-2">`;
            
        [0, 64, 128, 192, 255].forEach(val => {
            const hex = val.toString(16).padStart(2, '0');
            const color = `#${hex}${hex}${hex}`;
            const label = val === 0 ? "Clear (0)" : val === 255 ? "Blocked (255)" : `Opacity ${val}`;
            html += `<div class="tile-swatch" style="width:24px; height:24px; border-radius:4px; cursor:pointer; border:2px solid transparent; background-color:${color};" title="${label}" data-color="${color}"></div>`;
        });
        
        html += `</div>
            <div class="small mt-2 text-muted">Select a sight value to paint.</div>
        </div>`;
        
        document.getElementById('layer-props').innerHTML = html;
        document.querySelectorAll('.tile-swatch').forEach(sw => {
            sw.addEventListener('click', (e) => {
                document.querySelectorAll('.tile-swatch').forEach(s => s.style.borderColor = 'transparent');
                sw.style.borderColor = '#0d6efd';
                window.selectedDrawColor = sw.dataset.color;
            });
        });
    }

    function renderFlagsPaletteUI() {
        if (!document.getElementById('layer-props')) return;
        const entries = (HdlTM && HdlTM.flagPaletteEntries)
            ? HdlTM.flagPaletteEntries()
            : [
                { id: 'none', label: 'None (0)', bits: 0, color: '#000000' },
                { id: 'pz', label: 'Protection Zone', bits: 65, color: '#00ff00', package: true }
            ];

        let html = `<div class="mb-2">
            <label class="form-label small text-uppercase text-secondary fw-bold mb-2">Flags</label>
            <div class="d-flex flex-wrap gap-2">`;

        ensureFlagIconUnicodes();
        entries.forEach((f) => {
            const pkg = f.package ? ' ★' : '';
            const inner = f.icon
                ? `<i class="fa-solid ${f.icon} fa-sm" aria-hidden="true"></i>`
                : `<span style="width:14px;height:14px;border-radius:2px;background:${f.color};display:inline-block;"></span>`;
            html += `<div class="tile-swatch d-flex align-items-center justify-content-center"
                style="width:28px; height:28px; border-radius:4px; cursor:pointer; border:2px solid transparent; background-color:#222; color:${f.color}; font-size:10px;"
                title="${f.label}${pkg}" data-bits="${f.bits}" data-package="${f.package ? '1' : '0'}" data-color="${f.color}">
                ${inner}
            </div>`;
        });

        html += `</div>
            <div class="small mt-2 text-muted">★ packages set multiple bits (PZ = NO_CAST | NO_CREATURE). Manual flags set override bits so TileMap rebake keeps them.</div>
        </div>`;

        document.getElementById('layer-props').innerHTML = html;
        document.querySelectorAll('.tile-swatch').forEach((sw) => {
            sw.addEventListener('click', () => {
                document.querySelectorAll('.tile-swatch').forEach((s) => (s.style.borderColor = 'transparent'));
                sw.style.borderColor = '#0d6efd';
                window.selectedDrawColor = sw.dataset.color;
                selectedFlagBits = parseInt(sw.dataset.bits, 10) || 0;
                selectedFlagPackage = sw.dataset.package === '1' ? selectedFlagBits : null;
            });
        });
    }

    function renderFieldsPaletteUI() {
        if (!document.getElementById('layer-props')) return;
        const ttl = (HdlTM && HdlTM.MAP_FIELD_DEFAULT_TTL_SEC) || 7 * 24 * 3600;
        const ttlDays = Math.round(ttl / 86400);
        let html = `<div class="mb-2">
            <label class="form-label small text-uppercase text-secondary fw-bold mb-2">Fields</label>
            <div class="d-flex flex-wrap gap-2">`;

        const fields = [
            { color: '#000000', label: 'None', value: 0 },
            { color: '#ff8800', label: 'Fire', value: 1 },
            { color: '#00cc00', label: 'Poison', value: 2 },
            { color: '#aa00ff', label: 'Energy', value: 4 }
        ];

        fields.forEach((f) => {
            html += `<div class="tile-swatch" style="width:24px; height:24px; border-radius:4px; cursor:pointer; border:2px solid transparent; background-color:${f.color};" title="${f.label}" data-color="${f.color}" data-value="${f.value}"></div>`;
        });

        html += `</div>
            <div class="small mt-2 text-muted">Map-seeded fields use long default TTL (~${ttlDays} days). Never written by TileMap bake.</div>
        </div>`;

        document.getElementById('layer-props').innerHTML = html;
        document.querySelectorAll('.tile-swatch').forEach((sw) => {
            sw.addEventListener('click', () => {
                document.querySelectorAll('.tile-swatch').forEach((s) => (s.style.borderColor = 'transparent'));
                sw.style.borderColor = '#0d6efd';
                window.selectedDrawColor = sw.dataset.color;
                selectedFieldValue = parseInt(sw.dataset.value, 10);
            });
        });
    }

    document.querySelectorAll('[data-action="select-layer"]').forEach((el) => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.visibility-toggle')) return;
            selectFloorAndLayer(currentFloor, el.dataset.target);
        });
    });

    document.querySelectorAll('.visibility-toggle').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const suffix = btn.dataset.layerSuffix;
            if (!suffix) return;
            const layerId = layerIdFromSuffix(suffix);
            layerVisibility[layerId] = !(layerVisibility[layerId] !== false);
            updateObjectTreeUI();
            updateVisibility();
        });
    });

    // Floor selector: − / dropdown / + (same pattern as zoom)
    const floorOptions = document.querySelectorAll('.floor-option');
    const floorOutBtn = document.getElementById('floorOutBtn');
    const floorInBtn = document.getElementById('floorInBtn');

    function goToFloor(floorStr) {
        const f = padFloor(floorStr);
        if (f === currentFloor) return;
        selectFloorAndLayer(f, currentLayer || 'spawns');
    }

    floorOptions.forEach((opt) => {
        opt.addEventListener('click', (e) => {
            e.preventDefault();
            floorOptions.forEach((o) => o.classList.remove('active'));
            opt.classList.add('active');
            goToFloor(opt.dataset.floor);
        });
    });
    if (floorOutBtn) {
        floorOutBtn.addEventListener('click', () => {
            const z = Math.max(0, (parseInt(currentFloor, 10) || 0) - 1);
            goToFloor(z);
        });
    }
    if (floorInBtn) {
        floorInBtn.addEventListener('click', () => {
            const z = Math.min(15, (parseInt(currentFloor, 10) || 0) + 1);
            goToFloor(z);
        });
    }

    // updateVisibility has been moved above selectFloorAndLayer

    monsterNameInput.addEventListener('input', () => {
        renderSpawns();
        updateFloorCounts();
        scheduleMinimap();
    });
    const filterOnlyNpcsEl = document.getElementById('filterOnlyNpcs');
    const filterOnlyModifiedEl = document.getElementById('filterOnlyModified');
    if (filterOnlyNpcsEl) {
        filterOnlyNpcsEl.addEventListener('change', () => {
            viewOnlyNpcs = !!filterOnlyNpcsEl.checked;
            renderSpawns();
            updateFloorCounts();
            scheduleMinimap();
        });
    }
    if (filterOnlyModifiedEl) {
        filterOnlyModifiedEl.addEventListener('change', () => {
            viewOnlyModified = !!filterOnlyModifiedEl.checked;
            renderSpawns();
            updateFloorCounts();
            scheduleMinimap();
        });
    }
    const showMapCenterEl = document.getElementById('showMapCenter');
    if (showMapCenterEl) {
        showMapCenterEl.addEventListener('change', () => {
            showMapCenter = !!showMapCenterEl.checked;
            markDirty();
        });
    }

    function updateFloorCounts() {
        const filterText = monsterNameInput.value.toLowerCase().trim();
        const filtering = !!(filterText || viewOnlyNpcs || viewOnlyModified);
        let totalAll = 0;
        let currentCount = 0;

        for (let i = 0; i <= 15; i++) {
            const floor = padFloor(i);
            let count = 0;

            if (filtering && mapSpawnsCache[floor]) {
                for (const spawn of mapSpawnsCache[floor]) {
                    if (matchesFilter(spawn, filterText)) count++;
                }
            }
            if (floor === currentFloor) currentCount = count;
            totalAll += count;
        }

        const countSpan = document.getElementById('floor-count');
        if (countSpan) {
            countSpan.textContent =
                filtering && currentCount > 0 ? '(' + currentCount + ')' : '';
        }
        const worldSpan = document.getElementById('world-count');
        if (worldSpan) {
            const n = (currentMapWorld || []).length;
            worldSpan.textContent = n > 0 ? '(' + n + ')' : '';
        }

        monsterResults.innerHTML = filtering
            ? 'Found ' + totalAll + ' total matches.'
            : '';
    }

    async function loadFloorSpawns(floor) {
        if (!mapSpawnsCache[floor] || !mapWorldCache[floor]) {
            try {
                const docs = await fetchFloorPinDocs(floor);
                if (!mapSpawnsCache[floor]) mapSpawnsCache[floor] = docs.spawns;
                if (!mapWorldCache[floor]) mapWorldCache[floor] = docs.world;
            } catch (e) {
                console.error(e);
                if (!mapSpawnsCache[floor]) mapSpawnsCache[floor] = [];
                if (!mapWorldCache[floor]) mapWorldCache[floor] = [];
            }
        }
        currentMapSpawns = mapSpawnsCache[floor] || [];
        currentMapWorld = mapWorldCache[floor] || [];
        renderSpawns();
    }

    function updateViewPort() {
        const mw = mapPixelWidth();
        const mh = mapPixelHeight();
        if (!mw || !mh) return;
        // Viewport-sized display: visible tile span = client / zoom
        const clientW = imageContainer.clientWidth || (editorCanvas && editorCanvas.width) || 0;
        const clientH = imageContainer.clientHeight || (editorCanvas && editorCanvas.height) || 0;
        viewPortWidth = clientW / zoomValue;
        viewPortHeight = clientH / zoomValue;
        viewPortX = imageContainer.scrollLeft / zoomValue;
        viewPortY = imageContainer.scrollTop / zoomValue;
    }

    window.currentBrushSize = 1;

    /** Last tile painted this freehand stroke (for continuous Bresenham fill). */
    let paintStrokeLast = null;

    /**
     * Inclusive integer line (Bresenham) — same approach as sprite-editor freehand.
     * Prevents gaps when the mouse jumps more than one tile between events.
     */
    function forEachLineCell(x0, y0, x1, y1, plot) {
        let x = x0 | 0;
        let y = y0 | 0;
        const xEnd = x1 | 0;
        const yEnd = y1 | 0;
        const dx = Math.abs(xEnd - x);
        const dy = Math.abs(yEnd - y);
        const sx = x < xEnd ? 1 : -1;
        const sy = y < yEnd ? 1 : -1;
        let err = dx - dy;
        for (;;) {
            plot(x, y);
            if (x === xEnd && y === yEnd) break;
            const e2 = err * 2;
            if (e2 > -dy) {
                err -= dy;
                x += sx;
            }
            if (e2 < dx) {
                err += dx;
                y += sy;
            }
        }
    }

    /**
     * Freehand stamp: single cell, or interpolate a line from the last stroke point.
     */
    function paintStrokeTo(x, y) {
        const cx = Math.floor(x);
        const cy = Math.floor(y);
        if (!paintStrokeLast) {
            drawPen(cx, cy);
            paintStrokeLast = { x: cx, y: cy };
            return;
        }
        if (paintStrokeLast.x === cx && paintStrokeLast.y === cy) return;
        const lx = paintStrokeLast.x;
        const ly = paintStrokeLast.y;
        forEachLineCell(lx, ly, cx, cy, (px, py) => {
            // Skip the first point of the segment (already stamped as stroke last)
            if (px === lx && py === ly) return;
            drawPen(px, py);
        });
        paintStrokeLast = { x: cx, y: cy };
    }

    function drawPen(x, y) {
        const size = window.currentBrushSize || 1;
        const shape = window.currentBrushShape || 'square';
        const cx = Math.floor(x);
        const cy = Math.floor(y);

        const half = Math.max(0, Math.floor(size / 2));
        const brushRect = {
            x0: cx - half,
            y0: cy - half,
            x1: cx + half,
            y1: cy + half
        };

        // TileMap authoring path — live preview only (bake + channel sync on mouseup)
        if (isTileMapLayer(currentLayer) && tilemapSession) {
            const sub = tileMapSubFromLayer(currentLayer) || tilemapSession.activeSubLayer;
            tilemapSession.paintAt(cx, cy, {
                size,
                shape,
                erase: tilemapEraseMode,
                stamp: tilemapEraseMode ? null : tilemapSession.selectedStamp,
                subLayer: sub
            });
            syncCanvasesFromSession(brushRect, { layers: ['tilemap'] });
            return;
        }

        // Channel overrides via session when available
        if (tilemapSession && ['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) {
            if (currentLayer === 'friction' && window.selectedFrictionValue != null) {
                tilemapSession.paintChannel('friction', cx, cy, window.selectedFrictionValue, { size, shape });
                syncCanvasesFromSession(brushRect, { layers: ['friction'] });
                return;
            }
            if (currentLayer === 'sight' && window.selectedDrawColor) {
                const hex = window.selectedDrawColor.replace('#', '');
                const v = hex.length === 6 ? parseInt(hex.slice(0, 2), 16) : 0;
                tilemapSession.paintChannel('sight', cx, cy, v, { size, shape });
                syncCanvasesFromSession(brushRect, { layers: ['sight'] });
                return;
            }
            if (currentLayer === 'flags' && selectedFlagBits != null) {
                if (selectedFlagPackage != null) {
                    tilemapSession.paintChannel('flags', cx, cy, selectedFlagBits ? 1 : 0, {
                        size,
                        shape,
                        packageBits: selectedFlagPackage
                    });
                } else {
                    tilemapSession.paintChannel('flags', cx, cy, selectedFlagBits, { size, shape });
                }
                syncCanvasesFromSession(brushRect, { layers: ['flags'] });
                return;
            }
            if (currentLayer === 'fields' && selectedFieldValue != null) {
                tilemapSession.paintChannel('fields', cx, cy, selectedFieldValue, { size, shape });
                syncCanvasesFromSession(brushRect, { layers: ['fields'] });
                return;
            }
        }

        if (!['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) return;
        if (!window.selectedDrawColor) return;

        ensureWorldCanvas(mapPixelWidth(), mapPixelHeight());
        
        let minX = -Infinity, minY = -Infinity, maxX = Infinity, maxY = Infinity;
        if (selectionRect) {
            minX = Math.floor(selectionRect.x);
            minY = Math.floor(selectionRect.y);
            maxX = Math.floor(selectionRect.x + selectionRect.w);
            maxY = Math.floor(selectionRect.y + selectionRect.h);
        }

        const paintCtx = worldCanvas.getContext('2d');
        paintCtx.fillStyle = window.selectedDrawColor;

        const plot = (px, py) => {
            if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
                paintCtx.fillRect(px, py, 1, 1);
            }
        };

        const s = Math.max(1, size | 0);
        
        if (s === 1) {
            plot(cx, cy);
            markDirty();
            return;
        }
        
        // Reuse `half` declared above (same Math.floor(size/2) as for brushRect)
        const x0 = cx - half;
        const y0 = cy - half;

        if (shape === 'circle') {
            const r = (s - 1) / 2;
            const r2 = r * r + 0.25;
            for (let dy = 0; dy < s; dy++) {
                for (let dx = 0; dx < s; dx++) {
                    const fx = dx - r;
                    const fy = dy - r;
                    if (fx * fx + fy * fy <= r2) plot(x0 + dx, y0 + dy);
                }
            }
        } else if (shape === 'diamond') {
            const r = Math.floor((s - 1) / 2);
            for (let dy = 0; dy < s; dy++) {
                for (let dx = 0; dx < s; dx++) {
                    if (Math.abs(dx - half) + Math.abs(dy - half) <= r) {
                        plot(x0 + dx, y0 + dy);
                    }
                }
            }
        } else if (shape === 'cross') {
            for (let i = 0; i < s; i++) {
                plot(x0 + half, y0 + i);
                plot(x0 + i, y0 + half);
            }
        } else if (shape === 'dither') {
            for (let dy = 0; dy < s; dy++) {
                for (let dx = 0; dx < s; dx++) {
                    const px = x0 + dx;
                    const py = y0 + dy;
                    if (((px + py) & 1) === 0) plot(px, py);
                }
            }
        } else if (shape === 'spray') {
            const r = (s - 1) / 2;
            const r2 = r * r + 0.25;
            for (let dy = 0; dy < s; dy++) {
                for (let dx = 0; dx < s; dx++) {
                    const fx = dx - r;
                    const fy = dy - r;
                    if (fx * fx + fy * fy > r2) continue;
                    const px = x0 + dx;
                    const py = y0 + dy;
                    let h = (px * 374761393 + py * 668265263) | 0;
                    h = (h ^ (h >>> 13)) * 1274126177;
                    if ((h & 255) > 170) plot(px, py);
                }
            }
        } else { // square
            for (let dy = 0; dy < s; dy++) {
                for (let dx = 0; dx < s; dx++) {
                    plot(x0 + dx, y0 + dy);
                }
            }
        }
        markDirty();
    }
    
    function onPaintMove(e) {
        if (!window.isPainting) return;
        const rect = imageContainer.getBoundingClientRect();
        const localX = Math.floor((e.clientX - rect.left + imageContainer.scrollLeft) / zoomValue);
        const localY = Math.floor((e.clientY - rect.top + imageContainer.scrollTop) / zoomValue);
        paintStrokeTo(localX, localY);
    }
    
    function onPaintUp(e) {
        window.isPainting = false;
        paintStrokeLast = null;
        document.removeEventListener('mousemove', onPaintMove);
        document.removeEventListener('mouseup', onPaintUp);
        markDirty();
        if (tilemapSession) {
            if (isTileMapLayer(currentLayer)) {
                const { rect } = tilemapSession.endStroke();
                // After bake: update tilemap preview + derived channels in the stroke rect only
                if (rect) {
                    syncCanvasesFromSession(rect, {
                        layers: ['tilemap', 'friction', 'sight', 'flags']
                    });
                }
                updateUndoRedoUI();
            } else if (['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) {
                // Channel drag uses beginStroke…paintChannel…endStroke
                const { rect } = tilemapSession.endStroke();
                if (rect) {
                    syncCanvasesFromSession(rect, { layers: [currentLayer] });
                }
                updateUndoRedoUI();
            }
        }
        setDirty(true);
    }

    function applyBucket(x, y) {
        if (isTileMapLayer(currentLayer) && tilemapSession) {
            const sub = tileMapSubFromLayer(currentLayer) || tilemapSession.activeSubLayer;
            const { rect } = tilemapSession.bucketFill(Math.floor(x), Math.floor(y), {
                erase: tilemapEraseMode,
                stamp: tilemapEraseMode ? null : tilemapSession.selectedStamp,
                subLayer: sub
            });
            if (rect) {
                syncCanvasesFromSession(rect, {
                    layers: ['tilemap', 'friction', 'sight', 'flags']
                });
            }
            updateUndoRedoUI();
            setDirty(true);
            return;
        }
        if (!['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) return;
        if (!window.selectedDrawColor) return;

        ensureWorldCanvas(mapPixelWidth(), mapPixelHeight());
        const width = worldCanvas.width;
        const height = worldCanvas.height;
        
        let minX = 0, minY = 0, maxX = width - 1, maxY = height - 1;
        if (selectionRect) {
            minX = Math.max(0, Math.floor(selectionRect.x));
            minY = Math.max(0, Math.floor(selectionRect.y));
            maxX = Math.min(width - 1, Math.floor(selectionRect.x + selectionRect.w) - 1);
            maxY = Math.min(height - 1, Math.floor(selectionRect.y + selectionRect.h) - 1);
            if (x < minX || x > maxX || y < minY || y > maxY) return;
        }
        
        const ctx = worldCanvas.getContext('2d', { willReadFrequently: true });
        const imgData = ctx.getImageData(0, 0, width, height);
        const data = imgData.data;
        
        const startIndex = (y * width + x) * 4;
        const startR = data[startIndex];
        const startG = data[startIndex + 1];
        const startB = data[startIndex + 2];
        const startA = data[startIndex + 3];
        
        const offscreen = document.createElement('canvas');
        offscreen.width = 1; offscreen.height = 1;
        const oCtx = offscreen.getContext('2d');
        oCtx.fillStyle = window.selectedDrawColor;
        oCtx.fillRect(0,0,1,1);
        const targetColor = oCtx.getImageData(0,0,1,1).data;
        const tr = targetColor[0], tg = targetColor[1], tb = targetColor[2], ta = targetColor[3];
        
        if (startR === tr && startG === tg && startB === tb && startA === ta) return;
        
        const stack = [[x, y]];
        
        while (stack.length > 0) {
            const [cx, cy] = stack.pop();
            const idx = (cy * width + cx) * 4;
            
            if (data[idx] === startR && data[idx+1] === startG && data[idx+2] === startB && data[idx+3] === startA) {
                data[idx] = tr;
                data[idx+1] = tg;
                data[idx+2] = tb;
                data[idx+3] = ta;
                
                if (cx > minX) stack.push([cx - 1, cy]);
                if (cx < maxX) stack.push([cx + 1, cy]);
                if (cy > minY) stack.push([cx, cy - 1]);
                if (cy < maxY) stack.push([cx, cy + 1]);
            }
        }
        
        ctx.putImageData(imgData, 0, 0);
        setDirty(true);
        markDirty();
    }

    function resolveSpawnArt(spawn) {
        const rawName = spawn.legacyName || spawn.creatureId || '';
        let artId = spawn.creatureId || rawName;
        let genre = 'rpg_fantasy';
        const std = standardPresets[spawn.creatureId];
        if (std) {
            artId =
                std.customSprite || std.spriteId || std.id || artId;
            genre =
                std.customSpriteGenre ||
                std.customGenre ||
                std.spriteGenre ||
                std.genre ||
                genre;
        }
        const stem = spriteStem(artId);
        const standardUrl =
            ASSET_ROOT +
            'assets/sprites/' +
            genre +
            '/creatures/icon/' +
            stem +
            '.png';
        return { standardUrl };
    }

    function drawImageForSpawn(art, cx, cy, drawCtx) {
        const g = drawCtx || ctx;
        if (!g) return;
        let img = imageCache.get(art.standardUrl);
        if (!img) {
            img = { image: new Image(), loaded: false, error: false };
            img.image.onload = () => { img.loaded = true; markDirty(); };
            img.image.onerror = () => {
                img.error = true;
                markDirty();
            };
            img.image.src = art.standardUrl;
            imageCache.set(art.standardUrl, img);
        }

        if (img.loaded) {
            const w = img.image.naturalWidth || 32;
            const h = img.image.naturalHeight || 32;
            g.drawImage(img.image, cx, cy, w, h);
        } else if (img.error) {
            g.fillStyle = 'red';
            g.strokeStyle = 'white';
            g.lineWidth = 1;
            g.beginPath();
            g.arc(cx, cy, 3, 0, 2 * Math.PI);
            g.fill();
            g.stroke();
        }
    }

    /**
     * HUD cross at the current viewport center (display space).
     * @param {CanvasRenderingContext2D} overlayCtx
     * @param {number} viewW
     * @param {number} viewH
     */
    function drawMapCenterMark(overlayCtx, viewW, viewH) {
        const screenX = viewW * 0.5;
        const screenY = viewH * 0.5;
        const arm = 18;
        overlayCtx.save();
        overlayCtx.lineCap = 'square';
        overlayCtx.strokeStyle = '#1a0a12';
        overlayCtx.lineWidth = 4;
        overlayCtx.beginPath();
        overlayCtx.moveTo(screenX - arm, screenY);
        overlayCtx.lineTo(screenX + arm, screenY);
        overlayCtx.moveTo(screenX, screenY - arm);
        overlayCtx.lineTo(screenX, screenY + arm);
        overlayCtx.stroke();
        overlayCtx.strokeStyle = '#ff40a0';
        overlayCtx.lineWidth = 2;
        overlayCtx.beginPath();
        overlayCtx.moveTo(screenX - arm, screenY);
        overlayCtx.lineTo(screenX + arm, screenY);
        overlayCtx.moveTo(screenX, screenY - arm);
        overlayCtx.lineTo(screenX, screenY + arm);
        overlayCtx.stroke();
        overlayCtx.fillStyle = '#ff40a0';
        overlayCtx.strokeStyle = '#1a0a12';
        overlayCtx.lineWidth = 1;
        overlayCtx.beginPath();
        overlayCtx.arc(screenX, screenY, 2.5, 0, Math.PI * 2);
        overlayCtx.fill();
        overlayCtx.stroke();
        overlayCtx.restore();
    }

    /**
     * Screen-space tools + spawns on the viewport display (after world blit).
     * @param {CanvasRenderingContext2D} dctx
     * @param {{ zoom: number, scrollLeft: number, scrollTop: number, viewWidth?: number, viewHeight?: number }} info
     */
    function drawDisplayOverlay(dctx, info) {
        if (!dctx) return;
        const overlayCtx = dctx;
        const scrollLeft = info && info.scrollLeft != null ? info.scrollLeft : imageContainer.scrollLeft;
        const scrollTop = info && info.scrollTop != null ? info.scrollTop : imageContainer.scrollTop;
        const z = info && info.zoom > 0 ? info.zoom : zoomValue;
        const viewW = info && info.viewWidth != null ? info.viewWidth : (canvas ? canvas.width : 0);
        const viewH = info && info.viewHeight != null ? info.viewHeight : (canvas ? canvas.height : 0);
        if (viewW === 0 || viewH === 0) return;

        updateViewPort();
        // Note: world already cleared+blitted; only draw overlays here.

        if (window.showGrid) {
            overlayCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            overlayCtx.lineWidth = 1;
            overlayCtx.beginPath();

            const startXLocal = Math.max(0, Math.floor(scrollLeft / z));
            const startYLocal = Math.max(0, Math.floor(scrollTop / z));
            const endXLocal = Math.ceil((scrollLeft + viewW) / z);
            const endYLocal = Math.ceil((scrollTop + viewH) / z);

            for (let x = startXLocal; x <= endXLocal; x++) {
                const screenX = Math.round((x * z) - scrollLeft);
                overlayCtx.moveTo(screenX, 0);
                overlayCtx.lineTo(screenX, viewH);
            }
            for (let y = startYLocal; y <= endYLocal; y++) {
                const screenY = Math.round((y * z) - scrollTop);
                overlayCtx.moveTo(0, screenY);
                overlayCtx.lineTo(viewW, screenY);
            }
            overlayCtx.stroke();
        }

        if (showMapCenter) {
            drawMapCenterMark(overlayCtx, viewW, viewH);
        }

        if (selectionRect) {
            const sx = (selectionRect.x * z) - scrollLeft;
            const sy = (selectionRect.y * z) - scrollTop;
            const sw = selectionRect.w * z;
            const sh = selectionRect.h * z;
            overlayCtx.fillStyle = 'rgba(13, 110, 253, 0.2)';
            overlayCtx.fillRect(sx, sy, sw, sh);
            overlayCtx.strokeStyle = 'rgba(13, 110, 253, 0.8)';
            overlayCtx.lineWidth = 1;
            overlayCtx.setLineDash([4, 4]);
            overlayCtx.strokeRect(sx, sy, sw, sh);
            overlayCtx.setLineDash([]);
        }

        if (
            layerVisibility[`floor-${currentFloor}`] &&
            layerVisibility[`floor-${currentFloor}-flags`] &&
            flagsIconsActive(z) &&
            tilemapSession &&
            tilemapSession.floor &&
            tilemapSession.floor.flags
        ) {
            const iconUnicodes = ensureFlagIconUnicodes();
            const cols = tilemapSession.cols;
            const rows = tilemapSession.rows;
            const flagsArr = tilemapSession.floor.flags;
            const startXLocal = Math.max(0, Math.floor(scrollLeft / z));
            const startYLocal = Math.max(0, Math.floor(scrollTop / z));
            const endXLocal = Math.min(cols, Math.ceil((scrollLeft + viewW) / z));
            const endYLocal = Math.min(rows, Math.ceil((scrollTop + viewH) / z));

            if (iconUnicodes && Object.keys(iconUnicodes).length) {
                overlayCtx.font = `900 ${Math.max(12, z * 0.7)}px "Font Awesome 6 Free"`;
                overlayCtx.textAlign = 'center';
                overlayCtx.textBaseline = 'middle';

                for (let y = startYLocal; y < endYLocal; y++) {
                    for (let x = startXLocal; x < endXLocal; x++) {
                        const bits = flagsArr[y * cols + x] & 0xff;
                        if (!bits) continue;
                        const hex = HdlTM ? HdlTM.flagsPreviewColor(bits) : null;
                        const glyph = hex ? iconUnicodes[hex] : '';
                        if (!glyph) continue;
                        const screenX = x * z - scrollLeft + z / 2;
                        const screenY = y * z - scrollTop + z / 2;
                        overlayCtx.fillStyle = hex;
                        overlayCtx.strokeStyle = '#000000';
                        overlayCtx.lineWidth = 2;
                        overlayCtx.strokeText(glyph, screenX, screenY);
                        overlayCtx.fillText(glyph, screenX, screenY);
                    }
                }
            }
        }

        if (!layerVisibility[`floor-${currentFloor}`]) {
            return;
        }

        const filterText = monsterNameInput.value.toLowerCase().trim();

        if (layerVisibility[`floor-${currentFloor}-spawns`]) {
        for (const spawn of currentMapSpawns) {
            if (!matchesFilter(spawn, filterText)) continue;

            const x = Number(spawn.x);
            const y = Number(spawn.y);

            const screenX = (x * z) - scrollLeft;
            const screenY = (y * z) - scrollTop;

            if (screenX < -100 || screenX > viewW + 100 || screenY < -100 || screenY > viewH + 100) {
                continue;
            }

            if (selectedMapSpawns.includes(spawn) || spawn === selectedMapSpawn) {
                overlayCtx.fillStyle = 'rgba(255, 255, 0, 0.4)';
                overlayCtx.fillRect(screenX, screenY, 32, 32);
                overlayCtx.strokeStyle = '#ffff00';
                overlayCtx.lineWidth = 2;
                overlayCtx.strokeRect(screenX, screenY, 32, 32);
            } else if (HdlTM && typeof HdlTM.spawnIsNpc === 'function' && HdlTM.spawnIsNpc(spawn, standardPresets)) {
                overlayCtx.strokeStyle = '#44ddee';
                overlayCtx.lineWidth = 1;
                overlayCtx.strokeRect(screenX + 0.5, screenY + 0.5, 31, 31);
            }

            const art = resolveSpawnArt(spawn);
            drawImageForSpawn(art, screenX, screenY, overlayCtx);
        }
        }

        if (!layerVisibility[`floor-${currentFloor}-world`]) {
            return;
        }

        const worldFilter = monsterNameInput.value.toLowerCase().trim();
        for (const pin of currentMapWorld) {
            if (worldFilter && HdlTM && typeof HdlTM.worldMatchesQuery === 'function') {
                if (!HdlTM.worldMatchesQuery(pin, worldFilter)) continue;
            } else if (worldFilter) {
                const blob = ((pin.catalogId || '') + ' ' + (pin.id || '') + ' ' + (pin.kind || '')).toLowerCase();
                if (blob.indexOf(worldFilter) === -1) continue;
            }
            const x = Number(pin.x);
            const y = Number(pin.y);
            const screenX = (x * z) - scrollLeft;
            const screenY = (y * z) - scrollTop;
            if (screenX < -100 || screenX > viewW + 100 || screenY < -100 || screenY > viewH + 100) {
                continue;
            }
            const selected = selectedWorldPins.includes(pin) || pin === selectedWorldPin;
            overlayCtx.fillStyle = selected ? 'rgba(80, 220, 110, 0.45)' : 'rgba(80, 220, 110, 0.18)';
            overlayCtx.fillRect(screenX, screenY, 32, 32);
            overlayCtx.strokeStyle = selected ? '#50dc6e' : '#2a8a44';
            overlayCtx.lineWidth = selected ? 2 : 1;
            overlayCtx.strokeRect(screenX + 0.5, screenY + 0.5, 31, 31);
            const art = resolveWorldArt(pin);
            drawImageForSpawn(art, screenX, screenY, overlayCtx);
        }
    }

    function resolveWorldArt(pin) {
        const id = pin && pin.catalogId;
        const kind = (pin && pin.catalogKind) || 'objects';
        const genre = tilemapArtGenre || 'rpg_fantasy';
        if (!id) {
            return { standardUrl: '', fallbackUrl: '' };
        }
        let rel = null;
        if (HdlTM && typeof HdlTM.resolveSpriteRelPath === 'function') {
            rel = HdlTM.resolveSpriteRelPath({
                genre,
                kind: kind === 'equipment' ? 'equipment' : 'objects',
                id,
                variant: 'icon'
            });
        }
        const url = rel ? ASSET_ROOT + rel : '';
        return { standardUrl: url, fallbackUrl: url };
    }

    /** @deprecated residual name — routes to overlay */
    function drawCanvas() {
        if (!ctx || !canvas) return;
        drawDisplayOverlay(ctx, {
            zoom: zoomValue,
            scrollLeft: imageContainer.scrollLeft,
            scrollTop: imageContainer.scrollTop,
            viewWidth: canvas.width,
            viewHeight: canvas.height
        });
    }

    function renderSpawns() {
        markDirty();
    }

    function renderPaletteUI() {
        if (!document.getElementById('layer-props')) return;
        let html = `<div class="mb-2">
            <label class="form-label small text-uppercase text-secondary fw-bold mb-1">Palette</label>
            <div class="d-flex gap-1 mb-2">
                <input type="text" id="palette-input" list="monsterDatalist" class="form-control form-control-sm bg-black border-secondary text-white" placeholder="Monster name...">
                <button class="btn btn-sm btn-outline-primary" id="btn-add-palette"><i class="fa-solid fa-plus"></i></button>
            </div>
            <div class="palette-container d-flex flex-wrap gap-1 mb-2">`;
        
        mapPalette.forEach((item, index) => {
            const isSelected = (selectedPaletteItem === item);
            const label = item.name || item.id || '';
            const slug = paletteItemId(item);
            html += `<button class="btn btn-sm ${isSelected ? 'btn-primary' : 'btn-outline-secondary'} palette-item-btn" data-index="${index}" title="${slug}">${label}</button>`;
        });
        
        html += `</div>
            <div class="small">
                <strong>Selected:</strong> ${selectedPaletteItem ? (selectedPaletteItem.name || selectedPaletteItem.id) : 'None'}
                ${selectedPaletteItem ? '<span class="text-secondary">(' + paletteItemId(selectedPaletteItem) + ')</span>' : ''}
            </div>
        </div>`;
        
        document.getElementById('layer-props').innerHTML = html;
        
        document.getElementById('btn-add-palette').addEventListener('click', () => {
            const val = document.getElementById('palette-input').value.trim();
            if (!val) return;
            const item = resolvePaletteItem(val);
            if (!mapPalette.find((m) => paletteItemId(m) === item.id)) {
                mapPalette.push(item);
                renderPaletteUI();
            }
        });
        
        document.querySelectorAll('.palette-item-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = e.target.closest('.palette-item-btn').dataset.index;
                selectedPaletteItem = mapPalette[idx];
                selectedMapSpawn = null;
                renderPaletteUI();
                renderSpawnProperties();
            });
        });
    }

    function worldCatalogLabel(id) {
        const row = worldCatalog[id];
        return (row && row.label) || id || '';
    }

    function resolveWorldPaletteItem(raw) {
        const text = String(raw || '').trim();
        if (!text) return null;
        if (worldCatalog[text]) {
            const row = worldCatalog[text];
            return { id: row.id, name: row.label, catalogKind: row.kind };
        }
        const lower = text.toLowerCase();
        const ids = Object.keys(worldCatalog);
        for (let i = 0; i < ids.length; i++) {
            const row = worldCatalog[ids[i]];
            if (!row) continue;
            if (String(row.label || '').toLowerCase() === lower) {
                return { id: row.id, name: row.label, catalogKind: row.kind };
            }
        }
        const slug = HdlTM && typeof HdlTM.slugifyWorldId === 'function'
            ? HdlTM.slugifyWorldId(text)
            : text.toLowerCase().replace(/[^a-z0-9]+/g, '_');
        return { id: slug, name: text, catalogKind: 'objects' };
    }

    function renderWorldPaletteUI() {
        if (!document.getElementById('layer-props')) return;
        const kinds = (HdlTM && HdlTM.WORLD_KINDS) || [
            'container', 'chest', 'lever', 'door', 'teleport', 'switch', 'trap', 'harvest'
        ];
        let kindOpts = '';
        for (let i = 0; i < kinds.length; i++) {
            const k = kinds[i];
            kindOpts += '<option value="' + k + '"' +
                (k === selectedWorldKind ? ' selected' : '') + '>' + k + '</option>';
        }
        let html = `<div class="mb-2">
            <label class="form-label small text-uppercase text-secondary fw-bold mb-1">World palette</label>
            <div class="d-flex gap-1 mb-2">
                <select id="world-kind-select" class="form-select form-select-sm bg-black border-secondary text-white" style="max-width:7.5rem;">${kindOpts}</select>
                <input type="text" id="world-palette-input" list="worldCatalogDatalist" class="form-control form-control-sm bg-black border-secondary text-white" placeholder="catalog id…">
                <button class="btn btn-sm btn-outline-primary" id="btn-add-world-palette"><i class="fa-solid fa-plus"></i></button>
            </div>
            <datalist id="worldCatalogDatalist"></datalist>
            <div class="palette-container d-flex flex-wrap gap-1 mb-2">`;
        worldPalette.forEach((item, index) => {
            const isSelected = selectedWorldPalette === item;
            const label = item.name || item.id || '';
            html += `<button class="btn btn-sm ${isSelected ? 'btn-primary' : 'btn-outline-secondary'} world-palette-item-btn" data-index="${index}" title="${item.id}">${label}</button>`;
        });
        html += `</div>
            <div class="small">
                <strong>Kind:</strong> ${selectedWorldKind}
                · <strong>Stamp:</strong> ${selectedWorldPalette ? (selectedWorldPalette.name || selectedWorldPalette.id) : 'None'}
            </div>
            <div class="small text-secondary mt-1">Click the map to place. Inspectors author container / chest / lever / door / teleport / trap / harvest fields.</div>
        </div>`;
        document.getElementById('layer-props').innerHTML = html;
        fillWorldCatalogDatalist();
        const kindSel = document.getElementById('world-kind-select');
        if (kindSel) {
            kindSel.addEventListener('change', () => {
                selectedWorldKind = kindSel.value || 'container';
                renderWorldPaletteUI();
            });
        }
        const addBtn = document.getElementById('btn-add-world-palette');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const el = document.getElementById('world-palette-input');
                const val = el ? el.value.trim() : '';
                if (!val) return;
                const item = resolveWorldPaletteItem(val);
                if (item && !worldPalette.find((m) => m.id === item.id)) {
                    worldPalette.push(item);
                    selectedWorldPalette = item;
                    renderWorldPaletteUI();
                }
            });
        }
        document.querySelectorAll('.world-palette-item-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const idx = e.target.closest('.world-palette-item-btn').dataset.index;
                selectedWorldPalette = worldPalette[idx];
                selectedWorldPin = null;
                selectedWorldPins = [];
                renderWorldPaletteUI();
                renderWorldProperties();
            });
        });
    }

    function makeNewWorldPin(x, y, catalogId) {
        const z = parseInt(currentFloor, 10) || 0;
        const used = HdlTM && typeof HdlTM.normalizeWorldList === 'function'
            ? currentMapWorld.map((p) => p && p.id).filter(Boolean)
            : [];
        const cat = worldCatalog[catalogId];
        const raw = {
            catalogId,
            catalogKind: cat && cat.kind ? cat.kind : (selectedWorldPalette && selectedWorldPalette.catalogKind) || 'objects',
            kind: selectedWorldKind,
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
            z
        };
        if (HdlTM && typeof HdlTM.makeEditorWorldPin === 'function') {
            return HdlTM.makeEditorWorldPin(raw, worldCatalog, {
                z,
                kind: selectedWorldKind,
                usedIds: used
            });
        }
        return raw;
    }

    function renderWorldItemRows(items) {
        const list = Array.isArray(items) ? items : [];
        let html = '';
        for (let i = 0; i < list.length; i++) {
            const row = list[i];
            html += `<div class="d-flex gap-1 mb-1 world-item-row" data-index="${i}">
                <input type="text" class="form-control form-control-sm bg-black border-secondary text-white world-item-id" list="worldCatalogDatalist" value="${escapeHtml(row.item || '')}" placeholder="item id">
                <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-item-count" min="1" value="${row.count != null ? row.count : 1}" style="max-width:4.5rem;">
                <button type="button" class="btn btn-sm btn-outline-danger world-item-del" data-index="${i}">×</button>
            </div>`;
        }
        return html;
    }

    function readWorldItemRows(root) {
        if (!root) return [];
        const rows = [];
        root.querySelectorAll('.world-item-row').forEach((el) => {
            const idEl = el.querySelector('.world-item-id');
            const cEl = el.querySelector('.world-item-count');
            const item = idEl ? String(idEl.value || '').trim() : '';
            if (!item) return;
            let count = cEl ? Math.floor(Number(cEl.value)) : 1;
            if (!Number.isFinite(count) || count < 1) count = 1;
            rows.push({ item, count });
        });
        return rows;
    }

    function renderWorldSetRows(set) {
        const bag = set && typeof set === 'object' && !Array.isArray(set) ? set : {};
        const keys = Object.keys(bag);
        let html = '';
        for (let i = 0; i < keys.length; i++) {
            html += `<div class="d-flex gap-1 mb-1 world-set-row">
                <input type="text" class="form-control form-control-sm bg-black border-secondary text-white world-set-key" value="${escapeHtml(keys[i])}" placeholder="storage key">
                <input type="text" class="form-control form-control-sm bg-black border-secondary text-white world-set-value" value="${escapeHtml(String(bag[keys[i]]))}" placeholder="value" style="max-width:6rem;">
                <button type="button" class="btn btn-sm btn-outline-danger world-set-del">×</button>
            </div>`;
        }
        return html;
    }

    function readWorldSetRows(root) {
        if (!root) return {};
        const out = {};
        root.querySelectorAll('.world-set-row').forEach((el) => {
            const kEl = el.querySelector('.world-set-key');
            const vEl = el.querySelector('.world-set-value');
            const key = kEl ? String(kEl.value || '').trim() : '';
            if (!key) return;
            let value = vEl ? String(vEl.value || '').trim() : '1';
            if (value !== '' && value !== 'true' && value !== 'false' && Number.isFinite(Number(value))) {
                value = Number(value);
            } else if (value === '') {
                value = 1;
            }
            out[key] = value;
        });
        return out;
    }

    function chestOnceStorage(pin) {
        const once = pin && pin.once;
        if (once == null) return '';
        if (typeof once === 'string' || typeof once === 'number') return String(once);
        const clause = Array.isArray(once)
            ? once.find((c) => c && (c.storage || c.key))
            : once;
        if (!clause) return '';
        return String(clause.storage || clause.key || '');
    }

    function chestOnceEq(pin) {
        const once = pin && pin.once;
        if (!once || typeof once !== 'object') return 0;
        const clause = Array.isArray(once) ? once[0] : once;
        if (!clause) return 0;
        if (clause.eq !== undefined) return clause.eq;
        if (clause.equals !== undefined) return clause.equals;
        return 0;
    }

    function chestWhenFields(pin) {
        const when = pin && pin.when;
        const clause = Array.isArray(when)
            ? when.find((c) => c && (c.item || c.itemId))
            : when;
        if (!clause || typeof clause !== 'object') return { item: '', min: 1 };
        return {
            item: String(clause.item || clause.itemId || ''),
            min: clause.min != null ? clause.min : 1
        };
    }

    function leverStatesText(pin) {
        const s = pin && Array.isArray(pin.states) && pin.states.length ? pin.states : ['off', 'on'];
        return s.join(',');
    }

    function doorGateWhen(pin) {
        const g = pin && pin.gate;
        if (!g || typeof g !== 'object') return null;
        if (g.when != null) return g.when;
        if (g.storage || g.item || g.itemId || g.key) return g;
        return null;
    }

    function doorGateFields(pin) {
        const g = pin && pin.gate && typeof pin.gate === 'object' ? pin.gate : null;
        const when = doorGateWhen(pin);
        const storageClause = Array.isArray(when)
            ? when.find((c) => c && (c.storage || c.key))
            : when && (when.storage || when.key) ? when : null;
        const itemClause = Array.isArray(when)
            ? when.find((c) => c && (c.item || c.itemId))
            : when && (when.item || when.itemId) ? when : null;
        let eq = 0;
        if (storageClause) {
            if (storageClause.eq !== undefined) eq = storageClause.eq;
            else if (storageClause.equals !== undefined) eq = storageClause.equals;
        }
        return {
            storage: storageClause ? String(storageClause.storage || storageClause.key || '') : '',
            eq,
            item: itemClause ? String(itemClause.item || itemClause.itemId || '') : '',
            min: itemClause && itemClause.min != null ? itemClause.min : 1,
            level: g && g.level != null ? g.level : ''
        };
    }

    function teleportToFields(pin) {
        const to = pin && pin.to && typeof pin.to === 'object' ? pin.to : null;
        return {
            x: to && to.x != null ? to.x : '',
            y: to && to.y != null ? to.y : '',
            z: to && to.z != null ? to.z : (pin && pin.z != null ? pin.z : 0)
        };
    }

    function dropSpawnWaveMix(effects) {
        const list = Array.isArray(effects) ? effects : [];
        const out = [];
        let hasSpawn = false;
        let hasWave = false;
        for (let i = 0; i < list.length; i++) {
            const row = list[i];
            const t = row && row.type;
            if (t === 'spawn') {
                if (hasWave) continue;
                hasSpawn = true;
            } else if (t === 'wave') {
                if (hasSpawn) continue;
                hasWave = true;
            }
            out.push(row);
        }
        return out;
    }

    function renderWorldEffectRows(effects) {
        const list = Array.isArray(effects) ? effects : [];
        let html = '';
        for (let i = 0; i < list.length; i++) {
            const row = list[i] || {};
            if (row.type === 'door') {
                html += `<div class="d-flex flex-wrap gap-1 mb-1 align-items-center world-effect-row" data-type="door" data-index="${i}">
                    <span class="small text-secondary" style="min-width:2.4rem;">door</span>
                    <input type="text" class="form-control form-control-sm bg-black border-secondary text-white world-effect-door-id" value="${escapeHtml(row.id || '')}" placeholder="pin id">
                    <div class="form-check mb-0">
                        <input class="form-check-input world-effect-open" type="checkbox" ${row.open !== false ? 'checked' : ''}>
                        <label class="form-check-label small">Open</label>
                    </div>
                    <button type="button" class="btn btn-sm btn-outline-danger world-effect-del">×</button>
                </div>`;
            } else if (row.type === 'spawn') {
                html += `<div class="d-flex flex-wrap gap-1 mb-1 align-items-center world-effect-row" data-type="spawn" data-index="${i}">
                    <span class="small text-secondary" style="min-width:2.4rem;">spawn</span>
                    <input type="text" class="form-control form-control-sm bg-black border-secondary text-white world-effect-creature" value="${escapeHtml(row.creatureId || '')}" placeholder="creature id" style="max-width:8rem;">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-x" value="${row.x != null ? row.x : ''}" placeholder="x" style="max-width:4.5rem;" title="x">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-y" value="${row.y != null ? row.y : ''}" placeholder="y" style="max-width:4.5rem;" title="y">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-z" value="${row.z != null ? row.z : ''}" placeholder="z" style="max-width:4rem;" title="z">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-count" min="1" value="${row.count != null ? row.count : 1}" placeholder="n" style="max-width:4rem;" title="count">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-respawn" min="0" value="${row.respawn != null ? row.respawn : 0}" placeholder="respawn" style="max-width:4.5rem;" title="respawn sec">
                    <button type="button" class="btn btn-sm btn-outline-danger world-effect-del">×</button>
                </div>`;
            } else if (row.type === 'wave') {
                html += `<div class="d-flex flex-wrap gap-1 mb-1 align-items-center world-effect-row" data-type="wave" data-index="${i}">
                    <span class="small text-secondary" style="min-width:2.4rem;">wave</span>
                    <input type="text" class="form-control form-control-sm bg-black border-secondary text-white world-effect-wave-id" value="${escapeHtml(row.id || '')}" placeholder="wave id (optional)">
                    <button type="button" class="btn btn-sm btn-outline-danger world-effect-del">×</button>
                </div>`;
            } else if (row.type === 'unlock') {
                html += `<div class="d-flex flex-wrap gap-1 mb-1 align-items-center world-effect-row" data-type="unlock" data-index="${i}">
                    <span class="small text-secondary" style="min-width:2.4rem;">unlock</span>
                    <input type="text" class="form-control form-control-sm bg-black border-secondary text-white world-effect-unlock-id" value="${escapeHtml(row.id || '')}" placeholder="door id (empty = waves)">
                    <button type="button" class="btn btn-sm btn-outline-danger world-effect-del">×</button>
                </div>`;
            } else {
                const fr = row.friction != null ? row.friction : '';
                html += `<div class="d-flex flex-wrap gap-1 mb-1 align-items-center world-effect-row" data-type="cell" data-index="${i}">
                    <span class="small text-secondary" style="min-width:2.4rem;">cell</span>
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-x" value="${row.x != null ? row.x : 0}" style="max-width:4.5rem;" title="x">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-y" value="${row.y != null ? row.y : 0}" style="max-width:4.5rem;" title="y">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-z" value="${row.z != null ? row.z : 0}" style="max-width:4rem;" title="z">
                    <input type="number" class="form-control form-control-sm bg-black border-secondary text-white world-effect-friction" min="0" max="255" value="${fr}" placeholder="friction" style="max-width:5.5rem;" title="friction">
                    <button type="button" class="btn btn-sm btn-outline-danger world-effect-del">×</button>
                </div>`;
            }
        }
        return html;
    }

    function readWorldEffectRows(root) {
        if (!root) return [];
        const rows = [];
        root.querySelectorAll('.world-effect-row').forEach((el) => {
            const type = el.getAttribute('data-type') || 'cell';
            if (type === 'door') {
                const idEl = el.querySelector('.world-effect-door-id');
                const openEl = el.querySelector('.world-effect-open');
                const id = idEl ? String(idEl.value || '').trim() : '';
                if (!id) return;
                rows.push({ type: 'door', id, open: !!(openEl && openEl.checked) });
                return;
            }
            if (type === 'spawn') {
                const cidEl = el.querySelector('.world-effect-creature');
                const creatureId = cidEl ? String(cidEl.value || '').trim() : '';
                if (!creatureId) return;
                const xEl = el.querySelector('.world-effect-x');
                const yEl = el.querySelector('.world-effect-y');
                const zEl = el.querySelector('.world-effect-z');
                const nEl = el.querySelector('.world-effect-count');
                const effect = { type: 'spawn', creatureId };
                const x = xEl && String(xEl.value).trim() !== '' ? Number(xEl.value) : NaN;
                const y = yEl && String(yEl.value).trim() !== '' ? Number(yEl.value) : NaN;
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    effect.x = Math.round(x);
                    effect.y = Math.round(y);
                }
                const z = zEl && String(zEl.value).trim() !== '' ? Number(zEl.value) : NaN;
                if (Number.isFinite(z)) effect.z = Math.round(z);
                let count = nEl ? Math.floor(Number(nEl.value)) : 1;
                if (!Number.isFinite(count) || count < 1) count = 1;
                if (count > 1) effect.count = count;
                const rEl = el.querySelector('.world-effect-respawn');
                if (rEl && String(rEl.value).trim() !== '') {
                    const respawn = Number(rEl.value);
                    if (Number.isFinite(respawn) && respawn > 0) effect.respawn = respawn;
                }
                rows.push(effect);
                return;
            }
            if (type === 'wave') {
                const idEl = el.querySelector('.world-effect-wave-id');
                const id = idEl ? String(idEl.value || '').trim() : '';
                const effect = { type: 'wave' };
                if (id) effect.id = id;
                rows.push(effect);
                return;
            }
            if (type === 'unlock') {
                const idEl = el.querySelector('.world-effect-unlock-id');
                const id = idEl ? String(idEl.value || '').trim() : '';
                const effect = { type: 'unlock' };
                if (id) effect.id = id;
                rows.push(effect);
                return;
            }
            const xEl = el.querySelector('.world-effect-x');
            const yEl = el.querySelector('.world-effect-y');
            const zEl = el.querySelector('.world-effect-z');
            const fEl = el.querySelector('.world-effect-friction');
            const x = xEl ? Number(xEl.value) : 0;
            const y = yEl ? Number(yEl.value) : 0;
            const z = zEl ? Number(zEl.value) : 0;
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            const effect = { type: 'cell', x: Math.round(x), y: Math.round(y), z: Number.isFinite(z) ? Math.round(z) : 0 };
            if (fEl && String(fEl.value).trim() !== '') {
                let fr = Math.floor(Number(fEl.value));
                if (Number.isFinite(fr)) {
                    if (fr < 0) fr = 0;
                    if (fr > 255) fr = 255;
                    effect.friction = fr;
                }
            }
            if (effect.friction == null) return;
            rows.push(effect);
        });
        return rows;
    }

    function renderWorldProperties() {
        const propsContent = document.getElementById('propsContent');
        if (!propsContent) return;
        if (selectedWorldPins.length === 0 && !selectedWorldPin) {
            propsContent.innerHTML = `<div class="small text-muted">Select a World pin to inspect. Stamp from the palette, then click the map.</div>`;
            return;
        }
        if (selectedWorldPins.length === 0 && selectedWorldPin) {
            selectedWorldPins = [selectedWorldPin];
        }
        const kinds = (HdlTM && HdlTM.WORLD_KINDS) || [
            'container', 'chest', 'lever', 'door', 'teleport', 'switch', 'trap', 'harvest'
        ];
        let html = `<div class="d-flex gap-2 mb-3">
                        <button class="btn btn-sm btn-danger flex-grow-1" id="btn-remove-selected-world">Remove Selected</button>
                    </div>`;
        html += `<div class="selected-items-list pe-1" style="max-height: calc(100vh - 250px); overflow-y: auto; overflow-x: hidden;">`;
        selectedWorldPins.forEach((pin, index) => {
            const kind = pin.kind || 'container';
            const effectList = Array.isArray(pin.effects) ? pin.effects : [];
            let hasSpawnEffect = false;
            let hasWaveEffect = false;
            for (let ei = 0; ei < effectList.length; ei++) {
                const et = effectList[ei] && effectList[ei].type;
                if (et === 'spawn') hasSpawnEffect = true;
                if (et === 'wave') hasWaveEffect = true;
            }
            let kindOpts = '';
            for (let i = 0; i < kinds.length; i++) {
                kindOpts += '<option value="' + kinds[i] + '"' +
                    (kinds[i] === kind ? ' selected' : '') + '>' + kinds[i] + '</option>';
            }
            const itemsHtml = kind === 'container' ? renderWorldItemRows(pin.items) : '';
            html += `
                <div class="mb-3 pb-3 ${index < selectedWorldPins.length - 1 ? 'border-bottom border-secondary' : ''}">
                    <p class="fw-bold mb-1 text-white">${escapeHtml((pin.catalogId || pin.id || 'pin').toUpperCase())}</p>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Id</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-id" data-index="${index}" value="${escapeHtml(pin.id || '')}">
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Kind</label>
                            <select class="form-select form-select-sm bg-black border-secondary text-white prop-world-kind" data-index="${index}">${kindOpts}</select>
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Tag</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-tag" data-index="${index}" value="${escapeHtml(pin.tag || '')}">
                        </div>
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Catalog</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-catalog" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.catalogId || '')}">
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">X</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-x" data-index="${index}" value="${Math.round(pin.x)}">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Y</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-y" data-index="${index}" value="${Math.round(pin.y)}">
                        </div>
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Z</label>
                        <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-z" data-index="${index}" min="0" max="15" value="${pin.z != null ? pin.z : (parseInt(currentFloor, 10) || 0)}">
                    </div>
                    <div class="form-check mb-1">
                        <input class="form-check-input prop-world-blocking" type="checkbox" data-index="${index}" id="world-block-${index}" ${pin.blocking ? 'checked' : ''}>
                        <label class="form-check-label small" for="world-block-${index}">Blocking</label>
                    </div>
                    <div class="form-check mb-2">
                        <input class="form-check-input prop-world-pickup" type="checkbox" data-index="${index}" id="world-pick-${index}" ${pin.pickupable ? 'checked' : ''}>
                        <label class="form-check-label small" for="world-pick-${index}">Pickupable</label>
                    </div>
                    ${kind === 'container' ? `
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Capacity</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-cap" data-index="${index}" min="1" value="${pin.capacity != null ? pin.capacity : 20}">
                        </div>
                        <div class="form-check mt-4">
                            <input class="form-check-input prop-world-shared" type="checkbox" data-index="${index}" id="world-shared-${index}" ${pin.shared !== false ? 'checked' : ''}>
                            <label class="form-check-label small" for="world-shared-${index}">Shared</label>
                        </div>
                    </div>
                    <label class="form-label small text-secondary mb-1">Items</label>
                    <div class="world-items-list mb-2" data-index="${index}">${itemsHtml}</div>
                    <button type="button" class="btn btn-sm btn-outline-secondary mb-2 btn-add-world-item" data-index="${index}">Add item</button>
                    ` : kind === 'chest' ? `
                    <div class="form-check mb-2">
                        <input class="form-check-input prop-world-shared" type="checkbox" data-index="${index}" id="world-shared-${index}" ${pin.shared ? 'checked' : ''}>
                        <label class="form-check-label small" for="world-shared-${index}">Shared (first opener locks hunt)</label>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Once storage</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-key" data-index="${index}" value="${escapeHtml(chestOnceStorage(pin))}" placeholder="quest.demo.chest">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Once equals</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-eq" data-index="${index}" value="${chestOnceEq(pin)}">
                        </div>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">When item</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-when-item" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(chestWhenFields(pin).item)}" placeholder="optional">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">When min</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-when-min" data-index="${index}" min="1" value="${chestWhenFields(pin).min}">
                        </div>
                    </div>
                    <label class="form-label small text-secondary mb-1">Give</label>
                    <div class="world-give-list mb-2" data-index="${index}">${renderWorldItemRows(pin.give)}</div>
                    <button type="button" class="btn btn-sm btn-outline-secondary mb-2 btn-add-world-give" data-index="${index}">Add item</button>
                    <label class="form-label small text-secondary mb-1">Set storage</label>
                    <div class="world-set-list mb-2" data-index="${index}">${renderWorldSetRows(pin.set)}</div>
                    <button type="button" class="btn btn-sm btn-outline-secondary mb-2 btn-add-world-set" data-index="${index}">Add key</button>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Empty text</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-empty" data-index="${index}" value="${escapeHtml(pin.emptyText || '')}" placeholder="The chest is empty.">
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Transform to</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-transform" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.transformTo || '')}">
                    </div>
                    ` : (kind === 'lever' || kind === 'switch') ? `
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">States</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-states" data-index="${index}" value="${escapeHtml(leverStatesText(pin))}" placeholder="off,on">
                    </div>
                    <label class="form-label small text-secondary mb-1">Effects</label>
                    <div class="world-effects-list mb-2" data-index="${index}">${renderWorldEffectRows(pin.effects)}</div>
                    <div class="d-flex flex-wrap gap-1 mb-2">
                        <button type="button" class="btn btn-sm btn-outline-secondary btn-add-world-effect-cell" data-index="${index}">Add cell</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary btn-add-world-effect-door" data-index="${index}">Add door</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary btn-add-world-effect-spawn" data-index="${index}"${hasWaveEffect ? ' disabled' : ''}>Add spawn</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary btn-add-world-effect-wave" data-index="${index}"${hasSpawnEffect ? ' disabled' : ''}>Add wave</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary btn-add-world-effect-unlock" data-index="${index}">Add unlock</button>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">When storage</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-key" data-index="${index}" value="${escapeHtml(chestOnceStorage({ once: pin.when }))}" placeholder="optional gate">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">When equals</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-eq" data-index="${index}" value="${chestOnceEq({ once: pin.when })}">
                        </div>
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Transform on use</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-transform-use" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(typeof pin.transformOnUse === 'string' ? pin.transformOnUse : (Array.isArray(pin.transformOnUse) ? pin.transformOnUse.filter(Boolean).join(',') : ''))}" placeholder="on-art catalog (or off,on)">
                    </div>
                    ` : kind === 'door' ? `
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Closed catalog</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-closed" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.closedId || '')}">
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Open catalog</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-open" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.openId || '')}">
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Lock item</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-lock" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.lockId || '')}" placeholder="optional key">
                        </div>
                        <div class="form-check mt-4">
                            <input class="form-check-input prop-world-consume" type="checkbox" data-index="${index}" id="world-consume-${index}" ${pin.consume ? 'checked' : ''}>
                            <label class="form-check-label small" for="world-consume-${index}">Consume key</label>
                        </div>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Gate storage</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-gate-key" data-index="${index}" value="${escapeHtml(doorGateFields(pin).storage)}" placeholder="quest.demo.door">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Gate equals</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-gate-eq" data-index="${index}" value="${doorGateFields(pin).eq}">
                        </div>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Gate item</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-gate-item" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(doorGateFields(pin).item)}" placeholder="optional">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Gate min</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-gate-min" data-index="${index}" min="1" value="${doorGateFields(pin).min}">
                        </div>
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Gate level</label>
                        <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-gate-level" data-index="${index}" min="1" value="${doorGateFields(pin).level}" placeholder="optional min player.level">
                    </div>
                    ` : kind === 'teleport' ? `
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">To X</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-to-x" data-index="${index}" value="${teleportToFields(pin).x}">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">To Y</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-to-y" data-index="${index}" value="${teleportToFields(pin).y}">
                        </div>
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">To Z</label>
                        <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-to-z" data-index="${index}" min="0" max="15" value="${teleportToFields(pin).z}">
                    </div>
                    ` : kind === 'harvest' ? `
                    <div class="form-check mb-2">
                        <input class="form-check-input prop-world-shared" type="checkbox" data-index="${index}" id="world-shared-${index}" ${pin.shared !== false ? 'checked' : ''}>
                        <label class="form-check-label small" for="world-shared-${index}">Shared (first harvest locks until cooldown)</label>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Once storage</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-key" data-index="${index}" value="${escapeHtml(chestOnceStorage(pin))}" placeholder="harvest.bush">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Once equals</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-eq" data-index="${index}" value="${chestOnceEq(pin)}">
                        </div>
                    </div>
                    <label class="form-label small text-secondary mb-1">Give</label>
                    <div class="world-give-list mb-2" data-index="${index}">${renderWorldItemRows(pin.give)}</div>
                    <button type="button" class="btn btn-sm btn-outline-secondary mb-2 btn-add-world-give" data-index="${index}">Add item</button>
                    <label class="form-label small text-secondary mb-1">Set storage</label>
                    <div class="world-set-list mb-2" data-index="${index}">${renderWorldSetRows(pin.set)}</div>
                    <button type="button" class="btn btn-sm btn-outline-secondary mb-2 btn-add-world-set" data-index="${index}">Add key</button>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Empty text</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-empty" data-index="${index}" value="${escapeHtml(pin.emptyText || '')}" placeholder="You find nothing.">
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Transform to</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-transform" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.transformTo || '')}">
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Cooldown sec</label>
                        <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-cooldown" data-index="${index}" min="0" step="0.1" value="${pin.cooldown != null ? pin.cooldown : ''}" placeholder="optional">
                    </div>
                    ` : kind === 'trap' ? `
                    <div class="form-check mb-2">
                        <input class="form-check-input prop-world-shared" type="checkbox" data-index="${index}" id="world-shared-${index}" ${pin.shared !== false ? 'checked' : ''}>
                        <label class="form-check-label small" for="world-shared-${index}">Shared (first step locks until cooldown)</label>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Damage</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-damage" data-index="${index}" min="0" value="${pin.damage != null ? pin.damage : ''}" placeholder="hp">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Field</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-field" data-index="${index}" value="${escapeHtml(pin.field || '')}" placeholder="fire / poison / energy">
                        </div>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Once storage</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-key" data-index="${index}" value="${escapeHtml(chestOnceStorage(pin))}" placeholder="optional">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Once equals</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-once-eq" data-index="${index}" value="${chestOnceEq(pin)}">
                        </div>
                    </div>
                    <label class="form-label small text-secondary mb-1">Set storage</label>
                    <div class="world-set-list mb-2" data-index="${index}">${renderWorldSetRows(pin.set)}</div>
                    <button type="button" class="btn btn-sm btn-outline-secondary mb-2 btn-add-world-set" data-index="${index}">Add key</button>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Transform to</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-transform" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.transformTo || '')}">
                    </div>
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Cooldown sec</label>
                        <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-cooldown" data-index="${index}" min="0" step="0.1" value="${pin.cooldown != null ? pin.cooldown : ''}" placeholder="optional">
                    </div>
                    ` : `<div class="small text-secondary mb-2">Unknown kind fields persist if already in the pin.</div>`}
                    ${kind !== 'chest' && kind !== 'door' && kind !== 'lever' && kind !== 'switch' && kind !== 'harvest' && kind !== 'trap' ? `
                    <div class="mb-2">
                        <label class="form-label small text-secondary mb-0">Transform on use</label>
                        <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-transform-use" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(typeof pin.transformOnUse === 'string' ? pin.transformOnUse : '')}">
                    </div>
                    ` : ''}
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Decay sec</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-world-decay-sec" data-index="${index}" min="0" step="0.1" value="${pin.decay && pin.decay.sec != null ? pin.decay.sec : ''}" placeholder="optional">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Decay to</label>
                            <input type="text" class="form-control form-control-sm bg-black border-secondary text-white prop-world-decay-to" data-index="${index}" list="worldCatalogDatalist" value="${escapeHtml(pin.decay && pin.decay.to ? pin.decay.to : '')}" placeholder="remove if empty">
                        </div>
                    </div>
                    <div class="d-flex gap-2 mb-0">
                        <button class="btn btn-sm btn-primary flex-grow-1 btn-update-world" data-index="${index}">Update</button>
                        <button class="btn btn-sm btn-info flex-grow-1 text-white btn-center-world" data-index="${index}">Center</button>
                        <button class="btn btn-sm btn-danger flex-grow-1 btn-delete-world" data-index="${index}">Delete</button>
                    </div>
                </div>
            `;
        });
        html += `</div>`;
        propsContent.innerHTML = html;

        const rm = document.getElementById('btn-remove-selected-world');
        if (rm) {
            rm.addEventListener('click', () => {
                saveState();
                currentMapWorld = currentMapWorld.filter((p) => !selectedWorldPins.includes(p));
                mapWorldCache[currentFloor] = currentMapWorld;
                selectedWorldPins = [];
                selectedWorldPin = null;
                renderSpawns();
                updateFloorCounts();
                renderWorldProperties();
            });
        }
        document.querySelectorAll('.btn-add-world-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!Array.isArray(pin.items)) pin.items = [];
                pin.items.push({ item: '', count: 1 });
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-add-world-give').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!Array.isArray(pin.give)) pin.give = [];
                pin.give.push({ item: '', count: 1 });
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-add-world-set').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!pin.set || typeof pin.set !== 'object' || Array.isArray(pin.set)) {
                    pin.set = {};
                }
                let n = Object.keys(pin.set).length;
                let k = n === 0 ? 'quest.key' : 'quest.key_' + (n + 1);
                while (pin.set[k] != null) {
                    n += 1;
                    k = 'quest.key_' + n;
                }
                pin.set[k] = 1;
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.world-item-del').forEach((btn) => {
            btn.addEventListener('click', () => {
                const row = btn.closest('.world-item-row');
                const list = btn.closest('.world-items-list, .world-give-list');
                const pidx = list ? parseInt(list.dataset.index, 10) : -1;
                const pin = selectedWorldPins[pidx];
                if (!pin || !row || !list) return;
                const iidx = parseInt(row.dataset.index, 10);
                const bag = list.classList.contains('world-give-list') ? 'give' : 'items';
                if (Array.isArray(pin[bag])) pin[bag].splice(iidx, 1);
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.world-set-del').forEach((btn) => {
            btn.addEventListener('click', () => {
                const row = btn.closest('.world-set-row');
                const list = btn.closest('.world-set-list');
                const pidx = list ? parseInt(list.dataset.index, 10) : -1;
                const pin = selectedWorldPins[pidx];
                if (!pin || !row) return;
                const kEl = row.querySelector('.world-set-key');
                const key = kEl ? String(kEl.value || '').trim() : '';
                if (pin.set && typeof pin.set === 'object' && key) delete pin.set[key];
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-add-world-effect-cell').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!Array.isArray(pin.effects)) pin.effects = [];
                pin.effects.push({
                    type: 'cell',
                    x: Math.round(Number(pin.x)) || 0,
                    y: Math.round(Number(pin.y)) || 0,
                    z: pin.z != null ? pin.z : (parseInt(currentFloor, 10) || 0),
                    friction: 100
                });
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-add-world-effect-door').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!Array.isArray(pin.effects)) pin.effects = [];
                pin.effects.push({ type: 'door', id: '', open: true });
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-add-world-effect-spawn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!Array.isArray(pin.effects)) pin.effects = [];
                for (let i = 0; i < pin.effects.length; i++) {
                    if (pin.effects[i] && pin.effects[i].type === 'wave') return;
                }
                pin.effects.push({
                    type: 'spawn',
                    creatureId: '',
                    x: Math.round(Number(pin.x)) || 0,
                    y: Math.round(Number(pin.y)) || 0,
                    z: pin.z != null ? pin.z : (parseInt(currentFloor, 10) || 0),
                    count: 1
                });
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-add-world-effect-wave').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!Array.isArray(pin.effects)) pin.effects = [];
                for (let i = 0; i < pin.effects.length; i++) {
                    if (pin.effects[i] && pin.effects[i].type === 'spawn') return;
                }
                pin.effects.push({ type: 'wave' });
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-add-world-effect-unlock').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                if (!Array.isArray(pin.effects)) pin.effects = [];
                pin.effects.push({ type: 'unlock' });
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.world-effect-del').forEach((btn) => {
            btn.addEventListener('click', () => {
                const row = btn.closest('.world-effect-row');
                const list = btn.closest('.world-effects-list');
                const pidx = list ? parseInt(list.dataset.index, 10) : -1;
                const pin = selectedWorldPins[pidx];
                if (!pin || !row || !Array.isArray(pin.effects)) return;
                const iidx = parseInt(row.dataset.index, 10);
                if (Number.isFinite(iidx)) pin.effects.splice(iidx, 1);
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.prop-world-kind').forEach((sel) => {
            sel.addEventListener('change', () => {
                const idx = parseInt(sel.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                saveState();
                applyWorldPinFields(pin, readWorldPinFields(idx));
                renderWorldProperties();
            });
        });
        document.querySelectorAll('.btn-update-world').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const idx = parseInt(btn.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                if (!pin) return;
                const fields = readWorldPinFields(idx);
                const plan = HdlTM && typeof HdlTM.planWorldFloorMove === 'function'
                    ? HdlTM.planWorldFloorMove(currentFloor, fields.z)
                    : { ok: false, reason: 'same' };
                if (plan.ok) {
                    await moveWorldToFloor(pin, fields);
                    return;
                }
                saveState();
                applyWorldPinFields(pin, fields);
                renderSpawns();
                updateFloorCounts();
            });
        });
        document.querySelectorAll('.btn-center-world').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                zoomImageAtPoint(pin.x, pin.y, currentFloor, 1600);
            });
        });
        document.querySelectorAll('.btn-delete-world').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                saveState();
                const idx = parseInt(e.target.dataset.index, 10);
                const pin = selectedWorldPins[idx];
                const mapIdx = currentMapWorld.indexOf(pin);
                if (mapIdx > -1) currentMapWorld.splice(mapIdx, 1);
                selectedWorldPins.splice(idx, 1);
                if (selectedWorldPin === pin) {
                    selectedWorldPin = selectedWorldPins.length > 0 ? selectedWorldPins[0] : null;
                }
                mapWorldCache[currentFloor] = currentMapWorld;
                renderSpawns();
                updateFloorCounts();
                renderWorldProperties();
            });
        });
    }

    function readWorldPinFields(index) {
        const idEl = document.querySelector('.prop-world-id[data-index="' + index + '"]');
        const kindEl = document.querySelector('.prop-world-kind[data-index="' + index + '"]');
        const tagEl = document.querySelector('.prop-world-tag[data-index="' + index + '"]');
        const catEl = document.querySelector('.prop-world-catalog[data-index="' + index + '"]');
        const xEl = document.querySelector('.prop-world-x[data-index="' + index + '"]');
        const yEl = document.querySelector('.prop-world-y[data-index="' + index + '"]');
        const zEl = document.querySelector('.prop-world-z[data-index="' + index + '"]');
        const blockEl = document.querySelector('.prop-world-blocking[data-index="' + index + '"]');
        const pickEl = document.querySelector('.prop-world-pickup[data-index="' + index + '"]');
        const capEl = document.querySelector('.prop-world-cap[data-index="' + index + '"]');
        const sharedEl = document.querySelector('.prop-world-shared[data-index="' + index + '"]');
        const itemsRoot = document.querySelector('.world-items-list[data-index="' + index + '"]');
        const giveRoot = document.querySelector('.world-give-list[data-index="' + index + '"]');
        const setRoot = document.querySelector('.world-set-list[data-index="' + index + '"]');
        const onceKeyEl = document.querySelector('.prop-world-once-key[data-index="' + index + '"]');
        const onceEqEl = document.querySelector('.prop-world-once-eq[data-index="' + index + '"]');
        const whenItemEl = document.querySelector('.prop-world-when-item[data-index="' + index + '"]');
        const whenMinEl = document.querySelector('.prop-world-when-min[data-index="' + index + '"]');
        const emptyEl = document.querySelector('.prop-world-empty[data-index="' + index + '"]');
        const transformEl = document.querySelector('.prop-world-transform[data-index="' + index + '"]');
        const statesEl = document.querySelector('.prop-world-states[data-index="' + index + '"]');
        const effectsRoot = document.querySelector('.world-effects-list[data-index="' + index + '"]');
        const closedEl = document.querySelector('.prop-world-closed[data-index="' + index + '"]');
        const openEl = document.querySelector('.prop-world-open[data-index="' + index + '"]');
        const lockEl = document.querySelector('.prop-world-lock[data-index="' + index + '"]');
        const consumeEl = document.querySelector('.prop-world-consume[data-index="' + index + '"]');
        const gateKeyEl = document.querySelector('.prop-world-gate-key[data-index="' + index + '"]');
        const gateEqEl = document.querySelector('.prop-world-gate-eq[data-index="' + index + '"]');
        const gateItemEl = document.querySelector('.prop-world-gate-item[data-index="' + index + '"]');
        const gateMinEl = document.querySelector('.prop-world-gate-min[data-index="' + index + '"]');
        const gateLevelEl = document.querySelector('.prop-world-gate-level[data-index="' + index + '"]');
        const toXEl = document.querySelector('.prop-world-to-x[data-index="' + index + '"]');
        const toYEl = document.querySelector('.prop-world-to-y[data-index="' + index + '"]');
        const toZEl = document.querySelector('.prop-world-to-z[data-index="' + index + '"]');
        const transformUseEl = document.querySelector('.prop-world-transform-use[data-index="' + index + '"]');
        const decaySecEl = document.querySelector('.prop-world-decay-sec[data-index="' + index + '"]');
        const decayToEl = document.querySelector('.prop-world-decay-to[data-index="' + index + '"]');
        const cooldownEl = document.querySelector('.prop-world-cooldown[data-index="' + index + '"]');
        const damageEl = document.querySelector('.prop-world-damage[data-index="' + index + '"]');
        const fieldEl = document.querySelector('.prop-world-field[data-index="' + index + '"]');
        const kind = kindEl ? kindEl.value : 'container';
        const onceKey = onceKeyEl ? onceKeyEl.value.trim() : '';
        let onceEq = onceEqEl ? Number(onceEqEl.value) : 0;
        if (!Number.isFinite(onceEq)) onceEq = 0;
        const whenItem = whenItemEl ? whenItemEl.value.trim() : '';
        let whenMin = whenMinEl ? Math.floor(Number(whenMinEl.value)) : 1;
        if (!Number.isFinite(whenMin) || whenMin < 1) whenMin = 1;
        return {
            id: idEl ? idEl.value.trim() : '',
            kind,
            tag: tagEl ? tagEl.value.trim() : '',
            catalogId: catEl ? catEl.value.trim() : '',
            x: xEl ? Number(xEl.value) : 0,
            y: yEl ? Number(yEl.value) : 0,
            z: zEl ? Number(zEl.value) : (parseInt(currentFloor, 10) || 0),
            blocking: !!(blockEl && blockEl.checked),
            pickupable: !!(pickEl && pickEl.checked),
            capacity: capEl ? Number(capEl.value) : 20,
            shared: sharedEl ? !!sharedEl.checked : kind !== 'chest',
            items: readWorldItemRows(itemsRoot),
            give: readWorldItemRows(giveRoot),
            set: readWorldSetRows(setRoot),
            once: onceKey ? { storage: onceKey, eq: onceEq } : null,
            when: whenItem ? { item: whenItem, min: whenMin } : null,
            emptyText: emptyEl ? emptyEl.value.trim() : '',
            transformTo: transformEl ? transformEl.value.trim() : '',
            states: statesEl ? statesEl.value.trim() : 'off,on',
            effects: readWorldEffectRows(effectsRoot),
            closedId: closedEl ? closedEl.value.trim() : '',
            openId: openEl ? openEl.value.trim() : '',
            lockId: lockEl ? lockEl.value.trim() : '',
            consume: !!(consumeEl && consumeEl.checked),
            gateStorage: gateKeyEl ? gateKeyEl.value.trim() : '',
            gateEq: (function () {
                let n = gateEqEl ? Number(gateEqEl.value) : 0;
                return Number.isFinite(n) ? n : 0;
            })(),
            gateItem: gateItemEl ? gateItemEl.value.trim() : '',
            gateMin: (function () {
                let n = gateMinEl ? Math.floor(Number(gateMinEl.value)) : 1;
                return Number.isFinite(n) && n >= 1 ? n : 1;
            })(),
            gateLevel: (function () {
                if (!gateLevelEl || gateLevelEl.value === '') return 0;
                const n = Math.floor(Number(gateLevelEl.value));
                return Number.isFinite(n) && n >= 1 ? n : 0;
            })(),
            to: (function () {
                const x = toXEl ? Number(toXEl.value) : NaN;
                const y = toYEl ? Number(toYEl.value) : NaN;
                if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
                let z = toZEl ? Number(toZEl.value) : NaN;
                if (!Number.isFinite(z)) z = parseInt(currentFloor, 10) || 0;
                return { x: Math.round(x), y: Math.round(y), z: Math.round(z) };
            })(),
            transformOnUse: (function () {
                const raw = transformUseEl ? transformUseEl.value.trim() : '';
                if (!raw) return '';
                if (raw.indexOf(',') >= 0) {
                    return raw.split(',').map((s) => s.trim());
                }
                return raw;
            })(),
            decay: (function () {
                let sec = decaySecEl ? Number(decaySecEl.value) : 0;
                if (!Number.isFinite(sec) || sec <= 0) return null;
                const decay = { sec };
                const to = decayToEl ? decayToEl.value.trim() : '';
                if (to) decay.to = to;
                return decay;
            })(),
            cooldown: (function () {
                let n = cooldownEl ? Number(cooldownEl.value) : 0;
                if (!Number.isFinite(n) || n <= 0) return 0;
                return n;
            })(),
            damage: (function () {
                if (!damageEl || String(damageEl.value).trim() === '') return 0;
                const n = Math.floor(Number(damageEl.value));
                return Number.isFinite(n) && n >= 1 ? n : 0;
            })(),
            field: fieldEl ? fieldEl.value.trim() : ''
        };
    }

    function buildDoorGate(fields) {
        const clauses = [];
        if (fields.gateStorage) {
            clauses.push({ storage: fields.gateStorage, eq: fields.gateEq });
        }
        if (fields.gateItem) {
            clauses.push({ item: fields.gateItem, min: fields.gateMin });
        }
        const gate = {};
        if (clauses.length === 1) gate.when = clauses[0];
        else if (clauses.length > 1) gate.when = clauses;
        if (fields.gateLevel >= 1) gate.level = fields.gateLevel;
        return Object.keys(gate).length ? gate : null;
    }

    function applyWorldPinFields(pin, fields) {
        pin.id = fields.id || pin.id;
        pin.kind = fields.kind || pin.kind;
        pin.tag = fields.tag || undefined;
        if (!pin.tag) delete pin.tag;
        pin.catalogId = fields.catalogId || pin.catalogId;
        pin.x = Math.round(Number(fields.x));
        pin.y = Math.round(Number(fields.y));
        pin.z = Number(fields.z);
        pin.blocking = !!fields.blocking;
        pin.pickupable = !!fields.pickupable;
        if (pin.kind === 'container') {
            pin.capacity = Math.max(1, Math.floor(Number(fields.capacity)) || 20);
            pin.shared = fields.shared !== false;
            pin.items = fields.items || [];
            delete pin.once;
            delete pin.when;
            delete pin.give;
            delete pin.set;
            delete pin.emptyText;
            delete pin.transformTo;
            delete pin.states;
            delete pin.effects;
            delete pin.closedId;
            delete pin.openId;
            delete pin.gate;
            delete pin.lockId;
            delete pin.consume;
            delete pin.to;
        } else if (pin.kind === 'chest') {
            pin.shared = !!fields.shared;
            if (fields.once) pin.once = fields.once;
            else delete pin.once;
            if (fields.when) pin.when = fields.when;
            else delete pin.when;
            pin.give = fields.give || [];
            if (fields.set && Object.keys(fields.set).length) pin.set = fields.set;
            else delete pin.set;
            if (fields.emptyText) pin.emptyText = fields.emptyText;
            else delete pin.emptyText;
            if (fields.transformTo) pin.transformTo = fields.transformTo;
            else delete pin.transformTo;
            delete pin.items;
            delete pin.capacity;
            delete pin.states;
            delete pin.effects;
            delete pin.closedId;
            delete pin.openId;
            delete pin.gate;
            delete pin.lockId;
            delete pin.consume;
            delete pin.to;
        } else if (pin.kind === 'lever' || pin.kind === 'switch') {
            const statesRaw = String(fields.states || '').split(',');
            const states = [];
            for (let i = 0; i < statesRaw.length; i++) {
                const s = statesRaw[i].trim();
                if (s) states.push(s);
            }
            pin.states = states.length ? states : ['off', 'on'];
            pin.effects = dropSpawnWaveMix(fields.effects || []);
            if (fields.once) pin.when = fields.once;
            else delete pin.when;
            delete pin.items;
            delete pin.capacity;
            delete pin.once;
            delete pin.give;
            delete pin.set;
            delete pin.emptyText;
            delete pin.transformTo;
            delete pin.closedId;
            delete pin.openId;
            delete pin.shared;
            delete pin.gate;
            delete pin.lockId;
            delete pin.consume;
            delete pin.to;
        } else if (pin.kind === 'harvest') {
            pin.shared = fields.shared !== false;
            if (fields.once) pin.once = fields.once;
            else delete pin.once;
            if (fields.when) pin.when = fields.when;
            pin.give = fields.give || [];
            if (fields.set && Object.keys(fields.set).length) pin.set = fields.set;
            else delete pin.set;
            if (fields.emptyText) pin.emptyText = fields.emptyText;
            else delete pin.emptyText;
            if (fields.transformTo) pin.transformTo = fields.transformTo;
            else delete pin.transformTo;
            if (fields.cooldown) pin.cooldown = fields.cooldown;
            else delete pin.cooldown;
            delete pin.items;
            delete pin.capacity;
            delete pin.states;
            delete pin.effects;
            delete pin.closedId;
            delete pin.openId;
            delete pin.gate;
            delete pin.lockId;
            delete pin.consume;
            delete pin.to;
            delete pin.damage;
            delete pin.field;
        } else if (pin.kind === 'trap') {
            pin.shared = fields.shared !== false;
            if (fields.once) pin.once = fields.once;
            else delete pin.once;
            if (fields.when) pin.when = fields.when;
            if (fields.set && Object.keys(fields.set).length) pin.set = fields.set;
            else delete pin.set;
            if (fields.transformTo) pin.transformTo = fields.transformTo;
            else delete pin.transformTo;
            if (fields.cooldown) pin.cooldown = fields.cooldown;
            else delete pin.cooldown;
            if (fields.damage) pin.damage = fields.damage;
            else delete pin.damage;
            if (fields.field) pin.field = fields.field;
            else delete pin.field;
            delete pin.items;
            delete pin.capacity;
            delete pin.give;
            delete pin.emptyText;
            delete pin.states;
            delete pin.effects;
            delete pin.closedId;
            delete pin.openId;
            delete pin.gate;
            delete pin.lockId;
            delete pin.consume;
            delete pin.to;
        } else if (pin.kind === 'door') {
            if (fields.closedId) pin.closedId = fields.closedId;
            else delete pin.closedId;
            if (fields.openId) pin.openId = fields.openId;
            else delete pin.openId;
            if (fields.lockId) pin.lockId = fields.lockId;
            else delete pin.lockId;
            if (fields.consume) pin.consume = true;
            else delete pin.consume;
            const gate = buildDoorGate(fields);
            if (gate) pin.gate = gate;
            else delete pin.gate;
            delete pin.items;
            delete pin.capacity;
            delete pin.once;
            delete pin.when;
            delete pin.give;
            delete pin.set;
            delete pin.emptyText;
            delete pin.transformTo;
            delete pin.states;
            delete pin.effects;
            delete pin.shared;
            delete pin.to;
        } else if (pin.kind === 'teleport') {
            if (fields.to) pin.to = fields.to;
            else delete pin.to;
            delete pin.items;
            delete pin.capacity;
            delete pin.once;
            delete pin.when;
            delete pin.give;
            delete pin.set;
            delete pin.emptyText;
            delete pin.transformTo;
            delete pin.states;
            delete pin.effects;
            delete pin.closedId;
            delete pin.openId;
            delete pin.shared;
            delete pin.gate;
            delete pin.lockId;
            delete pin.consume;
        } else {
            delete pin.items;
            delete pin.capacity;
            delete pin.once;
            delete pin.when;
            delete pin.give;
            delete pin.set;
            delete pin.emptyText;
            delete pin.transformTo;
            delete pin.states;
            delete pin.effects;
            delete pin.closedId;
            delete pin.openId;
            delete pin.shared;
            delete pin.gate;
            delete pin.lockId;
            delete pin.consume;
            delete pin.to;
        }
        if (pin.kind !== 'chest' && pin.kind !== 'door' && pin.kind !== 'harvest' && pin.kind !== 'trap') {
            if (fields.transformOnUse && (typeof fields.transformOnUse === 'string' ? fields.transformOnUse : fields.transformOnUse.length)) {
                pin.transformOnUse = fields.transformOnUse;
            } else {
                delete pin.transformOnUse;
            }
        } else {
            delete pin.transformOnUse;
        }
        if (pin.kind !== 'harvest' && pin.kind !== 'trap') {
            delete pin.cooldown;
            delete pin.damage;
            delete pin.field;
        }
        if (fields.decay) pin.decay = fields.decay;
        else delete pin.decay;
        const cat = worldCatalog[pin.catalogId];
        if (cat && cat.kind) pin.catalogKind = cat.kind;
    }

    async function moveWorldToFloor(pin, fields) {
        const fromFloor = currentFloor;
        const destFloor = padFloor(fields.z);
        await ensureFloorSpawnsLoaded(destFloor);
        applyWorldPinFields(pin, fields);
        const apply = HdlTM && typeof HdlTM.applyWorldFloorMove === 'function'
            ? HdlTM.applyWorldFloorMove
            : null;
        const result = apply
            ? apply(
                mapWorldCache[fromFloor] || currentMapWorld,
                mapWorldCache[destFloor] || [],
                pin,
                fields.z
            )
            : null;
        if (!result) {
            alert('Could not move World pin — pin not found on this floor');
            return;
        }
        mapWorldCache[fromFloor] = result.fromList;
        mapWorldCache[destFloor] = result.destList;
        currentMapWorld = result.fromList;
        selectedWorldPins = selectedWorldPins.filter((p) => p !== pin);
        selectedWorldPin = selectedWorldPins[0] || null;
        renderSpawns();
        updateFloorCounts();
        renderWorldProperties();
        try {
            await saveFloorWorld(destFloor);
            await saveFloorWorld(fromFloor);
            setDirty(false);
        } catch (e) {
            alert('Error saving World floor move: ' + e.message);
        }
    }

    function cloneStairPadRow(row, z) {
        if (!row) return null;
        const to = row.to && row.to.x != null
            ? { x: row.to.x | 0, y: row.to.y | 0, z: row.to.z }
            : null;
        return {
            x: row.x | 0,
            y: row.y | 0,
            z: z != null ? z : row.z,
            dir: row.dir || 'center',
            type: row.type || 'stairs',
            deltaZ: row.deltaZ != null ? row.deltaZ : 0,
            to
        };
    }

    function refreshSelectedStairPad() {
        if (!selectedStairPad || !tilemapSession || typeof tilemapSession.findStairAt !== 'function') {
            return;
        }
        if (String(tilemapSession.z) !== String(selectedStairPad.z)) return;
        const row = tilemapSession.findStairAt(selectedStairPad.x, selectedStairPad.y);
        selectedStairPad = row ? cloneStairPadRow(row, tilemapSession.z) : null;
    }

    function applyPendingStairDests() {
        if (!tilemapSession || typeof tilemapSession.setStairDest !== 'function') return;
        if (!pendingStairDests.length) return;
        const z = tilemapSession.z;
        const keep = [];
        for (let i = 0; i < pendingStairDests.length; i++) {
            const p = pendingStairDests[i];
            if (String(p.padZ) !== String(z)) {
                keep.push(p);
                continue;
            }
            tilemapSession.setStairDest(p.padX, p.padY, p.to, { undo: false });
        }
        pendingStairDests = keep;
        refreshSelectedStairPad();
    }

    function trySelectStairPadAt(x, y) {
        pickStairDest = false;
        if (!tilemapSession || typeof tilemapSession.findStairAt !== 'function') {
            selectedStairPad = null;
            return false;
        }
        const row = tilemapSession.findStairAt(x, y);
        if (!row) {
            selectedStairPad = null;
            return false;
        }
        selectedStairPad = cloneStairPadRow(row, tilemapSession.z);
        selectedMapSpawn = null;
        selectedMapSpawns = [];
        return true;
    }

    function applySelectedPadDest(to) {
        const statusBar = document.getElementById('statusBar');
        if (!selectedStairPad || !to) return { ok: false, reason: 'no_pad' };
        const dest = {
            x: Math.round(Number(to.x) || 0),
            y: Math.round(Number(to.y) || 0),
            z: to.z !== undefined && to.z !== null ? to.z : selectedStairPad.z
        };
        if (
            dest.x === (selectedStairPad.x | 0) &&
            dest.y === (selectedStairPad.y | 0) &&
            String(dest.z) === String(selectedStairPad.z)
        ) {
            if (statusBar) statusBar.textContent = 'Hop dest cannot be the pad tile';
            return { ok: false, reason: 'same_tile' };
        }
        if (
            tilemapSession &&
            typeof tilemapSession.setStairDest === 'function' &&
            String(tilemapSession.z) === String(selectedStairPad.z)
        ) {
            const r = tilemapSession.setStairDest(selectedStairPad.x, selectedStairPad.y, dest);
            if (!r.ok) {
                if (statusBar) statusBar.textContent = 'Could not set hop dest (' + (r.reason || 'error') + ')';
                return r;
            }
            selectedStairPad = cloneStairPadRow(r.row, tilemapSession.z);
            if (statusBar) {
                statusBar.textContent =
                    'Hop dest ' + dest.x + ',' + dest.y + ',' + dest.z;
            }
            renderSpawnProperties();
            return r;
        }
        pendingStairDests = pendingStairDests.filter((p) =>
            !(p.padX === selectedStairPad.x && p.padY === selectedStairPad.y &&
                String(p.padZ) === String(selectedStairPad.z))
        );
        pendingStairDests.push({
            padX: selectedStairPad.x,
            padY: selectedStairPad.y,
            padZ: selectedStairPad.z,
            to: dest
        });
        selectedStairPad.dir = 'custom';
        selectedStairPad.to = dest;
        if (statusBar) {
            statusBar.textContent =
                'Hop dest queued — return to floor ' + selectedStairPad.z + ' and Save';
        }
        renderSpawnProperties();
        return { ok: true, pending: true };
    }

    function renderStairPadProperties() {
        const propsContent = document.getElementById('propsContent');
        if (!propsContent || !selectedStairPad) return;
        const pad = selectedStairPad;
        const to = pad.to || {};
        const destX = to.x != null ? to.x : pad.x;
        const destY = to.y != null ? to.y : pad.y;
        const destZ = to.z != null ? to.z : pad.z;
        const dz = pad.deltaZ != null ? pad.deltaZ : 0;
        const dzLabel = dz < 0 ? 'z' + dz : dz > 0 ? 'z+' + dz : 'z+0';
        const preview = (pad.dir || 'center') +
            (pad.dir === 'custom' ? '' : ' · ' + dzLabel) +
            ' → ' + destX + ', ' + destY + ', ' + destZ;
        propsContent.innerHTML = `
            <div class="mb-2">
                <p class="fw-bold mb-1 text-white">Hop pad</p>
                <div class="small text-secondary mb-2">${pad.x}, ${pad.y}, ${pad.z} · ${pad.type || 'stairs'}</div>
                <div class="small font-monospace text-info mb-2">${preview}</div>
                <label class="form-label small text-muted">Dest</label>
                <div class="d-flex gap-1 mb-2">
                    <input type="number" id="pad-dest-x" class="form-control form-control-sm bg-black border-secondary text-white" value="${destX}" title="Dest X">
                    <input type="number" id="pad-dest-y" class="form-control form-control-sm bg-black border-secondary text-white" value="${destY}" title="Dest Y">
                    <input type="number" id="pad-dest-z" class="form-control form-control-sm bg-black border-secondary text-white" value="${destZ}" title="Dest Z">
                </div>
                <div class="d-flex flex-wrap gap-1">
                    <button type="button" class="btn btn-sm btn-primary" id="pad-dest-apply">Apply</button>
                    <button type="button" class="btn btn-sm ${pickStairDest ? 'btn-warning' : 'btn-outline-secondary'}" id="pad-dest-pick">Pick dest</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="pad-dest-reset">Reset to dir</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="pad-dest-goto">Goto dest</button>
                </div>
            </div>`;
        const applyBtn = document.getElementById('pad-dest-apply');
        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                const xEl = document.getElementById('pad-dest-x');
                const yEl = document.getElementById('pad-dest-y');
                const zEl = document.getElementById('pad-dest-z');
                applySelectedPadDest({
                    x: xEl ? Number(xEl.value) : destX,
                    y: yEl ? Number(yEl.value) : destY,
                    z: zEl && zEl.value !== '' ? Number(zEl.value) : destZ
                });
            });
        }
        const pickBtn = document.getElementById('pad-dest-pick');
        if (pickBtn) {
            pickBtn.addEventListener('click', () => {
                pickStairDest = !pickStairDest;
                imageContainer.style.cursor = pickStairDest ? 'crosshair' : 'default';
                const sb = document.getElementById('statusBar');
                if (sb) {
                    sb.textContent = pickStairDest
                        ? 'Click a tile for hop dest (z from Dest field)'
                        : 'Ready';
                }
                renderStairPadProperties();
            });
        }
        const resetBtn = document.getElementById('pad-dest-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                pickStairDest = false;
                if (
                    tilemapSession &&
                    typeof tilemapSession.resetStairDest === 'function' &&
                    String(tilemapSession.z) === String(pad.z)
                ) {
                    const r = tilemapSession.resetStairDest(pad.x, pad.y);
                    if (r.ok) {
                        selectedStairPad = r.row
                            ? cloneStairPadRow(r.row, tilemapSession.z)
                            : null;
                    }
                } else {
                    selectedStairPad.dir = 'center';
                    selectedStairPad.to = null;
                }
                renderSpawnProperties();
            });
        }
        const gotoBtn = document.getElementById('pad-dest-goto');
        if (gotoBtn) {
            gotoBtn.addEventListener('click', () => {
                const xEl = document.getElementById('pad-dest-x');
                const yEl = document.getElementById('pad-dest-y');
                const zEl = document.getElementById('pad-dest-z');
                const gx = xEl ? Number(xEl.value) : destX;
                const gy = yEl ? Number(yEl.value) : destY;
                const gz = zEl && zEl.value !== '' ? Number(zEl.value) : destZ;
                if (typeof runGotoQuery === 'function') {
                    runGotoQuery(gx + ',' + gy + ',' + gz);
                }
            });
        }
    }

    function renderSpawnProperties() {
        const propsContent = document.getElementById('propsContent');
        if (selectedStairPad) {
            renderStairPadProperties();
            return;
        }

        if (selectedMapSpawns.length === 0 && !selectedMapSpawn) {
            propsContent.innerHTML = `<div class="small text-muted">Select an object to view properties.</div>`;
            return;
        }
        
        // Ensure selectedMapSpawns is populated if only selectedMapSpawn is set
        if (selectedMapSpawns.length === 0 && selectedMapSpawn) {
            selectedMapSpawns = [selectedMapSpawn];
        }

        let html = `<div class="d-flex gap-2 mb-3">
                        <button class="btn btn-sm btn-danger flex-grow-1" id="btn-remove-selected">Remove Selected</button>
                        <button class="btn btn-sm btn-outline-danger flex-grow-1" id="btn-remove-unselected">Remove Unselected</button>
                    </div>`;

        if (selectedMapSpawns.length > 1) {
            html += `<p class="fw-bold mb-2 text-white">${selectedMapSpawns.length} Monsters Selected</p>`;
        }

        html += `<div class="selected-items-list pe-1" style="max-height: calc(100vh - 250px); overflow-y: auto; overflow-x: hidden;">`;

        selectedMapSpawns.forEach((spawn, index) => {
            html += `
                <div class="mb-3 pb-3 ${index < selectedMapSpawns.length - 1 ? 'border-bottom border-secondary' : ''}">
                    <p class="fw-bold mb-1 text-white">${spawnDisplayName(spawn).toUpperCase()}</p>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">X</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-x" data-index="${index}" value="${Math.round(spawn.x)}">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Y</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-y" data-index="${index}" value="${Math.round(spawn.y)}">
                        </div>
                    </div>
                    <div class="mb-2 prop-pair">
                        <div>
                            <label class="form-label small text-secondary mb-0">Z</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-z" data-index="${index}" min="0" max="15" value="${spawn.z != null ? spawn.z : (parseInt(currentFloor, 10) || 0)}">
                        </div>
                        <div>
                            <label class="form-label small text-secondary mb-0">Respawn</label>
                            <input type="number" class="form-control form-control-sm bg-black border-secondary text-white prop-respawn" data-index="${index}" min="0" value="${spawn.respawn != null ? spawn.respawn : defaultSpawnRespawn()}">
                        </div>
                    </div>
                    <div class="d-flex gap-2 mb-2">
                        <button class="btn btn-sm btn-primary flex-grow-1 btn-update-spawn" data-index="${index}">Update</button>
                        <button class="btn btn-sm btn-info flex-grow-1 text-white btn-center-spawn" data-index="${index}">Center</button>
                        <button class="btn btn-sm btn-danger flex-grow-1 btn-delete-spawn" data-index="${index}">Delete</button>
                    </div>
                    <div class="d-flex gap-2 mb-0">
                        <button type="button" class="btn btn-sm btn-outline-warning flex-grow-1 btn-add-to-palette-spawn" data-index="${index}">Add to Palette</button>
                        <button type="button" class="btn btn-sm btn-outline-primary flex-grow-1 btn-view-stats" data-index="${index}">Stats</button>
                    </div>
                </div>
            `;
        });
        
        html += `</div>`;
        propsContent.innerHTML = html;

        document.getElementById('btn-remove-selected').addEventListener('click', () => {
            saveState();
            currentMapSpawns = currentMapSpawns.filter(s => !selectedMapSpawns.includes(s));
            mapSpawnsCache[currentFloor] = currentMapSpawns;
            selectedMapSpawns = [];
            selectedMapSpawn = null;
            renderSpawns();
            updateFloorCounts();
            renderSpawnProperties();
        });

        document.getElementById('btn-remove-unselected').addEventListener('click', () => {
            saveState();
            currentMapSpawns = currentMapSpawns.filter(s => selectedMapSpawns.includes(s));
            mapSpawnsCache[currentFloor] = currentMapSpawns;
            renderSpawns();
            updateFloorCounts();
            renderSpawnProperties();
        });

        document.querySelectorAll('.btn-update-spawn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                const spawn = selectedMapSpawns[idx];
                const itemDiv = e.target.closest('.mb-3');
                if (!spawn || !itemDiv) return;
                const fields = {
                    x: Number(itemDiv.querySelector('.prop-x').value),
                    y: Number(itemDiv.querySelector('.prop-y').value),
                    z: Number(itemDiv.querySelector('.prop-z').value),
                    respawn: Math.max(0, Number(itemDiv.querySelector('.prop-respawn').value) || 0)
                };
                const plan = planFloorMove(currentFloor, fields.z);
                if (!plan.ok && plan.reason === 'invalid') {
                    alert('Z must be an integer 0–15');
                    return;
                }
                if (plan.ok) {
                    const name = spawnDisplayName(spawn) || spawn.creatureId || 'spawn';
                    const msg =
                        'Move ' +
                        name +
                        ' from floor ' +
                        plan.fromZ +
                        ' to floor ' +
                        plan.toZ +
                        '? This saves both floors now.';
                    const ok = await confirmSpawnFloorMove(msg);
                    if (!ok) return;
                    e.target.disabled = true;
                    try {
                        await moveSpawnToFloor(spawn, { x: fields.x, y: fields.y, z: plan.toZ, respawn: fields.respawn });
                    } finally {
                        e.target.disabled = false;
                    }
                    return;
                }
                saveState();
                spawn.x = fields.x;
                spawn.y = fields.y;
                spawn.z = fields.z;
                spawn.respawn = fields.respawn;
                if (spawn.creatureId) {
                    spawn.creatureId = resolveCreatureId(spawn.creatureId);
                }
                renderSpawns();
            });
        });

        document.querySelectorAll('.btn-center-spawn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                const spawn = selectedMapSpawns[idx];
                zoomImageAtPoint(spawn.x, spawn.y, currentFloor, 1600);
                const url = new URL(window.location.href);
                url.searchParams.set('point', `${Math.floor(spawn.x)},${Math.floor(spawn.y)},${currentFloor},1600`);
                window.history.replaceState({}, '', url.toString());
            });
        });

        document.querySelectorAll('.btn-delete-spawn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                saveState();
                const idx = parseInt(e.target.dataset.index, 10);
                const spawn = selectedMapSpawns[idx];
                const mapIdx = currentMapSpawns.indexOf(spawn);
                if (mapIdx > -1) {
                    currentMapSpawns.splice(mapIdx, 1);
                }
                selectedMapSpawns.splice(idx, 1);
                if (selectedMapSpawn === spawn) {
                    selectedMapSpawn = selectedMapSpawns.length > 0 ? selectedMapSpawns[0] : null;
                }
                renderSpawns();
                updateFloorCounts();
                renderSpawnProperties();
            });
        });

        document.querySelectorAll('.btn-add-to-palette-spawn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                const spawn = selectedMapSpawns[idx];
                const item = resolvePaletteItem(spawn.creatureId || spawn.legacyName);
                if (item.id && !mapPalette.find((m) => paletteItemId(m) === item.id)) {
                    mapPalette.push(item);
                    if (currentLayer === 'spawns') {
                        renderPaletteUI();
                    }
                }
            });
        });
        
        document.querySelectorAll('.btn-view-stats').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.index, 10);
                const spawn = selectedMapSpawns[idx];
                showMonsterData(spawn);
            });
        });
    }

    // Click: pick nearest spawn in map-local space (map-spawn.js findSpawnAt)
    imageContainer.addEventListener('click', function (e) {
        if (currentTool !== 'select') return;
        if (wasDragging) {
            wasDragging = false;
            return;
        }
        if (!layerVisibility[`floor-${currentFloor}`]) return;
        if (!mapPixelWidth()) {
            return;
        }

        const rect = imageContainer.getBoundingClientRect();
        const clickCanvasX = e.clientX - rect.left + imageContainer.scrollLeft;
        const clickCanvasY = e.clientY - rect.top + imageContainer.scrollTop;
        const clickX = clickCanvasX / zoomValue;
        const clickY = clickCanvasY / zoomValue;

        if (currentLayer === 'world' && layerVisibility[`floor-${currentFloor}-world`]) {
            let nearest = null;
            let minD = Infinity;
            for (const pin of currentMapWorld) {
                const w = 32;
                const h = 32;
                const px = pin.x * zoomValue;
                const py = pin.y * zoomValue;
                if (clickCanvasX >= px && clickCanvasX <= px + w &&
                    clickCanvasY >= py && clickCanvasY <= py + h) {
                    const cx = px + w / 2;
                    const cy = py + h / 2;
                    const distSq = (clickCanvasX - cx) * (clickCanvasX - cx) + (clickCanvasY - cy) * (clickCanvasY - cy);
                    if (distSq < minD) {
                        minD = distSq;
                        nearest = pin;
                    }
                }
            }
            if (nearest) {
                selectedWorldPin = nearest;
                selectedWorldPins = [nearest];
                selectedWorldPalette = null;
                renderWorldPaletteUI();
                renderWorldProperties();
                renderSpawns();
                return;
            }
            if (selectedWorldPalette) {
                saveState();
                const pin = makeNewWorldPin(clickX, clickY, selectedWorldPalette.id);
                if (pin) {
                    currentMapWorld.push(pin);
                    mapWorldCache[currentFloor] = currentMapWorld;
                    selectedWorldPin = pin;
                    selectedWorldPins = [pin];
                    renderSpawns();
                    updateFloorCounts();
                    renderWorldProperties();
                }
            } else {
                selectedWorldPin = null;
                selectedWorldPins = [];
                renderWorldProperties();
                renderSpawns();
            }
            return;
        }

        let nearestSpawn = null;
        let minDistanceSq = Infinity;

        if (layerVisibility[`floor-${currentFloor}-spawns`]) {
            const filterText = monsterNameInput.value.toLowerCase().trim();

            for (const spawn of currentMapSpawns) {
                if (!matchesFilter(spawn, filterText)) continue;

                const art = resolveSpawnArt(spawn);
                const img = imageCache.get(art.standardUrl);
                const w = (img && img.loaded) ? (img.image.naturalWidth || 32) : 32;
                const h = (img && img.loaded) ? (img.image.naturalHeight || 32) : 32;
                
                const spawnCanvasX = spawn.x * zoomValue;
                const spawnCanvasY = spawn.y * zoomValue;
                
                if (clickCanvasX >= spawnCanvasX && clickCanvasX <= spawnCanvasX + w &&
                    clickCanvasY >= spawnCanvasY && clickCanvasY <= spawnCanvasY + h) {
                    const cx = spawnCanvasX + w / 2;
                    const cy = spawnCanvasY + h / 2;
                    const distSq = (clickCanvasX - cx) * (clickCanvasX - cx) + (clickCanvasY - cy) * (clickCanvasY - cy);
                    if (distSq < minDistanceSq) {
                        minDistanceSq = distSq;
                        nearestSpawn = spawn;
                    }
                }
            }
        }

        if (nearestSpawn) {
            selectedMapSpawn = nearestSpawn;
            selectedMapSpawns = [nearestSpawn];
            selectedPaletteItem = null;
            if (currentLayer === 'spawns') renderPaletteUI();

            const activeBtn = document.querySelector('.image-zoom.active');
            const currentZoomPct = activeBtn
                ? activeBtn.textContent.replace('%', '').trim()
                : String(zoomValue * 100);
            const newUrl =
                window.location.pathname +
                '?point=' +
                Math.round(Number(nearestSpawn.x)) +
                ',' +
                Math.round(Number(nearestSpawn.y)) +
                ',' +
                currentFloor +
                ',' +
                currentZoomPct;
            window.history.pushState({}, '', newUrl);
            showMonsterData(nearestSpawn);
            
            renderSpawnProperties();
        } else {
            if (currentLayer === 'spawns' && selectedPaletteItem && layerVisibility[`floor-${currentFloor}-spawns`]) {
                saveState();
                const newSpawn = makeNewSpawnPin(
                    clickX,
                    clickY,
                    paletteItemId(selectedPaletteItem)
                );
                if (newSpawn) {
                    currentMapSpawns.push(newSpawn);
                    renderSpawns();
                    updateFloorCounts();
                }
            } else {
                selectedMapSpawn = null;
                selectedMapSpawns = [];
                renderSpawnProperties();
            }
        }
    });

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** Display `resists` as damage taken: base 100%, JSON value subtracts. */
    function damageTakenPct(resists, key) {
        if (!resists || resists[key] == null || resists[key] === '') return 100;
        const n = Number(resists[key]);
        return Number.isFinite(n) ? 100 - n : 100;
    }

    function loadCreatureJson(id) {
        const key = String(id || '');
        if (!key) return Promise.resolve(null);
        if (creatureJsonCache[key]) return Promise.resolve(creatureJsonCache[key]);
        const url = ASSET_ROOT + 'presets/standard/creatures/' + encodeURIComponent(key) + '.json';
        return fetch(url)
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (data && typeof data === 'object') {
                    creatureJsonCache[key] = data;
                    if (data.id) creatureJsonCache[data.id] = data;
                }
                return data;
            })
            .catch((err) => {
                console.error('Error loading creature JSON', key, err);
                return null;
            });
    }

    let monsterStatsLoadGen = 0;

    function renderOfficialMonsterStats(mData) {
        const hp = mData.hp != null ? Number(mData.hp) : 0;
        const exp = mData.exp != null ? Number(mData.exp) : 0;
        const loot = mData.lootValue != null ? Number(mData.lootValue) : 0;
        const resists = mData.resists || {};
        const flags = mData.flags || {};
        const bestiary = mData.bestiary || {};
        const immunities = mData.immunities || {};
        return (
            '<div class="row">' +
            '<div class="col-md-6">' +
            '<p><strong>HP:</strong> ' +
            (Number.isFinite(hp) ? hp : 0) +
            '</p>' +
            '<p><strong>Experience:</strong> ' +
            (Number.isFinite(exp) ? exp : 0) +
            '</p>' +
            '<p><strong>Mitigation:</strong> ' +
            (mData.mitigation != null ? mData.mitigation : 0) +
            '%</p>' +
            '<p><strong>Bestiary Class:</strong> ' +
            escapeHtml(bestiary.class || '-') +
            '</p>' +
            '<p><strong>Speed:</strong> ' +
            (mData.speed != null ? mData.speed : 0) +
            '</p>' +
            '<p><strong>Armor:</strong> ' +
            (mData.armor != null ? mData.armor : 0) +
            '</p>' +
            '</div>' +
            '<div class="col-md-6">' +
            '<p><strong>Damage Taken:</strong></p>' +
            '<ul class="mb-2">' +
            '<li>Death: ' +
            damageTakenPct(resists, 'death') +
            '%</li>' +
            '<li>Earth: ' +
            damageTakenPct(resists, 'earth') +
            '%</li>' +
            '<li>Energy: ' +
            damageTakenPct(resists, 'energy') +
            '%</li>' +
            '<li>Ice: ' +
            damageTakenPct(resists, 'ice') +
            '%</li>' +
            '<li>Fire: ' +
            damageTakenPct(resists, 'fire') +
            '%</li>' +
            '<li>Holy: ' +
            damageTakenPct(resists, 'holy') +
            '%</li>' +
            '<li>Physical: ' +
            damageTakenPct(resists, 'physical') +
            '%</li>' +
            '</ul></div>' +
            '<div class="col-md-6"><p><strong>Bestiary Kills:</strong> ' +
            (bestiary.toKill != null ? bestiary.toKill : 0) +
            '</p></div>' +
            '<div class="col-md-6"><p><strong>Average Loot:</strong> ' +
            (Number.isFinite(loot) ? loot.toFixed(2) : '0') +
            '</p></div>' +
            '<div class="col-md-6"><p><strong>EXP / HP:</strong> ' +
            (hp ? (exp / hp).toFixed(2) : '0') +
            '</p></div>' +
            '<div class="col-md-6"><p><strong>Loot / HP:</strong> ' +
            (hp && Number.isFinite(loot) ? (loot / hp).toFixed(2) : '0') +
            '</p></div>' +
            '<div class="col-md-6"><p><strong>Walk on:</strong><br>' +
            'Energy: ' +
            (flags.canWalkOnEnergy ? 'yes' : 'no') +
            '<br>Fire: ' +
            (flags.canWalkOnFire ? 'yes' : 'no') +
            '<br>Poison: ' +
            (flags.canWalkOnPoison ? 'yes' : 'no') +
            '</p></div>' +
            '<div class="col-md-6"><p><strong>Other:</strong><br>' +
            'See invisible: ' +
            (immunities.invisible ? 'yes' : 'no') +
            '<br>Push items: ' +
            (flags.canPushItems ? 'yes' : 'no') +
            '</p></div></div>'
        );
    }

    function showMonsterData(spawn) {
        const id = resolveCreatureId((spawn && (spawn.creatureId || spawn.legacyName)) || '');
        const summary = (id && standardPresets[id]) || (spawn && standardPresets[spawn.creatureId]) || null;
        const title =
            (summary && summary.label) ||
            (spawn && (spawn.legacyName || spawn.creatureId)) ||
            id ||
            'Unknown';
        monsterModalTitle.textContent = title;
        if (monsterModalBody) {
            monsterModalBody.innerHTML = '<p class="text-muted mb-0">Loading…</p>';
        }
        if (monsterModal) monsterModal.show();

        const gen = ++monsterStatsLoadGen;
        loadCreatureJson(id).then((mData) => {
            if (gen !== monsterStatsLoadGen || !monsterModalBody) return;
            if (mData) {
                if (mData.label) monsterModalTitle.textContent = mData.label;
                monsterModalBody.innerHTML = renderOfficialMonsterStats(mData);
                return;
            }
            monsterModalBody.innerHTML =
                '<p>No official creature preset for <code>' +
                escapeHtml(id || spawnDisplayName(spawn)) +
                '</code>.</p>' +
                (summary
                    ? '<p class="mb-0"><strong>Standard id:</strong> ' +
                      escapeHtml(summary.id || id) +
                      (summary.customSprite
                          ? '<br><strong>Sprite:</strong> ' + escapeHtml(summary.customSprite)
                          : '') +
                      (summary.hp != null
                          ? '<br><strong>HP (list):</strong> ' + escapeHtml(summary.hp)
                          : '') +
                      '</p>'
                    : '');
        });
    }

    function frictionFindOpts() {
        if (!tilemapSession || !tilemapSession.floor) return {};
        return {
            friction: tilemapSession.floor.friction,
            cols: tilemapSession.cols,
            rows: tilemapSession.rows
        };
    }

    function collectSpawnBags() {
        const bags = [];
        for (let i = 0; i <= 15; i++) {
            const id = padFloor(i);
            if (mapSpawnsCache[id]) bags.push({ floor: id, spawns: mapSpawnsCache[id] });
        }
        return bags;
    }

    function collectWorldBags() {
        const bags = [];
        for (let i = 0; i <= 15; i++) {
            const id = padFloor(i);
            if (mapWorldCache[id]) bags.push({ floor: id, world: mapWorldCache[id] });
        }
        return bags;
    }

    function selectPaletteForCreature(rawId) {
        const item = resolvePaletteItem(rawId);
        if (!item.id) return null;
        if (!mapPalette.find((m) => paletteItemId(m) === item.id)) {
            mapPalette.push(item);
        }
        selectedPaletteItem = mapPalette.find((m) => paletteItemId(m) === item.id) || item;
        selectedMapSpawn = null;
        selectedMapSpawns = [];
        if (currentLayer === 'spawns') renderPaletteUI();
        return item;
    }

    function findSpawnUnderPointer(clickCanvasX, clickCanvasY) {
        const filterText = monsterNameInput.value.toLowerCase().trim();
        let nearest = null;
        let minDistanceSq = Infinity;
        for (const spawn of currentMapSpawns) {
            if (!matchesFilter(spawn, filterText)) continue;
            const art = resolveSpawnArt(spawn);
            const img = imageCache.get(art.standardUrl);
            const w = (img && img.loaded) ? (img.image.naturalWidth || 32) : 32;
            const h = (img && img.loaded) ? (img.image.naturalHeight || 32) : 32;
            const spawnCanvasX = spawn.x * zoomValue;
            const spawnCanvasY = spawn.y * zoomValue;
            if (clickCanvasX >= spawnCanvasX && clickCanvasX <= spawnCanvasX + w &&
                clickCanvasY >= spawnCanvasY && clickCanvasY <= spawnCanvasY + h) {
                const cx = spawnCanvasX + w / 2;
                const cy = spawnCanvasY + h / 2;
                const distSq = (clickCanvasX - cx) * (clickCanvasX - cx) + (clickCanvasY - cy) * (clickCanvasY - cy);
                if (distSq < minDistanceSq) {
                    minDistanceSq = distSq;
                    nearest = spawn;
                }
            }
        }
        return nearest;
    }

    function applyEyedropper(localX, localY, ev) {
        const statusBar = document.getElementById('statusBar');
        const clickCanvasX = ev
            ? ev.clientX - imageContainer.getBoundingClientRect().left + imageContainer.scrollLeft
            : localX * zoomValue;
        const clickCanvasY = ev
            ? ev.clientY - imageContainer.getBoundingClientRect().top + imageContainer.scrollTop
            : localY * zoomValue;

        if (currentLayer === 'spawns') {
            let pin = findSpawnUnderPointer(clickCanvasX, clickCanvasY);
            if (!pin && HdlTM && typeof HdlTM.spawnAtTile === 'function') {
                pin = HdlTM.spawnAtTile(currentMapSpawns, localX, localY);
            }
            if (pin) {
                const item = selectPaletteForCreature(pin.creatureId || pin.legacyName);
                if (statusBar) {
                    statusBar.textContent = 'Eyedrop ' + (item ? item.id : (pin.creatureId || ''));
                }
                return;
            }
            if (statusBar) statusBar.textContent = 'Eyedropper: no pin on this tile';
            return;
        }
        if (currentLayer === 'world') {
            let pin = HdlTM && typeof HdlTM.worldPinAtTile === 'function'
                ? HdlTM.worldPinAtTile(currentMapWorld, localX, localY)
                : null;
            if (pin && pin.catalogId) {
                const item = resolveWorldPaletteItem(pin.catalogId);
                if (item && !worldPalette.find((m) => m.id === item.id)) worldPalette.push(item);
                selectedWorldPalette = worldPalette.find((m) => m.id === (item && item.id)) || item;
                if (pin.kind) selectedWorldKind = pin.kind;
                renderWorldPaletteUI();
                if (statusBar) statusBar.textContent = 'Eyedrop ' + pin.kind + ' · ' + pin.catalogId;
                return;
            }
            if (statusBar) statusBar.textContent = 'Eyedropper: no World pin on this tile';
            return;
        }

        if (!tilemapSession || typeof tilemapSession.sampleCellAt !== 'function') {
            if (statusBar) statusBar.textContent = 'Eyedropper: nothing under cursor';
            return;
        }

        if (['friction', 'sight', 'flags', 'fields'].includes(currentLayer)) {
            const hit = tilemapSession.sampleCellAt(localX, localY, { channel: currentLayer });
            if (!hit) return;
            if (currentLayer === 'friction') {
                window.selectedFrictionValue = hit.value;
                if (typeof renderFrictionPaletteUI === 'function') renderFrictionPaletteUI();
                highlightChannelSwatch('value', String(hit.value));
            } else if (currentLayer === 'sight') {
                const hex = (hit.value & 0xff).toString(16).padStart(2, '0');
                window.selectedDrawColor = '#' + hex + hex + hex;
                if (typeof renderSightPaletteUI === 'function') renderSightPaletteUI();
                highlightChannelSwatch('color', window.selectedDrawColor);
            } else if (currentLayer === 'flags') {
                selectedFlagBits = hit.value;
                selectedFlagPackage = hit.value === ((HdlTM && HdlTM.TILE_FLAG_PZ_PACKAGE) || 65)
                    ? hit.value
                    : null;
                if (typeof renderFlagsPaletteUI === 'function') renderFlagsPaletteUI();
                highlightChannelSwatch('bits', String(hit.value));
            } else if (currentLayer === 'fields') {
                selectedFieldValue = hit.value;
                if (typeof renderFieldsPaletteUI === 'function') renderFieldsPaletteUI();
                highlightChannelSwatch('value', String(hit.value));
            }
            if (statusBar) statusBar.textContent = 'Eyedrop ' + currentLayer + ' = ' + hit.value;
            return;
        }

        const sub = tileMapSubFromLayer(currentLayer);
        const hit = tilemapSession.sampleCellAt(localX, localY, sub ? { subLayer: sub } : {});
        if (!hit || hit.kind !== 'tilemap') {
            if (statusBar) statusBar.textContent = 'Eyedropper: empty cell';
            return;
        }
        if (!hit.stamp) {
            tilemapEraseMode = true;
            if (statusBar) statusBar.textContent = 'Eyedropper: empty tile';
            if (isTileMapLayer(currentLayer)) renderTileMapPaletteUI();
            return;
        }
        tilemapEraseMode = false;
        tilemapRawStamp = hit.stamp && hit.stamp.wangLocked ? hit.stamp : null;
        tilemapSession.selectStamp(hit.stamp);
        if (hit.subLayer && currentLayer !== 'tilemap:' + hit.subLayer) {
            selectFloorAndLayer(currentFloor, 'tilemap:' + hit.subLayer);
        } else if (isTileMapLayer(currentLayer)) {
            renderTileMapPaletteUI();
        }
        if (statusBar) {
            const fam = hit.stamp.wallFamily || hit.stamp.wangFamily;
            const label = fam && !hit.stamp.wangLocked
                ? fam
                : (hit.stamp.catalogId || '');
            statusBar.textContent = 'Eyedrop ' + label +
                (hit.subLayer ? ' · ' + hit.subLayer : '') +
                (hit.stamp.wangLocked ? ' (RAW)' : '');
        }
    }

    function applyRawCatalogStamp() {
        if (!tilemapSession) return;
        const idEl = document.getElementById('tilemap-raw-id');
        const kindEl = document.getElementById('tilemap-raw-kind');
        const catalogId = idEl ? String(idEl.value || '').trim() : '';
        if (!catalogId) return;
        const kind = kindEl && kindEl.value === 'objects'
            ? 'objects'
            : (kindEl && kindEl.value === 'overlays' ? 'overlays' : 'tiles');
        const sub = tileMapSubFromLayer(currentLayer) || (tilemapSession.activeSubLayer) || 'ground';
        const parsed = kind === 'overlays' && HdlTM && typeof HdlTM.parseWangId === 'function'
            ? HdlTM.parseWangId(catalogId)
            : null;
        const wallParsed = kind === 'objects' && HdlTM && typeof HdlTM.parseWallId === 'function'
            ? HdlTM.parseWallId(catalogId)
            : null;
        const roleId = kind === 'overlays'
            ? (parsed && parsed.family === 'water' ? 'water' : 'path')
            : wallParsed
              ? 'wall'
              : (sub === 'ground' ? 'floor' : null);
        const colors = (HdlTM && HdlTM.ROLE_PREVIEW_COLORS) || {};
        tilemapRawStamp = {
            catalogId,
            kind,
            roleId,
            subLayer: kind === 'overlays' ? 'path' : (wallParsed ? 'vertical' : sub),
            wangFamily: parsed ? parsed.family : undefined,
            wangMask: parsed ? parsed.mask : undefined,
            wallFamily: wallParsed ? wallParsed.family : undefined,
            wallAlign: wallParsed ? wallParsed.align : undefined,
            wangLocked: !!(kind === 'overlays' && parsed) || !!wallParsed,
            wangResolve: false,
            label: catalogId + ' (RAW)',
            previewColor: colors[roleId] || '#666666'
        };
        tilemapSession.selectStamp(tilemapRawStamp);
        tilemapEraseMode = false;
        if (kind === 'overlays' && currentLayer !== 'tilemap:path') {
            selectFloorAndLayer(currentFloor, 'tilemap:path');
        } else if (wallParsed && currentLayer !== 'tilemap:vertical') {
            selectFloorAndLayer(currentFloor, 'tilemap:vertical');
        } else {
            renderTileMapPaletteUI();
        }
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.textContent = 'RAW ' + catalogId;
    }

    function copySelectedTiles() {
        if (!tilemapSession || typeof tilemapSession.copyTiles !== 'function' || !selectionRect) {
            return false;
        }
        if (selectionRect.w < 0.5 && selectionRect.h < 0.5) return false;
        const rect = {
            x0: Math.floor(selectionRect.x),
            y0: Math.floor(selectionRect.y),
            x1: Math.floor(selectionRect.x + selectionRect.w),
            y1: Math.floor(selectionRect.y + selectionRect.h)
        };
        const sub = tileMapSubFromLayer(currentLayer);
        const clip = tilemapSession.copyTiles(rect, sub ? { subLayer: sub } : { allLayers: true });
        if (!clip) return false;
        tileClipboard = clip;
        const statusBar = document.getElementById('statusBar');
        if (statusBar) {
            statusBar.textContent = 'Copied ' + clip.w + '×' + clip.h + ' tiles';
        }
        return true;
    }

    function pasteTileClipboard() {
        if (!tilemapSession || typeof tilemapSession.pasteTiles !== 'function' || !tileClipboard) {
            return false;
        }
        const destX = lastMapTile && lastMapTile.x != null ? Math.floor(lastMapTile.x) : 0;
        const destY = lastMapTile && lastMapTile.y != null ? Math.floor(lastMapTile.y) : 0;
        const { rect } = tilemapSession.pasteTiles(tileClipboard, destX, destY);
        if (rect) {
            syncCanvasesFromSession(rect, {
                layers: ['tilemap', 'friction', 'sight', 'flags']
            });
        }
        updateUndoRedoUI();
        setDirty(true);
        const statusBar = document.getElementById('statusBar');
        if (statusBar) {
            statusBar.textContent = 'Pasted ' + tileClipboard.w + '×' + tileClipboard.h + ' tiles at ' + destX + ',' + destY;
        }
        return true;
    }

    function highlightChannelSwatch(dataKey, value) {
        document.querySelectorAll('.tile-swatch').forEach((sw) => {
            const raw = sw.dataset[dataKey];
            sw.style.borderColor = String(raw) === String(value) ? '#0d6efd' : 'transparent';
        });
    }

    function copySelectedWorld() {
        if (!HdlTM || typeof HdlTM.copyWorldPins !== 'function') return false;
        const src = selectedWorldPins.length ? selectedWorldPins : (selectedWorldPin ? [selectedWorldPin] : []);
        const clip = HdlTM.copyWorldPins(src);
        if (!clip) return false;
        worldClipboard = clip;
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.textContent = 'Copied ' + clip.pins.length + ' World pin(s)';
        return true;
    }

    function pasteWorldClipboard() {
        if (!HdlTM || typeof HdlTM.pasteWorldPins !== 'function' || !worldClipboard) return false;
        const dest = {
            x: lastMapTile.x,
            y: lastMapTile.y,
            z: parseInt(currentFloor, 10) || 0
        };
        const pins = HdlTM.pasteWorldPins(worldClipboard, dest, worldCatalog, currentMapWorld);
        if (!pins.length) return false;
        saveState();
        for (let i = 0; i < pins.length; i++) currentMapWorld.push(pins[i]);
        mapWorldCache[currentFloor] = currentMapWorld;
        selectedWorldPins = pins.slice();
        selectedWorldPin = pins[0];
        selectedWorldPalette = null;
        renderSpawns();
        updateFloorCounts();
        renderWorldProperties();
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.textContent = 'Pasted ' + pins.length + ' World pin(s)';
        return true;
    }

    function copySelectedSpawns() {
        if (!HdlTM || typeof HdlTM.copySpawnPins !== 'function') return false;
        const src = selectedMapSpawns.length ? selectedMapSpawns : (selectedMapSpawn ? [selectedMapSpawn] : []);
        const clip = HdlTM.copySpawnPins(src);
        if (!clip) return false;
        spawnClipboard = clip;
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.textContent = 'Copied ' + clip.pins.length + ' spawn pin(s)';
        return true;
    }

    function pasteSpawnClipboard() {
        if (!HdlTM || typeof HdlTM.pasteSpawnPins !== 'function' || !spawnClipboard) return false;
        const dest = {
            x: lastMapTile.x,
            y: lastMapTile.y,
            z: parseInt(currentFloor, 10) || 0
        };
        const pins = HdlTM.pasteSpawnPins(spawnClipboard, dest, standardPresets);
        if (!pins.length) return false;
        saveState();
        for (let i = 0; i < pins.length; i++) currentMapSpawns.push(pins[i]);
        mapSpawnsCache[currentFloor] = currentMapSpawns;
        selectedMapSpawns = pins.slice();
        selectedMapSpawn = pins[0];
        selectedPaletteItem = null;
        renderSpawns();
        updateFloorCounts();
        renderSpawnProperties();
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.textContent = 'Pasted ' + pins.length + ' spawn pin(s)';
        return true;
    }

    function hideBsModal(id) {
        const el = document.getElementById(id);
        if (!el || typeof bootstrap === 'undefined' || !bootstrap.Modal) return;
        const inst = bootstrap.Modal.getInstance(el);
        if (inst) inst.hide();
    }

    function jumpToSpawnHit(hit) {
        if (!hit) return;
        if (hit.pin) {
            const z = hit.floor != null ? hit.floor : (hit.pin.z != null ? hit.pin.z : currentFloor);
            zoomImageAtPoint(hit.pin.x, hit.pin.y, z, Math.max(currentZoomPct(), 800));
            if (padFloor(z) === currentFloor) {
                selectedWorldPin = hit.pin;
                selectedWorldPins = [hit.pin];
                renderWorldProperties();
                renderSpawns();
            }
            return;
        }
        if (!hit.spawn) return;
        const z = hit.floor != null ? hit.floor : (hit.spawn.z != null ? hit.spawn.z : currentFloor);
        zoomImageAtPoint(hit.spawn.x, hit.spawn.y, z, Math.max(currentZoomPct(), 800));
        if (padFloor(z) === currentFloor) {
            selectedMapSpawn = hit.spawn;
            selectedMapSpawns = [hit.spawn];
            renderSpawnProperties();
            renderSpawns();
        }
    }

    function runGotoQuery(text) {
        if (!HdlTM || typeof HdlTM.parseGotoQuery !== 'function') return false;
        const parsed = HdlTM.parseGotoQuery(text);
        if (!parsed) return false;
        if (parsed.kind === 'xyz') {
            const z = parsed.z != null ? parsed.z : currentFloor;
            zoomImageAtPoint(parsed.x, parsed.y, z, currentZoomPct());
            const statusBar = document.getElementById('statusBar');
            if (statusBar) {
                statusBar.textContent = 'Goto ' + parsed.x + ',' + parsed.y +
                    (parsed.z != null ? ',' + parsed.z : '');
            }
            return true;
        }
        const key = parsed.query;
        if (key !== gotoSearchKey) {
            gotoSearchKey = key;
            gotoSearchIndex = 0;
            if (typeof HdlTM.findSpawnHits === 'function') {
                gotoSearchHits = HdlTM.findSpawnHits(collectSpawnBags(), {
                    query: key,
                    presets: standardPresets
                });
            } else {
                const rows = currentMapSpawns.filter((s) => matchesFilter(s, key));
                gotoSearchHits = rows.map((spawn) => ({
                    floor: currentFloor,
                    spawn,
                    issue: 'ok'
                }));
            }
            if (typeof HdlTM.findWorldHits === 'function') {
                const worldHits = HdlTM.findWorldHits(collectWorldBags(), {
                    query: key,
                    catalogs: worldCatalog
                });
                gotoSearchHits = gotoSearchHits.concat(worldHits);
            }
        } else {
            gotoSearchIndex += 1;
        }
        if (!gotoSearchHits.length) {
            const statusBar = document.getElementById('statusBar');
            if (statusBar) statusBar.textContent = 'No pins match “' + key + '”';
            return false;
        }
        const hit = gotoSearchHits[gotoSearchIndex % gotoSearchHits.length];
        jumpToSpawnHit(hit);
        const statusBar = document.getElementById('statusBar');
        if (statusBar) {
            statusBar.textContent = 'Match ' +
                ((gotoSearchIndex % gotoSearchHits.length) + 1) +
                '/' + gotoSearchHits.length +
                ' · ' + (hit.pin
                    ? (hit.pin.catalogId || hit.pin.id || 'world')
                    : (hit.spawn && hit.spawn.creatureId) || '');
        }
        return true;
    }

    function openGotoModal() {
        const el = document.getElementById('gotoModal');
        const input = document.getElementById('gotoInput');
        if (!el || typeof bootstrap === 'undefined' || !bootstrap.Modal) {
            const text = window.prompt('Goto x,y[,z] or creature id', '');
            if (text) runGotoQuery(text);
            return;
        }
        const modal = bootstrap.Modal.getOrCreateInstance(el);
        modal.show();
        setTimeout(() => {
            if (input) {
                input.focus();
                input.select();
            }
        }, 150);
    }

    function renderFindHits(hits, label) {
        const list = document.getElementById('findResultsList');
        const status = document.getElementById('findStatus');
        const floorOnly = document.getElementById('findCurrentFloorOnly');
        const floorNote = floorOnly && floorOnly.checked ? ' · current floor' : '';
        if (status) {
            status.textContent = (label || 'Results') + ': ' + hits.length +
                (label === 'Blocked' ? ' (current floor friction)' : '') +
                floorNote;
        }
        if (!list) return;
        if (!hits.length) {
            list.innerHTML = '<div class="text-secondary">No matches.</div>';
            return;
        }
        const cap = hits.slice(0, 250);
        list.innerHTML = cap.map((hit, i) => {
            const s = hit.pin || hit.spawn || {};
            const id = escapeHtml(
                hit.pin
                    ? (s.catalogId || s.id || 'world')
                    : (s.creatureId || '(empty)')
            );
            const kind = hit.pin ? ' · world' : '';
            const issue = hit.issue && hit.issue !== 'ok' ? ' · ' + hit.issue : '';
            return '<div class="find-hit px-2 py-1 border-bottom border-secondary" data-idx="' + i + '">' +
                '<span class="text-info">z' + escapeHtml(hit.floor) + '</span> ' +
                Math.round(Number(s.x)) + ',' + Math.round(Number(s.y)) +
                ' <code>' + id + '</code>' + escapeHtml(kind + issue) +
                '</div>';
        }).join('');
        list.querySelectorAll('.find-hit').forEach((row) => {
            row.addEventListener('click', () => {
                const idx = parseInt(row.dataset.idx, 10);
                const hit = cap[idx];
                if (!hit) return;
                jumpToSpawnHit(hit);
                hideBsModal('findModal');
            });
        });
    }

    function collectFindBags() {
        const bags = collectSpawnBags();
        const floorOnly = document.getElementById('findCurrentFloorOnly');
        if (!floorOnly || !floorOnly.checked) return bags;
        return bags.filter((b) => padFloor(b.floor) === currentFloor);
    }

    function runFind(kind) {
        if (!HdlTM || typeof HdlTM.findSpawnHits !== 'function') return;
        lastFindKind = kind;
        const q = (document.getElementById('findInput') && document.getElementById('findInput').value) || '';
        const opts = {
            presets: standardPresets,
            frictionForFloor: (f) => (padFloor(f) === currentFloor ? frictionFindOpts() : null)
        };
        if (kind === 'unknown') opts.issue = 'unknown';
        else if (kind === 'blocked') opts.issue = 'blocked';
        else if (q.trim()) opts.query = q.trim();
        let hits = HdlTM.findSpawnHits(collectFindBags(), opts);
        if (typeof HdlTM.findWorldHits === 'function') {
            const worldOpts = {
                catalogs: worldCatalog,
                frictionForFloor: opts.frictionForFloor
            };
            if (opts.issue) worldOpts.issue = opts.issue;
            if (opts.query) worldOpts.query = opts.query;
            let worldBags = collectWorldBags();
            const floorOnly = document.getElementById('findCurrentFloorOnly');
            if (floorOnly && floorOnly.checked) {
                worldBags = worldBags.filter((b) => padFloor(b.floor) === currentFloor);
            }
            hits = hits.concat(HdlTM.findWorldHits(worldBags, worldOpts));
        }
        renderFindHits(hits, kind === 'unknown' ? 'Unknown' : kind === 'blocked' ? 'Blocked' : 'Search');
    }

    function openFindModal() {
        const el = document.getElementById('findModal');
        if (!el || typeof bootstrap === 'undefined' || !bootstrap.Modal) return;
        bootstrap.Modal.getOrCreateInstance(el).show();
        const input = document.getElementById('findInput');
        setTimeout(() => {
            if (input) input.focus();
        }, 150);
    }

    function scheduleMinimap() {
        if (minimapRaf) return;
        minimapRaf = requestAnimationFrame(() => {
            minimapRaf = 0;
            drawMinimap();
        });
    }

    function drawMinimap() {
        const canvas = document.getElementById('mapMinimap');
        if (!canvas || !HdlTM || typeof HdlTM.fillMinimapRgba !== 'function') return;
        const destW = HdlTM.MINIMAP_DEFAULT_W || 248;
        const destH = HdlTM.MINIMAP_DEFAULT_H || 198;
        if (canvas.width !== destW) canvas.width = destW;
        if (canvas.height !== destH) canvas.height = destH;
        const ctxMini = canvas.getContext('2d');
        if (!ctxMini) return;
        updateViewPort();
        const cols = tilemapSession ? tilemapSession.cols : (bounds.width || 2560);
        const rows = tilemapSession ? tilemapSession.rows : (bounds.height || 2048);
        const friction = tilemapSession && tilemapSession.floor ? tilemapSession.floor.friction : null;
        const filterText = monsterNameInput ? monsterNameInput.value.toLowerCase().trim() : '';
        const visible = [];
        for (let i = 0; i < currentMapSpawns.length; i++) {
            if (matchesFilter(currentMapSpawns[i], filterText)) visible.push(currentMapSpawns[i]);
        }
        const img = ctxMini.createImageData(destW, destH);
        HdlTM.fillMinimapRgba(img.data, {
            cols,
            rows,
            friction,
            destW,
            destH,
            spawns: visible,
            world: currentMapWorld,
            presets: standardPresets,
            viewRect: {
                x: viewPortX,
                y: viewPortY,
                w: viewPortWidth,
                h: viewPortHeight
            }
        });
        ctxMini.putImageData(img, 0, 0);
    }

    /**
     * Center view on map-local (x, y). Same contract as map-spawn.js
     * zoomImageAtPoint. Accepts legacy world deep-links via deepLinkToLocal.
     */
    function zoomImageAtPoint(x, y, floorZ, zoomPercentage = 1600) {
        const floorStr = padFloor(floorZ);
        selectFloorAndLayer(floorStr, currentLayer);

        const local = deepLinkToLocal(x, y);

        setTimeout(() => {
            const scrollContainer = imageContainer;
            scrollContainer.offsetWidth;
            const btn = Array.from(zoomButtons).find(
                (b) =>
                    b.dataset.zoom == String(Number(zoomPercentage) / 100)
            );
            if (btn) btn.click();

            setTimeout(() => {
                const clientWidth = scrollContainer.clientWidth;
                const clientHeight = scrollContainer.clientHeight;
                const scaleDisplayed = Number(zoomPercentage) / 100;
                scrollContainer.scrollLeft = Math.max(
                    0,
                    local.x * scaleDisplayed - clientWidth / 2
                );
                scrollContainer.scrollTop = Math.max(
                    0,
                    local.y * scaleDisplayed - clientHeight / 2
                );
                renderSpawns();
            }, 10);
        }, 250);
    }

    const btnGoto = document.getElementById('btnGoto');
    const btnFind = document.getElementById('btnFind');
    if (btnGoto) btnGoto.addEventListener('click', () => openGotoModal());
    if (btnFind) btnFind.addEventListener('click', () => openFindModal());
    const gotoGo = document.getElementById('gotoModalGo');
    const gotoInput = document.getElementById('gotoInput');
    if (gotoGo) {
        gotoGo.addEventListener('click', () => {
            if (gotoInput && runGotoQuery(gotoInput.value)) hideBsModal('gotoModal');
        });
    }
    if (gotoInput) {
        gotoInput.addEventListener('keydown', (e) => {
            if (e.code === 'Enter') {
                e.preventDefault();
                if (runGotoQuery(gotoInput.value)) hideBsModal('gotoModal');
            }
        });
    }
    const findBtnSearch = document.getElementById('findBtnSearch');
    const findBtnUnknown = document.getElementById('findBtnUnknown');
    const findBtnBlocked = document.getElementById('findBtnBlocked');
    const findInput = document.getElementById('findInput');
    const findCurrentFloorOnly = document.getElementById('findCurrentFloorOnly');
    if (findBtnSearch) findBtnSearch.addEventListener('click', () => runFind('search'));
    if (findBtnUnknown) findBtnUnknown.addEventListener('click', () => runFind('unknown'));
    if (findBtnBlocked) findBtnBlocked.addEventListener('click', () => runFind('blocked'));
    if (findInput) {
        findInput.addEventListener('keydown', (e) => {
            if (e.code === 'Enter') {
                e.preventDefault();
                runFind('search');
            }
        });
    }
    if (findCurrentFloorOnly) {
        findCurrentFloorOnly.addEventListener('change', () => {
            if (lastFindKind) runFind(lastFindKind);
        });
    }
    const minimapEl = document.getElementById('mapMinimap');
    if (minimapEl) {
        minimapEl.addEventListener('click', (e) => {
            if (!HdlTM || typeof HdlTM.minimapToMap !== 'function') return;
            const rect = minimapEl.getBoundingClientRect();
            const destW = minimapEl.width || 248;
            const destH = minimapEl.height || 198;
            const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * destW;
            const py = ((e.clientY - rect.top) / Math.max(1, rect.height)) * destH;
            const cols = tilemapSession ? tilemapSession.cols : (bounds.width || 2560);
            const rows = tilemapSession ? tilemapSession.rows : (bounds.height || 2048);
            const tile = HdlTM.minimapToMap(px, py, cols, rows, destW, destH);
            zoomImageAtPoint(tile.x, tile.y, currentFloor, currentZoomPct());
        });
    }
    imageContainer.addEventListener('scroll', () => {
        scheduleMinimap();
    });

    // Boot: deep-link or default center (local 1129,767 @ 1600% — map-spawn.js)
    const urlParams = new URLSearchParams(window.location.search);
    const centerPoint = urlParams.get('point');

    selectFloorAndLayer(currentFloor, 'spawns', () => {
        if (centerPoint) {
            const params = centerPoint.split(',');
            setTimeout(() => {
                if (params[3] !== undefined) {
                    zoomImageAtPoint(params[0], params[1], params[2], params[3]);
                } else {
                    zoomImageAtPoint(params[0], params[1], params[2]);
                }
            }, 600);
        } else {
            setTimeout(() => {
                zoomImageAtPoint(1129, 767, 7, 100);
            }, 600);
        }
    });

    async function saveFloorSpawns(floor) {
        if (!mapSpawnsCache[floor]) return;
        
        const floorZ = parseInt(floor, 10) || 0;
        const cleanSpawns = mapSpawnsCache[floor].map((spawn) => {
            if (HdlTM && typeof HdlTM.makeEditorSpawnPin === 'function') {
                const pin = HdlTM.makeEditorSpawnPin(spawn, standardPresets, {
                    z: floorZ,
                    respawn: spawn.respawn != null ? spawn.respawn : defaultSpawnRespawn()
                });
                if (pin) return pin;
            }
            return {
                creatureId: resolveCreatureId(spawn.creatureId || spawn.legacyName),
                x: Math.round(Number(spawn.x)),
                y: Math.round(Number(spawn.y)),
                z: spawn.z != null ? Number(spawn.z) : floorZ,
                respawn:
                    spawn.respawn != null
                        ? Math.max(0, Number(spawn.respawn) || 0)
                        : defaultSpawnRespawn()
            };
        });

        const formData = new FormData();
        formData.append('floor', floor);
        formData.append('spawns', JSON.stringify(cleanSpawns));

        const res = await fetch(window.__API_URL__ + '?action=legacy_map_save_spawns', {
            method: 'POST',
            body: formData
        });

        if (!res.ok) {
            throw new Error(`Failed to save spawns for floor ${floor}`);
        }
        if (HdlTM && typeof HdlTM.markSpawnBaseline === 'function') {
            HdlTM.markSpawnBaseline(mapSpawnsCache[floor]);
        }
    }

    async function saveFloorWorld(floor) {
        if (!mapWorldCache[floor]) return;
        const floorZ = parseInt(floor, 10) || 0;
        const clean = HdlTM && typeof HdlTM.stripWorldListForSave === 'function'
            ? HdlTM.stripWorldListForSave(mapWorldCache[floor].map((p) => Object.assign({}, p, { z: p.z != null ? p.z : floorZ })))
            : mapWorldCache[floor];
        const formData = new FormData();
        formData.append('floor', floor);
        formData.append('world', JSON.stringify(clean));
        const res = await fetch(window.__API_URL__ + '?action=legacy_map_save_world', {
            method: 'POST',
            body: formData
        });
        if (!res.ok) {
            const t = await res.text();
            throw new Error('Failed to save World pins for floor ' + floor + ': ' + t);
        }
        if (HdlTM && typeof HdlTM.markWorldBaseline === 'function') {
            HdlTM.markWorldBaseline(mapWorldCache[floor]);
        }
    }

    /**
     * Build a detached canvas PNG data URL from session (or base) for legacy layer save.
     * @param {string} layer
     * @returns {string|null} data URL
     */
    function channelToDataUrl(layer) {
        const ch = layer === 'path' ? 'friction' : layer;
        // Without a session, friction/path live on the detached world canvas.
        if (!tilemapSession && ch === 'friction' && worldCanvas && worldCanvas.width) {
            return worldCanvas.toDataURL('image/png');
        }
        if (!editorViewport) return null;
        if (tilemapSession) editorViewport.setSession(tilemapSession);
        const pack = editorViewport.exportChannelRgba(ch);
        if (!pack || !pack.width) return null;
        if (!exportCanvas) exportCanvas = document.createElement('canvas');
        exportCanvas.width = pack.width;
        exportCanvas.height = pack.height;
        const xctx = exportCanvas.getContext('2d');
        const img = xctx.createImageData(pack.width, pack.height);
        img.data.set(pack.data);
        xctx.putImageData(img, 0, 0);
        return exportCanvas.toDataURL('image/png');
    }

    async function saveLayerImage(floor, layer) {
        if (layer === 'spawns' || layer === 'world' || isTileMapLayer(layer)) {
            return;
        }
        const dataUrl = channelToDataUrl(layer);
        if (!dataUrl) return;

        const base64Data = dataUrl.split(',')[1];

        let targetLayer = layer;
        if (layer === 'friction') {
            targetLayer = 'path';
        }

        const formData = new FormData();
        formData.append('floor', floor);
        formData.append('layer', targetLayer);
        formData.append('image', base64Data);

        const res = await fetch(window.__API_URL__ + '?action=legacy_map_save_layer', {
            method: 'POST',
            body: formData
        });

        if (!res.ok) {
            throw new Error(`Failed to save layer ${layer} for floor ${floor}`);
        }
    }

    /**
     * Chunked hybrid save: begin (map.json) + one binary POST per gzip blob.
     * Blobs from serializeHybridPack are already gzip (`*.u8.gz` / `*.u16.gz`) so
     * full floors stay well under PHP post_max_size (no raw 5–10MB grids).
     */
    async function saveHybridPack(floor) {
        if (!tilemapSession || !HdlTM) {
            throw new Error('No TileMap session to save');
        }
        const floorId = padFloor(floor);
        await ensureFloorSpawnsLoaded(floorId);
        const statusBar = document.getElementById('statusBar');
        if (statusBar) statusBar.textContent = 'Building hybrid pack…';

        const transport =
            typeof tilemapSession.toHybridBinaryTransport === 'function'
                ? tilemapSession.toHybridBinaryTransport({
                      id: 'floor_' + floorId,
                      label: 'Legacy floor ' + floorId,
                      spawns: mapSpawnsCache[floorId] || mapSpawnsCache[floor] || null,
                      world: mapWorldCache[floorId] || mapWorldCache[floor] || null
                  })
                : null;

        if (!transport) {
            throw new Error('Map editor bundle outdated — rebuild map-editor.bundle.js');
        }

        // 1) meta only
        const beginFd = new FormData();
        beginFd.append('floor', floorId);
        beginFd.append('meta', JSON.stringify(transport.meta));
        const beginRes = await fetch(
            window.__API_URL__ + '?action=legacy_map_save_hybrid_begin',
            { method: 'POST', body: beginFd }
        );
        if (!beginRes.ok) {
            const t = await beginRes.text();
            throw new Error('Failed to start hybrid save: ' + t);
        }

        // 2) each blob = on-disk gzip file bytes (magic 1f 8b); no Content-Encoding wrap
        const rels = Object.keys(transport.blobs);
        for (let i = 0; i < rels.length; i++) {
            const rel = rels[i];
            const u8 = transport.blobs[rel];
            if (statusBar) {
                statusBar.textContent = 'Saving hybrid blob ' + (i + 1) + '/' + rels.length + '…';
            }
            if (!(rel.endsWith('.u8.gz') || rel.endsWith('.u16.gz'))) {
                throw new Error('Hybrid blob path must be *.u8.gz or *.u16.gz: ' + rel);
            }
            if (!u8 || u8.byteLength < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) {
                throw new Error('Hybrid blob is not gzip (rebuild map-editor.bundle.js): ' + rel);
            }
            const headers = { 'Content-Type': 'application/octet-stream' };
            const url =
                window.__API_URL__ +
                '?action=legacy_map_save_hybrid_blob&floor=' +
                encodeURIComponent(floorId) +
                '&path=' +
                encodeURIComponent(rel);
            const blobRes = await fetch(url, { method: 'POST', headers, body: u8 });
            if (!blobRes.ok) {
                const t = await blobRes.text();
                throw new Error('Failed to save hybrid blob ' + rel + ': ' + t);
            }
        }

        // Path PNG bootstrap must match hybrid channels (export from session, not multi-canvas).
        // Non-fatal: hybrid pack is already the source of truth on disk.
        if (tilemapSession && tilemapSession.floor) {
            try {
                if (statusBar) statusBar.textContent = 'Exporting path PNG from session…';
                await saveLayerImage(floorId, 'friction');
            } catch (e) {
                console.warn('path PNG export failed (hybrid still saved)', e);
            }
        }
        tilemapSession.markClean();
        if (HdlTM && typeof HdlTM.markWorldBaseline === 'function' && mapWorldCache[floorId]) {
            HdlTM.markWorldBaseline(mapWorldCache[floorId]);
        }
        if (statusBar) statusBar.textContent = 'Hybrid pack saved';
    }

    window.saveCurrentMap = async function() {
        if (!isMapEditReady()) {
            const statusBarEarly = document.getElementById('statusBar');
            if (statusBarEarly) statusBarEarly.textContent = 'Map is still loading';
            return;
        }
        const btnSaveMap = document.getElementById('btnSaveMap');
        const statusBar = document.getElementById('statusBar');
        if (btnSaveMap) btnSaveMap.disabled = true;
        if (statusBar) statusBar.textContent = 'Saving...';

        const channelLayers = ['friction', 'sight', 'flags', 'fields'];
        
        try {
            if (currentLayer === 'spawns') {
                await saveFloorSpawns(currentFloor);
            } else if (currentLayer === 'world') {
                await ensureTilemapSession();
                if (tilemapSession) {
                    await saveHybridPack(currentFloor);
                } else {
                    await saveFloorWorld(currentFloor);
                }
            } else if (
                isTileMapLayer(currentLayer) ||
                channelLayers.includes(currentLayer) ||
                (tilemapSession && tilemapSession.dirty)
            ) {
                // TileMap + channel layers always write the hybrid pack (fields live
                // only in hybrid; path PNG alone cannot hold them). ensureSession
                // bootstraps from hybrid or path PNG when the floor was opened
                // spawns-only (preferHybridOnly).
                await ensureTilemapSession();
                if (!tilemapSession) {
                    throw new Error(
                        'No map session to save — hybrid load / path PNG bootstrap failed'
                    );
                }
                await saveHybridPack(currentFloor);
                if (mapSpawnsCache[currentFloor]) {
                    await saveFloorSpawns(currentFloor);
                }
                if (mapWorldCache[currentFloor]) {
                    await saveFloorWorld(currentFloor);
                }
            } else {
                await saveLayerImage(currentFloor, currentLayer);
            }
            setDirty(false);
            if (statusBar) statusBar.textContent = 'Map saved';
        } catch (e) {
            console.error(e);
            alert('Error saving map: ' + e.message);
            if (statusBar) statusBar.textContent = 'Error saving map';
        } finally {
            if (btnSaveMap) btnSaveMap.disabled = false;
        }
    };

    const btnSaveMap = document.getElementById('btnSaveMap');
    if (btnSaveMap) {
        btnSaveMap.addEventListener('click', window.saveCurrentMap);
    }

    const btnExportPng = document.getElementById('btnExportPng');
    if (btnExportPng) {
        btnExportPng.addEventListener('click', () => {
            if (tilemapSession && editorViewport) {
                editorViewport.setSession(tilemapSession);
            }
            const dataUrl = channelToDataUrl('friction');
            if (!dataUrl && worldCanvas && worldCanvas.width) {
                const a = document.createElement('a');
                a.href = worldCanvas.toDataURL('image/png');
                a.download = 'floor-' + currentFloor + '-path.png';
                a.click();
                return;
            }
            if (!dataUrl) {
                alert('No friction map to export');
                return;
            }
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = 'floor-' + currentFloor + '-path.png';
            a.click();
        });
    }

    // Boot TileMap presets in background
    loadTilemapPresets();
});
</script>
</body>
</html>
