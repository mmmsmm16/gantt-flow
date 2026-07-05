// ai/config.ts の単体テスト（レビュー指摘 Important #3・新設）。
// 最重要: API キーは「①セッションメモリ（既定）」「②persist=true のときだけ localStorage 平文」の
// 2箇所にしか存在してはいけない（config.ts 冒頭コメント参照）。ここでは setApiKey/getApiKey の
// 契約（persist の有無・メモリ優先・プロバイダ種別ごとの独立）をピンポイントで検証する。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getApiKey, setApiKey, KEY_PREFIX } from '../src/ai/config';

// node 環境用の localStorage シム（ai-provider.test.ts と同型）。
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

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('setApiKey / getApiKey', () => {
  it('persist=true は localStorage に平文保存する', () => {
    setApiKey('anthropic', 'PERSISTED-KEY', true);
    expect(localStorage.getItem(KEY_PREFIX + 'anthropic')).toBe('PERSISTED-KEY');
    expect(getApiKey('anthropic')).toBe('PERSISTED-KEY');
  });

  it('persist=false はメモリのみに保持し、既存の永続値があっても localStorage から削除する', () => {
    // まず「この PC に保存」で永続値を作っておく。
    setApiKey('anthropic', 'OLD-PERSISTED', true);
    expect(localStorage.getItem(KEY_PREFIX + 'anthropic')).toBe('OLD-PERSISTED');

    // persist=false に切り替えると、既存の永続値も消え、メモリだけが正になる。
    setApiKey('anthropic', 'MEM-ONLY', false);
    expect(localStorage.getItem(KEY_PREFIX + 'anthropic')).toBeNull();
    expect(getApiKey('anthropic')).toBe('MEM-ONLY');
  });

  it('getApiKey はセッションメモリを localStorage より優先する', () => {
    setApiKey('anthropic', 'FROM-MEMORY', false);
    // localStorage を直接書き換えても（想定外の食い違いを模す）、メモリの値が優先される。
    localStorage.setItem(KEY_PREFIX + 'anthropic', 'FROM-LS-DIRECT');
    expect(getApiKey('anthropic')).toBe('FROM-MEMORY');
  });

  it('プロバイダ種別（anthropic / azure-openai）ごとに独立して管理される', () => {
    setApiKey('anthropic', 'ANTHROPIC-KEY', true);
    setApiKey('azure-openai', 'AZURE-KEY', true);

    expect(getApiKey('anthropic')).toBe('ANTHROPIC-KEY');
    expect(getApiKey('azure-openai')).toBe('AZURE-KEY');
    expect(localStorage.getItem(KEY_PREFIX + 'anthropic')).toBe('ANTHROPIC-KEY');
    expect(localStorage.getItem(KEY_PREFIX + 'azure-openai')).toBe('AZURE-KEY');

    // 一方を persist=false に切り替えても、他方の永続値には影響しない。
    setApiKey('anthropic', 'ANTHROPIC-MEM-ONLY', false);
    expect(localStorage.getItem(KEY_PREFIX + 'anthropic')).toBeNull();
    expect(localStorage.getItem(KEY_PREFIX + 'azure-openai')).toBe('AZURE-KEY');
    expect(getApiKey('azure-openai')).toBe('AZURE-KEY');
  });
});
