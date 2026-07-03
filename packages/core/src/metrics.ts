// 工数の集計（`docs/02-data-model.md` §3）。末端のみが値を持ち、親は子孫の末端工数の合計を導出。
import type { Core, TaskDetail, Id } from './model/types';

// 全タスクの集計工数を 1 パス（O(n)）で計算する。表のソート・一覧描画・合計など、
// 複数タスク分が必要な場面ではタスクごとに effortRollupMinutes を呼ばずこちらを使う。
export function computeEffortRollups(
  core: Core,
  details: Record<Id, TaskDetail>,
): Map<Id, number> {
  const childrenByParent = new Map<Id, Id[]>();
  for (const t of Object.values(core.tasks)) {
    if (!t.parentId) continue;
    const list = childrenByParent.get(t.parentId);
    if (list) list.push(t.id);
    else childrenByParent.set(t.parentId, [t.id]);
  }
  const rollups = new Map<Id, number>();
  const visiting = new Set<Id>(); // 親参照に循環があっても無限再帰しない（循環の再訪は 0 扱い）
  const calc = (id: Id): number => {
    const memo = rollups.get(id);
    if (memo !== undefined) return memo;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const children = childrenByParent.get(id);
    const value = children
      ? children.reduce((sum, c) => sum + calc(c), 0)
      : details[id]?.effortMinutes ?? 0;
    visiting.delete(id);
    rollups.set(id, value);
    return value;
  };
  for (const id of Object.keys(core.tasks)) calc(id);
  return rollups;
}

// 単一タスク版（互換 API）。内部で全体を計算するため、ループ内では computeEffortRollups を使うこと。
export function effortRollupMinutes(
  core: Core,
  details: Record<Id, TaskDetail>,
  taskId: Id,
): number {
  return computeEffortRollups(core, details).get(taskId) ?? details[taskId]?.effortMinutes ?? 0;
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

// 「分」を編集欄・比較表示用の数値（h・小数1位丸め）へ。0.5h 刻み想定の入力でも、
// インポート等で半端な分数が入ると 0.16666… のような循環小数が画面に出てしまうため、
// 表示直前の丸めをこの1関数に集約する（元の effortMinutes は丸めず保持＝編集時の意味は変えない）。
export function effortMinutesToHours(min: number): number {
  return Math.round((min / 60) * 10) / 10;
}
