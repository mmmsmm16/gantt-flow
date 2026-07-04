import { describe, it, expect } from 'vitest';
import { routeEdge, type Rect, type Pt } from '../src/sync/edgeRoute';

const R = (x: number, y: number, w = 120, h = 44): Rect => ({ x, y, w, h });

// 経路が矩形(余白なしの本体)を横切っていないことの検証ヘルパ
function passesThrough(points: Pt[], o: Rect): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (a.y === b.y) {
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      if (a.y > o.y && a.y < o.y + o.h && hi > o.x && lo < o.x + o.w) return true;
    } else {
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      if (a.x > o.x && a.x < o.x + o.w && hi > o.y && lo < o.y + o.h) return true;
    }
  }
  return false;
}

describe('routeEdge: 直角経路のノード回避', () => {
  it('同一行・障害物なしは直線(2点)', () => {
    const r = routeEdge(R(0, 100), R(300, 100), []);
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toEqual({ x: 120, y: 122 });
    expect(r.points[1]).toEqual({ x: 300, y: 122 });
  });

  it('障害物なしの段違いは HVH(4点)・縦はターゲット手前の共通入口レーン(x2-STUB)で曲がる', () => {
    const r = routeEdge(R(0, 0), R(400, 200), []);
    expect(r.points).toHaveLength(4);
    expect(r.points[1]!.x).toBe(384); // entryX = x2(400) - STUB(16) ＝ 同じ工程に入る矢印で揃う位置
    expect(r.d.startsWith('M120,22')).toBe(true);
  });

  it('同じ工程へ入る複数の矢印は同じ x(共通入口レーン)で曲がる', () => {
    // 別々の高さ・別々の出発点から同一ターゲットへ入る 2 本。曲がる縦の x が一致すること。
    const target = R(400, 100);
    const a = routeEdge(R(0, 0), target, []); // 上から
    const b = routeEdge(R(0, 200), target, []); // 下から
    const bendX = (pts: Pt[]) => pts[pts.length - 2]!.x; // 終端の直前＝左辺へ入る縦の x
    expect(bendX(a.points)).toBe(bendX(b.points));
    expect(bendX(a.points)).toBe(400 - 16); // entryX
  });

  it('既定の縦通り道が障害物に当たるときは midX をずらして回避する', () => {
    // 中央(midX=260)に障害物 → 左右どちらかへ避ける
    const obstacle = R(200, 80);
    const r = routeEdge(R(0, 0), R(400, 200), [obstacle]);
    expect(passesThrough(r.points, obstacle)).toBe(false);
    expect(r.points).toHaveLength(4); // HVH のまま避けられる
  });

  it('横セグメントが障害物の行を貫くときは迂回(HVHVH)で避ける', () => {
    // 同一行で目的地までの間にノードが居座る → 上下に迂回するしかない
    const obstacle = R(200, 100);
    const r = routeEdge(R(0, 100), R(400, 100), [obstacle]);
    expect(passesThrough(r.points, obstacle)).toBe(false);
    expect(r.points.length).toBeGreaterThan(4); // 迂回形
  });

  it('複数障害物でも交差最小の経路を選ぶ(全回避できれば交差ゼロ)', () => {
    const obstacles = [R(200, 60), R(200, 160), R(320, 110)];
    const r = routeEdge(R(0, 0), R(500, 220), obstacles);
    for (const o of obstacles) {
      expect(passesThrough(r.points, o)).toBe(false);
    }
  });

  it('障害物が縦に連続していても、隙間や全体の上下の通り道で全回避する', () => {
    // 行を塞ぐ A の直下に B が連続（A 直下のチャネルは B 内）。さらに横にもう一つ。
    // 旧来の「障害物端±2PAD」だけでは抜け道が塞がれがちなケース。
    const A = R(200, 100);
    const B = R(200, 150);
    const C = R(360, 100);
    const r = routeEdge(R(0, 100), R(560, 100), [A, B, C]);
    for (const o of [A, B, C]) expect(passesThrough(r.points, o)).toBe(false);
  });

  it('後ろ向き(ターゲットが左)は左辺から出て相手の右辺へ入る', () => {
    // 相手が左＝左辺から出て、ターゲットの右辺へ入る(矢じりは左を向く)。従来の「右辺から U 字」ではない。
    const r = routeEdge(R(400, 0), R(0, 200), []);
    expect(r.points.length).toBeGreaterThanOrEqual(4);
    expect(r.points[0]).toEqual({ x: 400, y: 22 }); // ソース左辺中央
    expect(r.points[r.points.length - 1]).toEqual({ x: 120, y: 222 }); // ターゲット右辺中央(0+120)
  });

  it('ラベル位置は経路の中央セグメントの中点', () => {
    const r = routeEdge(R(0, 0), R(400, 200), []);
    expect(r.label).toEqual({ x: 384, y: 122 }); // 縦セグメント(x=entryX=384)の中点
  });
});

describe('routeEdge: 相対位置による出入り辺の自動選択(4方位)', () => {
  // 相手のいる辺から出て、相手の対辺へ入る。marker は orient=auto なので最終セグメントの向きに
  // 矢じりが揃う(下の相手には下辺から出て上辺へ＝矢じりは下向きに刺さる)。すべて決定論。
  it('右の相手 → 右辺から出て左辺へ入る(直線)', () => {
    const r = routeEdge(R(0, 0), R(400, 0), []);
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toEqual({ x: 120, y: 22 }); // ソース右辺中央
    expect(r.points[1]).toEqual({ x: 400, y: 22 }); // ターゲット左辺中央
  });

  it('左の相手 → 左辺から出て右辺へ入る(直線・矢じりは左向き)', () => {
    const r = routeEdge(R(400, 0), R(0, 0), []);
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toEqual({ x: 400, y: 22 }); // ソース左辺中央
    expect(r.points[1]).toEqual({ x: 120, y: 22 }); // ターゲット右辺中央(0+120)
    expect(r.points[1]!.x).toBeLessThan(r.points[0]!.x); // 最終セグメントは左向き
  });

  it('真下の相手 → 下辺から出て上辺へ入る(直線・矢じりは下向き)', () => {
    const r = routeEdge(R(0, 0), R(0, 200), []);
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toEqual({ x: 60, y: 44 }); // ソース下辺中央(0+120/2, 0+44)
    expect(r.points[1]).toEqual({ x: 60, y: 200 }); // ターゲット上辺中央
    expect(r.points[1]!.y).toBeGreaterThan(r.points[0]!.y); // 下向き
  });

  it('真上の相手 → 上辺から出て下辺へ入る(直線・矢じりは上向き)', () => {
    const r = routeEdge(R(0, 200), R(0, 0), []);
    expect(r.points).toHaveLength(2);
    expect(r.points[0]).toEqual({ x: 60, y: 200 }); // ソース上辺中央
    expect(r.points[1]).toEqual({ x: 60, y: 44 }); // ターゲット下辺中央(0+44)
    expect(r.points[1]!.y).toBeLessThan(r.points[0]!.y); // 上向き
  });

  it('主軸(水平/垂直)の優勢で辺が切り替わる', () => {
    // 水平ずれ小・垂直ずれ大 → 下辺から
    expect(routeEdge(R(0, 0), R(20, 300), []).points[0]).toEqual({ x: 60, y: 44 });
    // 斜めでも水平が優勢 → 右辺から
    expect(routeEdge(R(0, 0), R(400, 120), []).points[0]).toEqual({ x: 120, y: 22 });
  });

  it('縦方向でも障害物を避ける(下辺から出て相手を迂回)', () => {
    // ソース→真下のターゲット。間に別ノードが居座る → 下辺から出つつ障害物本体を貫かない。
    const obstacle = R(0, 120);
    const r = routeEdge(R(0, 0), R(0, 260), [obstacle]);
    expect(r.points[0]).toEqual({ x: 60, y: 44 }); // 下辺から出る
    expect(passesThrough(r.points, obstacle)).toBe(false); // 迂回している
  });

  it('決定論: 同じ入力は同じ経路(4方位)', () => {
    const cases: [ReturnType<typeof R>, ReturnType<typeof R>][] = [
      [R(0, 0), R(400, 0)],
      [R(400, 0), R(0, 0)],
      [R(0, 0), R(0, 200)],
      [R(0, 200), R(0, 0)],
    ];
    for (const [s, t] of cases) {
      expect(routeEdge(s, t, []).d).toBe(routeEdge(s, t, []).d);
    }
  });
});
