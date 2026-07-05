// フロー上の仮ノード承認（Task 4）のテスト。
//  - nodeStatusOf: 6 状態の純導出（修正中 > 無効 > 承認/否認 > 仮）。
//  - AiFlowPreview の静的レンダリング（renderToStaticMarkup・node 環境）で
//    仮ノード（.fnode.tentative）・状態バッジ・凡例・未確定件数・エッジが描かれること。
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type BatchOp, type Project } from '@gantt-flow/core';
import { buildAiPreview } from '../src/ai/preview';
import { type DecisionMap } from '../src/ai/decisions';
import { AiFlowPreview, nodeStatusOf } from '../src/ui/AiFlowPreview';

const emptyProject = (): Project => ({
  schemaVersion: 1,
  meta: { id: 'p', title: 'テスト', createdAt: '', updatedAt: '', appVersion: '' },
  core: { tasks: {}, dependencies: {}, assignees: {} },
  details: {},
  flow: { byLevel: [] },
  manual: { procedures: {}, assets: {} },
});

const ops: BatchOp[] = [
  { op: 'add_task', ref: 'a', name: '受注', level: 'medium', assignee: '営業' },
  { op: 'add_task', ref: 'b', name: '出荷', level: 'medium', assignee: '倉庫' },
  { op: 'add_dependency', from: 'a', to: 'b' },
  { op: 'set_procedure', task: 'a', purpose: '受注を確定する' },
];

const noop = () => {};

const render = (decisions: DecisionMap, editingOp: number | null = null): string => {
  const preview = buildAiPreview(emptyProject(), ops, 'medium');
  return renderToStaticMarkup(
    createElement(AiFlowPreview, {
      preview,
      decisions,
      edits: {},
      editingOp,
      onDecide: noop,
      onBeginEdit: noop,
      onCommitEdit: noop,
      onCancelEdit: noop,
    }),
  );
};

describe('nodeStatusOf', () => {
  const disabled = new Map<number, string>([[3, '依存先が否認されたため']]);

  it('修正中が最優先', () => {
    expect(nodeStatusOf(0, { 0: 'approved' }, disabled, 0)).toBe('editing');
  });
  it('無効（却下波及）は承認/否認より優先', () => {
    expect(nodeStatusOf(3, { 3: 'approved' }, disabled, null)).toBe('invalid');
  });
  it('承認 / 否認 / 未判定=仮', () => {
    expect(nodeStatusOf(1, { 1: 'approved' }, disabled, null)).toBe('approved');
    expect(nodeStatusOf(1, { 1: 'rejected' }, disabled, null)).toBe('rejected');
    expect(nodeStatusOf(1, {}, disabled, null)).toBe('tentative');
  });
});

describe('AiFlowPreview（静的レンダリング）', () => {
  it('未判定は仮ノード（琥珀破線）＋「仮」バッジで描かれる', () => {
    const html = render({});
    expect(html).toContain('fnode tentative');
    expect(html).toContain('fbadge k');
    expect(html).toContain('受注');
    expect(html).toContain('出荷');
  });

  it('凡例 5 種と未確定件数バッジが出る', () => {
    const html = render({});
    expect(html).toContain('flow-legend');
    expect(html).toContain('prov-tent-count');
    expect(html).toContain('仮のプロセス 2 個');
  });

  it('承認で緑ノード（.fnode.approved）＋「✓承認済」バッジ', () => {
    const html = render({ 0: 'approved' });
    expect(html).toContain('fnode approved');
    expect(html).toContain('✓承認済');
    expect(html).toContain('仮のプロセス 2 個'); // 承認も未確定件数に含む
  });

  it('否認で打消しノード（.fnode.rejected）＋「✕否認」バッジ・件数から外れる', () => {
    const html = render({ 0: 'rejected' });
    expect(html).toContain('fnode rejected');
    expect(html).toContain('✕否認');
    expect(html).toContain('仮のプロセス 1 個'); // 否認 1 件ぶん減る
  });

  it('非フロー系提案（set_procedure）は対象ノードに小バッジ（.fnode-nf）を出す', () => {
    const html = render({});
    expect(html).toContain('fnode-nf');
  });

  it('エッジが描かれる（proposal 依存＝仮スタイル）', () => {
    const html = render({});
    expect(html).toContain('fedge');
  });
});
