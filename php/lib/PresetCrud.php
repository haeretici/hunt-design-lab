<?php
/**
 * Mode-scoped preset CRUD for Designer UI.
 *
 * Phase 2–4: catalog documents, folder entities, nested piece packs,
 * soft refs (incl. hunts/scenarios), and optional kernel validate
 * (pieces / biomes / dungeons layout|stress). Hunts stay on Hunt Editor.
 */

declare(strict_types=1);

namespace De;

final class PresetCrud
{
    /** Entity id: snake_case, max 80 (same as HuntPresets / docs/21). */
    private const ID_RE = '/^[a-z][a-z0-9_]{0,79}$/';

    /** Default page size for large folder lists (legacy creatures ≈ 1600+). */
    private const DEFAULT_PAGE_SIZE = 100;

    private const MAX_PAGE_SIZE = 500;

    /**
     * Kind → storage config.
     * Catalog: path relative to presets/<mode>/, arrayKey for row list.
     * Folder: dir relative to presets/<mode>/, one JSON file per id.
     *
     * @var array<string, array{
     *   shape: string,
     *   path?: string,
     *   dir?: string,
     *   arrayKey?: string,
     *   label: string,
     *   group: string,
     *   paginate?: bool
     * }>
     */
    private const KINDS = [
        // Combat catalogs
        'spells' => [
            'shape' => 'catalog',
            'path' => 'spells.json',
            'arrayKey' => 'spells',
            'label' => 'Spells',
            'group' => 'combat',
        ],
        'classes' => [
            'shape' => 'catalog',
            'path' => 'classes.json',
            'arrayKey' => 'classes',
            'label' => 'Classes',
            'group' => 'combat',
        ],
        'equipment' => [
            'shape' => 'catalog',
            'path' => 'equipment.json',
            'arrayKey' => 'items',
            'label' => 'Equipment',
            'group' => 'combat',
        ],
        'strategies' => [
            'shape' => 'catalog',
            'path' => 'strategies.json',
            'arrayKey' => 'strategies',
            'label' => 'Strategies',
            'group' => 'combat',
        ],
        'creatures' => [
            'shape' => 'folder',
            'dir' => 'creatures',
            'label' => 'Creatures',
            'group' => 'combat',
            'paginate' => true,
        ],
        'player_profiles' => [
            'shape' => 'folder',
            'dir' => 'player_profiles',
            'label' => 'Base Profiles',
            'group' => 'combat',
        ],
        'parties' => [
            'shape' => 'folder',
            'dir' => 'parties',
            'label' => 'Parties',
            'group' => 'combat',
        ],
        // Dungeon generator folders
        'populations' => [
            'shape' => 'folder',
            'dir' => 'populations',
            'label' => 'Populations',
            'group' => 'dungeon',
        ],
        'markers' => [
            'shape' => 'folder',
            'dir' => 'markers',
            'label' => 'Markers',
            'group' => 'dungeon',
        ],
        'biomes' => [
            'shape' => 'folder',
            'dir' => 'biomes',
            'label' => 'Biomes',
            'group' => 'dungeon',
        ],
        'art_sets' => [
            'shape' => 'folder',
            'dir' => 'art_sets',
            'label' => 'Art sets',
            'group' => 'dungeon',
        ],
        'dungeons' => [
            'shape' => 'folder',
            'dir' => 'dungeons',
            'label' => 'Dungeons',
            'group' => 'dungeon',
        ],
        // Nested pack: one JSON file per pack id, body has pieces[]
        'pieces' => [
            'shape' => 'nested_pack',
            'dir' => 'pieces',
            'label' => 'Piece packs',
            'group' => 'dungeon',
        ],
    ];

    /**
     * @return list<array{id: string, label: string, shape: string, group: string}>
     */
    public static function listKinds(): array
    {
        $out = [];
        foreach (self::KINDS as $id => $cfg) {
            $out[] = [
                'id' => $id,
                'label' => $cfg['label'],
                'shape' => $cfg['shape'],
                'group' => $cfg['group'],
            ];
        }
        return $out;
    }

    /**
     * List entity rows for a kind.
     *
     * Optional $opts:
     * - q: filter id/label (case-insensitive substring)
     * - limit: page size (0/omit = all for small kinds; default page for paginate kinds)
     * - offset: skip N matching rows
     *
     * @param array{q?: string, limit?: int|null, offset?: int|null} $opts
     * @return array{
     *   mode: string,
     *   kind: string,
     *   shape: string,
     *   path: string,
     *   items: list<array{id: string, label: string, mtime: int|null}>,
     *   count: int,
     *   total: int,
     *   offset: int,
     *   limit: int|null
     * }
     */
    public static function list(string $modeId, string $kind, array $opts = []): array
    {
        $modeId = self::assertModeId($modeId);
        $cfg = self::assertKind($kind);
        $q = isset($opts['q']) ? strtolower(trim((string) $opts['q'])) : '';
        $offset = max(0, (int) ($opts['offset'] ?? 0));

        $limitOpt = $opts['limit'] ?? null;
        $defaultLimit = !empty($cfg['paginate']) ? self::DEFAULT_PAGE_SIZE : null;
        if ($limitOpt === null || $limitOpt === '') {
            $limit = $defaultLimit;
        } else {
            $limit = (int) $limitOpt;
            if ($limit <= 0) {
                $limit = null; // explicit "all"
            } else {
                $limit = min(self::MAX_PAGE_SIZE, $limit);
            }
        }

        if ($cfg['shape'] === 'catalog') {
            return self::listCatalog($modeId, $kind, $cfg, $q, $offset, $limit);
        }
        // folder + nested_pack share one-file-per-id listing
        return self::listFolder($modeId, $kind, $cfg, $q, $offset, $limit);
    }

    /**
     * Get one entity, or the whole catalog document when $entityId is empty (catalog only).
     *
     * @return array<string, mixed>
     */
    public static function get(string $modeId, string $kind, string $entityId = ''): array
    {
        $modeId = self::assertModeId($modeId);
        $cfg = self::assertKind($kind);

        if ($cfg['shape'] === 'catalog') {
            return self::getCatalog($modeId, $kind, $cfg, $entityId);
        }

        if ($entityId === '') {
            throw new \InvalidArgumentException(
                'Folder/nested kind requires an entity id (cannot load whole directory as document)'
            );
        }
        return self::getFolder($modeId, $kind, $cfg, $entityId);
    }

    /**
     * Create or update one entity.
     *
     * @param array<string, mixed> $opts mode, kind, id, entity, renameFrom?
     * @return array{mode: string, kind: string, id: string, created: bool, path: string, count?: int, shape: string}
     */
    public static function save(array $opts): array
    {
        $modeId = self::assertModeId((string) ($opts['mode'] ?? ''));
        $kind = (string) ($opts['kind'] ?? '');
        $cfg = self::assertKind($kind);
        $entityId = self::assertEntityId((string) ($opts['id'] ?? ''));
        $renameFrom = isset($opts['renameFrom']) && is_string($opts['renameFrom']) && $opts['renameFrom'] !== ''
            ? self::assertEntityId($opts['renameFrom'])
            : null;

        $raw = self::normalizeEntityBody($opts['entity'] ?? null, $entityId);

        if ($cfg['shape'] === 'catalog') {
            return self::saveCatalog($modeId, $kind, $cfg, $entityId, $raw, $renameFrom);
        }
        return self::saveFolder($modeId, $kind, $cfg, $entityId, $raw, $renameFrom);
    }

    /**
     * Remove one entity. Soft reference warnings are included when cheap to compute.
     *
     * @return array{
     *   mode: string,
     *   kind: string,
     *   id: string,
     *   deleted: bool,
     *   path: string,
     *   count?: int,
     *   shape: string,
     *   warnings: list<string>
     * }
     */
    public static function delete(string $modeId, string $kind, string $entityId): array
    {
        $modeId = self::assertModeId($modeId);
        $cfg = self::assertKind($kind);
        $entityId = self::assertEntityId($entityId);
        $warnings = self::findReferenceWarnings($modeId, $kind, $entityId);

        if ($cfg['shape'] === 'catalog') {
            $result = self::deleteCatalog($modeId, $kind, $cfg, $entityId);
        } else {
            $result = self::deleteFolder($modeId, $kind, $cfg, $entityId);
        }
        $result['warnings'] = $warnings;
        return $result;
    }

    /**
     * Soft reference scan (does not block delete). Cheap catalog + small-folder scans.
     *
     * @return array{mode: string, kind: string, id: string, warnings: list<string>, refs: list<array{kind: string, id: string, field: string}>}
     */
    public static function refs(string $modeId, string $kind, string $entityId): array
    {
        $modeId = self::assertModeId($modeId);
        self::assertKind($kind);
        $entityId = self::assertEntityId($entityId);
        $refs = self::collectReferences($modeId, $kind, $entityId);
        $warnings = [];
        foreach ($refs as $ref) {
            $warnings[] = sprintf(
                'Referenced by %s/%s (%s)',
                $ref['kind'],
                $ref['id'],
                $ref['field']
            );
        }
        return [
            'mode' => $modeId,
            'kind' => $kind,
            'id' => $entityId,
            'warnings' => $warnings,
            'refs' => $refs,
        ];
    }

    /**
     * Lightweight id list for relation selects.
     *
     * Optional $filterField + $filterValue narrow catalog rows by a field
     * (e.g. slot=helmet for equipment). Ignored for folder/nested kinds.
     *
     * @return array{mode: string, kind: string, ids: list<string>}
     */
    public static function ids(
        string $modeId,
        string $kind,
        string $filterField = '',
        string $filterValue = ''
    ): array {
        $modeId = self::assertModeId($modeId);
        $cfg = self::assertKind($kind);
        // Full id list for relation selects (no pagination).
        if ($cfg['shape'] === 'folder' || $cfg['shape'] === 'nested_pack') {
            $ids = self::listFolderStems($modeId, $cfg);
        } else {
            $list = self::list($modeId, $kind, ['limit' => 0, 'offset' => 0]);
            $ids = [];
            $doFilter = $filterField !== '' && $filterValue !== ''
                && $cfg['shape'] === 'catalog';
            if ($doFilter) {
                // Re-read catalog to match field values — list() only returns id/label.
                $doc = self::readCatalogDocument($modeId, $cfg);
                $rows = $doc[$cfg['arrayKey']] ?? [];
                foreach ($rows as $row) {
                    if (!is_array($row)) {
                        continue;
                    }
                    $rowId = isset($row['id']) && is_string($row['id'])
                        ? strtolower(trim($row['id'])) : '';
                    if ($rowId === '' || !preg_match(self::ID_RE, $rowId)) {
                        continue;
                    }
                    $val = $row[$filterField] ?? null;
                    if (is_string($val) && strtolower(trim($val)) === strtolower(trim($filterValue))) {
                        $ids[] = $rowId;
                    }
                }
            } else {
                foreach ($list['items'] as $item) {
                    $ids[] = $item['id'];
                }
            }
        }
        return [
            'mode' => $modeId,
            'kind' => $kind,
            'ids' => $ids,
        ];
    }

    /**
     * Blank entity for "New".
     *
     * @return array<string, mixed>
     */
    public static function blankTemplate(string $kind, string $id = 'new_item'): array
    {
        $cfg = self::assertKind($kind);
        $id = preg_match(self::ID_RE, strtolower(trim($id))) ? strtolower(trim($id)) : 'new_item';

        return match ($kind) {
            'spells' => [
                'id' => $id,
                'label' => $id,
                'kind' => 'spell',
                'element' => 'energy',
                'powerCurve' => 'magic_strike',
                'basePower' => 40,
                'range' => 4,
                'mana' => 20,
                'hitChance' => 100,
                'isMelee' => false,
                'moveLock' => 0.05,
                'cooldowns' => (object) [],
            ],
            'classes' => [
                'id' => $id,
                'label' => $id,
                'role' => 'melee',
                'defaultLevel' => 50,
                'baseHp' => 150,
                'baseMp' => 50,
                'hpPerLevel' => 15,
                'mpPerLevel' => 5,
                'baseSpeed' => 220,
                'skillKey' => 'melee',
                'weaponType' => 'melee',
                'skills' => [
                    'melee' => 50,
                    'distance' => 10,
                    'shielding' => 40,
                    'magic' => 10,
                ],
                'spells' => ['melee_auto'],
                'autoAttack' => 'melee_auto',
            ],
            'equipment' => [
                'id' => $id,
                'label' => $id,
                'slot' => 'rightHand',
                'category' => 'sword',
                'weaponType' => 'melee',
                'atk' => 10,
                'defense' => 0,
                'weight' => 1000,
            ],
            'strategies' => [
                'id' => $id,
                'label' => $id,
                'aggression' => 0.75,
                'engageRange' => 7,
                'keepDistance' => 1,
                'fleeHpPercent' => 0.15,
                'healHpPercent' => 0.35,
                'healSpellId' => 'heal_light',
                'monstersToEngage' => 1,
                'returnToRoute' => true,
                'spellPriority' => ['melee_auto'],
            ],
            'creatures' => [
                'id' => $id,
                'label' => $id,
                'hp' => 100,
                'hpMax' => 100,
                'speed' => 100,
                'level' => 20,
                'armor' => 0,
                'exp' => 10,
                'aggro' => true,
                'flags' => [
                    'targetDistance' => 1,
                    'runHealth' => 0,
                    'staticAttackChance' => 90,
                    'aggroRange' => 7,
                    'loseTargetDistance' => 12,
                ],
                'attacks' => [
                    [
                        'id' => 'melee_0',
                        'kind' => 'melee',
                        'intervalMs' => 2000,
                        'chance' => 100,
                        'range' => 1,
                        'element' => 'physical',
                        'min' => 0,
                        'max' => 10,
                    ],
                ],
            ],

            'player_profiles' => [
                'id' => $id,
                'label' => $id,
                'vocation' => 'guardian',
                'level' => 50,
                'promoted' => false,
                'skills' => [
                    'axe' => 13,
                    'club' => 13,
                    'distance' => 13,
                    'fishing' => 10,
                    'fist' => 10,
                    'magicLevel' => 0,
                    'shielding' => 10,
                    'sword' => 13,
                ],
                'stats' => [
                    'lifeLeech' => 0,
                    'manaLeech' => 0,
                    'critChance' => 5,
                    'critDamage' => 10,
                ],
                'equipment' => [
                    'head' => '',
                    'chest' => '',
                    'legs' => '',
                    'boots' => '',
                    'weapon' => '',
                    'shield' => '',
                    'amulet' => '',
                    'ring' => '',
                ],
                'strategyId' => 'guardian_aggro',
                'notes' => '',
            ],
            'parties' => [
                'id' => $id,
                'label' => $id,
                'members' => [
                    [
                        'profileId' => 'guardian_starter',
                        'name' => 'Guardian Leader',
                        'isLeader' => true,
                    ],
                ],
                'notes' => '',
            ],
            'populations' => [
                'id' => $id,
                'notes' => '',
                'defaultRespawn' => 0,
                'groups' => [
                    'normal' => [
                        'weight' => 100,
                        'creatureIds' => ['cave_rat'],
                        'packSize' => [1, 2],
                    ],
                ],
                'limits' => [
                    'totalPacks' => [2, 4],
                ],
            ],
            'markers' => [
                'id' => $id,
                'notes' => '',
                'pools' => [
                    'A' => [
                        'objectIds' => ['barrel'],
                        'spawnCount' => [0, 2],
                        'effect' => 'break',
                        'blocking' => false,
                    ],
                ],
            ],
            'biomes' => [
                'id' => $id,
                'label' => $id,
                'notes' => '',
                'piecePack' => 'cave_v1',
                'populationId' => 'cave_rats',
                'markersId' => 'cave_clickies',
                'artSet' => 'cave',
                'profiles' => [
                    'procedural' => [],
                    'fixed' => [],
                ],
            ],
            'art_sets' => [
                'id' => $id,
                'label' => $id,
                'notes' => '',
                'genre' => 'rpg_fantasy',
                'kind' => 'tiles',
                'roles' => [
                    'floor' => [],
                    'wall' => [],
                ],
            ],
            'dungeons' => [
                'id' => $id,
                'type' => 'procedural',
                'biome' => 'cave',
                'seeded' => true,
                'notes' => '',
                'piecePack' => 'cave_v1',
                'populationId' => 'cave_rats',
                'markersId' => 'cave_clickies',
                'floor' => 0,
                'maxAttempts' => 40,
                'maxPieces' => 28,
                'capOpenExits' => true,
                'connectorTags' => ['corridor'],
                'rules' => [
                    ['op' => 'AddHub', 'tags' => ['hub'], 'count' => 1],
                    ['op' => 'AddRoom', 'tags' => ['room'], 'count' => [2, 4]],
                    ['op' => 'AddCorridor', 'tags' => ['corridor'], 'count' => [1, 3]],
                    ['op' => 'AddExit', 'count' => 1],
                    [
                        'op' => 'SelectEvent',
                        'events' => ['champion_room', 'rest_well'],
                        'count' => [1, 2],
                    ],
                ],
                'pacingBudget' => [
                    'id' => $id . '_micro',
                    'micro' => [
                        'targetGapSec' => 20,
                        'minGapSec' => 0,
                        'warnGapSec' => 90,
                        'maxGapSec' => 180,
                    ],
                    'mid' => [
                        'minKills' => 0,
                        'maxKills' => 40,
                        'minChampions' => 0,
                        'maxChampions' => 12,
                    ],
                    'session' => [
                        'minTimeSec' => 0,
                        'maxTimeSec' => 300,
                        'minKillsPerMin' => 0,
                        'maxKillsPerMin' => 120,
                    ],
                ],
            ],
            'pieces' => [
                'id' => $id,
                'biome' => 'cave',
                'notes' => '',
                'pieces' => [
                    [
                        'id' => 'room_01',
                        'biome' => 'cave',
                        'size' => ['w' => 5, 'h' => 5],
                        'exits' => [
                            'N' => true,
                            'S' => true,
                            'E' => false,
                            'W' => false,
                        ],
                        'friction' => [
                            '##.##',
                            '#...#',
                            '#...#',
                            '#...#',
                            '##.##',
                        ],
                        'sockets' => [
                            'spawns' => [['x' => 2, 'y' => 2]],
                            'markers' => [],
                            'waypoints' => [
                                ['x' => 2, 'y' => 0],
                                ['x' => 2, 'y' => 4],
                            ],
                        ],
                        'tags' => ['room'],
                    ],
                ],
            ],
            default => ['id' => $id, 'label' => $id],
        };
    }

    /**
     * Optional engine validate via kernel (Node).
     * pieces/biomes: structural checks. dungeons: few-seed layout or bounded stress.
     * Does not run full 10k dungeon_test CI stress.
     *
     * @param string $level layout|stress
     * @return array{
     *   mode: string,
     *   kind: string,
     *   id: string,
     *   ok: bool,
     *   level: string,
     *   durationMs: int|null,
     *   errors: list<string>,
     *   warnings: list<string>,
     *   detail?: mixed
     * }
     */
    public static function validate(
        string $modeId,
        string $kind,
        string $entityId,
        string $level = 'layout'
    ): array {
        $modeId = self::assertModeId($modeId);
        self::assertKind($kind);
        $entityId = self::assertEntityId($entityId);
        $level = strtolower(trim($level));
        if ($level !== 'stress') {
            $level = 'layout';
        }

        // Ensure entity exists (throws if not).
        self::get($modeId, $kind, $entityId);

        $script = HDL_ROOT . '/bin/presets_validate.js';
        if (!is_file($script)) {
            throw new \RuntimeException('Validate script missing: bin/presets_validate.js');
        }

        $cmd = [
            HDL_NODE_BIN,
            $script,
            '--mode',
            $modeId,
            '--kind',
            $kind,
            '--id',
            $entityId,
            '--level',
            $level,
        ];

        // Hard wall so a hung Node process cannot freeze the PHP request.
        $timeoutSec = $level === 'stress' ? 90 : 30;
        $run = self::runNodeCapture($cmd, $timeoutSec);
        $stdout = $run['stdout'];
        $stderr = $run['stderr'];
        $code = $run['code'];
        $timedOut = $run['timedOut'];

        if ($timedOut) {
            return [
                'mode' => $modeId,
                'kind' => $kind,
                'id' => $entityId,
                'ok' => false,
                'level' => $level,
                'durationMs' => $timeoutSec * 1000,
                'errors' => [
                    'validate_timeout_after_' . $timeoutSec . 's (try layout level or run dungeon_test CLI)',
                ],
                'warnings' => [],
                'detail' => null,
            ];
        }

        $decoded = null;
        if (is_string($stdout) && $stdout !== '') {
            $decoded = json_decode($stdout, true);
        }
        if (!is_array($decoded)) {
            $msg = trim((string) $stderr);
            if ($msg === '') {
                $msg = 'Validate process returned invalid JSON (exit ' . $code . ')';
            }
            return [
                'mode' => $modeId,
                'kind' => $kind,
                'id' => $entityId,
                'ok' => false,
                'level' => $level,
                'durationMs' => null,
                'errors' => [$msg],
                'warnings' => [],
            ];
        }

        $durationMs = null;
        if (isset($decoded['durationMs']) && is_numeric($decoded['durationMs'])) {
            $durationMs = (int) round((float) $decoded['durationMs']);
        }

        return [
            'mode' => $modeId,
            'kind' => $kind,
            'id' => $entityId,
            'ok' => !empty($decoded['ok']),
            'level' => isset($decoded['level']) ? (string) $decoded['level'] : $level,
            'durationMs' => $durationMs,
            'errors' => isset($decoded['errors']) && is_array($decoded['errors'])
                ? array_values(array_map('strval', $decoded['errors']))
                : [],
            'warnings' => isset($decoded['warnings']) && is_array($decoded['warnings'])
                ? array_values(array_map('strval', $decoded['warnings']))
                : [],
            'detail' => $decoded['detail'] ?? null,
        ];
    }

    /**
     * Run node with argv array; kill process group if wall-clock timeout exceeded.
     *
     * @param list<string> $cmd
     * @return array{stdout: string, stderr: string, code: int, timedOut: bool}
     */
    private static function runNodeCapture(array $cmd, int $timeoutSec): array
    {
        $desc = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $proc = proc_open(
            $cmd,
            $desc,
            $pipes,
            HDL_ROOT,
            null,
            ['bypass_shell' => true]
        );
        if (!is_resource($proc)) {
            throw new \RuntimeException('Failed to start node validate process');
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $timedOut = false;
        $deadline = microtime(true) + max(1, $timeoutSec);

        while (true) {
            $status = proc_get_status($proc);
            $read = [$pipes[1], $pipes[2]];
            $write = null;
            $except = null;
            // Short select so we can enforce wall clock.
            @stream_select($read, $write, $except, 0, 200000);
            foreach ($read as $stream) {
                $chunk = stream_get_contents($stream);
                if ($chunk === false || $chunk === '') {
                    continue;
                }
                if ($stream === $pipes[1]) {
                    $stdout .= $chunk;
                } else {
                    $stderr .= $chunk;
                }
            }
            if (!$status['running']) {
                break;
            }
            if (microtime(true) >= $deadline) {
                $timedOut = true;
                // Best-effort terminate.
                @proc_terminate($proc, 15);
                usleep(100000);
                $status = proc_get_status($proc);
                if ($status['running']) {
                    @proc_terminate($proc, 9);
                }
                break;
            }
        }

        // Drain remaining buffered output.
        $restOut = stream_get_contents($pipes[1]);
        $restErr = stream_get_contents($pipes[2]);
        if (is_string($restOut) && $restOut !== '') {
            $stdout .= $restOut;
        }
        if (is_string($restErr) && $restErr !== '') {
            $stderr .= $restErr;
        }
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);

        return [
            'stdout' => $stdout,
            'stderr' => $stderr,
            'code' => (int) $code,
            'timedOut' => $timedOut,
        ];
    }

    // ── Catalog adapters ──────────────────────────────────────────────────

    /**
     * @param array{shape: string, path: string, arrayKey: string, label: string} $cfg
     * @return array<string, mixed>
     */
    private static function listCatalog(
        string $modeId,
        string $kind,
        array $cfg,
        string $q,
        int $offset,
        ?int $limit
    ): array {
        $path = self::catalogPath($modeId, $cfg);
        $mtime = is_file($path) ? filemtime($path) : null;
        $doc = self::readCatalogDocument($modeId, $cfg);
        $rows = $doc[$cfg['arrayKey']];
        $items = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $id = isset($row['id']) && is_string($row['id']) ? strtolower(trim($row['id'])) : '';
            if ($id === '' || !preg_match(self::ID_RE, $id)) {
                continue;
            }
            $label = isset($row['label']) && is_string($row['label']) && trim($row['label']) !== ''
                ? $row['label']
                : $id;
            if ($q !== '') {
                $hay = strtolower($id . ' ' . $label);
                if (!str_contains($hay, $q)) {
                    continue;
                }
            }
            $items[] = [
                'id' => $id,
                'label' => $label,
                'mtime' => $mtime ?: null,
            ];
        }
        usort($items, static fn (array $a, array $b): int => strcmp($a['id'], $b['id']));
        $total = count($items);
        if ($offset > 0 || $limit !== null) {
            $items = array_slice($items, $offset, $limit);
        }

        return [
            'mode' => $modeId,
            'kind' => $kind,
            'shape' => $cfg['shape'],
            'path' => self::relPath($path),
            'items' => array_values($items),
            'count' => count($items),
            'total' => $total,
            'offset' => $offset,
            'limit' => $limit,
        ];
    }

    /**
     * @param array{shape: string, path: string, arrayKey: string} $cfg
     * @return array<string, mixed>
     */
    private static function getCatalog(string $modeId, string $kind, array $cfg, string $entityId): array
    {
        $path = self::catalogPath($modeId, $cfg);
        $doc = self::readCatalogDocument($modeId, $cfg);

        if ($entityId === '') {
            return [
                'mode' => $modeId,
                'kind' => $kind,
                'shape' => $cfg['shape'],
                'path' => self::relPath($path),
                'document' => $doc,
            ];
        }

        $id = self::assertEntityId($entityId);
        $index = self::findRowIndex($doc[$cfg['arrayKey']], $id);
        if ($index < 0) {
            throw new \InvalidArgumentException(
                ucfirst($kind) . ' not found: ' . $id
            );
        }
        $entity = $doc[$cfg['arrayKey']][$index];
        if (!is_array($entity)) {
            throw new \RuntimeException('Corrupt catalog row: ' . $id);
        }

        return [
            'mode' => $modeId,
            'kind' => $kind,
            'shape' => $cfg['shape'],
            'path' => self::relPath($path),
            'id' => $id,
            'index' => $index,
            'entity' => $entity,
        ];
    }

    /**
     * @param array{shape: string, path: string, arrayKey: string} $cfg
     * @param array<string, mixed> $raw
     * @return array{mode: string, kind: string, id: string, created: bool, path: string, count: int, shape: string}
     */
    private static function saveCatalog(
        string $modeId,
        string $kind,
        array $cfg,
        string $entityId,
        array $raw,
        ?string $renameFrom
    ): array {
        $path = self::catalogPath($modeId, $cfg);
        $doc = is_file($path)
            ? self::readCatalogDocument($modeId, $cfg)
            : self::emptyCatalogDocument($cfg);

        /** @var list<mixed> $rows */
        $rows = $doc[$cfg['arrayKey']];
        $created = true;

        if ($renameFrom !== null && $renameFrom !== $entityId) {
            $fromIdx = self::findRowIndex($rows, $renameFrom);
            $toIdx = self::findRowIndex($rows, $entityId);
            if ($toIdx >= 0) {
                throw new \InvalidArgumentException(
                    'Cannot rename: target id already exists: ' . $entityId
                );
            }
            if ($fromIdx >= 0) {
                $rows[$fromIdx] = $raw;
                $created = false;
            } else {
                $rows[] = $raw;
            }
        } else {
            $idx = self::findRowIndex($rows, $entityId);
            if ($idx >= 0) {
                $rows[$idx] = $raw;
                $created = false;
            } else {
                $rows[] = $raw;
            }
        }

        $doc[$cfg['arrayKey']] = array_values($rows);
        self::writeJsonFile($path, $doc);

        return [
            'mode' => $modeId,
            'kind' => $kind,
            'id' => $entityId,
            'created' => $created,
            'path' => self::relPath($path),
            'count' => count($doc[$cfg['arrayKey']]),
            'shape' => 'catalog',
        ];
    }

    /**
     * @param array{shape: string, path: string, arrayKey: string} $cfg
     * @return array{mode: string, kind: string, id: string, deleted: bool, path: string, count: int, shape: string}
     */
    private static function deleteCatalog(string $modeId, string $kind, array $cfg, string $entityId): array
    {
        $path = self::catalogPath($modeId, $cfg);
        $doc = self::readCatalogDocument($modeId, $cfg);
        $rows = $doc[$cfg['arrayKey']];
        $idx = self::findRowIndex($rows, $entityId);
        if ($idx < 0) {
            throw new \InvalidArgumentException(
                ucfirst($kind) . ' not found: ' . $entityId
            );
        }
        array_splice($rows, $idx, 1);
        $doc[$cfg['arrayKey']] = array_values($rows);
        self::writeJsonFile($path, $doc);

        return [
            'mode' => $modeId,
            'kind' => $kind,
            'id' => $entityId,
            'deleted' => true,
            'path' => self::relPath($path),
            'count' => count($doc[$cfg['arrayKey']]),
            'shape' => 'catalog',
        ];
    }

    // ── Folder adapters ───────────────────────────────────────────────────

    /**
     * @param array{shape: string, dir: string, label: string} $cfg
     * @return array<string, mixed>
     */
    private static function listFolder(
        string $modeId,
        string $kind,
        array $cfg,
        string $q,
        int $offset,
        ?int $limit
    ): array {
        $dir = self::folderDir($modeId, $cfg);
        $stems = self::listFolderStems($modeId, $cfg);

        if ($q !== '') {
            $stems = array_values(array_filter(
                $stems,
                static fn (string $id): bool => str_contains($id, $q)
            ));
        }

        $total = count($stems);
        if ($offset > 0 || $limit !== null) {
            $pageStems = array_slice($stems, $offset, $limit);
        } else {
            $pageStems = $stems;
        }

        $items = [];
        foreach ($pageStems as $id) {
            $path = $dir . '/' . $id . '.json';
            $mtime = is_file($path) ? filemtime($path) : null;
            $label = $id;
            /** @var array<string, mixed> extra summary fields for wiki / pickers */
            $summary = [];
            // Cheap label (+ combat summary for creatures) peek for the current page only.
            if (is_file($path) && filesize($path) < 512_000) {
                try {
                    $data = self::readJsonFile($path);
                    if (isset($data['label']) && is_string($data['label']) && trim($data['label']) !== '') {
                        $label = $data['label'];
                    } elseif ($kind === 'pieces' && isset($data['pieces']) && is_array($data['pieces'])) {
                        $n = count($data['pieces']);
                        $biome = isset($data['biome']) && is_string($data['biome'])
                            ? $data['biome']
                            : '';
                        $label = $biome !== ''
                            ? sprintf('%s · %d piece(s)', $biome, $n)
                            : sprintf('%d piece(s)', $n);
                    }
                    // Creature wiki cards: expose a few combat stats without a full get.
                    if ($kind === 'creatures' && is_array($data)) {
                        foreach ([
                            'hp',
                            'level',
                            'exp',
                            'armor',
                            'speed',
                            'race',
                            // Derived kit threat cache (npm run measure:threat -- --apply).
                            'threatDps',
                            'burstDps',
                            'avgHit',
                            'maxHit',
                            // Art override (catalog id / genre) for wiki thumbs.
                            'customSprite',
                            'customSpriteGenre',
                            'spriteId',
                        ] as $key) {
                            if (!array_key_exists($key, $data)) {
                                continue;
                            }
                            $val = $data[$key];
                            if (is_int($val) || is_float($val) || is_string($val) || is_bool($val)) {
                                $summary[$key] = $val;
                            }
                        }
                        // Nested bestiary.class → flat bestiaryClass for list filters.
                        if (
                            isset($data['bestiary'])
                            && is_array($data['bestiary'])
                            && isset($data['bestiary']['class'])
                            && is_string($data['bestiary']['class'])
                        ) {
                            $bc = trim($data['bestiary']['class']);
                            if ($bc !== '') {
                                $summary['bestiaryClass'] = $bc;
                            }
                        }
                    }
                } catch (\Throwable $e) {
                    // keep stem as label
                }
            }
            // Secondary filter by label when q is set (id already matched; also match label-only).
            if ($q !== '' && !str_contains($id, $q) && !str_contains(strtolower($label), $q)) {
                continue;
            }
            $items[] = array_merge(
                [
                    'id' => $id,
                    'label' => $label,
                    'mtime' => $mtime ?: null,
                ],
                $summary
            );
        }

        return [
            'mode' => $modeId,
            'kind' => $kind,
            'shape' => $cfg['shape'],
            'path' => self::relPath($dir),
            'items' => $items,
            'count' => count($items),
            'total' => $total,
            'offset' => $offset,
            'limit' => $limit,
        ];
    }

    /**
     * @param array{dir: string} $cfg
     * @return list<string>
     */
    private static function listFolderStems(string $modeId, array $cfg): array
    {
        $dir = self::folderDir($modeId, $cfg);
        if (!is_dir($dir)) {
            return [];
        }
        $files = scandir($dir);
        if ($files === false) {
            return [];
        }
        $ids = [];
        foreach ($files as $f) {
            if (!str_ends_with($f, '.json')) {
                continue;
            }
            $id = substr($f, 0, -5);
            if ($id === '' || !preg_match(self::ID_RE, $id)) {
                continue;
            }
            $ids[] = $id;
        }
        sort($ids, SORT_STRING);
        return $ids;
    }

    /**
     * @param array{shape: string, dir: string} $cfg
     * @return array<string, mixed>
     */
    private static function getFolder(string $modeId, string $kind, array $cfg, string $entityId): array
    {
        $id = self::assertEntityId($entityId);
        $path = self::folderPath($modeId, $cfg, $id);
        if (!is_file($path)) {
            throw new \InvalidArgumentException(
                ucfirst($kind) . ' not found: ' . $id
            );
        }
        $entity = self::readJsonFile($path);
        if (array_is_list($entity)) {
            throw new \RuntimeException('Corrupt folder entity (expected object): ' . $id);
        }

        return [
            'mode' => $modeId,
            'kind' => $kind,
            'shape' => $cfg['shape'],
            'path' => self::relPath($path),
            'id' => $id,
            'entity' => $entity,
        ];
    }

    /**
     * @param array{shape: string, dir: string} $cfg
     * @param array<string, mixed> $raw
     * @return array{mode: string, kind: string, id: string, created: bool, path: string, shape: string}
     */
    private static function saveFolder(
        string $modeId,
        string $kind,
        array $cfg,
        string $entityId,
        array $raw,
        ?string $renameFrom
    ): array {
        $dir = self::folderDir($modeId, $cfg);
        if (!is_dir($dir)) {
            if (!mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new \RuntimeException('Cannot create directory: ' . self::relPath($dir));
            }
        }

        $path = self::folderPath($modeId, $cfg, $entityId);
        $created = !is_file($path);

        if ($renameFrom !== null && $renameFrom !== $entityId) {
            $fromPath = self::folderPath($modeId, $cfg, $renameFrom);
            if (is_file($path)) {
                throw new \InvalidArgumentException(
                    'Cannot rename: target id already exists: ' . $entityId
                );
            }
            if (is_file($fromPath)) {
                // Write new then unlink old (atomic enough for local toolkit).
                self::writeJsonFile($path, $raw);
                if (!@unlink($fromPath)) {
                    throw new \RuntimeException('Wrote new id but failed to remove old file: ' . $renameFrom);
                }
                $created = false;
            } else {
                self::writeJsonFile($path, $raw);
            }
        } else {
            self::writeJsonFile($path, $raw);
            $created = $created; // already set
        }

        $shape = $cfg['shape'] === 'nested_pack' ? 'nested_pack' : 'folder';
        return [
            'mode' => $modeId,
            'kind' => $kind,
            'id' => $entityId,
            'created' => $created,
            'path' => self::relPath($path),
            'shape' => $shape,
        ];
    }

    /**
     * @param array{shape: string, dir: string} $cfg
     * @return array{mode: string, kind: string, id: string, deleted: bool, path: string, shape: string}
     */
    private static function deleteFolder(string $modeId, string $kind, array $cfg, string $entityId): array
    {
        $path = self::folderPath($modeId, $cfg, $entityId);
        if (!is_file($path)) {
            throw new \InvalidArgumentException(
                ucfirst($kind) . ' not found: ' . $entityId
            );
        }
        if (!@unlink($path)) {
            throw new \RuntimeException('Failed to delete: ' . self::relPath($path));
        }

        $shape = $cfg['shape'] === 'nested_pack' ? 'nested_pack' : 'folder';
        return [
            'mode' => $modeId,
            'kind' => $kind,
            'id' => $entityId,
            'deleted' => true,
            'path' => self::relPath($path),
            'shape' => $shape,
        ];
    }

    // ── Soft reference warnings ───────────────────────────────────────────

    /**
     * @return list<string>
     */
    private static function findReferenceWarnings(string $modeId, string $kind, string $entityId): array
    {
        $refs = self::collectReferences($modeId, $kind, $entityId);
        $warnings = [];
        foreach ($refs as $ref) {
            $warnings[] = sprintf(
                'Referenced by %s/%s (%s)',
                $ref['kind'],
                $ref['id'],
                $ref['field']
            );
        }
        return $warnings;
    }

    /**
     * Cross-file pointer scan (designer kinds + hunts/scenarios external dirs).
     * Caps folder walks to avoid multi-second deletes.
     *
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function collectReferences(string $modeId, string $kind, string $entityId): array
    {
        $refs = [];

        if ($kind === 'spells') {
            $refs = array_merge($refs, self::scanCatalogField($modeId, 'classes', 'spells', $entityId, true));
            $refs = array_merge($refs, self::scanCatalogField($modeId, 'classes', 'autoAttack', $entityId, false));
            $refs = array_merge($refs, self::scanCatalogField($modeId, 'strategies', 'spellPriority', $entityId, true));
            $refs = array_merge($refs, self::scanCatalogField($modeId, 'strategies', 'healSpellId', $entityId, false));
            // Creatures no longer reference spell autoAttack (kit is attacks[] only).
        }

        if ($kind === 'populations') {
            $refs = array_merge($refs, self::scanFolderField($modeId, 'biomes', 'populationId', $entityId, 200));
            $refs = array_merge($refs, self::scanFolderField($modeId, 'dungeons', 'populationId', $entityId, 200));
        }

        if ($kind === 'markers') {
            $refs = array_merge($refs, self::scanFolderField($modeId, 'biomes', 'markersId', $entityId, 200));
            $refs = array_merge($refs, self::scanFolderField($modeId, 'dungeons', 'markersId', $entityId, 200));
        }

        if ($kind === 'art_sets') {
            $refs = array_merge($refs, self::scanFolderField($modeId, 'biomes', 'artSet', $entityId, 200));
        }

        if ($kind === 'dungeons') {
            // biomes.profiles.procedural / fixed arrays
            $refs = array_merge($refs, self::scanBiomeProfileRefs($modeId, $entityId));
        }

        if ($kind === 'creatures') {
            $refs = array_merge($refs, self::scanPopulationCreatureRefs($modeId, $entityId));
        }

        if ($kind === 'player_profiles') {
            $refs = array_merge($refs, self::scanPartyProfileRefs($modeId, $entityId));
        }

        if ($kind === 'equipment') {
            // Loadouts live on base profiles (hunts no longer embed party gear).
            $refs = array_merge(
                $refs,
                self::scanPlayerProfileEquipmentRefs($modeId, $entityId)
            );
        }

        if ($kind === 'biomes') {
            $refs = array_merge($refs, self::scanFolderField($modeId, 'dungeons', 'biome', $entityId, 200));
        }

        if ($kind === 'pieces') {
            $refs = array_merge($refs, self::scanFolderField($modeId, 'biomes', 'piecePack', $entityId, 200));
            $refs = array_merge($refs, self::scanFolderField($modeId, 'dungeons', 'piecePack', $entityId, 200));
        }

        // External (non-CRUD) packs: hunts + scenarios often hold the real usage graph.
        $refs = array_merge($refs, self::scanHuntsAndScenarios($modeId, $kind, $entityId));

        return $refs;
    }

    /**
     * Scan presets/<mode>/hunts and scenarios for soft pointers.
     * Hunts remain Hunt-Editor owned; this only warns before designer deletes.
     *
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function scanHuntsAndScenarios(
        string $modeId,
        string $targetKind,
        string $entityId
    ): array {
        $out = [];
        $modeRoot = HDL_ROOT . '/presets/' . $modeId;

        // Hunts: rich graph of dungeon / pop / art / class / strategy / equipment.
        $huntsDir = $modeRoot . '/hunts';
        if (is_dir($huntsDir)) {
            $files = scandir($huntsDir) ?: [];
            $n = 0;
            foreach ($files as $file) {
                if ($n >= 300) {
                    break;
                }
                if (!str_ends_with($file, '.json')) {
                    continue;
                }
                $n += 1;
                $path = $huntsDir . '/' . $file;
                if (!is_file($path)) {
                    continue;
                }
                try {
                    $data = self::readJsonFile($path);
                } catch (\Throwable $e) {
                    continue;
                }
                $huntId = isset($data['id']) && is_string($data['id'])
                    ? strtolower(trim($data['id']))
                    : strtolower(basename($file, '.json'));
                $hits = self::matchHuntPointers($data, $targetKind, $entityId);
                foreach ($hits as $field) {
                    $out[] = ['kind' => 'hunts', 'id' => $huntId, 'field' => $field];
                }
            }
        }

        // Scenarios: baseHuntId mainly (plus optional overrides).
        $scenDir = $modeRoot . '/scenarios';
        if (is_dir($scenDir) && ($targetKind === 'hunts' || $targetKind === 'dungeons'
            || $targetKind === 'populations' || $targetKind === 'biomes'
            || $targetKind === 'art_sets' || $targetKind === 'pieces'
            || $targetKind === 'classes' || $targetKind === 'strategies'
            || $targetKind === 'equipment' || $targetKind === 'creatures')) {
            $files = scandir($scenDir) ?: [];
            $n = 0;
            foreach ($files as $file) {
                if ($n >= 200) {
                    break;
                }
                if (!str_ends_with($file, '.json')) {
                    continue;
                }
                $n += 1;
                $path = $scenDir . '/' . $file;
                if (!is_file($path)) {
                    continue;
                }
                try {
                    $data = self::readJsonFile($path);
                } catch (\Throwable $e) {
                    continue;
                }
                $scenId = isset($data['id']) && is_string($data['id'])
                    ? strtolower(trim($data['id']))
                    : strtolower(basename($file, '.json'));
                // Scenarios usually reference hunts by baseHuntId — only useful if we
                // ever expose hunts as designer kind. Still match overrides if present.
                $hits = self::matchHuntPointers($data, $targetKind, $entityId);
                if ($targetKind === 'hunts') {
                    $base = $data['baseHuntId'] ?? null;
                    if (is_string($base) && strtolower(trim($base)) === $entityId) {
                        $hits[] = 'baseHuntId';
                    }
                }
                foreach ($hits as $field) {
                    $out[] = ['kind' => 'scenarios', 'id' => $scenId, 'field' => $field];
                }
            }
        }

        return $out;
    }

    /**
     * Collect field paths inside a hunt-like JSON that point at $entityId of $targetKind.
     *
     * @param array<string, mixed> $data
     * @return list<string>
     */
    private static function matchHuntPointers(array $data, string $targetKind, string $entityId): array
    {
        $hits = [];
        $eq = static function ($v) use ($entityId): bool {
            return is_string($v) && strtolower(trim($v)) === $entityId;
        };

        if ($targetKind === 'populations' && $eq($data['populationId'] ?? null)) {
            $hits[] = 'populationId';
        }
        if ($targetKind === 'art_sets' && $eq($data['artSet'] ?? null)) {
            $hits[] = 'artSet';
        }
        if ($targetKind === 'pieces' && $eq($data['piecePack'] ?? null)) {
            $hits[] = 'piecePack';
        }
        if ($targetKind === 'biomes' && $eq($data['biome'] ?? null)) {
            $hits[] = 'biome';
        }
        if ($targetKind === 'biomes' && $eq($data['biomeId'] ?? null)) {
            $hits[] = 'biomeId';
        }
        if ($targetKind === 'markers' && $eq($data['markersId'] ?? null)) {
            $hits[] = 'markersId';
        }

        $layout = $data['layout'] ?? null;
        if (is_array($layout)) {
            if ($targetKind === 'dungeons' && $eq($layout['profileId'] ?? null)) {
                $hits[] = 'layout.profileId';
            }
            if ($targetKind === 'pieces' && $eq($layout['piecePack'] ?? null)) {
                $hits[] = 'layout.piecePack';
            }
            if ($targetKind === 'biomes' && $eq($layout['biomeId'] ?? null)) {
                $hits[] = 'layout.biomeId';
            }
            // multi_biome segments
            $segments = $layout['segments'] ?? null;
            if (is_array($segments)) {
                foreach ($segments as $si => $seg) {
                    if (!is_array($seg)) {
                        continue;
                    }
                    if ($targetKind === 'biomes' && $eq($seg['biomeId'] ?? null)) {
                        $hits[] = 'layout.segments[' . $si . '].biomeId';
                    }
                    $floors = $seg['floors'] ?? null;
                    if (is_array($floors) && $targetKind === 'dungeons') {
                        foreach ($floors as $fi => $floor) {
                            if (is_array($floor) && $eq($floor['profileId'] ?? null)) {
                                $hits[] = 'layout.segments[' . $si . '].floors[' . $fi . '].profileId';
                            }
                        }
                    }
                }
            }
        }

        // Party members: class / strategy / equipment
        $parties = $data['parties'] ?? null;
        if (is_array($parties)) {
            foreach ($parties as $pi => $party) {
                if (!is_array($party)) {
                    continue;
                }
                $members = $party['members'] ?? null;
                if (!is_array($members)) {
                    continue;
                }
                foreach ($members as $mi => $member) {
                    if (!is_array($member)) {
                        continue;
                    }
                    $prefix = 'parties[' . $pi . '].members[' . $mi . ']';
                    if ($targetKind === 'classes' && $eq($member['classId'] ?? null)) {
                        $hits[] = $prefix . '.classId';
                    }
                    if ($targetKind === 'strategies' && $eq($member['strategyId'] ?? null)) {
                        $hits[] = $prefix . '.strategyId';
                    }
                    if ($targetKind === 'creatures' && $eq($member['creatureId'] ?? null)) {
                        $hits[] = $prefix . '.creatureId';
                    }
                    if ($targetKind === 'equipment') {
                        $eqp = $member['equipment'] ?? null;
                        if (is_array($eqp)) {
                            foreach ($eqp as $slot => $itemId) {
                                if ($eq($itemId)) {
                                    $hits[] = $prefix . '.equipment.' . $slot;
                                }
                            }
                        }
                    }
                }
            }
        }

        return $hits;
    }

    /**
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function scanCatalogField(
        string $modeId,
        string $kind,
        string $field,
        string $needle,
        bool $isArray
    ): array {
        if (!isset(self::KINDS[$kind]) || self::KINDS[$kind]['shape'] !== 'catalog') {
            return [];
        }
        $cfg = self::KINDS[$kind];
        $path = self::catalogPath($modeId, $cfg);
        if (!is_file($path)) {
            return [];
        }
        try {
            $doc = self::readCatalogDocument($modeId, $cfg);
        } catch (\Throwable $e) {
            return [];
        }
        $out = [];
        foreach ($doc[$cfg['arrayKey']] as $row) {
            if (!is_array($row)) {
                continue;
            }
            $rowId = isset($row['id']) && is_string($row['id']) ? strtolower(trim($row['id'])) : '';
            if ($rowId === '') {
                continue;
            }
            $val = $row[$field] ?? null;
            $hit = false;
            if ($isArray && is_array($val)) {
                foreach ($val as $v) {
                    if (is_string($v) && strtolower(trim($v)) === $needle) {
                        $hit = true;
                        break;
                    }
                }
            } elseif (is_string($val) && strtolower(trim($val)) === $needle) {
                $hit = true;
            }
            if ($hit) {
                $out[] = ['kind' => $kind, 'id' => $rowId, 'field' => $field];
            }
        }
        return $out;
    }

    /**
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function scanFolderField(
        string $modeId,
        string $kind,
        string $field,
        string $needle,
        int $cap
    ): array {
        if (
            !isset(self::KINDS[$kind])
            || (
                self::KINDS[$kind]['shape'] !== 'folder'
                && self::KINDS[$kind]['shape'] !== 'nested_pack'
            )
        ) {
            return [];
        }
        $cfg = self::KINDS[$kind];
        $stems = self::listFolderStems($modeId, $cfg);
        $out = [];
        $n = 0;
        foreach ($stems as $id) {
            if ($n >= $cap) {
                break;
            }
            $n += 1;
            $path = self::folderPath($modeId, $cfg, $id);
            if (!is_file($path)) {
                continue;
            }
            try {
                $data = self::readJsonFile($path);
            } catch (\Throwable $e) {
                continue;
            }
            $val = $data[$field] ?? null;
            if (is_string($val) && strtolower(trim($val)) === $needle) {
                $out[] = ['kind' => $kind, 'id' => $id, 'field' => $field];
            }
        }
        return $out;
    }

    /**
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function scanBiomeProfileRefs(string $modeId, string $dungeonId): array
    {
        if (!isset(self::KINDS['biomes'])) {
            return [];
        }
        $cfg = self::KINDS['biomes'];
        $out = [];
        foreach (self::listFolderStems($modeId, $cfg) as $biomeId) {
            $path = self::folderPath($modeId, $cfg, $biomeId);
            if (!is_file($path)) {
                continue;
            }
            try {
                $data = self::readJsonFile($path);
            } catch (\Throwable $e) {
                continue;
            }
            $profiles = $data['profiles'] ?? null;
            if (!is_array($profiles)) {
                continue;
            }
            foreach (['procedural', 'fixed'] as $key) {
                $list = $profiles[$key] ?? null;
                if (!is_array($list)) {
                    continue;
                }
                foreach ($list as $pid) {
                    if (is_string($pid) && strtolower(trim($pid)) === $dungeonId) {
                        $out[] = [
                            'kind' => 'biomes',
                            'id' => $biomeId,
                            'field' => 'profiles.' . $key,
                        ];
                    }
                }
            }
            $floors = $data['floors'] ?? null;
            if (is_array($floors)) {
                foreach ($floors as $floor) {
                    if (!is_array($floor)) {
                        continue;
                    }
                    $pid = $floor['profileId'] ?? null;
                    if (is_string($pid) && strtolower(trim($pid)) === $dungeonId) {
                        $out[] = [
                            'kind' => 'biomes',
                            'id' => $biomeId,
                            'field' => 'floors.profileId',
                        ];
                    }
                }
            }
        }
        return $out;
    }

    /**
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function scanPopulationCreatureRefs(string $modeId, string $creatureId): array
    {
        if (!isset(self::KINDS['populations'])) {
            return [];
        }
        $cfg = self::KINDS['populations'];
        $out = [];
        foreach (self::listFolderStems($modeId, $cfg) as $popId) {
            $path = self::folderPath($modeId, $cfg, $popId);
            if (!is_file($path)) {
                continue;
            }
            try {
                $data = self::readJsonFile($path);
            } catch (\Throwable $e) {
                continue;
            }
            $groups = $data['groups'] ?? null;
            if (!is_array($groups)) {
                continue;
            }
            foreach ($groups as $gName => $group) {
                if (!is_array($group)) {
                    continue;
                }
                $ids = $group['creatureIds'] ?? null;
                if (!is_array($ids)) {
                    continue;
                }
                foreach ($ids as $cid) {
                    if (is_string($cid) && strtolower(trim($cid)) === $creatureId) {
                        $out[] = [
                            'kind' => 'populations',
                            'id' => $popId,
                            'field' => 'groups.' . $gName . '.creatureIds',
                        ];
                        break 2;
                    }
                }
            }
        }
        return $out;
    }

    /**
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function scanPartyProfileRefs(string $modeId, string $profileId): array
    {
        if (!isset(self::KINDS['parties'])) {
            return [];
        }
        $cfg = self::KINDS['parties'];
        $out = [];
        foreach (self::listFolderStems($modeId, $cfg) as $partyId) {
            $path = self::folderPath($modeId, $cfg, $partyId);
            if (!is_file($path)) {
                continue;
            }
            try {
                $data = self::readJsonFile($path);
            } catch (\Throwable $e) {
                continue;
            }
            $members = $data['members'] ?? null;
            if (!is_array($members)) {
                continue;
            }
            foreach ($members as $mi => $member) {
                if (!is_array($member)) {
                    continue;
                }
                $pid = $member['profileId'] ?? ($member['profile'] ?? null);
                if (is_string($pid) && strtolower(trim($pid)) === $profileId) {
                    $out[] = [
                        'kind' => 'parties',
                        'id' => $partyId,
                        'field' => 'members[' . $mi . '].profileId',
                    ];
                    break;
                }
            }
        }
        return $out;
    }

    /**
     * Equipment ids on base player profiles (designer slot names: weapon, head, …).
     *
     * @return list<array{kind: string, id: string, field: string}>
     */
    private static function scanPlayerProfileEquipmentRefs(
        string $modeId,
        string $itemId
    ): array {
        if (!isset(self::KINDS['player_profiles'])) {
            return [];
        }
        $cfg = self::KINDS['player_profiles'];
        $needle = strtolower(trim($itemId));
        if ($needle === '') {
            return [];
        }
        $out = [];
        $n = 0;
        foreach (self::listFolderStems($modeId, $cfg) as $profileId) {
            if ($n >= 300) {
                break;
            }
            $n += 1;
            $path = self::folderPath($modeId, $cfg, $profileId);
            if (!is_file($path)) {
                continue;
            }
            try {
                $data = self::readJsonFile($path);
            } catch (\Throwable $e) {
                continue;
            }
            $eqp = $data['equipment'] ?? null;
            if (!is_array($eqp)) {
                continue;
            }
            foreach ($eqp as $slot => $slotItemId) {
                if (!is_string($slotItemId) || $slotItemId === '') {
                    continue;
                }
                if (strtolower(trim($slotItemId)) === $needle) {
                    $out[] = [
                        'kind' => 'player_profiles',
                        'id' => $profileId,
                        'field' => 'equipment.' . $slot,
                    ];
                }
            }
        }
        return $out;
    }

    // ── Shared helpers ────────────────────────────────────────────────────

    /**
     * @return array{shape: string, path?: string, dir?: string, arrayKey?: string, label: string, group: string, paginate?: bool}
     */
    private static function assertKind(string $kind): array
    {
        $kind = strtolower(trim($kind));
        if ($kind === '' || !isset(self::KINDS[$kind])) {
            $allowed = implode(', ', array_keys(self::KINDS));
            throw new \InvalidArgumentException(
                'Unknown or unsupported kind (allowed: ' . $allowed . ')'
            );
        }
        return self::KINDS[$kind];
    }

    private static function assertModeId(string $modeId): string
    {
        return hdl_sanitize_mode_id($modeId);
    }

    private static function assertEntityId(string $id): string
    {
        $id = strtolower(trim($id));
        if ($id === '' || !preg_match(self::ID_RE, $id)) {
            throw new \InvalidArgumentException(
                'Invalid entity id (use snake_case, e.g. fire_wave)'
            );
        }
        if (str_contains($id, '..') || str_contains($id, '/') || str_contains($id, '\\')) {
            throw new \InvalidArgumentException('Invalid entity id');
        }
        return $id;
    }

    /**
     * @param mixed $raw
     * @return array<string, mixed>
     */
    private static function normalizeEntityBody(mixed $raw, string $entityId): array
    {
        if (is_string($raw)) {
            $decoded = json_decode($raw, true);
            if (!is_array($decoded)) {
                throw new \InvalidArgumentException('entity must be a JSON object');
            }
            $raw = $decoded;
        }
        if (!is_array($raw) || array_is_list($raw)) {
            throw new \InvalidArgumentException('entity must be a JSON object');
        }

        $raw['id'] = $entityId;
        // Piece packs use notes + pieces[]; populations/markers use groups/pools without labels.
        $isPiecePack = isset($raw['pieces']) && is_array($raw['pieces']);
        $isPopOrMarker = isset($raw['groups']) || isset($raw['pools']);
        if (
            !$isPiecePack
            && (!$isPopOrMarker || array_key_exists('label', $raw))
            && (!isset($raw['label']) || !is_string($raw['label']) || trim($raw['label']) === '')
        ) {
            $raw['label'] = $entityId;
        }
        return $raw;
    }

    /**
     * @param array{path: string} $cfg
     */
    private static function catalogPath(string $modeId, array $cfg): string
    {
        return hdl_presets_root() . '/' . $modeId . '/' . $cfg['path'];
    }

    /**
     * @param array{dir: string} $cfg
     */
    private static function folderDir(string $modeId, array $cfg): string
    {
        return hdl_presets_root() . '/' . $modeId . '/' . $cfg['dir'];
    }

    /**
     * @param array{dir: string} $cfg
     */
    private static function folderPath(string $modeId, array $cfg, string $id): string
    {
        return self::folderDir($modeId, $cfg) . '/' . $id . '.json';
    }

    /**
     * @param array{path: string, arrayKey: string} $cfg
     * @return array<string, mixed>
     */
    private static function readCatalogDocument(string $modeId, array $cfg): array
    {
        $path = self::catalogPath($modeId, $cfg);
        if (!is_file($path)) {
            throw new \InvalidArgumentException(
                'Catalog missing: ' . self::relPath($path)
            );
        }
        $data = self::readJsonFile($path);
        $key = $cfg['arrayKey'];
        if (!isset($data[$key]) || !is_array($data[$key]) || !array_is_list($data[$key])) {
            throw new \RuntimeException(
                'Invalid catalog document (expected list at .' . $key . '): ' . self::relPath($path)
            );
        }
        return $data;
    }

    /**
     * @param array{arrayKey: string} $cfg
     * @return array<string, mixed>
     */
    private static function emptyCatalogDocument(array $cfg): array
    {
        return [
            'version' => 2,
            'notes' => '',
            $cfg['arrayKey'] => [],
        ];
    }

    /**
     * @param list<mixed> $rows
     */
    private static function findRowIndex(array $rows, string $id): int
    {
        foreach ($rows as $i => $row) {
            if (!is_array($row)) {
                continue;
            }
            $rid = isset($row['id']) && is_string($row['id'])
                ? strtolower(trim($row['id']))
                : '';
            if ($rid === $id) {
                return (int) $i;
            }
        }
        return -1;
    }

    /**
     * @return array<string, mixed>
     */
    private static function readJsonFile(string $path): array
    {
        $raw = file_get_contents($path);
        if ($raw === false) {
            throw new \RuntimeException('Cannot read: ' . self::relPath($path));
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new \RuntimeException('Invalid JSON: ' . self::relPath($path));
        }
        return $data;
    }

    /**
     * @param array<string, mixed>|\stdClass $data
     */
    private static function writeJsonFile(string $path, array|\stdClass $data): void
    {
        try {
            JsonFile::write($path, $data);
        } catch (\RuntimeException $e) {
            throw new \RuntimeException(
                $e->getMessage() . ' (' . self::relPath($path) . ')',
                0,
                $e
            );
        }
    }

    private static function relPath(string $abs): string
    {
        $root = HDL_ROOT;
        if (str_starts_with($abs, $root . '/')) {
            return substr($abs, strlen($root) + 1);
        }
        return $abs;
    }
}
