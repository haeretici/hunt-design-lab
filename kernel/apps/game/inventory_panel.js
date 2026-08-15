/**
 * Live inventory UI — root backpack grid, nested container panels, equip drag.
 *
 * Outside the logic tick: polls active player inventory and mutates via
 * inventory helpers + player.applyInventoryMutation().
 *
 * Interaction:
 *   - Left click: select item
 *   - Left drag (hold + move): move / swap into target slot
 *   - Drag stackable → inv/eq/ground: Stage 7 amount modal (Shift/Ctrl/moveStack)
 *   - Drag item → action bar slot: bind by itemId only (no quantity modal)
 *   - Drag bag → canvas: drop on walkable tile (engage range + path)
 *   - Drag ground item → bag: pick up (Chebyshev ≤ 1)
 *   - Drag ground map top → other SQM (Stage 9): threshold drag, suppress walk click
 *   - Right click: context menu (details, equip/unequip, open container, drop/pick)
 */

'use strict';

const { Settings } = require('../../settings.js');
const { findItem } = require('../../core/lib/character/stats.js');
const {
    uiState,
    isMouseButtonDown,
    armSuppressNextContextMenu,
    consumeSuppressNextContextMenu,
    armSuppressNextCanvasClick
} = require('./ui_state.js');
const {
    topPickableUid,
    resolveCanvasHit,
    processMouseAction,
    applyCommandIntents,
    allowGroundLmbDrag,
    itemSupportsDetailsModal,
    thingLabel,
    isClassicLookChord,
    resolveStackMoveAmount,
    buildLookIntent,
    buildBrowseFieldIntent,
    browseFieldTileKey,
    listBrowsableStackUids,
    isInBrowseOpenRange,
    resolveBrowseFieldApproach,
    resolveApproach,
    BROWSE_FIELD_CAPACITY
} = require('./mouse_dispatcher.js');
const { isTalkableNpc } = require('../../core/lib/npc/flags.js');
const { resolveDialog } = require('../../core/lib/npc/dialog.js');
const {
    TALK_RANGE,
    openTalk,
    closeTalk,
    getTalkSession,
    findTalkNpc,
    canTalkToNpc
} = require('../../core/lib/npc/session.js');
const {
    ROOT_UID,
    itemIsContainer,
    itemIsMultiUse,
    itemIsUsable,
    itemIsEquipable,
    itemIsStackable,
    moveItem,
    moveItemAmount,
    getStackCount,
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
    resolveItemBudgetDisplay
} = require('../../core/lib/character/equipment_runtime.js');
const {
    dropItemToGround,
    pickupItemFromGround,
    placePlayerItemIntoGroundContainer,
    moveGroundItemIntoContainer,
    moveGroundItemToTile,
    groundRootLocation,
    isGroundContainerOpenable,
    canDropToTile,
    canPickupFromTile,
    getStack
} = require('../../core/lib/character/ground_items.js');

/** Orange system floats (cap / room) — matches watch combat-text style. */
const FLOAT_SYSTEM_COLOR = '#f59e0b';
const {
    resolveItemSpriteUrl,
    getActivePlayerFromSim,
    showEquipmentItemModal
} = require('./equipment_panel.js');
const {
    tryHandleSlotDrop,
    enterActionCursor,
    state: actionBarState
} = require('./action_bars.js');
const {
    openSidebarPanel,
    isSidebarPanelOpen
} = require('./sidebar_panels.js');
const { createNpcDialogPanel } = require('./npc_dialog_panel.js');
const {
    tileClientRect,
    slotClientRect,
    collectOccupiedRects,
    placeFloatPanel,
    boundsForOrigin
} = require('./float_panel_place.js');

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

    function talkCtx() {
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        if (!sim) return null;
        return {
            sim,
            entityById: sim.entityById,
            creatureById: sim.creatureById,
            creatures: sim.creatures,
            itemDb: sim.itemDb || sim._itemDb || null
        };
    }

    const npcDialog = createNpcDialogPanel({
        floatRoot,
        getPlayer: () => activePlayer() || getActivePlayerFromSim(simOf()),
        getCtx: talkCtx,
        getCanvas: () => canvasEl,
        getTileSize: () => ({
            w: Settings.tileWidth || 32,
            h: Settings.tileHeight || 32
        }),
        onSystemFloat: (player, text) => emitSystemFloat(player, text),
        onInventoryMutation: () => notifyMutation()
    });

    /** @type {HTMLElement|null} */
    let ctxMenu = null;
    /** @type {string|null} selected item uid */
    let selectedUid = null;
    /**
     * Open nested container panels.
     * Key: player containerUid, or `ground:${uid}` for bags on the ground store.
     * @type {Map<string, { el: HTMLElement, containerUid: string, source: 'player'|'ground' }>}
     */
    const openPanels = new Map();
    /**
     * Stage 8 Browse Field panels: tileKey → { el, x, y, z }
     * @type {Map<string, { el: HTMLElement, x: number, y: number, z: string|number }>}
     */
    const browsePanels = new Map();
    /**
     * Walk-then-browse deferred open (same family as future OPEN_CORPSE).
     * @type {{ x: number, y: number, z: string|number }|null}
     */
    let pendingBrowse = null;
    /**
     * Walk-then-open ground container (bag on tile / nested).
     * @type {{ uid: string, x: number, y: number, z: string|number }|null}
     */
    let pendingOpenGround = null;
    /**
     * Walk-then-talk deferred open (same family as pendingBrowse).
     * @type {{ npcId: *, x: number, y: number, z: string|number }|null}
     */
    let pendingTalk = null;

    /**
     * True while a walk-then-* is still in flight. paint() can run after the
     * adapter enqueues START_AUTOWALK but before hunt_ai sets _manualDest —
     * treat the queued command as “still walking” so pending* is not dropped.
     * @param {object|null|undefined} player
     * @returns {boolean}
     */
    function isQueuedOrWalkingToward(player) {
        if (!player) return false;
        if (player._manualDest) return true;
        if (player.path && player.path.length > 0) return true;
        const q = player.commandQueue;
        if (!Array.isArray(q)) return false;
        for (let i = 0; i < q.length; i++) {
            if (q[i] && q[i].type === 'START_AUTOWALK') return true;
        }
        return false;
    }

    /**
     * @param {string} containerUid
     * @param {'player'|'ground'} [source]
     * @returns {string}
     */
    function panelKey(containerUid, source) {
        return source === 'ground' ? 'ground:' + containerUid : containerUid;
    }
    /** @type {string} last painted signature */
    let lastSig = '';
    /** @type {ReturnType<typeof setInterval>|null} */
    let timer = null;

    /** @type {{ uid: string, from: object, startX: number, startY: number, dragging: boolean, ghost: HTMLElement|null, pointerId: number, captureEl: HTMLElement|null, source?: 'inventory'|'ground'|'browse_field', groundTile?: {x:number,y:number,z:string|number}, onMove?: (e: PointerEvent) => void, onEnd?: (e: PointerEvent) => void }|null} */
    let dragState = null;

    /** @type {HTMLElement|null} Stage 7 stack-split modal */
    let stackSplitEl = null;

    const genreOf = () => {
        if (typeof o.getGenre === 'function') {
            const g = o.getGenre();
            if (g) return String(g);
        }
        return 'rpg_fantasy';
    };

    const itemDbOf = () =>
        typeof o.getItemDb === 'function' ? o.getItemDb() : null;

    const spellBookOf = () => {
        if (typeof o.getSpellBook === 'function') {
            const sb = o.getSpellBook();
            if (sb) return sb;
        }
        if (actionBarState && typeof actionBarState.getSpellBook === 'function') {
            const sb = actionBarState.getSpellBook();
            if (sb) return sb;
        }
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        return (sim && (sim.spellBook || sim._spellBook)) || null;
    };

    /**
     * Enter use-with / cast crosshair with tile-vs-entity policy from the spell book.
     * @param {{ type: string, sourceUid?: string, itemId?: string, spellId?: string }} cursor
     */
    function enterUseWithCursor(cursor) {
        enterActionCursor(cursor, { spellBook: spellBookOf() });
    }

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
     * Close Stage 7 stack-split amount dialog if open.
     */
    function hideStackSplitModal() {
        if (stackSplitEl && stackSplitEl.remove) {
            stackSplitEl.remove();
        }
        stackSplitEl = null;
    }

    /**
     * Minimal inv-styled stack amount dialog (docs/29 Q7.2).
     * @param {{
     *   max: number,
     *   item?: object|null,
     *   label?: string,
     *   onConfirm: (amount: number) => void,
     *   onCancel?: () => void
     * }} opts
     */
    function showStackSplitModal(opts) {
        hideStackSplitModal();
        if (typeof document === 'undefined') return;
        const max = Math.max(1, Math.floor(Number(opts.max) || 1));
        const el = document.createElement('div');
        el.className = 'inv-stack-split-modal';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Move amount');

        const title = document.createElement('div');
        title.className = 'inv-stack-split-title';
        title.textContent = opts.label || itemLabel(opts.item) || 'Move';

        const row = document.createElement('div');
        row.className = 'inv-stack-split-row';

        const amountEl = document.createElement('span');
        amountEl.className = 'inv-stack-split-amount';
        amountEl.textContent = String(max);

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '1';
        slider.max = String(max);
        slider.value = String(max);
        slider.className = 'inv-stack-split-slider';
        slider.addEventListener('input', () => {
            amountEl.textContent = String(slider.value);
        });

        row.appendChild(slider);
        row.appendChild(amountEl);

        const actions = document.createElement('div');
        actions.className = 'inv-stack-split-actions';
        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'inv-stack-split-btn inv-stack-split-btn--ok';
        okBtn.textContent = 'Ok';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'inv-stack-split-btn';
        cancelBtn.textContent = 'Cancel';

        const finish = (confirm) => {
            const n = Math.max(1, Math.min(max, Math.floor(Number(slider.value) || 1)));
            hideStackSplitModal();
            if (confirm && typeof opts.onConfirm === 'function') opts.onConfirm(n);
            else if (!confirm && typeof opts.onCancel === 'function') opts.onCancel();
        };
        okBtn.addEventListener('click', (e) => {
            e.preventDefault();
            finish(true);
        });
        cancelBtn.addEventListener('click', (e) => {
            e.preventDefault();
            finish(false);
        });
        actions.appendChild(okBtn);
        actions.appendChild(cancelBtn);

        el.appendChild(title);
        el.appendChild(row);
        el.appendChild(actions);
        document.body.appendChild(el);
        stackSplitEl = el;
        try {
            slider.focus();
        } catch (_) {
            /* ignore */
        }
    }

    /**
     * Resolve stack move amount from modifiers / moveStack pref, then run action.
     * @param {{
     *   count: number,
     *   item?: object|null,
     *   shift?: boolean,
     *   ctrl?: boolean,
     *   moveStack?: boolean,
     *   onAmount: (amount: number) => void
     * }} opts
     */
    function withStackMoveAmount(opts) {
        const decision = resolveStackMoveAmount({
            count: opts.count,
            shift: opts.shift,
            ctrl: opts.ctrl,
            moveStack: opts.moveStack
        });
        if (decision.kind === 'amount') {
            opts.onAmount(decision.amount);
            return;
        }
        showStackSplitModal({
            max: decision.max,
            item: opts.item,
            onConfirm: (n) => opts.onAmount(n)
        });
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
        } else if (result.error === 'immovable_item') {
            // Elemental fields / immovables — was silent "Pick up item" no-op
            emitSystemFloat(player, 'You cannot pick that up');
        } else if (result.error === 'out_of_range') {
            emitSystemFloat(player, 'Too far away');
        }
    }

    /**
     * @param {HTMLElement} slotEl
     * @param {string|null} uid
     * @param {object|null} item
     * @param {string} genre
     */
    /**
     * Live equipment-runtime entry for an inventory instance (equipped slots only).
     * @param {object|null|undefined} player
     * @param {object|null|undefined} inst
     * @returns {object|null}
     */
    function runtimeForInstance(player, inst) {
        if (!player || !inst || !player.equipmentRuntime || !player.inventory) {
            return null;
        }
        const eq = player.inventory.equipment;
        if (!eq) return null;
        const slots = Object.keys(eq);
        for (let i = 0; i < slots.length; i++) {
            const slot = slots[i];
            if (eq[slot] !== inst.uid) continue;
            const rt = player.equipmentRuntime[slot];
            if (rt && rt.itemId === inst.itemId) return rt;
            return null;
        }
        return null;
    }

    /**
     * Append stack / charges / duration badges (legacy UIItem layout).
     * @param {HTMLElement} slotEl
     * @param {number} stackCount
     * @param {{ charges: number|null, durationText: string|null }} budget
     */
    function appendItemBudgetBadges(slotEl, stackCount, budget) {
        if (budget && budget.charges != null && budget.charges > 0) {
            const ch = document.createElement('span');
            ch.className = 'item-charges-badge';
            ch.textContent = String(budget.charges);
            slotEl.appendChild(ch);
        }
        if (budget && budget.durationText) {
            const dur = document.createElement('span');
            dur.className = 'item-duration-badge';
            dur.textContent = budget.durationText;
            slotEl.appendChild(dur);
        }
        if (stackCount > 1) {
            const badge = document.createElement('span');
            badge.className = 'inv-stack-count';
            badge.textContent = String(stackCount);
            slotEl.appendChild(badge);
        }
    }

    /**
     * Title tooltip including stack / charges / duration.
     * @param {object|null} item
     * @param {number} stackCount
     * @param {{ charges: number|null, durationText: string|null }} budget
     * @returns {string}
     */
    function itemSlotTitle(item, stackCount, budget) {
        let title = itemLabel(item);
        if (stackCount > 1) title += ` x${stackCount}`;
        if (budget && budget.charges != null && budget.charges > 0) {
            title += ` (${budget.charges} charges)`;
        }
        if (budget && budget.durationText) {
            title += ` [${budget.durationText}]`;
        }
        return title;
    }

    /**
     * @param {HTMLElement} slotEl
     * @param {string|null} uid
     * @param {object|null} item
     * @param {string} genre
     * @param {object|null|undefined} [invOverride] ground store or player inv
     */
    function paintSlotContent(slotEl, uid, item, genre, invOverride) {
        const itemId = item && item.id != null ? String(item.id) : '';
        const player = activePlayer();
        const inv =
            invOverride ||
            (player && player.inventory) ||
            null;
        const inst = uid && inv ? getItem(inv, uid) : null;
        const stackCount =
            inst && inst.count != null && Number(inst.count) > 1
                ? Math.floor(Number(inst.count))
                : 1;
        // Runtime budgets only apply to the live player's equipped instances
        const runtime =
            invOverride && player && player.inventory && invOverride !== player.inventory
                ? null
                : runtimeForInstance(player, inst);
        const budget = resolveItemBudgetDisplay({
            item,
            instance: inst,
            runtime
        });
        const paintKey = uid
            ? `${genre}::${uid}::${itemId}::${stackCount}::${budget.sig}`
            : '';
        // Always refresh selection / type flags (cheap class toggles)
        slotEl.classList.toggle('is-filled', !!uid);
        slotEl.classList.toggle('is-selected', !!uid && uid === selectedUid);
        slotEl.classList.toggle(
            'is-container',
            !!(item && itemIsContainer(item))
        );
        // Skip wiping <img> when instance + stack + charges/duration unchanged
        if (slotEl.dataset.paintedKey === paintKey) {
            if (uid) {
                slotEl.dataset.itemUid = uid;
                slotEl.title = itemSlotTitle(item, stackCount, budget);
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
        slotEl.title = itemSlotTitle(item, stackCount, budget);
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
            appendItemBudgetBadges(slotEl, stackCount, budget);
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
     * @param {{ source?: 'player'|'ground' }} [opts]
     */
    function renderContainerGrid(grid, containerUid, inv, itemDb, genre, opts) {
        const o2 = opts || {};
        const source = o2.source === 'ground' ? 'ground' : 'player';
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
                if (source === 'ground') {
                    slot.dataset.groundContainer = '1';
                }
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
            if (source === 'ground') {
                slotEl.dataset.groundContainer = '1';
            } else {
                slotEl.removeAttribute('data-ground-container');
            }
            const uid = cont.slots[i] || null;
            const inst = uid ? getItem(inv, uid) : null;
            const item = inst ? findItem(itemDb, inst.itemId) : null;
            paintSlotContent(slotEl, uid, item, genre, inv);
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

        // Stage 8: walk-then-browse arrival + live browse panel refresh
        tickPendingBrowse();
        tickPendingOpenGround();
        tickTalkSession();
        refreshBrowsePanels(itemDb, genre);
        refreshGroundContainerPanels(itemDb, genre);
        if (npcDialog) npcDialog.sync(player, talkCtx());

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
            // Empty backpack chrome must not cancel walk-then-talk / browse.
            closeFloatingItemPanels();
            hideContextMenu();
            lastSig = 'idle';
            return;
        }

        const inv = player.inventory;
        const root = getContainer(inv, inv.rootUid || ROOT_UID);
        /**
         * Include stack counts + charges/duration so spend/tick repaints badges.
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
                    const b = resolveItemBudgetDisplay({
                        item: inst
                            ? findItem(itemDb, inst.itemId)
                            : null,
                        instance: inst,
                        runtime: runtimeForInstance(player, inst)
                    });
                    return `${u}:${c}:${b.sig}`;
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
        // Include nested open panel slot signatures (player only; ground via refresh)
        openPanels.forEach((p) => {
            if (p.source === 'ground') return;
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

        // Refresh open floating panels (player inventory only)
        openPanels.forEach((p, key) => {
            if (p.source === 'ground') return;
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
                    genre,
                    { source: 'player' }
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
     * Live ground bag panels: refresh slots; close when bag leaves ground store.
     * @param {object[]|Record<string, object>|null} itemDb
     * @param {string} genre
     */
    function refreshGroundContainerPanels(itemDb, genre) {
        const sim = simOf();
        const ground = sim && sim.groundItems ? sim.groundItems : null;
        const toClose = [];
        openPanels.forEach((p, key) => {
            if (!p || p.source !== 'ground') return;
            if (!ground || !isGroundContainerOpenable(ground, p.containerUid)) {
                toClose.push(key);
                return;
            }
            const gInv = ground.inventory;
            const cont =
                getContainer(gInv, p.containerUid) ||
                ensureItemContainer(gInv, p.containerUid, itemDb);
            if (!cont) {
                toClose.push(key);
                return;
            }
            const g = p.el && p.el.querySelector('.backpack-grid, .inv-panel-grid');
            if (g) {
                renderContainerGrid(
                    /** @type {HTMLElement} */ (g),
                    p.containerUid,
                    gInv,
                    itemDb,
                    genre,
                    { source: 'ground' }
                );
            }
            const h = p.el && p.el.querySelector('.inv-panel-title');
            if (h) {
                const inst = getItem(gInv, p.containerUid);
                const item = inst ? findItem(itemDb, inst.itemId) : null;
                h.textContent = itemLabel(item) || 'Container';
            }
        });
        for (let i = 0; i < toClose.length; i++) {
            closeContainerPanel(toClose[i]);
        }
    }

    /**
     * @param {string} key panel map key
     */
    function closeContainerPanel(key) {
        const p = openPanels.get(key);
        if (p && p.el) p.el.remove();
        openPanels.delete(key);
        lastSig = '';
    }

    /**
     * @param {object|null|undefined} intent
     * @param {object} [extra]
     * @returns {{ slotEl?: *, tile?: object, origin?: string }}
     */
    function placeOptsFromOpen(intent, extra) {
        const out = extra && typeof extra === 'object' ? Object.assign({}, extra) : {};
        if (intent && intent.slotEl) {
            out.slotEl = intent.slotEl;
            if (!out.origin) out.origin = 'slot';
        }
        if (intent && intent.tile && intent.tile.x != null && intent.tile.y != null) {
            if (!out.tile) out.tile = intent.tile;
            if (!out.origin && !out.slotEl) out.origin = 'canvas';
        }
        return out;
    }

    /**
     * Place a newly appended float next to its slot or tile.
     * @param {HTMLElement} el
     * @param {{
     *   origin?: string,
     *   slotEl?: *,
     *   tile?: { x?: number, y?: number },
     *   anchor?: object,
     *   x?: number,
     *   y?: number
     * }} [opts]
     */
    function placeNewFloat(el, opts) {
        const o2 = opts || {};
        let origin = o2.origin;
        let anchor = o2.anchor || null;
        if (!anchor && o2.slotEl) {
            anchor = slotClientRect(o2.slotEl);
            if (!origin) origin = 'slot';
        }
        if (!anchor && o2.tile && o2.tile.x != null && o2.tile.y != null) {
            const sim = simOf();
            anchor = tileClientRect(
                o2.tile,
                canvasEl,
                sim && sim.tileMap,
                Settings.tileWidth || 32,
                Settings.tileHeight || 32
            );
            if (!origin) origin = 'canvas';
        }
        if (!anchor && o2.x != null && o2.y != null) {
            const px = Number(o2.x);
            const py = Number(o2.y);
            if (Number.isFinite(px) && Number.isFinite(py)) {
                anchor = { left: px, top: py, right: px, bottom: py };
            }
        }
        placeFloatPanel(el, {
            anchor,
            bounds: boundsForOrigin(
                origin,
                canvasEl,
                typeof window !== 'undefined' ? window : null
            ),
            occupied: collectOccupiedRects(floatRoot, el),
            fallbackW: 200,
            fallbackH: 80
        });
    }

    /**
     * @param {string} containerUid
     * @param {{ forceNew?: boolean, x?: number, y?: number, ground?: boolean, source?: 'player'|'ground', slotEl?: *, tile?: object, origin?: string }} [opts]
     */
    function openContainerPanel(containerUid, opts) {
        const o2 = opts || {};
        const source =
            o2.ground === true || o2.source === 'ground' ? 'ground' : 'player';
        if (!floatRoot || !containerUid) return;

        if (source === 'ground') {
            openGroundContainerPanel(containerUid, o2);
            return;
        }

        const player = activePlayer();
        if (!player || !player.inventory) return;
        const inv = player.inventory;
        if (containerUid === inv.rootUid) return; // already main panel
        // Repair missing container slots (equipped quiver/bag must open like nested bags)
        const cont =
            getContainer(inv, containerUid) ||
            ensureItemContainer(inv, containerUid, itemDbOf());
        if (!cont) return;
        const key = o2.forceNew
            ? containerUid + '#' + Date.now()
            : panelKey(containerUid, 'player');

        if (!o2.forceNew && openPanels.has(key)) {
            const existing = openPanels.get(key);
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
        el.dataset.invSource = 'player';

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
            closeContainerPanel(key);
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
        placeNewFloat(el, o2);

        wirePanelHeaderDrag(header, el);

        openPanels.set(key, { el, containerUid, source: 'player' });
        renderContainerGrid(grid, containerUid, inv, itemDb, genreOf(), {
            source: 'player'
        });
        lastSig = '';
        paint();
    }

    /**
     * Open a bag/corpse container that lives on the ground store.
     * @param {string} containerUid
     * @param {{ forceNew?: boolean, x?: number, y?: number, forceOpen?: boolean, slotEl?: *, tile?: object, origin?: string }} [opts]
     */
    function openGroundContainerPanel(containerUid, opts) {
        const o2 = opts || {};
        if (!floatRoot || !containerUid) return;
        const sim = simOf();
        if (!sim || !sim.groundItems) return;
        const gInv = sim.groundItems.inventory;
        if (!isGroundContainerOpenable(sim.groundItems, containerUid)) return;

        const cont =
            getContainer(gInv, containerUid) ||
            ensureItemContainer(gInv, containerUid, itemDbOf());
        if (!cont) return;

        const key = o2.forceNew
            ? 'ground:' + containerUid + '#' + Date.now()
            : panelKey(containerUid, 'ground');

        if (!o2.forceNew && openPanels.has(key)) {
            if (o2.forceOpen) {
                const existing = openPanels.get(key);
                if (existing && existing.el) {
                    existing.el.classList.add('is-focused');
                    existing.el.style.zIndex = String(1000 + openPanels.size);
                }
                return;
            }
            // Toggle close when re-open same ground bag
            closeContainerPanel(key);
            paint();
            return;
        }

        const itemDb = itemDbOf();
        const inst = getItem(gInv, containerUid);
        const item = inst ? findItem(itemDb, inst.itemId) : null;

        const el = document.createElement('div');
        el.className = 'inv-float-panel inv-ground-container-panel';
        el.dataset.containerUid = containerUid;
        el.dataset.invSource = 'ground';

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
            closeContainerPanel(key);
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
        const groundPlace = Object.assign({}, o2);
        if (!groundPlace.tile && !groundPlace.slotEl && sim.groundItems) {
            const root = groundRootLocation(sim.groundItems, containerUid);
            if (root) {
                groundPlace.tile = { x: root.x, y: root.y, z: root.z };
                if (!groundPlace.origin) groundPlace.origin = 'canvas';
            }
        }
        placeNewFloat(el, groundPlace);

        wirePanelHeaderDrag(header, el);

        openPanels.set(key, { el, containerUid, source: 'ground' });
        renderContainerGrid(grid, containerUid, gInv, itemDb, genreOf(), {
            source: 'ground'
        });
        lastSig = '';
        paint();
    }

    /**
     * @param {HTMLElement} header
     * @param {HTMLElement} el
     */
    function wirePanelHeaderDrag(header, el) {
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
    }

    function closeFloatingItemPanels() {
        openPanels.forEach((p) => p.el.remove());
        openPanels.clear();
        closeAllBrowsePanels();
    }

    function closeAllPanels() {
        closeFloatingItemPanels();
        pendingBrowse = null;
        pendingOpenGround = null;
        pendingTalk = null;
        if (npcDialog) npcDialog.hide();
    }

    /**
     * Stage 8: close every Browse Field panel.
     */
    function closeAllBrowsePanels() {
        browsePanels.forEach((p) => {
            if (p && p.el) p.el.remove();
        });
        browsePanels.clear();
    }

    /**
     * @param {string} tileKey
     */
    function closeBrowseFieldPanel(tileKey) {
        const p = browsePanels.get(tileKey);
        if (p && p.el) p.el.remove();
        browsePanels.delete(tileKey);
    }

    /**
     * Live Browse Field grids + auto-close when filter empty (Q8.5).
     * @param {object[]|Record<string, object>|null} itemDb
     * @param {string} genre
     */
    function refreshBrowsePanels(itemDb, genre) {
        const sim = simOf();
        const ground = sim && sim.groundItems ? sim.groundItems : null;
        const toClose = [];
        browsePanels.forEach((p, key) => {
            if (!ground) {
                toClose.push(key);
                return;
            }
            const uids = listBrowsableStackUids(ground, p.x, p.y, p.z, itemDb);
            if (uids.length === 0) {
                toClose.push(key);
                return;
            }
            const g = p.el && p.el.querySelector('.backpack-grid, .inv-panel-grid');
            if (g) {
                renderBrowseFieldGrid(
                    /** @type {HTMLElement} */ (g),
                    p.x,
                    p.y,
                    p.z,
                    uids,
                    ground,
                    itemDb,
                    genre
                );
            }
        });
        for (let i = 0; i < toClose.length; i++) {
            closeBrowseFieldPanel(toClose[i]);
        }
    }

    /**
     * After walk-then-browse: open when player reaches Chebyshev ≤ 1.
     */
    function tickPendingBrowse() {
        if (!pendingBrowse) return;
        const player = activePlayer();
        if (!player || !player.tile) return;
        const tile = pendingBrowse;
        if (
            String(player.tile.z != null ? player.tile.z : 0) !==
            String(tile.z != null ? tile.z : 0)
        ) {
            // Floor change cancels deferred browse
            pendingBrowse = null;
            return;
        }
        if (isInBrowseOpenRange(player.tile, tile)) {
            const dest = pendingBrowse;
            pendingBrowse = null;
            openBrowseFieldPanel(dest.x, dest.y, dest.z, {
                forceOpen: true,
                origin: 'canvas',
                tile: { x: dest.x, y: dest.y, z: dest.z }
            });
            return;
        }
        // Still walking: keep pending while dest / path / queued autowalk exists
        if (!isQueuedOrWalkingToward(player)) {
            // Walk cancelled / no route — abandon without re-FCT (path fail already announced)
            pendingBrowse = null;
        }
    }

    /**
     * After walk-then-open ground bag: open when adjacent.
     */
    function tickPendingOpenGround() {
        if (!pendingOpenGround) return;
        const player = activePlayer();
        const sim = simOf();
        if (!player || !player.tile || !sim || !sim.groundItems) {
            pendingOpenGround = null;
            return;
        }
        const dest = pendingOpenGround;
        if (!isGroundContainerOpenable(sim.groundItems, dest.uid)) {
            pendingOpenGround = null;
            return;
        }
        if (
            String(player.tile.z != null ? player.tile.z : 0) !==
            String(dest.z != null ? dest.z : 0)
        ) {
            pendingOpenGround = null;
            return;
        }
        if (isInBrowseOpenRange(player.tile, dest)) {
            pendingOpenGround = null;
            openGroundContainerPanel(dest.uid, {
                forceOpen: true,
                origin: 'canvas',
                tile: { x: dest.x, y: dest.y, z: dest.z }
            });
            return;
        }
        if (!isQueuedOrWalkingToward(player)) {
            pendingOpenGround = null;
        }
    }

    /**
     * Open talk immediately: session + queueable npc_dialog + panel sync.
     * @param {object} player
     * @param {object} npc
     */
    function beginTalkNow(player, npc) {
        const opened = openTalk(player, npc);
        if (!opened.ok) return;
        if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
        player.commandQueue.push({
            type: 'CUSTOM_COMMAND',
            command: 'npc_dialog',
            args: { npcId: npc.id, nodeId: opened.nodeId }
        });
        if (npcDialog) npcDialog.sync(player, talkCtx());
    }

    /**
     * After walk-then-talk: open when Chebyshev ≤ 3. Drop session if the
     * player walks away or the NPC dies after the panel is already open.
     */
    function tickTalkSession() {
        const player = activePlayer();
        if (pendingTalk) {
            if (!player || !player.tile) return;
            const dest = pendingTalk;
            if (
                String(player.tile.z != null ? player.tile.z : 0) !==
                String(dest.z != null ? dest.z : 0)
            ) {
                pendingTalk = null;
                return;
            }
            const npc = findTalkNpc(talkCtx(), dest.npcId);
            if (!npc || !isTalkableNpc(npc)) {
                pendingTalk = null;
                return;
            }
            if (canTalkToNpc(player, npc).ok) {
                pendingTalk = null;
                beginTalkNow(player, npc);
                return;
            }
            if (!isQueuedOrWalkingToward(player)) {
                pendingTalk = null;
            }
            return;
        }
        if (!player) return;
        const session = getTalkSession(player);
        if (!session) return;
        const npc = findTalkNpc(talkCtx(), session.npcId);
        if (!npc || !canTalkToNpc(player, npc).ok) {
            closeTalk(player);
            if (npcDialog) npcDialog.hide();
        }
    }

    /**
     * Stage 6b adapter: TALK_NPC range + walk-then-talk.
     * @param {object} intent
     * @param {object} player
     * @param {object} sim
     */
    function handleTalkNpcIntent(intent, player, sim) {
        if (!intent || !player || !sim) return;
        const npcId =
            intent.creatureId != null
                ? intent.creatureId
                : intent.creature && intent.creature.id;
        const npc =
            findTalkNpc(talkCtx(), npcId) ||
            (intent.creature && isTalkableNpc(intent.creature)
                ? intent.creature
                : null);
        if (!npc || !isTalkableNpc(npc)) {
            emitSystemFloat(player, 'No one to talk to');
            pendingTalk = null;
            return;
        }
        const resolved = resolveDialog(npc);
        if (!resolved.ok) {
            emitSystemFloat(player, 'Nothing to say.');
            pendingTalk = null;
            return;
        }
        const tile = npc.tile
            ? { x: npc.tile.x, y: npc.tile.y, z: npc.tile.z }
            : intent.tile
              ? {
                    x: intent.tile.x,
                    y: intent.tile.y,
                    z: intent.tile.z != null ? intent.tile.z : 0
                }
              : null;
        if (!tile || tile.x == null || tile.y == null) {
            emitSystemFloat(player, 'No one to talk to');
            pendingTalk = null;
            return;
        }
        const approach = resolveApproach(
            player.tile,
            sim.tileMap || null,
            tile,
            TALK_RANGE
        );
        if (approach.status === 'wrong_floor') {
            emitSystemFloat(player, 'You cannot talk to that floor.');
            pendingTalk = null;
            return;
        }
        if (approach.status === 'no_path') {
            emitSystemFloat(player, 'There is no way.');
            pendingTalk = null;
            return;
        }
        if (approach.status === 'in_range') {
            pendingTalk = null;
            beginTalkNow(player, npc);
            return;
        }
        if (approach.status === 'walk' && approach.dest) {
            pendingTalk = {
                npcId: npc.id,
                x: tile.x,
                y: tile.y,
                z: tile.z != null ? tile.z : 0
            };
            if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
            player.commandQueue.push({
                type: 'START_AUTOWALK',
                dest: approach.dest
            });
        }
    }

    /**
     * OPEN_CONTAINER (player or ground bag) with walk-then for ground.
     * @param {object} intent
     * @param {object} player
     * @param {object} sim
     */
    function handleOpenContainerIntent(intent, player, sim) {
        if (!intent || !intent.sourceUid) return;
        const uid = String(intent.sourceUid);
        const isGround =
            intent.ground === true ||
            !!(sim && sim.groundItems && sim.groundItems.inventory.items[uid]);

        if (!isGround) {
            openContainerPanel(uid, placeOptsFromOpen(intent));
            return;
        }
        if (!sim || !sim.groundItems) {
            emitSystemFloat(player, 'Cannot open that here');
            return;
        }
        const gInst = getItem(sim.groundItems.inventory, uid);
        if (!gInst) {
            emitSystemFloat(player, 'Cannot open that here');
            return;
        }
        const item = findItem(itemDbOf(), gInst.itemId);
        if (!itemIsContainer(item)) {
            emitSystemFloat(player, 'Cannot open that here');
            return;
        }
        // Ensure slots exist
        ensureItemContainer(sim.groundItems.inventory, uid, itemDbOf());

        const root = groundRootLocation(sim.groundItems, uid);
        if (!root) {
            emitSystemFloat(player, 'Cannot open that here');
            return;
        }
        const tile = { x: root.x, y: root.y, z: root.z };
        const approach = resolveBrowseFieldApproach(
            player.tile,
            sim.tileMap || null,
            tile
        );
        if (approach.status === 'wrong_floor') {
            emitSystemFloat(player, 'You cannot open that floor.');
            pendingOpenGround = null;
            return;
        }
        if (approach.status === 'no_path') {
            emitSystemFloat(player, 'There is no way.');
            pendingOpenGround = null;
            return;
        }
        if (approach.status === 'in_range') {
            pendingOpenGround = null;
            openGroundContainerPanel(
                uid,
                placeOptsFromOpen(intent, {
                    origin: intent.slotEl ? 'slot' : 'canvas',
                    tile: intent.tile || tile
                })
            );
            return;
        }
        if (approach.status === 'walk' && approach.dest) {
            pendingOpenGround = { uid, x: tile.x, y: tile.y, z: tile.z };
            if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
            player.commandQueue.push({
                type: 'START_AUTOWALK',
                dest: approach.dest
            });
        }
    }

    /**
     * Render Browse Field slot grid (top-first uids; capacity ≥ 30).
     * @param {HTMLElement} grid
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {string[]} uids top-first
     * @param {object} ground
     * @param {object[]|Record<string, object>|null} itemDb
     * @param {string} genre
     */
    function renderBrowseFieldGrid(grid, x, y, z, uids, ground, itemDb, genre) {
        const cap = Math.max(BROWSE_FIELD_CAPACITY, uids.length);
        const existing = grid.querySelectorAll('.backpack-slot, .inv-slot');
        if (existing.length !== cap) {
            grid.innerHTML = '';
            for (let i = 0; i < cap; i++) {
                const slot = document.createElement('div');
                slot.className = 'backpack-slot inv-slot inv-browse-slot';
                slot.dataset.slotIndex = String(i);
                slot.dataset.browseField = '1';
                slot.dataset.browseX = String(x);
                slot.dataset.browseY = String(y);
                slot.dataset.browseZ = String(z);
                slot.setAttribute('role', 'button');
                slot.tabIndex = 0;
                grid.appendChild(slot);
            }
        }
        const slots = grid.querySelectorAll('.backpack-slot, .inv-slot');
        const gInv = ground && ground.inventory ? ground.inventory : null;
        for (let i = 0; i < slots.length; i++) {
            const slotEl = /** @type {HTMLElement} */ (slots[i]);
            slotEl.dataset.slotIndex = String(i);
            slotEl.dataset.browseField = '1';
            slotEl.dataset.browseX = String(x);
            slotEl.dataset.browseY = String(y);
            slotEl.dataset.browseZ = String(z);
            // Strip container attrs so drops never treat browse as a bag destination
            slotEl.removeAttribute('data-container-uid');
            const uid = uids[i] || null;
            const inst = uid && gInv ? getItem(gInv, uid) : null;
            const item = inst ? findItem(itemDb, inst.itemId) : null;
            paintSlotContent(slotEl, uid, item, genre, gInv);
        }
    }

    /**
     * Open or toggle Browse Field for tile (Q8.4). forceOpen skips toggle-close.
     * @param {number} x
     * @param {number} y
     * @param {string|number} z
     * @param {{ forceOpen?: boolean, x?: number, y?: number, tile?: object, origin?: string, slotEl?: * }} [opts]
     */
    function openBrowseFieldPanel(x, y, z, opts) {
        const o2 = opts || {};
        if (!floatRoot) return;
        const sim = simOf();
        if (!sim || !sim.groundItems) return;
        const tx = Math.round(x);
        const ty = Math.round(y);
        const tz = z !== undefined && z !== null ? z : 0;
        const key = browseFieldTileKey(tx, ty, tz);

        if (browsePanels.has(key)) {
            if (!o2.forceOpen) {
                // Re-browse same tile → close (Q8.4)
                closeBrowseFieldPanel(key);
                return;
            }
            // Already open (walk-then arrival): focus existing
            const existing = browsePanels.get(key);
            if (existing && existing.el) {
                existing.el.classList.add('is-focused');
                existing.el.style.zIndex = String(1000 + browsePanels.size + openPanels.size);
            }
            return;
        }

        const itemDb = itemDbOf();
        const uids = listBrowsableStackUids(sim.groundItems, tx, ty, tz, itemDb);
        if (uids.length === 0) return;

        const el = document.createElement('div');
        el.className = 'inv-float-panel inv-browse-field-panel';
        el.dataset.browseField = '1';
        el.dataset.browseTileKey = key;

        const header = document.createElement('div');
        header.className = 'inv-panel-header';
        const title = document.createElement('span');
        title.className = 'inv-panel-title';
        title.textContent = 'Browse Field';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'inv-panel-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', () => {
            closeBrowseFieldPanel(key);
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
        placeNewFloat(el, {
            origin: o2.origin || 'canvas',
            tile: o2.tile || { x: tx, y: ty, z: tz },
            slotEl: o2.slotEl,
            x: o2.x,
            y: o2.y
        });

        // Drag panel by header (same as bag panels)
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

        browsePanels.set(key, { el, x: tx, y: ty, z: tz });
        renderBrowseFieldGrid(
            grid,
            tx,
            ty,
            tz,
            uids,
            sim.groundItems,
            itemDb,
            genreOf()
        );
    }

    /**
     * Stage 8 adapter: BROWSE_FIELD range + walk-then-open.
     * @param {object} intent
     * @param {object} player
     * @param {object} sim
     */
    function handleBrowseFieldIntent(intent, player, sim) {
        if (!intent || !player || !sim) return;
        const tile = {
            x: Math.round(Number(intent.x) || 0),
            y: Math.round(Number(intent.y) || 0),
            z: intent.z != null ? intent.z : 0
        };
        const itemDb = itemDbOf();
        const uids =
            sim.groundItems
                ? listBrowsableStackUids(
                      sim.groundItems,
                      tile.x,
                      tile.y,
                      tile.z,
                      itemDb
                  )
                : [];
        if (uids.length === 0) {
            // Empty / creature-only — no-op (toggle close if open)
            const key = browseFieldTileKey(tile.x, tile.y, tile.z);
            if (browsePanels.has(key)) closeBrowseFieldPanel(key);
            return;
        }

        const approach = resolveBrowseFieldApproach(
            player.tile,
            sim.tileMap || null,
            tile
        );
        if (approach.status === 'wrong_floor') {
            emitSystemFloat(player, 'You cannot browse that floor.');
            pendingBrowse = null;
            return;
        }
        if (approach.status === 'no_path') {
            emitSystemFloat(player, 'There is no way.');
            pendingBrowse = null;
            return;
        }
        if (approach.status === 'in_range') {
            pendingBrowse = null;
            openBrowseFieldPanel(tile.x, tile.y, tile.z, {
                origin: 'canvas',
                tile
            });
            return;
        }
        if (approach.status === 'walk' && approach.dest) {
            pendingBrowse = { x: tile.x, y: tile.y, z: tile.z };
            if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
            player.commandQueue.push({
                type: 'START_AUTOWALK',
                dest: approach.dest
            });
        }
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
     * @param {HTMLElement|null} [slotEl]
     */
    function showContextMenu(x, y, uid, slotEl) {
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
            if (isMainBackpack) {
                // Sidebar backpack panel (not a floating nested bag)
                addItem('Open backpack', () => {
                    openSidebarPanel('backpack');
                });
            } else {
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
            const eqSlotOpen =
                isEquipped &&
                inst.location &&
                inst.location.kind === 'equipment'
                    ? inst.location.slot
                    : null;
            const isMainBackpackOpen =
                eqSlotOpen === 'backpack' && uid === inv.rootUid;
            if (!isMainBackpackOpen) {
                addItem('Open', () =>
                    openContainerPanel(uid, { slotEl, origin: 'slot' })
                );
                addItem('Open in new panel', () =>
                    openContainerPanel(uid, {
                        forceNew: true,
                        slotEl,
                        origin: 'slot'
                    })
                );
            }
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
                enterUseWithCursor({
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
        // Stage 8: Browse Field slots (not a container destination)
        const browseEl = target.closest(
            '.backpack-slot[data-browse-field], .inv-slot[data-browse-field]'
        );
        if (browseEl) {
            const bx = parseInt(browseEl.getAttribute('data-browse-x') || '0', 10);
            const by = parseInt(browseEl.getAttribute('data-browse-y') || '0', 10);
            const bzRaw = browseEl.getAttribute('data-browse-z');
            const bz =
                bzRaw != null && bzRaw !== ''
                    ? Number.isFinite(Number(bzRaw))
                        ? Number(bzRaw)
                        : bzRaw
                    : 0;
            const index = parseInt(
                browseEl.getAttribute('data-slot-index') || '0',
                10
            );
            return {
                kind: 'browse_field',
                x: Number.isFinite(bx) ? bx : 0,
                y: Number.isFinite(by) ? by : 0,
                z: bz,
                index: Number.isFinite(index) ? index : 0,
                uid: browseEl.getAttribute('data-item-uid'),
                el: /** @type {HTMLElement} */ (browseEl)
            };
        }
        const bagEl = target.closest(
            '.backpack-slot[data-container-uid], .inv-slot[data-container-uid]'
        );
        if (bagEl) {
            const containerUid = bagEl.getAttribute('data-container-uid') || ROOT_UID;
            const index = parseInt(bagEl.getAttribute('data-slot-index') || '0', 10);
            const isGround = bagEl.getAttribute('data-ground-container') === '1';
            return {
                kind: 'container',
                containerUid,
                index: Number.isFinite(index) ? index : 0,
                uid: bagEl.getAttribute('data-item-uid'),
                source: isGround ? 'ground' : 'player',
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
        // Include Browse Field grids so drag-in is rejected (unlocked=false)
        const grid =
            el.closest('.backpack-grid, .inv-panel-grid') ||
            (panelEl && panelEl.contains(el) ? gridEl : null);
        if (!grid) return null;
        const slots = grid.querySelectorAll(
            '.backpack-slot[data-container-uid], .inv-slot[data-container-uid], .backpack-slot[data-browse-field], .inv-slot[data-browse-field]'
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
        // Stage 7: Classic LMB while RMB held → Look (suppress drag)
        if (ev.button === 0) {
            const modeEarly =
                uiState && uiState.mouseControlMode != null
                    ? Number(uiState.mouseControlMode)
                    : 1;
            if (
                isClassicLookChord({
                    mode: modeEarly,
                    button: 'left',
                    leftPressed: true,
                    rightPressed: isMouseButtonDown('right')
                })
            ) {
                const playerChord = activePlayer();
                if (!playerChord || !playerChord.inventory) return;
                const hitChord = hitTestSlot(ev.target);
                if (hitChord && hitChord.uid) {
                    ev.preventDefault();
                    armSuppressNextContextMenu();
                    hideContextMenu();
                    if (hitChord.kind === 'browse_field') {
                        const simC = simOf();
                        const gInst =
                            simC && simC.groundItems
                                ? getItem(simC.groundItems.inventory, hitChord.uid)
                                : null;
                        const itemC = gInst
                            ? findItem(itemDbOf(), gInst.itemId)
                            : null;
                        lookInventoryItem(itemC, gInst, playerChord);
                    } else if (
                        hitChord.kind === 'container' &&
                        hitChord.source === 'ground'
                    ) {
                        const simC = simOf();
                        const gInst =
                            simC && simC.groundItems
                                ? getItem(simC.groundItems.inventory, hitChord.uid)
                                : null;
                        const itemC = gInst
                            ? findItem(itemDbOf(), gInst.itemId)
                            : null;
                        lookInventoryItem(itemC, gInst, playerChord);
                    } else {
                        const instC = getItem(playerChord.inventory, hitChord.uid);
                        const itemC = instC
                            ? findItem(itemDbOf(), instC.itemId)
                            : null;
                        lookInventoryItem(itemC, instC, playerChord);
                    }
                }
                return;
            }
        }

        if (ev.button !== 0) return;
        // Nested bag panels use header drag with capture — ignore chrome there
        if (
            ev.target instanceof Element &&
            ev.target.closest(
                '.inv-panel-header, .inv-panel-close, .inv-context-menu, .inv-stack-split-modal'
            )
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

        // Stage 8: drag out of Browse Field (ground source; range re-check on drop)
        if (hit.kind === 'browse_field') {
            beginBrowseFieldDrag(ev, player, hit);
            return;
        }

        // Ground bag panel: drag nested items out (or rearrange inside ground inv)
        if (hit.kind === 'container' && hit.source === 'ground') {
            beginGroundContainerDrag(ev, player, hit);
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
        /** Capture modifiers at drag start (drop uses these for stack rules). */
        const dragMods = {
            shift: !!(ev && ev.shiftKey),
            ctrl: !!(ev && (ev.ctrlKey || ev.metaKey))
        };
        dragState = {
            uid: hit.uid,
            from,
            startX: ev.clientX,
            startY: ev.clientY,
            dragging: false,
            ghost: null,
            pointerId: ev.pointerId,
            captureEl,
            source: 'inventory',
            dragMods
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

            const livePlayer = activePlayer();
            if (!livePlayer || !livePlayer.inventory) return;

            const inst = getItem(livePlayer.inventory, state.uid);
            if (!inst) return;
            const item = findItem(itemDbOf(), inst.itemId);
            const count = getStackCount(inst);
            const mods = state.dragMods || {};
            // Prefer end-event modifiers when present (user may press Ctrl mid-drag)
            const shift = !!(e && e.shiftKey) || !!mods.shift;
            const ctrl =
                !!(e && (e.ctrlKey || e.metaKey)) || !!mods.ctrl;
            const moveStackPref = !!(uiState && uiState.moveStack);

            // Action bar binds by itemId only (hotkey / use-with). Not a stack
            // move — never open the quantity modal for this destination.
            const elUnder =
                typeof document !== 'undefined'
                    ? document.elementFromPoint(e.clientX, e.clientY)
                    : null;
            if (elUnder && inst.itemId && tryHandleSlotDrop(elUnder, inst.itemId)) {
                return;
            }

            const runMove = (amount) => {
                const target = hitTestAtPoint(e.clientX, e.clientY);
                if (target) {
                    // Q8.1 unlocked=false — cannot drop into Browse Field
                    if (target.kind === 'browse_field') {
                        emitSystemFloat(livePlayer, 'You cannot put that there');
                        return;
                    }
                    // Player item → open ground bag
                    if (
                        target.kind === 'container' &&
                        target.source === 'ground'
                    ) {
                        const liveSim = simOf();
                        if (!liveSim || !liveSim.groundItems) return;
                        // Partial stacks into ground bags: full move only v1
                        const r = placePlayerItemIntoGroundContainer({
                            playerInv: livePlayer.inventory,
                            uid: state.uid,
                            ground: liveSim.groundItems,
                            containerUid: target.containerUid,
                            index: target.index,
                            player: livePlayer,
                            itemDb: itemDbOf()
                        });
                        if (r.ok) {
                            notifyMutation();
                        } else if (r.error === 'out_of_range') {
                            emitSystemFloat(livePlayer, 'Too far away');
                        } else if (
                            r.error === 'no_room' ||
                            r.error === 'full' ||
                            r.error === 'occupied' ||
                            r.error === 'not_enough_room'
                        ) {
                            emitSystemFloat(livePlayer, 'There are no room');
                        }
                        return;
                    }
                    const to =
                        target.kind === 'equipment'
                            ? { kind: 'equipment', slot: target.slot }
                            : {
                                  kind: 'container',
                                  containerUid: target.containerUid,
                                  index: target.index
                              };
                    const r =
                        amount < count && itemIsStackable(item)
                            ? moveItemAmount(
                                  livePlayer.inventory,
                                  state.from,
                                  to,
                                  amount,
                                  itemDbOf()
                              )
                            : moveItem(
                                  livePlayer.inventory,
                                  state.from,
                                  to,
                                  itemDbOf()
                              );
                    if (r.ok) {
                        notifyMutation();
                    } else if (r.error === 'no_room' || r.error === 'full') {
                        emitSystemFloat(livePlayer, 'There are no room');
                    }
                    return;
                }

                // Drop onto watch canvas floor tile (partial when stackable)
                tryDropOnCanvas(
                    livePlayer,
                    state.uid,
                    e.clientX,
                    e.clientY,
                    amount
                );
            };

            if (itemIsStackable(item) && count > 1) {
                withStackMoveAmount({
                    count,
                    item,
                    shift,
                    ctrl,
                    moveStack: moveStackPref,
                    onAmount: runMove
                });
            } else {
                runMove(count);
            }
        };

        dragState.onMove = onMove;
        dragState.onEnd = onEnd;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }

    /**
     * Stage 8: drag a ground item out of Browse Field into inv/eq (not into browse).
     * @param {PointerEvent} ev
     * @param {object} player
     * @param {{ uid: string, x: number, y: number, z: string|number, el?: HTMLElement }} hit
     */
    function beginBrowseFieldDrag(ev, player, hit) {
        const sim = simOf();
        if (!sim || !sim.groundItems || !hit.uid) return;

        if (dragState && dragState.ghost) {
            dragState.ghost.remove();
        }
        dragState = null;

        applySelectionHighlight(hit.uid);
        hideContextMenu();

        const captureEl = hit.el || /** @type {HTMLElement} */ (ev.currentTarget);
        const gInst = getItem(sim.groundItems.inventory, hit.uid);
        const item = gInst ? findItem(itemDbOf(), gInst.itemId) : null;

        dragState = {
            uid: hit.uid,
            from: { kind: 'ground', uid: hit.uid },
            startX: ev.clientX,
            startY: ev.clientY,
            dragging: false,
            ghost: null,
            pointerId: ev.pointerId,
            captureEl,
            source: 'browse_field',
            groundTile: { x: hit.x, y: hit.y, z: hit.z }
        };

        try {
            if (captureEl && typeof captureEl.setPointerCapture === 'function') {
                captureEl.setPointerCapture(ev.pointerId);
            }
        } catch (_) {
            /* ignore */
        }
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

            const livePlayer = activePlayer();
            const liveSim = simOf();
            if (!livePlayer || !livePlayer.inventory || !liveSim || !liveSim.groundItems) {
                return;
            }

            // Q8.6: re-check adjacency before drag-out
            const range = canPickupFromTile(
                livePlayer,
                state.groundTile ? state.groundTile.x : hit.x,
                state.groundTile ? state.groundTile.y : hit.y,
                state.groundTile ? state.groundTile.z : hit.z
            );
            if (!range.ok) {
                emitSystemFloat(livePlayer, 'Too far away');
                return;
            }

            const target = hitTestAtPoint(e.clientX, e.clientY);
            if (target) {
                // unlocked=false — no drop into any Browse Field panel
                if (target.kind === 'browse_field') {
                    emitSystemFloat(livePlayer, 'You cannot put that there');
                    return;
                }

                if (target.kind === 'equipment') {
                    if (target.slot === 'backpack') {
                        const r = pickupItemFromGround({
                            ground: liveSim.groundItems,
                            uid: state.uid,
                            playerInv: livePlayer.inventory,
                            player: livePlayer,
                            itemDb: itemDbOf(),
                            equipmentSlot: 'backpack'
                        });
                        handlePickupResult(r, livePlayer);
                    }
                    return;
                }

                if (target.kind === 'container') {
                    if (target.source === 'ground') {
                        const r = moveGroundItemIntoContainer({
                            ground: liveSim.groundItems,
                            uid: state.uid,
                            containerUid: target.containerUid,
                            index: target.index,
                            player: livePlayer,
                            itemDb: itemDbOf()
                        });
                        if (r.ok) {
                            notifyMutation();
                        } else if (r.error === 'out_of_range') {
                            emitSystemFloat(livePlayer, 'Too far away');
                        } else if (
                            r.error === 'no_room' ||
                            r.error === 'full' ||
                            r.error === 'occupied' ||
                            r.error === 'not_enough_room'
                        ) {
                            emitSystemFloat(livePlayer, 'There are no room');
                        }
                        return;
                    }
                    const r = pickupItemFromGround({
                        ground: liveSim.groundItems,
                        uid: state.uid,
                        playerInv: livePlayer.inventory,
                        player: livePlayer,
                        itemDb: itemDbOf(),
                        containerUid: target.containerUid,
                        index: target.index
                    });
                    handlePickupResult(r, livePlayer);
                }
                return;
            }

            // Drop onto canvas floor (from browse) — same-store tile move
            tryMoveGroundItemOnCanvas(livePlayer, liveSim, state.uid, e.clientX, e.clientY);
        };

        dragState.onMove = onMove;
        dragState.onEnd = onEnd;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }

    /**
     * Drag items out of an open ground bag (nested contents).
     * @param {PointerEvent} ev
     * @param {object} player
     * @param {{ uid: string, containerUid?: string, index?: number, el?: HTMLElement }} hit
     */
    function beginGroundContainerDrag(ev, player, hit) {
        const sim = simOf();
        if (!sim || !sim.groundItems || !hit.uid) return;

        if (dragState && dragState.ghost) {
            dragState.ghost.remove();
        }
        dragState = null;

        applySelectionHighlight(hit.uid);
        hideContextMenu();

        const captureEl = hit.el || /** @type {HTMLElement} */ (ev.currentTarget);
        const gInst = getItem(sim.groundItems.inventory, hit.uid);
        const item = gInst ? findItem(itemDbOf(), gInst.itemId) : null;
        const root = groundRootLocation(sim.groundItems, hit.uid);

        dragState = {
            uid: hit.uid,
            from: {
                kind: 'container',
                containerUid: hit.containerUid,
                index: hit.index
            },
            startX: ev.clientX,
            startY: ev.clientY,
            dragging: false,
            ghost: null,
            pointerId: ev.pointerId,
            captureEl,
            source: 'ground_container',
            groundTile: root
                ? { x: root.x, y: root.y, z: root.z }
                : undefined
        };

        try {
            if (captureEl && typeof captureEl.setPointerCapture === 'function') {
                captureEl.setPointerCapture(ev.pointerId);
            }
        } catch (_) {
            /* ignore */
        }
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

            const livePlayer = activePlayer();
            const liveSim = simOf();
            if (!livePlayer || !livePlayer.inventory || !liveSim || !liveSim.groundItems) {
                return;
            }

            const rootLoc =
                groundRootLocation(liveSim.groundItems, state.uid) ||
                state.groundTile;
            if (rootLoc) {
                const range = canPickupFromTile(
                    livePlayer,
                    rootLoc.x,
                    rootLoc.y,
                    rootLoc.z
                );
                if (!range.ok) {
                    emitSystemFloat(livePlayer, 'Too far away');
                    return;
                }
            } else {
                emitSystemFloat(livePlayer, 'Too far away');
                return;
            }

            const target = hitTestAtPoint(e.clientX, e.clientY);
            if (target) {
                if (target.kind === 'browse_field') {
                    emitSystemFloat(livePlayer, 'You cannot put that there');
                    return;
                }
                if (target.kind === 'equipment') {
                    if (target.slot === 'backpack') {
                        const r = pickupItemFromGround({
                            ground: liveSim.groundItems,
                            uid: state.uid,
                            playerInv: livePlayer.inventory,
                            player: livePlayer,
                            itemDb: itemDbOf(),
                            equipmentSlot: 'backpack'
                        });
                        handlePickupResult(r, livePlayer);
                    }
                    return;
                }
                if (target.kind === 'container') {
                    if (target.source === 'ground') {
                        const r = moveGroundItemIntoContainer({
                            ground: liveSim.groundItems,
                            uid: state.uid,
                            containerUid: target.containerUid,
                            index: target.index,
                            player: livePlayer,
                            itemDb: itemDbOf()
                        });
                        if (r.ok) notifyMutation();
                        else if (r.error === 'out_of_range') {
                            emitSystemFloat(livePlayer, 'Too far away');
                        } else if (
                            r.error === 'no_room' ||
                            r.error === 'full' ||
                            r.error === 'occupied' ||
                            r.error === 'not_enough_room'
                        ) {
                            emitSystemFloat(livePlayer, 'There are no room');
                        }
                        return;
                    }
                    const r = pickupItemFromGround({
                        ground: liveSim.groundItems,
                        uid: state.uid,
                        playerInv: livePlayer.inventory,
                        player: livePlayer,
                        itemDb: itemDbOf(),
                        containerUid: target.containerUid,
                        index: target.index
                    });
                    handlePickupResult(r, livePlayer);
                }
                return;
            }

            tryMoveGroundItemOnCanvas(
                livePlayer,
                liveSim,
                state.uid,
                e.clientX,
                e.clientY
            );
        };

        dragState.onMove = onMove;
        dragState.onEnd = onEnd;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }

    /**
     * Move ground-store item onto a canvas tile (map top drag, Browse Field, or
     * open ground bag). Range / path via canDropToTile (engage + path).
     * @param {object} player
     * @param {object} sim
     * @param {string} uid
     * @param {number} clientX
     * @param {number} clientY
     * @param {number} [count] optional partial stack amount
     * @returns {boolean}
     */
    function tryMoveGroundItemOnCanvas(player, sim, uid, clientX, clientY, count) {
        if (!sim || !sim.tileMap || !sim.groundItems || !player) return false;
        const tile = clientToTile(clientX, clientY);
        if (!tile) return false;
        /** @type {object} */
        const moveOpts = {
            ground: sim.groundItems,
            uid,
            player,
            tileMap: sim.tileMap,
            x: tile.x,
            y: tile.y,
            z: tile.z,
            itemDb: itemDbOf()
        };
        if (count != null && Number.isFinite(Number(count))) {
            moveOpts.count = Math.floor(Number(count));
        }
        const r = moveGroundItemToTile(moveOpts);
        if (r.ok) {
            notifyMutation();
            return true;
        }
        if (r.error === 'out_of_range') {
            emitSystemFloat(player, 'Too far away');
        } else if (r.error === 'not_walkable' || r.error === 'no_path') {
            emitSystemFloat(player, 'You cannot put that there');
        }
        return false;
    }

    /**
     * @param {object} player
     * @param {string} uid
     * @param {number} clientX
     * @param {number} clientY
     * @param {number} [count] optional partial stack amount
     * @returns {boolean}
     */
    function tryDropOnCanvas(player, uid, clientX, clientY, count) {
        const sim = simOf();
        if (!sim || !sim.tileMap || !sim.groundItems || !player.inventory) {
            return false;
        }
        const tile = clientToTile(clientX, clientY);
        if (!tile) return false;
        /** @type {object} */
        const dropOpts = {
            playerInv: player.inventory,
            uid,
            ground: sim.groundItems,
            player,
            tileMap: sim.tileMap,
            x: tile.x,
            y: tile.y,
            z: tile.z,
            itemDb: itemDbOf()
        };
        if (count != null && Number.isFinite(Number(count))) {
            dropOpts.count = Math.floor(Number(count));
        }
        const r = dropItemToGround(dropOpts);
        if (r.ok) {
            notifyMutation();
            return true;
        }
        return false;
    }

    /**
     * Start drag of top ground item under the pointer.
     * - Click without drag: pickup into bag (modes 0/1); Mode 2 defers to dispatcher.
     * - Drag to inventory / ground bag: pickup or nest.
     * - Drag to another map tile (Stage 9): moveGroundItemToTile (no autowalk).
     * Mode 2 (Smart): only pure pickupables; attack/use/open stay on click path.
     * Stage 7: Classic LMB while RMB held → Look (no drag).
     * @param {PointerEvent} ev
     */
    function onCanvasPointerDown(ev) {
        if (!liveOf()) return;
        const player = activePlayer();
        const sim = simOf();
        if (!player || !sim) return;
        const tile = clientToTile(ev.clientX, ev.clientY);
        if (!tile) return;

        const mouseMode =
            uiState && uiState.mouseControlMode != null
                ? Number(uiState.mouseControlMode)
                : 1;

        // Stage 7 Classic chord Look on canvas (LMB while RMB held)
        if (ev.button === 0) {
            if (
                isClassicLookChord({
                    mode: mouseMode,
                    button: 'left',
                    leftPressed: true,
                    rightPressed: isMouseButtonDown('right')
                })
            ) {
                ev.preventDefault();
                armSuppressNextContextMenu();
                hideContextMenu();
                const hitLook = resolveCanvasHit({
                    sim,
                    player,
                    tile,
                    itemDb: itemDbOf()
                });
                if (hitLook) {
                    applyLookIntent(buildLookIntent(hitLook), player);
                }
                return;
            }
        }

        if (ev.button !== 0) return;
        // Crosshair / use-with: never start ground drag — LMB must resolve the cast.
        if (uiState && uiState.activeActionCursor) {
            return;
        }
        if (!player.inventory || !sim.groundItems) return;

        const mods = {
            shift: !!(ev && ev.shiftKey),
            ctrl: !!(ev && (ev.ctrlKey || ev.metaKey)),
            alt: !!(ev && ev.altKey)
        };
        const hit = resolveCanvasHit({
            sim,
            player,
            tile,
            itemDb: itemDbOf()
        });
        if (
            !allowGroundLmbDrag({
                hit,
                mode: mouseMode,
                modifiers: mods
            })
        ) {
            return;
        }

        // Skip elemental fields / immovables (top may be fire_field with loot under).
        const topUid = topPickableUid(
            sim.groundItems,
            tile.x,
            tile.y,
            tile.z,
            itemDbOf()
        );
        if (!topUid) return;
        const range = canPickupFromTile(player, tile.x, tile.y, tile.z);
        if (!range.ok) return;

        ev.preventDefault();
        hideContextMenu();

        if (dragState && dragState.ghost) {
            dragState.ghost.remove();
        }
        /** Capture modifiers at drag start (stack amount uses Shift/Ctrl/moveStack). */
        const dragMods = {
            shift: !!(ev && ev.shiftKey),
            ctrl: !!(ev && (ev.ctrlKey || ev.metaKey))
        };
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
            groundTile: tile,
            dragMods,
            /** Mode 2: click without drag leaves pickup to dispatcher (avoid double). */
            deferClickPickup: mouseMode === 2
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
                // Stage 9: once drag threshold is met, swallow the follow-up click
                // so START_AUTOWALK does not steal the gesture.
                armSuppressNextCanvasClick();
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

            const livePlayer = activePlayer();
            const liveSim = simOf();
            if (!livePlayer || !liveSim || !liveSim.groundItems) return;

            // Click without drag → auto equip backpack or BFS nest
            // (Mode 2 defers to click → dispatcher PICKUP.)
            if (!state.dragging) {
                if (state.deferClickPickup) return;
                const r = pickupItemFromGround({
                    ground: liveSim.groundItems,
                    uid: state.uid,
                    playerInv: livePlayer.inventory,
                    player: livePlayer,
                    itemDb: itemDbOf()
                });
                handlePickupResult(r, livePlayer);
                return;
            }

            const finishGroundMove = (amount) => {
                const target = hitTestAtPoint(e.clientX, e.clientY);
                if (target) {
                    if (target.kind === 'equipment') {
                        // Drag onto backpack equip slot: equip if empty, else nest
                        if (target.slot === 'backpack') {
                            const r = pickupItemFromGround({
                                ground: liveSim.groundItems,
                                uid: state.uid,
                                playerInv: livePlayer.inventory,
                                player: livePlayer,
                                itemDb: itemDbOf(),
                                equipmentSlot: 'backpack'
                            });
                            handlePickupResult(r, livePlayer);
                        }
                        return;
                    }
                    if (target.kind === 'browse_field') {
                        emitSystemFloat(livePlayer, 'You cannot put that there');
                        return;
                    }
                    if (target.kind === 'container') {
                        if (target.source === 'ground') {
                            const r = moveGroundItemIntoContainer({
                                ground: liveSim.groundItems,
                                uid: state.uid,
                                containerUid: target.containerUid,
                                index: target.index,
                                player: livePlayer,
                                itemDb: itemDbOf()
                            });
                            if (r.ok) {
                                notifyMutation();
                            } else if (r.error === 'out_of_range') {
                                emitSystemFloat(livePlayer, 'Too far away');
                            } else if (
                                r.error === 'no_room' ||
                                r.error === 'full' ||
                                r.error === 'occupied' ||
                                r.error === 'not_enough_room'
                            ) {
                                emitSystemFloat(livePlayer, 'There are no room');
                            }
                            return;
                        }
                        const r = pickupItemFromGround({
                            ground: liveSim.groundItems,
                            uid: state.uid,
                            playerInv: livePlayer.inventory,
                            player: livePlayer,
                            itemDb: itemDbOf(),
                            containerUid: target.containerUid,
                            index: target.index
                        });
                        handlePickupResult(r, livePlayer);
                        return;
                    }
                }

                // Stage 9: drop on another map tile (or same — no-op)
                tryMoveGroundItemOnCanvas(
                    livePlayer,
                    liveSim,
                    state.uid,
                    e.clientX,
                    e.clientY,
                    amount
                );
            };

            const liveInst = getItem(liveSim.groundItems.inventory, state.uid);
            if (!liveInst) return;
            const liveItem = findItem(itemDbOf(), liveInst.itemId);
            const stackCount = getStackCount(liveInst);
            const dMods = state.dragMods || {};
            const shift = !!(e && e.shiftKey) || !!dMods.shift;
            const ctrl =
                !!(e && (e.ctrlKey || e.metaKey)) || !!dMods.ctrl;
            const moveStackPref = !!(uiState && uiState.moveStack);

            // Partial stacks only for ground→tile (UI targets take full item v1)
            if (itemIsStackable(liveItem) && stackCount > 1) {
                const uiTarget = hitTestAtPoint(e.clientX, e.clientY);
                if (!uiTarget) {
                    withStackMoveAmount({
                        count: stackCount,
                        item: liveItem,
                        shift,
                        ctrl,
                        moveStack: moveStackPref,
                        onAmount: (n) => finishGroundMove(n)
                    });
                    return;
                }
            }
            finishGroundMove(undefined);
        };

        dragState.onMove = onMove;
        dragState.onEnd = onEnd;
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd);
        window.addEventListener('pointercancel', onEnd);
    }

    /**
     * Apply LOOK intent: equipment → View details modal; else FCT.
     * @param {object} intent
     * @param {object|null|undefined} player
     */
    function applyLookIntent(intent, player) {
        if (!intent) return;
        if (intent.style === 'modal' && intent.item) {
            showEquipmentItemModal(intent.item, {
                slotKey: preferredEquipSlot(intent.item) || null,
                genre: genreOf()
            });
            return;
        }
        const text =
            intent.text ||
            (intent.item
                ? thingLabel(intent.itemInst, intent.item, 'Item')
                : 'Nothing here.');
        emitSystemFloat(player, text);
    }

    /**
     * Inventory / equipment item Look (Shift or Look menu).
     * @param {object|null|undefined} item
     * @param {object|null|undefined} inst
     * @param {object|null|undefined} player
     */
    function lookInventoryItem(item, inst, player) {
        if (item && itemSupportsDetailsModal(item)) {
            showEquipmentItemModal(item, {
                slotKey:
                    (item.slot != null && String(item.slot)) ||
                    (inst &&
                    inst.location &&
                    inst.location.kind === 'equipment'
                        ? inst.location.slot
                        : preferredEquipSlot(item)) ||
                    null,
                genre: genreOf()
            });
            return;
        }
        emitSystemFloat(
            player,
            thingLabel(inst, item, item && item.id ? String(item.id) : 'Item')
        );
    }

    /**
     * Classic / Regular direct use-open-equip for inventory slot items.
     * @param {object} player
     * @param {{ kind: string, slot?: string, uid: string }} hit
     * @param {object} inst
     * @param {object|null} item
     * @param {boolean} isMainBackpackSlot
     * @returns {boolean} true if handled
     */
    function inventoryDirectUseOpenEquip(player, hit, inst, item, isMainBackpackSlot) {
        if (!item || !inst) return false;
        if (itemIsContainer(item) && hit.uid !== player.inventory.rootUid) {
            const pk = panelKey(hit.uid, 'player');
            if (openPanels.has(pk)) {
                closeContainerPanel(pk);
                paint();
            } else {
                openContainerPanel(hit.uid, { slotEl: hit.el, origin: 'slot' });
            }
            return true;
        }
        if (isMainBackpackSlot) {
            openSidebarPanel('backpack');
            return true;
        }
        if (itemIsUsable(item)) {
            if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
            player.commandQueue.push({
                type: 'USE_ITEM',
                sourceUid: inst.uid,
                itemId: item.id,
                target: { kind: 'self' }
            });
            return true;
        }
        if (itemIsMultiUse(item)) {
            enterUseWithCursor({
                type: 'USE_ITEM_WITH',
                sourceUid: inst.uid,
                itemId: item.id
            });
            return true;
        }
        if (itemIsEquipable(item)) {
            if (hit.kind === 'container') {
                const r = equipItem(player.inventory, hit.uid, itemDbOf());
                if (r.ok) notifyMutation();
                else if (r.error === 'no_room' || r.error === 'full') {
                    emitSystemFloat(player, 'There are no room');
                }
            } else if (hit.kind === 'equipment') {
                if (hit.slot === 'backpack' && hit.uid === player.inventory.rootUid) {
                    return true;
                }
                const r = unequipItem(player.inventory, hit.slot, itemDbOf(), {
                    containerUid: player.inventory.rootUid
                });
                if (r.ok) notifyMutation();
                else if (r.error === 'full' || r.error === 'no_room') {
                    emitSystemFloat(player, 'There are no room');
                }
            }
            return true;
        }
        return false;
    }

    /**
     * Build any-tile canvas context menu from OPEN_CONTEXT_MENU intent entries.
     * @param {number} clientX
     * @param {number} clientY
     * @param {object} player
     * @param {object} sim
     * @param {object} menuIntent
     */
    function showCanvasContextMenu(clientX, clientY, player, sim, menuIntent) {
        if (!player || !sim || !menuIntent) return;
        hideContextMenu();

        const tile = menuIntent.tile || { x: 0, y: 0, z: 0 };
        const range =
            menuIntent.pickableUid && player.tile
                ? canPickupFromTile(player, tile.x, tile.y, tile.z)
                : { ok: false };

        ctxMenu = document.createElement('div');
        ctxMenu.className = 'inv-context-menu';
        ctxMenu.style.left = (clientX || 0) + 'px';
        ctxMenu.style.top = (clientY || 0) + 'px';

        /**
         * @param {string} text
         * @param {() => void} fn
         * @param {boolean} [disabled]
         */
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

        const entries = Array.isArray(menuIntent.entries)
            ? menuIntent.entries
            : [];

        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry) continue;
            const id = entry.id;

            // Disabled stubs (Loot corpse / Quickloot until 5b, …) — not clickable
            if (id === 'immovable_note' || entry.disabled) {
                addItem(entry.label || id, () => {}, true);
                continue;
            }

            if (id === 'talk') {
                addItem(entry.label || 'Talk', () => {
                    handleCanvasAdapterIntent(
                        {
                            type: 'TALK_NPC',
                            stub: entry.stub === true,
                            creature: entry.creature,
                            creatureId: entry.creatureId,
                            tile: entry.tile || tile
                        },
                        { player, sim }
                    );
                });
                continue;
            }

            if (id === 'look') {
                addItem(entry.label || 'Look', () => {
                    applyLookIntent(
                        {
                            type: 'LOOK',
                            style: entry.lookStyle || 'fct',
                            text: entry.text,
                            item: entry.item,
                            itemInst: entry.itemInst,
                            creature: entry.creature
                        },
                        player
                    );
                });
                continue;
            }

            if (id === 'view_details') {
                addItem(entry.label || 'View details', () => {
                    if (!entry.item) return;
                    showEquipmentItemModal(entry.item, {
                        slotKey: preferredEquipSlot(entry.item) || null,
                        genre: genreOf()
                    });
                });
                continue;
            }

            if (id === 'attack') {
                addItem(entry.label || 'Attack', () => {
                    if (!Array.isArray(player.commandQueue)) {
                        player.commandQueue = [];
                    }
                    player.commandQueue.push({
                        type: 'SET_TARGET',
                        targetId: entry.targetId
                    });
                    player.targetId = entry.targetId;
                    if (entry.creature) player.target = entry.creature;
                });
                continue;
            }

            if (id === 'pickup') {
                const pickUid = entry.pickableUid || menuIntent.pickableUid;
                addItem(
                    entry.label || 'Pick up',
                    () => {
                        if (!pickUid || !player.inventory || !sim.groundItems) {
                            return;
                        }
                        const r = pickupItemFromGround({
                            ground: sim.groundItems,
                            uid: pickUid,
                            playerInv: player.inventory,
                            player,
                            itemDb: itemDbOf()
                        });
                        handlePickupResult(r, player);
                    },
                    !range.ok
                );
                continue;
            }

            if (id === 'use') {
                addItem(entry.label || 'Use', () => {
                    if (!Array.isArray(player.commandQueue)) {
                        player.commandQueue = [];
                    }
                    player.commandQueue.push({
                        type: 'USE_ITEM',
                        sourceUid: entry.sourceUid,
                        itemId: entry.itemId,
                        target: { kind: 'self' }
                    });
                });
                continue;
            }

            if (id === 'use_with') {
                addItem(entry.label || 'Use with...', () => {
                    enterUseWithCursor({
                        type: 'USE_ITEM_WITH',
                        sourceUid: entry.sourceUid,
                        itemId: entry.itemId
                    });
                });
                continue;
            }

            if (id === 'open') {
                addItem(entry.label || 'Open', () => {
                    handleOpenContainerIntent(
                        {
                            type: 'OPEN_CONTAINER',
                            sourceUid: entry.sourceUid || menuIntent.pickableUid,
                            ground: entry.ground !== false,
                            itemId: entry.itemId,
                            tile: entry.tile || menuIntent.tile || tile
                        },
                        player,
                        sim
                    );
                });
                continue;
            }

            if (id === 'browse_field') {
                addItem(entry.label || 'Browse field', () => {
                    handleCanvasAdapterIntent(
                        buildBrowseFieldIntent(entry.tile || entry || tile),
                        { player, sim }
                    );
                });
                continue;
            }

            // Unknown entry: show disabled if labeled
            if (entry.label) {
                addItem(entry.label, () => {}, !!entry.disabled);
            }
        }

        // Fallback when entries missing (should not happen Stage 2+)
        if (entries.length === 0) {
            addItem('Look', () => {
                applyLookIntent(
                    {
                        type: 'LOOK',
                        style: 'fct',
                        text:
                            tile && tile.x != null
                                ? `Tile (${tile.x}, ${tile.y})`
                                : 'Nothing here.'
                    },
                    player
                );
            });
        }

        document.body.appendChild(ctxMenu);
    }

    /**
     * Adapter for non-queue canvas intents (LOOK, PICKUP, menu, use-with, open).
     * Shared by canvas RMB and LMB (via manual_control onAdapterIntent).
     * @param {object} intent
     * @param {{ player: object, sim: object, clientX?: number, clientY?: number }} ctx
     */
    function handleCanvasAdapterIntent(intent, ctx) {
        if (!intent || !ctx) return;
        const player = ctx.player;
        const sim = ctx.sim;
        if (!player || !sim) return;

        switch (intent.type) {
            case 'LOOK':
                applyLookIntent(intent, player);
                break;
            case 'PICKUP': {
                if (!intent.pickableUid || !player.inventory || !sim.groundItems) {
                    break;
                }
                const r = pickupItemFromGround({
                    ground: sim.groundItems,
                    uid: intent.pickableUid,
                    playerInv: player.inventory,
                    player,
                    itemDb: itemDbOf()
                });
                handlePickupResult(r, player);
                break;
            }
            case 'OPEN_CONTEXT_MENU':
                showCanvasContextMenu(
                    ctx.clientX != null ? ctx.clientX : 0,
                    ctx.clientY != null ? ctx.clientY : 0,
                    player,
                    sim,
                    intent
                );
                break;
            case 'ENTER_USE_WITH':
                enterUseWithCursor({
                    type: 'USE_ITEM_WITH',
                    sourceUid: intent.sourceUid,
                    itemId: intent.itemId
                });
                break;
            case 'OPEN_CONTAINER':
                handleOpenContainerIntent(intent, player, sim);
                break;
            case 'TALK_NPC':
                handleTalkNpcIntent(intent, player, sim);
                break;
            case 'QUICKLOOT':
                // Stage 5a stub — no vacuum until 5b (no inventory mutation)
                emitSystemFloat(player, 'Not available yet');
                break;
            case 'OPEN_CORPSE':
                // Stage 5a stub — corpse container open lands with 5b
                emitSystemFloat(player, 'Not available yet');
                break;
            case 'BROWSE_FIELD':
                handleBrowseFieldIntent(intent, player, sim);
                break;
            default:
                break;
        }
    }

    /**
     * RMB on canvas: Stage 2 dispatcher matrix + adapter intents.
     * Stage 7: Classic chord Look when LMB still held (suppress default).
     * Ground drag stays on pointerdown (Q1.1 A).
     * @param {MouseEvent} ev
     */
    function onCanvasContextMenu(ev) {
        if (ev && typeof ev.preventDefault === 'function') {
            ev.preventDefault();
        }
        if (consumeSuppressNextContextMenu()) {
            return;
        }
        if (!liveOf()) return;
        const player = activePlayer();
        const sim = simOf();
        if (!player || !sim) return;
        const tile = clientToTile(ev.clientX, ev.clientY);
        if (!tile) return;

        const hit = resolveCanvasHit({
            sim,
            player,
            tile,
            itemDb: itemDbOf()
        });
        if (!hit) return;

        const mode =
            uiState && uiState.mouseControlMode != null
                ? uiState.mouseControlMode
                : 1;

        // Stage 7: RMB while LMB held → Look (Classic only)
        if (
            isClassicLookChord({
                mode,
                button: 'right',
                leftPressed: isMouseButtonDown('left'),
                rightPressed: true
            })
        ) {
            hideContextMenu();
            applyLookIntent(buildLookIntent(hit), player);
            return;
        }

        const intents = processMouseAction({
            button: 'right',
            hit,
            mode,
            lootMode:
                uiState && uiState.lootControlMode != null
                    ? uiState.lootControlMode
                    : 0,
            talkOnRightClick: !!(uiState && uiState.talkOnRightClick),
            modifiers: {
                shift: !!(ev && ev.shiftKey),
                ctrl: !!(ev && (ev.ctrlKey || ev.metaKey)),
                alt: !!(ev && ev.altKey)
            },
            playerControlMode: player.controlMode || 'ai',
            playerAlive: !!player.alive,
            hasInventory: !!player.inventory,
            hasGroundItems: !!sim.groundItems,
            playerTile: player.tile || null
        });

        hideContextMenu();
        const remaining = applyCommandIntents(player, intents, {});
        const ctx = {
            player,
            sim,
            clientX: ev.clientX,
            clientY: ev.clientY
        };
        for (let i = 0; i < remaining.length; i++) {
            handleCanvasAdapterIntent(remaining[i], ctx);
        }
    }

    /**
     * Inventory / equipment RMB — Stage 2 Classic/Regular modifiers.
     * Stage 7: Classic chord Look when LMB still held.
     * @param {MouseEvent} ev
     */
    function onContextMenu(ev) {
        if (consumeSuppressNextContextMenu()) {
            if (ev && typeof ev.preventDefault === 'function') {
                ev.preventDefault();
            }
            return;
        }
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

        const mode =
            uiState && uiState.mouseControlMode != null
                ? Number(uiState.mouseControlMode)
                : 1;
        const shift = !!ev.shiftKey;
        const ctrl = !!(ev.ctrlKey || ev.metaKey);
        const alt = !!ev.altKey;

        // Browse Field / ground bag slots: same mode matrix as inventory
        // (Classic unshifted Open, Regular menu, Ctrl swap). Stage 8 shipped
        // always-menu here; classic direct open was the missing parity.
        if (
            hit.kind === 'browse_field' ||
            (hit.kind === 'container' && hit.source === 'ground')
        ) {
            const simG = simOf();
            const gInst =
                simG && simG.groundItems
                    ? getItem(simG.groundItems.inventory, hit.uid)
                    : null;
            const gItem = gInst
                ? findItem(itemDbOf(), gInst.itemId)
                : null;

            if (
                isClassicLookChord({
                    mode,
                    button: 'right',
                    leftPressed: isMouseButtonDown('left'),
                    rightPressed: true
                })
            ) {
                lookInventoryItem(gItem, gInst, player);
                hideContextMenu();
                return;
            }
            if (shift) {
                lookInventoryItem(gItem, gInst, player);
                hideContextMenu();
                return;
            }
            if (alt) {
                hideContextMenu();
                return;
            }

            const directOpen =
                (mode === 1 && !ctrl) ||
                ((mode === 0 || mode === 2) && ctrl);
            if (directOpen && gItem && itemIsContainer(gItem) && simG) {
                hideContextMenu();
                handleOpenContainerIntent(
                    {
                        type: 'OPEN_CONTAINER',
                        sourceUid: hit.uid,
                        ground: true,
                        slotEl: hit.el
                    },
                    player,
                    simG
                );
                return;
            }

            if (hit.kind === 'browse_field') {
                showBrowseFieldItemMenu(ev.clientX, ev.clientY, player, hit);
            } else {
                showGroundContainerItemMenu(
                    ev.clientX,
                    ev.clientY,
                    player,
                    hit
                );
            }
            return;
        }

        const inst = getItem(player.inventory, hit.uid);
        const item = inst ? findItem(itemDbOf(), inst.itemId) : null;

        // Stage 7: RMB while LMB held → Look (Classic only)
        if (
            isClassicLookChord({
                mode,
                button: 'right',
                leftPressed: isMouseButtonDown('left'),
                rightPressed: true
            })
        ) {
            lookInventoryItem(item, inst, player);
            hideContextMenu();
            return;
        }

        // When the sidebar backpack panel is closed, RMB on the equipped main
        // backpack opens it (classic open-container affordance) unless Shift Look.
        const isMainBackpackSlot =
            hit.kind === 'equipment' &&
            hit.slot === 'backpack' &&
            hit.uid === player.inventory.rootUid;

        // Shift → Look (both modes)
        if (shift) {
            lookInventoryItem(item, inst, player);
            hideContextMenu();
            return;
        }

        // Alt on inventory: no creature target — ignore (do not open menu)
        if (alt) {
            hideContextMenu();
            return;
        }

        // Classic Ctrl → full context menu
        if (mode === 1 && ctrl) {
            showContextMenu(ev.clientX, ev.clientY, hit.uid, hit.el);
            return;
        }

        // Regular / Smart Ctrl → use / open (Smart canvas Ctrl is container-or-menu;
        // inventory keeps direct use/open on Ctrl like Regular.)
        if ((mode === 0 || mode === 2) && ctrl) {
            hideContextMenu();
            if (
                inventoryDirectUseOpenEquip(
                    player,
                    hit,
                    inst,
                    item,
                    isMainBackpackSlot
                )
            ) {
                return;
            }
            showContextMenu(ev.clientX, ev.clientY, hit.uid, hit.el);
            return;
        }

        // Classic unshifted → direct open/use/equip
        if (mode === 1 && !ctrl) {
            if (isMainBackpackSlot && !isSidebarPanelOpen('backpack')) {
                openSidebarPanel('backpack');
                hideContextMenu();
                return;
            }
            if (
                inventoryDirectUseOpenEquip(
                    player,
                    hit,
                    inst,
                    item,
                    isMainBackpackSlot
                )
            ) {
                hideContextMenu();
                return;
            }
        }

        // Regular / Smart unshifted → always menu; Classic fallthrough when no direct action
        showContextMenu(ev.clientX, ev.clientY, hit.uid, hit.el);
    }

    /**
     * Browse Field slot menu (Look / Use / Open / Pick up).
     * Shown on Regular/Smart unshifted RMB, or Classic Ctrl+RMB.
     * Classic unshifted / Regular Ctrl on containers open directly (see onContextMenu).
     * @param {number} clientX
     * @param {number} clientY
     * @param {object} player
     * @param {{ uid: string, x: number, y: number, z: string|number }} hit
     */
    function showBrowseFieldItemMenu(clientX, clientY, player, hit) {
        hideContextMenu();
        const sim = simOf();
        if (!sim || !sim.groundItems || !hit.uid) return;
        const gInst = getItem(sim.groundItems.inventory, hit.uid);
        if (!gInst) return;
        const item = findItem(itemDbOf(), gInst.itemId);
        const range = canPickupFromTile(player, hit.x, hit.y, hit.z);

        ctxMenu = document.createElement('div');
        ctxMenu.className = 'inv-context-menu';
        ctxMenu.style.left = (clientX || 0) + 'px';
        ctxMenu.style.top = (clientY || 0) + 'px';

        /**
         * @param {string} text
         * @param {() => void} fn
         * @param {boolean} [disabled]
         */
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

        if (item && itemSupportsDetailsModal(item)) {
            addItem('View details', () => {
                showEquipmentItemModal(item, {
                    slotKey: preferredEquipSlot(item) || null,
                    genre: genreOf()
                });
            });
        } else {
            addItem('Look', () => {
                emitSystemFloat(
                    player,
                    thingLabel(gInst, item, item && item.id ? String(item.id) : 'Item')
                );
            });
        }

        addItem(
            'Pick up',
            () => {
                const r = pickupItemFromGround({
                    ground: sim.groundItems,
                    uid: hit.uid,
                    playerInv: player.inventory,
                    player,
                    itemDb: itemDbOf()
                });
                handlePickupResult(r, player);
            },
            !range.ok
        );

        if (itemIsUsable(item)) {
            addItem(
                'Use',
                () => {
                    if (!range.ok) {
                        emitSystemFloat(player, 'Too far away');
                        return;
                    }
                    if (!Array.isArray(player.commandQueue)) {
                        player.commandQueue = [];
                    }
                    // Ground USE still requires item in player inv — FCT until ground use exists
                    emitSystemFloat(player, 'Cannot use that here');
                },
                !range.ok
            );
        }
        if (itemIsMultiUse(item)) {
            addItem(
                'Use with...',
                () => {
                    if (!range.ok) {
                        emitSystemFloat(player, 'Too far away');
                        return;
                    }
                    emitSystemFloat(player, 'Cannot use that here');
                },
                !range.ok
            );
        }
        if (itemIsContainer(item)) {
            addItem(
                'Open',
                () => {
                    handleOpenContainerIntent(
                        {
                            type: 'OPEN_CONTAINER',
                            sourceUid: hit.uid,
                            ground: true,
                            slotEl: hit.el
                        },
                        player,
                        sim
                    );
                },
                !range.ok
            );
        }

        document.body.appendChild(ctxMenu);
    }

    /**
     * Context menu for items inside an open ground bag.
     * @param {number} clientX
     * @param {number} clientY
     * @param {object} player
     * @param {{ uid: string, containerUid?: string }} hit
     */
    function showGroundContainerItemMenu(clientX, clientY, player, hit) {
        hideContextMenu();
        const sim = simOf();
        if (!sim || !sim.groundItems || !hit.uid) return;
        const gInv = sim.groundItems.inventory;
        const gInst = getItem(gInv, hit.uid);
        if (!gInst) return;
        const item = findItem(itemDbOf(), gInst.itemId);
        const root = groundRootLocation(sim.groundItems, hit.uid);
        const range = root
            ? canPickupFromTile(player, root.x, root.y, root.z)
            : { ok: false };

        ctxMenu = document.createElement('div');
        ctxMenu.className = 'inv-context-menu';
        ctxMenu.style.left = (clientX || 0) + 'px';
        ctxMenu.style.top = (clientY || 0) + 'px';

        /**
         * @param {string} text
         * @param {() => void} fn
         * @param {boolean} [disabled]
         */
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

        if (item && itemSupportsDetailsModal(item)) {
            addItem('View details', () => {
                showEquipmentItemModal(item, {
                    slotKey: preferredEquipSlot(item) || null,
                    genre: genreOf()
                });
            });
        } else {
            addItem('Look', () => {
                emitSystemFloat(
                    player,
                    thingLabel(gInst, item, item && item.id ? String(item.id) : 'Item')
                );
            });
        }

        addItem(
            'Pick up',
            () => {
                const r = pickupItemFromGround({
                    ground: sim.groundItems,
                    uid: hit.uid,
                    playerInv: player.inventory,
                    player,
                    itemDb: itemDbOf()
                });
                handlePickupResult(r, player);
            },
            !range.ok
        );

        if (itemIsContainer(item)) {
            addItem(
                'Open',
                () => {
                    handleOpenContainerIntent(
                        {
                            type: 'OPEN_CONTAINER',
                            sourceUid: hit.uid,
                            ground: true,
                            slotEl: hit.el
                        },
                        player,
                        sim
                    );
                },
                !range.ok
            );
        }

        document.body.appendChild(ctxMenu);
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

        // Browse Field or ground bag: open nested/ground containers
        if (hit.kind === 'browse_field') {
            const sim = simOf();
            if (!sim || !sim.groundItems) return;
            const gInst = getItem(sim.groundItems.inventory, hit.uid);
            if (!gInst) return;
            const item = findItem(itemDbOf(), gInst.itemId);
            if (itemIsContainer(item)) {
                handleOpenContainerIntent(
                    {
                        type: 'OPEN_CONTAINER',
                        sourceUid: hit.uid,
                        ground: true,
                        slotEl: hit.el
                    },
                    player,
                    sim
                );
            }
            return;
        }

        if (hit.kind === 'container' && hit.source === 'ground') {
            const sim = simOf();
            if (!sim || !sim.groundItems) return;
            const gInst = getItem(sim.groundItems.inventory, hit.uid);
            if (!gInst) return;
            const item = findItem(itemDbOf(), gInst.itemId);
            if (itemIsContainer(item)) {
                handleOpenContainerIntent(
                    {
                        type: 'OPEN_CONTAINER',
                        sourceUid: hit.uid,
                        ground: true,
                        slotEl: hit.el
                    },
                    player,
                    sim
                );
            }
            return;
        }

        const inst = getItem(player.inventory, hit.uid);
        if (!inst) return;
        const item = findItem(itemDbOf(), inst.itemId);
        // Containers open whether nested or equipped; main backpack opens the sidebar panel
        if (itemIsContainer(item) && hit.uid !== player.inventory.rootUid) {
            openContainerPanel(hit.uid, { slotEl: hit.el, origin: 'slot' });
            return;
        }
        if (
            hit.kind === 'equipment' &&
            hit.slot === 'backpack' &&
            hit.uid === player.inventory.rootUid
        ) {
            openSidebarPanel('backpack');
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

    /**
     * Test hook (mouse Talk also goes through handleTalkNpcIntent).
     * `window.__hdlOpenNpcDialog(npcOrId)` is also bound while this panel is live.
     * @param {*} npcOrId
     */
    function openNpcDialogForTest(npcOrId) {
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        const player = getActivePlayerFromSim(sim) || activePlayer();
        return npcDialog.openForTest(npcOrId, player, talkCtx());
    }

    if (typeof window !== 'undefined') {
        window.__hdlOpenNpcDialog = openNpcDialogForTest;
    }

    return {
        refresh: () => {
            lastSig = '';
            paint();
        },
        /**
         * LMB adapter path from manual_control (Look / menu / use-with).
         * @param {object} intent
         * @param {{ player: object, sim: object, clientX?: number, clientY?: number }} ctx
         */
        handleCanvasAdapterIntent,
        openNpcDialogForTest,
        dispose: () => {
            disposed = true;
            if (timer) clearTimeout(timer);
            timer = null;
            if (npcDialog) npcDialog.dispose();
            if (
                typeof window !== 'undefined' &&
                window.__hdlOpenNpcDialog === openNpcDialogForTest
            ) {
                delete window.__hdlOpenNpcDialog;
            }
            closeAllPanels();
            hideContextMenu();
            hideStackSplitModal();
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
