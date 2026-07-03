// 形式知化の進捗ドライバ。末端工程（子を持たない＝実作業）の「入力欠落」と「聞くべき質問」を出す。
// 暗黙知の形式知化が施策の主役なので、手順(how)・難易度(ベテラン依存度)・工数・LT を重く見る。
import { computeCodes, type Project, type Id, type TaskDetail } from '@gantt-flow/core';

interface FieldCheck {
  label: string;
  question: string;
  filled: (d: TaskDetail | undefined) => boolean;
  weight: number;
}

// weight=2 は形式知化/定量化の中心（手順・難易度・工数）。
const CHECKS: FieldCheck[] = [
  { label: '手順(how)', question: '具体的な手順・やり方は？（暗黙知の形式知化の中心）', filled: (d) => !!d?.how?.trim(), weight: 2 },
  { label: '難易度', question: 'ベテランでないとできない作業？（H=ベテラン依存 / M / L=誰でも）', filled: (d) => !!d?.difficulty, weight: 2 },
  { label: '工数(分)', question: '1回あたりの作業時間は何分？（タッチタイム）', filled: (d) => d?.effortMinutes !== undefined, weight: 2 },
  { label: 'リードタイム(日)', question: '着手〜完了の経過日数は？（待ち・停滞含む）', filled: (d) => d?.ltDays !== undefined, weight: 1 },
  { label: '自動化区分', question: '手作業 / 一部自動 / システム のどれ？', filled: (d) => !!d?.automation, weight: 1 },
  { label: '入出力', question: '入力・出力する帳票や情報は？（どこから来て、どこへ渡すか）', filled: (d) => !!(d?.inputs?.length || d?.outputs?.length), weight: 1 },
];

export interface TaskAudit {
  taskId: Id;
  code: string;
  name: string;
  completeness: number; // 0-100
  missing: { label: string; question: string }[];
}

/** 末端工程のみ監査（工数・手順は末端に入力する設計のため）。完成度の低い順に並べる。 */
export function auditLeafTasks(p: Project): TaskAudit[] {
  const codes = computeCodes(p.core);
  const hasChild = new Set(
    Object.values(p.core.tasks)
      .map((t) => t.parentId)
      .filter((x): x is Id => !!x),
  );
  const totalW = CHECKS.reduce((s, c) => s + c.weight, 0);
  const leaves = Object.values(p.core.tasks).filter((t) => !hasChild.has(t.id));
  return leaves
    .map((t) => {
      const d = p.details[t.id];
      let filledW = 0;
      const missing: { label: string; question: string }[] = [];
      for (const c of CHECKS) {
        if (c.filled(d)) filledW += c.weight;
        else missing.push({ label: c.label, question: c.question });
      }
      return {
        taskId: t.id,
        code: codes[t.id] ?? '?',
        name: t.name || '(無題)',
        completeness: Math.round((100 * filledW) / totalW),
        missing,
      };
    })
    .sort(
      (a, b) =>
        a.completeness - b.completeness ||
        a.code.localeCompare(b.code, undefined, { numeric: true }),
    );
}

/** 監査結果をヒアリング向けテキストに整形（未完成の工程＝次に聞くべき所を上に）。 */
export function formatAudit(p: Project, opts: { onlyIncomplete?: boolean; limit?: number } = {}): string {
  const all = auditLeafTasks(p);
  if (all.length === 0) return '末端工程がありません（先に工程を作成してください）。';
  const avg = Math.round(all.reduce((s, a) => s + a.completeness, 0) / all.length);
  const target = (opts.onlyIncomplete ? all.filter((a) => a.completeness < 100) : all).slice(
    0,
    opts.limit ?? 30,
  );
  if (target.length === 0) return `全 ${all.length} 末端工程が入力済みです（完成度 100%）。`;
  const lines = target.map((a) => {
    if (a.missing.length === 0) return `✓ ${a.code} ${a.name}（100%）`;
    const qs = a.missing.map((m) => `    - ${m.label}: ${m.question}`).join('\n');
    return `□ ${a.code} ${a.name}（${a.completeness}%）未入力: ${a.missing.map((m) => m.label).join('・')}\n  聞くべきこと:\n${qs}  {id:${a.taskId}}`;
  });
  return `形式知化の進捗: 末端 ${all.length} 工程 / 平均完成度 ${avg}%\n${lines.join('\n')}`;
}
