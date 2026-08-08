<?php
/**
 * Hunt Simulator page template (Stage 7: party editor + live hunt watch).
 * Expects $appRoot (web path to project root, usually '') and optional $pageTitle.
 */

declare(strict_types=1);

$pageTitle = $pageTitle ?? 'Hunt Simulator — Hunt Design Lab';
$appRoot = isset($appRoot) ? rtrim((string) $appRoot, '/') : '';
$asset = static function (string $path) use ($appRoot): string {
    $path = ltrim($path, '/');
    return ($appRoot === '' ? '' : $appRoot) . '/' . $path;
};
$apiUrl = $asset('php/api.php');
$cssUrl = $asset('build/app.css');
$bundleUrl = $asset('build/app.bundle.js');
$contentMode = function_exists('hdl_default_mode_id') ? hdl_default_mode_id() : 'standard';
$modesList = function_exists('hdl_list_modes') ? hdl_list_modes() : [
    ['id' => 'standard', 'label' => 'Standard', 'isDefault' => true],
    ['id' => 'legacy', 'label' => 'Legacy (dev port)', 'isDefault' => false],
];
?>
<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title><?= htmlspecialchars($pageTitle, ENT_QUOTES, 'UTF-8') ?></title>
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon-32.png?v=4'), ENT_QUOTES, 'UTF-8') ?>" type="image/png" sizes="32x32">
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon.svg?v=4'), ENT_QUOTES, 'UTF-8') ?>" type="image/svg+xml">
    <link rel="icon" href="<?= htmlspecialchars($asset('assets/brand/favicon.ico?v=4'), ENT_QUOTES, 'UTF-8') ?>" sizes="any">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <link href="<?= htmlspecialchars($cssUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.5.0" rel="stylesheet">
</head>
<body id="game-app">

<script>
    window.__APP_ROOT__ = <?= json_encode($appRoot === '' ? '/' : $appRoot . '/', JSON_UNESCAPED_SLASHES) ?>;
    window.__API_URL__ = <?= json_encode($apiUrl, JSON_UNESCAPED_SLASHES) ?>;
    window.__CONTENT_MODE__ = <?= json_encode($contentMode, JSON_UNESCAPED_SLASHES) ?>;
    window.__MODES__ = <?= json_encode($modesList, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?>;
</script>

<div class="editor-app-container">

    <header class="editor-header-bar">
        <a class="brand" title="Hunt Design Lab" href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">
            <i class="fa-solid fa-dragon"></i> HuntDL
        </a>
<?php $activeNav = 'hunt'; require __DIR__ . '/partials/header_nav.php'; ?>
        <div class="global-actions">
            <span id="sessionStateBadge" class="badge-retro">READY</span>
        </div>
    </header>

    <div class="editor-workspace editor-workspace--split">
        <aside class="am-sidebar game-sidebar">
            <div class="am-sidebar-body">
                <div id="gameLoadError" class="alert alert-danger py-2 px-2 small mb-2" hidden></div>

                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Session</h2>
                    <label class="label-retro" for="modeSelect">Content mode</label>
                    <select class="form-select form-select-retro w-100 mb-2" id="modeSelect" title="standard = product pack; legacy = reference pack"></select>

                    <label class="label-retro" for="huntSelect">Hunt preset</label>
                    <select class="form-select form-select-retro w-100 mb-2" id="huntSelect"></select>

                    <label class="label-retro" for="partySelect">Party</label>
                    <select class="form-select form-select-retro w-100 mb-2" id="partySelect" title="Party presets from base profiles (presets/parties)"></select>

                    <label class="label-retro" for="seedInput">Seed</label>
                    <input type="number" class="form-control form-control-retro w-100 mb-2" id="seedInput" value="42" min="1" step="1">

                    <div class="d-flex justify-content-between align-items-center mb-3">
                        <label class="label-retro mb-0" title="Control mode for the active camera member">Active Control</label>
                        <div class="btn-group btn-group-sm" role="group" aria-label="Active Member Control Mode">
                            <input type="radio" class="btn-check" name="activeControlMode" id="controlModeAi" autocomplete="off" checked value="ai">
                            <label class="btn btn-outline-info btn-retro" for="controlModeAi"><i class="fa-solid fa-robot"></i> AI</label>
                            <input type="radio" class="btn-check" name="activeControlMode" id="controlModeManual" autocomplete="off" value="manual">
                            <label class="btn btn-outline-warning btn-retro" for="controlModeManual"><i class="fa-solid fa-gamepad"></i> Manual</label>
                        </div>
                    </div>

                    <div id="manualControlOptions" class="card card-retro p-2 mb-3" style="display: none;">
                        <div class="d-flex justify-content-between align-items-center mb-2">
                            <label class="label-retro mb-0 text-white text-xs" for="autoChaseToggle" title="Automatically step toward the targeted creature when in manual control">Auto Chase</label>
                            <input type="checkbox" class="form-check-input mt-0" id="autoChaseToggle" style="cursor: pointer;">
                        </div>
                        <div>
                            <small class="text-muted text-xxs d-block"><i class="fa-solid fa-keyboard"></i> Space / Shift+Space to cycle targets</small>
                            <small class="text-muted text-xxs d-block">Escape / 5 to stop autowalk</small>
                        </div>
                    </div>

                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <label class="label-retro mb-0" for="speedSlider">Play speed</label>
                        <span class="badge-retro" id="speedVal">1.00</span>
                    </div>
                    <input type="range" class="form-range mb-2" id="speedSlider" min="0.25" max="20" step="0.25" value="1">

                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <label class="label-retro mb-0 text-info" for="playbackSlider">Scrubber</label>
                        <span class="badge-retro" id="playbackFrameVal">0 / 0</span>
                    </div>
                    <input type="range" class="form-range mb-3" id="playbackSlider" min="0" max="0" value="0" disabled title="Seek to logic tick from seed (reseed)">

                    <div class="d-flex gap-2 flex-wrap">
                        <button type="button" class="btn btn-retro btn-primary flex-grow-1" id="playBtn">
                            <i class="fa-solid fa-play"></i> Play
                        </button>
                        <button type="button" class="btn btn-retro btn-secondary flex-grow-1" id="pauseBtn" disabled>
                            <i class="fa-solid fa-pause"></i> Pause
                        </button>
                        <button type="button" class="btn btn-retro btn-secondary flex-grow-1" id="stopBtn">
                            <i class="fa-solid fa-stop"></i> Stop
                        </button>
                    </div>
                </div>

                <div class="am-sidebar-section">
                    <div class="d-flex justify-content-between align-items-center mb-1">
                        <h2 class="am-sidebar-title mb-0">Party members</h2>
                        <button type="button" class="btn btn-retro btn-retro-cyan btn-sm" id="resetPartyBtn" title="Reload members from selected party preset">
                            Reset
                        </button>
                    </div>
                    <p class="text-muted text-xxs mb-1">Enable/disable slots, pick a leader, and Set Active for the camera view (defaults to leader). Loadout comes from the party’s base profiles.</p>
                    <div id="partySlots" class="party-slots"></div>
                </div>

                <div class="am-sidebar-section">
                    <h2 class="am-sidebar-title">Runtime</h2>
                    <div class="game-stats">
                        <div><span class="label-retro">FPS</span> <span id="statFps" class="game-stat-value">—</span></div>
                        <div><span class="label-retro">UPS</span> <span id="statUps" class="game-stat-value">—</span></div>
                        <div><span class="label-retro">Speed</span> <span id="statSpeed" class="game-stat-value">1</span></div>
                        <div><span class="label-retro">Time</span> <span id="statTime" class="game-stat-value">00:00:00</span></div>
                    </div>
                </div>
            </div>
            <div class="game-sidebar-footer">
                <button type="button" class="btn btn-retro btn-retro-cyan w-100 mb-1" id="openEngineTweakingsBtn" title="Open Engine Tweakings in a popup window">
                    <i class="fa-solid fa-wrench"></i> Engine Tweakings
                </button>
                <button type="button" class="btn btn-retro btn-retro-purple w-100 mb-1" id="openActionBarConfigBtn" title="Open Hotkeys Setup in a popup window">
                    <i class="fa-solid fa-gamepad"></i> Hotkeys Setup
                </button>
                <button type="button" class="btn btn-retro btn-secondary w-100 mb-1" id="openSimBatchBtn" title="Open Hunt Sim Batch Builder in a popup window">
                    <i class="fa-solid fa-layer-group"></i> Sim Batch
                </button>
                <span class="d-block text-muted game-popup-hint" id="engineTweakingsPopupHint" hidden></span>
                <span class="d-block text-muted game-popup-hint" id="actionBarConfigPopupHint" hidden></span>
                <span class="d-block text-muted game-popup-hint" id="simBatchPopupHint" hidden></span>
                <span class="d-block text-muted game-popup-hint">Popups — allow if blocked</span>
            </div>
        </aside>

        <main class="game-main">
            <div class="game-canvas-wrap canvas-container action-bars-layout" id="gameCanvasContainer">
                <div id="actionBarDockTop" class="action-bar-dock action-bar-dock--horizontal action-bar-dock--top"></div>
                <div class="canvas-middle-row">
                    <div id="actionBarDockLeft" class="action-bar-dock action-bar-dock--vertical action-bar-dock--left"></div>
                    <div class="canvas-center-wrapper" id="canvasCenterWrapper">
                        <button id="fullscreenToggleBtn" class="fullscreen-btn" title="Full Screen" type="button" aria-label="Full Screen">
                            <svg viewBox="0 0 24 24" id="enterFullscreenIcon" aria-hidden="true">
                                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                            </svg>
                            <svg viewBox="0 0 24 24" id="exitFullscreenIcon" style="display: none;" aria-hidden="true">
                                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
                            </svg>
                        </button>
                        <canvas id="gameCanvas" width="720" height="480" aria-label="Hunt view"></canvas>
                    </div>
                    <div id="actionBarDockRight" class="action-bar-dock action-bar-dock--vertical action-bar-dock--right"></div>
                </div>
                <div id="actionBarDockBottom" class="action-bar-dock action-bar-dock--horizontal action-bar-dock--bottom"></div>
            </div>
            <div class="game-below-canvas">
                <section class="game-live-section" aria-label="Live hunt telemetry">
                    <div class="am-sidebar-title-row">
                        <h2 class="am-sidebar-title mb-0">Live hunt</h2>
                        <button type="button" class="btn btn-sm btn-outline-secondary party-details-btn" id="bugReportBtn" title="Save a bug report with seed, party, and gear for reproduction">
                            Report Bug
                        </button>
                    </div>
                    <div class="game-live-tiles">
                        <div class="game-live-tile game-live-tile--stats">
                            <div class="game-stats game-stats--live">
                                <div class="live-stat-row"><span class="label-retro">Tick</span> <span id="liveTick" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Floors</span> <span id="liveFloors" class="game-stat-value">—</span></div>
                                <div class="live-stat-row"><span class="label-retro">Kills</span> <span id="liveKills" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Deaths</span> <span id="liveDeaths" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Exp</span> <span id="liveExp" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Exp/h</span> <span id="liveExpPerHour" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Dmg out</span> <span id="liveDmgOut" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Dmg in</span> <span id="liveDmgIn" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Dmg/h</span> <span id="liveDmgOutPh" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Hit %</span> <span id="liveHitRate" class="game-stat-value">—</span></div>
                                <div class="live-stat-row"><span class="label-retro">Mana</span> <span id="liveMana" class="game-stat-value">0</span></div>
                                <div class="live-stat-row"><span class="label-retro">Mobs</span> <span id="liveCreatures" class="game-stat-value">0</span></div>
                                <div class="live-stat-row" id="liveWaveRow" hidden><span class="label-retro">Wave</span> <span id="liveWave" class="game-stat-value">—</span></div>
                            </div>
                        </div>
                        <div class="game-live-tile game-live-tile--meta">
                            <div class="game-live-meta-block">
                                <p class="label-retro mb-1">Floor hops</p>
                                <pre id="liveHopLog" class="live-hop-log text-muted small mb-0" title="Tick-accurate party stair hops">—</pre>
                            </div>
                            <div class="game-live-meta-block" id="liveParitySection" hidden>
                                <p class="label-retro mb-1">Parity (post-hop Scout/RNG)</p>
                                <pre id="liveParityLog" class="live-hop-log live-parity-log text-muted small mb-0" title="Opt-in parityTrace: Scout/RNG after first hop">—</pre>
                            </div>
                            <div class="game-live-meta-block">
                                <p class="label-retro mb-1">Damage by element</p>
                                <p id="liveElementBreakdown" class="live-element-line text-muted small mb-0">—</p>
                            </div>
                            <div class="game-live-meta-block game-live-party">
                                <div class="am-sidebar-title-row">
                                    <h3 class="am-sidebar-title mb-0">Party damage</h3>
                                    <button type="button" class="btn btn-sm btn-outline-secondary party-details-btn" id="partyDetailsBtn" title="Per-member combat and spell cast breakdown">
                                        Details
                                    </button>
                                </div>
                                <div id="liveMemberList" class="live-member-list">
                                    <p class="text-muted small mb-0">No party</p>
                                </div>
                            </div>
                        </div>
                    </div>
                    <p class="text-muted small mb-0 game-live-hint">
                        Build a party, pick a hunt, watch combat on the path map.
                        Scrubber reseeds from the session seed to any played tick.
                        Headless batch stays independent (<code>npm run sim:hunt</code>).
                    </p>
                </section>
            </div>
        </main>

        <aside class="game-inventory-panel" aria-label="Equipment and backpack">
            <div class="am-sidebar-body">
                <section class="game-equipment-panel" aria-label="Active player equipment">
                    <div class="am-sidebar-title-row">
                        <h2 class="am-sidebar-title mb-0">Equipment</h2>
                        <button type="button" class="btn btn-sm btn-outline-secondary party-details-btn" id="equipmentDetailsBtn" title="Open full character preview for the active player">
                            Details
                        </button>
                    </div>
                    <div class="equipment-card-container">
                        <div class="equipment-card" id="activeEquipmentCard">
                            <div class="slot-item amulet" style="left:1px;top:19px;" data-slot="amulet" title="Amulet">
                                <span class="slot-placeholder"><i class="fa-solid fa-gem"></i></span>
                            </div>
                            <div class="slot-item helmet" style="left:37px;top:1px;" data-slot="head" title="Helmet / Head">
                                <span class="slot-placeholder"><i class="fa-solid fa-helmet-safety"></i></span>
                            </div>
                            <div class="slot-item bag" style="left:73px;top:19px;" data-slot="backpack" title="Backpack">
                                <span class="slot-placeholder"><i class="fa-solid fa-bag-shopping"></i></span>
                            </div>
                            <div class="slot-item rightHand" style="left:1px;top:55px;" data-slot="weapon" title="Weapon / Right Hand">
                                <span class="slot-placeholder"><i class="fa-solid fa-hand-fist"></i></span>
                            </div>
                            <div class="slot-item armor" style="left:37px;top:37px;" data-slot="chest" title="Armor / Chest">
                                <span class="slot-placeholder"><i class="fa-solid fa-vest"></i></span>
                            </div>
                            <div class="slot-item leftHand" style="left:73px;top:55px;" data-slot="shield" title="Shield / Left Hand">
                                <span class="slot-placeholder"><i class="fa-solid fa-shield"></i></span>
                            </div>
                            <div class="slot-item ring" style="left:1px;top:91px;" data-slot="ring" title="Ring">
                                <span class="slot-placeholder"><i class="fa-solid fa-ring"></i></span>
                            </div>
                            <div class="slot-item legs" style="left:37px;top:73px;" data-slot="legs" title="Legs">
                                <span class="slot-placeholder"><i class="fa-solid fa-socks"></i></span>
                            </div>
                            <div class="slot-item light" style="left:73px;top:91px;" data-slot="light" title="Utility / Light">
                                <span class="slot-placeholder"><i class="fa-solid fa-lightbulb"></i></span>
                            </div>
                            <div class="slot-item boots" style="left:37px;top:109px;" data-slot="boots" title="Boots">
                                <span class="slot-placeholder"><i class="fa-solid fa-shoe-prints"></i></span>
                            </div>
                            <div style="left:1px;top:127px;" class="soul">
                                <p>Soul:</p>
                                <p class="total" id="activeEqSoul">—</p>
                            </div>
                            <div style="left:73px;top:127px;" class="capacity">
                                <p>Cap:</p>
                                <p class="total" id="activeEqCap">—</p>
                            </div>
                            <div class="eq-status-bar" id="activeEqStatusBar" role="status" aria-label="Active conditions" hidden></div>
                        </div>
                    </div>
                </section>
                <div id="sidebarPanelToggles" class="sidebar-panel-toggles" role="toolbar" aria-label="Open or close sidebar panels"></div>
                <section class="game-backpack-panel panel-collapsible-section" data-panel-id="backpack" aria-label="Backpack inventory">
                    <div class="am-sidebar-title-row panel-title-bar">
                        <div class="panel-toggle-header d-flex align-items-center flex-grow-1" role="button" tabindex="0" title="Drag to reorder · click to collapse">
                            <div class="d-flex align-items-center gap-1">
                                <i class="fa-solid fa-chevron-down panel-toggle-icon"></i>
                                <h2 class="am-sidebar-title mb-0">Backpack</h2>
                            </div>
                        </div>
                        <div class="panel-title-actions">
                            <button type="button" class="panel-close-btn" aria-label="Close backpack" title="Close Backpack">
                                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    <div class="panel-collapsible-content">
                        <div class="backpack-grid-scroll panel-body-scroll" id="backpackScroll">
                            <div class="backpack-grid" id="backpackGrid" title="Character backpack (20 slots; nested bags open in panels)">
                                <?php for ($i = 0; $i < 20; $i++) : ?>
                                <div class="backpack-slot inv-slot" data-slot-index="<?= $i ?>" data-container-uid="root"></div>
                                <?php endfor; ?>
                            </div>
                        </div>
                        <p class="text-muted small mb-0 inv-hint">LMB select · drag to move · RMB menu · dbl-click open/equip</p>
                    </div>
                    <div class="panel-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Resize panel height" title="Drag to resize height"></div>
                </section>
                <section class="game-combat-panel panel-collapsible-section" data-panel-id="combat" aria-label="Combat enemies list">
                    <div class="am-sidebar-title-row panel-title-bar">
                        <div class="panel-toggle-header d-flex align-items-center flex-grow-1" role="button" tabindex="0" title="Drag to reorder · click to collapse">
                            <div class="d-flex align-items-center gap-1">
                                <i class="fa-solid fa-chevron-down panel-toggle-icon"></i>
                                <h2 class="am-sidebar-title mb-0">Combat</h2>
                            </div>
                        </div>
                        <div class="panel-title-actions">
                            <div class="combat-sort-container">
                                <button type="button" class="btn btn-xs btn-outline-secondary party-details-btn combat-sort-btn" id="combatSortBtn" title="Sort by: Display Time - ASC (Default)" aria-label="Sort options">
                                    <i class="fa-solid fa-arrow-down-short-wide"></i>
                                </button>
                                <div id="combatSortDropdown" class="combat-sort-dropdown-menu" hidden>
                                    <div class="combat-sort-item active" data-sort="display_time_asc">Display Time - ASC</div>
                                    <div class="combat-sort-item" data-sort="display_time_desc">Display Time - DESC</div>
                                    <div class="combat-sort-item" data-sort="distance_asc">Distance - ASC</div>
                                    <div class="combat-sort-item" data-sort="distance_desc">Distance - DESC</div>
                                    <div class="combat-sort-item" data-sort="hp_percent_asc">% HP - ASC</div>
                                    <div class="combat-sort-item" data-sort="hp_percent_desc">% HP - DESC</div>
                                    <div class="combat-sort-item" data-sort="name_asc">Name - ASC</div>
                                    <div class="combat-sort-item" data-sort="name_desc">Name - DESC</div>
                                </div>
                            </div>
                            <button type="button" class="panel-close-btn" aria-label="Close combat" title="Close Combat">
                                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    <div class="panel-collapsible-content">
                        <div class="entity-panel-list-scroll panel-body-scroll">
                            <div id="combatCreaturesList" class="entity-panel-list" role="list">
                                <p class="text-muted small mb-0 p-1">No creatures in combat</p>
                            </div>
                        </div>
                    </div>
                    <div class="panel-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Resize panel height" title="Drag to resize height"></div>
                </section>
                <section class="game-skills-panel panel-collapsible-section" data-panel-id="skills" aria-label="Character skills">
                    <div class="am-sidebar-title-row panel-title-bar">
                        <div class="panel-toggle-header d-flex align-items-center flex-grow-1" role="button" tabindex="0" title="Drag to reorder · click to collapse">
                            <div class="d-flex align-items-center gap-1">
                                <i class="fa-solid fa-chevron-down panel-toggle-icon"></i>
                                <h2 class="am-sidebar-title mb-0">Skills</h2>
                            </div>
                        </div>
                        <div class="panel-title-actions">
                            <button type="button" class="panel-close-btn" aria-label="Close skills" title="Close Skills">
                                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    <div class="panel-collapsible-content">
                        <div class="skills-panel-scroll panel-body-scroll" id="skillsPanelScroll">
                            <div id="skillsPanelList" class="skills-panel-list">
                                <p class="text-muted small mb-0 p-1">No character</p>
                            </div>
                        </div>
                    </div>
                    <div class="panel-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Resize panel height" title="Drag to resize height"></div>
                </section>
                <section class="game-party-panel panel-collapsible-section" data-panel-id="party" aria-label="Party members list">
                    <div class="am-sidebar-title-row panel-title-bar">
                        <div class="panel-toggle-header d-flex align-items-center flex-grow-1" role="button" tabindex="0" title="Drag to reorder · click to collapse">
                            <div class="d-flex align-items-center gap-1">
                                <i class="fa-solid fa-chevron-down panel-toggle-icon"></i>
                                <h2 class="am-sidebar-title mb-0">Party</h2>
                            </div>
                        </div>
                        <div class="panel-title-actions">
                            <button type="button" class="panel-close-btn" aria-label="Close party" title="Close Party">
                                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                            </button>
                        </div>
                    </div>
                    <div class="panel-collapsible-content">
                        <div class="entity-panel-list-scroll panel-body-scroll">
                            <div id="partyMembersList" class="entity-panel-list" role="list">
                                <p class="text-muted small mb-0 p-1">No party members</p>
                            </div>
                        </div>
                    </div>
                    <div class="panel-resize-handle" role="separator" aria-orientation="horizontal" aria-label="Resize panel height" title="Drag to resize height"></div>
                </section>
            </div>
        </aside>
    </div>
</div>

<div id="partyDetailsModal" class="party-details-modal" hidden aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="partyDetailsTitle">
    <div class="party-details-dialog">
        <div class="party-details-header">
            <h2 id="partyDetailsTitle" class="party-details-title">Party details</h2>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="partyDetailsClose" data-party-details-close aria-label="Close">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
        </div>
        <div id="partyDetailsBody" class="party-details-body">
            <p class="text-muted small mb-0">No session</p>
        </div>
    </div>
</div>

<div id="bugReportModal" class="party-details-modal" hidden aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="bugReportTitle">
    <div class="party-details-dialog bug-report-dialog">
        <div class="party-details-header">
            <h2 id="bugReportTitle" class="party-details-title">Report Bug</h2>
            <button type="button" class="btn btn-sm btn-outline-secondary" id="bugReportClose" data-bug-report-close aria-label="Close">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
            </button>
        </div>
        <div class="party-details-body bug-report-body">
            <label class="label-retro" for="bugReportDescription">What went wrong?</label>
            <textarea
                id="bugReportDescription"
                class="form-control form-control-retro bug-report-textarea"
                rows="6"
                style="min-height: 150px;"
                maxlength="8000"
                placeholder="Describe the bug (steps, expected vs actual)…"
            ></textarea>
            <p class="text-muted small mt-2 mb-0">
                Save writes a JSON under <code>bugs/</code> with seed, party, gear, and session
                context for headless reproduction (<code>npm run bug:repro -- bugs/…</code>).
            </p>
            <p id="bugReportStatus" class="bug-report-status small mt-2 mb-0" hidden></p>
            <div class="bug-report-actions">
                <button type="button" class="btn btn-sm btn-outline-secondary" id="bugReportCancel" data-bug-report-close>
                    Cancel
                </button>
                <button type="button" class="btn btn-sm btn-primary" id="bugReportSave">
                    Save
                </button>
            </div>
        </div>
    </div>
</div>

<script src="<?= htmlspecialchars($bundleUrl, ENT_QUOTES, 'UTF-8') ?>?v=1.5.0"></script>
</body>
</html>
