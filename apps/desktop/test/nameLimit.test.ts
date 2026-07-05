// 工程名のソフト上限（B-15）。純粋な判定・クラス・title 生成を検証する
// （入力は拒否しない＝超過は警告のみ、という仕様を境界値で固定する）。
import { describe, it, expect } from 'vitest';
import {
  TASK_NAME_SOFT_LIMIT,
  isNameOverLimit,
  nameLenClass,
  nameLenTitle,
  NAME_OVERLONG_TITLE,
} from '../src/nameLimit';

describe('nameLimit（工程名のソフト上限）', () => {
  it('120字ちょうどは超過でない、121字で超過', () => {
    expect(TASK_NAME_SOFT_LIMIT).toBe(120);
    expect(isNameOverLimit('あ'.repeat(120))).toBe(false);
    expect(isNameOverLimit('あ'.repeat(121))).toBe(true);
  });

  it('空/未定義は超過でない', () => {
    expect(isNameOverLimit('')).toBe(false);
    expect(isNameOverLimit(undefined)).toBe(false);
    expect(isNameOverLimit(null)).toBe(false);
  });

  it('クラス/タイトルは超過時のみ付く（既存 className へ連結できる先頭スペース付き）', () => {
    expect(nameLenClass('short')).toBe('');
    expect(nameLenTitle('short')).toBeUndefined();
    const over = 'x'.repeat(121);
    expect(nameLenClass(over)).toBe(' name-overlong');
    expect(nameLenTitle(over)).toBe(NAME_OVERLONG_TITLE);
  });
});
