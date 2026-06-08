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

  it('行列(Excel相当)取り込みで新規プロジェクトになる', () => {
    const s = createAppStore();
    s.getState().importRows([
      ['作業名', '粒度', '担当'],
      ['受注', '中', '営業'],
      ['出荷', '中', '倉庫'],
    ]);
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(2);
    expect(Object.keys(s.getState().project.core.assignees)).toHaveLength(2);
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

  it('制御ノード追加・手動エッジ接続・削除（フロー固有要素）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const taskNode = taskNodes(s)[0]!;
    s.getState().addControlNode('decision');
    const ctrl = Object.values(view0(s).nodes).find((n) => n.kind === 'control')!;
    // 手動エッジ（pinned）で接続
    s.getState().connect(taskNode.id, ctrl.id);
    let edge = Object.values(view0(s).edges).find((e) => e.source === taskNode.id && e.target === ctrl.id)!;
    expect(edge.pinned).toBe(true);
    // ラベル付与
    s.getState().setEdgeLabel(edge.id, 'OK');
    expect(Object.values(view0(s).edges).find((e) => e.id === edge.id)!.label).toBe('OK');
    // エッジ削除
    s.getState().deleteEdge(edge.id);
    expect(view0(s).edges[edge.id]).toBeUndefined();
    // 制御ノード削除
    s.getState().deleteFlowNode(ctrl.id);
    expect(Object.values(view0(s).nodes).some((n) => n.kind === 'control')).toBe(false);
  });

  it('フローで工程を作成すると表に追加され、ドロップ位置のレーンの担当になる（逆同期）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(a, '営業'); // lane order 0 → y=40
    const before = Object.keys(s.getState().project.core.tasks).length;

    s.getState().addTaskAt(320, 40); // 営業レーンの行へドロップ
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(before + 1);
    const newNode = taskNodes(s).find((n) => n.x === 320 && n.y === 40);
    expect(newNode).toBeDefined(); // ドロップ位置に配置されている
    const eigyo = Object.values(view0(s).lanes).find((l) => l.title === '営業')!;
    expect(s.getState().project.core.tasks[newNode!.taskId]!.assigneeId).toBe(eigyo.assigneeId);
  });

  it('フローでの工程作成は 1 undo で取り消せる', () => {
    const s = createAppStore();
    s.getState().addTaskAt(300, 40);
    expect(taskNodes(s)).toHaveLength(1);
    s.getState().undo();
    expect(taskNodes(s)).toHaveLength(0);
  });

  it('工程ノードどうしの矢印接続で依存（前後関係）が表に作られる', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const aNode = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const bNode = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(0);

    s.getState().connect(aNode.id, bNode.id);
    const deps = Object.values(s.getState().project.core.dependencies);
    expect(deps).toHaveLength(1); // pinned エッジでなくコア依存になる
    expect(deps[0]!.from).toBe(aNode.taskId);
    expect(deps[0]!.to).toBe(bNode.taskId);
  });

  it('サンプルを読み込むと中ビュー（受注業務）が開き、履歴はリセットされる', () => {
    const s = createAppStore();
    s.getState().loadSample();
    expect(Object.keys(s.getState().project.core.tasks).length).toBeGreaterThan(10);
    expect(s.getState().level).toBe('medium');
    expect(s.getState().scopeParentId).toBeDefined();
    expect(s.getState().canUndo).toBe(false); // 読み込み直後は履歴なし
    // 既定ビュー（中・スコープ=受注業務）に中工程ノードが 4 つ並ぶ
    const cur = s
      .getState()
      .project.flow.byLevel.find(
        (v) => v.level === 'medium' && v.scopeParentId === s.getState().scopeParentId,
      )!;
    expect(Object.values(cur.nodes).filter((n) => n.kind === 'task')).toHaveLength(4);
  });

  it('整列（tidyFlow）で配置が決定論的に組み直され、1 undo で戻せる', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    s.getState().connect(a.id, b.id); // A→B 依存
    // B を変な位置へ
    s.getState().moveNode(b.id, 1234, 999);
    expect(taskNodes(s).find((n) => n.taskId === b.taskId)!.x).toBe(1234);
    s.getState().tidyFlow();
    // 依存先 B は A より右の段へ整列される
    const ax = taskNodes(s).find((n) => n.taskId === a.taskId)!.x;
    const bx = taskNodes(s).find((n) => n.taskId === b.taskId)!.x;
    expect(bx).toBeGreaterThan(ax);
    expect(bx).not.toBe(1234);
    expect(s.getState().canUndo).toBe(true);
    s.getState().undo();
    expect(taskNodes(s).find((n) => n.taskId === b.taskId)!.x).toBe(1234);
  });

  it('restoreProject は未保存(dirty)として読み込む（保存を促すため）', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const json = serializeProject(s.getState().project);
    const s2 = createAppStore();
    s2.getState().restoreProject(deserializeProject(json));
    expect(Object.keys(s2.getState().project.core.tasks)).toHaveLength(1);
    expect(s2.getState().dirty).toBe(true); // 復元直後は未保存扱い
    expect(s2.getState().canUndo).toBe(false); // 履歴はリセット
  });

  it('レーンの高さを変えると、その下のレーンのノードが連動シフトする', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(a, '営業'); // lane 0, y=80（帯の中央, 既定高さ156）
    s.getState().addTask('B');
    const b = Object.values(s.getState().project.core.tasks).find((t) => t.name === 'B')!.id;
    s.getState().setAssigneeByName(b, '倉庫'); // lane 1, y=80+156=236
    const bNode = () => taskNodes(s).find((n) => n.taskId === b)!;
    expect(bNode().y).toBe(236);

    const lane0 = Object.values(view0(s).lanes).find((l) => l.order === 0)!;
    s.getState().setLaneHeight(lane0.id, 220); // 156→220 = +64 → 下のレーンのノードが +64
    expect(view0(s).lanes[lane0.id]!.height).toBe(220);
    expect(bNode().y).toBe(300);
    // A（同レーン）は動かない
    expect(taskNodes(s).find((n) => n.taskId === a)!.y).toBe(80);
    // 1 undo で戻る
    s.getState().undo();
    expect(bNode().y).toBe(236);
    expect(view0(s).lanes[lane0.id]!.height).toBeUndefined();
  });

  it('導出エッジを削除すると元の依存（前後関係）も消える', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    s.getState().connect(a.id, b.id);
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(1);
    const derived = Object.values(view0(s).edges).find((e) => e.derivedFromDependencyId)!;
    s.getState().deleteEdge(derived.id);
    // 依存が消え、再同期しても矢印は復活しない
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(0);
    expect(Object.values(view0(s).edges).filter((e) => e.derivedFromDependencyId)).toHaveLength(0);
  });

  it('担当を変えると工程ノードがそのレーンの行へ縦移動する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(a, '営業'); // lane order 0 → y=80（帯の中央）
    expect(taskNodes(s).find((n) => n.taskId === a)!.y).toBe(80);
    s.getState().addTask('B');
    const b = Object.values(s.getState().project.core.tasks).find((t) => t.name === 'B')!.id;
    s.getState().setAssigneeByName(b, '倉庫'); // 2 本目のレーン order 1
    s.getState().setAssigneeByName(a, '倉庫'); // A を倉庫レーンへ → y=80+156
    expect(taskNodes(s).find((n) => n.taskId === a)!.y).toBe(236);
  });
});
