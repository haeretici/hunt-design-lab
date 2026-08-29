/**
 * Wiki view-mode batch selection + Smart Update Sprites modal.
 * Shared by creature_picker and equipment_picker (uiMode=view only).
 *
 * Usage:
 *   const batch = DeSmartUpdate.createController({
 *     kind: 'creatures',           // or 'equipment' | 'spells'
 *     getMode: () => init.mode,
 *     getGenre: () => init.genre,
 *     getCategory: () => categoryFilter,  // equipment wiki filter → modal default
 *     isViewMode: () => uiMode === 'view',
 *     getItemMeta: (id) => ({ alias: label }),
 *     onPatched: (updated) => { ... },
 *     apiRoot: () => appRoot(),
 *     statusEl: () => document.getElementById('crMeta'), // header; picker footer is select-only
 *   });
 *   batch.bind();
 *   // in card/table HTML: batch.checkboxHtml(id)
 *   // on checkbox change: batch.setChecked(id, checked)
 */
(function (global) {
    'use strict';

    const IMAGE_MODELS = [
        'Gemini 3.7 Flash (Low)',
        'Gemini 3.7 Flash (Medium)',
        'Gemini 3.7 Flash (High)',
        'Gemini 3.1 Pro (Low)',
        'Gemini 3.1 Pro (High)',
        'Grok 4.6 (Low)',
        'Grok 4.6 (Medium)',
        'Grok 4.6 (High)'
    ];

    /**
     * Equipment subcategory ids for Smart Update backlog filter + job prompt.
     * Keep in sync with HDL_ASSET_CATEGORIES (equipment block) and
     * ASSET_KINDS.equipment.categories in kernel/settings.js.
     * Includes combat categories present in presets (ammo, quiver, …).
     */
    const EQUIPMENT_CATEGORIES = [
        'sword',
        'axe',
        'club',
        'mace',
        'dagger',
        'spear',
        'bow',
        'crossbow',
        'staff',
        'wand',
        'fist',
        'shield',
        'helmet',
        'armor',
        'legs',
        'boots',
        'ring',
        'amulet',
        'ammo',
        'quiver',
        'spellbook',
        'light',
        'container'
    ];

    const SLOT = 16;

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * @param {object} opts
     */
    function createController(opts) {
        const kind = opts.kind === 'equipment' ? 'equipment' : (opts.kind === 'spells' ? 'spells' : 'creatures');
        /** @type {Set<string>} */
        const selected = new Set();
        let modalEl = null;
        let bsModal = null;
        let running = false;

        function isViewMode() {
            return typeof opts.isViewMode === 'function'
                ? !!opts.isViewMode()
                : true;
        }

        function count() {
            return selected.size;
        }

        function isChecked(id) {
            return selected.has(String(id));
        }

        function setChecked(id, on) {
            const key = String(id);
            if (on) selected.add(key);
            else selected.delete(key);
            syncCheckboxDom(key);
            if (typeof opts.onSelectionChange === 'function') {
                opts.onSelectionChange(selected);
            }
        }

        function toggle(id) {
            setChecked(id, !isChecked(id));
        }

        function clear() {
            const ids = Array.from(selected);
            selected.clear();
            ids.forEach(syncCheckboxDom);
            if (typeof opts.onSelectionChange === 'function') {
                opts.onSelectionChange(selected);
            }
        }

        function syncCheckboxDom(id) {
            const on = isChecked(id);
            document
                .querySelectorAll(
                    `.de-batch-check[data-id="${CSS.escape(String(id))}"]`
                )
                .forEach((el) => {
                    if (el instanceof HTMLInputElement) {
                        el.checked = on;
                    }
                });
        }

        /**
         * Compact checkbox markup for cards/table (view mode only in CSS).
         * @param {string} id
         */
        function checkboxHtml(id) {
            const checked = isChecked(id) ? ' checked' : '';
            return (
                `<label class="de-batch-check-wrap" title="Select for batch actions" ` +
                `onclick="event.stopPropagation()">` +
                `<input type="checkbox" class="form-check-input de-batch-check" ` +
                `data-id="${escapeHtml(id)}"${checked}></label>`
            );
        }

        function apiUrl() {
            const root =
                typeof opts.apiRoot === 'function' ? opts.apiRoot() : '/';
            return new URL('php/api.php', window.location.origin + root).href;
        }

        async function apiPost(action, body) {
            const url = new URL(apiUrl());
            url.searchParams.set('action', action);
            const res = await fetch(url.href, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
                cache: 'no-store'
            });
            const data = await res.json();
            if (!res.ok || data.ok === false) {
                throw new Error((data && data.error) || `API ${action} failed`);
            }
            return data;
        }

        function ensureModal() {
            if (modalEl) return modalEl;
            const el = document.createElement('div');
            el.className = 'modal fade';
            el.id = 'deSmartUpdateModal';
            el.tabIndex = -1;
            el.setAttribute('aria-hidden', 'true');
            el.innerHTML = `
<div class="modal-dialog modal-dialog-centered">
  <div class="modal-content bg-dark text-light border-secondary">
    <div class="modal-header border-secondary">
      <h5 class="modal-title"><i class="fa-solid fa-wand-magic-sparkles me-2"></i>Smart Update Sprites</h5>
      <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
    </div>
    <div class="modal-body">
      <p class="small text-secondary mb-3" id="deSuSummary">—</p>
      <div class="row g-2">
        <div class="col-6">
          <label class="form-label small text-secondary mb-1">Genre</label>
          <input type="text" class="form-control form-control-sm" id="deSuGenre" readonly>
        </div>
        <div class="col-6">
          <label class="form-label small text-secondary mb-1">Asset Kind</label>
          <input type="text" class="form-control form-control-sm" id="deSuKind" readonly>
        </div>
        <div class="col-6" id="deSuCategoryWrap">
          <label class="form-label small text-secondary mb-1">Category</label>
          <select class="form-select form-select-sm" id="deSuCategory">
            <option value="">(none)</option>
          </select>
        </div>
        <div class="col-3">
          <label class="form-label small text-secondary mb-1">Rows</label>
          <input type="number" class="form-control form-control-sm" id="deSuRows" value="4" readonly>
        </div>
        <div class="col-3">
          <label class="form-label small text-secondary mb-1">Cols</label>
          <input type="number" class="form-control form-control-sm" id="deSuCols" value="4" readonly>
        </div>
        <div class="col-6">
          <label class="form-label small text-secondary mb-1">Seed</label>
          <input type="number" class="form-control form-control-sm" id="deSuSeed" min="0" step="1" placeholder="optional">
        </div>
        <div class="col-6">
          <label class="form-label small text-secondary mb-1">Iters</label>
          <input type="number" class="form-control form-control-sm" id="deSuIters" value="1" readonly>
        </div>
        <div class="col-12">
          <label class="form-label small text-secondary mb-1">Image Model</label>
          <select class="form-select form-select-sm" id="deSuModel"></select>
        </div>
      </div>
      <p class="small text-secondary mt-3 mb-0" id="deSuHint">
        Each sheet is 4×4 (16 cells). Short sheets fill from library entities whose
        dedicated sprite ≠ id (level low→high). Empty selection runs one sheet from that backlog.
        More than 16 runs multiple sheets.
      </p>
      <div class="small text-danger mt-2" id="deSuError" hidden></div>
    </div>
    <div class="modal-footer border-secondary">
      <button type="button" class="btn btn-sm btn-outline-secondary" data-bs-dismiss="modal" id="deSuCancel">Cancel</button>
      <button type="button" class="btn btn-sm btn-primary" id="deSuRun">
        <i class="fa-solid fa-play me-1"></i>Save and Run batch
      </button>
    </div>
  </div>
</div>`;
            document.body.appendChild(el);

            const modelSel = el.querySelector('#deSuModel');
            if (modelSel) {
                modelSel.innerHTML = IMAGE_MODELS.map(
                    (m) =>
                        `<option value="${escapeHtml(m)}"${
                            m === 'Gemini 3.7 Flash (High)' ? ' selected' : ''
                        }>${escapeHtml(m)}</option>`
                ).join('');
            }
            const catSel = el.querySelector('#deSuCategory');
            if (catSel) {
                catSel.innerHTML =
                    '<option value="">(none)</option>' +
                    EQUIPMENT_CATEGORIES.map(
                        (c) =>
                            `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`
                    ).join('');
            }

            const runBtn = el.querySelector('#deSuRun');
            if (runBtn) {
                runBtn.addEventListener('click', () => {
                    submitRun().catch((err) => {
                        showError(err.message || String(err));
                    });
                });
            }

            modalEl = el;
            return el;
        }

        function showError(msg) {
            const errEl = document.getElementById('deSuError');
            if (!errEl) return;
            if (!msg) {
                errEl.hidden = true;
                errEl.textContent = '';
                return;
            }
            errEl.hidden = false;
            errEl.textContent = msg;
        }

        function openModal() {
            if (!isViewMode()) return;
            const el = ensureModal();
            const genre =
                typeof opts.getGenre === 'function'
                    ? String(opts.getGenre() || 'rpg_fantasy')
                    : 'rpg_fantasy';
            const n = selected.size;
            let fillNote;
            const spriteField =
                kind === 'spells' ? 'customUISprite' : 'customSprite';
            if (n === 0) {
                fillNote =
                    `no selection · will fill up to 16 from library backlog (${spriteField} ≠ id)`;
            } else if (n % SLOT === 0) {
                fillNote = `${Math.ceil(n / SLOT)} full sheet(s)`;
            } else {
                const fill = SLOT - (n % SLOT);
                fillNote =
                    `${Math.ceil(n / SLOT)} sheet(s); last sheet fills ${fill} slot(s) ` +
                    `from library backlog (${spriteField} ≠ id, level low→high)`;
            }

            const genreEl = el.querySelector('#deSuGenre');
            const kindEl = el.querySelector('#deSuKind');
            const summaryEl = el.querySelector('#deSuSummary');
            const catWrap = el.querySelector('#deSuCategoryWrap');
            const hintEl = el.querySelector('#deSuHint');
            if (genreEl instanceof HTMLInputElement) genreEl.value = genre;
            // Pipeline asset kind: spells wiki generates UI icons (kind=ui).
            if (kindEl instanceof HTMLInputElement) {
                kindEl.value = kind === 'spells' ? 'ui' : kind;
            }
            if (hintEl) {
                hintEl.textContent =
                    kind === 'spells'
                        ? 'Each sheet is 4×4 (16 cells). Short sheets fill from library spells whose customUISprite ≠ id (requiredLevel low→high). Empty selection runs one sheet from that backlog. Art is written to the ui catalog (category spells).'
                        : 'Each sheet is 4×4 (16 cells). Short sheets fill from library entities whose customSprite ≠ id (level low→high). Empty selection runs one sheet from that backlog. More than 16 runs multiple sheets.';
            }
            if (summaryEl) {
                summaryEl.textContent = `${n} selected · ${fillNote}`;
            }
            if (catWrap) {
                catWrap.style.display = kind === 'equipment' ? '' : 'none';
            }
            // Prefill category from the wiki filter when it is a known option.
            const catEl = el.querySelector('#deSuCategory');
            if (kind === 'equipment' && catEl instanceof HTMLSelectElement) {
                let pref = '';
                if (typeof opts.getCategory === 'function') {
                    pref = String(opts.getCategory() || '')
                        .trim()
                        .toLowerCase();
                }
                const known = Array.from(catEl.options).some(
                    (o) => o.value === pref
                );
                catEl.value = known ? pref : '';
            }
            showError('');

            if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
                bsModal = bootstrap.Modal.getOrCreateInstance(el);
                bsModal.show();
            } else {
                el.classList.add('show');
                el.style.display = 'block';
                el.removeAttribute('aria-hidden');
            }
        }

        function closeModal() {
            if (bsModal) {
                bsModal.hide();
            } else if (modalEl) {
                modalEl.classList.remove('show');
                modalEl.style.display = 'none';
            }
        }

        function setStatus(msg) {
            const el =
                typeof opts.statusEl === 'function' ? opts.statusEl() : null;
            if (el) el.textContent = msg;
        }

        async function submitRun() {
            if (running) return;
            showError('');
            const n = selected.size;

            const genreEl = document.getElementById('deSuGenre');
            const seedEl = document.getElementById('deSuSeed');
            const modelEl = document.getElementById('deSuModel');
            const catEl = document.getElementById('deSuCategory');
            const genre =
                genreEl instanceof HTMLInputElement
                    ? genreEl.value.trim()
                    : 'rpg_fantasy';
            const model =
                modelEl instanceof HTMLSelectElement
                    ? modelEl.value
                    : IMAGE_MODELS[2];
            let seed = null;
            if (seedEl instanceof HTMLInputElement && seedEl.value.trim() !== '') {
                const s = parseInt(seedEl.value, 10);
                if (isNaN(s) || s < 0) {
                    showError('Seed must be a non-negative integer.');
                    return;
                }
                seed = s;
            }
            let category = null;
            if (
                kind === 'equipment' &&
                catEl instanceof HTMLSelectElement &&
                catEl.value
            ) {
                category = catEl.value;
            }

            const mode =
                typeof opts.getMode === 'function'
                    ? String(opts.getMode() || 'standard')
                    : 'standard';

            /** @type {Array<{id: string, alias: string}>} */
            const items = [];
            selected.forEach((id) => {
                let alias = id;
                if (typeof opts.getItemMeta === 'function') {
                    const meta = opts.getItemMeta(id) || {};
                    if (meta.alias) alias = String(meta.alias);
                    else if (meta.label) alias = String(meta.label);
                }
                items.push({ id, alias });
            });

            const runBtn = document.getElementById('deSuRun');
            running = true;
            if (runBtn) runBtn.disabled = true;
            const sheetHint =
                n === 0 ? 1 : Math.ceil(n / SLOT);
            setStatus(
                n === 0
                    ? 'Filling backlog + queueing smart update…'
                    : `Saving customSprite + queueing ~${sheetHint} batch(es)…`
            );

            try {
                /** @type {Record<string, unknown>} */
                const body = {
                    mode,
                    kind,
                    genre,
                    model,
                    items
                };
                if (seed != null) body.seed = seed;
                if (category) body.category = category;

                const data = await apiPost('smart_update_sprites', body);
                const updated = (data && data.updated) || [];
                const job = data && data.job;
                const backlogFilled =
                    data && typeof data.backlog_filled === 'number'
                        ? data.backlog_filled
                        : 0;
                const selectedN =
                    data && typeof data.selected === 'number'
                        ? data.selected
                        : n;
                if (typeof opts.onPatched === 'function') {
                    opts.onPatched(updated, data);
                }
                clear();
                closeModal();
                const jobId = job && job.id ? String(job.id) : null;
                const detail =
                    backlogFilled > 0
                        ? `${selectedN} selected + ${backlogFilled} backlog`
                        : `${updated.length} item(s)`;
                setStatus(
                    jobId
                        ? `Smart Update: ${detail} linked · job ${jobId.slice(0, 8)}…`
                        : `Smart Update: ${detail} linked`
                );
            } catch (e) {
                showError(e.message || String(e));
                setStatus('Smart Update failed: ' + (e.message || e));
                throw e;
            } finally {
                running = false;
                if (runBtn) runBtn.disabled = false;
            }
        }

        /**
         * Wire Actions dropdown + delegated checkbox clicks.
         * Call once after DOM ready.
         */
        function bind() {
            const actionBtn = document.getElementById('deActionSmartSprites');
            if (actionBtn) {
                actionBtn.addEventListener('click', (ev) => {
                    ev.preventDefault();
                    openModal();
                });
            }

            // Delegated checkbox changes (grid + table redraws).
            document.addEventListener('change', (ev) => {
                const t = ev.target;
                if (!(t instanceof HTMLInputElement)) return;
                if (!t.classList.contains('de-batch-check')) return;
                if (!isViewMode()) return;
                const id = t.getAttribute('data-id');
                if (!id) return;
                setChecked(id, t.checked);
            });

            // Bubble phase: let the checkbox toggle, but do not bubble to card/row select.
            document.addEventListener('click', (ev) => {
                const t = ev.target;
                if (!(t instanceof Element)) return;
                if (t.closest('.de-batch-check-wrap')) {
                    ev.stopPropagation();
                }
            });
        }

        return {
            selected,
            count,
            isChecked,
            setChecked,
            toggle,
            clear,
            checkboxHtml,
            openModal,
            bind,
            SLOT
        };
    }

    global.DeSmartUpdate = {
        IMAGE_MODELS,
        EQUIPMENT_CATEGORIES,
        createController,
        SLOT
    };
})(typeof window !== 'undefined' ? window : globalThis);
