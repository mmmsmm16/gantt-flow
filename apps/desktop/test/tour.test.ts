// 使い方ツアーの全導線化ロジック（UX#11）。DOM を持たない node 環境なので、
// 提示判定（純関数）・具体ハイライト対象の宣言・初回フラグ・保留フラグを検証する。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TOUR_STEPS, shouldStartTourOnFirstTask, tourDone } from '../src/ui/Tour';
import { useUI } from '../src/ui/useUI';

const DONE_KEY = 'gf-tour-done-v1';

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
  useUI.setState({ tourStep: null, tourPendingFirstTask: false });
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('shouldStartTourOnFirstTask（空スタート経路の提示判定）', () => {
  it('保留中かつ未完了のときだけ提示する', () => {
    expect(shouldStartTourOnFirstTask({ pending: true, done: false })).toBe(true);
    expect(shouldStartTourOnFirstTask({ pending: true, done: true })).toBe(false);
    expect(shouldStartTourOnFirstTask({ pending: false, done: false })).toBe(false);
    expect(shouldStartTourOnFirstTask({ pending: false, done: true })).toBe(false);
  });
});

describe('tourDone（初回フラグ・永続）', () => {
  it('未設定は false、完了マークで true', () => {
    expect(tourDone()).toBe(false);
    localStorage.setItem(DONE_KEY, '1');
    expect(tourDone()).toBe(true);
  });
  it('localStorage 不可なら true（毎回出さない）', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(tourDone()).toBe(true);
  });
});

describe('TOUR_STEPS（具体要素のハイライト対象）', () => {
  it('5 ステップで、作業系（1〜4）の先頭候補はペイン全体ではなく具体要素セレクタ', () => {
    expect(TOUR_STEPS).toHaveLength(5);
    // 先頭候補（実際に狙う対象）が具体要素であること（旧: ペイン全体は使わない）。
    const primaries = TOUR_STEPS.map((s) => s.selectors[0]);
    expect(primaries).toEqual([
      '.outline .name-input',
      '.node.task',
      '.flow-palette .add-task',
      '.toolbar [aria-label="コマンド・工程を検索"]',
      '.view-tabs button[title^="手順書"]',
    ]);
    // どの先頭候補も「ペインまるごと」ではない（フォールバックのペイン/ツールバー以外）。
    for (const p of primaries) {
      expect(['.table-pane', '.flow-pane', '.toolbar', '.view-tabs']).not.toContain(p);
    }
  });
  it('各ステップは不在時に落ちないようフォールバック候補を持つ', () => {
    for (const s of TOUR_STEPS) {
      expect(s.selectors.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('対象UI不在時の正直な文言（emptyBody）を作業系ステップ（1〜3）が持つ', () => {
    // 具体要素が実在しないことがある表(1)・フロー(2,3)には emptyBody を用意する。
    expect(TOUR_STEPS[0]?.emptyBody).toBeTruthy();
    expect(TOUR_STEPS[1]?.emptyBody).toBeTruthy();
    expect(TOUR_STEPS[2]?.emptyBody).toBeTruthy();
  });
});

describe('tourPendingFirstTask（保留フラグ）', () => {
  it('setTourPendingFirstTask で切り替わる', () => {
    expect(useUI.getState().tourPendingFirstTask).toBe(false);
    useUI.getState().setTourPendingFirstTask(true);
    expect(useUI.getState().tourPendingFirstTask).toBe(true);
    useUI.getState().setTourPendingFirstTask(false);
    expect(useUI.getState().tourPendingFirstTask).toBe(false);
  });
});
