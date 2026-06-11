// 出力（`docs/06-roadmap.md` Phase4）。Project → 表の行列。Excel/CSV はこの行列を各形式に流す。
import type { Project, ProcessTask, ProcessLevel, Id } from '../model/types';
import { computeCodes } from '../codes';

const LEVEL_LABEL: Record<ProcessLevel, string> = {
  large: '大',
  medium: '中',
  small: '小',
  detail: '詳細',
};

export const EXPORT_HEADER = [
  '工程No',
  '作業名',
  '担当',
  '粒度',
  '前工程',
  'インプット',
  'アウトプット',
  '課題',
  '業務内容',
  '使用システム',
  '工数(分)',
  '備考',
];

export interface ProjectToRowsOptions {
  /**
   * 前工程列の参照方法。
   * - 'code'（既定）: 工程No。再取込時に一意解決できるため CSV ラウンドトリップ用。
   * - 'name': 作業名。XLSX / 印刷など人間が読む出力用（旧来の表示）。
   */
  depRef?: 'code' | 'name';
}

export function projectToRows(project: Project, opts: ProjectToRowsOptions = {}): string[][] {
  const depRef = opts.depRef ?? 'code';
  const { tasks, dependencies, assignees } = project.core;
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of Object.values(tasks)) {
    const key = t.parentId ?? undefined;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(t);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);

  const nameOf = (id: Id) => tasks[id]?.name ?? '';
  const codes = computeCodes(project.core);
  const rows: string[][] = [EXPORT_HEADER];

  const walk = (parentId: Id | undefined) => {
    const arr = byParent.get(parentId) ?? [];
    arr.forEach((t) => {
      const no = codes[t.id]!;
      const d = project.details[t.id];
      // 前工程の参照は depRef で切替（'code'=工程No / 'name'=作業名）。欠けている側は
      // もう一方で補う（コード未計算・名前空の工程でも列を空にしない）。
      const prev = Object.values(dependencies)
        .filter((dep) => dep.to === t.id)
        .map((dep) =>
          depRef === 'name'
            ? nameOf(dep.from) || (codes[dep.from] ?? '')
            : codes[dep.from] ?? nameOf(dep.from),
        )
        .join('；');
      rows.push([
        no,
        t.name,
        t.assigneeId ? assignees[t.assigneeId]?.name ?? '' : '',
        LEVEL_LABEL[t.level],
        prev,
        (d?.inputs ?? []).map((x) => x.name).join('；'),
        (d?.outputs ?? []).map((x) => x.name).join('；'),
        (d?.issues ?? []).map((x) => (x.measure ? `${x.issue}→${x.measure}` : x.issue)).join('；'),
        d?.how ?? '',
        d?.system ?? '',
        d?.effortMinutes != null ? String(d.effortMinutes) : '',
        d?.note ?? '',
      ]);
      walk(t.id);
    });
  };
  walk(undefined);
  return rows;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

export function projectToCsv(project: Project): string {
  return rowsToCsv(projectToRows(project));
}
