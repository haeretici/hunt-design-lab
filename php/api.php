<?php
/**
 * Job + Asset Manager API for the web UI.
 *
 * Job endpoints (GET or POST; write actions prefer POST):
 *   action=run     — queue a whitelisted script (generate_sprite, sim_batch, …)
 *   action=status  — job meta + optional log slice (?id=&offset=)
 *   action=log     — log slice only (?id=&offset=)
 *   action=list    — recent jobs
 *   action=scripts — list allowed scripts / params (for UI)
 *
 * Simulation results (Analysis UI):
 *   action=sim_results_list — JSON files under var/sim + presets/analysis
 *   action=sim_results_get  — read one allowed result file (?path=)
 *
 * Asset Manager (catalog) endpoints:
 *   action=catalog_genres — genre counts
 *   action=catalog_list   — creatures sorted by mtime (genre, limit, query)
 *   action=creature_remove — delete files + catalog row (POST)
 *   action=creature_rename — rename files + catalog (POST)
 *   action=creature_flip   — horizontal flip + reprocess (POST)
 *   action=creature_replace — multipart file upload replaces original + reprocess (POST)
 *   action=creature_opaque_alpha — set opaqueAlpha + reprocess (POST)
 *   action=creature_reprocess — re-run process_sprites for one stem (POST)
 *   action=creature_fix_green — neutralize accentuated green on original + reprocess (POST)
 *
 * Content mode / hunt pack endpoints:
 *   action=modes_list     — installed content modes
 *   action=hunts_list     — hunts for a mode (?mode=)
 *   action=hunts_get      — one hunt JSON (?mode=&id=)
 *   action=hunts_template — blank hunt body for New
 *   action=hunts_save     — write hunt JSON + update mode.json browser.hunts (POST)
 *   action=hunts_delete   — delete hunt file + drop from browser.hunts (POST)
 *   action=presets_browser_pack — one-shot mode catalog + Stage 11 layout deps (?mode=)
 *
 * Designer preset CRUD (Phase 2–3: catalog, folder, nested piece packs):
 *   action=presets_kinds    — allowlisted kinds for the Designer UI
 *   action=presets_list     — ?mode=&kind=&q=&limit=&offset= → id/label rows
 *   action=presets_get      — ?mode=&kind=&id= (omit id for full catalog document)
 *   action=presets_ids      — lightweight id list for relation selects
 *   action=presets_refs     — soft reference warnings for an entity (?mode=&kind=&id=)
 *   action=presets_template — blank entity for New (?kind=&id=)
 *   action=presets_save     — create/update one entity (POST)
 *   action=presets_rename   — explicit id rename + soft-ref rewrite (POST: mode, kind, from, to)
 *   action=presets_delete   — delete entity; response may include soft warnings (POST)
 *   action=presets_validate — kernel validate pieces/biomes/dungeons (?mode=&kind=&id=&level=layout|stress)
 *
 * Bug reports (Hunt UI / Scenario Lab):
 *   action=bugs_save — write a JSON report under bugs/ (POST body: { report })
 *
 * All shell-bound values are validated against php/config.php whitelists.
 */

declare(strict_types=1);

require_once __DIR__ . '/bootstrap.php';

use De\BrowserPresetPack;
use De\BugReports;
use De\CreatureAssets;
use De\HuntPresets;
use De\JobRunner;
use De\JobStore;
use De\LegacyMapEditor;
use De\PresetCrud;
use De\Request;
use De\Response;
use De\SimResults;
use De\SmartUpdateSprites;
use De\Validator;

// Local toolkit: CORS not required (same origin). Reject non-local hosts optionally.
header('X-Dungeon-Engine-API: 1');

try {
    hdl_ensure_storage();
} catch (Throwable $e) {
    Response::error('Storage unavailable: ' . $e->getMessage(), 500);
    exit;
}

$req = new Request();
$action = $req->action();

if ($action === '') {
    Response::error(
        'Missing or invalid action. Use: run, status, log, list, scripts, ' .
        'sim_results_list, sim_results_get, sim_results_folder, ' .
        'catalog_genres, catalog_list, creature_remove, creature_rename, creature_flip, creature_replace, creature_opaque_alpha, creature_reprocess, creature_fix_green, ' .
        'modes_list, hunts_list, hunts_get, hunts_template, hunts_save, hunts_delete, presets_browser_pack, ' .
        'presets_kinds, presets_list, presets_get, presets_ids, presets_refs, presets_template, presets_save, presets_rename, presets_delete, presets_validate, ' .
        'legacy_map_save_spawns, legacy_map_save_world, legacy_map_save_layer, legacy_map_save_hybrid, legacy_map_save_hybrid_begin, legacy_map_save_hybrid_blob, legacy_map_load_hybrid, smart_update_sprites, bugs_save',
        400
    );
    exit;
}

$store = new JobStore();
$runner = new JobRunner($store);

try {
    switch ($action) {
        case 'scripts':
            handleScripts();
            break;

        case 'list':
            Response::ok(['jobs' => $store->listRecent()]);
            break;

        case 'status':
            handleStatus($req, $store);
            break;

        case 'log':
            handleLog($req, $store);
            break;

        case 'run':
            if (!$req->isWrite() && ($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
                // Allow GET for simple tests, but document POST as preferred
            }
            handleRun($req, $runner);
            break;

        case 'sim_results_list':
            $root = $req->get('root', null);
            $rootStr = is_string($root) ? $root : null;
            Response::ok(SimResults::list($rootStr));
            break;

        case 'sim_results_get':
            $path = (string) $req->get('path', '');
            Response::ok(SimResults::get($path));
            break;

        case 'sim_results_folder':
            $path = (string) $req->get('path', '');
            Response::ok(SimResults::getFolder($path));
            break;

        case 'bugs_save':
            requireWrite($req);
            $report = $req->get('report', null);
            if (is_string($report)) {
                $decoded = json_decode($report, true);
                if (!is_array($decoded)) {
                    throw new InvalidArgumentException('report must be a JSON object');
                }
                $report = $decoded;
            }
            if (!is_array($report)) {
                throw new InvalidArgumentException('report must be a JSON object');
            }
            $saved = BugReports::save($report);
            Response::ok([
                'id' => $saved['id'],
                'path' => $saved['path'],
                'bytes' => $saved['bytes'],
            ]);
            break;

        case 'catalog_genres':
            $data = CreatureAssets::genres([
                'kind' => (string) $req->get('kind', 'creatures'),
            ]);
            Response::ok($data);
            break;

        case 'catalog_list':
            $data = CreatureAssets::list([
                'genre' => (string) $req->get('genre', ''),
                'kind' => (string) $req->get('kind', 'creatures'),
                'limit' => $req->get('limit', null),
                'query' => (string) $req->get('query', ''),
            ]);
            Response::ok($data);
            break;

        case 'creature_remove':
            requireWrite($req);
            $data = CreatureAssets::remove([
                'genre' => (string) $req->get('genre', ''),
                'kind' => (string) $req->get('kind', 'creatures'),
                'id' => (string) $req->get('id', ''),
                'dry_run' => (bool) $req->get('dry_run', false),
                'keep_done' => (bool) $req->get('keep_done', false),
            ]);
            Response::ok($data);
            break;

        case 'creature_rename':
            requireWrite($req);
            $data = CreatureAssets::rename([
                'genre' => (string) $req->get('genre', ''),
                'kind' => (string) $req->get('kind', 'creatures'),
                'id' => (string) $req->get('id', ''),
                'name' => (string) $req->get('name', ''),
                'alias' => $req->get('alias', null),
                'dry_run' => (bool) $req->get('dry_run', false),
            ]);
            Response::ok($data);
            break;

        case 'creature_flip':
            requireWrite($req);
            $data = CreatureAssets::flip([
                'genre' => (string) $req->get('genre', ''),
                'kind' => (string) $req->get('kind', 'creatures'),
                'id' => (string) $req->get('id', ''),
                'dry_run' => (bool) $req->get('dry_run', false),
            ]);
            Response::ok($data);
            break;

        case 'creature_replace':
            requireWrite($req);
            $data = handleCreatureReplace($req);
            Response::ok($data);
            break;

        case 'creature_opaque_alpha':
            requireWrite($req);
            $data = CreatureAssets::setOpaqueAlpha([
                'genre' => (string) $req->get('genre', ''),
                'kind' => (string) $req->get('kind', 'creatures'),
                'id' => (string) $req->get('id', ''),
                'opaque_alpha' => (bool) $req->get('opaque_alpha', false),
                'dry_run' => (bool) $req->get('dry_run', false),
            ]);
            Response::ok($data);
            break;

        case 'creature_reprocess':
            requireWrite($req);
            $data = CreatureAssets::reprocess([
                'genre' => (string) $req->get('genre', ''),
                'kind' => (string) $req->get('kind', 'creatures'),
                'id' => (string) $req->get('id', ''),
                'dry_run' => (bool) $req->get('dry_run', false),
            ]);
            Response::ok($data);
            break;

        case 'creature_fix_green':
            requireWrite($req);
            $data = CreatureAssets::fixGreen([
                'genre' => (string) $req->get('genre', ''),
                'kind' => (string) $req->get('kind', 'creatures'),
                'id' => (string) $req->get('id', ''),
                'dry_run' => (bool) $req->get('dry_run', false),
            ]);
            Response::ok($data);
            break;

        case 'modes_list':
            Response::ok([
                'modes' => HuntPresets::listModes(),
                'defaultMode' => hdl_default_mode_id(),
            ]);
            break;

        case 'hunts_list':
            $mode = (string) $req->get('mode', hdl_default_mode_id());
            Response::ok(HuntPresets::list($mode));
            break;

        case 'hunts_get':
            $mode = (string) $req->get('mode', hdl_default_mode_id());
            $id = (string) $req->get('id', '');
            Response::ok(HuntPresets::get($mode, $id));
            break;

        case 'hunts_template':
            $id = (string) $req->get('id', 'new_hunt');
            Response::ok([
                'hunt' => HuntPresets::blankTemplate($id !== '' ? $id : 'new_hunt'),
            ]);
            break;

        case 'hunts_save':
            requireWrite($req);
            $data = HuntPresets::save([
                'mode' => (string) $req->get('mode', hdl_default_mode_id()),
                'id' => (string) $req->get('id', ''),
                'hunt' => $req->get('hunt', null),
                'inBrowser' => $req->get('inBrowser', true),
                'setDefault' => (bool) $req->get('setDefault', false),
                'renameFrom' => $req->get('renameFrom', null),
            ]);
            Response::ok($data);
            break;

        case 'hunts_delete':
            requireWrite($req);
            $data = HuntPresets::delete(
                (string) $req->get('mode', hdl_default_mode_id()),
                (string) $req->get('id', '')
            );
            Response::ok($data);
            break;

        case 'presets_browser_pack':
            // Read-only: browser catalog + transitive Stage 11 layout deps.
            $mode = (string) $req->get('mode', hdl_default_mode_id());
            Response::ok(BrowserPresetPack::build($mode));
            break;

        case 'presets_kinds':
            Response::ok(['kinds' => PresetCrud::listKinds()]);
            break;

        case 'presets_list':
            $mode = (string) $req->get('mode', hdl_default_mode_id());
            $kind = (string) $req->get('kind', '');
            $listOpts = [];
            $q = $req->get('q', null);
            if ($q !== null && $q !== '') {
                $listOpts['q'] = (string) $q;
            }
            if ($req->get('limit', null) !== null && $req->get('limit', '') !== '') {
                $listOpts['limit'] = (int) $req->get('limit');
            }
            if ($req->get('offset', null) !== null && $req->get('offset', '') !== '') {
                $listOpts['offset'] = (int) $req->get('offset');
            }
            Response::ok(PresetCrud::list($mode, $kind, $listOpts));
            break;

        case 'presets_get':
            $mode = (string) $req->get('mode', hdl_default_mode_id());
            $kind = (string) $req->get('kind', '');
            $id = (string) $req->get('id', '');
            Response::ok(PresetCrud::get($mode, $kind, $id));
            break;

        case 'presets_ids':
            $mode = (string) $req->get('mode', hdl_default_mode_id());
            $kind = (string) $req->get('kind', '');
            $filterField = (string) $req->get('filterField', '');
            $filterValue = (string) $req->get('filterValue', '');
            Response::ok(PresetCrud::ids($mode, $kind, $filterField, $filterValue));
            break;

        case 'presets_refs':
            $mode = (string) $req->get('mode', hdl_default_mode_id());
            $kind = (string) $req->get('kind', '');
            $id = (string) $req->get('id', '');
            Response::ok(PresetCrud::refs($mode, $kind, $id));
            break;

        case 'presets_template':
            $kind = (string) $req->get('kind', 'spells');
            $id = (string) $req->get('id', 'new_item');
            Response::ok([
                'kind' => $kind,
                'entity' => PresetCrud::blankTemplate($kind, $id !== '' ? $id : 'new_item'),
            ]);
            break;

        case 'presets_save':
            requireWrite($req);
            $data = PresetCrud::save([
                'mode' => (string) $req->get('mode', hdl_default_mode_id()),
                'kind' => (string) $req->get('kind', ''),
                'id' => (string) $req->get('id', ''),
                'entity' => $req->get('entity', null),
                'renameFrom' => $req->get('renameFrom', null),
            ]);
            Response::ok($data);
            break;

        case 'presets_rename':
            // Explicit id rename; rewrites soft refs (populations, hunts, …) by default.
            requireWrite($req);
            $data = PresetCrud::rename([
                'mode' => (string) $req->get('mode', hdl_default_mode_id()),
                'kind' => (string) $req->get('kind', ''),
                'from' => (string) $req->get('from', $req->get('renameFrom', '')),
                'to' => (string) $req->get('to', $req->get('id', '')),
                'updateRefs' => $req->get('updateRefs', true),
            ]);
            Response::ok($data);
            break;

        case 'presets_delete':
            requireWrite($req);
            $data = PresetCrud::delete(
                (string) $req->get('mode', hdl_default_mode_id()),
                (string) $req->get('kind', ''),
                (string) $req->get('id', '')
            );
            Response::ok($data);
            break;

        case 'presets_validate':
            // Read-only engine check (Node); does not write presets.
            // level=layout|stress (stress only meaningful for dungeons).
            $data = PresetCrud::validate(
                (string) $req->get('mode', hdl_default_mode_id()),
                (string) $req->get('kind', ''),
                (string) $req->get('id', ''),
                (string) $req->get('level', 'layout')
            );
            Response::ok($data);
            break;

        case 'legacy_map_save_spawns':
            requireWrite($req);
            $spawns = $req->get('spawns', null);
            if (is_string($spawns)) {
                $decoded = json_decode($spawns, true);
                if (!is_array($decoded)) {
                    throw new InvalidArgumentException('spawns must be a JSON object/array');
                }
                $spawns = $decoded;
            }
            if (!is_array($spawns)) {
                throw new InvalidArgumentException('spawns must be a JSON object/array');
            }
            $data = LegacyMapEditor::saveSpawns([
                'floor' => (string) $req->get('floor', ''),
                'spawns' => $spawns,
            ]);
            Response::ok($data);
            break;

        case 'legacy_map_save_world':
            requireWrite($req);
            $world = $req->get('world', null);
            if (is_string($world)) {
                $decoded = json_decode($world, true);
                if (!is_array($decoded)) {
                    throw new InvalidArgumentException('world must be a JSON object/array');
                }
                $world = $decoded;
            }
            if (!is_array($world)) {
                throw new InvalidArgumentException('world must be a JSON object/array');
            }
            $data = LegacyMapEditor::saveWorld([
                'floor' => (string) $req->get('floor', ''),
                'world' => $world,
            ]);
            Response::ok($data);
            break;

        case 'legacy_map_save_layer':
            requireWrite($req);
            $data = LegacyMapEditor::saveLayer([
                'floor' => (string) $req->get('floor', ''),
                'layer' => (string) $req->get('layer', ''),
                'image' => (string) $req->get('image', ''),
            ]);
            Response::ok($data);
            break;

        case 'legacy_map_save_hybrid':
            requireWrite($req);
            $data = LegacyMapEditor::saveHybrid([
                'floor' => (string) $req->get('floor', ''),
                'meta' => $req->get('meta', null),
                'blobsBase64' => $req->get('blobsBase64', $req->get('blobs', null)),
            ]);
            Response::ok($data);
            break;

        case 'legacy_map_save_hybrid_begin':
            // Chunked hybrid save step 1: write map.json (small). Blobs follow via _blob.
            requireWrite($req);
            $data = LegacyMapEditor::saveHybridBegin([
                'floor' => (string) $req->get('floor', ''),
                'meta' => $req->get('meta', null),
            ]);
            Response::ok($data);
            break;

        case 'legacy_map_save_hybrid_blob':
            // Chunked hybrid save step 2: body = on-disk gzip blob (*.u8.gz / *.u16.gz).
            // Optional Content-Encoding: gzip is transport-only and is peeled first;
            // the resulting bytes must still be a gzip hybrid blob (no raw grids).
            requireWrite($req);
            $raw = file_get_contents('php://input');
            if (!is_string($raw) || $raw === '') {
                throw new InvalidArgumentException(
                    'Empty hybrid blob body. Check PHP post_max_size / Content-Length.'
                );
            }
            $encoding = strtolower((string) ($_SERVER['HTTP_CONTENT_ENCODING'] ?? ''));
            if ($encoding === 'gzip' || $encoding === 'x-gzip') {
                $decoded = @gzdecode($raw);
                if ($decoded === false) {
                    throw new InvalidArgumentException('Failed to gunzip transport wrapper');
                }
                $raw = $decoded;
            }
            $data = LegacyMapEditor::saveHybridBlob([
                'floor' => (string) $req->get('floor', ''),
                'path' => (string) $req->get('path', $req->get('rel', '')),
            ], $raw);
            Response::ok($data);
            break;

        case 'legacy_map_load_hybrid':
            $data = LegacyMapEditor::loadHybrid([
                'floor' => (string) $req->get('floor', ''),
                'embed' => $req->get('embed', false),
            ]);
            Response::ok($data);
            break;

        case 'smart_update_sprites':
            // Wiki batch: patch customSprite on selected entities + queue multi-sheet job.
            requireWrite($req);
            $data = SmartUpdateSprites::run([
                'mode' => (string) $req->get('mode', hdl_default_mode_id()),
                'kind' => (string) $req->get('kind', ''),
                'genre' => (string) $req->get('genre', ''),
                'seed' => $req->get('seed', null),
                'model' => $req->get('model', null),
                'category' => $req->get('category', null),
                'dry_run' => (bool) $req->get('dry_run', false),
                'items' => $req->get('items', $req->get('ids', null)),
            ], $runner);
            Response::ok($data);
            break;

        default:
            Response::error('Unknown action: ' . $action, 404);
    }
} catch (InvalidArgumentException $e) {
    Response::error($e->getMessage(), 400);
} catch (RuntimeException $e) {
    // Concurrency / spawn failures
    $code = str_contains($e->getMessage(), 'already running') ? 409 : 500;
    Response::error($e->getMessage(), $code);
} catch (Throwable $e) {
    Response::error('Internal error: ' . $e->getMessage(), 500);
}

/**
 * @return never
 */
function handleScripts(): void
{
    $out = [];
    foreach (HDL_SCRIPTS as $id => $def) {
        $params = [];
        foreach ($def['params'] as $name => $rule) {
            $params[$name] = [
                'type' => $rule['type'] ?? 'string',
                'required' => !empty($rule['required']),
                'default' => $rule['default'] ?? null,
            ];
            if (($rule['type'] ?? '') === 'enum') {
                $params[$name]['values'] = $rule['values'] ?? [];
            }
            if (($rule['type'] ?? '') === 'int') {
                $params[$name]['min'] = $rule['min'] ?? null;
                $params[$name]['max'] = $rule['max'] ?? null;
            }
        }
        $out[] = [
            'id' => $id,
            'label' => $def['label'],
            'bin' => $def['bin'],
            'params' => $params,
        ];
    }
    Response::ok(['scripts' => $out]);
    exit;
}

function handleRun(Request $req, JobRunner $runner): void
{
    $input = $req->all();
    // Strip routing keys before validation unknown-key check
    unset($input['action']);
    $job = $runner->enqueue($input);
    Response::ok(['job' => $job], 202);
}

function handleStatus(Request $req, JobStore $store): void
{
    $id = Validator::assertJobId((string) $req->get('id', ''));
    $meta = $store->read($id);
    if ($meta === null) {
        Response::error('Job not found', 404);
        return;
    }
    $store->maybeReap($id, $meta);
    $meta = $store->read($id);
    if ($meta === null) {
        Response::error('Job not found', 404);
        return;
    }

    $offset = (int) $req->get('offset', 0);
    if ($offset < 0) {
        $offset = 0;
    }
    $log = $store->readLog($id, $offset);

    Response::ok([
        'job' => $store->publicMeta($meta),
        'log' => $log,
    ]);
}

function handleLog(Request $req, JobStore $store): void
{
    $id = Validator::assertJobId((string) $req->get('id', ''));
    if ($store->read($id) === null) {
        Response::error('Job not found', 404);
        return;
    }
    $offset = (int) $req->get('offset', 0);
    if ($offset < 0) {
        $offset = 0;
    }
    Response::ok([
        'id' => $id,
        'log' => $store->readLog($id, $offset),
    ]);
}

/**
 * Mutations require POST/PUT/PATCH/DELETE.
 */
function requireWrite(Request $req): void
{
    if (!$req->isWrite()) {
        throw new InvalidArgumentException('This action requires POST');
    }
}

/**
 * Accept multipart `file` (or raw staged path for tests), replace original, reprocess variants.
 *
 * @return array<string, mixed>
 */
function handleCreatureReplace(Request $req): array
{
    $genre = (string) $req->get('genre', '');
    $kind = (string) $req->get('kind', 'creatures');
    $id = (string) $req->get('id', '');
    $dryRun = (bool) $req->get('dry_run', false);

    $tmpPath = null;
    $cleanup = null;

    if (isset($_FILES['file']) && is_array($_FILES['file'])) {
        $upload = $_FILES['file'];
        $err = (int) ($upload['error'] ?? UPLOAD_ERR_NO_FILE);
        if ($err !== UPLOAD_ERR_OK) {
            throw new InvalidArgumentException(uploadErrorMessage($err));
        }
        $tmpName = (string) ($upload['tmp_name'] ?? '');
        if ($tmpName === '' || !is_uploaded_file($tmpName)) {
            throw new InvalidArgumentException('Invalid upload');
        }
        $size = (int) ($upload['size'] ?? 0);
        if ($size < 8 || $size > 25 * 1024 * 1024) {
            throw new InvalidArgumentException('Image size out of range (max 25 MB)');
        }

        $origName = (string) ($upload['name'] ?? 'upload.png');
        $ext = strtolower(pathinfo($origName, PATHINFO_EXTENSION));
        if (!in_array($ext, ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'], true)) {
            $ext = 'png';
        }

        $dest = tempnam(sys_get_temp_dir(), 'hdl_rep_');
        if ($dest === false) {
            throw new RuntimeException('Cannot stage upload');
        }
        // tempnam creates an empty file; move into a named extension for ImageMagick
        @unlink($dest);
        $staged = $dest . '.' . $ext;
        if (!move_uploaded_file($tmpName, $staged)) {
            throw new RuntimeException('Failed to store upload');
        }
        $tmpPath = $staged;
        $cleanup = $staged;
    } else {
        // Optional path-based replace (CLI/tests only; still constrained by assertUploadPath)
        $file = (string) $req->get('file', '');
        if ($file === '') {
            throw new InvalidArgumentException('Missing image file (multipart field "file")');
        }
        $tmpPath = $file;
    }

    try {
        return CreatureAssets::replace([
            'genre' => $genre,
            'kind' => $kind,
            'id' => $id,
            'file' => $tmpPath,
            'dry_run' => $dryRun,
        ]);
    } finally {
        if (is_string($cleanup) && $cleanup !== '' && is_file($cleanup)) {
            @unlink($cleanup);
        }
    }
}

function uploadErrorMessage(int $code): string
{
    return match ($code) {
        UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'Upload exceeds size limit',
        UPLOAD_ERR_PARTIAL => 'Upload incomplete',
        UPLOAD_ERR_NO_FILE => 'No file uploaded',
        UPLOAD_ERR_NO_TMP_DIR => 'Server temp directory missing',
        UPLOAD_ERR_CANT_WRITE => 'Server cannot write upload',
        UPLOAD_ERR_EXTENSION => 'Upload blocked by extension',
        default => 'Upload failed',
    };
}
