import { describe, it, expect, vi } from 'vitest';
import { cancelEditOnEscape, nameEscapeAction } from '../src/inputBehaviors';
import { createAppStore } from '../src/store';

// nameEscapeAction: #1 の中核判定。未コミット新規行（name===''）は行削除、既存行は取り消し。
describe('nameEscapeAction（Escape で削除するか復元するか）', () => {
  it('確定名が空文字（＝直前作成の未コミット行）は remove', () => {
    expect(nameEscapeAction('')).toBe('remove');
  });
  it('名前が付いている既存行は restore（従来のリネーム取り消し）', () => {
    expect(nameEscapeAction('受付')).toBe('restore');
    expect(nameEscapeAction('新規工程')).toBe('restore'); // ＋子の既定名も既存行扱い＝残す
  });
});

// cancelEditOnEscape: 値を defaultValue へ戻してから blur・伝播停止。onBlur が
// 「変化があるときだけコミット」なので、これで打った内容が破棄されコミットされない。
describe('cancelEditOnEscape（Escape=取り消しの共通ハンドラ）', () => {
  const makeEvent = (key: string, opts: { value: string; defaultValue: string; ime?: boolean }) => {
    const el = { value: opts.value, defaultValue: opts.defaultValue, blur: vi.fn() };
    return {
      key,
      isComposing: opts.ime ?? false,
      stopPropagation: vi.fn(),
      currentTarget: el,
      _el: el,
    } as never as import('react').KeyboardEvent<HTMLInputElement> & {
      stopPropagation: ReturnType<typeof vi.fn>;
      _el: typeof el;
    };
  };

  it('Escape で value を defaultValue へ戻し blur・伝播停止する', () => {
    const e = makeEvent('Escape', { value: 'ゴミ入力', defaultValue: '確定値' });
    cancelEditOnEscape(e);
    expect(e._el.value).toBe('確定値');
    expect(e._el.blur).toHaveBeenCalledOnce();
    expect(e.stopPropagation).toHaveBeenCalledOnce();
  });

  it('Escape 以外は何もしない（通常の打鍵を素通し）', () => {
    const e = makeEvent('a', { value: 'あ', defaultValue: '確定値' });
    cancelEditOnEscape(e);
    expect(e._el.value).toBe('あ');
    expect(e._el.blur).not.toHaveBeenCalled();
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('IME 変換確定中の Escape はキャンセルにしない（誤取り消し防止）', () => {
    const e = makeEvent('Escape', { value: 'へんかん', defaultValue: '確定値', ime: true });
    cancelEditOnEscape(e);
    expect(e._el.value).toBe('へんかん');
    expect(e._el.blur).not.toHaveBeenCalled();
  });
});

// #1 状態レベルの回帰: 追加直後の行は確定名が空（＝ゴースト）で、Escape 相当の removeTask で
// 行ごと消える。名前を付けた行は remove 対象にならず残る（誤削除しない）。
describe('ゴースト行の Escape 削除（state レベル回帰）', () => {
  it('＋大/n/ゴースト起点の新規行は name===\'\' で作られ、removeTask で行ごと消える', () => {
    const s = createAppStore();
    const id = s.getState().addRootTask('large')!;
    expect(id).toBeTruthy();
    const created = s.getState().project.core.tasks[id]!;
    expect(created.name).toBe(''); // 未コミット＝ゴースト
    expect(nameEscapeAction(created.name)).toBe('remove');

    s.getState().removeTask(id); // Escape ハンドラが呼ぶ経路
    expect(s.getState().project.core.tasks[id]).toBeUndefined(); // 表とフローからゴーストが消える
  });

  it('名前を付けた行は Escape で削除されず取り消し（restore）に倒れる', () => {
    const s = createAppStore();
    const id = s.getState().addRootTask('large')!;
    s.getState().renameTask(id, '受付'); // 確定名が付く
    expect(nameEscapeAction(s.getState().project.core.tasks[id]!.name)).toBe('restore');
  });
});
