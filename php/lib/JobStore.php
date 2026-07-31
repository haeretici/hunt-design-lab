<?php
/**
 * File-based job metadata and log storage under var/jobs/<id>/.
 */

declare(strict_types=1);

namespace De;

final class JobStore
{
    public function __construct(
        private string $jobsDir = HDL_JOBS
    ) {
    }

    public function dirFor(string $id): string
    {
        $id = Validator::assertJobId($id);
        return $this->jobsDir . '/' . $id;
    }

    public function metaPath(string $id): string
    {
        return $this->dirFor($id) . '/meta.json';
    }

    public function logPath(string $id): string
    {
        return $this->dirFor($id) . '/job.log';
    }

    public function exitPath(string $id): string
    {
        return $this->dirFor($id) . '/exit.code';
    }

    /**
     * @param array<string, mixed> $meta
     */
    public function create(array $meta): string
    {
        hdl_ensure_storage();
        $id = $this->newId();
        $dir = $this->jobsDir . '/' . $id;
        if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException('Cannot create job directory');
        }

        $meta['id'] = $id;
        $meta['created_at'] = $meta['created_at'] ?? gmdate('c');
        $meta['status'] = $meta['status'] ?? 'queued';
        $this->writeMeta($id, $meta);
        // Touch empty log so clients can poll immediately
        file_put_contents($this->logPath($id), '');
        return $id;
    }

    /**
     * @return array<string, mixed>|null
     */
    public function read(string $id): ?array
    {
        $path = $this->metaPath($id);
        if (!is_file($path)) {
            return null;
        }
        $raw = file_get_contents($path);
        if ($raw === false || $raw === '') {
            return null;
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }

    /**
     * @param array<string, mixed> $meta
     */
    public function writeMeta(string $id, array $meta): void
    {
        $path = $this->metaPath($id);
        $tmp = $path . '.tmp.' . getmypid();
        $json = JsonFile::encode($meta);
        if (file_put_contents($tmp, $json, LOCK_EX) === false) {
            throw new \RuntimeException('Failed to write job meta');
        }
        if (!rename($tmp, $path)) {
            @unlink($tmp);
            throw new \RuntimeException('Failed to commit job meta');
        }
    }

    /**
     * @param array<string, mixed> $patch
     * @return array<string, mixed>
     */
    public function update(string $id, array $patch): array
    {
        $meta = $this->read($id);
        if ($meta === null) {
            throw new \RuntimeException('Job not found: ' . $id);
        }
        $merged = array_merge($meta, $patch);
        $this->writeMeta($id, $merged);
        return $merged;
    }

    public function countRunning(): int
    {
        $n = 0;
        foreach ($this->listIds() as $id) {
            $meta = $this->read($id);
            if ($meta === null) {
                continue;
            }
            $status = $meta['status'] ?? '';
            if ($status === 'queued' || $status === 'running') {
                // Reap dead PIDs so a crashed worker does not block forever
                if ($this->maybeReap($id, $meta)) {
                    continue;
                }
                $n++;
            }
        }
        return $n;
    }

    /**
     * @param array<string, mixed> $meta
     */
    public function maybeReap(string $id, array $meta): bool
    {
        $status = $meta['status'] ?? '';
        if ($status !== 'queued' && $status !== 'running') {
            return false;
        }
        $pid = isset($meta['pid']) ? (int) $meta['pid'] : 0;
        if ($pid <= 0) {
            // Still queued without worker — leave alone unless very old
            $created = strtotime((string) ($meta['created_at'] ?? '')) ?: 0;
            if ($status === 'queued' && $created > 0 && (time() - $created) > 120) {
                $this->update($id, [
                    'status' => 'failed',
                    'error' => 'Worker never started',
                    'finished_at' => gmdate('c'),
                ]);
                return true;
            }
            return false;
        }
        if ($this->pidAlive($pid)) {
            return false;
        }
        // Process gone — read exit code if present
        $exitCode = null;
        $exitFile = $this->exitPath($id);
        if (is_file($exitFile)) {
            $raw = trim((string) file_get_contents($exitFile));
            if ($raw !== '' && preg_match('/^-?\d+$/', $raw)) {
                $exitCode = (int) $raw;
            }
        }
        $this->update($id, [
            'status' => ($exitCode === 0) ? 'completed' : 'failed',
            'exit_code' => $exitCode,
            'finished_at' => gmdate('c'),
            'error' => $exitCode === 0 ? null : ($meta['error'] ?? 'Process ended without clean exit record'),
        ]);
        return true;
    }

    public function pidAlive(int $pid): bool
    {
        if ($pid <= 0) {
            return false;
        }
        // posix_kill(0) checks existence without signaling
        if (function_exists('posix_kill')) {
            return @posix_kill($pid, 0);
        }
        // Fallback: /proc on Linux
        return is_dir('/proc/' . $pid);
    }

    /**
     * @return list<string>
     */
    public function listIds(): array
    {
        hdl_ensure_storage();
        $ids = [];
        $entries = scandir($this->jobsDir);
        if ($entries === false) {
            return [];
        }
        foreach ($entries as $name) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            try {
                Validator::assertJobId($name);
            } catch (\InvalidArgumentException) {
                continue;
            }
            if (is_dir($this->jobsDir . '/' . $name) && is_file($this->jobsDir . '/' . $name . '/meta.json')) {
                $ids[] = $name;
            }
        }
        // Newest first by directory mtime
        usort($ids, function (string $a, string $b): int {
            return (filemtime($this->jobsDir . '/' . $b) ?: 0) <=> (filemtime($this->jobsDir . '/' . $a) ?: 0);
        });
        return $ids;
    }

    /**
     * @return list<array<string, mixed>>
     */
    public function listRecent(int $limit = HDL_JOB_LIST_LIMIT): array
    {
        $out = [];
        foreach ($this->listIds() as $id) {
            $meta = $this->read($id);
            if ($meta === null) {
                continue;
            }
            $this->maybeReap($id, $meta);
            $meta = $this->read($id);
            if ($meta === null) {
                continue;
            }
            $out[] = $this->publicMeta($meta);
            if (count($out) >= $limit) {
                break;
            }
        }
        return $out;
    }

    /**
     * Read log tail or slice from byte offset.
     *
     * @return array{content: string, offset: int, size: int, truncated: bool}
     */
    public function readLog(string $id, int $offset = 0, int $maxBytes = HDL_LOG_CHUNK_BYTES): array
    {
        $path = $this->logPath($id);
        if (!is_file($path)) {
            return ['content' => '', 'offset' => 0, 'size' => 0, 'truncated' => false];
        }
        $size = filesize($path);
        if ($size === false) {
            $size = 0;
        }
        if ($offset < 0) {
            $offset = 0;
        }
        if ($offset > $size) {
            $offset = $size;
        }
        $fh = fopen($path, 'rb');
        if ($fh === false) {
            return ['content' => '', 'offset' => $offset, 'size' => $size, 'truncated' => false];
        }
        fseek($fh, $offset);
        $chunk = fread($fh, $maxBytes + 1);
        fclose($fh);
        if ($chunk === false) {
            $chunk = '';
        }
        $truncated = strlen($chunk) > $maxBytes;
        if ($truncated) {
            $chunk = substr($chunk, 0, $maxBytes);
        }
        $newOffset = $offset + strlen($chunk);
        return [
            'content' => $chunk,
            'offset' => $newOffset,
            'size' => $size,
            'truncated' => $truncated,
        ];
    }

    /**
     * Strip internal fields if any; keep API payload clean.
     *
     * @param array<string, mixed> $meta
     * @return array<string, mixed>
     */
    public function publicMeta(array $meta): array
    {
        return [
            'id' => $meta['id'] ?? null,
            'script' => $meta['script'] ?? null,
            'status' => $meta['status'] ?? 'unknown',
            'params' => $meta['params'] ?? new \stdClass(),
            'command' => $meta['command'] ?? '',
            'pid' => $meta['pid'] ?? null,
            'exit_code' => $meta['exit_code'] ?? null,
            'error' => $meta['error'] ?? null,
            'created_at' => $meta['created_at'] ?? null,
            'started_at' => $meta['started_at'] ?? null,
            'finished_at' => $meta['finished_at'] ?? null,
        ];
    }

    private function newId(): string
    {
        try {
            $bytes = random_bytes(16);
            return bin2hex($bytes);
        } catch (\Throwable) {
            return substr(hash('sha256', uniqid((string) mt_rand(), true)), 0, 32);
        }
    }
}
