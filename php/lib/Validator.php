<?php
/**
 * Validate and normalize job parameters against HDL_SCRIPTS whitelist.
 * Rejects unknown keys and coerces types so nothing untrusted reaches the shell.
 */

declare(strict_types=1);

namespace De;

final class Validator
{
    /**
     * @param array<string, mixed> $input
     * @return array{script: string, params: array<string, mixed>, argv: list<string>, display: string}
     */
    public static function validateRun(array $input): array
    {
        $scriptId = $input['script'] ?? null;
        if (!is_string($scriptId) || $scriptId === '') {
            throw new \InvalidArgumentException('Missing or invalid "script"');
        }
        if (!preg_match('/^[a-z][a-z0-9_]{0,63}$/', $scriptId)) {
            throw new \InvalidArgumentException('Invalid script id');
        }
        if (!isset(HDL_SCRIPTS[$scriptId])) {
            throw new \InvalidArgumentException('Unknown script: ' . $scriptId);
        }

        $def = HDL_SCRIPTS[$scriptId];
        $paramDefs = $def['params'];
        $allowedKeys = array_merge(['script', 'action'], array_keys($paramDefs));

        foreach (array_keys($input) as $key) {
            if (!is_string($key)) {
                throw new \InvalidArgumentException('Invalid parameter key type');
            }
            if (!in_array($key, $allowedKeys, true)) {
                throw new \InvalidArgumentException('Unknown parameter: ' . $key);
            }
        }

        $params = [];
        foreach ($paramDefs as $name => $rule) {
            $has = array_key_exists($name, $input) && $input[$name] !== null && $input[$name] !== '';
            if (!$has) {
                if (!empty($rule['required'])) {
                    throw new \InvalidArgumentException("Missing required parameter: {$name}");
                }
                if (array_key_exists('default', $rule)) {
                    $params[$name] = $rule['default'];
                }
                continue;
            }
            $params[$name] = self::coerce($name, $input[$name], $rule);
        }

        $argv = self::buildArgv($def, $params);
        $display = self::buildDisplayCommand($def, $argv);

        return [
            'script' => $scriptId,
            'params' => $params,
            'argv' => $argv,
            'display' => $display,
        ];
    }

    /**
     * @param array<string, mixed> $rule
     */
    private static function coerce(string $name, mixed $value, array $rule): mixed
    {
        $type = $rule['type'] ?? 'string';

        switch ($type) {
            case 'enum':
                if (!is_string($value) && !is_numeric($value)) {
                    throw new \InvalidArgumentException("Invalid {$name}: expected string enum");
                }
                $str = (string) $value;
                /** @var list<string> $values */
                $values = $rule['values'] ?? [];
                // Prefer live mode pack scan for hunt ids
                if ($name === 'huntId' && function_exists('hdl_all_mode_hunt_ids')) {
                    try {
                        $dynamic = hdl_all_mode_hunt_ids();
                        if ($dynamic !== []) {
                            $values = $dynamic;
                        }
                    } catch (\Throwable $e) {
                        // keep static whitelist
                    }
                }
                if (!in_array($str, $values, true)) {
                    throw new \InvalidArgumentException("Invalid {$name}: value not allowed");
                }
                return $str;

            case 'int':
                if (is_bool($value) || is_array($value)) {
                    throw new \InvalidArgumentException("Invalid {$name}: expected integer");
                }
                if (is_string($value) && !preg_match('/^-?\d+$/', trim($value))) {
                    throw new \InvalidArgumentException("Invalid {$name}: expected integer");
                }
                $n = (int) $value;
                if (isset($rule['min']) && $n < (int) $rule['min']) {
                    throw new \InvalidArgumentException("Invalid {$name}: below minimum");
                }
                if (isset($rule['max']) && $n > (int) $rule['max']) {
                    throw new \InvalidArgumentException("Invalid {$name}: above maximum");
                }
                return $n;

            case 'bool':
                if (is_bool($value)) {
                    return $value;
                }
                if (is_int($value)) {
                    return $value === 1;
                }
                if (is_string($value)) {
                    $v = strtolower(trim($value));
                    if (in_array($v, ['1', 'true', 'yes', 'on'], true)) {
                        return true;
                    }
                    if (in_array($v, ['0', 'false', 'no', 'off', ''], true)) {
                        return false;
                    }
                }
                throw new \InvalidArgumentException("Invalid {$name}: expected boolean");

            case 'relpath':
                return self::coerceRelPath($name, $value, $rule);

            case 'party_members':
                return self::coercePartyMembers($name, $value);

            case 'roster_items':
                return self::coerceRosterItems($name, $value);

            default:
                throw new \InvalidArgumentException("Unsupported type for {$name}");
        }
    }

    /**
     * Selected sprite roster entries for smart_update_sprites (technical + optional alias).
     *
     * @return list<array{technical: string, alias: string}>
     */
    private static function coerceRosterItems(string $name, mixed $value): array
    {
        if (is_string($value)) {
            $decoded = json_decode($value, true);
            if (!is_array($decoded)) {
                throw new \InvalidArgumentException("Invalid {$name}: expected JSON array");
            }
            $value = $decoded;
        }
        if (!is_array($value)) {
            throw new \InvalidArgumentException("Invalid {$name}: expected array");
        }
        if ($value === []) {
            throw new \InvalidArgumentException("Invalid {$name}: empty");
        }
        if (count($value) > 512) {
            throw new \InvalidArgumentException("Invalid {$name}: too many items (max 512)");
        }

        $out = [];
        $seen = [];
        foreach ($value as $i => $row) {
            if (is_string($row)) {
                $row = ['technical' => $row];
            }
            if (!is_array($row)) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}]: expected object");
            }
            $technical = isset($row['technical'])
                ? trim((string) $row['technical'])
                : (isset($row['id']) ? trim((string) $row['id']) : '');
            if ($technical === '' || strlen($technical) > 128) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}].technical");
            }
            // Title Case phrase ("My Orc") or snake_case id — letters, digits, space, _ . -
            if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,127}$/', $technical)) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}].technical characters");
            }
            $key = strtolower($technical);
            if (isset($seen[$key])) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}]: duplicate technical");
            }
            $seen[$key] = true;

            $alias = isset($row['alias']) ? trim((string) $row['alias']) : $technical;
            if ($alias === '' || strlen($alias) > 128) {
                $alias = $technical;
            }
            // Display labels often use parentheses / punctuation (e.g. "Horn (Ring)",
            // "Barrel (Brown)"). Keep path/shell-hostile chars out; allow common wiki text.
            if (!preg_match('/^[\w \'.\-()[\]:,&+\/!]{1,128}$/u', $alias)) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}].alias");
            }

            $out[] = [
                'technical' => $technical,
                'alias' => $alias,
            ];
        }

        return $out;
    }

    /**
     * Relative path under an allowed prefix (no .., no absolute, no backslash).
     *
     * @param array<string, mixed> $rule
     */
    private static function coerceRelPath(string $name, mixed $value, array $rule): string
    {
        if (!is_string($value) && !is_numeric($value)) {
            throw new \InvalidArgumentException("Invalid {$name}: expected path string");
        }
        $raw = str_replace('\\', '/', trim((string) $value));
        $raw = trim($raw, '/');
        if ($raw === '' || str_contains($raw, '..') || str_starts_with($raw, '/')) {
            throw new \InvalidArgumentException("Invalid {$name}: path not allowed");
        }
        if (!preg_match('#^[a-zA-Z0-9][a-zA-Z0-9_./-]*$#', $raw)) {
            throw new \InvalidArgumentException("Invalid {$name}: unsafe path characters");
        }

        $prefix = isset($rule['prefix']) ? trim((string) $rule['prefix'], '/') : '';
        if ($prefix !== '') {
            if ($raw !== $prefix && !str_starts_with($raw, $prefix . '/')) {
                throw new \InvalidArgumentException(
                    "Invalid {$name}: must be under {$prefix}/"
                );
            }
        }

        // Normalize repeated slashes
        $parts = array_values(array_filter(explode('/', $raw), static fn ($p) => $p !== ''));
        return implode('/', $parts);
    }

    /**
     * Party member list for headless hunt config (whitelist fields only).
     *
     * @return list<array<string, mixed>>
     */
    private static function coercePartyMembers(string $name, mixed $value): array
    {
        if (is_string($value)) {
            $decoded = json_decode($value, true);
            if (!is_array($decoded)) {
                throw new \InvalidArgumentException("Invalid {$name}: expected JSON array");
            }
            $value = $decoded;
        }
        if (!is_array($value)) {
            throw new \InvalidArgumentException("Invalid {$name}: expected array");
        }
        if (count($value) > 8) {
            throw new \InvalidArgumentException("Invalid {$name}: too many members (max 8)");
        }

        $out = [];
        foreach ($value as $i => $row) {
            if (!is_array($row)) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}]: expected object");
            }
            $member = [];

            $classId = isset($row['classId']) ? (string) $row['classId'] : 'adventurer';
            if (!in_array($classId, HDL_CLASS_IDS, true)) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}].classId");
            }
            $member['classId'] = $classId;

            $strategyId = isset($row['strategyId']) ? (string) $row['strategyId'] : 'balanced';
            if (!in_array($strategyId, HDL_STRATEGY_IDS, true)) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}].strategyId");
            }
            $member['strategyId'] = $strategyId;

            $nm = isset($row['name']) ? trim((string) $row['name']) : 'Member';
            if ($nm === '' || strlen($nm) > 64 || !preg_match('/^[\w \'.\-]+$/u', $nm)) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}].name");
            }
            $member['name'] = $nm;

            $level = isset($row['level']) ? (int) $row['level'] : 50;
            if ($level < 1 || $level > 999) {
                throw new \InvalidArgumentException("Invalid {$name}[{$i}].level");
            }
            $member['level'] = $level;

            $member['isLeader'] = !empty($row['isLeader']);

            // Drop equipment / free-form bags — headless accepts them, web path keeps safe subset.
            $out[] = $member;
        }

        return $out;
    }

    /**
     * Build argv tokens for the script only (no runtime binary).
     * All values already validated against whitelist / int ranges.
     *
     * @param array{bin: string, params: array<string, array<string, mixed>>, runtime: string, argv_mode?: string} $def
     * @param array<string, mixed> $params
     * @return list<string>
     */
    public static function buildArgv(array $def, array $params): array
    {
        $mode = $def['argv_mode'] ?? 'flags';
        if ($mode === 'json_config') {
            return self::buildJsonConfigArgv($def, $params);
        }

        $argv = [];
        foreach ($def['params'] as $name => $rule) {
            if (!array_key_exists($name, $params)) {
                continue;
            }
            $value = $params[$name];
            $flag = $rule['flag'] ?? null;
            if (!is_string($flag) || $flag === '') {
                continue;
            }

            $type = $rule['type'] ?? 'string';
            if ($type === 'bool') {
                if ($value === true) {
                    $argv[] = $flag;
                }
                continue;
            }

            if (!empty($rule['omit_if_default']) && array_key_exists('default', $rule) && $value === $rule['default']) {
                continue;
            }

            if ($type === 'int') {
                $argv[] = $flag;
                $argv[] = (string) (int) $value;
                continue;
            }
            if ($type === 'enum') {
                /** @var list<string> $values */
                $values = $rule['values'] ?? [];
                if (!is_string($value) || !in_array($value, $values, true)) {
                    throw new \InvalidArgumentException("Refusing unsafe enum for {$name}");
                }
                $argv[] = $flag;
                $argv[] = $value;
                continue;
            }
        }
        return $argv;
    }

    /**
     * One compact JSON object arg for batch_worker (same as CLI JSON form).
     *
     * @param array{params: array<string, array<string, mixed>>} $def
     * @param array<string, mixed> $params
     * @return list<string>
     */
    private static function buildJsonConfigArgv(array $def, array $params): array
    {
        $cfg = [];
        foreach ($def['params'] as $name => $rule) {
            if (!array_key_exists($name, $params)) {
                continue;
            }
            $key = isset($rule['json_key']) && is_string($rule['json_key']) && $rule['json_key'] !== ''
                ? $rule['json_key']
                : $name;
            $value = $params[$name];
            if ($value === null || $value === '') {
                continue;
            }
            if (is_array($value) && $value === []) {
                continue;
            }
            $cfg[$key] = $value;
        }

        $json = json_encode($cfg, JSON_UNESCAPED_SLASHES);
        if (!is_string($json) || $json === '' || $json === '[]' || $json === '{}') {
            throw new \InvalidArgumentException('Failed to build sim batch JSON config');
        }
        if (strlen($json) > 65_536) {
            throw new \InvalidArgumentException('Sim batch config too large');
        }

        return [$json];
    }

    /**
     * Human-readable command line (for UI / logs). Shell-safe via escapeshellarg.
     *
     * @param array{runtime: string, bin: string} $def
     * @param list<string> $argv
     */
    public static function buildDisplayCommand(array $def, array $argv): string
    {
        $parts = [self::runtimeBinary($def['runtime']), $def['bin']];
        foreach ($argv as $token) {
            $parts[] = self::needsQuote($token) ? escapeshellarg($token) : $token;
        }
        return implode(' ', $parts);
    }

    /**
     * Full command array for proc_open: [binary, scriptPath, ...argv]
     *
     * @param array{runtime: string, bin: string} $def
     * @param list<string> $argv
     * @return list<string>
     */
    public static function buildExecCommand(array $def, array $argv): array
    {
        $binRel = $def['bin'];
        if (!is_string($binRel) || $binRel === '' || str_contains($binRel, '..') || $binRel[0] === '/') {
            throw new \InvalidArgumentException('Invalid script bin path in config');
        }
        $scriptPath = HDL_ROOT . '/' . $binRel;
        if (!is_file($scriptPath)) {
            throw new \RuntimeException('Script not found: ' . $binRel);
        }

        $cmd = [self::runtimeBinary($def['runtime']), $scriptPath];
        foreach ($argv as $token) {
            if (!is_string($token)) {
                throw new \InvalidArgumentException('Non-string argv token');
            }
            $cmd[] = $token;
        }
        return $cmd;
    }

    public static function runtimeBinary(string $runtime): string
    {
        if ($runtime === 'node') {
            return HDL_NODE_BIN;
        }
        throw new \InvalidArgumentException('Unsupported runtime: ' . $runtime);
    }

    private static function needsQuote(string $token): bool
    {
        if ($token === '') {
            return true;
        }
        // Quote anything outside a conservative safe token set (display only).
        return preg_match('/^[A-Za-z0-9_.=\\/-]+$/', $token) !== 1;
    }

    /**
     * Job ids are only [a-zA-Z0-9_-] (generated server-side; re-validated on read).
     */
    public static function assertJobId(string $id): string
    {
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/', $id)) {
            throw new \InvalidArgumentException('Invalid job id');
        }
        return $id;
    }

    /**
     * Resolve a relative path under HDL_SIM_RESULT_ROOTS (no traversal).
     *
     * @return array{relative: string, absolute: string}
     */
    public static function assertSimResultPath(string $relative): array
    {
        $raw = str_replace('\\', '/', trim($relative));
        $raw = ltrim($raw, '/');
        if ($raw === '' || str_contains($raw, '..') || str_starts_with($raw, '/')) {
            throw new \InvalidArgumentException('Invalid result path');
        }
        if (!preg_match('#^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.json$#', $raw)) {
            throw new \InvalidArgumentException('Result path must be a .json under an allowed root');
        }

        return self::resolveUnderSimResultRoots($raw);
    }

    /**
     * Resolve a relative directory under HDL_SIM_RESULT_ROOTS (no traversal).
     * Directory may be a root itself (e.g. presets/standard/analysis).
     *
     * @return array{relative: string, absolute: string}
     */
    public static function assertSimResultDir(string $relative): array
    {
        $raw = str_replace('\\', '/', trim($relative));
        $raw = trim($raw, '/');
        if ($raw === '' || str_contains($raw, '..') || str_starts_with($raw, '/')) {
            throw new \InvalidArgumentException('Invalid result directory');
        }
        if (!preg_match('#^[a-zA-Z0-9][a-zA-Z0-9_./-]*$#', $raw)) {
            throw new \InvalidArgumentException('Result directory has invalid characters');
        }

        return self::resolveUnderSimResultRoots($raw, true);
    }

    /**
     * @return array{relative: string, absolute: string}
     */
    private static function resolveUnderSimResultRoots(string $raw, bool $expectDir = false): array
    {
        $allowed = false;
        foreach (HDL_SIM_RESULT_ROOTS as $root) {
            $root = trim(str_replace('\\', '/', (string) $root), '/');
            if ($raw === $root || str_starts_with($raw, $root . '/')) {
                $allowed = true;
                break;
            }
        }
        if (!$allowed) {
            throw new \InvalidArgumentException(
                $expectDir ? 'Result directory outside allowed roots' : 'Result path outside allowed roots'
            );
        }

        $absolute = HDL_ROOT . '/' . $raw;
        $realRoot = realpath(HDL_ROOT);
        if ($realRoot === false) {
            throw new \RuntimeException('Project root missing');
        }

        $realPath = realpath($absolute);
        if ($realPath !== false) {
            if (!str_starts_with($realPath, $realRoot . DIRECTORY_SEPARATOR) && $realPath !== $realRoot) {
                throw new \InvalidArgumentException('Result path resolves outside project');
            }
            if ($expectDir && !is_dir($realPath)) {
                throw new \InvalidArgumentException('Result path is not a directory');
            }
            $absolute = $realPath;
        } else {
            $parent = dirname($absolute);
            $realParent = realpath($parent);
            if ($realParent === false ||
                (!str_starts_with($realParent, $realRoot . DIRECTORY_SEPARATOR) && $realParent !== $realRoot)
            ) {
                throw new \InvalidArgumentException('Result path parent not found or outside project');
            }
            if ($expectDir) {
                throw new \InvalidArgumentException('Result directory not found');
            }
        }

        return ['relative' => $raw, 'absolute' => $absolute];
    }
}
