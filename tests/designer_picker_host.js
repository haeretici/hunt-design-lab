#!/usr/bin/env node
/**
 * Shared Designer / map-editor picker host: READY → INIT, SELECT → apply.
 */

'use strict';

const assert = require('assert');
const {
    openCatalogAssetPicker,
    openEquipmentPicker,
    handlePickerMessage,
    resetPickerHostForTests,
    DESIGNER_PICKER_CHANNEL,
    MSG,
    PARENT_MSG
} = require('../html/widgets/designer_pickers/parent_host.js');
const { openCatalogAssetPicker: designerOpenCatalog } = require('../kernel/apps/designer-ui/relation_pickers.js');

function fakeWindow() {
    const posted = [];
    const win = {
        closed: false,
        posted,
        focus() {},
        postMessage(payload, origin) {
            posted.push({ payload, origin });
        }
    };
    return win;
}

function installWindow(child) {
    const listeners = [];
    global.window = {
        location: { origin: 'http://localhost' },
        open() {
            return child;
        },
        addEventListener(type, fn) {
            listeners.push({ type, fn });
        },
        focus() {}
    };
    return listeners;
}

function testCatalogSelectApply() {
    resetPickerHostForTests();
    const child = fakeWindow();
    installWindow(child);
    let selected = null;
    const rid = openCatalogAssetPicker({
        genre: 'rpg_fantasy',
        assetKind: 'tiles',
        previewVariant: 'icon',
        currentId: 'overgrown_grass_floor',
        title: 'Select tile',
        onSelect: (id, meta) => {
            selected = { id, meta };
        }
    });
    assert.ok(rid, 'openCatalogAssetPicker returns requestId');
    handlePickerMessage({
        origin: 'http://localhost',
        source: child,
        data: {
            channel: DESIGNER_PICKER_CHANNEL,
            kind: 'catalog',
            type: MSG.READY
        }
    });
    const init = child.posted.find((m) => m.payload && m.payload.type === PARENT_MSG.INIT);
    assert.ok(init, 'READY sends INIT');
    assert.strictEqual(init.payload.kind, 'catalog');
    assert.strictEqual(init.payload.requestId, rid);
    assert.strictEqual(init.payload.previewVariant, 'icon');
    assert.strictEqual(init.payload.assetKind, 'tiles');
    assert.strictEqual(init.payload.currentId, 'overgrown_grass_floor');

    handlePickerMessage({
        origin: 'http://localhost',
        source: child,
        data: {
            channel: DESIGNER_PICKER_CHANNEL,
            kind: 'catalog',
            type: MSG.SELECT,
            requestId: rid,
            value: {
                id: 'overgrown_grass_floor',
                label: 'Overgrown Grass Floor',
                assetKind: 'tiles'
            }
        }
    });
    assert.ok(selected);
    assert.strictEqual(selected.id, 'overgrown_grass_floor');
    assert.strictEqual(selected.meta.assetKind, 'tiles');
    resetPickerHostForTests();
}

function testEquipmentSelectApply() {
    resetPickerHostForTests();
    const child = fakeWindow();
    installWindow(child);
    let selected = null;
    const rid = openEquipmentPicker({
        mode: 'standard',
        genre: 'rpg_fantasy',
        title: 'Select item',
        onSelect: (id, meta) => {
            selected = { id, meta };
        }
    });
    assert.ok(rid);
    handlePickerMessage({
        origin: 'http://localhost',
        source: child,
        data: {
            channel: DESIGNER_PICKER_CHANNEL,
            kind: 'equipment',
            type: MSG.SELECT,
            requestId: rid,
            value: { id: 'rope', label: 'Rope' }
        }
    });
    assert.ok(selected);
    assert.strictEqual(selected.id, 'rope');
    resetPickerHostForTests();
}

function testDesignerWrapperStillOpensCatalog() {
    resetPickerHostForTests();
    const child = fakeWindow();
    installWindow(child);
    let selected = null;
    const rid = designerOpenCatalog({
        assetKind: 'objects',
        previewVariant: 'alpha',
        onSelect: (id) => {
            selected = id;
        }
    });
    assert.ok(rid);
    handlePickerMessage({
        origin: 'http://localhost',
        source: child,
        data: {
            channel: DESIGNER_PICKER_CHANNEL,
            kind: 'catalog',
            type: MSG.SELECT,
            requestId: rid,
            value: { id: 'village_crate', assetKind: 'objects' }
        }
    });
    assert.strictEqual(selected, 'village_crate');
    resetPickerHostForTests();
}

function testWrongOriginIgnored() {
    resetPickerHostForTests();
    const child = fakeWindow();
    installWindow(child);
    let selected = null;
    const rid = openCatalogAssetPicker({
        onSelect: (id) => {
            selected = id;
        }
    });
    handlePickerMessage({
        origin: 'https://evil.example',
        source: child,
        data: {
            channel: DESIGNER_PICKER_CHANNEL,
            kind: 'catalog',
            type: MSG.SELECT,
            requestId: rid,
            value: { id: 'nope' }
        }
    });
    assert.strictEqual(selected, null);
    resetPickerHostForTests();
}

function main() {
    testCatalogSelectApply();
    testEquipmentSelectApply();
    testDesignerWrapperStillOpensCatalog();
    testWrongOriginIgnored();
    console.log('designer picker host ok');
}

main();
