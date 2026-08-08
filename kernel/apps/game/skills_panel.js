/**
 * Skills panel — live skill values for the active camera player
 * (or idle form party member when no session).
 */

'use strict';

const { getActivePlayerFromSim } = require('./equipment_panel.js');

/** Display order (matches Character Profile Preview skill table). */
const SKILL_ROWS = Object.freeze([
    { key: 'axe', label: 'Axe' },
    { key: 'club', label: 'Club' },
    { key: 'distance', label: 'Distance' },
    { key: 'fishing', label: 'Fishing' },
    { key: 'fist', label: 'Fist' },
    { key: 'magicLevel', label: 'Magic Level', aliases: ['magic'] },
    { key: 'shielding', label: 'Shielding' },
    { key: 'sword', label: 'Sword' }
]);

/**
 * @param {*} value
 * @returns {string}
 */
function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Read a skill number from a bag (supports aliases).
 * @param {object|null|undefined} skills
 * @param {string} key
 * @param {string[]} [aliases]
 * @returns {number|null}
 */
function readSkill(skills, key, aliases) {
    if (!skills || typeof skills !== 'object') return null;
    if (skills[key] != null && skills[key] !== '') {
        const n = Number(skills[key]);
        return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
    }
    if (aliases) {
        for (let i = 0; i < aliases.length; i++) {
            const a = aliases[i];
            if (skills[a] != null && skills[a] !== '') {
                const n = Number(skills[a]);
                if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
            }
        }
    }
    return null;
}

/**
 * Wire Skills panel with dirty-only paint.
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {() => object|null} [opts.getIdleMember] active form member when idle
 * @param {() => boolean} [opts.isSessionLive]
 * @param {number} [opts.intervalMs=250] 0 = no internal timer
 * @returns {{ refresh: () => void, dispose: () => void }}
 */
function bindSkillsPanel(opts) {
    const o = opts || {};
    if (typeof document === 'undefined') {
        return { refresh: () => {}, dispose: () => {} };
    }

    const listEl = document.getElementById('skillsPanelList');
    let timer = null;
    /** @type {string} */
    let lastSig = '';

    const refresh = () => {
        if (!listEl) return;
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        const live = typeof o.isSessionLive === 'function' ? !!o.isSessionLive() : !!sim;

        /** @type {object|null} */
        let source = null;
        if (sim && live) {
            source = getActivePlayerFromSim(sim);
        }
        if (!source && typeof o.getIdleMember === 'function') {
            source = o.getIdleMember() || null;
        }

        if (!source) {
            if (lastSig !== 'empty') {
                listEl.innerHTML =
                    '<p class="text-muted small mb-0 p-1">No character</p>';
                lastSig = 'empty';
            }
            return;
        }

        const skills =
            source.skills && typeof source.skills === 'object' ? source.skills : {};
        const level =
            source.level != null && Number.isFinite(Number(source.level))
                ? Math.max(1, Math.floor(Number(source.level)))
                : 1;
        const name = String(
            source.name || source.label || source.classId || source.vocation || 'Character'
        );

        const parts = [`L${level}`, name];
        /** @type {{ key: string, label: string, value: number|null }[]} */
        const rows = [];
        for (let i = 0; i < SKILL_ROWS.length; i++) {
            const def = SKILL_ROWS[i];
            const val = readSkill(skills, def.key, def.aliases);
            rows.push({ key: def.key, label: def.label, value: val });
            parts.push(`${def.key}:${val == null ? '-' : val}`);
        }
        const sig = parts.join('|');
        if (sig === lastSig) return;
        lastSig = sig;

        let html = `<div class="skills-panel-level">
            <span class="skills-panel-level-label">Level</span>
            <span class="skills-panel-level-value">${level}</span>
        </div>`;
        html += '<div class="skills-panel-grid">';
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const display = r.value == null ? '—' : String(r.value);
            html += `<div class="skills-panel-row" data-skill="${escapeHtml(r.key)}">
                <span class="skills-panel-name">${escapeHtml(r.label)}</span>
                <span class="skills-panel-value">${escapeHtml(display)}</span>
            </div>`;
        }
        html += '</div>';
        listEl.innerHTML = html;
    };

    const intervalMs = o.intervalMs != null ? o.intervalMs : 250;
    refresh();
    if (intervalMs > 0) {
        timer = setInterval(refresh, intervalMs);
    }

    return {
        refresh,
        dispose: () => {
            if (timer) clearInterval(timer);
            timer = null;
        }
    };
}

module.exports = {
    SKILL_ROWS,
    readSkill,
    bindSkillsPanel,
    escapeHtml
};
