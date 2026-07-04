import { effortMinutesToHours } from '@gantt-flow/core';

// 工数・リードタイム欄の入力を JS が Number() で解釈できる小数表記へ正規化する。
// type=number をやめて type=text + inputMode=decimal へ統一した副作用で、全角数字や
// カンマ小数がそのまま value に残るため、換算前にここで吸収する（#3: 「1,5」を黙殺して
// 「15」の10倍誤入力にしていた事故の解消）。全角数字→半角・全角ピリオド→'.'・カンマ→'.'。
export function normalizeEffortInput(raw: string): string {
  return raw
    .trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)) // 全角数字→半角
    .replace(/．/g, '.') // 全角ピリオド→小数点
    .replace(/[，,]/g, '.'); // 全角/半角カンマ→小数点（工数は千区切りを取らない）
}

// 工数欄（時間）の入力を分へ変換する共通ヘルパ。インスペクタ・全項目表・アウトラインの
// 工数 onBlur で共用する（ビューごとに素の Number()×60 を残すと、不正値の混入経路が復活する）。
// 空欄=undefined（解除）、数値でない/負/無限大=null（不正・棄却）。
// ×60 した後で有限性を見る（1e308 のような有限の入力も分換算で Infinity に溢れ、保存ファイルが壊れるため）。
export function parseEffortHoursToMinutes(raw: string): number | undefined | null {
  const norm = normalizeEffortInput(raw);
  if (!norm) return undefined;
  const minutes = Math.round(Number(norm) * 60);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}

// To-Be リードタイム欄（日）の入力を数値へ変換する共通ヘルパ。工数欄と同じ正規化
// （全角数字/全角ピリオド/カンマ小数の吸収）を通し、raw Number() での '1,5'→NaN 棄却を防ぐ。
// 空欄=undefined（解除）、数値でない/負/無限大=null（不正・棄却、呼び出し側は
// parseEffortHoursToMinutes と同じ流儀で `?? undefined` にして「解除」扱いへ寄せる）。
export function parseLtDaysInput(raw: string): number | undefined | null {
  const norm = normalizeEffortInput(raw);
  if (!norm) return undefined;
  const days = Number(norm);
  return Number.isFinite(days) && days >= 0 ? days : null;
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
  const norm = normalizeEffortInput(rawInput); // カンマ小数「1,5」も表示値と同単位で比較する
  const inputHours = norm === '' ? undefined : Number(norm);
  const displayedHours = storedMinutes != null ? effortMinutesToHours(storedMinutes) : undefined;
  return inputHours === displayedHours;
}
