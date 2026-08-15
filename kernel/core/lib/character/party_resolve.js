/**
 * Resolve session parties from runner/UI config.
 *
 * Party roster lives in presets/<mode>/parties/ (members → player_profiles).
 * Hunts no longer embed parties; session selects partyId (+ optional enable/leader).
 *
 * Priority:
 *   1. config.parties (explicit bag, tests / overrides)
 *   2. config.members → single party
 *   3. config.partyId → loadParty
 *   4. hunt.defaultPartyId
 *   5. mode defaults.partyId
 *   6. 'starter_duo' then solo guardian fallback
 */

'use strict';

const {
    expandParties,
    materializeParties,
    assertPartyMembersHaveSkillSource
} = require('./player_profile.js');

/** Product default when mode has no defaults.partyId. */
const DEFAULT_PARTY_ID = 'starter_duo';

/**
 * @returns {{ loadParty?: Function, loadPlayerProfile?: Function, getDefaultPartyId?: Function }|null}
 */
function tryPresetsLoaders() {
    try {
        const presets = require('../presets.js');
        let getDefaultPartyId = null;
        try {
            const modes = require('../modes.js');
            getDefaultPartyId = () => {
                try {
                    const mode = modes.getActiveMode();
                    const id =
                        mode &&
                        mode.defaults &&
                        mode.defaults.partyId != null
                            ? String(mode.defaults.partyId)
                            : null;
                    return id || DEFAULT_PARTY_ID;
                } catch (_) {
                    return DEFAULT_PARTY_ID;
                }
            };
        } catch (_) {
            getDefaultPartyId = () => DEFAULT_PARTY_ID;
        }
        return {
            loadParty: presets.loadParty,
            loadPlayerProfile: presets.loadPlayerProfile,
            getDefaultPartyId
        };
    } catch (_) {
        return null;
    }
}

/**
 * Attach waypoints / stairLinks / loopWaypoints onto each party bag.
 * @param {object[]} parties
 * @param {object[]} [waypoints]
 * @param {object[]|null} [stairLinks]
 * @param {{ loopWaypoints?: boolean }|null} [routeOpts]
 * @returns {object[]}
 */
function attachRoute(parties, waypoints, stairLinks, routeOpts) {
    const wps = Array.isArray(waypoints) ? waypoints : [];
    const huntLoop = !!(routeOpts && routeOpts.loopWaypoints);
    return (Array.isArray(parties) ? parties : []).map((p) => {
        const existing = Array.isArray(p.waypoints) ? p.waypoints : null;
        const loop =
            p.loopWaypoints != null ? !!p.loopWaypoints : huntLoop;
        return Object.assign({}, p, {
            // Empty array is truthy — treat as missing so hunt route can fill in
            waypoints: existing && existing.length ? existing : wps,
            stairLinks: p.stairLinks || stairLinks || undefined,
            loopWaypoints: loop
        });
    });
}

/**
 * Expand a party preset id into a one-element parties array.
 * @param {string} partyId
 * @param {{ loadParty?: Function, loadPlayerProfile?: Function }} [loaders]
 * @returns {object[]|null}
 */
function partiesFromPartyId(partyId, loaders) {
    if (!partyId || typeof partyId !== 'string') return null;
    const L = loaders || tryPresetsLoaders() || {};
    if (typeof L.loadParty !== 'function') return null;
    try {
        const party = L.loadParty(partyId, {
            loadPlayerProfile: L.loadPlayerProfile
        });
        if (!party || typeof party !== 'object') return null;
        const members = Array.isArray(party.members) ? party.members : [];
        return [
            {
                name: party.label || party.name || party.id || partyId,
                id: party.id || partyId,
                members
            }
        ];
    } catch (_) {
        return null;
    }
}

/**
 * Resolve parties for a hunt session.
 *
 * @param {object} [config] runner / form input
 * @param {object} [opts]
 * @param {object} [opts.hunt] expanded hunt (optional defaultPartyId)
 * @param {object[]} [opts.waypoints]
 * @param {object[]|null} [opts.stairLinks]
 * @param {boolean} [opts.loopWaypoints] Arena patrol: wrap route after last wp
 * @param {{ loadParty?: Function, loadPlayerProfile?: Function, getDefaultPartyId?: Function }} [opts.loaders]
 * @returns {object[]}
 */
function resolveSessionParties(config, opts) {
    const cfg = config || {};
    const o = opts || {};
    const hunt = o.hunt || {};
    const loaders = o.loaders || tryPresetsLoaders() || {};
    const waypoints = o.waypoints;
    const stairLinks = o.stairLinks != null ? o.stairLinks : null;
    const loopWaypoints =
        o.loopWaypoints != null
            ? !!o.loopWaypoints
            : cfg.loopWaypoints != null
              ? !!cfg.loopWaypoints
              : !!hunt.loopWaypoints;

    /** @type {object[]|null} */
    let parties = null;

    if (Array.isArray(cfg.parties) && cfg.parties.length) {
        parties = cfg.parties.slice();
    } else if (Array.isArray(cfg.members) && cfg.members.length) {
        parties = [
            {
                name: cfg.partyName || 'HuntParty',
                id: cfg.partyId || 'hunt',
                members: cfg.members
            }
        ];
    } else {
        const partyId =
            cfg.partyId != null && String(cfg.partyId).trim() !== ''
                ? String(cfg.partyId).trim()
                : hunt.defaultPartyId != null &&
                    String(hunt.defaultPartyId).trim() !== ''
                  ? String(hunt.defaultPartyId).trim()
                  : typeof loaders.getDefaultPartyId === 'function'
                    ? loaders.getDefaultPartyId()
                    : DEFAULT_PARTY_ID;
        parties = partiesFromPartyId(partyId, loaders);
        // Last-chance: starter_duo then inline solo
        if (!parties && partyId !== DEFAULT_PARTY_ID) {
            parties = partiesFromPartyId(DEFAULT_PARTY_ID, loaders);
        }
    }

    if (!parties || !parties.length) {
        // Last-chance product fallback: profile-backed starter (not class floors)
        parties = [
            {
                name: 'HuntParty',
                id: 'hunt',
                members: [
                    {
                        name: 'Guardian',
                        profileId: 'guardian_starter',
                        isLeader: true
                    }
                ]
            }
        ];
    }

    parties = attachRoute(parties, waypoints, stairLinks, {
        loopWaypoints
    });

    if (cfg.storage && typeof cfg.storage === 'object' && !Array.isArray(cfg.storage)) {
        parties = parties.map((p) =>
            Object.assign({}, p, {
                storage: Object.assign(
                    {},
                    cfg.storage,
                    p.storage && typeof p.storage === 'object' ? p.storage : {}
                )
            })
        );
    }

    // Character-first: expand profileId, then auto-bind class starter profiles
    // for any remaining skill-less rows (create-char analog). Hard-fail only
    // when materialize cannot produce an authored skills bag (§7.2).
    try {
        parties = expandParties(parties, {
            loadPlayerProfile: loaders.loadPlayerProfile || undefined
        });
        parties = materializeParties(parties, {
            loadPlayerProfile: loaders.loadPlayerProfile || undefined,
            autoStarterProfile: true
        });
    } catch (_) {
        /* keep as-is */
    }

    // Product gate (§7.2): after materialize, every enabled member must have skills
    if (o.skipSkillSourceAssert !== true) {
        for (let pi = 0; pi < parties.length; pi++) {
            assertPartyMembersHaveSkillSource(parties[pi], {
                context: `resolveSessionParties party[${pi}]`
            });
        }
    }

    return parties;
}

module.exports = {
    DEFAULT_PARTY_ID,
    attachRoute,
    partiesFromPartyId,
    resolveSessionParties
};
