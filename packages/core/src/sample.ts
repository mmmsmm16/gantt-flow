// サンプルプロジェクト（初回体験・デモ用）。純粋・決定論: idGen を注入して生成する。
// import（rowsToProject）と同様に core/details を直接構築し、最後に reconcileProject で flow を導出する。
// 題材は「受注〜出荷業務」: 複数部門レーン・前後関係・I/O・課題・階層（小工程）を一通り含む。
import type {
  Project,
  Id,
  ProcessLevel,
  ProcessTask,
  Dependency,
  Assignee,
  TaskDetail,
  IoKind,
  IssueTarget,
} from './model/types';
import type { IdGen } from './ids';
import { CURRENT_SCHEMA_VERSION } from './persistence/migrate';
import { reconcileProject, ensureLevelView } from './sync/reconcileProject';

export function createSampleProject(idGen: IdGen, now = '2026-01-01T00:00:00.000Z'): Project {
  const tasks: Record<Id, ProcessTask> = {};
  const dependencies: Record<Id, Dependency> = {};
  const assignees: Record<Id, Assignee> = {};
  const details: Record<Id, TaskDetail> = {};
  const orderOf = new Map<Id | undefined, number>();

  const dept = (name: string): Id => {
    const id = idGen();
    assignees[id] = { id, name, kind: 'department' };
    return id;
  };
  const task = (
    name: string,
    level: ProcessLevel,
    parentId: Id | undefined,
    assigneeId?: Id,
  ): Id => {
    const id = idGen();
    const order = orderOf.get(parentId) ?? 0;
    orderOf.set(parentId, order + 1);
    tasks[id] = { id, name, level, order, parentId, assigneeId };
    details[id] = { taskId: id };
    return id;
  };
  const detail = (taskId: Id, patch: Partial<TaskDetail>) => {
    Object.assign(details[taskId]!, patch);
  };
  const io = (taskId: Id, side: 'inputs' | 'outputs', name: string, kind: IoKind, formInfo?: string) => {
    const item = { id: idGen(), name, kind, ...(formInfo ? { formInfo } : {}) };
    (details[taskId]![side] ??= []).push(item);
  };
  const issue = (taskId: Id, text: string, measure?: string, target?: IssueTarget) => {
    const item = { id: idGen(), issue: text, ...(measure ? { measure } : {}), ...(target ? { target } : {}) };
    (details[taskId]!.issues ??= []).push(item);
  };
  const dep = (from: Id, to: Id) => {
    const id = idGen();
    dependencies[id] = { id, from, to, type: 'FS', scopeParentId: tasks[from]!.parentId };
  };

  // ---- 部門（担当＝レーン） ----
  const sales = dept('営業部');
  const credit = dept('経理部');
  const stock = dept('在庫管理');
  const warehouse = dept('倉庫');

  // ---- 大工程 ----
  const L1 = task('受注業務', 'large', undefined);
  const L2 = task('出荷業務', 'large', undefined);
  const L3 = task('請求業務', 'large', undefined);

  // ---- L1 受注業務（中工程・既定ビュー） ----
  const M1 = task('注文受付', 'medium', L1, sales);
  detail(M1, { how: '受信した注文書を受付台帳に登録し、内容を確認する。', system: '受注管理システム' });
  const M2 = task('与信確認', 'medium', L1, credit);
  detail(M2, { effortMinutes: 30, how: '取引先の与信枠を確認し、超過がないか判断する。', difficulty: 'M' });
  issue(M2, '与信枠超過時の対応フローが未整備', '経理と協議し例外処理ルートを定義する');
  const M3 = task('在庫引当', 'medium', L1, stock);
  detail(M3, { effortMinutes: 20, automation: 'partial' });
  io(M3, 'inputs', '受注伝票', 'doc', '様式A-12');
  io(M3, 'outputs', '引当結果', 'doc');
  const M4 = task('受注確定', 'medium', L1, sales);
  detail(M4, { effortMinutes: 15 });
  io(M4, 'outputs', '受注確定通知', 'doc', '取引先へ送付');

  // 注文受付（M1）の小工程
  const S1 = task('注文書受領', 'small', M1, sales);
  detail(S1, { effortMinutes: 10 });
  io(S1, 'inputs', '注文書', 'info');
  const S2 = task('内容確認', 'small', M1, sales);
  detail(S2, { effortMinutes: 15 });
  const S3 = task('システム入力', 'small', M1, sales);
  detail(S3, { effortMinutes: 20, automation: 'manual' });
  io(S3, 'outputs', '受注伝票', 'info');

  // ---- L2 出荷業務 ----
  const M5 = task('出荷指示', 'medium', L2, sales);
  detail(M5, { effortMinutes: 10 });
  const M6 = task('ピッキング', 'medium', L2, warehouse);
  detail(M6, { effortMinutes: 40 });
  const M7 = task('検品', 'medium', L2, warehouse);
  detail(M7, { effortMinutes: 30, difficulty: 'H' });
  issue(M7, '検品基準が属人的でばらつきがある', 'チェックリストを標準化し教育する');
  const M8 = task('出荷', 'medium', L2, warehouse);
  detail(M8, { effortMinutes: 25 });
  io(M8, 'outputs', '納品書', 'doc', '様式B-03');

  // ---- L3 請求業務 ----
  const M9 = task('請求書作成', 'medium', L3, credit);
  detail(M9, { effortMinutes: 30 });
  io(M9, 'outputs', '請求書', 'doc', '様式C-01');
  const M10 = task('入金確認', 'medium', L3, credit);
  detail(M10, { effortMinutes: 20 });

  // ---- 前後関係（同一スコープ内） ----
  dep(M1, M2);
  dep(M2, M3);
  dep(M3, M4);
  dep(S1, S2);
  dep(S2, S3);
  dep(M5, M6);
  dep(M6, M7);
  dep(M7, M8);
  dep(M9, M10);
  // 大工程の前後関係（受注業務 → 出荷業務 → 請求業務）。中/小の全体ビューでもブリッジで繋がる。
  dep(L1, L2);
  dep(L2, L3);

  // ---- リードタイム(As-Is) と業務難易度・To-Be（As-Is/To-Be 比較のデモ） ----
  // 工数＝タッチタイム(分) / ltDays＝経過日数(待ち含む) / toBe＝あるべき姿の差分。
  // 改善の物語: 停滞(承認・引当待ち)の削減と、暗黙知の形式知化で難易度を下げる。
  detail(S1, { ltDays: 0.5, difficulty: 'L' });
  detail(S2, { ltDays: 0.5, difficulty: 'M' });
  detail(S3, {
    ltDays: 1,
    difficulty: 'M',
    toBe: { effortMinutes: 5, ltDays: 0.2, automation: 'system', difficulty: 'L', rationale: '受注データを EDI 連携で自動取込し、手入力を廃止。' },
  });
  detail(M2, {
    ltDays: 3,
    toBe: { ltDays: 1, difficulty: 'L', rationale: 'チェック観点を10項目に形式知化し電子承認へ。若手でも一次承認でき、承認待ち 3日→1日。' },
  });
  detail(M3, {
    ltDays: 2,
    difficulty: 'M',
    // To-Be: システム自動化＋営業部へ集約（レーン移動）。
    toBe: { ltDays: 0.5, automation: 'system', assigneeId: sales, rationale: '在庫引当をシステム自動化し営業で完結。引当待ちを解消し担当も集約。' },
  });
  detail(M4, { ltDays: 1, difficulty: 'L', toBe: { ltDays: 0.5 } });
  detail(M5, { ltDays: 0.5, difficulty: 'L' });
  detail(M6, { ltDays: 1, difficulty: 'M' });
  detail(M7, {
    ltDays: 2,
    toBe: { difficulty: 'L', ltDays: 1, rationale: '検品基準をチェックリスト化し一部を画像検査で自動化。熟練の目視判断が不要になり難易度 高→低。' },
  });
  detail(M8, { ltDays: 1, difficulty: 'L' });
  detail(M9, { ltDays: 2, difficulty: 'M', toBe: { ltDays: 1, rationale: '請求データを受注から自動生成し転記を廃止。' } });
  detail(M10, { ltDays: 3, difficulty: 'M', toBe: { ltDays: 1, rationale: '入金消込を口座 API 連携で自動照合。' } });

  // ---- 構造差分のデモ（画面4: 並行化）----
  // 並行化: 与信確認→在庫引当 は As-Is 専用（To-Be では並行＝この依存を外す）。
  // M3 の担当移動（toBe.assigneeId=営業部）と合わせ、To-Be フローでレーン移動＋並行が見える。
  const depMM = Object.values(dependencies).find((dd) => dd.from === M2 && dd.to === M3);
  if (depMM) depMM.phase = 'asis';

  let project: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: {
      id: idGen(),
      title: 'サンプル：受注〜出荷業務',
      createdAt: now,
      updatedAt: now,
      appVersion: '0.0.0',
    },
    core: { tasks, dependencies, assignees },
    details,
    flow: { byLevel: [] },
  };

  // 既定で開くビュー（中・スコープ=受注業務）と全体ビュー（大）を用意して同期する。
  project = ensureLevelView(project, 'large');
  project = ensureLevelView(project, 'medium', L1);
  return reconcileProject(project, idGen);
}
