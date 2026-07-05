// トーストのコアレス化（同一メッセージの回数畳み込み）と同時表示上限の検証。
// Ctrl+Z 連打などで同じメッセージが積み上がる・ミニマップを覆う問題への対処。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUI, TOAST_MAX_VISIBLE, TOAST_COALESCE_MS } from '../src/ui/useUI';

const toasts = () => useUI.getState().toasts;

beforeEach(() => {
  useUI.setState({ toasts: [] });
});

describe('トーストのコアレス化と上限', () => {
  it('直前と同一メッセージ・同一トーンは畳み込んで count を増やす（新規に積まない）', () => {
    const { toast } = useUI.getState();
    toast('元に戻しました: 工程を追加', 'info');
    toast('元に戻しました: 工程を追加', 'info');
    toast('元に戻しました: 工程を追加', 'info');
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.count).toBe(3);
  });

  it('メッセージが変われば別トーストとして積む', () => {
    const { toast } = useUI.getState();
    toast('A を削除しました', 'info');
    toast('B を削除しました', 'info');
    expect(toasts()).toHaveLength(2);
    expect(toasts().map((t) => t.count)).toEqual([1, 1]);
  });

  it('アクション付きトーストは畳み込まない（元に戻す等は個別に残す）', () => {
    const { toast } = useUI.getState();
    const action = { label: '元に戻す', run: () => {} };
    toast('削除しました', 'info', action);
    toast('削除しました', 'info', action);
    expect(toasts()).toHaveLength(2);
  });

  it('同時表示は上限（TOAST_MAX_VISIBLE）を超えず、古い方から捨てる', () => {
    const { toast } = useUI.getState();
    for (let i = 0; i < TOAST_MAX_VISIBLE + 2; i++) toast(`メッセージ ${i}`, 'info');
    expect(toasts()).toHaveLength(TOAST_MAX_VISIBLE);
    // 最新 TOAST_MAX_VISIBLE 件が残る（古い 0,1 が捨てられる）。
    expect(toasts()[0]!.message).toBe('メッセージ 2');
    expect(toasts().at(-1)!.message).toBe(`メッセージ ${TOAST_MAX_VISIBLE + 1}`);
  });

  it('時間窓を超えた同一メッセージは畳み込まず別トーストとして残す（回復後の再通知）', () => {
    vi.useFakeTimers();
    try {
      const { toast } = useUI.getState();
      toast('変更監視に失敗しました', 'info');
      vi.advanceTimersByTime(TOAST_COALESCE_MS + 500);
      toast('変更監視に失敗しました', 'info');
      expect(toasts()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
