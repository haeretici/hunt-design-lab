/**
 * Character Profile Preview Widget — legacy equipment card & inventory details.
 */
(function() {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    let mode = params.get('mode') || 'standard';
    let profileId = params.get('id') || '';
    /** When true, prefer live hp/mp from the payload (hunt watch). */
    let liveMode = params.get('live') === '1' || params.get('live') === 'true';

    /** @type {Record<string, any>} */
    let equipmentMap = {};
    let modeGenre = 'rpg_fantasy';
    let currentProfile = null;

    const els = {
        modeBadge: document.getElementById('ppModeBadge'),
        syncStatus: document.getElementById('ppSyncStatus'),
        refreshBtn: document.getElementById('ppRefreshBtn'),
        alert: document.getElementById('ppAlert'),
        title: document.getElementById('ppTitle'),
        idBadge: document.getElementById('ppIdBadge'),
        notes: document.getElementById('ppNotes'),
        vocation: document.getElementById('ppVocation'),
        level: document.getElementById('ppLevel'),
        hp: document.getElementById('ppHp'),
        mp: document.getElementById('ppMp'),
        totalArmor: document.getElementById('ppTotalArmor'),
        totalWeight: document.getElementById('ppTotalWeight'),
        strategy: document.getElementById('ppStrategy'),
        promoted: document.getElementById('ppPromoted'),
        soul: document.getElementById('ppSoul'),
        cap: document.getElementById('ppCap'),
        equipmentCard: document.getElementById('equipmentCard'),
        inventoryGrid: document.getElementById('ppInventoryGrid'),
        eqModalBody: document.getElementById('eqModalBody')
    };

    /**
     * Compute application root URL dynamically from page location or global config.
     */
    function appRoot() {
        if (typeof window !== 'undefined' && window.__APP_ROOT__ && typeof window.__APP_ROOT__ === 'string') {
            return window.__APP_ROOT__;
        }
        try {
            const url = new URL(window.location.href);
            const m = url.pathname.match(/^(.*\/)html\/widgets\//i);
            if (m) {
                url.pathname = m[1];
                url.search = '';
                url.hash = '';
                const href = url.href;
                return href.endsWith('/') ? href : href + '/';
            }
        } catch (_) {
            /* ignore */
        }
        return '/';
    }

    /**
     * Get root URL helper for assets and API calls.
     */
    function appUrl(relPath) {
        const clean = String(relPath || '').replace(/^\/+/, '');
        return new URL(clean, appRoot()).href;
    }

    /**
     * Format slot name into human readable label and icon.
     */
    function formatSlotInfo(slot) {
        const s = String(slot || '').toLowerCase();
        if (s === 'head' || s === 'helmet') return { icon: 'fa-solid fa-helmet-safety', label: 'Helmet (Head)' };
        if (s === 'chest' || s === 'armor' || s === 'body') return { icon: 'fa-solid fa-vest', label: 'Armor (Chest)' };
        if (s === 'legs') return { icon: 'fa-solid fa-socks', label: 'Legs / Pants' };
        if (s === 'boots' || s === 'feet') return { icon: 'fa-solid fa-shoe-prints', label: 'Boots (Feet)' };
        if (s === 'righthand' || s === 'weapon') return { icon: 'fa-solid fa-hand-fist', label: 'Weapon (Right Hand)' };
        if (s === 'lefthand' || s === 'shield') return { icon: 'fa-solid fa-shield', label: 'Shield (Left Hand)' };
        if (s === 'amulet' || s === 'neck') return { icon: 'fa-solid fa-gem', label: 'Amulet (Neck)' };
        if (s === 'ring') return { icon: 'fa-solid fa-ring', label: 'Ring' };
        if (s === 'backpack' || s === 'container') return { icon: 'fa-solid fa-bag-shopping', label: 'Backpack' };
        return { icon: 'fa-solid fa-box', label: String(slot || 'Equipment') };
    }

    /**
     * Format property keys into titlecase labels.
     */
    function formatPropLabel(str) {
        const s = String(str || '');
        return s.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
    }

    let catalogPromise = null;

    /**
     * Fetch mode genre & equipment catalog.
     */
    function loadCatalogs() {
        const loadedMode = mode;
        catalogPromise = (async () => {
            try {
                // Load equipment items catalog
                const eqRes = await fetch(appUrl(`php/api.php?action=presets_get&mode=${encodeURIComponent(loadedMode)}&kind=equipment`));
                if (eqRes.ok) {
                    const eqJson = await eqRes.json();
                    const rootData = (eqJson && eqJson.data) ? eqJson.data : eqJson;
                    const doc = (rootData && rootData.document) ? rootData.document : rootData;
                    const items = (doc && Array.isArray(doc.items)) ? doc.items : (Array.isArray(doc) ? doc : []);

                    equipmentMap = {};
                    items.forEach((item) => {
                        if (item && item.id) {
                            equipmentMap[item.id] = item;
                        }
                    });
                }

                // Load modes info to resolve active mode's genre
                const modeRes = await fetch(appUrl('php/api.php?action=modes_list'));
                if (modeRes.ok) {
                    const modeJson = await modeRes.json();
                    const modesArr = (modeJson && Array.isArray(modeJson.modes)) ? modeJson.modes : (Array.isArray(modeJson) ? modeJson : []);
                    const match = modesArr.find((m) => m && m.id === loadedMode);
                    if (match && match.genre) {
                        modeGenre = String(match.genre);
                    }
                }
            } catch (err) {
                console.warn('Failed loading equipment catalog:', err);
            }
        })();
        return catalogPromise;
    }


    /**
     * Resolve sprite image URL for an equipment item.
     * Prefer temporary catalog override (customSprite / spriteId) over combat id.
     */
    function resolveItemSpriteUrl(item) {
        if (!item) return null;
        if (item.sprites) {
            if (item.sprites.alpha) return appUrl(item.sprites.alpha);
            if (item.sprites.icon) return appUrl(item.sprites.icon);
            if (item.sprites.original) return appUrl(item.sprites.original);
        }
        if (item.sprite) {
            if (typeof item.sprite === 'string') return appUrl(item.sprite);
            if (item.sprite.legacy) return appUrl(item.sprite.legacy);
        }
        const itemId =
            typeof item === 'string'
                ? item
                : item.customSprite || item.spriteId || item.id || '';
        if (!itemId) return null;
        // Catalog stems are Title_Case files under equipment/alpha/
        const stem = String(itemId)
            .trim()
            .replace(/\.png$/i, '')
            .split(/[_\s-]+/)
            .filter(Boolean)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
            .join('_');
        return appUrl(`assets/sprites/${modeGenre}/equipment/alpha/${stem}.png`);
    }

    /**
     * HP / MP from vocation + level. Matches kernel poolMaxForLevel:
     * L1–7 all classes 150+(L−1)×5 HP, (L−1)×5 MP; L8 = 185/35;
     * after 8 class per-level.
     */
    function calculateHpMp(vocation, level) {
        const lvl = Math.max(1, parseInt(level, 10) || 1);
        if (lvl < 8) {
            return { maxHp: 150 + (lvl - 1) * 5, maxMp: (lvl - 1) * 5 };
        }
        const voc = String(vocation || '').toLowerCase();
        let hpPerLvl = 5;
        let mpPerLvl = 5;
        if (voc.includes('knight') || voc.includes('guardian')) {
            hpPerLvl = 15;
            mpPerLvl = 5;
        } else if (voc.includes('paladin') || voc.includes('ranger') || voc.includes('scout')) {
            hpPerLvl = 10;
            mpPerLvl = 15;
        } else if (
            voc.includes('sorcerer') ||
            voc.includes('adept') ||
            voc.includes('mage') ||
            voc.includes('druid') ||
            voc.includes('warden')
        ) {
            hpPerLvl = 5;
            mpPerLvl = 30;
        } else if (voc.includes('monk') || voc.includes('mystic')) {
            hpPerLvl = 10;
            mpPerLvl = 10;
        }
        return { maxHp: 185 + (lvl - 8) * hpPerLvl, maxMp: 35 + (lvl - 8) * mpPerLvl };
    }

    /** Matches kernel/core/lib/character/stats.js pipelineToPercent. */
    const COMBAT_PIPELINE_PER_PERCENT = 100;

    /**
     * Compact percent number for UI (no % suffix). 1000 → "10".
     * @param {unknown} n
     * @returns {string}
     */
    function formatPipelinePercent(n) {
        const v = (Number(n) || 0) / COMBAT_PIPELINE_PER_PERCENT;
        if (!Number.isFinite(v)) return '0';
        return String(Math.round(v * 1000) / 1000);
    }

    /**
     * Player-facing crit / leech lines. Pipeline units ÷ 100; chance stays 0–100.
     * @param {Record<string, unknown>|null|undefined} item
     * @returns {string[]}
     */
    function catalogSpecialBonusLines(item) {
        const row = item && typeof item === 'object' ? item : {};
        const lines = [];
        if (row.lifeLeech) lines.push(`Life Leech: ${row.lifeLeech}%`);
        if (row.lifeLeechChance != null && row.lifeLeechAmount != null) {
            lines.push(
                `Life Leech: ${row.lifeLeechChance}% / ${formatPipelinePercent(row.lifeLeechAmount)}%`
            );
        }
        if (row.manaLeech) lines.push(`Mana Leech: ${row.manaLeech}%`);
        if (row.manaLeechChance != null && row.manaLeechAmount != null) {
            lines.push(
                `Mana Leech: ${row.manaLeechChance}% / ${formatPipelinePercent(row.manaLeechAmount)}%`
            );
        }
        if (row.critChance) {
            lines.push(`Crit Chance: ${formatPipelinePercent(row.critChance)}%`);
        }
        if (row.critDamage) lines.push(`Crit Damage: ${row.critDamage}%`);
        if (row.critExtraDamage != null) {
            lines.push(`Crit Extra Dmg: ${formatPipelinePercent(row.critExtraDamage)}%`);
        }
        return lines;
    }

    /**
     * Display equipment stats in a modal (similar to tile picker right sidebar).
     */
    function showEquipmentModal(item, slotKey) {
        if (!item || !els.eqModalBody) return;

        const spriteUrl = resolveItemSpriteUrl(item);
        const slotInfo = formatSlotInfo(item.slot || slotKey);

        let pillsHtml = '';
        if (item.twoHanded === true || item.twoHanded === 'true' || item.twoHanded === 1) {
            pillsHtml += '<span class="eq-pill" style="color:#d2a8ff;border-color:rgba(210,168,255,0.4)"><i class="fa-solid fa-hands"></i> 2-Handed (2h)</span>';
        } else if (item.category === 'weapon' || item.weaponType || item.atk != null || item.slot === 'weapon') {
            pillsHtml += '<span class="eq-pill" style="color:#a8d2ff;border-color:rgba(168,210,255,0.4)"><i class="fa-solid fa-hand"></i> 1-Handed (1h)</span>';
        }
        if (item.imbuementSlots != null && Number(item.imbuementSlots) > 0) {
            pillsHtml += `<span class="eq-pill" style="color:#7bc8ff;border-color:rgba(123,200,255,0.4)"><i class="fa-solid fa-gem"></i> ${item.imbuementSlots} Imbuement Slots</span>`;
        }

        let statRows = '';
        const addRow = (icon, label, value, valClass) => {
            statRows += `
                <tr>
                    <td class="eq-stat-label"><i class="${icon}"></i> ${label}</td>
                    <td class="eq-stat-val ${valClass || ''}">${value}</td>
                </tr>
            `;
        };

        // Required Level
        const lvl = item.level != null ? item.level : 1;
        addRow('fa-solid fa-graduation-cap', 'Required Level', `Lvl ${lvl}`, 'text-info');

        // Slot
        addRow(slotInfo.icon, 'Slot', slotInfo.label, 'text-warning');

        // Category / Weapon Type
        if (item.category) {
            let catStr = String(item.category);
            if (item.weaponType) catStr += ` (${item.weaponType})`;
            addRow('fa-solid fa-layer-group', 'Category', catStr, '');
        }

        // Vocation / Allowed Classes
        if (item.vocation != null) {
            const vocStr = Array.isArray(item.vocation) ? item.vocation.join(', ') : String(item.vocation);
            if (vocStr) addRow('fa-solid fa-user-shield', 'Vocation', vocStr, '');
        }

        // Attack Range
        if (item.range != null && Number(item.range) > 0) {
            addRow('fa-solid fa-crosshair', 'Range', `${item.range} tiles`, '');
        }

        if (item.min != null || item.max != null) {
            const lo = item.min != null ? Number(item.min) : Number(item.max);
            const hi = item.max != null ? Number(item.max) : Number(item.min);
            const span = lo === hi ? String(lo) : `${lo}–${hi}`;
            const el = item.element ? ` ${formatPropLabel(item.element)}` : '';
            addRow('fa-solid fa-wand-magic-sparkles', 'Attack', `${span}${el}`, 'text-danger fw-bold');
        }
        if (item.manaGain != null && Number(item.manaGain) > 0) {
            addRow('fa-solid fa-droplet', 'Mana Gain', `+${Math.floor(Number(item.manaGain))} on damaging auto`, 'text-info');
        }

        // Physical Attack
        if (item.atk != null && item.atk !== 0) {
            addRow('fa-solid fa-burst', 'Attack (Physical)', `+${item.atk}`, 'text-danger fw-bold');
        }

        // Extra Elemental Attack
        if (item.extraAtk != null || item.extraAtkElement != null) {
            const valNum = Number(item.extraAtk) || 0;
            const elemStr = item.extraAtkElement ? formatPropLabel(item.extraAtkElement) : '';
            let extraVal = '';
            if (valNum > 0 && elemStr) extraVal = `+${valNum} (${elemStr})`;
            else if (valNum > 0) extraVal = `+${valNum}`;
            else if (elemStr) extraVal = elemStr;
            if (extraVal) addRow('fa-solid fa-fire', 'Elemental Attack', extraVal, 'text-warning');
        }

        // Armor
        if (item.armor != null && item.armor !== 0) {
            addRow('fa-solid fa-shield-halved', 'Armor', `+${item.armor}`, 'text-warning fw-bold');
        }

        // Defense & Defense Bonus
        if ((item.defense != null && item.defense !== 0) || (item.defenseBonus != null && item.defenseBonus !== 0)) {
            const defBase = Number(item.defense) || 0;
            const defBonus = Number(item.defenseBonus) || 0;
            let defStr = String(defBase);
            if (defBonus > 0) defStr += ` (+${defBonus} bonus)`;
            else if (defBonus < 0) defStr += ` (${defBonus} bonus)`;
            addRow('fa-solid fa-shield', 'Defense', defStr, 'text-primary fw-bold');
        }

        // Speed
        if (item.speed != null && item.speed !== 0) {
            const speedVal = Number(item.speed);
            const speedStr = speedVal >= 0 ? `+${speedVal}` : `${speedVal}`;
            addRow('fa-solid fa-bolt', 'Speed', speedStr, 'text-success');
        }

        // Weight
        if (item.weight != null) {
            const weightOz = Math.round(Number(item.weight) / 100);
            addRow('fa-solid fa-weight-hanging', 'Weight', `${weightOz} oz (${item.weight} g)`, 'text-muted');
        }

        // Special Bonuses (catalog pipeline ÷ 100; chance stays 0–100)
        let specialPillsHtml = '';
        const specialLines = catalogSpecialBonusLines(item);
        for (let i = 0; i < specialLines.length; i++) {
            specialPillsHtml += `<span class="eq-pill eq-pill-bonus">${specialLines[i]}</span>`;
        }

        // Skill & Stat Bonuses Section
        let bonusPillsHtml = '';
        const bonusesObj = item.skillBonuses || item.skills || item.bonuses;
        if (bonusesObj && typeof bonusesObj === 'object' && Object.keys(bonusesObj).length > 0) {
            for (const [k, val] of Object.entries(bonusesObj)) {
                if (val == null || val === 0) continue;
                const sign = Number(val) >= 0 ? '+' : '';
                bonusPillsHtml += `<span class="eq-pill eq-pill-bonus">${formatPropLabel(k)}: ${sign}${val}</span>`;
            }
        }

        // Resists Section
        let resistPillsHtml = '';
        const resistsObj = item.resists || item.resistances || item.elementalReduction;
        if (resistsObj && typeof resistsObj === 'object' && Object.keys(resistsObj).length > 0) {
            for (const [k, val] of Object.entries(resistsObj)) {
                if (val == null || val === 0) continue;
                const sign = Number(val) >= 0 ? '+' : '';
                resistPillsHtml += `<span class="eq-pill eq-pill-resist">${formatPropLabel(k)}: ${sign}${val}%</span>`;
            }
        }

        els.eqModalBody.innerHTML = `
            <div class="eq-modal-thumb">
                <img src="${spriteUrl}" alt="${item.label || item.id}" onerror="this.style.display='none'">
            </div>
            <div class="eq-modal-title">${item.label || item.id}</div>
            <div class="eq-modal-id">${item.id}</div>

            ${pillsHtml ? `<div class="text-center mb-3">${pillsHtml}</div>` : ''}

            <table class="eq-stat-table">
                <tbody>${statRows}</tbody>
            </table>

            ${specialPillsHtml ? `
                <div class="mb-3">
                    <h6 class="small text-muted text-uppercase font-monospace mb-1"><i class="fa-solid fa-wand-magic-sparkles text-cyan"></i> Special Bonuses</h6>
                    <div>${specialPillsHtml}</div>
                </div>
            ` : ''}

            ${bonusPillsHtml ? `
                <div class="mb-3">
                    <h6 class="small text-muted text-uppercase font-monospace mb-1"><i class="fa-solid fa-wand-magic-sparkles text-cyan"></i> Skill & Stat Bonuses</h6>
                    <div>${bonusPillsHtml}</div>
                </div>
            ` : ''}

            ${resistPillsHtml ? `
                <div class="mb-3">
                    <h6 class="small text-muted text-uppercase font-monospace mb-1"><i class="fa-solid fa-shield-virus text-primary"></i> Resists & Reductions</h6>
                    <div>${resistPillsHtml}</div>
                </div>
            ` : ''}

            ${item.notes || item.description ? `
                <div class="p-2 bg-dark rounded border border-secondary small text-muted font-monospace">
                    ${item.notes || item.description}
                </div>
            ` : ''}
        `;

        if (window.bootstrap && window.bootstrap.Modal) {
            const modal = window.bootstrap.Modal.getOrCreateInstance(document.getElementById('equipmentModal'));
            modal.show();
        }
    }

    /**
     * Render the character profile into UI.
     */
    function renderProfile(rawProfile) {
        if (!rawProfile) return;
        const root = (rawProfile && rawProfile.data) ? rawProfile.data : rawProfile;
        const profile = (root && root.entity) ? root.entity : root;
        currentProfile = profile;

        if (els.modeBadge) els.modeBadge.textContent = String(mode).toUpperCase();
        if (els.title) els.title.textContent = profile.label || profile.id || 'Unnamed Profile';
        if (els.idBadge) els.idBadge.textContent = profile.id || 'id';
        if (els.notes) els.notes.textContent = profile.notes || 'No designer notes provided.';

        const vocRaw = String(profile.vocation || 'None');
        const vocName = vocRaw.charAt(0).toUpperCase() + vocRaw.slice(1);
        if (els.vocation) els.vocation.textContent = vocName;
        if (els.level) els.level.textContent = profile.level || 50;
        if (els.promoted) {
            els.promoted.innerHTML = profile.promoted
                ? '<span class="badge bg-warning text-dark"><i class="fa-solid fa-crown"></i> Promoted</span>'
                : '<span class="badge bg-secondary">Standard</span>';
        }

        const estimated = calculateHpMp(profile.vocation || profile.classId, profile.level);
        // Live hunt payloads may include current/max vitals; designer uses estimates.
        const maxHp =
            profile.hpMax != null && Number.isFinite(Number(profile.hpMax))
                ? Number(profile.hpMax)
                : estimated.maxHp;
        const maxMp =
            profile.mpMax != null && Number.isFinite(Number(profile.mpMax))
                ? Number(profile.mpMax)
                : estimated.maxMp;
        const curHp =
            profile.hp != null && Number.isFinite(Number(profile.hp))
                ? Number(profile.hp)
                : maxHp;
        const curMp =
            profile.mp != null && Number.isFinite(Number(profile.mp))
                ? Number(profile.mp)
                : maxMp;
        if (els.hp) {
            els.hp.textContent = `${Math.round(curHp).toLocaleString()} / ${Math.round(maxHp).toLocaleString()}`;
        }
        if (els.mp) {
            els.mp.textContent = `${Math.round(curMp).toLocaleString()} / ${Math.round(maxMp).toLocaleString()}`;
        }

        if (els.strategy) els.strategy.textContent = profile.strategyId || 'none';
        if (els.syncStatus) {
            els.syncStatus.textContent = liveMode ? 'Live Session Sync' : 'Live Sync Active';
        }

        // Equipment items breakdown
        const equipment = profile.equipment || {};
        const slotKeys = ['head', 'chest', 'legs', 'boots', 'weapon', 'shield', 'amulet', 'ring', 'backpack'];

        let totalArmor = 0;
        let totalWeightOz = 0;
        const skillBonuses = { axe: 0, club: 0, distance: 0, fishing: 0, fist: 0, magicLevel: 0, shielding: 0, sword: 0 };
        const equippedList = [];

        slotKeys.forEach((slotKey) => {
            const itemId = equipment[slotKey];
            const slotEl = els.equipmentCard ? els.equipmentCard.querySelector(`[data-slot="${slotKey}"]`) : null;
            if (!slotEl) return;

            // Clear existing slot contents
            slotEl.innerHTML = '';

            if (itemId && String(itemId).trim()) {
                const cleanId = String(itemId).trim();
                const item = equipmentMap[cleanId] || { id: cleanId, label: cleanId };

                // Accrue stats
                if (item.armor) totalArmor += Number(item.armor) || 0;
                if (item.weight) totalWeightOz += Number(item.weight) || 0;

                // Accrue skill bonuses if present
                if (item.skills) {
                    Object.keys(skillBonuses).forEach((s) => {
                        if (item.skills[s]) skillBonuses[s] += Number(item.skills[s]) || 0;
                    });
                }

                equippedList.push({ slotKey, item });

                // Render sprite icon in equipment card slot
                const img = document.createElement('img');
                const primaryUrl = resolveItemSpriteUrl(item);
                img.src = primaryUrl;
                img.alt = item.label || cleanId;
                img.title = `${item.label || cleanId} (${slotKey})\nClick for full stats`;

                img.onerror = () => {
                    const fallbackUrl = appUrl(`assets/sprites/${modeGenre}/equipment/small/${cleanId}.png`);
                    if (img.src !== fallbackUrl) {
                        img.src = fallbackUrl;
                    } else {
                        slotEl.innerHTML = `<span class="small font-monospace" style="font-size:9px;">${cleanId.slice(0, 3)}</span>`;
                    }
                };

                slotEl.appendChild(img);

                // Click handler for opening equipment stats modal
                slotEl.onclick = (ev) => {
                    ev.stopPropagation();
                    showEquipmentModal(item, slotKey);
                };
            } else {
                slotEl.onclick = null;
                // Empty slot placeholder icons
                const placeholders = {
                    head: '<i class="fa-solid fa-helmet-safety"></i>',
                    chest: '<i class="fa-solid fa-vest"></i>',
                    legs: '<i class="fa-solid fa-socks"></i>',
                    boots: '<i class="fa-solid fa-shoe-prints"></i>',
                    weapon: '<i class="fa-solid fa-hand-fist"></i>',
                    shield: '<i class="fa-solid fa-shield"></i>',
                    amulet: '<i class="fa-solid fa-gem"></i>',
                    ring: '<i class="fa-solid fa-ring"></i>',
                    backpack: '<i class="fa-solid fa-bag-shopping"></i>',
                    light: '<i class="fa-solid fa-lightbulb"></i>'
                };
                slotEl.innerHTML = `<span class="slot-placeholder">${placeholders[slotKey] || ''}</span>`;
            }
        });

        // Collect container inventory items (e.g. arrows in quivers or spare gear in backpacks)
        const collectContainerEntries = (entries, containerLabel) => {
            if (!Array.isArray(entries)) return;
            entries.forEach((entry) => {
                if (!entry) return;
                let id = typeof entry === 'string' ? entry : (entry.itemId || entry.id);
                if (!id) return;
                const count = (typeof entry === 'object' && entry.count != null) ? Math.max(1, Math.floor(Number(entry.count))) : 1;
                const cleanId = String(id).trim();
                const item = equipmentMap[cleanId] || { id: cleanId, label: cleanId };
                if (item.weight) totalWeightOz += (Number(item.weight) || 0) * count;
                equippedList.push({ slotKey: containerLabel, item, count });
                if (typeof entry === 'object' && Array.isArray(entry.contents)) {
                    collectContainerEntries(entry.contents, `${containerLabel} -> ${item.label || cleanId}`);
                }
            });
        };
        if (profile.inventory && typeof profile.inventory === 'object') {
            Object.keys(profile.inventory).forEach((k) => {
                collectContainerEntries(profile.inventory[k], `in ${k}`);
            });
        }
        if (Array.isArray(profile.backpack) && (!profile.inventory || profile.inventory.backpack !== profile.backpack)) {
            collectContainerEntries(profile.backpack, 'in backpack');
        }

        // Update Totals
        if (els.totalArmor) els.totalArmor.textContent = totalArmor;
        if (els.totalWeight) els.totalWeight.textContent = `${(totalWeightOz / 100).toFixed(2)} oz`;

        // Capacity: keep in sync with kernel/core/lib/character/inventory.js baseCapacity
        // L1=600, L8=670 (+10/lvl); after 8: guardian/mystic +25, scout +20, others +10.
        const capLevel = Math.max(1, parseInt(profile.level, 10) || 50);
        const capVoc = String(
            profile.classId || profile.vocation || profile.class || 'adventurer'
        ).toLowerCase();
        let baseCap;
        if (capLevel < 8) {
            baseCap = 10 * (capLevel + 59);
        } else if (
            capVoc.includes('knight') ||
            capVoc.includes('guardian') ||
            capVoc.includes('monk') ||
            capVoc.includes('mystic')
        ) {
            baseCap = 5 * (5 * capLevel - 5 * 8 + 134);
        } else if (
            capVoc.includes('paladin') ||
            capVoc.includes('scout') ||
            capVoc.includes('ranger')
        ) {
            baseCap = 10 * (2 * capLevel - 8 + 59);
        } else {
            baseCap = 10 * (capLevel + 59);
        }
        const currentCap = Math.max(0, Math.floor(baseCap - totalWeightOz / 100));
        if (els.cap) els.cap.textContent = currentCap.toLocaleString();
        if (els.soul) els.soul.textContent = '100';

        // Render Skills Table
        const skills = profile.skills || {};
        const skillKeys = ['axe', 'club', 'distance', 'fishing', 'fist', 'magicLevel', 'shielding', 'sword'];
        skillKeys.forEach((s) => {
            const baseVal = parseInt(skills[s], 10) || 0;
            const bonusVal = skillBonuses[s] || 0;
            const totVal = baseVal + bonusVal;

            const baseEl = document.getElementById(`sk-base-${s}`);
            const bonusEl = document.getElementById(`sk-bonus-${s}`);
            const totEl = document.getElementById(`sk-tot-${s}`);

            if (baseEl) baseEl.textContent = baseVal;
            if (bonusEl) {
                bonusEl.textContent = bonusVal > 0 ? `+${bonusVal}` : '+0';
                bonusEl.className = bonusVal > 0 ? 'val-bonus' : 'text-muted';
            }
            if (totEl) {
                totEl.textContent = totVal;
                totEl.className = bonusVal > 0 ? 'val-total text-info' : 'val-total';
            }
        });

        // Render Combat Stats & Imbuements Table
        const stats = profile.stats || {};
        const setStat = (id, val, suffix) => {
            const el = document.getElementById(id);
            if (el) el.textContent = `${val != null ? val : 0}${suffix}`;
        };
        setStat('st-lifeLeech', stats.lifeLeech, '%');
        setStat('st-manaLeech', stats.manaLeech, '%');
        setStat('st-critChance', stats.critChance, '%');
        setStat('st-critDamage', stats.critDamage, '%');

        // Render Inventory Breakdown
        renderInventoryBreakdown(equippedList);
    }

    /**
     * Render detailed cards for equipped items below stats.
     */
    function renderInventoryBreakdown(equippedList) {
        if (!els.inventoryGrid) return;
        els.inventoryGrid.innerHTML = '';

        if (!equippedList || equippedList.length === 0) {
            els.inventoryGrid.innerHTML = '<div class="text-muted small p-2">No equipment items currently equipped.</div>';
            return;
        }

        equippedList.forEach(({ slotKey, item, count }) => {
            const card = document.createElement('div');
            card.className = 'item-card';

            const spriteUrl = resolveItemSpriteUrl(item);
            const countTag = (count && count > 1) ? ` x${count}` : '';

            let statsDesc = [];
            if (item.armor) statsDesc.push(`Arm: ${item.armor}`);
            if (item.min != null || item.max != null) {
                const lo = item.min != null ? Number(item.min) : Number(item.max);
                const hi = item.max != null ? Number(item.max) : Number(item.min);
                const span = lo === hi ? String(lo) : `${lo}–${hi}`;
                const el = item.element ? ` ${item.element}` : '';
                statsDesc.push(`Atk: ${span}${el}`);
            }
            if (item.atk) {
                const is2h = (item.twoHanded === true || item.twoHanded === 'true' || item.twoHanded === 1);
                statsDesc.push(`Atk: ${item.atk} (${is2h ? '2h' : '1h'})`);
            }
            if (item.manaGain != null && Number(item.manaGain) > 0) {
                statsDesc.push(`MP +${Math.floor(Number(item.manaGain))}`);
            }
            if (item.defense) statsDesc.push(`Def: ${item.defense}`);
            if (item.weight) statsDesc.push(`${(item.weight / 100).toFixed(1)} oz`);

            card.innerHTML = `
                <div class="item-card-icon">
                    <img src="${spriteUrl}" alt="${item.label || item.id}" onerror="this.style.display='none'">
                </div>
                <div class="item-card-info">
                    <div class="item-card-title">${item.label || item.id}${countTag}</div>
                    <div class="item-card-sub">
                        <span class="text-info">[${slotKey}]</span>
                        <span>${statsDesc.join(' | ') || 'No stats'}</span>
                    </div>
                </div>
            `;

            // Highlight slot on hover & open modal on click
            card.addEventListener('mouseenter', () => {
                const slotEl = els.equipmentCard ? els.equipmentCard.querySelector(`[data-slot="${slotKey}"]`) : null;
                if (slotEl) slotEl.classList.add('is-highlighted');
            });
            card.addEventListener('mouseleave', () => {
                const slotEl = els.equipmentCard ? els.equipmentCard.querySelector(`[data-slot="${slotKey}"]`) : null;
                if (slotEl) slotEl.classList.remove('is-highlighted');
            });
            card.addEventListener('click', () => {
                showEquipmentModal(item, slotKey);
            });

            els.inventoryGrid.appendChild(card);
        });
    }

    /**
     * Fetch profile entity fallback if not pushed via postMessage.
     */
    async function loadProfileFallback() {
        if (!profileId) return;
        try {
            await (catalogPromise || loadCatalogs());
            const res = await fetch(appUrl(`php/api.php?action=presets_get&mode=${encodeURIComponent(mode)}&kind=player_profiles&id=${encodeURIComponent(profileId)}`));
            if (res.ok) {
                const resJson = await res.json();
                const rootData = (resJson && resJson.data) ? resJson.data : resJson;
                const entity = (rootData && rootData.entity) ? rootData.entity : rootData;
                if (entity && (entity.id || entity.vocation)) {
                    renderProfile(entity);
                }
            }
        } catch (err) {
            console.warn('Failed fetching profile fallback:', err);
        }
    }

    /**
     * Post Message protocol for live syncing with Designer UI opener.
     */
    function setupMessaging() {
        window.addEventListener('message', async (ev) => {
            if (ev.origin !== window.location.origin) return;
            const data = ev.data;
            if (!data) return;

            if (data.type === 'PROFILE_PREVIEW_DATA') {
                const modeChanged = data.mode && data.mode !== mode;
                if (data.mode) mode = data.mode;
                if (data.live != null) liveMode = !!data.live;
                if (data.profile) {
                    currentProfile = data.profile;
                    if (data.profile.id) profileId = String(data.profile.id);
                }
                if (modeChanged || !catalogPromise) {
                    await loadCatalogs();
                } else {
                    await catalogPromise;
                }
                if (currentProfile) {
                    renderProfile(currentProfile);
                }
            }
        });

        // Post READY to opener so it sends the latest editor state
        if (window.opener && !window.opener.closed) {
            try {
                window.opener.postMessage({ type: 'PROFILE_PREVIEW_READY' }, window.location.origin);
            } catch (_) {}
        }
    }

    // Initialize
    document.addEventListener('DOMContentLoaded', async () => {
        setupMessaging();
        await loadCatalogs();

        if (currentProfile) {
            renderProfile(currentProfile);
        }

        if (els.refreshBtn) {
            els.refreshBtn.addEventListener('click', async () => {
                await loadCatalogs();
                if (currentProfile) renderProfile(currentProfile);
                else await loadProfileFallback();
            });
        }

        // Fallback load if no postMessage received within 300ms
        setTimeout(async () => {
            if (!currentProfile) {
                await loadProfileFallback();
            }
        }, 300);
    });
})();
