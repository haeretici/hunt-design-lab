/**
 * Project-wide paths, genre registry, asset-kind registry, and game runtime knobs.
 * Shared by Node CLIs, browser apps, and the hunt simulator under kernel/.
 */

const path = require('path');

// Node: absolute project root. Browser bundle: empty (paths stay project-relative).
const ROOT =
    typeof __dirname !== 'undefined' ? path.resolve(__dirname, '..') : '';

/**
 * Mutable runtime settings for the game shell (loops, headless, display).
 * Asset pipeline constants stay as module-level exports below.
 * @type {{
 *   FRAME_RATE: number,
 *   LOGIC_UPS: number,
 *   TIME_SPEED: number,
 *   DEFAULT_PLAY_SPEED: number,
 *   HEADLESS: boolean,
 *   showFPS: boolean,
 *   showTime: boolean,
 *   screenColor: string,
 *   tileWidth: number,
 *   tileHeight: number,
 *   FRICTION_BLOCKED: number,
 *   PATH_MAX_DISTANCE: number,
 *   PATH_MAX_ITERATIONS: number,
 *   PATH_REQUEST_MAX_DISTANCE: number,
 *   NAVMESH_CLOSEST_N: number,
 *   DEFAULT_ENTITY_SPEED: number,
 *   MOVE_DIAGONAL_FACTOR: number,
 *   MOVE_MIN_DELAY: number,
 *   SPELL_MOVE_LOCK_DEFAULT: number,
 *   BASE_REGEN_HP_INTERVAL_MS: number,
 *   BASE_REGEN_MP_INTERVAL_MS: number,
 *   ENGAGE_REGEN_HP_INTERVAL_MS: number,
 *   ENGAGE_REGEN_MP_INTERVAL_MS: number,
 *   COMBAT_MELEE_AUTO_FACTOR: number,
 *   COMBAT_MELEE_STRIKE_MIN_MUL: number,
 *   COMBAT_MELEE_STRIKE_MAX_MUL: number,
 *   COMBAT_MAGIC_MIN: number,
 *   COMBAT_MAGIC_MAX: number,
 *   AI_ENGAGE_RANGE: number,
 *   AI_ENGAGE_RANGE_X: number,
 *   AI_ENGAGE_RANGE_Y: number,
 *   AI_FLEE_HP_PERCENT: number,
 *   AI_CREATURE_AGGRO_RANGE: number,
 *   AI_CREATURE_LEASH: number,
 *   AI_CREATURE_LEASH_REAGGRO_MARGIN: number,
 *   AI_DESPAWN_LEASH_TICKS: number,
 *   AI_TICK_RADIUS: number,
 *   AI_SPATIAL_CHUNK_SIZE: number,
 *   AI_CREATURE_SLEEP: boolean,
 *   SPAWN_MODE: string,
 *   SPAWN_ACTIVATE_RADIUS: number,
 *   SPAWN_DESPAWN_HOME_DIST: number,
 *   SPAWN_DESPAWN_IDLE_RADIUS: number|null,
 *   SPAWN_DESPAWN_IDLE_SEC: number,
 *   SPAWN_MAX_LIVING: number,
 *   SPAWN_TIME_MULTIPLIER: number,
 *   SPAWN_CHUNK_SIZE: number,
 *   AI_CREATURE_LOSE_TARGET_DIST: number,
 *   AI_CREATURE_FLEE_STAND_DIST: number,
 *   AI_CREATURE_STATIC_ATTACK_CHANCE: number,
 *   AI_CREATURE_CIRCLE_CHANCE: number,
 *   AI_CREATURE_CIRCLE_INTERVAL: number,
 *   AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC: number,
 *   AI_CREATURE_RETARGET_INTERVAL: number,
 *   AI_GATE_BRAIN_ON_MOVE_DELAY: boolean,
 *   AI_GATE_CREATURE_ON_MOVE_DELAY: boolean,
 *   AI_THINK_PAD_SEC: number,
 *   AI_ENGAGE_DECISION_INTERVAL: number,
 *   AI_TARGET_RETARGET_DIST: number,
 *   AI_TARGET_LOSE_DIST: number,
 *   AI_RETARGET_INTERVAL: number,
 *   AI_REPATH_INTERVAL_TICKS: number,
 *   AI_PATH_BUDGET_PER_FRAME: number,
 *   AI_PROVOKED_WINDOW_SEC: number,
 *   AI_FIELD_STEP_PENALTY: number,
 *   AI_HAZARD_CACHE_SEC: number,
 *   AI_SUMMON_FIELD_OVERRIDE_DIST: number,
 *   debugAI: {
 *     enabled: boolean,
 *     states: boolean,
 *     paths: boolean,
 *     targets: boolean,
 *     ranges: boolean,
 *     spawns: boolean,
 *     hitSources: boolean
 *   },
 *   useEntitySprites: boolean,
 *   entitySpriteVariant: string|null,
 *   tileSpriteVariant: string|null,
 *   entitySpriteScale: number,
 *   entitySpriteScaleMax: number,
 *   entitySpriteScaleByAffix: Record<string, number>,
 *   spriteJumpHeight: number,
 *   provider: string,
 *   app: object|null
 * }}
 */
const Settings = {
    /** Canvas / requestAnimationFrame target */
    FRAME_RATE: 60,
    /** Fixed logic updates per second (must match Time.LOGIC_UPS) */
    LOGIC_UPS: 20,
    /**
     * Wall-clock multiplier for ApplicationLoop scheduling only.
     * Does not change logic dt (always 1/LOGIC_UPS).
     */
    TIME_SPEED: 1.0,
    DEFAULT_PLAY_SPEED: 1.0,
    /** When true, skip DOM-heavy render paths and prefer pure sim */
    HEADLESS: false,
    showFPS: true,
    showTime: true,
    screenColor: '#12121c',
    /** Pixel size when drawing tiles (Stage 1+ map view) */
    tileWidth: 32,
    tileHeight: 32,
    /**
     * Browser watch: static floor offscreen cache (TileMap.render).
     * Maps with cols*rows ≤ TILEMAP_CACHE_FULL_MAX_TILES bake the whole floor.
     * Larger maps use an overscan rect (viewport + margins) and rebuild when
     * the camera approaches the cache edge (see docs/08_tilemap_and_pathfinding.md).
     */
    TILEMAP_CACHE_FULL_MAX_TILES: 6400,
    /** Minimum overscan margin in tiles (also max(view/2) per axis). */
    TILEMAP_CACHE_MARGIN_MIN: 8,
    /**
     * Optional early rebuild strip inside the overscan edge (tiles).
     * 0 = rebuild only when the viewport leaves the cache (default hysteresis).
     * Keep this much smaller than the build margin or pans thrash rebuilds.
     */
    TILEMAP_CACHE_TRIP_MARGIN: 0,
    /**
     * Optional camera origin in tile coords (top-left of viewport).
     * May be fractional so the watch camera eases with step slides (moveLock).
     * When null, TileMap draws the NW corner preview.
     * cameraTileZ selects which multi-floor layer to draw (null → first loaded).
     */
    cameraTileX: null,
    cameraTileY: null,
    cameraTileZ: null,
    /**
     * Path-PNG / grid friction sentinel: non-walkable tiles store this value.
     * Walkable gray channel is 0–254 (higher → slower step delay via
     * movement.js tables). A* uses this only as blocked vs walkable —
     * walkable grays never change path cost. Default walk gray is 100
     * (dungeon pieces / DEFAULT_TILE_FRICTION).
     */
    FRICTION_BLOCKED: 255,
    /**
     * Max players that may share one tile (join-order stack). 0 = unlimited.
     * Creature in a mixed stair stack does not consume a player slot.
     * See docs/28_player_tile_stack_plan.md.
     */
    PLAYER_TILE_MAX_STACK: 10,
    /**
     * When a canPushCreatures mover cannot shove a pushable monster to a free
     * orthogonal neighbor, crush (zero HP) that target so the mover can enter.
     * Legacy-shaped; optional off later for balance authors.
     */
    CREATURE_PUSH_CRUSH: true,
    /**
     * Local A* caps (Stage 2 Pathfinder). Nodes outside |Δx|/|Δy| from start
     * are skipped; expanded-node budget hard-fails the search.
     * Legacy defaults: 100 / 512.
     */
    PATH_MAX_DISTANCE: 100,
    PATH_MAX_ITERATIONS: 512,
    /**
     * Stage 10: max Chebyshev distance for a single player/UI path request
     * when enforceRequestCap is set (no cross-map clicks). Longer routes need
     * authored waypoints or a navmesh with useNavmeshBeyondCap.
     */
    PATH_REQUEST_MAX_DISTANCE: 100,
    /** How many closest graph nodes to try at each end of a coarse route. */
    NAVMESH_CLOSEST_N: 3,
    /**
     * Default player speed before applyClassLoadout (class baseSpeed ≈ 110).
     * Creatures use DEFAULT_CREATURE_COMBAT.speed (100) via resolveCreatureSpeed —
     * not this knob. Step delay tables: kernel/core/lib/movement.js.
     */
    DEFAULT_ENTITY_SPEED: 110,
    /** Multiplier on table delay for diagonal steps (legacy ×2). */
    MOVE_DIAGONAL_FACTOR: 2,
    /** Floor after table + diagonal (one logic tick at 20 UPS). */
    MOVE_MIN_DELAY: 0.05,
    /**
     * Default post-cast self root (seconds) when a spell omits `moveLock`.
     * One logic tick at 20 UPS — brief plant without feeling stuck.
     * Per-spell override: presets/spells.json `moveLock` (0 disables).
     */
    SPELL_MOVE_LOCK_DEFAULT: 0.05,
    /**
     * HP/MP regeneration tick interval in milliseconds.
     * Base intervals apply when out of combat (no monsters in engage area).
     * Engage intervals apply during combat.
     */
    BASE_REGEN_HP_INTERVAL_MS: 3000,
    BASE_REGEN_MP_INTERVAL_MS: 5000,
    ENGAGE_REGEN_HP_INTERVAL_MS: 4000,
    ENGAGE_REGEN_MP_INTERVAL_MS: 6000,
    /**
     * Stage 4 combat formula knobs (pure modules in kernel/core/lib/combat/).
     * levelBonus = legacy stepped bands (+1/5 lv to 500, then /6, /7, …)
     * weapon auto (melee/fist + distance) max = ceil(FACTOR × atk × skill + levelBonus)
     *   — distance atk is ammo+weapon mod
     * Strikes (melee_strike / magic_strike): option-B mean from basePower
     * coefficients ± spell.damageAmplitude (omit amplitude → 0 = fixed mean).
     * Legacy strike mul knobs below are unused by the mean±amplitude path;
     * kept only for older callers/docs until fully removed.
     */
    COMBAT_MELEE_AUTO_FACTOR: 0.102,
    COMBAT_MELEE_STRIKE_MIN_MUL: 0.5,
    COMBAT_MELEE_STRIKE_MAX_MUL: 1.0,
    COMBAT_MAGIC_MIN: 0.02,
    COMBAT_MAGIC_MAX: 0.035,
    /**
     * Stage 5 hunt AI knobs.
     * Player engage area is an axis box: ‖Δx‖ ≤ AI_ENGAGE_RANGE_X and
     * ‖Δy‖ ≤ AI_ENGAGE_RANGE_Y (defaults 7×7 = historical Chebyshev 7 square).
     * AI_ENGAGE_RANGE is the scalar fallback / square shorthand when X/Y unset.
     * Flee when HP fraction ≤ AI_FLEE_HP_PERCENT.
     * Creatures aggro within AI_CREATURE_AGGRO_RANGE; leash home beyond AI_CREATURE_LEASH.
     * While leashing, re-aggro only when home dist ≤ LEASH − REAGGRO_MARGIN (hysteresis
     * so boundary kiting cannot thrash attack ↔ leash). Margin 0 = legacy single edge.
     * AI_DESPAWN_LEASH_TICKS > 0 despawns after that many leash ticks (0 = never).
     */
    AI_ENGAGE_RANGE: 7,
    AI_ENGAGE_RANGE_X: 7,
    AI_ENGAGE_RANGE_Y: 7,
    AI_FLEE_HP_PERCENT: 0.15,
    AI_CREATURE_AGGRO_RANGE: 7,
    AI_CREATURE_LEASH: 18,
    AI_CREATURE_LEASH_REAGGRO_MARGIN: 2,
    AI_DESPAWN_LEASH_TICKS: 0,
    /**
     * Creature AI tick filter (legacy tilesToUpdate / PLAYER_UPDATE_RADIUS).
     * Only living creatures within this Chebyshev radius of a living party member
     * (same floor) run FSM brains; non-idle / sticky-target creatures keep ticking
     * so leash/return can finish. 0 = tick every living creature (filter off).
     * Player enemy scans use the same proximity window.
     */
    AI_TICK_RADIUS: 10,
    /**
     * Chunk size for creature SpatialIndex used by hunt AI proximity gather.
     * Falls back to SPAWN_CHUNK_SIZE when unset. Smaller → tighter queries,
     * more buckets; 32 matches spawn on_demand grid.
     */
    AI_SPATIAL_CHUNK_SIZE: 32,
    /**
     * Selective entity update (Etapa 3 sleep).
     * When true, living creatures outside the AI active set (same rules as
     * AI_TICK_RADIUS / sticky) skip Creature.update — cooldowns and moveDelay
     * freeze until they re-enter the bubble. No catch-up on wake (legacy-friendly).
     * false = every living creature pays full update every frame (old behaviour).
     * Radius 0 also disables sleep (all creatures stay awake).
     */
    AI_CREATURE_SLEEP: true,
    /**
     * SpawnManager knobs (legacy on-demand pattern).
     * SPAWN_MODE — "eager" (spawn all ready slots at once; default hunts/tests)
     *   or "on_demand" (only within SPAWN_ACTIVATE_RADIUS of living observers).
     * SPAWN_ACTIVATE_RADIUS — Chebyshev radius (legacy PLAYER_UPDATE_RADIUS = 10).
     *   Keep ≥ AI_TICK_RADIUS so brains are not woken for unmaterialized dens.
     * SPAWN_DESPAWN_HOME_DIST — Chebyshev home distance for on_demand despawn
     *   (legacy 20). Simulator eager mode disables home despawn (0) so corridor
     *   hunts stay stable; on_demand uses this value when > 0.
     * SPAWN_DESPAWN_IDLE_RADIUS — Chebyshev: idle living creatures beyond this of
     *   every observer (same floor) start an idle-despawn timer. null = use
     *   SPAWN_ACTIVATE_RADIUS. Only applied in on_demand when SPAWN_DESPAWN_IDLE_SEC > 0.
     * SPAWN_DESPAWN_IDLE_SEC — seconds idle+far before park (hysteresis; avoids
     *   border thrash). 0 = off. Other-floor observers count as far. Soft unload
     *   parks the same body (HP / conditions / tile); next tick may re-activate
     *   without death respawn cooldown. Combat / sticky / non-idle never park.
     * SPAWN_MAX_LIVING — soft cap on simultaneous living slot entities (0 = unlimited).
     *   When at cap, new activations try to evict farthest idle first; mid-combat
     *   and sticky targets are never budget-evicted. Eager hunts typically leave 0.
     * SPAWN_TIME_MULTIPLIER — multiplies entry.respawn seconds for cooldown
     *   (legacy SPAWN_TIME_MULTIPLIER = 2; engine default 1).
     * SPAWN_CHUNK_SIZE — spatial index cell size for on_demand scans.
     */
    SPAWN_MODE: 'eager',
    SPAWN_ACTIVATE_RADIUS: 10,
    SPAWN_DESPAWN_HOME_DIST: 20,
    SPAWN_DESPAWN_IDLE_RADIUS: null,
    SPAWN_DESPAWN_IDLE_SEC: 2,
    SPAWN_MAX_LIVING: 0,
    SPAWN_TIME_MULTIPLIER: 1,
    SPAWN_CHUNK_SIZE: 32,
    /**
     * Creature kit defaults (overridable per template via flags / strategiesTarget).
     * AI_CREATURE_LOSE_TARGET_DIST — hard clear sticky player (legacy ~10).
     * AI_CREATURE_FLEE_STAND_DIST — ideal stand-off while runHealth* flee active.
     * AI_CREATURE_STATIC_ATTACK_CHANCE — global default 1–100 before per-attack chance.
     * AI_CREATURE_CIRCLE_CHANCE — 0–100 chance per free think to step around a melee
     *   target when already at ideal stand-off (adjacent). 0 disables circling.
     * AI_CREATURE_CIRCLE_INTERVAL — logic seconds to wait after a circle attempt that
     *   did not move (occupied pick / no candidates). Successful steps already wait
     *   on moveDelay. Independent of TIME_SPEED (sim seconds via Time.timeSinceLevelLoad).
     * AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC — half-life (logic seconds) for creature
     *   damageTakenBy threat used by strategiesTarget "damage". 0 = no decay (legacy
     *   forever-accumulate). Overridable per template via flags.threatDecayHalflifeSec.
     * AI_CREATURE_RETARGET_INTERVAL — min logic seconds between mid-combat re-rolls of
     *   strategiesTarget while sticky target is still valid. 0 = sticky until lose.
     *   Per-creature changeTarget.interval (ms) + changeTarget.chance (%) override
     *   this. No flags.retarget* path.
     */
    AI_CREATURE_LOSE_TARGET_DIST: 10,
    AI_CREATURE_FLEE_STAND_DIST: 10,
    AI_CREATURE_STATIC_ATTACK_CHANCE: 100,
    AI_CREATURE_CIRCLE_CHANCE: 30,
    AI_CREATURE_CIRCLE_INTERVAL: 2.0,
    AI_CREATURE_THREAT_DECAY_HALFLIFE_SEC: 10,
    AI_CREATURE_RETARGET_INTERVAL: 0,
    /**
     * AI think cadence. Cooldowns still tick every logic frame.
     *
     * AI_GATE_BRAIN_ON_MOVE_DELAY — skip player FSM while moveDelay > 0.
     * AI_GATE_CREATURE_ON_MOVE_DELAY — skip creature *movement/FSM* while
     *   moveDelay > 0; engaged creatures still run the attack kit each tick
     *   so kiting/flee does not starve spells (see tickHuntAi).
     * AI_THINK_PAD_SEC — after Engage spell scan, if primary.attack is ready
     *   (≤ 0), set it to this pad (default 0.1s on primary GCD).
     *   Does not touch auto.attack. Must not re-apply while remaining is
     *   mid-pad (else 0.05 UPS steps stick forever). 0 disables.
     * AI_ENGAGE_DECISION_INTERVAL — min seconds between shouldEngage re-rolls while
     *   following; pack crossing monstersToEngage always re-evaluates. 0 = every tick.
     * AI_TARGET_RETARGET_DIST — soft drop sticky target when Chebyshev ≥ this
     *   (default 2) so nearest can be re-picked. 0 disables.
     * AI_TARGET_LOSE_DIST — hard clear target when Chebyshev > this (default 10 to provide hysteresis over engageRange 7). 0 disables.
     */
    AI_GATE_BRAIN_ON_MOVE_DELAY: true,
    AI_GATE_CREATURE_ON_MOVE_DELAY: true,
    AI_THINK_PAD_SEC: 0.1,
    AI_ENGAGE_DECISION_INTERVAL: 0.25,
    AI_TARGET_RETARGET_DIST: 2,
    AI_TARGET_LOSE_DIST: 10,
    /**
     * Logic-time decision throttles (Stage 12G.1 regulators).
     * Independent of TIME_SPEED — intervals are sim seconds / logic ticks.
     *
     * AI_RETARGET_INTERVAL — min logic seconds between soft retarget re-scans
     *   (findNearest over nearby enemies) while sticky target is still valid
     *   but outside hold band. 0 = every call (pre-12G.1). Lose / death always
     *   re-scan immediately.
     * AI_REPATH_INTERVAL_SEC — min logic seconds between optional (moving-goal)
     *   full A* repath packages in TileMap.followPath. Default 2.0 (server-shaped
     *   Option B). When > 0, wins over AI_REPATH_INTERVAL_TICKS. Empty path /
     *   blocked-step repaths are critical and ignore this gate (see fail-backoff).
     * AI_REPATH_INTERVAL_TICKS — tick-based optional repath throttle; used only
     *   when AI_REPATH_INTERVAL_SEC is 0 / unset (compat / tests). ≤1 = every need.
     * AI_REPATH_FAIL_BACKOFF_SEC — after a failed critical repath (still no path),
     *   suppress further critical A* for this many logic seconds (default 0.25).
     *   Clears on new goal tile, successful path, or forceDue.
     * AI_PATH_BUDGET_PER_FRAME — max optional repath packages per logic frame
     *   (Etapa 5 / policy A). 0 = unlimited (golden/CI/normal hunts). Stress /
     *   server-shaped presets pin 48. Critical never consumes budget.
     * AI_CREATURE_PATH_MAX_DISTANCE — Chebyshev A* cap for creature/summon
     *   chase stepToward / followPath (default 12). Leash / return-home uses
     *   PATH_MAX_DISTANCE so a just-leashed mob (home > 12) can walk back.
     *   Players keep PATH_MAX_DISTANCE.
     * AI_CREATURE_THINK_INTERVAL_SEC — min logic seconds between creature/summon
     *   full brain ticks when free of moveDelay (default 1.0). Attack kit still
     *   runs when brain is gated (see hunt_ai tryEngagedAttacks).
     * AI_OCCUPANT_STEP_PENALTY — soft A* step cost on enterable creature-occupied
     *   intermediates (4C; default ~4× base cardinal step). Players stack free.
     * AI_FOLLOW_TRAIL_SLOTS — FollowLeader same-floor: path to a slot N steps
     *   before rawGoal on the A* path (legacy trail) instead of always the
     *   leader tile. false = Phase C stack-on-leader goal.
     * AI_FOLLOW_SLOT_SPACING — tiles per follower slot index on that path (1).
     * AI_FOLLOW_MAX_LAG — if Chebyshev to leader exceeds this, skip trail and
     *   path to rawGoal with long-path catch-up (default 12).
     * AI_FOLLOW_PEACEFUL_WP — reserved v1.1: rawGoal = leader waypoint when
     *   quiet and near (see resolveFollowRawGoal). Default false / unused.
     */
    AI_RETARGET_INTERVAL: 0,
    AI_REPATH_INTERVAL_SEC: 2.0,
    AI_REPATH_INTERVAL_TICKS: 1,
    AI_REPATH_FAIL_BACKOFF_SEC: 0.25,
    AI_PATH_BUDGET_PER_FRAME: 0,
    AI_CREATURE_PATH_MAX_DISTANCE: 12,
    AI_CREATURE_THINK_INTERVAL_SEC: 1.0,
    AI_OCCUPANT_STEP_PENALTY: 4,
    AI_FOLLOW_TRAIL_SLOTS: true,
    AI_FOLLOW_SLOT_SPACING: 1,
    AI_FOLLOW_MAX_LAG: 12,
    AI_FOLLOW_PEACEFUL_WP: false,
    /** Seconds after taking damage that a creature will cross avoided fields (penalty path). */
    AI_PROVOKED_WINDOW_SEC: 5.0,
    /** Extra A* step cost for hazard tiles when provoked / forced-brain field crossing. */
    AI_FIELD_STEP_PENALTY: 10,
    /** After a successful hazard soft-path, remember soft mode for this many seconds. */
    AI_HAZARD_CACHE_SEC: 2.0,
    /**
     * Unused by pathfinding after S06-01 Option B (summons = wild for fields).
     * Summons no longer free-cross fields by master distance; kept for config compat only.
     */
    AI_SUMMON_FIELD_OVERRIDE_DIST: 4,
    /**
     * Hunt AI debug canvas overlays (Stage 12B).
     * All flags default false; no-op when HEADLESS. Toggled from Engine Tweakings popup.
     * @type {{
     *   enabled: boolean,
     *   states: boolean,
     *   paths: boolean,
     *   targets: boolean,
     *   ranges: boolean,
     *   spawns: boolean,
     *   hitSources: boolean,
     *   tileTypes: boolean
     * }}
     */
    debugAI: {
        enabled: false,
        states: false,
        paths: false,
        targets: false,
        ranges: false,
        spawns: false,
        /** Combat VFX hit sources (attacker tile) for active animation frames */
        hitSources: false,
        /** Color-code floor / wall / void / stairs in the viewport */
        tileTypes: false
    },
    /**
     * Watch-mode catalog sprites (Stage 12D).
     * When true, EntityMarkersScript draws catalog PNGs when ImageDB has them;
     * otherwise (or on miss/load) colored rectangles remain.
     */
    useEntitySprites: true,
    /**
     * Force sprite variant folder (icon|small|medium|alpha|retro|original).
     * null → auto from tileWidth (≤16 icon, ≤32 small, else medium).
     * At browser default 32px tiles, auto picks **small** (64×64 source).
     * @type {string|null}
     */
    entitySpriteVariant: "retro",
    /**
     * Force sprite variant folder for tiles.
     * null → auto from tileWidth (≤32 icon, else small/medium).
     * @type {string|null}
     */
    tileSpriteVariant: null,
    /**
     * Role mult for normal entities (no rarity / affix). Combined with
     * template `displayScale` at draw time: final = displayScale × role.
     * Independent of tile zoom.
     */
    entitySpriteScale: 1,
    /**
     * Max **role** mult; absolute draw cap is this × entity.displayScale
     * so large species keep affix headroom.
     */
    entitySpriteScaleMax: 2,
    /**
     * Per-rarity / affix **role** mult (multiplies template displayScale).
     * Highest match wins. Keys: rare | champion | elite | boss.
     * @type {Record<string, number>}
     */
    entitySpriteScaleByAffix: {
        rare: 1.15,
        champion: 1.35,
        elite: 1.6,
        boss: 2
    },
    /**
     * Jump height (fraction of tile height) for the walking bob animation.
     * Engine Tweakings clamps to [0, 0.5]; this value is the sole numeric default.
     */
    spriteJumpHeight: 0.05,
    /**
     * Configurable keyboard shortcut definitions for manual combat control.
     * Supports defining multiple keys per action (e.g. 'Space', 'Shift+Space').
     * @type {Record<string, string[]>}
     */
    /**
     * Manual movement defaults: cardinals only (WASD + arrow keys).
     * Diagonals come from held combinations (e.g. W+A → NW) via SOCD merge.
     * Digits / numpad / QEZC are free for action-bar hotkeys.
     */
    MANUAL_CONTROL_SHORTCUTS: {
        moveNorth: ['ARROWUP', 'W'],
        moveSouth: ['ARROWDOWN', 'S'],
        moveWest: ['ARROWLEFT', 'A'],
        moveEast: ['ARROWRIGHT', 'D'],
        moveNorthWest: [],
        moveNorthEast: [],
        moveSouthWest: [],
        moveSouthEast: [],
        targetNext: ['SPACE', 'SPACEBAR', ' '],
        targetPrev: ['SHIFT+SPACE', 'SHIFT+SPACEBAR', 'SHIFT+ '],
        toggleAutoChase: ['T', 'KEYT'],
        stopAutowalk: ['ESCAPE']
    },
    provider: 'simulator',
    /**
     * Runtime feature overrides (Engine Tweakings / headless runner).
     * `null` / missing key → inherit mode.features (then default false).
     * Award path freezes a session snapshot at hunt start for determinism;
     * mid-run UI edits are refused, but the engine accepts live config if set.
     * @type {{
     *   expProgression?: boolean|null,
     *   skillProgression?: boolean|null,
     *   partyShareEnabled?: boolean|null,
     *   corpseLoot?: boolean|null
     * }}
     */
    features: {
        expProgression: null,
        skillProgression: null,
        partyShareEnabled: null,
        corpseLoot: null
    },
    /**
     * Personal exp rate knobs (Phase C). Applied after party share raw.
     * @type {{
     *   baseRate: number,
     *   eventMult: number,
     *   staminaMult: number,
     *   additiveBonus: number,
     *   prey: number,
     *   xpBoost: number
     * }}
     */
    expRates: {
        baseRate: 1,
        eventMult: 1,
        staminaMult: 1,
        additiveBonus: 0,
        prey: 0,
        xpBoost: 0
    },
    /**
     * Skill try session knobs (Phase D pins). Defaults neutral.
     * @type {{ stageMult: number, skillPrey: number }}
     */
    skillRates: {
        stageMult: 1,
        skillPrey: 0
    },
    /** Set by engine.js → Application */
    app: null
};


/** @typedef {'rpg_fantasy'|'fantastic_ecology'|'ultra_tech'|'space_creatures'|'steampunk'|'super_heroes'} GenreId */

/**
 * Top-level asset families under each genre.
 * @typedef {'creatures'|'equipment'|'tiles'|'overlays'|'objects'|'ui'} AssetKindId
 */

/**
 * @typedef {Object} GenreConfig
 * @property {GenreId} id
 * @property {string} label Short UI / CLI label
 * @property {string} subjectLine Default subject (creatures; kept for BC)
 * @property {string} perspective Camera / composition hint
 * @property {string} styleExtra Genre-specific style notes appended to the base pixel style
 * @property {string} folder assets/sprites/<folder>/…
 * @property {string} theme Short theme phrase for non-creature subject lines
 * @property {Partial<Record<AssetKindId, string>>} [subjects] Optional per-kind subject overrides
 */

/**
 * @typedef {Object} AssetKindConfig
 * @property {AssetKindId} id
 * @property {string} label UI label
 * @property {string} folder assets/sprites/<genre>/<folder>/
 * @property {string} doneFileName under assets/data/<genre>/
 * @property {string} manifestFileName under assets/data/<genre>/
 * @property {string} catalogArrayKey JSON array key on disk (`creatures` for BC, else `items`)
 * @property {string} sheetNoun prompt noun (character spritesheet / item sheet / …)
 * @property {string} rosterLabel prompt roster header
 * @property {string} subjectFallback when genre has no subjects[kind]
 * @property {'character'|'item'|'tile'|'overlay'|'prop'} compose composition family for prompts
 * @property {boolean} usesGreenKey whether process_sprites green-screen path is expected
 * @property {string[]} [categories] optional subcategory ids (equipment, tiles, overlays, objects)
 */

/**
 * Optional UI labels and image-gen focus text for subcategory ids.
 * Category **ids** stay stable (CLI, catalog, done lists); labels/focus are display/prompt only.
 * @typedef {{ label?: string, promptFocus?: string }} CategoryMeta
 */

/** @type {Record<AssetKindId, AssetKindConfig>} */
const ASSET_KINDS = {
    creatures: {
        id: 'creatures',
        label: 'Creatures',
        folder: 'creatures',
        doneFileName: 'creature_list_done.txt',
        manifestFileName: 'creatures.json',
        catalogArrayKey: 'creatures',
        sheetNoun: 'character spritesheet',
        rosterLabel: 'Creatures',
        subjectFallback: 'Creatures and characters.',
        compose: 'character',
        usesGreenKey: true,
        categories: []
    },
    equipment: {
        id: 'equipment',
        label: 'Equipment',
        folder: 'equipment',
        doneFileName: 'equipment_list_done.txt',
        manifestFileName: 'equipment.json',
        catalogArrayKey: 'items',
        sheetNoun: 'item icon spritesheet',
        rosterLabel: 'Items',
        subjectFallback: 'Weapons, armor, and wearable equipment.',
        compose: 'item',
        usesGreenKey: true,
        categories: [
            'sword',
            'axe',
            'club',
            'mace',
            'dagger',
            'spear',
            'bow',
            'crossbow',
            'staff',
            'wand',
            'fist',
            'shield',
            'helmet',
            'armor',
            'legs',
            'boots',
            'ring',
            'amulet',
            'ammo',
            'quiver',
            'spellbook',
            'light',
            'container'
        ]
    },
    tiles: {
        id: 'tiles',
        label: 'Tiles',
        folder: 'tiles',
        doneFileName: 'tiles_list_done.txt',
        manifestFileName: 'tiles.json',
        catalogArrayKey: 'items',
        sheetNoun: 'terrain tileset sheet',
        rosterLabel: 'Tiles',
        subjectFallback: 'Terrain floors, walls, and ground tiles.',
        compose: 'tile',
        usesGreenKey: false,
        categories: ['floor', 'wall', 'water', 'path', 'special']
    },
    overlays: {
        id: 'overlays',
        label: 'Overlays',
        folder: 'overlays',
        doneFileName: 'overlays_list_done.txt',
        manifestFileName: 'overlays.json',
        catalogArrayKey: 'items',
        sheetNoun: 'terrain overlay Wang-16 sheet',
        rosterLabel: 'Overlays',
        subjectFallback: 'Alpha terrain overlays: dirt, water, and cobble fringes.',
        compose: 'overlay',
        usesGreenKey: false,
        categories: ['dirt', 'water', 'cobble']
    },
    objects: {
        id: 'objects',
        label: 'Scenario Objects',
        folder: 'objects',
        doneFileName: 'objects_list_done.txt',
        manifestFileName: 'objects.json',
        catalogArrayKey: 'items',
        sheetNoun: 'scenario object spritesheet',
        rosterLabel: 'Objects',
        subjectFallback: 'Houses, trees, walls, furniture, and map props.',
        compose: 'prop',
        usesGreenKey: true,
        categories: [
            'tree',
            'rock',
            'house',
            'wall',
            'door',
            'furniture',
            'container',
            'deco'
        ]
    },
    ui: {
        id: 'ui',
        label: 'UI Elements',
        folder: 'ui',
        doneFileName: 'ui_list_done.txt',
        manifestFileName: 'ui.json',
        catalogArrayKey: 'items',
        sheetNoun: 'user interface spritesheet',
        rosterLabel: 'UI Elements',
        subjectFallback: 'UI icons and interface elements.',
        compose: 'prop',
        usesGreenKey: true,
        categories: ['spells']
    }
};

const DEFAULT_KIND = 'creatures';

/** @type {Record<GenreId, GenreConfig>} */
const GENRES = {
    rpg_fantasy: {
        id: 'rpg_fantasy',
        label: 'Fantasy RPG',
        theme: 'Fantasy RPG',
        subjectLine: 'Fantasy RPG Creatures.',
        perspective: 'Top-down RPG style.',
        styleExtra:
            'Same SNES pixel-art rules; medieval fantasy armor and monsters, mythic beasts, ' +
            'clear silhouettes suggested with pixel clusters, not smooth shading.',
        folder: 'rpg_fantasy',
        subjects: {
            creatures: 'Fantasy RPG Creatures.',
            equipment: 'Fantasy RPG Weapons, Armor, Shields, and Magical Equipment.',
            tiles: 'Fantasy RPG Terrain: floors, walls, paths, and water tiles.',
            overlays: 'Fantasy RPG alpha overlays: dirt, water, and cobble Wang-16 fringes over grass.',
            objects: 'Fantasy RPG Scenario Objects: houses, trees, walls, furniture, and props.',
            ui: 'Fantasy RPG spell icons and interface glyphs.'
        }
    },
    fantastic_ecology: {
        id: 'fantastic_ecology',
        label: 'Fantastic Ecology',
        theme: 'Fantastic Ecology',
        subjectLine: 'Fantastic Ecology and Elemental Monsters.',
        perspective: 'Top-down RPG style.',
        styleExtra:
            'Same SNES pixel-art rules; living ecosystems, elemental hybrids, plant and crystal fauna, ' +
            'nature spirits — materials in dithered pixel clusters, not soft gradients.',
        folder: 'fantastic_ecology',
        subjects: {
            creatures: 'Fantastic Ecology and Elemental Monsters.',
            equipment: 'Nature-forged and elemental weapons, armor, and amulets.',
            tiles: 'Living terrain tiles: moss, crystal ground, coral, root floors, elemental floors.',
            overlays: 'Living alpha overlays: moss soil, tide pools, and root-cobble Wang-16 fringes.',
            objects: 'Living props: giant fungi, crystal pillars, root arches, elemental shrines.',
            ui: 'Elemental spell icons and nature-spirit interface glyphs.'
        }
    },
    ultra_tech: {
        id: 'ultra_tech',
        label: 'Ultra Tech',
        theme: 'Ultra Tech',
        subjectLine: 'Ultra Tech Robots and Mecha.',
        perspective: 'Top-down action RPG style.',
        styleExtra:
            'Same SNES pixel-art rules; hard-surface robots, mechs, drones; panel lines and glowing optics ' +
            'as chunky pixels (not smooth vector panels); no logos.',
        folder: 'ultra_tech',
        subjects: {
            creatures: 'Ultra Tech Robots and Mecha.',
            equipment: 'Sci-fi weapons, energy shields, powered armor, and tech gadgets.',
            tiles: 'Sci-fi facility tiles: metal floors, energy grids, hull plating, hazard floors.',
            overlays: 'Sci-fi alpha overlays: scorch dirt, coolant pools, and grated Wang-16 fringes.',
            objects: 'Sci-fi props: terminals, crates, turrets, power cores, blast doors.',
            ui: 'Sci-fi ability icons and HUD glyphs.'
        }
    },
    space_creatures: {
        id: 'space_creatures',
        label: 'Space Creatures',
        theme: 'Space / Sci-fi',
        subjectLine: 'Space Creatures and Aliens.',
        perspective: 'Top-down sci-fi RPG style.',
        styleExtra:
            'Same SNES pixel-art rules; original alien fauna and humanoids; cosmic palette via limited colors; ' +
            'avoid known franchise designs and smooth airbrushed shading.',
        folder: 'space_creatures',
        subjects: {
            creatures: 'Space Creatures and Aliens.',
            equipment: 'Alien and spacefarer weapons, armor, and relics.',
            tiles: 'Alien world and starship tiles: rock crust, bio-floors, hull decks, crystal ground.',
            overlays: 'Alien alpha overlays: dust, ichor pools, and crystal-cobble Wang-16 fringes.',
            objects: 'Space props: alien flora, rock spires, habitats, cargo pods, beacons.',
            ui: 'Alien ability icons and starship interface glyphs.'
        }
    },
    steampunk: {
        id: 'steampunk',
        label: 'Steampunk',
        theme: 'Steampunk',
        subjectLine: 'Steampunk Creatures and Automatons.',
        perspective: 'Top-down RPG style.',
        styleExtra:
            'Same SNES pixel-art rules; brass, copper, gears, steam vents, clockwork beasts and aeronauts ' +
            'as readable pixel clusters, not polished illustration.',
        folder: 'steampunk',
        subjects: {
            creatures: 'Steampunk Creatures and Automatons.',
            equipment: 'Steampunk weapons, brass armor, goggles, and clockwork gadgets.',
            tiles: 'Steampunk city and factory tiles: cobble, riveted steel, wooden docks, brick.',
            overlays: 'Steampunk alpha overlays: soot dirt, oil water, and brass-cobble Wang-16 fringes.',
            objects: 'Steampunk props: gear towers, pipes, airship parts, lamp posts, workshops.',
            ui: 'Steampunk spell icons and clockwork interface glyphs.'
        }
    },
    super_heroes: {
        id: 'super_heroes',
        label: 'Super Heroes',
        theme: 'Super Hero',
        subjectLine: 'Original Super Heroes and Super Villains.',
        perspective: 'Top-down action RPG style.',
        styleExtra:
            'Same SNES pixel-art rules; colorful original costumes and powers as bold flat pixel blocks; ' +
            'no trademarked characters or logos; not comic-book vector line art.',
        folder: 'super_heroes',
        subjects: {
            creatures: 'Original Super Heroes and Super Villains.',
            equipment: 'Original superhero gear: shields, gauntlets, helmets, power items (no brands).',
            tiles: 'City and base tiles: rooftops, streets, concrete, lab floors, night alleys.',
            overlays: 'City alpha overlays: dirt patches, puddles, and street-cobble Wang-16 fringes.',
            objects: 'City props: rooftop vents, billboards (no text/logos), cars as props, hydrants, crates.',
            ui: 'Original super-power icons and comic HUD glyphs (no brands).'
        }
    }
};

const DEFAULT_GENRE = 'rpg_fantasy';

/**
 * Display labels + image-gen focus for subcategory ids that need disambiguation.
 * Ids remain the source of truth (`legs`, `boots`, …).
 * @type {Partial<Record<AssetKindId, Record<string, CategoryMeta>>>}
 */
const CATEGORY_META = {
    equipment: {
        legs: {
            label: 'legs / pants',
            // "legs" alone often yields boots; spell out pants-style armor and forbid footwear.
            promptFocus:
                'leg armor / pants only (pants, leggings, greaves, cuisses — a waist-to-ankle ' +
                'armor piece, still equipment armor). No boots, shoes, sabatons, or any footwear'
        },
        boots: {
            label: 'boots',
            promptFocus:
                'boots / footwear only (boots, shoes, sabatons, treads). No pants, leggings, ' +
                'or full leg armor'
        },
        ammo: {
            label: 'ammo',
            promptFocus:
                'ammunition / projectiles only (arrows, bolts, darts, throwing needles). ' +
                'No bow, crossbow, or quiver — just the projectile icon'
        },
        quiver: {
            label: 'quiver',
            promptFocus:
                'quiver / bolt case only (arrow container worn on the body). No loose arrows or bows'
        },
        fist: {
            label: 'fist / claw',
            promptFocus:
                'fist weapons only (claws, katar, knuckle, sai, bo staff as hand-to-hand). ' +
                'No swords, axes, or shields'
        },
        spellbook: {
            label: 'spellbook',
            promptFocus:
                'spellbook / tome / grimoire only (closed or open magic book). No wands or staffs'
        },
        light: {
            label: 'light',
            promptFocus:
                'light source / held torch-like item only (torch, lamp, candle, glowing orb). ' +
                'No weapons or full armor'
        }
    },
    overlays: {
        dirt: {
            label: 'dirt',
            promptFocus:
                'packed earth / soil overlay family only (alpha fringe over a grass ground; ' +
                'not a full-bleed ground fill)'
        },
        water: {
            label: 'water',
            promptFocus:
                'shallow water / shore overlay family only (alpha liquid fringe over ground; ' +
                'not an opaque lake fill tile)'
        },
        cobble: {
            label: 'cobble',
            promptFocus:
                'cobblestone / packed-stone path overlay family only (alpha fringe over ground; ' +
                'not a seamless full-cell street tile)'
        }
    }
};

/**
 * UI label for a kind + category id (falls back to the id).
 * @param {string} kindId
 * @param {string} categoryId
 * @returns {string}
 */
function categoryLabel(kindId, categoryId) {
    if (!categoryId) return '';
    const meta =
        CATEGORY_META[kindId] && CATEGORY_META[kindId][categoryId]
            ? CATEGORY_META[kindId][categoryId]
            : null;
    return (meta && meta.label) || categoryId;
}

/**
 * Image-gen focus phrase for a kind + category, or null for the generic note.
 * @param {string} kindId
 * @param {string} categoryId
 * @returns {string|null}
 */
function categoryPromptFocus(kindId, categoryId) {
    if (!categoryId) return null;
    const meta =
        CATEGORY_META[kindId] && CATEGORY_META[kindId][categoryId]
            ? CATEGORY_META[kindId][categoryId]
            : null;
    return (meta && meta.promptFocus) || null;
}

/**
 * Base URL for the sprite free-edit UI (sprite-manager shell).
 * Forms supported:
 * - Absolute path: `/sprite-editor` → `/sprite-editor/layout_free_edit.html`
 * - Protocol-relative: `//host/path` → `//host/path/layout_free_edit.html`
 * - Absolute URL: `http://test.com/` → `http://test.com/layout_free_edit.html`
 * - App-relative subfolder: `sprite-manager/` → resolved via appUrl, then page appended
 *
 * A trailing slash is added automatically before the page name when missing.
 */
const SPRITE_EDITOR_URL = '/sprite-editor';

/**
 * Build a sprite-editor page URL from SPRITE_EDITOR_URL (or an override base).
 * App-relative bases (no leading `/`, `//`, or scheme) need `resolveAppUrl` (browser `appUrl`).
 *
 * @param {string} [base=SPRITE_EDITOR_URL]
 * @param {(relPath: string) => string} [resolveAppUrl]
 * @param {string} [page='layout_free_edit.html']
 * @returns {string}
 */
function resolveSpriteEditorUrl(
    base = SPRITE_EDITOR_URL,
    resolveAppUrl,
    page = 'layout_free_edit.html'
) {
    let b = String(base == null ? '' : base).trim();
    if (!b) b = '/sprite-editor';
    const isRootAbsolute = b.startsWith('/');
    const isProtocolRelative = b.startsWith('//');
    const isAbsoluteUrl = /^[a-z][a-z0-9+.-]*:/i.test(b);
    if (!isRootAbsolute && !isProtocolRelative && !isAbsoluteUrl) {
        if (typeof resolveAppUrl === 'function') {
            b = resolveAppUrl(b);
        }
    }
    b = b.replace(/\/?$/, '/');
    return b + String(page).replace(/^\//, '');
}

const PATHS = {
    root: ROOT,
    assets: path.join(ROOT, 'assets'),
    data: path.join(ROOT, 'assets', 'data'),
    sprites: path.join(ROOT, 'assets', 'sprites'),
    /**
     * Legacy port (dev maps, spawns, monster GIFs).
     * See assets/legacy/README.md. Fixed root — mode.json may still point maps/spawns here.
     */
    legacy: path.join(ROOT, 'assets', 'legacy'),
    /**
     * Collision path PNGs (`floor-*-path.png`).
     * Updated by modes.applyModePaths for the active content mode.
     */
    maps: path.join(ROOT, 'assets', 'legacy', 'maps', 'v01'),
    /**
     * Coarse navmesh graphs. Updated by modes.applyModePaths.
     */
    navmesh: path.join(ROOT, 'assets', 'legacy', 'maps', 'v01', 'navmesh'),
    /**
     * Active mode combat / hunt presets (presets/<mode>/).
     * Updated by modes.applyModePaths.
     */
    presets: path.join(ROOT, 'presets', 'standard')
};

/**
 * Absolute path to a floor collision PNG under the active pack (`PATHS.maps`).
 * @param {string|number} floorId e.g. '07' or 7 (padded to 2 digits if numeric-like)
 * @param {string} [mapsRoot] hunt pack root override (`legacyMapId`)
 * @returns {string}
 */
function mapPathPng(floorId, mapsRoot) {
    const raw = String(floorId);
    const id = /^\d+$/.test(raw) ? raw.padStart(2, '0') : raw;
    return path.join(mapsRoot || PATHS.maps, `floor-${id}-path.png`);
}

/**
 * Absolute path to a navmesh JSON under the active pack navmesh dir.
 * @param {string} id e.g. 'floor07_corridor' or 'legacy_merged'
 * @returns {string}
 */
function navmeshPath(id) {
    return path.join(PATHS.navmesh, `${id}.json`);
}

/**
 * @param {string} genreId
 * @returns {GenreConfig}
 */
function getGenre(genreId) {
    const g = GENRES[genreId];
    if (!g) {
        const known = Object.keys(GENRES).join(', ');
        throw new Error(`Unknown genre "${genreId}". Known: ${known}`);
    }
    return g;
}

/**
 * @param {string} kindId
 * @returns {AssetKindConfig}
 */
function getAssetKind(kindId) {
    const k = ASSET_KINDS[kindId];
    if (!k) {
        const known = Object.keys(ASSET_KINDS).join(', ');
        throw new Error(`Unknown asset kind "${kindId}". Known: ${known}`);
    }
    return k;
}

/**
 * Subject line for image-gen prompts (genre + kind).
 * @param {string} genreId
 * @param {string} [kindId]
 * @returns {string}
 */
function subjectLineFor(genreId, kindId = DEFAULT_KIND) {
    const g = getGenre(genreId);
    const k = getAssetKind(kindId);
    if (g.subjects && g.subjects[k.id]) return g.subjects[k.id];
    if (k.id === 'creatures' && g.subjectLine) return g.subjectLine;
    return `${g.theme || g.label}: ${k.subjectFallback}`;
}

/**
 * Absolute paths for a genre + asset kind (sprites, done-list, catalog).
 * @param {string} genreId
 * @param {string} [kindId='creatures']
 */
function genrePaths(genreId, kindId = DEFAULT_KIND) {
    const g = getGenre(genreId);
    const k = getAssetKind(kindId);
    const kindRoot = path.join(PATHS.sprites, g.folder, k.folder);
    const dataDir = path.join(PATHS.data, g.folder);
    return {
        genre: g,
        kind: k,
        kindId: k.id,
        kindRoot,
        /** @deprecated use kindRoot — kept so older callers still resolve creatures root */
        creaturesRoot: kindRoot,
        original: path.join(kindRoot, 'original'),
        /** Full-size RGBA after BG removal (process_sprites.py). */
        alpha: path.join(kindRoot, 'alpha'),
        /** 50% of alpha, full-color RGBA (NEAREST). */
        medium: path.join(kindRoot, 'medium'),
        /** medium quantized to 16 colors + transparent index 0. */
        retro: path.join(kindRoot, 'retro'),
        /** alpha scaled to 64×64 RGBA (LANCZOS, or NEAREST if catalog scaleFilter=nearest). */
        small: path.join(kindRoot, 'small'),
        /** alpha scaled to 32×32 RGBA (same filter as small/). */
        icon: path.join(kindRoot, 'icon'),
        /**
         * @deprecated Legacy alias for retro/ (pre multi-variant pipeline).
         */
        transformed: path.join(kindRoot, 'retro'),
        spritesheet: path.join(kindRoot, 'sprites.png'),
        doneFile: path.join(dataDir, k.doneFileName),
        manifest: path.join(dataDir, k.manifestFileName),
        dataDir
    };
}

/**
 * @returns {AssetKindId[]}
 */
function listKindIds() {
    return /** @type {AssetKindId[]} */ (Object.keys(ASSET_KINDS));
}

/**
 * Palette / authoring stamp kind. Unknown values collapse to tiles.
 * @param {string|null|undefined} kind
 * @returns {'tiles'|'objects'|'overlays'}
 */
function normalizeStampKind(kind) {
    const k = String(kind || 'tiles')
        .trim()
        .toLowerCase();
    if (k === 'objects' || k === 'overlays') return k;
    return 'tiles';
}

module.exports = {
    ROOT,
    PATHS,
    GENRES,
    ASSET_KINDS,
    CATEGORY_META,
    DEFAULT_GENRE,
    DEFAULT_KIND,
    SPRITE_EDITOR_URL,
    resolveSpriteEditorUrl,
    getGenre,
    getAssetKind,
    subjectLineFor,
    categoryLabel,
    categoryPromptFocus,
    genrePaths,
    listKindIds,
    normalizeStampKind,
    mapPathPng,
    navmeshPath,
    Settings
};

// Bind PATHS.maps / presets / navmesh to the default content mode (after exports).
try {
    const modes = require('./core/lib/modes.js');
    if (modes && typeof modes.ensureActiveMode === 'function') {
        modes.ensureActiveMode();
    }
} catch (_) {
    /* browser stub or incomplete tree */
}
