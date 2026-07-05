// クイック追加 DSL のアプリ層アダプタ。純パーサ（quickAdd.ts）に、ストアから読んだ
// 文脈（既存担当名・選択行から決まる親/粒度・前工程候補）を与える。
// コマンドパレットと、アウトラインのクイック追加行が同じ解釈を共有するための単一ソース。
import { computeCodes, isMilestone } from '@gantt-flow/core';
import { useApp, resolveQuickAddParent } from './store';
import { parseQuickAdd, type QuickAddParsed } from './quickAdd';

// 前工程候補は「対象工程がまだ存在しない」前提で組む必要があるため suggestions.ts の
// prevCandidates をそのまま使えない（同じ規則をここで再現する）。# で粒度を変えると候補
// グループも変わるので、トークンだけ先に読んでから候補を作る 2 段階（走査コストは無視できる）。
export function parseQuickAddInApp(input: string): QuickAddParsed {
  const a = useApp.getState();
  const assigneeNames = Object.values(a.project.core.assignees).map((x) => x.name);
  const sel = a.selectedTaskId ? a.project.core.tasks[a.selectedTaskId] : undefined;
  const pre = parseQuickAdd(input, { assigneeNames, predecessors: [] });
  const level = pre.level ?? sel?.level ?? a.level;
  // 親は確定時（addTaskWithOptions）と同じ解決を使う＝チップに出る前工程候補と実際の配置が一致する。
  const parentId = resolveQuickAddParent(a.project.core.tasks, sel, level, a.scopeParentId);
  const taskCodes = computeCodes(a.project.core);
  // マイルストーンは「工程→MS」の一方向しか依存を張れない（commands/index.ts の isMilestone
  // ガードで MS からの出依存は無視される）ため、MS を前工程候補には出さない（suggestions.ts の
  // prevCandidates と同じ規則）。出さないと不可視の入力を許してしまい、確定時に無言で無視される。
  const predecessors = Object.values(a.project.core.tasks)
    .filter(
      (t) =>
        t.level === level &&
        (t.parentId ?? undefined) === (parentId ?? undefined) &&
        !isMilestone(a.project.core, t.id),
    )
    .sort((x, y) => x.order - y.order || x.id.localeCompare(y.id))
    .map((t) => ({ id: t.id, name: t.name, code: taskCodes[t.id] }));
  return parseQuickAdd(input, { assigneeNames, predecessors });
}
