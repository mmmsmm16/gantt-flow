// 両窓編集同期（dualwindow）。既存の閲覧専用ミラー（gf-mirror / MirrorView）とは別系統で、
// 「メインウィンドウ＝リーダー」「?window=edit の別窓＝フォロワー」を新チャネル gf-sync で結ぶ。
//
// 方式（設計メモ .superpowers/sdd/dualwindow-design.md）:
//  - リーダーが唯一の真実。編集はすべてリーダーの store（core→reconcile→history）で直列適用する
//    ＝並行性が無いので reconcile 不変条件は安全。
//  - フォロワーは編集アクションをリーダーへ「転送」し、返ってきたスナップショットで自窓を更新する
//    （最初の snapshot を受け取るまで編集禁止）。表示状態（level/scope/選択/課題レイヤ）は窓ごとに独立。
//  - 作成系の返り値（新工程 id）は同期的に得られないため、リーダーが focusHint で発信元の窓に
//    「作成した工程へリネーム/詳細/選択を寄せる」よう伝える（origin 一致の窓だけが実行）。
import { create } from 'zustand';
import type { StoreApi } from 'zustand';
import {
  type AppState,
  type RemoteSnapshot,
  type FocusHint,
  type FocusIntent,
  useApp,
} from './store';
import { useUI } from './ui/useUI';

/** 同一オリジン内でリーダーとフォロワーを結ぶチャネル名（閲覧専用ミラーの gf-mirror とは別）。 */
export const SYNC_CHANNEL = 'gf-sync';

export type WindowRole = 'leader' | 'follower';

/** URL の ?window=edit を解釈。編集用フォロワー窓なら 'edit'、それ以外は null（通常＝リーダー）。 */
export function parseWindowParam(search: string): 'edit' | null {
  return new URLSearchParams(search).get('window') === 'edit' ? 'edit' : null;
}

/** 編集用サブウィンドウ（?window=edit）を同一オリジンの別ウィンドウで開く。名前付きターゲットなので
    既に開いていれば前面化する（ミラーと同じ流儀）。 */
export function openEditWindow(): Window | null {
  if (typeof window === 'undefined') return null;
  const url = `${window.location.pathname}?window=edit`;
  return window.open(url, 'gf-edit', 'width=1200,height=800');
}

// ---------------------------------------------------------------------------
// アクション分類（store.ts の全ミューテータ／表示アクションを明示的に列挙する）。
// 新しいアクションを store に足したら必ずここへ 1 行足す。未分類は開発時に警告し、
// 実行時は安全側＝ローカル拒否（leaderOnly 扱い）にフォールバックする。
// dualwindow.test.ts が「全ストアアクションが分類済み」を機械的に assert する。
// ---------------------------------------------------------------------------
export type ActionClass =
  | 'forward' // ミューテータ: フォロワーはリーダーへ転送（core/details/flow を変える全操作）
  | 'ensureView' // setLevel/setScope: 表示はローカル＋冪等な ensureView だけ転送
  | 'local' // 窓ごとに独立（select/課題レイヤ/読み取り/スナップショット受信）
  | 'leaderOnly'; // ファイル系: フォロワーでは実行不可（UI グレーアウト＋案内）

export const ACTION_CLASS: Record<string, ActionClass> = {
  // --- forward（ミューテータ） ---
  addTask: 'forward',
  addRootTask: 'forward',
  addChildTask: 'forward',
  addMilestone: 'forward',
  removeTask: 'forward',
  setTaskLevel: 'forward',
  setTaskCode: 'forward',
  renameTask: 'forward',
  setAssigneeByName: 'forward',
  setAssigneeManyByName: 'forward',
  removeManyTasks: 'forward',
  addDependency: 'forward',
  removeDependency: 'forward',
  setDependencyPhase: 'forward',
  setToBePredecessor: 'forward',
  addToBePredecessor: 'forward',
  removeToBePredecessor: 'forward',
  addSiblingOf: 'forward',
  addTaskWithOptions: 'forward',
  duplicateTask: 'forward',
  pasteRowsAsTasks: 'forward',
  moveTaskUp: 'forward',
  moveTaskDown: 'forward',
  indentTask: 'forward',
  outdentTask: 'forward',
  dropTask: 'forward',
  addIo: 'forward',
  updateIo: 'forward',
  removeIo: 'forward',
  addIssue: 'forward',
  addIssueWithMeasure: 'forward',
  updateIssue: 'forward',
  removeIssue: 'forward',
  updateDetail: 'forward',
  updateToBe: 'forward',
  copyAsIsToToBe: 'forward',
  addToBeTask: 'forward',
  moveNode: 'forward',
  moveNodesBy: 'forward',
  addTaskAt: 'forward',
  addParallel: 'forward',
  makeParallelTo: 'forward',
  addTaskNextTo: 'forward',
  insertTaskOnEdge: 'forward',
  connectToNew: 'forward',
  addControlNode: 'forward',
  addComment: 'forward',
  updateComment: 'forward',
  setCommentTarget: 'forward',
  tidyFlow: 'forward',
  setLaneHeight: 'forward',
  moveLane: 'forward',
  connect: 'forward',
  reconnectEdge: 'forward',
  renameAssignee: 'forward',
  setEdgeLabel: 'forward',
  toggleNodePin: 'forward',
  deleteFlowNode: 'forward',
  deleteFlowNodes: 'forward',
  deleteEdge: 'forward',
  undo: 'forward',
  redo: 'forward',
  ensureView: 'forward',
  // --- ensureView（表示ローカル＋ビュー保証だけ転送） ---
  setLevel: 'ensureView',
  setScope: 'ensureView',
  // --- local（窓ごと独立／読み取り／受信） ---
  select: 'local',
  toggleIssues: 'local',
  wouldTidyFlow: 'local',
  applyRemoteSnapshot: 'local',
  // --- leaderOnly（ファイル系） ---
  markSaved: 'leaderOnly',
  loadProject: 'leaderOnly',
  reloadFromExternal: 'leaderOnly',
  importCsvText: 'leaderOnly',
  importRows: 'leaderOnly',
  newProject: 'leaderOnly',
  loadSample: 'leaderOnly',
  loadTemplate: 'leaderOnly',
  restoreProject: 'leaderOnly',
};

/** アクション名の分類。未分類は安全側で 'leaderOnly'（フォロワーで実行させない）。 */
export function classifyAction(name: string): ActionClass {
  return ACTION_CLASS[name] ?? 'leaderOnly';
}

// 作成系アクションが「発信元の窓」で行う後処理の種別。ここに無い forward アクションは
// 後処理なし（データ同期のみ）。surface は転送時のアクティブペインで決める（下記）。
export const FOCUS_INTENT: Record<string, FocusIntent> = {
  addTaskAt: 'rename',
  connectToNew: 'rename',
  insertTaskOnEdge: 'rename',
  addTaskNextTo: 'rename',
  addRootTask: 'rename',
  addChildTask: 'rename',
  addSiblingOf: 'rename',
  addParallel: 'rename',
  addMilestone: 'inspector',
  addTaskWithOptions: 'select',
  duplicateTask: 'select',
  addToBeTask: 'select',
};

// ---------------------------------------------------------------------------
// チャネル抽象（テストで差し替えるため薄く包む。mirror.ts の MirrorChannel と同じ流儀）。
// ---------------------------------------------------------------------------
export interface FocusRequest {
  intent: FocusIntent;
  surface?: 'table' | 'flow';
}

export type SyncMessage =
  | { type: 'hello' } // フォロワー→リーダー（接続時に現在状態を要求）
  | { type: 'bye' } // どちらか→相手（離脱通知。フォロワーは接続待ちへ）
  | { type: 'snapshot'; snapshot: RemoteSnapshot } // リーダー→フォロワー（現在状態）
  | { type: 'action'; name: string; args: unknown[]; origin: string; focus?: FocusRequest }; // フォロワー→リーダー（編集転送）

export interface SyncChannel {
  postMessage(msg: SyncMessage): void;
  onmessage: ((msg: SyncMessage) => void) | null;
  close(): void;
}

const hasBroadcastChannel = (): boolean => typeof BroadcastChannel !== 'undefined';

/** 実 BroadcastChannel を SyncChannel として開く（非対応環境では null＝同期無効）。 */
export function openSyncChannel(): SyncChannel | null {
  if (!hasBroadcastChannel()) return null;
  const ch = new BroadcastChannel(SYNC_CHANNEL);
  const wrap: SyncChannel = {
    postMessage: (m) => ch.postMessage(m),
    onmessage: null,
    close: () => ch.close(),
  };
  ch.onmessage = (e: MessageEvent) => wrap.onmessage?.(e.data as SyncMessage);
  return wrap;
}

// ---------------------------------------------------------------------------
// スナップショット抽出／差分判定（純粋関数・テスト対象）。
// ---------------------------------------------------------------------------
/** store 状態から従属窓へ配る同期フィールドだけを切り出す（表示状態は含めない）。 */
export function pickSnapshot(s: AppState): RemoteSnapshot {
  return {
    project: s.project,
    canUndo: s.canUndo,
    canRedo: s.canRedo,
    dirty: s.dirty,
    lastSyncAdded: s.lastSyncAdded,
    lastAssigneeSync: s.lastAssigneeSync,
    focusHint: s.focusHint,
  };
}

/** 発行済み a に対し b で「同期対象」が実質変わったか（無関係な store 変化では再発行しない）。
    project は不変更新なので参照比較。フラッシュ系・focusHint は seq で判定。 */
export function snapshotChanged(a: RemoteSnapshot | null, b: RemoteSnapshot): boolean {
  if (!a) return true;
  return (
    a.project !== b.project ||
    a.dirty !== b.dirty ||
    a.canUndo !== b.canUndo ||
    a.canRedo !== b.canRedo ||
    (a.lastSyncAdded?.seq ?? -1) !== (b.lastSyncAdded?.seq ?? -1) ||
    (a.lastAssigneeSync?.seq ?? -1) !== (b.lastAssigneeSync?.seq ?? -1) ||
    (a.focusHint?.seq ?? -1) !== (b.focusHint?.seq ?? -1)
  );
}

/** focusHint を「この窓」が実行すべきか（origin 一致のときだけ）。 */
export function shouldHandleFocus(focusHint: FocusHint | null | undefined, myWindowId: string): boolean {
  return !!focusHint && focusHint.origin === myWindowId;
}

// ---------------------------------------------------------------------------
// 窓ごとの同期状態（UI が購読）。role と接続状態を持つ。
// ---------------------------------------------------------------------------
interface DualWindowState {
  role: WindowRole;
  /** フォロワーがリーダーへ接続できているか（最初の snapshot 受信〜bye/切断まで）。
      リーダーは常に true（自身が真実）。 */
  connected: boolean;
}
export const useDualWindow = create<DualWindowState>(() => ({ role: 'leader', connected: true }));

/** この窓は編集転送フォロワーか（App/主要コンポーネントがファイル系グレーアウト等に使う）。 */
export const isFollowerWindow = (): boolean => useDualWindow.getState().role === 'follower';

// この窓の一意 id（origin 照合用）。モジュール読込時に 1 回だけ決める。
const genId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `w-${Math.random().toString(36).slice(2)}-${Date.now()}`;
export const MY_WINDOW_ID = genId();

// ---------------------------------------------------------------------------
// リーダー側ランタイム: フォロワーの action を直列適用し、変化のたび snapshot を配る。
// ---------------------------------------------------------------------------
export interface LeaderOptions {
  channel?: SyncChannel;
  /** 連続編集を束ねる猶予（既定 40ms）。hello には即応答（デバウンス無し）。 */
  debounceMs?: number;
  /** origin 照合に使うこの窓の id（省略時 MY_WINDOW_ID）。 */
  windowId?: string;
  /** true のとき配信のみ行い、フォロワーの編集転送(action)は適用しない（reflect-only）。 */
  readOnly?: boolean;
}

/** リーダー同期を開始する。返り値のクリーンアップで購読解除＋チャネルを閉じる。 */
export function createLeaderSync(store: StoreApi<AppState>, opts: LeaderOptions = {}): () => void {
  const ch = opts.channel ?? openSyncChannel();
  if (!ch) return () => {}; // 非対応環境: 同期無効（単独窓として普通に動く）
  const debounceMs = opts.debounceMs ?? 40;
  let last: RemoteSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publishNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    last = pickSnapshot(store.getState());
    ch.postMessage({ type: 'snapshot', snapshot: last });
  };
  const schedule = () => {
    if (!snapshotChanged(last, pickSnapshot(store.getState()))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(publishNow, debounceMs);
  };

  ch.onmessage = (msg) => {
    if (msg?.type === 'hello') {
      publishNow(); // 新しいフォロワー接続に現在状態で即応答
    } else if (msg?.type === 'action' && !opts.readOnly) {
      // フォロワーの編集をリーダーの store に直列適用（両窓編集同期の要）。
      applyForwardedAction(store, msg, opts.windowId ?? MY_WINDOW_ID);
      // 適用結果はすぐ配る（focusHint を含む最新スナップショットを 1 発で届ける）。
      publishNow();
    }
  };
  const unsub = store.subscribe(schedule);

  const onHide = () => ch.postMessage({ type: 'bye' });
  const wired = typeof window !== 'undefined';
  if (wired) window.addEventListener('pagehide', onHide);

  return () => {
    if (timer) clearTimeout(timer);
    unsub();
    if (wired) window.removeEventListener('pagehide', onHide);
    ch.close();
  };
}

// フォロワーから転送された 1 アクションをリーダーの store に適用する。
//  - forward 以外（未分類・leaderOnly 等）は握りつぶす（フォロワー UI 側で既に拒否済みの保険）。
//  - 作成系の返り値（新工程 id）を捕まえ、focus 指定があれば focusHint を立てる（発信元窓が後処理）。
//  - フォロワー代行の副作用でリーダー自身の選択/詳細/トーストを動かさない（表示は窓ごと独立）。
export function applyForwardedAction(
  store: StoreApi<AppState>,
  msg: Extract<SyncMessage, { type: 'action' }>,
  _leaderId: string,
): void {
  const state = store.getState() as unknown as Record<string, unknown>;
  const fn = state[msg.name];
  if (classifyAction(msg.name) !== 'forward' || typeof fn !== 'function') return;

  // リーダー自身の表示状態（選択・詳細・トースト）は、フォロワー代行では動かさない。
  const prevSel = store.getState().selectedTaskId;
  const ui = typeof useUI?.getState === 'function' ? useUI.getState() : null;
  const prevInspector = ui?.inspectorOpen;
  const prevToasts = ui?.toasts;

  const ret = (fn as (...a: unknown[]) => unknown)(...msg.args);

  if (msg.focus) {
    const taskId = typeof ret === 'string' ? ret : undefined;
    const seq = (store.getState().focusHint?.seq ?? 0) + 1;
    const hint: FocusHint = {
      taskId,
      origin: msg.origin,
      intent: msg.focus.intent,
      surface: msg.focus.surface,
      seq,
    };
    store.setState({ focusHint: hint });
  }

  // 表示状態を巻き戻す（フォロワーの作成で選択が動いた等をリーダー窓へ波及させない）。
  if (store.getState().selectedTaskId !== prevSel) store.setState({ selectedTaskId: prevSel });
  if (ui && prevInspector !== undefined && ui.inspectorOpen !== prevInspector) {
    ui.setInspectorOpen(prevInspector);
  }
  if (ui && prevToasts && ui.toasts !== prevToasts) useUI.setState({ toasts: prevToasts });
}

// ---------------------------------------------------------------------------
// フォロワー側ランタイム: 編集を転送し、snapshot を受けて自窓へ反映する。
// ---------------------------------------------------------------------------
export interface FollowerOptions {
  channel?: SyncChannel;
  windowId?: string;
  /** rename 後処理のペイン（テスト用に注入可能。既定は useUI.activePane）。 */
  activePane?: () => 'table' | 'flow';
  /** true のとき受信反映のみ行い、編集の転送・focusHint 後処理はしない（reflect-only）。 */
  readOnly?: boolean;
}

/** フォロワー同期を開始する。編集アクションを転送に差し替え、snapshot 受信で自窓を更新する。 */
export function createFollowerSync(store: StoreApi<AppState>, opts: FollowerOptions = {}): () => void {
  const ch = opts.channel ?? openSyncChannel();
  if (!ch) return () => {}; // 非対応環境: 同期無効
  const windowId = opts.windowId ?? MY_WINDOW_ID;
  const activePane = opts.activePane ?? (() => useUI.getState().activePane);

  let handledFocusSeq = -1;

  const post = (msg: SyncMessage) => ch.postMessage(msg);

  // 転送ラッパーを store のアクションへ被せる。分類に忠実に:
  //  forward → 転送、ensureView → 表示ローカル＋ ensureView 転送、leaderOnly → 拒否、local → 素通し。
  // reflect-only（S1 骨格）のときは被せない＝受信反映だけの読み取り窓として動く。
  if (!opts.readOnly) {
    installForwarding(store, {
      windowId,
      activePane,
      post,
      connected: () => useDualWindow.getState().connected,
    });
  }

  ch.onmessage = (msg) => {
    if (msg?.type === 'snapshot') {
      store.getState().applyRemoteSnapshot(msg.snapshot);
      if (!useDualWindow.getState().connected) useDualWindow.setState({ connected: true });
      // 発信元フォーカスヒント（作成→即リネーム等）の後処理。reflect-only では行わない。
      if (!opts.readOnly) {
        handleIncomingFocus(store, windowId, () => handledFocusSeq, (s) => (handledFocusSeq = s));
      }
    } else if (msg?.type === 'bye') {
      useDualWindow.setState({ connected: false }); // リーダー離脱＝接続待ち（編集ロック）
    }
  };

  post({ type: 'hello' }); // 接続時に現在状態を要求（最初の snapshot まで編集禁止）

  const onHide = () => post({ type: 'bye' });
  const wired = typeof window !== 'undefined';
  if (wired) window.addEventListener('pagehide', onHide);

  return () => {
    if (wired) window.removeEventListener('pagehide', onHide);
    ch.close();
  };
}

interface ForwardWiring {
  windowId: string;
  activePane: () => 'table' | 'flow';
  post: (msg: SyncMessage) => void;
  connected: () => boolean;
}

// forward/ensureView/leaderOnly のラッパーを一括で store.setState する。local は触らない。
export function installForwarding(store: StoreApi<AppState>, w: ForwardWiring): void {
  const state = store.getState() as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  const forward = (name: string, args: unknown[], focus?: FocusRequest) => {
    if (!w.connected()) {
      // 未接続（接続待ち）中は編集を捨てて案内する（データはリーダーが真実）。
      useUI.getState().toast('メインウィンドウとの接続を待っています…', 'info');
      return undefined;
    }
    w.post({ type: 'action', name, args, origin: w.windowId, focus });
    return undefined;
  };

  for (const name of Object.keys(state)) {
    if (typeof state[name] !== 'function') continue;
    const cls = classifyAction(name);
    if (cls === 'forward') {
      const intent = FOCUS_INTENT[name];
      patch[name] = (...args: unknown[]) =>
        forward(name, args, intent ? { intent, surface: w.activePane() } : undefined);
    } else if (cls === 'ensureView') {
      // setLevel/setScope: 表示状態はローカルに切替え、共有プロジェクトへはビュー保証だけ転送する。
      patch[name] = (...args: unknown[]) => applyEnsureViewLocally(store, w, name, args);
    } else if (cls === 'leaderOnly') {
      patch[name] = () => {
        useUI.getState().toast('この操作はメインウィンドウで行ってください。', 'info');
        return undefined;
      };
    }
    // local はそのまま（select/toggleIssues/wouldTidyFlow/applyRemoteSnapshot）。
  }
  store.setState(patch as Partial<AppState>);
}

// フォロワーの setLevel/setScope: 現在ビューの規約どおり level/scope を決めてローカルに反映し、
// リーダーへは冪等な ensureView(level,scope) だけ転送する（表示は窓ごと・プロジェクトは共有）。
function applyEnsureViewLocally(
  store: StoreApi<AppState>,
  w: ForwardWiring,
  name: string,
  args: unknown[],
): void {
  const cur = store.getState();
  let level = cur.level;
  let scope = cur.scopeParentId;
  if (name === 'setLevel') {
    const next = args[0] as AppState['level'];
    level = next;
    // 粒度を変えたら既定スコープ（全体）へ。同一粒度なら現在スコープを保つ（store.setLevel と同じ規約）。
    scope = next === cur.level ? cur.scopeParentId : undefined;
  } else {
    scope = args[0] as string | undefined;
  }
  if (w.connected()) w.post({ type: 'action', name: 'ensureView', args: [level, scope], origin: w.windowId });
  store.setState({ level, scopeParentId: scope });
}

// snapshot に載ってきた focusHint を、この窓が発信元なら 1 回だけ実行する。
function handleIncomingFocus(
  store: StoreApi<AppState>,
  windowId: string,
  getSeq: () => number,
  setSeq: (s: number) => void,
): void {
  const hint = store.getState().focusHint;
  if (!shouldHandleFocus(hint, windowId)) return;
  if (!hint || hint.seq <= getSeq()) return; // 同じ focusHint で二重発火しない
  setSeq(hint.seq);
  runFocusHint(hint);
}

/** focusHint の後処理（発信元の窓で実行）。rename=その場リネーム要求 / inspector=詳細を開く /
    select=選択のみ。rename の実体は FlowCanvas/TableView が useUI.renameRequest を購読して開く。 */
export function runFocusHint(hint: FocusHint): void {
  if (!hint.taskId) return;
  if (hint.intent === 'rename') {
    useUI.getState().requestRename(hint.taskId, hint.surface ?? 'flow');
  } else if (hint.intent === 'inspector') {
    useApp.getState().select(hint.taskId);
    useUI.getState().setInspectorOpen(true);
  } else if (hint.intent === 'select') {
    useApp.getState().select(hint.taskId);
  }
}

// ---------------------------------------------------------------------------
// 起動時の配線（main.tsx から呼ぶ）。role を確定し、リーダー/フォロワーそれぞれのランタイムを開始。
// ---------------------------------------------------------------------------
/** 通常窓（リーダー）として同期を開始。返り値でクリーンアップ。
    S1（骨格）: reflect-only＝配信のみ。フォロワーの編集転送の適用は S2 で有効化する。 */
export function startLeader(): () => void {
  useDualWindow.setState({ role: 'leader', connected: true });
  return createLeaderSync(useApp, { readOnly: true });
}

/** ?window=edit（フォロワー）として同期を開始。最初の snapshot まで connected=false（編集ロック）。
    S1（骨格）: reflect-only＝受信反映のみ。編集転送・focusHint は S2/S3 で有効化する。 */
export function startFollower(): () => void {
  useDualWindow.setState({ role: 'follower', connected: false });
  return createFollowerSync(useApp, { readOnly: true });
}
