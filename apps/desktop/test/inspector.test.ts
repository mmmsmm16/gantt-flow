// 工数欄の入力ガード。1e308 のような「有限だが ×60 で溢れる」値が Infinity として
// 保存され、JSON では null になってファイルが開けなくなる事故を防ぐ。
import { describe, it, expect } from 'vitest';
import { parseEffortHoursToMinutes, validateEffort, EFFORT_RULE_MESSAGE } from '../src/parseEffort';

describe('parseEffortHoursToMinutes', () => {
  it('空欄（空白のみ含む）は undefined＝解除', () => {
    expect(parseEffortHoursToMinutes('')).toBeUndefined();
    expect(parseEffortHoursToMinutes('   ')).toBeUndefined();
  });

  it('通常の値は分へ換算（0.5 時間=30 分）', () => {
    expect(parseEffortHoursToMinutes('2')).toBe(120);
    expect(parseEffortHoursToMinutes('0.5')).toBe(30);
    expect(parseEffortHoursToMinutes('0')).toBe(0);
  });

  it('数値でない・負の値は null＝棄却', () => {
    expect(parseEffortHoursToMinutes('abc')).toBeNull();
    expect(parseEffortHoursToMinutes('-1')).toBeNull();
  });

  it('Infinity になる値は null＝棄却（1e999 はもちろん、×60 で溢れる 1e308 も）', () => {
    expect(parseEffortHoursToMinutes('1e999')).toBeNull();
    expect(parseEffortHoursToMinutes('1e308')).toBeNull();
  });
});

// 非破壊バリデーション用ラッパ。ビューは {ok, minutes}/{ok:false, message} で
// 「値を残したまま不正表示し commit だけブロック」を統一実装する。
describe('validateEffort', () => {
  it('有効値は ok=true と確定分を返す（空欄は解除＝undefined）', () => {
    expect(validateEffort('2')).toEqual({ ok: true, minutes: 120 });
    expect(validateEffort('0')).toEqual({ ok: true, minutes: 0 });
    expect(validateEffort('')).toEqual({ ok: true, minutes: undefined });
  });

  it('不正値は ok=false と理由メッセージを返す（値は破棄しない＝呼び出し側で残す）', () => {
    for (const bad of ['abc', '-1', '1e308']) {
      expect(validateEffort(bad)).toEqual({ ok: false, message: EFFORT_RULE_MESSAGE });
    }
  });
});
