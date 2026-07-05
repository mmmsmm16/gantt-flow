// StatusBar のキーヒント動的生成（C-04）。ハードコードを廃し実効キーマップから生成する。
// paneKeyHints は純関数なので、シングルキー ON/OFF でフィルタしたキーマップを渡して検証する
// （getActiveKeymap は localStorage 依存＝ここでは filterKeymapForSingleKey を直接使う）。
import { describe, it, expect } from 'vitest';
import { DEFAULT_KEYMAP, resolveKeymap, filterKeymapForSingleKey } from '../src/keymap';
import { paneKeyHints } from '../src/ui/StatusBar';

const on = () => filterKeymapForSingleKey(resolveKeymap(DEFAULT_KEYMAP, {}), true);
const off = () => filterKeymapForSingleKey(resolveKeymap(DEFAULT_KEYMAP, {}), false);

describe('paneKeyHints（ステータスバーのキーヒント生成）', () => {
  it('表: シングルキーON では単キー（j/k・n）を表示する', () => {
    const hints = paneKeyHints(on(), 'table');
    const move = hints.find((h) => h.label === '移動');
    const add = hints.find((h) => h.label === '追加');
    expect(move?.keys).toBe('J/K');
    expect(add?.keys).toBe('N');
    // 密度は最大 5 個（トーン維持）。
    expect(hints.length).toBeLessThanOrEqual(5);
  });

  it('表: シングルキーOFF では移動が矢印へ落ちる（修飾キー系のみ）', () => {
    const hints = paneKeyHints(off(), 'table');
    const move = hints.find((h) => h.label === '移動');
    expect(move?.keys).toBe('↓/↑');
    // lowRisk な「追加(n)」は OFF でも実際に効く＝ヒントにも残す。
    expect(hints.find((h) => h.label === '追加')?.keys).toBe('N');
    // Enter / ? / コマンド は常時表示。
    expect(hints.find((h) => h.label === '編集')?.keys).toBe('Enter');
    expect(hints.find((h) => h.label === '一覧')?.keys).toBe('?');
  });

  it('フロー: 選択（矢印）・接続（c, lowRisk）・コマンド・一覧の 4 つ', () => {
    const onHints = paneKeyHints(on(), 'flow');
    expect(onHints.map((h) => h.label)).toEqual(['選択', '接続', 'コマンド', '一覧']);
    expect(onHints.find((h) => h.label === '接続')?.keys).toBe('C');
    // 接続(c) は lowRisk＝OFF でも効くのでヒントも残る。
    const offHints = paneKeyHints(off(), 'flow');
    expect(offHints.find((h) => h.label === '接続')?.keys).toBe('C');
  });

  it('ユーザー上書きしたキーがヒントに反映される（表示＝実挙動）', () => {
    const overridden = filterKeymapForSingleKey(
      resolveKeymap(DEFAULT_KEYMAP, { 'row-add': { key: 'a' } }),
      true,
    );
    expect(paneKeyHints(overridden, 'table').find((h) => h.label === '追加')?.keys).toBe('A');
  });
});
