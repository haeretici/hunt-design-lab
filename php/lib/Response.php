<?php
/**
 * JSON HTTP responses for the job API.
 */

declare(strict_types=1);

namespace De;

final class Response
{
    /**
     * @param array<string, mixed> $data
     */
    public static function json(array $data, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        // Local dev tool only — still avoid accidental embedding elsewhere
        header('X-Content-Type-Options: nosniff');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    /**
     * @param array<string, mixed> $extra
     */
    public static function error(string $message, int $status = 400, array $extra = []): void
    {
        self::json(array_merge([
            'ok' => false,
            'error' => $message,
        ], $extra), $status);
    }

    /**
     * @param array<string, mixed> $data
     */
    public static function ok(array $data = [], int $status = 200): void
    {
        self::json(array_merge(['ok' => true], $data), $status);
    }
}
