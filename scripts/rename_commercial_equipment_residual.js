#!/usr/bin/env node
/**
 * One-shot: rename commercial-residual equipment (+ linked spells) to safer ids/labels.
 * When customSprite === old id, rename sprite files across size folders so pipeline
 * inventory keeps the art keyed to the new id.
 *
 * Usage: node scripts/rename_commercial_equipment_residual.js [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

/** @type {Record<string, { id: string, label: string }>} */
const EQUIPMENT = {
    // Named weapons / pin art
    assassin_star: { id: 'nightshade_star', label: 'Nightshade Star' },
    the_devileye: { id: 'infernal_gaze', label: 'Infernal Gaze' },
    warsinger_bow: { id: 'battle_hymn_bow', label: 'Battle Hymn Bow' },
    mycological_bow: { id: 'sporewood_bow', label: 'Sporewood Bow' },
    mycological_mace: { id: 'sporewood_mace', label: 'Sporewood Mace' },
    crystal_crossbow: { id: 'prism_crossbow', label: 'Prism Crossbow' },
    triple_bolt_crossbow: { id: 'tribolt_crossbow', label: 'Tribolt Crossbow' },
    heavy_arbalest: { id: 'siege_arbalest', label: 'Siege Arbalest' },
    // Ammo
    thunderstorm_arrow: { id: 'stormlash_arrow', label: 'Stormlash Arrow' },
    // Classic combat runes
    sudden_death_rune: { id: 'deathburst_rune', label: 'Deathburst Rune' },
    great_fireball_rune: { id: 'grand_fireburst_rune', label: 'Grand Fireburst Rune' },
    thunderstorm_rune: { id: 'stormlash_rune', label: 'Stormlash Rune' },
    avalanche_rune: { id: 'rockfall_rune', label: 'Rockfall Rune' },
    holy_missile_rune: { id: 'radiant_bolt_rune', label: 'Radiant Bolt Rune' },
    light_magic_missile_rune: { id: 'lesser_arc_bolt_rune', label: 'Lesser Arc Bolt Rune' },
    heavy_magic_missile_rune: { id: 'greater_arc_bolt_rune', label: 'Greater Arc Bolt Rune' },
    stalagmite_rune: { id: 'stone_spike_rune', label: 'Stone Spike Rune' },
    fireball_rune: { id: 'fireburst_rune', label: 'Fireburst Rune' },
    icicle_rune: { id: 'frost_spike_rune', label: 'Frost Spike Rune' },
    stone_shower_rune: { id: 'gravel_rain_rune', label: 'Gravel Rain Rune' },
    explosion_rune: { id: 'blastwave_rune', label: 'Blastwave Rune' },
    // Field / bomb / wall runes
    poison_field_rune: { id: 'venom_field_rune', label: 'Venom Field Rune' },
    fire_field_rune: { id: 'blaze_field_rune', label: 'Blaze Field Rune' },
    destroy_field_rune: { id: 'purge_field_rune', label: 'Purge Field Rune' },
    energy_field_rune: { id: 'spark_field_rune', label: 'Spark Field Rune' },
    poison_bomb_rune: { id: 'venom_bomb_rune', label: 'Venom Bomb Rune' },
    fire_bomb_rune: { id: 'blaze_bomb_rune', label: 'Blaze Bomb Rune' },
    poison_wall_rune: { id: 'venom_wall_rune', label: 'Venom Wall Rune' },
    fire_wall_rune: { id: 'blaze_wall_rune', label: 'Blaze Wall Rune' },
    energy_bomb_rune: { id: 'spark_bomb_rune', label: 'Spark Bomb Rune' },
    energy_wall_rune: { id: 'spark_wall_rune', label: 'Spark Wall Rune' },
    // "The …" and classic kit residuals
    the_avenger: { id: 'vengeance_blade', label: 'Vengeance Blade' },
    the_calamity: { id: 'calamity_edge', label: 'Calamity Edge' },
    the_chiller: { id: 'frostbite_wand', label: 'Frostbite Wand' },
    the_epic_wisdom: { id: 'epic_wisdom_cap', label: 'Epic Wisdom Cap' },
    the_epiphany: { id: 'epiphany_blade', label: 'Epiphany Blade' },
    the_eye_of_suon: { id: 'sun_eye_amulet', label: 'Sun Eye Amulet' },
    the_ironworker: { id: 'ironworker_crossbow', label: 'Ironworker Crossbow' },
    the_justice_seeker: { id: 'justice_seeker', label: 'Justice Seeker' },
    the_rain_coat: { id: 'stormcloak', label: 'Stormcloak' },
    the_scorcher: { id: 'scorcher_wand', label: 'Scorcher Wand' },
    the_shield_nevermourn: { id: 'nevermourn_shield', label: 'Nevermourn Shield' },
    the_stomper: { id: 'stomper_maul', label: 'Stomper Maul' },
    the_asp_amulet: { id: 'asp_amulet', label: 'Asp Amulet' },
    helmet_of_the_ancients: { id: 'ancient_kings_helm', label: 'Ancient Kings Helm' },
    helmet_of_the_ancients_enchanted: {
        id: 'ancient_kings_helm_enchanted',
        label: 'Ancient Kings Helm (Enchanted)'
    },
    helmet_of_the_deep: { id: 'abyssal_helm', label: 'Abyssal Helm' },
    helmet_of_the_lost: { id: 'lost_wanderer_helm', label: 'Lost Wanderer Helm' },
    robe_of_the_ice_queen: { id: 'frost_queen_robe', label: 'Frost Queen Robe' },
    robe_of_the_underworld: { id: 'underworld_robe', label: 'Underworld Robe' },
    magic_sword: { id: 'arcane_blade', label: 'Arcane Blade' },
    golden_armor: { id: 'gilded_plate', label: 'Gilded Plate' },
    steel_helmet: { id: 'steel_casque', label: 'Steel Casque' },
    claw_of_the_noxious_spawn: { id: 'noxious_spawn_claw', label: 'Noxious Spawn Claw' },
    ron_the_rippers_sabre: { id: 'ripper_sabre', label: 'Ripper Sabre' },
    shield_of_the_white_knight: { id: 'white_knight_shield', label: 'White Knight Shield' },
    hat_of_the_mad: { id: 'madcap_hat', label: 'Madcap Hat' },
    club_of_the_fury: { id: 'fury_club', label: 'Fury Club' },
    crest_of_the_deep_seas: { id: 'deep_sea_crest', label: 'Deep Sea Crest' },
    eye_of_the_storm: { id: 'storm_eye_lantern', label: 'Storm Eye Lantern' },
    heart_of_the_pride: { id: 'pride_heart_amulet', label: 'Pride Heart Amulet' },
    necklace_of_the_deep: { id: 'deep_sea_necklace', label: 'Deep Sea Necklace' },
    scythe_of_the_reaper: { id: 'reaper_scythe', label: 'Reaper Scythe' },
    spellbook_of_the_novice: { id: 'novice_spellbook', label: 'Novice Spellbook' },
    trousers_of_the_ancients: { id: 'ancient_legwraps', label: 'Ancient Legwraps' },
    true_heart_of_the_sea: { id: 'sea_heart_lantern', label: 'Sea Heart Lantern' },
    visage_of_the_end_days: { id: 'end_days_visage', label: 'End Days Visage' },
    skewering_spear_of_the_igniter: { id: 'igniter_spear', label: 'Igniter Spear' },
    crown_of_the_yule_queen_fire: {
        id: 'yule_queen_crown_fire',
        label: 'Yule Queen Crown (Fire)'
    },
    crown_of_the_yule_queen_ice: {
        id: 'yule_queen_crown_ice',
        label: 'Yule Queen Crown (Ice)'
    }
};

/** Spell id/label renames (classic combat runes; field spells share equipment ids). */
const SPELLS = {
    sudden_death: { id: 'deathburst', label: 'Deathburst' },
    great_fireball: { id: 'grand_fireburst', label: 'Grand Fireburst' },
    thunderstorm: { id: 'stormlash', label: 'Stormlash' },
    avalanche: { id: 'rockfall', label: 'Rockfall' },
    holy_missile: { id: 'radiant_bolt', label: 'Radiant Bolt' },
    light_magic_missile: { id: 'lesser_arc_bolt', label: 'Lesser Arc Bolt' },
    heavy_magic_missile: { id: 'greater_arc_bolt', label: 'Greater Arc Bolt' },
    stalagmite: { id: 'stone_spike', label: 'Stone Spike' },
    fireball: { id: 'fireburst', label: 'Fireburst' },
    icicle: { id: 'frost_spike', label: 'Frost Spike' },
    stone_shower: { id: 'gravel_rain', label: 'Gravel Rain' },
    explosion: { id: 'blastwave', label: 'Blastwave' }
};

const SPRITE_DIRS = ['original', 'alpha', 'medium', 'small', 'icon', 'retro'];
const GENRE = 'rpg_fantasy';

function snakeToTitleFile(id) {
    return (
        String(id)
            .split('_')
            .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
            .join('_') + '.png'
    );
}

function loadJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
    if (DRY) return;
    fs.writeFileSync(p, JSON.stringify(data, null, 4) + '\n', 'utf8');
}

function walkFiles(dir, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'build') continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkFiles(p, acc);
        else acc.push(p);
    }
    return acc;
}

function replaceIdsInText(text, pairs) {
    // longest first
    const sorted = pairs.slice().sort((a, b) => b.from.length - a.from.length);
    let out = text;
    for (const { from, to } of sorted) {
        // word-ish boundary: not [a-z0-9_] before/after
        const re = new RegExp(`(?<![a-z0-9_])${from.replace(/_/g, '_')}(?![a-z0-9_])`, 'g');
        out = out.replace(re, to);
    }
    return out;
}

function replaceLabelsInText(text, pairs) {
    const sorted = pairs.slice().sort((a, b) => b.from.length - a.from.length);
    let out = text;
    for (const { from, to } of sorted) {
        if (!from || from === to) continue;
        out = out.split(from).join(to);
    }
    return out;
}

function renameSpriteFiles(oldId, newId) {
    const oldFile = snakeToTitleFile(oldId);
    const newFile = snakeToTitleFile(newId);
    const base = path.join(ROOT, 'assets', 'sprites', GENRE, 'equipment');
    let n = 0;
    for (const d of SPRITE_DIRS) {
        const from = path.join(base, d, oldFile);
        const to = path.join(base, d, newFile);
        if (!fs.existsSync(from)) continue;
        if (DRY) {
            console.log(`  sprite ${d}/${oldFile} -> ${newFile}`);
        } else {
            if (fs.existsSync(to)) {
                console.warn(`  SKIP sprite exists: ${to}`);
                continue;
            }
            fs.renameSync(from, to);
        }
        n += 1;
    }
    return n;
}

function main() {
    const equipPath = path.join(ROOT, 'presets/standard/equipment.json');
    const equip = loadJson(equipPath);
    const items = equip.items || equip;
    const byId = new Map(items.map((i) => [i.id, i]));

    // collision check
    for (const [oldId, neu] of Object.entries(EQUIPMENT)) {
        if (!byId.has(oldId)) {
            console.error(`MISSING equipment ${oldId}`);
            process.exit(1);
        }
        if (byId.has(neu.id) && oldId !== neu.id) {
            console.error(`COLLISION equipment ${neu.id}`);
            process.exit(1);
        }
    }

    const idPairs = [];
    const labelPairs = [];
    for (const [oldId, neu] of Object.entries(EQUIPMENT)) {
        idPairs.push({ from: oldId, to: neu.id });
        const oldLabel = byId.get(oldId).label;
        if (oldLabel && oldLabel !== neu.label) {
            labelPairs.push({ from: oldLabel, to: neu.label });
        }
        // also map old planned labels if different from disk
        labelPairs.push({ from: oldId, to: neu.id }); // noop if same shape handled by id
    }
    for (const [oldId, neu] of Object.entries(SPELLS)) {
        idPairs.push({ from: oldId, to: neu.id });
        labelPairs.push({ from: neu.label === oldId ? '' : '', to: '' });
        // spell labels from current spells.json
    }

    // --- equipment.json ---
    let spriteRenames = 0;
    for (const it of items) {
        const map = EQUIPMENT[it.id];
        if (!map) continue;
        const oldId = it.id;
        const oldLabel = it.label;
        const uniqueSprite =
            it.customSprite === oldId ||
            (it.customSprite == null && true === false);

        if (uniqueSprite || it.customSprite === oldId) {
            const n = renameSpriteFiles(oldId, map.id);
            spriteRenames += n;
            it.customSprite = map.id;
        }
        // if customSprite was old id string only
        if (it.customSprite === oldId) it.customSprite = map.id;

        it.id = map.id;
        it.label = map.label;
        console.log(`equip ${oldId} -> ${map.id} (${oldLabel} -> ${map.label})`);
    }
    writeJson(equipPath, equip);

    // --- assets catalog ---
    const catPath = path.join(ROOT, 'assets/data/rpg_fantasy/equipment.json');
    if (fs.existsSync(catPath)) {
        const cat = loadJson(catPath);
        const catItems = cat.items || [];
        for (const it of catItems) {
            const map = EQUIPMENT[it.id];
            if (!map) continue;
            const oldId = it.id;
            it.id = map.id;
            if (it.technical) it.technical = map.label;
            if (it.alias) it.alias = map.label;
            if (it.sprites && typeof it.sprites === 'object') {
                for (const k of Object.keys(it.sprites)) {
                    const p = it.sprites[k];
                    if (typeof p === 'string') {
                        it.sprites[k] = p
                            .split(snakeToTitleFile(oldId))
                            .join(snakeToTitleFile(map.id))
                            .split(oldId)
                            .join(map.id);
                    }
                }
            }
        }
        // also rewrite any sprite path that still has old Title file for renamed sprites
        for (const it of catItems) {
            if (!it.sprites) continue;
            for (const k of Object.keys(it.sprites)) {
                let p = it.sprites[k];
                if (typeof p !== 'string') continue;
                for (const [oldId, neu] of Object.entries(EQUIPMENT)) {
                    p = p.split(snakeToTitleFile(oldId)).join(snakeToTitleFile(neu.id));
                }
                it.sprites[k] = p;
            }
        }
        cat.updatedAt = new Date().toISOString();
        writeJson(catPath, cat);
        console.log('updated assets catalog');
    }

    // --- equipment_list_done.txt ---
    const donePath = path.join(ROOT, 'assets/data/rpg_fantasy/equipment_list_done.txt');
    if (fs.existsSync(donePath)) {
        let done = fs.readFileSync(donePath, 'utf8');
        for (const [oldId, neu] of Object.entries(EQUIPMENT)) {
            const oldTitle = snakeToTitleFile(oldId).replace(/\.png$/, '').replace(/_/g, ' ');
            // file lines often "Title Title" or "TitleTitle"
            const compactOld = oldTitle.replace(/ /g, '');
            const newTitle = neu.label;
            const compactNew = newTitle.replace(/ /g, '');
            done = done.split(oldTitle + oldTitle).join(newTitle + newTitle);
            done = done.split(compactOld + compactOld).join(compactNew + compactNew);
            // Title_Case form without spaces used in some lines: Avalanche RuneAvalanche Rune
            const titleCaseWords = snakeToTitleFile(oldId)
                .replace(/\.png$/, '')
                .replace(/_/g, ' ');
            done = done.split(titleCaseWords + titleCaseWords).join(neu.label + neu.label);
        }
        // secondary: replace known old labels concatenated
        for (const [oldId, neu] of Object.entries(EQUIPMENT)) {
            const it = byId.get(oldId);
            if (!it || !it.label) continue;
            const a = it.label;
            const b = neu.label;
            done = done.split(a + a).join(b + b);
            done = done.split(a.replace(/'/g, '') + a.replace(/'/g, '')).join(b + b);
        }
        if (!DRY) fs.writeFileSync(donePath, done, 'utf8');
        console.log('updated equipment_list_done.txt');
    }

    // --- spells.json ---
    const spellsPath = path.join(ROOT, 'presets/standard/spells.json');
    const spellsDoc = loadJson(spellsPath);
    const spells = spellsDoc.spells || spellsDoc;
    for (const sp of spells) {
        const eqMap = EQUIPMENT[sp.id];
        const spMap = SPELLS[sp.id];
        if (spMap) {
            console.log(`spell ${sp.id} -> ${spMap.id}`);
            sp.id = spMap.id;
            sp.label = spMap.label;
        } else if (eqMap && sp.source === 'rune') {
            // field runes: id is equipment id
            console.log(`spell(equip) ${sp.id} -> ${eqMap.id}`);
            sp.id = eqMap.id;
            sp.label = eqMap.label;
        }
        if (sp.runeItemId && EQUIPMENT[sp.runeItemId]) {
            sp.runeItemId = EQUIPMENT[sp.runeItemId].id;
        }
        // fix after id change already applied — runeItemId for classic spells
        if (sp.runeItemId && !EQUIPMENT[sp.runeItemId]) {
            // already remapped or fine
        }
    }
    // second pass: any remaining old runeItemId strings
    for (const sp of spells) {
        for (const [oldId, neu] of Object.entries(EQUIPMENT)) {
            if (sp.runeItemId === oldId) sp.runeItemId = neu.id;
            if (sp.id === oldId) {
                sp.id = neu.id;
                sp.label = neu.label;
            }
        }
        for (const [oldId, neu] of Object.entries(SPELLS)) {
            if (sp.id === oldId) {
                sp.id = neu.id;
                sp.label = neu.label;
            }
        }
    }
    writeJson(spellsPath, spellsDoc);

    // Load spell labels for text replace from SPELLS map + equipment labels
    const spellLabelPairs = [];
    // Use fixed old labels we know
    const OLD_SPELL_LABELS = {
        sudden_death: 'Sudden Death',
        great_fireball: 'Great Fireball',
        thunderstorm: 'Thunderstorm',
        avalanche: 'Avalanche',
        holy_missile: 'Holy Missile',
        light_magic_missile: 'Light Magic Missile',
        heavy_magic_missile: 'Heavy Magic Missile',
        stalagmite: 'Stalagmite',
        fireball: 'Fireball',
        icicle: 'Icicle',
        stone_shower: 'Stone Shower',
        explosion: 'Explosion'
    };
    for (const [oldId, neu] of Object.entries(SPELLS)) {
        if (OLD_SPELL_LABELS[oldId]) {
            spellLabelPairs.push({ from: OLD_SPELL_LABELS[oldId], to: neu.label });
        }
    }

    // --- equipment_map.csv / spell_map.csv ---
    for (const rel of ['other/content_maps/equipment_map.csv', 'other/content_maps/spell_map.csv']) {
        const p = path.join(ROOT, rel);
        if (!fs.existsSync(p)) continue;
        let text = fs.readFileSync(p, 'utf8');
        const lines = text.split(/\n/);
        const out = lines.map((line, idx) => {
            if (idx === 0 || !line.trim()) return line;
            // CSV: legacy_id,legacy_label,standard_id,standard_label
            // naive split — ids/labels rarely contain commas for these rows
            const parts = line.split(',');
            if (parts.length < 4) return line;
            const stdId = parts[2];
            const stdLabel = parts.slice(3).join(','); // rest
            if (EQUIPMENT[stdId]) {
                parts[2] = EQUIPMENT[stdId].id;
                parts[3] = EQUIPMENT[stdId].label;
                return parts.join(',');
            }
            if (SPELLS[stdId]) {
                parts[2] = SPELLS[stdId].id;
                parts[3] = SPELLS[stdId].label;
                return parts.join(',');
            }
            // also if standard already partially...
            return line;
        });
        if (!DRY) fs.writeFileSync(p, out.join('\n'), 'utf8');
        console.log('updated', rel);
    }

    // --- global text replace in content/code (structured first already done) ---
    const TEXT_ROOTS = [
        'presets',
        'tests',
        'kernel',
        'docs',
        'scripts',
        'bin',
        'html',
        'templates',
        'other/content_maps',
        'other/features_port_review_stage_07_content_schemas_results.md',
        'other/features_port_review_plan.md',
        'other/shapes_and_player_field_runes_plan.md',
        'other/features_port_review_stage_04_shapes_runes_results.md',
        'assets/data'
    ];
    const EXTS = new Set(['.js', '.json', '.md', '.csv', '.txt', '.php', '.html', '.scss']);

    // Build id pairs (equipment + spells), longest first
    const allIdPairs = [];
    for (const [o, n] of Object.entries(EQUIPMENT)) allIdPairs.push({ from: o, to: n.id });
    for (const [o, n] of Object.entries(SPELLS)) allIdPairs.push({ from: o, to: n.id });
    allIdPairs.sort((a, b) => b.from.length - a.from.length);

    const allLabelPairs = [];
    for (const [o, n] of Object.entries(EQUIPMENT)) {
        const old = byId.get(o);
        if (old && old.label) allLabelPairs.push({ from: old.label, to: n.label });
    }
    allLabelPairs.push(...spellLabelPairs);
    // Extra franchise labels that may appear in docs
    allLabelPairs.push(
        { from: 'Sudden Death Rune', to: 'Deathburst Rune' },
        { from: 'Great Fireball Rune', to: 'Grand Fireburst Rune' },
        { from: 'Thunderstorm Rune', to: 'Stormlash Rune' },
        { from: 'Avalanche Rune', to: 'Rockfall Rune' },
        { from: 'Holy Missile Rune', to: 'Radiant Bolt Rune' },
        { from: 'Light Magic Missile Rune', to: 'Lesser Arc Bolt Rune' },
        { from: 'Heavy Magic Missile Rune', to: 'Greater Arc Bolt Rune' },
        { from: 'Fire Field Rune', to: 'Blaze Field Rune' },
        { from: 'Poison Field Rune', to: 'Venom Field Rune' },
        { from: 'Destroy Field Rune', to: 'Purge Field Rune' },
        { from: 'Energy Field Rune', to: 'Spark Field Rune' },
        { from: 'Assassin Star', to: 'Nightshade Star' },
        { from: 'The Devileye', to: 'Infernal Gaze' },
        { from: 'Warsinger Bow', to: 'Battle Hymn Bow' },
        { from: 'Mycological Bow', to: 'Sporewood Bow' },
        { from: 'Mycological Mace', to: 'Sporewood Mace' }
    );
    allLabelPairs.sort((a, b) => b.from.length - a.from.length);

    const skipPaths = new Set([
        path.join(ROOT, 'presets/standard/equipment.json'),
        path.join(ROOT, 'presets/standard/spells.json'),
        path.join(ROOT, 'assets/data/rpg_fantasy/equipment.json')
    ]);

    let filesTouched = 0;
    for (const rootRel of TEXT_ROOTS) {
        const rootAbs = path.join(ROOT, rootRel);
        const files = fs.existsSync(rootAbs)
            ? fs.statSync(rootAbs).isDirectory()
                ? walkFiles(rootAbs)
                : [rootAbs]
            : [];
        for (const file of files) {
            if (skipPaths.has(file)) continue;
            if (file.includes(`${path.sep}other${path.sep}docs${path.sep}archive`)) continue;
            if (file.includes(`${path.sep}node_modules${path.sep}`)) continue;
            const ext = path.extname(file);
            if (!EXTS.has(ext)) continue;
            // skip this script
            if (file.endsWith('rename_commercial_equipment_residual.js')) continue;
            let text = fs.readFileSync(file, 'utf8');
            const orig = text;
            text = replaceIdsInText(text, allIdPairs);
            text = replaceLabelsInText(text, allLabelPairs);
            if (text !== orig) {
                if (!DRY) fs.writeFileSync(file, text, 'utf8');
                filesTouched += 1;
                console.log('text', path.relative(ROOT, file));
            }
        }
    }

    console.log(
        `\nDone. sprite file renames: ${spriteRenames}, text files: ${filesTouched}, dry=${DRY}`
    );
}

main();
