import { describe, it, expect } from 'vitest';
import { nearestInDirection, firstVisual, type NavRect } from '../src/spatialNav';

const R = (id: string, x: number, y: number): NavRect => ({ id, x, y, w: 150, h: 44 });

describe('spatialNav: nearestInDirection', () => {
  const nodes = [R('a', 0, 0), R('b', 220, 0), R('c', 440, 0), R('d', 220, 156), R('e', 0, 312)];

  it('右/左は同じ行の隣を選ぶ', () => {
    expect(nearestInDirection(nodes[0]!, nodes, 'right')).toBe('b');
    expect(nearestInDirection(nodes[1]!, nodes, 'right')).toBe('c');
    expect(nearestInDirection(nodes[2]!, nodes, 'left')).toBe('b');
  });

  it('下/上は直下・直上を優先する(斜めより直交ずれが小さい方)', () => {
    expect(nearestInDirection(nodes[1]!, nodes, 'down')).toBe('d');
    expect(nearestInDirection(nodes[3]!, nodes, 'up')).toBe('b');
    // a の下: d(右下 156px下/220px右) と e(真下 312px下) → e は cross=0 で勝つ
    expect(nearestInDirection(nodes[0]!, nodes, 'down')).toBe('e');
  });

  it('その方向に何も無ければ null', () => {
    expect(nearestInDirection(nodes[0]!, nodes, 'left')).toBe(null);
    expect(nearestInDirection(nodes[2]!, nodes, 'right')).toBe(null);
  });
});

describe('spatialNav: firstVisual', () => {
  it('上→下、同じ高さなら左→右の最初を返す', () => {
    expect(firstVisual([R('x', 300, 100), R('y', 100, 100), R('z', 500, 50)])).toBe('z');
    expect(firstVisual([R('x', 300, 100), R('y', 100, 100)])).toBe('y');
    expect(firstVisual([])).toBe(null);
  });
});
