/**
 * Floating combat text (damage / miss / heal numbers) for watch mode.
 * Push via simulator.emitCombatText or sampleAttack hook — never in headless.
 */

'use strict';

const { Script } = require('./script.js');
const { Settings } = require('../../settings.js');
const { Time } = require('../lib/time.js');

/**
 * @typedef {{ x: number, y: number, z?: string|number|null, text: string, color: string, age: number, life: number, pixelSpace?: boolean }} FctEntry
 */

class FloatingCombatTextScript extends Script {
    constructor() {
        super();
        /** @type {FctEntry[]} */
        this.entries = [];
        this.maxEntries = 48;
    }

    /**
     * @param {object} opts
     * @param {number} opts.x tile x (or pixel if pixelSpace)
     * @param {number} opts.y tile y
     * @param {string|number} [opts.z] floor (omit = draw on any floor)
     * @param {string} opts.text
     * @param {string} [opts.color]
     * @param {number} [opts.life] seconds
     * @param {boolean} [opts.pixelSpace]
     */
    push(opts) {
        if (Settings.HEADLESS || !opts) return;
        const o = opts;
        /** @type {FctEntry} */
        const entry = {
            x: o.x,
            y: o.y,
            text: String(o.text != null ? o.text : ''),
            color: o.color || '#ffffff',
            age: 0,
            life: o.life != null ? o.life : 0.9,
            pixelSpace: !!o.pixelSpace
        };
        if (o.z !== undefined && o.z !== null) entry.z = o.z;
        this.entries.push(entry);
        while (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
    }

    update() {
        if (Settings.HEADLESS) {
            this.entries.length = 0;
            return;
        }
        const dt = Time.deltaTime || 0;
        for (let i = this.entries.length - 1; i >= 0; i--) {
            this.entries[i].age += dt;
            if (this.entries[i].age >= this.entries[i].life) {
                this.entries.splice(i, 1);
            }
        }
    }

    onGUI(g) {
        if (Settings.HEADLESS || !g || !this.entries.length) return;
        const sim = this.level || this.parent;
        const tw = Settings.tileWidth || 32;
        const th = Settings.tileHeight || 32;
        const ox = (sim && sim.tileMap && sim.tileMap._viewOriginX) || 0;
        const oy = (sim && sim.tileMap && sim.tileMap._viewOriginY) || 0;
        const viewZ =
            sim && sim.tileMap && sim.tileMap._viewZ != null
                ? String(sim.tileMap._viewZ)
                : Settings.cameraTileZ != null
                  ? String(Settings.cameraTileZ)
                  : null;

        g.font = 'bold 11px monospace';
        g.textAlign = 'center';
        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            if (
                viewZ != null &&
                e.z !== undefined &&
                e.z !== null &&
                String(e.z) !== viewZ
            ) {
                continue;
            }
            const t = e.life > 0 ? e.age / e.life : 1;
            const rise = Math.floor(t * 18);
            let px;
            let py;
            if (e.pixelSpace) {
                px = e.x;
                py = e.y - rise;
            } else {
                px = (e.x - ox) * tw + tw / 2;
                py = (e.y - oy) * th - rise;
            }
            g.globalAlpha = Math.max(0, 1 - t);
            g.fillStyle = e.color;
            g.fillText(e.text, px, py);
            g.globalAlpha = 1;
        }
        g.textAlign = 'left';
    }
}

module.exports = { FloatingCombatTextScript };
