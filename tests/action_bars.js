/**
 * Unit tests for Action Bars core, hotkey mapping, Smart Cast targeting, and macro dispatching.
 */

'use strict';

const assert = require('assert');
const {
    initActionBars,
    executeSlot,
    assignSlot,
    normalizeHotkey,
    switchProfile,
    checkHotkeyConflict,
    resolveSlotCooldownSpec,
    getSpecRemainingSeconds,
    getSpecCooldownDisplay,
    formatCooldownTimer,
    setLayoutCounts,
    normalizeBar,
    normalizeDocks,
    normalizeSlot,
    buildStoragePayload,
    applyStoredPayload,
    coerceStoredPayload,
    isSubActionAvailable,
    findNextAvailableMultiIndex,
    getActiveMultiSubAction,
    itemIsActionBarEquipable,
    toggleEquipByItemId,
    findEquippedSlotForItemId,
    countItemIdCarried,
    SLOTS_PER_BAR,
    MAX_BARS_PER_DOCK,
    MULTI_ACTION_DEPTH,
    VISIBLE_CAP_HORIZONTAL,
    VISIBLE_CAP_VERTICAL,
    maxPageOffsetForBar,
    clampBarPageOffset,
    findBarById,
    findBarForSlotId,
    isSlotBarLocked,
    setBarLocked,
    toggleBarLocked,
    clearBar,
    describeSlotAction,
    slotAriaLabel,
    visibleRangeForBar,
    setBarPageOffset,
    shiftBarPage,
    state
} = require('../kernel/apps/game/action_bars.js');
const { createActionBarParentBridge } = require('../html/widgets/action_bar_config/parent_bridge.js');
const { uiState, clearTargetCursorMode } = require('../kernel/apps/game/ui_state.js');
const Cooldowns = require('../kernel/core/lib/combat/cooldowns.js');
const { Settings } = require('../kernel/settings.js');
const {
    buildInventoryFromSeed,
    countItemIdInInventoryTree
} = require('../kernel/core/lib/character/inventory.js');

const GEAR_ITEM_DB = [
    {
        id: 'backpack',
        label: 'Backpack',
        category: 'container',
        slot: 'backpack',
        volume: 20,
        weight: 1800
    },
    {
        id: 'iron_longsword',
        label: 'Iron Longsword',
        slot: 'rightHand',
        category: 'sword',
        atk: 42,
        weight: 5400
    },
    {
        id: 'steel_helm',
        label: 'Steel Helm',
        slot: 'helmet',
        category: 'helmet',
        armor: 6,
        weight: 3200
    },
    {
        id: 'leather_boots',
        label: 'Leather Boots',
        slot: 'boots',
        category: 'boots',
        armor: 2,
        weight: 900
    },
    {
        id: 'potion_healing',
        label: 'Healing Potion',
        category: 'potion',
        consumable: true,
        weight: 180
    }
];

let passed = 0;
function test(name, fn) {
    try {
        clearTargetCursorMode();
        fn();
        console.log(`PASS: ${name}`);
        passed++;
    } catch (e) {
        console.error(`FAIL: ${name}`);
        console.error(e);
        process.exit(1);
    }
}

console.log('--- Running Action Bars & Macro Dispatcher Tests ---');

test('normalizeHotkey converts standard representation', () => {
    assert.strictEqual(normalizeHotkey('shift + 1 '), 'SHIFT+1');
    assert.strictEqual(normalizeHotkey('Ctrl+f1'), 'CTRL+F1');
});

test('default MANUAL_CONTROL_SHORTCUTS use WASD+arrows only (no digits/numpad diagonals)', () => {
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveNorth, ['ARROWUP', 'W']);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveSouth, ['ARROWDOWN', 'S']);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveWest, ['ARROWLEFT', 'A']);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveEast, ['ARROWRIGHT', 'D']);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveNorthWest, []);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveNorthEast, []);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveSouthWest, []);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveSouthEast, []);
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.stopAutowalk, ['ESCAPE']);
});

test('initActionBars sets up default 4 docks (top, bottom, left, right)', () => {
    initActionBars({
        getItemDb: () => [
            { id: 'rune_fireball', multiUse: true, type: 'rune', category: 'rune' },
            { id: 'rune_deathburst', multiUse: true, type: 'rune', category: 'rune' }
        ]
    });
    assert.ok(state.docks.top.length >= 1, 'Top dock exists');
    assert.ok(state.docks.bottom.length >= 1, 'Bottom dock exists');
    assert.ok(state.docks.left.length >= 1, 'Left dock exists');
    assert.ok(state.docks.right.length >= 1, 'Right dock exists');

    assert.strictEqual(SLOTS_PER_BAR, 50, 'SLOTS_PER_BAR constant is 50');
    assert.strictEqual(MAX_BARS_PER_DOCK, 3);
    assert.strictEqual(MULTI_ACTION_DEPTH, 3);
    assert.strictEqual(VISIBLE_CAP_HORIZONTAL, 12);
    assert.strictEqual(VISIBLE_CAP_VERTICAL, 10);

    assert.deepStrictEqual(state.layoutCounts, { top: 1, bottom: 1, left: 1, right: 1 });
    assert.strictEqual(state.docks.top.length, 1);
    assert.strictEqual(state.docks.bottom.length, 1);
    assert.strictEqual(state.docks.left.length, 1);
    assert.strictEqual(state.docks.right.length, 1);

    assert.strictEqual(state.docks.top[0].slots.length, SLOTS_PER_BAR, 'Top bar has 50 logical slots');
    assert.strictEqual(state.docks.bottom[0].slots.length, SLOTS_PER_BAR, 'Bottom bar has 50 logical slots');
    assert.strictEqual(state.docks.left[0].slots.length, SLOTS_PER_BAR, 'Left bar has 50 logical slots');
    assert.strictEqual(state.docks.right[0].slots.length, SLOTS_PER_BAR, 'Right bar has 50 logical slots');

    // Classic defaults still occupy the first page of hotkeys
    assert.strictEqual(state.docks.top[0].slots[0].hotkey, 'F1');
    assert.strictEqual(state.docks.top[0].slots[11].hotkey, 'F12');
    assert.strictEqual(state.docks.top[0].slots[12].hotkey, '', 'Slots past classic page start unbound');
    assert.strictEqual(state.docks.bottom[0].slots[0].hotkey, '1');
    assert.strictEqual(state.docks.left[0].slots[0].hotkey, 'SHIFT+1');
    assert.strictEqual(state.docks.right[0].slots[0].hotkey, 'CTRL+1');
});

test('assignSlot binds item and maps hotkey in lookup index', () => {
    const slotId = state.docks.top[0].slots[0].id; // top_1_slot_0 (F1)
    const assigned = assignSlot(slotId, 'item', {
        itemId: 'rune_fireball',
        targetMode: 'smart_target',
        hotkey: 'F1'
    });
    assert.strictEqual(assigned, true);

    const slot = state.slotsById.get(slotId);
    assert.strictEqual(slot.actionType, 'item');
    assert.strictEqual(slot.itemId, 'rune_fireball');
    assert.strictEqual(state.hotkeysMap.get('F1'), slotId);
});

test('executeSlot uses Smart Cast when target Mode is smart_target and active target exists', () => {
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        target: { id: 99, alive: true }
    };
    const slotId = state.docks.top[0].slots[0].id;
    const slot = state.slotsById.get(slotId);

    executeSlot(slot, { player });
    assert.strictEqual(player.commandQueue.length, 1);
    assert.strictEqual(player.commandQueue[0].type, 'USE_ITEM_WITH');
    assert.strictEqual(player.commandQueue[0].itemId, 'rune_fireball');
    assert.strictEqual(player.commandQueue[0].target.id, 99);
    assert.strictEqual(uiState.activeActionCursor, null, 'No crosshair cursor prompted in Smart Cast mode');
});

test('executeSlot falls back to cursor prompt when target Mode is cursor_prompt', () => {
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        target: { id: 99, alive: true }
    };
    const slotId = state.docks.top[0].slots[1].id; // F2
    assignSlot(slotId, 'item', {
        itemId: 'rune_deathburst',
        targetMode: 'cursor_prompt',
        hotkey: 'F2'
    });
    const slot = state.slotsById.get(slotId);

    executeSlot(slot, {
        player,
        spellBook: {
            deathburst: {
                id: 'deathburst',
                source: 'rune',
                runeItemId: 'rune_deathburst',
                range: 6
            }
        }
    });
    assert.strictEqual(player.commandQueue.length, 0, 'No direct command dispatched yet');
    assert.ok(uiState.activeActionCursor != null, 'Crosshair targeting mode entered');
    assert.strictEqual(uiState.activeActionCursor.type, 'USE_ITEM_WITH');
    assert.strictEqual(uiState.activeActionCursor.itemId, 'rune_deathburst');
    assert.strictEqual(
        uiState.activeActionCursor.allowTileAim,
        false,
        'single-target rune: creature only (no empty-tile aim)'
    );
});

test('resolveAllowTileAim: shaped rune allows tile; bolt does not', () => {
    const { resolveAllowTileAim } = require('../kernel/apps/game/action_bars.js');
    const spellBook = {
        deathburst: {
            id: 'deathburst',
            source: 'rune',
            runeItemId: 'deathburst_rune',
            range: 6
        },
        blaze_bomb_rune: {
            id: 'blaze_bomb_rune',
            source: 'rune',
            runeItemId: 'blaze_bomb_rune',
            range: 4,
            shape: { type: 'area', code: 3 }
        }
    };
    assert.strictEqual(
        resolveAllowTileAim({ itemId: 'deathburst_rune', spellBook }),
        false
    );
    assert.strictEqual(
        resolveAllowTileAim({ itemId: 'blaze_bomb_rune', spellBook }),
        true
    );
    assert.strictEqual(
        resolveAllowTileAim({ itemId: 'rope', spellBook: {} }),
        true,
        'tools without spell → tile aim OK'
    );
});

test('executeSlot handles spell Smart Cast vs self cast', () => {
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        target: { id: 101, alive: true }
    };
    const slotId = state.docks.bottom[0].slots[0].id; // "1"
    assignSlot(slotId, 'spell', {
        spellId: 'flame_strike',
        targetMode: 'smart_target',
        hotkey: '1'
    });
    executeSlot(state.slotsById.get(slotId), {
        player,
        spellBook: {
            flame_strike: { id: 'flame_strike', element: 'fire', range: 3 }
        }
    });

    assert.strictEqual(player.commandQueue.length, 1);
    assert.strictEqual(player.commandQueue[0].type, 'CAST_SPELL');
    assert.strictEqual(player.commandQueue[0].spellId, 'flame_strike');
    assert.strictEqual(player.commandQueue[0].target.id, 101);

    // Healing always self (even under smart_target)
    const selfSlotId = state.docks.bottom[0].slots[1].id; // "2"
    assignSlot(selfSlotId, 'spell', {
        spellId: 'heal_light',
        targetMode: 'smart_target',
        hotkey: '2'
    });
    executeSlot(state.slotsById.get(selfSlotId), {
        player,
        spellBook: {
            heal_light: { id: 'heal_light', element: 'healing', range: 0 }
        }
    });
    assert.strictEqual(player.commandQueue.length, 2);
    assert.strictEqual(player.commandQueue[1].type, 'CAST_SPELL');
    assert.strictEqual(player.commandQueue[1].target.kind, 'self');
});

test('executeSlot smart cast without target does not self-cast damage spells', () => {
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        target: null
    };
    const slotId = state.docks.bottom[0].slots[2].id;
    assignSlot(slotId, 'spell', {
        spellId: 'flame_strike',
        targetMode: 'smart_target',
        hotkey: '3'
    });
    executeSlot(state.slotsById.get(slotId), {
        player,
        spellBook: {
            flame_strike: { id: 'flame_strike', element: 'fire', range: 3 }
        }
    });
    assert.strictEqual(
        player.commandQueue.length,
        0,
        'targeted strike must not fire on self when no target is selected'
    );
});

test('executeSlot triggers command macro strings', () => {
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: []
    };
    const slotId = state.docks.left[0].slots[0].id; // Shift+1
    assignSlot(slotId, 'command', {
        command: 'auto_chase',
        hotkey: 'SHIFT+1'
    });
    executeSlot(state.slotsById.get(slotId), { player });
    assert.strictEqual(player.commandQueue.length, 1);
    assert.strictEqual(player.commandQueue[0].type, 'SET_AUTO_CHASE');

    assignSlot(slotId, 'command', {
        command: 'stop',
        hotkey: 'SHIFT+2'
    });
    executeSlot(state.slotsById.get(slotId), { player });
    assert.strictEqual(player.commandQueue.length, 2);
    assert.strictEqual(player.commandQueue[1].type, 'STOP_AUTOWALK');
});

test('checkHotkeyConflict detects already bound hotkeys in current profile', () => {
    const topSlot0 = state.docks.top[0].slots[0].id; // F1
    assignSlot(topSlot0, 'item', { itemId: 'rune_fireball', hotkey: 'F1' });
    const conflict = checkHotkeyConflict('F1', 'top_1_slot_5');
    assert.ok(conflict != null, 'Conflict identified for F1 on another slot');
    assert.strictEqual(conflict.id, topSlot0);

    const noConflictSelf = checkHotkeyConflict('F1', topSlot0);
    assert.strictEqual(noConflictSelf, null, 'No conflict when checking the same slot');
});

test('switchProfile isolates layouts and keymaps per vocation/class', () => {
    assert.strictEqual(state.activeProfileId, 'guardian');
    const defaultTopSlot0 = state.docks.top[0].slots[0].id;
    assignSlot(defaultTopSlot0, 'item', { itemId: 'rune_fireball', hotkey: 'F1' });

    // Switch to mystic vocation profile
    const changed = switchProfile('mystic');
    assert.strictEqual(changed, true, 'Switched to mystic profile');
    assert.strictEqual(state.activeProfileId, 'mystic');
    assert.strictEqual(state.docks.top[0].slots[0].actionType, 'empty', 'New vocation profile starts clean with empty slots');

    // Bind spell in mystic profile
    assignSlot(state.docks.top[0].slots[0].id, 'spell', { spellId: 'spell_flame_strike', hotkey: 'F1' });
    assert.strictEqual(state.docks.top[0].slots[0].spellId, 'spell_flame_strike');

    // Switch back to guardian profile
    switchProfile('guardian');
    assert.strictEqual(state.activeProfileId, 'guardian');
    assert.strictEqual(state.docks.top[0].slots[0].itemId, 'rune_fireball', 'Restored fireburst binding when returning to guardian profile');
});

test('createActionBarParentBridge synchronizes state and handles messages', () => {
    const actionBarsModule = {
        state,
        switchProfile,
        assignSlot,
        setBarLocked,
        clearBar,
        rebuildMaps: () => {},
        updateActionBars: () => {}
    };
    const bridge = createActionBarParentBridge({
        actionBars: actionBarsModule,
        getActivePlayer: () => ({ classId: 'guardian', name: 'Tank' }),
        getSpellBook: () => ({ spell_taunt: { name: 'Taunt', cost: 10, cd: 3 } }),
        getItemDb: () => ([{ id: 'item_potion', name: 'Health Potion', type: 'potion' }]),
        getGenre: () => 'fantasy'
    });

    const snapshot = bridge.snapshotState();
    assert.strictEqual(snapshot.activePlayerClass, 'guardian');
    assert.strictEqual(snapshot.genre, 'fantasy');
    assert.ok(snapshot.spellBook.spell_taunt != null, 'Includes spellBook');

    // Test applyMessage for switching profile and assigning slots
    bridge.applyMessage({
        channel: 'hunt-design-lab-action-bar',
        type: 'switch_profile',
        profileId: 'guardian'
    });
    assert.strictEqual(state.activeProfileId, 'guardian');

    const slotId = state.docks.bottom[0].slots[0].id;
    bridge.applyMessage({
        channel: 'hunt-design-lab-action-bar',
        type: 'assign_slot',
        slotId: slotId,
        actionType: 'spell',
        cfg: { spellId: 'spell_taunt', targetMode: 'smart_target', hotkey: '1' }
    });
    assert.strictEqual(state.docks.bottom[0].slots[0].spellId, 'spell_taunt');

    // Stage G: lock / clear via bridge
    const barId = state.docks.bottom[0].id;
    bridge.applyMessage({
        channel: 'hunt-design-lab-action-bar',
        type: 'set_bar_locked',
        barId,
        locked: true
    });
    assert.strictEqual(state.docks.bottom[0].locked, true);
    bridge.applyMessage({
        channel: 'hunt-design-lab-action-bar',
        type: 'set_bar_locked',
        barId,
        locked: false
    });
    bridge.applyMessage({
        channel: 'hunt-design-lab-action-bar',
        type: 'clear_bar',
        barId,
        clearHotkeys: false
    });
    assert.strictEqual(state.docks.bottom[0].slots[0].actionType, 'empty');
    assert.strictEqual(state.docks.bottom[0].slots[0].hotkey, '1');
});

test('createActionBarParentBridge normalizes spellBook array and performs dirty checking on sendState', () => {
    const actionBarsModule = {
        state,
        switchProfile,
        assignSlot,
        rebuildMaps: () => {},
        updateActionBars: () => {}
    };
    let postCount = 0;
    const bridge = createActionBarParentBridge({
        actionBars: actionBarsModule,
        getActivePlayer: () => ({ classId: 'warden' }),
        getSpellBook: () => ([
            { id: 'flame_strike', label: 'Flame Strike', mana: 20 },
            { id: 'ice_strike', label: 'Ice Strike', mana: 20 }
        ]),
        getItemDb: () => []
    });

    const snapshot = bridge.snapshotState();
    assert.strictEqual(typeof snapshot.spellBook, 'object', 'spellBook is normalized to object');
    assert.ok(snapshot.spellBook.flame_strike != null, 'Contains flame_strike keyed by id');
    assert.strictEqual(snapshot.spellBook.flame_strike.label, 'Flame Strike');

    // Simulate popup window to verify dirty checking on sendState
    const fakePopup = {
        closed: false,
        postMessage: () => {
            postCount++;
        }
    };
    bridge.applyMessage({ channel: 'hunt-design-lab-action-bar', type: 'ready' }, fakePopup);
    assert.strictEqual(postCount, 1, 'Initial ready forces state send');

    bridge.sendState(false);
    assert.strictEqual(postCount, 1, 'sendState with false does not send when state is unchanged');

    bridge.sendState(true);
    assert.strictEqual(postCount, 2, 'sendState with force=true sends state');
    bridge.dispose();
});

test('mountDocks clears lastSignatures cache and default genre is rpg_fantasy', () => {
    initActionBars({});
    assert.strictEqual(state.getGenre(), 'rpg_fantasy', 'Default genre should be rpg_fantasy');

    state.lastSignatures.set('test_slot_0', 'dummy_sig');
    global.document = { getElementById: () => null };
    const { mountDocks } = require('../kernel/apps/game/action_bars.js');
    mountDocks();
    delete global.document;
    assert.strictEqual(state.lastSignatures.size, 0, 'lastSignatures must be cleared when mounting docks');
});

test('updateActionBars uses edge-triggered profile switching', () => {
    let currentPlayer = { classId: 'guardian' };
    const { updateActionBars } = require('../kernel/apps/game/action_bars.js');
    initActionBars({
        getActivePlayer: () => currentPlayer
    });
    assert.strictEqual(state.activeProfileId, 'guardian');
    
    // Explicitly switch profile to mystic (e.g. while configuring in popup)
    switchProfile('mystic');
    assert.strictEqual(state.activeProfileId, 'mystic');

    global.document = { getElementById: () => null };
    updateActionBars();
    delete global.document;

    assert.strictEqual(state.activeProfileId, 'mystic', 'updateActionBars must not override manually selected profile when player class has not changed');

    // Change player class in game
    currentPlayer = { classId: 'adept' };
    global.document = { getElementById: () => null };
    updateActionBars();
    delete global.document;
    assert.strictEqual(state.activeProfileId, 'adept', 'updateActionBars switches profile automatically when player class changes');
});

test('createActionBarParentBridge handles general hotkeys synchronization and updates Settings', () => {
    const { Settings } = require('../kernel/settings.js');
    const actionBarsModule = {
        state,
        switchProfile: () => {},
        assignSlot: () => {},
        rebuildMaps: () => {},
        updateActionBars: () => {}
    };
    const bridge = createActionBarParentBridge({
        actionBars: actionBarsModule,
        getActivePlayer: () => ({ classId: 'guardian' }),
        getSpellBook: () => null,
        getItemDb: () => null
    });
    
    const snapshot = bridge.snapshotState();
    assert.ok(snapshot.generalHotkeys != null, 'Includes generalHotkeys in state');
    assert.ok(Array.isArray(snapshot.generalHotkeys.moveNorth), 'Includes default movement hotkeys');
    
    // Simulate patch_general_hotkeys message from popup
    bridge.applyMessage({
        channel: 'hunt-design-lab-action-bar',
        type: 'patch_general_hotkeys',
        shortcuts: {
            moveNorth: ['W', 'UP'],
            toggleAutoChase: ['CTRL+C']
        }
    });
    
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveNorth, ['W', 'UP'], 'Settings updated with new movement hotkeys');
    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.toggleAutoChase, ['CTRL+C'], 'Settings updated with new toggleAutoChase hotkeys');
});

test('createActionBarParentBridge handles copy_general_hotkeys_to_all_profiles and syncs storage', () => {
    const { Settings } = require('../kernel/settings.js');
    const { loadGeneralHotkeys } = require('../kernel/apps/game/ui_state.js');

    const store = {};
    global.window = {
        localStorage: {
            getItem: (k) => store[k] || null,
            setItem: (k, v) => { store[k] = String(v); }
        }
    };

    const actionBarsModule = {
        state: {
            activeProfileId: 'guardian',
            profiles: { guardian: {}, adept: {}, ranger: {} }
        },
        switchProfile: (pid) => { actionBarsModule.state.activeProfileId = pid; },
        assignSlot: () => {},
        rebuildMaps: () => {},
        updateActionBars: () => {}
    };

    const bridge = createActionBarParentBridge({
        actionBars: actionBarsModule,
        getActivePlayer: () => ({ classId: 'guardian' }),
        getSpellBook: () => null,
        getItemDb: () => null
    });

    bridge.applyMessage({
        channel: 'hunt-design-lab-action-bar',
        type: 'copy_general_hotkeys_to_all_profiles',
        shortcuts: {
            moveNorth: ['ARROWUP'],
            toggleAutoChase: ['KEYT', 'ALT+T']
        }
    });

    assert.deepStrictEqual(Settings.MANUAL_CONTROL_SHORTCUTS.moveNorth, ['ARROWUP'], 'Updated current settings');
    const raw = store['hdl_general_hotkeys'];
    assert.ok(raw, 'Saved to localStorage');
    const parsed = JSON.parse(raw);
    assert.ok(parsed.profiles && parsed.profiles.adept && parsed.profiles.ranger, 'Copied settings to adept and ranger profiles');
    assert.deepStrictEqual(parsed.profiles.adept.toggleAutoChase, ['KEYT', 'ALT+T'], 'Adept received copied shortcuts');
    assert.deepStrictEqual(parsed.profiles.ranger.toggleAutoChase, ['KEYT', 'ALT+T'], 'Ranger received copied shortcuts');

    delete global.window;
});

test('executeSlot ignores AI controlMode (no queue)', () => {
    const player = {
        id: 1,
        alive: true,
        controlMode: 'ai',
        commandQueue: [],
        target: { id: 99, alive: true }
    };
    const slotId = state.docks.top[0].slots[0].id;
    assignSlot(slotId, 'item', {
        itemId: 'rune_fireball',
        targetMode: 'smart_target',
        hotkey: 'F1'
    });
    executeSlot(state.slotsById.get(slotId), { player });
    assert.strictEqual(player.commandQueue.length, 0, 'AI members must not receive action-bar commands');
});

test('assignSlot clears conflicting hotkey on the other slot', () => {
    initActionBars({});
    const a = state.docks.top[0].slots[0].id;
    const b = state.docks.top[0].slots[1].id;
    assignSlot(a, 'item', { itemId: 'rune_a', hotkey: 'F1' });
    assignSlot(b, 'item', { itemId: 'rune_b', hotkey: 'F1' });
    assert.strictEqual(state.slotsById.get(a).hotkey, '', 'previous F1 owner cleared');
    assert.strictEqual(state.slotsById.get(b).hotkey, 'F1');
    assert.strictEqual(state.hotkeysMap.get('F1'), b);
});

test('shared primary cooldown marks spell and related rune remaining', () => {
    const player = { id: 1, alive: true, controlMode: 'manual' };
    Cooldowns.ensureCooldowns(player);
    Cooldowns.apply(player, { primary: { attack: 2 } });

    const spellBook = {
        flame_strike: {
            id: 'flame_strike',
            cooldowns: { primary: { attack: 2 } }
        },
        lesser_arc_bolt: {
            id: 'lesser_arc_bolt',
            source: 'rune',
            runeItemId: 'lesser_arc_bolt_rune',
            cooldowns: { primary: { attack: 2 } }
        }
    };

    const spellSpec = resolveSlotCooldownSpec(
        { actionType: 'spell', spellId: 'flame_strike' },
        spellBook,
        null
    );
    const runeSpec = resolveSlotCooldownSpec(
        { actionType: 'item', itemId: 'lesser_arc_bolt_rune' },
        spellBook,
        null
    );
    assert.ok(spellSpec && spellSpec.primary && spellSpec.primary.attack === 2);
    assert.ok(runeSpec && runeSpec.primary && runeSpec.primary.attack === 2);
    assert.ok(getSpecRemainingSeconds(player, spellSpec) > 0, 'spell blocked by primary');
    assert.ok(getSpecRemainingSeconds(player, runeSpec) > 0, 'rune shares primary attack CD');
});

test('formatCooldownTimer matches legacy second buckets', () => {
    assert.strictEqual(formatCooldownTimer(0), '');
    assert.strictEqual(formatCooldownTimer(-1), '');
    assert.strictEqual(formatCooldownTimer(12.4), '12s');
    assert.strictEqual(formatCooldownTimer(10), '10s');
    assert.strictEqual(formatCooldownTimer(1.54), '1.5s');
    assert.strictEqual(formatCooldownTimer(0.254), '0.25s');
});

test('getSpecCooldownDisplay progress sweeps 0→100 on longest blocking key', () => {
    const player = { id: 1, alive: true };
    Cooldowns.ensureCooldowns(player);
    const spec = {
        primary: { attack: 2 },
        spell: { front_sweep: 6 }
    };
    Cooldowns.apply(player, spec);

    let d = getSpecCooldownDisplay(player, spec);
    assert.ok(Math.abs(d.remaining - 6) < 1e-9, `remaining should be spell CD: ${d.remaining}`);
    assert.ok(Math.abs(d.duration - 6) < 1e-9, `duration from spell key: ${d.duration}`);
    assert.ok(d.progress < 1e-6, `just cast → progress ~0, got ${d.progress}`);

    Cooldowns.tick(player, 3);
    d = getSpecCooldownDisplay(player, spec);
    assert.ok(Math.abs(d.remaining - 3) < 1e-9, `half remaining: ${d.remaining}`);
    assert.ok(Math.abs(d.progress - 50) < 1e-6, `halfway progress: ${d.progress}`);

    Cooldowns.tick(player, 3);
    d = getSpecCooldownDisplay(player, spec);
    assert.strictEqual(d.remaining, 0);
    assert.strictEqual(d.progress, 100);
});

// ── Stage A: data model, layout counts ──────────────────────────────────────

test('setLayoutCounts 1→3 creates empty bars; 3→1 keeps bar_1 data and stashes extras', () => {
    initActionBars({});
    const bar1Id = state.docks.bottom[0].id;
    const slot0 = state.docks.bottom[0].slots[0].id;
    assignSlot(slot0, 'spell', { spellId: 'heal_light', hotkey: '1' });
    assert.strictEqual(state.docks.bottom[0].slots[0].spellId, 'heal_light');

    setLayoutCounts({ bottom: 3 }, { remount: false });
    assert.strictEqual(state.layoutCounts.bottom, 3);
    assert.strictEqual(state.docks.bottom.length, 3, 'three bottom bars after expand');
    assert.strictEqual(state.docks.bottom[0].id, bar1Id, 'bar_1 identity preserved');
    assert.strictEqual(state.docks.bottom[0].slots[0].spellId, 'heal_light', 'bar_1 assignment preserved');
    assert.strictEqual(state.docks.bottom[1].slots.length, SLOTS_PER_BAR);
    assert.strictEqual(state.docks.bottom[1].slots[0].actionType, 'empty');
    assert.strictEqual(state.docks.bottom[2].id, 'bottom_3');

    // Mark bar_2 so stash restore can be verified
    const bar2Slot = state.docks.bottom[1].slots[0].id;
    // bar2 slot may not be in maps if rebuild used — assign via state if needed
    const bar2 = state.docks.bottom[1];
    bar2.slots[0].actionType = 'item';
    bar2.slots[0].itemId = 'potion_heal';

    setLayoutCounts({ bottom: 1 }, { remount: false });
    assert.strictEqual(state.layoutCounts.bottom, 1);
    assert.strictEqual(state.docks.bottom.length, 1);
    assert.strictEqual(state.docks.bottom[0].slots[0].spellId, 'heal_light', 'bar_1 still intact after shrink');
    assert.ok(
        state.barStash.guardian &&
        Array.isArray(state.barStash.guardian.bottom) &&
        state.barStash.guardian.bottom.length >= 1,
        'excess bars stashed'
    );

    setLayoutCounts({ bottom: 3 }, { remount: false });
    assert.strictEqual(state.docks.bottom.length, 3);
    assert.strictEqual(state.docks.bottom[0].slots[0].spellId, 'heal_light');
    assert.strictEqual(
        state.docks.bottom[1].slots[0].itemId,
        'potion_heal',
        'stashed bar_2 restored with assignment'
    );
});

test('assignSlot supports text, passive, and multi types', () => {
    initActionBars({});
    const a = state.docks.top[0].slots[0].id;
    const b = state.docks.top[0].slots[1].id;
    const c = state.docks.top[0].slots[2].id;

    assert.strictEqual(assignSlot(a, 'text', { text: 'Hello party', hotkey: 'F1' }), true);
    assert.strictEqual(state.slotsById.get(a).actionType, 'text');
    assert.strictEqual(state.slotsById.get(a).text, 'Hello party');
    assert.strictEqual(state.slotsById.get(a).itemId, null);

    assert.strictEqual(assignSlot(b, 'passive', { passiveId: 'gift_of_life', hotkey: 'F2' }), true);
    assert.strictEqual(state.slotsById.get(b).actionType, 'passive');
    assert.strictEqual(state.slotsById.get(b).passiveId, 'gift_of_life');

    assert.strictEqual(assignSlot(c, 'multi', {
        hotkey: 'F3',
        multiActions: [
            { actionType: 'spell', spellId: 'flame_strike', targetMode: 'smart_target' },
            { actionType: 'item', itemId: 'rune_fireball', targetMode: 'cursor_prompt' },
            { actionType: 'empty' }
        ]
    }), true);
    const multi = state.slotsById.get(c);
    assert.strictEqual(multi.actionType, 'multi');
    assert.ok(Array.isArray(multi.multiActions));
    assert.strictEqual(multi.multiActions.length, MULTI_ACTION_DEPTH);
    assert.strictEqual(multi.multiActions[0].spellId, 'flame_strike');
    assert.strictEqual(multi.multiActions[1].itemId, 'rune_fireball');
    assert.strictEqual(multi.multiActions[2].actionType, 'empty');

    // Text/passive → FCT; multi executes active sub (spell with target)
    const floats = [];
    const sim = {
        emitCombatText: (opts) => {
            floats.push(opts);
        }
    };
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        tile: { x: 3, y: 4, z: 0 },
        target: { id: 99, alive: true },
        cooldowns: Cooldowns.createCooldownState()
    };
    executeSlot(state.slotsById.get(a), { player, sim });
    executeSlot(state.slotsById.get(b), { player, sim });
    executeSlot(state.slotsById.get(c), {
        player,
        sim,
        spellBook: {
            flame_strike: {
                id: 'flame_strike',
                element: 'fire',
                range: 3,
                cooldowns: { spell: { flame_strike: 2 } }
            }
        }
    });
    assert.strictEqual(floats.length, 2, 'text + passive emit FCT');
    assert.strictEqual(floats[0].text, 'Hello party');
    assert.ok(String(floats[1].text).indexOf('gift_of_life') >= 0);
    assert.strictEqual(floats[0].x, 3);
    assert.strictEqual(floats[0].y, 4);
    assert.strictEqual(player.commandQueue.length, 1, 'multi enqueues first ready spell');
    assert.strictEqual(player.commandQueue[0].type, 'CAST_SPELL');
    assert.strictEqual(player.commandQueue[0].spellId, 'flame_strike');
});

test('multi rotation skips empty middle and CD’d first spell', () => {
    initActionBars({});
    const slotId = state.docks.top[0].slots[0].id;
    assignSlot(slotId, 'multi', {
        multiActions: [
            {
                actionType: 'spell',
                spellId: 'flame_strike',
                targetMode: 'smart_target'
            },
            { actionType: 'empty' },
            {
                actionType: 'spell',
                spellId: 'heal_light',
                targetMode: 'self'
            }
        ]
    });
    const slot = state.slotsById.get(slotId);
    const spellBook = {
        flame_strike: {
            id: 'flame_strike',
            element: 'fire',
            cooldowns: { spell: { flame_strike: 4 }, primary: { attack: 2 } }
        },
        heal_light: {
            id: 'heal_light',
            element: 'healing',
            cooldowns: { spell: { heal_light: 1 }, primary: { healing: 1 } }
        }
    };
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        target: { id: 7, alive: true },
        cooldowns: Cooldowns.createCooldownState()
    };
    const ctx = { player, spellBook, itemDb: null };

    // Empty middle skipped; first filled ready → index 0
    assert.strictEqual(findNextAvailableMultiIndex(slot, ctx), 0);
    assert.strictEqual(getActiveMultiSubAction(slot, ctx).sub.spellId, 'flame_strike');

    // Put first spell on CD → rotate to heal (index 2), skipping empty index 1
    Cooldowns.ensureCooldowns(player);
    player.cooldowns.spell.flame_strike = 3;
    assert.strictEqual(isSubActionAvailable(slot.multiActions[0], ctx), false);
    assert.strictEqual(isSubActionAvailable(slot.multiActions[2], ctx), true);
    assert.strictEqual(findNextAvailableMultiIndex(slot, ctx), 2);

    player.commandQueue = [];
    executeSlot(slot, { player, spellBook });
    assert.strictEqual(player.commandQueue.length, 1);
    assert.strictEqual(player.commandQueue[0].spellId, 'heal_light');
    assert.strictEqual(player.commandQueue[0].target.kind, 'self');

    // Both on CD → index falls back to first filled for paint; execute no-ops
    player.cooldowns.spell.heal_light = 2;
    assert.strictEqual(findNextAvailableMultiIndex(slot, ctx), 0, 'paint fallback first filled');
    player.commandQueue = [];
    executeSlot(slot, { player, spellBook });
    assert.strictEqual(player.commandQueue.length, 0, 'no ready sub → no execute');

    // CD paint uses active (fallback) sub spec
    const cdSpec = resolveSlotCooldownSpec(slot, spellBook, null, player);
    assert.ok(cdSpec && cdSpec.spell && cdSpec.spell.flame_strike != null);
    const rem = getSpecRemainingSeconds(player, cdSpec);
    assert.ok(rem > 0);
});

test('multi rotation skips item with zero stack', () => {
    initActionBars({});
    const slotId = state.docks.top[0].slots[1].id;
    assignSlot(slotId, 'multi', {
        multiActions: [
            { actionType: 'item', itemId: 'rune_fireball', targetMode: 'self' },
            { actionType: 'spell', spellId: 'heal_light', targetMode: 'self' },
            { actionType: 'empty' }
        ]
    });
    const slot = state.slotsById.get(slotId);
    const spellBook = {
        heal_light: { id: 'heal_light', element: 'healing' }
    };
    // Inventory present but no runes → count 0 for item sub
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        inventory: {
            rootUid: 'bp',
            containers: { bp: { slots: [] } },
            items: {}
        },
        cooldowns: Cooldowns.createCooldownState()
    };
    const ctx = { player, spellBook, itemDb: null };
    assert.strictEqual(isSubActionAvailable(slot.multiActions[0], ctx), false);
    assert.strictEqual(findNextAvailableMultiIndex(slot, ctx), 1);
    executeSlot(slot, { player, spellBook });
    assert.strictEqual(player.commandQueue.length, 1);
    assert.strictEqual(player.commandQueue[0].spellId, 'heal_light');
});

const {
    filterSpells,
    spellBookToList,
    isBlockedHotkey,
    findGeneralHotkeyConflict,
    eventToHotkeyString,
    listKnownPassives,
    TEXT_MAX_LEN
} = require('../kernel/apps/game/action_bar_modals.js');

test('filterSpells filters by vocation, query, and sort', () => {
    const spells = spellBookToList([
        { id: 'a', label: 'Zap', vocations: ['mystic'], level: 20, group: 'attack' },
        { id: 'b', label: 'Heal', vocations: ['guardian'], level: 5, group: 'healing' },
        { id: 'c', label: 'Common Bolt', level: 1, group: 'attack' },
        { id: 'd', label: 'Alpha', vocations: ['mystic'], level: 2, group: 'support' }
    ]);
    const mystic = filterSpells(spells, { vocation: 'mystic', showAll: false, sort: 'name' });
    assert.deepStrictEqual(mystic.map((s) => s.id), ['d', 'c', 'a']);

    const q = filterSpells(spells, { query: 'heal', showAll: true });
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].id, 'b');

    const byLvl = filterSpells(spells, { showAll: true, sort: 'level' });
    assert.strictEqual(byLvl[0].id, 'c');
});

test('isBlockedHotkey rejects reserved bare keys', () => {
    assert.strictEqual(isBlockedHotkey('ESCAPE'), true);
    assert.strictEqual(isBlockedHotkey('W'), true);
    assert.strictEqual(isBlockedHotkey('ARROWUP'), true);
    assert.strictEqual(isBlockedHotkey('F1'), false);
    assert.strictEqual(isBlockedHotkey('SHIFT+W'), false);
    assert.strictEqual(isBlockedHotkey('1'), false);
});

test('findGeneralHotkeyConflict detects movement shortcuts', () => {
    const sc = { moveNorth: ['W', 'ARROWUP'], stopAutowalk: ['ESCAPE'] };
    assert.strictEqual(findGeneralHotkeyConflict('W', sc), 'moveNorth');
    assert.strictEqual(findGeneralHotkeyConflict('F5', sc), null);
});

test('eventToHotkeyString builds combo from keyboard-like events', () => {
    assert.strictEqual(
        eventToHotkeyString({ key: 'f1', ctrlKey: true, shiftKey: false, altKey: false }),
        'CTRL+F1'
    );
    assert.strictEqual(
        eventToHotkeyString({ key: ' ', ctrlKey: false, shiftKey: true, altKey: false }),
        'SHIFT+SPACE'
    );
    assert.strictEqual(eventToHotkeyString({ key: 'Shift' }), '');
});

test('listKnownPassives exposes stub registry', () => {
    const list = listKnownPassives();
    assert.ok(list.length >= 1);
    assert.strictEqual(list[0].id, 'gift_of_life');
    assert.ok(TEXT_MAX_LEN >= 120);
});

test('itemIsActionBarEquipable detects gear but not potions', () => {
    assert.strictEqual(
        itemIsActionBarEquipable(GEAR_ITEM_DB.find((i) => i.id === 'iron_longsword')),
        true
    );
    assert.strictEqual(
        itemIsActionBarEquipable(GEAR_ITEM_DB.find((i) => i.id === 'potion_healing')),
        false
    );
    assert.strictEqual(itemIsActionBarEquipable(null), false);
});

test('executeSlot equips and unequips gear by itemId (legacy equipItemId parity)', () => {
    initActionBars({ getItemDb: () => GEAR_ITEM_DB });
    const inv = buildInventoryFromSeed(
        {
            equipment: { backpack: 'backpack' },
            backpack: ['iron_longsword', 'steel_helm']
        },
        GEAR_ITEM_DB
    );
    let mutations = 0;
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        inventory: inv,
        applyInventoryMutation() {
            mutations += 1;
        }
    };

    const slotId = state.docks.bottom[0].slots[0].id;
    assignSlot(slotId, 'item', {
        itemId: 'iron_longsword',
        targetMode: 'self',
        hotkey: '1'
    });
    const slot = state.slotsById.get(slotId);

    assert.strictEqual(findEquippedSlotForItemId(inv, 'iron_longsword'), null);
    assert.strictEqual(countItemIdInInventoryTree(inv, 'iron_longsword'), 1);
    assert.strictEqual(countItemIdCarried(inv, 'iron_longsword'), 1);

    executeSlot(slot, { player, itemDb: GEAR_ITEM_DB });
    assert.strictEqual(player.commandQueue.length, 0, 'equip does not enqueue USE_ITEM');
    assert.strictEqual(findEquippedSlotForItemId(inv, 'iron_longsword'), 'rightHand');
    assert.strictEqual(countItemIdInInventoryTree(inv, 'iron_longsword'), 0);
    assert.strictEqual(countItemIdCarried(inv, 'iron_longsword'), 1);
    assert.strictEqual(mutations, 1);

    // Second click unequips back into backpack
    executeSlot(slot, { player, itemDb: GEAR_ITEM_DB });
    assert.strictEqual(findEquippedSlotForItemId(inv, 'iron_longsword'), null);
    assert.strictEqual(countItemIdInInventoryTree(inv, 'iron_longsword'), 1);
    assert.strictEqual(mutations, 2);

    // Owned-but-not-carried gear is a silent no-op (legacy zero-count guard)
    assignSlot(slotId, 'item', { itemId: 'leather_boots', hotkey: '1' });
    executeSlot(state.slotsById.get(slotId), { player, itemDb: GEAR_ITEM_DB });
    assert.strictEqual(player.commandQueue.length, 0);
    assert.strictEqual(findEquippedSlotForItemId(inv, 'leather_boots'), null);
    assert.strictEqual(mutations, 2, 'missing gear does not call applyInventoryMutation');
});

test('isSubActionAvailable treats equipped-only gear as ready', () => {
    initActionBars({ getItemDb: () => GEAR_ITEM_DB });
    const inv = buildInventoryFromSeed(
        {
            equipment: {
                backpack: 'backpack',
                rightHand: 'iron_longsword'
            },
            backpack: []
        },
        GEAR_ITEM_DB
    );
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        inventory: inv
    };
    const sub = {
        actionType: 'item',
        itemId: 'iron_longsword',
        targetMode: 'smart_target'
    };
    assert.strictEqual(
        countItemIdInInventoryTree(inv, 'iron_longsword'),
        0,
        'precondition: not in backpack tree'
    );
    assert.strictEqual(
        isSubActionAvailable(sub, { player, itemDb: GEAR_ITEM_DB }),
        true
    );
    // Toggle unequip via helper still works when only equipped
    const r = toggleEquipByItemId(player, 'iron_longsword', GEAR_ITEM_DB);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'unequip');
    assert.strictEqual(findEquippedSlotForItemId(inv, 'iron_longsword'), null);
});

test('executeSlot still queues USE_ITEM for consumables', () => {
    initActionBars({ getItemDb: () => GEAR_ITEM_DB });
    const player = {
        id: 1,
        alive: true,
        controlMode: 'manual',
        commandQueue: [],
        inventory: buildInventoryFromSeed(
            { equipment: { backpack: 'backpack' }, backpack: ['potion_healing'] },
            GEAR_ITEM_DB
        )
    };
    const slotId = state.docks.bottom[0].slots[1].id;
    assignSlot(slotId, 'item', {
        itemId: 'potion_healing',
        targetMode: 'self',
        hotkey: '2'
    });
    executeSlot(state.slotsById.get(slotId), { player, itemDb: GEAR_ITEM_DB });
    assert.strictEqual(player.commandQueue.length, 1);
    assert.strictEqual(player.commandQueue[0].type, 'USE_ITEM');
    assert.strictEqual(player.commandQueue[0].itemId, 'potion_healing');
});

test('buildStoragePayload round-trips layoutCounts via applyStoredPayload', () => {
    initActionBars({});
    setLayoutCounts({ top: 2, right: 0 }, { remount: false });
    const slotId = state.docks.bottom[0].slots[0].id;
    assignSlot(slotId, 'text', { text: 'round-trip', hotkey: '9' });

    const payload = buildStoragePayload();
    assert.strictEqual(payload.version, undefined, 'no storage version field');
    assert.strictEqual(payload.layoutCounts.top, 2);
    assert.strictEqual(payload.layoutCounts.right, 0);
    assert.strictEqual(payload.profiles.guardian.top.length, 2);
    assert.strictEqual(payload.profiles.guardian.right.length, 0);

    initActionBars({});
    assert.strictEqual(state.layoutCounts.top, 1);
    assert.strictEqual(applyStoredPayload(payload), true);
    assert.strictEqual(state.layoutCounts.top, 2);
    assert.strictEqual(state.layoutCounts.right, 0);
    assert.strictEqual(state.docks.top.length, 2);
    assert.strictEqual(state.docks.right.length, 0);
    assert.strictEqual(state.docks.bottom[0].slots[0].actionType, 'text');
    assert.strictEqual(state.docks.bottom[0].slots[0].text, 'round-trip');
});

test('coerceStoredPayload rejects invalid blobs and coerces current-schema docks', () => {
    assert.strictEqual(coerceStoredPayload(null), null);
    assert.strictEqual(coerceStoredPayload({}), null);

    const coerced = coerceStoredPayload({
        activeProfileId: 'guardian',
        layoutCounts: { top: 1, bottom: 1, left: 1, right: 1 },
        profiles: {
            guardian: {
                top: [{
                    id: 'top_1',
                    orientation: 'horizontal',
                    slots: [
                        { id: 'top_1_slot_0', index: 0, hotkey: 'F1', actionType: 'item', itemId: 'rune_fireball', targetMode: 'smart_target' }
                    ]
                }],
                bottom: [],
                left: [],
                right: []
            }
        }
    });
    assert.ok(coerced);
    assert.strictEqual(coerced.profiles.guardian.top[0].slots.length, SLOTS_PER_BAR);
    assert.strictEqual(coerced.profiles.guardian.top[0].slots[0].itemId, 'rune_fireball');
    assert.strictEqual(coerced.profiles.guardian.bottom.length, 1);
    assert.strictEqual(coerced.profiles.guardian.bottom[0].slots.length, SLOTS_PER_BAR);
});

test('normalizeSlot rejects unknown action types as empty', () => {
    const s = normalizeSlot({ actionType: 'not_a_type', spellId: 'x' }, 'top_1', 0);
    assert.strictEqual(s.actionType, 'empty');
    assert.strictEqual(s.spellId, null);
});

test('normalizeBar always yields SLOTS_PER_BAR and preserves assigned slots', () => {
    const bar = normalizeBar({
        id: 'bottom_1',
        orientation: 'horizontal',
        slots: [
            { id: 'bottom_1_slot_0', index: 0, hotkey: '1', actionType: 'spell', spellId: 'flame_strike', targetMode: 'smart_target' }
        ]
    }, 'bottom', 1);
    assert.strictEqual(bar.slots.length, SLOTS_PER_BAR);
    assert.strictEqual(bar.slots[0].spellId, 'flame_strike');
    assert.strictEqual(bar.slots[1].actionType, 'empty');
});

test('normalizeDocks pads missing bars to layoutCounts', () => {
    const docks = normalizeDocks({ top: [] }, { top: 2, bottom: 0, left: 1, right: 1 });
    assert.strictEqual(docks.top.length, 2);
    assert.strictEqual(docks.bottom.length, 0);
    assert.strictEqual(docks.left.length, 1);
    assert.strictEqual(docks.top[0].slots.length, SLOTS_PER_BAR);
    assert.strictEqual(docks.top[1].id, 'top_2');
});

// ── Stage D: carousel pageOffset ────────────────────────────────────────────

test('maxPageOffsetForBar / clampBarPageOffset respect VISIBLE_CAP', () => {
    initActionBars({});
    const bar = state.docks.bottom[0];
    assert.strictEqual(bar.orientation, 'horizontal');
    assert.strictEqual(maxPageOffsetForBar(bar), SLOTS_PER_BAR - VISIBLE_CAP_HORIZONTAL);
    bar.pageOffset = 999;
    assert.strictEqual(clampBarPageOffset(bar), SLOTS_PER_BAR - VISIBLE_CAP_HORIZONTAL);
    bar.pageOffset = -3;
    assert.strictEqual(clampBarPageOffset(bar), 0);
    const vbar = state.docks.left[0];
    assert.strictEqual(maxPageOffsetForBar(vbar), SLOTS_PER_BAR - VISIBLE_CAP_VERTICAL);
});

test('setBarPageOffset / shiftBarPage update state without remount', () => {
    initActionBars({});
    const bar = state.docks.bottom[0];
    const max = maxPageOffsetForBar(bar);
    assert.strictEqual(setBarPageOffset(bar.id, 5, { remount: false, save: false }), 5);
    assert.strictEqual(bar.pageOffset, 5);
    assert.strictEqual(shiftBarPage(bar.id, 2, { remount: false, save: false }), 7);
    assert.strictEqual(shiftBarPage(bar.id, -100, { remount: false, save: false }), 0);
    assert.strictEqual(setBarPageOffset(bar.id, max + 50, { remount: false, save: false }), max);
    assert.strictEqual(setBarPageOffset('missing_bar', 1, { remount: false, save: false }), null);
});

test('visibleRangeForBar window size matches cap; last page still fills', () => {
    initActionBars({});
    const bar = state.docks.bottom[0];
    bar.pageOffset = 0;
    let r = visibleRangeForBar(bar);
    assert.strictEqual(r.start, 0);
    assert.strictEqual(r.end, VISIBLE_CAP_HORIZONTAL);
    assert.strictEqual(r.end - r.start, VISIBLE_CAP_HORIZONTAL);

    bar.pageOffset = maxPageOffsetForBar(bar);
    r = visibleRangeForBar(bar);
    assert.strictEqual(r.end, SLOTS_PER_BAR);
    assert.strictEqual(r.end - r.start, VISIBLE_CAP_HORIZONTAL);
    assert.strictEqual(r.start, SLOTS_PER_BAR - VISIBLE_CAP_HORIZONTAL);
});

test('normalizeBar clamps pageOffset to max window', () => {
    const bar = normalizeBar({
        id: 'bottom_1',
        orientation: 'horizontal',
        pageOffset: 999,
        slots: []
    }, 'bottom', 1);
    assert.strictEqual(bar.pageOffset, SLOTS_PER_BAR - VISIBLE_CAP_HORIZONTAL);
});

test('hotkeysMap still binds slots beyond visible window', () => {
    initActionBars({});
    const bar = state.docks.bottom[0];
    bar.pageOffset = 0;
    const far = bar.slots[20];
    assignSlot(far.id, 'spell', { spellId: 'heal_light', hotkey: 'F8' });
    assert.strictEqual(state.hotkeysMap.get('F8'), far.id);
    assert.ok(findBarById(bar.id));
    // Off-page execute still resolves via maps (no DOM required)
    const slot = state.slotsById.get(far.id);
    assert.strictEqual(slot.spellId, 'heal_light');
    assert.strictEqual(slot.index, 20);
});

test('pageOffset round-trips in storage payload', () => {
    initActionBars({});
    setBarPageOffset(state.docks.bottom[0].id, 7, { remount: false, save: false });
    const payload = buildStoragePayload();
    assert.strictEqual(payload.profiles[state.activeProfileId].bottom[0].pageOffset, 7);
    initActionBars({});
    assert.strictEqual(state.docks.bottom[0].pageOffset, 0);
    applyStoredPayload(payload);
    assert.strictEqual(state.docks.bottom[0].pageOffset, 7);
});

// ── Stage G: lock bar + clear bar ──────────────────────────────────────────

test('setBarLocked blocks assignSlot but keeps hotkey map', () => {
    initActionBars({});
    const bar = state.docks.bottom[0];
    const slotId = bar.slots[0].id;
    assert.strictEqual(setBarLocked(bar.id, true, { remount: false, save: false }), true);
    assert.strictEqual(bar.locked, true);
    assert.strictEqual(isSlotBarLocked(slotId), true);
    assert.strictEqual(findBarForSlotId(slotId), bar);
    assert.strictEqual(assignSlot(slotId, 'spell', { spellId: 'heal_light', hotkey: 'F9' }), false);
    assert.strictEqual(state.slotsById.get(slotId).actionType, 'empty');
    // Unlock then assign works
    assert.strictEqual(toggleBarLocked(bar.id, { remount: false, save: false }), false);
    assert.strictEqual(bar.locked, false);
    assert.strictEqual(assignSlot(slotId, 'spell', { spellId: 'heal_light', hotkey: 'F9' }), true);
    assert.strictEqual(state.slotsById.get(slotId).spellId, 'heal_light');
    assert.strictEqual(state.hotkeysMap.get('F9'), slotId);
});

test('clearBar empties actions and keeps hotkeys by default', () => {
    initActionBars({});
    const bar = state.docks.top[0];
    const a = bar.slots[0].id;
    const b = bar.slots[1].id;
    assignSlot(a, 'spell', { spellId: 'heal_light', hotkey: '1' });
    assignSlot(b, 'text', { text: 'hi', hotkey: '2' });
    const n = clearBar(bar.id, { remount: false, save: false });
    assert.ok(n >= 2, 'cleared at least two slots');
    assert.strictEqual(state.slotsById.get(a).actionType, 'empty');
    assert.strictEqual(state.slotsById.get(a).spellId, null);
    assert.strictEqual(state.slotsById.get(a).hotkey, '1', 'hotkey preserved');
    assert.strictEqual(state.slotsById.get(b).text, null);
    assert.strictEqual(state.slotsById.get(b).hotkey, '2');
});

test('clearBar is blocked when bar is locked', () => {
    initActionBars({});
    const bar = state.docks.left[0];
    const slotId = bar.slots[0].id;
    assignSlot(slotId, 'item', { itemId: 'rune_fireball', hotkey: '3' });
    setBarLocked(bar.id, true, { remount: false, save: false });
    assert.strictEqual(clearBar(bar.id, { remount: false, save: false }), -1);
    assert.strictEqual(state.slotsById.get(slotId).actionType, 'item');
});

test('locked flag round-trips in storage payload', () => {
    initActionBars({});
    setBarLocked(state.docks.right[0].id, true, { remount: false, save: false });
    const payload = buildStoragePayload();
    assert.strictEqual(payload.profiles[state.activeProfileId].right[0].locked, true);
    initActionBars({});
    assert.strictEqual(state.docks.right[0].locked, false);
    applyStoredPayload(payload);
    assert.strictEqual(state.docks.right[0].locked, true);
});

test('slotAriaLabel describes empty and assigned slots', () => {
    initActionBars({});
    const empty = state.docks.bottom[0].slots[3];
    empty.hotkey = 'F4';
    const labelEmpty = slotAriaLabel(empty, null, null);
    assert.ok(labelEmpty.indexOf('Slot 4') >= 0);
    assert.ok(labelEmpty.indexOf('Empty') >= 0);
    assert.ok(labelEmpty.indexOf('F4') >= 0);
    assert.strictEqual(describeSlotAction({ actionType: 'multi', multiActions: [
        { actionType: 'spell', spellId: 'a' },
        { actionType: 'empty' },
        { actionType: 'item', itemId: 'b' }
    ] }, null, null).indexOf('Multi') >= 0, true);
});

console.log(`\nAll ${passed} Action Bars tests passed successfully!`);

