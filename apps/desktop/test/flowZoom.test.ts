import { describe, it, expect } from 'vitest';
import { clampScale, zoomScroll } from '../src/flowZoom';

describe('flowZoom: clampScale', () => {
  it('0.4〜2.5 に収め、3 桁で丸める', () => {
    expect(clampScale(3)).toBe(2.5);
    expect(clampScale(0.1)).toBe(0.4);
    expect(clampScale(1.21)).toBe(1.21);
    expect(clampScale(1.1 * 1.1)).toBe(1.21); // 浮動小数の桁ゴミを丸める＝同値比較が安定
  });
});

describe('flowZoom: zoomScroll(アンカー固定のスクロール補正)', () => {
  it('アンカー直下の論理座標が、ズーム後も同じ画面位置に来る', () => {
    // scroll(100,50)・アンカー(200,120) → 論理点 (300,170)。2 倍では (600,340) に写る。
    const out = zoomScroll({ left: 100, top: 50 }, { x: 200, y: 120 }, 1, 2);
    expect(out).toEqual({ left: 400, top: 220 });
    // 検算: 新スクロール + アンカー = 論理点 × 新 scale（＝画面位置が不変）
    expect((out.left + 200) / 2).toBe((100 + 200) / 1);
    expect((out.top + 120) / 2).toBe((50 + 120) / 1);
  });

  it('縮小も同じ式で成立する（拡大の逆変換で元のスクロールに戻る）', () => {
    const zoomed = zoomScroll({ left: 100, top: 50 }, { x: 200, y: 120 }, 1, 2);
    const back = zoomScroll(zoomed, { x: 200, y: 120 }, 2, 1);
    expect(back).toEqual({ left: 100, top: 50 });
  });

  it('補正後が負になる場合は 0 で止める（ブラウザの clamp と同じ）', () => {
    const out = zoomScroll({ left: 0, top: 0 }, { x: 300, y: 200 }, 1, 0.5);
    expect(out).toEqual({ left: 0, top: 0 }); // -150/-100 → 0
  });

  it('scale が変わらなければスクロールも変わらない', () => {
    expect(zoomScroll({ left: 80, top: 60 }, { x: 10, y: 20 }, 1.5, 1.5)).toEqual({
      left: 80,
      top: 60,
    });
  });
});
