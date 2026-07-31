<?php
/**
 * CRUD for mode hunt packages: presets/<mode>/hunts/*.json + mode.json browser.hunts.
 */

declare(strict_types=1);

namespace De;

final class HuntPresets
{
    /** Hunt / mode slug: snake_case, max 80 chars */
    private const ID_RE = '/^[a-z][a-z0-9_]{0,79}$/';

    /**
     * @return list<array{id: string, label: string, isDefault: bool}>
     */
    public static function listModes(): array
    {
        return hdl_list_modes();
    }

    /**
     * List hunts for a mode (disk scan + browser flags).
     *
     * @return array{mode: string, hunts: list<array<string, mixed>>, browserHunts: list<string>, defaultHuntId: string|null}
     */
    public static function list(string $modeId): array
    {
        $modeId = self::assertModeId($modeId);
        $mode = hdl_load_mode($modeId);
        $browser = $mode['browser']['hunts'] ?? [];
        $browserSet = [];
        foreach ($browser as $h) {
            $browserSet[(string) $h] = true;
        }
        $defaultHuntId = null;
        $defaults = $mode['defaults'] ?? [];
        if (is_array($defaults) && is_string($defaults['huntId'] ?? null) && $defaults['huntId'] !== '') {
            $defaultHuntId = $defaults['huntId'];
        }

        $dir = self::huntsDir($modeId);
        $hunts = [];
        if (is_dir($dir)) {
            $files = scandir($dir);
            if ($files !== false) {
                foreach ($files as $f) {
                    if (!str_ends_with($f, '.json')) {
                        continue;
                    }
                    $id = substr($f, 0, -5);
                    if ($id === '' || !preg_match(self::ID_RE, $id)) {
                        continue;
                    }
                    $meta = self::readMeta($modeId, $id);
                    $hunts[] = [
                        'id' => $id,
                        'label' => $meta['label'] ?? $id,
                        'notes' => $meta['notes'] ?? '',
                        'floor' => $meta['floor'] ?? null,
                        'inBrowser' => isset($browserSet[$id]),
                        'isDefault' => $defaultHuntId !== null && $defaultHuntId === $id,
                        'mtime' => $meta['mtime'] ?? null,
                    ];
                }
            }
        }

        usort($hunts, static function (array $a, array $b): int {
            return strcmp((string) $a['id'], (string) $b['id']);
        });

        return [
            'mode' => $modeId,
            'hunts' => $hunts,
            'browserHunts' => array_values(array_map('strval', $browser)),
            'defaultHuntId' => $defaultHuntId,
        ];
    }

    /**
     * @return array{mode: string, id: string, hunt: array<string, mixed>, inBrowser: bool, isDefault: bool, path: string}
     */
    public static function get(string $modeId, string $huntId): array
    {
        $modeId = self::assertModeId($modeId);
        $huntId = self::assertHuntId($huntId);
        $path = self::huntPath($modeId, $huntId);
        if (!is_file($path)) {
            throw new \InvalidArgumentException('Hunt not found: ' . $huntId);
        }
        $hunt = self::readJsonFile($path);
        $mode = hdl_load_mode($modeId);
        $browser = $mode['browser']['hunts'] ?? [];
        $inBrowser = in_array($huntId, $browser, true);
        $defaultHuntId = is_array($mode['defaults'] ?? null)
            ? ($mode['defaults']['huntId'] ?? null)
            : null;
        $isDefault = is_string($defaultHuntId) && $defaultHuntId === $huntId;

        return [
            'mode' => $modeId,
            'id' => $huntId,
            'hunt' => $hunt,
            'inBrowser' => $inBrowser,
            'isDefault' => $isDefault,
            'path' => self::relPath($path),
        ];
    }

    /**
     * Create or overwrite a hunt JSON and optionally update mode.json catalog flags.
     *
     * @param array<string, mixed> $opts mode, id, hunt (object), inBrowser?, setDefault?, renameFrom?
     * @return array{mode: string, id: string, created: bool, path: string, inBrowser: bool, isDefault: bool, browserHunts: list<string>}
     */
    public static function save(array $opts): array
    {
        $modeId = self::assertModeId((string) ($opts['mode'] ?? ''));
        $huntId = self::assertHuntId((string) ($opts['id'] ?? ''));
        $renameFrom = isset($opts['renameFrom']) && is_string($opts['renameFrom']) && $opts['renameFrom'] !== ''
            ? self::assertHuntId($opts['renameFrom'])
            : null;

        $rawHunt = $opts['hunt'] ?? null;
        if (is_string($rawHunt)) {
            $decoded = json_decode($rawHunt, true);
            if (!is_array($decoded)) {
                throw new \InvalidArgumentException('hunt must be a JSON object');
            }
            $rawHunt = $decoded;
        }
        if (!is_array($rawHunt) || array_is_list($rawHunt)) {
            throw new \InvalidArgumentException('hunt must be a JSON object');
        }

        // Normalize identity fields onto the body
        $rawHunt['id'] = $huntId;
        if (!isset($rawHunt['label']) || !is_string($rawHunt['label']) || trim($rawHunt['label']) === '') {
            $rawHunt['label'] = $huntId;
        }

        $dir = self::huntsDir($modeId);
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new \RuntimeException('Cannot create hunts directory for mode ' . $modeId);
            }
        }

        $path = self::huntPath($modeId, $huntId);
        $created = !is_file($path);

        // Rename: remove old file when id changes
        if ($renameFrom !== null && $renameFrom !== $huntId) {
            $oldPath = self::huntPath($modeId, $renameFrom);
            if (is_file($oldPath)) {
                if (is_file($path)) {
                    throw new \InvalidArgumentException(
                        'Cannot rename: target hunt id already exists: ' . $huntId
                    );
                }
                if (!@unlink($oldPath)) {
                    throw new \RuntimeException('Failed to remove old hunt file: ' . $renameFrom);
                }
                $created = true;
            }
        }

        self::writeJsonFile($path, $rawHunt);

        $inBrowser = array_key_exists('inBrowser', $opts)
            ? (bool) $opts['inBrowser']
            : true;
        $setDefault = !empty($opts['setDefault']);

        $browserHunts = self::updateModeCatalog($modeId, $huntId, [
            'inBrowser' => $inBrowser,
            'setDefault' => $setDefault,
            'removeFromBrowser' => !$inBrowser,
            'renameFrom' => $renameFrom,
        ]);

        $mode = hdl_load_mode($modeId);
        $defaultHuntId = is_array($mode['defaults'] ?? null)
            ? ($mode['defaults']['huntId'] ?? null)
            : null;
        $isDefault = is_string($defaultHuntId) && $defaultHuntId === $huntId;

        return [
            'mode' => $modeId,
            'id' => $huntId,
            'created' => $created,
            'path' => self::relPath($path),
            'inBrowser' => $inBrowser,
            'isDefault' => $isDefault,
            'browserHunts' => $browserHunts,
        ];
    }

    /**
     * Delete hunt file and drop it from browser.hunts / defaults.
     *
     * @return array{mode: string, id: string, deleted: bool, path: string, browserHunts: list<string>}
     */
    public static function delete(string $modeId, string $huntId): array
    {
        $modeId = self::assertModeId($modeId);
        $huntId = self::assertHuntId($huntId);
        $path = self::huntPath($modeId, $huntId);
        if (!is_file($path)) {
            throw new \InvalidArgumentException('Hunt not found: ' . $huntId);
        }
        if (!@unlink($path)) {
            throw new \RuntimeException('Failed to delete hunt file: ' . $huntId);
        }

        $browserHunts = self::updateModeCatalog($modeId, $huntId, [
            'inBrowser' => false,
            'removeFromBrowser' => true,
            'clearDefaultIfMatch' => true,
        ]);

        return [
            'mode' => $modeId,
            'id' => $huntId,
            'deleted' => true,
            'path' => self::relPath($path),
            'browserHunts' => $browserHunts,
        ];
    }

    /**
     * Minimal blank hunt body for "New".
     *
     * @return array<string, mixed>
     */
    public static function blankTemplate(string $id = 'new_hunt'): array
    {
        $id = preg_match(self::ID_RE, $id) ? $id : 'new_hunt';
        return [
            'id' => $id,
            'label' => $id,
            'notes' => '',
            'floor' => 7,
            'floors' => [7],
            'waypointPreset' => '',
            'spawns' => [],
            // Party roster is selected at sim/UI time (presets/<mode>/parties/).
        ];
    }

    /**
     * Update mode.json browser.hunts and optional defaults.huntId.
     *
     * @param array{
     *   inBrowser?: bool,
     *   removeFromBrowser?: bool,
     *   setDefault?: bool,
     *   clearDefaultIfMatch?: bool,
     *   renameFrom?: string|null
     * } $opts
     * @return list<string>
     */
    private static function updateModeCatalog(string $modeId, string $huntId, array $opts): array
    {
        $path = hdl_presets_root() . '/' . $modeId . '/mode.json';
        if (!is_file($path)) {
            throw new \RuntimeException('mode.json missing for ' . $modeId);
        }
        $raw = file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException('Cannot read mode.json for ' . $modeId);
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new \RuntimeException('Invalid mode.json for ' . $modeId);
        }

        if (!isset($data['browser']) || !is_array($data['browser'])) {
            $data['browser'] = [];
        }
        $list = [];
        if (isset($data['browser']['hunts']) && is_array($data['browser']['hunts'])) {
            foreach ($data['browser']['hunts'] as $item) {
                if (is_string($item) && $item !== '') {
                    $list[] = $item;
                }
            }
        }

        $renameFrom = isset($opts['renameFrom']) && is_string($opts['renameFrom'])
            ? $opts['renameFrom']
            : null;
        if ($renameFrom !== null && $renameFrom !== $huntId) {
            $list = array_values(array_filter(
                $list,
                static fn (string $h): bool => $h !== $renameFrom
            ));
        }

        $remove = !empty($opts['removeFromBrowser']) || (array_key_exists('inBrowser', $opts) && !$opts['inBrowser']);
        if ($remove) {
            $list = array_values(array_filter(
                $list,
                static fn (string $h): bool => $h !== $huntId
            ));
        } elseif (!empty($opts['inBrowser']) || (array_key_exists('inBrowser', $opts) && $opts['inBrowser'])) {
            if (!in_array($huntId, $list, true)) {
                $list[] = $huntId;
            }
        }

        // Dedupe preserve order
        $seen = [];
        $deduped = [];
        foreach ($list as $h) {
            if (isset($seen[$h])) {
                continue;
            }
            $seen[$h] = true;
            $deduped[] = $h;
        }
        $data['browser']['hunts'] = $deduped;

        if (!isset($data['defaults']) || !is_array($data['defaults'])) {
            $data['defaults'] = [];
        }
        if (!empty($opts['setDefault'])) {
            $data['defaults']['huntId'] = $huntId;
        }
        if (!empty($opts['clearDefaultIfMatch'])) {
            $cur = $data['defaults']['huntId'] ?? null;
            if (is_string($cur) && $cur === $huntId) {
                unset($data['defaults']['huntId']);
            }
            if ($renameFrom !== null) {
                $cur2 = $data['defaults']['huntId'] ?? null;
                if (is_string($cur2) && $cur2 === $renameFrom) {
                    unset($data['defaults']['huntId']);
                }
            }
        }
        // Rename default pointer
        if ($renameFrom !== null && $renameFrom !== $huntId) {
            $cur = $data['defaults']['huntId'] ?? null;
            if (is_string($cur) && $cur === $renameFrom) {
                $data['defaults']['huntId'] = $huntId;
            }
        }

        self::writeJsonFile($path, $data);
        return $deduped;
    }

    /**
     * @return array{label?: string, notes?: string, floor?: int|null, mtime?: int|null}
     */
    private static function readMeta(string $modeId, string $huntId): array
    {
        $path = self::huntPath($modeId, $huntId);
        $mtime = is_file($path) ? filemtime($path) : null;
        try {
            $data = self::readJsonFile($path);
        } catch (\Throwable $e) {
            return ['mtime' => $mtime ?: null];
        }
        $label = is_string($data['label'] ?? null) ? $data['label'] : $huntId;
        $notes = is_string($data['notes'] ?? null) ? $data['notes'] : '';
        $floor = isset($data['floor']) && is_numeric($data['floor']) ? (int) $data['floor'] : null;
        return [
            'label' => $label,
            'notes' => $notes,
            'floor' => $floor,
            'mtime' => $mtime ?: null,
        ];
    }

    private static function huntsDir(string $modeId): string
    {
        return hdl_presets_root() . '/' . $modeId . '/hunts';
    }

    private static function huntPath(string $modeId, string $huntId): string
    {
        return self::huntsDir($modeId) . '/' . $huntId . '.json';
    }

    private static function assertModeId(string $modeId): string
    {
        return hdl_sanitize_mode_id($modeId);
    }

    private static function assertHuntId(string $id): string
    {
        $id = strtolower(trim($id));
        if ($id === '' || !preg_match(self::ID_RE, $id)) {
            throw new \InvalidArgumentException(
                'Invalid hunt id (use snake_case, e.g. cave_crawl_generated)'
            );
        }
        // Hard path safety
        if (str_contains($id, '..') || str_contains($id, '/') || str_contains($id, '\\')) {
            throw new \InvalidArgumentException('Invalid hunt id');
        }
        return $id;
    }

    /**
     * @return array<string, mixed>
     */
    private static function readJsonFile(string $path): array
    {
        $raw = file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException('Cannot read: ' . self::relPath($path));
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new \RuntimeException('Invalid JSON: ' . self::relPath($path));
        }
        return $data;
    }

    /**
     * @param array<string, mixed>|\stdClass $data
     */
    private static function writeJsonFile(string $path, array|\stdClass $data): void
    {
        try {
            JsonFile::write($path, $data);
        } catch (\RuntimeException $e) {
            throw new \RuntimeException(
                $e->getMessage() . ' (' . self::relPath($path) . ')',
                0,
                $e
            );
        }
    }

    private static function relPath(string $abs): string
    {
        $root = HDL_ROOT;
        if (str_starts_with($abs, $root . '/')) {
            return substr($abs, strlen($root) + 1);
        }
        return $abs;
    }

}
