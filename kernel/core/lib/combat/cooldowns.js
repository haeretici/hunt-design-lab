/**
 * Cooldown buckets for combat actions (Stage 4).
 *
 * Buckets (legacy parity):
 *   auto      — weapon auto swing only (legacy autoAttackTimer; not primary)
 *   primary   — shared spell/strike GCD (attack / healing / support)
 *   secondary — special channels (ultimates, focus, class specials)
 *   spell     — per-spell ids (key = spell id)
 *   item      — use / equip / open
 *
 * A spell may tag multiple buckets; **all** listed keys must be ready (≤ 0)
 * before the action fires; on success **all** listed keys are set to their
 * durations (seconds).
 *
 * Auto and primary are independent: melee_auto sets auto.attack; front_sweep
 * sets primary.attack + spell.front_sweep. Both may fire the same tick.
 *
 * Spec shape (from presets/spells.json `cooldowns`):
 *   {
 *     "auto":    { "attack": 2 },
 *     "primary": { "attack": 2 },
 *     "spell":   { "front_sweep": 6 }
 *   }
 */

const BUCKETS = ['auto', 'primary', 'secondary', 'spell', 'item'];

/** Buckets that ship with fixed keys in createCooldownState. */
const SEEDED_BUCKETS = { auto: true, primary: true, item: true };

/**
 * Empty cooldown state for a combatant.
 * @returns {{ auto: Object, primary: Object, secondary: Object, spell: Object, item: Object }}
 */
function createCooldownState() {
    return {
        auto: {
            attack: 0
        },
        primary: {
            attack: 0,
            healing: 0,
            support: 0
        },
        secondary: {},
        spell: {},
        item: {
            use: 0,
            equip: 0,
            open: 0
        }
    };
}

/**
 * Ensure entity.cooldowns exists with standard buckets.
 * @param {object} entity
 * @returns {object} entity.cooldowns
 */
function ensureCooldowns(entity) {
    if (!entity.cooldowns) {
        entity.cooldowns = createCooldownState();
    } else {
        const seed = createCooldownState();
        for (let i = 0; i < BUCKETS.length; i++) {
            const b = BUCKETS[i];
            if (!entity.cooldowns[b] || typeof entity.cooldowns[b] !== 'object') {
                entity.cooldowns[b] = SEEDED_BUCKETS[b] ? seed[b] : {};
            } else if (SEEDED_BUCKETS[b]) {
                // Backfill missing seeded keys (e.g. entities created before auto bucket)
                const keys = Object.keys(seed[b]);
                for (let k = 0; k < keys.length; k++) {
                    const key = keys[k];
                    if (entity.cooldowns[b][key] == null) {
                        entity.cooldowns[b][key] = 0;
                    }
                }
            }
        }
    }
    return entity.cooldowns;
}

/**
 * @param {object} entity
 * @param {string} bucket
 * @param {string} key
 * @returns {number} remaining seconds (0 if ready / missing)
 */
function getRemaining(entity, bucket, key) {
    const cds = entity && entity.cooldowns;
    if (!cds || !cds[bucket]) return 0;
    const v = cds[bucket][key];
    return v > 0 ? v : 0;
}

/**
 * Whether every key in the cooldown spec is ready (remaining ≤ 0).
 * Empty / missing spec → true.
 *
 * @param {object} entity
 * @param {object|null|undefined} spec
 * @returns {boolean}
 */
function canUse(entity, spec) {
    if (!spec || typeof spec !== 'object') return true;
    ensureCooldowns(entity);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        for (const key of Object.keys(keys)) {
            if (getRemaining(entity, bucket, key) > 0) return false;
        }
    }
    return true;
}

/**
 * Apply cooldown durations from a spell/action spec (overwrite remaining).
 * @param {object} entity
 * @param {object|null|undefined} spec
 */
function apply(entity, spec) {
    if (!spec || typeof spec !== 'object') return;
    const cds = ensureCooldowns(entity);
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const keys = spec[bucket];
        if (!keys || typeof keys !== 'object') continue;
        if (!cds[bucket]) cds[bucket] = {};
        for (const key of Object.keys(keys)) {
            const dur = Number(keys[key]) || 0;
            if (dur > 0) cds[bucket][key] = dur;
        }
    }
}

/**
 * Tick all known cooldown timers by dt seconds (floor at 0).
 * @param {object} entity
 * @param {number} dt
 */
function tick(entity, dt) {
    if (!entity || !entity.cooldowns) return;
    const step = Math.max(0, Number(dt) || 0);
    if (step === 0) return;
    const cds = entity.cooldowns;
    for (let i = 0; i < BUCKETS.length; i++) {
        const bucket = BUCKETS[i];
        const map = cds[bucket];
        if (!map) continue;
        for (const key of Object.keys(map)) {
            if (map[key] > 0) {
                map[key] = Math.max(0, map[key] - step);
            }
        }
    }
}

/**
 * Gate + apply helper. Returns false if any bucket not ready.
 * @param {object} entity
 * @param {object|null|undefined} spec
 * @returns {boolean}
 */
function tryUse(entity, spec) {
    if (!canUse(entity, spec)) return false;
    apply(entity, spec);
    return true;
}

module.exports = {
    BUCKETS,
    createCooldownState,
    ensureCooldowns,
    getRemaining,
    canUse,
    apply,
    tick,
    tryUse
};
