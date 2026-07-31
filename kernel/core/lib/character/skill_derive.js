/**
 * Derived skill generator for tests / profile authoring (Phase B tooling).
 * Not used at runtime spawn — content helper only.
 *
 * Policy v1: level → skill anchors per class role (linear between anchors),
 * not try-budget economics. Rates are attached for cost validation only.
 *
 * @see docs/27_exp_skill_progression_plan.md
 */

'use strict';

const {
    totalSkillTries,
    totalManaForMagicLevel,
    SKILL_FLOOR,
    MAGIC_FLOOR
} = require('./progression.js');

/** Floor skills (class B2 / untrained). */
const FLOOR_SKILLS = Object.freeze({
    melee: SKILL_FLOOR,
    distance: SKILL_FLOOR,
    shielding: SKILL_FLOOR,
    magic: MAGIC_FLOOR,
    fist: SKILL_FLOOR
});

/**
 * Role anchors: [level, value] pairs. Linear interpolate between.
 * Inspired by standard novice/starter/veteran profiles (not identical).
 */
const CLASS_POLICY = Object.freeze({
    guardian: {
        skillKey: 'melee',
        primaryLegacy: 'sword',
        primary: [
            [8, 15],
            [12, 25],
            [50, 60],
            [90, 90]
        ],
        shielding: [
            [8, 15],
            [12, 20],
            [50, 50],
            [90, 80]
        ],
        magic: [
            [8, 0],
            [50, 0],
            [90, 5]
        ],
        distance: [
            [8, 10],
            [50, 10],
            [90, 15]
        ],
        offMelee: [
            [8, 10],
            [50, 13],
            [90, 20]
        ]
    },
    scout: {
        skillKey: 'distance',
        primaryLegacy: 'distance',
        primary: [
            [8, 15],
            [12, 25],
            [50, 50],
            [90, 90]
        ],
        shielding: [
            [8, 10],
            [12, 12],
            [50, 20],
            [90, 45]
        ],
        magic: [
            [8, 0],
            [50, 0],
            [90, 20]
        ],
        distance: null, // primary is distance
        melee: [
            [8, 12],
            [12, 15],
            [50, 30],
            [90, 40]
        ],
        offMelee: [
            [8, 10],
            [50, 13],
            [90, 15]
        ]
    },
    mystic: {
        skillKey: 'melee',
        primaryLegacy: 'fist',
        primary: [
            [8, 15],
            [12, 22],
            [50, 55],
            [90, 85]
        ],
        shielding: [
            [8, 12],
            [12, 18],
            [50, 45],
            [90, 70]
        ],
        magic: [
            [8, 0],
            [12, 5],
            [50, 25],
            [90, 45]
        ],
        distance: [
            [8, 10],
            [50, 15],
            [90, 25]
        ],
        offMelee: [
            [8, 10],
            [50, 13],
            [90, 18]
        ]
    },
    adept: {
        skillKey: 'magic',
        primaryLegacy: 'magicLevel',
        primary: [
            [8, 8],
            [12, 15],
            [50, 40],
            [90, 80]
        ],
        shielding: [
            [8, 10],
            [12, 10],
            [50, 20],
            [90, 25]
        ],
        magic: null, // primary is magic
        distance: [
            [8, 10],
            [50, 10],
            [90, 15]
        ],
        melee: [
            [8, 10],
            [12, 12],
            [50, 30],
            [90, 25]
        ],
        offMelee: [
            [8, 10],
            [50, 13],
            [90, 12]
        ]
    },
    warden: {
        skillKey: 'magic',
        primaryLegacy: 'magicLevel',
        primary: [
            [8, 8],
            [12, 15],
            [50, 40],
            [90, 80]
        ],
        shielding: [
            [8, 10],
            [12, 10],
            [50, 20],
            [90, 25]
        ],
        magic: null,
        distance: [
            [8, 10],
            [50, 10],
            [90, 15]
        ],
        melee: [
            [8, 10],
            [12, 12],
            [50, 30],
            [90, 25]
        ],
        offMelee: [
            [8, 10],
            [50, 13],
            [90, 12]
        ]
    },
    adventurer: {
        skillKey: 'melee',
        primaryLegacy: 'sword',
        primary: [
            [1, 10],
            [8, 15],
            [20, 30],
            [50, 40]
        ],
        shielding: [
            [1, 10],
            [8, 12],
            [20, 20],
            [50, 30]
        ],
        magic: [
            [1, 0],
            [8, 0],
            [20, 10],
            [50, 20]
        ],
        distance: [
            [1, 10],
            [8, 12],
            [20, 20],
            [50, 30]
        ],
        offMelee: [
            [1, 10],
            [20, 12],
            [50, 15]
        ]
    }
});

/**
 * Linear interpolate value at `level` along sorted [level, value] anchors.
 * @param {Array<[number, number]>} anchors
 * @param {number} level
 * @returns {number}
 */
function interpolateAnchors(anchors, level) {
    if (!anchors || !anchors.length) return SKILL_FLOOR;
    const L = Math.max(1, Math.floor(Number(level) || 1));
    const pts = anchors
        .map((p) => [Number(p[0]), Number(p[1])])
        .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
        .sort((a, b) => a[0] - b[0]);
    if (!pts.length) return SKILL_FLOOR;
    if (L <= pts[0][0]) return Math.round(pts[0][1]);
    if (L >= pts[pts.length - 1][0]) return Math.round(pts[pts.length - 1][1]);
    for (let i = 0; i < pts.length - 1; i++) {
        const [l0, v0] = pts[i];
        const [l1, v1] = pts[i + 1];
        if (L >= l0 && L <= l1) {
            if (l1 === l0) return Math.round(v1);
            const t = (L - l0) / (l1 - l0);
            return Math.round(v0 + t * (v1 - v0));
        }
    }
    return Math.round(pts[pts.length - 1][1]);
}

/**
 * @param {string} classId
 * @returns {object}
 */
function resolvePolicy(classId) {
    const id = classId != null ? String(classId).toLowerCase() : '';
    return CLASS_POLICY[id] || CLASS_POLICY.adventurer;
}

/**
 * Apply focus modifiers to a derived engine bag.
 * @param {object} bag
 * @param {string} focus primary | hybrid | tank
 * @param {object} policy
 * @returns {object}
 */
function applyFocus(bag, focus, policy) {
    const f = focus != null ? String(focus).toLowerCase() : 'primary';
    const out = Object.assign({}, bag);
    if (f === 'tank') {
        out.shielding = Math.round(out.shielding * 1.15);
        if (policy.skillKey === 'melee' || policy.skillKey === 'distance') {
            // slight primary trade-off
            const pk = policy.skillKey === 'distance' ? 'distance' : 'melee';
            out[pk] = Math.max(SKILL_FLOOR, Math.round(out[pk] * 0.95));
        }
    } else if (f === 'hybrid') {
        if (policy.skillKey === 'melee') {
            out.magic = Math.max(out.magic, Math.round((out.melee || 10) * 0.35));
            out.distance = Math.max(out.distance, Math.round((out.melee || 10) * 0.25));
        } else if (policy.skillKey === 'distance') {
            out.magic = Math.max(out.magic, Math.round((out.distance || 10) * 0.3));
            out.melee = Math.max(out.melee, Math.round((out.distance || 10) * 0.4));
        } else if (policy.skillKey === 'magic') {
            out.melee = Math.max(out.melee, Math.round((out.magic || 0) * 0.35 + 10));
            out.shielding = Math.max(out.shielding, Math.round(out.shielding * 1.1));
        }
    }
    // primary: as-is
    return out;
}

/**
 * Derive engine skill bag for a class at a level.
 *
 * @param {string|object} classIdOrDef class id or class row (uses id + skillRates)
 * @param {number} level
 * @param {object} [opts]
 * @param {string} [opts.focus='primary'] primary | hybrid | tank
 * @param {string} [opts.format='engine'] engine | legacy
 * @param {object} [opts.rates] override skillRates
 * @param {boolean} [opts.includeCosts=false] attach try/mana cost summary
 * @returns {{ skills: object, classId: string, level: number, focus: string, policy: string, costs?: object }}
 */
function deriveSkills(classIdOrDef, level, opts) {
    const options = opts || {};
    const focus = options.focus != null ? String(options.focus) : 'primary';
    const format = options.format != null ? String(options.format) : 'engine';
    const L = Math.max(1, Math.floor(Number(level) || 1));

    let classId = 'adventurer';
    let rates = options.rates || null;
    if (classIdOrDef && typeof classIdOrDef === 'object') {
        classId = classIdOrDef.id != null ? String(classIdOrDef.id) : 'adventurer';
        if (!rates && classIdOrDef.skillRates) rates = classIdOrDef.skillRates;
    } else if (classIdOrDef != null) {
        classId = String(classIdOrDef);
    }

    const policy = resolvePolicy(classId);
    const primary = interpolateAnchors(policy.primary, L);
    const shielding = interpolateAnchors(policy.shielding, L);
    const off = interpolateAnchors(policy.offMelee || [[8, 10], [50, 13]], L);

    let melee;
    let distance;
    let magic;
    let fist;

    if (policy.skillKey === 'distance') {
        distance = primary;
        melee = interpolateAnchors(policy.melee || policy.offMelee, L);
        magic = interpolateAnchors(policy.magic || [[8, 0], [50, 0]], L);
        fist = Math.max(SKILL_FLOOR, Math.round(melee * 0.5));
    } else if (policy.skillKey === 'magic') {
        magic = primary;
        melee = interpolateAnchors(policy.melee || policy.offMelee, L);
        distance = interpolateAnchors(policy.distance || [[8, 10], [50, 10]], L);
        fist = Math.max(SKILL_FLOOR, Math.round(melee * 0.5));
    } else {
        // melee primary (guardian / mystic / adventurer)
        melee = primary;
        distance = interpolateAnchors(policy.distance || [[8, 10], [50, 10]], L);
        magic = interpolateAnchors(policy.magic || [[8, 0], [50, 0]], L);
        if (policy.primaryLegacy === 'fist') {
            fist = primary;
            melee = Math.max(SKILL_FLOOR, Math.round(primary * 0.85));
        } else {
            fist = Math.max(SKILL_FLOOR, Math.round(primary * 0.2 + 8));
        }
    }

    let engine = {
        melee: Math.max(SKILL_FLOOR, melee),
        distance: Math.max(SKILL_FLOOR, distance),
        shielding: Math.max(SKILL_FLOOR, shielding),
        magic: Math.max(MAGIC_FLOOR, magic),
        fist: Math.max(SKILL_FLOOR, fist)
    };
    engine = applyFocus(engine, focus, policy);
    // re-clamp after focus
    engine.melee = Math.max(SKILL_FLOOR, Math.round(engine.melee));
    engine.distance = Math.max(SKILL_FLOOR, Math.round(engine.distance));
    engine.shielding = Math.max(SKILL_FLOOR, Math.round(engine.shielding));
    engine.magic = Math.max(MAGIC_FLOOR, Math.round(engine.magic));
    engine.fist = Math.max(SKILL_FLOOR, Math.round(engine.fist));

    let skills;
    if (format === 'legacy') {
        const leg = {
            sword: policy.primaryLegacy === 'sword' ? engine.melee : off,
            axe: off,
            club: off,
            fist: engine.fist,
            distance: engine.distance,
            shielding: engine.shielding,
            magicLevel: engine.magic,
            fishing: SKILL_FLOOR
        };
        if (policy.primaryLegacy === 'fist') {
            leg.fist = engine.fist;
            leg.sword = engine.melee;
        }
        if (policy.skillKey === 'distance') {
            leg.sword = engine.melee;
            leg.distance = engine.distance;
        }
        if (policy.skillKey === 'magic') {
            leg.sword = engine.melee;
            leg.magicLevel = engine.magic;
        }
        skills = leg;
    } else {
        skills = engine;
    }

    const result = {
        classId,
        level: L,
        focus,
        format,
        policy: 'v1_level_anchors',
        skills
    };

    if (options.includeCosts) {
        const r = rates || {};
        result.costs = {
            meleeTries: totalSkillTries('melee', engine.melee, r),
            fistTries: totalSkillTries('fist', engine.fist, r),
            distanceTries: totalSkillTries('distance', engine.distance, r),
            shieldingTries: totalSkillTries('shielding', engine.shielding, r),
            magicMana: totalManaForMagicLevel(engine.magic, r)
        };
    }

    return result;
}

/**
 * Suggested profile skill block only (legacy keys) for drafting JSON.
 * @param {string|object} classIdOrDef
 * @param {number} level
 * @param {object} [opts]
 * @returns {object} skills bag
 */
function deriveProfileSkills(classIdOrDef, level, opts) {
    return deriveSkills(classIdOrDef, level, Object.assign({}, opts, { format: 'legacy' }))
        .skills;
}

module.exports = {
    FLOOR_SKILLS,
    CLASS_POLICY,
    interpolateAnchors,
    deriveSkills,
    deriveProfileSkills
};
