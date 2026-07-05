import { describe, it, expect } from 'vitest';
import { clampScale, zoomScroll, centerScroll } from '../src/flowZoom';

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

describe('flowZoom: centerScroll(表→フロー追従の中央寄せ)', () => {
  const view = { left: 0, top: 0, w: 800, h: 600 };

  it('完全に視界内なら null（据え置き＝見えている間は動かさない）', () => {
    expect(centerScroll({ x: 100, y: 100, w: 120, h: 60 }, view, 1)).toBeNull();
    // 右端・下端ちょうど（<= 判定で視界内）も動かさない
    expect(centerScroll({ x: 0, y: 0, w: 800, h: 600 }, view, 1)).toBeNull();
  });

  it('右へはみ出したノードは中央へ寄せる（縦は上に切れるので 0 で止める）', () => {
    // node 画面矩形 (1000,100)〜(1120,160)。中心 (1060,130)。左=1060-400=660、上=130-300<0→0。
    const to = centerScroll({ x: 1000, y: 100, w: 120, h: 60 }, view, 1);
    expect(to).toEqual({ left: 660, top: 0 });
  });

  it('scale を掛けた画面座標で判定・計算する（ズームは変えない）', () => {
    // scale 2 で node 画面矩形 (20,20)〜(220,120)。view.left=400 の左に外れる。
    // 中心 (120,70)。左=120-400=-280→0、上=70-300<0→0。
    const to = centerScroll({ x: 10, y: 10, w: 100, h: 50 }, { left: 400, top: 0, w: 800, h: 600 }, 2);
    expect(to).toEqual({ left: 0, top: 0 });
  });

  it('下方向にはみ出したノードは縦だけ中央へ（横が視界内なら横中心もそのまま計算）', () => {
    // node (300,2000)〜(420,2060)。中心 (360,2030)。左=360-400=-40→0、上=2030-300=1730。
    const to = centerScroll({ x: 300, y: 2000, w: 120, h: 60 }, view, 1);
    expect(to).toEqual({ left: 0, top: 1730 });
  });
});
