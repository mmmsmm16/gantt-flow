// 検証パネル（納品前チェック）の純ロジック。core の lintProject が返す LintIssue[] を
// 「表示用のセクション」「行クリック時のジャンプ計画」「出力前サマリ文」へ変換する。
// UI 非依存（React 非 import）＝単体テスト可能。表示は ValidationDialog が担う。
import type { Core, LintCategory, LintIssue } from '@gantt-flow/core';
import { midOf } from './procShared';

// セクションの固定順とラベル。lintProject の category 固定順と一致させる。
const SECTION_DEFS: { category: LintCategory; label: string }[] = [
  { category: 'integrity', label: '整合性' },
  { category: 'procedure', label: '手順書未作成' },
  { category: 'assignee', label: '担当未割当' },
  { category: 'effort', label: '工数未入力' },
  { category: 'issue', label: '方策未記入' },
  { category: 'io', label: '帳票の受け渡し' },
];

export interface LintSection {
  category: LintCategory;
  label: string;
  issues: LintIssue[];
}

/** LintIssue[] を固定順のセクションへ束ねる。0 件のセクションは省略する。 */
export function groupLintIssues(issues: LintIssue[]): LintSection[] {
  return SECTION_DEFS.map((def) => ({
    category: def.category,
    label: def.label,
    issues: issues.filter((i) => i.category === def.category),
  })).filter((s) => s.issues.length > 0);
}

// 行クリック時のジャンプ先計画。procedure は手順書タブの章へ、他は工程表へ、
// 実在工程に紐づかない指摘（整合性の孤児など）はジャンプ不可（ref 表示のみ）。
export type LintJump =
  | { kind: 'procedure'; taskId: string; midId: string }
  | { kind: 'table'; taskId: string }
  | { kind: 'none' };

export function planLintJump(issue: LintIssue, core: Core): LintJump {
  const taskId = issue.taskId;
  if (!taskId || !core.tasks[taskId]) return { kind: 'none' };
  if (issue.category === 'procedure') {
    const midId = midOf(core, taskId);
    if (midId) return { kind: 'procedure', taskId, midId };
  }
  return { kind: 'table', taskId };
}

/**
 * 出力前サマリ文。0 件なら null（確認不要）。非 0 は固定順で「手順書未作成 3件・担当未割当 2件」形式。
 * ハンドブック出力前のプリフライト確認ダイアログに埋め込む。
 */
export function summarizeForExport(issues: LintIssue[]): string | null {
  const parts = groupLintIssues(issues).map((s) => `${s.label} ${s.issues.length}件`);
  return parts.length ? parts.join('・') : null;
}
