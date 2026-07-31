/**
 * Fixed-timestep clock for the game runtime.
 * Wall-clock scheduling (ApplicationLoop) may run faster/slower via Settings.TIME_SPEED;
 * logic always advances by LOGIC_DT so simulations stay deterministic.
 */

const LOGIC_UPS = 20;
const LOGIC_DT = 1 / LOGIC_UPS;

function nowMs() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
}

const Time = {
    time: 0,
    timeSinceLevelLoad: 0,
    deltaTime: 0,
    base: 0,

    getFixedLogicDeltaTime() {
        return LOGIC_DT;
    },

    advanceFixedLogicStep() {
        this.deltaTime = this.getFixedLogicDeltaTime();
        this.time += this.deltaTime;
        this.timeSinceLevelLoad += this.deltaTime;
    },

    /** Wall-clock delta (render / tools only — not used for hunt logic). */
    update() {
        this.deltaTime = (nowMs() - this.base) / 1000;
        this.base = nowMs();
        this.time += this.deltaTime;
        this.timeSinceLevelLoad += this.deltaTime;
    },

    resetTimeSinceLevelLoad() {
        this.base = nowMs();
        this.timeSinceLevelLoad = 0;
        this.deltaTime = 0;
    }
};

module.exports = { Time, LOGIC_UPS, LOGIC_DT, nowMs };
