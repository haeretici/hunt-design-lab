/**
 * Asset catalog ops: list, remove, rename, flip, replace, reprocess, fix-green.
 * Works for any asset kind (creatures, equipment, tiles, objects).
 * Shared by CLI (bin/manage_creature.js) and the PHP web API (sync spawn).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
    ROOT,
    GENRES,
    genrePaths,
    DEFAULT_KIND,
    getAssetKind,
    listKindIds
} = require('../../settings.js');
const {
    loadCatalog,
    saveCatalog,
    findById,
    technicalToId,
    technicalToFileStem,
    deriveAliasFromTechnical,
    resolveOpaqueAlpha,
    repoPath,
    absoluteSpritePath
} = require('./creature_manifest.js');

/** Variant folder names under …/<kind>/ (original + processed). */
const ALL_VARIANT_NAMES = [
    'original',
    'alpha',
    'medium',
    'retro',
    'small',
    'icon',
    'transformed'
];

/**
 * @param {ReturnType<typeof genrePaths>} paths
 * @returns {Array<{ name: string, dir: string }>}
 */
function variantDirs(paths) {
    const out = [];
    for (const name of ALL_VARIANT_NAMES) {
        const dir =
            name === 'transformed'
                ? path.join(paths.creaturesRoot, 'transformed')
                : paths[name] || path.join(paths.creaturesRoot, name);
        if (dir) out.push({ name, dir });
    }
    return out;
}

/**
 * @param {string} dir
 * @param {string} stem
 * @returns {string|null}
 */
function existingPng(dir, stem) {
    const p = path.join(dir, `${stem}.png`);
    return fs.existsSync(p) ? p : null;
}

/**
 * Resolve on-disk file stem for a catalog row.
 * @param {object} creature
 * @param {ReturnType<typeof genrePaths>} paths
 * @returns {string|null}
 */
function resolveStem(creature, paths) {
    const rel = creature.sprites && creature.sprites.original;
    if (rel) {
        const abs = absoluteSpritePath(String(rel));
        return path.basename(abs, path.extname(abs));
    }
    if (creature.technical) {
        const stem = technicalToFileStem(String(creature.technical));
        if (existingPng(paths.original, stem)) return stem;
    }
    if (creature.id) {
        const lower = String(creature.id).toLowerCase();
        if (!fs.existsSync(paths.original)) return null;
        for (const name of fs.readdirSync(paths.original)) {
            if (!name.toLowerCase().endsWith('.png')) continue;
            const s = name.replace(/\.png$/i, '');
            if (s.toLowerCase() === lower) return s;
        }
    }
    return creature.technical ? technicalToFileStem(String(creature.technical)) : null;
}

/**
 * @param {string} filePath
 * @returns {number|null} mtime ms
 */
function mtimeMs(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return null;
    }
}

/**
 * @param {string} filePath
 * @returns {string|null} ISO
 */
function mtimeIso(filePath) {
    try {
        return fs.statSync(filePath).mtime.toISOString();
    } catch {
        return null;
    }
}

/**
 * Repo-relative path for a variant file (if present).
 * @param {string} genreFolder
 * @param {string} kindFolder
 * @param {string} variant
 * @param {string} stem
 * @param {string} absPath
 */
function relVariant(genreFolder, kindFolder, variant, stem, absPath) {
    if (!absPath) return null;
    return repoPath(
        'assets',
        'sprites',
        genreFolder,
        kindFolder,
        variant,
        `${stem}.png`
    );
}

/**
 * List catalog assets enriched with file mtimes and variant presence.
 * Sorted newest-first by file mtime (falls back to createdAt).
 *
 * Equipment: catalog sprite rows only. Combat presets are not injected;
 * they bind art via spriteId / customSprite and stay in presets/equipment.json.
 *
 * @param {string} genreId
 * @param {{ limit?: number, query?: string, kind?: string }} [options]
 */
function listCreaturesEnriched(genreId, options = {}) {
    const kindId = options.kind || DEFAULT_KIND;
    const kind = getAssetKind(kindId);
    const paths = genrePaths(genreId, kindId);
    const catalog = loadCatalog(genreId, { kind: kindId });
    const folder = paths.genre.folder;
    const kindFolder = kind.folder;
    const dirs = variantDirs(paths);
    const q = options.query ? String(options.query).trim().toLowerCase() : '';

    /** @type {object[]} */
    const items = [];
    const seenIds = new Set();

    if (kindId === 'equipment') {
        try {
            const { loadEquipmentPreset } = require('./presets.js');
            const { catalogItemToCombatItem } = require('./content/equipment_bridge.js');

            const catalogMap = Object.create(null);
            for (const c of catalog.creatures || []) {
                if (c && c.id) catalogMap[c.id] = c;
            }

            const eqData = loadEquipmentPreset();
            const rawPresetItems = (eqData && eqData.items) || [];

            for (const p of rawPresetItems) {
                if (!p || !p.id) continue;

                const c = catalogMap[p.id] || null;
                // Combat items that reuse another catalog sprite (or have no art)
                // must not appear as empty Sprite Manager cards.
                if (!c) continue;
                seenIds.add(p.id);
                const combat = catalogItemToCombatItem(p);
                const alias = p.label || p.alias || (c && c.alias) || p.id;
                const technical = p.technical || p.label || (c && c.technical) || p.id;

                if (q) {
                    const hay = `${p.id} ${technical} ${alias} ${p.category || ''} ${p.slot || ''} ${(p.tags || []).join(' ')}`.toLowerCase();
                    if (!hay.includes(q)) continue;
                }

                const stem = c ? resolveStem(c, paths) : null;
                /** @type {Record<string, string|null>} */
                const variants = {};
                /** @type {Record<string, boolean>} */
                const present = {};

                if (stem) {
                    for (const { name, dir } of dirs) {
                        if (name === 'transformed') continue;
                        const abs = existingPng(dir, stem);
                        present[name] = Boolean(abs);
                        variants[name] = abs ? relVariant(folder, kindFolder, name, stem, abs) : null;
                    }
                } else {
                    for (const { name } of dirs) {
                        if (name === 'transformed') continue;
                        present[name] = false;
                        variants[name] = null;
                    }
                }

                const originalAbs = stem ? existingPng(paths.original, stem) : null;
                let sortMs = null;
                let mtime = null;
                if (originalAbs) {
                    sortMs = mtimeMs(originalAbs);
                    mtime = mtimeIso(originalAbs);
                } else if (c && c.createdAt) {
                    const t = Date.parse(String(c.createdAt));
                    if (Number.isFinite(t)) sortMs = t;
                    mtime = String(c.createdAt);
                }

                items.push({
                    id: p.id,
                    technical,
                    alias,
                    genre: p.genre || (c && c.genre) || genreId,
                    kind: 'equipment',
                    category: combat.category || p.category || (c && c.category) || null,
                    slot: combat.slot || p.slot || null,
                    level: combat.level != null ? combat.level : (p.level != null ? p.level : 1),
                    atk: p.atk != null ? p.atk : (combat.atk || 0),
                    extraAtk: p.extraAtk != null ? p.extraAtk : (combat.extraAtk || 0),
                    extraAtkElement: p.extraAtkElement || combat.extraAtkElement || null,
                    defense: p.defense != null ? p.defense : (combat.defense || 0),
                    defenseBonus: p.defenseBonus != null ? p.defenseBonus : (combat.defenseBonus || 0),
                    armor: p.armor != null ? p.armor : (combat.armor || 0),
                    weight: p.weight != null ? p.weight : (combat.weight || 0),
                    weaponType: p.weaponType || combat.weaponType || null,
                    vocation: p.vocation || null,
                    twoHanded: !!p.twoHanded,
                    imbuementSlots: p.imbuementSlots || null,
                    range: p.range || null,
                    skillBonuses: p.skillBonuses || combat.skillBonuses || null,
                    resists: p.resists || combat.resists || null,
                    notes: p.notes || (c && c.notes) || null,
                    opaqueAlpha: resolveOpaqueAlpha(c ? c.opaqueAlpha : false, kindId),
                    status: c ? c.status : 'preset_only',
                    source: p.source || (c && c.source) || 'preset',
                    tags: Array.isArray(p.tags) ? p.tags : (Array.isArray(c?.tags) ? c.tags : []),
                    createdAt: (c && c.createdAt) || null,
                    stem,
                    mtime,
                    mtimeMs: sortMs || 0,
                    sprites: {
                        original: variants.original || (c && c.sprites?.original) || null,
                        alpha: variants.alpha || null,
                        medium: variants.medium || null,
                        retro: variants.retro || null,
                        small: variants.small || null,
                        icon: variants.icon || null,
                        transformed: (c && c.sprites?.transformed) || null
                    },
                    present
                });
            }
        } catch (_) {
            /* ignore */
        }
    }

    for (const c of catalog.creatures || []) {
        if (!c || !c.id || seenIds.has(c.id)) continue;
        seenIds.add(c.id);

        if (q) {
            const hay = `${c.id} ${c.technical} ${c.alias} ${(c.tags || []).join(' ')}`.toLowerCase();
            if (!hay.includes(q)) continue;
        }

        const stem = resolveStem(c, paths);
        /** @type {Record<string, string|null>} */
        const variants = {};
        /** @type {Record<string, boolean>} */
        const present = {};

        for (const { name, dir } of dirs) {
            if (name === 'transformed') continue;
            const abs = stem ? existingPng(dir, stem) : null;
            present[name] = Boolean(abs);
            variants[name] = abs
                ? relVariant(folder, kindFolder, name, stem, abs)
                : null;
        }

        const originalAbs = stem ? existingPng(paths.original, stem) : null;
        let sortMs = null;
        let mtime = null;
        if (originalAbs) {
            sortMs = mtimeMs(originalAbs);
            mtime = mtimeIso(originalAbs);
        } else if (c.createdAt) {
            const t = Date.parse(String(c.createdAt));
            if (Number.isFinite(t)) sortMs = t;
            mtime = String(c.createdAt);
        }

        let combat = null;
        if (kindId === 'equipment') {
            try {
                const { catalogItemToCombatItem } = require('./content/equipment_bridge.js');
                combat = catalogItemToCombatItem(c);
            } catch (_) {
                /* ignore */
            }
        }

        items.push({
            id: c.id,
            technical: c.technical,
            alias: c.alias,
            genre: c.genre || genreId,
            kind: c.kind || kindId,
            category: c.category || (combat && combat.category) || null,
            slot: (combat && combat.slot) || c.slot || null,
            level: combat && combat.level != null ? combat.level : 1,
            atk: (combat && combat.atk) || 0,
            extraAtk: (combat && combat.extraAtk) || c.extraAtk || 0,
            extraAtkElement: (combat && combat.extraAtkElement) || c.extraAtkElement || null,
            defense: (combat && combat.defense) || 0,
            defenseBonus: (combat && combat.defenseBonus) || c.defenseBonus || 0,
            armor: (combat && combat.armor) || 0,
            weight: (combat && combat.weight) || 0,
            weaponType: (combat && combat.weaponType) || null,
            vocation: c.vocation || null,
            twoHanded: !!c.twoHanded,
            imbuementSlots: c.imbuementSlots || null,
            range: c.range || null,
            skillBonuses: (combat && combat.skillBonuses) || c.skillBonuses || null,
            resists: (combat && combat.resists) || c.resists || null,
            notes: c.notes || null,
            opaqueAlpha: resolveOpaqueAlpha(c.opaqueAlpha, kindId),
            status: c.status,
            source: c.source,
            tags: Array.isArray(c.tags) ? c.tags : [],
            createdAt: c.createdAt || null,
            stem,
            mtime,
            mtimeMs: sortMs || 0,
            sprites: {
                original: variants.original || c.sprites?.original || null,
                alpha: variants.alpha || null,
                medium: variants.medium || null,
                retro: variants.retro || null,
                small: variants.small || null,
                icon: variants.icon || null,
                transformed: c.sprites?.transformed || null
            },
            present
        });
    }

    items.sort((a, b) => {
        const ma = a.mtimeMs != null ? a.mtimeMs : 0;
        const mb = b.mtimeMs != null ? b.mtimeMs : 0;
        if (mb !== ma) return mb - ma;
        return String(a.id).localeCompare(String(b.id));
    });

    const limit =
        options.limit != null && Number.isFinite(Number(options.limit))
            ? Math.max(0, Math.floor(Number(options.limit)))
            : null;
    const sliced = limit != null ? items.slice(0, limit) : items;

    return {
        genre: genreId,
        kind: kindId,
        updatedAt: catalog.updatedAt,
        total: items.length,
        creatures: sliced.map(({ mtimeMs: _ms, ...rest }) => rest)
    };
}

/**
 * @param {string} filePath
 */
function unlinkQuiet(filePath) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
    }
    return false;
}

/**
 * Remove technical from done list if present.
 * @param {string} doneFile
 * @param {string} technical
 * @param {boolean} dryRun
 */
function removeFromDoneList(doneFile, technical, dryRun) {
    if (!fs.existsSync(doneFile) || !technical) {
        return { removed: false };
    }
    const text = fs.readFileSync(doneFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const key = String(technical).trim().toLowerCase();
    const kept = [];
    let removed = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const tech = trimmed.split('\t')[0].trim();
        if (tech.toLowerCase() === key) {
            removed = true;
            continue;
        }
        kept.push(line.replace(/\r$/, ''));
    }
    if (removed && !dryRun) {
        fs.writeFileSync(doneFile, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
    }
    return { removed };
}

/**
 * Replace technical name in done list.
 * @param {string} doneFile
 * @param {string} oldTechnical
 * @param {string} newTechnical
 * @param {boolean} dryRun
 */
function renameInDoneList(doneFile, oldTechnical, newTechnical, dryRun) {
    if (!fs.existsSync(doneFile) || !oldTechnical) {
        return { renamed: false };
    }
    const text = fs.readFileSync(doneFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const key = String(oldTechnical).trim().toLowerCase();
    let renamed = false;
    const out = [];
    for (const line of lines) {
        const raw = line.replace(/\r$/, '');
        const trimmed = raw.trim();
        if (!trimmed) {
            out.push(raw);
            continue;
        }
        const parts = trimmed.split('\t');
        const tech = parts[0].trim();
        if (tech.toLowerCase() === key) {
            renamed = true;
            parts[0] = newTechnical;
            out.push(parts.join('\t'));
        } else {
            out.push(raw);
        }
    }
    if (renamed && !dryRun) {
        const content = out.join('\n');
        fs.writeFileSync(
            doneFile,
            content.endsWith('\n') || content === '' ? content : content + '\n',
            'utf8'
        );
    }
    return { renamed };
}

/**
 * Delete all sprite variants + catalog row (+ done list).
 * @param {string} genreId
 * @param {string} creatureId
 * @param {{ dryRun?: boolean, keepDone?: boolean, kind?: string }} [options]
 */
function removeCreature(genreId, creatureId, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const kindId = options.kind || DEFAULT_KIND;
    const kind = getAssetKind(kindId);
    const paths = genrePaths(genreId, kindId);
    const catalog = loadCatalog(genreId, { kind: kindId });
    const creature = findById(catalog, creatureId);
    if (!creature) {
        throw new Error(`Asset not found: ${creatureId}`);
    }

    const stem = resolveStem(creature, paths);
    const deleted = [];
    if (stem) {
        for (const { name, dir } of variantDirs(paths)) {
            const abs = existingPng(dir, stem);
            if (abs) {
                deleted.push(
                    repoPath(
                        'assets',
                        'sprites',
                        paths.genre.folder,
                        kind.folder,
                        name,
                        `${stem}.png`
                    )
                );
                if (!dryRun) unlinkQuiet(abs);
            }
        }
    }

    catalog.creatures = (catalog.creatures || []).filter((c) => c.id !== creatureId);
    if (!dryRun) {
        saveCatalog(catalog, { kind: kindId });
        if (!options.keepDone) {
            removeFromDoneList(paths.doneFile, creature.technical, false);
        }
    }

    return {
        ok: true,
        action: 'remove',
        genre: genreId,
        kind: kindId,
        id: creatureId,
        technical: creature.technical,
        stem,
        deleted,
        dryRun
    };
}

/**
 * Validate a new technical name (letters/spaces only after stem sanitize).
 * @param {string} technical
 */
function assertTechnicalName(technical) {
    const t = String(technical || '').trim();
    if (!t) throw new Error('Technical name is required');
    if (t.length > 80) throw new Error('Technical name too long (max 80)');
    if (!/^[A-Za-z][A-Za-z0-9' -]*$/.test(t)) {
        throw new Error(
            'Technical name must start with a letter and use only letters, digits, spaces, hyphen, apostrophe'
        );
    }
    const stem = technicalToFileStem(t);
    if (!stem || stem.length < 2) {
        throw new Error('Technical name produces an empty file stem');
    }
    return t;
}

/**
 * Rename asset: files + catalog + done list.
 * @param {string} genreId
 * @param {string} creatureId
 * @param {string} newTechnical
 * @param {{ dryRun?: boolean, alias?: string, kind?: string }} [options]
 */
function renameCreature(genreId, creatureId, newTechnical, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const kindId = options.kind || DEFAULT_KIND;
    const kind = getAssetKind(kindId);
    const paths = genrePaths(genreId, kindId);
    const catalog = loadCatalog(genreId, { kind: kindId });
    const creature = findById(catalog, creatureId);
    if (!creature) {
        throw new Error(`Asset not found: ${creatureId}`);
    }

    const technical = assertTechnicalName(newTechnical);
    const newId = technicalToId(technical);
    const newStem = technicalToFileStem(technical);
    const oldStem = resolveStem(creature, paths);

    if (newId !== creatureId && findById(catalog, newId)) {
        throw new Error(`Target id already exists: ${newId}`);
    }

    if (oldStem && newStem !== oldStem) {
        for (const { dir } of variantDirs(paths)) {
            const dest = path.join(dir, `${newStem}.png`);
            if (fs.existsSync(dest)) {
                throw new Error(
                    `Target file already exists: ${path.basename(dest)} in ${path.basename(dir)}/`
                );
            }
        }
    }

    const folder = paths.genre.folder;
    const kindFolder = kind.folder;
    const renamed = [];
    if (oldStem && newStem !== oldStem) {
        for (const { name, dir } of variantDirs(paths)) {
            const src = existingPng(dir, oldStem);
            if (!src) continue;
            const dest = path.join(dir, `${newStem}.png`);
            renamed.push({
                from: repoPath(
                    'assets',
                    'sprites',
                    folder,
                    kindFolder,
                    name,
                    `${oldStem}.png`
                ),
                to: repoPath(
                    'assets',
                    'sprites',
                    folder,
                    kindFolder,
                    name,
                    `${newStem}.png`
                )
            });
            if (!dryRun) {
                fs.renameSync(src, dest);
            }
        }
    }

    let spritesOriginal = null;
    if (!dryRun) {
        spritesOriginal = fs.existsSync(path.join(paths.original, `${newStem}.png`))
            ? repoPath('assets', 'sprites', folder, kindFolder, 'original', `${newStem}.png`)
            : null;
    } else if (oldStem) {
        spritesOriginal = repoPath(
            'assets',
            'sprites',
            folder,
            kindFolder,
            'original',
            `${newStem}.png`
        );
    }

    const alias =
        options.alias != null && String(options.alias).trim()
            ? String(options.alias).trim()
            : creature.alias || deriveAliasFromTechnical(technical);

    const updated = {
        ...creature,
        id: newId,
        technical,
        alias,
        kind: kindId,
        sprites: {
            original: spritesOriginal,
            transformed: creature.sprites?.transformed ?? null
        }
    };

    if (!dryRun) {
        const idx = catalog.creatures.findIndex((c) => c.id === creatureId);
        if (idx >= 0) {
            catalog.creatures[idx] = updated;
        }
        catalog.creatures.sort((a, b) => a.id.localeCompare(b.id));
        saveCatalog(catalog, { kind: kindId });
        renameInDoneList(paths.doneFile, creature.technical, technical, false);
    }

    return {
        ok: true,
        action: 'rename',
        genre: genreId,
        kind: kindId,
        from: { id: creatureId, technical: creature.technical, stem: oldStem },
        to: { id: newId, technical, stem: newStem },
        alias,
        renamed,
        dryRun
    };
}

/**
 * Resolve ImageMagick binary (v7 magick or v6 convert).
 * @returns {string|null}
 */
function findImageMagick() {
    for (const bin of ['magick', 'convert']) {
        const r = spawnSync(bin, ['-version'], { encoding: 'utf8' });
        if (r.status === 0) return bin;
    }
    return null;
}

/**
 * Re-run process_sprites.py --force for one stem under a genre original/ dir.
 * @param {string} originalDir
 * @param {string} stem
 * @param {{ opaqueAlpha?: boolean, kind?: string }} [options]
 */
function reprocessStem(originalDir, stem, options = {}) {
    const processScript = path.join(ROOT, 'bin', 'process_sprites.py');
    if (!fs.existsSync(processScript)) {
        throw new Error('process_sprites.py not found');
    }
    const opaque = resolveOpaqueAlpha(options.opaqueAlpha, options.kind);
    const args = [processScript, originalDir, '--force', '--only', stem];
    if (opaque) {
        args.push('--opaque-alpha');
    }
    const pr = spawnSync('python3', args, { encoding: 'utf8', cwd: ROOT });
    if (pr.error) throw pr.error;
    if (pr.status !== 0) {
        const msg = (pr.stderr || pr.stdout || '').trim();
        throw new Error(`process_sprites failed: ${msg || `exit ${pr.status}`}`);
    }
}

/**
 * @param {string} genreId
 * @param {string} creatureId
 * @param {{ kind?: string }} [options]
 * @returns {{ creature: object, stem: string, originalAbs: string, paths: ReturnType<typeof genrePaths>, kindId: string }}
 */
function resolveCreatureOriginal(genreId, creatureId, options = {}) {
    const kindId = options.kind || DEFAULT_KIND;
    const paths = genrePaths(genreId, kindId);
    const catalog = loadCatalog(genreId, { kind: kindId });
    const creature = findById(catalog, creatureId);
    if (!creature) {
        throw new Error(`Asset not found: ${creatureId}`);
    }

    const stem = resolveStem(creature, paths);
    if (!stem) {
        throw new Error('No sprite stem resolved for asset');
    }
    const originalAbs = existingPng(paths.original, stem);
    if (!originalAbs) {
        throw new Error(`Original PNG missing for ${stem}`);
    }
    return { creature, stem, originalAbs, paths, kindId };
}

/**
 * Flip original horizontally, then re-run process_sprites.py --force for that stem.
 * @param {string} genreId
 * @param {string} creatureId
 * @param {{ dryRun?: boolean, kind?: string }} [options]
 */
function flipCreatureHorizontal(genreId, creatureId, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const { creature, stem, originalAbs, paths, kindId } = resolveCreatureOriginal(
        genreId,
        creatureId,
        options
    );
    const kind = getAssetKind(kindId);

    const im = findImageMagick();
    if (!im && !dryRun) {
        throw new Error('ImageMagick not found (install magick or convert)');
    }

    if (!dryRun) {
        const r = spawnSync(im, [originalAbs, '-flop', originalAbs], {
            encoding: 'utf8',
            cwd: ROOT
        });
        if (r.error) throw r.error;
        if (r.status !== 0) {
            throw new Error(
                `ImageMagick flip failed: ${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`
            );
        }
        reprocessStem(paths.original, stem, {
            opaqueAlpha: resolveOpaqueAlpha(creature.opaqueAlpha, kindId),
            kind: kindId
        });
    }

    return {
        ok: true,
        action: 'flip',
        genre: genreId,
        kind: kindId,
        id: creatureId,
        technical: creature.technical,
        stem,
        original: repoPath(
            'assets',
            'sprites',
            paths.genre.folder,
            kind.folder,
            'original',
            `${stem}.png`
        ),
        dryRun
    };
}

/**
 * Replace original PNG with a source image, then regenerate variants.
 * Source may be any raster ImageMagick can read; destination is always PNG.
 * @param {string} genreId
 * @param {string} creatureId
 * @param {string} sourceFile absolute path to uploaded/local image
 * @param {{ dryRun?: boolean, kind?: string }} [options]
 */
function replaceCreatureOriginal(genreId, creatureId, sourceFile, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const { creature, stem, originalAbs, paths, kindId } = resolveCreatureOriginal(
        genreId,
        creatureId,
        options
    );
    const kind = getAssetKind(kindId);

    const src = path.resolve(String(sourceFile || ''));
    if (!src || !fs.existsSync(src)) {
        throw new Error('Source image file not found');
    }
    const st = fs.statSync(src);
    if (!st.isFile() || st.size < 8) {
        throw new Error('Source is not a usable image file');
    }
    if (st.size > 25 * 1024 * 1024) {
        throw new Error('Source image too large (max 25 MB)');
    }

    const im = findImageMagick();
    if (!im && !dryRun) {
        throw new Error('ImageMagick not found (install magick or convert)');
    }

    if (!dryRun) {
        const r = spawnSync(im, [src, originalAbs], {
            encoding: 'utf8',
            cwd: ROOT
        });
        if (r.error) throw r.error;
        if (r.status !== 0) {
            throw new Error(
                `ImageMagick convert failed: ${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`
            );
        }
        if (!fs.existsSync(originalAbs)) {
            throw new Error('Replace failed: original PNG not written');
        }
        reprocessStem(paths.original, stem, {
            opaqueAlpha: resolveOpaqueAlpha(creature.opaqueAlpha, kindId),
            kind: kindId
        });
    }

    return {
        ok: true,
        action: 'replace',
        genre: genreId,
        kind: kindId,
        id: creatureId,
        technical: creature.technical,
        stem,
        original: repoPath(
            'assets',
            'sprites',
            paths.genre.folder,
            kind.folder,
            'original',
            `${stem}.png`
        ),
        dryRun
    };
}

/**
 * Set opaqueAlpha on a catalog row and reprocess variants when original exists.
 * @param {string} genreId
 * @param {string} creatureId
 * @param {boolean} opaqueAlpha
 * @param {{ dryRun?: boolean, kind?: string }} [options]
 */
function setOpaqueAlpha(genreId, creatureId, opaqueAlpha, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const kindId = options.kind || DEFAULT_KIND;
    const paths = genrePaths(genreId, kindId);
    const catalog = loadCatalog(genreId, { kind: kindId });
    const creature = findById(catalog, creatureId);
    if (!creature) {
        throw new Error(`Asset not found: ${creatureId}`);
    }

    const next = Boolean(opaqueAlpha);
    const prev = resolveOpaqueAlpha(creature.opaqueAlpha, kindId);
    const stem = resolveStem(creature, paths);
    const originalAbs = stem ? existingPng(paths.original, stem) : null;

    if (!dryRun) {
        creature.opaqueAlpha = next;
        const idx = catalog.creatures.findIndex((c) => c.id === creatureId);
        if (idx >= 0) {
            catalog.creatures[idx] = creature;
        }
        saveCatalog(catalog, { kind: kindId });
        if (originalAbs && stem) {
            reprocessStem(paths.original, stem, {
                opaqueAlpha: next,
                kind: kindId
            });
        }
    }

    return {
        ok: true,
        action: 'set_opaque_alpha',
        genre: genreId,
        kind: kindId,
        id: creatureId,
        technical: creature.technical,
        stem,
        opaqueAlpha: next,
        previousOpaqueAlpha: prev,
        reprocessed: Boolean(originalAbs && stem && !dryRun),
        dryRun
    };
}

/**
 * Re-run process_sprites.py --force for one asset stem (no flip/replace).
 * Honors catalog opaqueAlpha (and tiles default when unset).
 * @param {string} genreId
 * @param {string} creatureId
 * @param {{ dryRun?: boolean, kind?: string }} [options]
 */
function reprocessCreature(genreId, creatureId, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const { creature, stem, originalAbs, paths, kindId } = resolveCreatureOriginal(
        genreId,
        creatureId,
        options
    );
    const kind = getAssetKind(kindId);
    const opaque = resolveOpaqueAlpha(creature.opaqueAlpha, kindId);

    if (!dryRun) {
        reprocessStem(paths.original, stem, {
            opaqueAlpha: opaque,
            kind: kindId
        });
    }

    return {
        ok: true,
        action: 'reprocess',
        genre: genreId,
        kind: kindId,
        id: creatureId,
        technical: creature.technical,
        stem,
        opaqueAlpha: opaque,
        original: repoPath(
            'assets',
            'sprites',
            paths.genre.folder,
            kind.folder,
            'original',
            `${stem}.png`
        ),
        dryRun
    };
}

/**
 * Neutralize accentuated green pixels on original/ (R=B=G), then reprocess variants.
 * @param {string} genreId
 * @param {string} creatureId
 * @param {{ dryRun?: boolean, kind?: string }} [options]
 */
function fixGreenCreature(genreId, creatureId, options = {}) {
    const dryRun = Boolean(options.dryRun);
    const { creature, stem, originalAbs, paths, kindId } = resolveCreatureOriginal(
        genreId,
        creatureId,
        options
    );
    const kind = getAssetKind(kindId);
    const opaque = resolveOpaqueAlpha(creature.opaqueAlpha, kindId);

    let pixelsFixed = 0;
    if (!dryRun) {
        const processScript = path.join(ROOT, 'bin', 'process_sprites.py');
        if (!fs.existsSync(processScript)) {
            throw new Error('process_sprites.py not found');
        }
        const fr = spawnSync(
            'python3',
            [processScript, '--fix-green-file', originalAbs],
            { encoding: 'utf8', cwd: ROOT }
        );
        if (fr.error) throw fr.error;
        if (fr.status !== 0) {
            const msg = (fr.stderr || fr.stdout || '').trim();
            throw new Error(`fix-green failed: ${msg || `exit ${fr.status}`}`);
        }
        const match = String(fr.stdout || '').match(/(\d+)\s+pixel/);
        if (match) pixelsFixed = parseInt(match[1], 10) || 0;

        reprocessStem(paths.original, stem, {
            opaqueAlpha: opaque,
            kind: kindId
        });
    }

    return {
        ok: true,
        action: 'fix_green',
        genre: genreId,
        kind: kindId,
        id: creatureId,
        technical: creature.technical,
        stem,
        pixelsFixed,
        opaqueAlpha: opaque,
        original: repoPath(
            'assets',
            'sprites',
            paths.genre.folder,
            kind.folder,
            'original',
            `${stem}.png`
        ),
        dryRun
    };
}

/**
 * Genre summary for the asset manager sidebar (optionally filtered by kind).
 * @param {{ kind?: string }} [options]
 */
function listGenresSummary(options = {}) {
    const kindId = options.kind || DEFAULT_KIND;
    /** @type {object[]} */
    const genres = [];
    for (const id of Object.keys(GENRES)) {
        const catalog = loadCatalog(id, { kind: kindId });
        const paths = genrePaths(id, kindId);
        let withOriginal = 0;
        for (const c of catalog.creatures || []) {
            const stem = resolveStem(c, paths);
            if (stem && existingPng(paths.original, stem)) withOriginal += 1;
        }
        genres.push({
            id,
            label: GENRES[id].label,
            kind: kindId,
            total: (catalog.creatures || []).length,
            withOriginal,
            updatedAt: catalog.updatedAt
        });
    }
    return { genres, kind: kindId, kinds: listKindIds() };
}

module.exports = {
    ALL_VARIANT_NAMES,
    listCreaturesEnriched,
    listGenresSummary,
    removeCreature,
    renameCreature,
    flipCreatureHorizontal,
    replaceCreatureOriginal,
    setOpaqueAlpha,
    reprocessCreature,
    fixGreenCreature,
    findImageMagick,
    resolveStem,
    reprocessStem,
    assertTechnicalName
};
