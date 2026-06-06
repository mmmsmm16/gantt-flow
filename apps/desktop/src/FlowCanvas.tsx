import { useEffect, useRef, useState } from 'react';
import { useApp, findView } from './store';
import { SIZE, deriveBands, type FlowNode, type FlowDocNode, type FlowNodeId } from '@gantt-flow/core';

const ROW_H = 120;
const MARGIN = 40;

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

  const canvasRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: FlowNodeId; x: number; y: number; offX: number; offY: number } | null>(null);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDrag((d) => (d ? { ...d, x: e.clientX - rect.left - d.offX, y: e.clientY - rect.top - d.offY } : d));
    };
    const onUp = () => {
      setDrag((d) => {
        if (d) moveNode(d.id, Math.round(d.x), Math.round(d.y));
        return null;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, moveNode]);

  const view = findView(project, level, scopeParentId);
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
  const ioKindOf = (n: FlowDocNode): 'doc' | 'info' => {
    const d = project.details[n.taskId];
    const item = [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((i) => i.id === n.ioId);
    return item?.kind ?? 'doc';
  };
  const docLabel = (n: FlowDocNode): string => {
    const d = project.details[n.taskId];
    return [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((i) => i.id === n.ioId)?.name ?? '帳票';
  };
  const labelOf = (n: FlowNode): string => {
    if (n.kind === 'task') return project.core.tasks[n.taskId]?.name ?? '';
    if (n.kind === 'issue') return '課題';
    if (n.kind === 'comment') return n.text;
    if (n.kind === 'control') return n.control;
    return '';
  };

  return (
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

      {lanes.map((lane) => (
        <div key={`ll-${lane.id}`} className="lane-label" style={{ top: MARGIN + lane.order * ROW_H - 8 }}>
          {lane.title}
        </div>
      ))}

      <svg className="edges">
        <defs>
          <marker id="arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto">
            <path d="M0,0 L7,3 L0,6 z" fill="#64748b" />
          </marker>
        </defs>

        {lanes.map((lane) => {
          const y = MARGIN + lane.order * ROW_H + 60;
          return <line key={`lane-${lane.id}`} className="lane-line" x1={0} y1={y} x2={3000} y2={y} />;
        })}

        {/* プロセス矢印: 右端 → 左端（ベジェ） */}
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
          return (
            <path
              key={e.id}
              d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`}
              className="edge"
              fill="none"
              markerEnd="url(#arrow)"
            />
          );
        })}

        {/* 課題の線（細い薄線・矢頭なし） */}
        {showIssues &&
          nodes.map((n) => {
            if (n.kind !== 'issue') return null;
            const target = view.nodes[n.targetNodeId];
            if (!target) return null;
            const a = center(n);
            const b = center(target);
            return <line key={`il-${n.id}`} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} className="issue-line" />;
          })}

        {/* 帳票/情報（I/O）: 帳票形 or 情報チップ */}
        {docNodes.map((n) => {
          const p = posOf(n);
          const s = SIZE.doc;
          const cls = `io-${n.io}`;
          const kind = ioKindOf(n);
          const tx = p.x + s.w / 2;
          const ty = p.y + s.h / 2 + 4;
          if (kind === 'info') {
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
        const cls =
          n.kind === 'task'
            ? `node task${n.taskId === selectedTaskId ? ' selected' : ''}`
            : n.kind === 'issue'
              ? 'node issue'
              : n.kind === 'comment'
                ? 'node comment'
                : 'node control';
        const draggable = n.kind === 'task';
        return (
          <div
            key={n.id}
            className={cls}
            style={{ left: p.x, top: p.y, width: sizeOf(n).w, height: sizeOf(n).h }}
            onPointerDown={(e) => {
              if (!draggable) return;
              const rect = canvasRef.current?.getBoundingClientRect();
              if (!rect) return;
              setDrag({ id: n.id, x: n.x, y: n.y, offX: e.clientX - rect.left - n.x, offY: e.clientY - rect.top - n.y });
            }}
            onClick={() => {
              if (n.kind === 'task') select(n.taskId);
            }}
          >
            {labelOf(n)}
          </div>
        );
      })}
    </div>
  );
}
