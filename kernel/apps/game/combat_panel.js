/**
 * Combat panel (sorted live enemies in engage range), Party panel (ally roster
 * with vitals), and collapsible behavior for sidebar inventory section panels.
 */

'use strict';

const { getActivePlayerFromSim, readSourceVitals } = require('./equipment_panel.js');
const { resolveManaShieldBar } = require('../../core/lib/combat/conditions.js');

/** Sidebar mana-shield fill (matches canvas nameplate). */
const MANA_SHIELD_BAR_FILL = '#a855f7';

/**
 * Insert / update / remove the thin mana-shield bar above the HP bar.
 * @param {HTMLElement|null} row
 * @param {object|null|undefined} source
 */
function syncManaShieldBar(row, source) {
    if (!row) return;
    const info = row.querySelector('.entity-list-info');
    if (!info) return;
    const bar = resolveManaShieldBar(source);
    let wrap = info.querySelector('.entity-list-ms-bar-bg');
    if (!bar) {
        if (wrap) wrap.remove();
        return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(bar.frac * 100)));
    const title =
        bar.mode === 'pooled'
            ? `Magic shield ${bar.remaining} / ${bar.max}`
            : 'Magic shield (gear)';
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'entity-list-ms-bar-bg';
        wrap.innerHTML =
            `<div class="entity-list-ms-bar-fill" style="width:${pct}%;` +
            `background-color:${MANA_SHIELD_BAR_FILL};"></div>`;
        const hpBg = info.querySelector('.entity-list-hp-bar-bg');
        if (hpBg) info.insertBefore(wrap, hpBg);
        else info.appendChild(wrap);
    } else {
        const fill = wrap.querySelector('.entity-list-ms-bar-fill');
        if (fill) {
            fill.style.width = `${pct}%`;
            fill.style.backgroundColor = MANA_SHIELD_BAR_FILL;
        }
    }
    wrap.title = title;
}
const { entitySpriteOpts, resolveSpriteUrl } = require('../../core/lib/creature_sprites.js');
const { resolvePlayerSpriteArt } = require('../../core/lib/character/player_profile.js');
const {
    resolveEngageRange,
    engageQueryRadius,
    isWithinEngageRange
} = require('../../core/lib/ai/engage_range.js');
const {
    uiState,
    clearTargetCursorMode,
    isMouseButtonDown,
    armSuppressNextContextMenu,
    consumeSuppressNextContextMenu
} = require('./ui_state.js');
const { isClassicLookChord, creatureLookText } = require('./mouse_dispatcher.js');
const { isAttackableCreature } = require('../../core/lib/npc/flags.js');
const {
    bindCollapsiblePanels,
    bindSidebarPanels
} = require('./sidebar_panels.js');
const { bindSkillsPanel } = require('./skills_panel.js');

const SORT_STORAGE_KEY = 'hdl_combat_sort';

const SORT_LABELS = {
    display_time_asc: 'Display Time - ASC',
    display_time_desc: 'Display Time - DESC',
    distance_asc: 'Distance - ASC',
    distance_desc: 'Distance - DESC',
    hp_percent_asc: '% HP - ASC',
    hp_percent_desc: '% HP - DESC',
    name_asc: 'Name - ASC',
    name_desc: 'Name - DESC'
};

const DEFAULT_SORT = 'display_time_asc';

/** @type {object[]} */
let lastSortedCreatures = [];

/** @type {(() => void)|null} */
let lastCombatRefresh = null;

/** @type {HTMLElement|null} */
let activeCombatCtxMenu = null;

/**
 * Dismiss any open combat creature context menu.
 */
function hideCombatContextMenu() {
    if (activeCombatCtxMenu && activeCombatCtxMenu.remove) {
        activeCombatCtxMenu.remove();
        activeCombatCtxMenu = null;
    }
}

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
 * HP color ramps like legacy ShowName (green → yellow → red).
 * @param {number} frac 0..1
 * @returns {string}
 */
function hpFill(frac) {
    if (frac > 0.7) return '#00ff00';
    if (frac > 0.4) return '#ffff00';
    return '#ff0000';
}

/**
 * Chebyshev distance between two tiles.
 * @param {{x?: number, y?: number}|null} a
 * @param {{y?: number, x?: number}|null} b
 * @returns {number}
 */
function chebyshev(a, b) {
    if (!a || !b) return 9999;
    const ax = a.x != null ? Number(a.x) : 0;
    const ay = a.y != null ? Number(a.y) : 0;
    const bx = b.x != null ? Number(b.x) : 0;
    const by = b.y != null ? Number(b.y) : 0;
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * Stable entity identity for list rows (never random).
 * Prefers positive numeric/string id; falls back to uid; last resort type+name.
 * @param {object|null|undefined} entity
 * @param {string} [prefix]
 * @returns {string}
 */
function entityKey(entity, prefix) {
    const p = prefix || '';
    if (!entity) return `${p}null`;
    if (entity.id != null && entity.id !== 0 && entity.id !== '0') {
        return `${p}id:${entity.id}`;
    }
    if (entity.uid != null && entity.uid !== '') {
        return `${p}uid:${entity.uid}`;
    }
    if (entity.profileId != null && entity.profileId !== '') {
        return `${p}profile:${entity.profileId}`;
    }
    const type = entity.creatureType || entity.classId || entity.vocation || '';
    const name = entity.name || entity.label || '';
    if (type || name) {
        return `${p}fallback:${type}:${name}`;
    }
    return `${p}unknown`;
}

/**
 * Player engage query radius (max of X/Y box; strategy → Settings).
 * @param {object|null} player
 * @returns {number}
 */
function engageRangeFor(player) {
    return Math.max(1, engageQueryRadius(resolveEngageRange(player)));
}

/**
 * Player engage box (strategy → Settings defaults 7×7).
 * @param {object|null} player
 * @returns {{ x: number, y: number }}
 */
function engageRangeXYFor(player) {
    return resolveEngageRange(player);
}

/**
 * Resolve 32x32 sprite icon URL for an entity or party member.
 * @param {object} entity
 * @param {string} [genre]
 * @returns {string|null}
 */
function resolveEntitySpriteIcon(entity, genre) {
    if (!entity) return null;
    try {
        if (entity.vocation || entity.classId || entity.customSprite) {
            const art = resolvePlayerSpriteArt(entity, entity.classDef);
            const id =
                art.spriteId ||
                entity.customSprite ||
                entity.creatureType ||
                entity.classId ||
                entity.vocation ||
                null;
            if (id) {
                const url = resolveSpriteUrl({
                    genre: art.spriteGenre || genre || 'rpg_fantasy',
                    id,
                    variant: 'icon'
                });
                if (url) return url;
            }
        }
        const opts = entitySpriteOpts(entity, {
            genre: genre || 'rpg_fantasy',
            variant: 'icon'
        });
        return resolveSpriteUrl(opts);
    } catch (_) {
        return null;
    }
}

/**
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function normalizeSortKey(raw) {
    if (raw && SORT_LABELS[raw]) return raw;
    return DEFAULT_SORT;
}

/**
 * @returns {string}
 */
function loadSortPreference() {
    try {
        if (typeof localStorage === 'undefined') return DEFAULT_SORT;
        return normalizeSortKey(localStorage.getItem(SORT_STORAGE_KEY));
    } catch (_) {
        return DEFAULT_SORT;
    }
}

/**
 * @param {string} sortKey
 */
function saveSortPreference(sortKey) {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(SORT_STORAGE_KEY, normalizeSortKey(sortKey));
    } catch (_) {
        /* ignore quota / private mode */
    }
}

/**
 * Clear list container to a known empty/idle message (removes stale rows + <p>).
 * @param {HTMLElement} listEl
 * @param {string} message
 * @param {string} state
 */
function setListMessage(listEl, message, state) {
    if (listEl.dataset.state === state) return;
    listEl.innerHTML = `<p class="text-muted small mb-0 p-1">${escapeHtml(message)}</p>`;
    listEl.dataset.state = state;
}

/**
 * Ensure list is ready for row painting (drops idle/empty placeholders).
 * @param {HTMLElement} listEl
 */
function beginListPaint(listEl) {
    if (listEl.dataset.state) {
        listEl.innerHTML = '';
        delete listEl.dataset.state;
    }
}

/**
 * @param {number|null|undefined} hp
 * @param {number|null|undefined} hpMax
 * @returns {number}
 */
function hpPercent(hp, hpMax) {
    if (hp == null || !Number.isFinite(Number(hp))) return 0;
    const max = Math.max(1, Number(hpMax) || 1);
    return Math.max(0, Math.min(100, Math.round((Number(hp) / max) * 100)));
}

/**
 * Sort creatures in-place by current sort mode.
 * @param {object[]} creatures
 * @param {string} currentSort
 * @param {Map<string, number>} creatureDisplayTimes
 * @param {{x?: number, y?: number}} playerTile
 */
function sortCreatures(creatures, currentSort, creatureDisplayTimes, playerTile) {
    creatures.sort((a, b) => {
        const keyA = entityKey(a);
        const keyB = entityKey(b);
        const timeA = creatureDisplayTimes.get(keyA) || 0;
        const timeB = creatureDisplayTimes.get(keyB) || 0;

        let diff = 0;
        if (currentSort === 'display_time_asc') {
            diff = timeA - timeB;
        } else if (currentSort === 'display_time_desc') {
            diff = timeB - timeA;
        } else if (currentSort === 'distance_asc' || currentSort === 'distance_desc') {
            const distA = chebyshev(playerTile, a.tile);
            const distB = chebyshev(playerTile, b.tile);
            diff = currentSort === 'distance_asc' ? distA - distB : distB - distA;
        } else if (currentSort === 'hp_percent_asc' || currentSort === 'hp_percent_desc') {
            const hpA = readSourceVitals(a);
            const hpB = readSourceVitals(b);
            const pctA = hpPercent(hpA.hp, hpA.hpMax);
            const pctB = hpPercent(hpB.hp, hpB.hpMax);
            diff = currentSort === 'hp_percent_asc' ? pctA - pctB : pctB - pctA;
        } else if (currentSort === 'name_asc' || currentSort === 'name_desc') {
            const nameA = String(a.name || a.label || a.creatureType || '').toLowerCase();
            const nameB = String(b.name || b.label || b.creatureType || '').toLowerCase();
            diff = nameA.localeCompare(nameB);
            if (currentSort === 'name_desc') diff = -diff;
        }
        if (diff === 0 && currentSort !== 'display_time_asc') {
            diff = timeA - timeB;
        }
        if (diff === 0) {
            // Stable secondary: entity key so order does not flicker
            if (keyA < keyB) return -1;
            if (keyA > keyB) return 1;
        }
        return diff;
    });
}

/**
 * Wire Combat panel with sorting options and target highlight.
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {() => boolean} [opts.isSessionLive]
 * @param {() => string} [opts.getGenre]
 * @param {number} [opts.intervalMs=250] 0 = no internal timer (external refresh)
 * @returns {{ refresh: () => void, dispose: () => void }}
 */
function bindCombatPanel(opts) {
    const o = opts || {};
    if (typeof document === 'undefined') return { refresh: () => {}, dispose: () => {} };

    const listEl = document.getElementById('combatCreaturesList');
    const sortBtn = document.getElementById('combatSortBtn');
    const sortDropdown = document.getElementById('combatSortDropdown');
    const sortItems = document.querySelectorAll('.combat-sort-item');

    let currentSort = loadSortPreference();
    let displaySequence = 0;
    /** @type {Map<string, number>} */
    const creatureDisplayTimes = new Map();
    let timer = null;
    let currentSim = null;
    /** @type {string} */
    let lastSig = '';

    const setSort = (sortKey) => {
        const next = normalizeSortKey(sortKey);
        currentSort = next;
        saveSortPreference(next);
        if (sortBtn) {
            sortBtn.title = `Sort by: ${SORT_LABELS[next]}`;
        }
        if (sortItems) {
            sortItems.forEach((item) => {
                const k = item.getAttribute('data-sort');
                item.classList.toggle('active', k === next);
            });
        }
        lastSig = '';
    };

    // Apply saved preference to UI on bind
    setSort(currentSort);

    const toggleDropdown = (ev) => {
        if (!sortDropdown) return;
        ev.stopPropagation();
        sortDropdown.hidden = !sortDropdown.hidden;
    };

    const onDocClick = (ev) => {
        hideCombatContextMenu();
        if (sortDropdown && !sortDropdown.hidden) {
            const t = /** @type {Element|null} */ (ev.target);
            if (!t || !t.closest || !t.closest('.combat-sort-container')) {
                sortDropdown.hidden = true;
            }
        }
    };

    const onItemClick = (ev) => {
        ev.stopPropagation();
        const k = ev.currentTarget.getAttribute('data-sort');
        if (k) {
            setSort(k);
            if (sortDropdown) sortDropdown.hidden = true;
            refresh();
        }
    };

    if (sortBtn) sortBtn.addEventListener('click', toggleDropdown);
    if (typeof document !== 'undefined') document.addEventListener('click', onDocClick);
    if (sortItems) {
        sortItems.forEach((item) => item.addEventListener('click', onItemClick));
    }

    const refresh = () => {
        if (!listEl) return;
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        const live = typeof o.isSessionLive === 'function' ? !!o.isSessionLive() : !!sim;

        if (sim !== currentSim) {
            currentSim = sim;
            creatureDisplayTimes.clear();
            displaySequence = 0;
            lastSig = '';
            listEl.innerHTML = '';
            delete listEl.dataset.state;
        }

        if (!sim || !live) {
            lastSortedCreatures = [];
            setListMessage(listEl, 'No creatures in combat', 'idle');
            lastSig = 'idle';
            return;
        }

        const activePlayer = getActivePlayerFromSim(sim);
        let viewZ = '0';
        if (activePlayer && activePlayer.tile && activePlayer.tile.z != null) {
            viewZ = String(activePlayer.tile.z);
        } else if (sim.Settings && sim.Settings.cameraTileZ != null) {
            viewZ = String(sim.Settings.cameraTileZ);
        }

        const activeTarget =
            activePlayer && activePlayer.target && activePlayer.target.alive !== false
                ? activePlayer.target
                : null;
        const playerTile =
            activePlayer && activePlayer.tile ? activePlayer.tile : { x: 0, y: 0 };
        const engageBox = engageRangeXYFor(activePlayer);
        const genre = typeof o.getGenre === 'function' ? o.getGenre() : 'rpg_fantasy';

        const creatures = (sim.creatures || []).filter((c) => {
            if (!c || c.alive === false || !c.tile) return false;
            // Talkable guides are not hunt targets (Q6.2 / Stage 6b)
            if (!isAttackableCreature(c)) return false;
            const cz = c.tile.z != null ? String(c.tile.z) : '0';
            if (cz !== viewZ) return false;
            // Phase G2: hide invisible monsters from combat list (players cannot see them)
            if (
                c.invisible ||
                (Array.isArray(c.conditions) &&
                    c.conditions.some((x) => x && x.kind === 'invisible'))
            ) {
                return false;
            }
            // Always keep the active target listed even if it briefly leaves range
            if (activeTarget && (c === activeTarget || c.id === activeTarget.id)) {
                return true;
            }
            return isWithinEngageRange(playerTile, c.tile, engageBox);
        });

        if (creatures.length === 0) {
            lastSortedCreatures = [];
            // Prune display times when nothing in range
            if (creatureDisplayTimes.size) creatureDisplayTimes.clear();
            setListMessage(listEl, 'No creatures in engage range', 'empty');
            lastSig = 'empty';
            return;
        }

        creatures.forEach((c) => {
            const key = entityKey(c);
            if (!creatureDisplayTimes.has(key)) {
                creatureDisplayTimes.set(key, ++displaySequence);
            }
        });

        sortCreatures(creatures, currentSort, creatureDisplayTimes, playerTile);
        lastSortedCreatures = creatures.slice();
        lastCombatRefresh = refresh;

        // Dirty signature: skip DOM work when order + vitals + target unchanged.
        // Include engage box so strategy/settings range changes repaint the list.
        // (Do not reference a free `range` — that was a ReferenceError that blanked
        // the combat list whenever any creature was in engage range.)
        const sigParts = [
            currentSort,
            String(activeTarget && activeTarget.id),
            `${engageBox.x}x${engageBox.y}`
        ];
        for (let i = 0; i < creatures.length; i++) {
            const c = creatures[i];
            const vitals = readSourceVitals(c);
            const pct = hpPercent(vitals.hp, vitals.hpMax);
            const isTarget =
                activeTarget && (c === activeTarget || c.id === activeTarget.id) ? 1 : 0;
            sigParts.push(`${entityKey(c)}:${pct}:${isTarget}`);
        }
        const sig = sigParts.join('|');
        if (sig === lastSig && listEl.dataset.state == null) {
            return;
        }
        lastSig = sig;

        beginListPaint(listEl);

        const currentRows = Array.from(listEl.querySelectorAll('.entity-list-row'));
        const rowByKey = new Map();
        currentRows.forEach((row) => rowByKey.set(row.getAttribute('data-uid'), row));

        /** @type {Set<string>} */
        const activeKeys = new Set();

        creatures.forEach((c, index) => {
            const key = entityKey(c);
            activeKeys.add(key);
            const name = String(c.name || c.label || c.creatureType || 'Creature');
            const safeName = escapeHtml(name);
            const vitals = readSourceVitals(c);
            const hpPct = hpPercent(vitals.hp, vitals.hpMax);
            const isTarget = !!(
                activeTarget &&
                (c === activeTarget || c.id === activeTarget.id)
            );
            const iconUrl = resolveEntitySpriteIcon(c, genre) || '';

            let row = rowByKey.get(key);
            if (!row) {
                row = document.createElement('div');
                row.className = 'entity-list-row';
                row.setAttribute('data-uid', key);
                row.innerHTML = `
                    <div class="entity-list-icon">
                        ${
                            iconUrl
                                ? `<img src="${escapeHtml(iconUrl)}" alt="${safeName}" title="${safeName}">`
                                : `<span class="icon-placeholder">${safeName.substring(0, 2)}</span>`
                        }
                    </div>
                    <div class="entity-list-info">
                        <div class="entity-list-name-row">
                            <span class="entity-list-name" title="${safeName}">${safeName}</span>
                            <span class="entity-list-hp-text">${hpPct}%</span>
                        </div>
                        <div class="entity-list-hp-bar-bg">
                            <div class="entity-list-hp-bar-fill" style="width: ${hpPct}%; background-color: ${hpFill(hpPct / 100)};"></div>
                        </div>
                    </div>
                `;
                const img = row.querySelector('img');
                if (img) {
                    img.addEventListener('error', () => {
                        const parent = img.parentElement;
                        if (parent) {
                            parent.innerHTML = `<span class="icon-placeholder">${safeName.substring(0, 2)}</span>`;
                        }
                    });
                }
                rowByKey.set(key, row);
            } else {
                const nameEl = row.querySelector('.entity-list-name');
                if (nameEl) {
                    if (nameEl.getAttribute('title') !== name) {
                        nameEl.setAttribute('title', name);
                        nameEl.textContent = name;
                    }
                }
                const hpText = row.querySelector('.entity-list-hp-text');
                if (hpText && hpText.textContent !== `${hpPct}%`) {
                    hpText.textContent = `${hpPct}%`;
                }
                const hpBar = row.querySelector('.entity-list-hp-bar-fill');
                if (hpBar) {
                    hpBar.style.width = `${hpPct}%`;
                    hpBar.style.backgroundColor = hpFill(hpPct / 100);
                }
                const img = row.querySelector('.entity-list-icon img');
                if (iconUrl && img && img.getAttribute('src') !== iconUrl) {
                    img.setAttribute('src', iconUrl);
                    img.setAttribute('alt', name);
                    img.setAttribute('title', name);
                }
            }
            syncManaShieldBar(row, c);
            row.classList.toggle('is-target', isTarget);
            row.onmouseenter = () => {
                if (uiState) {
                    uiState.hoveredEntityKey = key;
                    uiState.hoveredEntityId = c.id != null ? c.id : null;
                    uiState.hoveredEntity = c;
                }
            };
            row.onmouseleave = () => {
                if (uiState && (uiState.hoveredEntityKey === key || uiState.hoveredEntity === c)) {
                    uiState.hoveredEntityKey = null;
                    uiState.hoveredEntityId = null;
                    uiState.hoveredEntity = null;
                }
            };
            row.onclick = (ev) => {
                ev.preventDefault();
                const sim = typeof o.getSim === 'function' ? o.getSim() : null;
                const player = sim ? getActivePlayerFromSim(sim) : null;
                if (!player || !sim || !c || c.id == null || c.alive === false) return;
                if (!Array.isArray(player.commandQueue)) player.commandQueue = [];

                // Stage 7: Classic LMB while RMB held → Look creature (FCT)
                const mode =
                    uiState && uiState.mouseControlMode != null
                        ? Number(uiState.mouseControlMode)
                        : 1;
                if (
                    isClassicLookChord({
                        mode,
                        button: 'left',
                        leftPressed: true,
                        rightPressed: isMouseButtonDown('right')
                    })
                ) {
                    armSuppressNextContextMenu();
                    if (sim && typeof sim.emitCombatText === 'function') {
                        const t = c.tile || player.tile || {};
                        sim.emitCombatText({
                            x: t.x || 0,
                            y: t.y || 0,
                            z: t.z,
                            text: creatureLookText(c),
                            color: '#f59e0b',
                            life: 1.1
                        });
                    }
                    return;
                }

                if (uiState && uiState.activeActionCursor) {
                    const cur = uiState.activeActionCursor;
                    const cmd = {
                        type: cur.type,
                        sourceUid: cur.sourceUid,
                        itemId: cur.itemId,
                        spellId: cur.spellId,
                        target: { kind: 'entity', id: c.id }
                    };
                    player.commandQueue.push(cmd);
                    clearTargetCursorMode();
                } else {
                    player.commandQueue.push({ type: 'SET_TARGET', targetId: c.id });
                    player.targetId = c.id;
                    player.target = c;
                    refresh();
                }
            };
            row.oncontextmenu = (ev) => {
                ev.preventDefault();
                if (consumeSuppressNextContextMenu()) return;
                const sim = typeof o.getSim === 'function' ? o.getSim() : null;
                const player = sim ? getActivePlayerFromSim(sim) : null;
                if (!player || !sim || !c || c.id == null || c.alive === false) return;
                if (typeof document === 'undefined') return;

                // Stage 7: Classic RMB while LMB held → Look creature
                const mode =
                    uiState && uiState.mouseControlMode != null
                        ? Number(uiState.mouseControlMode)
                        : 1;
                if (
                    isClassicLookChord({
                        mode,
                        button: 'right',
                        leftPressed: isMouseButtonDown('left'),
                        rightPressed: true
                    })
                ) {
                    hideCombatContextMenu();
                    if (sim && typeof sim.emitCombatText === 'function') {
                        const t = c.tile || player.tile || {};
                        sim.emitCombatText({
                            x: t.x || 0,
                            y: t.y || 0,
                            z: t.z,
                            text: creatureLookText(c),
                            color: '#f59e0b',
                            life: 1.1
                        });
                    }
                    return;
                }

                hideCombatContextMenu();
                if (!isAttackableCreature(c)) return;
                activeCombatCtxMenu = document.createElement('div');
                activeCombatCtxMenu.className = 'inv-context-menu';
                activeCombatCtxMenu.style.left = ev.clientX + 'px';
                activeCombatCtxMenu.style.top = ev.clientY + 'px';
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'inv-context-item';
                btn.textContent = 'Attack';
                btn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    hideCombatContextMenu();
                    if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
                    player.commandQueue.push({ type: 'SET_TARGET', targetId: c.id });
                    player.targetId = c.id;
                    player.target = c;
                    refresh();
                };
                activeCombatCtxMenu.appendChild(btn);
                document.body.appendChild(activeCombatCtxMenu);
            };

            const targetChild = listEl.children[index];
            if (targetChild !== row) {
                listEl.insertBefore(row, targetChild || null);
            }
        });

        currentRows.forEach((row) => {
            const k = row.getAttribute('data-uid');
            if (!activeKeys.has(k)) {
                row.remove();
            }
        });

        // Prune first-seen map for creatures no longer listed
        creatureDisplayTimes.forEach((_v, k) => {
            if (!activeKeys.has(k)) creatureDisplayTimes.delete(k);
        });
    };

    const intervalMs = o.intervalMs != null ? o.intervalMs : 250;
    refresh();
    if (intervalMs > 0) {
        timer = setInterval(refresh, intervalMs);
    }

    return {
        refresh,
        dispose: () => {
            hideCombatContextMenu();
            if (timer) clearInterval(timer);
            timer = null;
            if (sortBtn) sortBtn.removeEventListener('click', toggleDropdown);
            if (typeof document !== 'undefined') {
                document.removeEventListener('click', onDocClick);
            }
            if (sortItems) {
                sortItems.forEach((item) => item.removeEventListener('click', onItemClick));
            }
        }
    };
}

/**
 * Wire Party panel displaying ally roster with vitals and active status.
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {() => object[]} [opts.getIdleMembers]
 * @param {() => boolean} [opts.isSessionLive]
 * @param {() => string} [opts.getGenre]
 * @param {number} [opts.intervalMs=250] 0 = no internal timer
 * @returns {{ refresh: () => void, dispose: () => void }}
 */
function bindPartyPanel(opts) {
    const o = opts || {};
    if (typeof document === 'undefined') return { refresh: () => {}, dispose: () => {} };

    const listEl = document.getElementById('partyMembersList');
    let timer = null;
    let currentSim = null;
    /** @type {string} */
    let lastSig = '';

    const refresh = () => {
        if (!listEl) return;
        const sim = typeof o.getSim === 'function' ? o.getSim() : null;
        const live = typeof o.isSessionLive === 'function' ? !!o.isSessionLive() : !!sim;
        const genre = typeof o.getGenre === 'function' ? o.getGenre() : 'rpg_fantasy';

        if (sim !== currentSim) {
            currentSim = sim;
            lastSig = '';
            listEl.innerHTML = '';
            delete listEl.dataset.state;
        }

        /** @type {object[]} */
        let members = [];
        let activeMember = null;
        if (sim && sim.parties && sim.parties[0] && Array.isArray(sim.parties[0].members)) {
            members = sim.parties[0].members;
            activeMember = getActivePlayerFromSim(sim);
        } else if (typeof o.getIdleMembers === 'function') {
            members = o.getIdleMembers() || [];
        }

        // Stable paint order: only enabled members, sequential DOM index
        const visible = [];
        for (let i = 0; i < members.length; i++) {
            const m = members[i];
            if (!m || m.enabled === false) continue;
            visible.push(m);
        }

        if (visible.length === 0) {
            setListMessage(listEl, 'No party members', 'empty');
            lastSig = 'empty';
            return;
        }

        const sigParts = [live ? 'live' : 'idle', String(activeMember && activeMember.id)];
        for (let i = 0; i < visible.length; i++) {
            const m = visible[i];
            const vitals = readSourceVitals(m);
            const hasHp = vitals.hp != null && !isNaN(vitals.hp);
            const hpPct = hasHp ? hpPercent(vitals.hp, vitals.hpMax) : -1;
            const hasMp = vitals.mp != null && !isNaN(vitals.mp) && vitals.mpMax > 0;
            const mpPct = hasMp ? hpPercent(vitals.mp, vitals.mpMax) : -1;
            const isActive =
                activeMember &&
                (m === activeMember ||
                    (m.id != null && m.id === activeMember.id) ||
                    (m.profileId != null && m.profileId === activeMember.profileId))
                    ? 1
                    : 0;
            const dead = m.alive === false ? 1 : 0;
            sigParts.push(
                `${entityKey(m, 'p')}:${m.name || ''}:${hpPct}:${mpPct}:${isActive}:${dead}`
            );
        }
        const sig = sigParts.join('|');
        if (sig === lastSig && listEl.dataset.state == null) {
            return;
        }
        lastSig = sig;

        beginListPaint(listEl);

        const currentRows = Array.from(listEl.querySelectorAll('.entity-list-row'));
        const rowByKey = new Map();
        currentRows.forEach((row) => rowByKey.set(row.getAttribute('data-uid'), row));

        /** @type {Set<string>} */
        const activeKeys = new Set();

        visible.forEach((m, index) => {
            const key = entityKey(m, 'p');
            activeKeys.add(key);
            const name = String(m.name || m.label || m.classId || m.vocation || 'Ally');
            const safeName = escapeHtml(name);
            const vitals = readSourceVitals(m);
            const hasHp = vitals.hp != null && !isNaN(vitals.hp);
            const hpPct = hasHp ? hpPercent(vitals.hp, vitals.hpMax) : 100;
            const hasMp = vitals.mp != null && !isNaN(vitals.mp) && vitals.mpMax > 0;
            const mpPct = hasMp ? hpPercent(vitals.mp, vitals.mpMax) : 0;
            const isActive = !!(
                activeMember &&
                (m === activeMember ||
                    (m.id != null && m.id === activeMember.id) ||
                    (m.profileId != null && m.profileId === activeMember.profileId))
            );
            const iconUrl = resolveEntitySpriteIcon(m, genre) || '';
            const crownHtml = m.isLeader
                ? '<i class="fa-solid fa-crown text-warning me-1" title="Leader"></i>'
                : '';

            let row = rowByKey.get(key);
            if (!row) {
                row = document.createElement('div');
                row.className = 'entity-list-row';
                row.setAttribute('data-uid', key);
                row.innerHTML = `
                    <div class="entity-list-icon">
                        ${
                            iconUrl
                                ? `<img src="${escapeHtml(iconUrl)}" alt="${safeName}" title="${safeName}">`
                                : `<span class="icon-placeholder">${safeName.substring(0, 2)}</span>`
                        }
                    </div>
                    <div class="entity-list-info">
                        <div class="entity-list-name-row">
                            <span class="entity-list-name" title="${safeName}">${crownHtml}${safeName}</span>
                            <span class="entity-list-hp-text">${hasHp ? `${hpPct}%` : '—'}</span>
                        </div>
                        <div class="entity-list-hp-bar-bg">
                            <div class="entity-list-hp-bar-fill" style="width: ${hpPct}%; background-color: ${hpFill(hpPct / 100)};"></div>
                        </div>
                        ${
                            hasMp
                                ? `<div class="entity-list-mp-bar-bg mt-1">
                            <div class="entity-list-mp-bar-fill" style="width: ${mpPct}%; background-color: #0088ff;"></div>
                        </div>`
                                : ''
                        }
                    </div>
                `;
                const img = row.querySelector('img');
                if (img) {
                    img.addEventListener('error', () => {
                        const parent = img.parentElement;
                        if (parent) {
                            parent.innerHTML = `<span class="icon-placeholder">${safeName.substring(0, 2)}</span>`;
                        }
                    });
                }
                rowByKey.set(key, row);
            } else {
                const nameEl = row.querySelector('.entity-list-name');
                if (nameEl) {
                    const desired = `${m.isLeader ? '1' : '0'}:${name}`;
                    if (nameEl.dataset.nameKey !== desired) {
                        nameEl.dataset.nameKey = desired;
                        nameEl.setAttribute('title', name);
                        nameEl.innerHTML = `${crownHtml}${safeName}`;
                    }
                }
                const hpText = row.querySelector('.entity-list-hp-text');
                if (hpText) hpText.textContent = hasHp ? `${hpPct}%` : '—';
                const hpBar = row.querySelector('.entity-list-hp-bar-fill');
                if (hpBar) {
                    hpBar.style.width = `${hpPct}%`;
                    hpBar.style.backgroundColor = hpFill(hpPct / 100);
                }
                let mpBar = row.querySelector('.entity-list-mp-bar-fill');
                if (mpBar && hasMp) {
                    mpBar.style.width = `${mpPct}%`;
                } else if (hasMp && !mpBar) {
                    const info = row.querySelector('.entity-list-info');
                    if (info) {
                        const wrap = document.createElement('div');
                        wrap.className = 'entity-list-mp-bar-bg mt-1';
                        wrap.innerHTML = `<div class="entity-list-mp-bar-fill" style="width: ${mpPct}%; background-color: #0088ff;"></div>`;
                        info.appendChild(wrap);
                    }
                }
                const img = row.querySelector('.entity-list-icon img');
                if (iconUrl && img && img.getAttribute('src') !== iconUrl) {
                    img.setAttribute('src', iconUrl);
                    img.setAttribute('alt', name);
                    img.setAttribute('title', name);
                }
            }
            syncManaShieldBar(row, m);
            row.classList.toggle('is-active-member', isActive);
            row.classList.toggle('is-dead', m.alive === false);
            row.onclick = (ev) => {
                ev.preventDefault();
                const sim = typeof o.getSim === 'function' ? o.getSim() : null;
                const activeMember = sim ? getActivePlayerFromSim(sim) : null;
                if (!activeMember || !sim || !m || m.id == null) return;
                if (!Array.isArray(activeMember.commandQueue)) activeMember.commandQueue = [];
                if (uiState && uiState.activeActionCursor) {
                    const cur = uiState.activeActionCursor;
                    const cmd = {
                        type: cur.type,
                        sourceUid: cur.sourceUid,
                        itemId: cur.itemId,
                        spellId: cur.spellId,
                        target: { kind: 'entity', id: m.id }
                    };
                    activeMember.commandQueue.push(cmd);
                    clearTargetCursorMode();
                }
            };

            const targetChild = listEl.children[index];
            if (targetChild !== row) {
                listEl.insertBefore(row, targetChild || null);
            }
        });

        currentRows.forEach((row) => {
            const k = row.getAttribute('data-uid');
            if (!activeKeys.has(k)) {
                row.remove();
            }
        });
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

/**
 * Bind combat + party + skills panels with a single shared poll timer.
 * @param {object} opts
 * @param {() => object|null} opts.getSim
 * @param {() => object[]} [opts.getIdleMembers]
 * @param {() => object|null} [opts.getIdleMember] active idle member for skills
 * @param {() => boolean} [opts.isSessionLive]
 * @param {() => string} [opts.getGenre]
 * @param {number} [opts.intervalMs=250]
 * @returns {{ refresh: () => void, dispose: () => void, combat: { refresh: () => void, dispose: () => void }, party: { refresh: () => void, dispose: () => void }, skills: { refresh: () => void, dispose: () => void } }}
 */
function bindRosterPanels(opts) {
    const o = opts || {};
    const intervalMs = o.intervalMs != null ? o.intervalMs : 250;
    const idleMs = o.idleIntervalMs != null ? o.idleIntervalMs : 2000;
    const shared = Object.assign({}, o, { intervalMs: 0 });
    const combat = bindCombatPanel(shared);
    const party = bindPartyPanel(shared);
    const skills = bindSkillsPanel({
        getSim: o.getSim,
        isSessionLive: o.isSessionLive,
        getIdleMember:
            typeof o.getIdleMember === 'function'
                ? o.getIdleMember
                : () => {
                      const list =
                          typeof o.getIdleMembers === 'function'
                              ? o.getIdleMembers() || []
                              : [];
                      for (let i = 0; i < list.length; i++) {
                          if (list[i] && list[i].enabled !== false) return list[i];
                      }
                      return null;
                  },
        intervalMs: 0
    });

    const refresh = () => {
        combat.refresh();
        party.refresh();
        skills.refresh();
    };

    let timer = null;
    let disposed = false;
    refresh();
    if (intervalMs > 0 && typeof setTimeout !== 'undefined') {
        const schedule = () => {
            if (disposed) return;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            const hidden = typeof document !== 'undefined' && document.hidden;
            const live = typeof o.isSessionLive === 'function' ? !!o.isSessionLive() : true;
            const ms = hidden ? Math.max(idleMs, 3000) : (live ? intervalMs : idleMs);
            timer = setTimeout(() => {
                timer = null;
                if (disposed) return;
                if (!(typeof document !== 'undefined' && document.hidden)) {
                    refresh();
                }
                schedule();
            }, ms);
        };
        schedule();
    }

    return {
        refresh,
        dispose: () => {
            disposed = true;
            if (timer) clearTimeout(timer);
            timer = null;
            combat.dispose();
            party.dispose();
            skills.dispose();
        },
        combat,
        party,
        skills
    };
}

/**
 * Cycle targeting through living creatures listed in the combat panel.
 * @param {object|null} sim
 * @param {object|null} player
 * @param {number} direction 1 for next target, -1 for previous target
 */
function cycleCombatTarget(sim, player, direction) {
    if (!player || !player.alive) return;
    const list = (lastSortedCreatures || []).filter((c) => c && c.alive !== false && c.id != null);
    if (!list.length) return;
    const currentId = player.target && player.target.id != null ? player.target.id : player.targetId;
    const idx = currentId != null ? list.findIndex((c) => c.id === currentId) : -1;
    let nextTarget = null;
    if (idx === -1) {
        nextTarget = direction > 0 ? list[0] : list[list.length - 1];
    } else {
        const nextIdx = (idx + direction + list.length) % list.length;
        nextTarget = list[nextIdx];
    }
    if (nextTarget && nextTarget.id != null) {
        if (!Array.isArray(player.commandQueue)) player.commandQueue = [];
        player.commandQueue.push({ type: 'SET_TARGET', targetId: nextTarget.id });
        player.targetId = nextTarget.id;
        player.target = nextTarget;
        if (lastCombatRefresh) lastCombatRefresh();
    }
}

module.exports = {
    hpFill,
    chebyshev,
    entityKey,
    engageRangeFor,
    engageRangeXYFor,
    escapeHtml,
    normalizeSortKey,
    loadSortPreference,
    saveSortPreference,
    sortCreatures,
    resolveEntitySpriteIcon,
    bindCollapsiblePanels,
    bindSidebarPanels,
    bindCombatPanel,
    bindPartyPanel,
    bindSkillsPanel,
    bindRosterPanels,
    cycleCombatTarget,
    hideCombatContextMenu,
    SORT_LABELS,
    DEFAULT_SORT,
    SORT_STORAGE_KEY
};
