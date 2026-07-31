/**
 * Resolve repo-root URLs so the browser app can be hosted under a subpath.
 *
 * Relative fetch / img.src resolve against the page, not the script bundle —
 * always build asset/preset URLs with appUrl().
 *
 * Override (optional): window.__APP_ROOT__ = '/deploy/prefix/'
 * Node / headless (no document): returns host-root paths (`/assets/...`).
 */

'use strict';

/**
 * @param {string} s
 * @returns {string}
 */
function ensureTrailingSlash(s) {
    const t = String(s || '');
    if (!t) return '/';
    return t.endsWith('/') ? t : `${t}/`;
}

/**
 * Absolute app root ending with `/`.
 * @returns {string}
 */
function getAppRoot() {
    if (typeof window !== 'undefined' && window.__APP_ROOT__) {
        return ensureTrailingSlash(window.__APP_ROOT__);
    }
    if (typeof document !== 'undefined' && document.baseURI) {
        try {
            const url = new URL(document.baseURI);
            // Nested under /html/ or /templates/ → parent of that segment
            const match = url.pathname.match(/^(.*\/)(?:templates|html)(?:\/|$)/i);
            if (match) {
                url.pathname = match[1];
                url.search = '';
                url.hash = '';
                return ensureTrailingSlash(url.href);
            }
            // .../game.php or directory → strip file name
            const pathOnly = url.pathname || '/';
            if (/\.php$/i.test(pathOnly) || /\.html?$/i.test(pathOnly)) {
                url.pathname = pathOnly.replace(/[^/]+$/, '');
            }
            url.search = '';
            url.hash = '';
            return ensureTrailingSlash(url.href);
        } catch (_) {
            /* fall through */
        }
    }
    return '/';
}

/**
 * @param {string} relPath path from repo root, e.g. `assets/legacy/map/x.png` or `/presets/a.json`
 * @returns {string} URL for fetch / Image.src
 */
function appUrl(relPath) {
    const clean = String(relPath || '').replace(/^\/+/, '');
    const root = getAppRoot();
    if (root === '/') {
        return `/${clean}`;
    }
    try {
        return new URL(clean, root).href;
    } catch (_) {
        return root + clean;
    }
}

module.exports = { getAppRoot, appUrl, ensureTrailingSlash };
