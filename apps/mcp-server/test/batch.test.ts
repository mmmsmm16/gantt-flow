import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Project, isMilestone, uuid, runBatch, type BatchOp } from '@gantt-flow/core';
import { Workspace } from '../src/session.js';
import { loadProjectFile } from '../src/fileio.js';
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

// runBatch/BatchOp の純ロジック検証（ref 解決・upsert 冪等・milestone・parseProposals 等）は
// packages/core/test/batch.test.ts へ移設済み。ここでは mcp 固有の write-through
// （s.apply → ディスク保存 → 再読込 deep-equal）と、mcp 側モジュール(audit.ts)との連携のみ検証する。
describe('runBatch（一括構築・write-through）', () => {
  it('ref 参照で工程・依存・担当・詳細・IO・課題を1回で構築し、保存→再読込で一致する', async () => {
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
    const result = runBatch(s.project, ops, uuid, new Date().toISOString());
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
    expect(onDisk).toEqual(s.project);
  });

  it('kind=milestone のバッチも write-through で保存され、再読込後も isMilestone が成立する', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const result = runBatch(s.project, [{ op: 'add_task', ref: 'ms', name: 'リリース', level: 'medium', kind: 'milestone' }], uuid, new Date().toISOString());
    await s.apply(() => result.project);
    const onDisk = await reload(path());
    expect(isMilestone(onDisk.core, result.aliases['ms'])).toBe(true);
  });
});

describe('audit_completeness（形式知化の進捗）', () => {
  it('末端工程の欠落を検出し、埋めると完成度が上がる', () => {
    const base = { schemaVersion: 1, meta: { id: 'x', title: '', createdAt: '', updatedAt: '', appVersion: '0' }, core: { tasks: {}, dependencies: {}, assignees: {} }, details: {}, flow: { byLevel: [] } } as unknown as Project;
    const now = new Date().toISOString();
    const r1 = runBatch(base, [{ op: 'add_task', ref: 't', name: '転記', level: 'detail' }], uuid, now);
    const a1 = auditLeafTasks(r1.project)[0]!;
    expect(a1.completeness).toBeLessThan(100);
    expect(a1.missing.map((m) => m.label)).toEqual(expect.arrayContaining(['手順(how)', '難易度', '工数(分)']));

    const r2 = runBatch(
      r1.project,
      [
        { op: 'set_detail', task: r1.aliases['t']!, patch: { how: '台帳へ転記', difficulty: 'L', effortMinutes: 10, ltDays: 1, automation: 'manual' } },
        { op: 'add_io', task: r1.aliases['t']!, io: 'outputs', name: '台帳', kind: 'doc' },
      ],
      uuid,
      now,
    );
    const a2 = auditLeafTasks(r2.project)[0]!;
    expect(a2.completeness).toBe(100);
    expect(formatAudit(r2.project, { onlyIncomplete: true })).toContain('入力済み');
  });
});
