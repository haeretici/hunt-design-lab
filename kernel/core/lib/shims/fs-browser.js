/**
 * Minimal fs stub for browser bundles.
 * Done-list I/O is replaced by fetch in the web app; these no-ops keep
 * batch_builder require() happy under esbuild platform:browser.
 */

'use strict';

module.exports = {
    existsSync() {
        return false;
    },
    readFileSync() {
        return '';
    },
    appendFileSync() {},
    mkdirSync() {},
    writeFileSync() {}
};
