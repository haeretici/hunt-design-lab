/**
 * Simple browser image cache (soccer-oss  / legacy pattern).
 * Headless / Node: get() returns null unless register() was used.
 * Does not throw on missing assets — callers fall back to markers.
 */

'use strict';

/**
 * @typedef {HTMLImageElement|CanvasImageSource|{ complete?: boolean, naturalWidth?: number, width?: number, height?: number, src?: string }} Drawable
 */

const ImageDB = {
    /** @type {Record<string, Drawable>} */
    images: Object.create(null),
    /** @type {Record<string, true>} */
    failed: Object.create(null),

    /**
     * Return cached drawable, or start loading in the browser.
     * @param {string} src Absolute or root-relative URL
     * @returns {Drawable|null}
     */
    get(src) {
        if (!src) return null;
        const key = String(src);
        if (this.failed[key]) return null;
        if (this.images[key]) return this.images[key];

        if (typeof Image === 'undefined') {
            return null;
        }

        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
            /* keep in cache */
            if (key.indexOf('/retro/') !== -1 && typeof document !== 'undefined') {
                const w = img.naturalWidth;
                const h = img.naturalHeight;
                if (w > 0 && h > 0) {
                    const bp = Math.ceil(Math.max(w, h) / 32) * 32;
                    if (w !== bp || h !== bp) {
                        const canvas = document.createElement('canvas');
                        canvas.width = bp;
                        canvas.height = bp;
                        const ctx = canvas.getContext('2d');
                        if (ctx) {
                            const dx = Math.floor((bp - w) / 2);
                            const dy = Math.floor((bp - h) / 2);
                            ctx.drawImage(img, dx, dy);
                            this.images[key] = canvas;
                        }
                    }
                }
            }
        };
        img.onerror = () => {
            this.failed[key] = true;
            delete this.images[key];
        };
        this.images[key] = img;
        img.src = key;
        return img;
    },

    /**
     * Force-register a drawable (composed sheets, tests, pre-decoded canvas).
     * @param {string} src
     * @param {Drawable} drawable
     * @returns {Drawable}
     */
    register(src, drawable) {
        const key = String(src);
        this.images[key] = drawable;
        delete this.failed[key];
        return drawable;
    },

    /**
     * @param {string} src
     * @returns {boolean}
     */
    isReady(src) {
        if (!src) return false;
        const key = String(src);
        if (this.failed[key]) return false;
        const img = this.images[key];
        if (!img) return false;
        return isDrawableReady(img);
    },

    /**
     * @param {string} src
     * @returns {boolean}
     */
    hasFailed(src) {
        if (!src) return false;
        return !!this.failed[String(src)];
    },

    clear() {
        this.images = Object.create(null);
        this.failed = Object.create(null);
    }
};

/**
 * @param {Drawable|null|undefined} img
 * @returns {boolean}
 */
function isDrawableReady(img) {
    if (!img) return false;
    if (img.complete === false) return false;
    const w =
        img.naturalWidth != null
            ? img.naturalWidth
            : img.width != null
              ? img.width
              : 0;
    return w > 0;
}

module.exports = { ImageDB, isDrawableReady };
