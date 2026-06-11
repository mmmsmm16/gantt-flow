// 工数欄の入力ガード。1e308 のような「有限だが ×60 で溢れる」値が Infinity として
// 保存され、JSON では null になってファイルが開けなくなる事故を防ぐ。
import { describe, it, expect } from 'vitest';
import { parseEffortHoursToMinutes } from '../src/parseEffort';

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
