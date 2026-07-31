import json
import csv
import difflib

legacy_file = 'presets/legacy/equipment.json'
standard_file = 'presets/standard/equipment.json'

with open(legacy_file, 'r', encoding='utf-8') as f:
    legacy_data = json.load(f)

with open(standard_file, 'r', encoding='utf-8') as f:
    standard_data = json.load(f)

legacy_items = legacy_data.get('items', [])
standard_items = standard_data.get('items', [])

s_items_by_id = {item['id']: item for item in standard_items}
l_items_by_id = {item['id']: item for item in legacy_items}

common_ids = set(s_items_by_id.keys()) & set(l_items_by_id.keys())

unmapped_l = [item for item in legacy_items if item['id'] not in common_ids]
unmapped_s = [item for item in standard_items if item['id'] not in common_ids]

def get_signature(item):
    keys = ['category', 'weight', 'atk', 'defense', 'armor', 'level', 'slot', 'weaponType', 'twoHanded', 'extraAtk']
    return tuple(item.get(k) for k in keys)

map_l2s = {}
for id_ in common_ids:
    map_l2s[id_] = id_

# Match remaining items using signature + string similarity
s_remaining = list(unmapped_s)

unresolved_l = []

for l_item in unmapped_l:
    l_sig = get_signature(l_item)
    # candidates are standard items with the same signature
    candidates = [s for s in s_remaining if get_signature(s) == l_sig]
    
    if len(candidates) == 1:
        s_item = candidates[0]
        map_l2s[l_item['id']] = s_item['id']
        s_remaining.remove(s_item)
    elif len(candidates) > 1:
        # Resolve by string similarity on ID
        best_match = max(candidates, key=lambda s: difflib.SequenceMatcher(None, l_item['id'], s['id']).ratio())
        map_l2s[l_item['id']] = best_match['id']
        s_remaining.remove(best_match)
    else:
        unresolved_l.append(l_item)

if len(unresolved_l) == 1 and len(s_remaining) == 1:
    l_item = unresolved_l.pop()
    s_item = s_remaining.pop()
    map_l2s[l_item['id']] = s_item['id']
    print(f"Forced match: {l_item['id']} -> {s_item['id']}")
elif unresolved_l:
    print(f"Failed to match {len(unresolved_l)} items.")
    for item in unresolved_l:
        print("Unresolved legacy:", item['id'])
    exit(1)

if s_remaining:
    print(f"Standard items remaining: {len(s_remaining)}")
    for item in s_remaining:
        print("Unresolved standard:", item['id'])
    exit(1)

print("Successfully mapped all items!")

csv_file = 'equipment_map.csv'
with open(csv_file, 'w', newline='', encoding='utf-8') as f:
    writer = csv.writer(f)
    writer.writerow(['legacy_id', 'legacy_label', 'standard_id', 'standard_label'])
    for l_item in legacy_items:
        l_id = l_item['id']
        s_id = map_l2s[l_id]
        l_label = l_item.get('label', '')
        s_label = s_items_by_id[s_id].get('label', '')
        writer.writerow([l_id, l_label, s_id, s_label])

print(f"Saved CSV map to {csv_file}")

map_s2l = {v: k for k, v in map_l2s.items()}

new_standard_items = []
for s_item in standard_items:
    s_id = s_item['id']
    l_id = map_s2l[s_id]
    l_item = l_items_by_id[l_id]
    
    new_item = {}
    for k, v in l_item.items():
        if k == 'id':
            new_item['id'] = s_item['id']
        elif k == 'label':
            new_item['label'] = s_item['label']
        else:
            new_item[k] = v
            
    if 'id' not in new_item and 'id' in s_item:
        new_item['id'] = s_item['id']
    if 'label' not in new_item and 'label' in s_item:
        new_item['label'] = s_item['label']
        
    new_standard_items.append(new_item)

standard_data['items'] = new_standard_items
with open(standard_file, 'w', encoding='utf-8') as f:
    json.dump(standard_data, f, indent=4)
    
print(f"Updated {standard_file}")
