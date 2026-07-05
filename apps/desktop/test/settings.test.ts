import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSettingsFile, collectSettings, SETTINGS_VERSION, type SettingsFile } from '../src/settings';

// node 環境には localStorage が無いため最小のメモリ実装を使う（他テストと同じ流儀）。
class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const valid: SettingsFile = {
  app: 'gantt-flow',
  kind: 'settings',
  version: SETTINGS_VERSION,
  theme: 'dark',
  singleKey: true,
  keybindings: { 'row-add': { key: 'a' }, 'undo-u': null },
  columns: { prev: true, effort: false, io: true },
  ftColumns: { note: false },
  ftWidths: { how: 240 },
};

describe('settings: parseSettingsFile', () => {
  it('正しいファイルはそのまま読める(round-trip)', () => {
    const r = parseSettingsFile(JSON.stringify(valid));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    expect(r.settings.theme).toBe('dark');
    expect(r.settings.singleKey).toBe(true);
    expect(r.settings.keybindings).toEqual(valid.keybindings);
    expect(r.settings.columns).toEqual(valid.columns);
    expect(r.settings.ftWidths).toEqual({ how: 240 });
  });

  it('壊れた JSON / マーカー無しは拒否', () => {
    expect(parseSettingsFile('{ not json').ok).toBe(false);
    expect(parseSettingsFile(JSON.stringify({ version: 1 })).ok).toBe(false);
    expect(parseSettingsFile(JSON.stringify({ app: 'other', kind: 'settings', version: 1 })).ok).toBe(false);
  });

  it('より新しいバージョンは拒否(前方互換の安全側)', () => {
    const r = parseSettingsFile(JSON.stringify({ ...valid, version: SETTINGS_VERSION + 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('新しいバージョン');
  });

  it('不明キーは無視し、型不正のキーはそのキーだけ読み飛ばして warnings に積む', () => {
    const r = parseSettingsFile(
      JSON.stringify({
        ...valid,
        futureFeature: { foo: 1 }, // 不明キー → 無視
        theme: 'sepia', // 不正 → 読み飛ばし
        singleKey: 'yes', // 不正 → 読み飛ばし
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.settings.theme).toBeUndefined();
    expect(r.settings.singleKey).toBeUndefined();
    expect(r.settings.keybindings).toEqual(valid.keybindings); // 正しい部分は生きる
    expect(r.warnings.length).toBe(2);
  });

  it('キーバインド: 不正な chord は件数つきで読み飛ばし、null(無効化)と未知 id は通す', () => {
    const r = parseSettingsFile(
      JSON.stringify({
        app: 'gantt-flow',
        kind: 'settings',
        version: 1,
        keybindings: {
          'row-add': { key: 'a', mod: true },
          'future-binding': { key: 'x' }, // 未知 id → 通す(将来バージョン相互運用)
          'undo-u': null, // 無効化 → 通す
          broken1: { mod: true }, // key も code も無い → 読み飛ばし
          broken2: 'j', // 形式不正 → 読み飛ばし
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.settings.keybindings!)).toEqual(['row-add', 'future-binding', 'undo-u']);
    expect(r.warnings[0]).toContain('2 件');
  });
});

// セキュリティ規律: AI の API キーが設定エクスポート（SettingsFile）に混入しないこと。
describe('settings: AI キー不混入（セキュリティ）', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('gf-ai-key-* を localStorage に入れても collectSettings の出力にキー文字列が現れない', () => {
    // 「この PC に保存」チェック時に置かれる平文キー（本来はここだけに存在する）。
    localStorage.setItem('gf-ai-key-anthropic', 'sk-ant-SECRETKEY-0123456789');
    localStorage.setItem('gf-ai-key-azure-openai', 'AZURE-SECRET-9999');
    localStorage.setItem('gf-ai-provider', 'anthropic');
    localStorage.setItem('gf-ai-model', 'claude-opus-4-8');

    const file = collectSettings();
    const json = JSON.stringify(file);

    // SettingsFile にキー項目そのものが無い（型 unchanged）。
    expect(Object.keys(file)).not.toContain('apiKey');
    expect(Object.keys(file)).not.toContain('aiKey');
    // JSON 化してもキー文字列が一切現れない。
    expect(json).not.toContain('sk-ant-');
    expect(json).not.toContain('SECRETKEY');
    expect(json).not.toContain('AZURE-SECRET');
    expect(json).not.toContain('gf-ai-key-');
  });
});
