/**
 * Dialog tree resolve for talkable NPCs (Stage 6b).
 * Session / command live in session.js; Hunt UI lives in npc_dialog_panel.js.
 * This module only loads and walks JSON nodes so spawn, tests, and session cannot drift.
 */

'use strict';

const presets = require('../presets.js');
const { applyStoragePatch, replyMatchesWhen } = require('./storage.js');
const { normalizeItemSpec } = require('./items.js');

/**
 * True if value looks like a dialog tree (non-empty nodes map).
 * @param {object|null|undefined} obj
 * @returns {boolean}
 */
function isDialogTree(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (!obj.nodes || typeof obj.nodes !== 'object' || Array.isArray(obj.nodes)) {
        return false;
    }
    return Object.keys(obj.nodes).length > 0;
}

/**
 * Clone + fill start / greeting defaults. Null when the tree is unusable.
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeDialog(raw) {
    if (!isDialogTree(raw)) return null;
    const dialog = JSON.parse(JSON.stringify(raw));
    const nodeIds = Object.keys(dialog.nodes);
    if (dialog.start != null && String(dialog.start).trim()) {
        dialog.start = String(dialog.start).trim();
    } else if (dialog.nodes.start) {
        dialog.start = 'start';
    } else {
        dialog.start = nodeIds[0];
    }
    const startNode = dialog.nodes[dialog.start];
    if (!startNode || typeof startNode !== 'object') return null;
    if (dialog.greeting == null || String(dialog.greeting) === '') {
        if (startNode.text != null) dialog.greeting = String(startNode.text);
    }
    return dialog;
}

/**
 * Load an extracted tree from presets/<mode>/dialogs/<id>.json.
 * Missing / unreadable files return null (caller maps that to "missing").
 * @param {string} dialogId
 * @returns {object|null}
 */
function loadDialogById(dialogId) {
    const id = dialogId != null ? String(dialogId).trim() : '';
    if (!id) return null;
    try {
        const raw = presets.loadJson(`dialogs/${id}.json`);
        if (!raw || typeof raw !== 'object') return null;
        return JSON.parse(JSON.stringify(raw));
    } catch (_) {
        return null;
    }
}

/**
 * Resolve a dialog tree from a creature, template, raw tree, or dialogId string.
 *
 * Order: inline `dialog` → `dialogId` file → top-level tree (`nodes`).
 *
 * @param {object|string|null|undefined} source
 * @param {{ loadDialogById?: function(string): object|null }} [opts]
 * @returns {{ ok: true, dialog: object, source: 'inline'|'dialogId' } | { ok: false, reason: 'missing'|'invalid' }}
 */
function resolveDialog(source, opts) {
    const load =
        opts && typeof opts.loadDialogById === 'function'
            ? opts.loadDialogById
            : loadDialogById;

    if (typeof source === 'string') {
        const raw = load(source);
        if (!raw) return { ok: false, reason: 'missing' };
        const dialog = normalizeDialog(raw);
        return dialog
            ? { ok: true, dialog, source: 'dialogId' }
            : { ok: false, reason: 'invalid' };
    }

    if (!source || typeof source !== 'object') {
        return { ok: false, reason: 'missing' };
    }

    if (source.dialog != null) {
        if (typeof source.dialog !== 'object' || Array.isArray(source.dialog)) {
            return { ok: false, reason: 'invalid' };
        }
        const dialog = normalizeDialog(source.dialog);
        if (dialog) return { ok: true, dialog, source: 'inline' };
        return { ok: false, reason: 'invalid' };
    }

    const dialogId =
        source.dialogId != null ? String(source.dialogId).trim() : '';
    if (dialogId) {
        const raw = load(dialogId);
        if (!raw) return { ok: false, reason: 'missing' };
        const dialog = normalizeDialog(raw);
        return dialog
            ? { ok: true, dialog, source: 'dialogId' }
            : { ok: false, reason: 'invalid' };
    }

    if (isDialogTree(source)) {
        const dialog = normalizeDialog(source);
        return dialog
            ? { ok: true, dialog, source: 'inline' }
            : { ok: false, reason: 'invalid' };
    }

    return { ok: false, reason: 'missing' };
}

/**
 * Pick a node. Default id is dialog.start (or "start").
 * @param {object|null|undefined} dialog
 * @param {string} [nodeId]
 * @returns {{ ok: true, nodeId: string, node: object } | { ok: false, reason: 'missing'|'unknown_node' }}
 */
function resolveNode(dialog, nodeId) {
    if (!dialog || typeof dialog !== 'object' || !dialog.nodes) {
        return { ok: false, reason: 'missing' };
    }
    const id =
        nodeId != null && String(nodeId).trim()
            ? String(nodeId).trim()
            : dialog.start != null && String(dialog.start).trim()
              ? String(dialog.start).trim()
              : 'start';
    const node = dialog.nodes[id];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return { ok: false, reason: 'unknown_node' };
    }
    return { ok: true, nodeId: id, node };
}

/**
 * Clone a `{ key: value }` storage patch. Empty / invalid → omitted.
 * @param {object|null|undefined} raw
 * @returns {Record<string, *>|null}
 */
function cloneSetPatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const keys = Object.keys(raw);
    if (!keys.length) return null;
    return JSON.parse(JSON.stringify(raw));
}

/**
 * Normalize reply buttons on a node.
 * Missing action + goto → goto; missing both → close. Empty labels dropped.
 * Replies with `when` are hidden unless the player matches (no player → hide).
 * @param {object|null|undefined} node
 * @param {object|null|undefined} [player]
 * @returns {{ label: string, action: string, goto?: string, command?: *, when?: *, set?: object, item?: string, itemId?: string, count?: number, give?: object, take?: object }[]}
 */
function listReplies(node, player) {
    if (!node || !Array.isArray(node.replies)) return [];
    const out = [];
    for (let i = 0; i < node.replies.length; i++) {
        const raw = node.replies[i];
        if (!raw || typeof raw !== 'object') continue;
        const label = raw.label != null ? String(raw.label).trim() : '';
        if (!label) continue;
        const reply = { label };
        const gotoId = raw.goto != null ? String(raw.goto).trim() : '';
        if (raw.action != null && String(raw.action).trim()) {
            reply.action = String(raw.action).trim();
        } else if (gotoId) {
            reply.action = 'goto';
        } else {
            reply.action = 'close';
        }
        if (gotoId) reply.goto = gotoId;
        if (raw.command != null) reply.command = raw.command;
        if (raw.when != null) reply.when = JSON.parse(JSON.stringify(raw.when));
        const setPatch = cloneSetPatch(raw.set);
        if (setPatch) reply.set = setPatch;
        if (raw.item != null && String(raw.item).trim()) {
            reply.item = String(raw.item).trim();
        }
        if (raw.itemId != null && String(raw.itemId).trim()) {
            reply.itemId = String(raw.itemId).trim();
        }
        if (raw.count != null && Number.isFinite(Number(raw.count))) {
            const n = Math.floor(Number(raw.count));
            if (n >= 1) reply.count = n;
        }
        const giveSpec = normalizeItemSpec(raw.give, raw.count);
        if (giveSpec) reply.give = giveSpec;
        const takeSpec = normalizeItemSpec(raw.take, raw.count);
        if (takeSpec) reply.take = takeSpec;
        if (!replyMatchesWhen(player, reply)) continue;
        out.push(reply);
    }
    return out;
}

/**
 * Follow one reply against a dialog tree. Does not write storage (preview-safe).
 * Re-checks `when` when a player is passed.
 * @param {object|null|undefined} dialog
 * @param {object|null|undefined} reply
 * @param {object|null|undefined} [player]
 * @returns {{ ok: true, kind: 'goto', nodeId: string, node: object, patch?: object } | { ok: true, kind: 'close', patch?: object } | { ok: true, kind: 'custom', command: *, patch?: object } | { ok: true, kind: 'give_item'|'take_item', itemId: string, count: number, next: 'goto'|'stay', nodeId?: string, node?: object, patch?: object } | { ok: true, kind: 'open_shop', next: 'goto'|'stay', nodeId?: string, node?: object, patch?: object } | { ok: true, kind: 'stub', action: string, patch?: object } | { ok: false, reason: 'invalid'|'unknown_goto'|'when'|'invalid_item' }}
 */
function applyReply(dialog, reply, player) {
    if (!reply || typeof reply !== 'object') {
        return { ok: false, reason: 'invalid' };
    }
    if (reply.when != null && !replyMatchesWhen(player, reply)) {
        return { ok: false, reason: 'when' };
    }
    const action =
        reply.action != null && String(reply.action).trim()
            ? String(reply.action).trim()
            : reply.goto
              ? 'goto'
              : 'close';
    const patch = cloneSetPatch(reply.set);
    if (action === 'give_item' || action === 'take_item') {
        const spec = normalizeItemSpec(
            reply.give || reply.take || reply.itemId || reply.item,
            reply.count
        );
        if (!spec) return { ok: false, reason: 'invalid_item' };
        /** @type {{ ok: true, kind: string, itemId: string, count: number, next: string, nodeId?: string, node?: object, patch?: object }} */
        const out = {
            ok: true,
            kind: action,
            itemId: spec.itemId,
            count: spec.count,
            next: 'stay'
        };
        if (patch) out.patch = patch;
        const target = reply.goto != null ? String(reply.goto).trim() : '';
        if (target) {
            const next = resolveNode(dialog, target);
            if (!next.ok) return { ok: false, reason: 'unknown_goto' };
            out.next = 'goto';
            out.nodeId = next.nodeId;
            out.node = next.node;
        }
        return out;
    }
    if (action === 'open_shop' || action === 'trade') {
        /** @type {{ ok: true, kind: string, next: string, nodeId?: string, node?: object, patch?: object }} */
        const out = { ok: true, kind: 'open_shop', next: 'stay' };
        if (patch) out.patch = patch;
        const target = reply.goto != null ? String(reply.goto).trim() : '';
        if (target) {
            const next = resolveNode(dialog, target);
            if (!next.ok) return { ok: false, reason: 'unknown_goto' };
            out.next = 'goto';
            out.nodeId = next.nodeId;
            out.node = next.node;
        }
        return out;
    }
    if (action === 'close') {
        return patch ? { ok: true, kind: 'close', patch } : { ok: true, kind: 'close' };
    }
    if (action === 'goto' || (reply.goto && action !== 'custom')) {
        const target = reply.goto != null ? String(reply.goto).trim() : '';
        if (!target) return { ok: false, reason: 'unknown_goto' };
        const next = resolveNode(dialog, target);
        if (!next.ok) return { ok: false, reason: 'unknown_goto' };
        const out = { ok: true, kind: 'goto', nodeId: next.nodeId, node: next.node };
        if (patch) out.patch = patch;
        return out;
    }
    if (action === 'custom') {
        const out = { ok: true, kind: 'custom', command: reply.command || null };
        if (patch) out.patch = patch;
        return out;
    }
    const stub = { ok: true, kind: 'stub', action };
    if (patch) stub.patch = patch;
    return stub;
}

/**
 * Commit a reply `set` patch onto the player. Preview paths must not call this.
 * @param {object|null|undefined} player
 * @param {object|null|undefined} patch
 * @returns {boolean}
 */
function commitReplyPatch(player, patch) {
    return applyStoragePatch(player, patch);
}

module.exports = {
    isDialogTree,
    normalizeDialog,
    loadDialogById,
    resolveDialog,
    resolveNode,
    listReplies,
    applyReply,
    commitReplyPatch
};
