import { describe, it, expect } from 'vitest';
import { addTask, addDependency } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { deriveBands } from '../src/sync/bands';
import type { FlowTaskNode, FlowControlNode } from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName } from './helpers';

const taskNodes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

describe('bands（親範囲バンドの導出）', () => {
  it('小工程ビューで中・大の祖先バンドが出る', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'L', level: 'large' }, g);
    const lId = taskIdByName(p, 'L');
    p = addTask(p, { name: 'M', level: 'medium', parentId: lId }, g);
    const mId = taskIdByName(p, 'M');
    p = addTask(p, { name: 'S1', level: 'small', parentId: mId }, g);
    p = addTask(p, { name: 'S2', level: 'small', parentId: mId }, g);

    const res = reconcileFlow(p.core, p.details, emptyView('small', mId), n);
    expect(taskNodes(res.view)).toHaveLength(2);

    const bands = deriveBands(p.core, res.view);
    const mBand = bands.find((b) => b.taskId === mId)!;
    const lBand = bands.find((b) => b.taskId === lId)!;
    expect(mBand.depth).toBe(1);
    expect(mBand.label).toBe('M');
    expect(lBand.depth).toBe(2);
    expect(mBand.width).toBeGreaterThan(0);
  });
});

describe('ユーザー経路の尊重（A→判断→B なら直接 A→B を張らない）', () => {
  it('制御ノード経由の経路があれば導出エッジを足さない', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const aNode = taskNodes(r1.view).find((t) => t.taskId === taskIdByName(p, 'A'))!;
    const bNode = taskNodes(r1.view).find((t) => t.taskId === taskIdByName(p, 'B'))!;

    // 既存の導出エッジを消し、A→判断→B のユーザー経路を作る
    for (const e of Object.values(r1.view.edges)) delete r1.view.edges[e.id];
    const ctrl: FlowControlNode = { id: 'ctrl', kind: 'control', control: 'decision', x: 300, y: 40 };
    r1.view.nodes['ctrl'] = ctrl;
    r1.view.edges['e1'] = { id: 'e1', source: aNode.id, target: 'ctrl', pinned: true, role: 'flow' };
    r1.view.edges['e2'] = { id: 'e2', source: 'ctrl', target: bNode.id, pinned: true, role: 'flow' };

    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    // 直接 A→B の導出エッジは張られない
    const direct = Object.values(r2.view.edges).filter(
      (e) => e.source === aNode.id && e.target === bNode.id,
    );
    expect(direct).toHaveLength(0);
    // ユーザー経路は保持
    expect(r2.view.edges['e1']).toBeDefined();
    expect(r2.view.edges['e2']).toBeDefined();
  });

  it('線形 A→B→C に A→C を明示追加すると直接エッジを描く（推移的でも省略しない）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addTask(p, { name: 'C', level: 'medium' }, g);
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    const c = taskIdByName(p, 'C');
    p = addDependency(p, a, b, g);
    p = addDependency(p, b, c, g);
    p = addDependency(p, a, c, g); // 推移的だが明示的な前後関係
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const idOf = (taskId: string) => taskNodes(r.view).find((t) => t.taskId === taskId)!.id;
    const hasEdge = (s: string, t: string) =>
      Object.values(r.view.edges).some((e) => e.source === idOf(s) && e.target === idOf(t));
    expect(hasEdge(a, b)).toBe(true);
    expect(hasEdge(b, c)).toBe(true);
    expect(hasEdge(a, c)).toBe(true); // ← pinned 経路でない限り省略しない
  });
});
