#!/usr/bin/env node
/**
 * Rebuild presets/standard/creatures from presets/legacy/creatures using
 * other/content_maps/legacy_to_standard_names.csv (commercial-safe labels/ids).
 *
 *   node bin/port_creatures_standard.js
 *   node bin/port_creatures_standard.js --dry-run
 *   node bin/port_creatures_standard.js --apply-p0-p1   # update CSV renames first
 *   node bin/port_creatures_standard.js --csv-only        # only write CSV (with --apply-p0-p1)
 *
 * Strips copy-fingerprint fields from standard output:
 *   top-level + nested legacyName, notes that echo legacy names, sprite.legacy
 *
 * Hand-authored templates preserved whole-file: dummy, venom_spitter
 *
 * Standard-only art overrides preserved by id across re-port (not present on
 * legacy): customSprite, customSpriteGenre. Lost only if the standardId itself
 * renames (P0/P1 id change) — override lived on the old stem.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { formatJson } = require('../kernel/core/lib/json_format.js');

const ROOT = path.resolve(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'presets', 'legacy', 'creatures');
const STANDARD_DIR = path.join(ROOT, 'presets', 'standard', 'creatures');
function resolveNameCsv() {
    const cands = [
        path.join(ROOT, 'other', 'content_maps', 'legacy_to_standard_names.csv'),
        path.join(ROOT, 'other', 'legacy_to_standard_names.csv')
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    return cands[0];
}
const CSV_PATH = resolveNameCsv();
const MODE_PATH = path.join(ROOT, 'presets', 'standard', 'mode.json');

/** Never overwrite / delete these standard ids (hand-authored). */
const PRESERVE_IDS = new Set(['dummy', 'venom_spitter']);

/**
 * Art fields that live only on standard (designer / map_sprites) and must
 * survive a combat re-port from legacy. Matched by standardId (file stem).
 */
const PRESERVE_ART_FIELDS = ['customSprite', 'customSpriteGenre'];

/**
 * Identity rows missing from an older CSV export but present in legacy presets.
 * Merged when loading the map so regen does not drop common baseline mobs.
 */
const EXTRA_IDENTITY_ROWS = [
    { legacyName: 'Cave Rat', standardName: 'Cave Rat', standardId: 'cave_rat' }
];

// ---------------------------------------------------------------------------
// P0 + P1 commercial-safe renames (applied to Standard Name via --apply-p0-p1)
// Longest keys first. Values are display labels (title-cased as stored).
// ---------------------------------------------------------------------------

/** Full-name exact map (case-insensitive key → Standard Name). */
const EXACT_RENAMES = {
    // P0 — sibling gaps
    'shaburak demon': 'Fiendish Ember Demon',
    'shaburak lord': 'Fiendish Ember Lord',
    'shaburak prince': 'Fiendish Ember Prince',
    "mooh'tah master": 'Bovine Master',
    "mooh'tah warrior": 'Bovine Warrior',
    "fallen mooh'tah master ghar": 'Fallen Bovine Master',
    'orclops doomhauler': 'Orc Colossus Hauler',
    'orclops ravager': 'Orc Colossus Ravager',
    vexclaw: 'Fel Claw',
    mawhawk: 'Maw Tyrant',
    'reflection of mawhawk': 'Reflection Of Maw Tyrant',
    yalahari: 'Pale Aristocrat',
    'memory of a yalahari': 'Memory Of A Pale Aristocrat',
    'yalahari despoiler': 'Pale Despoiler',
    minishabaal: 'Lesser Doom Demon',
    bullwark: 'Bovine Bulwark',

    // P1 — Sleep (Roshamuul)
    feversleep: 'Fever Dreamer',
    terrorsleep: 'Terror Dreamer',
    shiversleep: 'Shiver Dreamer',

    // P1 — Otherworld
    sparkion: 'Spark Fiend',
    'instable sparkion': 'Instable Spark Fiend',
    'breach brood': 'Rift Brood',
    'instable breach brood': 'Instable Rift Brood',
    'dread intruder': 'Void Intruder',
    'stabilizing dread intruder': 'Stabilizing Void Intruder',
    'reality reaver': 'Reality Ripper',
    'stabilizing reality reaver': 'Stabilizing Reality Ripper',
    'ravenous beyondling': 'Ravenous Voidling',

    // P1 — Warzone mobs (not named bosses)
    weeper: 'Stone Weeper',
    'infected weeper': 'Infected Stone Weeper',
    orewalker: 'Ore Walker',
    'cliff strider': 'Cliff Giant',
    'stone devourer': 'Rock Devourer',
    'magma crawler': 'Magma Creeper',
    'lava lurker': 'Lava Ambusher',
    'lava lurker attendant': 'Lava Ambusher Attendant',
    'ravenous lava lurker': 'Ravenous Lava Ambusher',
    'hideous fungus': 'Hideous Spore Mass',
    'humongous fungus': 'Giant Spore Mass',

    // P1 — Hive coinages (generic Insectoid* already ok)
    crawler: 'Hive Crawler',
    spitter: 'Hive Spitter',
    swarmer: 'Hive Swarmer',
    'hive pore': 'Hive Spore Vent',

    // P1 — Soul War
    brachiodemon: 'Armored Demon',
    'capricious phantom': 'Capricious Wraith',
    'infernal phantom': 'Infernal Wraith',
    'distorted phantom': 'Distorted Wraith',
    'hazardous phantom': 'Hazardous Wraith',
    'mould phantom': 'Mould Wraith',
    'rift phantom': 'Rift Wraith',
    'vibrant phantom': 'Vibrant Wraith',
    'cloak of terror': 'Terror Cloak',
    'bony sea devil': 'Bony Sea Fiend',
    'many faces': 'Many-Faced Horror',
    'branchy crawler': 'Branch Crawler',
    'courage leech': 'Courage Siphon',
    'rotten golem': 'Rotting Golem',
    "druid's apparition": 'Druid Shade',
    "knight's apparition": 'Knight Shade',
    "paladin's apparition": 'Paladin Shade',
    "sorcerer's apparition": 'Sorcerer Shade',
    'darklight construct': 'Gloomlight Construct',
    'darklight emitter': 'Gloomlight Emitter',
    'darklight matter': 'Gloomlight Matter',
    'darklight source': 'Gloomlight Source',
    'darklight striker': 'Gloomlight Striker',
    'rotten man-maggot': 'Rotten Maggot Man',
    'meandering mushroom': 'Wandering Mushroom',
    'mycobiontic beetle': 'Fungal Beetle',

    // P1 — Library
    'biting book': 'Razor Tome',
    'burning book': 'Ember Tome',
    'icecold book': 'Frost Tome',
    'energetic book': 'Spark Tome',
    'cursed book': 'Cursed Tome',
    'flying book': 'Flying Tome',
    'brain squid': 'Mind Squid',
    'rage squid': 'Fury Squid',
    'squid warden': 'Mind Squid Warden',
    'squidgy slime': 'Inky Slime',
    'floating savant': 'Floating Scholar',
    'ink blob': 'Ink Ooze',
    'knowledge elemental': 'Lore Elemental',
    'guardian of tales': 'Lore Guardian',
    'energuardian of tales': 'Energy Lore Guardian',
    'animated feather': 'Animated Quill',
    'memory of a book': 'Memory Of A Tome',

    // P1 — Bastion coinages
    carnivostrich: 'Carnivore Ostrich',
    mantosaurus: 'Mantis Lizard',
    gorerilla: 'Gore Ape',
    rhindeer: 'Rhino Deer',
    headpecker: 'Skull Beak',
    nighthunter: 'Night Hunter',
    sulphider: 'Sulfur Crawler',
    'sulphur spouter': 'Sulfur Spouter',
    'gore horn': 'Gore Hornbeast',
    'noxious ripptor': 'Noxious Raptor',
    undertaker: 'Tomb Beetle',

    // P1 — Barkless / Oramond
    'barkless devotee': 'Barkstripped Devotee',
    'barkless fanatic': 'Scarred Cultist',
    'worm priestess': 'Serpent Priestess',

    // P1 — Strong coinages (descriptive splits / renames)
    bonebeast: 'Bone Beast',
    drillworm: 'Drill Worm',
    nightstalker: 'Night Stalker',
    deathbine: 'Death Vine',
    'bane bringer': 'Doom Herald',
    draptor: 'Drake Raptor',
    gnarlhound: 'Gnash Hound',
    'modified gnarlhound': 'Modified Gnash Hound',
    stampor: 'Stomp Rhino',
    gozzler: 'Guzzle Fiend',
    swampling: 'Swampling',
    armadile: 'Armored Crawler',
    crystalcrusher: 'Crystal Crusher',
    thanatursus: 'Death Bear',
    liodile: 'Lion Croc',
    vulcongra: 'Magma Ape',
    kongra: 'Jungle Ape',
    merlkin: 'Jungle Ape Mage',
    sibang: 'Jungle Ape Scout'
};

/**
 * Phrase / family replacements applied when no exact match.
 * Longest `from` first. Word-boundary, case-insensitive.
 * `to` is inserted as-is then the whole label is re-title-cased.
 */
const PHRASE_RENAMES = [
    // P0 family leftovers
    ["mooh'tah", 'Bovine'],
    ['shaburak', 'Fiendish Ember'],
    ['orclops', 'Orc Colossus'],
    ['yalahari', 'Pale Aristocrat'],
    ['mawhawk', 'Maw Tyrant'],
    ['vexclaw', 'Fel Claw'],
    ['minishabaal', 'Lesser Doom Demon'],
    ['bullwark', 'Bovine Bulwark'],

    // P1 families
    ['feversleep', 'Fever Dreamer'],
    ['terrorsleep', 'Terror Dreamer'],
    ['shiversleep', 'Shiver Dreamer'],
    ['sparkion', 'Spark Fiend'],
    ['breach brood', 'Rift Brood'],
    ['dread intruder', 'Void Intruder'],
    ['reality reaver', 'Reality Ripper'],
    ['beyondling', 'Voidling'],
    ['infected weeper', 'Infected Stone Weeper'],
    ['weeper', 'Stone Weeper'],
    ['orewalker', 'Ore Walker'],
    ['cliff strider', 'Cliff Giant'],
    ['stone devourer', 'Rock Devourer'],
    ['magma crawler', 'Magma Creeper'],
    ['lava lurker', 'Lava Ambusher'],
    ['hideous fungus', 'Hideous Spore Mass'],
    ['humongous fungus', 'Giant Spore Mass'],
    ['brachiodemon', 'Armored Demon'],
    ['cloak of terror', 'Terror Cloak'],
    ['bony sea devil', 'Bony Sea Fiend'],
    ['branchy crawler', 'Branch Crawler'],
    ['courage leech', 'Courage Siphon'],
    ['darklight', 'Gloomlight'],
    ["druid's apparition", 'Druid Shade'],
    ["knight's apparition", 'Knight Shade'],
    ["paladin's apparition", 'Paladin Shade'],
    ["sorcerer's apparition", 'Sorcerer Shade'],
    ['biting book', 'Razor Tome'],
    ['burning book', 'Ember Tome'],
    ['icecold book', 'Frost Tome'],
    ['energetic book', 'Spark Tome'],
    ['cursed book', 'Cursed Tome'],
    ['flying book', 'Flying Tome'],
    ['brain squid', 'Mind Squid'],
    ['rage squid', 'Fury Squid'],
    ['squid warden', 'Mind Squid Warden'],
    ['floating savant', 'Floating Scholar'],
    ['ink blob', 'Ink Ooze'],
    ['knowledge elemental', 'Lore Elemental'],
    ['energuardian of tales', 'Energy Lore Guardian'],
    ['guardian of tales', 'Lore Guardian'],
    ['animated feather', 'Animated Quill'],
    ['carnivostrich', 'Carnivore Ostrich'],
    ['mantosaurus', 'Mantis Lizard'],
    ['gorerilla', 'Gore Ape'],
    ['rhindeer', 'Rhino Deer'],
    ['headpecker', 'Skull Beak'],
    ['nighthunter', 'Night Hunter'],
    ['sulphider', 'Sulfur Crawler'],
    ['sulphur spouter', 'Sulfur Spouter'],
    ['noxious ripptor', 'Noxious Raptor'],
    ['barkless devotee', 'Barkstripped Devotee'],
    ['barkless fanatic', 'Scarred Cultist'],
    ['barkless', 'Barkstripped'],
    ['worm priestess', 'Serpent Priestess'],
    ['bonebeast', 'Bone Beast'],
    ['drillworm', 'Drill Worm'],
    ['nightstalker', 'Night Stalker'],
    ['deathbine', 'Death Vine'],
    ['bane bringer', 'Doom Herald'],
    ['draptor', 'Drake Raptor'],
    ['gnarlhound', 'Gnash Hound'],
    ['stampor', 'Stomp Rhino'],
    ['gozzler', 'Guzzle Fiend'],
    ['swampling', 'Swampling'],
    ['armadile', 'Armored Crawler'],
    ['crystalcrusher', 'Crystal Crusher'],
    ['thanatursus', 'Death Bear'],
    ['liodile', 'Lion Croc'],
    ['vulcongra', 'Magma Ape'],
    ['kongra', 'Jungle Ape'],
    ['merlkin', 'Jungle Ape Mage'],
    ['sibang', 'Jungle Ape Scout'],
    ['mycobiontic beetle', 'Fungal Beetle'],
    ['meandering mushroom', 'Wandering Mushroom'],
    ['rotten man-maggot', 'Rotten Maggot Man'],
    ['capricious phantom', 'Capricious Wraith'],
    ['infernal phantom', 'Infernal Wraith'],
    ['distorted phantom', 'Distorted Wraith'],
    ['hazardous phantom', 'Hazardous Wraith'],
    ['mould phantom', 'Mould Wraith'],
    ['rift phantom', 'Rift Wraith'],
    ['vibrant phantom', 'Vibrant Wraith']
].sort((a, b) => b[0].length - a[0].length);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const opts = {
        dryRun: false,
        applyP0P1: false,
        csvOnly: false,
        quiet: false
    };
    for (const a of argv) {
        if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--apply-p0-p1') opts.applyP0P1 = true;
        else if (a === '--csv-only') opts.csvOnly = true;
        else if (a === '--quiet' || a === '-q') opts.quiet = true;
        else if (a === '--help' || a === '-h') {
            console.log(`Usage: node bin/port_creatures_standard.js [options]
  --apply-p0-p1   Apply P0+P1 renames to other/content_maps/legacy_to_standard_names.csv first
  --csv-only      Only update/write the CSV (no creature files)
  --dry-run       Report only (no writes)
  --quiet         Less logging`);
            process.exit(0);
        }
    }
    return opts;
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Title-case label; keep apostrophe-s lowercase (Monarch's). */
function titleCaseLabel(s) {
    return String(s)
        .split(/(\s+|-+)/)
        .map((part) => {
            if (!part || /^[\s-]+$/.test(part)) return part;
            const m = part.match(/^([A-Za-z0-9]+)('s)$/i);
            if (m) {
                return (
                    m[1].charAt(0).toUpperCase() +
                    m[1].slice(1).toLowerCase() +
                    "'s"
                );
            }
            if (/^[A-Za-z]/.test(part)) {
                return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            }
            return part;
        })
        .join('');
}

function labelToId(label) {
    return String(label)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * @param {string} standardName
 * @returns {{ name: string, changed: boolean }}
 */
function applyP0P1Rename(standardName) {
    const original = String(standardName || '').trim();
    if (!original) return { name: original, changed: false };

    const lower = original.toLowerCase();
    if (EXACT_RENAMES[lower]) {
        const name = EXACT_RENAMES[lower];
        return { name, changed: name.toLowerCase() !== lower };
    }

    let out = original;
    let changed = false;
    for (const [from, to] of PHRASE_RENAMES) {
        const re = new RegExp(`\\b${escapeRegex(from)}\\b`, 'gi');
        if (re.test(out)) {
            out = out.replace(re, to);
            changed = true;
        }
    }
    if (!changed) return { name: original, changed: false };
    return { name: titleCaseLabel(out), changed: true };
}

/**
 * Parse CSV with quoted fields. Expects header:
 * Legacy Name,Standard Name,Standard ID
 * @param {string} text
 * @returns {{ legacyName: string, standardName: string, standardId: string }[]}
 */
function parseNameMapCsv(text) {
    const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
    if (!lines.length) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const cols = parseCsvLine(line);
        if (cols.length < 3) continue;
        rows.push({
            legacyName: cols[0],
            standardName: cols[1],
            standardId: cols[2]
        });
    }
    return rows;
}

/** Minimal CSV line parser for quoted fields. */
function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQ = false;
                }
            } else {
                cur += ch;
            }
        } else if (ch === '"') {
            inQ = true;
        } else if (ch === ',') {
            out.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function csvEscape(s) {
    const t = String(s ?? '');
    if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return `"${t}"`;
}

function formatNameMapCsv(rows) {
    let out = 'Legacy Name,Standard Name,Standard ID\n';
    for (const r of rows) {
        out +=
            `${csvEscape(r.legacyName)},${csvEscape(r.standardName)},${csvEscape(r.standardId)}\n`;
    }
    return out;
}

/**
 * Ensure unique standardId across rows (keep first; suffix later collisions).
 * @param {{ legacyName: string, standardName: string, standardId: string }[]} rows
 */
function uniquifyStandardIds(rows) {
    const used = new Map();
    for (const r of rows) {
        let id = r.standardId || labelToId(r.standardName);
        if (!id) id = 'unnamed';
        if (!used.has(id)) {
            used.set(id, 1);
            r.standardId = id;
            continue;
        }
        let n = used.get(id) + 1;
        let candidate = `${id}_${n}`;
        while (used.has(candidate)) {
            n += 1;
            candidate = `${id}_${n}`;
        }
        used.set(id, n);
        used.set(candidate, 1);
        r.standardId = candidate;
    }
}

/**
 * Remove fields that fingerprint a legacy OTBM port.
 * @param {object} data
 */
function stripCopyFingerprints(data) {
    if (!data || typeof data !== 'object') return;

    delete data.legacyName;

    if (data.sprite && typeof data.sprite === 'object') {
        delete data.sprite.legacy;
        if (Object.keys(data.sprite).length === 0) delete data.sprite;
    }

    // Walk nested objects/arrays for attack/spell legacyName
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
        }
        delete node.legacyName;
        for (const v of Object.values(node)) walk(v);
    };
    walk(data);
}

/**
 * Neutral notes from standard label (no legacy coinage).
 * @param {string} standardName
 */
function standardNotes(standardName) {
    const n = String(standardName || 'creature').trim();
    if (!n) return undefined;
    const lower = n.toLowerCase();
    const article = /^[aeiou]/i.test(lower) ? 'An' : 'A';
    return `${article} ${lower}.`;
}

/**
 * @param {string} a
 * @param {string} b
 */
function normKey(a) {
    return String(a || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

function applyP0P1ToRows(rows) {
    let changed = 0;
    for (const r of rows) {
        const { name, changed: did } = applyP0P1Rename(r.standardName);
        if (did) {
            r.standardName = name;
            r.standardId = labelToId(name);
            changed += 1;
        } else if (!r.standardId) {
            r.standardId = labelToId(r.standardName);
        }
    }
    uniquifyStandardIds(rows);
    return changed;
}

/**
 * @param {{ legacyName: string, standardName: string, standardId: string }[]} rows
 * @returns {Map<string, { standardName: string, standardId: string }>}
 */
function buildLegacyLookup(rows) {
    /** @type {Map<string, { standardName: string, standardId: string }>} */
    const map = new Map();
    for (const r of rows) {
        const key = normKey(r.legacyName);
        if (!key) continue;
        // First wins for duplicate legacy names
        if (!map.has(key)) {
            map.set(key, {
                standardName: r.standardName,
                standardId: r.standardId
            });
        }
    }
    return map;
}

function regenerateCreatures(lookup, opts) {
    if (!fs.existsSync(LEGACY_DIR)) {
        throw new Error(
            `Missing ${LEGACY_DIR} — expected presets/legacy/creatures/. ` +
                'Restore with: git checkout legacy -- presets/legacy'
        );
    }
    if (!fs.existsSync(STANDARD_DIR) && !opts.dryRun) {
        fs.mkdirSync(STANDARD_DIR, { recursive: true });
    }

    const legacyFiles = fs
        .readdirSync(LEGACY_DIR)
        .filter((f) => f.endsWith('.json'));

    // Collect hand-authored preserve files + standard-only art overrides
    /** @type {Map<string, object>} */
    const preserved = new Map();
    /**
     * standardId → { customSprite?, customSpriteGenre? } from existing standard
     * before wipe. Re-applied after combat fields are copied from legacy.
     * @type {Map<string, Record<string, string>>}
     */
    const artOverrides = new Map();
    if (fs.existsSync(STANDARD_DIR)) {
        for (const id of PRESERVE_IDS) {
            const p = path.join(STANDARD_DIR, `${id}.json`);
            if (fs.existsSync(p)) {
                preserved.set(id, JSON.parse(fs.readFileSync(p, 'utf8')));
            }
        }
        for (const file of fs.readdirSync(STANDARD_DIR).filter((f) => f.endsWith('.json'))) {
            const stem = file.replace(/\.json$/, '');
            if (PRESERVE_IDS.has(stem)) continue;
            let prev;
            try {
                prev = JSON.parse(fs.readFileSync(path.join(STANDARD_DIR, file), 'utf8'));
            } catch {
                continue;
            }
            if (!prev || typeof prev !== 'object') continue;
            /** @type {Record<string, string>} */
            const art = {};
            for (const key of PRESERVE_ART_FIELDS) {
                const v = prev[key];
                if (v != null && String(v).trim()) art[key] = String(v).trim();
            }
            if (Object.keys(art).length) artOverrides.set(stem, art);
        }
    }

    // Remove previous pipeline outputs (not hand-authored)
    let removed = 0;
    if (fs.existsSync(STANDARD_DIR) && !opts.dryRun) {
        for (const file of fs.readdirSync(STANDARD_DIR).filter((f) => f.endsWith('.json'))) {
            const stem = file.replace(/\.json$/, '');
            if (PRESERVE_IDS.has(stem)) continue;
            fs.unlinkSync(path.join(STANDARD_DIR, file));
            removed += 1;
        }
    }

    let written = 0;
    let unmapped = 0;
    let skippedPreserve = 0;
    let artRestored = 0;
    /** @type {string[]} */
    const unmappedSamples = [];
    /** @type {Set<string>} */
    const writtenIds = new Set();
    /** @type {string[]} */
    const collisions = [];

    for (const file of legacyFiles) {
        const filePath = path.join(LEGACY_DIR, file);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        const legacyLabel = data.label || data.legacyName || file.replace(/\.json$/, '');
        const keys = [normKey(data.legacyName), normKey(data.label), normKey(legacyLabel)].filter(
            Boolean
        );
        let mapped = null;
        for (const k of keys) {
            if (lookup.has(k)) {
                mapped = lookup.get(k);
                break;
            }
        }

        if (!mapped) {
            unmapped += 1;
            if (unmappedSamples.length < 12) unmappedSamples.push(legacyLabel);
            continue;
        }

        if (PRESERVE_IDS.has(mapped.standardId)) {
            skippedPreserve += 1;
            continue;
        }

        if (writtenIds.has(mapped.standardId)) {
            collisions.push(
                `${legacyLabel} → ${mapped.standardId} (already written)`
            );
            continue;
        }

        const out = { ...data };
        out.id = mapped.standardId;
        out.label = mapped.standardName;
        out.source = 'pipeline';
        out.notes = standardNotes(mapped.standardName);
        stripCopyFingerprints(out);

        // Drop art fields that may have come from legacy (standard owns these).
        for (const key of PRESERVE_ART_FIELDS) delete out[key];

        const prevArt = artOverrides.get(mapped.standardId);
        if (prevArt) {
            Object.assign(out, prevArt);
            artRestored += 1;
        }

        writtenIds.add(mapped.standardId);
        written += 1;

        if (!opts.dryRun) {
            const dest = path.join(STANDARD_DIR, `${mapped.standardId}.json`);
            fs.writeFileSync(dest, formatJson(out));
        }
    }

    // Restore hand-authored
    for (const [id, body] of preserved) {
        if (!opts.dryRun) {
            fs.writeFileSync(
                path.join(STANDARD_DIR, `${id}.json`),
                formatJson(body)
            );
        }
        writtenIds.add(id);
    }

    // mode.json browser.creatures
    let modeUpdated = false;
    if (fs.existsSync(MODE_PATH)) {
        const modeData = JSON.parse(fs.readFileSync(MODE_PATH, 'utf8'));
        const allIds = [...writtenIds].sort();
        if (!modeData.browser) modeData.browser = {};
        modeData.browser.creatures = allIds;
        if (!opts.dryRun) {
            fs.writeFileSync(MODE_PATH, formatJson(modeData));
        }
        modeUpdated = true;
    }

    return {
        legacyFiles: legacyFiles.length,
        written,
        removed,
        unmapped,
        unmappedSamples,
        skippedPreserve,
        collisions,
        preserved: preserved.size,
        artOverrides: artOverrides.size,
        artRestored,
        modeUpdated,
        totalStandardIds: writtenIds.size
    };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (!fs.existsSync(CSV_PATH)) {
        console.error(`Missing ${CSV_PATH}`);
        process.exit(1);
    }

    let rows = parseNameMapCsv(fs.readFileSync(CSV_PATH, 'utf8'));
    if (!rows.length) {
        console.error(`No rows in ${CSV_PATH}`);
        process.exit(1);
    }

    // Fill known gaps (baseline mobs absent from the CSV export)
    const haveLegacy = new Set(rows.map((r) => normKey(r.legacyName)));
    for (const extra of EXTRA_IDENTITY_ROWS) {
        if (!haveLegacy.has(normKey(extra.legacyName))) {
            rows.push({ ...extra });
            haveLegacy.add(normKey(extra.legacyName));
        }
    }

    let renameCount = 0;
    if (opts.applyP0P1) {
        renameCount = applyP0P1ToRows(rows);
        if (!opts.quiet) {
            console.log(`P0+P1: renamed ${renameCount} standard names in CSV map`);
        }
        if (!opts.dryRun) {
            fs.writeFileSync(CSV_PATH, formatNameMapCsv(rows));
            if (!opts.quiet) console.log(`Wrote ${CSV_PATH}`);
        }
    }

    if (opts.csvOnly) {
        if (opts.dryRun && !opts.quiet) {
            console.log(`Dry-run: would write ${rows.length} CSV rows`);
        }
        return;
    }

    const lookup = buildLegacyLookup(rows);
    const stats = regenerateCreatures(lookup, opts);

    if (!opts.quiet) {
        console.log('port standard creatures');
        console.log(`  csv rows:        ${rows.length}`);
        console.log(`  lookup keys:     ${lookup.size}`);
        console.log(`  legacy files:    ${stats.legacyFiles}`);
        console.log(`  written:         ${stats.written}${opts.dryRun ? ' (dry-run)' : ''}`);
        console.log(`  removed old:     ${stats.removed}${opts.dryRun ? ' (skipped)' : ''}`);
        console.log(`  preserved:       ${stats.preserved} (${[...PRESERVE_IDS].join(', ')})`);
        console.log(
            `  art restored:    ${stats.artRestored} / ${stats.artOverrides} (customSprite/customSpriteGenre)`
        );
        console.log(`  unmapped:        ${stats.unmapped}`);
        if (stats.unmappedSamples.length) {
            console.log(`    e.g. ${stats.unmappedSamples.join(' | ')}`);
        }
        if (stats.collisions.length) {
            console.log(`  id collisions skipped: ${stats.collisions.length}`);
            for (const c of stats.collisions.slice(0, 8)) console.log(`    ${c}`);
        }
        console.log(`  total standard:  ${stats.totalStandardIds}`);
        if (stats.modeUpdated) console.log(`  updated ${MODE_PATH}`);
    }

    // Quick fingerprint audit on a sample written file
    if (!opts.dryRun && stats.written > 0) {
        const sampleId = [...buildLegacyLookup(rows).values()][0]?.standardId;
        if (sampleId && !PRESERVE_IDS.has(sampleId)) {
            const samplePath = path.join(STANDARD_DIR, `${sampleId}.json`);
            if (fs.existsSync(samplePath)) {
                const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
                const bad =
                    sample.legacyName != null ||
                    (sample.sprite && sample.sprite.legacy) ||
                    (Array.isArray(sample.attacks) &&
                        sample.attacks.some((a) => a && a.legacyName != null));
                if (bad) {
                    console.error('Fingerprint strip failed on sample', sampleId);
                    process.exit(1);
                }
            }
        }
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    applyP0P1Rename,
    parseNameMapCsv,
    formatNameMapCsv,
    stripCopyFingerprints,
    labelToId,
    titleCaseLabel,
    EXACT_RENAMES
};
