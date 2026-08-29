/**
 * Canvas mouse action dispatcher — pure hit resolve + intent matrix.
 *
 * Modes 0/1/2 live. Classic unshifted RMB: useThing (open/use) before pickup
 * (legacy parity). Stage 5a: QUICKLOOT / OPEN_CORPSE stubs. Stage 6b: TALK_NPC
 * is an adapter intent (walk-then-talk; stub only when the NPC has no dialog).
 * Stage 7: Classic LMB+RMB Look chord + moveStack amount rules (pure).
 * Stage 8: Browse Field (virtual tile container).
 * Ground drag stays in inventory_panel (Q1.1 A).
 *
 * See docs/29_mouse_control_modes_and_action_mapping.md.
 */

'use strict';

const { findItem } = require('../../core/lib/character/stats.js');
const {
    getItem,
    preferredEquipSlot,
    itemIsEquipable,
    itemIsContainer,
    itemIsUsable,
    itemIsMultiUse
} = require('../../core/lib/character/inventory.js');
const { getStack } = require('../../core/lib/character/ground_items.js');
const { findPath } = require('../../core/lib/pathfinder.js');
const {
    isTalkableNpc,
    isAttackableCreature
} = require('../../core/lib/npc/flags.js');
const { hopsOnStep } = require('../../core/entities/tilemap.js');
const { worldPinUseReady } = require('../../core/lib/dungeon/world_pins.js');

/** Browse Field virtual capacity (legacy create size 30). */
const BROWSE_FIELD_CAPACITY = 30;
/** Open range: player tile or adjacent (Chebyshev ≤ 1, same floor). */
const BROWSE_FIELD_RANGE = 1;
/** Talk initiate / stay range (Chebyshev, same floor). Client lock; not server 4. */
const TALK_NPC_RANGE = 3;

/**
 * Fields / immovables live on the ground stack but cannot be collected.
 * Synthetic field instances often lack item-DB templates.
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} template
 * @returns {boolean}
 */
function isImmovableGroundInst(inst, template) {
    if (!inst) return true;
    if (inst.isField || inst.immovable || inst.immovableField) return true;
    if (
        template &&
        (template.isField || template.immovable || template.immovableField)
    ) {
        return true;
    }
    return false;
}

/**
 * Top-most non-immovable ground uid on the tile (loot under fields), or null.
 * @param {object} ground ground store with inventory
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @returns {string|null}
 */
function topPickableUid(ground, x, y, z, itemDb) {
    if (!ground || !ground.inventory) return null;
    const stack = getStack(ground, x, y, z);
    for (let i = stack.length - 1; i >= 0; i--) {
        const uid = stack[i];
        if (!uid) continue;
        const inst = getItem(ground.inventory, uid);
        if (!inst) continue;
        const template = findItem(itemDb, inst.itemId);
        if (!isImmovableGroundInst(inst, template)) return uid;
    }
    return null;
}

/**
 * Living creature on tile (excludes excludeId, typically the active player).
 * @param {object|null|undefined} sim
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {number|string|null|undefined} excludeId
 * @returns {object|null}
 */
function findCreatureAtTile(sim, x, y, z, excludeId) {
    if (!sim || !Array.isArray(sim.creatures)) return null;
    for (let i = 0; i < sim.creatures.length; i++) {
        const c = sim.creatures[i];
        if (
            c &&
            c.alive &&
            c.tile &&
            c.tile.x === x &&
            c.tile.y === y &&
            String(c.tile.z) === String(z) &&
            c.id !== excludeId
        ) {
            return c;
        }
    }
    return null;
}

/**
 * Equipment / items with a preferred equip slot get the View details modal.
 * Everything else uses Look → FCT.
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function itemSupportsDetailsModal(item) {
    if (!item || typeof item !== 'object') return false;
    if (itemIsEquipable(item)) return true;
    return preferredEquipSlot(item) != null;
}

/**
 * Prefer template label; then instance name; then itemId; else fallback.
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} template
 * @param {string} [fallback]
 * @returns {string}
 */
function thingLabel(inst, template, fallback) {
    if (template) {
        const t =
            template.label || template.name || template.id || null;
        if (t != null && String(t).trim() !== '') return String(t);
    }
    if (inst) {
        if (inst.name != null && String(inst.name).trim() !== '') {
            return String(inst.name);
        }
        if (inst.label != null && String(inst.label).trim() !== '') {
            return String(inst.label);
        }
        if (inst.itemId != null && String(inst.itemId).trim() !== '') {
            return String(inst.itemId).replace(/_/g, ' ');
        }
    }
    return fallback != null ? String(fallback) : 'Item';
}

/**
 * Creature display name for Look FCT.
 * @param {object|null|undefined} creature
 * @returns {string}
 */
function creatureLookText(creature) {
    if (!creature) return 'Creature';
    const name =
        creature.name ||
        creature.label ||
        creature.templateId ||
        creature.id ||
        'Creature';
    return String(name);
}

/**
 * Resolve canvas tile hit into look/use/creature/stack fields (no DOM).
 *
 * @param {object} opts
 * @param {object} opts.sim
 * @param {object|null|undefined} opts.player active player (for exclude + isPlayerTile)
 * @param {{ x: number, y: number, z: string|number }} opts.tile
 * @param {object[]|Record<string, object>|null|undefined} [opts.itemDb]
 * @returns {object|null}
 */
function resolveCanvasHit(opts) {
    const o = opts || {};
    const sim = o.sim;
    const player = o.player;
    const tile = o.tile;
    const itemDb = o.itemDb;
    if (!sim || !tile || tile.x == null || tile.y == null) return null;

    const x = tile.x;
    const y = tile.y;
    const z = tile.z;
    const excludeId = player && player.id != null ? player.id : null;
    const creature = findCreatureAtTile(sim, x, y, z, excludeId);

    const ground = sim.groundItems || null;
    const stackUids = ground ? getStack(ground, x, y, z) : [];
    const pickableUid = ground ? topPickableUid(ground, x, y, z, itemDb) : null;
    const rawTopUid = stackUids.length ? stackUids[stackUids.length - 1] : null;

    let pickableInst = null;
    let pickableItem = null;
    if (pickableUid && ground && ground.inventory) {
        pickableInst = getItem(ground.inventory, pickableUid);
        pickableItem = pickableInst ? findItem(itemDb, pickableInst.itemId) : null;
    }

    let rawTopInst = null;
    let rawTopItem = null;
    let rawTopImmovable = false;
    if (rawTopUid && ground && ground.inventory) {
        rawTopInst = getItem(ground.inventory, rawTopUid);
        rawTopItem = rawTopInst ? findItem(itemDb, rawTopInst.itemId) : null;
        rawTopImmovable = isImmovableGroundInst(rawTopInst, rawTopItem);
    }

    const isPlayerTile = !!(
        player &&
        player.tile &&
        player.tile.x === x &&
        player.tile.y === y &&
        String(player.tile.z) === String(z)
    );

    const talkable = isTalkableNpc(creature);
    const corpseLike = flagCorpseLike(pickableInst, pickableItem, rawTopInst, rawTopItem);
    /** Stage 8: ground stack uids for Browse Field (top-first; fields excluded). */
    const browsableUids = ground
        ? listBrowsableStackUids(ground, x, y, z, itemDb)
        : [];

    const stair = resolveHitStair(sim, x, y, z);
    const useStair = !!(stair && !hopsOnStep(stair.type));

    return {
        x,
        y,
        z,
        stair,
        useStair,
        creature,
        creatureId: creature ? creature.id : null,
        /** Stage 6a: true when creature is talkable NPC (content flags). */
        isNpc: talkable,
        /** Stage 5a: true when top ground thing is corpse-like (content flags). */
        isCorpse: corpseLike,
        stackUids,
        browsableUids,
        pickableUid,
        pickableInst,
        pickableItem,
        rawTopUid,
        rawTopInst,
        rawTopItem,
        rawTopImmovable,
        isPlayerTile
    };
}

/**
 * Registered pad under the hit tile, or null.
 * @param {object|null|undefined} sim
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {object|null}
 */
function resolveHitStair(sim, x, y, z) {
    const map = sim && sim.tileMap;
    if (!map || typeof map.getStair !== 'function') return null;
    return map.getStair(x, y, z) || null;
}

/**
 * Use-on-tile for ladders (and other non-step pads).
 * @param {object|null|undefined} hit
 * @returns {object[]|null}
 */
function useStairIntents(hit) {
    if (!hit || !hit.useStair) return null;
    return [
        {
            type: 'USE_STAIR',
            dest: { x: hit.x, y: hit.y, z: hit.z }
        }
    ];
}

/**
 * Pure field / hazard entity — never a Browse Field slot (Q8.8).
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} template
 * @returns {boolean}
 */
function isFieldGroundEntity(inst, template) {
    if (!inst) return true;
    if (inst.isField || inst.immovableField) return true;
    if (
        template &&
        (template.isField || template.immovableField)
    ) {
        return true;
    }
    return false;
}

/**
 * True when ground instance may appear in Browse Field slots.
 * Engine v1: all stack items except pure fields (Q8.8).
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} template
 * @returns {boolean}
 */
function isBrowsableGroundInst(inst, template) {
    if (!inst) return false;
    return !isFieldGroundEntity(inst, template);
}

/**
 * Tile key for Browse Field panels (matches ground_items tileKey).
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @returns {string}
 */
function browseFieldTileKey(x, y, z) {
    return `${String(z)}:${Math.round(x)}:${Math.round(y)}`;
}

/**
 * Browsable ground uids on a tile, **top of stack first** (legacy rbegin).
 * @param {object|null|undefined} ground
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {object[]|Record<string, object>|null|undefined} itemDb
 * @returns {string[]}
 */
function listBrowsableStackUids(ground, x, y, z, itemDb) {
    if (!ground || !ground.inventory) return [];
    const stack = getStack(ground, x, y, z);
    /** @type {string[]} */
    const out = [];
    for (let i = stack.length - 1; i >= 0; i--) {
        const uid = stack[i];
        if (!uid) continue;
        const inst = getItem(ground.inventory, uid);
        if (!inst) continue;
        const template = findItem(itemDb, inst.itemId);
        if (!isBrowsableGroundInst(inst, template)) continue;
        out.push(uid);
    }
    return out;
}

/**
 * Hit has ≥1 browsable ground item (menu enable Q8.2 / Q8.10).
 * @param {object|null|undefined} hit
 * @param {object[]|Record<string, object>|null|undefined} [itemDb]
 * @returns {boolean}
 */
function hitHasBrowsableItems(hit, itemDb) {
    if (!hit || typeof hit !== 'object') return false;
    if (Array.isArray(hit.browsableUids)) {
        return hit.browsableUids.length > 0;
    }
    // Fallback when hit lacks browsableUids (tests / synthetic hits)
    if (!Array.isArray(hit.stackUids) || hit.stackUids.length === 0) {
        return false;
    }
    if (hit.pickableUid) return true;
    // stack present but only fields: no pickable → not browsable without filter
    if (itemDb && hit.stackUids) {
        // Without ground store we cannot re-resolve; use pickable as proxy
        return false;
    }
    return false;
}

/**
 * Player may open Browse Field immediately (Chebyshev ≤ 1, same floor).
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} playerTile
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} tile
 * @returns {boolean}
 */
function isInBrowseOpenRange(playerTile, tile) {
    return chebyshevSameFloor(playerTile, tile) <= BROWSE_FIELD_RANGE;
}

/**
 * Build BROWSE_FIELD adapter intent (Q8.7).
 * @param {{ x: number, y: number, z?: string|number }|object} tileOrHit
 * @returns {{ type: string, x: number, y: number, z: string|number }}
 */
function buildBrowseFieldIntent(tileOrHit) {
    const t = tileOrHit || {};
    const x = t.x != null ? t.x : t.tile && t.tile.x;
    const y = t.y != null ? t.y : t.tile && t.tile.y;
    const z =
        t.z != null
            ? t.z
            : t.tile && t.tile.z != null
              ? t.tile.z
              : 0;
    return {
        type: 'BROWSE_FIELD',
        x: Math.round(Number(x) || 0),
        y: Math.round(Number(y) || 0),
        z: z != null ? z : 0
    };
}

/**
 * Resolve in-range vs walk-then-act vs cancel.
 * Browse Field uses maxDist 1; NPC talk uses maxDist 3.
 *
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} playerTile
 * @param {object|null|undefined} tileMap
 * @param {{ x: number, y: number, z?: string|number }} target
 * @param {number} [maxDist=1] Chebyshev inclusive, same floor
 * @returns {{ status: 'in_range' }|{ status: 'wrong_floor' }|{ status: 'no_path' }|{ status: 'walk', dest: { x: number, y: number, z: string|number } }}
 */
function resolveApproach(playerTile, tileMap, target, maxDist) {
    if (!playerTile || !target || target.x == null || target.y == null) {
        return { status: 'no_path' };
    }
    const raw = Number(maxDist);
    const lim =
        Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : BROWSE_FIELD_RANGE;
    const tx = Math.round(target.x);
    const ty = Math.round(target.y);
    const tz = target.z !== undefined && target.z !== null ? target.z : 0;
    const px = Math.round(playerTile.x);
    const py = Math.round(playerTile.y);
    const pz =
        playerTile.z !== undefined && playerTile.z !== null ? playerTile.z : 0;

    if (String(pz) !== String(tz)) {
        return { status: 'wrong_floor' };
    }
    if (Math.max(Math.abs(px - tx), Math.abs(py - ty)) <= lim) {
        return { status: 'in_range' };
    }

    /**
     * @param {number} nx
     * @param {number} ny
     * @returns {boolean}
     */
    function tileEnterable(nx, ny) {
        if (!tileMap) return true;
        if (typeof tileMap.isTileWalkable === 'function') {
            return !!tileMap.isTileWalkable(nx, ny, tz);
        }
        if (typeof tileMap.canEnter === 'function') {
            return !!tileMap.canEnter(nx, ny, tz);
        }
        return true;
    }

    let best = null;
    let bestLen = Infinity;
    let bestManh = Infinity;
    let bestToTarget = Infinity;

    /**
     * Prefer shorter path (or Chebyshev when there is no map). Equal length
     * used to pick the NW scan-order tile — alcove (3,0) beat corridor (3,3)
     * on npc_talk_lab. Tie-break toward the player→target axis.
     * @param {number} nx
     * @param {number} ny
     * @param {number} len
     */
    function consider(nx, ny, len) {
        const manh = Math.abs(px - nx) + Math.abs(py - ny);
        const toTarget = Math.abs(nx - tx) + Math.abs(ny - ty);
        if (
            len > bestLen ||
            (len === bestLen && manh > bestManh) ||
            (len === bestLen && manh === bestManh && toTarget >= bestToTarget)
        ) {
            return;
        }
        bestLen = len;
        bestManh = manh;
        bestToTarget = toTarget;
        best = { x: nx, y: ny, z: tz };
    }

    for (let dy = -lim; dy <= lim; dy++) {
        for (let dx = -lim; dx <= lim; dx++) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (!tileEnterable(nx, ny)) continue;
            if (nx === px && ny === py) {
                return { status: 'in_range' };
            }
            if (!tileMap) {
                consider(
                    nx,
                    ny,
                    Math.max(Math.abs(px - nx), Math.abs(py - ny))
                );
                continue;
            }
            const path = findPath(
                tileMap,
                { x: px, y: py, z: tz },
                { x: nx, y: ny, z: tz },
                {
                    checkOccupied: false,
                    maxIterations: 512
                }
            );
            if (!path || !path.length) continue;
            consider(nx, ny, path.length);
        }
    }
    if (!best) return { status: 'no_path' };
    return { status: 'walk', dest: best };
}

/**
 * Resolve open vs walk-then-browse vs cancel (Chebyshev ≤ 1).
 *
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} playerTile
 * @param {object|null|undefined} tileMap
 * @param {{ x: number, y: number, z?: string|number }} target
 * @returns {{ status: 'in_range' }|{ status: 'wrong_floor' }|{ status: 'no_path' }|{ status: 'walk', dest: { x: number, y: number, z: string|number } }}
 */
function resolveBrowseFieldApproach(playerTile, tileMap, target) {
    return resolveApproach(playerTile, tileMap, target, BROWSE_FIELD_RANGE);
}

/**
 * Instance/template corpse markers (content will set these when corpses ship).
 * @param {object|null|undefined} inst
 * @param {object|null|undefined} item
 * @returns {boolean}
 */
function thingIsCorpse(inst, item) {
    if (inst && (inst.isCorpse === true || inst.corpse === true)) return true;
    if (item) {
        if (item.isCorpse === true || item.corpse === true) return true;
        const kind = item.kind != null ? String(item.kind).toLowerCase() : '';
        if (kind === 'corpse') return true;
        const cat =
            item.category != null ? String(item.category).toLowerCase() : '';
        if (cat === 'corpse') return true;
    }
    return false;
}

/**
 * @param {object|null|undefined} pickableInst
 * @param {object|null|undefined} pickableItem
 * @param {object|null|undefined} rawTopInst
 * @param {object|null|undefined} rawTopItem
 * @returns {boolean}
 */
function flagCorpseLike(pickableInst, pickableItem, rawTopInst, rawTopItem) {
    return (
        thingIsCorpse(pickableInst, pickableItem) ||
        thingIsCorpse(rawTopInst, rawTopItem)
    );
}

/**
 * True if hit is a corpse-like world target (Stage 5a/5b).
 * Accepts resolveCanvasHit output or a synthetic hit with `isCorpse: true`.
 * @param {object|null|undefined} hit
 * @returns {boolean}
 */
function isCorpseLike(hit) {
    if (!hit || typeof hit !== 'object') return false;
    if (hit.isCorpse === true) return true;
    return flagCorpseLike(
        hit.pickableInst,
        hit.pickableItem,
        hit.rawTopInst,
        hit.rawTopItem
    );
}

/**
 * Normalize modifier bag from event-like input.
 * @param {{ shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean }|null|undefined} m
 * @returns {{ shift: boolean, ctrl: boolean, alt: boolean }}
 */
function normalizeModifiers(m) {
    const o = m || {};
    return {
        shift: !!o.shift,
        ctrl: !!(o.ctrl || o.meta),
        alt: !!o.alt
    };
}

/**
 * Build pure Look intent for a hit (modal for equipment, FCT otherwise).
 * Priority: creature > pickable > raw top (field) > empty tile.
 * @param {object} hit
 * @returns {object}
 */
function buildLookIntent(hit) {
    if (!hit) {
        return { type: 'LOOK', style: 'fct', text: 'Nothing here.' };
    }

    if (hit.creature) {
        return {
            type: 'LOOK',
            style: 'fct',
            text: creatureLookText(hit.creature),
            creature: hit.creature,
            tile: { x: hit.x, y: hit.y, z: hit.z }
        };
    }

    if (hit.pickableUid && hit.pickableItem && itemSupportsDetailsModal(hit.pickableItem)) {
        return {
            type: 'LOOK',
            style: 'modal',
            item: hit.pickableItem,
            itemInst: hit.pickableInst,
            pickableUid: hit.pickableUid,
            tile: { x: hit.x, y: hit.y, z: hit.z }
        };
    }

    if (hit.pickableUid) {
        const label = thingLabel(hit.pickableInst, hit.pickableItem, 'Item');
        return {
            type: 'LOOK',
            style: 'fct',
            text: label,
            pickableUid: hit.pickableUid,
            item: hit.pickableItem,
            itemInst: hit.pickableInst,
            tile: { x: hit.x, y: hit.y, z: hit.z }
        };
    }

    if (hit.rawTopUid) {
        const label = thingLabel(hit.rawTopInst, hit.rawTopItem, 'Object');
        return {
            type: 'LOOK',
            style: 'fct',
            text: label,
            rawTopUid: hit.rawTopUid,
            item: hit.rawTopItem,
            itemInst: hit.rawTopInst,
            tile: { x: hit.x, y: hit.y, z: hit.z }
        };
    }

    const zPart =
        hit.z != null && hit.z !== 0 ? `, z ${hit.z}` : '';
    return {
        type: 'LOOK',
        style: 'fct',
        text: `Tile (${hit.x}, ${hit.y}${zPart})`,
        tile: { x: hit.x, y: hit.y, z: hit.z }
    };
}

/**
 * Pure context-menu entry list for any tile (adapter builds DOM).
 * @param {object} hit
 * @param {object} [opts]
 * @param {boolean} [opts.includeStubs=true]
 * @returns {object[]}
 */
function buildCanvasContextMenuEntries(hit, opts) {
    const o = opts || {};
    const includeStubs = o.includeStubs !== false;
    const entries = [];
    if (!hit) return entries;

    const showImmovableNote = !!(
        hit.rawTopUid &&
        hit.pickableUid &&
        hit.rawTopUid !== hit.pickableUid &&
        hit.rawTopImmovable
    );
    if (showImmovableNote) {
        entries.push({
            id: 'immovable_note',
            label:
                thingLabel(hit.rawTopInst, hit.rawTopItem, 'Object') +
                ' (immovable)',
            disabled: true
        });
    }

    // Look always first (actionable)
    if (hit.creature) {
        entries.push({
            id: 'look',
            label: 'Look',
            lookStyle: 'fct',
            text: creatureLookText(hit.creature),
            creature: hit.creature
        });
        if (isAttackableCreature(hit.creature, hit)) {
            entries.push({
                id: 'attack',
                label: 'Attack',
                targetId: hit.creature.id,
                creature: hit.creature
            });
        }
        // Stage 6b: Talk reserved for talkable NPCs (adapter opens dialog)
        if (isTalkableNpc(hit.creature) || hit.isNpc === true) {
            entries.push({
                id: 'talk',
                label: 'Talk',
                stub: !npcHasDialogData(hit.creature),
                creature: hit.creature,
                creatureId: hit.creature.id,
                tile: { x: hit.x, y: hit.y, z: hit.z }
            });
        }
    } else if (
        hit.pickableUid &&
        hit.pickableItem &&
        itemSupportsDetailsModal(hit.pickableItem)
    ) {
        entries.push({
            id: 'view_details',
            label: 'View details',
            item: hit.pickableItem,
            itemInst: hit.pickableInst,
            pickableUid: hit.pickableUid
        });
    } else if (hit.pickableUid) {
        entries.push({
            id: 'look',
            label: 'Look',
            lookStyle: 'fct',
            text: thingLabel(hit.pickableInst, hit.pickableItem, 'Item'),
            pickableUid: hit.pickableUid,
            item: hit.pickableItem,
            itemInst: hit.pickableInst
        });
    } else if (hit.rawTopUid) {
        entries.push({
            id: 'look',
            label: 'Look',
            lookStyle: 'fct',
            text: thingLabel(hit.rawTopInst, hit.rawTopItem, 'Object'),
            rawTopUid: hit.rawTopUid,
            item: hit.rawTopItem,
            itemInst: hit.rawTopInst
        });
    } else {
        const zPart =
            hit.z != null && hit.z !== 0 ? `, z ${hit.z}` : '';
        entries.push({
            id: 'look',
            label: 'Look',
            lookStyle: 'fct',
            text: `Tile (${hit.x}, ${hit.y}${zPart})`
        });
    }

    if (hit.useStair) {
        entries.push({
            id: 'use_stair',
            label: 'Use',
            dest: { x: hit.x, y: hit.y, z: hit.z },
            stair: hit.stair
        });
    }

    if (hitHasWorldPinTop(hit)) {
        const kind = hit.rawTopInst.worldPinKind;
        if (kind === 'container') {
            if (
                !(
                    hit.pickableUid &&
                    hit.pickableUid === hit.rawTopUid &&
                    hit.pickableItem &&
                    itemIsContainer(hit.pickableItem)
                )
            ) {
                entries.push({
                    id: 'open',
                    label: 'Open',
                    sourceUid: hit.rawTopUid,
                    itemId:
                        (hit.rawTopItem && hit.rawTopItem.id) ||
                        (hit.rawTopInst && hit.rawTopInst.itemId),
                    ground: true,
                    tile: { x: hit.x, y: hit.y, z: hit.z }
                });
            }
        } else if (kind !== 'trap') {
            entries.push({
                id: 'use',
                label: 'Use',
                stub: !worldPinUseReady(kind),
                sourceUid: hit.rawTopUid,
                itemId:
                    (hit.rawTopItem && hit.rawTopItem.id) ||
                    (hit.rawTopInst && hit.rawTopInst.itemId),
                worldPinKind: kind,
                tile: { x: hit.x, y: hit.y, z: hit.z }
            });
        }
    }

    if (hit.pickableUid) {
        const label = thingLabel(hit.pickableInst, hit.pickableItem, 'Item');
        entries.push({
            id: 'pickup',
            label: `Pick up ${label}`,
            pickableUid: hit.pickableUid,
            pickableInst: hit.pickableInst,
            pickableItem: hit.pickableItem
        });

        if (hit.pickableItem && itemIsUsable(hit.pickableItem)) {
            entries.push({
                id: 'use',
                label: 'Use',
                sourceUid: hit.pickableUid,
                itemId: hit.pickableItem.id || hit.pickableInst && hit.pickableInst.itemId
            });
        }
        if (hit.pickableItem && itemIsMultiUse(hit.pickableItem)) {
            entries.push({
                id: 'use_with',
                label: 'Use with...',
                sourceUid: hit.pickableUid,
                itemId: hit.pickableItem.id || hit.pickableInst && hit.pickableInst.itemId
            });
        }
        if (hit.pickableItem && itemIsContainer(hit.pickableItem)) {
            const pinKind = hit.pickableInst && hit.pickableInst.worldPinKind;
            if (!pinKind || pinKind === 'container') {
                entries.push({
                    id: 'open',
                    label: 'Open',
                    sourceUid: hit.pickableUid,
                    itemId: hit.pickableItem.id || hit.pickableInst && hit.pickableInst.itemId,
                    ground: true
                });
            }
        }
    }

    // Stage 5a: corpse loot menu slots (disabled — no vacuum until 5b)
    if (includeStubs && isCorpseLike(hit)) {
        entries.push({
            id: 'loot_corpse',
            label: 'Loot corpse',
            disabled: true,
            stub: true
        });
        entries.push({
            id: 'quickloot',
            label: 'Quickloot',
            disabled: true,
            stub: true
        });
    }

    // Stage 8: Browse field — enabled when ≥1 browsable ground item (Q8.2/Q8.10)
    if (hitHasBrowsableItems(hit, o.itemDb)) {
        entries.push({
            id: 'browse_field',
            label: 'Browse field',
            x: hit.x,
            y: hit.y,
            z: hit.z,
            tile: { x: hit.x, y: hit.y, z: hit.z }
        });
    }

    return entries;
}

/**
 * OPEN_CONTEXT_MENU intent for any tile.
 * @param {object} hit
 * @returns {object}
 */
function openContextMenuIntent(hit) {
    const showImmovableNote = !!(
        hit.rawTopUid &&
        hit.pickableUid &&
        hit.rawTopUid !== hit.pickableUid &&
        hit.rawTopImmovable
    );
    return {
        type: 'OPEN_CONTEXT_MENU',
        tile: { x: hit.x, y: hit.y, z: hit.z },
        pickableUid: hit.pickableUid,
        pickableInst: hit.pickableInst,
        pickableItem: hit.pickableItem,
        rawTopUid: hit.rawTopUid,
        rawTopInst: hit.rawTopInst,
        rawTopItem: hit.rawTopItem,
        showImmovableNote,
        creature: hit.creature,
        creatureId: hit.creatureId,
        entries: buildCanvasContextMenuEntries(hit)
    };
}

/**
 * Unshifted LMB default: target / stop / walk (modes 0 and 1; Smart fallthrough).
 * NPCs are never targeted (legacy skips isNpc on attack paths).
 * @param {object} hit
 * @returns {object[]}
 */
function unshiftedLeftDefault(hit) {
    if (hit.creature && isAttackableCreature(hit.creature, hit)) {
        return [
            {
                type: 'SET_TARGET',
                targetId: hit.creature.id,
                creature: hit.creature
            }
        ];
    }
    if (hit.isPlayerTile) {
        return [{ type: 'STOP_AUTOWALK' }];
    }
    return [
        {
            type: 'START_AUTOWALK',
            dest: { x: hit.x, y: hit.y, z: hit.z }
        }
    ];
}

/**
 * Chebyshev distance on the same floor, or Infinity if floors differ / missing.
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} a
 * @param {{ x?: number, y?: number, z?: string|number }|null|undefined} b
 * @returns {number}
 */
function chebyshevSameFloor(a, b) {
    if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) {
        return Infinity;
    }
    if (String(a.z != null ? a.z : 0) !== String(b.z != null ? b.z : 0)) {
        return Infinity;
    }
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * True when the creature carries dialog content (inline tree or dialogId).
 * Adapter re-resolves; this only drops `stub` on the intent.
 * @param {object|null|undefined} creature
 * @returns {boolean}
 */
function npcHasDialogData(creature) {
    if (!creature || typeof creature !== 'object') return false;
    if (creature.dialogId != null && String(creature.dialogId).trim()) return true;
    const d = creature.dialog;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (!d.nodes || typeof d.nodes !== 'object' || Array.isArray(d.nodes)) {
        return false;
    }
    return Object.keys(d.nodes).length > 0;
}

/**
 * Stage 6b: TALK_NPC for a talkable NPC (any range — adapter walk-then-talk).
 * `stub` is true only when the creature has no dialog / dialogId.
 * @param {object} hit
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} [_playerTile]
 * @returns {object[]|null}
 */
function tryTalkNpc(hit, _playerTile) {
    if (!hit || !hit.creature) return null;
    if (!isTalkableNpc(hit.creature) && hit.isNpc !== true) return null;
    return [
        {
            type: 'TALK_NPC',
            stub: !npcHasDialogData(hit.creature),
            creature: hit.creature,
            creatureId: hit.creature.id,
            tile: { x: hit.x, y: hit.y, z: hit.z }
        }
    ];
}

/**
 * Stage 5a: reserved quickloot intent (adapter FCT; no inventory mutation).
 * @param {object} hit
 * @returns {object}
 */
function quicklootStubIntent(hit) {
    return {
        type: 'QUICKLOOT',
        stub: true,
        tile: hit ? { x: hit.x, y: hit.y, z: hit.z } : null,
        pickableUid: hit && hit.pickableUid != null ? hit.pickableUid : null,
        isCorpse: true
    };
}

/**
 * Stage 5a: reserved open-corpse intent (adapter FCT; no container open).
 * @param {object} hit
 * @returns {object}
 */
function openCorpseStubIntent(hit) {
    return {
        type: 'OPEN_CORPSE',
        stub: true,
        tile: hit ? { x: hit.x, y: hit.y, z: hit.z } : null,
        pickableUid: hit && hit.pickableUid != null ? hit.pickableUid : null,
        sourceUid: hit && hit.pickableUid != null ? hit.pickableUid : null,
        isCorpse: true
    };
}

/**
 * Normalize classic lootControlMode to 0/1/2.
 * @param {number|null|undefined} lootMode
 * @returns {number}
 */
function normalizeLootMode(lootMode) {
    const n = Number(lootMode);
    if (!Number.isFinite(n)) return 0;
    const f = Math.floor(n);
    if (f === 1 || f === 2) return f;
    return 0;
}

/**
 * Classic corpse loot branch when hit is corpse-like (Stage 5a stubs only).
 * Returns null when no corpse or this input is not a loot-mode slot.
 *
 * @param {object} hit
 * @param {number} lootMode
 * @param {{ shift: boolean, ctrl: boolean, alt: boolean }} mods
 * @param {'left'|'right'} button
 * @returns {object[]|null}
 */
function classicCorpseLootIntents(hit, lootMode, mods, button) {
    if (!isCorpseLike(hit)) return null;
    if (mods.ctrl || mods.alt) return null;
    const lm = normalizeLootMode(lootMode);

    // Shift + RMB/LMB on corpse: mode 0 open; mode 1 quickloot; mode 2 → Look fallthrough
    if (mods.shift) {
        if (lm === 0) return [openCorpseStubIntent(hit)];
        if (lm === 1) return [quicklootStubIntent(hit)];
        return null;
    }

    if (button === 'right') {
        // Loot: Right → quickloot; SHIFT+Right / Left → open corpse
        if (lm === 0) return [quicklootStubIntent(hit)];
        return [openCorpseStubIntent(hit)];
    }

    // Loot: Left — unshifted LMB quickloots corpse only (not attack)
    if (button === 'left' && lm === 2) {
        return [quicklootStubIntent(hit)];
    }

    return null;
}

/**
 * Smart unshifted LMB priority (§1.4 / Q4.1 attack-first / Q4.2 multi-use cursor).
 * @param {object} hit
 * @param {object} flags
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} playerTile
 * @returns {object[]}
 */
function smartUnshiftedLeft(hit, flags, playerTile) {
    // 1. Talkable NPC → TALK_NPC (adapter walk-then-talk, Stage 6b)
    const talk = tryTalkNpc(hit, playerTile);
    if (talk) return talk;

    // 2. Attack non-NPC creature only (legacy skips isNpc)
    if (hit.creature && isAttackableCreature(hit.creature, hit)) {
        return [
            {
                type: 'SET_TARGET',
                targetId: hit.creature.id,
                creature: hit.creature
            }
        ];
    }

    // 3. useThing: container / multi-use / usable (same order as classic RMB)
    const useThing = classicGroundUseThingIntents(hit);
    if (useThing) return useThing;
    const usePad = useStairIntents(hit);
    if (usePad) return usePad;

    // 4. Quickloot world corpse-containers — stub until Stage 5b (no false success)
    if (isCorpseLike(hit)) {
        return [quicklootStubIntent(hit)];
    }

    // 5. Pickupable → pick up 1 (engine: full instance via adapter)
    if (hit.pickableUid && flags.hasInventory && flags.hasGroundItems) {
        return [
            {
                type: 'PICKUP',
                pickableUid: hit.pickableUid,
                pickableInst: hit.pickableInst,
                pickableItem: hit.pickableItem,
                tile: { x: hit.x, y: hit.y, z: hit.z }
            }
        ];
    }

    // 6. Else autowalk / stop (Look is Shift or menu in engine; NPC tile walks)
    return unshiftedLeftDefault(hit);
}

/**
 * Smart Ctrl: open world container or lying corpse; else context menu (legacy).
 * @param {object} hit
 * @returns {object[]}
 */
function smartCtrl(hit) {
    const pin = worldPinUseThingIntents(hit);
    if (pin) return pin;
    if (
        hit.pickableUid &&
        hit.pickableItem &&
        itemIsContainer(hit.pickableItem)
    ) {
        return [groundOpenContainerIntent(hit, hit.pickableUid)];
    }
    // Legacy: world container/corpse without parent → open (not menu)
    if (isCorpseLike(hit)) {
        return [openCorpseStubIntent(hit)];
    }
    return [openContextMenuIntent(hit)];
}

/**
 * Whether canvas LMB pointerdown may begin ground drag for this press.
 * Mode 2: only pure pickupables (no creature; not multi-use/usable/container);
 * modifiers never start drag (Look / Ctrl / Alt go to the click path).
 * Modes 0/1: true when no modifiers (panel still checks pickable + range).
 *
 * @param {object} opts
 * @param {object|null|undefined} opts.hit
 * @param {number} [opts.mode]
 * @param {{ shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean }} [opts.modifiers]
 * @returns {boolean}
 */
function allowGroundLmbDrag(opts) {
    const o = opts || {};
    const hit = o.hit;
    const mode = o.mode != null ? Number(o.mode) : 1;
    const mods = normalizeModifiers(o.modifiers);
    if (mods.shift || mods.ctrl || mods.alt) return false;
    if (mode !== 2) return true;
    if (!hit || !hit.pickableUid) return false;
    // Q4.1: creature wins — do not steal LMB for ground drag
    if (hit.creature) return false;
    if (hit.pickableItem) {
        if (itemIsMultiUse(hit.pickableItem)) return false;
        if (itemIsUsable(hit.pickableItem)) return false;
        if (itemIsContainer(hit.pickableItem)) return false;
    }
    return true;
}

/**
 * Seeded World pin on the raw stack top (immovable crates / chests / levers).
 * @param {object|null|undefined} hit
 * @returns {boolean}
 */
function hitHasWorldPinTop(hit) {
    return !!(hit && hit.rawTopInst && hit.rawTopInst.worldPinKind);
}

/**
 * Open-container intent for a ground uid.
 * @param {object} hit
 * @param {string} uid
 * @returns {object}
 */
function groundOpenContainerIntent(hit, uid) {
    return {
        type: 'OPEN_CONTAINER',
        sourceUid: uid,
        ground: true,
        tile: { x: hit.x, y: hit.y, z: hit.z }
    };
}

/**
 * Hunt-seed World pin on the tile top: container opens; chest/lever/door/teleport/harvest USE;
 * trap is step-on (no USE); else stub.
 * Rope/shovel Use-with is not a pin USE — flagged tiles hop via USE_ITEM_WITH.
 * @param {object} hit
 * @returns {object[]|null}
 */
function worldPinUseThingIntents(hit) {
    if (!hitHasWorldPinTop(hit)) return null;
    const inst = hit.rawTopInst;
    const kind = inst.worldPinKind;
    // Pin kind wins catalog `category: container` (chest art is often a bag).
    if (kind === 'container') {
        return [groundOpenContainerIntent(hit, hit.rawTopUid)];
    }
    if (kind === 'trap') return null;
    return [
        {
            type: 'USE',
            stub: !worldPinUseReady(kind),
            sourceUid: hit.rawTopUid,
            worldPinKind: kind,
            tile: { x: hit.x, y: hit.y, z: hit.z }
        }
    ];
}

/**
 * Classic RMB useThing chain (legacy processMouseAction loot modes 0–2).
 * World pin top wins (open crate / chest·lever·door·teleport Use / stub Use). Then container/open before
 * multi-use before use; plain pickupables fall through.
 * Corpses are handled separately via classicCorpseLootIntents (loot modes).
 *
 * @param {object} hit
 * @returns {object[]|null}
 */
function classicGroundUseThingIntents(hit) {
    if (!hit) return null;
    const pin = worldPinUseThingIntents(hit);
    if (pin) return pin;
    if (!hit.pickableUid || !hit.pickableItem) return null;
    const item = hit.pickableItem;
    const itemId = item.id || (hit.pickableInst && hit.pickableInst.itemId);

    // Pickupable bags / backpacks always open (not pick up) — legacy isPickupable branch
    if (itemIsContainer(item)) {
        return [groundOpenContainerIntent(hit, hit.pickableUid)];
    }
    if (itemIsMultiUse(item)) {
        return [
            {
                type: 'ENTER_USE_WITH',
                sourceUid: hit.pickableUid,
                itemId
            }
        ];
    }
    if (itemIsUsable(item)) {
        return [
            {
                type: 'USE_ITEM',
                sourceUid: hit.pickableUid,
                itemId,
                target: { kind: 'self' }
            }
        ];
    }
    return null;
}

/**
 * Classic unshifted RMB: talk NPC → attack → corpse loot → useThing (open/use) → pickup / walk.
 * Context menu is Ctrl+click only (not unshifted RMB).
 *
 * @param {object} hit
 * @param {object} flags
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} playerTile
 * @param {number} lootMode
 * @returns {object[]}
 */
function classicUnshiftedRight(hit, flags, playerTile, lootMode) {
    // Stage 6b: talkable NPC always on classic (adapter handles range)
    const talk = tryTalkNpc(hit, playerTile);
    if (talk) return talk;

    // Attack non-NPC only (legacy skips isNpc after talk branch)
    if (hit.creature && isAttackableCreature(hit.creature, hit)) {
        return [
            {
                type: 'SET_TARGET',
                targetId: hit.creature.id,
                creature: hit.creature
            }
        ];
    }

    // Stage 5a: corpse loot stubs only when corpse-like (no-op until 5b)
    const corpseLoot = classicCorpseLootIntents(
        hit,
        lootMode,
        { shift: false, ctrl: false, alt: false },
        'right'
    );
    if (corpseLoot) return corpseLoot;

    // useThing: open container / multi-use / use before plain pickup (legacy)
    const useThing = classicGroundUseThingIntents(hit);
    if (useThing) return useThing;
    const usePad = useStairIntents(hit);
    if (usePad) return usePad;

    if (hit.pickableUid && flags.hasInventory && flags.hasGroundItems) {
        return [
            {
                type: 'PICKUP',
                pickableUid: hit.pickableUid,
                pickableInst: hit.pickableInst,
                pickableItem: hit.pickableItem,
                tile: { x: hit.x, y: hit.y, z: hit.z }
            }
        ];
    }
    // Empty / non-pickable
    if (flags.playerControlMode === 'manual' && flags.playerAlive) {
        if (hit.isPlayerTile) {
            return [{ type: 'STOP_AUTOWALK' }];
        }
        return [
            {
                type: 'START_AUTOWALK',
                dest: { x: hit.x, y: hit.y, z: hit.z }
            }
        ];
    }
    return [];
}

/**
 * Regular Ctrl: use / open / use-with on ground pickable; else menu.
 * @param {object} hit
 * @returns {object[]}
 */
function regularCtrlUse(hit) {
    // Legacy non-smart Ctrl: container → multi-use → use (same helper as classic/smart)
    const useThing = classicGroundUseThingIntents(hit);
    if (useThing) return useThing;
    const usePad = useStairIntents(hit);
    if (usePad) return usePad;
    // No usable thing → context menu
    return [openContextMenuIntent(hit)];
}

/**
 * Map button + hit + mode + modifiers to intents (Stage 4 + 5a/6a stubs).
 *
 * @param {object} input
 * @param {'left'|'right'} input.button
 * @param {{ shift?: boolean, ctrl?: boolean, alt?: boolean, meta?: boolean }} [input.modifiers]
 * @param {object|null} input.hit from resolveCanvasHit
 * @param {number} [input.mode] mouseControlMode (0 Regular, 1 Classic, 2 Smart); default 1
 * @param {number} [input.lootMode] classic lootControlMode (0/1/2); stub body until 5b
 * @param {boolean} [input.talkOnRightClick] Regular: RMB talks to NPC when true (Stage 6b)
 * @param {object|null|undefined} [input.activeCursor] uiState.activeActionCursor
 * @param {string} [input.playerControlMode] 'manual' | 'ai'
 * @param {boolean} [input.playerAlive]
 * @param {boolean} [input.hasInventory]
 * @param {boolean} [input.hasGroundItems]
 * @param {{ x: number, y: number, z?: string|number }|null|undefined} [input.playerTile] for NPC talk range
 * @returns {object[]} intents
 */
function processMouseAction(input) {
    const i = input || {};
    const hit = i.hit;
    if (!hit) return [];

    const button = i.button;
    const mode = i.mode != null ? Number(i.mode) : 1;
    const lootMode = normalizeLootMode(i.lootMode);
    const talkOnRightClick = i.talkOnRightClick === true;
    const mods = normalizeModifiers(i.modifiers);
    const playerControlMode = i.playerControlMode || 'manual';
    const playerAlive = i.playerAlive !== false;
    const hasInventory = i.hasInventory !== false;
    const hasGroundItems = i.hasGroundItems !== false;
    const activeCursor = i.activeCursor || null;
    const playerTile = i.playerTile || null;

    const flags = {
        playerControlMode,
        playerAlive,
        hasInventory,
        hasGroundItems
    };

    // LMB action-cursor resolve always wins (manual only).
    // Single-target (allowTileAim === false): require a creature; keep crosshair on empty tile.
    // AoE / tools (allowTileAim true or unset): entity or tile aim.
    if (button === 'left' && activeCursor) {
        if (playerControlMode !== 'manual' || !playerAlive) return [];
        let target = null;
        if (hit.creature) {
            target = { kind: 'entity', id: hit.creature.id };
        } else if (activeCursor.allowTileAim !== false) {
            target = { kind: 'tile', x: hit.x, y: hit.y, z: hit.z };
        } else {
            // Invalid aim for single-target rune/spell — keep activeActionCursor
            return [];
        }
        return [
            {
                type: 'RESOLVE_ACTION_CURSOR',
                cursor: {
                    type: activeCursor.type,
                    sourceUid: activeCursor.sourceUid,
                    itemId: activeCursor.itemId,
                    spellId: activeCursor.spellId
                },
                target
            },
            { type: 'CLEAR_ACTION_CURSOR' }
        ];
    }

    if (button !== 'left' && button !== 'right') return [];

    // Shared modifier: Shift → Look, except classic corpse loot slots (5a)
    if (mods.shift) {
        if (mode === 1) {
            const corpseShift = classicCorpseLootIntents(
                hit,
                lootMode,
                mods,
                button
            );
            if (corpseShift) return corpseShift;
        }
        return [buildLookIntent(hit)];
    }

    // Shared modifier: Alt → Attack non-NPC creature (all modes; legacy skips isNpc)
    if (mods.alt) {
        if (
            hit.creature &&
            isAttackableCreature(hit.creature, hit) &&
            playerControlMode === 'manual' &&
            playerAlive
        ) {
            return [
                {
                    type: 'SET_TARGET',
                    targetId: hit.creature.id,
                    creature: hit.creature
                }
            ];
        }
        return [];
    }

    // --- Classic (1) ---
    if (mode === 1) {
        // Ctrl → always context menu (any tile)
        if (mods.ctrl) {
            return [openContextMenuIntent(hit)];
        }
        if (button === 'left') {
            if (playerControlMode !== 'manual' || !playerAlive) return [];
            // Loot: Left — corpse LMB → quickloot stub (no attack path on corpse)
            const corpseLeft = classicCorpseLootIntents(
                hit,
                lootMode,
                mods,
                'left'
            );
            if (corpseLeft) return corpseLeft;
            return unshiftedLeftDefault(hit);
        }
        // unshifted right
        return classicUnshiftedRight(hit, flags, playerTile, lootMode);
    }

    // --- Regular (0) ---
    if (mode === 0) {
        // Ctrl → use / open / use-with (or menu fallback)
        if (mods.ctrl) {
            return regularCtrlUse(hit);
        }
        if (button === 'left') {
            if (playerControlMode !== 'manual' || !playerAlive) return [];
            return unshiftedLeftDefault(hit);
        }
        // Stage 6b: optional talkOnRightClick for Regular RMB on NPC
        if (talkOnRightClick) {
            const talk = tryTalkNpc(hit, playerTile);
            if (talk) return talk;
        }
        // Unshifted RMB → always context menu (any tile; no walk)
        return [openContextMenuIntent(hit)];
    }

    // --- Left Smart-Click (2) ---
    if (mode === 2) {
        if (mods.ctrl) {
            return smartCtrl(hit);
        }
        if (button === 'left') {
            if (playerControlMode !== 'manual' || !playerAlive) return [];
            return smartUnshiftedLeft(hit, flags, playerTile);
        }
        // Unshifted RMB → context menu (like Regular)
        return [openContextMenuIntent(hit)];
    }

    // Unknown mode — safe Classic-like fallthrough
    if (button === 'left') {
        if (playerControlMode !== 'manual' || !playerAlive) return [];
        return unshiftedLeftDefault(hit);
    }
    return classicUnshiftedRight(hit, flags, playerTile, lootMode);
}

/**
 * Apply non-DOM intents to the player command queue (and optional cursor clear).
 * Returns intents the adapter must still handle
 * (OPEN_CONTEXT_MENU, LOOK, PICKUP, ENTER_USE_WITH, OPEN_CONTAINER, …).
 *
 * @param {object} player
 * @param {object[]} intents
 * @param {object} [opts]
 * @param {() => void} [opts.clearActionCursor]
 * @returns {object[]} remaining intents
 */
/**
 * Classic LMB+RMB Look chord (docs/29 Q7.1).
 * True when mode is Classic (1) and the **other** button is still held on the
 * event of the second button. No simultaneous-press timing window.
 *
 * @param {{
 *   mode?: number,
 *   button?: 'left'|'right'|string,
 *   leftPressed?: boolean,
 *   rightPressed?: boolean
 * }} opts
 * @returns {boolean}
 */
function isClassicLookChord(opts) {
    const o = opts || {};
    const mode = Number(o.mode);
    if (mode !== 1) return false;
    const button = o.button === 'right' || o.button === 2 ? 'right' : 'left';
    const left = !!o.leftPressed;
    const right = !!o.rightPressed;
    if (button === 'right' && left) return true;
    if (button === 'left' && right) return true;
    return false;
}

/**
 * Stack drag quantity resolution (docs/29 §1.6 / Q7.2).
 * Matches legacy `moveStackableItem`:
 * - Shift → 1
 * - Ctrl XOR moveStack → full stack
 * - else when count > 1 → open amount modal
 * - count ≤ 1 → 1 (no modal)
 *
 * Default moveStack=false: plain drag opens modal; Ctrl moves full.
 *
 * @param {{
 *   count?: number,
 *   shift?: boolean,
 *   ctrl?: boolean,
 *   moveStack?: boolean
 * }} opts
 * @returns {{ kind: 'amount', amount: number } | { kind: 'modal', max: number }}
 */
function resolveStackMoveAmount(opts) {
    const o = opts || {};
    let count = Math.floor(Number(o.count));
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count <= 1) return { kind: 'amount', amount: 1 };
    if (o.shift) return { kind: 'amount', amount: 1 };
    const ctrl = !!o.ctrl;
    const moveStack = !!o.moveStack;
    // Legacy: isCtrlPressed() ~= moveStack → full stack
    if (ctrl !== moveStack) return { kind: 'amount', amount: count };
    return { kind: 'modal', max: count };
}

function applyCommandIntents(player, intents, opts) {
    const o = opts || {};
    const remaining = [];
    if (!player || !Array.isArray(intents)) return remaining;
    if (!Array.isArray(player.commandQueue)) player.commandQueue = [];

    for (let i = 0; i < intents.length; i++) {
        const intent = intents[i];
        if (!intent || !intent.type) continue;

        switch (intent.type) {
            case 'RESOLVE_ACTION_CURSOR': {
                const cur = intent.cursor || {};
                const cmd = {
                    type: cur.type,
                    sourceUid: cur.sourceUid,
                    itemId: cur.itemId,
                    spellId: cur.spellId,
                    target: intent.target
                };
                player.commandQueue.push(cmd);
                break;
            }
            case 'CLEAR_ACTION_CURSOR': {
                if (typeof o.clearActionCursor === 'function') {
                    o.clearActionCursor();
                }
                break;
            }
            case 'SET_TARGET': {
                player.commandQueue.push({
                    type: 'SET_TARGET',
                    targetId: intent.targetId
                });
                player.targetId = intent.targetId;
                if (intent.creature) player.target = intent.creature;
                break;
            }
            case 'STOP_AUTOWALK': {
                player.commandQueue.push({ type: 'STOP_AUTOWALK' });
                break;
            }
            case 'START_AUTOWALK': {
                player.commandQueue.push({
                    type: 'START_AUTOWALK',
                    dest: intent.dest
                });
                break;
            }
            case 'USE_ITEM': {
                player.commandQueue.push({
                    type: 'USE_ITEM',
                    sourceUid: intent.sourceUid,
                    itemId: intent.itemId,
                    target: intent.target || { kind: 'self' }
                });
                break;
            }
            case 'USE_STAIR': {
                player.commandQueue.push({
                    type: 'USE_STAIR',
                    dest: intent.dest
                });
                break;
            }
            default:
                remaining.push(intent);
                break;
        }
    }
    return remaining;
}

module.exports = {
    isImmovableGroundInst,
    topPickableUid,
    findCreatureAtTile,
    itemSupportsDetailsModal,
    thingLabel,
    creatureLookText,
    isTalkableNpc,
    isAttackableCreature,
    isCorpseLike,
    chebyshevSameFloor,
    tryTalkNpc,
    npcHasDialogData,
    TALK_NPC_RANGE,
    quicklootStubIntent,
    openCorpseStubIntent,
    normalizeLootMode,
    allowGroundLmbDrag,
    classicGroundUseThingIntents,
    worldPinUseThingIntents,
    resolveHitStair,
    useStairIntents,
    resolveCanvasHit,
    normalizeModifiers,
    buildLookIntent,
    buildCanvasContextMenuEntries,
    processMouseAction,
    applyCommandIntents,
    isClassicLookChord,
    resolveStackMoveAmount,
    // Stage 8 — Browse Field
    BROWSE_FIELD_CAPACITY,
    BROWSE_FIELD_RANGE,
    isFieldGroundEntity,
    isBrowsableGroundInst,
    browseFieldTileKey,
    listBrowsableStackUids,
    hitHasBrowsableItems,
    isInBrowseOpenRange,
    buildBrowseFieldIntent,
    resolveBrowseFieldApproach,
    resolveApproach
};
