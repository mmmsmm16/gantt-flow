// 操作快適性バッチ3: フロー・状態退避・store フィードバックの回帰テスト。
// 対象: #4 ビューポート退避 / #10 undo 端案内・件数ラベル / 段積みオフセット / 自動整列の無差分スキップ /
//       #26 フィルタ保持 / marked ミラー / #5 revealTask のフロー可視化 / マイルストーン作成でインスペクタ。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Id } from '@gantt-flow/core';
import { createAppStore, findView, useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';
import { revealTask } from '../src/taskOps';
import { saveFlowViewport, loadFlowViewport, clearFlowViewport } from '../src/flowZoom';

type Store = ReturnType<typeof createAppStore>;
const lastToast = (): string => useUI.getState().toasts.at(-1)?.message ?? '';
const taskIds = (s: Store): Id[] => Object.values(s.getState().project.core.tasks).map((t) => t.id);

beforeEach(() => useUI.setState({ toasts: [], inspectorOpen: false, activePane: 'table', outlineFilter: '', markedTaskIds: [] }));

describe('#4 flowZoom ビューポート退避', () => {
  it('save→load でラウンドトリップ、clear で破棄', () => {
    clearFlowViewport();
    expect(loadFlowViewport()).toBeNull();
    saveFlowViewport({ scale: 1.6, left: 240, top: 120 });
    expect(loadFlowViewport()).toEqual({ scale: 1.6, left: 240, top: 120 });
    clearFlowViewport();
    expect(loadFlowViewport()).toBeNull();
  });
});

describe('#10 undo/redo 端の案内と一括ラベルの件数', () => {
  it('履歴の端では案内トースト（無反応にしない）', () => {
    const s = createAppStore();
    s.getState().undo();
    expect(lastToast()).toBe('これ以上戻せません');
    s.getState().redo();
    expect(lastToast()).toBe('これ以上やり直せません');
  });

  it('複数削除・複数担当は件数入りラベル', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    const ids = taskIds(s);
    s.getState().setAssigneeManyByName(ids, '営業');
    s.getState().undo();
    expect(lastToast()).toBe('元に戻しました: 2件の担当を変更');
    s.getState().redo();
    s.getState().removeManyTasks(ids);
    s.getState().undo();
    expect(lastToast()).toBe('元に戻しました: 2件を削除');
  });
});

describe('段積みオフセット: 連続追加が真上に重ならない', () => {
  it('同一中心へ制御ノードを 2 つ追加してもズレて置かれる', () => {
    const s = createAppStore();
    s.getState().addControlNode('decision', 400, 200);
    s.getState().addControlNode('merge', 400, 200);
    const view = findView(s.getState().project, 'medium', undefined)!;
    const ctrls = Object.values(view.nodes).filter((n) => n.kind === 'control');
    expect(ctrls).toHaveLength(2);
    expect(ctrls[0]!.x !== ctrls[1]!.x || ctrls[0]!.y !== ctrls[1]!.y).toBe(true);
  });

  it('同一中心へ付箋を 2 つ追加してもズレて置かれる', () => {
    const s = createAppStore();
    s.getState().addComment('a', 400, 300);
    s.getState().addComment('b', 400, 300);
    const view = findView(s.getState().project, 'medium', undefined)!;
    const notes = Object.values(view.nodes).filter((n) => n.kind === 'comment');
    expect(notes).toHaveLength(2);
    expect(notes[0]!.x !== notes[1]!.x || notes[0]!.y !== notes[1]!.y).toBe(true);
  });
});

describe('#8 自動整列の無差分スキップ', () => {
  it('整列後は wouldTidyFlow が false で、再整列は履歴を汚さない no-op', () => {
    const s = createAppStore();
    s.getState().addTask('A');
    s.getState().addTask('B');
    // 整列対象になるのは依存を持つ工程だけ（孤立ノードは手動配置を保持）。A→B を張ってから外す。
    const [a, b] = taskIds(s);
    s.getState().addDependency(a!, b!);
    const view0 = findView(s.getState().project, 'medium', undefined)!;
    const node = Object.values(view0.nodes).find((n) => n.kind === 'task')!;
    s.getState().moveNode(node.id, 720, 520); // わざと整列位置から外す
    expect(s.getState().wouldTidyFlow()).toBe(true);
    s.getState().tidyFlow();
    expect(s.getState().wouldTidyFlow()).toBe(false);
    const p = s.getState().project;
    s.getState().tidyFlow(); // 差分なし → 参照不変（履歴 push なし）
    expect(s.getState().project).toBe(p);
  });
});

describe('#10 マイルストーン作成で詳細パネルを開く', () => {
  it('addMilestone で inspectorOpen が true になる', () => {
    const s = createAppStore();
    s.getState().addMilestone(120, 40);
    expect(useUI.getState().inspectorOpen).toBe(true);
  });
});

describe('#26 フィルタ保持 / marked ミラー（useUI）', () => {
  it('outlineFilter を保持する', () => {
    useUI.getState().setOutlineFilter('検収');
    expect(useUI.getState().outlineFilter).toBe('検収');
  });

  it('markedTaskIds を保持し、空→空の更新はスキップ（参照維持）', () => {
    useUI.getState().setMarkedTaskIds(['a', 'b']);
    expect(useUI.getState().markedTaskIds).toEqual(['a', 'b']);
    useUI.getState().setMarkedTaskIds([]);
    const emptyRef = useUI.getState().markedTaskIds;
    useUI.getState().setMarkedTaskIds([]);
    expect(useUI.getState().markedTaskIds).toBe(emptyRef);
  });
});

describe('#5 revealTask のフロー可視化', () => {
  it('revealInFlow のときだけ activePane を flow に倒す', () => {
    useApp.getState().newProject();
    useApp.getState().addTask('X');
    const id = Object.values(useApp.getState().project.core.tasks)[0]!.id;

    useUI.setState({ activePane: 'table' });
    revealTask(id); // 通常経路は倒さない
    expect(useUI.getState().activePane).toBe('table');

    revealTask(id, { revealInFlow: true });
    expect(useUI.getState().activePane).toBe('flow');
  });
});
