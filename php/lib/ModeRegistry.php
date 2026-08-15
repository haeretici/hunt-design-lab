<?php
/**
 * Content mode registry — reads presets/<mode>/mode.json from disk.
 * Keeps PHP hunt/scenario allow-lists aligned with mode packages.
 */

declare(strict_types=1);

/**
 * Absolute path to presets root.
 */
function hdl_presets_root(): string
{
    return HDL_ROOT . '/presets';
}

/**
 * Sanitize mode id (folder name).
 */
function hdl_sanitize_mode_id(string $id): string
{
    $s = strtolower(trim($id));
    $s = preg_replace('/[^a-z0-9_-]/', '', $s) ?? '';
    if ($s === '') {
        throw new InvalidArgumentException('Empty mode id');
    }
    return $s;
}

/**
 * Load and normalize one mode.json.
 *
 * @return array<string, mixed>
 */
function hdl_load_mode(string $modeId): array
{
    $id = hdl_sanitize_mode_id($modeId);
    $path = hdl_presets_root() . '/' . $id . '/mode.json';
    if (!is_file($path)) {
        throw new RuntimeException('Unknown content mode: ' . $id);
    }
    $raw = file_get_contents($path);
    if ($raw === false) {
        throw new RuntimeException('Cannot read mode.json for ' . $id);
    }
    /** @var mixed $data */
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        throw new RuntimeException('Invalid mode.json for ' . $id);
    }

    $browser = is_array($data['browser'] ?? null) ? $data['browser'] : [];
    $list = static function ($v): array {
        if (!is_array($v)) {
            return [];
        }
        $out = [];
        foreach ($v as $item) {
            if (is_string($item) && $item !== '') {
                $out[] = $item;
            }
        }
        return $out;
    };

    return [
        'id' => is_string($data['id'] ?? null) ? $data['id'] : $id,
        'label' => is_string($data['label'] ?? null) ? $data['label'] : $id,
        'isDefault' => !empty($data['isDefault']),
        'genre' => is_string($data['genre'] ?? null) ? $data['genre'] : 'rpg_fantasy',
        'browser' => [
            'hunts' => $list($browser['hunts'] ?? []),
            'populations' => $list($browser['populations'] ?? []),
            'creatures' => $list($browser['creatures'] ?? []),
            'dialogs' => $list($browser['dialogs'] ?? []),
            'waypoints' => $list($browser['waypoints'] ?? []),
            'catalogCreatures' => $list($browser['catalogCreatures'] ?? []),
            'scenarios' => $list($browser['scenarios'] ?? []),
        ],
        'defaults' => is_array($data['defaults'] ?? null) ? $data['defaults'] : [],
    ];
}

/**
 * Scan presets/{mode}/mode.json for every installed pack.
 *
 * @return list<array{id: string, label: string, isDefault: bool}>
 */
function hdl_list_modes(): array
{
    $root = hdl_presets_root();
    $out = [];
    if (!is_dir($root)) {
        return $out;
    }
    $entries = scandir($root);
    if ($entries === false) {
        return $out;
    }
    foreach ($entries as $name) {
        if ($name === '.' || $name === '..') {
            continue;
        }
        $dir = $root . '/' . $name;
        if (!is_dir($dir) || !is_file($dir . '/mode.json')) {
            continue;
        }
        try {
            $m = hdl_load_mode($name);
            $out[] = [
                'id' => (string) $m['id'],
                'label' => (string) $m['label'],
                'isDefault' => (bool) $m['isDefault'],
                // Genre catalog root for designer asset thumbs / pickers
                'genre' => is_string($m['genre'] ?? null)
                    ? (string) $m['genre']
                    : 'rpg_fantasy',
            ];
        } catch (Throwable $e) {
            // skip invalid packs
        }
    }
    usort($out, static function (array $a, array $b): int {
        if ($a['isDefault'] !== $b['isDefault']) {
            return $a['isDefault'] ? -1 : 1;
        }
        return strcmp($a['id'], $b['id']);
    });
    return $out;
}

/**
 * Default mode id (isDefault flag, else first, else standard).
 */
function hdl_default_mode_id(): string
{
    $env = getenv('HDL_CONTENT_MODE');
    if (is_string($env) && trim($env) !== '') {
        try {
            return hdl_sanitize_mode_id($env);
        } catch (Throwable $e) {
            // fall through
        }
    }
    foreach (hdl_list_modes() as $m) {
        if (!empty($m['isDefault'])) {
            return $m['id'];
        }
    }
    $modes = hdl_list_modes();
    if ($modes !== []) {
        return $modes[0]['id'];
    }
    return 'standard';
}

/**
 * Hunt ids allowed for a mode: mode.json browser list ∪ disk scan of hunts/.
 *
 * @return list<string>
 */
function hdl_mode_hunt_ids(string $modeId): array
{
    $id = hdl_sanitize_mode_id($modeId);
    $ids = [];
    try {
        $mode = hdl_load_mode($id);
        foreach ($mode['browser']['hunts'] as $h) {
            $ids[$h] = true;
        }
    } catch (Throwable $e) {
        // ignore
    }
    $dir = hdl_presets_root() . '/' . $id . '/hunts';
    if (is_dir($dir)) {
        $files = scandir($dir);
        if ($files !== false) {
            foreach ($files as $f) {
                if (str_ends_with($f, '.json')) {
                    $ids[substr($f, 0, -5)] = true;
                }
            }
        }
    }
    $list = array_keys($ids);
    sort($list);
    return $list;
}

/**
 * All hunt ids across every installed mode (union).
 *
 * @return list<string>
 */
function hdl_all_mode_hunt_ids(): array
{
    $ids = [];
    foreach (hdl_list_modes() as $m) {
        foreach (hdl_mode_hunt_ids($m['id']) as $h) {
            $ids[$h] = true;
        }
    }
    $list = array_keys($ids);
    sort($list);
    return $list;
}
