// 工数欄（時間）の入力を分へ変換する共通ヘルパ。インスペクタ・全項目表・アウトラインの
// 工数 onBlur で共用する（ビューごとに素の Number()×60 を残すと、不正値の混入経路が復活する）。
// 空欄=undefined（解除）、数値でない/負/無限大=null（不正・棄却）。
// ×60 した後で有限性を見る（1e308 のような有限の入力も分換算で Infinity に溢れ、保存ファイルが壊れるため）。
export function parseEffortHoursToMinutes(raw: string): number | undefined | null {
  if (!raw.trim()) return undefined;
  const minutes = Math.round(Number(raw) * 60);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
}
