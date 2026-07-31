<?php
/**
 * Persist browser bug reports under bugs/ for headless reproduction.
 */

declare(strict_types=1);

namespace De;

final class BugReports
{
    /** Relative directory under HDL_ROOT. */
    public const DIR = 'bugs';

    private const MAX_DESCRIPTION = 8000;

    private const MAX_JSON_BYTES = 2_000_000;

    private const SCHEMA_VERSION_MIN = 1;

    private const SCHEMA_VERSION_MAX = 10;

    /**
     * Absolute bugs directory; creates it when missing.
     */
    public static function ensureDir(): string
    {
        $dir = HDL_ROOT . '/' . self::DIR;
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new \RuntimeException('Cannot create bugs directory');
            }
        }
        return $dir;
    }

    /**
     * Save a validated bug report document.
     *
     * @param array<string, mixed> $report
     * @return array{id: string, path: string, absolute: string, bytes: int}
     */
    public static function save(array $report): array
    {
        $doc = self::normalizeReport($report);
        $json = JsonFile::encode($doc);
        if (strlen($json) > self::MAX_JSON_BYTES) {
            throw new \InvalidArgumentException('Bug report JSON too large');
        }

        $dir = self::ensureDir();
        $id = self::makeId($doc);
        $filename = $id . '.json';
        $absolute = $dir . '/' . $filename;
        // Avoid accidental overwrite on same-second collisions.
        $n = 0;
        while (is_file($absolute) && $n < 20) {
            $n++;
            $id = self::makeId($doc) . '_' . $n;
            $filename = $id . '.json';
            $absolute = $dir . '/' . $filename;
        }

        if (file_put_contents($absolute, $json, LOCK_EX) === false) {
            throw new \RuntimeException('Failed to write bug report file');
        }
        @chmod($absolute, 0664);

        $rel = self::DIR . '/' . $filename;
        return [
            'id' => $id,
            'path' => $rel,
            'absolute' => $absolute,
            'bytes' => strlen($json),
        ];
    }

    /**
     * @param array<string, mixed> $report
     * @return array<string, mixed>
     */
    private static function normalizeReport(array $report): array
    {
        if ($report === [] || array_is_list($report)) {
            throw new \InvalidArgumentException('report must be a JSON object');
        }

        $description = isset($report['description'])
            ? trim((string) $report['description'])
            : '';
        if ($description === '') {
            throw new \InvalidArgumentException('description is required');
        }
        if (strlen($description) > self::MAX_DESCRIPTION) {
            $description = substr($description, 0, self::MAX_DESCRIPTION);
        }
        $report['description'] = $description;

        $schema = isset($report['schemaVersion'])
            ? (int) $report['schemaVersion']
            : 1;
        if ($schema < self::SCHEMA_VERSION_MIN || $schema > self::SCHEMA_VERSION_MAX) {
            throw new \InvalidArgumentException('Unsupported schemaVersion');
        }
        $report['schemaVersion'] = $schema;

        $source = isset($report['source']) ? (string) $report['source'] : 'hunt';
        if ($source !== 'hunt' && $source !== 'scenario') {
            $source = 'hunt';
        }
        $report['source'] = $source;

        if (!isset($report['createdAt']) || !is_string($report['createdAt']) || trim($report['createdAt']) === '') {
            $report['createdAt'] = gmdate('c');
        }

        if (!isset($report['seed'])) {
            $report['seed'] = 1;
        } else {
            $report['seed'] = (int) $report['seed'];
            if ($report['seed'] < 0) {
                $report['seed'] = $report['seed'] & 0xFFFFFFFF;
            }
        }

        // Cap nested depth by re-encoding (drops resources / invalid UTF-8).
        $encoded = json_encode($report, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded === false) {
            throw new \InvalidArgumentException('report contains non-JSON values');
        }
        $decoded = json_decode($encoded, true);
        if (!is_array($decoded) || array_is_list($decoded)) {
            throw new \InvalidArgumentException('report must be a JSON object');
        }
        return $decoded;
    }

    /**
     * @param array<string, mixed> $doc
     */
    private static function makeId(array $doc): string
    {
        $ts = gmdate('Ymd_His');
        $seed = isset($doc['seed']) ? (int) $doc['seed'] : 0;
        $src = isset($doc['source']) ? preg_replace('/[^a-z]/', '', (string) $doc['source']) : 'hunt';
        if ($src === null || $src === '') {
            $src = 'hunt';
        }
        $rand = bin2hex(random_bytes(3));
        return sprintf('bug_%s_%s_s%d_%s', $ts, $src, $seed, $rand);
    }
}
