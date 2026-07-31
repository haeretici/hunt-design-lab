/**
 * Browser bug report — collect session context + POST JSON to bugs/.
 * Used by Hunt Simulator and Scenario Lab (Report Bug modal).
 *
 * schemaVersion 2 (min): party skill/profile flags, structured waves,
 * top spells, live member HP snapshot. Repro input stays seed + members
 * (schema 1 files still map via bugReportToRunnerInput).
 */

'use strict';

const { membersToPartyConfig } = require('./party_form.js');
const {
    snapshotFromSim,
    sortedCountEntries
} = require('./live_panel.js');

/** Schema version for bugs/*.json (bump when fields change). */
const BUG_REPORT_SCHEMA_VERSION = 2;

/** Max description length (matches PHP + textarea maxlength). */
const MAX_DESCRIPTION_CHARS = 8000;

/** Cap spell-id rows in session / live member snapshots. */
const TOP_SPELLS_LIMIT = 12;
const LIVE_MEMBER_TOP_SPELLS = 5;

/**
 * @param {Document} [doc]
 * @returns {Record<string, HTMLElement|null>}
 */
function bindBugReportElements(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return {};
    return {
        bugReportBtn: d.getElementById('bugReportBtn'),
        bugReportModal: d.getElementById('bugReportModal'),
        bugReportDescription: d.getElementById('bugReportDescription'),
        bugReportSave: d.getElementById('bugReportSave'),
        bugReportCancel: d.getElementById('bugReportCancel'),
        bugReportClose: d.getElementById('bugReportClose'),
        bugReportStatus: d.getElementById('bugReportStatus')
    };
}

/**
 * Open/close the bug report modal (same pattern as party details).
 * @param {HTMLElement|null} modal
 * @param {boolean} open
 */
function setBugReportOpen(modal, open) {
    if (!modal) return;
    if (open) {
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        if (typeof document !== 'undefined') {
            document.body.classList.add('bug-report-open');
        }
    } else {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        if (typeof document !== 'undefined') {
            document.body.classList.remove('bug-report-open');
        }
    }
}

/**
 * Normalize party member gear rows for the report (enabled slots only).
 * @param {object[]|null|undefined} formMembers party editor rows
 * @returns {object[]}
 */
function partyMembersForReport(formMembers) {
    return membersToPartyConfig(formMembers || []);
}

/**
 * True when a member bag carries a non-empty skills object.
 * @param {object|null|undefined} m
 * @returns {boolean}
 */
function memberHasSkills(m) {
    return !!(
        m &&
        m.skills &&
        typeof m.skills === 'object' &&
        Object.keys(m.skills).length > 0
    );
}

/**
 * Diagnostic flags for form party vs profile expansion (schema v2).
 * Helps spot "partyId label but class-default skills" mismatches.
 *
 * @param {object[]} members party config rows (enabled only)
 * @returns {{
 *   memberCount: number,
 *   membersHaveSkills: boolean,
 *   membersHaveProfileId: boolean,
 *   membersWithSkills: number,
 *   membersWithProfileId: number,
 *   allMembersHaveSkills: boolean
 * }}
 */
function partyDiagnostics(members) {
    const list = Array.isArray(members) ? members : [];
    let withSkills = 0;
    let withProfile = 0;
    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (memberHasSkills(m)) withSkills += 1;
        if (m && m.profileId != null && String(m.profileId).trim() !== '') {
            withProfile += 1;
        }
    }
    const n = list.length;
    return {
        memberCount: n,
        membersHaveSkills: withSkills > 0,
        membersHaveProfileId: withProfile > 0,
        membersWithSkills: withSkills,
        membersWithProfileId: withProfile,
        allMembersHaveSkills: n > 0 && withSkills === n
    };
}

/**
 * Top spell casts as [id, count] pairs (desc).
 * @param {Record<string, number>|null|undefined} map
 * @param {number} [limit]
 * @returns {Array<[string, number]>}
 */
function topSpellsFromMap(map, limit) {
    const cap =
        limit != null && Number.isFinite(Number(limit))
            ? Math.max(0, Math.floor(Number(limit)))
            : TOP_SPELLS_LIMIT;
    return sortedCountEntries(map)
        .slice(0, cap)
        .map((row) => /** @type {[string, number]} */ ([row.id, row.count]));
}

/**
 * Compact arena waves bag for the report (null when not a wave hunt).
 * @param {object|null|undefined} waves
 * @returns {object|null}
 */
function wavesForReport(waves) {
    if (!waves || typeof waves !== 'object') return null;
    /** @type {Record<string, any>} */
    const out = {};
    if (waves.phase != null) out.phase = String(waves.phase);
    if (waves.waveIndex != null && Number.isFinite(Number(waves.waveIndex))) {
        out.waveIndex = Number(waves.waveIndex);
    }
    if (waves.waveId != null) out.waveId = String(waves.waveId);
    if (waves.waveLabel != null) out.waveLabel = String(waves.waveLabel);
    if (
        waves.wavesCompleted != null &&
        Number.isFinite(Number(waves.wavesCompleted))
    ) {
        out.wavesCompleted = Number(waves.wavesCompleted);
    }
    if (waves.totalWaves != null && Number.isFinite(Number(waves.totalWaves))) {
        out.totalWaves = Number(waves.totalWaves);
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Live party rows from snapshotFromSim (HP / cast pressure at report time).
 * @param {object[]|null|undefined} snapMembers
 * @returns {object[]}
 */
function liveMembersForReport(snapMembers) {
    if (!Array.isArray(snapMembers) || !snapMembers.length) return [];
    const out = [];
    for (let i = 0; i < snapMembers.length; i++) {
        const m = snapMembers[i];
        if (!m) continue;
        /** @type {Record<string, any>} */
        const row = {
            name: m.name != null ? String(m.name) : `Member${i + 1}`,
            classId: m.classId != null ? String(m.classId) : null,
            isLeader: !!m.isLeader,
            alive: m.alive !== false,
            hp: m.hp != null ? Number(m.hp) : null,
            hpMax: m.hpMax != null ? Number(m.hpMax) : null,
            kills: m.kills || 0,
            damageDealt: m.damageDealt || 0,
            damageTaken: m.damageTaken || 0,
            spellsCast: m.spellsCast || 0,
            manaSpent: m.manaSpent || 0,
            topSpells: topSpellsFromMap(
                m.spellsCastById,
                LIVE_MEMBER_TOP_SPELLS
            )
        };
        if (m.aiState != null && String(m.aiState) !== '') {
            row.aiState = String(m.aiState);
        }
        // Multi-floor triage (docs/25): tile coords at report time
        if (Number.isFinite(Number(m.x))) row.x = Number(m.x);
        if (Number.isFinite(Number(m.y))) row.y = Number(m.y);
        if (Number.isFinite(Number(m.z))) row.z = Number(m.z);
        out.push(row);
    }
    return out;
}

/**
 * Compact live-session fields useful for reproduction notes.
 * @param {object|null} sim
 * @param {object|null} [snap] optional prebuilt snapshotFromSim
 * @returns {object}
 */
function sessionContextFromSim(sim, snap) {
    const s = snap || snapshotFromSim(sim);
    const endReason =
        sim && sim.telemetry && sim.telemetry.endReason != null
            ? String(sim.telemetry.endReason)
            : s.sessionState != null
              ? String(s.sessionState)
              : null;
    /** @type {object} */
    const out = {
        state: s.sessionState || 'idle',
        endReason,
        tickCount: s.tickCount || 0,
        timeSec: s.timeSec || 0,
        kills: s.kills || 0,
        deaths: s.deaths || 0,
        expGained: s.expGained || 0,
        damageDealt: s.damageDealt || 0,
        damageTaken: s.damageTaken || 0,
        manaSpent: s.manaSpent || 0,
        spellsCast: s.spellsCast || 0,
        creaturesAlive: s.creaturesAlive || 0,
        terminal: !!s.terminal,
        waveHud: s.waveHud || null,
        waves: wavesForReport(s.waves),
        topSpells: topSpellsFromMap(s.spellsCastById, TOP_SPELLS_LIMIT),
        liveMembers: liveMembersForReport(s.members),
        partyFloors: s.partyFloors || null
    };
    const kindMap = s.spellsCastByKind;
    if (kindMap && typeof kindMap === 'object' && Object.keys(kindMap).length) {
        out.spellsCastByKind = Object.assign({}, kindMap);
    }
    const hops = s.floorHopLog;
    if (Array.isArray(hops) && hops.length) {
        // Cap payload size; full log remains on the live sim
        out.floorHopLog = hops.slice(-24).map((h) => ({
            tick: h.tick,
            name: h.name,
            fromZ: h.fromZ,
            toZ: h.toZ,
            x: h.x,
            y: h.y
        }));
    }
    // Prefer live sim log (complete); fall back to snapshot clone
    let parity =
        sim && Array.isArray(sim.parityTickLog) && sim.parityTickLog.length
            ? sim.parityTickLog
            : s.parityTickLog;
    if (Array.isArray(parity) && parity.length) {
        // Full post-hop window is intentionally small (~25 ticks)
        out.parityTickLog = parity.map((row) => ({
            t: row.t,
            rng: row.rng,
            draws: row.draws,
            kills: row.kills,
            exp: row.exp,
            dmgOut: row.dmgOut,
            party: Array.isArray(row.party)
                ? row.party.map((m) => ({
                      n: m.n,
                      x: m.x,
                      y: m.y,
                      z: m.z,
                      hp: m.hp,
                      ai: m.ai,
                      dmg: m.dmg,
                      k: m.k,
                      tgt: m.tgt,
                      tgtN: m.tgtN
                  }))
                : [],
            hostiles: Array.isArray(row.hostiles)
                ? row.hostiles.map((h) => ({
                      id: h.id,
                      n: h.n,
                      x: h.x,
                      y: h.y,
                      z: h.z,
                      hp: h.hp
                  }))
                : [],
            atk: Array.isArray(row.atk)
                ? row.atk.map((a) => ({
                      by: a.by,
                      byType: a.byType,
                      vs: a.vs,
                      vsId: a.vsId,
                      spell: a.spell,
                      d: a.d,
                      miss: a.miss,
                      crit: a.crit,
                      kill: a.kill
                  }))
                : []
        }));
        if (s.parityTickLogText) {
            out.parityTickLogText = String(s.parityTickLogText);
        }
    }
    if (sim) {
        if (sim.seed != null) out.seed = sim.seed >>> 0 || 1;
        if (sim.huntId != null) out.huntId = String(sim.huntId);
        if (sim.floor != null) out.floor = sim.floor;
        if (sim.genre != null) out.genre = sim.genre;
        if (sim.maxTicks != null) out.maxTicks = sim.maxTicks;
        if (sim.maxKills != null) out.maxKills = sim.maxKills;
        if (sim.maxSeconds != null) out.maxSeconds = sim.maxSeconds;
        if (sim.spawnMode != null) out.spawnMode = sim.spawnMode;
    }
    let commandHistory =
        sim && Array.isArray(sim.commandHistory) && sim.commandHistory.length
            ? sim.commandHistory
            : s.commandHistory;
    if (Array.isArray(commandHistory) && commandHistory.length) {
        out.commandHistory = commandHistory.slice();
    }
    return out;
}

/**
 * Build a serializable bug report document.
 *
 * @param {object} input
 * @param {string} input.description
 * @param {'hunt'|'scenario'} [input.source='hunt']
 * @param {string} [input.modeId]
 * @param {number|string} [input.seed]
 * @param {string|null} [input.huntId]
 * @param {string|null} [input.scenarioId]
 * @param {string|null} [input.partyId]
 * @param {string|null} [input.partyName]
 * @param {object[]} [input.members] form members (enabled filtered)
 * @param {object|null} [input.sim] live Simulator
 * @param {number} [input.timeSpeed]
 * @param {Record<string, number|boolean>|null} [input.scenarioSettings]
 * @param {string} [input.userAgent]
 * @param {string} [input.createdAt] ISO string (tests)
 * @returns {object}
 */
function buildBugReportPayload(input) {
    const o = input || {};
    let description =
        o.description != null ? String(o.description).trim() : '';
    if (description.length > MAX_DESCRIPTION_CHARS) {
        description = description.slice(0, MAX_DESCRIPTION_CHARS);
    }

    const source =
        o.source === 'scenario' ? 'scenario' : 'hunt';
    const modeId =
        o.modeId != null && String(o.modeId).trim() !== ''
            ? String(o.modeId).trim()
            : 'standard';

    let seed = 1;
    if (o.seed != null && String(o.seed).trim() !== '') {
        const n = parseInt(String(o.seed).trim(), 10);
        if (Number.isFinite(n)) seed = n >>> 0 || 1;
    }
    // Prefer live sim seed when a session is running (form can lag after random fill).
    if (o.sim && o.sim.seed != null) {
        seed = o.sim.seed >>> 0 || seed;
    }

    const partyMembers = partyMembersForReport(o.members);
    const partyId =
        o.partyId != null && String(o.partyId).trim() !== ''
            ? String(o.partyId).trim()
            : null;
    const partyName =
        o.partyName != null && String(o.partyName).trim() !== ''
            ? String(o.partyName).trim()
            : null;

    const huntId =
        o.huntId != null && String(o.huntId).trim() !== ''
            ? String(o.huntId).trim()
            : o.sim && o.sim.huntId
              ? String(o.sim.huntId)
              : null;
    const scenarioId =
        o.scenarioId != null && String(o.scenarioId).trim() !== ''
            ? String(o.scenarioId).trim()
            : null;

    const session = sessionContextFromSim(o.sim || null);
    if (o.timeSpeed != null && Number.isFinite(Number(o.timeSpeed))) {
        session.timeSpeed = Number(o.timeSpeed);
    }

    const diagnostics = partyDiagnostics(partyMembers);

    /** @type {object} */
    const report = {
        schemaVersion: BUG_REPORT_SCHEMA_VERSION,
        createdAt:
            o.createdAt ||
            (typeof Date !== 'undefined'
                ? new Date().toISOString()
                : ''),
        source,
        description,
        modeId,
        seed,
        huntId: source === 'hunt' ? huntId : huntId,
        scenarioId: source === 'scenario' ? scenarioId : scenarioId,
        partyId,
        party: {
            id: partyId || 'report',
            name: partyName || partyId || 'HuntParty',
            members: partyMembers,
            // v2 diagnostics (not used by repro runner)
            memberCount: diagnostics.memberCount,
            membersHaveSkills: diagnostics.membersHaveSkills,
            membersHaveProfileId: diagnostics.membersHaveProfileId,
            membersWithSkills: diagnostics.membersWithSkills,
            membersWithProfileId: diagnostics.membersWithProfileId,
            allMembersHaveSkills: diagnostics.allMembersHaveSkills
        },
        session,
        scenarioSettings:
            o.scenarioSettings && typeof o.scenarioSettings === 'object'
                ? o.scenarioSettings
                : null,
        userAgent:
            o.userAgent != null
                ? String(o.userAgent)
                : typeof navigator !== 'undefined' && navigator.userAgent
                  ? String(navigator.userAgent)
                  : null
    };

    // Headless repro hints (CLI maps these 1:1). Diagnostics stay on party/session.
    report.repro = {
        runner: source === 'scenario' ? 'scenario' : 'hunt',
        seed,
        modeId,
        huntId: huntId || undefined,
        scenarioId: scenarioId || undefined,
        partyId: partyId || undefined,
        members: partyMembers,
        scenarioSettings: report.scenarioSettings || undefined,
        commandHistory: session && Array.isArray(session.commandHistory) ? session.commandHistory : undefined
    };

    return report;
}

/**
 * Build runner input for headless reproduction from a saved bug report.
 * Pure — no I/O.
 *
 * @param {object} report
 * @returns {{ kind: 'hunt'|'scenario', modeId: string, input: object }}
 */
function bugReportToRunnerInput(report) {
    const r = report || {};
    const repro = r.repro && typeof r.repro === 'object' ? r.repro : r;
    const kind =
        r.source === 'scenario' || repro.runner === 'scenario'
            ? 'scenario'
            : 'hunt';
    const modeId =
        (repro.modeId || r.modeId || 'standard') + '';
    const seed =
        repro.seed != null
            ? repro.seed >>> 0 || 1
            : r.seed != null
              ? r.seed >>> 0 || 1
              : 1;

    const members =
        Array.isArray(repro.members) && repro.members.length
            ? repro.members
            : r.party && Array.isArray(r.party.members)
              ? r.party.members
              : null;
    const partyId =
        repro.partyId != null
            ? repro.partyId
            : r.partyId != null
              ? r.partyId
              : r.party && r.party.id
                ? r.party.id
                : null;

    /** @type {object} */
    const input = { seed };
    if (partyId) input.partyId = String(partyId);
    if (members && members.length) input.members = members;
    const commandHistory =
        Array.isArray(repro.commandHistory) && repro.commandHistory.length
            ? repro.commandHistory
            : r.session && Array.isArray(r.session.commandHistory)
              ? r.session.commandHistory
              : null;
    if (commandHistory && commandHistory.length) input.commandHistory = commandHistory;

    if (kind === 'scenario') {
        const scenarioId =
            repro.scenarioId || r.scenarioId || 'choke_pack';
        input.scenarioId = String(scenarioId);
        const settings =
            repro.scenarioSettings || r.scenarioSettings || null;
        if (settings && typeof settings === 'object') {
            // runScenarioHunt → applyScenario / splitScenarioOpts applies these knobs.
            input.scenarioSettings = settings;
        }
        return { kind, modeId, input };
    }

    const huntId = repro.huntId || r.huntId || 'cave_crawl_generated';
    input.huntId = String(huntId);
    return { kind, modeId, input };
}

/**
 * POST report document to PHP bugs_save.
 * @param {string} apiBase absolute or relative API URL
 * @param {object} report
 * @returns {Promise<{ ok: boolean, path?: string, id?: string, error?: string }>}
 */
async function saveBugReport(apiBase, report) {
    const base =
        apiBase != null && String(apiBase).trim() !== ''
            ? String(apiBase)
            : '/php/api.php';
    let url;
    try {
        url = new URL(base, typeof window !== 'undefined' ? window.location.href : 'http://localhost/');
    } catch (_) {
        url = { href: base, searchParams: new URLSearchParams() };
        // Fallback when URL ctor unavailable
        const sep = base.indexOf('?') >= 0 ? '&' : '?';
        const href = `${base}${sep}action=bugs_save`;
        const res = await fetch(href, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
            return {
                ok: false,
                error: (data && data.error) || `HTTP ${res.status}`
            };
        }
        return {
            ok: true,
            path: data.path,
            id: data.id
        };
    }
    url.searchParams.set('action', 'bugs_save');
    const res = await fetch(url.href, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
        return {
            ok: false,
            error: (data && data.error) || `HTTP ${res.status}`
        };
    }
    return {
        ok: true,
        path: data.path,
        id: data.id
    };
}

/**
 * Wire Report Bug button → modal → save.
 *
 * @param {object} opts
 * @param {() => object} opts.getContext returns fields for buildBugReportPayload (without description)
 * @param {() => string} [opts.getApiUrl]
 * @param {Record<string, HTMLElement|null>} [opts.els]
 * @param {Document} [opts.doc]
 * @param {(result: object) => void} [opts.onSaved]
 * @returns {() => void} unbind
 */
function bindBugReportModal(opts) {
    const o = opts || {};
    const d =
        o.doc || (typeof document !== 'undefined' ? document : null);
    const els = o.els || (d ? bindBugReportElements(d) : {});
    const btn = els.bugReportBtn;
    const modal = els.bugReportModal;
    const textarea = els.bugReportDescription;
    const saveBtn = els.bugReportSave;
    const statusEl = els.bugReportStatus;
    if (!btn || !modal) {
        return () => {};
    }

    let saving = false;

    const setStatus = (text, isError) => {
        if (!statusEl) return;
        if (!text) {
            statusEl.hidden = true;
            statusEl.textContent = '';
            statusEl.classList.remove('is-error', 'is-ok');
            return;
        }
        statusEl.hidden = false;
        statusEl.textContent = text;
        statusEl.classList.toggle('is-error', !!isError);
        statusEl.classList.toggle('is-ok', !isError);
    };

    const open = () => {
        setStatus('');
        if (textarea) {
            textarea.value = '';
            textarea.disabled = false;
        }
        if (saveBtn) saveBtn.disabled = false;
        setBugReportOpen(modal, true);
        if (textarea && typeof textarea.focus === 'function') {
            try {
                textarea.focus();
            } catch (_) {
                /* ignore */
            }
        }
    };

    const close = () => {
        if (saving) return;
        setBugReportOpen(modal, false);
        setStatus('');
    };

    const onBtn = (ev) => {
        if (ev) ev.preventDefault();
        open();
    };

    const onKey = (ev) => {
        if (ev.key === 'Escape' && !modal.hidden && !saving) {
            close();
        }
    };

    const onBackdrop = (ev) => {
        if (ev.target === modal && !saving) close();
    };

    const onSave = async (ev) => {
        if (ev) ev.preventDefault();
        if (saving) return;
        const description = textarea ? String(textarea.value || '') : '';
        if (!String(description).trim()) {
            setStatus('Please describe the bug before saving.', true);
            if (textarea && typeof textarea.focus === 'function') {
                try {
                    textarea.focus();
                } catch (_) {
                    /* ignore */
                }
            }
            return;
        }

        saving = true;
        if (saveBtn) saveBtn.disabled = true;
        if (textarea) textarea.disabled = true;
        setStatus('Saving…');

        try {
            const ctx =
                typeof o.getContext === 'function' ? o.getContext() : {};
            const report = buildBugReportPayload(
                Object.assign({}, ctx, { description })
            );
            const apiUrl =
                typeof o.getApiUrl === 'function'
                    ? o.getApiUrl()
                    : typeof window !== 'undefined' && window.__API_URL__
                      ? String(window.__API_URL__)
                      : '/php/api.php';
            const result = await saveBugReport(apiUrl, report);
            if (!result.ok) {
                setStatus(result.error || 'Save failed', true);
                saving = false;
                if (saveBtn) saveBtn.disabled = false;
                if (textarea) textarea.disabled = false;
                return;
            }
            const path = result.path || result.id || 'bugs/…';
            setStatus(`Saved ${path}`, false);
            if (typeof o.onSaved === 'function') {
                try {
                    o.onSaved(result);
                } catch (_) {
                    /* ignore */
                }
            }
            saving = false;
            // Brief success, then close so the user sees the path.
            setTimeout(() => {
                setBugReportOpen(modal, false);
                setStatus('');
                if (textarea) {
                    textarea.value = '';
                    textarea.disabled = false;
                }
                if (saveBtn) saveBtn.disabled = false;
            }, 900);
        } catch (err) {
            const msg =
                err && err.message ? String(err.message) : String(err);
            setStatus(msg, true);
            saving = false;
            if (saveBtn) saveBtn.disabled = false;
            if (textarea) textarea.disabled = false;
        }
    };

    btn.addEventListener('click', onBtn);
    if (d) d.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBackdrop);
    if (saveBtn) saveBtn.addEventListener('click', onSave);

    const closeNodes = modal.querySelectorAll('[data-bug-report-close]');
    const onCloseClick = (ev) => {
        if (ev) ev.preventDefault();
        close();
    };
    for (let i = 0; i < closeNodes.length; i++) {
        closeNodes[i].addEventListener('click', onCloseClick);
    }

    return () => {
        btn.removeEventListener('click', onBtn);
        if (d) d.removeEventListener('keydown', onKey);
        modal.removeEventListener('click', onBackdrop);
        if (saveBtn) saveBtn.removeEventListener('click', onSave);
        for (let i = 0; i < closeNodes.length; i++) {
            closeNodes[i].removeEventListener('click', onCloseClick);
        }
        setBugReportOpen(modal, false);
    };
}

module.exports = {
    BUG_REPORT_SCHEMA_VERSION,
    MAX_DESCRIPTION_CHARS,
    TOP_SPELLS_LIMIT,
    LIVE_MEMBER_TOP_SPELLS,
    bindBugReportElements,
    setBugReportOpen,
    partyMembersForReport,
    memberHasSkills,
    partyDiagnostics,
    topSpellsFromMap,
    wavesForReport,
    liveMembersForReport,
    sessionContextFromSim,
    buildBugReportPayload,
    bugReportToRunnerInput,
    saveBugReport,
    bindBugReportModal
};
