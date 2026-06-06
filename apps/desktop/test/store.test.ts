import { describe, it, expect } from 'vitest';
import { createAppStore } from '../src/store';
import { serializeProject, deserializeProject } from '@gantt-flow/core';
import type { FlowTaskNode, FlowDocNode } from '@gantt-flow/core';

const view0 = (s: ReturnType<typeof createAppStore>) => s.getState().project.flow.byLevel[0]!;
const taskNodes = (s: ReturnType<typeof createAppStore>) =>
  Object.values(view0(s).nodes).filter((n): n is FlowTaskNode => n.kind === 'task');

describe('app store（command → reconcile → history）', () => {
  it('作業追加でフローにノードが出て、undo/redo できる', () => {
    const s = createAppStore();
    expect(taskNodes(s)).toHaveLength(0);
    s.getState().addTask('受付');
    expect(taskNodes(s)).toHaveLength(1);
    expect(s.getState().canUndo).toBe(true);

    s.getState().undo();
    expect(taskNodes(s)).toHaveLength(0);
    s.getState().redo();
    expect(taskNodes(s)).toHaveLength(1);
  });

  it('I/O 追加で doc ノードが現れる', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const taskId = taskNodes(s)[0]!.taskId;
    s.getState().addIo(taskId, 'inputs', '注文書');
    const docs = Object.values(view0(s).nodes).filter((n): n is FlowDocNode => n.kind === 'doc');
    expect(docs).toHaveLength(1);
    expect(docs[0]!.io).toBe('input');
  });

  it('ノード移動 → undo で位置が戻る', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const node = taskNodes(s)[0]!;
    const origX = node.x;
    s.getState().moveNode(node.id, 555, 666);
    expect((taskNodes(s)[0]!).x).toBe(555);
    s.getState().undo();
    expect((taskNodes(s)[0]!).x).toBe(origX);
  });

  it('担当を付けるとレーンができる', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const taskId = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(taskId, '営業');
    expect(Object.values(view0(s).lanes).length).toBe(1);
  });

  it('保存→開く 相当のラウンドトリップで状態が復元し、履歴はリセットされる', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    s.getState().addTask('出荷');
    // 保存相当
    const json = serializeProject(s.getState().project);
    // 別ストアで開く相当
    const s2 = createAppStore();
    s2.getState().loadProject(deserializeProject(json));
    expect(taskNodes(s2)).toHaveLength(2);
    expect(s2.getState().canUndo).toBe(false); // 開いた直後は履歴なし
  });

  it('粒度切替は undo 対象にならない（replaceTop）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    expect(s.getState().canUndo).toBe(true);
    s.getState().setLevel('large');
    expect(s.getState().level).toBe('large');
    // 切替直後も「直前のA追加」までは戻れる（切替自体は履歴を増やさない）
    expect(s.getState().canUndo).toBe(true);
  });

  it('CSV 取り込みで新規プロジェクトになる', () => {
    const s = createAppStore();
    s.getState().importCsvText('作業名,粒度\nA,中\nB,中');
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(2);
    expect(s.getState().canUndo).toBe(false); // 取り込みは履歴リセット
  });

  it('別レーンへドラッグすると担当が書き戻る（逆同期）', () => {
    const s = createAppStore();
    // 2 つの担当（=2 レーン）を用意
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(a, '営業');
    s.getState().addTask('B');
    const b = Object.values(s.getState().project.core.tasks).find((t) => t.name === 'B')!.id;
    s.getState().setAssigneeByName(b, '倉庫');

    const view = view0(s);
    const laneByName = (name: string) => Object.values(view.lanes).find((l) => l.title === name)!;
    const soukoOrder = laneByName('倉庫').order;
    // A のノードを倉庫レーンの y へドラッグ
    const aNode = taskNodes(s).find((n) => n.taskId === a)!;
    s.getState().moveNode(aNode.id, 300, 40 + soukoOrder * 120);
    expect(s.getState().project.core.tasks[a]!.assigneeId).toBe(view.lanes[laneByName('倉庫').id]!.assigneeId);
  });

  it('大工程に子を足すと一段細かい中工程になる', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const large = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addChildTask(large.id);
    const child = Object.values(s.getState().project.core.tasks).find((t) => t.parentId === large.id)!;
    expect(child.level).toBe('medium');
  });

  it('removeTask で削除、setTaskLevel で粒度を変えられる', () => {
    const s = createAppStore();
    s.getState().addRootTask('medium');
    const t = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().setTaskLevel(t.id, 'small');
    expect(s.getState().project.core.tasks[t.id]!.level).toBe('small');
    s.getState().removeTask(t.id);
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(0);
  });

  it('担当を変えると工程ノードがそのレーンの行へ縦移動する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(a, '営業'); // lane order 0 → y=40
    expect(taskNodes(s).find((n) => n.taskId === a)!.y).toBe(40);
    s.getState().addTask('B');
    const b = Object.values(s.getState().project.core.tasks).find((t) => t.name === 'B')!.id;
    s.getState().setAssigneeByName(b, '倉庫'); // 2 本目のレーン order 1
    s.getState().setAssigneeByName(a, '倉庫'); // A を倉庫レーンへ → y=40+120
    expect(taskNodes(s).find((n) => n.taskId === a)!.y).toBe(160);
  });
});
