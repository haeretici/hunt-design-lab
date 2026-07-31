/**
 * Live inventory UI — root backpack grid, nested container panels, equip drag.
 *
 * Outside the logic tick: polls active player inventory and mutates via
 * inventory helpers + player.applyInventoryMutation().
 *
 * Interaction:
 *   - Left click: select item
 *   - Left drag (hold + move): move / swap into target slot
 *   - Drag bag → canvas: drop on walkable tile (engage range + path)
 *   - Drag ground item → bag: pick up (Chebyshev ≤ 1)
 *   - Right click: context menu (details, equip/unequip, open container, drop/pick)
 */

'use strict';

const { Settings } = require('../../settings.js');
const { findItem } = require('../../core/lib/character/stats.js');
const { uiState, enterTargetCursorMode } = require('./ui_state.js');
const {
    ROOT_UID,
    itemIsContainer,
    itemIsMultiUse,
    itemIsUsable,
    itemIsEquipable,
    moveItem,
    equipItem,
    unequipItem,
    preferredEquipSlot,
    canEquipInSlot,
    totalCarriedWeight,
    remainingCapacity,
    designerSlotToEngine,
    getItem,
    getContainer,
    ensureItemContainer
} = require('../../core/lib/character/inventory.js');
const {
    dropItemToGround,
    pickupItemFromGround,
    canDropToTile,
    canPickupFromTile,
    peekTop,
    getStack
} = require('../../core/lib/character/ground_items.js');

/** Orange system floats (cap / room) — matches watch combat-text style. */
const FLOAT_SYSTEM_COLOR = '#f59e0b';
const {
    resolveItemSpriteUrl,
    getActivePlayerFromSim,
    showEquipmentItemModal
} = require('./equipment_panel.js');
const { tryHandleSlotDrop } = require('./action_bars.js');

const DRAG_THRESHOLD_PX = 5;

/**
 * @param {object|null|undefined} item
 * @returns {string}
 */
function itemLabel(item) {
    if (!item) return 'Item';
    return item.label || item.name || item.id || 'Item';
}

/**
 * Wire backpack + equipment card interaction for the active player.
 *
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {() => object[]|Record<string, object>|null} opts.getItemDb
 * @param {() => string} [opts.getGenre]
 * @param {() => boolean} [opts.isSessionLive]
 * @param {() => void} [opts.onMutation] refresh equipment card after changes
 * @param {() => void} [opts.onMutationPaint] force canvas repaint (ground + floats)
 * @param {string|HTMLCanvasElement} [opts.canvas] watch canvas (default #gameCanvas)
 * @param {number} [opts.intervalMs=250]
 * @returns {{ refresh: () => void, dispose: () => void }}
 */
function bindInventoryPanel(opts) {
    const o = opts || {};
    const gridEl = document.getElementById('backpackGrid');
    const scrollEl =
        document.getElementById('backpackScroll') ||
        (gridEl && gridEl.parentElement);
    const panelEl = document.querySelector('.game-backpack-panel');
    const cardEl = document.getElementById('activeEquipmentCard');
    const capEl = document.getElementById('activeEqCap');
    const titleEl = panelEl
        ? panelEl.querySelector('.am-sidebar-title')
        : null;
    /** @type {HTMLCanvasElement|null} */
    let canvasEl = null;
    if (o.canvas && typeof o.canvas === 'object' && o.canvas.getContext) {
        canvasEl = /** @type {HTMLCanvasElement} */ (o.canvas);
    } else if (typeof o.canvas === 'string') {
        canvasEl = /** @type {HTMLCanvasElement|null} */ (
            document.getElementById(o.canvas)
        );
    } else {
        canvasEl = /** @type {HTMLCanvasElement|null} */ (
            document.getElementById('gameCanvas')
        );
    }

    /** @type {HTMLElement|null} */
    let floatRoot = document.getElementById('inventoryFloatRoot');
    if (!floatRoot && typeof document !== 'undefined') {
        floatRoot = document.createElement('div');
        floatRoot.id = 'inventoryFloatRoot';
        floatRoot.className = 'inv-float-root';
        document.body.appendChild(floatRoot);
    }

    /** @type {HTMLElement|null} */
    let ctxMenu = null;
    /** @type {string|null} selected item uid */
    let selectedUid = null;
    /** Open nested container panels: uid → { el, containerUid } */
    /** @type {Map<string, { el: HTMLElement, containerUid: string }>} */
    const openPanels = new Map();
    /** @type {string} last painted signature */
    let lastSig = '';
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;

    /** @type {{ uid: string, from: object, startX: number, startY: number, dragging: boolean, ghost: HTMLElement|null, pointerId: number, captureEl: HTMLElement|null, source?: 'inventory'|'ground', groundTile?: {x:number,y:number,z:string|number}, onMove?: (e: PointerEvent) => void, onEnd?: (e: PointerEvent) => void }|null} */
    let dragState = null;

    const genreOf = () => {
        if (typeof o.getGenre === 'function') {
            const g = o.getGenre();
            if (g) return String(g);
        }
        return 'rpg_fantasy';
    };

    const itemDbOf = () =>
        typeof o.getItemDb === 'function' ? o.getItemDb() : null;

    const liveOf = () =>
        typeof o.isSessionLive === 'function' ? !!o.isSessionLive() : false;

    const simOf = () =>
        typeof o.getSim === 'function' ? o.getSim() : null;

    /**
     * Client coords → map tile under the watch canvas (CSS-scale aware).
     * @param {number} clientX
     * @param {number} clientY
     * @returns {{ x: number, y: number, z: string|number }|null}
     */
    function clientToTile(clientX, clientY) {
        if (!canvasEl) return null;
        const sim = simOf();
        if (!sim || !sim.tileMap) return null;
        const rect = canvasEl.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        if (
            clientX < rect.left ||
            clientX > rect.right ||
            clientY < rect.top ||
            clientY > rect.bottom
        ) {
            return null;
        }
        const scaleX = (canvasEl.width || rect.width) / rect.width;
        const scaleY = (canvasEl.height || rect.height) / rect.height;
        const cx = (clientX - rect.left) * scaleX;
        const cy = (clientY - rect.top) * scaleY;
        const tw = Settings.tileWidth || 32;
        const th = Settings.tileHeight || 32;
        const ox = sim.tileMap._viewOriginX || 0;
        const oy = sim.tileMap._viewOriginY || 0;
        const x = Math.floor(cx / tw) + ox;
        const y = Math.floor(cy / th) + oy;
        const z =
            sim.tileMap._viewZ != null
                ? sim.tileMap._viewZ
                : Settings.cameraTileZ != null
                  ? Settings.cameraTileZ
                  : 0;
        return { x, y, z };
    }

    /**
     * @param {string} uid
     * @param {object|null} item
     * @returns {HTMLElement}
     */
    function makeDragGhost(uid, item) {
        const ghost = document.createElement('div');
        ghost.className = 'inv-drag-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        const url = item ? resolveItemSpriteUrl(item, genreOf()) : null;
        if (url) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = '';
            img.draggable = false;
            ghost.appendChild(img);
        } else {
            ghost.textContent = itemLabel(item).slice(0, 3);
        }
        document.body.appendChild(ghost);
        return ghost;
    }

    /**
     * @returns {object|null} active Player with inventory
     */
    const activePlayer = () => {
        if (!liveOf()) return null;
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        return getActivePlayerFromSim(sim);
    };

    const requestCanvasPaint = () => {
        if (typeof o.onMutationPaint === 'function') {
            o.onMutationPaint();
            return;
        }
        if (
            typeof window !== 'undefined' &&
            window.Application &&
            typeof window.Application.paintOnce === 'function'
        ) {
            window.Application.paintOnce();
        }
    };

    const notifyMutation = () => {
        const player = activePlayer();
        if (player && typeof player.applyInventoryMutation === 'function') {
            player.applyInventoryMutation();
        }
        lastSig = '';
        paint();
        if (typeof o.onMutation === 'function') o.onMutation();
        // Keep ground stacks / FCT visible after terminal freeze (practice mode)
        requestCanvasPaint();
    };

    /**
     * Watch-mode floating system text above the active player (cap / room).
     * @param {object|null|undefined} player
     * @param {string} text
     * @param {string} [color]
     */
    function emitSystemFloat(player, text, color) {
        const sim = simOf();
        if (!sim || !text) return;
        if (typeof sim.emitCombatText !== 'function') return;
        const tile = player && player.tile ? player.tile : null;
        const x = tile ? tile.x : 0;
        const y = tile ? tile.y : 0;
        const z =
            tile && tile.z !== undefined && tile.z !== null ? tile.z : undefined;
        sim.emitCombatText({
            x,
            y,
            z,
            text: String(text),
            color: color || FLOAT_SYSTEM_COLOR,
            life: 1.1
        });
        requestCanvasPaint();
    }

    /**
     * @param {{ ok: boolean, error?: string }} result
     * @param {object|null|undefined} player
     */
    function handlePickupResult(result, player) {
        if (!result) return;
        if (result.ok) {
            notifyMutation();
            return;
        }
        if (result.error === 'not_enough_cap') {
            emitSystemFloat(player, 'Not enough cap');
        } else if (
            result.error === 'not_enough_room' ||
            result.error === 'full'
        ) {
            emitSystemFloat(player, 'Not enough room');
        }
    }

    /**
     * @param {HTMLElement} slotEl
     * @param {string|null} uid
     * @param {object|null} item
     * @param {string} genre
     */
    function paintSlotContent(slotEl, uid, item, genre) {
        const itemId = item && item.id != null ? String(item.id) : '';
        const player = activePlayer();
        const inv = player && player.inventory;
        const inst = uid && inv ? getItem(inv, uid) : null;
        const stackCount =
            inst && inst.count != null && Number(inst.count) > 1
                ? Math.floor(Number(inst.count))
                : 1;
        const paintKey = uid
            ? `${genre}::${uid}::${itemId}::${stackCount}`
            : '';
        // Always refresh selection / type flags (cheap class toggles)
        slotEl.classList.toggle('is-filled', !!uid);
        slotEl.classList.toggle('is-selected', !!uid && uid === selectedUid);
        slotEl.classList.toggle(
            'is-container',
            !!(item && itemIsContainer(item))
        );
        // Skip wiping <img> when the slot still holds the same instance + count
        if (slotEl.dataset.paintedKey === paintKey) {
            if (uid) {
                slotEl.dataset.itemUid = uid;
                const base = itemLabel(item);
                slotEl.title =
                    stackCount > 1 ? `${base} x${stackCount}` : base;
            }
            return;
        }
        slotEl.dataset.paintedKey = paintKey;
        slotEl.innerHTML = '';
        if (!uid) {
            slotEl.removeAttribute('data-item-uid');
            slotEl.title = '';
            return;
        }
        slotEl.dataset.itemUid = uid;
        const label = itemLabel(item);
        slotEl.title = stackCount > 1 ? `${label} x${stackCount}` : label;
        if (item) {
            const img = document.createElement('img');
            const url = resolveItemSpriteUrl(item, genre);
            if (url) img.src = url;
            img.alt = label;
            img.draggable = false;
            img.onerror = () => {
                slotEl.textContent = label.slice(0, 3);
            };
            slotEl.appendChild(img);
            if (stackCount > 1) {
                const badge = document.createElement('span');
                badge.className = 'inv-stack-count';
                badge.textContent = String(stackCount);
                slotEl.appendChild(badge);
            }
        } else {
            slotEl.textContent = '?';
        }
    }

    /**
     * @param {HTMLElement} grid
     * @param {string} containerUid
     * @param {object} inv
     * @param {object[]|Record<string, object>|null} itemDb
     * @param {string} genre
     */
    function renderContainerGrid(grid, containerUid, inv, itemDb, genre) {
        const cont = getContainer(inv, containerUid);
        if (!cont) {
            grid.innerHTML = '';
            return;
        }
        const cap = cont.capacity;
        // Rebuild slots if count changed
        const existing = grid.querySelectorAll('.backpack-slot, .inv-slot');
        if (existing.length !== cap) {
            grid.innerHTML = '';
            for (let i = 0; i < cap; i++) {
                const slot = document.createElement('div');
                slot.className = 'backpack-slot inv-slot';
                slot.dataset.slotIndex = String(i);
                slot.dataset.containerUid = containerUid;
                slot.setAttribute('role', 'button');
                slot.tabIndex = 0;
                grid.appendChild(slot);
            }
        }
        const slots = grid.querySelectorAll('.backpack-slot, .inv-slot');
        for (let i = 0; i < slots.length; i++) {
            const slotEl = /** @type {HTMLElement} */ (slots[i]);
            slotEl.dataset.slotIndex = String(i);
            slotEl.dataset.containerUid = containerUid;
            const uid = cont.slots[i] || null;
            const inst = uid ? getItem(inv, uid) : null;
            const item = inst ? findItem(itemDb, inst.itemId) : null;
            paintSlotContent(slotEl, uid, item, genre);
        }
    }

    /**
     * @param {object} player
     * @param {object[]|Record<string, object>|null} itemDb
     * @param {string} genre
     */
    function paintEquipmentCardInteractive(player, itemDb, genre) {
        if (!cardEl || !player || !player.inventory) return;
        const inv = player.inventory;
        const slots = cardEl.querySelectorAll('.slot-item[data-slot]');
        for (let i = 0; i < slots.length; i++) {
            const slotEl = /** @type {HTMLElement} */ (slots[i]);
            const designer = slotEl.getAttribute('data-slot');
            if (!designer || designer === 'light') continue;
            const engine = designerSlotToEngine(designer);
            if (!engine) continue;
            slotEl.dataset.equipSlot = engine;
            slotEl.classList.add('inv-equip-slot');
            const uid = inv.equipment[engine] || null;
            const inst = uid ? getItem(inv, uid) : null;
            // Leave visual to equipment_panel paint; only ensure data attrs + selection
            slotEl.classList.toggle('is-selected', !!uid && uid === selectedUid);
            if (uid) slotEl.dataset.itemUid = uid;
            else slotEl.removeAttribute('data-item-uid');
            // If equipment_panel hasn't painted yet, show item briefly
            if (uid && !slotEl.querySelector('img') && inst) {
                const item = findItem(itemDb, inst.itemId);
                paintSlotContent(slotEl, uid, item, genre);
            }
        }
    }

    function updateCapDisplay(player, itemDb) {
        if (!capEl || !player) return;
        if (typeof player.getRemainingCapacity === 'function') {
            capEl.textContent = player.getRemainingCapacity().toLocaleString();
            return;
        }
        if (player.inventory) {
            const w = totalCarriedWeight(player.inventory, itemDb);
            capEl.textContent = remainingCapacity(
                player.level || 1,
                w,
                player.classId
            ).toLocaleString();
        }
    }

    function paint() {
        const player = activePlayer();
        const itemDb = itemDbOf();
        const genre = genreOf();

        if (!player || !player.inventory) {
            if (gridEl) {
                // Idle / no inventory: empty panel (no phantom slots)
                const invStub = {
                    containers: {
                        [ROOT_UID]: {
                            capacity: 0,
                            slots: []
                        }
                    },
                    rootUid: ROOT_UID,
                    items: {},
                    equipment: {},
                    nextUid: 1
                };
                renderContainerGrid(gridEl, ROOT_UID, invStub, itemDb, genre);
            }
            if (titleEl) titleEl.textContent = 'Backpack';
            closeAllPanels();
            hideContextMenu();
            lastSig = 'idle';
            return;
        }

        const inv = player.inventory;
        const root = getContainer(inv, inv.rootUid || ROOT_UID);
        /**
         * Include stack counts so ammo spend / merge repaints badges.
         * @param {import('../../core/lib/character/inventory.js').InventoryContainer|null} cont
         */
        function containerSig(cont) {
            if (!cont || !Array.isArray(cont.slots)) return '';
            return cont.slots
                .map((u) => {
                    if (!u) return '';
                    const inst = inv.items[u];
                    const c =
                        inst && inst.count != null
                            ? Math.floor(Number(inst.count)) || 1
                            : 1;
                    return `${u}:${c}`;
                })
                .join(',');
        }
        const sigParts = [
            player.id,
            player.level,
            JSON.stringify(inv.equipment),
            containerSig(root),
            selectedUid || '',
            Array.from(openPanels.keys()).join('|')
        ];
        // Include nested open panel slot signatures
        openPanels.forEach((p) => {
            const c = getContainer(inv, p.containerUid);
            sigParts.push(containerSig(c));
        });
        const sig = sigParts.join('::');
        if (sig === lastSig) {
            updateCapDisplay(player, itemDb);
            return;
        }
        lastSig = sig;

        if (gridEl) {
            renderContainerGrid(
                gridEl,
                inv.rootUid || ROOT_UID,
                inv,
                itemDb,
                genre
            );
        }
        if (titleEl) {
            const n = root ? root.capacity : 0;
            // Equipped backpack is the main open container — show its name
            const rootInst =
                inv.rootUid && inv.rootUid !== ROOT_UID
                    ? getItem(inv, inv.rootUid)
                    : null;
            const rootItem = rootInst
                ? findItem(itemDb, rootInst.itemId)
                : null;
            const name = rootItem ? itemLabel(rootItem) : 'Backpack';
            titleEl.textContent =
                n > 0 ? `${name} (${n})` : name;
        }
        paintEquipmentCardInteractive(player, itemDb, genre);
        updateCapDisplay(player, itemDb);

        // Refresh open floating panels
        openPanels.forEach((p, key) => {
            if (!getContainer(inv, p.containerUid) && p.containerUid !== inv.rootUid) {
                // container destroyed
                p.el.remove();
                openPanels.delete(key);
                return;
            }
            const g = p.el.querySelector('.backpack-grid, .inv-panel-grid');
            if (g) {
                renderContainerGrid(
                    /** @type {HTMLElement} */ (g),
                    p.containerUid,
                    inv,
                    itemDb,
                    genre
                );
            }
            const h = p.el.querySelector('.inv-panel-title');
            if (h) {
                const inst = getItem(inv, p.containerUid);
                const item = inst ? findItem(itemDb, inst.itemId) : null;
                h.textContent = itemLabel(item) || 'Container';
            }
        });
    }

    /**
     * @param {string} containerUid
     * @param {{ forceNew?: boolean, x?: number, y?: number }} [opts]
     */
    function openContainerPanel(containerUid, opts) {
        const player = activePlayer();
        if (!player || !player.inventory || !floatRoot) return;
        const inv = player.inventory;
        if (containerUid === inv.rootUid) return; // already main panel
        // Repair missing container slots (equipped quiver/bag must open like nested bags)
        const cont =
            getContainer(inv, containerUid) ||
            ensureItemContainer(inv, containerUid, itemDbOf());
        if (!cont) return;
        const o2 = opts || {};
        const key = o2.forceNew
            ? containerUid + '#' + Date.now()
            : containerUid;

        if (!o2.forceNew && openPanels.has(containerUid)) {
            const existing = openPanels.get(containerUid);
            if (existing) {
                existing.el.classList.add('is-focused');
                existing.el.style.zIndex = String(1000 + openPanels.size);
                return;
            }
        }

        const itemDb = itemDbOf();
        const inst = getItem(inv, containerUid);
        const item = inst ? findItem(itemDb, inst.itemId) : null;

        const el = document.createElement('div');
        el.className = 'inv-float-panel';
        el.dataset.containerUid = containerUid;
        const left = o2.x != null ? o2.x : 80 + openPanels.size * 24;
        const top = o2.y != null ? o2.y : 120 + openPanels.size * 24;
        el.style.left = left + 'px';
        el.style.top = top + 'px';

        const header = document.createElement('div');
        header.className = 'inv-panel-header';
        const title = document.createElement('span');
        title.className = 'inv-panel-title';
        title.textContent = itemLabel(item) || 'Container';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'inv-panel-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', () => {
            el.remove();
            openPanels.delete(key);
            if (key !== containerUid) {
                /* unique key */
            } else {
                openPanels.delete(containerUid);
            }
            lastSig = '';
            paint();
        });
        header.appendChild(title);
        header.appendChild(closeBtn);

        const scroll = document.createElement('div');
        scroll.className = 'backpack-grid-scroll inv-panel-scroll';
        const grid = document.createElement('div');
        grid.className = 'backpack-grid inv-panel-grid';
        scroll.appendChild(grid);
        el.appendChild(header);
        el.appendChild(scroll);
        floatRoot.appendChild(el);

        // Drag panel by header
        let pan = /** @type {{ x: number, y: number, sl: number, st: number }|null} */ (null);
        header.addEventListener('pointerdown', (ev) => {
            if (/** @type {HTMLElement} */ (ev.target).closest('button')) return;
            pan = {
                x: ev.clientX,
                y: ev.clientY,
                sl: el.offsetLeft,
                st: el.offsetTop
            };
            header.setPointerCapture(ev.pointerId);
        });
        header.addEventListener('pointermove', (ev) => {
            if (!pan) return;
            el.style.left = pan.sl + (ev.clientX - pan.x) + 'px';
            el.style.top = pan.st + (ev.clientY - pan.y) + 'px';
        });
        header.addEventListener('pointerup', () => {
            pan = null;
        });

        openPanels.set(key, { el, containerUid });
        renderContainerGrid(grid, containerUid, inv, itemDb, genreOf());
        lastSig = '';
        paint();
    }

    function closeAllPanels() {
        openPanels.forEach((p) => p.el.remove());
        openPanels.clear();
    }

    function hideContextMenu() {
        if (ctxMenu) {
            ctxMenu.remove();
            ctxMenu = null;
        }
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {string} uid
     */
    function showContextMenu(x, y, uid) {
        hideContextMenu();
        const player = activePlayer();
        if (!player || !player.inventory) return;
        const inv = player.inventory;
        const inst = getItem(inv, uid);
        if (!inst) return;
        const itemDb = itemDbOf();
        const item = findItem(itemDb, inst.itemId);
        const isCont = itemIsContainer(item);
        const isEquipped =
            inst.location && inst.location.kind === 'equipment';
        const equipSlot = preferredEquipSlot(item);

        ctxMenu = document.createElement('div');
        ctxMenu.className = 'inv-context-menu';
        ctxMenu.style.left = x + 'px';
        ctxMenu.style.top = y + 'px';

        /**
         * @param {string} label
         * @param {() => void} fn
         * @param {boolean} [disabled]
         */
        const addItem = (label, fn, disabled) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'inv-context-item';
            btn.textContent = label;
            if (disabled) {
                btn.disabled = true;
            } else {
                btn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    hideContextMenu();
                    fn();
                });
            }
            ctxMenu.appendChild(btn);
        };

        addItem('View details', () => {
            // Same stats modal as profile_preview equipment click
            const catalogItem =
                item ||
                (inst
                    ? { id: inst.itemId, label: inst.itemId }
                    : null);
            if (!catalogItem) return;
            showEquipmentItemModal(catalogItem, {
                slotKey:
                    (catalogItem.slot != null && String(catalogItem.slot)) ||
                    (isEquipped && inst.location && inst.location.kind === 'equipment'
                        ? inst.location.slot
                        : preferredEquipSlot(catalogItem)) ||
                    null,
                genre: genreOf()
            });
        });

        if (!isEquipped && equipSlot && canEquipInSlot(item, equipSlot)) {
            addItem('Equip', () => {
                const r = equipItem(inv, uid, itemDb, equipSlot);
                if (r.ok) {
                    notifyMutation();
                } else if (r.error === 'no_room' || r.error === 'full') {
                    emitSystemFloat(player, 'There are no room');
                }
            });
        }
        if (isEquipped) {
            const eqSlot =
                inst.location && inst.location.kind === 'equipment'
                    ? inst.location.slot
                    : null;
            // Main backpack is the open parent container — cannot stow into itself
            const isMainBackpack =
                eqSlot === 'backpack' && uid === inv.rootUid;
            if (!isMainBackpack) {
                addItem('Unequip to backpack', () => {
                    if (!eqSlot) return;
                    const r = unequipItem(inv, eqSlot, itemDb, {
                        containerUid: inv.rootUid
                    });
                    if (r.ok) notifyMutation();
                });
            }
        }
        if (isCont) {
            addItem('Open', () => openContainerPanel(uid));
            addItem('Open in new panel', () =>
                openContainerPanel(uid, {
                    forceNew: true,
                    x: x + 12,
                    y: y + 12
                })
            );
        }
        if (itemIsUsable(item)) {
            addItem('Use on Self', () => {
                if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
                player.commandQueue.push({
                    type: 'USE_ITEM',
                    sourceUid: inst.uid,
                    itemId: item.id,
                    target: { kind: 'self' }
                });
            });
        }
        if (itemIsMultiUse(item)) {
            addItem('Use with...', () => {
                enterTargetCursorMode({
                    type: 'USE_ITEM_WITH',
                    sourceUid: inst.uid,
                    itemId: item.id
                });
            });
            const activeTarget = player.targetId || (player.target && player.target.id);
            if (activeTarget != null) {
                addItem('Use on Target (Active)', () => {
                    if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
                    player.commandQueue.push({
                        type: 'USE_ITEM_WITH',
                        sourceUid: inst.uid,
                        itemId: item.id,
                        target: { kind: 'entity', id: activeTarget }
                    });
                });
            }
        }

        // Drop at feet when session + map allow
        const sim = simOf();
        if (sim && sim.tileMap && player.tile && sim.groundItems) {
            const feet = {
                x: Math.round(player.tile.x),
                y: Math.round(player.tile.y),
                z: player.tile.z !== undefined ? player.tile.z : 0
            };
            const dropCheck = canDropToTile(
                player,
                sim.tileMap,
                feet.x,
                feet.y,
                feet.z
            );
            addItem(
                'Drop at feet',
                () => {
                    const r = dropItemToGround({
                        playerInv: inv,
                        uid,
                        ground: sim.groundItems,
                        player,
                        tileMap: sim.tileMap,
                        x: feet.x,
                        y: feet.y,
                        z: feet.z
                    });
                    if (r.ok) notifyMutation();
                },
                !dropCheck.ok
            );
        }

        document.body.appendChild(ctxMenu);
    }

    /**
     * Highlight selection without rebuilding slot DOM (rebuild mid-pointerdown
     * cancels the gesture and leaves a stuck drag ghost).
     * @param {string|null} uid
     */
    function applySelectionHighlight(uid) {
        selectedUid = uid;
        const nodes = document.querySelectorAll(
            '.backpack-slot.is-selected, .inv-slot.is-selected, .slot-item.is-selected, .inv-equip-slot.is-selected'
        );
        for (let i = 0; i < nodes.length; i++) {
            nodes[i].classList.remove('is-selected');
        }
        if (!uid) return;
        const filled = document.querySelectorAll(
            '.backpack-slot[data-item-uid], .inv-slot[data-item-uid], .slot-item[data-item-uid], .inv-equip-slot[data-item-uid]'
        );
        for (let i = 0; i < filled.length; i++) {
            if (filled[i].getAttribute('data-item-uid') === uid) {
                filled[i].classList.add('is-selected');
            }
        }
    }

    /**
     * @param {EventTarget|null} target
     * @returns {{ kind: string, slot?: string, containerUid?: string, index?: number, uid?: string|null, el?: HTMLElement }|null}
     */
    function hitTestSlot(target) {
        if (!target || !(target instanceof Element)) return null;
        const equipEl = target.closest('.slot-item[data-slot], .inv-equip-slot');
        if (equipEl && cardEl && cardEl.contains(equipEl)) {
            const designer = equipEl.getAttribute('data-slot');
            if (designer === 'light') return null;
            const engine = designerSlotToEngine(designer || '');
            if (!engine) return null;
            return {
                kind: 'equipment',
                slot: engine,
                uid: equipEl.getAttribute('data-item-uid'),
                el: /** @type {HTMLElement} */ (equipEl)
            };
        }
        const bagEl = target.closest(
            '.backpack-slot[data-container-uid], .inv-slot[data-container-uid]'
        );
        if (bagEl) {
            const containerUid = bagEl.getAttribute('data-container-uid') || ROOT_UID;
            const index = parseInt(bagEl.getAttribute('data-slot-index') || '0', 10);
            return {
                kind: 'container',
                containerUid,
                index: Number.isFinite(index) ? index : 0,
                uid: bagEl.getAttribute('data-item-uid'),
                el: /** @type {HTMLElement} */ (bagEl)
            };
        }
        return null;
    }

    /**
     * Resolve drop target under client coords (ghost must already be hidden).
     * Falls back to nearest backpack slot when releasing on grid gaps / panel chrome.
     * @param {number} clientX
     * @param {number} clientY
     * @returns {{ kind: string, slot?: string, containerUid?: string, index?: number, uid?: string|null, el?: HTMLElement }|null}
     */
    function hitTestAtPoint(clientX, clientY) {
        const el = document.elementFromPoint(clientX, clientY);
        const direct = hitTestSlot(el);
        if (direct) return direct;
        if (!el || !(el instanceof Element)) return null;

        // Dropped on backpack chrome / gap between cells → nearest slot center
        const grid =
            el.closest('.backpack-grid, .inv-panel-grid') ||
            (panelEl && panelEl.contains(el) ? gridEl : null);
        if (!grid) return null;
        const slots = grid.querySelectorAll(
            '.backpack-slot[data-container-uid], .inv-slot[data-container-uid]'
        );
        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < slots.length; i++) {
            const slot = /** @type {HTMLElement} */ (slots[i]);
            const r = slot.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const dx = clientX - cx;
            const dy = clientY - cy;
            const d = dx * dx + dy * dy;
            if (d < bestDist) {
                bestDist = d;
                best = slot;
            }
        }
        return best ? hitTestSlot(best) : null;
    }

    /**
     * Tear down active drag listeners + ghost.
     * @param {{ pointerId?: number, captureEl?: HTMLElement|null, ghost?: HTMLElement|null }|null} state
     * @param {(e: PointerEvent) => void} onMove
     * @param {(e: PointerEvent) => void} onEnd
     */
    function clearDragListeners(state, onMove, onEnd) {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        if (
            state &&
            state.captureEl &&
            state.pointerId != null &&
            typeof state.captureEl.releasePointerCapture === 'function'
        ) {
            try {
                if (state.captureEl.hasPointerCapture(state.pointerId)) {
                    state.captureEl.releasePointerCapture(state.pointerId);
                }
            } catch (_) {
                /* ignore */
            }
        }
        if (state && state.ghost) {
            state.ghost.style.display = 'none';
            state.ghost.remove();
            state.ghost = null;
        }
    }

    /**
     * @param {PointerEvent} ev
     */
    function onPointerDown(ev) {
        if (ev.button !== 0) return;
        // Nested bag panels use header drag with capture — ignore chrome there
        if (
            ev.target instanceof Element &&
            ev.target.closest('.inv-panel-header, .inv-panel-close, .inv-context-menu')
        ) {
            return;
        }
        const player = activePlayer();
        if (!player || !player.inventory) return;
        const hit = hitTestSlot(ev.target);
        if (!hit || !hit.uid) {
            applySelectionHighlight(null);
            hideContextMenu();
            lastSig = '';
            paint();
            return;
        }

        // Abort any stuck prior drag (e.g. cancelled gesture without cleanup)
        if (dragState && dragState.ghost) {
            dragState.ghost.remove();
        }
        dragState = null;

        applySelectionHighlight(hit.uid);
        hideContextMenu();
        // Do NOT full paint() here — destroying the node under the active pointer
        // triggers pointercancel and leaves the ghost stuck to the cursor.

        const from =
            hit.kind === 'equipment'
                ? { kind: 'equipment', slot: hit.slot }
                : {
                      kind: 'container',
                      containerUid: hit.containerUid,
                      index: hit.index
                  };

        const captureEl = hit.el || /** @type {HTMLElement} */ (ev.currentTarget);
        dragState = {
            uid: hit.uid,
            from,
            startX: ev.clientX,
            startY: ev.clientY,
            dragging: false,
            ghost: null,
            pointerId: ev.pointerId,
            captureEl
        };

        try {
            if (captureEl && typeof captureEl.setPointerCapture === 'function') {
                captureEl.setPointerCapture(ev.pointerId);
            }
        } catch (_) {
            /* ignore */
        }

        // Block native image drag / text selection which steal the gesture
        ev.preventDefault();

        const onMove = (e) => {
            if (!dragState || e.pointerId !== dragState.pointerId) return;
            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;
            if (
                !dragState.dragging &&
                dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
            ) {
                dragState.dragging = true;
                const inst = getItem(player.inventory, dragState.uid);
                const item = inst
                    ? findItem(itemDbOf(), inst.itemId)
                    : null;
                dragState.ghost = makeDragGhost(dragState.uid, item);
            }
            if (dragState.ghost) {
                dragState.ghost.style.left = e.clientX + 8 + 'px';
                dragState.ghost.style.top = e.clientY + 8 + 'px';
            }
        };

        const onEnd = (e) => {
            if (dragState && e.pointerId !== dragState.pointerId) return;
            const state = dragState;
            dragState = null;
            clearDragListeners(state, onMove, onEnd);
            if (!state || !state.dragging) return;

            const target = hitTestAtPoint(e.clientX, e.clientY);
            if (target) {
                const to =
                    target.kind === 'equipment'
                        ? { kind: 'equipment', slot: target.slot }
                        : {
                              kind: 'container',
                              containerUid: target.containerUid,
                              index: target.index
                          };
                const r = moveItem(player.inventory, state.from, to, itemDbOf());
                if (r.ok) {
                    notifyMutation();
                } else if (r.error === 'no_room' || r.error === 'full') {
                    emitSystemFloat(player, 'There are no room');
                }
                return;
            }

            const elUnder = typeof document !== 'undefined' ? document.elementFromPoint(e.clientX, e.clientY) : null;
            if (elUnder) {
                const itemInst = getItem(player.inventory, state.uid);
                if (itemInst && itemInst.itemId && tryHandleSlotDrop(elUnder, itemInst.itemId)) {
                    return;
                }
            }

            // Drop onto watch canvas floor tile
            tryDropOnCanvas(player, state.uid, e.clientX, e.clientY);
        };

        dragState.onMove = onMove;
        dragState.onEnd = onEnd;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }

    /**
     * @param {object} player
     * @param {string} uid
     * @param {number} clientX
     * @param {number} clientY
     * @returns {boolean}
     */
    function tryDropOnCanvas(player, uid, clientX, clientY) {
        const sim = simOf();
        if (!sim || !sim.tileMap || !sim.groundItems || !player.inventory) {
            return false;
        }
        const tile = clientToTile(clientX, clientY);
        if (!tile) return false;
        const r = dropItemToGround({
            playerInv: player.inventory,
            uid,
            ground: sim.groundItems,
            player,
            tileMap: sim.tileMap,
            x: tile.x,
            y: tile.y,
            z: tile.z
        });
        if (r.ok) {
            notifyMutation();
            return true;
        }
        return false;
    }

    /**
     * Start drag of top ground item under the pointer (pickup into bag).
     * @param {PointerEvent} ev
     */
    function onCanvasPointerDown(ev) {
        if (ev.button !== 0) return;
        if (!liveOf()) return;
        const player = activePlayer();
        const sim = simOf();
        if (!player || !player.inventory || !sim || !sim.groundItems) return;
        const tile = clientToTile(ev.clientX, ev.clientY);
        if (!tile) return;
        const topUid = peekTop(sim.groundItems, tile.x, tile.y, tile.z);
        if (!topUid) return;
        const range = canPickupFromTile(player, tile.x, tile.y, tile.z);
        if (!range.ok) return;

        ev.preventDefault();
        hideContextMenu();

        if (dragState && dragState.ghost) {
            dragState.ghost.remove();
        }
        dragState = {
            uid: topUid,
            from: { kind: 'ground', uid: topUid },
            startX: ev.clientX,
            startY: ev.clientY,
            dragging: false,
            ghost: null,
            pointerId: ev.pointerId,
            captureEl: canvasEl,
            source: 'ground',
            groundTile: tile
        };

        try {
            if (canvasEl && typeof canvasEl.setPointerCapture === 'function') {
                canvasEl.setPointerCapture(ev.pointerId);
            }
        } catch (_) {
            /* ignore */
        }

        const gInst = getItem(sim.groundItems.inventory, topUid);
        const item = gInst ? findItem(itemDbOf(), gInst.itemId) : null;

        const onMove = (e) => {
            if (!dragState || e.pointerId !== dragState.pointerId) return;
            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;
            if (
                !dragState.dragging &&
                dx * dx + dy * dy >= DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX
            ) {
                dragState.dragging = true;
                dragState.ghost = makeDragGhost(dragState.uid, item);
            }
            if (dragState.ghost) {
                dragState.ghost.style.left = e.clientX + 8 + 'px';
                dragState.ghost.style.top = e.clientY + 8 + 'px';
            }
        };

        const onEnd = (e) => {
            if (dragState && e.pointerId !== dragState.pointerId) return;
            const state = dragState;
            dragState = null;
            clearDragListeners(state, onMove, onEnd);
            if (!state) return;

            // Click without drag → auto equip backpack or BFS nest
            if (!state.dragging) {
                const r = pickupItemFromGround({
                    ground: sim.groundItems,
                    uid: state.uid,
                    playerInv: player.inventory,
                    player,
                    itemDb: itemDbOf()
                });
                handlePickupResult(r, player);
                return;
            }

            const target = hitTestAtPoint(e.clientX, e.clientY);
            if (!target) return;

            if (target.kind === 'equipment') {
                // Drag onto backpack equip slot: equip if empty, else nest
                if (target.slot === 'backpack') {
                    const r = pickupItemFromGround({
                        ground: sim.groundItems,
                        uid: state.uid,
                        playerInv: player.inventory,
                        player,
                        itemDb: itemDbOf(),
                        equipmentSlot: 'backpack'
                    });
                    handlePickupResult(r, player);
                }
                // Other equip slots: not supported via ground drag (nest-only policy)
                return;
            }

            if (target.kind !== 'container') return;
            const r = pickupItemFromGround({
                ground: sim.groundItems,
                uid: state.uid,
                playerInv: player.inventory,
                player,
                itemDb: itemDbOf(),
                containerUid: target.containerUid,
                index: target.index
            });
            handlePickupResult(r, player);
        };

        dragState.onMove = onMove;
        dragState.onEnd = onEnd;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }

    /**
     * RMB on canvas: pick up top ground item when in range, target enemies, or move character on empty tiles.
     * @param {MouseEvent} ev
     */
    function onCanvasContextMenu(ev) {
        if (ev && typeof ev.preventDefault === 'function') {
            ev.preventDefault();
        }
        if (!liveOf()) return;
        const player = activePlayer();
        const sim = simOf();
        if (!player || !sim) return;
        const tile = clientToTile(ev.clientX, ev.clientY);
        if (!tile) return;

        let targetCreature = null;
        if (sim.creatures && sim.creatures.length > 0) {
            for (let i = 0; i < sim.creatures.length; i++) {
                const c = sim.creatures[i];
                if (c && c.alive && c.tile && c.tile.x === tile.x && c.tile.y === tile.y && String(c.tile.z) === String(tile.z) && c.id !== player.id) {
                    targetCreature = c;
                    break;
                }
            }
        }

        // Classic Control (mouseControlMode = 1): RMB sets enemy as target when clicking with RMB on central canvas
        if (uiState && uiState.mouseControlMode === 1 && player.controlMode === 'manual' && targetCreature) {
            hideContextMenu();
            if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
            player.commandQueue.push({ type: 'SET_TARGET', targetId: targetCreature.id });
            player.targetId = targetCreature.id;
            player.target = targetCreature;
            return;
        }

        const stack = (sim.groundItems && getStack(sim.groundItems, tile.x, tile.y, tile.z)) || [];
        if (!stack.length && !targetCreature) {
            hideContextMenu();
            if (player.controlMode === 'manual' && player.alive) {
                if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
                if (player.tile && tile.x === player.tile.x && tile.y === player.tile.y && String(tile.z) === String(player.tile.z)) {
                    player.commandQueue.push({ type: 'STOP_AUTOWALK' });
                } else {
                    player.commandQueue.push({ type: 'START_AUTOWALK', dest: { x: tile.x, y: tile.y, z: tile.z } });
                }
            }
            return;
        }

        if (!player.inventory || !sim.groundItems) return;
        if (!stack.length) return;
        const topUid = stack[stack.length - 1];
        const range = canPickupFromTile(player, tile.x, tile.y, tile.z);
        hideContextMenu();

        ctxMenu = document.createElement('div');
        ctxMenu.className = 'inv-context-menu';
        ctxMenu.style.left = ev.clientX + 'px';
        ctxMenu.style.top = ev.clientY + 'px';

        const gInst = getItem(sim.groundItems.inventory, topUid);
        const item = gInst ? findItem(itemDbOf(), gInst.itemId) : null;
        const label = itemLabel(item);

        const addItem = (text, fn, disabled) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'inv-context-item';
            btn.textContent = text;
            if (disabled) {
                btn.disabled = true;
            } else {
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    hideContextMenu();
                    fn();
                });
            }
            ctxMenu.appendChild(btn);
        };

        addItem(
            `Pick up ${label}`,
            () => {
                const r = pickupItemFromGround({
                    ground: sim.groundItems,
                    uid: topUid,
                    playerInv: player.inventory,
                    player,
                    itemDb: itemDbOf()
                });
                handlePickupResult(r, player);
            },
            !range.ok
        );

        if (item) {
            addItem('View details', () => {
                showEquipmentItemModal(item, {
                    slotKey: preferredEquipSlot(item) || null,
                    genre: genreOf()
                });
            });
        }

        document.body.appendChild(ctxMenu);
    }

    /**
     * @param {MouseEvent} ev
     */
    function onContextMenu(ev) {
        const player = activePlayer();
        if (!player || !player.inventory) return;
        const hit = hitTestSlot(ev.target);
        if (!hit || !hit.uid) {
            hideContextMenu();
            return;
        }
        ev.preventDefault();
        selectedUid = hit.uid;
        lastSig = '';
        paint();
        const inst = getItem(player.inventory, hit.uid);
        const item = inst ? findItem(itemDbOf(), inst.itemId) : null;
        if (!ev.shiftKey && uiState && uiState.mouseControlMode === 1 && item && inst) {
            if (itemIsContainer(item) && hit.uid !== player.inventory.rootUid) {
                if (openPanels.has(hit.uid)) {
                    const p = openPanels.get(hit.uid);
                    if (p && p.el) p.el.remove();
                    openPanels.delete(hit.uid);
                    lastSig = '';
                    paint();
                } else {
                    openContainerPanel(hit.uid);
                }
                return;
            } else if (itemIsUsable(item)) {
                if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
                player.commandQueue.push({
                    type: 'USE_ITEM',
                    sourceUid: inst.uid,
                    itemId: item.id,
                    target: { kind: 'self' }
                });
                return;
            } else if (itemIsMultiUse(item)) {
                enterTargetCursorMode({
                    type: 'USE_ITEM_WITH',
                    sourceUid: inst.uid,
                    itemId: item.id
                });
                return;
            } else if (itemIsEquipable(item)) {
                if (hit.kind === 'container') {
                    const r = equipItem(player.inventory, hit.uid, itemDbOf());
                    if (r.ok) notifyMutation();
                    else if (r.error === 'no_room' || r.error === 'full') emitSystemFloat(player, 'There are no room');
                } else if (hit.kind === 'equipment') {
                    if (hit.slot === 'backpack' && hit.uid === player.inventory.rootUid) return;
                    const r = unequipItem(player.inventory, hit.slot, itemDbOf(), { containerUid: player.inventory.rootUid });
                    if (r.ok) notifyMutation();
                    else if (r.error === 'full' || r.error === 'no_room') emitSystemFloat(player, 'There are no room');
                }
                return;
            }
        }
        showContextMenu(ev.clientX, ev.clientY, hit.uid);
    }

    /**
     * Double-click container to open (including equipped quiver/bags);
     * double-click equippable to equip / unequip non-containers.
     * @param {MouseEvent} ev
     */
    function onDblClick(ev) {
        const player = activePlayer();
        if (!player || !player.inventory) return;
        const hit = hitTestSlot(ev.target);
        if (!hit || !hit.uid) return;
        const inst = getItem(player.inventory, hit.uid);
        if (!inst) return;
        const item = findItem(itemDbOf(), inst.itemId);
        // Containers open whether nested or equipped (not the main backpack root)
        if (itemIsContainer(item) && hit.uid !== player.inventory.rootUid) {
            openContainerPanel(hit.uid);
            return;
        }
        if (hit.kind === 'container' && preferredEquipSlot(item)) {
            const r = equipItem(player.inventory, hit.uid, itemDbOf());
            if (r.ok) {
                notifyMutation();
            } else if (r.error === 'no_room' || r.error === 'full') {
                emitSystemFloat(player, 'There are no room');
            }
        } else if (hit.kind === 'equipment') {
            // Equipped main backpack cannot be dropped into itself
            if (
                hit.slot === 'backpack' &&
                hit.uid &&
                hit.uid === player.inventory.rootUid
            ) {
                return;
            }
            const r = unequipItem(player.inventory, hit.slot, itemDbOf(), {
                containerUid: player.inventory.rootUid
            });
            if (r.ok) {
                notifyMutation();
            } else if (r.error === 'full' || r.error === 'no_room') {
                emitSystemFloat(player, 'There are no room');
            }
        }
    }

    const onDocClick = (ev) => {
        if (ctxMenu && !ctxMenu.contains(/** @type {Node} */ (ev.target))) {
            hideContextMenu();
        }
    };

    // Event targets: card + backpack area + float root
    const roots = [cardEl, panelEl, floatRoot].filter(Boolean);
    for (let i = 0; i < roots.length; i++) {
        roots[i].addEventListener('pointerdown', onPointerDown);
        roots[i].addEventListener('contextmenu', onContextMenu);
        roots[i].addEventListener('dblclick', onDblClick);
    }
    document.addEventListener('click', onDocClick);
    if (canvasEl) {
        canvasEl.addEventListener('pointerdown', onCanvasPointerDown);
        canvasEl.addEventListener('contextmenu', onCanvasContextMenu);
    }

    const baseMs = o.intervalMs != null ? o.intervalMs : 250;
    const idleMs = o.idleIntervalMs != null ? o.idleIntervalMs : 2000;
    let disposed = false;

    const schedulePaint = () => {
        if (disposed || typeof setTimeout === 'undefined') return;
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        const hidden = typeof document !== 'undefined' && document.hidden;
        const live = typeof o.isSessionLive === 'function' ? !!o.isSessionLive() : true;
        const ms = hidden ? Math.max(idleMs, 3000) : (live ? baseMs : idleMs);
        timer = setTimeout(() => {
            timer = null;
            if (disposed) return;
            if (!(typeof document !== 'undefined' && document.hidden)) {
                paint();
            }
            schedulePaint();
        }, ms);
    };

    paint();
    schedulePaint();

    return {
        refresh: () => {
            lastSig = '';
            paint();
        },
        dispose: () => {
            disposed = true;
            if (timer) clearTimeout(timer);
            timer = null;
            closeAllPanels();
            hideContextMenu();
            for (let i = 0; i < roots.length; i++) {
                roots[i].removeEventListener('pointerdown', onPointerDown);
                roots[i].removeEventListener('contextmenu', onContextMenu);
                roots[i].removeEventListener('dblclick', onDblClick);
            }
            document.removeEventListener('click', onDocClick);
            if (canvasEl) {
                canvasEl.removeEventListener('pointerdown', onCanvasPointerDown);
                canvasEl.removeEventListener('contextmenu', onCanvasContextMenu);
            }
            if (dragState) {
                clearDragListeners(
                    dragState,
                    dragState.onMove || (() => {}),
                    dragState.onEnd || (() => {})
                );
            }
            dragState = null;
        }
    };
}

module.exports = {
    bindInventoryPanel
};
