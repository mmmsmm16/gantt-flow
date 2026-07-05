import { describe, it, expect } from 'vitest';
import {
  addTask,
  addAssignee,
  setAssignee,
  renameTask,
  addDependency,
  deleteTask,
} from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import type { FlowTaskNode, FlowControlNode } from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName, assigneeIdByName } from './helpers';

const taskNodes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

describe('reconcileFlow v1', () => {
  it('作業追加 → タスクノードが自動配置される', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addAssignee(p, { name: '営業', kind: 'department' }, g);
    p = addTask(p, { name: '受付', level: 'medium', assigneeId: assigneeIdByName(p, '営業') }, g);

    const res = reconcileFlow(p.core, p.details, emptyView(), n);
    const nodes = taskNodes(res.view);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.taskId).toBe(taskIdByName(p, '受付'));
    expect(res.report.added).toHaveLength(1);
    // レーンが担当ぶん 1 本
    expect(Object.values(res.view.lanes)).toHaveLength(1);
  });

  it('リネーム → 位置・レーンは不変（データ編集で x/y を動かさない）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    // 手動でノードを移動
    const node = taskNodes(r1.view)[0]!;
    r1.view.nodes[node.id] = { ...node, x: 999, y: 888 };

    p = renameTask(p, taskIdByName(p, 'A'), 'A2');
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    const moved = r2.view.nodes[node.id] as FlowTaskNode;
    expect(moved.x).toBe(999);
    expect(moved.y).toBe(888);
  });

  it('担当変更 → レーンが変わり位置は保持', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addAssignee(p, { name: '営業', kind: 'department' }, g);
    p = addAssignee(p, { name: '倉庫', kind: 'department' }, g);
    p = addTask(p, { name: 'A', level: 'medium', assigneeId: assigneeIdByName(p, '営業') }, g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const node = taskNodes(r1.view)[0]!;
    r1.view.nodes[node.id] = { ...node, x: 500, y: 500 };
    const laneBefore = (r1.view.nodes[node.id] as FlowTaskNode).laneId;

    p = setAssignee(p, taskIdByName(p, 'A'), assigneeIdByName(p, '倉庫'));
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    const after = r2.view.nodes[node.id] as FlowTaskNode;
    expect(after.x).toBe(500); // 位置は保持
    expect(after.laneId).not.toBe(laneBefore); // レーンは変わる
  });

  it('依存追加 → 導出エッジが 1 本出る', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);

    const res = reconcileFlow(p.core, p.details, emptyView(), n);
    const edges = Object.values(res.view.edges);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.derivedFromDependencyId).toBeDefined();
    expect(edges[0]!.role).toBe('flow');
  });

  it('作業削除 → ノード撤去 + 前後の繋ぎ直し（A→[X]→B を A→B）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'X', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'X'), g);
    p = addDependency(p, taskIdByName(p, 'X'), taskIdByName(p, 'B'), g);

    const xId = taskIdByName(p, 'X');
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    expect(taskNodes(r1.view)).toHaveLength(3);

    p = deleteTask(p, xId);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);

    // X のノードは撤去
    expect(taskNodes(r2.view).map((n) => n.taskId)).not.toContain(xId);
    expect(taskNodes(r2.view)).toHaveLength(2);
    // A→B のエッジが 1 本（繋ぎ直し）
    const edges = Object.values(r2.view.edges);
    expect(edges).toHaveLength(1);
    const aNode = taskNodes(r2.view).find((n) => n.taskId === taskIdByName(p, 'A'))!;
    const bNode = taskNodes(r2.view).find((n) => n.taskId === taskIdByName(p, 'B'))!;
    expect(edges[0]!.source).toBe(aNode.id);
    expect(edges[0]!.target).toBe(bNode.id);
  });

  it('冪等性: reconcile(reconcile(x)) == reconcile(x)', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addAssignee(p, { name: '営業', kind: 'department' }, g);
    p = addTask(p, { name: 'A', level: 'medium', assigneeId: assigneeIdByName(p, '営業') }, g);
    p = addTask(p, { name: 'B', level: 'medium', assigneeId: assigneeIdByName(p, '営業') }, g);
    p = addDependency(p, taskIdByName(p, 'A'), taskIdByName(p, 'B'), g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(r2.view).toEqual(r1.view);
    expect(r2.report.added).toHaveLength(0);
    expect(r2.report.removed).toHaveLength(0);
  });

  it('pinned エッジは依存が無くても消えない', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const [a, b] = taskNodes(r1.view);
    r1.view.edges['pinned-1'] = {
      id: 'pinned-1',
      source: a!.id,
      target: b!.id,
      pinned: true,
      role: 'flow',
    };
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(r2.view.edges['pinned-1']).toBeDefined();
  });

  it('pinned エッジでも端点ノードが消えたら撤去される（幽霊エッジを残さない）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const aNode = taskNodes(r1.view).find((t) => t.taskId === taskIdByName(p, 'A'))!;
    const bNode = taskNodes(r1.view).find((t) => t.taskId === taskIdByName(p, 'B'))!;
    // ユーザーが A→判断、判断→B を手で接続（pinned）
    const ctrl: FlowControlNode = { id: 'ctrl', kind: 'control', control: 'decision', x: 300, y: 40 };
    r1.view.nodes['ctrl'] = ctrl;
    r1.view.edges['pin-a'] = { id: 'pin-a', source: aNode.id, target: 'ctrl', pinned: true, role: 'flow' };
    r1.view.edges['pin-b'] = { id: 'pin-b', source: 'ctrl', target: bNode.id, pinned: true, role: 'flow' };

    p = deleteTask(p, taskIdByName(p, 'A'));
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(r2.view.edges['pin-a']).toBeUndefined(); // 端点(A)消失 → pinned でも撤去
    expect(r2.view.edges['pin-b']).toBeDefined(); // 両端が生きていれば保持
  });

  it('別スコープ/別粒度のタスクは対象に含めない', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    p = addTask(p, { name: 'M', level: 'medium' }, g);
    p = addTask(p, { name: 'S', level: 'small' }, g);
    const res = reconcileFlow(p.core, p.details, emptyView('medium'), n);
    expect(taskNodes(res.view)).toHaveLength(1);
    expect(taskNodes(res.view)[0]!.taskId).toBe(taskIdByName(p, 'M'));
  });

  it('新規ノードの初期列が既存ノードと衝突するときは空き列へずらす（既存は不変）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    // A(order0)→x=120, B(order1)→x=340 に配置される
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const bx = taskNodes(r1.view).find((nd) => nd.taskId === taskIdByName(p, 'B'))!.x;
    expect(bx).toBe(340);

    // A を消して C を足すと、対象は [B(order1), C(order2)]。
    // 既存 B は x=340 を保持し、新規 C の目標列は index1 = 120 + 220 = 340 で B と衝突する。
    p = deleteTask(p, taskIdByName(p, 'A'));
    p = addTask(p, { name: 'C', level: 'medium' }, g);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);

    const nodes2 = taskNodes(r2.view);
    const b2 = nodes2.find((nd) => nd.taskId === taskIdByName(p, 'B'))!;
    const c2 = nodes2.find((nd) => nd.taskId === taskIdByName(p, 'C'))!;
    // 既存 B は動かない（x/y 不変）
    expect(b2.x).toBe(340);
    // 新規 C は衝突を避けて次の空き列へ（340 → 560）
    expect(c2.x).toBe(560);
    // 2 ノードは矩形的に重ならない
    const overlap =
      c2.x < b2.x + 150 && c2.x + 150 > b2.x && c2.y < b2.y + 44 && c2.y + 44 > b2.y;
    expect(overlap).toBe(false);

    // 冪等: 同じ idGen でもう一度 reconcile しても何も変わらない
    const r3 = reconcileFlow(p.core, p.details, r2.view, n);
    expect(r3.view).toEqual(r2.view);
    expect(r3.report.added).toHaveLength(0);
    expect(r3.report.removed).toHaveLength(0);
  });

  it('手動配置ノードが格子を跨ぐ密なレーンでも新規は必ず空きへ収まる（重なりゼロ）', () => {
    const g = counter();
    const n = counter('n');
    let p = emptyProject();
    // 同一レーン（担当なし=order0）に 5 タスク。まず既存 4 つを配置。
    for (const name of ['A', 'B', 'C', 'D']) {
      p = addTask(p, { name, level: 'medium' }, g);
    }
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    // 既存 4 ノードを 220px 刻みの「格子を跨ぐ」位置へ手動移動（各ノードが 2 列に跨る）。
    const view1 = r1.view;
    const at = [220, 660, 1100, 1540];
    ['A', 'B', 'C', 'D'].forEach((name, k) => {
      const nd = taskNodes(view1).find((x) => x.taskId === taskIdByName(p, name))!;
      view1.nodes[nd.id] = { ...nd, x: at[k]!, y: 80 };
    });
    // 新規 E を追加（自然な列 index4 = 120+880=1000 は既存とぶつかる）。
    p = addTask(p, { name: 'E', level: 'medium' }, g);
    const r2 = reconcileFlow(p.core, p.details, view1, n);

    // どの 2 ノードも矩形的に重ならない（衝突ゼロを保証）。
    const nodes = taskNodes(r2.view);
    const overlap = (a: (typeof nodes)[number], b: (typeof nodes)[number]) =>
      a.x < b.x + 150 && a.x + 150 > b.x && a.y < b.y + 44 && a.y + 44 > b.y;
    let any = false;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) if (overlap(nodes[i]!, nodes[j]!)) any = true;
    expect(any).toBe(false);
    // 既存 4 ノードは手動位置を保持（x/y 不変）。
    at.forEach((x, k) => {
      const name = ['A', 'B', 'C', 'D'][k]!;
      expect(nodes.find((nd) => nd.taskId === taskIdByName(p, name))!.x).toBe(x);
    });
    // 冪等。
    const r3 = reconcileFlow(p.core, p.details, r2.view, n);
    expect(r3.view).toEqual(r2.view);
  });
});
