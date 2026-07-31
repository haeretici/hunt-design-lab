/**
 * Combat VFX for watch mode: AOE footprint, death flash, projectile stub,
 * melee/auto hit slash. Queue via Simulator.emitCombatEffect / recordAttack —
 * no-op when HEADLESS.
 *
 * Distance auto with equipped ammo draws the ammo `customSprite` along the
 * shot path, rotated so the tip faces the defender (art is tip-up-right).
 */

'use strict';

const { Script } = require('./script.js');
const { Settings } = require('../../settings.js');
const { DEFAULT_GENRE } = require('../../settings.js');
const { Time } = require('../lib/time.js');
const { getVisualTilePos } = require('../lib/movement.js');
const {
    getReadySpriteImage,
    getCachedImageSize,
    defaultVariantForDisplay
} = require('../lib/creature_sprites.js');

/** @typedef {'aoe'|'death'|'projectile'|'melee'} CombatFxType */

/**
 * Source ammo PNGs point tip toward upper-right (≈ −45° from +X / 45° CW from up).
 * Subtract this when rotating so the tip tracks flight direction.
 * Tunable if catalog art orientation changes.
 */
const AMMO_ART_TIP_ANGLE = -Math.PI / 4;

/**
 * Projectile sprite size as a fraction of min(tileW, tileH).
 * Slightly under one tile so arrows stay readable without covering the target.
 */
const PROJECTILE_SPRITE_SCALE = 0.72;

/**
 * @typedef {object} CombatFxEntry
 * @property {CombatFxType} type
 * @property {number} [x]
 * @property {number} [y]
 * @property {string|number} [z] floor (omit = draw on any floor)
 * @property {number} [x0]
 * @property {number} [y0]
 * @property {number} [x1]
 * @property {number} [y1]
 * @property {number} [sx] hit source tile x (attacker); used by AI debug hitSources
 * @property {number} [sy] hit source tile y
 * @property {number} [radius]
 * @property {{x:number,y:number}[]} [tiles] exact shape footprint (preferred over radius)
 * @property {string} [spellId] spell id for non-auto hits (AI debug hitSources label)
 * @property {string} [spriteId] catalog id for projectile art (ammo customSprite)
 * @property {string} [spriteGenre] genre folder for spriteId
 * @property {string} [spriteKind] catalog kind (default equipment for ammo)
 * @property {number} [spriteScale] draw size mult of min(tileW,tileH)
 * @property {string} color
 * @property {number} age
 * @property {number} life
 */

const ELEMENT_COLORS = Object.freeze({
    physical: '#e5e7eb',
    fire: '#f97316',
    ice: '#38bdf8',
    energy: '#a78bfa',
    earth: '#84cc16',
    death: '#c084fc',
    holy: '#fde047',
    healing: '#34d399',
    poison: '#4ade80',
    lifedrain: '#f472b6',
    manadrain: '#60a5fa'
});

/**
 * @param {string} [element]
 * @returns {string}
 */
function elementColor(element) {
    if (!element) return ELEMENT_COLORS.physical;
    const key = String(element).toLowerCase();
    return ELEMENT_COLORS[key] || ELEMENT_COLORS.physical;
}

/**
 * Pure: build ephemeral FX specs from one resolveAttack result.
 * Does not read Settings / DOM — safe for unit tests and headless callers.
 *
 * @param {object|null} attacker
 * @param {object|null} defender
 * @param {object|null} result resolveAttack result
 * @returns {object[]} plain opts suitable for CombatEffectsScript.push
 */
/**
 * Spell identifier for AI debug hit labels. Empty for auto attacks
 * (those keep the plain VFX type label: melee / projectile).
 * @param {object} spell
 * @returns {string}
 */
function spellIdForDebug(spell) {
    if (!spell || typeof spell !== 'object') return '';
    const kind = spell.kind != null ? String(spell.kind) : '';
    const id =
        spell.id != null
            ? String(spell.id)
            : spell.spellId != null
              ? String(spell.spellId)
              : '';
    if (kind === 'auto' || id === 'melee_auto' || id === 'auto') return '';
    if (spell.powerCurve === 'melee_auto' && (!id || id === 'melee_auto')) {
        return '';
    }
    return id;
}

/**
 * Attach optional spellId onto an FX opts object (non-auto only).
 * @param {object} opts
 * @param {string} spellId
 * @returns {object}
 */
function withSpellId(opts, spellId) {
    if (spellId) opts.spellId = spellId;
    return opts;
}

/**
 * Floor z for FX (prefer impact / defender, then attacker).
 * @param {{ z?: string|number }|null} aTile
 * @param {{ z?: string|number }|null} dTile
 * @returns {string|number|undefined}
 */
function floorZFromTiles(aTile, dTile) {
    if (dTile && dTile.z !== undefined && dTile.z !== null) return dTile.z;
    if (aTile && aTile.z !== undefined && aTile.z !== null) return aTile.z;
    return undefined;
}

/**
 * @param {object} opts
 * @param {string|number|undefined} z
 * @returns {object}
 */
function withFloorZ(opts, z) {
    if (z !== undefined && z !== null) opts.z = z;
    return opts;
}

/**
 * Whether this attack should draw equipped-ammo art on the projectile.
 * Distance auto (bow/xbow) and any spell flagged requiresAmmo.
 * Magic bolts / generic spells keep the abstract colored streak.
 *
 * @param {object} spell
 * @param {object|null} attacker
 * @returns {boolean}
 */
function usesAmmoProjectileSprite(spell, attacker) {
    if (!spell || typeof spell !== 'object') return false;
    if (spell.requiresAmmo === true) return true;
    const id =
        spell.id != null
            ? String(spell.id)
            : spell.spellId != null
              ? String(spell.spellId)
              : '';
    if (id === 'distance_auto') return true;
    if (spell.powerCurve === 'distance_auto') return true;
    const cs =
        attacker &&
        (attacker.combatStats || attacker.effectiveStats || null);
    if (
        cs &&
        (cs.weaponType === 'distance' || cs.weaponType === 'ranged') &&
        (spell.kind === 'auto' || id === 'auto')
    ) {
        return true;
    }
    return false;
}

/**
 * Resolve watch-mode projectile sprite opts from attacker ammo loadout.
 * Pure: reads combatStats / equipment bags only (no Image / DOM).
 *
 * Priority: combatStats.ammoSprite → leftHand item customSprite/spriteId/id.
 *
 * @param {object|null} attacker
 * @param {object} spell
 * @returns {{ spriteId: string, spriteGenre?: string, spriteKind: string, spriteScale: number }|null}
 */
function resolveAmmoProjectileSprite(attacker, spell) {
    if (!usesAmmoProjectileSprite(spell, attacker) || !attacker) return null;

    const cs =
        attacker.combatStats || attacker.effectiveStats || null;
    let spriteId =
        cs && cs.ammoSprite != null && String(cs.ammoSprite).trim()
            ? String(cs.ammoSprite).trim()
            : null;
    let spriteGenre =
        cs && cs.ammoSpriteGenre != null && String(cs.ammoSpriteGenre).trim()
            ? String(cs.ammoSpriteGenre).trim()
            : null;

    // Fallback: resolve leftHand ammo from loadout itemDb when stats lack art
    if (!spriteId && attacker.equipment) {
        const left =
            attacker.equipment.leftHand != null
                ? attacker.equipment.leftHand
                : attacker.equipment.shield;
        if (left != null && left !== '') {
            let item = null;
            const db = attacker._loadoutItemDb || attacker.itemDb || null;
            if (db && typeof db === 'object') {
                if (Array.isArray(db)) {
                    for (let i = 0; i < db.length; i++) {
                        if (db[i] && String(db[i].id) === String(left)) {
                            item = db[i];
                            break;
                        }
                    }
                } else if (db[left]) {
                    item = db[left];
                } else if (db[String(left)]) {
                    item = db[String(left)];
                }
            }
            if (item) {
                const cat = item.category != null ? String(item.category) : '';
                const isAmmo =
                    cat === 'ammo' ||
                    cat === 'ammunition' ||
                    (Array.isArray(item.type) &&
                        item.type.indexOf('ammunition') >= 0);
                if (isAmmo) {
                    spriteId =
                        (item.customSprite != null &&
                            String(item.customSprite).trim()) ||
                        (item.spriteId != null && String(item.spriteId).trim()) ||
                        (item.id != null && String(item.id).trim()) ||
                        null;
                    spriteGenre =
                        (item.customSpriteGenre != null &&
                            String(item.customSpriteGenre).trim()) ||
                        (item.spriteGenre != null &&
                            String(item.spriteGenre).trim()) ||
                        null;
                }
            }
        }
    }

    if (!spriteId) return null;
    return {
        spriteId,
        spriteGenre: spriteGenre || undefined,
        spriteKind: 'equipment',
        spriteScale: PROJECTILE_SPRITE_SCALE
    };
}

/**
 * Canvas rotation (radians) so art tip faces flight vector (dx, dy).
 * Compensates for AMMO_ART_TIP_ANGLE (source tip at upper-right).
 *
 * @param {number} dx pixel delta x (toward target)
 * @param {number} dy pixel delta y (toward target; +down)
 * @param {number} [artTipAngle=AMMO_ART_TIP_ANGLE]
 * @returns {number}
 */
function projectileRotation(dx, dy, artTipAngle) {
    const flight = Math.atan2(dy, dx);
    const tip =
        artTipAngle != null && Number.isFinite(Number(artTipAngle))
            ? Number(artTipAngle)
            : AMMO_ART_TIP_ANGLE;
    return flight - tip;
}

function effectsFromAttack(attacker, defender, result) {
    const out = [];
    if (!result || !result.ok) return out;

    const spell = result.spell || {};
    const element = spell.element || 'physical';
    const color = elementColor(element);
    const spellId = spellIdForDebug(spell);
    const aTile = attacker ? (getVisualTilePos(attacker) || attacker.tile) : null;
    const dTile = defender ? (getVisualTilePos(defender) || defender.tile) : null;
    const floorZ = floorZFromTiles(aTile, dTile);

    // Secondary samples of a multi-target cast: death only (footprint already drawn)
    const secondaryMulti = result.multi === false;

    const range =
        spell.range != null ? Number(spell.range) : 1;
    const isMelee =
        spell.isMelee === true ||
        (spell.isMelee == null &&
            (spell.kind === 'auto' ||
                spell.powerCurve === 'melee_auto' ||
                spell.powerCurve === 'melee_strike' ||
                range <= 1));
    const radius =
        spell.radius != null ? Math.max(0, Number(spell.radius) | 0) : 0;
    const shapeType =
        spell.shape && spell.shape.type != null
            ? String(spell.shape.type)
            : '';
    const attackKind =
        spell.attackKind != null
            ? String(spell.attackKind)
            : shapeType === 'area' ||
                shapeType === 'wave' ||
                shapeType === 'beam'
              ? shapeType === 'beam'
                  ? 'wave'
                  : shapeType
              : spell.kind != null
                ? String(spell.kind)
                : '';
    const hasFootprint =
        Array.isArray(result.affectedTiles) && result.affectedTiles.length > 0;
    const isShaped =
        !secondaryMulti &&
        (hasFootprint ||
            attackKind === 'area' ||
            attackKind === 'wave' ||
            radius > 0 ||
            shapeType === 'area' ||
            shapeType === 'wave' ||
            shapeType === 'beam');

    if (!secondaryMulti) {
        // Projectile: ranged non-melee bolt/shot (not for shaped AoE/wave)
        if (aTile && dTile && !isMelee && range > 1 && !isShaped) {
            /** @type {object} */
            const projOpts = {
                type: 'projectile',
                x0: aTile.x,
                y0: aTile.y,
                x1: dTile.x,
                y1: dTile.y,
                sx: aTile.x,
                sy: aTile.y,
                color,
                life: 0.2
            };
            const ammoSpr = resolveAmmoProjectileSprite(attacker, spell);
            if (ammoSpr) {
                projOpts.spriteId = ammoSpr.spriteId;
                if (ammoSpr.spriteGenre) projOpts.spriteGenre = ammoSpr.spriteGenre;
                projOpts.spriteKind = ammoSpr.spriteKind || 'equipment';
                if (ammoSpr.spriteScale != null) {
                    projOpts.spriteScale = ammoSpr.spriteScale;
                }
            }
            out.push(withSpellId(withFloorZ(projOpts, floorZ), spellId));
        }

        // Melee / auto swing: short slash toward impact (single-target only)
        if (dTile && isMelee && !isShaped) {
            const sx = aTile ? aTile.x : dTile.x;
            const sy = aTile ? aTile.y : dTile.y;
            out.push(
                withSpellId(
                    withFloorZ(
                        {
                            type: 'melee',
                            x0: sx,
                            y0: sy,
                            x1: dTile.x,
                            y1: dTile.y,
                            sx,
                            sy,
                            color,
                            life: 0.18
                        },
                        floorZ
                    ),
                    spellId
                )
            );
        }

        // AOE / wave footprint: prefer exact shape tiles; else Chebyshev disk
        if (isShaped) {
            const cx =
                result.center && result.center.x != null
                    ? result.center.x
                    : dTile
                      ? dTile.x
                      : aTile
                        ? aTile.x
                        : 0;
            const cy =
                result.center && result.center.y != null
                    ? result.center.y
                    : dTile
                      ? dTile.y
                      : aTile
                        ? aTile.y
                        : 0;
            /** @type {object} */
            const aoeOpts = {
                type: 'aoe',
                x: cx,
                y: cy,
                radius: radius,
                sx: aTile ? aTile.x : undefined,
                sy: aTile ? aTile.y : undefined,
                color,
                life: 0.35
            };
            if (hasFootprint) {
                aoeOpts.tiles = result.affectedTiles.map((t) => ({
                    x: t.x,
                    y: t.y
                }));
            }
            out.push(withSpellId(withFloorZ(aoeOpts, floorZ), spellId));
        }
    }

    // Death flash when this hit killed the defender
    if (dTile && defender && defender.alive === false) {
        out.push(
            withSpellId(
                withFloorZ(
                    {
                        type: 'death',
                        x: dTile.x,
                        y: dTile.y,
                        sx: aTile ? aTile.x : undefined,
                        sy: aTile ? aTile.y : undefined,
                        color: '#f87171',
                        life: 0.45
                    },
                    floorZ
                ),
                spellId
            )
        );
    }

    return out;
}

class CombatEffectsScript extends Script {
    constructor() {
        super();
        /** @type {CombatFxEntry[]} */
        this.entries = [];
        this.maxEntries = 64;
    }

    /**
     * @param {object} opts
     * @param {CombatFxType} opts.type
     * @param {number} [opts.x]
     * @param {number} [opts.y]
     * @param {string|number} [opts.z] floor (omit = draw on any floor)
     * @param {number} [opts.x0]
     * @param {number} [opts.y0]
     * @param {number} [opts.x1]
     * @param {number} [opts.y1]
     * @param {number} [opts.radius]
     * @param {string} [opts.color]
     * @param {string} [opts.spellId] non-auto spell id for AI debug labels
     * @param {string} [opts.spriteId] ammo/projectile catalog sprite id
     * @param {string} [opts.spriteGenre]
     * @param {string} [opts.spriteKind]
     * @param {number} [opts.spriteScale]
     * @param {number} [opts.life] seconds
     */
    push(opts) {
        if (Settings.HEADLESS || !opts || !opts.type) return;
        const type = String(opts.type);
        if (
            type !== 'aoe' &&
            type !== 'death' &&
            type !== 'projectile' &&
            type !== 'melee'
        ) {
            return;
        }
        /** @type {CombatFxEntry} */
        const entry = {
            type: /** @type {CombatFxType} */ (type),
            color: opts.color || ELEMENT_COLORS.physical,
            age: 0,
            life: opts.life != null ? Number(opts.life) : defaultLife(type)
        };
        if (type === 'projectile' || type === 'melee') {
            entry.x0 = Number(opts.x0) || 0;
            entry.y0 = Number(opts.y0) || 0;
            entry.x1 = Number(opts.x1) || 0;
            entry.y1 = Number(opts.y1) || 0;
        } else {
            entry.x = Number(opts.x) || 0;
            entry.y = Number(opts.y) || 0;
            if (type === 'aoe') {
                entry.radius = Math.max(0, Number(opts.radius) || 0);
                if (Array.isArray(opts.tiles) && opts.tiles.length) {
                    entry.tiles = opts.tiles.map((t) => ({
                        x: Number(t.x) || 0,
                        y: Number(t.y) || 0
                    }));
                }
            }
        }
        if (opts.z !== undefined && opts.z !== null) {
            entry.z = opts.z;
        }
        // Optional hit source (attacker tile) for AI debug hitSources overlay
        if (opts.sx != null && Number.isFinite(Number(opts.sx))) {
            entry.sx = Number(opts.sx);
        }
        if (opts.sy != null && Number.isFinite(Number(opts.sy))) {
            entry.sy = Number(opts.sy);
        }
        // Non-auto spell identifier for hitSources label (hit:type:spellId)
        if (opts.spellId != null && String(opts.spellId).length) {
            entry.spellId = String(opts.spellId);
        }
        // Distance ammo / projectile catalog art
        if (opts.spriteId != null && String(opts.spriteId).trim()) {
            entry.spriteId = String(opts.spriteId).trim();
            if (opts.spriteGenre != null && String(opts.spriteGenre).trim()) {
                entry.spriteGenre = String(opts.spriteGenre).trim();
            }
            entry.spriteKind =
                opts.spriteKind != null && String(opts.spriteKind).trim()
                    ? String(opts.spriteKind).trim()
                    : 'equipment';
            if (opts.spriteScale != null && Number.isFinite(Number(opts.spriteScale))) {
                entry.spriteScale = Number(opts.spriteScale);
            }
        }
        this.entries.push(entry);
        while (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
    }

    /**
     * Queue all effects derived from one attack (watch only).
     * @param {object|null} attacker
     * @param {object|null} defender
     * @param {object|null} result
     */
    pushFromAttack(attacker, defender, result) {
        if (Settings.HEADLESS) return;
        const list = effectsFromAttack(attacker, defender, result);
        for (let i = 0; i < list.length; i++) {
            this.push(list[i]);
        }
    }

    clear() {
        this.entries.length = 0;
    }

    update() {
        if (Settings.HEADLESS) {
            this.entries.length = 0;
            return;
        }
        const dt = Time.deltaTime || 0;
        for (let i = this.entries.length - 1; i >= 0; i--) {
            this.entries[i].age += dt;
            if (this.entries[i].age >= this.entries[i].life) {
                this.entries.splice(i, 1);
            }
        }
    }

    onGUI(g) {
        if (Settings.HEADLESS || !g || !this.entries.length) return;
        const sim = this.level || this.parent;
        const tw = Settings.tileWidth || 32;
        const th = Settings.tileHeight || 32;
        const ox = (sim && sim.tileMap && sim.tileMap._viewOriginX) || 0;
        const oy = (sim && sim.tileMap && sim.tileMap._viewOriginY) || 0;
        const viewZ =
            sim && sim.tileMap && sim.tileMap._viewZ != null
                ? String(sim.tileMap._viewZ)
                : Settings.cameraTileZ != null
                  ? String(Settings.cameraTileZ)
                  : null;

        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            if (
                viewZ != null &&
                e.z !== undefined &&
                e.z !== null &&
                String(e.z) !== viewZ
            ) {
                continue;
            }
            const t = e.life > 0 ? Math.min(1, e.age / e.life) : 1;
            if (e.type === 'projectile') {
                drawProjectile(g, e, t, tw, th, ox, oy);
            } else if (e.type === 'melee') {
                drawMelee(g, e, t, tw, th, ox, oy);
            } else if (e.type === 'aoe') {
                drawAoe(g, e, t, tw, th, ox, oy);
            } else if (e.type === 'death') {
                drawDeath(g, e, t, tw, th, ox, oy);
            }
        }
        g.globalAlpha = 1;
    }
}

/**
 * @param {CombatFxType} type
 * @returns {number}
 */
function defaultLife(type) {
    if (type === 'projectile') return 0.2;
    if (type === 'melee') return 0.18;
    if (type === 'death') return 0.45;
    return 0.35;
}

/**
 * @param {CanvasRenderingContext2D} g
 * @param {CombatFxEntry} e
 * @param {number} t 0..1 age fraction
 * @param {number} tw
 * @param {number} th
 * @param {number} ox
 * @param {number} oy
 */
function drawProjectile(g, e, t, tw, th, ox, oy) {
    // Travel quickly then fade: head at min(1, t*1.4)
    const u = Math.min(1, t * 1.4);
    const x0 = (e.x0 - ox) * tw + tw / 2;
    const y0 = (e.y0 - oy) * th + th / 2;
    const x1 = (e.x1 - ox) * tw + tw / 2;
    const y1 = (e.y1 - oy) * th + th / 2;
    const hx = x0 + (x1 - x0) * u;
    const hy = y0 + (y1 - y0) * u;
    const alpha = Math.max(0, 1 - t);
    const dx = x1 - x0;
    const dy = y1 - y0;

    // Ammo / projectile catalog art when ready; else colored streak + head
    if (e.spriteId && typeof g.drawImage === 'function') {
        const img = getReadySpriteImage({
            id: e.spriteId,
            genre: e.spriteGenre || DEFAULT_GENRE,
            kind: e.spriteKind || 'equipment',
            variant: defaultVariantForDisplay()
        });
        if (img) {
            const size = getCachedImageSize(img);
            if (size && size.iw > 0 && size.ih > 0) {
                const scaleFrac =
                    e.spriteScale != null && Number.isFinite(Number(e.spriteScale))
                        ? Number(e.spriteScale)
                        : PROJECTILE_SPRITE_SCALE;
                const target = Math.min(tw, th) * scaleFrac;
                const aspect = size.iw / size.ih;
                // Fit the longer side of the PNG into `target` so diagonal
                // ammo art keeps a similar on-screen length in every direction.
                let dw;
                let dh;
                if (aspect >= 1) {
                    dw = target;
                    dh = target / aspect;
                } else {
                    dh = target;
                    dw = target * aspect;
                }
                const rot = projectileRotation(dx, dy);
                g.save();
                g.globalAlpha = alpha * 0.95;
                g.translate(hx, hy);
                g.rotate(rot);
                g.drawImage(img, -dw / 2, -dh / 2, dw, dh);
                g.restore();
                return;
            }
        }
    }

    g.globalAlpha = alpha * 0.85;
    g.strokeStyle = e.color;
    g.lineWidth = Math.max(1.5, tw * 0.08);
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(hx, hy);
    g.stroke();

    const r = Math.max(2, tw * 0.18);
    g.fillStyle = e.color;
    g.beginPath();
    g.arc(hx, hy, r, 0, Math.PI * 2);
    g.fill();
}

/**
 * Short auto/melee slash: quick travel puff + impact arc (watch-only feedback).
 * @param {CanvasRenderingContext2D} g
 * @param {CombatFxEntry} e
 * @param {number} t 0..1 age fraction
 * @param {number} tw
 * @param {number} th
 * @param {number} ox
 * @param {number} oy
 */
function drawMelee(g, e, t, tw, th, ox, oy) {
    const x0 = (e.x0 - ox) * tw + tw / 2;
    const y0 = (e.y0 - oy) * th + th / 2;
    const x1 = (e.x1 - ox) * tw + tw / 2;
    const y1 = (e.y1 - oy) * th + th / 2;
    // Snap head to impact quickly (adjacent tiles travel almost instantly)
    const u = Math.min(1, t * 2.2);
    const hx = x0 + (x1 - x0) * u;
    const hy = y0 + (y1 - y0) * u;
    const alpha = Math.max(0, 1 - t);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const arm = Math.min(tw, th) * (0.28 + t * 0.12);

    // Brief stroke from attacker toward impact
    g.globalAlpha = alpha * 0.75;
    g.strokeStyle = e.color;
    g.lineWidth = Math.max(1.5, tw * 0.09);
    g.beginPath();
    g.moveTo(x0 + (x1 - x0) * 0.35, y0 + (y1 - y0) * 0.35);
    g.lineTo(hx, hy);
    g.stroke();

    // Slash arc at the head (perpendicular to attack direction)
    g.globalAlpha = alpha * 0.95;
    g.lineWidth = Math.max(1.5, tw * 0.1);
    g.beginPath();
    g.moveTo(hx - nx * arm, hy - ny * arm);
    g.lineTo(hx + nx * arm, hy + ny * arm);
    g.stroke();

    // Small impact flash
    const r = Math.max(2, tw * 0.14 * (1 + t * 0.4));
    g.globalAlpha = alpha * 0.7;
    g.fillStyle = e.color;
    g.beginPath();
    g.arc(hx, hy, r, 0, Math.PI * 2);
    g.fill();
}

/**
 * @param {CanvasRenderingContext2D} g
 * @param {CombatFxEntry} e
 * @param {number} t
 * @param {number} tw
 * @param {number} th
 * @param {number} ox
 * @param {number} oy
 */
function drawAoe(g, e, t, tw, th, ox, oy) {
    const expand = 1 + t * 0.08;
    const alpha = Math.max(0, (1 - t) * 0.45);
    const alphaStroke = Math.max(0, (1 - t) * 0.9);
    g.fillStyle = e.color;
    g.strokeStyle = e.color;
    g.lineWidth = Math.max(1, tw * 0.06);

    // Exact shape footprint (spell.shape → affectedTiles)
    if (Array.isArray(e.tiles) && e.tiles.length) {
        const pad = ((expand - 1) * 0.5) * Math.min(tw, th);
        for (let i = 0; i < e.tiles.length; i++) {
            const tile = e.tiles[i];
            const px = (tile.x - ox) * tw - pad;
            const py = (tile.y - oy) * th - pad;
            const w = tw + pad * 2;
            const h = th + pad * 2;
            g.globalAlpha = alpha;
            g.fillRect(px, py, w, h);
            g.globalAlpha = alphaStroke;
            g.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1);
        }
        return;
    }

    // Fallback: Chebyshev disk as axis-aligned square in tile space
    const rad = e.radius != null ? e.radius : 0;
    const half = (rad + 0.5) * expand;
    const cx = (e.x - ox) * tw + tw / 2;
    const cy = (e.y - oy) * th + th / 2;
    const side = 2 * half * Math.min(tw, th);

    g.globalAlpha = alpha;
    g.fillRect(cx - side / 2, cy - side / 2, side, side);
    g.globalAlpha = alphaStroke;
    g.strokeRect(cx - side / 2, cy - side / 2, side, side);
}

/**
 * @param {CanvasRenderingContext2D} g
 * @param {CombatFxEntry} e
 * @param {number} t
 * @param {number} tw
 * @param {number} th
 * @param {number} ox
 * @param {number} oy
 */
function drawDeath(g, e, t, tw, th, ox, oy) {
    const cx = (e.x - ox) * tw + tw / 2;
    const cy = (e.y - oy) * th + th / 2;
    const r = Math.min(tw, th) * (0.35 + t * 0.55);
    const alpha = Math.max(0, 1 - t);

    g.globalAlpha = alpha * 0.7;
    g.strokeStyle = e.color;
    g.lineWidth = Math.max(1.5, tw * 0.1);
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.stroke();

    // Brief X mark that shrinks as the ring expands
    const arm = Math.min(tw, th) * 0.28 * (1 - t * 0.5);
    g.globalAlpha = alpha;
    g.beginPath();
    g.moveTo(cx - arm, cy - arm);
    g.lineTo(cx + arm, cy + arm);
    g.moveTo(cx + arm, cy - arm);
    g.lineTo(cx - arm, cy + arm);
    g.stroke();
}

module.exports = {
    CombatEffectsScript,
    effectsFromAttack,
    spellIdForDebug,
    elementColor,
    ELEMENT_COLORS,
    AMMO_ART_TIP_ANGLE,
    PROJECTILE_SPRITE_SCALE,
    usesAmmoProjectileSprite,
    resolveAmmoProjectileSprite,
    projectileRotation
};
