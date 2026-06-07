import { useEffect, useRef, useState } from 'react';
import { useApp, findView } from './store';
import { useUI } from './ui/useUI';
import {
  SIZE,
  deriveBands,
  ioIconRect,
  IO_ICON,
  type ControlKind,
  type FlowNode,
  type FlowNodeId,
} from '@gantt-flow/core';

const ROW_H = 120;
const MARGIN = 40; // = core の MARGIN_Y（ノード行の基準）
const LABEL_W = 96; // 左のレーン名列
const BAND_TOP = MARGIN - 16;
const FULL_W = 3000;
const CANVAS_W = 1600; // フロー配置の論理サイズ（はみ出しはスクロール）
const CANVAS_H = 1400;
const clampScale = (s: number) => Math.min(2.5, Math.max(0.4, +s.toFixed(3)));
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
  const addTaskAt = useApp((s) => s.addTaskAt);
  const connect = useApp((s) => s.connect);
  const addControlNode = useApp((s) => s.addControlNode);
  const addComment = useApp((s) => s.addComment);
  const setEdgeLabel = useApp((s) => s.setEdgeLabel);
  const deleteEdge = useApp((s) => s.deleteEdge);
  const deleteFlowNode = useApp((s) => s.deleteFlowNode);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: FlowNodeId; x: number; y: number; offX: number; offY: number } | null>(null);
  const [conn, setConn] = useState<{ from: FlowNodeId; fx: number; fy: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const zoomBy = (f: number) => setScale((s) => clampScale(s * f));

  // 何も掴んでいない（ノード以外の）空白をドラッグ → 画面をパン（スクロール）する。
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest('.node, .handle, .del, button, input, a')) return; // ノード操作などは委ねる
    const scroller = canvasRef.current?.closest('.flow-pane') as HTMLElement | null;
    if (!scroller) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const sl = scroller.scrollLeft;
    const st = scroller.scrollTop;
    setPanning(true);
    const onMove = (ev: PointerEvent) => {
      scroller.scrollLeft = sl - (ev.clientX - startX);
      scroller.scrollTop = st - (ev.clientY - startY);
    };
    const onUp = () => {
      setPanning(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const relPoint = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return rect
      ? { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale }
      : { x: 0, y: 0 };
  };

  // Ctrl/⌘ + ホイールでズーム（通常ホイールはスクロールに委ねる）。passive:false で preventDefault。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setScale((s) => clampScale(s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

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
  const divNodes = nodes.filter((n) => n.kind !== 'doc');

  const posOf = (n: FlowNode) => (drag && drag.id === n.id ? { x: drag.x, y: drag.y } : { x: n.x, y: n.y });
  const center = (n: FlowNode) => {
    const p = posOf(n);
    const s = sizeOf(n);
    return { cx: p.x + s.w / 2, cy: p.y + s.h / 2 };
  };
  // 課題線の終点。対象が I/O(doc) なら集約アイコンの中心へ寄せる（個別ノードは非表示のため）。
  const targetCenter = (t: FlowNode) => {
    if (t.kind === 'doc') {
      const owner = nodes.find((nn) => nn.kind === 'task' && nn.taskId === t.taskId);
      if (owner) {
        const d = project.details[t.taskId];
        const items = t.io === 'input' ? (d?.inputs ?? []) : (d?.outputs ?? []);
        const r = ioIconRect(posOf(owner), t.io, items.length || 1);
        return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
      }
    }
    return center(t);
  };
  // I/O 集約アイコン（入力=左上 / 出力=右下に重ね、複数は1枚に名前を縦列挙）。
  const renderIoIcon = (
    taskPos: { x: number; y: number },
    io: 'input' | 'output',
    items: { id: string; name: string; kind: 'doc' | 'info' }[],
  ) => {
    if (!items.length) return null;
    const r = ioIconRect(taskPos, io, items.length);
    const wave = 6;
    const path = `M${r.x},${r.y} h${r.w} v${r.h - wave} q${-r.w / 4},${wave} ${-r.w / 2},0 q${-r.w / 4},${-wave} ${-r.w / 2},0 z`;
    return (
      <g className={`io-icon io-${io}`}>
        {items[0]?.kind === 'info' ? (
          <rect className="io-main" x={r.x} y={r.y} width={r.w} height={r.h} rx={8} />
        ) : (
          <path className="io-main" d={path} />
        )}
        {items.map((it, i) => (
          <text
            key={it.id}
            className="io-name"
            x={r.x + r.w / 2}
            y={r.y + IO_ICON.padTop + i * IO_ICON.line + IO_ICON.line - 3}
            textAnchor="middle"
          >
            {it.name || '帳票'}
          </text>
        ))}
      </g>
    );
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
        <button
          className="add-task"
          title="工程を追加（ダブルクリックでも作成）"
          onClick={() => {
            const k = nodes.filter((n) => n.kind === 'task').length;
            addTaskAt(220 + (k % 6) * 38, 70 + (k % 4) * 30);
          }}
        >
          工程＋
        </button>
        <button onClick={() => addControlNode('start')}>開始</button>
        <button onClick={() => addControlNode('end')}>終了</button>
        <button onClick={() => addControlNode('decision')}>判断◇</button>
        <button onClick={() => addControlNode('merge')}>合流</button>
        <button
          onClick={async () => {
            const text = await useUI.getState().promptText({
              title: '付箋を追加',
              placeholder: 'コメント',
              confirmLabel: '追加',
            });
            if (text !== null) addComment(text);
          }}
        >
          付箋
        </button>
        <span className="palette-zoom">
          <button onClick={() => zoomBy(1 / 1.2)} aria-label="縮小" title="縮小">
            −
          </button>
          <button onClick={() => setScale(1)} aria-label="ズームを100%に戻す" title="100%にリセット">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoomBy(1.2)} aria-label="拡大" title="拡大">
            ＋
          </button>
        </span>
        <span className="palette-hint">○ドラッグで矢印 / Ctrl+ホイールで拡大縮小</span>
      </div>

      <div
        className={`flow-canvas${panning ? ' panning' : ''}`}
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
        onDoubleClick={(e) => {
          const el = e.target as HTMLElement;
          if (el.closest('.node, .handle, .del, button, input, a')) return; // 既存要素上は無視
          const p = relPoint(e);
          addTaskAt(p.x, p.y);
        }}
      >
        <div
          className="flow-scale"
          style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})` }}
        >
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
              <path d="M0,0 L7,3 L0,6 z" className="arrow-head" />
            </marker>
          </defs>

          {/* スイムレーン: 左にラベル列・薄い水平線で全幅を帯に区切る */}
          {(() => {
            const cnt = Math.max(1, lanes.length);
            const bottom = BAND_TOP + cnt * ROW_H;
            const els: JSX.Element[] = [
              <rect key="labelcol" className="lane-col-bg" x={0} y={BAND_TOP} width={LABEL_W} height={cnt * ROW_H} />,
            ];
            for (let i = 0; i < cnt; i++) {
              if (i % 2 === 1)
                els.push(
                  <rect key={`bg-${i}`} className="lane-stripe" x={LABEL_W} y={BAND_TOP + i * ROW_H} width={FULL_W} height={ROW_H} />,
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
            const midX = (x1 + x2) / 2;
            // 直角（オーソゴナル）コネクタ: 水平 → 垂直 → 水平
            const d = `M${x1},${y1} H${midX} V${y2} H${x2}`;
            return (
              <g key={e.id}>
                <path
                  d={d}
                  className="edge-hit"
                  style={{ pointerEvents: 'stroke' }}
                  onClick={async () => {
                    const l = await useUI.getState().promptText({
                      title: '分岐ラベル',
                      placeholder: '空で消去',
                      defaultValue: e.label ?? '',
                      confirmLabel: '設定',
                    });
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
              const b = targetCenter(target);
              return <line key={`il-${n.id}`} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} className="issue-line" />;
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
              {n.kind === 'control' && (n.control === 'decision' || n.control === 'merge') && (
                <svg
                  className="control-diamond"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <polygon points="50,1 99,50 50,99 1,50" />
                </svg>
              )}
              <span className="node-label">{labelOf(n)}</span>
              {connectable && (
                <span className="handle" title="ドラッグして矢印を引く" onPointerDown={(e) => startConnect(n, e)} />
              )}
              {deletable && (
                <button
                  className="del"
                  title="削除"
                  aria-label="ノードを削除"
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
        <svg className="io-overlay" width={CANVAS_W} height={CANVAS_H}>
          {nodes.map((n) => {
            if (n.kind !== 'task') return null;
            const d = project.details[n.taskId];
            const p = posOf(n);
            return (
              <g key={`io-${n.id}`}>
                {renderIoIcon(p, 'input', d?.inputs ?? [])}
                {renderIoIcon(p, 'output', d?.outputs ?? [])}
              </g>
            );
          })}
        </svg>

        {!nodes.some((n) => n.kind === 'task') && (
          <div className="flow-empty">工程を追加すると、ここにフロー図が表示されます。</div>
        )}
        </div>
      </div>
    </div>
  );
}
