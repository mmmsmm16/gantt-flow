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
import type { FlowTaskNode } from '../src/model/types';
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
});
