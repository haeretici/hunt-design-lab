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
        #selectedImage {
            transform-origin: 0 0;
            image-rendering: pixelated;
            user-select: none;
            -webkit-user-drag: none;
        }
        .spawn {
            position: absolute;
            pointer-events: none;
            z-index: 2;
        }
        .legacy-map-sidebar {
            width: 300px;
            min-width: 300px;
            border-right: 1px solid var(--bs-border-color);
            background: var(--bs-gray-900);
            display: flex;
            flex-direction: column;
            overflow-y: auto;
            padding: 1rem;
        }
        .map-layout {
            display: flex;
            flex: 1;
            overflow: hidden;
            height: calc(100vh - 48px); /* minus header */
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
            <span class="badge-retro"><i class="fa-solid fa-map"></i> Wiki · Legacy Map</span>
        </div>
    </header>

    <div class="map-layout">
        <div class="legacy-map-sidebar">
            <h5 class="mb-3">Controls</h5>
            
            <div class="mb-3">
                <label class="form-label">Zoom</label>
                <div class="d-flex flex-wrap gap-1">
                    <button class="btn btn-outline-primary btn-sm image-zoom active" data-zoom="1">100%</button>
                    <button class="btn btn-outline-secondary btn-sm image-zoom" data-zoom="2">200%</button>
                    <button class="btn btn-outline-secondary btn-sm image-zoom" data-zoom="4">400%</button>
                    <button class="btn btn-outline-secondary btn-sm image-zoom" data-zoom="8">800%</button>
                    <button class="btn btn-outline-secondary btn-sm image-zoom" data-zoom="16">1600%</button>
                    <button class="btn btn-outline-secondary btn-sm image-zoom" data-zoom="32">3200%</button>
                </div>
                <div class="form-check mt-2">
                    <input class="form-check-input" type="checkbox" id="mouseZoom" checked>
                    <label class="form-check-label" for="mouseZoom">Mouse Wheel Zoom</label>
                </div>
            </div>

            <div class="mb-3">
                <label class="form-label">Filter</label>
                <input type="text" class="form-control form-control-sm" placeholder="Monster name..." id="monster-name">
                <div id="monster-results" class="mt-2 small text-muted"></div>
            </div>

            <div class="mb-3">
                <label class="form-label">Floor (Path)</label>
                <div class="d-flex flex-column gap-1">
                    <?php for ($i = 0; $i <= 15; $i++): $floor = str_pad((string)$i, 2, '0', STR_PAD_LEFT); ?>
                    <div class="form-check">
                        <input class="form-check-input floor-radio" type="radio" name="map" id="floor-<?= $floor ?>-path" value="<?= $floor ?>" <?= $i === 7 ? 'checked' : '' ?>>
                        <label class="form-check-label" for="floor-<?= $floor ?>-path"><?= $floor ?> <span id="floor-count-<?= $floor ?>" class="text-info fw-bold small ms-1"></span></label>
                    </div>
                    <?php endfor; ?>
                </div>
            </div>
        </div>

        <div class="map-viewer-container">
            <div id="imageContainer" data-floor="07">
                <div id="spawns-layer" style="position: absolute; top: 0; left: 0; transform-origin: 0 0;"></div>
                <img id="selectedImage" draggable="false" src="<?= htmlspecialchars($asset('assets/legacy/map/floor-07-path.png'), ENT_QUOTES, 'UTF-8') ?>" alt="Selected Map">
            </div>
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

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
/**
 * Legacy Map wiki viewer.
 *
 * Coordinate contract (must match engine + assets/legacy/spawns/by_floor):
 *   - by_floor rows store MAP-LOCAL tile coords (pixel = tile on floor-*-path.png).
 *   - Same conversion as assets/legacy/monsters/js/map-spawn.js:
 *       localX = worldX - bounds.xMin, localY = worldY - bounds.yMin
 *   - Engine spawnSource.legacy_floor filters those local x/y directly — do NOT
 *     re-subtract bounds here or rewrite by_floor files.
 *   - ?point=x,y,z,zoomPct uses LOCAL coords (same as map-spawn.js deep-links).
 */
document.addEventListener("DOMContentLoaded", () => {
    const ASSET_ROOT = window.__APP_ROOT__ || '/';

    const imageContainer = document.getElementById('imageContainer');
    const selectedImage = document.getElementById('selectedImage');
    const spawnsLayer = document.getElementById('spawns-layer');
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
    let zoomValue = 1;
    let mapSpawnsCache = {};
    let currentMapSpawns = [];
    let monstersData = {};
    /** Art lookup: creatureId → { customSprite, customSpriteGenre, … } */
    let standardPresets = {};

    // bounds.json is only for world↔local when needed (URL world-coords heuristic).
    // Path PNG / by_floor / engine all use map-local tiles.
    let bounds = { xMin: 31744, yMin: 30976, width: 2560, height: 2048 };

    let viewPortX = 0;
    let viewPortY = 0;
    let viewPortWidth = 0;
    let viewPortHeight = 0;

    const RED_DOT =
        'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><circle cx="4" cy="4" r="3" fill="red" stroke="white" stroke-width="1"/></svg>';

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
     * by_floor rows are ALWAYS local (engine contract) — never run this on them.
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

    function spawnDisplayName(spawn) {
        return String(spawn.legacyName || spawn.creatureId || '').toLowerCase();
    }

    function matchesFilter(spawn, filterText) {
        if (!filterText) return true;
        return spawnDisplayName(spawn).indexOf(filterText) !== -1;
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

    fetch(ASSET_ROOT + 'assets/legacy/monsters/data/monsters.json')
        .then((res) => res.json())
        .then((data) => {
            for (const i in data) {
                if (data[i] && data[i].name) {
                    monstersData[String(data[i].name).toLowerCase()] = data[i];
                }
            }
        })
        .catch((err) => console.error('Error loading monsters.json', err));

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
            if (currentMapSpawns.length > 0) {
                renderSpawns();
            }
        })
        .catch((err) => console.error('Error loading standard presets', err));

    function prefetchAllFloors() {
        const promises = [];
        for (let i = 0; i <= 15; i++) {
            const floor = padFloor(i);
            if (mapSpawnsCache[floor]) continue;
            promises.push(
                fetch(ASSET_ROOT + 'assets/legacy/spawns/by_floor/' + floor + '.json')
                    .then((res) => res.json())
                    .then((data) => {
                        mapSpawnsCache[floor] = Array.isArray(data.spawns)
                            ? data.spawns
                            : [];
                    })
                    .catch((e) => {
                        console.error(e);
                        mapSpawnsCache[floor] = [];
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

    let startX, startY, startScrollLeft, startScrollTop;
    function onMouseMove(event) {
        imageContainer.scrollLeft = startScrollLeft - (event.clientX - startX);
        imageContainer.scrollTop = startScrollTop - (event.clientY - startY);
    }
    function onMouseUp() {
        imageContainer.classList.remove('panning');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        renderSpawns();
    }
    imageContainer.addEventListener('mousedown', (e) => {
        if (e.target.closest('.spawn')) return;
        e.preventDefault();
        startX = e.clientX;
        startY = e.clientY;
        startScrollLeft = imageContainer.scrollLeft;
        startScrollTop = imageContainer.scrollTop;
        imageContainer.classList.add('panning');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    const zoomButtons = document.querySelectorAll('.image-zoom');
    zoomButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            zoomButtons.forEach((b) => {
                b.classList.remove('btn-primary', 'active');
                b.classList.add('btn-outline-secondary');
            });
            btn.classList.add('btn-primary', 'active');
            btn.classList.remove('btn-outline-secondary');
            setZoom(parseFloat(btn.dataset.zoom));
        });
    });

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

        const scaledWidth = (selectedImage.naturalWidth || bounds.width || 2560) * zoomValue;
        selectedImage.style.width = scaledWidth + 'px';
        // Layer is in map-local pixels; scale position of markers instead of visual size
        spawnsLayer.style.transform = 'none';

        scrollContainer.scrollLeft = centerX * scalingFactor - clientWidth / 2;
        scrollContainer.scrollTop = centerY * scalingFactor - clientHeight / 2;

        renderSpawns();
    }

    document.querySelectorAll('.floor-radio').forEach((radio) => {
        radio.addEventListener('change', (e) => {
            if (!e.target.checked) return;
            currentFloor = e.target.value;
            selectedImage.src =
                ASSET_ROOT + 'assets/legacy/map/floor-' + currentFloor + '-path.png';
            imageContainer.dataset.floor = currentFloor;
            loadFloorSpawns(currentFloor);
        });
    });

    monsterNameInput.addEventListener('input', () => {
        renderSpawns();
        updateFloorCounts();
    });

    function updateFloorCounts() {
        const filterText = monsterNameInput.value.toLowerCase().trim();
        let totalAll = 0;

        for (let i = 0; i <= 15; i++) {
            const floor = padFloor(i);
            const countSpan = document.getElementById('floor-count-' + floor);
            let count = 0;

            if (filterText && mapSpawnsCache[floor]) {
                for (const spawn of mapSpawnsCache[floor]) {
                    if (matchesFilter(spawn, filterText)) count++;
                }
            }

            if (countSpan) {
                countSpan.textContent =
                    filterText && count > 0 ? '(' + count + ')' : '';
            }
            totalAll += count;
        }

        monsterResults.innerHTML = filterText
            ? 'Found ' + totalAll + ' total matches.'
            : '';
    }

    async function loadFloorSpawns(floor) {
        if (mapSpawnsCache[floor]) {
            currentMapSpawns = mapSpawnsCache[floor];
            renderSpawns();
            return;
        }

        try {
            const res = await fetch(
                ASSET_ROOT + 'assets/legacy/spawns/by_floor/' + floor + '.json'
            );
            if (res.ok) {
                const data = await res.json();
                mapSpawnsCache[floor] = Array.isArray(data.spawns) ? data.spawns : [];
                currentMapSpawns = mapSpawnsCache[floor];
            } else {
                currentMapSpawns = [];
            }
        } catch (e) {
            console.error(e);
            currentMapSpawns = [];
        }
        renderSpawns();
    }

    function updateViewPort() {
        if (!selectedImage.naturalWidth) return;
        const rect = selectedImage.getBoundingClientRect();
        const scaleDisplayed = rect.width / selectedImage.naturalWidth;
        // Same as map-spawn.js: natural size / zoom = visible tile span
        viewPortWidth = selectedImage.naturalWidth / zoomValue;
        viewPortHeight = selectedImage.naturalHeight / zoomValue;
        viewPortX = imageContainer.scrollLeft / scaleDisplayed;
        viewPortY = imageContainer.scrollTop / scaleDisplayed;
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
        // Secondary fallback: reference GIFs (map-spawn.js style)
        const gifName = String(rawName || artId)
            .trim()
            .toLowerCase()
            .replace(/\.gif$/i, '');
        const legacyGifUrl =
            ASSET_ROOT + 'assets/legacy/monsters/images/' + gifName + '.gif';
        return { standardUrl, legacyGifUrl };
    }

    function renderSpawns() {
        updateViewPort();
        spawnsLayer.innerHTML = '';

        const filterText = monsterNameInput.value.toLowerCase().trim();

        // Monsters appear at ≥400% zoom, or anytime a name filter is set
        // (same rule as assets/legacy/monsters/js/map-spawn.js).
        if (zoomValue < 4 && !filterText) {
            return;
        }

        const fragment = document.createDocumentFragment();

        currentMapSpawns.forEach((spawn) => {
            if (!matchesFilter(spawn, filterText)) return;

            // by_floor is already map-local (engine + map-spawn after convert).
            const x = Number(spawn.x);
            const y = Number(spawn.y);

            // Viewport culling when not filtering (map-spawn canDrawPoint)
            if (!filterText) {
                if (
                    x < viewPortX ||
                    x > viewPortX + viewPortWidth ||
                    y < viewPortY ||
                    y > viewPortY + viewPortHeight
                ) {
                    return;
                }
            }

            const art = resolveSpawnArt(spawn);
            const img = document.createElement('img');
            img.src = art.standardUrl;
            img.onerror = function () {
                // Try reference GIF once, then red dot
                if (this.dataset.fallback !== '1') {
                    this.dataset.fallback = '1';
                    this.src = art.legacyGifUrl;
                    return;
                }
                this.onerror = null;
                this.src = RED_DOT;
            };
            img.className = 'spawn';
            img.alt = spawnDisplayName(spawn);
            img.style.left = (x * zoomValue) + 'px';
            img.style.top = (y * zoomValue) + 'px';
            img.style.transform = 'translate(-50%, -50%)';

            fragment.appendChild(img);
        });

        spawnsLayer.appendChild(fragment);
    }

    // Click: pick nearest spawn in map-local space (map-spawn.js findSpawnAt)
    selectedImage.addEventListener('click', function (e) {
        if (
            !selectedImage.src ||
            (zoomValue < 4 && !monsterNameInput.value.trim())
        ) {
            return;
        }

        const rect = selectedImage.getBoundingClientRect();
        const scaleX = selectedImage.naturalWidth / rect.width;
        const scaleY = selectedImage.naturalHeight / rect.height;
        const clickX = (e.clientX - rect.left) * scaleX;
        const clickY = (e.clientY - rect.top) * scaleY;

        let nearestSpawn = null;
        let minDistance = 10; // natural-image pixels
        const filterText = monsterNameInput.value.toLowerCase().trim();

        for (const spawn of currentMapSpawns) {
            if (!matchesFilter(spawn, filterText)) continue;
            const sx = Number(spawn.x);
            const sy = Number(spawn.y);
            const dx = sx - clickX;
            const dy = sy - clickY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < minDistance) {
                minDistance = dist;
                nearestSpawn = spawn;
            }
        }

        if (nearestSpawn) {
            const activeBtn = document.querySelector('.image-zoom.active');
            const currentZoomPct = activeBtn
                ? activeBtn.textContent.replace('%', '').trim()
                : String(zoomValue * 100);
            // Deep-link uses LOCAL coords (map-spawn.js parity; engine tile space)
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
        }
    });

    function showMonsterData(spawn) {
        const monsterName = spawnDisplayName(spawn);
        const mData = monstersData[monsterName];
        if (mData) {
            monsterModalTitle.textContent =
                mData.name.charAt(0).toUpperCase() + mData.name.slice(1);
            monsterModalBody.innerHTML =
                '<div class="row">' +
                '<div class="col-md-6">' +
                '<p><strong>HP:</strong> ' +
                mData.health +
                '</p>' +
                '<p><strong>Experience:</strong> ' +
                mData.experience +
                '</p>' +
                '<p><strong>Mitigation:</strong> ' +
                (mData.defenses && mData.defenses.mitigation != null
                    ? mData.defenses.mitigation
                    : 0) +
                '%</p>' +
                '<p><strong>Bestiary Class:</strong> ' +
                (mData.Bestiary && mData.Bestiary.class
                    ? mData.Bestiary.class
                    : '-') +
                '</p>' +
                '<p><strong>Speed:</strong> ' +
                mData.speed +
                '</p>' +
                '<p><strong>Armor:</strong> ' +
                (mData.defenses && mData.defenses.armor != null
                    ? mData.defenses.armor
                    : 0) +
                '</p>' +
                '</div>' +
                '<div class="col-md-6">' +
                '<p><strong>Resistances:</strong></p>' +
                '<ul class="mb-2">' +
                '<li>Death: ' +
                ((mData.elements && mData.elements.death) || 0) +
                '%</li>' +
                '<li>Earth: ' +
                ((mData.elements && mData.elements.earth) || 0) +
                '%</li>' +
                '<li>Energy: ' +
                ((mData.elements && mData.elements.energy) || 0) +
                '%</li>' +
                '<li>Ice: ' +
                ((mData.elements && mData.elements.ice) || 0) +
                '%</li>' +
                '<li>Fire: ' +
                ((mData.elements && mData.elements.fire) || 0) +
                '%</li>' +
                '<li>Holy: ' +
                ((mData.elements && mData.elements.holy) || 0) +
                '%</li>' +
                '<li>Physical: ' +
                ((mData.elements && mData.elements.physical) || 0) +
                '%</li>' +
                '</ul></div>' +
                '<div class="col-md-6"><p><strong>Bestiary Kills:</strong> ' +
                (mData.Bestiary && mData.Bestiary.toKill != null
                    ? mData.Bestiary.toKill
                    : 0) +
                '</p></div>' +
                '<div class="col-md-6"><p><strong>Average Loot:</strong> ' +
                (mData.average_loot != null
                    ? Number(mData.average_loot).toFixed(2)
                    : '0') +
                '</p></div>' +
                '<div class="col-md-6"><p><strong>EXP / HP:</strong> ' +
                (mData.health
                    ? (mData.experience / mData.health).toFixed(2)
                    : '0') +
                '</p></div>' +
                '<div class="col-md-6"><p><strong>Loot / HP:</strong> ' +
                (mData.average_loot != null && mData.health
                    ? (mData.average_loot / mData.health).toFixed(2)
                    : '0') +
                '</p></div>' +
                '<div class="col-md-6"><p><strong>Walk on:</strong><br>' +
                'Energy: ' +
                (mData.flags && mData.flags.canWalkOnEnergy ? 'yes' : 'no') +
                '<br>Fire: ' +
                (mData.flags && mData.flags.canWalkOnFire ? 'yes' : 'no') +
                '<br>Poison: ' +
                (mData.flags && mData.flags.canWalkOnPoison ? 'yes' : 'no') +
                '</p></div>' +
                '<div class="col-md-6"><p><strong>Other:</strong><br>' +
                'See invisible: ' +
                (mData.immunities && mData.immunities.invisible
                    ? 'yes'
                    : 'no') +
                '<br>Push items: ' +
                (mData.flags && mData.flags.canPushItems ? 'yes' : 'no') +
                '</p></div></div>';
            if (monsterModal) monsterModal.show();
        } else {
            const std = standardPresets[spawn.creatureId];
            monsterModalTitle.textContent = std
                ? std.label || spawn.creatureId
                : spawn.legacyName || spawn.creatureId || 'Unknown';
            monsterModalBody.innerHTML =
                '<p>No entry in monsters.json for <code>' +
                monsterName +
                '</code>.</p>' +
                (std
                    ? '<p class="mb-0"><strong>Standard id:</strong> ' +
                      std.id +
                      (std.customSprite
                          ? '<br><strong>Sprite:</strong> ' + std.customSprite
                          : '') +
                      (std.hp != null
                          ? '<br><strong>HP (preset):</strong> ' + std.hp
                          : '') +
                      '</p>'
                    : '');
            if (monsterModal) monsterModal.show();
        }
    }

    /**
     * Center view on map-local (x, y). Same contract as map-spawn.js
     * zoomImageAtPoint. Accepts legacy world deep-links via deepLinkToLocal.
     */
    function zoomImageAtPoint(x, y, floorZ, zoomPercentage = 1600) {
        const floorStr = padFloor(floorZ);
        const floorRadio = document.getElementById('floor-' + floorStr + '-path');
        if (floorRadio) {
            floorRadio.checked = true;
            floorRadio.dispatchEvent(new Event('change', { bubbles: true }));
        }

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

    // Boot: deep-link or default center (local 1129,767 @ 1600% — map-spawn.js)
    const urlParams = new URLSearchParams(window.location.search);
    const centerPoint = urlParams.get('point');

    loadFloorSpawns(currentFloor);

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
</script>
</body>
</html>
