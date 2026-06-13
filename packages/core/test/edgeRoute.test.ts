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

  it('障害物なしの段違いは従来どおり中央の HVH(4点)', () => {
    const r = routeEdge(R(0, 0), R(400, 200), []);
    expect(r.points).toHaveLength(4);
    expect(r.points[1]!.x).toBe(260); // (120+400)/2
    expect(r.d.startsWith('M120,22')).toBe(true);
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

  it('後ろ向き(ターゲットが左)でも経路が返る', () => {
    const r = routeEdge(R(400, 0), R(0, 200), []);
    expect(r.points.length).toBeGreaterThanOrEqual(4);
    expect(r.points[0]).toEqual({ x: 520, y: 22 });
    expect(r.points[r.points.length - 1]).toEqual({ x: 0, y: 222 });
  });

  it('ラベル位置は経路の中央セグメントの中点', () => {
    const r = routeEdge(R(0, 0), R(400, 200), []);
    expect(r.label).toEqual({ x: 260, y: 122 }); // 縦セグメントの中点
  });
});
