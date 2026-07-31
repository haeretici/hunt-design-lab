<?php
/**
 * Canonical pretty-JSON encode + atomic file write for git-tracked data.
 *
 * Must stay byte-compatible with kernel/core/lib/json_format.js:
 *   4-space indent, trailing newline, unescaped slashes + unicode, key order preserved.
 */

declare(strict_types=1);

namespace De;

final class JsonFile
{
    /**
     * Encode flags shared by every on-disk JSON writer in the toolkit.
     * PHP JSON_PRETTY_PRINT uses 4 spaces — match Node JSON.stringify(..., null, 4).
     */
    public const ENCODE_FLAGS =
        JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

    /**
     * @param mixed $data
     */
    public static function encode(mixed $data): string
    {
        $json = json_encode($data, self::ENCODE_FLAGS);
        if ($json === false) {
            throw new \RuntimeException('JSON encode failed');
        }
        return $json . "\n";
    }

    /**
     * Atomic write (temp + rename) with 0664 mode.
     *
     * @param mixed $data
     */
    public static function write(string $path, mixed $data): void
    {
        $dir = dirname($path);
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new \RuntimeException('Cannot create directory: ' . $dir);
            }
        }

        $json = self::encode($data);
        $tmp = $path . '.tmp.' . bin2hex(random_bytes(4));
        if (file_put_contents($tmp, $json, LOCK_EX) === false) {
            throw new \RuntimeException('Failed to write temp file: ' . $path);
        }
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException('Failed to replace: ' . $path);
        }
        @chmod($path, 0664);
    }
}
