// 設定ファイル(エクスポート/インポート)。テーマ・シングルキー操作・キーバインド上書き・
// 表の列設定を 1 つの JSON で持ち運ぶ(別 PC への引き継ぎ・チーム内共有)。
// parseSettingsFile は副作用ゼロの純関数(vitest は node 環境のためここだけでテストする)。
// 検証ポリシー: マーカー必須 / 上位バージョンは拒否 / 不明キーは無視 /
// 型不正のキーはそのキーだけ読み飛ばして warnings に積む(全部は捨てない)。
import { useUI, type Theme, type ColumnVisibility } from './ui/useUI';
import { loadOverrides, saveOverrides, type Chord, type KeymapOverrides } from './keymap';

export const SETTINGS_VERSION = 1;

// ⚠️ セキュリティ規律: この SettingsFile（エクスポート/インポート）には **AI の API キーを
// 一切含めない**。キーの存在場所は `ai/config.ts` のセッションメモリと `gf-ai-key-*` localStorage
// だけで、collectSettings() の出力にも Project にも入れない（test/settings.test.ts で固定）。
export interface SettingsFile {
  app: 'gantt-flow';
  kind: 'settings';
  version: number;
  theme?: Theme;
  singleKey?: boolean;
  keybindings?: KeymapOverrides;
  columns?: Partial<ColumnVisibility>; // 旧バージョンの設定は後から追加した列（status 等）を欠く
  ftColumns?: Record<string, boolean>;
  ftWidths?: Record<string, number>;
}

export type ParseResult =
  | { ok: true; settings: Partial<SettingsFile>; warnings: string[] }
  | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Chord 形({key?, code?, mod?, alt?, shift?})か。余計なキーは許容(将来互換)。
function isChord(v: unknown): v is Chord {
  if (!isObj(v)) return false;
  if (v.key !== undefined && typeof v.key !== 'string') return false;
  if (v.code !== undefined && typeof v.code !== 'string') return false;
  for (const f of ['mod', 'alt', 'shift']) {
    if (v[f] !== undefined && typeof v[f] !== 'boolean') return false;
  }
  return v.key !== undefined || v.code !== undefined;
}

export function parseSettingsFile(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSON として読めませんでした。' };
  }
  if (!isObj(raw) || raw.app !== 'gantt-flow' || raw.kind !== 'settings') {
    return { ok: false, error: 'gantt-flow の設定ファイルではありません。' };
  }
  if (typeof raw.version !== 'number' || raw.version < 1) {
    return { ok: false, error: '設定ファイルのバージョンが不正です。' };
  }
  if (raw.version > SETTINGS_VERSION) {
    return { ok: false, error: 'より新しいバージョンの設定ファイルです（アプリを更新してください）。' };
  }

  const warnings: string[] = [];
  const out: Partial<SettingsFile> = {};

  if (raw.theme !== undefined) {
    if (raw.theme === 'light' || raw.theme === 'dark') out.theme = raw.theme;
    else warnings.push('テーマの値が不正のため読み飛ばしました。');
  }
  if (raw.singleKey !== undefined) {
    if (typeof raw.singleKey === 'boolean') out.singleKey = raw.singleKey;
    else warnings.push('シングルキー設定の値が不正のため読み飛ばしました。');
  }
  if (raw.keybindings !== undefined) {
    if (isObj(raw.keybindings)) {
      const kb: KeymapOverrides = {};
      let dropped = 0;
      for (const [id, v] of Object.entries(raw.keybindings)) {
        if (v === null || isChord(v)) kb[id] = v as Chord | null;
        else dropped += 1;
      }
      out.keybindings = kb; // 未知の binding id は通す(resolveKeymap は defaults 起点なので無害)
      if (dropped) warnings.push(`キーバインド ${dropped} 件が不正な形式のため読み飛ばしました。`);
    } else {
      warnings.push('キーバインド設定が不正のため読み飛ばしました。');
    }
  }
  if (raw.columns !== undefined) {
    if (
      isObj(raw.columns) &&
      ['prev', 'effort', 'io'].every((k) => typeof (raw.columns as Record<string, unknown>)[k] === 'boolean')
    ) {
      out.columns = raw.columns as unknown as Partial<ColumnVisibility>;
    } else warnings.push('列設定(工程表)が不正のため読み飛ばしました。');
  }
  if (raw.ftColumns !== undefined) {
    if (isObj(raw.ftColumns) && Object.values(raw.ftColumns).every((v) => typeof v === 'boolean')) {
      out.ftColumns = raw.ftColumns as Record<string, boolean>;
    } else warnings.push('列設定(全項目表)が不正のため読み飛ばしました。');
  }
  if (raw.ftWidths !== undefined) {
    if (isObj(raw.ftWidths) && Object.values(raw.ftWidths).every((v) => typeof v === 'number')) {
      out.ftWidths = raw.ftWidths as Record<string, number>;
    } else warnings.push('列幅設定が不正のため読み飛ばしました。');
  }
  return { ok: true, settings: out, warnings };
}

/** 現在の設定を 1 つのオブジェクトに集める(エクスポート用)。 */
export function collectSettings(): SettingsFile {
  const ui = useUI.getState();
  return {
    app: 'gantt-flow',
    kind: 'settings',
    version: SETTINGS_VERSION,
    theme: ui.theme,
    singleKey: ui.singleKey,
    keybindings: loadOverrides(),
    columns: ui.columnVisibility,
    ftColumns: ui.ftColumns,
    ftWidths: ui.ftColWidths,
  };
}

/** 取り込んだ設定を適用する。必ず setter 経由(画面へ即時反映+永続化)。 */
export function applySettings(s: Partial<SettingsFile>): void {
  const ui = useUI.getState();
  if (s.theme !== undefined) ui.setTheme(s.theme);
  if (s.singleKey !== undefined) ui.setSingleKey(s.singleKey);
  if (s.keybindings !== undefined) saveOverrides(s.keybindings);
  ui.hydrateSettings({ columns: s.columns, ftColumns: s.ftColumns, ftWidths: s.ftWidths });
}
