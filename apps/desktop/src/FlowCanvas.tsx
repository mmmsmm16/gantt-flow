import { useEffect, useRef, useState } from 'react';
import { useApp, findView } from './store';
import { useUI } from './ui/useUI';
import * as Icons from './ui/icons';
import {
  SIZE,
  deriveBands,
  ioIconRect,
  IO_ICON,
  laneLayout,
  LANE_MIN_H,
  type LaneBox,
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
  const tidyFlow = useApp((s) => s.tidyFlow);
  const setLaneHeight = useApp((s) => s.setLaneHeight);
  const moveLane = useApp((s) => s.moveLane);
  const toggleNodePin = useApp((s) => s.toggleNodePin);
  const addIo = useApp((s) => s.addIo);
  const moveNodesBy = useApp((s) => s.moveNodesBy);
  const deleteFlowNodes = useApp((s) => s.deleteFlowNodes);
  const removeManyTasks = useApp((s) => s.removeManyTasks);

  // 工程ノードの角の＋から I/O を追加（名前を尋ねてから登録。表/インスペクタにも反映）。
  const addIoPrompt = async (taskId: string, io: 'inputs' | 'outputs') => {
    const name = await useUI.getState().promptText({
      title: io === 'inputs' ? 'インプットを追加' : 'アウトプットを追加',
      placeholder: '帳票 / 情報の名称',
      confirmLabel: '追加',
    });
    if (name !== null) addIo(taskId, io, name);
  };

  // 矢印の分岐ラベルを編集（ダブルクリック / ミニツールバー共通）。
  const editEdgeLabel = async (edgeId: string, current: string) => {
    const l = await useUI.getState().promptText({
      title: '分岐ラベル',
      placeholder: '空で消去',
      defaultValue: current,
      confirmLabel: '設定',
    });
    if (l !== null) setEdgeLabel(edgeId, l);
  };

  const canvasRef = useRef<HTMLDivElement>(null);
  const laneRailRef = useRef<HTMLDivElement>(null); // 担当ラベルの固定レール（横スクロールで左端に貼り付く）
  // ノードを掴んだ画面座標と「実際に動かしたか」。ドラッグ移動後の click では選択（詳細パネル）を出さない。
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const [drag, setDrag] = useState<{ id: FlowNodeId; x: number; y: number; ox: number; oy: number; offX: number; offY: number } | null>(null);
  // 複数選択（範囲ドラッグ / Shift+クリック）。まとめて移動・削除できる。
  const [multiSel, setMultiSel] = useState<Set<FlowNodeId>>(new Set());
  const multiSelRef = useRef(multiSel);
  multiSelRef.current = multiSel;
  // 範囲選択の矩形（キャンバス座標）。Shift+空白ドラッグで開く。
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [conn, setConn] = useState<{ from: FlowNodeId; fx: number; fy: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  // フロー固有要素（制御ノード/付箋/矢印）の選択。Delete で削除・Esc で解除。
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  // レーンの高さ手動リサイズ（プレビュー中の高さを保持）。
  const [laneResize, setLaneResize] = useState<{ laneId: string; height: number } | null>(null);
  const zoomBy = (f: number) => setScale((s) => clampScale(s * f));

  // 範囲選択中に計算した「枠内ノード」を pointerup で確定するための受け渡し。
  const bandSelRef = useRef<FlowNodeId[]>([]);

  // 空白でのポインタ操作:
  //  Shift+ドラッグ … 範囲選択（矩形に触れたノードをまとめて選択）
  //  通常ドラッグ  … 画面をパン（スクロール）。クリックで選択解除。
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement;
    if (el.closest('.node, .handle, .del, button, input, a')) return; // ノード操作などは委ねる
    const scroller = canvasRef.current; // .flow-canvas 自身が横スクロール容器（ヘッダ/パレットは固定）
    if (!scroller) return;
    setSel(null); // 空白クリックで単一選択解除

    if (e.shiftKey) {
      const p0 = relPoint(e);
      bandSelRef.current = [];
      setBand({ x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y });
      const onMove = (ev: PointerEvent) => {
        const p = relPoint(ev);
        setBand((b) => (b ? { ...b, x1: p.x, y1: p.y } : b));
      };
      const onUp = () => {
        setMultiSel(new Set(bandSelRef.current));
        setBand(null);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      return;
    }

    setMultiSel(new Set()); // 通常の空白クリックは複数選択も解除
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
    const el = canvasRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    // .flow-canvas 自身が横スクロール容器なので、スクロール量を足してから倍率で割る
    // （でないとスクロール時に矢印プレビュー/ドラッグ/落下判定がカーソルとずれる）。
    return {
      x: (e.clientX - rect.left + el.scrollLeft) / scale,
      y: (e.clientY - rect.top + el.scrollTop) / scale,
    };
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
      const s = downPosRef.current;
      if (s && (Math.abs(e.clientX - s.x) > 4 || Math.abs(e.clientY - s.y) > 4)) movedRef.current = true;
      const p = relPoint(e);
      setDrag((d) => (d ? { ...d, x: p.x - d.offX, y: p.y - d.offY } : d));
    };
    const onUp = () => {
      downPosRef.current = null;
      setDrag((d) => {
        if (d && movedRef.current) {
          const ms = multiSelRef.current;
          if (ms.has(d.id) && ms.size > 1) {
            moveNodesBy([...ms], Math.round(d.x) - d.ox, Math.round(d.y) - d.oy); // 選択をまとめて移動
          } else {
            moveNode(d.id, Math.round(d.x), Math.round(d.y));
          }
        }
        return null;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, moveNode, moveNodesBy]);

  // 担当ラベルのレール: 横スクロール量だけ右へずらして常に左端へ貼り付ける（縦は内容と一緒に動く）。
  useEffect(() => {
    const scroller = canvasRef.current; // .flow-canvas 自身が横スクロール容器（ヘッダ/パレットは固定）
    if (!scroller) return;
    const pin = () => {
      const rail = laneRailRef.current;
      if (rail) rail.style.transform = `translateX(${scroller.scrollLeft}px)`;
    };
    pin();
    scroller.addEventListener('scroll', pin, { passive: true });
    return () => scroller.removeEventListener('scroll', pin);
  });

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
        // 落下先は工程/制御ノードのみ（付箋・I/O・課題には矢印を引けない＝ハイライトと一致）。
        if (n.kind !== 'task' && n.kind !== 'control') return false;
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

  // Delete=選択中の要素を削除（矢印/制御ノード/付箋＝図から、工程ノード＝確認のうえ工程ごと）。
  // Esc=選択解除。テキスト編集中やオーバーレイ表示中は無視。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || useUI.getState().overlay) return;
      const el = document.activeElement;
      const editable =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable);
      if (editable) return;
      if (e.key === 'Escape') {
        setSel(null);
        setMultiSel(new Set());
        return;
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      // 複数選択があればまとめて削除（フロー固有要素は即時、工程は確認あり）。
      const ms = multiSelRef.current;
      if (ms.size > 0 && view) {
        e.preventDefault();
        const flowSpecific: string[] = [];
        const taskIds: string[] = [];
        for (const id of ms) {
          const n = view.nodes[id];
          if (!n) continue;
          if (n.kind === 'control' || n.kind === 'comment') flowSpecific.push(id);
          else if (n.kind === 'task') taskIds.push(n.taskId);
        }
        if (flowSpecific.length) deleteFlowNodes(flowSpecific);
        if (taskIds.length) {
          void useUI
            .getState()
            .confirm({
              title: '工程を一括削除',
              message: `選択中の ${taskIds.length} 件の工程を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
              confirmLabel: '削除',
              danger: true,
            })
            .then((ok) => ok && removeManyTasks(taskIds));
        }
        setMultiSel(new Set());
        return;
      }
      if (sel?.kind === 'edge') {
        e.preventDefault();
        deleteEdge(sel.id);
        setSel(null);
        return;
      }
      if (sel && view) {
        const n = view.nodes[sel.id];
        if (n && (n.kind === 'control' || n.kind === 'comment')) {
          e.preventDefault();
          deleteFlowNode(sel.id);
          setSel(null);
        }
        return;
      }
      // フロー固有要素を選択していない場合は、選択中の工程ノードを工程ごと削除（確認あり）。
      const a = useApp.getState();
      const tid = a.selectedTaskId;
      const t = tid ? a.project.core.tasks[tid] : undefined;
      if (tid && t) {
        e.preventDefault();
        void useUI
          .getState()
          .confirm({
            title: '工程を削除',
            message: `「${t.name || '（無題）'}」を削除します（配下の工程は1つ上の階層へ繰り上げて残します）。`,
            confirmLabel: '削除',
            danger: true,
          })
          .then((ok) => {
            if (ok) {
              a.removeTask(tid);
              a.select(undefined);
            }
          });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sel, view, deleteEdge, deleteFlowNode, deleteFlowNodes, removeManyTasks]);

  if (!view) return <p className="empty">ビューがありません。</p>;

  let nodes = Object.values(view.nodes);
  if (!showIssues) nodes = nodes.filter((n) => n.kind !== 'issue');
  const lanes = Object.values(view.lanes).sort((a, b) => a.order - b.order);
  const bands = deriveBands(project.core, view);
  const divNodes = nodes.filter((n) => n.kind !== 'doc');

  // レーン幾何（可変高さ）。確定済みの高さで描画し、リサイズ中は破線ガイドだけ動かす
  // （ドラッグ中にレーンとノードがズレて見えるのを避け、確定時にまとめて反映）。
  // 担当（assignee）由来のレーンが無いビュー（例: 大/全体は工程に担当が無い）では
  // スイムレーンを一切描かない＝「担当者名の無いレーン」を出さない。
  const boxes: LaneBox[] = laneLayout(lanes);
  const hasLanes = boxes.length > 0;
  const lanesBottomY = hasLanes ? boxes[boxes.length - 1]!.top + boxes[boxes.length - 1]!.height : BAND_TOP;

  // レーン下端の手動リサイズ（ラベル列のグリップをドラッグ）。確定時に setLaneHeight（下のレーンも連動）。
  const onLaneResizeDown = (box: LaneBox, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const startY = e.clientY;
    const startH = box.height;
    const s = scale;
    setLaneResize({ laneId: box.lane.id, height: startH });
    const heightAt = (ev: PointerEvent) => Math.max(LANE_MIN_H, startH + (ev.clientY - startY) / s);
    const onMove = (ev: PointerEvent) => setLaneResize({ laneId: box.lane.id, height: heightAt(ev) });
    const onUp = (ev: PointerEvent) => {
      const h = heightAt(ev);
      setLaneResize(null);
      setLaneHeight(box.lane.id, h);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 全体表示: 全ノードの外接矩形を計算し、画面に収まる倍率と位置へスクロール（拡大は100%まで）。
  const fitView = () => {
    const scroller = canvasRef.current; // .flow-canvas 自身が横スクロール容器（ヘッダ/パレットは固定）
    if (!scroller || !nodes.length) return;
    let minX = 0;
    let minY = BAND_TOP;
    let maxX = LABEL_W;
    let maxY = BAND_TOP;
    for (const n of nodes) {
      const s = sizeOf(n);
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + s.w);
      maxY = Math.max(maxY, n.y + s.h);
    }
    const pad = 56;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const s = clampScale(Math.min(1, scroller.clientWidth / contentW, scroller.clientHeight / contentH));
    setScale(s);
    requestAnimationFrame(() => {
      scroller.scrollLeft = Math.max(0, (minX - pad) * s);
      scroller.scrollTop = Math.max(0, (minY - pad) * s);
    });
  };

  // 複数選択したノードを掴んでドラッグ中は、選択全体を同じ差分で動かして見せる。
  const groupDrag = !!drag && multiSel.has(drag.id) && multiSel.size > 1;
  const ddx = drag ? drag.x - drag.ox : 0;
  const ddy = drag ? drag.y - drag.oy : 0;
  const posOf = (n: FlowNode) => {
    if (drag && drag.id === n.id) return { x: drag.x, y: drag.y };
    if (groupDrag && multiSel.has(n.id)) return { x: n.x + ddx, y: n.y + ddy };
    return { x: n.x, y: n.y };
  };
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

  // 接続ドラッグ中の「落とせる相手」＝工程/制御ノード（自分以外）。落下受付(onUp)と同じ条件。
  const isConnTarget = (n: FlowNode) =>
    (n.kind === 'task' || n.kind === 'control') && (!conn || n.id !== conn.from);
  // カーソル直下の落下先（プレビュー矢印を吸着させ、強調表示する対象）。
  const dropTargetId = conn
    ? (divNodes.find((n) => {
        if (!isConnTarget(n)) return false;
        const p = posOf(n);
        const s = sizeOf(n);
        return conn.x >= p.x && conn.x <= p.x + s.w && conn.y >= p.y && conn.y <= p.y + s.h;
      })?.id ?? null)
    : null;
  // プレビュー矢印の終点: 落下先があればその中心へ吸着、無ければカーソル位置。
  const connEnd = conn
    ? dropTargetId
      ? center(view.nodes[dropTargetId]!)
      : { cx: conn.x, cy: conn.y }
    : null;

  // 課題ノードは工程ごとに1枚へ集約表示（モデルは1課題=1ノードのまま、描画だけ束ねる）。
  // details の課題順で先頭に対応するノードを代表(primary)とし、それ以外は描画しない。
  const issuePrimary = new Map<string, string>(); // taskId -> 代表ノードid
  {
    const groups = new Map<string, FlowNode[]>();
    for (const n of divNodes) {
      if (n.kind === 'issue') (groups.get(n.taskId) ?? groups.set(n.taskId, []).get(n.taskId)!).push(n);
    }
    for (const [taskId, arr] of groups) {
      const order = project.details[taskId]?.issues ?? [];
      const rank = (n: FlowNode) => {
        if (n.kind !== 'issue') return 1e9;
        const k = order.findIndex((i) => i.id === n.issueId);
        return k < 0 ? 1e9 : k;
      };
      arr.sort((x, y) => rank(x) - rank(y) || x.id.localeCompare(y.id));
      issuePrimary.set(taskId, arr[0]!.id);
    }
  }
  const isPrimaryIssue = (n: FlowNode) => n.kind === 'issue' && issuePrimary.get(n.taskId) === n.id;
  // 工程に記載された課題文（空欄は除外）。複数なら箇条書きで表示する。
  const issueTexts = (taskId: string): string[] =>
    (project.details[taskId]?.issues ?? []).map((i) => i.issue).filter((t) => t.trim().length > 0);

  // 範囲選択の矩形に触れているノード（描画中のプレビュー＝確定前のハイライト）。
  let bandSel: FlowNodeId[] = [];
  if (band) {
    const rx0 = Math.min(band.x0, band.x1);
    const ry0 = Math.min(band.y0, band.y1);
    const rx1 = Math.max(band.x0, band.x1);
    const ry1 = Math.max(band.y0, band.y1);
    bandSel = divNodes
      .filter((n) => {
        if (n.kind === 'issue' && !isPrimaryIssue(n)) return false;
        const s = sizeOf(n);
        return n.x < rx1 && n.x + s.w > rx0 && n.y < ry1 && n.y + s.h > ry0;
      })
      .map((n) => n.id);
  }
  bandSelRef.current = bandSel;
  const bandSelSet = new Set(bandSel);
  const isMultiSel = (n: FlowNode) => multiSel.has(n.id) || bandSelSet.has(n.id);

  return (
    <div className="flow-wrap">
      <div className="flow-palette">
        <span>追加:</span>
        <button
          className="add-task"
          title="工程を追加"
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
        <span className="palette-sep" aria-hidden="true" />
        <button className="palette-act" onClick={tidyFlow} title="自動整列（依存で段組み・レーンで縦配置）">
          <Icons.Wand />
          整列
        </button>
        <button className="palette-act" onClick={fitView} title="全体表示（画面に合わせる）">
          <Icons.Maximize />
          全体
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
        <span className="palette-hint">○ドラッグで矢印 / Shift+ドラッグで範囲選択 / Delete で削除 / Ctrl+ホイールで拡大縮小</span>
      </div>

      <div
        className={`flow-canvas${panning ? ' panning' : ''}${conn ? ' connecting' : ''}`}
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
      >
        <div
          className="flow-scale"
          style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${scale})` }}
        >
        {bands.map((b) => (
          <div
            key={b.taskId}
            className={`band band-${b.level}`}
            style={{ left: b.x, top: b.top, width: b.width, height: b.height }}
          >
            <span className="band-label">
              {b.level === 'large' ? '大' : b.level === 'medium' ? '中' : '小'}: {b.label}
            </span>
          </div>
        ))}

        {/* 担当ラベルは .flow-scale の外（lane-rail）に置き、横スクロールでも左端に固定する。 */}

        {band && (
          <div
            className="flow-band"
            style={{
              left: Math.min(band.x0, band.x1),
              top: Math.min(band.y0, band.y1),
              width: Math.abs(band.x1 - band.x0),
              height: Math.abs(band.y1 - band.y0),
            }}
          />
        )}

        <svg className="edges">
          <defs>
            <marker id="arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="3" orient="auto">
              <path d="M0,0 L7,3 L0,6 z" className="arrow-head" />
            </marker>
          </defs>

          {/* スイムレーン: 左にラベル列・可変高さの帯で区切る（並行工程で太く / 手動リサイズ）。
              担当レーンが無いビューでは描かない。 */}
          {hasLanes && (() => {
            const els: JSX.Element[] = [
              <rect key="labelcol" className="lane-col-bg" x={0} y={BAND_TOP} width={LABEL_W} height={lanesBottomY - BAND_TOP} />,
            ];
            boxes.forEach((box, i) => {
              if (i % 2 === 1)
                els.push(
                  <rect key={`bg-${box.lane.id}`} className="lane-stripe" x={LABEL_W} y={box.top} width={FULL_W} height={box.height} />,
                );
              els.push(<line key={`lh-${box.lane.id}`} className="lane-line" x1={0} y1={box.top} x2={FULL_W} y2={box.top} />);
            });
            els.push(<line key="lh-bottom" className="lane-line" x1={0} y1={lanesBottomY} x2={FULL_W} y2={lanesBottomY} />);
            els.push(<line key="vdiv" className="lane-divider" x1={LABEL_W} y1={BAND_TOP} x2={LABEL_W} y2={lanesBottomY} />);
            if (laneResize) {
              const rb = boxes.find((b) => b.lane.id === laneResize.laneId);
              if (rb) {
                const gy = rb.top + laneResize.height; // 確定済み上端 + プレビュー高さ
                els.push(
                  <line key="resize-guide" className="lane-resize-guide" x1={0} y1={gy} x2={FULL_W} y2={gy} />,
                );
              }
            }
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
                  onClick={() => setSel({ kind: 'edge', id: e.id })}
                  onDoubleClick={() => void editEdgeLabel(e.id, e.label ?? '')}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    deleteEdge(e.id);
                  }}
                />
                <path
                  d={d}
                  className={`edge${sel?.kind === 'edge' && sel.id === e.id ? ' sel' : ''}`}
                  fill="none"
                  markerEnd="url(#arrow)"
                />
                {e.label && (
                  <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} className="edge-label" textAnchor="middle">
                    {e.label}
                  </text>
                )}
              </g>
            );
          })}

          {conn && connEnd && (
            <line
              x1={conn.fx}
              y1={conn.fy}
              x2={connEnd.cx}
              y2={connEnd.cy}
              className={`edge connecting${dropTargetId ? ' on-target' : ''}`}
              markerEnd="url(#arrow)"
            />
          )}

          {showIssues &&
            nodes.map((n) => {
              if (n.kind !== 'issue' || !isPrimaryIssue(n)) return null; // 集約: 代表のみ線を引く
              const target = view.nodes[n.targetNodeId];
              if (!target) return null;
              const a = center(n);
              const b = targetCenter(target);
              return <line key={`il-${n.id}`} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} className="issue-line" />;
            })}

        </svg>

        {/* 選択中の矢印に小さなツールバー（ラベル編集 / 削除）を浮かべて、操作を見えるようにする。 */}
        {sel?.kind === 'edge' &&
          (() => {
            const e = view.edges[sel.id];
            if (!e) return null;
            const s = view.nodes[e.source];
            const t = view.nodes[e.target];
            if (!s || !t) return null;
            const sp = posOf(s);
            const ss = sizeOf(s);
            const tp = posOf(t);
            const x1 = sp.x + ss.w;
            const y1 = sp.y + ss.h / 2;
            const x2 = tp.x;
            const y2 = tp.y + sizeOf(t).h / 2;
            return (
              <div className="edge-toolbar" style={{ left: (x1 + x2) / 2, top: (y1 + y2) / 2 }}>
                <button title="分岐ラベルを編集" onClick={() => void editEdgeLabel(e.id, e.label ?? '')}>
                  ✎ ラベル
                </button>
                <button
                  className="danger"
                  title="この矢印を削除"
                  onClick={() => {
                    deleteEdge(e.id);
                    setSel(null);
                  }}
                >
                  🗑 削除
                </button>
              </div>
            );
          })()}

        {divNodes.map((n) => {
          if (n.kind === 'issue' && !isPrimaryIssue(n)) return null; // 集約: 代表ノードのみ描画
          const p = posOf(n);
          const draggable = n.kind === 'task' || n.kind === 'control' || n.kind === 'comment';
          const deletable = n.kind === 'control' || n.kind === 'comment';
          const connectable = n.kind === 'task' || n.kind === 'control';
          const focusable = draggable; // task/control/comment はキーボードで選択可能
          const isSel = sel?.kind === 'node' && sel.id === n.id;
          const selCls = isSel ? ' sel' : '';
          const multiCls = isMultiSel(n) ? ' multi-sel' : '';
          const cls =
            n.kind === 'task'
              ? `node task${n.taskId === selectedTaskId ? ' selected' : ''}${n.pinned ? ' pinned' : ''}${selCls}`
              : n.kind === 'issue'
                ? `node issue${selCls}`
                : n.kind === 'comment'
                  ? `node comment${selCls}`
                  : `node control control-${n.control}${selCls}`;
          // 接続ドラッグ中: 起点=conn-source / 落下先候補=droppable / カーソル直下=drop-active。
          const connCls = !conn
            ? ''
            : n.id === conn.from
              ? ' conn-source'
              : n.id === dropTargetId
                ? ' droppable drop-active'
                : isConnTarget(n)
                  ? ' droppable'
                  : '';
          const activate = () => {
            if (n.kind === 'task') {
              select(n.taskId);
              setSel(null);
            } else {
              setSel({ kind: 'node', id: n.id });
            }
          };
          const ariaLabel =
            n.kind === 'task'
              ? `工程: ${labelOf(n) || '（無題）'}`
              : n.kind === 'comment'
                ? `付箋: ${labelOf(n)}`
                : n.kind === 'control'
                  ? `${labelOf(n)}（制御ノード）`
                  : labelOf(n);
          return (
            <div
              key={n.id}
              className={cls + connCls + multiCls}
              style={
                n.kind === 'issue'
                  ? { left: p.x, top: p.y } // 課題は内容に応じて自動サイズ（CSS）
                  : { left: p.x, top: p.y, width: sizeOf(n).w, height: sizeOf(n).h }
              }
              role={focusable ? 'button' : undefined}
              tabIndex={focusable ? 0 : undefined}
              aria-label={focusable ? ariaLabel : undefined}
              aria-pressed={focusable ? isSel : undefined}
              onPointerDown={(e) => {
                if (!draggable) return;
                downPosRef.current = { x: e.clientX, y: e.clientY };
                movedRef.current = false;
                const pt = relPoint(e);
                setDrag({ id: n.id, x: n.x, y: n.y, ox: n.x, oy: n.y, offX: pt.x - n.x, offY: pt.y - n.y });
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (movedRef.current) {
                  movedRef.current = false; // ドラッグで動かした直後の click は選択しない
                  return;
                }
                if (e.shiftKey) {
                  // Shift+クリック: 複数選択にトグル（単一選択・詳細パネルは出さない）。
                  setMultiSel((prev) => {
                    const next = new Set(prev);
                    if (next.has(n.id)) next.delete(n.id);
                    else next.add(n.id);
                    return next;
                  });
                  setSel(null);
                  return;
                }
                setMultiSel(new Set()); // 通常クリックは複数選択を解除
                activate();
              }}
              onKeyDown={(e) => {
                if (focusable && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  activate();
                }
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
              {n.kind === 'issue' ? (
                (() => {
                  const texts = issueTexts(n.taskId);
                  if (texts.length === 0) return <span className="node-label">課題</span>;
                  if (texts.length === 1) return <span className="node-label issue-text">{texts[0]}</span>;
                  return (
                    <ul className="issue-list">
                      {texts.map((tx, i) => (
                        <li key={i}>{tx}</li>
                      ))}
                    </ul>
                  );
                })()
              ) : (
                <span className="node-label">{labelOf(n)}</span>
              )}
              {n.kind === 'task' && (
                <>
                  <button
                    className="io-add io-add-in"
                    title="インプットを追加（左上）"
                    aria-label="インプットを追加"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void addIoPrompt(n.taskId, 'inputs');
                    }}
                  >
                    ＋
                  </button>
                  <button
                    className="io-add io-add-out"
                    title="アウトプットを追加（右下）"
                    aria-label="アウトプットを追加"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      void addIoPrompt(n.taskId, 'outputs');
                    }}
                  >
                    ＋
                  </button>
                  <button
                    className="pin-btn"
                    title={n.pinned ? '固定を解除（整列で動くようになる）' : 'この工程を固定（整列で動かさない）'}
                    aria-label={n.pinned ? '固定を解除' : '工程を固定'}
                    aria-pressed={!!n.pinned}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleNodePin(n.id);
                    }}
                  >
                    📌
                  </button>
                </>
              )}
              {connectable && (
                <span
                  className="handle"
                  title="ドラッグして他の工程へ矢印を引く（前後関係を登録）"
                  onPointerDown={(e) => startConnect(n, e)}
                />
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
          <defs>
            <marker id="io-arrow" markerWidth="8" markerHeight="8" refX="6.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" className="io-source-head" />
            </marker>
          </defs>
          {nodes.map((n) => {
            if (n.kind !== 'task') return null;
            const d = project.details[n.taskId];
            const p = posOf(n);
            const inputs = d?.inputs ?? [];
            const plain = inputs.filter((it) => !it.source?.trim());
            const sourced = inputs.filter((it) => it.source?.trim());
            const mw = 88;
            const mh = 30;
            return (
              <g key={`io-${n.id}`}>
                {renderIoIcon(p, 'input', plain)}
                {renderIoIcon(p, 'output', d?.outputs ?? [])}
                {/* 出所付きの入力帳票: 出所部署のレーンに置き、工程へ矢印を引く */}
                {sourced.map((it, i) => {
                  const box = boxes.find((b) => b.lane.title === it.source);
                  const mx = p.x + i * (mw + 8);
                  const my = box ? box.base : p.y - mh - 30; // 出所レーンの工程行 / 無ければ工程の真上
                  const cx = mx + mw / 2;
                  return (
                    <g key={`src-${it.id}`} className="io-source">
                      <line
                        className="io-source-line"
                        x1={cx}
                        y1={my + mh / 2}
                        x2={p.x}
                        y2={p.y + SIZE.task.h / 2}
                        markerEnd="url(#io-arrow)"
                      />
                      <rect className="io-source-chip" x={mx} y={my} width={mw} height={mh} rx={6} />
                      <text className="io-source-name" x={cx} y={my + 13} textAnchor="middle">
                        {it.name || '帳票'}
                      </text>
                      <text className="io-source-from" x={cx} y={my + 24} textAnchor="middle">
                        {box ? it.source : `外部: ${it.source}`}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {!nodes.some((n) => n.kind === 'task') && (
          <div className="flow-empty">工程を追加すると、ここにフロー図が表示されます。</div>
        )}
        </div>

        {hasLanes && (
          <div
            className="lane-rail"
            ref={laneRailRef}
            style={{ width: LABEL_W * scale, height: lanesBottomY * scale }}
          >
            {boxes.map((box, li) => (
              <div
                key={`ll-${box.lane.id}`}
                className="lane-label"
                style={{ top: box.top * scale, height: box.height * scale }}
              >
                {box.lane.title}
                {boxes.length > 1 && (
                  <span className="lane-reorder">
                    <button
                      className="lane-mv"
                      title="レーンを上へ"
                      aria-label={`${box.lane.title}レーンを上へ`}
                      disabled={li === 0}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => moveLane(box.lane.id, -1)}
                    >
                      ▲
                    </button>
                    <button
                      className="lane-mv"
                      title="レーンを下へ"
                      aria-label={`${box.lane.title}レーンを下へ`}
                      disabled={li === boxes.length - 1}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => moveLane(box.lane.id, 1)}
                    >
                      ▼
                    </button>
                  </span>
                )}
                {box.lane.id !== '_' && (
                  <span
                    className="lane-resize"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label={`${box.lane.title}レーンの高さ（${Math.round(box.height)}px）。上下キーで変更`}
                    aria-valuenow={Math.round(box.height)}
                    aria-valuemin={LANE_MIN_H}
                    tabIndex={0}
                    title="ドラッグ / 上下キーでレーンの高さを変更"
                    onPointerDown={(e) => onLaneResizeDown(box, e)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const step = (e.shiftKey ? 24 : 10) * (e.key === 'ArrowDown' ? 1 : -1);
                        setLaneHeight(box.lane.id, box.height + step);
                      }
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
