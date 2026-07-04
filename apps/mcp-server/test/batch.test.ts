import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Project, isMilestone } from '@gantt-flow/core';
import { Workspace } from '../src/session.js';
import { loadProjectFile } from '../src/fileio.js';
import { runBatch, type BatchOp } from '../src/batch.js';
import { auditLeafTasks, formatAudit } from '../src/audit.js';

let dir: string;
const path = () => join(dir, 'b.gflow');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gf-batch-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
/** ディスクへ書き戻された Project を読み直す（write-through の検証用。v2 ZIP/旧 JSON 両対応）。 */
const reload = async (p: string): Promise<Project> => loadProjectFile(p);

describe('runBatch（一括構築）', () => {
  it('ref 参照で工程・依存・担当・詳細・IO・課題を1回で構築', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { title: 'B' });

    const ops: BatchOp[] = [
      { op: 'add_task', ref: 'a', name: '受注', level: 'medium', assignee: '営業部' },
      { op: 'add_task', ref: 'b', name: '出荷', level: 'medium', assignee: '倉庫' },
      { op: 'add_dependency', from: 'a', to: 'b' },
      { op: 'set_detail', task: 'a', patch: { effortMinutes: 90, difficulty: 'H', how: 'EDIで受注を取り込む' } },
      { op: 'add_io', task: 'a', io: 'inputs', name: '注文書', kind: 'doc', source: '顧客' },
      { op: 'add_issue', task: 'a', issue: '紙FAXが多い', measure: 'EDI化' },
    ];
    const result = runBatch(s.project, ops);
    expect(result.created).toMatchObject({ tasks: 2, dependencies: 1, assignees: 2, ios: 1, issues: 1 });
    expect(result.warnings).toEqual([]);

    await s.apply(() => result.project);
    // 依存が ref で解決され A→B が張られている
    const a = result.aliases['a']!;
    const b = result.aliases['b']!;
    expect(Object.values(s.project.core.dependencies).some((d) => d.from === a && d.to === b)).toBe(true);
    expect(s.project.details[a]?.effortMinutes).toBe(90);
    expect(s.project.details[a]?.difficulty).toBe('H');
    expect(s.project.details[a]?.inputs?.[0]?.name).toBe('注文書');

    // write-through 保存
    const onDisk = await reload(path());
    expect(Object.keys(onDisk.core.tasks)).toHaveLength(2);
    expect(Object.keys(onDisk.core.assignees)).toHaveLength(2);
  });

  it('未解決 ref は requireTaskRef で明確に失敗する', () => {
    const base = { schemaVersion: 1, meta: { id: 'x', title: '', createdAt: '', updatedAt: '', appVersion: '0' }, core: { tasks: {}, dependencies: {}, assignees: {} }, details: {}, flow: { byLevel: [] } } as unknown as Project;
    expect(() => runBatch(base, [{ op: 'add_dependency', from: 'nope', to: 'nope2' }])).toThrow(/解決できません/);
  });

  it('同名担当は再利用される（重複作成しない）', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const result = runBatch(s.project, [
      { op: 'add_task', name: 'X', level: 'medium', assignee: '経理' },
      { op: 'add_task', name: 'Y', level: 'medium', assignee: '経理' },
    ]);
    expect(result.created.assignees).toBe(1);
    expect(Object.keys(result.project.core.assignees)).toHaveLength(1);
  });
});

describe('upsert（冪等）', () => {
  it('同じ親・同名なら更新、無ければ作成', () => {
    const ws = new Workspace();
    // create は async だが runBatch は純粋なので空 Project を直接用意
    const base = { schemaVersion: 1, meta: { id: 'x', title: '', createdAt: '', updatedAt: '', appVersion: '0' }, core: { tasks: {}, dependencies: {}, assignees: {} }, details: {}, flow: { byLevel: [] } } as unknown as Project;
    const r1 = runBatch(base, [{ op: 'upsert_task', ref: 't', name: '検品', level: 'medium' }]);
    expect(Object.keys(r1.project.core.tasks)).toHaveLength(1);
    const id1 = r1.aliases['t'];
    const r2 = runBatch(r1.project, [
      { op: 'upsert_task', ref: 't', name: '検品', level: 'small' },
      { op: 'set_detail', task: 't', patch: { effortMinutes: 15 } },
    ]);
    expect(Object.keys(r2.project.core.tasks)).toHaveLength(1); // 増えない
    expect(r2.aliases['t']).toBe(id1); // 同じ工程
    expect(r2.project.core.tasks[id1!]?.level).toBe('small');
    expect(r2.project.details[id1!]?.effortMinutes).toBe(15);
  });
});

describe('kind: milestone（節目マーカー）', () => {
  it('add_task に kind=milestone を指定するとマイルストーンが作成される', () => {
    const base = { schemaVersion: 1, meta: { id: 'x', title: '', createdAt: '', updatedAt: '', appVersion: '0' }, core: { tasks: {}, dependencies: {}, assignees: {} }, details: {}, flow: { byLevel: [] } } as unknown as Project;
    const result = runBatch(base, [{ op: 'add_task', ref: 'ms', name: 'リリース', level: 'medium', kind: 'milestone' }]);
    expect(Object.keys(result.project.core.tasks)).toHaveLength(1);
    const msId = result.aliases['ms']!;
    const task = result.project.core.tasks[msId]!;
    expect(task.kind).toBe('milestone');
    expect(isMilestone(result.project.core, msId)).toBe(true);
  });
});

describe('audit_completeness（形式知化の進捗）', () => {
  it('末端工程の欠落を検出し、埋めると完成度が上がる', () => {
    const base = { schemaVersion: 1, meta: { id: 'x', title: '', createdAt: '', updatedAt: '', appVersion: '0' }, core: { tasks: {}, dependencies: {}, assignees: {} }, details: {}, flow: { byLevel: [] } } as unknown as Project;
    const r1 = runBatch(base, [{ op: 'add_task', ref: 't', name: '転記', level: 'detail' }]);
    const a1 = auditLeafTasks(r1.project)[0]!;
    expect(a1.completeness).toBeLessThan(100);
    expect(a1.missing.map((m) => m.label)).toEqual(expect.arrayContaining(['手順(how)', '難易度', '工数(分)']));

    const r2 = runBatch(r1.project, [
      { op: 'set_detail', task: r1.aliases['t']!, patch: { how: '台帳へ転記', difficulty: 'L', effortMinutes: 10, ltDays: 1, automation: 'manual' } },
      { op: 'add_io', task: r1.aliases['t']!, io: 'outputs', name: '台帳', kind: 'doc' },
    ]);
    const a2 = auditLeafTasks(r2.project)[0]!;
    expect(a2.completeness).toBe(100);
    expect(formatAudit(r2.project, { onlyIncomplete: true })).toContain('入力済み');
  });
});
