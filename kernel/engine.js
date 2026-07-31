/**
 * Browser app shell: CanvasLoop (~FRAME_RATE) + ApplicationLoop (~LOGIC_UPS * TIME_SPEED).
 * Logic always uses fixed Time.advanceFixedLogicStep(); TIME_SPEED only changes wall scheduling.
 * Headless sims call Simulator.updateAll() directly and never need this module.
 *
 * When the hunt session ends (route_complete, party_wipe, waves_complete, …),
 * both loops freeze: no further logic ticks and no canvas clear/repaint so the
 * last frame stays visible. Scrub seek / Play start unfreeze by leaving the
 * terminal state or calling paintOnce().
 */

const { Time, LOGIC_UPS } = require('./core/lib/time.js');
const { Settings } = require('./settings.js');
const { Utils } = require('./core/lib/utils.js');
const { nowMs } = require('./core/lib/time.js');
const { isSessionTerminal } = require('./providers/simulator/hunt_opts.js');

function isLiveLoop(loopId) {
    return !Settings.app.interrupted && Settings.app.loopId === loopId;
}

/**
 * True when the current level should stop ticking and repainting.
 * Seek-in-progress is never frozen so reseed can finish and paintOnce can run.
 * `inventoryPractice` keeps the canvas + light script updates alive after the
 * hunt ends so Scenario Lab inventory drop/pickup still renders.
 * @param {object|null|undefined} level
 * @returns {boolean}
 */
function isLevelFrozen(level) {
    if (!level || level._seekInProgress) return false;
    if (level.inventoryPractice) return false;
    return isSessionTerminal(level.sessionState);
}

function CanvasLoop(currentTime, loopId) {
    if (!isLiveLoop(loopId)) return;

    const deltaTime = currentTime - Settings.app.lastTime;
    if (deltaTime >= Settings.app.targetFrameTime) {
        const level = Settings.app.currentLevel;
        const frozen = isLevelFrozen(level);

        // Force a single paint after seek / session-end edge (leave last image after).
        if (Settings.app._forcePaint) {
            Settings.app._forcePaint = false;
            Settings.app.clearScreen();
            Settings.app.render();
            Settings.app.onGUI();
        } else if (!frozen) {
            Settings.app.clearScreen();
            Settings.app.render();
            Settings.app.onGUI();
        }

        if (!frozen) {
            Settings.app.frames++;

            if (
                level &&
                level.active &&
                currentTime - Settings.app.lastFrameFPSUpdate >= 1000
            ) {
                Settings.app.FPS =
                    Settings.app.frames /
                    ((currentTime - Settings.app.lastFrameFPSUpdate) / 1000);
                Settings.app.lastFrameFPSUpdate = currentTime;
                Settings.app.frames = 0;
                if (Settings.showFPS && Settings.app.statsFields) {
                    if (Settings.app.statsFields.fps) {
                        Settings.app.statsFields.fps.textContent = String(
                            Math.round(Settings.app.FPS)
                        );
                    }
                    if (Settings.app.statsFields.ups) {
                        Settings.app.statsFields.ups.textContent = String(
                            Math.round(Settings.app.UPS)
                        );
                    }
                    if (Settings.app.statsFields.speed) {
                        Settings.app.statsFields.speed.textContent = String(
                            Settings.TIME_SPEED
                        );
                    }
                }
                if (
                    Settings.showTime &&
                    Settings.app.statsFields &&
                    Settings.app.statsFields.time
                ) {
                    Settings.app.statsFields.time.textContent =
                        Utils.formatSeconds(Time.timeSinceLevelLoad);
                }
            }
        }
        Settings.app.lastTime =
            currentTime - (deltaTime % Settings.app.targetFrameTime);
    }
    if (isLiveLoop(loopId) && typeof requestAnimationFrame === 'function') {
        requestAnimationFrame((t) => CanvasLoop(t, loopId));
    }
}

async function ApplicationLoop(loopId) {
    if (!isLiveLoop(loopId)) return;

    const start = nowMs();
    await Settings.app.update();
    const end = nowMs();
    const workTime = end - start;

    if (!isLiveLoop(loopId)) return;

    try {
        // 20 UPS at 1x; TIME_SPEED only shortens wall wait between ticks
        const baseFrameTime = 1000 / LOGIC_UPS;
        const targetFrameTimeMs = baseFrameTime / Settings.TIME_SPEED;
        const nextFrameTime = Math.max(0, targetFrameTimeMs - workTime);

        Settings.app.lastUpdate = end;
        Settings.app.updateCounter = (Settings.app.updateCounter || 0) + 1;
        Settings.app.totalWorkTime = (Settings.app.totalWorkTime || 0) + workTime;
        Settings.app.lastLogTime = Settings.app.lastLogTime || end;

        if (end - Settings.app.lastLogTime >= 1000) {
            Settings.app.UPS =
                Settings.app.updateCounter / ((end - Settings.app.lastLogTime) / 1000);
            Settings.app.avgWorkTime = Settings.app.totalWorkTime / Settings.app.updateCounter;
            Settings.app.updateCounter = 0;
            Settings.app.totalWorkTime = 0;
            Settings.app.lastLogTime = end;
        }

        setTimeout(() => ApplicationLoop(loopId), nextFrameTime);
    } catch (err) {
        console.error(err);
        Settings.app.interrupted = true;
    }
}

const Application = {
    lastFrameFPSUpdate: 0,
    targetFrameTime: 1000 / 60,
    interrupted: false,
    /** Bumped on each run() so stale CanvasLoop/ApplicationLoop callbacks exit */
    loopId: 0,
    paused: false,
    /**
     * One-shot repaint while session is otherwise frozen (after scrub seek,
     * or when a terminal frame must be shown once).
     * @type {boolean}
     */
    _forcePaint: false,
    lastTime: 0,
    lastUpdate: 0,
    currentLevel: null,
    levelReady: false,
    frames: 0,
    FPS: 0,
    UPS: 0,
    canvas: null,
    g: null,
    width: 0,
    height: 0,
    camX: 0,
    camY: 0,
    statsFields: null,
    updateCounter: 0,
    totalWorkTime: 0,
    lastLogTime: 0,
    avgWorkTime: 0,

    async loadLevel(currentLevel) {
        this.levelReady = false;
        Time.resetTimeSinceLevelLoad();
        if (this.g) {
            this.clearScreen();
        }
        if (this.currentLevel !== null && typeof this.currentLevel.destroy === 'function') {
            this.currentLevel.destroy();
        }
        this.currentLevel = currentLevel;
        if (this.currentLevel != null) {
            await this.currentLevel.start();
        }
        this.levelReady = this.currentLevel != null;
    },

    getCurrentLevel() {
        return this.currentLevel;
    },

    clearScreen() {
        if (!this.g || !this.canvas) return;
        this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
        if (Settings.screenColor) {
            this.g.fillStyle = Settings.screenColor;
            this.g.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }
    },

    /**
     * Start render + logic loops for a level root (usually a Simulator).
     * @param {string} canvasID
     * @param {import('./core/entities/gameobject.js').GameObject} level
     * @param {number} [width=720]
     * @param {number} [height=528]
     */
    async run(canvasID, level, width = 720, height = 528) {
        if (!canvasID) throw new Error('canvasID is required');
        if (!level) throw new Error('level is required');
        if (typeof document === 'undefined') {
            throw new Error('Application.run requires a browser document');
        }

        this.width = width;
        this.height = height;
        this.targetFrameTime = 1000 / Settings.FRAME_RATE;
        // Invalidate any previous loops before starting a new generation
        this.interrupted = true;
        this.loopId += 1;
        const loopId = this.loopId;
        this.interrupted = false;
        this.paused = false;
        this._forcePaint = false;
        this.lastTime = nowMs();
        this.lastUpdate = nowMs();
        this.lastFrameFPSUpdate = nowMs();
        this.frames = 0;
        this.FPS = 0;
        this.UPS = 0;
        this.updateCounter = 0;
        this.totalWorkTime = 0;
        this.lastLogTime = 0;

        this.canvas = document.getElementById(canvasID);
        if (!this.canvas) throw new Error(`Canvas with ID '${canvasID}' not found`);
        this.g = this.canvas.getContext('2d');
        this.canvas.setAttribute('width', String(this.width));
        this.canvas.setAttribute('height', String(this.height));

        this.bindStatsFields();
        Time.resetTimeSinceLevelLoad();
        await this.loadLevel(level);

        if (!isLiveLoop(loopId)) return;

        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame((t) => CanvasLoop(t, loopId));
        }
        ApplicationLoop(loopId);
    },

    bindStatsFields() {
        if (typeof document === 'undefined') {
            this.statsFields = null;
            return;
        }
        this.statsFields = {
            fps: document.getElementById('statFps'),
            ups: document.getElementById('statUps'),
            speed: document.getElementById('statSpeed'),
            time: document.getElementById('statTime')
        };
    },

    async update() {
        if (this.paused || !this.levelReady || !this.currentLevel) {
            Time.base = nowMs();
            return;
        }
        // Stage 12E: do not interleave live ticks while scrub reseed is running
        if (this.currentLevel._seekInProgress) {
            Time.base = nowMs();
            return;
        }
        // Session end: stop logic (mirrors headless stopOnEnd). Canvas freezes too.
        if (isLevelFrozen(this.currentLevel)) {
            Time.base = nowMs();
            return;
        }
        Time.advanceFixedLogicStep();
        this.currentLevel.updateAll();
        // When this tick just ended the session, paint the final frame once.
        if (isSessionTerminal(this.currentLevel.sessionState)) {
            this._forcePaint = true;
        }
    },

    render() {
        if (!this.levelReady || !this.currentLevel || !this.g) return;
        this.g.save();
        this.g.translate(this.camX, this.camY);
        this.currentLevel.renderAll(this.g);
        this.g.restore();
    },

    onGUI() {
        if (!this.levelReady || !this.currentLevel || !this.g) return;
        this.g.save();
        this.g.translate(this.camX, this.camY);
        this.currentLevel.onGUIAll(this.g);
        this.g.restore();
    },

    /**
     * Immediately clear + draw the current level (or schedule one CanvasLoop paint).
     * Used after scrub seek so the frozen canvas shows the sought tick.
     */
    paintOnce() {
        this._forcePaint = true;
        if (!this.levelReady || !this.currentLevel || !this.g) return;
        this.clearScreen();
        this.render();
        this.onGUI();
        this._forcePaint = false;
    },

    quit() {
        this.interrupted = true;
        this._forcePaint = false;
        if (this.currentLevel && typeof this.currentLevel.destroy === 'function') {
            this.currentLevel.destroy();
        }
        this.levelReady = false;
        this.currentLevel = null;
    }
};

Settings.app = Application;

if (typeof window !== 'undefined') {
    window.Application = Application;
    window.Settings = Settings;
}

module.exports = {
    Application,
    CanvasLoop,
    ApplicationLoop,
    isLevelFrozen,
    isSessionTerminal
};
