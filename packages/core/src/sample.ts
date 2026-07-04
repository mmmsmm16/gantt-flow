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
  ProcedureDoc,
  ProcedureStep,
  StepCond,
  StepRef,
  AssetRef,
  AssetLocator,
} from './model/types';
import type { IdGen } from './ids';
import { CURRENT_SCHEMA_VERSION } from './persistence/migrate';
import { reconcileProject, ensureLevelView } from './sync/reconcileProject';

export function createSampleProject(idGen: IdGen, now = '2026-01-01T00:00:00.000Z'): Project {
  const tasks: Record<Id, ProcessTask> = {};
  const dependencies: Record<Id, Dependency> = {};
  const assignees: Record<Id, Assignee> = {};
  const details: Record<Id, TaskDetail> = {};
  const procedures: Record<Id, ProcedureDoc> = {};
  const assets: Record<Id, AssetRef> = {};
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
  const io = (taskId: Id, side: 'inputs' | 'outputs', name: string, kind: IoKind, formInfo?: string): Id => {
    const id = idGen();
    const item = { id, name, kind, ...(formInfo ? { formInfo } : {}) };
    (details[taskId]![side] ??= []).push(item);
    return id;
  };
  const issue = (taskId: Id, text: string, measure?: string, target?: IssueTarget) => {
    const item = { id: idGen(), issue: text, ...(measure ? { measure } : {}), ...(target ? { target } : {}) };
    (details[taskId]!.issues ??= []).push(item);
  };
  const dep = (from: Id, to: Id) => {
    const id = idGen();
    dependencies[id] = { id, from, to, type: 'FS', scopeParentId: tasks[from]!.parentId };
  };
  // ---- 手順書・資料台帳（末端工程のみに付与。 conds/refs の対象は実在 ID を直接参照する） ----
  const asset = (name: string, desc: string, locator: AssetLocator): Id => {
    const id = idGen();
    assets[id] = { id, name, desc, locator };
    return id;
  };
  const step = (
    action: string,
    why: string,
    bodyMd: string,
    conds: Array<Omit<StepCond, 'id'>> = [],
    refs: StepRef[] = [],
  ): ProcedureStep => ({
    id: idGen(),
    action,
    why,
    bodyMd,
    conds: conds.map((c) => ({ id: idGen(), ...c })),
    refs,
    images: [], // バイナリはサンプルに同梱できないため空のまま
  });
  const procedure = (taskId: Id, purpose: string, steps: ProcedureStep[]) => {
    procedures[taskId] = {
      taskId,
      purpose,
      steps,
      updatedAt: now,
      revisions: [{ at: now, note: '初版', by: 'サンプル' }],
    };
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
  const ioM3OrderSlip = io(M3, 'inputs', '受注伝票', 'doc', '様式A-12');
  io(M3, 'outputs', '引当結果', 'doc');
  const M4 = task('受注確定', 'medium', L1, sales);
  detail(M4, { effortMinutes: 15 });
  io(M4, 'outputs', '受注確定通知', 'doc', '取引先へ送付');

  // 注文受付（M1）の小工程
  const S1 = task('注文書受領', 'small', M1, sales);
  detail(S1, { effortMinutes: 10 });
  const ioS1OrderDoc = io(S1, 'inputs', '注文書', 'info');
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

  // ---- 構造差分のデモ（画面4: 並行化＋担当移動）----
  // 並行化: As-Is は 注文受付→与信確認→在庫引当 の直列。To-Be では 与信確認 と 在庫引当 を
  // 注文受付の直後に並行で走らせる。= 与信確認→在庫引当(M2→M3) を As-Is 専用にし、
  // 代わりに 注文受付→在庫引当(M1→M3) を To-Be 専用で張る（在庫引当が先頭で注文受付と重ならないよう、
  // 注文受付の後ろ＝同じ列に与信確認と並ぶ）。M3 の担当移動(toBe.assigneeId=営業部)と合わせて見える。
  const depMM = Object.values(dependencies).find((dd) => dd.from === M2 && dd.to === M3);
  if (depMM) depMM.phase = 'asis';
  dep(M1, M3);
  const depM1M3 = Object.values(dependencies).find((dd) => dd.from === M1 && dd.to === M3);
  if (depM1M3) depM1M3.phase = 'tobe';

  // ---- 資料台帳（未接続の共有フォルダ参照＋URL参照のデモ） ----
  const assetFormList = asset(
    '注文書様式一覧',
    'FAX・メール・EDI 別の注文書サンプルと必須記載項目の一覧。受付時の確認に使用する。',
    { alias: '営業共有', relPath: '受注/注文書様式一覧.xlsx' },
  );
  const assetCreditChecklist = asset(
    '与信確認チェックリスト',
    '与信枠確認時に埋める確認項目一覧。残枠が僅差の場合は全項目の記入が必須。',
    { alias: '経理共有', relPath: '与信管理/与信確認チェックリスト.xlsx' },
  );
  const assetShortageManual = asset(
    '欠品時対応マニュアル',
    '欠品発生時の代替品・分納の判断フローと取引先連絡テンプレートをまとめた社内 wiki。',
    { url: 'https://wiki.example.local/manuals/shortage-handling' },
  );

  // ---- 手順書（末端工程のみ。受注業務の入口〜与信〜引当の 3 工程で使い方が一望できるように） ----
  procedure(S1, '取引先から届いた注文書を受け取り、記載内容に不備がないか確認したうえで受付台帳に登録する。', [
    step(
      '注文書の受信経路を確認する',
      '経路によって様式や確認すべき項目が異なるため。',
      '受信経路ごとに確認ポイントが異なる。\n\n' +
        '- **FAX**: 数字や押印のかすれがないか目視で確認する\n' +
        '- **メール添付**: 添付形式が `PDF` であることを確認する（`.xlsx` 原本の直送は差し戻し）\n' +
        '- **EDI**: システム自動取込のため本ステップは省略可\n\n' +
        '**教訓**: 以前 FAX の数量欄「1,000」を「1,900」と読み違え、欠品騒ぎになったことがある。数字が不鮮明な場合は必ず電話で読み合わせること。',
      [{ when: 'FAXの記載が不鮮明な場合', thenMd: '取引先へ電話で読み合わせを行い、`受付台帳` の備考欄に確認済みである旨を記載する。' }],
      [{ kind: 'asset', assetId: assetFormList }],
    ),
    step(
      '記載内容を確認し、受付台帳へ登録する',
      '後工程（与信確認・在庫引当）の起点になるため、抜け漏れがあると下流の手戻りが大きい。',
      '受付台帳への登録前に、最低限以下を確認する。\n\n' +
        '1. 取引先名・担当者名\n' +
        '2. 品目コードと数量\n' +
        '3. 希望納期\n\n' +
        '**特に希望納期は要注意** — 空欄のまま与信確認に回すとスケジュールが立てられず差し戻しになる。必ず本人に確認してから次工程へ渡すこと。',
      [{ when: '希望納期が未記入の場合', thenMd: '担当者に確認して補記する。確認が取れるまで与信確認には回さない。', targetTaskId: M2 }],
      [{ kind: 'io', taskId: S1, ioId: ioS1OrderDoc }],
    ),
  ]);

  procedure(M2, '取引先の与信枠に対して今回受注額が収まっているかを確認し、超過時は例外処理へ回す。', [
    step(
      '与信管理システムで取引先の与信枠と残高を照会する',
      '与信枠超過での出荷は貸倒れリスクに直結するため、必ずシステムで確認する（記憶や勘に頼らない）。',
      '確認手順:\n\n' +
        '- 与信管理システムに取引先コードを入力し残枠を照会する\n' +
        '- 今回受注額 + 既存の未回収額 が残枠内か確認する\n' +
        '- 残枠ギリギリの場合は `与信確認チェックリスト` の全項目を必ず埋める\n\n' +
        '**教訓**: 以前「たぶん大丈夫」と口頭判断で確定させ、後日超過が発覚して説明対応に追われたことがある。必ずシステムの数字で確認し、チェックリストへの記入を省略しない。',
      [],
      [{ kind: 'asset', assetId: assetCreditChecklist }],
    ),
    step(
      '超過の有無を判定し、必要なら例外承認へ回す',
      '超過時は与信の例外処理フローが必要なため（現状ルール未整備、要協議）。',
      '判定基準:\n\n' +
        '- 残枠内 → そのまま在庫引当へ回す\n' +
        '- 超過 → 上長へ一次報告のうえ `例外与信申請書` を起票する\n\n' +
        '超過時の承認ルートはまだ明文化されておらず、都度上長判断になっている（別途整備が必要な既知課題）。',
      [{ when: '与信枠を超過している場合', thenMd: '在庫引当には進めず、上長へ一次報告のうえ例外与信申請書を起票する。', targetTaskId: M3 }],
      [],
    ),
  ]);

  procedure(M3, '受注内容に対して引き当てる在庫を確保し、欠品時は代替手配を判断する。', [
    step(
      '在庫システムで対象品目の引当可能数を確認する',
      '在庫データがリアルタイムでない拠点があり、実在庫との差異が起きうるため目視確認が必要。',
      '引当可否の確認手順:\n\n' +
        '- 在庫システムで品目コードごとの引当可能数を照会する\n' +
        '- `受注伝票`（様式A-12）の数量と突き合わせる\n' +
        '- 倉庫によっては在庫データの反映が半日ほど遅れるため、僅差のときは倉庫へ電話で実在庫を確認する\n\n' +
        '**教訓**: 以前システム上は「引当可」だったが実際は先約で欠品しており、出荷直前に発覚して謝罪対応になったことがある。僅差のときはシステムを鵜呑みにしない。',
      [],
      [{ kind: 'io', taskId: M3, ioId: ioM3OrderSlip }],
    ),
    step(
      '引当結果を登録し、欠品時は代替手配を判断する',
      '欠品のまま次工程（受注確定）に進むと出荷遅延の連絡が後手に回るため。',
      '欠品時の判断フロー:\n\n' +
        '1. 代替品・分納の可否を営業部に確認する\n' +
        '2. 可能なら `引当結果` に代替内容を明記する\n' +
        '3. 不可なら受注確定を保留し、営業から取引先へ連絡する\n\n' +
        '手順の詳細は資料台帳の `欠品時対応マニュアル` を参照。',
      [{ when: '欠品が発生した場合', thenMd: '受注確定には進めず、注文受付へ差し戻して代替手配の可否を確認する。', targetTaskId: M1 }],
      [{ kind: 'asset', assetId: assetShortageManual }],
    ),
  ]);

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
    manual: { procedures, assets },
  };

  // 既定で開くビュー（中・スコープ=受注業務）と全体ビュー（大）を用意して同期する。
  project = ensureLevelView(project, 'large');
  project = ensureLevelView(project, 'medium', L1);
  return reconcileProject(project, idGen);
}
