import { describe, it, expect } from 'vitest';
import { createHistory } from '../src/history/history';

describe('history（スナップショット Undo/Redo）', () => {
  it('push / undo / redo の基本', () => {
    const h = createHistory(0);
    h.push(1);
    h.push(2);
    expect(h.current()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeUndefined(); // これ以上戻れない
    expect(h.redo()).toBe(1);
    expect(h.current()).toBe(1);
  });

  it('新規 push で redo 側は破棄される', () => {
    const h = createHistory('a');
    h.push('b');
    h.push('c');
    h.undo(); // -> b
    h.push('d'); // redo(c) は捨てられる
    expect(h.current()).toBe('d');
    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBeUndefined();
  });

  it('replaceTop は直近を置換（サイズ不変＝コアレッシング）', () => {
    const h = createHistory(0);
    h.push(1);
    const sizeBefore = h.size();
    h.replaceTop(11);
    h.replaceTop(12);
    expect(h.size()).toBe(sizeBefore);
    expect(h.current()).toBe(12);
    expect(h.undo()).toBe(0); // 1/11/12 は 1 エントリに束ねられている
  });

  it('limit を超えると古い方から破棄され、最新が残る', () => {
    const h = createHistory(0, { limit: 3 });
    h.push(1);
    h.push(2);
    h.push(3); // [1,2,3]（0 は破棄）
    expect(h.size()).toBe(3);
    expect(h.current()).toBe(3);
    // 3 回 undo しても limit ぶんしか戻れない
    expect(h.undo()).toBe(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBeUndefined();
  });

  it('canUndo / canRedo', () => {
    const h = createHistory(0);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    h.push(1);
    expect(h.canUndo()).toBe(true);
    h.undo();
    expect(h.canRedo()).toBe(true);
  });

  it('reset で履歴を破棄して 1 エントリにする', () => {
    const h = createHistory(0);
    h.push(1);
    h.push(2);
    h.reset(99);
    expect(h.current()).toBe(99);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
    expect(h.size()).toBe(1);
  });
});
