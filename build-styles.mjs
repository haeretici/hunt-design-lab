/**
 * Compile scss/main.scss → build/app.css (compressed + inline source map).
 */

import * as sass from 'sass';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(root, 'build'), { recursive: true });

const inputFile = path.join(root, 'scss', 'main.scss');
const outputFile = path.join(root, 'build', 'app.css');

const result = sass.compile(inputFile, {
    style: 'compressed',
    sourceMap: true,
    loadPaths: [path.join(root, 'scss')]
});

let css = result.css;
if (result.sourceMap) {
    const mapJson = JSON.stringify(result.sourceMap);
    const base64 = Buffer.from(mapJson).toString('base64');
    css += `\n/*# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64} */`;
}

fs.writeFileSync(outputFile, css);
console.log(`  ${path.relative(root, outputFile)}         ${(css.length / 1024).toFixed(1)}kb`);
