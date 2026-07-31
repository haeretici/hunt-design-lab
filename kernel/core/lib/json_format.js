/**
 * Canonical pretty-JSON for git-tracked files and UI editors.
 *
 * Must stay byte-compatible with PHP JsonFile encoding:
 *   JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE + "\n"
 *
 * Contract:
 * - 4-space indent (not 2)
 * - trailing newline
 * - key order preserved (no sorting)
 * - Unicode left unescaped; `/` not escaped
 */

'use strict';

/** Indent width matching PHP JSON_PRETTY_PRINT. */
const JSON_INDENT = 4;

/**
 * Pretty-print a JSON-serializable value in the repo canonical form.
 * @param {unknown} value
 * @returns {string} text including trailing newline
 */
function formatJson(value) {
    return JSON.stringify(value, null, JSON_INDENT) + '\n';
}

/**
 * Alias used by editors (same bytes as formatJson).
 * @param {unknown} value
 * @returns {string}
 */
function prettyJson(value) {
    return formatJson(value);
}

/**
 * Parse then re-emit so whitespace / unicode escapes match the contract.
 * @param {string} text
 * @returns {string}
 */
function reformatJsonText(text) {
    const parsed = JSON.parse(text);
    return formatJson(parsed);
}

module.exports = {
    JSON_INDENT,
    formatJson,
    prettyJson,
    reformatJsonText
};
