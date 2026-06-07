// UI 状態（ドメインストアとは別系統。undo/redo 履歴を汚さない）。
// テーマ＋自前ダイアログ（confirm/prompt）＋トースト＋表レイアウト（表を広く）。
import { create } from 'zustand';

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'gf-theme';
const COLS_KEY = 'gf-columns';

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

  /** 工程表の任意列（前工程 / 工数 / I/O・課題）の表示トグル。localStorage 永続。 */
  columnVisibility: ColumnVisibility;
  toggleColumn: (key: keyof ColumnVisibility) => void;

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
  toggleTableWide: () => set({ tableWide: !get().tableWide }),

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
