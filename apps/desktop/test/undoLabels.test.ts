// undo/redo の「何が起きたか」ラベル（UX#10）。操作ごとに push 時ラベルを付け、undo/redo で
// 「元に戻しました: <label>」「やり直しました: <label>」トーストを出す。add/delete/rename/
// assignee/dependency の主要操作でラベルが正しく出ることを確認する。
import { describe, it, expect, beforeEach } from 'vitest';
import type { Id } from '@gantt-flow/core';
import { createAppStore } from '../src/store';
import { useUI } from '../src/ui/useUI';

type Store = ReturnType<typeof createAppStore>;
const lastToast = (): string => useUI.getState().toasts.at(-1)?.message ?? '';
const idByName = (s: Store, name: string): Id =>
  Object.values(s.getState().project.core.tasks).find((t) => t.name === name)!.id;

beforeEach(() => useUI.setState({ toasts: [] }));

describe('undo/redo のラベル付きフィードバック', () => {
  it('工程追加 → undo/redo でラベルを出す', () => {
    const s = createAppStore();
    s.getState().addTask('作業A');
    s.getState().undo();
    expect(lastToast()).toBe('元に戻しました: 工程を追加');
    s.getState().redo();
    expect(lastToast()).toBe('やり直しました: 工程を追加');
  });

  it('削除は工程名入りラベル', () => {
    const s = createAppStore();
    s.getState().addTask('検収');
    s.getState().removeTask(idByName(s, '検収'));
    s.getState().undo();
    expect(lastToast()).toBe('元に戻しました: 工程『検収』を削除');
  });

  it('作業名の変更', () => {
    const s = createAppStore();
    s.getState().addTask('旧名');
    s.getState().renameTask(idByName(s, '旧名'), '新名');
    s.getState().undo();
    expect(lastToast()).toBe('元に戻しました: 作業名を変更');
  });

  it('担当の変更', () => {
    const s = createAppStore();
    s.getState().addTask('作業A');
    s.getState().setAssigneeByName(idByName(s, '作業A'), '経理部');
    s.getState().undo();
    expect(lastToast()).toBe('元に戻しました: 担当を変更');
  });

  it('前工程（依存）の追加', () => {
    const s = createAppStore();
    s.getState().addTask('前');
    s.getState().addTask('後');
    s.getState().addDependency(idByName(s, '前'), idByName(s, '後'));
    s.getState().undo();
    expect(lastToast()).toBe('元に戻しました: 前工程を追加');
  });

  it('undo できないときはトーストを出さない', () => {
    const s = createAppStore(); // 初期状態は undo 不可
    s.getState().undo();
    expect(useUI.getState().toasts).toHaveLength(0);
  });
});
