import { useEffect, useRef, useState } from 'react';
import { useApp, findView } from './store';
import {
  SIZE,
  deriveBands,
  type ControlKind,
  type FlowNode,
  type FlowDocNode,
  type FlowNodeId,
} from '@gantt-flow/core';

const ROW_H = 120;
const MARGIN = 40; // = core の MARGIN_Y（ノード行の基準）
const LABEL_W = 96; // 左のレーン名列
const BAND_TOP = MARGIN - 16;
const FULL_W = 3000;
const CONTROL_LABEL: Record<ControlKind, string> = {
  start: '開始',
  end: '終了',
  decision: '判断',
  merge: '合流',
};

function sizeOf(n: FlowNode) {
  if (n.kind === 'task') return SIZE.task;
  if (n.kind === 'doc') return SIZE.doc;
  if (n.kind === 'issue') return SIZE.issue;
  if (n.kind === 'comment') return SIZE.comment;
  return SIZE.control;
}

export function FlowCanvas() {
  const project = useApp((s) => s.project);
  const level = useApp((s) => s.level);
  const scopeParentId = useApp((s) => s.scopeParentId);
  const showIssues = useApp((s) => s.showIssues);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const moveNode = useApp((s) => s.moveNode);
  const connect = useApp((s) => s.connect);
  const addControlNode = useApp((s) => s.addControlNode);
  const addComment = useApp((s) => s.addComment);
  const setEdgeLabel = useApp((s) => s.setEdgeLabel);
  const deleteEdge = useApp((s) => s.deleteEdge);
  const deleteFlowNode = useApp((s) => s.deleteFlowNode);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: FlowNodeId; x: number; y: number; offX: number; offY: number } | null>(null);
  const [conn, setConn] = useState<{ from: FlowNodeId; fx: number; fy: number; x: number; y: number } | null>(null);

  const relPoint = (e: PointerEvent | React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : { x: 0, y: 0 };
  };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const p = relPoint(e);
      setDrag((d) => (d ? { ...d, x: p.x - d.offX, y: p.y - d.offY } : d));
    };
    const onUp = () =>
      setDrag((d) => {
        if (d) moveNode(d.id, Math.round(d.x), Math.round(d.y));
        return null;
      });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, moveNode]);

  const view = findView(project, level, scopeParentId);

  useEffect(() => {
    if (!conn || !view) return;
    const onMove = (e: PointerEvent) => {
      const p = relPoint(e);
      setConn((c) => (c ? { ...c, x: p.x, y: p.y } : c));
    };
    const onUp = (e: PointerEvent) => {
      const p = relPoint(e);
      const target = Object.values(view.nodes).find((n) => {
        if (n.kind === 'doc' || n.kind === 'issue') return false;
        const s = sizeOf(n);
        return p.x >= n.x && p.x <= n.x + s.w && p.y >= n.y && p.y <= n.y + s.h;
      });
      setConn((c) => {
        if (c && target && target.id !== c.from) connect(c.from, target.id);
        return null;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [conn, view, connect]);

  if (!view) return <p className="empty">ビューがありません。</p>;

  let nodes = Object.values(view.nodes);
  if (!showIssues) nodes = nodes.filter((n) => n.kind !== 'issue');
  const lanes = Object.values(view.lanes).sort((a, b) => a.order - b.order);
  const bands = deriveBands(project.core, view);
  const docNodes = nodes.filter((n): n is FlowDocNode => n.kind === 'doc');
  const divNodes = nodes.filter((n) => n.kind !== 'doc');

  const posOf = (n: FlowNode) => (drag && drag.id === n.id ? { x: drag.x, y: drag.y } : { x: n.x, y: n.y });
  const center = (n: FlowNode) => {
    const p = posOf(n);
    const s = sizeOf(n);
    return { cx: p.x + s.w / 2, cy: p.y + s.h / 2 };
  };
  const ioKindOf = (n: FlowDocNode) => {
    const d = project.details[n.taskId];
    return [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((i) => i.id === n.ioId)?.kind ?? 'doc';
  };
  const docLabel = (n: FlowDocNode) => {
    const d = project.details[n.taskId];
    return [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((i) => i.id === n.ioId)?.name ?? '帳票';
  };
  const labelOf = (n: FlowNode): string => {
    if (n.kind === 'task') return project.core.tasks[n.taskId]?.name ?? '';
    if (n.kind === 'issue') return '課題';
    if (n.kind === 'comment') return n.text;
    if (n.kind === 'control') return CONTROL_LABEL[n.control];
    return '';
  };

  const startConnect = (n: FlowNode, e: React.PointerEvent) => {
    e.stopPropagation();
    const p = posOf(n);
    const s = sizeOf(n);
    setConn({ from: n.id, fx: p.x + s.w, fy: p.y + s.h / 2, x: p.x + s.w, y: p.y + s.h / 2 });
  };

  return (
    <div className="flow-wrap">
      <div className="flow-palette">
        <span>追加:</span>
        <button onClick={() => addControlNode('start')}>開始</button>
        <button onClick={() => addControlNode('end')}>終了</button>
        <button onClick={() => addControlNode('decision')}>判断◇</button>
        <button onClick={() => addControlNode('merge')}>合流</button>
        <button onClick={() => addComment(prompt('コメント') ?? '')}>付箋</button>
        <span className="palette-hint">ノード右の○をドラッグで矢印を引く</span>
      </div>

      <div className="flow-canvas" ref={canvasRef}>
        {bands.map((b) => (
          <div
            key={b.taskId}
            className={`band band-${b.level}`}
            style={{ left: b.x - 12, top: 8 + (b.depth - 1) * 8, width: b.width + 24, bottom: 8 + (b.depth - 1) * 8 }}
          >
            <span className="band-label">
              {b.level === 'large' ? '大' : b.level === 'medium' ? '中' : '小'}: {b.label}
            </span>
          </div>
        ))}

        {(lanes.length ? lanes : [{ id: '_', title: '（未割当）', order: 0 }]).map((lane) => (
          <div
            key={`ll-${lane.id}`}
            className="lane-label"
            style={{ top: BAND_TOP + lane.order * ROW_H, height: ROW_H }}
          >
            {lane.title}
          </div>
        ))}

        <svg className="edges">
          <defs>
            <marker id="arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto">
              <path d="M0,0 L7,3 L0,6 z" fill="#64748b" />
            </marker>
          </defs>

          {/* スイムレーン: 左にラベル列・薄い水平線で全幅を帯に区切る */}
          {(() => {
            const cnt = Math.max(1, lanes.length);
            const bottom = BAND_TOP + cnt * ROW_H;
            const els: JSX.Element[] = [
              <rect key="labelcol" x={0} y={BAND_TOP} width={LABEL_W} height={cnt * ROW_H} fill="#f8fafc" />,
            ];
            for (let i = 0; i < cnt; i++) {
              if (i % 2 === 1)
                els.push(
                  <rect key={`bg-${i}`} x={LABEL_W} y={BAND_TOP + i * ROW_H} width={FULL_W} height={ROW_H} fill="rgba(2,6,23,0.015)" />,
                );
            }
            for (let i = 0; i <= cnt; i++) {
              els.push(<line key={`lh-${i}`} className="lane-line" x1={0} y1={BAND_TOP + i * ROW_H} x2={FULL_W} y2={BAND_TOP + i * ROW_H} />);
            }
            els.push(<line key="vdiv" className="lane-divider" x1={LABEL_W} y1={BAND_TOP} x2={LABEL_W} y2={bottom} />);
            return els;
          })()}

          {Object.values(view.edges).map((e) => {
            const s = view.nodes[e.source];
            const t = view.nodes[e.target];
            if (!s || !t) return null;
            const sp = posOf(s);
            const ss = sizeOf(s);
            const tp = posOf(t);
            const ts = sizeOf(t);
            const x1 = sp.x + ss.w;
            const y1 = sp.y + ss.h / 2;
            const x2 = tp.x;
            const y2 = tp.y + ts.h / 2;
            const dx = Math.max(30, Math.abs(x2 - x1) / 2);
            const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
            return (
              <g key={e.id}>
                <path
                  d={d}
                  className="edge-hit"
                  style={{ pointerEvents: 'stroke' }}
                  onClick={() => {
                    const l = prompt('分岐ラベル（空で消去）', e.label ?? '');
                    if (l !== null) setEdgeLabel(e.id, l);
                  }}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    deleteEdge(e.id);
                  }}
                />
                <path d={d} className="edge" fill="none" markerEnd="url(#arrow)" />
                {e.label && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} className="edge-label" textAnchor="middle">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {conn && (
            <line x1={conn.fx} y1={conn.fy} x2={conn.x} y2={conn.y} className="edge connecting" markerEnd="url(#arrow)" />
          )}

          {showIssues &&
            nodes.map((n) => {
              if (n.kind !== 'issue') return null;
              const target = view.nodes[n.targetNodeId];
              if (!target) return null;
              const a = center(n);
              const b = center(target);
              return <line key={`il-${n.id}`} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} className="issue-line" />;
            })}

          {docNodes.map((n) => {
            const p = posOf(n);
            const s = SIZE.doc;
            const cls = `io-${n.io}`;
            const tx = p.x + s.w / 2;
            const ty = p.y + s.h / 2 + 4;
            if (ioKindOf(n) === 'info') {
              return (
                <g key={n.id} className={`doc-shape ${cls}`}>
                  <rect x={p.x} y={p.y} width={s.w} height={s.h} rx={s.h / 2} />
                  <text x={tx} y={ty} textAnchor="middle">
                    {docLabel(n)}
                  </text>
                </g>
              );
            }
            const wave = 6;
            const d = `M${p.x},${p.y} h${s.w} v${s.h - wave} q${-s.w / 4},${wave} ${-s.w / 2},0 q${-s.w / 4},${-wave} ${-s.w / 2},0 z`;
            return (
              <g key={n.id} className={`doc-shape ${cls}`}>
                <path d={d} />
                <text x={tx} y={ty} textAnchor="middle">
                  {docLabel(n)}
                </text>
              </g>
            );
          })}
        </svg>

        {divNodes.map((n) => {
          const p = posOf(n);
          const draggable = n.kind === 'task' || n.kind === 'control' || n.kind === 'comment';
          const deletable = n.kind === 'control' || n.kind === 'comment';
          const connectable = n.kind === 'task' || n.kind === 'control';
          const cls =
            n.kind === 'task'
              ? `node task${n.taskId === selectedTaskId ? ' selected' : ''}`
              : n.kind === 'issue'
                ? 'node issue'
                : n.kind === 'comment'
                  ? 'node comment'
                  : `node control control-${n.control}`;
          return (
            <div
              key={n.id}
              className={cls}
              style={{ left: p.x, top: p.y, width: sizeOf(n).w, height: sizeOf(n).h }}
              onPointerDown={(e) => {
                if (!draggable) return;
                const pt = relPoint(e);
                setDrag({ id: n.id, x: n.x, y: n.y, offX: pt.x - n.x, offY: pt.y - n.y });
              }}
              onClick={() => {
                if (n.kind === 'task') select(n.taskId);
              }}
            >
              {labelOf(n)}
              {connectable && (
                <span className="handle" title="ドラッグして矢印を引く" onPointerDown={(e) => startConnect(n, e)} />
              )}
              {deletable && (
                <button
                  className="del"
                  title="削除"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteFlowNode(n.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
