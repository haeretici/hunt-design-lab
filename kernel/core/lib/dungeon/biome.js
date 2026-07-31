/**
 * Stage 11.7 — Biome packs (logic first; art volume later).
 * Stage 11.8 — biome.floors multi-floor chains + artSet decorative pointer.
 *
 * A biome pack is a mode-local content bundle: piece pack + population +
 * marker rules + dungeon profile ids that share one biome id. Kernel code
 * stays mode-agnostic; manifests live under presets/<mode>/biomes/.
 *
 * Macro multi-floor chains: biome.floors[] lists profile ids / floor entries
 * linked by stair sockets. artSet binds decorative tile catalogs later.
 */

'use strict';

const { normalizeFloorChain } = require('./layout/multifloor.js');

/**
 * @param {*} v
 * @returns {string|null}
 */
function normalizeBiomeId(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    return s || null;
}

/**
 * Decorative art set id (genre tile catalog pointer). Soft — no assets required.
 * Lowercased like biome ids so pack lookup stays stable.
 * @param {*} v
 * @returns {string|null}
 */
function normalizeArtSet(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim().toLowerCase();
    return s || null;
}

/**
 * Normalize a biome pack manifest (file or inline).
 * @param {object|null|undefined} raw
 * @returns {object|null}
 */
function normalizeBiomePack(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = normalizeBiomeId(raw.id != null ? raw.id : raw.biome);
    if (!id) return null;

    const piecePack =
        raw.piecePack != null
            ? String(raw.piecePack)
            : raw.piecePackId != null
              ? String(raw.piecePackId)
              : null;
    const populationId =
        raw.populationId != null
            ? String(raw.populationId)
            : raw.population != null && typeof raw.population === 'string'
              ? String(raw.population)
              : null;
    const markersId =
        raw.markersId != null
            ? String(raw.markersId)
            : raw.markerRules != null && typeof raw.markerRules === 'string'
              ? String(raw.markerRules)
              : null;

    /** @type {string[]} */
    let profiles = [];
    /** @type {string[]} */
    let proceduralProfiles = [];
    /** @type {string[]} */
    let fixedProfiles = [];

    if (Array.isArray(raw.profiles)) {
        profiles = raw.profiles.map((p) => String(p)).filter(Boolean);
    } else if (raw.profiles && typeof raw.profiles === 'object') {
        const pr = raw.profiles;
        if (Array.isArray(pr.procedural)) {
            proceduralProfiles = pr.procedural.map((p) => String(p)).filter(Boolean);
        }
        if (Array.isArray(pr.fixed)) {
            fixedProfiles = pr.fixed.map((p) => String(p)).filter(Boolean);
        }
        if (Array.isArray(pr.all)) {
            profiles = pr.all.map((p) => String(p)).filter(Boolean);
        }
    }

    if (!profiles.length) {
        profiles = proceduralProfiles.concat(fixedProfiles);
    }
    // Dedupe preserve order
    const seen = Object.create(null);
    const allProfiles = [];
    for (let i = 0; i < profiles.length; i++) {
        const p = profiles[i];
        if (seen[p]) continue;
        seen[p] = true;
        allProfiles.push(p);
    }
    for (let i = 0; i < proceduralProfiles.length; i++) {
        const p = proceduralProfiles[i];
        if (seen[p]) continue;
        seen[p] = true;
        allProfiles.push(p);
    }
    for (let i = 0; i < fixedProfiles.length; i++) {
        const p = fixedProfiles[i];
        if (seen[p]) continue;
        seen[p] = true;
        allProfiles.push(p);
    }

    return {
        id,
        label: raw.label != null ? String(raw.label) : id,
        notes: raw.notes != null ? String(raw.notes) : null,
        piecePack,
        populationId,
        markersId,
        profiles: allProfiles,
        proceduralProfiles:
            proceduralProfiles.length > 0
                ? proceduralProfiles
                : allProfiles.slice(),
        fixedProfiles: fixedProfiles.slice(),
        // Stage 11.8: multi-floor chain (profile graph / stair sockets)
        floors: normalizeFloorChain(raw.floors),
        // Decorative tile set pointer (art volume binds later; pack collectRefs-safe)
        artSet: normalizeArtSet(
            raw.artSet != null
                ? raw.artSet
                : raw.art_set != null
                  ? raw.art_set
                  : null
        )
    };
}

/**
 * Soft consistency checks between biome id and loaded content.
 * Does not throw — returns { ok, warnings[], errors[] }.
 *
 * @param {{
 *   biomeId?: string|null,
 *   piecePack?: object|null,
 *   population?: object|null,
 *   profile?: object|null,
 *   markers?: object|null,
 *   manifest?: object|null
 * }} parts
 * @returns {{ ok: boolean, warnings: string[], errors: string[] }}
 */
function validateBiomeConsistency(parts) {
    const p = parts || {};
    /** @type {string[]} */
    const warnings = [];
    /** @type {string[]} */
    const errors = [];

    const expected =
        normalizeBiomeId(p.biomeId) ||
        (p.manifest && p.manifest.id) ||
        null;

    if (p.manifest && !p.manifest.piecePack) {
        errors.push('biome_manifest_missing_piecePack');
    }
    if (p.manifest && !p.manifest.populationId) {
        warnings.push('biome_manifest_missing_populationId');
    }

    if (expected && p.piecePack) {
        const pb = normalizeBiomeId(p.piecePack.biome);
        if (pb && pb !== expected) {
            // Stage 11.10: logic pieces may be shared across biomes (art/pop differ).
            // Demote to warning so crypt can reuse cave_v1 friction prefabs.
            warnings.push(
                `piece_pack_biome_mismatch: pack=${pb} expected=${expected}`
            );
        } else if (!pb) {
            warnings.push('piece_pack_missing_biome');
        }
    }

    if (expected && p.population) {
        const popB = normalizeBiomeId(p.population.biome);
        if (popB && popB !== expected) {
            errors.push(
                `population_biome_mismatch: pop=${popB} expected=${expected}`
            );
        } else if (!popB) {
            warnings.push('population_missing_biome');
        }
    }

    if (expected && p.profile) {
        const prB = normalizeBiomeId(p.profile.biome);
        if (prB && prB !== expected) {
            errors.push(
                `profile_biome_mismatch: profile=${prB} expected=${expected}`
            );
        } else if (!prB) {
            warnings.push('profile_missing_biome');
        }
        if (
            p.manifest &&
            p.manifest.piecePack &&
            p.profile.piecePack &&
            String(p.profile.piecePack) !== String(p.manifest.piecePack)
        ) {
            warnings.push(
                `profile_piecePack_differs: profile=${p.profile.piecePack} manifest=${p.manifest.piecePack}`
            );
        }
    }

    if (expected && p.markers) {
        const mB = normalizeBiomeId(p.markers.biome);
        if (mB && mB !== expected) {
            errors.push(
                `markers_biome_mismatch: markers=${mB} expected=${expected}`
            );
        }
    }

    // Multi-floor chain: each entry should resolve a profileId (soft)
    if (p.manifest && Array.isArray(p.manifest.floors)) {
        for (let i = 0; i < p.manifest.floors.length; i++) {
            const f = p.manifest.floors[i];
            if (!f) continue;
            if (!f.profileId && !f.profile) {
                warnings.push(`biome_floor_missing_profile:${i}`);
            }
        }
        if (p.manifest.floors.length === 1) {
            warnings.push('biome_floors_single_entry');
        }
    }

    // artSet is optional decorative binding — warn only if explicitly empty string was normalized away already
    if (p.manifest && p.manifest.artSet === '') {
        warnings.push('biome_artSet_empty');
    }

    return {
        ok: errors.length === 0,
        warnings,
        errors
    };
}

/**
 * Resolve a biome pack from a manifest + loaders (mode already active).
 *
 * @param {string|object} biomeIdOrManifest biome id or raw manifest
 * @param {{
 *   loadBiomePack?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   loadPopulation?: (id: string) => object,
 *   loadMarkers?: (id: string) => object,
 *   loadDungeonProfile?: (id: string) => object,
 *   normalizePiecePack?: (raw: object) => object|null,
 *   normalizePopulation?: (raw: object) => object|null,
 *   normalizeMarkerRules?: (raw: object) => object|null,
 *   normalizeDungeonProfile?: (raw: object) => object|null,
 *   normalizeFixedProfile?: (raw: object) => object|null
 * }} [loaders]
 * @returns {{
 *   ok: boolean,
 *   biome: object|null,
 *   piecePack: object|null,
 *   population: object|null,
 *   markers: object|null,
 *   profiles: Record<string, object>,
 *   consistency: { ok: boolean, warnings: string[], errors: string[] },
 *   error?: string
 * }}
 */
function resolveBiomePack(biomeIdOrManifest, loaders) {
    const L = loaders || {};
    let manifestRaw = null;
    if (biomeIdOrManifest && typeof biomeIdOrManifest === 'object') {
        manifestRaw = biomeIdOrManifest;
    } else if (typeof biomeIdOrManifest === 'string' && L.loadBiomePack) {
        try {
            manifestRaw = L.loadBiomePack(biomeIdOrManifest);
        } catch (e) {
            return {
                ok: false,
                biome: null,
                piecePack: null,
                population: null,
                markers: null,
                profiles: Object.create(null),
                consistency: { ok: false, warnings: [], errors: ['load_failed'] },
                error: e && e.message ? e.message : String(e)
            };
        }
    }

    const biome = normalizeBiomePack(manifestRaw);
    if (!biome) {
        return {
            ok: false,
            biome: null,
            piecePack: null,
            population: null,
            markers: null,
            profiles: Object.create(null),
            consistency: {
                ok: false,
                warnings: [],
                errors: ['invalid_manifest']
            },
            error: 'invalid_manifest'
        };
    }

    let piecePack = null;
    if (biome.piecePack && typeof L.loadPiecePack === 'function') {
        const raw = L.loadPiecePack(biome.piecePack);
        piecePack =
            typeof L.normalizePiecePack === 'function'
                ? L.normalizePiecePack(raw)
                : raw;
    }

    let population = null;
    if (biome.populationId && typeof L.loadPopulation === 'function') {
        const raw = L.loadPopulation(biome.populationId);
        population =
            typeof L.normalizePopulation === 'function'
                ? L.normalizePopulation(raw)
                : raw;
    }

    let markers = null;
    if (biome.markersId && typeof L.loadMarkers === 'function') {
        const raw = L.loadMarkers(biome.markersId);
        markers =
            typeof L.normalizeMarkerRules === 'function'
                ? L.normalizeMarkerRules(raw)
                : raw;
    }

    /** @type {Record<string, object>} */
    const profiles = Object.create(null);
    if (typeof L.loadDungeonProfile === 'function') {
        for (let i = 0; i < biome.profiles.length; i++) {
            const pid = biome.profiles[i];
            try {
                const raw = L.loadDungeonProfile(pid);
                let norm = raw;
                if (raw && typeof raw === 'object') {
                    const t = String(raw.type || raw.kind || '').toLowerCase();
                    const isFixed =
                        t === 'fixed' ||
                        t === 'fixed_cutout' ||
                        t === 'fixed+cutouts' ||
                        t === 'cutout' ||
                        t === 'cutouts' ||
                        Array.isArray(raw.placements) ||
                        Array.isArray(raw.cutouts);
                    if (isFixed && typeof L.normalizeFixedProfile === 'function') {
                        norm = L.normalizeFixedProfile(raw);
                    } else if (typeof L.normalizeDungeonProfile === 'function') {
                        norm = L.normalizeDungeonProfile(raw);
                    }
                }
                if (norm) profiles[pid] = norm;
            } catch (_e) {
                /* profile missing — recorded in consistency via empty */
            }
        }
    }

    const consistency = validateBiomeConsistency({
        biomeId: biome.id,
        manifest: biome,
        piecePack,
        population,
        markers,
        profile: biome.profiles.length ? profiles[biome.profiles[0]] : null
    });

    // Missing declared profiles are errors
    for (let i = 0; i < biome.profiles.length; i++) {
        const pid = biome.profiles[i];
        if (!profiles[pid]) {
            consistency.errors.push(`profile_missing:${pid}`);
            consistency.ok = false;
        }
    }
    if (!piecePack) {
        consistency.errors.push('piece_pack_unresolved');
        consistency.ok = false;
    }

    return {
        ok: consistency.ok,
        biome,
        piecePack,
        population,
        markers,
        profiles,
        consistency
    };
}

/**
 * Collect biome ids from piece packs (by pack.biome field).
 * @param {object[]} packs normalized or raw packs with .biome
 * @returns {string[]}
 */
function listBiomeIdsFromPacks(packs) {
    const seen = Object.create(null);
    /** @type {string[]} */
    const out = [];
    const list = Array.isArray(packs) ? packs : [];
    for (let i = 0; i < list.length; i++) {
        const b = normalizeBiomeId(list[i] && list[i].biome);
        if (!b || seen[b]) continue;
        seen[b] = true;
        out.push(b);
    }
    return out.sort();
}

module.exports = {
    normalizeBiomeId,
    normalizeArtSet,
    normalizeBiomePack,
    validateBiomeConsistency,
    resolveBiomePack,
    listBiomeIdsFromPacks
};
