// フローのズーム計算（純粋関数）。FlowCanvas から分離してユニットテスト可能にする。

/** ズーム倍率の有効範囲。3 桁丸めは % 表示と「同値なら補正スキップ」の比較を安定させるため。 */
export const clampScale = (s: number): number => Math.min(2.5, Math.max(0.4, +s.toFixed(3)));

/** アンカー付きズームのスクロール補正。アンカー（ビューポート内オフセット）直下の論理座標が
    ズーム前後で同じ画面位置に来る scrollLeft/Top を返す。負はブラウザの clamp と同じく 0 に丸める
    （rAF 適用時点の実 DOM に依存しない決定論的な値にする）。 */
export function zoomScroll(
  scroll: { left: number; top: number },
  anchor: { x: number; y: number },
  prevScale: number,
  nextScale: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, ((scroll.left + anchor.x) / prevScale) * nextScale - anchor.x),
    top: Math.max(0, ((scroll.top + anchor.y) / prevScale) * nextScale - anchor.y),
  };
}
