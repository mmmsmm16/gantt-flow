import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addTask, addDependency, addIoItem, addIssueItem, deleteTask, renameTask } from '../src/commands';
import { reconcileProject, ensureLevelView } from '../src/sync/reconcileProject';
import { uuid } from '../src/ids';
import type { Project, FlowTaskNode } from '../src/model/types';
import { emptyProject } from './helpers';

type Op = { kind: number; a: number; b: number; s: string };

function applyOp(p: Project, op: Op): Project {
  const ids = Object.keys(p.core.tasks);
  const pick = (k: number) => ids[k % Math.max(1, ids.length)];
  switch (op.kind % 7) {
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
    default:
      return p;
  }
}

const opArb = fc.record({
  kind: fc.nat(6),
  a: fc.nat(99),
  b: fc.nat(99),
  s: fc.string({ maxLength: 4 }),
});

describe('プロパティテスト（ランダムなコマンド列で不変条件）', () => {
  it('対象タスク 1 件 ⇔ ノード 1 個 / ダングリングなし / 冪等', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        let p = ensureLevelView(emptyProject(), 'medium');
        for (const op of ops) p = applyOp(p, op);
        p = reconcileProject(p, uuid);

        const view = p.flow.byLevel[0]!;
        const mediumTasks = Object.values(p.core.tasks).filter(
          (t) => t.level === 'medium' && t.parentId === undefined,
        );
        const taskNodes = Object.values(view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

        // 1 タスク ⇔ 1 ノード
        expect(taskNodes).toHaveLength(mediumTasks.length);
        const taskIds = new Set(taskNodes.map((n) => n.taskId));
        expect(taskIds.size).toBe(taskNodes.length);

        // エッジの端点は必ず実在ノード
        for (const e of Object.values(view.edges)) {
          expect(view.nodes[e.source]).toBeDefined();
          expect(view.nodes[e.target]).toBeDefined();
        }
        // 課題ノードの対象は実在ノード
        for (const nd of Object.values(view.nodes)) {
          if (nd.kind === 'issue') expect(view.nodes[nd.targetNodeId]).toBeDefined();
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
