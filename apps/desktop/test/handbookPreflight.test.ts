// ハンドブック出力前の納品前チェック。App の onExportHandbook は
// summarizeForExport(lintProject(project)) が null なら確認なしで出力、
// 非 null なら確認を出し「内容を確認」で検証パネルを開く。ここでは
// その判定を駆動する純関数（emptyOutputConfirm.test.ts と同型）を検証する。
import { describe, it, expect } from 'vitest';
import { createSampleProject, lintProject } from '@gantt-flow/core';
import { summarizeForExport } from '../src/validationPanel';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

describe('納品前チェック（ハンドブック出力プリフライト）', () => {
  it('工程 0 件なら null（確認なしで出力）', () => {
    const p = createSampleProject(gen('t'));
    const empty = {
      ...p,
      core: { tasks: {}, dependencies: {}, assignees: {} },
      details: {},
      manual: { procedures: {}, assets: {} },
    };
    expect(summarizeForExport(lintProject(empty))).toBeNull();
  });

  it('未整備の工程があれば非 null（確認を出し、キャンセルでパネルへ）', () => {
    const p = createSampleProject(gen('t'));
    const summary = summarizeForExport(lintProject(p));
    expect(summary).not.toBeNull();
    // 「ラベル n件」形式（・区切り）であることを確認。
    expect(summary).toMatch(/\d+件/);
  });
});
