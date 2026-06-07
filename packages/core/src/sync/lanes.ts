// スイムレーンの幾何（可変高さ）を一元化する。reconcile・tidy・両レンダラ（画面/SVG出力）が共有し、
// レーン高さの扱いを 1 箇所に集約する。Swimlane.height は任意（未指定＝既定）で後方互換。
import type { Swimlane, Id } from '../model/types';

export const LANE_DEFAULT_H = 120; // 既定のレーン高さ
export const LANE_MIN_H = 72; // 手動リサイズの下限
export const LANE_BASE_Y = 40; // 先頭レーンの工程ノード基準 y（= reconcile の MARGIN_Y）
export const LANE_TOP_Y = 24; // 視覚上のレーン上端（= 画面/SVG の BAND_TOP）

export const laneHeight = (lane: { height?: number }): number =>
  Math.max(LANE_MIN_H, lane.height ?? LANE_DEFAULT_H);

const sortLanes = (lanes: Swimlane[]): Swimlane[] =>
  [...lanes].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

const asArray = (lanes: Record<Id, Swimlane> | Swimlane[]): Swimlane[] =>
  Array.isArray(lanes) ? lanes : Object.values(lanes);

export interface LaneBox {
  lane: Swimlane;
  top: number; // 視覚上端
  height: number;
  base: number; // 工程ノード基準 y（top + インセット）
}

// order 昇順の各レーンの視覚上端/高さ/ノード基準 y を返す（累積）。
export function laneLayout(lanes: Record<Id, Swimlane> | Swimlane[], topBase = LANE_TOP_Y): LaneBox[] {
  const inset = LANE_BASE_Y - LANE_TOP_Y;
  let acc = topBase;
  const out: LaneBox[] = [];
  for (const lane of sortLanes(asArray(lanes))) {
    const height = laneHeight(lane);
    out.push({ lane, top: acc, height, base: acc + inset });
    acc += height;
  }
  return out;
}

// 全レーンの視覚上の下端（最低 1 レーン分は確保）。
export function lanesBottom(lanes: Record<Id, Swimlane> | Swimlane[], topBase = LANE_TOP_Y): number {
  const boxes = laneLayout(lanes, topBase);
  return boxes.length ? boxes[boxes.length - 1]!.top + boxes[boxes.length - 1]!.height : topBase + LANE_DEFAULT_H;
}

// 指定 order の手前までの高さ合計（累積上端のオフセット）。
export function cumHeightBeforeOrder(lanes: Record<Id, Swimlane> | Swimlane[], order: number): number {
  let acc = 0;
  for (const lane of sortLanes(asArray(lanes))) {
    if (lane.order >= order) break;
    acc += laneHeight(lane);
  }
  return acc;
}

// 指定 order の工程ノード基準 y（reconcile/tidy が新規・移動ノードに使う）。
export function laneTaskBaseY(lanes: Record<Id, Swimlane> | Swimlane[], order: number): number {
  return LANE_BASE_Y + cumHeightBeforeOrder(lanes, order);
}

// ドロップした y に最も近いレーン order（moveNode/addTaskAt 用）。基準 y で最近傍を選ぶ。
export function nearestLaneOrder(lanes: Record<Id, Swimlane> | Swimlane[], y: number): number {
  const boxes = laneLayout(lanes);
  if (!boxes.length) return 0;
  let best = boxes[0]!.lane.order;
  let bestD = Infinity;
  for (const b of boxes) {
    const d = Math.abs(b.base - y);
    if (d < bestD) {
      bestD = d;
      best = b.lane.order;
    }
  }
  return best;
}
