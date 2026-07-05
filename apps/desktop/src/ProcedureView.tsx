// 手順書タブ（第 3 のビュー）。中工程を開くと、サイドバーに配下末端工程の縦フローナビ、
// 本文に各工程の目的・ステップ（アクション/目的/詳細本文 Markdown/条件+飛び先/参照チップ）が並ぶ。
// 単一データソース（project.manual）を core コマンド経由で編集する（reconcile/flow には触らない）。
// UI の正: design_reference/procedure-mock.html。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Core, Id, Manual, ProcessTask, Project, StepRef } from '@gantt-flow/core';
import { computeCodes, deriveProcedureNav } from '@gantt-flow/core';
import { useApp } from './store';
import { useUI } from './ui/useUI';
import { MarkdownLite } from './markdownLite';
import { AssetLedger } from './AssetLedger';
import { getAssetUrl } from './assetStore';
import { cancelEditOnEscape, selectAllOnFocus } from './inputBehaviors';
import { isEditableTarget } from './keymap';
import { hasChildren, isLeaf, ancestorsOf, resolveRef as resolveRefShared } from './procShared';

const LEVEL_LABEL: Record<string, string> = { large: '大', medium: '中', small: '小', detail: '詳細' };

// 「中工程」= 縦フローナビの配下末端をぶら下げる非末端工程。選択工程/明示指定から決める。
function resolveMidId(core: Core, selectedTaskId: Id | undefined, procedureMidId: Id | null): Id | undefined {
  if (procedureMidId && core.tasks[procedureMidId]) return procedureMidId;
  const sel = selectedTaskId && core.tasks[selectedTaskId] ? core.tasks[selectedTaskId] : undefined;
  if (sel) {
    if (hasChildren(core, sel.id)) return sel.id; // 選択が非末端＝そのまま中工程
    if (sel.parentId && core.tasks[sel.parentId]) return sel.parentId; // 末端なら親を中工程に
    return sel.id;
  }
  // 未選択: order 順で最初の非末端工程（無ければ最初の工程）。
  const tasks = byOrder(Object.values(core.tasks));
  const nonLeaf = tasks.find((t) => hasChildren(core, t.id));
  return (nonLeaf ?? tasks[0])?.id;
}

// taskId を含む中工程（子があれば自身・末端なら親、無ければ自身）。
function midOf(core: Core, taskId: Id): Id | undefined {
  const t = core.tasks[taskId];
  if (!t) return undefined;
  if (hasChildren(core, taskId)) return taskId;
  return t.parentId && core.tasks[t.parentId] ? t.parentId : taskId;
}

const byOrder = (ts: ProcessTask[]): ProcessTask[] =>
  [...ts].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

function coverageOf(core: Core, manual: Manual, midId: Id): { done: number; total: number } {
  const nav = deriveProcedureNav(core, midId, manual);
  return { done: nav.filter((n) => n.hasProcedure).length, total: nav.length };
}

// 参照チップの表示解決（見つからない＝ダングリングは broken）。icon/tone は procShared が返す kind から作る
// （procShared.resolveRef は project 引数の汎用形＝handbook.ts とも共有。表示結果は従来と同一）。
const REF_ICON: Record<'asset' | 'io' | 'task', string> = { asset: '📚', io: '📄', task: '🔗' };
const REF_TONE: Record<'asset' | 'io' | 'task', 'ref' | 'io'> = { asset: 'ref', io: 'io', task: 'io' };
function resolveRef(
  ref: StepRef,
  project: Project,
): { icon: string; label: string; broken: boolean; tone: 'ref' | 'io' } {
  const r = resolveRefShared(project, ref);
  return { icon: REF_ICON[r.kind], label: r.label, broken: r.broken, tone: REF_TONE[r.kind] };
}

// 単一行の非制御入力（defaultValue + onBlur コミット + Escape 取消 + フォーカス全選択）。
// key で外部変更時に再マウントして defaultValue を更新（既存 Inspector と同流儀）。
function EditLine(props: {
  value: string;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  onCommit: (next: string) => void;
}): JSX.Element {
  return (
    <input
      key={props.value}
      className={props.className}
      defaultValue={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      onKeyDown={cancelEditOnEscape}
      {...selectAllOnFocus}
      onBlur={(e) => props.onCommit(e.target.value)}
    />
  );
}

// 複数行の非制御テキストエリア（bodyMd 用）。全選択はしない（本文編集で全消しの誤爆を避ける）。
function EditArea(props: {
  value: string;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
  onCommit: (next: string) => void;
}): JSX.Element {
  return (
    <textarea
      key={props.value}
      className={props.className}
      defaultValue={props.value}
      placeholder={props.placeholder}
      aria-label={props.ariaLabel}
      rows={3}
      onKeyDown={cancelEditOnEscape}
      onBlur={(e) => props.onCommit(e.target.value)}
    />
  );
}

const commitReq = (cur: string, next: string, write: (v: string) => void) => {
  if (next !== cur) write(next);
};
const commitOpt = (cur: string | undefined, next: string, write: (v: string | undefined) => void) => {
  const v = next === '' ? undefined : next;
  if (v !== (cur ?? undefined)) write(v);
};

export interface ProcedureViewProps {
  /** ハンドブック(HTML)出力。ファイル系操作＝リーダー専用のため、フォロワーでは渡さない(未指定ならボタン非表示)。 */
  onExportHandbook?: () => void;
}

export function ProcedureView({ onExportHandbook }: ProcedureViewProps = {}): JSX.Element {
  const project = useApp((s) => s.project);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const procedureMidId = useUI((s) => s.procedureMidId);
  const setProcedureMidId = useUI((s) => s.setProcedureMidId);

  const core = project.core;
  const details = project.details;
  const manual = project.manual;
  const codes = useMemo(() => computeCodes(core), [core]);

  const midId = resolveMidId(core, selectedTaskId, procedureMidId);

  // 縦フローナビ（配下末端の直列化）。中工程自身が末端なら 1 章として見せる。
  const navItems = useMemo(() => {
    if (!midId) return [];
    const nav = deriveProcedureNav(core, midId, manual);
    if (nav.length) return nav;
    if (isLeaf(core, midId)) {
      return [
        {
          taskId: midId,
          name: core.tasks[midId]?.name ?? '',
          layer: 0,
          parallel: false,
          hasProcedure: (manual.procedures[midId]?.steps.length ?? 0) > 0,
        },
      ];
    }
    return [];
  }, [core, manual, midId]);

  const mainRef = useRef<HTMLDivElement>(null);
  const [hereTaskId, setHereTaskId] = useState<Id | undefined>(undefined);
  const [selStep, setSelStep] = useState<{ taskId: Id; stepId: Id } | null>(null);
  // 資料台帳ドロワー（右パネル）の開閉。手順書タブ内のローカル表示状態（undo 非対象・非永続）。
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const assetOptions = useMemo(
    () => Object.values(manual.assets).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    [manual.assets],
  );
  const [pendingScroll, setPendingScroll] = useState<Id | null>(null);
  const [pendingFocus, setPendingFocus] = useState<Id | null>(null);
  const visibleRef = useRef<Map<Id, boolean>>(new Map());
  // 選択中ステップを window リスナーから参照する（ステップ div は非フォーカス＝キーイベントの
  // target は body になり React ツリー内の onKeyDown では拾えないため、window で受ける）。
  const selStepRef = useRef(selStep);
  selStepRef.current = selStep;

  // ステップ選択中の Delete でそのステップを削除（テキスト編集中・未選択時は何もしない＝暴発しない）。
  // Escape は編集中でなければ選択解除に使う（編集中は cancelEditOnEscape が input で握って伝播を止める）。
  // App のグローバル listener（table/flow の Delete）は手順書ビューでは対象ペインが未マウント＝no-op。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(document.activeElement)) return;
      const sel = selStepRef.current;
      if (e.key === 'Delete' && sel) {
        useApp.getState().removeStep(sel.taskId, sel.stepId);
        setSelStep(null);
        e.preventDefault();
        e.stopPropagation();
      } else if (e.key === 'Escape' && sel) {
        setSelStep(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // 本文スクロールで可視上端に来た章の taskId を追う（＝「いまここ」）。IntersectionObserver の
  // 観測域を上部だけに絞る（下 70% を除外）ことで、最上部の章が current になる。
  useEffect(() => {
    const root = mainRef.current;
    if (!root) return;
    const visible = visibleRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.taskid;
          if (id) visible.set(id, e.isIntersecting);
        }
        const first = navItems.find((n) => visible.get(n.taskId));
        setHereTaskId(first?.taskId ?? navItems[0]?.taskId);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    root.querySelectorAll<HTMLElement>('.proc-chap').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [navItems]);

  // 中工程が切り替わったあと、ジャンプ先の章へスクロールする（レンダ後に実行）。
  useEffect(() => {
    if (!pendingScroll) return;
    const el = mainRef.current?.querySelector<HTMLElement>(`[data-taskid="${CSS.escape(pendingScroll)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setPendingScroll(null);
    }
  }, [pendingScroll, navItems, midId]);

  // 追加直後のステップのアクション入力へフォーカス（打てばそのまま入力）。
  useEffect(() => {
    if (!pendingFocus) return;
    const el = mainRef.current?.querySelector<HTMLInputElement>(
      `[data-stepid="${CSS.escape(pendingFocus)}"] .proc-act-input`,
    );
    if (el) {
      el.focus();
      el.select();
    }
    setPendingFocus(null);
  }, [pendingFocus, project]);

  if (!midId) {
    return (
      <div className="procedure-view">
        <div className="proc-empty-view">工程がありません。工程表で工程を作成してください。</div>
      </div>
    );
  }

  const midTask = core.tasks[midId]!;
  const parentChain = ancestorsOf(core, midId);
  const siblingMids = byOrder(
    Object.values(core.tasks).filter((t) => (t.parentId ?? undefined) === (midTask.parentId ?? undefined)),
  );
  const midIdx = siblingMids.findIndex((t) => t.id === midId);
  const prevMid = midIdx > 0 ? siblingMids[midIdx - 1] : undefined;
  const nextMid = midIdx >= 0 && midIdx < siblingMids.length - 1 ? siblingMids[midIdx + 1] : undefined;
  const cov = { done: navItems.filter((n) => n.hasProcedure).length, total: navItems.length };
  const allTasks = byOrder(Object.values(core.tasks).filter((t) => t.name));

  const nameOf = (id: Id) => `${codes[id] ? codes[id] + ' ' : ''}${core.tasks[id]?.name ?? ''}`;
  const assigneeNameOf = (id: Id) => {
    const aid = core.tasks[id]?.assigneeId;
    return aid ? core.assignees[aid]?.name : undefined;
  };

  // --- 中工程の切替・ジャンプ ---
  const gotoMid = (id: Id) => {
    setProcedureMidId(id);
    setSelStep(null);
    mainRef.current?.scrollTo({ top: 0 });
  };
  const jumpToChapter = (taskId: Id) => {
    setHereTaskId(taskId);
    mainRef.current
      ?.querySelector<HTMLElement>(`[data-taskid="${CSS.escape(taskId)}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const jumpToTask = (taskId: Id) => {
    if (!core.tasks[taskId]) return;
    const targetMid = midOf(core, taskId);
    if (targetMid && targetMid !== midId) {
      setSelStep(null);
      useApp.getState().select(taskId);
      setProcedureMidId(targetMid);
      setPendingScroll(taskId);
    } else {
      jumpToChapter(taskId);
    }
  };
  const showInFlow = (taskId: Id) => {
    useApp.getState().select(taskId);
    useUI.getState().setMainView('work');
    useUI.getState().setPaneLayout('flow');
  };

  // --- 手順書の編集アクション（store 経由・stable なので getState で呼ぶ） ---
  const startProcedure = (taskId: Id) => {
    useApp.getState().upsertProcedurePurpose(taskId, ''); // doc を確保
    const id = useApp.getState().addStep(taskId, { action: '' }); // 最初のステップ
    if (id) {
      setSelStep({ taskId, stepId: id });
      setPendingFocus(id);
    }
  };
  const addStepTo = (taskId: Id) => {
    const id = useApp.getState().addStep(taskId, { action: '' });
    if (id) {
      setSelStep({ taskId, stepId: id });
      setPendingFocus(id);
    }
  };

  // 画像取り込み（ファイル選択・貼り付け共通）。bytes は assetStore へ入り Project には file 名だけ。
  const addImagesFromFiles = async (taskId: Id, stepId: Id, files: Iterable<File>) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue; // 画像以外は無視（テキスト等はここへ来ない）
      const bytes = new Uint8Array(await f.arrayBuffer());
      useApp.getState().addStepImage(taskId, stepId, bytes, f.type || 'image/png');
    }
  };
  // ステップ内の貼り付け。クリップボードに画像ファイルがある時だけ奪う（textarea へのテキスト貼付は妨げない）。
  const onStepPaste = (taskId: Id, stepId: Id) => (e: React.ClipboardEvent) => {
    const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return; // テキスト貼り付けは既定動作に任せる
    e.preventDefault();
    void addImagesFromFiles(taskId, stepId, imgs);
  };

  const renderChapter = (taskId: Id) => {
    const t = core.tasks[taskId];
    if (!t) return null;
    const d = details[taskId];
    const doc = manual.procedures[taskId];
    const steps = doc?.steps ?? [];
    const metaParts: string[] = [];
    const asg = assigneeNameOf(taskId);
    if (asg) metaParts.push(`担当: ${asg}`);
    if (d?.effortMinutes != null) metaParts.push(`${d.effortMinutes}分`);

    return (
      <article className="proc-chap" data-taskid={taskId} key={taskId}>
        <div className="proc-chap-h">
          <h3>{nameOf(taskId)}</h3>
          {metaParts.length > 0 && <span className="proc-meta">{metaParts.join(' ・ ')}</span>}
          <button type="button" className="proc-flowlink" onClick={() => showInFlow(taskId)}>
            フローで表示 →
          </button>
        </div>

        <div className="proc-chap-purpose">
          <b>目的:</b>{' '}
          <EditLine
            className="proc-how-input"
            value={d?.how ?? ''}
            placeholder="この工程の目的（how の一行サマリ）"
            ariaLabel="工程の目的"
            onCommit={(v) => commitOpt(d?.how, v, (x) => useApp.getState().updateDetail(taskId, { how: x }))}
          />
        </div>

        {steps.length === 0 ? (
          <div className="proc-empty-proc">
            <span>この工程の手順書は未作成です。</span>
            <button type="button" className="proc-btn" onClick={() => startProcedure(taskId)}>
              ＋ 手順を書く
            </button>
            <button type="button" className="proc-btn" disabled title="AI ドラフト生成は次サイクルで対応">
              ✨ ドラフト生成
            </button>
          </div>
        ) : (
          <>
            {steps.map((step, i) => {
              const selected = selStep?.taskId === taskId && selStep.stepId === step.id;
              return (
                <div
                  key={step.id}
                  data-stepid={step.id}
                  className={`proc-step${selected ? ' selected' : ''}`}
                  onClick={() => setSelStep({ taskId, stepId: step.id })}
                  onPaste={onStepPaste(taskId, step.id)}
                >
                  <span className="proc-stepno">{i + 1}</span>
                  <div className="proc-step-body">
                    <div className="proc-step-top">
                      <EditLine
                        className="proc-act-input"
                        value={step.action}
                        placeholder="アクション（1 文）"
                        ariaLabel="アクション"
                        onCommit={(v) =>
                          commitReq(step.action, v, (x) => useApp.getState().updateStep(taskId, step.id, { action: x }))
                        }
                      />
                      <span className="proc-step-tools">
                        <button
                          type="button"
                          className="proc-mini"
                          title="上へ"
                          disabled={i === 0}
                          onClick={() => useApp.getState().moveStep(taskId, step.id, i - 1)}
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          className="proc-mini"
                          title="下へ"
                          disabled={i === steps.length - 1}
                          onClick={() => useApp.getState().moveStep(taskId, step.id, i + 1)}
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          className="proc-mini danger"
                          title="このステップを削除"
                          onClick={() => {
                            useApp.getState().removeStep(taskId, step.id);
                            setSelStep(null);
                          }}
                        >
                          ×
                        </button>
                      </span>
                    </div>

                    <div className="proc-why">
                      <EditLine
                        className="proc-why-input"
                        value={step.why ?? ''}
                        placeholder="このステップの目的（1 文）"
                        ariaLabel="ステップの目的"
                        onCommit={(v) =>
                          commitOpt(step.why, v, (x) => useApp.getState().updateStep(taskId, step.id, { why: x }))
                        }
                      />
                    </div>

                    {(step.bodyMd ?? '').trim() !== '' && (
                      <div className="proc-detail">
                        <MarkdownLite text={step.bodyMd ?? ''} />
                      </div>
                    )}
                    <EditArea
                      className="proc-detail-input"
                      value={step.bodyMd ?? ''}
                      placeholder="詳細本文・ノウハウ（Markdown: **太字** ・ - 箇条書き ・ `コード`）"
                      ariaLabel="詳細本文"
                      onCommit={(v) =>
                        commitOpt(step.bodyMd, v, (x) => useApp.getState().updateStep(taskId, step.id, { bodyMd: x }))
                      }
                    />

                    {step.conds.map((c) => {
                      const target = c.targetTaskId ? core.tasks[c.targetTaskId] : undefined;
                      return (
                        <div className="proc-cond" key={c.id}>
                          <div className="proc-cond-row">
                            <span className="proc-cond-if">条件</span>
                            <EditLine
                              className="proc-cond-when"
                              value={c.when}
                              placeholder="条件（例: 記載不備がある場合）"
                              ariaLabel="条件"
                              onCommit={(v) =>
                                commitReq(c.when, v, (x) =>
                                  useApp.getState().updateStepCond(taskId, step.id, c.id, { when: x }),
                                )
                              }
                            />
                            <button
                              type="button"
                              className="proc-mini danger"
                              title="条件を削除"
                              onClick={() => useApp.getState().removeStepCond(taskId, step.id, c.id)}
                            >
                              ×
                            </button>
                          </div>
                          <EditArea
                            className="proc-cond-then"
                            value={c.thenMd}
                            placeholder="対処（Markdown 可）"
                            ariaLabel="対処"
                            onCommit={(v) =>
                              commitReq(c.thenMd, v, (x) =>
                                useApp.getState().updateStepCond(taskId, step.id, c.id, { thenMd: x }),
                              )
                            }
                          />
                          <div className="proc-cond-jump">
                            <span className="proc-cond-label">飛び先:</span>
                            <select
                              className="dep-add"
                              value={c.targetTaskId ?? ''}
                              onChange={(e) =>
                                useApp
                                  .getState()
                                  .updateStepCond(taskId, step.id, c.id, {
                                    targetTaskId: e.target.value || undefined,
                                  })
                              }
                            >
                              <option value="">（飛び先なし）</option>
                              {allTasks.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {nameOf(o.id)}
                                </option>
                              ))}
                            </select>
                            {c.targetTaskId && (
                              <button
                                type="button"
                                className={`proc-c-link${target ? '' : ' broken'}`}
                                onClick={() => c.targetTaskId && jumpToTask(c.targetTaskId)}
                                title={target ? 'この工程の手順書へ移動' : 'リンク切れ（工程が見つかりません）'}
                              >
                                → {target ? nameOf(c.targetTaskId) : 'リンク切れ'}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {step.refs.length > 0 && (
                      <div className="proc-chips">
                        {step.refs.map((ref, ri) => {
                          const r = resolveRef(ref, project);
                          return (
                            <span
                              className={`proc-chip ${r.broken ? 'broken' : r.tone}`}
                              key={ri}
                              title={r.broken ? 'リンク切れ（参照先が見つかりません）' : undefined}
                            >
                              {r.icon} {r.label}
                              <button
                                type="button"
                                className="proc-chip-x"
                                title="参照を外す"
                                onClick={() => useApp.getState().removeStepRef(taskId, step.id, ri)}
                              >
                                ×
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {step.images.length > 0 && (
                      <div className="proc-shots">
                        {step.images.map((img) => {
                          const url = getAssetUrl(img.file);
                          return (
                            <figure className="proc-shot" key={img.id}>
                              {url ? (
                                <img src={url} alt={img.caption || 'ステップ画像'} />
                              ) : (
                                <div className="proc-shot-missing">画像が見つかりません</div>
                              )}
                              <figcaption>
                                <EditLine
                                  className="proc-shot-cap"
                                  value={img.caption ?? ''}
                                  placeholder="キャプション"
                                  ariaLabel="画像のキャプション"
                                  onCommit={(v) =>
                                    commitOpt(img.caption, v, (x) =>
                                      useApp.getState().updateStepImage(taskId, step.id, img.id, { caption: x }),
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  className="proc-mini danger"
                                  title="画像を削除"
                                  onClick={() => useApp.getState().removeStepImage(taskId, step.id, img.id)}
                                >
                                  ×
                                </button>
                              </figcaption>
                            </figure>
                          );
                        })}
                      </div>
                    )}

                    <div className="proc-step-add">
                      <label className="proc-linkbtn proc-img-add">
                        ＋ 画像
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const fs = e.target.files;
                            if (fs && fs.length) void addImagesFromFiles(taskId, step.id, fs);
                            e.target.value = ''; // 同じファイルを続けて選べるようリセット
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="proc-linkbtn"
                        onClick={() => useApp.getState().addStepCond(taskId, step.id, { when: '', thenMd: '' })}
                      >
                        ＋ 条件
                      </button>
                      <select
                        className="proc-addref"
                        aria-label="参照を追加"
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) return;
                          if (v.startsWith('asset:')) {
                            useApp.getState().addStepRef(taskId, step.id, { kind: 'asset', assetId: v.slice(6) });
                          } else if (v.startsWith('io:')) {
                            useApp.getState().addStepRef(taskId, step.id, { kind: 'io', taskId, ioId: v.slice(3) });
                          }
                        }}
                      >
                        <option value="">＋ 参照</option>
                        {assetOptions.length > 0 && (
                          <optgroup label="資料">
                            {assetOptions.map((a) => (
                              <option key={a.id} value={`asset:${a.id}`}>
                                📚 {a.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                        {[...(d?.inputs ?? []), ...(d?.outputs ?? [])].length > 0 && (
                          <optgroup label="入出力">
                            {[...(d?.inputs ?? []), ...(d?.outputs ?? [])].map((io) => (
                              <option key={io.id} value={`io:${io.id}`}>
                                📄 {io.name}
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}
            <button type="button" className="proc-btn proc-add-step" onClick={() => addStepTo(taskId)}>
              ＋ ステップを追加
            </button>
          </>
        )}
      </article>
    );
  };

  return (
    <div className="procedure-view">
      <aside className="proc-side">
        <div className="proc-cap">工程フロー</div>
        {parentChain.map((p) => (
          <div className="proc-mg-h dim" key={p.id}>
            {nameOf(p.id)}
            <span className="proc-lv2">{LEVEL_LABEL[p.level]}</span>
          </div>
        ))}
        {siblingMids.map((sib) => {
          const isCurrent = sib.id === midId;
          const sc = isCurrent ? cov : coverageOf(core, manual, sib.id);
          return (
            <Fragment key={sib.id}>
              <div
                className={`proc-mg-h${isCurrent ? ' current' : ' dim'}`}
                role="button"
                tabIndex={0}
                onClick={() => !isCurrent && gotoMid(sib.id)}
                onKeyDown={(e) => {
                  if (!isCurrent && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    gotoMid(sib.id);
                  }
                }}
              >
                {nameOf(sib.id)}
                <span className="proc-lv2">{LEVEL_LABEL[sib.level]}</span>
                {sc.total > 0 && (
                  <span className={`proc-cov ${sc.done > 0 ? 'ok' : 'none'}`}>
                    {sc.done}/{sc.total}
                  </span>
                )}
              </div>
              {isCurrent && (
                <nav className="proc-mflow" aria-label="工程フローナビ">
                  {navItems.map((n, i) => (
                    <Fragment key={n.taskId}>
                      {i > 0 && <div className="proc-mlink" aria-hidden="true" />}
                      <button
                        type="button"
                        className={`proc-mnode${n.hasProcedure ? '' : ' todo'}${
                          hereTaskId === n.taskId ? ' here' : ''
                        }`}
                        onClick={() => jumpToChapter(n.taskId)}
                      >
                        <span className="proc-mnode-name">{n.name}</span>
                        {n.parallel && <span className="proc-par">∥並行</span>}
                        {hereTaskId === n.taskId ? (
                          <span className="proc-now">いまここ</span>
                        ) : (
                          <span className={`proc-cov ${n.hasProcedure ? 'ok' : 'none'}`}>
                            {n.hasProcedure ? '✓' : '—'}
                          </span>
                        )}
                      </button>
                    </Fragment>
                  ))}
                </nav>
              )}
            </Fragment>
          );
        })}
      </aside>

      <main
        className="proc-main"
        ref={mainRef}
        // 章・ステップ以外の余白クリックでステップ選択を解除（Delete の暴発防止・選択の明確化）。
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelStep(null);
        }}
      >
        <div className="proc-crumb">
          {parentChain.map((p) => (
            <span key={p.id}>{nameOf(p.id)} / </span>
          ))}
          <b>{nameOf(midId)}</b>
        </div>
        <div className="proc-doc-h">
          <h2>{nameOf(midId)}</h2>
          <span className="proc-covbar">
            手順書 <b>{cov.done}</b>/{cov.total} 工程 作成済み
          </span>
          <button
            type="button"
            className="proc-btn proc-ledger-btn"
            onClick={() => setLedgerOpen((v) => !v)}
            aria-pressed={ledgerOpen}
          >
            📚 資料台帳
            {assetOptions.length > 0 && <span className="proc-ledger-count">{assetOptions.length}</span>}
          </button>
          {onExportHandbook && (
            <button type="button" className="proc-btn" onClick={onExportHandbook}>
              📖 ハンドブック出力
            </button>
          )}
        </div>
        <div className="proc-purpose">
          <span className="proc-purpose-tag">この工程群の目的</span>
          <EditArea
            className="proc-purpose-input"
            value={manual.procedures[midId]?.purpose ?? ''}
            placeholder="この工程群の目的（1〜2 文）"
            ariaLabel="工程群の目的"
            onCommit={(v) =>
              commitOpt(manual.procedures[midId]?.purpose, v, (x) =>
                useApp.getState().upsertProcedurePurpose(midId, x ?? ''),
              )
            }
          />
        </div>

        {prevMid && (
          <div
            className="proc-entry"
            role="button"
            tabIndex={0}
            onClick={() => gotoMid(prevMid.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                gotoMid(prevMid.id);
              }
            }}
          >
            ▲ 前の工程: {nameOf(prevMid.id)}
          </div>
        )}

        {navItems.length === 0 ? (
          <div className="proc-empty-proc">この中工程には末端工程がありません。</div>
        ) : (
          navItems.map((n) => renderChapter(n.taskId))
        )}

        {nextMid && (
          <div
            className="proc-entry tail"
            role="button"
            tabIndex={0}
            onClick={() => gotoMid(nextMid.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                gotoMid(nextMid.id);
              }
            }}
          >
            ▼ 次の工程: {nameOf(nextMid.id)}
          </div>
        )}
      </main>

      {ledgerOpen && <AssetLedger onClose={() => setLedgerOpen(false)} />}
    </div>
  );
}
