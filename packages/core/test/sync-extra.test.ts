import { describe, it, expect } from 'vitest';
import { addTask, addDependency, removeDependency } from '../src/commands';
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

describe('全体スコープ（中・scope未指定）= 全ての大を横断', () => {
  it('全大の中工程を表示し、大跨ぎの中依存も描く（冪等）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: '大A', level: 'large' }, g);
    p = addTask(p, { name: '大B', level: 'large' }, g);
    const A = taskIdByName(p, '大A');
    const B = taskIdByName(p, '大B');
    p = addTask(p, { name: '中a', level: 'medium', parentId: A }, g);
    p = addTask(p, { name: '中b', level: 'medium', parentId: B }, g);
    const a = taskIdByName(p, '中a');
    const b = taskIdByName(p, '中b');
    p = addDependency(p, a, b, g); // 大をまたぐ中→中 依存

    const r = reconcileFlow(p.core, p.details, emptyView('medium', undefined), n);
    const tnodes = taskNodes(r.view);
    expect(tnodes.map((t) => t.taskId).sort()).toEqual([a, b].sort()); // 両大の中が出る
    const idOf = (taskId: string) => tnodes.find((t) => t.taskId === taskId)!.id;
    expect(
      Object.values(r.view.edges).some((e) => e.source === idOf(a) && e.target === idOf(b)),
    ).toBe(true);

    const r2 = reconcileFlow(p.core, p.details, r.view, n);
    expect(r2.report.added).toHaveLength(0);
    expect(r2.report.removed).toHaveLength(0);
  });
});

describe('大またぎブリッジと直接依存の重複防止（同じ端点対に矢印は 1 本）', () => {
  // L1(m1→m2) → L2(m3→m4): ブリッジは m2→m3 に解決される
  function build() {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'L1', level: 'large' }, g);
    p = addTask(p, { name: 'L2', level: 'large' }, g);
    const l1 = taskIdByName(p, 'L1');
    const l2 = taskIdByName(p, 'L2');
    p = addTask(p, { name: 'm1', level: 'medium', parentId: l1 }, g);
    p = addTask(p, { name: 'm2', level: 'medium', parentId: l1 }, g);
    p = addTask(p, { name: 'm3', level: 'medium', parentId: l2 }, g);
    p = addTask(p, { name: 'm4', level: 'medium', parentId: l2 }, g);
    p = addDependency(p, taskIdByName(p, 'm1'), taskIdByName(p, 'm2'), g);
    p = addDependency(p, taskIdByName(p, 'm3'), taskIdByName(p, 'm4'), g);
    p = addDependency(p, l1, l2, g);
    return { p, g };
  }
  const edgesBetween = (
    v: ReturnType<typeof reconcileFlow>['view'],
    p: ReturnType<typeof emptyProject>,
    from: string,
    to: string,
  ) => {
    const idOf = (name: string) =>
      taskNodes(v).find((t) => t.taskId === taskIdByName(p, name))!.id;
    return Object.values(v.edges).filter((e) => e.source === idOf(from) && e.target === idOf(to));
  };
  const directDepId = (p: ReturnType<typeof emptyProject>) =>
    Object.values(p.core.dependencies).find(
      (d) => d.from === taskIdByName(p, 'm2') && d.to === taskIdByName(p, 'm3'),
    )!.id;

  it('直接依存 m2→m3 とブリッジが同じ端点対 → 直接依存のエッジ 1 本だけ描く', () => {
    const n = counter('n');
    let { p, g } = build();
    p = addDependency(p, taskIdByName(p, 'm2'), taskIdByName(p, 'm3'), g); // 大を跨ぐ直接依存

    const r = reconcileFlow(p.core, p.details, emptyView('medium', undefined), n);
    const dup = edgesBetween(r.view, p, 'm2', 'm3');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.derivedFromDependencyId).toBe(directDepId(p)); // 直接依存が勝つ

    const r2 = reconcileFlow(p.core, p.details, r.view, n);
    expect(r2.view).toEqual(r.view); // 冪等
  });

  it('ブリッジが先に存在 → 後から直接依存を足しても 1 本に収束する', () => {
    const n = counter('n');
    let { p, g } = build();
    const r1 = reconcileFlow(p.core, p.details, emptyView('medium', undefined), n);
    expect(edgesBetween(r1.view, p, 'm2', 'm3')).toHaveLength(1); // ブリッジのみ

    p = addDependency(p, taskIdByName(p, 'm2'), taskIdByName(p, 'm3'), g);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    const dup = edgesBetween(r2.view, p, 'm2', 'm3');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.derivedFromDependencyId).toBe(directDepId(p));

    // 直接依存を消せばブリッジが戻る
    const restored = reconcileFlow(
      removeDependency(p, directDepId(p)).core,
      p.details,
      r2.view,
      n,
    );
    expect(edgesBetween(restored.view, p, 'm2', 'm3')).toHaveLength(1);
  });
});
