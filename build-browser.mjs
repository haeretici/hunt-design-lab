/**
 * Bundle browser apps (app.js → build/app.bundle.js).
 * Stubs Node fs/path so kernel batch modules can load in the browser.
 */

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const shared = {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    sourcemap: true,
    minify: true,
    logLevel: 'info',
    // Node-only: TileMap.loadFloor uses pngjs in Node; browser uses Image + canvas.
    external: ['pngjs'],
    alias: {
        fs: path.join(root, 'kernel/core/lib/shims/fs-browser.js'),
        path: path.join(root, 'kernel/core/lib/shims/path-browser.js')
    }
};

await esbuild.build({
    ...shared,
    entryPoints: [path.join(root, 'app.js')],
    outfile: path.join(root, 'build', 'app.bundle.js')
});

await esbuild.build({
    ...shared,
    entryPoints: [path.join(root, 'kernel/apps/wiki/map_editor_entry.js')],
    outfile: path.join(root, 'build', 'map-editor.bundle.js')
});

console.log('Browser bundle → build/app.bundle.js');
console.log('Map editor bundle → build/map-editor.bundle.js');
