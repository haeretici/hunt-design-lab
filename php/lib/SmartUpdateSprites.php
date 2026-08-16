<?php
/**
 * Wiki batch action: set customSprite on combat entities, then queue
 * smart_update_sprites (multi 4×4 sheets).
 *
 * Short sheets are filled from library backlog (entities whose dedicated
 * sprite field is not yet equal to their id) instead of random name-gen
 * roster filler. Creatures/equipment use customSprite; spells use
 * customUISprite and generate into asset kind `ui` (category `spells`).
 * Empty selection is allowed: fill one full sheet (16) from that backlog.
 */

declare(strict_types=1);

namespace De;

final class SmartUpdateSprites
{
    private const SLOT = 16;

    private const MAX_ITEMS = 512;

    /**
     * Entity id (snake_case) → batch technical phrase (Title Case words).
     * Matches pipeline naming so cleanFileStem / idToFileStem agree on stems.
     * e.g. ashen_dwarf_priest → "Ashen Dwarf Priest"
     */
    public static function entityIdToTechnical(string $entityId): string
    {
        $id = strtolower(trim($entityId));
        $parts = preg_split('/[_\s-]+/', $id, -1, PREG_SPLIT_NO_EMPTY);
        if ($parts === false || $parts === []) {
            return $entityId;
        }
        $words = [];
        foreach ($parts as $p) {
            $words[] = ucfirst(strtolower($p));
        }
        return implode(' ', $words);
    }

    /**
     * Coerce a wiki/preset label into a job-safe roster alias.
     * Equipment labels commonly include parentheses ("Horn (Ring)"); strip only
     * characters the job validator rejects, then fall back to $fallback.
     */
    public static function safeRosterAlias(string $alias, string $fallback): string
    {
        $a = trim($alias);
        if ($a === '') {
            return $fallback;
        }
        if (strlen($a) > 128) {
            $a = substr($a, 0, 128);
            $a = rtrim($a);
        }
        // Same character class as Validator::ROSTER_LABEL_RE.
        if (preg_match(Validator::ROSTER_LABEL_RE, $a) === 1) {
            return $a;
        }
        $cleaned = preg_replace('/[^\w \'.\-()[\]:,&+\/!]/u', '', $a);
        if (!is_string($cleaned)) {
            return $fallback;
        }
        $cleaned = trim(preg_replace('/\s+/u', ' ', $cleaned) ?? '');
        if ($cleaned === '' || strlen($cleaned) > 128) {
            return $fallback;
        }
        return $cleaned;
    }

    /**
     * True when the entity does not yet own its dedicated sprite id.
     * Missing / empty customSprite counts as needing one (≠ id).
     */
    public static function needsOwnSprite(string $entityId, mixed $customSprite): bool
    {
        $id = strtolower(trim($entityId));
        if ($id === '') {
            return false;
        }
        if ($customSprite === null) {
            return true;
        }
        $cs = strtolower(trim((string) $customSprite));
        return $cs !== $id;
    }

    /**
     * @param array{
     *   mode?: string,
     *   kind?: string,
     *   genre?: string,
     *   seed?: int|null,
     *   model?: string|null,
     *   category?: string|null,
     *   dry_run?: bool,
     *   ids?: list<string>|mixed,
     *   items?: list<array{id?: string, alias?: string}>|mixed
     * } $input
     * @return array{
     *   mode: string,
     *   kind: string,
     *   genre: string,
     *   selected: int,
     *   backlog_filled: int,
     *   updated: list<array{id: string, customSprite: string, technical: string, source: string}>,
     *   batches: int,
     *   job: array<string, mixed>|null,
     *   dry_run: bool
     * }
     */
    public static function run(array $input, JobRunner $runner): array
    {
        $mode = isset($input['mode']) && is_string($input['mode']) && $input['mode'] !== ''
            ? $input['mode']
            : hdl_default_mode_id();
        $kind = isset($input['kind']) ? strtolower(trim((string) $input['kind'])) : '';
        if (!in_array($kind, ['creatures', 'equipment', 'spells'], true)) {
            throw new \InvalidArgumentException(
                'kind must be creatures, equipment or spells for smart update'
            );
        }

        $genre = isset($input['genre']) ? trim((string) $input['genre']) : '';
        if ($genre === '' || !in_array($genre, HDL_GENRES, true)) {
            throw new \InvalidArgumentException('Invalid or missing genre');
        }

        $dryRun = !empty($input['dry_run']);
        $seed = null;
        if (array_key_exists('seed', $input) && $input['seed'] !== null && $input['seed'] !== '') {
            if (!is_numeric($input['seed'])) {
                throw new \InvalidArgumentException('Invalid seed');
            }
            $seed = (int) $input['seed'];
            if ($seed < 0) {
                throw new \InvalidArgumentException('Invalid seed');
            }
        }

        $model = isset($input['model']) && is_string($input['model']) && $input['model'] !== ''
            ? $input['model']
            : 'Gemini 3.7 Flash (High)';
        if (!in_array($model, HDL_IMAGE_MODELS, true)) {
            throw new \InvalidArgumentException('Invalid model');
        }

        $category = null;
        if (isset($input['category']) && is_string($input['category']) && trim($input['category']) !== '') {
            $category = trim($input['category']);
            if (!in_array($category, HDL_ASSET_CATEGORIES, true)) {
                throw new \InvalidArgumentException('Invalid category');
            }
        }

        $selection = self::normalizeSelection($input);
        $selectedCount = count($selection);
        if ($selectedCount > self::MAX_ITEMS) {
            throw new \InvalidArgumentException('Too many items (max ' . self::MAX_ITEMS . ')');
        }

        // Round up to full 4×4 sheets; empty selection → one sheet from backlog.
        $targetCount = $selectedCount === 0
            ? self::SLOT
            : (int) (ceil($selectedCount / self::SLOT) * self::SLOT);
        $needFill = $targetCount - $selectedCount;

        /** @var array<string, true> $seen */
        $seen = [];
        foreach ($selection as $row) {
            $seen[$row['id']] = true;
        }

        $backlog = [];
        if ($needFill > 0) {
            $backlog = self::pickBacklog($mode, $kind, $category, $seen, $needFill);
        }

        if ($selectedCount === 0 && $backlog === []) {
            throw new \InvalidArgumentException(
                'No entities need a dedicated sprite (customSprite !== id)'
                    . ($category !== null ? " for category \"{$category}\"" : '')
            );
        }

        /** @var list<array{id: string, alias: string, source: string}> $work */
        $work = [];
        foreach ($selection as $row) {
            $work[] = [
                'id' => $row['id'],
                'alias' => $row['alias'],
                'source' => 'selected',
            ];
        }
        foreach ($backlog as $row) {
            $work[] = [
                'id' => $row['id'],
                'alias' => $row['alias'],
                'source' => 'backlog',
            ];
        }

        /** @var list<array{id: string, customSprite: string, technical: string, source: string}> $updated */
        $updated = [];
        /** @var list<array{technical: string, alias: string}> $roster */
        $roster = [];

        foreach ($work as $row) {
            $entityId = $row['id'];
            $technical = self::entityIdToTechnical($entityId);
            $alias = self::safeRosterAlias(
                $row['alias'] !== '' ? $row['alias'] : $technical,
                $technical
            );
            // Art id stored on the combat template = entity id (snake_case catalog id).
            $customSprite = $entityId;

            if (!$dryRun) {
                self::patchCustomSprite($mode, $kind, $entityId, $customSprite);
            }

            $updated[] = [
                'id' => $entityId,
                'customSprite' => $customSprite,
                'technical' => $technical,
                'source' => $row['source'],
            ];
            $roster[] = [
                'technical' => $technical,
                'alias' => $alias,
            ];
        }

        $batches = (int) max(1, (int) ceil(count($roster) / self::SLOT));
        $backlogFilled = count($backlog);

        $jobMeta = null;
        if (!$dryRun) {
            $jobKind = $kind === 'spells' ? 'ui' : $kind;
            $jobCategory = $kind === 'spells' ? 'spells' : $category;

            $jobInput = [
                'script' => 'smart_update_sprites',
                'genre' => $genre,
                'kind' => $jobKind,
                'model' => $model,
                'rows' => 4,
                'cols' => 4,
                'items' => $roster,
            ];
            if ($seed !== null) {
                $jobInput['seed'] = $seed;
            }
            if ($jobCategory !== null) {
                $jobInput['category'] = $jobCategory;
            }
            $jobMeta = $runner->enqueue($jobInput);
        }

        return [
            'mode' => $mode,
            'kind' => $kind,
            'genre' => $genre,
            'selected' => $selectedCount,
            'backlog_filled' => $backlogFilled,
            'updated' => $updated,
            'batches' => $batches,
            'job' => $jobMeta,
            'dry_run' => $dryRun,
        ];
    }

    /**
     * Library entities that still need a dedicated sprite, ordered level ASC
     * then id ASC. Skips ids already in $exclude.
     *
     * @param array<string, true> $exclude
     * @return list<array{id: string, alias: string}>
     */
    private static function pickBacklog(
        string $mode,
        string $kind,
        ?string $category,
        array $exclude,
        int $limit
    ): array {
        if ($limit <= 0) {
            return [];
        }

        /** @var list<array{id: string, alias: string, level: int}> $candidates */
        if ($kind === 'equipment') {
            $candidates = self::collectEquipmentBacklog($mode, $category, $exclude);
        } elseif ($kind === 'spells') {
            $candidates = self::collectSpellsBacklog($mode, $exclude);
        } else {
            $candidates = self::collectCreatureBacklog($mode, $exclude);
        }

        usort(
            $candidates,
            static function (array $a, array $b): int {
                if ($a['level'] !== $b['level']) {
                    return $a['level'] <=> $b['level'];
                }
                return strcmp($a['id'], $b['id']);
            }
        );

        $out = [];
        foreach ($candidates as $row) {
            $out[] = [
                'id' => $row['id'],
                'alias' => $row['alias'],
            ];
            if (count($out) >= $limit) {
                break;
            }
        }
        return $out;
    }

    /**
     * @param array<string, true> $exclude
     * @return list<array{id: string, alias: string, level: int}>
     */
    private static function collectCreatureBacklog(string $mode, array $exclude): array
    {
        // limit=0 → all folder entities (summary includes level + customSprite).
        $listed = PresetCrud::list($mode, 'creatures', ['limit' => 0]);
        $items = isset($listed['items']) && is_array($listed['items'])
            ? $listed['items']
            : [];

        $out = [];
        foreach ($items as $row) {
            if (!is_array($row)) {
                continue;
            }
            $id = isset($row['id']) ? strtolower(trim((string) $row['id'])) : '';
            if ($id === '' || isset($exclude[$id])) {
                continue;
            }
            $cs = $row['customSprite'] ?? null;
            if (!self::needsOwnSprite($id, $cs)) {
                continue;
            }
            $label = isset($row['label']) && is_string($row['label']) && trim($row['label']) !== ''
                ? trim($row['label'])
                : $id;
            $level = 0;
            if (isset($row['level']) && is_numeric($row['level'])) {
                $level = (int) $row['level'];
            }
            $out[] = [
                'id' => $id,
                'alias' => $label,
                'level' => $level,
            ];
        }
        return $out;
    }

    /**
     * @param array<string, true> $exclude
     * @return list<array{id: string, alias: string, level: int}>
     */
    private static function collectEquipmentBacklog(
        string $mode,
        ?string $category,
        array $exclude
    ): array {
        $rows = PresetCrud::catalogRows($mode, 'equipment');

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $id = isset($row['id']) ? strtolower(trim((string) $row['id'])) : '';
            if ($id === '' || isset($exclude[$id])) {
                continue;
            }
            if ($category !== null) {
                $rowCat = isset($row['category']) ? trim((string) $row['category']) : '';
                if ($rowCat !== $category) {
                    continue;
                }
            }
            $cs = $row['customSprite'] ?? null;
            if (!self::needsOwnSprite($id, $cs)) {
                continue;
            }
            $label = isset($row['label']) && is_string($row['label']) && trim($row['label']) !== ''
                ? trim($row['label'])
                : $id;
            $level = 0;
            if (isset($row['level']) && is_numeric($row['level'])) {
                $level = (int) $row['level'];
            }
            $out[] = [
                'id' => $id,
                'alias' => $label,
                'level' => $level,
            ];
        }
        return $out;
    }

    /**
     * @param array<string, true> $exclude
     * @return list<array{id: string, alias: string, level: int}>
     */
    private static function collectSpellsBacklog(string $mode, array $exclude): array
    {
        // spells.json uses arrayKey `spells`, not `items` (equipment).
        $rows = PresetCrud::catalogRows($mode, 'spells');

        $out = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $id = isset($row['id']) ? strtolower(trim((string) $row['id'])) : '';
            if ($id === '' || isset($exclude[$id])) {
                continue;
            }
            $cs = $row['customUISprite'] ?? null;
            if (!self::needsOwnSprite($id, $cs)) {
                continue;
            }
            $label = isset($row['label']) && is_string($row['label']) && trim($row['label']) !== ''
                ? trim($row['label'])
                : $id;
            $level = 0;
            if (isset($row['requiredLevel']) && is_numeric($row['requiredLevel'])) {
                $level = (int) $row['requiredLevel'];
            }
            $out[] = [
                'id' => $id,
                'alias' => $label,
                'level' => $level,
            ];
        }
        return $out;
    }

    /**
     * @param array<string, mixed> $input
     * @return list<array{id: string, alias: string}>
     */
    private static function normalizeSelection(array $input): array
    {
        $raw = $input['items'] ?? $input['ids'] ?? null;
        if ($raw === null) {
            return [];
        }
        if (is_string($raw)) {
            $decoded = json_decode($raw, true);
            $raw = is_array($decoded) ? $decoded : preg_split('/\s*,\s*/', $raw);
        }
        if (!is_array($raw)) {
            throw new \InvalidArgumentException('items must be an array');
        }

        $out = [];
        $seen = [];
        foreach ($raw as $i => $row) {
            if (is_string($row) || is_numeric($row)) {
                $row = ['id' => (string) $row];
            }
            if (!is_array($row)) {
                throw new \InvalidArgumentException("items[{$i}]: expected object or id string");
            }
            $id = isset($row['id'])
                ? strtolower(trim((string) $row['id']))
                : (isset($row['technical']) ? strtolower(trim((string) $row['technical'])) : '');
            if ($id === '' || !preg_match('/^[a-z][a-z0-9_]{0,63}$/', $id)) {
                throw new \InvalidArgumentException("items[{$i}]: invalid id");
            }
            if (isset($seen[$id])) {
                continue;
            }
            $seen[$id] = true;
            $alias = isset($row['alias'])
                ? trim((string) $row['alias'])
                : (isset($row['label']) ? trim((string) $row['label']) : $id);
            if ($alias === '') {
                $alias = $id;
            }
            $out[] = ['id' => $id, 'alias' => $alias];
        }
        return $out;
    }

    /**
     * Load entity, set customSprite, strip customSpriteGenre / customGenre, save.
     */
    private static function patchCustomSprite(
        string $mode,
        string $kind,
        string $entityId,
        string $customSprite
    ): void {
        $got = PresetCrud::get($mode, $kind, $entityId);
        $entity = isset($got['entity']) && is_array($got['entity'])
            ? $got['entity']
            : null;
        if ($entity === null) {
            throw new \InvalidArgumentException(
                ucfirst($kind) . ' not found: ' . $entityId
            );
        }

        $entity['id'] = $entityId;
        if ($kind === 'spells') {
            $entity['customUISprite'] = $customSprite;
        } else {
            $entity['customSprite'] = $customSprite;
            unset($entity['customSpriteGenre'], $entity['customGenre']);
        }

        PresetCrud::save([
            'mode' => $mode,
            'kind' => $kind,
            'id' => $entityId,
            'entity' => $entity,
        ]);
    }
}
