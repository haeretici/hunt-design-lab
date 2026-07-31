/**
 * Generic tile-space chunk index (entity id + x,y,z).
 *
 * Same pattern as SpawnManager's on_demand grid: bucket entities by
 * `${z}:${floor(x/cs)}:${floor(y/cs)}` so proximity queries scan local
 * chunks instead of the full entity list.
 *
 * Query helpers return candidates from overlapping chunks; callers refine
 * with exact Chebyshev distance when needed. Iteration is deterministic
 * (sorted by numeric/string id).
 */

'use strict';

/**
 * @param {*} id
 * @returns {string}
 */
function idKey(id) {
    return String(id);
}

/**
 * Stable sort: numeric ids ascending, else string compare.
 * @param {*} a
 * @param {*} b
 * @returns {number}
 */
function compareIds(a, b) {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && String(a) === String(na) && String(b) === String(nb)) {
        return na - nb;
    }
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Read x,y,z from entity.tile or bare position fields.
 * @param {object} entity
 * @returns {{ x: number, y: number, z: * }|null}
 */
function entityPos(entity) {
    if (!entity) return null;
    if (entity.tile && entity.tile.x != null && entity.tile.y != null) {
        return {
            x: entity.tile.x,
            y: entity.tile.y,
            z: entity.tile.z !== undefined && entity.tile.z !== null ? entity.tile.z : 0
        };
    }
    if (entity.x != null && entity.y != null) {
        return {
            x: entity.x,
            y: entity.y,
            z: entity.z !== undefined && entity.z !== null ? entity.z : 0
        };
    }
    return null;
}

class SpatialIndex {
    /**
     * @param {{ chunkSize?: number }} [opts]
     */
    constructor(opts) {
        const o = opts || {};
        this.chunkSize = Math.max(1, o.chunkSize != null ? o.chunkSize | 0 : 32);
        /** @type {Map<string, Map<string, object>>} chunkKey → idKey → entity */
        this._chunks = new Map();
        /** @type {Map<string, { entity: object, key: string, x: number, y: number, z: * }>} */
        this._byId = new Map();
    }

    /** @returns {number} */
    get size() {
        return this._byId.size;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {*} z
     * @returns {string}
     */
    chunkKey(x, y, z) {
        const cs = this.chunkSize;
        const cx = Math.floor(Number(x) / cs);
        const cy = Math.floor(Number(y) / cs);
        return `${z}:${cx}:${cy}`;
    }

    clear() {
        this._chunks.clear();
        this._byId.clear();
    }

    /**
     * Insert or replace entity at its current tile.
     * @param {object} entity must have id + tile (or x,y,z)
     * @returns {boolean}
     */
    insert(entity) {
        if (!entity || entity.id == null) return false;
        const pos = entityPos(entity);
        if (!pos) return false;
        const ik = idKey(entity.id);
        if (this._byId.has(ik)) {
            this.remove(entity.id);
        }
        const key = this.chunkKey(pos.x, pos.y, pos.z);
        let bucket = this._chunks.get(key);
        if (!bucket) {
            bucket = new Map();
            this._chunks.set(key, bucket);
        }
        bucket.set(ik, entity);
        this._byId.set(ik, {
            entity,
            key,
            x: pos.x,
            y: pos.y,
            z: pos.z
        });
        return true;
    }

    /**
     * @param {object|*} entityOrId
     * @returns {boolean}
     */
    remove(entityOrId) {
        const id =
            entityOrId != null && typeof entityOrId === 'object'
                ? entityOrId.id
                : entityOrId;
        if (id == null) return false;
        const ik = idKey(id);
        const rec = this._byId.get(ik);
        if (!rec) return false;
        const bucket = this._chunks.get(rec.key);
        if (bucket) {
            bucket.delete(ik);
            if (bucket.size === 0) this._chunks.delete(rec.key);
        }
        this._byId.delete(ik);
        return true;
    }

    /**
     * Rebucket after entity.tile changed. No-op if still same chunk.
     * Inserts if missing.
     * @param {object} entity
     * @param {{ x: number, y: number, z?: * }|null} [prevPos] optional previous tile
     * @returns {boolean}
     */
    update(entity, prevPos) {
        if (!entity || entity.id == null) return false;
        const pos = entityPos(entity);
        if (!pos) {
            return this.remove(entity.id);
        }
        const ik = idKey(entity.id);
        const rec = this._byId.get(ik);
        if (!rec) return this.insert(entity);

        const nextKey = this.chunkKey(pos.x, pos.y, pos.z);
        if (rec.key === nextKey) {
            rec.x = pos.x;
            rec.y = pos.y;
            rec.z = pos.z;
            rec.entity = entity;
            return true;
        }

        const oldBucket = this._chunks.get(rec.key);
        if (oldBucket) {
            oldBucket.delete(ik);
            if (oldBucket.size === 0) this._chunks.delete(rec.key);
        }
        let bucket = this._chunks.get(nextKey);
        if (!bucket) {
            bucket = new Map();
            this._chunks.set(nextKey, bucket);
        }
        bucket.set(ik, entity);
        rec.key = nextKey;
        rec.x = pos.x;
        rec.y = pos.y;
        rec.z = pos.z;
        rec.entity = entity;
        return true;
    }

    /**
     * @param {*} id
     * @returns {object|null}
     */
    get(id) {
        if (id == null) return null;
        const rec = this._byId.get(idKey(id));
        return rec ? rec.entity : null;
    }

    /**
     * @param {*} id
     * @returns {boolean}
     */
    has(id) {
        if (id == null) return false;
        return this._byId.has(idKey(id));
    }

    /**
     * Replace contents from an entity list (skips entries without id/tile).
     * @param {object[]} entities
     * @returns {number} indexed count
     */
    rebuild(entities) {
        this.clear();
        if (!Array.isArray(entities)) return 0;
        let n = 0;
        for (let i = 0; i < entities.length; i++) {
            if (this.insert(entities[i])) n += 1;
        }
        return n;
    }

    /**
     * Entities in chunks that intersect the Chebyshev square around (x,y) on z.
     * Does not apply exact radius — caller refines (or use queryChebyshev).
     * @param {number} x
     * @param {number} y
     * @param {*} z
     * @param {number} radius
     * @returns {object[]} sorted by id
     */
    queryChunkCandidates(x, y, z, radius) {
        const r = Math.max(0, Number(radius) || 0);
        const cs = this.chunkSize;
        const zx = z !== undefined && z !== null ? z : 0;
        const minCx = Math.floor((Number(x) - r) / cs);
        const maxCx = Math.floor((Number(x) + r) / cs);
        const minCy = Math.floor((Number(y) - r) / cs);
        const maxCy = Math.floor((Number(y) + r) / cs);
        /** @type {object[]} */
        const out = [];
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const bucket = this._chunks.get(`${zx}:${cx}:${cy}`);
                if (!bucket) continue;
                for (const entity of bucket.values()) {
                    out.push(entity);
                }
            }
        }
        out.sort((a, b) => compareIds(a && a.id, b && b.id));
        return out;
    }

    /**
     * Union of chunk candidates near any observer (same-z squares).
     * Deduped and sorted by id. Does **not** apply exact radius — use
     * queryNearObserversExact for the refined living set.
     *
     * @param {{ tile?: {x,y,z}, x?: number, y?: number, z?: * }[]} observers
     * @param {number} radius
     * @returns {object[]}
     */
    queryNearObservers(observers, radius) {
        if (!observers || !observers.length) return [];
        const r = Math.max(0, Number(radius) || 0);
        const cs = this.chunkSize;
        /** @type {Map<string, object>} */
        const seen = new Map();

        for (let i = 0; i < observers.length; i++) {
            const o = observers[i];
            if (!o) continue;
            const pos = entityPos(o);
            if (!pos) continue;
            const zx = pos.z;
            const minCx = Math.floor((pos.x - r) / cs);
            const maxCx = Math.floor((pos.x + r) / cs);
            const minCy = Math.floor((pos.y - r) / cs);
            const maxCy = Math.floor((pos.y + r) / cs);
            for (let cx = minCx; cx <= maxCx; cx++) {
                for (let cy = minCy; cy <= maxCy; cy++) {
                    const bucket = this._chunks.get(`${zx}:${cx}:${cy}`);
                    if (!bucket) continue;
                    for (const [ik, entity] of bucket) {
                        if (!seen.has(ik)) seen.set(ik, entity);
                    }
                }
            }
        }

        const out = Array.from(seen.values());
        out.sort((a, b) => compareIds(a && a.id, b && b.id));
        return out;
    }

    /**
     * Living-ish entities within exact Chebyshev radius of (x,y) on z.
     * Chunk gather + exact refine. Order stable (id-sorted).
     *
     * @param {number} x
     * @param {number} y
     * @param {*} z
     * @param {number} radius
     * @param {{
     *   livingOnly?: boolean,
     *   filter?: (e: object) => boolean,
     *   includeOrigin?: boolean
     * }} [opts]
     * @returns {object[]}
     */
    queryChebyshev(x, y, z, radius, opts) {
        const o = opts || {};
        const r = Math.max(0, Number(radius) || 0);
        const ox = Number(x);
        const oy = Number(y);
        const zx = z !== undefined && z !== null ? z : 0;
        const candidates = this.queryChunkCandidates(ox, oy, zx, r);
        /** @type {object[]} */
        const out = [];
        for (let i = 0; i < candidates.length; i++) {
            const e = candidates[i];
            if (!e) continue;
            if (o.livingOnly !== false) {
                if (e.alive === false) continue;
                if (e.hp && e.hp.current <= 0) continue;
            }
            if (o.filter && !o.filter(e)) continue;
            const pos = entityPos(e);
            if (!pos) continue;
            if (String(pos.z) !== String(zx)) continue;
            const d = Math.max(
                Math.abs(pos.x - ox),
                Math.abs(pos.y - oy)
            );
            if (d > r) continue;
            if (d === 0 && o.includeOrigin === false) continue;
            out.push(e);
        }
        return out;
    }

    /**
     * Exact Chebyshev around an entity (reads tile / x,y,z).
     * @param {object} origin
     * @param {number} radius
     * @param {{ livingOnly?: boolean, filter?: (e: object) => boolean, includeOrigin?: boolean }} [opts]
     * @returns {object[]}
     */
    queryAround(origin, radius, opts) {
        const pos = entityPos(origin);
        if (!pos) return [];
        return this.queryChebyshev(pos.x, pos.y, pos.z, radius, opts);
    }

    /**
     * Living entities within exact Chebyshev of any observer (same floor).
     * Deduped and sorted by id. Hot path for hunt AI enemy / sleep AOI.
     *
     * @param {{ tile?: {x,y,z}, x?: number, y?: number, z?: * }[]} observers
     * @param {number} radius
     * @param {{
     *   livingOnly?: boolean,
     *   filter?: (e: object) => boolean
     * }} [opts]
     * @returns {object[]}
     */
    queryNearObserversExact(observers, radius, opts) {
        if (!observers || !observers.length) return [];
        const o = opts || {};
        const r = Math.max(0, Number(radius) || 0);
        const candidates = this.queryNearObservers(observers, r);
        /** @type {object[]} */
        const out = [];
        for (let i = 0; i < candidates.length; i++) {
            const e = candidates[i];
            if (!e) continue;
            if (o.livingOnly !== false) {
                if (e.alive === false) continue;
                if (e.hp && e.hp.current <= 0) continue;
            }
            if (o.filter && !o.filter(e)) continue;
            const pos = entityPos(e);
            if (!pos) continue;
            let near = false;
            for (let j = 0; j < observers.length; j++) {
                const obs = observers[j];
                if (!obs) continue;
                const op = entityPos(obs);
                if (!op) continue;
                if (String(op.z) !== String(pos.z)) continue;
                const d = Math.max(
                    Math.abs(pos.x - op.x),
                    Math.abs(pos.y - op.y)
                );
                if (d <= r) {
                    near = true;
                    break;
                }
            }
            if (near) out.push(e);
        }
        return out;
    }

    /**
     * Debug / telemetry snapshot.
     * @returns {{ size: number, chunks: number, chunkSize: number }}
     */
    stats() {
        return {
            size: this._byId.size,
            chunks: this._chunks.size,
            chunkSize: this.chunkSize
        };
    }
}

module.exports = {
    SpatialIndex,
    entityPos,
    compareIds,
    idKey
};
