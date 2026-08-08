<?php
/**
 * Build a single JSON pack of mode presets for the browser.
 *
 * Hunt Simulator / Scenario Lab have no real filesystem. Instead of N static
 * fetches + client-side dep walking, PHP resolves:
 *   mode.json browser catalog
 *   → hunts / creatures / waypoints / populations / scenarios
 *   → Stage 11 layout deps (dungeons → pieces / populations / markers / biomes / art_sets)
 *
 * Kernel JS still owns layout *expand* (procedural RNG). This pack only ships
 * the raw JSON files so setPresetCache + expandHuntDefinition work offline.
 */

declare(strict_types=1);

namespace De;

final class BrowserPresetPack
{
    /** Schema version for clients. */
    public const PACK_VERSION = 1;

    /** Safe preset id (snake_case / kebab, max 80). */
    private const ID_RE = '/^[a-z][a-z0-9_-]{0,79}$/';

    /**
     * Top-level shared tables always included for a mode.
     *
     * @var list<string>
     */
    private const CORE_FILES = [
        'classes.json',
        'spells.json',
        'equipment.json',
        'strategies.json',
    ];

    /**
     * Build browser pack for one content mode.
     *
     * @return array{
     *   packVersion: int,
     *   modeId: string,
     *   mode: array<string, mixed>,
     *   files: array<string, mixed>,
     *   missing: list<string>,
     *   deps: array<string, list<string>>
     * }
     */
    public static function build(string $modeId): array
    {
        $modeId = self::assertModeId($modeId);
        $modeDir = hdl_presets_root() . '/' . $modeId;
        if (!is_dir($modeDir)) {
            throw new \InvalidArgumentException('Unknown content mode: ' . $modeId);
        }

        $modeRaw = self::readJsonFile($modeDir . '/mode.json');
        if ($modeRaw === null) {
            throw new \RuntimeException('Cannot read mode.json for ' . $modeId);
        }

        /** @var array<string, true> $wanted relative paths under mode dir */
        $wanted = [];
        /** @var array<string, list<string>> $deps */
        $deps = [
            'hunts' => [],
            'dungeons' => [],
            'pieces' => [],
            'populations' => [],
            'markers' => [],
            'biomes' => [],
            'art_sets' => [],
            'creatures' => [],
            'waypoints' => [],
            'scenarios' => [],
            'parties' => [],
            'player_profiles' => [],
        ];

        foreach (self::CORE_FILES as $core) {
            $wanted[$core] = true;
        }

        $browser = is_array($modeRaw['browser'] ?? null) ? $modeRaw['browser'] : [];
        $list = static function ($v): array {
            if (!is_array($v)) {
                return [];
            }
            $out = [];
            foreach ($v as $item) {
                if (is_string($item) && $item !== '' && self::isSafeId($item)) {
                    $out[] = $item;
                }
            }
            return $out;
        };

        foreach ($list($browser['creatures'] ?? []) as $id) {
            $wanted['creatures/' . $id . '.json'] = true;
            $deps['creatures'][] = $id;
        }
        foreach ($list($browser['waypoints'] ?? []) as $id) {
            $wanted['waypoints/' . $id . '.json'] = true;
            $deps['waypoints'][] = $id;
        }
        foreach ($list($browser['populations'] ?? []) as $id) {
            $wanted['populations/' . $id . '.json'] = true;
            $deps['populations'][] = $id;
        }
        foreach ($list($browser['scenarios'] ?? []) as $id) {
            $wanted['scenarios/' . $id . '.json'] = true;
            $deps['scenarios'][] = $id;
        }

        // Party + base profiles: always ship full folders (session party select).
        // Optional browser.parties / browser.playerProfiles restrict when set.
        $partyIds = $list($browser['parties'] ?? []);
        $profileIds = $list($browser['playerProfiles'] ?? []);
        if ($partyIds === []) {
            $partyIds = self::listFolderIds($modeDir . '/parties');
        }
        if ($profileIds === []) {
            $profileIds = self::listFolderIds($modeDir . '/player_profiles');
        }
        foreach ($partyIds as $id) {
            $wanted['parties/' . $id . '.json'] = true;
            $deps['parties'][] = $id;
        }
        foreach ($profileIds as $id) {
            $wanted['player_profiles/' . $id . '.json'] = true;
            $deps['player_profiles'][] = $id;
        }

        $huntIds = $list($browser['hunts'] ?? []);
        foreach ($huntIds as $id) {
            $wanted['hunts/' . $id . '.json'] = true;
            $deps['hunts'][] = $id;
        }

        // Pass 1: load hunts and collect layout refs.
        $pendingProfiles = [];
        $pendingPieces = [];
        $pendingPops = [];
        $pendingMarkers = [];
        $pendingBiomes = [];
        $pendingArtSets = [];

        foreach ($huntIds as $id) {
            $hunt = self::readJsonFile($modeDir . '/hunts/' . $id . '.json');
            if ($hunt === null) {
                continue;
            }
            self::collectRefs($hunt, $pendingProfiles, $pendingPieces, $pendingPops, $pendingMarkers, $pendingBiomes, $pendingArtSets);
        }

        // Pass 2: dungeon profiles (and their refs).
        $profileQueue = array_keys($pendingProfiles);
        $seenProfiles = [];
        while ($profileQueue !== []) {
            $pid = array_shift($profileQueue);
            if ($pid === null || isset($seenProfiles[$pid])) {
                continue;
            }
            $seenProfiles[$pid] = true;
            $rel = 'dungeons/' . $pid . '.json';
            $wanted[$rel] = true;
            $deps['dungeons'][] = $pid;
            $profile = self::readJsonFile($modeDir . '/' . $rel);
            if ($profile === null) {
                continue;
            }
            $beforeProfiles = $pendingProfiles;
            self::collectRefs($profile, $pendingProfiles, $pendingPieces, $pendingPops, $pendingMarkers, $pendingBiomes, $pendingArtSets);
            foreach (array_keys($pendingProfiles) as $next) {
                if (!isset($beforeProfiles[$next]) && !isset($seenProfiles[$next])) {
                    $profileQueue[] = $next;
                }
            }
        }

        // Pass 3: biome packs (may list more profiles + artSet).
        $biomeQueue = array_keys($pendingBiomes);
        $seenBiomes = [];
        while ($biomeQueue !== []) {
            $bid = array_shift($biomeQueue);
            if ($bid === null || isset($seenBiomes[$bid])) {
                continue;
            }
            $seenBiomes[$bid] = true;
            $rel = 'biomes/' . $bid . '.json';
            $wanted[$rel] = true;
            $deps['biomes'][] = $bid;
            $biome = self::readJsonFile($modeDir . '/' . $rel);
            if ($biome === null) {
                continue;
            }
            self::collectRefs($biome, $pendingProfiles, $pendingPieces, $pendingPops, $pendingMarkers, $pendingBiomes, $pendingArtSets);
            // Biome profiles not yet loaded.
            foreach (array_keys($pendingProfiles) as $pid) {
                if (!isset($seenProfiles[$pid])) {
                    $seenProfiles[$pid] = true;
                    $prel = 'dungeons/' . $pid . '.json';
                    $wanted[$prel] = true;
                    $deps['dungeons'][] = $pid;
                    $profile = self::readJsonFile($modeDir . '/' . $prel);
                    if ($profile !== null) {
                        self::collectRefs(
                            $profile,
                            $pendingProfiles,
                            $pendingPieces,
                            $pendingPops,
                            $pendingMarkers,
                            $pendingBiomes,
                            $pendingArtSets
                        );
                    }
                }
            }
            foreach (array_keys($pendingBiomes) as $next) {
                if (!isset($seenBiomes[$next])) {
                    $biomeQueue[] = $next;
                }
            }
        }

        foreach (array_keys($pendingPieces) as $id) {
            $wanted['pieces/' . $id . '.json'] = true;
            $deps['pieces'][] = $id;
        }
        foreach (array_keys($pendingPops) as $id) {
            $wanted['populations/' . $id . '.json'] = true;
            $deps['populations'][] = $id;
        }
        foreach (array_keys($pendingMarkers) as $id) {
            $wanted['markers/' . $id . '.json'] = true;
            $deps['markers'][] = $id;
        }
        // Stage 11.9 art sets (decorative tile packs)
        foreach (array_keys($pendingArtSets) as $id) {
            $wanted['art_sets/' . $id . '.json'] = true;
            $deps['art_sets'][] = $id;
        }

        // Unique dep lists.
        foreach ($deps as $k => $ids) {
            $deps[$k] = array_values(array_unique($ids));
            sort($deps[$k]);
        }

        /** @var array<string, mixed> $files */
        $files = [];
        /** @var list<string> $missing */
        $missing = [];

        $paths = array_keys($wanted);
        sort($paths);
        foreach ($paths as $rel) {
            if (!self::isSafeRel($rel)) {
                $missing[] = $rel;
                continue;
            }
            $full = $modeDir . '/' . $rel;
            $data = self::readJsonFile($full);
            if ($data === null) {
                $missing[] = $rel;
                continue;
            }
            $files[$rel] = $data;
        }

        return [
            'packVersion' => self::PACK_VERSION,
            'modeId' => $modeId,
            'mode' => $modeRaw,
            'files' => $files,
            'missing' => $missing,
            'deps' => $deps,
        ];
    }

    /**
     * List safe entity ids from a presets folder (*.json stems).
     *
     * @return list<string>
     */
    private static function listFolderIds(string $dir): array
    {
        if (!is_dir($dir)) {
            return [];
        }
        $out = [];
        $entries = scandir($dir);
        if (!is_array($entries)) {
            return [];
        }
        foreach ($entries as $file) {
            if (!is_string($file) || !str_ends_with($file, '.json')) {
                continue;
            }
            $id = substr($file, 0, -5);
            if ($id !== '' && self::isSafeId($id)) {
                $out[] = $id;
            }
        }
        sort($out);
        return $out;
    }

    /**
     * Collect Stage 11 pointer fields from a hunt / profile / biome JSON object.
     * Intentionally shallow field walk — must not reimplement generator expand.
     *
     * @param array<string, mixed> $obj
     * @param array<string, true> $profiles
     * @param array<string, true> $pieces
     * @param array<string, true> $pops
     * @param array<string, true> $markers
     * @param array<string, true> $biomes
     * @param array<string, true> $artSets Stage 11.9 decorative packs
     */
    private static function collectRefs(
        array $obj,
        array &$profiles,
        array &$pieces,
        array &$pops,
        array &$markers,
        array &$biomes,
        array &$artSets
    ): void {
        self::addId($pops, $obj['populationId'] ?? null);
        self::addId($markers, $obj['markersId'] ?? null);
        self::addId($pieces, $obj['piecePack'] ?? null);
        self::addId($biomes, $obj['biomeId'] ?? null);
        self::addId($biomes, $obj['biome'] ?? null);
        self::addId($artSets, $obj['artSet'] ?? null);
        self::addId($profiles, $obj['dungeonProfileId'] ?? null);
        self::addId($profiles, $obj['profileId'] ?? null);

        // Biome manifest: profiles.procedural / profiles.fixed
        if (isset($obj['profiles']) && is_array($obj['profiles'])) {
            foreach ($obj['profiles'] as $group) {
                if (is_string($group)) {
                    // Flat profiles: ["small_crawl", ...]
                    self::addId($profiles, $group);
                    continue;
                }
                if (!is_array($group)) {
                    continue;
                }
                foreach ($group as $pid) {
                    self::addId($profiles, $pid);
                }
            }
        }

        // Stage 11.8: biome.floors / layout.floors chain (profile + pack pointers)
        if (isset($obj['floors']) && is_array($obj['floors'])) {
            foreach ($obj['floors'] as $floor) {
                if (is_string($floor) || is_int($floor)) {
                    self::addId($profiles, (string) $floor);
                    continue;
                }
                if (!is_array($floor)) {
                    continue;
                }
                self::addId($profiles, $floor['profileId'] ?? null);
                self::addId($profiles, $floor['id'] ?? null);
                self::addId($pieces, $floor['piecePack'] ?? null);
                self::addId($pops, $floor['populationId'] ?? null);
                self::addId($markers, $floor['markersId'] ?? null);
                self::addId($biomes, $floor['biomeId'] ?? null);
                // Stage 11.9: artSet → presets/art_sets/<id>.json
                self::addId($artSets, $floor['artSet'] ?? null);
                if (isset($floor['profile']) && is_array($floor['profile'])) {
                    self::collectRefs(
                        $floor['profile'],
                        $profiles,
                        $pieces,
                        $pops,
                        $markers,
                        $biomes,
                        $artSets
                    );
                }
            }
        }

        if (isset($obj['layout']) && is_array($obj['layout'])) {
            $layout = $obj['layout'];
            self::addId($profiles, $layout['profileId'] ?? null);
            self::addId($profiles, $layout['id'] ?? null);
            self::addId($pieces, $layout['piecePack'] ?? null);
            self::addId($biomes, $layout['biomeId'] ?? null);
            self::addId($biomes, $layout['biome'] ?? null);
            self::addId($artSets, $layout['artSet'] ?? null);
            self::addId($pops, $layout['populationId'] ?? null);
            self::addId($markers, $layout['markersId'] ?? null);
            if (isset($layout['profile']) && is_array($layout['profile'])) {
                self::collectRefs(
                    $layout['profile'],
                    $profiles,
                    $pieces,
                    $pops,
                    $markers,
                    $biomes,
                    $artSets
                );
            }
            // Nested layout.floors for multifloor hunts
            if (isset($layout['floors']) && is_array($layout['floors'])) {
                self::collectRefs(
                    ['floors' => $layout['floors']],
                    $profiles,
                    $pieces,
                    $pops,
                    $markers,
                    $biomes,
                    $artSets
                );
            }
            // Stage 11.10: layout.segments multi-biome macro chain
            if (isset($layout['segments']) && is_array($layout['segments'])) {
                foreach ($layout['segments'] as $seg) {
                    if (is_string($seg) || is_int($seg)) {
                        self::addId($biomes, (string) $seg);
                        continue;
                    }
                    if (!is_array($seg)) {
                        continue;
                    }
                    self::addId($biomes, $seg['biomeId'] ?? null);
                    self::addId($biomes, $seg['biome'] ?? null);
                    self::addId($artSets, $seg['artSet'] ?? null);
                    self::addId($pieces, $seg['piecePack'] ?? null);
                    self::addId($pops, $seg['populationId'] ?? null);
                    self::addId($markers, $seg['markersId'] ?? null);
                    self::addId($profiles, $seg['profileId'] ?? null);
                    if (isset($seg['floors']) && is_array($seg['floors'])) {
                        self::collectRefs(
                            ['floors' => $seg['floors']],
                            $profiles,
                            $pieces,
                            $pops,
                            $markers,
                            $biomes,
                            $artSets
                        );
                    }
                }
            }
            if (isset($layout['biomeIds']) && is_array($layout['biomeIds'])) {
                foreach ($layout['biomeIds'] as $bid) {
                    self::addId($biomes, is_string($bid) || is_int($bid) ? (string) $bid : null);
                }
            }
            // Nested layout.arenaLoop (rare; product usually puts arenaLoop on hunt)
            if (isset($layout['arenaLoop']) && is_array($layout['arenaLoop'])) {
                self::collectArenaLoopRefs(
                    $layout['arenaLoop'],
                    $profiles,
                    $pieces,
                    $artSets
                );
            }
        }

        // Arena ↔ rest chain: shells + optional packs + alternating art
        if (isset($obj['arenaLoop']) && is_array($obj['arenaLoop'])) {
            self::collectArenaLoopRefs(
                $obj['arenaLoop'],
                $profiles,
                $pieces,
                $artSets
            );
        }

        // layout.type arena_rest_chain with missing arenaLoop still needs defaults
        $layoutType = '';
        if (isset($obj['layout']) && is_array($obj['layout'])) {
            $layoutType = strtolower((string) ($obj['layout']['type'] ?? $obj['layout']['kind'] ?? ''));
        }
        if (
            ($layoutType === 'arena_rest_chain' || $layoutType === 'arena-rest-chain')
            && (!isset($obj['arenaLoop']) || !is_array($obj['arenaLoop']))
            && (!isset($obj['layout']['arenaLoop']) || !is_array($obj['layout']['arenaLoop']))
        ) {
            self::collectArenaLoopRefs([], $profiles, $pieces, $artSets);
        }
    }

    /**
     * Arena/rest shell profile + piece pack + artSet pointers.
     * Defaults match kernel normalizeArenaLoop (arena_combat_shell / rest_area_shell).
     *
     * @param array<string, mixed> $loop
     * @param array<string, true> $profiles
     * @param array<string, true> $pieces
     * @param array<string, true> $artSets
     */
    private static function collectArenaLoopRefs(
        array $loop,
        array &$profiles,
        array &$pieces,
        array &$artSets
    ): void {
        $arenaProfile = $loop['arenaProfileId'] ?? null;
        $restProfile = $loop['restProfileId'] ?? null;
        self::addId(
            $profiles,
            is_string($arenaProfile) && $arenaProfile !== ''
                ? $arenaProfile
                : 'arena_combat_shell'
        );
        self::addId(
            $profiles,
            is_string($restProfile) && $restProfile !== ''
                ? $restProfile
                : 'rest_area_shell'
        );
        self::addId($pieces, $loop['arenaPackId'] ?? null);
        self::addId($pieces, $loop['restPackId'] ?? null);
        self::addId($pieces, $loop['arenaPiecePack'] ?? null);
        self::addId($pieces, $loop['restPiecePack'] ?? null);
        self::addId($artSets, $loop['restArtSet'] ?? null);
        if (isset($loop['artSets']) && is_array($loop['artSets'])) {
            foreach ($loop['artSets'] as $aid) {
                self::addId($artSets, is_string($aid) || is_int($aid) ? (string) $aid : null);
            }
        }
    }

    /**
     * @param array<string, true> $bucket
     * @param mixed $id
     */
    private static function addId(array &$bucket, $id): void
    {
        if (!is_string($id) || $id === '' || !self::isSafeId($id)) {
            return;
        }
        $bucket[$id] = true;
    }

    private static function isSafeId(string $id): bool
    {
        return (bool) preg_match(self::ID_RE, $id);
    }

    /**
     * Relative path under mode presets: no .., only known subdirs / core files.
     */
    private static function isSafeRel(string $rel): bool
    {
        if ($rel === '' || str_contains($rel, '..') || str_starts_with($rel, '/')) {
            return false;
        }
        if (in_array($rel, self::CORE_FILES, true)) {
            return true;
        }
        if (!preg_match(
            '#^(hunts|creatures|waypoints|populations|scenarios|dungeons|pieces|markers|biomes|art_sets|parties|player_profiles)/[a-z][a-z0-9_-]{0,79}\.json$#',
            $rel
        )) {
            return false;
        }
        return true;
    }

    private static function assertModeId(string $modeId): string
    {
        return hdl_sanitize_mode_id($modeId);
    }

    /**
     * @return array<string, mixed>|null
     */
    private static function readJsonFile(string $path): ?array
    {
        if (!is_file($path)) {
            return null;
        }
        $raw = file_get_contents($path);
        if ($raw === false || $raw === '') {
            return null;
        }
        /** @var mixed $data */
        $data = json_decode($raw, true);
        return is_array($data) ? $data : null;
    }
}
