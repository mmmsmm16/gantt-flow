// UI 状態（ドメインストアとは別系統。undo/redo 履歴を汚さない）。
// テーマ＋自前ダイアログ（confirm/prompt）＋トースト＋表レイアウト（表を広く）。
import { create } from 'zustand';
import { loadSingleKeyEnabled, saveSingleKeyEnabled } from '../keymap';

type Id = string;

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'gf-theme';
const MINIMAP_KEY = 'gf-minimap';
const TOBE_KEY = 'gf-tobe';
const CHROME_KEY = 'gf-chrome-hidden';
const COLS_KEY = 'gf-columns';
const FT_COLS_KEY = 'gf-ft-columns';
const FT_W_KEY = 'gf-ft-widths';

// 全項目表の列表示（true=表示。キーが無ければ表示扱い）。localStorage 永続。
function readFtColumns(): Record<string, boolean> {
  try {
    const saved = localStorage.getItem(FT_COLS_KEY);
    if (saved) return JSON.parse(saved) as Record<string, boolean>;
  } catch {
    /* localStorage 不可/破損: 既定（全表示） */
  }
  return {};
}

// 全項目表の列幅の手動上書き（px）。未指定キーは既定幅。localStorage 永続。
function readFtWidths(): Record<string, number> {
  try {
    const saved = localStorage.getItem(FT_W_KEY);
    if (saved) return JSON.parse(saved) as Record<string, number>;
  } catch {
    /* 既定幅 */
  }
  return {};
}

// 工程表(アウトライン)の任意列の定義。この配列が唯一の定義元で、列カーソル・最小幅・
// ヘッダ行・列メニュー(以上 TableView)と、ここでの表示トグルの永続化すべてを駆動する。
// 列を増やすときはここに 1 エントリ追加し、TableView 側で本体の <td> を書くだけでよい。
export const OUTLINE_OPTIONAL_COLUMNS = [
  { key: 'prev', label: '前工程', width: 132 },
  { key: 'effort', label: '工数', width: 78 },
  { key: 'io', label: '入/出・課題', width: 224 },
] as const;
export type OutlineColumnKey = (typeof OUTLINE_OPTIONAL_COLUMNS)[number]['key'];

// 工程表の任意列（前工程 / 工数 / I/O・課題）の表示トグル。既定は全て表示。
export type ColumnVisibility = Record<OutlineColumnKey, boolean>;
const DEFAULT_COLUMNS = Object.fromEntries(
  OUTLINE_OPTIONAL_COLUMNS.map((c) => [c.key, true]),
) as ColumnVisibility;

function readInitialColumns(): ColumnVisibility {
  try {
    const saved = localStorage.getItem(COLS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<ColumnVisibility>;
      return Object.fromEntries(
        OUTLINE_OPTIONAL_COLUMNS.map((c) => [c.key, parsed[c.key] ?? DEFAULT_COLUMNS[c.key]]),
      ) as ColumnVisibility;
    }
  } catch {
    /* localStorage 不可/破損: 既定（全表示）にフォールバック */
  }
  return DEFAULT_COLUMNS;
}

function readInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* localStorage 不可: 既定にフォールバック */
  }
  if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'dark';
  }
  return 'light';
}

function applyTheme(theme: Theme): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme;
}

export type ToastTone = 'error' | 'info' | 'success';
/** トーストに 1 個だけ付けられる任意アクション（例: 出力後の「開いて確認」）。押すとトーストは閉じる。 */
export interface ToastAction {
  label: string;
  run: () => void;
}
export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

// トーストの自動消去までの時間(ms)。error はやや長め＝読み切る前に消えないよう猶予を足す。
export const TOAST_DURATION_MS: Record<ToastTone, number> = {
  info: 4200,
  success: 4200,
  error: 6000,
};

// hover で一時停止できるトースト用タイマー。DOM 非依存の純粋実装（vi.useFakeTimers で直接テスト可能）。
// pause: 残り時間を覚えて止める / resume: 残り時間から再開 / cancel: 二度と発火しない(アンマウント用)。
export interface PausableTimer {
  pause: () => void;
  resume: () => void;
  cancel: () => void;
}
export function createPausableTimer(ms: number, onDone: () => void): PausableTimer {
  let remaining = ms;
  let armedAt = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    armedAt = Date.now();
    handle = setTimeout(onDone, remaining);
  };
  arm();
  return {
    pause: () => {
      if (handle == null) return;
      clearTimeout(handle);
      handle = null;
      remaining = Math.max(0, remaining - (Date.now() - armedAt));
    },
    resume: () => {
      if (handle != null) return;
      arm();
    },
    cancel: () => {
      if (handle != null) clearTimeout(handle);
      handle = null;
    },
  };
}

// 永続化(自動保存/世代バックアップ/助言ロック)の健全性。沈黙する失敗を可視化するための共有状態。
export type PersistKind = 'autosave' | 'backup' | 'lock';
// 助言ロックの表示状態: holding=このセッションが編集ロックを保持 / readonly=取得できず読み取り専用。
export type LockUiState = 'holding' | 'readonly';
const PERSIST_FAIL_MESSAGE: Record<PersistKind, string> = {
  autosave: '自動保存に失敗しました（空き容量をご確認ください）。編集は続けられます。',
  backup: 'バックアップの保存に失敗しました（空き容量をご確認ください）。',
  lock: '編集ロックを更新できませんでした（別の場所で同時に開いていないかご確認ください）。',
};

export interface ConfirmOpts {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 情報表示モーダルとして使うとき、キャンセルボタンを隠す。 */
  hideCancel?: boolean;
}
export interface PromptOpts {
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export type Dialog =
  | ({ kind: 'confirm'; resolve: (ok: boolean) => void } & ConfirmOpts)
  | ({ kind: 'prompt'; resolve: (value: string | null) => void } & PromptOpts);

interface UIState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  /** いま開いている/保存先のファイル名（null=未割当: 新規/サンプル/テンプレート/取り込み）。
      正本は persistence のモジュール変数（React から購読できない）なので、
      保存/開く等の完了時に App がここへ写す。チップとウィンドウタイトルの購読元。 */
  fileName: string | null;
  setFileName: (name: string | null) => void;

  /** Welcome（工程 0 件のオンボーディング）をこのセッションで離れたか（非永続）。
      空の編集画面に到達した後、全工程を削除しても突然 Welcome へ戻さないためのフラグ。 */
  welcomeDismissed: boolean;
  setWelcomeDismissed: (dismissed: boolean) => void;

  /** 工程表に集中するため、フローを畳んで表を全幅にする。 */
  tableWide: boolean;
  toggleTableWide: () => void;

  /** フローに集中するため、表を畳んでフローを全幅にする（tableWide と排他）。 */
  flowWide: boolean;
  toggleFlowWide: () => void;

  /** 分割 / 工程表のみ / 工程フローのみ をタブで直接切替（tableWide・flowWide を一括設定）。 */
  setPaneLayout: (mode: 'split' | 'table' | 'flow') => void;

  /** 直交ビュー: 'work'=分割/表/フロー（既存 PaneLayoutTabs）、'procedure'=手順書タブ（全面）。
      分割/表/フローの外側にある全面ビューの切替。既定 'work'。undo 非対象・非永続（ビュー状態）。 */
  mainView: 'work' | 'procedure';
  setMainView: (v: 'work' | 'procedure') => void;
  /** 手順書タブが開く中工程（null=選択工程から導出）。ノードのクリックジャンプ・条件の飛び先・
      パンくずで中工程を切替えるときに使う。undo 非対象・非永続。 */
  procedureMidId: Id | null;
  setProcedureMidId: (id: Id | null) => void;

  /** 集中モード: 上部ツールバー＋各ビューのヘッダ・操作バーを隠して作業エリアを最大化。
      表示制御は App の .focus-mode クラス＋CSS で行う。localStorage 永続(既定 OFF=表示)。 */
  chromeHidden: boolean;
  toggleChrome: () => void;

  /** 工程表の表示モード: アウトライン（階層＋インスペクタ） / 全項目フル表（全列1グリッド）。 */
  tableMode: 'outline' | 'full';
  setTableMode: (mode: 'outline' | 'full') => void;

  /** いまキーボード操作の対象になっているペイン（単キーのルーティングに使う）。 */
  activePane: 'table' | 'flow';
  setActivePane: (pane: 'table' | 'flow') => void;

  /** g リーダーキー待機中（ステータスバーの表示用）。 */
  leaderPending: boolean;
  setLeaderPending: (pending: boolean) => void;

  /** シングルキー操作(Vim 風: j/k/hjkl/gリーダー等)が有効か。既定 OFF。設定で切替。 */
  singleKey: boolean;
  setSingleKey: (enabled: boolean) => void;

  /** As-Is/To-Be 比較機能（比較ボタン・To-Beタブ・シナリオ切替）が有効か。既定 OFF。設定で切替。 */
  tobeEnabled: boolean;
  setTobeEnabled: (enabled: boolean) => void;
  /** 改善効果サマリ（比較オーバーレイ）を開く。無効時は設定（general）を開き有効化を促す。
      ショートカット（⌘⇧C）とパレットの両方から呼ぶ共通導線。 */
  openComparison: () => void;

  /** メインのフロー表示シナリオ（As-Is=編集可 / To-Be=改善後を読み取り専用で投影）。ビュー状態。 */
  scenario: 'asis' | 'tobe';
  setScenario: (scenario: 'asis' | 'tobe') => void;

  /** 全項目表の列表示（true=表示。未指定キーは表示）。localStorage 永続。 */
  ftColumns: Record<string, boolean>;
  toggleFtColumn: (key: string) => void;

  /** 全項目表の列幅の手動上書き（px）。未指定キーは既定幅。localStorage 永続。 */
  ftColWidths: Record<string, number>;
  setFtColWidth: (key: string, width: number) => void;

  /** 工程表の任意列（前工程 / 工数 / I/O・課題）の表示トグル。localStorage 永続。 */
  columnVisibility: ColumnVisibility;
  toggleColumn: (key: keyof ColumnVisibility) => void;

  /** 設定インポート用の一括反映（列設定）。undefined のキーは変更しない。 */
  hydrateSettings: (p: {
    columns?: ColumnVisibility;
    ftColumns?: Record<string, boolean>;
    ftWidths?: Record<string, number>;
  }) => void;

  /** 全画面オーバーレイ（ヘルプ / パレット / 課題一覧 / サマリ / 比較 / バックアップ / 設定）。同時に 1 つだけ。 */
  overlay: 'help' | 'palette' | 'issues' | 'summary' | 'comparison' | 'backups' | 'settings' | null;
  setOverlay: (overlay: 'help' | 'palette' | 'issues' | 'summary' | 'comparison' | 'backups' | 'settings' | null) => void;

  /** 設定ダイアログのアクティブタブ（パレットからの深リンク用）。 */
  settingsTab: 'general' | 'keys' | 'data';
  setSettingsTab: (tab: 'general' | 'keys' | 'data') => void;

  /** フロー右下のミニマップを表示するか。localStorage 永続(既定 ON)。 */
  minimap: boolean;
  toggleMinimap: () => void;

  /** 詳細パネル(インスペクタ)を表示するか。「選択」とは独立(フローでは選択だけでは開かない)。 */
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;

  /** フローの I/O アイコン/チップをクリックしたとき、インスペクタの該当 I/O 項目まで
      スクロール＆フォーカスするためのシグナル（seq でトリガ）。null=非アクティブ。 */
  inspectorIoFocus: { io: 'inputs' | 'outputs'; ioId?: Id; seq: number } | null;
  focusInspectorIo: (io: 'inputs' | 'outputs', ioId?: Id) => void;

  /** 両窓編集同期: 作成した工程をその場リネームで開くよう、対象ペイン（表/フロー）へ依頼するシグナル。
      発信元の窓で focusHint を受けた dualwindow ランタイムが set し、TableView/FlowCanvas が購読して
      該当ノード/行の名前編集を開く（seq でトリガ）。null=非アクティブ。 */
  renameRequest: { taskId: Id; surface: 'table' | 'flow'; seq: number } | null;
  requestRename: (taskId: Id, surface: 'table' | 'flow') => void;

  /** アウトライン表の折りたたみ状態（コマンド/非マウント時も保持するためここに置く。非永続）。 */
  outlineCollapsed: Set<Id>;
  toggleOutlineCollapsed: (id: Id) => void;
  setOutlineCollapsed: (ids: Set<Id>) => void;

  /** アウトライン表のクイックフィルタ文字列。ビュー切替（表⇄フロー・粒度変更）で FlowCanvas/
      TableView が再マウントされても揮発しないよう、ローカル state ではなくここに置く（#26。非永続）。 */
  outlineFilter: string;
  setOutlineFilter: (query: string) => void;

  /** 表の複数選択（marked）を全体へミラーした工程 ID。コマンドパレットが「選択中の n 件に適用」を
      出すために購読する（正本は各表ビューの useRowMultiSelect。非永続）。 */
  markedTaskIds: Id[];
  setMarkedTaskIds: (ids: Id[]) => void;

  /** 使い方ツアーの現在ステップ（null=非表示）。 */
  tourStep: number | null;
  setTourStep: (step: number | null) => void;

  /** 空スタート経路で、最初の工程が作られたらツアーを提示するために保留中か（非永続）。
      サンプル/テンプレート/取り込みは即時開始するのでこのフラグは使わない。 */
  tourPendingFirstTask: boolean;
  setTourPendingFirstTask: (pending: boolean) => void;

  /** 重い処理中の全画面スピナー（メッセージ＝表示中）。取り込みなどで無応答に見えるのを防ぐ。 */
  busy: string | null;
  setBusy: (message: string | null) => void;

  dialog: Dialog | null;
  /** 表示待ちのダイアログ(FIFO)。表示中に confirm/promptText が呼ばれても押し退けず、
      先のダイアログが解決してから順に表示する(resolve を放置して await を永遠に待たせない)。 */
  dialogQueue: Dialog[];
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  promptText: (opts: PromptOpts) => Promise<string | null>;
  /** Modal から確定/取消を返す。confirm は boolean、prompt は文字列(確定) or null(取消)。 */
  resolveDialog: (result: boolean | string | null) => void;

  /** Esc の一元処理(useGlobalHotkeys)から呼ぶ: 最上位レイヤを 1 つだけ閉じる。
      レイヤ順は dialog > overlay > 一時 UI(ドロップダウン等)。閉じたら true。 */
  closeTopLayer: () => boolean;
  /** overlay 自身の Esc 処理を差し込む(パレットの引数モード→一覧 など)。
      closer が true を返すと消費扱いで overlay は閉じない。戻り値で解除。 */
  registerOverlayCloser: (closer: () => boolean) => () => void;
  /** Esc で閉じる一時 UI(メニュー等)を登録する(後から登録したものが最上位)。戻り値で解除。 */
  registerTransientLayer: (close: () => void) => () => void;
  /** 一時 UI(コンテキストメニュー/ドロップダウン)が開いているか。
      useGlobalHotkeys の停止判定用(メニュー操作中のグローバルキー暴発を防ぐ)。 */
  hasTransientLayer: () => boolean;

  toasts: ToastItem[];
  toast: (message: string, tone?: ToastTone, action?: ToastAction) => void;
  dismissToast: (id: number) => void;

  /** 直近の自動保存(localStorage への未保存退避)が成功した時刻(epoch ms)。null=まだ成功なし。 */
  lastAutosaveAt: number | null;
  /** 直近の永続化失敗(自動保存/バックアップ/ロック更新)。null=正常。StatusBar とトーストの元。 */
  persistFailure: { kind: PersistKind; at: number } | null;
  /** 助言ロックの表示状態(holding/readonly)。null=ファイル未割当(新規/取込/ブラウザ)。 */
  lockState: LockUiState | null;
  /** 永続化の成功を記録(autosave は時刻を更新、同種の失敗表示が残っていれば解除)。 */
  notePersistOk: (kind: PersistKind) => void;
  /** 永続化の失敗を記録。状態が変わったときだけトーストを1回出す(リトライ連打でスパムしない)。 */
  notePersistFailure: (kind: PersistKind) => void;
  /** 助言ロックの表示状態を反映する(persistence 層から呼ぶ)。 */
  setLockState: (state: LockUiState | null) => void;
}

const initialTheme = readInitialTheme();
applyTheme(initialTheme); // モジュール読込時に即適用（描画前に反映）

let toastSeq = 0;

// overlay の Esc を横取りするクローザと、Esc で閉じる一時 UI のスタック。
// ストア外に置く（関数の出し入れで再レンダリングを起こさないため）。
const overlayClosers: (() => boolean)[] = [];
const transientClosers: (() => void)[] = [];

export const useUI = create<UIState>((set, get) => ({
  theme: initialTheme,
  setTheme: (theme) => {
    applyTheme(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* 永続化失敗は無視（メモリ上は反映済み） */
    }
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  fileName: null,
  setFileName: (fileName) => set({ fileName }),

  welcomeDismissed: false,
  setWelcomeDismissed: (welcomeDismissed) => set({ welcomeDismissed }),

  tableWide: false,
  toggleTableWide: () =>
    set({ tableWide: !get().tableWide, flowWide: false, ...(get().tableWide ? {} : { activePane: 'table' as const }) }),

  flowWide: false,
  toggleFlowWide: () =>
    set({ flowWide: !get().flowWide, tableWide: false, ...(get().flowWide ? {} : { activePane: 'flow' as const }) }),

  setPaneLayout: (mode) =>
    set({
      tableWide: mode === 'table',
      flowWide: mode === 'flow',
      // 全項目表(full)はフローと併存できないため、分割/フロー選択時はアウトラインへ戻す。
      ...(mode !== 'table' && get().tableMode === 'full' ? { tableMode: 'outline' as const } : {}),
      ...(mode === 'table'
        ? { activePane: 'table' as const }
        : mode === 'flow'
          ? { activePane: 'flow' as const }
          : {}),
    }),

  mainView: 'work',
  setMainView: (mainView) => set({ mainView }),
  procedureMidId: null,
  setProcedureMidId: (procedureMidId) => set({ procedureMidId }),

  chromeHidden: (() => {
    try {
      return localStorage.getItem(CHROME_KEY) === '1';
    } catch {
      return false;
    }
  })(),
  toggleChrome: () => {
    const next = !get().chromeHidden;
    try {
      if (next) localStorage.setItem(CHROME_KEY, '1');
      else localStorage.removeItem(CHROME_KEY);
    } catch {
      /* 永続化失敗は無視 */
    }
    set({ chromeHidden: next });
  },

  tableMode: 'outline',
  setTableMode: (mode) => set({ tableMode: mode, ...(mode === 'full' ? { activePane: 'table' as const } : {}) }),

  activePane: 'table',
  setActivePane: (pane) => set({ activePane: pane }),

  leaderPending: false,
  setLeaderPending: (pending) => set({ leaderPending: pending }),

  singleKey: loadSingleKeyEnabled(),
  setSingleKey: (enabled) => {
    saveSingleKeyEnabled(enabled); // 永続化 + 実効キーマップのキャッシュ破棄
    set({ singleKey: enabled });
  },

  ftColumns: readFtColumns(),
  toggleFtColumn: (key) => {
    const cur = get().ftColumns;
    const next = { ...cur, [key]: cur[key] === false }; // 表示(≠false)→false、非表示→true
    try {
      localStorage.setItem(FT_COLS_KEY, JSON.stringify(next));
    } catch {
      /* 永続化失敗は無視 */
    }
    set({ ftColumns: next });
  },

  ftColWidths: readFtWidths(),
  setFtColWidth: (key, width) => {
    const next = { ...get().ftColWidths, [key]: Math.max(40, Math.round(width)) };
    try {
      localStorage.setItem(FT_W_KEY, JSON.stringify(next));
    } catch {
      /* 永続化失敗は無視 */
    }
    set({ ftColWidths: next });
  },

  overlay: null,
  setOverlay: (overlay) => set({ overlay }),

  settingsTab: 'general',
  setSettingsTab: (tab) => set({ settingsTab: tab }),

  tobeEnabled: (() => {
    try {
      return localStorage.getItem(TOBE_KEY) === '1';
    } catch {
      return false;
    }
  })(),
  setTobeEnabled: (enabled) => {
    try {
      if (enabled) localStorage.setItem(TOBE_KEY, '1');
      else localStorage.removeItem(TOBE_KEY);
    } catch {
      /* 永続化失敗は無視 */
    }
    // 無効化したら開いている比較オーバーレイを閉じ、シナリオを As-Is に戻す。
    set((s) => ({
      tobeEnabled: enabled,
      overlay: !enabled && s.overlay === 'comparison' ? null : s.overlay,
      scenario: enabled ? s.scenario : 'asis',
    }));
  },
  openComparison: () => {
    const s = get();
    if (s.tobeEnabled) {
      s.setOverlay('comparison');
      return;
    }
    // 未有効時は黙って何もしない代わりに、設定で有効化する導線を出す（発見性）。
    s.setSettingsTab('general');
    s.setOverlay('settings');
    s.toast('設定で As-Is / To-Be 比較を有効にしてください', 'info');
  },

  scenario: 'asis',
  setScenario: (scenario) => set({ scenario }),

  minimap: (() => {
    try {
      return localStorage.getItem(MINIMAP_KEY) !== '0';
    } catch {
      return true;
    }
  })(),
  toggleMinimap: () => {
    const next = !get().minimap;
    try {
      if (next) localStorage.removeItem(MINIMAP_KEY);
      else localStorage.setItem(MINIMAP_KEY, '0');
    } catch {
      /* 永続化失敗は無視 */
    }
    set({ minimap: next });
  },

  inspectorOpen: false,
  setInspectorOpen: (open) => set({ inspectorOpen: open }),

  inspectorIoFocus: null,
  focusInspectorIo: (io, ioId) =>
    set((s) => ({ inspectorIoFocus: { io, ioId, seq: (s.inspectorIoFocus?.seq ?? 0) + 1 } })),

  renameRequest: null,
  requestRename: (taskId, surface) =>
    set((s) => ({ renameRequest: { taskId, surface, seq: (s.renameRequest?.seq ?? 0) + 1 } })),

  outlineCollapsed: new Set<Id>(),
  toggleOutlineCollapsed: (id) => {
    const next = new Set(get().outlineCollapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ outlineCollapsed: next });
  },
  setOutlineCollapsed: (ids) => set({ outlineCollapsed: ids }),

  outlineFilter: '',
  setOutlineFilter: (outlineFilter) => set({ outlineFilter }),

  markedTaskIds: [],
  // 空→空の更新はスキップ（表マウント/アンマウントのたびに無用な再レンダーを起こさない）。
  setMarkedTaskIds: (ids) =>
    set((s) => (s.markedTaskIds.length === 0 && ids.length === 0 ? s : { markedTaskIds: ids })),

  columnVisibility: readInitialColumns(),
  toggleColumn: (key) => {
    const next = { ...get().columnVisibility, [key]: !get().columnVisibility[key] };
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(next));
    } catch {
      /* 永続化失敗は無視（メモリ上は反映済み） */
    }
    set({ columnVisibility: next });
  },

  hydrateSettings: (p) => {
    const patch: Record<string, unknown> = {};
    try {
      if (p.columns) {
        localStorage.setItem(COLS_KEY, JSON.stringify(p.columns));
        patch.columnVisibility = p.columns;
      }
      if (p.ftColumns) {
        localStorage.setItem(FT_COLS_KEY, JSON.stringify(p.ftColumns));
        patch.ftColumns = p.ftColumns;
      }
      if (p.ftWidths) {
        localStorage.setItem(FT_W_KEY, JSON.stringify(p.ftWidths));
        patch.ftColWidths = p.ftWidths;
      }
    } catch {
      /* 永続化失敗は無視（メモリ上は反映） */
    }
    if (Object.keys(patch).length) set(patch);
  },

  tourStep: null,
  setTourStep: (tourStep) => set({ tourStep }),

  tourPendingFirstTask: false,
  setTourPendingFirstTask: (tourPendingFirstTask) => set({ tourPendingFirstTask }),

  busy: null,
  setBusy: (busy) => set({ busy }),

  dialog: null,
  dialogQueue: [],
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      const d: Dialog = { kind: 'confirm', resolve, ...opts };
      if (get().dialog) set({ dialogQueue: [...get().dialogQueue, d] });
      else set({ dialog: d });
    }),
  promptText: (opts) =>
    new Promise<string | null>((resolve) => {
      const d: Dialog = { kind: 'prompt', resolve, ...opts };
      if (get().dialog) set({ dialogQueue: [...get().dialogQueue, d] });
      else set({ dialog: d });
    }),
  resolveDialog: (result) => {
    const d = get().dialog;
    if (!d) return;
    // 待ち行列の先頭を次に表示してから resolve する（解決後すぐ別ダイアログを
    // 開くコードが、最新の表示状態を見て正しく並べるように）。
    const [next, ...rest] = get().dialogQueue;
    set({ dialog: next ?? null, dialogQueue: rest });
    if (d.kind === 'confirm') d.resolve(result === true);
    else d.resolve(typeof result === 'string' ? result : null);
  },

  closeTopLayer: () => {
    const s = get();
    if (s.dialog) {
      s.resolveDialog(s.dialog.kind === 'confirm' ? false : null); // 取消として解決
      return true;
    }
    if (s.overlay) {
      const closer = overlayClosers[overlayClosers.length - 1];
      if (closer && closer()) return true; // overlay 側で消費（閉じない）
      set({ overlay: null });
      return true;
    }
    const transient = transientClosers[transientClosers.length - 1];
    if (transient) {
      transient();
      return true;
    }
    // 使い方ツアーは最下層のレイヤ。Esc で（今回だけ）閉じられるようにする。
    // ツアー中は blocked で全ショートカットが止まるため、Esc で抜けられないと
    // undo などが効かない。永続的な「表示しない」は 閉じる/完了 ボタン側に任せる。
    if (s.tourStep !== null) {
      s.setTourStep(null);
      return true;
    }
    return false;
  },
  registerOverlayCloser: (closer) => {
    overlayClosers.push(closer);
    return () => {
      const i = overlayClosers.lastIndexOf(closer);
      if (i >= 0) overlayClosers.splice(i, 1);
    };
  },
  registerTransientLayer: (close) => {
    transientClosers.push(close);
    return () => {
      const i = transientClosers.lastIndexOf(close);
      if (i >= 0) transientClosers.splice(i, 1);
    };
  },
  hasTransientLayer: () => transientClosers.length > 0,

  toasts: [],
  toast: (message, tone = 'info', action) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, message, tone, action }] });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  lastAutosaveAt: null,
  persistFailure: null,
  lockState: null,
  notePersistOk: (kind) =>
    set((s) => ({
      lastAutosaveAt: kind === 'autosave' ? Date.now() : s.lastAutosaveAt,
      // 同種の失敗表示が残っていれば「回復した」ものとして解除する。
      persistFailure: s.persistFailure?.kind === kind ? null : s.persistFailure,
    })),
  notePersistFailure: (kind) => {
    // 状態変化時のみ 1 回トースト(同種の連続失敗＝リトライではスパムしない)。
    if (get().persistFailure?.kind !== kind) get().toast(PERSIST_FAIL_MESSAGE[kind], 'error');
    set({ persistFailure: { kind, at: Date.now() } });
  },
  setLockState: (lockState) => set({ lockState }),
}));
