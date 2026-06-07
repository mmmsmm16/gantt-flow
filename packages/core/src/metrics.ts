// 工数の集計（`docs/02-data-model.md` §3）。末端のみが値を持ち、親は子孫の末端工数の合計を導出。
import type { Core, TaskDetail, Id } from './model/types';

export function effortRollupMinutes(
  core: Core,
  details: Record<Id, TaskDetail>,
  taskId: Id,
): number {
  const children = Object.values(core.tasks).filter((t) => t.parentId === taskId);
  if (children.length === 0) return details[taskId]?.effortMinutes ?? 0;
  return children.reduce((sum, c) => sum + effortRollupMinutes(core, details, c.id), 0);
}

// 「分」を表示用に整形（>=60 は時間併記）。
export function formatMinutes(min: number): string {
  if (!min) return '0分';
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}時間${m}分` : `${h}時間`;
}

// 「分」を時間表示に（0.5h 単位想定）。例: 90 → "1.5h", 120 → "2h", 0 → "0h"。
export function formatHours(min: number): string {
  return `${parseFloat((min / 60).toFixed(2))}h`;
}
