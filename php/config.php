<?php
/**
 * Whitelists and bounds for web-triggered CLI jobs.
 * Only values listed here may reach exec(); never trust raw request strings.
 */

declare(strict_types=1);

/**
 * Allowed genre ids (must match kernel/settings.js GENRES).
 *
 * @var list<string>
 */
const HDL_GENRES = [
    'rpg_fantasy',
    'fantastic_ecology',
    'ultra_tech',
    'space_creatures',
    'steampunk',
    'super_heroes',
];

/**
 * Allowed asset kind ids (must match kernel/settings.js ASSET_KINDS).
 *
 * @var list<string>
 */
const HDL_ASSET_KINDS = [
    'creatures',
    'equipment',
    'tiles',
    'overlays',
    'objects',
    'ui',
];

/**
 * Optional subcategories for equipment / tiles / objects.
 * Empty string allowed via omit; free enum when set.
 *
 * @var list<string>
 */
const HDL_ASSET_CATEGORIES = [
    // equipment (classic weapons/armor + combat inventory present in presets)
    'sword', 'axe', 'club', 'mace', 'dagger', 'spear', 'bow', 'crossbow',
    'staff', 'wand', 'fist', 'shield', 'helmet', 'armor', 'legs', 'boots',
    'ring', 'amulet', 'ammo', 'quiver', 'spellbook', 'light', 'container',
    // tiles
    'floor', 'wall', 'water', 'path', 'special',
    // overlays (wangFamily)
    'dirt', 'cobble',
    // objects
    'tree', 'rock', 'house', 'door', 'furniture', 'deco',
    // ui
    'spells',
];

/**
 * Allowed image model labels (must match IMAGE_MODELS in batch_builder.js).
 *
 * @var list<string>
 */
const HDL_IMAGE_MODELS = [
    'Gemini 3.6 Flash (Low)',
    'Gemini 3.6 Flash (Medium)',
    'Gemini 3.6 Flash (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.1 Pro (High)',
    'Grok 4.5 (Low)',
    'Grok 4.5 (Medium)',
    'Grok 4.5 (High)',
];

/**
 * Fallback hunt ids when ModeRegistry cannot scan disk (keep in sync with
 * presets/standard/mode.json browser.hunts). Prefer hdl_all_mode_hunt_ids().
 *
 * @var list<string>
 */
const HDL_HUNT_IDS = [
    'cave_crawl_generated',
    'catalog_crawl_generated',
    'outskirts_camp_fixed',
    'cave_crawl_multifloor',
    // Product / I6 cookbook hunts (docs/22 · docs/24)
    'golden_cave_crawl',
    'standard_arena_waves',
    'rising_pressure_macro',
    'cave_band_low',
    'cave_band_mid',
    'crypt_band_high',
    'cave_to_crypt_macro',
    'biome_volume_macro',
    'test_arena',
];

/**
 * Strategy ids allowed when party members are posted with a web sim batch.
 * Keep in sync with presets/strategies.json.
 *
 * @var list<string>
 */
const HDL_STRATEGY_IDS = [
    'balanced',
    'guardian_aggro',
    'scout_kite',
    'mystic_combo',
    'adept_caster',
    'warden_support',
    'pacifist',
];

/**
 * Class ids allowed for party members in web sim batches.
 * Map to vocation archetypes: guardian≈knight, scout≈paladin,
 * mystic≈monk, adept≈sorcerer, warden≈druid, adventurer≈none.
 *
 * @var list<string>
 */
const HDL_CLASS_IDS = [
    'guardian',
    'scout',
    'mystic',
    'adept',
    'warden',
    'adventurer',
];

/**
 * Scripts the web UI may launch.
 * Keys are stable action ids used by the API (never file paths from the client).
 *
 * Each entry:
 * - runtime: only "node" for now
 * - bin: project-relative path under HDL_ROOT (no ..)
 * - params: map of param name → type rules used by Validator
 * - argv_mode: optional "json_config" — pass one JSON object arg (sim batch)
 *
 * @var array<string, array{
 *   label: string,
 *   runtime: string,
 *   bin: string,
 *   argv_mode?: string,
 *   params: array<string, array<string, mixed>>
 * }>
 */
const HDL_SCRIPTS = [
    'generate_sprite' => [
        'label' => 'Generate asset spritesheet',
        'runtime' => 'node',
        'bin' => 'bin/generate_sprite.js',
        'params' => [
            'genre' => [
                'type' => 'enum',
                'values' => HDL_GENRES,
                'required' => true,
                'flag' => '-g',
            ],
            'kind' => [
                'type' => 'enum',
                'values' => HDL_ASSET_KINDS,
                'required' => false,
                'default' => 'creatures',
                'flag' => '--kind',
                'omit_if_default' => true,
            ],
            'category' => [
                'type' => 'enum',
                'values' => HDL_ASSET_CATEGORIES,
                'required' => false,
                'flag' => '--category',
            ],
            'seed' => [
                'type' => 'int',
                'min' => 0,
                'max' => 2_147_483_647,
                'required' => false,
                'flag' => '--seed',
            ],
            'rows' => [
                'type' => 'int',
                'min' => 1,
                'max' => 8,
                'required' => false,
                'default' => 4,
                'flag' => '--rows',
                'omit_if_default' => true,
            ],
            'cols' => [
                'type' => 'int',
                'min' => 1,
                'max' => 8,
                'required' => false,
                'default' => 4,
                'flag' => '--cols',
                'omit_if_default' => true,
            ],
            'iterations' => [
                'type' => 'int',
                'min' => 1,
                'max' => 64,
                'required' => false,
                'default' => 1,
                'flag' => '--iterations',
                'omit_if_default' => true,
            ],
            'model' => [
                'type' => 'enum',
                'values' => HDL_IMAGE_MODELS,
                'required' => false,
                'flag' => '--model',
            ],
            'dry_run' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'flag' => '--dry-run',
                // bool flags: present only when true
            ],
            'opaque_alpha' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'flag' => '--opaque-alpha',
            ],
            'skip_agy' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'flag' => '--skip-agy',
            ],
            'skip_split' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'flag' => '--skip-split',
            ],
            'skip_process' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'flag' => '--skip-process',
            ],
            'skip_inventory' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'flag' => '--skip-inventory',
            ],
            'no_record' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'flag' => '--no-record',
            ],
        ],
    ],
    /**
     * Wiki Smart Update Sprites — multi-sheet roster (selected + library backlog).
     * argv_mode json_config: one JSON object arg to bin/smart_update_sprites.js.
     */
    'smart_update_sprites' => [
        'label' => 'Smart Update Sprites',
        'runtime' => 'node',
        'bin' => 'bin/smart_update_sprites.js',
        'argv_mode' => 'json_config',
        'params' => [
            'genre' => [
                'type' => 'enum',
                'values' => HDL_GENRES,
                'required' => true,
                'json_key' => 'genre',
            ],
            'kind' => [
                'type' => 'enum',
                'values' => HDL_ASSET_KINDS,
                'required' => true,
                'json_key' => 'kind',
            ],
            'category' => [
                'type' => 'enum',
                'values' => HDL_ASSET_CATEGORIES,
                'required' => false,
                'json_key' => 'category',
            ],
            'seed' => [
                'type' => 'int',
                'min' => 0,
                'max' => 2_147_483_647,
                'required' => false,
                'json_key' => 'seed',
            ],
            'model' => [
                'type' => 'enum',
                'values' => HDL_IMAGE_MODELS,
                'required' => false,
                'default' => 'Gemini 3.6 Flash (High)',
                'json_key' => 'model',
            ],
            'rows' => [
                'type' => 'int',
                'min' => 1,
                'max' => 8,
                'required' => false,
                'default' => 4,
                'json_key' => 'rows',
            ],
            'cols' => [
                'type' => 'int',
                'min' => 1,
                'max' => 8,
                'required' => false,
                'default' => 4,
                'json_key' => 'cols',
            ],
            'dry_run' => [
                'type' => 'bool',
                'required' => false,
                'default' => false,
                'json_key' => 'dry_run',
            ],
            'items' => [
                'type' => 'roster_items',
                'required' => true,
                'json_key' => 'items',
            ],
        ],
    ],
    /**
     * Headless hunt batch (scripts/batch_worker.js → runHeadlessHuntBatch).
     * Web UI posts validated scalars (+ optional members); argv is one JSON config.
     * Cap iterations for web (large campaigns still use SIMULATION.sh).
     */
    'sim_batch' => [
        'label' => 'Hunt simulation batch',
        'runtime' => 'node',
        'bin' => 'scripts/batch_worker.js',
        'argv_mode' => 'json_config',
        'params' => [
            'iterations' => [
                'type' => 'int',
                'min' => 1,
                'max' => 900,
                'required' => false,
                'default' => 10,
                'json_key' => 'iterations',
            ],
            'seed' => [
                'type' => 'int',
                'min' => 1,
                'max' => 2_147_483_647,
                'required' => false,
                'default' => 42,
                'json_key' => 'seed',
            ],
            'concurrency' => [
                'type' => 'int',
                'min' => 1,
                'max' => 16,
                'required' => false,
                'default' => 1,
                'json_key' => 'concurrency',
            ],
            'huntId' => [
                'type' => 'enum',
                'values' => HDL_HUNT_IDS,
                'required' => false,
                'default' => 'cave_crawl_generated',
                'json_key' => 'huntId',
            ],
            'outDir' => [
                'type' => 'relpath',
                'prefix' => 'var/sim',
                'required' => false,
                'default' => 'var/sim',
                'json_key' => 'outDir',
            ],
            'frames' => [
                'type' => 'int',
                'min' => 1,
                'max' => 2_000_000,
                'required' => false,
                'json_key' => 'frames',
            ],
            'maxKills' => [
                'type' => 'int',
                'min' => 1,
                'max' => 100_000,
                'required' => false,
                'json_key' => 'maxKills',
            ],
            'maxTicks' => [
                'type' => 'int',
                'min' => 1,
                'max' => 2_000_000,
                'required' => false,
                'json_key' => 'maxTicks',
            ],
            'quiet' => [
                'type' => 'bool',
                'required' => false,
                'default' => true,
                'json_key' => 'quiet',
            ],
            'members' => [
                'type' => 'party_members',
                'required' => false,
                'json_key' => 'members',
            ],
        ],
    ],
];

/**
 * Roots the Analysis UI may browse for JSON results (relative to HDL_ROOT).
 * No path escapes; API lists/reads only under these trees.
 *
 * @var list<string>
 */
const HDL_SIM_RESULT_ROOTS = [
    'var/sim',
    'presets/standard/analysis',
    'presets/analysis', // legacy alias if present
];

/** Max concurrent running jobs of any script (image gen is heavy). */
const HDL_MAX_RUNNING_JOBS = 1;

/** How many recent jobs list_action returns. */
const HDL_JOB_LIST_LIMIT = 20;

/** Max log bytes returned in a single status/log poll. */
const HDL_LOG_CHUNK_BYTES = 48_000;
