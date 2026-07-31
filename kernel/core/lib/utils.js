/**
 * Shared helpers for the game runtime (minimal Stage 0 surface).
 * Seeded LCG is the single source of truth for deterministic Math.random during logic.
 */

const NATIVE_MATH_RANDOM = Math.random;

/** Numerical Recipes LCG parameters (same family as soccer-js). */
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_M = 0x100000000;

/**
 * @param {number} seed
 * @returns {(() => number) & { getState: () => number, getDrawCount: () => number }}
 *   returns [0, 1); getState/getDrawCount for live↔headless parity isolation
 */
function createSeededRandom(seed) {
    let state = (seed >>> 0) || 1;
    let draws = 0;
    function seededRandom() {
        state = (Math.imul(state, LCG_A) + LCG_C) >>> 0;
        draws += 1;
        return state / LCG_M;
    }
    /** Current LCG state (after last draw; seed before first draw). */
    seededRandom.getState = function getState() {
        return state >>> 0;
    };
    /** Total draws since creation (session LCG only). */
    seededRandom.getDrawCount = function getDrawCount() {
        return draws;
    };
    return seededRandom;
}

/**
 * Replace Math.random with a seeded LCG for the duration of logic ticks / bootstrap.
 * @param {number} seed
 * @returns {() => number}
 */
function bindSeededRandom(seed) {
    const rng = createSeededRandom(seed);
    Math.random = rng;
    return rng;
}

/** Restore the platform Math.random (never leave a bound RNG after headless runs). */
function unbindSeededRandom() {
    Math.random = NATIVE_MATH_RANDOM;
}

const Utils = {
    createSeededRandom,
    bindSeededRandom,
    unbindSeededRandom,

    /** Independent LCG for non-sim cosmetic use (does not touch Math.random). */
    pseudoRandomState: 0x9e3779b9,
    getPseudoRandom() {
        this.pseudoRandomState = (Math.imul(this.pseudoRandomState, LCG_A) + LCG_C) >>> 0;
        return this.pseudoRandomState / LCG_M;
    },

    formatSeconds(seconds) {
        const s = Math.max(0, Math.floor(Number(seconds) || 0));
        const hrs = Math.floor(s / 3600);
        const mins = Math.floor((s % 3600) / 60);
        const secs = s % 60;
        const pad = (n) => n.toString().padStart(2, '0');
        return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    },

    distanceMax(x1, y1, x2, y2) {
        return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
    },

    calculateDistance(x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    },

    getRandomInt(min, max) {
        const lo = Math.ceil(min);
        const hi = Math.floor(max);
        return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }
};

module.exports = {
    Utils,
    createSeededRandom,
    bindSeededRandom,
    unbindSeededRandom,
    NATIVE_MATH_RANDOM
};
