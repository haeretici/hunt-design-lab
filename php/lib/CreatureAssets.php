<?php
/**
 * Sync bridge to bin/manage_creature.js for Asset Manager mutations.
 * All shell-bound values are validated (genre whitelist, id pattern, technical name).
 */

declare(strict_types=1);

namespace De;

final class CreatureAssets
{
    /** Creature id: snake_case slug */
    private const ID_RE = '/^[a-z][a-z0-9_]{0,79}$/';

    /**
     * @return array{ok: bool, error?: string, ...}
     */
    /**
     * @param array{kind?: string} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function genres(array $opts = []): array
    {
        $argv = ['genres', '--json'];
        if (!empty($opts['kind'])) {
            $kind = self::assertKind((string) $opts['kind']);
            $argv[] = '--kind';
            $argv[] = $kind;
        }
        return self::run($argv);
    }

    /**
     * @param array{genre: string, kind?: string, limit?: int|null, query?: string} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function list(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $argv = ['list', '-g', $genre, '--json'];
        if (!empty($opts['kind'])) {
            $kind = self::assertKind((string) $opts['kind']);
            $argv[] = '--kind';
            $argv[] = $kind;
        }
        if (isset($opts['limit']) && $opts['limit'] !== null && $opts['limit'] !== '') {
            $limit = self::assertLimit($opts['limit']);
            $argv[] = '--limit';
            $argv[] = (string) $limit;
        }
        if (!empty($opts['query'])) {
            $q = self::assertQuery((string) $opts['query']);
            $argv[] = '--query';
            $argv[] = $q;
        }
        return self::run($argv);
    }

    /**
     * @param array{genre: string, id: string, kind?: string, dry_run?: bool, keep_done?: bool} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function remove(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $id = self::assertId($opts['id'] ?? '');
        $argv = ['remove', '-g', $genre, '--id', $id, '--json'];
        if (!empty($opts['kind'])) {
            $argv[] = '--kind';
            $argv[] = self::assertKind((string) $opts['kind']);
        }
        if (!empty($opts['dry_run'])) {
            $argv[] = '--dry-run';
        }
        if (!empty($opts['keep_done'])) {
            $argv[] = '--keep-done';
        }
        return self::run($argv);
    }

    /**
     * @param array{genre: string, id: string, name: string, alias?: string|null, kind?: string, dry_run?: bool} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function rename(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $id = self::assertId($opts['id'] ?? '');
        $name = self::assertTechnicalName($opts['name'] ?? '');
        $argv = ['rename', '-g', $genre, '--id', $id, '--name', $name, '--json'];
        if (!empty($opts['kind'])) {
            $argv[] = '--kind';
            $argv[] = self::assertKind((string) $opts['kind']);
        }
        if (!empty($opts['alias'])) {
            $alias = self::assertAlias((string) $opts['alias']);
            $argv[] = '--alias';
            $argv[] = $alias;
        }
        if (!empty($opts['dry_run'])) {
            $argv[] = '--dry-run';
        }
        return self::run($argv);
    }

    /**
     * @param array{genre: string, id: string, dry_run?: bool} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function flip(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $id = self::assertId($opts['id'] ?? '');
        $argv = ['flip', '-g', $genre, '--id', $id, '--json'];
        if (!empty($opts['kind'])) {
            $argv[] = '--kind';
            $argv[] = self::assertKind((string) $opts['kind']);
        }
        if (!empty($opts['dry_run'])) {
            $argv[] = '--dry-run';
        }
        return self::run($argv);
    }

    /**
     * Replace original sprite from an on-disk image path (temp upload), then reprocess.
     *
     * @param array{genre: string, id: string, file: string, kind?: string, dry_run?: bool} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function replace(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $id = self::assertId($opts['id'] ?? '');
        $file = self::assertUploadPath((string) ($opts['file'] ?? ''));
        $argv = ['replace', '-g', $genre, '--id', $id, '--file', $file, '--json'];
        if (!empty($opts['kind'])) {
            $argv[] = '--kind';
            $argv[] = self::assertKind((string) $opts['kind']);
        }
        if (!empty($opts['dry_run'])) {
            $argv[] = '--dry-run';
        }
        return self::run($argv);
    }

    /**
     * @param array{genre: string, id: string, opaque_alpha: bool, kind?: string, dry_run?: bool} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function setOpaqueAlpha(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $id = self::assertId($opts['id'] ?? '');
        $value = !empty($opts['opaque_alpha']) ? 'true' : 'false';
        $argv = ['opaque', '-g', $genre, '--id', $id, '--value', $value, '--json'];
        if (!empty($opts['kind'])) {
            $argv[] = '--kind';
            $argv[] = self::assertKind((string) $opts['kind']);
        }
        if (!empty($opts['dry_run'])) {
            $argv[] = '--dry-run';
        }
        return self::run($argv);
    }

    /**
     * Re-run process_sprites for one stem (no flip/replace).
     *
     * @param array{genre: string, id: string, kind?: string, dry_run?: bool} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function reprocess(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $id = self::assertId($opts['id'] ?? '');
        $argv = ['reprocess', '-g', $genre, '--id', $id, '--json'];
        if (!empty($opts['kind'])) {
            $argv[] = '--kind';
            $argv[] = self::assertKind((string) $opts['kind']);
        }
        if (!empty($opts['dry_run'])) {
            $argv[] = '--dry-run';
        }
        return self::run($argv);
    }

    /**
     * Neutralize accentuated green on original/ (R=B=G), then reprocess stem.
     *
     * @param array{genre: string, id: string, kind?: string, dry_run?: bool} $opts
     * @return array{ok: bool, error?: string, ...}
     */
    public static function fixGreen(array $opts): array
    {
        $genre = self::assertGenre($opts['genre'] ?? '');
        $id = self::assertId($opts['id'] ?? '');
        $argv = ['fix-green', '-g', $genre, '--id', $id, '--json'];
        if (!empty($opts['kind'])) {
            $argv[] = '--kind';
            $argv[] = self::assertKind((string) $opts['kind']);
        }
        if (!empty($opts['dry_run'])) {
            $argv[] = '--dry-run';
        }
        return self::run($argv);
    }

    /**
     * Only allow absolute paths under the system temp directory (upload staging).
     */
    public static function assertUploadPath(string $file): string
    {
        $file = trim($file);
        if ($file === '' || str_contains($file, "\0")) {
            throw new \InvalidArgumentException('Missing source file');
        }
        $real = realpath($file);
        if ($real === false || !is_file($real)) {
            throw new \InvalidArgumentException('Source file not found');
        }
        $tmpRoot = realpath(sys_get_temp_dir());
        if ($tmpRoot === false) {
            throw new \RuntimeException('Temp directory unavailable');
        }
        // Path must stay under system temp (or project var/ for local tests)
        $varRoot = realpath(HDL_VAR);
        $allowed = false;
        if (str_starts_with($real, $tmpRoot . DIRECTORY_SEPARATOR) || $real === $tmpRoot) {
            $allowed = true;
        }
        if ($varRoot !== false && str_starts_with($real, $varRoot . DIRECTORY_SEPARATOR)) {
            $allowed = true;
        }
        if (!$allowed) {
            throw new \InvalidArgumentException('Source file path not allowed');
        }
        $size = filesize($real);
        if ($size === false || $size < 8 || $size > 25 * 1024 * 1024) {
            throw new \InvalidArgumentException('Source file size out of range');
        }
        return $real;
    }

    public static function assertGenre(string $genre): string
    {
        $genre = trim($genre);
        if ($genre === '' || !in_array($genre, HDL_GENRES, true)) {
            throw new \InvalidArgumentException('Invalid or missing genre');
        }
        return $genre;
    }

    public static function assertKind(string $kind): string
    {
        $kind = trim($kind);
        if ($kind === '' || !in_array($kind, HDL_ASSET_KINDS, true)) {
            throw new \InvalidArgumentException('Invalid or missing asset kind');
        }
        return $kind;
    }

    public static function assertId(string $id): string
    {
        $id = strtolower(trim($id));
        if ($id === '' || !preg_match(self::ID_RE, $id)) {
            throw new \InvalidArgumentException('Invalid or missing creature id');
        }
        return $id;
    }

    public static function assertTechnicalName(string $name): string
    {
        $name = trim($name);
        if ($name === '' || strlen($name) > 80) {
            throw new \InvalidArgumentException('Invalid technical name');
        }
        if (!preg_match("/^[A-Za-z][A-Za-z0-9' -]*$/", $name)) {
            throw new \InvalidArgumentException(
                'Technical name must start with a letter and use only letters, digits, spaces, hyphen, apostrophe'
            );
        }
        return $name;
    }

    public static function assertAlias(string $alias): string
    {
        $alias = trim($alias);
        if ($alias === '' || strlen($alias) > 80) {
            throw new \InvalidArgumentException('Invalid alias');
        }
        if (!preg_match("/^[A-Za-z0-9][A-Za-z0-9' -]*$/", $alias)) {
            throw new \InvalidArgumentException('Invalid alias characters');
        }
        return $alias;
    }

    public static function assertQuery(string $query): string
    {
        $query = trim($query);
        if (strlen($query) > 80) {
            throw new \InvalidArgumentException('Query too long');
        }
        // Allow simple free text without shell metacharacters
        if ($query !== '' && !preg_match('/^[A-Za-z0-9 _\'.-]+$/', $query)) {
            throw new \InvalidArgumentException('Invalid query characters');
        }
        return $query;
    }

    public static function assertLimit(mixed $limit): int
    {
        if (is_bool($limit) || is_array($limit)) {
            throw new \InvalidArgumentException('Invalid limit');
        }
        if (is_string($limit) && !preg_match('/^\d+$/', trim($limit))) {
            throw new \InvalidArgumentException('Invalid limit');
        }
        $n = (int) $limit;
        if ($n < 0 || $n > 5000) {
            throw new \InvalidArgumentException('Limit out of range (0–5000)');
        }
        return $n;
    }

    /**
     * @param list<string> $scriptArgv command + flags after manage_creature.js
     * @return array<string, mixed>
     */
    private static function run(array $scriptArgv): array
    {
        $script = HDL_ROOT . '/bin/manage_creature.js';
        if (!is_file($script)) {
            throw new \RuntimeException('manage_creature.js not found');
        }

        $cmd = [HDL_NODE_BIN, $script, ...$scriptArgv];
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $proc = proc_open(
            $cmd,
            $descriptors,
            $pipes,
            HDL_ROOT,
            null,
            ['bypass_shell' => true]
        );
        if (!is_resource($proc)) {
            throw new \RuntimeException('Failed to spawn manage_creature.js');
        }

        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);

        $stdout = is_string($stdout) ? trim($stdout) : '';
        $decoded = null;
        if ($stdout !== '') {
            $decoded = json_decode($stdout, true);
        }

        if (!is_array($decoded)) {
            $msg = trim((string) $stderr);
            if ($msg === '') {
                $msg = $stdout !== '' ? $stdout : 'manage_creature returned non-JSON';
            }
            throw new \RuntimeException($msg);
        }

        if ($code !== 0 || (isset($decoded['ok']) && $decoded['ok'] === false)) {
            $err = $decoded['error'] ?? ('manage_creature failed (exit ' . $code . ')');
            throw new \RuntimeException(is_string($err) ? $err : 'manage_creature failed');
        }

        // Node list/genres payloads don't always set ok:true — normalize
        if (!array_key_exists('ok', $decoded)) {
            $decoded['ok'] = true;
        }
        return $decoded;
    }
}
