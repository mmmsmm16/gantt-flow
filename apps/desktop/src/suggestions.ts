// 入力補完（オートコンプリート）の候補集め。プロジェクト全体から重複なく集約する。
// 同じ帳票が複数工程に登場するのが業務フローの常なので、表記ゆれ（受注伝票 vs 受注表）を防ぐ。
import type { Project, ProcessTask, Id } from '@gantt-flow/core';
import { isMilestone } from '@gantt-flow/core';

// すべての I/O（帳票/情報）の名称を、出現頻度の高い順に重複なく返す。
export function collectIoNames(project: Project): string[] {
  const count = new Map<string, number>();
  for (const d of Object.values(project.details)) {
    for (const it of [...(d.inputs ?? []), ...(d.outputs ?? [])]) {
      const n = it.name.trim();
      if (n) count.set(n, (count.get(n) ?? 0) + 1);
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
}

// 「前工程」に設定できる候補。同じ粒度の工程（別の親グループも可）のうち、既に前後関係
// (どちら向きでも)が張られているものを除外して order 順に返す(表セレクトとパレットの引数
// コマンドで共用)。粒度跨ぎは従来どおり除外＝大工程の接続から導出されるブリッジに委ねる。
// マイルストーン(kind==='milestone')は「工程→MS」の一方向しか依存を張れない
// （commands/index.ts の isMilestone ガードで MS からの出依存は無視される）ため、
// MS を"他工程の前工程"候補には出さない。MS 自身の前工程セレクトは対象外＝呼び出し側
// (taskId が MS)であれば通常工程を候補として返してよく、これは候補側(o)のみを絞る
// ここのフィルタでは影響を受けない。
export function prevCandidates(project: Project, taskId: Id): ProcessTask[] {
  const t = project.core.tasks[taskId];
  if (!t) return [];
  const deps = Object.values(project.core.dependencies);
  const predIds = new Set(deps.filter((d) => d.to === taskId).map((d) => d.from));
  const succIds = new Set(deps.filter((d) => d.from === taskId).map((d) => d.to));
  return Object.values(project.core.tasks)
    .filter(
      (o) =>
        o.id !== taskId &&
        o.level === t.level &&
        !isMilestone(project.core, o.id) &&
        !predIds.has(o.id) &&
        !succIds.has(o.id),
    )
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// 前工程候補を親グループ別に分ける（同粒度の別グループも候補に入るようになったため、
// セレクトで「どのグループの工程か」を optgroup で見分けられるようにする用途）。
// 親が初めて現れた順を保ち、各グループ内は渡された候補順（order→id）を維持する。
export function groupPrevCandidates(
  candidates: ProcessTask[],
): { parentId: Id | undefined; tasks: ProcessTask[] }[] {
  const order: (Id | undefined)[] = [];
  const map = new Map<Id | undefined, ProcessTask[]>();
  for (const o of candidates) {
    const k = o.parentId ?? undefined;
    const arr = map.get(k);
    if (arr) arr.push(o);
    else {
      map.set(k, [o]);
      order.push(k);
    }
  }
  return order.map((parentId) => ({ parentId, tasks: map.get(parentId)! }));
}

// 「＋前工程」セレクトの候補を行別に引けるルックアップを 1 回の走査で作る。
// prevCandidates と同じ結果(順序含む)を返すが、行ごとに全工程・全依存をなめ直さない
// (全行分で O(n²) になり、選択移動のたびの再レンダーが重くなる)。意味の単一ソースは
// あくまで prevCandidates — 候補規則を変えるときは両方ではなく prevCandidates を直し、
// ここはその等価な前計算に保つ(同一性はテストで固定)。表(アウトライン/全項目)で共用。
export function buildPrevCandidateIndex(project: Project): (taskId: Id) => ProcessTask[] {
  // 依存は両向きで登録し、「o↔taskId のどちら向きでも繋がり済みなら除外」を 1 回の参照で判定する。
  const linked = new Set<string>();
  for (const d of Object.values(project.core.dependencies)) {
    linked.add(`${d.from}\u0000${d.to}`);
    linked.add(`${d.to}\u0000${d.from}`);
  }
  // 同じ粒度のグループ（親は問わない）に分け、prevCandidates と同じ順(order→id)に整列しておく。
  // マイルストーンは prevCandidates 同様「他工程の前工程」候補にはしない＝候補側の母集団
  // であるグループ構築時点で除外する（MS 自身が taskId としてこのグループを引く場合は
  // 通常工程だけが返る＝MS の前工程セレクトは従来どおり機能する）。
  const groups = new Map<string, ProcessTask[]>();
  const groupKey = (t: ProcessTask) => `${t.level}`;
  for (const t of Object.values(project.core.tasks)) {
    if (isMilestone(project.core, t.id)) continue;
    const key = groupKey(t);
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }
  for (const arr of groups.values())
    arr.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  // 同じプロジェクト状態への問い合わせは再レンダーのたびに行ごとへ繰り返されるため、
  // 結果を id 別にメモ化する(インデックス自体はコミット時に作り直す前提)。
  const cache = new Map<Id, ProcessTask[]>();
  return (taskId) => {
    const hit = cache.get(taskId);
    if (hit) return hit;
    const t = project.core.tasks[taskId];
    if (!t) return [];
    const out = (groups.get(groupKey(t)) ?? []).filter(
      (o) => o.id !== taskId && !linked.has(`${o.id}\u0000${taskId}`),
    );
    cache.set(taskId, out);
    return out;
  };
}
