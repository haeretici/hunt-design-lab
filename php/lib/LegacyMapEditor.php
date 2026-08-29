<?php

declare(strict_types=1);

namespace De;

use InvalidArgumentException;
use RuntimeException;

class LegacyMapEditor
{
    private const ALLOWED_LAYERS = ['friction', 'sight', 'flags', 'fields', 'path'];

    /**
     * Relative blob path under hybrid pack — gzip only.
     * e.g. floors/0/sub_ground.u16.gz, floors/0/friction.u8.gz
     */
    private const BLOB_REL_RE = '/^[a-zA-Z0-9_\\/.-]+\\.(u8|u16)\\.gz$/';

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function saveSpawns(array $input): array
    {
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));

        $spawns = $input['spawns'] ?? null;
        if (!is_array($spawns)) {
            throw new InvalidArgumentException('spawns must be an array');
        }

        // Client may POST a bare list of rows or an already-wrapped by_floor document.
        // Disk format is always { floor, count, spawns } (see assets/legacy/spawns/by_floor/*.json).
        if (isset($spawns['spawns']) && is_array($spawns['spawns'])) {
            $list = $spawns['spawns'];
        } elseif (array_is_list($spawns)) {
            $list = $spawns;
        } else {
            throw new InvalidArgumentException('spawns must be a list of spawn rows');
        }

        $list = array_values($list);

        $hybridDir = self::getHybridDir($floor);
        $hybridMeta = $hybridDir . '/map.json';
        if (is_file($hybridMeta)) {
            $raw = file_get_contents($hybridMeta);
            $meta = is_string($raw) ? json_decode($raw, true) : null;
            if (!is_array($meta)) {
                throw new RuntimeException('Failed to read hybrid map.json');
            }
            $meta['spawns'] = $list;
            self::writeMetaFile($hybridDir, $meta);
            return [
                'success' => true,
                'floor' => $floor,
                'source' => 'hybrid',
                'file' => 'assets/legacy/map/hybrid/floor-' . $floor . '/map.json',
            ];
        }

        $doc = [
            'floor' => (int) $floor,
            'count' => count($list),
            'spawns' => $list,
        ];

        $path = self::getSpawnsPath($floor);
        $json = json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            throw new RuntimeException('Failed to encode spawns JSON');
        }

        if (file_put_contents($path, $json . "\n") === false) {
            throw new RuntimeException('Failed to write spawns file');
        }

        return [
            'success' => true,
            'floor' => $floor,
            'source' => 'by_floor',
            'file' => 'assets/legacy/spawns/by_floor/' . $floor . '.json',
        ];
    }

    /**
     * Patch hybrid map.json `world` pins. Hybrid pack required (no by_floor analog).
     *
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function saveWorld(array $input): array
    {
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));

        $world = $input['world'] ?? null;
        if (!is_array($world)) {
            throw new InvalidArgumentException('world must be an array');
        }
        if (isset($world['world']) && is_array($world['world'])) {
            $list = $world['world'];
        } elseif (array_is_list($world)) {
            $list = $world;
        } else {
            throw new InvalidArgumentException('world must be a list of pin rows');
        }

        $list = array_values($list);

        $hybridDir = self::getHybridDir($floor);
        $hybridMeta = $hybridDir . '/map.json';
        if (!is_file($hybridMeta)) {
            throw new RuntimeException(
                'Hybrid pack required for World pins — save TileMap first'
            );
        }
        $raw = file_get_contents($hybridMeta);
        $meta = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($meta)) {
            throw new RuntimeException('Failed to read hybrid map.json');
        }
        $meta['world'] = $list;
        self::writeMetaFile($hybridDir, $meta);
        return [
            'success' => true,
            'floor' => $floor,
            'source' => 'hybrid',
            'file' => 'assets/legacy/map/hybrid/floor-' . $floor . '/map.json',
        ];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function saveLayer(array $input): array
    {
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));

        $layer = (string) ($input['layer'] ?? '');
        if (!in_array($layer, self::ALLOWED_LAYERS, true)) {
            throw new InvalidArgumentException('Invalid layer name');
        }

        $base64 = (string) ($input['image'] ?? '');
        if (strpos($base64, 'data:image/png;base64,') === 0) {
            $base64 = substr($base64, 22);
        }

        $binary = base64_decode($base64, true);
        if ($binary === false) {
            throw new InvalidArgumentException('Invalid base64 payload');
        }

        // Basic PNG signature check
        if (substr($binary, 0, 8) !== "\x89PNG\x0D\x0A\x1A\x0A") {
            throw new InvalidArgumentException('Decoded payload is not a valid PNG');
        }

        $path = self::getMapPath($floor, $layer);

        if (file_put_contents($path, $binary) === false) {
            throw new RuntimeException('Failed to write map layer file');
        }

        return ['success' => true, 'floor' => $floor, 'layer' => $layer, 'file' => 'assets/legacy/map/floor-' . $floor . '-' . $layer . '.png'];
    }

    /**
     * Save hybrid map pack (map.json + binary blobs) under assets/legacy/map/hybrid/floor-XX/.
     * Suitable for small packs (tests / rooms). Full legacy floors should use
     * saveHybridBegin + saveHybridBlob (chunked binary) to stay under PHP post_max_size.
     *
     * @param array<string, mixed> $input floor, meta (array|json string), blobsBase64 (array|json string)
     * @return array<string, mixed>
     */
    public static function saveHybrid(array $input): array
    {
        $floorRaw = trim((string) ($input['floor'] ?? ''));
        if ($floorRaw === '' && empty($input['meta']) && empty($input['blobsBase64']) && empty($input['blobs'])) {
            throw new InvalidArgumentException(
                'Empty hybrid save request (missing floor/meta). ' .
                'Usually means the POST body exceeded PHP post_max_size — use chunked hybrid save.'
            );
        }

        $floor = self::normalizeFloor($floorRaw);
        $meta = self::decodeMeta($input['meta'] ?? null);

        $blobs = $input['blobsBase64'] ?? $input['blobs'] ?? null;
        if (is_string($blobs)) {
            $decoded = json_decode($blobs, true);
            if (!is_array($decoded)) {
                throw new InvalidArgumentException('blobsBase64 must be a JSON object');
            }
            $blobs = $decoded;
        }
        if (!is_array($blobs)) {
            throw new InvalidArgumentException('blobsBase64 must be an object map');
        }

        $dir = self::ensureHybridDir($floor);
        self::clearHybridDir($dir);

        $written = [];
        foreach ($blobs as $rel => $b64) {
            $rel = self::normalizeBlobRel((string) $rel);
            $binary = base64_decode((string) $b64, true);
            if ($binary === false) {
                throw new InvalidArgumentException('Invalid base64 for blob ' . $rel);
            }
            self::assertGzipBlob($binary, $rel);
            self::writeBlobFile($dir, $rel, $binary);
            $written[] = $rel;
        }

        self::writeMetaFile($dir, $meta);

        $relRoot = 'assets/legacy/map/hybrid/floor-' . $floor;
        return [
            'success' => true,
            'floor' => $floor,
            'dir' => $relRoot,
            'meta' => $relRoot . '/map.json',
            'blobs' => $written,
        ];
    }

    /**
     * Start a chunked hybrid save: clear pack dir + write map.json only.
     *
     * @param array<string, mixed> $input floor, meta
     * @return array<string, mixed>
     */
    public static function saveHybridBegin(array $input): array
    {
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));
        $meta = self::decodeMeta($input['meta'] ?? null);

        $dir = self::ensureHybridDir($floor);
        self::clearHybridDir($dir);
        self::writeMetaFile($dir, $meta);

        $relRoot = 'assets/legacy/map/hybrid/floor-' . $floor;
        return [
            'success' => true,
            'floor' => $floor,
            'dir' => $relRoot,
            'meta' => $relRoot . '/map.json',
            'phase' => 'begin',
        ];
    }

    /**
     * Write one hybrid blob. Body must already be gzip file bytes (magic 1f 8b).
     * Optional HTTP Content-Encoding: gzip is transport-only: decoded first, result must still be gzip.
     *
     * @param array<string, mixed> $input floor, path/rel
     * @param string $binary gzip blob bytes for disk (*.u8.gz / *.u16.gz)
     * @return array<string, mixed>
     */
    public static function saveHybridBlob(array $input, string $binary): array
    {
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));
        $rel = self::normalizeBlobRel((string) ($input['path'] ?? $input['rel'] ?? ''));

        if ($binary === '') {
            throw new InvalidArgumentException('Empty blob body for ' . $rel);
        }
        self::assertGzipBlob($binary, $rel);

        $dir = self::getHybridDir($floor);
        if (!is_dir($dir)) {
            throw new RuntimeException('Hybrid dir missing — call saveHybridBegin first');
        }
        // map.json should already exist from begin
        if (!is_file($dir . '/map.json')) {
            throw new RuntimeException('Hybrid map.json missing — call saveHybridBegin first');
        }

        self::writeBlobFile($dir, $rel, $binary);

        return [
            'success' => true,
            'floor' => $floor,
            'path' => $rel,
            'bytes' => strlen($binary),
            'phase' => 'blob',
        ];
    }

    /**
     * Load hybrid pack if present for floor.
     * Default: return meta + dir + blobPaths (client fetches binaries from assets/).
     * Pass embed=1 to include blobsBase64 (small packs / tests only).
     *
     * @param array<string, mixed> $input floor, embed?
     * @return array<string, mixed>
     */
    public static function loadHybrid(array $input): array
    {
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));
        $embed = !empty($input['embed']);

        $dir = self::getHybridDir($floor);
        $metaPath = $dir . '/map.json';
        if (!is_file($metaPath)) {
            return [
                'success' => true,
                'present' => false,
                'floor' => $floor,
                'meta' => null,
                'dir' => null,
                'blobPaths' => [],
                'blobsBase64' => new \stdClass(),
            ];
        }

        $raw = file_get_contents($metaPath);
        if ($raw === false) {
            throw new RuntimeException('Failed to read map.json');
        }
        $meta = json_decode($raw, true);
        if (!is_array($meta)) {
            throw new RuntimeException('Invalid hybrid map.json');
        }

        $paths = self::collectBlobPathsFromMeta($meta);
        $relRoot = 'assets/legacy/map/hybrid/floor-' . $floor;

        $out = [
            'success' => true,
            'present' => true,
            'floor' => $floor,
            'dir' => $relRoot,
            'meta' => $meta,
            'blobPaths' => $paths,
        ];

        if ($embed) {
            $blobs = [];
            foreach ($paths as $rel) {
                $abs = $dir . '/' . $rel;
                if (!is_file($abs)) {
                    throw new RuntimeException('Missing hybrid blob: ' . $rel);
                }
                $bin = file_get_contents($abs);
                if ($bin === false) {
                    throw new RuntimeException('Failed to read blob: ' . $rel);
                }
                $blobs[$rel] = base64_encode($bin);
            }
            $out['blobsBase64'] = $blobs;
        } else {
            // Verify blobs exist without loading into memory as base64
            foreach ($paths as $rel) {
                if (!is_file($dir . '/' . $rel)) {
                    throw new RuntimeException('Missing hybrid blob: ' . $rel);
                }
            }
            $out['blobsBase64'] = new \stdClass();
        }

        return $out;
    }

    /**
     * @param array<string, mixed> $meta
     * @return list<string>
     */
    private static function collectBlobPathsFromMeta(array $meta): array
    {
        $out = [];
        $floors = $meta['floors'] ?? [];
        if (!is_array($floors)) {
            return $out;
        }
        foreach ($floors as $fm) {
            if (!is_array($fm)) {
                continue;
            }
            $subs = $fm['subLayers'] ?? [];
            if (is_array($subs)) {
                foreach ($subs as $sm) {
                    if (is_array($sm) && !empty($sm['blob']) && is_string($sm['blob'])) {
                        $out[] = str_replace('\\', '/', $sm['blob']);
                    }
                }
            }
            $ch = $fm['channels'] ?? [];
            if (is_array($ch)) {
                foreach (['friction', 'sight', 'flags', 'fields'] as $k) {
                    if (!empty($ch[$k]) && is_string($ch[$k])) {
                        $out[] = str_replace('\\', '/', $ch[$k]);
                    }
                }
            }
            if (!empty($fm['overrideMask']) && is_string($fm['overrideMask'])) {
                $out[] = str_replace('\\', '/', $fm['overrideMask']);
            }
        }
        return array_values(array_unique($out));
    }

    private static function clearHybridDir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $file) {
            $path = $file->getPathname();
            if ($file->isDir()) {
                @rmdir($path);
            } else {
                @unlink($path);
            }
        }
    }

    /**
     * Accept "08", "8", 8 → "08". Reject out of range.
     */
    private static function normalizeFloor(string $floor): string
    {
        $floor = trim($floor);
        if ($floor === '') {
            throw new InvalidArgumentException(
                'Floor must be a 2-digit number between 00 and 15 (empty floor — often a truncated POST)'
            );
        }
        if (preg_match('/^(0[0-9]|1[0-5])$/', $floor)) {
            return $floor;
        }
        if (preg_match('/^([0-9]|1[0-5])$/', $floor)) {
            return str_pad($floor, 2, '0', STR_PAD_LEFT);
        }
        throw new InvalidArgumentException('Floor must be a 2-digit number between 00 and 15');
    }

    /**
     * @param mixed $meta
     * @return array<string, mixed>
     */
    private static function decodeMeta(mixed $meta): array
    {
        if (is_string($meta)) {
            $decoded = json_decode($meta, true);
            if (!is_array($decoded)) {
                throw new InvalidArgumentException('meta must be a JSON object');
            }
            return $decoded;
        }
        if (!is_array($meta)) {
            throw new InvalidArgumentException('meta must be an object');
        }
        return $meta;
    }

    private static function normalizeBlobRel(string $rel): string
    {
        $rel = str_replace('\\', '/', $rel);
        $rel = ltrim($rel, '/');
        if ($rel === '' || strpos($rel, '..') !== false) {
            throw new InvalidArgumentException('Invalid blob path');
        }
        if (!preg_match(self::BLOB_REL_RE, $rel)) {
            throw new InvalidArgumentException(
                'Invalid blob name (expected *.u8.gz or *.u16.gz): ' . $rel
            );
        }
        return $rel;
    }

    /**
     * Hybrid on-disk format is gzip-only (no raw .u8 / .u16).
     */
    private static function assertGzipBlob(string $binary, string $rel): void
    {
        if (strlen($binary) < 2 || $binary[0] !== "\x1f" || $binary[1] !== "\x8b") {
            throw new InvalidArgumentException(
                'Hybrid blob must be gzip-compressed (magic 1f 8b): ' . $rel
            );
        }
    }

    private static function ensureHybridDir(string $floor): string
    {
        $dir = self::getHybridDir($floor);
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Failed to create hybrid directory');
        }
        return $dir;
    }

    /**
     * @param array<string, mixed> $meta
     */
    private static function writeMetaFile(string $dir, array $meta): void
    {
        $metaJson = json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        if ($metaJson === false) {
            throw new RuntimeException('Failed to encode hybrid meta');
        }
        $metaPath = $dir . '/map.json';
        if (file_put_contents($metaPath, $metaJson . "\n") === false) {
            throw new RuntimeException('Failed to write map.json');
        }
    }

    private static function writeBlobFile(string $dir, string $rel, string $binary): void
    {
        $abs = $dir . '/' . $rel;
        $parent = dirname($abs);
        if (!is_dir($parent) && !mkdir($parent, 0775, true) && !is_dir($parent)) {
            throw new RuntimeException('Failed to create blob directory for ' . $rel);
        }
        if (file_put_contents($abs, $binary) === false) {
            throw new RuntimeException('Failed to write blob ' . $rel);
        }
    }

    private static function getSpawnsPath(string $floor): string
    {
        $dir = HDL_ROOT . '/assets/legacy/spawns/by_floor';
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        return $dir . '/' . $floor . '.json';
    }

    private static function getMapPath(string $floor, string $layer): string
    {
        $dir = HDL_ROOT . '/assets/legacy/map';
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        return $dir . '/floor-' . $floor . '-' . $layer . '.png';
    }

    private static function getHybridDir(string $floor): string
    {
        return HDL_ROOT . '/assets/legacy/map/hybrid/floor-' . $floor;
    }
}
