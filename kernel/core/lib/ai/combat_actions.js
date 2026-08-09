/**
 * Shared combat action helpers for player + creature AI (Stage 5).
 */

const { Settings } = require('../../../settings.js');
const {
    resolveAttack,
    indexSpells,
    defaultMeleeAutoSpell,
    isChallengeableCreature,
    baseTargetDistance
} = require('../combat/resolve.js');
const {
    spellHasShape,
    isSelfCenteredAreaSpell,
    canCastPlayerAreaOnTile,
    resolveShapedAttack,
    computeSpellFootprint
} = require('../combat/area.js');
const {
    spellHasChain,
    resolveChainAttack,
    normalizeChainSpec,
    pickChainTargets
} = require('../combat/chain.js');
const { isValidTarget } = require('./targeting.js');
const { isTileFieldHazardForEntity } = require('../combat/elemental_fields.js');
const { entitiesOnTiles, hasLineOfSight } = require('../shapes.js');
const Cooldowns = require('../combat/cooldowns.js');
const { hasMana } = require('../combat/resolve.js');
const { distBetween } = require('./targeting.js');
const { tileDistance } = require('../movement.js');
const { hpPercent, isAutoAttackId } = require('./strategy.js');
const { hasCondition } = require('../combat/conditions.js');
const { isWithinSpellCastRange } = require('../combat/cast_range.js');

/** Default self-heal spell id (presets/spells.json). */
const DEFAULT_HEAL_SPELL_ID = 'heal_light';

/**
 * Condition kind → self-cure spell id (Phase F).
 * Order is cast priority when multiple DoTs are active.
 * @type {{ kind: string, spellId: string }[]}
 */
const CURE_BY_CONDITION = [
    { kind: 'poison', spellId: 'cure_poison' },
    { kind: 'fire', spellId: 'cure_burning' },
    { kind: 'energy', spellId: 'cure_electrification' },
    { kind: 'bleed', spellId: 'cure_bleeding' },
    { kind: 'curse', spellId: 'cure_curse' }
];

/** Built-in auto spell ids by weapon family. */
const AUTO_BY_WEAPON = {
    melee: 'melee_auto',
    distance: 'distance_auto',
    magic: 'wand_auto'
};

/**
 * @param {object} ctx hunt context
 * @returns {Record<string, object>}
 */
function spellBookFromCtx(ctx) {
    if (ctx && ctx.spellBook) return ctx.spellBook;
    if (ctx && ctx.spells) return indexSpells(ctx.spells);
    return Object.create(null);
}

/**
 * Built-in fallback when spell book lacks a weapon auto def.
 * @param {string} spellId
 * @returns {object|null}
 */
function defaultAutoSpell(spellId) {
    if (spellId === 'melee_auto' || spellId === 'auto') {
        return defaultMeleeAutoSpell();
    }
    if (spellId === 'distance_auto') {
        return {
            id: 'distance_auto',
            label: 'Distance Auto Attack',
            kind: 'auto',
            element: 'physical',
            powerCurve: 'melee_auto',
            basePower: 0,
            range: 6,
            mana: 0,
            hitChance: 100,
            isMelee: false,
            requiresAmmo: true,
            ammoPerShot: 1,
            moveLock: 0.05,
            cooldowns: { auto: { attack: 2 } }
        };
    }
    if (spellId === 'wand_auto') {
        return {
            id: 'wand_auto',
            label: 'Wand Auto Attack',
            kind: 'auto',
            element: 'energy',
            powerCurve: 'magic_strike',
            basePower: 18,
            /** Fallback when equipped wand has no range; runtime prefers weaponRange. */
            range: 4,
            mana: 5,
            hitChance: 100,
            isMelee: false,
            moveLock: 0.05,
            cooldowns: { auto: { attack: 2 } }
        };
    }
    return null;
}

/** Default wand auto range when weapon/spell range is missing. */
const DEFAULT_WAND_AUTO_RANGE = 4;

/**
 * Effective Chebyshev range for a spell cast by attacker.
 * wand_auto uses equipped weapon range (combatStats.weaponRange); else spell.range.
 *
 * @param {object|null|undefined} attacker
 * @param {object} spell
 * @returns {number}
 */
function resolveSpellRange(attacker, spell) {
    if (!spell) return 1;
    const sid = spell.id != null ? String(spell.id) : '';
    if (sid === 'wand_auto') {
        const stats =
            (attacker && (attacker.combatStats || attacker.effectiveStats)) ||
            null;
        if (stats && stats.weaponRange != null && stats.weaponRange !== '') {
            const wr = Number(stats.weaponRange);
            if (Number.isFinite(wr) && wr >= 0) return wr;
        }
        if (spell.range != null && spell.range !== '') {
            const sr = Number(spell.range);
            if (Number.isFinite(sr) && sr >= 0) return sr;
        }
        return DEFAULT_WAND_AUTO_RANGE;
    }
    const range = spell.range != null ? Number(spell.range) : 1;
    return Number.isFinite(range) ? range : 1;
}

/**
 * Resolve spell def by id using context book.
 * @param {string} spellId
 * @param {object} ctx
 * @returns {object|null}
 */
function getSpell(spellId, ctx) {
    if (!spellId) return null;
    const book = spellBookFromCtx(ctx);
    if (book[spellId]) return book[spellId];
    if (isAutoAttackId(spellId)) {
        return defaultAutoSpell(spellId);
    }
    return null;
}

/**
 * Equipped / class weapon family: melee | distance | magic.
 * Unarmed / fist always maps to melee (legacy fist fighting).
 * @param {object} owner
 * @returns {string}
 */
function resolveWeaponType(owner) {
    if (!owner) return 'melee';
    const stats = owner.combatStats || owner.effectiveStats || null;
    if (stats && stats.unarmed) return 'melee';
    const wt =
        (stats && stats.weaponType) ||
        owner.weaponType ||
        (owner.classDef && owner.classDef.weaponType) ||
        'melee';
    if (wt === 'fist' || wt === 'unarmed') return 'melee';
    if (wt === 'distance' || wt === 'ranged' || wt === 'bow' || wt === 'crossbow') {
        return 'distance';
    }
    if (wt === 'magic' || wt === 'wand' || wt === 'rod' || wt === 'staff') {
        return 'magic';
    }
    return 'melee';
}

/**
 * Spell id for the player's weapon auto swing.
 * Prefers equipped weapon family. Unarmed is always melee_auto (fist).
 * Class autoAttack is only a melee-family fallback, never overrides bow/wand.
 * @param {object} owner
 * @returns {string}
 */
function resolveAutoAttackId(owner) {
    if (!owner) return 'melee_auto';
    const stats = owner.combatStats || owner.effectiveStats || null;
    if (stats && stats.unarmed) return AUTO_BY_WEAPON.melee;
    if (stats && stats.autoAttack && isAutoAttackId(stats.autoAttack)) {
        // Effective stats already resolved family (incl. unarmed → melee_auto)
        return stats.autoAttack === 'auto' ? AUTO_BY_WEAPON.melee : stats.autoAttack;
    }
    const fromClass = owner.autoAttack || null;
    const wt = resolveWeaponType(owner);
    if (wt === 'distance') return 'distance_auto';
    if (wt === 'magic') return 'wand_auto';
    if (fromClass && isAutoAttackId(fromClass) && fromClass !== 'distance_auto' && fromClass !== 'wand_auto') {
        return fromClass === 'auto' ? AUTO_BY_WEAPON.melee : fromClass;
    }
    return AUTO_BY_WEAPON.melee;
}

/**
 * Whether the active content mode enables weapon auto-attack.
 * Defaults true when mode is missing (tests / headless without mode pack).
 * @param {object} [ctx]
 * @returns {boolean}
 */
function isModeAutoAttackEnabled(ctx) {
    const c = ctx || {};
    if (c.autoAttack === false) return false;
    if (c.autoAttack === true) return true;
    const mode =
        c.mode ||
        (c.sim && c.sim.mode) ||
        null;
    if (mode && mode.features && mode.features.autoAttack === false) {
        return false;
    }
    // Live active mode when sim does not carry a mode bag
    try {
        const { getActiveMode } = require('../modes.js');
        const m = getActiveMode();
        if (m && m.features && m.features.autoAttack === false) return false;
    } catch (_) {
        /* modes optional in pure unit tests */
    }
    return true;
}

/**
 * Whether attacker is free of post-cast / step root (moveLock / moveDelay).
 * @param {object} owner
 * @returns {boolean}
 */
function isMoveUnlocked(owner) {
    if (!owner) return false;
    const d = Number(owner.moveDelay) || 0;
    return !(d > 0);
}

/**
 * Whether the active content mode consumes quiver ammo on distance auto.
 * Defaults **false** when mode is missing (unit tests without mode pack).
 * Standard mode sets `features.ammoConsumption: true`.
 * @param {object} [ctx]
 * @returns {boolean}
 */
function isModeAmmoConsumptionEnabled(ctx) {
    const c = ctx || {};
    if (c.ammoConsumption === true) return true;
    if (c.ammoConsumption === false) return false;
    const mode = c.mode || (c.sim && c.sim.mode) || null;
    if (mode && mode.features && mode.features.ammoConsumption === true) {
        return true;
    }
    if (mode && mode.features && mode.features.ammoConsumption === false) {
        return false;
    }
    try {
        const { getActiveMode } = require('../modes.js');
        const m = getActiveMode();
        if (m && m.features && m.features.ammoConsumption === true) return true;
    } catch (_) {
        /* modes optional in pure unit tests */
    }
    return false;
}

/**
 * Whether the active content mode consumes stackable runes from inventory.
 * Defaults **false** when mode is missing (unit tests without mode pack).
 * Standard mode sets `features.runeConsumption: true`.
 * @param {object} [ctx]
 * @returns {boolean}
 */
function isModeRuneConsumptionEnabled(ctx) {
    const c = ctx || {};
    if (c.runeConsumption === true) return true;
    if (c.runeConsumption === false) return false;
    const mode = c.mode || (c.sim && c.sim.mode) || null;
    if (mode && mode.features && mode.features.runeConsumption === true) {
        return true;
    }
    if (mode && mode.features && mode.features.runeConsumption === false) {
        return false;
    }
    try {
        const { getActiveMode } = require('../modes.js');
        const m = getActiveMode();
        if (m && m.features && m.features.runeConsumption === true) return true;
    } catch (_) {
        /* modes optional in pure unit tests */
    }
    return false;
}

/**
 * Whether monster auto-summon AI is enabled for this combat context.
 * Defaults **true** when mode is missing (product default); set
 * `features.monsterSummons: false` for stability / isolation tests.
 * @param {object} [ctx]
 * @returns {boolean}
 */
function isModeMonsterSummonsEnabled(ctx) {
    const c = ctx || {};
    if (c.monsterSummons === false) return false;
    if (c.monsterSummons === true) return true;
    const mode = c.mode || (c.sim && c.sim.mode) || null;
    if (mode && mode.features && mode.features.monsterSummons === false) {
        return false;
    }
    if (mode && mode.features && mode.features.monsterSummons === true) {
        return true;
    }
    try {
        const { getActiveMode } = require('../modes.js');
        const m = getActiveMode();
        if (m && m.features && m.features.monsterSummons === false) {
            return false;
        }
    } catch (_) {
        /* modes optional in pure unit tests */
    }
    return true;
}

/**
 * Whether the spell is a consumable rune cast (`source: "rune"`).
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function isRuneSpell(spell) {
    if (!spell) return false;
    return String(spell.source || '').toLowerCase() === 'rune';
}

/**
 * Equipment template id for a rune spell (`runeItemId`, else spell id for field runes).
 * @param {object|null|undefined} spell
 * @returns {string|null}
 */
function resolveRuneItemId(spell) {
    if (!spell) return null;
    if (spell.runeItemId != null && String(spell.runeItemId).trim() !== '') {
        return String(spell.runeItemId).trim();
    }
    // Field / utility runes often share id with the equipment template
    if (isRuneSpell(spell) && spell.id != null && String(spell.id).trim() !== '') {
        return String(spell.id).trim();
    }
    return null;
}

/**
 * Rune stock check for `source: "rune"` spells.
 * - Consumption **off** (default in bare tests): always allow.
 * - Consumption **on** + backpack inventory: need ≥1 matching item in the tree.
 * - Consumption **on** without inventory (scripted NPCs / bare attackers): allow.
 *
 * @param {object} attacker
 * @param {object} spell
 * @param {object} [ctx]
 * @returns {boolean}
 */
function hasRune(attacker, spell, ctx) {
    if (!isRuneSpell(spell)) return true;
    if (!isModeRuneConsumptionEnabled(ctx)) return true;
    if (!attacker) return false;
    if (!attacker.inventory) return true;
    const itemId = resolveRuneItemId(spell);
    if (!itemId) return true;
    try {
        const { countItemIdInInventoryTree } = require('../character/inventory.js');
        return countItemIdInInventoryTree(attacker.inventory, itemId) >= 1;
    } catch (_) {
        return true;
    }
}

/**
 * After a rune cast is accepted (mana/CD/gates pass): spend 1 unit from the
 * backpack tree. No-op when consumption is off or inventory is missing.
 * @param {object} attacker
 * @param {object} spell
 * @param {object} [ctx]
 */
function spendRune(attacker, spell, ctx) {
    if (!attacker || !isRuneSpell(spell)) return;
    if (!isModeRuneConsumptionEnabled(ctx)) return;
    if (!attacker.inventory) return;
    const itemId = resolveRuneItemId(spell);
    if (!itemId) return;
    try {
        const { consumeItemIdFromInventory } = require('../character/inventory.js');
        const r = consumeItemIdFromInventory(attacker.inventory, itemId, 1);
        if (r.changed && typeof attacker.applyInventoryMutation === 'function') {
            attacker.applyInventoryMutation();
        } else if (
            r.changed &&
            typeof attacker.syncEquipmentFromInventory === 'function'
        ) {
            attacker.syncEquipmentFromInventory();
        }
    } catch (_) {
        /* inventory optional */
    }
}

/**
 * Resolve itemDb for inventory ammo helpers on a player-like attacker.
 * @param {object} attacker
 * @param {object} [ctx]
 * @returns {object[]|Record<string, object>|null}
 */
function ammoItemDb(attacker, ctx) {
    if (attacker && attacker._loadoutItemDb) return attacker._loadoutItemDb;
    if (ctx && ctx.itemDb) return ctx.itemDb;
    if (ctx && ctx.sim && ctx.sim._itemDb) return ctx.sim._itemDb;
    return null;
}

/**
 * Whether the attacker's rightHand is a throwing weapon (stackable spears/stars).
 * @param {object} attacker
 * @param {object} [ctx]
 * @returns {boolean}
 */
function isThrowingWeaponAttacker(attacker, ctx) {
    if (!attacker || !attacker.inventory) return false;
    try {
        const { equippedIsThrowingWeapon } = require('../character/inventory.js');
        return equippedIsThrowingWeapon(
            attacker.inventory,
            ammoItemDb(attacker, ctx)
        );
    } catch (_) {
        return false;
    }
}

/**
 * Ammo / throwing stock check for distance auto.
 * - Throwing weapons: need ≥1 unit in rightHand stack (always, when inventory present).
 * - Mode `ammoConsumption` + bow/xbow: quiver stacks (or finite `attacker.ammo` counter).
 * - Otherwise: null/undefined ammo = infinite; finite counter still gates.
 *
 * @param {object} attacker
 * @param {object} spell
 * @param {object} [ctx]
 * @returns {boolean}
 */
function hasAmmo(attacker, spell, ctx) {
    if (!spell || !spell.requiresAmmo) return true;
    if (!attacker) return false;
    const need = Math.max(1, Number(spell.ammoPerShot) || 1);

    // Hand-thrown weapons: the weapon stack itself is the stock
    if (isThrowingWeaponAttacker(attacker, ctx)) {
        try {
            const { equippedRightHandCount } = require('../character/inventory.js');
            return equippedRightHandCount(attacker.inventory) >= need;
        } catch (_) {
            return false;
        }
    }

    if (isModeAmmoConsumptionEnabled(ctx)) {
        if (attacker.inventory) {
            try {
                const {
                    countEquippedQuiverAmmo
                } = require('../character/inventory.js');
                const n = countEquippedQuiverAmmo(
                    attacker.inventory,
                    ammoItemDb(attacker, ctx)
                );
                if (n >= need) return true;
            } catch (_) {
                /* inventory optional */
            }
        }
        // Explicit finite counters (tests / scripted attackers)
        if (attacker.ammo != null || attacker.ammunition != null) {
            const n =
                attacker.ammo != null
                    ? Number(attacker.ammo)
                    : Number(attacker.ammunition);
            return Number.isFinite(n) && n >= need;
        }
        return false;
    }
    if (attacker.ammo == null && attacker.ammunition == null) return true;
    const n =
        attacker.ammo != null
            ? Number(attacker.ammo)
            : Number(attacker.ammunition);
    return Number.isFinite(n) && n >= need;
}

/**
 * After a distance auto resolves (hit **or** miss): spend quiver ammo, or roll
 * throwing-weapon break chance and remove one unit when it breaks.
 * @param {object} attacker
 * @param {object} spell
 * @param {object} [ctx]
 */
function spendAmmo(attacker, spell, ctx) {
    if (!attacker || !spell || !spell.requiresAmmo) return;

    // Throwing weapons: probabilistic break on every throw (including miss)
    if (isThrowingWeaponAttacker(attacker, ctx)) {
        try {
            const {
                tryBreakEquippedThrowingWeapon
            } = require('../character/inventory.js');
            const r = tryBreakEquippedThrowingWeapon(
                attacker.inventory,
                ammoItemDb(attacker, ctx),
                ctx && ctx.rng
            );
            if (r.changed && typeof attacker.applyInventoryMutation === 'function') {
                attacker.applyInventoryMutation();
            } else if (
                r.changed &&
                typeof attacker.syncEquipmentFromInventory === 'function'
            ) {
                attacker.syncEquipmentFromInventory();
            }
        } catch (_) {
            /* inventory optional */
        }
        return;
    }

    const cost = Math.max(1, Number(spell.ammoPerShot) || 1);
    if (isModeAmmoConsumptionEnabled(ctx) && attacker.inventory) {
        try {
            const {
                consumeEquippedQuiverAmmo
            } = require('../character/inventory.js');
            const r = consumeEquippedQuiverAmmo(
                attacker.inventory,
                cost,
                ammoItemDb(attacker, ctx)
            );
            if (r.changed && typeof attacker.applyInventoryMutation === 'function') {
                attacker.applyInventoryMutation();
            } else if (r.changed && typeof attacker.syncEquipmentFromInventory === 'function') {
                attacker.syncEquipmentFromInventory();
            }
            // Keep optional numeric counters in sync for UI/tests
            if (attacker.ammo != null) {
                attacker.ammo = Math.max(0, Number(attacker.ammo) - r.spent);
            } else if (attacker.ammunition != null) {
                attacker.ammunition = Math.max(
                    0,
                    Number(attacker.ammunition) - r.spent
                );
            }
            return;
        } catch (_) {
            /* fall through to counter */
        }
    }
    if (attacker.ammo != null) {
        attacker.ammo = Math.max(0, Number(attacker.ammo) - cost);
    } else if (attacker.ammunition != null) {
        attacker.ammunition = Math.max(0, Number(attacker.ammunition) - cost);
    }
}

/**
 * Mode-gated weapon auto-attack when target is active and conditions allow.
 * Spells / steps that set moveDelay on this tick must run first so auto yields.
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object} opts.defender
 * @param {object} opts.ctx
 * @returns {object|null}
 */
function tryAutoAttack(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const defender = o.defender;
    const ctx = o.ctx || {};
    if (!attacker || !defender || !attacker.alive || !defender.alive) return null;
    if (!isModeAutoAttackEnabled(ctx)) return null;
    // Spell cast or step this frame already planted the character
    if (!isMoveUnlocked(attacker)) return null;

    const spellId = resolveAutoAttackId(attacker);
    const spell = getSpell(spellId, ctx);
    if (!spell) return null;
    if (!hasAmmo(attacker, spell, ctx)) return null;

    const result = tryAttack({
        attacker,
        defender,
        spellId,
        ctx
    });
    if (result && result.ok) {
        spendAmmo(attacker, spell, ctx);
    }
    return result;
}

/**
 * Whether the attacker knows / is allowed to cast this spell.
 * Auto-attacks always pass (weapon family resolves which fires).
 * Prefer class spell book on combatStats.spells; else spell.vocations allow-list.
 * @param {object} attacker
 * @param {object} spell
 * @returns {boolean}
 */
function canUseSpell(attacker, spell) {
    if (!attacker || !spell) return false;
    const sid = spell.id != null ? String(spell.id) : '';
    if (sid && isAutoAttackId(sid)) return true;

    const stats = attacker.combatStats || attacker.effectiveStats || null;
    const known = stats && Array.isArray(stats.spells) ? stats.spells : null;
    if (known && known.length) {
        return !!(sid && known.indexOf(sid) >= 0);
    }

    const allowed = Array.isArray(spell.vocations) ? spell.vocations : null;
    if (allowed && allowed.length) {
        const classId =
            (attacker.classId != null && String(attacker.classId)) ||
            (stats && stats.classId != null && String(stats.classId)) ||
            (attacker.vocation != null && String(attacker.vocation)) ||
            '';
        // No class context (bare test attackers) → do not block.
        if (!classId) return true;
        return allowed.indexOf(classId) >= 0;
    }
    // No book and no vocation list → unrestricted (tests / custom injectors).
    return true;
}

/**
 * Whether attacker meets the spell's minimum level (when authored).
 * @param {object} attacker
 * @param {object} spell
 * @returns {boolean}
 */
function meetsSpellLevel(attacker, spell) {
    if (!spell || spell.level == null) return true;
    const need = Number(spell.level);
    if (!(need > 0)) return true;
    const stats = attacker && (attacker.combatStats || attacker.effectiveStats);
    const have = Number(
        (attacker && attacker.level != null && attacker.level) ||
            (stats && stats.level != null && stats.level) ||
            1
    );
    return have >= need;
}

/**
 * Whether attacker meets the spell's minimum magic level (when authored).
 * Reads effective `magic` skill (profile `magicLevel` normalizes to `magic`).
 * Legacy runes use `rune:magicLevel(N)`; engine field is `spell.magicLevel`.
 * @param {object} attacker
 * @param {object} spell
 * @returns {boolean}
 */
function meetsSpellMagicLevel(attacker, spell) {
    if (!spell || spell.magicLevel == null) return true;
    const need = Number(spell.magicLevel);
    if (!(need > 0)) return true;
    const stats = attacker && (attacker.combatStats || attacker.effectiveStats);
    const skills = (attacker && attacker.skills) || (stats && stats.skills) || null;
    const have = Number(
        (stats && stats.magic != null && stats.magic) ||
            (skills && skills.magic != null && skills.magic) ||
            (skills && skills.magicLevel != null && skills.magicLevel) ||
            (attacker && attacker.magic != null && attacker.magic) ||
            0
    );
    return have >= need;
}

/**
 * Whether attacker can currently fire the spell (known + level + magic level +
 * moveLock/moveDelay root + CD + mana + rune stock when consumption is on).
 * @param {object} attacker
 * @param {object} spell
 * @param {object} [ctx] hunt context (mode / runeConsumption / inventory helpers)
 * @returns {boolean}
 */
function canCast(attacker, spell, ctx) {
    if (!attacker || !spell) return false;
    if (!canUseSpell(attacker, spell)) return false;
    if (!meetsSpellLevel(attacker, spell)) return false;
    if (!meetsSpellMagicLevel(attacker, spell)) return false;
    // Post-cast / step root: same gate as tryAutoAttack and canStep.
    // Blocks same-tick and mid-root casts (AI, heal, CUSTOM_COMMAND macros).
    if (!isMoveUnlocked(attacker)) return false;
    // Phase M: Stage-1 swift foot pacify — block attack/auto (support+heal OK).
    if (isPacifiedAttack(attacker, spell)) return false;
    // Protection zone (path PNG green / TILE_FLAG_NO_CAST): no magic or autos.
    {
        const c = ctx || {};
        const tileMap =
            c.tileMap || (c.sim && c.sim.tileMap) || null;
        const t = attacker.tile;
        if (
            tileMap &&
            t &&
            typeof tileMap.blocksCast === 'function' &&
            tileMap.blocksCast(t.x, t.y, t.z)
        ) {
            return false;
        }
    }
    Cooldowns.ensureCooldowns(attacker);
    if (!Cooldowns.canUse(attacker, spell.cooldowns)) return false;
    if (!hasMana(attacker, spell.mana || 0)) return false;
    if (!hasRune(attacker, spell, ctx)) return false;
    // Phase B: player shaped cast only when first on tile (tile controller).
    if (spellHasShape(spell)) {
        const c = ctx || {};
        const tileMap =
            c.tileMap || (c.sim && c.sim.tileMap) || null;
        if (!canCastPlayerAreaOnTile(attacker, tileMap)) return false;
    }
    return true;
}

/**
 * Stage-1 swift foot / pacify: block offensive autos & attack-group spells.
 * Support and healing remain castable (escape / recovery).
 * @param {object} attacker
 * @param {object} spell
 * @returns {boolean}
 */
function isPacifiedAttack(attacker, spell) {
    if (!attacker || !spell) return false;
    let pacified = attacker.cannotAttack === true;
    if (!pacified) {
        try {
            const { isCannotAttack } = require('../combat/conditions.js');
            pacified = isCannotAttack(attacker);
        } catch (_) {
            pacified = false;
        }
    }
    if (!pacified) return false;
    const kind = String(spell.kind || '');
    if (kind === 'support' || kind === 'heal') return false;
    if (spell.element === 'healing') return false;
    // statusOnly utility with no damage (dispel, etc.) — allow if support-like
    if (spell.statusOnly && kind !== 'auto' && kind !== 'strike') {
        const cd = spell.cooldowns && spell.cooldowns.primary;
        if (cd && cd.support != null && cd.attack == null) return false;
    }
    return true;
}

/**
 * Living combatants that may be hit (exclude caster / dead).
 * @param {object} attacker
 * @param {object|null|undefined} primary
 * @param {object[]} candidates
 * @returns {object[]}
 */
function livingHostilePool(attacker, primary, candidates) {
    const pool = Array.isArray(candidates) ? candidates.slice() : [];
    if (primary && pool.indexOf(primary) < 0) pool.push(primary);
    const out = [];
    for (let i = 0; i < pool.length; i++) {
        const e = pool[i];
        if (!e || e === attacker) continue;
        if (e.alive === false) continue;
        if (e.hp && e.hp.current <= 0) continue;
        out.push(e);
    }
    return out;
}

/**
 * Whether the spell can usefully fire at the sticky target (or self-AoE pack).
 *
 * Self-centered area (rampage, radiant_crater, …): ignore authored `range: 0`
 * and allow cast when **any** living hostile lies on the caster-centered
 * footprint (not only when Chebyshev to sticky ≤ range).
 *
 * Single-target / wave / ranged area: cast range to primary (Chebyshev ≤
 * spell.range; far-use runes also require the legacy 7×5 box), plus Bresenham
 * LoS through walkable tiles when `ctx.tileMap` (or sim) is set.
 * Adjacent (Chebyshev ≤ 1) is always clear; missing tileMap → open (tests).
 *
 * @param {object} attacker
 * @param {object|null} defender sticky / primary target
 * @param {object} spell
 * @param {object} [ctx] hunt ctx { enemies, players, tileMap, sim, candidates }
 * @returns {boolean}
 */
/**
 * Chain hop filter for catalog flags (chainOnlyRanged).
 * Legacy chivalrous_challenge / divine_dazzle canChain:
 * free monster (no master), not reward boss, base targetDistance > 1.
 *
 * @param {object} spell
 * @param {object} caster
 * @param {object} cand
 * @returns {boolean}
 */
function chainCanPick(spell, caster, cand) {
    if (!isValidTarget(caster, cand)) return false;
    if (!spell || !spell.chainOnlyRanged) return true;
    if (!isChallengeableCreature(cand)) return false;
    if (
        cand.isRewardBoss === true ||
        (cand.flags && cand.flags.rewardBoss === true) ||
        (cand.kit && cand.kit.flags && cand.kit.flags.rewardBoss === true)
    ) {
        return false;
    }
    return baseTargetDistance(cand) > 1;
}

/**
 * Self-origin support chain (no sticky primary required).
 * @param {object|null|undefined} spell
 * @returns {boolean}
 */
function isSelfOriginChainSpell(spell) {
    return !!(
        spell &&
        spellHasChain(spell) &&
        spell.requiresTarget === false
    );
}

function isSpellInRange(attacker, defender, spell, ctx) {
    if (!attacker || !spell || !attacker.tile) return false;

    if (isSelfCenteredAreaSpell(spell)) {
        const c = ctx || {};
        const tileMap =
            c.tileMap || (c.sim && c.sim.tileMap) || null;
        const candidates = shapeCandidatesFromCtx(attacker, c);
        const foot = computeSpellFootprint({
            attacker,
            primary: defender || null,
            spell,
            candidates,
            tileMap
        });
        if (!foot.affectedTiles || !foot.affectedTiles.length) return false;
        const z =
            foot.center && foot.center.z !== undefined
                ? foot.center.z
                : attacker.tile.z;
        const pool = livingHostilePool(attacker, defender, candidates);
        return entitiesOnTiles(pool, foot.affectedTiles, z).length > 0;
    }

    // Self-origin chain (chivalrous_challenge / divine_dazzle): any pickable hop.
    if (isSelfOriginChainSpell(spell)) {
        const c = ctx || {};
        const tileMap =
            c.tileMap || (c.sim && c.sim.tileMap) || null;
        const candidates = shapeCandidatesFromCtx(attacker, c);
        const spec = normalizeChainSpec(spell);
        if (!spec) return false;
        const picked = pickChainTargets({
            caster: attacker,
            primary: null,
            candidates,
            maxTargets: spec.maxTargets,
            distance: spec.distance,
            backtracking: spec.backtracking,
            tileMap,
            canPick: (caster, cand) => chainCanPick(spell, caster, cand)
        });
        return picked.hops.length > 0;
    }

    if (!defender || defender.alive === false) return false;
    if (defender.hp && defender.hp.current <= 0) return false;
    const r = resolveSpellRange(attacker, spell);
    if (
        !isWithinSpellCastRange(
            attacker.tile,
            defender.tile,
            spell,
            r
        )
    ) {
        return false;
    }

    // Single-target / wave / ranged-area gate: solid tiles block shots.
    // Self-centered and self-origin chain already returned above.
    const c = ctx || {};
    const tileMap = c.tileMap || (c.sim && c.sim.tileMap) || null;
    if (tileMap && attacker.tile && defender.tile) {
        if (
            !hasLineOfSight(
                attacker.tile.x,
                attacker.tile.y,
                attacker.tile.z,
                defender.tile.x,
                defender.tile.y,
                defender.tile.z,
                tileMap
            )
        ) {
            return false;
        }
    }
    return true;
}

/**
 * Candidate entities for multi-target shape hits from hunt ctx.
 * Players hit creatures (ctx.enemies); creatures hit party (ctx.players).
 * @param {object} attacker
 * @param {object} ctx
 * @returns {object[]}
 */
function shapeCandidatesFromCtx(attacker, ctx) {
    const c = ctx || {};
    if (Array.isArray(c.candidates) && c.candidates.length) {
        return c.candidates;
    }
    if (attacker && attacker.type === 'creature') {
        return c.players || [];
    }
    // Player / default: hostile creatures
    return c.enemies || [];
}

/**
 * Record one or many attack results into sim telemetry / VFX.
 * Multi-target: one recordAttack per defender. Mana counted only on the first
 * sample; footprint tiles attached only once for aoe VFX.
 * @param {object} attacker
 * @param {object|null} primary
 * @param {object} result
 * @param {object} ctx
 */
function recordAttackResult(attacker, primary, result, ctx) {
    if (!result || !result.ok) return;
    const c = ctx || {};
    if (result.multi && Array.isArray(result.results) && result.results.length) {
        for (let i = 0; i < result.results.length; i++) {
            const r = result.results[i];
            const def =
                result.hits && result.hits[i] ? result.hits[i] : null;
            if (!def || !r || !r.ok) continue;

            // Clone lightly so we can zero mana on secondary samples and attach
            // footprint metadata only on the first (aoe VFX once).
            /** @type {object} */
            const bag = Object.assign({}, r);
            if (i === 0) {
                bag.multi = true;
                bag.affectedTiles = result.affectedTiles;
                bag.center = result.center;
                bag.direction = result.direction;
                bag.hits = result.hits;
                bag.results = result.results;
                if (result.chain) {
                    bag.chain = true;
                    bag.chainLinks = result.chainLinks;
                }
            } else {
                bag.multi = false;
                // Avoid double-counting spell mana in telemetry
                if (bag.spell && bag.spell.mana) {
                    bag.spell = Object.assign({}, bag.spell, { mana: 0 });
                }
            }

            if (c.sim && typeof c.sim.recordAttack === 'function') {
                c.sim.recordAttack(attacker, def, bag);
            } else if (typeof c.onAttack === 'function') {
                c.onAttack(attacker, def, bag);
            }
        }
        return;
    }

    if (c.sim && typeof c.sim.recordAttack === 'function') {
        c.sim.recordAttack(attacker, primary, result);
    } else if (typeof c.onAttack === 'function') {
        c.onAttack(attacker, primary, result);
    }
}

/**
 * Attack if in range; returns resolveAttack (or shaped multi) result, or null.
 *
 * When the spell has `shape` (area / wave / beam), hits every living candidate
 * on the footprint (ctx.enemies or ctx.players). Mana/CD spent once.
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object} opts.defender
 * @param {string} opts.spellId
 * @param {object} opts.ctx hunt context { spellBook, sim, onAttack, enemies, players, tileMap }
 * @param {'primary'|'maximize'} [opts.centerMode] ranged area blast center policy
 * @returns {object|null}
 */
function tryAttack(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const defender = o.defender;
    const spellId = o.spellId || 'melee_auto';
    const ctx = o.ctx || {};
    if (!attacker || !attacker.alive) return null;

    const spell = getSpell(spellId, ctx);
    if (!spell && !isAutoAttackId(spellId)) return null;
    const def = spell || defaultAutoSpell(spellId) || defaultMeleeAutoSpell();
    // Self-origin chain / self-buff may omit a sticky primary.
    const selfOrigin = isSelfOriginChainSpell(def);
    if (
        !selfOrigin &&
        (!defender || defender.alive === false)
    ) {
        return null;
    }
    if (!isSpellInRange(attacker, defender || null, def, ctx)) return null;
    if (!canCast(attacker, def, ctx)) return null;

    // Chain multi-hop (chain_rebuke, chivalrous_challenge, divine_dazzle, …).
    // Prefer chain over shape if both are set (catalog should not combine).
    if (spellHasChain(def)) {
        const tileMap =
            ctx.tileMap ||
            (ctx.sim && ctx.sim.tileMap) ||
            null;
        const candidates = shapeCandidatesFromCtx(attacker, ctx);
        // Self-origin chains (requiresTarget false) ignore sticky primary so the
        // hop search starts at the caster (legacy getChainValue self path).
        const selfOrigin = isSelfOriginChainSpell(def);
        const primary =
            selfOrigin || !defender || defender === attacker
                ? null
                : defender;
        const result = resolveChainAttack({
            attacker,
            primary,
            spell: def,
            candidates,
            tileMap,
            spellBook: spellBookFromCtx(ctx),
            rng: ctx.rng || Math.random,
            canPick: (caster, cand) => chainCanPick(def, caster, cand)
        });
        if (!result.ok) return null;
        spendRune(attacker, def, ctx);
        recordAttackResult(
            attacker,
            primary || (result.hits && result.hits[0]) || defender,
            result,
            ctx
        );
        return result;
    }

    // Shaped multi-target (rampage, front_sweep, GFB, waves, field runes, …)
    if (spellHasShape(def)) {
        const tileMap =
            ctx.tileMap ||
            (ctx.sim && ctx.sim.tileMap) ||
            null;
        const candidates = shapeCandidatesFromCtx(attacker, ctx);
        const groundStore =
            ctx.groundStore ||
            (ctx.sim && (ctx.sim.groundItems || ctx.sim.groundStore)) ||
            (tileMap && (tileMap.groundStore || tileMap.groundItems)) ||
            null;
        // Default: maximize multi-hit (AI + Smart Cast). Manual Active Target
        // / castWith tile pass centerMode 'primary'; aim-only always primary.
        let centerMode = o.centerMode;
        if (centerMode !== 'primary' && centerMode !== 'maximize') {
            centerMode =
                defender && defender._aimOnly ? 'primary' : 'maximize';
        }
        const result = resolveShapedAttack({
            attacker,
            primary: defender,
            spell: def,
            candidates,
            tileMap,
            groundStore,
            sim: ctx.sim || null,
            spellBook: spellBookFromCtx(ctx),
            rng: ctx.rng || Math.random,
            centerMode
        });
        if (!result.ok) return null;
        // Consume rune once cast is accepted (even if 0 creatures hit).
        // Empty footprint already fails as no_tiles above — no spend.
        spendRune(attacker, def, ctx);
        recordAttackResult(attacker, defender, result, ctx);
        return result;
    }

    const result = resolveAttack({
        attacker,
        defender,
        spell: def,
        spellBook: spellBookFromCtx(ctx),
        rng: ctx.rng || Math.random
    });

    if (result && result.ok) {
        spendRune(attacker, def, ctx);
    }
    recordAttackResult(attacker, defender, result, ctx);
    return result;
}

/**
 * Self-heal when HP is below strategy.healHpPercent and heal spell is ready.
 * Uses resolveAttack with defender = self; element healing restores HP.
 *
 * @param {object} opts
 * @param {object} opts.attacker Player casting the heal
 * @param {object} [opts.strategy] Strategy bag (healHpPercent, healSpellId)
 * @param {object} opts.ctx Hunt context { spellBook, sim, rng }
 * @param {object} [opts.target] Ally to heal (defaults to self)
 * @returns {object|null} resolveAttack result when cast, else null
 */
function tryHeal(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const ctx = o.ctx || {};
    if (!attacker || !attacker.alive) return null;

    const st = o.strategy || attacker.strategy || {};
    const threshold =
        st.healHpPercent != null ? Number(st.healHpPercent) : 0.35;
    if (!(threshold > 0)) return null;

    const target = o.target && o.target.alive !== false ? o.target : attacker;
    if (!target || !target.alive) return null;
    if (hpPercent(target) >= threshold) return null;

    const spellId =
        st.healSpellId ||
        (st.healSpell != null ? st.healSpell : null) ||
        DEFAULT_HEAL_SPELL_ID;
    if (!spellId) return null;

    const spell = getSpell(spellId, ctx);
    if (!spell || spell.element !== 'healing') return null;
    if (!canCast(attacker, spell, ctx)) return null;

    return tryAttack({
        attacker,
        defender: target,
        spellId,
        ctx
    });
}

/**
 * Cast a self-cure when the target has a matching condition and the spell is ready.
 * Uses class book + mana/CD gates via canCast / canUseSpell.
 *
 * @param {object} opts
 * @param {object} opts.attacker
 * @param {object} [opts.ctx]
 * @param {object} [opts.target] defaults to self
 * @returns {object|null} resolveAttack result when cast, else null
 */
function tryCure(opts) {
    const o = opts || {};
    const attacker = o.attacker;
    const ctx = o.ctx || {};
    if (!attacker || !attacker.alive) return null;

    const target = o.target && o.target.alive !== false ? o.target : attacker;
    if (!target || !target.alive) return null;

    for (let i = 0; i < CURE_BY_CONDITION.length; i++) {
        const row = CURE_BY_CONDITION[i];
        if (!hasCondition(target, row.kind)) continue;
        const spell = getSpell(row.spellId, ctx);
        if (!spell || !Array.isArray(spell.dispel) || !spell.dispel.length) {
            continue;
        }
        if (!canCast(attacker, spell, ctx)) continue;
        return tryAttack({
            attacker,
            defender: target,
            spellId: row.spellId,
            ctx
        });
    }
    return null;
}

/**
 * Step one tile toward a world tile if moveDelay allows.
 * Same-floor only — cross-floor must go through stairs / followLongPath.
 *
 * @param {object} entity
 * @param {{ x: number, y: number, z?: string|number }} dest
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @param {{ allowLongPath?: boolean, longPathDistance?: number }} [opts]
 *   When allowLongPath and Chebyshev distance exceeds longPathDistance
 *   (default PATH_MAX_DISTANCE), uses followLongPath + navmesh instead of
 *   local A* — follower far catch-up on large floors.
 * @returns {boolean} true if a step was taken
 */
function stepToward(entity, dest, tileMap, opts) {
    if (!entity || !entity.canStep || !entity.canStep()) return false;
    if (!entity.tile || !dest || !tileMap) return false;
    const z = dest.z !== undefined ? dest.z : entity.tile.z;
    // Local stepToward cannot cross floors (would path x,y on start layer and
    // apply targetZ — freeze/teleport). Callers must use Party.stepTowardFloor.
    if (String(entity.tile.z) !== String(z)) {
        // E5: stop following stale same-floor path when goal is other floor
        if (Array.isArray(entity.path) && entity.path.length) {
            entity.path = [];
        }
        return false;
    }
    if (
        entity.tile.x === dest.x &&
        entity.tile.y === dest.y &&
        String(entity.tile.z) === String(z)
    ) {
        return false;
    }
    const from = { x: entity.tile.x, y: entity.tile.y, z: entity.tile.z };
    const cheb = Math.max(
        Math.abs(dest.x - entity.tile.x),
        Math.abs(dest.y - entity.tile.y)
    );
    const localCap =
        Settings.PATH_MAX_DISTANCE != null
            ? Number(Settings.PATH_MAX_DISTANCE)
            : 100;
    // Creatures / summons use shorter chase radius (Option B); players keep full local cap
    const isPlayer = entity.type === 'player';
    const creatureCap =
        Settings.AI_CREATURE_PATH_MAX_DISTANCE != null
            ? Number(Settings.AI_CREATURE_PATH_MAX_DISTANCE)
            : 12;
    const pathCap =
        opts && opts.maxDistance != null
            ? Number(opts.maxDistance)
            : isPlayer
              ? localCap
              : Number.isFinite(creatureCap) && creatureCap > 0
                ? creatureCap
                : localCap;
    const longDist =
        opts && opts.longPathDistance != null
            ? Number(opts.longPathDistance)
            : localCap;
    if (
        opts &&
        opts.allowLongPath &&
        cheb > longDist &&
        typeof tileMap.followLongPath === 'function'
    ) {
        tileMap.followLongPath(entity, dest.x, dest.y, z, {
            enforceRequestCap: false,
            useNavmeshBeyondCap: true
        });
    } else {
        tileMap.followPath(entity, dest.x, dest.y, z, pathCap);
    }
    return (
        entity.tile.x !== from.x ||
        entity.tile.y !== from.y ||
        String(entity.tile.z) !== String(from.z)
    );
}

/**
 * Count free adjacent tiles around a world tile (openness for melee packing).
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {object} self entity used for canEnter occupancy rules
 * @returns {number}
 */
function openNeighborCount(tileMap, x, y, z, self) {
    if (!tileMap) return 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (tileMap.canEnter(x + dx, y + dy, z, self)) n += 1;
        }
    }
    return n;
}

/**
 * Best free tile adjacent to *target* for melee engagement.
 * Legacy paths onto an open neighbor of the mob, not the mob cell itself.
 * Prefers the adjacent tile closest to self; null if self is already adjacent
 * and can stay (caller may still micro-reposition).
 *
 * @param {object} self
 * @param {object} target
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function engageAdjacentTile(self, target, tileMap) {
    if (!self || !self.tile || !target || !target.tile || !tileMap) return null;
    const z = target.tile.z !== undefined ? target.tile.z : self.tile.z;
    const curD = tileDistance(self.tile, target.tile);
    // Already in melee range (Chebyshev ≤ 1) and not on target tile
    if (
        curD <= 1 &&
        !(self.tile.x === target.tile.x && self.tile.y === target.tile.y)
    ) {
        return null;
    }

    let best = null;
    let bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = target.tile.x + dx;
            const ny = target.tile.y + dy;
            if (!tileMap.canEnter(nx, ny, z, self)) continue;
            // Prefer closer to self; slight openness tie-break; hard-prefer
            // non-hazard tiles so canWalkOn* false mobs do not engage onto fields.
            const dSelf = tileDistance(self.tile, { x: nx, y: ny });
            const open = openNeighborCount(tileMap, nx, ny, z, self);
            const hazard = isTileFieldHazardForEntity(tileMap, nx, ny, z, self)
                ? 1000
                : 0;
            const score = hazard + dSelf * 10 - open;
            if (score < bestScore) {
                bestScore = score;
                best = { x: nx, y: ny, z };
            }
        }
    }
    return best;
}

/**
 * When already adjacent, prefer a free neighbor that stays on the target and
 * has more open space (simplified legacy soloEK pack micro-step).
 *
 * @param {object} self
 * @param {object} target
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function meleeMicroTile(self, target, tileMap) {
    if (!self || !self.tile || !target || !target.tile || !tileMap) return null;
    if (tileDistance(self.tile, target.tile) > 1) return null;

    const z = self.tile.z;
    const curHazard = isTileFieldHazardForEntity(
        tileMap,
        self.tile.x,
        self.tile.y,
        z,
        self
    );
    const curOpen = openNeighborCount(tileMap, self.tile.x, self.tile.y, z, self);
    let best = null;
    let bestScore = curOpen - (curHazard ? 100 : 0);
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = self.tile.x + dx;
            const ny = self.tile.y + dy;
            if (!tileMap.canEnter(nx, ny, z, self)) continue;
            // Stay adjacent to target
            if (tileDistance({ x: nx, y: ny }, target.tile) > 1) continue;
            if (isTileFieldHazardForEntity(tileMap, nx, ny, z, self)) continue;
            const open = openNeighborCount(tileMap, nx, ny, z, self);
            if (open > bestScore) {
                bestScore = open;
                best = { x: nx, y: ny, z };
            }
        }
    }
    return best;
}

/**
 * Prefer a tile that is ~keepDistance away from target (simple kite).
 * Picks a free walkable neighbor that increases distance when too close.
 *
 * @param {object} self
 * @param {object} target
 * @param {number} keepDistance
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function repositionTile(self, target, keepDistance, tileMap) {
    if (!self || !self.tile || !target || !target.tile || !tileMap) return null;
    const want = Math.max(1, keepDistance | 0);
    const cur = tileDistance(self.tile, target.tile);
    if (cur >= want) return null;

    const z = self.tile.z;
    let best = null;
    let bestScore = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = self.tile.x + dx;
            const ny = self.tile.y + dy;
            if (!tileMap.canEnter(nx, ny, z, self)) continue;
            if (isTileFieldHazardForEntity(tileMap, nx, ny, z, self)) continue;
            const d = tileDistance({ x: nx, y: ny }, target.tile);
            // Prefer tiles that restore keepDistance without going past aggro stretch
            const score = d - Math.abs(d - want) * 0.25;
            if (score > bestScore) {
                bestScore = score;
                best = { x: nx, y: ny, z };
            }
        }
    }
    return best;
}

/**
 * Continuous combat footing (legacy kite / stand-still anti-bias simplified).
 * Scores current tile + free neighbors every call — not only when too close.
 *
 * Score drivers:
 *  - distance to target near `keepDistance` (peak at want)
 *  - mild diagonal step penalty
 *  - openness (escape tiles)
 *  - soft pull toward optional battleWP
 *  - anti-still when standingCounter is high
 *
 * @param {object} self
 * @param {object} target
 * @param {object} [opts]
 * @param {number} [opts.keepDistance=1]
 * @param {number} [opts.standingCounter=0]
 * @param {{ x: number, y: number }} [opts.battleWP]
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @returns {{ x: number, y: number, z: string|number }|null} best tile (may equal current)
 */
function pickCombatMoveTile(self, target, opts, tileMap) {
    if (!self || !self.tile || !tileMap) return null;
    const o = opts || {};
    const want = Math.max(1, (o.keepDistance != null ? o.keepDistance : 1) | 0);
    const standing =
        o.standingCounter != null ? Number(o.standingCounter) : 0;
    const battleWP = o.battleWP || null;
    const z = self.tile.z;
    const tgt = target && target.tile ? target.tile : null;

    let best = { x: self.tile.x, y: self.tile.y, z };
    let bestScore = -Infinity;

    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const nx = self.tile.x + dx;
            const ny = self.tile.y + dy;
            const isStill = dx === 0 && dy === 0;
            if (!isStill && !tileMap.canEnter(nx, ny, z, self)) continue;

            let score = 0;
            // Diagonal step cost (legacy mild penalty)
            if (dx !== 0 && dy !== 0) score -= 5;

            // Strong bias off elemental hazards this entity cannot walk on
            // (creature fields affect creatures; only player fields ignore other players).
            if (!isStill && isTileFieldHazardForEntity(tileMap, nx, ny, z, self)) {
                score -= 80;
            }

            if (tgt) {
                const d = tileDistance({ x: nx, y: ny }, tgt);
                // Peak at keepDistance; soft falloff either side
                const err = Math.abs(d - want);
                score += 20 - err * 12;
                if (d < want) score -= (want - d) * 8;
                if (d > want + 2) score -= (d - want - 2) * 3;
            }

            const open = openNeighborCount(tileMap, nx, ny, z, self);
            score += open * 1.5;

            if (battleWP) {
                const wpD = tileDistance({ x: nx, y: ny }, battleWP);
                if (wpD > 4) score -= ((wpD - 4) * (wpD - 4)) / 5;
                else score += 2;
            }

            // Legacy anti-still: after ~0.5s parked, bias against standing
            if (isStill && standing > 0.5) {
                score -= 2 + standing * 0.5;
            }

            if (score > bestScore) {
                bestScore = score;
                best = { x: nx, y: ny, z };
            }
        }
    }
    return best;
}

/**
 * Melee engage destination: adjacent tile when out of range, else micro-step.
 * @param {object} self
 * @param {object} target
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function pickMeleeMoveTile(self, target, tileMap) {
    if (!self || !self.tile || !target || !target.tile || !tileMap) return null;
    const d = tileDistance(self.tile, target.tile);
    if (d > 1) {
        return engageAdjacentTile(self, target, tileMap) || {
            x: target.tile.x,
            y: target.tile.y,
            z: target.tile.z !== undefined ? target.tile.z : self.tile.z
        };
    }
    return meleeMicroTile(self, target, tileMap);
}

/**
 * Random free adjacent step (legacy idle wander / path fallback).
 * @param {object} entity
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @param {() => number} [rng]
 * @returns {boolean} true if a step was taken
 */
function stepRandomAdjacent(entity, tileMap, rng) {
    if (!entity || !entity.tile || !tileMap) return false;
    if (entity.canStep && !entity.canStep()) return false;
    const z = entity.tile.z;
    const opts = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = entity.tile.x + dx;
            const ny = entity.tile.y + dy;
            if (!tileMap.canEnter(nx, ny, z, entity)) continue;
            if (isTileFieldHazardForEntity(tileMap, nx, ny, z, entity)) continue;
            opts.push({ x: nx, y: ny, z });
        }
    }
    if (!opts.length) return false;
    const r = typeof rng === 'function' ? rng() : Math.random();
    const pick = opts[Math.floor(r * opts.length)];
    return stepToward(entity, pick, tileMap);
}

/**
 * Walkable tiles adjacent to *self* that stay adjacent to *target* (melee orbit).
 * Does **not** filter occupancy — caller picks one tile then checks canEnter once
 * (no retry over the list; preserves single-rng determinism).
 *
 * Order is fixed (row-major dy, dx) so seeded rng picks are stable.
 *
 * @param {object} self
 * @param {object} target
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @returns {{ x: number, y: number, z: string|number }[]}
 */
function listMeleeCircleCandidates(self, target, tileMap) {
    if (!self || !self.tile || !target || !target.tile || !tileMap) return [];
    if (String(self.tile.z) !== String(target.tile.z)) return [];
    const z = self.tile.z;
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = self.tile.x + dx;
            const ny = self.tile.y + dy;
            if (!tileMap.isWalkable(nx, ny, z)) continue;
            // Stay in melee of target; never step onto the target cell
            if (tileDistance({ x: nx, y: ny }, target.tile) > 1) continue;
            if (nx === target.tile.x && ny === target.tile.y) continue;
            if (isTileFieldHazardForEntity(tileMap, nx, ny, z, self)) continue;
            out.push({ x: nx, y: ny, z });
        }
    }
    return out;
}

/**
 * One-shot melee circle step: chance roll → pick one intersecting adjacent tile
 * → occupancy check → move or abort (no alternate tiles).
 *
 * @param {object} self
 * @param {object} target
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @param {object} [opts]
 * @param {() => number} [opts.rng]
 * @param {number} [opts.chance] 0–100; default Settings.AI_CREATURE_CIRCLE_CHANCE
 * @param {() => boolean} [opts.isDue] when false, skip without rolling
 * @param {() => void} [opts.onNoMove] called when an attempt was made but no step
 * @returns {'moved'|'blocked'|'no_candidates'|'skipped'|'chance_fail'|'locked'}
 */
function tryMeleeCircleStep(self, target, tileMap, opts) {
    const o = opts || {};
    if (!self || !self.tile || !target || !target.tile || !tileMap) {
        return 'skipped';
    }
    if (self.canStep && !self.canStep()) return 'locked';
    if (typeof o.isDue === 'function' && !o.isDue()) return 'skipped';

    const chanceRaw =
        o.chance != null
            ? Number(o.chance)
            : Settings.AI_CREATURE_CIRCLE_CHANCE != null
              ? Number(Settings.AI_CREATURE_CIRCLE_CHANCE)
              : 30;
    const chance = Math.max(0, Math.min(100, chanceRaw));
    if (chance <= 0) return 'skipped';

    const rng = typeof o.rng === 'function' ? o.rng : Math.random;
    if (rng() * 100 >= chance) return 'chance_fail';

    const cands = listMeleeCircleCandidates(self, target, tileMap);
    if (!cands.length) {
        if (typeof o.onNoMove === 'function') o.onNoMove();
        return 'no_candidates';
    }

    const pick = cands[Math.floor(rng() * cands.length)];
    // Single occupancy check — do not scan for another free tile
    if (!tileMap.canEnter(pick.x, pick.y, pick.z, self)) {
        if (typeof o.onNoMove === 'function') o.onNoMove();
        return 'blocked';
    }

    const moved = stepToward(self, pick, tileMap);
    if (!moved) {
        if (typeof o.onNoMove === 'function') o.onNoMove();
        return 'blocked';
    }
    return 'moved';
}

/**
 * Tile one step away from target (flee).
 * @param {object} self
 * @param {object} threat
 * @param {import('../../entities/tilemap.js').TileMap} tileMap
 * @returns {{ x: number, y: number, z: string|number }|null}
 */
function fleeTile(self, threat, tileMap) {
    if (!self || !self.tile || !tileMap) return null;
    const z = self.tile.z;
    let best = null;
    let bestD = -1;
    const tx = threat && threat.tile ? threat.tile.x : self.tile.x;
    const ty = threat && threat.tile ? threat.tile.y : self.tile.y;
    const curD = tileDistance(self.tile, { x: tx, y: ty });
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = self.tile.x + dx;
            const ny = self.tile.y + dy;
            if (!tileMap.canEnter(nx, ny, z, self)) continue;
            const d = tileDistance({ x: nx, y: ny }, { x: tx, y: ty });
            if (d > bestD) {
                bestD = d;
                best = { x: nx, y: ny, z };
            }
        }
    }
    if (bestD > curD) {
        return best;
    }
    return null;
}

module.exports = {
    DEFAULT_HEAL_SPELL_ID,
    DEFAULT_WAND_AUTO_RANGE,
    AUTO_BY_WEAPON,
    spellBookFromCtx,
    getSpell,
    defaultAutoSpell,
    resolveWeaponType,
    resolveAutoAttackId,
    resolveSpellRange,
    isWithinSpellCastRange,
    isModeAutoAttackEnabled,
    isModeAmmoConsumptionEnabled,
    isModeRuneConsumptionEnabled,
    isModeMonsterSummonsEnabled,
    isMoveUnlocked,
    hasAmmo,
    spendAmmo,
    isRuneSpell,
    resolveRuneItemId,
    hasRune,
    spendRune,
    canUseSpell,
    meetsSpellLevel,
    meetsSpellMagicLevel,
    canCast,
    isSpellInRange,
    isSelfOriginChainSpell,
    chainCanPick,
    shapeCandidatesFromCtx,
    recordAttackResult,
    tryAttack,
    tryAutoAttack,
    tryHeal,
    tryCure,
    CURE_BY_CONDITION,
    stepToward,
    stepRandomAdjacent,
    openNeighborCount,
    engageAdjacentTile,
    meleeMicroTile,
    repositionTile,
    pickCombatMoveTile,
    pickMeleeMoveTile,
    listMeleeCircleCandidates,
    tryMeleeCircleStep,
    fleeTile
};
