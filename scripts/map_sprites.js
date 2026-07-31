#!/usr/bin/env node
/**
 * Temporary customSprite mapper for standard (or any mode) combat presets.
 *
 * Picks art catalog stems when combat ids have no matching sprite under
 * assets/sprites/<genre>/{creatures,equipment}/.
 *
 *   node scripts/map_sprites.js
 *   node scripts/map_sprites.js --kind equipment
 *   node scripts/map_sprites.js --kind creatures
 *   node scripts/map_sprites.js --kind all --mode standard --genre rpg_fantasy
 *   node scripts/map_sprites.js --dry-run
 *
 * Creatures → writes `customSprite` on each presets/<mode>/creatures/*.json
 * Equipment → writes `customSprite` on each item in presets/<mode>/equipment.json
 *   (UI resolves customSprite || spriteId || id)
 *
 * Only **native** combat ids are skipped (id already exists in the art catalog,
 * e.g. cave_rat → cave_rat with customSprite left as-is, typically equal to id).
 * Everything else is re-resolved every run so that as the catalog grows,
 * keyword hits improve and hash fallbacks spread across more stems — fewer
 * repeated sprites over time.
 *
 * Matching order (equipment) for ids without a native catalog sprite:
 *   1. Keyword in item id → preferred catalog stem
 *   2. Same/aliased category pool (deterministic hash pick)
 *   3. Full catalog hash fallback
 *
 * Matching order (creatures): keyword map, then full catalog hash fallback.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Creature keyword → catalog stem (rpg_fantasy)
// ---------------------------------------------------------------------------
const CREATURE_KEYWORDS = {
    spider: 'glacier_spider_rager',
    gargoyle: 'rune_gargoyle',
    goblin: 'vampiric_goblin',
    ghoul: 'umbral_ghoul',
    dragon: 'wild_desert_dragon',
    troll: 'chaos_troll_captain',
    wolf: 'storm_wolf_rager',
    wyrm: 'warp_crypt_wyrm',
    vampire: 'hellfire_vampire_archer',
    chimera: 'astral_chimera',
    cyclops: 'obsidian_cyclops',
    dwarf: 'obsidian_dwarf_warden',
    elf: 'phantom_elf_raider',
    gorgon: 'lava_gorgon',
    medusa: 'lava_gorgon',
    leviathan: 'ember_leviathan',
    minotaur: 'lunar_minotaur_vanguard',
    orc: 'sun_orc_guard',
    panther: 'grave_ruins_panther_vanguard',
    phoenix: 'lava_phoenix_assassin',
    scorpion: 'venomous_ocean_scorpion_ravager',
    sphinx: 'dark_sphinx_scout',
    tiger: 'nether_tiger',
    lion: 'nether_tiger',
    triton: 'chaos_triton_assassin',
    basilisk: 'plague_basilisk',
    bear: 'ethereal_storm_bear',
    behemoth: 'blood_behemoth',
    bug: 'rune_stone_bugbear',
    beetle: 'rune_stone_bugbear',
    demon: 'mist_demon_priest',
    devil: 'ember_jungle_devil',
    drake: 'sanguine_crypt_drake_vanguard',
    elemental: 'arcane_elemental_vanguard',
    fiend: 'celestial_fiend',
    giant: 'radiant_fire_giant_priest',
    golem: 'solar_volcano_golem_slayer',
    harpy: 'magma_harpy',
    horror: 'ember_ruins_horror',
    lizard: 'crystal_lizard_warrior',
    necromancer: 'infernal_merrow_necromancer',
    ogre: 'ember_ogre_ravager',
    phantom: 'glacier_mountain_phantom',
    ghost: 'glacier_mountain_phantom',
    priest: 'crystal_demon_priest',
    revenant: 'chaos_stone_revenant_archer',
    serpent: 'tempest_serpent_berserker',
    snake: 'tempest_serpent_berserker',
    skeleton: 'skeletal_hill_giant',
    stalker: 'twilight_desert_stalker',
    wight: 'skeletal_crypt_wight_overlord',
    zombie: 'umbral_ghoul',
    crawler: 'brimstone_ruins_crawler',
    rat: 'brimstone_ruins_crawler',
    rotworm: 'brimstone_ruins_crawler',
    worm: 'brimstone_ruins_crawler',
    amazon: 'radiant_desert_elf_champion',
    valkyrie: 'radiant_desert_elf_champion',
    witch: 'infernal_merrow_necromancer',
    warlock: 'iron_viper_warlock',
    cat: 'nether_tiger',
    dog: 'storm_wolf_rager',
    hound: 'storm_wolf_rager',
    assassin: 'chaos_triton_assassin',
    knight: 'crystal_fungal_knight_berserker',
    guard: 'sun_orc_guard',
    hunter: 'feral_ice_spider_hunter',
    mage: 'arcane_elemental_vanguard',
    shaman: 'magma_cloud_giant_shaman',
    cultist: 'hellfire_kobold_cultist',
    cult: 'hellfire_kobold_cultist',
    pirate: 'chaos_triton_assassin',
    bandit: 'chaos_triton_assassin',
    nomad: 'radiant_desert_elf_champion',
    mutated: 'ashen_goblin_devourer',
    slime: 'ashen_goblin_devourer',
    blob: 'ashen_goblin_devourer',
    bog: 'ashen_goblin_devourer',
    frog: 'ashen_goblin_devourer',
    toad: 'ashen_goblin_devourer',
    tortoise: 'crystal_lizard_warrior',
    turtle: 'crystal_lizard_warrior',
    crab: 'venomous_ocean_scorpion_ravager',
    fish: 'venomous_triton_devourer',
    water: 'venomous_triton_devourer',
    sea: 'venomous_triton_devourer',
    bird: 'magma_harpy',
    chicken: 'magma_harpy',
    penguin: 'magma_harpy',
    bat: 'storm_catacomb_devil_vanguard',
    wasp: 'rune_stone_bugbear',
    bee: 'rune_stone_bugbear',
    insect: 'rune_stone_bugbear',
    centipede: 'rune_stone_bugbear',
    scarab: 'rune_stone_bugbear',
    larva: 'brimstone_ruins_crawler',
    pig: 'ember_ogre_ravager',
    boar: 'ember_ogre_ravager',
    deer: 'ethereal_storm_bear',
    horse: 'ethereal_storm_bear',
    cow: 'lunar_minotaur_vanguard',
    bull: 'lunar_minotaur_vanguard',
    sheep: 'ethereal_storm_bear',
    plant: 'glacier_forest_construct',
    tree: 'glacier_forest_construct',
    flower: 'glacier_forest_construct',
    stone: 'chaos_stone_revenant_archer',
    rock: 'chaos_stone_revenant_archer',
    earth: 'chaos_stone_revenant_archer',
    fire: 'radiant_fire_giant_priest',
    ice: 'glacier_mountain_phantom',
    energy: 'arcane_elemental_vanguard',
    light: 'celestial_fiend',
    dark: 'umbral_ghoul',
    shadow: 'umbral_ghoul',
    death: 'skeletal_hill_giant',
    holy: 'celestial_fiend',
    devourer: 'ashen_goblin_devourer',
    titan: 'blood_behemoth',
    pharaoh: 'chaos_stone_revenant_archer',
    mummy: 'warp_tomb_drake',
    bone: 'skeletal_hill_giant',
    beast: 'ethereal_storm_bear',
    djinn: 'mist_demon_priest',
    gladiator: 'crystal_lizard_warrior',
    spectre: 'glacier_mountain_phantom',
    brother: 'crystal_demon_priest',
    brain: 'twilight_chimera_slayer',
    book: 'glacier_forest_construct',
    lord: 'ember_ogre_ravager',
    adventurer: 'phantom_elf_raider',
    barbarian: 'phantom_hill_giant',
    blood: 'blood_behemoth',
    brood: 'rune_stone_bugbear',
    bunny: 'storm_wolf_rager',
    cobra: 'tempest_serpent_berserker',
    hydra: 'sanguine_crypt_drake_vanguard',
    machine: 'cursed_automaton',
    strider: 'twilight_desert_stalker',
    spawn: 'ashen_goblin_devourer',
    soul: 'glacier_mountain_phantom',
    spirit: 'glacier_mountain_phantom',
    tomb: 'warp_tomb_drake',
    warrior: 'sun_orc_guard',
    wrath: 'storm_catacomb_devil_vanguard',
    eye: 'celestial_fiend',
    fairy: 'magma_harpy',
    fury: 'storm_catacomb_devil_vanguard',
    magic: 'arcane_elemental_vanguard',
    sorcerer: 'infernal_merrow_necromancer',
    mutant: 'ashen_goblin_devourer',
    abomination: 'dread_abomination',
    corrupt: 'ashen_goblin_devourer',
    gloom: 'umbral_ghoul'
};

// Equipment id keywords → preferred catalog stem (when present in catalog).
// Longer keys are checked first so "crossbow" wins over "bow".
const EQUIPMENT_KEYWORDS = {
    crossbow: 'ancient_javelin',
    longsword: 'ancient_broadsword',
    broadsword: 'ancient_broadsword',
    shortsword: 'blessed_katana',
    sword: 'ancient_broadsword',
    saber: 'arcane_obsidian_saber',
    katana: 'blessed_katana',
    cleaver: 'arcane_obsidian_cleaver',
    tomahawk: 'blessed_tomahawk',
    double_axe: 'ancient_double_axe',
    axe: 'ancient_double_axe',
    morning_star: 'radiant_morning_star',
    mace: 'steel_club',
    club: 'steel_club',
    cudgel: 'weathered_cudgel',
    hammer: 'steel_club',
    staff: 'weathered_staff',
    rod: 'royal_arcane_rod',
    wand: 'royal_arcane_rod',
    spellbook: 'weathered_quarterstaff',
    book: 'weathered_quarterstaff',
    javelin: 'ancient_javelin',
    spear: 'ancient_javelin',
    lance: 'arcane_bone_poleaxe',
    poleaxe: 'arcane_bone_poleaxe',
    billhook: 'bloodied_iron_billhook',
    bow: 'ancient_javelin',
    arrow: 'ancient_javelin',
    bolt: 'ancient_javelin',
    quiver: 'ancient_javelin',
    ammo: 'ancient_javelin',
    shield: 'ancient_wall_shield',
    pavise: 'arcane_bronze_pavise',
    scutum: 'bloodied_iron_scutum',
    helmet: 'ancient_mask',
    helm: 'arcane_leather_visored_helm',
    barbute: 'bloodied_iron_barbute',
    mask: 'ancient_mask',
    hood: 'ancient_mask',
    hat: 'ancient_mask',
    armor: 'ancient_scale_mail',
    plate: 'arcane_bronze_cuirass',
    cuirass: 'arcane_bronze_cuirass',
    mail: 'ancient_scale_mail',
    vest: 'bloodied_iron_vest',
    robe: 'ancient_scale_mail',
    legs: 'ancient_chausses',
    greaves: 'ancient_chausses',
    chausses: 'ancient_chausses',
    trousers: 'ancient_trousers',
    pants: 'ancient_trousers',
    boots: 'ancient_stompers',
    stompers: 'ancient_stompers',
    shoes: 'arcane_steel_war_boots',
    sandals: 'bloodied_leather_plate_boots',
    ring: 'ancient_seal_ring',
    amulet: 'wicked_crystal_charm',
    necklace: 'wicked_crystal_charm',
    charm: 'wicked_crystal_charm',
    backpack: 'ancient_wall_shield',
    bag: 'ancient_wall_shield',
    container: 'ancient_wall_shield',
    torch: 'royal_arcane_rod',
    light: 'royal_arcane_rod',
    fist: 'weathered_cudgel'
};

/**
 * Combat equipment category → art catalog category (when different / missing art).
 * Catalog has: sword, axe, spear, club, wand, staff, shield, helmet, armor,
 * legs, boots, ring, amulet.
 */
const EQUIPMENT_CATEGORY_ALIAS = {
    sword: 'sword',
    axe: 'axe',
    club: 'club',
    mace: 'club',
    dagger: 'sword',
    fist: 'club',
    spear: 'spear',
    bow: 'spear',
    crossbow: 'spear',
    ammo: 'spear',
    quiver: 'spear',
    wand: 'wand',
    staff: 'staff',
    spellbook: 'staff',
    shield: 'shield',
    helmet: 'helmet',
    armor: 'armor',
    legs: 'legs',
    boots: 'boots',
    ring: 'ring',
    amulet: 'amulet',
    // no dedicated backpack/light art yet — borrow neutral props
    container: 'shield',
    light: 'wand'
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        kind: 'all', // creatures | equipment | all
        mode: 'standard',
        genre: 'rpg_fantasy',
        dryRun: false,
        quiet: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--force') {
            // Kept for CLI compatibility; non-natives are always re-resolved.
        } else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--kind' && argv[i + 1]) opts.kind = String(argv[++i]).toLowerCase();
        else if (a === '--mode' && argv[i + 1]) opts.mode = String(argv[++i]);
        else if (a === '--genre' && argv[i + 1]) opts.genre = String(argv[++i]);
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node scripts/map_sprites.js [options]

Temporary customSprite assignment from art catalog.

  --kind creatures|equipment|all   What to update (default: all)
  --mode <mode>                    presets/<mode>/… (default: standard)
  --genre <genre>                  Art catalog genre (default: rpg_fantasy)
  --dry-run                        Report only (no writes)
  --quiet                          Less logging

Only native catalog ids are skipped (customSprite is left untouched).
All other combat ids are re-mapped each run as the catalog grows.
`);
            process.exit(0);
        } else {
            console.error(`Unknown arg: ${a} (try --help)`);
            process.exit(1);
        }
    }
    if (!['creatures', 'equipment', 'all'].includes(opts.kind)) {
        console.error(`Invalid --kind ${opts.kind}`);
        process.exit(1);
    }
    return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stableHash(str) {
    let hash = 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        hash = s.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(hash);
}

function pickByHash(id, pool) {
    if (!pool || pool.length === 0) return null;
    return pool[stableHash(id) % pool.length];
}

/** Prefer longer keywords so "crossbow" matches before "bow". */
function matchKeyword(id, keywordsMap) {
    const target = String(id || '').toLowerCase();
    const keys = Object.keys(keywordsMap).sort((a, b) => b.length - a.length);
    for (const key of keys) {
        if (target.includes(key)) {
            return { keyword: key, spriteId: keywordsMap[key] };
        }
    }
    return null;
}

function loadCatalogIds(genre, kind) {
    const file = path.join(ROOT, 'assets', 'data', genre, `${kind}.json`);
    if (!fs.existsSync(file)) {
        throw new Error(`Missing catalog ${file}`);
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (kind === 'creatures') {
        const list = Array.isArray(data.creatures) ? data.creatures : [];
        return {
            ids: list.map((c) => c.id).filter(Boolean),
            byCategory: null,
            idSet: new Set(list.map((c) => c.id).filter(Boolean))
        };
    }
    const list = Array.isArray(data.items) ? data.items : [];
    const byCategory = {};
    const ids = [];
    for (const item of list) {
        if (!item || !item.id) continue;
        ids.push(item.id);
        const cat = String(item.category || 'unknown');
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(item.id);
    }
    return { ids, byCategory, idSet: new Set(ids) };
}

function resolveEquipmentSprite(item, catalog) {
    const id = String(item.id || '');
    const idSet = catalog.idSet;

    // Caller skips when id is already a catalog sprite; remaining are mappings.

    // 1) Keyword preference (only if stem still exists in catalog)
    const kw = matchKeyword(id, EQUIPMENT_KEYWORDS);
    if (kw && idSet.has(kw.spriteId)) {
        return { spriteId: kw.spriteId, via: 'keyword', keyword: kw.keyword };
    }

    // 2) Category pool (with alias)
    const combatCat = String(item.category || '').toLowerCase();
    const artCat = EQUIPMENT_CATEGORY_ALIAS[combatCat] || combatCat;
    const pool = catalog.byCategory[artCat];
    if (pool && pool.length) {
        const spriteId = pickByHash(id, pool);
        return { spriteId, via: 'category', category: artCat };
    }

    // 3) Slot-based soft fallback (when category missing)
    const slot = String(item.slot || '').toLowerCase();
    const slotToCat = {
        righthand: null, // need weaponType
        lefthand: 'shield',
        armor: 'armor',
        helmet: 'helmet',
        legs: 'legs',
        boots: 'boots',
        ring: 'ring',
        amulet: 'amulet',
        backpack: 'shield',
        ammunition: 'spear'
    };
    let slotCat = slotToCat[slot];
    if (slot === 'righthand') {
        const wt = String(item.weaponType || '').toLowerCase();
        if (wt === 'magic') slotCat = 'wand';
        else if (wt === 'distance') slotCat = 'spear';
        else if (wt === 'shield') slotCat = 'shield';
        else slotCat = 'sword';
    }
    if (slotCat && catalog.byCategory[slotCat] && catalog.byCategory[slotCat].length) {
        const spriteId = pickByHash(id, catalog.byCategory[slotCat]);
        return { spriteId, via: 'slot', category: slotCat };
    }

    // 4) Full catalog hash
    const spriteId = pickByHash(id, catalog.ids);
    return { spriteId, via: 'fallback' };
}

function resolveCreatureSprite(id, catalog, keywordsMap) {
    // Caller skips when id is already a catalog sprite; remaining are mappings.
    const kw = matchKeyword(id, keywordsMap);
    if (kw && catalog.idSet.has(kw.spriteId)) {
        return { spriteId: kw.spriteId, via: 'keyword', keyword: kw.keyword };
    }
    if (kw && !catalog.idSet.has(kw.spriteId)) {
        // keyword target missing from this genre catalog — fall through
    }
    const spriteId = pickByHash(id, catalog.ids);
    return { spriteId, via: 'fallback' };
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function mapCreatures(opts, catalog) {
    const dir = path.join(ROOT, 'presets', opts.mode, 'creatures');
    if (!fs.existsSync(dir)) {
        throw new Error(`Missing creatures dir ${dir}`);
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const stats = { total: 0, updated: 0, skipped: 0, native: 0, unchanged: 0, via: {} };

    for (const file of files) {
        const filePath = path.join(dir, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const id = data.id || path.basename(file, '.json');
        stats.total++;

        // Native 1:1 art — leave customSprite alone (often customSprite === id).
        if (catalog.idSet.has(String(id))) {
            stats.native++;
            stats.skipped++;
            continue;
        }

        const resolved = resolveCreatureSprite(id, catalog, CREATURE_KEYWORDS);
        if (!resolved.spriteId) {
            stats.skipped++;
            continue;
        }

        stats.via[resolved.via] = (stats.via[resolved.via] || 0) + 1;
        if (String(data.customSprite || '') === resolved.spriteId) {
            stats.unchanged++;
            continue;
        }

        data.customSprite = resolved.spriteId;
        stats.updated++;

        if (!opts.dryRun) {
            fs.writeFileSync(filePath, formatJson(data), 'utf8');
        }
    }
    return stats;
}

function mapEquipment(opts, catalog) {
    const filePath = path.join(ROOT, 'presets', opts.mode, 'equipment.json');
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing equipment file ${filePath}`);
    }
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const items = Array.isArray(doc.items) ? doc.items : [];
    const stats = { total: 0, updated: 0, skipped: 0, native: 0, unchanged: 0, via: {} };

    for (const item of items) {
        if (!item || item.id == null) continue;
        stats.total++;

        // Native 1:1 art — leave customSprite/spriteId alone.
        if (catalog.idSet.has(String(item.id))) {
            stats.native++;
            stats.skipped++;
            continue;
        }

        const resolved = resolveEquipmentSprite(item, catalog);
        if (!resolved.spriteId) {
            stats.skipped++;
            continue;
        }

        stats.via[resolved.via] = (stats.via[resolved.via] || 0) + 1;
        const sameCustom = String(item.customSprite || '') === resolved.spriteId;
        const sameSpriteId = String(item.spriteId || '') === resolved.spriteId;
        if (sameCustom && sameSpriteId) {
            stats.unchanged++;
            continue;
        }

        item.customSprite = resolved.spriteId;
        // Keep spriteId in sync — equipment_picker historically reads spriteId.
        item.spriteId = resolved.spriteId;
        stats.updated++;
    }

    if (!opts.dryRun && stats.updated > 0) {
        fs.writeFileSync(filePath, formatJson(doc), 'utf8');
    }
    return stats;
}

function printStats(label, stats, opts) {
    if (opts.quiet) return;
    const viaParts = Object.keys(stats.via)
        .sort()
        .map((k) => `${k}=${stats.via[k]}`)
        .join(', ');
    console.log(
        `${label}: total=${stats.total} updated=${stats.updated}` +
            (stats.unchanged ? ` unchanged=${stats.unchanged}` : '') +
            (stats.skipped ? ` skipped=${stats.skipped}` : '') +
            (stats.native ? ` native=${stats.native}` : '') +
            (viaParts ? ` (${viaParts})` : '')
    );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.quiet) {
        console.log(
            `map_sprites mode=${opts.mode} genre=${opts.genre} kind=${opts.kind}` +
                (opts.dryRun ? ' dry-run' : '')
        );
    }

    if (opts.kind === 'creatures' || opts.kind === 'all') {
        const catalog = loadCatalogIds(opts.genre, 'creatures');
        if (!catalog.ids.length) throw new Error('Creature catalog is empty');
        const stats = mapCreatures(opts, catalog);
        printStats('creatures', stats, opts);
    }

    if (opts.kind === 'equipment' || opts.kind === 'all') {
        const catalog = loadCatalogIds(opts.genre, 'equipment');
        if (!catalog.ids.length) throw new Error('Equipment catalog is empty');
        const stats = mapEquipment(opts, catalog);
        printStats('equipment', stats, opts);
    }

    if (opts.dryRun && !opts.quiet) {
        console.log('dry-run: no files written');
    }
}

main();
