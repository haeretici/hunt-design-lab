/**
 * Per-player NPC talk session (Stage 6b).
 * Headless-safe: no UI. Range and flags are re-checked at process time
 * so TAS / replay cannot talk to a unit that is dead, hostile, or too far.
 */

'use strict';

const {
    isTalkableNpc,
    isHostileNeverTalk
} = require('./flags.js');
const {
    resolveDialog,
    resolveNode,
    listReplies,
    applyReply,
    commitReplyPatch
} = require('./dialog.js');
const { applyStoragePatch } = require('./storage.js');
const {
    transferFromReply,
    commitItemTransfer,
    resolveItemDb
} = require('./items.js');
const {
    resolveShop,
    shopMatchesWhen,
    buyFromShop,
    sellToShop
} = require('./shop.js');

const SHOP_ACTIONS = {
    shop: 'open_shop',
    open_shop: 'open_shop',
    trade: 'open_shop',
    close_shop: 'close_shop',
    buy: 'buy',
    sell: 'sell'
};

/** Chebyshev talk range (same floor). Client lock; do not adopt server 4. */
const TALK_RANGE = 3;

/**
 * Chebyshev distance on the same floor, or Infinity if floors differ / missing.
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} a
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} b
 * @returns {number}
 */
function chebyshevSameFloor(a, b) {
    if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) {
        return Infinity;
    }
    if (String(a.z != null ? a.z : 0) !== String(b.z != null ? b.z : 0)) {
        return Infinity;
    }
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isLiving(entity) {
    if (!entity) return false;
    if (entity.alive === false) return false;
    if (entity.hp && typeof entity.hp === 'object' && entity.hp.current <= 0) {
        return false;
    }
    return true;
}

/**
 * Process-time talk gate: living talkable NPC, same floor, Chebyshev ≤ 3.
 * @param {object|null|undefined} player
 * @param {object|null|undefined} npc
 * @returns {{ ok: true, dist: number } | { ok: false, reason: string }}
 */
function canTalkToNpc(player, npc) {
    if (!player || !npc) return { ok: false, reason: 'missing' };
    if (!isLiving(player) || !isLiving(npc)) return { ok: false, reason: 'dead' };
    if (isHostileNeverTalk(npc)) return { ok: false, reason: 'hostile' };
    if (!isTalkableNpc(npc)) return { ok: false, reason: 'not_talkable' };
    const playerTile = player.tile;
    const npcTile = npc.tile;
    if (!playerTile || !npcTile) return { ok: false, reason: 'out_of_range' };
    if (String(playerTile.z != null ? playerTile.z : 0) !== String(npcTile.z != null ? npcTile.z : 0)) {
        return { ok: false, reason: 'wrong_floor' };
    }
    const dist = chebyshevSameFloor(playerTile, npcTile);
    if (dist > TALK_RANGE) return { ok: false, reason: 'out_of_range' };
    return { ok: true, dist };
}

/**
 * @param {object|null|undefined} player
 * @returns {{ npcId: *, dialogId: string|null, nodeId: string }|null}
 */
function getTalkSession(player) {
    if (!player || !player._npcTalk || typeof player._npcTalk !== 'object') {
        return null;
    }
    return player._npcTalk;
}

/**
 * @param {object} npc
 * @param {object} dialog
 * @returns {string|null}
 */
function resolveDialogId(npc, dialog) {
    if (npc && npc.dialogId != null && String(npc.dialogId).trim()) {
        return String(npc.dialogId).trim();
    }
    if (dialog && dialog.id != null && String(dialog.id).trim()) {
        return String(dialog.id).trim();
    }
    return null;
}

/**
 * Open or jump the conversation to a node after range/flag re-check.
 * @param {object} player
 * @param {object} npc
 * @param {string} [nodeId]
 * @returns {{ ok: true, session: object, dialog: object, node: object, nodeId: string, source: string } | { ok: false, reason: string }}
 */
function setTalk(player, npc, nodeId) {
    const gate = canTalkToNpc(player, npc);
    if (!gate.ok) return gate;
    const resolved = resolveDialog(npc);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const node = resolveNode(resolved.dialog, nodeId);
    if (!node.ok) return { ok: false, reason: node.reason };
    player._npcTalk = {
        npcId: npc.id,
        dialogId: resolveDialogId(npc, resolved.dialog),
        nodeId: node.nodeId
    };
    if (node.node && node.node.set) {
        applyStoragePatch(player, node.node.set);
    }
    return {
        ok: true,
        session: player._npcTalk,
        dialog: resolved.dialog,
        node: node.node,
        nodeId: node.nodeId,
        source: resolved.source
    };
}

/**
 * Open talk on the greet / start node (or an explicit node).
 * @param {object} player
 * @param {object} npc
 * @param {string} [nodeId]
 * @returns {{ ok: true, session: object, dialog: object, node: object, nodeId: string, source: string } | { ok: false, reason: string }}
 */
function openTalk(player, npc, nodeId) {
    return setTalk(player, npc, nodeId);
}

/**
 * Jump to a named node. Creates the session if none exists (same gate as open).
 * @param {object} player
 * @param {object} npc
 * @param {string} nodeId
 * @returns {{ ok: true, session: object, dialog: object, node: object, nodeId: string, source: string } | { ok: false, reason: string }}
 */
function gotoTalk(player, npc, nodeId) {
    if (nodeId == null || !String(nodeId).trim()) {
        return { ok: false, reason: 'unknown_node' };
    }
    return setTalk(player, npc, nodeId);
}

/**
 * Clear the conversation. Always succeeds (Escape / Bye / later walk-away).
 * @param {object|null|undefined} player
 * @returns {{ ok: true, closed: object|null }}
 */
function closeTalk(player) {
    const prev = getTalkSession(player);
    if (player) player._npcTalk = null;
    return { ok: true, closed: prev };
}

/**
 * Resolve a live NPC from the sim / AOI maps. Numeric string ids coerce.
 * @param {object|null|undefined} ctx
 * @param {*} npcId
 * @returns {object|null}
 */
function findTalkNpc(ctx, npcId) {
    if (npcId == null || npcId === '' || !ctx) return null;
    const n = Number(npcId);
    const numeric = Number.isFinite(n) ? n : null;
    const maps = [ctx.entityById, ctx.creatureById];
    if (ctx.sim) maps.push(ctx.sim.entityById);
    for (let i = 0; i < maps.length; i++) {
        const map = maps[i];
        if (!map || typeof map.get !== 'function') continue;
        if (map.has && map.has(npcId)) return map.get(npcId);
        if (numeric != null && map.has && map.has(numeric)) return map.get(numeric);
        const asString = String(npcId);
        if (map.has && map.has(asString)) return map.get(asString);
        const hit = map.get(npcId) || (numeric != null ? map.get(numeric) : null);
        if (hit) return hit;
    }
    if (ctx.sim && typeof ctx.sim.getEntityById === 'function') {
        const hit =
            ctx.sim.getEntityById(npcId) ||
            (numeric != null ? ctx.sim.getEntityById(numeric) : null);
        if (hit) return hit;
    }
    const pools = []
        .concat(ctx.enemies || [])
        .concat(ctx.players || [])
        .concat((ctx.sim && ctx.sim.creatures) || [])
        .concat(ctx.creatures || []);
    for (let i = 0; i < pools.length; i++) {
        const c = pools[i];
        if (!c) continue;
        if (c.id === npcId) return c;
        if (numeric != null && c.id === numeric) return c;
        if (String(c.id) === String(npcId)) return c;
    }
    return null;
}

/**
 * @param {*} raw
 * @returns {string}
 */
function parseItemArg(raw) {
    return raw != null && String(raw).trim() ? String(raw).trim() : '';
}

/**
 * Locked Q6.3 grammar:
 *   { type: 'CUSTOM_COMMAND', command: 'npc_dialog', args: { npcId, nodeId } }
 *   { command: 'npc_dialog', args: { action: 'close' } }
 *   { command: 'npc_dialog', args: { npcId, action: 'open_shop'|'close_shop'|'buy'|'sell', itemId?, count? } }
 *   npc_dialog <npcId> [nodeId]
 *   npc_dialog close
 *   npc_dialog <npcId> shop|open_shop|trade|close_shop
 *   npc_dialog <npcId> buy|sell <itemId> [count]
 * Reserved tokens (not node ids in the string form): close, shop, open_shop, trade, close_shop, buy, sell.
 * @param {object|null|undefined} cmd
 * @returns {{ action: string, npcId?: *, nodeId?: string|null, itemId?: string, count?: number } | null}
 */
function parseNpcDialogCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return null;
    const raw = String(cmd.command || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (lower !== 'npc_dialog' && lower.indexOf('npc_dialog ') !== 0) return null;

    const args =
        cmd.args && typeof cmd.args === 'object' && !Array.isArray(cmd.args)
            ? cmd.args
            : null;

    if (args && args.action != null && String(args.action).trim()) {
        const act = String(args.action).trim().toLowerCase();
        if (act === 'close') {
            return {
                action: 'close',
                npcId: args.npcId != null ? args.npcId : null
            };
        }
        const shopAct = SHOP_ACTIONS[act];
        if (shopAct) {
            /** @type {{ action: string, npcId: *, itemId?: string, count?: number }} */
            const out = {
                action: shopAct,
                npcId: args.npcId != null ? args.npcId : null
            };
            if (shopAct === 'buy' || shopAct === 'sell') {
                out.itemId = parseItemArg(
                    args.itemId != null ? args.itemId : args.item
                );
                if (args.count != null && Number.isFinite(Number(args.count))) {
                    out.count = Math.floor(Number(args.count));
                }
            }
            return out;
        }
    }

    if (lower === 'npc_dialog' && args && args.npcId != null && String(args.npcId) !== '') {
        const nodeId =
            args.nodeId != null && String(args.nodeId).trim()
                ? String(args.nodeId).trim()
                : null;
        return { action: 'talk', npcId: args.npcId, nodeId };
    }

    const parts = raw.split(/\s+/);
    if (parts.length < 2) return null;
    if (String(parts[1]).toLowerCase() === 'close') {
        return { action: 'close', npcId: null };
    }
    const token = parts[1];
    const asNum = Number(token);
    const npcId =
        Number.isFinite(asNum) && String(asNum) === String(token) ? asNum : token;
    const third = parts[2] ? String(parts[2]).toLowerCase() : '';
    if (third === 'close') {
        return { action: 'close', npcId };
    }
    if (third && SHOP_ACTIONS[third]) {
        const shopAct = SHOP_ACTIONS[third];
        /** @type {{ action: string, npcId: *, itemId?: string, count?: number }} */
        const out = { action: shopAct, npcId };
        if (shopAct === 'buy' || shopAct === 'sell') {
            out.itemId = parseItemArg(parts[3]);
            if (parts[4] != null && Number.isFinite(Number(parts[4]))) {
                out.count = Math.floor(Number(parts[4]));
            }
        }
        return out;
    }
    return {
        action: 'talk',
        npcId,
        nodeId: parts[2] ? String(parts[2]) : null
    };
}

/**
 * Open the vendor-lite shop on an existing (or new) talk session.
 * Re-checks range + shop.when. Headless-safe (no UI).
 * @param {object} player
 * @param {object} npc
 * @returns {{ ok: boolean, reason?: string, text?: string, session?: object, shop?: object }}
 */
function openShop(player, npc) {
    const gate = canTalkToNpc(player, npc);
    if (!gate.ok) return gate;
    const shop = resolveShop(npc);
    if (!shop) return { ok: false, reason: 'no_shop' };
    if (!shopMatchesWhen(player, shop)) {
        return { ok: false, reason: 'shop_when', text: shop.denyText || null };
    }
    if (!getTalkSession(player)) {
        const opened = openTalk(player, npc);
        if (!opened.ok) return opened;
    }
    const session = getTalkSession(player);
    if (!session) return { ok: false, reason: 'missing' };
    session.shop = true;
    return { ok: true, kind: 'open_shop', session, shop };
}

/**
 * Leave the shop view; talk session stays on the current node.
 * @param {object|null|undefined} player
 * @returns {{ ok: true, kind: string, session: object|null }}
 */
function closeShop(player) {
    const session = getTalkSession(player);
    if (session) delete session.shop;
    return { ok: true, kind: 'close_shop', session };
}

/**
 * Buy or sell one shop row. Re-checks range, shop.when, and row.when.
 * Does not require the shop panel to be open (headless / TAS).
 * @param {object} player
 * @param {object} npc
 * @param {{ action: string, itemId?: string, count?: number }} deal
 * @param {object|null|undefined} [ctx]
 * @returns {{ ok: boolean, reason?: string, text?: string, itemId?: string, count?: number }}
 */
function executeShopDeal(player, npc, deal, ctx) {
    const gate = canTalkToNpc(player, npc);
    if (!gate.ok) return gate;
    const shop = resolveShop(npc);
    if (!shop) return { ok: false, reason: 'no_shop' };
    if (!shopMatchesWhen(player, shop)) {
        return { ok: false, reason: 'shop_when', text: shop.denyText || null };
    }
    const itemId = deal && deal.itemId != null ? String(deal.itemId).trim() : '';
    if (!itemId) {
        return {
            ok: false,
            reason: deal && deal.action === 'sell' ? 'not_bought' : 'not_sold'
        };
    }
    const db = resolveItemDb(player, ctx);
    if (deal.action === 'sell') {
        return sellToShop(player, shop, itemId, deal.count, db);
    }
    return buyFromShop(player, shop, itemId, deal.count, db);
}

/**
 * Process an npc_dialog CUSTOM_COMMAND. Failures are silent no-ops.
 * @param {object} player
 * @param {object} cmd
 * @param {object|null|undefined} ctx
 * @returns {{ ok: boolean, reason?: string, session?: object|null, closed?: object|null }}
 */
function executeNpcDialog(player, cmd, ctx) {
    const parsed = parseNpcDialogCommand(cmd);
    if (!parsed) return { ok: false, reason: 'invalid' };
    if (parsed.action === 'close') return closeTalk(player);
    if (parsed.action === 'close_shop') return closeShop(player);
    const npc = findTalkNpc(ctx, parsed.npcId);
    if (!npc) return { ok: false, reason: 'missing' };
    if (parsed.action === 'open_shop') return openShop(player, npc);
    if (parsed.action === 'buy' || parsed.action === 'sell') {
        return executeShopDeal(player, npc, parsed, ctx);
    }
    if (parsed.nodeId) return gotoTalk(player, npc, parsed.nodeId);
    return openTalk(player, npc);
}

/**
 * Take a visible reply: re-check `when`, commit give/take, apply reply `set`, then goto / close / open_shop.
 * Hidden replies are rejected so TAS / UI cannot skip the predicate.
 * Transfer fails leave the session on the current node (no set / no goto).
 * @param {object} player
 * @param {object} npc
 * @param {object} reply
 * @param {object|null|undefined} [ctx]
 * @returns {{ ok: boolean, reason?: string, kind?: string, session?: object, nodeId?: string, command?: *, transferred?: boolean }}
 */
function takeReply(player, npc, reply, ctx) {
    const gate = canTalkToNpc(player, npc);
    if (!gate.ok) return gate;
    const resolved = resolveDialog(npc);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const session = getTalkSession(player);
    const current = resolveNode(resolved.dialog, session && session.nodeId);
    const node = current.ok ? current.node : null;
    const visible = listReplies(node, player);
    let canonical = null;
    for (let i = 0; i < visible.length; i++) {
        const r = visible[i];
        if (!r) continue;
        if (r.label !== (reply && reply.label)) continue;
        if (r.action !== (reply && reply.action)) continue;
        if ((r.goto || '') !== (reply && reply.goto ? String(reply.goto) : '')) continue;
        canonical = r;
        break;
    }
    if (!canonical) return { ok: false, reason: 'when' };
    const result = applyReply(resolved.dialog, canonical, player);
    if (!result.ok) return result;
    if (result.kind === 'open_shop') {
        const shop = resolveShop(npc);
        if (!shop) return { ok: false, reason: 'no_shop' };
        if (!shopMatchesWhen(player, shop)) {
            return { ok: false, reason: 'shop_when', text: shop.denyText || null };
        }
    }
    const transfer = transferFromReply(canonical);
    let transferred = false;
    if (transfer.give || transfer.take) {
        const moved = commitItemTransfer(
            player,
            transfer,
            resolveItemDb(player, ctx)
        );
        if (!moved.ok) return moved;
        transferred = true;
    }
    if (result.patch) commitReplyPatch(player, result.patch);
    if (result.kind === 'close') {
        const closed = closeTalk(player);
        return {
            ok: true,
            kind: 'close',
            closed: closed.closed,
            transferred
        };
    }
    if (result.kind === 'goto' || result.next === 'goto') {
        const jumped = gotoTalk(player, npc, result.nodeId);
        if (!jumped.ok) return jumped;
        if (result.kind === 'open_shop') jumped.session.shop = true;
        return {
            ok: true,
            kind: result.kind === 'goto' ? 'goto' : result.kind,
            next: 'goto',
            session: jumped.session,
            dialog: jumped.dialog,
            node: jumped.node,
            nodeId: jumped.nodeId,
            source: jumped.source,
            transferred
        };
    }
    if (result.kind === 'open_shop') {
        const session = getTalkSession(player);
        if (!session) return { ok: false, reason: 'missing' };
        session.shop = true;
        return {
            ok: true,
            kind: 'open_shop',
            next: 'stay',
            session,
            transferred
        };
    }
    if (transferred) result.transferred = true;
    return result;
}

module.exports = {
    TALK_RANGE,
    chebyshevSameFloor,
    canTalkToNpc,
    getTalkSession,
    openTalk,
    gotoTalk,
    closeTalk,
    openShop,
    closeShop,
    executeShopDeal,
    takeReply,
    findTalkNpc,
    parseNpcDialogCommand,
    executeNpcDialog
};
