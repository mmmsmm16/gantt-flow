import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEYMAP,
  eventMatches,
  findBinding,
  createLeaderTracker,
  resolveKeymap,
  findConflict,
  chordKeys,
  isSingleKeyBinding,
  filterKeymapForSingleKey,
  type KeyLike,
} from '../src/keymap';

const ev = (partial: Partial<KeyLike> & { key: string }): KeyLike => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...partial,
});

describe('keymap: eventMatches', () => {
  it('単キー(j)は修飾なしのみ一致する', () => {
    expect(eventMatches(ev({ key: 'j' }), { key: 'j' })).toBe(true);
    expect(eventMatches(ev({ key: 'J', shiftKey: true }), { key: 'j' })).toBe(true); // shift 不問
    expect(eventMatches(ev({ key: 'j', ctrlKey: true }), { key: 'j' })).toBe(false);
    expect(eventMatches(ev({ key: 'j', altKey: true }), { key: 'j' })).toBe(false);
  });

  it('mod 指定は Ctrl と ⌘ のどちらでも一致する', () => {
    expect(eventMatches(ev({ key: 'k', ctrlKey: true }), { key: 'k', mod: true })).toBe(true);
    expect(eventMatches(ev({ key: 'k', metaKey: true }), { key: 'k', mod: true })).toBe(true);
    expect(eventMatches(ev({ key: 'k' }), { key: 'k', mod: true })).toBe(false);
  });

  it('shift 指定があるときは厳密に区別する(n と Shift+N)', () => {
    expect(eventMatches(ev({ key: 'n' }), { key: 'n', shift: false })).toBe(true);
    expect(eventMatches(ev({ key: 'N', shiftKey: true }), { key: 'n', shift: false })).toBe(false);
    expect(eventMatches(ev({ key: 'N', shiftKey: true }), { key: 'n', shift: true })).toBe(true);
  });

  it('code 指定は物理キーで判定する', () => {
    expect(eventMatches(ev({ key: '!', code: 'Digit1', altKey: true }), { code: 'Digit1', alt: true })).toBe(true);
  });
});

describe('keymap: findBinding', () => {
  it('コンテキストの優先順で解決する(table の j は global より先)', () => {
    const b = findBinding(ev({ key: 'j' }), DEFAULT_KEYMAP, ['table', 'global'], false);
    expect(b?.action).toBe('table.next');
  });

  it('flow コンテキストでは j がノード移動になる', () => {
    const b = findBinding(ev({ key: 'j' }), DEFAULT_KEYMAP, ['flow', 'global'], false);
    expect(b?.action).toBe('flow.down');
  });

  it('リーダー有効時はリーダーバインドのみ一致する(g t)', () => {
    const normal = findBinding(ev({ key: 't' }), DEFAULT_KEYMAP, ['table', 'global'], false);
    expect(normal).toBeUndefined();
    const led = findBinding(ev({ key: 't' }), DEFAULT_KEYMAP, ['table', 'global'], true);
    expect(led?.action).toBe('pane.table');
  });

  it('g g は table コンテキストで先頭へ、G(Shift) は末尾へ', () => {
    const gg = findBinding(ev({ key: 'g' }), DEFAULT_KEYMAP, ['table', 'global'], true);
    expect(gg?.action).toBe('table.first');
    const G = findBinding(ev({ key: 'G', shiftKey: true }), DEFAULT_KEYMAP, ['table', 'global'], false);
    expect(G?.action).toBe('table.last');
  });

  it('Ctrl+Z は undo、Ctrl+Shift+Z は redo', () => {
    expect(findBinding(ev({ key: 'z', ctrlKey: true }), DEFAULT_KEYMAP, ['global'], false)?.action).toBe('global.undo');
    expect(
      findBinding(ev({ key: 'Z', ctrlKey: true, shiftKey: true }), DEFAULT_KEYMAP, ['global'], false)?.action,
    ).toBe('global.redo');
  });
});

describe('keymap: createLeaderTracker', () => {
  it('1秒以内の2打目で consume できる', () => {
    let t = 1000;
    const lt = createLeaderTracker(1000, () => t);
    lt.arm();
    t += 500;
    expect(lt.isPending()).toBe(true);
    expect(lt.consume()).toBe(true);
    expect(lt.isPending()).toBe(false); // consume 後は解除
  });

  it('タイムアウト後は pending でない', () => {
    let t = 1000;
    const lt = createLeaderTracker(1000, () => t);
    lt.arm();
    t += 1500;
    expect(lt.isPending()).toBe(false);
    expect(lt.consume()).toBe(false);
  });
});

describe('keymap: resolveKeymap(カスタマイズ)', () => {
  it('上書きでキーが差し替わり、null で無効化できる', () => {
    const km = resolveKeymap(DEFAULT_KEYMAP, {
      'row-add': { key: 'a' }, // n → a
      'undo-u': null, // u を無効化
    });
    expect(findBinding(ev({ key: 'a' }), km, ['table'], false)?.action).toBe('table.addSibling');
    expect(findBinding(ev({ key: 'n' }), km, ['table'], false)).toBeUndefined();
    expect(findBinding(ev({ key: 'u' }), km, ['global'], false)).toBeUndefined();
  });

  it('fixed なバインドは上書き・無効化できない', () => {
    const km = resolveKeymap(DEFAULT_KEYMAP, { 'row-delete': null, help: { key: 'h' } });
    expect(findBinding(ev({ key: 'delete' }), km, ['table'], false)?.action).toBe('table.delete');
    expect(findBinding(ev({ key: '?' }), km, ['global'], false)?.action).toBe('global.help');
  });
});

describe('keymap: findConflict(重複検出)', () => {
  it('同一コンテキストで同じキーなら衝突を返す', () => {
    const target = DEFAULT_KEYMAP.find((b) => b.id === 'row-add')!; // table の n
    const conflict = findConflict(DEFAULT_KEYMAP, target, { key: 'j' }); // 既存 row-next と衝突
    expect(conflict?.id).toBe('row-next');
  });

  it('table と global は同時に有効になるため互いに衝突扱い', () => {
    const target = DEFAULT_KEYMAP.find((b) => b.id === 'row-add')!;
    const conflict = findConflict(DEFAULT_KEYMAP, target, { key: 'v' }); // global の表モード切替
    expect(conflict?.id).toBe('table-mode');
  });

  it('別コンテキスト(table と flow)は衝突しない', () => {
    const target = DEFAULT_KEYMAP.find((b) => b.id === 'row-add')!; // table
    const conflict = findConflict(DEFAULT_KEYMAP, target, { key: 'c' }); // flow の接続モード
    expect(conflict).toBeUndefined();
  });
});

describe('keymap: シングルキー操作(Vim 風)のフィルタ', () => {
  const byId = (id: string) => DEFAULT_KEYMAP.find((b) => b.id === id)!;

  it('修飾なし単キー(j/n/+/=/-/0/Space/G/N)とリーダー(gg/g t)はシングルキー判定', () => {
    for (const id of [
      'row-next', // j
      'row-add', // n
      'row-add-child', // Shift+N
      'row-last', // G(Shift+g)
      'row-collapse', // Space
      'zoom-in', // +
      'zoom-in-eq', // =
      'zoom-out', // -
      'zoom-reset', // 0
      'undo-u', // u
      'table-mode', // v
      'palette-slash', // /
      'connect-mode', // c
      'row-first', // g g(leader)
      'go-table', // g t(leader)
    ]) {
      expect(isSingleKeyBinding(byId(id)), id).toBe(true);
    }
  });

  it('矢印・Alt+矢印・mod系・F2/F6・fixed(?/Enter/Delete/Tab)は対象外', () => {
    for (const id of [
      'row-next-arrow', // ↓
      'row-move-up', // Alt+↑
      'palette', // ⌘K
      'row-duplicate', // ⌘D
      'pane-toggle', // F6
      'row-edit-f2', // F2
      'help', // ?(fixed)
      'row-edit', // Enter(fixed)
      'row-delete', // Delete(fixed)
      'row-indent', // Tab(fixed)
    ]) {
      expect(isSingleKeyBinding(byId(id)), id).toBe(false);
    }
  });

  it('OFF では単キーが実効キーマップから消え、ON ではそのまま', () => {
    const off = filterKeymapForSingleKey(DEFAULT_KEYMAP, false);
    expect(findBinding(ev({ key: 'j' }), off, ['table'], false)).toBeUndefined();
    expect(findBinding(ev({ key: 'arrowdown' }), off, ['table'], false)?.action).toBe('table.next'); // 矢印は残る
    expect(findBinding(ev({ key: 't' }), off, ['global'], true)).toBeUndefined(); // リーダーも消える
    const on = filterKeymapForSingleKey(DEFAULT_KEYMAP, true);
    expect(findBinding(ev({ key: 'j' }), on, ['table'], false)?.action).toBe('table.next');
  });

  it('カスタムで単キー化したバインドも OFF では消える(resolve → filter の順)', () => {
    const resolved = resolveKeymap(DEFAULT_KEYMAP, { save: { key: 's' } }); // ⌘S → s に変更
    const off = filterKeymapForSingleKey(resolved, false);
    expect(findBinding(ev({ key: 's' }), off, ['global'], false)).toBeUndefined();
    // code ベースの単キー(KeyJ)も防御的に拾う
    const resolved2 = resolveKeymap(DEFAULT_KEYMAP, { save: { code: 'KeyS' } });
    const off2 = filterKeymapForSingleKey(resolved2, false);
    expect(off2.find((b) => b.id === 'save')).toBeUndefined();
  });
});

describe('keymap: 工程カラーのクイックキー(Alt+数字)', () => {
  it('Alt+1/2/3=塗り色、Alt+Shift+1/2/3=文字色(e.code で物理キー判定)', () => {
    // Mac では Alt+数字が記号(¡™£)になるため key ではなく code で照合する
    expect(
      findBinding(ev({ key: '¡', code: 'Digit1', altKey: true }), DEFAULT_KEYMAP, ['global'], false)?.action,
    ).toBe('color.fillNone');
    expect(
      findBinding(ev({ key: '™', code: 'Digit2', altKey: true }), DEFAULT_KEYMAP, ['global'], false)?.action,
    ).toBe('color.fillBlue');
    expect(
      findBinding(
        ev({ key: '⁄', code: 'Digit3', altKey: true, shiftKey: true }),
        DEFAULT_KEYMAP,
        ['global'],
        false,
      )?.action,
    ).toBe('color.textRed');
    // Shift の有無で塗り/文字を区別
    expect(
      findBinding(ev({ key: '1', code: 'Digit1', altKey: true, shiftKey: true }), DEFAULT_KEYMAP, ['global'], false)
        ?.action,
    ).toBe('color.textNone');
  });

  it('Alt 付きなのでシングルキーOFFでも有効(フィルタ対象外)', () => {
    const off = filterKeymapForSingleKey(DEFAULT_KEYMAP, false);
    expect(
      findBinding(ev({ key: '™', code: 'Digit2', altKey: true }), off, ['global'], false)?.action,
    ).toBe('color.fillBlue');
  });
});

describe('keymap: chordKeys(表示)', () => {
  it('リーダーと修飾キーを表示順に並べる', () => {
    expect(chordKeys({ key: 't' }, true)).toEqual(['g', 'T']);
    expect(chordKeys({ key: 'arrowup', alt: true })).toContain('↑');
    expect(chordKeys({ key: ' ' })).toEqual(['Space']);
  });
});
