---
name: add-migration
description: >-
  Add a schema-version migration to the gantt-flow persistence layer the safe way. Use this whenever
  the persisted data shape changes in packages/core/src/model (a new field that needs backfilling, a
  renamed/restructured field) and already-saved files must keep opening — e.g. "I added a field and
  need old .json files to still load", "bump the schema version", "add a migration", "change the
  saved format". Bumps CURRENT_SCHEMA_VERSION, adds a pure Migration, aligns the Zod schema + types,
  and adds fixture + no-op-on-current tests so user data is never silently corrupted or dropped.
---

# Add a persistence migration

gantt-flow is an offline, one-file-per-project app for confidential internal data. The worst thing
that can happen is silently corrupting or dropping someone's file. Migrations are how the format
evolves without that risk: each is a **pure** function that lifts an older `Project` shape to the
current one, applied **in memory on load** and only written back on an explicit save (so a read-only
copy on a shared drive opens safely). See `docs/05-persistence.md` §4 and `docs/08-testing.md` §3.

Use this skill when a change to `packages/core/src/model/types.ts` would make an existing saved file
fail to parse or load with wrong/missing data.

## The machinery (`packages/core/src/persistence/migrate.ts`)

```ts
export const CURRENT_SCHEMA_VERSION = 1;

export interface Migration {
  to: number;                                              // lifts data UP to this version
  up: (raw: Record<string, unknown>) => Record<string, unknown>;
}

export const migrations: Migration[] = [];                 // empty at v1; append here

// Applies every migration with `to > raw.schemaVersion`, in ascending order.
export function migrate(raw, list = migrations): Record<string, unknown> { … }
```

Load order is **migrate → Zod parse**: `migrate()` brings raw JSON up to the current shape, *then*
the Zod schema in `model/schema.ts` validates it. So a migration must produce data the *current*
schema accepts.

## Steps

### 1. Bump the version
Increment `CURRENT_SCHEMA_VERSION` by exactly 1 (e.g. `1` → `2`).

### 2. Append a pure migration
Add one entry to `migrations` whose `to` equals the new version. `up` must be **pure**: no I/O, no
`Date.now()`/random, no external state — only a deterministic transform of `raw`. Backfill new
fields with sensible defaults; rename/restructure as needed. Don't set `schemaVersion` inside `up`
(the `migrate` loop stamps it for you).

```ts
// Example: v2 introduces TaskDetail.effortMinutes (optional → no backfill needed),
// and renames a hypothetical `note` to `memo` (must be migrated).
export const migrations: Migration[] = [
  {
    to: 2,
    up: (raw) => {
      const details = (raw.details ?? {}) as Record<string, Record<string, unknown>>;
      for (const d of Object.values(details)) {
        if ('note' in d) { d.memo = d.note; delete d.note; }
      }
      return { ...raw, details };
    },
  },
];
```

### 3. Align types and the Zod schema
Update `packages/core/src/model/types.ts` (the TS shape) **and**
`packages/core/src/model/schema.ts` (the Zod parser) together so they agree with what `up` produces.
If a field is newly required, make sure the migration backfills it for old data — otherwise a
migrated old file will fail Zod validation. Prefer optional fields when you can; they avoid forcing a
backfill and keep older readers tolerant.

### 4. Add the tests (this is the point of the skill)
In `packages/core/test/persistence.test.ts`, add:

- **Fixture migration** — a literal object/JSON at the *old* version, run through `migrate()`, then
  asserted deep-equal to the expected current shape:
  ```ts
  it('migrates v1 → v2 (note → memo, schemaVersion stamped)', () => {
    const v1 = { schemaVersion: 1, /* …minimal old-shape Project… */ };
    const out = migrate(v1);
    expect(out.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(out).toEqual({ /* …expected current shape… */ });
  });
  ```
- **No-op on current** — a current-version file must pass through unchanged (idempotent):
  ```ts
  it('migrate() is a no-op on a current-version file', () => {
    const cur = { schemaVersion: CURRENT_SCHEMA_VERSION, /* …valid current Project… */ };
    expect(migrate(cur)).toEqual(cur);
  });
  ```
- If load/save is affected, also keep the **round-trip** assertion (`save`→`open` equals input
  except `meta.updatedAt`) green.

### 5. Verify
```
npm test -w @gantt-flow/core
npm run typecheck -w @gantt-flow/core
```

## Safety checklist

- [ ] `CURRENT_SCHEMA_VERSION` bumped by exactly 1; new `Migration.to` matches it.
- [ ] `up` is pure (no I/O, no `Date.now`/random) and doesn't set `schemaVersion` itself.
- [ ] `types.ts` and `schema.ts` agree with `up`'s output; newly-required fields are backfilled.
- [ ] Fixture test (old → current, deep-equal) **and** no-op-on-current test added and passing.
- [ ] Broken/unknown data still routes to `quarantine` rather than throwing (don't drop user data).

Migrations only ever move data **forward**. If a newer file is opened by an older build, that's
handled at load time (it opens read-only / warns), not here — never write a "down" migration.
