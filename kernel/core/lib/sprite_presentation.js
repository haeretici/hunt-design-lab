/**
 * Cheap watch-mode sprite presentation helpers (no new art, headless-safe).
 *
 * 1. Walk bob — sine hop during tile step slide
 * 2. Hit flash — brief white overlay on damage
 * 3. Hit recoil — short nudge away from attacker
 * 4. Foot shadow — ellipse under sprite
 * 5. Face target — horizontal flip toward combat target when idle
 * 6. Rarity aura — Albion-style silhouette outline for rare+ mobs
 *    (normal = none; green rare, blue champion, purple elite, gold boss).
 *    Built once per source frame + tier (single-frame sprites), then blitted.
 *
 * Logic combat / pathing never depend on these fields.
 */

'use strict';

const { Settings } = require('../../settings.js');
const { Time } = require('./time.js');
const { stepVisualProgress } = require('./movement.js');

/** Peak bob as a fraction of tile height (upward). */
const BOB_FRAC = 0.12;
/** Hit flash duration (sim seconds). */
const HIT_FLASH_SEC = 0.12;
/** Hit recoil duration (sim seconds). */
const HIT_RECOIL_SEC = 0.1;
/** Recoil distance in tile units (~3 px at 32px tiles). */
const HIT_RECOIL_TILES = 0.1;
/** Max white flash alpha. */
const HIT_FLASH_ALPHA = 0.55;
/** Foot shadow opacity. */
const SHADOW_ALPHA = 0.28;
/** Combat-target highlight shadow opacity (more visible than normal foot shadow). */
const TARGET_SHADOW_ALPHA = 0.62;
/** Combat-target red pulse frequency (Hz, wall clock; full dark↔bright cycle). */
const TARGET_SHADOW_HZ = 2.5 / 3;
/** Dark red end of the combat-target shadow fade (#AA0000). */
const TARGET_SHADOW_R_DARK = 0xaa;
/** Bright red end of the combat-target shadow fade (#FF0000). */
const TARGET_SHADOW_R_BRIGHT = 0xff;
/** Alpha threshold for “opaque enough” when scanning sprite feet (matches aura contour). */
const OPAQUE_ALPHA_MIN = 24;
/**
 * Lower fraction of the *opaque* vertical span used for foot horizontal center.
 * e.g. 0.33 → mean X of opaque pixels in the bottom third of the silhouette.
 */
const FOOT_BAND_FRAC = 0.33;

/**
 * Albion-like rarity tiers → outline color + dilation radius (source px).
 * Normal / untagged mobs have no entry (no aura).
 * @type {Record<string, { color: string, r: number, g: number, b: number, radius: number, alpha: number }>}
 */
const RARITY_AURA = {
    rare: { color: '#3ddc84', r: 61, g: 220, b: 132, radius: 2, alpha: 0.9 },
    champion: { color: '#4da3ff', r: 77, g: 163, b: 255, radius: 2, alpha: 0.92 },
    elite: { color: '#c084fc', r: 192, g: 132, b: 252, radius: 3, alpha: 0.95 },
    boss: { color: '#fbbf24', r: 251, g: 191, b: 36, radius: 3, alpha: 1 }
};

/** Tier rank for resolving highest when multiple affixes present. */
const RARITY_TIER_RANK = { rare: 1, champion: 2, elite: 3, boss: 4 };

/**
 * Outline canvas cache: key = image identity + tier.
 * Single-frame art → one build per unique sprite + rarity for the session.
 * @type {Map<string, { canvas: *, pad: number, iw: number, ih: number, cw: number, ch: number }|null>}
 */
const _auraCache = new Map();

/**
 * Opaque foot metrics cache: key = image identity.
 * Single-frame art → one scan per unique sprite for the session.
 * @type {Map<string, { iw: number, ih: number, top: number, bottom: number, footCx: number }|null>}
 */
const _footCache = new Map();

/** @type {WeakMap<object, string>} */
const _imgIds = new WeakMap();
let _imgIdSeq = 0;

/**
 * Vertical bob in canvas pixels during a step slide (0 at ends, peak mid).
 * Negative = up. Zero when idle / not sliding.
 *
 * @param {object|null|undefined} entity
 * @param {number} [extraDt=0] canvas sub-frame seconds
 * @param {number} [tileHeight=32]
 * @returns {number}
 */
function stepBobOffsetPx(entity, extraDt, tileHeight) {
    if (!entity) return 0;
    const dur = Number(entity._moveVisDuration) || 0;
    if (dur <= 0) return 0;
    const t = stepVisualProgress(entity, extraDt);
    if (t <= 0 || t >= 1) return 0;
    const th = Number(tileHeight) > 0 ? Number(tileHeight) : 32;
    // Half-sine arch: 0 → peak → 0 over the step
    return -Math.sin(Math.PI * t) * th * BOB_FRAC;
}

/**
 * Start hit flash + recoil on defender (watch mode only).
 * No-op for miss / zero damage / healing (caller filters).
 *
 * @param {object|null|undefined} defender
 * @param {object|null|undefined} attacker
 * @param {number} [now] sim time override (tests)
 */
function beginHitFeedback(defender, attacker, now) {
    if (!defender || Settings.HEADLESS) return;
    const t =
        now != null && Number.isFinite(Number(now))
            ? Number(now)
            : Time.timeSinceLevelLoad;

    defender._hitFlashUntil = t + HIT_FLASH_SEC;

    let rdx = 0;
    let rdy = 0;
    const dTile = defender.tile;
    const aTile = attacker && attacker.tile ? attacker.tile : null;
    if (dTile && aTile) {
        rdx = Number(dTile.x) - Number(aTile.x);
        rdy = Number(dTile.y) - Number(aTile.y);
    }
    const len = Math.hypot(rdx, rdy);
    if (len > 1e-6) {
        rdx = (rdx / len) * HIT_RECOIL_TILES;
        rdy = (rdy / len) * HIT_RECOIL_TILES;
    } else {
        // Same tile / unknown attacker: nudge along current facing
        const face = defender.spriteFacing === -1 ? -1 : 1;
        rdx = face * HIT_RECOIL_TILES;
        rdy = 0;
    }
    defender._hitRecoilDx = rdx;
    defender._hitRecoilDy = rdy;
    defender._hitRecoilUntil = t + HIT_RECOIL_SEC;
    defender._hitRecoilT0 = t;
}

/**
 * Remaining hit-flash strength 0..1 (0 = none).
 *
 * @param {object|null|undefined} entity
 * @param {number} [now]
 * @returns {number}
 */
function hitFlashStrength(entity, now) {
    if (!entity) return 0;
    const until = Number(entity._hitFlashUntil) || 0;
    if (until <= 0) return 0;
    const t =
        now != null && Number.isFinite(Number(now))
            ? Number(now)
            : Time.timeSinceLevelLoad;
    if (t >= until) return 0;
    const left = until - t;
    return Math.max(0, Math.min(1, left / HIT_FLASH_SEC));
}

/**
 * Decay recoil offset in tile units (away from attacker at start of hit).
 *
 * @param {object|null|undefined} entity
 * @param {number} [now]
 * @returns {{ x: number, y: number }}
 */
function getHitRecoilOffset(entity, now) {
    if (!entity) return { x: 0, y: 0 };
    const until = Number(entity._hitRecoilUntil) || 0;
    if (until <= 0) return { x: 0, y: 0 };
    const t =
        now != null && Number.isFinite(Number(now))
            ? Number(now)
            : Time.timeSinceLevelLoad;
    if (t >= until) return { x: 0, y: 0 };
    const t0 =
        entity._hitRecoilT0 != null
            ? Number(entity._hitRecoilT0)
            : until - HIT_RECOIL_SEC;
    const span = Math.max(1e-6, until - t0);
    // 1 at impact → 0 when expired
    const u = Math.max(0, Math.min(1, (until - t) / span));
    return {
        x: (Number(entity._hitRecoilDx) || 0) * u,
        y: (Number(entity._hitRecoilDy) || 0) * u
    };
}

/**
 * When standing still with a living target, face them horizontally.
 * Mid-step facing from movement wins until the slide ends.
 *
 * @param {object|null|undefined} entity
 */
function faceSpriteTowardTarget(entity) {
    if (!entity || !entity.tile) return;
    if ((Number(entity._moveVisDuration) || 0) > 0) return;
    const target = entity.target;
    if (!target || !target.tile) return;
    if (target.alive === false) return;
    const dx = Math.round(target.tile.x) - Math.round(entity.tile.x);
    if (dx < 0) {
        entity.spriteFacing = -1;
    } else if (dx > 0) {
        entity.spriteFacing = 1;
    }
}

/**
 * Scan source alpha for true feet inside the frame.
 * Transparent bottom padding is common in sprite thumbs — without this the
 * shadow sits on the image box while the body floats above it.
 *
 * footCx = mean X of opaque pixels in the bottom FOOT_BAND_FRAC of the
 * *opaque* vertical span (not the full image height), so head/weapon mass
 * above does not pull the shadow sideways.
 *
 * @param {object} img
 * @returns {{
 *   iw: number,
 *   ih: number,
 *   top: number,
 *   bottom: number,
 *   footCx: number
 * }|null}
 *   top/bottom = first/last opaque rows (0-based); footCx in source px
 */
function buildSpriteOpaqueFoot(img) {
    const size = _imageNaturalSize(img);
    if (!size) return null;
    const { iw, ih } = size;
    if (iw * ih > 512 * 512) return null;

    const alloc = _allocAuraCanvas(iw, ih);
    if (!alloc) return null;
    const { ctx } = alloc;

    try {
        ctx.clearRect(0, 0, iw, ih);
        ctx.drawImage(img, 0, 0, iw, ih);
        const imageData = ctx.getImageData(0, 0, iw, ih);
        const src = imageData.data;

        let top = -1;
        let bottom = -1;
        for (let y = 0; y < ih; y++) {
            const row = y * iw * 4;
            for (let x = 0; x < iw; x++) {
                if (src[row + x * 4 + 3] > OPAQUE_ALPHA_MIN) {
                    if (top < 0) top = y;
                    bottom = y;
                    break;
                }
            }
        }
        if (bottom < 0 || top < 0) return null;

        // Bottom third (by default) of the opaque silhouette height
        const opaqueH = bottom - top + 1;
        const bandH = Math.max(
            1,
            Math.round(opaqueH * FOOT_BAND_FRAC)
        );
        const y0 = bottom - bandH + 1;
        let sumX = 0;
        let count = 0;
        for (let y = y0; y <= bottom; y++) {
            const row = y * iw * 4;
            for (let x = 0; x < iw; x++) {
                if (src[row + x * 4 + 3] > OPAQUE_ALPHA_MIN) {
                    sumX += x;
                    count += 1;
                }
            }
        }
        const footCx = count > 0 ? sumX / count : iw / 2;
        return { iw, ih, top, bottom, footCx };
    } catch (_e) {
        // getImageData / tainted canvas / missing API
        return null;
    }
}

/**
 * Cached opaque-foot metrics for an image. Null if unavailable.
 *
 * @param {object|null|undefined} img
 * @returns {{
 *   iw: number,
 *   ih: number,
 *   top: number,
 *   bottom: number,
 *   footCx: number
 * }|null}
 */
function getSpriteOpaqueFoot(img) {
    if (!img) return null;
    const key = _imageCacheId(img);
    if (_footCache.has(key)) return _footCache.get(key) || null;
    const built = buildSpriteOpaqueFoot(img);
    _footCache.set(key, built);
    return built;
}

/**
 * Soft ellipse under feet (presentation only).
 * When `img` is provided, Y/X use the lowest opaque pixels (same alpha idea as
 * rarity aura) so transparent frame padding does not leave the shadow on the
 * floor while the body floats.
 *
 * Optional `opts.combatTargetHighlight`: fade dark red (#AA0000) ↔ bright red
 * (#FF0000) so the active view member's combat target is obvious (watch only).
 *
 * @param {CanvasRenderingContext2D} g
 * @param {number} tilePxX
 * @param {number} tilePxY
 * @param {number} tw
 * @param {number} th
 * @param {number} [scale=1] sprite height mult (widens shadow slightly)
 * @param {object|null|undefined} [img] source sprite for opaque-foot scan
 * @param {boolean} [flipH=false] horizontal mirror (match sprite facing)
 * @param {{ combatTargetHighlight?: boolean, now?: number }} [opts]
 */
function drawEntityShadow(g, tilePxX, tilePxY, tw, th, scale, img, flipH, opts) {
    if (!g) return;
    const sRaw = scale != null ? Number(scale) : 1;
    // Full scale for layout (matches measureEntitySprite); soft-cap only radii
    const sLayout = Number.isFinite(sRaw) && sRaw > 0 ? sRaw : 1;
    const sRad = Math.min(1.6, sLayout);
    let cx = tilePxX + tw / 2;
    // Default: sit just above the tile bottom edge (image-box feet)
    let cy = tilePxY + th - th * 0.1;

    const foot = img ? getSpriteOpaqueFoot(img) : null;
    if (foot && foot.ih > 0 && foot.iw > 0) {
        // Same layout as measureEntitySprite: height = th*scale, feet on tile bottom
        const scaledH = th * sLayout;
        const scaledW = foot.iw * (scaledH / foot.ih);
        const px = tilePxX + tw / 2 - scaledW / 2;
        const py = tilePxY + th - scaledH;
        // Bottom of last opaque row → canvas Y under true feet
        const contentBottomY =
            py + ((foot.bottom + 1) / foot.ih) * scaledH;
        cy = contentBottomY - th * 0.04;
        // Foot mass X; flip when the body is mirrored
        let localCx = foot.footCx;
        if (flipH) localCx = foot.iw - 1 - localCx;
        cx = px + ((localCx + 0.5) / foot.iw) * scaledW;
    }

    const highlight = !!(opts && opts.combatTargetHighlight);
    const hover = !!(opts && opts.hoverHighlight);
    // Slightly larger ellipse when highlighting so the pulse reads at a glance
    const radMul = (highlight || hover) ? 1.25 : 1;
    const rx = tw * 0.28 * sRad * radMul;
    const ry = th * 0.11 * Math.min(1.3, sRad) * radMul;

    let fill = '#000000';
    let alpha = SHADOW_ALPHA;
    let blur = 0;
    if (hover && !highlight) {
        let t = opts && opts.now != null ? Number(opts.now) : NaN;
        if (!Number.isFinite(t)) {
            t =
                typeof performance !== 'undefined' &&
                typeof performance.now === 'function'
                    ? performance.now() / 1000
                    : Time.timeSinceLevelLoad || 0;
        }
        const u = 0.5 + 0.5 * Math.cos(t * TARGET_SHADOW_HZ * Math.PI * 2);
        const r = Math.round(0xdd + (0xff - 0xdd) * u);
        const gVal = Math.round(0xaa + (0xd7 - 0xaa) * u);
        const hexR = r.toString(16).padStart(2, '0');
        const hexG = gVal.toString(16).padStart(2, '0');
        fill = `#${hexR}${hexG}00`;
        alpha = 0.8;
        blur = Math.max(5, Math.round(tw * (0.16 + 0.1 * u)));
    } else if (highlight) {
        // Wall clock so the pulse keeps fading while the sim is paused
        let t = opts && opts.now != null ? Number(opts.now) : NaN;
        if (!Number.isFinite(t)) {
            t =
                typeof performance !== 'undefined' &&
                typeof performance.now === 'function'
                    ? performance.now() / 1000
                    : Time.timeSinceLevelLoad || 0;
        }
        // Smooth cosine fade: t=0 → bright #FF0000, half period → dark #AA0000
        const u =
            0.5 +
            0.5 * Math.cos(t * TARGET_SHADOW_HZ * Math.PI * 2);
        const r = Math.round(
            TARGET_SHADOW_R_DARK +
                (TARGET_SHADOW_R_BRIGHT - TARGET_SHADOW_R_DARK) * u
        );
        const hex = r.toString(16).padStart(2, '0');
        fill = `#${hex}0000`;
        alpha = TARGET_SHADOW_ALPHA;
        // Soft glow always on; stronger near the bright end of the pulse
        blur = Math.max(4, Math.round(tw * (0.14 + 0.12 * u)));
    }

    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = fill;
    if (blur > 0 && typeof g.shadowBlur === 'number') {
        g.shadowColor = fill;
        g.shadowBlur = blur;
        g.shadowOffsetX = 0;
        g.shadowOffsetY = 0;
    }
    if (typeof g.ellipse === 'function') {
        g.beginPath();
        g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        g.fill();
    } else {
        // Fallback for mock/test contexts without ellipse
        g.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
    }
    g.restore();
}

/**
 * White flash overlay on a drawn sprite layout (call after drawEntitySprite).
 * Re-applies optional horizontal flip so the rect matches the sprite box.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {{ px: number, py: number, scaledW: number, scaledH: number }} layout
 * @param {number} strength 0..1
 */
function drawSpriteHitFlash(g, layout, strength) {
    if (!g || !layout) return;
    const a = Number(strength);
    if (!(a > 0)) return;
    const dx = Math.floor(layout.px);
    const dy = Math.floor(layout.py);
    const dw = layout.scaledW;
    const dh = layout.scaledH;
    g.save();
    g.globalAlpha = Math.min(1, a) * HIT_FLASH_ALPHA;
    g.fillStyle = '#ffffff';
    g.fillRect(dx, dy, dw, dh);
    g.restore();
}

/**
 * Stable cache key fragment for a drawable image.
 * @param {object} img
 * @returns {string}
 */
function _imageCacheId(img) {
    if (!img || typeof img !== 'object') return 'null';
    let id = _imgIds.get(img);
    if (id) return id;
    if (img.src) id = String(img.src);
    else if (img._src) id = String(img._src);
    else {
        _imgIdSeq += 1;
        id = 'img#' + _imgIdSeq;
    }
    _imgIds.set(img, id);
    return id;
}

/**
 * Alloc a 2d canvas for outline baking (browser / OffscreenCanvas).
 * @param {number} w
 * @param {number} h
 * @returns {{ canvas: *, ctx: CanvasRenderingContext2D }|null}
 */
function _allocAuraCanvas(w, h) {
    const ww = Math.max(1, w | 0);
    const hh = Math.max(1, h | 0);
    if (typeof OffscreenCanvas !== 'undefined') {
        try {
            const canvas = new OffscreenCanvas(ww, hh);
            const ctx = canvas.getContext('2d');
            if (ctx) return { canvas, ctx };
        } catch (_e) {
            /* fall through */
        }
    }
    if (typeof document !== 'undefined' && document.createElement) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = ww;
            canvas.height = hh;
            const ctx = canvas.getContext('2d');
            if (ctx) return { canvas, ctx };
        } catch (_e) {
            /* fall through */
        }
    }
    return null;
}

/**
 * Natural pixel size of a drawable (HTMLImage / canvas / ImageBitmap).
 * @param {object} img
 * @returns {{ iw: number, ih: number }|null}
 */
function _imageNaturalSize(img) {
    if (!img) return null;
    const iw =
        img.naturalWidth != null
            ? Number(img.naturalWidth)
            : img.width != null
              ? Number(img.width)
              : img._spriteIw != null
                ? Number(img._spriteIw)
                : 0;
    const ih =
        img.naturalHeight != null
            ? Number(img.naturalHeight)
            : img.height != null
              ? Number(img.height)
              : img._spriteIh != null
                ? Number(img._spriteIh)
                : 0;
    if (!(iw > 0) || !(ih > 0)) return null;
    return { iw: iw | 0, ih: ih | 0 };
}

/**
 * Highest rarity tier on a mob for aura color, or null (normal / player).
 * Rank: boss > elite > champion > rare. Players never get a mob aura.
 *
 * @param {object|null|undefined} entity
 * @returns {'rare'|'champion'|'elite'|'boss'|null}
 */
function resolveEntityRarityTier(entity) {
    if (!entity) return null;
    if (entity.type === 'player' || entity.isPlayer) return null;

    /** @type {string|null} */
    let best = null;
    let bestRank = 0;
    const consider = (raw) => {
        if (raw == null || raw === '') return;
        const k = String(raw).toLowerCase();
        const rank = RARITY_TIER_RANK[k];
        if (rank == null) return;
        if (rank > bestRank) {
            bestRank = rank;
            best = k;
        }
    };

    if (entity.rarity != null) consider(entity.rarity);
    if (Array.isArray(entity.affixes)) {
        for (let i = 0; i < entity.affixes.length; i++) {
            consider(entity.affixes[i]);
        }
    }
    if (entity.isBoss || entity.boss) consider('boss');
    if (entity.isElite || entity.elite) consider('elite');
    if (entity.isChampion || entity.champion) consider('champion');
    if (entity.isRare || entity.rare) consider('rare');

    return best;
}

/**
 * Bake a colored silhouette *ring* outside opaque pixels (once per frame+tier).
 * Ring only — interior stays transparent so the real sprite sits on top cleanly.
 *
 * @param {object} img
 * @param {string} tier
 * @returns {{ canvas: *, pad: number, iw: number, ih: number, cw: number, ch: number }|null}
 */
function buildRarityAuraSprite(img, tier) {
    const cfg = RARITY_AURA[tier];
    if (!cfg || !img) return null;
    const size = _imageNaturalSize(img);
    if (!size) return null;
    const { iw, ih } = size;
    const radius = Math.max(1, Math.min(6, cfg.radius | 0));
    const pad = radius + 1;
    const cw = iw + pad * 2;
    const ch = ih + pad * 2;
    // Cap extreme sheets (safety); normal small/medium sprites are fine
    if (cw * ch > 512 * 512) return null;

    const alloc = _allocAuraCanvas(cw, ch);
    if (!alloc) return null;
    const { canvas, ctx } = alloc;

    try {
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(img, pad, pad, iw, ih);
        const imageData = ctx.getImageData(0, 0, cw, ch);
        const src = imageData.data;
        const n = cw * ch;
        const opaque = new Uint8Array(n);
        // Alpha threshold: treat soft edges as solid for a clean contour
        for (let i = 0, p = 3; i < n; i++, p += 4) {
            opaque[i] = src[p] > 24 ? 1 : 0;
        }

        const dil = new Uint8Array(n);
        const r2 = radius * radius;
        for (let y = 0; y < ch; y++) {
            for (let x = 0; x < cw; x++) {
                const idx = y * cw + x;
                if (!opaque[idx]) continue;
                for (let dy = -radius; dy <= radius; dy++) {
                    const ny = y + dy;
                    if (ny < 0 || ny >= ch) continue;
                    const dy2 = dy * dy;
                    for (let dx = -radius; dx <= radius; dx++) {
                        if (dx * dx + dy2 > r2) continue;
                        const nx = x + dx;
                        if (nx < 0 || nx >= cw) continue;
                        dil[ny * cw + nx] = 1;
                    }
                }
            }
        }

        // Outer ring only + soft inner edge for a slight glow falloff
        const out = ctx.createImageData(cw, ch);
        const od = out.data;
        const cr = cfg.r;
        const cg = cfg.g;
        const cb = cfg.b;
        for (let i = 0, p = 0; i < n; i++, p += 4) {
            if (!dil[i] || opaque[i]) continue;
            // Distance-ish alpha: pixels just outside body are stronger
            // (cheap: full alpha on ring; browser softens via draw scale)
            od[p] = cr;
            od[p + 1] = cg;
            od[p + 2] = cb;
            od[p + 3] = 230;
        }
        ctx.putImageData(out, 0, 0);
    } catch (_e) {
        // getImageData / tainted canvas / missing API — skip aura
        return null;
    }

    return { canvas, pad, iw, ih, cw, ch };
}

/**
 * Cached outline sprite for (image, tier). Null if unavailable.
 *
 * @param {object} img
 * @param {string} tier
 * @returns {{ canvas: *, pad: number, iw: number, ih: number, cw: number, ch: number }|null}
 */
function getRarityAuraSprite(img, tier) {
    if (!img || !RARITY_AURA[tier]) return null;
    const key = _imageCacheId(img) + '|' + tier;
    if (_auraCache.has(key)) return _auraCache.get(key) || null;
    const built = buildRarityAuraSprite(img, tier);
    _auraCache.set(key, built);
    return built;
}

/**
 * Draw rarity silhouette outline under the sprite (same layout + flip as body).
 * Cheap after first bake: one extra drawImage of a small cached ring.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {object} img source sprite (for cache key / bake)
 * @param {{ px: number, py: number, scaledW: number, scaledH: number, iw?: number, ih?: number }} layout
 * @param {boolean} [flipH=false]
 * @param {string|null|undefined} tier
 * @param {number} [now] sim time for subtle pulse (optional)
 */
function drawEntityRarityAura(g, img, layout, flipH, tier, now) {
    if (!g || !img || !layout || !tier) return;
    const cfg = RARITY_AURA[tier];
    if (!cfg) return;

    const baked = getRarityAuraSprite(img, tier);
    const dx0 = Math.floor(layout.px);
    const dy0 = Math.floor(layout.py);
    const dw = layout.scaledW;
    const dh = layout.scaledH;
    if (!(dw > 0) || !(dh > 0)) return;

    // Subtle pulse (Albion-ish); cheap sin on draw alpha
    const t =
        now != null && Number.isFinite(Number(now))
            ? Number(now)
            : Time.timeSinceLevelLoad;
    const pulse = 0.82 + 0.18 * (0.5 + 0.5 * Math.sin(t * 3.2));
    const alpha = Math.min(1, cfg.alpha * pulse);

    g.save();
    if (flipH) {
        const cx = dx0 + dw / 2;
        g.translate(cx, 0);
        g.scale(-1, 1);
        g.translate(-cx, 0);
    }
    g.globalAlpha = alpha;

    if (baked && baked.canvas) {
        const sx = dw / baked.iw;
        const sy = dh / baked.ih;
        const adx = Math.floor(layout.px - baked.pad * sx);
        const ady = Math.floor(layout.py - baked.pad * sy);
        const adw = Math.max(1, Math.round(baked.cw * sx));
        const adh = Math.max(1, Math.round(baked.ch * sy));
        // Soft outer halo via shadow on the thin ring (cheap GPU)
        g.shadowColor = cfg.color;
        g.shadowBlur = Math.max(2, Math.round(4 * (layout.scale || 1)));
        g.shadowOffsetX = 0;
        g.shadowOffsetY = 0;
        g.drawImage(baked.canvas, adx, ady, adw, adh);
    } else {
        // Fallback when canvas bake is unavailable: alpha-mask glow via shadowBlur
        g.shadowColor = cfg.color;
        g.shadowBlur = Math.max(4, Math.round(8 * (layout.scale || 1)));
        g.shadowOffsetX = 0;
        g.shadowOffsetY = 0;
        g.drawImage(img, dx0, dy0, dw, dh);
    }
    g.restore();
}

/**
 * Colored stroke around a rect marker when sprites are missing.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {string|null|undefined} tier
 */
function drawRectRarityAura(g, x, y, w, h, tier) {
    if (!g || !tier) return;
    const cfg = RARITY_AURA[tier];
    if (!cfg) return;
    g.save();
    g.strokeStyle = cfg.color;
    g.lineWidth = tier === 'boss' || tier === 'elite' ? 2.5 : 2;
    g.globalAlpha = cfg.alpha;
    g.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    g.restore();
}

/** Test / session helper: drop baked outlines. */
function clearRarityAuraCache() {
    _auraCache.clear();
}

/** Test / session helper: drop opaque-foot metrics. */
function clearSpriteOpaqueFootCache() {
    _footCache.clear();
}

module.exports = {
    BOB_FRAC,
    HIT_FLASH_SEC,
    HIT_RECOIL_SEC,
    HIT_RECOIL_TILES,
    HIT_FLASH_ALPHA,
    SHADOW_ALPHA,
    OPAQUE_ALPHA_MIN,
    FOOT_BAND_FRAC,
    RARITY_AURA,
    RARITY_TIER_RANK,
    stepBobOffsetPx,
    beginHitFeedback,
    hitFlashStrength,
    getHitRecoilOffset,
    faceSpriteTowardTarget,
    buildSpriteOpaqueFoot,
    getSpriteOpaqueFoot,
    drawEntityShadow,
    drawSpriteHitFlash,
    resolveEntityRarityTier,
    buildRarityAuraSprite,
    getRarityAuraSprite,
    drawEntityRarityAura,
    drawRectRarityAura,
    clearRarityAuraCache,
    clearSpriteOpaqueFootCache
};
