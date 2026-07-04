// ヘルプ一覧の生成ロジック(HelpDialog.buildKeymapGroupsFrom)。UX#12:
// シングルキー操作がOFFのときも行を隠さず、薄く(off:true)表示して「設定でONにできます」を
// 添える。ただし lowRisk なバインド(表の n=次工程追加)は OFF 設定でも常時有効なので off にしない。
import { describe, it, expect } from 'vitest';
import { DEFAULT_KEYMAP, resolveKeymap, filterKeymapForSingleKey, type KeymapOverrides } from '../src/keymap';
import { buildKeymapGroupsFrom } from '../src/ui/HelpDialog';

function build(overrides: KeymapOverrides, singleKeyEnabled: boolean) {
  const resolvedAll = resolveKeymap(DEFAULT_KEYMAP, overrides);
  const active = filterKeymapForSingleKey(resolvedAll, singleKeyEnabled);
  return buildKeymapGroupsFrom(active, resolvedAll);
}

function findItem(groups: ReturnType<typeof build>, label: string) {
  for (const g of groups) {
    const hit = g.items.find((i) => i.label === label);
    if (hit) return hit;
  }
  return undefined;
}

describe('HelpDialog: buildKeymapGroupsFrom(UX#12 シングルキーの可視化)', () => {
  it('シングルキーOFFでも行は消えず、薄く(off:true)表示される', () => {
    const groups = build({}, false);
    // 表モード切替(v)は単キーで lowRisk でないため、OFF では無効=薄く(off:true)表示される。
    const item = findItem(groups, '表モード切替(アウトライン⇄全項目)');
    expect(item).toBeDefined();
    expect(item?.off).toBe(true);
  });

  it('lowRisk(表の n=次工程追加)はOFF設定でも off にならない(既定で有効)', () => {
    const groups = build({}, false);
    const rowAdd = findItem(groups, '次に工程を追加して編集');
    expect(rowAdd).toBeDefined();
    expect(rowAdd?.off).toBe(false);
    expect(rowAdd?.keys).toEqual(['N']);
  });

  it('P2 で lowRisk にした操作(折りたたみ/ズーム/接続)はOFFでも off にならない', () => {
    const groups = build({}, false);
    expect(findItem(groups, '折りたたみ(アウトライン)')?.off).toBe(false);
    expect(findItem(groups, 'ズームイン')?.off).toBe(false);
    expect(findItem(groups, '接続モード(矢印で候補 → Enter)')?.off).toBe(false);
  });

  it('シングルキーONなら OFF 表示は出ない', () => {
    const groups = build({}, true);
    const item = findItem(groups, '表モード切替(アウトライン⇄全項目)');
    expect(item?.off).toBe(false);
  });

  it('残った代替キー(↓)がある行は、代表キー(j)がOFFでも off:true にならない', () => {
    const groups = build({}, false);
    const next = findItem(groups, '下の行を選択');
    expect(next).toBeDefined();
    expect(next?.off).toBe(false);
    expect(next?.keys.join(' ')).toContain('↓');
  });

  it('ユーザー上書きでその action を完全に無効化(null)した行だけは、隠れたまま出さない', () => {
    const groups = build({ 'row-collapse': null }, false);
    expect(findItem(groups, '折りたたみ(アウトライン)')).toBeUndefined();
  });
});
