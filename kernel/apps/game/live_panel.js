/**
 * Live hunt stats panel — reads Simulator / telemetry and writes DOM.
 * Must stay outside the core logic loop (Stage 7 exit criteria).
 */

'use strict';

const { Time } = require('../../core/lib/time.js');
const { isSessionTerminal } = require('../../providers/simulator/hunt_opts.js');
const { cloneCountMap } = require('../../core/lib/telemetry.js');

/**
 * Value / hour from sim-seconds.
 * @param {number} value
 * @param {number} timeSeconds
 * @returns {number}
 */
function ratePerHour(value, timeSeconds) {
    const t = Number(timeSeconds) || 0;
    if (t <= 0) return 0;
    return ((Number(value) || 0) * 3600) / t;
}

/**
 * Sort count-map keys by count desc, then id asc.
 * @param {Record<string, number>|null|undefined} map
 * @returns {{ id: string, count: number }[]}
 */
function sortedCountEntries(map) {
    const m = map || {};
    return Object.keys(m)
        .map((id) => ({ id, count: Number(m[id]) || 0 }))
        .filter((row) => row.count > 0)
        .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
}

/**
 * Format a number for compact HUD display.
 * @param {number} n
 * @param {number} [digits=0]
 * @returns {string}
 */
function fmtNum(n, digits) {
    const d = digits != null ? digits : 0;
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (d === 0) return String(Math.round(v));
    return v.toFixed(d);
}

/**
 * Snapshot live stats from a running (or ended) Simulator.
 * Pure: no DOM.
 *
 * @param {object|null} sim Simulator instance
 * @returns {object}
 */
/**
 * Compact wave HUD line from WaveController.snapshot().
 * @param {object|null} waves
 * @returns {string|null}
 */
function formatWaveHud(waves) {
    if (!waves || typeof waves !== 'object') return null;
    const total = waves.totalWaves != null ? Number(waves.totalWaves) : 0;
    if (!(total > 0)) return null;
    const completed = waves.wavesCompleted != null ? Number(waves.wavesCompleted) : 0;
    const idx = waves.waveIndex != null ? Number(waves.waveIndex) : -1;
    // Display 1-based current wave while active/intermission; completed/total at end.
    let current = completed;
    if (waves.phase === 'active' || waves.phase === 'intermission') {
        current = idx >= 0 ? idx + 1 : completed + 1;
    } else if (waves.phase === 'complete') {
        current = total;
    } else if (waves.phase === 'waiting' && idx < 0) {
        current = 0;
    } else if (idx >= 0) {
        current = idx + 1;
    }
    const phase = waves.phase ? String(waves.phase) : '';
    const label = waves.waveLabel ? String(waves.waveLabel) : '';
    let line = `${current}/${total}`;
    if (phase) line += ` · ${phase}`;
    if (label) line += ` · ${label}`;
    return line;
}

/**
 * Compact party floor line: "Guardian z0 · Scout z1".
 * @param {object[]|null|undefined} members
 * @returns {string}
 */
function formatPartyFloors(members) {
    if (!Array.isArray(members) || !members.length) return '—';
    const parts = [];
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (!m) continue;
        const name = m.name != null ? String(m.name) : `m${i}`;
        const z =
            m.z != null && Number.isFinite(Number(m.z))
                ? String(Number(m.z))
                : '?';
        parts.push(`${name} z${z}`);
    }
    return parts.length ? parts.join(' · ') : '—';
}

/**
 * Format hop log rows for the live panel (newest last, cap N).
 * @param {object[]|null|undefined} hops
 * @param {number} [limit=12]
 * @returns {string}
 */
function formatFloorHopLog(hops, limit) {
    const cap = limit != null ? Math.max(1, limit | 0) : 12;
    if (!Array.isArray(hops) || !hops.length) return '—';
    const slice = hops.length > cap ? hops.slice(hops.length - cap) : hops;
    return slice
        .map((h) => {
            const name = h.name != null ? String(h.name) : '?';
            const tick = h.tick != null ? fmtNum(h.tick) : '?';
            const fromZ = h.fromZ != null ? String(h.fromZ) : '?';
            const toZ = h.toZ != null ? String(h.toZ) : '?';
            const hasXy =
                Number.isFinite(Number(h.x)) && Number.isFinite(Number(h.y));
            const xy = hasXy ? ` @${fmtNum(h.x)},${fmtNum(h.y)}` : '';
            return `t${tick} ${name} z${fromZ}→${toZ}${xy}`;
        })
        .join('\n');
}

/**
 * Copy floorHopLog from sim (plain objects only).
 * @param {object|null|undefined} sim
 * @returns {object[]}
 */
function cloneFloorHopLog(sim) {
    if (!sim || !Array.isArray(sim.floorHopLog) || !sim.floorHopLog.length) {
        return [];
    }
    return sim.floorHopLog.map((h) => ({
        tick: h.tick,
        entityId: h.entityId,
        name: h.name != null ? String(h.name) : '?',
        fromZ: h.fromZ,
        toZ: h.toZ,
        x: h.x,
        y: h.y
    }));
}

/**
 * Clone parityTickLog (split-floor combat/RNG isolation) as plain JSON.
 * @param {object|null|undefined} sim
 * @returns {object[]}
 */
function cloneParityTickLog(sim) {
    if (!sim || !Array.isArray(sim.parityTickLog) || !sim.parityTickLog.length) {
        return [];
    }
    // Rows are already plain; shallow-clone top + nested arrays we care about
    return sim.parityTickLog.map((row) => ({
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
}

/**
 * Compact multi-line text focusing Scout (+ kills/RNG) for live panel.
 * @param {object[]|null|undefined} log
 * @param {{ focusName?: string, maxLines?: number }} [opts]
 * @returns {string}
 */
function formatParityTickLog(log, opts) {
    if (!Array.isArray(log) || !log.length) return '—';
    const o = opts || {};
    const focus = o.focusName != null ? String(o.focusName) : 'Scout';
    const maxLines =
        o.maxLines != null && o.maxLines > 0 ? Math.floor(o.maxLines) : 40;
    const lines = [];
    for (let i = 0; i < log.length && lines.length < maxLines; i++) {
        const row = log[i];
        if (!row) continue;
        const party = Array.isArray(row.party) ? row.party : [];
        const scout =
            party.find((m) => m && String(m.n) === focus) ||
            party.find((m) => m && /scout/i.test(String(m.n || ''))) ||
            null;
        const others = party.filter((m) => m && m !== scout);
        const parts = [`t${row.t}`];
        if (scout) {
            const tgt =
                scout.tgtN != null
                    ? scout.tgtN
                    : scout.tgt != null
                      ? `#${scout.tgt}`
                      : '—';
            parts.push(
                `S@${scout.x},${scout.y},z${scout.z} ai=${scout.ai || '—'} tgt=${tgt} dmg=${scout.dmg} k=${scout.k}`
            );
        }
        for (let j = 0; j < others.length; j++) {
            const m = others[j];
            const short = String(m.n || '?').slice(0, 1);
            parts.push(`${short}@${m.x},${m.y},z${m.z}`);
        }
        parts.push(
            `kills=${row.kills} draws+${row.draws} rng=${
                row.rng != null ? '0x' + (row.rng >>> 0).toString(16) : '—'
            }`
        );
        const atk = Array.isArray(row.atk) ? row.atk : [];
        const scoutAtk = atk.filter(
            (a) =>
                a &&
                (String(a.by) === focus ||
                    /scout/i.test(String(a.by || '')) ||
                    a.byType === 'player')
        );
        // Prefer Scout-named attacks; fall back to all player attacks this tick
        const showAtk =
            scoutAtk.length &&
            scoutAtk.some(
                (a) => String(a.by) === focus || /scout/i.test(String(a.by || ''))
            )
                ? scoutAtk.filter(
                      (a) =>
                          String(a.by) === focus ||
                          /scout/i.test(String(a.by || ''))
                  )
                : scoutAtk;
        if (showAtk.length) {
            const bits = showAtk.slice(0, 4).map((a) => {
                const sp = a.spell || 'hit';
                const flag = a.kill ? 'KILL' : a.miss ? 'miss' : String(a.d);
                return `${sp}→${a.vs}:${flag}`;
            });
            parts.push('atk[' + bits.join('; ') + ']');
        }
        const hostN = Array.isArray(row.hostiles) ? row.hostiles.length : 0;
        if (hostN) parts.push(`zHost=${hostN}`);
        lines.push(parts.join(' | '));
    }
    return lines.length ? lines.join('\n') : '—';
}

function snapshotFromSim(sim) {
    if (!sim) {
        return {
            sessionState: 'idle',
            tickCount: 0,
            timeSec: 0,
            kills: 0,
            deaths: 0,
            expGained: 0,
            expPerHour: 0,
            damageDealt: 0,
            damageTaken: 0,
            damageDealtPerHour: 0,
            damageTakenPerHour: 0,
            hitRate: 0,
            attacks: 0,
            hits: 0,
            manaSpent: 0,
            autoAttacks: 0,
            spellsCast: 0,
            spellsCastById: {},
            spellsCastByKind: {},
            creaturesAlive: 0,
            damageByElement: {},
            members: [],
            partyFloors: '—',
            floorHopLog: [],
            floorHopLogText: '—',
            parityTickLog: [],
            parityTickLogText: '—',
            waves: null,
            waveHud: null,
            terminal: false
        };
    }

    const t = sim.telemetry || {};
    const timeSec =
        Time && Time.timeSinceLevelLoad != null
            ? Time.timeSinceLevelLoad
            : (sim.tickCount || 0) * 0.05;
    const attacks = t.attacks || 0;
    const hits = t.hits || 0;

    /** @type {object[]} */
    let members = [];
    if (typeof sim.getPartyPositions === 'function') {
        const parties = sim.getPartyPositions();
        if (parties[0] && Array.isArray(parties[0].members)) {
            members = parties[0].members.map((m) => {
                const autoAttacks = m.autoAttacks || 0;
                const spellsCast = m.spellsCast || 0;
                return {
                    name: m.name,
                    classId: m.classId,
                    isLeader: m.isLeader,
                    alive: m.alive,
                    hp: m.hp,
                    hpMax: m.hpMax,
                    damageDealt: m.damageDealt || 0,
                    damageTaken: m.damageTaken || 0,
                    kills: m.kills || 0,
                    expGained: m.expGained || 0,
                    rawExpGained: m.rawExpGained || 0,
                    level: m.level != null ? m.level : null,
                    levelUps: m.levelUps || 0,
                    autoAttacks,
                    autoAttacksPerHour: ratePerHour(autoAttacks, timeSec),
                    spellsCast,
                    spellsCastPerHour: ratePerHour(spellsCast, timeSec),
                    spellsCastById: cloneCountMap(m.spellsCastById),
                    spellsCastByKind: cloneCountMap(m.spellsCastByKind),
                    manaSpent: m.manaSpent || 0,
                    aiState: m.aiState || '',
                    x: m.x,
                    y: m.y,
                    z: m.z
                };
            });
        }
    }

    const byEl = t.damageDealtByElement || {};
    const damageByElement = Object.create(null);
    for (const k of Object.keys(byEl)) {
        if (byEl[k] > 0) damageByElement[k] = byEl[k];
    }

    let waves = null;
    if (sim.waveController && typeof sim.waveController.snapshot === 'function') {
        waves = sim.waveController.snapshot();
    } else if (sim.telemetry && sim.telemetry.waves) {
        waves = sim.telemetry.waves;
    }

    const sessionState = sim.sessionState || 'idle';
    const floorHopLog = cloneFloorHopLog(sim);
    const parityTickLog = cloneParityTickLog(sim);

    return {
        sessionState,
        tickCount: sim.tickCount || 0,
        timeSec,
        kills: t.kills || 0,
        deaths: t.deaths || 0,
        expGained: t.expGained || 0,
        rawExpGained: t.rawExpGained || 0,
        levelUps: t.levelUps || 0,
        expPerHour: ratePerHour(t.expGained, timeSec),
        rawExpPerHour: ratePerHour(t.rawExpGained || 0, timeSec),
        damageDealt: t.damageDealt || 0,
        damageTaken: t.damageTaken || 0,
        damageDealtPerHour: ratePerHour(t.damageDealt, timeSec),
        damageTakenPerHour: ratePerHour(t.damageTaken, timeSec),
        hitRate: attacks > 0 ? hits / attacks : 0,
        attacks,
        hits,
        manaSpent: t.manaSpent || 0,
        autoAttacks: t.autoAttacks || 0,
        spellsCast: t.spellsCast || 0,
        spellsCastById: cloneCountMap(t.spellsCastById),
        spellsCastByKind: cloneCountMap(t.spellsCastByKind),
        creaturesAlive: Array.isArray(sim.creatures)
            ? sim.creatures.filter((c) => c && c.alive).length
            : 0,
        damageByElement,
        members,
        partyFloors: formatPartyFloors(members),
        floorHopLog,
        floorHopLogText: formatFloorHopLog(floorHopLog),
        parityTickLog,
        parityTickLogText: formatParityTickLog(parityTickLog),
        waves,
        waveHud: formatWaveHud(waves),
        terminal: isSessionTerminal(sessionState)
    };
}

/**
 * Bind DOM element ids used by the live panel.
 * @param {Document} [doc]
 * @returns {Record<string, HTMLElement|null>}
 */
function bindLivePanelElements(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return {};
    return {
        sessionState: d.getElementById('sessionStateBadge'),
        tick: d.getElementById('liveTick'),
        floors: d.getElementById('liveFloors'),
        hopLog: d.getElementById('liveHopLog'),
        paritySection: d.getElementById('liveParitySection'),
        parityLog: d.getElementById('liveParityLog'),
        kills: d.getElementById('liveKills'),
        deaths: d.getElementById('liveDeaths'),
        exp: d.getElementById('liveExp'),
        expPerHour: d.getElementById('liveExpPerHour'),
        dmgOut: d.getElementById('liveDmgOut'),
        dmgIn: d.getElementById('liveDmgIn'),
        dmgOutPh: d.getElementById('liveDmgOutPh'),
        hitRate: d.getElementById('liveHitRate'),
        mana: d.getElementById('liveMana'),
        creatures: d.getElementById('liveCreatures'),
        waveRow: d.getElementById('liveWaveRow'),
        wave: d.getElementById('liveWave'),
        elementBreakdown: d.getElementById('liveElementBreakdown'),
        memberList: d.getElementById('liveMemberList'),
        partyDetailsBtn: d.getElementById('partyDetailsBtn'),
        partyDetailsModal: d.getElementById('partyDetailsModal'),
        partyDetailsBody: d.getElementById('partyDetailsBody'),
        partyDetailsClose: d.getElementById('partyDetailsClose')
    };
}

/**
 * Render count map as compact "id: n · id: n" or empty placeholder.
 * @param {Record<string, number>|null|undefined} map
 * @returns {string}
 */
function formatCountMapLine(map) {
    const rows = sortedCountEntries(map);
    if (!rows.length) return '—';
    return rows.map((r) => `${r.id}: ${fmtNum(r.count)}`).join(' · ');
}

/**
 * HTML for one member block inside the party details modal.
 * @param {object} m member snapshot
 * @returns {string}
 */
function renderMemberDetailsHtml(m) {
    const leader = m.isLeader ? '★ ' : '';
    const dead = m.alive === false ? ' (down)' : '';
    const hp =
        m.hpMax > 0 ? `${fmtNum(m.hp)}/${fmtNum(m.hpMax)}` : '—';
    const hasPos =
        Number.isFinite(Number(m.x)) && Number.isFinite(Number(m.y));
    const pos = hasPos
        ? Number.isFinite(Number(m.z))
            ? `(${fmtNum(m.x)},${fmtNum(m.y)},${fmtNum(m.z)})`
            : `(${fmtNum(m.x)},${fmtNum(m.y)})`
        : '—';
    const byId = sortedCountEntries(m.spellsCastById);
    const byKind = sortedCountEntries(m.spellsCastByKind);
    const spellRows = byId.length
        ? byId
              .map(
                  (r) =>
                      `<tr><td>${escapeHtml(r.id)}</td><td class="text-end">${fmtNum(
                          r.count
                      )}</td></tr>`
              )
              .join('')
        : '<tr><td colspan="2" class="text-muted">No spells recorded</td></tr>';
    const kindLine = byKind.length
        ? byKind.map((r) => `${escapeHtml(r.id)}: ${fmtNum(r.count)}`).join(' · ')
        : '—';

    return (
        `<div class="party-details-member">` +
        `<div class="party-details-member-head">` +
        `<strong>${leader}${escapeHtml(m.name || '?')}${dead}</strong>` +
        `<span class="text-muted small">${escapeHtml(m.classId || '')}</span>` +
        `</div>` +
        `<div class="party-details-grid">` +
        `<div><span class="label-retro">HP</span> ${hp}</div>` +
        `<div><span class="label-retro">AI</span> ${escapeHtml(m.aiState || '—')}</div>` +
        `<div><span class="label-retro">Pos</span> ${pos}</div>` +
        `<div><span class="label-retro">Dmg out</span> ${fmtNum(m.damageDealt)}</div>` +
        `<div><span class="label-retro">Dmg in</span> ${fmtNum(m.damageTaken)}</div>` +
        `<div><span class="label-retro">Kills</span> ${fmtNum(m.kills)}</div>` +
        `<div><span class="label-retro">Exp</span> ${fmtNum(m.expGained)}</div>` +
        `<div><span class="label-retro">Mana</span> ${fmtNum(m.manaSpent)}</div>` +
        `<div><span class="label-retro">AutoAtk</span> ${fmtNum(m.autoAttacks)}` +
        ` <span class="text-muted">(${fmtNum(m.autoAttacksPerHour)}/h)</span></div>` +
        `<div><span class="label-retro">Spells</span> ${fmtNum(m.spellsCast)}` +
        ` <span class="text-muted">(${fmtNum(m.spellsCastPerHour)}/h)</span></div>` +
        `</div>` +
        `<p class="party-details-kind label-retro mb-1">By kind</p>` +
        `<p class="party-details-kind-line small mb-2">${kindLine}</p>` +
        `<p class="party-details-kind label-retro mb-1">By spell id</p>` +
        `<table class="party-details-spell-table">` +
        `<thead><tr><th>Spell</th><th class="text-end">Casts</th></tr></thead>` +
        `<tbody>${spellRows}</tbody>` +
        `</table>` +
        `</div>`
    );
}

/**
 * Build full modal body HTML from a live snapshot.
 * @param {object} snap
 * @returns {string}
 */
function renderPartyDetailsHtml(snap) {
    if (!snap) {
        return '<p class="text-muted small mb-0">No session</p>';
    }
    const members = snap.members || [];
    const sessionLine =
        `<p class="party-details-session small text-muted mb-2">` +
        `Session · ticks ${fmtNum(snap.tickCount)} · ` +
        `mana ${fmtNum(snap.manaSpent)} · ` +
        `spells ${fmtNum(snap.spellsCast)} · ` +
        `auto ${fmtNum(snap.autoAttacks)} · ` +
        `hits ${fmtNum(snap.hits)} / ${fmtNum(snap.attacks)} atk` +
        `</p>` +
        `<p class="small mb-3"><span class="label-retro">Party by kind</span> ` +
        `${escapeHtml(formatCountMapLine(snap.spellsCastByKind))}</p>`;

    if (!members.length) {
        return (
            sessionLine +
            '<p class="text-muted small mb-0">No party members</p>'
        );
    }
    return (
        sessionLine + members.map((m) => renderMemberDetailsHtml(m)).join('')
    );
}

/**
 * Open/close helpers for the party details modal (no Bootstrap JS required).
 * @param {HTMLElement|null} modal
 * @param {boolean} open
 */
function setPartyDetailsOpen(modal, open) {
    if (!modal) return;
    if (open) {
        modal.hidden = false;
        modal.setAttribute('aria-hidden', 'false');
        document.body.classList.add('party-details-open');
    } else {
        modal.hidden = true;
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('party-details-open');
    }
}

/**
 * Wire Details button → modal with live snapshot of party spell stats.
 *
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {Record<string, HTMLElement|null>} [opts.els] from bindLivePanelElements
 * @param {Document} [opts.doc]
 * @returns {() => void} unbind
 */
function bindPartyDetailsModal(opts) {
    const o = opts || {};
    const d =
        o.doc || (typeof document !== 'undefined' ? document : null);
    const els = o.els || (d ? bindLivePanelElements(d) : {});
    const btn = els.partyDetailsBtn;
    const modal = els.partyDetailsModal;
    const body = els.partyDetailsBody;
    if (!btn || !modal) {
        return () => {};
    }

    const open = () => {
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        const snap = snapshotFromSim(sim);
        if (body) body.innerHTML = renderPartyDetailsHtml(snap);
        setPartyDetailsOpen(modal, true);
        const closeBtn = els.partyDetailsClose || modal.querySelector('[data-party-details-close]');
        if (closeBtn && typeof closeBtn.focus === 'function') {
            try {
                closeBtn.focus();
            } catch (_) {
                /* ignore */
            }
        }
    };

    const close = () => setPartyDetailsOpen(modal, false);

    const onBtn = (ev) => {
        if (ev) ev.preventDefault();
        open();
    };
    const onKey = (ev) => {
        if (ev.key === 'Escape' && !modal.hidden) {
            close();
        }
    };
    const onBackdrop = (ev) => {
        if (ev.target === modal) close();
    };

    btn.addEventListener('click', onBtn);
    if (d) d.addEventListener('keydown', onKey);
    modal.addEventListener('click', onBackdrop);

    const closeNodes = modal.querySelectorAll('[data-party-details-close]');
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
        for (let i = 0; i < closeNodes.length; i++) {
            closeNodes[i].removeEventListener('click', onCloseClick);
        }
        setPartyDetailsOpen(modal, false);
    };
}

/**
 * Write a snapshot into bound elements.
 * @param {Record<string, HTMLElement|null>} els
 * @param {object} snap
 * @param {{ paused?: boolean }} [opts]
 */
function renderLivePanel(els, snap, opts) {
    if (!els || !snap) return;
    const o = opts || {};

    if (els.sessionState) {
        let label = String(snap.sessionState || 'idle').toUpperCase();
        if (o.paused && snap.sessionState === 'running') label = 'PAUSED';
        els.sessionState.textContent = label;
    }

    const set = (el, text) => {
        if (el) el.textContent = text;
    };

    set(els.tick, fmtNum(snap.tickCount));
    set(els.floors, snap.partyFloors || '—');
    if (els.hopLog) {
        const text =
            snap.floorHopLogText != null
                ? String(snap.floorHopLogText)
                : formatFloorHopLog(snap.floorHopLog);
        els.hopLog.textContent = text;
    }
    if (els.parityLog || els.paritySection) {
        const hasParity =
            (Array.isArray(snap.parityTickLog) &&
                snap.parityTickLog.length > 0) ||
            (snap.parityTickLogText != null &&
                String(snap.parityTickLogText).trim() !== '' &&
                String(snap.parityTickLogText).trim() !== '—');
        if (els.paritySection) {
            els.paritySection.hidden = !hasParity;
        }
        if (els.parityLog) {
            const text =
                snap.parityTickLogText != null
                    ? String(snap.parityTickLogText)
                    : formatParityTickLog(snap.parityTickLog);
            els.parityLog.textContent = hasParity ? text : '—';
        }
    }
    set(els.kills, fmtNum(snap.kills));
    set(els.deaths, fmtNum(snap.deaths));
    set(els.exp, fmtNum(snap.expGained));
    set(els.expPerHour, fmtNum(snap.expPerHour));
    set(els.dmgOut, fmtNum(snap.damageDealt));
    set(els.dmgIn, fmtNum(snap.damageTaken));
    set(els.dmgOutPh, fmtNum(snap.damageDealtPerHour));
    set(
        els.hitRate,
        snap.attacks > 0 ? `${Math.round(snap.hitRate * 100)}%` : '—'
    );
    set(els.mana, fmtNum(snap.manaSpent));
    set(els.creatures, fmtNum(snap.creaturesAlive));

    // Wave HUD: show only when the hunt has a sequential wave controller.
    if (els.waveRow) {
        if (snap.waveHud) {
            els.waveRow.hidden = false;
            set(els.wave, snap.waveHud);
        } else {
            els.waveRow.hidden = true;
            set(els.wave, '—');
        }
    } else if (els.wave) {
        set(els.wave, snap.waveHud || '—');
    }

    if (els.elementBreakdown) {
        const parts = [];
        const map = snap.damageByElement || {};
        for (const k of Object.keys(map)) {
            parts.push(`${k}: ${fmtNum(map[k])}`);
        }
        els.elementBreakdown.textContent = parts.length
            ? parts.join(' · ')
            : '—';
    }

    if (els.memberList) {
        const rows = snap.members || [];
        if (!rows.length) {
            els.memberList.innerHTML =
                '<p class="text-muted small mb-0">No party</p>';
        } else {
            const html = rows
                .map((m) => {
                    const leader = m.isLeader ? '★ ' : '';
                    const dead = m.alive === false ? ' (down)' : '';
                    const hp =
                        m.hpMax > 0
                            ? `${fmtNum(m.hp)}/${fmtNum(m.hpMax)}`
                            : '—';
                    const dmg = fmtNum(m.damageDealt);
                    const autoAtkPh = fmtNum(m.autoAttacksPerHour);
                    const ai = m.aiState ? ` · ${m.aiState}` : '';
                    const hasPos =
                        Number.isFinite(Number(m.x)) &&
                        Number.isFinite(Number(m.y));
                    const pos = hasPos
                        ? Number.isFinite(Number(m.z))
                            ? ` · (${fmtNum(m.x)},${fmtNum(m.y)},${fmtNum(m.z)})`
                            : ` · (${fmtNum(m.x)},${fmtNum(m.y)})`
                        : '';
                    return (
                        `<div class="live-member">` +
                        `<span class="live-member-name">${leader}${escapeHtml(
                            m.name || '?'
                        )}${dead}</span>` +
                        `<span class="live-member-meta">HP ${hp} · dmg ${dmg}${escapeHtml(
                            ai
                        )}${pos}</span>` +
                        `<span class="live-member-meta">AutoAtk/h ${autoAtkPh}</span>` +
                        `</div>`
                    );
                })
                .join('');
            els.memberList.innerHTML = html;
        }
    }
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Start a polling timer that refreshes the live panel from Application.currentLevel.
 * When the session ends, freezes on the final snapshot (no further DOM churn)
 * until a new non-terminal sim is observed (Play / seek to mid-hunt).
 *
 * Detects new `sim.floorHopLog` rows (tick-accurate stair hops) and fires
 * `onFloorHop` so the host can auto-pause for multi-floor isolation without scrub.
 *
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {() => boolean} [opts.isPaused]
 * @param {Record<string, HTMLElement|null>} opts.els
 * @param {number} [opts.intervalMs=250]
 * @param {(hops: object[], snap: object, sim: object) => void} [opts.onFloorHop]
 * @returns {() => void} stop function
 */
function startLivePanelPoll(opts) {
    const o = opts || {};
    const intervalMs = o.intervalMs != null ? o.intervalMs : 250;
    /** @type {object|null} */
    let frozenSnap = null;
    /** @type {string|null} */
    let frozenKey = null;
    /** Last hop log length seen (sync after seek / new session without firing). */
    let hopLogSeen = 0;

    const tick = () => {
        // Hidden tab: skip work; next visible tick will catch up.
        if (typeof document !== 'undefined' && document.hidden) return;

        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        if (!sim) {
            hopLogSeen = 0;
            // Idle page (no session): paint empty once, then skip re-renders.
            if (frozenKey === '__no_sim__') return;
            frozenSnap = null;
            frozenKey = '__no_sim__';
            const empty = snapshotFromSim(null);
            renderLivePanel(o.els, empty, { paused: false });
            return;
        }
        if (frozenKey === '__no_sim__') {
            frozenKey = null;
            frozenSnap = null;
        }

        const state = sim.sessionState || 'idle';
        const terminal = isSessionTerminal(state);
        // Freeze key: session state + tick so seek-to-end re-snapshots once.
        const key = terminal
            ? `${state}:${sim.tickCount || 0}:${sim.seed || 0}`
            : null;

        if (terminal && frozenSnap && frozenKey === key) {
            // Keep final numbers; only refresh paused label on the badge.
            const paused =
                typeof o.isPaused === 'function' ? o.isPaused() : false;
            if (o.els && o.els.sessionState) {
                let label = String(frozenSnap.sessionState || 'idle').toUpperCase();
                if (paused && frozenSnap.sessionState === 'running') {
                    label = 'PAUSED';
                }
                o.els.sessionState.textContent = label;
            }
            return;
        }

        const snap = snapshotFromSim(sim);
        if (terminal) {
            frozenSnap = snap;
            frozenKey = key;
        } else {
            frozenSnap = null;
            frozenKey = null;
        }

        // Tick-accurate hop log lives on the sim; only fire on live growth.
        // Seek reseed rebuilds the log — ignore during _seekInProgress so scrub
        // does not auto-pause; after seek, sync the cursor without firing.
        const hops = snap.floorHopLog || [];
        if (hops.length < hopLogSeen) {
            hopLogSeen = hops.length;
        }
        if (sim._seekInProgress) {
            hopLogSeen = hops.length;
        } else if (hops.length > hopLogSeen) {
            const fresh = hops.slice(hopLogSeen);
            hopLogSeen = hops.length;
            if (typeof o.onFloorHop === 'function' && fresh.length) {
                try {
                    o.onFloorHop(fresh, snap, sim);
                } catch (_) {
                    /* host UI must not break the poll */
                }
            }
        }

        const paused = typeof o.isPaused === 'function' ? o.isPaused() : false;
        renderLivePanel(o.els, snap, { paused });
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
}

module.exports = {
    ratePerHour,
    fmtNum,
    formatWaveHud,
    formatPartyFloors,
    formatFloorHopLog,
    cloneFloorHopLog,
    cloneParityTickLog,
    formatParityTickLog,
    sortedCountEntries,
    formatCountMapLine,
    snapshotFromSim,
    bindLivePanelElements,
    renderLivePanel,
    renderMemberDetailsHtml,
    renderPartyDetailsHtml,
    setPartyDetailsOpen,
    bindPartyDetailsModal,
    startLivePanelPoll,
    escapeHtml,
    isSessionTerminal
};
