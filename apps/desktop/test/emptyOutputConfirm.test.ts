// 工程 0 件のまま無警告で出力/印刷が成功してしまうのを防ぐ判定（UX16位以下）。
// 実際の確認ダイアログ表示は App 側（useUI.confirm）が担うため、ここでは
// persistence.isEmptyProjectForOutput（純関数）の判定だけを検証する。
import { describe, it, expect } from 'vitest';
import { createSampleProject } from '@gantt-flow/core';
import { isEmptyProjectForOutput } from '../src/persistence';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

describe('isEmptyProjectForOutput（工程0件での出力/印刷確認）', () => {
  it('工程が1件以上あれば false（確認不要）', () => {
    const p = createSampleProject(gen('t'));
    expect(isEmptyProjectForOutput(p)).toBe(false);
  });

  it('工程 0 件なら true（確認が必要）', () => {
    const p = createSampleProject(gen('t'));
    const empty = { ...p, core: { ...p.core, tasks: {} } };
    expect(isEmptyProjectForOutput(empty)).toBe(true);
  });
});
