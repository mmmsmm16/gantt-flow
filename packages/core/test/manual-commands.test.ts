import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import {
  addTask,
  deleteTaskKeepChildren,
  upsertProcedure,
  deleteProcedure,
  addProcedureRevision,
  addStep,
  updateStep,
  removeStep,
  moveStep,
  addStepCond,
  updateStepCond,
  removeStepCond,
  addStepRef,
  removeStepRef,
  addStepImage,
  updateStepImage,
  removeStepImage,
  upsertAsset,
  updateAsset,
  removeAsset,
} from '../src/commands';

const NOW = '2026-07-05T00:00:00.000Z';
const NOW2 = '2026-07-06T00:00:00.000Z'; // no-op ガードの再発防止用（違う now を渡しても updatedAt が動かないことを確認する）

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

it('moveStep は toIndex が範囲外なら先頭/末尾へクランプする', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: 'A' }, g, NOW);
  out = addStep(out, 't1', { action: 'B' }, g, NOW);
  out = addStep(out, 't1', { action: 'C' }, g, NOW);
  const stepCId = out.manual.procedures.t1!.steps[2]!.id;
  // 負値 → 先頭へクランプ
  out = moveStep(out, 't1', stepCId, -5, NOW);
  expect(out.manual.procedures.t1!.steps.map((s) => s.action)).toEqual(['C', 'A', 'B']);

  const stepAId = out.manual.procedures.t1!.steps[1]!.id; // 'A' は現在 index 1
  // 大きすぎる値 → 末尾へクランプ
  out = moveStep(out, 't1', stepAId, 999, NOW);
  expect(out.manual.procedures.t1!.steps.map((s) => s.action)).toEqual(['C', 'B', 'A']);
});

it('moveStep は to===from なら no-op（updatedAt も不変）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: 'A' }, g, NOW);
  out = addStep(out, 't1', { action: 'B' }, g, NOW);
  const stepBId = out.manual.procedures.t1!.steps[1]!.id;
  const before = out.manual.procedures.t1!.steps.map((s) => s.action);
  out = moveStep(out, 't1', stepBId, 1, NOW2);
  expect(out.manual.procedures.t1!.steps.map((s) => s.action)).toEqual(before);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
});

it('moveStep は stepId 不在なら no-op（steps/updatedAt とも不変）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: 'A' }, g, NOW);
  out = addStep(out, 't1', { action: 'B' }, g, NOW);
  const before = out.manual.procedures.t1!.steps;
  out = moveStep(out, 't1', 'no-such-step', 0, NOW2);
  expect(out.manual.procedures.t1!.steps).toEqual(before);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
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

it('addStepRef は完全一致重複を張らない（updatedAt も不変）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepRef(out, 't1', stepId, { kind: 'asset', assetId: 'asset1' }, NOW);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
  // 重複追加を別の now で呼んでも no-op（updatedAt が動いてしまう回帰を防止）
  out = addStepRef(out, 't1', stepId, { kind: 'asset', assetId: 'asset1' }, NOW2);
  expect(out.manual.procedures.t1!.steps[0]!.refs).toEqual([{ kind: 'asset', assetId: 'asset1' }]);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
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

it('upsertAsset は既存レコードを merge する（name のみ再 upsert しても desc/locator が消えない）', () => {
  const { p, g } = withLeaf();
  let out = upsertAsset(
    p,
    { id: 'asset1', name: '規程集', desc: '社内規程一式', locator: { alias: 'docs', relPath: 'a.pdf' } },
    g,
  );
  // name だけ指定して再 upsert（desc/locator キーは渡さない）→ 消えずに残る
  out = upsertAsset(out, { id: 'asset1', name: '規程集（改）' }, g);
  expect(out.manual.assets.asset1).toEqual({
    id: 'asset1',
    name: '規程集（改）',
    desc: '社内規程一式',
    locator: { alias: 'docs', relPath: 'a.pdf' },
  });
});

it('upsertAsset は locator に undefined を明示すればクリアできる', () => {
  const { p, g } = withLeaf();
  let out = upsertAsset(
    p,
    { id: 'asset1', name: '規程集', locator: { alias: 'docs', relPath: 'a.pdf' } },
    g,
  );
  out = upsertAsset(out, { id: 'asset1', name: '規程集', locator: undefined }, g);
  expect(out.manual.assets.asset1!.locator).toBeUndefined();
  expect(out.manual.assets.asset1!.name).toBe('規程集');
});

it('updateAsset はキー存在ベースの read-merge-write（name のみ更新しても他は保持）', () => {
  const { p, g } = withLeaf();
  let out = upsertAsset(
    p,
    { id: 'asset1', name: '規程集', desc: '社内規程一式', locator: { alias: 'docs', relPath: 'a.pdf' } },
    g,
  );
  out = updateAsset(out, 'asset1', { desc: '改訂版' });
  expect(out.manual.assets.asset1).toEqual({
    id: 'asset1',
    name: '規程集',
    desc: '改訂版',
    locator: { alias: 'docs', relPath: 'a.pdf' },
  });
});

it('updateAsset は対象不在なら no-op', () => {
  const { p } = withLeaf();
  const out = updateAsset(p, 'no-such-asset', { name: 'x' });
  expect(out.manual.assets['no-such-asset']).toBeUndefined();
});

it('deleteProcedure は手順書を丸ごと削除する', () => {
  const { p } = withLeaf();
  let out = upsertProcedure(p, 't1', { purpose: 'x' }, NOW);
  out = deleteProcedure(out, 't1');
  expect(out.manual.procedures.t1).toBeUndefined();
});

it('addProcedureRevision は改訂履歴を追記し updatedAt を立てる', () => {
  const { p } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addProcedureRevision(out, 't1', { note: '手順を追記', by: '担当A' }, NOW);
  expect(out.manual.procedures.t1!.revisions).toEqual([{ at: NOW, note: '手順を追記', by: '担当A' }]);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
});

it('removeStep は対象 step を 1 件だけ外し updatedAt を立てる', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: 'A' }, g, NOW);
  out = addStep(out, 't1', { action: 'B' }, g, NOW);
  const stepAId = out.manual.procedures.t1!.steps[0]!.id;
  out = removeStep(out, 't1', stepAId, NOW2);
  expect(out.manual.procedures.t1!.steps.map((s) => s.action)).toEqual(['B']);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW2);
});

it('removeStep は対象不在なら no-op（steps/updatedAt とも不変）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: 'A' }, g, NOW);
  const before = out.manual.procedures.t1!.steps;
  out = removeStep(out, 't1', 'no-such-step', NOW2);
  expect(out.manual.procedures.t1!.steps).toEqual(before);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
});

it('removeStepCond は対象 cond を 1 件だけ外し updatedAt を立てる', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepCond(out, 't1', stepId, { when: '不備あり', thenMd: '差し戻す' }, g, NOW);
  out = addStepCond(out, 't1', stepId, { when: '不備なし', thenMd: '次工程へ' }, g, NOW);
  const condAId = out.manual.procedures.t1!.steps[0]!.conds[0]!.id;
  out = removeStepCond(out, 't1', stepId, condAId, NOW2);
  expect(out.manual.procedures.t1!.steps[0]!.conds.map((c) => c.when)).toEqual(['不備なし']);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW2);
});

it('removeStepCond は対象不在なら no-op（conds/updatedAt とも不変）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepCond(out, 't1', stepId, { when: '不備あり', thenMd: '差し戻す' }, g, NOW);
  const before = out.manual.procedures.t1!.steps[0]!.conds;
  out = removeStepCond(out, 't1', stepId, 'no-such-cond', NOW2);
  expect(out.manual.procedures.t1!.steps[0]!.conds).toEqual(before);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
});

it('updateStepImage はキー存在ベースの read-merge-write で caption を更新・削除できる', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepImage(out, 't1', stepId, { file: 'assets/abc.png', caption: '例' }, g, NOW);
  const imageId = out.manual.procedures.t1!.steps[0]!.images[0]!.id;
  out = updateStepImage(out, 't1', stepId, imageId, { caption: '差し替え後' }, NOW2);
  expect(out.manual.procedures.t1!.steps[0]!.images[0]!.caption).toBe('差し替え後');
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW2);
  out = updateStepImage(out, 't1', stepId, imageId, { caption: undefined }, NOW2);
  expect(out.manual.procedures.t1!.steps[0]!.images[0]!.caption).toBeUndefined();
});

it('removeStepImage は対象 image を 1 件だけ外し updatedAt を立てる', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepImage(out, 't1', stepId, { file: 'assets/a.png' }, g, NOW);
  out = addStepImage(out, 't1', stepId, { file: 'assets/b.png' }, g, NOW);
  const imageAId = out.manual.procedures.t1!.steps[0]!.images[0]!.id;
  out = removeStepImage(out, 't1', stepId, imageAId, NOW2);
  expect(out.manual.procedures.t1!.steps[0]!.images.map((i) => i.file)).toEqual(['assets/b.png']);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW2);
});

it('removeStepImage は対象不在なら no-op（images/updatedAt とも不変）', () => {
  const { p, g } = withLeaf();
  let out = upsertProcedure(p, 't1', {}, NOW);
  out = addStep(out, 't1', { action: '確認する' }, g, NOW);
  const stepId = out.manual.procedures.t1!.steps[0]!.id;
  out = addStepImage(out, 't1', stepId, { file: 'assets/a.png' }, g, NOW);
  const before = out.manual.procedures.t1!.steps[0]!.images;
  out = removeStepImage(out, 't1', stepId, 'no-such-image', NOW2);
  expect(out.manual.procedures.t1!.steps[0]!.images).toEqual(before);
  expect(out.manual.procedures.t1!.updatedAt).toBe(NOW);
});
