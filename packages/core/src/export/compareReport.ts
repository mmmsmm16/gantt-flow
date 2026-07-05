// 改善効果レポートの集計・行列生成（As-Is / To-Be）。computeCompare の KPI に、
// 工程別差分・担当別工数・自動化率・構造差分をまとめた 1 つの純粋な CompareReport を返す。
// ComparisonDialog（画面）・reportHtml（HTML 出力）・Excel「改善効果」シートが同じ集計を共有する。
// 純関数（UI/OS 非依存）。値は分・日で保持し、表示側で h 換算・丸めをする。
import type { Core, TaskDetail, Difficulty, Id, Project } from '../model/types';
import {
  computeCompare,
  leafIds,
  leafEffortMinutes,
  leafLtDays,
  leafDifficulty,
  leafAutomation,
  type CompareTotals,
  type ComparePair,
} from '../compare';
import { computeCodes } from '../codes';
import { UNASSIGNED_LABEL } from '../metrics';

/** Excel の改善効果シート名。単独出力（exportImprovementExcel）と統合ブックの双方で共有。 */
export const IMPROVEMENT_SHEET_NAME = '改善効果';

/** 小数第1位で丸め（画面・レポート・シートで共通の表示丸め）。 */
export const round1 = (v: number): number => Math.round(v * 10) / 10;

const mkPair = (asis: number, tobe: number): ComparePair => ({ asis, tobe, delta: tobe - asis });

/** 工程のライフサイクル（To-Be 未指定は維持=kept）。 */
export type Lifecycle = 'added' | 'removed' | 'kept';

/** 工程別差分の 1 行（末端工程・ComparisonDialog の perRow と厳密一致）。 */
export interface CompareReportRow {
  taskId: Id;
  code: string;
  name: string;
  ownerAsis: string; // As-Is 担当（レーン）
  ownerTobe: string; // To-Be 担当（toBe.assigneeId で移動・未指定は As-Is と同じ）
  effortMinutes: ComparePair; // 工数（分）
  ltDays: ComparePair; // リードタイム（日）
  ltCutDays: number; // As-Is − To-Be（正＝短縮）
  difficultyAsis?: Difficulty;
  difficultyTobe?: Difficulty;
  lifecycle: Lifecycle;
  changed: boolean; // toBe があるか（表で「変更あり」と淡色表示を分ける）
  rationale?: string;
}

/** 自動化区分ごとの末端工程数（未設定は none）。 */
export interface AutomationDist {
  manual: number;
  partial: number;
  system: number;
  none: number;
}

/** 担当別の末端工数（分）。As-Is は As-Is 担当、To-Be は To-Be 担当（レーン移動反映）。 */
export interface CompareAssigneeRow {
  name: string;
  asis: number;
  tobe: number;
}

/** 構造変更の要約（ComparisonDialog の struct と厳密一致）。 */
export interface CompareStruct {
  added: string[];
  removed: string[];
  moved: string[];
  parallelized: number;
}

export interface CompareReport {
  totals: CompareTotals; // = computeCompare そのまま
  rows: CompareReportRow[];
  byAssignee: CompareAssigneeRow[];
  automation: { asis: AutomationDist; tobe: AutomationDist };
  automationRatePct: ComparePair; // (system + partial) ÷ 末端工程数 × 100（partial の重み付けはしない）
  struct: CompareStruct;
}

function assigneeName(core: Core, id: Id | undefined): string {
  return id ? core.assignees[id]?.name ?? UNASSIGNED_LABEL : UNASSIGNED_LABEL;
}

// 指定シナリオの末端集計から自動化区分の分布を作る（difficulty と同じ末端集合＝milestone 除外・phase 反映）。
function autoDist(core: Core, details: Record<Id, TaskDetail>, phase: 'asis' | 'tobe'): AutomationDist {
  const out: AutomationDist = { manual: 0, partial: 0, system: 0, none: 0 };
  for (const id of leafIds(core, details, phase)) {
    out[leafAutomation(details[id], phase) ?? 'none'] += 1;
  }
  return out;
}

// 自動化率(%) ＝ (system + partial) ÷ 末端工程数 × 100。分母 0 は 0%。
function ratePct(d: AutomationDist): number {
  const total = d.manual + d.partial + d.system + d.none;
  return total === 0 ? 0 : ((d.system + d.partial) / total) * 100;
}

/** 改善効果レポートの全集計を 1 度にまとめて返す（純関数）。 */
export function buildCompareReport(core: Core, details: Record<Id, TaskDetail>): CompareReport {
  const totals = computeCompare(core, details);
  const codes = computeCodes(core);

  // 工程別差分の行。末端（子を持たない）・milestone 非除外・工数/LT のいずれかが入っている行のみ
  // （ComparisonDialog の perRow を忠実移植。是正は IMPROVEMENTS.md 行きの別 issue）。
  const tasks = Object.values(core.tasks);
  const hasChild = new Set(tasks.map((t) => t.parentId).filter(Boolean) as string[]);
  const rows: CompareReportRow[] = tasks
    .filter((t) => !hasChild.has(t.id))
    .map((t): CompareReportRow => {
      const d = details[t.id];
      const effortMinutes = mkPair(leafEffortMinutes(d, 'asis'), leafEffortMinutes(d, 'tobe'));
      const ltDays = mkPair(leafLtDays(d, 'asis'), leafLtDays(d, 'tobe'));
      return {
        taskId: t.id,
        code: codes[t.id] ?? '',
        name: t.name,
        ownerAsis: assigneeName(core, t.assigneeId),
        ownerTobe: assigneeName(core, d?.toBe?.assigneeId ?? t.assigneeId),
        effortMinutes,
        ltDays,
        ltCutDays: ltDays.asis - ltDays.tobe,
        difficultyAsis: leafDifficulty(d, 'asis'),
        difficultyTobe: leafDifficulty(d, 'tobe'),
        lifecycle: d?.toBe?.lifecycle ?? 'kept',
        changed: !!d?.toBe,
        rationale: d?.toBe?.rationale,
      };
    })
    .filter((r) => r.effortMinutes.asis || r.effortMinutes.tobe || r.ltDays.asis || r.ltDays.tobe);

  // 担当別の末端工数（分）。As-Is は As-Is 担当・To-Be は To-Be 担当（レーン移動）で集計。
  const asisMap = new Map<string, number>();
  for (const id of leafIds(core, details, 'asis')) {
    const name = assigneeName(core, core.tasks[id]?.assigneeId);
    asisMap.set(name, (asisMap.get(name) ?? 0) + leafEffortMinutes(details[id], 'asis'));
  }
  const tobeMap = new Map<string, number>();
  for (const id of leafIds(core, details, 'tobe')) {
    const name = assigneeName(core, details[id]?.toBe?.assigneeId ?? core.tasks[id]?.assigneeId);
    tobeMap.set(name, (tobeMap.get(name) ?? 0) + leafEffortMinutes(details[id], 'tobe'));
  }
  const byAssignee: CompareAssigneeRow[] = [...new Set([...asisMap.keys(), ...tobeMap.keys()])]
    .map((name) => ({ name, asis: asisMap.get(name) ?? 0, tobe: tobeMap.get(name) ?? 0 }))
    .sort((a, b) => b.asis - a.asis || b.tobe - a.tobe || a.name.localeCompare(b.name, 'ja'));

  const asisAuto = autoDist(core, details, 'asis');
  const tobeAuto = autoDist(core, details, 'tobe');

  // 構造差分（新規 / 廃止 / 移動 / 並行化）。ComparisonDialog の struct と厳密一致。
  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  for (const t of tasks) {
    const tb = details[t.id]?.toBe;
    if (!tb) continue;
    if (tb.lifecycle === 'added') added.push(t.name);
    else if (tb.lifecycle === 'removed') removed.push(t.name);
    if (tb.assigneeId && tb.assigneeId !== t.assigneeId) moved.push(t.name);
  }
  const parallelized = Object.values(core.dependencies).filter((d) => d.phase === 'asis').length;

  return {
    totals,
    rows,
    byAssignee,
    automation: { asis: asisAuto, tobe: tobeAuto },
    automationRatePct: mkPair(ratePct(asisAuto), ratePct(tobeAuto)),
    struct: { added, removed, moved, parallelized },
  };
}

const LIFECYCLE_LABEL: Record<Lifecycle, string> = { added: '新設', removed: '廃止', kept: '維持' };

/** Excel「改善効果」シートの行列（KPI ＋ 工程別差分 ＋ 担当別工数）。人間が読む納品物なので日本語ヘッダ。 */
export function compareReportSheetRows(project: Project): string[][] {
  const r = buildCompareReport(project.core, project.details);
  const t = r.totals;
  const h = (min: number): string => String(round1(min / 60));
  const d1 = (v: number): string => String(round1(v));

  const rows: string[][] = [];
  rows.push(['改善効果サマリ（As-Is / To-Be）']);
  rows.push(['指標', 'As-Is', 'To-Be', '改善']);
  rows.push(['総工数(h)', h(t.effortMinutes.asis), h(t.effortMinutes.tobe), h(t.effortMinutes.delta)]);
  rows.push(['リードタイム(日)', d1(t.ltDays.asis), d1(t.ltDays.tobe), d1(t.ltDays.delta)]);
  rows.push(['待ち時間(日)', d1(t.waitDays.asis), d1(t.waitDays.tobe), d1(t.waitDays.delta)]);
  rows.push([
    '自動化率(%)',
    d1(r.automationRatePct.asis),
    d1(r.automationRatePct.tobe),
    d1(r.automationRatePct.delta),
  ]);
  rows.push([]);

  rows.push(['工程別差分']);
  rows.push([
    '工程No', '工程', '担当(As-Is)', '担当(To-Be)',
    '工数As-Is(h)', '工数To-Be(h)', 'LT As-Is(日)', 'LT To-Be(日)', '短縮(日)',
    '難易度As-Is', '難易度To-Be', '状態', '根拠',
  ]);
  for (const row of r.rows) {
    rows.push([
      row.code, row.name, row.ownerAsis, row.ownerTobe,
      h(row.effortMinutes.asis), h(row.effortMinutes.tobe),
      d1(row.ltDays.asis), d1(row.ltDays.tobe), d1(row.ltCutDays),
      row.difficultyAsis ?? '', row.difficultyTobe ?? '',
      LIFECYCLE_LABEL[row.lifecycle], row.rationale ?? '',
    ]);
  }
  rows.push([]);

  rows.push(['担当別工数(h)']);
  rows.push(['担当', 'As-Is', 'To-Be']);
  for (const a of r.byAssignee) rows.push([a.name, h(a.asis), h(a.tobe)]);

  return rows;
}
