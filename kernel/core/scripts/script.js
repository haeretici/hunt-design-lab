/**
 * ECS-lite script base (soccer-oss pattern).
 * Attach via GameObject.insertScript(script). update/render/onGUI cascade
 * with the parent; pure logic stays on entities / lib modules.
 */

'use strict';

class Script {
    constructor() {
        this.parent = null;
        this.level = null;
        this.destroyFlag = false;
    }

    start() {}

    async update() {}

    /**
     * World-space draw (under camera translate).
     * @param {CanvasRenderingContext2D|object} _g
     */
    render(_g) {}

    /**
     * Overlay draw (same transform as entity onGUI).
     * @param {CanvasRenderingContext2D|object} _g
     */
    onGUI(_g) {}

    destroy() {
        if (!this.parent || !this.parent.scripts) {
            this.destroyFlag = true;
            return;
        }
        this.destroyFlag = true;
        const index = this.parent.scripts.indexOf(this);
        if (index !== -1) {
            this.parent.scripts.splice(index, 1);
        }
    }

    async onMessage(_message) {}
}

module.exports = { Script };
