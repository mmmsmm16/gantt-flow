// フロー図ドラッグ中のスナップ（吸着）計算。近くのノードと上端/中央（y）・左端/中央（x）が
// 揃う位置に吸着させ、揃った相手を示すガイド線の線分を返す。純関数（DOM 非依存・ユニットテスト可能）。
// 軸ごとに独立判定: y は「高さ（行）を揃える」、x は「横位置（列）を揃える」に対応する。
// 呼び出し側（FlowCanvas のドラッグ）は threshold を画面上の一定距離（SNAP_PX / scale）で渡す。

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapGuide {
  /** 'x'=縦線（x 位置で揃った）/ 'y'=横線（y 位置で揃った）。 */
  axis: 'x' | 'y';
  /** 線の位置（axis='x' なら x 座標、'y' なら y 座標）。 */
  pos: number;
  /** 線分の範囲（axis='x' なら y 範囲、'y' なら x 範囲）。揃った全ノードを端から端まで覆う。 */
  from: number;
  to: number;
}

/** 軸ごとの吸着候補。kind: 0=端（上端/左端）揃え、1=中央揃え（同差なら端を優先）。 */
interface AxisHit {
  /** 吸着後の moving の開始座標（上端/左端）。 */
  start: number;
  /** ガイド線の位置（端揃えなら端、中央揃えなら中央）。 */
  line: number;
  kind: 0 | 1;
  diff: number;
}

function pickAxis(
  start: number,
  size: number,
  others: SnapRect[],
  key: (o: SnapRect) => readonly [start: number, size: number],
  threshold: number,
): AxisHit | null {
  let best: AxisHit | null = null;
  for (const o of others) {
    const [os, osize] = key(o);
    const center = os + osize / 2;
    const cands: AxisHit[] = [
      { start: os, line: os, kind: 0, diff: Math.abs(start - os) },
      { start: center - size / 2, line: center, kind: 1, diff: Math.abs(start + size / 2 - center) },
    ];
    for (const c of cands) {
      if (c.diff > threshold) continue;
      // 最小 diff を採用。同差は端(kind 0) > 中央(kind 1)、それも同じなら先勝ち（決定論）。
      if (!best || c.diff < best.diff || (c.diff === best.diff && c.kind < best.kind)) best = c;
    }
  }
  return best;
}

/** hit と同じ揃え値（誤差 0.5px 以内）を持つノード＝ガイド線で結ぶ相手。 */
function membersOf(
  others: SnapRect[],
  hit: AxisHit,
  key: (o: SnapRect) => readonly [start: number, size: number],
): SnapRect[] {
  return others.filter((o) => {
    const [os, osize] = key(o);
    const v = hit.kind === 0 ? os : os + osize / 2;
    return Math.abs(v - hit.line) <= 0.5;
  });
}

/**
 * moving を others に吸着させた座標と、表示すべきガイド線を返す。
 * 吸着が無い軸は元の値のまま。others が空なら no-op。
 */
export function computeSnap(
  moving: SnapRect,
  others: SnapRect[],
  threshold: number,
): { x: number; y: number; guides: SnapGuide[] } {
  if (!others.length) return { x: moving.x, y: moving.y, guides: [] };
  const hx = pickAxis(moving.x, moving.w, others, (o) => [o.x, o.w] as const, threshold);
  const hy = pickAxis(moving.y, moving.h, others, (o) => [o.y, o.h] as const, threshold);
  const x = hx ? hx.start : moving.x;
  const y = hy ? hy.start : moving.y;
  const snapped: SnapRect = { x, y, w: moving.w, h: moving.h };

  const guides: SnapGuide[] = [];
  if (hx) {
    const rects = [...membersOf(others, hx, (o) => [o.x, o.w] as const), snapped];
    guides.push({
      axis: 'x',
      pos: hx.line,
      from: Math.min(...rects.map((r) => r.y)),
      to: Math.max(...rects.map((r) => r.y + r.h)),
    });
  }
  if (hy) {
    const rects = [...membersOf(others, hy, (o) => [o.y, o.h] as const), snapped];
    guides.push({
      axis: 'y',
      pos: hy.line,
      from: Math.min(...rects.map((r) => r.x)),
      to: Math.max(...rects.map((r) => r.x + r.w)),
    });
  }
  return { x, y, guides };
}
