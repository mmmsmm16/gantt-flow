import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addTask,
  upsertProcedure,
  addStep,
  removeStep,
  addStepCond,
  addStepRef,
  addStepImage,
  upsertAsset,
  uuid,
  type Project,
} from '@gantt-flow/core';
import { Workspace } from '../src/session.js';
import { loadProjectFile } from '../src/fileio.js';
import { formatProcedure } from '../src/format.js';
import { runBatch, type BatchOp } from '../src/batch.js';

let dir: string;
const path = () => join(dir, 'proc.gflow');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gf-proc-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** ディスクへ書き戻された Project を読み直す（write-through の検証用）。 */
const reload = async (p: string): Promise<Project> => loadProjectFile(p);

describe('手順書ツール（upsert_procedure / get_procedure 相当）', () => {
  it('purpose+steps(2件) を設定し、整形結果に両ステップが含まれ、reload で deep-equal', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), { title: '手順書テスト' });
    const t = uuid();
    await s.apply((p) => addTask(p, { name: '検品', level: 'detail', id: t }, uuid));

    const now = new Date().toISOString();
    const steps = [
      { action: '数量を確認する', why: '過不足を防ぐ' },
      { action: '外観を確認する', bodyMd: '傷・汚れの有無を見る' },
    ];
    await s.apply((p) => {
      let next = upsertProcedure(p, t, { purpose: '検品を正確に行う' }, now);
      for (const st of steps) next = addStep(next, t, st, uuid, now);
      return next;
    });

    const text = formatProcedure(s.project, t);
    expect(text).toContain('検品を正確に行う');
    expect(text).toContain('数量を確認する');
    expect(text).toContain('外観を確認する');
    expect(text).toContain('過不足を防ぐ');
    expect(text).toContain('傷・汚れの有無を見る');
    expect(s.project.manual.procedures[t]?.steps).toHaveLength(2);

    // reload（write-through 済みのファイルを再オープン）で手順書が deep-equal
    const onDisk = await reload(path());
    expect(onDisk.manual.procedures[t]).toEqual(s.project.manual.procedures[t]);
  });

  it('steps を渡すと既存の全ステップが新しい ID で置換される', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const t = uuid();
    await s.apply((p) => addTask(p, { name: '検品', level: 'detail', id: t }, uuid));
    const now1 = new Date().toISOString();
    await s.apply((p) => addStep(upsertProcedure(p, t, {}, now1), t, { action: '旧手順' }, uuid, now1));
    const oldStepId = s.project.manual.procedures[t]!.steps[0]!.id;

    const now2 = new Date().toISOString();
    await s.apply((p) => {
      const existingIds = (p.manual.procedures[t]?.steps ?? []).map((st) => st.id);
      let next = upsertProcedure(p, t, {}, now2);
      for (const id of existingIds) next = removeStep(next, t, id, now2);
      next = addStep(next, t, { action: '新手順' }, uuid, now2);
      return next;
    });

    const proc = s.project.manual.procedures[t]!;
    expect(proc.steps).toHaveLength(1);
    expect(proc.steps[0]!.action).toBe('新手順');
    expect(proc.steps[0]!.id).not.toBe(oldStepId);
  });

  it('未作成の工程は「手順書は未作成です」', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const t = uuid();
    await s.apply((p) => addTask(p, { name: '未着手工程', level: 'detail', id: t }, uuid));
    expect(formatProcedure(s.project, t)).toBe('手順書は未作成です。');
  });

  it('formatProcedure は目的・ステップ・条件・参照・画像を整形する', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const t = uuid();
    const target = uuid();
    await s.apply((p) => addTask(p, { name: '検品', level: 'detail', id: t }, uuid));
    await s.apply((p) => addTask(p, { name: '差し戻し', level: 'detail', id: target }, uuid));

    const now = new Date().toISOString();
    await s.apply((p) => {
      let next = upsertProcedure(p, t, { purpose: '検品を正確に行う' }, now);
      next = addStep(next, t, { action: '数量確認', why: '過不足防止' }, uuid, now);
      const stepId = next.manual.procedures[t]!.steps[0]!.id;
      next = addStepCond(next, t, stepId, { when: '数量が違う', thenMd: '差し戻す', targetTaskId: target }, uuid, now);
      next = addStepRef(next, t, stepId, { kind: 'task', taskId: target }, now);
      next = addStepImage(next, t, stepId, { file: 'img/x.png', caption: '検品の様子' }, uuid, now);
      return next;
    });

    const text = formatProcedure(s.project, t);
    expect(text).toContain('検品を正確に行う');
    expect(text).toContain('数量確認');
    expect(text).toContain('過不足防止');
    expect(text).toContain('差し戻す');
    expect(text).toContain('差し戻し'); // 飛び先タスク名（conds の targetTaskId）
    expect(text).toContain('img/x.png');
    expect(text).toContain('検品の様子');
  });

  it('purpose 省略時は既存の purpose が保持される（upsert_procedure の purpose 未指定）', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const t = uuid();
    await s.apply((p) => addTask(p, { name: '検品', level: 'detail', id: t }, uuid));

    // 最初の手順書作成で purpose を設定
    const now1 = new Date().toISOString();
    await s.apply((p) => upsertProcedure(p, t, { purpose: '検品を正確に行う' }, now1));
    expect(s.project.manual.procedures[t]?.purpose).toBe('検品を正確に行う');

    // purpose を指定せず（undefined）steps のみで upsert_procedure 実行
    const now2 = new Date().toISOString();
    await s.apply((p) => {
      let next = upsertProcedure(p, t, {}, now2); // purpose 省略
      next = addStep(next, t, { action: '数量確認', why: '過不足防止' }, uuid, now2);
      return next;
    });

    // purpose が保持されていることを確認
    const proc = s.project.manual.procedures[t]!;
    expect(proc.purpose).toBe('検品を正確に行う');
    expect(proc.steps).toHaveLength(1);
    expect(proc.steps[0]!.action).toBe('数量確認');

    // reload でも deep-equal を確認
    const onDisk = await reload(path());
    expect(onDisk.manual.procedures[t]).toEqual(proc);
  });
});

describe('資料台帳ツール（upsert_asset 相当）', () => {
  it('alias+relPath / url の locator で台帳に追加され、reload で deep-equal', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    await s.apply((p) => upsertAsset(p, { name: '規程集', locator: { alias: 'docs', relPath: 'a.pdf' } }, uuid));
    await s.apply((p) => upsertAsset(p, { name: '外部リンク', locator: { url: 'https://example.com' } }, uuid));

    const assets = Object.values(s.project.manual.assets);
    expect(assets).toHaveLength(2);
    expect(assets.some((a) => a.name === '規程集' && a.locator && 'relPath' in a.locator)).toBe(true);
    expect(assets.some((a) => a.name === '外部リンク' && a.locator && 'url' in a.locator)).toBe(true);

    const onDisk = await reload(path());
    expect(onDisk.manual.assets).toEqual(s.project.manual.assets);
  });
});

describe('apply_batch: set_procedure / add_step / upsert_asset', () => {
  it('add_step を混ぜた一括構築が 1 往復で反映される', async () => {
    const ws = new Workspace();
    const s = await ws.create(path(), {});
    const ops: BatchOp[] = [
      { op: 'add_task', ref: 't', name: '検品', level: 'detail' },
      { op: 'set_procedure', task: 't', purpose: '正確に検品する' },
      { op: 'add_step', task: 't', action: '数量確認', why: '過不足防止' },
      { op: 'add_step', task: 't', action: '外観確認' },
      { op: 'upsert_asset', ref: 'doc1', name: 'マニュアル', alias: 'docs', relPath: 'm.pdf' },
    ];
    const result = runBatch(s.project, ops);
    expect(result.created.steps).toBe(2);
    expect(result.created.assets).toBe(1);

    await s.apply(() => result.project);
    const t = result.aliases['t']!;
    const proc = s.project.manual.procedures[t]!;
    expect(proc.purpose).toBe('正確に検品する');
    expect(proc.steps.map((st) => st.action)).toEqual(['数量確認', '外観確認']);
    expect(Object.keys(s.project.manual.assets)).toHaveLength(1);

    const onDisk = await reload(path());
    expect(onDisk.manual.procedures[t]).toEqual(proc);
  });
});
