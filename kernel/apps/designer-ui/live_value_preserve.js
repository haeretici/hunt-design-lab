/**
 * Reconcile json-editor getValue() with the last loaded entity.
 *
 * Hidden `options.dependencies` omit live keys from getValue(). Enum widgets
 * invent the first enum value when the key was absent. Tuple / array widgets
 * invent [0, 0] or []. Save must not change combat (creature attacks, equipment
 * slot/weaponType/heal, spell field/source).
 */

'use strict';

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlain(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * First-enum leftovers from before effect/shootEffect gained an empty default.
 * A form-only "31" / "158" is the select's old implicit value, not author intent.
 * @type {Set<string>}
 */
const INVENTED_ENUM_DEFAULTS = new Set(['31', '158']);

/**
 * Values json-editor invents for optional widgets that were not on disk.
 * Non-empty additions (user picked a real named enum / set range 7 / heal
 * [60, 90]) are kept. Empty arrays, [0, 0] tuples, and all-false objects are
 * treated as form chrome, not author intent.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isImplicitInvented(value) {
    if (value === '' || value === 0 || value === false || value === null) {
        return true;
    }
    if (typeof value === 'string' && INVENTED_ENUM_DEFAULTS.has(value)) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.length === 0 || value.every(isImplicitInvented);
    }
    if (isPlain(value)) {
        const keys = Object.keys(value);
        return keys.length === 0 || keys.every((k) => isImplicitInvented(value[k]));
    }
    return false;
}

/**
 * @param {unknown[]} loadedArr
 * @param {unknown} formItem
 * @param {number} index
 * @param {Set<number>} used
 * @returns {unknown}
 */
function findLoadedItem(loadedArr, formItem, index, used) {
    if (isPlain(formItem) && formItem.id != null && formItem.id !== '') {
        for (let i = 0; i < loadedArr.length; i++) {
            if (used.has(i)) continue;
            const cand = loadedArr[i];
            if (isPlain(cand) && cand.id === formItem.id) {
                used.add(i);
                return cand;
            }
        }
    }
    if (index < loadedArr.length && !used.has(index)) {
        const cand = loadedArr[index];
        if (
            isPlain(formItem) &&
            isPlain(cand) &&
            formItem.id &&
            cand.id &&
            formItem.id !== cand.id
        ) {
            return undefined;
        }
        used.add(index);
        return cand;
    }
    return undefined;
}

/**
 * @param {unknown} loaded last committed startval (disk or Raw→Form)
 * @param {unknown} form json-editor getValue() (or a nested piece)
 * @returns {unknown}
 */
function preserveLiveEntity(loaded, form) {
    if (form === undefined) {
        return loaded;
    }
    if (form === null || typeof form !== 'object') {
        return form;
    }
    if (Array.isArray(form)) {
        const src = Array.isArray(loaded) ? loaded : [];
        const used = new Set();
        return form.map((item, i) =>
            preserveLiveEntity(findLoadedItem(src, item, i, used), item)
        );
    }
    if (!isPlain(form)) return form;
    const orig = isPlain(loaded) ? loaded : null;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(form)) {
        if (
            orig &&
            !Object.prototype.hasOwnProperty.call(orig, k) &&
            isImplicitInvented(v)
        ) {
            continue;
        }
        out[k] = preserveLiveEntity(orig ? orig[k] : undefined, v);
    }
    if (orig) {
        for (const [k, v] of Object.entries(orig)) {
            if (!Object.prototype.hasOwnProperty.call(out, k)) {
                out[k] = v;
            }
        }
    }
    return out;
}

module.exports = {
    preserveLiveEntity
};
