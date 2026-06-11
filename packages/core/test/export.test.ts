import { describe, it, expect } from 'vitest';
import { projectToRows, projectToCsv, rowsToCsv, EXPORT_HEADER } from '../src/export/exportRows';
import { importCsv, rowsToProject } from '../src/import/importCsv';
import { addTask, addDependency } from '../src/commands';
import { counter, emptyProject, taskIdByName } from './helpers';

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
    // 前工程列には工程No が出る（作業名は重複しうるため）
    const shukka = rows.find((r) => r[1] === '出荷準備')!;
    expect(shukka[4]).toBe('1-1');
  });

  it('表の行列でラウンドトリップ（工程数・依存数が保たれる）', () => {
    const { project } = importCsv(CSV, counter('a'));
    const rows = projectToRows(project);
    const { project: p2 } = rowsToProject(rows, counter('b'));
    expect(Object.keys(p2.core.tasks)).toHaveLength(3);
    expect(Object.keys(p2.core.dependencies)).toHaveLength(1);
  });

  it('前工程列は既定で工程No、depRef:"name" なら作業名（XLSX/印刷など人間が読む出力用）', () => {
    const { project } = importCsv(CSV, counter('d'));
    const byCode = projectToRows(project); // 既定 'code'（CSV ラウンドトリップ維持）
    expect(byCode.find((r) => r[1] === '出荷準備')![4]).toBe('1-1');
    const byName = projectToRows(project, { depRef: 'name' });
    expect(byName.find((r) => r[1] === '出荷準備')![4]).toBe('注文書受付');
    expect(byName[0]).toEqual(EXPORT_HEADER); // ヘッダは共通
  });

  it('rowsToCsv はカンマ/改行をクオートする', () => {
    expect(rowsToCsv([['a,b', 'c']])).toBe('"a,b",c');
    expect(typeof projectToCsv(importCsv(CSV, counter('c')).project)).toBe('string');
  });

  it('エクスポート→再取込で詳細項目（業務内容/使用システム/工数/備考/方策）が保たれる', () => {
    const csv = `工程No,作業名,担当,粒度,前工程,インプット,アウトプット,課題,業務内容,使用システム,工数(分),備考
1,受注業務,営業部,大,,,,,,,,
1-1,内容確認,営業,中,,注文書,受付票,基準が属人的→チェックリストを標準化,目視で確認,販売管理,30,繁忙期は遅延`;
    const { project } = importCsv(csv, counter('a'));
    const { project: p2, report } = importCsv(projectToCsv(project), counter('b'));
    expect(report.warnings).toHaveLength(0);
    const id = Object.values(p2.core.tasks).find((t) => t.name === '内容確認')!.id;
    const d = p2.details[id]!;
    expect(d.how).toBe('目視で確認');
    expect(d.system).toBe('販売管理');
    expect(d.effortMinutes).toBe(30);
    expect(d.note).toBe('繁忙期は遅延');
    expect(d.inputs?.map((x) => x.name)).toEqual(['注文書']);
    expect(d.outputs?.map((x) => x.name)).toEqual(['受付票']);
    expect(d.issues).toHaveLength(1);
    expect(d.issues![0]).toMatchObject({ issue: '基準が属人的', measure: 'チェックリストを標準化' });
  });

  it('CSV 数式インジェクション: = + - @ で始まるセルを無害化し、再取込で元へ戻す', () => {
    const g = counter('x');
    let p = emptyProject();
    p = addTask(p, { name: '=HYPERLINK("http://evil","x")', level: 'large' }, g);
    p = addTask(p, { name: '+1234', level: 'medium', parentId: taskIdByName(p, '=HYPERLINK("http://evil","x")') }, g);

    const csv = projectToCsv(p);
    // 出力 CSV では数式トリガで始まるセルの先頭に ' が付く（Excel が文字列として扱う）
    expect(csv).toContain(`"'=HYPERLINK`);
    expect(csv).toContain(`'+1234`);

    // 再取込すると ' は剥がれ、元の作業名へ戻る（ラウンドトリップ維持）
    const { project: p2 } = importCsv(csv, counter('y'));
    const names = Object.values(p2.core.tasks).map((t) => t.name).sort();
    expect(names).toEqual(['+1234', '=HYPERLINK("http://evil","x")'].sort());
  });

  it('前工程は工程No で出力され、同名工程があっても再取込で正しく繋がる', () => {
    const g = counter('t');
    let p = emptyProject();
    p = addTask(p, { name: '受注業務', level: 'large' }, g);
    const ju = taskIdByName(p, '受注業務');
    p = addTask(p, { name: '内容確認', level: 'medium', parentId: ju }, g);
    const kakunin = taskIdByName(p, '内容確認');
    p = addTask(p, { name: '与信確認', level: 'medium', parentId: ju }, g);
    p = addTask(p, { name: '請求業務', level: 'large' }, g);
    const sei = taskIdByName(p, '請求業務');
    p = addTask(p, { name: '内容確認', level: 'medium', parentId: sei }, g); // 同名（別親）
    p = addDependency(p, kakunin, taskIdByName(p, '与信確認'), g);

    const rows = projectToRows(p);
    const yoshin = rows.find((r) => r[1] === '与信確認')!;
    expect(yoshin[4]).toBe('1-1'); // 作業名「内容確認」ではなく工程No

    const { project: p2, report } = rowsToProject(rows, counter('b'));
    expect(report.unresolvedDeps).toHaveLength(0);
    const deps = Object.values(p2.core.dependencies);
    expect(deps).toHaveLength(1);
    const from = p2.core.tasks[deps[0]!.from]!;
    expect(from.name).toBe('内容確認');
    expect(p2.core.tasks[from.parentId!]!.name).toBe('受注業務'); // 請求業務側に繋がない
  });
});
