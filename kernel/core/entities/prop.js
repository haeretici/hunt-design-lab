/**
 * Interactive map prop (Stage 11.2 gizmo / "clicky").
 * Thin entity: break / loot / heal → telemetry; optional tile occupancy.
 * Not a combat AI target.
 */

'use strict';

const { GameObject } = require('./gameobject.js');

class Prop extends GameObject {
    /**
     * @param {object} [opts]
     * @param {string} [opts.name]
     * @param {number} [opts.id]
     * @param {string} [opts.objectId]
     * @param {string} [opts.markerId]
     * @param {'break'|'loot'|'heal'|'well'|string} [opts.effect]
     * @param {number} [opts.lootValue]
     * @param {number} [opts.healAmount]
     * @param {boolean} [opts.blocking]
     * @param {string|null} [opts.pacingTag]
     * @param {{ x: number, y: number, z?: string|number }} [opts.tile]
     */
    constructor(opts = {}) {
        super(opts.name || opts.objectId || 'Prop');
        this.type = 'prop';
        const rawId = opts.id != null ? opts.id | 0 : 0;
        this.id = rawId > 0 ? rawId : 0;

        this.objectId = opts.objectId != null ? String(opts.objectId) : 'barrel';
        this.markerId = opts.markerId != null ? String(opts.markerId) : null;
        this.effect =
            opts.effect != null ? String(opts.effect).toLowerCase() : 'break';
        this.lootValue =
            opts.lootValue != null ? Math.max(0, Number(opts.lootValue) || 0) : 0;
        this.healAmount =
            opts.healAmount != null
                ? Math.max(0, Number(opts.healAmount) || 0)
                : 0;
        this.blocking = opts.blocking === true;
        this.pacingTag =
            opts.pacingTag != null
                ? String(opts.pacingTag)
                : this.effect === 'well'
                  ? 'well'
                  : this.effect;

        this.alive = true;
        this.used = false;

        /** @type {{ x: number, y: number, z: string|number }|null} */
        this.tile = null;
        if (opts.tile) {
            this.tile = {
                x: Math.round(opts.tile.x),
                y: Math.round(opts.tile.y),
                z: opts.tile.z !== undefined ? opts.tile.z : 0
            };
            this.x = this.tile.x;
            this.y = this.tile.y;
            this.z = this.tile.z;
        }

        /** @type {object|null} source table row */
        this._propEntry = null;
    }

    syncPositionFromTile() {
        if (!this.tile) return;
        this.x = this.tile.x;
        this.y = this.tile.y;
        this.z = this.tile.z;
    }
}

module.exports = { Prop };
