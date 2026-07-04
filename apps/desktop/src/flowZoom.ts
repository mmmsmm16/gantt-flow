// フローのズーム計算（純粋関数）。FlowCanvas から分離してユニットテスト可能にする。

/** ズーム倍率の有効範囲。3 桁丸めは % 表示と「同値なら補正スキップ」の比較を安定させるため。 */
export const clampScale = (s: number): number => Math.min(2.5, Math.max(0.4, +s.toFixed(3)));

/** フローのビューポート状態（倍率＋スクロール位置）。詳細パネルの開閉や表⇄フロー切替で
    FlowCanvas がアンマウントされても、この退避値から再マウント時に復元して 100%/(0,0) への
    リセットを防ぐ（#4）。モジュール変数に置く＝再レンダーを起こさない一時状態。 */
export interface FlowViewport {
  scale: number;
  left: number;
  top: number;
}
let savedViewport: FlowViewport | null = null;

/** 現在のビューポートを退避する（FlowCanvas のアンマウント時に呼ぶ）。 */
export function saveFlowViewport(v: FlowViewport): void {
  savedViewport = v;
}

/** 退避済みのビューポートを返す（無ければ null）。再マウント時の復元に使う。 */
export function loadFlowViewport(): FlowViewport | null {
  return savedViewport;
}

/** 退避値を破棄する（プロジェクト差し替え時など、以前の位置を持ち越したくないとき）。 */
export function clearFlowViewport(): void {
  savedViewport = null;
}

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
