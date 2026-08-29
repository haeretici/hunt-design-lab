/**
 * World pin rows: interactive map objects (container / chest / lever / …).
 * Browser-safe (no fs). Hybrid map.json `world` is SoT. Furniture stamps
 * never carry behavior — interactivity lives on these pins only.
 * W5: optional `transformOnUse` + `decay` on any kind.
 * W6: `trap` / `harvest` + lever spawn / wave / unlock effects.
 */

'use strict';

const WORLD_KINDS = Object.freeze([
    'container',
    'chest',
    'lever',
    'door',
    'teleport',
    'switch',
    'trap',
    'harvest'
]);

const CATALOG_KINDS = Object.freeze(['objects', 'equipment']);

const DEFAULT_CONTAINER_CAPACITY = 20;
const MAX_ITEM_NEST = 8;
const MIN_WORLD_FLOOR_Z = 0;
const MAX_WORLD_FLOOR_Z = 15;
const DEFAULT_LEVER_STATES = Object.freeze(['off', 'on']);
const WORLD_USE_KINDS = Object.freeze([
    'chest',
    'lever',
    'switch',
    'door',
    'teleport',
    'harvest'
]);

const TRAP_FIELD_KINDS = Object.freeze([
    'fire',
    'poison',
    'energy',
    'barrier',
    'vine'
]);

const FIND_ISSUE_EMPTY = 'empty';
const FIND_ISSUE_UNKNOWN = 'unknown';
const FIND_ISSUE_BLOCKED = 'blocked';
const FIND_ISSUE_OK = 'ok';

/**
 * @param {*} v
 * @returns {number|null}
 */
function finiteInt(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
}

/**
 * @param {string} name
 * @returns {string}
 */
function slugifyWorldId(name) {
    const s = String(name || '')
        .trim()
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return s;
}

/**
 * @param {*} raw
 * @returns {string}
 */
function normalizeWorldKind(raw) {
    const k = String(raw || '')
        .trim()
        .toLowerCase();
    if (!k) return 'container';
    if (WORLD_KINDS.indexOf(k) >= 0) return k;
    const slug = slugifyWorldId(k);
    if (!slug) return 'container';
    if (WORLD_KINDS.indexOf(slug) >= 0) return slug;
    return slug;
}

/**
 * @param {*} raw
 * @returns {'objects'|'equipment'}
 */
function normalizeCatalogKind(raw) {
    const k = String(raw || '')
        .trim()
        .toLowerCase();
    if (CATALOG_KINDS.indexOf(k) >= 0) return k;
    return 'objects';
}

const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Kind defaults. Chest `shared: false` = per-player storage (W2).
 * @param {string} kind
 * @returns {{ blocking: boolean, pickupable: boolean, shared: boolean }}
 */
function kindDefaults(kind) {
    const k = normalizeWorldKind(kind);
    if (k === 'container') {
        return { blocking: false, pickupable: true, shared: true };
    }
    if (k === 'chest') {
        return { blocking: true, pickupable: false, shared: false };
    }
    if (k === 'door') {
        return { blocking: true, pickupable: false, shared: true };
    }
    if (k === 'trap' || k === 'harvest') {
        return { blocking: false, pickupable: false, shared: true };
    }
    return { blocking: false, pickupable: false, shared: true };
}

/**
 * @param {*} data
 * @returns {object[]}
 */
function parseWorldRows(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.world)) return data.world;
    return [];
}

/**
 * Hybrid doc wins whenever it is present (even if `world` is empty).
 * No by_floor analog — World pins live only in hybrid.
 * @param {*|null|undefined} hybridDoc
 * @returns {object[]}
 */
function loadFloorWorldFromDocs(hybridDoc) {
    if (hybridDoc != null) return parseWorldRows(hybridDoc);
    return [];
}

/**
 * @param {*} raw
 * @param {number} [depth]
 * @returns {{ item: string, count: number, items?: object[] }|null}
 */
function normalizeWorldItem(raw, depth) {
    const d = depth | 0;
    if (d > MAX_ITEM_NEST) return null;
    if (!raw || typeof raw !== 'object') return null;
    const item = String(raw.item || raw.id || raw.itemId || '').trim();
    if (!item) return null;
    let count = 1;
    if (raw.count != null) {
        const n = Math.floor(Number(raw.count));
        if (!Number.isFinite(n) || n < 1) return null;
        count = n;
    }
    /** @type {{ item: string, count: number, items?: object[] }} */
    const row = { item, count };
    if (Array.isArray(raw.items) && raw.items.length) {
        const nested = [];
        for (let i = 0; i < raw.items.length; i++) {
            const child = normalizeWorldItem(raw.items[i], d + 1);
            if (child) nested.push(child);
        }
        if (nested.length) row.items = nested;
    }
    return row;
}

/**
 * @param {*} raw
 * @returns {object[]}
 */
function normalizeWorldItems(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const row = normalizeWorldItem(raw[i], 0);
        if (row) out.push(row);
    }
    return out;
}

/**
 * @param {object[]} items
 * @returns {object[]}
 */
function cloneWorldItems(items) {
    const list = Array.isArray(items) ? items : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const row = normalizeWorldItem(list[i], 0);
        if (row) out.push(row);
    }
    return out;
}

/**
 * @param {*} raw
 * @returns {object|null}
 */
function normalizeWhenClause(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item =
        raw.item != null
            ? String(raw.item).trim()
            : raw.itemId != null
              ? String(raw.itemId).trim()
              : '';
    /** @type {object} */
    const clause = {};
    if (item) {
        clause.item = item;
    } else {
        const storage =
            raw.storage != null
                ? String(raw.storage).trim()
                : raw.key != null
                  ? String(raw.key).trim()
                  : '';
        if (!storage || !STORAGE_KEY_RE.test(storage)) return null;
        clause.storage = storage;
    }
    if (raw.eq !== undefined) clause.eq = raw.eq;
    else if (raw.equals !== undefined) clause.eq = raw.equals;
    if (raw.neq !== undefined) clause.neq = raw.neq;
    if (raw.min !== undefined) clause.min = raw.min;
    if (raw.max !== undefined) clause.max = raw.max;
    return clause;
}

/**
 * @param {object} clause
 */
function defaultOnceEq(clause) {
    if (!clause || clause.item) return;
    if (
        clause.eq === undefined &&
        clause.neq === undefined &&
        clause.min === undefined &&
        clause.max === undefined
    ) {
        clause.eq = 0;
    }
}

/**
 * `once` for chests. String → `{ storage, eq: 0 }`. `equals` → `eq`.
 * @param {*} raw
 * @returns {object|object[]|null}
 */
function normalizeChestOnce(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'string' || typeof raw === 'number') {
        const storage = String(raw).trim();
        if (!storage || !STORAGE_KEY_RE.test(storage)) return null;
        return { storage, eq: 0 };
    }
    if (Array.isArray(raw)) {
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const clause = normalizeWhenClause(raw[i]);
            if (!clause) continue;
            defaultOnceEq(clause);
            out.push(clause);
        }
        if (!out.length) return null;
        return out.length === 1 ? out[0] : out;
    }
    const clause = normalizeWhenClause(raw);
    if (!clause) return null;
    defaultOnceEq(clause);
    return clause;
}

/**
 * Extra chest gate (`when.item`, AND-array). Missing → null (evalWhen allows).
 * @param {*} raw
 * @returns {object|object[]|null}
 */
function normalizeChestWhen(raw) {
    if (raw == null) return null;
    if (Array.isArray(raw)) {
        const out = [];
        for (let i = 0; i < raw.length; i++) {
            const clause = normalizeWhenClause(raw[i]);
            if (clause) out.push(clause);
        }
        return out.length ? out : null;
    }
    return normalizeWhenClause(raw);
}

/**
 * `{ key: value }` storage patch. Invalid keys dropped.
 * @param {*} raw
 * @returns {Record<string, number|string>|null}
 */
function normalizeChestSet(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i] || '').trim();
        if (!k || !STORAGE_KEY_RE.test(k)) continue;
        let v = raw[keys[i]];
        if (v == null) continue;
        if (typeof v === 'boolean') v = v ? 1 : 0;
        else if (typeof v === 'number') {
            if (!Number.isFinite(v)) continue;
        } else if (typeof v === 'string') {
            const t = v.trim();
            if (!t) continue;
            if (t !== 'true' && t !== 'false' && Number.isFinite(Number(t))) {
                v = Number(t);
            } else v = t;
        } else continue;
        out[k] = v;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * @param {*} v
 * @returns {number|null}
 */
function clampChannelByte(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 255) return 255;
    return n;
}

/**
 * Lever / switch states. Missing → `off` / `on`.
 * @param {*} raw
 * @returns {string[]}
 */
function normalizeLeverStates(raw) {
    /** @type {string[]} */
    let list = [];
    if (typeof raw === 'string') {
        list = raw.split(',');
    } else if (Array.isArray(raw)) {
        list = raw;
    }
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < list.length; i++) {
        const s = String(list[i] == null ? '' : list[i]).trim();
        if (!s || seen[s]) continue;
        seen[s] = true;
        out.push(s);
    }
    return out.length ? out : DEFAULT_LEVER_STATES.slice();
}

/**
 * @param {*} raw
 * @param {number} [fallbackZ]
 * @returns {{ type: 'cell', x: number, y: number, z: number, friction?: number, sight?: number, flags?: number, fields?: number }|null}
 */
function normalizeCellEffect(raw, fallbackZ) {
    if (!raw || typeof raw !== 'object') return null;
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x == null || y == null) return null;
    const zRaw = raw.z != null ? finiteInt(raw.z) : finiteInt(fallbackZ);
    const z = zRaw != null ? zRaw : 0;
    /** @type {{ type: 'cell', x: number, y: number, z: number, friction?: number, sight?: number, flags?: number, fields?: number }} */
    const effect = { type: 'cell', x, y, z };
    let any = false;
    const friction = clampChannelByte(raw.friction);
    if (friction != null && raw.friction != null) {
        effect.friction = friction;
        any = true;
    }
    const sight = clampChannelByte(raw.sight);
    if (sight != null && raw.sight != null) {
        effect.sight = sight;
        any = true;
    }
    const flags = clampChannelByte(raw.flags);
    if (flags != null && raw.flags != null) {
        effect.flags = flags;
        any = true;
    }
    const fields = clampChannelByte(raw.fields);
    if (fields != null && raw.fields != null) {
        effect.fields = fields;
        any = true;
    }
    return any ? effect : null;
}

/**
 * @param {*} raw
 * @returns {{ type: 'door', id: string, open: boolean }|null}
 */
function normalizeDoorEffect(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = slugifyWorldId(raw.id || raw.doorId || '');
    if (!id) return null;
    return { type: 'door', id, open: raw.open !== false };
}

/**
 * Door `gate`: `{ when }` (evalWhen) + optional `level` (min `player.level`).
 * Bare `{ storage, eq }` / `{ item, min }` is treated as `when`.
 * @param {*} raw
 * @returns {{ when?: object|object[], level?: number }|null}
 */
function normalizeDoorGate(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    /** @type {{ when?: object|object[], level?: number }} */
    const gate = {};
    const whenSrc =
        raw.when != null
            ? raw.when
            : raw.storage != null ||
                raw.item != null ||
                raw.itemId != null ||
                raw.key != null
              ? raw
              : null;
    const when = normalizeChestWhen(whenSrc);
    if (when) gate.when = when;
    if (raw.level != null) {
        const n = Math.floor(Number(raw.level));
        if (Number.isFinite(n) && n >= 1) gate.level = n;
    }
    return gate.when || gate.level != null ? gate : null;
}

/**
 * Swap catalogId on Use. String = one id (lever on-art / chest alias).
 * Array = per-state ids (lever orientation).
 * @param {*} raw
 * @returns {string|string[]|null}
 */
function normalizeTransformOnUse(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'string' || typeof raw === 'number') {
        const s = String(raw).trim();
        return s || null;
    }
    if (Array.isArray(raw)) {
        const out = [];
        let any = false;
        for (let i = 0; i < raw.length; i++) {
            const s = raw[i] != null ? String(raw[i]).trim() : '';
            out.push(s);
            if (s) any = true;
        }
        return any ? out : null;
    }
    return null;
}

/**
 * Optional hunt decay. `sec` from seed; missing `to` removes the instance.
 * `ticks` / `seconds` alias `sec`.
 * @param {*} raw
 * @returns {{ sec: number, to?: string }|null}
 */
function normalizeDecay(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'number' || typeof raw === 'string') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return { sec: n };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const secRaw =
        raw.sec != null
            ? raw.sec
            : raw.seconds != null
              ? raw.seconds
              : raw.ticks;
    const sec = Number(secRaw);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    /** @type {{ sec: number, to?: string }} */
    const decay = { sec };
    if (raw.to != null) {
        const to = String(raw.to).trim();
        if (to) decay.to = to;
    }
    return decay;
}

/**
 * @param {*} raw
 * @param {number} fallbackZ
 * @returns {{ x: number, y: number, z: number }|null}
 */
function normalizeTeleportTo(raw, fallbackZ) {
    if (!raw || typeof raw !== 'object') return null;
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x == null || y == null) return null;
    const z = raw.z != null ? finiteInt(raw.z) : finiteInt(fallbackZ);
    return { x, y, z: z != null ? z : 0 };
}

/**
 * W6 lever spawn: creature at coords (missing x/y → lever tile at apply).
 * @param {*} raw
 * @param {number} [fallbackZ]
 * @returns {{ type: 'spawn', creatureId: string, x?: number, y?: number, z?: number, count?: number, respawn?: number }|null}
 */
function normalizeSpawnEffect(raw, fallbackZ) {
    if (!raw || typeof raw !== 'object') return null;
    const creatureId = String(raw.creatureId || raw.id || raw.name || '').trim();
    if (!creatureId) return null;
    /** @type {{ type: 'spawn', creatureId: string, x?: number, y?: number, z?: number, count?: number, respawn?: number }} */
    const effect = { type: 'spawn', creatureId };
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x != null && y != null) {
        effect.x = x;
        effect.y = y;
    }
    const z = raw.z != null ? finiteInt(raw.z) : finiteInt(fallbackZ);
    if (z != null) effect.z = z;
    const count = Math.floor(Number(raw.count));
    if (Number.isFinite(count) && count > 1) effect.count = count;
    if (raw.respawn != null) {
        const r = Number(raw.respawn);
        if (Number.isFinite(r) && r >= 0) effect.respawn = r;
    }
    return effect;
}

/**
 * W6 start-lever: unlock waiting waves. Optional `id` picks a wave.
 * @param {*} raw
 * @returns {{ type: 'wave', id?: string }}
 */
function normalizeWaveEffect(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'wave' };
    /** @type {{ type: 'wave', id?: string }} */
    const effect = { type: 'wave' };
    const id = raw.id != null ? String(raw.id).trim() : '';
    if (id && id !== 'wave') effect.id = id;
    return effect;
}

/**
 * W6 unlock: door pin id marks hunt-unlock; missing id unlocks waves.
 * @param {*} raw
 * @returns {{ type: 'unlock', id?: string }}
 */
function normalizeUnlockEffect(raw) {
    if (!raw || typeof raw !== 'object') return { type: 'unlock' };
    /** @type {{ type: 'unlock', id?: string }} */
    const effect = { type: 'unlock' };
    const id = slugifyWorldId(raw.id || raw.doorId || '');
    if (id && id !== 'unlock') effect.id = id;
    return effect;
}

/**
 * Hunt seconds until a harvest / trap can fire again.
 * @param {*} raw
 * @returns {number|null}
 */
function normalizeCooldownSec(raw) {
    if (raw == null || raw === false || raw === true) return null;
    if (typeof raw === 'number' || typeof raw === 'string') {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n;
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    const n = Number(raw.sec != null ? raw.sec : raw.seconds);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

/**
 * Trap field kind. Unknown → null.
 * @param {*} raw
 * @returns {string|null}
 */
function normalizeTrapField(raw) {
    if (raw == null || raw === false || raw === true) return null;
    let s = '';
    if (typeof raw === 'string' || typeof raw === 'number') {
        s = String(raw);
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        s = String(raw.kind || raw.id || raw.name || '');
    }
    s = s.trim().toLowerCase().replace(/_field$/, '').replace(/field$/, '');
    if (s === 'earth') s = 'poison';
    if (s === 'magic_wall' || s === 'magicwall') s = 'barrier';
    if (TRAP_FIELD_KINDS.indexOf(s) >= 0) return s;
    return null;
}

/**
 * @param {*} raw
 * @returns {number|null}
 */
function normalizeTrapDamage(raw) {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return null;
    return n;
}

/**
 * W3 cell/door + W6 spawn / wave / unlock.
 * First `spawn` or `wave` wins — the other type is dropped. Wave load
 * clears spawn slots; mixing leaves live bodies without manager keys.
 * @param {*} raw
 * @param {number} [fallbackZ]
 * @returns {object[]}
 */
function normalizeLeverEffects(raw, fallbackZ) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    let hasSpawn = false;
    let hasWave = false;
    for (let i = 0; i < raw.length; i++) {
        const row = raw[i];
        if (!row || typeof row !== 'object') continue;
        const type = String(row.type || '').trim().toLowerCase();
        if (type === 'door') {
            const effect = normalizeDoorEffect(row);
            if (effect) out.push(effect);
        } else if (type === 'spawn') {
            if (hasWave) continue;
            const effect = normalizeSpawnEffect(row, fallbackZ);
            if (effect) {
                out.push(effect);
                hasSpawn = true;
            }
        } else if (type === 'wave') {
            if (hasSpawn) continue;
            out.push(normalizeWaveEffect(row));
            hasWave = true;
        } else if (type === 'unlock') {
            out.push(normalizeUnlockEffect(row));
        } else if (type === 'cell' || type === '') {
            const effect = normalizeCellEffect(row, fallbackZ);
            if (effect) out.push(effect);
        }
    }
    return out;
}

/**
 * @param {string|null|undefined} kind
 * @returns {boolean}
 */
function worldPinUseReady(kind) {
    return WORLD_USE_KINDS.indexOf(String(kind || '')) >= 0;
}

/**
 * @param {string[]} used
 * @param {string} kind
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {string}
 */
function allocWorldPinId(used, kind, x, y, z) {
    const base = slugifyWorldId(kind + '_' + z + '_' + x + '_' + y) || 'pin';
    const set = used && typeof used === 'object' ? used : [];
    const taken = Object.create(null);
    for (let i = 0; i < set.length; i++) {
        const id = String(set[i] || '').trim();
        if (id) taken[id] = true;
    }
    if (!taken[base]) return base;
    let n = 2;
    while (taken[base + '_' + n]) n += 1;
    return base + '_' + n;
}

/**
 * @param {object[]} pins
 * @returns {string[]}
 */
function collectWorldIds(pins) {
    const list = Array.isArray(pins) ? pins : [];
    const ids = [];
    for (let i = 0; i < list.length; i++) {
        const id = list[i] && list[i].id != null ? String(list[i].id).trim() : '';
        if (id) ids.push(id);
    }
    return ids;
}

/**
 * Normalize one pin. Invalid coords / missing catalogId → null.
 * @param {*} raw
 * @param {{ z?: number, usedIds?: string[] }} [opts]
 * @returns {object|null}
 */
function normalizeWorldPin(raw, opts) {
    if (!raw || typeof raw !== 'object') return null;
    const o = opts || {};
    const x = finiteInt(raw.x);
    const y = finiteInt(raw.y);
    if (x == null || y == null) return null;
    const zRaw = raw.z != null ? raw.z : o.z;
    const z = zRaw != null ? finiteInt(zRaw) : 0;
    if (z == null) return null;
    const catalogId = String(raw.catalogId || raw.item || raw.spriteId || '').trim();
    if (!catalogId) return null;
    const kind = normalizeWorldKind(raw.kind);
    const defs = kindDefaults(kind);
    let id = raw.id != null ? slugifyWorldId(raw.id) : '';
    if (!id) {
        id = allocWorldPinId(o.usedIds || [], kind, x, y, z);
    }
    const tag = raw.tag != null ? slugifyWorldId(raw.tag) : '';
    const blocking = raw.blocking != null ? !!raw.blocking : defs.blocking;
    const pickupable = raw.pickupable != null ? !!raw.pickupable : defs.pickupable;
    /** @type {object} */
    const pin = {
        id,
        kind,
        catalogId,
        catalogKind: normalizeCatalogKind(raw.catalogKind || raw.kindHint),
        x,
        y,
        z,
        blocking,
        pickupable
    };
    if (tag) pin.tag = tag;
    if (kind === 'container') {
        const cap =
            raw.capacity != null
                ? Math.floor(Number(raw.capacity))
                : DEFAULT_CONTAINER_CAPACITY;
        pin.capacity = Number.isFinite(cap) && cap >= 1 ? cap : DEFAULT_CONTAINER_CAPACITY;
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        pin.items = normalizeWorldItems(raw.items);
    } else if (kind === 'chest') {
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        const once = normalizeChestOnce(raw.once);
        if (once) pin.once = once;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
        pin.give = normalizeWorldItems(raw.give);
        const set = normalizeChestSet(raw.set);
        if (set) pin.set = set;
        if (raw.emptyText != null) {
            const text = String(raw.emptyText).trim();
            if (text) pin.emptyText = text;
        }
        if (raw.transformTo != null) {
            const to = String(raw.transformTo).trim();
            if (to) pin.transformTo = to;
        }
    } else if (kind === 'lever' || kind === 'switch') {
        pin.states = normalizeLeverStates(raw.states);
        const effects = normalizeLeverEffects(raw.effects, z);
        if (effects.length) pin.effects = effects;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
    } else if (kind === 'door') {
        if (raw.closedId != null) {
            const closedId = String(raw.closedId).trim();
            if (closedId) pin.closedId = closedId;
        }
        if (raw.openId != null) {
            const openId = String(raw.openId).trim();
            if (openId) pin.openId = openId;
        }
        const gate = normalizeDoorGate(raw.gate);
        if (gate) pin.gate = gate;
        if (raw.lockId != null) {
            const lockId = String(raw.lockId).trim();
            if (lockId) pin.lockId = lockId;
        }
        if (raw.consume === true) pin.consume = true;
    } else if (kind === 'teleport') {
        const to = normalizeTeleportTo(raw.to, z);
        if (to) pin.to = to;
    } else if (kind === 'harvest') {
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        const once = normalizeChestOnce(raw.once);
        if (once) pin.once = once;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
        pin.give = normalizeWorldItems(raw.give);
        const set = normalizeChestSet(raw.set);
        if (set) pin.set = set;
        if (raw.emptyText != null) {
            const text = String(raw.emptyText).trim();
            if (text) pin.emptyText = text;
        }
        if (raw.transformTo != null) {
            const to = String(raw.transformTo).trim();
            if (to) pin.transformTo = to;
        }
        const cooldown = normalizeCooldownSec(raw.cooldown);
        if (cooldown != null) pin.cooldown = cooldown;
    } else if (kind === 'trap') {
        pin.shared = raw.shared != null ? !!raw.shared : defs.shared;
        const once = normalizeChestOnce(raw.once);
        if (once) pin.once = once;
        const when = normalizeChestWhen(raw.when);
        if (when) pin.when = when;
        const set = normalizeChestSet(raw.set);
        if (set) pin.set = set;
        if (raw.transformTo != null) {
            const to = String(raw.transformTo).trim();
            if (to) pin.transformTo = to;
        }
        const cooldown = normalizeCooldownSec(raw.cooldown);
        if (cooldown != null) pin.cooldown = cooldown;
        const damage = normalizeTrapDamage(raw.damage);
        if (damage != null) pin.damage = damage;
        const field = normalizeTrapField(raw.field);
        if (field) pin.field = field;
        if (raw.element != null) {
            const element = String(raw.element).trim().toLowerCase();
            if (element) pin.element = element;
        }
    }
    const transformOnUse = normalizeTransformOnUse(raw.transformOnUse);
    if (kind === 'chest' || kind === 'harvest' || kind === 'trap') {
        if (!pin.transformTo && typeof transformOnUse === 'string') {
            pin.transformTo = transformOnUse;
        }
    } else if (transformOnUse) {
        pin.transformOnUse = transformOnUse;
    }
    const decay = normalizeDecay(raw.decay);
    if (decay) pin.decay = decay;
    return pin;
}

/**
 * @param {*} list
 * @param {{ z?: number }} [opts]
 * @returns {object[]}
 */
function normalizeWorldList(list, opts) {
    const rows = Array.isArray(list) ? list : parseWorldRows(list);
    const out = [];
    const used = [];
    for (let i = 0; i < rows.length; i++) {
        const pin = normalizeWorldPin(rows[i], {
            z: opts && opts.z,
            usedIds: used
        });
        if (!pin) continue;
        used.push(pin.id);
        out.push(pin);
    }
    return out;
}

/**
 * Editor / save pin. Same as normalize plus optional catalog lookup.
 * @param {object} raw
 * @param {Record<string, object>|null|undefined} [catalogs]
 * @param {{ z?: number, usedIds?: string[], kind?: string }} [opts]
 * @returns {object|null}
 */
function makeEditorWorldPin(raw, catalogs, opts) {
    if (!raw || typeof raw !== 'object') return null;
    const o = opts || {};
    const map = catalogs && typeof catalogs === 'object' ? catalogs : {};
    const catalogId = String(raw.catalogId || raw.item || raw.id || '').trim();
    const hit = catalogId && map[catalogId] ? map[catalogId] : null;
    const merged = Object.assign({}, raw);
    if (hit) {
        if (!merged.catalogId) merged.catalogId = hit.id || catalogId;
        if (!merged.catalogKind && hit.kind) merged.catalogKind = hit.kind;
        if (merged.kind == null && o.kind == null && hit.category === 'container') {
            merged.kind = 'container';
        }
        if (merged.capacity == null && hit.volume != null) {
            merged.capacity = hit.volume;
        }
    }
    if (o.kind && !merged.kind) merged.kind = o.kind;
    if (o.z != null && merged.z == null) merged.z = o.z;
    return normalizeWorldPin(merged, o);
}

/**
 * Drop editor-only `_origSig`. Keep authored fields.
 * @param {object} pin
 * @returns {object|null}
 */
function stripWorldPinForSave(pin) {
    const n = normalizeWorldPin(pin);
    if (!n) return null;
    return n;
}

/**
 * @param {object[]} pins
 * @returns {object[]}
 */
function stripWorldListForSave(pins) {
    return normalizeWorldList(pins);
}

/**
 * Stable fingerprint for "modified since load".
 * @param {object|null|undefined} pin
 * @returns {string}
 */
function worldPinSignature(pin) {
    if (!pin || typeof pin !== 'object') return '';
    const n = normalizeWorldPin(pin);
    if (!n) return '';
    return JSON.stringify(n);
}

/**
 * @param {object[]} pins
 * @returns {object[]}
 */
function markWorldBaseline(pins) {
    const list = Array.isArray(pins) ? pins : [];
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p || typeof p !== 'object') continue;
        p._origSig = worldPinSignature(p);
    }
    return list;
}

/**
 * @param {object|null|undefined} pin
 * @returns {boolean}
 */
function isModifiedWorld(pin) {
    if (!pin || typeof pin !== 'object') return false;
    if (pin._origSig == null || pin._origSig === '') return true;
    return worldPinSignature(pin) !== pin._origSig;
}

/**
 * Last pin whose rounded tile equals (x, y).
 * @param {object[]} pins
 * @param {number} x
 * @param {number} y
 * @returns {object|null}
 */
function worldPinAtTile(pins, x, y) {
    const list = Array.isArray(pins) ? pins : [];
    const tx = Math.round(Number(x));
    const ty = Math.round(Number(y));
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        if (!p) continue;
        if (Math.round(Number(p.x)) === tx && Math.round(Number(p.y)) === ty) return p;
    }
    return null;
}

/**
 * @param {object|null|undefined} pin
 * @param {string} query
 * @returns {boolean}
 */
function worldMatchesQuery(pin, query) {
    if (!query) return true;
    if (!pin) return false;
    const q = String(query).trim().toLowerCase();
    if (!q) return true;
    const fields = [pin.id, pin.tag, pin.kind, pin.catalogId];
    for (let i = 0; i < fields.length; i++) {
        const s = fields[i] != null ? String(fields[i]).toLowerCase() : '';
        if (s && s.indexOf(q) !== -1) return true;
    }
    const bags = [pin.items, pin.give];
    for (let b = 0; b < bags.length; b++) {
        const items = Array.isArray(bags[b]) ? bags[b] : [];
        for (let i = 0; i < items.length; i++) {
            const id =
                items[i] && items[i].item != null
                    ? String(items[i].item).toLowerCase()
                    : '';
            if (id && id.indexOf(q) !== -1) return true;
        }
    }
    if (pin.once && pin.once.storage && String(pin.once.storage).toLowerCase().indexOf(q) !== -1) {
        return true;
    }
    if (pin.closedId && String(pin.closedId).toLowerCase().indexOf(q) !== -1) return true;
    if (pin.openId && String(pin.openId).toLowerCase().indexOf(q) !== -1) return true;
    if (pin.lockId && String(pin.lockId).toLowerCase().indexOf(q) !== -1) return true;
    if (pin.transformTo && String(pin.transformTo).toLowerCase().indexOf(q) !== -1) {
        return true;
    }
    const transformOnUse = pin.transformOnUse;
    if (typeof transformOnUse === 'string') {
        if (transformOnUse.toLowerCase().indexOf(q) !== -1) return true;
    } else if (Array.isArray(transformOnUse)) {
        for (let i = 0; i < transformOnUse.length; i++) {
            const id =
                transformOnUse[i] != null
                    ? String(transformOnUse[i]).toLowerCase()
                    : '';
            if (id && id.indexOf(q) !== -1) return true;
        }
    }
    if (pin.decay && pin.decay.to && String(pin.decay.to).toLowerCase().indexOf(q) !== -1) {
        return true;
    }
    const effects = Array.isArray(pin.effects) ? pin.effects : [];
    for (let i = 0; i < effects.length; i++) {
        const e = effects[i];
        if (!e) continue;
        const id = e.id != null ? String(e.id).toLowerCase() : '';
        if (id && id.indexOf(q) !== -1) return true;
        const cid = e.creatureId != null ? String(e.creatureId).toLowerCase() : '';
        if (cid && cid.indexOf(q) !== -1) return true;
        const et = e.type != null ? String(e.type).toLowerCase() : '';
        if (et && et.indexOf(q) !== -1) return true;
    }
    if (pin.field && String(pin.field).toLowerCase().indexOf(q) !== -1) return true;
    return false;
}

/**
 * @param {object|null|undefined} pin
 * @param {{
 *   catalogs?: Record<string, object>,
 *   friction?: Uint8Array|number[]|null,
 *   cols?: number,
 *   rows?: number,
 *   blocked?: number
 * }} [opts]
 * @returns {'empty'|'unknown'|'blocked'|'ok'}
 */
function classifyWorldPin(pin, opts) {
    const o = opts || {};
    if (!pin || typeof pin !== 'object') return FIND_ISSUE_EMPTY;
    const catalogId = String(pin.catalogId || '').trim();
    if (!catalogId) return FIND_ISSUE_EMPTY;
    const catalogs = o.catalogs && typeof o.catalogs === 'object' ? o.catalogs : null;
    if (catalogs && Object.keys(catalogs).length && !catalogs[catalogId]) {
        return FIND_ISSUE_UNKNOWN;
    }
    const friction = o.friction;
    const cols = o.cols | 0;
    const rows = o.rows | 0;
    if (friction && cols > 0 && rows > 0) {
        const x = finiteInt(pin.x);
        const y = finiteInt(pin.y);
        if (x != null && y != null && x >= 0 && y >= 0 && x < cols && y < rows) {
            const blocked = o.blocked != null ? o.blocked & 0xff : 255;
            if ((friction[y * cols + x] & 0xff) === blocked) return FIND_ISSUE_BLOCKED;
        }
    }
    return FIND_ISSUE_OK;
}

/**
 * @param {object[]} pins
 * @param {{
 *   query?: string,
 *   onlyModified?: boolean,
 *   kind?: string,
 *   issue?: string,
 *   catalogs?: Record<string, object>,
 *   friction?: Uint8Array|number[]|null,
 *   cols?: number,
 *   rows?: number,
 *   blocked?: number
 * }} [opts]
 * @returns {object[]}
 */
function filterEditorWorld(pins, opts) {
    const list = Array.isArray(pins) ? pins : [];
    const o = opts || {};
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (!p) continue;
        if (o.query && !worldMatchesQuery(p, o.query)) continue;
        if (o.kind && normalizeWorldKind(p.kind) !== normalizeWorldKind(o.kind)) continue;
        if (o.onlyModified && !isModifiedWorld(p)) continue;
        if (o.issue) {
            const issue = classifyWorldPin(p, o);
            if (o.issue === FIND_ISSUE_UNKNOWN) {
                if (issue !== FIND_ISSUE_UNKNOWN && issue !== FIND_ISSUE_EMPTY) continue;
            } else if (issue !== o.issue) {
                continue;
            }
        }
        out.push(p);
    }
    return out;
}

/**
 * @param {Array<{ floor: string|number, world: object[] }>} floors
 * @param {{
 *   query?: string,
 *   issue?: string,
 *   catalogs?: Record<string, object>,
 *   frictionForFloor?: function(string|number): { friction: Uint8Array|number[], cols: number, rows: number }|null
 * }} [opts]
 * @returns {Array<{ floor: string|number, pin: object, issue: string }>}
 */
function findWorldHits(floors, opts) {
    const bags = Array.isArray(floors) ? floors : [];
    const o = opts || {};
    const hits = [];
    for (let b = 0; b < bags.length; b++) {
        const bag = bags[b];
        if (!bag) continue;
        const rows = Array.isArray(bag.world) ? bag.world : [];
        let classOpts = o;
        if (typeof o.frictionForFloor === 'function') {
            const ch = o.frictionForFloor(bag.floor);
            classOpts = Object.assign({}, o, ch || {});
        }
        for (let i = 0; i < rows.length; i++) {
            const p = rows[i];
            if (!p) continue;
            if (o.query && !worldMatchesQuery(p, o.query)) continue;
            const issue = classifyWorldPin(p, classOpts);
            if (o.issue) {
                if (o.issue === FIND_ISSUE_UNKNOWN) {
                    if (issue !== FIND_ISSUE_UNKNOWN && issue !== FIND_ISSUE_EMPTY) continue;
                } else if (issue !== o.issue) {
                    continue;
                }
            }
            hits.push({ floor: bag.floor, pin: p, issue });
        }
    }
    return hits;
}

/**
 * Relative clipboard. Origin = min x/y of the selection.
 * @param {object[]} pins
 * @returns {{ origin: { x: number, y: number }, pins: object[] }|null}
 */
function copyWorldPins(pins) {
    const list = (Array.isArray(pins) ? pins : []).filter(
        (p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
    );
    if (!list.length) return null;
    let ox = Infinity;
    let oy = Infinity;
    for (let i = 0; i < list.length; i++) {
        const x = Math.round(Number(list[i].x));
        const y = Math.round(Number(list[i].y));
        if (x < ox) ox = x;
        if (y < oy) oy = y;
    }
    const out = [];
    for (let i = 0; i < list.length; i++) {
        const n = normalizeWorldPin(list[i]);
        if (!n) continue;
        out.push({
            dx: n.x - ox,
            dy: n.y - oy,
            pin: n
        });
    }
    if (!out.length) return null;
    return { origin: { x: ox, y: oy }, pins: out };
}

/**
 * @param {{ pins: object[] }|null|undefined} clip
 * @param {{ x: number, y: number, z?: number }} dest
 * @param {Record<string, object>|null|undefined} catalogs
 * @param {object[]} [existing]
 * @returns {object[]}
 */
function pasteWorldPins(clip, dest, catalogs, existing) {
    if (!clip || !Array.isArray(clip.pins) || !clip.pins.length) return [];
    const dx0 = dest && dest.x != null ? Math.round(Number(dest.x)) : 0;
    const dy0 = dest && dest.y != null ? Math.round(Number(dest.y)) : 0;
    if (!Number.isFinite(dx0) || !Number.isFinite(dy0)) return [];
    const z = dest && dest.z != null ? Number(dest.z) : 0;
    const used = collectWorldIds(existing);
    const out = [];
    for (let i = 0; i < clip.pins.length; i++) {
        const row = clip.pins[i];
        if (!row) continue;
        const src = row.pin || row;
        const x = dx0 + (Number(row.dx) || 0);
        const y = dy0 + (Number(row.dy) || 0);
        const raw = Object.assign({}, src, { x, y, z, id: '' });
        const pin = makeEditorWorldPin(raw, catalogs, { z, usedIds: used });
        if (pin) {
            used.push(pin.id);
            out.push(pin);
        }
    }
    return out;
}

/**
 * @param {*} raw
 * @returns {number|null}
 */
function parseWorldFloorZ(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    const z = Math.round(n);
    if (z < MIN_WORLD_FLOOR_Z || z > MAX_WORLD_FLOOR_Z) return null;
    return z;
}

/**
 * @param {*} fromZ
 * @param {*} toZ
 * @returns {{ ok: true, fromZ: number, toZ: number }|{ ok: false, reason: 'same'|'invalid' }}
 */
function planWorldFloorMove(fromZ, toZ) {
    const from = parseWorldFloorZ(fromZ);
    const to = parseWorldFloorZ(toZ);
    if (from == null || to == null) return { ok: false, reason: 'invalid' };
    if (from === to) return { ok: false, reason: 'same' };
    return { ok: true, fromZ: from, toZ: to };
}

/**
 * @param {object[]} fromList
 * @param {object[]} destList
 * @param {object} pin
 * @param {number} destZ
 * @returns {{ fromList: object[], destList: object[], moved: object }|null}
 */
function applyWorldFloorMove(fromList, destList, pin, destZ) {
    const z = parseWorldFloorZ(destZ);
    if (z == null || !pin || typeof pin !== 'object') return null;
    const from = Array.isArray(fromList) ? fromList.slice() : [];
    const dest = Array.isArray(destList) ? destList.slice() : [];
    const idx = from.indexOf(pin);
    if (idx < 0) return null;
    from.splice(idx, 1);
    const moved = Object.assign({}, pin, { z });
    dest.push(moved);
    return { fromList: from, destList: dest, moved };
}

module.exports = {
    WORLD_KINDS,
    CATALOG_KINDS,
    DEFAULT_CONTAINER_CAPACITY,
    DEFAULT_LEVER_STATES,
    WORLD_USE_KINDS,
    TRAP_FIELD_KINDS,
    MAX_ITEM_NEST,
    MIN_WORLD_FLOOR_Z,
    MAX_WORLD_FLOOR_Z,
    FIND_ISSUE_EMPTY,
    FIND_ISSUE_UNKNOWN,
    FIND_ISSUE_BLOCKED,
    FIND_ISSUE_OK,
    slugifyWorldId,
    normalizeWorldKind,
    normalizeCatalogKind,
    kindDefaults,
    parseWorldRows,
    loadFloorWorldFromDocs,
    normalizeWorldItem,
    normalizeWorldItems,
    cloneWorldItems,
    normalizeChestOnce,
    normalizeChestWhen,
    normalizeChestSet,
    normalizeLeverStates,
    normalizeLeverEffects,
    normalizeSpawnEffect,
    normalizeWaveEffect,
    normalizeUnlockEffect,
    normalizeCooldownSec,
    normalizeTrapField,
    normalizeTrapDamage,
    normalizeDoorGate,
    normalizeTeleportTo,
    normalizeTransformOnUse,
    normalizeDecay,
    worldPinUseReady,
    allocWorldPinId,
    collectWorldIds,
    normalizeWorldPin,
    normalizeWorldList,
    makeEditorWorldPin,
    stripWorldPinForSave,
    stripWorldListForSave,
    worldPinSignature,
    markWorldBaseline,
    isModifiedWorld,
    worldPinAtTile,
    worldMatchesQuery,
    classifyWorldPin,
    filterEditorWorld,
    findWorldHits,
    copyWorldPins,
    pasteWorldPins,
    parseWorldFloorZ,
    planWorldFloorMove,
    applyWorldFloorMove
};
