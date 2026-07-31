/**
 * json-editor custom editor: visual dungeon profile (procedural rules + fixed map).
 * Format: "dungeon_profile" — replaces the raw object form for dungeons/*.json.
 */

'use strict';

const RULE_OPS = [
    { id: 'AddHub', label: 'Hub', hint: 'Start piece (usually 1 hub)' },
    { id: 'AddRoom', label: 'Room', hint: 'Grow rooms from open exits' },
    { id: 'AddCorridor', label: 'Corridor', hint: 'Optional connectors' },
    { id: 'AddExit', label: 'Exit', hint: 'Stamp exit / dead-end' },
    { id: 'SelectEvent', label: 'Event', hint: 'Tag rooms with events' }
];

const TAG_CHIPS = ['hub', 'room', 'corridor', 'deadend', 'exit', 'ns', 'ew'];

const CELL_PX = 14;
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
 * @returns {[number, number]}
 */
function pairCount(raw) {
    if (Array.isArray(raw) && raw.length >= 1) {
        const lo = toInt(raw[0], 1);
        const hi = raw.length >= 2 ? toInt(raw[1], lo) : lo;
        return lo <= hi ? [lo, hi] : [hi, lo];
    }
    if (raw && typeof raw === 'object') {
        const o = /** @type {{min?:unknown,max?:unknown}} */ (raw);
        const lo = toInt(o.min, 1);
        const hi = o.max != null ? toInt(o.max, lo) : lo;
        return lo <= hi ? [lo, hi] : [hi, lo];
    }
    if (raw != null && raw !== '') {
        const n = toInt(raw, 1);
        return [n, n];
    }
    return [1, 1];
}

/**
 * @param {unknown} raw
 * @returns {object}
 */
function normalizeRuleRow(raw) {
    const r = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
    let op = r.op != null ? String(r.op) : r.type != null ? String(r.type) : 'AddRoom';
    const lower = op.toLowerCase().replace(/[_\s-]/g, '');
    if (lower === 'hub' || lower === 'addhub') op = 'AddHub';
    else if (lower === 'room' || lower === 'addroom') op = 'AddRoom';
    else if (lower === 'corridor' || lower === 'addcorridor') op = 'AddCorridor';
    else if (lower === 'exit' || lower === 'addexit') op = 'AddExit';
    else if (lower === 'event' || lower === 'selectevent' || lower === 'selectevents') {
        op = 'SelectEvent';
    } else if (!RULE_OPS.some((x) => x.id === op)) {
        op = 'AddRoom';
    }
    const tags = Array.isArray(r.tags)
        ? r.tags.map((t) => String(t)).filter(Boolean)
        : r.tag != null
          ? [String(r.tag)]
          : [];
    const events = Array.isArray(r.events)
        ? r.events.map((e) => String(e)).filter(Boolean)
        : r.event != null
          ? [String(r.event)]
          : [];
    const count = pairCount(r.count != null ? r.count : r.n);
    return { op, tags, count, events };
}

/**
 * @param {unknown} raw
 * @returns {{pieceId:string,x:number,y:number}[]}
 */
function normalizePlacements(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{pieceId:string,x:number,y:number}[]} */
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
 * @returns {{x:number,y:number}|null}
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
 * @returns {{x:number,y:number}[]}
 */
function normalizeWaypoints(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {{x:number,y:number}[]} */
    const out = [];
    for (const p of raw) {
        const pt = normalizePoint(p);
        if (pt) out.push(pt);
    }
    return out;
}

/**
 * @param {unknown} raw
 * @returns {object[]}
 */
function normalizeCutouts(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {object[]} */
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!c || typeof c !== 'object') continue;
        const o = /** @type {Record<string, unknown>} */ (c);
        const bboxRaw =
            o.bbox && typeof o.bbox === 'object'
                ? /** @type {Record<string, unknown>} */ (o.bbox)
                : o;
        const x = toInt(bboxRaw.x, 0);
        const y = toInt(bboxRaw.y, 0);
        const w = Math.max(
            1,
            toInt(bboxRaw.w != null ? bboxRaw.w : bboxRaw.width, 1)
        );
        const h = Math.max(
            1,
            toInt(bboxRaw.h != null ? bboxRaw.h : bboxRaw.height, 1)
        );
        const events = Array.isArray(o.events)
            ? o.events.map((e) => String(e)).filter(Boolean)
            : [];
        const maxPacks = pairCount(o.maxPacks != null ? o.maxPacks : [1, 3]);
        out.push({
            id: o.id != null ? String(o.id) : `cutout_${i}`,
            bbox: { x, y, w, h },
            events,
            maxPacks,
            useSockets: o.useSockets !== false
        });
    }
    return out;
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
 * @returns {{id:string,w:number,h:number,friction:string[],tags:string[],exits:object}|null}
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
        friction: frictionRows(p.friction, w, h),
        tags: Array.isArray(p.tags) ? p.tags.map((t) => String(t)) : [],
        exits:
            p.exits && typeof p.exits === 'object'
                ? p.exits
                : { N: false, S: false, E: false, W: false }
    };
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
 * Current designer mode from the page select (fallback standard).
 * @returns {string}
 */
function currentMode() {
    const el = document.getElementById('duModeSelect');
    if (el && /** @type {HTMLSelectElement} */ (el).value) {
        return String(/** @type {HTMLSelectElement} */ (el).value);
    }
    if (typeof window !== 'undefined' && window.__CONTENT_MODE__) {
        return String(window.__CONTENT_MODE__);
    }
    return 'standard';
}

/**
 * Default pacing shell (matches product micro budgets).
 * @param {string} id
 * @returns {object}
 */
function defaultPacing(id) {
    return {
        id: (id || 'profile') + '_micro',
        micro: {
            targetGapSec: 20,
            minGapSec: 0,
            warnGapSec: 90,
            maxGapSec: 180
        },
        mid: {
            minKills: 0,
            maxKills: 40,
            minChampions: 0,
            maxChampions: 12
        },
        session: {
            minTimeSec: 0,
            maxTimeSec: 300,
            minKillsPerMin: 0,
            maxKillsPerMin: 120
        }
    };
}

/**
 * Procedural starter rules (same shape as small_crawl).
 * @returns {object[]}
 */
function starterRules() {
    return [
        { op: 'AddHub', tags: ['hub'], count: [1, 1], events: [] },
        { op: 'AddRoom', tags: ['room'], count: [2, 4], events: [] },
        { op: 'AddCorridor', tags: ['corridor'], count: [1, 3], events: [] },
        { op: 'AddExit', tags: [], count: [1, 1], events: [] },
        {
            op: 'SelectEvent',
            tags: [],
            count: [1, 2],
            events: ['champion_room', 'rest_well']
        }
    ];
}

/**
 * Register custom editor once JSONEditor is on window.
 * @returns {boolean}
 */
function registerDungeonProfileEditor() {
    if (typeof window === 'undefined' || typeof window.JSONEditor !== 'function') {
        return false;
    }
    if (window.__DU_DUNGEON_PROFILE_REGISTERED__) return true;

    const JE = window.JSONEditor;
    const Abstract = JE.AbstractEditor;

    class DungeonProfileEditor extends Abstract {
        build() {
            this.header = this.label = this.theme.getFormInputLabel(this.getTitle());
            this.description = this.theme.getFormInputDescription(
                this.schema.description ||
                    'Visual editor for procedural rules and fixed piece layouts.'
            );
            this.container.appendChild(this.header);
            if (this.description) this.container.appendChild(this.description);

            this.root = document.createElement('div');
            this.root.className = 'du-dungeon-editor';
            this.container.appendChild(this.root);

            /** @type {Record<string, unknown>} */
            this.extra = {};
            /** @type {Map<string, ReturnType<typeof normalizePieceLite>>} */
            this.pieceIndex = new Map();
            /** @type {string[]} */
            this.pieceIds = [];
            /** @type {string[]} */
            this.packIds = [];
            /** @type {string[]} */
            this.populationIds = [];
            /** @type {string[]} */
            this.markerIds = [];
            /** @type {string|null} */
            this.loadedPackId = null;
            this.packLoadToken = 0;

            /** @type {'select'|'place'|'entrance'|'exit'|'waypoint'|'cutout'|'erase-wp'} */
            this.fixedTool = 'select';
            /** @type {number} */
            this.selectedPlacement = -1;
            /** @type {number} */
            this.selectedCutout = -1;
            /** @type {string} */
            this.placePieceId = '';
            this._drag = null;
            this._cutDrag = null;

            this.state = this.blankState('new_item');
            /** @type {{minX:number,minY:number}|null} */
            this._mapOrigin = null;
            this._onDocMouseMove = (ev) => this.onDocMapMove(ev);
            this._onDocMouseUp = () => this.finishMapPointer();
            document.addEventListener('mousemove', this._onDocMouseMove);
            document.addEventListener('mouseup', this._onDocMouseUp);
            this.renderShell();
            this.input = this.root;
            void this.loadRelationIds();
        }

        /**
         * @param {MouseEvent} ev
         * @returns {{wx:number,wy:number}|null}
         */
        worldFromClient(ev) {
            const wrap = this.root && this.root.querySelector('[data-role="map-wrap"]');
            const table = wrap && wrap.querySelector('.du-dungeon-map');
            if (!table || !this._mapOrigin) return null;
            const rect = table.getBoundingClientRect();
            if (
                ev.clientX < rect.left ||
                ev.clientY < rect.top ||
                ev.clientX >= rect.right ||
                ev.clientY >= rect.bottom
            ) {
                // Still allow drag outside map bounds (clamp to last valid via cell size)
            }
            const cx = Math.floor((ev.clientX - rect.left) / CELL_PX);
            const cy = Math.floor((ev.clientY - rect.top) / CELL_PX);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
            return {
                wx: cx + this._mapOrigin.minX,
                wy: cy + this._mapOrigin.minY
            };
        }

        /**
         * @param {MouseEvent} ev
         */
        onDocMapMove(ev) {
            if (!this._drag && !this._cutDrag) return;
            const pt = this.worldFromClient(ev);
            if (!pt) return;
            if (this._drag) {
                const pl = this.state.placements[this._drag.idx];
                if (!pl) return;
                const nx = pt.wx - this._drag.ox;
                const ny = pt.wy - this._drag.oy;
                if (pl.x !== nx || pl.y !== ny) {
                    pl.x = nx;
                    pl.y = ny;
                    this.renderMap();
                    this.onChange(true);
                }
            } else if (this._cutDrag) {
                this._cutDrag.x1 = pt.wx;
                this._cutDrag.y1 = pt.wy;
            }
        }

        /**
         * End map drag / cutout rectangle.
         */
        finishMapPointer() {
            if (this._cutDrag) {
                const d = this._cutDrag;
                this._cutDrag = null;
                const x = Math.min(d.x0, d.x1);
                const y = Math.min(d.y0, d.y1);
                const w = Math.abs(d.x1 - d.x0) + 1;
                const h = Math.abs(d.y1 - d.y0) + 1;
                if (w >= 1 && h >= 1) {
                    this.state.cutouts.push({
                        id: `cutout_${this.state.cutouts.length + 1}`,
                        bbox: { x, y, w, h },
                        events: [],
                        maxPacks: [1, 3],
                        useSockets: true
                    });
                    this.selectedCutout = this.state.cutouts.length - 1;
                    this.renderCutoutList();
                    this.renderMap();
                    this.onChange(true);
                }
            }
            if (this._drag) {
                this._drag = null;
                this.renderPlaceList();
            }
        }

        /**
         * @param {string} id
         */
        blankState(id) {
            return {
                id: id || 'new_item',
                label: '',
                type: 'procedural',
                biome: 'cave',
                seeded: true,
                notes: '',
                piecePack: 'cave_v1',
                populationId: 'cave_rats',
                markersId: 'cave_clickies',
                floor: 0,
                maxAttempts: 40,
                maxPieces: 28,
                capOpenExits: true,
                connectorTags: ['corridor'],
                rules: starterRules(),
                placements: /** @type {{pieceId:string,x:number,y:number}[]} */ ([]),
                entrance: /** @type {{x:number,y:number}|null} */ (null),
                exit: /** @type {{x:number,y:number}|null} */ (null),
                waypoints: /** @type {{x:number,y:number}[]} */ ([]),
                cutouts: /** @type {object[]} */ ([]),
                pacingBudget: defaultPacing(id || 'new_item')
            };
        }

        renderShell() {
            this.root.innerHTML = '';

            // ── Identity ─────────────────────────────────────────────
            const identity = document.createElement('section');
            identity.className = 'du-dungeon-section';
            identity.innerHTML =
                `<div class="du-dungeon-section-title">Profile</div>` +
                `<div class="du-dungeon-row">` +
                `<label class="du-dungeon-field">Label<input type="text" class="form-control form-control-sm" data-f="label" maxlength="120"></label>` +
                `<label class="du-dungeon-field">Biome<input type="text" class="form-control form-control-sm" data-f="biome" spellcheck="false"></label>` +
                `<label class="du-dungeon-field">Floor<input type="number" class="form-control form-control-sm" data-f="floor" min="0" step="1"></label>` +
                `<label class="du-dungeon-check"><input type="checkbox" data-f="seeded"> Seeded</label>` +
                `</div>` +
                `<div class="du-dungeon-row">` +
                `<label class="du-dungeon-field du-dungeon-field--grow">Notes<textarea class="form-control form-control-sm" data-f="notes" rows="2" maxlength="4000"></textarea></label>` +
                `</div>` +
                `<div class="du-dungeon-type-toggle" role="group" aria-label="Dungeon type">` +
                `<button type="button" class="btn btn-sm btn-retro btn-secondary du-dungeon-type-btn" data-type="procedural">Procedural</button>` +
                `<button type="button" class="btn btn-sm btn-retro btn-secondary du-dungeon-type-btn" data-type="fixed">Fixed</button>` +
                `</div>`;
            this.root.appendChild(identity);

            // ── Relations ────────────────────────────────────────────
            const rel = document.createElement('section');
            rel.className = 'du-dungeon-section';
            rel.innerHTML =
                `<div class="du-dungeon-section-title">Packs &amp; tables</div>` +
                `<div class="du-dungeon-row">` +
                `<label class="du-dungeon-field">Piece pack<select class="form-select form-select-sm" data-f="piecePack"></select></label>` +
                `<label class="du-dungeon-field">Population<select class="form-select form-select-sm" data-f="populationId"></select></label>` +
                `<label class="du-dungeon-field">Markers<select class="form-select form-select-sm" data-f="markersId"></select></label>` +
                `</div>`;
            this.root.appendChild(rel);

            // ── Type panels ──────────────────────────────────────────
            this.procPanel = document.createElement('section');
            this.procPanel.className = 'du-dungeon-section du-dungeon-proc';
            this.procPanel.innerHTML =
                `<div class="du-dungeon-section-title">Rule program</div>` +
                `<p class="du-dungeon-hint small text-muted mb-2">Ops run in order. Counts may be a range (rolled per seed). Tags filter the piece pack.</p>` +
                `<div class="du-dungeon-row du-dungeon-row--tight">` +
                `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-action="tpl-starter">Apply starter crawl</button>` +
                `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-action="tpl-clear">Clear rules</button>` +
                `</div>` +
                `<div class="du-dungeon-rules" data-role="rules"></div>` +
                `<div class="du-dungeon-row du-dungeon-row--tight mt-2">` +
                RULE_OPS.map(
                    (op) =>
                        `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-add-op="${op.id}" title="${op.hint}">+ ${op.label}</button>`
                ).join('') +
                `</div>` +
                `<div class="du-dungeon-section-title mt-3">Generator knobs</div>` +
                `<div class="du-dungeon-row">` +
                `<label class="du-dungeon-field">Max attempts<input type="number" class="form-control form-control-sm" data-f="maxAttempts" min="1" max="500"></label>` +
                `<label class="du-dungeon-field">Max pieces<input type="number" class="form-control form-control-sm" data-f="maxPieces" min="1" max="200"></label>` +
                `<label class="du-dungeon-check"><input type="checkbox" data-f="capOpenExits"> Cap open exits</label>` +
                `<label class="du-dungeon-field du-dungeon-field--grow">Connector tags<input type="text" class="form-control form-control-sm" data-f="connectorTags" placeholder="corridor" spellcheck="false"></label>` +
                `</div>`;
            this.root.appendChild(this.procPanel);

            this.fixedPanel = document.createElement('section');
            this.fixedPanel.className = 'du-dungeon-section du-dungeon-fixed';
            this.fixedPanel.innerHTML =
                `<div class="du-dungeon-section-title">Fixed layout</div>` +
                `<p class="du-dungeon-hint small text-muted mb-2">Place pieces from the pack, then mark entrance / exit / waypoints. Waypoints are ordered; the map draws path connections. Cutouts are seed-varying pockets.</p>` +
                `<div class="du-dungeon-fixed-layout">` +
                `<div class="du-dungeon-palette">` +
                `<div class="du-dungeon-subhead">Pieces</div>` +
                `<div class="du-dungeon-palette-list" data-role="palette"></div>` +
                `</div>` +
                `<div class="du-dungeon-map-col">` +
                `<div class="du-dungeon-tools" data-role="fixed-tools"></div>` +
                `<div class="du-dungeon-map-wrap" data-role="map-wrap"></div>` +
                `<p class="du-dungeon-hint small text-muted mb-0" data-role="map-hint"></p>` +
                `</div>` +
                `<div class="du-dungeon-side">` +
                `<div class="du-dungeon-subhead">Placements</div>` +
                `<div class="du-dungeon-place-list" data-role="place-list"></div>` +
                `<div class="du-dungeon-subhead mt-2">Cutouts</div>` +
                `<div class="du-dungeon-cutout-list" data-role="cutout-list"></div>` +
                `<button type="button" class="btn btn-sm btn-retro btn-secondary mt-1" data-action="add-cutout">+ Cutout</button>` +
                `</div>` +
                `</div>`;
            this.root.appendChild(this.fixedPanel);

            // ── Pacing ───────────────────────────────────────────────
            const pacing = document.createElement('section');
            pacing.className = 'du-dungeon-section';
            pacing.innerHTML =
                `<details class="du-dungeon-details">` +
                `<summary class="du-dungeon-section-title">Pacing budget</summary>` +
                `<div class="du-dungeon-row mt-2">` +
                `<label class="du-dungeon-field">Budget id<input type="text" class="form-control form-control-sm font-monospace" data-pace="id" spellcheck="false"></label>` +
                `</div>` +
                `<div class="du-dungeon-subhead">Micro (seconds between fights)</div>` +
                `<div class="du-dungeon-row">` +
                `<label class="du-dungeon-field">Target<input type="number" class="form-control form-control-sm" data-pace="micro.targetGapSec" min="0"></label>` +
                `<label class="du-dungeon-field">Min<input type="number" class="form-control form-control-sm" data-pace="micro.minGapSec" min="0"></label>` +
                `<label class="du-dungeon-field">Warn<input type="number" class="form-control form-control-sm" data-pace="micro.warnGapSec" min="0"></label>` +
                `<label class="du-dungeon-field">Max<input type="number" class="form-control form-control-sm" data-pace="micro.maxGapSec" min="0"></label>` +
                `</div>` +
                `<div class="du-dungeon-subhead">Mid (kills / champions)</div>` +
                `<div class="du-dungeon-row">` +
                `<label class="du-dungeon-field">Min kills<input type="number" class="form-control form-control-sm" data-pace="mid.minKills" min="0"></label>` +
                `<label class="du-dungeon-field">Max kills<input type="number" class="form-control form-control-sm" data-pace="mid.maxKills" min="0"></label>` +
                `<label class="du-dungeon-field">Min champs<input type="number" class="form-control form-control-sm" data-pace="mid.minChampions" min="0"></label>` +
                `<label class="du-dungeon-field">Max champs<input type="number" class="form-control form-control-sm" data-pace="mid.maxChampions" min="0"></label>` +
                `</div>` +
                `<div class="du-dungeon-subhead">Session</div>` +
                `<div class="du-dungeon-row">` +
                `<label class="du-dungeon-field">Min time s<input type="number" class="form-control form-control-sm" data-pace="session.minTimeSec" min="0"></label>` +
                `<label class="du-dungeon-field">Max time s<input type="number" class="form-control form-control-sm" data-pace="session.maxTimeSec" min="0"></label>` +
                `<label class="du-dungeon-field">Min kpm<input type="number" class="form-control form-control-sm" data-pace="session.minKillsPerMin" min="0"></label>` +
                `<label class="du-dungeon-field">Max kpm<input type="number" class="form-control form-control-sm" data-pace="session.maxKillsPerMin" min="0"></label>` +
                `</div>` +
                `</details>`;
            this.root.appendChild(pacing);

            this.bindShellEvents();
            this.syncFormFromState();
            this.renderTypePanels();
        }

        bindShellEvents() {
            this.root.querySelectorAll('[data-f]').forEach((el) => {
                const input = /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} */ (
                    el
                );
                const field = input.getAttribute('data-f');
                if (!field) return;
                const apply = () => {
                    this.applyField(field, input);
                    this.onChange(true);
                };
                input.addEventListener('change', apply);
                if (input.tagName === 'TEXTAREA' || input.type === 'text' || input.type === 'number') {
                    input.addEventListener('input', apply);
                }
            });

            this.root.querySelectorAll('[data-pace]').forEach((el) => {
                const input = /** @type {HTMLInputElement} */ (el);
                const path = input.getAttribute('data-pace');
                if (!path) return;
                const apply = () => {
                    this.applyPace(path, input.value);
                    this.onChange(true);
                };
                input.addEventListener('change', apply);
                input.addEventListener('input', apply);
            });

            this.root.querySelectorAll('[data-type]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const t = btn.getAttribute('data-type');
                    if (t !== 'procedural' && t !== 'fixed') return;
                    this.state.type = t;
                    if (t === 'procedural' && (!this.state.rules || !this.state.rules.length)) {
                        this.state.rules = starterRules();
                    }
                    if (t === 'fixed' && !this.state.placements.length) {
                        // leave empty; designer places
                    }
                    this.syncFormFromState();
                    this.renderTypePanels();
                    this.onChange(true);
                    if (t === 'fixed') void this.ensurePiecePack();
                });
            });

            this.root.querySelectorAll('[data-action]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const a = btn.getAttribute('data-action');
                    if (a === 'tpl-starter') {
                        this.state.rules = starterRules();
                        this.renderRules();
                        this.onChange(true);
                    } else if (a === 'tpl-clear') {
                        this.state.rules = [];
                        this.renderRules();
                        this.onChange(true);
                    } else if (a === 'add-cutout') {
                        const n = this.state.cutouts.length;
                        this.state.cutouts.push({
                            id: `cutout_${n + 1}`,
                            bbox: { x: 0, y: 0, w: 5, h: 5 },
                            events: [],
                            maxPacks: [1, 3],
                            useSockets: true
                        });
                        this.selectedCutout = this.state.cutouts.length - 1;
                        this.renderCutoutList();
                        this.renderMap();
                        this.onChange(true);
                    }
                });
            });

            this.root.querySelectorAll('[data-add-op]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const op = btn.getAttribute('data-add-op');
                    if (!op) return;
                    const def = RULE_OPS.find((x) => x.id === op);
                    let tags = [];
                    let count = [1, 1];
                    let events = [];
                    if (op === 'AddHub') tags = ['hub'];
                    else if (op === 'AddRoom') {
                        tags = ['room'];
                        count = [2, 4];
                    } else if (op === 'AddCorridor') {
                        tags = ['corridor'];
                        count = [1, 3];
                    } else if (op === 'SelectEvent') {
                        count = [1, 2];
                        events = ['champion_room'];
                    }
                    this.state.rules.push({ op, tags, count, events });
                    this.renderRules();
                    this.onChange(true);
                    void def;
                });
            });
        }

        /**
         * @param {string} field
         * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} input
         */
        applyField(field, input) {
            if (field === 'label') this.state.label = input.value;
            else if (field === 'biome') this.state.biome = input.value.trim();
            else if (field === 'notes') this.state.notes = input.value;
            else if (field === 'floor') this.state.floor = Math.max(0, toInt(input.value, 0));
            else if (field === 'seeded') {
                this.state.seeded = /** @type {HTMLInputElement} */ (input).checked;
            } else if (field === 'piecePack') {
                this.state.piecePack = input.value;
                void this.ensurePiecePack(true);
            } else if (field === 'populationId') this.state.populationId = input.value;
            else if (field === 'markersId') this.state.markersId = input.value;
            else if (field === 'maxAttempts') {
                this.state.maxAttempts = Math.max(1, toInt(input.value, 40));
            } else if (field === 'maxPieces') {
                this.state.maxPieces = Math.max(1, toInt(input.value, 28));
            } else if (field === 'capOpenExits') {
                this.state.capOpenExits = /** @type {HTMLInputElement} */ (input).checked;
            } else if (field === 'connectorTags') {
                this.state.connectorTags = input.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
            }
        }

        /**
         * @param {string} path
         * @param {string} value
         */
        applyPace(path, value) {
            if (!this.state.pacingBudget || typeof this.state.pacingBudget !== 'object') {
                this.state.pacingBudget = defaultPacing(this.state.id);
            }
            const pb = /** @type {Record<string, unknown>} */ (this.state.pacingBudget);
            if (path === 'id') {
                pb.id = value.trim() || this.state.id + '_micro';
                return;
            }
            const parts = path.split('.');
            if (parts.length !== 2) return;
            const [sec, key] = parts;
            if (!pb[sec] || typeof pb[sec] !== 'object') pb[sec] = {};
            /** @type {Record<string, unknown>} */ (pb[sec])[key] = Math.max(
                0,
                toInt(value, 0)
            );
        }

        async loadRelationIds() {
            const mode = currentMode();
            try {
                const [pieces, pops, marks] = await Promise.all([
                    apiGet('presets_ids', { mode, kind: 'pieces' }),
                    apiGet('presets_ids', { mode, kind: 'populations' }),
                    apiGet('presets_ids', { mode, kind: 'markers' })
                ]);
                this.packIds = Array.isArray(pieces.ids) ? pieces.ids.map(String) : [];
                this.populationIds = Array.isArray(pops.ids)
                    ? pops.ids.map(String)
                    : [];
                this.markerIds = Array.isArray(marks.ids) ? marks.ids.map(String) : [];
            } catch (_) {
                this.packIds = this.packIds.length ? this.packIds : ['cave_v1'];
                this.populationIds = this.populationIds.length
                    ? this.populationIds
                    : ['cave_rats'];
                this.markerIds = this.markerIds.length
                    ? this.markerIds
                    : ['cave_clickies'];
            }
            this.fillSelects();
            if (this.state.type === 'fixed' || this.state.piecePack) {
                void this.ensurePiecePack();
            }
        }

        fillSelects() {
            const fill = (field, ids, current) => {
                const sel = /** @type {HTMLSelectElement|null} */ (
                    this.root.querySelector(`[data-f="${field}"]`)
                );
                if (!sel) return;
                const list = ids.slice();
                if (current && !list.includes(current)) list.unshift(current);
                if (!list.length) list.push('');
                sel.innerHTML = list
                    .map(
                        (id) =>
                            `<option value="${escapeAttr(id)}">${escapeHtml(id || '—')}</option>`
                    )
                    .join('');
                sel.value = current || list[0] || '';
            };
            fill('piecePack', this.packIds, this.state.piecePack);
            fill('populationId', this.populationIds, this.state.populationId);
            fill('markersId', this.markerIds, this.state.markersId);
        }

        /**
         * @param {boolean} [force]
         */
        async ensurePiecePack(force) {
            const packId = this.state.piecePack;
            if (!packId) return;
            if (!force && this.loadedPackId === packId && this.pieceIndex.size) return;
            const token = ++this.packLoadToken;
            try {
                const data = await apiGet('presets_get', {
                    mode: currentMode(),
                    kind: 'pieces',
                    id: packId
                });
                if (token !== this.packLoadToken) return;
                const entity =
                    data.entity && typeof data.entity === 'object'
                        ? data.entity
                        : data;
                const pieces = Array.isArray(entity.pieces) ? entity.pieces : [];
                this.pieceIndex = new Map();
                this.pieceIds = [];
                for (const raw of pieces) {
                    const lite = normalizePieceLite(raw);
                    if (!lite) continue;
                    this.pieceIndex.set(lite.id, lite);
                    this.pieceIds.push(lite.id);
                }
                this.loadedPackId = packId;
                if (!this.placePieceId || !this.pieceIndex.has(this.placePieceId)) {
                    this.placePieceId = this.pieceIds[0] || '';
                }
            } catch (_) {
                if (token !== this.packLoadToken) return;
                // Keep previous index if reload fails
            }
            if (this.state.type === 'fixed') {
                this.renderPalette();
                this.renderMap();
                this.renderPlaceList();
            }
        }

        syncFormFromState() {
            const set = (field, val) => {
                const el = /** @type {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement|null} */ (
                    this.root.querySelector(`[data-f="${field}"]`)
                );
                if (!el) return;
                if (el.type === 'checkbox') {
                    /** @type {HTMLInputElement} */ (el).checked = !!val;
                } else if (field === 'connectorTags') {
                    el.value = Array.isArray(val) ? val.join(', ') : String(val || '');
                } else {
                    el.value = val != null ? String(val) : '';
                }
            };
            set('label', this.state.label);
            set('biome', this.state.biome);
            set('notes', this.state.notes);
            set('floor', this.state.floor);
            set('seeded', this.state.seeded);
            set('maxAttempts', this.state.maxAttempts);
            set('maxPieces', this.state.maxPieces);
            set('capOpenExits', this.state.capOpenExits);
            set('connectorTags', this.state.connectorTags);
            this.fillSelects();

            this.root.querySelectorAll('[data-type]').forEach((btn) => {
                btn.classList.toggle(
                    'is-active',
                    btn.getAttribute('data-type') === this.state.type
                );
            });

            const pb =
                this.state.pacingBudget && typeof this.state.pacingBudget === 'object'
                    ? /** @type {Record<string, any>} */ (this.state.pacingBudget)
                    : defaultPacing(this.state.id);
            const paceVal = (path) => {
                const el = /** @type {HTMLInputElement|null} */ (
                    this.root.querySelector(`[data-pace="${path}"]`)
                );
                if (!el) return;
                if (path === 'id') {
                    el.value = pb.id != null ? String(pb.id) : '';
                    return;
                }
                const [sec, key] = path.split('.');
                const v =
                    pb[sec] && typeof pb[sec] === 'object' ? pb[sec][key] : '';
                el.value = v != null ? String(v) : '';
            };
            [
                'id',
                'micro.targetGapSec',
                'micro.minGapSec',
                'micro.warnGapSec',
                'micro.maxGapSec',
                'mid.minKills',
                'mid.maxKills',
                'mid.minChampions',
                'mid.maxChampions',
                'session.minTimeSec',
                'session.maxTimeSec',
                'session.minKillsPerMin',
                'session.maxKillsPerMin'
            ].forEach(paceVal);
        }

        renderTypePanels() {
            const isFixed = this.state.type === 'fixed';
            if (this.procPanel) this.procPanel.hidden = isFixed;
            if (this.fixedPanel) this.fixedPanel.hidden = !isFixed;
            if (isFixed) {
                this.renderFixedTools();
                this.renderPalette();
                this.renderPlaceList();
                this.renderCutoutList();
                this.renderMap();
                void this.ensurePiecePack();
            } else {
                this.renderRules();
            }
        }

        renderRules() {
            const host = this.root.querySelector('[data-role="rules"]');
            if (!host) return;
            host.innerHTML = '';
            if (!this.state.rules.length) {
                host.innerHTML =
                    '<p class="small text-muted mb-0">No rules yet. Add ops or apply the starter crawl template.</p>';
                return;
            }
            this.state.rules.forEach((rule, idx) => {
                const card = document.createElement('div');
                card.className = 'du-dungeon-rule';
                card.dataset.idx = String(idx);

                const opOpts = RULE_OPS.map(
                    (op) =>
                        `<option value="${op.id}" ${op.id === rule.op ? 'selected' : ''}>${op.label} (${op.id})</option>`
                ).join('');

                const [cLo, cHi] = rule.count || [1, 1];
                const showEvents = rule.op === 'SelectEvent';

                card.innerHTML =
                    `<div class="du-dungeon-rule-head">` +
                    `<span class="du-dungeon-rule-idx">#${idx + 1}</span>` +
                    `<select class="form-select form-select-sm" data-rule="op">${opOpts}</select>` +
                    `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-rule-act="up" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>` +
                    `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-rule-act="down" title="Move down" ${idx === this.state.rules.length - 1 ? 'disabled' : ''}>↓</button>` +
                    `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-rule-act="del" title="Remove">×</button>` +
                    `</div>` +
                    `<div class="du-dungeon-row">` +
                    `<label class="du-dungeon-field du-dungeon-field--grow">Tags<input type="text" class="form-control form-control-sm" data-rule="tags" value="${escapeAttr((rule.tags || []).join(', '))}" placeholder="room, hub" spellcheck="false"></label>` +
                    `<label class="du-dungeon-field">Count min<input type="number" class="form-control form-control-sm" data-rule="cmin" min="0" max="99" value="${cLo}"></label>` +
                    `<label class="du-dungeon-field">Count max<input type="number" class="form-control form-control-sm" data-rule="cmax" min="0" max="99" value="${cHi}"></label>` +
                    `</div>` +
                    `<div class="du-dungeon-chips" data-rule-chips></div>` +
                    (showEvents
                        ? `<label class="du-dungeon-field du-dungeon-field--grow">Events (comma-separated)<input type="text" class="form-control form-control-sm" data-rule="events" value="${escapeAttr((rule.events || []).join(', '))}" placeholder="champion_room, rest_well" spellcheck="false"></label>`
                        : '');

                const chips = card.querySelector('[data-rule-chips]');
                if (chips) {
                    TAG_CHIPS.forEach((t) => {
                        const b = document.createElement('button');
                        b.type = 'button';
                        b.className =
                            'btn btn-sm btn-retro btn-secondary du-dungeon-chip' +
                            ((rule.tags || []).includes(t) ? ' is-active' : '');
                        b.textContent = t;
                        b.addEventListener('click', () => {
                            const tags = new Set(rule.tags || []);
                            if (tags.has(t)) tags.delete(t);
                            else tags.add(t);
                            rule.tags = [...tags];
                            this.renderRules();
                            this.onChange(true);
                        });
                        chips.appendChild(b);
                    });
                }

                card.querySelectorAll('[data-rule]').forEach((el) => {
                    const input = /** @type {HTMLInputElement|HTMLSelectElement} */ (el);
                    const key = input.getAttribute('data-rule');
                    const apply = () => {
                        if (key === 'op') {
                            rule.op = input.value;
                            this.renderRules();
                        } else if (key === 'tags') {
                            rule.tags = input.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean);
                        } else if (key === 'cmin' || key === 'cmax') {
                            let lo = toInt(
                                /** @type {HTMLInputElement} */ (
                                    card.querySelector('[data-rule="cmin"]')
                                ).value,
                                1
                            );
                            let hi = toInt(
                                /** @type {HTMLInputElement} */ (
                                    card.querySelector('[data-rule="cmax"]')
                                ).value,
                                lo
                            );
                            if (hi < lo) {
                                const t = lo;
                                lo = hi;
                                hi = t;
                            }
                            rule.count = [Math.max(0, lo), Math.max(0, hi)];
                        } else if (key === 'events') {
                            rule.events = input.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean);
                        }
                        this.onChange(true);
                    };
                    input.addEventListener('change', apply);
                    if (input.tagName !== 'SELECT') input.addEventListener('input', apply);
                });

                card.querySelectorAll('[data-rule-act]').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const act = btn.getAttribute('data-rule-act');
                        if (act === 'del') {
                            this.state.rules.splice(idx, 1);
                        } else if (act === 'up' && idx > 0) {
                            const t = this.state.rules[idx - 1];
                            this.state.rules[idx - 1] = this.state.rules[idx];
                            this.state.rules[idx] = t;
                        } else if (act === 'down' && idx < this.state.rules.length - 1) {
                            const t = this.state.rules[idx + 1];
                            this.state.rules[idx + 1] = this.state.rules[idx];
                            this.state.rules[idx] = t;
                        }
                        this.renderRules();
                        this.onChange(true);
                    });
                });

                host.appendChild(card);
            });
        }

        renderFixedTools() {
            const host = this.root.querySelector('[data-role="fixed-tools"]');
            if (!host) return;
            const tools = [
                { id: 'select', label: 'Select / move' },
                { id: 'place', label: 'Place piece' },
                { id: 'entrance', label: 'Entrance' },
                { id: 'exit', label: 'Exit' },
                { id: 'waypoint', label: 'Waypoint' },
                { id: 'cutout', label: 'Cutout box' },
                { id: 'erase-wp', label: 'Erase WP' }
            ];
            host.innerHTML =
                `<span class="du-dungeon-label">Tool</span>` +
                tools
                    .map(
                        (t) =>
                            `<button type="button" class="btn btn-sm btn-retro btn-secondary du-dungeon-tool${this.fixedTool === t.id ? ' is-active' : ''}" data-tool="${t.id}">${t.label}</button>`
                    )
                    .join('');
            host.querySelectorAll('[data-tool]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const t = btn.getAttribute('data-tool');
                    if (!t) return;
                    this.fixedTool = /** @type {typeof this.fixedTool} */ (t);
                    this.renderFixedTools();
                    this.updateMapHint();
                });
            });
            this.updateMapHint();
        }

        updateMapHint() {
            const el = this.root.querySelector('[data-role="map-hint"]');
            if (!el) return;
            const hints = {
                select: 'Click a piece to select. Drag to move. Click empty to deselect.',
                place: 'Select a piece in the palette, then click the map (top-left cell).',
                entrance: 'Click a walkable cell for the party entrance.',
                exit: 'Click a walkable cell for the exit.',
                waypoint:
                    'Click walkable cells to append hunt waypoints (order = path; lines show connections).',
                cutout: 'Drag a rectangle over the map for a seed-varying cutout pocket.',
                'erase-wp': 'Click a waypoint cell to remove it (path reconnects in order).'
            };
            el.textContent = hints[this.fixedTool] || '';
        }

        renderPalette() {
            const host = this.root.querySelector('[data-role="palette"]');
            if (!host) return;
            host.innerHTML = '';
            if (!this.pieceIds.length) {
                host.innerHTML =
                    '<p class="small text-muted mb-0">Load a piece pack (or wait for API).</p>';
                return;
            }
            for (const id of this.pieceIds) {
                const p = this.pieceIndex.get(id);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className =
                    'du-dungeon-palette-item' +
                    (this.placePieceId === id ? ' is-active' : '');
                const tags = p && p.tags.length ? p.tags.join(', ') : '';
                btn.innerHTML =
                    `<span class="du-dungeon-palette-id">${escapeHtml(id)}</span>` +
                    (p
                        ? `<span class="du-dungeon-palette-meta">${p.w}×${p.h}${tags ? ' · ' + escapeHtml(tags) : ''}</span>`
                        : '');
                btn.addEventListener('click', () => {
                    this.placePieceId = id;
                    this.fixedTool = 'place';
                    this.renderPalette();
                    this.renderFixedTools();
                });
                host.appendChild(btn);
            }
        }

        renderPlaceList() {
            const host = this.root.querySelector('[data-role="place-list"]');
            if (!host) return;
            host.innerHTML = '';
            if (!this.state.placements.length) {
                host.innerHTML =
                    '<p class="small text-muted mb-0">No placements.</p>';
                return;
            }
            this.state.placements.forEach((pl, idx) => {
                const row = document.createElement('div');
                row.className =
                    'du-dungeon-place-row' +
                    (this.selectedPlacement === idx ? ' is-active' : '');
                row.innerHTML =
                    `<button type="button" class="du-dungeon-place-pick" data-pick="${idx}">` +
                    `<code>${escapeHtml(pl.pieceId)}</code> @ ${pl.x},${pl.y}` +
                    `</button>` +
                    `<label class="du-dungeon-xy">x<input type="number" data-px="${idx}" value="${pl.x}"></label>` +
                    `<label class="du-dungeon-xy">y<input type="number" data-py="${idx}" value="${pl.y}"></label>` +
                    `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-pdel="${idx}" title="Remove">×</button>`;
                host.appendChild(row);
            });
            host.querySelectorAll('[data-pick]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    this.selectedPlacement = toInt(btn.getAttribute('data-pick'), -1);
                    this.renderPlaceList();
                    this.renderMap();
                });
            });
            host.querySelectorAll('[data-px],[data-py]').forEach((el) => {
                const input = /** @type {HTMLInputElement} */ (el);
                input.addEventListener('change', () => {
                    const isX = input.hasAttribute('data-px');
                    const idx = toInt(
                        input.getAttribute(isX ? 'data-px' : 'data-py'),
                        -1
                    );
                    if (idx < 0 || !this.state.placements[idx]) return;
                    if (isX) this.state.placements[idx].x = toInt(input.value, 0);
                    else this.state.placements[idx].y = toInt(input.value, 0);
                    this.renderMap();
                    this.onChange(true);
                });
            });
            host.querySelectorAll('[data-pdel]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const idx = toInt(btn.getAttribute('data-pdel'), -1);
                    if (idx < 0) return;
                    this.state.placements.splice(idx, 1);
                    if (this.selectedPlacement === idx) this.selectedPlacement = -1;
                    else if (this.selectedPlacement > idx) this.selectedPlacement -= 1;
                    this.renderPlaceList();
                    this.renderMap();
                    this.onChange(true);
                });
            });
        }

        renderCutoutList() {
            const host = this.root.querySelector('[data-role="cutout-list"]');
            if (!host) return;
            host.innerHTML = '';
            if (!this.state.cutouts.length) {
                host.innerHTML =
                    '<p class="small text-muted mb-0">No cutouts (optional).</p>';
                return;
            }
            this.state.cutouts.forEach((c, idx) => {
                const card = document.createElement('div');
                card.className =
                    'du-dungeon-cutout' +
                    (this.selectedCutout === idx ? ' is-active' : '');
                const b = c.bbox || { x: 0, y: 0, w: 1, h: 1 };
                const [pLo, pHi] = c.maxPacks || [1, 3];
                card.innerHTML =
                    `<div class="du-dungeon-row du-dungeon-row--tight">` +
                    `<label class="du-dungeon-field du-dungeon-field--grow">Id<input type="text" class="form-control form-control-sm font-monospace" data-c="id" value="${escapeAttr(c.id)}" spellcheck="false"></label>` +
                    `<button type="button" class="btn btn-sm btn-retro btn-secondary" data-cdel="${idx}">×</button>` +
                    `</div>` +
                    `<div class="du-dungeon-row du-dungeon-row--tight">` +
                    `<label class="du-dungeon-field">x<input type="number" class="form-control form-control-sm" data-c="x" value="${b.x}"></label>` +
                    `<label class="du-dungeon-field">y<input type="number" class="form-control form-control-sm" data-c="y" value="${b.y}"></label>` +
                    `<label class="du-dungeon-field">w<input type="number" class="form-control form-control-sm" data-c="w" value="${b.w}" min="1"></label>` +
                    `<label class="du-dungeon-field">h<input type="number" class="form-control form-control-sm" data-c="h" value="${b.h}" min="1"></label>` +
                    `</div>` +
                    `<label class="du-dungeon-field du-dungeon-field--grow">Events<input type="text" class="form-control form-control-sm" data-c="events" value="${escapeAttr((c.events || []).join(', '))}" spellcheck="false"></label>` +
                    `<div class="du-dungeon-row du-dungeon-row--tight">` +
                    `<label class="du-dungeon-field">Packs min<input type="number" class="form-control form-control-sm" data-c="plo" value="${pLo}" min="0"></label>` +
                    `<label class="du-dungeon-field">Packs max<input type="number" class="form-control form-control-sm" data-c="phi" value="${pHi}" min="0"></label>` +
                    `<label class="du-dungeon-check"><input type="checkbox" data-c="sock" ${c.useSockets !== false ? 'checked' : ''}> Sockets</label>` +
                    `</div>`;
                card.addEventListener('click', (ev) => {
                    if (/** @type {HTMLElement} */ (ev.target).closest('input,button')) {
                        return;
                    }
                    this.selectedCutout = idx;
                    this.renderCutoutList();
                    this.renderMap();
                });
                card.querySelectorAll('[data-c]').forEach((el) => {
                    const input = /** @type {HTMLInputElement} */ (el);
                    const key = input.getAttribute('data-c');
                    const apply = () => {
                        if (key === 'id') c.id = input.value.trim() || `cutout_${idx}`;
                        else if (key === 'x') c.bbox.x = toInt(input.value, 0);
                        else if (key === 'y') c.bbox.y = toInt(input.value, 0);
                        else if (key === 'w') c.bbox.w = Math.max(1, toInt(input.value, 1));
                        else if (key === 'h') c.bbox.h = Math.max(1, toInt(input.value, 1));
                        else if (key === 'events') {
                            c.events = input.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean);
                        } else if (key === 'plo' || key === 'phi') {
                            let lo = toInt(
                                /** @type {HTMLInputElement} */ (
                                    card.querySelector('[data-c="plo"]')
                                ).value,
                                1
                            );
                            let hi = toInt(
                                /** @type {HTMLInputElement} */ (
                                    card.querySelector('[data-c="phi"]')
                                ).value,
                                lo
                            );
                            if (hi < lo) {
                                const t = lo;
                                lo = hi;
                                hi = t;
                            }
                            c.maxPacks = [lo, hi];
                        } else if (key === 'sock') {
                            c.useSockets = input.checked;
                        }
                        this.renderMap();
                        this.onChange(true);
                    };
                    input.addEventListener('change', apply);
                    if (input.type !== 'checkbox') input.addEventListener('input', apply);
                });
                const del = card.querySelector('[data-cdel]');
                if (del) {
                    del.addEventListener('click', () => {
                        this.state.cutouts.splice(idx, 1);
                        if (this.selectedCutout === idx) this.selectedCutout = -1;
                        this.renderCutoutList();
                        this.renderMap();
                        this.onChange(true);
                    });
                }
                host.appendChild(card);
            });
        }

        /**
         * World bounds covering placements + markers.
         * @returns {{minX:number,minY:number,maxX:number,maxY:number,w:number,h:number}}
         */
        mapBounds() {
            let minX = 0;
            let minY = 0;
            let maxX = 12;
            let maxY = 8;
            let any = false;
            for (const pl of this.state.placements) {
                const p = this.pieceIndex.get(pl.pieceId);
                const w = p ? p.w : 5;
                const h = p ? p.h : 5;
                if (!any) {
                    minX = pl.x;
                    minY = pl.y;
                    maxX = pl.x + w;
                    maxY = pl.y + h;
                    any = true;
                } else {
                    minX = Math.min(minX, pl.x);
                    minY = Math.min(minY, pl.y);
                    maxX = Math.max(maxX, pl.x + w);
                    maxY = Math.max(maxY, pl.y + h);
                }
            }
            const pts = [
                this.state.entrance,
                this.state.exit,
                ...this.state.waypoints
            ].filter(Boolean);
            for (const pt of pts) {
                if (!pt) continue;
                minX = Math.min(minX, pt.x);
                minY = Math.min(minY, pt.y);
                maxX = Math.max(maxX, pt.x + 1);
                maxY = Math.max(maxY, pt.y + 1);
                any = true;
            }
            for (const c of this.state.cutouts) {
                const b = c.bbox;
                if (!b) continue;
                minX = Math.min(minX, b.x);
                minY = Math.min(minY, b.y);
                maxX = Math.max(maxX, b.x + b.w);
                maxY = Math.max(maxY, b.y + b.h);
                any = true;
            }
            minX -= MAP_PAD;
            minY -= MAP_PAD;
            maxX += MAP_PAD;
            maxY += MAP_PAD;
            return {
                minX,
                minY,
                maxX,
                maxY,
                w: Math.max(8, maxX - minX),
                h: Math.max(6, maxY - minY)
            };
        }

        /**
         * @param {number} worldX
         * @param {number} worldY
         * @returns {boolean}
         */
        isWalkable(worldX, worldY) {
            for (const pl of this.state.placements) {
                const p = this.pieceIndex.get(pl.pieceId);
                if (!p) continue;
                const lx = worldX - pl.x;
                const ly = worldY - pl.y;
                if (lx < 0 || ly < 0 || lx >= p.w || ly >= p.h) continue;
                if (p.friction[ly].charAt(lx) !== '#') return true;
            }
            return false;
        }

        /**
         * Top-most placement index under cell, or -1.
         * @param {number} worldX
         * @param {number} worldY
         * @returns {number}
         */
        hitPlacement(worldX, worldY) {
            for (let i = this.state.placements.length - 1; i >= 0; i--) {
                const pl = this.state.placements[i];
                const p = this.pieceIndex.get(pl.pieceId);
                const w = p ? p.w : 5;
                const h = p ? p.h : 5;
                if (
                    worldX >= pl.x &&
                    worldY >= pl.y &&
                    worldX < pl.x + w &&
                    worldY < pl.y + h
                ) {
                    return i;
                }
            }
            return -1;
        }

        /**
         * First waypoint index at a cell, or -1.
         * @param {number} wx
         * @param {number} wy
         * @returns {number}
         */
        waypointIndexAt(wx, wy) {
            for (let i = 0; i < this.state.waypoints.length; i++) {
                const p = this.state.waypoints[i];
                if (p.x === wx && p.y === wy) return i;
            }
            return -1;
        }

        /**
         * SVG overlay: consecutive waypoint edges (hunt path order).
         * @param {number} minX
         * @param {number} minY
         * @param {number} w
         * @param {number} h
         * @returns {SVGSVGElement|null}
         */
        buildWaypointEdgeOverlay(minX, minY, w, h) {
            const wps = this.state.waypoints;
            if (!wps || wps.length < 2) return null;

            const NS = 'http://www.w3.org/2000/svg';
            const svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('class', 'du-dungeon-wp-edges');
            svg.setAttribute('width', String(w * CELL_PX));
            svg.setAttribute('height', String(h * CELL_PX));
            svg.setAttribute('viewBox', `0 0 ${w * CELL_PX} ${h * CELL_PX}`);
            svg.setAttribute('aria-hidden', 'true');

            const defs = document.createElementNS(NS, 'defs');
            const marker = document.createElementNS(NS, 'marker');
            // Unique id per render so multiple overlays never clash
            const markerId = `du-wp-arrow-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
            marker.setAttribute('id', markerId);
            marker.setAttribute('markerWidth', '7');
            marker.setAttribute('markerHeight', '7');
            marker.setAttribute('refX', '6');
            marker.setAttribute('refY', '3.5');
            marker.setAttribute('orient', 'auto');
            marker.setAttribute('markerUnits', 'userSpaceOnUse');
            const tip = document.createElementNS(NS, 'path');
            tip.setAttribute('d', 'M0,0 L7,3.5 L0,7 Z');
            tip.setAttribute('class', 'du-dungeon-wp-arrow');
            marker.appendChild(tip);
            defs.appendChild(marker);
            svg.appendChild(defs);

            const half = CELL_PX / 2;
            for (let i = 0; i + 1 < wps.length; i++) {
                const a = wps[i];
                const b = wps[i + 1];
                if (!a || !b) continue;
                if (a.x === b.x && a.y === b.y) continue;
                const x1 = (a.x - minX) * CELL_PX + half;
                const y1 = (a.y - minY) * CELL_PX + half;
                const x2 = (b.x - minX) * CELL_PX + half;
                const y2 = (b.y - minY) * CELL_PX + half;
                const line = document.createElementNS(NS, 'line');
                line.setAttribute('x1', String(x1));
                line.setAttribute('y1', String(y1));
                line.setAttribute('x2', String(x2));
                line.setAttribute('y2', String(y2));
                line.setAttribute('class', 'du-dungeon-wp-edge');
                line.setAttribute('marker-end', `url(#${markerId})`);
                line.setAttribute(
                    'title',
                    `WP ${i + 1} → ${i + 2} (${a.x},${a.y}) → (${b.x},${b.y})`
                );
                svg.appendChild(line);
            }
            return svg;
        }

        renderMap() {
            const wrap = this.root.querySelector('[data-role="map-wrap"]');
            if (!wrap) return;
            const bounds = this.mapBounds();
            const { minX, minY, w, h } = bounds;

            /** @type {(string|null)[]} */
            const cells = new Array(w * h).fill(null);
            /** @type {number[]} */
            const owners = new Array(w * h).fill(-1);

            this.state.placements.forEach((pl, pi) => {
                const p = this.pieceIndex.get(pl.pieceId);
                const pw = p ? p.w : 5;
                const ph = p ? p.h : 5;
                for (let ly = 0; ly < ph; ly++) {
                    for (let lx = 0; lx < pw; lx++) {
                        const wx = pl.x + lx;
                        const wy = pl.y + ly;
                        const cx = wx - minX;
                        const cy = wy - minY;
                        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
                        const idx = cy * w + cx;
                        const ch = p ? p.friction[ly].charAt(lx) : '#';
                        cells[idx] = ch;
                        owners[idx] = pi;
                    }
                }
            });

            const stage = document.createElement('div');
            stage.className = 'du-dungeon-map-stage';

            const table = document.createElement('div');
            table.className = 'du-dungeon-map';
            table.style.gridTemplateColumns = `repeat(${w}, ${CELL_PX}px)`;
            table.style.gridTemplateRows = `repeat(${h}, ${CELL_PX}px)`;

            for (let cy = 0; cy < h; cy++) {
                for (let cx = 0; cx < w; cx++) {
                    const cell = document.createElement('div');
                    cell.className = 'du-dungeon-map-cell';
                    const idx = cy * w + cx;
                    const ch = cells[idx];
                    const pi = owners[idx];
                    const wx = cx + minX;
                    const wy = cy + minY;
                    if (ch == null) {
                        cell.classList.add('is-void');
                    } else if (ch === '#') {
                        cell.classList.add('is-wall');
                    } else {
                        cell.classList.add('is-floor');
                    }
                    if (pi === this.selectedPlacement) {
                        cell.classList.add('is-selected-piece');
                    }
                    // Cutout overlay
                    for (let ci = 0; ci < this.state.cutouts.length; ci++) {
                        const b = this.state.cutouts[ci].bbox;
                        if (!b) continue;
                        if (
                            wx >= b.x &&
                            wy >= b.y &&
                            wx < b.x + b.w &&
                            wy < b.y + b.h
                        ) {
                            cell.classList.add('in-cutout');
                            if (ci === this.selectedCutout) {
                                cell.classList.add('in-cutout-active');
                            }
                        }
                    }

                    const wpIdx = this.waypointIndexAt(wx, wy);
                    const isEntrance =
                        this.state.entrance &&
                        this.state.entrance.x === wx &&
                        this.state.entrance.y === wy;
                    const isExit =
                        this.state.exit &&
                        this.state.exit.x === wx &&
                        this.state.exit.y === wy;

                    let title = `(${wx},${wy})`;
                    if (isEntrance) {
                        cell.classList.add('is-entrance');
                        cell.textContent = 'E';
                        title += ' entrance';
                    } else if (isExit) {
                        cell.classList.add('is-exit');
                        cell.textContent = 'X';
                        title += ' exit';
                    } else if (wpIdx >= 0) {
                        cell.classList.add('is-waypoint');
                        // 1-based order so designers see path sequence
                        cell.textContent = String(wpIdx + 1);
                        title += ` waypoint #${wpIdx + 1}`;
                    }
                    // Entrance/exit that double as waypoints still count for path lines
                    if (wpIdx >= 0 && (isEntrance || isExit)) {
                        cell.classList.add('is-waypoint');
                        title += ` · waypoint #${wpIdx + 1}`;
                    }
                    cell.title = title;
                    cell.dataset.wx = String(wx);
                    cell.dataset.wy = String(wy);
                    table.appendChild(cell);
                }
            }

            stage.appendChild(table);
            const edges = this.buildWaypointEdgeOverlay(minX, minY, w, h);
            if (edges) stage.appendChild(edges);

            this._mapOrigin = { minX, minY };
            this.bindMapEvents(table);
            wrap.innerHTML = '';
            wrap.appendChild(stage);
        }

        /**
         * @param {HTMLElement} table
         */
        bindMapEvents(table) {
            table.addEventListener('mousedown', (ev) => {
                if (ev.button !== 0) return;
                const t = /** @type {HTMLElement} */ (ev.target);
                const cell = t.closest('.du-dungeon-map-cell');
                if (!cell || !table.contains(cell)) return;
                ev.preventDefault();
                const wx = toInt(cell.getAttribute('data-wx'), 0);
                const wy = toInt(cell.getAttribute('data-wy'), 0);
                const tool = this.fixedTool;

                if (tool === 'place') {
                    if (!this.placePieceId) return;
                    this.state.placements.push({
                        pieceId: this.placePieceId,
                        x: wx,
                        y: wy
                    });
                    this.selectedPlacement = this.state.placements.length - 1;
                    this.renderPlaceList();
                    this.renderMap();
                    this.onChange(true);
                    return;
                }

                if (tool === 'entrance') {
                    this.state.entrance = { x: wx, y: wy };
                    this.renderMap();
                    this.onChange(true);
                    return;
                }

                if (tool === 'exit') {
                    this.state.exit = { x: wx, y: wy };
                    this.renderMap();
                    this.onChange(true);
                    return;
                }

                if (tool === 'waypoint') {
                    if (!this.state.waypoints.some((p) => p.x === wx && p.y === wy)) {
                        this.state.waypoints.push({ x: wx, y: wy });
                        this.renderMap();
                        this.onChange(true);
                    }
                    return;
                }

                if (tool === 'erase-wp') {
                    const before = this.state.waypoints.length;
                    this.state.waypoints = this.state.waypoints.filter(
                        (p) => !(p.x === wx && p.y === wy)
                    );
                    if (this.state.waypoints.length !== before) {
                        this.renderMap();
                        this.onChange(true);
                    }
                    return;
                }

                if (tool === 'cutout') {
                    this._cutDrag = { x0: wx, y0: wy, x1: wx, y1: wy };
                    return;
                }

                // select / move — drag tracked on document so re-render is safe
                const hit = this.hitPlacement(wx, wy);
                this.selectedPlacement = hit;
                if (hit >= 0) {
                    const pl = this.state.placements[hit];
                    this._drag = {
                        idx: hit,
                        ox: wx - pl.x,
                        oy: wy - pl.y
                    };
                } else {
                    this._drag = null;
                }
                this.renderPlaceList();
                this.renderMap();
            });
        }

        /**
         * @param {unknown} value
         * @param {boolean} [initial]
         */
        setValue(value, initial) {
            const v =
                value && typeof value === 'object' && !Array.isArray(value)
                    ? /** @type {Record<string, unknown>} */ (value)
                    : {};

            const managed = new Set([
                'id',
                'label',
                'type',
                'biome',
                'seeded',
                'notes',
                'piecePack',
                'populationId',
                'markersId',
                'floor',
                'maxAttempts',
                'maxPieces',
                'capOpenExits',
                'connectorTags',
                'rules',
                'placements',
                'entrance',
                'exit',
                'waypoints',
                'cutouts',
                'pacingBudget'
            ]);
            /** @type {Record<string, unknown>} */
            const extra = {};
            for (const [k, val] of Object.entries(v)) {
                if (!managed.has(k)) extra[k] = val;
            }
            this.extra = extra;

            const id = v.id != null ? String(v.id) : 'new_item';
            let type = v.type != null ? String(v.type) : '';
            if (type !== 'fixed' && type !== 'procedural') {
                // Infer from body when type omitted (e.g. small_crawl)
                type =
                    Array.isArray(v.placements) && v.placements.length
                        ? 'fixed'
                        : 'procedural';
            }

            this.state = {
                id,
                label: v.label != null ? String(v.label) : '',
                type,
                biome: v.biome != null ? String(v.biome) : 'cave',
                seeded: v.seeded !== false,
                notes: v.notes != null ? String(v.notes) : '',
                piecePack:
                    v.piecePack != null
                        ? String(v.piecePack)
                        : v.piecePackId != null
                          ? String(v.piecePackId)
                          : 'cave_v1',
                populationId:
                    v.populationId != null ? String(v.populationId) : '',
                markersId: v.markersId != null ? String(v.markersId) : '',
                floor: toInt(v.floor, 0),
                maxAttempts: Math.max(1, toInt(v.maxAttempts, 40)),
                maxPieces: Math.max(1, toInt(v.maxPieces, 28)),
                capOpenExits: v.capOpenExits !== false,
                connectorTags: Array.isArray(v.connectorTags)
                    ? v.connectorTags.map((t) => String(t))
                    : ['corridor'],
                rules: Array.isArray(v.rules)
                    ? v.rules.map(normalizeRuleRow)
                    : type === 'procedural'
                      ? starterRules()
                      : [],
                placements: normalizePlacements(v.placements),
                entrance: normalizePoint(v.entrance),
                exit: normalizePoint(v.exit),
                waypoints: normalizeWaypoints(v.waypoints),
                cutouts: normalizeCutouts(v.cutouts),
                pacingBudget:
                    v.pacingBudget && typeof v.pacingBudget === 'object'
                        ? JSON.parse(JSON.stringify(v.pacingBudget))
                        : defaultPacing(id)
            };

            this.selectedPlacement = -1;
            this.selectedCutout = -1;
            if (this.root) {
                this.syncFormFromState();
                this.renderTypePanels();
            }
            void this.ensurePiecePack(true);
            this.onChange(!initial);
        }

        getValue() {
            const s = this.state;
            /** @type {Record<string, unknown>} */
            const out = {
                id: s.id,
                type: s.type,
                biome: s.biome || undefined,
                seeded: s.seeded,
                piecePack: s.piecePack || undefined,
                populationId: s.populationId || undefined,
                markersId: s.markersId || undefined,
                floor: s.floor | 0
            };
            if (s.label) out.label = s.label;
            if (s.notes) out.notes = s.notes;

            if (s.type === 'fixed') {
                out.placements = s.placements.map((p) => ({
                    pieceId: p.pieceId,
                    x: p.x | 0,
                    y: p.y | 0
                }));
                if (s.entrance) out.entrance = { x: s.entrance.x, y: s.entrance.y };
                if (s.exit) out.exit = { x: s.exit.x, y: s.exit.y };
                if (s.waypoints.length) {
                    out.waypoints = s.waypoints.map((p) => ({ x: p.x, y: p.y }));
                }
                if (s.cutouts.length) {
                    out.cutouts = s.cutouts.map((c) => {
                        /** @type {Record<string, unknown>} */
                        const row = {
                            id: c.id,
                            bbox: {
                                x: c.bbox.x | 0,
                                y: c.bbox.y | 0,
                                w: Math.max(1, c.bbox.w | 0),
                                h: Math.max(1, c.bbox.h | 0)
                            },
                            maxPacks: c.maxPacks
                                ? [c.maxPacks[0], c.maxPacks[1]]
                                : [1, 3],
                            useSockets: c.useSockets !== false
                        };
                        if (c.events && c.events.length) row.events = c.events.slice();
                        return row;
                    });
                }
            } else {
                out.maxAttempts = s.maxAttempts;
                out.maxPieces = s.maxPieces;
                out.capOpenExits = s.capOpenExits;
                if (s.connectorTags && s.connectorTags.length) {
                    out.connectorTags = s.connectorTags.slice();
                }
                out.rules = (s.rules || []).map((r) => {
                    /** @type {Record<string, unknown>} */
                    const row = { op: r.op };
                    if (r.tags && r.tags.length) row.tags = r.tags.slice();
                    const [lo, hi] = r.count || [1, 1];
                    row.count = lo === hi ? lo : [lo, hi];
                    if (r.op === 'SelectEvent' && r.events && r.events.length) {
                        row.events = r.events.slice();
                    }
                    return row;
                });
            }

            if (s.pacingBudget && typeof s.pacingBudget === 'object') {
                out.pacingBudget = JSON.parse(JSON.stringify(s.pacingBudget));
            }

            // Preserve unknown keys (e.g. future multi-floor fields)
            for (const [k, val] of Object.entries(this.extra || {})) {
                if (out[k] === undefined) out[k] = val;
            }

            // Drop undefined
            for (const k of Object.keys(out)) {
                if (out[k] === undefined) delete out[k];
            }
            return out;
        }

        destroy() {
            if (this._onDocMouseMove) {
                document.removeEventListener('mousemove', this._onDocMouseMove);
                this._onDocMouseMove = null;
            }
            if (this._onDocMouseUp) {
                document.removeEventListener('mouseup', this._onDocMouseUp);
                this._onDocMouseUp = null;
            }
            if (this.root) {
                this.root.innerHTML = '';
                this.root = null;
            }
            super.destroy();
        }
    }

    /**
     * @param {string} s
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
     */
    function escapeAttr(s) {
        return escapeHtml(s).replace(/'/g, '&#39;');
    }

    JE.defaults.editors.dungeon_profile = DungeonProfileEditor;
    JE.defaults.resolvers.unshift((schema) => {
        if (schema && schema.format === 'dungeon_profile') {
            return 'dungeon_profile';
        }
    });

    window.__DU_DUNGEON_PROFILE_REGISTERED__ = true;
    return true;
}

module.exports = {
    registerDungeonProfileEditor,
    normalizeRuleRow,
    normalizePlacements,
    normalizeCutouts,
    pairCount,
    starterRules
};
