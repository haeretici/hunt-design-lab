/**
 * json-editor 2.15 NumberEditor.getValue() runs from setValue() before
 * refreshValue(). With use_default_values:false it still has this.value===''
 * and clears the input it just wrote (hp, hpMax, lootValue, resists.*, …).
 * IntegerEditor has the same stale-value branch without the wipe.
 */

'use strict';

/**
 * @param {{
 *   value?: unknown,
 *   input?: { value?: string },
 *   schema?: { default?: unknown },
 *   jsoneditor?: { options?: { use_default_values?: boolean } }
 * } | null | undefined} editor
 */
function syncStaleNumberEditorValue(editor) {
    if (!editor || !editor.jsoneditor) return;
    const opts = editor.jsoneditor.options || {};
    const schema = editor.schema || {};
    if (schema.default || opts.use_default_values) return;
    if (editor.value !== '') return;
    const inputVal = editor.input ? editor.input.value : '';
    if (inputVal !== '') editor.value = inputVal;
}

/**
 * @param {{ prototype?: { getValue?: Function, __hdlNumberStartvalPatched?: boolean } } | null | undefined} Editor
 */
function wrapNumberEditorGetValue(Editor) {
    if (!Editor || !Editor.prototype || Editor.prototype.__hdlNumberStartvalPatched) {
        return;
    }
    const orig = Editor.prototype.getValue;
    if (typeof orig !== 'function') return;
    Editor.prototype.getValue = function patchedNumberGetValue() {
        syncStaleNumberEditorValue(this);
        return orig.call(this);
    };
    Editor.prototype.__hdlNumberStartvalPatched = true;
}

/**
 * @param {{ defaults?: { editors?: { number?: object, integer?: object } } } | null | undefined} JE
 * @returns {boolean}
 */
function patchJsonEditorNumberStartval(JE) {
    const root =
        JE ||
        (typeof window !== 'undefined' ? window.JSONEditor : null);
    if (!root || !root.defaults || !root.defaults.editors) return false;
    wrapNumberEditorGetValue(root.defaults.editors.number);
    wrapNumberEditorGetValue(root.defaults.editors.integer);
    return true;
}

module.exports = {
    syncStaleNumberEditorValue,
    patchJsonEditorNumberStartval
};
