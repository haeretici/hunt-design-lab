<?php
/**
 * List and read simulation result JSON under HDL_SIM_RESULT_ROOTS.
 * Used by Analysis UI so operators can open var/sim / presets/analysis without
 * dropping files into the browser. Folder load (I7) returns every JSON in a
 * results directory for multi-seed / set visualization.
 */

declare(strict_types=1);

namespace De;

final class SimResults
{
    /** Max files returned by list (newest first). */
    private const LIST_LIMIT = 200;

    /** Max JSON files returned by getFolder. */
    private const FOLDER_FILE_LIMIT = 80;

    /** Max depth under each root. */
    private const MAX_DEPTH = 6;

    /** Max JSON body size for get (bytes). */
    private const MAX_READ_BYTES = 8_000_000;

    /** Preferred primary filenames when summarizing a folder. */
    private const PRIMARY_NAMES = [
        'class_matrix.json',
        'strategy_eval.json',
        'sweep.json',
        'batch_aggregate.json',
        'sample_standard_arena_class_matrix.json',
        'sample_standard_arena_strategy_eval.json',
        'sample_creature_hp_sweep.json',
        'sample_golden_cave_crawl_batch.json',
        'sample_standard_arena_tier_compare.json',
    ];

    /**
     * @return array{
     *   roots: list<string>,
     *   files: list<array<string, mixed>>,
     *   folders: list<array<string, mixed>>
     * }
     */
    public static function list(?string $rootFilter = null): array
    {
        $roots = HDL_SIM_RESULT_ROOTS;
        if ($rootFilter !== null && $rootFilter !== '') {
            $rootFilter = trim(str_replace('\\', '/', $rootFilter), '/');
            if (!in_array($rootFilter, $roots, true)) {
                throw new \InvalidArgumentException('Unknown results root');
            }
            $roots = [$rootFilter];
        }

        $files = [];
        foreach ($roots as $root) {
            $absRoot = HDL_ROOT . '/' . $root;
            if (!is_dir($absRoot)) {
                continue;
            }
            self::walkJson($absRoot, $root, 0, $files);
        }

        usort($files, static function (array $a, array $b): int {
            return ($b['mtime'] ?? 0) <=> ($a['mtime'] ?? 0);
        });

        if (count($files) > self::LIST_LIMIT) {
            $files = array_slice($files, 0, self::LIST_LIMIT);
        }

        return [
            'roots' => HDL_SIM_RESULT_ROOTS,
            'files' => $files,
            'folders' => self::foldersFromFiles($files),
        ];
    }

    /**
     * Load all JSON documents in a results directory (shallow — not recursive).
     *
     * @return array{
     *   path: string,
     *   primary: string|null,
     *   files: list<array{path: string, name: string, size: int, mtime: int, document: mixed}>
     * }
     */
    public static function getFolder(string $relative): array
    {
        $resolved = Validator::assertSimResultDir($relative);
        $absDir = $resolved['absolute'];
        if (!is_dir($absDir)) {
            throw new \InvalidArgumentException('Result directory not found');
        }

        $entries = @scandir($absDir);
        if ($entries === false) {
            throw new \RuntimeException('Failed to list result directory');
        }

        $files = [];
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..' || $name[0] === '.') {
                continue;
            }
            if (!str_ends_with(strtolower($name), '.json')) {
                continue;
            }
            $abs = $absDir . '/' . $name;
            if (!is_file($abs)) {
                continue;
            }
            $size = filesize($abs);
            if ($size === false || $size < 2 || $size > self::MAX_READ_BYTES) {
                continue;
            }
            $raw = file_get_contents($abs);
            if ($raw === false) {
                continue;
            }
            $doc = json_decode($raw, true);
            if (!is_array($doc)) {
                continue;
            }
            $rel = $resolved['relative'] . '/' . $name;
            $files[] = [
                'path' => $rel,
                'name' => $name,
                'size' => (int) $size,
                'mtime' => (int) (filemtime($abs) ?: 0),
                'document' => $doc,
            ];
            if (count($files) >= self::FOLDER_FILE_LIMIT) {
                break;
            }
        }

        usort($files, static function (array $a, array $b): int {
            return strcmp((string) $a['name'], (string) $b['name']);
        });

        return [
            'path' => $resolved['relative'],
            'primary' => self::pickPrimary(array_column($files, 'name')),
            'files' => $files,
        ];
    }

    /**
     * @param list<array<string, mixed>> $files
     * @return list<array<string, mixed>>
     */
    private static function foldersFromFiles(array $files): array
    {
        /** @var array<string, array{path: string, files: list<array<string, mixed>>, mtime: int}> $map */
        $map = [];
        foreach ($files as $f) {
            $dir = isset($f['dir']) ? (string) $f['dir'] : '';
            if ($dir === '') {
                continue;
            }
            if (!isset($map[$dir])) {
                $map[$dir] = [
                    'path' => $dir,
                    'files' => [],
                    'mtime' => 0,
                ];
            }
            $map[$dir]['files'][] = $f;
            $mt = (int) ($f['mtime'] ?? 0);
            if ($mt > $map[$dir]['mtime']) {
                $map[$dir]['mtime'] = $mt;
            }
        }

        $folders = [];
        foreach ($map as $bucket) {
            $names = [];
            foreach ($bucket['files'] as $f) {
                $names[] = (string) ($f['name'] ?? '');
            }
            $primary = self::pickPrimary($names);
            $parts = array_values(array_filter(explode('/', $bucket['path'])));
            $short = implode('/', array_slice($parts, -2));
            $n = count($bucket['files']);
            $when = $bucket['mtime'] > 0
                ? gmdate('Y-m-d H:i', $bucket['mtime']) . 'Z'
                : '?';
            $folders[] = [
                'path' => $bucket['path'],
                'fileCount' => $n,
                'mtime' => $bucket['mtime'],
                'primaryName' => $primary,
                'label' => $short . ' · ' . $n . ' file' . ($n === 1 ? '' : 's')
                    . ($primary !== null ? ' · ' . $primary : '')
                    . ' · ' . $when,
            ];
        }

        usort($folders, static function (array $a, array $b): int {
            return ($b['mtime'] ?? 0) <=> ($a['mtime'] ?? 0);
        });

        return $folders;
    }

    /**
     * @param list<string> $names
     */
    private static function pickPrimary(array $names): ?string
    {
        foreach (self::PRIMARY_NAMES as $want) {
            if (in_array($want, $names, true)) {
                return $want;
            }
        }
        return null;
    }

    /**
     * @return array{path: string, size: int, mtime: int, document: mixed}
     */
    public static function get(string $relative): array
    {
        $resolved = Validator::assertSimResultPath($relative);
        $abs = $resolved['absolute'];
        if (!is_file($abs)) {
            throw new \InvalidArgumentException('Result file not found');
        }
        $size = filesize($abs);
        if ($size === false || $size < 2) {
            throw new \InvalidArgumentException('Result file empty');
        }
        if ($size > self::MAX_READ_BYTES) {
            throw new \InvalidArgumentException('Result file too large');
        }

        $raw = file_get_contents($abs);
        if ($raw === false) {
            throw new \RuntimeException('Failed to read result file');
        }
        $doc = json_decode($raw, true);
        if (!is_array($doc)) {
            throw new \InvalidArgumentException('Result file is not a JSON object/array');
        }

        return [
            'path' => $resolved['relative'],
            'size' => (int) $size,
            'mtime' => (int) (filemtime($abs) ?: 0),
            'document' => $doc,
        ];
    }

    /**
     * @param list<array<string, mixed>> $out
     */
    private static function walkJson(string $absDir, string $relDir, int $depth, array &$out): void
    {
        if ($depth > self::MAX_DEPTH) {
            return;
        }
        if (count($out) >= self::LIST_LIMIT * 2) {
            return;
        }

        $entries = @scandir($absDir);
        if ($entries === false) {
            return;
        }

        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            if ($name[0] === '.') {
                continue;
            }
            $abs = $absDir . '/' . $name;
            $rel = $relDir . '/' . $name;
            if (is_dir($abs)) {
                self::walkJson($abs, $rel, $depth + 1, $out);
                continue;
            }
            if (!is_file($abs)) {
                continue;
            }
            if (!str_ends_with(strtolower($name), '.json')) {
                continue;
            }
            // Skip huge blobs in list (still loadable if under get limit and user knows path)
            $size = filesize($abs);
            if ($size === false || $size > self::MAX_READ_BYTES) {
                continue;
            }
            $out[] = [
                'path' => $rel,
                'name' => $name,
                'dir' => $relDir,
                'size' => (int) $size,
                'mtime' => (int) (filemtime($abs) ?: 0),
                'label' => self::labelFor($rel, (int) (filemtime($abs) ?: 0), (int) $size),
            ];
        }
    }

    private static function labelFor(string $rel, int $mtime, int $size): string
    {
        $when = $mtime > 0 ? gmdate('Y-m-d H:i', $mtime) . 'Z' : '?';
        $kb = $size >= 1024 ? (string) round($size / 1024) . 'k' : $size . 'B';
        return $rel . ' · ' . $when . ' · ' . $kb;
    }
}
