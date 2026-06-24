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
