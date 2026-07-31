/**
 * Spell shape picker popup (Designer).
 * Catalog + matrix come from parent via postMessage init (kernel shapes.js).
 */
(function () {
    'use strict';

    const CHANNEL = 'hunt-design-lab-designer-picker';
    const KIND = 'shape';

    const parent = window.opener;
    if (!parent || parent.closed) {
        document.addEventListener('DOMContentLoaded', () => {
            document.body.innerHTML =
                '<div class="p-4 text-warning">Open this picker from the Designer page.</div>';
        });
        return;
    }

    /** @type {{ catalog?: Array<Record<string, unknown>>, current?: Record<string, unknown>|null, requestId?: string, fieldPath?: string }|null} */
    let init = null;
    /** @type {Array<Record<string, unknown>>} */
    let catalog = [];
    /** @type {Record<string, unknown>|null} */
    let selected = null;
    let filter = '';
    let typeFilter = '';

    function byId(id) {
        return document.getElementById(id);
    }

    function post(msg) {
        try {
            parent.postMessage({ channel: CHANNEL, kind: KIND, ...msg }, window.location.origin);
        } catch (err) {
            console.warn('shape picker postMessage failed', err);
        }
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function matches(entry) {
        if (typeFilter && String(entry.type || '') !== typeFilter) return false;
        if (!filter) return true;
        const q = filter.toLowerCase();
        const hay = [entry.id, entry.label, entry.type, JSON.stringify(entry.shape || {})]
            .join(' ')
            .toLowerCase();
        return hay.includes(q);
    }

    /**
     * @param {number[][]} matrix
     */
    function renderPreview(matrix) {
        const wrap = byId('spPreview');
        if (!wrap) return;
        if (!Array.isArray(matrix) || !matrix.length) {
            wrap.hidden = true;
            wrap.innerHTML = '';
            return;
        }
        const rows = matrix.length;
        const cols = Math.max(...matrix.map((r) => (Array.isArray(r) ? r.length : 0)), 1);
        wrap.style.gridTemplateColumns = `repeat(${cols}, 14px)`;
        wrap.innerHTML = '';
        for (let y = 0; y < rows; y++) {
            const row = Array.isArray(matrix[y]) ? matrix[y] : [];
            for (let x = 0; x < cols; x++) {
                const cell = document.createElement('div');
                const v = row[x] != null ? row[x] : 0;
                cell.className = 'sp-cell';
                if (v === 3) cell.classList.add('is-origin');
                else if (v === 1 || v === 2) cell.classList.add('is-hit');
                else cell.classList.add('is-empty');
                wrap.appendChild(cell);
            }
        }
        wrap.hidden = false;
    }

    function shapePayload(entry) {
        if (!entry || !entry.shape || typeof entry.shape !== 'object') return null;
        return JSON.parse(JSON.stringify(entry.shape));
    }

    function render() {
        const listEl = byId('spList');
        const selEl = byId('spSelection');
        const selectBtn = byId('spSelect');
        const labelEl = byId('spPreviewLabel');
        const jsonEl = byId('spJson');
        if (!listEl) return;

        const list = catalog.filter(matches);
        listEl.innerHTML = '';

        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'sp-empty';
            empty.textContent = catalog.length
                ? 'No shapes match this filter.'
                : 'Waiting for shape catalog from Designer…';
            listEl.appendChild(empty);
        } else {
            const frag = document.createDocumentFragment();
            for (const e of list) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className =
                    'sp-item' + (selected && selected.id === e.id ? ' is-selected' : '');
                btn.setAttribute('role', 'option');
                btn.setAttribute(
                    'aria-selected',
                    selected && selected.id === e.id ? 'true' : 'false'
                );
                const shape = e.shape || {};
                let meta = String(e.type || '');
                if (shape.code != null) meta += ` · code ${shape.code}`;
                if (shape.spread != null) meta += ` · spread ${shape.spread}`;
                if (shape.length != null) meta += ` · length ${shape.length}`;
                btn.innerHTML =
                    `<span>${escapeHtml(String(e.label || e.id))}</span>` +
                    `<span class="sp-item-meta">${escapeHtml(meta)}</span>`;
                btn.addEventListener('click', () => {
                    selected = e;
                    render();
                });
                btn.addEventListener('dblclick', () => {
                    selected = e;
                    confirmSelect();
                });
                frag.appendChild(btn);
            }
            listEl.appendChild(frag);
        }

        if (selected) {
            if (labelEl) labelEl.textContent = String(selected.label || selected.id);
            renderPreview(/** @type {number[][]} */ (selected.matrix || []));
            if (jsonEl) {
                jsonEl.textContent = JSON.stringify(shapePayload(selected), null, 2);
            }
            if (selEl) {
                selEl.innerHTML =
                    'Selected: <code>' + escapeHtml(String(selected.id)) + '</code>';
            }
        } else {
            if (labelEl) labelEl.textContent = 'Select a shape to preview';
            renderPreview([]);
            if (jsonEl) jsonEl.textContent = '';
            if (selEl) selEl.textContent = 'Nothing selected';
        }
        if (selectBtn) selectBtn.disabled = !selected;
    }

    function confirmSelect() {
        if (!selected) return;
        const shape = shapePayload(selected);
        if (!shape) return;
        post({
            type: 'select',
            requestId: init && init.requestId,
            fieldPath: init && init.fieldPath,
            value: { shape }
        });
        try {
            window.close();
        } catch (_) {
            /* ignore */
        }
    }

    /**
     * @param {Record<string, unknown>} payload
     */
    function applyInit(payload) {
        init = payload || {};
        catalog = Array.isArray(init.catalog) ? init.catalog : [];
        selected = null;
        const currentId = init.currentId != null ? String(init.currentId) : '';
        const current = init.current && typeof init.current === 'object' ? init.current : null;
        if (currentId) {
            selected = catalog.find((e) => String(e.id) === currentId) || null;
        }
        if (!selected && current) {
            // Match by shape fields
            selected =
                catalog.find((e) => {
                    const s = e.shape || {};
                    if (String(s.type) !== String(current.type || '')) return false;
                    if (s.type === 'area') {
                        return String(s.code) === String(current.code);
                    }
                    return (
                        String(s.spread) === String(current.spread) &&
                        String(s.length) === String(current.length)
                    );
                }) || null;
        }
        render();
    }

    window.addEventListener('message', (ev) => {
        if (ev.origin !== window.location.origin) return;
        const data = ev.data;
        if (!data || data.channel !== CHANNEL) return;
        if (data.type === 'init' && data.kind === KIND) {
            applyInit(data);
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        byId('spFilter')?.addEventListener('input', (ev) => {
            filter = String(/** @type {HTMLInputElement} */ (ev.target).value || '').trim();
            render();
        });
        byId('spTypeFilter')?.addEventListener('change', (ev) => {
            typeFilter = String(/** @type {HTMLSelectElement} */ (ev.target).value || '');
            render();
        });
        byId('spSelect')?.addEventListener('click', confirmSelect);
        byId('spCancel')?.addEventListener('click', () => {
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

        render();
        post({ type: 'ready', kind: KIND });
    });
})();
