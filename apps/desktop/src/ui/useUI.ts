// UI 状態（ドメインストアとは別系統。undo/redo 履歴を汚さない）。
// テーマ＋自前ダイアログ（confirm/prompt）＋トースト＋表レイアウト（表を広く）。
import { create } from 'zustand';
import { loadSingleKeyEnabled, saveSingleKeyEnabled } from '../keymap';

type Id = string;

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'gf-theme';
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

// 工程表の任意列（前工程 / 工数 / I/O・課題）の表示トグル。既定は全て表示。
export interface ColumnVisibility {
  prev: boolean;
  effort: boolean;
  io: boolean;
}
const DEFAULT_COLUMNS: ColumnVisibility = { prev: true, effort: true, io: true };

function readInitialColumns(): ColumnVisibility {
  try {
    const saved = localStorage.getItem(COLS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<ColumnVisibility>;
      return {
        prev: parsed.prev ?? DEFAULT_COLUMNS.prev,
        effort: parsed.effort ?? DEFAULT_COLUMNS.effort,
        io: parsed.io ?? DEFAULT_COLUMNS.io,
      };
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

  /** 工程表に集中するため、フローを畳んで表を全幅にする。 */
  tableWide: boolean;
  toggleTableWide: () => void;

  /** フローに集中するため、表を畳んでフローを全幅にする（tableWide と排他）。 */
  flowWide: boolean;
  toggleFlowWide: () => void;

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

  /** 全画面オーバーレイ（ヘルプ / パレット / 課題一覧 / サマリ / バックアップ / 設定）。同時に 1 つだけ。 */
  overlay: 'help' | 'palette' | 'issues' | 'summary' | 'backups' | 'settings' | null;
  setOverlay: (overlay: 'help' | 'palette' | 'issues' | 'summary' | 'backups' | 'settings' | null) => void;

  /** 設定ダイアログのアクティブタブ（パレットからの深リンク用）。 */
  settingsTab: 'general' | 'keys' | 'data';
  setSettingsTab: (tab: 'general' | 'keys' | 'data') => void;

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
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  promptText: (opts: PromptOpts) => Promise<string | null>;
  /** Modal から確定/取消を返す。confirm は boolean、prompt は文字列(確定) or null(取消)。 */
  resolveDialog: (result: boolean | string | null) => void;

  toasts: ToastItem[];
  toast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
}

const initialTheme = readInitialTheme();
applyTheme(initialTheme); // モジュール読込時に即適用（描画前に反映）

let toastSeq = 0;

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

  tableWide: false,
  toggleTableWide: () =>
    set({ tableWide: !get().tableWide, flowWide: false, ...(get().tableWide ? {} : { activePane: 'table' as const }) }),

  flowWide: false,
  toggleFlowWide: () =>
    set({ flowWide: !get().flowWide, tableWide: false, ...(get().flowWide ? {} : { activePane: 'flow' as const }) }),

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
  confirm: (opts) =>
    new Promise<boolean>((resolve) => set({ dialog: { kind: 'confirm', resolve, ...opts } })),
  promptText: (opts) =>
    new Promise<string | null>((resolve) => set({ dialog: { kind: 'prompt', resolve, ...opts } })),
  resolveDialog: (result) => {
    const d = get().dialog;
    if (!d) return;
    set({ dialog: null });
    if (d.kind === 'confirm') d.resolve(result === true);
    else d.resolve(typeof result === 'string' ? result : null);
  },

  toasts: [],
  toast: (message, tone = 'info') => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, message, tone }] });
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
