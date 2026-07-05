import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import { runBatch, parseProposals, isMilestone, type BatchOp } from '../src';

const NOW = '2026-07-05T00:00:00.000Z';

describe('runBatch（一括構築・決定論）', () => {
  it('ref 参照で工程・依存・担当・詳細・IO・課題・手順書を 1 回で構築（バイト安定）', () => {
    const g = counter();
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '受注', level: 'medium', assignee: '営業部' },
      { op: 'add_task', ref: 'b', name: '出荷', level: 'medium', assignee: '倉庫' },
      { op: 'add_dependency', from: 'a', to: 'b' },
      { op: 'set_procedure', task: 'a', purpose: '受注を確定する' },
      { op: 'add_step', task: 'a', action: '内容を確認' },
    ];
    const res = runBatch(emptyProject(), ops, g, NOW);
    expect(res.created).toEqual({ tasks: 2, dependencies: 1, assignees: 2, ios: 0, issues: 0, steps: 1, assets: 0 });
    expect(res.project.manual.procedures[res.aliases['a']!]!.updatedAt).toBe(NOW);
    // aliases の id が counter 由来で決定論（2 回実行して deep-equal）
    expect(runBatch(emptyProject(), ops, counter(), NOW)).toEqual(res);
  });

  it('set_detail / set_tobe / add_io / add_issue も 1 回で反映される', () => {
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '受注', level: 'medium', assignee: '営業部' },
      { op: 'set_detail', task: 'a', patch: { effortMinutes: 90, difficulty: 'H', how: 'EDIで受注を取り込む' } },
      { op: 'set_tobe', task: 'a', patch: { effortMinutes: 30 } },
      { op: 'add_io', task: 'a', io: 'inputs', name: '注文書', kind: 'doc', source: '顧客' },
      { op: 'add_issue', task: 'a', issue: '紙FAXが多い', measure: 'EDI化' },
    ];
    const res = runBatch(emptyProject(), ops, counter(), NOW);
    expect(res.created).toEqual({ tasks: 1, dependencies: 0, assignees: 1, ios: 1, issues: 1, steps: 0, assets: 0 });
    expect(res.warnings).toEqual([]);
    const a = res.aliases['a']!;
    expect(res.project.details[a]?.effortMinutes).toBe(90);
    expect(res.project.details[a]?.difficulty).toBe('H');
    expect(res.project.details[a]?.toBe?.effortMinutes).toBe(30);
    expect(res.project.details[a]?.inputs?.[0]?.name).toBe('注文書');
    expect(res.project.details[a]?.issues?.[0]?.issue).toBe('紙FAXが多い');
  });

  it('未解決 ref は requireTaskRef で明確に失敗する', () => {
    expect(() => runBatch(emptyProject(), [{ op: 'add_dependency', from: 'x', to: 'y' }], counter(), NOW)).toThrow();
  });

  it('同名担当は再利用される（重複作成しない）', () => {
    const res = runBatch(
      emptyProject(),
      [
        { op: 'add_task', name: 'X', level: 'medium', assignee: '経理' },
        { op: 'add_task', name: 'Y', level: 'medium', assignee: '経理' },
      ],
      counter(),
      NOW,
    );
    expect(res.created.assignees).toBe(1);
    expect(Object.keys(res.project.core.assignees)).toHaveLength(1);
  });

  it('upsert_task は同じ親・同名で更新、無ければ作成', () => {
    const r1 = runBatch(emptyProject(), [{ op: 'upsert_task', ref: 't', name: '検品', level: 'medium' }], counter(), NOW);
    expect(Object.keys(r1.project.core.tasks)).toHaveLength(1);
    const id1 = r1.aliases['t'];
    const r2 = runBatch(
      r1.project,
      [
        { op: 'upsert_task', ref: 't', name: '検品', level: 'small' },
        { op: 'set_detail', task: 't', patch: { effortMinutes: 15 } },
      ],
      counter(),
      NOW,
    );
    expect(Object.keys(r2.project.core.tasks)).toHaveLength(1); // 増えない
    expect(r2.aliases['t']).toBe(id1); // 同じ工程
    expect(r2.project.core.tasks[id1!]?.level).toBe('small');
    expect(r2.project.details[id1!]?.effortMinutes).toBe(15);
  });

  it('kind=milestone でマイルストーンが作られる', () => {
    const res = runBatch(emptyProject(), [{ op: 'add_task', ref: 'm', name: 'リリース', level: 'medium', kind: 'milestone' }], counter(), NOW);
    expect(isMilestone(res.project.core, res.aliases['m'])).toBe(true);
  });
});

describe('parseProposals（AI 出力の最終防衛線）', () => {
  it('parseProposals は正しい JSON を BatchOp[] に通す', () => {
    expect(parseProposals('{"operations":[{"op":"add_task","name":"A","level":"medium"}]}').operations.length).toBe(1);
  });

  it('parseProposals は不正 JSON / 不正 op を拒否する', () => {
    expect(() => parseProposals('not json')).toThrow();
    expect(() => parseProposals('{"operations":[{"op":"nope"}]}')).toThrow();
  });

  it('parseProposals は必須項目欠落を拒否する', () => {
    // add_task は name/level が必須
    expect(() => parseProposals('{"operations":[{"op":"add_task","name":"A"}]}')).toThrow();
  });
});
