/**
 * Catalog sprite path resolution + lazy ImageDB load for watch mode (Stage 12D).
 *
 * Pure path helpers are safe in Node tests. Image load only happens in browser
 * when Image exists and Settings.HEADLESS is false.
 *
 * Layout: assets/sprites/<genre>/<kind>/<variant>/<Stem>.png
 * Variants: icon (32), small (64), medium (~half), alpha, retro, original
 */

'use strict';

const { DEFAULT_GENRE, GENRES, Settings } = require('../../settings.js');
const { appUrl } = require('./app_paths.js');
const { ImageDB, isDrawableReady } = require('./imagedb.js');

/** Processed + source variant folder names under a kind root. */
const SPRITE_VARIANTS = Object.freeze([
    'icon',
    'small',
    'medium',
    'alpha',
    'retro',
    'original'
]);

/** Default draw variant when Settings.entitySpriteVariant is unset. */
const DEFAULT_VARIANT = 'small';

/**
 * Technical phrase → PNG stem (`Ashen Dwarf Priest` → `Ashen_Dwarf_Priest`).
 * Mirrors creature_manifest.technicalToFileStem (kept local to avoid fs pull).
 * @param {string} technical
 * @returns {string}
 */
function technicalToFileStem(technical) {
    return String(technical || '')
        .trim()
        .replace(/['']/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Catalog id / slug → Title_Case stem (`ashen_dwarf_priest` → `Ashen_Dwarf_Priest`).
 * @param {string} id
 * @returns {string}
 */
function idToFileStem(id) {
    return String(id || '')
        .trim()
        .replace(/\.png$/i, '')
        .split(/[_\s-]+/)
        .filter(Boolean)
        .map((part) => {
            if (!part) return part;
            return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
        })
        .join('_');
}

/**
 * @param {string} [genreId]
 * @returns {string} folder under assets/sprites/
 */
function genreFolder(genreId) {
    const id = genreId || DEFAULT_GENRE;
    const g = GENRES[id];
    return (g && g.folder) || id;
}

/**
 * @param {string} [variant]
 * @returns {string}
 */
function normalizeVariant(variant) {
    const v = String(variant || DEFAULT_VARIANT).toLowerCase();
    if (SPRITE_VARIANTS.indexOf(v) >= 0) return v;
    // Legacy alias
    if (v === 'transformed') return 'retro';
    return DEFAULT_VARIANT;
}

/**
 * Strip leading slashes; normalize to repo-relative path.
 * @param {string} p
 * @returns {string}
 */
function cleanRelPath(p) {
    return String(p || '').replace(/^\/+/, '');
}

/**
 * Rewrite …/original/Stem.png → …/<variant>/Stem.png (same stem).
 * Also rewrites any known variant segment.
 * @param {string} originalRel
 * @param {string} variant
 * @returns {string|null}
 */
function rewriteVariantPath(originalRel, variant) {
    const rel = cleanRelPath(originalRel);
    if (!rel) return null;
    const v = normalizeVariant(variant);
    const re = /\/(original|alpha|medium|retro|small|icon|transformed)\//i;
    if (re.test(rel)) {
        return rel.replace(re, `/${v}/`);
    }
    // Path without variant folder — append is unsafe; refuse
    return null;
}

/**
 * Merge catalog `sprites` (plural) with ported `sprite` (singular, e.g. legacy GIF).
 * Catalog keys win on collision so original/small/… stay preferred over legacy.
 * @param {object|null|undefined} sprites
 * @param {object|null|undefined} sprite
 * @returns {object|null}
 */
function mergeSpriteBags(sprites, sprite) {
    const hasSprites = sprites && typeof sprites === 'object';
    const hasSprite = sprite && typeof sprite === 'object';
    if (!hasSprites && !hasSprite) return null;
    if (!hasSprite) return sprites;
    if (!hasSprites) return sprite;
    return Object.assign({}, sprite, sprites);
}

/**
 * Resolve file stem from explicit stem, technical, sprites bag, or id.
 * @param {{
 *   stem?: string|null,
 *   technical?: string|null,
 *   id?: string|null,
 *   slug?: string|null,
 *   sprites?: object|null,
 *   sprite?: object|null
 * }} opts
 * @returns {string|null}
 */
function resolveFileStem(opts) {
    const o = opts || {};
    if (o.stem) {
        const s = String(o.stem).replace(/\.png$/i, '').trim();
        if (s) return s;
    }
    if (o.technical) {
        const s = technicalToFileStem(o.technical);
        if (s) return s;
    }
    const sprites = mergeSpriteBags(o.sprites, o.sprite);
    if (sprites && sprites.original) {
        const base = String(sprites.original).split(/[/\\]/).pop() || '';
        const s = base.replace(/\.png$/i, '');
        if (s) return s;
    }
    const id = o.id || o.slug;
    if (id) {
        const s = idToFileStem(id);
        if (s) return s;
    }
    return null;
}

/**
 * Repo-relative sprite path (no leading slash), or null if unresolvable.
 *
 * Catalog variants under assets/sprites/… take priority. Ported templates may
 * still expose `sprite.legacy` / `sprites.legacy` as a last-resort path.
 *
 * @param {{
 *   genre?: string,
 *   kind?: string,
 *   variant?: string,
 *   stem?: string|null,
 *   technical?: string|null,
 *   id?: string|null,
 *   slug?: string|null,
 *   sprites?: object|null,
 *   sprite?: object|null
 * }} opts
 * @returns {string|null}
 */
function resolveSpriteRelPath(opts) {
    const o = opts || {};
    const variant = normalizeVariant(o.variant);
    const kind = o.kind || 'creatures';
    const sprites = mergeSpriteBags(o.sprites, o.sprite);

    if (sprites && typeof sprites === 'object') {
        if (sprites[variant]) {
            return cleanRelPath(sprites[variant]);
        }
        if (sprites.original) {
            const rewritten = rewriteVariantPath(sprites.original, variant);
            if (rewritten) return rewritten;
        }
        // Legacy GIFs (no variant folders)
        if (sprites.legacy) {
            return cleanRelPath(sprites.legacy);
        }
    }

    const stem = resolveFileStem(o);
    if (!stem) return null;

    const folder = genreFolder(o.genre);
    return `assets/sprites/${folder}/${kind}/${variant}/${stem}.png`;
}

/**
 * Browser/fetch URL for a sprite (uses appUrl).
 * @param {Parameters<typeof resolveSpriteRelPath>[0]} opts
 * @returns {string|null}
 */
function resolveSpriteUrl(opts) {
    const rel = resolveSpriteRelPath(opts);
    if (!rel) return null;
    return appUrl(rel);
}

/**
 * Pick draw variant from Settings or tile size.
 * Browser default is 32×32 tiles → **small** (64×64 source thumbs).
 * @returns {string}
 */
function defaultVariantForDisplay() {
    if (Settings.entitySpriteVariant) {
        return normalizeVariant(Settings.entitySpriteVariant);
    }
    const tw = Settings.tileWidth || 32;
    if (tw <= 16) return 'icon';
    if (tw <= 32) return 'small';
    return 'medium';
}

/**
 * Pick draw variant from Settings or tile size for tiles.
 * Browser default is 32×32 tiles → **icon** (32×32 source thumbs).
 * @returns {string}
 */
function defaultTileVariantForDisplay() {
    if (Settings.tileSpriteVariant) {
        return normalizeVariant(Settings.tileSpriteVariant);
    }
    const tw = Settings.tileWidth || 32;
    if (tw <= 32) return 'icon';
    if (tw <= 64) return 'small';
    return 'medium';
}

/**
 * Placement / role variant, then Engine Tweakings / tile-size default.
 * Settings.tileSpriteVariant still wins (global display override).
 *
 * @param {string|null|undefined} explicit
 * @returns {string}
 */
function resolveTileVariantForDisplay(explicit) {
    if (Settings.tileSpriteVariant) {
        return normalizeVariant(Settings.tileSpriteVariant);
    }
    if (explicit != null && String(explicit).trim()) {
        return normalizeVariant(explicit);
    }
    return defaultTileVariantForDisplay();
}

/**
 * Sprite height mult relative to tile height for an entity.
 *
 * ```
 * drawn = displayScale × roleScale
 * ```
 *
 * * `displayScale` — per-species size from the creature template (default 1;
 *   e.g. dragons 1.5–2). Copied onto the entity via `applyTemplate`.
 * * `roleScale` — rarity/affix entry from `Settings.entitySpriteScaleByAffix`,
 *   or `Settings.entitySpriteScale` when no affix matches (default 1).
 * * Affix/rarity therefore multiplies the species base (elite dragon =
 *   displayScale × elite mult).
 * * Hard cap is `entitySpriteScaleMax × displayScale` so large species keep
 *   room for affix boosts.
 * * Explicit `entity.spriteScale` is an absolute override (still capped).
 *
 * @param {object|null|undefined} entity
 * @returns {number}
 */
function resolveEntitySpriteScale(entity) {
    const baseRaw = Number(Settings.entitySpriteScale);
    const base = Number.isFinite(baseRaw) && baseRaw > 0 ? baseRaw : 1;
    const maxRaw = Number(Settings.entitySpriteScaleMax);
    const maxRole = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 2;
    const lo = 0.25;

    let display = 1;
    if (entity && entity.displayScale != null) {
        const d = Number(entity.displayScale);
        if (Number.isFinite(d) && d > 0) display = d;
    }

    const cap = Math.max(lo, maxRole * display);

    if (entity && entity.spriteScale != null) {
        const o = Number(entity.spriteScale);
        if (Number.isFinite(o) && o > 0) {
            return Math.max(lo, Math.min(cap, o));
        }
    }

    let role = base;
    if (entity) {
        const table =
            Settings.entitySpriteScaleByAffix &&
            typeof Settings.entitySpriteScaleByAffix === 'object'
                ? Settings.entitySpriteScaleByAffix
                : null;
        if (table) {
            /** @type {number|null} */
            let best = null;
            const consider = (key) => {
                if (key == null || key === '') return;
                const k = String(key).toLowerCase();
                if (table[k] == null) return;
                const v = Number(table[k]);
                if (!Number.isFinite(v) || v <= 0) return;
                if (best == null || v > best) best = v;
            };
            if (entity.rarity != null) consider(entity.rarity);
            if (Array.isArray(entity.affixes)) {
                for (let i = 0; i < entity.affixes.length; i++) {
                    consider(entity.affixes[i]);
                }
            }
            if (best != null) role = best;
        }
    }

    if (!Number.isFinite(role) || role <= 0) role = base;
    const scale = display * role;
    if (!Number.isFinite(scale) || scale <= 0) return Math.max(lo, Math.min(cap, base * display));
    return Math.max(lo, Math.min(cap, scale));
}

/**
 * Build resolver opts from a sim entity (creature or player).
 * @param {object} entity
 * @param {{ genre?: string, variant?: string, kind?: string }} [overrides]
 * @returns {object}
 */
function entitySpriteOpts(entity, overrides) {
    const o = overrides || {};
    if (!entity) {
        return {
            genre: o.genre || DEFAULT_GENRE,
            kind: o.kind || 'creatures',
            variant: o.variant || defaultVariantForDisplay()
        };
    }
    // customSprite / spriteId: use that catalog id for stem resolution and
    // skip template sprite bags (including legacy GIF) so the override wins.
    // customSpriteGenre → spriteGenre wins over hunt/scene genre so art can
    // come from another genre catalog.
    const customId =
        entity.spriteId != null && String(entity.spriteId).trim()
            ? String(entity.spriteId).trim()
            : null;
    if (customId) {
        return {
            genre:
                entity.spriteGenre ||
                o.genre ||
                entity.genre ||
                DEFAULT_GENRE,
            kind: o.kind || entity.spriteKind || 'creatures',
            variant: o.variant || defaultVariantForDisplay(),
            id: customId,
            technical: null,
            stem: entity.spriteStem || null,
            sprites: null
        };
    }
    return {
        genre:
            o.genre ||
            entity.genre ||
            entity.spriteGenre ||
            DEFAULT_GENRE,
        kind: o.kind || entity.spriteKind || 'creatures',
        variant: o.variant || defaultVariantForDisplay(),
        id: entity.creatureType || entity.classId || null,
        technical: entity.technical || entity.spriteTechnical || null,
        stem: entity.spriteStem || null,
        sprites: mergeSpriteBags(entity.sprites, entity.sprite)
    };
}

/**
 * Requested variant, then icon, then original. Hunt tall-props used to ask
 * for entity `small/` while debug tiles only shipped `icon/` — 404 forever.
 * @param {Parameters<typeof resolveSpriteRelPath>[0]} opts
 * @returns {string[]}
 */
function spriteUrlCandidates(opts) {
    const o = opts || {};
    const requested = normalizeVariant(o.variant);
    /** @type {string[]} */
    const variants = [requested];
    if (requested !== 'icon') variants.push('icon');
    if (requested !== 'original') variants.push('original');
    /** @type {string[]} */
    const urls = [];
    /** @type {Record<string, true>} */
    const seen = Object.create(null);
    for (let i = 0; i < variants.length; i++) {
        const url = resolveSpriteUrl(Object.assign({}, o, { variant: variants[i] }));
        if (!url || seen[url]) continue;
        seen[url] = true;
        urls.push(url);
    }
    return urls;
}

/**
 * @param {Parameters<typeof resolveSpriteRelPath>[0]} opts
 * @returns {'skip'|'missing'|'ready'|'pending'|'failed'}
 */
function getSpriteLoadState(opts) {
    if (Settings.HEADLESS) return 'skip';
    if (Settings.useEntitySprites === false) return 'skip';
    const urls = spriteUrlCandidates(opts);
    if (!urls.length) return 'missing';
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (ImageDB.hasFailed(url)) continue;
        const img = ImageDB.get(url);
        if (isDrawableReady(img)) return 'ready';
        if (img) return 'pending';
        return 'missing';
    }
    return 'failed';
}

/**
 * True only while a candidate is in-flight. Failed / missing is false
 * so the floor cache does not rebuild every frame on 404.
 * @param {Parameters<typeof resolveSpriteRelPath>[0]} opts
 * @returns {boolean}
 */
function isSpritePending(opts) {
    return getSpriteLoadState(opts) === 'pending';
}

/**
 * Start async load (no-op headless / no Image). Returns URL or null.
 * @param {Parameters<typeof resolveSpriteRelPath>[0]} opts
 * @returns {string|null}
 */
function prefetchSprite(opts) {
    if (Settings.HEADLESS) return null;
    const urls = spriteUrlCandidates(opts);
    if (!urls.length) return null;
    for (let i = 0; i < urls.length; i++) {
        if (ImageDB.hasFailed(urls[i])) continue;
        ImageDB.get(urls[i]);
        return urls[i];
    }
    return null;
}

/**
 * Prefetch sprites for a hunt roster (spawns + optional party class ids).
 * Never blocks; never throws.
 *
 * @param {{
 *   genre?: string,
 *   spawns?: object[],
 *   creatureIds?: string[],
 *   members?: object[],
 *   templates?: Record<string, object>|null,
 *   classes?: Record<string, object>|null,
 *   classLoader?: ((id: string) => object|null)|null,
 *   itemDb?: object[]|Record<string, object>|null,
 *   variant?: string
 * }} [opts]
 * @returns {string[]} URLs requested
 */
function prefetchHuntSprites(opts) {
    const o = opts || {};
    if (Settings.HEADLESS) return [];
    const genre = o.genre || DEFAULT_GENRE;
    const variant = o.variant || defaultVariantForDisplay();
    const templates = o.templates || null;
    const classes = o.classes || null;
    const itemDb = o.itemDb || null;
    const classLoader =
        typeof o.classLoader === 'function' ? o.classLoader : null;
    /** @type {Record<string, true>} */
    const seen = Object.create(null);
    /** @type {string[]} */
    const urls = [];

    const pushId = (id, extra) => {
        if (!id || seen[id]) return;
        seen[id] = true;
        const tpl = templates && templates[id] ? templates[id] : null;
        const custom =
            tpl &&
            tpl.customSprite != null &&
            String(tpl.customSprite).trim()
                ? String(tpl.customSprite).trim()
                : tpl && tpl.spriteId != null && String(tpl.spriteId).trim()
                  ? String(tpl.spriteId).trim()
                  : null;
        const tplGenre =
            custom &&
            tpl &&
            tpl.customSpriteGenre != null &&
            String(tpl.customSpriteGenre).trim()
                ? String(tpl.customSpriteGenre).trim()
                : (tpl && tpl.genre) || genre;
        const url = prefetchSprite(
            Object.assign(
                {
                    genre: tplGenre,
                    id: custom || (tpl && tpl.id) || id,
                    technical: custom ? null : tpl && tpl.technical,
                    sprites: custom
                        ? null
                        : mergeSpriteBags(
                              tpl && tpl.sprites,
                              tpl && tpl.sprite
                          ),
                    variant
                },
                extra || {}
            )
        );
        if (url) urls.push(url);
    };

    const resolveClassDef = (classId) => {
        if (!classId) return null;
        if (classes && classes[classId]) return classes[classId];
        if (classLoader) {
            try {
                return classLoader(classId);
            } catch (_) {
                return null;
            }
        }
        return null;
    };

    if (Array.isArray(o.creatureIds)) {
        for (let i = 0; i < o.creatureIds.length; i++) {
            pushId(o.creatureIds[i]);
        }
    }
    if (Array.isArray(o.spawns)) {
        for (let i = 0; i < o.spawns.length; i++) {
            const e = o.spawns[i];
            if (!e) continue;
            const id = e.creatureId || e.id;
            const tpl = e.template || (templates && id ? templates[id] : null);
            if (id) {
                if (!seen[id]) {
                    seen[id] = true;
                    const custom =
                        (e.spriteId && String(e.spriteId).trim()) ||
                        (tpl &&
                            tpl.customSprite != null &&
                            String(tpl.customSprite).trim()) ||
                        (tpl &&
                            tpl.spriteId != null &&
                            String(tpl.spriteId).trim()) ||
                        null;
                    const tplGenre =
                        custom &&
                        tpl &&
                        tpl.customSpriteGenre != null &&
                        String(tpl.customSpriteGenre).trim()
                            ? String(tpl.customSpriteGenre).trim()
                            : (e.spriteGenre && String(e.spriteGenre).trim()) ||
                              (tpl && tpl.genre) ||
                              genre;
                    const url = prefetchSprite({
                        genre: tplGenre,
                        id: custom || (tpl && tpl.id) || id,
                        technical: custom
                            ? null
                            : tpl && tpl.technical,
                        sprites: custom
                            ? null
                            : mergeSpriteBags(
                                  (tpl && tpl.sprites) || e.sprites,
                                  (tpl && tpl.sprite) || e.sprite
                              ),
                        variant
                    });
                    if (url) urls.push(url);
                }
            }
        }
    }
    if (Array.isArray(o.members)) {
        // Profile customSprite → vocation baseSprite → class/type id (soft).
        let resolvePlayerSpriteArt = null;
        try {
            resolvePlayerSpriteArt = require('./character/player_profile.js')
                .resolvePlayerSpriteArt;
        } catch (_) {
            resolvePlayerSpriteArt = null;
        }
        for (let i = 0; i < o.members.length; i++) {
            const m = o.members[i];
            if (!m) continue;
            const classId = m.classId || m.vocation || null;
            const classDef =
                m.classDef ||
                (classId ? resolveClassDef(classId) : null);
            let artId = null;
            let artGenre = genre;
            if (typeof resolvePlayerSpriteArt === 'function') {
                const art = resolvePlayerSpriteArt(m, classDef);
                artId = art.spriteId;
                if (art.spriteGenre) artGenre = art.spriteGenre;
            } else {
                artId =
                    (m.spriteId != null && String(m.spriteId).trim()) ||
                    (m.customSprite != null && String(m.customSprite).trim()) ||
                    null;
            }
            const custom = !!artId;
            const sid = artId || m.creatureType || classId || null;
            if (sid) {
                const url = prefetchSprite({
                    genre: artGenre,
                    id: sid,
                    sprites: custom
                        ? null
                        : mergeSpriteBags(m.sprites, m.sprite),
                    technical: custom ? null : m.technical,
                    variant
                });
                if (url) urls.push(url);
            }
            // Distance ammo projectile art (equipment kind, customSprite preferred)
            if (itemDb && m.equipment && typeof m.equipment === 'object') {
                const left =
                    m.equipment.leftHand != null
                        ? m.equipment.leftHand
                        : m.equipment.shield;
                if (left != null && left !== '') {
                    let item = null;
                    if (Array.isArray(itemDb)) {
                        for (let j = 0; j < itemDb.length; j++) {
                            if (itemDb[j] && String(itemDb[j].id) === String(left)) {
                                item = itemDb[j];
                                break;
                            }
                        }
                    } else if (itemDb[left]) {
                        item = itemDb[left];
                    } else if (itemDb[String(left)]) {
                        item = itemDb[String(left)];
                    }
                    if (item) {
                        const cat =
                            item.category != null ? String(item.category) : '';
                        const isAmmo =
                            cat === 'ammo' ||
                            cat === 'ammunition' ||
                            (Array.isArray(item.type) &&
                                item.type.indexOf('ammunition') >= 0);
                        if (isAmmo) {
                            const ammoArt =
                                (item.customSprite != null &&
                                    String(item.customSprite).trim()) ||
                                (item.spriteId != null &&
                                    String(item.spriteId).trim()) ||
                                (item.id != null && String(item.id).trim()) ||
                                null;
                            if (ammoArt) {
                                const ammoGenre =
                                    (item.customSpriteGenre != null &&
                                        String(item.customSpriteGenre).trim()) ||
                                    (item.spriteGenre != null &&
                                        String(item.spriteGenre).trim()) ||
                                    genre;
                                const equipKey = `equip:${ammoGenre}:${ammoArt}`;
                                if (!seen[equipKey]) {
                                    seen[equipKey] = true;
                                    const url = prefetchSprite({
                                        genre: ammoGenre,
                                        kind: 'equipment',
                                        id: ammoArt,
                                        variant
                                    });
                                    if (url) urls.push(url);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    return urls;
}

/**
 * Return a ready drawable for opts, starting load if needed. Null until ready or failed.
 * After the requested variant 404s, tries `icon/` then `original/`.
 * @param {Parameters<typeof resolveSpriteRelPath>[0]} opts
 * @returns {import('./imagedb.js').Drawable|null}
 */
function getReadySpriteImage(opts) {
    if (Settings.HEADLESS) return null;
    if (Settings.useEntitySprites === false) return null;
    const urls = spriteUrlCandidates(opts);
    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        if (ImageDB.hasFailed(url)) continue;
        const img = ImageDB.get(url);
        if (isDrawableReady(img)) return img;
        return null;
    }
    return null;
}

/**
 * Read natural image size, caching on the drawable so hot draw loops
 * do not re-probe naturalWidth/Height every frame.
 * @param {import('./imagedb.js').Drawable} img
 * @returns {{ iw: number, ih: number }|null}
 */
function getCachedImageSize(img) {
    if (!img) return null;
    // Prefer previously measured size (stable once the asset has loaded)
    if (img._spriteIw > 0 && img._spriteIh > 0) {
        return { iw: img._spriteIw, ih: img._spriteIh };
    }
    const iw =
        img.naturalWidth != null && img.naturalWidth > 0
            ? img.naturalWidth
            : img.width || 0;
    const ih =
        img.naturalHeight != null && img.naturalHeight > 0
            ? img.naturalHeight
            : img.height || 0;
    if (!(iw > 0 && ih > 0)) return null;
    img._spriteIw = iw;
    img._spriteIh = ih;
    return { iw, ih };
}

/**
 * Layout for drawing a sprite on a tile: horizontal center, vertical bottom.
 * Height = `th * scale` (scale is tile-relative; independent of source PNG size).
 * Feet on the tile bottom; tall/wide sprites may spill past the tile box.
 *
 * @param {import('./imagedb.js').Drawable} img
 * @param {number} tilePxX left of tile in canvas px
 * @param {number} tilePxY top of tile in canvas px
 * @param {number} tw tile width px
 * @param {number} th tile height px
 * @param {number} [scale=1] height mult of tile (1 = one tile tall, 2 = double)
 * @returns {{
 *   iw: number,
 *   ih: number,
 *   scaledW: number,
 *   scaledH: number,
 *   scale: number,
 *   px: number,
 *   py: number,
 *   topY: number,
 *   bottomY: number
 * }|null}
 */
function measureEntitySprite(img, tilePxX, tilePxY, tw, th, scale) {
    if (!img) return null;
    const size = getCachedImageSize(img);
    if (!size) return null;
    const { iw, ih } = size;

    const sRaw = scale != null ? Number(scale) : 1;
    const s = Number.isFinite(sRaw) && sRaw > 0 ? sRaw : 1;
    const scaledH = th * s;
    const scaledW = iw * (scaledH / ih);
    // Center horizontally on the tile; pin feet to the tile bottom edge
    const px = tilePxX + tw / 2 - scaledW / 2;
    const py = tilePxY + th - scaledH;
    return {
        iw,
        ih,
        scaledW,
        scaledH,
        scale: s,
        px,
        py,
        topY: py,
        bottomY: tilePxY + th
    };
}

/**
 * Draw a sprite centered on a tile, feet on the tile bottom.
 * Catalog art faces right by default; pass flipH to mirror for leftward moves.
 *
 * @param {CanvasRenderingContext2D} g
 * @param {import('./imagedb.js').Drawable} img
 * @param {number} tilePxX left of tile in canvas px
 * @param {number} tilePxY top of tile in canvas px
 * @param {number} tw tile width px
 * @param {number} th tile height px
 * @param {number} [scale=1] height mult of tile
 * @param {boolean} [flipH=false] horizontal mirror (sprite facing left)
 * @returns {ReturnType<typeof measureEntitySprite>} layout used, or null
 */
function drawEntitySprite(g, img, tilePxX, tilePxY, tw, th, scale, flipH) {
    if (!g || !img) return null;
    const layout = measureEntitySprite(img, tilePxX, tilePxY, tw, th, scale);
    if (!layout) return null;
    const dx = Math.floor(layout.px);
    const dy = Math.floor(layout.py);
    const dw = layout.scaledW;
    const dh = layout.scaledH;
    if (flipH) {
        // Mirror around the sprite's horizontal center (tile center)
        const cx = dx + dw / 2;
        g.save();
        g.translate(cx, 0);
        g.scale(-1, 1);
        g.translate(-cx, 0);
        g.drawImage(img, dx, dy, dw, dh);
        g.restore();
    } else {
        g.drawImage(img, dx, dy, dw, dh);
    }
    return layout;
}

module.exports = {
    SPRITE_VARIANTS,
    DEFAULT_VARIANT,
    technicalToFileStem,
    idToFileStem,
    genreFolder,
    normalizeVariant,
    cleanRelPath,
    rewriteVariantPath,
    mergeSpriteBags,
    resolveFileStem,
    resolveSpriteRelPath,
    resolveSpriteUrl,
    spriteUrlCandidates,
    getSpriteLoadState,
    isSpritePending,
    defaultVariantForDisplay,
    defaultTileVariantForDisplay,
    resolveTileVariantForDisplay,
    entitySpriteOpts,
    resolveEntitySpriteScale,
    prefetchSprite,
    prefetchHuntSprites,
    getReadySpriteImage,
    getCachedImageSize,
    measureEntitySprite,
    drawEntitySprite
};
