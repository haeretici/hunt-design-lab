/**
 * Pure party / hunt form helpers for the Hunt Simulator UI (Stage 7).
 * No DOM — collect/apply shapes are serializable for IndexedDB prefs.
 */

'use strict';

const {
    EQUIPMENT_SLOTS,
    normalizeEquipmentMap
} = require('../../core/lib/character/stats.js');
const {
    expandPartyMember,
    materializePartyMember,
    defaultProfileIdForClass,
    assertPartyMembersHaveSkillSource
} = require('../../core/lib/character/player_profile.js');
const {
    huntToSimulatorOpts
} = require('../../providers/simulator/hunt_opts.js');

/** Max editable party slots in the browser UI. */
const MAX_PARTY_SLOTS = 4;

/** Equipment slots exposed in the party editor (engine vocabulary). */
const EDITOR_EQUIPMENT_SLOTS = [
    'rightHand',
    'leftHand',
    'armor',
    'helmet',
    'legs',
    'boots',
    'amulet',
    'ring'
];

/** Default AI strategy when a class has no specialized preset. */
const DEFAULT_STRATEGY_BY_CLASS = {
    guardian: 'guardian_aggro',
    scout: 'scout_kite',
    mystic: 'mystic_combo',
    adept: 'adept_caster',
    warden: 'warden_support',
    adventurer: 'balanced'
};

/**
 * @param {string} classId
 * @returns {string}
 */
function defaultStrategyForClass(classId) {
    return DEFAULT_STRATEGY_BY_CLASS[classId] || 'balanced';
}

/**
 * Empty member row for the party editor.
 * Enabled default slot is profile-backed (create-char analog) so Play never
 * starts on naked class floors. Disabled slots keep a class + starter id so
 * enabling them materializes skills without an extra party preset load.
 * @param {number} [index=0]
 * @returns {object}
 */
function emptyMember(index) {
    const i = index != null ? index : 0;
    return {
        enabled: i === 0,
        name: i === 0 ? 'Leader' : `Member${i + 1}`,
        classId: 'guardian',
        profileId: 'guardian_starter',
        strategyId: 'guardian_aggro',
        level: 50,
        isLeader: i === 0,
        controlMode: 'ai',
        autoChase: false,
        equipment: {}
    };
}

/**
 * Optional profile loader for party members that only reference profileId.
 * Injected by browser/headless when available; null-safe without it.
 * @type {((id: string) => object|null)|null}
 */
let _loadPlayerProfile = null;

/**
 * @param {((id: string) => object|null)|null} fn
 */
function setPlayerProfileLoader(fn) {
    _loadPlayerProfile = typeof fn === 'function' ? fn : null;
}

/**
 * Copy equipment into editor slots after alias normalize (head→helmet, …).
 * @param {object|null|undefined} rawEq
 * @returns {Record<string, string>}
 */
function equipmentForEditor(rawEq) {
    const normalized = normalizeEquipmentMap(rawEq);
    const equipment = Object.create(null);
    for (let s = 0; s < EDITOR_EQUIPMENT_SLOTS.length; s++) {
        const slot = EDITOR_EQUIPMENT_SLOTS[s];
        const v = normalized[slot];
        if (v != null && v !== '') equipment[slot] = String(v);
    }
    return equipment;
}

/**
 * Normalize a partial member into a full form row.
 * Accepts designer profile slots (head/chest/weapon/shield) and optional profileId.
 * @param {object|null|undefined} raw
 * @param {number} [index=0]
 * @param {{ loadPlayerProfile?: (id: string) => object|null }} [opts]
 * @returns {object}
 */
function normalizeMember(raw, index, opts) {
    const base = emptyMember(index);
    // Null/missing → start from profile-backed empty slot (create-char default)
    const input = raw && typeof raw === 'object' ? raw : base;

    const loadProf =
        opts && typeof opts.loadPlayerProfile === 'function'
            ? opts.loadPlayerProfile
            : _loadPlayerProfile || resolveProfileLoader();
    // Character-first: expand profileId and auto-bind class starter when needed
    const expanded = materializePartyMember(input, {
        loadPlayerProfile: loadProf || undefined,
        autoStarterProfile: true
    });
    const src = expanded || input;

    const equipment = equipmentForEditor(src.equipment);
    const classId = src.classId
        ? String(src.classId)
        : src.vocation
          ? String(src.vocation)
          : base.classId;
    /** @type {Record<string, any>} */
    const row = {
        enabled:
            raw && typeof raw === 'object'
                ? raw.enabled !== false && raw.enabled !== 0
                : base.enabled,
        name:
            src.name != null && String(src.name).trim() !== ''
                ? String(src.name).trim()
                : base.name,
        classId,
        strategyId: src.strategyId
            ? String(src.strategyId)
            : defaultStrategyForClass(classId),
        level:
            src.level != null && Number.isFinite(Number(src.level))
                ? Math.max(1, Math.floor(Number(src.level)))
                : base.level,
        isLeader: !!(raw && typeof raw === 'object' ? raw.isLeader : base.isLeader),
        controlMode:
            src.controlMode != null
                ? String(src.controlMode)
                : input.controlMode != null
                  ? String(input.controlMode)
                  : 'ai',
        autoChase:
            src.autoChase != null
                ? !!src.autoChase
                : input.autoChase != null
                  ? !!input.autoChase
                  : false,
        equipment,
        profileId:
            src.profileId != null
                ? String(src.profileId)
                : input.profileId != null
                  ? String(input.profileId)
                  : defaultProfileIdForClass(classId)
    };
    // Profile / member skills must reach the simulator. Without them, combat
    // falls back to classes.json vocation baselines (often much higher magic /
    // melee than authored player_profiles) and Hunt UI diverges from headless
    // --party <id> (see bugs/bug_20260731_003936_hunt_s42_3e96f2.json).
    const skillsSrc =
        src.skills && typeof src.skills === 'object'
            ? src.skills
            : input.skills && typeof input.skills === 'object'
              ? input.skills
              : null;
    if (skillsSrc) {
        row.skills = Object.assign({}, skillsSrc);
    }
    if (src.critChance != null) row.critChance = Number(src.critChance) || 0;
    else if (input.critChance != null) row.critChance = Number(input.critChance) || 0;
    if (src.critDamage != null) row.critDamage = Number(src.critDamage) || 0;
    else if (input.critDamage != null) row.critDamage = Number(input.critDamage) || 0;
    // Inventory seeds (Scenario Lab sandbox / authored backpack trees)
    if (src.inventorySandbox === true || input.inventorySandbox === true) {
        row.inventorySandbox = true;
    }
    if (src.inventory != null) row.inventory = src.inventory;
    else if (input.inventory != null) row.inventory = input.inventory;
    if (src.backpack != null) row.backpack = src.backpack;
    else if (input.backpack != null) row.backpack = input.backpack;
    // Seeded combat conditions (status strip demos)
    if (Array.isArray(src.conditions) && src.conditions.length) {
        row.conditions = src.conditions.slice();
    } else if (Array.isArray(input.conditions) && input.conditions.length) {
        row.conditions = input.conditions.slice();
    }
    return row;
}

/**
 * Build party form state from a party preset (or expanded party bag).
 * @param {object|null} party party with members[] (already expanded preferred)
 * @returns {{ members: object[] }}
 */
function partyFormFromParty(party) {
    const members = [];
    const defs =
        party && Array.isArray(party.members) && party.members.length
            ? party.members
            : [{ name: 'Guardian', profileId: 'guardian_starter', isLeader: true }];

    for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
        if (i < defs.length) {
            const m = normalizeMember(
                Object.assign({}, defs[i], { enabled: true }),
                i
            );
            members.push(m);
        } else {
            // Disabled but still profile-backed so enable → Play has skills
            const m = normalizeMember(
                Object.assign({}, emptyMember(i), { enabled: false }),
                i
            );
            members.push(m);
        }
    }
    ensureSingleLeader(members);
    return { members };
}

/**
 * @deprecated Hunts no longer embed parties — use partyFormFromParty / partyId.
 * Kept for tests that still pass a bag with parties[0].
 * @param {object|null} hunt
 * @returns {{ members: object[] }}
 */
function partyFormFromHunt(hunt) {
    const party =
        hunt && Array.isArray(hunt.parties) && hunt.parties[0]
            ? hunt.parties[0]
            : null;
    return partyFormFromParty(party);
}

/**
 * Load a party preset id into form members (browser/Node).
 * @param {string|null|undefined} partyId
 * @param {{ loadParty?: (id: string) => object|null }} [opts]
 * @returns {{ members: object[], partyId: string|null }}
 */
function partyFormFromPartyId(partyId, opts) {
    const o = opts || {};
    const id =
        partyId != null && String(partyId).trim() !== ''
            ? String(partyId).trim()
            : null;
    let party = null;
    if (id && typeof o.loadParty === 'function') {
        try {
            party = o.loadParty(id);
        } catch (_) {
            party = null;
        }
    } else if (id) {
        try {
            const presets = require('../../core/lib/presets.js');
            party = presets.loadParty(id);
        } catch (_) {
            party = null;
        }
    }
    const form = partyFormFromParty(party);
    return { members: form.members, partyId: id };
}

/**
 * Form slot index of the enabled leader (or first enabled / 0).
 * Used as the default "Active" camera view before Play.
 * @param {object[]} members
 * @returns {number}
 */
function leaderFormSlot(members) {
    if (!Array.isArray(members)) return 0;
    for (let i = 0; i < members.length; i++) {
        if (members[i] && members[i].enabled && members[i].isLeader) return i;
    }
    for (let i = 0; i < members.length; i++) {
        if (members[i] && members[i].enabled) return i;
    }
    return 0;
}

/**
 * Map a form slot index → index among enabled members (Simulator party.members order).
 * @param {object[]} members form members (MAX_PARTY_SLOTS rows)
 * @param {number} slot form slot 0..MAX_PARTY_SLOTS-1
 * @returns {number|null} enabled index, or null if slot disabled / missing
 */
function enabledMemberIndexForSlot(members, slot) {
    if (!Array.isArray(members)) return null;
    const s = Math.floor(Number(slot));
    if (!Number.isFinite(s) || s < 0) return null;
    let n = 0;
    for (let i = 0; i < members.length; i++) {
        if (!members[i] || !members[i].enabled) continue;
        if (i === s) return n;
        n += 1;
    }
    return null;
}

/**
 * Ensure one leader among enabled slots (first enabled if none).
 * @param {object[]} members
 */
function ensureSingleLeader(members) {
    if (!Array.isArray(members)) return;
    let leaderIdx = -1;
    for (let i = 0; i < members.length; i++) {
        if (members[i] && members[i].enabled && members[i].isLeader) {
            if (leaderIdx < 0) leaderIdx = i;
            else members[i].isLeader = false;
        }
    }
    if (leaderIdx < 0) {
        for (let i = 0; i < members.length; i++) {
            if (members[i] && members[i].enabled) {
                members[i].isLeader = true;
                leaderIdx = i;
                break;
            }
        }
    }
    for (let i = 0; i < members.length; i++) {
        if (members[i] && i !== leaderIdx) members[i].isLeader = false;
    }
}

/**
 * Convert form members → Simulator party.members list.
 * Disabled slots are dropped.
 *
 * @param {object[]} members
 * @returns {object[]}
 */
/**
 * @returns {((id: string) => object|null)|null}
 */
function resolveProfileLoader() {
    if (typeof _loadPlayerProfile === 'function') return _loadPlayerProfile;
    try {
        return require('../../core/lib/presets.js').loadPlayerProfile;
    } catch (_) {
        return null;
    }
}

function membersToPartyConfig(members) {
    ensureSingleLeader(members);
    const out = [];
    if (!Array.isArray(members)) return out;
    const loadProf = resolveProfileLoader();
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m || !m.enabled) continue;
        // Character-first materialize: profile expand + class → starter fallback
        let src = m;
        if (typeof loadProf === 'function') {
            const matured = materializePartyMember(m, {
                loadPlayerProfile: loadProf,
                autoStarterProfile: true
            });
            if (matured) src = matured;
        }
        const equipment = equipmentForEditor(src.equipment != null ? src.equipment : m.equipment);
        /** @type {Record<string, any>} */
        const row = {
            name: src.name || m.name || `Member${out.length + 1}`,
            classId: src.classId || m.classId || 'adventurer',
            strategyId:
                src.strategyId ||
                m.strategyId ||
                defaultStrategyForClass(src.classId || m.classId),
            level: src.level != null ? src.level : m.level != null ? m.level : 50,
            isLeader: !!(m.isLeader || src.isLeader),
            controlMode:
                m.controlMode != null
                    ? String(m.controlMode)
                    : src.controlMode != null
                      ? String(src.controlMode)
                      : 'ai',
            autoChase:
                m.autoChase != null
                    ? !!m.autoChase
                    : src.autoChase != null
                      ? !!src.autoChase
                      : false,
            equipment
        };
        if (src.profileId || m.profileId) {
            row.profileId = String(src.profileId || m.profileId);
        }
        if (src.skills && typeof src.skills === 'object') {
            row.skills = Object.assign({}, src.skills);
        } else if (m.skills && typeof m.skills === 'object') {
            row.skills = Object.assign({}, m.skills);
        }
        if (src.critChance != null || m.critChance != null) {
            row.critChance = Number(src.critChance != null ? src.critChance : m.critChance) || 0;
        }
        if (src.critDamage != null || m.critDamage != null) {
            row.critDamage = Number(src.critDamage != null ? src.critDamage : m.critDamage) || 0;
        }
        // Inventory seeds (Scenario Lab sandbox / authored backpack trees)
        if (m.inventorySandbox === true || src.inventorySandbox === true) {
            row.inventorySandbox = true;
        }
        if (m.inventory != null) row.inventory = m.inventory;
        else if (src.inventory != null) row.inventory = src.inventory;
        if (m.backpack != null) row.backpack = m.backpack;
        else if (src.backpack != null) row.backpack = src.backpack;
        // Seeded combat conditions (status strip demos)
        if (Array.isArray(m.conditions) && m.conditions.length) {
            row.conditions = m.conditions.slice();
        } else if (Array.isArray(src.conditions) && src.conditions.length) {
            row.conditions = src.conditions.slice();
        }
        out.push(row);
    }
    if (!out.length) {
        // Product fallback: expand starter profile so skills are authored (§7.2)
        const expanded = expandPartyMember(
            {
                name: 'Guardian',
                profileId: 'guardian_starter',
                isLeader: true,
                controlMode: 'ai'
            },
            { loadPlayerProfile: loadProf || undefined }
        );
        if (expanded && expanded.skills) {
            out.push(expanded);
        } else {
            throw new Error(
                'membersToPartyConfig: no enabled members and could not load guardian_starter'
            );
        }
    }
    // Guarantee one leader
    if (!out.some((m) => m.isLeader)) {
        out[0].isLeader = true;
    }
    // Skill-source assert runs after materialize at product borders
    // (resolveSessionParties / loadParty / buildSimulatorOpts).
    return out;
}

/**
 * Build a resolved-hunt-shaped object from expanded hunt JSON + form party.
 * Shared field extraction; `huntToSimulatorOpts` maps this to Simulator opts.
 *
 * @param {object} opts same shape as buildSimulatorOpts input
 * @returns {object}
 */
function resolvedFromBrowserHunt(opts) {
    const o = opts || {};
    const hunt = o.hunt || {};
    const floor = hunt.floor != null ? hunt.floor : 7;
    const waypoints = Array.isArray(hunt.waypoints) ? hunt.waypoints : [];
    const spawns = Array.isArray(hunt.spawns) ? hunt.spawns : [];
    // Sequential arena waves (optional). Distinct from flat spawn tables.
    const waves = hunt.waves != null ? hunt.waves : null;
    const props = Array.isArray(hunt.props) ? hunt.props : [];
    const partyMembers = membersToPartyConfig(o.members || []);

    // Multi-floor / nav — same fields headless resolveHuntConfig forwards.
    const stairLinks = Array.isArray(hunt.stairLinks)
        ? hunt.stairLinks
        : Array.isArray(hunt.stairs)
          ? hunt.stairs
          : null;
    const navmeshData =
        hunt.navmeshData && typeof hunt.navmeshData === 'object'
            ? hunt.navmeshData
            : hunt.navmesh && typeof hunt.navmesh === 'object'
              ? hunt.navmesh
              : null;
    const layoutMeta =
        hunt.layoutMeta && typeof hunt.layoutMeta === 'object'
            ? hunt.layoutMeta
            : null;
    const floorMeta = Array.isArray(hunt.floorMeta)
        ? hunt.floorMeta
        : layoutMeta && Array.isArray(layoutMeta.floorMeta)
          ? layoutMeta.floorMeta
          : null;
    const arenaLoop =
        hunt.arenaLoop && typeof hunt.arenaLoop === 'object'
            ? hunt.arenaLoop
            : null;
    const perFloorWaypoints =
        hunt.perFloorWaypoints && typeof hunt.perFloorWaypoints === 'object'
            ? hunt.perFloorWaypoints
            : null;
    const pacingBudget =
        hunt.pacingBudget && typeof hunt.pacingBudget === 'object'
            ? hunt.pacingBudget
            : null;
    const mapPaths =
        hunt.mapPaths && typeof hunt.mapPaths === 'object'
            ? hunt.mapPaths
            : null;

    // Arena-rest: if expand left waypoints empty but per-floor routes exist,
    // seed party from first floor so spawnParty does not hard-fail.
    let routeWaypoints = waypoints;
    if (
        (!routeWaypoints || !routeWaypoints.length) &&
        perFloorWaypoints
    ) {
        const floorKey =
            hunt.floor != null ? String(hunt.floor) : '0';
        const fromFloor = perFloorWaypoints[floorKey];
        if (Array.isArray(fromFloor) && fromFloor.length) {
            routeWaypoints = fromFloor;
        } else {
            const keys = Object.keys(perFloorWaypoints);
            for (let ki = 0; ki < keys.length; ki++) {
                const w = perFloorWaypoints[keys[ki]];
                if (Array.isArray(w) && w.length) {
                    routeWaypoints = w;
                    break;
                }
            }
        }
    }

    const partyName =
        o.partyName ||
        (hunt.parties && hunt.parties[0] && hunt.parties[0].name) ||
        'HuntParty';
    const partyId =
        o.partyId != null && String(o.partyId).trim() !== ''
            ? String(o.partyId).trim()
            : (hunt.parties && hunt.parties[0] && hunt.parties[0].id) ||
              'hunt';
    let parties = [
        {
            name: partyName,
            id: partyId,
            waypoints: routeWaypoints,
            loopWaypoints: !!hunt.loopWaypoints,
            stairLinks: stairLinks || undefined,
            members: partyMembers
        }
    ];

    // Headless resolveSessionParties expands profileId → skills. Browser must
    // do the same so Hunt UI matches `npm run sim:hunt -- --party <id>`.
    try {
        const { expandParties } = require('../../core/lib/character/player_profile.js');
        let loadPlayerProfile = null;
        try {
            const presets = require('../../core/lib/presets.js');
            if (typeof presets.loadPlayerProfile === 'function') {
                loadPlayerProfile = presets.loadPlayerProfile;
            }
        } catch (_) {
            loadPlayerProfile = null;
        }
        parties = expandParties(parties, {
            loadPlayerProfile: loadPlayerProfile || undefined
        });
    } catch (_) {
        /* keep form members as-is */
    }

    /**
     * Match headless resolveHuntConfig: explicit spawnMode, else eager when the
     * hunt only implies it via absence of on_demand (Simulator also defaults).
     * Prefer authored hunt.spawnMode when set.
     */
    const spawnMode =
        hunt.spawnMode === 'on_demand'
            ? 'on_demand'
            : hunt.spawnMode === 'eager'
              ? 'eager'
              : 'eager';

    // Stage 11.4/11.5: generated friction must reach Simulator.floorLayers.
    // Without this, the browser loads continent path PNGs and party spawn
    // fails at generator waypoints (e.g. 0,3 on floor 0).
    const floorFriction =
        o.floorFriction != null
            ? o.floorFriction
            : hunt.floorFriction && hunt.floorFriction.friction
              ? hunt.floorFriction
              : null;
    const floorLayers =
        o.floorLayers != null
            ? o.floorLayers
            : hunt.floorLayers && typeof hunt.floorLayers === 'object'
              ? hunt.floorLayers
              : null;
    // Stage 11.9: decorative art layers from expand (artSet binding)
    const floorArt =
        o.floorArt != null
            ? o.floorArt
            : hunt.floorArt && hunt.floorArt.cells
              ? hunt.floorArt
              : null;
    const artLayers =
        o.artLayers != null
            ? o.artLayers
            : hunt.artLayers && typeof hunt.artLayers === 'object'
              ? hunt.artLayers
              : null;

    let maxKills =
        hunt.limits && hunt.limits.maxKills != null
            ? hunt.limits.maxKills
            : hunt.maxKills != null
              ? hunt.maxKills
              : null;
    let maxSeconds =
        hunt.limits && hunt.limits.maxSeconds != null
            ? hunt.limits.maxSeconds
            : hunt.maxSeconds != null
              ? hunt.maxSeconds
              : hunt.duration != null
                ? hunt.duration
                : null;
    // Headless derives maxTicks from maxSeconds when limits.maxTicks is absent
    // (rising_pressure_macro: maxSeconds 180 → 3600). Keep browser reports aligned.
    let maxTicks =
        hunt.limits && hunt.limits.maxTicks != null
            ? hunt.limits.maxTicks
            : hunt.maxTicks != null
              ? hunt.maxTicks
              : null;
    if (maxTicks == null && maxSeconds != null && Number(maxSeconds) > 0) {
        let ups = 20;
        try {
            const { Settings } = require('../../settings.js');
            if (Settings && Settings.LOGIC_UPS > 0) ups = Settings.LOGIC_UPS;
        } catch (_) {
            /* default 20 */
        }
        maxTicks = Math.max(1, Math.ceil(Number(maxSeconds) * ups));
    }
    let noAttackTimeoutSec =
        hunt.limits && hunt.limits.noAttackTimeoutSec != null
            ? hunt.limits.noAttackTimeoutSec
            : hunt.noAttackTimeoutSec != null
              ? hunt.noAttackTimeoutSec
              : null;

    return {
        seed: o.seed >>> 0 || 1,
        floor,
        floors: Array.isArray(hunt.floors) ? hunt.floors.slice() : null,
        mapPath: o.mapPath || hunt.mapPath || null,
        mapPaths,
        floorFriction,
        floorLayers,
        floorArt,
        artLayers,
        huntId: o.huntId != null ? o.huntId : hunt.id || null,
        genre: hunt.genre || o.genre || null,
        parties,
        spawns,
        waves,
        props,
        spawnMode,
        stairLinks,
        navmeshData,
        pacingBudget,
        layoutMeta,
        floorMeta,
        arenaLoop,
        perFloorWaypoints,
        maxTicks,
        maxKills,
        maxSeconds,
        noAttackTimeoutSec
    };
}

/**
 * Build full Simulator constructor options for a browser hunt session.
 * Delegates field mapping to shared `huntToSimulatorOpts`.
 *
 * @param {object} opts
 * @param {number} opts.seed
 * @param {object} opts.hunt hunt definition JSON
 * @param {string|null} [opts.huntId]
 * @param {object[]} opts.members form members (enabled filtered)
 * @param {string} [opts.mapPath] browser URL for path PNG
 * @param {object} [opts.injectors] from buildPresetInjectors()
 * @param {boolean|object} [opts.parityTrace] opt-in parityTickLog (browser:parity)
 * @returns {object} Simulator opts
 */
function buildSimulatorOpts(opts) {
    const o = opts || {};
    const resolved = resolvedFromBrowserHunt(o);
    // membersToPartyConfig already materializes; assert is the last integrity
    // line (S2 parity) — not the primary authoring gate.
    if (Array.isArray(resolved.parties)) {
        for (let pi = 0; pi < resolved.parties.length; pi++) {
            assertPartyMembersHaveSkillSource(resolved.parties[pi], {
                context: `buildSimulatorOpts party[${pi}]`,
                onlyEnabled: false
            });
        }
    }
    // Callers should omit mapPath when floorFriction is set (continent PNGs
    // at generator waypoints like 0,3 are not walkable). Simulator prefers
    // floorLayers over mapPath when both are present.
    /** @type {object} */
    const extra = {
        injectors: o.injectors || {},
        mapPath: o.mapPath !== undefined ? o.mapPath || null : resolved.mapPath,
        combatAi: true
    };
    if (o.parityTrace !== undefined) {
        extra.parityTrace = o.parityTrace;
    }
    return huntToSimulatorOpts(resolved, extra);
}

/**
 * Serializable prefs blob for IndexedDB.
 * @param {object} state
 * @returns {object}
 */
function collectPrefsState(state) {
    const s = state || {};
    return {
        seed: s.seed != null ? String(s.seed) : '42',
        speed: s.speed != null ? Number(s.speed) : 1,
        modeId: s.modeId || 'standard',
        huntId: s.huntId || 'cave_crawl_generated',
        partyId: s.partyId != null ? String(s.partyId) : 'starter_duo',
        members: Array.isArray(s.members)
            ? s.members.map((m, i) => normalizeMember(m, i))
            : partyFormFromParty(null).members
    };
}

/**
 * Merge stored prefs onto defaults (invalid values ignored).
 * @param {object|null} prefs
 * @param {object} defaults from collectPrefsState
 * @returns {object}
 */
function applyPrefsState(prefs, defaults) {
    const d = defaults || collectPrefsState({});
    if (!prefs || typeof prefs !== 'object') {
        return {
            seed: d.seed,
            speed: d.speed,
            modeId: d.modeId,
            huntId: d.huntId,
            partyId: d.partyId,
            members: d.members.map((m, i) => normalizeMember(m, i))
        };
    }
    let speed = d.speed;
    if (prefs.speed != null && Number.isFinite(Number(prefs.speed))) {
        speed = Math.max(0.25, Math.min(20, Number(prefs.speed)));
    }
    let seed = d.seed;
    if (prefs.seed != null && String(prefs.seed).trim() !== '') {
        seed = String(prefs.seed).trim();
    }
    const modeId =
        prefs.modeId && String(prefs.modeId).trim()
            ? String(prefs.modeId).trim()
            : d.modeId;
    const huntId =
        prefs.huntId && String(prefs.huntId).trim()
            ? String(prefs.huntId).trim()
            : d.huntId;
    const partyId =
        prefs.partyId && String(prefs.partyId).trim()
            ? String(prefs.partyId).trim()
            : d.partyId;

    let members = d.members;
    if (Array.isArray(prefs.members) && prefs.members.length) {
        members = [];
        for (let i = 0; i < MAX_PARTY_SLOTS; i++) {
            members.push(normalizeMember(prefs.members[i] || null, i));
        }
        ensureSingleLeader(members);
    }

    return { seed, speed, modeId, huntId, partyId, members };
}

module.exports = {
    MAX_PARTY_SLOTS,
    EDITOR_EQUIPMENT_SLOTS,
    EQUIPMENT_SLOTS,
    DEFAULT_STRATEGY_BY_CLASS,
    defaultStrategyForClass,
    defaultProfileIdForClass,
    emptyMember,
    normalizeMember,
    setPlayerProfileLoader,
    equipmentForEditor,
    partyFormFromParty,
    partyFormFromPartyId,
    partyFormFromHunt,
    leaderFormSlot,
    enabledMemberIndexForSlot,
    ensureSingleLeader,
    membersToPartyConfig,
    resolvedFromBrowserHunt,
    buildSimulatorOpts,
    collectPrefsState,
    applyPrefsState
};
