// AI アシストパネル（右ドロワー・モック §2 メモ入力 / §4 カードリスト / §5 適用バー）。
// AssetLedger（aside.drawer）の前例に倣い、aiPanelOpen でマウントする条件つきドロワー。
//
// 承認データは軽量な zustand ストア `useAiSession` に集約する（カードとフロー＝Task 4 の
// AiFlowPreview が同一 decisions/edits/preview を共有するため、パネル外に置く）。プレビューの
// id 安定（危険地帯 4）: 生成完了時に一度だけ buildAiPreview し、以後 decisions 変更では
// 再 runBatch せず表示スタイルだけ変える。適用は resolveApproved の ops を本番 uuid で適用する。
import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { BatchOp } from '@gantt-flow/core';
import { useApp } from '../store';
import { useUI } from './useUI';
import { cancelEditOnEscape, selectAllOnFocus } from '../inputBehaviors';
import {
  requestProposals,
  AiError,
  AI_ERROR_TEXT,
  MockAiProvider,
  type AiProvider,
} from '../ai/provider';
import { buildAiPreview, type AiPreview } from '../ai/preview';
import {
  resolveApproved,
  applyEdits,
  type DecisionState,
  type DecisionMap,
  type EditMap,
  type ProposalEdit,
} from '../ai/decisions';

const LEVEL_LABEL: Record<string, string> = { large: '大', medium: '中', small: '小', detail: '詳細' };

type Phase = 'idle' | 'streaming' | 'ready' | 'error';

interface AiSessionState {
  memo: string;
  phase: Phase;
  progress: string;
  detected: number;
  errorText: string | null;
  rawOps: BatchOp[];
  decisions: DecisionMap;
  edits: EditMap;
  preview: AiPreview | null;
  editingOp: number | null;
  /** フロー上の仮ノード承認（AiFlowPreview）を重畳表示するか（既定 ON）。カード操作とは独立の表示設定。 */
  flowPreview: boolean;
  /** フローの非フロー系バッジ → 対象カードへスクロール/強調するためのシグナル（seq でトリガ）。 */
  cardFocus: { op: number; seq: number } | null;

  setMemo: (memo: string) => void;
  startStreaming: () => void;
  onProgress: (chunk: string) => void;
  setGenerated: (rawOps: BatchOp[], preview: AiPreview) => void;
  fail: (errorText: string) => void;
  setDecision: (i: number, state: DecisionState) => void;
  setEdit: (i: number, patch: ProposalEdit) => void;
  beginEdit: (i: number) => void;
  cancelEdit: () => void;
  setFlowPreview: (on: boolean) => void;
  focusCard: (op: number) => void;
  reset: () => void;
}

const IDLE = {
  phase: 'idle' as Phase,
  progress: '',
  detected: 0,
  errorText: null,
  rawOps: [] as BatchOp[],
  decisions: {} as DecisionMap,
  edits: {} as EditMap,
  preview: null as AiPreview | null,
  editingOp: null as number | null,
};

/** カードとフロー（Task 4）が共有する承認セッション状態。undo 対象外・非永続（ビュー状態）。 */
export const useAiSession = create<AiSessionState>((set) => ({
  memo: '',
  ...IDLE,
  // 表示設定（flowPreview）は生成/リセットで揮発させない。cardFocus はシグナル（初期 null）。
  flowPreview: true,
  cardFocus: null,
  setMemo: (memo) => set({ memo }),
  startStreaming: () => set({ ...IDLE, phase: 'streaming' }),
  onProgress: (chunk) =>
    set((s) => {
      const progress = s.progress + chunk;
      // ストリーミング中の「検出件数」を "op": の出現数で概算（Anthropic の逐次 chunk・Mock の一括）。
      const detected = (progress.match(/"op"\s*:/g) ?? []).length;
      return { progress, detected };
    }),
  setGenerated: (rawOps, preview) =>
    set({ rawOps, preview, phase: 'ready', decisions: {}, edits: {}, editingOp: null }),
  fail: (errorText) => set({ phase: 'error', errorText }),
  setDecision: (i, state) => set((s) => ({ decisions: { ...s.decisions, [i]: state } })),
  setEdit: (i, patch) =>
    set((s) => ({ edits: { ...s.edits, [i]: { ...s.edits[i], ...patch } }, editingOp: null })),
  beginEdit: (i) => set({ editingOp: i }),
  cancelEdit: () => set({ editingOp: null }),
  setFlowPreview: (on) => set({ flowPreview: on }),
  focusCard: (op) => set((s) => ({ cardFocus: { op, seq: (s.cardFocus?.seq ?? 0) + 1 } })),
  reset: () => set({ memo: '', ...IDLE }),
}));

// --- 実画面セルフチェック/E2E 用の provider 注入口（dev のみ・本番ビルドには出さない） ---
// window.__gfMockAi('{"operations":[...]}') で MockAiProvider を仕込む。requestProposals は
// aiEnabled ガードを通るので、AI を有効化した上でこの override を使えば実 API を叩かず検証できる。
let injectedProvider: AiProvider | null = null;
if (typeof window !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __gfMockAi?: (json: string) => void }).__gfMockAi = (json: string) => {
    injectedProvider = new MockAiProvider(json);
  };
}

const KIND_LABEL: Record<BatchOp['op'], string> = {
  add_task: '工程',
  upsert_task: '工程(更新)',
  add_dependency: '前後関係',
  set_detail: '詳細',
  set_tobe: 'To-Be',
  add_io: '入出力',
  add_issue: '課題',
  set_procedure: '手順書',
  add_step: '手順',
  upsert_asset: '資料',
};

const STATUS_LABEL: Record<string, string> = {
  pending: '仮',
  approved: '承認済',
  rejected: '否認',
  invalid: '無効',
};

/** name フィールドを持つ op か（インライン修正の対象）。 */
function isEditable(o: BatchOp): boolean {
  return o.op === 'add_task' || o.op === 'upsert_task' || o.op === 'upsert_asset';
}
function hasAssignee(o: BatchOp): o is Extract<BatchOp, { op: 'add_task' | 'upsert_task' }> {
  return o.op === 'add_task' || o.op === 'upsert_task';
}

async function generate(): Promise<void> {
  const session = useAiSession.getState();
  const app = useApp.getState();
  const mode = useUI.getState().aiPanelMode;
  session.startStreaming();
  try {
    const rawOps = await requestProposals(
      {
        project: app.project,
        memo: session.memo,
        kind: mode.kind,
        targetTaskId: mode.kind === 'procedureDraft' ? mode.targetTaskId : undefined,
      },
      (chunk) => useAiSession.getState().onProgress(chunk),
      injectedProvider ?? undefined,
    );
    // 生成直後に一度だけ preview を固定する（id 安定・decisions 変更では作り直さない）。
    const preview = buildAiPreview(app.project, applyEdits(rawOps, {}), app.level, app.scopeParentId);
    useAiSession.getState().setGenerated(rawOps, preview);
  } catch (e) {
    useAiSession.getState().fail(e instanceof AiError ? AI_ERROR_TEXT[e.kind] : AI_ERROR_TEXT.unknown);
  }
}

function applyApproved(): void {
  const { preview, decisions, edits } = useAiSession.getState();
  if (!preview) return;
  const finalOps = applyEdits(preview.ops, edits); // 生成後のインライン修正を最終適用へ反映
  const { apply } = resolveApproved(finalOps, decisions);
  const applyOps = apply.map((i) => finalOps[i]!);
  if (!applyOps.length) return;
  try {
    useApp.getState().applyApprovedBatch(applyOps); // 本番 uuid・commit 1 undo
    useUI.getState().toast('AI提案を適用しました（元に戻す: Ctrl+Z）', 'success');
    useAiSession.getState().reset();
    useUI.getState().setAiPanelOpen(false);
  } catch {
    useUI.getState().toast('提案の適用に失敗しました', 'error');
  }
}

export function AiPanel(): JSX.Element {
  const mode = useUI((s) => s.aiPanelMode);
  const memo = useAiSession((s) => s.memo);
  const phase = useAiSession((s) => s.phase);
  const detected = useAiSession((s) => s.detected);
  const errorText = useAiSession((s) => s.errorText);
  const preview = useAiSession((s) => s.preview);
  const decisions = useAiSession((s) => s.decisions);
  const edits = useAiSession((s) => s.edits);
  const editingOp = useAiSession((s) => s.editingOp);
  const flowPreview = useAiSession((s) => s.flowPreview);
  const cardFocus = useAiSession((s) => s.cardFocus);

  // モードが変わったら（＝別の起動導線で開き直したら）セッションをまっさらにする。
  const modeKey = mode.kind === 'procedureDraft' ? `pd:${mode.targetTaskId}` : 'batch';
  useEffect(() => {
    useAiSession.getState().reset();
  }, [modeKey]);

  // フローの非フロー系バッジ → 対象カードへスクロール＆一時ハイライト（フロー⇄カードの往復導線）。
  const listRef = useRef<HTMLDivElement>(null);
  const [flashOp, setFlashOp] = useState<number | null>(null);
  useEffect(() => {
    if (!cardFocus) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-op="${cardFocus.op}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setFlashOp(cardFocus.op);
    const t = setTimeout(() => setFlashOp(null), 1400);
    return () => clearTimeout(t);
  }, [cardFocus]);

  const ops = preview?.ops ?? [];
  const editedOps = useMemo(() => applyEdits(ops, edits), [ops, edits]);
  const resolved = useMemo(
    () => (preview ? resolveApproved(editedOps, decisions) : null),
    [preview, editedOps, decisions],
  );
  const applyCount = resolved?.apply.length ?? 0;
  const nodeMap = preview?.nodeMap;

  const close = () => useUI.getState().setAiPanelOpen(false);
  const targetName =
    mode.kind === 'procedureDraft'
      ? useApp.getState().project.core.tasks[mode.targetTaskId]?.name ?? '(不明な工程)'
      : '';

  const taskNameOf = (id: string | undefined): string =>
    (id && preview?.result.project.core.tasks[id]?.name) || id || '?';

  const summaryOf = (i: number): string => {
    const o = editedOps[i]!;
    switch (o.op) {
      case 'add_task':
      case 'upsert_task':
        return `「${o.name || '(無題)'}」${o.assignee ? ` ・ ${o.assignee}` : ''}（${LEVEL_LABEL[o.level ?? 'medium'] ?? ''}）`;
      case 'add_dependency': {
        const e = nodeMap?.edgeOps.get(i);
        return e ? `${taskNameOf(e[0])} → ${taskNameOf(e[1])}` : `${o.from} → ${o.to}`;
      }
      case 'set_procedure':
        return `${targetLabel(i)}手順書${o.purpose ? `: ${o.purpose}` : ''}`;
      case 'add_step':
        return `${targetLabel(i)}${o.action}`;
      case 'add_issue':
        return `${targetLabel(i)}${o.issue}`;
      case 'add_io':
        return `${targetLabel(i)}${o.io === 'inputs' ? '入力' : '出力'}: ${o.name}`;
      case 'set_detail':
        return `${targetLabel(i)}詳細を設定`;
      case 'set_tobe':
        return `${targetLabel(i)}To-Be を設定`;
      case 'upsert_asset':
        return `「${o.name || '(無題)'}」`;
    }
  };
  const targetLabel = (i: number): string => {
    const id = nodeMap?.opToTaskId.get(i);
    const nm = id ? preview?.result.project.core.tasks[id]?.name : undefined;
    return nm ? `【${nm}】 ` : '';
  };

  return (
    <aside className="ai-panel" role="dialog" aria-label="AI アシスト">
      <header className="ai-panel-h">
        <h4>✨ AI アシスト</h4>
        {mode.kind === 'procedureDraft' && (
          <span className="ai-mode" title="手順書ドラフトの対象工程">
            手順書: {targetName}
          </span>
        )}
        <button type="button" className="close" aria-label="AI パネルを閉じる" onClick={close}>
          ×
        </button>
      </header>

      <div className="ai-panel-body">
        <label className="ai-memo-label" htmlFor="ai-memo">
          {mode.kind === 'procedureDraft'
            ? 'この工程について分かっていること（任意・箇条書き可）'
            : 'ヒアリングメモ'}
        </label>
        <textarea
          id="ai-memo"
          className="ai-memo"
          value={memo}
          placeholder="ヒアリングメモを貼り付け、または要点を入力…"
          onChange={(e) => useAiSession.getState().setMemo(e.target.value)}
          disabled={phase === 'streaming'}
        />
        <button
          type="button"
          className="ai-gen-btn"
          onClick={() => void generate()}
          disabled={phase === 'streaming'}
        >
          {phase === 'streaming' ? '生成中…' : '提案を生成'}
        </button>

        {phase === 'streaming' && (
          <div className="gen" aria-live="polite">
            <span className="ai-spin" aria-hidden="true" />
            <div className="pbar">
              <span />
            </div>
            <span className="detected">検出: {detected} 件…</span>
          </div>
        )}

        {phase === 'error' && (
          <div className="ai-error" role="alert">
            <p>{errorText}</p>
            <button type="button" className="ai-gen-btn" onClick={() => void generate()}>
              再生成
            </button>
          </div>
        )}

        {phase === 'ready' && ops.length === 0 && (
          <p className="ai-empty">提案が見つかりませんでした。メモを具体的にして再生成してください。</p>
        )}

        {phase === 'ready' && ops.length > 0 && (
          <div className="ai-flowtoggle-row">
            <span className="ai-flowtoggle-hint">仮ノードはフロー上で承認できます</span>
            <button
              type="button"
              className={`ai-flowtoggle${flowPreview ? ' on' : ''}`}
              aria-pressed={flowPreview}
              onClick={() => useAiSession.getState().setFlowPreview(!flowPreview)}
              title="フロー上に仮ノードを重畳して承認する（主戦場）"
            >
              フローで確認
            </button>
          </div>
        )}

        {phase === 'ready' && ops.length > 0 && (
          <div className="prop-list" ref={listRef}>
            {ops.map((rawOp, i) => {
              const decision = decisions[i] ?? 'pending';
              const reason = resolved?.disabled.get(i);
              const cls = reason ? 'invalid' : decision;
              const isFlow = !!nodeMap && (nodeMap.opToTaskId.has(i) || nodeMap.edgeOps.has(i));
              const editable = isEditable(rawOp);
              const editedName = editable ? (editedOps[i] as { name?: string }).name : undefined;
              const origName = editable ? (rawOp as { name?: string }).name : undefined;
              const nameChanged = editedName !== undefined && editedName !== origName;

              return (
                <div className={`prop ${cls}${flashOp === i ? ' flash' : ''}`} key={i} data-op={i}>
                  <div className="prop-h">
                    <span className="prop-kind">{KIND_LABEL[rawOp.op]}</span>
                    <span className={`prop-status ${cls}`}>{STATUS_LABEL[cls]}</span>
                    {isFlow && <span className="flowlink">フロー対象</span>}
                  </div>
                  <div className="prop-summary">{summaryOf(i)}</div>
                  {nameChanged && <div className="was">元案: {origName}</div>}
                  {reason && <div className="prop-reason">{reason}</div>}

                  {editingOp === i ? (
                    <div className="edit-row">
                      <input
                        key={`name-${editedName ?? origName ?? ''}`}
                        className="edit-input"
                        defaultValue={editedName ?? origName ?? ''}
                        aria-label="名称を修正"
                        placeholder="名称"
                        onKeyDown={(e) => {
                          cancelEditOnEscape(e);
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                        {...selectAllOnFocus}
                        onBlur={(e) => useAiSession.getState().setEdit(i, { name: e.target.value })}
                      />
                      {hasAssignee(rawOp) && (
                        <input
                          key={`asg-${(editedOps[i] as { assignee?: string }).assignee ?? ''}`}
                          className="edit-input"
                          defaultValue={(editedOps[i] as { assignee?: string }).assignee ?? ''}
                          aria-label="担当を修正"
                          placeholder="担当（部署/氏名）"
                          onKeyDown={(e) => {
                            cancelEditOnEscape(e);
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                          {...selectAllOnFocus}
                          onBlur={(e) => useAiSession.getState().setEdit(i, { assignee: e.target.value })}
                        />
                      )}
                      <button
                        type="button"
                        className="prop-btn"
                        onClick={() => useAiSession.getState().cancelEdit()}
                      >
                        完了
                      </button>
                    </div>
                  ) : (
                    <div className="prop-actions">
                      <button
                        type="button"
                        className={`prop-btn ok${decision === 'approved' ? ' on' : ''}`}
                        onClick={() => useAiSession.getState().setDecision(i, 'approved')}
                      >
                        承認
                      </button>
                      {editable && (
                        <button
                          type="button"
                          className="prop-btn"
                          onClick={() => useAiSession.getState().beginEdit(i)}
                        >
                          修正
                        </button>
                      )}
                      <button
                        type="button"
                        className={`prop-btn no${decision === 'rejected' ? ' on' : ''}`}
                        onClick={() => useAiSession.getState().setDecision(i, 'rejected')}
                      >
                        否認
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {phase === 'ready' && ops.length > 0 && (
        <footer className="applybar">
          <button type="button" className="apply-btn" disabled={applyCount === 0} onClick={applyApproved}>
            承認 {applyCount} 件を確定（元に戻せます）
          </button>
        </footer>
      )}
    </aside>
  );
}
