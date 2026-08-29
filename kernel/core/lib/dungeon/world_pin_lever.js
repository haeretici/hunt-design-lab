/**
 * W3 lever / switch: USE toggles state and applies cell / door effects.
 * W6: spawn / wave / unlock effects. Tag shares one effect set + state.
 * Do not auto-use on step (traps are kind: trap).
 */

'use strict';

const { getItem } = require('../character/inventory.js');
const { evalWhen } = require('../npc/storage.js');
const { applyCellPatch } = require('./cell_patch.js');
const { groundUidForWorldPin } = require('./world_pin_seed.js');
const { setDoorOpen } = require('./world_pin_door.js');
const { applyChestTransform } = require('./world_pin_chest.js');
const { DEFAULT_LEVER_STATES } = require('./world_pins.js');

/**
 * @param {object|null|undefined} ground
 * @returns {{ state: Record<string, number>, snapshots: Record<string, object[]> }}
 */
function ensureLeverBag(ground) {
    if (!ground.worldPinLever) {
        ground.worldPinLever = {
            state: Object.create(null),
            snapshots: Object.create(null)
        };
    }
    return ground.worldPinLever;
}

/**
 * Dispatch: this pin's effects, else another pin with the same tag.
 * @param {object|null|undefined} ground
 * @param {object} inst
 * @returns {{ effects: object[], key: string, states: string[] }}
 */
function resolveLeverEffects(ground, inst) {
    const own = Array.isArray(inst.worldPinEffects) ? inst.worldPinEffects : [];
    const tag = inst.worldPinTag ? String(inst.worldPinTag) : '';
    const key = tag || String(inst.worldPinId || '');
    const states =
        Array.isArray(inst.worldPinStates) && inst.worldPinStates.length
            ? inst.worldPinStates
            : DEFAULT_LEVER_STATES.slice();
    if (own.length) return { effects: own, key, states };
    if (!tag || !ground || !ground.inventory || !ground.inventory.items) {
        return { effects: [], key, states };
    }
    const ids = Object.keys(ground.inventory.items);
    for (let i = 0; i < ids.length; i++) {
        const other = ground.inventory.items[ids[i]];
        if (!other || other === inst) continue;
        if (other.worldPinTag !== tag) continue;
        if (!Array.isArray(other.worldPinEffects) || !other.worldPinEffects.length) {
            continue;
        }
        const st =
            Array.isArray(other.worldPinStates) && other.worldPinStates.length
                ? other.worldPinStates
                : states;
        return { effects: other.worldPinEffects, key, states: st };
    }
    return { effects: [], key, states };
}

/**
 * @param {object} inst
 * @returns {number}
 */
function leverCellZ(inst, effect) {
    if (effect && effect.z !== undefined && effect.z !== null) return effect.z;
    if (inst && inst.location && inst.location.z != null) return inst.location.z;
    return 0;
}

/**
 * @param {object} effect
 * @param {object|null} inst
 * @returns {object[]}
 */
function expandSpawnEffect(effect, inst) {
    if (!effect || !effect.creatureId) return [];
    const loc = inst && inst.location && typeof inst.location === 'object' ? inst.location : {};
    const x = effect.x != null ? effect.x : loc.x;
    const y = effect.y != null ? effect.y : loc.y;
    if (x == null || y == null) return [];
    const z = effect.z != null ? effect.z : loc.z != null ? loc.z : 0;
    const countRaw = Math.floor(Number(effect.count));
    const count = Number.isFinite(countRaw) && countRaw > 1 ? countRaw : 1;
    const respawn =
        effect.respawn != null && Number.isFinite(Number(effect.respawn))
            ? Math.max(0, Number(effect.respawn))
            : 0;
    /** @type {object[]} */
    const rows = [];
    for (let i = 0; i < count; i++) {
        rows.push({
            creatureId: String(effect.creatureId),
            x: Math.round(Number(x)),
            y: Math.round(Number(y)),
            z,
            respawn
        });
    }
    return rows;
}

/**
 * @param {object[]} rows
 * @param {object} ctx
 */
function emitSpawns(rows, ctx) {
    if (!rows || !rows.length) return;
    if (typeof ctx.spawn === 'function') {
        ctx.spawn(rows);
        return;
    }
    const sm = ctx.spawnManager;
    if (!sm || typeof sm.add !== 'function') return;
    for (let i = 0; i < rows.length; i++) sm.add(rows[i]);
    if (typeof ctx.tickSpawn === 'function') ctx.tickSpawn();
}

/**
 * @param {string} waveId
 * @param {object} ctx
 */
function emitWaveUnlock(waveId, ctx) {
    const time = ctx.time != null ? Number(ctx.time) : 0;
    if (typeof ctx.unlockWaves === 'function') {
        ctx.unlockWaves(waveId, time);
        return;
    }
    const wc = ctx.waveController;
    if (wc && typeof wc.unlock === 'function') wc.unlock(time, waveId);
}

/**
 * @param {string} pinId
 * @param {object} ctx
 */
function unlockDoorById(pinId, ctx) {
    const id = pinId != null ? String(pinId) : '';
    const ground = ctx.ground || null;
    if (!id || !ground) return;
    const uid = groundUidForWorldPin(ground, id);
    const door = uid ? getItem(ground.inventory, uid) : null;
    if (!door) return;
    door.worldPinUnlocked = true;
}

/**
 * @param {object[]} effects
 * @param {object} bag
 * @param {string} key
 * @param {{
 *   ground?: object|null,
 *   tileMap?: object|null,
 *   itemDb?: object|null,
 *   inst?: object|null,
 *   spawnManager?: object|null,
 *   tickSpawn?: function|null,
 *   spawn?: function|null,
 *   waveController?: object|null,
 *   unlockWaves?: function|null,
 *   time?: number
 * }} ctx
 */
function applyLeverEffects(effects, bag, key, ctx) {
    const list = Array.isArray(effects) ? effects : [];
    const snaps = [];
    const tileMap = ctx.tileMap || null;
    const ground = ctx.ground || null;
    const itemDb = ctx.itemDb || null;
    const inst = ctx.inst || null;
    /** @type {object[]} */
    const spawnRows = [];
    let waveId = null;
    let waveWanted = false;
    for (let i = 0; i < list.length; i++) {
        const effect = list[i];
        if (!effect || !effect.type) continue;
        if (effect.type === 'cell') {
            const patch = {
                x: effect.x,
                y: effect.y,
                z: leverCellZ(inst, effect)
            };
            /** @type {string[]} */
            const keys = [];
            if (effect.friction != null) {
                patch.friction = effect.friction;
                keys.push('friction');
            }
            if (effect.sight != null) {
                patch.sight = effect.sight;
                keys.push('sight');
            }
            if (effect.flags != null) {
                patch.flags = effect.flags;
                keys.push('flags');
            }
            if (effect.fields != null) {
                patch.fields = effect.fields;
                keys.push('fields');
            }
            if (!keys.length) continue;
            const r = applyCellPatch(tileMap, patch);
            if (!r.ok) continue;
            snaps.push({
                type: 'cell',
                x: patch.x,
                y: patch.y,
                z: patch.z,
                keys,
                prev: r.prev
            });
        } else if (effect.type === 'door') {
            const id = effect.id != null ? String(effect.id) : '';
            if (!id || !ground) continue;
            const uid = groundUidForWorldPin(ground, id);
            const door = uid ? getItem(ground.inventory, uid) : null;
            if (!door) continue;
            snaps.push({
                type: 'door',
                id,
                prevOpen: !!door.worldPinDoorOpen
            });
            setDoorOpen(door, effect.open !== false, { tileMap, itemDb });
        } else if (effect.type === 'spawn') {
            const rows = expandSpawnEffect(effect, inst);
            for (let r = 0; r < rows.length; r++) spawnRows.push(rows[r]);
        } else if (effect.type === 'wave') {
            waveWanted = true;
            if (effect.id) waveId = String(effect.id);
        } else if (effect.type === 'unlock') {
            if (effect.id) unlockDoorById(effect.id, ctx);
            else {
                waveWanted = true;
            }
        }
    }
    bag.snapshots[key] = snaps;
    if (spawnRows.length) emitSpawns(spawnRows, ctx);
    if (waveWanted) emitWaveUnlock(waveId, ctx);
}

/**
 * @param {object} bag
 * @param {string} key
 * @param {{ ground?: object|null, tileMap?: object|null, itemDb?: object|null }} ctx
 */
function reverseLeverEffects(bag, key, ctx) {
    const snaps = bag.snapshots[key];
    if (!Array.isArray(snaps) || !snaps.length) {
        delete bag.snapshots[key];
        return;
    }
    const tileMap = ctx.tileMap || null;
    const ground = ctx.ground || null;
    const itemDb = ctx.itemDb || null;
    for (let i = snaps.length - 1; i >= 0; i--) {
        const snap = snaps[i];
        if (!snap) continue;
        if (snap.type === 'cell' && snap.prev) {
            /** @type {object} */
            const patch = { x: snap.x, y: snap.y, z: snap.z };
            const keys = Array.isArray(snap.keys) ? snap.keys : ['friction'];
            for (let k = 0; k < keys.length; k++) {
                const ch = keys[k];
                if (snap.prev[ch] != null) patch[ch] = snap.prev[ch];
            }
            applyCellPatch(tileMap, patch);
        } else if (snap.type === 'door' && snap.id && ground) {
            const uid = groundUidForWorldPin(ground, snap.id);
            const door = uid ? getItem(ground.inventory, uid) : null;
            if (door) setDoorOpen(door, !!snap.prevOpen, { tileMap, itemDb });
        }
    }
    delete bag.snapshots[key];
}

/**
 * @param {object|null|undefined} ground
 * @param {string} key
 * @param {string} tag
 * @param {number} index
 * @param {string} name
 */
function syncLeverState(ground, key, tag, index, name) {
    if (!ground || !ground.inventory || !ground.inventory.items) return;
    const ids = Object.keys(ground.inventory.items);
    for (let i = 0; i < ids.length; i++) {
        const inst = ground.inventory.items[ids[i]];
        if (!inst) continue;
        const kind = inst.worldPinKind;
        if (kind !== 'lever' && kind !== 'switch') continue;
        const matchTag = tag && inst.worldPinTag === tag;
        const matchId = !tag && inst.worldPinId === key;
        if (!matchTag && !matchId) continue;
        inst.worldPinStateIndex = index;
        inst.worldPinState = name;
    }
}

/**
 * Hunt USE on `kind: lever` / `switch`. Caller enforces Chebyshev ≤ 1.
 *
 * @param {object|null|undefined} player
 * @param {object|null|undefined} inst
 * @param {{
 *   ground?: object|null,
 *   tileMap?: object|null,
 *   itemDb?: object|null,
 *   pin?: object|null,
 *   spawnManager?: object|null,
 *   tickSpawn?: function|null,
 *   spawn?: function|null,
 *   waveController?: object|null,
 *   unlockWaves?: function|null,
 *   time?: number
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   text?: string,
 *   state?: string,
 *   stateIndex?: number
 * }}
 */
function useWorldLever(player, inst, opts) {
    const o = opts || {};
    if (!inst || (inst.worldPinKind !== 'lever' && inst.worldPinKind !== 'switch')) {
        return {
            ok: false,
            reason: 'not_lever',
            text: 'You cannot use this object.'
        };
    }
    const ground = o.ground || null;
    if (!ground) {
        return {
            ok: false,
            reason: 'no_ground',
            text: 'You cannot use this object.'
        };
    }
    const when = inst.worldPinWhen || (o.pin && o.pin.when) || null;
    if (!evalWhen(player, when)) {
        return {
            ok: false,
            reason: 'when',
            text: 'You cannot use this object.'
        };
    }
    const tileMap = o.tileMap || ground.tileMap || null;
    const resolved = resolveLeverEffects(ground, inst);
    const bag = ensureLeverBag(ground);
    const current = bag.state[resolved.key] | 0;
    const n = resolved.states.length || 2;
    const next = (current + 1) % n;
    const ctx = {
        ground,
        tileMap,
        itemDb: o.itemDb || null,
        inst,
        spawnManager: o.spawnManager || null,
        tickSpawn: o.tickSpawn || null,
        spawn: o.spawn || null,
        waveController: o.waveController || null,
        unlockWaves: o.unlockWaves || null,
        time: o.time
    };
    if (next === 0) reverseLeverEffects(bag, resolved.key, ctx);
    else if (current === 0) applyLeverEffects(resolved.effects, bag, resolved.key, ctx);
    bag.state[resolved.key] = next;
    const name = resolved.states[next] || String(next);
    syncLeverState(ground, resolved.key, inst.worldPinTag || '', next, name);
    inst.worldPinStateIndex = next;
    inst.worldPinState = name;
    applyLeverTransform(inst, next, o.itemDb || null);
    return { ok: true, state: name, stateIndex: next };
}

/**
 * Swap lever art to match state. String `transformOnUse` = on-art; index 0
 * restores `worldPinBaseCatalog`. Array is per-state catalog ids.
 * @param {object} inst
 * @param {number} index
 * @param {object[]|Record<string, object>|null} itemDb
 */
function applyLeverTransform(inst, index, itemDb) {
    if (!inst) return;
    const spec = inst.worldPinTransformOnUse;
    const base = inst.worldPinBaseCatalog || inst.itemId;
    let id = '';
    if (Array.isArray(spec) && spec.length) {
        const hit = spec[index];
        if (hit) id = String(hit).trim();
    } else if (spec) {
        const on = String(spec).trim();
        if (on) id = index === 0 ? String(base || '').trim() : on;
    }
    if (id) applyChestTransform(inst, id, itemDb);
}

/**
 * @param {object|null|undefined} player
 * @param {object|null|undefined} ground
 * @param {string} uid
 * @param {{ tileMap?: object|null, itemDb?: object|null, pin?: object|null }} [opts]
 * @returns {ReturnType<typeof useWorldLever>}
 */
function useWorldLeverAt(player, ground, uid, opts) {
    if (!ground || !ground.inventory || uid == null || String(uid) === '') {
        return {
            ok: false,
            reason: 'not_lever',
            text: 'You cannot use this object.'
        };
    }
    const inst = getItem(ground.inventory, uid);
    const o = opts || {};
    return useWorldLever(player, inst, {
        ground,
        tileMap: o.tileMap || ground.tileMap || null,
        itemDb: o.itemDb || null,
        pin: o.pin || null,
        spawnManager: o.spawnManager || null,
        tickSpawn: o.tickSpawn || null,
        spawn: o.spawn || null,
        waveController: o.waveController || null,
        unlockWaves: o.unlockWaves || null,
        time: o.time
    });
}

module.exports = {
    useWorldLever,
    useWorldLeverAt,
    resolveLeverEffects
};
