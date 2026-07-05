// アプリ状態（Zustand）。core のコマンド＋reconcileProject＋history を薄く包む。
// 「コマンド → reconcileProject → history.push」が 1 編集＝1 undo 単位（docs/01-architecture §6）。
import { create } from 'zustand';
import { createStore, type StateCreator } from 'zustand/vanilla';
import {
  type Project,
  type Id,
  type ProcessLevel,
  type ProcessTask,
  type FlowNodeId,
  type FlowLevelView,
  type FlowEdge,
  type ControlKind,
  type IoKind,
  type IssueTarget,
  type TaskDetailPatch,
  type TaskDetailToBe,
  type IoItem,
  type IssueItem,
  type ImportReport,
  type StepRef,
  type AssetLocator,
  CURRENT_SCHEMA_VERSION,
  uuid,
  serializeProject,
  createHistory,
  reconcileProject,
  reconcileProjectWithReport,
  ensureLevelView,
  importCsv,
  rowsToProject,
  createSampleProject,
  TEMPLATES,
  tidyFlowView,
  nearestLaneOrder,
  laneTaskBaseY,
  laneHeight,
  laneLayout,
  nodeSize,
  nodeRect,
  routeEdge,
  LANE_MIN_H,
  ROW_SUB,
  SIZE,
  addTask as cAddTask,
  renameTask as cRenameTask,
  setTaskLevel as cSetTaskLevel,
  setTaskCode as cSetTaskCode,
  setAssignee as cSetAssignee,
  addAssignee as cAddAssignee,
  addDependency as cAddDependency,
  removeDependency as cRemoveDependency,
  setDependencyPhase as cSetDependencyPhase,
  addIoItem as cAddIoItem,
  removeIoItem as cRemoveIoItem,
  updateIoItem as cUpdateIoItem,
  addIssueItem as cAddIssueItem,
  removeIssueItem as cRemoveIssueItem,
  updateIssueItem as cUpdateIssueItem,
  updateTaskDetail as cUpdateTaskDetail,
  updateTaskToBe as cUpdateTaskToBe,
  copyAsIsToToBe as cCopyAsIsToToBe,
  deleteTaskKeepChildren as cDeleteTaskKeepChildren,
  reorderTask as cReorderTask,
  reparentTask as cReparentTask,
  addParallelTask as cAddParallelTask,
  makeParallel as cMakeParallel,
  upsertProcedure as cUpsertProcedure,
  addStep as cAddStep,
  updateStep as cUpdateStep,
  removeStep as cRemoveStep,
  moveStep as cMoveStep,
  addStepCond as cAddStepCond,
  updateStepCond as cUpdateStepCond,
  removeStepCond as cRemoveStepCond,
  addStepRef as cAddStepRef,
  removeStepRef as cRemoveStepRef,
  addStepImage as cAddStepImage,
  updateStepImage as cUpdateStepImage,
  removeStepImage as cRemoveStepImage,
  upsertAsset as cUpsertAsset,
  updateAsset as cUpdateAsset,
  removeAsset as cRemoveAsset,
  isMilestone,
  collectReferencedAssetFiles,
  runBatch,
  type BatchOp,
} from '@gantt-flow/core';
import { clearLastCommand } from './ui/lastCommand';
import { contentHashName, putAsset, broadcastAsset, pruneAssetStore } from './assetStore';
import { useUI, type ToastTone } from './ui/useUI';

const RANK: Record<ProcessLevel, number> = { large: 0, medium: 1, small: 2, detail: 3 };
const LEVELS: ProcessLevel[] = ['large', 'medium', 'small', 'detail'];

export const findView = (
  p: Project,
  level: ProcessLevel,
  scopeParentId?: Id,
): FlowLevelView | undefined =>
  p.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );

// 対象レーンが元工程のノードを収めきれない場合、必要ぶんだけ高さを拡張する
// （setLaneHeight と同じ規則: 拡張前の次レーン基準 y 以降のノードを delta ぶん下へシフト）。
// 下端の余白はレーン上端の余白（box.base - box.top）と対称にし、tidyFlowView の
// LANE_PAD 計算と同じ見た目（行数に依らず一定の余白）になるよう揃える。
// 実機FB「並行工程を追加するとスイムレーンをまたいでしまう」対策＝追加時のみレーン内に収める。
function growLaneToFit(view: FlowLevelView, laneId: Id, neededBottom: number): void {
  const lane = view.lanes[laneId];
  const box = laneLayout(view.lanes).find((b) => b.lane.id === laneId);
  if (!lane || !box) return;
  const cur = laneHeight(lane);
  const topInset = box.base - box.top;
  const required = Math.max(cur, Math.ceil(neededBottom - box.top + topInset));
  const delta = required - cur;
  if (delta <= 0) return;
  const threshold = laneTaskBaseY(view.lanes, lane.order + 1);
  lane.height = required;
  for (const n of Object.values(view.nodes)) {
    if (n.y >= threshold) n.y += delta;
  }
}

// 基準ノードの直下の空きサブ行（y = ref.y + k*ROW_SUB、x は同じ）を探す。
// 並行追加・並行化の連打でノードが重ならないようにする。基準がレーンに属していれば、
// そのレーンの範囲内に収まる候補だけを採用し、収まらなければレーンを拡張する（ドラッグ移動時の
// 自動追従はしない＝手動レーン高さ設定と衝突するため、追加時のみのガード）。基準が未割当
// レーン（レーン外）のときは従来どおりレーン無視で下へ積む。
function parallelSlotBelow(
  view: FlowLevelView,
  ref: { x: number; y: number; laneId?: Id },
  excludeId?: FlowNodeId,
): { x: number; y: number } {
  const taken = Object.values(view.nodes).filter(
    (n) => (n.kind === 'task' || n.kind === 'control') && n.id !== excludeId,
  );
  const occupied = (y: number) =>
    taken.some((n) => Math.abs(n.x - ref.x) < SIZE.task.w && Math.abs(n.y - y) < SIZE.task.h);
  const lane = ref.laneId ? view.lanes[ref.laneId] : undefined;
  const box = lane ? laneLayout(view.lanes).find((b) => b.lane.id === lane.id) : undefined;
  const bottom = box ? box.top + box.height : undefined;

  let y = ref.y + ROW_SUB;
  for (let k = 1; k <= taken.length + 1; k++) {
    y = ref.y + k * ROW_SUB;
    if (bottom !== undefined && y + SIZE.task.h > bottom) break; // レーン内に空きなし → 拡張へ
    if (!occupied(y)) return { x: ref.x, y };
  }
  if (lane) {
    growLaneToFit(view, lane.id, y + SIZE.task.h);
    return { x: ref.x, y };
  }
  return { x: ref.x, y: ref.y + ROW_SUB }; // 到達しない保険
}

// クイック追加の #粒度 が選択行の粒度と異なるときの親解決（store とパレットで共有＝
// チップ表示と確定の解釈を一致させる）。選択行の親をそのまま使うと「大の子に大」のような
// どのビューにも出ない階層矛盾を作るため、目的粒度の親になれる祖先を選択行自身から辿る。
// 見つからなければ現在ビューのスコープ末尾（addTask の規約）へフォールバック。
export function resolveQuickAddParent(
  tasks: Record<Id, ProcessTask>,
  sel: ProcessTask | undefined,
  level: ProcessLevel,
  fallbackParentId: Id | undefined,
): Id | undefined {
  if (!sel) return fallbackParentId;
  if (sel.level === level) return sel.parentId;
  if (level === 'large') return undefined;
  const wantRank = RANK[level] - 1;
  let cur: ProcessTask | undefined = sel;
  while (cur && RANK[cur.level] > wantRank) cur = cur.parentId ? tasks[cur.parentId] : undefined;
  return cur && RANK[cur.level] === wantRank ? cur.id : fallbackParentId;
}

// 全体スコープの子ビューに出る「大またぎブリッジ」エッジか。derivedFromDependencyId が
// 親レベルの依存を指す＝依存の from/to と端点の工程が一致しない。挿入（insertTaskOnEdge）を
// 許すと親依存の削除＋親なし中間工程ができるため、store と FlowCanvas が同じ判定で弾く。
export function isBridgeEdge(p: Project, view: FlowLevelView, edge: FlowEdge): boolean {
  const dep = edge.derivedFromDependencyId
    ? p.core.dependencies[edge.derivedFromDependencyId]
    : undefined;
  if (!dep) return false;
  const s = view.nodes[edge.source];
  const t = view.nodes[edge.target];
  const sTaskId = s?.kind === 'task' ? s.taskId : undefined;
  const tTaskId = t?.kind === 'task' ? t.taskId : undefined;
  return dep.from !== sTaskId || dep.to !== tTaskId;
}

// 「次工程を追加」(n) の配置: 基準ノードの右隣（同じ行＝同レーン）。既存の箱もの（工程/制御/付箋）と
// 重なる間は 1 枠ずつ右へずらす簡易回避（探索上限あり＝極端な密集では最後の候補位置を許容）。
const NEXT_GAP_X = 40;
function nextTaskPos(
  view: FlowLevelView,
  base: { x: number; y: number },
  selfId: FlowNodeId,
): { x: number; y: number } {
  const { w, h } = SIZE.task;
  const boxes = Object.values(view.nodes).filter(
    (n) => n.id !== selfId && (n.kind === 'task' || n.kind === 'control' || n.kind === 'comment'),
  );
  let x = base.x + w + NEXT_GAP_X;
  const y = base.y;
  const hit = () =>
    boxes.some((o) => {
      const s = nodeSize(o);
      return x < o.x + s.w && x + w > o.x && y < o.y + s.h && y + h > o.y;
    });
  for (let i = 0; i < 50 && hit(); i++) x += w + NEXT_GAP_X;
  return { x: Math.round(x), y: Math.round(y) };
}

// 段積み配置: base（左上）から右下へ 1 枠ずつずらし、既存の箱ノード（工程/制御/付箋）と
// 重ならない最初の位置を返す。制御ノード・付箋を連続追加したとき（特に画面中央スポーン）に
// 既存ノードの真上へ重なって「追加が効かない」ように見えるのを防ぐ（必ずズレて置かれる）。
const STACK_DX = 26;
const STACK_DY = 22;
function stackSlot(
  view: FlowLevelView,
  baseX: number,
  baseY: number,
  size: { w: number; h: number },
): { x: number; y: number } {
  const boxes = Object.values(view.nodes).filter(
    (n) => n.kind === 'task' || n.kind === 'control' || n.kind === 'comment',
  );
  for (let k = 0; k <= boxes.length; k++) {
    const x = Math.round(baseX + k * STACK_DX);
    const y = Math.round(baseY + k * STACK_DY);
    const hit = boxes.some((o) => {
      const s = nodeSize(o);
      return x < o.x + s.w && x + size.w > o.x && y < o.y + s.h && y + size.h > o.y;
    });
    if (!hit) return { x, y };
  }
  const k = boxes.length + 1;
  return { x: Math.round(baseX + k * STACK_DX), y: Math.round(baseY + k * STACK_DY) };
}

// 部分整列で「固定扱い」にするノード集合（選択した工程ノード以外を固定）。tidyFlow と
// wouldTidyFlow が同じ規則を使うよう切り出す。selectedIds 空/未指定なら全体整列（固定なし）。
function tidyKeepFixed(
  view: FlowLevelView,
  selectedIds?: FlowNodeId[],
): Set<FlowNodeId> | undefined {
  if (!selectedIds || !selectedIds.length) return undefined;
  const selSet = new Set(selectedIds);
  return new Set(
    Object.values(view.nodes)
      .filter((n) => n.kind === 'task' && !selSet.has(n.id))
      .map((n) => n.id),
  );
}

// 自動整列が変えるのはノードの x/y とレーン高さだけ。この 2 つが全て一致すれば「差分なし」＝
// 整列しても見た目は変わらない（確認を出さず no-op として扱う判定に使う）。
function sameLayout(a: FlowLevelView, b: FlowLevelView): boolean {
  for (const id in a.nodes) {
    const na = a.nodes[id]!;
    const nb = b.nodes[id];
    if (!nb || na.x !== nb.x || na.y !== nb.y) return false;
  }
  for (const id in a.lanes) {
    if ((a.lanes[id]?.height ?? undefined) !== (b.lanes[id]?.height ?? undefined)) return false;
  }
  return true;
}

function initialProject(): Project {
  const now = new Date().toISOString();
  const base: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { id: uuid(), title: '新規プロジェクト', createdAt: now, updatedAt: now, appVersion: '0.0.0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
    manual: { procedures: {}, assets: {} },
  };
  return reconcileProject(ensureLevelView(base, 'medium'), uuid);
}

/** パレットのクイック追加 DSL（parseQuickAdd）の解釈結果を受けるオプション。 */
export interface AddTaskOptions {
  name: string;
  level?: ProcessLevel;
  assigneeName?: string;
  effortMinutes?: number;
  predecessorId?: Id;
}

/** 両窓編集同期（dualwindow）: 作成系操作の「発信元の窓だけで実行する後処理」の種別。
    rename=作成直後にその場リネーム / inspector=詳細を開く / select=選択のみ。 */
export type FocusIntent = 'rename' | 'inspector' | 'select';

/** リーダー→フォロワーへ、作成した工程 id と発信元の窓 id を伝える一時シグナル（origin 一致の窓だけが実行）。
    seq で 1 回だけ発火させる（lastSyncAdded と同じ規約）。applyRemoteSnapshot 経由でのみ従属窓へ届く。 */
export interface FocusHint {
  taskId?: Id;
  origin: string;
  /** 後処理の種別。トーストだけを運ぶ hint（undo/redo の結果など）では省略できる。 */
  intent?: FocusIntent;
  surface?: 'table' | 'flow';
  /** 発信元窓へ届けるトースト（undo/redo の結果・境界メッセージ）。リーダーでは巻き戻して出さない。 */
  toast?: { message: string; tone: ToastTone };
  seq: number;
}

/** リーダーが従属窓へ配る「同期対象フィールド」だけのスナップショット（表示状態＝level/scope/選択は含めない）。 */
export interface RemoteSnapshot {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  lastSyncAdded?: { ids: FlowNodeId[]; seq: number };
  lastAssigneeSync?: { ids: Id[]; seq: number };
  focusHint?: FocusHint | null;
}

export interface AppState {
  project: Project;
  canUndo: boolean;
  canRedo: boolean;
  selectedTaskId?: Id;
  level: ProcessLevel;
  scopeParentId?: Id;
  showIssues: boolean;
  dirty: boolean;
  /** 直近の表側編集（commit）の同期で「現在表示中ビュー」に自動追加されたノード。
      フロー側が一時ハイライトに使う。連続編集では seq を進めて最新の追加だけが光る。 */
  lastSyncAdded: { ids: FlowNodeId[]; seq: number };
  /** フローのレーン移動 → 担当書き戻し（逆同期）が起きた工程。表側の担当セルの一時ハイライト用。 */
  lastAssigneeSync: { ids: Id[]; seq: number };
  /** 両窓編集同期: 発信元の窓へ「作成した工程へリネーム/詳細/選択を寄せる」を伝えるシグナル（null=無し）。
      リーダーが従属窓の作成操作を代行したとき set し、applyRemoteSnapshot で従属窓へ運ぶ。 */
  focusHint: FocusHint | null;

  addTask: (name: string) => void;
  /** ルート工程を追加し、新しい工程の ID を返す（追加直後に選択＋名前を即編集するため）。
      名前は空（''）＝addSiblingOf/クイック追加と同じ「無題で作って即入力」の規約。 */
  addRootTask: (level: ProcessLevel) => Id | undefined;
  /** 子工程を追加し、新しい工程の ID を返す（フォーカス/選択用）。 */
  addChildTask: (parentId: Id) => Id | undefined;
  /** マイルストーンを追加（現在ビューの level/scope。子工程・担当・工数は持たない）。
      x,y を渡せばその位置（未紐付け時はそのまま菱形の位置になる）へ、省略時は既定位置に
      軽く段積みする。表の行追加・フローの追加ボタン・コマンドパレットが同じこのアクションを
      呼ぶ（作成導線の一本化）。作成 ID を返す。 */
  addMilestone: (x?: number, y?: number) => Id | undefined;
  removeTask: (taskId: Id) => void;
  setTaskLevel: (taskId: Id, level: ProcessLevel) => void;
  setTaskCode: (taskId: Id, code: string | undefined) => void;
  renameTask: (taskId: Id, name: string) => void;
  setAssigneeByName: (taskId: Id, name: string) => void;
  /** 複数工程の担当を一括設定（1 undo 単位）。空名は未割当に。 */
  setAssigneeManyByName: (taskIds: Id[], name: string) => void;
  /**
   * 複数工程を一括削除（各々の配下は1つ上へ繰り上げ、1 undo 単位）。
   * flowNodeIds を渡すと現在ビューの制御/付箋ノード（と接続エッジ）も同じ undo 単位で撤去する
   * ＝図形＋工程の混在削除を 1 回の「元に戻す」で丸ごと復元できる。
   */
  removeManyTasks: (taskIds: Id[], flowNodeIds?: FlowNodeId[]) => void;
  addDependency: (from: Id, to: Id) => void;
  removeDependency: (depId: Id) => void;
  /** 依存の所属シナリオを変更（undefined=両方 / 'asis'=To-Beで解除＝並行化 / 'tobe'=To-Be専用）。 */
  setDependencyPhase: (depId: Id, phase: 'asis' | 'tobe' | undefined) => void;
  /** To-Be 上の前工程を 1 本に設定（既存の To-Be 専用 incoming を置換）。新設工程の接続に使う。 */
  setToBePredecessor: (taskId: Id, fromId: Id | undefined) => void;
  /** To-Be の前工程を 1 本追加（As-Is 専用依存は両方へ昇格 / 無ければ To-Be 専用で新設）。 */
  addToBePredecessor: (taskId: Id, fromId: Id) => void;
  /** To-Be の前工程を 1 本外す（両方→As-Is専用 / To-Be専用→削除）。As-Is は保つ。 */
  removeToBePredecessor: (taskId: Id, fromId: Id) => void;
  addSiblingOf: (taskId: Id) => Id | undefined;
  /** クイック追加: 作成＋担当＋工数＋前工程の依存を 1 undo 単位で合成し、作成工程を選択する。
      選択中の工程と同じ粒度ならその直下（同じ親）へ挿入（addSiblingOf と同じ位置規則）。
      #粒度 が選択行と異なるときの親は resolveQuickAddParent で解決（階層矛盾を作らない）。
      粒度未指定は選択工程と同じ、なければ現在の表示粒度。 */
  addTaskWithOptions: (opts: AddTaskOptions) => Id;
  /** 工程を複製（同じ粒度・親の直後に、詳細＝I/O・課題なども複製）。1 undo。 */
  duplicateTask: (taskId: Id) => Id | undefined;
  /** クリップボード由来の行（[作業名, 担当?] ...）をまとめて工程として追加。作成数を返す。 */
  pasteRowsAsTasks: (rows: string[][]) => number;
  moveTaskUp: (taskId: Id) => void;
  moveTaskDown: (taskId: Id) => void;
  indentTask: (taskId: Id) => void;
  outdentTask: (taskId: Id) => void;
  dropTask: (dragId: Id, targetId: Id, mode: 'before' | 'after' | 'child') => void;
  addIo: (taskId: Id, io: 'inputs' | 'outputs', name: string) => void;
  updateIo: (taskId: Id, ioId: Id, patch: Partial<Pick<IoItem, 'name' | 'kind' | 'formInfo' | 'source'>>) => void;
  removeIo: (taskId: Id, ioId: Id) => void;
  addIssue: (taskId: Id, text: string) => void;
  /** 方策だけ先に入力されたとき、課題文は空のまま方策付きで起票する。 */
  addIssueWithMeasure: (taskId: Id, measure: string) => void;
  updateIssue: (taskId: Id, issueId: Id, patch: Partial<Pick<IssueItem, 'issue' | 'measure' | 'target'>>) => void;
  removeIssue: (taskId: Id, issueId: Id) => void;
  updateDetail: (taskId: Id, patch: TaskDetailPatch) => void;
  /** To-Be 差分の部分更新（undefined のキーは削除＝現状に戻す）。 */
  updateToBe: (taskId: Id, patch: Partial<TaskDetailToBe>) => void;
  /** As-Is の現状値を To-Be の起点へ複製。 */
  copyAsIsToToBe: (taskId: Id) => void;
  /** 複数工程の As-Is 値を To-Be の起点へ一括複製（1 undo 単位）。複製できた件数を返す。 */
  copyAsIsToToBeMany: (taskIds: Id[]) => number;
  /** To-Be で新設する工程(lifecycle='added')を作る。As-Is には出ない。作成 ID を返す。 */
  addToBeTask: () => Id | undefined;

  /** AI 承認バッチの一括適用。resolveApproved で選ばれた ops を本番 uuid で runBatch し、
      commit 経由で 1 スナップショット＝1 undo にする（reconcile は commit が担当）。 */
  /** 承認バッチを本番 uuid で適用（1 undo）。ref→実 taskId の aliases を返す（見送り継続用）。 */
  applyApprovedBatch: (ops: BatchOp[]) => Record<string, Id>;

  // --- 手順書（manual）。core/details/flow は触らず manual のみ更新（各コマンドへ now を注入）。 ---
  /** 工程の手順書の目的を設定（doc を確保して purpose/updatedAt を立てる。空文字で目的をクリア）。 */
  upsertProcedurePurpose: (taskId: Id, purpose: string) => void;
  /** ステップを末尾に追加し、新しいステップ ID を返す（事前 uuid を注入）。 */
  addStep: (taskId: Id, args: { action: string; why?: string; bodyMd?: string }) => Id | undefined;
  updateStep: (taskId: Id, stepId: Id, patch: { action?: string; why?: string; bodyMd?: string }) => void;
  removeStep: (taskId: Id, stepId: Id) => void;
  moveStep: (taskId: Id, stepId: Id, toIndex: number) => void;
  /** ステップに条件（〜の場合→対処・飛び先）を追加し、新しい条件 ID を返す。 */
  addStepCond: (taskId: Id, stepId: Id, args: { when: string; thenMd: string; targetTaskId?: Id }) => Id | undefined;
  updateStepCond: (taskId: Id, stepId: Id, condId: Id, patch: { when?: string; thenMd?: string; targetTaskId?: Id }) => void;
  removeStepCond: (taskId: Id, stepId: Id, condId: Id) => void;
  addStepRef: (taskId: Id, stepId: Id, ref: StepRef) => void;
  removeStepRef: (taskId: Id, stepId: Id, index: number) => void;
  // ---- ステップ画像（manual の StepImage）。Project には file 名だけ入り、実バイトは assetStore
  // （メモリ層）に持つ＝undo/autosave に乗らない。追加時に二窓へ bytes を配布する。 ----
  /** 画像 bytes を assetStore へ格納・二窓へ配布し、内容ハッシュ名だけを手順書へ追加する。 */
  addStepImage: (taskId: Id, stepId: Id, bytes: Uint8Array, mime: string, caption?: string) => void;
  updateStepImage: (taskId: Id, stepId: Id, imageId: Id, patch: { caption?: string }) => void;
  removeStepImage: (taskId: Id, stepId: Id, imageId: Id) => void;
  // ---- 資料台帳（manual.assets）。手順書のステップから参照される資料の唯一の実体。 ----
  /** 資産を追加/更新する（id 指定時は既存レコードへ merge）。事前 uuid を注入し、新規/対象 ID を返す。 */
  upsertAsset: (args: { id?: Id; name: string; desc?: string; locator?: AssetLocator }) => Id | undefined;
  updateAsset: (assetId: Id, patch: { name?: string; desc?: string; locator?: AssetLocator }) => void;
  removeAsset: (assetId: Id) => void;
  /** フロー上のドラッグ確定。別レーンへ落ちて担当が書き戻った場合は新しい担当名を返す（UI 通知用）。 */
  moveNode: (nodeId: FlowNodeId, x: number, y: number) => string | undefined;
  /** 複数ノードをまとめて (dx,dy) 平行移動（1 undo 単位）。レーン再割当はしない。 */
  moveNodesBy: (nodeIds: FlowNodeId[], dx: number, dy: number) => void;
  /** フロー上で工程を新規作成し、ドロップ位置のレーン(担当)へ配置する（表へ自動反映）。作成 ID を返す。 */
  addTaskAt: (x: number, y: number) => Id | undefined;
  /** 並行工程を追加（前工程のみコピー）。フロー上は基準ノードの直下の空きへ配置。1 undo。 */
  addParallel: (taskId: Id) => Id | undefined;
  /** 既存工程を基準工程と並行にする（依存を付け替え、旧チェーンは直結で修復）。1 undo。 */
  makeParallelTo: (taskId: Id, baseTaskId: Id) => void;
  /** フローの「次工程を追加」(n)。基準工程の右隣（同レーン・重なり回避）へ新規工程を作成し、
      基準からの依存接続まで 1 undo で行う。connect:false（Shift+N）は接続なし。作成 ID を返す。 */
  addTaskNextTo: (baseTaskId: Id, opts?: { connect?: boolean }) => Id | undefined;
  /** 矢印の途中に工程を挿入（A→B を A→新規→B に分割）。導出エッジは依存を分割し、
      pinned エッジは 2 本に張り直す。作成 ID を返す。1 undo 単位。 */
  insertTaskOnEdge: (edgeId: Id) => Id | undefined;
  /** 接続ドラッグを空白で離したとき: ドロップ位置に工程を新規作成し、起点からの接続まで
      1 undo で行う。起点が工程ノードなら依存（前後関係）、制御ノード等なら pinned エッジ。
      作成 ID を返す（直後にその場リネームを開始する用途）。 */
  connectToNew: (sourceNodeId: FlowNodeId, x: number, y: number) => Id | undefined;
  /** 制御ノードを追加。x,y を渡せばその位置（例: 画面中央）に置く。省略時は左上に段積み。 */
  addControlNode: (control: ControlKind, x?: number, y?: number) => void;
  /** 付箋を追加。x,y を渡せばその位置に置く。省略時は既定位置に段積み。 */
  addComment: (text: string, x?: number, y?: number) => void;
  /** 付箋のテキストを変更。 */
  updateComment: (nodeId: FlowNodeId, text: string) => void;
  /** 付箋の対象ノード（細い薄線で結ぶ相手）を設定/解除。undefined で解除。
      対象は実在する工程ノードのみ（自分自身・不在ノードは no-op）。同期は触らない（付箋はユーザー所有）。 */
  setCommentTarget: (nodeId: FlowNodeId, targetNodeId: FlowNodeId | undefined) => void;
  /** 現在のフロービューを自動整列（依存で段組み・レーンで縦配置）。1 undo 単位。 */
  /** 自動整列。selectedIds を渡すと、その工程ノードだけを整列し他は固定（部分整列）。 */
  tidyFlow: (selectedIds?: FlowNodeId[]) => void;
  /** 自動整列で配置（x/y・レーン高さ）が実際に変わるか（読み取り専用）。確認ダイアログを
      出す前に「差分の出ない整列」を判定し、no-op トーストへ切り替えるために使う。 */
  wouldTidyFlow: (selectedIds?: FlowNodeId[]) => boolean;
  /** レーンの高さを変更（手動リサイズ）。下のレーンのノードを連動シフトして整合を保つ。 */
  setLaneHeight: (laneId: Id, height: number) => void;
  /** スイムレーンを 1 つ上(-1)/下(+1)へ入れ替える。中のノードも連動して移動。 */
  moveLane: (laneId: Id, dir: -1 | 1) => void;
  connect: (source: FlowNodeId, target: FlowNodeId) => void;
  /** 既存エッジの端点を別ノードへ付け替える（再接続）。導出エッジは依存の付け替え、手動エッジは端点変更。 */
  reconnectEdge: (edgeId: Id, end: 'source' | 'target', newNodeId: FlowNodeId) => void;
  /** 担当（部署/個人）の名称変更。レーン名・各工程の担当表示に反映（reconcile）。 */
  renameAssignee: (assigneeId: Id, name: string) => void;
  setEdgeLabel: (edgeId: Id, label: string) => void;
  /** 工程ノードの固定をトグル（固定すると整列で動かない）。 */
  toggleNodePin: (nodeId: FlowNodeId) => void;
  deleteFlowNode: (nodeId: FlowNodeId) => void;
  /** 複数のフロー固有ノード（制御/付箋）をまとめて削除（1 undo 単位）。工程/I/O/課題は無視。 */
  deleteFlowNodes: (nodeIds: FlowNodeId[]) => void;
  deleteEdge: (edgeId: Id) => void;
  select: (taskId?: Id) => void;
  setLevel: (level: ProcessLevel) => void;
  setScope: (scopeParentId?: Id) => void;
  toggleIssues: () => void;
  undo: () => void;
  redo: () => void;
  /** 保存済みとして記録。保存したスナップショットを渡すとその時点を基準に dirty を再計算する
   *（保存処理中に入った編集は未保存のまま）。省略時は現在の状態を保存済みとする。 */
  markSaved: (saved?: Project) => void;
  loadProject: (project: Project) => void;
  /** 外部（MCP/AI など別プロセス）でファイルが更新されたときの再読込。
   *  現在のビュー(level/scope)と選択を可能な限り保ったまま、保存済みベースとして差し替える。 */
  reloadFromExternal: (project: Project) => void;
  importCsvText: (text: string) => ImportReport;
  importRows: (rows: string[][]) => ImportReport;
  newProject: () => void;
  loadSample: () => void;
  /** テンプレート（templates.ts の key）から新規プロジェクトを開始する。 */
  loadTemplate: (key: string) => void;
  /** 自動退避データから復元（未保存＝dirty 扱い。ファイル保存を促す）。 */
  restoreProject: (project: Project) => void;

  // --- 両窓編集同期（dualwindow） ---
  /** リーダーが配ったスナップショットを従属窓へ反映する。素の set() のみで、history/savedRef/
      selectedTaskId/level/scope/showIssues には触れない（表示状態は窓ごとに独立）。 */
  applyRemoteSnapshot: (snap: RemoteSnapshot) => void;
  /** 指定 level/scope のフロービューを（無ければ作って）保証・reconcile する冪等操作（undo 対象外）。
      従属窓の粒度/スコープ切替を共有プロジェクトへ最小反映するためリーダーが実行する。 */
  ensureView: (level: ProcessLevel, scopeParentId?: Id) => void;
}

export const appStateCreator: StateCreator<AppState> = (set, get) => {
  const history = createHistory<Project>(initialProject());
  // 未保存検知: 最後に保存/開いた時点の Project 参照。現在がこれと異なれば dirty。
  let savedRef: Project | null = history.current();

  // undo/redo の「何をしたか」ラベル。history と同じ増減を平行配列でミラーする（Project の
  // コピーは持たない＝メモリ増は文字列ぶんのみ）。labels[i] = 状態 i を生んだ操作のラベル。
  const LABEL_FALLBACK = '編集';
  let labels: (string | undefined)[] = [undefined];
  let labelCursor = 0;
  // history.push の直後に呼ぶ（history.size() は上限プルーニング後の実サイズ）。
  const recordLabel = (label?: string) => {
    labels = labels.slice(0, labelCursor + 1);
    labels.push(label);
    labelCursor = labels.length - 1;
    const over = labels.length - history.size(); // history 側が古い方から捨てた分に追従
    if (over > 0) {
      labels = labels.slice(over);
      labelCursor -= over;
    }
  };
  const pushHistory = (p: Project, label?: string) => {
    history.push(p);
    recordLabel(label);
  };
  const resetLabels = () => {
    labels = [undefined];
    labelCursor = 0;
  };

  const sync = (extra: Partial<AppState> = {}) =>
    set({
      project: history.current(),
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      dirty: history.current() !== savedRef,
      ...extra,
    });

  // core/details を変えるコマンド: 現在ビューを保証 → reconcile → 履歴 push（1 undo 単位）。
  // label は undo/redo のフィードバック用（省略時は「編集」フォールバック）。
  const commit = (p: Project, label?: string) => {
    const { level, scopeParentId } = get();
    const withView = ensureLevelView(p, level, scopeParentId);
    const { project: reconciled, reports } = reconcileProjectWithReport(withView, uuid);
    pushHistory(reconciled, label);
    // 表側編集の同期で現在ビューに自動追加されたノードを記録（フロー側の一時ハイライト）。
    // 追加が無い編集では更新しない＝seq が進まず、前回のフラッシュを光らせ直さない。
    const added =
      reports.find(
        (r) => r.level === level && (r.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
      )?.report.added ?? [];
    sync(added.length ? { lastSyncAdded: { ids: added, seq: get().lastSyncAdded.seq + 1 } } : {});
  };

  // ビュー切替（undo 対象外）: 履歴の先頭を置き換える。置換前の先頭が「保存済み」スナップ
  // ショットそのものなら savedRef も新しい先頭へ付け替える（内容は等価＝保存済みのまま）。
  const replaceTop = (p: Project) => {
    if (savedRef === history.current()) savedRef = p;
    history.replaceTop(p);
  };

  // 現在ビューのオーバーレイ（制御ノード/コメント/手動エッジ等）を直接編集して履歴に積む。
  // fn が false を返したら「変更なし」として履歴に積まない（no-op で履歴を汚さない）。
  const editView = (
    fn: (view: FlowLevelView, project: Project) => void | false,
    label?: string,
  ) => {
    const { level, scopeParentId } = get();
    const p = structuredClone(get().project);
    const view = findView(p, level, scopeParentId);
    if (!view) return;
    if (fn(view, p) === false) return;
    pushHistory(p, label);
    sync();
  };

  // ファイルを開く/新規/取り込み: 既定ビューを保証して履歴をリセット（undo 不可の境界）
  const adopt = (p: Project, level: ProcessLevel, scopeParentId?: Id, dirtyAfter = false) => {
    // 直前コマンドの記録（mod+. のリピート）も破棄: 前プロジェクトの工程 id を
    // 引数に持つコマンドを新プロジェクトへ再実行させない。
    clearLastCommand();
    const reconciled = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
    history.reset(reconciled);
    resetLabels(); // 新プロジェクトの履歴＝undo/redo ラベルもリセット
    savedRef = dirtyAfter ? null : reconciled; // 開く/新規=保存済みベース、取込=未保存
    set({
      project: reconciled,
      canUndo: false,
      canRedo: false,
      dirty: dirtyAfter,
      selectedTaskId: undefined,
      level,
      scopeParentId,
      // 前プロジェクトの同期フラッシュを持ち越さない（再マウント時の誤点灯防止）
      lastSyncAdded: { ids: [], seq: 0 },
      lastAssigneeSync: { ids: [], seq: 0 },
    });
  };

  // 粒度切替時の既定スコープは常に「全体」(親をまたいで俯瞰できるのが基本姿勢)。
  // 特定の親に絞るのはスコープセレクタ/表クリックでの明示操作のみ。
  const defaultScopeFor = (_level: ProcessLevel): Id | undefined => undefined;

  // 同一親グループの兄弟を order 昇順で返す（p 省略時は現在のプロジェクト）。
  const siblingsOf = (taskId: Id, p: Project = get().project) =>
    Object.values(p.core.tasks)
      .filter((o) => (o.parentId ?? undefined) === (p.core.tasks[taskId]?.parentId ?? undefined))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  // 担当名から ID を引き、無ければ部門として新規作成する（名前は呼び出し側で trim 済み）。
  const ensureAssigneeId = (p: Project, name: string): { project: Project; assigneeId: Id } => {
    const existing = Object.values(p.core.assignees).find((a) => a.name === name);
    if (existing) return { project: p, assigneeId: existing.id };
    const next = cAddAssignee(p, { name, kind: 'department' }, uuid);
    return {
      project: next,
      assigneeId: Object.values(next.core.assignees).find((a) => a.name === name)!.id,
    };
  };

  // 同じ from→to の依存が既にあるか（重複接続を no-op にして履歴・dirty を汚さないためのガード）。
  const hasDependency = (from: Id, to: Id) =>
    Object.values(get().project.core.dependencies).some((d) => d.from === from && d.to === to);

  // 削除でスコープの親が消えていたら全体スコープへ戻す
  //（消えた親を指したまま、以後の新規工程が表に出ない孤児になるのを防ぐ）。
  const clearScopeIfRemoved = (p: Project) => {
    const scope = get().scopeParentId;
    if (scope && !p.core.tasks[scope]) set({ scopeParentId: undefined });
  };

  // 削除で現在の選択工程が消えていたら選択を解除する。commit 後に呼ぶ（現在の project を基準に
  // 判定）。選択が実在しないと App の showInspector が空の詳細ペインを開いたまま固着し、分割画面
  // からフローペインが消える（H-2）。App 側の存在チェックと二重化して確実に解消する。
  const clearSelectionIfRemoved = () => {
    const sel = get().selectedTaskId;
    if (sel && !get().project.core.tasks[sel]) set({ selectedTaskId: undefined });
  };

  // 工程削除で消えるノード（工程/入出力/課題。いずれも taskId を持つ）を指していた付箋の対象参照を
  // 外す。reconcile はコメント（付箋）を管理しないため、ノード消滅を追従して掃除しないと
  // targetNodeId がダングリングのまま永続化されてしまう（描画側はガードしているが不変条件違反）。
  // cDeleteTaskKeepChildren 直後・reconcile 前の p（flow は未変更）に対して呼ぶこと。
  const clearCommentTargetsFor = (p: Project, taskId: Id) => {
    for (const view of p.flow.byLevel) {
      const dead = new Set<FlowNodeId>();
      for (const n of Object.values(view.nodes)) {
        if ('taskId' in n && n.taskId === taskId) dead.add(n.id);
      }
      if (!dead.size) continue;
      for (const n of Object.values(view.nodes)) {
        if (n.kind === 'comment' && n.targetNodeId && dead.has(n.targetNodeId)) {
          delete n.targetNodeId;
        }
      }
    }
  };

  // reparent は実質変化があるときだけコミット（深さ超過・循環などの no-op で履歴を汚さない）。
  const commitReparent = (
    taskId: Id,
    newParentId: Id | undefined,
    index?: number,
    label?: string,
  ) => {
    const cur = get().project;
    const applied = cReparentTask(cur, taskId, newParentId, index);
    const a = cur.core.tasks[taskId];
    const b = applied.core.tasks[taskId];
    if (a && b && (a.parentId !== b.parentId || a.level !== b.level || a.order !== b.order)) {
      commit(applied, label);
    }
  };

  return {
    project: history.current(),
    canUndo: false,
    canRedo: false,
    dirty: false,
    selectedTaskId: undefined,
    level: 'medium',
    scopeParentId: undefined,
    showIssues: true,
    lastSyncAdded: { ids: [], seq: 0 },
    lastAssigneeSync: { ids: [], seq: 0 },
    focusHint: null,

    addTask: (name) =>
      commit(
        cAddTask(
          get().project,
          { name: name || '新規作業', level: get().level, parentId: get().scopeParentId },
          uuid,
        ),
        '工程を追加',
      ),

    addRootTask: (level) => {
      // 空名で作り、UI 側が追加直後に選択＋名前を即編集する（キーボード n=addSiblingOf と挙動統一）。
      const wasEmpty = Object.keys(get().project.core.tasks).length === 0;
      const id = uuid();
      commit(cAddTask(get().project, { name: '', level, parentId: undefined, id }, uuid), '工程を追加');
      // 初回導線: 空プロジェクトで最初の工程を作った瞬間、その粒度をフロー表示粒度へ追従させる。
      // 既定は medium なので「＋大工程」で始めても大ノードがフローに出ない問題を防ぐ。
      // 既存プロジェクト（工程あり）では追従しない＝手動配置・現在の粒度を勝手に切り替えて驚かせない。
      if (wasEmpty && level !== get().level) get().setLevel(level);
      return id;
    },

    addChildTask: (parentId) => {
      const parent = get().project.core.tasks[parentId];
      if (!parent) return undefined;
      const childLevel = LEVELS[RANK[parent.level] + 1] ?? 'detail';
      const id = uuid();
      commit(cAddTask(get().project, { name: '新規工程', level: childLevel, parentId, id }, uuid), '工程を追加');
      return id;
    },

    // マイルストーン追加: 現在ビューの level/scope に作成（表/フロー/パレットのどこから
    // 呼んでも同じ位置規則）。reconcile 後に位置を上書きするのは addTaskAt と同じ
    // 「作成と配置を 1 スナップショットに集約」パターン。
    addMilestone: (x, y) => {
      const { level, scopeParentId } = get();
      const newId = uuid();
      let p = cAddTask(
        get().project,
        { name: '新規マイルストーン', level, parentId: scopeParentId, id: newId, kind: 'milestone' },
        uuid,
      );
      p = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
      const view = findView(p, level, scopeParentId);
      const node = view
        ? Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === newId)
        : undefined;
      if (node) {
        // 既存の（自分以外の）マイルストーン数。中央スポーン/既定位置いずれも、この本数ぶん
        // 右へずらして連続追加が既存 MS の真上に重ならないようにする（未紐付け時は node.x が
        // そのまま菱形の位置になる。milestoneGuides.ts 参照）。
        const k = Object.values(view!.nodes).filter(
          (n) => n.kind === 'task' && n.id !== node.id && isMilestone(p.core, n.taskId),
        ).length;
        if (x != null) {
          node.x = Math.round(x) + k * 40;
          node.y = Math.round(y ?? node.y);
        } else {
          node.x = 80 + k * 40;
        }
      }
      pushHistory(p, 'マイルストーンを追加');
      sync({ selectedTaskId: newId });
      // 作成直後にインスペクタを開く: マイルストーンは対象工程（前工程）を紐付けて初めて意味を持つ。
      // すぐ設定できるよう詳細パネルを開く（#10。表/フロー/パレットのどこから作っても同じ導線）。
      useUI.getState().setInspectorOpen(true);
      return newId;
    },

    // 削除は配下を残す（子は祖父へ昇格し、依存は維持）。
    removeTask: (taskId) => {
      const name = get().project.core.tasks[taskId]?.name?.trim() || '工程';
      const p = cDeleteTaskKeepChildren(get().project, taskId);
      clearCommentTargetsFor(p, taskId);
      clearScopeIfRemoved(p);
      commit(p, `工程『${name}』を削除`);
      clearSelectionIfRemoved();
    },

    setTaskLevel: (taskId, level) => commit(cSetTaskLevel(get().project, taskId, level), '粒度を変更'),
    setTaskCode: (taskId, code) => commit(cSetTaskCode(get().project, taskId, code), '工程Noを変更'),

    renameTask: (taskId, name) => commit(cRenameTask(get().project, taskId, name), '作業名を変更'),

    setAssigneeByName: (taskId, name) => {
      const trimmed = name.trim();
      if (!trimmed) {
        commit(cSetAssignee(get().project, taskId, undefined), '担当を変更');
        return;
      }
      const { project: p, assigneeId } = ensureAssigneeId(get().project, trimmed);
      commit(cSetAssignee(p, taskId, assigneeId), '担当を変更');
    },

    setAssigneeManyByName: (taskIds, name) => {
      let p = get().project;
      const trimmed = name.trim();
      let assigneeId: Id | undefined;
      if (trimmed) {
        ({ project: p, assigneeId } = ensureAssigneeId(p, trimmed));
      }
      let count = 0;
      for (const id of taskIds) {
        if (p.core.tasks[id]) {
          p = cSetAssignee(p, id, assigneeId);
          count += 1;
        }
      }
      // 一括操作は undo ラベルに件数を入れる（「3件の担当を変更」＝何をまとめて戻すか分かる）。
      if (count) commit(p, count > 1 ? `${count}件の担当を変更` : '担当を変更');
    },

    removeManyTasks: (taskIds, flowNodeIds) => {
      let p = get().project;
      let count = 0;
      for (const id of taskIds) {
        if (p.core.tasks[id]) {
          p = cDeleteTaskKeepChildren(p, id);
          clearCommentTargetsFor(p, id);
          count += 1;
        }
      }
      // 図形（制御/付箋）を混在削除する場合は工程削除と同じスナップショットへ畳み込む。
      // p は履歴上の他スナップと構造を共有しうるため、ビュー破壊前に必ずクローンする。
      let flowRemoved = 0;
      if (flowNodeIds && flowNodeIds.length) {
        p = structuredClone(p);
        const view = findView(p, get().level, get().scopeParentId);
        if (view) {
          const targets = new Set<FlowNodeId>();
          for (const id of flowNodeIds) {
            const n = view.nodes[id];
            if (!n || (n.kind !== 'control' && n.kind !== 'comment')) continue;
            delete view.nodes[id];
            targets.add(id);
            flowRemoved += 1;
          }
          if (targets.size) {
            for (const e of Object.values(view.edges)) {
              if (targets.has(e.source) || targets.has(e.target)) delete view.edges[e.id];
            }
          }
        }
      }
      if (count || flowRemoved) {
        clearScopeIfRemoved(p);
        // ラベルは「戻す対象」を表す undo フィードバック用。工程が主体なら件数を、
        // 図形のみが残ったケースは figure ラベルにフォールバックする。
        const label = count ? (count > 1 ? `${count}件を削除` : '工程を削除') : 'ノードを削除';
        commit(p, label);
        clearSelectionIfRemoved();
      }
    },

    addDependency: (from, to) => {
      if (!from || !to || from === to) return;
      // 消えた工程を指す依存は作らない（リピート mod+. 等で stale な id が来る。
      // addTaskWithOptions が predecessorId に行っているのと同じ規約）。
      const tasks = get().project.core.tasks;
      if (!tasks[from] || !tasks[to]) return;
      if (hasDependency(from, to)) return; // 既存の依存への再接続は no-op
      commit(cAddDependency(get().project, from, to, uuid), '前工程を追加');
    },

    removeDependency: (depId) => commit(cRemoveDependency(get().project, depId), '前工程を削除'),
    setDependencyPhase: (depId, phase) =>
      commit(cSetDependencyPhase(get().project, depId, phase), '前後関係を変更'),
    setToBePredecessor: (taskId, fromId) => {
      let p = get().project;
      // 既存の To-Be 専用 incoming を外す（前工程は 1 本に保つ）。
      for (const d of Object.values(p.core.dependencies)) {
        if (d.to === taskId && d.phase === 'tobe') p = cRemoveDependency(p, d.id);
      }
      if (fromId && fromId !== taskId) {
        const id = uuid();
        p = cAddDependency(p, fromId, taskId, () => id);
        p = cSetDependencyPhase(p, id, 'tobe');
      }
      commit(p, '前工程を変更');
    },
    addToBePredecessor: (taskId, fromId) => {
      if (fromId === taskId) return;
      let p = get().project;
      const existing = Object.values(p.core.dependencies).find((d) => d.from === fromId && d.to === taskId);
      if (existing) {
        if (existing.phase === 'asis') p = cSetDependencyPhase(p, existing.id, undefined); // As-Is専用→両方(To-Beにも出す)
        else return; // 既に To-Be に存在（両方/tobe）
      } else {
        const id = uuid();
        p = cAddDependency(p, fromId, taskId, () => id);
        p = cSetDependencyPhase(p, id, 'tobe');
      }
      commit(p, '前工程を追加');
    },
    removeToBePredecessor: (taskId, fromId) => {
      let p = get().project;
      const dep = Object.values(p.core.dependencies).find((d) => d.from === fromId && d.to === taskId);
      if (!dep) return;
      if (dep.phase === 'tobe') p = cRemoveDependency(p, dep.id); // To-Be専用→削除
      else if (dep.phase === undefined) p = cSetDependencyPhase(p, dep.id, 'asis'); // 両方→As-Is専用(To-Beから外す)
      else return; // As-Is専用→To-Beには無い
      commit(p, '前工程を削除');
    },

    // 「次行を追加」: 同じ親・同じ粒度の兄弟を「クリック行の直下」に挿入し、新タスクの id を返す（フォーカス用）。
    addSiblingOf: (taskId) => {
      const cur = get().project;
      const t = cur.core.tasks[taskId];
      if (!t) return undefined;
      const newId = uuid();
      let p = cAddTask(cur, { name: '', level: t.level, parentId: t.parentId, id: newId }, uuid);
      const sibs = siblingsOf(taskId, p);
      const idx = sibs.findIndex((o) => o.id === taskId);
      if (idx >= 0) p = cReorderTask(p, newId, idx + 1); // クリック行の直下へ
      commit(p, '工程を追加');
      return newId;
    },

    // クイック追加: 作成 → 表の位置 → 担当 → 工数 → 前工程の依存、を 1 スナップショットに
    // 集約（addTaskAt / duplicateTask と同じコマンド合成パターン＝1 undo でまとめて戻る）。
    // 名前は無題（''）を許す＝引数を空で確定したときの従来挙動「無題で 1 件追加」。
    addTaskWithOptions: (opts) => {
      const cur = get().project;
      const sel = get().selectedTaskId ? cur.core.tasks[get().selectedTaskId!] : undefined;
      const level = opts.level ?? sel?.level ?? get().level;
      const parentId = resolveQuickAddParent(cur.core.tasks, sel, level, get().scopeParentId);
      const newId = uuid();
      let p = cAddTask(cur, { name: opts.name, level, parentId, id: newId }, uuid);
      // 「選択行の直下へ」は同じ親グループに作れた（＝粒度が一致した）ときだけ。
      // #粒度 で別グループに作るときは末尾のまま（resolveQuickAddParent の規約）。
      if (sel && level === sel.level) {
        const sibs = siblingsOf(sel.id, p);
        const idx = sibs.findIndex((o) => o.id === sel.id);
        if (idx >= 0) p = cReorderTask(p, newId, idx + 1); // 選択行の直下へ（addSiblingOf と同じ規則）
      }
      const assigneeName = opts.assigneeName?.trim();
      if (assigneeName) {
        const r = ensureAssigneeId(p, assigneeName);
        p = cSetAssignee(r.project, newId, r.assigneeId);
      }
      if (opts.effortMinutes != null && Number.isFinite(opts.effortMinutes) && opts.effortMinutes >= 0) {
        p = cUpdateTaskDetail(p, newId, { effortMinutes: Math.round(opts.effortMinutes) });
      }
      // 前工程はパーサで解決済みの id を信頼するが、消えた工程を指す依存は作らない。
      if (opts.predecessorId && p.core.tasks[opts.predecessorId]) {
        p = cAddDependency(p, opts.predecessorId, newId, uuid);
      }
      commit(p, '工程を追加');
      set({ selectedTaskId: newId });
      return newId;
    },

    // 工程を複製: 同じ粒度・親の「直後」に同名の工程を作り、詳細（I/O・課題は新ID）も写す。
    // 依存（前後関係）は引き継がない（複製で順序を二重に張らない）。1 undo。
    duplicateTask: (taskId) => {
      const cur = get().project;
      const t = cur.core.tasks[taskId];
      if (!t) return undefined;
      const newId = uuid();
      let p = cAddTask(
        cur,
        // kind も複製する（省略すると MS の複製が普通の工程になってしまう）。
        { name: t.name, level: t.level, parentId: t.parentId, assigneeId: t.assigneeId, id: newId, kind: t.kind },
        uuid,
      );
      const sibs = siblingsOf(taskId, p);
      const idx = sibs.findIndex((o) => o.id === taskId);
      if (idx >= 0) p = cReorderTask(p, newId, idx + 1);
      const d = cur.details[taskId];
      if (d) {
        // スカラ項目は TaskDetailPatch が許す全フィールドを写す（status・色も含めた完全な複製）。
        p = cUpdateTaskDetail(p, newId, {
          how: d.how,
          system: d.system,
          note: d.note,
          volume: d.volume,
          exception: d.exception,
          dataLink: d.dataLink,
          regulation: d.regulation,
          automation: d.automation,
          difficulty: d.difficulty,
          effortMinutes: d.effortMinutes,
          status: d.status,
          fillColor: d.fillColor,
          textColor: d.textColor,
        });
        for (const it of d.inputs ?? [])
          p = cAddIoItem(p, newId, 'inputs', { name: it.name, kind: it.kind, formInfo: it.formInfo, source: it.source }, uuid);
        for (const it of d.outputs ?? [])
          p = cAddIoItem(p, newId, 'outputs', { name: it.name, kind: it.kind, formInfo: it.formInfo }, uuid);
        for (const iss of d.issues ?? [])
          p = cAddIssueItem(p, newId, { issue: iss.issue, measure: iss.measure }, uuid);
      }
      commit(p, '工程を複製');
      set({ selectedTaskId: newId });
      return newId;
    },

    // クリップボード（Excel/表計算）からの貼り付け: 1 行 = 1 工程として一括追加。
    // 列は [作業名, 担当?]。粒度・親は選択中の工程（無ければ現在のビュー）に合わせ末尾へ追加。
    pasteRowsAsTasks: (rows) => {
      const cur = get().project;
      const sel = get().selectedTaskId ? cur.core.tasks[get().selectedTaskId!] : undefined;
      const level = sel?.level ?? get().level;
      const parentId = sel ? sel.parentId : get().scopeParentId;
      const items = rows
        .map((r) => ({ name: (r[0] ?? '').trim(), assignee: (r[1] ?? '').trim() }))
        .filter((r) => r.name);
      if (!items.length) return 0;
      let p = cur;
      let count = 0;
      for (const it of items) {
        const nid = uuid();
        p = cAddTask(p, { name: it.name, level, parentId, id: nid }, uuid);
        count += 1;
        if (it.assignee) {
          const r = ensureAssigneeId(p, it.assignee);
          p = cSetAssignee(r.project, nid, r.assigneeId);
        }
      }
      if (count) commit(p, count > 1 ? `${count}件を貼り付け` : '工程を貼り付け');
      return count;
    },

    moveTaskUp: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx > 0) commit(cReorderTask(get().project, taskId, idx - 1), '順序を変更');
    },
    moveTaskDown: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx >= 0 && idx < sibs.length - 1)
        commit(cReorderTask(get().project, taskId, idx + 1), '順序を変更');
    },
    indentTask: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx > 0) commitReparent(taskId, sibs[idx - 1]!.id, undefined, '階層を変更'); // 直前の兄弟の子へ
    },
    outdentTask: (taskId) => {
      const t = get().project.core.tasks[taskId];
      if (!t || t.parentId === undefined) return; // 既に root
      const parent = get().project.core.tasks[t.parentId];
      if (!parent) return;
      const gpSibs = siblingsOf(parent.id);
      const parentIdx = gpSibs.findIndex((o) => o.id === parent.id);
      commitReparent(taskId, parent.parentId, parentIdx + 1, '階層を変更'); // 親の直後（祖父母の子）へ
    },
    dropTask: (dragId, targetId, mode) => {
      if (dragId === targetId) return;
      const drag = get().project.core.tasks[dragId];
      const target = get().project.core.tasks[targetId];
      if (!drag || !target) return;
      if (mode === 'child') {
        commitReparent(dragId, targetId, undefined, '移動');
        return;
      }
      const targetParent = target.parentId;
      const sibs = siblingsOf(targetId);
      const ti = sibs.findIndex((o) => o.id === targetId);
      if ((drag.parentId ?? undefined) === (targetParent ?? undefined)) {
        const di = sibs.findIndex((o) => o.id === dragId); // 同一グループ → 並べ替え
        const tiPost = di < ti ? ti - 1 : ti;
        commit(cReorderTask(get().project, dragId, mode === 'after' ? tiPost + 1 : tiPost), '順序を変更');
      } else {
        commitReparent(dragId, targetParent, mode === 'after' ? ti + 1 : ti, '移動'); // 別グループ → 移動
      }
    },

    addIo: (taskId, io, name) => {
      const lv = get().project.core.tasks[taskId]?.level;
      const kind: IoKind = lv === 'small' || lv === 'detail' ? 'info' : 'doc';
      commit(cAddIoItem(get().project, taskId, io, { name: name || '帳票', kind }, uuid), '入出力を追加');
    },
    updateIo: (taskId, ioId, patch) =>
      commit(cUpdateIoItem(get().project, taskId, ioId, patch), '入出力を変更'),
    removeIo: (taskId, ioId) => commit(cRemoveIoItem(get().project, taskId, ioId), '入出力を削除'),

    addIssue: (taskId, text) =>
      commit(cAddIssueItem(get().project, taskId, { issue: text || '課題' }, uuid), '課題を追加'),
    addIssueWithMeasure: (taskId, measure) =>
      commit(cAddIssueItem(get().project, taskId, { issue: '', measure }, uuid), '課題を追加'),
    updateIssue: (taskId, issueId, patch) =>
      commit(cUpdateIssueItem(get().project, taskId, issueId, patch), '課題を変更'),
    removeIssue: (taskId, issueId) =>
      commit(cRemoveIssueItem(get().project, taskId, issueId), '課題を削除'),
    updateDetail: (taskId, patch) => commit(cUpdateTaskDetail(get().project, taskId, patch), '詳細を編集'),
    updateToBe: (taskId, patch) => commit(cUpdateTaskToBe(get().project, taskId, patch), 'To-Beを編集'),
    copyAsIsToToBe: (taskId) => commit(cCopyAsIsToToBe(get().project, taskId), 'To-Beに複製'),
    copyAsIsToToBeMany: (taskIds) => {
      // 既存 copyAsIsToToBe の core 関数をループ適用し、1 スナップショット＝1 undo にまとめる
      // （旧: 呼び出し側で forEach → N 回 commit で undo が N 回必要だった）。
      let p = get().project;
      let count = 0;
      for (const id of taskIds) {
        if (p.core.tasks[id] && p.details[id]) {
          p = cCopyAsIsToToBe(p, id);
          count += 1;
        }
      }
      if (count) commit(p, count > 1 ? `${count}件をTo-Beに複製` : 'To-Beに複製');
      return count;
    },
    addToBeTask: () => {
      const cur = get().project;
      const firstLarge = Object.values(cur.core.tasks).find((t) => t.level === 'large');
      const parentId = firstLarge?.id;
      const level: ProcessLevel = parentId ? 'medium' : 'large';
      const assigneeId = Object.values(cur.core.assignees)[0]?.id;
      const id = uuid();
      let p = cAddTask(cur, { name: '新規工程', level, parentId, assigneeId, id }, uuid);
      p = cUpdateTaskToBe(p, id, { lifecycle: 'added' });
      commit(p, '工程を追加');
      return id;
    },

    // --- 手順書（manual）。core は履歴を持たないので commit 経由で 1 undo 単位。
    // updatedAt 用の now は各コマンドへ注入（純粋性・決定論を core 側で保つ）。 ---
    upsertProcedurePurpose: (taskId, purpose) =>
      commit(cUpsertProcedure(get().project, taskId, { purpose }, new Date().toISOString()), '目的を編集'),
    addStep: (taskId, args) => {
      const id = uuid();
      commit(cAddStep(get().project, taskId, { ...args, id }, uuid, new Date().toISOString()), '手順を追加');
      return id;
    },
    updateStep: (taskId, stepId, patch) =>
      commit(cUpdateStep(get().project, taskId, stepId, patch, new Date().toISOString()), '手順を編集'),
    removeStep: (taskId, stepId) =>
      commit(cRemoveStep(get().project, taskId, stepId, new Date().toISOString()), '手順を削除'),
    moveStep: (taskId, stepId, toIndex) =>
      commit(cMoveStep(get().project, taskId, stepId, toIndex, new Date().toISOString()), '手順を並べ替え'),
    addStepCond: (taskId, stepId, args) => {
      const id = uuid();
      commit(cAddStepCond(get().project, taskId, stepId, { ...args, id }, uuid, new Date().toISOString()), '条件を追加');
      return id;
    },
    updateStepCond: (taskId, stepId, condId, patch) =>
      commit(cUpdateStepCond(get().project, taskId, stepId, condId, patch, new Date().toISOString()), '条件を編集'),
    removeStepCond: (taskId, stepId, condId) =>
      commit(cRemoveStepCond(get().project, taskId, stepId, condId, new Date().toISOString()), '条件を削除'),
    addStepRef: (taskId, stepId, ref) =>
      commit(cAddStepRef(get().project, taskId, stepId, ref, new Date().toISOString()), '参照を追加'),
    removeStepRef: (taskId, stepId, index) =>
      commit(cRemoveStepRef(get().project, taskId, stepId, index, new Date().toISOString()), '参照を削除'),

    // 画像追加: 内容ハッシュで命名 → メモリ層へ格納 → 二窓へ bytes 配布 → Project には file 名だけ commit。
    // bytes は undo/autosave/snapshot に載せない（肥大・重複配布を避ける）。フォロワーで貼った場合は
    // このアクション自体が引数(bytes 含む)ごとリーダーへ forward され、リーダーがここを実行する。
    addStepImage: (taskId, stepId, bytes, mime, caption) => {
      const file = contentHashName(bytes, mime);
      putAsset(file, bytes);
      broadcastAsset(file, bytes);
      commit(
        cAddStepImage(
          get().project,
          taskId,
          stepId,
          { file, ...(caption ? { caption } : {}) },
          uuid,
          new Date().toISOString(),
        ),
        '画像を追加',
      );
    },
    updateStepImage: (taskId, stepId, imageId, patch) =>
      commit(cUpdateStepImage(get().project, taskId, stepId, imageId, patch, new Date().toISOString()), '画像を編集'),
    removeStepImage: (taskId, stepId, imageId) =>
      commit(cRemoveStepImage(get().project, taskId, stepId, imageId, new Date().toISOString()), '画像を削除'),

    upsertAsset: (args) => {
      const id = args.id ?? uuid();
      commit(cUpsertAsset(get().project, { ...args, id }, uuid), args.id ? '資料を編集' : '資料を追加');
      return id;
    },
    updateAsset: (assetId, patch) => commit(cUpdateAsset(get().project, assetId, patch), '資料を編集'),
    removeAsset: (assetId) => commit(cRemoveAsset(get().project, assetId), '資料を削除'),

    // フロー上のドラッグ確定。別レーンに落ちたら担当を書き戻す（唯一の逆方向同期）。
    // x/y は 0 未満へクランプする（負座標へ落ちると全体表示のスクロールは 0 未満にできず、
    // 二度と画面内へ戻せなくなるため。ドラッグ中のプレビュー/スナップガイドはそのまま＝
    // 確定時にのみ境界で止める）。
    moveNode: (nodeId, x, y) => {
      const { level, scopeParentId } = get();
      const p = structuredClone(get().project);
      const view = findView(p, level, scopeParentId);
      const node = view?.nodes[nodeId];
      if (!view || !node) return;
      const cx = Math.max(0, x);
      const cy = Math.max(0, y);
      node.x = cx;
      node.y = cy;

      if (node.kind === 'task') {
        const laneOrder = nearestLaneOrder(view.lanes, cy);
        const lane = Object.values(view.lanes).find((l) => l.order === laneOrder);
        const task = p.core.tasks[node.taskId];
        if (lane?.assigneeId && task && task.assigneeId !== lane.assigneeId) {
          task.assigneeId = lane.assigneeId; // 逆同期: レーン → 担当
          pushHistory(reconcileProject(p, uuid), 'レーン移動で担当を変更');
          // 書き戻った工程を記録（表側の担当セルの一時ハイライト）。
          sync({ lastAssigneeSync: { ids: [node.taskId], seq: get().lastAssigneeSync.seq + 1 } });
          return p.core.assignees[lane.assigneeId]?.name; // 新しい担当名を返す（UI 通知用）
        }
      }
      pushHistory(p, 'ノードを移動');
      sync();
      return undefined;
    },

    // 複数ノードをまとめて平行移動（範囲選択した要素を一括ドラッグ）。
    // レーン再割当（逆同期）はしない＝選択をそのままずらす素直な挙動。1 undo 単位。
    // 剛体移動として 0 未満へは行かせない: 個別クランプだと選択の一部だけ壁で止まり
    // 相対配置が歪むため、選択全体の最小 x/y が 0 を下回らないよう移動量そのものを
    // 削って揃える（全体表示の負座標救出＝fitView からも同じ関数を使う）。
    moveNodesBy: (nodeIds, dx, dy) => {
      if ((dx === 0 && dy === 0) || nodeIds.length === 0) return;
      editView((view) => {
        let minX = Infinity;
        let minY = Infinity;
        for (const id of nodeIds) {
          const n = view.nodes[id];
          if (n) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
          }
        }
        if (!Number.isFinite(minX)) return false; // 対象ノードが1つも無い
        const cdx = minX + dx < 0 ? -minX : dx;
        const cdy = minY + dy < 0 ? -minY : dy;
        if (cdx === 0 && cdy === 0) return false;
        let changed = false;
        for (const id of nodeIds) {
          const n = view.nodes[id];
          if (n) {
            n.x = Math.max(0, Math.round(n.x + cdx));
            n.y = Math.max(0, Math.round(n.y + cdy));
            changed = true;
          }
        }
        if (!changed) return false;
      }, 'ノードを移動');
    },

    // フロー上で工程を新規作成 → ドロップ位置のレーン(担当)へ。1 操作 = 1 undo（作成と配置を 1 スナップショットに集約）。
    addTaskAt: (x, y) => {
      const { level, scopeParentId } = get();
      const view0 = findView(get().project, level, scopeParentId);
      const laneOrder = view0 ? nearestLaneOrder(view0.lanes, y) : 0;
      const lane = view0
        ? Object.values(view0.lanes).find((l) => l.order === laneOrder)
        : undefined;
      // フロー上で作る工程は既定名を与える（空の白箱にしない。リネームは表/インスペクタで）。
      const newId = uuid();
      let p = cAddTask(
        get().project,
        { name: '新規工程', level, parentId: scopeParentId, assigneeId: lane?.assigneeId, id: newId },
        uuid,
      );
      p = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
      const view = findView(p, level, scopeParentId);
      const node = view
        ? Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === newId)
        : undefined;
      if (node) {
        node.x = Math.round(x);
        node.y = Math.round(y);
      }
      pushHistory(p, '工程を追加');
      sync({ selectedTaskId: newId });
      return newId;
    },

    // 接続ドラッグを空白で離したとき: ドロップ位置に工程を作成し、起点から接続する。
    // 工程ノード起点なら依存（前後関係＝同粒度。reconcile で導出エッジが張られる）、制御ノード
    // 等の起点なら pinned エッジ。作成・接続・配置を 1 スナップショットに集約（addTaskAt と同じ
    // 「1 操作 = 1 undo」パターン）。
    connectToNew: (sourceNodeId, x, y) => {
      const { level, scopeParentId } = get();
      const cur = get().project;
      const view0 = findView(cur, level, scopeParentId);
      const sNode = view0?.nodes[sourceNodeId];
      if (!sNode) return undefined;
      const laneOrder = view0 ? nearestLaneOrder(view0.lanes, y) : 0;
      const lane = view0
        ? Object.values(view0.lanes).find((l) => l.order === laneOrder)
        : undefined;
      // 起点が工程ノードなら同粒度の依存にできる。それ以外（制御ノード等）は pinned エッジ。
      const isTaskSource = sNode.kind === 'task' && !!cur.core.tasks[sNode.taskId];
      const newId = uuid();
      let p = cAddTask(
        cur,
        { name: '新規工程', level, parentId: scopeParentId, assigneeId: lane?.assigneeId, id: newId },
        uuid,
      );
      // 依存は reconcile の前に張り、導出エッジを新 id で生成させる（addTaskNextTo と同手順）。
      if (isTaskSource) p = cAddDependency(p, sNode.taskId, newId, uuid);
      p = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
      const view = findView(p, level, scopeParentId);
      const node = view
        ? Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === newId)
        : undefined;
      if (node) {
        node.x = Math.round(x);
        node.y = Math.round(y);
      }
      // 制御ノード等の起点は依存にならないので pinned エッジを直書き（connect と同じ規約）。
      if (!isTaskSource && view && node) {
        const eid = uuid();
        view.edges[eid] = { id: eid, source: sourceNodeId, target: node.id, pinned: true, role: 'flow' };
      }
      pushHistory(p, '工程を追加');
      sync({ selectedTaskId: newId });
      return newId;
    },

    // 並行工程を追加。コマンド適用 → reconcile でノード生成 → 基準ノードの直下へ上書き →
    // 1 push（addTaskAt と同じ「作成と配置を 1 スナップショットに集約」パターン。commit() だと
    // push 後に位置を上書きできない）。
    addParallel: (taskId) => {
      const { level, scopeParentId } = get();
      if (!get().project.core.tasks[taskId]) return undefined;
      const newId = uuid();
      let p = cAddParallelTask(get().project, taskId, uuid, newId);
      p = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
      const view = findView(p, level, scopeParentId);
      const nodes = view ? Object.values(view.nodes) : [];
      const refNode = nodes.find((n) => n.kind === 'task' && n.taskId === taskId);
      const newNode = nodes.find((n) => n.kind === 'task' && n.taskId === newId);
      if (view && refNode && newNode) {
        const pos = parallelSlotBelow(view, refNode, newNode.id);
        newNode.x = pos.x;
        newNode.y = pos.y;
      }
      pushHistory(p, '並行工程を追加');
      sync({ selectedTaskId: newId });
      return newId;
    },

    // フローの「次工程を追加」(n): 作成（粒度・親・担当は基準と同じ＝reconcile で同レーンに乗る）
    // → 表では基準の直下へ → 依存接続 → 右隣へ配置、を 1 スナップショットに集約（addTaskAt と
    // 同じコマンド合成パターン＝1 undo で工程・依存・配置がまとめて戻る）。
    addTaskNextTo: (baseTaskId, opts) => {
      const { level, scopeParentId } = get();
      const cur = get().project;
      const base = cur.core.tasks[baseTaskId];
      const view0 = findView(cur, level, scopeParentId);
      const baseNode = view0
        ? Object.values(view0.nodes).find((n) => n.kind === 'task' && n.taskId === baseTaskId)
        : undefined;
      if (!base || !baseNode) return undefined;
      const newId = uuid();
      let p = cAddTask(
        cur,
        { name: '新規工程', level: base.level, parentId: base.parentId, assigneeId: base.assigneeId, id: newId },
        uuid,
      );
      const sibs = siblingsOf(baseTaskId, p);
      const idx = sibs.findIndex((o) => o.id === baseTaskId);
      if (idx >= 0) p = cReorderTask(p, newId, idx + 1); // 表では基準の直下へ（addSiblingOf と同じ規則）
      if (opts?.connect !== false) p = cAddDependency(p, baseTaskId, newId, uuid);
      p = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
      const view = findView(p, level, scopeParentId);
      const node = view
        ? Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === newId)
        : undefined;
      if (view && node) {
        const pos = nextTaskPos(view, baseNode, node.id);
        node.x = pos.x;
        node.y = pos.y;
      }
      pushHistory(p, '工程を追加');
      sync({ selectedTaskId: newId });
      return newId;
    },

    // 既存工程を基準工程と並行化（依存付け替え＋旧チェーン修復）し、基準ノードの直下へ寄せる。
    makeParallelTo: (taskId, baseTaskId) => {
      const { level, scopeParentId } = get();
      const t = get().project.core.tasks[taskId];
      const base = get().project.core.tasks[baseTaskId];
      if (!t || !base || taskId === baseTaskId || t.level !== base.level) return;
      let p = cMakeParallel(get().project, taskId, baseTaskId, uuid);
      p = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
      const view = findView(p, level, scopeParentId);
      const nodes = view ? Object.values(view.nodes) : [];
      const baseNode = nodes.find((n) => n.kind === 'task' && n.taskId === baseTaskId);
      const node = nodes.find((n) => n.kind === 'task' && n.taskId === taskId);
      if (view && baseNode && node) {
        const pos = parallelSlotBelow(view, baseNode, node.id);
        node.x = pos.x;
        node.y = pos.y;
      }
      pushHistory(p, '並行化');
      sync();
    },

    // 矢印の途中に工程を挿入: 作成 → 元エッジの分割 → 配置を 1 スナップショットに集約（1 undo）。
    // 半分（A→新規 / 新規→B）ごとの張り方は connect の規約に合わせる: 同粒度の工程どうし＝依存
    // （表へ反映）/ 制御ノード絡み・粒度違い＝pinned エッジ。導出エッジの依存を分割した場合、
    // reconcile が新 id でエッジを導出し直すため、元のラベルは明示的にコピーして引き継ぐ。
    insertTaskOnEdge: (edgeId) => {
      const { level, scopeParentId } = get();
      const cur = get().project;
      const view0 = findView(cur, level, scopeParentId);
      const edge = view0?.edges[edgeId];
      if (!view0 || !edge || edge.role === 'ioLink') return undefined;
      // 大またぎブリッジは挿入不可（FlowCanvas はボタン自体を出さないが、防御として二重化）。
      if (isBridgeEdge(cur, view0, edge)) return undefined;
      const sNode = view0.nodes[edge.source];
      const tNode = view0.nodes[edge.target];
      if (!sNode || !tNode) return undefined;

      // 挿入位置 = 描画と同じ経路（routeEdge）のラベル位置＝目で追っていた矢印の真ん中に出す。
      const obstacles = Object.values(view0.nodes)
        .filter(
          (n) =>
            (n.kind === 'task' || n.kind === 'control' || n.kind === 'comment') &&
            n.id !== edge.source &&
            n.id !== edge.target,
        )
        .map((n) => nodeRect(n));
      const at = routeEdge(nodeRect(sNode), nodeRect(tNode), obstacles).label;

      const sTaskId = sNode.kind === 'task' ? sNode.taskId : undefined;
      const tTaskId = tNode.kind === 'task' ? tNode.taskId : undefined;
      const sTask = sTaskId ? cur.core.tasks[sTaskId] : undefined;
      const tTask = tTaskId ? cur.core.tasks[tTaskId] : undefined;
      // 粒度・親・担当は両端が揃っていれば引き継ぐ。揃わなければ現在ビュー／挿入位置のレーンに従う。
      const newLevel = sTask && tTask && sTask.level === tTask.level ? sTask.level : level;
      const sameParent =
        sTask && tTask && (sTask.parentId ?? undefined) === (tTask.parentId ?? undefined);
      const parentId = sameParent ? sTask.parentId : scopeParentId;
      const lane = Object.values(view0.lanes).find(
        (l) => l.order === nearestLaneOrder(view0.lanes, at.y),
      );
      const assigneeId =
        sTask && tTask && sTask.assigneeId === tTask.assigneeId ? sTask.assigneeId : lane?.assigneeId;

      const newId = uuid();
      let p = cAddTask(
        cur,
        { name: '新規工程', level: newLevel, parentId, assigneeId, id: newId },
        uuid,
      );
      // 表では先行（A）の直下へ（A と同じ親グループに作れたときだけ。addTaskNextTo と同じ規則）。
      if (sTask && (sTask.parentId ?? undefined) === (parentId ?? undefined) && sTask.level === newLevel) {
        const sibs = siblingsOf(sTask.id, p);
        const idx = sibs.findIndex((o) => o.id === sTask.id);
        if (idx >= 0) p = cReorderTask(p, newId, idx + 1);
      }

      const firstIsDep = sTask !== undefined && sTask.level === newLevel;
      const secondIsDep = tTask !== undefined && tTask.level === newLevel;
      if (edge.derivedFromDependencyId) p = cRemoveDependency(p, edge.derivedFromDependencyId);
      if (firstIsDep && sTaskId) p = cAddDependency(p, sTaskId, newId, uuid);
      if (secondIsDep && tTaskId) p = cAddDependency(p, newId, tTaskId, uuid);
      // pinned の元エッジは図から取り除く（reconcile は pinned を保持するため明示削除が必要）。
      if (!edge.derivedFromDependencyId) {
        const v = findView(p, level, scopeParentId);
        if (v) delete v.edges[edgeId];
      }
      p = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
      const view = findView(p, level, scopeParentId);
      const node = view
        ? Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === newId)
        : undefined;
      if (view && node) {
        node.x = Math.round(at.x - SIZE.task.w / 2);
        node.y = Math.round(at.y - SIZE.task.h / 2);
        // 依存にできない半分は pinned エッジで張り直す（ラベルは先行側＝A→新規へ引き継ぐ）。
        if (!firstIsDep) {
          const id = uuid();
          view.edges[id] = {
            id,
            source: sNode.id,
            target: node.id,
            pinned: true,
            role: 'flow',
            ...(edge.label ? { label: edge.label } : {}),
          };
        }
        if (!secondIsDep) {
          const id = uuid();
          view.edges[id] = { id, source: node.id, target: tNode.id, pinned: true, role: 'flow' };
        }
        if (firstIsDep && edge.label) {
          const dep = Object.values(p.core.dependencies).find(
            (d) => d.from === sTaskId && d.to === newId,
          );
          const derived = dep
            ? Object.values(view.edges).find((x) => x.derivedFromDependencyId === dep.id)
            : undefined;
          if (derived) derived.label = edge.label;
        }
      }
      pushHistory(p, '工程を挿入');
      sync({ selectedTaskId: newId });
      return newId;
    },

    // フロー固有要素（制御ノード/コメント/手動エッジ）の編集。view を直接いじって push。
    addControlNode: (control, x, y) =>
      editView((view) => {
        const id = uuid();
        // 位置指定あり（画面中央など）＝そこを起点に、既存の箱ノードと重ならない位置へ段積み。
        // k%5 の周回だと 5 個目で真上に戻り「追加が効かない」誤認を招いていた（累積で必ずズレる）。
        const base = x != null ? { x: Math.round(x), y: Math.round(y ?? 44) } : { x: 420, y: 44 };
        const pos = stackSlot(view, base.x, base.y, SIZE.control);
        view.nodes[id] = { id, kind: 'control', control, x: pos.x, y: pos.y };
      }, '制御ノードを追加'),
    addComment: (text, x, y) =>
      editView((view) => {
        const id = uuid();
        const base = x != null ? { x: Math.round(x), y: Math.round(y ?? 320) } : { x: 420, y: 320 };
        const pos = stackSlot(view, base.x, base.y, SIZE.comment);
        view.nodes[id] = { id, kind: 'comment', text: text || 'メモ', x: pos.x, y: pos.y };
      }, 'メモを追加'),
    updateComment: (nodeId, text) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        const t = text || 'メモ'; // 空は addComment と同じ既定文言（見えない白付箋を作らない）
        if (!n || n.kind !== 'comment' || n.text === t) return false;
        n.text = t;
      }, 'メモを編集'),
    setCommentTarget: (nodeId, targetNodeId) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        if (!n || n.kind !== 'comment') return false;
        // 対象は実在する工程ノードのみ（自分自身・不在ノードは無効＝ダングリング参照を作らない）。
        if (targetNodeId !== undefined) {
          const t = view.nodes[targetNodeId];
          if (!t || t.kind !== 'task' || targetNodeId === nodeId) return false;
        }
        if ((n.targetNodeId ?? undefined) === (targetNodeId ?? undefined)) return false;
        if (targetNodeId === undefined) delete n.targetNodeId;
        else n.targetNodeId = targetNodeId;
      }, targetNodeId ? '付箋の対象を設定' : '付箋の対象を解除'),
    tidyFlow: (selectedIds) =>
      editView((view, p) => {
        // 部分整列: 選択した工程ノード以外を固定扱い（位置・レーン高さを保つ）。
        const keepFixed = tidyKeepFixed(view, selectedIds);
        const tidied = tidyFlowView(p.core, p.details, view, keepFixed);
        // 差分の出ない整列は履歴・dirty を汚さない（no-op。呼び出し側で案内トーストを出す）。
        if (sameLayout(view, tidied)) return false;
        p.flow.byLevel[p.flow.byLevel.indexOf(view)] = tidied;
      }, '自動整列'),
    wouldTidyFlow: (selectedIds) => {
      const { level, scopeParentId } = get();
      const view = findView(get().project, level, scopeParentId);
      if (!view) return false;
      const keepFixed = tidyKeepFixed(view, selectedIds);
      const tidied = tidyFlowView(get().project.core, get().project.details, view, keepFixed);
      return !sameLayout(view, tidied);
    },
    setLaneHeight: (laneId, height) =>
      editView((view) => {
        const lane = view.lanes[laneId];
        if (!lane) return false;
        const clamped = Math.max(LANE_MIN_H, Math.round(height));
        const delta = clamped - laneHeight(lane);
        if (delta === 0) return false;
        // 変更前の「次レーン基準 y」より下のノードは、レーン拡縮ぶん連動シフト（絶対 y の整合）。
        const threshold = laneTaskBaseY(view.lanes, lane.order + 1);
        lane.height = clamped;
        for (const n of Object.values(view.nodes)) {
          if (n.y >= threshold) n.y += delta;
        }
      }, 'レーン高さを変更'),
    moveLane: (laneId, dir) =>
      editView((view) => {
        // レーン幾何は laneLayout（唯一の正）から取る。boxes は order 昇順。
        const boxes = laneLayout(view.lanes);
        const idx = boxes.findIndex((b) => b.lane.id === laneId);
        const j = idx + dir;
        if (idx < 0 || j < 0 || j >= boxes.length) return false;
        // 入れ替える 2 レーンの上(U)/下(D)を特定
        const U = dir === 1 ? boxes[idx]! : boxes[j]!;
        const D = dir === 1 ? boxes[j]! : boxes[idx]!;
        // U の帯のノードは下へ(+D高さ)、D の帯のノードは上へ(-U高さ)。帯外は不変。
        for (const n of Object.values(view.nodes)) {
          if (n.y >= U.top && n.y < U.top + U.height) n.y += D.height;
          else if (n.y >= D.top && n.y < D.top + D.height) n.y -= U.height;
        }
        const tmp = U.lane.order;
        U.lane.order = D.lane.order;
        D.lane.order = tmp;
      }, 'レーンを入れ替え'),
    // 矢印接続。両端が工程ノードなら「依存（前後関係）」をコアに作る→工程表へ反映。
    // 制御ノード等を含む接続は従来どおり pinned な図固有エッジ（reconcile で消えない）。
    connect: (source, target) => {
      if (source === target) return;
      const { level, scopeParentId } = get();
      const view = findView(get().project, level, scopeParentId);
      const sNode = view?.nodes[source];
      const tNode = view?.nodes[target];
      if (sNode?.kind === 'task' && tNode?.kind === 'task') {
        const from = get().project.core.tasks[sNode.taskId];
        const to = get().project.core.tasks[tNode.taskId];
        // 同じ粒度の工程どうしは依存化（前後関係）。別の大工程を跨ぐ中工程の接続も可
        // （全体スコープのビューで描画される）。粒度が違う接続は従来どおり pinned エッジ。
        if (from && to && from.level === to.level) {
          if (!hasDependency(sNode.taskId, tNode.taskId)) {
            commit(cAddDependency(get().project, sNode.taskId, tNode.taskId, uuid), '前工程を追加');
          }
          return;
        }
      }
      // 既に同じ手動エッジがあれば no-op（履歴を汚さない）。
      if (view && Object.values(view.edges).some((e) => e.source === source && e.target === target))
        return;
      editView((v) => {
        const id = uuid();
        v.edges[id] = { id, source, target, pinned: true, role: 'flow' };
      }, '接続を追加');
    },
    toggleNodePin: (nodeId) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        if (n && n.kind === 'task') n.pinned = !n.pinned;
      }, '固定を切替'),
    // 既存エッジの端点付け替え。導出エッジ＝依存(from/to)の付け替え、手動エッジ＝端点の差し替え。
    reconnectEdge: (edgeId, end, newNodeId) => {
      const { level, scopeParentId } = get();
      const view = findView(get().project, level, scopeParentId);
      const edge = view?.edges[edgeId];
      const newNode = view?.nodes[newNodeId];
      if (!view || !edge || !newNode) return;
      if (newNode.kind !== 'task' && newNode.kind !== 'control') return;
      const otherEndId = end === 'source' ? edge.target : edge.source;
      if (newNodeId === otherEndId) return; // 自己ループ防止
      if (edge.derivedFromDependencyId) {
        // 依存の付け替え（両端が工程である必要）。
        const dep = get().project.core.dependencies[edge.derivedFromDependencyId];
        const otherNode = view.nodes[otherEndId];
        if (!dep || newNode.kind !== 'task' || otherNode?.kind !== 'task') return;
        const newFrom = end === 'source' ? newNode.taskId : dep.from;
        const newTo = end === 'target' ? newNode.taskId : dep.to;
        if (newFrom === newTo) return;
        if (hasDependency(newFrom, newTo)) {
          commit(cRemoveDependency(get().project, dep.id), '前後関係を変更'); // 既存と重複 → 旧を畳むだけ
          return;
        }
        commit(cAddDependency(cRemoveDependency(get().project, dep.id), newFrom, newTo, uuid), '前後関係を変更');
        return;
      }
      // 手動（pinned）エッジ: 端点を差し替え（同一接続が既にあれば no-op）。
      const dup = Object.values(view.edges).some(
        (e) =>
          e.id !== edgeId &&
          (end === 'source'
            ? e.source === newNodeId && e.target === edge.target
            : e.source === edge.source && e.target === newNodeId),
      );
      if (dup) return;
      editView((v) => {
        const e = v.edges[edgeId];
        if (!e) return false;
        if (end === 'source') e.source = newNodeId;
        else e.target = newNodeId;
      }, '接続を変更');
    },
    renameAssignee: (assigneeId, name) => {
      const trimmed = name.trim();
      const cur = get().project.core.assignees[assigneeId];
      if (!cur || !trimmed || cur.name === trimmed) return;
      const p = structuredClone(get().project);
      const a = p.core.assignees[assigneeId];
      if (a) a.name = trimmed; // reconcile でレーン名(title)・各工程の担当表示へ反映
      commit(p, '担当名を変更');
    },
    setEdgeLabel: (edgeId, label) =>
      editView((view) => {
        const e = view.edges[edgeId];
        if (e) e.label = label || undefined;
      }, 'ラベルを変更'),
    deleteFlowNode: (nodeId) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        if (!n || (n.kind !== 'control' && n.kind !== 'comment')) return; // 図固有要素のみ削除可
        delete view.nodes[nodeId];
        for (const e of Object.values(view.edges)) {
          if (e.source === nodeId || e.target === nodeId) delete view.edges[e.id];
        }
      }, 'ノードを削除'),
    deleteFlowNodes: (nodeIds) =>
      editView((view) => {
        const set = new Set(nodeIds);
        for (const id of nodeIds) {
          const n = view.nodes[id];
          if (!n || (n.kind !== 'control' && n.kind !== 'comment')) continue;
          delete view.nodes[id];
        }
        for (const e of Object.values(view.edges)) {
          if (set.has(e.source) || set.has(e.target)) delete view.edges[e.id];
        }
      }, 'ノードを削除'),
    deleteEdge: (edgeId) => {
      const view = findView(get().project, get().level, get().scopeParentId);
      const edge = view?.edges[edgeId];
      // 導出エッジは元の依存（前後関係）を消す＝表にも反映し再同期でも復活しない。
      // 手動（pinned）エッジは図からのみ取り除く。
      if (edge?.derivedFromDependencyId) {
        commit(cRemoveDependency(get().project, edge.derivedFromDependencyId), '前工程を削除');
        return;
      }
      editView((v) => {
        delete v.edges[edgeId];
      }, 'エッジを削除');
    },

    select: (taskId) => set({ selectedTaskId: taskId }),

    setLevel: (level) => {
      // 同じ粒度なら現在のスコープを保つ(行クリック等での意図しないスコープ解除を防ぐ)。
      const scopeParentId = level === get().level ? get().scopeParentId : defaultScopeFor(level);
      replaceTop(reconcileProject(ensureLevelView(get().project, level, scopeParentId), uuid));
      sync({ level, scopeParentId });
    },

    setScope: (scopeParentId) => {
      replaceTop(reconcileProject(ensureLevelView(get().project, get().level, scopeParentId), uuid));
      sync({ scopeParentId });
    },

    toggleIssues: () => set({ showIssues: !get().showIssues }),

    undo: () => {
      // 取り消す操作＝いまの先頭(labelCursor 位置)のラベル。undo 成功後にカーソルを 1 戻す。
      const undone = labels[labelCursor];
      if (history.undo()) {
        labelCursor -= 1;
        sync();
        useUI.getState().toast(`元に戻しました: ${undone ?? LABEL_FALLBACK}`);
      } else {
        // 履歴の端。キーボード（Ctrl+Z）は端でも呼ばれるため、無反応にせず案内する（#10）。
        useUI.getState().toast('これ以上戻せません', 'info');
      }
    },
    redo: () => {
      if (history.redo()) {
        labelCursor += 1;
        // やり直す操作＝進めた先(新しい labelCursor 位置)のラベル。
        const redone = labels[labelCursor];
        sync();
        useUI.getState().toast(`やり直しました: ${redone ?? LABEL_FALLBACK}`);
      } else {
        useUI.getState().toast('これ以上やり直せません', 'info');
      }
    },
    // AI 承認バッチの一括適用（ACTION_CLASS='forward'）。プレビューの決定論 id は捨て、本番 uuid で
    // 適用対象 ops を runBatch し直す。commit が reconcile と 1 undo を担当する（承認分が undo 一発で戻る）。
    applyApprovedBatch: (ops) => {
      if (!ops.length) return {}; // 承認 0 件は履歴を汚さない
      const now = new Date().toISOString();
      const { project, aliases } = runBatch(get().project, ops, uuid, now);
      commit(project, 'AI提案を適用');
      return aliases; // ref→実 taskId（見送り分のセッション継続で参照張り替えに使う。D-02）
    },

    markSaved: (saved) => {
      const target = saved ?? history.current();
      // 保存 await 中に setLevel/setScope（replaceTop）が走ると、保存したスナップショットが
      // 履歴の先頭から外れ、参照比較では二度と dirty が false にならない。参照が違っても
      // 内容が等価なら現在の先頭を保存済み扱いにする（保存完了時 1 回だけの stringify は許容）。
      savedRef =
        target !== history.current() &&
        serializeProject(target) === serializeProject(history.current())
          ? history.current()
          : target;
      sync();
    },

    loadProject: (project) => {
      // 別プロジェクトへの置き換え（undo 履歴リセット）＝新プロジェクトが参照する画像だけ残す
      // （全消しにすると、直前に openProjectFromFile が ingestAssets した開いたばかりの
      //  ファイルの画像まで消してしまう＝Critical リグレッション）。
      pruneAssetStore(collectReferencedAssetFiles(project));
      const first = project.flow.byLevel[0];
      adopt(project, first?.level ?? 'medium', first?.scopeParentId);
    },
    reloadFromExternal: (project) => {
      // 現在見ているビューが新ファイルにも在れば維持（無ければ先頭ビューへフォールバック）。
      const { level, scopeParentId, selectedTaskId } = get();
      const keepView = project.flow.byLevel.some(
        (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
      );
      const first = project.flow.byLevel[0];
      const lv = keepView ? level : first?.level ?? 'medium';
      const sc = keepView ? scopeParentId : first?.scopeParentId;
      adopt(project, lv, sc); // 保存済みベース（dirty=false）。undo 履歴はリセットされる。
      // 選択していた工程が残っていれば選択を復元（ハイライト/インスペクタの飛びを抑える）。
      if (selectedTaskId && project.core.tasks[selectedTaskId]) set({ selectedTaskId });
    },
    restoreProject: (project) => {
      // 別プロジェクトへの置き換え（undo 履歴リセット）＝新プロジェクトが参照する画像だけ残す。
      pruneAssetStore(collectReferencedAssetFiles(project));
      const first = project.flow.byLevel[0];
      adopt(project, first?.level ?? 'medium', first?.scopeParentId, true); // 未保存扱い
    },
    importCsvText: (text) => {
      const { project, report } = importCsv(text, uuid);
      const hasLarge = Object.values(project.core.tasks).some((t) => t.level === 'large');
      // 別プロジェクトへの置き換え（undo 履歴リセット）＝新プロジェクトが参照する画像だけ残す
      // （取込直後は画像を参照しないため、実質は前プロジェクトの画像の全消し＝メモリ回収）。
      pruneAssetStore(collectReferencedAssetFiles(project));
      adopt(project, hasLarge ? 'large' : 'medium', undefined, true);
      return report;
    },
    importRows: (rows) => {
      const { project, report } = rowsToProject(rows, uuid);
      const hasLarge = Object.values(project.core.tasks).some((t) => t.level === 'large');
      // 別プロジェクトへの置き換え（undo 履歴リセット）＝新プロジェクトが参照する画像だけ残す
      // （取込直後は画像を参照しないため、実質は前プロジェクトの画像の全消し＝メモリ回収）。
      pruneAssetStore(collectReferencedAssetFiles(project));
      adopt(project, hasLarge ? 'large' : 'medium', undefined, true);
      return report;
    },
    newProject: () => {
      const p = initialProject();
      // 別プロジェクトへの置き換え（undo 履歴リセット）＝新規プロジェクトは画像を参照しないため、
      // 実質は前プロジェクトの画像の全消し（メモリ回収）。
      pruneAssetStore(collectReferencedAssetFiles(p));
      adopt(p, 'medium', undefined);
    },
    loadTemplate: (key) => {
      const tpl = TEMPLATES.find((t) => t.key === key);
      if (!tpl) return;
      const p = tpl.create(uuid, new Date().toISOString());
      // 別プロジェクトへの置き換え（undo 履歴リセット）＝テンプレートは画像を参照しないため、
      // 実質は前プロジェクトの画像の全消し（メモリ回収）。
      pruneAssetStore(collectReferencedAssetFiles(p));
      adopt(p, 'medium', undefined); // 既定は全体スコープ(大をまたいで業務全体を俯瞰)
    },
    loadSample: () => {
      const sample = createSampleProject(uuid, new Date().toISOString());
      // 別プロジェクトへの置き換え（undo 履歴リセット）＝サンプルは画像を参照しないため、
      // 実質は前プロジェクトの画像の全消し（メモリ回収）。
      pruneAssetStore(collectReferencedAssetFiles(sample));
      adopt(sample, 'medium', undefined); // 既定は全体スコープ
    },

    // --- 両窓編集同期（dualwindow） ---
    // 従属窓へのスナップショット反映。canUndo/canRedo/dirty はリーダーの履歴状態をそのまま採用
    // （従属窓は自前の履歴を持たない）。表示状態（level/scope/選択/showIssues）と savedRef・
    // history には一切触れない＝窓ごとに独立。focusHint はキーがあるときだけ更新する。
    applyRemoteSnapshot: (snap) =>
      set({
        project: snap.project,
        canUndo: snap.canUndo,
        canRedo: snap.canRedo,
        dirty: snap.dirty,
        ...(snap.lastSyncAdded ? { lastSyncAdded: snap.lastSyncAdded } : {}),
        ...(snap.lastAssigneeSync ? { lastAssigneeSync: snap.lastAssigneeSync } : {}),
        ...('focusHint' in snap ? { focusHint: snap.focusHint ?? null } : {}),
      }),

    // 指定ビューを保証・reconcile して履歴の先頭を置換（undo 対象外）。ensureLevelView も reconcile も
    // 冪等なので、2 回目以降は added/removed 空＝プロジェクトは実質不変。
    ensureView: (level, scopeParentId) => {
      replaceTop(reconcileProject(ensureLevelView(get().project, level, scopeParentId), uuid));
      sync();
    },
  };
};

export const useApp = create<AppState>(appStateCreator);
export const createAppStore = () => createStore<AppState>(appStateCreator);
