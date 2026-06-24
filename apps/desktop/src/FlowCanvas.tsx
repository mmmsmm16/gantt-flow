import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useApp, findView, isBridgeEdge } from './store';
import { useUI } from './ui/useUI';
import { useFlashIds } from './ui/useFlash';
import { pushKeyContext, registerContextHandler } from './ui/useGlobalHotkeys';
import { chordKeys, getActiveKeymap, isImeKeyEvent } from './keymap';
import { clampScale, zoomScroll } from './flowZoom';
import { confirmRemoveTasks, revealTask } from './taskOps';
import { TASK_COLORS } from './theme';
import { nearestInDirection, firstVisual, alignTarget, type NavDir } from './spatialNav';
import { computeSnap, type SnapGuide, type SnapRect } from './snap';
import * as Icons from './ui/icons';
import { ioInfoChipPath, ioDocBodyPath, ioDocFoldPoints } from './flowShapes';
import {
  SIZE,
  deriveBands,
  ioIconRect,
  IO_ICON,
  issueLineTarget,
  issuePrimaryIds,
  laneLayout,
  nodeRect,
  nodeSize,
  routeEdge,
  sourceChipLayout,
  LANE_MIN_H,
  type EdgeRoute,
  type LaneBox,
  type ControlKind,
  type FlowEdge,
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
// ドラッグ吸着の距離（画面ピクセル）。論理座標へは scale で割って換算する。
const SNAP_PX = 6;
const CONTROL_LABEL: Record<ControlKind, string> = {
  start: '開始',
  end: '終了',
  decision: '判断',
  merge: '合流',
};

export function FlowCanvas() {
  const project = useApp((s) => s.project);
  const level = useApp((s) => s.level);
  const scopeParentId = useApp((s) => s.scopeParentId);
  const showIssues = useApp((s) => s.showIssues);
  const showMinimap = useUI((s) => s.minimap);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  const moveNode = useApp((s) => s.moveNode);
  const addTaskAt = useApp((s) => s.addTaskAt);
  const addTaskNextTo = useApp((s) => s.addTaskNextTo);
  const connect = useApp((s) => s.connect);
  const connectToNew = useApp((s) => s.connectToNew);
  const addParallel = useApp((s) => s.addParallel);
  const makeParallelTo = useApp((s) => s.makeParallelTo);
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
  const renameTask = useApp((s) => s.renameTask);
  const duplicateTask = useApp((s) => s.duplicateTask);
  const insertTaskOnEdge = useApp((s) => s.insertTaskOnEdge);
  const updateComment = useApp((s) => s.updateComment);
  // 表側編集の同期で追加されたノードを一時ハイライト（どこが変わったかを示すフラッシュ）。
  const lastSyncAdded = useApp((s) => s.lastSyncAdded);
  const flashIds = useFlashIds(lastSyncAdded);

  // その場リネームの確定。触れただけの blur(未変更)では履歴と未保存フラグを汚さない
  // (表の commitName / インスペクタの commitText と同じ規約)。
  const commitNodeRename = (taskId: string, value: string) => {
    if (value !== (project.core.tasks[taskId]?.name ?? '')) renameTask(taskId, value);
  };

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

  // 付箋のテキストを編集（右クリックメニュー）。
  const editCommentText = async (nodeId: FlowNodeId, current: string) => {
    const text = await useUI.getState().promptText({
      title: '付箋を編集',
      placeholder: 'コメント',
      defaultValue: current,
      confirmLabel: '設定',
    });
    if (text !== null) updateComment(nodeId, text);
  };

  const canvasRef = useRef<HTMLDivElement>(null);
  const laneRailRef = useRef<HTMLDivElement>(null); // 担当ラベルの固定レール（横スクロールで左端に貼り付く）
  // ノードを掴んだ画面座標と「実際に動かしたか」。ドラッグ移動後の click では選択（詳細パネル）を出さない。
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const [drag, setDrag] = useState<{ id: FlowNodeId; x: number; y: number; ox: number; oy: number; offX: number; offY: number } | null>(null);
  // ドラッグ吸着（スマートガイド）。候補はドラッグ開始時に 1 回だけ構築して ref に保持
  // （drag effect は毎フレーム再実行されるため、effect 内で組むと毎フレーム O(n) になる）。
  const snapCtxRef = useRef<{ size: { w: number; h: number }; candidates: SnapRect[] } | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  // 複数選択（範囲ドラッグ / Shift+クリック）。まとめて移動・削除できる。
  const [multiSel, setMultiSel] = useState<Set<FlowNodeId>>(new Set());
  const multiSelRef = useRef(multiSel);
  multiSelRef.current = multiSel;
  // 範囲選択の矩形（キャンバス座標）。Shift+空白ドラッグで開く。
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // フロー上で工程名をその場編集している対象（ダブルクリック / F2）。
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  // キーボードピッカー。mode='connect'(c)は接続先、'parallel'(Shift+P)は並行化の基準工程を、
  // 起点から候補(距離順)を Tab/矢印で循環し Enter(またはクリック)で確定する。
  const [kbConnect, setKbConnect] = useState<{
    mode: 'connect' | 'parallel';
    from: FlowNodeId;
    candidates: FlowNodeId[];
    idx: number;
  } | null>(null);
  const [conn, setConn] = useState<{ from: FlowNodeId; fx: number; fy: number; x: number; y: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  // フロー固有要素（制御ノード/付箋/矢印）の選択。Delete で削除・Esc で解除。
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  // 右クリックメニュー（ノード/矢印）。位置はカーソルの画面座標（fixed 配置）。
  const [ctxMenu, setCtxMenu] = useState<{ kind: 'node' | 'edge'; id: string; x: number; y: number } | null>(null);
  // レーンの高さ手動リサイズ（プレビュー中の高さを保持）。
  const [laneResize, setLaneResize] = useState<{ laneId: string; height: number } | null>(null);

  // アンカー付きズーム。setScale は非同期なので新 scale をここで確定し、同じ値でスクロールを補正する
  // （fitView と同じ「scale 設定 → rAF でスクロール」パターン）。scaleRef は再レンダ前の連続ホイール
  // でも複利で効くよう zoomAt 内で即時更新し、外部の setScale（リセット/フィット）とは描画で同期する。
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // 直前のズームで予約したスクロール位置。連続ズーム時、el.scrollLeft はまだ古い scale の値の
  // ままなので、予約値を基準に次の補正を計算する（適用した rAF でクリア）。
  const pendingZoomScroll = useRef<{ left: number; top: number } | null>(null);
  const zoomAt = (factor: number, anchor?: { x: number; y: number }) => {
    const el = canvasRef.current;
    const prev = scaleRef.current;
    const next = clampScale(prev * factor);
    if (next === prev || !el) return; // clamp で scale が変わらないときは補正もしない
    scaleRef.current = next;
    setScale(next);
    const rect = el.getBoundingClientRect();
    // アンカー＝カーソル位置（ホイール）。省略時はビューポート中央（±ボタン / +,- キー）。
    const a = anchor
      ? { x: anchor.x - rect.left, y: anchor.y - rect.top }
      : { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const target = zoomScroll(
      pendingZoomScroll.current ?? { left: el.scrollLeft, top: el.scrollTop },
      a,
      prev,
      next,
    );
    pendingZoomScroll.current = target;
    requestAnimationFrame(() => {
      const t = pendingZoomScroll.current;
      if (!t) return; // 後続のズームが適用済み
      el.scrollLeft = t.left;
      el.scrollTop = t.top;
      pendingZoomScroll.current = null;
    });
  };
  const zoomBy = (f: number) => zoomAt(f);

  // 'flow' コンテキストのキーボードアクション(矢印移動・ズーム・リネーム・接続モード)。
  // ハンドラ本体は描画後半(fitView 等の定義後)で ref に流し込み、登録自体は初回のみ行う。
  const flowActionsRef = useRef<((action: string, e: KeyboardEvent) => boolean) | null>(null);
  useEffect(
    () =>
      registerContextHandler('flow', (action, e) => flowActionsRef.current?.(action, e) ?? false),
    [],
  );

  // 接続モードの現候補へ視点を追従(候補が画面外だと何を選んでいるか分からないため)。
  // 'nearest' なので見えている間はスクロールせず、枠外のときだけ最小限寄せる。
  useEffect(() => {
    const id = kbConnect ? kbConnect.candidates[kbConnect.idx] : undefined;
    if (!id) return;
    document
      .querySelector(`[data-nodeid="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [kbConnect]);

  // 接続モード中は 'connect' コンテキストを最優先で有効化し、Tab/矢印/hjkl/Enter/Esc/c は
  // keymap('connect') → 中央ディスパッチ(useGlobalHotkeys)経由で受ける。IME・ダイアログ・
  // 編集中などのガードを全ハンドラと共通化する(capture での横取りはしない＝プロンプト表示中の
  // Enter はプロンプトの確定に届く)。ハンドラ本体は描画後半で ref に流し込む。
  const connectActionsRef = useRef<((action: string) => boolean) | null>(null);
  const connecting = kbConnect !== null;
  useEffect(() => {
    if (!connecting) return undefined;
    const release = pushKeyContext('connect');
    const unregister = registerContextHandler(
      'connect',
      (action) => connectActionsRef.current?.(action) ?? false,
    );
    return () => {
      unregister();
      release();
    };
  }, [connecting]);

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

  // いま見えているキャンバス中央（論理座標）。制御ノード/付箋を画面の真ん中へ置くために使う。
  const viewportCenter = () => {
    const el = canvasRef.current;
    if (!el) return undefined;
    return {
      x: Math.round((el.scrollLeft + el.clientWidth / 2) / scale),
      y: Math.round((el.scrollTop + el.clientHeight / 2) / scale),
    };
  };
  // 指定種別のノードを画面中央に置くための top-left（中央 − サイズの半分）。
  const spawnPos = (w: number, h: number) => {
    const c = viewportCenter();
    return c ? { x: c.x - w / 2, y: c.y - h / 2 } : { x: undefined, y: undefined };
  };

  // 空白をダブルクリック → その位置に工程を新規作成（ノード上は各自の編集に委ねる）。
  const onCanvasDoubleClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('.node, .handle, .del, button, input, a, .lane-rail, .flow-minimap, .edge-toolbar')) return;
    if ((e.target as Element).closest('svg.edges')) {
      // 矢印（edge-hit）上のダブルクリックはラベル編集に委ねるため、線以外の余白だけで作成。
      if ((e.target as HTMLElement).classList.contains('edge-hit')) return;
    }
    const p = relPoint(e);
    const id = addTaskAt(p.x - SIZE.task.w / 2, p.y - SIZE.task.h / 2);
    if (id) setEditingTaskId(id); // 作成直後にその場リネーム（「新規工程」の量産を防ぐ）
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
  // カーソル位置をアンカーに補正＝拡大してもカーソル直下の工程が画面外へ流れない。
  // zoomAt は ref と安定な setter にしか触れないため、初回登録のままで stale にならない。
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!drag) {
      setSnapGuides((g) => (g.length ? [] : g)); // ドラッグ終了後にガイドが残らないように
      return;
    }
    const onMove = (e: PointerEvent) => {
      const s = downPosRef.current;
      if (s && (Math.abs(e.clientX - s.x) > 4 || Math.abs(e.clientY - s.y) > 4)) movedRef.current = true;
      const p = relPoint(e);
      // 近くのノードと上端/中央・左端/中央が揃う位置へ吸着（Alt/Option 押下中は無効）。
      // 吸着済みの座標を drag に書くので、確定(onUp)もそのまま揃った値になる。
      let nx = p.x - drag.offX;
      let ny = p.y - drag.offY;
      let guides: SnapGuide[] = [];
      const ctx = snapCtxRef.current;
      if (ctx && !e.altKey) {
        const snapped = computeSnap({ x: nx, y: ny, ...ctx.size }, ctx.candidates, SNAP_PX / scale);
        nx = snapped.x;
        ny = snapped.y;
        guides = snapped.guides;
      }
      setSnapGuides(guides);
      setDrag((d) => (d ? { ...d, x: nx, y: ny } : d));
    };
    const onUp = () => {
      downPosRef.current = null;
      snapCtxRef.current = null;
      setSnapGuides([]);
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

  // 確定座標での全エッジ経路(エッジ id → 経路)。routeEdge は障害物の数に応じて高くつくため
  // ビュー単位でメモ化する。ドラッグ中はドラッグ対象に接続するエッジだけ見かけの位置で
  // 再計算し(routeOf)、それ以外はこの結果を使い回す＝毎フレームの全再ルートを避ける。
  const baseRoutes = useMemo(() => {
    const routes = new Map<string, EdgeRoute>();
    if (!view) return routes;
    const obstacles = Object.values(view.nodes)
      .filter((n) => n.kind === 'task' || n.kind === 'control' || n.kind === 'comment')
      .map((n) => ({ id: n.id, ...nodeRect(n) }));
    for (const e of Object.values(view.edges)) {
      const s = view.nodes[e.source];
      const t = view.nodes[e.target];
      if (!s || !t) continue;
      routes.set(
        e.id,
        routeEdge(
          nodeRect(s),
          nodeRect(t),
          obstacles.filter((o) => o.id !== e.source && o.id !== e.target),
        ),
      );
    }
    return routes;
  }, [view]);

  useEffect(() => {
    if (!conn || !view) return;
    const onMove = (e: PointerEvent) => {
      const p = relPoint(e);
      setConn((c) => (c ? { ...c, x: p.x, y: p.y } : c));
    };
    const from = conn.from; // ドラッグ中は不変（x/y のみ更新される）
    const onUp = (e: PointerEvent) => {
      const p = relPoint(e);
      const target = Object.values(view.nodes).find((n) => {
        // 落下先は工程/制御ノードのみ（付箋・I/O・課題には矢印を引けない＝ハイライトと一致）。
        if (n.kind !== 'task' && n.kind !== 'control') return false;
        const s = nodeSize(n);
        return p.x >= n.x && p.x <= n.x + s.w && p.y >= n.y && p.y <= n.y + s.h;
      });
      if (target && target.id !== from) {
        connect(from, target.id);
      } else if (!target) {
        // 空白で離した: ドロップ位置に工程を作成して起点から接続 → 直後にその場リネーム。
        const newId = connectToNew(from, p.x - SIZE.task.w / 2, p.y - SIZE.task.h / 2);
        if (newId) setEditingTaskId(newId);
      }
      setConn(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [conn, view, connect, connectToNew]);

  // 選択中の工程が変わったら、対応するフローノードが画面外のとき視点を寄せる（表→フロー追従）。
  // 'nearest' なので見えている間はスクロールしない＝フロー側の操作で既に見えている時は動かない。
  useEffect(() => {
    if (!selectedTaskId || !view) return;
    const node = Object.values(view.nodes).find(
      (n) => n.kind === 'task' && n.taskId === selectedTaskId,
    );
    if (!node) return;
    const raf = requestAnimationFrame(() => {
      document
        .querySelector(`[data-nodeid="${CSS.escape(node.id)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedTaskId, view]);

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
      const s = nodeSize(n);
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

  // キーボード操作の対象ノード: 複数選択 > フロー固有選択(sel) > 選択中の工程のノード。
  const keyTargets = (): FlowNodeId[] => {
    if (multiSel.size > 0) return [...multiSel];
    if (sel?.kind === 'node') return [sel.id];
    if (selectedTaskId) {
      const n = Object.values(view.nodes).find(
        (o) => o.kind === 'task' && o.taskId === selectedTaskId,
      );
      if (n) return [n.id];
    }
    return [];
  };

  // 矢印キーで選択を隣のノードへ移す(空間ナビ)。未選択なら左上のノードから開始。
  const navBoxes = () =>
    divNodes
      .filter((n) => n.kind === 'task' || n.kind === 'control' || n.kind === 'comment')
      .map((n) => ({ id: n.id, ...posOf(n), ...nodeSize(n) }));
  const selectNodeById = (id: FlowNodeId) => {
    const n = view.nodes[id];
    if (!n) return;
    setMultiSel(new Set());
    if (n.kind === 'task') {
      select(n.taskId); // インスペクタは開かない(選択のみ)
      setSel(null);
    } else {
      setSel({ kind: 'node', id });
      select(undefined);
    }
    // 選択先が画面外ならスクロールで追従
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-nodeid="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  };
  const spatialSelect = (dir: NavDir): boolean => {
    const boxes = navBoxes();
    if (!boxes.length) return false;
    const curId = keyTargets()[0];
    const cur = curId ? boxes.find((b) => b.id === curId) : undefined;
    const nextId = cur ? nearestInDirection(cur, boxes, dir) : firstVisual(boxes);
    if (nextId) selectNodeById(nextId);
    return true; // 方向の先に無くてもキーは消費(画面スクロールの暴発を防ぐ)
  };

  // 'flow' コンテキストのアクション実行(キー照合・ガードは useGlobalHotkeys 済み)。
  flowActionsRef.current = (action, e) => {
    const step = e.shiftKey ? 32 : 8;
    const nudge = (dx: number, dy: number): boolean => {
      const t = keyTargets();
      if (!t.length) return false;
      moveNodesBy(t, dx, dy);
      return true;
    };
    switch (action) {
      case 'flow.left':
        return spatialSelect('left');
      case 'flow.right':
        return spatialSelect('right');
      case 'flow.up':
        return spatialSelect('up');
      case 'flow.down':
        return spatialSelect('down');
      case 'flow.moveLeft':
        return nudge(-step, 0);
      case 'flow.moveRight':
        return nudge(step, 0);
      case 'flow.moveUp':
        return nudge(0, -step);
      case 'flow.moveDown':
        return nudge(0, step);
      case 'flow.alignLeft':
      case 'flow.alignRight':
      case 'flow.alignUp':
      case 'flow.alignDown': {
        // 整列ジャンプ: その方向の隣の列(左端 x)/行(中央 y)へぴったり揃えて移動。
        // 複数選択は主ノード(先頭)を基準に全体を同じ差分で動かす。
        const targets = keyTargets();
        if (!targets.length) return false;
        const boxes = navBoxes();
        const cur = boxes.find((b) => b.id === targets[0]);
        if (!cur) return false;
        const tset = new Set(targets);
        const dir: NavDir =
          action === 'flow.alignLeft'
            ? 'left'
            : action === 'flow.alignRight'
              ? 'right'
              : action === 'flow.alignUp'
                ? 'up'
                : 'down';
        const jump = alignTarget(cur, boxes.filter((b) => !tset.has(b.id)), dir);
        if (jump) moveNodesBy(targets, jump.dx, jump.dy);
        return true; // 行き先が無くてもキーは消費(画面スクロールの暴発を防ぐ)
      }
      case 'flow.zoomIn':
        zoomBy(1.2);
        return true;
      case 'flow.zoomOut':
        zoomBy(1 / 1.2);
        return true;
      case 'flow.zoomReset':
        setScale(1);
        return true;
      case 'flow.fit':
        fitView();
        return true;
      case 'flow.rename': {
        // ノード自身にフォーカスがある場合は要素側の Enter/F2 ハンドラに委ねる。
        if ((document.activeElement as HTMLElement | null)?.closest('.node')) return false;
        const tid =
          selectedTaskId ??
          (() => {
            const t = sel?.kind === 'node' ? view.nodes[sel.id] : undefined;
            return t?.kind === 'task' ? t.taskId : undefined;
          })();
        if (!tid) return false;
        setEditingTaskId(tid);
        return true;
      }
      case 'flow.addInput':
      case 'flow.addOutput': {
        // 選択中の工程に I/O を追加(名前を尋ねてから登録。表/インスペクタにも反映)。
        const targetId = keyTargets()[0];
        const tn = targetId ? view.nodes[targetId] : undefined;
        const taskId = tn?.kind === 'task' ? tn.taskId : selectedTaskId;
        if (!taskId || !project.core.tasks[taskId]) return false;
        void addIoPrompt(taskId, action === 'flow.addInput' ? 'inputs' : 'outputs');
        return true;
      }
      case 'flow.addNext':
      case 'flow.addNextNoConnect': {
        // n: 選択中の工程の右隣へ作成 → 依存を接続 → その場リネーム開始、まで一気通貫。
        // Shift+N は接続なし。工程ノード未選択ならビューポート中央へ作成（接続なし）。
        const targetId = keyTargets()[0];
        const tn = targetId ? view.nodes[targetId] : undefined;
        const baseTaskId = tn?.kind === 'task' ? tn.taskId : undefined;
        if (baseTaskId) {
          const newId = addTaskNextTo(baseTaskId, { connect: action === 'flow.addNext' });
          if (newId) setEditingTaskId(newId); // リネーム入力の autoFocus が画面外なら追従スクロールも兼ねる
          return true;
        }
        const c = viewportCenter();
        if (!c) return false;
        const newId = addTaskAt(c.x - SIZE.task.w / 2, c.y - SIZE.task.h / 2);
        if (newId) setEditingTaskId(newId);
        return true;
      }
      case 'flow.connect': {
        const fromId = keyTargets()[0];
        return fromId ? startKbConnect(fromId) : false;
      }
      case 'flow.addParallel': {
        // 選択中の工程の並行工程を追加(前工程を写して直下へ。store が配置まで行う)。
        const targetId = keyTargets()[0];
        const tn = targetId ? view.nodes[targetId] : undefined;
        const taskId = tn?.kind === 'task' ? tn.taskId : selectedTaskId;
        if (!taskId || !project.core.tasks[taskId]) return false;
        addParallel(taskId);
        return true;
      }
      case 'flow.makeParallel': {
        // 基準工程ピッカーを開く(接続モードと同じ操作系。候補は工程ノードのみ)。
        const fromId = keyTargets()[0];
        return fromId ? startKbConnect(fromId, 'parallel') : false;
      }
      case 'flow.delete': {
        // Delete/Backspace=選択中の要素を削除（矢印/制御ノード/付箋＝図から、工程ノード＝確認のうえ工程ごと）。
        // 複数選択があればまとめて削除（フロー固有要素は即時、工程は確認あり）。
        if (multiSel.size > 0) {
          const flowSpecific: string[] = [];
          const taskIds: string[] = [];
          for (const id of multiSel) {
            const n = view.nodes[id];
            if (!n) continue;
            if (n.kind === 'control' || n.kind === 'comment') flowSpecific.push(id);
            else if (n.kind === 'task') taskIds.push(n.taskId);
          }
          if (flowSpecific.length) deleteFlowNodes(flowSpecific);
          if (taskIds.length) void confirmRemoveTasks(taskIds);
          setMultiSel(new Set());
          return true;
        }
        if (sel?.kind === 'edge') {
          deleteEdge(sel.id);
          setSel(null);
          return true;
        }
        if (sel) {
          const n = view.nodes[sel.id];
          if (n && (n.kind === 'control' || n.kind === 'comment')) {
            deleteFlowNode(sel.id);
            setSel(null);
            return true;
          }
          return false;
        }
        // フロー固有要素を選択していない場合は、選択中の工程ノードを工程ごと削除（確認あり）。
        const tid = selectedTaskId;
        if (!tid || !project.core.tasks[tid]) return false;
        void confirmRemoveTasks([tid]).then((ok) => {
          if (ok) select(undefined);
        });
        return true;
      }
      case 'flow.clear':
        // Esc=選択解除（解除するものが無ければキーを消費しない）。
        if (!sel && multiSel.size === 0) return false;
        setSel(null);
        setMultiSel(new Set());
        return true;
      default:
        return false;
    }
  };

  // ピッカー確定: connect=矢印(依存)を引く、parallel=基準工程と並行化(依存の付け替えは store)。
  const commitPick = (mode: 'connect' | 'parallel', fromId: FlowNodeId, targetId: FlowNodeId) => {
    if (mode === 'parallel') {
      const f = view.nodes[fromId];
      const t = view.nodes[targetId];
      if (f?.kind === 'task' && t?.kind === 'task') makeParallelTo(f.taskId, t.taskId);
      return;
    }
    connect(fromId, targetId);
  };

  // 'connect' コンテキストのアクション実行(キー照合・ガードは useGlobalHotkeys 済み)。
  // Tab=距離順の循環、矢印/hjkl=方向で接続先を選ぶ、Enter=確定、Esc/c=取消。
  connectActionsRef.current = (action) => {
    const cycle = (d: number) => {
      setKbConnect((c) =>
        c ? { ...c, idx: (c.idx + d + c.candidates.length) % c.candidates.length } : c,
      );
      return true;
    };
    // 方向選択: 現候補から見て押した方向の最近傍の候補へ(空間ナビと同じ感覚)。
    const pickDir = (d2: NavDir) => {
      setKbConnect((c) => {
        if (!c) return c;
        const cboxes = c.candidates.flatMap((id) => {
          const n = view.nodes[id];
          return n ? [{ id, x: n.x, y: n.y, w: nodeSize(n).w, h: nodeSize(n).h }] : [];
        });
        const cur = cboxes.find((b) => b.id === c.candidates[c.idx]);
        if (!cur) return c;
        const next = nearestInDirection(cur, cboxes, d2);
        return next ? { ...c, idx: c.candidates.indexOf(next as FlowNodeId) } : c;
      });
      return true;
    };
    switch (action) {
      case 'connect.next':
        return cycle(1);
      case 'connect.prev':
        return cycle(-1);
      case 'connect.left':
        return pickDir('left');
      case 'connect.right':
        return pickDir('right');
      case 'connect.up':
        return pickDir('up');
      case 'connect.down':
        return pickDir('down');
      case 'connect.commit': {
        if (!kbConnect) return false;
        const target = kbConnect.candidates[kbConnect.idx];
        if (target) commitPick(kbConnect.mode, kbConnect.from, target);
        setKbConnect(null);
        return true;
      }
      case 'connect.cancel':
        setKbConnect(null);
        return true;
      default:
        return false;
    }
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
    const s = nodeSize(n);
    return { cx: p.x + s.w / 2, cy: p.y + s.h / 2 };
  };
  // キーボードピッカーを任意の起点から開始（c キー・右クリック「ここから接続」・Shift+P の共通処理）。
  // mode='connect' は工程+制御ノード、'parallel'（並行化の基準選び）は工程のみが候補。
  const startKbConnect = (fromId: FlowNodeId, mode: 'connect' | 'parallel' = 'connect'): boolean => {
    const from = view.nodes[fromId];
    if (!from) return false;
    if (mode === 'parallel' ? from.kind !== 'task' : from.kind !== 'task' && from.kind !== 'control')
      return false;
    const fc = center(from);
    const cands = Object.values(view.nodes)
      .filter((n) =>
        (mode === 'parallel' ? n.kind === 'task' : n.kind === 'task' || n.kind === 'control') &&
        n.id !== from.id,
      )
      .sort((a, b) => {
        const ca = center(a);
        const cb = center(b);
        return (
          Math.hypot(ca.cx - fc.cx, ca.cy - fc.cy) - Math.hypot(cb.cx - fc.cx, cb.cy - fc.cy)
        );
      })
      .map((n) => n.id);
    if (!cands.length) return false;
    setKbConnect({ mode, from: from.id, candidates: cands, idx: 0 });
    return true;
  };
  // 同期で追加された doc ノードは div ではなく I/O 集約アイコン（SVG）として描かれるため、
  // フラッシュは ioId に引き直してアイコン側に印を付ける。
  const flashIoIds = new Set<string>();
  for (const id of flashIds) {
    const fn = view.nodes[id];
    if (fn?.kind === 'doc') flashIoIds.add(fn.ioId);
  }

  // I/O 集約アイコン（入力=左上 / 出力=右下に重ね、複数は1枚に名前を縦列挙）。
  const renderIoIcon = (
    taskPos: { x: number; y: number },
    io: 'input' | 'output',
    items: { id: string; name: string; kind: 'doc' | 'info' }[],
  ) => {
    if (!items.length) return null;
    const r = ioIconRect(taskPos, io, items.length);
    // 形＝種類（DESIGN §8・色非依存で白黒可読）: 帳票(doc)=角丸矩形＋右上ドッグイアの書類形 /
    // 情報(info)=3 角丸＋1 角を立てたタグ形。種類は同側 I/O の先頭で代表（既存仕様）。
    return (
      <g className={`io-icon io-${io}${items.some((it) => flashIoIds.has(it.id)) ? ' node-flash' : ''}`}>
        {items[0]?.kind === 'info' ? (
          <path className="io-main" d={ioInfoChipPath(r, io)} />
        ) : (
          <>
            <path className="io-main" d={ioDocBodyPath(r)} />
            <polygon className="io-fold" points={ioDocFoldPoints(r)} />
          </>
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

  const startConnect = (n: FlowNode, e: React.PointerEvent, edge: 'top' | 'right' | 'bottom' | 'left' = 'right') => {
    e.stopPropagation();
    const p = posOf(n);
    const s = nodeSize(n);
    // 開始辺の中点からプレビュー線を引く（確定後の経路は routeEdge が再計算＝従来どおり右辺起点）。
    const mid = {
      top: { x: p.x + s.w / 2, y: p.y },
      right: { x: p.x + s.w, y: p.y + s.h / 2 },
      bottom: { x: p.x + s.w / 2, y: p.y + s.h },
      left: { x: p.x, y: p.y + s.h / 2 },
    }[edge];
    setConn({ from: n.id, fx: mid.x, fy: mid.y, x: mid.x, y: mid.y });
  };

  // 接続ドラッグ中の「落とせる相手」＝工程/制御ノード（自分以外）。落下受付(onUp)と同じ条件。
  const isConnTarget = (n: FlowNode) =>
    (n.kind === 'task' || n.kind === 'control') && (!conn || n.id !== conn.from);
  // カーソル直下の落下先（プレビュー矢印を吸着させ、強調表示する対象）。
  const dropTargetId = conn
    ? (divNodes.find((n) => {
        if (!isConnTarget(n)) return false;
        const p = posOf(n);
        const s = nodeSize(n);
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
  // details の課題順で先頭に対応するノードを代表(primary)とし、それ以外は描画しない
  // （選定規則は画像出力 flowSvg と共有: issuePrimaryIds）。taskId -> 代表ノードid。
  const issuePrimary = issuePrimaryIds(divNodes, project.details);
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
        const s = nodeSize(n);
        return n.x < rx1 && n.x + s.w > rx0 && n.y < ry1 && n.y + s.h > ry0;
      })
      .map((n) => n.id);
  }
  bandSelRef.current = bandSel;
  const bandSelSet = new Set(bandSel);
  const isMultiSel = (n: FlowNode) => multiSel.has(n.id) || bandSelSet.has(n.id);

  // キーボード接続モードの現候補(ハイライトとプレビュー矢印の対象)。
  const kbCandidate = kbConnect ? (kbConnect.candidates[kbConnect.idx] ?? null) : null;
  const kbCandSet = kbConnect ? new Set(kbConnect.candidates) : null;

  // 矢印経路の障害物 = 箱もの(工程/制御/付箋)。ドラッグ中はその位置(posOf)を反映。
  const edgeObstacles = divNodes
    .filter((n) => n.kind === 'task' || n.kind === 'control' || n.kind === 'comment')
    .map((n) => ({ id: n.id, ...posOf(n), ...nodeSize(n) }));

  // エッジ経路の参照。ドラッグ中に見かけの位置で再ルートするのは
  //  (1) 端点がドラッグ対象のエッジ
  //  (2) 確定済み経路の外接矩形がドラッグ中ノードの矩形に触れるエッジ
  //     (現在位置=動かした先を避ける / 掴む前の位置=退いた後の迂回を解く)
  // だけに絞り、それ以外はメモ済みの baseRoutes を使い回す＝毎フレームの全再ルートを
  // 避けつつ、無関係なエッジがドラッグ中ノードに重なって見えるのを防ぐ。
  // (確定経路はドロップ時の store 更新で再計算される)
  const draggingIds: ReadonlySet<FlowNodeId> | null = drag
    ? groupDrag
      ? multiSel
      : new Set([drag.id])
    : null;
  const ROUTE_HIT_PAD = 16; // routeEdge が障害物の脇に取る余白(PAD*2=12)より広めに拾う
  const dragRects: { x: number; y: number; w: number; h: number }[] = [];
  if (draggingIds) {
    for (const id of draggingIds) {
      const n = view.nodes[id];
      if (!n) continue;
      const s = nodeSize(n);
      dragRects.push({ ...posOf(n), ...s }); // 見かけの現在位置
      dragRects.push({ x: n.x, y: n.y, ...s }); // 掴む前の確定位置
    }
  }
  // 確定済み経路の外接矩形(AABB)がドラッグ矩形のどれかに触れるか(安価な近似判定。
  // 多少の取りすぎは許容し、再ルート漏れを出さない側に倒す)。
  const routeHitsDrag = (route: EdgeRoute): boolean => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of route.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return dragRects.some(
      (r) =>
        maxX > r.x - ROUTE_HIT_PAD &&
        minX < r.x + r.w + ROUTE_HIT_PAD &&
        maxY > r.y - ROUTE_HIT_PAD &&
        minY < r.y + r.h + ROUTE_HIT_PAD,
    );
  };
  const routeOf = (e: FlowEdge): EdgeRoute | undefined => {
    if (draggingIds) {
      const base = baseRoutes.get(e.id);
      const needsReroute =
        draggingIds.has(e.source) ||
        draggingIds.has(e.target) ||
        (base !== undefined && routeHitsDrag(base));
      if (needsReroute) {
        const s = view.nodes[e.source];
        const t = view.nodes[e.target];
        if (!s || !t) return undefined;
        return routeEdge(
          { ...posOf(s), ...nodeSize(s) },
          { ...posOf(t), ...nodeSize(t) },
          edgeObstacles.filter((o) => o.id !== e.source && o.id !== e.target),
        );
      }
      return base;
    }
    return baseRoutes.get(e.id);
  };

  return (
    <div className="flow-wrap">
      <div className="flow-palette">
        <span>追加:</span>
        <button
          className="add-task"
          aria-label="工程を追加"
          title="工程を追加"
          onClick={() => {
            const k = nodes.filter((n) => n.kind === 'task').length;
            const c = viewportCenter();
            const id = c
              ? addTaskAt(c.x - SIZE.task.w / 2 + (k % 5) * 20, c.y - SIZE.task.h / 2 + (k % 5) * 16)
              : addTaskAt(220 + (k % 6) * 38, 70 + (k % 4) * 30);
            if (id) setEditingTaskId(id); // 追加直後にその場リネーム
          }}
        >
          <Icons.BoxPlus />
        </button>
        <button aria-label="開始" title="開始（スタジアム形）" onClick={() => { const p = spawnPos(SIZE.control.w, SIZE.control.h); addControlNode('start', p.x, p.y); }}><Icons.Play /></button>
        <button aria-label="終了" title="終了（スタジアム形）" onClick={() => { const p = spawnPos(SIZE.control.w, SIZE.control.h); addControlNode('end', p.x, p.y); }}><Icons.Stop /></button>
        <button aria-label="判断" title="判断（ひし形）" onClick={() => { const p = spawnPos(SIZE.control.w, SIZE.control.h); addControlNode('decision', p.x, p.y); }}><Icons.Diamond /></button>
        <button aria-label="合流" title="合流" onClick={() => { const p = spawnPos(SIZE.control.w, SIZE.control.h); addControlNode('merge', p.x, p.y); }}><Icons.Merge /></button>
        <button
          onClick={async () => {
            const text = await useUI.getState().promptText({
              title: '付箋を追加',
              placeholder: 'コメント',
              confirmLabel: '追加',
            });
            if (text !== null) {
              const p = spawnPos(SIZE.comment.w, SIZE.comment.h);
              addComment(text, p.x, p.y);
            }
          }}
          aria-label="付箋を追加"
          title="付箋を追加"
        >
          <Icons.StickyNote />
        </button>
        <span className="palette-sep" aria-hidden="true" />
        <button
          className="palette-act"
          onClick={async () => {
            const ok = await useUI.getState().confirm({
              title: 'フローを整列',
              message: '依存とレーンに基づいて配置を作り直します。手で整えた配置は失われます（Ctrl+Z で戻せます）。',
              confirmLabel: '整列する',
            });
            if (ok) tidyFlow();
          }}
          title="自動整列（依存で段組み・レーンで縦配置）"
          aria-label="自動整列"
        >
          <Icons.Wand />
        </button>
        <button className="palette-act" onClick={fitView} title="全体表示（画面に合わせる）" aria-label="全体表示">
          <Icons.Maximize />
        </button>
        <span className="palette-zoom">
          <button onClick={() => zoomBy(1 / 1.2)} aria-label="縮小" title="縮小">
            <Icons.Minus />
          </button>
          <button onClick={() => setScale(1)} aria-label="ズームを100%に戻す" title="100%にリセット">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoomBy(1.2)} aria-label="拡大" title="拡大">
            <Icons.Plus />
          </button>
        </span>
        {kbConnect ? (
          <span className="palette-hint connect-hint">
            {kbConnect.mode === 'parallel'
              ? '並行化: 矢印（hjkl）で基準の工程を選び Enter で確定（クリックでも可 / Esc で取消）'
              : '接続モード: 矢印（hjkl）で接続先を選び Enter で接続（Tab=順送り / Esc で取消）'}
          </span>
        ) : (
          <span className="palette-hint">○ドラッグで矢印 / c で接続モード / Shift+ドラッグで範囲選択 / Delete で削除</span>
        )}
      </div>

      <div
        className={`flow-canvas${panning ? ' panning' : ''}${conn || kbConnect ? ' connecting' : ''}`}
        ref={canvasRef}
        onPointerDown={onCanvasPointerDown}
        onDoubleClick={onCanvasDoubleClick}
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
            // 直角コネクタ。他のノードと重なると「その工程と繋がっている」ように
            // 誤読されるため、routeEdge が障害物を避ける通り道を選ぶ(baseRoutes にメモ化)。
            const route = routeOf(e);
            if (!route) return null;
            const d = route.d;
            return (
              <g key={e.id}>
                <path
                  d={d}
                  className="edge-hit"
                  style={{ pointerEvents: 'stroke' }}
                  onClick={() => setSel({ kind: 'edge', id: e.id })}
                  onDoubleClick={() => void editEdgeLabel(e.id, e.label ?? '')}
                  onContextMenu={(ev) => {
                    // 即削除はやめてメニューに（誤削除防止。削除はメニュー/Delete キーから）。
                    ev.preventDefault();
                    setSel({ kind: 'edge', id: e.id });
                    setCtxMenu({ kind: 'edge', id: e.id, x: ev.clientX, y: ev.clientY });
                  }}
                />
                <path
                  d={d}
                  className={`edge${sel?.kind === 'edge' && sel.id === e.id ? ' sel' : ''}`}
                  fill="none"
                  markerEnd="url(#arrow)"
                />
                {e.label && (
                  <text x={route.label.x} y={route.label.y - 4} className="edge-label" textAnchor="middle">
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

          {/* 空白上では「＋ 新しい工程」を予告（離すと作成＆接続される） */}
          {conn && connEnd && !dropTargetId && (
            <text x={connEnd.cx + 12} y={connEnd.cy - 10} className="conn-ghost">
              ＋ 新しい工程
            </text>
          )}

          {/* キーボード接続モード: 起点 → 現候補のプレビュー矢印 */}
          {kbConnect &&
            kbCandidate &&
            (() => {
              const s = view.nodes[kbConnect.from];
              const t = view.nodes[kbCandidate];
              if (!s || !t) return null;
              const sp = posOf(s);
              const ss = nodeSize(s);
              const tc = center(t);
              return (
                <line
                  x1={sp.x + ss.w}
                  y1={sp.y + ss.h / 2}
                  x2={tc.cx}
                  y2={tc.cy}
                  className="edge connecting on-target"
                  markerEnd="url(#arrow)"
                />
              );
            })()}

          {showIssues &&
            nodes.map((n) => {
              if (n.kind !== 'issue' || !isPrimaryIssue(n)) return null; // 集約: 代表のみ線を引く
              const target = view.nodes[n.targetNodeId];
              if (!target) return null;
              const a = center(n);
              // 終点の規則(doc は集約アイコン中心へ寄せる)は画像出力と共有: issueLineTarget。
              const b = issueLineTarget(target, nodes, project.details, posOf);
              return <line key={`il-${n.id}`} x1={a.cx} y1={a.cy} x2={b.x} y2={b.y} className="issue-line" />;
            })}

        </svg>

        {/* 選択中の矢印に小さなツールバー（ラベル編集 / 削除）を浮かべて、操作を見えるようにする。 */}
        {sel?.kind === 'edge' &&
          (() => {
            const e = view.edges[sel.id];
            if (!e) return null;
            // 経路のラベル位置に追従(描画と同じ routeOf を使い、迂回時もズレない)。
            const route = routeOf(e);
            if (!route) return null;
            return (
              <div className="edge-toolbar" style={{ left: route.label.x, top: route.label.y }}>
                <button title="分岐ラベルを編集" onClick={() => void editEdgeLabel(e.id, e.label ?? '')}>
                  ✎ ラベル
                </button>
                {/* 大またぎブリッジ（親依存の導出）は挿入不可のため出さない（store 側の判定と共有）。 */}
                {!isBridgeEdge(project, view, e) && (
                  <button
                    title="この矢印の途中に工程を挿入（A→B を A→新規→B に）"
                    onClick={() => {
                      setSel(null); // 元エッジは分割で消えるため先に選択を解く
                      const id = insertTaskOnEdge(e.id);
                      if (id) setEditingTaskId(id); // 挿入直後にその場で名前を付ける
                    }}
                  >
                    ＋ 工程を挿入
                  </button>
                )}
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
          // 工程カラー(塗り/文字色)。colored クラス + CSS 変数で当て、ダークは CSS 側で導出。
          const taskDetail = n.kind === 'task' ? project.details[n.taskId] : undefined;
          const fillC = taskDetail?.fillColor;
          const textC = taskDetail?.textColor;
          const colorCls = `${fillC ? ' colored' : ''}${textC ? ' colored-text' : ''}`;
          const colorVars: Record<string, string> = {};
          if (fillC) {
            colorVars['--task-base'] = TASK_COLORS[fillC].base;
            colorVars['--task-fill'] = TASK_COLORS[fillC].fill;
          }
          if (textC) colorVars['--task-text'] = TASK_COLORS[textC].text;
          const cls =
            n.kind === 'task'
              ? `node task${n.taskId === selectedTaskId ? ' selected' : ''}${n.pinned ? ' pinned' : ''}${selCls}${colorCls}`
              : n.kind === 'issue'
                ? `node issue${selCls}`
                : n.kind === 'comment'
                  ? `node comment${selCls}`
                  : `node control control-${n.control}${selCls}`;
          // 接続ドラッグ中: 起点=conn-source / 落下先候補=droppable / カーソル直下=drop-active。
          // キーボード接続モード(kbConnect)も同じ見た目を使う(現候補=drop-active)。
          const connCls = conn
            ? n.id === conn.from
              ? ' conn-source'
              : n.id === dropTargetId
                ? ' droppable drop-active'
                : isConnTarget(n)
                  ? ' droppable'
                  : ''
            : kbConnect
              ? n.id === kbConnect.from
                ? ' conn-source'
                : n.id === kbCandidate
                  ? ' droppable drop-active'
                  : kbCandSet?.has(n.id)
                    ? ' droppable'
                    : ''
              : '';
          const activate = () => {
            if (n.kind === 'task') {
              if (n.taskId === selectedTaskId) {
                // 選択済みノードの再クリック/再 Enter = 詳細パネルを開く(1回目は選択のみ)
                useUI.getState().setInspectorOpen(true);
              } else {
                select(n.taskId);
              }
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
          const flashCls = flashIds.has(n.id) ? ' node-flash' : '';
          return (
            <div
              key={n.id}
              data-nodeid={n.id}
              className={cls + connCls + multiCls + flashCls}
              style={
                n.kind === 'issue'
                  ? { left: p.x, top: p.y } // 課題は内容に応じて自動サイズ（CSS）
                  : { left: p.x, top: p.y, width: nodeSize(n).w, height: nodeSize(n).h, ...colorVars }
              }
              role={focusable ? 'button' : undefined}
              tabIndex={focusable ? 0 : undefined}
              aria-label={focusable ? ariaLabel : undefined}
              aria-pressed={focusable ? isSel : undefined}
              onPointerDown={(e) => {
                if (e.button !== 0 || !draggable) return; // 右クリック（メニュー）でドラッグを始めない
                downPosRef.current = { x: e.clientX, y: e.clientY };
                movedRef.current = false;
                const pt = relPoint(e);
                // 吸着候補（自分と複数選択の連れは除外）をドラッグ開始時に 1 回だけ構築。
                const dragged = multiSel.has(n.id) ? multiSel : new Set([n.id]);
                snapCtxRef.current = {
                  size: nodeSize(n),
                  candidates: divNodes
                    .filter(
                      (m) =>
                        (m.kind === 'task' || m.kind === 'control' || m.kind === 'comment') &&
                        !dragged.has(m.id),
                    )
                    .map((m) => ({ x: m.x, y: m.y, ...nodeSize(m) })),
                };
                setDrag({ id: n.id, x: n.x, y: n.y, ox: n.x, oy: n.y, offX: pt.x - n.x, offY: pt.y - n.y });
              }}
              onContextMenu={(e) => {
                if (n.kind === 'issue') return; // 課題は集約表示のみ（操作は表/インスペクタから）
                e.preventDefault();
                e.stopPropagation();
                selectNodeById(n.id); // メニューの対象を選択で明示（Delete 等のキー操作とも揃う）
                // キーボード起動(メニューキー/Shift+F10)は clientX/Y が (0,0) で届くため、
                // ノード中央をアンカーにする(画面左上角にメニューが飛ばないように)。
                let { clientX: x, clientY: y } = e;
                if (x === 0 && y === 0) {
                  const r = e.currentTarget.getBoundingClientRect();
                  x = r.left + r.width / 2;
                  y = r.top + r.height / 2;
                }
                setCtxMenu({ kind: 'node', id: n.id, x, y });
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (movedRef.current) {
                  movedRef.current = false; // ドラッグで動かした直後の click は選択しない
                  return;
                }
                if (kbConnect && kbCandSet?.has(n.id)) {
                  // ピッカー中のクリック=その候補で確定(接続/並行化とも。従来は選択に化けていた)。
                  commitPick(kbConnect.mode, kbConnect.from, n.id);
                  setKbConnect(null);
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
                // 接続モード中の Enter/Space は中央ディスパッチ(connect.commit)に委ねる
                // (ここで activate すると確定と二重に発火する)。preventDefault もしない。
                if (kbConnect && (e.key === 'Enter' || e.key === ' ')) return;
                if (n.kind === 'task' && e.key === 'F2') {
                  e.preventDefault();
                  setEditingTaskId(n.taskId);
                  return;
                }
                if (focusable && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  activate();
                }
              }}
              onDoubleClick={(e) => {
                if (n.kind === 'task') {
                  e.stopPropagation();
                  setEditingTaskId(n.taskId); // その場で名前を編集
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
              ) : n.kind === 'task' && editingTaskId === n.taskId ? (
                <input
                  className="node-edit"
                  defaultValue={project.core.tasks[n.taskId]?.name ?? ''}
                  aria-label="工程名"
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()} // 編集中はネイティブの編集メニュー(貼り付け等)に委ねる
                  onBlur={(e) => {
                    commitNodeRename(n.taskId, e.target.value);
                    setEditingTaskId(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (isImeKeyEvent(e)) return; // IME 変換確定の Enter/Esc では閉じない
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitNodeRename(n.taskId, e.currentTarget.value);
                      setEditingTaskId(null);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingTaskId(null);
                    }
                  }}
                />
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
                  <button
                    className="pin-btn parallel-btn"
                    title="並行工程を追加（前工程を引き継いで直下に作成）"
                    aria-label="並行工程を追加"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      addParallel(n.taskId);
                    }}
                  >
                    ∥
                  </button>
                </>
              )}
              {connectable &&
                (['top', 'right', 'bottom', 'left'] as const).map((edge) => (
                  <span
                    key={edge}
                    className={`handle handle-${edge}`}
                    title="ドラッグして他の工程へ矢印を引く（空白で離すと新規工程を作成）"
                    onPointerDown={(e) => startConnect(n, e, edge)}
                  />
                ))}
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
            return (
              <g key={`io-${n.id}`}>
                {renderIoIcon(p, 'input', plain)}
                {renderIoIcon(p, 'output', d?.outputs ?? [])}
                {/* 出所付きの入力帳票: 出所部署のレーンに置き、工程へ矢印を引く
                    （レーン照合・チップ矩形・「外部:」表示の規則は画像出力と共有: sourceChipLayout）。 */}
                {sourced.map((it, i) => {
                  const chip = sourceChipLayout(p, it.source ?? '', i, boxes);
                  const cx = chip.x + chip.w / 2;
                  return (
                    <g key={`src-${it.id}`} className="io-source">
                      <line
                        className="io-source-line"
                        x1={chip.line.x1}
                        y1={chip.line.y1}
                        x2={chip.line.x2}
                        y2={chip.line.y2}
                        markerEnd="url(#io-arrow)"
                      />
                      <rect className="io-source-chip" x={chip.x} y={chip.y} width={chip.w} height={chip.h} rx={6} />
                      <text className="io-source-name" x={cx} y={chip.y + 13} textAnchor="middle">
                        {it.name || '帳票'}
                      </text>
                      <text className="io-source-from" x={cx} y={chip.y + 24} textAnchor="middle">
                        {chip.label}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>

        {/* ドラッグ吸着のガイド線（揃った相手を端から端まで結ぶ）。ノードより上層に描く。 */}
        {snapGuides.map((g, i) => (
          <div
            key={`${g.axis}-${i}`}
            className={`snap-guide snap-guide-${g.axis}`}
            style={
              g.axis === 'y'
                ? { left: g.from, top: g.pos, width: g.to - g.from }
                : { left: g.pos, top: g.from, height: g.to - g.from }
            }
          />
        ))}

        {!nodes.some((n) => n.kind === 'task') && (
          <div className="flow-empty">
            <strong>ここをダブルクリックすると工程を作成できます。</strong>
            <span>表で追加した工程も自動でここに表示されます。</span>
          </div>
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

      {showMinimap && nodes.some((n) => n.kind === 'task') && (
        <FlowMinimap
          scrollerRef={canvasRef}
          scale={scale}
          nodes={divNodes.filter((n) => !(n.kind === 'issue' && !isPrimaryIssue(n)))}
          lanesBottomY={lanesBottomY}
        />
      )}

      {/* 右クリックメニュー: 分散していた操作（リネーム/接続/I/O/固定/複製/削除…）の一覧口。
          対象の種別ごとに「いまできる操作」だけを出す。 */}
      {ctxMenu &&
        (() => {
          const close = () => setCtxMenu(null);
          if (ctxMenu.kind === 'edge') {
            const e = view.edges[ctxMenu.id];
            if (!e) return null;
            return (
              <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                <ContextItem label="ラベルを編集" onClick={() => void editEdgeLabel(e.id, e.label ?? '')} />
                {/* 大またぎブリッジ（親依存の導出）は挿入不可のため出さない（store 側の判定と共有）。 */}
                {!isBridgeEdge(project, view, e) && (
                  <ContextItem
                    label="工程を挿入"
                    onClick={() => {
                      setSel(null); // 元エッジは分割で消えるため先に選択を解く
                      const id = insertTaskOnEdge(e.id);
                      if (id) setEditingTaskId(id);
                    }}
                  />
                )}
                <div className="menu-sep" role="separator" />
                <ContextItem
                  label="削除"
                  action="flow.delete"
                  danger
                  onClick={() => {
                    deleteEdge(e.id);
                    setSel(null);
                  }}
                />
              </FlowContextMenu>
            );
          }
          const n = view.nodes[ctxMenu.id];
          if (!n) return null;
          if (n.kind === 'task') {
            const taskId = n.taskId;
            return (
              <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                <ContextItem label="名前を変更" action="flow.rename" onClick={() => setEditingTaskId(taskId)} />
                <ContextItem label="ここから接続" action="flow.connect" onClick={() => startKbConnect(n.id)} />
                <ContextItem label="インプットを追加" action="flow.addInput" onClick={() => void addIoPrompt(taskId, 'inputs')} />
                <ContextItem label="アウトプットを追加" action="flow.addOutput" onClick={() => void addIoPrompt(taskId, 'outputs')} />
                <div className="menu-sep" role="separator" />
                <ContextItem
                  label={n.pinned ? '固定を解除（整列で動くようにする）' : '固定（整列で動かさない）'}
                  onClick={() => toggleNodePin(n.id)}
                />
                <ContextItem label="複製" onClick={() => duplicateTask(taskId)} />
                <ContextItem label="表で表示" onClick={() => revealTask(taskId)} />
                <div className="menu-sep" role="separator" />
                <ContextItem
                  label="工程を削除"
                  action="flow.delete"
                  danger
                  onClick={() =>
                    void confirmRemoveTasks([taskId]).then((ok) => {
                      if (ok) select(undefined); // キーボード削除（flow.delete）と同じ後始末
                    })
                  }
                />
              </FlowContextMenu>
            );
          }
          if (n.kind === 'control') {
            return (
              <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                <ContextItem label="ここから接続" action="flow.connect" onClick={() => startKbConnect(n.id)} />
                <div className="menu-sep" role="separator" />
                <ContextItem
                  label="削除"
                  action="flow.delete"
                  danger
                  onClick={() => {
                    deleteFlowNode(n.id);
                    setSel(null);
                  }}
                />
              </FlowContextMenu>
            );
          }
          if (n.kind === 'comment') {
            return (
              <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                <ContextItem label="テキストを編集" onClick={() => void editCommentText(n.id, n.text)} />
                <div className="menu-sep" role="separator" />
                <ContextItem
                  label="削除"
                  action="flow.delete"
                  danger
                  onClick={() => {
                    deleteFlowNode(n.id);
                    setSel(null);
                  }}
                />
              </FlowContextMenu>
            );
          }
          return null;
        })()}
    </div>
  );
}

// フロー用の右クリックメニュー。カーソル位置（画面座標）に fixed で出し、画面端では
// はみ出す側に反転する（実寸を測ってから表示）。Esc は useUI の一時レイヤ（closeTopLayer）
// 経由・外側クリックは pointerdown 監視で閉じる（Menu.tsx と同じ規約）。
function FlowContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      x: x + r.width > window.innerWidth - margin ? Math.max(margin, x - r.width) : x,
      y: y + r.height > window.innerHeight - margin ? Math.max(margin, y - r.height) : y,
    });
  }, [x, y]);
  // onClose は親の再レンダで毎回作り直されるため ref で受け、登録は開いている間 1 回だけにする。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    window.addEventListener('pointerdown', onDown);
    const unregister = useUI.getState().registerTransientLayer(() => closeRef.current());
    return () => {
      window.removeEventListener('pointerdown', onDown);
      unregister();
    };
  }, []);
  // キーボード起動(メニューキー/Shift+F10)でもそのまま操作できるよう、開いたら最初の
  // 項目へフォーカスし、閉じたら開く前の位置(ノード等)へ戻す。項目選択で別の入力
  // (リネーム等)へフォーカスが移った後は奪い返さない(body に落ちたときだけ戻す)。
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('.menu-item')?.focus();
    return () => {
      if (prev?.isConnected && (document.activeElement === document.body || !document.activeElement))
        prev.focus();
    };
  }, []);
  return (
    <div
      ref={ref}
      className="menu ctx-menu"
      role="menu"
      style={pos ? { left: pos.x, top: pos.y } : { left: x, top: y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => closeRef.current()}
      onKeyDown={(e) => {
        // ↑↓ で項目間を巡回(ロービングフォーカス)。フロー側のキー操作へは流さない。
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        e.stopPropagation();
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('.menu-item') ?? []);
        if (items.length === 0) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const next =
          i < 0
            ? e.key === 'ArrowDown'
              ? 0
              : items.length - 1
            : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]!.focus();
      }}
    >
      {children}
    </div>
  );
}

// メニュー 1 項目。action を渡すと現在の実効キーマップから対応キーを引いて kbd 表記を併記する
// （シングルキー OFF で効かないキーは表示もしない＝見えるものと効くものを一致させる）。
function ContextItem({
  label,
  action,
  danger,
  onClick,
}: {
  label: string;
  action?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  const binding = action ? getActiveKeymap().find((b) => b.action === action) : undefined;
  return (
    <button
      type="button"
      className={`menu-item${danger ? ' danger' : ''}`}
      role="menuitem"
      onClick={onClick}
    >
      <span className="ctx-label">{label}</span>
      {binding && (
        <span className="ctx-keys" aria-hidden="true">
          {chordKeys(binding.chord, binding.leader).map((k, i) => (
            <kbd key={i}>{k}</kbd>
          ))}
        </span>
      )}
    </button>
  );
}

// ミニマップ（右下の俯瞰図）。スクロール位置/ビューサイズの購読をこの子に閉じ込め、
// スクロールのたびに巨大なキャンバス全体（エッジ経路計算を含む）が再レンダリング
// されるのを防ぐ（親はスクロールでは再描画されない）。
function FlowMinimap({
  scrollerRef,
  scale,
  nodes,
  lanesBottomY,
}: {
  scrollerRef: RefObject<HTMLDivElement>;
  scale: number;
  nodes: FlowNode[];
  lanesBottomY: number;
}) {
  // 可視領域（スクロール量とビューサイズ。スクロール/リサイズで rAF 間引きで更新）。
  const [vp, setVp] = useState({ left: 0, top: 0, w: 0, h: 0 });
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    let raf = 0;
    const update = () => {
      raf = 0;
      setVp({ left: el.scrollLeft, top: el.scrollTop, w: el.clientWidth, h: el.clientHeight });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollerRef]);

  const MW = 170;
  const MH = 116;
  const PAD = 8;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const s = nodeSize(n);
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + s.w);
    maxY = Math.max(maxY, n.y + s.h);
  }
  if (!isFinite(minX)) return null;
  // レーン帯も含めて全体を捉える
  minX = Math.min(minX, 0);
  minY = Math.min(minY, BAND_TOP);
  maxX = Math.max(maxX, LABEL_W + 200);
  maxY = Math.max(maxY, lanesBottomY);
  const cw = Math.max(1, maxX - minX);
  const ch = Math.max(1, maxY - minY);
  const mscale = Math.min((MW - PAD * 2) / cw, (MH - PAD * 2) / ch);
  const toMM = (x: number, y: number) => ({ x: PAD + (x - minX) * mscale, y: PAD + (y - minY) * mscale });
  const vr = {
    x: PAD + (vp.left / scale - minX) * mscale,
    y: PAD + (vp.top / scale - minY) * mscale,
    w: (vp.w / scale) * mscale,
    h: (vp.h / scale) * mscale,
  };
  const panTo = (clientX: number, clientY: number, rect: DOMRect) => {
    const el = scrollerRef.current;
    if (!el) return;
    const contentX = minX + (clientX - rect.left - PAD) / mscale;
    const contentY = minY + (clientY - rect.top - PAD) / mscale;
    el.scrollLeft = contentX * scale - el.clientWidth / 2;
    el.scrollTop = contentY * scale - el.clientHeight / 2;
  };
  return (
    <div
      className="flow-minimap"
      style={{ width: MW, height: MH }}
      title="ミニマップ（クリック / ドラッグで移動）"
      onPointerDown={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        panTo(e.clientX, e.clientY, rect);
        const move = (ev: PointerEvent) => panTo(ev.clientX, ev.clientY, rect);
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    >
      <svg width={MW} height={MH}>
        {nodes.map((n) => {
          const s = nodeSize(n);
          const p = toMM(n.x, n.y);
          return (
            <rect
              key={n.id}
              x={p.x}
              y={p.y}
              width={Math.max(2, s.w * mscale)}
              height={Math.max(2, s.h * mscale)}
              rx={1}
              className={`mm-node mm-${n.kind}`}
            />
          );
        })}
        <rect className="mm-viewport" x={vr.x} y={vr.y} width={vr.w} height={vr.h} />
      </svg>
    </div>
  );
}
