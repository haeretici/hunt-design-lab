/**
 * SpawnManager — light spawn slots with activate / despawn / respawn lifecycle.
 *
 * Ports the useful parts of legacy on-demand spawning without binding
 * defs to tilemap cells:
 *   - slots stay data-only until activated (C_slots ≫ C_living)
 *   - on_demand: activate within Chebyshev SPAWN_ACTIVATE_RADIUS of observers
 *   - eager: activate every cooldown-ready slot
 *   - death or home-distance > SPAWN_DESPAWN_HOME_DIST frees the slot + cooldown
 *   - on_demand idle AOI unload (SPAWN_DESPAWN_IDLE_SEC): park idle far entities
 *     after hysteresis (other-floor observers count as far); never mid-combat /
 *     sticky / non-idle. Soft unload — same body (HP / conditions / tile) comes
 *     back next tick without the death respawn cooldown (floor hop must not
 *     blank nearby dens or heal them)
 *   - SPAWN_MAX_LIVING budget eviction is the same park (no death cooldown)
 *   - spawned flag prevents double-spawn while an entity is live
 *
 * Host injects spawn / despawn / getEntity so unit tests stay free of Simulator.
 * Optional park / unpark keep the parked body; missing park falls back to despawn.
 */

'use strict';

const { Settings } = require('../../settings.js');
const { tileDistance } = require('./movement.js');

/** Far-past initial lastSpawnTime so first spawn is immediately eligible. */
const INITIAL_LAST_SPAWN = -1e9;

/**
 * Stable unique key for a spawn slot.
 * @param {object} entry
 * @returns {string}
 */
function makeSpawnKey(entry) {
    if (!entry) return '';
    if (entry.id != null && entry.id !== '') return String(entry.id);
    if (entry.key != null && entry.key !== '') return String(entry.key);
    const z = entry.z !== undefined && entry.z !== null ? entry.z : 0;
    const cid = entry.creatureId || entry.id || entry.name || 'unknown';
    return `${cid}_${Math.round(entry.x)}_${Math.round(entry.y)}_${z}`;
}

/**
 * Normalize a hunt / legacy spawn row into manager entry fields.
 * @param {object} raw
 * @param {number} [index]
 * @returns {object|null}
 */
function normalizeSpawnEntry(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const creatureId = raw.creatureId || raw.id || raw.name;
    if (!creatureId && raw.x == null) return null;
    if (raw.x == null || raw.y == null) return null;
    const x = Math.round(Number(raw.x));
    const y = Math.round(Number(raw.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const z =
        raw.z !== undefined && raw.z !== null
            ? Number(raw.z)
            : 0;
    const respawnRaw =
        raw.respawn != null
            ? raw.respawn
            : raw.spawntime != null
              ? raw.spawntime
              : 0;
    const respawn = Math.max(0, Number(respawnRaw) || 0);
    const key = makeSpawnKey({
        id: raw.id || raw.key,
        creatureId: creatureId || `spawn_${index != null ? index : 0}`,
        x,
        y,
        z
    });
    return {
        key,
        creatureId: String(creatureId || key),
        x,
        y,
        z,
        respawn,
        template: raw.template || null,
        /** Original row for host spawnFromTable / telemetry. */
        entry: raw
    };
}

/**
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function sameFloor(a, b) {
    if (!a || !b) return false;
    return String(a.z) === String(b.z);
}

/**
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isEntityAlive(entity) {
    if (!entity) return false;
    if (entity.alive === false) return false;
    if (entity.hp && typeof entity.hp.current === 'number' && entity.hp.current <= 0) {
        return false;
    }
    return true;
}

/**
 * Position of a live entity (tile preferred).
 * @param {object} entity
 * @returns {{ x: number, y: number, z: * }|null}
 */
function entityPos(entity) {
    if (!entity) return null;
    if (entity.tile && entity.tile.x != null) {
        return {
            x: entity.tile.x,
            y: entity.tile.y,
            z: entity.tile.z
        };
    }
    if (entity.x != null && entity.y != null) {
        return { x: entity.x, y: entity.y, z: entity.z };
    }
    return null;
}

/**
 * True when a living entity must not idle-AOI or budget-despawn
 * (mid-combat, sticky target, leash / non-idle FSM).
 * @param {object|null|undefined} entity
 * @returns {boolean}
 */
function isEntityProtected(entity) {
    if (!entity) return false;
    if (entity.target || entity.targetId != null) return true;
    const state = entity.aiState;
    if (state && state !== 'idle') return true;
    return false;
}

/**
 * Keep-priority for soft-cap eviction (higher = keep). Protected = never evict.
 * @param {object} state
 * @param {object|null} entity
 * @param {{x,y,z}[]} observers
 * @returns {number}
 */
function livingKeepPriority(state, entity, observers) {
    if (isEntityProtected(entity)) return 1e12;
    let p = 0;
    const entry = state && state.entry;
    const rarity =
        (entry && (entry.rarity || (entry.affixes && entry.affixes.rarity))) ||
        '';
    if (rarity === 'boss') p += 10000;
    else if (rarity === 'elite') p += 5000;
    else if (rarity === 'champion') p += 2000;
    else if (rarity === 'rare') p += 500;

    const pos = entityPos(entity);
    if (pos && observers && observers.length) {
        let minD = Infinity;
        let nearCount = 0;
        for (let i = 0; i < observers.length; i++) {
            const o = observers[i];
            if (!o || o.x == null) continue;
            if (!sameFloor(pos, o)) continue;
            const d = tileDistance(pos, o);
            if (d < minD) minD = d;
            // Count observers roughly in a generous bubble for multi-player camps
            if (d <= 20) nearCount += 1;
        }
        if (Number.isFinite(minD)) {
            // Nearer to any observer → keep longer
            p += Math.max(0, 2000 - minD * 20);
            p += nearCount * 50;
        }
    }
    return p;
}

/**
 * Min Chebyshev distance to any same-floor observer, or Infinity if none.
 * @param {{x,y,z}|null} pos
 * @param {{x,y,z}[]} observers
 * @returns {number}
 */
function minDistToObservers(pos, observers) {
    if (!pos || !observers || !observers.length) return Infinity;
    let minD = Infinity;
    for (let i = 0; i < observers.length; i++) {
        const o = observers[i];
        if (!o || o.x == null) continue;
        if (!sameFloor(pos, o)) continue;
        const d = tileDistance(pos, o);
        if (d < minD) minD = d;
    }
    return minD;
}

class SpawnManager {
    /**
     * @param {{
     *   mode?: 'eager'|'on_demand',
     *   activateRadius?: number,
     *   despawnHomeDist?: number,
     *   despawnIdleRadius?: number|null,
     *   despawnIdleSec?: number,
     *   maxLiving?: number,
     *   spawnTimeMultiplier?: number,
     *   chunkSize?: number
     * }} [opts]
     */
    constructor(opts) {
        const o = opts || {};
        this.mode = o.mode != null ? o.mode : Settings.SPAWN_MODE || 'on_demand';
        this.activateRadius =
            o.activateRadius != null
                ? o.activateRadius
                : Settings.SPAWN_ACTIVATE_RADIUS != null
                  ? Settings.SPAWN_ACTIVATE_RADIUS
                  : 10;
        this.despawnHomeDist =
            o.despawnHomeDist != null
                ? o.despawnHomeDist
                : Settings.SPAWN_DESPAWN_HOME_DIST != null
                  ? Settings.SPAWN_DESPAWN_HOME_DIST
                  : 20;
        // null = fall back to activateRadius at query time
        this.despawnIdleRadius =
            o.despawnIdleRadius !== undefined
                ? o.despawnIdleRadius
                : Settings.SPAWN_DESPAWN_IDLE_RADIUS !== undefined
                  ? Settings.SPAWN_DESPAWN_IDLE_RADIUS
                  : null;
        this.despawnIdleSec =
            o.despawnIdleSec != null
                ? Math.max(0, Number(o.despawnIdleSec) || 0)
                : Settings.SPAWN_DESPAWN_IDLE_SEC != null
                  ? Math.max(0, Number(Settings.SPAWN_DESPAWN_IDLE_SEC) || 0)
                  : 0;
        this.maxLiving =
            o.maxLiving != null
                ? Math.max(0, o.maxLiving | 0)
                : Settings.SPAWN_MAX_LIVING != null
                  ? Math.max(0, Settings.SPAWN_MAX_LIVING | 0)
                  : 0;
        this.spawnTimeMultiplier =
            o.spawnTimeMultiplier != null
                ? o.spawnTimeMultiplier
                : Settings.SPAWN_TIME_MULTIPLIER != null
                  ? Settings.SPAWN_TIME_MULTIPLIER
                  : 1;
        this.chunkSize =
            o.chunkSize != null
                ? Math.max(1, o.chunkSize | 0)
                : Settings.SPAWN_CHUNK_SIZE != null
                  ? Math.max(1, Settings.SPAWN_CHUNK_SIZE | 0)
                  : 32;

        /** @type {object[]} runtime slot states */
        this._states = [];
        /** @type {Map<string, object>} */
        this._byKey = new Map();
        /** @type {Map<string, object[]>} */
        this._chunks = new Map();
        /** Cached living count (spawned flags). */
        this._livingCount = 0;
    }

    /** @returns {number} */
    get size() {
        return this._states.length;
    }

    /** @returns {number} slots currently marked spawned */
    get livingCount() {
        return this._livingCount;
    }

    /** @returns {object[]} shallow copy of slot states */
    listStates() {
        return this._states.slice();
    }

    /**
     * @param {string} key
     * @returns {object|undefined}
     */
    getState(key) {
        return this._byKey.get(String(key));
    }

    /** @returns {object[]} slots currently marked spawned */
    listSpawned() {
        return this._states.filter((s) => s.spawned);
    }

    /**
     * Effective idle-AOI despawn radius (activateRadius when unset).
     * @returns {number}
     */
    resolveDespawnIdleRadius() {
        if (this.despawnIdleRadius == null) return this.activateRadius;
        const n = Number(this.despawnIdleRadius);
        if (!Number.isFinite(n) || n < 0) return this.activateRadius;
        return n;
    }

    /**
     * Whether idle AOI despawn is active (on_demand + positive hysteresis).
     * @returns {boolean}
     */
    isIdleAoiDespawnEnabled() {
        return this.mode === 'on_demand' && this.despawnIdleSec > 0;
    }

    /**
     * Replace all slots from hunt / legacy rows.
     * @param {object[]} entries
     * @returns {number} loaded count
     */
    load(entries) {
        this.clear();
        if (!Array.isArray(entries)) return 0;
        for (let i = 0; i < entries.length; i++) {
            this.add(entries[i], i);
        }
        return this._states.length;
    }

    /**
     * Append one spawn slot. Duplicate spatial keys get a `#n` suffix so stacked
     * hunt-table rows (same creature/tile) still materialize separately.
     * @param {object} raw
     * @param {number} [index]
     * @returns {object|null} state or null if skipped
     */
    add(raw, index) {
        const norm = normalizeSpawnEntry(raw, index);
        if (!norm) return null;

        let key = norm.key;
        if (this._byKey.has(key)) {
            const base = key;
            let n = index != null ? index : this._states.length;
            key = `${base}#${n}`;
            let guard = 0;
            while (this._byKey.has(key) && guard < 10000) {
                guard += 1;
                key = `${base}#${n}_${guard}`;
            }
        }

        const state = {
            key,
            creatureId: norm.creatureId,
            x: norm.x,
            y: norm.y,
            z: norm.z,
            respawn: norm.respawn,
            template: norm.template,
            entry: norm.entry,
            spawned: false,
            /** When true, slot will never activate again (respawn <= 0 after free). */
            exhausted: false,
            lastSpawnTime: INITIAL_LAST_SPAWN,
            entityId: null,
            /** Parked living body from idle_aoi / budget; restored on re-activate. */
            parkedEntity: null,
            /**
             * Sim time when the entity first became idle+far from all observers.
             * null while near / protected / not spawned.
             * @type {number|null}
             */
            idleAwaySince: null
        };
        this._states.push(state);
        this._byKey.set(state.key, state);
        this._indexChunk(state);
        return state;
    }

    clear() {
        this._states.length = 0;
        this._byKey.clear();
        this._chunks.clear();
        this._livingCount = 0;
    }

    /**
     * Cooldown remaining before a free slot may spawn again (seconds).
     * Uses strict `time > last + need` (legacy) so a free slot cannot
     * re-spawn on the same timestamp it was freed.
     * @param {object} state
     * @param {number} time
     * @returns {number}
     */
    cooldownRemaining(state, time) {
        if (!state || state.spawned || state.exhausted) return Infinity;
        const need = (state.respawn || 0) * this.spawnTimeMultiplier;
        const readyAt = (state.lastSpawnTime || 0) + need;
        if (time > readyAt) return 0;
        return readyAt - time;
    }

    /**
     * Whether a free slot is past its respawn cooldown.
     * @param {object} state
     * @param {number} time
     * @returns {boolean}
     */
    isCooldownReady(state, time) {
        if (!state || state.spawned || state.exhausted) return false;
        const need = (state.respawn || 0) * this.spawnTimeMultiplier;
        return time > (state.lastSpawnTime || 0) + need;
    }

    /**
     * Main lifecycle step.
     *
     * @param {{
     *   time: number,
     *   observers?: { x: number, y: number, z?: * }[],
     *   getEntity: (id: *) => object|null|undefined,
     *   spawn: (state: object) => object|null|undefined,
     *   despawn?: (entity: object, state: object, reason: string) => void,
     *   isProtected?: (entity: object) => boolean
     * }} ctx
     * @returns {{
     *   spawned: object[],
     *   despawned: object[],
     *   freed: object[],
     *   idleDespawned: object[],
     *   budgetEvicted: object[],
     *   skippedBudget: number,
     *   living: number
     * }}
     */
    tick(ctx) {
        const out = {
            spawned: [],
            despawned: [],
            freed: [],
            idleDespawned: [],
            budgetEvicted: [],
            skippedBudget: 0,
            living: 0
        };
        if (!ctx || typeof ctx.getEntity !== 'function' || typeof ctx.spawn !== 'function') {
            return out;
        }
        const time = ctx.time != null ? Number(ctx.time) : 0;
        const observers = Array.isArray(ctx.observers) ? ctx.observers : [];
        const isProt =
            typeof ctx.isProtected === 'function'
                ? ctx.isProtected
                : isEntityProtected;

        // 1) Reconcile live entities: death / missing / home / idle AOI
        for (let i = 0; i < this._states.length; i++) {
            const state = this._states[i];
            if (!state.spawned) continue;

            const entity =
                state.entityId != null ? ctx.getEntity(state.entityId) : null;
            if (!isEntityAlive(entity)) {
                this._freeSlot(state, time, 'death');
                out.freed.push(state);
                continue;
            }

            const homeDespawn =
                this.despawnHomeDist != null && this.despawnHomeDist > 0;
            if (homeDespawn) {
                const pos = entityPos(entity);
                const home = { x: state.x, y: state.y, z: state.z };
                if (
                    pos &&
                    sameFloor(pos, home) &&
                    tileDistance(pos, home) > this.despawnHomeDist
                ) {
                    this._releaseLiving(
                        state,
                        entity,
                        ctx,
                        time,
                        'home_distance',
                        out
                    );
                    continue;
                } else if (pos && !sameFloor(pos, home)) {
                    // Different floor: treat as beyond home (legacy z-local).
                    this._releaseLiving(
                        state,
                        entity,
                        ctx,
                        time,
                        'home_floor',
                        out
                    );
                    continue;
                }
            }

            // Idle AOI unload (on_demand only): hysteresis while far + idle
            if (this.isIdleAoiDespawnEnabled()) {
                if (this._tickIdleAoi(state, entity, observers, time, isProt)) {
                    this._releaseLiving(
                        state,
                        entity,
                        ctx,
                        time,
                        'idle_aoi',
                        out
                    );
                    continue;
                }
            } else {
                state.idleAwaySince = null;
            }
        }

        // 1b) Soft-cap: if already over maxLiving, evict lowest-priority idle
        if (this.maxLiving > 0) {
            while (this._livingCount > this.maxLiving) {
                const victim = this._pickBudgetVictim(ctx, observers, isProt);
                if (!victim) break;
                const entity =
                    victim.entityId != null
                        ? ctx.getEntity(victim.entityId)
                        : null;
                this._releaseLiving(victim, entity, ctx, time, 'budget', out);
            }
        }

        // 2) Activate free, cooldown-ready slots (stable key order when capped)
        const candidates =
            this.mode === 'eager'
                ? this._states
                : this._candidatesNearObservers(observers);

        // Deterministic activate order under soft cap: nearer slots first
        if (this.maxLiving > 0 && this.mode !== 'eager' && candidates.length > 1) {
            candidates.sort((a, b) => {
                const da = minDistToObservers(
                    { x: a.x, y: a.y, z: a.z },
                    observers
                );
                const db = minDistToObservers(
                    { x: b.x, y: b.y, z: b.z },
                    observers
                );
                if (da !== db) return da - db;
                if (a.key < b.key) return -1;
                if (a.key > b.key) return 1;
                return 0;
            });
        }

        const seen = new Set();
        for (let i = 0; i < candidates.length; i++) {
            const state = candidates[i];
            if (!state || seen.has(state.key)) continue;
            seen.add(state.key);
            if (state.spawned) continue;
            if (!this.isCooldownReady(state, time)) continue;

            if (this.mode !== 'eager' && !this._isNearAnyObserver(state, observers)) {
                continue;
            }

            if (this.maxLiving > 0 && this._livingCount >= this.maxLiving) {
                // Try one eviction of a lower-priority living idle so this slot can enter
                const victim = this._pickBudgetVictim(ctx, observers, isProt, state);
                if (!victim) {
                    out.skippedBudget += 1;
                    continue;
                }
                const vent =
                    victim.entityId != null
                        ? ctx.getEntity(victim.entityId)
                        : null;
                this._releaseLiving(victim, vent, ctx, time, 'budget', out);
            }

            const entity = this._materialize(ctx, state);
            if (!entity || entity.id == null) {
                // Host refused (blocked tile, missing template) — retry later.
                continue;
            }
            // Guard against host creating a second body while we think free:
            // only accept if still unspawned after spawn() side effects.
            if (state.spawned) continue;

            state.spawned = true;
            state.entityId = entity.id;
            state.parkedEntity = null;
            state.lastSpawnTime = time;
            state.idleAwaySince = null;
            this._livingCount += 1;
            out.spawned.push(state);
        }

        out.living = this._livingCount;
        return out;
    }

    /**
     * Host-side death hook when entity leaves sim outside tick reconciliation.
     * @param {*} entityId
     * @param {number} time
     * @returns {object|null} freed state
     */
    notifyEntityGone(entityId, time) {
        if (entityId == null) return null;
        for (let i = 0; i < this._states.length; i++) {
            const state = this._states[i];
            if (state.spawned && state.entityId === entityId) {
                this._freeSlot(state, time != null ? time : 0, 'death');
                return state;
            }
        }
        return null;
    }

    // --- internals -------------------------------------------------------

    /**
     * Soft free (idle_aoi / budget): park the body and re-activate next tick
     * without death cooldown. Home free: destroy + wait `respawn`. Death:
     * cooldown / exhaust one-shots.
     *
     * @param {object} state
     * @param {number} time
     * @param {string} [reason]
     * @private
     */
    _freeSlot(state, time, reason) {
        if (state.spawned) {
            this._livingCount = Math.max(0, this._livingCount - 1);
        }
        state.spawned = false;
        state.entityId = null;
        state.idleAwaySince = null;
        const skipDeathCooldown = reason === 'idle_aoi' || reason === 'budget';
        if (!skipDeathCooldown) {
            state.parkedEntity = null;
        }
        const soft =
            reason === 'idle_aoi' ||
            reason === 'budget' ||
            reason === 'home_distance' ||
            reason === 'home_floor';
        if (skipDeathCooldown) {
            const need = (state.respawn || 0) * this.spawnTimeMultiplier;
            // Same-tick activate cannot re-fire: time > (time - need) + need is false.
            // Next tick (time advances) with observers in range is immediately ready.
            state.lastSpawnTime = time - need;
        } else {
            state.lastSpawnTime = time;
        }
        if (soft) {
            state.exhausted = false;
            return;
        }
        // Death / missing: one-shot slots never return.
        if ((state.respawn || 0) <= 0) {
            state.exhausted = true;
        }
    }

    /**
     * Idle/budget: park when the host supports it (keep HP). Otherwise despawn.
     * Home / death: always destroy.
     *
     * @param {object} state
     * @param {object|null} entity
     * @param {object} ctx
     * @param {number} time
     * @param {string} reason
     * @param {object} out
     * @private
     */
    _releaseLiving(state, entity, ctx, time, reason, out) {
        const park =
            (reason === 'idle_aoi' || reason === 'budget') &&
            entity &&
            typeof ctx.park === 'function';
        if (park) {
            state.parkedEntity = entity;
        } else {
            state.parkedEntity = null;
        }
        this._freeSlot(state, time, reason);
        if (park) {
            ctx.park(entity, state, reason);
        } else if (entity && typeof ctx.despawn === 'function') {
            ctx.despawn(entity, state, reason);
        }
        if (out) {
            out.despawned.push(state);
            if (reason === 'idle_aoi') out.idleDespawned.push(state);
            if (reason === 'budget') out.budgetEvicted.push(state);
        }
    }

    /**
     * Restore a parked body, or spawn a fresh one.
     * @param {object} ctx
     * @param {object} state
     * @returns {object|null}
     * @private
     */
    _materialize(ctx, state) {
        if (state.parkedEntity) {
            if (typeof ctx.unpark === 'function') {
                return ctx.unpark(state);
            }
            state.parkedEntity = null;
        }
        return ctx.spawn(state);
    }

    /**
     * Advance idle-AOI timer. Returns true when entity should despawn now.
     * @param {object} state
     * @param {object} entity
     * @param {{x,y,z}[]} observers
     * @param {number} time
     * @param {(e: object) => boolean} isProt
     * @returns {boolean}
     * @private
     */
    _tickIdleAoi(state, entity, observers, time, isProt) {
        if (isProt(entity)) {
            state.idleAwaySince = null;
            return false;
        }
        const radius = this.resolveDespawnIdleRadius();
        const pos = entityPos(entity);
        const near =
            pos &&
            observers.length > 0 &&
            minDistToObservers(pos, observers) <= radius;
        if (near) {
            state.idleAwaySince = null;
            return false;
        }
        // No observers / far: start or continue away timer
        if (state.idleAwaySince == null) {
            state.idleAwaySince = time;
            return false;
        }
        return time - state.idleAwaySince >= this.despawnIdleSec;
    }

    /**
     * Lowest keep-priority non-protected living slot (farthest idle preferred).
     * When `incoming` is set, only return a victim with strictly lower priority
     * than the candidate slot (so soft-cap swaps make sense).
     *
     * @param {object} ctx
     * @param {{x,y,z}[]} observers
     * @param {(e: object) => boolean} isProt
     * @param {object} [incoming] candidate slot wanting to spawn
     * @returns {object|null}
     * @private
     */
    _pickBudgetVictim(ctx, observers, isProt, incoming) {
        let best = null;
        let bestPri = Infinity;
        let bestKey = '';
        const incomingPri = incoming
            ? livingKeepPriority(
                  incoming,
                  // Fake "near home" entity for slot priority when no body yet
                  {
                      tile: { x: incoming.x, y: incoming.y, z: incoming.z },
                      aiState: 'idle'
                  },
                  observers
              )
            : Infinity;

        for (let i = 0; i < this._states.length; i++) {
            const state = this._states[i];
            if (!state.spawned) continue;
            const entity =
                state.entityId != null ? ctx.getEntity(state.entityId) : null;
            if (!isEntityAlive(entity)) continue;
            if (isProt(entity)) continue;
            const pri = livingKeepPriority(state, entity, observers);
            if (incoming && pri >= incomingPri) continue;
            if (
                pri < bestPri ||
                (pri === bestPri && state.key < bestKey)
            ) {
                bestPri = pri;
                bestKey = state.key;
                best = state;
            }
        }
        return best;
    }

    /**
     * @param {object} state
     * @private
     */
    _indexChunk(state) {
        const ck = this._chunkKey(state.x, state.y, state.z);
        let bucket = this._chunks.get(ck);
        if (!bucket) {
            bucket = [];
            this._chunks.set(ck, bucket);
        }
        bucket.push(state);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {*} z
     * @returns {string}
     * @private
     */
    _chunkKey(x, y, z) {
        const cs = this.chunkSize;
        const cx = Math.floor(x / cs);
        const cy = Math.floor(y / cs);
        return `${z}:${cx}:${cy}`;
    }

    /**
     * @param {object} state
     * @param {{x,y,z}[]} observers
     * @returns {boolean}
     * @private
     */
    _isNearAnyObserver(state, observers) {
        const r = this.activateRadius;
        for (let i = 0; i < observers.length; i++) {
            const o = observers[i];
            if (!o) continue;
            if (!sameFloor(state, o)) continue;
            if (tileDistance(state, o) <= r) return true;
        }
        return false;
    }

    /**
     * Collect unique free slots in chunks overlapping observer radii.
     * @param {{x,y,z}[]} observers
     * @returns {object[]}
     * @private
     */
    _candidatesNearObservers(observers) {
        if (!observers.length) return [];
        const r = this.activateRadius;
        const cs = this.chunkSize;
        const out = [];
        const seen = new Set();

        for (let i = 0; i < observers.length; i++) {
            const o = observers[i];
            if (!o || o.x == null || o.y == null) continue;
            const z = o.z !== undefined && o.z !== null ? o.z : 0;
            const minCx = Math.floor((o.x - r) / cs);
            const maxCx = Math.floor((o.x + r) / cs);
            const minCy = Math.floor((o.y - r) / cs);
            const maxCy = Math.floor((o.y + r) / cs);
            for (let cx = minCx; cx <= maxCx; cx++) {
                for (let cy = minCy; cy <= maxCy; cy++) {
                    const bucket = this._chunks.get(`${z}:${cx}:${cy}`);
                    if (!bucket) continue;
                    for (let j = 0; j < bucket.length; j++) {
                        const s = bucket[j];
                        if (seen.has(s.key)) continue;
                        seen.add(s.key);
                        out.push(s);
                    }
                }
            }
        }
        return out;
    }
}

module.exports = {
    SpawnManager,
    makeSpawnKey,
    normalizeSpawnEntry,
    isEntityProtected,
    livingKeepPriority,
    minDistToObservers,
    INITIAL_LAST_SPAWN
};
