<?php
/**
 * Safe request input helper (GET + POST + JSON body).
 * Never returns raw nested structures for shell use — callers must validate.
 */

declare(strict_types=1);

namespace De;

final class Request
{
    /** @var array<string, mixed> */
    private array $params;

    private string $method;

    /**
     * @param array<string, mixed>|null $params Override (tests); null = parse globals
     */
    public function __construct(?array $params = null)
    {
        $this->method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

        if ($params !== null) {
            $this->params = $params;
            return;
        }

        $query = is_array($_GET) ? $_GET : [];
        $post = is_array($_POST) ? $_POST : [];
        $json = [];

        $contentType = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
        if (stripos($contentType, 'application/json') !== false) {
            $raw = file_get_contents('php://input');
            if (is_string($raw) && $raw !== '') {
                $decoded = json_decode($raw, true);
                if (is_array($decoded)) {
                    $json = $decoded;
                }
            }
        }

        // Precedence: JSON body → POST → GET (action may come from query string)
        $this->params = array_merge($query, $post, $json);
    }

    public function method(): string
    {
        return $this->method;
    }

    public function action(): string
    {
        $action = $this->params['action'] ?? '';
        if (!is_string($action) && !is_numeric($action)) {
            return '';
        }
        // Strict action id: lowercase letters, digits, underscore
        $action = strtolower(trim((string) $action));
        if ($action === '' || !preg_match('/^[a-z][a-z0-9_]{0,63}$/', $action)) {
            return '';
        }
        return $action;
    }

    /**
     * Raw param (still untrusted). Prefer typed getters after validation.
     *
     * @return mixed
     */
    public function get(string $key, mixed $default = null): mixed
    {
        return array_key_exists($key, $this->params) ? $this->params[$key] : $default;
    }

    /**
     * @return array<string, mixed>
     */
    public function all(): array
    {
        return $this->params;
    }

    public function isWrite(): bool
    {
        return in_array($this->method, ['POST', 'PUT', 'PATCH', 'DELETE'], true);
    }
}
