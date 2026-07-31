/**
 * AI think cadence helpers.
 *
 * Knobs live on Settings (AI_GATE_*, AI_THINK_PAD_*, AI_ENGAGE_*, AI_TARGET_*,
 * AI_RETARGET_INTERVAL, AI_REPATH_INTERVAL_TICKS).
 * Cooldowns always tick on Creature.update; these helpers only throttle decisions.
 * Retarget / repath intervals use logic-time regulators (Stage 12G.1).
 */

const { Settings } = require('../../../settings.js');
const { Time } = require('../time.js');
const Cooldowns = require('../combat/cooldowns.js');
const { shouldEngage } = require('./strategy.js');
const { isValidTarget, distBetween } = require('./targeting.js');
const { isLogicIntervalDue, forceDue } = require('../logic_regulator.js');

/**
 * @param {string} key
 * @param {*} fallback
 * @returns {*}
 */
function setting(key, fallback) {
    if (Settings[key] === undefined || Settings[key] === null) return fallback;
    return Settings[key];
}

/**
 * Whether the entity brain may run this logic tick (legacy: only when moveDelay ≤ 0).
 * @param {object} entity
 * @param {'player'|'creature'} [role='player']
 * @returns {boolean}
 */
function brainReady(entity, role) {
    if (!entity || entity.alive === false) return false;
    const gate =
        role === 'creature'
            ? setting('AI_GATE_CREATURE_ON_MOVE_DELAY', true)
            : setting('AI_GATE_BRAIN_ON_MOVE_DELAY', true);
    if (!gate) return true;
    const delay = Number(entity.moveDelay) || 0;
    return delay <= 0;
}

/**
 * After the Engage spell scan, pad primary.attack so ability retries are not
 * every free logic tick (legacy playerscripts pad primary.attack to 0.1s).
 *
 * Does **not** touch auto.attack — weapon auto has its own 2s cadence.
 * Only pads when primary.attack is already ready (remaining ≤ 0). Re-applying
 * while 0 < remaining < pad (e.g. mid-pad after a 0.05s logic tick) would
 * bounce forever between pad and pad−dt and never allow another cast.
 * Never shortens an existing primary.attack cooldown.
 * @param {object} entity
 */
function applyThinkPad(entity) {
    const pad = Number(setting('AI_THINK_PAD_SEC', 0.1)) || 0;
    if (pad <= 0 || !entity) return;
    Cooldowns.ensureCooldowns(entity);
    const cur = Cooldowns.getRemaining(entity, 'primary', 'attack');
    if (cur <= 0) {
        entity.cooldowns.primary.attack = pad;
    }
}

/**
 * Sticky engage decision (legacy pack threshold + less spam than 20 Hz aggression).
 * Re-rolls when pack crosses monstersToEngage, or when AI_ENGAGE_DECISION_INTERVAL
 * has elapsed since the last roll. Interval 0 → re-roll every call (pre-parity).
 *
 * @param {object} owner
 * @param {number} packCount living enemies in engage range
 * @param {object} strategy
 * @param {() => number} [rng]
 * @returns {boolean} whether the owner wants to enter combat this tick
 */
function evaluateEngageWant(owner, packCount, strategy, rng) {
    if (!owner) return false;
    const st = strategy || {};
    const need = st.monstersToEngage != null ? st.monstersToEngage | 0 : 1;
    const pack = packCount | 0;
    const prev =
        owner._engagePackCount != null ? owner._engagePackCount | 0 : -1;
    owner._engagePackCount = pack;

    if (pack < need) {
        owner._engageDecision = false;
        return false;
    }

    const interval = Number(setting('AI_ENGAGE_DECISION_INTERVAL', 0.25));
    const now =
        Time && typeof Time.timeSinceLevelLoad === 'number'
            ? Time.timeSinceLevelLoad
            : 0;
    const crossedInto = prev < need && pack >= need;
    const nextAt =
        owner._engageNextRollAt != null ? owner._engageNextRollAt : -Infinity;
    const intervalDue = !Number.isFinite(interval) || interval <= 0 || now >= nextAt;
    const first = owner._engageDecision == null;

    if (first || crossedInto || intervalDue) {
        owner._engageDecision = shouldEngage(
            st,
            pack,
            typeof rng === 'function' ? rng : Math.random
        );
        owner._engageNextRollAt =
            interval > 0 ? now + interval : now;
    }

    return !!owner._engageDecision;
}

/**
 * Distance policy for a living same-floor target.
 * @param {object} self
 * @param {object|null} target
 * @returns {'invalid'|'lose'|'retarget'|'hold'}
 */
function targetDistancePolicy(self, target) {
    if (!isValidTarget(self, target)) return 'invalid';
    const d = distBetween(self, target);
    const lose = Number(setting('AI_TARGET_LOSE_DIST', 10));
    if (lose > 0 && d > lose) return 'lose';
    const retarget = Number(setting('AI_TARGET_RETARGET_DIST', 2));
    if (retarget > 0 && d >= retarget) return 'retarget';
    return 'hold';
}

/**
 * Reset sticky engage fields (optional; used when leaving route AI hard-reset).
 * @param {object} owner
 */
function clearEngageSticky(owner) {
    if (!owner) return;
    owner._engageDecision = null;
    owner._engagePackCount = null;
    owner._engageNextRollAt = null;
    forceDue(owner, '_retargetNextAt');
}

/**
 * Whether a soft retarget re-scan (findNearest) may run this tick.
 * Interval 0 / missing → always true. Uses logic time (Time.timeSinceLevelLoad).
 * Force-true after forceDue / clearEngageSticky so combat entry is not stuck.
 *
 * @param {object} owner
 * @returns {boolean}
 */
function softRetargetDue(owner) {
    if (!owner) return true;
    const interval = Number(setting('AI_RETARGET_INTERVAL', 0));
    if (!Number.isFinite(interval) || interval <= 0) return true;
    const now =
        Time && typeof Time.timeSinceLevelLoad === 'number'
            ? Time.timeSinceLevelLoad
            : 0;
    return isLogicIntervalDue(owner, '_retargetNextAt', interval, now);
}

/**
 * Logic-time gate for melee circle retries (blocked / empty candidate).
 * Unlike isLogicIntervalDue, this does **not** arm on check — arm only after
 * an actual circle attempt that failed to move (see armCircleRetry).
 *
 * @param {object} owner
 * @returns {boolean}
 */
function circleAttemptDue(owner) {
    if (!owner) return true;
    const nextAt = owner._circleNextAt;
    if (nextAt == null || !Number.isFinite(nextAt)) return true;
    const now =
        Time && typeof Time.timeSinceLevelLoad === 'number'
            ? Time.timeSinceLevelLoad
            : 0;
    return now >= nextAt;
}

/**
 * Arm the melee-circle retry timer after a no-move attempt.
 * Interval 0 / missing → no gate (always due next free think).
 * @param {object} owner
 */
function armCircleRetry(owner) {
    if (!owner) return;
    const interval = Number(setting('AI_CREATURE_CIRCLE_INTERVAL', 0.5));
    if (!Number.isFinite(interval) || interval <= 0) {
        owner._circleNextAt = null;
        return;
    }
    const now =
        Time && typeof Time.timeSinceLevelLoad === 'number'
            ? Time.timeSinceLevelLoad
            : 0;
    owner._circleNextAt = now + interval;
}

/**
 * Clear circle retry gate (target lost / leave combat).
 * @param {object} owner
 */
function clearCircleRetry(owner) {
    if (!owner) return;
    owner._circleNextAt = null;
}

module.exports = {
    brainReady,
    applyThinkPad,
    evaluateEngageWant,
    targetDistancePolicy,
    clearEngageSticky,
    softRetargetDue,
    circleAttemptDue,
    armCircleRetry,
    clearCircleRetry,
    setting
};
