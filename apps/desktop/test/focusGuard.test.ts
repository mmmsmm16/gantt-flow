// #8 フォーカス乗っ取り防止のガード判定。固定キー(Enter/Delete 等)を、無関係な操作系
// (ボタン/リンク/入力/メニュー項目/タブ/contenteditable)にフォーカスがある間は
// ペインのアクションへ横取りさせない — その判定関数 isInteractiveRole / isInteractiveTarget を検証する。
// keymap.ts は DOM/React 非依存なので node 環境でそのままテストできる。
import { describe, it, expect } from 'vitest';
import { isInteractiveRole, isInteractiveTarget } from '../src/keymap';

describe('keymap: isInteractiveRole(操作系フォーカス判定)', () => {
  it('ネイティブの操作系タグは true(大小文字を問わない)', () => {
    for (const tag of ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isInteractiveRole(tag, null, false)).toBe(true);
      expect(isInteractiveRole(tag.toLowerCase(), null, false)).toBe(true);
    }
  });

  it('contenteditable は true', () => {
    expect(isInteractiveRole('DIV', null, true)).toBe(true);
  });

  it('role="menuitem" / "tab" は true', () => {
    expect(isInteractiveRole('DIV', 'menuitem', false)).toBe(true);
    expect(isInteractiveRole('LI', 'tab', false)).toBe(true);
  });

  it('フローのノード(role="button" の div)は false=Enter/Delete を横取りしない対象', () => {
    // 操作系タグでも contenteditable でもなく、role も menuitem/tab 以外 → 素通し対象外。
    expect(isInteractiveRole('DIV', 'button', false)).toBe(false);
  });

  it('ペイン自体・本文などの非操作系は false', () => {
    expect(isInteractiveRole('SECTION', null, false)).toBe(false);
    expect(isInteractiveRole('BODY', null, false)).toBe(false);
    expect(isInteractiveRole('DIV', null, false)).toBe(false);
    expect(isInteractiveRole('SVG', 'presentation', false)).toBe(false);
    expect(isInteractiveRole(null, null, false)).toBe(false);
    expect(isInteractiveRole(undefined, undefined, false)).toBe(false);
  });
});

describe('keymap: isInteractiveTarget(DOM ラッパー)', () => {
  // document.activeElement 相当を最小の Element 互換オブジェクトで代用する(node 環境)。
  const elLike = (tagName: string, opts: { role?: string | null; contentEditable?: boolean } = {}) =>
    ({
      tagName,
      getAttribute: (name: string) => (name === 'role' ? (opts.role ?? null) : null),
      isContentEditable: opts.contentEditable ?? false,
    }) as unknown as Element;

  it('null は false(フォーカスなし)', () => {
    expect(isInteractiveTarget(null)).toBe(false);
  });

  it('button/入力/メニュー項目にフォーカス中は true', () => {
    expect(isInteractiveTarget(elLike('BUTTON'))).toBe(true);
    expect(isInteractiveTarget(elLike('INPUT'))).toBe(true);
    expect(isInteractiveTarget(elLike('DIV', { role: 'menuitem' }))).toBe(true);
    expect(isInteractiveTarget(elLike('DIV', { contentEditable: true }))).toBe(true);
  });

  it('フローのノード div(role=button)やペイン section は false', () => {
    expect(isInteractiveTarget(elLike('DIV', { role: 'button' }))).toBe(false);
    expect(isInteractiveTarget(elLike('SECTION'))).toBe(false);
  });
});
