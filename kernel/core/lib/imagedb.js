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
