// 表の行選択モードのアクション本体（runTableAction）。DOM に依存しない分岐を直接検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Id } from '@gantt-flow/core';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';
import {
  runTableAction,
  resolveEditNavTarget,
  type RowSelectionOpts,
} from '../src/ui/useRowSelectionKeys';

const col = { get: () => 0, set: () => {} };
const optsOf = (orderedIds: Id[], beginEdit: (id: Id) => void = () => {}): RowSelectionOpts => ({
  enabled: true,
  orderedIds,
  columns: [],
  beginEdit,
});

const tasksByName = (name: string) =>
  Object.values(useApp.getState().project.core.tasks).find((t) => t.name === name)!;

beforeEach(() => {
  useApp.getState().newProject();
  // 前のテストのダイアログ/折りたたみ状態を持ち越さない。
  if (useUI.getState().dialog) useUI.getState().resolveDialog(false);
  useUI.getState().setOutlineCollapsed(new Set());
});

describe('runTableAction: table.addChild', () => {
  it('折りたたまれた親に子を追加すると展開され、新しい子が選択・編集開始される', () => {
    useApp.getState().addRootTask('large');
    const parent = Object.values(useApp.getState().project.core.tasks)[0]!.id;
    const existing = useApp.getState().addChildTask(parent)!;
    useUI.getState().setOutlineCollapsed(new Set([parent]));
    useApp.getState().select(parent);

    const edited: Id[] = [];
    const handled = runTableAction('table.addChild', optsOf([parent], (id) => edited.push(id)), col);

    expect(handled).toBe(true);
    const children = Object.values(useApp.getState().project.core.tasks).filter(
      (t) => t.parentId === parent,
    );
    expect(children).toHaveLength(2);
    const nid = useApp.getState().selectedTaskId!;
    expect(nid).not.toBe(existing);
    expect(children.map((c) => c.id)).toContain(nid);
    // 親が展開されて新しい行が見える＋編集フォーカスが要求される。
    expect(useUI.getState().outlineCollapsed.has(parent)).toBe(false);
    expect(edited).toEqual([nid]);
  });

  it('展開済みの親はそのまま（折りたたみ集合に触れない）', () => {
    useApp.getState().addRootTask('large');
    const parent = Object.values(useApp.getState().project.core.tasks)[0]!.id;
    useApp.getState().select(parent);
    const before = useUI.getState().outlineCollapsed;

    runTableAction('table.addChild', optsOf([parent]), col);
    expect(useUI.getState().outlineCollapsed).toBe(before);
  });
});

describe('runTableAction: table.delete', () => {
  it('共通の確認ダイアログ（confirmRemoveTasks）を経由し、OK で削除して近い行へ選択を移す', async () => {
    useApp.getState().addTask('A');
    useApp.getState().addTask('B');
    const a = tasksByName('A').id;
    const b = tasksByName('B').id;
    useApp.getState().select(a);

    const handled = runTableAction('table.delete', optsOf([a, b]), col);
    expect(handled).toBe(true);
    expect(useUI.getState().dialog?.kind).toBe('confirm');
    expect(useUI.getState().dialog?.message).toContain('「A」');
    useUI.getState().resolveDialog(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(useApp.getState().project.core.tasks[a]).toBeUndefined();
    expect(useApp.getState().selectedTaskId).toBe(b);
  });

  it('キャンセルでは削除せず選択も動かさない', async () => {
    useApp.getState().addTask('A');
    const a = tasksByName('A').id;
    useApp.getState().select(a);

    runTableAction('table.delete', optsOf([a]), col);
    useUI.getState().resolveDialog(false);
    await new Promise((r) => setTimeout(r, 0));

    expect(useApp.getState().project.core.tasks[a]).toBeDefined();
    expect(useApp.getState().selectedTaskId).toBe(a);
  });

  it('最後の 1 行を削除すると選択は解除される', async () => {
    useApp.getState().addTask('A');
    const a = tasksByName('A').id;
    useApp.getState().select(a);

    runTableAction('table.delete', optsOf([a]), col);
    useUI.getState().resolveDialog(true);
    await new Promise((r) => setTimeout(r, 0));

    expect(useApp.getState().project.core.tasks[a]).toBeUndefined();
    expect(useApp.getState().selectedTaskId).toBeUndefined();
  });
});

describe('runTableAction: table.find(クイックフィルタ)', () => {
  it('openFind があれば行ゼロでも開く(絞り込み 0 件の状態からも解除できる)', () => {
    let opened = 0;
    const opts: RowSelectionOpts = {
      ...optsOf([]),
      openFind: () => {
        opened += 1;
        return true;
      },
    };
    expect(runTableAction('table.find', opts, col)).toBe(true);
    expect(opened).toBe(1);
  });

  it('openFind が無いビュー(全項目表)でもキーを奪い、案内トーストを出す(ブラウザ検索に素通りさせない)', () => {
    const before = useUI.getState().toasts.length;
    expect(runTableAction('table.find', optsOf(['x']), col)).toBe(true);
    const toasts = useUI.getState().toasts;
    expect(toasts.length).toBe(before + 1);
    expect(toasts[toasts.length - 1]!.message).toContain('アウトライン表示');
  });
});

describe('resolveEditNavTarget: 編集中の Enter/Tab セル移動(移動先の解決)', () => {
  const grid = { orderedIds: ['r1', 'r2', 'r3'], columns: ['level', 'name', 'assignee', 'effort'] };

  it('down は同列の次行へ。編集できない行(tryFocus=false)は飛ばす', () => {
    const hit = resolveEditNavTarget(
      grid,
      { taskId: 'r1', colKey: 'name' },
      'down',
      (id) => id !== 'r2', // r2 は親行などで編集不可とみなす
    );
    expect(hit).toEqual({ taskId: 'r3', colKey: 'name' });
  });

  it('up は前の行へ。先頭で移動先が無ければ null', () => {
    expect(resolveEditNavTarget(grid, { taskId: 'r2', colKey: 'name' }, 'up', () => true)).toEqual({
      taskId: 'r1',
      colKey: 'name',
    });
    expect(resolveEditNavTarget(grid, { taskId: 'r1', colKey: 'name' }, 'up', () => true)).toBeNull();
  });

  it('right/left は同じ行で編集可能な列だけを辿る(select 等のセルはスキップ)', () => {
    const editable = new Set(['name', 'effort']);
    const probe = (_: string, key: string) => editable.has(key);
    expect(resolveEditNavTarget(grid, { taskId: 'r1', colKey: 'name' }, 'right', probe)).toEqual({
      taskId: 'r1',
      colKey: 'effort', // assignee(編集不可扱い)を飛ばす
    });
    expect(resolveEditNavTarget(grid, { taskId: 'r1', colKey: 'effort' }, 'left', probe)).toEqual({
      taskId: 'r1',
      colKey: 'name',
    });
    // 左に編集可能セルが無ければ移動しない(level は select なのでスキップ)
    expect(resolveEditNavTarget(grid, { taskId: 'r1', colKey: 'name' }, 'left', probe)).toBeNull();
  });

  it('行・列が見つからないときは null(フィルタ等で行が消えた直後の取りこぼし防止)', () => {
    expect(resolveEditNavTarget(grid, { taskId: 'zz', colKey: 'name' }, 'down', () => true)).toBeNull();
    expect(resolveEditNavTarget(grid, { taskId: 'r1', colKey: 'zz' }, 'right', () => true)).toBeNull();
  });

  it('最終行の down は移動先なし(null)＝末尾ゴースト行(onEditNavPastEnd)を起動する境界', () => {
    // handleEditNav はこの null を見て、Enter かつ down なら onEditNavPastEnd() を呼ぶ。
    expect(resolveEditNavTarget(grid, { taskId: 'r3', colKey: 'name' }, 'down', () => true)).toBeNull();
  });
});
