/**
 * Multi-genre creature name generator (browser + Node).
 *
 * Produces commercial-safe names from public-domain / generic vocabulary.
 * Each result has:
 *   - technical: descriptive prompt name for sprite generation (Antigravity)
 *   - alias: shorter display / file-friendly nickname
 *
 * No D&D Product Identity, no franchise superhero names, no brand marks.
 */

'use strict';

// ---------------------------------------------------------------------------
// Restricted terms (not free for unlicensed commercial use)
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const RESTRICTED_TERMS = {
    // D&D / WotC
    Myconid: 'D&D-specific mushroom people (WotC)',
    Bullywug: 'D&D-specific frog people (WotC)',
    Grung: 'D&D-specific poison frog people (WotC)',
    'Thri-Kreen': 'D&D insectoid race (WotC)',
    Vegepygmy: 'D&D-specific plant humanoids (WotC)',
    Duergar: 'D&D gray-dwarf race name (WotC)',
    Drow: 'D&D dark-elf race name (WotC branding)',
    Grimlock: 'D&D-specific blind subterranean humanoids (WotC)',
    Underdark: 'D&D setting term (WotC Product Identity)',
    Beholder: 'D&D Product Identity monster',
    Illithid: 'D&D Product Identity (mind flayer)',
    'Mind Flayer': 'D&D Product Identity',
    Owlbear: 'D&D-origin hybrid (license-dependent)',
    'Displacer Beast': 'D&D Product Identity',
    'Yuan-ti': 'D&D snake people (WotC)',
    Bulette: 'D&D land shark (WotC)',
    Flumph: 'D&D-specific creature (WotC)',
    Modron: 'D&D lawful constructs (WotC)',
    Slaad: 'D&D chaos frogs (WotC)',
    Githyanki: 'D&D race (WotC)',
    Githzerai: 'D&D race (WotC)',
    Aboleth: 'D&D aquatic aberration (WotC)',
    Roper: 'D&D-specific monster (WotC)',
    'Hook Horror': 'D&D-specific monster (WotC)',
    'Carrion Crawler': 'D&D-specific monster (WotC)',
    'Umber Hulk': 'D&D Product Identity',
    'Gelatinous Cube': 'D&D-origin ooze (license-dependent)',
    'Rust Monster': 'D&D-origin (license-dependent)',
    Lizardfolk: 'Strongly associated with D&D race write-ups',
    Gnoll: "D&D spelling/coinage; safer to avoid unlicensed",
    Troglodyte: 'Generic word exists, but D&D reptilian race is distinctive',
    // Franchise superheroes / brands (substring match)
    Superman: 'Trademarked character',
    Batman: 'Trademarked character',
    Spiderman: 'Trademarked character',
    'Spider-Man': 'Trademarked character',
    Wolverine: 'Trademarked character',
    Hulk: 'Trademarked character',
    Ironman: 'Trademarked character',
    'Iron Man': 'Trademarked character',
    Xmen: 'Trademarked franchise',
    'X-Men': 'Trademarked franchise',
    Avengers: 'Trademarked team',
    Jedi: 'Trademarked franchise term',
    Sith: 'Trademarked franchise term',
    Xenomorph: 'Trademarked franchise creature',
    Predalien: 'Trademarked franchise creature',
    Transformers: 'Trademarked franchise',
    Optimus: 'Trademarked character',
    Megatron: 'Trademarked character',
    Pokemon: 'Trademarked franchise',
    Pokémon: 'Trademarked franchise'
};

// ---------------------------------------------------------------------------
// Genre word banks
// ---------------------------------------------------------------------------

/** @type {Record<string, object>} */
const BANKS = {
    rpg_fantasy: {
        adjectives: [
            'Ancient', 'Arcane', 'Ashen', 'Astral', 'Blood', 'Brimstone', 'Celestial',
            'Chaos', 'Crystal', 'Cursed', 'Dark', 'Doom', 'Dread', 'Eldritch', 'Ember',
            'Ethereal', 'Feral', 'Glacier', 'Gloom', 'Grave', 'Hellfire', 'Hollow',
            'Infernal', 'Iron', 'Lava', 'Lunar', 'Magma', 'Mist', 'Nether', 'Obsidian',
            'Phantom', 'Plague', 'Primeval', 'Radiant', 'Rune', 'Sanguine', 'Skeletal',
            'Solar', 'Storm', 'Sun', 'Tempest', 'Thunder', 'Toxic', 'Twilight',
            'Vampiric', 'Venomous', 'Void', 'Warp', 'Wild'
        ],
        habitats: [
            'Abyss', 'Bog', 'Catacomb', 'Cave', 'Cavern', 'Citadel', 'Cloud', 'Crypt',
            'Deep Sea', 'Desert', 'Dune', 'Fire', 'Forest', 'Frost', 'Glacier', 'Hill',
            'Ice', 'Jungle', 'Mire', 'Mountain', 'Ocean', 'Reef', 'Ruins', 'Sky',
            'Stone', 'Storm', 'Swamp', 'Tomb', 'Volcano'
        ],
        creatures: [
            'Basilisk', 'Centaur', 'Chimera', 'Cyclops', 'Dragon', 'Drake', 'Gargoyle',
            'Gorgon', 'Griffin', 'Harpy', 'Hydra', 'Minotaur', 'Phoenix', 'Satyr',
            'Siren', 'Sphinx', 'Wyrm', 'Wyrmling', 'Bugbear', 'Dwarf', 'Elf', 'Ettin',
            'Giant', 'Goblin', 'Hobgoblin', 'Kobold', 'Ogre', 'Orc', 'Troll', 'Wight',
            'Demon', 'Devil', 'Fiend', 'Ghoul', 'Golem', 'Imp', 'Merrow', 'Phantom',
            'Revenant', 'Spectre', 'Vampire', 'Wraith', 'Behemoth', 'Leviathan',
            'Abomination', 'Automaton', 'Construct', 'Crawler', 'Elemental', 'Horror',
            'Serpent', 'Stalker', 'Triton', 'Bear', 'Panther', 'Scorpion', 'Spider',
            'Tiger', 'Viper', 'Wolf', 'Lizard Warrior', 'Fungal Knight'
        ],
        roles: [
            'Archer', 'Assassin', 'Berserker', 'Brute', 'Captain', 'Champion', 'Cultist',
            'Devourer', 'Executioner', 'Guard', 'Hunter', 'Knight', 'Lord', 'Mage',
            'Necromancer', 'Overlord', 'Packleader', 'Priest', 'Raider', 'Rager',
            'Ranger', 'Ravager', 'Scout', 'Shaman', 'Slayer', 'Sorcerer', 'Vanguard',
            'Warden', 'Warlock', 'Warrior', 'Weaver'
        ],
        specialBodies: [
            'Cloud Giant', 'Fire Giant', 'Frost Giant', 'Hill Giant', 'Stone Giant', 'Storm Giant'
        ]
    },

    fantastic_ecology: {
        adjectives: [
            'Blooming', 'Coral', 'Crystal', 'Ember', 'Fungal', 'Glacial', 'Luminous',
            'Mossy', 'Mycelial', 'Petal', 'Pollen', 'Prismatic', 'Rooted', 'Sap',
            'Spore', 'Tidal', 'Verdant', 'Volcanic', 'Amber', 'Azure', 'Basalt',
            'Boreal', 'Brine', 'Canopy', 'Cave', 'Delta', 'Dune', 'Fjord', 'Geyser',
            'Hollow', 'Ivy', 'Jade', 'Kelp', 'Lava', 'Marsh', 'Nightbloom', 'Obsidian',
            'Pearl', 'Quartz', 'Reef', 'River', 'Sand', 'Thorn', 'Thunder', 'Tide',
            'Willow', 'Wind', 'Zephyr'
        ],
        habitats: [
            'Alpine', 'Bog', 'Canopy', 'Cavern', 'Coral Shelf', 'Crater', 'Delta',
            'Fen', 'Glacier', 'Grotto', 'Hot Spring', 'Jungle', 'Kelp Forest', 'Mesa',
            'Mire', 'Oasis', 'Rainforest', 'Riverbank', 'Savanna', 'Shore', 'Tundra',
            'Volcano Rim', 'Wetland', 'Woodland'
        ],
        creatures: [
            'Elemental', 'Bloombeast', 'Rootwalker', 'Sporeling', 'Crystal Stag',
            'Moss Golem', 'Tide Serpent', 'Ember Moth', 'Ice Beetle', 'Sand Ray',
            'Thorn Boar', 'Coral Drake', 'Fungal Bear', 'Pollen Sprite', 'Stone Toad',
            'River Wisp', 'Lava Salamander', 'Storm Heron', 'Mangrove Crawler',
            'Pearl Crab', 'Vine Hydra', 'Amber Wolf', 'Quartz Hawk', 'Kelp Leviathan',
            'Spore Drake', 'Basalt Tortoise', 'Bloom Hydra', 'Marsh Phantom',
            'Canopy Panther', 'Glacier Fox', 'Tidal Guardian', 'Root Serpent',
            'Crystal Wyrm', 'Verdant Stalker', 'Geyser Sprite', 'Boreal Elk'
        ],
        roles: [
            'Guardian', 'Herdleader', 'Pollinator', 'Apex', 'Scavenger', 'Migrator',
            'Nestkeeper', 'Broodmother', 'Symbiote', 'Predator', 'Forager', 'Warden',
            'Bloomcaller', 'Tidewalker', 'Sporecaster', 'Rootbinder'
        ],
        specialBodies: [
            'Living Wildfire', 'Walking Glacier', 'Storm Cloud Beast', 'Blooming Colossus'
        ]
    },

    ultra_tech: {
        adjectives: [
            'Apex', 'Carbon', 'Chrome', 'Combat', 'Cyber', 'Delta', 'Fusion', 'Heavy',
            'Ion', 'Ironclad', 'Laser', 'Magpulse', 'Nano', 'Null', 'Omega', 'Plasma',
            'Quantum', 'Rail', 'Reactor', 'Shock', 'Siege', 'Silent', 'Solar', 'Steel',
            'Tactical', 'Titan', 'Turbo', 'Void', 'Warp', 'Zero', 'Arc', 'Bolt',
            'Cobalt', 'Cryo', 'Drone', 'Echo', 'Flux', 'Grid', 'Hex', 'Hyper',
            'Jet', 'Kinetic', 'Lumen', 'Mech', 'Neon', 'Orbit', 'Pulse', 'Razor'
        ],
        habitats: [
            'Orbital', 'Foundry', 'Scrapyard', 'Reactor', 'Hangar', 'Asteroid',
            'Deep Mine', 'Sky Dock', 'War Factory', 'Data Vault', 'Ice Moon',
            'Desert Outpost', 'City Core', 'Battlefront', 'Lab Complex',
            'Dry Dock', 'Grid Node', 'Launch Bay', 'Smelter', 'Vault Ring'
        ],
        creatures: [
            'Assault Mech', 'Battle Drone', 'Siege Walker', 'Scout Bot', 'Heavy Frame',
            'Plasma Tank', 'Spider Unit', 'Winged Drone', 'Shield Guardian', 'Rail Sniper',
            'Mining Golem', 'Combat Android', 'Recon Probe', 'Titan Chassis',
            'Hover Sentinel', 'Blade Runner Unit', 'Wrecker Bot', 'Medic Droid',
            'Artillery Frame', 'Stealth Unit', 'Loader Mech', 'Interceptor',
            'Quad Walker', 'Orbital Drop Pod', 'Core Guardian', 'Pulse Crawler',
            'Nano Swarm Host', 'Forge Automaton', 'Breach Unit', 'Command Frame',
            // Single-word cores
            'Mech', 'Drone', 'Walker', 'Android', 'Probe', 'Tank', 'Golem',
            'Chassis', 'Sentinel', 'Crawler', 'Frame', 'Droid', 'Automaton',
            'Sniper', 'Bulwark', 'Swarm'
        ],
        roles: [
            'Striker', 'Vanguard', 'Support', 'Heavy', 'Sniper', 'Scout', 'Engineer',
            'Warden', 'Destroyer', 'Interceptor', 'Bulwark', 'Raider', 'Overwatch',
            'Demolisher', 'Pathfinder', 'Controller', 'Breacher', 'Spotter'
        ],
        specialBodies: [
            'Bipedal Assault Frame', 'Hexapod Siege Platform', 'Hover Artillery Platform',
            'Tri-Pod Siege Caster'
        ]
    },

    space_creatures: {
        adjectives: [
            'Astral', 'Cosmic', 'Crimson', 'Crystal', 'Eclipse', 'Hollow', 'Ion',
            'Lunar', 'Nebula', 'Nova', 'Obsidian', 'Plasma', 'Pulsar', 'Quantum',
            'Radiant', 'Solar', 'Stellar', 'Void', 'Warp', 'Xeno',
            'Azure', 'Bio', 'Chrome', 'Dark', 'Ember', 'Frost', 'Ghost', 'Hyper',
            'Iridium', 'Jade', 'Kinetic', 'Lumen', 'Meteor', 'Null', 'Orbit',
            'Prism', 'Quasar', 'Rift', 'Shadow', 'Tide', 'Ultraviolet', 'Violet'
        ],
        habitats: [
            'Asteroid Belt', 'Gas Giant', 'Ice Moon', 'Nebula', 'Orbital Reef',
            'Ring System', 'Star Nursery', 'Void Rift', 'Crystal World', 'Lava World',
            'Ocean World', 'Desert World', 'Derelict Station', 'Comet Trail',
            'Binary Star', 'Dark Nebula', 'Plasma Storm', 'Dust Belt', 'Tide Lock',
            'Magnetar Rim', 'Shattered Moon'
        ],
        creatures: [
            'Alien Stalker', 'Void Serpent', 'Crystal Jelly', 'Spore Floater',
            'Horned Xeno', 'Shellback', 'Plasma Ray', 'Rift Crawler', 'Star Leech',
            'Nebula Wisp', 'Asteroid Beetle', 'Gravity Whale', 'Phase Mantis',
            'Comet Moth', 'Hive Drone', 'Acid Spitter', 'Tentacle Horror',
            'Crystal Drake', 'Void Wolf', 'Solar Phoenix', 'Ice Kraken',
            'Ring Serpent', 'Orbit Squid', 'Lumen Beetle', 'Rift Hydra',
            'Xeno Knight', 'Spore Giant', 'Plasma Imp', 'Shadow Floater',
            'Meteor Crab', 'Star Golem', 'Void Harpy',
            // Single-word cores
            'Serpent', 'Jelly', 'Floater', 'Crawler', 'Leech', 'Wisp', 'Beetle',
            'Whale', 'Mantis', 'Moth', 'Drone', 'Drake', 'Wolf', 'Phoenix', 'Kraken',
            'Squid', 'Hydra', 'Imp', 'Crab', 'Golem', 'Harpy', 'Stalker', 'Spitter'
        ],
        roles: [
            'Hunter', 'Broodguard', 'Scout', 'Apex', 'Symbiote', 'Parasite',
            'Migrator', 'Nestlord', 'Voidcaller', 'Riftwalker', 'Swarmleader',
            'Guardian', 'Devourer', 'Pathfinder', 'Broodling', 'Sporehost'
        ],
        specialBodies: [
            'Living Comet', 'Colony Organism', 'Phase-Shift Beast', 'Starspawn Cluster'
        ]
    },

    steampunk: {
        adjectives: [
            'Brass', 'Bronze', 'Clockwork', 'Copper', 'Gear', 'Gilded', 'Iron',
            'Riveted', 'Rusted', 'Steam', 'Victorian', 'Aether', 'Cinder', 'Coal',
            'Ember', 'Fog', 'Gasket', 'Hinged', 'Industrial', 'Mechanical', 'Piston',
            'Pressure', 'Soot', 'Spring', 'Valve', 'Windup', 'Airship', 'Boiler',
            'Chrono', 'Dirigible', 'Factory', 'Gadget', 'Hex', 'Ornate', 'Polished',
            'Quicksilver', 'Sooty', 'Ticked', 'Wrought', 'Burnished', 'Cogged',
            'Smog', 'Tin', 'Lacquered', 'Hammered', 'Vented', 'Whirring', 'Aetherial',
            'Cast-Iron', 'Spark'
        ],
        habitats: [
            'Airship', 'Boiler Room', 'Clocktower', 'Factory', 'Fog District',
            'Foundry', 'Harbor', 'Mine Shaft', 'Railway', 'Sky Dock', 'Steamworks',
            'Underworks', 'Workshop', 'Bridge District', 'Smog Alley', 'Dockyard',
            'Engine Yard', 'Gasworks', 'Observatory', 'Pump House', 'Rail Yard',
            'Skybridge', 'Tannery Row', 'Viaduct'
        ],
        creatures: [
            // Multi-word archetypes
            'Clockwork Knight', 'Steam Golem', 'Gear Wolf', 'Brass Hawk',
            'Piston Beetle', 'Aether Wisp', 'Valve Serpent', 'Boiler Beast',
            'Automaton Guard', 'Dirigible Squid', 'Cog Spider', 'Windup Soldier',
            'Iron Horse', 'Pressure Drake', 'Gasket Imp', 'Riveted Ogre',
            'Chrono Beetle', 'Soot Phantom', 'Spring Fox', 'Mechanical Minotaur',
            'Airship Kraken', 'Copper Scarab', 'Steam Elemental', 'Gear Hydra',
            'Ornate Sentinel', 'Factory Warden', 'Piston Titan', 'Clockwork Owl',
            'Brass Lion', 'Valve Hawk', 'Cog Hound', 'Steam Mantis',
            'Aether Serpent', 'Riveted Beetle', 'Boiler Crab', 'Windup Panther',
            // Single-word cores (habitat prefix + better alias variety)
            'Golem', 'Automaton', 'Kraken', 'Drake', 'Beetle', 'Serpent', 'Hawk',
            'Ogre', 'Imp', 'Fox', 'Owl', 'Scarab', 'Hydra', 'Titan', 'Wisp',
            'Soldier', 'Knight', 'Spider', 'Horse', 'Squid', 'Phantom', 'Minotaur',
            'Elemental', 'Sentinel', 'Colossus', 'Leviathan', 'Locomotive', 'Hound',
            'Mantis', 'Crab', 'Panther', 'Raven', 'Stag', 'Warden'
        ],
        roles: [
            'Engineer', 'Aeronaut', 'Watchman', 'Stoker', 'Tinker', 'Captain',
            'Sentinel', 'Raider', 'Pilot', 'Foreman', 'Inventor', 'Guardian',
            'Skyraider', 'Warden', 'Mechanic', 'Navigator', 'Porter', 'Surveyor',
            'Signalman', 'Overseer', 'Artificer', 'Deckhand'
        ],
        specialBodies: [
            'Walking Locomotive', 'Clockwork Colossus', 'Steam-Powered Leviathan',
            'Skyrail Behemoth', 'Aetherforge Golem'
        ]
    },

    super_heroes: {
        adjectives: [
            'Crimson', 'Azure', 'Golden', 'Shadow', 'Radiant', 'Storm', 'Plasma',
            'Crystal', 'Ember', 'Frost', 'Thunder', 'Volt', 'Phantom', 'Iron',
            'Silver', 'Obsidian', 'Solar', 'Lunar', 'Neon', 'Prism', 'Quantum',
            'Sonic', 'Titan', 'Ultra', 'Vivid', 'Wild', 'Arc', 'Bolt', 'Chrome',
            'Dark', 'Echo', 'Flux', 'Glow', 'Hyper', 'Jade', 'Kinetic', 'Lumen',
            'Nova', 'Pulse', 'Razor', 'Swift', 'Turbo', 'Void', 'Warp', 'Zenith'
        ],
        habitats: [
            'City', 'Rooftop', 'Harbor', 'Industrial', 'Skyline', 'Underground',
            'Coastal', 'Mountain', 'Desert', 'Arctic', 'Jungle', 'Orbital',
            'Night District', 'Metro', 'Plaza', 'Canal', 'Subway', 'Warehouse',
            'Campus', 'Spire'
        ],
        creatures: [
            // Generic archetypes only — powers + roles, no franchise names
            'Velocity Runner', 'Shield Guardian', 'Plasma Blaster', 'Shadow Stalker',
            'Titan Bruiser', 'Sonic Screamer', 'Crystal Mage', 'Flame Wielder',
            'Frost Binder', 'Storm Caller', 'Gadgeteer', 'Mind Weaver',
            'Iron Sentinel', 'Night Operative', 'Sky Dancer', 'Ground Shaker',
            'Light Bearer', 'Void Walker', 'Pulse Striker', 'Blade Dancer',
            'Wall Crawler', 'Tide Controller', 'Beast Whisperer', 'Time Bender',
            'Gravity Knight', 'Hex Caster', 'Steel Brawler', 'Wind Archer',
            'Ember Vanguard', 'Frost Archer', 'Thunder Bruiser', 'Neon Trickster',
            // Single-word power cores
            'Runner', 'Blaster', 'Stalker', 'Bruiser', 'Screamer', 'Mage', 'Wielder',
            'Binder', 'Caller', 'Weaver', 'Sentinel', 'Operative', 'Dancer', 'Shaker',
            'Bearer', 'Walker', 'Striker', 'Crawler', 'Controller', 'Bender', 'Knight',
            'Caster', 'Brawler', 'Archer', 'Vanguard', 'Trickster', 'Guardian'
        ],
        roles: [
            'Hero', 'Villain', 'Antihero', 'Sidekick', 'Vigilante', 'Guardian',
            'Outlaw', 'Champion', 'Rogue', 'Sentinel', 'Enforcer', 'Protector',
            'Nemesis', 'Scout', 'Commander', 'Mercenary', 'Defender'
        ],
        specialBodies: [
            'Armored Power Suit Wearer', 'Living Energy Construct', 'Dual-Form Shapeshifter',
            'Elemental Conduit Host'
        ]
    }
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Simple seeded PRNG (mulberry32) so browser and Node share the same API.
 * @param {number} seed
 * @returns {() => number} returns [0, 1)
 */
function mulberry32(seed) {
    let t = seed >>> 0;
    return function next() {
        t += 0x6d2b79f5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {() => number} rng
 * @param {string[]} arr
 */
function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
}

/**
 * @param {string} name
 * @returns {Array<[string, string]>}
 */
function findRestricted(name) {
    const lower = name.toLowerCase();
    /** @type {Array<[string, string]>} */
    const hits = [];
    for (const [term, reason] of Object.entries(RESTRICTED_TERMS)) {
        if (lower.includes(term.toLowerCase())) {
            hits.push([term, reason]);
        }
    }
    return hits;
}

/**
 * Collapse whitespace and title-case lightly (banks are already Title Case).
 * @param {string} s
 */
function cleanPhrase(s) {
    return s.replace(/\s+/g, ' ').trim();
}

/**
 * Candidate aliases from preferred (short / readable) to more distinctive.
 * Multi-word creatures must include adj and/or role so batches do not collapse
 * to one alias per archetype ("Gear Wolf" alone).
 *
 * @param {{ adj: string, creature: string, role: string|null }} parts
 * @returns {string[]}
 */
function buildAliasCandidates(parts) {
    const adj = parts.adj;
    const creature = parts.creature;
    const role = parts.role;
    const words = creature.split(/\s+/).filter(Boolean);
    /** @type {string[]} */
    const out = [];
    const push = (s) => {
        const c = cleanPhrase(s);
        if (c && !out.includes(c)) out.push(c);
    };

    if (words.length === 1) {
        if (role && creature.length <= 12) push(`${creature} ${role}`);
        push(`${adj} ${creature}`);
        if (role) push(`${adj} ${creature} ${role}`);
        if (role) push(`${creature} ${role}`);
        if (role) push(`${adj} ${role}`);
        return out;
    }

    // Multi-word / special body: never lead with bare creature as first choice.
    push(`${adj} ${creature}`);
    if (role) push(`${creature} ${role}`);
    if (words.length >= 2) {
        push(`${adj} ${words.slice(-2).join(' ')}`);
        push(`${adj} ${words[words.length - 1]}`);
    }
    if (role) {
        push(`${adj} ${words[words.length - 1]} ${role}`);
        push(`${words.slice(-2).join(' ')} ${role}`);
    }
    // Last resorts (may still collide across a batch).
    push(creature);
    if (role) push(`${adj} ${role}`);
    return out;
}

/**
 * Prefer short, readable aliases (first candidate).
 * @param {{ adj: string, creature: string, role: string|null }} parts
 */
function buildAlias(parts) {
    const list = buildAliasCandidates(parts);
    return list[0] || cleanPhrase(parts.creature);
}

/**
 * True when adjective echoes any token of the creature phrase.
 * @param {string} adj
 * @param {string} creature
 */
function adjCollidesWithCreature(adj, creature) {
    const a = adj.toLowerCase();
    return creature
        .split(/\s+/)
        .some((w) => w.toLowerCase() === a);
}

/**
 * Build one name. Keep technical short (≈2–4 words) for Antigravity prompts:
 *   Adj + Creature [+ Role]
 * Habitat is only mixed into the creature core when the creature token is a single word.
 *
 * @param {string} genreId
 * @param {() => number} rng
 * @returns {{ technical: string, alias: string, genre: string, _parts?: object }}
 */
function generateOne(genreId, rng) {
    const bank = BANKS[genreId];
    if (!bank) {
        throw new Error(`No word bank for genre "${genreId}"`);
    }

    let creature;
    let role = null;

    const roll = rng();
    if (roll < 0.12 && bank.specialBodies.length) {
        // e.g. "Cloud Giant", "Walking Locomotive"
        creature = pick(rng, bank.specialBodies);
    } else {
        creature = pick(rng, bank.creatures);
        // Single-word creatures can take a habitat prefix for variety
        // ("Cave Basilisk") without exploding multi-word archetypes.
        if (creature.split(' ').length === 1 && rng() < 0.45) {
            creature = `${pick(rng, bank.habitats)} ${creature}`;
        }
    }

    // Adjective must not echo any creature token ("Steam Steam Golem", "Titan Titan Chassis").
    let adj = pick(rng, bank.adjectives);
    for (let guard = 0; guard < 12 && adjCollidesWithCreature(adj, creature); guard++) {
        adj = pick(rng, bank.adjectives);
    }

    // Role ~70% when technical would stay ≤ 4 tokens
    const tokenBudget = creature.split(' ').length;
    if (tokenBudget <= 2 && rng() < 0.7) {
        role = pick(rng, bank.roles);
    } else if (tokenBudget === 3 && rng() < 0.35) {
        role = pick(rng, bank.roles);
    }

    const technical = cleanPhrase(role ? `${adj} ${creature} ${role}` : `${adj} ${creature}`);
    const parts = { adj, creature, role };
    const alias = buildAlias(parts);

    return { technical, alias, genre: genreId, _parts: parts };
}

/**
 * Pick first alias candidate not already used; fall back to preferred if all collide.
 * @param {{ adj: string, creature: string, role: string|null }} parts
 * @param {Set<string>} usedAlias
 * @returns {string}
 */
function pickUniqueAlias(parts, usedAlias) {
    const candidates = buildAliasCandidates(parts);
    for (const c of candidates) {
        if (!usedAlias.has(c)) return c;
    }
    // Soft uniqueness: still return preferred form (technical remains the hard key).
    return candidates[0] || cleanPhrase(parts.creature);
}

/**
 * Generate unique name objects.
 *
 * Uniqueness policy:
 *   - technical: hard unique within the result (+ exclude list)
 *   - alias: prefer unique via candidate ladder; may soft-collide only if
 *     every candidate is already taken (should be rare after bank expansion)
 *
 * @param {object} options
 * @param {string} options.genre
 * @param {number} [options.count=16]
 * @param {Iterable<string>} [options.exclude] technical names already used
 * @param {number|null} [options.seed]
 * @param {number} [options.maxAttempts]
 * @param {boolean} [options.requireUniqueAlias=true] retry when alias still collides after ladder
 * @returns {Array<{ technical: string, alias: string, genre: string }>}
 */
function generateNames(options) {
    const genre = options.genre;
    const count = options.count ?? 16;
    const exclude = new Set(options.exclude || []);
    const seed = options.seed;
    const maxAttempts = options.maxAttempts ?? Math.max(count * 200, 2000);
    const requireUniqueAlias = options.requireUniqueAlias !== false;

    if (!BANKS[genre]) {
        throw new Error(`Unknown genre "${genre}". Known: ${Object.keys(BANKS).join(', ')}`);
    }
    if (count < 1) {
        throw new Error('count must be >= 1');
    }

    const rng = seed == null
        ? Math.random
        : mulberry32(seed >>> 0);

    /** @type {Array<{ technical: string, alias: string, genre: string }>} */
    const result = [];
    const usedTech = new Set(exclude);
    const usedAlias = new Set();
    let attempts = 0;

    while (result.length < count) {
        attempts += 1;
        if (attempts > maxAttempts) {
            throw new Error(
                `Could not generate ${count} unique names after ${maxAttempts} attempts ` +
                `(have ${result.length}; exclude size ${exclude.size}).`
            );
        }
        const item = generateOne(genre, rng);
        if (usedTech.has(item.technical)) {
            continue;
        }
        if (findRestricted(item.technical).length || findRestricted(item.alias).length) {
            continue;
        }

        const parts = item._parts || {
            adj: item.technical.split(' ')[0],
            creature: item.technical,
            role: null
        };
        const alias = pickUniqueAlias(parts, usedAlias);

        if (findRestricted(alias).length) {
            continue;
        }
        if (requireUniqueAlias && usedAlias.has(alias)) {
            // Exhausted candidates for this draw; try another generation.
            continue;
        }

        usedTech.add(item.technical);
        usedAlias.add(alias);
        result.push({
            technical: item.technical,
            alias,
            genre: genre
        });
    }

    return result;
}

/**
 * Bank size + single/multi-word creature split for one genre.
 * @param {string} genreId
 */
function bankStats(genreId) {
    const bank = BANKS[genreId];
    if (!bank) {
        throw new Error(`Unknown genre "${genreId}"`);
    }
    const creatures = bank.creatures || [];
    let single = 0;
    let multi = 0;
    for (const c of creatures) {
        if (String(c).split(/\s+/).length === 1) single += 1;
        else multi += 1;
    }
    return {
        genre: genreId,
        adjectives: bank.adjectives.length,
        habitats: bank.habitats.length,
        creatures: creatures.length,
        roles: bank.roles.length,
        specialBodies: bank.specialBodies.length,
        totalTokens:
            bank.adjectives.length +
            bank.habitats.length +
            creatures.length +
            bank.roles.length +
            bank.specialBodies.length,
        singleWordCreatures: single,
        multiWordCreatures: multi
    };
}

/**
 * Sample diversity + probe max single-call batch size (seeded).
 *
 * @param {string} genreId
 * @param {{ sampleSize?: number, seed?: number, exclude?: Iterable<string> }} [options]
 */
function genreCapacityStats(genreId, options = {}) {
    const sampleSize = options.sampleSize ?? 2000;
    const seed = options.seed ?? 42;
    const exclude = [...(options.exclude || [])];

    const rng = mulberry32(seed >>> 0);
    const tech = new Set();
    const alias = new Set();
    for (let i = 0; i < sampleSize; i++) {
        const item = generateOne(genreId, rng);
        const parts = item._parts;
        const a = pickUniqueAlias(parts, alias);
        tech.add(item.technical);
        alias.add(a);
    }

    // Binary search largest count generateNames can satisfy with current exclude.
    // Cap the probe so --stats stays fast; report is a lower bound when at cap.
    const probeCap = 256;
    let lo = 1;
    let hi = probeCap;
    let maxBatch = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        try {
            generateNames({
                genre: genreId,
                count: mid,
                exclude,
                seed: seed + 7,
                maxAttempts: Math.max(mid * 400, 4000),
                requireUniqueAlias: true
            });
            maxBatch = mid;
            lo = mid + 1;
        } catch {
            hi = mid - 1;
        }
    }

    return {
        genre: genreId,
        bank: bankStats(genreId),
        sampleSize,
        uniqueTechnicalSample: tech.size,
        uniqueAliasSample: alias.size,
        aliasToTechRatio: tech.size
            ? Number((alias.size / tech.size).toFixed(3))
            : 0,
        maxSingleCallBatch: maxBatch,
        maxSingleCallBatchCapped: maxBatch >= probeCap,
        excludeSize: exclude.length
    };
}

/**
 * Capacity stats for every bank genre.
 * @param {{ sampleSize?: number, seed?: number, excludeByGenre?: Record<string, Iterable<string>> }} [options]
 */
function allGenreCapacityStats(options = {}) {
    return listGenres().map((id) =>
        genreCapacityStats(id, {
            sampleSize: options.sampleSize,
            seed: options.seed,
            exclude: options.excludeByGenre ? options.excludeByGenre[id] : undefined
        })
    );
}

/**
 * @param {string} text
 * @returns {Set<string>}
 */
function parseDoneList(text) {
    const set = new Set();
    if (!text) return set;
    for (const line of text.split(/\r?\n/)) {
        const name = line.trim();
        // Support "technical" or "technical\talias" lines
        if (!name) continue;
        const technical = name.split('\t')[0].trim();
        if (technical) set.add(technical);
    }
    return set;
}

/**
 * Audit free-text names for restricted terms.
 * @param {string[]} names
 * @returns {{ total: number, flagged: Array<{ name: string, hits: Array<[string, string]> }> }}
 */
function auditNames(names) {
    const flagged = [];
    for (const name of names) {
        const hits = findRestricted(name);
        if (hits.length) flagged.push({ name, hits });
    }
    return { total: names.length, flagged };
}

/**
 * @returns {string[]}
 */
function listGenres() {
    return Object.keys(BANKS);
}

module.exports = {
    RESTRICTED_TERMS,
    BANKS,
    generateNames,
    generateOne,
    buildAlias,
    buildAliasCandidates,
    findRestricted,
    parseDoneList,
    auditNames,
    listGenres,
    bankStats,
    genreCapacityStats,
    allGenreCapacityStats,
    mulberry32
};
