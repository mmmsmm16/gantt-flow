// AI 提案の承認データ層（純関数・UI 非依存・単体テスト）。
//
// 承認 UI（カード／フロー）は「op index → 判定」の DecisionMap と「op index → インライン修正」の
// EditMap だけを持つ。プレビュー（フロー図・カード表示）は生成直後に一度だけ固定した id を使い、
// decisions の変化では再計算しない（危険地帯 4）。ここは:
//  - resolveApproved: ref-DAG の却下波及（producer が否認/無効なら下流も無効・fixpoint）。
//  - applyEdits: 名称/担当のインライン修正を ops へ畳み込む（表示ラベル＋最終適用の両方で使用）。
//  - buildProposalNodeMap: 提案 op ⇔ プレビューノード（taskId）の対応（危険地帯 5）。
import type { BatchOp, BatchResult, Id } from '@gantt-flow/core';

export type DecisionState = 'pending' | 'approved' | 'rejected';
/** op index -> 判定（未登録 = 'pending'）。 */
export type DecisionMap = Record<number, DecisionState>;
/** インライン修正（v1 は名称・担当）。 */
export interface ProposalEdit {
  name?: string;
  assignee?: string;
}
export type EditMap = Record<number, ProposalEdit>;

/** 却下波及で下流を無効にした理由（UI 表示・フロー/カード共通）。 */
export const DISABLED_REASON = '依存先が否認されたため';
/** 適用直前フィルタ（filterApplicable）で除外した理由。トースト集計と適用バーの注記で共用する。 */
export const NOT_APPROVED_REASON = '依存先が未承認のため';

// producer になれる op（ref を宣言して後続 op から参照される）。
const PRODUCER_OPS: ReadonlySet<BatchOp['op']> = new Set(['add_task', 'upsert_task', 'upsert_asset']);

/** この op が「消費する ref（この一括で作る工程/資料への参照）」を集める。既存 taskId 参照も
    ここに含むが、producedBy に無い token は下流無効化に関与しない（＝既存参照は不干渉）。 */
function consumedRefs(o: BatchOp): string[] {
  switch (o.op) {
    case 'add_task':
    case 'upsert_task':
      return o.parent ? [o.parent] : [];
    case 'add_dependency':
      return [o.from, o.to];
    case 'set_detail':
    case 'set_tobe':
    case 'add_io':
    case 'add_issue':
    case 'set_procedure':
    case 'add_step':
      return [o.task];
    default:
      return [];
  }
}

/**
 * ref-DAG の却下波及を fixpoint で解く。producer(ref を持つ add_task/upsert_task/upsert_asset)が
 * rejected か既に disabled なら、その ref を消費する下流 op を disabled（理由付き）にし、連鎖させる。
 * 既存 taskId を指す消費は無効化しない（producedBy に無いため）。
 * apply = decisions[i]==='approved' かつ !disabled.has(i)（未判定=pending は適用しない）。
 */
export function resolveApproved(
  ops: BatchOp[],
  decisions: DecisionMap,
): { apply: number[]; disabled: Map<number, string> } {
  // ref -> それを生成する producer op の index。
  const producedBy = new Map<string, number>();
  ops.forEach((o, i) => {
    const ref = (o as { ref?: string }).ref;
    if (PRODUCER_OPS.has(o.op) && ref) producedBy.set(ref, i);
  });

  const decisionOf = (i: number): DecisionState => decisions[i] ?? 'pending';
  const disabled = new Map<number, string>();

  // bands.ts / tidy.ts と同様、変化が無くなるまで反復して連鎖を収束させる。
  let changed = true;
  while (changed) {
    changed = false;
    ops.forEach((o, i) => {
      if (disabled.has(i)) return;
      for (const ref of consumedRefs(o)) {
        const p = producedBy.get(ref);
        if (p === undefined || p === i) continue; // 既存参照 or 自己参照は不干渉
        if (decisionOf(p) === 'rejected' || disabled.has(p)) {
          disabled.set(i, DISABLED_REASON);
          changed = true;
          break;
        }
      }
    });
  }

  const apply: number[] = [];
  ops.forEach((_o, i) => {
    if (decisionOf(i) === 'approved' && !disabled.has(i)) apply.push(i);
  });
  return { apply, disabled };
}

/**
 * 適用直前の第二フィルタ（レビュー指摘: pending producer + approved consumer の適用時穴）。
 * resolveApproved は「decisions が rejected/disabled」の波及だけを見るため、producer が
 * **pending のまま**（否認ではない）で consumer だけ承認された場合を素通りさせてしまう。
 * ここでは applyIdx（resolveApproved.apply）に対し、consumedRefs の producer が同じく
 * applyIdx に含まれない消費 op を fixpoint で除外する。既存 taskId 参照（producedBy に無い
 * token）は producer が無いので除外しない。
 */
export function filterApplicable(
  ops: BatchOp[],
  applyIdx: number[],
): { apply: number[]; excluded: Map<number, string> } {
  const producedBy = new Map<string, number>();
  ops.forEach((o, i) => {
    const ref = (o as { ref?: string }).ref;
    if (PRODUCER_OPS.has(o.op) && ref) producedBy.set(ref, i);
  });

  const applySet = new Set(applyIdx);
  const excluded = new Map<number, string>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const i of applyIdx) {
      if (excluded.has(i)) continue;
      for (const ref of consumedRefs(ops[i]!)) {
        const p = producedBy.get(ref);
        if (p === undefined || p === i) continue; // 既存参照 or 自己参照は不干渉
        if (!applySet.has(p) || excluded.has(p)) {
          excluded.set(i, NOT_APPROVED_REASON);
          applySet.delete(i);
          changed = true;
          break;
        }
      }
    }
  }

  const apply = applyIdx.filter((i) => !excluded.has(i));
  return { apply, excluded };
}

/** 承認確定バーが必要とする「実適用プラン」。resolveApproved（却下波及）→ filterApplicable
    （pending producer の第二フィルタ）を貫き、実際に適用される index と見送り分をまとめて返す。 */
export interface ApplyPlan {
  /** 実際に適用する op の index。 */
  applyIdx: number[];
  /** 依存先未承認で見送った index → 理由。 */
  excluded: Map<number, string>;
}
export function planApply(ops: BatchOp[], decisions: DecisionMap): ApplyPlan {
  const { apply } = resolveApproved(ops, decisions);
  const { apply: applyIdx, excluded } = filterApplicable(ops, apply);
  return { applyIdx, excluded };
}

/**
 * インライン修正（名称・担当）を ops へ畳み込む。id は揺らさない（承認状態の対応が壊れない）。
 * 名称は工程/資料 op の name、担当は工程 op の assignee に反映（assigneeId はクリアして名前解決に寄せる）。
 */
export function applyEdits(ops: BatchOp[], edits: EditMap): BatchOp[] {
  return ops.map((o, i) => {
    const e = edits[i];
    if (!e) return o;
    if (o.op === 'add_task' || o.op === 'upsert_task') {
      const patched = { ...o };
      if (e.name !== undefined) patched.name = e.name;
      if (e.assignee !== undefined) {
        patched.assignee = e.assignee;
        patched.assigneeId = undefined; // 名前指定を優先させる
      }
      return patched;
    }
    if (o.op === 'upsert_asset') {
      return e.name !== undefined ? { ...o, name: e.name } : o;
    }
    return o;
  });
}

/** 提案 op ⇔ プレビューノードの対応（危険地帯 5）。preview の aliases/created と突合する。 */
export interface ProposalNodeMap {
  /** 工程を生成/対象にする op -> ノード taskId。 */
  opToTaskId: Map<number, Id>;
  /** 逆引き（1 ノードに複数 op = バッジ）。 */
  taskIdToOps: Map<Id, number[]>;
  /** add_dependency op -> [fromTaskId, toTaskId]。 */
  edgeOps: Map<number, [Id, Id]>;
  /** フローに置けない op（set_procedure/add_step/add_issue/set_detail/set_tobe/upsert_asset）。 */
  nonFlowOps: number[];
}

/**
 * 提案 op とプレビュー（runBatch 結果）のノード対応を作る。呼び出し側（buildAiPreview）は
 * runBatch 前に task/資料生成 op へ `ref = op.ref ?? '__p'+index` を付与しているので、aliases が
 * 全生成物を index で引ける全単射になっている。対象系（set_ 系 / add_io / add_issue / add_step）は
 * task を aliases/既存 id で解決した taskId へ寄せる。
 */
export function buildProposalNodeMap(ops: BatchOp[], preview: BatchResult): ProposalNodeMap {
  const { aliases, project } = preview;
  const opToTaskId = new Map<number, Id>();
  const taskIdToOps = new Map<Id, number[]>();
  const edgeOps = new Map<number, [Id, Id]>();
  const nonFlowOps: number[] = [];

  const resolveTask = (token: string | undefined): Id | undefined => {
    if (token === undefined) return undefined;
    if (aliases[token]) return aliases[token];
    return project.core.tasks[token] ? token : undefined;
  };
  const link = (i: number, taskId: Id | undefined) => {
    if (!taskId) return;
    opToTaskId.set(i, taskId);
    const arr = taskIdToOps.get(taskId) ?? [];
    arr.push(i);
    taskIdToOps.set(taskId, arr);
  };

  ops.forEach((o, i) => {
    switch (o.op) {
      case 'add_task':
      case 'upsert_task':
        link(i, o.ref ? aliases[o.ref] : undefined);
        break;
      case 'add_dependency': {
        const from = resolveTask(o.from);
        const to = resolveTask(o.to);
        if (from && to) edgeOps.set(i, [from, to]);
        break;
      }
      case 'add_io':
        // I/O（帳票/情報）はフロー上の doc ノードとして描ける＝対象工程へ紐付く。
        link(i, resolveTask(o.task));
        break;
      case 'set_detail':
      case 'set_tobe':
      case 'add_issue':
      case 'set_procedure':
      case 'add_step':
        link(i, resolveTask(o.task)); // 対象ノードへバッジで存在を示す
        nonFlowOps.push(i);
        break;
      case 'upsert_asset':
        nonFlowOps.push(i); // 資料台帳はフローに描けない（カードのみ）
        break;
    }
  });

  return { opToTaskId, taskIdToOps, edgeOps, nonFlowOps };
}
