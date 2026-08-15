/**
 * Catalog asset picker popup (Designer relation field).
 * Lists genre assets via catalog_list (kind=tiles|creatures|equipment|objects|overlays);
 * posts select back to opener. Prefers alpha (or init.previewVariant) for thumbs.
 *
 * Message kind is always `catalog` (parent openCatalogAssetPicker).
 */
(function () {
    'use strict';

    const CHANNEL = 'hunt-design-lab-designer-picker';
    const KIND = 'catalog';

    const parent = window.opener;
    if (!parent || parent.closed) {
        document.addEventListener('DOMContentLoaded', () => {
            document.body.innerHTML =
                '<div class="p-4 text-warning">Open this picker from the Designer page.</div>';
        });
        return;
    }

    /**
     * @type {{
     *   genre?: string,
     *   assetKind?: string,
     *   currentId?: string,
     *   category?: string,
     *   previewVariant?: string,
     *   showCategoryFilter?: boolean|string,
     *   categories?: string[]|string,
     *   fieldPath?: string,
     *   title?: string,
     *   requestId?: string
     * }|null}
     */
    let init = null;
    /** @type {Array<Record<string, unknown>>} */
    let items = [];
    /** @type {Record<string, unknown>|null} */
    let selected = null;
    let filter = '';
    let category = '';
    let slotFilter = '';
    let minLevel = null;
    let maxLevel = null;
    let sortBy = 'mtime';

    function byId(id) {
        return document.getElementById(id);
    }

    function post(msg) {
        try {
            parent.postMessage({ channel: CHANNEL, kind: KIND, ...msg }, window.location.origin);
        } catch (err) {
            console.warn('catalog picker postMessage failed', err);
        }
    }

    /**
     * Resolve app root for API / assets (page is under html/widgets/…).
     * @returns {string}
     */
    function appRoot() {
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

    function apiUrl() {
        return new URL('php/api.php', appRoot()).href;
    }

    function assetUrl(rel) {
        const clean = String(rel || '').replace(/^\/+/, '');
        return new URL(clean, appRoot()).href;
    }

    /**
     * @param {string} action
     * @param {Record<string, unknown>} params
     */
    async function apiCall(action, params) {
        const url = new URL(apiUrl());
        url.searchParams.set('action', action);
        for (const [k, v] of Object.entries(params || {})) {
            if (v === undefined || v === null || v === '') continue;
            url.searchParams.set(k, String(v));
        }
        const res = await fetch(url.href, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok || data.ok === false) {
            throw new Error((data && data.error) || `API ${action} failed`);
        }
        return data;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function assetKind() {
        return (init && init.assetKind) || 'tiles';
    }

    function previewVariant() {
        return (init && init.previewVariant) || 'alpha';
    }

    /**
     * Prefer configured variant (alpha), then other processed sizes, then original.
     * @param {Record<string, unknown>} item
     * @returns {string|null}
     */
    function previewPath(item) {
        const s = /** @type {Record<string, string>} */ (item.sprites || {});
        const preferred = previewVariant();
        const order = [preferred, 'alpha', 'medium', 'small', 'icon', 'original', 'transformed'];
        const seen = Object.create(null);
        for (let i = 0; i < order.length; i++) {
            const key = order[i];
            if (!key || seen[key]) continue;
            seen[key] = true;
            if (s[key]) return s[key];
        }
        // legacy GIF bag
        if (s.legacy) return s.legacy;
        return null;
    }

    function kindLabel() {
        const k = assetKind();
        if (k === 'tiles') return 'tile';
        if (k === 'creatures') return 'creature sprite';
        if (k === 'equipment') return 'equipment';
        if (k === 'objects') return 'object';
        if (k === 'overlays') return 'overlay';
        return k;
    }

    /**
     * Category options for the current catalog family.
     * @param {string} kind
     * @returns {string[]}
     */
    function defaultCategories(kind) {
        if (kind === 'objects') {
            return [
                'tree',
                'rock',
                'house',
                'wall',
                'door',
                'furniture',
                'container',
                'deco'
            ];
        }
        if (kind === 'tiles') {
            return ['floor', 'path', 'wall', 'water', 'special'];
        }
        if (kind === 'overlays') {
            return ['dirt', 'water', 'cobble'];
        }
        return [];
    }

    /**
     * @param {unknown} raw
     * @returns {string[]}
     */
    function parseCategories(raw) {
        if (Array.isArray(raw)) {
            return raw.map((c) => String(c).trim()).filter(Boolean);
        }
        if (raw == null || raw === '') return [];
        return String(raw)
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
    }

    /**
     * Rebuild the category <select> for tiles vs objects.
     * @param {string} kind
     * @param {string} selected
     * @param {string[]} [list]
     */
    function fillCategorySelect(kind, selected, list) {
        const catEl = byId('tpCategory');
        if (!catEl) return;
        const cats = list && list.length ? list : defaultCategories(kind);
        const cur = String(selected || '');
        catEl.innerHTML = '';
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'All categories';
        catEl.appendChild(all);
        for (let i = 0; i < cats.length; i++) {
            const opt = document.createElement('option');
            opt.value = cats[i];
            opt.textContent = cats[i];
            catEl.appendChild(opt);
        }
        if (cur && cats.indexOf(cur) >= 0) {
            catEl.value = cur;
        } else {
            catEl.value = '';
        }
    }

    function matchesSlot(item) {
        if (!slotFilter) return true;
        const target = slotFilter.toLowerCase();
        const s = String(item.slot || '').toLowerCase();
        const c = String(item.category || '').toLowerCase();

        if (target === 'head' || target === 'helmet') {
            return s === 'helmet' || s === 'head' || c === 'helmet' || c === 'head';
        }
        if (target === 'chest' || target === 'armor' || target === 'body') {
            return s === 'armor' || s === 'chest' || s === 'body' || c === 'armor' || c === 'chest' || c === 'body';
        }
        if (target === 'legs') {
            return s === 'legs' || c === 'legs';
        }
        if (target === 'boots' || target === 'feet') {
            return s === 'boots' || s === 'feet' || c === 'boots' || c === 'feet';
        }
        if (target === 'righthand' || target === 'weapon') {
            return s === 'righthand' || s === 'weapon' || ['sword', 'axe', 'club', 'mace', 'dagger', 'spear', 'bow', 'crossbow', 'staff', 'wand'].includes(c);
        }
        if (target === 'lefthand' || target === 'shield') {
            // Ammo nests inside quiver containers — not equipped in leftHand
            return (
                s === 'lefthand' ||
                s === 'shield' ||
                c === 'shield' ||
                c === 'quiver'
            );
        }
        if (target === 'amulet' || target === 'neck') {
            return s === 'amulet' || s === 'neck' || c === 'amulet' || c === 'neck';
        }
        if (target === 'ring') {
            return s === 'ring' || c === 'ring';
        }
        if (target === 'backpack' || target === 'container') {
            return s === 'backpack' || s === 'container' || c === 'backpack' || c === 'container';
        }
        return s === target || c === target;
    }

    function matchesLevel(item) {
        const lvl = Number(item.level) || 1;
        if (minLevel !== null && !isNaN(minLevel) && lvl < minLevel) return false;
        if (maxLevel !== null && !isNaN(maxLevel) && lvl > maxLevel) return false;
        return true;
    }

    function matchesFilter(item) {
        if (category && String(item.category || '') !== category) return false;
        if (!filter) return true;
        const q = filter.toLowerCase();
        const hay = [
            item.id,
            item.alias,
            item.technical,
            item.category,
            ...(Array.isArray(item.tags) ? item.tags : [])
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
        return hay.includes(q);
    }

    function updateChrome() {
        const titleEl = byId('tpTitle');
        if (titleEl) {
            const custom = init && init.title ? String(init.title) : '';
            titleEl.textContent = custom || `Select ${kindLabel()}`;
        }

        const catEl = byId('tpCategory');
        const kind = assetKind();
        const showCat =
            init &&
            (init.showCategoryFilter === true ||
                init.showCategoryFilter === '1' ||
                (init.showCategoryFilter == null &&
                    (kind === 'tiles' ||
                        kind === 'objects' ||
                        kind === 'overlays')));
        if (catEl) {
            catEl.hidden = !showCat;
            if (!showCat) catEl.value = '';
        }
    }

    function render() {
        const grid = byId('tpGrid');
        const empty = byId('tpEmpty');
        const meta = byId('tpMeta');
        const selEl = byId('tpSelection');
        const selectBtn = byId('tpSelect');
        if (!grid) return;

        let list = items.filter(matchesFilter);

        if (meta) {
            const genre = (init && init.genre) || '—';
            meta.textContent = `${list.length} shown · ${assetKind()} · genre ${genre}`;
        }

        grid.innerHTML = '';
        if (!list.length) {
            if (empty) {
                empty.hidden = false;
                empty.textContent = `No ${kindLabel()}s match this filter.`;
            }
        } else if (empty) {
            empty.hidden = true;
        }

        const frag = document.createDocumentFragment();
        for (const t of list) {
            const card = document.createElement('div');
            card.className =
                'tp-card' + (selected && selected.id === t.id ? ' is-selected' : '');
            card.dataset.id = String(t.id);
            card.setAttribute('role', 'button');
            card.tabIndex = 0;
            card.title = String(t.technical || t.id);

            const thumb = document.createElement('div');
            thumb.className = 'tp-thumb';
            const path = previewPath(t);
            if (path) {
                const img = document.createElement('img');
                img.src = assetUrl(String(path));
                img.alt = String(t.alias || t.technical || t.id);
                img.loading = 'lazy';
                img.decoding = 'async';
                img.addEventListener('error', () => {
                    thumb.innerHTML = '<span class="missing">no img</span>';
                });
                thumb.appendChild(img);
            } else {
                thumb.innerHTML = '<span class="missing">no img</span>';
            }

            const name = document.createElement('div');
            name.className = 'tp-name';
            name.textContent = String(t.alias || t.technical || t.id);

            const idEl = document.createElement('div');
            idEl.className = 'tp-id';
            idEl.textContent = String(t.id);

            card.appendChild(thumb);
            card.appendChild(name);
            card.appendChild(idEl);

            const pick = () => {
                selected = t;
                render();
            };
            card.addEventListener('click', pick);
            card.addEventListener('dblclick', () => {
                selected = t;
                confirmSelect();
            });
            card.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    pick();
                }
            });
            frag.appendChild(card);
        }
        grid.appendChild(frag);

        if (selEl) {
            selEl.innerHTML = selected
                ? `Selected: <code>${escapeHtml(String(selected.id))}</code>`
                : 'Nothing selected';
        }
        if (selectBtn) selectBtn.disabled = !selected;
    }

    /**
     * Map slot key to human readable label & icon
     */
    function formatSlotInfo(slotKey) {
        const key = String(slotKey || '').toLowerCase();
        const map = {
            head: { label: 'Head / Helmet', icon: 'fa-solid fa-helmet-safety' },
            helmet: { label: 'Head / Helmet', icon: 'fa-solid fa-helmet-safety' },
            chest: { label: 'Chest / Armor', icon: 'fa-solid fa-shirt' },
            armor: { label: 'Chest / Armor', icon: 'fa-solid fa-shirt' },
            body: { label: 'Chest / Armor', icon: 'fa-solid fa-shirt' },
            legs: { label: 'Legs', icon: 'fa-solid fa-socks' },
            boots: { label: 'Boots / Feet', icon: 'fa-solid fa-shoe-prints' },
            feet: { label: 'Boots / Feet', icon: 'fa-solid fa-shoe-prints' },
            righthand: { label: 'Right Hand (Weapon)', icon: 'fa-solid fa-hand-fist' },
            weapon: { label: 'Right Hand (Weapon)', icon: 'fa-solid fa-hand-fist' },
            lefthand: { label: 'Left Hand (Shield)', icon: 'fa-solid fa-shield' },
            shield: { label: 'Left Hand (Shield)', icon: 'fa-solid fa-shield' },
            amulet: { label: 'Amulet / Neck', icon: 'fa-solid fa-gem' },
            neck: { label: 'Amulet / Neck', icon: 'fa-solid fa-gem' },
            ring: { label: 'Ring', icon: 'fa-solid fa-ring' },
            backpack: { label: 'Backpack / Container', icon: 'fa-solid fa-bag-shopping' },
            container: { label: 'Backpack / Container', icon: 'fa-solid fa-bag-shopping' }
        };
        return map[key] || { label: slotKey || '—', icon: 'fa-solid fa-box' };
    }

    /**
     * Capitalize and format raw property names nicely.
     */
    function formatPropLabel(prop) {
        const p = String(prop || '').trim();
        const map = {
            magicLevel: 'Magic Level',
            magic: 'Magic Level',
            distance: 'Distance Skill',
            shielding: 'Shielding',
            sword: 'Sword Skill',
            axe: 'Axe Skill',
            club: 'Club Skill',
            fist: 'Fist Fighting',
            melee: 'Melee Skill',
            hp: 'Max HP',
            mana: 'Max Mana',
            hpMax: 'Max HP',
            manaMax: 'Max Mana',
            hpRegen: 'HP Regen',
            manaRegen: 'Mana Regen',
            speed: 'Movement Speed',
            physical: 'Physical',
            fire: 'Fire',
            ice: 'Ice',
            energy: 'Energy',
            earth: 'Earth',
            holy: 'Holy',
            death: 'Death',
            drown: 'Drown',
            poison: 'Poison',
            lifedrain: 'Life Drain',
            manadrain: 'Mana Drain'
        };
        if (map[p]) return map[p];
        return p
            .replace(/([A-Z])/g, ' $1')
            .replace(/_/g, ' ')
            .replace(/^\w/, (c) => c.toUpperCase())
            .trim();
    }

    /**
     * Helper to create a single stat key-value row
     */
    function createStatRow(iconClass, label, value, valColorClass) {
        const row = document.createElement('div');
        row.className = 'tp-stat-row';

        const lbl = document.createElement('div');
        lbl.className = 'tp-stat-label';
        lbl.innerHTML = `<i class="${iconClass}"></i> <span>${escapeHtml(label)}</span>`;

        const val = document.createElement('div');
        val.className = `tp-stat-val ${valColorClass || ''}`;
        val.textContent = String(value);

        row.appendChild(lbl);
        row.appendChild(val);
        return row;
    }

    /**
     * Render stats sidebar for the currently selected item.
     * @param {Record<string, any>|null} item
     */
    function renderSidebar(item) {
        const emptyEl = byId('tpSidebarEmpty');
        const contentEl = byId('tpSidebarContent');
        if (!emptyEl || !contentEl) return;

        if (!item) {
            emptyEl.hidden = false;
            contentEl.hidden = true;
            contentEl.innerHTML = '';
            return;
        }

        emptyEl.hidden = true;
        contentEl.hidden = false;
        contentEl.innerHTML = '';

        const frag = document.createDocumentFragment();

        // Track displayed keys to render any unhandled custom properties
        const handledKeys = new Set([
            'id', 'alias', 'label', 'technical', 'genre', 'kind', 'sprites',
            'status', 'source', 'createdAt', 'updatedAt', 'opaqueAlpha',
            'level', 'slot', 'category', 'weaponType', 'vocation', 'twoHanded',
            'range', 'imbuementSlots', 'atk', 'extraAtk', 'extraAtkElement',
            'defense', 'defenseBonus', 'armor', 'speed', 'weight', 'skillBonuses',
            'skills', 'bonuses', 'resists', 'resistances', 'elementalReduction',
            'tags', 'notes', 'description'
        ]);

        // 1. Header (Thumbnail, Title, ID, Quick Badges)
        const header = document.createElement('div');
        header.className = 'tp-detail-header';

        const thumb = document.createElement('div');
        thumb.className = 'tp-detail-thumb';
        const imgPath = previewPath(item);
        if (imgPath) {
            const img = document.createElement('img');
            img.src = assetUrl(String(imgPath));
            img.alt = String(item.alias || item.technical || item.id);
            img.addEventListener('error', () => {
                thumb.innerHTML = '<span class="missing">no img</span>';
            });
            thumb.appendChild(img);
        } else {
            thumb.innerHTML = '<span class="missing">no img</span>';
        }

        const title = document.createElement('h2');
        title.className = 'tp-detail-title';
        title.textContent = String(item.alias || item.label || item.technical || item.id);

        const idBadge = document.createElement('div');
        idBadge.className = 'tp-detail-id';
        idBadge.textContent = String(item.id);

        header.appendChild(thumb);
        header.appendChild(title);
        header.appendChild(idBadge);

        // Quick badges row (2-Handed, Imbuement Slots)
        const quickBadges = document.createElement('div');
        quickBadges.className = 'tp-pills-wrap mt-1 justify-content-center';

        if (item.twoHanded === true || item.twoHanded === 'true' || item.twoHanded === 1) {
            const pill = document.createElement('span');
            pill.className = 'tp-pill';
            pill.style.borderColor = 'rgba(210, 168, 255, 0.4)';
            pill.style.color = '#d2a8ff';
            pill.innerHTML = '<i class="fa-solid fa-hands"></i> 2-Handed (2h)';
            quickBadges.appendChild(pill);
        } else if (item.category === 'weapon' || item.weaponType || item.atk != null || item.slot === 'weapon') {
            const pill = document.createElement('span');
            pill.className = 'tp-pill';
            pill.style.borderColor = 'rgba(168, 210, 255, 0.4)';
            pill.style.color = '#a8d2ff';
            pill.innerHTML = '<i class="fa-solid fa-hand"></i> 1-Handed (1h)';
            quickBadges.appendChild(pill);
        }
        if (item.imbuementSlots != null && Number(item.imbuementSlots) > 0) {
            const pill = document.createElement('span');
            pill.className = 'tp-pill';
            pill.style.borderColor = 'rgba(123, 200, 255, 0.4)';
            pill.style.color = '#7bc8ff';
            pill.innerHTML = `<i class="fa-solid fa-gem"></i> ${item.imbuementSlots} Imbuement Slots`;
            quickBadges.appendChild(pill);
        }

        if (quickBadges.children.length > 0) {
            header.appendChild(quickBadges);
        }

        frag.appendChild(header);

        // 2. Equipment / Item Stats Section
        const statsSec = document.createElement('div');
        statsSec.className = 'tp-detail-section';

        const statsTitle = document.createElement('div');
        statsTitle.className = 'tp-detail-section-title';
        const isEq = assetKind() === 'equipment' || item.atk != null || item.armor != null || item.defense != null || item.slot;
        statsTitle.innerHTML = `<i class="fa-solid fa-chart-simple"></i> ${isEq ? 'Combat & General Stats' : 'Item Info'}`;
        statsSec.appendChild(statsTitle);

        const statList = document.createElement('div');
        statList.className = 'tp-stat-list';

        // Required Level
        const lvl = item.level != null ? item.level : 1;
        statList.appendChild(createStatRow('fa-solid fa-graduation-cap', 'Required Level', `Lvl ${lvl}`, 'tp-val-lvl'));

        // Slot
        if (item.slot) {
            const slotInfo = formatSlotInfo(item.slot);
            statList.appendChild(createStatRow(slotInfo.icon, 'Slot', slotInfo.label, 'tp-val-slot'));
        }

        // Category / Weapon Type
        if (item.category) {
            let catStr = String(item.category);
            if (item.weaponType) {
                catStr += ` (${item.weaponType})`;
            }
            statList.appendChild(createStatRow('fa-solid fa-layer-group', 'Category', catStr, 'tp-val-cat'));
        }

        // Vocation / Allowed Classes
        if (item.vocation != null) {
            const vocStr = Array.isArray(item.vocation)
                ? item.vocation.join(', ')
                : String(item.vocation);
            if (vocStr) {
                statList.appendChild(createStatRow('fa-solid fa-user-shield', 'Vocation', vocStr, 'tp-val-cat'));
            }
        }

        // Attack Range
        if (item.range != null && Number(item.range) > 0) {
            statList.appendChild(createStatRow('fa-solid fa-crosshair', 'Range', `${item.range} tiles`, 'tp-val-cat'));
        }

        // Physical Attack
        if (item.atk != null && item.atk !== 0) {
            statList.appendChild(createStatRow('fa-solid fa-burst', 'Attack (Physical)', `+${item.atk}`, 'tp-val-atk'));
        }

        // Extra Elemental Attack
        if (item.extraAtk != null || item.extraAtkElement != null) {
            const valNum = Number(item.extraAtk) || 0;
            const elemStr = item.extraAtkElement ? formatPropLabel(item.extraAtkElement) : '';
            let extraVal = '';
            if (valNum > 0 && elemStr) {
                extraVal = `+${valNum} (${elemStr})`;
            } else if (valNum > 0) {
                extraVal = `+${valNum}`;
            } else if (elemStr) {
                extraVal = elemStr;
            }
            if (extraVal) {
                statList.appendChild(createStatRow('fa-solid fa-fire', 'Elemental Attack', extraVal, 'tp-val-extra-atk'));
            }
        }

        // Armor
        if (item.armor != null && item.armor !== 0) {
            statList.appendChild(createStatRow('fa-solid fa-shield-halved', 'Armor', `+${item.armor}`, 'tp-val-arm'));
        }

        // Defense & Defense Bonus
        if ((item.defense != null && item.defense !== 0) || (item.defenseBonus != null && item.defenseBonus !== 0)) {
            const defBase = Number(item.defense) || 0;
            const defBonus = Number(item.defenseBonus) || 0;
            let defStr = String(defBase);
            if (defBonus > 0) {
                defStr += ` (+${defBonus} bonus)`;
            } else if (defBonus < 0) {
                defStr += ` (${defBonus} bonus)`;
            }
            statList.appendChild(createStatRow('fa-solid fa-shield', 'Defense', defStr, 'tp-val-def'));
        }

        // Speed
        if (item.speed != null && item.speed !== 0) {
            const speedVal = Number(item.speed);
            const speedStr = speedVal >= 0 ? `+${speedVal}` : `${speedVal}`;
            statList.appendChild(createStatRow('fa-solid fa-bolt', 'Speed', speedStr, 'tp-val-speed'));
        }

        // Weight
        if (item.weight != null) {
            const weightOz = Math.round(Number(item.weight) / 100);
            statList.appendChild(createStatRow('fa-solid fa-weight-hanging', 'Weight', `${weightOz} oz (${item.weight} g)`, 'tp-val-wgt'));
        }

        statsSec.appendChild(statList);
        frag.appendChild(statsSec);

        // 3. Skill Bonuses Section
        const bonusesObj = item.skillBonuses || item.skills || item.bonuses;
        if (bonusesObj && typeof bonusesObj === 'object' && Object.keys(bonusesObj).length > 0) {
            const bonusSec = document.createElement('div');
            bonusSec.className = 'tp-detail-section';

            const bonusTitle = document.createElement('div');
            bonusTitle.className = 'tp-detail-section-title';
            bonusTitle.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Skill & Stat Bonuses';
            bonusSec.appendChild(bonusTitle);

            const pillsWrap = document.createElement('div');
            pillsWrap.className = 'tp-pills-wrap';
            for (const [k, val] of Object.entries(bonusesObj)) {
                if (val == null || val === 0) continue;
                const pill = document.createElement('span');
                pill.className = 'tp-pill tp-pill-bonus';
                const sign = Number(val) >= 0 ? '+' : '';
                pill.textContent = `${formatPropLabel(k)}: ${sign}${val}`;
                pillsWrap.appendChild(pill);
            }
            if (pillsWrap.children.length > 0) {
                bonusSec.appendChild(pillsWrap);
                frag.appendChild(bonusSec);
            }
        }

        // 4. Elemental Resists / Reductions Section
        const resistsObj = item.resists || item.resistances || item.elementalReduction;
        if (resistsObj && typeof resistsObj === 'object' && Object.keys(resistsObj).length > 0) {
            const resistSec = document.createElement('div');
            resistSec.className = 'tp-detail-section';

            const resistTitle = document.createElement('div');
            resistTitle.className = 'tp-detail-section-title';
            resistTitle.innerHTML = '<i class="fa-solid fa-shield-virus"></i> Elemental Resists & Reductions';
            resistSec.appendChild(resistTitle);

            const pillsWrap = document.createElement('div');
            pillsWrap.className = 'tp-pills-wrap';
            for (const [k, val] of Object.entries(resistsObj)) {
                if (val == null || val === 0) continue;
                const pct = Number(val);
                const pill = document.createElement('span');
                if (pct > 0) {
                    pill.className = 'tp-pill tp-pill-resist';
                    pill.textContent = `${formatPropLabel(k)}: +${pct}% protection`;
                } else {
                    pill.className = 'tp-pill';
                    pill.style.borderColor = 'rgba(255, 123, 114, 0.4)';
                    pill.style.color = '#ff7b72';
                    pill.style.background = 'rgba(255, 123, 114, 0.12)';
                    pill.textContent = `${formatPropLabel(k)}: ${pct}% (vulnerability)`;
                }
                pillsWrap.appendChild(pill);
            }
            if (pillsWrap.children.length > 0) {
                resistSec.appendChild(pillsWrap);
                frag.appendChild(resistSec);
            }
        }

        // 5. Tags
        if (Array.isArray(item.tags) && item.tags.length > 0) {
            const tagSec = document.createElement('div');
            tagSec.className = 'tp-detail-section';

            const tagTitle = document.createElement('div');
            tagTitle.className = 'tp-detail-section-title';
            tagTitle.innerHTML = '<i class="fa-solid fa-tags"></i> Tags';
            tagSec.appendChild(tagTitle);

            const pillsWrap = document.createElement('div');
            pillsWrap.className = 'tp-pills-wrap';
            for (const tag of item.tags) {
                const pill = document.createElement('span');
                pill.className = 'tp-pill';
                pill.textContent = String(tag);
                pillsWrap.appendChild(pill);
            }
            tagSec.appendChild(pillsWrap);
            frag.appendChild(tagSec);
        }

        // 6. Custom / Flexible Additional Attributes
        const customRows = [];
        for (const [k, v] of Object.entries(item)) {
            if (handledKeys.has(k) || v == null || v === '') continue;
            if (typeof v === 'object') continue;
            customRows.push({ key: k, value: String(v) });
        }
        if (customRows.length > 0) {
            const customSec = document.createElement('div');
            customSec.className = 'tp-detail-section';

            const customTitle = document.createElement('div');
            customTitle.className = 'tp-detail-section-title';
            customTitle.innerHTML = '<i class="fa-solid fa-sliders"></i> Additional Properties';
            customSec.appendChild(customTitle);

            const customList = document.createElement('div');
            customList.className = 'tp-stat-list';
            for (const row of customRows) {
                customList.appendChild(createStatRow('fa-solid fa-circle-info', formatPropLabel(row.key), row.value));
            }
            customSec.appendChild(customList);
            frag.appendChild(customSec);
        }

        // 7. Notes / Description
        const noteText = item.notes || item.description;
        if (noteText) {
            const noteSec = document.createElement('div');
            noteSec.className = 'tp-detail-section';

            const noteTitle = document.createElement('div');
            noteTitle.className = 'tp-detail-section-title';
            noteTitle.innerHTML = '<i class="fa-solid fa-note-sticky"></i> Description & Notes';
            noteSec.appendChild(noteTitle);

            const noteBox = document.createElement('div');
            noteBox.className = 'tp-stat-row text-muted';
            noteBox.style.fontSize = '0.78rem';
            noteBox.style.lineHeight = '1.35';
            noteBox.textContent = String(noteText);

            noteSec.appendChild(noteBox);
            frag.appendChild(noteSec);
        }

        contentEl.appendChild(frag);
    }

    function confirmSelect() {
        if (!selected) return;
        post({
            type: 'select',
            requestId: init && init.requestId,
            fieldPath: init && init.fieldPath,
            value: {
                id: String(selected.id),
                label: String(selected.alias || selected.technical || selected.id),
                category: selected.category != null ? String(selected.category) : undefined,
                assetKind: assetKind()
            }
        });
        try {
            window.close();
        } catch (_) {
            /* ignore */
        }
    }

    async function loadItems() {
        const genre = (init && init.genre) || 'rpg_fantasy';
        const kind = assetKind();
        // Omit limit → return full genre catalog for this kind.
        const data = await apiCall('catalog_list', {
            genre,
            kind
        });
        items = Array.isArray(data.creatures) ? data.creatures : [];
        const currentId = init && init.currentId ? String(init.currentId) : '';
        if (currentId) {
            selected = items.find((t) => String(t.id) === currentId) || null;
        }
        render();
    }

    function applyInit(payload) {
        init = payload || {};
        // Back-compat: older parents sent kind:"tile" without assetKind
        if (!init.assetKind && init.kind === 'tiles') init.assetKind = 'tiles';
        if (!init.assetKind) init.assetKind = 'tiles';

        category = init.category ? String(init.category) : '';
        fillCategorySelect(
            assetKind(),
            category,
            parseCategories(init.categories)
        );
        const catEl = byId('tpCategory');
        if (catEl) category = String(catEl.value || '');

        if (init.slotFilter) {
            slotFilter = String(init.slotFilter);
            const slotEl = byId('tpSlot');
            if (slotEl) slotEl.value = slotFilter;
        }

        updateChrome();
        loadItems().catch((err) => {
            const empty = byId('tpEmpty');
            if (empty) {
                empty.hidden = false;
                empty.textContent =
                    'Failed to load catalog: ' + (err.message || err);
            }
        });
    }

    window.addEventListener('message', (ev) => {
        if (ev.origin !== window.location.origin) return;
        const data = ev.data;
        if (!data || data.channel !== CHANNEL) return;
        // Accept init for catalog (current) and legacy tile kind.
        if (
            data.type === 'init' &&
            (data.kind === KIND || data.kind === 'tile')
        ) {
            applyInit(data);
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        byId('tpFilter')?.addEventListener('input', (ev) => {
            filter = String(/** @type {HTMLInputElement} */ (ev.target).value || '').trim();
            render();
        });
        byId('tpCategory')?.addEventListener('change', (ev) => {
            category = String(/** @type {HTMLSelectElement} */ (ev.target).value || '');
            render();
        });
        byId('tpSlot')?.addEventListener('change', (ev) => {
            slotFilter = String(/** @type {HTMLSelectElement} */ (ev.target).value || '');
            render();
        });
        byId('tpMinLevel')?.addEventListener('input', (ev) => {
            const val = /** @type {HTMLInputElement} */ (ev.target).value;
            minLevel = val !== '' ? Number(val) : null;
            render();
        });
        byId('tpMaxLevel')?.addEventListener('input', (ev) => {
            const val = /** @type {HTMLInputElement} */ (ev.target).value;
            maxLevel = val !== '' ? Number(val) : null;
            render();
        });
        byId('tpSort')?.addEventListener('change', (ev) => {
            sortBy = String(/** @type {HTMLSelectElement} */ (ev.target).value || 'mtime');
            render();
        });
        byId('tpSelect')?.addEventListener('click', confirmSelect);
        byId('tpCancel')?.addEventListener('click', () => {
            post({ type: 'cancel', requestId: init && init.requestId });
            try {
                window.close();
            } catch (_) {
                /* ignore */
            }
        });
        window.addEventListener('beforeunload', () => {
            post({ type: 'closing', requestId: init && init.requestId });
        });

        // Query-string fallbacks (if parent cannot postMessage in time)
        try {
            const q = new URLSearchParams(window.location.search);
            if (q.get('genre') || q.get('id') || q.get('kind') || q.get('requestId')) {
                applyInit({
                    genre: q.get('genre') || 'rpg_fantasy',
                    assetKind: q.get('kind') || 'tiles',
                    currentId: q.get('id') || '',
                    category: q.get('category') || '',
                    slotFilter: q.get('slotFilter') || '',
                    previewVariant: q.get('previewVariant') || 'alpha',
                    showCategoryFilter: q.get('showCategoryFilter') || '',
                    categories: q.get('categories') || '',
                    fieldPath: q.get('fieldPath') || '',
                    title: q.get('title') || '',
                    requestId: q.get('requestId') || ''
                });
            }
        } catch (_) {
            /* ignore */
        }

        post({ type: 'ready', kind: KIND });
    });
})();
