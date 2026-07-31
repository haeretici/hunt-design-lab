/**
 * Stage 11.10 — Macro 15‑min multi-biome transitions.
 *
 * Chain distinct biome packs / art sets over a session so the player hits a
 * major art-set or monster-biome change on a ~15‑minute macro cadence.
 *
 * Segments expand into multifloor floors (11.8) with per-floor biomeId,
 * artSet, populationId, piecePack, markersId. Decorative binding stays on
 * art.js (per-floor artSet from floorMeta). Population resolves per floor
 * when floorMeta carries distinct population ids.
 *
 * Output still speaks TileMap / SpawnManager — no second map runtime.
 */

'use strict';

const { normalizeBiomeId, normalizeArtSet } = require('../biome.js');
const {
    normalizeFloorChain,
    normalizeFloorEntry,
    generateMultiFloorLayout,
    applyMultiFloorToHunt
} = require('./multifloor.js');

/** Default macro segment target: 15 minutes of sim time (design intent). */
const DEFAULT_TARGET_SEGMENT_SEC = 15 * 60;

/**
 * Normalize one macro segment (biome stretch).
 * Accepts:
 *   string biome id
 *   { biomeId, floors?, targetMinSec?, artSet?, populationId?, … }
 *
 * @param {*} raw
 * @param {number} index
 * @returns {object|null}
 */
function normalizeMacroSegment(raw, index) {
    if (raw == null || raw === '') return null;

    if (typeof raw === 'string' || typeof raw === 'number') {
        const id = normalizeBiomeId(raw);
        if (!id) return null;
        return {
            index,
            biomeId: id,
            label: id,
            targetMinSec: DEFAULT_TARGET_SEGMENT_SEC,
            floors: null,
            profileId: null,
            piecePack: null,
            populationId: null,
            markersId: null,
            artSet: null,
            role: null
        };
    }
    if (typeof raw !== 'object') return null;

    const biomeId = normalizeBiomeId(
        raw.biomeId != null
            ? raw.biomeId
            : raw.biome != null
              ? raw.biome
              : raw.id
    );

    let targetMinSec = DEFAULT_TARGET_SEGMENT_SEC;
    if (raw.targetMinSec != null && Number.isFinite(Number(raw.targetMinSec))) {
        targetMinSec = Math.max(0, Number(raw.targetMinSec));
    } else if (
        raw.targetSec != null &&
        Number.isFinite(Number(raw.targetSec))
    ) {
        targetMinSec = Math.max(0, Number(raw.targetSec));
    } else if (
        raw.durationSec != null &&
        Number.isFinite(Number(raw.durationSec))
    ) {
        targetMinSec = Math.max(0, Number(raw.durationSec));
    }

    let floors = null;
    if (Array.isArray(raw.floors) && raw.floors.length) {
        floors = normalizeFloorChain(raw.floors);
    }

    return {
        index,
        biomeId,
        label:
            raw.label != null
                ? String(raw.label)
                : biomeId || `segment_${index}`,
        targetMinSec,
        floors,
        profileId:
            raw.profileId != null
                ? String(raw.profileId)
                : raw.profile != null && typeof raw.profile === 'string'
                  ? String(raw.profile)
                  : null,
        piecePack:
            raw.piecePack != null
                ? String(raw.piecePack)
                : raw.piecePackId != null
                  ? String(raw.piecePackId)
                  : null,
        populationId:
            raw.populationId != null
                ? String(raw.populationId)
                : raw.population != null && typeof raw.population === 'string'
                  ? String(raw.population)
                  : null,
        markersId:
            raw.markersId != null
                ? String(raw.markersId)
                : raw.markerRules != null && typeof raw.markerRules === 'string'
                  ? String(raw.markerRules)
                  : null,
        artSet: normalizeArtSet(
            raw.artSet != null
                ? raw.artSet
                : raw.art_set != null
                  ? raw.art_set
                  : null
        ),
        role: raw.role != null ? String(raw.role) : null
    };
}

/**
 * Normalize segments[] array.
 * @param {*} raw
 * @returns {object[]|null}
 */
function normalizeMacroSegments(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    /** @type {object[]} */
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        const s = normalizeMacroSegment(raw[i], i);
        if (s) out.push(s);
    }
    return out.length ? out : null;
}

/**
 * Infer macro segments from a flat multifloor chain when floors carry
 * distinct biomeId / artSet values (no explicit segments[]).
 *
 * @param {object[]} floorEntries normalized floor entries
 * @returns {object[]|null}
 */
function segmentsFromFloorMeta(floorEntries) {
    if (!Array.isArray(floorEntries) || !floorEntries.length) return null;
    /** @type {object[]} */
    const segs = [];
    let cur = null;
    for (let i = 0; i < floorEntries.length; i++) {
        const f = floorEntries[i];
        if (!f) continue;
        const biomeId = normalizeBiomeId(f.biomeId);
        const artSet = normalizeArtSet(f.artSet);
        const key = `${biomeId || ''}|${artSet || ''}|${f.populationId || ''}`;
        if (!cur || cur._key !== key) {
            cur = {
                index: segs.length,
                biomeId,
                artSet,
                populationId: f.populationId || null,
                markersId: f.markersId || null,
                piecePack: f.piecePack || null,
                label: biomeId || artSet || `segment_${segs.length}`,
                targetMinSec: DEFAULT_TARGET_SEGMENT_SEC,
                floors: [],
                _key: key,
                floorZs: []
            };
            segs.push(cur);
        }
        cur.floors.push(f);
        cur.floorZs.push(f.z);
    }
    // Drop internal key
    for (let i = 0; i < segs.length; i++) {
        delete segs[i]._key;
    }
    return segs.length >= 2 ? segs : segs.length === 1 ? segs : null;
}

/**
 * Expand segments into a flat floor chain, filling defaults from biome packs.
 *
 * @param {object[]} segments normalizeMacroSegments result
 * @param {{
 *   loadBiomePack?: (id: string) => object
 * }} [loaders]
 * @returns {{ floors: object[], segments: object[], transitions: object[] }}
 */
function expandSegmentsToFloors(segments, loaders) {
    const L = loaders || {};
    /** @type {object[]} */
    const floors = [];
    /** @type {object[]} */
    const expandedSegs = [];
    /** @type {object[]} */
    const transitions = [];
    let zCursor = 0;

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        let biomeRaw = null;
        if (seg.biomeId && typeof L.loadBiomePack === 'function') {
            try {
                biomeRaw = L.loadBiomePack(seg.biomeId);
            } catch (_e) {
                biomeRaw = null;
            }
        }

        const piecePack =
            seg.piecePack ||
            (biomeRaw && biomeRaw.piecePack) ||
            null;
        const populationId =
            seg.populationId ||
            (biomeRaw && biomeRaw.populationId) ||
            null;
        const markersId =
            seg.markersId ||
            (biomeRaw && biomeRaw.markersId) ||
            null;
        const artSet =
            seg.artSet ||
            (biomeRaw && biomeRaw.artSet
                ? normalizeArtSet(biomeRaw.artSet)
                : null) ||
            (seg.biomeId ? normalizeArtSet(seg.biomeId) : null);

        // Floors: segment.floors, else biome.floors, else single profileId, else small_crawl
        let floorRawList = null;
        if (seg.floors && seg.floors.length) {
            floorRawList = seg.floors;
        } else if (
            biomeRaw &&
            Array.isArray(biomeRaw.floors) &&
            biomeRaw.floors.length
        ) {
            floorRawList = biomeRaw.floors;
        } else if (seg.profileId) {
            floorRawList = [seg.profileId];
        } else if (
            biomeRaw &&
            Array.isArray(biomeRaw.profiles) &&
            biomeRaw.profiles.length
        ) {
            floorRawList = [biomeRaw.profiles[0]];
        } else if (
            biomeRaw &&
            biomeRaw.profiles &&
            typeof biomeRaw.profiles === 'object' &&
            Array.isArray(biomeRaw.profiles.procedural) &&
            biomeRaw.profiles.procedural.length
        ) {
            floorRawList = [biomeRaw.profiles.procedural[0]];
        } else {
            floorRawList = ['small_crawl'];
        }

        const startZ = zCursor;
        /** @type {number[]} */
        const floorZs = [];
        const chain = normalizeFloorChain(floorRawList) || [];

        for (let f = 0; f < chain.length; f++) {
            const entry = chain[f];
            // Reassign sequential z across segments
            entry.z = zCursor;
            if (!entry.biomeId) entry.biomeId = seg.biomeId;
            if (!entry.artSet && artSet) entry.artSet = artSet;
            if (!entry.piecePack && piecePack) entry.piecePack = piecePack;
            if (!entry.populationId && populationId) {
                entry.populationId = populationId;
            }
            if (!entry.markersId && markersId) entry.markersId = markersId;
            if (!entry.role && seg.role) entry.role = seg.role;
            // First floor of a new segment (after first) is a macro transition pad
            if (i > 0 && f === 0) {
                entry.role = entry.role || 'biome_transition';
                entry.macroTransition = true;
            }
            floors.push(entry);
            floorZs.push(zCursor);
            zCursor += 1;
        }

        const exp = {
            index: i,
            biomeId: seg.biomeId,
            label: seg.label,
            targetMinSec: seg.targetMinSec,
            artSet,
            populationId,
            markersId,
            piecePack,
            startZ,
            endZ: zCursor - 1,
            floorCount: chain.length,
            floorZs
        };
        expandedSegs.push(exp);

        if (i > 0) {
            const prev = expandedSegs[i - 1];
            transitions.push({
                fromSegment: i - 1,
                toSegment: i,
                fromBiomeId: prev.biomeId,
                toBiomeId: exp.biomeId,
                fromArtSet: prev.artSet,
                toArtSet: exp.artSet,
                fromZ: prev.endZ,
                toZ: exp.startZ,
                targetMinSec: prev.targetMinSec
            });
        }
    }

    return { floors, segments: expandedSegs, transitions };
}

/**
 * Enrich a flat floor chain: when a floor has biomeId, fill missing
 * piecePack / artSet / populationId / markersId from the biome pack.
 *
 * @param {object[]} floors
 * @param {{ loadBiomePack?: (id: string) => object }} [loaders]
 * @returns {object[]}
 */
function applyBiomeDefaultsToFloors(floors, loaders) {
    const L = loaders || {};
    if (!Array.isArray(floors)) return floors;
    /** @type {Record<string, object|null>} */
    const cache = Object.create(null);

    function biomeOf(id) {
        if (!id || typeof L.loadBiomePack !== 'function') return null;
        if (Object.prototype.hasOwnProperty.call(cache, id)) return cache[id];
        try {
            cache[id] = L.loadBiomePack(id);
        } catch (_e) {
            cache[id] = null;
        }
        return cache[id];
    }

    for (let i = 0; i < floors.length; i++) {
        const e = floors[i];
        if (!e) continue;
        // Ensure biomeId field exists on entry (normalizeFloorEntry may add it)
        if (e.biomeId == null && e.biome != null) {
            e.biomeId = normalizeBiomeId(e.biome);
        }
        const b = e.biomeId ? biomeOf(String(e.biomeId)) : null;
        if (!b) {
            // Convention: artSet often matches biomeId
            if (!e.artSet && e.biomeId) e.artSet = normalizeArtSet(e.biomeId);
            continue;
        }
        if (!e.piecePack && b.piecePack) e.piecePack = String(b.piecePack);
        if (!e.populationId && b.populationId) {
            e.populationId = String(b.populationId);
        }
        if (!e.markersId && b.markersId) e.markersId = String(b.markersId);
        if (!e.artSet) {
            e.artSet = b.artSet
                ? normalizeArtSet(b.artSet)
                : normalizeArtSet(e.biomeId);
        }
    }
    return floors;
}

/**
 * Build layoutMeta.macro summary for pacing + consumers.
 *
 * @param {object[]} segments expanded segments
 * @param {object[]} transitions
 * @returns {object}
 */
function buildMacroMeta(segments, transitions) {
    const segs = Array.isArray(segments) ? segments : [];
    const trans = Array.isArray(transitions) ? transitions : [];
    const biomeIds = [];
    const artSets = [];
    const seenB = Object.create(null);
    const seenA = Object.create(null);
    let totalTargetSec = 0;
    for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        totalTargetSec += Number(s.targetMinSec) || 0;
        if (s.biomeId && !seenB[s.biomeId]) {
            seenB[s.biomeId] = true;
            biomeIds.push(s.biomeId);
        }
        if (s.artSet && !seenA[s.artSet]) {
            seenA[s.artSet] = true;
            artSets.push(s.artSet);
        }
    }
    return {
        type: 'multi_biome',
        segmentCount: segs.length,
        transitionCount: trans.length,
        biomeIds,
        artSets,
        totalTargetSec,
        targetSegmentSec: DEFAULT_TARGET_SEGMENT_SEC,
        segments: segs.map((s) => ({
            index: s.index,
            biomeId: s.biomeId,
            label: s.label,
            artSet: s.artSet,
            populationId: s.populationId,
            markersId: s.markersId,
            piecePack: s.piecePack,
            targetMinSec: s.targetMinSec,
            startZ: s.startZ,
            endZ: s.endZ,
            floorCount: s.floorCount,
            floorZs: (s.floorZs || []).slice()
        })),
        transitions: trans.map((t) => ({
            fromSegment: t.fromSegment,
            toSegment: t.toSegment,
            fromBiomeId: t.fromBiomeId,
            toBiomeId: t.toBiomeId,
            fromArtSet: t.fromArtSet,
            toArtSet: t.toArtSet,
            fromZ: t.fromZ,
            toZ: t.toZ,
            targetMinSec: t.targetMinSec
        }))
    };
}

/**
 * Generate multi-biome layout: expand segments → multifloor generate.
 *
 * @param {{
 *   segments?: object[],
 *   floors?: object[],
 *   seed?: number,
 *   loadDungeonProfile?: (id: string) => object,
 *   loadPiecePack?: (id: string) => object,
 *   normalizePiecePack?: (raw: object) => object|null,
 *   loadPopulation?: (id: string) => object,
 *   loadBiomePack?: (id: string) => object,
 *   defaultPiecePack?: string|null,
 *   defaultArtSet?: string|null
 * }} opts
 * @returns {object}
 */
function generateMultiBiomeLayout(opts) {
    const o = opts || {};
    const seed = o.seed != null ? o.seed >>> 0 || 1 : 1;

    let segments = normalizeMacroSegments(o.segments);
    let floorsRaw = null;
    /** @type {object[]} */
    let transitions = [];
    /** @type {object[]} */
    let expandedSegs = [];

    if (segments && segments.length) {
        const exp = expandSegmentsToFloors(segments, {
            loadBiomePack: o.loadBiomePack
        });
        floorsRaw = exp.floors;
        expandedSegs = exp.segments;
        transitions = exp.transitions;
    } else if (Array.isArray(o.floors) && o.floors.length) {
        floorsRaw = applyBiomeDefaultsToFloors(
            normalizeFloorChain(o.floors) || [],
            { loadBiomePack: o.loadBiomePack }
        );
        const inferred = segmentsFromFloorMeta(floorsRaw);
        if (inferred) {
            expandedSegs = inferred.map((s, i) => ({
                index: i,
                biomeId: s.biomeId,
                label: s.label,
                targetMinSec: s.targetMinSec,
                artSet: s.artSet,
                populationId: s.populationId,
                markersId: s.markersId,
                piecePack: s.piecePack,
                startZ: s.floorZs[0],
                endZ: s.floorZs[s.floorZs.length - 1],
                floorCount: s.floors.length,
                floorZs: s.floorZs.slice()
            }));
            for (let i = 1; i < expandedSegs.length; i++) {
                const prev = expandedSegs[i - 1];
                const cur = expandedSegs[i];
                transitions.push({
                    fromSegment: i - 1,
                    toSegment: i,
                    fromBiomeId: prev.biomeId,
                    toBiomeId: cur.biomeId,
                    fromArtSet: prev.artSet,
                    toArtSet: cur.artSet,
                    fromZ: prev.endZ,
                    toZ: cur.startZ,
                    targetMinSec: prev.targetMinSec
                });
            }
        }
    }

    if (!floorsRaw || !floorsRaw.length) {
        return {
            ok: false,
            seed,
            error: {
                code: 'invalid_macro',
                message:
                    'Multi-biome layout needs segments[] (≥1) or floors[] with biome/art pointers'
            }
        };
    }

    // Ensure biome defaults on every floor
    floorsRaw = applyBiomeDefaultsToFloors(floorsRaw, {
        loadBiomePack: o.loadBiomePack
    });

    const gen = generateMultiFloorLayout({
        floors: floorsRaw,
        seed,
        loadDungeonProfile: o.loadDungeonProfile,
        loadPiecePack: o.loadPiecePack,
        normalizePiecePack: o.normalizePiecePack,
        loadPopulation: o.loadPopulation,
        defaultPiecePack: o.defaultPiecePack,
        defaultArtSet: o.defaultArtSet
    });

    if (!gen.ok) return gen;

    // Enrich floorMeta with biome pointers from the expanded chain
    if (Array.isArray(gen.floorMeta)) {
        for (let i = 0; i < gen.floorMeta.length; i++) {
            const fm = gen.floorMeta[i];
            const src = floorsRaw[i];
            if (!fm || !src) continue;
            if (src.biomeId != null) fm.biomeId = src.biomeId;
            if (src.populationId != null) fm.populationId = src.populationId;
            if (src.markersId != null) fm.markersId = src.markersId;
            if (src.artSet != null) fm.artSet = src.artSet;
            if (src.piecePack != null) fm.piecePack = src.piecePack;
            if (src.macroTransition) fm.macroTransition = true;
            if (src.role != null) fm.role = src.role;
        }
    }

    // If segments were not built (single-biome multifloor), synthesize one
    if (!expandedSegs.length && gen.floorMeta && gen.floorMeta.length) {
        const inferred = segmentsFromFloorMeta(
            gen.floorMeta.map((fm) => ({
                z: fm.z,
                biomeId: fm.biomeId,
                artSet: fm.artSet,
                populationId: fm.populationId,
                markersId: fm.markersId,
                piecePack: fm.piecePack
            }))
        );
        if (inferred) {
            expandedSegs = inferred.map((s, i) => ({
                index: i,
                biomeId: s.biomeId,
                label: s.label,
                targetMinSec: s.targetMinSec,
                artSet: s.artSet,
                populationId: s.populationId,
                markersId: s.markersId,
                piecePack: s.piecePack,
                startZ: s.floorZs[0],
                endZ: s.floorZs[s.floorZs.length - 1],
                floorCount: s.floors.length,
                floorZs: s.floorZs.slice()
            }));
            transitions = [];
            for (let i = 1; i < expandedSegs.length; i++) {
                const prev = expandedSegs[i - 1];
                const cur = expandedSegs[i];
                transitions.push({
                    fromSegment: i - 1,
                    toSegment: i,
                    fromBiomeId: prev.biomeId,
                    toBiomeId: cur.biomeId,
                    fromArtSet: prev.artSet,
                    toArtSet: cur.artSet,
                    fromZ: prev.endZ,
                    toZ: cur.startZ,
                    targetMinSec: prev.targetMinSec
                });
            }
        }
    }

    const macro = buildMacroMeta(expandedSegs, transitions);

    return Object.assign({}, gen, {
        type: 'multi_biome',
        macro,
        meta: Object.assign({}, gen.meta || {}, {
            type: 'multi_biome',
            macroSegmentCount: macro.segmentCount,
            macroTransitionCount: macro.transitionCount,
            biomeIds: macro.biomeIds.slice(),
            artSets: macro.artSets.slice()
        })
    });
}

/**
 * Apply multi-biome gen onto a hunt (delegates multifloor apply + macro meta).
 *
 * @param {object} hunt
 * @param {object} gen generateMultiBiomeLayout result
 * @param {number} seed
 * @param {object} [chainMeta]
 * @returns {object}
 */
function applyMultiBiomeToHunt(hunt, gen, seed, chainMeta) {
    const cm = chainMeta || {};
    const out = applyMultiFloorToHunt(hunt, gen, seed, cm);

    // Prefer first segment content when hunt omits population/markers
    if (gen.macro && gen.macro.segments && gen.macro.segments.length) {
        const first = gen.macro.segments[0];
        if (!out.populationId && !out.population && first.populationId) {
            out.populationId = first.populationId;
        }
        if (
            !out.markersId &&
            !out.markerRules &&
            !out.markers &&
            first.markersId
        ) {
            out.markersId = first.markersId;
        }
        if (!out.artSet && first.artSet) {
            out.artSet = first.artSet;
        }
        if (!out.biomeId && first.biomeId) {
            out.biomeId = first.biomeId;
        }
    }

    out.layoutMeta = Object.assign({}, out.layoutMeta || {}, {
        type: 'multi_biome',
        reason: 'ok',
        seed,
        macro: gen.macro || null,
        // Keep multifloor fields
        floorCount: gen.floors && gen.floors.length,
        floors: gen.floors ? gen.floors.slice() : undefined,
        floorMeta: gen.floorMeta,
        stairLinkCount: (gen.stairLinks && gen.stairLinks.length) || 0,
        pieceCount: gen.meta && gen.meta.pieceCount,
        artSet:
            cm.artSet ||
            (gen.macro &&
                gen.macro.segments &&
                gen.macro.segments[0] &&
                gen.macro.segments[0].artSet) ||
            null,
        biomeIds: gen.macro ? gen.macro.biomeIds.slice() : [],
        artSets: gen.macro ? gen.macro.artSets.slice() : []
    });

    // Per-floor population map for resolveHuntPopulationDefs
    if (gen.floorMeta && gen.floorMeta.length) {
        /** @type {Record<string, string>} */
        const byZ = Object.create(null);
        let multi = false;
        let firstPop = null;
        for (let i = 0; i < gen.floorMeta.length; i++) {
            const fm = gen.floorMeta[i];
            if (!fm || !fm.populationId) continue;
            byZ[String(fm.z)] = String(fm.populationId);
            if (firstPop == null) firstPop = String(fm.populationId);
            else if (String(fm.populationId) !== firstPop) multi = true;
        }
        if (Object.keys(byZ).length) {
            out.populationByFloor = byZ;
            if (multi) out.multiBiomePopulation = true;
        }
        /** @type {Record<string, string>} */
        const markersByZ = Object.create(null);
        let multiM = false;
        let firstM = null;
        for (let i = 0; i < gen.floorMeta.length; i++) {
            const fm = gen.floorMeta[i];
            if (!fm || !fm.markersId) continue;
            markersByZ[String(fm.z)] = String(fm.markersId);
            if (firstM == null) firstM = String(fm.markersId);
            else if (String(fm.markersId) !== firstM) multiM = true;
        }
        if (Object.keys(markersByZ).length) {
            out.markersByFloor = markersByZ;
            if (multiM) out.multiBiomeMarkers = true;
        }
    }

    return out;
}

/**
 * Expand hunt.layout multi_biome → floorLayers + macro meta.
 *
 * @param {object} hunt
 * @param {object} [opts]
 * @returns {object}
 */
function resolveMultiBiomeHuntLayout(hunt, opts) {
    if (!hunt || typeof hunt !== 'object') return hunt;
    const layout = hunt.layout;
    if (!layout || typeof layout !== 'object') return hunt;

    if (
        hunt.layoutMeta &&
        hunt.layoutMeta.reason === 'ok' &&
        hunt.layoutMeta.type === 'multi_biome' &&
        hunt.floorLayers
    ) {
        return hunt;
    }

    const o = opts || {};
    const seed =
        o.seed != null
            ? o.seed >>> 0 || 1
            : hunt.seed != null
              ? hunt.seed >>> 0 || 1
              : 1;

    let segmentsRaw =
        Array.isArray(layout.segments) && layout.segments.length
            ? layout.segments
            : Array.isArray(hunt.macroSegments) && hunt.macroSegments.length
              ? hunt.macroSegments
              : null;

    let floorsRaw =
        Array.isArray(layout.floors) && layout.floors.length
            ? layout.floors
            : null;

    // biomeIds: ["cave","crypt"] shorthand → segments
    if (
        !segmentsRaw &&
        Array.isArray(layout.biomeIds) &&
        layout.biomeIds.length
    ) {
        segmentsRaw = layout.biomeIds.map((id) => ({ biomeId: id }));
    }
    if (
        !segmentsRaw &&
        Array.isArray(layout.biomes) &&
        layout.biomes.length
    ) {
        segmentsRaw = layout.biomes;
    }

    if (!segmentsRaw && !floorsRaw) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = 'missing_segments';
        out.layoutError = {
            code: 'missing_segments',
            message:
                'Multi-biome layout needs layout.segments[] or floors[] with biome pointers'
        };
        return out;
    }

    const gen = generateMultiBiomeLayout({
        segments: segmentsRaw || undefined,
        floors: floorsRaw || undefined,
        seed,
        loadDungeonProfile: o.loadDungeonProfile,
        loadPiecePack: o.loadPiecePack,
        normalizePiecePack: o.normalizePiecePack,
        loadPopulation: o.loadPopulation,
        loadBiomePack: o.loadBiomePack,
        defaultPiecePack:
            layout.piecePack != null ? String(layout.piecePack) : null,
        defaultArtSet:
            layout.artSet != null
                ? String(layout.artSet)
                : hunt.artSet != null
                  ? String(hunt.artSet)
                  : null
    });

    if (!gen.ok) {
        const out = Object.assign({}, hunt);
        out.layoutSkipped = gen.error ? gen.error.code : 'generate_failed';
        out.layoutError = gen.error || {
            code: 'generate_failed',
            message: 'Multi-biome generation failed'
        };
        out.layoutMeta = {
            reason: 'failed',
            type: 'multi_biome',
            seed,
            floorIndex: gen.floorIndex
        };
        return out;
    }

    // Chain meta for first segment content pointers
    let populationId =
        layout.populationId != null
            ? String(layout.populationId)
            : hunt.populationId != null
              ? String(hunt.populationId)
              : null;
    let markersId =
        layout.markersId != null
            ? String(layout.markersId)
            : hunt.markersId != null
              ? String(hunt.markersId)
              : null;
    let artSet =
        layout.artSet != null
            ? String(layout.artSet)
            : hunt.artSet != null
              ? String(hunt.artSet)
              : null;
    if (gen.macro && gen.macro.segments && gen.macro.segments[0]) {
        const first = gen.macro.segments[0];
        if (!populationId && first.populationId) {
            populationId = first.populationId;
        }
        if (!markersId && first.markersId) markersId = first.markersId;
        if (!artSet && first.artSet) artSet = first.artSet;
    }

    return applyMultiBiomeToHunt(hunt, gen, seed, {
        populationId,
        markersId,
        artSet,
        pacingBudget: layout.pacingBudget || null
    });
}

/**
 * True when hunt layout is multi-biome (segments / multi_biome type).
 * @param {object|null|undefined} hunt
 * @returns {boolean}
 */
function huntHasMultiBiome(hunt) {
    if (!hunt || typeof hunt !== 'object') return false;
    const layout = hunt.layout;
    if (!layout || typeof layout !== 'object') return false;
    const t = String(layout.type || layout.kind || '').toLowerCase();
    if (
        t === 'multi_biome' ||
        t === 'multibiome' ||
        t === 'macro' ||
        t === 'macro_biome'
    ) {
        return true;
    }
    if (Array.isArray(layout.segments) && layout.segments.length >= 1) {
        return true;
    }
    if (Array.isArray(layout.biomeIds) && layout.biomeIds.length >= 2) {
        return true;
    }
    return false;
}

module.exports = {
    DEFAULT_TARGET_SEGMENT_SEC,
    normalizeMacroSegment,
    normalizeMacroSegments,
    segmentsFromFloorMeta,
    expandSegmentsToFloors,
    applyBiomeDefaultsToFloors,
    buildMacroMeta,
    generateMultiBiomeLayout,
    applyMultiBiomeToHunt,
    resolveMultiBiomeHuntLayout,
    huntHasMultiBiome,
    // re-export for tests that only need floor entry shape
    normalizeFloorEntry
};
