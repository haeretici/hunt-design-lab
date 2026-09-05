/**
 * Viewport placement for #inventoryFloatRoot panels (bags, Browse Field, NPC)
 * and cursor-anchored RMB menus (`.inv-context-menu`).
 * Float panels: prefer the right of the source slot/tile; flip left if it
 * would clip; clamp to the canvas (map origin) or the viewport (slot origin).
 * Context menus: prefer top-left at the cursor; flip left/up if they would
 * clip (last backpack column, bottom of the list); then clamp.
 */

'use strict';

const GAP = 8;
const NUDGE = 16;
const VIEWPORT_PAD = 8;

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(n, lo, hi) {
    if (!(hi >= lo)) return lo;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
}

/**
 * @param {DOMRect|{ left?: number, top?: number, right?: number, bottom?: number, width?: number, height?: number }|null|undefined} r
 * @returns {{ left: number, top: number, right: number, bottom: number }|null}
 */
function rectFromClientRect(r) {
    if (!r) return null;
    const left = Number(r.left) || 0;
    const top = Number(r.top) || 0;
    const width = Number(r.width) || 0;
    const height = Number(r.height) || 0;
    const right = r.right != null ? Number(r.right) : left + width;
    const bottom = r.bottom != null ? Number(r.bottom) : top + height;
    if (!(right > left) && !(bottom > top) && width <= 0 && height <= 0) {
        return null;
    }
    return { left, top, right, bottom };
}

/**
 * @param {{ innerWidth?: number, innerHeight?: number }|null|undefined} win
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
function viewportBounds(win) {
    const w = win && win.innerWidth != null ? Number(win.innerWidth) : 0;
    const h = win && win.innerHeight != null ? Number(win.innerHeight) : 0;
    return {
        left: VIEWPORT_PAD,
        top: VIEWPORT_PAD,
        right: w > 0 ? Math.max(VIEWPORT_PAD, w - VIEWPORT_PAD) : 10000,
        bottom: h > 0 ? Math.max(VIEWPORT_PAD, h - VIEWPORT_PAD) : 10000
    };
}

/**
 * @param {{ getBoundingClientRect?: function(): * }|null|undefined} canvasEl
 * @returns {{ left: number, top: number, right: number, bottom: number }|null}
 */
function canvasClientBounds(canvasEl) {
    if (!canvasEl || typeof canvasEl.getBoundingClientRect !== 'function') {
        return null;
    }
    return rectFromClientRect(canvasEl.getBoundingClientRect());
}

/**
 * Inverse of inventory_panel.clientToTile — tile cell in viewport pixels.
 *
 * @param {{ x?: number, y?: number }|null|undefined} tile
 * @param {{ getBoundingClientRect?: function(): *, width?: number, height?: number }|null|undefined} canvasEl
 * @param {{ _viewOriginX?: number, _viewOriginY?: number }|null|undefined} tileMap
 * @param {number} [tileW=32]
 * @param {number} [tileH=32]
 * @returns {{ left: number, top: number, right: number, bottom: number }|null}
 */
function tileClientRect(tile, canvasEl, tileMap, tileW, tileH) {
    if (!tile || tile.x == null || tile.y == null) return null;
    if (!canvasEl || typeof canvasEl.getBoundingClientRect !== 'function') {
        return null;
    }
    const rect = canvasEl.getBoundingClientRect();
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const tw = tileW > 0 ? tileW : 32;
    const th = tileH > 0 ? tileH : 32;
    const ox = (tileMap && tileMap._viewOriginX) || 0;
    const oy = (tileMap && tileMap._viewOriginY) || 0;
    const scaleX = (canvasEl.width || rect.width) / rect.width;
    const scaleY = (canvasEl.height || rect.height) / rect.height;
    const cssTw = tw / (scaleX > 0 ? scaleX : 1);
    const cssTh = th / (scaleY > 0 ? scaleY : 1);
    const left = rect.left + (Number(tile.x) - ox) * cssTw;
    const top = rect.top + (Number(tile.y) - oy) * cssTh;
    return { left, top, right: left + cssTw, bottom: top + cssTh };
}

/**
 * @param {{ getBoundingClientRect?: function(): * }|null|undefined} el
 * @returns {{ left: number, top: number, right: number, bottom: number }|null}
 */
function slotClientRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    return rectFromClientRect(el.getBoundingClientRect());
}

/**
 * @param {{ children?: *, childNodes?: * }|null|undefined} floatRoot
 * @param {*} excludeEl
 * @returns {{ left: number, top: number, right: number, bottom: number }[]}
 */
function collectOccupiedRects(floatRoot, excludeEl) {
    if (!floatRoot) return [];
    const kids = floatRoot.children || floatRoot.childNodes || [];
    const out = [];
    for (let i = 0; i < kids.length; i++) {
        const el = kids[i];
        if (!el || el === excludeEl) continue;
        const className = String(el.className || '');
        if (className.indexOf('inv-float-panel') < 0) continue;
        if (typeof el.getBoundingClientRect === 'function') {
            const r = rectFromClientRect(el.getBoundingClientRect());
            if (r) out.push(r);
            continue;
        }
        const left =
            parseFloat(el.style && el.style.left) || Number(el.offsetLeft) || 0;
        const top =
            parseFloat(el.style && el.style.top) || Number(el.offsetTop) || 0;
        const w = Number(el.offsetWidth) || 200;
        const h = Number(el.offsetHeight) || 80;
        out.push({ left, top, right: left + w, bottom: top + h });
    }
    return out;
}

/**
 * @param {{ left: number, top: number, right: number, bottom: number }} a
 * @param {{ left: number, top: number, right: number, bottom: number }} b
 * @returns {boolean}
 */
function rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.panelW]
 * @param {number} [opts.panelH]
 * @param {{ left?: number, top?: number, right?: number, bottom?: number }|null} [opts.anchor]
 * @param {{ left: number, top: number, right: number, bottom: number }} [opts.bounds]
 * @param {{ left: number, top: number, right: number, bottom: number }[]} [opts.occupied]
 * @param {number} [opts.gap]
 * @param {number} [opts.nudge]
 * @returns {{ left: number, top: number }}
 */
function computeFloatPosition(opts) {
    const o = opts || {};
    const panelW = Math.max(1, Number(o.panelW) || 200);
    const panelH = Math.max(1, Number(o.panelH) || 80);
    const bounds = o.bounds || viewportBounds(null);
    const occupied = Array.isArray(o.occupied) ? o.occupied : [];
    const gap = o.gap != null ? Number(o.gap) : GAP;
    const nudge = o.nudge != null ? Number(o.nudge) : NUDGE;
    const anchor = o.anchor;

    let left;
    let top;
    if (anchor && (anchor.right != null || anchor.left != null)) {
        const preferRight = (anchor.right != null ? Number(anchor.right) : 0) + gap;
        if (preferRight + panelW <= bounds.right) {
            left = preferRight;
        } else {
            left =
                (anchor.left != null ? Number(anchor.left) : 0) - panelW - gap;
        }
        top = anchor.top != null ? Number(anchor.top) : bounds.top;
    } else {
        left = bounds.left;
        top = bounds.top;
    }

    const maxLeft = bounds.right - panelW;
    const maxTop = bounds.bottom - panelH;
    left = clamp(left, bounds.left, maxLeft);
    top = clamp(top, bounds.top, maxTop);

    let placed = { left, top, right: left + panelW, bottom: top + panelH };
    for (let step = 0; step < 8; step++) {
        let hit = false;
        for (let i = 0; i < occupied.length; i++) {
            if (occupied[i] && rectsOverlap(placed, occupied[i])) {
                hit = true;
                break;
            }
        }
        if (!hit) break;
        left = clamp(left + nudge, bounds.left, maxLeft);
        top = clamp(top + nudge, bounds.top, maxTop);
        placed = { left, top, right: left + panelW, bottom: top + panelH };
    }
    return { left, top };
}

/**
 * @param {{ style?: { left?: string, top?: string }, offsetWidth?: number, offsetHeight?: number }|null|undefined} panel
 * @param {object} [opts]
 * @returns {{ left: number, top: number }|null}
 */
function placeFloatPanel(panel, opts) {
    if (!panel || !panel.style) return null;
    const o = opts || {};
    const panelW = Number(panel.offsetWidth) || o.fallbackW || 200;
    const panelH = Number(panel.offsetHeight) || o.fallbackH || 80;
    const pos = computeFloatPosition({
        panelW,
        panelH,
        anchor: o.anchor,
        bounds: o.bounds,
        occupied: o.occupied,
        gap: o.gap,
        nudge: o.nudge
    });
    panel.style.left = pos.left + 'px';
    panel.style.top = pos.top + 'px';
    return pos;
}

/**
 * Cursor-anchored popup (inventory / canvas / combat / action-bar RMB).
 * Prefer top-left at (x, y); flip left/up if it would clip; then clamp.
 *
 * @param {object} [opts]
 * @param {number} [opts.x]
 * @param {number} [opts.y]
 * @param {number} [opts.menuW]
 * @param {number} [opts.menuH]
 * @param {{ left: number, top: number, right: number, bottom: number }} [opts.bounds]
 * @returns {{ left: number, top: number }}
 */
function computeContextMenuPosition(opts) {
    const o = opts || {};
    const menuW = Math.max(1, Number(o.menuW) || 160);
    const menuH = Math.max(1, Number(o.menuH) || 40);
    const bounds = o.bounds || viewportBounds(null);
    let left = Number(o.x);
    let top = Number(o.y);
    if (!Number.isFinite(left)) left = bounds.left;
    if (!Number.isFinite(top)) top = bounds.top;

    if (left + menuW > bounds.right) {
        left = left - menuW;
    }
    if (top + menuH > bounds.bottom) {
        top = top - menuH;
    }

    const maxLeft = bounds.right - menuW;
    const maxTop = bounds.bottom - menuH;
    left = clamp(left, bounds.left, maxLeft);
    top = clamp(top, bounds.top, maxTop);
    return { left, top };
}

/**
 * Measure a mounted `.inv-context-menu` and write clamped left/top.
 *
 * @param {{ style?: { left?: string, top?: string }, offsetWidth?: number, offsetHeight?: number, getBoundingClientRect?: function(): * }|null|undefined} el
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 * @param {number} [opts.fallbackW]
 * @param {number} [opts.fallbackH]
 * @param {{ left: number, top: number, right: number, bottom: number }} [opts.bounds]
 * @param {{ innerWidth?: number, innerHeight?: number }|null} [opts.win]
 * @returns {{ left: number, top: number }|null}
 */
function placeContextMenu(el, x, y, opts) {
    if (!el || !el.style) return null;
    const o = opts || {};
    const win =
        o.win || (typeof window !== 'undefined' ? window : null);
    let menuW = Number(el.offsetWidth) || 0;
    let menuH = Number(el.offsetHeight) || 0;
    if (
        (menuW <= 0 || menuH <= 0) &&
        typeof el.getBoundingClientRect === 'function'
    ) {
        const r = el.getBoundingClientRect();
        if (r) {
            if (menuW <= 0) menuW = Number(r.width) || 0;
            if (menuH <= 0) menuH = Number(r.height) || 0;
        }
    }
    if (menuW <= 0) menuW = o.fallbackW || 160;
    if (menuH <= 0) menuH = o.fallbackH || 80;
    const pos = computeContextMenuPosition({
        x,
        y,
        menuW,
        menuH,
        bounds: o.bounds || viewportBounds(win)
    });
    el.style.left = pos.left + 'px';
    el.style.top = pos.top + 'px';
    return pos;
}

/**
 * @param {string|null|undefined} kind 'canvas' | 'slot' | other
 * @param {{ getBoundingClientRect?: function(): * }|null|undefined} canvasEl
 * @param {{ innerWidth?: number, innerHeight?: number }|null|undefined} win
 * @returns {{ left: number, top: number, right: number, bottom: number }}
 */
function boundsForOrigin(kind, canvasEl, win) {
    if (kind === 'canvas') {
        const c = canvasClientBounds(canvasEl);
        if (c) return c;
    }
    return viewportBounds(
        win || (typeof window !== 'undefined' ? window : null)
    );
}

module.exports = {
    GAP,
    NUDGE,
    VIEWPORT_PAD,
    viewportBounds,
    canvasClientBounds,
    tileClientRect,
    slotClientRect,
    collectOccupiedRects,
    computeFloatPosition,
    placeFloatPanel,
    computeContextMenuPosition,
    placeContextMenu,
    boundsForOrigin
};
