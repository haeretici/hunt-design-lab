/**
 * Right-sidebar collapsible panels: open/close, order (drag title bar),
 * resizable height, and icon toggles under the equipment card.
 *
 * Prefs (localStorage `hdl_sidebar_panels`):
 *   { order, closed, collapsed, heights }
 * Legacy per-panel `hdl_panel_collapsed_<id>` is migrated on first load.
 */

'use strict';

const PREFS_KEY = 'hdl_sidebar_panels';
const LEGACY_COLLAPSED_PREFIX = 'hdl_panel_collapsed_';

/** Default order when the user has no saved UI prefs. Skills sits under Combat. */
const DEFAULT_ORDER = Object.freeze(['backpack', 'combat', 'skills', 'party']);

const DEFAULT_HEIGHTS = Object.freeze({
    backpack: 148,
    combat: 210,
    skills: 210,
    party: 210
});

const PANEL_META = Object.freeze({
    backpack: {
        label: 'Backpack',
        icon: 'fa-bag-shopping',
        title: 'Backpack'
    },
    combat: {
        label: 'Combat',
        icon: 'fa-crosshairs',
        title: 'Combat'
    },
    skills: {
        label: 'Skills',
        icon: 'fa-chart-line',
        title: 'Skills'
    },
    party: {
        label: 'Party',
        icon: 'fa-users',
        title: 'Party'
    }
});

const MIN_PANEL_HEIGHT = 72;
const MAX_PANEL_HEIGHT = 480;

/** @type {ReturnType<typeof createController>|null} */
let activeController = null;

/**
 * @returns {ReturnType<typeof createController>|null}
 */
function getSidebarPanelsController() {
    return activeController;
}

/**
 * Ask the active sidebar controller to open a panel (unhide + expand).
 * Safe no-op when unbound. Used by inventory RMB on the equipped backpack.
 * @param {string} panelId
 * @returns {boolean}
 */
function openSidebarPanel(panelId) {
    if (!activeController || typeof activeController.openPanel !== 'function') {
        return false;
    }
    return activeController.openPanel(panelId);
}

/**
 * @param {string} panelId
 * @returns {boolean}
 */
function isSidebarPanelOpen(panelId) {
    if (!activeController || typeof activeController.isOpen !== 'function') {
        return true;
    }
    return activeController.isOpen(panelId);
}

/**
 * @returns {{ order: string[], closed: Record<string, boolean>, collapsed: Record<string, boolean>, heights: Record<string, number> }}
 */
function defaultPrefs() {
    return {
        order: DEFAULT_ORDER.slice(),
        closed: Object.create(null),
        collapsed: Object.create(null),
        heights: Object.assign(Object.create(null), DEFAULT_HEIGHTS)
    };
}

/**
 * @returns {{ order: string[], closed: Record<string, boolean>, collapsed: Record<string, boolean>, heights: Record<string, number> }}
 */
function loadPrefs() {
    const base = defaultPrefs();
    try {
        if (typeof localStorage === 'undefined') return base;
        const raw = localStorage.getItem(PREFS_KEY);
        if (!raw) {
            // Migrate legacy collapse flags only when no unified prefs yet
            for (let i = 0; i < DEFAULT_ORDER.length; i++) {
                const id = DEFAULT_ORDER[i];
                const leg = localStorage.getItem(LEGACY_COLLAPSED_PREFIX + id);
                if (leg === 'true') base.collapsed[id] = true;
            }
            return base;
        }
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return base;

        if (Array.isArray(parsed.order)) {
            const seen = new Set();
            const next = [];
            for (let i = 0; i < parsed.order.length; i++) {
                const id = String(parsed.order[i] || '');
                if (!PANEL_META[id] || seen.has(id)) continue;
                seen.add(id);
                next.push(id);
            }
            for (let i = 0; i < DEFAULT_ORDER.length; i++) {
                if (!seen.has(DEFAULT_ORDER[i])) next.push(DEFAULT_ORDER[i]);
            }
            if (next.length) base.order = next;
        }

        if (parsed.closed && typeof parsed.closed === 'object') {
            for (const id of Object.keys(PANEL_META)) {
                if (parsed.closed[id] === true) base.closed[id] = true;
            }
        }
        if (parsed.collapsed && typeof parsed.collapsed === 'object') {
            for (const id of Object.keys(PANEL_META)) {
                if (parsed.collapsed[id] === true) base.collapsed[id] = true;
            }
        }
        if (parsed.heights && typeof parsed.heights === 'object') {
            for (const id of Object.keys(PANEL_META)) {
                const n = Number(parsed.heights[id]);
                if (Number.isFinite(n)) {
                    base.heights[id] = clampHeight(n);
                }
            }
        }
    } catch (_) {
        /* private mode / bad JSON */
    }
    return base;
}

/**
 * @param {{ order: string[], closed: Record<string, boolean>, collapsed: Record<string, boolean>, heights: Record<string, number> }} prefs
 */
function savePrefs(prefs) {
    try {
        if (typeof localStorage === 'undefined') return;
        const payload = {
            order: prefs.order.slice(),
            closed: Object.assign({}, prefs.closed),
            collapsed: Object.assign({}, prefs.collapsed),
            heights: Object.assign({}, prefs.heights)
        };
        localStorage.setItem(PREFS_KEY, JSON.stringify(payload));
        // Keep legacy keys in sync so older code paths stay consistent
        for (const id of Object.keys(PANEL_META)) {
            localStorage.setItem(
                LEGACY_COLLAPSED_PREFIX + id,
                prefs.collapsed[id] ? 'true' : 'false'
            );
        }
    } catch (_) {
        /* ignore quota */
    }
}

/**
 * @param {number} h
 * @returns {number}
 */
function clampHeight(h) {
    const n = Math.round(Number(h) || 0);
    if (!Number.isFinite(n)) return DEFAULT_HEIGHTS.combat;
    return Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, n));
}

/**
 * Find the scrollable body inside a panel section.
 * @param {HTMLElement} sec
 * @returns {HTMLElement|null}
 */
function findScrollBody(sec) {
    return (
        sec.querySelector('.panel-body-scroll') ||
        sec.querySelector('.entity-panel-list-scroll') ||
        sec.querySelector('.backpack-grid-scroll') ||
        sec.querySelector('.skills-panel-scroll') ||
        null
    );
}

/**
 * Ensure each collapsible section has a close button and resize handle.
 * @param {HTMLElement} sec
 * @param {string} panelId
 */
function ensureChrome(sec, panelId) {
    const titleRow =
        sec.querySelector('.am-sidebar-title-row') ||
        sec.querySelector('.panel-title-bar');
    if (titleRow) {
        titleRow.classList.add('panel-title-bar');
        let actions = titleRow.querySelector('.panel-title-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'panel-title-actions';
            // Combat: keep sort container before close
            const sort = titleRow.querySelector('.combat-sort-container');
            if (sort) {
                titleRow.appendChild(actions);
            } else {
                titleRow.appendChild(actions);
            }
        }
        // Move combat sort into actions if present as sibling
        const sort = titleRow.querySelector('.combat-sort-container');
        if (sort && sort.parentElement === titleRow && !actions.contains(sort)) {
            actions.appendChild(sort);
        }
        let closeBtn = actions.querySelector('.panel-close-btn');
        if (!closeBtn) {
            closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'panel-close-btn';
            closeBtn.setAttribute('aria-label', 'Close panel');
            closeBtn.setAttribute(
                'title',
                `Close ${PANEL_META[panelId] ? PANEL_META[panelId].label : 'panel'}`
            );
            closeBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
            actions.appendChild(closeBtn);
        }
    }

    // Wrap content children in a scroll body if missing (for height clamp)
    const content = sec.querySelector('.panel-collapsible-content');
    if (content) {
        let scroll = findScrollBody(sec);
        if (!scroll) {
            scroll = document.createElement('div');
            scroll.className = 'panel-body-scroll';
            while (content.firstChild) {
                scroll.appendChild(content.firstChild);
            }
            content.appendChild(scroll);
        } else {
            scroll.classList.add('panel-body-scroll');
        }
    }

    let handle = sec.querySelector('.panel-resize-handle');
    if (!handle) {
        handle = document.createElement('div');
        handle.className = 'panel-resize-handle';
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'horizontal');
        handle.setAttribute('aria-label', 'Resize panel height');
        handle.title = 'Drag to resize height';
        sec.appendChild(handle);
    }
}

/**
 * Build or refresh icon toggle row under equipment.
 * @param {HTMLElement} root
 * @param {{ order: string[], closed: Record<string, boolean> }} prefs
 * @param {(id: string) => void} onToggle
 * @returns {HTMLElement|null}
 */
function ensureToggleBar(root, prefs, onToggle) {
    let bar = root.querySelector('#sidebarPanelToggles');
    if (!bar) {
        const equip = root.querySelector('.game-equipment-panel');
        bar = document.createElement('div');
        bar.id = 'sidebarPanelToggles';
        bar.className = 'sidebar-panel-toggles';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Open or close sidebar panels');
        if (equip && equip.parentElement === root) {
            if (equip.nextSibling) {
                root.insertBefore(bar, equip.nextSibling);
            } else {
                root.appendChild(bar);
            }
        } else {
            root.insertBefore(bar, root.firstChild);
        }
    }

    const order = prefs.order && prefs.order.length ? prefs.order : DEFAULT_ORDER.slice();
    // Stable button order matching default panel order (not drag order of open panels)
    const ids = DEFAULT_ORDER.slice();
    for (let i = 0; i < order.length; i++) {
        if (ids.indexOf(order[i]) < 0) ids.push(order[i]);
    }

    bar.innerHTML = '';
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const meta = PANEL_META[id];
        if (!meta) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sidebar-panel-toggle-btn';
        btn.dataset.panelToggle = id;
        btn.setAttribute('aria-label', meta.label);
        btn.title = prefs.closed[id]
            ? `Open ${meta.label}`
            : `Close ${meta.label}`;
        btn.setAttribute('aria-pressed', prefs.closed[id] ? 'false' : 'true');
        if (prefs.closed[id]) btn.classList.add('is-closed');
        else btn.classList.add('is-open');
        btn.innerHTML = `<i class="fa-solid ${meta.icon}" aria-hidden="true"></i>`;
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            onToggle(id);
        });
        bar.appendChild(btn);
    }
    return bar;
}

/**
 * @param {HTMLElement} root .am-sidebar-body
 * @param {string[]} order
 */
function applyOrder(root, order) {
    const sections = [];
    for (let i = 0; i < order.length; i++) {
        const sec = root.querySelector(
            `.panel-collapsible-section[data-panel-id="${order[i]}"]`
        );
        if (sec) sections.push(sec);
    }
    // Append in order after fixed nodes (equipment + toggles)
    for (let i = 0; i < sections.length; i++) {
        root.appendChild(sections[i]);
    }
}

/**
 * Create the live controller (DOM + prefs).
 * @returns {{
 *   dispose: () => void,
 *   openPanel: (id: string) => boolean,
 *   closePanel: (id: string) => boolean,
 *   isOpen: (id: string) => boolean,
 *   setCollapsed: (id: string, collapsed: boolean) => void,
 *   isCollapsed: (id: string) => boolean,
 *   refreshToggles: () => void
 * }}
 */
function createController() {
    if (typeof document === 'undefined') {
        return {
            dispose: () => {},
            openPanel: () => false,
            closePanel: () => false,
            isOpen: () => true,
            setCollapsed: () => {},
            isCollapsed: () => false,
            refreshToggles: () => {}
        };
    }

    const root =
        document.querySelector('.game-inventory-panel .am-sidebar-body') ||
        document.querySelector('.game-inventory-panel');
    if (!root) {
        return {
            dispose: () => {},
            openPanel: () => false,
            closePanel: () => false,
            isOpen: () => true,
            setCollapsed: () => {},
            isCollapsed: () => false,
            refreshToggles: () => {}
        };
    }

    const prefs = loadPrefs();
    /** @type {Array<{ el: EventTarget, type: string, fn: EventListener, opts?: boolean|AddEventListenerOptions }>} */
    const listeners = [];
    /** @type {Map<string, HTMLElement>} */
    const sectionById = new Map();

    /**
     * @param {EventTarget} el
     * @param {string} type
     * @param {EventListener} fn
     * @param {boolean|AddEventListenerOptions} [opts]
     */
    const on = (el, type, fn, opts) => {
        el.addEventListener(type, fn, opts);
        listeners.push({ el, type, fn, opts });
    };

    const sections = root.querySelectorAll('.panel-collapsible-section[data-panel-id]');
    sections.forEach((sec) => {
        const panelId = sec.getAttribute('data-panel-id');
        if (!panelId || !PANEL_META[panelId]) return;
        sectionById.set(panelId, /** @type {HTMLElement} */ (sec));
        ensureChrome(/** @type {HTMLElement} */ (sec), panelId);
    });

    // Include any panel ids present in DOM but not in DEFAULT_ORDER
    sectionById.forEach((_sec, id) => {
        if (prefs.order.indexOf(id) < 0) prefs.order.push(id);
    });

    /**
     * @param {string} panelId
     * @param {boolean} collapsed
     */
    const applyCollapsed = (panelId, collapsed) => {
        const sec = sectionById.get(panelId);
        if (!sec) return;
        const content = sec.querySelector('.panel-collapsible-content');
        const icon = sec.querySelector('.panel-toggle-icon');
        const handle = sec.querySelector('.panel-resize-handle');
        if (collapsed) {
            sec.classList.add('panel-collapsed');
            if (content) /** @type {HTMLElement} */ (content).style.display = 'none';
            if (handle) /** @type {HTMLElement} */ (handle).style.display = 'none';
            if (icon) {
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-right');
            }
            prefs.collapsed[panelId] = true;
        } else {
            sec.classList.remove('panel-collapsed');
            if (content) /** @type {HTMLElement} */ (content).style.display = '';
            if (handle) /** @type {HTMLElement} */ (handle).style.display = '';
            if (icon) {
                icon.classList.remove('fa-chevron-right');
                icon.classList.add('fa-chevron-down');
            }
            delete prefs.collapsed[panelId];
        }
    };

    /**
     * @param {string} panelId
     * @param {boolean} open
     */
    const applyOpen = (panelId, open) => {
        const sec = sectionById.get(panelId);
        if (!sec) return;
        if (open) {
            sec.classList.remove('panel-closed');
            sec.hidden = false;
            sec.style.display = '';
            delete prefs.closed[panelId];
            // Opening also expands content so the user sees the panel body
            applyCollapsed(panelId, false);
        } else {
            sec.classList.add('panel-closed');
            sec.hidden = true;
            sec.style.display = 'none';
            prefs.closed[panelId] = true;
        }
    };

    /**
     * @param {string} panelId
     * @param {number} height
     */
    const applyHeight = (panelId, height) => {
        const sec = sectionById.get(panelId);
        if (!sec) return;
        const h = clampHeight(height);
        prefs.heights[panelId] = h;
        const scroll = findScrollBody(sec);
        if (scroll) {
            scroll.style.maxHeight = `${h}px`;
            scroll.style.overflowY = 'auto';
        }
    };

    const refreshToggles = () => {
        ensureToggleBar(/** @type {HTMLElement} */ (root), prefs, (id) => {
            if (prefs.closed[id]) {
                applyOpen(id, true);
            } else {
                applyOpen(id, false);
            }
            savePrefs(prefs);
            refreshToggles();
        });
    };

    // Initial paint
    applyOrder(/** @type {HTMLElement} */ (root), prefs.order);
    for (const id of sectionById.keys()) {
        applyOpen(id, !prefs.closed[id]);
        if (!prefs.closed[id]) {
            applyCollapsed(id, !!prefs.collapsed[id]);
        }
        applyHeight(id, prefs.heights[id] != null ? prefs.heights[id] : DEFAULT_HEIGHTS[id] || 210);
    }
    refreshToggles();
    savePrefs(prefs);

    // Per-section interactions
    sectionById.forEach((sec, panelId) => {
        const header = sec.querySelector('.panel-toggle-header');
        const closeBtn = sec.querySelector('.panel-close-btn');
        const handle = sec.querySelector('.panel-resize-handle');
        const titleBar = sec.querySelector('.panel-title-bar');

        if (header) {
            const onClick = (ev) => {
                const t = /** @type {Element|null} */ (ev.target);
                if (
                    t &&
                    (t.closest('button') ||
                        t.closest('.combat-sort-container') ||
                        t.closest('.panel-title-actions') ||
                        t.closest('.panel-close-btn') ||
                        t.closest('.panel-resize-handle'))
                ) {
                    return;
                }
                if (prefs.closed[panelId]) return;
                applyCollapsed(panelId, !prefs.collapsed[panelId]);
                savePrefs(prefs);
            };
            const onKey = (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    onClick(ev);
                }
            };
            on(header, 'click', onClick);
            on(header, 'keydown', onKey);
        }

        if (closeBtn) {
            on(closeBtn, 'click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                applyOpen(panelId, false);
                savePrefs(prefs);
                refreshToggles();
            });
        }

        // Resize by dragging bottom handle
        if (handle) {
            /** @type {{ startY: number, startH: number }|null} */
            let resize = null;
            on(handle, 'pointerdown', (ev) => {
                if (prefs.closed[panelId] || prefs.collapsed[panelId]) return;
                const pe = /** @type {PointerEvent} */ (ev);
                if (pe.button != null && pe.button !== 0) return;
                pe.preventDefault();
                pe.stopPropagation();
                const cur =
                    prefs.heights[panelId] != null
                        ? prefs.heights[panelId]
                        : DEFAULT_HEIGHTS[panelId] || 210;
                resize = { startY: pe.clientY, startH: cur };
                try {
                    handle.setPointerCapture(pe.pointerId);
                } catch (_) {}
                sec.classList.add('is-resizing');
            });
            on(handle, 'pointermove', (ev) => {
                if (!resize) return;
                const pe = /** @type {PointerEvent} */ (ev);
                const next = clampHeight(resize.startH + (pe.clientY - resize.startY));
                applyHeight(panelId, next);
            });
            const endResize = () => {
                if (!resize) return;
                resize = null;
                sec.classList.remove('is-resizing');
                savePrefs(prefs);
            };
            on(handle, 'pointerup', endResize);
            on(handle, 'pointercancel', endResize);
        }

        // Drag title bar to reorder
        if (titleBar) {
            titleBar.setAttribute('draggable', 'true');
            on(titleBar, 'dragstart', (ev) => {
                const de = /** @type {DragEvent} */ (ev);
                const t = /** @type {Element|null} */ (de.target);
                if (
                    t &&
                    (t.closest('button') ||
                        t.closest('.combat-sort-container') ||
                        t.closest('.panel-title-actions') ||
                        t.closest('input') ||
                        t.closest('select'))
                ) {
                    de.preventDefault();
                    return;
                }
                if (de.dataTransfer) {
                    de.dataTransfer.effectAllowed = 'move';
                    de.dataTransfer.setData('text/plain', panelId);
                }
                sec.classList.add('is-dragging-panel');
            });
            on(titleBar, 'dragend', () => {
                sec.classList.remove('is-dragging-panel');
                sectionById.forEach((s) => s.classList.remove('panel-drop-target'));
            });
            on(sec, 'dragover', (ev) => {
                const de = /** @type {DragEvent} */ (ev);
                de.preventDefault();
                if (de.dataTransfer) de.dataTransfer.dropEffect = 'move';
                sec.classList.add('panel-drop-target');
            });
            on(sec, 'dragleave', () => {
                sec.classList.remove('panel-drop-target');
            });
            on(sec, 'drop', (ev) => {
                const de = /** @type {DragEvent} */ (ev);
                de.preventDefault();
                sec.classList.remove('panel-drop-target');
                const fromId =
                    (de.dataTransfer && de.dataTransfer.getData('text/plain')) || '';
                if (!fromId || fromId === panelId || !sectionById.has(fromId)) return;
                const order = prefs.order.slice();
                const fromIdx = order.indexOf(fromId);
                const toIdx = order.indexOf(panelId);
                if (fromIdx < 0 || toIdx < 0) return;
                order.splice(fromIdx, 1);
                const insertAt = order.indexOf(panelId);
                order.splice(insertAt < 0 ? order.length : insertAt, 0, fromId);
                prefs.order = order;
                applyOrder(/** @type {HTMLElement} */ (root), prefs.order);
                savePrefs(prefs);
            });
        }
    });

    // External open requests (inventory RMB on equipped backpack)
    const onOpenEvent = (ev) => {
        const detail = /** @type {CustomEvent} */ (ev).detail || {};
        const id = detail.id || detail.panelId;
        if (id) openPanel(String(id));
    };
    on(document, 'hdl:open-sidebar-panel', onOpenEvent);

    /**
     * @param {string} panelId
     * @returns {boolean}
     */
    function openPanel(panelId) {
        if (!sectionById.has(panelId)) return false;
        applyOpen(panelId, true);
        savePrefs(prefs);
        refreshToggles();
        return true;
    }

    /**
     * @param {string} panelId
     * @returns {boolean}
     */
    function closePanel(panelId) {
        if (!sectionById.has(panelId)) return false;
        applyOpen(panelId, false);
        savePrefs(prefs);
        refreshToggles();
        return true;
    }

    /** @type {ReturnType<typeof createController>} */
    const controller = {
        dispose: () => {
            listeners.forEach(({ el, type, fn, opts }) => {
                el.removeEventListener(type, fn, opts);
            });
            listeners.length = 0;
            if (activeController === controller) activeController = null;
        },
        openPanel,
        closePanel,
        isOpen: (id) => !prefs.closed[id],
        setCollapsed: (id, collapsed) => {
            if (!sectionById.has(id) || prefs.closed[id]) return;
            applyCollapsed(id, !!collapsed);
            savePrefs(prefs);
        },
        isCollapsed: (id) => !!prefs.collapsed[id],
        refreshToggles
    };
    return controller;
}

/**
 * Wire sidebar panel chrome (collapse, close, reorder, resize, toggles).
 * Replaces the older collapse-only bindCollapsiblePanels.
 * @returns {ReturnType<typeof createController>}
 */
function bindSidebarPanels() {
    if (activeController && typeof activeController.dispose === 'function') {
        activeController.dispose();
    }
    const api = createController();
    activeController = api;
    return api;
}

/** @deprecated Use bindSidebarPanels */
function bindCollapsiblePanels() {
    return bindSidebarPanels();
}

module.exports = {
    PREFS_KEY,
    LEGACY_COLLAPSED_PREFIX,
    DEFAULT_ORDER,
    DEFAULT_HEIGHTS,
    PANEL_META,
    MIN_PANEL_HEIGHT,
    MAX_PANEL_HEIGHT,
    defaultPrefs,
    loadPrefs,
    savePrefs,
    clampHeight,
    bindSidebarPanels,
    bindCollapsiblePanels,
    getSidebarPanelsController,
    openSidebarPanel,
    isSidebarPanelOpen
};
