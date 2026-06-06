import { useEffect, useRef, useState } from 'react';
import { useApp, findView } from './store';
import { SIZE, deriveBands, type FlowNode, type FlowNodeId } from '@gantt-flow/core';

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

  const posOf = (n: FlowNode) => (drag && drag.id === n.id ? { x: drag.x, y: drag.y } : { x: n.x, y: n.y });
  const liveCenter = (n: FlowNode) => {
    const p = posOf(n);
    const s = sizeOf(n);
    return { cx: p.x + s.w / 2, cy: p.y + s.h / 2 };
  };
  const labelOf = (n: FlowNode): string => {
    if (n.kind === 'task') return project.core.tasks[n.taskId]?.name ?? '';
    if (n.kind === 'doc') {
      const d = project.details[n.taskId];
      return [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((i) => i.id === n.ioId)?.name ?? '帳票';
    }
    if (n.kind === 'issue') return '課題';
    if (n.kind === 'comment') return n.text;
    return n.control;
  };

  return (
    <div className="flow-canvas" ref={canvasRef}>
      {/* 親範囲バンド（祖先範囲の帯） */}
      {bands.map((b) => (
        <div
          key={b.taskId}
          className="band"
          style={{ left: b.x - 10, top: 6 + (b.depth - 1) * 6, width: b.width + 20, bottom: 6 + (b.depth - 1) * 6 }}
        >
          <span className="band-label">
            {b.level === 'large' ? '大' : b.level === 'medium' ? '中' : '小'}: {b.label}
          </span>
        </div>
      ))}

      {/* スイムレーン（薄い水平線で全幅区切り） */}
      {lanes.map((lane) => (
        <div key={`ll-${lane.id}`} className="lane-label" style={{ top: MARGIN + lane.order * ROW_H - 8 }}>
          {lane.title}
        </div>
      ))}

      <svg className="edges">
        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6 z" fill="#475569" />
          </marker>
        </defs>
        {lanes.map((lane) => {
          const y = MARGIN + lane.order * ROW_H + 60;
          return <line key={`lane-${lane.id}`} className="lane-line" x1={0} y1={y} x2={2000} y2={y} />;
        })}
        {Object.values(view.edges).map((e) => {
          const s = view.nodes[e.source];
          const t = view.nodes[e.target];
          if (!s || !t) return null;
          const a = liveCenter(s);
          const b = liveCenter(t);
          return <line key={e.id} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} className="edge" markerEnd="url(#arrow)" />;
        })}
        {showIssues &&
          nodes.map((n) => {
            if (n.kind !== 'issue') return null;
            const target = view.nodes[n.targetNodeId];
            if (!target) return null;
            const a = liveCenter(n);
            const b = liveCenter(target);
            return <line key={`il-${n.id}`} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} className="issue-line" />;
          })}
      </svg>

      {nodes.map((n) => {
        const p = posOf(n);
        const cls =
          n.kind === 'task'
            ? `node task${n.taskId === selectedTaskId ? ' selected' : ''}`
            : n.kind === 'doc'
              ? `node doc ${n.io}`
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
