/**
 * Elemental field hazards (fire, poison, energy) and solid obstacle fields
 * (barrier wall / vine barrier). Contract: docs/26_elemental_fields_design.md.
 *
 * Short-lived fields register in a per-store expiry heap (≤ 24h duration).
 * Longer scenario props skip the heap and stay until replaced.
 *
 * Obstacle kinds block pathfinding by temporarily setting tile friction to
 * FRICTION_BLOCKED (restored on remove/expire). They deal no entry damage.
 * Placement stores {x,y,z} on the ground stack — floor hop by the caster does
 * not move or cancel the obstacle (same as elemental fields / delayed casts).
 */

'use strict';

const { Time } = require('../time.js');
const { applyMitigation } = require('./damage.js');
const { applyCondition } = require('./conditions.js');
const { tileKey } = require('../character/ground_items.js');
const { createItemInstance, destroyItem } = require('../character/inventory.js');

/** Match tilemap.FRICTION_BLOCKED — avoid requiring tilemap (circular). */
const FRICTION_BLOCKED = 255;

const FIELD_KINDS = {
    FIRE: 'fire',
    POISON: 'poison',
    ENERGY: 'energy',
    /** Solid path blocker (legacy magic wall). */
    BARRIER: 'barrier',
    /** Solid path blocker (legacy wild growth). */
    VINE: 'vine'
};

const FIELD_SOURCES = {
    PLAYER: 'player',
    CREATURE: 'creature',
    SCENARIO: 'scenario'
};

const FIELD_MASKS = {
    FIRE: 1,
    POISON: 2,
    ENERGY: 4,
    PLAYER: 8,
    /** Solid obstacle (barrier / vine) — always hard-blocks pathfinding. */
    OBSTACLE: 16
};

/** Default combat durations (seconds). */
const FIELD_DURATIONS_SEC = {
    fire: { stage1: 200, stage2: 348, total: 446 },
    poison: { active: 248, total: 248 },
    energy: { active: 98, total: 98 },
    // Legacy magic wall setDuration(16, 24) → mid 20s fixed for determinism.
    barrier: { total: 20 },
    // Legacy wild growth setDuration(30).
    vine: { total: 30 }
};

/** Fields longer than this never enter the active expiry registry. */
const ACTIVE_FIELD_MAX_DURATION_SEC = 24 * 3600;

const FIELD_ITEM_IDS = {
    fire: 'fire_field',
    poison: 'poison_field',
    energy: 'energy_field',
    barrier: 'barrier_wall',
    vine: 'vine_barrier'
};

const FIELD_DISPLAY_NAMES = {
    fire: 'Fire Field',
    poison: 'Poison Field',
    energy: 'Energy Field',
    barrier: 'Barrier Wall',
    vine: 'Vine Barrier'
};

/**
 * Solid path-blocking field kinds (no damage; block walk / A*).
 * @param {string|null|undefined} kind
 * @returns {boolean}
 */
function isObstacleFieldKind(kind) {
    return kind === 'barrier' || kind === 'vine';
}

/**
 * @param {string|object|null|undefined} input
 * @returns {'fire'|'poison'|'energy'|'barrier'|'vine'|null}
 */
function getFieldKind(input) {
    if (input == null) return null;
    if (typeof input === 'string') {
        const str = input.toLowerCase().trim();
        if (
            str === 'fire' ||
            str === 'fire_field' ||
            str === 'firefield' ||
            str.startsWith('firefield')
        ) {
            return 'fire';
        }
        if (
            str === 'poison' ||
            str === 'poison_field' ||
            str === 'poisonfield' ||
            str.startsWith('poisonfield') ||
            str.startsWith('earthfield')
        ) {
            return 'poison';
        }
        if (
            str === 'energy' ||
            str === 'energy_field' ||
            str === 'energyfield' ||
            str.startsWith('energyfield')
        ) {
            return 'energy';
        }
        // Solid obstacles (Phase K) — commercial-safe + legacy aliases.
        if (
            str === 'barrier' ||
            str === 'barrier_wall' ||
            str === 'barrier_field' ||
            str === 'magic_wall' ||
            str === 'magicwall' ||
            str.startsWith('magicwall') ||
            str.startsWith('magic_wall')
        ) {
            return 'barrier';
        }
        if (
            str === 'vine' ||
            str === 'vine_barrier' ||
            str === 'vine_field' ||
            str === 'wild_growth' ||
            str === 'wildgrowth' ||
            str.startsWith('wildgrowth') ||
            str.startsWith('wild_growth')
        ) {
            return 'vine';
        }
        return null;
    }
    if (typeof input === 'object') {
        if (input.fieldKind) return getFieldKind(String(input.fieldKind));
        if (input.field != null) return getFieldKind(input.field);
        if (input.deploysField != null) return getFieldKind(input.deploysField);
        const id = String(input.itemId || input.id || input.name || input.legacyName || '');
        return getFieldKind(id);
    }
    return null;
}

/**
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function isFieldItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.isField === true || item.immovableField === true || item.fieldKind != null) {
        return true;
    }
    if (typeof item.itemId === 'string') {
        return Boolean(getFieldKind(item.itemId));
    }
    return false;
}

/**
 * Whether this field instance is a solid path blocker.
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function isObstacleField(item) {
    if (!item) return false;
    if (item.isObstacle === true) return true;
    return isObstacleFieldKind(item.fieldKind || getFieldKind(item));
}

/**
 * Default total duration for a field kind (seconds).
 * @param {string} kind
 * @returns {number}
 */
function defaultDurationSec(kind) {
    const d = FIELD_DURATIONS_SEC[kind];
    return d && d.total != null ? Number(d.total) : 0;
}

/**
 * Resolve expire timestamp for a field instance.
 * @param {object} field
 * @returns {number}
 */
function fieldExpireAt(field) {
    if (!field) return 0;
    if (field.expireAt != null && Number.isFinite(Number(field.expireAt))) {
        return Number(field.expireAt);
    }
    const createdAt = field.createdAt != null ? Number(field.createdAt) : 0;
    const dur =
        field.durationSec != null && Number.isFinite(Number(field.durationSec))
            ? Number(field.durationSec)
            : defaultDurationSec(field.fieldKind || getFieldKind(field) || 'fire');
    return createdAt + dur;
}

/**
 * Compute decay state / fire stage at absolute time.
 * @param {object} field
 * @param {number} [currentTime]
 * @returns {{ expired: boolean, active: boolean, stage: number, kind: string|null, elapsed: number, duration: number }}
 */
function getFieldState(field, currentTime) {
    if (!isFieldItem(field)) {
        return { expired: true, active: false, stage: 0, kind: null, elapsed: 0, duration: 0 };
    }
    const kind = field.fieldKind || getFieldKind(field) || 'fire';
    const now = currentTime != null ? Number(currentTime) : Time.timeSinceLevelLoad;
    const createdAt = field.createdAt != null ? Number(field.createdAt) : 0;
    const elapsed = Math.max(0, now - createdAt);
    const expireAt = fieldExpireAt(field);
    const duration = Math.max(0, expireAt - createdAt);

    if (now >= expireAt || (duration > 0 && elapsed >= duration)) {
        return { expired: true, active: false, stage: 0, kind, elapsed, duration };
    }

    // Custom / long-lived fields: fully active until expiry (no fire stage-3 idle).
    const usesDefaultFireStages =
        kind === 'fire' &&
        field.durationSec == null &&
        (field.expireAt == null ||
            Math.abs(Number(field.expireAt) - (createdAt + FIELD_DURATIONS_SEC.fire.total)) < 1e-6);

    if (kind === 'fire' && usesDefaultFireStages) {
        const dur = FIELD_DURATIONS_SEC.fire;
        if (elapsed < dur.stage1) {
            return { expired: false, active: true, stage: 1, kind, elapsed, duration: dur.total };
        }
        if (elapsed < dur.stage2) {
            return { expired: false, active: true, stage: 2, kind, elapsed, duration: dur.total };
        }
        return { expired: false, active: false, stage: 3, kind, elapsed, duration: dur.total };
    }

    return { expired: false, active: true, stage: 1, kind, elapsed, duration };
}

/**
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isPlayerEntity(entity) {
    if (!entity) return false;
    if (entity.type === 'player') return true;
    if (entity.classId != null) return true;
    if (entity.constructor && entity.constructor.name === 'Player') return true;
    return false;
}

/**
 * @param {object|null|undefined} entity
 * @param {string} [fieldSource]
 * @returns {boolean}
 */
function isEntityImmuneToField(entity, fieldSource) {
    if (!entity) return true;
    const src = fieldSource || FIELD_SOURCES.SCENARIO;
    if (src === FIELD_SOURCES.PLAYER && isPlayerEntity(entity)) return true;
    return false;
}

/**
 * Derive elemental field avoidance bitmask and friendly fire rules for pathfinding.
 * @param {object|null|undefined} entity
 * @returns {{ avoidFieldMask: number, ignorePlayerFields: boolean }}
 */
function computeEntityAvoidFieldMask(entity) {
    if (!entity) {
        return { avoidFieldMask: 0, ignorePlayerFields: false };
    }
    const ignorePlayerFields = isPlayerEntity(entity);
    if (entity.avoidFieldMask !== undefined && entity.avoidFieldMask !== null) {
        return {
            avoidFieldMask: Number(entity.avoidFieldMask) | 0,
            ignorePlayerFields: entity.ignorePlayerFields !== undefined ? !!entity.ignorePlayerFields : ignorePlayerFields
        };
    }

    const flags = entity.flags || (entity.template && entity.template.flags) || {};
    const resists = entity.resists || (entity.template && entity.template.resists) || {};

    let mask = 0;
    const canFire = flags.canWalkOnFire === true || (resists.fire != null && Number(resists.fire) >= 100);
    const canPoison = flags.canWalkOnPoison === true || flags.canWalkOnEarth === true || (resists.earth != null && Number(resists.earth) >= 100) || (resists.poison != null && Number(resists.poison) >= 100);
    const canEnergy = flags.canWalkOnEnergy === true || (resists.energy != null && Number(resists.energy) >= 100);

    if (!canFire) mask |= FIELD_MASKS.FIRE;
    if (!canPoison) mask |= FIELD_MASKS.POISON;
    if (!canEnergy) mask |= FIELD_MASKS.ENERGY;

    return { avoidFieldMask: mask, ignorePlayerFields };
}

/**
 * Whether a tile field bitmask is a hazard for the given avoidance options.
 * Creature/scenario fields always count when the kind bit matches; player-sourced
 * fields (bit 8) are skipped only when ignorePlayerFields is true.
 * @param {number} tileMask
 * @param {number} avoidFieldMask
 * @param {boolean} [ignorePlayerFields=false]
 * @returns {boolean}
 */
function isFieldMaskHazard(tileMask, avoidFieldMask, ignorePlayerFields) {
    const mask = Number(tileMask) | 0;
    const avoid = Number(avoidFieldMask) | 0;
    if (!mask || avoid <= 0 || (mask & avoid) === 0) return false;
    if (ignorePlayerFields && (mask & FIELD_MASKS.PLAYER) !== 0) return false;
    return true;
}

/**
 * Whether a map tile is an elemental hazard for this entity (path / engage / spawn).
 * @param {{ getTileFieldMask?: function }|null|undefined} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isTileFieldHazardForEntity(tileMap, x, y, z, entity) {
    if (!tileMap || typeof tileMap.getTileFieldMask !== 'function') return false;
    const opts = computeEntityAvoidFieldMask(entity);
    if (!(opts.avoidFieldMask > 0)) return false;
    const tileMask = tileMap.getTileFieldMask(x, y, z);
    return isFieldMaskHazard(tileMask, opts.avoidFieldMask, opts.ignorePlayerFields);
}

// ---------------------------------------------------------------------------
// Active-field expiry registry (per GroundStore)
// ---------------------------------------------------------------------------

/**
 * @param {object} groundStore
 * @returns {{ byKey: Object, heap: object[], gen: number }}
 */
function ensureFieldRegistry(groundStore) {
    if (!groundStore._fieldRegistry) {
        groundStore._fieldRegistry = {
            /** @type {Record<string, { expireAt: number, uid: string, kind: string, gen: number }>} */
            byKey: Object.create(null),
            /** @type {{ expireAt: number, tileKey: string, gen: number }[]} */
            heap: [],
            gen: 0
        };
    }
    return groundStore._fieldRegistry;
}

/**
 * Binary min-heap on expireAt (lazy invalidation via gen).
 * @param {{ expireAt: number, tileKey: string, gen: number }[]} heap
 * @param {{ expireAt: number, tileKey: string, gen: number }} node
 */
function heapPush(heap, node) {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p].expireAt <= heap[i].expireAt) break;
        const t = heap[p];
        heap[p] = heap[i];
        heap[i] = t;
        i = p;
    }
}

/**
 * @param {{ expireAt: number, tileKey: string, gen: number }[]} heap
 * @returns {{ expireAt: number, tileKey: string, gen: number }|null}
 */
function heapPop(heap) {
    if (!heap.length) return null;
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
        heap[0] = last;
        let i = 0;
        for (;;) {
            const l = i * 2 + 1;
            const r = l + 1;
            let smallest = i;
            if (l < heap.length && heap[l].expireAt < heap[smallest].expireAt) {
                smallest = l;
            }
            if (r < heap.length && heap[r].expireAt < heap[smallest].expireAt) {
                smallest = r;
            }
            if (smallest === i) break;
            const t = heap[i];
            heap[i] = heap[smallest];
            heap[smallest] = t;
            i = smallest;
        }
    }
    return top;
}

/**
 * Register field for automatic purge when duration ≤ 24h.
 * @param {object} groundStore
 * @param {string} key
 * @param {object} field
 */
function registerActiveField(groundStore, key, field) {
    if (!groundStore || !field) return;
    const duration =
        field.durationSec != null && Number.isFinite(Number(field.durationSec))
            ? Number(field.durationSec)
            : fieldExpireAt(field) - (field.createdAt != null ? Number(field.createdAt) : 0);
    if (!(duration > 0) || duration > ACTIVE_FIELD_MAX_DURATION_SEC) {
        // Long-lived / scenario: drop any prior short-lived registration for this tile.
        unregisterActiveField(groundStore, key);
        return;
    }
    const reg = ensureFieldRegistry(groundStore);
    reg.gen += 1;
    const gen = reg.gen;
    const expireAt = fieldExpireAt(field);
    reg.byKey[key] = {
        expireAt,
        uid: field.uid,
        kind: field.fieldKind || getFieldKind(field) || 'fire',
        gen
    };
    heapPush(reg.heap, { expireAt, tileKey: key, gen });
}

/**
 * @param {object} groundStore
 * @param {string} key
 */
function unregisterActiveField(groundStore, key) {
    if (!groundStore || !groundStore._fieldRegistry) return;
    const reg = groundStore._fieldRegistry;
    if (reg.byKey[key]) delete reg.byKey[key];
}

/**
 * @param {import('../character/ground_items.js').GroundStore|null|undefined} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @returns {object|null}
 */
function getFieldOnTile(groundStore, x, y, z) {
    if (!groundStore || !groundStore.stacks || !groundStore.inventory) return null;
    const tz = z !== undefined && z !== null ? z : 0;
    const key = tileKey(Math.round(x), Math.round(y), tz);
    const stack = groundStore.stacks[key];
    if (!Array.isArray(stack) || !stack.length) return null;
    // Top-most field wins (stack is bottom→top).
    for (let i = stack.length - 1; i >= 0; i--) {
        const item = groundStore.inventory.items[stack[i]];
        if (item && isFieldItem(item)) return item;
    }
    return null;
}

/**
 * Synchronize a tile's active elemental fields bitmask to the TileMap layer.
 * @param {import('../character/ground_items.js').GroundStore|null|undefined} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z=0]
 */
function syncTileMapFieldMask(groundStore, x, y, z) {
    if (!groundStore || !groundStore.tileMap || typeof groundStore.tileMap.setTileFieldMask !== 'function') {
        return;
    }
    const tz = z !== undefined && z !== null ? z : 0;
    const field = getFieldOnTile(groundStore, x, y, tz);
    let mask = 0;
    if (field && !getFieldState(field).expired) {
        const kind = field.fieldKind || getFieldKind(field);
        if (kind === 'fire') mask |= FIELD_MASKS.FIRE;
        else if (kind === 'poison') mask |= FIELD_MASKS.POISON;
        else if (kind === 'energy') mask |= FIELD_MASKS.ENERGY;
        else if (isObstacleFieldKind(kind)) mask |= FIELD_MASKS.OBSTACLE;
        if (field.source === FIELD_SOURCES.PLAYER) mask |= FIELD_MASKS.PLAYER;
    }
    groundStore.tileMap.setTileFieldMask(x, y, tz, mask);
}

/**
 * Set or restore tile friction when deploying / removing solid obstacles.
 * Stores `savedFriction` on the field instance for exact restore.
 * @param {object} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {object} field
 * @param {'block'|'restore'} mode
 */
function syncObstacleFriction(groundStore, x, y, z, field, mode) {
    if (!field || !isObstacleField(field)) return;
    const tileMap = groundStore && groundStore.tileMap;
    if (!tileMap || typeof tileMap.getLayer !== 'function') return;
    const layer = tileMap.getLayer(z);
    if (!layer || !layer.friction) return;
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= layer.cols || iy >= layer.rows) return;
    const idx =
        typeof tileMap.index === 'function'
            ? tileMap.index(ix, iy, layer.cols)
            : iy * layer.cols + ix;
    if (mode === 'block') {
        if (field.savedFriction == null) {
            field.savedFriction = layer.friction[idx];
        }
        layer.friction[idx] = FRICTION_BLOCKED;
    } else if (mode === 'restore') {
        if (field.savedFriction != null && Number.isFinite(Number(field.savedFriction))) {
            // Only restore if we still own the block (another obstacle may have re-blocked).
            if (layer.friction[idx] === FRICTION_BLOCKED) {
                layer.friction[idx] = Number(field.savedFriction) & 0xff;
            }
        }
        field.savedFriction = null;
    }
}

/**
 * @param {import('../character/ground_items.js').GroundStore|null|undefined} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @returns {boolean}
 */
function removeFieldFromTile(groundStore, x, y, z) {
    if (!groundStore || !groundStore.stacks || !groundStore.inventory) return false;
    const tz = z !== undefined && z !== null ? z : 0;
    const tx = Math.round(x);
    const ty = Math.round(y);
    const key = tileKey(tx, ty, tz);
    const stack = groundStore.stacks[key];
    if (!Array.isArray(stack) || !stack.length) return false;
    let removed = false;
    for (let i = stack.length - 1; i >= 0; i--) {
        const uid = stack[i];
        const item = groundStore.inventory.items[uid];
        if (item && isFieldItem(item)) {
            syncObstacleFriction(groundStore, tx, ty, tz, item, 'restore');
            stack.splice(i, 1);
            destroyItem(groundStore.inventory, uid);
            removed = true;
        }
    }
    if (stack.length === 0) delete groundStore.stacks[key];
    if (removed) {
        unregisterActiveField(groundStore, key);
        syncTileMapFieldMask(groundStore, tx, ty, tz);
    }
    return removed;
}

/**
 * Deploy field: replace any existing field on the tile, push new field on top of stack.
 * @param {import('../character/ground_items.js').GroundStore} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @param {object} [opts]
 * @param {string} [opts.kind]
 * @param {string} [opts.id]
 * @param {string} [opts.source]
 * @param {number} [opts.createdAt]
 * @param {number} [opts.durationSec] override total lifetime
 * @param {number} [opts.expireAt] absolute expire time
 * @returns {object|null}
 */
function deployFieldToTile(groundStore, x, y, z, opts) {
    const o = opts || {};
    if (!groundStore || !groundStore.inventory || !groundStore.stacks) return null;
    const tz = z !== undefined && z !== null ? z : 0;
    const tx = Math.round(x);
    const ty = Math.round(y);
    const kind = o.kind || getFieldKind(o.id || o.name || o.itemId) || 'fire';
    const source = o.source || FIELD_SOURCES.SCENARIO;
    const createdAt = o.createdAt != null ? Number(o.createdAt) : Time.timeSinceLevelLoad;

    let durationSec =
        o.durationSec != null && Number.isFinite(Number(o.durationSec))
            ? Math.max(0, Number(o.durationSec))
            : defaultDurationSec(kind);
    let expireAt =
        o.expireAt != null && Number.isFinite(Number(o.expireAt))
            ? Number(o.expireAt)
            : createdAt + durationSec;
    if (o.expireAt != null && o.durationSec == null) {
        durationSec = Math.max(0, expireAt - createdAt);
    }

    removeFieldFromTile(groundStore, tx, ty, tz);

    const itemId = FIELD_ITEM_IDS[kind] || kind + '_field';
    const uid = createItemInstance(groundStore.inventory, itemId, null, { count: 1 });
    if (!uid) return null;

    const item = groundStore.inventory.items[uid];
    item.name = FIELD_DISPLAY_NAMES[kind] || itemId;
    item.isField = true;
    item.fieldKind = kind;
    item.source = source;
    item.createdAt = createdAt;
    item.durationSec = durationSec;
    item.expireAt = expireAt;
    item.weight = 0;
    item.immovable = true;
    item.immovableField = true;
    // Floor stick: location z is fixed at plant time (caster floor hop does not move it).
    item.location = { kind: 'ground', x: tx, y: ty, z: tz };
    if (isObstacleFieldKind(kind)) {
        item.isObstacle = true;
    }

    const key = tileKey(tx, ty, tz);
    if (!groundStore.stacks[key]) groundStore.stacks[key] = [];
    // New field is always top of stack (items already on tile stay below).
    groundStore.stacks[key].push(uid);

    // Solid obstacles hard-block walkability until expiry / remove.
    if (item.isObstacle) {
        syncObstacleFriction(groundStore, tx, ty, tz, item, 'block');
    }

    registerActiveField(groundStore, key, item);
    syncTileMapFieldMask(groundStore, tx, ty, tz);
    return item;
}

/**
 * @param {object} entity
 * @param {number} amount
 * @param {string} element
 * @returns {number} final damage applied (after mitigation floor)
 */
function inflictFieldDamage(entity, amount, element) {
    if (!entity || !entity.alive) return 0;
    const mit = applyMitigation(amount, element, entity);
    const dmg = mit.final;
    if (!(dmg > 0)) return 0;
    if (typeof entity.applyHpDelta === 'function') {
        entity.applyHpDelta(dmg, element);
    } else if (entity.hp) {
        entity.hp.current = Math.max(0, (entity.hp.current || 0) - dmg);
        if (entity.hp.current <= 0) entity.alive = false;
    }
    return dmg;
}

/**
 * Step-on / spawn-underfoot entry effects.
 * @param {object} entity
 * @param {object} field
 * @param {number} [currentTime]
 * @returns {{ applied: boolean, kind?: string, element?: string, damage?: number, condition?: string|null, immunity?: boolean, active?: boolean }}
 */
function applyFieldEntryEffects(entity, field, currentTime) {
    if (!entity || !entity.alive || !field) return { applied: false, damage: 0 };
    if (isEntityImmuneToField(entity, field.source)) {
        return { applied: false, immunity: true, damage: 0 };
    }
    const state = getFieldState(field, currentTime);
    if (!state.active || state.expired) return { applied: false, active: false, damage: 0 };

    // Solid obstacles: path blockers only — no step damage / status.
    if (isObstacleFieldKind(state.kind) || isObstacleField(field)) {
        return { applied: false, kind: state.kind, damage: 0, reason: 'obstacle' };
    }

    let damage = 0;
    let conditionName = null;
    let element = 'physical';

    if (state.kind === 'fire') {
        element = 'fire';
        damage = inflictFieldDamage(entity, 20, 'fire');
        if (entity.alive) {
            applyCondition(
                entity,
                {
                    type: 'fire',
                    schedule: [{ turns: 7, damage: 10, intervalSec: 9 }],
                    totalDamage: 70
                },
                { source: field.source || 'scenario', forceOverride: true }
            );
            conditionName = 'fire';
        }
    } else if (state.kind === 'poison') {
        element = 'earth';
        damage = inflictFieldDamage(entity, 5, 'earth');
        if (entity.alive) {
            applyCondition(
                entity,
                {
                    type: 'poison',
                    schedule: [
                        { turns: 4, damage: 5, intervalSec: 2 },
                        { turns: 5, damage: 4, intervalSec: 2 },
                        { turns: 7, damage: 3, intervalSec: 2 },
                        { turns: 10, damage: 2, intervalSec: 2 },
                        { turns: 19, damage: 1, intervalSec: 2 }
                    ],
                    totalDamage: 100
                },
                { source: field.source || 'scenario', forceOverride: true }
            );
            conditionName = 'poison';
        }
    } else if (state.kind === 'energy') {
        element = 'energy';
        damage = inflictFieldDamage(entity, 30, 'energy');
    }

    return { applied: true, kind: state.kind, element, damage, condition: conditionName };
}

/**
 * Energy exit damage when leaving a field (or underfoot expire).
 * @param {object} entity
 * @param {object} prevField
 * @param {object|null} nextField
 * @param {number} [currentTime]
 * @returns {{ applied: boolean, element?: string, damage?: number, reason?: string, immunity?: boolean }}
 */
function applyEnergyFieldExitEffect(entity, prevField, nextField, currentTime) {
    if (!entity || !entity.alive || !prevField) return { applied: false, damage: 0 };
    if (isEntityImmuneToField(entity, prevField.source)) {
        return { applied: false, immunity: true, damage: 0 };
    }
    const state = getFieldState(prevField, currentTime);
    // Expired underfoot still counts as energy exit (kind preserved on item until purge).
    const kind = state.kind || prevField.fieldKind || getFieldKind(prevField);
    if (kind !== 'energy') return { applied: false, reason: 'not_energy', damage: 0 };

    if (nextField) {
        const nextState = getFieldState(nextField, currentTime);
        if (
            !nextState.expired &&
            nextState.kind === 'energy' &&
            !isEntityImmuneToField(entity, nextField.source)
        ) {
            return { applied: false, reason: 'moved_to_energy_field', damage: 0 };
        }
    }

    const damage = inflictFieldDamage(entity, 25, 'energy');
    return { applied: true, element: 'energy', damage };
}

/**
 * @param {import('../character/ground_items.js').GroundStore} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @param {number} [currentTime]
 * @param {object[]} [occupantEntities]
 * @returns {boolean}
 */
function checkAndCleanExpiredTileFields(groundStore, x, y, z, currentTime, occupantEntities) {
    const field = getFieldOnTile(groundStore, x, y, z);
    if (!field) return false;
    const now = currentTime != null ? Number(currentTime) : Time.timeSinceLevelLoad;
    const state = getFieldState(field, now);
    if (!state.expired) return false;

    if (state.kind === 'energy' && Array.isArray(occupantEntities)) {
        for (let i = 0; i < occupantEntities.length; i++) {
            const ent = occupantEntities[i];
            if (ent && ent.alive && !isEntityImmuneToField(ent, field.source)) {
                // Treat removal as exit from this energy field (no next field).
                applyEnergyFieldExitEffect(ent, field, null, now);
            }
        }
    }
    removeFieldFromTile(groundStore, x, y, z);
    return true;
}

/**
 * Parse `z:x:y` tile keys produced by ground_items.tileKey.
 * @param {string} key
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function parseTileKey(key) {
    if (!key || typeof key !== 'string') return null;
    const parts = key.split(':');
    if (parts.length < 3) return null;
    const z = parts[0];
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y, z };
}

/**
 * Purge short-lived fields whose expireAt ≤ now (heap-driven).
 * @param {import('../character/ground_items.js').GroundStore|null|undefined} groundStore
 * @param {number} [currentTime]
 * @param {(x:number,y:number,z:string|number) => object[]} [getOccupants]
 * @returns {number} count purged
 */
function purgeExpiredFields(groundStore, currentTime, getOccupants) {
    if (!groundStore || !groundStore._fieldRegistry) return 0;
    const now = currentTime != null ? Number(currentTime) : Time.timeSinceLevelLoad;
    const reg = groundStore._fieldRegistry;
    let purged = 0;

    while (reg.heap.length) {
        const peek = reg.heap[0];
        if (!peek || peek.expireAt > now) break;
        const node = heapPop(reg.heap);
        if (!node) break;
        const meta = reg.byKey[node.tileKey];
        // Stale heap entry (field replaced or unregistered).
        if (!meta || meta.gen !== node.gen) continue;

        const parsed = parseTileKey(node.tileKey);
        if (!parsed) {
            delete reg.byKey[node.tileKey];
            continue;
        }
        let occupants = null;
        if (typeof getOccupants === 'function') {
            occupants = getOccupants(parsed.x, parsed.y, parsed.z) || [];
        }
        if (checkAndCleanExpiredTileFields(groundStore, parsed.x, parsed.y, parsed.z, now, occupants)) {
            purged += 1;
        } else {
            // Meta pointed at a gone field — clear registry entry.
            unregisterActiveField(groundStore, node.tileKey);
        }
    }
    return purged;
}

/**
 * @param {object} entity
 * @param {{ x: number, y: number, z?: string|number }|null} prevTile
 * @param {{ x: number, y: number, z?: string|number }|null} nextTile
 * @param {import('../character/ground_items.js').GroundStore} groundStore
 * @param {number} [currentTime]
 */
function onEntityTileTransition(entity, prevTile, nextTile, groundStore, currentTime) {
    if (!entity || !groundStore || (!prevTile && !nextTile)) return;
    const now = currentTime != null ? Number(currentTime) : Time.timeSinceLevelLoad;
    const pz = prevTile && prevTile.z !== undefined && prevTile.z !== null ? prevTile.z : 0;
    const nz = nextTile && nextTile.z !== undefined && nextTile.z !== null ? nextTile.z : 0;

    let prevField = prevTile ? getFieldOnTile(groundStore, prevTile.x, prevTile.y, pz) : null;
    let nextField = nextTile ? getFieldOnTile(groundStore, nextTile.x, nextTile.y, nz) : null;

    // Lazy cleanup of expired fields touched by this move.
    if (prevField && getFieldState(prevField, now).expired) {
        checkAndCleanExpiredTileFields(groundStore, prevTile.x, prevTile.y, pz, now, [entity]);
        prevField = null;
    }
    if (nextField && getFieldState(nextField, now).expired) {
        removeFieldFromTile(groundStore, nextTile.x, nextTile.y, nz);
        nextField = null;
    }

    const activePrev = prevField && !getFieldState(prevField, now).expired ? prevField : null;
    const activeNext = nextField && !getFieldState(nextField, now).expired ? nextField : null;

    const moved =
        !prevTile ||
        !nextTile ||
        Math.round(prevTile.x) !== Math.round(nextTile.x) ||
        Math.round(prevTile.y) !== Math.round(nextTile.y) ||
        String(pz) !== String(nz);

    if (activePrev && moved) {
        applyEnergyFieldExitEffect(entity, activePrev, activeNext, now);
    }
    if (activeNext && moved && entity.alive) {
        applyFieldEntryEffects(entity, activeNext, now);
    }
}

/**
 * @param {import('../character/ground_items.js').GroundStore} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @param {object} fieldOpts
 * @param {object[]} [occupantEntities]
 * @param {number} [currentTime]
 * @returns {object|null}
 */
function deployFieldAndTriggerOccupants(groundStore, x, y, z, fieldOpts, occupantEntities, currentTime) {
    const now = currentTime != null ? Number(currentTime) : Time.timeSinceLevelLoad;
    const field = deployFieldToTile(
        groundStore,
        x,
        y,
        z,
        Object.assign({}, fieldOpts, {
            createdAt: fieldOpts && fieldOpts.createdAt != null ? fieldOpts.createdAt : now
        })
    );
    if (!field) return null;
    if (Array.isArray(occupantEntities)) {
        for (let i = 0; i < occupantEntities.length; i++) {
            const ent = occupantEntities[i];
            if (ent && ent.alive) applyFieldEntryEffects(ent, field, now);
        }
    }
    return field;
}

/**
 * Whether a field entry is tracked in the short-lived active registry.
 * @param {object} groundStore
 * @param {number} x
 * @param {number} y
 * @param {string|number} [z]
 * @returns {boolean}
 */
function isFieldInActiveRegistry(groundStore, x, y, z) {
    if (!groundStore || !groundStore._fieldRegistry) return false;
    const tz = z !== undefined && z !== null ? z : 0;
    const key = tileKey(Math.round(x), Math.round(y), tz);
    return !!groundStore._fieldRegistry.byKey[key];
}

module.exports = {
    FIELD_KINDS,
    FIELD_SOURCES,
    FIELD_MASKS,
    FIELD_DURATIONS_SEC,
    FIELD_ITEM_IDS,
    FIELD_DISPLAY_NAMES,
    ACTIVE_FIELD_MAX_DURATION_SEC,
    getFieldKind,
    isFieldItem,
    isObstacleFieldKind,
    isObstacleField,
    isPlayerEntity,
    isEntityImmuneToField,
    computeEntityAvoidFieldMask,
    isFieldMaskHazard,
    isTileFieldHazardForEntity,
    getFieldState,
    fieldExpireAt,
    getFieldOnTile,
    removeFieldFromTile,
    deployFieldToTile,
    syncTileMapFieldMask,
    syncObstacleFriction,
    applyFieldEntryEffects,
    applyEnergyFieldExitEffect,
    checkAndCleanExpiredTileFields,
    onEntityTileTransition,
    deployFieldAndTriggerOccupants,
    purgeExpiredFields,
    isFieldInActiveRegistry,
    ensureFieldRegistry
};
