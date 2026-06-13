// As-Is / To-Be 比較サマリ（画面1）。改善効果を「工数(タッチタイム)」と
// 「リードタイム(経過日数・停滞含む)」の2軸で対等に見せ、待ち=LT−工数 と業務難易度の変化も示す。
// 集計は core の computeCompare（純関数）。SummaryDialog と同じモーダル語彙を踏襲。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Difficulty, ProcessLevel, Project } from '@gantt-flow/core';
import {
  computeCompare,
  leafEffortMinutes,
  leafLtDays,
  projectScenarioCore,
  reconcileProject,
  ensureLevelView,
  tidyFlowView,
  uuid,
} from '@gantt-flow/core';
import { buildFlowSvg } from '../flowSvg';
import { useApp } from '../store';
import { useUI } from './useUI';
import { useFocusTrap } from './useFocusTrap';
import * as Icons from './icons';

// 指定シナリオ・粒度のフロー図 SVG を生成（射影→ビュー保証→reconcile→tidy→buildFlowSvg）。読み取り専用。
function buildScenarioFlowSvg(project: Project, phase: 'asis' | 'tobe', level: ProcessLevel): string {
  const core = projectScenarioCore(project.core, project.details, phase);
  let tmp: Project = { ...project, core, flow: { byLevel: [] } };
  tmp = ensureLevelView(tmp, level);
  tmp = reconcileProject(tmp, uuid);
  const base = tmp.flow.byLevel.find((v) => v.level === level && v.scopeParentId === undefined);
  if (!base) return '';
  const view = tidyFlowView(core, project.details, base);
  return buildFlowSvg(tmp, view);
}

type Phase = 'asis' | 'tobe' | 'delta';

const DIFF: { key: Difficulty; label: string; sub: string; cls: string }[] = [
  { key: 'H', label: '高', sub: 'ベテランのみ', cls: 'h' },
  { key: 'M', label: '中', sub: '中堅', cls: 'm' },
  { key: 'L', label: '低', sub: '誰でも', cls: 'l' },
];

const round1 = (v: number) => Math.round(v * 10) / 10;
const fmtDays = (v: number) => `${round1(v)}日`;
const fmtHours = (h: number) => `${round1(h)}h`;
const signed = (v: number, unit: string) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(round1(v))}${unit}`;
const pct = (delta: number, base: number) => (base === 0 ? '0%' : `${delta > 0 ? '+' : ''}${Math.round((delta / base) * 100)}%`);

// Δ ピル（良化=減=緑 / 悪化=増=赤 / 据え置き=中間）
function DeltaPill({ delta, base, unit, small }: { delta: number; base: number; unit: string; small?: boolean }) {
  const tone = delta === 0 ? 'flat' : delta < 0 ? 'good' : 'bad';
  const arrow = delta < 0 ? '▼' : delta > 0 ? '▲' : '–';
  return (
    <span className={`cmp-delta ${tone}${small ? ' cmp-delta-sm' : ''}`}>
      <span>{arrow} {signed(delta, unit)}</span>
      {base ? <span className="pct">{pct(delta, base)}</span> : null}
    </span>
  );
}

function Headline({ from, to, unit }: { from: string; to: string; unit: string }) {
  return (
    <div className="cmp-headline big">
      <span className="cmp-from">{from}</span>
      <span className="cmp-arrow">→</span>
      <span className="cmp-to">{to}<span className="unit">{unit}</span></span>
    </div>
  );
}

function CompareBars({ asis, tobe, unit, emph }: { asis: number; tobe: number; unit: string; emph: Phase }) {
  const m = Math.max(asis, tobe, 1);
  return (
    <div className="cmp-bars">
      <div className={`cmp-bar-row${emph === 'asis' ? ' emph' : ''}`}>
        <span className="cmp-bar-tag">As-Is</span>
        <span className="cmp-bar-track"><span className="cmp-bar-fill asis" style={{ width: `${(asis / m) * 100}%` }} /></span>
        <span className="cmp-bar-val">{round1(asis)}{unit}</span>
      </div>
      <div className={`cmp-bar-row${emph === 'tobe' ? ' emph' : ''}`}>
        <span className="cmp-bar-tag">To-Be</span>
        <span className="cmp-bar-track"><span className="cmp-bar-fill tobe" style={{ width: `${(tobe / m) * 100}%` }} /></span>
        <span className="cmp-bar-val">{round1(tobe)}{unit}</span>
      </div>
    </div>
  );
}

function DiffStack({ counts, total, unit }: { counts: Record<Difficulty, number>; total: number; unit: string }) {
  return (
    <span className="cmp-auto-track">
      {DIFF.map((d) => {
        const n = counts[d.key] || 0;
        const p = total ? (n / total) * 100 : 0;
        if (!p) return null;
        return (
          <span key={d.key} className={`cmp-auto-seg diff-${d.cls}`} style={{ width: `${p}%` }} title={`${d.label}（${d.sub}）: ${round1(n)}${unit}`}>
            {p >= 12 ? <span className="seg-lab">{round1(n)}{unit}</span> : null}
          </span>
        );
      })}
    </span>
  );
}

export function ComparisonDialog() {
  const open = useUI((s) => s.overlay === 'comparison');
  const project = useApp((s) => s.project);
  const close = () => useUI.getState().setOverlay(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);
  const [phase, setPhase] = useState<Phase>('delta');
  const [diffMode, setDiffMode] = useState<'count' | 'effort'>('count');
  const [view, setView] = useState<'summary' | 'flow'>('summary');
  const [flowLevel, setFlowLevel] = useState<ProcessLevel>('medium');

  const c = useMemo(() => computeCompare(project.core, project.details), [project]);
  // フロー比較（画面4）の As-Is / To-Be 図。flow タブのときだけ計算。
  const flowSvgs = useMemo(
    () =>
      view !== 'flow'
        ? null
        : { asis: buildScenarioFlowSvg(project, 'asis', flowLevel), tobe: buildScenarioFlowSvg(project, 'tobe', flowLevel) },
    [project, view, flowLevel],
  );
  // 構造差分の要約（新規 / 廃止 / 移動 / 並行化）。
  const struct = useMemo(() => {
    const added: string[] = [];
    const removed: string[] = [];
    const moved: string[] = [];
    for (const t of Object.values(project.core.tasks)) {
      const tb = project.details[t.id]?.toBe;
      if (!tb) continue;
      if (tb.lifecycle === 'added') added.push(t.name);
      else if (tb.lifecycle === 'removed') removed.push(t.name);
      if (tb.assigneeId && tb.assigneeId !== t.assigneeId) moved.push(t.name);
    }
    const parallelized = Object.values(project.core.dependencies).filter((d) => d.phase === 'asis').length;
    return { added, removed, moved, parallelized };
  }, [project]);
  // 工程別の差分（末端のみ・工数 or LT が入っている行）
  const perRow = useMemo(() => {
    const tasks = Object.values(project.core.tasks);
    const hasChild = new Set(tasks.map((t) => t.parentId).filter(Boolean) as string[]);
    return tasks
      .filter((t) => !hasChild.has(t.id))
      .map((t) => {
        const d = project.details[t.id];
        const aEff = leafEffortMinutes(d, 'asis') / 60;
        const bEff = leafEffortMinutes(d, 'tobe') / 60;
        const aLt = leafLtDays(d, 'asis');
        const bLt = leafLtDays(d, 'tobe');
        const ltCut = aLt - bLt; // リードタイム短縮（日）
        return {
          id: t.id,
          name: t.name,
          owner: t.assigneeId ? project.core.assignees[t.assigneeId]?.name ?? '' : '',
          aEff, bEff, aLt, bLt, ltCut,
          changed: !!d?.toBe,
        };
      })
      .filter((r) => r.aEff || r.bEff || r.aLt || r.bLt);
  }, [project]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  if (!open) return null;

  const effH = { asis: c.effortMinutes.asis / 60, tobe: c.effortMinutes.tobe / 60, delta: c.effortMinutes.delta / 60 };
  const maxCut = Math.max(...perRow.map((r) => r.ltCut), 1);
  const counts = diffMode === 'count' ? c.difficulty.count : c.difficulty.effort;
  const totals = diffMode === 'count'
    ? { asis: c.leafCount.asis, tobe: c.leafCount.tobe }
    : { asis: c.effortMinutes.asis / 60, tobe: c.effortMinutes.tobe / 60 };
  const unit = diffMode === 'count' ? '工程' : 'h';
  const hAsis = diffMode === 'count' ? c.difficulty.count.asis.H : c.difficulty.effort.asis.H / 60;
  const hTobe = diffMode === 'count' ? c.difficulty.count.tobe.H : c.difficulty.effort.tobe.H / 60;
  const dmCounts = diffMode === 'effort'
    ? { asis: scaleH(counts.asis), tobe: scaleH(counts.tobe) }
    : counts;

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal cmp-modal" role="dialog" aria-modal="true" aria-label="改善効果サマリ（As-Is / To-Be 比較）" ref={dialogRef} onMouseDown={(e) => e.stopPropagation()}>
        <div className="help-head">
          <h3 className="modal-title">改善効果サマリ <span className="cmp-modal-sub">As-Is / To-Be</span></h3>
          <div className="seg cmp-view-tabs" role="tablist">
            <button role="tab" aria-selected={view === 'summary'} className={view === 'summary' ? 'on' : ''} onClick={() => setView('summary')}>サマリ</button>
            <button role="tab" aria-selected={view === 'flow'} className={view === 'flow' ? 'on' : ''} onClick={() => setView('flow')}>フロー比較</button>
          </div>
          <button ref={closeRef} className="x" aria-label="閉じる" title="閉じる" onClick={close}>×</button>
        </div>

        {view === 'summary' && (
        <div className="cmp-tabrow">
          <div className="seg cmp-phase-tabs" role="tablist">
            {(['asis', 'tobe', 'delta'] as Phase[]).map((p) => (
              <button key={p} role="tab" aria-selected={phase === p} className={phase === p ? 'on' : ''} onClick={() => setPhase(p)}>
                {p === 'asis' ? 'As-Is' : p === 'tobe' ? 'To-Be' : 'Δ（差分）'}
              </button>
            ))}
          </div>
          <span className="cmp-tab-legend">
            <span className="cmp-leg"><span className="sw asis" />As-Is</span>
            <span className="cmp-leg"><span className="sw tobe" />To-Be</span>
          </span>
        </div>
        )}

        {view === 'flow' && (
          <div className="cmp-flow">
            <div className="cmp-flow-toolbar">
              <div className="seg cmp-seg-sm" role="tablist">
                {([['large', '大'], ['medium', '中'], ['small', '小']] as [ProcessLevel, string][]).map(([k, lab]) => (
                  <button key={k} className={flowLevel === k ? 'on' : ''} onClick={() => setFlowLevel(k)}>{lab}</button>
                ))}
              </div>
              <span className="cmp-flow-diffchips">
                {struct.added.length > 0 && <span className="cmp-chip added">新規 {struct.added.length}</span>}
                {struct.removed.length > 0 && <span className="cmp-chip removed">廃止 {struct.removed.length}</span>}
                {struct.moved.length > 0 && <span className="cmp-chip moved">移動 {struct.moved.length}</span>}
                {struct.parallelized > 0 && <span className="cmp-chip parallel">並行化 {struct.parallelized}</span>}
                {struct.added.length + struct.removed.length + struct.moved.length + struct.parallelized === 0 && (
                  <span className="cmp-flow-hint">構造の変更はありません（工数・リードタイム・難易度のみ変化）</span>
                )}
              </span>
            </div>
            <div className="cmp-flow-pane">
              <div className="cmp-flow-label asis">As-Is（現状）</div>
              <div className="cmp-flow-svg" dangerouslySetInnerHTML={{ __html: flowSvgs?.asis ?? '' }} />
            </div>
            <div className="cmp-flow-pane">
              <div className="cmp-flow-label tobe">To-Be（改善後）</div>
              <div className="cmp-flow-svg" dangerouslySetInnerHTML={{ __html: flowSvgs?.tobe ?? '' }} />
            </div>
            <p className="cmp-table-foot">
              ※ 読み取り専用。構造（新規・廃止・担当移動・並行化）は To-Be 編集（インスペクタ）と一括入力で変更できます。配置は自動整列で都度導出します。
            </p>
          </div>
        )}

        {view === 'summary' && (
        <div className="cmp-body">
          <div className="cmp-cards">
            {/* 工数（左） */}
            <section className="cmp-card is-feature">
              <div className="cmp-axis-head">
                <span className="cmp-card-icon"><Icons.Clock /></span>
                <span className="ax-title">工数</span>
                <span className="ax-sub">タッチタイム・総和</span>
                <span className="push" />
                <DeltaPill delta={effH.delta} base={effH.asis} unit="h" />
              </div>
              <Headline from={fmtHours(effH.asis)} to={`${round1(effH.tobe)}`} unit="h" />
              <CompareBars asis={effH.asis} tobe={effH.tobe} unit="h" emph={phase} />
            </section>

            {/* リードタイム（右） */}
            <section className="cmp-card is-feature">
              <div className="cmp-axis-head">
                <span className="cmp-card-icon"><Icons.ChartBar /></span>
                <span className="ax-title">リードタイム</span>
                <span className="ax-sub">着手〜完了・停滞含む</span>
                <span className="push" />
                <DeltaPill delta={c.ltDays.delta} base={c.ltDays.asis} unit="日" />
              </div>
              <Headline from={fmtDays(c.ltDays.asis)} to={`${round1(c.ltDays.tobe)}`} unit="日" />
              <CompareBars asis={c.ltDays.asis} tobe={c.ltDays.tobe} unit="日" emph={phase} />
              <div className="cmp-axis-note">各工程の着手〜完了の経過時間（クリティカルパス）。並行工程は加算されません。</div>
            </section>
          </div>

          <div className="cmp-lower">
            <section className="cmp-card">
              <div className="cmp-diff-head">
                <span className="cmp-card-icon"><Icons.Sparkles /></span>
                <span className="cmp-card-title">業務難易度の変化</span>
                <span className="push" />
                <div className="seg cmp-seg-sm">
                  <button className={diffMode === 'count' ? 'on' : ''} onClick={() => setDiffMode('count')}>工程数</button>
                  <button className={diffMode === 'effort' ? 'on' : ''} onClick={() => setDiffMode('effort')}>工数</button>
                </div>
              </div>
              <div className="cmp-diff-metric">
                <span className="lead">高難度（ベテラン依存）</span>
                <span className="val"><span className="from">{round1(hAsis)}{unit}</span> → {round1(hTobe)}{unit}</span>
                <DeltaPill delta={hTobe - hAsis} base={hAsis} unit={unit} small />
              </div>
              <div className="cmp-auto-row"><span className="cmp-bar-tag">As-Is</span><DiffStack counts={dmCounts.asis} total={totals.asis} unit={diffMode === 'count' ? '' : 'h'} /></div>
              <div className="cmp-auto-row"><span className="cmp-bar-tag">To-Be</span><DiffStack counts={dmCounts.tobe} total={totals.tobe} unit={diffMode === 'count' ? '' : 'h'} /></div>
              <ul className="cmp-auto-legend">
                {DIFF.map((d) => (<li key={d.key}><span className={`cmp-auto-dot diff-${d.cls}`} />{d.label}・{d.sub}</li>))}
              </ul>
              <div className="cmp-auto-delta">暗黙知を形式知化し、<b>誰でもできる（低）</b>業務へ移行。ベテラン依存を縮小。</div>
            </section>

            <div className="cmp-table-wrap">
              <div className="cmp-table-cap">工程別の差分</div>
              <div className="cmp-table-scroll">
                <table className="cmp-table">
                  <thead>
                    <tr><th>工程</th><th>担当</th><th className="num">工数</th><th className="num">リードタイム</th><th className="num">短縮</th></tr>
                  </thead>
                  <tbody>
                    {perRow.map((r) => (
                      <tr key={r.id} className={r.changed ? '' : 'is-kept'}>
                        <td>{r.name}</td>
                        <td className="flow">{r.owner}</td>
                        <td className="num flow">{round1(r.aEff)}h <b>→ {round1(r.bEff)}h</b></td>
                        <td className="num flow">{round1(r.aLt)}日 <b>→ {round1(r.bLt)}日</b></td>
                        <td className="num">
                          {r.ltCut > 0.05 ? (
                            <span className="cmp-cut-bar">
                              <span className="cmp-cut-track"><span className="cmp-cut-fill" style={{ width: `${(r.ltCut / maxCut) * 100}%` }} /></span>
                              <span className="cmp-good">−{round1(r.ltCut)}日</span>
                            </span>
                          ) : <span className="cmp-cut-zero">±0</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="cmp-table-foot">
                ※ リードタイムは依存のクリティカルパス。並行（依存で繋がらない）工程は加算されないため、総リードタイムは各行の単純和より短くなりうる（＝並行化の効果）。
              </p>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

// 工数モードは分→時間に換算して表示
function scaleH(c: Record<Difficulty, number>): Record<Difficulty, number> {
  return { H: c.H / 60, M: c.M / 60, L: c.L / 60 };
}
