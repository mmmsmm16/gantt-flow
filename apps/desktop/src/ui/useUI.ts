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
  { key: 'io', label: 'I/O・課題', width: 224 },
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
export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

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

  /** アウトライン表の折りたたみ状態（コマンド/非マウント時も保持するためここに置く。非永続）。 */
  outlineCollapsed: Set<Id>;
  toggleOutlineCollapsed: (id: Id) => void;
  setOutlineCollapsed: (ids: Set<Id>) => void;

  /** 使い方ツアーの現在ステップ（null=非表示）。 */
  tourStep: number | null;
  setTourStep: (step: number | null) => void;

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
  toast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
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
    // 無効化したら開いている比較オーバーレイを閉じる。
    set((s) => ({ tobeEnabled: enabled, overlay: !enabled && s.overlay === 'comparison' ? null : s.overlay }));
  },

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

  outlineCollapsed: new Set<Id>(),
  toggleOutlineCollapsed: (id) => {
    const next = new Set(get().outlineCollapsed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ outlineCollapsed: next });
  },
  setOutlineCollapsed: (ids) => set({ outlineCollapsed: ids }),

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
  toast: (message, tone = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, message, tone }] });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
