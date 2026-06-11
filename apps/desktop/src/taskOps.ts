// 工程に対する UI 横断の手続き。store（ドメイン）と useUI（ダイアログ/パネル）をまたぐ操作を
// ここに集約し、各ビュー（表・フロー・パレット等）での重複実装を防ぐ。
import { useApp } from './store';
import { useUI } from './ui/useUI';

/**
 * 工程へジャンプ: 選択し、粒度をその工程に合わせ、詳細パネルを開く。
 * 全体スコープで俯瞰中はスコープを維持（どの工程も見えている）。特定の親に絞って
 * 見ているときだけ、対象工程の文脈（親）へスコープを追従させる。
 */
export function revealTask(taskId: string): void {
  const app = useApp.getState();
  const t = app.project.core.tasks[taskId];
  if (!t) return;
  const wasScoped = app.scopeParentId !== undefined;
  app.select(taskId);
  app.setLevel(t.level);
  if (wasScoped) app.setScope(t.parentId);
  useUI.getState().setInspectorOpen(true);
}

/**
 * 工程削除の標準確認ダイアログ。OK なら削除して true を返す（複数件は 1 undo 単位）。
 * キャンセル・対象なしは false。削除後の選択移動などは呼び出し側で行う。
 */
export async function confirmRemoveTasks(taskIds: string[]): Promise<boolean> {
  const tasks = useApp.getState().project.core.tasks;
  const targets = taskIds.filter((id) => tasks[id]);
  if (targets.length === 0) return false;
  const single = targets.length === 1 ? tasks[targets[0]!] : undefined;
  const ok = await useUI.getState().confirm({
    title: single ? '工程を削除' : '工程を一括削除',
    message: single
      ? `「${single.name || '（無題）'}」を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`
      : `選択中の ${targets.length} 件の工程を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
    confirmLabel: '削除',
    danger: true,
  });
  if (!ok) return false;
  const app = useApp.getState();
  if (single) app.removeTask(single.id);
  else app.removeManyTasks(targets);
  return true;
}
