/**
 * json-editor custom editor: interactive friction grid for dungeon pieces.
 * Format: "dungeon_piece" — paints # / ., toggles exits, places sockets.
 *
 * Paint: click/drag with Wall or Floor. Flood fill: Flood tool, or Shift+click
 * with Wall/Floor. Rect fill: Rect tool + drag a box with Wall/Floor brush.
 */

'use strict';

const MAX_DIM = 32;
const MIN_DIM = 1;

/**
 * @param {unknown} v
 * @param {number} fallback
 * @returns {number}
 */
function clampDim(v, fallback) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(MIN_DIM, Math.min(MAX_DIM, n));
}

/**
 * 4-connected flood fill on friction rows. Mutates `rows` in place.
 * Only replaces cells matching the seed cell's character with `ch`.
 *
 * @param {string[]} rows
 * @param {number} x
 * @param {number} y
 * @param {string} ch  '#' or '.'
 * @param {number} w
 * @param {number} h
 * @returns {{ x: number, y: number }[]} changed cells
 */
function floodFillFriction(rows, x, y, ch, w, h) {
    /** @type {{ x: number, y: number }[]} */
    const changed = [];
    if (x < 0 || y < 0 || x >= w || y >= h) return changed;
    if (ch !== '#' && ch !== '.') return changed;
    const target = rows[y].charAt(x);
    if (target === ch) return changed;

    /** @type {{ x: number, y: number }[]} */
    const stack = [{ x, y }];
    /** @type {Set<string>} */
    const seen = new Set();

    while (stack.length) {
        const p = stack.pop();
        if (!p) break;
        const key = `${p.x},${p.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (p.x < 0 || p.y < 0 || p.x >= w || p.y >= h) continue;
        if (rows[p.y].charAt(p.x) !== target) continue;

        const row = rows[p.y];
        rows[p.y] = row.slice(0, p.x) + ch + row.slice(p.x + 1);
        changed.push({ x: p.x, y: p.y });

        stack.push({ x: p.x + 1, y: p.y });
        stack.push({ x: p.x - 1, y: p.y });
        stack.push({ x: p.x, y: p.y + 1 });
        stack.push({ x: p.x, y: p.y - 1 });
    }
    return changed;
}

/**
 * Fill axis-aligned rectangle (inclusive) with `ch`. Mutates `rows`.
 *
 * @param {string[]} rows
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {string} ch
 * @param {number} w
 * @param {number} h
 * @returns {{ x: number, y: number }[]}
 */
function rectFillFriction(rows, x0, y0, x1, y1, ch, w, h) {
    /** @type {{ x: number, y: number }[]} */
    const changed = [];
    if (ch !== '#' && ch !== '.') return changed;
    const minX = Math.max(0, Math.min(x0, x1));
    const maxX = Math.min(w - 1, Math.max(x0, x1));
    const minY = Math.max(0, Math.min(y0, y1));
    const maxY = Math.min(h - 1, Math.max(y0, y1));
    for (let y = minY; y <= maxY; y++) {
        let row = rows[y];
        let next = row;
        for (let x = minX; x <= maxX; x++) {
            if (next.charAt(x) === ch) continue;
            next = next.slice(0, x) + ch + next.slice(x + 1);
            changed.push({ x, y });
        }
        rows[y] = next;
    }
    return changed;
}

/**
 * @param {unknown} raw
 * @param {number} w
 * @param {number} h
 * @returns {string[]}
 */
function normalizeFrictionRows(raw, w, h) {
    /** @type {string[]} */
    let rows = [];
    if (Array.isArray(raw)) {
        rows = raw.map((r) => (typeof r === 'string' ? r : String(r || '')));
    } else if (typeof raw === 'string') {
        rows = raw
            .replace(/\r\n/g, '\n')
            .split(/[\n;]/)
            .filter((r) => r.length > 0);
    }
    /** @type {string[]} */
    const out = [];
    for (let y = 0; y < h; y++) {
        let row = rows[y] != null ? String(rows[y]) : '';
        if (row.length < w) row = row + '#'.repeat(w - row.length);
        if (row.length > w) row = row.slice(0, w);
        // Normalize non-blocked to '.' for paint UI (engine still accepts other chars via raw JSON).
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
 * @param {unknown} raw
 * @returns {{ N: boolean, S: boolean, E: boolean, W: boolean }}
 */
function normalizeExits(raw) {
    const ex = { N: false, S: false, E: false, W: false };
    if (!raw || typeof raw !== 'object') return ex;
    for (const d of ['N', 'S', 'E', 'W']) {
        const v = /** @type {Record<string, unknown>} */ (raw)[d];
        ex[d] = v === true || v === 1 || v === '1' || v === 'true';
    }
    return ex;
}

/**
 * @param {unknown} list
 * @returns {{ x: number, y: number, id?: string }[]}
 */
function normalizePoints(list) {
    if (!Array.isArray(list)) return [];
    /** @type {{ x: number, y: number, id?: string }[]} */
    const out = [];
    for (const p of list) {
        if (!p || typeof p !== 'object') continue;
        const x = Math.floor(Number(/** @type {{x?:unknown}} */ (p).x));
        const y = Math.floor(Number(/** @type {{y?:unknown}} */ (p).y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        /** @type {{ x: number, y: number, id?: string }} */
        const row = { x, y };
        const id = /** @type {{id?: unknown}} */ (p).id;
        if (id != null && String(id) !== '') row.id = String(id);
        out.push(row);
    }
    return out;
}

/**
 * Register custom editor once JSONEditor is on window.
 * Safe to call multiple times.
 */
function registerPieceGridEditor() {
    if (typeof window === 'undefined' || typeof window.JSONEditor !== 'function') {
        return false;
    }
    if (window.__DU_PIECE_GRID_REGISTERED__) return true;

    const JE = window.JSONEditor;
    const Abstract = JE.AbstractEditor;

    class DungeonPieceEditor extends Abstract {
        build() {
            this.header = this.label = this.theme.getFormInputLabel(this.getTitle());
            this.description = this.theme.getFormInputDescription(this.schema.description || '');
            this.container.appendChild(this.header);
            if (this.description) this.container.appendChild(this.description);

            this.root = document.createElement('div');
            this.root.className = 'du-piece-editor';
            this.container.appendChild(this.root);

            /** @type {'wall'|'floor'|'fill'|'rect'|'spawn'|'marker'|'waypoint'|'erase'} */
            this.tool = 'wall';
            /** Last wall/floor brush used by fill / rect tools ('#' or '.'). */
            /** @type {'#'|'.'} */
            this.brush = '#';
            /** @type {string} */
            this.markerId = 'A';

            /** Drag-paint / rect state (instance-level so cell updates do not reset it). */
            this._painting = false;
            this._lastPaintKey = '';
            /** @type {{ x: number, y: number }|null} */
            this._rectStart = null;
            /** @type {{ x: number, y: number }|null} */
            this._rectEnd = null;
            /** @type {((ev: MouseEvent) => void)|null} */
            this._onDocMouseUp = null;
            /** @type {((ev: MouseEvent) => void)|null} */
            this._onDocMouseMove = null;

            this.state = {
                id: 'piece',
                biome: '',
                size: { w: 5, h: 5 },
                exits: { N: false, S: false, E: false, W: false },
                friction: normalizeFrictionRows(null, 5, 5),
                sockets: { spawns: [], markers: [], waypoints: [], stairs: [] },
                tags: [],
                walkFriction: 100
            };

            this.renderShell();
            this.input = this.root; // json-editor focus target
        }

        renderShell() {
            this.root.innerHTML = '';

            // Meta row
            const meta = document.createElement('div');
            meta.className = 'du-piece-meta';
            meta.innerHTML =
                `<label class="du-piece-field">Id <input type="text" class="form-control form-control-sm font-monospace" data-field="id" maxlength="80" spellcheck="false"></label>` +
                `<label class="du-piece-field">Biome <input type="text" class="form-control form-control-sm" data-field="biome" spellcheck="false"></label>` +
                `<label class="du-piece-field">W <input type="number" class="form-control form-control-sm" data-field="w" min="1" max="${MAX_DIM}"></label>` +
                `<label class="du-piece-field">H <input type="number" class="form-control form-control-sm" data-field="h" min="1" max="${MAX_DIM}"></label>` +
                `<label class="du-piece-field du-piece-field--grow">Tags <input type="text" class="form-control form-control-sm" data-field="tags" placeholder="corridor, ns" spellcheck="false"></label>`;
            this.root.appendChild(meta);

            // Exits
            const exits = document.createElement('div');
            exits.className = 'du-piece-exits';
            exits.innerHTML =
                `<span class="du-piece-label">Exits</span>` +
                ['N', 'S', 'E', 'W']
                    .map(
                        (d) =>
                            `<label class="du-piece-exit"><input type="checkbox" data-exit="${d}"> ${d}</label>`
                    )
                    .join('');
            this.root.appendChild(exits);

            // Tools
            const tools = document.createElement('div');
            tools.className = 'du-piece-tools';
            const toolDefs = [
                { id: 'wall', label: 'Wall #', title: 'Paint blocked (drag). Shift+click flood fills.' },
                { id: 'floor', label: 'Floor .', title: 'Paint walkable (drag). Shift+click flood fills.' },
                { id: 'fill', label: 'Flood', title: 'Flood fill with last Wall/Floor brush' },
                { id: 'rect', label: 'Rect', title: 'Drag a rectangle filled with last Wall/Floor brush' },
                { id: 'spawn', label: 'Spawn', title: 'Place spawn socket' },
                { id: 'marker', label: 'Marker', title: 'Place marker socket' },
                { id: 'waypoint', label: 'Waypoint', title: 'Place waypoint socket' },
                { id: 'erase', label: 'Erase sock', title: 'Remove sockets on cell' }
            ];
            tools.innerHTML =
                `<span class="du-piece-label">Paint</span>` +
                toolDefs
                    .map(
                        (t) =>
                            `<button type="button" class="btn btn-sm btn-retro btn-secondary du-piece-tool" data-tool="${t.id}" title="${t.title}">${t.label}</button>`
                    )
                    .join('') +
                `<label class="du-piece-field du-piece-marker-id">Marker id <input type="text" class="form-control form-control-sm font-monospace" data-field="markerId" value="A" maxlength="8" spellcheck="false"></label>`;
            this.root.appendChild(tools);

            // Grid
            this.gridWrap = document.createElement('div');
            this.gridWrap.className = 'du-piece-grid-wrap';
            this.root.appendChild(this.gridWrap);

            this.hint = document.createElement('p');
            this.hint.className = 'du-piece-hint small text-muted mb-0';
            this.hint.textContent =
                'Wall/Floor: click or drag to paint; Shift+click flood fills. Flood uses last brush. Rect: drag a box. Sockets only on walkable (.) cells.';
            this.root.appendChild(this.hint);

            this.bindShellEvents();
            this.syncFormFromState();
            this.renderGrid();
        }

        bindShellEvents() {
            this.root.querySelectorAll('[data-field]').forEach((el) => {
                const input = /** @type {HTMLInputElement} */ (el);
                const field = input.getAttribute('data-field');
                const handler = () => {
                    if (field === 'id') {
                        this.state.id = input.value.trim().toLowerCase() || 'piece';
                    } else if (field === 'biome') {
                        this.state.biome = input.value.trim();
                    } else if (field === 'tags') {
                        this.state.tags = input.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean);
                    } else if (field === 'w' || field === 'h') {
                        const w =
                            field === 'w'
                                ? clampDim(input.value, this.state.size.w)
                                : this.state.size.w;
                        const h =
                            field === 'h'
                                ? clampDim(input.value, this.state.size.h)
                                : this.state.size.h;
                        this.resize(w, h);
                    } else if (field === 'markerId') {
                        this.markerId = (input.value.trim() || 'A').slice(0, 8);
                    }
                    this.onChange(true);
                };
                input.addEventListener('change', handler);
                input.addEventListener('input', () => {
                    if (field === 'id' || field === 'biome' || field === 'tags' || field === 'markerId') {
                        handler();
                    }
                });
            });

            this.root.querySelectorAll('[data-exit]').forEach((el) => {
                el.addEventListener('change', () => {
                    const d = /** @type {HTMLInputElement} */ (el).getAttribute('data-exit');
                    if (!d) return;
                    this.state.exits[d] = /** @type {HTMLInputElement} */ (el).checked;
                    this.onChange(true);
                });
            });

            this.root.querySelectorAll('[data-tool]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const t = btn.getAttribute('data-tool');
                    if (!t) return;
                    // While Flood/Rect is active, Wall/Floor only switch the fill brush
                    // (stay on the current tool so the brush stays visible as the "ink").
                    if (
                        (this.tool === 'fill' || this.tool === 'rect') &&
                        (t === 'wall' || t === 'floor')
                    ) {
                        this.brush = t === 'wall' ? '#' : '.';
                        this.syncToolButtons();
                        this.updateHint();
                        return;
                    }
                    this.tool = /** @type {typeof this.tool} */ (t);
                    if (t === 'wall') this.brush = '#';
                    if (t === 'floor') this.brush = '.';
                    this.syncToolButtons();
                    this.updateHint();
                });
            });
            this.syncToolButtons();
        }

        /**
         * Highlight the active tool; when Flood/Rect is selected also mark
         * Wall or Floor so the current fill brush is obvious.
         */
        syncToolButtons() {
            if (!this.root) return;
            const brushTool = this.brush === '.' ? 'floor' : 'wall';
            const showBrush =
                this.tool === 'fill' || this.tool === 'rect' || this.tool === 'wall' || this.tool === 'floor';
            this.root.querySelectorAll('[data-tool]').forEach((b) => {
                const id = b.getAttribute('data-tool');
                b.classList.toggle('is-active', id === this.tool);
                b.classList.toggle('is-brush', showBrush && id === brushTool && id !== this.tool);
            });
        }

        updateHint() {
            if (!this.hint) return;
            const brushLabel = this.brush === '#' ? 'Wall #' : 'Floor .';
            if (this.tool === 'fill') {
                this.hint.textContent = `Flood fill with ${brushLabel}. Click Wall/Floor to change brush (stays on Flood). Click a cell to fill its region.`;
            } else if (this.tool === 'rect') {
                this.hint.textContent = `Rect fill with ${brushLabel}: drag a box. Click Wall/Floor to change brush (stays on Rect).`;
            } else if (this.tool === 'wall' || this.tool === 'floor') {
                this.hint.textContent =
                    'Click or drag to paint. Shift+click flood fills with this brush. Sockets only stick on walkable (.) cells.';
            } else {
                this.hint.textContent =
                    'Click a cell for sockets / erase. Sockets only stick on walkable (.) cells. Exits mark stitch edges.';
            }
        }

        syncFormFromState() {
            const idEl = /** @type {HTMLInputElement|null} */ (
                this.root.querySelector('[data-field="id"]')
            );
            const biomeEl = /** @type {HTMLInputElement|null} */ (
                this.root.querySelector('[data-field="biome"]')
            );
            const wEl = /** @type {HTMLInputElement|null} */ (
                this.root.querySelector('[data-field="w"]')
            );
            const hEl = /** @type {HTMLInputElement|null} */ (
                this.root.querySelector('[data-field="h"]')
            );
            const tagsEl = /** @type {HTMLInputElement|null} */ (
                this.root.querySelector('[data-field="tags"]')
            );
            if (idEl) idEl.value = this.state.id || '';
            if (biomeEl) biomeEl.value = this.state.biome || '';
            if (wEl) wEl.value = String(this.state.size.w);
            if (hEl) hEl.value = String(this.state.size.h);
            if (tagsEl) tagsEl.value = (this.state.tags || []).join(', ');
            for (const d of ['N', 'S', 'E', 'W']) {
                const cb = /** @type {HTMLInputElement|null} */ (
                    this.root.querySelector(`[data-exit="${d}"]`)
                );
                if (cb) cb.checked = !!this.state.exits[d];
            }
        }

        /**
         * @param {number} w
         * @param {number} h
         */
        resize(w, h) {
            w = clampDim(w, 5);
            h = clampDim(h, 5);
            const old = this.state.friction;
            /** @type {string[]} */
            const next = [];
            for (let y = 0; y < h; y++) {
                let row = '';
                for (let x = 0; x < w; x++) {
                    if (y < old.length && x < old[y].length) {
                        row += old[y].charAt(x);
                    } else {
                        row += '#';
                    }
                }
                next.push(row);
            }
            this.state.size = { w, h };
            this.state.friction = next;
            // Drop sockets outside bounds
            const clip = (list) =>
                (list || []).filter((p) => p.x >= 0 && p.y >= 0 && p.x < w && p.y < h);
            this.state.sockets.spawns = clip(this.state.sockets.spawns);
            this.state.sockets.markers = clip(this.state.sockets.markers);
            this.state.sockets.waypoints = clip(this.state.sockets.waypoints);
            this.state.sockets.stairs = clip(this.state.sockets.stairs || []);
            this.syncFormFromState();
            this.renderGrid();
        }

        /**
         * @returns {Map<string, string>}
         */
        buildSocketMap() {
            /** @type {Map<string, string>} */
            const sockMap = new Map();
            const mark = (list, kind) => {
                for (const p of list || []) {
                    const key = `${p.x},${p.y}`;
                    const label =
                        kind === 'marker' && p.id
                            ? `M:${p.id}`
                            : kind === 'spawn'
                              ? 'S'
                              : kind === 'waypoint'
                                ? 'W'
                                : kind === 'stair'
                                  ? '↑'
                                  : '?';
                    const prev = sockMap.get(key);
                    sockMap.set(key, prev ? prev + ' ' + label : label);
                }
            };
            mark(this.state.sockets.spawns, 'spawn');
            mark(this.state.sockets.markers, 'marker');
            mark(this.state.sockets.waypoints, 'waypoint');
            mark(this.state.sockets.stairs, 'stair');
            return sockMap;
        }

        /**
         * Update one cell's classes / socket label without rebuilding the grid
         * (keeps drag-paint listeners and painting state alive).
         *
         * @param {number} x
         * @param {number} y
         * @param {Map<string, string>} [sockMap]
         */
        refreshCell(x, y, sockMap) {
            if (!this.gridWrap) return;
            const cell = /** @type {HTMLElement|null} */ (
                this.gridWrap.querySelector(`[data-x="${x}"][data-y="${y}"]`)
            );
            if (!cell) return;
            const map = sockMap || this.buildSocketMap();
            const ch = this.state.friction[y].charAt(x);
            const blocked = ch === '#';
            cell.classList.toggle('is-wall', blocked);
            cell.classList.toggle('is-floor', !blocked);
            cell.classList.remove('is-rect-preview');
            const sock = map.get(`${x},${y}`);
            if (sock) {
                cell.classList.add('has-socket');
                cell.dataset.socket = sock;
                cell.textContent = sock.length > 3 ? sock.slice(0, 3) : sock;
            } else {
                cell.classList.remove('has-socket');
                delete cell.dataset.socket;
                cell.textContent = '';
            }
            cell.title = `(${x},${y}) ${blocked ? 'wall' : 'floor'}${sock ? ' · ' + sock : ''}`;
        }

        /**
         * @param {{ x: number, y: number }[]} cells
         */
        refreshCells(cells) {
            const map = this.buildSocketMap();
            for (const p of cells) this.refreshCell(p.x, p.y, map);
        }

        clearRectPreview() {
            if (!this.gridWrap) return;
            this.gridWrap.querySelectorAll('.is-rect-preview').forEach((el) => {
                el.classList.remove('is-rect-preview');
            });
        }

        /**
         * Highlight the drag rectangle while the mouse is down (rect tool).
         *
         * @param {number} x0
         * @param {number} y0
         * @param {number} x1
         * @param {number} y1
         */
        showRectPreview(x0, y0, x1, y1) {
            if (!this.gridWrap) return;
            this.clearRectPreview();
            const w = this.state.size.w;
            const h = this.state.size.h;
            const minX = Math.max(0, Math.min(x0, x1));
            const maxX = Math.min(w - 1, Math.max(x0, x1));
            const minY = Math.max(0, Math.min(y0, y1));
            const maxY = Math.min(h - 1, Math.max(y0, y1));
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const cell = this.gridWrap.querySelector(
                        `[data-x="${x}"][data-y="${y}"]`
                    );
                    if (cell) cell.classList.add('is-rect-preview');
                }
            }
        }

        /**
         * Detach document-level drag listeners.
         */
        unbindDocPaint() {
            if (this._onDocMouseUp) {
                document.removeEventListener('mouseup', this._onDocMouseUp);
                this._onDocMouseUp = null;
            }
            if (this._onDocMouseMove) {
                document.removeEventListener('mousemove', this._onDocMouseMove);
                this._onDocMouseMove = null;
            }
        }

        endPaintStroke() {
            if (this._painting && this.tool === 'rect' && this._rectStart && this._rectEnd) {
                const ch = this.brush;
                const w = this.state.size.w;
                const h = this.state.size.h;
                const changed = rectFillFriction(
                    this.state.friction,
                    this._rectStart.x,
                    this._rectStart.y,
                    this._rectEnd.x,
                    this._rectEnd.y,
                    ch,
                    w,
                    h
                );
                if (ch === '#') {
                    for (const p of changed) this.clearSocketsAt(p.x, p.y);
                }
                this.clearRectPreview();
                if (changed.length) {
                    this.refreshCells(changed);
                    this.onChange(true);
                }
            }
            this._painting = false;
            this._lastPaintKey = '';
            this._rectStart = null;
            this._rectEnd = null;
            this.unbindDocPaint();
        }

        /**
         * @param {number} x
         * @param {number} y
         * @param {{ flood?: boolean, skipDedupe?: boolean }} [opts]
         */
        applyCell(x, y, opts) {
            const w = this.state.size.w;
            const h = this.state.size.h;
            if (x < 0 || y < 0 || x >= w || y >= h) return;

            const flood = !!(opts && opts.flood);
            const skipDedupe = !!(opts && opts.skipDedupe);
            const key = `${x},${y}:${this.tool}:${flood ? 'f' : 'p'}`;
            if (!skipDedupe && this._painting && key === this._lastPaintKey && !flood) {
                return;
            }
            this._lastPaintKey = key;

            const tool = this.tool;

            if (tool === 'fill' || ((tool === 'wall' || tool === 'floor') && flood)) {
                const ch =
                    tool === 'fill' ? this.brush : tool === 'wall' ? '#' : '.';
                if (tool === 'wall') this.brush = '#';
                if (tool === 'floor') this.brush = '.';
                const changed = floodFillFriction(this.state.friction, x, y, ch, w, h);
                if (ch === '#') {
                    for (const p of changed) this.clearSocketsAt(p.x, p.y);
                }
                if (changed.length) {
                    // Many cells: full rebuild keeps sockets/labels accurate.
                    this.renderGrid();
                    this.onChange(true);
                }
                return;
            }

            if (tool === 'rect') {
                // Preview only while dragging; commit on mouseup in endPaintStroke.
                if (!this._rectStart) this._rectStart = { x, y };
                this._rectEnd = { x, y };
                this.showRectPreview(
                    this._rectStart.x,
                    this._rectStart.y,
                    this._rectEnd.x,
                    this._rectEnd.y
                );
                return;
            }

            if (tool === 'wall' || tool === 'floor') {
                const ch = tool === 'wall' ? '#' : '.';
                this.brush = ch;
                const row = this.state.friction[y];
                if (row.charAt(x) === ch) {
                    return;
                }
                this.state.friction[y] = row.slice(0, x) + ch + row.slice(x + 1);
                if (ch === '#') this.clearSocketsAt(x, y);
                this.refreshCell(x, y);
                this.onChange(true);
                return;
            }

            if (tool === 'erase') {
                this.clearSocketsAt(x, y);
                this.refreshCell(x, y);
                this.onChange(true);
                return;
            }

            // Socket tools require walkable
            if (this.state.friction[y].charAt(x) === '#') return;
            this.clearSocketsAt(x, y);
            if (tool === 'spawn') {
                this.state.sockets.spawns.push({ x, y });
            } else if (tool === 'marker') {
                this.state.sockets.markers.push({
                    x,
                    y,
                    id: this.markerId || 'A'
                });
            } else if (tool === 'waypoint') {
                this.state.sockets.waypoints.push({ x, y });
            }
            this.refreshCell(x, y);
            this.onChange(true);
        }

        /**
         * @param {MouseEvent} ev
         * @returns {{ x: number, y: number }|null}
         */
        cellFromEvent(ev) {
            const el = document.elementFromPoint(ev.clientX, ev.clientY);
            if (!el || !this.gridWrap || !this.gridWrap.contains(el)) return null;
            const cell = /** @type {HTMLElement|null} */ (
                el.closest ? el.closest('.du-piece-cell') : null
            );
            if (!cell || !this.gridWrap.contains(cell)) return null;
            const x = Math.floor(Number(cell.getAttribute('data-x')));
            const y = Math.floor(Number(cell.getAttribute('data-y')));
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            return { x, y };
        }

        /**
         * @param {HTMLElement} table
         */
        bindGridPointerHandlers(table) {
            table.addEventListener('mousedown', (ev) => {
                if (ev.button !== 0) return;
                const target = /** @type {HTMLElement} */ (ev.target);
                const cell = /** @type {HTMLElement|null} */ (
                    target.closest ? target.closest('.du-piece-cell') : null
                );
                if (!cell) return;
                ev.preventDefault();

                const x = Math.floor(Number(cell.getAttribute('data-x')));
                const y = Math.floor(Number(cell.getAttribute('data-y')));
                if (!Number.isFinite(x) || !Number.isFinite(y)) return;

                const flood = ev.shiftKey && (this.tool === 'wall' || this.tool === 'floor');
                // Flood is a single action (no drag).
                if (flood || this.tool === 'fill') {
                    this.applyCell(x, y, { flood: true, skipDedupe: true });
                    return;
                }

                // Socket / erase: single click only
                if (
                    this.tool === 'spawn' ||
                    this.tool === 'marker' ||
                    this.tool === 'waypoint' ||
                    this.tool === 'erase'
                ) {
                    this.applyCell(x, y, { skipDedupe: true });
                    return;
                }

                this._painting = true;
                this._lastPaintKey = '';
                this._rectStart = this.tool === 'rect' ? { x, y } : null;
                this._rectEnd = this.tool === 'rect' ? { x, y } : null;
                this.applyCell(x, y, { skipDedupe: true });

                this.unbindDocPaint();
                this._onDocMouseMove = (moveEv) => {
                    if (!this._painting) return;
                    const pt = this.cellFromEvent(moveEv);
                    if (!pt) return;
                    this.applyCell(pt.x, pt.y);
                };
                this._onDocMouseUp = () => {
                    this.endPaintStroke();
                };
                document.addEventListener('mousemove', this._onDocMouseMove);
                document.addEventListener('mouseup', this._onDocMouseUp);
            });

            // Prevent HTML5 drag of buttons from cancelling paint mid-stroke.
            table.addEventListener('dragstart', (ev) => ev.preventDefault());
        }

        renderGrid() {
            if (!this.gridWrap) return;
            // Do not tear down mid-stroke (e.g. external setValue); end stroke cleanly.
            if (this._painting) this.endPaintStroke();

            const w = this.state.size.w;
            const h = this.state.size.h;
            const table = document.createElement('div');
            table.className = 'du-piece-grid';
            table.style.gridTemplateColumns = `repeat(${w}, var(--du-cell, 22px))`;
            table.setAttribute('role', 'grid');
            table.setAttribute('aria-label', 'Friction grid');

            const sockMap = this.buildSocketMap();

            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const cell = document.createElement('button');
                    cell.type = 'button';
                    cell.className = 'du-piece-cell';
                    const ch = this.state.friction[y].charAt(x);
                    const blocked = ch === '#';
                    cell.classList.toggle('is-wall', blocked);
                    cell.classList.toggle('is-floor', !blocked);
                    const sock = sockMap.get(`${x},${y}`);
                    if (sock) {
                        cell.classList.add('has-socket');
                        cell.dataset.socket = sock;
                        cell.textContent = sock.length > 3 ? sock.slice(0, 3) : sock;
                    } else {
                        cell.textContent = '';
                    }
                    cell.title = `(${x},${y}) ${blocked ? 'wall' : 'floor'}${sock ? ' · ' + sock : ''}`;
                    cell.setAttribute('data-x', String(x));
                    cell.setAttribute('data-y', String(y));
                    table.appendChild(cell);
                }
            }

            this.bindGridPointerHandlers(table);

            this.gridWrap.innerHTML = '';
            this.gridWrap.appendChild(table);
        }

        /**
         * @param {number} x
         * @param {number} y
         */
        clearSocketsAt(x, y) {
            const drop = (list) => (list || []).filter((p) => !(p.x === x && p.y === y));
            this.state.sockets.spawns = drop(this.state.sockets.spawns);
            this.state.sockets.markers = drop(this.state.sockets.markers);
            this.state.sockets.waypoints = drop(this.state.sockets.waypoints);
            this.state.sockets.stairs = drop(this.state.sockets.stairs || []);
        }

        /**
         * @param {unknown} value
         * @param {boolean} [initial]
         */
        setValue(value, initial) {
            const v = value && typeof value === 'object' ? value : {};
            const size = /** @type {{w?:unknown,h?:unknown}} */ (v.size || {});
            const w = clampDim(size.w != null ? size.w : v.w, 5);
            const h = clampDim(size.h != null ? size.h : v.h, 5);
            const socks =
                v.sockets && typeof v.sockets === 'object' ? v.sockets : {};
            this.state = {
                id: v.id != null ? String(v.id) : 'piece',
                biome: v.biome != null ? String(v.biome) : '',
                size: { w, h },
                exits: normalizeExits(v.exits),
                friction: normalizeFrictionRows(v.friction, w, h),
                sockets: {
                    spawns: normalizePoints(socks.spawns),
                    markers: normalizePoints(socks.markers),
                    waypoints: normalizePoints(socks.waypoints),
                    stairs: normalizePoints(socks.stairs)
                },
                tags: Array.isArray(v.tags)
                    ? v.tags.map((t) => String(t)).filter(Boolean)
                    : [],
                walkFriction:
                    v.walkFriction != null && Number.isFinite(Number(v.walkFriction))
                        ? Math.max(0, Math.min(254, Math.floor(Number(v.walkFriction))))
                        : 100
            };
            if (this.root) {
                this.syncFormFromState();
                this.renderGrid();
            }
            this.onChange(!initial);
        }

        getValue() {
            const s = this.state;
            /** @type {Record<string, unknown>} */
            const out = {
                id: s.id,
                size: { w: s.size.w, h: s.size.h },
                exits: {
                    N: !!s.exits.N,
                    S: !!s.exits.S,
                    E: !!s.exits.E,
                    W: !!s.exits.W
                },
                friction: s.friction.slice(),
                sockets: {
                    spawns: (s.sockets.spawns || []).map((p) => ({ x: p.x, y: p.y })),
                    markers: (s.sockets.markers || []).map((p) => {
                        /** @type {{x:number,y:number,id?:string}} */
                        const m = { x: p.x, y: p.y };
                        if (p.id) m.id = p.id;
                        return m;
                    }),
                    waypoints: (s.sockets.waypoints || []).map((p) => ({
                        x: p.x,
                        y: p.y
                    }))
                },
                tags: (s.tags || []).slice()
            };
            if (s.biome) out.biome = s.biome;
            if (s.sockets.stairs && s.sockets.stairs.length) {
                /** @type {Record<string, unknown>} */ (out.sockets).stairs =
                    s.sockets.stairs.map((p) => {
                        /** @type {{x:number,y:number,id?:string}} */
                        const st = { x: p.x, y: p.y };
                        if (p.id) st.id = p.id;
                        return st;
                    });
            }
            if (s.walkFriction != null && s.walkFriction !== 100) {
                out.walkFriction = s.walkFriction;
            }
            return out;
        }

        destroy() {
            this.endPaintStroke();
            if (this.root) {
                this.root.innerHTML = '';
                this.root = null;
            }
            super.destroy();
        }
    }

    JE.defaults.editors.dungeon_piece = DungeonPieceEditor;
    JE.defaults.resolvers.unshift((schema) => {
        if (schema && schema.format === 'dungeon_piece') {
            return 'dungeon_piece';
        }
    });

    window.__DU_PIECE_GRID_REGISTERED__ = true;
    return true;
}

module.exports = {
    registerPieceGridEditor,
    normalizeFrictionRows,
    normalizeExits,
    clampDim,
    floodFillFriction,
    rectFillFriction
};
