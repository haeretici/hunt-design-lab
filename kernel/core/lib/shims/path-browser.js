/**
 * Minimal path stub for browser bundles (posix-style).
 */

'use strict';

function normalize(p) {
    const parts = String(p || '').split('/').filter((s) => s && s !== '.');
    /** @type {string[]} */
    const out = [];
    for (const part of parts) {
        if (part === '..') {
            if (out.length && out[out.length - 1] !== '..') out.pop();
            else out.push('..');
        } else {
            out.push(part);
        }
    }
    const joined = out.join('/');
    return String(p || '').startsWith('/') ? `/${joined}` : joined || '.';
}

function join(...parts) {
    return normalize(parts.filter((p) => p != null && p !== '').join('/'));
}

function resolve(...parts) {
    const joined = join(...parts);
    if (joined.startsWith('/')) return joined;
    return `/${joined}`;
}

function dirname(p) {
    const s = String(p || '').replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    if (i <= 0) return s.startsWith('/') ? '/' : '.';
    return s.slice(0, i) || '/';
}

function basename(p, ext) {
    const s = String(p || '');
    const base = s.split('/').pop() || '';
    if (ext && base.endsWith(ext)) return base.slice(0, -ext.length);
    return base;
}

function isAbsolute(p) {
    return String(p || '').startsWith('/');
}

function relative(from, to) {
    // Browser preview only — prefer `to` when already project-relative.
    const t = String(to || '');
    if (!isAbsolute(t)) return t;
    const f = String(from || '').replace(/\/+$/, '');
    if (f && t.startsWith(f + '/')) return t.slice(f.length + 1);
    return t.replace(/^\//, '');
}

module.exports = {
    join,
    resolve,
    dirname,
    basename,
    isAbsolute,
    relative,
    sep: '/',
    posix: { join, resolve, dirname, basename, isAbsolute, relative, sep: '/' }
};
