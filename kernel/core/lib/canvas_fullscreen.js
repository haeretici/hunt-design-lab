/**
 * Full-screen canvas shell (soccer-oss parity).
 * CSS-scales the canvas to fit the viewport while keeping internal resolution;
 * native Fullscreen API when available, fixed overlay fallback otherwise.
 */

'use strict';

/** Hunt / Scenario Lab logical canvas size (matches templates). */
const DEFAULT_CANVAS_W = 720;
const DEFAULT_CANVAS_H = 480;

/**
 * @returns {boolean}
 */
function isNativeFullscreen() {
    return !!(
        document.fullscreenElement
        || document.webkitFullscreenElement
        || document.mozFullScreenElement
        || document.msFullscreenElement
    );
}

/**
 * Wire full-screen toggle on a canvas container.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.container - Element that goes full-screen (`.canvas-container`)
 * @param {HTMLCanvasElement|null} [opts.canvas]
 * @param {HTMLElement|null} [opts.toggleBtn]
 * @param {number} [opts.logicalW=720]
 * @param {number} [opts.logicalH=480]
 * @param {string} [opts.enterIconId='enterFullscreenIcon']
 * @param {string} [opts.exitIconId='exitFullscreenIcon']
 * @returns {{ dispose: () => void, isActive: () => boolean, toggle: () => void } | null}
 */
function bindCanvasFullscreen(opts) {
    if (!opts || !opts.container) return null;

    const container = opts.container;
    const canvas = opts.canvas || null;
    const toggleBtn = opts.toggleBtn || null;
    const logicalW = opts.logicalW > 0 ? opts.logicalW : DEFAULT_CANVAS_W;
    const logicalH = opts.logicalH > 0 ? opts.logicalH : DEFAULT_CANVAS_H;
    const enterIconId = opts.enterIconId || 'enterFullscreenIcon';
    const exitIconId = opts.exitIconId || 'exitFullscreenIcon';

    const fitCanvasToFullscreen = () => {
        if (!canvas || !container.classList.contains('is-fullscreen')) return;
        let vw = window.innerWidth;
        let vh = window.innerHeight;
        const parent = canvas.parentElement;
        if (parent && parent !== container && parent.clientWidth > 0 && parent.clientHeight > 0) {
            vw = parent.clientWidth;
            vh = parent.clientHeight;
        }
        const scale = Math.min(vw / logicalW, vh / logicalH);
        const cssW = Math.floor(logicalW * scale);
        const cssH = Math.floor(logicalH * scale);
        canvas.style.setProperty('width', `${cssW}px`, 'important');
        canvas.style.setProperty('height', `${cssH}px`, 'important');
        canvas.style.setProperty('max-width', '100%', 'important');
        canvas.style.setProperty('max-height', '100%', 'important');
    };

    const clearCanvasInlineSize = () => {
        if (!canvas) return;
        canvas.style.removeProperty('width');
        canvas.style.removeProperty('height');
        canvas.style.removeProperty('max-width');
        canvas.style.removeProperty('max-height');
    };

    const setFullscreenUi = (active) => {
        const enterIcon = document.getElementById(enterIconId);
        const exitIcon = document.getElementById(exitIconId);
        container.classList.toggle('is-fullscreen', active);
        if (active) {
            if (enterIcon) enterIcon.style.display = 'none';
            if (exitIcon) exitIcon.style.display = 'block';
            if (toggleBtn) toggleBtn.setAttribute('title', 'Exit Full Screen');
            fitCanvasToFullscreen();
        } else {
            if (enterIcon) enterIcon.style.display = 'block';
            if (exitIcon) exitIcon.style.display = 'none';
            if (toggleBtn) toggleBtn.setAttribute('title', 'Full Screen');
            clearCanvasInlineSize();
        }
    };

    const enterFullscreen = () => {
        const req = container.requestFullscreen
            || container.webkitRequestFullscreen
            || container.mozRequestFullScreen
            || container.msRequestFullscreen;
        if (req) {
            Promise.resolve(req.call(container)).catch(() => {
                setFullscreenUi(true);
            });
        } else {
            setFullscreenUi(true);
        }
    };

    const exitFullscreen = () => {
        if (isNativeFullscreen()) {
            const exit = document.exitFullscreen
                || document.webkitExitFullscreen
                || document.mozCancelFullScreen
                || document.msExitFullscreen;
            if (exit) exit.call(document);
        }
        setFullscreenUi(false);
    };

    const toggle = () => {
        if (isNativeFullscreen() || container.classList.contains('is-fullscreen')) {
            exitFullscreen();
        } else {
            enterFullscreen();
        }
    };

    const onToggleClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
    };

    const onFullscreenChange = () => {
        setFullscreenUi(isNativeFullscreen());
    };

    const onResize = () => {
        if (container.classList.contains('is-fullscreen')) {
            fitCanvasToFullscreen();
        }
    };

    if (toggleBtn) {
        toggleBtn.addEventListener('click', onToggleClick);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('mozfullscreenchange', onFullscreenChange);
    document.addEventListener('MSFullscreenChange', onFullscreenChange);
    window.addEventListener('resize', onResize);

    return {
        toggle,
        isActive: () => isNativeFullscreen() || container.classList.contains('is-fullscreen'),
        dispose: () => {
            if (toggleBtn) {
                toggleBtn.removeEventListener('click', onToggleClick);
            }
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
            document.removeEventListener('mozfullscreenchange', onFullscreenChange);
            document.removeEventListener('MSFullscreenChange', onFullscreenChange);
            window.removeEventListener('resize', onResize);
            if (container.classList.contains('is-fullscreen')) {
                exitFullscreen();
            }
        }
    };
}

module.exports = {
    DEFAULT_CANVAS_W,
    DEFAULT_CANVAS_H,
    isNativeFullscreen,
    bindCanvasFullscreen
};
