import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addTask, addDependency, addIoItem, addIssueItem, deleteTask, renameTask } from '../src/commands';
import { reconcileProject, ensureLevelView } from '../src/sync/reconcileProject';
import { uuid } from '../src/ids';
import { isMilestone } from '../src/milestone';
import type { Project, Core, Id, FlowTaskNode, FlowLevelView } from '../src/model/types';
import { emptyProject } from './helpers';

type Op = { kind: number; a: number; b: number; s: string };

function applyOp(p: Project, op: Op): Project {
  const ids = Object.keys(p.core.tasks);
  const pick = (k: number) => ids[k % Math.max(1, ids.length)];
  switch (op.kind % 8) {
    case 0:
      return addTask(p, { name: op.s || 'T', level: 'medium' }, uuid);
    case 1:
      return ids.length ? addDependency(p, pick(op.a)!, pick(op.b)!, uuid) : p;
    case 2:
      return ids.length ? addIoItem(p, pick(op.a)!, 'inputs', { name: op.s || 'io', kind: 'doc' }, uuid) : p;
    case 3:
      return ids.length ? addIssueItem(p, pick(op.a)!, { issue: op.s || 'x' }, uuid) : p;
    case 4:
      return ids.length ? deleteTask(p, pick(op.a)!) : p;
    case 5:
      return ids.length ? renameTask(p, pick(op.a)!, op.s || 'R') : p;
    case 6:
      return addTask(p, { name: op.s || 'MS', level: 'medium', kind: 'milestone' }, uuid);
    case 7: {
      // 階層 op: 大タスク 1 件と、その直下の中タスク 1 件を同時に作る（scoped view の対象を増やす）。
      const parentId = uuid();
      const childId = uuid();
      let next = addTask(p, { name: (op.s || 'H') + 'P', level: 'large', id: parentId }, uuid);
      next = addTask(next, { name: (op.s || 'H') + 'C', level: 'medium', parentId, id: childId }, uuid);
      return next;
    }
    default:
      return p;
  }
}

const opArb = fc.record({
  kind: fc.nat(7),
  a: fc.nat(99),
  b: fc.nat(99),
  s: fc.string({ maxLength: 4 }),
});

// core/reconcileFlow.ts の isUnderScope と同じ規則（祖先を任意深さまで辿る／循環ガード）。
// スコープ付きビューでの MS 可視性判定（対象工程がスコープ配下にあるか）を独立に検証するための複製。
function isUnderScope(core: Core, taskId: Id | undefined, scopeId: Id): boolean {
  let cur = taskId ? core.tasks[taskId]?.parentId : undefined;
  const seen = new Set<Id>();
  while (cur && !seen.has(cur)) {
    if (cur === scopeId) return true;
    seen.add(cur);
    cur = core.tasks[cur]?.parentId;
  }
  return false;
}

// reconcileFlow の対象タスク選定（v2 粒度非依存 MS 規則込み）を独立に再計算し、実際の view.nodes と
// 突き合わせる。all-scope(scopeParentId 未指定)・スコープ付きの両方で同じ式が成り立つ。
function expectedTargetIds(core: Core, level: 'medium', scopeParentId: Id | undefined): Set<Id> {
  const allScope = scopeParentId === undefined;
  const ids = Object.values(core.tasks)
    .filter((t) => {
      if (isMilestone(core, t.id)) {
        if (allScope) return true;
        if (t.level === level && t.parentId === scopeParentId) return true;
        return Object.values(core.dependencies).some(
          (d) => d.to === t.id && isUnderScope(core, d.from, scopeParentId!),
        );
      }
      return t.level === level && (allScope || t.parentId === scopeParentId);
    })
    .map((t) => t.id);
  return new Set(ids);
}

describe('プロパティテスト（ランダムなコマンド列で不変条件）', () => {
  it('対象タスク 1 件 ⇔ ノード 1 個 / ダングリングなし / 冪等（全スコープ + スコープ付きビュー）', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        let p = ensureLevelView(emptyProject(), 'medium');
        for (const op of ops) p = applyOp(p, op);

        // 階層 op（case 7）で大タスクができていれば、その 1 件をスコープにしたビューも用意する。
        const largeIds = Object.values(p.core.tasks)
          .filter((t) => t.level === 'large')
          .map((t) => t.id);
        const scopeId = largeIds.length ? largeIds[0] : undefined;
        if (scopeId) p = ensureLevelView(p, 'medium', scopeId);

        p = reconcileProject(p, uuid);

        const checkView = (view: FlowLevelView, scopeParentId: Id | undefined) => {
          const expected = expectedTargetIds(p.core, 'medium', scopeParentId);
          const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

          // 1 タスク ⇔ 1 ノード（重複なし・対象集合と一致）
          expect(taskNodes).toHaveLength(expected.size);
          const taskIds = new Set(taskNodes.map((n) => n.taskId));
          expect(taskIds.size).toBe(taskNodes.length);
          for (const id of taskIds) expect(expected.has(id)).toBe(true);

          // エッジの端点は必ず実在ノード
          for (const e of Object.values(view.edges)) {
            expect(view.nodes[e.source]).toBeDefined();
            expect(view.nodes[e.target]).toBeDefined();
          }
          // 課題ノードの対象は実在ノード
          for (const nd of Object.values(view.nodes)) {
            if (nd.kind === 'issue') expect(view.nodes[nd.targetNodeId]).toBeDefined();
          }
        };

        const allView = p.flow.byLevel.find(
          (v) => v.level === 'medium' && v.scopeParentId === undefined,
        )!;
        checkView(allView, undefined);
        if (scopeId) {
          const scopedView = p.flow.byLevel.find(
            (v) => v.level === 'medium' && v.scopeParentId === scopeId,
          )!;
          checkView(scopedView, scopeId);
        }

        // 冪等
        const again = reconcileProject(p, uuid);
        expect(again).toEqual(p);
        return true;
      }),
      { numRuns: 200 },
    );
  });
});
