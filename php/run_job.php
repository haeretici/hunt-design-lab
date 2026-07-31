<?php
/**
 * Background worker: run a queued job by id.
 * Invoked only by JobRunner (CLI), not via the web server document root ideally.
 *
 * Usage: php php/run_job.php <jobId>
 */

declare(strict_types=1);

// Refuse accidental HTTP hits
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    echo "CLI only\n";
    exit(1);
}

require_once __DIR__ . '/bootstrap.php';

use De\JobRunner;
use De\Validator;

// Long image-gen / process pipelines
ignore_user_abort(true);
set_time_limit(0);

$jobId = $argv[1] ?? '';
if ($jobId === '') {
    fwrite(STDERR, "Usage: php php/run_job.php <jobId>\n");
    exit(2);
}

try {
    Validator::assertJobId($jobId);
} catch (InvalidArgumentException $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(2);
}

hdl_ensure_storage();

$runner = new JobRunner();
$exit = $runner->execute($jobId);
exit($exit);
