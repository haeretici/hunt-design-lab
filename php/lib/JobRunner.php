<?php
/**
 * Queue a validated job and spawn php/run_job.php in the background.
 * The worker re-validates stored params before exec (defense in depth).
 */

declare(strict_types=1);

namespace De;

final class JobRunner
{
    public function __construct(
        private JobStore $store = new JobStore()
    ) {
    }

    public function store(): JobStore
    {
        return $this->store;
    }

    /**
     * @param array<string, mixed> $input Request params including script + flags
     * @return array<string, mixed> Public job meta
     */
    public function enqueue(array $input): array
    {
        $validated = Validator::validateRun($input);
        $scriptId = $validated['script'];
        $def = HDL_SCRIPTS[$scriptId];

        if ($this->store->countRunning() >= HDL_MAX_RUNNING_JOBS) {
            throw new \RuntimeException(
                'Another job is already running. Wait for it to finish or check status.'
            );
        }

        // Final path check before enqueue
        Validator::buildExecCommand($def, $validated['argv']);

        $id = $this->store->create([
            'script' => $scriptId,
            'params' => $validated['params'],
            'argv' => $validated['argv'],
            'command' => $validated['display'],
            'status' => 'queued',
            'pid' => null,
            'exit_code' => null,
            'error' => null,
            'started_at' => null,
            'finished_at' => null,
        ]);

        $workerPid = $this->spawnWorker($id);
        $meta = $this->store->update($id, [
            // Worker PID is the PHP runner; the node child may be nested
            'worker_pid' => $workerPid,
            'pid' => $workerPid,
        ]);

        return $this->store->publicMeta($meta);
    }

    /**
     * Spawn detached: php php/run_job.php <jobId>
     * Uses a minimal shell line so the HTTP request does not wait on the pipeline.
     * All three tokens are escapeshellarg'd; job id is hex-only from assertJobId.
     */
    private function spawnWorker(string $id): int
    {
        $id = Validator::assertJobId($id);
        $worker = HDL_PHP . '/run_job.php';
        if (!is_file($worker)) {
            throw new \RuntimeException('Job worker missing: php/run_job.php');
        }

        $php = HDL_PHP_BIN;
        // nohup + background so the built-in PHP server returns immediately
        $line = sprintf(
            'nohup %s %s %s > /dev/null 2>&1 & echo $!',
            escapeshellarg($php),
            escapeshellarg($worker),
            escapeshellarg($id)
        );

        $output = [];
        $code = 0;
        exec($line, $output, $code);

        $pid = isset($output[0]) && preg_match('/^\d+$/', trim($output[0]))
            ? (int) trim($output[0])
            : 0;

        if ($code !== 0 && $pid <= 0) {
            $this->store->update($id, [
                'status' => 'failed',
                'error' => 'Failed to spawn job worker',
                'finished_at' => gmdate('c'),
            ]);
            throw new \RuntimeException('Failed to spawn job worker');
        }

        return $pid;
    }

    /**
     * Execute a job in-process (called only from run_job.php CLI worker).
     */
    public function execute(string $id): int
    {
        $id = Validator::assertJobId($id);
        $meta = $this->store->read($id);
        if ($meta === null) {
            fwrite(STDERR, "Job not found: {$id}\n");
            return 1;
        }

        $scriptId = $meta['script'] ?? '';
        if (!is_string($scriptId) || !isset(HDL_SCRIPTS[$scriptId])) {
            $this->store->update($id, [
                'status' => 'failed',
                'error' => 'Invalid script in job meta',
                'finished_at' => gmdate('c'),
            ]);
            return 1;
        }

        $def = HDL_SCRIPTS[$scriptId];
        $params = is_array($meta['params'] ?? null) ? $meta['params'] : [];

        // Rebuild argv from stored params + whitelist (never trust stored argv alone)
        try {
            $rebuilt = Validator::validateRun(array_merge(['script' => $scriptId], $params));
            $cmd = Validator::buildExecCommand($def, $rebuilt['argv']);
            $display = $rebuilt['display'];
        } catch (\Throwable $e) {
            $this->store->update($id, [
                'status' => 'failed',
                'error' => 'Re-validation failed: ' . $e->getMessage(),
                'finished_at' => gmdate('c'),
            ]);
            return 1;
        }

        $this->store->update($id, [
            'status' => 'running',
            'started_at' => gmdate('c'),
            'command' => $display,
            'pid' => getmypid(),
        ]);

        $logPath = $this->store->logPath($id);
        $exitPath = $this->store->exitPath($id);

        $desc = [
            0 => ['file', '/dev/null', 'r'],
            1 => ['file', $logPath, 'a'],
            2 => ['file', $logPath, 'a'],
        ];

        $header = sprintf(
            "[%s] START %s\n[%s] cwd=%s\n\n",
            gmdate('c'),
            $display,
            gmdate('c'),
            HDL_ROOT
        );
        file_put_contents($logPath, $header, FILE_APPEND | LOCK_EX);

        $proc = proc_open(
            $cmd,
            $desc,
            $pipes,
            HDL_ROOT,
            null,
            ['bypass_shell' => true]
        );

        if (!is_resource($proc)) {
            $this->store->update($id, [
                'status' => 'failed',
                'error' => 'proc_open failed',
                'finished_at' => gmdate('c'),
            ]);
            file_put_contents($exitPath, "1\n");
            return 1;
        }

        $exitCode = proc_close($proc);
        file_put_contents($exitPath, (string) $exitCode . "\n");

        $footer = sprintf("\n[%s] EXIT %d\n", gmdate('c'), $exitCode);
        file_put_contents($logPath, $footer, FILE_APPEND | LOCK_EX);

        $this->store->update($id, [
            'status' => $exitCode === 0 ? 'completed' : 'failed',
            'exit_code' => $exitCode,
            'finished_at' => gmdate('c'),
            'error' => $exitCode === 0 ? null : "Process exited with code {$exitCode}",
        ]);

        return $exitCode;
    }
}
