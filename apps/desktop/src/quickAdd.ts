// 工程クイック追加 DSL のパーサ（純粋関数）。パレットの「工程を追加」で
// 「受注確認 @営業 #小 2h >受注登録」のような 1 行を解釈する。
// トークンは空白区切り・順不同。@担当 / #粒度 / 数値+h|時間=工数 / >前工程 を拾い、
// 残りを空白 1 つで連結したものが工程名（＝名前に空白を含められる）。
// 同種トークンが複数あれば後勝ち（CLI フラグの慣習に合わせる）。
// 既存データとの突き合わせ（担当の部分一致・前工程の解決）は ctx 経由＝ストア非依存で、
// チップのリアルタイム表示と Enter 確定が同じ解釈を共有する。
import type { ProcessLevel } from '@gantt-flow/core';

export interface QuickAddPred {
  id: string;
  name: string;
  code?: string;
}

export interface QuickAddContext {
  /** 既存の担当名。@ の部分一致解決の対象。 */
  assigneeNames: string[];
  /** 前工程の候補。prevCandidates と同じ「同じ親・同じ粒度」の規則だが、対象の工程が
      まだ存在しないため呼び出し側でグループを絞って渡す。 */
  predecessors: QuickAddPred[];
}

export interface QuickAddParsed {
  name: string;
  /** @担当。isNew=既存名に一致せず新規作成になる。 */
  assignee?: { name: string; isNew: boolean };
  level?: ProcessLevel;
  /** 工数（時間）。 */
  effortHours?: number;
  /** >前工程。matched が無ければ一致なし（依存は張らず、チップで知らせる）。 */
  predecessor?: { input: string; matched?: QuickAddPred };
}

const LEVEL_BY_LABEL: Record<string, ProcessLevel> = {
  大: 'large',
  中: 'medium',
  小: 'small',
  詳細: 'detail',
};

// 数値+h / 数値+時間（小数可）。"2h" "0.5時間" "1.5H" など。
const EFFORT_RE = /^(\d+(?:\.\d+)?)(h|時間)$/i;

// 完全一致 → 部分一致（既存名が入力を含む）の順。複数の部分一致は渡された順の先頭。
function resolveAssignee(input: string, names: string[]): { name: string; isNew: boolean } {
  const exact = names.find((n) => n === input);
  if (exact) return { name: exact, isNew: false };
  const partial = names.find((n) => n.includes(input));
  if (partial) return { name: partial, isNew: false };
  return { name: input, isNew: true };
}

// 工程コードの完全一致 → 名称の完全一致 → 名称の部分一致の順
//（コードは "1-2" のような短い値なので部分一致させると誤爆する）。
function resolvePredecessor(input: string, cands: QuickAddPred[]): QuickAddPred | undefined {
  return (
    cands.find((c) => c.code === input) ??
    cands.find((c) => c.name === input) ??
    cands.find((c) => c.name.includes(input))
  );
}

export function parseQuickAdd(input: string, ctx: QuickAddContext): QuickAddParsed {
  const out: QuickAddParsed = { name: '' };
  const nameParts: string[] = [];
  for (const token of input.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('@')) {
      // 「@」だけ（入力途中）は無視＝チップを出さず名前にも混ぜない
      const body = token.slice(1);
      if (body) out.assignee = resolveAssignee(body, ctx.assigneeNames);
      continue;
    }
    if (token.startsWith('#')) {
      const level = LEVEL_BY_LABEL[token.slice(1)];
      if (level) {
        out.level = level;
        continue;
      }
      // 未知の #xx は粒度ではなく名前の一部（タグ風の工程名を壊さない）
      nameParts.push(token);
      continue;
    }
    if (token.startsWith('>')) {
      const body = token.slice(1);
      if (body) out.predecessor = { input: body, matched: resolvePredecessor(body, ctx.predecessors) };
      continue;
    }
    const effort = EFFORT_RE.exec(token);
    if (effort) {
      out.effortHours = Number(effort[1]);
      continue;
    }
    nameParts.push(token);
  }
  out.name = nameParts.join(' ');
  return out;
}
