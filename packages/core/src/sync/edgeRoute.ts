// 矢印(エッジ)の直角経路を、他のノード(障害物)にできるだけ重ねずに引く。
// 工程の上を線が通ると「その工程と繋がっている」ように誤読されるため、
// 候補経路を少数生成して交差数で採点し、最良のものを選ぶ(完全な迷路探索はしない)。
//
// 経路の形は 2 種類:
//   HVH   : 出口 → 縦の通り道(midX) → 入口    (従来形。midX を賢く選ぶ)
//   HVHVH : 出口 → 横の通り道(channelY) → 入口 (HVH で避け切れないときの迂回)
// 始点=ソース右辺中央 / 終点=ターゲット左辺中央 は従来と同じ(接続ハンドルの位置)。

import type { Rect } from './autoPlace';

export type { Rect } from './autoPlace'; // 同形の既存型を再利用(index からは autoPlace 側が正)

export interface Pt {
  x: number;
  y: number;
}

export interface EdgeRoute {
  points: Pt[];
  /** SVG path の d 属性。 */
  d: string;
  /** 分岐ラベルの推奨位置(経路の中央セグメントの中点)。 */
  label: Pt;
}

const PAD = 6; // 障害物の周囲に取る余白(これ未満の接近は交差とみなす)
const STUB = 16; // ノードから出入りする最初/最後の直進量の最小値

// 水平セグメント(y 固定)が矩形(余白込み)を横切るか。端点がノードに「刺さる」のは
// 出入口なので、呼び出し側で source/target を障害物から除外しておくこと。
function hSegHits(y: number, xa: number, xb: number, o: Rect): boolean {
  if (y < o.y - PAD || y > o.y + o.h + PAD) return false;
  const lo = Math.min(xa, xb);
  const hi = Math.max(xa, xb);
  return hi > o.x - PAD && lo < o.x + o.w + PAD;
}

function vSegHits(x: number, ya: number, yb: number, o: Rect): boolean {
  if (x < o.x - PAD || x > o.x + o.w + PAD) return false;
  const lo = Math.min(ya, yb);
  const hi = Math.max(ya, yb);
  return hi > o.y - PAD && lo < o.y + o.h + PAD;
}

// 直交ポリラインの「障害物との交差数」。少ないほど良い。
function crossings(points: Pt[], obstacles: Rect[]): number {
  let n = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    for (const o of obstacles) {
      if (a.y === b.y) {
        if (a.x !== b.x && hSegHits(a.y, a.x, b.x, o)) n++;
      } else if (a.x === b.x) {
        if (vSegHits(a.x, a.y, b.y, o)) n++;
      }
    }
  }
  return n;
}

const dedupe = (vals: number[]): number[] => [...new Set(vals.map((v) => Math.round(v)))];

function toPath(points: Pt[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
}

// 中央セグメントの中点(ラベル位置)。
function labelOf(points: Pt[]): Pt {
  const i = Math.floor((points.length - 1) / 2); // 4点→セグメント1(縦) / 6点→セグメント2(横)
  const a = points[i]!;
  const b = points[i + 1]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * source 右辺中央 → target 左辺中央 の直角経路を返す。
 * obstacles には source/target 自身を含めないこと。
 */
export function routeEdge(source: Rect, target: Rect, obstacles: Rect[]): EdgeRoute {
  const x1 = source.x + source.w;
  const y1 = source.y + source.h / 2;
  const x2 = target.x;
  const y2 = target.y + target.h / 2;

  const finish = (points: Pt[]): EdgeRoute => ({ points, d: toPath(points), label: labelOf(points) });

  // 同一行かつ前向きで間に何もない最頻ケースは早期 return(直線)。
  const straight: Pt[] = [
    { x: x1, y: y1 },
    { x: x2, y: y2 },
  ];
  if (y1 === y2 && x2 > x1 && crossings(straight, obstacles) === 0) return finish(straight);

  // ---- 後ろ向き(手戻り/差し戻し): ターゲットが左にある(x2 < x1) ----
  // 前向きの通り道(行内)に重ねると前向き矢印と被って読めないので、全障害物の上 or 下に
  // 「専用レーン」を取って U 字で迂回する。終端セグメントは必ず右向き(xEntry < x2)にして、
  // 矢じりがターゲット左辺に入って見えるようにする。
  if (x2 < x1) return finish(routeBackward(source, target, obstacles, x1, y1, x2, y2));

  // ---- 形1: HVH(縦の通り道 midX を選ぶ) ----
  const hvh = (midX: number): Pt[] => [
    { x: x1, y: y1 },
    { x: midX, y: y1 },
    { x: midX, y: y2 },
    { x: x2, y: y2 },
  ];
  const defaultMid = (x1 + x2) / 2;
  // 障害物の x 端を並べ、隣り合う端の中点も通り道候補にする（＝障害物と障害物の「隙間」を通す）。
  const xEdges = [...new Set(obstacles.flatMap((o) => [o.x - PAD, o.x + o.w + PAD]))].sort((a, b) => a - b);
  const xGapMids: number[] = [];
  for (let i = 0; i < xEdges.length - 1; i++) xGapMids.push((xEdges[i]! + xEdges[i + 1]!) / 2);
  const midCandidates = dedupe([
    defaultMid,
    x1 + STUB,
    x2 - STUB,
    // 区間内の障害物の左右脇を通り道の候補にする
    ...obstacles.flatMap((o) => [o.x - PAD * 2, o.x + o.w + PAD * 2]),
    ...xGapMids,
  ]).filter((m) => m >= x1 + 4 && m <= x2 - 4); // 後ろ向きは上で早期 return 済 → ここは前向き(x2>x1)のみ
  if (midCandidates.length === 0) midCandidates.push(Math.round(defaultMid));

  let best: { points: Pt[]; score: number; tie: number } | null = null;
  for (const m of midCandidates) {
    const pts = hvh(m);
    const score = crossings(pts, obstacles);
    const tie = Math.abs(m - defaultMid); // 同点なら中央寄りを好む(見た目の安定)
    if (!best || score < best.score || (score === best.score && tie < best.tie)) {
      best = { points: pts, score, tie };
    }
  }
  if (best && best.score === 0) return finish(best.points);

  // ---- 形2: HVHVH(横の通り道 channelY で迂回) ----
  const m1 = x1 + STUB;
  const m2 = x2 - STUB;
  const ys = obstacles.flatMap((o) => [o.y - PAD * 2, o.y + o.h + PAD * 2]);
  // 障害物の y 端の隙間中点に加え、全障害物の上/下を通る確実な迂回路（必ず横移動が clear）を候補に。
  const yEdges = [...new Set(obstacles.flatMap((o) => [o.y - PAD, o.y + o.h + PAD]))].sort((a, b) => a - b);
  const yGapMids: number[] = [];
  for (let i = 0; i < yEdges.length - 1; i++) yGapMids.push((yEdges[i]! + yEdges[i + 1]!) / 2);
  const aboveAll = obstacles.length ? Math.min(...obstacles.map((o) => o.y)) - PAD * 2 - 10 : y1;
  const belowAll = obstacles.length ? Math.max(...obstacles.map((o) => o.y + o.h)) + PAD * 2 + 10 : y2;
  const channelCandidates = dedupe([y1, y2, ...ys, ...yGapMids, aboveAll, belowAll]);
  for (const cy of channelCandidates) {
    const pts: Pt[] = [
      { x: x1, y: y1 },
      { x: m1, y: y1 },
      { x: m1, y: cy },
      { x: m2, y: cy },
      { x: m2, y: y2 },
      { x: x2, y: y2 },
    ];
    const score = crossings(pts, obstacles);
    // 迂回はセグメントが増えるぶん +0.5 のハンデ(同点なら HVH を保つ)
    const tie = Math.abs(cy - (y1 + y2) / 2);
    if (!best || score + 0.5 < best.score || (score + 0.5 === best.score && tie < best.tie)) {
      best = { points: pts, score: score + 0.5, tie };
    }
  }

  return finish(best!.points);
}

/**
 * 後ろ向き(手戻り)エッジの U 字迂回経路。
 * 全障害物 ＋ ソース/ターゲットの行帯の「外側」にレーン(channelY)を取り、行内を走る前向き
 * 矢印と必ず別の高さを通す。縦の落とし/上げ(xExit/xEntry)は介在ノードを避ける x を選ぶ。
 *
 * 形(6点): ソース右辺 →右stub→ 縦↑↓ → channelY を横断 → 縦↓↑ → ターゲット左辺へ右向き進入。
 *   P0(x1,y1) P1(xExit,y1) P2(xExit,cy) P3(xEntry,cy) P4(xEntry,y2) P5(x2,y2)
 * 不変条件:
 *   - xEntry < x2 ⇒ 終端 P4→P5 は右向き ⇒ 共有マーカー(orient=auto)が右を向きターゲット左辺に入る。
 *   - xEntry はターゲット左辺より左 ⇒ 縦 P3→P4・終端がターゲット本体に被らない。
 *   - xExit >= x1 ⇒ 出口 stub がソース本体へ戻らない。
 *   - cy は行帯(両ノード本体を内包)の外 ⇒ 横断レーンが前向き線・両ノードと別の高さ。
 */
function routeBackward(
  source: Rect,
  target: Rect,
  obstacles: Rect[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Pt[] {
  // 行帯はソース/ターゲット本体を必ず内包する高さにし、レーンをその外へ出す(本体クリップ防止)。
  const BAND = Math.max(STUB, Math.max(source.h, target.h) / 2 + PAD);
  const rowLo = Math.min(y1, y2) - BAND;
  const rowHi = Math.max(y1, y2) + BAND;

  // レーン候補: 全障害物の上 / 下(障害物が無ければ行帯の外)。行帯に食い込んだら外へ押し出す。
  let aboveAll = obstacles.length ? Math.min(...obstacles.map((o) => o.y)) - PAD * 2 - 10 : rowLo - 24;
  let belowAll = obstacles.length ? Math.max(...obstacles.map((o) => o.y + o.h)) + PAD * 2 + 10 : rowHi + 24;
  if (aboveAll > rowLo) aboveAll = rowLo - 12;
  if (belowAll < rowHi) belowAll = rowHi + 12;

  // 縦の通り道 x。出口はソース右辺より右(>= x1)、入口はターゲット左辺より左(< x2)に限定。
  const inRange = (v: number) => v >= Math.min(x1, x2) - STUB * 3 && v <= Math.max(x1, x2) + STUB * 3;
  const obstacleXs = obstacles.flatMap((o) => [o.x - PAD * 2, o.x + o.w + PAD * 2]);
  // 既定値に近い順に最大 10 件へ絞る(縦が増えても計算量を抑える。既定は距離 0 で必ず残る)。
  const nearest = (cands: number[], to: number): number[] =>
    [...new Set(cands.map((v) => Math.round(v)))].sort((a, b) => Math.abs(a - to) - Math.abs(b - to)).slice(0, 10);

  const defaultExit = x1 + STUB;
  let xExitCands = nearest([defaultExit, ...obstacleXs].filter((v) => inRange(v) && v >= x1), defaultExit);
  if (xExitCands.length === 0) xExitCands = [Math.round(defaultExit)];

  // 隣接列でも終端が「長さ>0 の右向き」になるようクランプ。
  const ENTRY = Math.max(1, Math.min(STUB, Math.round((x1 - x2) / 2) - PAD));
  const defaultEntry = x2 - ENTRY;
  let xEntryCands = nearest([defaultEntry, ...obstacleXs].filter((v) => inRange(v) && v < x2), defaultEntry);
  if (xEntryCands.length === 0) xEntryCands = [Math.round(defaultEntry)];

  const midY = (y1 + y2) / 2;
  let best: { points: Pt[]; score: number; tie: number } | null = null;
  for (const cy of dedupe([aboveAll, belowAll])) {
    for (const xExit of xExitCands) {
      for (const xEntry of xEntryCands) {
        const pts: Pt[] = [
          { x: x1, y: y1 },
          { x: xExit, y: y1 },
          { x: xExit, y: cy },
          { x: xEntry, y: cy },
          { x: xEntry, y: y2 },
          { x: x2, y: y2 },
        ];
        const score = crossings(pts, obstacles);
        // 同点: 既定の通り道に近いほど良い / レーンは遠い(分離が良い)ほど僅かに優遇。
        const tie =
          Math.abs(xExit - defaultExit) + Math.abs(xEntry - defaultEntry) - Math.abs(cy - midY) * 0.001;
        if (!best || score < best.score || (score === best.score && tie < best.tie)) {
          best = { points: pts, score, tie };
        }
      }
    }
  }
  return best!.points;
}
