// 一括構築（apply_batch / upsert_task の中核）。議事録など非構造テキストから AI が抽出した
// 構造を「1往復・原子的」に Project へ流し込む。各 op は @gantt-flow/core の純コマンドへ写像し、
// 1 つの Project を順に変換する（最後に reconcile+保存は呼び出し側=session.apply が 1 回だけ行う）。
//
// 参照解決: add/upsert_task に付けた ref(エイリアス) を、後続 op の parent/from/to/task から参照できる。
// ref は「この一括内で作る工程」を指し、既存工程は taskId をそのまま渡す。担当は assignee(名前)でも
// 指定でき、無ければ部署として自動作成（冪等: 同名は再利用）。
//
// 決定論化: uuid 直接 import と new Date() を排除し、呼び出し側から idGen/now を注入する
// （CLAUDE.md の「ID 生成は必ず idGen を注入」規約に合わせ、core 全体を UUID/時計非依存に保つ）。
import { z } from 'zod';
import {
  addTask,
  addAssignee,
  setAssignee,
  addDependency,
  updateTaskDetail,
  updateTaskToBe,
  addIoItem,
  addIssueItem,
  setTaskLevel,
  upsertProcedure,
  addStep,
  upsertAsset,
} from './commands';
import type { Project, ProcessLevel, Id, TaskDetailToBe, AssetLocator } from './model/types';
import type { TaskDetailPatch } from './commands';
import type { IdGen } from './ids';

export type BatchOp =
  | { op: 'add_task'; ref?: string; name: string; level: ProcessLevel; parent?: string; assignee?: string; assigneeId?: string; kind?: 'milestone' }
  | { op: 'upsert_task'; ref?: string; name: string; level?: ProcessLevel; parent?: string; assignee?: string; assigneeId?: string; kind?: 'milestone' }
  | { op: 'add_dependency'; from: string; to: string }
  | { op: 'set_detail'; task: string; patch: TaskDetailPatch }
  | { op: 'set_tobe'; task: string; patch: Partial<TaskDetailToBe> }
  | { op: 'add_io'; task: string; io: 'inputs' | 'outputs'; name: string; kind: 'doc' | 'info'; formInfo?: string; source?: string }
  | { op: 'add_issue'; task: string; issue: string; measure?: string }
  | { op: 'set_procedure'; task: string; purpose?: string }
  | { op: 'add_step'; task: string; action: string; why?: string; bodyMd?: string }
  | { op: 'upsert_asset'; ref?: string; id?: string; name: string; desc?: string; alias?: string; relPath?: string; url?: string };

export interface BatchResult {
  project: Project;
  aliases: Record<string, Id>; // ref -> 生成/解決された taskId（資料は assetId）
  created: { tasks: number; dependencies: number; assignees: number; ios: number; issues: number; steps: number; assets: number };
  warnings: string[];
}

/** 同じ親の中で名前一致する工程を探す（upsert 用）。 */
function findByParentAndName(p: Project, parentId: Id | undefined, name: string): Id | undefined {
  return Object.values(p.core.tasks).find(
    (t) => (t.parentId ?? undefined) === (parentId ?? undefined) && t.name === name,
  )?.id;
}

/** 担当を名前で確保（既存は再利用、無ければ部署として作成）。created で新規作成かを返す。 */
function ensureAssignee(p: Project, name: string, idGen: IdGen): { project: Project; id: Id; created: boolean } {
  const existing = Object.values(p.core.assignees).find((a) => a.name === name);
  if (existing) return { project: p, id: existing.id, created: false };
  const next = addAssignee(p, { name, kind: 'department' }, idGen);
  const id = Object.values(next.core.assignees).find((a) => a.name === name)!.id;
  return { project: next, id, created: true };
}

/** 一括 op 列を 1 つの Project へ適用する（reconcile/保存はしない）。 */
export function runBatch(p0: Project, ops: BatchOp[], idGen: IdGen, now: string): BatchResult {
  let p = p0;
  const aliases: Record<string, Id> = {};
  const created = { tasks: 0, dependencies: 0, assignees: 0, ios: 0, issues: 0, steps: 0, assets: 0 };
  const warnings: string[] = [];

  // ref(エイリアス) or 既存 taskId を解決。未解決なら警告して undefined。
  const resolve = (token: string | undefined): Id | undefined => {
    if (token === undefined) return undefined;
    if (aliases[token]) return aliases[token];
    if (p.core.tasks[token]) return token;
    warnings.push(`参照を解決できません: "${token}"（この一括で作る工程の ref か、既存の taskId を指定）`);
    return undefined;
  };
  const requireTaskRef = (token: string): Id => {
    const id = resolve(token);
    if (!id) throw new Error(`工程参照を解決できません: "${token}"`);
    return id;
  };

  const resolveAssignee = (assigneeId?: string, assignee?: string): Id | undefined => {
    if (assigneeId) {
      if (!p.core.assignees[assigneeId]) warnings.push(`担当IDが見つかりません: ${assigneeId}`);
      return assigneeId;
    }
    if (assignee && assignee.trim()) {
      const r = ensureAssignee(p, assignee.trim(), idGen);
      p = r.project;
      if (r.created) created.assignees++;
      return r.id;
    }
    return undefined;
  };

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i]!;
    const where = `op[${i}] ${o.op}`;
    try {
      switch (o.op) {
        case 'add_task': {
          const parentId = resolve(o.parent);
          const assigneeId = resolveAssignee(o.assigneeId, o.assignee);
          const id = idGen();
          p = addTask(p, { id, name: o.name, level: o.level, parentId, assigneeId, kind: o.kind }, idGen);
          if (o.ref) aliases[o.ref] = id;
          created.tasks++;
          break;
        }
        case 'upsert_task': {
          const parentId = resolve(o.parent);
          const existing = findByParentAndName(p, parentId, o.name);
          const assigneeId = resolveAssignee(o.assigneeId, o.assignee);
          if (existing) {
            // kind は新規作成時のみ適用。既存工程の kind は変更しない（core に kind 遷移コマンドが無いため）。
            if (o.level) p = setTaskLevel(p, existing, o.level);
            if (assigneeId) p = setAssignee(p, existing, assigneeId);
            if (o.ref) aliases[o.ref] = existing;
          } else {
            const id = idGen();
            p = addTask(p, { id, name: o.name, level: o.level ?? 'medium', parentId, assigneeId, kind: o.kind }, idGen);
            if (o.ref) aliases[o.ref] = id;
            created.tasks++;
          }
          break;
        }
        case 'add_dependency': {
          const from = requireTaskRef(o.from);
          const to = requireTaskRef(o.to);
          const before = Object.keys(p.core.dependencies).length;
          p = addDependency(p, from, to, idGen);
          if (Object.keys(p.core.dependencies).length > before) created.dependencies++;
          break;
        }
        case 'set_detail': {
          p = updateTaskDetail(p, requireTaskRef(o.task), o.patch);
          break;
        }
        case 'set_tobe': {
          p = updateTaskToBe(p, requireTaskRef(o.task), o.patch);
          break;
        }
        case 'add_io': {
          p = addIoItem(p, requireTaskRef(o.task), o.io, { name: o.name, kind: o.kind, formInfo: o.formInfo, source: o.source }, idGen);
          created.ios++;
          break;
        }
        case 'add_issue': {
          p = addIssueItem(p, requireTaskRef(o.task), { issue: o.issue, measure: o.measure }, idGen);
          created.issues++;
          break;
        }
        case 'set_procedure': {
          p = upsertProcedure(p, requireTaskRef(o.task), o.purpose === undefined ? {} : { purpose: o.purpose }, now);
          break;
        }
        case 'add_step': {
          p = addStep(p, requireTaskRef(o.task), { action: o.action, why: o.why, bodyMd: o.bodyMd }, idGen, now);
          created.steps++;
          break;
        }
        case 'upsert_asset': {
          const wasNew = !o.id || !p.manual.assets[o.id];
          const locator: AssetLocator | undefined =
            o.alias && o.relPath ? { alias: o.alias, relPath: o.relPath } : o.url ? { url: o.url } : undefined;
          const beforeIds = new Set(Object.keys(p.manual.assets));
          p = upsertAsset(p, { id: o.id, name: o.name, desc: o.desc, locator }, idGen);
          const newId = o.id ?? Object.keys(p.manual.assets).find((k) => !beforeIds.has(k));
          if (o.ref && newId) aliases[o.ref] = newId;
          if (wasNew) created.assets++;
          break;
        }
        default: {
          warnings.push(`未知の op: ${(o as { op: string }).op}`);
        }
      }
    } catch (e) {
      throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { project: p, aliases, created, warnings };
}

// ---- スキーマ（AI 提案の最終防衛線） ----
// apply_batch の op スキーマ（議事録等からの一括構築）。task/parent/from/to は「この一括で作る工程の
// ref(エイリアス)」か「既存 taskId」。assignee は名前指定可（無ければ部署として自動作成）。
const Level = z.enum(['large', 'medium', 'small', 'detail']);
const Automation = z.enum(['manual', 'system', 'partial']);
const Difficulty = z.enum(['H', 'M', 'L']);
const Status = z.enum(['todo', 'heard', 'review', 'done']);
const IoKind = z.enum(['doc', 'info']);

const DetailPatchShape = z.object({
  how: z.string().optional(),
  system: z.string().optional(),
  effortMinutes: z.number().nonnegative().optional(),
  ltDays: z.number().nonnegative().optional(),
  note: z.string().optional(),
  volume: z.string().optional(),
  exception: z.string().optional(),
  automation: Automation.optional(),
  dataLink: z.string().optional(),
  regulation: z.string().optional(),
  difficulty: Difficulty.optional(),
  status: Status.optional(),
});
const TobePatchShape = z.object({
  effortMinutes: z.number().nonnegative().optional(),
  ltDays: z.number().nonnegative().optional(),
  difficulty: Difficulty.optional(),
  automation: Automation.optional(),
  rationale: z.string().optional(),
  lifecycle: z.enum(['added', 'removed']).optional(),
  assigneeId: z.string().optional(),
});

export const BatchOpSchema: z.ZodType<BatchOp> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_task'), ref: z.string().optional(), name: z.string(), level: Level, parent: z.string().optional(), assignee: z.string().optional(), assigneeId: z.string().optional(), kind: z.enum(['milestone']).optional().describe('節目マーカー。子・出依存・工数を持たない') }),
  z.object({ op: z.literal('upsert_task'), ref: z.string().optional(), name: z.string(), level: Level.optional(), parent: z.string().optional(), assignee: z.string().optional(), assigneeId: z.string().optional(), kind: z.enum(['milestone']).optional().describe('節目マーカー。子・出依存・工数を持たない。新規作成時のみ適用、既存工程の kind は変更しない') }),
  z.object({ op: z.literal('add_dependency'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('set_detail'), task: z.string(), patch: DetailPatchShape }),
  z.object({ op: z.literal('set_tobe'), task: z.string(), patch: TobePatchShape }),
  z.object({ op: z.literal('add_io'), task: z.string(), io: z.enum(['inputs', 'outputs']), name: z.string(), kind: IoKind, formInfo: z.string().optional(), source: z.string().optional() }),
  z.object({ op: z.literal('add_issue'), task: z.string(), issue: z.string(), measure: z.string().optional() }),
  z.object({ op: z.literal('set_procedure'), task: z.string(), purpose: z.string().optional() }),
  z.object({ op: z.literal('add_step'), task: z.string(), action: z.string(), why: z.string().optional(), bodyMd: z.string().optional() }),
  z.object({
    op: z.literal('upsert_asset'),
    ref: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
    desc: z.string().optional(),
    alias: z.string().optional(),
    relPath: z.string().optional(),
    url: z.string().optional(),
  }),
]);

// AI 出力（構造化提案）の最終防衛線。JSON.parse と zod パースの例外はそのまま投げ、
// 呼び出し側（desktop の AI provider 層）が AiError('schema') 等へ写像する。
export const ProposalsSchema: z.ZodType<{ operations: BatchOp[] }> = z.object({
  operations: z.array(BatchOpSchema),
});

export function parseProposals(jsonText: string): { operations: BatchOp[] } {
  const parsed: unknown = JSON.parse(jsonText);
  return ProposalsSchema.parse(parsed);
}
