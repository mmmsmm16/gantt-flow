// 出力（`docs/06-roadmap.md` Phase4）。Project → 表の行列。Excel/CSV はこの行列を各形式に流す。
import type { Project, ProcessTask, ProcessLevel, Id } from '../model/types';

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

export function projectToRows(project: Project): string[][] {
  const { tasks, dependencies, assignees } = project.core;
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of Object.values(tasks)) {
    const key = t.parentId ?? undefined;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(t);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);

  const nameOf = (id: Id) => tasks[id]?.name ?? '';
  const rows: string[][] = [EXPORT_HEADER];

  const walk = (parentId: Id | undefined, prefix: string) => {
    const arr = byParent.get(parentId) ?? [];
    arr.forEach((t, i) => {
      const no = t.code ?? (prefix ? `${prefix}-${i + 1}` : `${i + 1}`);
      const d = project.details[t.id];
      const prev = Object.values(dependencies)
        .filter((dep) => dep.to === t.id)
        .map((dep) => nameOf(dep.from))
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
      walk(t.id, no);
    });
  };
  walk(undefined, '');
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
