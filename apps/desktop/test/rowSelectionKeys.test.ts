// 表の行選択モードのアクション本体（runTableAction）。DOM に依存しない分岐を直接検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Id } from '@gantt-flow/core';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';
import {
  runTableAction,
  resolveEditNavTarget,
  resolveTabWrapTarget,
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

// H-3 再監査: セル編集中の Tab/Shift+Tab は「行内に移動先が無い」で無反応にならず、
// 次/前の行の先頭/末尾の編集可能セルへ折返す。それも無い(表の端)ときだけ null を返し、
// handleEditNav はネイティブの Tab へフォールバックする(preventDefault しない)。
describe('resolveTabWrapTarget: Tab/Shift+Tab の行またぎ折返し(H-3)', () => {
  const grid = { orderedIds: ['r1', 'r2', 'r3'], columns: ['level', 'name', 'assignee', 'effort'] };
  // 行ごとの「編集可能セル」を模した表(select-only 列や丸ごと編集不可の行を混在させる)。
  //  r1: level(select-only) / name・assignee・effort は編集可
  //  r2: level・assignee(select-only) / name・effort は編集可
  //  r3: level(select-only) / name・assignee・effort は編集可
  const editable: Record<string, Set<string>> = {
    r1: new Set(['name', 'assignee', 'effort']),
    r2: new Set(['name', 'effort']),
    r3: new Set(['name', 'assignee', 'effort']),
  };
  const tryFocus = (taskId: string, colKey: string) => editable[taskId]?.has(colKey) ?? false;

  const cases: {
    label: string;
    from: { taskId: string; colKey: string };
    dir: 'left' | 'right';
    expected: { taskId: string; colKey: string } | null;
  }[] = [
    {
      label: '行の途中の Tab: 同じ行内の次の編集可能列へ(select-only の assignee は無関係にそのまま採用)',
      from: { taskId: 'r1', colKey: 'name' },
      dir: 'right',
      expected: { taskId: 'r1', colKey: 'assignee' },
    },
    {
      label: '行の途中の Tab: 直後の列が select-only(編集不可)ならさらに先の編集可能列まで飛ばす',
      from: { taskId: 'r2', colKey: 'name' },
      dir: 'right',
      expected: { taskId: 'r2', colKey: 'effort' }, // assignee(select-only)を飛ばす
    },
    {
      label: '行末の Tab: 同じ行に移動先が無ければ次の行へ折返し、先頭列(select-only)を飛ばして最初の編集可能セルへ',
      from: { taskId: 'r1', colKey: 'effort' },
      dir: 'right',
      expected: { taskId: 'r2', colKey: 'name' }, // r2 の level(select-only)を飛ばす
    },
    {
      label: '最終行・最終セルの Tab: 折返し先が無い(表の本当の行き止まり)＝null',
      from: { taskId: 'r3', colKey: 'effort' },
      dir: 'right',
      expected: null,
    },
    {
      label: 'Shift+Tab(対称): 行の途中は同じ行内の前の編集可能列へ',
      from: { taskId: 'r1', colKey: 'effort' },
      dir: 'left',
      expected: { taskId: 'r1', colKey: 'assignee' },
    },
    {
      label: 'Shift+Tab(対称): 行頭で移動先が無ければ前の行へ折返し、末尾列から編集可能セルを探す',
      from: { taskId: 'r2', colKey: 'name' }, // 左の level は r2 で select-only
      dir: 'left',
      expected: { taskId: 'r1', colKey: 'effort' },
    },
    {
      label: 'Shift+Tab(対称): 先頭行・先頭セルは折返し先が無い(表の本当の行き止まり)＝null',
      from: { taskId: 'r1', colKey: 'name' }, // 左の level は r1 で select-only、前の行も無い
      dir: 'left',
      expected: null,
    },
  ];

  it.each(cases)('$label', ({ from, dir, expected }) => {
    expect(resolveTabWrapTarget(grid, from, dir, tryFocus)).toEqual(expected);
  });

  it('折返し先の行が丸ごと編集不可なら、そこも飛ばしてさらに次の行まで進む', () => {
    const wideGrid = { orderedIds: ['r1', 'r2', 'r3'], columns: ['name'] };
    const onlyR1AndR3 = (taskId: string) => taskId !== 'r2';
    expect(
      resolveTabWrapTarget(wideGrid, { taskId: 'r1', colKey: 'name' }, 'right', onlyR1AndR3),
    ).toEqual({ taskId: 'r3', colKey: 'name' });
  });
});
