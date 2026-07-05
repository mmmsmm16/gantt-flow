import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAppStore, useApp, findView } from '../src/store';
import { revealTask, confirmRemoveTasks } from '../src/taskOps';
import { useUI } from '../src/ui/useUI';
import { serializeProject, deserializeProject, ROW_SUB, SIZE, laneLayout } from '@gantt-flow/core';
import type { FlowTaskNode, FlowDocNode } from '@gantt-flow/core';
import {
  contentHashName,
  putAsset,
  ingestAssets,
  hasAsset,
  __resetAssetStoreForTest,
} from '../src/assetStore';

const view0 = (s: ReturnType<typeof createAppStore>) => s.getState().project.flow.byLevel[0]!;
const taskNodes = (s: ReturnType<typeof createAppStore>) =>
  Object.values(view0(s).nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
const idByName = (s: ReturnType<typeof createAppStore>, name: string) =>
  Object.values(s.getState().project.core.tasks).find((t) => t.name === name)!.id;
const depPairs = (s: ReturnType<typeof createAppStore>) =>
  Object.values(s.getState().project.core.dependencies)
    .map((d) => {
      const t = s.getState().project.core.tasks;
      return `${t[d.from]?.name}→${t[d.to]?.name}`;
    })
    .sort();

describe('reloadFromExternal（外部変更の片方向ライブ反映）', () => {
  it('外部の更新を反映し、選択を保ち、dirty=false（保存済みベース）になる', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    s.getState().addTask('出荷');
    const keepId = idByName(s, '受付');
    s.getState().select(keepId);

    // 外部プロセスがファイルへ書いた結果を別ストアで作る（受付/出荷 ＋ 検品 を追加）。
    const s2 = createAppStore();
    s2.getState().loadProject(deserializeProject(serializeProject(s.getState().project)));
    s2.getState().addTask('検品');
    const externalOnDisk = deserializeProject(serializeProject(s2.getState().project));

    s.getState().reloadFromExternal(externalOnDisk);

    expect(Object.values(s.getState().project.core.tasks).map((t) => t.name).sort()).toEqual(
      ['出荷', '受付', '検品'],
    );
    expect(s.getState().selectedTaskId).toBe(keepId); // 残っている選択は維持
    expect(s.getState().dirty).toBe(false); // 外部反映後は保存済み扱い
    expect(s.getState().canUndo).toBe(false); // undo 履歴はリセット
  });

  it('選択中の工程が外部更新で消えていたら選択は解除される', () => {
    const s = createAppStore();
    s.getState().addTask('一時');
    const gone = idByName(s, '一時');
    s.getState().select(gone);

    const s2 = createAppStore(); // 空（= 一時工程は無い）
    const external = deserializeProject(serializeProject(s2.getState().project));
    s.getState().reloadFromExternal(external);

    expect(s.getState().selectedTaskId).toBeUndefined();
    expect(s.getState().dirty).toBe(false);
  });
});

describe('B: reconnectEdge / renameAssignee（フロー編集の磨き込み）', () => {
  const viewOf = (s: ReturnType<typeof createAppStore>) =>
    findView(s.getState().project, s.getState().level, s.getState().scopeParentId)!;
  const nodeIdOf = (s: ReturnType<typeof createAppStore>, taskId: string) =>
    Object.values(viewOf(s).nodes).find((n) => n.kind === 'task' && n.taskId === taskId)!.id;

  it('reconnectEdge: 導出エッジの終点付け替えで依存が A→B から A→C へ変わる', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    s.getState().addTask('C');
    const a = idByName(s, 'A');
    const b = idByName(s, 'B');
    const c = idByName(s, 'C');
    s.getState().connect(nodeIdOf(s, a), nodeIdOf(s, b)); // 依存 A→B（導出エッジ生成）
    expect(depPairs(s)).toContain('A→B');
    const edge = Object.values(viewOf(s).edges).find((e) => e.derivedFromDependencyId)!;
    s.getState().reconnectEdge(edge.id, 'target', nodeIdOf(s, c));
    expect(depPairs(s)).toContain('A→C');
    expect(depPairs(s)).not.toContain('A→B');
  });

  it('renameAssignee: 担当名がレーン名と工程に反映される', () => {
    const s = createAppStore();
    s.getState().addTask('受注');
    const a = idByName(s, '受注');
    s.getState().setAssigneeByName(a, '営業');
    const asgId = s.getState().project.core.tasks[a]!.assigneeId!;
    s.getState().renameAssignee(asgId, '営業部');
    expect(s.getState().project.core.assignees[asgId]!.name).toBe('営業部');
    const lane = Object.values(viewOf(s).lanes).find((l) => l.assigneeId === asgId);
    expect(lane?.title).toBe('営業部');
  });
});

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

  it('addTaskNextTo: 基準の右隣に作成して依存を接続、1 undo で工程・依存ごと戻る', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!;
    const newId = s.getState().addTaskNextTo(a.taskId)!;
    expect(newId).toBeDefined();
    expect(s.getState().selectedTaskId).toBe(newId); // 作成工程が選択される（リネーム開始用）
    const created = taskNodes(s).find((n) => n.taskId === newId)!;
    expect(created.y).toBe(a.y); // 同じ行＝同レーン
    expect(created.x).toBeGreaterThanOrEqual(a.x + SIZE.task.w); // 基準の右隣
    const deps = Object.values(s.getState().project.core.dependencies);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.from).toBe(a.taskId);
    expect(deps[0]!.to).toBe(newId);
    // 依存はフローの導出エッジとして同じビューに引かれる
    expect(Object.values(view0(s).edges).some((e) => e.derivedFromDependencyId === deps[0]!.id)).toBe(true);
    s.getState().undo(); // 1 undo で作成と接続がまとめて消える
    expect(s.getState().project.core.tasks[newId]).toBeUndefined();
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(0);
  });

  it('addTaskNextTo: 右隣が塞がっていれば重ならない位置までさらに右へずらす', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!;
    const firstId = s.getState().addTaskNextTo(a.taskId)!; // 右隣を占有
    const first = taskNodes(s).find((n) => n.taskId === firstId)!;
    const secondId = s.getState().addTaskNextTo(a.taskId)!; // 同じ基準からもう一度
    const second = taskNodes(s).find((n) => n.taskId === secondId)!;
    expect(second.y).toBe(a.y);
    expect(second.x).toBeGreaterThanOrEqual(first.x + SIZE.task.w); // first と重ならない
  });

  it('addTaskNextTo: 粒度・親・担当を引き継ぎ、表では基準の直下に並ぶ（connect:false は接続なし）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const aId = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!.taskId;
    s.getState().setAssigneeByName(aId, '営業');
    const newId = s.getState().addTaskNextTo(aId, { connect: false })!;
    const a = s.getState().project.core.tasks[aId]!;
    const t = s.getState().project.core.tasks[newId]!;
    expect(t.level).toBe(a.level);
    expect(t.parentId).toBe(a.parentId);
    expect(t.assigneeId).toBe(a.assigneeId); // reconcile で営業レーンに乗る
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(0);
    // 表の並び: A の直下（B より前）
    const ordered = Object.values(s.getState().project.core.tasks)
      .sort((x, y) => x.order - y.order)
      .map((o) => o.id);
    expect(ordered.indexOf(newId)).toBe(ordered.indexOf(aId) + 1);
    // 存在しない工程を基準にすると何もしない
    expect(s.getState().addTaskNextTo('no-such-task')).toBeUndefined();
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

  it('addTaskAt は作成した工程の id を返す（作成直後のその場リネーム用）', () => {
    const s = createAppStore();
    const id = s.getState().addTaskAt(300, 40);
    expect(id).toBeDefined();
    expect(s.getState().selectedTaskId).toBe(id);
    expect(s.getState().project.core.tasks[id!]).toBeDefined();
  });

  it('connectToNew: 空白へドラッグで工程を作成し、起点工程から依存を張る（1 undo）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!;
    const before = Object.keys(s.getState().project.core.tasks).length;
    const newId = s.getState().connectToNew(a.id, 360, 40)!;
    expect(newId).toBeDefined();
    expect(s.getState().selectedTaskId).toBe(newId); // リネーム開始用に選択される
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(before + 1);
    const created = taskNodes(s).find((n) => n.taskId === newId)!;
    expect(created.x).toBe(360); // ドロップ位置に配置
    expect(created.y).toBe(40);
    const deps = Object.values(s.getState().project.core.dependencies);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.from).toBe(a.taskId);
    expect(deps[0]!.to).toBe(newId);
    // 依存は導出エッジとして同じビューに引かれる
    expect(Object.values(view0(s).edges).some((e) => e.derivedFromDependencyId === deps[0]!.id)).toBe(true);
    s.getState().undo(); // 1 undo で作成・依存ごと戻る
    expect(s.getState().project.core.tasks[newId]).toBeUndefined();
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(0);
  });

  it('connectToNew: 制御ノード起点なら依存ではなく pinned エッジになる', () => {
    const s = createAppStore();
    s.getState().addControlNode('decision');
    const ctrl = Object.values(view0(s).nodes).find((n) => n.kind === 'control')!;
    const newId = s.getState().connectToNew(ctrl.id, 380, 60)!;
    expect(newId).toBeDefined();
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(0); // 依存は作らない
    const newNode = taskNodes(s).find((n) => n.taskId === newId)!;
    const edge = Object.values(view0(s).edges).find((e) => e.source === ctrl.id && e.target === newNode.id)!;
    expect(edge).toBeDefined();
    expect(edge.pinned).toBe(true);
  });

  it('addDependency: 別の親グループの同粒度工程にも依存を張れる（前工程候補拡大の土台）', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const l1 = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addRootTask('large');
    const l2 = Object.values(s.getState().project.core.tasks).filter((t) => t.level === 'large')[1]!;
    const a1 = s.getState().addChildTask(l1.id)!; // 中工程(親=l1)
    const b1 = s.getState().addChildTask(l2.id)!; // 中工程(親=l2・別グループ)
    s.getState().addDependency(b1, a1); // 別グループ間（同粒度）
    const deps = Object.values(s.getState().project.core.dependencies);
    expect(deps.some((d) => d.from === b1 && d.to === a1)).toBe(true);
  });

  it('サンプルを読み込むと中・全体スコープのビューが開き、履歴はリセットされる', () => {
    const s = createAppStore();
    s.getState().loadSample();
    expect(Object.keys(s.getState().project.core.tasks).length).toBeGreaterThan(10);
    expect(s.getState().level).toBe('medium');
    expect(s.getState().scopeParentId).toBeUndefined(); // 既定は全体スコープ
    expect(s.getState().canUndo).toBe(false); // 読み込み直後は履歴なし
    // 全体ビューには全中工程(10)が並ぶ
    const cur = s
      .getState()
      .project.flow.byLevel.find((v) => v.level === 'medium' && v.scopeParentId === undefined)!;
    expect(Object.values(cur.nodes).filter((n) => n.kind === 'task')).toHaveLength(10);
  });

  it('粒度切替の既定スコープは全体。同一粒度の setLevel はスコープを保つ', () => {
    const s = createAppStore();
    s.getState().loadSample();
    s.getState().setLevel('small');
    expect(s.getState().scopeParentId).toBeUndefined(); // 切替後も全体
    // 明示的にスコープを絞る → 同一粒度の setLevel では解除されない
    const firstMedium = Object.values(s.getState().project.core.tasks).find((t) => t.level === 'medium')!;
    s.getState().setLevel('small');
    s.getState().setScope(firstMedium.id);
    s.getState().setLevel('small');
    expect(s.getState().scopeParentId).toBe(firstMedium.id);
    // 粒度を変えると既定(全体)に戻る
    s.getState().setLevel('medium');
    expect(s.getState().scopeParentId).toBeUndefined();
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

  it('一括操作: 複数工程の担当をまとめて設定／まとめて削除（各 1 undo）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    s.getState().addTask('C');
    const ids = Object.values(s.getState().project.core.tasks).map((t) => t.id);
    s.getState().setAssigneeManyByName(ids, '経理部');
    const eigyo = Object.values(s.getState().project.core.assignees).find((a) => a.name === '経理部')!;
    for (const id of ids) expect(s.getState().project.core.tasks[id]!.assigneeId).toBe(eigyo.id);
    expect(s.getState().canUndo).toBe(true);
    s.getState().undo(); // 1 操作で全件戻る
    for (const id of ids) expect(s.getState().project.core.tasks[id]!.assigneeId).toBeUndefined();

    s.getState().removeManyTasks(ids);
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(0);
    s.getState().undo(); // 1 操作で全件復活
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(3);
  });

  it('工程を複製すると同名の兄弟が直後にでき、I/O・課題もコピーされる（依存は引き継がない）', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const t = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addIo(t.id, 'inputs', '注文書');
    s.getState().addIssue(t.id, '手作業が多い');
    const nid = s.getState().duplicateTask(t.id)!;
    expect(nid).toBeDefined();
    const dup = s.getState().project.core.tasks[nid]!;
    expect(dup.name).toBe('受付');
    expect(dup.level).toBe(t.level);
    const dd = s.getState().project.details[nid]!;
    expect(dd.inputs).toHaveLength(1);
    expect(dd.inputs![0]!.name).toBe('注文書');
    expect(dd.inputs![0]!.id).not.toBe(s.getState().project.details[t.id]!.inputs![0]!.id); // 新ID
    expect(dd.issues).toHaveLength(1);
    s.getState().undo(); // 1 undo で複製が消える
    expect(s.getState().project.core.tasks[nid]).toBeUndefined();
  });

  it('クリップボード行（[名前, 担当]）を貼り付けると複数工程が一括追加される', () => {
    const s = createAppStore();
    const n = s.getState().pasteRowsAsTasks([
      ['見積作成', '営業部'],
      ['与信確認', '経理部'],
      ['', ''], // 空行は無視
      ['出荷指示'],
    ]);
    expect(n).toBe(3);
    const names = Object.values(s.getState().project.core.tasks).map((t) => t.name);
    expect(names).toContain('見積作成');
    expect(names).toContain('与信確認');
    expect(names).toContain('出荷指示');
    expect(Object.values(s.getState().project.core.assignees).map((a) => a.name)).toContain('経理部');
    s.getState().undo(); // 1 undo で全件取り消し
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(0);
  });

  it('copyAsIsToToBeMany: 全工程の As-Is を To-Be へ一括複製し、1 undo で全戻り（B-06）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    s.getState().addTask('C');
    const tasks = Object.values(s.getState().project.core.tasks);
    const ids = tasks.map((t) => t.id);
    // As-Is 値（工数）を各工程へ入れておく。
    ids.forEach((id, i) => s.getState().updateDetail(id, { effortMinutes: (i + 1) * 60 }));
    // 一括複製前は To-Be 未設定。
    for (const id of ids) expect(s.getState().project.details[id]!.toBe).toBeUndefined();

    const n = s.getState().copyAsIsToToBeMany(ids);
    expect(n).toBe(3);
    // 全工程の As-Is 工数が To-Be の起点へ写る。
    ids.forEach((id, i) => {
      expect(s.getState().project.details[id]!.toBe!.effortMinutes).toBe((i + 1) * 60);
    });
    expect(s.getState().canUndo).toBe(true);

    // 1 回の undo で 3 工程ぶんの複製がまとめて元に戻る（旧: forEach → N 回 commit だった）。
    s.getState().undo();
    for (const id of ids) expect(s.getState().project.details[id]!.toBe).toBeUndefined();
  });

  it('copyAsIsToToBeMany: 不在 id は数えず、複製できた件数だけを返す', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = idByName(s, 'A');
    expect(s.getState().copyAsIsToToBeMany([a, 'no-such-task'])).toBe(1);
    // 何も複製できなければ履歴を汚さない。
    const before = s.getState().project;
    expect(s.getState().copyAsIsToToBeMany(['no-such-task'])).toBe(0);
    expect(s.getState().project).toBe(before);
  });

  it('一括操作: moveNodesBy で複数ノードをまとめて平行移動（1 undo）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    const ax = a.x;
    const bx = b.x;
    s.getState().moveNodesBy([a.id, b.id], 50, 30);
    expect(taskNodes(s).find((n) => n.id === a.id)!.x).toBe(ax + 50);
    expect(taskNodes(s).find((n) => n.id === b.id)!.x).toBe(bx + 50);
    s.getState().undo();
    expect(taskNodes(s).find((n) => n.id === a.id)!.x).toBe(ax);
  });

  it('一括操作: deleteFlowNodes で制御/付箋をまとめて削除（工程は無視）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const taskNode = taskNodes(s)[0]!;
    s.getState().addControlNode('decision');
    s.getState().addComment('メモ');
    const ctrl = Object.values(view0(s).nodes).find((n) => n.kind === 'control')!;
    const note = Object.values(view0(s).nodes).find((n) => n.kind === 'comment')!;
    s.getState().deleteFlowNodes([ctrl.id, note.id, taskNode.id]); // 工程 id は無視される
    expect(view0(s).nodes[ctrl.id]).toBeUndefined();
    expect(view0(s).nodes[note.id]).toBeUndefined();
    expect(Object.values(view0(s).nodes).some((n) => n.kind === 'task')).toBe(true); // 工程は残る
  });

  it('removeManyTasks(flowNodeIds): 工程＋制御/付箋の混在削除を 1 undo 単位で丸ごと復元する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const taskId = idByName(s, 'A');
    const taskNode = taskNodes(s).find((n) => n.taskId === taskId)!;
    s.getState().addControlNode('decision');
    s.getState().addComment('メモ');
    const ctrl = Object.values(view0(s).nodes).find((n) => n.kind === 'control')!;
    const note = Object.values(view0(s).nodes).find((n) => n.kind === 'comment')!;

    // 工程と図形（制御/付箋）を同じ呼び出しで削除する。
    s.getState().removeManyTasks([taskId], [ctrl.id, note.id]);
    expect(s.getState().project.core.tasks[taskId]).toBeUndefined();
    expect(view0(s).nodes[taskNode.id]).toBeUndefined();
    expect(view0(s).nodes[ctrl.id]).toBeUndefined();
    expect(view0(s).nodes[note.id]).toBeUndefined();

    // 提示する「元に戻す」は undo 1 回。工程・制御・付箋がまとめて戻る（別 undo 単位に割れない）。
    s.getState().undo();
    expect(s.getState().project.core.tasks[taskId]).toBeDefined();
    expect(Object.values(view0(s).nodes).some((n) => n.kind === 'task')).toBe(true);
    expect(view0(s).nodes[ctrl.id]).toBeDefined();
    expect(view0(s).nodes[note.id]).toBeDefined();
  });

  it('setCommentTarget: 付箋を工程ノードへ結ぶ/解除する。不正な対象は no-op', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const task = taskNodes(s)[0]!;
    s.getState().addComment('メモ');
    const note = Object.values(view0(s).nodes).find((n) => n.kind === 'comment')!;

    // 実在する工程ノードを対象に設定できる。
    s.getState().setCommentTarget(note.id, task.id);
    const linked = view0(s).nodes[note.id]!;
    expect(linked.kind === 'comment' && linked.targetNodeId).toBe(task.id);

    // 不在ノード・自分自身は無効（no-op：直前の対象を保つ、履歴も汚さない）。
    const canUndoBefore = s.getState().canUndo;
    s.getState().setCommentTarget(note.id, 'no-such-node');
    s.getState().setCommentTarget(note.id, note.id);
    const still = view0(s).nodes[note.id]!;
    expect(still.kind === 'comment' && still.targetNodeId).toBe(task.id);
    expect(s.getState().canUndo).toBe(canUndoBefore); // no-op は履歴に積まれない

    // 解除できる（undefined）。
    s.getState().setCommentTarget(note.id, undefined);
    const cleared = view0(s).nodes[note.id]!;
    expect(cleared.kind === 'comment' && cleared.targetNodeId).toBeUndefined();

    // undo で対象設定が元に戻る（結び→解除の 2 手を戻すと結び直った状態へ）。
    s.getState().undo();
    const back = view0(s).nodes[note.id]!;
    expect(back.kind === 'comment' && back.targetNodeId).toBe(task.id);
  });

  it('removeTask: 削除された工程のノードを対象にしていた付箋の targetNodeId が外れる（ダングリング禁止）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const nodeA = taskNodes(s).find((n) => n.taskId === idByName(s, 'A'))!;
    const nodeB = taskNodes(s).find((n) => n.taskId === idByName(s, 'B'))!;
    s.getState().addComment('Aを対象');
    s.getState().addComment('Bを対象');
    const noteA = Object.values(view0(s).nodes).find((n) => n.kind === 'comment' && n.text === 'Aを対象')!;
    const noteB = Object.values(view0(s).nodes).find((n) => n.kind === 'comment' && n.text === 'Bを対象')!;
    s.getState().setCommentTarget(noteA.id, nodeA.id);
    s.getState().setCommentTarget(noteB.id, nodeB.id);

    s.getState().removeTask(idByName(s, 'A'));

    // 対象工程ごと消えた付箋は targetNodeId が外れる（描画側ガードで無害でも永続化するとダングリング）。
    const clearedA = view0(s).nodes[noteA.id]!;
    expect(clearedA.kind === 'comment' && clearedA.targetNodeId).toBeUndefined();
    // 無関係（削除していない工程）を対象にした付箋は影響を受けない。
    const stillB = view0(s).nodes[noteB.id]!;
    expect(stillB.kind === 'comment' && stillB.targetNodeId).toBe(nodeB.id);
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

  it('保存→粒度切替(replaceTop)→編集→undo で dirty が解消する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().markSaved();
    expect(s.getState().dirty).toBe(false);
    s.getState().setLevel('large'); // ビュー切替は保存済み状態を壊さない
    expect(s.getState().dirty).toBe(false);
    s.getState().addTask('B');
    expect(s.getState().dirty).toBe(true);
    s.getState().undo(); // 保存時点と等価な状態へ戻る
    expect(s.getState().dirty).toBe(false);
  });

  it('markSaved にスナップショットを渡すと、その時点を基準に dirty を再計算する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const snapshot = s.getState().project; // 保存処理がファイルに書いた状態
    s.getState().addTask('B'); // 保存中に入った編集
    s.getState().markSaved(snapshot);
    expect(s.getState().dirty).toBe(true); // 現在はスナップショットより進んでいる
    s.getState().undo(); // B を取り消すと保存時点に一致
    expect(s.getState().dirty).toBe(false);
  });

  it('保存 await 中の粒度切替（replaceTop）後でも、内容が等価なら markSaved で dirty が解消する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().setLevel('large'); // 両ビューを先に作っておく（後の切替を内容等価にする）
    s.getState().setLevel('medium');
    const snapshot = s.getState().project; // 保存処理がファイルに書いた状態
    // 保存 await 中のビュー切替を模擬: replaceTop でスナップショットが履歴の先頭から外れる
    s.getState().setLevel('large');
    expect(s.getState().project).not.toBe(snapshot); // 参照は別物（reconcile で作り直される）
    s.getState().markSaved(snapshot);
    expect(s.getState().dirty).toBe(false); // 内容等価なら保存済み扱いになる
    s.getState().addTask('B');
    expect(s.getState().dirty).toBe(true); // 以後の編集は通常どおり dirty
  });

  it('既に依存がある工程どうしの再接続は no-op（履歴・dirty を汚さない）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    s.getState().connect(a.id, b.id);
    s.getState().markSaved();
    const before = s.getState().project;
    s.getState().connect(a.id, b.id); // フローからの再接続
    expect(s.getState().project).toBe(before);
    expect(s.getState().dirty).toBe(false);
    s.getState().addDependency(a.taskId, b.taskId); // ストア API からの再追加
    expect(s.getState().project).toBe(before);
    expect(Object.keys(s.getState().project.core.dependencies)).toHaveLength(1);
  });

  it('同じ手動エッジを二重に張ろうとしても履歴は増えない', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const taskNode = taskNodes(s)[0]!;
    s.getState().addControlNode('decision');
    const ctrl = Object.values(view0(s).nodes).find((n) => n.kind === 'control')!;
    s.getState().connect(taskNode.id, ctrl.id);
    const before = s.getState().project;
    s.getState().connect(taskNode.id, ctrl.id); // 既存と同じ pinned エッジ
    expect(s.getState().project).toBe(before);
    expect(Object.keys(view0(s).edges)).toHaveLength(1);
  });

  it('スコープ中の親を削除するとスコープが全体へ戻り、以後の作成が孤児にならない', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const large = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addChildTask(large.id);
    s.getState().setLevel('medium');
    s.getState().setScope(large.id);
    s.getState().removeTask(large.id); // スコープの親そのものを削除
    expect(s.getState().scopeParentId).toBeUndefined();
    s.getState().addTaskAt(300, 80); // フローのダブルクリック相当
    const tasks = s.getState().project.core.tasks;
    expect(Object.values(tasks).filter((t) => t.parentId && !tasks[t.parentId])).toHaveLength(0);
  });

  it('removeManyTasks でスコープ親が消えた場合も全体スコープへ戻る', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const large = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().addChildTask(large.id);
    s.getState().setLevel('medium');
    s.getState().setScope(large.id);
    s.getState().removeManyTasks([large.id]);
    expect(s.getState().scopeParentId).toBeUndefined();
  });

  it('複製で status / fillColor / textColor も写る', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const t = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().updateDetail(t.id, { status: 'done', fillColor: 'blue', textColor: 'red' });
    const nid = s.getState().duplicateTask(t.id)!;
    const dd = s.getState().project.details[nid]!;
    expect(dd.status).toBe('done');
    expect(dd.fillColor).toBe('blue');
    expect(dd.textColor).toBe('red');
  });

  it('addRootTask は空名のルート工程を作り ID を返す（追加直後に名前を即編集するため）', () => {
    const s = createAppStore();
    const id = s.getState().addRootTask('large');
    expect(id).toBeTruthy();
    const t = s.getState().project.core.tasks[id!]!;
    expect(t.name).toBe(''); // 「新規工程」ではなく空名（即入力・キーボード n と統一）
    expect(t.level).toBe('large');
    expect(t.parentId).toBeUndefined();
  });

  it('addChildTask / addSiblingOf は作成した工程の ID を返す（兄弟はクリック行の直下へ）', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const large = Object.values(s.getState().project.core.tasks)[0]!;
    const childId = s.getState().addChildTask(large.id)!;
    expect(s.getState().project.core.tasks[childId]!.parentId).toBe(large.id);
    const sibId = s.getState().addSiblingOf(childId)!;
    const ordered = Object.values(s.getState().project.core.tasks)
      .filter((t) => t.parentId === large.id)
      .sort((a, b) => a.order - b.order)
      .map((t) => t.id);
    expect(ordered).toEqual([childId, sibId]);
  });

  it('moveLane でレーンを入れ替えると、中のノードが帯ごと移動する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(a, '営業'); // lane 0, y=80
    s.getState().addTask('B');
    const b = Object.values(s.getState().project.core.tasks).find((t) => t.name === 'B')!.id;
    s.getState().setAssigneeByName(b, '倉庫'); // lane 1, y=236
    const eigyo = Object.values(view0(s).lanes).find((l) => l.title === '営業')!;
    s.getState().moveLane(eigyo.id, 1); // 営業を下へ（帯高さは既定 156）
    expect(taskNodes(s).find((n) => n.taskId === a)!.y).toBe(236);
    expect(taskNodes(s).find((n) => n.taskId === b)!.y).toBe(80);
    expect(view0(s).lanes[eigyo.id]!.order).toBe(1);
    s.getState().undo(); // 1 undo で戻る
    expect(taskNodes(s).find((n) => n.taskId === a)!.y).toBe(80);
  });

  it('insertTaskOnEdge: 導出エッジを分割して A→新規→B の依存に置き換える（ラベルも引き継ぐ）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    s.getState().connect(a.id, b.id); // 同粒度の工程どうし＝依存（導出エッジ）
    const edge = Object.values(view0(s).edges).find((e) => e.derivedFromDependencyId)!;
    s.getState().setEdgeLabel(edge.id, '承認時');

    const newId = s.getState().insertTaskOnEdge(edge.id)!;
    expect(newId).toBeDefined();
    const deps = Object.values(s.getState().project.core.dependencies);
    expect(deps).toHaveLength(2);
    expect(deps.some((d) => d.from === a.taskId && d.to === newId)).toBe(true);
    expect(deps.some((d) => d.from === newId && d.to === b.taskId)).toBe(true);
    expect(deps.some((d) => d.from === a.taskId && d.to === b.taskId)).toBe(false); // 元の依存は消える
    // 粒度・担当・親は両端から引き継ぐ（ここでは中・未割当・root）
    const t = s.getState().project.core.tasks[newId]!;
    expect(t.level).toBe('medium');
    // ラベルは reconcile が新 id で導出し直すため、先行側（A→新規）のエッジへ明示コピーされる
    const depFirst = deps.find((d) => d.from === a.taskId && d.to === newId)!;
    const eFirst = Object.values(view0(s).edges).find(
      (e) => e.derivedFromDependencyId === depFirst.id,
    )!;
    expect(eFirst.label).toBe('承認時');
    // 新規工程のノードはビューに存在する（矢印のラベル位置付近に置かれる）
    expect(taskNodes(s).some((n) => n.taskId === newId)).toBe(true);
  });

  it('insertTaskOnEdge: pinned エッジは 2 本に分割（制御ノード側は pinned・同粒度の工程側は依存）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!;
    s.getState().addControlNode('decision');
    const ctrl = Object.values(view0(s).nodes).find((n) => n.kind === 'control')!;
    s.getState().connect(ctrl.id, a.id); // 制御→工程 ＝ pinned エッジ
    const edge = Object.values(view0(s).edges)[0]!;
    expect(edge.pinned).toBe(true);

    const newId = s.getState().insertTaskOnEdge(edge.id)!;
    const view = view0(s);
    expect(view.edges[edge.id]).toBeUndefined(); // 元エッジは消える
    const newNode = taskNodes(s).find((n) => n.taskId === newId)!;
    // 制御 → 新規 は pinned エッジのまま
    expect(
      Object.values(view.edges).some(
        (e) => e.pinned && e.source === ctrl.id && e.target === newNode.id,
      ),
    ).toBe(true);
    // 新規 → A は同粒度の工程どうし ＝ 依存（connect の規約と同じ）
    expect(
      Object.values(s.getState().project.core.dependencies).some(
        (d) => d.from === newId && d.to === a.taskId,
      ),
    ).toBe(true);
  });

  it('insertTaskOnEdge: 1 undo で工程・依存・エッジがまとめて元に戻る', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    s.getState().connect(a.id, b.id);
    const before = serializeProject(s.getState().project);
    const edge = Object.values(view0(s).edges).find((e) => e.derivedFromDependencyId)!;
    const newId = s.getState().insertTaskOnEdge(edge.id)!;
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(3);
    s.getState().undo(); // 1 回で作成・依存分割・配置がすべて戻る
    expect(serializeProject(s.getState().project)).toBe(before);
    expect(s.getState().project.core.tasks[newId]).toBeUndefined();
  });

  it('insertTaskOnEdge: 大またぎブリッジのエッジは no-op（親依存を壊さず工程も増やさない）', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    s.getState().addRootTask('large');
    const [la, lb] = Object.values(s.getState().project.core.tasks)
      .sort((x, y) => x.order - y.order)
      .map((t) => t.id);
    s.getState().addChildTask(la!);
    s.getState().addChildTask(lb!);
    s.getState().addDependency(la!, lb!); // 親(大)同士の依存 → 中の全体ビューにブリッジが出る
    const depId = Object.keys(s.getState().project.core.dependencies)[0]!;
    const view = findView(s.getState().project, 'medium', undefined)!;
    const bridge = Object.values(view.edges).find((e) => e.derivedFromDependencyId === depId)!;
    expect(bridge).toBeDefined();
    const taskCount = Object.keys(s.getState().project.core.tasks).length;

    expect(s.getState().insertTaskOnEdge(bridge.id)).toBeUndefined();
    expect(s.getState().project.core.dependencies[depId]).toBeDefined(); // 親依存は残る
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(taskCount); // 工程は増えない
  });

  it('addDependency: 削除済みの工程を指す id では依存を作らず、strict な再オープンが成功する', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const tasks = Object.values(s.getState().project.core.tasks);
    const a = tasks.find((t) => t.name === 'A')!.id;
    const b = tasks.find((t) => t.name === 'B')!.id;
    s.getState().removeTask(a);
    s.getState().addDependency(a, b); // リピート(mod+.)で stale な id が来た想定
    expect(Object.values(s.getState().project.core.dependencies)).toHaveLength(0);
    const json = serializeProject(s.getState().project);
    expect(() => deserializeProject(json)).not.toThrow(); // 既定 = strict 検証
  });

  it('addTaskWithOptions: 中工程を選択して #大 は root に作られ、大ビューに表示される', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const large = Object.values(s.getState().project.core.tasks)[0]!;
    const childId = s.getState().addChildTask(large.id)!;
    s.getState().select(childId);

    const newId = s.getState().addTaskWithOptions({ name: '新しい大', level: 'large' });
    const t = s.getState().project.core.tasks[newId]!;
    expect(t.level).toBe('large');
    expect(t.parentId).toBeUndefined(); // 「大の子に大」を作らない
    s.getState().setLevel('large');
    const view = findView(s.getState().project, 'large', undefined)!;
    expect(Object.values(view.nodes).some((n) => n.kind === 'task' && n.taskId === newId)).toBe(true);
  });

  it('addTaskWithOptions: 中工程を選択して #小 は選択中の工程が親になる', () => {
    const s = createAppStore();
    s.getState().addTask('受付'); // medium
    const sel = Object.values(s.getState().project.core.tasks)[0]!;
    s.getState().select(sel.id);
    const newId = s.getState().addTaskWithOptions({ name: '記帳', level: 'small' });
    const t = s.getState().project.core.tasks[newId]!;
    expect(t.level).toBe('small');
    expect(t.parentId).toBe(sel.id);
  });

  it('addTaskWithOptions: 小工程を選択して #中 は祖先（大）の子＝選択の親の兄弟になる', () => {
    const s = createAppStore();
    s.getState().addRootTask('large');
    const large = Object.values(s.getState().project.core.tasks)[0]!;
    const midId = s.getState().addChildTask(large.id)!; // medium
    const smallId = s.getState().addChildTask(midId)!; // small
    s.getState().select(smallId);
    const newId = s.getState().addTaskWithOptions({ name: '別の中', level: 'medium' });
    const t = s.getState().project.core.tasks[newId]!;
    expect(t.level).toBe('medium');
    expect(t.parentId).toBe(large.id); // 祖先チェーンから大を解決
  });
});

describe('再監査H-1: 初回導線でフロー表示粒度が最初の工程の粒度に追従する', () => {
  it('空プロジェクトで addRootTask(large) すると表示粒度が大へ追従し、大ノードがフローに出る', () => {
    const s = createAppStore();
    expect(s.getState().level).toBe('medium'); // 既定粒度
    const id = s.getState().addRootTask('large');
    expect(id).toBeTruthy();
    expect(s.getState().level).toBe('large'); // 初回だけ新工程の粒度へ追従
    // 追従先の大ビューに、作った大工程のノードが実在する（「大を作ってもフローに出ない」の解消）。
    const view = findView(s.getState().project, 'large', undefined)!;
    expect(Object.values(view.nodes).some((n) => n.kind === 'task' && n.taskId === id!)).toBe(true);
  });

  it('同じ粒度で作るなら追従は無害（medium のまま）', () => {
    const s = createAppStore();
    s.getState().addRootTask('medium');
    expect(s.getState().level).toBe('medium');
  });

  it('既存プロジェクト（工程あり）では粒度を勝手に切り替えない＝手動配置・現在の粒度を尊重', () => {
    const s = createAppStore();
    s.getState().addTask('受付'); // medium の工程が既にある＝空でない
    expect(s.getState().level).toBe('medium');
    s.getState().addRootTask('large'); // 2 件目は初回導線ではない
    expect(s.getState().level).toBe('medium'); // 追従しない
  });
});

describe('再監査H-2: 選択工程の削除で選択と詳細ペインが固着しない', () => {
  // App.tsx の詳細ペイン表示条件（belt）を純粋述語として再現し、選択が実在するときだけ true。
  const showInspectorLike = (s: ReturnType<typeof createAppStore>) => {
    const st = s.getState();
    const sel = st.selectedTaskId;
    return !!sel && !!st.project.core.tasks[sel];
  };

  it('removeTask: 選択中の工程を削除すると selectedTaskId が解除される（suspenders）', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const id = idByName(s, '受付');
    s.getState().select(id);
    expect(showInspectorLike(s)).toBe(true);
    s.getState().removeTask(id);
    expect(s.getState().selectedTaskId).toBeUndefined();
    expect(showInspectorLike(s)).toBe(false);
  });

  it('removeTask: 別の工程を選択中なら選択は維持される', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = idByName(s, 'A');
    const b = idByName(s, 'B');
    s.getState().select(b);
    s.getState().removeTask(a);
    expect(s.getState().selectedTaskId).toBe(b); // 消えていない選択はそのまま
  });

  it('removeManyTasks: 選択中を含む一括削除で選択が解除される', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = idByName(s, 'A');
    const b = idByName(s, 'B');
    s.getState().select(a);
    s.getState().removeManyTasks([a, b]);
    expect(s.getState().selectedTaskId).toBeUndefined();
    expect(showInspectorLike(s)).toBe(false);
  });

  it('belt: 選択が消えた工程を指していても存在チェックで詳細ペインは開かない', () => {
    const s = createAppStore();
    s.getState().addTask('受付');
    const id = idByName(s, '受付');
    s.getState().removeTask(id);
    s.getState().select(id); // store の自動解除を経ずに stale な id を選択し直す
    expect(s.getState().selectedTaskId).toBe(id); // 選択自体は入る
    expect(showInspectorLike(s)).toBe(false); // が、実在しないので開かない（App 側の belt）
  });
});

describe('UX#6: ノード負座標のクランプと救出', () => {
  it('moveNode は確定時に x/y を 0 未満へクランプする（プレビュー中の負座標は問わない）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const node = taskNodes(s)[0]!;
    s.getState().moveNode(node.id, -50, -30);
    const after = taskNodes(s).find((n) => n.id === node.id)!;
    expect(after.x).toBe(0);
    expect(after.y).toBe(0);
  });

  it('moveNodesBy は選択全体を剛体として動かし、一部が 0 未満になる移動量は削って揃える（個別クランプで形を歪めない）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    const gap = b.x - a.x; // 元の相対距離
    s.getState().moveNodesBy([a.id, b.id], -(a.x + 1000), 0); // そのままなら両方とも大幅に 0 未満
    const aAfter = taskNodes(s).find((n) => n.id === a.id)!;
    const bAfter = taskNodes(s).find((n) => n.id === b.id)!;
    expect(aAfter.x).toBe(0); // 最も左のノードがちょうど境界で止まる
    expect(bAfter.x - aAfter.x).toBe(gap); // 個別クランプではなく全体を平行移動＝相対配置を保つ
    expect(bAfter.x).toBeGreaterThanOrEqual(0);
  });

  it('外部データ等で負座標に取り残されたノードは、全体表示(fitView)と同じ一括オフセットで 0 以上へ救出できる', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const a = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'A')!;
    const b = taskNodes(s).find((n) => s.getState().project.core.tasks[n.taskId]!.name === 'B')!;
    const bx0 = b.x;
    const by0 = b.y;

    // クランプ導入前に保存されたファイルや外部プロセスの書き込みで負座標に取り残された
    // 状況を再現する（reconcile は既存ノードの x/y を据え置くため、loadProject 後も
    // この負座標はそのまま残る＝fitView が救出すべき状況と同じ）。
    const viewKey = (p: ReturnType<typeof s.getState>['project']) =>
      p.flow.byLevel.find(
        (v) => v.level === s.getState().level && (v.scopeParentId ?? undefined) === s.getState().scopeParentId,
      )!;
    const dirty = structuredClone(s.getState().project);
    const an = Object.values(viewKey(dirty).nodes).find(
      (n) => n.kind === 'task' && n.taskId === a.taskId,
    )!;
    an.x = -200;
    an.y = -60;
    s.getState().loadProject(dirty);

    // フロー側 fitView がやるのと同じ計算: 全ノードの最小 x/y を 0 へ合わせるオフセットを
    // moveNodesBy で全ノードへ一括適用する。
    const before = viewKey(s.getState().project);
    let minX = Infinity;
    let minY = Infinity;
    for (const n of Object.values(before.nodes)) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
    }
    expect(minX).toBeLessThan(0); // 再現確認: 救出前は負座標

    const dx = minX < 0 ? -minX : 0;
    const dy = minY < 0 ? -minY : 0;
    s.getState().moveNodesBy(Object.keys(before.nodes), dx, dy);

    const after = viewKey(s.getState().project);
    const aAfter = Object.values(after.nodes).find((n) => n.kind === 'task' && n.taskId === a.taskId)!;
    const bAfter = Object.values(after.nodes).find((n) => n.kind === 'task' && n.taskId === b.taskId)!;
    expect(aAfter.x).toBe(0); // 最も負だったノードがちょうど境界へ
    expect(aAfter.y).toBe(0);
    expect(bAfter.x).toBe(bx0 + dx); // 全体を平行移動＝他ノードとの相対配置は保つ
    expect(bAfter.y).toBe(by0 + dy);
  });
});

describe('taskOps（store と UI をまたぐ手続き）', () => {
  it('confirmRemoveTasks: キャンセルで false（削除しない）、OK で削除して true', async () => {
    useApp.getState().newProject();
    useApp.getState().addTask('受付');
    const id = Object.values(useApp.getState().project.core.tasks)[0]!.id;
    // キャンセル
    let pr = confirmRemoveTasks([id]);
    expect(useUI.getState().dialog?.kind).toBe('confirm');
    useUI.getState().resolveDialog(false);
    expect(await pr).toBe(false);
    expect(useApp.getState().project.core.tasks[id]).toBeDefined();
    // OK（単数形のメッセージ）
    pr = confirmRemoveTasks([id]);
    expect(useUI.getState().dialog?.message).toContain('「受付」');
    useUI.getState().resolveDialog(true);
    expect(await pr).toBe(true);
    expect(useApp.getState().project.core.tasks[id]).toBeUndefined();
  });

  it('confirmRemoveTasks: 複数件は一括削除（1 undo・件数表示）', async () => {
    useApp.getState().newProject();
    useApp.getState().addTask('A');
    useApp.getState().addTask('B');
    const ids = Object.values(useApp.getState().project.core.tasks).map((t) => t.id);
    const pr = confirmRemoveTasks(ids);
    expect(useUI.getState().dialog?.message).toContain('2 件');
    useUI.getState().resolveDialog(true);
    expect(await pr).toBe(true);
    expect(Object.keys(useApp.getState().project.core.tasks)).toHaveLength(0);
    useApp.getState().undo();
    expect(Object.keys(useApp.getState().project.core.tasks)).toHaveLength(2);
  });

  it('revealTask: 選択して粒度を合わせ、詳細パネルを開く（全体俯瞰中はスコープ維持）', () => {
    useApp.getState().newProject();
    useApp.getState().addRootTask('large');
    const large = Object.values(useApp.getState().project.core.tasks)[0]!;
    useUI.getState().setInspectorOpen(false);
    revealTask(large.id);
    expect(useApp.getState().selectedTaskId).toBe(large.id);
    expect(useApp.getState().level).toBe('large');
    expect(useApp.getState().scopeParentId).toBeUndefined();
    expect(useUI.getState().inspectorOpen).toBe(true);
  });

  it('addParallel: 前工程のみコピーし、基準ノードの直下に配置、1 undo で戻る', () => {
    const s = createAppStore();
    for (const n of ['A', 'B', 'C']) s.getState().addTask(n);
    const a = idByName(s, 'A');
    const b = idByName(s, 'B');
    const c = idByName(s, 'C');
    s.getState().addDependency(a, b);
    s.getState().addDependency(b, c);

    const newId = s.getState().addParallel(b)!;
    const deps = Object.values(s.getState().project.core.dependencies);
    expect(deps.some((d) => d.from === a && d.to === newId)).toBe(true); // 前工程コピー
    expect(deps.some((d) => d.from === newId)).toBe(false); // 後続はコピーしない
    const bNode = taskNodes(s).find((n) => n.taskId === b)!;
    const newNode = taskNodes(s).find((n) => n.taskId === newId)!;
    expect(newNode.x).toBe(bNode.x); // 基準と同列
    expect(newNode.y).toBe(bNode.y + ROW_SUB); // 直下のサブ行
    expect(s.getState().selectedTaskId).toBe(newId);

    s.getState().undo(); // 作成と配置が 1 undo 単位
    expect(s.getState().project.core.tasks[newId]).toBeUndefined();
    expect(taskNodes(s)).toHaveLength(3);
  });

  it('addParallel: 連打しても直下の空きへ順に積まれ重ならない', () => {
    const s = createAppStore();
    s.getState().addTask('B');
    const b = idByName(s, 'B');
    const id1 = s.getState().addParallel(b)!;
    const id2 = s.getState().addParallel(b)!;
    const n1 = taskNodes(s).find((n) => n.taskId === id1)!;
    const n2 = taskNodes(s).find((n) => n.taskId === id2)!;
    expect(n1.y).not.toBe(n2.y);
  });

  it('addParallel: 既定のレーン高さでは収まらない場合、元工程と同じレーン内に収まるようレーン高さを自動拡張する（実機FB）', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = idByName(s, 'A');
    s.getState().setAssigneeByName(a, '営業'); // lane0, y=80（既定高さ156）
    s.getState().addTask('B');
    const b = idByName(s, 'B');
    s.getState().setAssigneeByName(b, '倉庫'); // lane1, y=236

    const newId = s.getState().addParallel(a)!;
    const lane0 = Object.values(view0(s).lanes).find((l) => l.order === 0)!;
    const box0 = laneLayout(view0(s).lanes).find((bx) => bx.lane.id === lane0.id)!;
    const newNode = taskNodes(s).find((n) => n.taskId === newId)!;
    const bNode = taskNodes(s).find((n) => n.taskId === b)!;

    // 新ノードは元工程(A)と同じレーンの範囲内に収まる（次レーンへはみ出さない＝実機FBの再現条件）。
    expect(newNode.y).toBeGreaterThanOrEqual(box0.top);
    expect(newNode.y + SIZE.task.h).toBeLessThanOrEqual(box0.top + box0.height);

    expect(newNode.y).toBe(144); // 直下のサブ行自体は従来どおり（A.y=80 + ROW_SUB=64）
    expect(view0(s).lanes[lane0.id]!.height).toBe(220); // 156→220 = 2 段ぶんへ自動拡張
    expect(bNode.y).toBe(300); // 拡張ぶん、下のレーン(倉庫)は連動シフト（236+64）

    s.getState().undo(); // 作成・配置・レーン拡張が 1 undo 単位でまとめて戻る
    expect(view0(s).lanes[lane0.id]!.height).toBeUndefined();
    expect(taskNodes(s).find((n) => n.taskId === b)!.y).toBe(236);
  });

  it('makeParallelTo: X→Y→B→C が X→{Y,B}→C になり、B は基準の直下へ寄る', () => {
    const s = createAppStore();
    for (const n of ['X', 'Y', 'B', 'C']) s.getState().addTask(n);
    const x = idByName(s, 'X');
    const y = idByName(s, 'Y');
    const b = idByName(s, 'B');
    const c = idByName(s, 'C');
    s.getState().addDependency(x, y);
    s.getState().addDependency(y, b);
    s.getState().addDependency(b, c);

    s.getState().makeParallelTo(b, y);
    expect(depPairs(s)).toEqual(['B→C', 'X→B', 'X→Y', 'Y→C']);
    const yNode = taskNodes(s).find((n) => n.taskId === y)!;
    const bNode = taskNodes(s).find((n) => n.taskId === b)!;
    expect(bNode.x).toBe(yNode.x);
    expect(bNode.y).toBe(yNode.y + ROW_SUB);

    s.getState().undo(); // 依存付け替えと配置が 1 undo 単位
    expect(depPairs(s)).toEqual(['B→C', 'X→Y', 'Y→B']);
  });

  it('makeParallelTo: 同一工程・粒度違いは no-op（履歴も汚さない）', () => {
    const s = createAppStore();
    s.getState().addTask('B');
    const b = idByName(s, 'B');
    const canUndoBefore = s.getState().canUndo;
    const json = serializeProject(s.getState().project);
    s.getState().makeParallelTo(b, b);
    expect(serializeProject(s.getState().project)).toBe(json);
    expect(s.getState().canUndo).toBe(canUndoBefore);
  });

  it('addMilestone: kind:milestone で作成・選択し、子工程/担当/工数を持たない', () => {
    const s = createAppStore();
    const id = s.getState().addMilestone()!;
    expect(id).toBeTruthy();
    const t = s.getState().project.core.tasks[id]!;
    expect(t.kind).toBe('milestone');
    expect(t.assigneeId).toBeUndefined();
    expect(s.getState().project.details[id]?.effortMinutes).toBeUndefined();
    expect(s.getState().selectedTaskId).toBe(id); // 作成後に自動選択
    // 現在ビューの level/scope で作成（表/フロー/パレットのどこから呼んでも同じ）。
    expect(t.level).toBe(s.getState().level);
    expect(t.parentId).toBe(s.getState().scopeParentId);
    // タスクノードは1個だけ保持（1:1 不変条件）。
    expect(taskNodes(s).filter((n) => n.taskId === id)).toHaveLength(1);
  });

  it('addMilestone: 位置指定なしは複数追加しても重ならない（未紐付け時の段積み）', () => {
    const s = createAppStore();
    const id1 = s.getState().addMilestone()!;
    const id2 = s.getState().addMilestone()!;
    const n1 = taskNodes(s).find((n) => n.taskId === id1)!;
    const n2 = taskNodes(s).find((n) => n.taskId === id2)!;
    expect(n1.x).not.toBe(n2.x);
  });

  it('addMilestone: 位置を渡すとその位置に置く（フロー追加ボタン相当）', () => {
    const s = createAppStore();
    const id = s.getState().addMilestone(300, 40)!;
    const n = taskNodes(s).find((nn) => nn.taskId === id)!;
    expect(n.x).toBe(300);
    expect(n.y).toBe(40);
  });

  it('addMilestone: duplicateTask で複製しても kind:milestone を保つ', () => {
    const s = createAppStore();
    const id = s.getState().addMilestone()!;
    const dupId = s.getState().duplicateTask(id)!;
    expect(s.getState().project.core.tasks[dupId]!.kind).toBe('milestone');
  });

  it('revealTask: スコープ絞り込み中は対象工程の親へスコープを追従させる', () => {
    useApp.getState().newProject();
    useApp.getState().addRootTask('large');
    const large = Object.values(useApp.getState().project.core.tasks)[0]!;
    const childId = useApp.getState().addChildTask(large.id)!;
    useApp.getState().addRootTask('large');
    const other = Object.values(useApp.getState().project.core.tasks).find(
      (t) => t.level === 'large' && t.id !== large.id,
    )!;
    useApp.getState().setLevel('medium');
    useApp.getState().setScope(other.id); // 別の親に絞っている状態からジャンプ
    revealTask(childId);
    expect(useApp.getState().selectedTaskId).toBe(childId);
    expect(useApp.getState().level).toBe('medium');
    expect(useApp.getState().scopeParentId).toBe(large.id);
  });
});

describe('同期フラッシュ用の一時 state（lastSyncAdded / lastAssigneeSync）', () => {
  it('表側編集の commit で追加ノードが lastSyncAdded に入り、連続編集で seq が進む', () => {
    const s = createAppStore();
    expect(s.getState().lastSyncAdded.seq).toBe(0);
    s.getState().addTask('A');
    const first = s.getState().lastSyncAdded;
    expect(first.seq).toBe(1);
    expect(first.ids).toHaveLength(1);
    expect(view0(s).nodes[first.ids[0]!]?.kind).toBe('task');
    s.getState().addTask('B');
    const second = s.getState().lastSyncAdded;
    expect(second.seq).toBe(2);
    expect(second.ids).not.toEqual(first.ids); // 最新の追加だけが光る
  });

  it('ノード追加を伴わない編集（リネーム等）では lastSyncAdded を更新しない', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const before = s.getState().lastSyncAdded;
    s.getState().renameTask(taskNodes(s)[0]!.taskId, 'A2');
    expect(s.getState().lastSyncAdded).toBe(before); // 参照ごと不変＝光り直さない
  });

  it('I/O 追加では同期で生えた doc ノードが lastSyncAdded に入る', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addIo(taskNodes(s)[0]!.taskId, 'inputs', '注文書');
    const { ids } = s.getState().lastSyncAdded;
    expect(ids).toHaveLength(1);
    expect(view0(s).nodes[ids[0]!]?.kind).toBe('doc');
  });

  it('フロー上の直接操作（addTaskAt）では lastSyncAdded は進まない', () => {
    const s = createAppStore();
    s.getState().addTaskAt(300, 100);
    expect(Object.keys(s.getState().project.core.tasks)).toHaveLength(1);
    expect(s.getState().lastSyncAdded.seq).toBe(0);
  });

  it('レーン移動の逆同期（担当書き戻し）で lastAssigneeSync に工程 id が入る', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    const a = taskNodes(s)[0]!.taskId;
    s.getState().setAssigneeByName(a, '営業');
    s.getState().addTask('B');
    const b = Object.values(s.getState().project.core.tasks).find((t) => t.name === 'B')!.id;
    s.getState().setAssigneeByName(b, '倉庫');
    expect(s.getState().lastAssigneeSync.seq).toBe(0); // 表側からの担当変更では光らせない

    const view = view0(s);
    const souko = Object.values(view.lanes).find((l) => l.title === '倉庫')!;
    const aNode = taskNodes(s).find((n) => n.taskId === a)!;
    s.getState().moveNode(aNode.id, 300, 40 + souko.order * 120);
    expect(s.getState().lastAssigneeSync).toEqual({ ids: [a], seq: 1 });
  });

  it('レーンをまたがないノード移動では lastAssigneeSync は進まない', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().setAssigneeByName(taskNodes(s)[0]!.taskId, '営業');
    const node = taskNodes(s)[0]!;
    s.getState().moveNode(node.id, node.x + 50, node.y); // 同じレーン内の横移動
    expect(s.getState().lastAssigneeSync.seq).toBe(0);
  });
});

// migration-safety Critical 回帰防止: プロジェクト切替アクションは assetStore を「全消し」ではなく
// 「新プロジェクトが参照する画像だけ残すプルーン」で処理する。開くフローは persistence が
// ingestAssets（画像をメモリへ）した後に store.loadProject を呼ぶため、全消しにすると開いた
// 直後に画像が消え、次の保存で ZIP からも永久消失する（100% 再現の Critical）。
describe('画像 assetStore の参照保持プルーン（開いた直後の画像消失防止 / Critical）', () => {
  beforeEach(() => __resetAssetStoreForTest());
  afterEach(() => __resetAssetStoreForTest());

  // 手順書に画像を 1 枚貼った Project を作って返す（bytes と 内容ハッシュ由来の file 名も返す）。
  // 副作用で assetStore にも bytes が入るが、各テストは直後に reset して開くフローを組み立て直す。
  const seedProjectWithImage = () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const mime = 'image/png';
    const file = contentHashName(bytes, mime);
    const s = createAppStore();
    s.getState().addTask('工程');
    const taskId = Object.keys(s.getState().project.core.tasks)[0]!;
    s.getState().upsertProcedurePurpose(taskId, '');
    const stepId = s.getState().addStep(taskId, { action: 'x' })!;
    s.getState().addStepImage(taskId, stepId, bytes, mime);
    return { project: s.getState().project, bytes, file };
  };

  it('ingestAssets → loadProject の順でも、新プロジェクトが参照する画像が生存する（Critical 再発防止）', () => {
    const { project, bytes, file } = seedProjectWithImage();
    const app = createAppStore();
    // 開くフローを再現: メモリを空にしてから persistence が先に取り込み、次に store.loadProject。
    __resetAssetStoreForTest();
    expect(hasAsset(file)).toBe(false);
    ingestAssets({ [file]: bytes }); // openProjectFromFile 相当（loadProject より前に取り込む）
    app.getState().loadProject(project); // 後から load しても開いたばかりの画像を消さない
    expect(hasAsset(file)).toBe(true);
  });

  it('restoreProject（同一プロジェクトの復元）でも参照画像が生存する', () => {
    const { project, bytes, file } = seedProjectWithImage();
    const app = createAppStore();
    __resetAssetStoreForTest();
    ingestAssets({ [file]: bytes });
    app.getState().restoreProject(project);
    expect(hasAsset(file)).toBe(true);
  });

  it('newProject 等の切替では前プロジェクトの画像がプルーンされる（メモリ回収の意図固定）', () => {
    putAsset('old-project-image.png', new Uint8Array([9, 9, 9])); // 前プロジェクトの画像
    expect(hasAsset('old-project-image.png')).toBe(true);
    createAppStore().getState().newProject(); // 新規プロジェクトは画像を参照しない＝keep は空
    expect(hasAsset('old-project-image.png')).toBe(false);
  });

  it('loadProject: 前プロジェクトの画像は落とし、開いたファイルの画像だけ残す（同時確認）', () => {
    const { project, bytes, file } = seedProjectWithImage();
    const app = createAppStore();
    __resetAssetStoreForTest();
    putAsset('stale-from-previous.png', new Uint8Array([7, 7])); // 前プロジェクトの遺物
    ingestAssets({ [file]: bytes }); // これから開くファイルの画像
    app.getState().loadProject(project);
    expect(hasAsset(file)).toBe(true); // 開いたファイルの参照画像は生存
    expect(hasAsset('stale-from-previous.png')).toBe(false); // 参照外の前プロジェクト画像は回収
  });
});
