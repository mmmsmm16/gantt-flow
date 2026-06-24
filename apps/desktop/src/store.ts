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
} from '@gantt-flow/core';
import { clearLastCommand } from './ui/lastCommand';

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

// 基準ノードの直下の空きサブ行（y = ref.y + k*ROW_SUB、x は同じ）を探す。
// 並行追加・並行化の連打でノードが重ならないようにする。
function parallelSlotBelow(
  view: FlowLevelView,
  ref: { x: number; y: number },
  excludeId?: FlowNodeId,
): { x: number; y: number } {
  const taken = Object.values(view.nodes).filter(
    (n) => (n.kind === 'task' || n.kind === 'control') && n.id !== excludeId,
  );
  for (let k = 1; k <= taken.length + 1; k++) {
    const y = ref.y + k * ROW_SUB;
    const occupied = taken.some(
      (n) => Math.abs(n.x - ref.x) < SIZE.task.w && Math.abs(n.y - y) < SIZE.task.h,
    );
    if (!occupied) return { x: ref.x, y };
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

function initialProject(): Project {
  const now = new Date().toISOString();
  const base: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { id: uuid(), title: '新規プロジェクト', createdAt: now, updatedAt: now, appVersion: '0.0.0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
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

  addTask: (name: string) => void;
  /** ルート工程を追加し、新しい工程の ID を返す（追加直後に選択＋名前を即編集するため）。
      名前は空（''）＝addSiblingOf/クイック追加と同じ「無題で作って即入力」の規約。 */
  addRootTask: (level: ProcessLevel) => Id | undefined;
  /** 子工程を追加し、新しい工程の ID を返す（フォーカス/選択用）。 */
  addChildTask: (parentId: Id) => Id | undefined;
  removeTask: (taskId: Id) => void;
  setTaskLevel: (taskId: Id, level: ProcessLevel) => void;
  setTaskCode: (taskId: Id, code: string | undefined) => void;
  renameTask: (taskId: Id, name: string) => void;
  setAssigneeByName: (taskId: Id, name: string) => void;
  /** 複数工程の担当を一括設定（1 undo 単位）。空名は未割当に。 */
  setAssigneeManyByName: (taskIds: Id[], name: string) => void;
  /** 複数工程を一括削除（各々の配下は1つ上へ繰り上げ、1 undo 単位）。 */
  removeManyTasks: (taskIds: Id[]) => void;
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
  /** To-Be で新設する工程(lifecycle='added')を作る。As-Is には出ない。作成 ID を返す。 */
  addToBeTask: () => Id | undefined;
  moveNode: (nodeId: FlowNodeId, x: number, y: number) => void;
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
  /** 現在のフロービューを自動整列（依存で段組み・レーンで縦配置）。1 undo 単位。 */
  tidyFlow: () => void;
  /** レーンの高さを変更（手動リサイズ）。下のレーンのノードを連動シフトして整合を保つ。 */
  setLaneHeight: (laneId: Id, height: number) => void;
  /** スイムレーンを 1 つ上(-1)/下(+1)へ入れ替える。中のノードも連動して移動。 */
  moveLane: (laneId: Id, dir: -1 | 1) => void;
  connect: (source: FlowNodeId, target: FlowNodeId) => void;
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
}

export const appStateCreator: StateCreator<AppState> = (set, get) => {
  const history = createHistory<Project>(initialProject());
  // 未保存検知: 最後に保存/開いた時点の Project 参照。現在がこれと異なれば dirty。
  let savedRef: Project | null = history.current();

  const sync = (extra: Partial<AppState> = {}) =>
    set({
      project: history.current(),
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
      dirty: history.current() !== savedRef,
      ...extra,
    });

  // core/details を変えるコマンド: 現在ビューを保証 → reconcile → 履歴 push（1 undo 単位）
  const commit = (p: Project) => {
    const { level, scopeParentId } = get();
    const withView = ensureLevelView(p, level, scopeParentId);
    const { project: reconciled, reports } = reconcileProjectWithReport(withView, uuid);
    history.push(reconciled);
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
  const editView = (fn: (view: FlowLevelView, project: Project) => void | false) => {
    const { level, scopeParentId } = get();
    const p = structuredClone(get().project);
    const view = findView(p, level, scopeParentId);
    if (!view) return;
    if (fn(view, p) === false) return;
    history.push(p);
    sync();
  };

  // ファイルを開く/新規/取り込み: 既定ビューを保証して履歴をリセット（undo 不可の境界）
  const adopt = (p: Project, level: ProcessLevel, scopeParentId?: Id, dirtyAfter = false) => {
    // 直前コマンドの記録（mod+. のリピート）も破棄: 前プロジェクトの工程 id を
    // 引数に持つコマンドを新プロジェクトへ再実行させない。
    clearLastCommand();
    const reconciled = reconcileProject(ensureLevelView(p, level, scopeParentId), uuid);
    history.reset(reconciled);
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

  // reparent は実質変化があるときだけコミット（深さ超過・循環などの no-op で履歴を汚さない）。
  const commitReparent = (taskId: Id, newParentId: Id | undefined, index?: number) => {
    const cur = get().project;
    const applied = cReparentTask(cur, taskId, newParentId, index);
    const a = cur.core.tasks[taskId];
    const b = applied.core.tasks[taskId];
    if (a && b && (a.parentId !== b.parentId || a.level !== b.level || a.order !== b.order)) {
      commit(applied);
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

    addTask: (name) =>
      commit(
        cAddTask(
          get().project,
          { name: name || '新規作業', level: get().level, parentId: get().scopeParentId },
          uuid,
        ),
      ),

    addRootTask: (level) => {
      // 空名で作り、UI 側が追加直後に選択＋名前を即編集する（キーボード n=addSiblingOf と挙動統一）。
      const id = uuid();
      commit(cAddTask(get().project, { name: '', level, parentId: undefined, id }, uuid));
      return id;
    },

    addChildTask: (parentId) => {
      const parent = get().project.core.tasks[parentId];
      if (!parent) return undefined;
      const childLevel = LEVELS[RANK[parent.level] + 1] ?? 'detail';
      const id = uuid();
      commit(cAddTask(get().project, { name: '新規工程', level: childLevel, parentId, id }, uuid));
      return id;
    },

    // 削除は配下を残す（子は祖父へ昇格し、依存は維持）。
    removeTask: (taskId) => {
      const p = cDeleteTaskKeepChildren(get().project, taskId);
      clearScopeIfRemoved(p);
      commit(p);
    },

    setTaskLevel: (taskId, level) => commit(cSetTaskLevel(get().project, taskId, level)),
    setTaskCode: (taskId, code) => commit(cSetTaskCode(get().project, taskId, code)),

    renameTask: (taskId, name) => commit(cRenameTask(get().project, taskId, name)),

    setAssigneeByName: (taskId, name) => {
      const trimmed = name.trim();
      if (!trimmed) {
        commit(cSetAssignee(get().project, taskId, undefined));
        return;
      }
      const { project: p, assigneeId } = ensureAssigneeId(get().project, trimmed);
      commit(cSetAssignee(p, taskId, assigneeId));
    },

    setAssigneeManyByName: (taskIds, name) => {
      let p = get().project;
      const trimmed = name.trim();
      let assigneeId: Id | undefined;
      if (trimmed) {
        ({ project: p, assigneeId } = ensureAssigneeId(p, trimmed));
      }
      let changed = false;
      for (const id of taskIds) {
        if (p.core.tasks[id]) {
          p = cSetAssignee(p, id, assigneeId);
          changed = true;
        }
      }
      if (changed) commit(p);
    },

    removeManyTasks: (taskIds) => {
      let p = get().project;
      let changed = false;
      for (const id of taskIds) {
        if (p.core.tasks[id]) {
          p = cDeleteTaskKeepChildren(p, id);
          changed = true;
        }
      }
      if (changed) {
        clearScopeIfRemoved(p);
        commit(p);
      }
    },

    addDependency: (from, to) => {
      if (!from || !to || from === to) return;
      // 消えた工程を指す依存は作らない（リピート mod+. 等で stale な id が来る。
      // addTaskWithOptions が predecessorId に行っているのと同じ規約）。
      const tasks = get().project.core.tasks;
      if (!tasks[from] || !tasks[to]) return;
      if (hasDependency(from, to)) return; // 既存の依存への再接続は no-op
      commit(cAddDependency(get().project, from, to, uuid));
    },

    removeDependency: (depId) => commit(cRemoveDependency(get().project, depId)),
    setDependencyPhase: (depId, phase) => commit(cSetDependencyPhase(get().project, depId, phase)),
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
      commit(p);
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
      commit(p);
    },
    removeToBePredecessor: (taskId, fromId) => {
      let p = get().project;
      const dep = Object.values(p.core.dependencies).find((d) => d.from === fromId && d.to === taskId);
      if (!dep) return;
      if (dep.phase === 'tobe') p = cRemoveDependency(p, dep.id); // To-Be専用→削除
      else if (dep.phase === undefined) p = cSetDependencyPhase(p, dep.id, 'asis'); // 両方→As-Is専用(To-Beから外す)
      else return; // As-Is専用→To-Beには無い
      commit(p);
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
      commit(p);
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
      commit(p);
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
        { name: t.name, level: t.level, parentId: t.parentId, assigneeId: t.assigneeId, id: newId },
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
      commit(p);
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
      if (count) commit(p);
      return count;
    },

    moveTaskUp: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx > 0) commit(cReorderTask(get().project, taskId, idx - 1));
    },
    moveTaskDown: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx >= 0 && idx < sibs.length - 1) commit(cReorderTask(get().project, taskId, idx + 1));
    },
    indentTask: (taskId) => {
      const sibs = siblingsOf(taskId);
      const idx = sibs.findIndex((t) => t.id === taskId);
      if (idx > 0) commitReparent(taskId, sibs[idx - 1]!.id); // 直前の兄弟の子へ
    },
    outdentTask: (taskId) => {
      const t = get().project.core.tasks[taskId];
      if (!t || t.parentId === undefined) return; // 既に root
      const parent = get().project.core.tasks[t.parentId];
      if (!parent) return;
      const gpSibs = siblingsOf(parent.id);
      const parentIdx = gpSibs.findIndex((o) => o.id === parent.id);
      commitReparent(taskId, parent.parentId, parentIdx + 1); // 親の直後（祖父母の子）へ
    },
    dropTask: (dragId, targetId, mode) => {
      if (dragId === targetId) return;
      const drag = get().project.core.tasks[dragId];
      const target = get().project.core.tasks[targetId];
      if (!drag || !target) return;
      if (mode === 'child') {
        commitReparent(dragId, targetId);
        return;
      }
      const targetParent = target.parentId;
      const sibs = siblingsOf(targetId);
      const ti = sibs.findIndex((o) => o.id === targetId);
      if ((drag.parentId ?? undefined) === (targetParent ?? undefined)) {
        const di = sibs.findIndex((o) => o.id === dragId); // 同一グループ → 並べ替え
        const tiPost = di < ti ? ti - 1 : ti;
        commit(cReorderTask(get().project, dragId, mode === 'after' ? tiPost + 1 : tiPost));
      } else {
        commitReparent(dragId, targetParent, mode === 'after' ? ti + 1 : ti); // 別グループ → 移動
      }
    },

    addIo: (taskId, io, name) => {
      const lv = get().project.core.tasks[taskId]?.level;
      const kind: IoKind = lv === 'small' || lv === 'detail' ? 'info' : 'doc';
      commit(cAddIoItem(get().project, taskId, io, { name: name || '帳票', kind }, uuid));
    },
    updateIo: (taskId, ioId, patch) => commit(cUpdateIoItem(get().project, taskId, ioId, patch)),
    removeIo: (taskId, ioId) => commit(cRemoveIoItem(get().project, taskId, ioId)),

    addIssue: (taskId, text) => commit(cAddIssueItem(get().project, taskId, { issue: text || '課題' }, uuid)),
    addIssueWithMeasure: (taskId, measure) =>
      commit(cAddIssueItem(get().project, taskId, { issue: '', measure }, uuid)),
    updateIssue: (taskId, issueId, patch) => commit(cUpdateIssueItem(get().project, taskId, issueId, patch)),
    removeIssue: (taskId, issueId) => commit(cRemoveIssueItem(get().project, taskId, issueId)),
    updateDetail: (taskId, patch) => commit(cUpdateTaskDetail(get().project, taskId, patch)),
    updateToBe: (taskId, patch) => commit(cUpdateTaskToBe(get().project, taskId, patch)),
    copyAsIsToToBe: (taskId) => commit(cCopyAsIsToToBe(get().project, taskId)),
    addToBeTask: () => {
      const cur = get().project;
      const firstLarge = Object.values(cur.core.tasks).find((t) => t.level === 'large');
      const parentId = firstLarge?.id;
      const level: ProcessLevel = parentId ? 'medium' : 'large';
      const assigneeId = Object.values(cur.core.assignees)[0]?.id;
      const id = uuid();
      let p = cAddTask(cur, { name: '新規工程', level, parentId, assigneeId, id }, uuid);
      p = cUpdateTaskToBe(p, id, { lifecycle: 'added' });
      commit(p);
      return id;
    },

    // フロー上のドラッグ確定。別レーンに落ちたら担当を書き戻す（唯一の逆方向同期）。
    moveNode: (nodeId, x, y) => {
      const { level, scopeParentId } = get();
      const p = structuredClone(get().project);
      const view = findView(p, level, scopeParentId);
      const node = view?.nodes[nodeId];
      if (!view || !node) return;
      node.x = x;
      node.y = y;

      if (node.kind === 'task') {
        const laneOrder = nearestLaneOrder(view.lanes, y);
        const lane = Object.values(view.lanes).find((l) => l.order === laneOrder);
        const task = p.core.tasks[node.taskId];
        if (lane?.assigneeId && task && task.assigneeId !== lane.assigneeId) {
          task.assigneeId = lane.assigneeId; // 逆同期: レーン → 担当
          history.push(reconcileProject(p, uuid));
          // 書き戻った工程を記録（表側の担当セルの一時ハイライト）。
          sync({ lastAssigneeSync: { ids: [node.taskId], seq: get().lastAssigneeSync.seq + 1 } });
          return;
        }
      }
      history.push(p);
      sync();
    },

    // 複数ノードをまとめて平行移動（範囲選択した要素を一括ドラッグ）。
    // レーン再割当（逆同期）はしない＝選択をそのままずらす素直な挙動。1 undo 単位。
    moveNodesBy: (nodeIds, dx, dy) => {
      if ((dx === 0 && dy === 0) || nodeIds.length === 0) return;
      editView((view) => {
        let changed = false;
        for (const id of nodeIds) {
          const n = view.nodes[id];
          if (n) {
            n.x = Math.round(n.x + dx);
            n.y = Math.round(n.y + dy);
            changed = true;
          }
        }
        if (!changed) return false;
      });
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
      history.push(p);
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
      history.push(p);
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
      history.push(p);
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
      history.push(p);
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
      history.push(p);
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
      history.push(p);
      sync({ selectedTaskId: newId });
      return newId;
    },

    // フロー固有要素（制御ノード/コメント/手動エッジ）の編集。view を直接いじって push。
    addControlNode: (control, x, y) =>
      editView((view) => {
        const id = uuid();
        const k = Object.values(view.nodes).filter((n) => n.kind === 'control').length;
        // 位置指定あり（画面中央など）＝そこへ。同じ点への連続追加は少しずらして重なりを防ぐ。
        const px = x != null ? Math.round(x) + (k % 5) * 18 : 420 + k * 28;
        const py = y != null ? Math.round(y) + (k % 5) * 14 : 44 + k * 18;
        view.nodes[id] = { id, kind: 'control', control, x: px, y: py };
      }),
    addComment: (text, x, y) =>
      editView((view) => {
        const id = uuid();
        const k = Object.values(view.nodes).filter((n) => n.kind === 'comment').length;
        const px = x != null ? Math.round(x) + (k % 5) * 18 : 420;
        const py = y != null ? Math.round(y) + (k % 5) * 14 : 320 + k * 24;
        view.nodes[id] = { id, kind: 'comment', text: text || 'メモ', x: px, y: py };
      }),
    updateComment: (nodeId, text) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        const t = text || 'メモ'; // 空は addComment と同じ既定文言（見えない白付箋を作らない）
        if (!n || n.kind !== 'comment' || n.text === t) return false;
        n.text = t;
      }),
    tidyFlow: () =>
      editView((view, p) => {
        p.flow.byLevel[p.flow.byLevel.indexOf(view)] = tidyFlowView(p.core, p.details, view);
      }),
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
      }),
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
      }),
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
            commit(cAddDependency(get().project, sNode.taskId, tNode.taskId, uuid));
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
      });
    },
    toggleNodePin: (nodeId) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        if (n && n.kind === 'task') n.pinned = !n.pinned;
      }),
    setEdgeLabel: (edgeId, label) =>
      editView((view) => {
        const e = view.edges[edgeId];
        if (e) e.label = label || undefined;
      }),
    deleteFlowNode: (nodeId) =>
      editView((view) => {
        const n = view.nodes[nodeId];
        if (!n || (n.kind !== 'control' && n.kind !== 'comment')) return; // 図固有要素のみ削除可
        delete view.nodes[nodeId];
        for (const e of Object.values(view.edges)) {
          if (e.source === nodeId || e.target === nodeId) delete view.edges[e.id];
        }
      }),
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
      }),
    deleteEdge: (edgeId) => {
      const view = findView(get().project, get().level, get().scopeParentId);
      const edge = view?.edges[edgeId];
      // 導出エッジは元の依存（前後関係）を消す＝表にも反映し再同期でも復活しない。
      // 手動（pinned）エッジは図からのみ取り除く。
      if (edge?.derivedFromDependencyId) {
        commit(cRemoveDependency(get().project, edge.derivedFromDependencyId));
        return;
      }
      editView((v) => {
        delete v.edges[edgeId];
      });
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
      if (history.undo()) sync();
    },
    redo: () => {
      if (history.redo()) sync();
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
      const first = project.flow.byLevel[0];
      adopt(project, first?.level ?? 'medium', first?.scopeParentId, true); // 未保存扱い
    },
    importCsvText: (text) => {
      const { project, report } = importCsv(text, uuid);
      const hasLarge = Object.values(project.core.tasks).some((t) => t.level === 'large');
      adopt(project, hasLarge ? 'large' : 'medium', undefined, true);
      return report;
    },
    importRows: (rows) => {
      const { project, report } = rowsToProject(rows, uuid);
      const hasLarge = Object.values(project.core.tasks).some((t) => t.level === 'large');
      adopt(project, hasLarge ? 'large' : 'medium', undefined, true);
      return report;
    },
    newProject: () => adopt(initialProject(), 'medium', undefined),
    loadTemplate: (key) => {
      const tpl = TEMPLATES.find((t) => t.key === key);
      if (!tpl) return;
      const p = tpl.create(uuid, new Date().toISOString());
      adopt(p, 'medium', undefined); // 既定は全体スコープ(大をまたいで業務全体を俯瞰)
    },
    loadSample: () => {
      const sample = createSampleProject(uuid, new Date().toISOString());
      adopt(sample, 'medium', undefined); // 既定は全体スコープ
    },
  };
};

export const useApp = create<AppState>(appStateCreator);
export const createAppStore = () => createStore<AppState>(appStateCreator);
