/**
 * Engine Tweakings popup page script (runs in the child window).
 * Talks to opener via postMessage; does not import the game engine.
 */
(function () {
    const CHANNEL = 'hunt-design-lab-tweaks';
    const DEBUG_FLAGS = [
        'states',
        'paths',
        'targets',
        'ranges',
        'spawns',
        'hitSources',
        'tileTypes'
    ];

    const parent = window.opener;
    if (!parent || parent.closed) {
        document.addEventListener('DOMContentLoaded', () => {
            document.body.innerHTML =
                '<div class="p-4 text-warning">Open Engine Tweakings from the Hunt Simulator page.</div>';
        });
        return;
    }

    let state = null;
    let suppress = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let seekDebounceTimer = null;

    function post(msg) {
        try {
            parent.postMessage({ channel: CHANNEL, ...msg }, window.location.origin);
        } catch (err) {
            console.warn('postMessage to parent failed', err);
        }
    }

    function byId(id) {
        return document.getElementById(id);
    }

    /**
     * @param {object|null|undefined} s
     */
    function applySessionToForm(s) {
        const session = (s && s.session) || {};
        const live = !!session.live;
        const paused = !!session.paused;
        const seeking = !!session.seeking;
        const status = session.status || (live ? (paused ? 'PAUSED' : 'RUNNING') : 'READY');
        const cur =
            session.playback && typeof session.playback.current === 'number'
                ? Math.max(0, session.playback.current | 0)
                : 0;
        const max =
            session.playback && typeof session.playback.max === 'number'
                ? Math.max(0, session.playback.max | 0)
                : 0;

        const statusEl = byId('sessionStatusVal');
        if (statusEl) statusEl.innerText = String(status);

        const playBtn = byId('sessionPlayBtn');
        const pauseBtn = byId('sessionPauseBtn');
        const stopBtn = byId('sessionStopBtn');
        const scrub = byId('playbackSlider');
        const scrubVal = byId('playbackFrameVal');
        const speedSlider = byId('timeSpeedSlider');

        if (playBtn) {
            playBtn.disabled = !!seeking;
        }
        if (pauseBtn) {
            pauseBtn.disabled = !live || !!seeking;
            pauseBtn.innerHTML = paused
                ? '<i class="fa-solid fa-play"></i> Resume'
                : '<i class="fa-solid fa-pause"></i> Pause';
        }
        if (stopBtn) {
            stopBtn.disabled = !!seeking;
        }
        if (speedSlider) {
            speedSlider.disabled = !!seeking;
        }

        if (scrub) {
            // Avoid fighting the user while they drag the scrubber
            const active = document.activeElement === scrub;
            scrub.min = '0';
            scrub.max = String(Math.max(0, max));
            if (!active && !seeking) {
                scrub.value = String(Math.min(cur, max));
            }
            scrub.disabled = !live || max <= 0 || !!seeking;
        }
        if (scrubVal) {
            const shown =
                scrub && document.activeElement === scrub
                    ? parseInt(scrub.value, 10) || 0
                    : cur;
            scrubVal.innerText = `${shown} / ${max}`;
        }
    }

    function applyStateToForm(s) {
        if (!s) return;
        suppress = true;
        state = s;

        const cam = s.camera || {};
        const scale = typeof cam.scale === 'number' ? cam.scale : 32;
        const scaleSlider = byId('scaleSlider');
        const scaleVal = byId('scaleVal');
        if (scaleSlider) scaleSlider.value = String(scale);
        if (scaleVal) scaleVal.innerText = String(scale);

        // Bridge always sends spriteJumpHeight; HTML slider value is bootstrap only.
        const jumpSlider = byId('spriteJumpHeightSlider');
        const jumpVal = byId('spriteJumpHeightVal');
        if (typeof cam.spriteJumpHeight === 'number') {
            if (jumpSlider && document.activeElement !== jumpSlider) {
                jumpSlider.value = String(cam.spriteJumpHeight);
            }
            if (jumpVal) jumpVal.innerText = Number(cam.spriteJumpHeight).toFixed(2);
        }

        const speed = typeof s.TIME_SPEED === 'number' ? s.TIME_SPEED : 1;
        const speedSlider = byId('timeSpeedSlider');
        const speedVal = byId('timeSpeedVal');
        if (speedSlider && document.activeElement !== speedSlider) {
            speedSlider.value = String(speed);
        }
        if (speedVal) speedVal.innerText = Number(speed).toFixed(2);

        const dbg = s.debugAI || {};
        const master = byId('aiDebugEnabled');
        if (master) master.checked = !!dbg.enabled;
        document.querySelectorAll('.ai-debug-flag').forEach((el) => {
            const flag = el.getAttribute('data-flag');
            if (flag) el.checked = !!dbg[flag];
        });

        const feat = s.features || {};
        const expToggle = byId('expProgressionToggle');
        const skillToggle = byId('skillProgressionToggle');
        if (expToggle) expToggle.checked = !!feat.expProgression;
        if (skillToggle) skillToggle.checked = !!feat.skillProgression;

        const rates = s.expRates || {};
        document.querySelectorAll('.exp-rate-input').forEach((el) => {
            const key = el.getAttribute('data-rate');
            if (!key) return;
            const v = rates[key];
            if (typeof v === 'number' && Number.isFinite(v)) {
                el.value = String(v);
            }
        });

        applyMouseControlsToForm(s);
        applyLayoutCountsToForm(s);
        applySessionToForm(s);
        applyProgressionLock(s);

        suppress = false;
    }

    /**
     * Action bar toolbars per dock (0–3). Source of truth is parent action_bars.
     * @param {object|null|undefined} s
     */
    function applyLayoutCountsToForm(s) {
        const lc = (s && s.layoutCounts) || {};
        const docks = [
            { id: 'actionBarCountTop', key: 'top' },
            { id: 'actionBarCountBottom', key: 'bottom' },
            { id: 'actionBarCountLeft', key: 'left' },
            { id: 'actionBarCountRight', key: 'right' }
        ];
        for (let i = 0; i < docks.length; i++) {
            const el = byId(docks[i].id);
            if (!el) continue;
            let n =
                typeof lc[docks[i].key] === 'number' && Number.isFinite(lc[docks[i].key])
                    ? Math.floor(lc[docks[i].key])
                    : 1;
            if (n < 0) n = 0;
            if (n > 3) n = 3;
            el.value = String(n);
        }
    }

    /**
     * Mouse control mode + classic-only loot sub-mode (docs/29 Stage 3–4).
     * Modes: 0 Regular, 1 Classic, 2 Left Smart-Click.
     * @param {object|null|undefined} s
     */
    function applyMouseControlsToForm(s) {
        const mc = (s && s.mouseControls) || {};
        let mode =
            typeof mc.mouseControlMode === 'number' && Number.isFinite(mc.mouseControlMode)
                ? Math.floor(mc.mouseControlMode)
                : 1;
        if (mode !== 0 && mode !== 1 && mode !== 2) mode = 1;

        const modeSelect = byId('mouseControlModeSelect');
        if (modeSelect) modeSelect.value = String(mode);

        let loot =
            typeof mc.lootControlMode === 'number' && Number.isFinite(mc.lootControlMode)
                ? Math.floor(mc.lootControlMode)
                : 0;
        if (loot !== 0 && loot !== 1 && loot !== 2) loot = 0;
        const lootSelect = byId('lootControlModeSelect');
        if (lootSelect) lootSelect.value = String(loot);

        const lootWrap = byId('lootControlModeWrap');
        if (lootWrap) {
            lootWrap.hidden = mode !== 1;
        }

        const moveStackEl = byId('moveStackCheck');
        if (moveStackEl) {
            moveStackEl.checked = mc.moveStack === true;
        }
    }

    /**
     * Progression knobs only before run (session.live).
     * @param {object|null|undefined} s
     */
    function applyProgressionLock(s) {
        const session = (s && s.session) || {};
        const locked = !!session.live;
        document.querySelectorAll('.progression-flag, .exp-rate-input').forEach((el) => {
            el.disabled = locked;
        });
        const hint = byId('progressionLockHint');
        if (hint) hint.hidden = !locked;
    }

    function collectDebugAIFromForm() {
        const debugAI = {
            enabled: !!byId('aiDebugEnabled')?.checked,
            states: false,
            paths: false,
            targets: false,
            ranges: false,
            spawns: false,
            hitSources: false,
            tileTypes: false
        };
        document.querySelectorAll('.ai-debug-flag').forEach((el) => {
            const flag = el.getAttribute('data-flag');
            if (flag && DEBUG_FLAGS.indexOf(flag) !== -1) {
                debugAI[flag] = !!el.checked;
            }
        });
        return debugAI;
    }

    function collectPatchFromEvent(target) {
        if (!target || !target.id) return null;
        const id = target.id;
        const patch = {};

        if (id === 'scaleSlider' || id === 'spriteJumpHeightSlider') {
            const patchCam = {};
            if (byId('scaleSlider')) {
                const val = parseInt(byId('scaleSlider').value, 10);
                if (byId('scaleVal')) byId('scaleVal').innerText = String(val);
                patchCam.scale = val;
            }
            if (byId('spriteJumpHeightSlider')) {
                const val = parseFloat(byId('spriteJumpHeightSlider').value);
                if (byId('spriteJumpHeightVal')) byId('spriteJumpHeightVal').innerText = Number(val).toFixed(2);
                patchCam.spriteJumpHeight = val;
            }
            patch.camera = patchCam;
            return patch;
        }

        if (id === 'timeSpeedSlider') {
            const val = parseFloat(byId('timeSpeedSlider').value);
            if (byId('timeSpeedVal')) {
                byId('timeSpeedVal').innerText = Number(val).toFixed(2);
            }
            patch.TIME_SPEED = val;
            return patch;
        }

        if (id === 'aiDebugEnabled' || target.classList.contains('ai-debug-flag')) {
            const debugAI = collectDebugAIFromForm();
            // Checking a layer implies master on
            if (target.classList.contains('ai-debug-flag') && target.checked) {
                debugAI.enabled = true;
                if (byId('aiDebugEnabled')) byId('aiDebugEnabled').checked = true;
            }
            patch.debugAI = debugAI;
            return patch;
        }

        if (
            id === 'expProgressionToggle' ||
            id === 'skillProgressionToggle' ||
            target.classList.contains('progression-flag')
        ) {
            patch.features = {
                expProgression: !!byId('expProgressionToggle')?.checked,
                skillProgression: !!byId('skillProgressionToggle')?.checked
            };
            return patch;
        }

        if (target.classList.contains('exp-rate-input')) {
            const expRates = {};
            document.querySelectorAll('.exp-rate-input').forEach((el) => {
                const key = el.getAttribute('data-rate');
                if (!key) return;
                const n = parseFloat(el.value);
                expRates[key] = Number.isFinite(n) ? n : 0;
            });
            patch.expRates = expRates;
            return patch;
        }

        if (
            id === 'mouseControlModeSelect' ||
            id === 'lootControlModeSelect' ||
            id === 'moveStackCheck'
        ) {
            const modeEl = byId('mouseControlModeSelect');
            const lootEl = byId('lootControlModeSelect');
            const moveStackEl = byId('moveStackCheck');
            let mode = modeEl ? parseInt(modeEl.value, 10) : 1;
            if (mode !== 0 && mode !== 1 && mode !== 2) mode = 1;
            let loot = lootEl ? parseInt(lootEl.value, 10) : 0;
            if (loot !== 0 && loot !== 1 && loot !== 2) loot = 0;
            const lootWrap = byId('lootControlModeWrap');
            if (lootWrap) lootWrap.hidden = mode !== 1;
            patch.mouseControls = {
                mouseControlMode: mode,
                lootControlMode: loot,
                moveStack: !!(moveStackEl && moveStackEl.checked)
            };
            return patch;
        }

        if (
            id === 'actionBarCountTop' ||
            id === 'actionBarCountBottom' ||
            id === 'actionBarCountLeft' ||
            id === 'actionBarCountRight' ||
            (target.classList && target.classList.contains('action-bar-count-select'))
        ) {
            const parseCount = (elId) => {
                const el = byId(elId);
                let n = el ? parseInt(el.value, 10) : 1;
                if (!Number.isFinite(n)) n = 1;
                if (n < 0) n = 0;
                if (n > 3) n = 3;
                return n;
            };
            patch.layoutCounts = {
                top: parseCount('actionBarCountTop'),
                bottom: parseCount('actionBarCountBottom'),
                left: parseCount('actionBarCountLeft'),
                right: parseCount('actionBarCountRight')
            };
            return patch;
        }

        return null;
    }

    function emitFromEvent(e) {
        if (suppress) return;
        const target = e.target;
        if (!target) return;

        // Scrubber is a session command, not a Settings patch
        if (target.id === 'playbackSlider') {
            const t = parseInt(target.value, 10);
            const scrubVal = byId('playbackFrameVal');
            const max =
                state &&
                state.session &&
                state.session.playback &&
                typeof state.session.playback.max === 'number'
                    ? state.session.playback.max
                    : 0;
            if (scrubVal) scrubVal.innerText = `${t} / ${max}`;
            clearTimeout(seekDebounceTimer);
            const immediate = e.type === 'change';
            const send = () => post({ type: 'command', command: 'seek', tick: t });
            if (immediate) {
                send();
            } else {
                seekDebounceTimer = setTimeout(send, 200);
            }
            return;
        }

        const patch = collectPatchFromEvent(target);
        if (patch) post({ type: 'patch', patch });
    }

    function bindSessionButtons() {
        const playBtn = byId('sessionPlayBtn');
        const pauseBtn = byId('sessionPauseBtn');
        const stopBtn = byId('sessionStopBtn');
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                post({ type: 'command', command: 'play' });
            });
        }
        if (pauseBtn) {
            pauseBtn.addEventListener('click', () => {
                post({ type: 'command', command: 'pause' });
            });
        }
        if (stopBtn) {
            stopBtn.addEventListener('click', () => {
                post({ type: 'command', command: 'stop' });
            });
        }
    }

    function initForm() {
        const title = document.querySelector('.engine-tweakings-panel .card-title');
        if (title) title.classList.add('d-none');

        document.body.addEventListener('input', emitFromEvent);
        document.body.addEventListener('change', emitFromEvent);
        bindSessionButtons();

        // Ask parent for live Settings (source of truth) — do not trust HTML defaults
        post({ type: 'ready' });
    }

    // Parent may re-send state when focusing an already-open popup
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            post({ type: 'ready' });
        }
    });

    window.addEventListener('message', (event) => {
        if (event.origin !== window.location.origin) return;
        const data = event.data;
        if (!data || data.channel !== CHANNEL) return;
        if (data.type === 'state' && data.state) {
            applyStateToForm(data.state);
        }
    });

    window.addEventListener('beforeunload', () => {
        post({ type: 'closing' });
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initForm);
    } else {
        initForm();
    }
})();
