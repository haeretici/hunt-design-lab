/**
 * Scene-graph node (ECS-lite). Children + scripts tick/render with the parent.
 * Ported from soccer-js patterns; no soccer domain fields.
 */

const Orientation = {
    UP: 0,
    UP_RIGHT: 1,
    RIGHT: 2,
    DOWN_RIGHT: 3,
    DOWN: 4,
    DOWN_LEFT: 5,
    LEFT: 6,
    UP_LEFT: 7
};

class GameObject {
    constructor(name) {
        this.children = [];
        this.scripts = [];
        this.active = true;
        this.parent = null;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.orientation = Orientation.RIGHT;
        this.name = typeof name !== 'undefined' ? name : 'GameObject';
        this.globalX = 0;
        this.globalY = 0;
    }

    destroy() {
        this.active = false;
        if (this.parent == null) return;
        this.destroyFlag = true;
        for (let i = 0; i < this.parent.children.length; i++) {
            if (this.parent.children[i].destroyFlag) {
                this.parent.children.splice(i, 1);
                break;
            }
        }
    }

    start() {}

    insertScript(script) {
        script.parent = this;
        script.level = this.getRoot();
        script.start();
        this.scripts.push(script);
    }

    insertChild(child) {
        child.parent = this;
        child.updateGlobalPos();
        child.start();
        this.children.push(child);
    }

    async onMessage(_message) {}

    async sendMessage(message, receiver) {
        await receiver.onMessage(message);
    }

    async broadcastMessage(message) {
        await this.onMessage(message);
        for (let i = 0; i < this.scripts.length; i++) {
            await this.scripts[i].onMessage(message);
        }
        for (let i = 0; i < this.children.length; i++) {
            await this.children[i].broadcastMessage(message);
        }
    }

    getRoot() {
        if (this.parent != null) {
            return this.parent.getRoot();
        }
        return this;
    }

    update() {}

    updateGlobalPos() {
        this.globalX = this.x;
        this.globalY = this.y;
        let parent = this.parent;
        while (parent) {
            this.globalX += parent.x;
            this.globalY += parent.y;
            parent = parent.parent;
        }
    }

    updateAll() {
        if (!this.active) return;
        this.updateGlobalPos();
        this.update();
        for (let i = 0; i < this.scripts.length; i++) {
            this.scripts[i].update();
        }
        for (let i = 0; i < this.children.length; i++) {
            this.children[i].updateAll();
        }
    }

    render(_g) {}

    renderAll(g) {
        if (!this.active) return;
        this.render(g);
        for (let i = 0; i < this.children.length; i++) {
            this.children[i].renderAll(g);
        }
        for (let i = 0; i < this.scripts.length; i++) {
            this.scripts[i].render(g);
        }
    }

    setPosition(x, y, z, orientation = Orientation.DOWN) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.orientation = orientation;
    }

    onGUI(_g) {}

    onGUIAll(g) {
        if (!this.active) return;
        this.onGUI(g);
        for (let i = 0; i < this.scripts.length; i++) {
            this.scripts[i].onGUI(g);
        }
        for (let i = 0; i < this.children.length; i++) {
            this.children[i].onGUIAll(g);
        }
    }
}

module.exports = { Orientation, GameObject };
