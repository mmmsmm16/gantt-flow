// フロー上の仮ノード承認（Task 4）のテスト。
//  - nodeStatusOf: 6 状態の純導出（修正中 > 無効 > 承認/否認 > 仮）。
//  - AiFlowPreview の静的レンダリング（renderToStaticMarkup・node 環境）で
//    仮ノード（.fnode.tentative）・状態バッジ・凡例・未確定件数・エッジが描かれること。
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runBatch, type BatchOp, type Project } from '@gantt-flow/core';
import { buildAiPreview } from '../src/ai/preview';
import { type DecisionMap } from '../src/ai/decisions';
import { AiFlowPreview, nodeStatusOf } from '../src/ui/AiFlowPreview';

const NOW = '2026-07-05T00:00:00.000Z';
const counter = (): (() => string) => {
  let n = 0;
  return () => `id${++n}`;
};

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

// レビュー指摘(T4): ポップオーバーの外側クリック判定を提案ノードだけに絞るための data-ai-hit、
// 無効ノードの理由テキスト常時表示、エッジの状態別クラスの静的レンダ検証。
describe('AiFlowPreview（レビュー指摘: data-ai-hit・無効理由・修正中・エッジ状態）', () => {
  const renderOps = (
    project: Project,
    opsArg: BatchOp[],
    decisions: DecisionMap,
    editingOp: number | null = null,
  ): string => {
    const preview = buildAiPreview(project, opsArg, 'medium');
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

  it('提案ノードには data-ai-hit が付き、既存ノードには付かない', () => {
    // 既存工程を 1 件作ってから、それを起点にした新規提案（依存 1 本）を重ねる。
    const base = runBatch(
      emptyProject(),
      [{ op: 'add_task', ref: 'x', name: '既存受付', level: 'medium' }],
      counter(),
      NOW,
    );
    const existingId = base.aliases['x']!;
    const withExisting: BatchOp[] = [
      { op: 'add_task', ref: 'n', name: '新規工程', level: 'medium' },
      { op: 'add_dependency', from: existingId, to: 'n' },
    ];
    const html = renderOps(base.project, withExisting, {});
    // 提案ノード 1 個ぶんの data-ai-hit="" のみ（既存ノードには付かない）。
    expect((html.match(/data-ai-hit=""/g) ?? []).length).toBe(1);
    expect(html).toContain('fnode existing');
    expect(html).toContain('新規工程');
  });

  it('無効（却下波及）ノードは .fnode.invalid ＋ 理由テキスト（.fnode-reason）を常時表示する', () => {
    const invalidOps: BatchOp[] = [
      { op: 'add_task', ref: 'p', name: '親工程', level: 'medium' }, // 0: 否認
      { op: 'add_task', ref: 'c', name: '子工程', level: 'medium', parent: 'p' }, // 1: 承認だが親否認で無効
    ];
    const html = renderOps(emptyProject(), invalidOps, { 0: 'rejected', 1: 'approved' });
    expect(html).toContain('fnode invalid');
    expect(html).toContain('fnode-reason');
    expect(html).toContain('依存先が否認されたため');
  });

  it('修正中ノードは .fnode.editing ＋ input（node-input）と AI 案ヒントを描く', () => {
    const html = render({}, 0);
    expect(html).toContain('fnode editing');
    expect(html).toContain('node-input');
    expect(html).toContain('AI 案');
  });

  it('エッジは両端の状態に応じて tentative/approved/invalid のクラスを持ち、無効エッジには「無効」ラベルが付く', () => {
    const edgeOps: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: 'A', level: 'medium' },
      { op: 'add_task', ref: 'b', name: 'B', level: 'medium' },
      { op: 'add_dependency', from: 'a', to: 'b' },
    ];
    expect(renderOps(emptyProject(), edgeOps, {})).toContain('fedge tentative');
    expect(renderOps(emptyProject(), edgeOps, { 2: 'approved' })).toContain('fedge approved');

    const invalidHtml = renderOps(emptyProject(), edgeOps, { 0: 'rejected', 2: 'approved' });
    expect(invalidHtml).toContain('fedge invalid');
    expect(invalidHtml).toContain('無効');
  });
});
