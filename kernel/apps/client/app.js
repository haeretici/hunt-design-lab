'use strict';

const { initGameApp } = require('../game/app.js');
const {
    getContainer,
    getItem,
    equipmentMapFromInventory
} = require('../../core/lib/character/inventory.js');

const DB_NAME = 'HuntDLClientDB';
const DB_VERSION = 1;
const STORE_NAME = 'characters';

async function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (ev) => {
            const db = ev.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function getCharacters(db) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveCharacter(db, char) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(char);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

async function deleteCharacter(db, id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

const DEFAULT_CLIENT_SKILLS = Object.freeze({
    sword: 10,
    axe: 10,
    club: 10,
    fist: 10,
    distance: 10,
    shielding: 10,
    magicLevel: 0,
    fishing: 10
});

const VOCATION_PACKS = {
    warden: {
        equips: { weapon: 'frostbite_wand', shield: 'novice_spellbook' },
        inventory: [
            { id: 'meat', count: 1 },
            { id: 'mana_potion', count: 10 },
            { id: 'small_health_potion', count: 2 }
        ]
    },
    guardian: {
        equips: { weapon: 'dagger', shield: 'wooden_shield' },
        inventory: [
            { id: 'meat', count: 1 },
            { id: 'mana_potion', count: 2 },
            { id: 'small_health_potion', count: 10 }
        ]
    },
    mystic: {
        equips: { weapon: 'light_jo_staff' },
        inventory: [
            { id: 'meat', count: 1 },
            { id: 'mana_potion', count: 5 },
            { id: 'small_health_potion', count: 7 }
        ]
    },
    scout: {
        equips: { weapon: 'bow', shield: 'quiver', leftHand: 'quiver' },
        inventory: [
            { id: 'meat', count: 1 },
            { id: 'mana_potion', count: 5 },
            { id: 'small_health_potion', count: 7 }
        ],
        quiver: [
            { id: 'simple_arrow', itemId: 'simple_arrow', count: 100 }
        ]
    },
    adept: {
        equips: { weapon: 'scorcher_wand', shield: 'novice_spellbook' },
        inventory: [
            { id: 'meat', count: 1 },
            { id: 'mana_potion', count: 10 },
            { id: 'small_health_potion', count: 2 }
        ]
    }
};

const BASE_EQUIPS = {
    helmet: 'leather_helmet',
    armor: 'jacket',
    legs: 'leather_legs',
    boots: 'leather_boots',
    backpack: 'backpack'
};

function normalizeClientCharacter(char) {
    if (!char || typeof char !== 'object') return null;
    const vocation = char.vocation || 'guardian';
    const pack = VOCATION_PACKS[vocation] || VOCATION_PACKS.guardian;
    const level =
        char.level != null && Number.isFinite(Number(char.level))
            ? Math.max(1, Math.floor(Number(char.level)))
            : 1;
    const experience =
        char.experience != null && Number.isFinite(Number(char.experience))
            ? Math.max(0, Math.floor(Number(char.experience)))
            : 0;
    const skills = Object.assign({}, DEFAULT_CLIENT_SKILLS, char.skills || {});
    const equips = Object.assign({}, BASE_EQUIPS, pack.equips, char.equips || {});
    if (pack.equips.shield && !equips.shield && !equips.leftHand) {
        equips.shield = pack.equips.shield;
        equips.leftHand = pack.equips.leftHand || pack.equips.shield;
    }
    const cloneItem = (it) => (it && typeof it === 'object' ? Object.assign({}, it) : it);
    let inventory;
    if (Array.isArray(char.inventory) && char.inventory.length) {
        inventory = char.inventory.map(cloneItem);
    } else if (char.inventory && Array.isArray(char.inventory.backpack) && char.inventory.backpack.length) {
        inventory = char.inventory.backpack.map(cloneItem);
    } else {
        inventory = pack.inventory.map(cloneItem);
    }
    let quiver;
    if (Array.isArray(char.quiver)) {
        quiver = char.quiver.map(cloneItem);
    } else if (char.inventory && Array.isArray(char.inventory.shield)) {
        quiver = char.inventory.shield.map(cloneItem);
    } else if (char.inventory && Array.isArray(char.inventory.leftHand)) {
        quiver = char.inventory.leftHand.map(cloneItem);
    } else if (pack.quiver) {
        quiver = pack.quiver.map(cloneItem);
    } else {
        quiver = [];
    }

    // If migrating an earlier scout without char.quiver, avoid keeping arrows in backpack
    if (char.quiver === undefined && vocation === 'scout' && quiver.length > 0) {
        inventory = inventory.filter((item) => {
            const id = item && (item.id || item.itemId);
            return id !== 'simple_arrow';
        });
    }

    const spawnLoc = char.spawnLoc || 'firstlight_outpost';

    return Object.assign({}, char, {
        vocation,
        level,
        experience,
        skills,
        equips,
        inventory,
        quiver,
        spawnLoc
    });
}

function getEquipmentFromPlayer(player) {
    if (!player) return {};
    if (player.inventory) {
        return equipmentMapFromInventory(player.inventory, player._loadoutItemDb);
    }
    return Object.assign({}, player.equipment || {});
}

function getBackpackItemsFromPlayer(player) {
    if (!player || !player.inventory) return [];
    const inv = player.inventory;
    const root = getContainer(inv, inv.rootUid);
    if (!root || !Array.isArray(root.slots)) return [];
    const list = [];
    for (let i = 0; i < root.slots.length; i++) {
        const uid = root.slots[i];
        if (!uid) continue;
        const item = getItem(inv, uid);
        if (item && item.itemId) {
            list.push({
                id: item.itemId,
                itemId: item.itemId,
                count: item.count || 1
            });
        }
    }
    return list;
}

function getQuiverItemsFromPlayer(player) {
    if (!player || !player.inventory) return [];
    const inv = player.inventory;
    const leftUid = inv.equipment && (inv.equipment.leftHand || inv.equipment.shield);
    if (!leftUid) return [];
    const cont = getContainer(inv, leftUid);
    if (!cont || !Array.isArray(cont.slots)) return [];
    const list = [];
    for (let i = 0; i < cont.slots.length; i++) {
        const uid = cont.slots[i];
        if (!uid) continue;
        const item = getItem(inv, uid);
        if (item && item.itemId) {
            list.push({
                id: item.itemId,
                itemId: item.itemId,
                count: item.count || 1
            });
        }
    }
    return list;
}

async function initClientApp() {
    const root = document.getElementById('client-root');
    if (!root) return;

    const db = await initDB();
    let selectedCharacterId = null;
    let gameApi = null;

    try {
        gameApi = await initGameApp({ isClient: true, prefsKey: 'huntClient' });
    } catch (err) {
        console.error('Failed to pre-initialize game app in client:', err);
    }

    const persistActiveCharacter = async () => {
        if (!gameApi || typeof gameApi.getPlayer !== 'function' || !selectedCharacterId) return;
        const player = gameApi.getPlayer();
        if (!player) return;
        const chars = await getCharacters(db);
        const rawChar = chars.find((c) => c.id === selectedCharacterId);
        if (!rawChar) return;
        const char = normalizeClientCharacter(rawChar);

        char.level = Math.max(1, Math.floor(Number(player.level) || char.level || 1));
        if (player.experience != null && Number.isFinite(Number(player.experience))) {
            char.experience = Math.max(0, Math.floor(Number(player.experience)));
        }
        if (player.skills && typeof player.skills === 'object') {
            char.skills = Object.assign({}, char.skills, player.skills);
        }
        const eq = getEquipmentFromPlayer(player);
        if (Object.keys(eq).length > 0) {
            char.equips = eq;
        }
        const inv = getBackpackItemsFromPlayer(player);
        if (inv.length > 0) {
            char.inventory = inv;
        }
        if (player.inventory) {
            char.quiver = getQuiverItemsFromPlayer(player);
        }
        if (player.tile && player.tile.x != null && player.tile.y != null) {
            char.x = player.tile.x;
            char.y = player.tile.y;
            char.z = player.tile.z;
        }
        await saveCharacter(db, char);
    };

    // Autosave progress periodically
    setInterval(() => {
        persistActiveCharacter().catch(() => {});
    }, 10000);

    window.addEventListener('beforeunload', () => {
        persistActiveCharacter().catch(() => {});
    });

    const logOutBtn = document.getElementById('logOutBtn');
    if (logOutBtn) {
        logOutBtn.addEventListener('click', async () => {
            await persistActiveCharacter();
            if (gameApi && typeof gameApi.stopSession === 'function') {
                gameApi.stopSession();
            }
            const overlay = document.getElementById('client-ui-overlay');
            if (overlay) {
                overlay.style.display = '';
                overlay.classList.add('d-flex');
            }
            selectedCharacterId = null;
            await render();
        });
    }

    function renderCreateForm() {
        root.innerHTML = `
            <div class="text-center mb-4">
                <h2>Create Character</h2>
            </div>
            <div class="mb-3">
                <label class="form-label">Name</label>
                <input type="text" id="char-name" class="form-control" placeholder="Enter character name" autofocus>
            </div>
            <div class="mb-3">
                <label class="form-label">Vocation</label>
                <select id="char-voc" class="form-select">
                    <option value="guardian">Guardian</option>
                    <option value="mystic">Mystic</option>
                    <option value="warden">Warden</option>
                    <option value="scout">Scout</option>
                    <option value="adept">Adept</option>
                </select>
            </div>
            <div class="d-flex justify-content-between mt-4">
                <button id="btn-cancel" class="btn btn-secondary">Cancel</button>
                <button id="btn-create" class="btn btn-primary">Create</button>
            </div>
        `;

        document.getElementById('btn-cancel').addEventListener('click', () => {
            render();
        });

        document.getElementById('btn-create').addEventListener('click', async () => {
            const name = document.getElementById('char-name').value.trim();
            const voc = document.getElementById('char-voc').value;
            if (!name) {
                alert('Please enter a name.');
                return;
            }

            const pack = VOCATION_PACKS[voc] || VOCATION_PACKS.guardian;
            const newChar = {
                name,
                vocation: voc,
                level: 1,
                experience: 0,
                skills: Object.assign({}, DEFAULT_CLIENT_SKILLS),
                spawnLoc: 'firstlight_outpost',
                equips: Object.assign({}, BASE_EQUIPS, pack.equips),
                inventory: pack.inventory.map((it) => Object.assign({}, it)),
                quiver: pack.quiver ? pack.quiver.map((it) => Object.assign({}, it)) : [],
                createdAt: Date.now()
            };

            await saveCharacter(db, newChar);
            render();
        });
    }

    async function render() {
        const chars = await getCharacters(db);
        root.innerHTML = '';

        if (chars.length === 0) {
            renderCreateForm();
        } else {
            let html = `
                <div class="text-center mb-4">
                    <h2>Select Character</h2>
                </div>
                <div class="list-group mb-4">
            `;

            chars.forEach((c) => {
                const norm = normalizeClientCharacter(c);
                const isSelected = selectedCharacterId === c.id;
                html += `
                    <button type="button" class="list-group-item list-group-item-action char-item${isSelected ? ' active' : ''}" data-id="${c.id}">
                        <div class="d-flex w-100 justify-content-between">
                            <h5 class="mb-1">${norm.name}</h5>
                            <small>Lvl ${norm.level}</small>
                        </div>
                        <p class="mb-1 text-capitalize">${norm.vocation}</p>
                    </button>
                `;
            });

            html += `
                </div>
                <div class="d-flex justify-content-between">
                    <div>
                        <button id="btn-new-char" class="btn btn-outline-primary">Create New</button>
                        <button id="btn-remove-char" class="btn btn-danger ms-2"${selectedCharacterId ? '' : ' disabled'}>Remove</button>
                    </div>
                    <div>
                        <button id="btn-play" class="btn btn-success"${selectedCharacterId ? '' : ' disabled'}>Play</button>
                    </div>
                </div>
            `;
            root.innerHTML = html;

            document.getElementById('btn-new-char').addEventListener('click', () => {
                renderCreateForm();
            });

            const playBtn = document.getElementById('btn-play');
            const removeBtn = document.getElementById('btn-remove-char');

            removeBtn.addEventListener('click', async () => {
                if (selectedCharacterId) {
                    const char = chars.find((c) => c.id === selectedCharacterId);
                    if (char && confirm(`Are you sure you want to remove the character "${char.name}"?`)) {
                        await deleteCharacter(db, selectedCharacterId);
                        selectedCharacterId = null;
                        render();
                    }
                }
            });

            playBtn.addEventListener('click', async () => {
                try {
                    if (!selectedCharacterId) return;
                    const rawChar = chars.find((c) => c.id === selectedCharacterId);
                    if (!rawChar) return;
                    const char = normalizeClientCharacter(rawChar);
                    await saveCharacter(db, char);

                    // Hide char selection overlay
                    const overlay = document.getElementById('client-ui-overlay');
                    if (overlay) {
                        overlay.classList.remove('d-flex');
                        overlay.style.display = 'none';
                    }

                    // Enable live progression
                    try {
                        const lsKey = 'hdl_tweaks_progression';
                        let prog = JSON.parse(localStorage.getItem(lsKey) || '{}');
                        prog.liveExp = true;
                        prog.liveSkillTries = true;
                        localStorage.setItem(lsKey, JSON.stringify(prog));
                    } catch (e) {
                        console.error('Failed to set progression tweaks', e);
                    }

                    if (!gameApi) {
                        gameApi = await initGameApp({ isClient: true, prefsKey: 'huntClient' });
                    }
                    if (gameApi && gameApi.error) {
                        alert('Error initializing game: ' + gameApi.error);
                        return;
                    }

                    const memberInventory = {
                        backpack: Array.isArray(char.inventory) ? char.inventory : []
                    };
                    const quiverList = Array.isArray(char.quiver) ? char.quiver : [];
                    if (quiverList.length > 0) {
                        memberInventory.shield = quiverList;
                        memberInventory.leftHand = quiverList;
                    }

                    const singlePlayerMember = {
                        name: char.name,
                        classId: char.vocation,
                        level: Math.max(1, Math.floor(Number(char.level) || 1)),
                        experience: Math.max(0, Math.floor(Number(char.experience) || 0)),
                        isLeader: true,
                        controlMode: 'manual',
                        autoChase: false,
                        equipment: Object.assign({}, char.equips),
                        skills: Object.assign({}, DEFAULT_CLIENT_SKILLS, char.skills),
                        inventory: memberInventory,
                        backpack: Array.isArray(char.inventory) ? char.inventory : [],
                        shield: quiverList,
                        leftHand: quiverList,
                        enabled: true
                    };

                    const huntId = char.spawnLoc || 'firstlight_outpost';
                    const spawnPosition =
                        char.x != null && char.y != null
                            ? { x: char.x, y: char.y, z: char.z }
                            : null;

                    await gameApi.startSession({
                        members: [singlePlayerMember],
                        partyId: 'solo',
                        partyName: char.name,
                        huntId,
                        spawnPosition
                    });
                } catch (err) {
                    console.error(err);
                    alert('Error playing: ' + err.message);
                }
            });

            const items = root.querySelectorAll('.char-item');
            items.forEach((el) => {
                el.addEventListener('click', (ev) => {
                    items.forEach((i) => i.classList.remove('active'));
                    const target = ev.currentTarget;
                    target.classList.add('active');
                    selectedCharacterId = parseInt(target.dataset.id, 10);
                    playBtn.disabled = false;
                    removeBtn.disabled = false;
                });
            });
        }
    }

    await render();
}

module.exports = { initClientApp, VOCATION_PACKS, normalizeClientCharacter };
