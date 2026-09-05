/**
 * Hunt floating NPC dialog (Stage 6b).
 * Same chrome family as Browse Field; placed to the right of the NPC tile.
 * Session / range live in kernel/core/lib/npc/session.js — this module only paints
 * and enqueues npc_dialog commands. Mouse TALK_NPC adapter lives in inventory_panel.js.
 */

'use strict';

const { isTalkableNpc } = require('../../core/lib/npc/flags.js');
const {
    resolveDialog,
    resolveNode,
    listReplies,
    applyReply
} = require('../../core/lib/npc/dialog.js');
const {
    getTalkSession,
    openTalk,
    closeTalk,
    closeShop,
    takeReply,
    findTalkNpc,
    executeShopDeal
} = require('../../core/lib/npc/session.js');
const { transferFailText, countPlayerItem, resolveItemDb } = require('../../core/lib/npc/items.js');
const { findItem } = require('../../core/lib/character/stats.js');
const {
    resolveShop,
    listShopRows,
    shopDealMax,
    shopFailText,
    shopItemLabel
} = require('../../core/lib/npc/shop.js');
const {
    tileClientRect,
    collectOccupiedRects,
    placeFloatPanel,
    boundsForOrigin
} = require('./float_panel_place.js');
const { resolveItemSpriteUrl } = require('./equipment_panel.js');
const {
    clampShopAmount,
    applyShopAmountDelta,
    defaultShopAmount,
    filterShopRowsByName
} = require('./npc_shop_ui.js');

/**
 * @param {object|null|undefined} npc
 * @returns {string}
 */
function npcLabel(npc) {
    if (!npc || typeof npc !== 'object') return 'NPC';
    if (npc.label != null && String(npc.label).trim()) return String(npc.label).trim();
    if (npc.name != null && String(npc.name).trim()) return String(npc.name).trim();
    if (npc.id != null && String(npc.id).trim()) return String(npc.id);
    return 'NPC';
}

/**
 * @param {object|null|undefined} dialog
 * @param {object|null|undefined} node
 * @returns {string}
 */
function nodeBodyText(dialog, node) {
    if (node && node.text != null && String(node.text) !== '') {
        return String(node.text);
    }
    if (dialog && dialog.greeting != null && String(dialog.greeting) !== '') {
        return String(dialog.greeting);
    }
    return '';
}

/**
 * @param {object} player
 * @param {object} cmd
 */
function enqueueCommand(player, cmd) {
    if (!player || !cmd) return;
    if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
    player.commandQueue.push(cmd);
}

/**
 * @param {object} player
 * @param {*} npcId
 * @param {string} nodeId
 */
function enqueueGoto(player, npcId, nodeId) {
    enqueueCommand(player, {
        type: 'CUSTOM_COMMAND',
        command: 'npc_dialog',
        args: { npcId, nodeId }
    });
}

/**
 * @param {object} player
 */
function enqueueClose(player) {
    enqueueCommand(player, {
        type: 'CUSTOM_COMMAND',
        command: 'npc_dialog',
        args: { action: 'close' }
    });
}

/**
 * @param {object} player
 * @param {*} npcId
 */
function enqueueOpenShop(player, npcId) {
    enqueueCommand(player, {
        type: 'CUSTOM_COMMAND',
        command: 'npc_dialog',
        args: { npcId, action: 'open_shop' }
    });
}

/**
 * @param {object} player
 * @param {*} npcId
 */
function enqueueCloseShop(player, npcId) {
    enqueueCommand(player, {
        type: 'CUSTOM_COMMAND',
        command: 'npc_dialog',
        args: { npcId, action: 'close_shop' }
    });
}

/**
 * @param {object} player
 * @param {*} command
 */
function enqueueCustom(player, command) {
    if (command == null) return;
    if (typeof command === 'string') {
        enqueueCommand(player, { type: 'CUSTOM_COMMAND', command });
        return;
    }
    if (typeof command !== 'object') return;
    if (command.type) {
        enqueueCommand(player, command);
        return;
    }
    enqueueCommand(player, {
        type: 'CUSTOM_COMMAND',
        command: command.command || 'npc_dialog',
        args: command.args
    });
}

/**
 * @param {object|null|undefined} ctx
 * @returns {object|null}
 */
function firstTalkableNpc(ctx) {
    if (!ctx) return null;
    const pools = []
        .concat((ctx.sim && ctx.sim.creatures) || [])
        .concat(ctx.creatures || []);
    for (let i = 0; i < pools.length; i++) {
        if (isTalkableNpc(pools[i])) return pools[i];
    }
    return null;
}

/**
 * Place the panel to the right of the NPC's current tile (canvas clamp).
 * @param {HTMLElement} panel
 * @param {object|null|undefined} npc
 * @param {object|null|undefined} ctx
 * @param {object} o createNpcDialogPanel opts
 * @param {HTMLElement|null} root
 */
function placeNpcPanel(panel, npc, ctx, o, root) {
    const canvas = typeof o.getCanvas === 'function' ? o.getCanvas() : null;
    const sizes =
        typeof o.getTileSize === 'function' ? o.getTileSize() : { w: 32, h: 32 };
    const tile = npc && npc.tile ? npc.tile : null;
    const tileMap = ctx && ctx.sim ? ctx.sim.tileMap : null;
    const anchor = tileClientRect(
        tile,
        canvas,
        tileMap,
        sizes && sizes.w,
        sizes && sizes.h
    );
    placeFloatPanel(panel, {
        anchor,
        bounds: boundsForOrigin(
            'canvas',
            canvas,
            typeof window !== 'undefined' ? window : null
        ),
        occupied: collectOccupiedRects(root, panel),
        fallbackW: 280,
        fallbackH: 120
    });
}

/**
 * Bind header drag (same pattern as Browse Field).
 * @param {HTMLElement} header
 * @param {HTMLElement} el
 */
function bindPanelDrag(header, el) {
    let pan = /** @type {{ x: number, y: number, sl: number, st: number }|null} */ (null);
    header.addEventListener('pointerdown', (ev) => {
        const t = ev && ev.target;
        if (t && typeof t.closest === 'function' && t.closest('button')) return;
        pan = {
            x: ev.clientX,
            y: ev.clientY,
            sl: el.offsetLeft,
            st: el.offsetTop
        };
        if (typeof header.setPointerCapture === 'function' && ev.pointerId != null) {
            header.setPointerCapture(ev.pointerId);
        }
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

/**
 * @param {object} [opts]
 * @param {HTMLElement|null} [opts.floatRoot]
 * @param {() => HTMLElement|null} [opts.getFloatRoot]
 * @param {() => object|null} [opts.getPlayer]
 * @param {() => object|null} [opts.getCtx]
 * @param {() => HTMLElement|null} [opts.getCanvas]
 * @param {() => { w?: number, h?: number }} [opts.getTileSize]
 * @returns {{
 *   sync: function(object|null|undefined, object|null|undefined): void,
 *   hide: function(): void,
 *   isOpen: function(): boolean,
 *   getElement: function(): HTMLElement|null,
 *   openForTest: function(* , object|null|undefined, object|null|undefined): object,
 *   dispose: function(): void
 * }}
 */
function createNpcDialogPanel(opts) {
    const o = opts || {};
    /** @type {HTMLElement|null} */
    let el = null;
    let lastSig = '';
    let docBound = false;
    /** @type {{ npcId: *, side: 'buy'|'sell', search: string, selectedItemId: string|null, amount: number }|null} */
    let shopUi = null;

    function resetShopUi() {
        shopUi = null;
    }

    /**
     * @param {object|null|undefined} npc
     */
    function ensureShopUi(npc) {
        const id = npc && npc.id != null ? npc.id : null;
        if (!shopUi || String(shopUi.npcId) !== String(id)) {
            shopUi = {
                npcId: id,
                side: 'buy',
                search: '',
                selectedItemId: null,
                amount: 1
            };
        }
        return shopUi;
    }

    const rootOf = () => {
        if (typeof o.getFloatRoot === 'function') {
            const r = o.getFloatRoot();
            if (r) return r;
        }
        if (o.floatRoot) return o.floatRoot;
        if (typeof document !== 'undefined') {
            return document.getElementById('inventoryFloatRoot');
        }
        return null;
    };

    const playerOf = () =>
        typeof o.getPlayer === 'function' ? o.getPlayer() : null;

    const ctxOf = () => (typeof o.getCtx === 'function' ? o.getCtx() : null);

    function hide() {
        if (el) {
            if (typeof el.remove === 'function') el.remove();
            else if (el.parentNode) el.parentNode.removeChild(el);
        }
        el = null;
        lastSig = '';
        resetShopUi();
    }

    function requestClose(player) {
        const prev = getTalkSession(player);
        closeTalk(player);
        if (prev) enqueueClose(player);
        hide();
    }

    /**
     * @param {object} player
     * @param {object} npc
     * @param {object} dialog
     * @param {object} node
     * @param {string} nodeId
     * @param {object|null|undefined} ctx
     */
    function render(player, npc, dialog, node, nodeId, ctx) {
        const root = rootOf();
        if (!root || typeof document === 'undefined' || !document.createElement) {
            return;
        }

        let justCreated = false;
        if (!el) {
            el = document.createElement('div');
            el.className = 'inv-float-panel inv-npc-dialog-panel';
            el.dataset.npcDialog = '1';
            const header = document.createElement('div');
            header.className = 'inv-panel-header';
            const title = document.createElement('span');
            title.className = 'inv-panel-title';
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'inv-panel-close';
            closeBtn.setAttribute('aria-label', 'Close');
            closeBtn.textContent = '\u00d7';
            closeBtn.addEventListener('click', () => {
                requestClose(playerOf() || player);
            });
            header.appendChild(title);
            header.appendChild(closeBtn);
            const bodyWrap = document.createElement('div');
            bodyWrap.className = 'inv-npc-dialog-body';
            const body = document.createElement('div');
            body.className = 'inv-npc-dialog-text';
            const repliesEl = document.createElement('div');
            repliesEl.className = 'inv-npc-dialog-replies';
            bodyWrap.appendChild(body);
            bodyWrap.appendChild(repliesEl);
            const shopEl = document.createElement('div');
            shopEl.className = 'inv-npc-shop';
            shopEl.hidden = true;
            el.appendChild(header);
            el.appendChild(bodyWrap);
            el.appendChild(shopEl);
            root.appendChild(el);
            bindPanelDrag(header, el);
            justCreated = true;
        }

        el.dataset.nodeId = String(nodeId);
        const titleEl = el.querySelector('.inv-panel-title');
        if (titleEl) titleEl.textContent = npcLabel(npc);
        const textEl = el.querySelector('.inv-npc-dialog-text');
        if (textEl) textEl.textContent = nodeBodyText(dialog, node);

        const bodyWrap = el.querySelector('.inv-npc-dialog-body');
        const repliesEl = el.querySelector('.inv-npc-dialog-replies');
        const shopEl = el.querySelector('.inv-npc-shop');
        if (!repliesEl) {
            if (justCreated) placeNpcPanel(el, npc, ctx, o, root);
            return;
        }
        const session = getTalkSession(player);
        if (session && session.shop) {
            while (repliesEl.firstChild) {
                repliesEl.removeChild(repliesEl.firstChild);
            }
            repliesEl.hidden = true;
            if (bodyWrap) bodyWrap.hidden = true;
            if (shopEl) shopEl.hidden = false;
            el.classList.add('is-shop');
            renderShop(player, npc, shopEl, ctx);
            if (justCreated) placeNpcPanel(el, npc, ctx, o, root);
            return;
        }
        resetShopUi();
        repliesEl.hidden = false;
        if (bodyWrap) bodyWrap.hidden = false;
        if (shopEl) {
            shopEl.hidden = true;
            while (shopEl.firstChild) shopEl.removeChild(shopEl.firstChild);
        }
        el.classList.remove('is-shop');
        while (repliesEl.firstChild) {
            repliesEl.removeChild(repliesEl.firstChild);
        }
        const replies = listReplies(node, player);
        for (let i = 0; i < replies.length; i++) {
            const reply = replies[i];
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'inv-npc-dialog-reply';
            btn.textContent = reply.label;
            btn.dataset.replyIndex = String(i);
            btn.dataset.replyAction = reply.action;
            const preview = applyReply(dialog, reply, player);
            if (preview.ok && preview.kind === 'stub') {
                btn.disabled = true;
                btn.classList.add('is-stub');
            }
            btn.addEventListener('click', () => {
                onReply(playerOf() || player, npc, dialog, reply, ctx);
            });
            repliesEl.appendChild(btn);
        }
        if (justCreated) placeNpcPanel(el, npc, ctx, o, root);
    }

    /**
     * @param {object} player
     * @param {object} npc
     * @param {HTMLElement|null} shopEl
     * @param {object|null|undefined} ctx
     */
    function renderShop(player, npc, shopEl, ctx) {
        if (!shopEl) return;
        while (shopEl.firstChild) shopEl.removeChild(shopEl.firstChild);
        const ui = ensureShopUi(npc);
        const shop = resolveShop(npc);
        const itemDb = resolveItemDb(player, ctx);
        if (!shop) {
            const empty = document.createElement('div');
            empty.className = 'inv-npc-shop-empty';
            empty.textContent = 'Nothing to sell.';
            shopEl.appendChild(empty);
            shopEl.appendChild(makeBackBtn(player, npc));
            return;
        }

        const tabs = document.createElement('div');
        tabs.className = 'inv-npc-shop-tabs';
        tabs.setAttribute('role', 'tablist');
        tabs.appendChild(makeShopTab(player, npc, shopEl, ctx, 'buy', ui.side === 'buy'));
        tabs.appendChild(makeShopTab(player, npc, shopEl, ctx, 'sell', ui.side === 'sell'));
        shopEl.appendChild(tabs);

        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'inv-npc-shop-search';
        search.setAttribute('placeholder', 'Search');
        search.setAttribute('aria-label', 'Search');
        search.value = ui.search;
        shopEl.appendChild(search);

        const listEl = document.createElement('div');
        listEl.className = 'inv-npc-shop-list';
        shopEl.appendChild(listEl);

        const deal = makeShopDeal();
        shopEl.appendChild(deal.root);
        shopEl.appendChild(makeBackBtn(player, npc));

        const livePlayer = () => playerOf() || player;

        function sideRows() {
            return listShopRows(shop, livePlayer(), { side: ui.side });
        }

        function visibleRows() {
            return filterShopRowsByName(sideRows(), ui.search, itemDb);
        }

        function selectedRow() {
            const rows = visibleRows();
            if (ui.selectedItemId) {
                for (let i = 0; i < rows.length; i++) {
                    if (rows[i].itemId === ui.selectedItemId) return rows[i];
                }
            }
            return rows[0] || null;
        }

        function currentMax() {
            return shopDealMax(livePlayer(), shop, selectedRow(), ui.side);
        }

        function unitPrice(row) {
            if (!row) return 0;
            return ui.side === 'sell' ? row.sell : row.buy;
        }

        function canAffordRow(row) {
            if (!row) return false;
            const p = livePlayer();
            if (ui.side === 'sell') return countPlayerItem(p, row.itemId) > 0;
            return countPlayerItem(p, shop.currency) >= unitPrice(row);
        }

        function applyAmount(n) {
            const max = currentMax();
            ui.amount = clampShopAmount(n, 1, max);
            deal.slider.min = '1';
            deal.slider.max = String(max);
            deal.slider.value = String(ui.amount);
            deal.amountInput.value = String(ui.amount);
            const row = selectedRow();
            const unit = unitPrice(row);
            deal.price.textContent = row ? String(unit) : '—';
            deal.total.textContent = row ? String(unit * ui.amount) : '—';
            const coinLabel = shopItemLabel(shop.currency, itemDb) || shop.currency;
            deal.currency.textContent =
                coinLabel + ': ' + String(countPlayerItem(livePlayer(), shop.currency));
            const sideClass = ui.side === 'sell' ? 'inv-npc-shop-sell' : 'inv-npc-shop-buy';
            deal.confirm.className = 'inv-npc-shop-confirm ' + sideClass;
            deal.confirm.textContent = ui.side === 'sell' ? 'Sell' : 'Buy';
            deal.confirm.dataset.shopSide = ui.side;
            if (row) {
                deal.confirm.dataset.itemId = row.itemId;
                deal.confirm.disabled = false;
            } else {
                deal.confirm.dataset.itemId = '';
                deal.confirm.disabled = true;
            }
        }

        function refreshList() {
            const rows = visibleRows();
            const prevId = ui.selectedItemId;
            const picked = selectedRow();
            ui.selectedItemId = picked ? picked.itemId : null;
            if (picked && picked.itemId !== prevId) {
                ui.amount = defaultShopAmount(
                    ui.side,
                    shopDealMax(livePlayer(), shop, picked, ui.side)
                );
            }
            while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
            if (!rows.length) {
                const empty = document.createElement('div');
                empty.className = 'inv-npc-shop-empty';
                empty.textContent = ui.search ? 'No matching items.' : 'Nothing to sell.';
                listEl.appendChild(empty);
            }
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const rowEl = makeShopRow(row, itemDb, ui.side, livePlayer());
                if (picked && row.itemId === picked.itemId) {
                    rowEl.classList.add('is-selected');
                }
                if (!canAffordRow(row)) rowEl.classList.add('is-unaffordable');
                rowEl.addEventListener('click', () => {
                    const same = ui.selectedItemId === row.itemId;
                    ui.selectedItemId = row.itemId;
                    if (!same) {
                        ui.amount = defaultShopAmount(
                            ui.side,
                            shopDealMax(livePlayer(), shop, row, ui.side)
                        );
                    }
                    refreshList();
                });
                listEl.appendChild(rowEl);
            }
            applyAmount(ui.amount);
        }

        search.addEventListener('input', () => {
            ui.search = search.value != null ? String(search.value) : '';
            refreshList();
        });
        search.addEventListener('change', () => {
            ui.search = search.value != null ? String(search.value) : '';
            refreshList();
        });

        deal.slider.addEventListener('input', () => {
            applyAmount(deal.slider.value);
        });
        deal.amountInput.addEventListener('input', () => {
            applyAmount(deal.amountInput.value);
        });
        deal.amountInput.addEventListener('change', () => {
            applyAmount(deal.amountInput.value);
        });
        deal.amountInput.addEventListener('keydown', (ev) => {
            const key = ev && ev.key;
            if (key !== 'ArrowUp' && key !== 'Up' && key !== 'ArrowDown' && key !== 'Down') {
                return;
            }
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            const dir = key === 'ArrowDown' || key === 'Down' ? -1 : 1;
            applyAmount(applyShopAmountDelta(ui.amount, dir, ev, 1, currentMax()));
        });
        deal.dec.addEventListener('click', (ev) => {
            applyAmount(applyShopAmountDelta(ui.amount, -1, ev, 1, currentMax()));
        });
        deal.inc.addEventListener('click', (ev) => {
            applyAmount(applyShopAmountDelta(ui.amount, 1, ev, 1, currentMax()));
        });
        const onWheel = (ev) => {
            if (typeof ev.preventDefault === 'function') ev.preventDefault();
            const dir = ev && ev.deltaY < 0 ? 1 : -1;
            applyAmount(applyShopAmountDelta(ui.amount, dir, ev, 1, currentMax()));
        };
        deal.amountRow.addEventListener('wheel', onWheel, { passive: false });
        deal.confirm.addEventListener('click', () => {
            const row = selectedRow();
            if (!row) return;
            onShopDeal(livePlayer(), npc, ui.side, row.itemId, ui.amount, ctx);
        });

        if (!ui.selectedItemId) {
            const first = visibleRows()[0];
            if (first) {
                ui.selectedItemId = first.itemId;
                ui.amount = defaultShopAmount(
                    ui.side,
                    shopDealMax(livePlayer(), shop, first, ui.side)
                );
            }
        }
        refreshList();
    }

    /**
     * @param {object} player
     * @param {object} npc
     * @param {HTMLElement} shopEl
     * @param {object|null|undefined} ctx
     * @param {'buy'|'sell'} side
     * @param {boolean} active
     * @returns {HTMLElement}
     */
    function makeShopTab(player, npc, shopEl, ctx, side, active) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'inv-npc-shop-tab' + (active ? ' is-active' : '');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-pressed', active ? 'true' : 'false');
        tab.dataset.shopSide = side;
        tab.textContent = side === 'sell' ? 'Sell' : 'Buy';
        tab.addEventListener('click', () => {
            const ui = ensureShopUi(npc);
            if (ui.side === side) return;
            ui.side = side;
            ui.search = '';
            ui.selectedItemId = null;
            ui.amount = 1;
            renderShop(playerOf() || player, npc, shopEl, ctx);
        });
        return tab;
    }

    /**
     * @param {object} player
     * @param {object} npc
     * @returns {HTMLElement}
     */
    function makeBackBtn(player, npc) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'inv-npc-shop-back';
        back.textContent = 'Back';
        back.addEventListener('click', () => {
            onBackFromShop(playerOf() || player, npc);
        });
        return back;
    }

    /**
     * @param {object} row
     * @param {object[]|Record<string, object>|null} itemDb
     * @param {'buy'|'sell'} side
     * @param {object} player
     * @returns {HTMLElement}
     */
    function makeShopRow(row, itemDb, side, player) {
        const rowEl = document.createElement('div');
        rowEl.className = 'inv-npc-shop-row';
        rowEl.dataset.itemId = row.itemId;
        rowEl.dataset.shopSide = side;
        const item = findItem(itemDb, row.itemId);
        if (item && (item.sprites || item.sprite || item.customSprite || item.spriteId)) {
            const url = resolveItemSpriteUrl(item);
            if (url) {
                const img = document.createElement('img');
                img.className = 'inv-npc-shop-icon';
                img.alt = '';
                img.src = url;
                img.draggable = false;
                img.onerror = () => {
                    if (img.parentNode) img.parentNode.removeChild(img);
                };
                rowEl.appendChild(img);
            }
        }
        const name = document.createElement('span');
        name.className = 'inv-npc-shop-name';
        name.textContent = shopItemLabel(row.itemId, itemDb);
        const price = document.createElement('span');
        price.className = 'inv-npc-shop-price';
        price.textContent = String(side === 'sell' ? row.sell : row.buy);
        rowEl.appendChild(name);
        rowEl.appendChild(price);
        if (side === 'sell') {
            const have = document.createElement('span');
            have.className = 'inv-npc-shop-have';
            have.textContent = String(countPlayerItem(player, row.itemId));
            rowEl.appendChild(have);
        }
        return rowEl;
    }

    /**
     * @returns {{
     *   root: HTMLElement,
     *   amountRow: HTMLElement,
     *   slider: HTMLInputElement,
     *   amountInput: HTMLInputElement,
     *   dec: HTMLElement,
     *   inc: HTMLElement,
     *   price: HTMLElement,
     *   total: HTMLElement,
     *   currency: HTMLElement,
     *   confirm: HTMLButtonElement
     * }}
     */
    function makeShopDeal() {
        const root = document.createElement('div');
        root.className = 'inv-npc-shop-deal';

        const amountRow = document.createElement('div');
        amountRow.className = 'inv-npc-shop-amount-row';
        const dec = document.createElement('button');
        dec.type = 'button';
        dec.className = 'inv-npc-shop-amount-dec';
        dec.setAttribute('aria-label', 'Decrease amount');
        dec.textContent = '\u2212';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'inv-npc-shop-amount-slider';
        slider.min = '1';
        slider.max = '1';
        slider.value = '1';
        slider.step = '1';
        const amountInput = document.createElement('input');
        amountInput.type = 'number';
        amountInput.className = 'inv-npc-shop-amount-input';
        amountInput.min = '1';
        amountInput.value = '1';
        amountInput.setAttribute('aria-label', 'Amount');
        const inc = document.createElement('button');
        inc.type = 'button';
        inc.className = 'inv-npc-shop-amount-inc';
        inc.setAttribute('aria-label', 'Increase amount');
        inc.textContent = '+';
        amountRow.appendChild(dec);
        amountRow.appendChild(slider);
        amountRow.appendChild(amountInput);
        amountRow.appendChild(inc);
        root.appendChild(amountRow);

        const meta = document.createElement('div');
        meta.className = 'inv-npc-shop-deal-meta';
        const price = addDealMetaRow(meta, 'Price', 'inv-npc-shop-unit-price');
        const total = addDealMetaRow(meta, 'Total', 'inv-npc-shop-total');
        const currency = document.createElement('div');
        currency.className = 'inv-npc-shop-currency';
        currency.textContent = '';
        meta.appendChild(currency);
        root.appendChild(meta);

        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'inv-npc-shop-confirm inv-npc-shop-buy';
        confirm.textContent = 'Buy';
        root.appendChild(confirm);

        return {
            root,
            amountRow,
            slider,
            amountInput,
            dec,
            inc,
            price,
            total,
            currency,
            confirm
        };
    }

    /**
     * @param {HTMLElement} parent
     * @param {string} label
     * @param {string} valueClass
     * @returns {HTMLElement}
     */
    function addDealMetaRow(parent, label, valueClass) {
        const row = document.createElement('div');
        row.className = 'inv-npc-shop-deal-row';
        const lab = document.createElement('span');
        lab.className = 'inv-npc-shop-deal-label';
        lab.textContent = label;
        const val = document.createElement('span');
        val.className = valueClass;
        val.textContent = '—';
        row.appendChild(lab);
        row.appendChild(val);
        parent.appendChild(row);
        return val;
    }

    /**
     * @param {object} player
     * @param {object} npc
     */
    function onBackFromShop(player, npc) {
        resetShopUi();
        closeShop(player);
        if (npc) enqueueCloseShop(player, npc.id);
        lastSig = '';
        sync(player, ctxOf());
    }

    /**
     * Live click commits immediately (same as give/take). TAS uses the
     * queued buy/sell command; hunt_ai must not see a second copy — the
     * panel does not enqueue the deal (open_shop is idempotent and is queued).
     * @param {object} player
     * @param {object} npc
     * @param {'buy'|'sell'} side
     * @param {string} itemId
     * @param {number} [count]
     * @param {object|null|undefined} ctx
     */
    function onShopDeal(player, npc, side, itemId, count, ctx) {
        const result = executeShopDeal(
            player,
            npc,
            { action: side, itemId, count: count != null ? count : 1 },
            ctx
        );
        if (!result.ok) {
            const text = shopFailText(result.reason, {
                text: result.text,
                side
            });
            if (text && typeof o.onSystemFloat === 'function') {
                o.onSystemFloat(player, text);
            }
            return;
        }
        if (typeof o.onInventoryMutation === 'function') {
            o.onInventoryMutation();
        }
        lastSig = '';
        sync(player, ctx);
    }

    /**
     * @param {object} player
     * @param {object} npc
     * @param {object} dialog
     * @param {object} reply
     * @param {object|null|undefined} ctx
     */
    function onReply(player, npc, dialog, reply, ctx) {
        const result = takeReply(player, npc, reply, ctx);
        if (!result.ok) {
            const text =
                shopFailText(result.reason, { text: result.text }) ||
                transferFailText(result.reason);
            if (text && typeof o.onSystemFloat === 'function') {
                o.onSystemFloat(player, text);
            }
            return;
        }
        if (result.transferred && typeof o.onInventoryMutation === 'function') {
            o.onInventoryMutation();
        }
        if (result.kind === 'close') {
            enqueueClose(player);
            hide();
            return;
        }
        if (result.kind === 'open_shop') {
            enqueueOpenShop(player, npc.id);
            if (result.next === 'goto' && result.nodeId) {
                enqueueGoto(player, npc.id, result.nodeId);
            }
            lastSig = '';
            sync(player, ctx);
            return;
        }
        if (result.kind === 'goto' || result.next === 'goto') {
            enqueueGoto(player, npc.id, result.nodeId);
            lastSig = '';
            sync(player, ctx);
            return;
        }
        if (result.kind === 'custom') {
            enqueueCustom(player, result.command);
            return;
        }
        if (result.kind === 'give_item' || result.kind === 'take_item') {
            lastSig = '';
            sync(player, ctx);
            return;
        }
    }

    /**
     * Paint from player._npcTalk. Missing session hides the panel.
     * @param {object|null|undefined} player
     * @param {object|null|undefined} ctx
     */
    function sync(player, ctx) {
        const session = getTalkSession(player);
        if (!session) {
            hide();
            return;
        }
        const npc = findTalkNpc(ctx, session.npcId);
        if (!npc) {
            hide();
            return;
        }
        const resolved = resolveDialog(npc);
        if (!resolved.ok) {
            hide();
            return;
        }
        const node = resolveNode(resolved.dialog, session.nodeId);
        if (!node.ok) {
            hide();
            return;
        }
        const replySig = listReplies(node.node, player)
            .map((r) => r.label)
            .join('|');
        const shop = session.shop ? resolveShop(npc) : null;
        const shopSig = session.shop
            ? 'shop:' +
              String(shop ? countPlayerItem(player, shop.currency) : 0) +
              ':' +
              listShopRows(shop, player)
                  .map((r) => r.itemId + ':' + r.buy + ':' + r.sell)
                  .join('|')
            : 'dialog';
        const sig =
            String(session.npcId) +
            ':' +
            String(session.nodeId) +
            ':' +
            nodeBodyText(resolved.dialog, node.node) +
            ':' +
            replySig +
            ':' +
            shopSig;
        if (sig === lastSig && el) return;
        lastSig = sig;
        render(player, npc, resolved.dialog, node.node, node.nodeId, ctx);
    }

    /**
     * Phase 4 test hook — mouse Talk adapter is Phase 5.
     * @param {*} npcOrId
     * @param {object|null|undefined} [player]
     * @param {object|null|undefined} [ctx]
     * @returns {{ ok: boolean, reason?: string, session?: object, nodeId?: string }}
     */
    function openForTest(npcOrId, player, ctx) {
        const p = player || playerOf();
        const c = ctx || ctxOf();
        let npc = null;
        if (npcOrId && typeof npcOrId === 'object' && npcOrId.dialog != null) {
            npc = npcOrId;
        } else if (npcOrId && typeof npcOrId === 'object' && isTalkableNpc(npcOrId)) {
            npc = npcOrId;
        } else if (npcOrId != null && npcOrId !== '') {
            npc = findTalkNpc(c, npcOrId);
        } else {
            npc = firstTalkableNpc(c);
        }
        if (!p || !npc) return { ok: false, reason: 'missing' };
        const opened = openTalk(p, npc);
        if (!opened.ok) return opened;
        enqueueGoto(p, npc.id, opened.nodeId);
        lastSig = '';
        sync(p, c);
        return opened;
    }

    function onKey(ev) {
        if (!el) return;
        const key = ev && ev.key;
        if (key !== 'Escape' && key !== 'Esc') return;
        requestClose(playerOf());
    }

    function onDocPointer(ev) {
        if (!el) return;
        const t = ev && ev.target;
        if (t && typeof el.contains === 'function' && el.contains(t)) return;
        if (
            t &&
            typeof t.closest === 'function' &&
            t.closest('.inv-npc-dialog-panel')
        ) {
            return;
        }
        requestClose(playerOf());
    }

    function bindDoc() {
        if (docBound || typeof document === 'undefined') return;
        if (typeof document.addEventListener !== 'function') return;
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDocPointer);
        docBound = true;
    }

    function unbindDoc() {
        if (!docBound || typeof document === 'undefined') return;
        if (typeof document.removeEventListener === 'function') {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDocPointer);
        }
        docBound = false;
    }

    bindDoc();

    return {
        sync,
        hide,
        isOpen: () => !!el,
        getElement: () => el,
        openForTest,
        dispose: () => {
            hide();
            unbindDoc();
        }
    };
}

module.exports = {
    npcLabel,
    nodeBodyText,
    enqueueGoto,
    enqueueClose,
    enqueueOpenShop,
    enqueueCloseShop,
    createNpcDialogPanel
};
