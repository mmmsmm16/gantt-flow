// 工数欄の入力ガード。1e308 のような「有限だが ×60 で溢れる」値が Infinity として
// 保存され、JSON では null になってファイルが開けなくなる事故を防ぐ。
import { describe, it, expect } from 'vitest';
import { parseEffortHoursToMinutes, validateEffort, EFFORT_RULE_MESSAGE, isEffortBlurUnchanged } from '../src/parseEffort';
import { effortMinutesToHours } from '@gantt-flow/core';

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

// 工数欄は表示時に分を 0.1h 丸めする（effortMinutesToHours）。素の分同士で無編集判定すると
// 端数がズレて誤って書き換わる回帰を防ぐ（render→blur ラウンドトリップ）。
describe('isEffortBlurUnchanged（render→blur ラウンドトリップ）', () => {
  it('保存値100分は表示上1.7hに丸まる。無編集で blur しても書き換わらない', () => {
    const storedMinutes = 100;
    // 描画時: Inspector/FullTable/TableView は defaultValue={effortMinutesToHours(d.effortMinutes)} を出す。
    const displayed = effortMinutesToHours(storedMinutes);
    expect(displayed).toBe(1.7);
    // 無編集で blur すると入力欄の値は描画時の文字列のまま。
    const rawOnBlur = String(displayed);
    expect(isEffortBlurUnchanged(rawOnBlur, storedMinutes)).toBe(true);
    // 素の分に戻すと 102 になり、100 とズレる＝ガードが無いと誤って書き換わっていた箇所。
    expect(validateEffort(rawOnBlur)).toEqual({ ok: true, minutes: 102 });
  });

  it('表示値と異なる値へ実際に編集した場合は「変更あり」と判定する', () => {
    expect(isEffortBlurUnchanged('2', 100)).toBe(false);
    expect(isEffortBlurUnchanged('', 100)).toBe(false);
  });

  it('未保存（空欄）から空欄のまま blur は無編集', () => {
    expect(isEffortBlurUnchanged('', undefined)).toBe(true);
    expect(isEffortBlurUnchanged('  ', undefined)).toBe(true);
  });
});
