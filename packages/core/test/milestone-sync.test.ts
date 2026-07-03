// マイルストーンの同期隔離（Task 3）。MS は「1 タスク ⇄ 1 タスクノード」の不変条件は保ちつつ、
// 導出エッジ・自動整列（tidy）・親範囲バンドからは不可視として扱う。counter 2 系統（g=コマンド／
// n=reconcile 発番）で決定論。
import { describe, it, expect } from 'vitest';
import { addTask, addAssignee, addDependency, removeDependency } from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { tidyFlowView } from '../src/sync/tidy';
import { deriveBands } from '../src/sync/bands';
import { SIZE } from '../src/sync/autoPlace';
import { LANE_DEFAULT_H } from '../src/sync/lanes';
import type { FlowTaskNode } from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName, assigneeIdByName } from './helpers';

const taskNodes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
const taskNodeOf = (v: ReturnType<typeof reconcileFlow>['view'], taskId: string) =>
  taskNodes(v).find((n) => n.taskId === taskId)!;

describe('マイルストーンの同期隔離', () => {
  it('① 工程→MS 依存は導出エッジ 0 本・MS ノードは存在・通常 A→B は従来どおり', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g); // 通常
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS'), g); // MS へ

    const res = reconcileFlow(p.core, p.details, emptyView(), n);

    // MS も含めて 1 タスク ⇄ 1 タスクノード（不変条件は維持）
    expect(taskNodes(res.view)).toHaveLength(3);
    expect(taskNodeOf(res.view, taskIdByName(p, 'MS'))).toBeDefined();

    // 導出エッジは A→B の 1 本のみ（A→MS は張られない）
    const edges = Object.values(res.view.edges);
    expect(edges).toHaveLength(1);
    const aId = taskNodeOf(res.view, taskIdByName(p, 'A')).id;
    const bId = taskNodeOf(res.view, taskIdByName(p, 'B')).id;
    expect(edges[0]!.source).toBe(aId);
    expect(edges[0]!.target).toBe(bId);
  });

  it('② MS を含む状態で冪等（2 回目は view 等値・added/removed 空）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS'), g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(r2.view).toEqual(r1.view);
    expect(r2.report.added).toHaveLength(0);
    expect(r2.report.removed).toHaveLength(0);
  });

  it('③ 未紐付け MS の手動 x（777）が reconcile 後も保持される', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const node = taskNodeOf(r1.view, taskIdByName(p, 'MS'));
    r1.view.nodes[node.id] = { ...node, x: 777 };

    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect((r2.view.nodes[node.id] as FlowTaskNode).x).toBe(777);
  });

  it('④ tidy: MS の x/y は不変・通常工程は整列・MS はレーン高さを膨らませない', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addAssignee(p, { name: '営業', kind: 'department' }, g);
    const eig = assigneeIdByName(p, '営業');
    p = addTask(p, { name: 'A', level: 'medium', assigneeId: eig }, g);
    p = addTask(p, { name: 'B', level: 'medium', assigneeId: eig }, g);
    p = addTask(p, { name: 'MS', level: 'medium', assigneeId: eig, kind: 'milestone' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS'), g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const msNode = taskNodeOf(r1.view, taskIdByName(p, 'MS'));
    r1.view.nodes[msNode.id] = { ...msNode, x: 777, y: 555 };

    const tidied = tidyFlowView(p.core, p.details, r1.view);

    // MS の手動位置は不変
    const msAfter = tidied.nodes[msNode.id] as FlowTaskNode;
    expect(msAfter.x).toBe(777);
    expect(msAfter.y).toBe(555);

    // 通常工程は段組みで整列（A=col0, B=col1）
    const aAfter = taskNodeOf(tidied, taskIdByName(p, 'A'));
    const bAfter = taskNodeOf(tidied, taskIdByName(p, 'B'));
    expect(aAfter.x).toBe(120);
    expect(bAfter.x).toBeGreaterThan(aAfter.x);

    // MS が同居しても営業レーンは既定高さのまま（MS が並行度に数えられない）
    const lane = Object.values(tidied.lanes).find((l) => l.assigneeId === eig)!;
    expect(lane.height).toBe(LANE_DEFAULT_H);
  });

  it('⑤ deriveBands: 右端に置いた MS は親バンド幅を広げない', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'medium' }, g);
    const pid = taskIdByName(p, 'P');
    p = addTask(p, { name: 'A', level: 'small', parentId: pid }, g);
    p = addTask(p, { name: 'MS', level: 'small', parentId: pid, kind: 'milestone' }, g);

    const r1 = reconcileFlow(p.core, p.details, emptyView('small', pid), n);
    const msNode = taskNodeOf(r1.view, taskIdByName(p, 'MS'));
    r1.view.nodes[msNode.id] = { ...msNode, x: 5000 }; // 遠く右へ

    const bands = deriveBands(p.core, r1.view);
    const pBand = bands.find((b) => b.taskId === pid)!;
    expect(pBand).toBeDefined();
    // A のみで幅が決まる（MS の x=5000 に引っ張られない）
    expect(pBand.width).toBeGreaterThanOrEqual(SIZE.task.w);
    expect(pBand.x + pBand.width).toBeLessThan(1000);
  });

  it('⑥ 自己修復: 通常工程が MS 化すると既存の導出エッジが撤去され以降は冪等', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);

    // 1 回目: B は通常工程 → A→B の導出エッジが張られる
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    expect(Object.values(r1.view.edges)).toHaveLength(1);

    // B を後から MS 化（kind はコマンドで不変なので直接書き換えて遷移を再現）
    p.core.tasks[taskIdByName(p, 'B')]!.kind = 'milestone';

    // 2 回目: 同じ view に対して再同期 → 既存の導出エッジが撤去される（自己修復）
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(Object.values(r2.view.edges)).toHaveLength(0);
    expect(taskNodes(r2.view)).toHaveLength(2); // ノードは 1:1 のまま残る

    // 3 回目: 撤去後は冪等（view 等値・added/removed 空）
    const r3 = reconcileFlow(p.core, p.details, r2.view, n);
    expect(r3.view).toEqual(r2.view);
    expect(r3.report.added).toHaveLength(0);
    expect(r3.report.removed).toHaveLength(0);
  });

  it('⑦ deriveParentBridges: 兄弟末尾が MS でも橋の端点は通常工程になる', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    // 親(大) P1→P2。P1 の子は [A, MS]（MS が並び順の末尾）、P2 の子は [C]。
    p = addTask(p, { name: 'P1', level: 'large' }, g);
    p = addTask(p, { name: 'P2', level: 'large' }, g);
    const p1 = taskIdByName(p, 'P1');
    const p2 = taskIdByName(p, 'P2');
    p = addTask(p, { name: 'A', level: 'medium', parentId: p1 }, g); // order 0
    p = addTask(p, { name: 'MS', level: 'medium', parentId: p1, kind: 'milestone' }, g); // order 1（末尾）
    p = addTask(p, { name: 'C', level: 'medium', parentId: p2 }, g);
    p = addDependency(p, p1, p2, g); // 親レベルの依存 → 子の大またぎブリッジを導出

    // 全体スコープ（中・scope 未指定）でブリッジを張る
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);

    const aNode = taskNodeOf(res.view, taskIdByName(p, 'A'));
    const cNode = taskNodeOf(res.view, taskIdByName(p, 'C'));
    const msNode = taskNodeOf(res.view, taskIdByName(p, 'MS'));

    // 橋は A→C の 1 本。末尾が MS でも端点は A（MS は端点候補から除外される）。
    const edges = Object.values(res.view.edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.source).toBe(aNode.id);
    expect(edges[0]!.target).toBe(cNode.id);
    // MS ノードに触れる導出エッジは無い
    expect(edges.some((e) => e.source === msNode.id || e.target === msNode.id)).toBe(false);
  });

  it('⑧ 手動 pinned エッジ（A→MS）は 2 回の再同期後も残り、以降は冪等', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);

    const res = reconcileFlow(p.core, p.details, emptyView(), n);
    const aNodeId = taskNodeOf(res.view, taskIdByName(p, 'A')).id;
    const msNodeId = taskNodeOf(res.view, taskIdByName(p, 'MS')).id;

    res.view.edges['user-e'] = {
      id: 'user-e',
      source: aNodeId,
      target: msNodeId,
      pinned: true,
      role: 'flow',
    };

    const r2 = reconcileFlow(p.core, p.details, res.view, n);
    expect(r2.view.edges['user-e']).toEqual(res.view.edges['user-e']);

    const r3 = reconcileFlow(p.core, p.details, r2.view, n);
    expect(r3.view.edges['user-e']).toEqual(res.view.edges['user-e']);
    expect(r3.view).toEqual(r2.view);
    expect(r3.report.added).toHaveLength(0);
    expect(r3.report.removed).toHaveLength(0);
  });
});

// v2: 粒度非依存化。マイルストーンは工程粒度に左右されず、全ビューに同じものが出る。
//   ・全スコープビュー(scopeParentId 未指定): level 不問で常に表示。
//   ・スコープ付きビュー: 対象工程(入依存 from)のいずれかがそのスコープ配下にあるときのみ表示。
//   ・未紐付け MS はスコープ付きビューには出さない（全スコープビューのみ）。
const hasTaskNode = (v: ReturnType<typeof reconcileFlow>['view'], taskId: string) =>
  taskNodes(v).some((n) => n.taskId === taskId);

describe('マイルストーンの粒度非依存化（v2）', () => {
  it('⑨ 中で作った MS は大・小の全スコープビューにもノードとして出る', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'large' }, g);
    const pid = taskIdByName(p, 'P');
    p = addTask(p, { name: 'A', level: 'medium', parentId: pid }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS'), g); // 対象工程 A

    const msId = taskIdByName(p, 'MS');
    const large = reconcileFlow(p.core, p.details, emptyView('large'), n);
    const small = reconcileFlow(p.core, p.details, emptyView('small'), n);

    // 粒度が違っても同じ MS がノードとして現れる（1:1 はビューごとに維持）
    expect(hasTaskNode(large.view, msId)).toBe(true);
    expect(hasTaskNode(small.view, msId)).toBe(true);
    // MS に触れる導出エッジは張られない（節目マーカー）
    expect(Object.values(large.view.edges)).toHaveLength(0);
  });

  it('⑩ スコープ付きビューは対象工程が配下にある時だけ MS を出す', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'P1', level: 'large' }, g);
    p = addTask(p, { name: 'P2', level: 'large' }, g);
    const p1 = taskIdByName(p, 'P1');
    const p2 = taskIdByName(p, 'P2');
    p = addTask(p, { name: 'A', level: 'medium', parentId: p1 }, g); // 対象工程は P1 配下
    p = addTask(p, { name: 'B', level: 'medium', parentId: p2 }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g); // 未親付け（構造で紐付かない）
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS'), g);

    const msId = taskIdByName(p, 'MS');
    const inScope = reconcileFlow(p.core, p.details, emptyView('medium', p1), n);
    const outScope = reconcileFlow(p.core, p.details, emptyView('medium', p2), n);

    // 対象工程 A が配下にある P1 スコープには出る／無関係な P2 スコープには出ない
    expect(hasTaskNode(inScope.view, msId)).toBe(true);
    expect(hasTaskNode(outScope.view, msId)).toBe(false);
  });

  it('⑪ MS を含む大・小ビューはそれぞれ冪等（added/removed 空）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'large' }, g);
    const pid = taskIdByName(p, 'P');
    p = addTask(p, { name: 'A', level: 'medium', parentId: pid }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS'), g);

    const msId = taskIdByName(p, 'MS');
    const large1 = reconcileFlow(p.core, p.details, emptyView('large'), n);
    expect(hasTaskNode(large1.view, msId)).toBe(true);
    const large2 = reconcileFlow(p.core, p.details, large1.view, n);
    expect(large2.view).toEqual(large1.view);
    expect(large2.report.added).toHaveLength(0);
    expect(large2.report.removed).toHaveLength(0);

    const small1 = reconcileFlow(p.core, p.details, emptyView('small'), n);
    expect(hasTaskNode(small1.view, msId)).toBe(true);
    const small2 = reconcileFlow(p.core, p.details, small1.view, n);
    expect(small2.view).toEqual(small1.view);
    expect(small2.report.added).toHaveLength(0);
    expect(small2.report.removed).toHaveLength(0);
  });

  it('⑫ 未紐付け MS は全スコープビューのみ・スコープ付きビューには出ない', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'P', level: 'large' }, g);
    const pid = taskIdByName(p, 'P');
    p = addTask(p, { name: 'A', level: 'medium', parentId: pid }, g);
    p = addTask(p, { name: 'MS', level: 'medium', kind: 'milestone' }, g); // 未紐付け・未親付け

    const msId = taskIdByName(p, 'MS');
    const scoped = reconcileFlow(p.core, p.details, emptyView('medium', pid), n);
    const all = reconcileFlow(p.core, p.details, emptyView('medium'), n);

    expect(hasTaskNode(scoped.view, msId)).toBe(false);
    expect(hasTaskNode(all.view, msId)).toBe(true);
  });

  it('⑬ 遷移: 依存経由のみで可視な MS が、依存撤去 → 再同期で撤去される（1 回だけ）。以降は冪等', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'P1', level: 'large' }, g); // スコープ対象（対象工程 A の親）
    p = addTask(p, { name: 'P2', level: 'large' }, g); // MS の構造上の親（P1 スコープの外）
    const p1 = taskIdByName(p, 'P1');
    const p2 = taskIdByName(p, 'P2');
    p = addTask(p, { name: 'A', level: 'medium', parentId: p1 }, g); // 対象工程は P1 配下
    p = addTask(p, { name: 'MS', level: 'medium', parentId: p2, kind: 'milestone' }, g); // 構造上は P2 配下
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'MS'), g); // A→MS：依存のみで P1 スコープに現れる

    const msId = taskIdByName(p, 'MS');
    const depId = Object.values(p.core.dependencies).find(
      (d) => d.from === taskIdByName(p, 'A') && d.to === msId,
    )!.id;

    // ① P1 スコープでは構造では現れないが、A→MS の依存経由でノードが存在する
    const r1 = reconcileFlow(p.core, p.details, emptyView('medium', p1), n);
    expect(hasTaskNode(r1.view, msId)).toBe(true);
    const msNodeId = taskNodeOf(r1.view, msId).id;

    // ② 依存を撤去 → 同じ view を再同期 → MS ノードだけが撤去される（report.removed に 1 回のみ）
    p = removeDependency(p, depId);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(hasTaskNode(r2.view, msId)).toBe(false);
    expect(r2.report.removed).toEqual([msNodeId]);
    expect(r2.report.added).toHaveLength(0);

    // ③ 3 回目は冪等（view 等値・added/removed 空）
    const r3 = reconcileFlow(p.core, p.details, r2.view, n);
    expect(r3.view).toEqual(r2.view);
    expect(r3.report.added).toHaveLength(0);
    expect(r3.report.removed).toHaveLength(0);
  });
});
