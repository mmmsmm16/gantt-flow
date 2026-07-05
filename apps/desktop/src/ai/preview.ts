// AI プレビューの id 安定化（危険地帯 4 の確定設計）。
//
// 生成完了時に **一度だけ** buildAiPreview を呼び、決定論 idGen（makePreviewIdGen）と固定 now で
// runBatch → reconcileProject → tidy し、view と nodeMap の id を固定する。以後、承認/否認
// （decisions の変化）では **再 runBatch しない**（表示スタイル/可視性だけ変える）。適用は
// resolveApproved の ops を本番 uuid で runBatch し直す（store.applyApprovedBatch）。
//
// 決定論: makePreviewIdGen を 1 インスタンスだけ作り、runBatch と reconcileProject の両方へ
// 同じ実例を渡す。これでビルド内では id が衝突せず、ビルド間では同じ ops → 同じ id 列（＝
// preview.result.project / nodeMap が deep-equal）になる。本番 uuid とは別空間。
import {
  runBatch,
  reconcileProject,
  ensureLevelView,
  tidyFlowView,
  type BatchOp,
  type BatchResult,
  type Project,
  type ProcessLevel,
  type FlowLevelView,
  type IdGen,
} from '@gantt-flow/core';
import { buildProposalNodeMap, type ProposalNodeMap } from './decisions';

export const PREVIEW_NOW = '2026-07-05T00:00:00.000Z';

/** プレビュー専用の決定論カウンタ（毎ビルド同一 seed・本番 uuid とは別空間）。 */
export function makePreviewIdGen(): IdGen {
  let n = 0;
  return () => `aiprev-${++n}`;
}

export interface AiPreview {
  /** 編集畳み込み済み・ref 注入済みの ops（生成時に固定。resolveApproved/適用もこれを使う）。 */
  ops: BatchOp[];
  /** runBatch(project, ops, makePreviewIdGen(), PREVIEW_NOW) の結果。 */
  result: BatchResult;
  /** reconcile + tidy 済みプレビューフロー（対象 level）。 */
  view: FlowLevelView;
  nodeMap: ProposalNodeMap;
}

// runBatch 前に ref を付与する対象（後続 op から index で全生成物を引けるようにする）。
const PRODUCER_OPS: ReadonlySet<BatchOp['op']> = new Set(['add_task', 'upsert_task', 'upsert_asset']);

/** task/資料生成 op に `ref = op.ref ?? '__p'+index` を付け、aliases を全生成物の全単射にする。 */
function injectRefs(ops: BatchOp[]): BatchOp[] {
  return ops.map((o, i) =>
    PRODUCER_OPS.has(o.op) && (o as { ref?: string }).ref === undefined
      ? ({ ...o, ref: `__p${i}` } as BatchOp)
      : o,
  );
}

/**
 * 生成直後に一度だけ呼ぶ（全 op で runBatch → reconcile）。decisions 変更では呼ばない。
 * scenarioFlow と同じ射影経路（ensureLevelView → reconcileProject → tidyFlowView）で対象 level の
 * view を得る。**全 op（却下含む）で作る**ので view は全提案ノードを含む。
 */
export function buildAiPreview(
  project: Project,
  ops: BatchOp[],
  level: ProcessLevel,
  scopeParentId?: string,
): AiPreview {
  const injected = injectRefs(ops);
  const idGen = makePreviewIdGen(); // runBatch と reconcile で共有（衝突回避＋決定論）
  const result = runBatch(project, injected, idGen, PREVIEW_NOW);

  // flow は作り直す（scenarioFlow と同じ。手動配置は適用後の reconcile が正しく再構築する）。
  let tmp: Project = { ...result.project, flow: { byLevel: [] } };
  tmp = ensureLevelView(tmp, level, scopeParentId);
  tmp = reconcileProject(tmp, idGen);
  const base = tmp.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );
  const view: FlowLevelView = base
    ? tidyFlowView(tmp.core, tmp.details, base)
    : { level, scopeParentId, nodes: {}, edges: {}, lanes: {}, orientation: 'horizontal' };

  const nodeMap = buildProposalNodeMap(injected, result);
  return { ops: injected, result, view, nodeMap };
}
