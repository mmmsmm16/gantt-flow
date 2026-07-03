// トーストの hover 一時停止（UX16位以下）。DOM 非依存の純粋実装 createPausableTimer を
// vi.useFakeTimers で直接検証する（ToastView 側は配線のみなので、ここが実質のテスト対象）。
// あわせて tone 別の既定時間（error はやや長め）も確認する。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPausableTimer, TOAST_DURATION_MS } from '../src/ui/useUI';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPausableTimer（トーストの hover 一時停止）', () => {
  it('一時停止しなければ満了時に onDone を1回呼ぶ', () => {
    const onDone = vi.fn();
    createPausableTimer(1000, onDone);
    vi.advanceTimersByTime(999);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('pause 中は経過せず、resume すると残り時間から再開する', () => {
    const onDone = vi.fn();
    const timer = createPausableTimer(1000, onDone);
    vi.advanceTimersByTime(400); // 残り600
    timer.pause();
    vi.advanceTimersByTime(5000); // 停止中はどれだけ待っても発火しない
    expect(onDone).not.toHaveBeenCalled();
    timer.resume();
    vi.advanceTimersByTime(599);
    expect(onDone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('pause の多重呼び出し・未武装での resume は無害（二重計上しない）', () => {
    const onDone = vi.fn();
    const timer = createPausableTimer(1000, onDone);
    timer.pause();
    timer.pause(); // 既に停止中 → 何もしない
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
    timer.resume();
    timer.resume(); // 既に稼働中 → 再武装しない
    vi.advanceTimersByTime(1000);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('cancel すると二度と発火しない（アンマウント用）', () => {
    const onDone = vi.fn();
    const timer = createPausableTimer(1000, onDone);
    timer.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('TOAST_DURATION_MS（tone 別の既定表示時間）', () => {
  it('error は info/success よりやや長い（読み切る前に消えない猶予）', () => {
    expect(TOAST_DURATION_MS.error).toBeGreaterThan(TOAST_DURATION_MS.info);
    expect(TOAST_DURATION_MS.info).toBe(TOAST_DURATION_MS.success);
  });
});
