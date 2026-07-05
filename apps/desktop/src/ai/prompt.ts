// AI へのプロンプト構築（日本語）。ヒアリングメモ → BatchOp 列（apply_batch 語彙）への
// 変換方針を与える。mcp-server の prompts.ts `build_from_minutes` を土台に移植し、
// アプリ内アシスト（承認ゲート付き・core の parseProposals で厳密検証）向けに調整した。
import type { Project, Id } from '@gantt-flow/core';

export interface ProposalRequest {
  project: Project;
  memo: string;
  kind: 'batch' | 'procedureDraft';
  targetTaskId?: Id;
}

/**
 * システムプロンプト。BatchOp 語彙・ref 規約・「推測で数値を埋めない」方針を与える。
 * 出力は必ず `{ "operations": [ ... ] }` の JSON（他の文章を混ぜない）。
 */
export function buildSystemPrompt(): string {
  return [
    'あなたは業務改革コンサルタントを補助する AI です。ヒアリングメモ（自由テキスト）や',
    '既存プロジェクトを読み、gantt-flow の工程表・業務フローへの変更提案を作成します。',
    '',
    '出力は必ず次の形の JSON のみを返してください（前後に説明文やコードフェンスを付けない）:',
    '{ "operations": [ /* BatchOp の配列 */ ] }',
    '',
    'BatchOp の種類（op フィールドで区別）:',
    '- add_task { ref?, name, level:"large"|"medium"|"small"|"detail", parent?, assignee? }: 工程を追加。',
    '- upsert_task { ref?, name, level?, parent?, assignee? }: 同じ親・同名があれば更新、無ければ追加。',
    '- add_dependency { from, to }: 前工程 from → 後工程 to の順序依存を張る。',
    '- set_detail { task, patch }: 詳細（how 手順 / effortMinutes 分 / ltDays 日 / difficulty H|M|L / automation manual|system|partial / note 等）を設定。',
    '- set_tobe { task, patch }: To-Be（改善後）の差分を設定。',
    '- add_io { task, io:"inputs"|"outputs", name, kind:"doc"|"info", formInfo?, source? }: 入出力（帳票/情報）を追加。',
    '- add_issue { task, issue, measure? }: 業務課題と対策を追加。',
    '- set_procedure { task, purpose? }: 手順書を作成/更新（目的を1文で）。',
    '- add_step { task, action, why?, bodyMd? }: 手順ステップを追加。',
    '- upsert_asset { ref?, name, desc?, alias?, relPath?, url? }: 資料台帳を追加/更新。',
    '',
    'ref（エイリアス）規約:',
    '- 「この提案の中で新しく作る工程」を後続の op から参照するときは add_task/upsert_task に ref を付け、',
    '  add_dependency の from/to や set_detail 等の task にその ref を渡す。',
    '- 既存の工程を指すときは ref ではなく既存の taskId を渡す（メモにある工程名ではなく ID）。',
    '- 担当は assignee に部署名/氏名を書けば自動で確保される（同名は再利用）。',
    '',
    '方針:',
    '- 暗黙知の形式知化を重視（手順・工数・リードタイム・難易度）。金額/効果額は主役ではない。',
    '- メモに無い数値（工数・LT 等）は推測で埋めず、未設定のままにする。',
    '- 粒度を意識して分類する（large=業務全体 / medium=工程 / small / detail=実作業）。',
    '- 順序が読み取れる範囲で add_dependency を張る。曖昧な点は無理に確定しない。',
  ].join('\n');
}

/** 工程木を「- 中工程 (担当) [ID]」形式の概要にする（大きすぎる場合は先頭のみ）。 */
function summarizeTasks(project: Project): string {
  const tasks = Object.values(project.core.tasks);
  if (tasks.length === 0) return '（工程はまだありません）';
  const assigneeName = (id?: Id): string =>
    id ? (project.core.assignees[id]?.name ?? '') : '';
  const lines = tasks
    .slice()
    .sort((a, b) => a.level.localeCompare(b.level) || a.order - b.order)
    .slice(0, 60)
    .map((t) => {
      const who = assigneeName(t.assigneeId);
      const hasProc = project.manual.procedures[t.id] ? ' [手順書あり]' : '';
      return `- ${t.name}（${t.level}${who ? '・' + who : ''}） id=${t.id}${hasProc}`;
    });
  const more = tasks.length > 60 ? `\n… 他 ${tasks.length - 60} 件` : '';
  return lines.join('\n') + more;
}

/** 担当（部署/人）の一覧を概要にする。 */
function summarizeAssignees(project: Project): string {
  const names = Object.values(project.core.assignees).map((a) => a.name);
  return names.length ? names.join(' / ') : '（担当はまだ登録されていません）';
}

/**
 * ユーザープロンプト。プロジェクト概要（工程木・担当・既存手順書有無）＋メモ＋
 * 依頼種別（batch / procedureDraft）と対象工程を伝える。
 */
export function buildUserPrompt(req: ProposalRequest): string {
  const { project, memo, kind, targetTaskId } = req;
  const parts: string[] = [];
  parts.push(`# 現在のプロジェクト: ${project.meta.title || '(無題)'}`);
  parts.push('');
  parts.push('## 工程一覧');
  parts.push(summarizeTasks(project));
  parts.push('');
  parts.push('## 担当');
  parts.push(summarizeAssignees(project));
  parts.push('');

  if (kind === 'procedureDraft') {
    const target = targetTaskId ? project.core.tasks[targetTaskId] : undefined;
    parts.push('## 依頼: 手順書ドラフトの生成');
    if (target) {
      parts.push(
        `対象工程「${target.name}」(id=${target.id}) について、set_procedure と add_step で` +
          '実施手順のドラフトを作成してください。既存工程が対象なので task には上記の id を使うこと。',
      );
    } else {
      parts.push('対象工程が指定されていません。メモの内容から適切な工程の手順書を作成してください。');
    }
  } else {
    parts.push('## 依頼: メモからの変更提案');
    parts.push(
      'このメモを読み、上記プロジェクトへの変更提案（BatchOp 列）を作成してください。' +
        '新規に作る工程には ref を付け、既存工程を指すときは上記の id を使うこと。',
    );
  }
  parts.push('');
  parts.push('## ヒアリングメモ');
  parts.push(memo.trim() || '（メモは空です）');
  return parts.join('\n');
}
