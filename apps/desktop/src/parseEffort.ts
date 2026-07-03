import { effortMinutesToHours } from '@gantt-flow/core';

// 工数欄（時間）の入力を分へ変換する共通ヘルパ。インスペクタ・全項目表・アウトラインの
// 工数 onBlur で共用する（ビューごとに素の Number()×60 を残すと、不正値の混入経路が復活する）。
// 空欄=undefined（解除）、数値でない/負/無限大=null（不正・棄却）。
// ×60 した後で有限性を見る（1e308 のような有限の入力も分換算で Infinity に溢れ、保存ファイルが壊れるため）。
export function parseEffortHoursToMinutes(raw: string): number | undefined | null {
  if (!raw.trim()) return undefined;
  const minutes = Math.round(Number(raw) * 60);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

export const EFFORT_RULE_MESSAGE = '工数は 0 以上の数値（時間）で入力してください';

// 工数入力の検証結果。ビュー側はこれで「値を残したまま不正表示し、commit だけブロック」を統一実装する。
// ok=true のとき minutes は確定値（空欄は undefined＝解除）。ok=false は不正値で commit しない。
export type EffortValidation =
  | { ok: true; minutes: number | undefined }
  | { ok: false; message: string };

export function validateEffort(raw: string): EffortValidation {
  const minutes = parseEffortHoursToMinutes(raw);
  if (minutes === null) return { ok: false, message: EFFORT_RULE_MESSAGE };
  return { ok: true, minutes };
}

// 工数セルを不正表示にする（値は残し、aria-invalid と .invalid を付与、title に理由）。
// 表・全項目表・インスペクタの3箇所で同じ挙動にするための共通ヘルパ。
export function markEffortInvalid(input: HTMLInputElement, message: string): void {
  input.setAttribute('aria-invalid', 'true');
  input.classList.add('invalid');
  input.title = message;
}

export function clearEffortInvalid(input: HTMLInputElement): void {
  input.removeAttribute('aria-invalid');
  input.classList.remove('invalid');
  input.title = '';
}

// 工数欄は表示時に分を 0.1h 丸めしている（effortMinutesToHours）。この丸め後の値を
// そのまま素の分と比較すると、無編集の blur でも端数がズレて書き換わってしまう
// （例: 100分 → 表示 1.7h → 再パースで 102 分。100 !== 102 で誤って上書きされる）。
// 「編集したか」は入力欄の生値（時間）と表示値（丸め後の時間）を同じ単位で比べて判定する。
export function isEffortBlurUnchanged(rawInput: string, storedMinutes: number | undefined): boolean {
  const trimmed = rawInput.trim();
  const inputHours = trimmed === '' ? undefined : Number(trimmed);
  const displayedHours = storedMinutes != null ? effortMinutesToHours(storedMinutes) : undefined;
  return inputHours === displayedHours;
}
