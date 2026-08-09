<?php
/**
 * Shared top nav for editor shells.
 *
 * Expects:
 *   $asset (callable) — path → web URL
 *   $activeNav (string|null) — sprites|hunt|hunt-editor|designer-ui|scenario-lab|sim-batch|analysis|wiki-creatures|wiki-equipment
 * Optional:
 *   $navExtraClass (string) — extra classes on <nav> (e.g. sim-batch-nav)
 */

declare(strict_types=1);

$activeNav = $activeNav ?? null;
$navExtraClass = isset($navExtraClass) ? trim((string) $navExtraClass) : '';
$navClass = 'menu-items d-none d-sm-flex' . ($navExtraClass !== '' ? ' ' . $navExtraClass : '');
/** @return string ' active' when $activeNav matches any key */
$is = static function (string ...$keys) use ($activeNav): string {
    foreach ($keys as $key) {
        if ($activeNav === $key) {
            return ' active';
        }
    }
    return '';
};
?>
        <nav class="<?= htmlspecialchars($navClass, ENT_QUOTES, 'UTF-8') ?>">
            <div class="menu-dropdown<?= $is('hunt', 'scenario-lab') ?>">
                <span class="menu-item menu-dropdown-trigger<?= $is('analysis', 'sim-batch') ?>" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
                    Simulator <i class="fa-solid fa-caret-down menu-dropdown-caret" aria-hidden="true"></i>
                </span>
                <div class="menu-dropdown-panel" role="menu">
                    <a class="menu-dropdown-item<?= $is('hunt') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('index.php'), ENT_QUOTES, 'UTF-8') ?>">Hunt</a>
                    <a class="menu-dropdown-item<?= $is('scenario-lab') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('scenario-lab.php'), ENT_QUOTES, 'UTF-8') ?>">Scenario Lab</a>
                </div>
            </div>
            <div class="menu-dropdown<?= $is('sprites', 'hunt-editor') ?>">
                <span class="menu-item menu-dropdown-trigger<?= $is('sprites') ?>" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
                    Asset Manager <i class="fa-solid fa-caret-down menu-dropdown-caret" aria-hidden="true"></i>
                </span>
                <div class="menu-dropdown-panel" role="menu">
                    <a class="menu-dropdown-item<?= $is('sprites') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('sprite-manager.php'), ENT_QUOTES, 'UTF-8') ?>">Sprites</a>
                    <a class="menu-dropdown-item<?= $is('hunt-editor') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('hunt-editor.php'), ENT_QUOTES, 'UTF-8') ?>">Hunts</a>
                </div>
            </div>
            <div class="menu-dropdown<?= $is('analysis', 'sim-batch', 'designer-ui') ?>">
                <span class="menu-item menu-dropdown-trigger<?= $is('analysis', 'sim-batch', 'designer-ui') ?>" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
                    Tools <i class="fa-solid fa-caret-down menu-dropdown-caret" aria-hidden="true"></i>
                </span>
                <div class="menu-dropdown-panel" role="menu">
                    <a class="menu-dropdown-item<?= $is('designer-ui') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('designer-ui.php'), ENT_QUOTES, 'UTF-8') ?>">Designer</a>
                    <a class="menu-dropdown-item<?= $is('analysis') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('simulation-analysis.php'), ENT_QUOTES, 'UTF-8') ?>">Analysis</a>
                    <a class="menu-dropdown-item<?= $is('sim-batch') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('sim-batch-builder.php'), ENT_QUOTES, 'UTF-8') ?>">Sim Batch</a>
                </div>
            </div>
            <div class="menu-dropdown<?= $is('wiki-creatures', 'wiki-equipment', 'wiki-legacy-map') ?>">
                <span class="menu-item menu-dropdown-trigger<?= $is('wiki-creatures', 'wiki-equipment', 'wiki-legacy-map') ?>" role="button" tabindex="0" aria-haspopup="true" aria-expanded="false">
                    Wiki <i class="fa-solid fa-caret-down menu-dropdown-caret" aria-hidden="true"></i>
                </span>
                <div class="menu-dropdown-panel" role="menu">
                    <a class="menu-dropdown-item<?= $is('wiki-creatures') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('wiki-creatures.php'), ENT_QUOTES, 'UTF-8') ?>">Creatures</a>
                    <a class="menu-dropdown-item<?= $is('wiki-equipment') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('wiki-equipment.php'), ENT_QUOTES, 'UTF-8') ?>">Equipments</a>
                    <a class="menu-dropdown-item<?= $is('wiki-legacy-map') ?>" role="menuitem"
                       href="<?= htmlspecialchars($asset('wiki-legacy-map.php'), ENT_QUOTES, 'UTF-8') ?>">Legacy Map</a>
                </div>
            </div>
        </nav>
