// 場所エイリアス（alias → 実フォルダの絶対パス）の対応表。共有フォルダのマウント位置は
// PC ごとに違う（コンサル環境の常態）ので、.gflow には保存せず各 PC の localStorage に置く。
// keymap.ts の loadOverrides/saveOverrides（try/catch で壊れた値・保存失敗を無視する雛形）と同じ流儀。
import type { AssetLocator } from '@gantt-flow/core';

const ALIASES_KEY = 'gf-location-aliases-v1';

export function loadLocationAliases(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ALIASES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; // 壊れた保存値は無視して未登録扱い
  }
}

export function saveLocationAliases(map: Record<string, string>): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(ALIASES_KEY);
    else localStorage.setItem(ALIASES_KEY, JSON.stringify(map));
  } catch {
    /* 永続化失敗は無視（メモリ上は反映済み） */
  }
}

// base と relPath を、base の区切り文字の流儀（\ か /）に合わせて結合する。
// 二重区切り・欠落を避けるため、両端の区切りを一度剥がしてから 1 個だけ挟む。
function joinPath(base: string, relPath: string): string {
  const b = base.replace(/[\\/]+$/, '');
  const r = relPath.replace(/^[\\/]+/, '');
  if (!r) return b;
  const sep = b.includes('\\') && !b.includes('/') ? '\\' : '/';
  return `${b}${sep}${r}`;
}

export interface ResolvedLocator {
  state: 'resolved' | 'disconnected' | 'url';
  display: string;
}

// AssetLocator を表示用に解決する（純関数・localStorage には触れない＝ユニットテスト可能）。
//  - url: そのまま表示（コピー可）。
//  - alias+relPath: 対応表に alias があれば実パスへ結合（resolved）。無ければ
//    "alias/relPath" 表記のまま（disconnected＝コンサル環境の常態。エラー扱いしない）。
//  - locator 未設定: disconnected 扱い（表示は空文字＝呼び出し側が「未設定」等を出す）。
export function resolveLocator(
  locator: AssetLocator | undefined,
  aliases: Record<string, string>,
): ResolvedLocator {
  if (!locator) return { state: 'disconnected', display: '' };
  if ('url' in locator) return { state: 'url', display: locator.url };
  const base = aliases[locator.alias];
  if (base) return { state: 'resolved', display: joinPath(base, locator.relPath) };
  return { state: 'disconnected', display: `${locator.alias}/${locator.relPath}` };
}
