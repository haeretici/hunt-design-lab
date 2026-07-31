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
    state
} = require('../kernel/apps/game/action_bars.js');
const { createActionBarParentBridge } = require('../html/widgets/action_bar_config/parent_bridge.js');
const { uiState, clearTargetCursorMode } = require('../kernel/apps/game/ui_state.js');
const Cooldowns = require('../kernel/core/lib/combat/cooldowns.js');
const { Settings } = require('../kernel/settings.js');

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

    assert.strictEqual(state.docks.top[0].slots.length, 12, 'Top bar defaults to 12 slots');
    assert.strictEqual(state.docks.bottom[0].slots.length, 12, 'Bottom bar defaults to 12 slots');
    assert.strictEqual(state.docks.left[0].slots.length, 10, 'Left bar defaults to 10 slots');
    assert.strictEqual(state.docks.right[0].slots.length, 10, 'Right bar defaults to 10 slots');
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

    executeSlot(slot, { player });
    assert.strictEqual(player.commandQueue.length, 0, 'No direct command dispatched yet');
    assert.ok(uiState.activeActionCursor != null, 'Crosshair targeting mode entered');
    assert.strictEqual(uiState.activeActionCursor.type, 'USE_ITEM_WITH');
    assert.strictEqual(uiState.activeActionCursor.itemId, 'rune_deathburst');
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

test('migrateLegacyProfiles maps default profile to active character class', () => {
    const { migrateLegacyProfiles, initDefaultDocksData } = require('../kernel/apps/game/action_bars.js');
    const dummyDocks = initDefaultDocksData();
    const result = migrateLegacyProfiles({ default: dummyDocks }, 'default');
    assert.strictEqual(result.activeProfileId, 'guardian', 'Legacy default activeProfileId should migrate to guardian');
    assert.ok(result.profiles.guardian != null, 'Legacy default profile settings transferred to guardian');
    assert.strictEqual(result.profiles.default, undefined, 'Legacy default profile removed');
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

console.log(`\nAll ${passed} Action Bars tests passed successfully!`);

