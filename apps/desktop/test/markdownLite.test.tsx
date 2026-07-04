// markdownLite: 各記法が React 要素へ組まれる（＝dangerouslySetInnerHTML を使わない）ことを、
// renderToStaticMarkup（DOM 不要・node 環境で動く）で確認する。XSS 安全（<script> がタグにならない）も検証。
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownLite } from '../src/markdownLite';

const html = (text: string) => renderToStaticMarkup(createElement(MarkdownLite, { text }));

describe('markdownLite', () => {
  it('**太字** を <strong> に', () => {
    expect(html('これは **重要** です')).toContain('<strong>重要</strong>');
  });

  it('行内 `コード` を <code> に', () => {
    const out = html('値は `x=1` です');
    expect(out).toContain('<code>x=1</code>');
  });

  it('箇条書き（- ）を <ul><li> に', () => {
    const out = html('- りんご\n- みかん');
    expect(out).toContain('<ul');
    expect(out).toContain('<li>りんご</li>');
    expect(out).toContain('<li>みかん</li>');
    expect(out).not.toContain('<ol');
  });

  it('番号付き（1. ）を <ol><li> に', () => {
    const out = html('1. 手順A\n2. 手順B');
    expect(out).toContain('<ol');
    expect(out).toContain('<li>手順A</li>');
    expect(out).toContain('<li>手順B</li>');
  });

  it('空行で段落（<p>）が分かれる', () => {
    const out = html('前半の段落\n\n後半の段落');
    const paras = out.match(/<p[ >]/g) ?? [];
    expect(paras.length).toBe(2);
    expect(out).toContain('前半の段落');
    expect(out).toContain('後半の段落');
  });

  it('段落内の改行は <br/> になる', () => {
    const out = html('1行目\n2行目');
    expect(out).toContain('<br/>');
    // 1 段落（<p> は 1 つ）
    expect((out.match(/<p[ >]/g) ?? []).length).toBe(1);
  });

  it('未知記法（# 見出し等）はプレーンテキストのまま出す', () => {
    const out = html('# 見出しではない');
    expect(out).not.toContain('<h1');
    expect(out).toContain('# 見出しではない');
  });

  it('XSS 安全: <script> は実行可能なタグにならずエスケープされる', () => {
    const out = html('<script>alert(1)</script> と **太字**');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('<strong>太字</strong>'); // 記法解釈は生きている
  });

  it('太字とコードが混在しても両方要素化される', () => {
    const out = html('**A** と `B`');
    expect(out).toContain('<strong>A</strong>');
    expect(out).toContain('<code>B</code>');
  });

  it('空文字列は何も描画しない', () => {
    expect(html('')).toBe('');
  });

  it('導入行 + 箇条書きが 1 ブロックでも、段落 + <ul> に分かれる', () => {
    const out = html('確認する点:\n- 品目コード\n- 単価');
    expect(out).toContain('確認する点:');
    expect(out).toContain('<ul');
    expect(out).toContain('<li>品目コード</li>');
    expect(out).toContain('<li>単価</li>');
    // 段落が箇条書きの前に来る
    expect(out.indexOf('確認する点:')).toBeLessThan(out.indexOf('<ul'));
  });
});
