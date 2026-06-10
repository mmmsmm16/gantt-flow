import { describe, it, expect } from 'vitest';
import { parseSettingsFile, SETTINGS_VERSION, type SettingsFile } from '../src/settings';

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
