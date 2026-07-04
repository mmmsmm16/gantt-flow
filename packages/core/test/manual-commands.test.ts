import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import {
  addTask,
  deleteTaskKeepChildren,
  upsertProcedure,
  addStep,
  updateStep,
  moveStep,
  addStepCond,
  updateStepCond,
  addStepRef,
  removeStepRef,
  addStepImage,
  upsertAsset,
  removeAsset,
} from '../src/commands';

const NOW = '2026-07-05T00:00:00.000Z';

function withLeaf() {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: '注文確認', level: 'medium', id: 't1' }, g);
  return { p, g };
}

it('upsertProcedure は doc を作り purpose/updatedAt を立てる', () => {
  const { p } = withLeaf();
  const out = upsertProcedure(p, 't1', { purpose: '不備を潰す' }, NOW);
  expect(out.manual.procedures.t1).toEqual({ taskId: 't1', purpose: '不備を潰す', steps: [], updatedAt: NOW, revisions: [] });
});

it('addStep は決定論 id・末尾追加・updatedAt', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '突合する', why: '誤りを潰す' }, g, NOW);
  const step = out.manual.procedures.t1!.steps[0]!;
  expect(step.action).toBe('突合する');
  expect(step.conds).toEqual([]);
  expect(step.refs).toEqual([]);
  expect(step.images).toEqual([]);
});

it('moveStep は先頭〜末尾へ並べ替え、updatedAt を立てる', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: 'A' }, g, NOW);
  out = addStep(out, 't1', { action: 'B' }, g, NOW);
  out = addStep(out, 't1', { action: 'C' }, g, NOW);
  const stepCId = out.manual.procedures.t1!.steps[2]!.id;
  out = moveStep(out, 't1', stepCId, 0, NOW);
  expect(out.manual.procedures.t1!.steps.map((s) => s.action)).toEqual(['C', 'A', 'B']);
});

it('updateStep はキー存在ベースの read-merge-write（値 undefined で当該キーが消える）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '突合する', why: '誤りを潰す' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = updateStep(out, 't1', stepId, { why: undefined }, NOW);
  expect(out.manual.procedures.t1!.steps[0]!.why).toBeUndefined();
  expect(out.manual.procedures.t1!.steps[0]!.action).toBe('突合する');
});

it('cond の飛び先 targetTaskId を保持し、clear もできる', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepCond(out, 't1', stepId, { when: '不備あり', thenMd: '差し戻す', targetTaskId: 't2' }, g, NOW);
  const condId = out.manual.procedures.t1!.steps[0]!.conds[0]!.id;
  expect(out.manual.procedures.t1!.steps[0]!.conds[0]!.targetTaskId).toBe('t2');
  out = updateStepCond(out, 't1', stepId, condId, { targetTaskId: undefined }, NOW);
  expect(out.manual.procedures.t1!.steps[0]!.conds[0]!.targetTaskId).toBeUndefined();
});

it('addStepRef は完全一致重複を張らない', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepRef(out, 't1', stepId, { kind: 'asset', assetId: 'asset1' }, NOW);
  out = addStepRef(out, 't1', stepId, { kind: 'asset', assetId: 'asset1' }, NOW);
  expect(out.manual.procedures.t1!.steps[0]!.refs).toEqual([{ kind: 'asset', assetId: 'asset1' }]);
});

it('removeStepRef は index 指定で 1 件だけ外す', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepRef(out, 't1', stepId, { kind: 'asset', assetId: 'asset1' }, NOW);
  out = addStepRef(out, 't1', stepId, { kind: 'asset', assetId: 'asset2' }, NOW);
  out = removeStepRef(out, 't1', stepId, 0, NOW);
  expect(out.manual.procedures.t1!.steps[0]!.refs).toEqual([{ kind: 'asset', assetId: 'asset2' }]);
});

it('addStepImage は決定論 id で画像を追加する', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepImage(out, 't1', stepId, { file: 'assets/abc.png', caption: '例' }, g, NOW);
  expect(out.manual.procedures.t1!.steps[0]!.images).toEqual([
    { id: expect.any(String), file: 'assets/abc.png', caption: '例' },
  ]);
});

it('工程削除で手順書も掃除される（deleteTaskKeepChildren）', () => {
  const { p } = withLeaf();
  let out = upsertProcedure(p, 't1', { purpose: 'x' }, NOW);
  out = deleteTaskKeepChildren(out, 't1');
  expect(out.manual.procedures.t1).toBeUndefined();
});

it('cond の targetTaskId ダングリングは削除で消さない（リンク切れ表示に委ねる）', () => {
  const g = counter();
  let p = emptyProject();
  p = addTask(p, { name: '親', level: 'medium', id: 'M' }, g);
  p = addTask(p, { name: 'A', level: 'small', parentId: 'M', id: 'A' }, g);
  p = addTask(p, { name: 'B', level: 'small', parentId: 'M', id: 'B' }, g);
  let out = upsertProcedure(p, 'A', {}, NOW);
  out = addStep(out, 'A', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.A!.steps[0]!.id;
  out = addStepCond(out, 'A', stepId, { when: '不備あり', thenMd: '差し戻す', targetTaskId: 'B' }, g, NOW);
  out = deleteTaskKeepChildren(out, 'B');
  expect(out.core.tasks.B).toBeUndefined();
  expect(out.manual.procedures.A!.steps[0]!.conds[0]!.targetTaskId).toBe('B');
});

it('upsertAsset/removeAsset は台帳を出し入れする', () => {
  const { p, g } = withLeaf();
  let out = upsertAsset(p, { id: 'asset1', name: '規程集', locator: { alias: 'docs', relPath: 'a.pdf' } }, g);
  expect(out.manual.assets.asset1).toEqual({
    id: 'asset1',
    name: '規程集',
    locator: { alias: 'docs', relPath: 'a.pdf' },
  });
  out = upsertAsset(out, { name: '外部リンク', locator: { url: 'https://example.com' } }, g);
  const urlAssetId = Object.keys(out.manual.assets).find((id) => id !== 'asset1')!;
  expect(out.manual.assets[urlAssetId]!.locator).toEqual({ url: 'https://example.com' });
  out = removeAsset(out, 'asset1');
  expect(out.manual.assets.asset1).toBeUndefined();
});
