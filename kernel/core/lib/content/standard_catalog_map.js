/**
 * Map legacy class / spell catalogs → standard mode via CSV identity maps.
 *
 * CSVs live under other/ (commercial-safe standard_id / standard_label).
 * Standard output drops copy-fingerprint fields (legacyVocation, vocationMap, legacyName).
 *
 * @module content/standard_catalog_map
 */

'use strict';

const CLASS_FINGERPRINT_KEYS = ['legacyVocation', 'legacy_vocation', 'legacyName', 'legacyId'];
const SPELL_FINGERPRINT_KEYS = [
    'legacyName',
    'legacyId',
    'legacy_id',
    'legacy_label',
    'originalName',
    'sourceName'
];

/**
 * Parse a 4-column identity map CSV (header + rows).
 * Labels may contain commas — only the first three commas split fields; rest is last label.
 * @param {string} csvText
 * @param {[string,string,string,string]} columns e.g. ['legacy_id','legacy_label','standard_id','standard_label']
 * @returns {Array<Record<string,string>>}
 */
function parseFourColumnMapCsv(csvText, columns) {
    const cols = columns && columns.length === 4 ? columns : null;
    const lines = String(csvText || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter((ln) => ln.trim().length > 0);
    if (!lines.length) return [];

    let keys = cols;
    if (!keys) {
        const header = lines[0].split(',');
        keys = [header[0], header[1], header[2], header[3]].map((h) => String(h || '').trim());
    }

    const rows = [];
    const start = cols ? 1 : 1; // always skip header line
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        const c1 = line.indexOf(',');
        if (c1 < 0) continue;
        const c2 = line.indexOf(',', c1 + 1);
        if (c2 < 0) continue;
        const c3 = line.indexOf(',', c2 + 1);
        if (c3 < 0) continue;
        const row = {};
        row[keys[0]] = line.slice(0, c1).trim();
        row[keys[1]] = line.slice(c1 + 1, c2);
        row[keys[2]] = line.slice(c2 + 1, c3).trim();
        row[keys[3]] = line.slice(c3 + 1);
        rows.push(row);
    }
    return rows;
}

/**
 * @param {Array<Record<string,string>>} rows
 * @param {[string,string,string,string]} columns
 * @returns {string}
 */
function formatFourColumnMapCsv(rows, columns) {
    const cols = columns || ['legacy_id', 'legacy_label', 'standard_id', 'standard_label'];
    const lines = [cols.join(',')];
    for (let i = 0; i < (rows || []).length; i++) {
        const r = rows[i] || {};
        lines.push(
            [
                r[cols[0]] != null ? r[cols[0]] : '',
                r[cols[1]] != null ? r[cols[1]] : '',
                r[cols[2]] != null ? r[cols[2]] : '',
                r[cols[3]] != null ? r[cols[3]] : ''
            ].join(',')
        );
    }
    return lines.join('\n') + '\n';
}

const VOCATION_CSV_COLS = [
    'legacy_vocation',
    'legacy_label',
    'standard_id',
    'standard_label'
];
const SPELL_CSV_COLS = ['legacy_id', 'legacy_label', 'standard_id', 'standard_label'];

function parseVocationMapCsv(csvText) {
    return parseFourColumnMapCsv(csvText, VOCATION_CSV_COLS);
}

function formatVocationMapCsv(rows) {
    return formatFourColumnMapCsv(rows, VOCATION_CSV_COLS);
}

function parseSpellMapCsv(csvText) {
    return parseFourColumnMapCsv(csvText, SPELL_CSV_COLS);
}

function formatSpellMapCsv(rows) {
    return formatFourColumnMapCsv(rows, SPELL_CSV_COLS);
}

function stripKeys(obj, keys) {
    if (!obj || typeof obj !== 'object') return obj;
    for (let i = 0; i < keys.length; i++) {
        if (Object.prototype.hasOwnProperty.call(obj, keys[i])) delete obj[keys[i]];
    }
    return obj;
}

function ensureId(raw, fallback) {
    const s = String(raw != null && String(raw).trim() !== '' ? raw : fallback || 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    if (!s) return 'unknown';
    if (!/^[a-z]/.test(s)) return `c_${s}`.slice(0, 80);
    return s;
}

/**
 * Build legacy_vocation → row and standard_id → row indexes.
 * @param {Array<{legacy_vocation:string,legacy_label?:string,standard_id:string,standard_label?:string}>} mapRows
 */
function indexVocationMap(mapRows) {
    const byLegacy = new Map();
    const byStandard = new Map();
    if (!Array.isArray(mapRows)) return { byLegacy, byStandard };
    for (let i = 0; i < mapRows.length; i++) {
        const r = mapRows[i];
        if (!r) continue;
        if (r.legacy_vocation) byLegacy.set(String(r.legacy_vocation).toLowerCase(), r);
        if (r.standard_id) byStandard.set(String(r.standard_id).toLowerCase(), r);
    }
    return { byLegacy, byStandard };
}

/**
 * Map legacy classes.json document → standard classes (identity from vocation_map.csv).
 *
 * @param {object} legacyDoc
 * @param {Array<{legacy_vocation:string,legacy_label?:string,standard_id:string,standard_label?:string}>|null} mapRows
 * @param {{ spellIdMap?: Map<string,string> }} [opts] optional legacy spell id → standard spell id
 * @returns {{
 *   doc: object,
 *   mapRows: Array<{legacy_vocation:string,legacy_label:string,standard_id:string,standard_label:string}>,
 *   stats: { total:number, fromMap:number, generated:number }
 * }}
 */
function mapLegacyClassesToStandard(legacyDoc, mapRows, opts) {
    const classesIn =
        legacyDoc && Array.isArray(legacyDoc.classes) ? legacyDoc.classes : [];
    const { byLegacy, byStandard } = indexVocationMap(mapRows);
    const spellIdMap = opts && opts.spellIdMap instanceof Map ? opts.spellIdMap : null;

    const seen = new Set();
    const classes = [];
    const outMap = [];
    let fromMap = 0;
    let generated = 0;

    for (let i = 0; i < classesIn.length; i++) {
        const leg = classesIn[i];
        if (!leg || typeof leg !== 'object') continue;

        const legId = leg.id != null ? String(leg.id) : '';
        // Match CSV by legacyVocation, else by commercial id (after fingerprints stripped).
        let row =
            (leg.legacyVocation != null
                ? byLegacy.get(String(leg.legacyVocation).toLowerCase())
                : null) ||
            (legId ? byStandard.get(legId.toLowerCase()) : null) ||
            (legId ? byLegacy.get(legId.toLowerCase()) : null) ||
            null;

        const legVoc =
            row && row.legacy_vocation
                ? String(row.legacy_vocation)
                : leg.legacyVocation != null
                  ? String(leg.legacyVocation)
                  : legId;
        const packLabel = leg.label != null ? String(leg.label) : legId || legVoc;
        const legLabel =
            row && row.legacy_label != null && String(row.legacy_label).trim() !== ''
                ? String(row.legacy_label)
                : packLabel;

        let standardId;
        let standardLabel;
        let generatedRow = false;

        if (row && row.standard_id) {
            standardId = ensureId(row.standard_id, legId || legVoc);
            standardLabel =
                row.standard_label != null && String(row.standard_label).trim() !== ''
                    ? String(row.standard_label)
                    : packLabel;
            fromMap++;
        } else {
            generatedRow = true;
            generated++;
            standardId = ensureId(legId || legVoc, 'class');
            standardLabel = packLabel;
            row = {
                legacy_vocation: legVoc,
                legacy_label: legLabel,
                standard_id: standardId,
                standard_label: standardLabel
            };
        }

        if (seen.has(standardId)) {
            let n = 2;
            while (seen.has(`${standardId}_${n}`)) n++;
            standardId = `${standardId}_${n}`;
        }
        seen.add(standardId);

        const cls = Object.assign({}, leg, {
            id: standardId,
            label: standardLabel
        });
        stripKeys(cls, CLASS_FINGERPRINT_KEYS);

        // Remap spell book ids when a spell map is provided.
        if (Array.isArray(cls.spells) && spellIdMap) {
            cls.spells = cls.spells.map((sid) => {
                const key = sid != null ? String(sid) : '';
                return spellIdMap.has(key) ? spellIdMap.get(key) : sid;
            });
        }
        if (cls.autoAttack != null && spellIdMap) {
            const key = String(cls.autoAttack);
            if (spellIdMap.has(key)) cls.autoAttack = spellIdMap.get(key);
        }

        classes.push(cls);
        outMap.push({
            legacy_vocation: legVoc,
            legacy_label: legLabel,
            standard_id: standardId,
            standard_label: standardLabel
        });
    }

    const doc = {
        version: legacyDoc && legacyDoc.version != null ? legacyDoc.version : 2,
        notes:
            'Standard mode classes: combat fields from presets/legacy/classes.json; ' +
            'id and label from other/vocation_map.csv (commercial-safe). ' +
            'Spell ids reference presets/standard/spells.json.',
        classes
    };
    // Never carry vocationMap (lives only in CSV).
    return {
        doc,
        mapRows: outMap,
        stats: { total: classes.length, fromMap, generated }
    };
}

/**
 * Build legacy spell id → standard spell id map from CSV rows.
 * @param {Array<{legacy_id:string,standard_id:string}>} mapRows
 * @returns {Map<string,string>}
 */
function buildSpellIdMap(mapRows) {
    const m = new Map();
    if (!Array.isArray(mapRows)) return m;
    for (let i = 0; i < mapRows.length; i++) {
        const r = mapRows[i];
        if (!r || !r.legacy_id || !r.standard_id) continue;
        m.set(String(r.legacy_id), String(r.standard_id));
    }
    return m;
}

/**
 * Map legacy spells.json document → standard spells (identity from spell_map.csv).
 *
 * @param {object} legacyDoc
 * @param {Array<{legacy_id:string,legacy_label?:string,standard_id:string,standard_label?:string}>|null} mapRows
 * @param {{ vocationIdMap?: Map<string,string> }} [opts] optional legacy vocation → standard class id
 * @returns {{
 *   doc: object,
 *   mapRows: Array<{legacy_id:string,legacy_label:string,standard_id:string,standard_label:string}>,
 *   stats: { total:number, fromMap:number, generated:number }
 * }}
 */
function mapLegacySpellsToStandard(legacyDoc, mapRows, opts) {
    const spellsIn = legacyDoc && Array.isArray(legacyDoc.spells) ? legacyDoc.spells : [];
    const byLegacy = new Map();
    if (Array.isArray(mapRows)) {
        for (let i = 0; i < mapRows.length; i++) {
            const r = mapRows[i];
            if (r && r.legacy_id) byLegacy.set(String(r.legacy_id), r);
        }
    }
    const vocationIdMap =
        opts && opts.vocationIdMap instanceof Map ? opts.vocationIdMap : null;

    const seen = new Set();
    const spells = [];
    const outMap = [];
    let fromMap = 0;
    let generated = 0;

    for (let i = 0; i < spellsIn.length; i++) {
        const leg = spellsIn[i];
        if (!leg || typeof leg !== 'object') continue;

        const legId = leg.id != null ? String(leg.id) : 'unknown';
        // Prefer original legacy string from CSV (survives after JSON strip of legacyName).
        let row = byLegacy.get(legId) || null;
        const packLabel =
            leg.legacyName != null
                ? String(leg.legacyName)
                : leg.label != null
                  ? String(leg.label)
                  : legId;
        const legLabel =
            row && row.legacy_label != null && String(row.legacy_label).trim() !== ''
                ? String(row.legacy_label)
                : packLabel;

        let standardId;
        let standardLabel;
        let generatedRow = false;

        if (row && row.standard_id) {
            standardId = ensureId(row.standard_id, legId);
            standardLabel =
                row.standard_label != null && String(row.standard_label).trim() !== ''
                    ? String(row.standard_label)
                    : leg.label != null
                      ? String(leg.label)
                      : legId;
            fromMap++;
        } else {
            generatedRow = true;
            generated++;
            standardId = ensureId(legId, 'spell');
            standardLabel = leg.label != null ? String(leg.label) : legId;
            row = {
                legacy_id: legId,
                legacy_label: legLabel,
                standard_id: standardId,
                standard_label: standardLabel
            };
        }

        if (seen.has(standardId)) {
            let n = 2;
            while (seen.has(`${standardId}_${n}`)) n++;
            standardId = `${standardId}_${n}`;
        }
        seen.add(standardId);

        const spell = Object.assign({}, leg, {
            id: standardId,
            label: standardLabel
        });
        stripKeys(spell, SPELL_FINGERPRINT_KEYS);

        // Remap vocation allow-list to standard class ids when provided.
        if (Array.isArray(spell.vocations) && vocationIdMap) {
            spell.vocations = spell.vocations.map((v) => {
                const key = v != null ? String(v).toLowerCase() : '';
                if (vocationIdMap.has(key)) return vocationIdMap.get(key);
                // Already standard id (guardian, …) — leave as-is.
                return v;
            });
        }

        spells.push(spell);
        outMap.push({
            legacy_id: legId,
            legacy_label: legLabel,
            standard_id: standardId,
            standard_label: standardLabel
        });
    }

    const doc = {
        version: legacyDoc && legacyDoc.version != null ? legacyDoc.version : 2,
        notes:
            'Standard mode spell book: combat fields from presets/legacy/spells.json; ' +
            'id and label from other/spell_map.csv (commercial-safe). Schema: id, element, mana, ' +
            'range, powerCurve, basePower, cooldowns (auto/primary/secondary/spell/item), moveLock.',
        spells
    };

    return {
        doc,
        mapRows: outMap,
        stats: { total: spells.length, fromMap, generated }
    };
}

/**
 * Build legacy_vocation (or standard class id) → standard class id from vocation map rows.
 * Includes both legacy_vocation and standard_id keys so already-safe packs remap cleanly.
 * @param {Array<{legacy_vocation:string,standard_id:string}>} mapRows
 * @returns {Map<string,string>}
 */
function buildVocationIdMap(mapRows) {
    const m = new Map();
    if (!Array.isArray(mapRows)) return m;
    for (let i = 0; i < mapRows.length; i++) {
        const r = mapRows[i];
        if (!r || !r.standard_id) continue;
        const std = String(r.standard_id);
        if (r.legacy_vocation) m.set(String(r.legacy_vocation).toLowerCase(), std);
        m.set(std.toLowerCase(), std);
    }
    return m;
}

/**
 * Strip legacy fingerprint fields from a classes document in place (returns new doc shape).
 * Used to clean presets/legacy/classes.json so the map lives only in CSV.
 * @param {object} doc
 * @returns {object}
 */
function stripClassLegacyFields(doc) {
    const out = Object.assign({}, doc);
    delete out.vocationMap;
    if (Array.isArray(out.classes)) {
        out.classes = out.classes.map((c) => {
            if (!c || typeof c !== 'object') return c;
            const next = Object.assign({}, c);
            stripKeys(next, CLASS_FINGERPRINT_KEYS);
            return next;
        });
    }
    return out;
}

/**
 * Strip legacyName etc. from a spells document (for packs that should not carry fingerprints).
 * @param {object} doc
 * @returns {object}
 */
function stripSpellLegacyFields(doc) {
    const out = Object.assign({}, doc);
    if (Array.isArray(out.spells)) {
        out.spells = out.spells.map((s) => {
            if (!s || typeof s !== 'object') return s;
            const next = Object.assign({}, s);
            stripKeys(next, SPELL_FINGERPRINT_KEYS);
            return next;
        });
    }
    return out;
}

module.exports = {
    VOCATION_CSV_COLS,
    SPELL_CSV_COLS,
    parseFourColumnMapCsv,
    formatFourColumnMapCsv,
    parseVocationMapCsv,
    formatVocationMapCsv,
    parseSpellMapCsv,
    formatSpellMapCsv,
    mapLegacyClassesToStandard,
    mapLegacySpellsToStandard,
    buildSpellIdMap,
    buildVocationIdMap,
    stripClassLegacyFields,
    stripSpellLegacyFields
};
