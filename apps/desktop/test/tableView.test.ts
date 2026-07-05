import { describe, it, expect } from 'vitest';
import { useUI, OUTLINE_OPTIONAL_COLUMNS, normalizeColumns } from '../src/ui/useUI';

// buildPrevCandidateIndex のテストは suggestions.test.ts へ移動
// （実装が suggestions.ts に移り、アウトライン/全項目表で共用になったため）。

describe('工程表の任意列: 記述子(OUTLINE_OPTIONAL_COLUMNS)と表示トグルの整合', () => {
  it('記述子は列(キー・ラベル・幅・順序)を保持する（状況が担当の隣＝先頭）', () => {
    expect(OUTLINE_OPTIONAL_COLUMNS.map((c) => [c.key, c.label, c.width])).toEqual([
      ['status', '状況', 104],
      ['prev', '前工程', 132],
      ['effort', '工数', 78],
      ['io', '入/出・課題', 224],
    ]);
  });

  it('columnVisibility は記述子のキーをすべて持ち、既定は全列表示', () => {
    const vis = useUI.getState().columnVisibility;
    expect(Object.keys(vis).sort()).toEqual(OUTLINE_OPTIONAL_COLUMNS.map((c) => c.key).slice().sort());
    for (const c of OUTLINE_OPTIONAL_COLUMNS) expect(vis[c.key]).toBe(true);
  });

  it('toggleColumn は記述子の全キーで切り替えられる', () => {
    for (const c of OUTLINE_OPTIONAL_COLUMNS) {
      const before = useUI.getState().columnVisibility[c.key];
      useUI.getState().toggleColumn(c.key);
      expect(useUI.getState().columnVisibility[c.key]).toBe(!before);
      useUI.getState().toggleColumn(c.key); // 元に戻す
      expect(useUI.getState().columnVisibility[c.key]).toBe(before);
    }
  });

  it('status キーの無い保存済み設定は status を既定(true)で補う（後方互換）', () => {
    // 状況列を追加する前に保存された設定を模した部分オブジェクト
    const legacy = { prev: true, effort: false, io: true };
    const norm = normalizeColumns(legacy);
    expect(norm.status).toBe(true); // 新列は既定表示へフォールバック
    expect(norm.effort).toBe(false); // 既存の指定は尊重
    expect(norm.prev).toBe(true);
    expect(norm.io).toBe(true);
    // 全キーが揃う（欠けキー無し）
    expect(Object.keys(norm).sort()).toEqual(OUTLINE_OPTIONAL_COLUMNS.map((c) => c.key).slice().sort());
  });
});
