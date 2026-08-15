/**
 * Wiki shell — content mode selector + embed dual-mode catalog browsers
 * (creatures / equipment) in view mode.
 *
 * Shared UI lives under html/widgets/designer_pickers/* and is also used
 * as selection popups (uiMode=select) from Designer / future Select buttons.
 */

'use strict';

const { appUrl } = require('../../core/lib/app_paths.js');
const {
    setPreferredContentModeId,
    resolvePreferredContentModeId
} = require('../../core/lib/ui_preferences.js');

/**
 * @returns {'creatures'|'equipment'|'spells'}
 */
function wikiKind() {
    const fromWin =
        typeof window !== 'undefined' && window.__WIKI_KIND__
            ? String(window.__WIKI_KIND__)
            : '';
    const fromBody =
        typeof document !== 'undefined' && document.body
            ? String(document.body.getAttribute('data-wiki-kind') || '')
            : '';
    const kind = fromWin || fromBody || 'creatures';
    if (kind === 'equipment') return 'equipment';
    if (kind === 'spells') return 'spells';
    return 'creatures';
}

/**
 * @returns {Array<{id: string, label?: string, genre?: string, isDefault?: boolean}>}
 */
function modesList() {
    if (typeof window !== 'undefined' && Array.isArray(window.__MODES__)) {
        return window.__MODES__;
    }
    return [
        { id: 'standard', label: 'Standard', genre: 'rpg_fantasy', isDefault: true },
        { id: 'legacy', label: 'Legacy (dev port)', genre: 'rpg_fantasy', isDefault: false }
    ];
}

/**
 * @param {string} modeId
 * @returns {string}
 */
function genreForMode(modeId) {
    const m = modesList().find((x) => x && x.id === modeId);
    if (m && m.genre) return String(m.genre);
    return 'rpg_fantasy';
}

/**
 * Widget path for the catalog browser (shared select/view UI).
 * @param {'creatures'|'equipment'|'spells'} kind
 * @returns {string}
 */
function pickerPath(kind) {
    if (kind === 'equipment') {
        return 'html/widgets/designer_pickers/equipment_picker.html';
    }
    if (kind === 'spells') {
        return 'html/widgets/designer_pickers/spell_picker.html';
    }
    return 'html/widgets/designer_pickers/creature_picker.html';
}

/**
 * @param {{ mode: string, kind: 'creatures'|'equipment'|'spells' }} opts
 * @returns {string}
 */
function buildFrameSrc(opts) {
    const url = new URL(appUrl(pickerPath(opts.kind)), window.location.href);
    url.searchParams.set('uiMode', 'view');
    url.searchParams.set('mode', opts.mode);
    url.searchParams.set('genre', genreForMode(opts.mode));
    url.searchParams.set(
        'title',
        opts.kind === 'equipment' ? 'Equipment wiki' : (opts.kind === 'spells' ? 'Spells wiki' : 'Creature wiki')
    );
    return url.href;
}

/**
 * @returns {Promise<void>}
 */
async function initWikiApp() {
    const kind = wikiKind();
    const modes = modesList();
    const availableIds = modes.map((m) => String(m.id));

    const urlMode = (() => {
        try {
            return new URL(window.location.href).searchParams.get('mode') || '';
        } catch (_) {
            return '';
        }
    })();

    let modeId = resolvePreferredContentModeId({
        availableIds,
        fallback:
            urlMode ||
            (typeof window !== 'undefined' && window.__CONTENT_MODE__
                ? String(window.__CONTENT_MODE__)
                : 'standard'),
        defaultId: 'standard'
    });

    const modeSelect = document.getElementById('wikiModeSelect');
    const frame = document.getElementById('wikiFrame');

    if (modeSelect) {
        modeSelect.innerHTML = modes
            .map((m) => {
                const id = String(m.id);
                const label = String(m.label || m.id);
                const sel = id === modeId ? ' selected' : '';
                return `<option value="${id}"${sel}>${label}</option>`;
            })
            .join('');
        modeSelect.addEventListener('change', () => {
            modeId = String(modeSelect.value || 'standard');
            setPreferredContentModeId(modeId);
            try {
                const u = new URL(window.location.href);
                u.searchParams.set('mode', modeId);
                window.history.replaceState({}, '', u.href);
            } catch (_) {
                /* ignore */
            }
            reloadFrame();
        });
    }

    function reloadFrame() {
        if (!frame) return;
        frame.src = buildFrameSrc({ mode: modeId, kind });
    }

    setPreferredContentModeId(modeId);
    reloadFrame();
}

module.exports = { initWikiApp, wikiKind, buildFrameSrc };
