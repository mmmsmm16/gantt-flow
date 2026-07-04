import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseMirrorParam,
  pickMirrorState,
  mirrorStateChanged,
  startMirrorPublisher,
  type MirrorChannel,
  type MirrorMessage,
  type MirrorSource,
  type MirrorState,
} from '../src/mirror';
import type { Project } from '@gantt-flow/core';

// 参照同一性だけを見るテストなので、実 Project は組まず軽量ダミーで代用する。
const proj = (tag: string) => ({ __tag: tag } as unknown as Project);
const st = (over: Partial<MirrorState> & { project: Project }): MirrorState => ({
  level: 'medium',
  scopeParentId: undefined,
  showIssues: true,
  ...over,
});

describe('mirror: parseMirrorParam', () => {
  it('flow / table のみ受け付け、それ以外・未指定は null', () => {
    expect(parseMirrorParam('?mirror=flow')).toBe('flow');
    expect(parseMirrorParam('?mirror=table')).toBe('table');
    expect(parseMirrorParam('?mirror=bogus')).toBeNull();
    expect(parseMirrorParam('?x=1')).toBeNull();
    expect(parseMirrorParam('')).toBeNull();
  });
});

describe('mirror: pickMirrorState', () => {
  it('発行対象の4フィールドだけを写し、project 参照は保つ', () => {
    const p = proj('a');
    const picked = pickMirrorState({
      project: p,
      level: 'small',
      scopeParentId: 'x',
      showIssues: false,
      // 余計なフィールドは無視される
      ...({ selectedTaskId: 'zzz' } as object),
    } as never);
    expect(picked).toEqual({ project: p, level: 'small', scopeParentId: 'x', showIssues: false });
    expect(picked.project).toBe(p);
  });
});

describe('mirror: mirrorStateChanged', () => {
  const p = proj('a');
  it('初回（前回なし）は常に変化あり', () => {
    expect(mirrorStateChanged(null, st({ project: p }))).toBe(true);
  });
  it('同一 project 参照＋同一ビュー設定なら変化なし', () => {
    const a = st({ project: p });
    expect(mirrorStateChanged(a, st({ project: p }))).toBe(false);
  });
  it('project 参照が変われば変化あり（不変更新で毎回新参照）', () => {
    expect(mirrorStateChanged(st({ project: p }), st({ project: proj('b') }))).toBe(true);
  });
  it('粒度・課題レイヤの変化を検知', () => {
    expect(mirrorStateChanged(st({ project: p }), st({ project: p, level: 'large' }))).toBe(true);
    expect(mirrorStateChanged(st({ project: p }), st({ project: p, showIssues: false }))).toBe(true);
  });
  it('scope は undefined 同士なら不変、値が変われば変化', () => {
    expect(mirrorStateChanged(st({ project: p }), st({ project: p }))).toBe(false);
    expect(mirrorStateChanged(st({ project: p }), st({ project: p, scopeParentId: 'g1' }))).toBe(true);
  });
});

// 発行元（store）の差し替え可能なスタブ。
function fakeSource(initial: MirrorState) {
  let state = initial;
  let listener: (() => void) | null = null;
  const source: MirrorSource = {
    subscribe: (l) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
    getState: () => state,
  };
  return {
    source,
    set: (s: MirrorState) => (state = s),
    fire: () => listener?.(),
    subscribed: () => listener !== null,
  };
}

function fakeChannel() {
  const sent: MirrorMessage[] = [];
  const ch: MirrorChannel = { postMessage: (m) => sent.push(m), onmessage: null, close: vi.fn() };
  return { ch, sent, emit: (m: MirrorMessage) => ch.onmessage?.(m) };
}

describe('mirror: startMirrorPublisher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('変化をデバウンスして最新スナップショット1件だけ流す（連続編集を束ねる）', () => {
    const src = fakeSource(st({ project: proj('a') }));
    const { ch, sent } = fakeChannel();
    startMirrorPublisher(src.source, { channel: ch, debounceMs: 100 });

    src.set(st({ project: proj('b') }));
    src.fire();
    src.set(st({ project: proj('c') }));
    src.fire();
    expect(sent).toHaveLength(0); // 猶予内はまだ流さない

    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'state' });
    expect((sent[0] as { state: MirrorState }).state.project).toBe(src.source.getState().project); // 最新(c)
  });

  it('基準確立後、同一状態の変化通知では再発行しない（選択/ホバー等を無視）', () => {
    const only = st({ project: proj('a') });
    const src = fakeSource(only);
    const { ch, sent } = fakeChannel();
    startMirrorPublisher(src.source, { channel: ch, debounceMs: 100 });
    src.fire(); // 初回＝基準確立
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1);
    src.fire(); // 状態は同一のまま（無関係な store 変化を模す）
    vi.advanceTimersByTime(100);
    expect(sent).toHaveLength(1); // 増えない
  });

  it('hello を受けたら現在状態で即応答（デバウンス無し）', () => {
    const src = fakeSource(st({ project: proj('a') }));
    const { ch, sent, emit } = fakeChannel();
    startMirrorPublisher(src.source, { channel: ch, debounceMs: 100 });
    emit({ type: 'hello' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'state' });
  });

  it('クリーンアップで購読解除＋チャネルを閉じる', () => {
    const src = fakeSource(st({ project: proj('a') }));
    const { ch } = fakeChannel();
    const stop = startMirrorPublisher(src.source, { channel: ch, debounceMs: 100 });
    expect(src.subscribed()).toBe(true);
    stop();
    expect(src.subscribed()).toBe(false);
    expect(ch.close).toHaveBeenCalledTimes(1);
  });
});
