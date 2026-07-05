// 工程に対する UI 横断の手続き。store（ドメイン）と useUI（ダイアログ/パネル）をまたぐ操作を
// ここに集約し、各ビュー（表・フロー・パレット等）での重複実装を防ぐ。
import { isMilestone, type FlowNodeId, type ProcessLevel } from '@gantt-flow/core';
import { useApp } from './store';
import { useUI, type ToastTone } from './ui/useUI';
import { parsePastedRows } from './pasteParse';

// 一括設定の粒度入力（大/中/小/詳細 または英字）を ProcessLevel へ。不正は null。
const LEVEL_INPUT: Record<string, ProcessLevel> = {
  大: 'large',
  中: 'medium',
  小: 'small',
  詳細: 'detail',
  large: 'large',
  medium: 'medium',
  small: 'small',
  detail: 'detail',
};

/**
 * 破壊的操作の完了トーストに「元に戻す」アクションを付けて出す共通ヘルパ。
 * run は 1 回の undo（= 直前の操作を巻き戻す）。押下でトーストは即時閉じる（ToastView の既存挙動）。
 * 工程削除・矢印/図形削除・課題/IO 削除など「確認レス or 即時の破壊操作」の直後に使う。
 */
export function toastUndo(message: string, tone: ToastTone = 'info'): void {
  useUI.getState().toast(message, tone, { label: '元に戻す', run: () => useApp.getState().undo() });
}

/** 入出力(IoItem)を削除し「元に戻す」アクション付きトーストを出す（表・詳細パネル共通）。 */
export function removeIoWithUndo(taskId: string, ioId: string): void {
  useApp.getState().removeIo(taskId, ioId);
  toastUndo('入出力を削除しました');
}

/** 課題(IssueItem)を削除し「元に戻す」アクション付きトーストを出す（表・詳細パネル共通）。 */
export function removeIssueWithUndo(taskId: string, issueId: string): void {
  useApp.getState().removeIssue(taskId, issueId);
  toastUndo('課題を削除しました');
}

/** 手順書ステップを削除し「元に戻す」トーストを出す（Delete キー・×ボタン共通）。 */
export function removeStepWithUndo(taskId: string, stepId: string): void {
  useApp.getState().removeStep(taskId, stepId);
  toastUndo('手順ステップを削除しました');
}

/** クリップボード（Excel 等）の各行を工程として一括追加（タブ区切り [作業名, 担当]）。
 *  アウトライン表・全項目表の両方から呼べる共通処理（ビュー非依存の store.pasteRowsAsTasks に委譲）。 */
export async function pasteRowsFromClipboard(): Promise<void> {
  let text: string;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    useUI.getState().toast('クリップボードを読み取れませんでした（ブラウザの許可が必要です）。', 'error');
    return;
  }
  const { rows, hadHeader, hierarchical } = parsePastedRows(text);
  const n = useApp.getState().pasteRowsAsTasks(rows);
  if (n) {
    const bits = [hadHeader ? '見出し行を判定して担当・工数も取り込み' : '', hierarchical ? '階層（親子）も復元しました' : '']
      .filter(Boolean)
      .join('・');
    useUI.getState().toast(`${n}件の工程を貼り付けました。${bits ? `（${bits}）` : ''}`, 'success');
  } else useUI.getState().toast('貼り付ける行がありませんでした。', 'info');
}

/** 前後関係（依存）を解除し「元に戻す」トーストを出す（表・全項目表・詳細パネル共通）。 */
export function removeDependencyWithUndo(depId: string, message = '前工程を解除しました'): void {
  useApp.getState().removeDependency(depId);
  toastUndo(message);
}

/**
 * 工程を選択し、粒度をその工程に合わせる（詳細パネルは開かない）。
 * 全体スコープで俯瞰中はスコープを維持（どの工程も見えている）。特定の親に絞って
 * 見ているときだけ、対象工程の文脈（親）へスコープを追従させる。
 *
 * 「選ぶだけ」の経路（行クリック等）で使う。詳細パネルが既に開いていれば selectedTaskId
 * 追従で表示対象が切り替わる（C-01: 開いていなければ勝手に開かない）。
 */
export function selectTask(taskId: string): void {
  const app = useApp.getState();
  const t = app.project.core.tasks[taskId];
  if (!t) return;
  const wasScoped = app.scopeParentId !== undefined;
  app.select(taskId);
  app.setLevel(t.level);
  if (wasScoped) app.setScope(t.parentId);
}

/**
 * 工程へジャンプ: 選択し、粒度をその工程に合わせ、詳細パネルを開く。
 * 選択＋粒度/スコープ同期は selectTask に集約。こちらは明示的に詳細を開く経路
 * （行のダブルクリック / パレット / I/O ポップオーバー / 新規作成直後など）で使う。
 *
 * revealInFlow: パレット検索ジャンプ専用。分割＋詳細表示では activePane='table' のとき
 * フローペインが畳まれ、ジャンプ先のノードが見えない（#5）。この経路に限りフローを
 * アクティブにして必ず見せる（表クリックやフロー→表の「表で表示」経路では倒さない）。
 */
export function revealTask(taskId: string, opts?: { revealInFlow?: boolean }): void {
  const app = useApp.getState();
  if (!app.project.core.tasks[taskId]) return;
  selectTask(taskId);
  const ui = useUI.getState();
  if (opts?.revealInFlow) ui.setActivePane('flow');
  ui.setInspectorOpen(true);
}

/**
 * 工程削除の標準確認ダイアログ。OK なら削除して true を返す（複数件は 1 undo 単位）。
 * キャンセル・対象なしは false。削除後の選択移動などは呼び出し側で行う。
 *
 * alsoFlowNodes: フロー上で工程ノードと制御/付箋ノードを混在選択して削除する経路用。
 * 図形も同じ undo 単位へ畳み込み、提示する「元に戻す」1 回で工程＋図形をまとめて復元する
 * （別 undo 単位のままだと図形が巻き戻らず、提示した undo が操作の一部しか戻せない問題への対処）。
 */
export async function confirmRemoveTasks(
  taskIds: string[],
  opts?: { alsoFlowNodes?: FlowNodeId[] },
): Promise<boolean> {
  const tasks = useApp.getState().project.core.tasks;
  const targets = taskIds.filter((id) => tasks[id]);
  if (targets.length === 0) return false;
  const single = targets.length === 1 ? tasks[targets[0]!] : undefined;
  const flowNodes = opts?.alsoFlowNodes ?? [];
  const withFlow = flowNodes.length > 0;
  // 単一行の削除は確認レス（トースト＋元に戻すの ToastAction 標準に一本化）。
  // 一括削除・図形を伴う混在削除は影響範囲が広いため従来どおりモーダルで確認する。
  if (!(single && !withFlow)) {
    const ok = await useUI.getState().confirm({
      title: single ? '工程を削除' : '工程を一括削除',
      message: single
        ? `「${single.name || '（無題）'}」を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`
        : `選択中の ${targets.length} 件の工程を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
      confirmLabel: '削除',
      danger: true,
    });
    if (!ok) return false;
  }
  const app = useApp.getState();
  // 図形を伴う混在削除は removeManyTasks に flowNodeIds を渡して 1 undo 単位に畳み込む
  // （単一工程でも removeTask 経路には乗せない＝図形が別 undo 単位に分かれるのを避ける）。
  if (withFlow) app.removeManyTasks(targets, flowNodes);
  else if (single) app.removeTask(single.id);
  else app.removeManyTasks(targets);
  const hadChildren =
    single && Object.values(tasks).some((t) => t.parentId === single.id);
  const taskLabel = single
    ? `「${single.name || '（無題）'}」を削除しました${hadChildren ? '（配下は繰り上げ）' : ''}`
    : `${targets.length} 件の工程を削除しました`;
  toastUndo(withFlow ? `${taskLabel}（図形を含む）` : taskLabel);
  return true;
}

/**
 * 担当の一括設定。プロンプトで担当名を尋ね（空欄＝未割当）、変更を適用したら true を返す。
 * マイルストーンは担当を持たないため対象から除外する（対象が 0 件なら案内トーストを出す）。
 * キャンセル・対象なしは false。選択の解除などは呼び出し側で行う。
 */
export async function bulkSetAssignee(taskIds: string[]): Promise<boolean> {
  const core = useApp.getState().project.core;
  const targets = taskIds.filter((id) => core.tasks[id] && !isMilestone(core, id));
  if (targets.length === 0) {
    useUI.getState().toast('担当を設定できる工程が選択されていません。', 'info');
    return false;
  }
  const name = await useUI.getState().promptText({
    title: '担当を一括設定',
    message: `選択中の ${targets.length} 件の担当を変更します（空欄で未割当）。`,
    placeholder: '担当（部門 / 個人）',
    confirmLabel: '設定',
  });
  if (name === null) return false;
  useApp.getState().setAssigneeManyByName(targets, name);
  return true;
}

/** 粒度の一括設定。大/中/小/詳細 を尋ね、変更を適用したら true。マイルストーンは対象外。 */
export async function bulkSetLevel(taskIds: string[]): Promise<boolean> {
  const core = useApp.getState().project.core;
  const targets = taskIds.filter((id) => core.tasks[id] && !isMilestone(core, id));
  if (targets.length === 0) {
    useUI.getState().toast('粒度を変更できる工程が選択されていません。', 'info');
    return false;
  }
  const input = await useUI.getState().promptText({
    title: '粒度を一括設定',
    message: `選択中の ${targets.length} 件の粒度を変更します。大 / 中 / 小 / 詳細 のいずれかを入力してください。`,
    placeholder: '大 / 中 / 小 / 詳細',
    confirmLabel: '設定',
  });
  if (input === null) return false;
  const level = LEVEL_INPUT[input.trim()];
  if (!level) {
    useUI.getState().toast('「大 / 中 / 小 / 詳細」のいずれかを入力してください。', 'error');
    return false;
  }
  useApp.getState().setLevelMany(targets, level);
  return true;
}

/** 工数の一括設定。時間で尋ね（例: 2 / 0.5）、変更を適用したら true。 */
export async function bulkSetEffort(taskIds: string[]): Promise<boolean> {
  const core = useApp.getState().project.core;
  const targets = taskIds.filter((id) => core.tasks[id]);
  if (targets.length === 0) return false;
  const input = await useUI.getState().promptText({
    title: '工数を一括設定',
    message: `選択中の ${targets.length} 件の工数を変更します（時間で入力・例: 2 や 0.5）。`,
    placeholder: '工数（時間）',
    confirmLabel: '設定',
  });
  if (input === null) return false;
  const hours = Number(input.trim());
  if (!Number.isFinite(hours) || hours < 0) {
    useUI.getState().toast('工数は 0 以上の数値（時間）で入力してください。', 'error');
    return false;
  }
  useApp.getState().setEffortMany(targets, Math.round(hours * 60));
  return true;
}
