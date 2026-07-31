/**
 * Logic-time regulators for fixed-step sims (Stage 12G.1).
 *
 * Ported from soccer-oss patterns — domain-free only (no kick / match helpers).
 *
 * IMPORTANT:
 *   Settings.TIME_SPEED only changes how many logic ticks run per wall-clock
 *   second. Each tick still uses fixed LOGIC_DT (1/LOGIC_UPS). Cooldowns and
 *   decision throttles driven by Time.deltaTime (or tick counts) therefore keep
 *   the same rates in *sim time* at 1× or 10× play speed. These helpers are
 *   NOT a fix for “high UPS”; they unify decision throttles so expensive work
 *   (retarget scans, A* repath) stays in logic time — never wall-clock / Date.now.
 *
 * Use:
 *   - TickRegulator — run work every N logic ticks (support-spot style).
 *   - LogicTimeCooldown — countdown in logic seconds (uses Time.deltaTime).
 *   - isTickDue / isLogicIntervalDue — attach gates on entities without ceremony.
 */

/**
 * Logic-tick interval gate.
 * Ready on first call, then waits intervalTicks-1 false calls.
 */
class TickRegulator {
    /**
     * @param {number} intervalTicks
     */
    constructor(intervalTicks) {
        this.intervalTicks = Math.max(1, intervalTicks | 0);
        this.ticksUntilReady = 0;
    }

    /**
     * @param {number} intervalTicks
     */
    setInterval(intervalTicks) {
        this.intervalTicks = Math.max(1, intervalTicks | 0);
    }

    /**
     * @returns {boolean} true when work should run this tick
     */
    isReady() {
        if (this.ticksUntilReady > 0) {
            this.ticksUntilReady--;
            return false;
        }
        this.ticksUntilReady = this.intervalTicks - 1;
        return true;
    }

    forceReady() {
        this.ticksUntilReady = 0;
    }
}

/**
 * Countdown in logic seconds (call sites pass Time.deltaTime).
 * Ready when remaining <= 0.
 */
class LogicTimeCooldown {
    /**
     * @param {number} [defaultDuration=0]
     */
    constructor(defaultDuration = 0) {
        this.defaultDuration = Math.max(0, defaultDuration);
        this.remaining = 0;
    }

    /**
     * @param {number} [duration] defaults to defaultDuration
     */
    start(duration) {
        const d = duration != null ? duration : this.defaultDuration;
        this.remaining = Math.max(0, d);
    }

    clear() {
        this.remaining = 0;
    }

    /**
     * Advance by one logic step.
     * @param {number} dt Time.deltaTime (logic seconds)
     * @returns {boolean} true if cooldown finished this tick or was already ready
     */
    tick(dt) {
        if (this.remaining <= 0) return true;
        const step = typeof dt === 'number' && dt > 0 ? dt : 0;
        this.remaining -= step;
        if (this.remaining < 0) this.remaining = 0;
        return this.remaining <= 0;
    }

    get ready() {
        return this.remaining <= 0;
    }

    get active() {
        return this.remaining > 0;
    }
}

/**
 * Attach or reuse a TickRegulator on a host object.
 * @param {object} host
 * @param {string} key property name (e.g. '_repathReg')
 * @param {number} intervalTicks
 * @returns {TickRegulator|null}
 */
function getTickRegulator(host, key, intervalTicks) {
    if (!host || !key) return null;
    let reg = host[key];
    if (!(reg instanceof TickRegulator)) {
        reg = new TickRegulator(intervalTicks);
        host[key] = reg;
    } else if (intervalTicks != null) {
        reg.setInterval(intervalTicks);
    }
    return reg;
}

/**
 * Whether regulated tick-work should run this call.
 * intervalTicks ≤ 1 (or non-finite / null) → always true (no throttle).
 *
 * @param {object} host
 * @param {string} key
 * @param {number} intervalTicks
 * @returns {boolean}
 */
function isTickDue(host, key, intervalTicks) {
    const n = Number(intervalTicks);
    if (!host || !Number.isFinite(n) || n <= 1) return true;
    const reg = getTickRegulator(host, key, Math.max(1, n | 0));
    return reg ? reg.isReady() : true;
}

/**
 * Attach or reuse a LogicTimeCooldown on a host object.
 * @param {object} host
 * @param {string} key
 * @param {number} [defaultDuration=0]
 * @returns {LogicTimeCooldown|null}
 */
function getLogicCooldown(host, key, defaultDuration) {
    if (!host || !key) return null;
    let cd = host[key];
    if (!(cd instanceof LogicTimeCooldown)) {
        cd = new LogicTimeCooldown(defaultDuration || 0);
        host[key] = cd;
    } else if (defaultDuration != null && defaultDuration !== cd.defaultDuration) {
        cd.defaultDuration = Math.max(0, defaultDuration);
    }
    return cd;
}

/**
 * Logic-second interval gate: true when work may run, then arms the cooldown.
 * intervalSec ≤ 0 (or non-finite) → always true (no throttle).
 *
 * Call once per decision site (does not tick every frame — arms only on fire).
 * For continuous countdowns that must advance every frame, use LogicTimeCooldown.tick.
 *
 * @param {object} host
 * @param {string} key
 * @param {number} intervalSec logic seconds between firings
 * @param {number} [now] Time.timeSinceLevelLoad (preferred over wall clock)
 * @returns {boolean}
 */
function isLogicIntervalDue(host, key, intervalSec, now) {
    const interval = Number(intervalSec);
    if (!host || !Number.isFinite(interval) || interval <= 0) return true;
    const t =
        typeof now === 'number' && Number.isFinite(now)
            ? now
            : 0;
    const nextKey = key;
    const nextAt = host[nextKey];
    if (nextAt != null && Number.isFinite(nextAt) && t < nextAt) {
        return false;
    }
    host[nextKey] = t + interval;
    return true;
}

/**
 * Force a tick regulator (or logic-interval timestamp) ready for the next check.
 * @param {object} host
 * @param {string} key
 */
function forceDue(host, key) {
    if (!host || !key) return;
    const reg = host[key];
    if (reg instanceof TickRegulator) {
        reg.forceReady();
        return;
    }
    if (reg instanceof LogicTimeCooldown) {
        reg.clear();
        return;
    }
    // Logic-interval timestamp field
    host[key] = null;
}

module.exports = {
    TickRegulator,
    LogicTimeCooldown,
    getTickRegulator,
    isTickDue,
    getLogicCooldown,
    isLogicIntervalDue,
    forceDue
};
