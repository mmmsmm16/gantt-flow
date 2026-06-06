// 付随オブジェクトの決定論的な自動配置（`docs/03-view-spec.md` §2-3 / `docs/04-sync-spec.md` autoPlace）。
// 配置ポリシーは種類で非対称:
//  - 帳票/情報(I/O): 工程の角に「重ねて」添える（入力=左上 / 出力=右下、重なりOK）
//  - 課題/コメント: 他オブジェクトと「重ならない」空きスペースへ寄せる（ベストエフォート衝突回避）
import type { FlowNode } from '../model/types';

export interface Pos {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// レンダラと合わせる想定の概寸（配置計算用。実描画サイズと厳密一致でなくてよい）。
export const SIZE = {
  task: { w: 150, h: 44 },
  doc: { w: 54, h: 36 },
  issue: { w: 72, h: 34 },
  control: { w: 44, h: 30 },
  comment: { w: 100, h: 44 },
} as const;

const GAP = 20;
const STEP = 16;
const DOC_STACK = SIZE.doc.w + 8; // 複数 I/O を角から外側へずらす量

export function nodeRect(n: FlowNode): Rect {
  const s =
    n.kind === 'task'
      ? SIZE.task
      : n.kind === 'doc'
        ? SIZE.doc
        : n.kind === 'issue'
          ? SIZE.issue
          : n.kind === 'comment'
            ? SIZE.comment
            : SIZE.control;
  return { x: n.x, y: n.y, w: s.w, h: s.h };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// 入力帳票: 工程の「左上」角に重ねる。複数は左へ積む。
export function placeInputDoc(task: Pos, index: number): Pos {
  return { x: task.x - 24 - index * DOC_STACK, y: task.y - 16 };
}

// 出力帳票: 工程の「右下」角に重ねる。複数は右へ積む。
export function placeOutputDoc(task: Pos, index: number): Pos {
  return { x: task.x + SIZE.task.w - 30 + index * DOC_STACK, y: task.y + SIZE.task.h - 20 };
}

// 課題/コメント: 工程の右から走査し、既存ノードと重ならない最初の空きへ（決定論）。
export function placeClear(task: Pos, existing: FlowNode[], size = SIZE.issue): Pos {
  const baseX = task.x + SIZE.task.w + GAP;
  const rects = existing.map(nodeRect);
  for (let col = 0; col < 6; col++) {
    for (let row = 0; row < 24; row++) {
      const cand: Rect = {
        x: baseX + col * (size.w + GAP),
        y: task.y + row * STEP,
        w: size.w,
        h: size.h,
      };
      if (!rects.some((r) => overlaps(cand, r))) return { x: cand.x, y: cand.y };
    }
  }
  return { x: baseX, y: task.y }; // フォールバック（ほぼ起きない）
}
