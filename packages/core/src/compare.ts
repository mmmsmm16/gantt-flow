// As-Is / To-Be 比較の集計（提言#1/#2/#8）。工数＝タッチタイム（総和）と
// リードタイム＝経過時間（依存グラフのクリティカルパス）の2軸で改善効果を見る。
// すべて純関数。To-Be は TaskDetail.toBe を優先し、未設定は As-Is へフォールバック。
import type { Core, TaskDetail, Difficulty, Id } from './model/types';

export type Phase = 'asis' | 'tobe';

/** 1 営業日 = 8h。工数[分] と リードタイム[日] の換算に使う。 */
export const HOURS_PER_DAY = 8;

const minutesToDays = (min: number): number => min / 60 / HOURS_PER_DAY;

/** 末端工程の実効工数（分）。To-Be は toBe.effortMinutes 優先・無ければ As-Is。 */
export function leafEffortMinutes(d: TaskDetail | undefined, phase: Phase): number {
  if (!d) return 0;
  if (phase === 'tobe') return d.toBe?.effortMinutes ?? d.effortMinutes ?? 0;
  return d.effortMinutes ?? 0;
}

/** 末端工程の実効リードタイム（日）。To-Be は toBe.ltDays 優先・無ければ As-Is の ltDays。 */
export function leafLtDays(d: TaskDetail | undefined, phase: Phase): number {
  if (!d) return 0;
  if (phase === 'tobe') return d.toBe?.ltDays ?? d.ltDays ?? 0;
  return d.ltDays ?? 0;
}

/** 末端工程の実効難易度。To-Be は toBe.difficulty 優先・無ければ As-Is。未設定は undefined。 */
export function leafDifficulty(d: TaskDetail | undefined, phase: Phase): Difficulty | undefined {
  if (!d) return undefined;
  if (phase === 'tobe') return d.toBe?.difficulty ?? d.difficulty;
  return d.difficulty;
}

/** 子を持たない工程（末端）の ID。工数・難易度は末端のみが値を持つ。 */
function leafIds(core: Core): Id[] {
  const hasChild = new Set<Id>();
  for (const t of Object.values(core.tasks)) if (t.parentId) hasChild.add(t.parentId);
  return Object.values(core.tasks)
    .filter((t) => !hasChild.has(t.id))
    .map((t) => t.id);
}

/** 総工数（分）＝末端工程の工数の総和（リソース視点）。 */
export function totalEffortMinutes(
  core: Core,
  details: Record<Id, TaskDetail>,
  phase: Phase,
): number {
  return leafIds(core).reduce((s, id) => s + leafEffortMinutes(details[id], phase), 0);
}

/**
 * リードタイム（日）＝依存グラフのクリティカルパス（最長重み付き経路）。
 * 各工程の重み＝実効 ltDays。並行（依存で繋がらない）工程は加算されない＝並行化で LT が短くなる。
 * tidy.ts の longest-path 緩和と同型（重みが 1 → ltDays になっただけ）。循環があっても反復上限で停止。
 */
export function criticalPathDays(
  core: Core,
  details: Record<Id, TaskDetail>,
  phase: Phase,
): number {
  const ids = Object.keys(core.tasks);
  const weight = new Map<Id, number>();
  for (const id of ids) weight.set(id, leafLtDays(details[id], phase));
  const deps = Object.values(core.dependencies);
  // finish[id] = 自分の重み + 先行の最大 finish。先行なしは自分の重みだけ。
  const finish = new Map<Id, number>(ids.map((id) => [id, weight.get(id) ?? 0]));
  for (let iter = 0; iter < ids.length; iter++) {
    let changed = false;
    for (const d of deps) {
      const cand = (finish.get(d.from) ?? 0) + (weight.get(d.to) ?? 0);
      if (cand > (finish.get(d.to) ?? 0)) {
        finish.set(d.to, cand);
        changed = true;
      }
    }
    if (!changed) break;
  }
  let max = 0;
  for (const id of ids) max = Math.max(max, finish.get(id) ?? 0);
  return max;
}

/** 待ち時間（日）＝リードタイム − 工数（日換算）。停滞・承認待ち等の「攻めるムダ」。 */
export function totalWaitDays(
  core: Core,
  details: Record<Id, TaskDetail>,
  phase: Phase,
): number {
  return criticalPathDays(core, details, phase) - minutesToDays(totalEffortMinutes(core, details, phase));
}

export interface DiffDist {
  H: number;
  M: number;
  L: number;
}

/** 業務難易度（H/M/L）の構成。mode='count'＝工程数 / 'effort'＝工数（分）。未設定の難易度は数えない。 */
export function diffByDifficulty(
  core: Core,
  details: Record<Id, TaskDetail>,
  phase: Phase,
  mode: 'count' | 'effort',
): DiffDist {
  const out: DiffDist = { H: 0, M: 0, L: 0 };
  for (const id of leafIds(core)) {
    const diff = leafDifficulty(details[id], phase);
    if (!diff) continue;
    out[diff] += mode === 'count' ? 1 : leafEffortMinutes(details[id], phase);
  }
  return out;
}

export interface ComparePair {
  asis: number;
  tobe: number;
  delta: number; // tobe - asis（減少が改善のときは負）
}
const pair = (asis: number, tobe: number): ComparePair => ({ asis, tobe, delta: tobe - asis });

export interface CompareTotals {
  effortMinutes: ComparePair; // 総工数（分）
  ltDays: ComparePair; // リードタイム（日・クリティカルパス）
  workDays: ComparePair; // 工数の日換算（待ちバーの実作業部分）
  waitDays: ComparePair; // 待ち時間（日）
  difficulty: {
    count: { asis: DiffDist; tobe: DiffDist };
    effort: { asis: DiffDist; tobe: DiffDist };
  };
  leafCount: number;
}

/** サマリ（画面1）が必要とする全集計を 1 度にまとめて返す。 */
export function computeCompare(core: Core, details: Record<Id, TaskDetail>): CompareTotals {
  const effAsis = totalEffortMinutes(core, details, 'asis');
  const effTobe = totalEffortMinutes(core, details, 'tobe');
  const ltAsis = criticalPathDays(core, details, 'asis');
  const ltTobe = criticalPathDays(core, details, 'tobe');
  return {
    effortMinutes: pair(effAsis, effTobe),
    ltDays: pair(ltAsis, ltTobe),
    workDays: pair(minutesToDays(effAsis), minutesToDays(effTobe)),
    waitDays: pair(ltAsis - minutesToDays(effAsis), ltTobe - minutesToDays(effTobe)),
    difficulty: {
      count: { asis: diffByDifficulty(core, details, 'asis', 'count'), tobe: diffByDifficulty(core, details, 'tobe', 'count') },
      effort: { asis: diffByDifficulty(core, details, 'asis', 'effort'), tobe: diffByDifficulty(core, details, 'tobe', 'effort') },
    },
    leafCount: leafIds(core).length,
  };
}
