/**
 * json-editor custom editor: visual multi-box spawn regions for hunt waves.
 * Format: "wave_regions" — array of { id?, x, y, w, h, z? } (cutout-style).
 *
 * Draws on a grid sized to the hunt's fixed dungeon profile (layout.profileId)
 * when available so authors can see walls/floor while placing boxes.
 */

'use strict';

const CELL_PX = 16;
const DEFAULT_COLS = 24;
const DEFAULT_ROWS = 24;
const MAX_GRID = 96;
const MAP_PAD = 1;

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function toInt(v, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {unknown} raw
 * @param {number} [index=0]
 * @returns {{ id: string, x: number, y: number, w: number, h: number, z: number }}
 */
function normalizeRegion(raw, index) {
    const i = index != null ? index : 0;
    if (!raw || typeof raw !== 'object') {
        return {
            id: `region_${i + 1}`,
            x: 0,
            y: 0,
            w: 5,
            h: 5,
            z: 0
        };
    }
    const o = /** @type {Record<string, unknown>} */ (raw);
    const bbox =
        o.bbox && typeof o.bbox === 'object'
            ? /** @type {Record<string, unknown>} */ (o.bbox)
            : o;
    const x = toInt(bbox.x, 0);
    const y = toInt(bbox.y, 0);
    const w = Math.max(1, toInt(bbox.w != null ? bbox.w : bbox.width, 5));
    const h = Math.max(1, toInt(bbox.h != null ? bbox.h : bbox.height, 5));
    const z = toInt(o.z != null ? o.z : bbox.z, 0);
    const id =
        o.id != null && String(o.id).trim()
            ? String(o.id).trim()
            : `region_${i + 1}`;
    return { id, x, y, w, h, z };
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, x: number, y: number, w: number, h: number, z: number }[]}
 */
function normalizeRegions(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{ id: string, x: number, y: number, w: number, h: number, z: number }[]} */
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        out.push(normalizeRegion(raw[i], i));
    }
    return out;
}

/**
 * @param {{ x0: number, y0: number, x1: number, y1: number }} d
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
function rectFromDrag(d) {
    const x = Math.min(d.x0, d.x1);
    const y = Math.min(d.y0, d.y1);
    const w = Math.abs(d.x1 - d.x0) + 1;
    const h = Math.abs(d.y1 - d.y0) + 1;
    return { x, y, w, h };
}

/**
 * @param {unknown} rows
 * @param {number} w
 * @param {number} h
 * @returns {string[]}
 */
function frictionRows(rows, w, h) {
    /** @type {string[]} */
    let src = [];
    if (Array.isArray(rows)) {
        src = rows.map((r) => String(r || ''));
    }
    /** @type {string[]} */
    const out = [];
    for (let y = 0; y < h; y++) {
        let row = src[y] != null ? src[y] : '';
        if (row.length < w) row += '#'.repeat(w - row.length);
        if (row.length > w) row = row.slice(0, w);
        let s = '';
        for (let x = 0; x < w; x++) {
            const ch = row.charAt(x);
            s += ch === '#' || ch === 'X' || ch === 'x' || ch === 'W' ? '#' : '.';
        }
        out.push(s);
    }
    return out;
}

/**
 * @param {unknown} piece
 * @returns {{ id: string, w: number, h: number, friction: string[] }|null}
 */
function normalizePieceLite(piece) {
    if (!piece || typeof piece !== 'object') return null;
    const p = /** @type {Record<string, unknown>} */ (piece);
    const id = p.id != null ? String(p.id) : '';
    if (!id) return null;
    const size =
        p.size && typeof p.size === 'object'
            ? /** @type {Record<string, unknown>} */ (p.size)
            : {};
    const w = Math.max(1, toInt(size.w != null ? size.w : p.w, 5));
    const h = Math.max(1, toInt(size.h != null ? size.h : p.h, 5));
    return {
        id,
        w,
        h,
        friction: frictionRows(p.friction, w, h)
    };
}

/**
 * @param {unknown} raw
 * @returns {{ pieceId: string, x: number, y: number }[]}
 */
function normalizePlacements(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{ pieceId: string, x: number, y: number }[]} */
    const out = [];
    for (const p of raw) {
        if (!p || typeof p !== 'object') continue;
        const o = /** @type {Record<string, unknown>} */ (p);
        const pieceId =
            o.pieceId != null
                ? String(o.pieceId)
                : o.id != null
                  ? String(o.id)
                  : '';
        if (!pieceId) continue;
        out.push({
            pieceId,
            x: toInt(o.x, 0),
            y: toInt(o.y, 0)
        });
    }
    return out;
}

/**
 * @param {unknown} raw
 * @returns {{ x: number, y: number }|null}
 */
function normalizePoint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const x = toInt(o.x, NaN);
    const y = toInt(o.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

/**
 * @param {unknown} raw
 * @returns {{ x: number, y: number }[]}
 */
function normalizeWaypoints(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{ x: number, y: number }[]} */
    const out = [];
    for (const p of raw) {
        const pt = normalizePoint(p);
        if (pt) out.push(pt);
    }
    return out;
}

/**
 * Composite fixed dungeon placements into a walkable floor grid (world coords).
 *
 * @param {{ placements?: unknown, entrance?: unknown, exit?: unknown, waypoints?: unknown }} profile
 * @param {Map<string, { id: string, w: number, h: number, friction: string[] }>} pieceIndex
 * @returns {{
 *   minX: number,
 *   minY: number,
 *   cols: number,
 *   rows: number,
 *   cells: (null|string)[],
 *   entrance: { x: number, y: number }|null,
 *   exit: { x: number, y: number }|null,
 *   waypoints: { x: number, y: number }[]
 * }|null}
 */
function compositeDungeonFloor(profile, pieceIndex) {
    const placements = normalizePlacements(profile && profile.placements);
    if (!placements.length) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pl of placements) {
        const p = pieceIndex.get(pl.pieceId);
        const pw = p ? p.w : 5;
        const ph = p ? p.h : 5;
        minX = Math.min(minX, pl.x);
        minY = Math.min(minY, pl.y);
        maxX = Math.max(maxX, pl.x + pw);
        maxY = Math.max(maxY, pl.y + ph);
    }
    if (!Number.isFinite(minX)) return null;

    minX -= MAP_PAD;
    minY -= MAP_PAD;
    maxX += MAP_PAD;
    maxY += MAP_PAD;

    const cols = Math.min(MAX_GRID, Math.max(1, maxX - minX));
    const rows = Math.min(MAX_GRID, Math.max(1, maxY - minY));
    /** @type {(null|string)[]} */
    const cells = new Array(cols * rows).fill(null);

    for (const pl of placements) {
        const p = pieceIndex.get(pl.pieceId);
        if (!p) continue;
        for (let ly = 0; ly < p.h; ly++) {
            for (let lx = 0; lx < p.w; lx++) {
                const wx = pl.x + lx - minX;
                const wy = pl.y + ly - minY;
                if (wx < 0 || wy < 0 || wx >= cols || wy >= rows) continue;
                const ch = p.friction[ly].charAt(lx);
                cells[wy * cols + wx] = ch === '#' ? '#' : '.';
            }
        }
    }

    return {
        minX,
        minY,
        cols,
        rows,
        cells,
        entrance: normalizePoint(profile.entrance),
        exit: normalizePoint(profile.exit),
        waypoints: normalizeWaypoints(profile.waypoints)
    };
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

/**
 * @returns {string}
 */
function apiBase() {
    if (typeof window !== 'undefined' && window.__API_URL__) {
        return String(window.__API_URL__);
    }
    return 'php/api.php';
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} params
 */
async function apiGet(action, params) {
    const url = new URL(apiBase(), window.location.href);
    url.searchParams.set('action', action);
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.href, { method: 'GET', cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
        throw new Error((data && data.error) || `API ${action} failed`);
    }
    return data;
}

/**
 * @returns {string}
 */
function currentMode() {
    const el = document.getElementById('heModeSelect');
    if (el && /** @type {HTMLSelectElement} */ (el).value) {
        return String(/** @type {HTMLSelectElement} */ (el).value);
    }
    if (typeof window !== 'undefined' && window.__CONTENT_MODE__) {
        return String(window.__CONTENT_MODE__);
    }
    return 'standard';
}

/**
 * Register custom editor once JSONEditor is on window.
 * @returns {boolean}
 */
function registerWaveRegionsEditor() {
    if (typeof window === 'undefined' || typeof window.JSONEditor !== 'function') {
        return false;
    }
    if (window.__HE_WAVE_REGIONS_REGISTERED__) return true;

    const JE = window.JSONEditor;
    const Abstract = JE.AbstractEditor;

    class WaveRegionsEditor extends Abstract {
        /**
         * json-editor may call getValue() before build(); always init state early.
         */
        preBuild() {
            this.ensureState();
        }

        /**
         * @returns {void}
         */
        ensureState() {
            if (!Array.isArray(this.regions)) {
                /** @type {{ id: string, x: number, y: number, w: number, h: number, z: number }[]} */
                this.regions = [];
            }
            if (this.selected == null || typeof this.selected !== 'number') {
                this.selected = -1;
            }
            if (this.tool !== 'select' && this.tool !== 'draw') {
                this.tool = 'draw';
            }
            if (this.gridCols == null) this.gridCols = DEFAULT_COLS;
            if (this.gridRows == null) this.gridRows = DEFAULT_ROWS;
            if (this.originX == null) this.originX = 0;
            if (this.originY == null) this.originY = 0;
            if (this._drag === undefined) this._drag = null;
            if (this._onDocMouseMove === undefined) this._onDocMouseMove = null;
            if (this._onDocMouseUp === undefined) this._onDocMouseUp = null;
            if (this._floor === undefined) this._floor = null;
            if (this._floorProfileId === undefined) this._floorProfileId = '';
            if (this._floorStatus === undefined) this._floorStatus = 'idle';
            if (this._floorMessage === undefined) this._floorMessage = '';
            if (this._floorLoadToken === undefined) this._floorLoadToken = 0;
            if (this._mapTable === undefined) this._mapTable = null;
            if (this._onRootChange === undefined) this._onRootChange = null;
        }

        build() {
            this.ensureState();

            this.header = this.label = this.theme.getFormInputLabel(this.getTitle());
            this.description = this.theme.getFormInputDescription(
                this.schema.description ||
                    'Spawn regions for random wave tiles (union of boxes). Drag on the map to add a region.'
            );
            this.container.appendChild(this.header);
            if (this.description) this.container.appendChild(this.description);

            this.root = document.createElement('div');
            this.root.className = 'he-wave-regions';
            this.container.appendChild(this.root);

            this.bindRootChange();
            this.renderShell();
            this.input = this.root;
            void this.ensureDungeonPreview();
        }

        /**
         * Re-load floor when hunt layout.profileId changes.
         */
        bindRootChange() {
            if (!this.jsoneditor || typeof this.jsoneditor.on !== 'function') {
                return;
            }
            if (this._onRootChange) return;
            this._onRootChange = () => {
                const id = this.getHuntLayoutProfileId();
                if (id !== this._floorProfileId) {
                    void this.ensureDungeonPreview();
                }
            };
            this.jsoneditor.on('change', this._onRootChange);
        }

        /**
         * @returns {string}
         */
        getHuntLayoutProfileId() {
            try {
                const root = this.jsoneditor;
                if (root && typeof root.getValue === 'function') {
                    const v = root.getValue();
                    if (v && typeof v === 'object') {
                        const layout =
                            /** @type {Record<string, unknown>} */ (v).layout;
                        if (layout && typeof layout === 'object') {
                            const pid =
                                /** @type {Record<string, unknown>} */ (layout)
                                    .profileId;
                            if (pid != null && String(pid).trim()) {
                                return String(pid).trim();
                            }
                        }
                    }
                }
            } catch (_) {
                /* ignore */
            }
            return '';
        }

        renderShell() {
            this.ensureState();
            if (!this.root) return;
            this.root.innerHTML =
                `<div class="he-wave-regions-layout">` +
                `<div class="he-wave-regions-map-col">` +
                `<div class="he-wave-regions-tools" data-role="tools"></div>` +
                `<div class="he-wave-regions-floor-status small text-muted" data-role="floor-status"></div>` +
                `<div class="he-wave-regions-map-wrap" data-role="map-wrap"></div>` +
                `<p class="small text-muted mb-0" data-role="hint">Drag on the map to paint a new spawn region. Select a card to highlight it.</p>` +
                `</div>` +
                `<div class="he-wave-regions-side">` +
                `<div class="he-wave-regions-subhead">Regions</div>` +
                `<div class="he-wave-regions-list" data-role="list"></div>` +
                `<button type="button" class="btn btn-sm btn-retro btn-secondary mt-1" data-action="add">+ Region</button>` +
                `</div>` +
                `</div>`;

            this.root.querySelectorAll('[data-action]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const action = btn.getAttribute('data-action');
                    if (action === 'add') {
                        this.ensureState();
                        this.regions.push({
                            id: `region_${this.regions.length + 1}`,
                            x: this.originX,
                            y: this.originY,
                            w: 5,
                            h: 5,
                            z: 0
                        });
                        this.selected = this.regions.length - 1;
                        this.fitGrid();
                        this.renderAll();
                        this.onChange(true);
                    } else if (action === 'reload-floor') {
                        void this.ensureDungeonPreview(true);
                    }
                });
            });

            this.renderTools();
            this.renderFloorStatus();
            this.renderList();
            this.renderMap();
        }

        renderTools() {
            if (!this.root) return;
            const host = this.root.querySelector('[data-role="tools"]');
            if (!host) return;
            const tools = [
                { id: 'draw', label: 'Draw box' },
                { id: 'select', label: 'Select' }
            ];
            host.innerHTML =
                tools
                    .map(
                        (t) =>
                            `<button type="button" class="btn btn-sm btn-retro btn-secondary he-wave-regions-tool${
                                this.tool === t.id ? ' is-active' : ''
                            }" data-tool="${t.id}">${t.label}</button>`
                    )
                    .join('') +
                `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-action="reload-floor" title="Reload dungeon floor from layout.profileId">Reload map</button>`;

            host.querySelectorAll('[data-tool]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const id = btn.getAttribute('data-tool');
                    if (id !== 'draw' && id !== 'select') return;
                    this.tool = id;
                    this.cancelDrag();
                    this.renderTools();
                    const hint = this.root.querySelector('[data-role="hint"]');
                    if (hint) {
                        hint.textContent =
                            id === 'draw'
                                ? 'Press and drag on the map to paint a new spawn region.'
                                : 'Click a region on the map or pick a card to select.';
                    }
                });
            });
            host.querySelectorAll('[data-action="reload-floor"]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    void this.ensureDungeonPreview(true);
                });
            });
        }

        renderFloorStatus() {
            if (!this.root) return;
            const el = this.root.querySelector('[data-role="floor-status"]');
            if (!el) return;
            if (this._floorStatus === 'loading') {
                el.textContent = `Loading dungeon “${this._floorProfileId || '…'}”…`;
                return;
            }
            if (this._floorStatus === 'ready' && this._floor) {
                el.textContent =
                    `Dungeon: ${this._floorProfileId} · ${this._floor.cols}×${this._floor.rows} tiles` +
                    ` (origin ${this.originX},${this.originY}). World coords match the dungeon profile.`;
                return;
            }
            if (this._floorStatus === 'unsupported') {
                el.textContent =
                    this._floorMessage ||
                    'Layout has no fixed placements — abstract grid only.';
                return;
            }
            if (this._floorStatus === 'error') {
                el.textContent =
                    this._floorMessage ||
                    'Could not load dungeon floor for preview.';
                return;
            }
            el.textContent =
                'Set layout.profileId (fixed dungeon) to preview walls/floor while drawing boxes.';
        }

        /**
         * @param {boolean} [force]
         */
        async ensureDungeonPreview(force) {
            this.ensureState();
            const profileId = this.getHuntLayoutProfileId();
            if (
                !force &&
                profileId &&
                profileId === this._floorProfileId &&
                this._floorStatus === 'ready' &&
                this._floor
            ) {
                return;
            }
            if (!profileId) {
                this._floor = null;
                this._floorProfileId = '';
                this._floorStatus = 'idle';
                this._floorMessage = '';
                this.fitGrid();
                this.renderFloorStatus();
                this.renderMap();
                return;
            }

            const token = ++this._floorLoadToken;
            this._floorProfileId = profileId;
            this._floorStatus = 'loading';
            this._floorMessage = '';
            this.renderFloorStatus();

            try {
                const mode = currentMode();
                const data = await apiGet('presets_get', {
                    mode,
                    kind: 'dungeons',
                    id: profileId
                });
                if (token !== this._floorLoadToken) return;

                const entity =
                    data.entity && typeof data.entity === 'object'
                        ? data.entity
                        : data;
                const profile =
                    entity && typeof entity === 'object'
                        ? /** @type {Record<string, unknown>} */ (entity)
                        : {};
                const placements = normalizePlacements(profile.placements);
                const piecePack =
                    profile.piecePack != null
                        ? String(profile.piecePack)
                        : '';

                if (!placements.length) {
                    this._floor = null;
                    this._floorStatus = 'unsupported';
                    this._floorMessage =
                        profile.type === 'procedural'
                            ? `“${profileId}” is procedural — no static floor to preview. Use a fixed dungeon profile.`
                            : `“${profileId}” has no piece placements — abstract grid only.`;
                    this.fitGrid();
                    this.renderFloorStatus();
                    this.renderMap();
                    return;
                }

                if (!piecePack) {
                    this._floor = null;
                    this._floorStatus = 'error';
                    this._floorMessage = `Dungeon “${profileId}” has no piecePack.`;
                    this.fitGrid();
                    this.renderFloorStatus();
                    this.renderMap();
                    return;
                }

                const packData = await apiGet('presets_get', {
                    mode,
                    kind: 'pieces',
                    id: piecePack
                });
                if (token !== this._floorLoadToken) return;

                const packEntity =
                    packData.entity && typeof packData.entity === 'object'
                        ? packData.entity
                        : packData;
                const pieces = Array.isArray(
                    /** @type {Record<string, unknown>} */ (packEntity).pieces
                )
                    ? /** @type {unknown[]} */ (
                          /** @type {Record<string, unknown>} */ (packEntity)
                              .pieces
                      )
                    : [];
                /** @type {Map<string, { id: string, w: number, h: number, friction: string[] }>} */
                const pieceIndex = new Map();
                for (const raw of pieces) {
                    const lite = normalizePieceLite(raw);
                    if (lite) pieceIndex.set(lite.id, lite);
                }

                const floor = compositeDungeonFloor(
                    /** @type {{ placements?: unknown, entrance?: unknown, exit?: unknown, waypoints?: unknown }} */ (
                        profile
                    ),
                    pieceIndex
                );
                if (!floor) {
                    this._floor = null;
                    this._floorStatus = 'unsupported';
                    this._floorMessage = `Could not composite floor for “${profileId}”.`;
                    this.fitGrid();
                    this.renderFloorStatus();
                    this.renderMap();
                    return;
                }

                this._floor = floor;
                this._floorStatus = 'ready';
                this._floorMessage = '';
                this.fitGrid();
                this.renderFloorStatus();
                this.renderMap();
            } catch (err) {
                if (token !== this._floorLoadToken) return;
                this._floor = null;
                this._floorStatus = 'error';
                this._floorMessage =
                    err && /** @type {Error} */ (err).message
                        ? String(/** @type {Error} */ (err).message)
                        : `Failed to load dungeon “${profileId}”.`;
                this.fitGrid();
                this.renderFloorStatus();
                this.renderMap();
            }
        }

        fitGrid() {
            this.ensureState();
            if (this._floor) {
                this.originX = this._floor.minX;
                this.originY = this._floor.minY;
                let cols = this._floor.cols;
                let rows = this._floor.rows;
                for (let i = 0; i < this.regions.length; i++) {
                    const r = this.regions[i];
                    const needX = r.x + r.w - this.originX + 1;
                    const needY = r.y + r.h - this.originY + 1;
                    if (needX > cols) cols = needX;
                    if (needY > rows) rows = needY;
                }
                this.gridCols = Math.min(MAX_GRID, Math.max(8, cols));
                this.gridRows = Math.min(MAX_GRID, Math.max(8, rows));
                return;
            }

            this.originX = 0;
            this.originY = 0;
            let maxX = DEFAULT_COLS;
            let maxY = DEFAULT_ROWS;
            for (let i = 0; i < this.regions.length; i++) {
                const r = this.regions[i];
                maxX = Math.max(maxX, r.x + r.w + 2);
                maxY = Math.max(maxY, r.y + r.h + 2);
            }
            this.gridCols = Math.min(MAX_GRID, Math.max(8, maxX));
            this.gridRows = Math.min(MAX_GRID, Math.max(8, maxY));
        }

        renderList() {
            this.ensureState();
            if (!this.root) return;
            const host = this.root.querySelector('[data-role="list"]');
            if (!host) return;
            host.innerHTML = '';
            if (!this.regions.length) {
                host.innerHTML =
                    '<p class="small text-muted mb-0">No regions — whole floor is used for random spawns. Draw boxes to limit the fight area.</p>';
                return;
            }
            this.regions.forEach((r, idx) => {
                const card = document.createElement('div');
                card.className =
                    'he-wave-region-card' +
                    (this.selected === idx ? ' is-active' : '');
                card.innerHTML =
                    `<div class="he-wave-region-row">` +
                    `<label class="he-wave-region-field he-wave-region-field--grow">Id<input type="text" class="form-control form-control-sm font-monospace" data-f="id" value="${escapeAttr(r.id)}" spellcheck="false"></label>` +
                    `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-del="${idx}" title="Remove">×</button>` +
                    `</div>` +
                    `<div class="he-wave-region-row">` +
                    `<label class="he-wave-region-field">x<input type="number" class="form-control form-control-sm" data-f="x" value="${r.x}"></label>` +
                    `<label class="he-wave-region-field">y<input type="number" class="form-control form-control-sm" data-f="y" value="${r.y}"></label>` +
                    `<label class="he-wave-region-field">w<input type="number" class="form-control form-control-sm" data-f="w" value="${r.w}" min="1"></label>` +
                    `<label class="he-wave-region-field">h<input type="number" class="form-control form-control-sm" data-f="h" value="${r.h}" min="1"></label>` +
                    `<label class="he-wave-region-field">z<input type="number" class="form-control form-control-sm" data-f="z" value="${r.z}"></label>` +
                    `</div>`;

                card.addEventListener('click', (ev) => {
                    if (
                        /** @type {HTMLElement} */ (ev.target).closest(
                            'input,button'
                        )
                    ) {
                        return;
                    }
                    this.selected = idx;
                    this.renderList();
                    this.refreshRegionClasses();
                });

                card.querySelectorAll('[data-f]').forEach((el) => {
                    const input = /** @type {HTMLInputElement} */ (el);
                    const key = input.getAttribute('data-f');
                    const apply = () => {
                        if (key === 'id') {
                            r.id = input.value.trim() || `region_${idx + 1}`;
                        } else if (key === 'x') r.x = toInt(input.value, 0);
                        else if (key === 'y') r.y = toInt(input.value, 0);
                        else if (key === 'w') {
                            r.w = Math.max(1, toInt(input.value, 1));
                        } else if (key === 'h') {
                            r.h = Math.max(1, toInt(input.value, 1));
                        } else if (key === 'z') r.z = toInt(input.value, 0);
                        this.fitGrid();
                        this.renderMap();
                        this.onChange(true);
                    };
                    input.addEventListener('change', apply);
                    input.addEventListener('input', apply);
                });

                const del = card.querySelector('[data-del]');
                if (del) {
                    del.addEventListener('click', () => {
                        this.regions.splice(idx, 1);
                        if (this.selected === idx) this.selected = -1;
                        else if (this.selected > idx) this.selected -= 1;
                        this.fitGrid();
                        this.renderAll();
                        this.onChange(true);
                    });
                }

                host.appendChild(card);
            });
        }

        /**
         * @param {number} worldX
         * @param {number} worldY
         * @returns {HTMLElement|null}
         */
        cellAt(worldX, worldY) {
            if (!this._mapTable) return null;
            return /** @type {HTMLElement|null} */ (
                this._mapTable.querySelector(
                    `[data-x="${worldX}"][data-y="${worldY}"]`
                )
            );
        }

        /**
         * Paint region / selection classes without rebuilding the grid DOM.
         */
        refreshRegionClasses() {
            if (!this._mapTable) return;
            const cells = this._mapTable.querySelectorAll(
                '.he-wave-regions-cell'
            );
            cells.forEach((node) => {
                const cell = /** @type {HTMLElement} */ (node);
                const wx = toInt(cell.getAttribute('data-x'), 0);
                const wy = toInt(cell.getAttribute('data-y'), 0);
                cell.classList.remove('is-region', 'is-selected');
                delete cell.dataset.region;
                let coverIdx = -1;
                for (let i = 0; i < this.regions.length; i++) {
                    const r = this.regions[i];
                    if (
                        wx >= r.x &&
                        wy >= r.y &&
                        wx < r.x + r.w &&
                        wy < r.y + r.h
                    ) {
                        coverIdx = i;
                    }
                }
                if (coverIdx >= 0) {
                    cell.classList.add('is-region');
                    if (coverIdx === this.selected) {
                        cell.classList.add('is-selected');
                    }
                    cell.dataset.region = String(coverIdx);
                }
            });
            this.applyDragPreview();
        }

        clearDragPreview() {
            if (!this._mapTable) return;
            this._mapTable
                .querySelectorAll('.he-wave-regions-cell.is-preview')
                .forEach((el) => {
                    el.classList.remove('is-preview');
                });
        }

        /**
         * Rubber-band highlight while drawing — never rebuilds the grid.
         */
        applyDragPreview() {
            this.clearDragPreview();
            if (!this._drag || !this._mapTable) return;
            const { x, y, w, h } = rectFromDrag(this._drag);
            for (let wy = y; wy < y + h; wy++) {
                for (let wx = x; wx < x + w; wx++) {
                    const cell = this.cellAt(wx, wy);
                    if (cell) cell.classList.add('is-preview');
                }
            }
        }

        cancelDrag() {
            this.unbindDocDrag();
            this._drag = null;
            this.clearDragPreview();
        }

        unbindDocDrag() {
            if (this._onDocMouseMove) {
                document.removeEventListener('mousemove', this._onDocMouseMove);
                this._onDocMouseMove = null;
            }
            if (this._onDocMouseUp) {
                document.removeEventListener('mouseup', this._onDocMouseUp);
                this._onDocMouseUp = null;
            }
        }

        /**
         * @param {MouseEvent} e
         * @returns {{ x: number, y: number }|null}
         */
        worldFromEvent(e) {
            if (!this._mapTable) return null;
            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (!el) return null;
            const c = /** @type {HTMLElement} */ (el).closest(
                '.he-wave-regions-cell'
            );
            if (!c || !this._mapTable.contains(c)) return null;
            return {
                x: toInt(c.getAttribute('data-x'), 0),
                y: toInt(c.getAttribute('data-y'), 0)
            };
        }

        renderMap() {
            this.ensureState();
            if (!this.root) return;
            const host = this.root.querySelector('[data-role="map-wrap"]');
            if (!host) return;

            // Abort in-progress draw if the grid is rebuilt mid-stroke.
            this.unbindDocDrag();
            this._drag = null;

            const cols = this.gridCols;
            const rows = this.gridRows;
            const ox = this.originX;
            const oy = this.originY;
            const floor = this._floor;

            const table = document.createElement('div');
            table.className = 'he-wave-regions-grid';
            if (floor) table.classList.add('has-dungeon');
            table.style.gridTemplateColumns = `repeat(${cols}, ${CELL_PX}px)`;
            table.style.gridTemplateRows = `repeat(${rows}, ${CELL_PX}px)`;
            table.setAttribute('role', 'grid');
            table.setAttribute('aria-label', 'Spawn regions map');

            const entrance = floor && floor.entrance;
            const exit = floor && floor.exit;
            /** @type {Map<string, number>} */
            const wpAt = new Map();
            if (floor && floor.waypoints) {
                for (let i = 0; i < floor.waypoints.length; i++) {
                    const wp = floor.waypoints[i];
                    wpAt.set(`${wp.x},${wp.y}`, i + 1);
                }
            }

            for (let cy = 0; cy < rows; cy++) {
                for (let cx = 0; cx < cols; cx++) {
                    const wx = ox + cx;
                    const wy = oy + cy;
                    const cell = document.createElement('div');
                    cell.className = 'he-wave-regions-cell';
                    cell.dataset.x = String(wx);
                    cell.dataset.y = String(wy);

                    let terrain = null;
                    if (floor) {
                        const fx = wx - floor.minX;
                        const fy = wy - floor.minY;
                        if (
                            fx >= 0 &&
                            fy >= 0 &&
                            fx < floor.cols &&
                            fy < floor.rows
                        ) {
                            terrain = floor.cells[fy * floor.cols + fx];
                        }
                    }
                    if (terrain == null) {
                        if (floor) cell.classList.add('is-void');
                        else cell.classList.add('is-empty');
                    } else if (terrain === '#') {
                        cell.classList.add('is-wall');
                    } else {
                        cell.classList.add('is-floor');
                    }

                    let coverIdx = -1;
                    for (let i = 0; i < this.regions.length; i++) {
                        const r = this.regions[i];
                        if (
                            wx >= r.x &&
                            wy >= r.y &&
                            wx < r.x + r.w &&
                            wy < r.y + r.h
                        ) {
                            coverIdx = i;
                        }
                    }
                    if (coverIdx >= 0) {
                        cell.classList.add('is-region');
                        if (coverIdx === this.selected) {
                            cell.classList.add('is-selected');
                        }
                        cell.dataset.region = String(coverIdx);
                    }

                    let title = `${wx},${wy}`;
                    if (entrance && entrance.x === wx && entrance.y === wy) {
                        cell.classList.add('is-entrance');
                        cell.textContent = 'E';
                        title += ' entrance';
                    } else if (exit && exit.x === wx && exit.y === wy) {
                        cell.classList.add('is-exit');
                        cell.textContent = 'X';
                        title += ' exit';
                    } else {
                        const wpN = wpAt.get(`${wx},${wy}`);
                        if (wpN != null) {
                            cell.classList.add('is-waypoint');
                            cell.textContent = String(wpN);
                            title += ` waypoint #${wpN}`;
                        }
                    }
                    if (terrain === '#') title += ' wall';
                    else if (terrain === '.') title += ' floor';
                    cell.title = title;

                    table.appendChild(cell);
                }
            }

            table.addEventListener('mousedown', (ev) => {
                if (ev.button !== 0) return;
                const t = /** @type {HTMLElement} */ (ev.target);
                const cell = t.closest('[data-x][data-y]');
                if (!cell || !table.contains(cell)) return;
                ev.preventDefault();
                const x = toInt(cell.getAttribute('data-x'), 0);
                const y = toInt(cell.getAttribute('data-y'), 0);

                if (this.tool === 'select') {
                    const rid = cell.getAttribute('data-region');
                    this.selected = rid != null ? toInt(rid, -1) : -1;
                    this.renderList();
                    this.refreshRegionClasses();
                    return;
                }

                // Draw tool: rubber-band only until mouseup (do not rebuild DOM).
                this.unbindDocDrag();
                this._drag = { x0: x, y0: y, x1: x, y1: y };
                this.applyDragPreview();

                this._onDocMouseMove = (e) => {
                    if (!this._drag) return;
                    const pt = this.worldFromEvent(e);
                    if (!pt) return;
                    if (pt.x === this._drag.x1 && pt.y === this._drag.y1) {
                        return;
                    }
                    this._drag.x1 = pt.x;
                    this._drag.y1 = pt.y;
                    this.applyDragPreview();
                };
                this._onDocMouseUp = () => {
                    this.finishDrag();
                };
                document.addEventListener('mousemove', this._onDocMouseMove);
                document.addEventListener('mouseup', this._onDocMouseUp);
            });

            // Prevent the browser from selecting text / starting native drag.
            table.addEventListener('dragstart', (ev) => ev.preventDefault());

            this._mapTable = table;
            host.innerHTML = '';
            host.appendChild(table);
        }

        finishDrag() {
            this.unbindDocDrag();
            if (!this._drag) return;
            const d = this._drag;
            this._drag = null;
            this.clearDragPreview();

            const { x, y, w, h } = rectFromDrag(d);
            // A pure click (no drag) still creates a 1×1 box — intentional.
            this.regions.push({
                id: `region_${this.regions.length + 1}`,
                x,
                y,
                w,
                h,
                z: 0
            });
            this.selected = this.regions.length - 1;
            this.fitGrid();
            // Full rebuild only after commit (grid may need to grow).
            this.renderAll();
            this.onChange(true);
        }

        renderAll() {
            this.renderTools();
            this.renderFloorStatus();
            this.renderList();
            this.renderMap();
        }

        /**
         * @param {unknown} value
         * @param {boolean} [initial]
         */
        setValue(value, initial) {
            this.ensureState();
            this.regions = normalizeRegions(value);
            this.selected = this.regions.length ? 0 : -1;
            this.fitGrid();
            if (this.root) {
                this.bindRootChange();
                this.renderAll();
                void this.ensureDungeonPreview();
            }
            // initial setValue must not bubble (parent may still be wiring children)
            this.onChange(!initial);
        }

        getValue() {
            this.ensureState();
            return this.regions.map((r) => {
                /** @type {Record<string, unknown>} */
                const row = {
                    id: r.id,
                    x: r.x,
                    y: r.y,
                    w: r.w,
                    h: r.h
                };
                if (r.z) row.z = r.z;
                return row;
            });
        }

        destroy() {
            this.unbindDocDrag();
            if (this._onRootChange && this.jsoneditor) {
                try {
                    if (typeof this.jsoneditor.off === 'function') {
                        this.jsoneditor.off('change', this._onRootChange);
                    }
                } catch (_) {
                    /* ignore */
                }
                this._onRootChange = null;
            }
            this._mapTable = null;
            this._floor = null;
            if (this.root) {
                this.root.innerHTML = '';
                this.root = null;
            }
            super.destroy();
        }
    }

    JE.defaults.editors.wave_regions = WaveRegionsEditor;
    JE.defaults.resolvers.unshift((schema) => {
        if (schema && schema.format === 'wave_regions') {
            return 'wave_regions';
        }
    });

    window.__HE_WAVE_REGIONS_REGISTERED__ = true;
    return true;
}

module.exports = {
    registerWaveRegionsEditor,
    normalizeRegion,
    normalizeRegions,
    rectFromDrag,
    frictionRows,
    normalizePieceLite,
    normalizePlacements,
    compositeDungeonFloor
};
