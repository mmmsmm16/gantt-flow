// 改善効果サマリ（As-Is / To-Be 比較）の共通導線 openComparison（C-13）。
// ⌘⇧C ショートカットとパレット「改善効果サマリを開く」の両方から呼ばれる分岐を検証する。
import { describe, it, expect, beforeEach } from 'vitest';
import { useUI } from '../src/ui/useUI';

beforeEach(() => {
  useUI.setState({ tobeEnabled: false, overlay: null, settingsTab: 'general', toasts: [] });
});

describe('openComparison（改善効果サマリの導線）', () => {
  it('有効時は比較オーバーレイを開く（トーストは出さない）', () => {
    useUI.setState({ tobeEnabled: true });
    useUI.getState().openComparison();
    expect(useUI.getState().overlay).toBe('comparison');
    expect(useUI.getState().toasts).toHaveLength(0);
  });

  it('無効時は設定(general)を開き、info トーストで有効化を促す', () => {
    useUI.getState().openComparison();
    expect(useUI.getState().overlay).toBe('settings');
    expect(useUI.getState().settingsTab).toBe('general');
    const ts = useUI.getState().toasts;
    expect(ts).toHaveLength(1);
    expect(ts[0]?.tone).toBe('info');
    expect(ts[0]?.message).toContain('比較を有効に');
  });
});
