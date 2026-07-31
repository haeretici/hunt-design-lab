/**
 * Bundle browser apps (app.js → build/app.bundle.js).
 * Stubs Node fs/path so kernel batch modules can load in the browser.
 */

import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
    entryPoints: [path.join(root, 'app.js')],
    bundle: true,
    outfile: path.join(root, 'build', 'app.bundle.js'),
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
});

console.log('Browser bundle → build/app.bundle.js');
