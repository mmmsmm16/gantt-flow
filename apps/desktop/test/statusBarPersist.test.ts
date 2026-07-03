// StatusBar の永続化インジケータ（UX#9）の表示判定。描画から分離した純関数 persistIndicators を
// 直接検証する。新規（ロック/自動保存データ無し）では両インジケータとも出ない（＝StatusBar は
// 従来どおり描画される）、データが入れば「n秒前 / 失敗」「編集中ロック保持 / 読み取り専用」を出す。
import { describe, it, expect } from 'vitest';
import { persistIndicators, formatRelTime } from '../src/ui/StatusBar';

describe('persistIndicators（StatusBar の永続化表示判定）', () => {
  it('新規（自動保存/ロック情報なし）は両インジケータとも null（＝何も描かない）', () => {
    const r = persistIndicators(null, null, null);
    expect(r.autosave).toBeNull();
    expect(r.lock).toBeNull();
  });

  it('自動保存成功時刻は相対時刻、ロック保持は「編集中ロック保持」', () => {
    const now = 1_700_000_100_000;
    const r = persistIndicators(now - 30_000, null, 'holding', now);
    expect(r.autosave).toEqual({ text: '30秒前', failed: false });
    expect(r.lock).toEqual({ text: '編集中ロック保持', readonly: false });
  });

  it('保存系の失敗は「失敗」、ロック喪失は「読み取り専用」', () => {
    const r = persistIndicators(Date.now(), { kind: 'autosave' }, 'readonly');
    expect(r.autosave).toEqual({ text: '失敗', failed: true });
    expect(r.lock).toEqual({ text: '読み取り専用', readonly: true });
  });

  it('ロック更新失敗（kind=lock）は自動保存側を「失敗」にしない（時刻表示のまま）', () => {
    const now = 1_700_000_100_000;
    const r = persistIndicators(now - 5_000, { kind: 'lock' }, 'readonly', now);
    expect(r.autosave).toEqual({ text: '5秒前', failed: false });
    expect(r.lock?.readonly).toBe(true);
  });
});

describe('formatRelTime', () => {
  it('秒/分/時間の粒度で丸める', () => {
    const base = 1_000_000_000_000;
    expect(formatRelTime(base, base + 5_000)).toBe('5秒前');
    expect(formatRelTime(base, base + 90_000)).toBe('1分前');
    expect(formatRelTime(base, base + 3_600_000)).toBe('1時間前');
    expect(formatRelTime(base, base - 5_000)).toBe('0秒前'); // 未来はクランプ
  });
});
