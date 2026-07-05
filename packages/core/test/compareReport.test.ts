// 改善効果レポートの集計・行列生成（buildCompareReport / compareReportSheetRows）。
// totals は computeCompare と厳密一致・rows は ComparisonDialog の perRow 定義と一致。
import { describe, it, expect } from 'vitest';
import {
  buildCompareReport,
  compareReportSheetRows,
  IMPROVEMENT_SHEET_NAME,
  round1,
} from '../src/export/compareReport';
import { computeCompare, leafAutomation, hasAnyToBeInput } from '../src/compare';
import { addTask, addDependency } from '../src/commands';
import { counter, emptyProject, taskIdByName } from './helpers';

// compare.test.ts と同じ A→B→D / A→C→D（B・C 並行、C が As-Is の長い枝）フィクスチャ。
function build() {
  const g = counter('cr');
  let p = emptyProject();
  for (const name of ['A', 'B', 'C', 'D']) p = addTask(p, { name, level: 'medium' }, g);
  const id = (n: string) => taskIdByName(p, n);
  p = addDependency(p, id('A'), id('B'), g);
  p = addDependency(p, id('B'), id('D'), g);
  p = addDependency(p, id('A'), id('C'), g);
  p = addDependency(p, id('C'), id('D'), g);
  p.details[id('A')] = { taskId: id('A'), effortMinutes: 60, ltDays: 1, difficulty: 'M', automation: 'manual' };
  p.details[id('B')] = { taskId: id('B'), effortMinutes: 120, ltDays: 3, difficulty: 'H', automation: 'manual' };
  p.details[id('C')] = {
    taskId: id('C'),
    effortMinutes: 60,
    ltDays: 7,
    difficulty: 'H',
    automation: 'manual',
    // To-Be: 短縮・難易度 H→L・工数 60→30・手作業→システム自動
    toBe: { effortMinutes: 30, ltDays: 2, difficulty: 'L', automation: 'system', rationale: 'RPA化' },
  };
  p.details[id('D')] = { taskId: id('D'), effortMinutes: 120, ltDays: 2, difficulty: 'M', automation: 'partial' };
  return { p, id };
}

describe('buildCompareReport', () => {
  it('totals は computeCompare と厳密一致する（KPI の単一の真実）', () => {
    const { p } = build();
    const r = buildCompareReport(p.core, p.details);
    expect(r.totals).toEqual(computeCompare(p.core, p.details));
  });

  it('rows は末端の工数/LT を分・日で保持し、短縮(ltCutDays)は As-Is − To-Be', () => {
    const { p, id } = build();
    const r = buildCompareReport(p.core, p.details);
    const c = r.rows.find((x) => x.taskId === id('C'))!;
    expect(c.effortMinutes).toEqual({ asis: 60, tobe: 30, delta: -30 });
    expect(c.ltDays).toEqual({ asis: 7, tobe: 2, delta: -5 });
    expect(c.ltCutDays).toBe(5); // 7 − 2
    expect(c.difficultyAsis).toBe('H');
    expect(c.difficultyTobe).toBe('L');
    expect(c.lifecycle).toBe('kept');
    expect(c.changed).toBe(true);
    expect(c.rationale).toBe('RPA化');
    // toBe 無しの A は changed=false・To-Be は As-Is へフォールバック
    const a = r.rows.find((x) => x.taskId === id('A'))!;
    expect(a.changed).toBe(false);
    expect(a.effortMinutes).toEqual({ asis: 60, tobe: 60, delta: 0 });
  });

  it('自動化率＝(system+partial)÷末端工程数×100（partial の重み付けなし）', () => {
    const { p } = build();
    const r = buildCompareReport(p.core, p.details);
    // As-Is 自動化: manual A,B,C / partial D → (0+1)/4 = 25%
    expect(r.automation.asis).toEqual({ manual: 3, partial: 1, system: 0, none: 0 });
    expect(round1(r.automationRatePct.asis)).toBe(25);
    // To-Be: C が system へ → system 1 / partial 1 → (1+1)/4 = 50%
    expect(r.automation.tobe).toEqual({ manual: 2, partial: 1, system: 1, none: 0 });
    expect(round1(r.automationRatePct.tobe)).toBe(50);
    expect(round1(r.automationRatePct.delta)).toBe(25);
  });

  it('担当別工数は As-Is=As-Is担当・To-Be=To-Be担当（レーン移動反映）で分集計する', () => {
    const g = counter('as');
    let p = emptyProject();
    p.core.assignees['eigyo'] = { id: 'eigyo', name: '営業', kind: 'department' };
    p.core.assignees['keiri'] = { id: 'keiri', name: '経理', kind: 'department' };
    p = addTask(p, { name: 'X', level: 'medium', assigneeId: 'eigyo' }, g);
    p = addTask(p, { name: 'Y', level: 'medium', assigneeId: 'eigyo' }, g);
    p = addTask(p, { name: 'Z', level: 'medium', assigneeId: 'keiri' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p.details[id('X')] = { taskId: id('X'), effortMinutes: 60 };
    p.details[id('Y')] = { taskId: id('Y'), effortMinutes: 120, toBe: { assigneeId: 'keiri' } }; // 営業→経理へ移動
    p.details[id('Z')] = { taskId: id('Z'), effortMinutes: 30 };
    const r = buildCompareReport(p.core, p.details);
    const eigyo = r.byAssignee.find((a) => a.name === '営業')!;
    const kei = r.byAssignee.find((a) => a.name === '経理')!;
    expect(eigyo.asis).toBe(180); // X+Y
    expect(eigyo.tobe).toBe(60); // Y が経理へ移動 → X のみ
    expect(kei.asis).toBe(30); // Z
    expect(kei.tobe).toBe(150); // Z + 移動してきた Y
  });

  it('struct は新規/廃止/移動/並行化を集計する', () => {
    const g = counter('st');
    let p = emptyProject();
    for (const name of ['A', 'B']) p = addTask(p, { name, level: 'medium' }, g);
    p = addTask(p, { name: 'NEW', level: 'medium' }, g);
    const id = (n: string) => taskIdByName(p, n);
    p = addDependency(p, id('A'), id('B'), g);
    const depId = Object.keys(p.core.dependencies)[0]!;
    p.core.dependencies[depId]!.phase = 'asis'; // As-Is 専用依存＝並行化候補
    p.details[id('A')] = { taskId: id('A'), effortMinutes: 60, toBe: { assigneeId: 'lane9' } };
    p.details[id('NEW')] = { taskId: id('NEW'), effortMinutes: 30, toBe: { lifecycle: 'added' } };
    p.details[id('B')] = { taskId: id('B'), effortMinutes: 60, toBe: { lifecycle: 'removed' } };
    const r = buildCompareReport(p.core, p.details);
    expect(r.struct.added).toEqual(['NEW']);
    expect(r.struct.removed).toEqual(['B']);
    expect(r.struct.moved).toEqual(['A']);
    expect(r.struct.parallelized).toBe(1);
  });
});

describe('compareReportSheetRows', () => {
  it('KPI ブロック＋工程別差分＋担当別の見出しを持つ行列を返す', () => {
    const { p } = build();
    const rows = compareReportSheetRows(p);
    const flat = rows.map((r) => r.join('\t'));
    expect(flat[0]).toContain('改善効果サマリ');
    expect(flat).toContain('指標\tAs-Is\tTo-Be\t改善');
    expect(flat.some((l) => l.startsWith('総工数(h)'))).toBe(true);
    expect(flat.some((l) => l.startsWith('自動化率(%)'))).toBe(true);
    expect(flat).toContain('工程別差分');
    expect(flat).toContain('担当別工数(h)');
    // 総工数: As-Is 360 分 → 6h、To-Be 330 分 → 5.5h
    const eff = rows.find((r) => r[0] === '総工数(h)')!;
    expect(eff[1]).toBe('6');
    expect(eff[2]).toBe('5.5');
  });

  it('IMPROVEMENT_SHEET_NAME は「改善効果」', () => {
    expect(IMPROVEMENT_SHEET_NAME).toBe('改善効果');
  });
});

describe('leafAutomation / hasAnyToBeInput', () => {
  it('leafAutomation は To-Be で toBe.automation 優先・無ければ As-Is へフォールバック', () => {
    const d = { taskId: 't', automation: 'manual' as const, toBe: { automation: 'system' as const } };
    expect(leafAutomation(d, 'asis')).toBe('manual');
    expect(leafAutomation(d, 'tobe')).toBe('system');
    const d2 = { taskId: 't2', automation: 'partial' as const };
    expect(leafAutomation(d2, 'tobe')).toBe('partial'); // To-Be 未入力は As-Is と同一
    expect(leafAutomation(undefined, 'tobe')).toBeUndefined();
  });

  it('hasAnyToBeInput は toBe が 1 件でもあれば true', () => {
    const { p } = build();
    expect(hasAnyToBeInput(p.details)).toBe(true);
    expect(hasAnyToBeInput({})).toBe(false);
    expect(hasAnyToBeInput({ x: { taskId: 'x', effortMinutes: 10 } })).toBe(false);
  });
});
