import { describe, it, expect } from 'vitest';
import { resolveLocator } from '../src/locationAliases';

// resolveLocator は純関数（localStorage には触れない）。3 分岐（resolved/disconnected/url）を検証する。
describe('locationAliases: resolveLocator', () => {
  it('url ロケータはそのまま表示（state=url）', () => {
    const r = resolveLocator({ url: 'https://example.com/doc' }, {});
    expect(r).toEqual({ state: 'url', display: 'https://example.com/doc' });
  });

  it('alias が対応表にあれば実パスへ結合（state=resolved）', () => {
    const r = resolveLocator(
      { alias: '営業共有', relPath: '契約\\単価契約一覧.xlsx' },
      { 営業共有: '\\\\share\\営業' },
    );
    expect(r).toEqual({ state: 'resolved', display: '\\\\share\\営業\\契約\\単価契約一覧.xlsx' });
  });

  it('alias が対応表に無ければ "alias/relPath" のまま（state=disconnected・エラーではない）', () => {
    const r = resolveLocator({ alias: '営業共有', relPath: '契約/単価契約一覧.xlsx' }, {});
    expect(r).toEqual({ state: 'disconnected', display: '営業共有/契約/単価契約一覧.xlsx' });
  });

  it('base の区切り文字が / のときは / で結合する', () => {
    const r = resolveLocator(
      { alias: 'proj', relPath: 'docs/spec.pdf' },
      { proj: '/mnt/share/proj' },
    );
    expect(r).toEqual({ state: 'resolved', display: '/mnt/share/proj/docs/spec.pdf' });
  });

  it('base 末尾のスラッシュ・relPath 先頭のスラッシュは二重にならない', () => {
    const r = resolveLocator({ alias: 'a', relPath: '/x/y.txt' }, { a: '/mnt/share/' });
    expect(r).toEqual({ state: 'resolved', display: '/mnt/share/x/y.txt' });
  });

  it('locator 未設定は disconnected 扱い・display は空文字', () => {
    const r = resolveLocator(undefined, { a: '/mnt/share' });
    expect(r).toEqual({ state: 'disconnected', display: '' });
  });
});
