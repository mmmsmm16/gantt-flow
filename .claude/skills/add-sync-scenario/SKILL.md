---
name: add-sync-scenario
description: >-
  Scaffold a new golden (table-driven) test case for the gantt-flow sync engine (reconcileFlow)
  under packages/core/test/. Use this whenever you add or change reconcile/sync behavior and need
  a deterministic test — e.g. "add a test for what happens when a task's assignee changes", "cover
  the case where deleting a middle task rewires A→B", "write a golden test for I/O nodes", or any
  request to verify reconcileFlow's output. Follows the repo's counter()/emptyProject()/emptyView()
  pattern and asserts on res.view + res.report, including the idempotency invariant.
---

# Add a sync-engine golden test

The sync engine (`packages/core/src/sync/reconcileFlow.ts`) is the highest-risk part of this app —
`docs/08-testing.md` calls it 「最大のリスク」. It's a **pure, deterministic** function, which is
exactly why we pin its behavior with table-driven golden tests: build a `Project` with core commands,
run `reconcileFlow`, and assert on the resulting view and report. Injected ID generators make the
output byte-stable so assertions stay simple.

This skill scaffolds one such test the way the existing suite does it. The goal isn't ceremony — it's
that every new reconcile behavior gets a test that another engineer can read top-to-bottom and trust.

## The signature you're testing

```ts
reconcileFlow(core, details, view, idGen) => { view: FlowLevelView; report: SyncReport }
// SyncReport = { added: FlowNodeId[]; removed: FlowNodeId[] }
```

`reconcileFlow` reads `core` + `details` and rebuilds the given granularity/scope `view`. It never
mutates inputs. The `report` tells you which nodes it auto-added or removed (orphaned).

## The pattern

Mirror `packages/core/test/reconcile.test.ts`. The essential shape:

```ts
import { describe, it, expect } from 'vitest';
import { addTask, addAssignee, setAssignee, addDependency, deleteTask } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import type { FlowTaskNode } from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName, assigneeIdByName } from './helpers';

// Pull task nodes out of a view (the suite uses this helper inline).
const taskNodes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

it('<assignee changes> → <lane changes, position kept>', () => {
  const g = counter();      // ID stream for core commands (tasks, deps, assignees)
  const n = counter('n');   // SEPARATE ID stream for flow nodes/lanes
  let p = emptyProject();

  // 1. Arrange: build the project with commands (each returns a new Project).
  p = addAssignee(p, { name: '営業', kind: 'department' }, g);
  p = addTask(p, { name: 'A', level: 'medium', assigneeId: assigneeIdByName(p, '営業') }, g);

  // 2. Act: reconcile the target granularity/scope view.
  const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);

  // 3. Assert on res.view and res.report (see invariants below).
  expect(taskNodes(res.view)).toHaveLength(1);
  expect(res.report.added).toHaveLength(1);
});
```

### Why two `counter()` streams

`counter()` (in `test/helpers.ts`) returns a deterministic `IdGen` like `id-000, id-001, …`.
The suite uses one stream (`g`) for core command IDs and a second (`n = counter('n')`) for the
IDs `reconcileFlow` mints (nodes, lanes). Keeping them separate makes generated IDs readable and
stable (`n-000` is clearly a flow node) and avoids collisions. Always inject — never let production
UUIDs leak into a golden test, or the output stops being byte-stable.

### Helpers available (`test/helpers.ts`)

- `emptyProject()` → a blank `Project` (schemaVersion 1, empty core/details/flow).
- `emptyView(level = 'medium', scopeParentId?)` → a blank `FlowLevelView` to reconcile into.
- `taskIdByName(p, name)` / `assigneeIdByName(p, name)` → look up generated IDs by human name, so
  assertions read in domain terms instead of `id-003`.

### Commands available (`src/commands/index.ts`)

`addTask`, `renameTask`, `setTaskLevel`, `setAssignee`, `addAssignee`, `addDependency`,
`removeDependency`, `deleteTask`, `updateTaskDetail`, `addIoItem`/`removeIoItem`/`updateIoItem`,
`addIssueItem`/`removeIssueItem`/`updateIssueItem`. Commands take `(project, …args, idGen?)` and
return a new `Project` (they touch only `core`/`details`, never `flow`).

## Invariants worth asserting

Pick the ones your scenario exercises (full list in `docs/08-testing.md` §1-2). The most valuable:

- **1:1 task↔node** — one task node per in-scope task; out-of-scope/other-level tasks produce none.
- **Position stability** — after a *data-only* edit (rename, detail change), reconcile again against
  the previous view and assert a surviving node's `x`/`y` is unchanged. (To test this, hand-move a
  node — `res.view.nodes[id] = { ...node, x: 999, y: 888 }` — then reconcile and check it stuck.)
- **pinned survives** — a `pinned: true` edge is never removed even when its dependency is gone.
- **Idempotency** — almost always include this. Reconcile, then reconcile the result again with the
  *same* `idGen`, and assert nothing changed:

```ts
const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
const r2 = reconcileFlow(p.core, p.details, r1.view, n);
expect(r2.view).toEqual(r1.view);
expect(r2.report.added).toHaveLength(0);
expect(r2.report.removed).toHaveLength(0);
```

## Where to put the test

- Task nodes, lanes, edges, dependency rewiring → `packages/core/test/reconcile.test.ts`.
- I/O (`doc`) nodes and issue (`issue`) notes → `packages/core/test/reconcile-objects.test.ts`.
- A behavior that should hold for *all* random command sequences (an invariant, not one case) →
  consider a fast-check property in `packages/core/test/property.test.ts` instead of a single golden.

Add your `it(...)` inside the existing `describe` block; match the file's naming style (a short
Japanese phrase describing the scenario is the house style, e.g. `'担当変更 → レーンが変わり位置は保持'`).

## Verify

```
npm test -w @gantt-flow/core -- reconcile      # just the reconcile files
npm test -w @gantt-flow/core                   # whole core suite (golden + property + migration)
```

Write the assertion you expect to *fail first* if you're unsure of the engine's current behavior —
run it, read the actual `res.view`/`res.report`, and lock in the real (correct) values. A golden test
that was written to match a guess instead of verified behavior is worse than none.
