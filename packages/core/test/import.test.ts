import { describe, it, expect } from 'vitest';
import { importCsv, parseCsv } from '../src/import/importCsv';
import { reconcileFlow } from '../src/sync/reconcileFlow';
import { validate } from '../src/validate';
import type { FlowTaskNode } from '../src/model/types';
import { counter, emptyView } from './helpers';

const CSV = `工程No,作業名,担当,粒度,前工程,インプット,アウトプット,課題
1,受注処理,営業部,大,,,,
1-1,注文書受付,営業,中,,注文書,受付票,確認漏れ
1-2,出荷準備,倉庫,中,注文書受付,,出荷指示書,`;

describe('importCsv（初回ブートストラップ）', () => {
  it('CSV を Project に変換し ID を発番する', () => {
    const { project, report } = importCsv(CSV, counter('imp'));
    expect(report.created.tasks).toBe(3);
    expect(report.created.dependencies).toBe(1);
    expect(report.created.ios).toBe(3);
    expect(report.created.issues).toBe(1);
    expect(report.unresolvedDeps).toHaveLength(0);
    // すべて UUID（ここでは決定論カウンタ）で発番されている
    expect(Object.keys(project.core.tasks).every((id) => id.startsWith('imp-'))).toBe(true);
  });

  it('粒度から階層（親子）が組まれる', () => {
    const { project } = importCsv(CSV, counter('imp'));
    const large = Object.values(project.core.tasks).find((t) => t.name === '受注処理')!;
    const recv = Object.values(project.core.tasks).find((t) => t.name === '注文書受付')!;
    expect(recv.parentId).toBe(large.id);
    expect(recv.level).toBe('medium');
  });

  it('参照整合性が保たれ、中工程ビューに 2 ノード＋エッジが出る', () => {
    const { project } = importCsv(CSV, counter('imp'));
    expect(validate(project)).toHaveLength(0);
    const largeId = Object.values(project.core.tasks).find((t) => t.name === '受注処理')!.id;
    const res = reconcileFlow(project.core, project.details, emptyView('medium', largeId), counter('n'));
    const nodes = Object.values(res.view.nodes).filter((n): n is FlowTaskNode => n.kind === 'task');
    expect(nodes).toHaveLength(2);
    expect(Object.values(res.view.edges)).toHaveLength(1);
  });

  it('解決できない前工程参照は report に記録', () => {
    const csv = `作業名,粒度,前工程\nA,中,\nB,中,存在しない工程`;
    const { report } = importCsv(csv, counter('imp'));
    expect(report.unresolvedDeps).toHaveLength(1);
    expect(report.unresolvedDeps[0]!.ref).toBe('存在しない工程');
  });

  it('CSV パーサはクオート/カンマ/改行を扱う', () => {
    const rows = parseCsv('a,"b,c","d\ne"\n1,2,3');
    expect(rows[0]).toEqual(['a', 'b,c', 'd\ne']);
    expect(rows[1]).toEqual(['1', '2', '3']);
  });
});
