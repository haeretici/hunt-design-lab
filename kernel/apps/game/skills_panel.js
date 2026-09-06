/**
 * Skills panel — live skill values for the active camera player
 * (or idle form party member when no session).
 */

'use strict';

const { getActivePlayerFromSim } = require('./equipment_panel.js');
const {
    getExpForLevel,
    getReqSkillTries,
    getReqMana,
    skillBase,
    resolvePlayerVocationSkillRates
} = require('../../core/lib/character/progression.js');

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
 * Resolve class vocation skillRates from player or preset.
 * @param {object|null|undefined} source
 * @returns {object|null}
 */
function resolveVocationRates(source) {
    if (!source || typeof source !== 'object') return null;
    const fromProg = resolvePlayerVocationSkillRates(source);
    if (fromProg) return fromProg;
    const cid = source.classId || source.vocation || source.class;
    if (cid) {
        try {
            const presets = require('../../core/lib/presets.js');
            const cls = presets.getClass(String(cid));
            if (cls && cls.skillRates) return cls.skillRates;
        } catch (_) {
            /* optional */
        }
    }
    return null;
}

/**
 * Calculate level progression percent and remaining percent to go.
 * Reference: reference client format ("You have 88.31 percent to go").
 *
 * @param {object|null|undefined} source
 * @returns {{ percent: number, percentToGo: number, tooltip: string }}
 */
function getLevelProgress(source) {
    if (!source || typeof source !== 'object') {
        return { percent: 0, percentToGo: 100, tooltip: 'You have 100.00 percent to go' };
    }
    const level =
        source.level != null && Number.isFinite(Number(source.level))
            ? Math.max(1, Math.floor(Number(source.level)))
            : 1;
    const currLevelExp = getExpForLevel(level);
    const nextLevelExp = getExpForLevel(level + 1);
    const span = nextLevelExp - currLevelExp;

    let percent = 0;
    if (source.levelPercent != null && Number.isFinite(Number(source.levelPercent))) {
        percent = Math.max(0, Math.min(100, Number(source.levelPercent)));
    } else if (span > 0) {
        let exp = null;
        if (source.experience != null && Number.isFinite(Number(source.experience))) {
            exp = Number(source.experience);
        } else if (source.exp != null && Number.isFinite(Number(source.exp))) {
            exp = Number(source.exp);
        }
        if (exp != null) {
            const expInLevel = Math.max(0, exp - currLevelExp);
            const rawPct = (expInLevel * 100) / span;
            percent = Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100));
        } else if (Number.isFinite(Number(source.level)) && Number(source.level) > level) {
            const frac = Number(source.level) - level;
            percent = Math.min(100, Math.max(0, Math.round(frac * 10000) / 100));
        }
    }

    const percentToGo = Math.max(0, Math.min(100, Math.round((100 - percent) * 100) / 100));
    const tooltip = `You have ${percentToGo.toFixed(2)} percent to go`;
    return { percent, percentToGo, tooltip };
}

/**
 * Calculate skill progression percent and remaining percent to go.
 * Reference: reference client format ("You have 88.31 percent to go").
 *
 * @param {object|null|undefined} source
 * @param {{ key: string, label: string, aliases?: string[] }} def
 * @param {number|null} curLevel
 * @param {object|null} [vocationRates]
 * @returns {{ percent: number, percentToGo: number, tooltip: string }|null}
 */
function getSkillProgress(source, def, curLevel, vocationRates) {
    if (curLevel == null || !source || typeof source !== 'object') {
        return null;
    }
    const level = Math.max(0, Math.floor(curLevel));
    const key = def.key;
    const aliases = def.aliases || [];

    // Check explicit skillsPercent bag if present
    if (source.skillsPercent && typeof source.skillsPercent === 'object') {
        let explicit = source.skillsPercent[key];
        if (explicit == null) {
            for (let i = 0; i < aliases.length; i++) {
                if (source.skillsPercent[aliases[i]] != null) {
                    explicit = source.skillsPercent[aliases[i]];
                    break;
                }
            }
        }
        if (explicit != null && Number.isFinite(Number(explicit))) {
            const percent = Math.max(0, Math.min(100, Math.round(Number(explicit) * 100) / 100));
            const percentToGo = Math.max(0, Math.min(100, Math.round((100 - percent) * 100) / 100));
            return {
                percent,
                percentToGo,
                tooltip: `You have ${percentToGo.toFixed(2)} percent to go`
            };
        }
    }

    const isMagic = key === 'magicLevel' || key === 'magic';
    if (isMagic) {
        const nextMl = level + 1;
        const reqMana = getReqMana(nextMl, vocationRates);
        let curMana = 0;
        if (source._manaTowardMagic != null && Number.isFinite(Number(source._manaTowardMagic))) {
            curMana = Number(source._manaTowardMagic);
        } else if (source.manaTowardMagic != null && Number.isFinite(Number(source.manaTowardMagic))) {
            curMana = Number(source.manaTowardMagic);
        } else if (source._skillTryProgress && typeof source._skillTryProgress === 'object') {
            const val = source._skillTryProgress.magicLevel ?? source._skillTryProgress.magic;
            if (val != null && Number.isFinite(Number(val))) curMana = Number(val);
        } else if (source.skillTryProgress && typeof source.skillTryProgress === 'object') {
            const val = source.skillTryProgress.magicLevel ?? source.skillTryProgress.magic;
            if (val != null && Number.isFinite(Number(val))) curMana = Number(val);
        } else if (source.skillsProgress && typeof source.skillsProgress === 'object') {
            const val = source.skillsProgress.magicLevel ?? source.skillsProgress.magic;
            if (val != null && Number.isFinite(Number(val))) curMana = Number(val);
        } else if (source._skillsProgress && typeof source._skillsProgress === 'object') {
            const val = source._skillsProgress.magicLevel ?? source._skillsProgress.magic;
            if (val != null && Number.isFinite(Number(val))) curMana = Number(val);
        }

        if (curMana === 0 && source.skills && typeof source.skills === 'object') {
            const rawVal = Number(source.skills[key] != null ? source.skills[key] : (source.skills.magic != null ? source.skills.magic : null));
            if (Number.isFinite(rawVal) && rawVal > level && reqMana > 0) {
                curMana = (rawVal - level) * reqMana;
            }
        }

        let percent = 0;
        if (reqMana > 0) {
            const rawPct = (Math.max(0, curMana) * 100) / reqMana;
            percent = Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100));
        }
        const percentToGo = Math.max(0, Math.min(100, Math.round((100 - percent) * 100) / 100));
        return {
            percent,
            percentToGo,
            tooltip: `You have ${percentToGo.toFixed(2)} percent to go`
        };
    }

    // Regular skills (sword, axe, club, fist, distance, shielding, fishing)
    const need = getReqSkillTries(key, level + 1, vocationRates);
    const reqTries = need > 0 ? need : skillBase(key);

    let curTries = 0;
    const checkBags = [
        source._skillTryProgress,
        source.skillTryProgress,
        source.skillsProgress,
        source._skillsProgress,
        source.skillTries
    ];
    let found = false;
    for (let b = 0; b < checkBags.length; b++) {
        const bag = checkBags[b];
        if (bag && typeof bag === 'object') {
            if (bag[key] != null && Number.isFinite(Number(bag[key]))) {
                curTries = Number(bag[key]);
                found = true;
                break;
            }
            for (let a = 0; a < aliases.length; a++) {
                if (bag[aliases[a]] != null && Number.isFinite(Number(bag[aliases[a]]))) {
                    curTries = Number(bag[aliases[a]]);
                    found = true;
                    break;
                }
            }
            if (found) break;
            if (key === 'shielding' && bag.shield != null && Number.isFinite(Number(bag.shield))) {
                curTries = Number(bag.shield);
                found = true;
                break;
            }
            if ((key === 'sword' || key === 'axe' || key === 'club' || key === 'fist') &&
                bag.melee != null && Number.isFinite(Number(bag.melee))) {
                curTries = Number(bag.melee);
                found = true;
                break;
            }
        }
    }

    if (!found && source.skills && typeof source.skills === 'object') {
        const rawVal = Number(source.skills[key]);
        if (Number.isFinite(rawVal) && rawVal > level && reqTries > 0) {
            curTries = (rawVal - level) * reqTries;
        }
    }

    let percent = 0;
    if (reqTries > 0) {
        const rawPct = (Math.max(0, curTries) * 100) / reqTries;
        percent = Math.min(100, Math.max(0, Math.round(rawPct * 100) / 100));
    }
    const percentToGo = Math.max(0, Math.min(100, Math.round((100 - percent) * 100) / 100));
    return {
        percent,
        percentToGo,
        tooltip: `You have ${percentToGo.toFixed(2)} percent to go`
    };
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

        const vocationRates = resolveVocationRates(source);
        const levelProg = getLevelProgress(source);
        const levelPct = Math.max(0, Math.min(100, levelProg.percent));

        const parts = [`L${level}`, String(levelPct), name];
        /** @type {{ key: string, label: string, value: number|null, percent: number|null, tooltip: string|null }[]} */
        const rows = [];
        for (let i = 0; i < SKILL_ROWS.length; i++) {
            const def = SKILL_ROWS[i];
            const val = readSkill(skills, def.key, def.aliases);
            const prog = val != null ? getSkillProgress(source, def, val, vocationRates) : null;
            const pct = prog != null ? prog.percent : null;
            const tip = prog != null ? prog.tooltip : null;
            rows.push({
                key: def.key,
                label: def.label,
                value: val,
                percent: pct,
                tooltip: tip
            });
            parts.push(`${def.key}:${val == null ? '-' : val}:${pct == null ? '-' : pct}`);
        }
        const sig = parts.join('|');
        if (sig === lastSig) return;
        lastSig = sig;

        const levelStyle = `background: linear-gradient(to right, #31582f ${levelPct}%, #0a0d12 ${levelPct}%);`;
        let html = `<div class="skills-panel-level" title="${escapeHtml(levelProg.tooltip)}" style="${levelStyle}">
            <span class="skills-panel-level-label">Level</span>
            <span class="skills-panel-level-value">${level}</span>
        </div>`;
        html += '<div class="skills-panel-grid">';
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const display = r.value == null ? '—' : String(r.value);
            const titleAttr = r.tooltip ? ` title="${escapeHtml(r.tooltip)}"` : '';
            const rowPct = r.percent != null ? Math.max(0, Math.min(100, r.percent)) : null;
            const rowStyle = rowPct != null
                ? ` style="background: linear-gradient(to right, #31582f ${rowPct}%, rgba(0, 0, 0, 0.25) ${rowPct}%);"`
                : '';
            html += `<div class="skills-panel-row" data-skill="${escapeHtml(r.key)}"${titleAttr}${rowStyle}>
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
    getLevelProgress,
    getSkillProgress,
    bindSkillsPanel,
    escapeHtml
};
