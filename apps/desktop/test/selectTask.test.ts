// C-01: 行クリックは選択だけ（詳細パネルを開かない）。詳細を開くのはダブルクリック/トグル/コマンド。
// 表の行クリックは selectTask（onActivate）、ダブルクリックは revealTask を呼ぶ。ここでは両者の
// 「インスペクタを開くか」「選択・粒度同期」を store/useUI へ直接ドライブして検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import { selectTask, revealTask } from '../src/taskOps';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';

const idByName = (name: string) =>
  Object.values(useApp.getState().project.core.tasks).find((t) => t.name === name)!.id;

describe('selectTask / revealTask: クリックは開かない・ダブルクリックで開く（C-01）', () => {
  beforeEach(() => {
    useApp.getState().newProject();
    useUI.getState().setInspectorOpen(false);
  });

  it('selectTask は選択するが詳細パネルを開かない（クリック相当）', () => {
    useApp.getState().addTask('A');
    const a = idByName('A');

    selectTask(a);

    expect(useApp.getState().selectedTaskId).toBe(a);
    expect(useUI.getState().inspectorOpen).toBe(false); // クリックでは開かない
  });

  it('selectTask は対象工程へ粒度を同期する（フローの対応ノードを見せるため）', () => {
    useApp.getState().addTask('A');
    const a = idByName('A');
    useApp.getState().setTaskLevel(a, 'small'); // 表示中の粒度と別の粒度へ
    expect(useApp.getState().project.core.tasks[a]!.level).toBe('small');

    selectTask(a);

    expect(useApp.getState().level).toBe('small');
  });

  it('revealTask は詳細パネルを開く（ダブルクリック/パレット相当）', () => {
    useApp.getState().addTask('A');
    const a = idByName('A');

    revealTask(a);

    expect(useApp.getState().selectedTaskId).toBe(a);
    expect(useUI.getState().inspectorOpen).toBe(true);
  });

  it('詳細パネルが開いている間はクリック（selectTask）で表示対象を切り替える（開いたまま）', () => {
    useApp.getState().addTask('A');
    useApp.getState().addTask('B');
    const a = idByName('A');
    const b = idByName('B');

    revealTask(a); // まず開く
    expect(useUI.getState().inspectorOpen).toBe(true);
    expect(useApp.getState().selectedTaskId).toBe(a);

    selectTask(b); // 開いている間のクリック＝対象切替（開き直さない・閉じない）
    expect(useApp.getState().selectedTaskId).toBe(b);
    expect(useUI.getState().inspectorOpen).toBe(true);
  });

  it('存在しない ID は無視（選択も開閉も変えない）', () => {
    selectTask('nope');
    expect(useApp.getState().selectedTaskId).toBeUndefined();
    expect(useUI.getState().inspectorOpen).toBe(false);
    revealTask('nope');
    expect(useUI.getState().inspectorOpen).toBe(false);
  });
});
