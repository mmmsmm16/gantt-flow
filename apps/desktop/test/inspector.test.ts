// 工数欄の入力ガード。1e308 のような「有限だが ×60 で溢れる」値が Infinity として
// 保存され、JSON では null になってファイルが開けなくなる事故を防ぐ。
import { describe, it, expect } from 'vitest';
import { parseEffortHoursToMinutes, parseLtDaysInput, validateEffort, validateLtDays, EFFORT_RULE_MESSAGE, LT_RULE_MESSAGE, isEffortBlurUnchanged, normalizeEffortInput } from '../src/parseEffort';
import { effortMinutesToHours } from '@gantt-flow/core';

// #3 工数入力の統一（type=number → type=text）。カンマ小数「1,5」を黙殺せず 1.5h として扱う
// （number 型では value からカンマが消えて「15」の10倍誤入力になっていた回帰を防ぐ）。
describe('normalizeEffortInput（全角・カンマを JS が解釈できる小数へ）', () => {
  it('カンマ小数を小数点へ（1,5 → 1.5・全角カンマも）', () => {
    expect(normalizeEffortInput('1,5')).toBe('1.5');
    expect(normalizeEffortInput('2，5')).toBe('2.5');
  });
  it('全角数字・全角ピリオドを半角へ（１．５ → 1.5）', () => {
    expect(normalizeEffortInput('１．５')).toBe('1.5');
    expect(normalizeEffortInput('３')).toBe('3');
  });
  it('前後の空白を除去する', () => {
    expect(normalizeEffortInput('  2 ')).toBe('2');
    expect(normalizeEffortInput('')).toBe('');
  });
});

describe('parseEffortHoursToMinutes: カンマ小数を10倍誤入力にしない（#3）', () => {
  it("'1,5' は 90 分（1.5h）として扱う（従来は NaN で棄却→打ち直し）", () => {
    expect(parseEffortHoursToMinutes('1,5')).toBe(90);
  });
  it('全角「１．５」も 90 分・全角カンマ「２，５」は 150 分', () => {
    expect(parseEffortHoursToMinutes('１．５')).toBe(90);
    expect(parseEffortHoursToMinutes('２，５')).toBe(150);
  });
  it('無編集判定もカンマ表記を吸収する（1,5 と保存90分は同値＝書き換えない）', () => {
    expect(isEffortBlurUnchanged('1,5', 90)).toBe(true);
  });
});

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

// To-Be リードタイム欄（日）も工数欄と同じ正規化を通す。raw Number() のままだと
// カンマ小数「1,5」が NaN になり黙殺されていた（工数欄と同じ #3 系の回帰）。
describe('parseLtDaysInput: リードタイムも工数欄と同じ正規化に統一', () => {
  it("カンマ小数'1,5'は1.5日として扱う（従来は NaN で棄却）", () => {
    expect(parseLtDaysInput('1,5')).toBe(1.5);
  });
  it('全角「２，５」も 2.5・全角ピリオド「１．５」は 1.5', () => {
    expect(parseLtDaysInput('２，５')).toBe(2.5);
    expect(parseLtDaysInput('１．５')).toBe(1.5);
  });
  it('空欄（空白のみ含む）は undefined＝解除', () => {
    expect(parseLtDaysInput('')).toBeUndefined();
    expect(parseLtDaysInput('   ')).toBeUndefined();
  });
  it('通常の値はそのまま日数として扱う', () => {
    expect(parseLtDaysInput('2')).toBe(2);
    expect(parseLtDaysInput('0.5')).toBe(0.5);
    expect(parseLtDaysInput('0')).toBe(0);
  });
  it('数値でない・負の値・Infinity は null＝棄却', () => {
    expect(parseLtDaysInput('abc')).toBeNull();
    expect(parseLtDaysInput('-1')).toBeNull();
    expect(parseLtDaysInput('1e999')).toBeNull();
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
    // '2時間' は比較ダイアログ一括入力で無言の「解除」になり既存 To-Be を消していた入力（B-05）。
    for (const bad of ['abc', '2時間', '-1', '1e308']) {
      expect(validateEffort(bad)).toEqual({ ok: false, message: EFFORT_RULE_MESSAGE });
    }
  });
});

// リードタイム欄の非破壊バリデーション（工数欄の validateEffort と対）。比較ダイアログの
// 一括入力セルで「不正値（『2時間』等）は commit せず赤リング＋入力値保持」を統一するためのラッパ。
// 旧実装は parseLtDaysInput(...) ?? undefined で不正入力を無言の「解除」にし既存 To-Be 値を消していた。
describe('validateLtDays', () => {
  it('有効値は ok=true と確定日数を返す（空欄は解除＝undefined）', () => {
    expect(validateLtDays('2')).toEqual({ ok: true, days: 2 });
    expect(validateLtDays('0.5')).toEqual({ ok: true, days: 0.5 });
    expect(validateLtDays('0')).toEqual({ ok: true, days: 0 });
    expect(validateLtDays('')).toEqual({ ok: true, days: undefined });
  });

  it('カンマ小数・全角も工数欄と同じ正規化を通す（1,5 → 1.5 日）', () => {
    expect(validateLtDays('1,5')).toEqual({ ok: true, days: 1.5 });
    expect(validateLtDays('２，５')).toEqual({ ok: true, days: 2.5 });
  });

  it('不正値（数値でない・負・Infinity）は ok=false と理由を返す（値は破棄しない）', () => {
    for (const bad of ['abc', '2時間', '-1', '1e999']) {
      expect(validateLtDays(bad)).toEqual({ ok: false, message: LT_RULE_MESSAGE });
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
