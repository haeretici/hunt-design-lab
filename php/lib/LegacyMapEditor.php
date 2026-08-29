<?php

declare(strict_types=1);

namespace De;

use InvalidArgumentException;
use RuntimeException;

class LegacyMapEditor
{
    private const ALLOWED_LAYERS = ['friction', 'sight', 'flags', 'fields', 'path'];

    private const MAP_ID_RE = '/^[a-z][a-z0-9_]{0,31}$/';

    private const MAPS_ROOT_REL = 'assets/legacy/maps';

    private const DEFAULT_MAP_ID = 'v01';

    private const Z_MIN = 0;

    private const Z_MAX = 15;

    private const MIN_WIDTH = 8;

    private const MAX_WIDTH = 2560;

    private const MIN_HEIGHT = 8;

    private const MAX_HEIGHT = 2048;

    private const DEFAULT_WIDTH = 256;

    private const DEFAULT_HEIGHT = 256;

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
        $pack = self::packForWrite($input);
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));

        $spawns = $input['spawns'] ?? null;
        if (!is_array($spawns)) {
            throw new InvalidArgumentException('spawns must be an array');
        }

        // Client may POST a bare list of rows or an already-wrapped by_floor document.
        // Disk format is always { floor, count, spawns } (see pack spawns/by_floor/*.json).
        if (isset($spawns['spawns']) && is_array($spawns['spawns'])) {
            $list = $spawns['spawns'];
        } elseif (array_is_list($spawns)) {
            $list = $spawns;
        } else {
            throw new InvalidArgumentException('spawns must be a list of spawn rows');
        }

        $list = array_values($list);

        $hybridDir = self::getHybridDir($floor, $pack);
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
                'mapId' => $pack['id'],
                'source' => 'hybrid',
                'file' => self::hybridRel($floor, $pack) . '/map.json',
            ];
        }

        $doc = [
            'floor' => (int) $floor,
            'count' => count($list),
            'spawns' => $list,
        ];

        $path = self::getSpawnsPath($floor, $pack);
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
            'mapId' => $pack['id'],
            'source' => 'by_floor',
            'file' => $pack['spawnsRel'] . '/by_floor/' . $floor . '.json',
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
        $pack = self::packForWrite($input);
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

        $hybridDir = self::getHybridDir($floor, $pack);
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
            'mapId' => $pack['id'],
            'source' => 'hybrid',
            'file' => self::hybridRel($floor, $pack) . '/map.json',
        ];
    }

    /**
     * @param array<string, mixed> $input
     * @return array<string, mixed>
     */
    public static function saveLayer(array $input): array
    {
        $pack = self::packForWrite($input);
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

        $path = self::getMapPath($floor, $layer, $pack);

        if (file_put_contents($path, $binary) === false) {
            throw new RuntimeException('Failed to write map layer file');
        }

        return [
            'success' => true,
            'floor' => $floor,
            'mapId' => $pack['id'],
            'layer' => $layer,
            'file' => $pack['mapsRel'] . '/floor-' . $floor . '-' . $layer . '.png',
        ];
    }

    /**
     * Save hybrid map pack (map.json + binary blobs) under <pack>/hybrid/floor-XX/.
     * Suitable for small packs (tests / rooms). Full legacy floors should use
     * saveHybridBegin + saveHybridBlob (chunked binary) to stay under PHP post_max_size.
     *
     * @param array<string, mixed> $input floor, meta (array|json string), blobsBase64 (array|json string)
     * @return array<string, mixed>
     */
    public static function saveHybrid(array $input): array
    {
        $pack = self::packForWrite($input);
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

        $dir = self::ensureHybridDir($floor, $pack);
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

        $relRoot = self::hybridRel($floor, $pack);
        return [
            'success' => true,
            'floor' => $floor,
            'mapId' => $pack['id'],
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
        $pack = self::packForWrite($input);
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));
        $meta = self::decodeMeta($input['meta'] ?? null);

        $dir = self::ensureHybridDir($floor, $pack);
        self::clearHybridDir($dir);
        self::writeMetaFile($dir, $meta);

        $relRoot = self::hybridRel($floor, $pack);
        return [
            'success' => true,
            'floor' => $floor,
            'mapId' => $pack['id'],
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
        $pack = self::packForWrite($input);
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));
        $rel = self::normalizeBlobRel((string) ($input['path'] ?? $input['rel'] ?? ''));

        if ($binary === '') {
            throw new InvalidArgumentException('Empty blob body for ' . $rel);
        }
        self::assertGzipBlob($binary, $rel);

        $dir = self::getHybridDir($floor, $pack);
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
            'mapId' => $pack['id'],
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
        $pack = self::packForRead($input);
        $floor = self::normalizeFloor((string) ($input['floor'] ?? ''));
        $embed = !empty($input['embed']);

        $dir = self::getHybridDir($floor, $pack);
        $metaPath = $dir . '/map.json';
        if (!is_file($metaPath)) {
            return [
                'success' => true,
                'present' => false,
                'floor' => $floor,
                'mapId' => $pack['id'],
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
        $relRoot = self::hybridRel($floor, $pack);

        $out = [
            'success' => true,
            'present' => true,
            'floor' => $floor,
            'mapId' => $pack['id'],
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

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     */
    private static function ensureHybridDir(string $floor, array $pack): string
    {
        $dir = self::getHybridDir($floor, $pack);
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
        @chmod($abs, 0664);
    }

    /**
     * Create a pack: yellow path PNGs, bounds, empty by_floor + index.
     * Optional fromSelection crops path PNGs / hybrid / pins from a source pack
     * so the selection origin becomes (0,0). No navmesh/. requireWrite at the API.
     *
     * @param array<string, mixed> $input id, label?, width?, height?, fromSelection?, sourceMapId?, x?, y?
     * @return array<string, mixed>
     */
    public static function createMap(array $input): array
    {
        $id = self::normalizeNewMapId($input['id'] ?? null);
        $label = self::normalizeNewMapLabel($input['label'] ?? null, $id);
        $width = self::parseDim(
            array_key_exists('width', $input) ? $input['width'] : self::DEFAULT_WIDTH,
            'width',
            self::MIN_WIDTH,
            self::MAX_WIDTH
        );
        $height = self::parseDim(
            array_key_exists('height', $input) ? $input['height'] : self::DEFAULT_HEIGHT,
            'height',
            self::MIN_HEIGHT,
            self::MAX_HEIGHT
        );

        $fromSelection = self::parseBool($input['fromSelection'] ?? false);
        $sourcePack = null;
        $originX = 0;
        $originY = 0;
        if ($fromSelection) {
            $sourceRaw = $input['sourceMapId'] ?? $input['sourceId'] ?? null;
            if ($sourceRaw === null || $sourceRaw === '') {
                throw new InvalidArgumentException('sourceMapId is required when creating from selection');
            }
            if (!is_string($sourceRaw) && !is_numeric($sourceRaw)) {
                throw new InvalidArgumentException('Invalid map id');
            }
            $sourcePack = self::resolvePack(trim((string) $sourceRaw), true);
            $originX = self::parseDim($input['x'] ?? null, 'x', 0, self::MAX_WIDTH);
            $originY = self::parseDim($input['y'] ?? null, 'y', 0, self::MAX_HEIGHT);
            [$srcW, $srcH] = self::sourceMapSize($sourcePack);
            if ($originX >= $srcW || $originY >= $srcH) {
                throw new InvalidArgumentException('Selection origin is outside the source map');
            }
        }

        $manifest = self::loadManifest();
        if (self::findManifestRow($manifest, $id) !== null) {
            throw new InvalidArgumentException('Map id already exists');
        }

        $mapsRel = self::MAPS_ROOT_REL . '/' . $id;
        $packAbs = HDL_ROOT . '/' . $mapsRel;
        if (file_exists($packAbs)) {
            throw new InvalidArgumentException('Map id already exists');
        }

        $spawnsRel = $mapsRel . '/spawns';
        $byFloorAbs = $packAbs . '/spawns/by_floor';

        try {
            self::mkdir775($packAbs);
            self::mkdir775($byFloorAbs);

            $floorIDs = [];
            $indexFloors = [];
            $totalSpawns = 0;
            $creatureIdSet = [];
            for ($z = self::Z_MIN; $z <= self::Z_MAX; $z++) {
                $pad = str_pad((string) $z, 2, '0', STR_PAD_LEFT);
                $floorIDs[] = $pad;
                $spawns = [];
                if ($fromSelection && is_array($sourcePack)) {
                    $srcRoot = self::packAbs($sourcePack);
                    self::cropPngFile(
                        $srcRoot . '/floor-' . $pad . '-path.png',
                        $packAbs . '/floor-' . $pad . '-path.png',
                        $originX,
                        $originY,
                        $width,
                        $height,
                        true
                    );
                    foreach (['friction', 'sight', 'flags', 'fields'] as $layer) {
                        $srcLayer = $srcRoot . '/floor-' . $pad . '-' . $layer . '.png';
                        if (is_file($srcLayer)) {
                            self::cropPngFile(
                                $srcLayer,
                                $packAbs . '/floor-' . $pad . '-' . $layer . '.png',
                                $originX,
                                $originY,
                                $width,
                                $height,
                                false
                            );
                        }
                    }
                    $spawns = self::shiftPinList(
                        self::loadFloorSpawnList($sourcePack, $pad),
                        $originX,
                        $originY,
                        $width,
                        $height
                    );
                    self::cropHybridFloor(
                        $sourcePack,
                        $packAbs,
                        $pad,
                        $originX,
                        $originY,
                        $width,
                        $height,
                        $id,
                        $label,
                        $spawns
                    );
                } else {
                    self::writeYellowPathPng($packAbs . '/floor-' . $pad . '-path.png', $width, $height);
                }

                $count = count($spawns);
                $totalSpawns += $count;
                foreach ($spawns as $row) {
                    if (!is_array($row)) {
                        continue;
                    }
                    $cid = $row['creatureId'] ?? null;
                    if (is_string($cid) && $cid !== '') {
                        $creatureIdSet[$cid] = true;
                    }
                }
                JsonFile::write($byFloorAbs . '/' . $pad . '.json', [
                    'floor' => $z,
                    'count' => $count,
                    'spawns' => $spawns,
                ]);
                $indexFloors[] = [
                    'floor' => $pad,
                    'count' => $count,
                    'path' => $spawnsRel . '/by_floor/' . $pad . '.json',
                ];
            }

            $creatureIds = array_keys($creatureIdSet);
            sort($creatureIds);

            JsonFile::write($packAbs . '/bounds.json', [
                'xMin' => 0,
                'xMax' => $width,
                'yMin' => 0,
                'yMax' => $height,
                'zMin' => self::Z_MIN,
                'zMax' => self::Z_MAX,
                'width' => $width,
                'height' => $height,
                'floorIDs' => $floorIDs,
            ]);
            JsonFile::write($packAbs . '/spawns/index.json', [
                'version' => 2,
                'total' => $totalSpawns,
                'floors' => $indexFloors,
                'creatureIdCount' => count($creatureIds),
                'creatureIds' => $creatureIds,
            ]);

            $maps = $manifest['maps'] ?? [];
            if (!is_array($maps)) {
                $maps = [];
            }
            $maps[] = ['id' => $id, 'label' => $label];
            $manifest['maps'] = $maps;
            if (!isset($manifest['version'])) {
                $manifest['version'] = 1;
            }
            if (!isset($manifest['defaultId'])) {
                $manifest['defaultId'] = self::DEFAULT_MAP_ID;
            }
            JsonFile::write(HDL_ROOT . '/' . self::MAPS_ROOT_REL . '/manifest.json', $manifest);
        } catch (\Throwable $e) {
            self::removePackDirIfSafe($id);
            throw $e;
        }

        $out = [
            'success' => true,
            'id' => $id,
            'label' => $label,
            'mapsRel' => $mapsRel,
            'spawnsRel' => $spawnsRel,
            'width' => $width,
            'height' => $height,
            'zMin' => self::Z_MIN,
            'zMax' => self::Z_MAX,
        ];
        if ($fromSelection && is_array($sourcePack)) {
            $out['fromSelection'] = true;
            $out['sourceMapId'] = $sourcePack['id'];
            $out['x'] = $originX;
            $out['y'] = $originY;
        }
        return $out;
    }

    /**
     * Manifest maps for the editor pack switcher. Read-only — not a save API.
     *
     * @return array{version: int, defaultId: string, maps: list<array{id: string, label: string}>}
     */
    public static function listMaps(): array
    {
        $manifest = self::loadManifest();
        $defaultId = self::manifestDefaultId($manifest);
        $maps = [];
        foreach ($manifest['maps'] ?? [] as $m) {
            if (!is_array($m)) {
                continue;
            }
            $id = $m['id'] ?? null;
            if (!is_string($id) || !preg_match(self::MAP_ID_RE, $id)) {
                continue;
            }
            $label = is_string($m['label'] ?? null) && $m['label'] !== ''
                ? $m['label']
                : $id;
            $maps[] = ['id' => $id, 'label' => $label];
        }
        return [
            'version' => (int) ($manifest['version'] ?? 1),
            'defaultId' => $defaultId,
            'maps' => $maps,
        ];
    }

    /**
     * Resolve a pack from assets/legacy/maps/manifest.json.
     * Empty id → defaultId. Invalid id → throw.
     * Unknown id: $requireListed (writes) → throw; otherwise defaultId (reads).
     *
     * @return array{id: string, label: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string}
     */
    public static function resolvePack(?string $mapId = null, bool $requireListed = false): array
    {
        $manifest = self::loadManifest();
        $defaultId = self::manifestDefaultId($manifest);

        $id = ($mapId === null || $mapId === '') ? $defaultId : $mapId;
        if (!preg_match(self::MAP_ID_RE, $id)) {
            throw new InvalidArgumentException('Invalid map id');
        }

        $row = self::findManifestRow($manifest, $id);
        if ($row === null) {
            if ($requireListed) {
                throw new InvalidArgumentException('Unknown map id');
            }
            $id = $defaultId;
            $row = self::findManifestRow($manifest, $id);
        }

        $label = is_array($row) && is_string($row['label'] ?? null) && $row['label'] !== ''
            ? $row['label']
            : $id;
        $mapsRel = self::MAPS_ROOT_REL . '/' . $id;
        return [
            'id' => $id,
            'label' => $label,
            'mapsRel' => $mapsRel,
            'spawnsRel' => $mapsRel . '/spawns',
            'navmeshRel' => $mapsRel . '/navmesh',
            'boundsRel' => $mapsRel . '/bounds.json',
        ];
    }

    /**
     * @param array<string, mixed> $input
     * @return array{id: string, label: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string}
     */
    private static function packForWrite(array $input): array
    {
        return self::resolvePack(self::mapIdFromInput($input), true);
    }

    /**
     * @param array<string, mixed> $input
     * @return array{id: string, label: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string}
     */
    private static function packForRead(array $input): array
    {
        return self::resolvePack(self::mapIdFromInput($input), false);
    }

    /**
     * @param array<string, mixed> $input
     */
    private static function mapIdFromInput(array $input): ?string
    {
        $raw = $input['mapId'] ?? $input['map'] ?? null;
        if ($raw === null || $raw === '') {
            return null;
        }
        if (!is_string($raw) && !is_numeric($raw)) {
            throw new InvalidArgumentException('Invalid map id');
        }
        $id = trim((string) $raw);
        return $id === '' ? null : $id;
    }

    /**
     * @return array<string, mixed>
     */
    private static function loadManifest(): array
    {
        $manifestPath = HDL_ROOT . '/' . self::MAPS_ROOT_REL . '/manifest.json';
        if (!is_file($manifestPath)) {
            throw new RuntimeException('Legacy maps manifest missing');
        }
        $raw = file_get_contents($manifestPath);
        $manifest = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($manifest)) {
            throw new RuntimeException('Invalid legacy maps manifest');
        }
        return $manifest;
    }

    /**
     * @param array<string, mixed> $manifest
     */
    private static function manifestDefaultId(array $manifest): string
    {
        $defaultId = is_string($manifest['defaultId'] ?? null)
            ? $manifest['defaultId']
            : self::DEFAULT_MAP_ID;
        if (!preg_match(self::MAP_ID_RE, $defaultId)) {
            throw new RuntimeException('Invalid defaultId in legacy maps manifest');
        }
        return $defaultId;
    }

    /**
     * @param array<string, mixed> $manifest
     * @return array<string, mixed>|null
     */
    private static function findManifestRow(array $manifest, string $id): ?array
    {
        $maps = $manifest['maps'] ?? [];
        if (!is_array($maps)) {
            return null;
        }
        foreach ($maps as $m) {
            if (is_array($m) && ($m['id'] ?? null) === $id) {
                return $m;
            }
        }
        return null;
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     */
    private static function packAbs(array $pack): string
    {
        return HDL_ROOT . '/' . $pack['mapsRel'];
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     */
    private static function hybridRel(string $floor, array $pack): string
    {
        return $pack['mapsRel'] . '/hybrid/floor-' . $floor;
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     */
    private static function getSpawnsPath(string $floor, array $pack): string
    {
        $dir = self::packAbs($pack) . '/spawns/by_floor';
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        return $dir . '/' . $floor . '.json';
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     */
    private static function getMapPath(string $floor, string $layer, array $pack): string
    {
        $dir = self::packAbs($pack);
        if (!is_dir($dir)) {
            mkdir($dir, 0775, true);
        }
        return $dir . '/floor-' . $floor . '-' . $layer . '.png';
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     */
    private static function getHybridDir(string $floor, array $pack): string
    {
        return self::packAbs($pack) . '/hybrid/floor-' . $floor;
    }

    /**
     * @param mixed $raw
     */
    private static function normalizeNewMapId(mixed $raw): string
    {
        if ($raw === null || $raw === '') {
            throw new InvalidArgumentException('Invalid map id');
        }
        if (!is_string($raw) && !is_numeric($raw)) {
            throw new InvalidArgumentException('Invalid map id');
        }
        $id = trim((string) $raw);
        if (!preg_match(self::MAP_ID_RE, $id)) {
            throw new InvalidArgumentException('Invalid map id');
        }
        return $id;
    }

    /**
     * @param mixed $raw
     */
    private static function normalizeNewMapLabel(mixed $raw, string $id): string
    {
        if ($raw === null) {
            return $id;
        }
        if (!is_string($raw) && !is_numeric($raw)) {
            throw new InvalidArgumentException('Invalid map label');
        }
        $label = trim((string) $raw);
        return $label === '' ? $id : $label;
    }

    /**
     * @param mixed $raw
     */
    private static function parseDim(mixed $raw, string $name, int $min, int $max): int
    {
        if (is_bool($raw) || is_array($raw) || $raw === null) {
            throw new InvalidArgumentException($name . ' must be an integer');
        }
        if (is_string($raw)) {
            $raw = trim($raw);
            if ($raw === '' || !preg_match('/^-?\d+$/', $raw)) {
                throw new InvalidArgumentException($name . ' must be an integer');
            }
            $n = (int) $raw;
        } elseif (is_int($raw)) {
            $n = $raw;
        } elseif (is_float($raw)) {
            if (is_nan($raw) || is_infinite($raw) || floor($raw) !== $raw) {
                throw new InvalidArgumentException($name . ' must be an integer');
            }
            $n = (int) $raw;
        } else {
            throw new InvalidArgumentException($name . ' must be an integer');
        }
        if ($n < $min || $n > $max) {
            throw new InvalidArgumentException(
                $name . ' must be an integer between ' . $min . ' and ' . $max
            );
        }
        return $n;
    }

    private static function mkdir775(string $dir): void
    {
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Failed to create directory: ' . $dir);
        }
        @chmod($dir, 0775);
    }

    private static function writeYellowPathPng(string $path, int $width, int $height): void
    {
        if (!function_exists('imagecreatetruecolor') || !function_exists('imagepng')) {
            throw new RuntimeException('PHP GD with PNG support is required to create map packs');
        }
        $im = imagecreatetruecolor($width, $height);
        if ($im === false) {
            throw new RuntimeException('Failed to allocate path PNG');
        }
        $yellow = imagecolorallocate($im, 255, 255, 0);
        if ($yellow === false) {
            imagedestroy($im);
            throw new RuntimeException('Failed to allocate yellow fill');
        }
        imagefilledrectangle($im, 0, 0, $width - 1, $height - 1, $yellow);
        $ok = imagepng($im, $path);
        imagedestroy($im);
        if ($ok === false) {
            throw new RuntimeException('Failed to write path PNG');
        }
        @chmod($path, 0664);
    }

    private static function parseBool(mixed $raw): bool
    {
        if (is_bool($raw)) {
            return $raw;
        }
        if (is_int($raw) || is_float($raw)) {
            return ((int) $raw) !== 0;
        }
        if (!is_string($raw)) {
            return false;
        }
        $s = strtolower(trim($raw));
        return $s === '1' || $s === 'true' || $s === 'on' || $s === 'yes';
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     * @return array{0: int, 1: int}
     */
    private static function sourceMapSize(array $pack): array
    {
        $boundsPath = self::packAbs($pack) . '/bounds.json';
        if (is_file($boundsPath)) {
            $raw = file_get_contents($boundsPath);
            $b = is_string($raw) ? json_decode($raw, true) : null;
            if (is_array($b)) {
                $w = (int) ($b['width'] ?? 0);
                $h = (int) ($b['height'] ?? 0);
                if ($w >= 1 && $h >= 1) {
                    return [$w, $h];
                }
            }
        }
        foreach (['00', '07'] as $pad) {
            $png = self::packAbs($pack) . '/floor-' . $pad . '-path.png';
            if (!is_file($png)) {
                continue;
            }
            $info = @getimagesize($png);
            if (is_array($info) && (int) $info[0] > 0 && (int) $info[1] > 0) {
                return [(int) $info[0], (int) $info[1]];
            }
        }
        throw new InvalidArgumentException('Source map has no bounds');
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $pack
     * @return list<array<string, mixed>>
     */
    private static function loadFloorSpawnList(array $pack, string $pad): array
    {
        $hybridMeta = self::getHybridDir($pad, $pack) . '/map.json';
        if (is_file($hybridMeta)) {
            $raw = file_get_contents($hybridMeta);
            $meta = is_string($raw) ? json_decode($raw, true) : null;
            if (is_array($meta) && array_key_exists('spawns', $meta) && is_array($meta['spawns'])) {
                return array_values($meta['spawns']);
            }
        }
        $path = self::packAbs($pack) . '/spawns/by_floor/' . $pad . '.json';
        if (!is_file($path)) {
            return [];
        }
        $raw = file_get_contents($path);
        $doc = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($doc)) {
            return [];
        }
        if (isset($doc['spawns']) && is_array($doc['spawns'])) {
            return array_values($doc['spawns']);
        }
        if (array_is_list($doc)) {
            return $doc;
        }
        return [];
    }

    /**
     * @param mixed $list
     * @return list<array<string, mixed>>
     */
    private static function shiftPinList(mixed $list, int $ox, int $oy, int $w, int $h): array
    {
        if (!is_array($list)) {
            return [];
        }
        $out = [];
        foreach ($list as $pin) {
            if (!is_array($pin) || !self::pinInRect($pin, $ox, $oy, $w, $h)) {
                continue;
            }
            $out[] = self::shiftPin($pin, $ox, $oy, $w, $h);
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $pin
     */
    private static function pinInRect(array $pin, int $ox, int $oy, int $w, int $h): bool
    {
        if (!isset($pin['x'], $pin['y'])) {
            return false;
        }
        $x = (int) round((float) $pin['x']);
        $y = (int) round((float) $pin['y']);
        return $x >= $ox && $x < $ox + $w && $y >= $oy && $y < $oy + $h;
    }

    /**
     * @param array<string, mixed> $pin
     * @return array<string, mixed>
     */
    private static function shiftPin(array $pin, int $ox, int $oy, int $w, int $h): array
    {
        $pin['x'] = (int) round((float) $pin['x']) - $ox;
        $pin['y'] = (int) round((float) $pin['y']) - $oy;
        if (isset($pin['to']) && is_array($pin['to']) && isset($pin['to']['x'], $pin['to']['y'])) {
            $tx = (int) round((float) $pin['to']['x']);
            $ty = (int) round((float) $pin['to']['y']);
            if ($tx >= $ox && $tx < $ox + $w && $ty >= $oy && $ty < $oy + $h) {
                $pin['to']['x'] = $tx - $ox;
                $pin['to']['y'] = $ty - $oy;
            } else {
                unset($pin['to']);
            }
        }
        if (isset($pin['effects']) && is_array($pin['effects'])) {
            $effects = [];
            foreach ($pin['effects'] as $eff) {
                if (!is_array($eff)) {
                    continue;
                }
                if (($eff['type'] ?? '') === 'cell' && isset($eff['x'], $eff['y'])) {
                    $ex = (int) round((float) $eff['x']);
                    $ey = (int) round((float) $eff['y']);
                    if ($ex < $ox || $ex >= $ox + $w || $ey < $oy || $ey >= $oy + $h) {
                        continue;
                    }
                    $eff['x'] = $ex - $ox;
                    $eff['y'] = $ey - $oy;
                }
                $effects[] = $eff;
            }
            $pin['effects'] = $effects;
        }
        return $pin;
    }

    private static function cropPngFile(
        string $srcPath,
        string $destPath,
        int $ox,
        int $oy,
        int $w,
        int $h,
        bool $yellowFill
    ): void {
        if (!function_exists('imagecreatetruecolor') || !function_exists('imagepng')) {
            throw new RuntimeException('PHP GD with PNG support is required to create map packs');
        }
        $dst = imagecreatetruecolor($w, $h);
        if ($dst === false) {
            throw new RuntimeException('Failed to allocate PNG');
        }
        if ($yellowFill) {
            $fill = imagecolorallocate($dst, 255, 255, 0);
            if ($fill === false) {
                imagedestroy($dst);
                throw new RuntimeException('Failed to allocate yellow fill');
            }
            imagefilledrectangle($dst, 0, 0, $w - 1, $h - 1, $fill);
        }
        if (is_file($srcPath)) {
            $src = @imagecreatefrompng($srcPath);
            if ($src !== false) {
                imagecopy($dst, $src, 0, 0, $ox, $oy, $w, $h);
                imagedestroy($src);
            }
        }
        $ok = imagepng($dst, $destPath);
        imagedestroy($dst);
        if ($ok === false) {
            throw new RuntimeException('Failed to write PNG');
        }
        @chmod($destPath, 0664);
    }

    /**
     * @param array{id: string, mapsRel: string, spawnsRel: string, navmeshRel: string, boundsRel: string} $sourcePack
     * @param list<array<string, mixed>> $spawns
     */
    private static function cropHybridFloor(
        array $sourcePack,
        string $destPackAbs,
        string $pad,
        int $ox,
        int $oy,
        int $w,
        int $h,
        string $newId,
        string $newLabel,
        array $spawns
    ): void {
        $srcDir = self::getHybridDir($pad, $sourcePack);
        $metaPath = $srcDir . '/map.json';
        if (!is_file($metaPath)) {
            return;
        }
        $raw = file_get_contents($metaPath);
        $meta = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($meta)) {
            throw new RuntimeException('Failed to read hybrid map.json');
        }

        $destDir = $destPackAbs . '/hybrid/floor-' . $pad;
        self::mkdir775($destDir);

        $floors = $meta['floors'] ?? [];
        if (!is_array($floors)) {
            $floors = [];
        }
        $outFloors = [];
        foreach ($floors as $fm) {
            if (!is_array($fm)) {
                continue;
            }
            $outFloors[] = self::cropHybridFloorMeta($srcDir, $destDir, $fm, $ox, $oy, $w, $h);
        }

        $world = self::shiftPinList($meta['world'] ?? [], $ox, $oy, $w, $h);
        $meta['version'] = $meta['version'] ?? 2;
        $meta['id'] = $newId;
        $meta['label'] = $newLabel;
        $meta['floors'] = $outFloors;
        $meta['spawns'] = $spawns;
        $meta['world'] = $world === [] ? null : $world;
        self::writeMetaFile($destDir, $meta);
    }

    /**
     * @param array<string, mixed> $fm
     * @return array<string, mixed>
     */
    private static function cropHybridFloorMeta(
        string $srcDir,
        string $destDir,
        array $fm,
        int $ox,
        int $oy,
        int $w,
        int $h
    ): array {
        $srcCols = (int) ($fm['cols'] ?? 0);
        $srcRows = (int) ($fm['rows'] ?? 0);
        if ($srcCols < 1 || $srcRows < 1) {
            throw new RuntimeException('Hybrid floor missing cols/rows');
        }
        $fm['cols'] = $w;
        $fm['rows'] = $h;
        $fm['stairs'] = self::shiftPinList($fm['stairs'] ?? [], $ox, $oy, $w, $h);

        $subs = $fm['subLayers'] ?? [];
        if (is_array($subs)) {
            foreach ($subs as $i => $sm) {
                if (!is_array($sm)) {
                    continue;
                }
                $rel = $sm['blob'] ?? null;
                if (!is_string($rel) || $rel === '' || !empty($sm['empty'])) {
                    $sm['blob'] = null;
                    $sm['empty'] = true;
                    $subs[$i] = $sm;
                    continue;
                }
                $rel = str_replace('\\', '/', $rel);
                $written = self::writeCroppedBlob(
                    $srcDir,
                    $destDir,
                    $rel,
                    $srcCols,
                    $srcRows,
                    $ox,
                    $oy,
                    $w,
                    $h,
                    2,
                    "\x00",
                    true
                );
                if ($written === null) {
                    $sm['blob'] = null;
                    $sm['empty'] = true;
                } else {
                    $sm['blob'] = $written;
                    unset($sm['empty']);
                }
                $subs[$i] = $sm;
            }
            $fm['subLayers'] = $subs;
        }

        $ch = $fm['channels'] ?? [];
        if (!is_array($ch)) {
            $ch = [];
        }
        $newCh = [];
        $padBy = [
            'friction' => "\xff",
            'sight' => "\xff",
            'flags' => "\x00",
            'fields' => "\x00",
        ];
        foreach ($padBy as $k => $padByte) {
            if (empty($ch[$k]) || !is_string($ch[$k])) {
                continue;
            }
            $rel = str_replace('\\', '/', $ch[$k]);
            $omitIfZero = $k === 'fields';
            $written = self::writeCroppedBlob(
                $srcDir,
                $destDir,
                $rel,
                $srcCols,
                $srcRows,
                $ox,
                $oy,
                $w,
                $h,
                1,
                $padByte,
                $omitIfZero
            );
            if ($written !== null) {
                $newCh[$k] = $written;
            }
        }
        $fm['channels'] = $newCh;

        if (!empty($fm['overrideMask']) && is_string($fm['overrideMask'])) {
            $rel = str_replace('\\', '/', $fm['overrideMask']);
            $written = self::writeCroppedBlob(
                $srcDir,
                $destDir,
                $rel,
                $srcCols,
                $srcRows,
                $ox,
                $oy,
                $w,
                $h,
                1,
                "\x00",
                true
            );
            $fm['overrideMask'] = $written;
        }

        return $fm;
    }

    private static function writeCroppedBlob(
        string $srcDir,
        string $destDir,
        string $rel,
        int $srcCols,
        int $srcRows,
        int $ox,
        int $oy,
        int $w,
        int $h,
        int $cellBytes,
        string $padByte,
        bool $omitIfZero
    ): ?string {
        $cropped = self::cropGrid(
            self::readGunzipBlob($srcDir, $rel),
            $srcCols,
            $srcRows,
            $ox,
            $oy,
            $w,
            $h,
            $cellBytes,
            $padByte
        );
        if ($omitIfZero && self::isAllZero($cropped)) {
            return null;
        }
        self::writeBlobFile($destDir, $rel, self::gzipBytes($cropped));
        return $rel;
    }

    private static function cropGrid(
        string $raw,
        int $srcCols,
        int $srcRows,
        int $ox,
        int $oy,
        int $w,
        int $h,
        int $cellBytes,
        string $padByte
    ): string {
        if ($w < 1 || $h < 1 || $cellBytes < 1) {
            return '';
        }
        if ($padByte === '') {
            $padByte = "\x00";
        }
        $padByte = $padByte[0];
        $fillRow = str_repeat($padByte, $w * $cellBytes);
        $rows = [];
        for ($y = 0; $y < $h; $y++) {
            $sy = $oy + $y;
            if ($sy < 0 || $sy >= $srcRows) {
                $rows[] = $fillRow;
                continue;
            }
            $srcX0 = max(0, $ox);
            $srcX1 = min($srcCols, $ox + $w);
            $leftPad = max(0, -$ox);
            $rightPad = max(0, ($ox + $w) - $srcCols);
            $copyCells = max(0, $srcX1 - $srcX0);
            $srcOff = ($sy * $srcCols + $srcX0) * $cellBytes;
            $need = $copyCells * $cellBytes;
            $mid = $copyCells > 0 ? substr($raw, $srcOff, $need) : '';
            if (strlen($mid) < $need) {
                $mid = str_pad($mid, $need, $padByte);
            }
            $row = str_repeat($padByte, $leftPad * $cellBytes) . $mid . str_repeat($padByte, $rightPad * $cellBytes);
            if (strlen($row) !== strlen($fillRow)) {
                $row = str_pad(substr($row, 0, strlen($fillRow)), strlen($fillRow), $padByte);
            }
            $rows[] = $row;
        }
        return implode('', $rows);
    }

    private static function isAllZero(string $raw): bool
    {
        return $raw === '' || strspn($raw, "\x00") === strlen($raw);
    }

    private static function gzipBytes(string $raw): string
    {
        $gz = gzencode($raw, 6);
        if ($gz === false || strlen($gz) < 8) {
            throw new RuntimeException('Failed to gzip hybrid blob');
        }
        $gz[4] = "\x00";
        $gz[5] = "\x00";
        $gz[6] = "\x00";
        $gz[7] = "\x00";
        return $gz;
    }

    private static function gunzipBytes(string $gz, string $rel): string
    {
        if (strlen($gz) < 2 || $gz[0] !== "\x1f" || $gz[1] !== "\x8b") {
            throw new InvalidArgumentException('Hybrid blob must be gzip-compressed: ' . $rel);
        }
        $raw = gzdecode($gz);
        if ($raw === false) {
            throw new RuntimeException('Failed to gunzip hybrid blob: ' . $rel);
        }
        return $raw;
    }

    private static function readGunzipBlob(string $dir, string $rel): string
    {
        $rel = self::normalizeBlobRel($rel);
        $abs = $dir . '/' . $rel;
        if (!is_file($abs)) {
            throw new RuntimeException('Missing hybrid blob: ' . $rel);
        }
        $bin = file_get_contents($abs);
        if (!is_string($bin)) {
            throw new RuntimeException('Failed to read blob: ' . $rel);
        }
        return self::gunzipBytes($bin, $rel);
    }

    /**
     * Rollback a half-created pack. Never touches defaultId / v01.
     */
    private static function removePackDirIfSafe(string $id): void
    {
        if (!preg_match(self::MAP_ID_RE, $id) || $id === self::DEFAULT_MAP_ID) {
            return;
        }
        $dir = HDL_ROOT . '/' . self::MAPS_ROOT_REL . '/' . $id;
        $root = realpath(HDL_ROOT . '/' . self::MAPS_ROOT_REL);
        if ($root === false) {
            return;
        }
        $abs = realpath($dir);
        if ($abs === false) {
            if (is_dir($dir)) {
                self::removeTree($dir);
            }
            return;
        }
        $prefix = $root . DIRECTORY_SEPARATOR;
        if ($abs === $root || strpos($abs, $prefix) !== 0) {
            return;
        }
        self::removeTree($abs);
    }

    private static function removeTree(string $dir): void
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
        @rmdir($dir);
    }
}
