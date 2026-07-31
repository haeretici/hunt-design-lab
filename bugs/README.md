# Bug reports

JSON reports written by **Report Bug** on Hunt Simulator and Scenario Lab.

## Reproduce

```bash
npm run bug:repro -- bugs/bug_YYYYMMDD_….json
# or stop at a tick (hunt only):
node bin/repro_bug.js --to-tick 400 bugs/bug_….json
```

`bug:repro` accepts **schemaVersion 1 and 2**. Only `repro` / party members drive the runner; diagnostic fields on `party` / `session` are ignored.

## Report shape

### Common (v1 + v2)

| Field | Purpose |
| :--- | :--- |
| `description` | User free text |
| `source` | `hunt` or `scenario` |
| `modeId` | Content pack |
| `seed` | Session RNG seed |
| `huntId` / `scenarioId` | Fixture |
| `partyId` | Party preset id (label; members may diverge if form was edited) |
| `party.members` | Enabled members: class, strategy, level, equipment; **v2+ also `profileId` / `skills` when present** |
| `session` | Live snapshot at report time (ticks, kills, state, …) |
| `scenarioSettings` | Scenario Lab Settings knobs (if any) |
| `repro` | Compact headless input mirror (`seed`, `partyId`, `members`, …) |

### schemaVersion 2 (current writers)

| Field | Purpose |
| :--- | :--- |
| `party.membersHaveSkills` | At least one member has a non-empty `skills` bag |
| `party.membersHaveProfileId` | At least one member has `profileId` |
| `party.allMembersHaveSkills` | Every enabled member has skills (expect true for stock profile parties) |
| `party.membersWithSkills` / `membersWithProfileId` / `memberCount` | Counts |
| `session.endReason` | Telemetry end reason (falls back to `session.state`) |
| `session.waves` | Structured arena waves (`phase`, `waveId`, `wavesCompleted`, `totalWaves`, …) or `null` |
| `session.waveHud` | Human wave line (unchanged) |
| `session.topSpells` | Top cast spell ids as `[id, count]` |
| `session.spellsCast` / `spellsCastByKind` | Aggregate cast pressure |
| `session.liveMembers` | Live HP / kills / topSpells per party member at report time |

**Triage tip:** `partyId: "balance_quartet"` with `membersHaveSkills: false` means the session did **not** use profile skills (class baselines) — compare headless `--party balance_quartet` carefully.

Do not commit private/local noise unless the report is needed as a shared fixture.
