/**
 * Hunt session root.
 * Stage 0–3: empty level / ghost-walk.
 * Stage 5: combat AI, spawn tables, party wipe / route complete.
 * Stage 6: structured telemetry + session limits (duration / kill cap).
 */

const { GameObject } = require('../../core/entities/gameobject.js');
const { TileMap } = require('../../core/entities/tilemap.js');
const { Party } = require('../../core/entities/party.js');
const { Player } = require('../../core/entities/player.js');
const { Creature } = require('../../core/entities/creature.js');
const { Prop } = require('../../core/entities/prop.js');
const { Time } = require('../../core/lib/time.js');
const { Utils, unbindSeededRandom } = require('../../core/lib/utils.js');
const { Settings, mapPathPng } = require('../../settings.js');
const { Navmesh } = require('../../core/lib/navmesh.js');
const {
    tickHuntAi,
    initPlayerAi,
    initCreatureAi,
    ensureSpellBook,
    applyCreatureSleepState
} = require('../../core/lib/ai/hunt_ai.js');
const { indexStrategies, DEFAULT_STRATEGIES } =
    require('../../core/lib/ai/strategy.js');
const {
    recordDamageTakenBy,
    applyKitDamageMult,
    isSummon
} = require('../../core/lib/ai/creature_kit.js');
const { tileDistance, getVisualTilePos } = require('../../core/lib/movement.js');
const { beginHitFeedback } = require('../../core/lib/sprite_presentation.js');
const {
    createEmptyHuntTelemetry,
    createEmptyTelemetry,
    sampleAttack,
    sampleKill,
    sampleDeath,
    samplePacingEvent,
    sampleBiomeTransition,
    sampleCombatTouch,
    samplePropUse,
    buildHuntSummary: buildSummaryFromTelemetry
} = require('../../core/lib/telemetry.js');
const { pacingTagFromEntity } = require('../../core/lib/dungeon/pacing.js');
const { normalizeEquipmentMap } = require('../../core/lib/character/stats.js');
const {
    resolvePlayerSpriteArt
} = require('../../core/lib/character/player_profile.js');
const {
    freezeExpSessionConfig,
    seedPlayerExperience
} = require('../../core/lib/character/progression.js');
const { EntityMarkersScript } = require('../../core/scripts/entity_markers.js');
const { createGroundStore } = require('../../core/lib/character/ground_items.js');
const {
    purgeExpiredFields,
    isTileFieldHazardForEntity
} = require('../../core/lib/combat/elemental_fields.js');
const {
    FloatingCombatTextScript
} = require('../../core/scripts/floating_combat_text.js');
const {
    CombatEffectsScript
} = require('../../core/scripts/combat_effects.js');
const { drawAiDebugOverlays } = require('../../core/lib/ai_debug_draw.js');
const { SpawnManager } = require('../../core/lib/spawn_manager.js');
const {
    normalizeWavesConfig,
    WaveController
} = require('../../core/lib/wave_manager.js');
const { SpatialIndex } = require('../../core/lib/spatial_index.js');

const NATIVE_MATH_RANDOM = Math.random;

/**
 * Deep-clone plain JSON-safe config (parties / spawns / mapPaths).
 * @param {*} value
 * @returns {*}
 */
function clonePlain(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
}

/**
 * Clone floorLayers so scrub reseed keeps friction TypedArrays.
 * JSON.parse(JSON.stringify(Uint8Array)) becomes a number-keyed object and breaks loadFloorFromFriction.
 *
 * @param {Record<string, { cols?: number, rows?: number, friction?: ArrayLike<number> }>|null|undefined} layers
 * @returns {Record<string, { cols: number, rows: number, friction: Uint8Array }>|null}
 */
function cloneFloorLayers(layers) {
    if (!layers || typeof layers !== 'object') return null;
    /** @type {Record<string, { cols: number, rows: number, friction: Uint8Array }>} */
    const out = Object.create(null);
    const keys = Object.keys(layers);
    for (let i = 0; i < keys.length; i++) {
        const z = keys[i];
        const L = layers[z];
        if (!L || L.friction == null) continue;
        const cols = L.cols | 0;
        const rows = L.rows | 0;
        const src = L.friction;
        let friction;
        if (src instanceof Uint8Array) {
            friction = new Uint8Array(src);
        } else if (ArrayBuffer.isView(src)) {
            friction = new Uint8Array(
                src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength)
            );
        } else if (Array.isArray(src)) {
            friction = Uint8Array.from(src);
        } else if (typeof src === 'object') {
            // Defensive: recovered from bad JSON clone
            const n = cols > 0 && rows > 0 ? cols * rows : Object.keys(src).length;
            friction = new Uint8Array(n);
            for (let j = 0; j < n; j++) {
                friction[j] = src[j] | 0;
            }
        } else {
            continue;
        }
        out[z] = { cols, rows, friction };
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Clone artLayers so scrub reseed keeps palette + Uint16 cell indices.
 * JSON.parse(JSON.stringify(Uint16Array)) becomes a number-keyed object without
 * `length`; setArtLayer then installs empty cells → friction-only gray paint on
 * backward scrub (watch tiles vanish after seek-to-tick).
 *
 * @param {Record<string, {
 *   cols?: number,
 *   rows?: number,
 *   palette?: string[],
 *   cells?: ArrayLike<number>|object,
 *   artSet?: string|null,
 *   genre?: string|null,
 *   kind?: string
 * }>|null|undefined} layers
 * @returns {Record<string, {
 *   cols: number,
 *   rows: number,
 *   palette: string[],
 *   cells: Uint16Array,
 *   artSet: string|null,
 *   genre: string|null,
 *   kind: string
 * }>|null}
 */
function cloneArtLayers(layers) {
    if (!layers || typeof layers !== 'object') return null;
    /** @type {Record<string, {
     *   cols: number,
     *   rows: number,
     *   palette: string[],
     *   cells: Uint16Array,
     *   artSet: string|null,
     *   genre: string|null,
     *   kind: string
     * }>} */
    const out = Object.create(null);
    const keys = Object.keys(layers);
    for (let i = 0; i < keys.length; i++) {
        const z = keys[i];
        const L = layers[z];
        if (!L || L.cells == null || !Array.isArray(L.palette)) continue;
        const cols = L.cols | 0;
        const rows = L.rows | 0;
        const n = cols > 0 && rows > 0 ? cols * rows : 0;
        const src = L.cells;
        let cells;
        if (src instanceof Uint16Array) {
            cells = new Uint16Array(src);
        } else if (ArrayBuffer.isView(src)) {
            cells = new Uint16Array(
                src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength)
            );
        } else if (Array.isArray(src)) {
            cells = Uint16Array.from(src);
        } else if (typeof src === 'object') {
            // Defensive: recovered from bad JSON clone of TypedArray
            const len = n > 0 ? n : Object.keys(src).length;
            cells = new Uint16Array(len);
            for (let j = 0; j < len; j++) {
                cells[j] = src[j] | 0;
            }
        } else {
            continue;
        }
        if (n > 0 && cells.length < n) continue;
        if (n > 0 && cells.length > n) {
            cells = cells.subarray(0, n);
        }
        out[z] = {
            cols,
            rows,
            palette: L.palette.slice(),
            cells,
            artSet: L.artSet != null ? String(L.artSet) : null,
            genre: L.genre != null ? String(L.genre) : null,
            kind: L.kind != null ? String(L.kind) : 'tiles'
        };
    }
    return Object.keys(out).length ? out : null;
}

/**
 * @param {*} mode
 * @returns {'eager'|'on_demand'}
 */
function normalizeSpawnMode(mode) {
    return mode === 'on_demand' ? 'on_demand' : 'eager';
}

/**
 * True when a waves config is present (array or object with list).
 * @param {*} raw
 * @returns {boolean}
 */
function hasWavesConfig(raw) {
    return !!normalizeWavesConfig(raw);
}

class Simulator extends GameObject {
    /**
     * @param {{
     *   seed?: number,
     *   name?: string,
     *   floor?: string|number,
     *   floors?: (string|number)[],
     *   mapPath?: string,
     *   mapPaths?: Record<string, string>,
     *   floorFriction?: { z?: number|string, cols: number, rows: number, friction: Uint8Array|ArrayLike<number> }|null,
     *   floorLayers?: Record<string, { cols: number, rows: number, friction: Uint8Array|ArrayLike<number> }>|null,
     *   floorArt?: object|null,
     *   artLayers?: Record<string, object>|null,
     *   genre?: string,
     *   parties?: object[],
     *   spawns?: object[],
     *   props?: object[],
     *   spawnMode?: 'eager'|'on_demand',
     *   waves?: object|object[]|null,
     *   combatAi?: boolean,
     *   recordSteps?: boolean,
     *   huntId?: string|null,
     *   stairLinks?: { from: object, to: object, link?: string|null }[]|null,
     *   navmeshData?: object|null,
     *   maxTicks?: number|null,
     *   maxKills?: number|null,
     *   maxSeconds?: number|null,
     *   noAttackTimeoutSec?: number|null,
     *   noAttackTimeoutTicks?: number|null,
     *   pacingBudget?: object|null,
     *   layoutMeta?: object|null,
     *   floorMeta?: object[]|null,
     *   spellBook?: object[]|Record<string, object>,
     *   strategyTable?: Record<string, object>,
     *   classLoader?: (id: string) => object|null,
     *   itemDb?: object[]|Record<string, object>,
     *   creatureLoader?: (id: string) => object|null
     * }} [opts]
     */
    constructor(opts = {}) {
        super(opts.name || 'Simulator');
        const raw = opts.seed !== undefined ? opts.seed : 1;
        this.seed = raw >>> 0 || 1;
        this.tickCount = 0;
        this.seededRandom = null;
        this.rngState = 0;
        /**
         * Session phase:
         * idle | running | route_complete | party_wipe | timeout | kill_cap |
         * waves_complete | no_attack_timeout | stopped
         */
        this.sessionState = 'idle';
        /**
         * When true, browser shell keeps rendering after hunt end so inventory
         * drop/pickup can still be exercised (Scenario Lab inventory_sandbox).
         * @type {boolean}
         */
        this.inventoryPractice = opts.inventoryPractice === true;
        this.app = Settings.app;
        /**
         * Optional runner overrides for Phase C exp (merged at session freeze).
         * @type {object|null}
         */
        this.expConfig = opts.expConfig && typeof opts.expConfig === 'object'
            ? opts.expConfig
            : null;
        /**
         * Frozen at session start — piano-roll / determinism input.
         * Award path reads this bag (engine supports live reassignment).
         * @type {object|null}
         */
        this.sessionExpConfig = null;

        /** @type {TileMap|null} */
        this.tileMap = null;
        /** @type {Party[]} */
        this.parties = [];
        /** @type {Creature[]} Hostile NPCs */
        this.creatures = [];
        /**
         * Chunk index of live creatures for AI proximity gather (Etapa 1).
         * Rebuild when `_creatureSpatialDirty`; set to `false` to force linear scan.
         * @type {SpatialIndex|false|null}
         */
        this.creatureSpatialIndex = new SpatialIndex({
            chunkSize:
                Settings.AI_SPATIAL_CHUNK_SIZE != null
                    ? Math.max(1, Settings.AI_SPATIAL_CHUNK_SIZE | 0)
                    : Settings.SPAWN_CHUNK_SIZE != null
                      ? Math.max(1, Settings.SPAWN_CHUNK_SIZE | 0)
                      : 32
        });
        /** @type {boolean} */
        this._creatureSpatialDirty = false;
        /**
         * Chunk index of living party members for creature aggro (Etapa 5).
         * Set to `false` to force linear `ctx.players` scans.
         * @type {SpatialIndex|false|null}
         */
        this.playerSpatialIndex = new SpatialIndex({
            chunkSize:
                Settings.AI_SPATIAL_CHUNK_SIZE != null
                    ? Math.max(1, Settings.AI_SPATIAL_CHUNK_SIZE | 0)
                    : Settings.SPAWN_CHUNK_SIZE != null
                      ? Math.max(1, Settings.SPAWN_CHUNK_SIZE | 0)
                      : 32
        });
        /** @type {boolean} */
        this._playerSpatialDirty = false;
        /**
         * Last AI frame counters (`tickHuntAi`). Totals accumulate on `aiPerfTotals`.
         * @type {object|null}
         */
        this.aiPerf = null;
        /** @type {object|null} */
        this.aiPerfTotals = null;
        /**
         * Last selective-update (sleep) counters (`applyCreatureSleepState`).
         * @type {object|null}
         */
        this.updatePerf = null;
        /** @type {object|null} */
        this.updatePerfTotals = null;
        /** @type {Prop[]} Stage 11.2 interactive gizmos */
        this.props = [];
        /**
         * Floor item stacks (drop / pickup). Independent of player inventories.
         * @type {import('../../core/lib/character/ground_items.js').GroundStore}
         */
        this.groundItems = createGroundStore();
        /** @type {Map<number, object>} */
        this.entityById = new Map();
        /** Next positive occupancy id */
        this.nextEntityId = 1;

        this.floor = opts.floor !== undefined ? opts.floor : null;
        /** @type {(string|number)[]|null} Multi-floor load list (Stage 9) */
        this.floors = Array.isArray(opts.floors) && opts.floors.length
            ? opts.floors.slice()
            : null;
        this.mapPath = opts.mapPath || null;
        /** @type {Record<string, string>|null} Per-floor path overrides */
        this.mapPaths =
            opts.mapPaths && typeof opts.mapPaths === 'object'
                ? opts.mapPaths
                : null;
        /**
         * Stage 11.4: in-memory friction layers (generated layouts).
         * Keyed by floor z string. When set, loadMaps uses loadFloorFromFriction
         * instead of path PNGs for those floors.
         * @type {Record<string, { cols: number, rows: number, friction: Uint8Array|ArrayLike<number> }>|null}
         */
        this.floorLayers = null;
        if (opts.floorLayers && typeof opts.floorLayers === 'object') {
            this.floorLayers = opts.floorLayers;
        } else if (opts.floorFriction && typeof opts.floorFriction === 'object') {
            const ff = opts.floorFriction;
            const z = ff.z != null ? ff.z : opts.floor != null ? opts.floor : 0;
            this.floorLayers = Object.create(null);
            this.floorLayers[String(z)] = {
                cols: ff.cols,
                rows: ff.rows,
                friction: ff.friction
            };
        }
        /**
         * Stage 11.9: decorative art layers (palette + cell indices) parallel to
         * floorLayers. Applied onto TileMap after friction load.
         * @type {Record<string, object>|null}
         */
        this.artLayers = null;
        if (opts.artLayers && typeof opts.artLayers === 'object') {
            this.artLayers = opts.artLayers;
        } else if (opts.floorArt && typeof opts.floorArt === 'object') {
            const fa = opts.floorArt;
            const z = fa.z != null ? fa.z : opts.floor != null ? opts.floor : 0;
            this.artLayers = Object.create(null);
            this.artLayers[String(z)] = fa;
        }
        /** Content genre for catalog bridges (Stage 9) */
        this.genre = opts.genre || null;
        this.huntId = opts.huntId != null ? opts.huntId : null;
        /** @type {object[]|null} Raw party configs applied in start() */
        this._partyConfigs = Array.isArray(opts.parties) ? opts.parties : null;
        /** @type {object[]|null} Spawn table */
        this._spawnConfigs = Array.isArray(opts.spawns) ? opts.spawns : null;
        /**
         * Sequential arena waves (optional). When set, SpawnManager loads only
         * the active wave pack; session may end with waves_complete.
         * @type {object|object[]|null}
         */
        this._wavesConfigRaw =
            opts.waves != null ? clonePlain(opts.waves) : null;
        /** @type {WaveController|null} */
        this.waveController = null;
        /** @type {object[]|null} Stage 11.2 prop table (marker resolve output) */
        this._propConfigs = Array.isArray(opts.props) ? opts.props : null;
        /**
         * Stage 11.8 / 12H multi-floor stair links (from → to pads).
         * Installed on TileMap as first-class stairs after loadMaps, and
         * applied to every party unless the party config overrides.
         * @type {object[]|null}
         */
        this._stairLinks = Array.isArray(opts.stairLinks)
            ? opts.stairLinks
            : null;
        /**
         * Stage 12H: optional navmesh graph data (e.g. multifloor generator).
         * Installed on TileMap after loadMaps when present.
         * @type {object|null}
         */
        this._navmeshData =
            opts.navmeshData && typeof opts.navmeshData === 'object'
                ? opts.navmeshData
                : null;
        /**
         * Spawn activation policy. Default eager so existing hunt tables spawn
         * everything at start (tests stay stable). on_demand uses radius scans.
         * @type {'eager'|'on_demand'}
         */
        this.spawnMode = normalizeSpawnMode(
            opts.spawnMode != null ? opts.spawnMode : Settings.SPAWN_MODE
        );
        /**
         * When true, tick hunt AI instead of pure ghost-walk.
         * Auto-enabled when spawns or waves are present unless explicitly false.
         */
        this.combatAi =
            opts.combatAi !== undefined
                ? !!opts.combatAi
                : !!(
                      (opts.spawns && opts.spawns.length) ||
                      hasWavesConfig(opts.waves)
                  );
        this.recordSteps = !!opts.recordSteps;
        /** @type {{ tick: number, entityId: number, name: string, x: number, y: number, z: string|number }[]} */
        this.stepLog = [];
        /**
         * Tick-accurate party stair hops (z change). Always on — used by live
         * panel multi-floor isolation (docs/25) without enabling full stepLog.
         * @type {{ tick: number, entityId: number, name: string, fromZ: string|number, toZ: string|number, x: number, y: number }[]}
         */
        this.floorHopLog = [];
        /**
         * Optional split-floor combat/RNG log (docs/25). Off unless
         * `parityTrace` is true / a range object (browser:parity, bug:repro).
         * @type {object[]}
         */
        this.parityTickLog = [];
        this._initParityTrace(opts.parityTrace);

        /** Session limits (Stage 6). Null = unlimited (runner may still cap frames). */
        this.maxTicks =
            opts.maxTicks != null && opts.maxTicks > 0
                ? Math.floor(opts.maxTicks)
                : null;
        this.maxKills =
            opts.maxKills != null && opts.maxKills > 0
                ? Math.floor(opts.maxKills)
                : null;
        if (
            this.maxTicks == null &&
            opts.maxSeconds != null &&
            opts.maxSeconds > 0
        ) {
            const ups = Settings.LOGIC_UPS || 20;
            this.maxTicks = Math.max(1, Math.ceil(Number(opts.maxSeconds) * ups));
        }

        /**
         * Optional liveness guard: end session when no successful attack is
         * recorded for this many ticks (e.g. stuck AI on arena waves).
         * From opts.noAttackTimeoutTicks or opts.noAttackTimeoutSec * LOGIC_UPS.
         * @type {number|null}
         */
        this.noAttackTimeoutTicks = null;
        if (
            opts.noAttackTimeoutTicks != null &&
            opts.noAttackTimeoutTicks > 0
        ) {
            this.noAttackTimeoutTicks = Math.floor(opts.noAttackTimeoutTicks);
        } else if (
            opts.noAttackTimeoutSec != null &&
            opts.noAttackTimeoutSec > 0
        ) {
            const ups = Settings.LOGIC_UPS || 20;
            this.noAttackTimeoutTicks = Math.max(
                1,
                Math.ceil(Number(opts.noAttackTimeoutSec) * ups)
            );
        }
        /** Tick of last successful recordAttack (0 until first attack). */
        this._lastAttackTick = 0;

        this.telemetry = createEmptyHuntTelemetry();
        this.forceAiControl = !!opts.forceAiControl;
        this.commandHistory =
            !this.forceAiControl && Array.isArray(opts.commandHistory)
                ? clonePlain(opts.commandHistory)
                : [];
        this._lastTruncatedAtTick = -1;

        /**
         * Stage 11.0 pacing budget (optional). Evaluation is report-only.
         * @type {object|null}
         */
        this.pacingBudget =
            opts.pacingBudget && typeof opts.pacingBudget === 'object'
                ? opts.pacingBudget
                : null;

        /**
         * Stage 11.10: multi-biome layout meta (macro segments, floorMeta).
         * Used for runtime biome_transition samples + summary evaluation.
         * @type {object|null}
         */
        this.layoutMeta =
            opts.layoutMeta && typeof opts.layoutMeta === 'object'
                ? opts.layoutMeta
                : null;
        /**
         * Per-floor biome/art pointers keyed by z string.
         * Built from opts.floorMeta or layoutMeta.floorMeta.
         * @type {Record<string, { z: string|number, biomeId: string|null, artSet: string|null, segmentIndex: number|null, macroTransition: boolean }>}
         */
        this._floorMetaByZ = buildFloorMetaIndex(
            opts.floorMeta ||
                (this.layoutMeta && this.layoutMeta.floorMeta) ||
                null,
            this.layoutMeta && this.layoutMeta.macro
                ? this.layoutMeta.macro
                : null
        );
        /**
         * Dedup keys for biome_transition samples (`fromZ->toZ`).
         * Cleared on start / reseed so seek replays re-emit deterministically.
         * @type {Set<string>}
         */
        this._biomeTransitionSeen = new Set();

        /** @type {Record<string, object>} */
        this.spellBook = ensureSpellBook(opts.spellBook || null);
        /** @type {Record<string, object>} */
        this.strategyTable =
            opts.strategyTable || indexStrategies(DEFAULT_STRATEGIES);

        this._classLoader = opts.classLoader || null;
        this._itemDb = opts.itemDb || null;
        this._creatureLoader = opts.creatureLoader || null;

        /**
         * On-demand / eager spawn lifecycle (replaces ad-hoc _respawnQueue).
         * @type {SpawnManager}
         */
        this.spawnManager = this._createSpawnManager();
        this._initWaveController();

        /**
         * Stage 12E scrubber: seed + resolved hunt opts for reseed seek.
         * Captured at end of start(); loaders stay on the instance.
         * @type {object|null}
         */
        this.replayConfig = null;
        /** Logic ticks the user has scrubbed/played to (UI). */
        this.playbackElapsedTicks = 0;
        /** High-water mark of playable scrub range. */
        this.playbackMaxElapsedTicks = 0;
        /** True while seekToTick is replaying from seed (skip Application logic). */
        this._seekInProgress = false;
        /** Stop expanding max when session ends (wipe / route / timeout / cap). */
        this._playbackRecordingStopped = false;

        /**
         * Watch-mode camera focus: index into parties[0].members.
         * null → follow party leader (default). Independent of isLeader —
         * UI "Set Active" changes this without reassigning the hunt leader.
         * Index is stable across seek/reseed (members rebuild in same order).
         * @type {number|null}
         */
        this.cameraFocusMemberIndex = null;

        /** Watch-mode scripts (no-op when HEADLESS) */
        this.entityMarkers = new EntityMarkersScript({ getSim: () => this });
        this.floatingCombatText = new FloatingCombatTextScript();
        this.combatEffects = new CombatEffectsScript();
        this.insertScript(this.entityMarkers);
        this.insertScript(this.floatingCombatText);
        this.insertScript(this.combatEffects);
    }

    /**
     * Party member the watch camera follows (and whose combat target is
     * highlighted). Defaults to the leader when index is unset or invalid.
     * @returns {import('../../core/entities/player.js').Player|null}
     */
    getCameraFocusMember() {
        const party = this.parties && this.parties[0];
        if (!party || !party.members || !party.members.length) return null;
        const idx = this.cameraFocusMemberIndex;
        if (idx != null && idx >= 0 && idx < party.members.length) {
            const m = party.members[idx];
            if (m && m.tile) return m;
        }
        return party.getLeader() || party.members[0] || null;
    }

    /**
     * Set which party member the watch camera follows.
     * @param {number|null|undefined} index parties[0].members index, or null for leader
     */
    setCameraFocusMemberIndex(index) {
        if (index == null || index === '' || !Number.isFinite(Number(index))) {
            this.cameraFocusMemberIndex = null;
            return;
        }
        this.cameraFocusMemberIndex = Math.max(0, Math.floor(Number(index)));
    }

    /**
     * Serializable session snapshot for scrub reseed (no loaders / functions).
     * Must include multi-floor fields: without floorLayers, seek reloads path PNGs
     * (fails / wrong map) and stair hops desync (docs/25 + scrub hop UX).
     * artLayers must use cloneArtLayers (not JSON) so Uint16 cells survive reseed;
     * otherwise watch paint falls back to friction gray after backward scrub.
     * @returns {object}
     */
    captureReplayConfig() {
        return {
            seed: this.seed,
            name: this.name,
            floor: this.floor,
            floors: this.floors ? this.floors.slice() : null,
            mapPath: this.mapPath,
            mapPaths: this.mapPaths ? clonePlain(this.mapPaths) : null,
            floorLayers: cloneFloorLayers(this.floorLayers),
            artLayers: cloneArtLayers(this.artLayers),
            genre: this.genre,
            huntId: this.huntId,
            parties: clonePlain(this._partyConfigs),
            spawns: clonePlain(this._spawnConfigs),
            props: clonePlain(this._propConfigs),
            waves: this._wavesConfigRaw
                ? clonePlain(this._wavesConfigRaw)
                : null,
            spawnMode: this.spawnMode,
            combatAi: this.combatAi,
            recordSteps: this.recordSteps,
            maxTicks: this.maxTicks,
            maxKills: this.maxKills,
            noAttackTimeoutTicks: this.noAttackTimeoutTicks,
            stairLinks: Array.isArray(this._stairLinks)
                ? clonePlain(this._stairLinks)
                : null,
            // Graph is read-only after bake — keep reference (clonePlain is huge / lossy)
            navmeshData: this._navmeshData || null,
            pacingBudget: this.pacingBudget
                ? clonePlain(this.pacingBudget)
                : null,
            layoutMeta: this.layoutMeta ? clonePlain(this.layoutMeta) : null,
            commandHistory: Array.isArray(this.commandHistory)
                ? clonePlain(this.commandHistory)
                : [],
            forceAiControl: this.forceAiControl
        };
    }

    /**
     * Apply a replay config onto this instance (seed + spawn table + limits).
     * Does not re-run bootstrap; callers use start() / seekToTick().
     * @param {object} cfg
     */
    applyReplayConfig(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        this.seed = cfg.seed >>> 0 || 1;
        if (cfg.name != null) this.name = cfg.name;
        this.floor = cfg.floor !== undefined ? cfg.floor : this.floor;
        this.floors =
            Array.isArray(cfg.floors) && cfg.floors.length
                ? cfg.floors.slice()
                : cfg.floors === null
                  ? null
                  : this.floors;
        if (cfg.mapPath !== undefined) this.mapPath = cfg.mapPath;
        if (cfg.mapPaths !== undefined) {
            this.mapPaths =
                cfg.mapPaths && typeof cfg.mapPaths === 'object'
                    ? clonePlain(cfg.mapPaths)
                    : null;
        }
        if (cfg.floorLayers !== undefined) {
            this.floorLayers = cloneFloorLayers(cfg.floorLayers);
        }
        if (cfg.artLayers !== undefined) {
            this.artLayers = cloneArtLayers(cfg.artLayers);
        }
        if (cfg.genre !== undefined) this.genre = cfg.genre;
        if (cfg.huntId !== undefined) this.huntId = cfg.huntId;
        this._partyConfigs = Array.isArray(cfg.parties)
            ? clonePlain(cfg.parties)
            : null;
        this._spawnConfigs = Array.isArray(cfg.spawns)
            ? clonePlain(cfg.spawns)
            : null;
        this._propConfigs = Array.isArray(cfg.props)
            ? clonePlain(cfg.props)
            : cfg.props === null
              ? null
              : this._propConfigs;
        if (cfg.waves !== undefined) {
            this._wavesConfigRaw =
                cfg.waves != null ? clonePlain(cfg.waves) : null;
            this._initWaveController();
        }
        if (cfg.spawnMode !== undefined) {
            this.spawnMode = normalizeSpawnMode(cfg.spawnMode);
            this.spawnManager = this._createSpawnManager();
        }
        if (cfg.combatAi !== undefined) this.combatAi = !!cfg.combatAi;
        if (cfg.recordSteps !== undefined) this.recordSteps = !!cfg.recordSteps;
        this.maxTicks =
            cfg.maxTicks != null && cfg.maxTicks > 0
                ? Math.floor(cfg.maxTicks)
                : null;
        this.maxKills =
            cfg.maxKills != null && cfg.maxKills > 0
                ? Math.floor(cfg.maxKills)
                : null;
        if (cfg.noAttackTimeoutTicks !== undefined) {
            this.noAttackTimeoutTicks =
                cfg.noAttackTimeoutTicks != null &&
                cfg.noAttackTimeoutTicks > 0
                    ? Math.floor(cfg.noAttackTimeoutTicks)
                    : null;
        }
        if (cfg.stairLinks !== undefined) {
            this._stairLinks = Array.isArray(cfg.stairLinks)
                ? clonePlain(cfg.stairLinks)
                : null;
        }
        if (cfg.navmeshData !== undefined) {
            this._navmeshData =
                cfg.navmeshData && typeof cfg.navmeshData === 'object'
                    ? cfg.navmeshData
                    : null;
        }
        if (cfg.pacingBudget !== undefined) {
            this.pacingBudget =
                cfg.pacingBudget && typeof cfg.pacingBudget === 'object'
                    ? clonePlain(cfg.pacingBudget)
                    : null;
        }
        if (cfg.layoutMeta !== undefined) {
            this.layoutMeta =
                cfg.layoutMeta && typeof cfg.layoutMeta === 'object'
                    ? clonePlain(cfg.layoutMeta)
                    : null;
            this._floorMetaByZ = buildFloorMetaIndex(
                this.layoutMeta && this.layoutMeta.floorMeta
                    ? this.layoutMeta.floorMeta
                    : null,
                this.layoutMeta && this.layoutMeta.macro
                    ? this.layoutMeta.macro
                    : null
            );
        }
        if (cfg.forceAiControl !== undefined) {
            this.forceAiControl = !!cfg.forceAiControl;
        }
        if (!this._seekInProgress && cfg.commandHistory !== undefined) {
            this.commandHistory = Array.isArray(cfg.commandHistory)
                ? clonePlain(cfg.commandHistory)
                : [];
        }
    }

    /**
     * Drop parties/creatures/occupancy for a reseed; keep TileMap + watch scripts.
     */
    clearSessionEntities() {
        const keep = [];
        for (let i = 0; i < this.children.length; i++) {
            const c = this.children[i];
            if (c === this.tileMap) {
                keep.push(c);
            } else {
                c.parent = null;
                c.active = false;
            }
        }
        this.children = keep;
        this.parties = [];
        this.creatures = [];
        this.props = [];
        this.entityById.clear();
        this.nextEntityId = 1;
        this.stepLog = [];
        this.floorHopLog = [];
        this.parityTickLog = [];
        this._parityWindow = this._parityFixedWindow
            ? {
                  from: this._parityFixedWindow.from,
                  to: this._parityFixedWindow.to
              }
            : null;
        this._parityAttacksThisTick = [];
        this._parityDrawsAtTickStart = 0;
        if (this.creatureSpatialIndex && this.creatureSpatialIndex !== false) {
            this.creatureSpatialIndex.clear();
        }
        this._creatureSpatialDirty = false;
        if (this.playerSpatialIndex && this.playerSpatialIndex !== false) {
            this.playerSpatialIndex.clear();
        }
        this._playerSpatialDirty = false;
        this.aiPerf = null;
        this.aiPerfTotals = null;
        if (this.spawnManager) {
            this.spawnManager.clear();
        }
        // WaveController is re-created in start() via _initWaveController
        this.waveController = null;
        if (this.tileMap && typeof this.tileMap.clearOccupancy === 'function') {
            this.tileMap.clearOccupancy();
        }
        if (this.floatingCombatText && this.floatingCombatText.entries) {
            this.floatingCombatText.entries.length = 0;
        }
        if (this.combatEffects && typeof this.combatEffects.clear === 'function') {
            this.combatEffects.clear();
        }
    }

    /**
     * Build SpawnManager for current spawnMode / Settings knobs.
     * Eager hunts disable home-distance / idle-AOI despawn so corridor packs stay put.
     * on_demand enables idle AOI despawn + optional soft living cap (Etapa 2).
     * @returns {SpawnManager}
     * @private
     */
    _createSpawnManager() {
        const mode = normalizeSpawnMode(this.spawnMode);
        const homeDist =
            mode === 'on_demand'
                ? Settings.SPAWN_DESPAWN_HOME_DIST != null
                    ? Settings.SPAWN_DESPAWN_HOME_DIST
                    : 20
                : 0;
        // Idle AOI free only for on_demand (eager keeps full table materialized).
        const idleSec =
            mode === 'on_demand'
                ? Settings.SPAWN_DESPAWN_IDLE_SEC != null
                    ? Settings.SPAWN_DESPAWN_IDLE_SEC
                    : 2
                : 0;
        const maxLiving =
            Settings.SPAWN_MAX_LIVING != null
                ? Math.max(0, Settings.SPAWN_MAX_LIVING | 0)
                : 0;
        return new SpawnManager({
            mode,
            activateRadius: Settings.SPAWN_ACTIVATE_RADIUS,
            despawnHomeDist: homeDist,
            despawnIdleRadius: Settings.SPAWN_DESPAWN_IDLE_RADIUS,
            despawnIdleSec: idleSec,
            maxLiving,
            spawnTimeMultiplier: Settings.SPAWN_TIME_MULTIPLIER,
            chunkSize: Settings.SPAWN_CHUNK_SIZE
        });
    }

    /**
     * Build WaveController from raw hunt waves config (or clear when absent).
     * @private
     */
    _initWaveController() {
        const normalized = normalizeWavesConfig(this._wavesConfigRaw);
        this.waveController = normalized
            ? new WaveController(normalized)
            : null;
    }

    /**
     * Whether route_complete should be suppressed (arena waves still running).
     * @returns {boolean}
     * @private
     */
    _holdRouteForWaves() {
        return !!(
            this.waveController &&
            this.waveController.holdRoute &&
            !this.waveController.isComplete
        );
    }

    /**
     * True when the active wave has no live creatures and no pending slots.
     * @returns {boolean}
     * @private
     */
    _isCurrentWaveClear() {
        if (!this.spawnManager || !this.spawnManager.size) {
            // Empty table after a wave materialize failure still counts as clear
            // only once we have entered an active wave (waveIndex >= 0).
            return !!(
                this.waveController &&
                this.waveController.phase === 'active' &&
                this.waveController.waveIndex >= 0
            );
        }
        const states = this.spawnManager.listStates();
        for (let i = 0; i < states.length; i++) {
            const s = states[i];
            if (!s) continue;
            if (s.spawned) return false;
            if (!s.exhausted) return false;
        }
        return true;
    }

    /**
     * Load one-shot spawn rows for the active wave and materialize eagerly.
     * @param {object[]} rows
     * @private
     */
    _applyWaveSpawnRows(rows) {
        if (!this.spawnManager) {
            this.spawnManager = this._createSpawnManager();
        }
        this.spawnManager.clear();
        if (!Array.isArray(rows) || !rows.length) return;
        this.spawnManager.load(rows);
        // Waves always eager-materialize the current pack (arena ring).
        this._tickSpawnManager();
    }

    /**
     * Advance wave FSM; emit pacing events; end with waves_complete when done.
     * @private
     */
    _tickWaveController() {
        if (!this.waveController || this.sessionState !== 'running') return;

        const result = this.waveController.tick({
            time: Time.timeSinceLevelLoad,
            waveClear: this._isCurrentWaveClear(),
            tileMap: this.tileMap,
            rng:
                typeof this.seededRandom === 'function'
                    ? this.seededRandom
                    : Math.random,
            defaultZ: this.floor != null ? this.floor : 0,
            // Spawn near living party members so packs land inside aggro range
            anchors: this._spawnObservers(),
            anchorRadius: (() => {
                const cfgR =
                    this.waveController &&
                    this.waveController.config &&
                    this.waveController.config.anchorRadius;
                if (cfgR != null) return cfgR;
                return Settings.AI_CREATURE_AGGRO_RANGE != null
                    ? Math.max(6, Settings.AI_CREATURE_AGGRO_RANGE + 1)
                    : 8;
            })()
        });

        if (result.spawnRows) {
            this._applyWaveSpawnRows(result.spawnRows);
        }

        const events = result.events || [];
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (!ev) continue;
            samplePacingEvent(this.telemetry, {
                kind: ev.kind,
                t: Time.timeSinceLevelLoad,
                tag:
                    ev.waveId != null
                        ? String(ev.waveId)
                        : ev.waveLabel != null
                          ? String(ev.waveLabel)
                          : null,
                entityId: ev.waveIndex != null ? ev.waveIndex : null
            });
        }

        if (
            result.complete &&
            this.waveController.endOnComplete &&
            this.sessionState === 'running'
        ) {
            this.sessionState = 'waves_complete';
            this.telemetry.endReason = 'waves_complete';
            this.telemetry.endTick = this.tickCount;
        }
    }

    /**
     * Reseed from replayConfig and fast-forward to logic tick T.
     * Same seed + T ⇒ same party tiles / telemetry core as a fresh run stopped at T.
     * Math.random is native when this resolves (soccer RNG contract).
     *
     * Performance:
     * - T === tickCount → no-op (UI sync only)
     * - T > tickCount → **forward-only** (no bootstrap): used for frame-step 534→535
     *   after a scrub land; full reseed on every +1 made multi-floor hops feel stuck
     * - T < tickCount or forceReseed → full reseed from seed then tick to T
     *
     * @param {number} targetTicks
     * @param {{ allowBeyondMax?: boolean, forceReseed?: boolean }} [opts]
     *   allowBeyondMax — headless/tests may seek past recorded max
     *   forceReseed — always rebuild from seed (ignore forward-only path)
     * @returns {Promise<void>}
     */
    async seekToTick(targetTicks, opts) {
        if (!this.replayConfig) return;

        const o = opts || {};
        const want = Math.max(0, Math.floor(Number(targetTicks) || 0));
        let maxTarget = Math.max(0, this.playbackMaxElapsedTicks | 0);
        if (o.allowBeyondMax || Settings.HEADLESS) {
            maxTarget = Math.max(maxTarget, want);
        }
        const target = Math.max(0, Math.min(want, maxTarget));

        // Already on the requested frame — avoid a multi-second multi-floor reseed
        if (target === this.tickCount && !o.forceReseed) {
            this.playbackElapsedTicks = this.tickCount;
            this.updateScrubberUI();
            return;
        }

        const wasActive = this.active;
        this._seekInProgress = true;
        this._playbackRecordingStopped = false;

        try {
            const canForward =
                !o.forceReseed &&
                target > this.tickCount &&
                this.active !== false &&
                this.tileMap &&
                (this.sessionState === 'running' ||
                    this.sessionState === 'idle');

            if (canForward) {
                // Frame-step / scrub forward: continue from current state.
                this.active = true;
                const steps = target - this.tickCount;
                for (let i = 0; i < steps; i++) {
                    Time.advanceFixedLogicStep();
                    this.updateAll();
                    if (
                        this.sessionState !== 'running' &&
                        this.sessionState !== 'idle'
                    ) {
                        break;
                    }
                }
            } else {
                // Backward scrub or force: full reseed from session seed
                this.applyReplayConfig(this.replayConfig);
                await this.start();
                this.active = true;

                for (let i = 0; i < target; i++) {
                    Time.advanceFixedLogicStep();
                    this.updateAll();
                    if (
                        this.sessionState !== 'running' &&
                        this.sessionState !== 'idle'
                    ) {
                        break;
                    }
                }
            }

            this.playbackElapsedTicks = this.tickCount;
            if (this.tickCount > this.playbackMaxElapsedTicks) {
                this.playbackMaxElapsedTicks = this.tickCount;
            }
            if (
                this.sessionState !== 'running' &&
                this.sessionState !== 'idle'
            ) {
                this._playbackRecordingStopped = true;
            }

            if (this.floatingCombatText && this.floatingCombatText.entries) {
                this.floatingCombatText.entries.length = 0;
            }
            if (this.combatEffects && typeof this.combatEffects.clear === 'function') {
                this.combatEffects.clear();
            }

            // Ensure camera z tracks leader after hop frames (watch mode)
            if (!Settings.HEADLESS && typeof this._updateCamera === 'function') {
                this._updateCamera();
            }
        } finally {
            this._seekInProgress = false;
            this.active = wasActive;
            // Never leave session LCG on Math.random after seek
            Math.random = NATIVE_MATH_RANDOM;
            this.updateScrubberUI();
        }
    }

    /** Soccer-style alias for seekToTick. */
    async seekPlayback(targetTicks, opts) {
        return this.seekToTick(targetTicks, opts);
    }

    /**
     * Sync #playbackSlider / #playbackFrameVal when present (watch mode).
     */
    updateScrubberUI() {
        if (Settings.HEADLESS || typeof document === 'undefined') return;
        const slider = document.getElementById('playbackSlider');
        const badge = document.getElementById('playbackFrameVal');
        const maxTicks = Math.max(0, this.playbackMaxElapsedTicks | 0);
        const curTicks = Math.max(0, this.playbackElapsedTicks | 0);
        if (slider) {
            slider.min = '0';
            slider.max = String(Math.max(1, maxTicks));
            slider.value = String(Math.min(curTicks, maxTicks));
            slider.disabled = !this.replayConfig || maxTicks <= 0;
        }
        if (badge) {
            badge.textContent = `${curTicks} / ${maxTicks}`;
        }
    }

    /**
     * Expand scrub range during live play (not during seek).
     * @private
     */
    _recordPlaybackTick() {
        if (this._seekInProgress || this._playbackRecordingStopped) return;
        this.playbackElapsedTicks = this.tickCount;
        if (this.tickCount > this.playbackMaxElapsedTicks) {
            this.playbackMaxElapsedTicks = this.tickCount;
        }
        if (
            this.sessionState !== 'running' &&
            this.sessionState !== 'idle'
        ) {
            this._playbackRecordingStopped = true;
            this.playbackMaxElapsedTicks = this.tickCount;
            this.playbackElapsedTicks = this.tickCount;
        }
        if (!Settings.HEADLESS) {
            this.updateScrubberUI();
        }
    }

    /**
     * Allocate a positive entity id for occupancy.
     * @returns {number}
     */
    allocEntityId() {
        const id = this.nextEntityId;
        this.nextEntityId += 1;
        return id;
    }

    /**
     * @param {object} player
     * @returns {Party|null}
     */
    findPartyOf(player) {
        if (!player) return null;
        if (player.party) return player.party;
        for (let i = 0; i < this.parties.length; i++) {
            const p = this.parties[i];
            if (p.members.indexOf(player) >= 0) return p;
        }
        return null;
    }

    /**
     * Create session LCG and install on Math.random (logic ticks / bootstrap only).
     * Callers must restore native Math.random in a finally block.
     */
    bindSeededRandom() {
        this.seededRandom = Utils.createSeededRandom(this.seed);
        Math.random = this.seededRandom;
        return this.seededRandom;
    }

    /**
     * Restore platform Math.random (does not clear this.seededRandom).
     */
    unbindSeededRandom() {
        Math.random = NATIVE_MATH_RANDOM;
    }

    /**
     * Load map (if configured), spawn parties + creatures under seeded RNG.
     * Math.random is native again when start() returns (soccer-oss contract).
     *
     * Important: session LCG is **not** bound across `await loadMaps()`.
     * In the browser, paint / image / timer microtasks can interleave on await
     * and would steal LCG draws if Math.random were still the session seed —
     * desyncing spawns from headless (docs/25 multi-floor watch gap).
     *
     * @returns {Promise<void>}
     */
    async start() {
        // Drop prior parties/creatures so re-start / seek does not double-spawn
        this.clearSessionEntities();

        Time.resetTimeSinceLevelLoad();
        this.tickCount = 0;
        this.stepLog = [];
        this.floorHopLog = [];
        this.parityTickLog = [];
        this._parityWindow = this._parityFixedWindow
            ? {
                  from: this._parityFixedWindow.from,
                  to: this._parityFixedWindow.to
              }
            : null;
        this._parityAttacksThisTick = [];
        this._parityDrawsAtTickStart = 0;
        this.telemetry = createEmptyHuntTelemetry();
        this.telemetry.commandHistory = this.commandHistory;
        this.telemetry.startTick = 0;
        this.telemetry.endTick = null;
        this._lastAttackTick = 0;
        this._biomeTransitionSeen = new Set();
        // Phase C: freeze exp flags/rates as session inputs (UI pre-run only)
        this.sessionExpConfig = freezeExpSessionConfig(this.expConfig || {});
        this.sessionState = 'running';
        this.active = true;

        // Fresh playback counters only when not mid-seek (seek owns range)
        if (!this._seekInProgress) {
            this.playbackElapsedTicks = 0;
            this.playbackMaxElapsedTicks = 0;
            this._playbackRecordingStopped = false;
        }

        // Lazy-load presets on Node when loaders not injected (no RNG)
        this._ensurePresetLoaders();

        // Recreate manager so mode/knobs match Settings at session start
        this.spawnManager = this._createSpawnManager();
        this._initWaveController();

        // Maps / friction / stairs: no session RNG. Keep native Math.random so
        // browser interleaves during await cannot advance the hunt LCG.
        if (
            this.mapPath ||
            this.floor != null ||
            (this.floors && this.floors.length) ||
            this.mapPaths ||
            this.floorLayers
        ) {
            await this.loadMaps();
        }

        const prevRandom = Math.random;
        try {
            this.bindSeededRandom();

            if (this._partyConfigs && this._partyConfigs.length) {
                for (let i = 0; i < this._partyConfigs.length; i++) {
                    this.spawnParty(this._partyConfigs[i]);
                }
            }

            // Sequential waves own the spawn table; flat spawns only when no waves.
            if (this.waveController) {
                this.waveController.begin(Time.timeSinceLevelLoad);
                // startDelaySec === 0 materializes wave 0 immediately under seed
                this._tickWaveController();
            } else if (this._spawnConfigs && this._spawnConfigs.length) {
                this.spawnManager.load(this._spawnConfigs);
                // Eager: materialize all ready slots at start (legacy hunt table).
                // on_demand: wait until observers are in range during combat ticks.
                if (this.spawnMode === 'eager') {
                    this._tickSpawnManager();
                }
            }

            // Stage 11.2: materialize marker props (always eager; sparse clickies)
            if (this._propConfigs && this._propConfigs.length) {
                for (let i = 0; i < this._propConfigs.length; i++) {
                    this.spawnProp(this._propConfigs[i]);
                }
            }

            // Capture after bootstrap so mapPath/floor are resolved
            this.replayConfig = this.captureReplayConfig();
        } finally {
            // Keep this.seededRandom for updateAll; never leave LCG on Math.random
            Math.random = NATIVE_MATH_RANDOM;
            void prevRandom;
        }

        if (!this._seekInProgress) {
            this.updateScrubberUI();
        }
    }

    /**
     * Wire Node preset loaders if missing (no-op in browser without cache).
     * @private
     */
    _ensurePresetLoaders() {
        if (this._classLoader && this._creatureLoader && this._itemDb) {
            if (!Object.keys(this.spellBook).length) {
                try {
                    const presets = require('../../core/lib/presets.js');
                    this.spellBook = ensureSpellBook(presets.loadSpells().spells);
                    const strat = presets.loadStrategies();
                    if (strat && strat.strategies && strat.strategies.length) {
                        this.strategyTable = indexStrategies(strat);
                    }
                } catch (_) {
                    /* ignore */
                }
            }
            return;
        }
        try {
            const presets = require('../../core/lib/presets.js');
            const genre = this.genre || undefined;
            if (!this._classLoader) {
                this._classLoader = (id) => presets.getClass(id);
            }
            if (!this._creatureLoader) {
                this._creatureLoader = (id) => {
                    try {
                        return presets.loadCreatureTemplate(id, { genre });
                    } catch (_) {
                        return null;
                    }
                };
            }
            if (!this._itemDb) {
                // Stage 9: catalog equipment (category defaults) + preset overrides
                try {
                    this._itemDb = presets.loadCombatItemDb({ genre });
                } catch (_) {
                    const eq = presets.loadEquipment();
                    this._itemDb = eq.items || eq;
                }
            }
            if (!Object.keys(this.spellBook).length) {
                this.spellBook = ensureSpellBook(presets.loadSpells().spells);
            }
            const strat = presets.loadStrategies();
            if (strat && strat.strategies && strat.strategies.length) {
                this.strategyTable = indexStrategies(strat);
            }
        } catch (_) {
            // Browser / missing fs — callers inject loaders
        }
    }

    /**
     * Load one collision floor into the tile map.
     * Prefer in-memory floorLayers (Stage 11.4) over path PNG when present.
     * @param {string|number|null} [floor]
     * @param {string|null} [pathOverride]
     * @returns {Promise<TileMap>}
     */
    async loadMap(floor, pathOverride) {
        if (!this.tileMap) {
            this.tileMap = new TileMap();
            this.insertChild(this.tileMap);
            this._wireTileMapSpatialHooks(this.tileMap);
        }
        const z = floor != null ? floor : 7;
        const layer =
            this.floorLayers &&
            (this.floorLayers[String(z)] || this.floorLayers[z]);
        if (layer && layer.friction && layer.cols && layer.rows) {
            this.tileMap.loadFloorFromFriction(
                z,
                layer.cols | 0,
                layer.rows | 0,
                layer.friction
            );
            // Stage 11.9: attach decorative art when present
            if (this.artLayers) {
                const art =
                    this.artLayers[String(z)] || this.artLayers[z] || null;
                if (art) {
                    const artWithGenre = Object.assign({}, art, {
                        genre: art.genre || this.genre || null
                    });
                    this.tileMap.setArtLayer(z, artWithGenre);
                }
            }
            if (this.floor == null) this.floor = z;
            // Keep mapPath null-ish so replay knows this was generated
            if (!this.mapPath) this.mapPath = `friction://${z}`;
            return this.tileMap;
        }
        const pathPng =
            pathOverride ||
            (this.mapPaths && this.mapPaths[String(z)]) ||
            mapPathPng(z);
        await this.tileMap.loadFloor(z, pathPng);
        if (this.floor == null) this.floor = z;
        this.mapPath = pathPng;
        return this.tileMap;
    }

    /**
     * Load all configured floors (Stage 9 multi-floor).
     * Uses `floors` array when set; else single `floor` / `mapPath` / floorLayers.
     * Stage 12H: installs first-class stair tiles + optional navmesh after floors load.
     * @returns {Promise<TileMap>}
     */
    async loadMaps() {
        /** @type {(string|number)[]} */
        let list = [];
        if (this.floors && this.floors.length) {
            list = this.floors.slice();
        } else if (this.floor != null) {
            list = [this.floor];
        } else if (this.floorLayers) {
            list = Object.keys(this.floorLayers);
        } else if (this.mapPath) {
            list = [7];
        } else if (this.mapPaths) {
            list = Object.keys(this.mapPaths);
        }
        if (!list.length) {
            throw new Error('loadMaps: no floors configured');
        }
        for (let i = 0; i < list.length; i++) {
            const z = list[i];
            const override =
                this.mapPaths && this.mapPaths[String(z)]
                    ? this.mapPaths[String(z)]
                    : i === 0 && this.mapPath && list.length === 1
                      ? this.mapPath
                      : null;
            await this.loadMap(z, override);
        }
        this._installStairsAndNavmesh();
        return this.tileMap;
    }

    /**
     * Stage 12H: push session stairLinks onto TileMap and attach navmesh graph.
     * Safe to call multiple times; stairs are replaced from session links.
     * @private
     */
    _installStairsAndNavmesh() {
        if (!this.tileMap) return;
        const links = this._collectStairLinks();
        if (links.length) {
            this.tileMap.setStairs(links);
        }
        if (this._navmeshData) {
            try {
                this.tileMap.setNavmesh(new Navmesh(this._navmeshData));
            } catch (err) {
                // Invalid graph should not block hunt start
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn(
                        'Simulator: navmeshData rejected',
                        err && err.message ? err.message : err
                    );
                }
            }
        }
    }

    /**
     * Merge session + party-config stair links for TileMap install.
     * @returns {{ from: object, to: object, link?: string|null }[]}
     * @private
     */
    _collectStairLinks() {
        /** @type {{ from: object, to: object, link?: string|null }[]} */
        const out = [];
        const seen = Object.create(null);
        const push = (L) => {
            if (!L || !L.from || !L.to) return;
            const key = `${L.from.x},${L.from.y},${L.from.z}->${L.to.x},${L.to.y},${L.to.z}`;
            if (seen[key]) return;
            seen[key] = true;
            out.push({
                from: {
                    x: Math.round(L.from.x),
                    y: Math.round(L.from.y),
                    z: L.from.z
                },
                to: {
                    x: Math.round(L.to.x),
                    y: Math.round(L.to.y),
                    z: L.to.z
                },
                link: L.link != null ? L.link : null
            });
        };
        if (Array.isArray(this._stairLinks)) {
            for (let i = 0; i < this._stairLinks.length; i++) {
                push(this._stairLinks[i]);
            }
        }
        if (Array.isArray(this._partyConfigs)) {
            for (let i = 0; i < this._partyConfigs.length; i++) {
                const p = this._partyConfigs[i];
                if (!p || !Array.isArray(p.stairLinks)) continue;
                for (let j = 0; j < p.stairLinks.length; j++) {
                    push(p.stairLinks[j]);
                }
            }
        }
        return out;
    }

    /**
     * Install a pre-built TileMap (tests) or reuse existing.
     * @param {TileMap} tileMap
     */
    setTileMap(tileMap) {
        if (this.tileMap && this.tileMap !== tileMap) {
            this.tileMap.destroy();
        }
        this.tileMap = tileMap;
        if (tileMap && tileMap.parent !== this) {
            this.insertChild(tileMap);
        }
        this._wireTileMapSpatialHooks(tileMap);
        // Re-apply session stairs/nav when tests inject a map after construct
        this._installStairsAndNavmesh();
    }

    /**
     * Keep creature + player spatial indexes in sync when entities change tiles.
     * @param {TileMap|null} tileMap
     * @private
     */
    _wireTileMapSpatialHooks(tileMap) {
        if (!tileMap) return;
        tileMap.groundStore = this.groundItems || tileMap.groundStore || null;
        tileMap.groundItems = this.groundItems || tileMap.groundItems || null;
        if (this.groundItems) {
            this.groundItems.tileMap = tileMap;
        }
        // Party ally-pass (swap/yield) needs occupancy id → entity
        tileMap.resolveEntity = (id) => this.getEntityById(id);
        tileMap.onEntityTileMoved = (entity, _prev, _next) => {
            if (!entity || entity.id == null) return;
            if (!this.entityById.has(entity.id)) return;
            // Creatures (Etapa 1)
            if (
                this.creatureSpatialIndex &&
                this.creatureSpatialIndex !== false &&
                this.creatureSpatialIndex.has(entity.id)
            ) {
                this.creatureSpatialIndex.update(entity);
            }
            // Players (Etapa 5) — party members are not in creatures[]
            if (
                this.playerSpatialIndex &&
                this.playerSpatialIndex !== false &&
                this.playerSpatialIndex.has(entity.id)
            ) {
                this.playerSpatialIndex.update(entity);
            }
        };
    }

    /**
     * Build a Party from config, place members on the map, insert into scene.
     *
     * Config:
     *   { name?, id?, enabled?, waypoints: [{x,y,z}], members: [{ name?, classId?, … }] }
     *
     * @param {object} config
     * @returns {Party}
     */
    spawnParty(config) {
        if (!config) {
            throw new Error('spawnParty: config required');
        }
        if (!this.tileMap) {
            throw new Error('spawnParty: load a map first');
        }

        const waypoints = config.waypoints || [];
        if (!waypoints.length) {
            throw new Error('spawnParty: waypoints required');
        }

        const stairLinks =
            config.stairLinks || this._stairLinks || null;

        // Stage 12H: ensure party-only stair links also land on TileMap
        if (
            Array.isArray(config.stairLinks) &&
            config.stairLinks.length &&
            this.tileMap
        ) {
            this.tileMap.addStairLinks(config.stairLinks);
        }

        const loopWaypoints = !!config.loopWaypoints;
        const party = new Party({
            name: config.name || 'Party',
            id: config.id != null ? config.id : config.name || 'Party',
            enabled: config.enabled !== false,
            waypoints,
            loopWaypoints,
            // Stage 11.8 multi-floor stair pads (party still keeps a copy)
            stairLinks
        });

        const memberDefs = Array.isArray(config.members) && config.members.length
            ? config.members
            : [{ name: 'Leader', isLeader: true }];

        const start = waypoints[0];
        const z = start.z !== undefined ? start.z : this.floor != null ? this.floor : 0;

        for (let i = 0; i < memberDefs.length; i++) {
            const def = memberDefs[i] || {};
            const id = this.allocEntityId();
            const isLeader = def.isLeader != null ? !!def.isLeader : i === 0;

            const spawnTile = findSpawnTile(this.tileMap, start.x, start.y, z, i);
            if (!spawnTile) {
                throw new Error(
                    `spawnParty: no free tile near start for member ${i} at ${start.x},${start.y},z=${z}`
                );
            }

            const classId = def.classId || def.vocation || 'adventurer';
            const classDef =
                def.classDef ||
                (this._classLoader ? this._classLoader(classId) : null);
            // Watch art: profile customSprite → vocation baseSprite → polygon
            const art = resolvePlayerSpriteArt(def, classDef);
            const player = new Player({
                id,
                name: def.name || (isLeader ? 'Leader' : `Member${i}`),
                classId,
                speed: def.speed,
                hp: def.hp,
                hpMax: def.hpMax,
                level: def.level,
                isLeader,
                leaderId: null,
                equipment: normalizeEquipmentMap(def.equipment),
                strategyId: def.strategyId || null,
                strategy: def.strategy || null,
                skills: def.skills || null,
                critChance: def.critChance,
                critDamage: def.critDamage,
                promoted: def.promoted,
                controlMode: this.forceAiControl ? 'ai' : (def.controlMode || 'ai'),
                autoChase: !!def.autoChase,
                commandQueue: this.forceAiControl ? [] : (Array.isArray(def.commandQueue) ? clonePlain(def.commandQueue) : (def.commandQueue || [])),
                spriteId: art.spriteId || undefined,
                spriteGenre: art.spriteGenre || undefined,
                tile: { x: spawnTile.x, y: spawnTile.y, z }
            });

            // Inventory (root backpack + nested bags) then combat loadout.
            // Seed from def.inventory / def.backpack; sandbox flag for Scenario Lab.
            if (typeof player.initInventory === 'function') {
                const invSeed =
                    def.inventory && typeof def.inventory === 'object'
                        ? Object.assign({}, def.inventory)
                        : {};
                if (def.backpack != null && invSeed.backpack == null) {
                    invSeed.backpack = def.backpack;
                }
                if (def.inventorySandbox === true || invSeed.sandbox === true) {
                    invSeed.sandbox = true;
                }
                if (!invSeed.equipment) {
                    invSeed.equipment = player.equipment;
                }
                player.initInventory(invSeed, this._itemDb);
            }

            // Apply class + equipment combat stats when loaders available
            if (!def.combatStats) {
                if (classDef) {
                    player.applyClassLoadout(classDef, this._itemDb, {
                        level:
                            def.level != null
                                ? def.level
                                : classDef.defaultLevel,
                        baseSkills: def.skills || null,
                        skillOverrides: def.skillOverrides || null,
                        critChance: def.critChance,
                        critDamage: def.critDamage,
                        promoted: def.promoted
                    });
                }
            } else {
                player.applyCombatStats(def.combatStats);
            }
            // Re-apply art after loadout (loadout does not touch sprites; keep explicit)
            if (art.spriteId) {
                player.spriteId = art.spriteId;
                if (art.spriteGenre) player.spriteGenre = art.spriteGenre;
            }

            // Override hp after loadout if explicitly set
            if (def.hp != null) {
                player.hp.current = def.hp;
                player.alive = player.hp.current > 0;
            }
            if (def.hpMax != null) player.hp.max = def.hpMax;
            if (def.speed != null) player.speed = def.speed;

            // Phase C: seed total exp from level (or explicit def.experience)
            if (def.experience != null && Number.isFinite(Number(def.experience))) {
                player.experience = Math.max(0, Math.floor(Number(def.experience)));
            } else {
                seedPlayerExperience(player);
            }

            if (!this.tileMap.tryOccupy(spawnTile.x, spawnTile.y, z, player)) {
                throw new Error(
                    `spawnParty: tryOccupy failed at ${spawnTile.x},${spawnTile.y},z=${z}`
                );
            }
            player.moveDelay = 0;
            player.syncPositionFromTile();

            if (
                player.tile.x === start.x &&
                player.tile.y === start.y &&
                waypoints.length > 1
            ) {
                player.currentWaypoint = 1;
            } else if (
                player.tile.x === start.x &&
                player.tile.y === start.y &&
                waypoints.length <= 1
            ) {
                // Single wp: complete unless looping (patrol stays on route).
                if (loopWaypoints) {
                    player.currentWaypoint = 0;
                    player.routeComplete = false;
                } else {
                    player.routeComplete = true;
                    player.currentWaypoint = waypoints.length;
                }
            } else {
                player.currentWaypoint = 0;
            }

            if (this.combatAi) {
                initPlayerAi(player, {
                    strategyId: player.strategyId,
                    strategy: player.strategy,
                    strategyTable: this.strategyTable
                });
            }

            this.entityById.set(player.id, player);
            party.addMember(player);
        }

        const leader = party.getLeader();
        if (leader) {
            for (const m of party.members) {
                if (m !== leader) m.leaderId = leader.id;
            }
        }

        this.parties.push(party);
        this.insertChild(party);
        // Etapa 5: index party members for creature aggro spatial queries
        if (this.playerSpatialIndex && this.playerSpatialIndex !== false) {
            for (let i = 0; i < party.members.length; i++) {
                const m = party.members[i];
                if (m && m.id != null) this.playerSpatialIndex.insert(m);
            }
        } else {
            this._playerSpatialDirty = true;
        }
        return party;
    }

    /**
     * Spawn one interactive prop from a marker-resolved def.
     * { objectId, x, y, z?, effect?, lootValue?, healAmount?, blocking? }
     *
     * @param {object} entry
     * @returns {Prop|null}
     */
    spawnProp(entry) {
        if (!entry || !this.tileMap) return null;
        const z =
            entry.z !== undefined
                ? entry.z
                : this.floor != null
                  ? this.floor
                  : 0;
        const x = Math.round(entry.x);
        const y = Math.round(entry.y);
        const objectId = entry.objectId || entry.id || 'barrel';
        if (objectId == null) return null;

        // Prefer exact tile when walkable; else nearest free (non-blocking can share)
        let tileXY = null;
        if (
            typeof this.tileMap.canEnter === 'function' &&
            this.tileMap.canEnter(x, y, z, null)
        ) {
            tileXY = { x, y };
        } else {
            tileXY = findSpawnTile(this.tileMap, x, y, z, 0);
        }
        if (!tileXY) return null;

        const id = this.allocEntityId();
        const prop = new Prop({
            id,
            name: entry.name || objectId,
            objectId: String(objectId),
            markerId: entry.markerId != null ? String(entry.markerId) : null,
            effect: entry.effect || 'break',
            lootValue: entry.lootValue != null ? entry.lootValue : 0,
            healAmount: entry.healAmount != null ? entry.healAmount : 0,
            blocking: entry.blocking === true,
            pacingTag: entry.pacingTag != null ? entry.pacingTag : null,
            tile: { x: tileXY.x, y: tileXY.y, z }
        });
        prop.syncPositionFromTile();

        if (prop.blocking) {
            if (!this.tileMap.tryOccupy(tileXY.x, tileXY.y, z, prop)) {
                return null;
            }
        }

        prop._propEntry = {
            objectId: prop.objectId,
            x: tileXY.x,
            y: tileXY.y,
            z,
            effect: prop.effect,
            lootValue: prop.lootValue,
            healAmount: prop.healAmount,
            blocking: prop.blocking,
            markerId: prop.markerId
        };

        this.props.push(prop);
        this.entityById.set(prop.id, prop);
        this.insertChild(prop);
        this.telemetry.propsSpawned = (this.telemetry.propsSpawned || 0) + 1;
        return prop;
    }

    /**
     * Use a prop (break / loot / heal). Emits pacing micro-loop event.
     * @param {Prop} prop
     * @param {object|null} [user] party member who used it
     * @returns {boolean}
     */
    useProp(prop, user) {
        if (!prop || !prop.alive || prop.used) return false;
        prop.used = true;
        prop.alive = false;

        const loot = prop.lootValue || 0;
        const heal = prop.healAmount || 0;
        if (heal > 0 && user && user.hp) {
            const max = user.hp.max != null ? user.hp.max : user.hp.current;
            user.hp.current = Math.min(
                max,
                (user.hp.current || 0) + heal
            );
        }
        if (user && user.type === 'player' && loot > 0) {
            const party = this.findPartyOf(user);
            if (party) {
                party.lootGained = (party.lootGained || 0) + loot;
            }
        }

        samplePropUse(this.telemetry, {
            t: Time.timeSinceLevelLoad,
            effect: prop.effect,
            tag: prop.pacingTag || prop.effect,
            entityId: prop.id != null ? prop.id : null,
            objectId: prop.objectId,
            loot,
            heal
        });

        if (this.tileMap && prop.tile && prop.blocking) {
            this.tileMap.release(
                prop.tile.x,
                prop.tile.y,
                prop.tile.z,
                prop
            );
        }
        this.entityById.delete(prop.id);
        const idx = this.props.indexOf(prop);
        if (idx >= 0) this.props.splice(idx, 1);
        if (typeof prop.destroy === 'function') prop.destroy();
        return true;
    }

    /**
     * Auto-use props within Chebyshev range 1 of any living party member.
     * Feeds Stage 11.0 micro-loop without a full interact FSM.
     * @returns {number} number of props used this call
     * @private
     */
    _tickPropInteractions() {
        if (!this.props || !this.props.length) return 0;
        let used = 0;
        const members = [];
        for (let i = 0; i < this.parties.length; i++) {
            const party = this.parties[i];
            if (!party || !party.members) continue;
            for (let j = 0; j < party.members.length; j++) {
                const m = party.members[j];
                if (!m || !m.alive || !m.tile) continue;
                members.push(m);
            }
        }
        if (!members.length) return 0;

        // Snapshot because useProp mutates this.props
        const list = this.props.slice();
        for (let p = 0; p < list.length; p++) {
            const prop = list[p];
            if (!prop || !prop.alive || prop.used || !prop.tile) continue;
            for (let m = 0; m < members.length; m++) {
                const member = members[m];
                if (String(member.tile.z) !== String(prop.tile.z)) continue;
                if (tileDistance(member.tile, prop.tile) <= 1) {
                    if (this.useProp(prop, member)) used += 1;
                    break;
                }
            }
        }
        return used;
    }

    /**
     * Spawn one creature from a spawn-table entry.
     * { creatureId, x, y, z?, respawn?, template? }
     *
     * @param {object} entry
     * @returns {Creature|null}
     */
    spawnFromTable(entry) {
        if (!entry || !this.tileMap) return null;
        const z =
            entry.z !== undefined
                ? entry.z
                : this.floor != null
                  ? this.floor
                  : 0;
        const x = Math.round(entry.x);
        const y = Math.round(entry.y);
        const creatureId = entry.creatureId || entry.id;
        if (!creatureId) {
            return null;
        }

        let template = entry.template || null;
        if (!template && this._creatureLoader) {
            template = this._creatureLoader(creatureId);
        }
        if (!template) {
            // No hard-coded monster names/stats in engine — data must resolve.
            return null;
        }

        const tile = findSpawnTile(this.tileMap, x, y, z, 0, { template });
        if (!tile) {
            return null;
        }

        const id = this.allocEntityId();
        const creature = new Creature({
            id,
            name: template.label || creatureId,
            creatureType: template.id || creatureId,
            tile: { x: tile.x, y: tile.y, z },
            homeTile: { x: tile.x, y: tile.y, z },
            respawn: entry.respawn != null ? entry.respawn : 0,
            aggro: template.aggro !== undefined ? template.aggro : true
        });
        creature.applyTemplate(template);
        if (entry.respawn != null) creature.respawnTime = Number(entry.respawn);

        // Stage 11.1 population affix stubs (rarity tags + stat mults on spawn def)
        if (entry.rarity != null) creature.rarity = String(entry.rarity);
        if (Array.isArray(entry.affixes)) {
            creature.affixes = entry.affixes.map((a) => String(a));
        }
        if (entry.groupId != null) {
            creature.populationGroupId = String(entry.groupId);
        }
        const hpMult =
            entry.hpMult != null
                ? Number(entry.hpMult)
                : entry.statMult && entry.statMult.hp != null
                  ? Number(entry.statMult.hp)
                  : 1;
        const atkMult =
            entry.atkMult != null
                ? Number(entry.atkMult)
                : entry.statMult && entry.statMult.atk != null
                  ? Number(entry.statMult.atk)
                  : 1;
        const expMult =
            entry.expMult != null
                ? Number(entry.expMult)
                : entry.statMult && entry.statMult.exp != null
                  ? Number(entry.statMult.exp)
                  : 1;
        if (hpMult > 0 && hpMult !== 1) {
            creature.hp.max = Math.max(1, Math.round(creature.hp.max * hpMult));
            creature.hp.current = creature.hp.max;
        }
        if (atkMult > 0 && atkMult !== 1) {
            // Scales kit attacks[].min/max and on-hit condition.totalDamage.
            applyKitDamageMult(creature, atkMult);
        }
        if (expMult > 0 && expMult !== 1) {
            creature.expValue = Math.round(
                Number(creature.expValue || 0) * expMult
            );
        }

        if (!this.tileMap.tryOccupy(tile.x, tile.y, z, creature)) {
            return null;
        }
        creature.moveDelay = 0;
        creature.syncPositionFromTile();

        if (this.combatAi) {
            initCreatureAi(creature);
        }

        this.creatures.push(creature);
        this.entityById.set(creature.id, creature);
        this.insertChild(creature);
        if (this.creatureSpatialIndex && this.creatureSpatialIndex !== false) {
            this.creatureSpatialIndex.insert(creature);
        } else {
            this._creatureSpatialDirty = true;
        }
        this.telemetry.creaturesSpawned += 1;
        // Keep spawn meta for respawn / manager slot link
        creature._spawnEntry = {
            creatureId,
            x: tile.x,
            y: tile.y,
            z,
            respawn: creature.respawnTime,
            template
        };
        if (entry._spawnSlotKey != null) {
            creature._spawnSlotKey = entry._spawnSlotKey;
            creature._spawnEntry.key = entry._spawnSlotKey;
        }
        return creature;
    }

    /**
     * Resolve entity by id (players, creatures, props).
     * @param {number|string} id
     * @returns {object|null}
     */
    getEntityById(id) {
        if (id == null || !this.entityById) return null;
        return this.entityById.get(id) || null;
    }

    /**
     * Spawn a summon near its master (monster auto-summon AI).
     * Links masterId / summonIds; no spawn-manager respawn slot.
     *
     * @param {object} opts
     * @param {string} opts.creatureId Template id
     * @param {object} opts.master Master creature
     * @param {number} [opts.x]
     * @param {number} [opts.y]
     * @param {string|number} [opts.z]
     * @param {boolean} [opts.force] Prefer adjacent free tiles (spiral)
     * @returns {Creature|null}
     */
    spawnSummon(opts) {
        const o = opts || {};
        const master = o.master;
        if (!master || !master.tile || master.alive === false) return null;
        const creatureId = o.creatureId || o.id;
        if (!creatureId) return null;

        // Nested summons not allowed
        if (isSummon(master)) return null;

        const mx = o.x != null ? Math.round(o.x) : master.tile.x;
        const my = o.y != null ? Math.round(o.y) : master.tile.y;
        const z =
            o.z !== undefined && o.z !== null
                ? o.z
                : master.tile.z;

        let template = o.template || null;
        if (!template && typeof this._creatureLoader === 'function') {
            template = this._creatureLoader(creatureId);
        }

        // Prefer adjacent free tile (memberIndex 1 skips exact master tile)
        const near = findSpawnTile(this.tileMap, mx, my, z, 1, { template });
        if (!near) return null;

        const creature = this.spawnFromTable({
            creatureId,
            template,
            x: near.x,
            y: near.y,
            z,
            respawn: 0
        });
        if (!creature) return null;

        // No world respawn for summoned adds
        creature.respawnTime = 0;
        creature._spawnSlotKey = null;
        if (creature._spawnEntry) {
            creature._spawnEntry.respawn = 0;
            delete creature._spawnEntry.key;
        }

        creature.masterId = master.id;
        creature.homeTile = master.homeTile
            ? {
                  x: master.homeTile.x,
                  y: master.homeTile.y,
                  z: master.homeTile.z
              }
            : {
                  x: master.tile.x,
                  y: master.tile.y,
                  z: master.tile.z
              };
        creature.spawnTile = {
            x: creature.tile.x,
            y: creature.tile.y,
            z: creature.tile.z
        };

        // Inherit combat engagement when master is sticky
        if (master.target && master.target.alive !== false) {
            creature.target = master.target;
            creature.targetId = master.targetId;
            creature.inBattle = true;
        } else if (master.inBattle) {
            creature.inBattle = true;
        }

        if (!Array.isArray(master.summonIds)) master.summonIds = [];
        master.summonIds.push(creature.id);

        return creature;
    }

    /**
     * Unlink summon from master list (on summon death).
     * @param {object} summon
     */
    unlinkSummon(summon) {
        if (!summon || summon.masterId == null) return;
        const master = this.getEntityById(summon.masterId);
        if (master && Array.isArray(master.summonIds)) {
            master.summonIds = master.summonIds.filter(
                (id) => id !== summon.id
            );
        }
        summon.masterId = null;
    }

    /**
     * Kill all living summons of a master (master death dismisses summons).
     * @param {object} master
     */
    killSummonsOf(master) {
        if (!master || !Array.isArray(master.summonIds)) return;
        const ids = master.summonIds.slice();
        master.summonIds = [];
        for (let i = 0; i < ids.length; i++) {
            const s = this.getEntityById(ids[i]);
            if (!s || s.alive === false) continue;
            s.masterId = null;
            s.hp.current = 0;
            s.alive = false;
            if (this.tileMap && s.tile) {
                this.tileMap.release(s.tile.x, s.tile.y, s.tile.z, s);
            }
            if (this.spawnManager && s.id != null) {
                this.spawnManager.notifyEntityGone(
                    s.id,
                    Time.timeSinceLevelLoad
                );
            }
            // Summons grant no kill awards when master dies (cleanup only)
            samplePacingEvent(this.telemetry, {
                kind: 'summon_dismiss',
                t: Time.timeSinceLevelLoad,
                entityId: s.id != null ? s.id : null,
                tag: pacingTagFromEntity(s)
            });
        }
    }

    /**
     * Remove creature from AI/occupancy (despawn leash / spawn manager).
     * @param {Creature} creature
     */
    despawnCreature(creature) {
        if (!creature) return;
        // Master despawn: dismiss summons first
        if (
            !isSummon(creature) &&
            Array.isArray(creature.summonIds) &&
            creature.summonIds.length
        ) {
            this.killSummonsOf(creature);
        } else if (isSummon(creature)) {
            this.unlinkSummon(creature);
        }
        if (this.tileMap && creature.tile) {
            this.tileMap.release(
                creature.tile.x,
                creature.tile.y,
                creature.tile.z,
                creature
            );
        }
        creature.alive = false;
        creature.hp.current = 0;
        const idx = this.creatures.indexOf(creature);
        if (idx >= 0) this.creatures.splice(idx, 1);
        this.entityById.delete(creature.id);
        if (this.creatureSpatialIndex && this.creatureSpatialIndex !== false) {
            this.creatureSpatialIndex.remove(creature.id);
        } else {
            this._creatureSpatialDirty = true;
        }
        if (this.spawnManager && creature.id != null) {
            this.spawnManager.notifyEntityGone(
                creature.id,
                Time.timeSinceLevelLoad
            );
        }
        if (creature.parent === this) {
            // GameObject has no removeChild always — destroy child
            if (typeof creature.destroy === 'function') creature.destroy();
        }
    }

    /**
     * Record attack result into telemetry + kill awards.
     * @param {object} attacker
     * @param {object} defender
     * @param {object} result resolveAttack result
     */
    recordAttack(attacker, defender, result) {
        if (!result || !result.ok) return;

        this._lastAttackTick = this.tickCount;
        const sampled = sampleAttack(this.telemetry, attacker, defender, result);
        const dealt = sampled.dealt;

        // provokedUntil is stamped only in resolveAttack (single source of truth).

        // Watch-mode floating numbers + combat VFX (no-op when HEADLESS / seek)
        if (!Settings.HEADLESS && defender && defender.tile) {
            const fctZ =
                defender.tile.z !== undefined && defender.tile.z !== null
                    ? defender.tile.z
                    : undefined;
            const missed = result.miss || result.hit === false;
            if (missed) {
                this.emitCombatText({
                    x: defender.tile.x,
                    y: defender.tile.y,
                    z: fctZ,
                    text: 'miss',
                    color: '#9ca3af'
                });
            } else if (dealt > 0) {
                const isHeal =
                    (result.spell && result.spell.element === 'healing') ||
                    result.element === 'healing' ||
                    dealt < 0;
                const dPos = defender ? (getVisualTilePos(defender) || defender.tile) : defender ? defender.tile : null;
                this.emitCombatText({
                    x: dPos ? dPos.x : defender.tile.x,
                    y: dPos ? dPos.y : defender.tile.y,
                    z: fctZ,
                    text: isHeal
                        ? `+${Math.abs(Math.round(dealt))}`
                        : `-${Math.round(dealt)}`,
                    color: isHeal
                        ? '#34d399'
                        : result.critical || result.crit
                          ? '#fbbf24'
                          : attacker && attacker.type === 'player'
                            ? '#f87171'
                            : '#fb923c'
                });
                // Cheap hit flash + recoil on the defender sprite (damage only)
                if (!isHeal) {
                    beginHitFeedback(defender, attacker);
                }
            }
            this.emitCombatEffectsFromAttack(attacker, defender, result);
        }

        if (attacker && attacker.type === 'player' && dealt > 0) {
            attacker.damageDealt = (attacker.damageDealt || 0) + dealt;
            const party = this.findPartyOf(attacker);
            if (party) party.damageDealt += dealt;
            // Creature "damage" target strategy uses threat table on defender
            if (defender && defender.type === 'creature') {
                recordDamageTakenBy(defender, attacker, dealt);
                // Stage 11.0: first combat touch per creature for micro-loop spacing
                sampleCombatTouch(
                    this.telemetry,
                    defender.id != null ? defender.id : null,
                    Time.timeSinceLevelLoad,
                    pacingTagFromEntity(defender)
                );
            }
        } else if (attacker && attacker.type === 'creature' && dealt > 0) {
            if (defender && defender.type === 'player') {
                defender.damageTaken = (defender.damageTaken || 0) + dealt;
                const party = this.findPartyOf(defender);
                if (party) party.damageTaken += dealt;
            }
        }

        // Split-floor isolation: capture every attack in the open window
        // (including misses / zero damage) so live vs headless can diff.
        this._recordParityAttack(attacker, defender, result, dealt);

        // Death / kill
        if (defender && defender.alive === false) {
            if (defender.type === 'creature') {
                // Summon links: master death dismisses adds; summon death unlinks
                if (
                    !isSummon(defender) &&
                    Array.isArray(defender.summonIds) &&
                    defender.summonIds.length
                ) {
                    this.killSummonsOf(defender);
                } else if (isSummon(defender)) {
                    this.unlinkSummon(defender);
                }

                const exp = defender.expValue || 0;
                const loot = defender.lootValue || 0;
                samplePacingEvent(this.telemetry, {
                    kind: 'kill',
                    t: Time.timeSinceLevelLoad,
                    tag: pacingTagFromEntity(defender),
                    entityId: defender.id != null ? defender.id : null
                });
                const party =
                    attacker && attacker.type === 'player'
                        ? this.findPartyOf(attacker)
                        : this.parties[0];
                let award = {
                    awardedTotal: 0,
                    rawTotal: 0,
                    levelUps: 0
                };
                if (party) {
                    award = party.awardKill(exp, loot, {
                        sessionConfig: this.sessionExpConfig
                    });
                } else {
                    // No party: session still records monster exp as raw=awarded
                    award = {
                        awardedTotal: Math.max(0, Number(exp) || 0),
                        rawTotal: Math.max(0, Number(exp) || 0),
                        levelUps: 0
                    };
                }
                sampleKill(this.telemetry, {
                    exp: award.awardedTotal,
                    rawExp: award.rawTotal,
                    loot,
                    levelUps: award.levelUps
                });

                // Release tile; SpawnManager owns respawn cooldowns
                if (this.tileMap && defender.tile) {
                    this.tileMap.release(
                        defender.tile.x,
                        defender.tile.y,
                        defender.tile.z,
                        defender
                    );
                }
                if (this.spawnManager && defender.id != null) {
                    this.spawnManager.notifyEntityGone(
                        defender.id,
                        Time.timeSinceLevelLoad
                    );
                }
            } else if (defender.type === 'player') {
                sampleDeath(this.telemetry);
                samplePacingEvent(this.telemetry, {
                    kind: 'death',
                    t: Time.timeSinceLevelLoad,
                    entityId: defender.id != null ? defender.id : null
                });
                const party = this.findPartyOf(defender);
                if (party) party.deaths += 1;
                if (this.tileMap && defender.tile) {
                    this.tileMap.release(
                        defender.tile.x,
                        defender.tile.y,
                        defender.tile.z,
                        defender
                    );
                }
            }
        }
    }

    /**
     * Apply maxTicks / maxKills session limits. Mutates sessionState when hit.
     * @returns {boolean} true if session ended on a limit
     */
    checkSessionLimits() {
        if (this.sessionState !== 'running') return false;
        if (this.maxKills != null && this.telemetry.kills >= this.maxKills) {
            this.sessionState = 'kill_cap';
            this.telemetry.endReason = 'kill_cap';
            this.telemetry.endTick = this.tickCount;
            return true;
        }
        if (this.maxTicks != null && this.tickCount >= this.maxTicks) {
            this.sessionState = 'timeout';
            this.telemetry.endReason = 'timeout';
            this.telemetry.endTick = this.tickCount;
            return true;
        }
        // Liveness: no successful attack for N ticks (stuck AI / dead combat).
        // Uses ticks since last attack, or since session start when none yet.
        if (
            this.noAttackTimeoutTicks != null &&
            this.tickCount >= this.noAttackTimeoutTicks
        ) {
            const idleTicks = this.tickCount - (this._lastAttackTick || 0);
            if (idleTicks >= this.noAttackTimeoutTicks) {
                this.sessionState = 'no_attack_timeout';
                this.telemetry.endReason = 'no_attack_timeout';
                this.telemetry.endTick = this.tickCount;
                return true;
            }
        }
        return false;
    }

    /**
     * Whether all enabled parties finished their routes.
     * @returns {boolean}
     */
    allRoutesComplete() {
        if (!this.parties.length) return false;
        for (let i = 0; i < this.parties.length; i++) {
            const p = this.parties[i];
            if (!p.enabled) continue;
            if (!p.routeComplete && !p.allRoutesComplete()) return false;
        }
        return true;
    }

    /**
     * Whether every enabled party is wiped.
     * @returns {boolean}
     */
    isPartyWipe() {
        if (!this.parties.length) return false;
        let any = false;
        for (let i = 0; i < this.parties.length; i++) {
            const p = this.parties[i];
            if (!p.enabled) continue;
            any = true;
            if (!p.isWiped()) return false;
        }
        return any;
    }

    update() {
        this.tickCount += 1;
    }

    updateAll() {
        if (!this.active) return;
        // Soccer contract: LCG only during logic body; always restore native after.
        const prev = Math.random;
        this._parityAttacksThisTick = [];
        this._parityDrawsAtTickStart =
            this.seededRandom &&
            typeof this.seededRandom.getDrawCount === 'function'
                ? this.seededRandom.getDrawCount()
                : 0;
        try {
            if (this.seededRandom) {
                Math.random = this.seededRandom;
            }
            // Etapa 3: freeze CD/moveDelay on far idle hostiles before scene graph
            if (this.combatAi) {
                applyCreatureSleepState(this);
            }
            super.updateAll();

            // Short-lived elemental fields (≤24h) expire via heap; energy underfoot exit.
            if (this.groundItems) {
                const tileMap = this.tileMap;
                purgeExpiredFields(
                    this.groundItems,
                    Time.timeSinceLevelLoad,
                    (x, y, z) => {
                        /** @type {object[]} */
                        const out = [];
                        if (tileMap && typeof tileMap.getOccupant === 'function') {
                            const id = tileMap.getOccupant(x, y, z);
                            if (id) {
                                const ent =
                                    typeof tileMap.resolveOccupant === 'function'
                                        ? tileMap.resolveOccupant(id)
                                        : null;
                                if (ent) out.push(ent);
                            }
                        }
                        if (out.length) return out;
                        // Fallback if occupancy not wired (tests / early boot).
                        const pushIf = (e) => {
                            if (
                                e &&
                                e.alive !== false &&
                                e.tile &&
                                Math.round(e.tile.x) === Math.round(x) &&
                                Math.round(e.tile.y) === Math.round(y) &&
                                String(
                                    e.tile.z !== undefined && e.tile.z !== null
                                        ? e.tile.z
                                        : 0
                                ) === String(z)
                            ) {
                                out.push(e);
                            }
                        };
                        const parties = this.parties || [];
                        for (let p = 0; p < parties.length; p++) {
                            const members =
                                parties[p] && parties[p].members
                                    ? parties[p].members
                                    : [];
                            for (let m = 0; m < members.length; m++) {
                                pushIf(members[m]);
                            }
                        }
                        const creatures = this.creatures || [];
                        for (let c = 0; c < creatures.length; c++) {
                            pushIf(creatures[c]);
                        }
                        return out;
                    }
                );
            }

            if (this.sessionState === 'running') {
                if (this.combatAi) {
                    this._tickCombatSession();
                } else {
                    this._tickPartyMovement();
                    this._tickPropInteractions();
                    if (this.allRoutesComplete()) {
                        this.sessionState = 'route_complete';
                        this.telemetry.endReason = 'route_complete';
                        this.telemetry.endTick = this.tickCount;
                    } else {
                        this.checkSessionLimits();
                    }
                }
            }

            // Scrubber high-water (skipped while seek is replaying)
            this._recordPlaybackTick();
            this._maybeRecordParityTick();
        } finally {
            // Always restore native — never leave session LCG on Math.random
            Math.random = NATIVE_MATH_RANDOM;
            void prev;
        }
    }

    /**
     * Movement hooks for party / hunt AI (step log + biome transitions).
     * Always installed so macro telemetry fires even when recordSteps is off.
     * @returns {{ onStep: function }}
     * @private
     */
    _partyStepHooks() {
        return {
            onStep: (member, from, to) => {
                if (this.recordSteps) {
                    this.stepLog.push({
                        tick: this.tickCount,
                        entityId: member.id,
                        name: member.name,
                        x: to.x,
                        y: to.y,
                        z: to.z
                    });
                }
                this._recordFloorHop(member, from, to);
                this._maybeSampleBiomeTransition(member, from, to);
            }
        };
    }

    /**
     * Append one floor-hop row when a party member changes z (stair).
     * @param {object} member
     * @param {{ x?: number, y?: number, z?: string|number }|null} from
     * @param {{ x?: number, y?: number, z?: string|number }|null} to
     * @private
     */
    _recordFloorHop(member, from, to) {
        if (!from || !to || member == null) return;
        if (String(from.z) === String(to.z)) return;
        if (!Array.isArray(this.floorHopLog)) this.floorHopLog = [];
        this.floorHopLog.push({
            tick: this.tickCount,
            entityId: member.id,
            name: member.name != null ? String(member.name) : '?',
            fromZ: from.z,
            toZ: to.z,
            x: to.x,
            y: to.y
        });
        // Arm auto window on first stair hop (split-floor isolation).
        if (
            this._parityTraceEnabled &&
            this._parityTraceMode === 'auto' &&
            this._parityWindow == null
        ) {
            const hopTick = this.tickCount | 0;
            this._parityWindow = {
                from: hopTick + 1,
                to: hopTick + this._parityAfterHopTicks
            };
        }
    }

    /**
     * Parse parityTrace opts (opt-in only — product play path leaves this off).
     * - undefined / null / false / 0 → off
     * - true → auto window after first stair hop
     * - { fromTick, toTick } → fixed inclusive range
     * - { afterHopTicks: n } → auto with custom length
     * @param {boolean|object|null|undefined} raw
     * @private
     */
    _initParityTrace(raw) {
        const DEFAULT_AFTER_HOP = 25;
        this.parityTickLog = [];
        this._parityAttacksThisTick = [];
        this._parityDrawsAtTickStart = 0;
        this._parityWindow = null;
        this._parityFixedWindow = null;
        this._parityAfterHopTicks = DEFAULT_AFTER_HOP;

        if (raw == null || raw === false || raw === 0) {
            this._parityTraceEnabled = false;
            this._parityTraceMode = 'off';
            return;
        }

        this._parityTraceEnabled = true;
        if (raw && typeof raw === 'object') {
            const from =
                raw.fromTick != null
                    ? Math.floor(Number(raw.fromTick))
                    : raw.from != null
                      ? Math.floor(Number(raw.from))
                      : null;
            const to =
                raw.toTick != null
                    ? Math.floor(Number(raw.toTick))
                    : raw.to != null
                      ? Math.floor(Number(raw.to))
                      : null;
            if (
                from != null &&
                to != null &&
                Number.isFinite(from) &&
                Number.isFinite(to) &&
                to >= from
            ) {
                this._parityTraceMode = 'fixed';
                this._parityFixedWindow = { from, to };
                this._parityWindow = { from, to };
                return;
            }
            if (raw.afterHopTicks != null) {
                const n = Math.floor(Number(raw.afterHopTicks));
                if (Number.isFinite(n) && n > 0) {
                    this._parityAfterHopTicks = Math.min(n, 200);
                }
            }
        }
        this._parityTraceMode = 'auto';
    }

    /**
     * @returns {boolean}
     * @private
     */
    _parityActiveThisTick() {
        if (!this._parityTraceEnabled || !this._parityWindow) return false;
        const t = this.tickCount | 0;
        return t >= this._parityWindow.from && t <= this._parityWindow.to;
    }

    /**
     * Record one attack while the parity window is open (no presentation).
     * @param {object} attacker
     * @param {object} defender
     * @param {object} result
     * @param {number} dealt
     * @private
     */
    _recordParityAttack(attacker, defender, result, dealt) {
        if (!this._parityActiveThisTick()) return;
        if (!Array.isArray(this._parityAttacksThisTick)) {
            this._parityAttacksThisTick = [];
        }
        const spell = result && result.spell ? result.spell : null;
        const spellId =
            spell && spell.id != null
                ? String(spell.id)
                : result && result.spellId != null
                  ? String(result.spellId)
                  : null;
        this._parityAttacksThisTick.push({
            by:
                attacker && attacker.name != null
                    ? String(attacker.name)
                    : attacker && attacker.type != null
                      ? String(attacker.type)
                      : '?',
            byType: attacker && attacker.type != null ? String(attacker.type) : null,
            vs:
                defender && defender.name != null
                    ? String(defender.name)
                    : defender && defender.id != null
                      ? String(defender.id)
                      : '?',
            vsId: defender && defender.id != null ? defender.id : null,
            spell: spellId,
            d: Math.round(Number(dealt) || 0),
            miss: !!(result && (result.miss || result.hit === false)),
            crit: !!(result && (result.critical || result.crit)),
            kill: !!(defender && defender.alive === false)
        });
    }

    /**
     * End-of-tick snapshot for split-floor isolation.
     * @private
     */
    _maybeRecordParityTick() {
        if (!this._parityActiveThisTick()) return;
        if (!Array.isArray(this.parityTickLog)) this.parityTickLog = [];

        const rng = this.seededRandom;
        const drawsAfter =
            rng && typeof rng.getDrawCount === 'function'
                ? rng.getDrawCount()
                : 0;
        const draws = Math.max(
            0,
            drawsAfter - (this._parityDrawsAtTickStart || 0)
        );
        const rngState =
            rng && typeof rng.getState === 'function' ? rng.getState() : null;

        const party = [];
        let scoutZ = null;
        for (let i = 0; i < this.parties.length; i++) {
            const p = this.parties[i];
            if (!p || !p.members) continue;
            for (let j = 0; j < p.members.length; j++) {
                const m = p.members[j];
                if (!m) continue;
                const name = m.name != null ? String(m.name) : '?';
                const tile = m.tile || null;
                const x = tile ? tile.x : m.x;
                const y = tile ? tile.y : m.y;
                const z = tile ? tile.z : m.z;
                if (/scout/i.test(name) && scoutZ == null) scoutZ = z;
                const tgt = m.target || null;
                party.push({
                    n: name,
                    x,
                    y,
                    z,
                    hp: m.hp ? m.hp.current : 0,
                    ai: m.aiState || '',
                    dmg: m.damageDealt || 0,
                    k: m.kills || 0,
                    tgt:
                        tgt && tgt.id != null
                            ? tgt.id
                            : m.targetId != null
                              ? m.targetId
                              : null,
                    tgtN:
                        tgt && tgt.name != null
                            ? String(tgt.name)
                            : null
                });
            }
        }
        if (scoutZ == null && party.length) {
            // Prefer non-leader floor when split (first hopper is usually follower).
            const zs = party.map((r) => r.z);
            const uniq = [];
            for (let i = 0; i < zs.length; i++) {
                const key = String(zs[i]);
                if (uniq.indexOf(key) < 0) uniq.push(key);
            }
            if (uniq.length > 1) {
                const leader = party.find((r) => /guardian/i.test(r.n));
                const other = party.find(
                    (r) => !leader || String(r.z) !== String(leader.z)
                );
                scoutZ = other ? other.z : party[party.length - 1].z;
            } else {
                scoutZ = party[0].z;
            }
        }

        const hostiles = [];
        const creatures = this.creatures || [];
        for (let i = 0; i < creatures.length; i++) {
            const c = creatures[i];
            if (!c || !c.alive) continue;
            const cz = c.tile ? c.tile.z : c.z;
            if (scoutZ != null && String(cz) !== String(scoutZ)) continue;
            hostiles.push({
                id: c.id != null ? c.id : null,
                n: c.name != null ? String(c.name) : c.creatureId || '?',
                x: c.tile ? c.tile.x : c.x,
                y: c.tile ? c.tile.y : c.y,
                z: cz,
                hp: c.hp ? Math.round(c.hp.current) : 0
            });
            if (hostiles.length >= 16) break;
        }

        const tel = this.telemetry || {};
        this.parityTickLog.push({
            t: this.tickCount | 0,
            rng: rngState,
            draws,
            kills: tel.kills || 0,
            exp: tel.expGained || 0,
            dmgOut: tel.damageDealt || 0,
            party,
            hostiles,
            atk: (this._parityAttacksThisTick || []).slice()
        });
    }

    /**
     * Stage 11.10: when a party member stair-hops into a different biome /
     * art segment, emit one `biome_transition` pacing event (deduped by
     * fromZ→toZ for multi-member parties).
     *
     * @param {object} member
     * @param {{ x: number, y: number, z: string|number }} from
     * @param {{ x: number, y: number, z: string|number }} to
     * @private
     */
    _maybeSampleBiomeTransition(member, from, to) {
        if (!from || !to) return;
        if (String(from.z) === String(to.z)) return;
        // Need floor meta (multi-biome / multifloor hunts); skip hand maps
        if (
            !this._floorMetaByZ ||
            !Object.keys(this._floorMetaByZ).length
        ) {
            return;
        }

        const fromMeta = this._floorMetaByZ[String(from.z)] || null;
        const toMeta = this._floorMetaByZ[String(to.z)] || null;
        const fromBiome =
            fromMeta && fromMeta.biomeId != null
                ? String(fromMeta.biomeId)
                : null;
        const toBiome =
            toMeta && toMeta.biomeId != null ? String(toMeta.biomeId) : null;
        const fromArt =
            fromMeta && fromMeta.artSet != null
                ? String(fromMeta.artSet)
                : null;
        const toArt =
            toMeta && toMeta.artSet != null ? String(toMeta.artSet) : null;

        // Only sample when biome or art set actually changes (not same-biome multi-floor)
        const biomeChanged =
            fromBiome != null && toBiome != null && fromBiome !== toBiome;
        const artChanged =
            fromArt != null && toArt != null && fromArt !== toArt;
        if (!biomeChanged && !artChanged) return;

        const key = `${String(from.z)}->${String(to.z)}`;
        if (this._biomeTransitionSeen.has(key)) return;
        this._biomeTransitionSeen.add(key);

        sampleBiomeTransition(this.telemetry, {
            t: Time.timeSinceLevelLoad,
            fromBiomeId: fromBiome,
            toBiomeId: toBiome,
            fromArtSet: fromArt,
            toArtSet: toArt,
            fromZ: from.z,
            toZ: to.z,
            fromSegment:
                fromMeta && fromMeta.segmentIndex != null
                    ? fromMeta.segmentIndex
                    : null,
            toSegment:
                toMeta && toMeta.segmentIndex != null
                    ? toMeta.segmentIndex
                    : null,
            entityId: member && member.id != null ? member.id : null
        });
    }

    /**
     * Combat AI frame: hunt AI + respawns + end conditions.
     * @private
     */
    _tickCombatSession() {
        const hooks = this._partyStepHooks();

        this._injectReplayedCommands();
        tickHuntAi(this, hooks);
        for (let i = 0; i < this.parties.length; i++) {
            const p = this.parties[i];
            if (p && typeof p.syncFollowerRouteComplete === 'function') {
                p.syncFollowerRouteComplete();
            }
        }
        this._tickSpawnManager();
        // After spawn reconcile: free dead → wave clear / intermission / next pack
        this._tickWaveController();
        this._tickPropInteractions();

        if (this.sessionState !== 'running') {
            // waves_complete (or other) already set this frame
        } else if (this.isPartyWipe()) {
            this.sessionState = 'party_wipe';
            this.telemetry.endReason = 'party_wipe';
            this.telemetry.endTick = this.tickCount;
        } else if (this.allRoutesComplete() && !this._holdRouteForWaves()) {
            this.sessionState = 'route_complete';
            this.telemetry.endReason = 'route_complete';
            this.telemetry.endTick = this.tickCount;
        } else {
            this.checkSessionLimits();
        }

        if (!Settings.HEADLESS) {
            this._updateCamera();
        }
    }

    /**
     * Record a manual command executed by a party member, branching the timeline
     * if executed at an earlier tick after scrubbing (TAS Piano Roll style).
     * @param {object} member
     * @param {object} cmd
     */
    recordManualCommand(member, cmd) {
        if (this._seekInProgress || this.forceAiControl || cmd._replayed) return;
        if (!Array.isArray(this.commandHistory)) {
            this.commandHistory = [];
            if (this.telemetry) this.telemetry.commandHistory = this.commandHistory;
        }
        const tick = this.tickCount;
        if (this.commandHistory.length > 0) {
            const lastTick = this.commandHistory[this.commandHistory.length - 1].tick;
            if (tick < lastTick && tick !== this._lastTruncatedAtTick) {
                let cutoff = 0;
                while (cutoff < this.commandHistory.length && this.commandHistory[cutoff].tick < tick) {
                    cutoff++;
                }
                this.commandHistory.length = cutoff;
                this._lastTruncatedAtTick = tick;
                this.playbackMaxElapsedTicks = tick;
            }
        }
        const partyIdx = this.parties.indexOf(member.party || this.parties[0]);
        const memberIdx = member.party && Array.isArray(member.party.members)
            ? member.party.members.indexOf(member)
            : 0;
        const entry = Object.assign({}, cmd, {
            tick,
            partyIdx: Math.max(0, partyIdx),
            memberIdx: Math.max(0, memberIdx)
        });
        delete entry._replayed;
        this.commandHistory.push(entry);
    }

    /**
     * Inject replayed manual commands for the current tick during deterministic playback.
     * @private
     */
    _injectReplayedCommands() {
        if (this.forceAiControl || !Array.isArray(this.commandHistory) || !this.commandHistory.length) return;
        const tick = this.tickCount;
        for (let i = 0; i < this.commandHistory.length; i++) {
            const c = this.commandHistory[i];
            if (c.tick < tick) continue;
            if (c.tick > tick) break;
            const party = this.parties[c.partyIdx || 0] || this.parties[0];
            if (!party) continue;
            const member = (party.members && party.members[c.memberIdx || 0]) || party.members[0];
            if (!member || !member.alive) continue;
            if (!Array.isArray(member.commandQueue)) member.commandQueue = [];
            const cmd = Object.assign({}, c, { _replayed: true });
            delete cmd.tick;
            delete cmd.partyIdx;
            delete cmd.memberIdx;
            member.commandQueue.push(cmd);
        }
    }

    /**
     * Collect living party members as spawn activation observers.
     * @returns {{ x: number, y: number, z: * }[]}
     * @private
     */
    _spawnObservers() {
        const out = [];
        for (let i = 0; i < this.parties.length; i++) {
            const party = this.parties[i];
            if (!party || !party.members) continue;
            for (let j = 0; j < party.members.length; j++) {
                const m = party.members[j];
                if (!m || !m.alive || !m.tile) continue;
                out.push({ x: m.tile.x, y: m.tile.y, z: m.tile.z });
            }
        }
        return out;
    }

    /**
     * Activate / free / respawn via SpawnManager.
     * Updates sim.spawnPerf / spawnPerfTotals for scale diagnostics (Etapa 2).
     * @returns {{ spawned: object[], despawned: object[], freed: object[], idleDespawned?: object[], budgetEvicted?: object[], living?: number }}
     * @private
     */
    _tickSpawnManager() {
        if (!this.spawnManager || !this.spawnManager.size) {
            const empty = {
                spawned: [],
                despawned: [],
                freed: [],
                idleDespawned: [],
                budgetEvicted: [],
                skippedBudget: 0,
                living: 0
            };
            this._recordSpawnPerf(empty);
            return empty;
        }
        const result = this.spawnManager.tick({
            time: Time.timeSinceLevelLoad,
            observers: this._spawnObservers(),
            getEntity: (id) => this.getEntityById(id),
            spawn: (state) => this._spawnFromManagerState(state),
            despawn: (entity) => this.despawnCreature(entity)
        });
        this._recordSpawnPerf(result);
        return result;
    }

    /**
     * @param {object} result SpawnManager.tick output
     * @private
     */
    _recordSpawnPerf(result) {
        const r = result || {};
        const frame = {
            slots: this.spawnManager ? this.spawnManager.size : 0,
            living: r.living != null
                ? r.living
                : this.spawnManager
                  ? this.spawnManager.livingCount
                  : 0,
            creaturesList: this.creatures ? this.creatures.length : 0,
            spawned: r.spawned ? r.spawned.length : 0,
            despawned: r.despawned ? r.despawned.length : 0,
            freed: r.freed ? r.freed.length : 0,
            idleDespawned: r.idleDespawned ? r.idleDespawned.length : 0,
            budgetEvicted: r.budgetEvicted ? r.budgetEvicted.length : 0,
            skippedBudget: r.skippedBudget || 0,
            mode: this.spawnMode
        };
        this.spawnPerf = frame;
        if (!this.spawnPerfTotals) {
            this.spawnPerfTotals = {
                frames: 0,
                spawned: 0,
                despawned: 0,
                freed: 0,
                idleDespawned: 0,
                budgetEvicted: 0,
                skippedBudget: 0,
                livingPeak: 0
            };
        }
        const t = this.spawnPerfTotals;
        t.frames += 1;
        t.spawned += frame.spawned;
        t.despawned += frame.despawned;
        t.freed += frame.freed;
        t.idleDespawned += frame.idleDespawned;
        t.budgetEvicted += frame.budgetEvicted;
        t.skippedBudget += frame.skippedBudget;
        if (frame.living > t.livingPeak) t.livingPeak = frame.living;
    }

    /**
     * Materialize a manager slot into a live creature.
     * @param {object} state
     * @returns {Creature|null}
     * @private
     */
    _spawnFromManagerState(state) {
        if (!state) return null;
        const base = state.entry && typeof state.entry === 'object' ? state.entry : {};
        const entry = Object.assign({}, base, {
            creatureId: state.creatureId,
            x: state.x,
            y: state.y,
            z: state.z,
            respawn: state.respawn,
            template: state.template || base.template || null,
            _spawnSlotKey: state.key
        });
        return this.spawnFromTable(entry);
    }

    /**
     * After delays tick, step parties along waypoints (ghost-walk mode).
     * @private
     */
    _tickPartyMovement() {
        if (!this.tileMap || !this.parties.length) return;
        const hooks = this._partyStepHooks();

        for (let i = 0; i < this.parties.length; i++) {
            this.parties[i].tickMovement(this.tileMap, hooks);
        }

        if (!Settings.HEADLESS) {
            this._updateCamera();
        }
    }

    /**
     * Point Settings.cameraTile* at the active view member (top-left of canvas viewport).
     * Defaults to the party leader; "Set Active" can follow any member (incl. floor hops).
     * Sets cameraTileZ so multi-floor TileMap.render / entity overlays match that floor.
     * @private
     */
    _updateCamera() {
        const focus = this.getCameraFocusMember();
        if (!focus || !focus.tile) return;
        const app = Settings.app;
        const tw = Settings.tileWidth || 32;
        const th = Settings.tileHeight || 32;
        let viewW = 64;
        let viewH = 40;
        if (app && app.width > 0 && tw > 0) {
            viewW = Math.max(1, Math.ceil(app.width / tw));
        }
        if (app && app.height > 0 && th > 0) {
            viewH = Math.max(1, Math.ceil(app.height / th));
        }
        // Prefer presentation pos so the camera eases with the step slide
        const camX =
            Number.isFinite(focus.x) ? focus.x : focus.tile.x;
        const camY =
            Number.isFinite(focus.y) ? focus.y : focus.tile.y;
        Settings.cameraTileX = camX - Math.floor(viewW / 2);
        Settings.cameraTileY = camY - Math.floor(viewH / 2);
        Settings.cameraTileZ =
            focus.tile.z !== undefined && focus.tile.z !== null
                ? focus.tile.z
                : this.floor != null
                  ? this.floor
                  : null;
    }

    /**
     * Snapshot of member tiles (for tests / headless summary).
     * @returns {{ partyId: string|number, members: object[] }[]}
     */
    getPartyPositions() {
        return this.parties.map((p) => ({
            partyId: p.id,
            routeComplete: p.routeComplete || p.allRoutesComplete(),
            wiped: p.isWiped(),
            expGained: p.expGained,
            rawExpGained: p.rawExpGained || 0,
            levelUps: p.levelUps || 0,
            kills: p.kills,
            deaths: p.deaths,
            damageDealt: p.damageDealt,
            damageTaken: p.damageTaken,
            members: p.members.map((m) => ({
                id: m.id,
                name: m.name,
                classId: m.classId,
                isLeader: m.isLeader,
                x: m.tile ? m.tile.x : m.x,
                y: m.tile ? m.tile.y : m.y,
                z: m.tile ? m.tile.z : m.z,
                hp: m.hp ? m.hp.current : 0,
                hpMax: m.hp ? m.hp.max : 0,
                level: m.level != null ? m.level : null,
                experience: m.experience != null ? m.experience : null,
                alive: m.alive,
                aiState: m.aiState || '',
                currentWaypoint: m.currentWaypoint,
                routeComplete: m.routeComplete,
                moveDelay: m.moveDelay,
                expGained: m.expGained || 0,
                rawExpGained: m.rawExpGained || 0,
                levelUps: m.levelUps || 0,
                damageDealt: m.damageDealt || 0,
                damageTaken: m.damageTaken || 0,
                kills: m.kills || 0,
                autoAttacks: m.autoAttacks || 0,
                spellsCast: m.spellsCast || 0,
                spellsCastById: m.spellsCastById
                    ? Object.assign(Object.create(null), m.spellsCastById)
                    : Object.create(null),
                spellsCastByKind: m.spellsCastByKind
                    ? Object.assign(Object.create(null), m.spellsCastByKind)
                    : Object.create(null),
                manaSpent: m.manaSpent || 0
            }))
        }));
    }

    /**
     * Build hunt summary JSON (Stage 5–6 exit criteria).
     * Uses kernel/core/lib/telemetry.buildHuntSummary.
     * @param {object} [extra] frames, maxFrames, huntId, config overrides
     * @returns {object}
     */
    buildHuntSummary(extra) {
        const e = extra || {};
        if (
            this.telemetry.endTick == null &&
            this.sessionState !== 'running' &&
            this.sessionState !== 'idle'
        ) {
            this.telemetry.endTick = this.tickCount;
        }
        const summary = buildSummaryFromTelemetry({
            telemetry: this.telemetry,
            seed: this.seed,
            floor: this.floor,
            tickCount: this.tickCount,
            sessionState: this.sessionState,
            routeComplete: this.allRoutesComplete(),
            partyWipe: this.isPartyWipe(),
            parties: this.getPartyPositions(),
            waves: this.waveController
                ? this.waveController.snapshot()
                : null,
            frames: e.frames,
            maxFrames: e.maxFrames != null ? e.maxFrames : this.maxTicks,
            huntId: e.huntId != null ? e.huntId : this.huntId,
            timeSinceLevelLoad:
                e.timeSinceLevelLoad != null
                    ? e.timeSinceLevelLoad
                    : Time.timeSinceLevelLoad,
            logicDt: e.logicDt,
            creaturesAlive: this.creatures.filter((c) => c.alive).length,
            propsAlive: this.props.filter((p) => p.alive && !p.used).length,
            limits: {
                maxTicks: this.maxTicks,
                maxKills: this.maxKills
            },
            config: e.config || null,
            pacingBudget:
                e.pacingBudget !== undefined
                    ? e.pacingBudget
                    : this.pacingBudget,
            layoutMeta:
                e.layoutMeta !== undefined ? e.layoutMeta : this.layoutMeta,
            commandHistory: this.commandHistory || []
        });
        if (
            Array.isArray(this.parityTickLog) &&
            this.parityTickLog.length
        ) {
            summary.parityTickLog = this.parityTickLog.slice();
            if (this._parityWindow) {
                summary.parityWindow = {
                    from: this._parityWindow.from,
                    to: this._parityWindow.to,
                    mode: this._parityTraceMode
                };
            }
        }
        return summary;
    }

    render(g) {
        if (Settings.HEADLESS || !g) return;
        g.fillStyle = Settings.screenColor || '#12121c';
        g.fillRect(0, 0, 2048, 1280);
    }

    /**
     * Emit floating combat text (watch mode only).
     * @param {object} opts
     */
    emitCombatText(opts) {
        // Skip FCT queue growth during seek (perf); clear after seek as well
        if (
            Settings.HEADLESS ||
            this._seekInProgress ||
            !this.floatingCombatText
        ) {
            return;
        }
        this.floatingCombatText.push(opts);
    }

    /**
     * Emit one combat VFX entry (watch mode only).
     * @param {object} opts type aoe|death|projectile|melee + tile coords
     */
    emitCombatEffect(opts) {
        if (
            Settings.HEADLESS ||
            this._seekInProgress ||
            !this.combatEffects
        ) {
            return;
        }
        this.combatEffects.push(opts);
    }

    /**
     * Queue AOE / death / projectile / melee VFX from one resolveAttack result.
     * @param {object|null} attacker
     * @param {object|null} defender
     * @param {object|null} result
     */
    emitCombatEffectsFromAttack(attacker, defender, result) {
        if (
            Settings.HEADLESS ||
            this._seekInProgress ||
            !this.combatEffects
        ) {
            return;
        }
        this.combatEffects.pushFromAttack(attacker, defender, result);
    }

    onGUI(g) {
        if (Settings.HEADLESS || !g) return;
        // Entity markers + FCT are Script.onGUI (cascaded by onGUIAll).
        // Light HUD overlay only here (DOM live panel owns detailed stats).
        g.fillStyle = '#8b9bb4';
        g.font = '12px monospace';
        const label = this.combatAi
            ? 'Hunt Design Lab — hunt watch'
            : this.tileMap
              ? 'Hunt Design Lab — ghost walk'
              : 'Hunt Design Lab — empty level';
        g.fillText(label, 8, 14);
        g.fillText(
            `seed ${this.seed}  tick ${this.tickCount}  ${this.sessionState}`,
            8,
            28
        );
        if (this.combatAi) {
            g.fillText(
                `kills ${this.telemetry.kills}  dmg ${this.telemetry.damageDealt}/${this.telemetry.damageTaken}  exp ${this.telemetry.expGained}`,
                8,
                42
            );
        } else if (
            this.parties[0] &&
            this.parties[0].members[0] &&
            this.parties[0].members[0].tile
        ) {
            const t = this.parties[0].members[0].tile;
            g.fillText(`leader ${t.x},${t.y},z=${t.z}`, 8, 42);
        }
    }

    /**
     * Draw HUD, then scripts (markers / FCT), then AI debug so labels stay readable.
     * @param {CanvasRenderingContext2D} g
     */
    onGUIAll(g) {
        if (!this.active) return;
        this.onGUI(g);
        for (let i = 0; i < this.scripts.length; i++) {
            this.scripts[i].onGUI(g);
        }
        for (let i = 0; i < this.children.length; i++) {
            this.children[i].onGUIAll(g);
        }
        // After markers/FCT (Stage 12B)
        if (!Settings.HEADLESS && g) {
            drawAiDebugOverlays(g, this);
        }
    }

    destroy() {
        this.sessionState = 'stopped';
        this.unbindSeededRandom();
        unbindSeededRandom();
        super.destroy();
    }
}

/**
 * Find a free walkable spawn near (x,y,z). Index 0 prefers exact tile;
 * later indices take successive free tiles in a deterministic spiral
 * (skipping the exact start so members do not stack on the leader).
 *
 * @param {TileMap} tileMap
 * @param {number} x
 * @param {number} y
 * @param {string|number} z
 * @param {number} memberIndex
 * @param {object|null|undefined} [entityOrOpts]
 * @returns {{ x: number, y: number }|null}
 */
function findSpawnTile(tileMap, x, y, z, memberIndex, entityOrOpts) {
    const ox = Math.round(x);
    const oy = Math.round(y);
    if (
        memberIndex === 0 &&
        tileMap.canEnter(ox, oy, z, null) &&
        !isTileFieldHazardForEntity(tileMap, ox, oy, z, entityOrOpts)
    ) {
        return { x: ox, y: oy };
    }

    const maxR = 6;
    const free = [];
    for (let r = 0; r <= maxR; r++) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (r !== 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const cx = ox + dx;
                const cy = oy + dy;
                if (!tileMap.canEnter(cx, cy, z, null)) continue;
                if (memberIndex > 0 && cx === ox && cy === oy) continue;
                if (isTileFieldHazardForEntity(tileMap, cx, cy, z, entityOrOpts)) {
                    continue;
                }
                free.push({ x: cx, y: cy });
            }
        }
    }

    if (memberIndex === 0) {
        return free[0] || null;
    }
    return free[memberIndex - 1] || free[free.length - 1] || null;
}

/**
 * Index floorMeta rows by z string; attach segmentIndex from macro.segments
 * when available (Stage 11.10 runtime biome_transition).
 *
 * @param {object[]|null|undefined} floorMeta
 * @param {object|null|undefined} macro layoutMeta.macro
 * @returns {Record<string, {
 *   z: string|number,
 *   biomeId: string|null,
 *   artSet: string|null,
 *   segmentIndex: number|null,
 *   macroTransition: boolean
 * }>}
 */
function buildFloorMetaIndex(floorMeta, macro) {
    /** @type {Record<string, any>} */
    const out = Object.create(null);
    if (!Array.isArray(floorMeta) || !floorMeta.length) return out;

    /** @type {Record<string, number>} z → segment index */
    const zToSeg = Object.create(null);
    if (macro && Array.isArray(macro.segments)) {
        for (let i = 0; i < macro.segments.length; i++) {
            const seg = macro.segments[i];
            if (!seg) continue;
            const zs = Array.isArray(seg.floorZs) ? seg.floorZs : [];
            for (let j = 0; j < zs.length; j++) {
                zToSeg[String(zs[j])] =
                    seg.index != null ? Number(seg.index) : i;
            }
            if (seg.startZ != null && seg.endZ != null) {
                const a = Number(seg.startZ);
                const b = Number(seg.endZ);
                if (Number.isFinite(a) && Number.isFinite(b)) {
                    const lo = Math.min(a, b);
                    const hi = Math.max(a, b);
                    for (let z = lo; z <= hi; z++) {
                        if (zToSeg[String(z)] == null) {
                            zToSeg[String(z)] =
                                seg.index != null ? Number(seg.index) : i;
                        }
                    }
                }
            }
        }
    }

    for (let i = 0; i < floorMeta.length; i++) {
        const fm = floorMeta[i];
        if (!fm || fm.z == null) continue;
        const zk = String(fm.z);
        out[zk] = {
            z: fm.z,
            biomeId: fm.biomeId != null ? String(fm.biomeId) : null,
            artSet: fm.artSet != null ? String(fm.artSet) : null,
            segmentIndex:
                zToSeg[zk] != null
                    ? zToSeg[zk]
                    : fm.segmentIndex != null
                      ? Number(fm.segmentIndex)
                      : null,
            macroTransition: !!fm.macroTransition
        };
    }
    return out;
}

module.exports = {
    Simulator,
    findSpawnTile,
    buildFloorMetaIndex,
    createEmptyTelemetry,
    createEmptyHuntTelemetry
};
