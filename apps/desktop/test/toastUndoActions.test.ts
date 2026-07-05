// 破壊的操作の完了トーストに「元に戻す」アクションを付ける配線（C-07/#40）。
// taskOps の共通ヘルパ（toastUndo / removeIoWithUndo / removeIssueWithUndo / confirmRemoveTasks）が
// 削除後にアクション付きトーストを出し、そのアクションが undo を一発で実行することを検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Id } from '@gantt-flow/core';
import {
  toastUndo,
  removeIoWithUndo,
  removeIssueWithUndo,
  confirmRemoveTasks,
} from '../src/taskOps';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';

const idByName = (name: string): Id =>
  Object.values(useApp.getState().project.core.tasks).find((t) => t.name === name)!.id;
const lastToast = () => useUI.getState().toasts.at(-1);
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useApp.getState().newProject();
  useUI.setState({ toasts: [] });
});

describe('taskOps: 破壊的操作の「元に戻す」トースト', () => {
  it('toastUndo は「元に戻す」アクション付きトーストを出し、押すと undo が走る', () => {
    useApp.getState().addTask('A');
    const before = useApp.getState().project.core.tasks;
    expect(Object.keys(before)).toHaveLength(1);

    toastUndo('テスト削除しました');
    const t = lastToast();
    expect(t?.message).toBe('テスト削除しました');
    expect(t?.action?.label).toBe('元に戻す');

    t!.action!.run(); // = useApp.undo()
    expect(Object.keys(useApp.getState().project.core.tasks)).toHaveLength(0);
  });

  it('removeIoWithUndo: 入出力を削除し、アクションで復活する', () => {
    useApp.getState().addTask('工程');
    const id = idByName('工程');
    useApp.getState().addIo(id, 'inputs', '受注票');
    const ioId = useApp.getState().project.details[id]!.inputs![0]!.id;

    removeIoWithUndo(id, ioId);
    expect(useApp.getState().project.details[id]?.inputs ?? []).toHaveLength(0);
    const t = lastToast();
    expect(t?.message).toBe('入出力を削除しました');
    expect(t?.action?.label).toBe('元に戻す');

    t!.action!.run();
    const inputs = useApp.getState().project.details[id]!.inputs!;
    expect(inputs.map((i) => i.name)).toEqual(['受注票']);
  });

  it('removeIssueWithUndo: 課題を削除し、アクションで復活する', () => {
    useApp.getState().addTask('工程');
    const id = idByName('工程');
    useApp.getState().addIssue(id, '手作業が多い');
    const issueId = useApp.getState().project.details[id]!.issues![0]!.id;

    removeIssueWithUndo(id, issueId);
    expect(useApp.getState().project.details[id]?.issues ?? []).toHaveLength(0);
    expect(lastToast()?.message).toBe('課題を削除しました');
    expect(lastToast()?.action?.label).toBe('元に戻す');

    lastToast()!.action!.run();
    expect(useApp.getState().project.details[id]!.issues!.map((i) => i.issue)).toEqual(['手作業が多い']);
  });

  it('confirmRemoveTasks: 単一削除で工程名入りの「元に戻す」トーストを出し、復活できる', async () => {
    useApp.getState().addTask('検収');
    const id = idByName('検収');

    const p = confirmRemoveTasks([id]);
    useUI.getState().resolveDialog(true);
    const ok = await p;
    await flush();
    expect(ok).toBe(true);
    expect(useApp.getState().project.core.tasks[id]).toBeUndefined();

    const t = lastToast();
    expect(t?.message).toBe('「検収」を削除しました');
    expect(t?.action?.label).toBe('元に戻す');
    t!.action!.run();
    expect(idByName('検収')).toBe(id);
  });

  it('confirmRemoveTasks: 複数削除は件数入りのトースト', async () => {
    useApp.getState().addTask('A');
    useApp.getState().addTask('B');
    const ids = [idByName('A'), idByName('B')];

    const p = confirmRemoveTasks(ids);
    useUI.getState().resolveDialog(true);
    await p;
    await flush();
    expect(lastToast()?.message).toBe('2 件の工程を削除しました');
    expect(lastToast()?.action?.label).toBe('元に戻す');
  });

  it('confirmRemoveTasks: キャンセル時はトーストを出さない', async () => {
    useApp.getState().addTask('A');
    const id = idByName('A');
    const p = confirmRemoveTasks([id]);
    useUI.getState().resolveDialog(false);
    const ok = await p;
    await flush();
    expect(ok).toBe(false);
    expect(useApp.getState().project.core.tasks[id]).toBeDefined();
    expect(lastToast()).toBeUndefined();
  });
});
