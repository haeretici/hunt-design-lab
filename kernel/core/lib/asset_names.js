/**
 * Multi-kind asset name generator (equipment, tiles, scenario objects).
 * Creature names stay in creature_names.js; this module dispatches by kind.
 *
 * Output shape matches creature names:
 *   { technical, alias, genre, kind, category? }
 */

'use strict';

const {
    generateNames: generateCreatureNames,
    parseDoneList,
    findRestricted,
    mulberry32,
    RESTRICTED_TERMS
} = require('./creature_names.js');
const {
    ASSET_KINDS,
    DEFAULT_KIND,
    getAssetKind,
    GENRES
} = require('../../settings.js');
const { generateWangFamilyRoster, WANG_MASK_COUNT } = require('./overlay_wang.js');
const { generateWallFamilyRoster, WALL_ALIGN_COUNT } = require('./wall_wang.js');

// ---------------------------------------------------------------------------
// Shared helpers (mirror creature_names patterns)
// ---------------------------------------------------------------------------

/**
 * @param {() => number} rng
 * @param {string[]} arr
 */
function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
}

/**
 * @param {string} s
 */
function cleanPhrase(s) {
    return String(s).replace(/\s+/g, ' ').trim();
}

/**
 * Prefer short aliases: drop leading adjective when 3+ words.
 * @param {string} technical
 * @param {string} [core]
 */
function shortAlias(technical, core) {
    if (core && core.length >= 2 && core.length < technical.length) {
        return cleanPhrase(core);
    }
    const words = technical.split(/\s+/).filter(Boolean);
    if (words.length <= 2) return words.join(' ');
    return words.slice(1).join(' ');
}

/**
 * Cap a phrase to at most n words (generation length guard).
 * @param {string} s
 * @param {number} n
 */
function wordsCap(s, n) {
    return s.split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}

// ---------------------------------------------------------------------------
// Equipment banks (classic tile-RPG slots + common weapons)
// Genre-agnostic cores; adjectives carry theme flavor via genre banks below.
// Target: enough cores + alias ladder so a default batch of 16 per category works.
// ---------------------------------------------------------------------------

/** @type {Record<string, { cores: string[], materials: string[] }>} */
const EQUIPMENT_CATEGORIES = {
    sword: {
        cores: [
            'Longsword', 'Shortsword', 'Claymore', 'Scimitar', 'Rapier', 'Broadsword',
            'Falchion', 'Saber', 'Greatsword', 'Cutlass', 'Blade', 'Katana'
        ],
        materials: [
            'Iron', 'Steel', 'Bronze', 'Obsidian', 'Crystal', 'Bone', 'Silver', 'Gold',
            'Rune', 'Shadow', 'Ember', 'Frost', 'Jade', 'Adamantine', 'Orichalcum'
        ]
    },
    axe: {
        cores: [
            'Battle Axe', 'Hand Axe', 'War Axe', 'Hatchet', 'Double Axe', 'Cleaver',
            'Throwing Axe', 'Greataxe', 'Tomahawk', 'Bearded Axe', 'Pickaxe', 'Wood Axe'
        ],
        materials: [
            'Iron', 'Steel', 'Bronze', 'Obsidian', 'Bone', 'Stone', 'Ember', 'Jade',
            'Rune', 'Shadow', 'Crystal', 'Silver'
        ]
    },
    club: {
        cores: [
            'Club', 'Mace', 'Warhammer', 'Morning Star', 'Flail', 'Cudgel',
            'Spiked Club', 'Maul', 'Staff Club', 'Bludgeon', 'War Club', 'Knobbed Club'
        ],
        materials: [
            'Oak', 'Iron', 'Bone', 'Stone', 'Steel', 'Spiked', 'Crystal', 'Rune',
            'Ember', 'Shadow'
        ]
    },
    mace: {
        cores: [
            'Mace', 'War Mace', 'Flanged Mace', 'Morning Star', 'Scepter', 'Maul',
            'War Pick', 'Pernach', 'Spiked Mace', 'Heavy Mace', 'Ceremonial Mace', 'Bludgeon'
        ],
        materials: [
            'Iron', 'Steel', 'Gold', 'Silver', 'Rune', 'Crystal', 'Obsidian', 'Bone',
            'Bronze', 'Ember'
        ]
    },
    dagger: {
        cores: [
            'Dagger', 'Dirk', 'Stiletto', 'Kris', 'Knife', 'Throwing Knife', 'Shiv',
            'Poniard', 'Rondel', 'Tanto', 'Parrying Dagger', 'Boot Knife'
        ],
        materials: [
            'Iron', 'Steel', 'Bone', 'Obsidian', 'Crystal', 'Shadow', 'Poison', 'Silver',
            'Bronze', 'Jade'
        ]
    },
    spear: {
        cores: [
            'Spear', 'Pike', 'Halberd', 'Lance', 'Trident', 'Javelin', 'Glaive', 'Poleaxe',
            'Partisan', 'Billhook', 'Boar Spear', 'War Spear'
        ],
        materials: [
            'Iron', 'Steel', 'Bone', 'Crystal', 'Rune', 'Bronze', 'Obsidian', 'Shadow'
        ]
    },
    bow: {
        cores: [
            'Longbow', 'Shortbow', 'Recurve Bow', 'War Bow', 'Hunting Bow', 'Composite Bow',
            'Flatbow', 'Horse Bow', 'Self Bow', 'Horn Bow', 'Greatbow', 'Skirmish Bow'
        ],
        materials: [
            'Oak', 'Yew', 'Bone', 'Crystal', 'Rune', 'Shadow', 'Ember', 'Elven', 'Horn', 'Steel'
        ]
    },
    crossbow: {
        cores: [
            'Crossbow', 'Heavy Crossbow', 'Hand Crossbow', 'Arbalest', 'Repeater Crossbow',
            'Light Crossbow', 'Siege Crossbow', 'Pistol Crossbow', 'War Crossbow', 'Sniper Crossbow'
        ],
        materials: [
            'Iron', 'Steel', 'Oak', 'Brass', 'Rune', 'Crystal', 'Bone', 'Shadow'
        ]
    },
    staff: {
        cores: [
            'Staff', 'Quarterstaff', 'Battle Staff', 'Crystal Staff', 'Runestaff', 'Crook',
            'Walking Staff', 'War Staff', 'Branch Staff', 'Ironshod Staff', 'Focus Staff', 'Long Staff'
        ],
        materials: [
            'Oak', 'Crystal', 'Bone', 'Rune', 'Obsidian', 'Jade', 'Shadow', 'Ember', 'Yew', 'Iron'
        ]
    },
    wand: {
        cores: [
            'Wand', 'Rod', 'Scepter', 'Focus Wand', 'Spark Wand', 'Arcane Rod',
            'Channeling Rod', 'Bone Wand', 'Crystal Wand', 'Flame Wand', 'Frost Wand', 'Bolt Rod'
        ],
        materials: [
            'Crystal', 'Bone', 'Gold', 'Silver', 'Rune', 'Jade', 'Shadow', 'Ember', 'Ivory', 'Obsidian'
        ]
    },
    shield: {
        cores: [
            'Shield', 'Buckler', 'Tower Shield', 'Kite Shield', 'Round Shield',
            'Heater Shield', 'Wall Shield', 'Targe', 'Pavise', 'Aspis', 'Scutum',
            'Parma', 'Guard Shield', 'War Shield'
        ],
        materials: [
            'Iron', 'Steel', 'Wooden', 'Bronze', 'Crystal', 'Rune', 'Bone', 'Obsidian',
            'Spiked', 'Ember', 'Frost', 'Jade', 'Silver'
        ]
    },
    helmet: {
        cores: [
            'Helmet', 'Helm', 'Crown', 'Hood', 'Circlet', 'Mask', 'Great Helm',
            'Visored Helm', 'Cap', 'Barbute', 'Coif', 'War Mask'
        ],
        materials: [
            'Iron', 'Steel', 'Leather', 'Bronze', 'Crystal', 'Rune', 'Bone', 'Scale',
            'Plate', 'Shadow'
        ]
    },
    armor: {
        cores: [
            'Armor', 'Breastplate', 'Chainmail', 'Plate Armor', 'Scale Mail',
            'Cuirass', 'Robe', 'Vest', 'Hauberk', 'Tunic'
        ],
        materials: [
            'Iron', 'Steel', 'Leather', 'Bronze', 'Crystal', 'Rune', 'Scale', 'Plate',
            'Shadow', 'Ember', 'Frost', 'Jade'
        ]
    },
    legs: {
        // Prefer pants/leggings wording so names do not read as boots/footwear.
        cores: [
            'Pants', 'Leggings', 'Greaves', 'Cuisses', 'Chausses', 'Trousers',
            'Plate Pants', 'Scale Pants', 'Cloth Pants', 'War Greaves', 'Leg Wraps', 'Scale Leggings'
        ],
        materials: [
            'Iron', 'Steel', 'Leather', 'Bronze', 'Scale', 'Plate', 'Cloth', 'Shadow', 'Rune', 'Jade'
        ]
    },
    boots: {
        // Greaves are shin/leg armor (legs slot), not footwear.
        cores: [
            'Boots', 'Sabatons', 'Shoes', 'Sandals', 'Treads', 'Stompers',
            'Footwraps', 'War Boots', 'Hiking Boots', 'Plate Boots', 'Soft Boots', 'Heavy Boots'
        ],
        materials: [
            'Leather', 'Iron', 'Steel', 'Scale', 'Plate', 'Soft', 'Heavy', 'Winged', 'Shadow', 'Rune'
        ]
    },
    ring: {
        cores: [
            'Ring', 'Band', 'Signet', 'Loop', 'Circle', 'Seal Ring', 'Coil Ring',
            'Gem Ring', 'Twisted Ring', 'Plain Ring', 'Claw Ring', 'Spike Ring'
        ],
        materials: [
            'Gold', 'Silver', 'Iron', 'Bone', 'Crystal', 'Jade', 'Ruby', 'Sapphire',
            'Obsidian', 'Rune', 'Shadow', 'Bronze'
        ]
    },
    amulet: {
        cores: [
            'Amulet', 'Necklace', 'Pendant', 'Talisman', 'Medallion', 'Charm', 'Locket',
            'Torc', 'Collar', 'Relic Pendant', 'Bead Amulet', 'Icon Amulet'
        ],
        materials: [
            'Gold', 'Silver', 'Bone', 'Crystal', 'Jade', 'Obsidian', 'Rune', 'Shadow',
            'Ember', 'Pearl', 'Bronze', 'Ivory'
        ]
    },
    // Combat inventory categories present in standard presets (smart update / batch).
    ammo: {
        cores: [
            'Arrow', 'Bolt', 'Dart', 'Quarrel', 'Needle', 'Spike', 'Shot', 'Missile',
            'Hunting Arrow', 'War Bolt', 'Throwing Star', 'Javelin Tip'
        ],
        materials: [
            'Iron', 'Steel', 'Bone', 'Crystal', 'Obsidian', 'Silver', 'Poison', 'Flame',
            'Frost', 'Shadow', 'Rune', 'Jade'
        ]
    },
    quiver: {
        cores: [
            'Quiver', 'Bolt Case', 'Arrow Case', 'Bolt Quiver', 'Arrow Pouch',
            'Shaft Quiver', 'War Quiver', 'Hunter Quiver', 'Bandolier', 'Shaft Case'
        ],
        materials: [
            'Leather', 'Hide', 'Studded', 'Silk', 'Scale', 'Rune', 'Shadow', 'Ember',
            'Crystal', 'Bone'
        ]
    },
    fist: {
        cores: [
            'Claws', 'Katar', 'Knuckles', 'Sai', 'Cestus', 'Fist Blade', 'War Claws',
            'Spiked Gauntlet', 'Hand Blade', 'Tiger Claws', 'Knuckle Duster', 'Jo Staff'
        ],
        materials: [
            'Iron', 'Steel', 'Bone', 'Obsidian', 'Crystal', 'Shadow', 'Rune', 'Jade',
            'Bronze', 'Ember'
        ]
    },
    spellbook: {
        cores: [
            'Spellbook', 'Tome', 'Grimoire', 'Folio', 'Codex', 'Primer', 'Manual',
            'Lexicon', 'Compendium', 'Scroll Book', 'Arcane Tome', 'War Codex'
        ],
        materials: [
            'Leather', 'Bone', 'Crystal', 'Rune', 'Shadow', 'Ember', 'Jade', 'Obsidian',
            'Gold', 'Ivory'
        ]
    },
    light: {
        cores: [
            'Torch', 'Lamp', 'Lantern', 'Candle', 'Orb', 'Flare', 'Brazier', 'Glowstone',
            'Oil Lamp', 'Crystal Lamp', 'Flame Brand', 'Light Sphere'
        ],
        materials: [
            'Iron', 'Brass', 'Bone', 'Crystal', 'Rune', 'Shadow', 'Ember', 'Jade',
            'Silver', 'Obsidian'
        ]
    },
    container: {
        cores: [
            'Bag', 'Pack', 'Satchel', 'Pouch', 'Chest', 'Case', 'Crate', 'Sack',
            'Backpack', 'Haversack', 'Trunk', 'Coffer'
        ],
        materials: [
            'Leather', 'Hide', 'Wooden', 'Iron', 'Studded', 'Silk', 'Bone', 'Rune',
            'Shadow', 'Crystal'
        ]
    }
};

/** Genre-flavored adjectives for equipment (avoid franchise terms). */
const EQUIPMENT_ADJECTIVES = {
    rpg_fantasy: [
        'Ancient', 'Arcane', 'Blessed', 'Bloodied', 'Cursed', 'Enchanted', 'Gilded',
        'Holy', 'Infernal', 'Ornate', 'Radiant', 'Runic', 'Sacred', 'Shadowed',
        'Tempered', 'Venomous', 'Weathered', 'Wicked', 'Royal', 'Barbarian'
    ],
    fantastic_ecology: [
        'Blooming', 'Coral', 'Crystal', 'Fungal', 'Living', 'Mossy', 'Petal',
        'Prismatic', 'Rooted', 'Spore', 'Thorned', 'Verdant', 'Amber', 'Tidal'
    ],
    ultra_tech: [
        'Carbon', 'Chrome', 'Combat', 'Fusion', 'Ion', 'Nano', 'Plasma', 'Pulse',
        'Quantum', 'Tactical', 'Titanium', 'Void', 'Modular', 'Siege'
    ],
    space_creatures: [
        'Astral', 'Cosmic', 'Crystal', 'Nebula', 'Plasma', 'Stellar', 'Void',
        'Xeno', 'Ion', 'Lunar', 'Solar', 'Warp'
    ],
    steampunk: [
        'Brass', 'Bronze', 'Clockwork', 'Copper', 'Gilded', 'Gearwork', 'Riveted',
        'Steam', 'Windup', 'Aeronaut', 'Polished', 'Ornate'
    ],
    super_heroes: [
        'Bold', 'Chromatic', 'Cosmic', 'Mighty', 'Phantom', 'Radiant', 'Shadow',
        'Sonic', 'Stellar', 'Thunder', 'Vivid', 'Apex'
    ]
};

// ---------------------------------------------------------------------------
// Tile banks
// ---------------------------------------------------------------------------

/** @type {Record<string, string[]>} */
const TILE_CORES = {
    floor: [
        'Grass Floor', 'Dirt Floor', 'Stone Floor', 'Sand Floor', 'Wood Floor',
        'Cobble Floor', 'Marble Floor', 'Brick Floor', 'Snow Floor', 'Ash Floor',
        'Moss Floor', 'Crystal Floor', 'Metal Floor', 'Tile Floor', 'Mud Floor',
        'Leaf Floor', 'Bone Floor', 'Lava Rock Floor'
    ],
    wall: [
        'Stone Wall', 'Brick Wall', 'Wood Wall', 'Cave Wall', 'Metal Wall',
        'Crystal Wall', 'Ice Wall', 'Hedge Wall', 'Ruined Wall', 'Adobe Wall',
        'Plaster Wall', 'Force Wall', 'Hull Wall'
    ],
    water: [
        'Shallow Water', 'Deep Water', 'Shore Water', 'Swamp Water', 'Lava Pool',
        'Ice Sheet', 'Acid Pool', 'Crystal Pool', 'Oil Slick', 'Toxic Pool'
    ],
    path: [
        'Stone Path', 'Dirt Path', 'Wood Path', 'Brick Path', 'Sand Path',
        'Gravel Path', 'Metal Walkway', 'Bridge Deck', 'Carpet Path'
    ],
    special: [
        'Stone Stairs', 'Wood Stairs', 'Cave Stairs', 'Pit Edge', 'Hole Cover',
        'Bridge Tile', 'Door Threshold', 'Altar Floor', 'Portal Ring', 'Trap Floor'
    ]
};

const TILE_ADJECTIVES = {
    rpg_fantasy: [
        'Ancient', 'Cracked', 'Mossy', 'Weathered', 'Runic', 'Dark', 'Sunlit',
        'Damp', 'Overgrown', 'Polished', 'Broken', 'Sacred'
    ],
    fantastic_ecology: [
        'Blooming', 'Living', 'Spore', 'Coral', 'Verdant', 'Crystal', 'Rooted',
        'Tidal', 'Fungal', 'Luminous'
    ],
    ultra_tech: [
        'Polished', 'Grated', 'Hazard', 'Lit', 'Sealed', 'Industrial', 'Chrome',
        'Panelled', 'Glowing', 'Reinforced'
    ],
    space_creatures: [
        'Alien', 'Crystalline', 'Pitted', 'Bioluminescent', 'Meteor', 'Void',
        'Lunar', 'Iridized', 'Cosmic'
    ],
    steampunk: [
        'Riveted', 'Brass', 'Sooty', 'Cobblestone', 'Factory', 'Polished',
        'Gearmarked', 'Weathered', 'Dockside'
    ],
    super_heroes: [
        'City', 'Rooftop', 'Concrete', 'Night', 'Neon', 'Industrial', 'Alley',
        'Lab', 'Plaza', 'Skyline'
    ]
};

// ---------------------------------------------------------------------------
// Scenario object banks
// ---------------------------------------------------------------------------

/** @type {Record<string, string[]>} */
const OBJECT_CORES = {
    tree: [
        'Oak Tree', 'Pine Tree', 'Dead Tree', 'Willow Tree', 'Palm Tree',
        'Crystal Tree', 'Burned Tree', 'Fruit Tree', 'Giant Mushroom', 'Bush',
        'Hedge', 'Flower Patch', 'Cactus', 'Bamboo Stand'
    ],
    rock: [
        'Boulder', 'Rock Pile', 'Crystal Spire', 'Standing Stone', 'Ore Vein',
        'Stalagmite', 'Rubble', 'Cliff Rock', 'Meteor Rock', 'Bone Pile'
    ],
    house: [
        'Cottage', 'House', 'Hut', 'Cabin', 'Tower', 'Barn', 'Shop Front',
        'Ruined House', 'Temple Facade', 'Watchtower', 'Windmill', 'Shack'
    ],
    wall: [
        'Wall Segment', 'Fence', 'Gate', 'Palisade', 'Railing', 'Barricade',
        'Ruin Arch', 'Castle Wall Piece', 'Hedge Fence'
    ],
    door: [
        'Wooden Door', 'Iron Door', 'Gate Door', 'Trapdoor', 'Archway',
        'Portcullis', 'Hatch', 'Blast Door'
    ],
    furniture: [
        'Table', 'Chair', 'Bench', 'Bed', 'Throne', 'Desk', 'Bookshelf',
        'Anvil', 'Workbench', 'Altar', 'Lectern', 'Stool'
    ],
    container: [
        'Wooden Chest', 'Iron Chest', 'Barrel', 'Crate', 'Sack', 'Basket',
        'Urn', 'Coffin', 'Safe', 'Supply Box'
    ],
    deco: [
        'Torch Stand', 'Lantern Post', 'Statue', 'Fountain', 'Well', 'Signpost',
        'Campfire', 'Banner Pole', 'Gravestone', 'Pillar', 'Cage', 'Cart'
    ]
};

const OBJECT_ADJECTIVES = {
    rpg_fantasy: [
        'Ancient', 'Weathered', 'Ornate', 'Ruined', 'Mossy', 'Sturdy', 'Simple',
        'Enchanted', 'Abandoned', 'Village', 'Castle', 'Dark'
    ],
    fantastic_ecology: [
        'Living', 'Overgrown', 'Crystal', 'Blooming', 'Rootbound', 'Spore',
        'Coral', 'Amber', 'Verdant'
    ],
    ultra_tech: [
        'Modular', 'Industrial', 'Chrome', 'Sealed', 'Damaged', 'Glowing',
        'Reinforced', 'Portable', 'Lab'
    ],
    space_creatures: [
        'Alien', 'Crashed', 'Orbital', 'Crystal', 'Bio', 'Abandoned', 'Xeno',
        'Meteor', 'Habitat'
    ],
    steampunk: [
        'Brass', 'Riveted', 'Clockwork', 'Sooty', 'Workshop', 'Dockside',
        'Ornate', 'Gearworked', 'Steam'
    ],
    super_heroes: [
        'City', 'Rooftop', 'Abandoned', 'Industrial', 'Neon', 'Ruined',
        'Heroic', 'Villain', 'Plaza'
    ]
};

// ---------------------------------------------------------------------------
// UI banks
// ---------------------------------------------------------------------------

/** @type {Record<string, string[]>} */
const UI_CORES = {
    spells: [
        'Fireball Icon', 'Heal Icon', 'Shield Icon', 'Strike Icon', 'Blast Icon',
        'Aura Icon', 'Curse Icon', 'Blessing Icon', 'Bolt Icon', 'Nova Icon',
        'Ward Icon', 'Beam Icon'
    ]
};

const UI_ADJECTIVES = {
    rpg_fantasy: [
        'Arcane', 'Holy', 'Dark', 'Mystic', 'Divine', 'Corrupt', 'Radiant',
        'Shadow', 'Elemental', 'Ancient'
    ],
    fantastic_ecology: [
        'Nature', 'Storm', 'Tidal', 'Earth', 'Fungal', 'Crystal', 'Luminous',
        'Verdant', 'Solar', 'Lunar'
    ],
    ultra_tech: [
        'Cyber', 'Plasma', 'Ion', 'Laser', 'Quantum', 'Nano', 'Magnetic',
        'Sonic', 'EMP', 'Force'
    ],
    space_creatures: [
        'Cosmic', 'Void', 'Stellar', 'Astral', 'Nebula', 'Warp', 'Gravity',
        'Psyonic', 'Alien', 'Meteor'
    ],
    steampunk: [
        'Steam', 'Clockwork', 'Aether', 'Volt', 'Alchemical', 'Brass',
        'Galvanic', 'Pressure', 'Magnetic', 'Combustion'
    ],
    super_heroes: [
        'Heroic', 'Super', 'Power', 'Energy', 'Kinetic', 'Atomic', 'Vivid',
        'Dynamic', 'Smash', 'Blast'
    ]
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Equipment alias ladder (preferred short → more distinctive), mirroring
 * creature buildAliasCandidates so multi-word cores do not collapse a batch
 * to one alias per core (e.g. every kite shield → "Kite Shield").
 *
 * @param {{ adj: string|null, material: string|null, core: string, category: string }} parts
 * @returns {string[]}
 */
function buildEquipmentAliasCandidates(parts) {
    const adj = parts.adj || null;
    const material = parts.material || null;
    const core = parts.core;
    const category = parts.category || null;
    /** @type {string[]} */
    const out = [];
    const add = (s) => {
        const c = cleanPhrase(s);
        if (c && !out.includes(c)) out.push(c);
    };
    add(core);
    if (material) add(`${material} ${core}`);
    if (adj) add(`${adj} ${core}`);
    if (adj && material) add(wordsCap(`${adj} ${material} ${core}`, 4));
    if (category) add(`${core} ${category}`);
    if (material && category) add(`${material} ${core} ${category}`);
    if (adj && category) add(`${adj} ${core} ${category}`);
    return out;
}

/**
 * First unused alias on the ladder; preferred form if all collide.
 * @param {{ adj: string|null, material: string|null, core: string, category: string }} parts
 * @param {Set<string>} usedAlias
 * @returns {string}
 */
function pickEquipmentAlias(parts, usedAlias) {
    const candidates = buildEquipmentAliasCandidates(parts);
    for (const c of candidates) {
        if (!usedAlias.has(c)) return c;
    }
    return candidates[0] || cleanPhrase(parts.core);
}

/**
 * Conservative unique-alias / unique-technical ceilings for one equipment category.
 * Used to fail fast when count exceeds bank capacity under requireUniqueAlias.
 *
 * @param {string} genreId
 * @param {string} category
 * @returns {{ aliasCap: number, technicalCap: number, cores: number }}
 */
function estimateEquipmentCapacity(genreId, category) {
    const bank = EQUIPMENT_CATEGORIES[category];
    if (!bank) {
        return { aliasCap: 0, technicalCap: 0, cores: 0 };
    }
    const adjPool = EQUIPMENT_ADJECTIVES[genreId] || EQUIPMENT_ADJECTIVES.rpg_fantasy;
    const tech = new Set();
    const aliases = new Set();

    for (const core of bank.cores) {
        for (const adj of adjPool) {
            const techNoMat = cleanPhrase(`${adj} ${core}`);
            tech.add(wordsCap(techNoMat, 4));
            for (const c of buildEquipmentAliasCandidates({
                adj, material: null, core, category
            })) {
                aliases.add(c);
            }
            for (const material of bank.materials) {
                if (core.toLowerCase().includes(material.toLowerCase())) continue;
                if (adj.toLowerCase() === material.toLowerCase()) continue;
                tech.add(wordsCap(cleanPhrase(`${material} ${core}`), 4));
                tech.add(wordsCap(cleanPhrase(`${adj} ${material} ${core}`), 4));
                for (const c of buildEquipmentAliasCandidates({
                    adj, material, core, category
                })) {
                    aliases.add(c);
                }
            }
        }
    }

    return {
        aliasCap: aliases.size,
        technicalCap: tech.size,
        cores: bank.cores.length
    };
}

/**
 * @param {string} genreId
 * @param {string} [category] equipment category id or null for random
 * @param {() => number} rng
 */
function generateEquipmentOne(genreId, category, rng) {
    const cats = Object.keys(EQUIPMENT_CATEGORIES);
    const cat = category && EQUIPMENT_CATEGORIES[category]
        ? category
        : pick(rng, cats);
    const bank = EQUIPMENT_CATEGORIES[cat];
    const adjPool = EQUIPMENT_ADJECTIVES[genreId] || EQUIPMENT_ADJECTIVES.rpg_fantasy;
    const adj = pick(rng, adjPool);
    const core = pick(rng, bank.cores);
    const useMaterial = rng() < 0.55;
    let material = useMaterial ? pick(rng, bank.materials) : null;
    // Avoid "Iron Iron Sword" style collisions
    if (material && core.toLowerCase().includes(material.toLowerCase())) {
        material = null;
    }
    if (material && adj.toLowerCase() === material.toLowerCase()) {
        material = null;
    }

    let technical;
    if (material && rng() < 0.5) {
        technical = cleanPhrase(`${adj} ${material} ${core}`);
    } else if (material) {
        technical = cleanPhrase(`${material} ${core}`);
        // Still prefer adj for variety when material-first is short
        if (rng() < 0.4) technical = cleanPhrase(`${adj} ${technical}`);
    } else {
        technical = cleanPhrase(`${adj} ${core}`);
    }

    technical = wordsCap(technical, 4);

    const parts = { adj, material, core, category: cat };
    const alias = buildEquipmentAliasCandidates(parts)[0] || shortAlias(technical, core);
    return {
        technical,
        alias,
        genre: genreId,
        kind: 'equipment',
        category: cat,
        _parts: parts
    };
}

/**
 * @param {string} genreId
 * @param {string|null} category
 * @param {() => number} rng
 */
function generateTileOne(genreId, category, rng) {
    const cats = Object.keys(TILE_CORES);
    const cat = category && TILE_CORES[category] ? category : pick(rng, cats);
    const core = pick(rng, TILE_CORES[cat]);
    const adjPool = TILE_ADJECTIVES[genreId] || TILE_ADJECTIVES.rpg_fantasy;
    const adj = pick(rng, adjPool);
    // Tiles: often "Mossy Stone Floor" — adj + core
    let technical = cleanPhrase(`${adj} ${core}`);
    if (technical.split(' ').length > 4) {
        technical = cleanPhrase(`${adj} ${core.split(' ').slice(-2).join(' ')}`);
    }
    const alias = shortAlias(technical, core);
    return {
        technical,
        alias,
        genre: genreId,
        kind: 'tiles',
        category: cat
    };
}

/**
 * @param {string} genreId
 * @param {string|null} category
 * @param {() => number} rng
 */
function generateObjectOne(genreId, category, rng) {
    const cats = Object.keys(OBJECT_CORES);
    const cat = category && OBJECT_CORES[category] ? category : pick(rng, cats);
    const core = pick(rng, OBJECT_CORES[cat]);
    const adjPool = OBJECT_ADJECTIVES[genreId] || OBJECT_ADJECTIVES.rpg_fantasy;
    const adj = pick(rng, adjPool);
    let technical = cleanPhrase(`${adj} ${core}`);
    if (technical.split(' ').length > 4) {
        technical = wordsCap(technical, 4);
    }
    const alias = shortAlias(technical, core);
    return {
        technical,
        alias,
        genre: genreId,
        kind: 'objects',
        category: cat
    };
}

/**
 * @param {string} genreId
 * @param {string|null} category
 * @param {() => number} rng
 */
function generateUiOne(genreId, category, rng) {
    const cats = Object.keys(UI_CORES);
    const cat = category && UI_CORES[category] ? category : pick(rng, cats);
    const core = pick(rng, UI_CORES[cat]);
    const adjPool = UI_ADJECTIVES[genreId] || UI_ADJECTIVES.rpg_fantasy;
    const adj = pick(rng, adjPool);
    let technical = cleanPhrase(`${adj} ${core}`);
    if (technical.split(' ').length > 4) {
        technical = wordsCap(technical, 4);
    }
    const alias = shortAlias(technical, core);
    return {
        technical,
        alias,
        genre: genreId,
        kind: 'ui',
        category: cat
    };
}

/**
 * Generate unique asset names for any kind.
 *
 * Uniqueness policy (equipment):
 *   - technical: hard unique within the result (+ exclude list)
 *   - alias: prefer unique via equipment alias ladder; skip draw if every
 *     candidate is taken when requireUniqueAlias is true
 *
 * @param {object} options
 * @param {string} options.genre
 * @param {string} [options.kind='creatures']
 * @param {string|null} [options.category] restrict equipment/tiles/objects subcategory
 * @param {number} [options.count=16]
 * @param {Iterable<string>} [options.exclude]
 * @param {number|null} [options.seed]
 * @param {number} [options.maxAttempts]
 * @param {boolean} [options.requireUniqueAlias=true]
 * @returns {Array<{ technical: string, alias: string, genre: string, kind: string, category?: string }>}
 */
function generateAssetNames(options) {
    const kindId = options.kind || DEFAULT_KIND;
    const genre = options.genre;
    const count = options.count ?? 16;
    const category = options.category || null;

    if (kindId === 'creatures') {
        const list = generateCreatureNames({
            genre,
            count,
            exclude: options.exclude,
            seed: options.seed,
            maxAttempts: options.maxAttempts,
            requireUniqueAlias: options.requireUniqueAlias
        });
        return list.map((c) => ({ ...c, kind: 'creatures' }));
    }
    if (kindId === 'overlays') {
        if (count !== WANG_MASK_COUNT) {
            throw new Error(
                `overlays generate as a Wang-16 family (${WANG_MASK_COUNT} names); got count=${count}`
            );
        }
        return generateWangFamilyRoster({
            genre,
            category,
            exclude: options.exclude
        });
    }
    const wallFamily = options.wallFamily || options.wangFamily;
    if (kindId === 'objects' && wallFamily) {
        if (count !== WALL_ALIGN_COUNT) {
            throw new Error(
                `wall families generate as 4 faces (${WALL_ALIGN_COUNT} names); got count=${count}`
            );
        }
        return generateWallFamilyRoster({
            genre,
            wallFamily,
            category,
            exclude: options.exclude
        });
    }

    getAssetKind(kindId);
    if (!GENRES[genre]) {
        throw new Error(`Unknown genre "${genre}"`);
    }
    if (count < 1) {
        throw new Error('count must be >= 1');
    }
    if (category) {
        const allowed = ASSET_KINDS[kindId].categories || [];
        if (allowed.length && !allowed.includes(category)) {
            throw new Error(
                `Unknown category "${category}" for kind "${kindId}". Known: ${allowed.join(', ')}`
            );
        }
    }

    const exclude = new Set(options.exclude || []);
    const seed = options.seed;
    const maxAttempts = options.maxAttempts ?? Math.max(count * 200, 2000);
    const requireUniqueAlias = options.requireUniqueAlias !== false;
    const rng = seed == null ? Math.random : mulberry32(seed >>> 0);

    // Fail fast when a tight category bank cannot supply `count` unique aliases.
    if (kindId === 'equipment' && category && requireUniqueAlias) {
        const cap = estimateEquipmentCapacity(genre, category);
        if (count > cap.aliasCap) {
            throw new Error(
                `Cannot generate ${count} unique ${kindId} names for category "${category}" ` +
                    `(alias capacity ~${cap.aliasCap} from ${cap.cores} cores + materials/adjectives; ` +
                    `technical capacity ~${cap.technicalCap}). ` +
                    `Lower --count, omit --category, or expand EQUIPMENT_CATEGORIES.${category}.`
            );
        }
        if (count > cap.technicalCap) {
            throw new Error(
                `Cannot generate ${count} unique ${kindId} technical names for category "${category}" ` +
                    `(technical capacity ~${cap.technicalCap}; exclude size ${exclude.size}). ` +
                    `Lower --count or expand EQUIPMENT_CATEGORIES.${category}.`
            );
        }
    }

    /** @type {Array<{ technical: string, alias: string, genre: string, kind: string, category?: string }>} */
    const result = [];
    const usedTech = new Set(exclude);
    const usedAlias = new Set();
    let attempts = 0;

    const genOne = () => {
        if (kindId === 'equipment') return generateEquipmentOne(genre, category, rng);
        if (kindId === 'tiles') return generateTileOne(genre, category, rng);
        if (kindId === 'objects') return generateObjectOne(genre, category, rng);
        if (kindId === 'ui') return generateUiOne(genre, category, rng);
        throw new Error(`No name generator for kind "${kindId}"`);
    };

    while (result.length < count) {
        attempts += 1;
        if (attempts > maxAttempts) {
            const catHint = category ? ` category "${category}"` : '';
            let capacityHint = '';
            if (kindId === 'equipment' && category) {
                const cap = estimateEquipmentCapacity(genre, category);
                capacityHint =
                    ` Bank capacity for "${category}": ~${cap.aliasCap} unique aliases, ` +
                    `~${cap.technicalCap} technicals (${cap.cores} cores).`;
            }
            throw new Error(
                `Could not generate ${count} unique ${kindId} names${catHint} after ${maxAttempts} attempts ` +
                    `(have ${result.length}; exclude size ${exclude.size}).${capacityHint} ` +
                    `maxAttempts defaults to max(count*200, 2000); bank collision, exclude list, ` +
                    `or alias exhaustion is likely.`
            );
        }
        const item = genOne();
        if (usedTech.has(item.technical)) continue;
        if (findRestricted(item.technical).length) {
            continue;
        }

        let alias;
        if (kindId === 'equipment' && item._parts) {
            alias = pickEquipmentAlias(item._parts, usedAlias);
        } else {
            // Tiles / objects: short core alias + category suffix fallback
            alias = item.alias;
            if (usedAlias.has(alias)) {
                const alt = cleanPhrase(`${item.alias} ${item.category || kindId}`);
                if (!usedAlias.has(alt) && !findRestricted(alt).length) {
                    alias = alt;
                } else if (requireUniqueAlias) {
                    continue;
                }
            }
        }

        if (findRestricted(alias).length) {
            continue;
        }
        if (requireUniqueAlias && usedAlias.has(alias)) {
            continue;
        }

        usedTech.add(item.technical);
        usedAlias.add(alias);
        result.push({
            technical: item.technical,
            alias,
            genre,
            kind: kindId,
            category: item.category
        });
    }

    return result;
}

/**
 * List categories for a kind (empty for creatures).
 * @param {string} kindId
 * @returns {string[]}
 */
function listCategories(kindId) {
    return (getAssetKind(kindId).categories || []).slice();
}

module.exports = {
    EQUIPMENT_CATEGORIES,
    EQUIPMENT_ADJECTIVES,
    TILE_CORES,
    OBJECT_CORES,
    generateAssetNames,
    generateEquipmentOne,
    generateTileOne,
    generateObjectOne,
    generateUiOne,
    buildEquipmentAliasCandidates,
    pickEquipmentAlias,
    estimateEquipmentCapacity,
    listCategories,
    parseDoneList,
    RESTRICTED_TERMS,
    // Re-export creature generator for convenience
    generateCreatureNames
};
