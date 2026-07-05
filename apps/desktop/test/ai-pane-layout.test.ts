// AI パネル（batch）開時のペインレイアウト自動切替（E-01）。
//  - 開くと flow のみへ切替え、開く直前の状態を記憶する。
//  - 閉じると元へ戻す。ただし開いている間に手動でレイアウトを変えたら復元しない。
import { describe, it, expect } from 'vitest';
import {
  layoutOf,
  openAiFlowLayout,
  restoreAiLayout,
  type PaneLayoutUI,
  type PaneMode,
} from '../src/ui/aiPaneLayout';

/** useUI の該当部分を模した最小スタブ（setPaneLayout の規約を再現）。 */
function makeUI(init?: Partial<PaneLayoutUI>): PaneLayoutUI {
  const ui: PaneLayoutUI = {
    tableWide: false,
    flowWide: false,
    tableMode: 'outline',
    setPaneLayout(mode: PaneMode) {
      ui.tableWide = mode === 'table';
      ui.flowWide = mode === 'flow';
      // 分割/フローでは全項目表(full)は成立しないため outline へ戻す（useUI と同じ）。
      if (mode !== 'table' && ui.tableMode === 'full') ui.tableMode = 'outline';
    },
    setTableMode(mode) {
      ui.tableMode = mode;
    },
    ...init,
  };
  return ui;
}

describe('openAiFlowLayout / restoreAiLayout（E-01）', () => {
  it('分割から開くと flow へ切替え、閉じると分割へ戻す', () => {
    const ui = makeUI(); // split
    const snap = openAiFlowLayout(ui);
    expect(layoutOf(ui)).toBe('flow');
    expect(snap.layout).toBe('split');
    restoreAiLayout(ui, snap);
    expect(layoutOf(ui)).toBe('split');
  });

  it('工程表のみ（full）から開いても、閉じたら table + full を復元する', () => {
    const ui = makeUI({ tableWide: true, tableMode: 'full' }); // table + full
    const snap = openAiFlowLayout(ui);
    expect(layoutOf(ui)).toBe('flow');
    expect(ui.tableMode).toBe('outline'); // flow 切替で outline へ落ちる
    restoreAiLayout(ui, snap);
    expect(layoutOf(ui)).toBe('table');
    expect(ui.tableMode).toBe('full');
  });

  it('開いている間に手動でレイアウトを変えたら復元しない（ユーザー操作優先）', () => {
    const ui = makeUI(); // split
    const snap = openAiFlowLayout(ui); // flow
    ui.setPaneLayout('table'); // ユーザーが手動変更
    restoreAiLayout(ui, snap);
    expect(layoutOf(ui)).toBe('table'); // split へ戻さない
  });

  it('元から flow のときは開閉で何も変えない', () => {
    const ui = makeUI({ flowWide: true }); // flow
    const snap = openAiFlowLayout(ui);
    expect(snap.layout).toBe('flow');
    restoreAiLayout(ui, snap);
    expect(layoutOf(ui)).toBe('flow');
  });
});
