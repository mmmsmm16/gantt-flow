// フロー図のキーボード空間ナビゲーション(矢印キーで「隣のノード」へ選択を移す)。
// 表の ↑↓(行選択移動)と対になる操作。純関数(DOM 非依存・ユニットテスト可能)。
export interface NavRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NavDir = 'left' | 'right' | 'up' | 'down';

/**
 * cur から見て dir 方向にある最も近いノードの id を返す(無ければ null)。
 * スコア = 方向の距離 + 直交方向のずれ×2(まっすぐ先にあるものを優先)。
 */
export function nearestInDirection(cur: NavRect, candidates: NavRect[], dir: NavDir): string | null {
  const cx = cur.x + cur.w / 2;
  const cy = cur.y + cur.h / 2;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (c.id === cur.id) continue;
    const dx = c.x + c.w / 2 - cx;
    const dy = c.y + c.h / 2 - cy;
    let main: number;
    let cross: number;
    if (dir === 'right') {
      main = dx;
      cross = Math.abs(dy);
    } else if (dir === 'left') {
      main = -dx;
      cross = Math.abs(dy);
    } else if (dir === 'down') {
      main = dy;
      cross = Math.abs(dx);
    } else {
      main = -dy;
      cross = Math.abs(dx);
    }
    if (main <= 0) continue; // その方向に無い
    const score = main + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = c.id;
    }
  }
  return best;
}

/**
 * 整列ジャンプ: dir 方向にある「次の揃え位置」までの移動量を返す(無ければ null)。
 * 左右 = 他ノードの左端 x のうち、現在より手前/先の最近値へ x をジャンプ(y は不変)。
 * 上下 = 他ノードの中央 y のうち、最近の行へ y をジャンプ(x は不変)。
 * nearestInDirection(最近傍ノードへの選択移動)と違い軸の値だけを見る。最近傍ノードの
 * 座標へそのまま重ねると隣のノードに重なるため、「列・行の値の集合」へ段階的に揃える。
 */
export function alignTarget(
  cur: NavRect,
  candidates: NavRect[],
  dir: NavDir,
): { dx: number; dy: number } | null {
  const EPS = 0.5; // 既に揃っている値はスキップ(浮動小数の誤差は同値とみなす)
  if (dir === 'left' || dir === 'right') {
    const xs = candidates.filter((c) => c.id !== cur.id).map((c) => c.x);
    const next =
      dir === 'left'
        ? Math.max(...xs.filter((x) => x < cur.x - EPS), -Infinity)
        : Math.min(...xs.filter((x) => x > cur.x + EPS), Infinity);
    return Number.isFinite(next) ? { dx: next - cur.x, dy: 0 } : null;
  }
  const cy = cur.y + cur.h / 2;
  const cys = candidates.filter((c) => c.id !== cur.id).map((c) => c.y + c.h / 2);
  const next =
    dir === 'up'
      ? Math.max(...cys.filter((y) => y < cy - EPS), -Infinity)
      : Math.min(...cys.filter((y) => y > cy + EPS), Infinity);
  return Number.isFinite(next) ? { dx: 0, dy: next - cy } : null;
}

/** 視覚順(上→下、同じ高さなら左→右)で最初のノード。未選択時の開始点に使う。 */
export function firstVisual(candidates: NavRect[]): string | null {
  let best: NavRect | null = null;
  for (const c of candidates) {
    if (!best || c.y < best.y - 1 || (Math.abs(c.y - best.y) <= 1 && c.x < best.x)) best = c;
  }
  return best?.id ?? null;
}
