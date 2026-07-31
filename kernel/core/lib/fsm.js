/**
 * Lightweight finite-state machine (Stage 5 hunt AI).
 * Pattern from legacy StateMachine; no DOM / globals.
 *
 * States are plain objects with optional enter / execute / exit(owner).
 */

class StateMachine {
    /**
     * @param {object} owner Entity that owns this FSM
     */
    constructor(owner) {
        this.owner = owner;
        /** @type {object|null} */
        this.currentState = null;
        /** @type {object|null} */
        this.previousState = null;
        /** @type {object|null} Optional always-run layer */
        this.globalState = null;
        /** @type {string} Stable id for telemetry / debug */
        this.stateId = '';
    }

    /**
     * @param {object|null} s
     */
    setCurrentState(s) {
        this.currentState = s;
        this.stateId = stateName(s);
    }

    /**
     * @param {object|null} s
     */
    setGlobalState(s) {
        this.globalState = s;
    }

    /**
     * Transition: exit old → enter new.
     * @param {object|null} next
     */
    changeState(next) {
        if (this.currentState === next) return;
        this.previousState = this.currentState;
        if (this.currentState && typeof this.currentState.exit === 'function') {
            this.currentState.exit(this.owner);
        }
        this.currentState = next;
        this.stateId = stateName(next);
        if (this.currentState && typeof this.currentState.enter === 'function') {
            this.currentState.enter(this.owner);
        }
    }

    revertToPreviousState() {
        this.changeState(this.previousState);
    }

    /**
     * @param {object|string} st state object or id string
     * @returns {boolean}
     */
    isInState(st) {
        if (!this.currentState) return false;
        if (typeof st === 'string') {
            return this.stateId === st || stateName(this.currentState) === st;
        }
        return this.currentState === st || stateName(this.currentState) === stateName(st);
    }

    /**
     * Run global then current state execute.
     * @param {object} [ctx] Optional per-tick context (sim, map, …)
     */
    update(ctx) {
        if (this.globalState && typeof this.globalState.execute === 'function') {
            this.globalState.execute(this.owner, ctx);
        }
        if (this.currentState && typeof this.currentState.execute === 'function') {
            this.currentState.execute(this.owner, ctx);
        }
    }

    getNameOfCurrentState() {
        return this.stateId || stateName(this.currentState);
    }
}

/**
 * @param {object|null} s
 * @returns {string}
 */
function stateName(s) {
    if (!s) return '';
    if (s.id) return String(s.id);
    if (s.name) return String(s.name);
    return s.constructor && s.constructor.name ? s.constructor.name : '';
}

module.exports = { StateMachine, stateName };
