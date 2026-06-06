import { describe, it, expect } from 'vitest';
import { projectToRows, projectToCsv, rowsToCsv, EXPORT_HEADER } from '../src/export/exportRows';
import { importCsv, rowsToProject } from '../src/import/importCsv';
import { counter } from './helpers';

const CSV = `工程No,作業名,担当,粒度,前工程,インプット,アウトプット,課題
1,受注処理,営業部,大,,,,
1-1,注文書受付,営業,中,,注文書,受付票,確認漏れ
1-2,出荷準備,倉庫,中,注文書受付,,出荷指示書,`;

describe('export: Project → 行列 / CSV', () => {
  it('ヘッダ＋階層順の行を出力する', () => {
    const { project } = importCsv(CSV, counter('imp'));
    const rows = projectToRows(project);
    expect(rows[0]).toEqual(EXPORT_HEADER);
    const names = rows.slice(1).map((r) => r[1]);
    expect(names).toEqual(['受注処理', '注文書受付', '出荷準備']); // DFS 前順
    // 前工程列に依存が出る
    const shukka = rows.find((r) => r[1] === '出荷準備')!;
    expect(shukka[4]).toContain('注文書受付');
  });

  it('表の行列でラウンドトリップ（工程数・依存数が保たれる）', () => {
    const { project } = importCsv(CSV, counter('a'));
    const rows = projectToRows(project);
    const { project: p2 } = rowsToProject(rows, counter('b'));
    expect(Object.keys(p2.core.tasks)).toHaveLength(3);
    expect(Object.keys(p2.core.dependencies)).toHaveLength(1);
  });

  it('rowsToCsv はカンマ/改行をクオートする', () => {
    expect(rowsToCsv([['a,b', 'c']])).toBe('"a,b",c');
    expect(typeof projectToCsv(importCsv(CSV, counter('c')).project)).toBe('string');
  });
});
