// --faint ほか「情報を持つ文字色 × 背景色」の WCAG コントラスト回帰テスト（catalog #80）。
// styles.css の実トークン値を直接読み、主要ペアが AA（通常文字 4.5:1）を満たすことを固定する。
// 目的: --faint を装飾寄りに薄く戻す変更などで、列見出し等の可読性が再び基準割れするのを防ぐ。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../src/styles.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

// :root{...} / :root[data-theme='dark']{...} の各ブロックから hex トークンだけ抜き出す。
function tokensOf(selector: RegExp): Record<string, string> {
  const block = css.match(selector);
  if (!block) throw new Error(`ブロックが見つかりません: ${selector}`);
  const map: Record<string, string> = {};
  const re = /--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1]!)) !== null) map[m[1]!] = m[2]!.toLowerCase();
  return map;
}
const light = tokensOf(/:root\s*\{([\s\S]*?)\n\}/);
const dark = tokensOf(/:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/);

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const chan = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}
function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const AA = 4.5; // 通常文字（大文字/太字でも 11–12px は「大きい文字」に該当しないため 4.5:1 が必要）

describe('WCAG コントラスト（情報を持つ文字色）', () => {
  it('ライト: --faint は白パネル・淡パネル(--panel-2)上で AA を満たす（列見出し .grid th ほか）', () => {
    expect(contrast(light['faint']!, light['panel']!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(light['faint']!, light['panel-2']!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(light['faint']!, light['hdr']!)).toBeGreaterThanOrEqual(AA);
  });

  it('ライト: --muted も白パネル上で AA を満たし、--faint より濃い（階調維持）', () => {
    expect(contrast(light['muted']!, light['panel']!)).toBeGreaterThanOrEqual(AA);
    // muted は faint より前面（= より高コントラスト）＝2 段の濃淡差を保つ。
    expect(contrast(light['muted']!, light['panel']!)).toBeGreaterThan(contrast(light['faint']!, light['panel']!));
    expect(light['muted']).not.toBe(light['faint']);
  });

  it('ライト: --amber-ink は琥珀フィル上で AA を満たす（警告テキスト）', () => {
    expect(contrast(light['amber-ink']!, light['amber-fill']!)).toBeGreaterThanOrEqual(AA);
  });

  it('ダーク: --faint はパネル・背景上で AA を満たす', () => {
    expect(contrast(dark['faint']!, dark['panel']!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(dark['faint']!, dark['bg']!)).toBeGreaterThanOrEqual(AA);
  });

  it('ダーク: --muted もパネル上で AA を満たし、--faint より前面（階調維持）', () => {
    expect(contrast(dark['muted']!, dark['panel']!)).toBeGreaterThanOrEqual(AA);
    expect(contrast(dark['muted']!, dark['panel']!)).toBeGreaterThan(contrast(dark['faint']!, dark['panel']!));
    expect(dark['muted']).not.toBe(dark['faint']);
  });
});
