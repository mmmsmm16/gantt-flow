// 表の行選択モードのアクション本体（runTableAction）。DOM に依存しない分岐を直接検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Id } from '@gantt-flow/core';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';
import { runTableAction, type RowSelectionOpts } from '../src/ui/useRowSelectionKeys';

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
