// 業務テンプレート集。新規案件の立ち上がりを速くする「種」となるプロジェクトを生成する。
// sample.ts（受注〜出荷）と同じ方針: 純粋・決定論（idGen 注入）、core/details を直接構築し
// reconcileProject で flow を導出。各テンプレートは部門レーン・前後関係・I/O・課題を一通り含む。
import type {
  Project,
  Id,
  ProcessLevel,
  ProcessTask,
  Dependency,
  Assignee,
  TaskDetail,
  IoKind,
} from './model/types';
import type { IdGen } from './ids';
import { CURRENT_SCHEMA_VERSION } from './persistence/migrate';
import { reconcileProject, ensureLevelView } from './sync/reconcileProject';
import { createSampleProject } from './sample';

// sample.ts と同じ構築 DSL（テンプレートごとに使い回す）。
function builder(idGen: IdGen) {
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
  const task = (name: string, level: ProcessLevel, parentId: Id | undefined, assigneeId?: Id): Id => {
    const id = idGen();
    const order = orderOf.get(parentId) ?? 0;
    orderOf.set(parentId, order + 1);
    tasks[id] = { id, name, level, order, parentId, assigneeId };
    details[id] = { taskId: id };
    return id;
  };
  const detail = (taskId: Id, patch: Partial<TaskDetail>) => Object.assign(details[taskId]!, patch);
  const io = (taskId: Id, side: 'inputs' | 'outputs', name: string, kind: IoKind, formInfo?: string) => {
    (details[taskId]![side] ??= []).push({ id: idGen(), name, kind, ...(formInfo ? { formInfo } : {}) });
  };
  const issue = (taskId: Id, text: string, measure?: string) => {
    (details[taskId]!.issues ??= []).push({ id: idGen(), issue: text, ...(measure ? { measure } : {}) });
  };
  const dep = (from: Id, to: Id) => {
    const id = idGen();
    dependencies[id] = { id, from, to, type: 'FS', scopeParentId: tasks[from]!.parentId };
  };
  const finish = (title: string, now: string, defaultScope: Id): Project => {
    let project: Project = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      meta: { id: idGen(), title, createdAt: now, updatedAt: now, appVersion: '0.0.0' },
      core: { tasks, dependencies, assignees },
      details,
      flow: { byLevel: [] },
      manual: { procedures: {}, assets: {} },
    };
    project = ensureLevelView(project, 'large');
    project = ensureLevelView(project, 'medium', defaultScope);
    return reconcileProject(project, idGen);
  };
  return { dept, task, detail, io, issue, dep, finish };
}

// ---- 経理月次決算 ----
function createMonthlyClosing(idGen: IdGen, now: string): Project {
  const b = builder(idGen);
  const keiri = b.dept('経理部');
  const eigyo = b.dept('営業部');
  const koubai = b.dept('購買部');

  const L1 = b.task('月次締め', 'large', undefined);
  const L2 = b.task('決算整理', 'large', undefined);
  const L3 = b.task('報告', 'large', undefined);

  const M1 = b.task('売上計上の確認', 'medium', L1, eigyo);
  b.detail(M1, { effortMinutes: 60, how: '当月売上の計上漏れ・前倒し計上がないか確認する。', system: '販売管理システム' });
  b.io(M1, 'inputs', '売上明細', 'doc');
  const M2 = b.task('仕入計上の確認', 'medium', L1, koubai);
  b.detail(M2, { effortMinutes: 60 });
  b.io(M2, 'inputs', '仕入明細', 'doc');
  const M3 = b.task('経費精算の締め', 'medium', L1, keiri);
  b.detail(M3, { effortMinutes: 90, automation: 'partial' });
  b.issue(M3, '紙の領収書精算が残っており締めが遅れる', '経費精算システムへの完全移行を検討');
  const M4 = b.task('仮勘定の整理', 'medium', L2, keiri);
  b.detail(M4, { effortMinutes: 60, difficulty: 'M' });
  const M5 = b.task('減価償却・引当金の計上', 'medium', L2, keiri);
  b.detail(M5, { effortMinutes: 45, automation: 'system' });
  const M6 = b.task('残高照合', 'medium', L2, keiri);
  b.detail(M6, { effortMinutes: 90, difficulty: 'H' });
  b.issue(M6, '銀行残高との差異原因の特定に時間がかかる', '日次での消込運用に変更する');
  const M7 = b.task('月次試算表の作成', 'medium', L3, keiri);
  b.detail(M7, { effortMinutes: 30 });
  b.io(M7, 'outputs', '月次試算表', 'doc', '様式K-01');
  const M8 = b.task('経営層への報告', 'medium', L3, keiri);
  b.detail(M8, { effortMinutes: 60 });
  b.io(M8, 'outputs', '月次報告資料', 'doc');

  b.dep(M1, M3);
  b.dep(M2, M3);
  b.dep(M4, M5);
  b.dep(M5, M6);
  b.dep(M7, M8);
  return b.finish('テンプレート：経理月次決算', now, L1);
}

// ---- 購買業務 ----
function createProcurement(idGen: IdGen, now: string): Project {
  const b = builder(idGen);
  const genba = b.dept('現場部門');
  const koubai = b.dept('購買部');
  const keiri = b.dept('経理部');

  const L1 = b.task('購買依頼', 'large', undefined);
  const L2 = b.task('発注', 'large', undefined);
  const L3 = b.task('検収・支払', 'large', undefined);

  const M1 = b.task('購買申請', 'medium', L1, genba);
  b.detail(M1, { effortMinutes: 20, how: '品目・数量・希望納期を記入して申請する。' });
  b.io(M1, 'outputs', '購買申請書', 'doc', '様式P-01');
  const M2 = b.task('申請内容の確認', 'medium', L1, koubai);
  b.detail(M2, { effortMinutes: 15 });
  const M3 = b.task('相見積の取得', 'medium', L2, koubai);
  b.detail(M3, { effortMinutes: 120, difficulty: 'M' });
  b.io(M3, 'inputs', '見積書', 'doc');
  b.issue(M3, '少額でも一律で相見積が必要で時間がかかる', '金額基準を設けて簡易ルートを作る');
  const M4 = b.task('発注先の決定', 'medium', L2, koubai);
  b.detail(M4, { effortMinutes: 30 });
  const M5 = b.task('発注書の発行', 'medium', L2, koubai);
  b.detail(M5, { effortMinutes: 15, automation: 'partial' });
  b.io(M5, 'outputs', '発注書', 'doc', '様式P-02');
  const M6 = b.task('納品・検収', 'medium', L3, genba);
  b.detail(M6, { effortMinutes: 30 });
  b.io(M6, 'inputs', '納品書', 'doc');
  b.io(M6, 'outputs', '検収報告', 'info');
  const M7 = b.task('請求書の照合', 'medium', L3, keiri);
  b.detail(M7, { effortMinutes: 20, automation: 'manual' });
  b.issue(M7, '発注書・納品書・請求書の3点照合が手作業', 'システムでの自動照合を検討');
  const M8 = b.task('支払処理', 'medium', L3, keiri);
  b.detail(M8, { effortMinutes: 15, automation: 'system' });

  b.dep(M1, M2);
  b.dep(M3, M4);
  b.dep(M4, M5);
  b.dep(M6, M7);
  b.dep(M7, M8);
  return b.finish('テンプレート：購買業務', now, L1);
}

// ---- 入社手続き ----
function createOnboarding(idGen: IdGen, now: string): Project {
  const b = builder(idGen);
  const jinji = b.dept('人事部');
  const joho = b.dept('情報システム部');
  const haizoku = b.dept('配属部署');

  const L1 = b.task('入社前準備', 'large', undefined);
  const L2 = b.task('入社日対応', 'large', undefined);
  const L3 = b.task('入社後フォロー', 'large', undefined);

  const M1 = b.task('労働条件の通知', 'medium', L1, jinji);
  b.detail(M1, { effortMinutes: 30 });
  b.io(M1, 'outputs', '労働条件通知書', 'doc', '様式J-01');
  const M2 = b.task('入社書類の回収', 'medium', L1, jinji);
  b.detail(M2, { effortMinutes: 45, automation: 'manual' });
  b.io(M2, 'inputs', '入社誓約書', 'doc');
  b.io(M2, 'inputs', 'マイナンバー届', 'doc');
  b.issue(M2, '紙書類の回収・督促に手間がかかる', '電子契約・Web フォームでの回収に切り替える');
  const M3 = b.task('アカウント・端末の準備', 'medium', L1, joho);
  b.detail(M3, { effortMinutes: 60, automation: 'partial' });
  b.issue(M3, '入社直前の依頼で端末手配が間に合わないことがある', '入社 2 週間前までの依頼ルールを徹底');
  const M4 = b.task('座席・備品の準備', 'medium', L1, haizoku);
  b.detail(M4, { effortMinutes: 30 });
  const M5 = b.task('入社手続き・オリエンテーション', 'medium', L2, jinji);
  b.detail(M5, { effortMinutes: 120 });
  const M6 = b.task('社会保険・雇用保険の手続き', 'medium', L2, jinji);
  b.detail(M6, { effortMinutes: 60, difficulty: 'M' });
  b.io(M6, 'outputs', '資格取得届', 'doc', '年金事務所へ提出');
  const M7 = b.task('配属先での受け入れ', 'medium', L2, haizoku);
  b.detail(M7, { effortMinutes: 60 });
  const M8 = b.task('試用期間レビュー', 'medium', L3, haizoku);
  b.detail(M8, { effortMinutes: 60 });
  b.io(M8, 'outputs', '評価シート', 'doc');

  b.dep(M1, M2);
  b.dep(M5, M6);
  b.dep(M5, M7);
  return b.finish('テンプレート：入社手続き', now, L1);
}

export interface TemplateInfo {
  key: string;
  title: string;
  description: string;
  create: (idGen: IdGen, now?: string) => Project;
}

// テンプレート一覧（先頭＝既定のサンプル）。
export const TEMPLATES: TemplateInfo[] = [
  {
    key: 'order-to-ship',
    title: '受注〜出荷業務',
    description: '受注・出荷・請求の流れ。階層と I/O・課題を一通り含む標準サンプル。',
    create: (idGen, now = '2026-01-01T00:00:00.000Z') => createSampleProject(idGen, now),
  },
  {
    key: 'monthly-closing',
    title: '経理月次決算',
    description: '売上・仕入の締めから試算表作成、経営層への報告まで。',
    create: (idGen, now = '2026-01-01T00:00:00.000Z') => createMonthlyClosing(idGen, now),
  },
  {
    key: 'procurement',
    title: '購買業務',
    description: '購買申請から相見積・発注・検収・支払までの定番フロー。',
    create: (idGen, now = '2026-01-01T00:00:00.000Z') => createProcurement(idGen, now),
  },
  {
    key: 'onboarding',
    title: '入社手続き',
    description: '入社前準備〜入社日対応〜フォローまで。人事・情シス・配属部署の連携。',
    create: (idGen, now = '2026-01-01T00:00:00.000Z') => createOnboarding(idGen, now),
  },
];
