// AI 承認データ層（純関数）のテスト。
//  - resolveApproved: 却下→下流無効・連鎖 2 段・無関係 op 不干渉・既存 id 参照は不干渉。
//  - applyEdits: 名称/担当の畳み込み。
//  - buildProposalNodeMap: producer/consumer 突合・edge/nonFlow 分類。
import { describe, it, expect } from 'vitest';
import { runBatch, type BatchOp, type Project } from '@gantt-flow/core';
import {
  resolveApproved,
  filterApplicable,
  applyEdits,
  buildProposalNodeMap,
  DISABLED_REASON,
  type DecisionMap,
  type EditMap,
} from '../src/ai/decisions';

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

describe('resolveApproved', () => {
  it('承認のみ適用し、未判定（pending）は適用しない', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: 'A', level: 'medium' },
      { op: 'add_task', ref: 'b', name: 'B', level: 'medium' },
    ];
    const decisions: DecisionMap = { 0: 'approved' }; // 1 は未判定
    const { apply, disabled } = resolveApproved(ops, decisions);
    expect(apply).toEqual([0]);
    expect(disabled.size).toBe(0);
  });

  it('producer を否認すると、その ref を消費する下流が無効になる（連鎖 2 段）', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '親', level: 'medium' }, // 0 producer
      { op: 'add_task', ref: 'b', name: '子', level: 'small', parent: 'a' }, // 1 consumes a
      { op: 'add_dependency', from: 'b', to: 'a' }, // 2 consumes b
    ];
    const decisions: DecisionMap = { 0: 'rejected', 1: 'approved', 2: 'approved' };
    const { apply, disabled } = resolveApproved(ops, decisions);
    expect(disabled.get(1)).toBe(DISABLED_REASON); // a 否認 → 1 無効
    expect(disabled.get(2)).toBe(DISABLED_REASON); // 1 無効 → 2 も無効（連鎖）
    expect(apply).toEqual([]); // 承認でも無効は適用しない
  });

  it('無関係な op は却下波及に巻き込まれない', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: 'A', level: 'medium' }, // 0
      { op: 'add_task', ref: 'b', name: 'B', level: 'medium' }, // 1（a と無関係）
      { op: 'add_dependency', from: 'a', to: 'b' }, // 2 consumes a と b
    ];
    // 別の producer を否認しても、それを参照しない op は無効化されない。
    const { apply, disabled } = resolveApproved(ops, {
      0: 'rejected',
      1: 'approved',
      2: 'approved',
    });
    expect(disabled.has(1)).toBe(false); // b は a と無関係
    expect(disabled.has(2)).toBe(true); // 2 は a を消費するので無効
    expect(apply).toEqual([1]);
  });

  it('既存 taskId を指す消費は無効化しない', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: 'A', level: 'medium' }, // 0
      { op: 'add_issue', task: 'EXISTING', issue: '既存工程への課題' }, // 1 既存 id 参照
    ];
    const { apply, disabled } = resolveApproved(ops, { 0: 'rejected', 1: 'approved' });
    expect(disabled.has(1)).toBe(false); // EXISTING は producedBy に無い
    expect(apply).toEqual([1]);
  });
});

describe('filterApplicable（適用直前の第二フィルタ: pending producer + approved consumer）', () => {
  it('producer が pending のまま consumer だけ承認されると、consumer を除外する', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '親', level: 'medium' }, // 0 未判定(pending)
      { op: 'add_task', ref: 'b', name: '子', level: 'small', parent: 'a' }, // 1 承認・a を消費
    ];
    const decisions: DecisionMap = { 1: 'approved' }; // 0 は未判定のまま
    const { apply } = resolveApproved(ops, decisions);
    expect(apply).toEqual([1]); // resolveApproved 単体では素通りしてしまう(否認ではないため)
    const { apply: applicable, excluded } = filterApplicable(ops, apply);
    expect(applicable).toEqual([]);
    expect(excluded.has(1)).toBe(true);
  });

  it('連鎖: pending producer → 中間 consumer → 末端 consumer もまとめて除外する（fixpoint）', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '親', level: 'medium' }, // 0 未判定
      { op: 'add_task', ref: 'b', name: '子', level: 'small', parent: 'a' }, // 1 承認・a を消費
      { op: 'add_dependency', from: 'b', to: 'a' }, // 2 承認・b(間接的に a)を消費
    ];
    const decisions: DecisionMap = { 1: 'approved', 2: 'approved' };
    const { apply } = resolveApproved(ops, decisions);
    expect(apply).toEqual([1, 2]);
    const { apply: applicable, excluded } = filterApplicable(ops, apply);
    expect(applicable).toEqual([]);
    expect(excluded.has(1)).toBe(true);
    expect(excluded.has(2)).toBe(true);
  });

  it('既存 taskId への消費は producer が無いので除外しない', () => {
    const ops: BatchOp[] = [{ op: 'add_issue', task: 'EXISTING', issue: '既存工程への課題' }];
    const decisions: DecisionMap = { 0: 'approved' };
    const { apply } = resolveApproved(ops, decisions);
    const { apply: applicable, excluded } = filterApplicable(ops, apply);
    expect(applicable).toEqual([0]);
    expect(excluded.size).toBe(0);
  });

  it('producer も含めて全て承認済みなら除外ゼロ・apply は無変化', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '親', level: 'medium' }, // 0 承認
      { op: 'add_task', ref: 'b', name: '子', level: 'small', parent: 'a' }, // 1 承認
    ];
    const decisions: DecisionMap = { 0: 'approved', 1: 'approved' };
    const { apply } = resolveApproved(ops, decisions);
    const { apply: applicable, excluded } = filterApplicable(ops, apply);
    expect(applicable).toEqual(apply);
    expect(excluded.size).toBe(0);
  });
});

describe('applyEdits', () => {
  it('名称・担当を op へ畳み込み、id は揺らさない', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '受注', level: 'medium', assignee: '営業' },
      { op: 'add_dependency', from: 'a', to: 'a' },
    ];
    const edits: EditMap = { 0: { name: '受注登録', assignee: '受注課' } };
    const out = applyEdits(ops, edits);
    expect(out[0]).toMatchObject({ op: 'add_task', ref: 'a', name: '受注登録', assignee: '受注課' });
    expect((out[0] as { assigneeId?: string }).assigneeId).toBeUndefined();
    expect(out[1]).toBe(ops[1]); // 無編集 op は同一参照
  });

  it('資料 op の名称も畳み込む', () => {
    const ops: BatchOp[] = [{ op: 'upsert_asset', ref: 'd', name: '旧名' }];
    const out = applyEdits(ops, { 0: { name: '新名' } });
    expect(out[0]).toMatchObject({ op: 'upsert_asset', name: '新名' });
  });
});

describe('buildProposalNodeMap', () => {
  it('op → taskId 全単射・edgeOps 解決・nonFlowOps 分類', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '受注', level: 'medium' }, // 0 → node
      { op: 'add_task', ref: 'b', name: '出荷', level: 'medium' }, // 1 → node
      { op: 'add_dependency', from: 'a', to: 'b' }, // 2 → edge
      { op: 'set_procedure', task: 'a', purpose: '受注を確定' }, // 3 → a, nonFlow
      { op: 'add_issue', task: 'b', issue: '在庫不足' }, // 4 → b, nonFlow
      { op: 'upsert_asset', ref: 'doc1', name: '契約書' }, // 5 → nonFlow only
    ];
    const result = runBatch(emptyProject(), ops, counter(), NOW);
    const map = buildProposalNodeMap(ops, result);

    const idA = result.aliases['a']!;
    const idB = result.aliases['b']!;
    expect(map.opToTaskId.get(0)).toBe(idA);
    expect(map.opToTaskId.get(1)).toBe(idB);
    expect(map.opToTaskId.get(3)).toBe(idA); // set_procedure は対象工程へ寄せる
    expect(map.opToTaskId.get(4)).toBe(idB);
    expect(map.opToTaskId.has(2)).toBe(false); // 依存は edge
    expect(map.opToTaskId.has(5)).toBe(false); // 資料はノード無し

    expect(map.edgeOps.get(2)).toEqual([idA, idB]);
    expect(map.taskIdToOps.get(idA)).toEqual([0, 3]); // 1 ノードに複数 op = バッジ
    expect(map.nonFlowOps).toEqual([3, 4, 5]);
  });

  it('既存ノードへの寄せ（既存 taskId を指す対象系 op）', () => {
    // まず既存工程を作る。
    const base = runBatch(emptyProject(), [{ op: 'add_task', ref: 'x', name: '既存', level: 'medium' }], counter(), NOW);
    const existingId = base.aliases['x']!;
    const ops: BatchOp[] = [{ op: 'add_step', task: existingId, action: '確認する' }];
    const result = runBatch(base.project, ops, counter(), NOW);
    const map = buildProposalNodeMap(ops, result);
    expect(map.opToTaskId.get(0)).toBe(existingId);
    expect(map.nonFlowOps).toEqual([0]);
  });
});
