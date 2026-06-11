import { describe, it, expect } from 'vitest';
import { useUI, OUTLINE_OPTIONAL_COLUMNS } from '../src/ui/useUI';

// buildPrevCandidateIndex のテストは suggestions.test.ts へ移動
// （実装が suggestions.ts に移り、アウトライン/全項目表で共用になったため）。

describe('工程表の任意列: 記述子(OUTLINE_OPTIONAL_COLUMNS)と表示トグルの整合', () => {
  it('記述子は従来の列(キー・ラベル・幅・順序)をそのまま保持している', () => {
    expect(OUTLINE_OPTIONAL_COLUMNS.map((c) => [c.key, c.label, c.width])).toEqual([
      ['prev', '前工程', 132],
      ['effort', '工数', 78],
      ['io', 'I/O・課題', 224],
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
});
