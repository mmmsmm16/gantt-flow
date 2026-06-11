import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEYMAP,
  eventMatches,
  findBinding,
  createLeaderTracker,
  resolveKeymap,
  findConflict,
  chordFromEvent,
  chordKeys,
  isImeKeyEvent,
  isSingleKeyBinding,
  filterKeymapForSingleKey,
  type KeyContext,
  type KeyLike,
} from '../src/keymap';
import { useUI } from '../src/ui/useUI';
import { planEscFocus } from '../src/ui/useGlobalHotkeys';

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

  it('table コンテキストの h/l・←→ は列カーソル移動', () => {
    expect(findBinding(ev({ key: 'h' }), DEFAULT_KEYMAP, ['table', 'global'], false)?.action).toBe('table.left');
    expect(findBinding(ev({ key: 'arrowright' }), DEFAULT_KEYMAP, ['table', 'global'], false)?.action).toBe(
      'table.right',
    );
    // シングルキーOFFでも矢印の列移動は残る
    const off = filterKeymapForSingleKey(DEFAULT_KEYMAP, false);
    expect(findBinding(ev({ key: 'arrowleft' }), off, ['table'], false)?.action).toBe('table.left');
    expect(findBinding(ev({ key: 'l' }), off, ['table'], false)).toBeUndefined();
  });

  it('フローの i/o で I/O 追加(Alt+KeyI/KeyO は常時有効の代替)', () => {
    expect(findBinding(ev({ key: 'i' }), DEFAULT_KEYMAP, ['flow'], false)?.action).toBe('flow.addInput');
    expect(findBinding(ev({ key: 'o' }), DEFAULT_KEYMAP, ['flow'], false)?.action).toBe('flow.addOutput');
    const off = filterKeymapForSingleKey(DEFAULT_KEYMAP, false);
    expect(findBinding(ev({ key: 'i' }), off, ['flow'], false)).toBeUndefined(); // 単キーは OFF で消える
    expect(
      findBinding(ev({ key: 'ˆ', code: 'KeyI', altKey: true }), off, ['flow'], false)?.action,
    ).toBe('flow.addInput'); // Alt 代替は残る
  });

  it('flow コンテキストでは j/矢印=選択ナビ、Alt+矢印=ノード移動', () => {
    expect(findBinding(ev({ key: 'j' }), DEFAULT_KEYMAP, ['flow', 'global'], false)?.action).toBe('flow.down');
    expect(findBinding(ev({ key: 'arrowdown' }), DEFAULT_KEYMAP, ['flow', 'global'], false)?.action).toBe('flow.down');
    expect(
      findBinding(ev({ key: 'arrowdown', altKey: true }), DEFAULT_KEYMAP, ['flow', 'global'], false)?.action,
    ).toBe('flow.moveDown');
    expect(
      findBinding(ev({ key: 'arrowleft', altKey: true, shiftKey: true }), DEFAULT_KEYMAP, ['flow', 'global'], false)
        ?.action,
    ).toBe('flow.moveLeft'); // Shift 併用(大きく移動)も同じバインドに一致
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

  it('shift 不問(undefined)は Shift あり/なしの両方と衝突する(eventMatches と同じ意味論)', () => {
    const redo = DEFAULT_KEYMAP.find((b) => b.id === 'redo')!;
    // undo を Ctrl+U(shift 不問)へ変更済みの状態で redo に Ctrl+Shift+U → 実行時に undo が
    // 先に一致して影になるため、衝突として報告されなければならない
    const km = resolveKeymap(DEFAULT_KEYMAP, { undo: { key: 'u', mod: true } });
    expect(findConflict(km, redo, { key: 'u', mod: true, shift: true })?.id).toBe('undo');
    expect(findConflict(km, redo, { key: 'u', mod: true, shift: false })?.id).toBe('undo');
  });

  it('shift 明示同士は従来どおり区別され、同じ実効キーの再割り当ては衝突しない', () => {
    const undo = DEFAULT_KEYMAP.find((b) => b.id === 'undo')!;
    const redo = DEFAULT_KEYMAP.find((b) => b.id === 'redo')!;
    // Ctrl+Z(shift:false) と Ctrl+Shift+Z(shift:true) は別キー
    expect(findConflict(DEFAULT_KEYMAP, undo, { key: 'z', mod: true, shift: true })?.id).toBe('redo-shift-z');
    expect(findConflict(DEFAULT_KEYMAP, redo, { key: 'y', mod: true, shift: false })).toBeUndefined();
    // 自分自身のいまのキーを取り直しても衝突にならない(自分は除外)
    expect(findConflict(DEFAULT_KEYMAP, undo, { key: 'z', mod: true, shift: false })).toBeUndefined();
  });
});

describe('keymap: chordFromEvent(キーキャプチャ)', () => {
  it('shift は必ず明示する(true/false。不問=undefined を作らない)', () => {
    expect(chordFromEvent(ev({ key: 'u', ctrlKey: true }))).toEqual({ key: 'u', mod: true, shift: false });
    expect(chordFromEvent(ev({ key: 'U', ctrlKey: true, shiftKey: true }))).toEqual({
      key: 'u',
      mod: true,
      shift: true,
    });
    expect(chordFromEvent(ev({ key: 'x', altKey: true }))).toEqual({ key: 'x', alt: true, shift: false });
  });

  it('キャプチャした chord は打鍵した修飾の組み合わせだけに一致する', () => {
    const chord = chordFromEvent(ev({ key: 'u', ctrlKey: true })); // Ctrl+U(Shift なし)
    expect(eventMatches(ev({ key: 'u', ctrlKey: true }), chord)).toBe(true);
    expect(eventMatches(ev({ key: 'U', ctrlKey: true, shiftKey: true }), chord)).toBe(false); // Shift 付きは別
  });
});

describe('keymap: isImeKeyEvent(IME ガード)', () => {
  it('isComposing / keyCode 229 / React 合成イベント(nativeEvent)のいずれでも IME とみなす', () => {
    expect(isImeKeyEvent({ isComposing: true })).toBe(true);
    expect(isImeKeyEvent({ keyCode: 229 })).toBe(true);
    expect(isImeKeyEvent({ keyCode: 13, nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeKeyEvent({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });

  it('通常の打鍵は IME 扱いしない', () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKeyEvent({ keyCode: 27, nativeEvent: { isComposing: false, keyCode: 27 } })).toBe(false);
    expect(isImeKeyEvent({})).toBe(false);
  });
});

describe('keymap: flow の Delete/Esc と接続モード(connect)コンテキスト', () => {
  it('flow コンテキストの Delete/Backspace=削除、Esc=選択解除(慣習キー=fixed)', () => {
    expect(findBinding(ev({ key: 'Delete' }), DEFAULT_KEYMAP, ['flow'], false)?.action).toBe('flow.delete');
    expect(findBinding(ev({ key: 'Backspace' }), DEFAULT_KEYMAP, ['flow'], false)?.action).toBe('flow.delete');
    expect(findBinding(ev({ key: 'Escape' }), DEFAULT_KEYMAP, ['flow'], false)?.action).toBe('flow.clear');
    // 慣習キーなのでシングルキーOFFでも残る
    const off = filterKeymapForSingleKey(DEFAULT_KEYMAP, false);
    expect(findBinding(ev({ key: 'Delete' }), off, ['flow'], false)?.action).toBe('flow.delete');
    expect(findBinding(ev({ key: 'Escape' }), off, ['flow'], false)?.action).toBe('flow.clear');
  });

  it('connect コンテキストが先頭にあると flow/global より優先される', () => {
    const ctxs: KeyContext[] = ['connect', 'flow', 'global'];
    expect(findBinding(ev({ key: 'Escape' }), DEFAULT_KEYMAP, ctxs, false)?.action).toBe('connect.cancel');
    expect(findBinding(ev({ key: 'c' }), DEFAULT_KEYMAP, ctxs, false)?.action).toBe('connect.cancel');
    expect(findBinding(ev({ key: 'Enter' }), DEFAULT_KEYMAP, ctxs, false)?.action).toBe('connect.commit');
    expect(findBinding(ev({ key: 'Tab' }), DEFAULT_KEYMAP, ctxs, false)?.action).toBe('connect.next');
    expect(findBinding(ev({ key: 'Tab', shiftKey: true }), DEFAULT_KEYMAP, ctxs, false)?.action).toBe('connect.prev');
    expect(findBinding(ev({ key: 'arrowleft' }), DEFAULT_KEYMAP, ctxs, false)?.action).toBe('connect.left');
    expect(findBinding(ev({ key: 'j' }), DEFAULT_KEYMAP, ctxs, false)?.action).toBe('connect.down');
  });

  it('接続モードでなければ connect バインドは一致しない', () => {
    expect(findBinding(ev({ key: 'Tab' }), DEFAULT_KEYMAP, ['flow', 'global'], false)).toBeUndefined();
    expect(findBinding(ev({ key: 'Enter' }), DEFAULT_KEYMAP, ['flow', 'global'], false)?.action).toBe('flow.rename');
  });

  it('シングルキーOFFでも接続モード中の h/j/k/l・c は有効(fixed)', () => {
    const off = filterKeymapForSingleKey(DEFAULT_KEYMAP, false);
    expect(findBinding(ev({ key: 'h' }), off, ['connect', 'flow'], false)?.action).toBe('connect.left');
    expect(findBinding(ev({ key: 'c' }), off, ['connect', 'flow'], false)?.action).toBe('connect.cancel');
  });
});

describe('useGlobalHotkeys: Esc のフォーカス規則(planEscFocus)', () => {
  it('モーダルコンテキスト(接続モード等)の Esc が最優先(blur せず 1 押下でキャンセル)', () => {
    // フロー上のノード(tabIndex=0)にフォーカスがあっても、blur で消費せずバインディングへ。
    expect(planEscFocus({ blurrable: true, editable: false, hasModalBinding: true })).toBe('modal-binding');
    expect(planEscFocus({ blurrable: false, editable: false, hasModalBinding: true })).toBe('modal-binding');
    // 落ちた先の照合: connect が積まれていれば Esc は connect.cancel に解決する。
    expect(
      findBinding(ev({ key: 'Escape' }), DEFAULT_KEYMAP, ['connect', 'flow', 'global'], false)?.action,
    ).toBe('connect.cancel');
  });

  it('入力系(editable)の Esc は blur だけで完結する(選択は維持。解除はもう一度 Esc)', () => {
    expect(planEscFocus({ blurrable: true, editable: true, hasModalBinding: false })).toBe('blur-only');
    // モーダル中でも入力からの離脱が先(編集中は単キーを通さない editable ガードと整合)。
    expect(planEscFocus({ blurrable: true, editable: true, hasModalBinding: true })).toBe('blur-only');
  });

  it('非編集要素(ノード div・ボタン等)の Esc は blur しつつ同じ押下でバインディングへ落ちる', () => {
    expect(planEscFocus({ blurrable: true, editable: false, hasModalBinding: false })).toBe('blur-and-binding');
    // 落ちた先: flow なら flow.clear、table なら table.clear が同じ押下で効く(2 回押し不要)。
    expect(findBinding(ev({ key: 'Escape' }), DEFAULT_KEYMAP, ['flow', 'global'], false)?.action).toBe('flow.clear');
    expect(findBinding(ev({ key: 'Escape' }), DEFAULT_KEYMAP, ['table', 'global'], false)?.action).toBe('table.clear');
  });

  it('blur 対象が無ければ(body / ペイン自体)通常のバインディング照合へ', () => {
    expect(planEscFocus({ blurrable: false, editable: false, hasModalBinding: false })).toBe('binding');
  });
});

describe('useUI: ダイアログの FIFO 待ち行列(押し退けない)', () => {
  it('表示中に confirm/promptText を重ねると順に表示され、すべて解決される', async () => {
    const ui = useUI.getState();
    const p1 = ui.confirm({ message: '1番目' });
    const p2 = ui.confirm({ message: '2番目' });
    const p3 = ui.promptText({ message: '3番目' });
    // 先に開いたものが表示されたまま(置き換えられない)
    expect(useUI.getState().dialog?.message).toBe('1番目');
    expect(useUI.getState().dialogQueue.length).toBe(2);

    useUI.getState().resolveDialog(true);
    await expect(p1).resolves.toBe(true);
    expect(useUI.getState().dialog?.message).toBe('2番目');

    useUI.getState().resolveDialog(false);
    await expect(p2).resolves.toBe(false);
    expect(useUI.getState().dialog?.kind).toBe('prompt');

    useUI.getState().resolveDialog('入力値');
    await expect(p3).resolves.toBe('入力値');
    expect(useUI.getState().dialog).toBeNull();
    expect(useUI.getState().dialogQueue).toEqual([]);
  });

  it('解決直後に開いた次のダイアログは、待ち行列の後ろに正しく並ぶ', async () => {
    const ui = useUI.getState();
    const p1 = ui.confirm({ message: 'A' });
    const chained = p1.then(() => useUI.getState().confirm({ message: 'C' }));
    const p2 = ui.confirm({ message: 'B' });
    useUI.getState().resolveDialog(true); // A を解決 → B が表示、C は B の後ろ
    await p1;
    // p1 の then(マイクロタスク)を消化してから確認
    await Promise.resolve();
    expect(useUI.getState().dialog?.message).toBe('B');
    useUI.getState().resolveDialog(true);
    await expect(p2).resolves.toBe(true);
    expect(useUI.getState().dialog?.message).toBe('C');
    useUI.getState().resolveDialog(false);
    await expect(chained).resolves.toBe(false);
    expect(useUI.getState().dialog).toBeNull();
  });
});

describe('useUI: closeTopLayer(Esc の一元規則)', () => {
  it('dialog > overlay の順で 1 回につき 1 レイヤだけ閉じる(バックアップ復元の confirm 重なり)', async () => {
    const ui = useUI.getState();
    ui.setOverlay('backups');
    const p = ui.confirm({ message: '復元しますか' });
    // 1 回目: 最上位の confirm だけが取消で閉じ、バックアップ一覧は残る
    expect(useUI.getState().closeTopLayer()).toBe(true);
    await expect(p).resolves.toBe(false);
    expect(useUI.getState().overlay).toBe('backups');
    // 2 回目: オーバーレイが閉じる
    expect(useUI.getState().closeTopLayer()).toBe(true);
    expect(useUI.getState().overlay).toBeNull();
    // 3 回目: 閉じるものが無ければ false(通常のキー処理へ)
    expect(useUI.getState().closeTopLayer()).toBe(false);
  });

  it('prompt は取消(null)として解決される', async () => {
    const p = useUI.getState().promptText({ message: '名前' });
    expect(useUI.getState().closeTopLayer()).toBe(true);
    await expect(p).resolves.toBeNull();
  });

  it('一時 UI(メニュー等)は後から登録したものが最上位として閉じる', () => {
    const closed: string[] = [];
    const un1 = useUI.getState().registerTransientLayer(() => closed.push('a'));
    const un2 = useUI.getState().registerTransientLayer(() => closed.push('b'));
    expect(useUI.getState().closeTopLayer()).toBe(true);
    expect(closed).toEqual(['b']);
    un2();
    expect(useUI.getState().closeTopLayer()).toBe(true);
    expect(closed).toEqual(['b', 'a']);
    un1();
    expect(useUI.getState().closeTopLayer()).toBe(false);
  });

  it('overlay のカスタムクローザが true を返す間は overlay が閉じない(パレットの引数モード相当)', () => {
    const ui = useUI.getState();
    ui.setOverlay('palette');
    let consume = true;
    const unregister = ui.registerOverlayCloser(() => consume);
    expect(useUI.getState().closeTopLayer()).toBe(true); // 消費(引数モード→一覧 など)
    expect(useUI.getState().overlay).toBe('palette');
    consume = false;
    expect(useUI.getState().closeTopLayer()).toBe(true); // 既定どおり閉じる
    expect(useUI.getState().overlay).toBeNull();
    unregister();
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
    // フロー: h(単キー)は消えるが、矢印の選択ナビと Alt+矢印の移動は残る
    expect(findBinding(ev({ key: 'h' }), off, ['flow'], false)).toBeUndefined();
    expect(findBinding(ev({ key: 'arrowleft' }), off, ['flow'], false)?.action).toBe('flow.left');
    expect(findBinding(ev({ key: 'arrowleft', altKey: true }), off, ['flow'], false)?.action).toBe('flow.moveLeft');
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
