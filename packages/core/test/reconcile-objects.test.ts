import { describe, it, expect } from 'vitest';
import {
  addTask,
  addIoItem,
  removeIoItem,
  addIssueItem,
  removeIssueItem,
  addDependency,
  deleteTask,
} from '../src/commands';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { nodeRect, ioIconRect, edgeRects, SIZE } from '../src/sync/autoPlace';
import type {
  FlowDocNode,
  FlowIssueNote,
  FlowTaskNode,
  Project,
  Id,
} from '../src/model/types';
import { counter, emptyProject, emptyView, taskIdByName } from './helpers';

const docs = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowDocNode => n.kind === 'doc');
const notes = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).filter((n): n is FlowIssueNote => n.kind === 'issue');
const taskNode = (v: ReturnType<typeof reconcileFlow>['view']) =>
  Object.values(v.nodes).find((n): n is FlowTaskNode => n.kind === 'task')!;

const ioId = (p: Project, taskId: Id, name: string): Id => {
  const d = p.details[taskId]!;
  const item = [...(d.inputs ?? []), ...(d.outputs ?? [])].find((i) => i.name === name);
  if (!item) throw new Error(`io not found: ${name}`);
  return item.id;
};
const issueId = (p: Project, taskId: Id, text: string): Id => {
  const item = p.details[taskId]!.issues!.find((i) => i.issue === text)!;
  return item.id;
};

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('reconcileFlow: I/O・課題オブジェクト', () => {
  function withTask(): { p: Project; g: ReturnType<typeof counter>; id: Id } {
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: '受付', level: 'medium' }, g);
    return { p, g, id: taskIdByName(p, '受付') };
  }

  it('inputs/outputs から doc ノードが過不足なく生成される', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    p = addIoItem(p, id, 'outputs', { name: '受付票', kind: 'doc' }, g);

    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const ds = docs(r.view);
    expect(ds).toHaveLength(2);
    const input = ds.find((d) => d.io === 'input')!;
    const output = ds.find((d) => d.io === 'output')!;
    expect(input.ioId).toBe(ioId(p, id, '注文書'));
    expect(output.ioId).toBe(ioId(p, id, '受付票'));
  });

  it('入力は左上・出力は右下に「重ねて」配置される', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    p = addIoItem(p, id, 'outputs', { name: '受付票', kind: 'doc' }, g);
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const t = taskNode(r.view);
    const input = docs(r.view).find((d) => d.io === 'input')!;
    const output = docs(r.view).find((d) => d.io === 'output')!;
    // 入力は工程より左・上、出力は右・下
    expect(input.x).toBeLessThan(t.x);
    expect(input.y).toBeLessThan(t.y);
    expect(output.x).toBeGreaterThan(t.x);
    expect(output.y).toBeGreaterThan(t.y);
    // 帳票は工程に重なってよい（重なっている）
    expect(overlaps(nodeRect(input), nodeRect(t))).toBe(true);
  });

  it('I/O 削除で対応ノードのみ撤去（他は据え置き）', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    p = addIoItem(p, id, 'inputs', { name: '見積書', kind: 'doc' }, g);
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    expect(docs(r1.view)).toHaveLength(2);

    p = removeIoItem(p, id, ioId(p, id, '見積書'));
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    const ds = docs(r2.view);
    expect(ds).toHaveLength(1);
    expect(ds[0]!.ioId).toBe(ioId(p, id, '注文書'));
  });

  it('課題ノードは既定で工程ノードを対象にする', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIssueItem(p, id, { issue: '確認漏れ', measure: 'チェックリスト' }, g);
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const note = notes(r.view)[0]!;
    expect(note.issueId).toBe(issueId(p, id, '確認漏れ'));
    expect(note.targetNodeId).toBe(taskNode(r.view).id);
    expect(note.visible).toBe(true);
  });

  it('課題は他オブジェクト（工程）と重ならない位置に置かれる', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'outputs', { name: '受付票', kind: 'doc' }, g);
    p = addIssueItem(p, id, { issue: '確認漏れ' }, g);
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const note = notes(r.view)[0]!;
    const t = taskNode(r.view);
    expect(overlaps(nodeRect(note), nodeRect(t))).toBe(false);
    // 出力帳票とも重ならない
    const out = docs(r.view)[0]!;
    expect(overlaps(nodeRect(note), nodeRect(out))).toBe(false);
  });

  it('課題は I/O 集約アイコン（画面の実寸）とも重ならない', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    // 入力・出力を複数 → 集約アイコンが縦に伸び、個別 doc 矩形より大きくなる。
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    p = addIoItem(p, id, 'inputs', { name: '与信票', kind: 'doc' }, g);
    p = addIoItem(p, id, 'outputs', { name: '受付票', kind: 'doc' }, g);
    p = addIoItem(p, id, 'outputs', { name: '完了通知', kind: 'doc' }, g);
    p = addIssueItem(p, id, { issue: '確認漏れ' }, g);
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const note = notes(r.view)[0]!;
    const t = taskNode(r.view);
    // 個別 doc ではなく、集約アイコンの実寸（入力=2件分 / 出力=2件分）と重ならないこと。
    expect(overlaps(nodeRect(note), ioIconRect({ x: t.x, y: t.y }, 'input', 2))).toBe(false);
    expect(overlaps(nodeRect(note), ioIconRect({ x: t.x, y: t.y }, 'output', 2))).toBe(false);
    expect(overlaps(nodeRect(note), nodeRect(t))).toBe(false);
  });

  it('同じ工程の複数課題どうしは重ならない', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIssueItem(p, id, { issue: 'A' }, g);
    p = addIssueItem(p, id, { issue: 'B' }, g);
    p = addIssueItem(p, id, { issue: 'C' }, g);
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const ns = notes(r.view);
    expect(ns).toHaveLength(3);
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        expect(overlaps(nodeRect(ns[i]!), nodeRect(ns[j]!))).toBe(false);
      }
    }
  });

  it('課題は工程の近傍（バウンディングボックス周辺）に置かれる', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'outputs', { name: '受付票', kind: 'doc' }, g);
    p = addIssueItem(p, id, { issue: '確認漏れ' }, g);
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const note = notes(r.view)[0]!;
    const t = taskNode(r.view);
    // 工程幅ぶんの余白内＝隣接の空きに収まる（右方向へ遠く流れない）。
    const pad = SIZE.task.w;
    expect(note.x).toBeGreaterThanOrEqual(t.x - SIZE.issue.w - pad);
    expect(note.x).toBeLessThanOrEqual(t.x + SIZE.task.w + pad);
    expect(note.y).toBeGreaterThanOrEqual(t.y - SIZE.issue.h - pad);
    expect(note.y).toBeLessThanOrEqual(t.y + SIZE.task.h + pad);
  });

  it('課題は矢印（エッジ）とも重ならない', () => {
    const n = counter('n');
    const g = counter();
    let p = emptyProject();
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = addTask(p, { name: 'B', level: 'medium' }, g);
    const a = taskIdByName(p, 'A');
    const b = taskIdByName(p, 'B');
    p = addDependency(p, a, b, g); // A→B の依存 → 導出エッジ（矢印）が1本できる
    p = addIssueItem(p, a, { issue: '確認漏れ' }, g);
    const r = reconcileFlow(p.core, p.details, emptyView(), n);
    const note = notes(r.view)[0]!;
    const obstacles = edgeRects(Object.values(r.view.nodes), Object.values(r.view.edges));
    expect(obstacles.length).toBeGreaterThan(0); // エッジが実在する前提
    for (const er of obstacles) {
      expect(overlaps(nodeRect(note), er)).toBe(false);
    }
  });

  it('課題の対象に特定 I/O を指定 → その doc ノードへ。消失時はタスクへ寄る', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    const orderDocId = ioId(p, id, '注文書');
    p = addIssueItem(p, id, { issue: '不備', target: { kind: 'io', ioId: orderDocId } }, g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const docNode = docs(r1.view)[0]!;
    expect(notes(r1.view)[0]!.targetNodeId).toBe(docNode.id);

    // 対象 I/O を削除 → タスクへ寄る
    p = removeIoItem(p, id, orderDocId);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(notes(r2.view)[0]!.targetNodeId).toBe(taskNode(r2.view).id);
  });

  it('データ編集で doc の手動配置(x/y)は保持される', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const doc = docs(r1.view)[0]!;
    r1.view.nodes[doc.id] = { ...doc, x: 777, y: 333 };

    p = addIssueItem(p, id, { issue: 'x' }, g); // 別の編集
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    const moved = r2.view.nodes[doc.id] as FlowDocNode;
    expect(moved.x).toBe(777);
    expect(moved.y).toBe(333);
  });

  it('作業削除 → その I/O・課題ノードも全ビューから撤去される（幽霊が残らない）', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    p = addIssueItem(p, id, { issue: '確認漏れ' }, g);
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    expect(docs(r1.view)).toHaveLength(1);
    expect(notes(r1.view)).toHaveLength(1);

    p = deleteTask(p, id);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    // タスクノードだけでなく doc / issue ノードも消える
    expect(Object.values(r2.view.nodes)).toHaveLength(0);
    expect(r2.report.removed).toHaveLength(3);
    // 冪等: もう一度 reconcile しても何も起きない
    const r3 = reconcileFlow(p.core, p.details, r2.view, n);
    expect(r3.view).toEqual(r2.view);
    expect(r3.report.removed).toHaveLength(0);
  });

  it('I/O 削除 → doc ノードに繋いだ pinned エッジも同じ reconcile で撤去される', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    const orderIoId = ioId(p, id, '注文書');
    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const doc = docs(r1.view)[0]!;
    const t = taskNode(r1.view);
    r1.view.edges['pin-doc'] = {
      id: 'pin-doc',
      source: doc.id,
      target: t.id,
      pinned: true,
      role: 'flow',
    };

    p = removeIoItem(p, id, orderIoId);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(docs(r2.view)).toHaveLength(0);
    expect(r2.view.edges['pin-doc']).toBeUndefined(); // 端点消失 → pinned でも撤去
  });

  it('冪等性: I/O・課題込みでも reconcile(reconcile(x)) == reconcile(x)', () => {
    const n = counter('n');
    let { p, g, id } = withTask();
    p = addIoItem(p, id, 'inputs', { name: '注文書', kind: 'doc' }, g);
    p = addIoItem(p, id, 'outputs', { name: '受付票', kind: 'doc' }, g);
    p = addIssueItem(p, id, { issue: '確認漏れ' }, g);

    const r1 = reconcileFlow(p.core, p.details, emptyView(), n);
    const r2 = reconcileFlow(p.core, p.details, r1.view, n);
    expect(r2.view).toEqual(r1.view);
    expect(r2.report.added).toHaveLength(0);
    expect(r2.report.removed).toHaveLength(0);
  });
});
