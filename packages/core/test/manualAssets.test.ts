import { describe, expect, it } from 'vitest';
import { counter, emptyProject } from './helpers';
import { addTask, upsertProcedure, addStep, addStepImage } from '../src/commands';
import { collectReferencedAssetFiles } from '../src/manualAssets';
import { collectReferencedAssetFiles as fromIndex } from '../src';

const NOW = '2026-07-05T00:00:00.000Z';

// 手順書に画像を持つ末端工程を組み立てる小道具。
function withImages(files: { taskId: string; stepAction: string; files: string[] }[]) {
  const g = counter();
  let p = emptyProject();
  for (const spec of files) {
    p = addTask(p, { name: spec.taskId, level: 'medium', id: spec.taskId }, g);
    p = upsertProcedure(p, spec.taskId, {}, NOW);
    const stepId = `${spec.taskId}-s`;
    p = addStep(p, spec.taskId, { action: spec.stepAction, id: stepId }, g, NOW);
    spec.files.forEach((f, i) => {
      p = addStepImage(p, spec.taskId, stepId, { file: f, id: `${spec.taskId}-img-${i}` }, g, NOW);
    });
  }
  return p;
}

describe('collectReferencedAssetFiles', () => {
  it('手順書が無いプロジェクトは空集合', () => {
    expect(collectReferencedAssetFiles(emptyProject())).toEqual(new Set());
  });

  it('全 StepImage.file を集める（複数工程・複数ステップ・複数画像）', () => {
    const p = withImages([
      { taskId: 't1', stepAction: 'a', files: ['aaa.png', 'bbb.png'] },
      { taskId: 't2', stepAction: 'b', files: ['ccc.png'] },
    ]);
    expect(collectReferencedAssetFiles(p)).toEqual(new Set(['aaa.png', 'bbb.png', 'ccc.png']));
  });

  it('同一ファイルを 2 箇所で参照しても集合は 1 件（共有）', () => {
    const p = withImages([
      { taskId: 't1', stepAction: 'a', files: ['shared.png'] },
      { taskId: 't2', stepAction: 'b', files: ['shared.png'] },
    ]);
    expect(collectReferencedAssetFiles(p)).toEqual(new Set(['shared.png']));
  });

  it('index/commands から同じ関数が再エクスポートされている', () => {
    expect(fromIndex).toBe(collectReferencedAssetFiles);
  });
});
