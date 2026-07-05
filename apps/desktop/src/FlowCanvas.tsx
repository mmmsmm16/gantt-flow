import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useApp, findView, isBridgeEdge } from './store';
import { useUI } from './ui/useUI';
import { useFlashIds } from './ui/useFlash';
import { pushKeyContext, registerContextHandler } from './ui/useGlobalHotkeys';
import { chordKeys, getActiveKeymap, isImeKeyEvent, isInteractiveTarget } from './keymap';
import { clampScale, zoomScroll, centerScroll, loadFlowViewport, saveFlowViewport } from './flowZoom';
import { confirmRemoveTasks, revealTask, toastUndo } from './taskOps';
import { TASK_COLORS } from './theme';
import { hearingNodeClass } from './statusUi';
import { nearestInDirection, firstVisual, alignTarget, type NavDir } from './spatialNav';
import { nameLenClass, nameLenTitle, onNameInput } from './nameLimit';
import { computeSnap, type SnapGuide, type SnapRect } from './snap';
import * as Icons from './ui/icons';
import { ioInfoChipPath, ioDocBodyPath, ioDocFoldPoints } from './flowShapes';
import {
  SIZE,
  deriveBands,
  deriveMilestoneGuides,
  isMilestone,
  ioIconRect,
  IO_ICON,
  issueLineTarget,
  issuePrimaryIds,
  laneLayout,
  lanesBottom,
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
  // palette-hint の文言をキー割り当ての実効状態に連動させる（#9a）。singleKey トグルで
  // getActiveKeymap のキャッシュが無効化されるので、再計算のトリガーに購読する。
  const singleKey = useUI((s) => s.singleKey);
  const selectedTaskId = useApp((s) => s.selectedTaskId);
  const select = useApp((s) => s.select);
  // フロー内操作で選んだ選択は「自分側」＝表→フロー追従の中央寄せをしない（次の追従 effect を 1 回だけ抑止）。
  // フロー内の選択はすべて selectFromFlow 経由にし、このワンショットで origin を区別する（表/パレット等は素の追従）。
  const suppressFlowCenterRef = useRef(false);
  const selectFromFlow = (taskId?: string) => {
    // 実際に別工程へ変わるときだけ抑止フラグを立てる（同工程/解除では追従 effect が走らず
    // フラグが残留して次の外部選択を誤って抑止するのを防ぐ）。追従 effect が 1 回で消費する。
    if (taskId !== undefined && taskId !== useApp.getState().selectedTaskId) {
      suppressFlowCenterRef.current = true;
    }
    select(taskId);
  };
  const moveNode = useApp((s) => s.moveNode);
  const addTaskAt = useApp((s) => s.addTaskAt);
  const addTaskNextTo = useApp((s) => s.addTaskNextTo);
  const connect = useApp((s) => s.connect);
  const connectToNew = useApp((s) => s.connectToNew);
  const addParallel = useApp((s) => s.addParallel);
  const makeParallelTo = useApp((s) => s.makeParallelTo);
  const addControlNode = useApp((s) => s.addControlNode);
  const addMilestone = useApp((s) => s.addMilestone);
  const addComment = useApp((s) => s.addComment);
  const setEdgeLabel = useApp((s) => s.setEdgeLabel);
  const deleteEdge = useApp((s) => s.deleteEdge);
  const deleteFlowNode = useApp((s) => s.deleteFlowNode);
  const tidyFlow = useApp((s) => s.tidyFlow);
  const wouldTidyFlow = useApp((s) => s.wouldTidyFlow);
  const setLaneHeight = useApp((s) => s.setLaneHeight);
  const moveLane = useApp((s) => s.moveLane);
  const renameAssignee = useApp((s) => s.renameAssignee);
  const reconnectEdge = useApp((s) => s.reconnectEdge);
  const toggleNodePin = useApp((s) => s.toggleNodePin);
  const addIo = useApp((s) => s.addIo);
  const moveNodesBy = useApp((s) => s.moveNodesBy);
  const deleteFlowNodes = useApp((s) => s.deleteFlowNodes);
  const renameTask = useApp((s) => s.renameTask);
  const duplicateTask = useApp((s) => s.duplicateTask);
  const insertTaskOnEdge = useApp((s) => s.insertTaskOnEdge);
  const updateComment = useApp((s) => s.updateComment);
  const setCommentTarget = useApp((s) => s.setCommentTarget);
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
      title: io === 'inputs' ? '入力を追加' : '出力を追加',
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

  // フロー上の I/O 表示（集約アイコン・出所チップ）をクリック → その工程を選択し、詳細パネルの
  // 該当 I/O 項目まで寄せる（追加もそこから既存 UI で。ダブルクリックでの新規工程作成は防ぐ）。
  const openIoInInspector = (taskId: string, io: 'inputs' | 'outputs', ioId?: string) => {
    selectFromFlow(taskId); // フロー内操作＝自分側。表→フロー中央寄せは抑止
    useUI.getState().setInspectorOpen(true);
    useUI.getState().focusInspectorIo(io, ioId);
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
  const dragRef = useRef(drag);
  dragRef.current = drag;
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
  // 両窓編集同期: 発信元窓の focusHint が「フロー面での作成→即リネーム」を要求したら、その場編集を開く。
  // 作成系の返り値をローカルに得られないフォロワー窓で、リーダーから届いた新工程 id を受けて開く経路。
  // seq でトリガ（再マウント時に古い要求で開き直さないよう ref で消化済み seq を持つ）。
  const renameRequest = useUI((s) => s.renameRequest);
  const consumedRenameSeq = useRef(useUI.getState().renameRequest?.seq ?? 0);
  useEffect(() => {
    if (renameRequest && renameRequest.surface === 'flow' && renameRequest.seq > consumedRenameSeq.current) {
      consumedRenameSeq.current = renameRequest.seq;
      setEditingTaskId(renameRequest.taskId);
    }
  }, [renameRequest]);
  // 付箋の「対象工程を設定」待機中（この付箋 id を保持）。次に工程ノードをクリックで対象を確定、Esc で取消。
  const [commentLink, setCommentLink] = useState<FlowNodeId | null>(null);
  // キーボードピッカー。mode='connect'(c)は接続先、'parallel'(Shift+P)は並行化の基準工程を、
  // 起点から候補(距離順)を Tab/矢印で循環し Enter(またはクリック)で確定する。
  const [kbConnect, setKbConnect] = useState<{
    mode: 'connect' | 'parallel';
    from: FlowNodeId;
    candidates: FlowNodeId[];
    idx: number;
  } | null>(null);
  const [conn, setConn] = useState<{ from: FlowNodeId; fx: number; fy: number; x: number; y: number } | null>(null);
  // #4 マウント時に退避済みのビューポート倍率で復元（詳細開閉・表⇄フロー切替の再マウントで
  // 100% にリセットされないように）。スクロール位置は下の layout effect で戻す。
  const [scale, setScale] = useState(() => loadFlowViewport()?.scale ?? 1);
  const [panning, setPanning] = useState(false);
  // フロー固有要素（制御ノード/付箋/矢印）の選択。Delete で削除・Esc で解除。
  const [sel, setSel] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null);
  // 右クリックメニュー（ノード/矢印/複数選択）。位置はカーソルの画面座標（fixed 配置）。
  // kind='multi' は複数選択を右クリックしたとき（選択を維持したまま一括メニューを出す）。
  const [ctxMenu, setCtxMenu] = useState<{ kind: 'node' | 'edge' | 'multi'; id: string; x: number; y: number } | null>(null);
  // レーンの高さ手動リサイズ（プレビュー中の高さを保持）。
  const [laneResize, setLaneResize] = useState<{ laneId: string; height: number } | null>(null);
  // B1: ドラッグ/接続中の端オートスクロール。lastPointer=最新カーソル(client)+Alt、
  // autoReapply=スクロール後に対象位置を再評価するコールバック（ドラッグ/接続で差し替え）。
  const autoScrollRef = useRef<{ vx: number; vy: number; raf: number } | null>(null);
  const autoReapplyRef = useRef<(() => void) | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number; alt: boolean } | null>(null);
  // B3: 選択エッジの端点ドラッグ（再接続）。x/y はプレビュー終点（論理座標）。
  const [edgeDrag, setEdgeDrag] = useState<{ edgeId: string; end: 'source' | 'target'; x: number; y: number } | null>(null);
  // 未紐付けマイルストーンの菱形を横ドラッグ中のプレビュー x（モデル座標。確定は pointerup で moveNode）。
  const [msDrag, setMsDrag] = useState<{ taskId: string; x: number } | null>(null);
  // #7 ドラッグ中の Escape 中断。各ドラッグ（ノード移動 / 接続 / 端点再接続 / レーン高さ /
  // マイルストーン横移動）が開始時に「確定せず元へ戻す関数」をここへ登録し、Escape で呼ぶ。
  // null = 非ドラッグ（このとき Escape は通常どおり flow.clear などへ流す）。
  const dragCancelRef = useRef<(() => void) | null>(null);

  const stopAutoScroll = () => {
    if (autoScrollRef.current) {
      cancelAnimationFrame(autoScrollRef.current.raf);
      autoScrollRef.current = null;
    }
  };
  // ドラッグ/接続中、ポインタが容器の端 EDGE px 以内に来たら端からの距離に比例して自動スクロール。
  // スクロールのたびに autoReapply で対象（ノード/接続線/エッジ端点）を最新カーソル位置へ追従させる。
  const updateAutoScroll = (clientX: number, clientY: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const EDGE = 40;
    const MAX = 22;
    const speed = (d: number) => Math.ceil(((EDGE - Math.max(0, d)) / EDGE) * MAX);
    let vx = 0;
    let vy = 0;
    const dl = clientX - r.left;
    const dr = r.right - clientX;
    const dt = clientY - r.top;
    const db = r.bottom - clientY;
    if (dl < EDGE) vx = -speed(dl);
    else if (dr < EDGE) vx = speed(dr);
    if (dt < EDGE) vy = -speed(dt);
    else if (db < EDGE) vy = speed(db);
    if (vx === 0 && vy === 0) {
      stopAutoScroll();
      return;
    }
    if (autoScrollRef.current) {
      autoScrollRef.current.vx = vx;
      autoScrollRef.current.vy = vy;
      return;
    }
    const tick = () => {
      const cur = autoScrollRef.current;
      const sc = canvasRef.current;
      if (!cur || !sc) return;
      sc.scrollLeft += cur.vx;
      sc.scrollTop += cur.vy;
      autoReapplyRef.current?.(); // スクロール後、最新カーソル位置で対象を再評価
      cur.raf = requestAnimationFrame(tick);
    };
    autoScrollRef.current = { vx, vy, raf: requestAnimationFrame(tick) };
  };

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

  // #9a フロー下部の操作ヒント。接続モード(c)はシングルキー OFF だと無効なので、実効キーマップに
  // その割り当てが残っているときだけ「〈キー〉で接続モード」を出す（見えるものと効くものを一致）。
  const flowHint = useMemo(() => {
    const connect = getActiveKeymap().find((b) => b.action === 'flow.connect');
    const pieces = ['○ドラッグで矢印'];
    if (connect) pieces.push(`${chordKeys(connect.chord, connect.leader).join('')} で接続モード`);
    pieces.push('Shift+ドラッグで範囲選択', 'Delete で削除');
    return pieces.join(' / ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleKey]);

  // #4 ビューポートのスクロール位置を退避/復元する。倍率は上の useState 初期値で復元済み。
  // マウント時: 退避値があれば実 DOM のスクロールを戻す（layout フェーズ＝描画前に反映）。
  // アンマウント時: 現在の倍率＋スクロールを退避する（scaleRef は毎レンダ最新の scale を指す）。
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const vp = loadFlowViewport();
    if (vp) {
      el.scrollLeft = vp.left;
      el.scrollTop = vp.top;
    }
    return () => {
      saveFlowViewport({ scale: scaleRef.current, left: el.scrollLeft, top: el.scrollTop });
    };
  }, []);

  // 'flow' コンテキストのキーボードアクション(矢印移動・ズーム・リネーム・接続モード)。
  // ハンドラ本体は描画後半(fitView 等の定義後)で ref に流し込み、登録自体は初回のみ行う。
  const flowActionsRef = useRef<((action: string, e: KeyboardEvent) => boolean) | null>(null);
  useEffect(
    () =>
      registerContextHandler('flow', (action, e) => flowActionsRef.current?.(action, e) ?? false),
    [],
  );

  // #7 ドラッグ中の Escape で「確定せず中断」。capture フェーズで受けて伝播を止めることで、
  // useGlobalHotkeys の flow.clear（選択解除）や closeTopLayer より優先する（同じ押下で選択解除しない）。
  // ドラッグ中でなければ何もしない＝Escape は通常経路（flow.clear など）へそのまま流れる。
  useEffect(() => {
    const onEscCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragCancelRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      const cancel = dragCancelRef.current;
      dragCancelRef.current = null; // cancel が再入で自分を呼ばないよう先に解除
      cancel();
    };
    window.addEventListener('keydown', onEscCapture, true);
    return () => window.removeEventListener('keydown', onEscCapture, true);
  }, []);

  // 付箋の対象工程を選ぶ待機中は Escape で取消（capture で受けて選択解除などへ流さない）。
  useEffect(() => {
    if (!commentLink) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setCommentLink(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [commentLink]);

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
    if (el.closest('.node, .ms-diamond, .handle, .del, button, input, a')) return; // ノード操作などは委ねる
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
    // I/O 表示（集約アイコン・出所チップ）上のダブルクリックは編集オープンに割り当てるため除外
    // （新規工程の量産を防ぐ。onDoubleClick でも伝播を止めているが closest でも二重に弾く）。
    if (el.closest('.node, .ms-diamond, .handle, .del, button, input, a, .lane-rail, .flow-minimap, .edge-toolbar, .io-icon, .io-source')) return;
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
    // カーソル(client)座標から吸着込みのノード位置を算出して drag に反映。オートスクロールの
    // 再評価(autoReapply)からも同じ関数を使い、ポインタ静止のまま端スクロールしてもノードが追従する。
    const applyDragMove = (clientX: number, clientY: number, alt: boolean) => {
      const s = downPosRef.current;
      if (s && (Math.abs(clientX - s.x) > 4 || Math.abs(clientY - s.y) > 4)) movedRef.current = true;
      const p = relPoint({ clientX, clientY });
      // 近くのノードと上端/中央・左端/中央が揃う位置へ吸着（Alt/Option 押下中は無効）。
      let nx = p.x - drag.offX;
      let ny = p.y - drag.offY;
      let guides: SnapGuide[] = [];
      const ctx = snapCtxRef.current;
      if (ctx && !alt) {
        const snapped = computeSnap({ x: nx, y: ny, ...ctx.size }, ctx.candidates, SNAP_PX / scale);
        nx = snapped.x;
        ny = snapped.y;
        guides = snapped.guides;
      }
      // 境界クランプ: 確定側（moveNode/moveNodesBy）と同じ規則をプレビューにも適用し、
      // マウスアップ時にスナップバックしないようにする（負座標へは行かせない）。
      const ms = multiSelRef.current;
      if (ms.has(drag.id) && ms.size > 1) {
        // 剛体移動: 選択全体の最小 x/y が 0 を下回らないよう移動量(delta)そのものを削って揃える
        // （個別クランプだと選択の一部だけ壁で止まり相対配置が歪む。moveNodesBy と同じロジック）。
        let minX = Infinity;
        let minY = Infinity;
        for (const id of ms) {
          const n = view?.nodes[id];
          if (n) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
          }
        }
        if (Number.isFinite(minX)) {
          let ddx = nx - drag.ox;
          let ddy = ny - drag.oy;
          if (minX + ddx < 0) ddx = -minX;
          if (minY + ddy < 0) ddy = -minY;
          nx = drag.ox + ddx;
          ny = drag.oy + ddy;
        }
      } else {
        nx = Math.max(0, nx);
        ny = Math.max(0, ny);
      }
      setSnapGuides(guides);
      setDrag((d) => (d ? { ...d, x: nx, y: ny } : d));
    };
    autoReapplyRef.current = () => {
      const lp = lastPointerRef.current;
      if (lp) applyDragMove(lp.x, lp.y, lp.alt);
    };
    const onMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
      applyDragMove(e.clientX, e.clientY, e.altKey);
      updateAutoScroll(e.clientX, e.clientY);
    };
    const onUp = () => {
      stopAutoScroll();
      autoReapplyRef.current = null;
      lastPointerRef.current = null;
      downPosRef.current = null;
      snapCtxRef.current = null;
      setSnapGuides([]);
      const d = dragRef.current; // 最新のドラッグ位置（更新は state→ref へ反映済み）
      if (d && movedRef.current) {
        const ms = multiSelRef.current;
        if (ms.has(d.id) && ms.size > 1) {
          moveNodesBy([...ms], Math.round(d.x) - d.ox, Math.round(d.y) - d.oy); // 選択をまとめて移動
        } else {
          // 別レーンへ落ちて担当が書き戻ったら通知（フラッシュだけだと気づきにくい / 取り消し導線）。
          const changedTo = moveNode(d.id, Math.round(d.x), Math.round(d.y));
          if (changedTo) useUI.getState().toast(`担当を「${changedTo}」に変更しました（Ctrl+Z で取り消し）`, 'info');
        }
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // #7 Escape 中断: 確定（moveNode/moveNodesBy）を呼ばずにドラッグを破棄して元位置へ戻す。
    dragCancelRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stopAutoScroll();
      autoReapplyRef.current = null;
      lastPointerRef.current = null;
      downPosRef.current = null;
      movedRef.current = false;
      snapCtxRef.current = null;
      setSnapGuides([]);
      setDrag(null);
    };
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stopAutoScroll();
      autoReapplyRef.current = null;
      dragCancelRef.current = null;
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

  // 破壊的な図要素削除は「元に戻す」アクション付きトーストを添えて即時リカバリ導線を出す（C-07/#40）。
  // 矢印＝前後関係の削除にもなり得るため誤操作に気づけるよう、種別に応じたメッセージにする。
  const deleteEdgeWithUndo = (id: FlowNodeId) => {
    deleteEdge(id);
    toastUndo('矢印を削除しました');
  };
  const deleteFlowNodeWithUndo = (id: FlowNodeId) => {
    const kind = view?.nodes[id]?.kind;
    const label = kind === 'comment' ? '付箋' : kind === 'control' ? '制御ノード' : '図形';
    deleteFlowNode(id);
    toastUndo(`${label}を削除しました`);
  };
  const deleteFlowNodesWithUndo = (ids: FlowNodeId[]) => {
    if (!ids.length) return;
    deleteFlowNodes(ids);
    toastUndo(`${ids.length}件の図形を削除しました`);
  };

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
    const applyConnMove = (clientX: number, clientY: number) => {
      const p = relPoint({ clientX, clientY });
      setConn((c) => (c ? { ...c, x: p.x, y: p.y } : c));
    };
    autoReapplyRef.current = () => {
      const lp = lastPointerRef.current;
      if (lp) applyConnMove(lp.x, lp.y);
    };
    const onMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
      applyConnMove(e.clientX, e.clientY);
      updateAutoScroll(e.clientX, e.clientY);
    };
    const from = conn.from; // ドラッグ中は不変（x/y のみ更新される）
    const onUp = (e: PointerEvent) => {
      stopAutoScroll();
      autoReapplyRef.current = null;
      lastPointerRef.current = null;
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
    // #7 Escape 中断: connect / connectToNew を呼ばずに接続ドラッグを破棄（新規工程を作らない）。
    dragCancelRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stopAutoScroll();
      autoReapplyRef.current = null;
      lastPointerRef.current = null;
      setConn(null);
    };
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stopAutoScroll();
      autoReapplyRef.current = null;
      dragCancelRef.current = null;
    };
  }, [conn, view, connect, connectToNew]);

  // B3: 選択エッジの端点ドラッグ（再接続）。落下先＝工程/制御ノードなら reconnectEdge。
  useEffect(() => {
    if (!edgeDrag || !view) return;
    const apply = (clientX: number, clientY: number) => {
      const p = relPoint({ clientX, clientY });
      setEdgeDrag((d) => (d ? { ...d, x: p.x, y: p.y } : d));
    };
    autoReapplyRef.current = () => {
      const lp = lastPointerRef.current;
      if (lp) apply(lp.x, lp.y);
    };
    const onMove = (e: PointerEvent) => {
      lastPointerRef.current = { x: e.clientX, y: e.clientY, alt: e.altKey };
      apply(e.clientX, e.clientY);
      updateAutoScroll(e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      stopAutoScroll();
      autoReapplyRef.current = null;
      lastPointerRef.current = null;
      const p = relPoint(e);
      const target = Object.values(view.nodes).find((n) => {
        if (n.kind !== 'task' && n.kind !== 'control') return false;
        const s = nodeSize(n);
        return p.x >= n.x && p.x <= n.x + s.w && p.y >= n.y && p.y <= n.y + s.h;
      });
      if (target) reconnectEdge(edgeDrag.edgeId, edgeDrag.end, target.id);
      setEdgeDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // #7 Escape 中断: reconnectEdge を呼ばずに端点ドラッグを破棄（元の接続のまま）。
    dragCancelRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stopAutoScroll();
      autoReapplyRef.current = null;
      lastPointerRef.current = null;
      setEdgeDrag(null);
    };
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stopAutoScroll();
      autoReapplyRef.current = null;
      dragCancelRef.current = null;
    };
  }, [edgeDrag, view, reconnectEdge]);

  // 選択中の工程が変わったら、対応するフローノードが視界外のとき中央へ寄せる（表→フロー追従）。
  // centerScroll は完全に見えているとき null＝据え置き（フロー側で既に見えていれば動かさない）。
  // 「選択操作の反対側だけ追従」= フロー内で選んだ選択は selectFromFlow が抑止フラグを立て、この
  // 追従を 1 回スキップ（自分側は動かさない）。ドラッグ/接続はフロー内操作なので同じ経路で抑止される。
  // ズームは変えず、退避値と同じ論理座標×scale モデルで scrollLeft/Top を直接指定する（scaleRef で最新倍率）。
  useEffect(() => {
    if (!selectedTaskId || !view) return;
    if (suppressFlowCenterRef.current) {
      suppressFlowCenterRef.current = false; // ワンショット消費（残留させない）
      return;
    }
    const node = Object.values(view.nodes).find(
      (n) => n.kind === 'task' && n.taskId === selectedTaskId,
    );
    if (!node) return;
    const el = canvasRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const size = nodeSize(node);
      const to = centerScroll(
        { x: node.x, y: node.y, w: size.w, h: size.h },
        { left: el.scrollLeft, top: el.scrollTop, w: el.clientWidth, h: el.clientHeight },
        scaleRef.current,
      );
      if (to) {
        el.scrollLeft = to.left;
        el.scrollTop = to.top;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedTaskId, view]);

  if (!view) return <p className="empty">ビューがありません。</p>;

  let nodes = Object.values(view.nodes);
  if (!showIssues) nodes = nodes.filter((n) => n.kind !== 'issue');
  const lanes = Object.values(view.lanes).sort((a, b) => a.order - b.order);
  const bands = deriveBands(project.core, view);
  // マイルストーン縦線（上部余白の菱形＋レーンを貫く破線）。導出は画像出力 flowSvg と共有。
  const msGuides = deriveMilestoneGuides(project.core, view);
  // マイルストーンのタスクノードはレーン内に通常ノードとして描かない（上部余白の菱形が代わり）。
  // doc は I/O 集約アイコン（SVG）で描くため div ノードから除外。型ガードで doc を型からも外す。
  const divNodes = nodes.filter(
    (n): n is Exclude<FlowNode, { kind: 'doc' }> =>
      n.kind !== 'doc' && !(n.kind === 'task' && isMilestone(project.core, n.taskId)),
  );

  // レーン幾何（可変高さ）。確定済みの高さで描画し、リサイズ中は破線ガイドだけ動かす
  // （ドラッグ中にレーンとノードがズレて見えるのを避け、確定時にまとめて反映）。
  // 担当（assignee）由来のレーンが無いビュー（例: 大/全体は工程に担当が無い）では
  // スイムレーンを一切描かない＝「担当者名の無いレーン」を出さない。それ以外の粒度は
  // 工程（＝レーン）がまだ 0 件の空プロジェクトでも器（ラベル列・帯の枠）は常に描く
  // （hasLanes は「lanes が定義され得るビューか」で判定し、実際の件数には左右されない）。
  const boxes: LaneBox[] = laneLayout(lanes);
  const hasLanes = view.level !== 'large';
  const lanesBottomY = hasLanes ? lanesBottom(lanes, BAND_TOP) : BAND_TOP;

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
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragCancelRef.current = null;
      setLaneHeight(box.lane.id, h);
    };
    // #7 Escape 中断: setLaneHeight を呼ばずにプレビューを破棄（確定済みの高さのまま）。
    dragCancelRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragCancelRef.current = null;
      setLaneResize(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // マイルストーンの菱形を選択（クリック）／未紐付け時は横ドラッグで対象ノードの x を更新（y は不変）。
  // bound（対象工程あり）のときは縦線 x が工程に自動追従するためドラッグ無効＝クリックで選択のみ。
  const selectMs = (taskId: string) => {
    selectFromFlow(taskId);
    setSel(null);
    setMultiSel(new Set());
  };
  const startMsDrag = (g: { taskId: string; bound: boolean }, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (g.bound) return; // 追従中はドラッグしない（クリック選択は onClick 側で処理）
    const node = Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === g.taskId);
    if (!node) return;
    const startX = e.clientX;
    const baseX = node.x;
    let moved = false;
    setMsDrag({ taskId: g.taskId, x: baseX });
    const xAt = (ev: PointerEvent) => Math.max(0, baseX + (ev.clientX - startX) / scale);
    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true;
      setMsDrag({ taskId: g.taskId, x: xAt(ev) });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragCancelRef.current = null;
      const nx = xAt(ev);
      setMsDrag(null);
      // 横方向の平行移動のみ（y 不変）。moveNodesBy はレーン再割当をしない＝MS に担当が付かない。
      if (moved) moveNodesBy([node.id], Math.round(nx) - baseX, 0);
      else selectMs(g.taskId); // 動かさなければクリック＝選択
    };
    // #7 Escape 中断: moveNodesBy を呼ばずに横ドラッグを破棄（元 x のまま／選択もしない）。
    dragCancelRef.current = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      dragCancelRef.current = null;
      setMsDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // 全体表示: 全ノードの外接矩形を計算し、画面に収まる倍率と位置へスクロール（拡大は100%まで）。
  // 救出: scrollLeft/Top は 0 未満にできないため、過去のバグや外部編集で負座標に取り残された
  // ノードがあると全体表示でも二度と画面内へ戻せない。押されるたびに全ノードを一括で
  // (0,0) 以上へ平行移動してから通常の外接矩形計算に入る（相対配置は保つ／不要なら no-op）。
  const fitView = () => {
    const scroller = canvasRef.current; // .flow-canvas 自身が横スクロール容器（ヘッダ/パレットは固定）
    if (!scroller || !nodes.length) return;
    let rawMinX = Infinity;
    let rawMinY = Infinity;
    for (const n of Object.values(view.nodes)) {
      rawMinX = Math.min(rawMinX, n.x);
      rawMinY = Math.min(rawMinY, n.y);
    }
    const rescueDx = rawMinX < 0 ? -rawMinX : 0;
    const rescueDy = rawMinY < 0 ? -rawMinY : 0;
    if (rescueDx || rescueDy) moveNodesBy(Object.keys(view.nodes) as FlowNodeId[], rescueDx, rescueDy);

    let minX = 0;
    let minY = BAND_TOP;
    let maxX = LABEL_W;
    let maxY = BAND_TOP;
    for (const n of nodes) {
      const s = nodeSize(n);
      const nx = n.x + rescueDx;
      const ny = n.y + rescueDy;
      minX = Math.min(minX, nx);
      minY = Math.min(minY, ny);
      maxX = Math.max(maxX, nx + s.w);
      maxY = Math.max(maxY, ny + s.h);
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
      selectFromFlow(n.taskId); // インスペクタは開かない(選択のみ)。自分側＝表→フロー中央寄せは抑止
      setSel(null);
    } else {
      setSel({ kind: 'node', id });
      select(undefined);
    }
    // 選択先が画面外ならスクロールで追従。実 DOM フォーカスは各ノードへは移さない
    // （フローは aria-activedescendant 方式＝矢印移動でフォーカスを乗っ取らず Enter=リネーム等の
    //   フロー既定キーを保つ。選択の可視化は .selected スタイルと aria-selected で行う）。
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
    // #8 フォーカス乗っ取り防止: フォーカスが操作系（ボタン / リンク / 入力 / SELECT /
    //    メニュー項目 / タブ / contenteditable）にある間は、固定キー（Enter/Delete 等）を
    //    フローのアクションへ横取りせず素通しする（例: 設定ボタンにフォーカス中の Delete で
    //    工程削除ダイアログを開かない／Enter はそのボタンのクリックへ）。フロー内のノード div
    //    は role=button だが interactive 判定外なので従来どおり操作できる。グローバルスコープの
    //    キー（パレット / undo/redo など）は context 'global' で別経路のため影響を受けない。
    if (isInteractiveTarget(document.activeElement)) return false;
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
        if (isMilestone(project.core, taskId)) return false; // マイルストーンに I/O は付けない
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
        if (!fromId) return false;
        const fn = view.nodes[fromId];
        if (fn?.kind === 'task' && isMilestone(project.core, fn.taskId)) return false; // マイルストーンからは接続しない
        return startKbConnect(fromId);
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
          // 混在削除は図形を工程の確認導線に畳み込み 1 undo 単位にする（提示した「元に戻す」で丸ごと復元）。
          // 図形のみのときは即時削除＋単独トースト。
          if (taskIds.length) {
            void confirmRemoveTasks(taskIds, flowSpecific.length ? { alsoFlowNodes: flowSpecific } : undefined);
          } else if (flowSpecific.length) {
            deleteFlowNodesWithUndo(flowSpecific);
          }
          setMultiSel(new Set());
          return true;
        }
        if (sel?.kind === 'edge') {
          deleteEdgeWithUndo(sel.id);
          setSel(null);
          return true;
        }
        if (sel) {
          const n = view.nodes[sel.id];
          if (n && (n.kind === 'control' || n.kind === 'comment')) {
            deleteFlowNodeWithUndo(sel.id);
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
  // クリックで工程を選択し、詳細パネルの該当 I/O へ寄せる（名前クリックはその項目、地の形は先頭項目）。
  // ダブルクリックは伝播を止めて空白の新規工程作成を防ぐ（編集は詳細パネルへ）。
  const renderIoIcon = (
    taskId: string,
    taskPos: { x: number; y: number },
    io: 'input' | 'output',
    items: { id: string; name: string; kind: 'doc' | 'info' }[],
  ) => {
    if (!items.length) return null;
    const r = ioIconRect(taskPos, io, items.length);
    const ioFull = io === 'input' ? 'inputs' : 'outputs';
    // 形＝種類（DESIGN §8・色非依存で白黒可読）: 帳票(doc)=角丸矩形＋右上ドッグイアの書類形 /
    // 情報(info)=3 角丸＋1 角を立てたタグ形。種類は同側 I/O の先頭で代表（既存仕様）。
    return (
      <g
        className={`io-icon io-clickable io-${io}${items.some((it) => flashIoIds.has(it.id)) ? ' node-flash' : ''}`}
        role="button"
        aria-label={`${io === 'input' ? '入力' : '出力'}を編集`}
        onClick={(e) => {
          e.stopPropagation();
          openIoInInspector(taskId, ioFull, items[0]?.id);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation(); // 空白ダブルクリックの新規工程作成へ流さない
          openIoInInspector(taskId, ioFull, items[0]?.id);
        }}
      >
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
            onClick={(e) => {
              e.stopPropagation();
              openIoInInspector(taskId, ioFull, it.id);
            }}
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
    // 開始辺の中点からプレビュー線を引く（確定後の経路は routeEdge が相対位置から自然な辺を再選択する）。
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
  // B3: エッジ端点ドラッグ中の落下先（工程/制御ノード）。
  const edgeDropTargetId = edgeDrag
    ? (divNodes.find((n) => {
        if (n.kind !== 'task' && n.kind !== 'control') return false;
        const p = posOf(n);
        const s = nodeSize(n);
        return edgeDrag.x >= p.x && edgeDrag.x <= p.x + s.w && edgeDrag.y >= p.y && edgeDrag.y <= p.y + s.h;
      })?.id ?? null)
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

  // roving focus / aria-activedescendant: いま選択中のフォーカス可能ノード(option)の DOM id。
  // 工程ノードは selectedTaskId のノード、制御/付箋は フロー固有選択(sel)。id は fn- 接頭辞で衝突回避。
  // マイルストーン・課題ノードは option ではなく role=button/none で描くので activedescendant からは除く。
  const selectedNodeId: FlowNodeId | undefined =
    sel?.kind === 'node'
      ? view.nodes[sel.id]?.kind === 'task' || view.nodes[sel.id]?.kind === 'control' || view.nodes[sel.id]?.kind === 'comment'
        ? (sel.id as FlowNodeId)
        : undefined
      : selectedTaskId && !isMilestone(project.core, selectedTaskId)
        ? Object.values(view.nodes).find((o) => o.kind === 'task' && o.taskId === selectedTaskId)?.id
        : undefined;
  const activeDescId = selectedNodeId ? `fn-${selectedNodeId}` : undefined;

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
          className="add-milestone"
          aria-label="マイルストーンを追加"
          title="マイルストーンを追加（節目。子工程・担当・工数は持たない）"
          onClick={() => {
            const p = spawnPos(SIZE.task.w, SIZE.task.h);
            const id = addMilestone(p.x, p.y);
            if (id) setEditingTaskId(id); // 追加直後にその場リネーム（工程の＋と同じ挙動）
          }}
        >
          <Icons.MilestoneDiamond />
        </button>
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
            // 2件以上を選択中は「選択した工程だけ」を整列（他は固定＝手で整えた配置を壊さない）。
            if (multiSel.size >= 2) {
              // 差分が出ない整列は no-op（配置は既に整っている）。案内トーストだけ出して何もしない（#8）。
              if (!wouldTidyFlow([...multiSel])) {
                useUI.getState().toast('選択した工程はすでに整列されています', 'info');
                return;
              }
              tidyFlow([...multiSel]);
              return;
            }
            // 全体整列も差分が無ければ確認を出さず no-op トースト（「整列したのに変わらない」を防ぐ）。
            if (!wouldTidyFlow()) {
              useUI.getState().toast('すでに整列されています（配置は変わりません）', 'info');
              return;
            }
            const ok = await useUI.getState().confirm({
              title: 'フローを整列',
              message: '依存とレーンに基づいて配置を作り直します。手で整えた配置は失われます（Ctrl+Z で戻せます）。',
              confirmLabel: '整列する',
            });
            if (ok) tidyFlow();
          }}
          title={
            multiSel.size >= 2
              ? `選択した ${multiSel.size} 件だけを整列（他は固定）`
              : '自動整列（依存で段組み・レーンで縦配置）'
          }
          aria-label={multiSel.size >= 2 ? '選択を整列' : '自動整列'}
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
        {commentLink ? (
          <span className="palette-hint connect-hint">
            付箋の対象: 結びたい工程をクリックで選択（Esc で取消）
          </span>
        ) : kbConnect ? (
          <span className="palette-hint connect-hint">
            {kbConnect.mode === 'parallel'
              ? '並行化: 矢印（hjkl）で基準の工程を選び Enter で確定（クリックでも可 / Esc で取消）'
              : '接続モード: 矢印（hjkl）で接続先を選び Enter で接続（Tab=順送り / Esc で取消）'}
          </span>
        ) : (
          <span className="palette-hint">{flowHint}</span>
        )}
      </div>

      <div
        className={`flow-canvas${panning ? ' panning' : ''}${conn || kbConnect ? ' connecting' : ''}`}
        ref={canvasRef}
        // 独自キーボードモデル（矢印=選択移動）とボタン/ハンドル等の混在ゆえ listbox ではなく
        // application ロール。選択ノードは role=option + aria-selected で読ませ、活性ノードは
        // aria-activedescendant で指す（実フォーカスは各ノードへ移す＝roving focus）。
        role="application"
        aria-label="工程フロー図（矢印キーでノードを選択）"
        aria-activedescendant={activeDescId}
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

        {/* マイルストーン: 上部余白の琥珀の菱形＋レーンを貫く縦破線（対象工程の右端に自動追従）。
            未紐付け（!bound）のときだけ菱形を横ドラッグして位置を決められる。導出は flowSvg と共有。 */}
        {msGuides.map((g) => {
          const gx = msDrag && msDrag.taskId === g.taskId ? msDrag.x : g.x;
          const isSel = g.taskId === selectedTaskId;
          // 菱形の scrollIntoView 追従・右クリックメニューの対象に使う MS のタスクノード id。
          const msNode = Object.values(view.nodes).find((n) => n.kind === 'task' && n.taskId === g.taskId);
          const editing = editingTaskId === g.taskId;
          return (
            <div key={`ms-${g.taskId}`} className="ms-guide">
              <div className="ms-guide-line" style={{ left: gx, top: 0, height: lanesBottomY }} />
              <div
                className={`ms-diamond${isSel ? ' selected' : ''}${g.bound ? '' : ' draggable'}`}
                style={{ left: gx - 13, top: 3 }}
                data-nodeid={msNode?.id}
                role="button"
                tabIndex={0}
                aria-label={`マイルストーン: ${g.label || '（無題）'}`}
                title={g.bound ? g.label : `${g.label}（ドラッグで位置を調整）`}
                onPointerDown={(e) => startMsDrag(g, e)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (g.bound) selectMs(g.taskId); // 未紐付けは startMsDrag が選択も担う
                }}
                onKeyDown={(e) => {
                  if (e.key === 'F2') {
                    e.preventDefault();
                    setEditingTaskId(g.taskId); // 工程ノードの F2 と同じその場リネーム
                    return;
                  }
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectMs(g.taskId);
                  }
                }}
                onContextMenu={(e) => {
                  // 工程ノードの右クリックメニューを流用（対象は MS のタスクノード）。
                  if (!msNode) return;
                  e.preventDefault();
                  e.stopPropagation();
                  selectMs(g.taskId);
                  let { clientX: x, clientY: y } = e;
                  if (x === 0 && y === 0) {
                    const r = e.currentTarget.getBoundingClientRect();
                    x = r.left + r.width / 2;
                    y = r.top + r.height / 2;
                  }
                  setCtxMenu({ kind: 'node', id: msNode.id, x, y });
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setEditingTaskId(g.taskId);
                }}
              />
              {/* リネーム中はラベルの位置に工程ノードと同じ編集 input を出す（菱形はレーン外なので
                  divNodes の input には含まれない＝ここで同じ commit/cancel 規約を再現する）。 */}
              {editing ? (
                <input
                  className={`node-edit ms-edit${nameLenClass(project.core.tasks[g.taskId]?.name)}`}
                  title={nameLenTitle(project.core.tasks[g.taskId]?.name)}
                  onInput={onNameInput}
                  style={{ left: gx + 16, top: 4 }}
                  defaultValue={project.core.tasks[g.taskId]?.name ?? ''}
                  aria-label="工程名"
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.stopPropagation()} // 編集中はネイティブの編集メニュー(貼り付け等)に委ねる
                  onBlur={(e) => {
                    commitNodeRename(g.taskId, e.target.value);
                    setEditingTaskId(null);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (isImeKeyEvent(e)) return; // IME 変換確定の Enter/Esc では閉じない
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitNodeRename(g.taskId, e.currentTarget.value);
                      setEditingTaskId(null);
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingTaskId(null);
                    }
                  }}
                />
              ) : (
                <span className="ms-label" style={{ left: gx + 16, top: 4 }}>
                  {g.label}
                </span>
              )}
            </div>
          );
        })}

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
                {/* B3: 選択中の矢印の両端に掴み手。ドラッグして別の工程/制御へ付け替える。 */}
                {sel?.kind === 'edge' && sel.id === e.id && route.points.length >= 2 && (
                  <>
                    <circle
                      className="edge-endpoint"
                      cx={route.points[0]!.x}
                      cy={route.points[0]!.y}
                      r={6}
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        const a = route.points[0]!;
                        setEdgeDrag({ edgeId: e.id, end: 'source', x: a.x, y: a.y });
                      }}
                    >
                      <title>始点をドラッグして接続元を変更</title>
                    </circle>
                    <circle
                      className="edge-endpoint"
                      cx={route.points[route.points.length - 1]!.x}
                      cy={route.points[route.points.length - 1]!.y}
                      r={6}
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        const b = route.points[route.points.length - 1]!;
                        setEdgeDrag({ edgeId: e.id, end: 'target', x: b.x, y: b.y });
                      }}
                    >
                      <title>終点をドラッグして接続先を変更</title>
                    </circle>
                  </>
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

          {/* B3: エッジ端点ドラッグ中のプレビュー（固定端 → カーソル）。 */}
          {edgeDrag &&
            (() => {
              const e = view.edges[edgeDrag.edgeId];
              const route = e ? routeOf(e) : undefined;
              if (!route || route.points.length < 2) return null;
              const fixed = edgeDrag.end === 'target' ? route.points[0]! : route.points[route.points.length - 1]!;
              return (
                <line
                  x1={fixed.x}
                  y1={fixed.y}
                  x2={edgeDrag.x}
                  y2={edgeDrag.y}
                  className={`edge connecting${edgeDropTargetId ? ' on-target' : ''}`}
                  markerEnd="url(#arrow)"
                />
              );
            })()}

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

          {/* 付箋の対象工程リンク（課題の注釈線と同じ細い薄線・矢頭なし）。対象ノードが消えている
              場合は線を描かない＝ダングリング描画禁止（reconcile は付箋を触らないので防御は描画側）。 */}
          {nodes.map((n) => {
            if (n.kind !== 'comment' || !n.targetNodeId) return null;
            const target = view.nodes[n.targetNodeId];
            if (!target) return null;
            const a = center(n);
            const b = center(target);
            return <line key={`cl-${n.id}`} x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy} className="issue-line" />;
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
                    deleteEdgeWithUndo(e.id);
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
              ? `node task${n.taskId === selectedTaskId ? ' selected' : ''}${n.pinned ? ' pinned' : ''}${selCls}${colorCls}${hearingNodeClass(taskDetail)}`
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
              : edgeDrag
                ? n.id === edgeDropTargetId
                  ? ' droppable drop-active'
                  : n.kind === 'task' || n.kind === 'control'
                    ? ' droppable'
                    : ''
                : '';
          // 付箋の対象工程を選ぶ待機中は、選べる工程ノードを droppable として強調する。
          const linkCls = commentLink && n.kind === 'task' && n.id !== commentLink ? ' droppable' : '';
          const activate = () => {
            if (n.kind === 'task') {
              if (n.taskId === selectedTaskId) {
                // 選択済みノードの再クリック/再 Enter = 詳細パネルを開く(1回目は選択のみ)
                useUI.getState().setInspectorOpen(true);
              } else {
                selectFromFlow(n.taskId);
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
              id={focusable ? `fn-${n.id}` : undefined}
              data-nodeid={n.id}
              className={cls + connCls + linkCls + multiCls + flashCls}
              style={
                n.kind === 'issue'
                  ? { left: p.x, top: p.y } // 課題は内容に応じて自動サイズ（CSS）
                  : { left: p.x, top: p.y, width: nodeSize(n).w, height: nodeSize(n).h, ...colorVars }
              }
              // application 内のノードは role=option。工程ノードの選択は selectedTaskId、
              // 制御/付箋は フロー固有選択(sel=isSel) を aria-selected に反映する。
              role={focusable ? 'option' : undefined}
              tabIndex={focusable ? 0 : undefined}
              aria-label={focusable ? ariaLabel : undefined}
              aria-selected={
                focusable ? (n.kind === 'task' ? n.taskId === selectedTaskId : isSel) : undefined
              }
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
                // 複数選択中のノードを右クリックしたら選択を維持し、一括メニューを出す（#7。
                // 従来は selectNodeById が multiSel を捨てて単一選択に化けていた）。単一選択時は従来どおり。
                const inMulti = multiSelRef.current.has(n.id) && multiSelRef.current.size > 1;
                if (!inMulti) selectNodeById(n.id); // メニューの対象を選択で明示（Delete 等のキー操作とも揃う）
                // キーボード起動(メニューキー/Shift+F10)は clientX/Y が (0,0) で届くため、
                // ノード中央をアンカーにする(画面左上角にメニューが飛ばないように)。
                let { clientX: x, clientY: y } = e;
                if (x === 0 && y === 0) {
                  const r = e.currentTarget.getBoundingClientRect();
                  x = r.left + r.width / 2;
                  y = r.top + r.height / 2;
                }
                setCtxMenu({ kind: inMulti ? 'multi' : 'node', id: n.id, x, y });
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (movedRef.current) {
                  movedRef.current = false; // ドラッグで動かした直後の click は選択しない
                  return;
                }
                if (commentLink) {
                  // 付箋の対象工程を選ぶ待機中: 工程ノードのクリックで対象を確定（他種別は無視して待機継続）。
                  if (n.kind === 'task') {
                    setCommentTarget(commentLink, n.id);
                    setCommentLink(null);
                  }
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
                } else if (n.kind === 'comment') {
                  // 付箋も工程ノードと同じくダブルクリックで編集を始める（#6 統一）。
                  e.stopPropagation();
                  void editCommentText(n.id, n.text);
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
                  className={`node-edit${nameLenClass(project.core.tasks[n.taskId]?.name)}`}
                  title={nameLenTitle(project.core.tasks[n.taskId]?.name)}
                  onInput={onNameInput}
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
                    title="入力を追加（左上）"
                    aria-label="入力を追加"
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
                    title="出力を追加（右下）"
                    aria-label="出力を追加"
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
                    deleteFlowNodeWithUndo(n.id);
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
                {renderIoIcon(n.taskId, p, 'input', plain)}
                {renderIoIcon(n.taskId, p, 'output', d?.outputs ?? [])}
                {/* 出所付きの入力帳票: 出所部署のレーンに置き、工程へ矢印を引く
                    （レーン照合・チップ矩形・「外部:」表示の規則は画像出力と共有: sourceChipLayout）。
                    クリックで工程を選択し詳細パネルの該当入力へ寄せる（ダブルクリックは伝播を止める）。 */}
                {sourced.map((it, i) => {
                  const chip = sourceChipLayout(p, it.source ?? '', i, boxes);
                  const cx = chip.x + chip.w / 2;
                  return (
                    <g
                      key={`src-${it.id}`}
                      className="io-source io-clickable"
                      role="button"
                      aria-label={`入力「${it.name || '帳票'}」を編集`}
                      onClick={(e) => {
                        e.stopPropagation();
                        openIoInInspector(n.taskId, 'inputs', it.id);
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        openIoInInspector(n.taskId, 'inputs', it.id);
                      }}
                    >
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

        </div>

        {/* 案内見切れ対策: .flow-scale(論理1600x1400・パン/ズーム対象)の内側ではなく
            .flow-canvas(実際に見えているペイン)の直下に置き、可視領域の中央に固定する
            （パンやペイン幅に関わらず常に全文が収まる）。 */}
        {!nodes.some((n) => n.kind === 'task') && (
          <div className="flow-empty">
            <strong>ここをダブルクリックすると工程を作成できます。</strong>
            <span>表で追加した工程も自動でここに表示されます。</span>
          </div>
        )}

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
                {box.lane.assigneeId ? (
                  <button
                    className="lane-rename"
                    title="クリックで担当名を変更（この担当の全工程に反映）"
                    aria-label={`担当「${box.lane.title}」の名称を変更`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={async () => {
                      const name = await useUI.getState().promptText({
                        title: '担当（部署 / 個人）の名称変更',
                        defaultValue: box.lane.title,
                        placeholder: '担当名',
                        confirmLabel: '変更',
                      });
                      if (name) renameAssignee(box.lane.assigneeId!, name);
                    }}
                  >
                    {box.lane.title}
                  </button>
                ) : (
                  box.lane.title
                )}
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
          if (ctxMenu.kind === 'multi') {
            // 複数選択の一括メニュー（既存の一括アクションを呼ぶだけ）。工程/制御/付箋を仕分けて
            // 削除、工程は複製・選択整列。工程が無ければ複製は出さない。
            const ids = [...multiSel];
            const taskIds = ids.flatMap((id) => {
              const nd = view.nodes[id];
              return nd?.kind === 'task' ? [nd.taskId] : [];
            });
            const flowSpecific = ids.filter((id) => {
              const k = view.nodes[id]?.kind;
              return k === 'control' || k === 'comment';
            });
            return (
              <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                {taskIds.length > 0 && (
                  <ContextItem
                    label={`複製（${taskIds.length}件）`}
                    onClick={() => taskIds.forEach((tid) => duplicateTask(tid))}
                  />
                )}
                <ContextItem label={`選択を整列（${ids.length}件・他は固定）`} onClick={() => tidyFlow(ids)} />
                <div className="menu-sep" role="separator" />
                <ContextItem
                  label={`削除（${ids.length}件）`}
                  action="flow.delete"
                  danger
                  onClick={() => {
                    // 混在は 1 undo 単位に畳み込む（キーボード削除と同経路）。図形のみは即時削除。
                    if (taskIds.length) {
                      void confirmRemoveTasks(
                        taskIds,
                        flowSpecific.length ? { alsoFlowNodes: flowSpecific } : undefined,
                      );
                    } else if (flowSpecific.length) {
                      deleteFlowNodesWithUndo(flowSpecific);
                    }
                    setMultiSel(new Set());
                  }}
                />
              </FlowContextMenu>
            );
          }
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
                    deleteEdgeWithUndo(e.id);
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
            // マイルストーンは菱形のみで I/O・接続・固定の概念を持たない（無効ノードに紐づく浮遊アイコン等を防ぐ）。
            // メニューを 名前を変更/表で表示/複製/削除 に絞る。
            if (isMilestone(project.core, taskId)) {
              return (
                <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                  <ContextItem label="名前を変更" action="flow.rename" onClick={() => setEditingTaskId(taskId)} />
                  {/* マイルストーンは対象工程（前工程）を紐付けて初めて意味を持つ。詳細パネルを開くだけ（#10）。 */}
                  <ContextItem
                    label="対象工程を設定…"
                    onClick={() => {
                      selectFromFlow(taskId);
                      useUI.getState().setInspectorOpen(true);
                    }}
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
            return (
              <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                <ContextItem label="名前を変更" action="flow.rename" onClick={() => setEditingTaskId(taskId)} />
                <ContextItem label="ここから接続" action="flow.connect" onClick={() => startKbConnect(n.id)} />
                <ContextItem label="入力を追加" action="flow.addInput" onClick={() => void addIoPrompt(taskId, 'inputs')} />
                <ContextItem label="出力を追加" action="flow.addOutput" onClick={() => void addIoPrompt(taskId, 'outputs')} />
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
                    deleteFlowNodeWithUndo(n.id);
                    setSel(null);
                  }}
                />
              </FlowContextMenu>
            );
          }
          if (n.kind === 'comment') {
            const commentId = n.id;
            const hasTarget = !!n.targetNodeId;
            return (
              <FlowContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={close}>
                <ContextItem label="テキストを編集" onClick={() => void editCommentText(commentId, n.text)} />
                {/* 対象工程リンク: 設定は「次のクリックで工程を選ぶ」待機モードへ（Esc で取消）。 */}
                <ContextItem
                  label={hasTarget ? '対象工程を変更…' : '対象工程を設定…'}
                  onClick={() => {
                    setSel({ kind: 'node', id: commentId });
                    setCommentLink(commentId);
                  }}
                />
                {hasTarget && (
                  <ContextItem label="対象工程を解除" onClick={() => setCommentTarget(commentId, undefined)} />
                )}
                <div className="menu-sep" role="separator" />
                <ContextItem
                  label="削除"
                  action="flow.delete"
                  danger
                  onClick={() => {
                    deleteFlowNodeWithUndo(commentId);
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
