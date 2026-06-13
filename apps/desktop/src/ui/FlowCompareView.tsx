// 画面4: 工程フロー As-Is / To-Be 比較（参照デザイン FlowCompare 準拠）。
// レーン×列のグリッド配置。差分は To-Be 側に集約: 新規 / 廃止ゴースト / 移動(元位置ゴースト)。
// 難易度色・差分強調・横軸(工程順/時系列LT)の切替。上下フローは横スクロール同期。読み取り専用。
import { useMemo, useRef, useState } from 'react';
import type { Difficulty, ProcessLevel, Project } from '@gantt-flow/core';
import { leafLtDays, leafDifficulty } from '@gantt-flow/core';
import { buildScenarioView, type ScenarioView } from '../scenarioFlow';

type Phase = 'asis' | 'tobe';
type Axis = 'order' | 'time';
type DiffState = 'added' | 'deleted' | 'moved' | 'changed' | 'unchanged';

// rowH = 1 サブ行の高さ。laneInset = レーン上端の余白。laneH(=rowH+2*laneInset) は 1 行レーンの高さ。
const FG = { x0: 92, colW: 150, taskW: 122, taskH: 30, rowH: 42, laneInset: 8, dayW: 22, gap: 16, railW: 88, topPad: 14, timePad: 34 };

interface GNode {
  id: string;
  name: string;
  lane: number;
  col: number;
  slot: number; // レーン内のサブ行（同一レーン×同一列に複数工程が来ても重ならないよう縦に積む）
  lt: number;
  diff?: Difficulty;
  t0: number;
}
interface Graph {
  nodes: GNode[];
  byId: Map<string, GNode>;
  edges: [string, string][];
  span: number;
  cols: number;
  laneSubrows: number[]; // レーンごとに必要なサブ行数（最大の同居数）
}

/** レーンの縦ジオメトリ（As-Is/To-Be で共有し、行が揃うように両者の最大サブ行で決める）。 */
interface LaneGeom {
  top: number[]; // レーン i の上端
  height: number[]; // レーン i の高さ
  total: number; // 全レーン合計高さ
}
function laneHeightOf(subrows: number): number {
  return Math.max(1, subrows) * FG.rowH + FG.laneInset * 2;
}
function buildLaneGeom(lanes: string[], asisSub: number[], tobeSub: number[]): LaneGeom {
  const top: number[] = [];
  const height: number[] = [];
  let acc = 0;
  for (let i = 0; i < lanes.length; i++) {
    const h = laneHeightOf(Math.max(asisSub[i] ?? 1, tobeSub[i] ?? 1));
    top.push(acc);
    height.push(h);
    acc += h;
  }
  return { top, height, total: acc };
}

function laneNameOf(sv: ScenarioView, taskId: string): string {
  const aid = sv.core.tasks[taskId]?.assigneeId;
  return aid ? sv.core.assignees[aid]?.name ?? '（未割当）' : '（未割当）';
}

function unifiedLanes(asis: ScenarioView | null, tobe: ScenarioView | null): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const sv of [asis, tobe]) {
    if (!sv) continue;
    const lanes = Object.values(sv.view.lanes).sort((a, b) => a.order - b.order);
    for (const l of lanes) {
      const name = l.assigneeId ? sv.core.assignees[l.assigneeId]?.name ?? l.title : l.title;
      if (name && !seen.has(name)) {
        seen.add(name);
        ordered.push(name);
      }
    }
  }
  return ordered.length ? ordered : ['（未割当）'];
}

function computeGraph(sv: ScenarioView, phase: Phase, lanes: string[], details: Project['details']): Graph {
  const { view, core } = sv;
  const nodeToTask = new Map<string, string>();
  for (const n of Object.values(view.nodes)) if (n.kind === 'task') nodeToTask.set(n.id, n.taskId);
  const taskNodes = Object.values(view.nodes).filter((n) => n.kind === 'task');
  const xs = [...new Set(taskNodes.map((n) => Math.round(n.x)))].sort((a, b) => a - b);
  const colOf = new Map(xs.map((x, i) => [x, i] as const));
  const nodes: GNode[] = taskNodes.map((n) => {
    const name = laneNameOf(sv, n.taskId);
    return {
      id: n.taskId,
      name: core.tasks[n.taskId]?.name ?? '',
      lane: Math.max(0, lanes.indexOf(name)),
      col: colOf.get(Math.round(n.x)) ?? 0,
      slot: 0,
      lt: leafLtDays(details[n.taskId], phase),
      diff: leafDifficulty(details[n.taskId], phase),
      t0: 0,
    };
  });
  // サブ行(slot)割当: 同一レーン×同一列に複数工程が来たら縦に積む（1レーン=複数行を許す）。
  // 各レーンの必要サブ行数 = 列ごとの同居数の最大。元の y 順で安定に積む。
  const laneSubrows: number[] = lanes.map(() => 1);
  const byLaneCol = new Map<string, GNode[]>();
  const yOf = new Map(taskNodes.map((n) => [n.taskId, n.y] as const));
  for (const nd of nodes) {
    const key = `${nd.lane}:${nd.col}`;
    (byLaneCol.get(key) ?? byLaneCol.set(key, []).get(key)!).push(nd);
  }
  for (const [key, group] of byLaneCol) {
    group.sort((a, b) => (yOf.get(a.id) ?? 0) - (yOf.get(b.id) ?? 0));
    group.forEach((nd, i) => {
      nd.slot = i;
    });
    const lane = Number(key.split(':')[0]);
    laneSubrows[lane] = Math.max(laneSubrows[lane] ?? 1, group.length);
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const edges: [string, string][] = [];
  for (const e of Object.values(view.edges)) {
    if (e.role === 'ioLink') continue;
    const f = nodeToTask.get(e.source);
    const t = nodeToTask.get(e.target);
    if (f && t && f !== t && byId.has(f) && byId.has(t)) edges.push([f, t]);
  }
  // 最早開始(t0)の前進計算（依存の重み=lt）。並行はクリティカルパスに乗らない。
  for (let iter = 0; iter < nodes.length; iter++) {
    let changed = false;
    for (const [f, t] of edges) {
      const ff = byId.get(f)!;
      const tt = byId.get(t)!;
      const cand = ff.t0 + ff.lt;
      if (cand > tt.t0) {
        tt.t0 = cand;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const span = Math.max(0, ...nodes.map((n) => n.t0 + n.lt));
  return { nodes, byId, edges, span, cols: xs.length, laneSubrows };
}

function rectOf(n: GNode, axis: Axis, geom: LaneGeom) {
  const h = FG.taskH;
  const y = (geom.top[n.lane] ?? 0) + FG.laneInset + n.slot * FG.rowH + (FG.rowH - h) / 2;
  let x: number;
  let w: number;
  if (axis === 'time') {
    x = FG.x0 + n.t0 * FG.dayW + FG.gap / 2;
    w = Math.max(n.lt * FG.dayW - FG.gap, 30);
  } else {
    x = FG.x0 + n.col * FG.colW;
    w = FG.taskW;
  }
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
}

function niceTickStep(span: number): number {
  const target = Math.max(Math.ceil(span / 7), Math.ceil(80 / FG.dayW));
  return [1, 2, 5, 10, 20, 40, 80, 120].find((s) => s >= target) ?? target;
}
function tickLabel(d: number, step: number): string {
  if (d === 0) return '開始';
  if (step >= 20) return `${Math.round((d / 20) * 10) / 10}か月`;
  if (step >= 5) return `${d / 5}週`;
  return `${d}日`;
}

function Strip({
  graph,
  asisGraph,
  lanes,
  geom,
  phase,
  axis,
  diffColor,
  diffEmph,
  diffState,
  width,
  tickStep,
  scrollRef,
  onScroll,
  meta,
}: {
  graph: Graph;
  asisGraph: Graph;
  lanes: string[];
  geom: LaneGeom;
  phase: Phase;
  axis: Axis;
  diffColor: boolean;
  diffEmph: boolean;
  diffState: Record<string, DiffState>;
  width: number;
  tickStep: number;
  scrollRef: React.RefObject<HTMLDivElement>;
  onScroll: () => void;
  meta: React.ReactNode;
}) {
  const baseline = phase === 'asis';
  const tmode = axis === 'time';
  const canvasH = geom.total;
  const topPad = tmode ? FG.timePad : FG.topPad;
  const ticks: number[] = [];
  if (tmode) for (let d = 0; d <= graph.span + 0.001; d += tickStep) ticks.push(d);
  const deletedIds = baseline ? [] : Object.keys(diffState).filter((id) => diffState[id] === 'deleted');

  return (
    <div className="cmp-strip">
      <div className="cmp-strip-head">
        <span className={`cmp-strip-tag ${phase}`}>{baseline ? 'As-Is（現状）' : 'To-Be（改善後）'}</span>
        <span className="cmp-strip-meta">{meta}</span>
      </div>
      <div className="cmp-flowgrid-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="cmp-flowgrid" style={{ width, height: canvasH + topPad }}>
          {tmode && (
            <div className="cmp-ruler" style={{ left: 0, width, top: 12 }}>
              {ticks.map((d) => (
                <div key={d} className="cmp-ruler-tick" style={{ left: FG.x0 + d * FG.dayW }}>
                  <span>{tickLabel(d, tickStep)}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ position: 'absolute', top: topPad, left: 0, width, height: canvasH }}>
            {lanes.map((_, i) => (i % 2 === 1 ? <div key={`s${i}`} className="cmp-lane-row stripe" style={{ top: geom.top[i], height: geom.height[i], width }} /> : null))}
            {lanes.map((_, i) => (i > 0 ? <div key={`l${i}`} className="cmp-lane-line" style={{ top: geom.top[i], width }} /> : null))}

            <svg className="cmp-flow-edges" width={width} height={canvasH}>
              <defs>
                <marker id={`fc-arrow-${phase}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--arrow)" />
                </marker>
              </defs>
              {!baseline &&
                graph.nodes.map((n) => {
                  if (diffState[n.id] !== 'moved') return null;
                  const old = asisGraph.byId.get(n.id);
                  if (!old) return null;
                  const nr = rectOf(n, axis, geom);
                  const oy = rectOf(old, axis, geom).cy;
                  return <line key={`mv-${n.id}`} x1={nr.cx} y1={oy} x2={nr.cx} y2={nr.cy} stroke="var(--amber)" strokeWidth="1.4" strokeDasharray="3 3" />;
                })}
              {graph.edges.map(([from, to]) => {
                const ff = graph.byId.get(from);
                const tt = graph.byId.get(to);
                if (!ff || !tt) return null;
                const a = rectOf(ff, axis, geom);
                const b = rectOf(tt, axis, geom);
                const sx = a.x + a.w;
                const sy = a.cy;
                const ty = b.cy;
                const endX = b.x - 5;
                const vx = sy === ty ? endX : Math.max(sx + 8, b.x - 12);
                const d = sy === ty ? `M ${sx} ${sy} L ${endX} ${ty}` : `M ${sx} ${sy} L ${vx} ${sy} L ${vx} ${ty} L ${endX} ${ty}`;
                const dim = !baseline && diffEmph && diffState[from] === 'unchanged' && diffState[to] === 'unchanged';
                return <path key={`${from}-${to}`} d={d} stroke="var(--edge)" strokeWidth="1.5" fill="none" opacity={dim ? 0.3 : 1} markerEnd={`url(#fc-arrow-${phase})`} />;
              })}
            </svg>

            {/* 移動の元位置ゴースト（To-Be のみ） */}
            {!baseline &&
              graph.nodes.map((n) => {
                if (diffState[n.id] !== 'moved') return null;
                const old = asisGraph.byId.get(n.id);
                if (!old) return null;
                const nr = rectOf(n, axis, geom);
                const or = rectOf(old, axis, geom);
                return (
                  <div key={`gh-${n.id}`} className="cmp-ghost" style={{ left: nr.x, top: or.y, width: nr.w, height: FG.taskH }}>
                    <span>元: {lanes[old.lane]}</span>
                  </div>
                );
              })}

            {/* 廃止された工程ゴースト（To-Be のみ・元の As-Is 位置に表示） */}
            {!baseline &&
              deletedIds.map((id) => {
                const old = asisGraph.byId.get(id);
                if (!old) return null;
                const r = rectOf(old, axis, geom);
                return (
                  <div key={`rm-${id}`} className="cmp-cnode-wrap" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
                    <span className="cmp-cnode-tag del">廃止</span>
                    <div className="cmp-cnode deleted" title={`${old.name}（To-Beで廃止）`}>
                      <span className="nm">{old.name}</span>
                    </div>
                  </div>
                );
              })}

            {graph.nodes.map((n) => {
              const r = rectOf(n, axis, geom);
              const st = diffState[n.id];
              const box = ['cmp-cnode'];
              if (diffColor && n.diff) box.push(`diff-${n.diff.toLowerCase()}`);
              if (!baseline) {
                if (st === 'added') box.push('added');
                if (st === 'moved') box.push('moved');
                if (st === 'changed') box.push('changed');
                if (diffEmph && st === 'unchanged') box.push('dim');
              }
              let tag: { t: string; cls: string } | null = null;
              if (!baseline) {
                if (st === 'added') tag = { t: '＋ 新規', cls: 'new' };
                else if (st === 'moved') tag = { t: '↕ 移動', cls: 'move' };
              }
              return (
                <div key={n.id} className="cmp-cnode-wrap" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
                  {tag && <span className={`cmp-cnode-tag ${tag.cls}`}>{tag.t}</span>}
                  <div className={box.join(' ')} title={`${n.name}${n.lt ? ` ・ LT ${n.lt}日` : ''}${n.diff ? ` ・ 難易度 ${n.diff}` : ''}`}>
                    <span className="nm">{n.name}</span>
                  </div>
                  {!tmode && n.lt > 0 && <span className="cmp-cnode-lt">{n.lt}日</span>}
                </div>
              );
            })}

            {lanes.map((name, i) => (
              <div key={name} className="cmp-lane-label" style={{ top: geom.top[i], height: geom.height[i], width: FG.railW }}>
                {name}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function FlowCompareView({ project, level }: { project: Project; level: ProcessLevel }) {
  const [axis, setAxis] = useState<Axis>('order');
  const [diffColor, setDiffColor] = useState(true);
  const [diffEmph, setDiffEmph] = useState(true);
  const asisRef = useRef<HTMLDivElement>(null);
  const tobeRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const data = useMemo(() => {
    const asisSv = buildScenarioView(project, 'asis', level);
    const tobeSv = buildScenarioView(project, 'tobe', level);
    if (!asisSv || !tobeSv) return null;
    const lanes = unifiedLanes(asisSv, tobeSv);
    const asisG = computeGraph(asisSv, 'asis', lanes, project.details);
    const tobeG = computeGraph(tobeSv, 'tobe', lanes, project.details);
    const state: Record<string, DiffState> = {};
    const ids = new Set([...asisG.byId.keys(), ...tobeG.byId.keys()]);
    for (const id of ids) {
      const a = asisG.byId.get(id);
      const b = tobeG.byId.get(id);
      if (a && !b) state[id] = 'deleted';
      else if (!a && b) state[id] = 'added';
      else if (a && b && a.lane !== b.lane) state[id] = 'moved';
      else if (a && b && (a.lt !== b.lt || a.diff !== b.diff)) state[id] = 'changed';
      else state[id] = 'unchanged';
    }
    const geom = buildLaneGeom(lanes, asisG.laneSubrows, tobeG.laneSubrows);
    return { lanes, asisG, tobeG, state, geom };
  }, [project, level]);

  if (!data) return <div className="cmp-flow-hint">表示できるフローがありません。</div>;
  const { lanes, asisG, tobeG, state, geom } = data;
  const maxSpan = Math.max(asisG.span, tobeG.span, 1);
  const tickStep = niceTickStep(maxSpan);
  const width =
    axis === 'time'
      ? FG.x0 + maxSpan * FG.dayW + 48
      : FG.x0 + (Math.max(asisG.cols, tobeG.cols) - 1) * FG.colW + FG.taskW + 28;

  const sync = (from: 'asis' | 'tobe') => () => {
    if (syncing.current) return;
    const src = (from === 'asis' ? asisRef : tobeRef).current;
    const dst = (from === 'asis' ? tobeRef : asisRef).current;
    if (!src || !dst) return;
    syncing.current = true;
    dst.scrollLeft = src.scrollLeft;
    dst.scrollTop = src.scrollTop;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  const Seg = ({ value, set, opts }: { value: string; set: (v: string) => void; opts: [string, string][] }) => (
    <span className="seg cmp-seg-sm">
      {opts.map(([v, lab]) => (
        <button key={v} className={value === v ? 'on' : ''} onClick={() => set(v)}>
          {lab}
        </button>
      ))}
    </span>
  );

  return (
    <div className="cmp-flowcmp">
      <div className="cmp-flow-controls">
        <span className="ctl"><span className="ctl-label">横軸</span><Seg value={axis} set={(v) => setAxis(v as Axis)} opts={[['order', '工程順'], ['time', '時系列(LT)']]} /></span>
        <span className="ctl"><span className="ctl-label">難易度色</span><Seg value={diffColor ? 'on' : 'off'} set={(v) => setDiffColor(v === 'on')} opts={[['on', 'ON'], ['off', 'OFF']]} /></span>
        <span className="ctl"><span className="ctl-label">差分強調</span><Seg value={diffEmph ? 'on' : 'off'} set={(v) => setDiffEmph(v === 'on')} opts={[['on', 'ON'], ['off', 'OFF']]} /></span>
        <span className="push" />
        {diffColor && (
          <span className="cmp-flowcmp-legend">
            <span className="cmp-leg"><span className="cmp-auto-dot diff-h" />高</span>
            <span className="cmp-leg"><span className="cmp-auto-dot diff-m" />中</span>
            <span className="cmp-leg"><span className="cmp-auto-dot diff-l" />低</span>
          </span>
        )}
      </div>

      <div className="cmp-diff-legend">
        <span className="dl">As-Is は現状をそのまま表示</span>
        <span className="dl new">＋ 新規</span>
        <span className="dl del">廃止（ゴースト）</span>
        <span className="dl move">↕ 移動（元位置ゴースト）</span>
        <span className="dl unc">変化なし（淡色）</span>
      </div>

      <div className="cmp-flowsync">
        <Strip graph={asisG} asisGraph={asisG} lanes={lanes} geom={geom} phase="asis" axis={axis} diffColor={diffColor} diffEmph={diffEmph} diffState={state} width={width} tickStep={tickStep} scrollRef={asisRef} onScroll={sync('asis')} meta="直列・停滞を含む現状フロー" />
        <Strip graph={tobeG} asisGraph={asisG} lanes={lanes} geom={geom} phase="tobe" axis={axis} diffColor={diffColor} diffEmph={diffEmph} diffState={state} width={width} tickStep={tickStep} scrollRef={tobeRef} onScroll={sync('tobe')} meta="改善後フロー（差分は To-Be 側に集約）" />
      </div>
    </div>
  );
}
