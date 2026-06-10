// autosave（クラッシュ復旧）のテスト。キーがプロジェクト ID ごとに分かれ、
// dirty→clean で消えるのは clean になったプロジェクトの分だけであることを確認する。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSampleProject, serializeProject } from '@gantt-flow/core';
import { initAutosave, loadAutosave, clearAutosave } from '../src/autosave';
import { useApp } from '../src/store';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

// node 環境には localStorage が無いため最小のメモリ実装を使う。
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

const entry = (at: number, json: string) => JSON.stringify({ at, json });

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('autosave（プロジェクト ID ごとの退避）', () => {
  it('dirty→clean で消えるのは clean になったプロジェクトの分だけ（他タブの分は残る）', () => {
    initAutosave();
    // 別タブが退避した別プロジェクト P2 のエントリ
    const p2 = createSampleProject(gen('p2'));
    localStorage.setItem(`gf-autosave-v1:${p2.meta.id}`, entry(123, serializeProject(p2)));

    // このタブ: P1 を未保存編集 → デバウンス退避
    const p1 = createSampleProject(gen('p1'));
    useApp.getState().restoreProject(p1); // dirty=true
    vi.advanceTimersByTime(1100);
    expect(localStorage.getItem(`gf-autosave-v1:${p1.meta.id}`)).toBeTruthy();

    // P1 の dirty が解消（保存・開く相当）→ P1 の分だけ消え、P2 の分は残る
    useApp.getState().loadProject(p1); // dirty=false
    expect(localStorage.getItem(`gf-autosave-v1:${p1.meta.id}`)).toBeNull();
    expect(localStorage.getItem(`gf-autosave-v1:${p2.meta.id}`)).toBeTruthy();
  });

  it('復元提案は最新のエントリを返し、破棄（clearAutosave 引数なし）はそのエントリだけ消す', () => {
    const pa = createSampleProject(gen('pa'));
    const pb = createSampleProject(gen('pb'));
    localStorage.setItem(`gf-autosave-v1:${pa.meta.id}`, entry(100, serializeProject(pa)));
    localStorage.setItem(`gf-autosave-v1:${pb.meta.id}`, entry(200, serializeProject(pb)));

    const offered = loadAutosave();
    expect(offered?.meta.id).toBe(pb.meta.id); // at が新しい方

    clearAutosave();
    expect(localStorage.getItem(`gf-autosave-v1:${pb.meta.id}`)).toBeNull();
    expect(localStorage.getItem(`gf-autosave-v1:${pa.meta.id}`)).toBeTruthy(); // 他は残る
  });

  it('旧形式（単一キー gf-autosave-v1）の復旧データも読める', () => {
    const p = createSampleProject(gen('legacy'));
    localStorage.setItem('gf-autosave-v1', serializeProject(p));
    expect(loadAutosave()?.meta.id).toBe(p.meta.id);
  });

  it('壊れたエントリ・空プロジェクトは復元対象にしない', () => {
    localStorage.setItem('gf-autosave-v1:broken', entry(999, '{not json'));
    expect(loadAutosave()).toBeNull();
  });
});
