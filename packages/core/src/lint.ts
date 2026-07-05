// 業務リント（納品前チェック）。参照整合性（validate）に加えて「納品物として未完成」な
// 抜けを列挙する純関数。UI 非依存・決定論。検証パネル（desktop）とハンドブック出力前の
// プリフライトが共有する単一ロジック。ドメインは一切変更しない（読み取り専用）。
import type { Id, Project } from './model/types';
import { computeCodes } from './codes';
import { isMilestone } from './milestone';
import { validate, FATAL_ISSUE_KINDS } from './validate';

export type LintSeverity = 'error' | 'warn';
export type LintCategory = 'integrity' | 'procedure' | 'assignee' | 'effort' | 'issue';

export interface LintIssue {
  kind: string;          // 具体的な種別（procedure.missing / dependency.from など）
  category: LintCategory; // グルーピングの単位
  severity: LintSeverity; // error=納品を止めるべき / warn=未入力・未記入
  ref: string;            // 種別ごとの識別子（taskId / dependencyId / stepId / issueId）
  taskId?: Id;            // ジャンプ先の実在工程（解決できない整合性問題では undefined）
  issueId?: Id;          // issue.noMeasure のときの課題 id
  message: string;        // 表示メッセージ（日本語）
}

// category の固定表示順（決定論ソートの第 1 キー）。
const CATEGORY_ORDER: LintCategory[] = ['integrity', 'procedure', 'assignee', 'effort', 'issue'];

// validate() の整合性問題を実在工程へ写す。dependency→実在端点 /
// procedure.dangling*→stepId から doc.taskId 逆引き / detail.task→undefined。
function resolveIntegrityTaskId(project: Project, kind: string, ref: string): Id | undefined {
  const { tasks, dependencies } = project.core;
  if (kind === 'dependency.from' || kind === 'dependency.to' || kind === 'milestone.outgoing') {
    const d = dependencies[ref];
    if (!d) return undefined;
    // 欠落していない側の端点へ寄せる（from 欠落なら to、それ以外は from を優先）。
    return tasks[d.from] ? d.from : tasks[d.to] ? d.to : undefined;
  }
  if (kind === 'procedure.danglingTarget' || kind === 'procedure.danglingAsset') {
    for (const doc of Object.values(project.manual.procedures)) {
      if (doc.steps.some((s) => s.id === ref)) return tasks[doc.taskId] ? doc.taskId : undefined;
    }
    return undefined;
  }
  // task.parent / task.cycle / milestone.child / procedure.nonLeaf: ref は taskId。
  if (tasks[ref]) return ref;
  // detail.task ほか: 実在工程に紐づかない。
  return undefined;
}

/**
 * 業務リント。参照整合性（integrity）＋納品物としての抜け（手順書未作成・担当未割当・
 * 工数未入力・課題の方策未記入）を列挙する。決定論（category 固定順→工程No 番号順→ref）。
 *
 * 対象は葉（子を持たない）工程で milestone を除く（節目は担当・工数・手順書を持たない）。
 * 工数 0 は「未入力」とみなす（サマリと整合。意図的 0 分運用の誤検出は許容）。
 */
export function lintProject(project: Project): LintIssue[] {
  const out: LintIssue[] = [];
  const { tasks } = project.core;

  // 整合性（validate の写像）。FATAL_ISSUE_KINDS のみ error、他は warn。
  for (const v of validate(project)) {
    out.push({
      kind: v.kind,
      category: 'integrity',
      severity: FATAL_ISSUE_KINDS.has(v.kind) ? 'error' : 'warn',
      ref: v.ref,
      taskId: resolveIntegrityTaskId(project, v.kind, v.ref),
      message: v.message,
    });
  }

  // 葉工程ごとの納品物チェック（milestone 除外）。
  const hasChild = new Set<Id>();
  for (const t of Object.values(tasks)) if (t.parentId) hasChild.add(t.parentId);
  for (const t of Object.values(tasks)) {
    if (hasChild.has(t.id)) continue; // 非葉は対象外
    if (isMilestone(project.core, t.id)) continue; // 節目は対象外
    const detail = project.details[t.id];

    // 手順書未作成（doc なし or steps 0）。
    if ((project.manual.procedures[t.id]?.steps.length ?? 0) === 0) {
      out.push({ kind: 'procedure.missing', category: 'procedure', severity: 'warn', ref: t.id, taskId: t.id, message: '手順書が未作成' });
    }
    // 担当未割当。
    if (!t.assigneeId) {
      out.push({ kind: 'task.noAssignee', category: 'assignee', severity: 'warn', ref: t.id, taskId: t.id, message: '担当が未割当' });
    }
    // 工数未入力（未設定 or 0）。
    if (!detail?.effortMinutes) {
      out.push({ kind: 'task.noEffort', category: 'effort', severity: 'warn', ref: t.id, taskId: t.id, message: '工数が未入力' });
    }
    // 課題の方策未記入（課題テキストがあり方策が空。両方空はスキップ）。
    for (const iss of detail?.issues ?? []) {
      if (iss.issue.trim() && !iss.measure?.trim()) {
        out.push({
          kind: 'issue.noMeasure',
          category: 'issue',
          severity: 'warn',
          ref: iss.id,
          taskId: t.id,
          issueId: iss.id,
          message: `課題「${iss.issue}」に方策が未記入`,
        });
      }
    }
  }

  // 決定論ソート: category 固定順 → 工程No 番号順 → ref。
  const codes = computeCodes(project.core);
  const catIdx = (c: LintCategory) => CATEGORY_ORDER.indexOf(c);
  return out.sort((a, b) => {
    const c = catIdx(a.category) - catIdx(b.category);
    if (c !== 0) return c;
    const codeA = a.taskId ? codes[a.taskId] ?? '' : '';
    const codeB = b.taskId ? codes[b.taskId] ?? '' : '';
    const cc = codeA.localeCompare(codeB, undefined, { numeric: true });
    if (cc !== 0) return cc;
    return a.ref.localeCompare(b.ref);
  });
}
