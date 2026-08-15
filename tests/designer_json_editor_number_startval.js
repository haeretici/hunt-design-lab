#!/usr/bin/env node
/**
 * use_default_values:false must not wipe number startval (demon hpMax / resists).
 */

'use strict';

const assert = require('assert');
const {
    syncStaleNumberEditorValue,
    patchJsonEditorNumberStartval
} = require('../kernel/apps/designer-ui/json_editor_number_startval.js');

function test(name, fn) {
    try {
        fn();
        console.log('ok', name);
    } catch (err) {
        console.error('FAIL', name);
        console.error(err && err.stack ? err.stack : err);
        process.exitCode = 1;
    }
}

function fakeEditor(overrides) {
    return {
        value: '',
        input: { value: '8200' },
        schema: {},
        jsoneditor: { options: { use_default_values: false } },
        ...overrides
    };
}

test('syncs stale this.value from input under use_default_values:false', () => {
    const ed = fakeEditor();
    syncStaleNumberEditorValue(ed);
    assert.strictEqual(ed.value, '8200');
});

test('leaves empty input unset (optional number still omitted)', () => {
    const ed = fakeEditor({ input: { value: '' } });
    syncStaleNumberEditorValue(ed);
    assert.strictEqual(ed.value, '');
});

test('does not touch editors with schema default or use_default_values', () => {
    const withDefault = fakeEditor({ schema: { default: 1 }, value: '' });
    syncStaleNumberEditorValue(withDefault);
    assert.strictEqual(withDefault.value, '');

    const withFlag = fakeEditor({
        jsoneditor: { options: { use_default_values: true } }
    });
    syncStaleNumberEditorValue(withFlag);
    assert.strictEqual(withFlag.value, '');
});

test('json-editor 2.15 setValue order would wipe the input without the sync', () => {
    const input = { value: '' };
    const editor = {
        value: '',
        serialized: '',
        input,
        schema: {},
        jsoneditor: { options: { use_default_values: false } },
        is_dirty: false,
        shouldBeUnset() {
            return !this.jsoneditor.options.use_default_values && !this.is_dirty;
        },
        setValueToInputField(value) {
            this.input.value = value === undefined ? '' : value;
        },
        getValue() {
            if (
                !this.schema.default &&
                !this.jsoneditor.options.use_default_values &&
                this.value === ''
            ) {
                if (this.shouldBeUnset()) {
                    this.input.value = '';
                    return undefined;
                }
            }
            return parseFloat(this.value);
        },
        refreshValue() {
            this.value = this.input.value;
            this.serialized = this.value;
        },
        setValue(value) {
            if (!this.shouldBeUnset() && typeof value !== 'string') value = `${value}`;
            this.setValueToInputField(value);
            this.getValue();
            this.refreshValue();
        }
    };
    editor.setValue(8200);
    assert.strictEqual(editor.input.value, '');
    assert.strictEqual(editor.value, '');
});

test('patched getValue does not clear a startval number input', () => {
    function NumberEditor() {}
    NumberEditor.prototype.getValue = function () {
        if (
            !this.schema.default &&
            !this.jsoneditor.options.use_default_values &&
            this.value === ''
        ) {
            this.input.value = '';
            return undefined;
        }
        return parseFloat(this.value);
    };

    const JE = {
        defaults: {
            editors: {
                number: NumberEditor,
                integer: { prototype: {} }
            }
        }
    };
    assert.strictEqual(patchJsonEditorNumberStartval(JE), true);

    const ed = Object.assign(new NumberEditor(), fakeEditor());
    const got = ed.getValue();
    assert.strictEqual(ed.input.value, '8200');
    assert.strictEqual(got, 8200);
});
