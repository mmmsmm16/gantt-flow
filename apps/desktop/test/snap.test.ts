import { describe, it, expect } from 'vitest';
import { computeSnap } from '../src/snap';

// 工程ノードと同程度のサイズ感のダミー矩形
const rect = (x: number, y: number, w = 100, h = 44) => ({ x, y, w, h });

describe('computeSnap', () => {
  it('閾値内なら上端 y が揃い、横線ガイドが 1 本出る', () => {
    const r = computeSnap(rect(300, 103), [rect(0, 100)], 6);
    expect(r.y).toBe(100);
    expect(r.x).toBe(300); // x は遠いので不変
    expect(r.guides).toHaveLength(1);
    expect(r.guides[0]).toMatchObject({ axis: 'y', pos: 100 });
  });

  it('閾値外なら吸着しない（座標不変・ガイドなし）', () => {
    const r = computeSnap(rect(300, 110), [rect(0, 100)], 6);
    expect(r).toEqual({ x: 300, y: 110, guides: [] });
  });

  it('中央揃えの方が近ければ中央を採用する', () => {
    // other: y=100, h=60 → 中央 130。moving: y=109, h=44 → 上端差 9（閾値外）、中央差 |131-130|=1。
    const r = computeSnap(rect(300, 109), [rect(0, 100, 100, 60)], 6);
    expect(r.y).toBe(108); // 中央 130 に合わせる → 130 - 44/2
    expect(r.guides[0]).toMatchObject({ axis: 'y', pos: 130 });
  });

  it('左端 x が揃い、縦線ガイドが出る', () => {
    const r = computeSnap(rect(103, 500), [rect(100, 0)], 6);
    expect(r.x).toBe(100);
    expect(r.guides[0]).toMatchObject({ axis: 'x', pos: 100 });
  });

  it('x と y は独立に同時吸着できる（ガイド 2 本）', () => {
    const r = computeSnap(rect(103, 102), [rect(100, 500), rect(500, 100)], 6);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
    expect(r.guides.map((g) => g.axis).sort()).toEqual(['x', 'y']);
  });

  it('複数候補からは最も近いものに吸着する', () => {
    const r = computeSnap(rect(300, 103), [rect(0, 100), rect(0, 104)], 6);
    expect(r.y).toBe(104); // 差 1 の方（100 は差 3）
  });

  it('ガイドの線分は揃った全ノード + moving を端から端まで覆う', () => {
    const others = [rect(0, 100), rect(200, 100), rect(400, 100)];
    const r = computeSnap(rect(600, 102), others, 6);
    expect(r.y).toBe(100);
    const g = r.guides.find((g) => g.axis === 'y')!;
    expect(g.from).toBe(0); // 最左ノードの左端
    expect(g.to).toBe(700); // moving（吸着後 x=600, w=100）の右端
  });

  it('others が空なら no-op', () => {
    const r = computeSnap(rect(10, 20), [], 6);
    expect(r).toEqual({ x: 10, y: 20, guides: [] });
  });
});
