/**
 * Entity markers + nameplates / HP (and player mana) bars for watch mode.
 * When catalog sprites are ready (Stage 12D), draw them instead of rectangles.
 * Bars and names sit above the sprite top (legacy ShowName style).
 * Mob rarity auras (rare/champion/elite/boss silhouette) draw under the sprite.
 * Logic never depends on this script; skipped when Settings.HEADLESS.
 */

'use strict';

const { Script } = require('./script.js');
const { Settings } = require('../../settings.js');
const {
    entitySpriteOpts,
    getReadySpriteImage,
    measureEntitySprite,
    drawEntitySprite,
    resolveEntitySpriteScale,
    prefetchSprite,
    defaultVariantForDisplay,
    defaultTileVariantForDisplay,
    idToFileStem
} = require('../lib/creature_sprites.js');
const {
    resolveTileDrawBox,
    sortDrawables,
    DRAW_SUB_ENTITY,
    DRAW_SUB_PROP
} = require('../lib/tile_draw.js');
const {
    getVisualTilePos,
    getCanvasStepExtraDt
} = require('../lib/movement.js');
const {
    stepBobOffsetPx,
    hitFlashStrength,
    getHitRecoilOffset,
    faceSpriteTowardTarget,
    drawEntityShadow,
    drawSpriteHitFlash,
    resolveEntityRarityTier,
    drawEntityRarityAura,
    drawRectRarityAura
} = require('../lib/sprite_presentation.js');
const {
    listGroundTiles,
    parseTileKey,
    getRenderableStack,
    MAX_GROUND_RENDER
} = require('../lib/character/ground_items.js');
const { findItem } = require('../lib/character/stats.js');
const {
    isFieldItem,
    getFieldState
} = require('../lib/combat/elemental_fields.js');
const { Time } = require('../lib/time.js');
const { uiState } = require('../../apps/game/ui_state.js');
const { resolveManaShieldBar } = require('../lib/combat/conditions.js');

/**
 * Stable entity identity helper for matching hovered entity key.
 * @param {object} entity
 * @returns {string}
 */
function entityKey(entity) {
    if (!entity) return 'null';
    if (entity.id != null && entity.id !== 0 && entity.id !== '0') return `id:${entity.id}`;
    if (entity.uid != null && entity.uid !== '') return `uid:${entity.uid}`;
    if (entity.profileId != null && entity.profileId !== '') return `profile:${entity.profileId}`;
    const type = entity.creatureType || entity.classId || entity.vocation || '';
    const name = entity.name || entity.label || '';
    if (type || name) return `fallback:${type}:${name}`;
    return 'unknown';
}

/** Bar thickness in canvas px. */
const BAR_H = 4;
/** Gap between stacked bars. */
const BAR_GAP = 1;
/** Gap between nameplate stack and sprite top. */
const STACK_PAD = 2;
/** Mana-shield nameplate fill (cyan — distinct from HP ramp and mana blue). */
// Legacy nameplate uses Color::darkPink (#800080); brighter violet for Hunt HUD.
const MANA_SHIELD_BAR_FILL = '#a855f7';

/**
 * HP color ramps like legacy ShowName (green → yellow → red).
 * @param {number} frac 0..1
 * @returns {string}
 */
function hpFill(frac) {
    if (frac > 0.7) return '#00ff00';
    if (frac > 0.4) return '#ffff00';
    return '#ff0000';
}

/**
 * Nameplate resource bars, top → bottom (mana shield sits above HP).
 * @param {object|null|undefined} ent
 * @param {boolean} [showMana]
 * @returns {{ kind: string, frac: number, fill: string }[]}
 */
function nameplateBarsForEntity(ent, showMana) {
    if (!ent) return [];
    /** @type {{ kind: string, frac: number, fill: string }[]} */
    const bars = [];
    const shield = resolveManaShieldBar(ent);
    if (shield) {
        bars.push({
            kind: 'mana_shield',
            frac: shield.frac,
            fill: MANA_SHIELD_BAR_FILL
        });
    }
    if (ent.hp && ent.hp.max > 0) {
        const frac = ent.hp.current / ent.hp.max;
        bars.push({ kind: 'hp', frac, fill: hpFill(frac) });
    }
    if (showMana && ent.mp && ent.mp.max > 0) {
        bars.push({
            kind: 'mp',
            frac: ent.mp.current / ent.mp.max,
            fill: '#0000ff'
        });
    }
    return bars;
}

class EntityMarkersScript extends Script {
    /**
     * @param {object} [opts]
     * @param {() => object|null} [opts.getSim] returns Simulator (or use parent as level)
     */
    constructor(opts) {
        super();
        this._getSim = opts && opts.getSim ? opts.getSim : null;
    }

    /**
     * @returns {import('../entities/gameobject.js').GameObject|null}
     */
    _sim() {
        if (this._getSim) return this._getSim();
        return this.level || this.parent;
    }

    /**
     * Hunt genre for sprite resolution (sim.genre or default).
     * @param {object} sim
     * @returns {string|undefined}
     */
    _huntGenre(sim) {
        if (!sim) return undefined;
        return sim.genre || (sim.opts && sim.opts.genre) || undefined;
    }

    render(_g) {
        // Markers drawn in onGUI so they sit above the tilemap fill
    }

    onGUI(g) {
        if (Settings.HEADLESS || !g) return;
        const sim = this._sim();
        if (!sim || !sim.tileMap) return;

        const tw = Settings.tileWidth || 32;
        const th = Settings.tileHeight || 32;
        const ox = sim.tileMap._viewOriginX || 0;
        const oy = sim.tileMap._viewOriginY || 0;
        const viewCols = sim.tileMap._viewCols || 64;
        const viewRows = sim.tileMap._viewRows || 40;
        // Multi-floor: only draw entities on the floor TileMap just painted
        const viewZ =
            sim.tileMap._viewZ != null
                ? String(sim.tileMap._viewZ)
                : Settings.cameraTileZ != null
                  ? String(Settings.cameraTileZ)
                  : null;
        const padC = Math.max(1, Math.floor(tw * 0.25));
        const padP = Math.max(1, Math.floor(tw * 0.15));
        const genre = this._huntGenre(sim);
        const useSprites = Settings.useEntitySprites !== false;

        // 0 while paused/seek so mid-slide sprites do not jitter each paint
        const extraDt = getCanvasStepExtraDt();

        const sameFloor = (tile) => {
            if (viewZ == null || !tile) return true;
            if (tile.z === undefined || tile.z === null) return true;
            return String(tile.z) === viewZ;
        };

        const inView = (pos) => {
            if (!pos || !sameFloor(pos)) return false;
            // Pad by 1 tile so a sliding sprite entering the viewport still draws
            const vx = pos.x - ox;
            const vy = pos.y - oy;
            return (
                vx >= -1 &&
                vy >= -1 &&
                vx < viewCols + 1 &&
                vy < viewRows + 1
            );
        };

        /**
         * Draw a single resource bar (filled fraction + black outline).
         * @param {number} px left
         * @param {number} py top
         * @param {number} bw width
         * @param {number} frac 0..1
         * @param {string} fill
         */
        const drawBarAt = (px, py, bw, frac, fill) => {
            const f = Math.max(0, Math.min(1, frac));
            g.fillStyle = '#1a1a24';
            g.fillRect(px, py, bw, BAR_H);
            g.fillStyle = fill;
            g.fillRect(px, py, Math.max(0, Math.floor(bw * f)), BAR_H);
            g.strokeStyle = '#000000';
            g.lineWidth = 1;
            g.strokeRect(px + 0.5, py + 0.5, bw - 1, BAR_H - 1);
        };

        /**
         * Name + optional mana-shield + HP (+ optional mana) stacked just above `stackTopY`.
         * Shield sits above HP; mana stays the lower bar (closer to the sprite).
         * @param {object} ent
         * @param {number} tilePxX
         * @param {number} stackTopY canvas Y of the top of the sprite (or rect)
         * @param {boolean} showMana
         */
        const drawNameplate = (ent, tilePxX, stackTopY, showMana) => {
            const bars = nameplateBarsForEntity(ent, showMana);
            if (!bars.length && !ent.name) return;

            const barsH =
                bars.length > 0
                    ? bars.length * BAR_H + (bars.length - 1) * BAR_GAP
                    : 0;
            // Name sits above bars; leave a small gap under the name and over the sprite
            const fontPx = Math.max(8, Math.min(11, Math.round(tw * 0.55)));
            const nameGap = 3;
            const cursorY = stackTopY - STACK_PAD - barsH;

            // Center bars + name on the tile (sprites are also horizontal-center on the tile)
            const barW = tw;
            const barX = tilePxX + Math.floor((tw - barW) / 2);
            const centerX = tilePxX + tw / 2;

            let y = cursorY;
            for (let i = 0; i < bars.length; i++) {
                drawBarAt(barX, y, barW, bars[i].frac, bars[i].fill);
                y += BAR_H + BAR_GAP;
            }

            const name = ent.name ? String(ent.name) : '';
            if (name) {
                g.font = `bold ${fontPx}px monospace`;
                g.textAlign = 'center';
                g.textBaseline = 'bottom';
                const nameX = centerX;
                const nameY = cursorY - nameGap;
                // Dark outline for contrast on bright floors / sprites
                g.strokeStyle = '#000000';
                g.lineWidth = 2;
                g.strokeText(name, nameX, nameY);
                g.fillStyle = '#ffffff';
                g.fillText(name, nameX, nameY);
                g.textAlign = 'left';
                g.textBaseline = 'alphabetic';
            }
        };

        // Active view member's combat target → red/black pulsing foot shadow
        const focusMember =
            typeof sim.getCameraFocusMember === 'function'
                ? sim.getCameraFocusMember()
                : null;
        const activeTarget =
            focusMember &&
            focusMember.target &&
            focusMember.target.alive !== false &&
            focusMember.target.tile
                ? focusMember.target
                : null;

        /**
         * @param {object} ent
         * @param {string} rectColor fallback marker color
         * @param {number} pad
         * @param {boolean} showMana draw mana bar (players)
         */
        const drawEntity = (ent, rectColor, pad, showMana) => {
            if (!ent.tile || !ent.alive) return;
            // Phase G2: invisible hostiles are not drawn (players cannot see them).
            // Party members stay visible with reduced alpha for self-feedback.
            const isInvis = !!(
                ent.invisible ||
                (Array.isArray(ent.conditions) &&
                    ent.conditions.some((c) => c && c.kind === 'invisible'))
            );
            const isPlayer =
                ent.type === 'player' || ent.isPlayer === true || showMana;
            if (isInvis && !isPlayer) return;
            // Idle + has target: face them (step facing wins mid-slide)
            faceSpriteTowardTarget(ent);
            // Presentation pos slides toward logic tile over moveDelay (legacy)
            const vis = getVisualTilePos(ent, extraDt) || ent.tile;
            if (!inView(vis) && !inView(ent.tile)) return;
            // Hit recoil (tile units) + walk bob (canvas Y px)
            const recoil = getHitRecoilOffset(ent);
            const bobY = stepBobOffsetPx(ent, extraDt, th);
            const px = (vis.x + recoil.x - ox) * tw;
            const py = (vis.y + recoil.y - oy) * th + bobY;
            const flash = hitFlashStrength(ent);
            const isTarget = !!(activeTarget && (ent === activeTarget || ent.id === activeTarget.id));
            const isHovered = !!(
                uiState &&
                ((uiState.hoveredEntity && ent === uiState.hoveredEntity) ||
                 (uiState.hoveredEntityId != null && ent.id === uiState.hoveredEntityId) ||
                 (uiState.hoveredEntityKey && entityKey(ent) === uiState.hoveredEntityKey))
            );

            const shadowOpts = (isTarget || isHovered)
                ? { combatTargetHighlight: isTarget, hoverHighlight: isHovered }
                : undefined;

            // Mob rarity aura (rare/champion/elite/boss); players / normals → null
            const rarityTier = resolveEntityRarityTier(ent);
            // Player invis feedback: semi-transparent sprite (party can still see self)
            const invisAlpha = isInvis && isPlayer ? 0.4 : 1;

            let layout = null;
            if (useSprites) {
                const img = getReadySpriteImage(
                    entitySpriteOpts(ent, { genre })
                );
                if (img) {
                    // Tile-relative scale: 1× normal, up to 2× for boss affix
                    const scale = resolveEntitySpriteScale(ent);
                    // Catalog sprites face right; flip when facing left
                    const flipH = ent.spriteFacing === -1;
                    // Soft ground shadow under true opaque feet (before sprite)
                    drawEntityShadow(
                        g,
                        px,
                        py - bobY,
                        tw,
                        th,
                        scale,
                        img,
                        flipH,
                        shadowOpts
                    );
                    layout = measureEntitySprite(img, px, py, tw, th, scale);
                    // Silhouette outline under the body (cached per frame+tier)
                    if (layout && rarityTier) {
                        drawEntityRarityAura(
                            g,
                            img,
                            layout,
                            flipH,
                            rarityTier
                        );
                    }
                    if (invisAlpha < 1) {
                        g.save();
                        g.globalAlpha = invisAlpha;
                    }
                    layout = drawEntitySprite(
                        g,
                        img,
                        px,
                        py,
                        tw,
                        th,
                        scale,
                        flipH
                    );
                    if (invisAlpha < 1) {
                        g.restore();
                    }
                    if (layout && flash > 0) {
                        drawSpriteHitFlash(g, layout, flash);
                    }
                }
            }
            if (!layout) {
                drawEntityShadow(
                    g,
                    px,
                    py - bobY,
                    tw,
                    th,
                    1,
                    null,
                    false,
                    shadowOpts
                );
                if (invisAlpha < 1) {
                    g.save();
                    g.globalAlpha = invisAlpha;
                }
                g.fillStyle = rectColor;
                g.fillRect(px + pad, py + pad, tw - pad * 2, th - pad * 2);
                if (invisAlpha < 1) {
                    g.restore();
                }
                if (rarityTier) {
                    drawRectRarityAura(
                        g,
                        px + pad,
                        py + pad,
                        tw - pad * 2,
                        th - pad * 2,
                        rarityTier
                    );
                }
                if (flash > 0) {
                    g.save();
                    g.globalAlpha = Math.min(1, flash) * 0.55;
                    g.fillStyle = '#ffffff';
                    g.fillRect(px + pad, py + pad, tw - pad * 2, th - pad * 2);
                    g.restore();
                }
                if (isHovered) {
                    g.save();
                    g.strokeStyle = '#ffd700';
                    g.lineWidth = 2;
                    g.shadowColor = '#ffd700';
                    g.shadowBlur = 6;
                    g.strokeRect(px + pad - 1, py + pad - 1, (tw - pad * 2) + 2, (th - pad * 2) + 2);
                    g.restore();
                }
                // Rect occupies the visual tile; nameplate above the top
                drawNameplate(ent, px, py, showMana);
            } else {
                if (isHovered) {
                    g.save();
                    g.strokeStyle = '#ffd700';
                    g.lineWidth = 2;
                    g.shadowColor = '#ffd700';
                    g.shadowBlur = 6;
                    g.strokeRect(layout.px - 2, layout.py - 2, layout.scaledW + 4, layout.scaledH + 4);
                    g.restore();
                }
                // Nameplate above the drawn sprite top (not the tile top)
                drawNameplate(ent, px, layout.topY, showMana);
            }
        };

        // Ground items under creatures / players (max MAX_GROUND_RENDER per stack)
        drawGroundItems(g, sim, {
            tw,
            th,
            ox,
            oy,
            viewCols,
            viewRows,
            viewZ,
            genre,
            useSprites
        });

        // Phase 6: y-sort tall TileMap props with entities (terrain already cached)
        /** @type {Array<{ sortY: number, subOrder: number, stableKey: string, draw: () => void }>} */
        const drawList = [];

        const margin = 2;
        const x0 = Math.floor(ox) - margin;
        const y0 = Math.floor(oy) - margin;
        const x1 = Math.ceil(ox + viewCols) + margin;
        const y1 = Math.ceil(oy + viewRows) + margin;
        const tallProps =
            typeof sim.tileMap.collectTallProps === 'function'
                ? sim.tileMap.collectTallProps(viewZ != null ? viewZ : 0, {
                      x0,
                      y0,
                      x1,
                      y1
                  })
                : [];

        for (let i = 0; i < tallProps.length; i++) {
            const p = tallProps[i];
            if (!p) continue;
            // Overhang: allow props just outside view
            if (
                p.tileX < x0 ||
                p.tileY < y0 ||
                p.tileX > x1 ||
                p.tileY > y1
            ) {
                continue;
            }
            drawList.push({
                sortY: p.sortY,
                subOrder: p.subOrder != null ? p.subOrder : DRAW_SUB_PROP,
                stableKey: p.stableKey || `prop:${p.tileX},${p.tileY}`,
                draw: () => {
                    drawTallProp(g, p, {
                        tw,
                        th,
                        ox,
                        oy,
                        genre,
                        useSprites
                    });
                }
            });
        }

        const creatures = sim.creatures || [];
        for (let i = 0; i < creatures.length; i++) {
            const ent = creatures[i];
            if (!ent || !ent.tile || !ent.alive) continue;
            const vis = getVisualTilePos(ent, extraDt) || ent.tile;
            if (!inView(vis) && !inView(ent.tile)) continue;
            const sortY =
                vis && Number.isFinite(Number(vis.y))
                    ? Number(vis.y)
                    : Number(ent.tile.y) || 0;
            drawList.push({
                sortY,
                subOrder: DRAW_SUB_ENTITY,
                stableKey: `creature:${ent.id != null ? ent.id : i}`,
                draw: () => drawEntity(ent, '#e74c3c', padC, false)
            });
        }

        const parties = sim.parties || [];
        for (let p = 0; p < parties.length; p++) {
            const members = parties[p].members || [];
            for (let m = 0; m < members.length; m++) {
                const ent = members[m];
                if (!ent || !ent.tile || !ent.alive) continue;
                const vis = getVisualTilePos(ent, extraDt) || ent.tile;
                if (!inView(vis) && !inView(ent.tile)) continue;
                const sortY =
                    vis && Number.isFinite(Number(vis.y))
                        ? Number(vis.y)
                        : Number(ent.tile.y) || 0;
                const color = ent.isLeader ? '#00f2fe' : '#f0a030';
                drawList.push({
                    sortY,
                    subOrder: DRAW_SUB_ENTITY,
                    stableKey: `player:${ent.id != null ? ent.id : `${p}:${m}`}`,
                    draw: () => drawEntity(ent, color, padP, true)
                });
            }
        }

        sortDrawables(drawList);
        for (let i = 0; i < drawList.length; i++) {
            try {
                drawList[i].draw();
            } catch (_e) {
                // keep painting remaining drawables
            }
        }

        // Stage 11.2 gizmos (barrels / wells) — amber squares, no nameplate
        // (keep after y-sort pass; scenario markers, not TileMap tall props)
        const props = sim.props || [];
        for (let i = 0; i < props.length; i++) {
            const prop = props[i];
            if (!prop || !prop.alive || prop.used || !prop.tile) continue;
            if (!inView(prop.tile)) continue;
            const vx = prop.tile.x - ox;
            const vy = prop.tile.y - oy;
            const px = vx * tw;
            const py = vy * th;
            const pad = Math.max(2, Math.floor(tw * 0.3));
            const isWell =
                prop.effect === 'well' ||
                prop.effect === 'heal' ||
                prop.pacingTag === 'well';
            g.fillStyle = isWell ? '#34d399' : '#fbbf24';
            g.fillRect(px + pad, py + pad, tw - pad * 2, th - pad * 2);
        }
    }
}

/**
 * Draw one TileMap tall prop (scenery / furniture / vertical) with scale+anchor.
 * @param {CanvasRenderingContext2D} g
 * @param {object} prop from collectTallPropsFromFloor
 * @param {{ tw: number, th: number, ox: number, oy: number, genre?: string, useSprites: boolean }} view
 */
function drawTallProp(g, prop, view) {
    if (!g || !prop) return;
    const { tw, th, ox, oy, genre, useSprites } = view;
    const tilePx = (prop.tileX - ox) * tw;
    const tilePy = (prop.tileY - oy) * th;

    if (useSprites && prop.catalogId) {
        const variant =
            typeof defaultTileVariantForDisplay === 'function'
                ? defaultTileVariantForDisplay()
                : 'icon';
        // Prefetch once; getReady returns null until loaded
        if (typeof prefetchSprite === 'function') {
            prefetchSprite({
                genre,
                kind:
                    prop.kind === 'overlays'
                        ? 'overlays'
                        : prop.kind === 'objects'
                          ? 'objects'
                          : 'tiles',
                id: prop.catalogId,
                variant
            });
        }
        const img = getReadySpriteImage({
            genre,
            kind:
                prop.kind === 'overlays'
                    ? 'overlays'
                    : prop.kind === 'objects'
                      ? 'objects'
                      : 'tiles',
            id: prop.catalogId,
            variant
        });
        if (img) {
            const iw =
                img.naturalWidth || img.width || img.videoWidth || tw;
            const ih =
                img.naturalHeight || img.height || img.videoHeight || th;
            const box = resolveTileDrawBox(
                tilePx,
                tilePy,
                tw,
                th,
                iw,
                ih,
                prop.scale,
                prop.anchor
            );
            try {
                g.drawImage(img, box.dx, box.dy, box.dw, box.dh);
                return;
            } catch (_e) {
                // fall through to placeholder
            }
        }
    }

    // Placeholder diamond when sprite missing (watch still shows prop footprint)
    const pad = Math.max(2, Math.floor(tw * 0.2));
    g.fillStyle =
        prop.subLayerId === 'vertical'
            ? '#94a3b8'
            : prop.subLayerId === 'furniture'
              ? '#a16207'
              : '#166534';
    g.fillRect(tilePx + pad, tilePy + pad, tw - pad * 2, th - pad * 2);
}

/**
 * Draw floor item stacks before creatures/players.
 * @param {CanvasRenderingContext2D} g
 * @param {object} sim
 * @param {object} view
 */
function drawGroundItems(g, sim, view) {
    const store = sim.groundItems;
    if (!store) return;
    const keys = listGroundTiles(store);
    if (!keys.length) return;

    const { tw, th, ox, oy, viewCols, viewRows, viewZ, genre, useSprites } =
        view;
    const itemDb = sim._itemDb || (sim.opts && sim.opts.itemDb) || null;
    const variant =
        typeof defaultVariantForDisplay === 'function'
            ? defaultVariantForDisplay()
            : 'icon';
    // Prefer compact icon art on the floor
    const floorVariant = variant === 'original' ? 'small' : 'icon';

    for (let k = 0; k < keys.length; k++) {
        const parsed = parseTileKey(keys[k]);
        if (!parsed) continue;
        if (viewZ != null && String(parsed.z) !== String(viewZ)) continue;
        const vx = parsed.x - ox;
        const vy = parsed.y - oy;
        if (vx < -1 || vy < -1 || vx >= viewCols + 1 || vy >= viewRows + 1) {
            continue;
        }

        const uids = getRenderableStack(
            store,
            parsed.x,
            parsed.y,
            parsed.z,
            MAX_GROUND_RENDER
        );
        if (!uids.length) continue;

        const basePx = vx * tw;
        const basePy = vy * th;
        // Slight SE offset so stacked items are visible
        const step = Math.max(1, Math.floor(tw / 10));

        for (let i = 0; i < uids.length; i++) {
            const uid = uids[i];
            const inst = store.inventory && store.inventory.items[uid];
            if (!inst) continue;
            const item = findItem(itemDb, inst.itemId);
            const artId =
                (item &&
                    ((item.customSprite != null &&
                        String(item.customSprite).trim()) ||
                        (item.spriteId != null && String(item.spriteId).trim()) ||
                        (item.id != null && String(item.id).trim()))) ||
                inst.itemId;
            const artGenre =
                (item &&
                    ((item.customSpriteGenre != null &&
                        String(item.customSpriteGenre).trim()) ||
                        (item.spriteGenre != null &&
                            String(item.spriteGenre).trim()))) ||
                genre;
            const off = i * step;
            const px = basePx + off;
            const py = basePy + off;

            let drawn = false;
            // Elemental fields: simple colored tile overlay (art pipeline deferred).
            // Fire stage dims via getFieldState(now - createdAt) — UI only.
            if (isFieldItem(inst)) {
                const st = getFieldState(inst, Time.timeSinceLevelLoad);
                const kind = st.kind || inst.fieldKind || 'fire';
                let fill = 'rgba(220, 80, 40, 0.55)';
                let stroke = 'rgba(180, 40, 10, 0.7)';
                if (kind === 'poison') {
                    fill = 'rgba(80, 180, 70, 0.5)';
                    stroke = 'rgba(40, 120, 40, 0.7)';
                } else if (kind === 'energy') {
                    fill = 'rgba(90, 140, 255, 0.5)';
                    stroke = 'rgba(40, 80, 200, 0.7)';
                } else if (kind === 'barrier') {
                    // Barrier wall: cool cyan-violet solid with slow blink.
                    fill = 'rgba(120, 160, 255, 0.55)';
                    stroke = 'rgba(80, 120, 220, 0.85)';
                } else if (kind === 'vine') {
                    // Vine barrier: deep green solid with slow blink.
                    fill = 'rgba(40, 140, 60, 0.55)';
                    stroke = 'rgba(20, 90, 40, 0.85)';
                } else if (kind === 'fire' && st.stage === 2) {
                    fill = 'rgba(220, 100, 30, 0.42)';
                } else if (kind === 'fire' && st.stage === 3) {
                    fill = 'rgba(200, 120, 40, 0.28)';
                } else if (kind === 'fire' && st.expired) {
                    fill = 'rgba(120, 80, 60, 0.15)';
                }
                // Obstacles: slow alpha blink (~0.55 Hz) so walls read as active VFX.
                let alphaMul = 1;
                if (kind === 'barrier' || kind === 'vine') {
                    const t =
                        typeof performance !== 'undefined' && performance.now
                            ? performance.now() / 1000
                            : Time.timeSinceLevelLoad;
                    // 0.65–1.0 alpha envelope
                    alphaMul = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(t * Math.PI * 1.1));
                }
                const prevAlpha = g.globalAlpha;
                g.globalAlpha = prevAlpha * alphaMul;
                const inset = Math.max(1, Math.floor(tw * 0.08));
                g.fillStyle = fill;
                g.fillRect(
                    basePx + inset,
                    basePy + inset,
                    tw - inset * 2,
                    th - inset * 2
                );
                // Soft edge ring
                g.strokeStyle = stroke;
                g.lineWidth = Math.max(1, Math.floor(tw / 16));
                g.strokeRect(
                    basePx + inset,
                    basePy + inset,
                    tw - inset * 2,
                    th - inset * 2
                );
                // Obstacle inner cross-hatch hint (reads as solid wall)
                if (kind === 'barrier' || kind === 'vine') {
                    const pad = inset + Math.max(2, Math.floor(tw * 0.12));
                    g.strokeStyle =
                        kind === 'barrier'
                            ? 'rgba(200, 220, 255, 0.45)'
                            : 'rgba(160, 220, 160, 0.4)';
                    g.beginPath();
                    g.moveTo(basePx + pad, basePy + pad);
                    g.lineTo(basePx + tw - pad, basePy + th - pad);
                    g.moveTo(basePx + tw - pad, basePy + pad);
                    g.lineTo(basePx + pad, basePy + th - pad);
                    g.stroke();
                }
                g.globalAlpha = prevAlpha;
                drawn = true;
            }
            if (!drawn && useSprites && artId) {
                const spriteOpts = {
                    genre: artGenre,
                    kind: 'equipment',
                    id: artId,
                    variant: floorVariant
                };
                // Kick lazy load if not ready
                prefetchSprite(spriteOpts);
                const img = getReadySpriteImage(spriteOpts);
                if (img) {
                    // Fit inside ~70% of tile so stacks read clearly
                    const scale = 0.7;
                    drawEntitySprite(g, img, px, py, tw, th, scale, false);
                    drawn = true;
                }
            }
            if (!drawn) {
                const pad = Math.max(2, Math.floor(tw * 0.28));
                g.fillStyle = '#c4b5fd';
                g.fillRect(
                    px + pad,
                    py + pad,
                    tw - pad * 2 - off * 0.2,
                    th - pad * 2 - off * 0.2
                );
                // Tiny label from stem when no art
                if (artId && tw >= 24) {
                    const stem = idToFileStem
                        ? idToFileStem(artId)
                        : String(artId);
                    g.fillStyle = '#1e1b4b';
                    g.font = `bold ${Math.max(7, Math.floor(tw * 0.28))}px monospace`;
                    g.textAlign = 'center';
                    g.textBaseline = 'middle';
                    g.fillText(
                        stem.slice(0, 3),
                        px + tw / 2,
                        py + th / 2,
                        tw - 4
                    );
                    g.textAlign = 'left';
                    g.textBaseline = 'alphabetic';
                }
            }
        }
    }
}

module.exports = {
    EntityMarkersScript,
    nameplateBarsForEntity,
    MANA_SHIELD_BAR_FILL
};
