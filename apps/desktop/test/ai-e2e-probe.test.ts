// AI アシスト E2E probe（Task 5・実 API 不使用・MockAiProvider 注入）。
// 実ストア（useApp）で「メモ→提案生成→フロー承認/カードで一部否認（resolveApproved/
// filterApplicable 経由）→ applyApprovedBatch 部分適用→ useApp.undo() で全復帰」を
// 1 本の決定論テストで通す。既存の ai-preview.test.ts（buildAiPreview/applyApprovedBatch の
// undo 一発）・ai-provider.test.ts（MockAiProvider/オプトインガード）の流儀に合わせる。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BatchOp } from '@gantt-flow/core';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';
import { requestProposals, MockAiProvider, type ProposalRequest } from '../src/ai/provider';
import { buildAiPreview } from '../src/ai/preview';
import { resolveApproved, filterApplicable, applyEdits, type DecisionMap } from '../src/ai/decisions';

// node 環境向けの localStorage シム（useUI.setAiEnabled 等が触っても落ちないように。
// ai-preview.test.ts / ai-provider.test.ts と同じ流儀）。
class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  useApp.getState().newProject(); // 工程/依存/手順書を空に・undo 履歴をリセット
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

// ヒアリングメモ相当の canned 提案（8 op）:
//  0,1: 受注→出荷を新設（フローで承認）
//  2  : 受注→出荷の依存（フローで承認）
//  3  : 与信確認を新設（カードで否認＝今回は見送り）
//  4  : 与信確認→出荷の依存（フローでは承認したが、producer(3) が否認なので
//       resolveApproved の ref-DAG cascade で無効化されるべき）
//  5  : 受注の手順書 purpose（フローで承認）
//  6  : 検品を新設（まだ判断できず pending のまま＝保留）
//  7  : 出荷→検品の依存（フローでは承認したが producer(6) が未承認＝rejected ではなく
//       pending なので resolveApproved 単体では素通りしてしまい、filterApplicable の
//       第二フィルタで除外されるべき「pending producer + approved consumer」の穴）
const cannedOps: BatchOp[] = [
  { op: 'add_task', ref: 'order', name: '受注', level: 'medium', assignee: '営業' },
  { op: 'add_task', ref: 'ship', name: '出荷', level: 'medium', assignee: '倉庫' },
  { op: 'add_dependency', from: 'order', to: 'ship' },
  { op: 'add_task', ref: 'credit', name: '与信確認', level: 'medium', assignee: '経理' },
  { op: 'add_dependency', from: 'credit', to: 'ship' },
  { op: 'set_procedure', task: 'order', purpose: '受注を確定する' },
  { op: 'add_task', ref: 'inspect', name: '検品', level: 'medium', assignee: '品証' },
  { op: 'add_dependency', from: 'ship', to: 'inspect' },
];

describe('AI アシスト E2E probe（MockAiProvider・実 API 不使用）', () => {
  it('メモ→提案生成→フロー承認/カードで一部否認→部分適用→undo で全復帰', async () => {
    useUI.getState().setAiEnabled(true);

    const req: ProposalRequest = {
      project: useApp.getState().project,
      memo: '受注を受けたら出荷する。与信確認も出したが今回は見送り。検品はまだ判断できない。',
      kind: 'batch',
    };
    const mock = new MockAiProvider(JSON.stringify({ operations: cannedOps }));
    const proposedOps = await requestProposals(req, undefined, mock);
    expect(proposedOps).toEqual(cannedOps); // core の parseProposals（共通検証）を素通りする正当な提案

    const preview = buildAiPreview(
      useApp.getState().project,
      proposedOps,
      useApp.getState().level,
      useApp.getState().scopeParentId,
    );

    const decisions: DecisionMap = {
      0: 'approved',
      1: 'approved',
      2: 'approved',
      3: 'rejected',
      4: 'approved',
      5: 'approved',
      6: 'pending',
      7: 'approved',
    };
    const finalOps = applyEdits(preview.ops, {});
    const { apply: resolvedApply, disabled } = resolveApproved(finalOps, decisions);
    expect(disabled.has(4)).toBe(true); // producer(与信確認)否認の cascade で無効化
    const { apply: applicable, excluded } = filterApplicable(finalOps, resolvedApply);
    expect(excluded.has(7)).toBe(true); // producer(検品)未承認 → 第二フィルタで除外

    const applyOps = applicable.map((i) => finalOps[i]!);

    const tasksBefore = Object.keys(useApp.getState().project.core.tasks).length;
    const depsBefore = Object.keys(useApp.getState().project.core.dependencies).length;
    expect(tasksBefore).toBe(0);
    expect(depsBefore).toBe(0);

    useApp.getState().applyApprovedBatch(applyOps);

    const afterProject = useApp.getState().project;
    const names = Object.values(afterProject.core.tasks).map((t) => t.name);
    expect(names).toContain('受注');
    expect(names).toContain('出荷');
    expect(names).not.toContain('与信確認'); // カードで否認
    expect(names).not.toContain('検品'); // pending のまま未適用
    expect(Object.keys(afterProject.core.tasks).length).toBe(2);
    expect(Object.keys(afterProject.core.dependencies).length).toBe(1); // 受注→出荷のみ
    const orderTask = Object.values(afterProject.core.tasks).find((t) => t.name === '受注')!;
    expect(afterProject.manual.procedures[orderTask.id]?.purpose).toBe('受注を確定する');
    expect(useApp.getState().canUndo).toBe(true);

    // undo 一発で承認分の全 op が消える（1 スナップショット）。
    useApp.getState().undo();
    const revertedProject = useApp.getState().project;
    expect(Object.keys(revertedProject.core.tasks).length).toBe(0);
    expect(Object.keys(revertedProject.core.dependencies).length).toBe(0);
    expect(Object.keys(revertedProject.manual.procedures).length).toBe(0);
    expect(useApp.getState().canUndo).toBe(false);
  });
});
