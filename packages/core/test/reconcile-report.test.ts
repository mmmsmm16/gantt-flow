// reconcileProjectWithReport: 各ビューの SyncReport（追加/撤去ノード）が呼び出し側へ上がること。
// UI（ストア）はこの report を使って「同期でどこが変わったか」をフラッシュ表示する。
import { describe, it, expect } from 'vitest';
import { addTask, addIoItem, deleteTask } from '../src/commands';
import {
  reconcileProject,
  reconcileProjectWithReport,
  ensureLevelView,
} from '../src/sync/reconcileProject';
import { counter, emptyProject, taskIdByName } from './helpers';

describe('reconcileProjectWithReport', () => {
  it('作業追加 → 追加されたタスクノードの id が report.added に上がる', () => {
    const g = counter();
    let p = reconcileProject(ensureLevelView(emptyProject(), 'medium'), counter('n'));
    p = addTask(p, { name: 'A', level: 'medium' }, g);

    const { project: next, reports } = reconcileProjectWithReport(p, counter('m'));
    expect(reports).toHaveLength(1);
    const rep = reports[0]!;
    expect(rep.level).toBe('medium');
    expect(rep.scopeParentId).toBeUndefined();
    expect(rep.report.added).toHaveLength(1);
    expect(rep.report.removed).toHaveLength(0);
    // added の id は実際にビューへ追加されたノードを指す
    const node = next.flow.byLevel[0]!.nodes[rep.report.added[0]!];
    expect(node?.kind).toBe('task');
  });

  it('複数ビュー: 対象粒度のビューにだけ added が上がる', () => {
    const g = counter();
    let p = ensureLevelView(ensureLevelView(emptyProject(), 'medium'), 'small');
    p = reconcileProject(p, counter('n'));
    p = addTask(p, { name: 'M', level: 'medium' }, g);

    const { reports } = reconcileProjectWithReport(p, counter('m'));
    expect(reports).toHaveLength(2);
    const med = reports.find((r) => r.level === 'medium')!;
    const sml = reports.find((r) => r.level === 'small')!;
    expect(med.report.added).toHaveLength(1);
    expect(sml.report.added).toHaveLength(0);
  });

  it('I/O 追加 → doc ノードが added に上がる', () => {
    const g = counter();
    let p = reconcileProject(ensureLevelView(emptyProject(), 'medium'), counter('n'));
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = reconcileProject(p, counter('n2'));
    p = addIoItem(p, taskIdByName(p, 'A'), 'inputs', { name: '注文書', kind: 'doc' }, g);

    const { project: next, reports } = reconcileProjectWithReport(p, counter('m'));
    const added = reports[0]!.report.added;
    expect(added).toHaveLength(1);
    expect(next.flow.byLevel[0]!.nodes[added[0]!]?.kind).toBe('doc');
  });

  it('作業削除 → 撤去されたノードの id が report.removed に上がる', () => {
    const g = counter();
    let p = reconcileProject(ensureLevelView(emptyProject(), 'medium'), counter('n'));
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = reconcileProject(p, counter('n2'));
    const nodeId = Object.keys(p.flow.byLevel[0]!.nodes)[0]!;
    p = deleteTask(p, taskIdByName(p, 'A'));

    const { reports } = reconcileProjectWithReport(p, counter('m'));
    expect(reports[0]!.report.removed).toEqual([nodeId]);
    expect(reports[0]!.report.added).toHaveLength(0);
  });

  it('変化のない再同期では report が空（冪等）かつ reconcileProject と結果が一致する', () => {
    const g = counter();
    let p = reconcileProject(ensureLevelView(emptyProject(), 'medium'), counter('n'));
    p = addTask(p, { name: 'A', level: 'medium' }, g);
    p = reconcileProject(p, counter('n2'));

    const { project: again, reports } = reconcileProjectWithReport(p, counter('m'));
    expect(reports[0]!.report.added).toHaveLength(0);
    expect(reports[0]!.report.removed).toHaveLength(0);
    expect(again).toEqual(reconcileProject(p, counter('m')));
  });

  it('スコープ付きビューは scopeParentId で同定できる', () => {
    const g = counter();
    let p = addTask(emptyProject(), { name: '親', level: 'large' }, g);
    const parentId = taskIdByName(p, '親');
    p = ensureLevelView(p, 'medium', parentId);
    p = reconcileProject(p, counter('n'));
    p = addTask(p, { name: '子', level: 'medium', parentId }, g);

    const { reports } = reconcileProjectWithReport(p, counter('m'));
    const rep = reports.find((r) => r.level === 'medium' && r.scopeParentId === parentId)!;
    expect(rep.report.added).toHaveLength(1);
  });
});
