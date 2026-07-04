// 永続化の沈黙する失敗の可視化（UX#9）。自動保存の書き込み失敗が握り潰されず、
// useUI の persistFailure＋トーストへ反映されること、成功で lastAutosaveAt が入ること、
// 同種の失敗はトーストを 1 回に抑える（リトライでスパムしない）ことを確認する。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSampleProject } from '@gantt-flow/core';
import { initAutosave } from '../src/autosave';
import { useApp } from '../src/store';
import { useUI } from '../src/ui/useUI';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

// メモリ実装。failAutosave=true のとき autosave キー(gf-autosave-v1:*)への setItem だけ
// 失敗させ、容量超過等を再現する。他キー(テーマ等)は素通しで壊さない。
class MemStorage {
  private m = new Map<string, string>();
  constructor(private readonly failAutosave = false) {}
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
    if (this.failAutosave && k.startsWith('gf-autosave-v1'))
      throw new DOMException('quota', 'QuotaExceededError');
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const errorToasts = () => useUI.getState().toasts.filter((t) => t.tone === 'error');

beforeEach(() => {
  vi.useFakeTimers();
  useUI.setState({ toasts: [], persistFailure: null, lastAutosaveAt: null, lockState: null });
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('自動保存の失敗可視化（UX#9）', () => {
  it('デバウンス書き込みが失敗したら persistFailure＋トースト（1回）が立つ', () => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemStorage(true);
    initAutosave();

    const p = createSampleProject(gen('fail'));
    useApp.getState().restoreProject(p); // dirty=true → デバウンス退避を予約
    vi.advanceTimersByTime(1100); // write() 実行 → setItem が throw

    expect(useUI.getState().persistFailure?.kind).toBe('autosave');
    expect(errorToasts()).toHaveLength(1);

    // 2 回目の失敗（別の未保存編集）ではトーストを増やさない（同種の連続＝スパム防止）。
    useApp.getState().addTask('もう一手');
    vi.advanceTimersByTime(1100);
    expect(errorToasts()).toHaveLength(1);
  });

  it('書き込み成功で lastAutosaveAt が入り、失敗表示は解除される', () => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
    // 先に失敗状態を作っておく（回復の確認用）。
    useUI.getState().notePersistFailure('autosave');
    expect(useUI.getState().persistFailure?.kind).toBe('autosave');

    initAutosave();
    const p = createSampleProject(gen('ok'));
    useApp.getState().restoreProject(p);
    vi.advanceTimersByTime(1100); // write() 成功 → notePersistOk('autosave')

    expect(useUI.getState().lastAutosaveAt).not.toBeNull();
    expect(useUI.getState().persistFailure).toBeNull();
  });
});

describe('notePersistFailure / notePersistOk（useUI スライス）', () => {
  it('同種の連続失敗はトースト1回、別種は追加、notePersistOk で回復', () => {
    useUI.setState({ toasts: [], persistFailure: null, lastAutosaveAt: null });
    useUI.getState().notePersistFailure('lock');
    useUI.getState().notePersistFailure('lock'); // 同種 → 増やさない
    expect(errorToasts()).toHaveLength(1);
    useUI.getState().notePersistFailure('backup'); // 別種 → 追加
    expect(errorToasts()).toHaveLength(2);
    expect(useUI.getState().persistFailure?.kind).toBe('backup');

    useUI.getState().notePersistOk('backup');
    expect(useUI.getState().persistFailure).toBeNull();
  });
});
