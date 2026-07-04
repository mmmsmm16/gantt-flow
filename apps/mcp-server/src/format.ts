// Project を AI 向けの読みやすいテキストへ整形する。編集ツールを続けて呼べるよう、各要素の
// ID（taskId / depId / ioId / issueId）も併記する。集計は @gantt-flow/core の純関数に委ねる。
import {
  computeCodes,
  computeEffortRollups,
  computeCompare,
  formatMinutes,
  AUTOMATION_LABEL,
  type Project,
  type ProcessTask,
  type ProcessLevel,
  type TaskStatus,
  type Difficulty,
  type Id,
  type IoItem,
  type FlowLevelView,
  type FlowNode,
} from '@gantt-flow/core';

const LEVEL_LABEL: Record<ProcessLevel, string> = {
  large: '大',
  medium: '中',
  small: '小',
  detail: '詳細',
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '未着手',
  heard: 'ヒアリング済',
  review: '確認待ち',
  done: '確定',
};

const DIFFICULTY_LABEL: Record<Difficulty, string> = { H: '高(ベテラン依存)', M: '中', L: '低(誰でも)' };

function assigneeName(project: Project, id?: Id): string {
  if (!id) return '担当未設定';
  return project.core.assignees[id]?.name ?? `不明(${id})`;
}

/** 子を order 昇順で返す。 */
function childrenOf(project: Project, parentId: Id | undefined): ProcessTask[] {
  return Object.values(project.core.tasks)
    .filter((t) => (t.parentId ?? undefined) === (parentId ?? undefined))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** 工程ツリー（コード・名称・粒度・担当・集計工数・状態）を字下げで一覧化。 */
export function formatTaskTree(project: Project): string {
  const codes = computeCodes(project.core);
  const rollups = computeEffortRollups(project.core, project.details);
  const lines: string[] = [];
  const walk = (parentId: Id | undefined, depth: number): void => {
    for (const t of childrenOf(project, parentId)) {
      const d = project.details[t.id];
      const indent = '  '.repeat(depth);
      const code = codes[t.id] ?? '?';
      const eff = formatMinutes(rollups.get(t.id) ?? 0);
      const status = d?.status ? ` ・${STATUS_LABEL[d.status]}` : '';
      lines.push(
        `${indent}${code} ${t.name || '(無題)'} [${LEVEL_LABEL[t.level]}] ` +
          `<${assigneeName(project, t.assigneeId)}> ⏱${eff}${status}  {id:${t.id}}`,
      );
      walk(t.id, depth + 1);
    }
  };
  walk(undefined, 0);
  const count = Object.keys(project.core.tasks).length;
  return lines.length ? `工程数: ${count}\n${lines.join('\n')}` : '工程はまだありません。';
}

function formatIo(items: IoItem[] | undefined, label: string): string[] {
  if (!items || items.length === 0) return [];
  return [
    `  ${label}:`,
    ...items.map((io) => {
      const meta = [io.kind === 'doc' ? '帳票' : '情報', io.formInfo, io.source && `出所:${io.source}`]
        .filter(Boolean)
        .join(' / ');
      return `    - ${io.name}（${meta}） {ioId:${io.id}}`;
    }),
  ];
}

/** 1 工程の全項目（As-Is / To-Be / 入出力 / 課題 / 前後関係）を詳細表示。 */
export function formatTaskDetail(project: Project, taskId: Id): string {
  const t = project.core.tasks[taskId];
  if (!t) return `工程が見つかりません: ${taskId}`;
  const codes = computeCodes(project.core);
  const d = project.details[taskId];
  const out: string[] = [];
  out.push(`■ ${codes[taskId] ?? '?'} ${t.name || '(無題)'} [${LEVEL_LABEL[t.level]}] {id:${taskId}}`);
  out.push(`  担当: ${assigneeName(project, t.assigneeId)}${t.code ? ` / 工程No手動: ${t.code}` : ''}`);

  // As-Is
  const asis: string[] = [];
  if (d?.how) asis.push(`手順: ${d.how}`);
  if (d?.system) asis.push(`システム: ${d.system}`);
  if (d?.effortMinutes !== undefined) asis.push(`工数: ${d.effortMinutes}分`);
  if (d?.ltDays !== undefined) asis.push(`LT: ${d.ltDays}日`);
  if (d?.difficulty) asis.push(`難易度: ${DIFFICULTY_LABEL[d.difficulty]}`);
  if (d?.automation) asis.push(`自動化: ${AUTOMATION_LABEL[d.automation]}`);
  if (d?.status) asis.push(`状態: ${STATUS_LABEL[d.status]}`);
  if (d?.volume) asis.push(`量: ${d.volume}`);
  if (d?.exception) asis.push(`例外: ${d.exception}`);
  if (d?.note) asis.push(`備考: ${d.note}`);
  if (d?.dataLink) asis.push(`データ: ${d.dataLink}`);
  if (d?.regulation) asis.push(`規程: ${d.regulation}`);
  out.push(asis.length ? `  As-Is: ${asis.join(' / ')}` : '  As-Is: (未入力)');

  out.push(...formatIo(d?.inputs, '入力'));
  out.push(...formatIo(d?.outputs, '出力'));

  if (d?.issues?.length) {
    out.push('  課題:');
    for (const iss of d.issues) {
      out.push(`    - ${iss.issue}${iss.measure ? ` → 方策: ${iss.measure}` : ''} {issueId:${iss.id}}`);
    }
  }

  // To-Be 差分
  if (d?.toBe) {
    const tb = d.toBe;
    const parts: string[] = [];
    if (tb.lifecycle) parts.push(tb.lifecycle === 'added' ? '新設' : '廃止');
    if (tb.effortMinutes !== undefined) parts.push(`工数: ${tb.effortMinutes}分`);
    if (tb.ltDays !== undefined) parts.push(`LT: ${tb.ltDays}日`);
    if (tb.difficulty) parts.push(`難易度: ${DIFFICULTY_LABEL[tb.difficulty]}`);
    if (tb.automation) parts.push(`自動化: ${AUTOMATION_LABEL[tb.automation]}`);
    if (tb.assigneeId) parts.push(`担当: ${assigneeName(project, tb.assigneeId)}`);
    if (tb.rationale) parts.push(`根拠: ${tb.rationale}`);
    out.push(`  To-Be: ${parts.join(' / ') || '(差分なし)'}`);
  }

  // 前後関係
  const codeOf = (id: Id) => `${codes[id] ?? '?'} ${project.core.tasks[id]?.name ?? id}`;
  const preds = Object.values(project.core.dependencies).filter((dep) => dep.to === taskId);
  const succs = Object.values(project.core.dependencies).filter((dep) => dep.from === taskId);
  if (preds.length)
    out.push(`  前工程: ${preds.map((dep) => `${codeOf(dep.from)}{depId:${dep.id}}`).join(', ')}`);
  if (succs.length)
    out.push(`  後工程: ${succs.map((dep) => `${codeOf(dep.to)}{depId:${dep.id}}`).join(', ')}`);

  return out.join('\n');
}

/** 依存（流れ）の一覧。 */
export function formatDependencies(project: Project): string {
  const codes = computeCodes(project.core);
  const deps = Object.values(project.core.dependencies);
  if (!deps.length) return '依存（工程の流れ）はまだありません。';
  const label = (id: Id) => `${codes[id] ?? '?'} ${project.core.tasks[id]?.name ?? id}`;
  const lines = deps.map((d) => {
    const phase = d.phase ? ` (${d.phase === 'asis' ? 'As-Is専用' : 'To-Be専用'})` : '';
    return `${label(d.from)} → ${label(d.to)}${phase}  {depId:${d.id}}`;
  });
  return `依存数: ${deps.length}\n${lines.join('\n')}`;
}

/** 担当（人/部署）の一覧。 */
export function formatAssignees(project: Project): string {
  const list = Object.values(project.core.assignees);
  if (!list.length) return '担当はまだ登録されていません。';
  return list
    .map((a) => `- ${a.name}（${a.kind === 'person' ? '人' : '部署'}） {assigneeId:${a.id}}`)
    .join('\n');
}

/** 工数の集計（末端＋上位ロールアップ）。 */
export function formatMetrics(project: Project): string {
  const codes = computeCodes(project.core);
  const rollups = computeEffortRollups(project.core, project.details);
  const roots = childrenOf(project, undefined);
  const total = roots.reduce((s, t) => s + (rollups.get(t.id) ?? 0), 0);
  const lines = roots.map(
    (t) => `${codes[t.id] ?? '?'} ${t.name || '(無題)'}: ${formatMinutes(rollups.get(t.id) ?? 0)}`,
  );
  return `総工数: ${formatMinutes(total)}\n${lines.join('\n')}`;
}

/** As-Is / To-Be 比較（工数・LT・待ち・難易度分布）。コンサル提言の主軸。 */
export function formatCompare(project: Project): string {
  const c = computeCompare(project.core, project.details);
  const pair = (label: string, p: { asis: number; tobe: number; delta: number }, unit: string) =>
    `${label}: As-Is ${round(p.asis)}${unit} → To-Be ${round(p.tobe)}${unit}（${p.delta <= 0 ? '' : '+'}${round(p.delta)}${unit}）`;
  const lines = [
    pair('総工数', { asis: c.effortMinutes.asis, tobe: c.effortMinutes.tobe, delta: c.effortMinutes.delta }, '分'),
    pair('リードタイム', c.ltDays, '日'),
    pair('実作業(日換算)', c.workDays, '日'),
    pair('待ち時間', c.waitDays, '日'),
    `末端工程数: As-Is ${c.leafCount.asis} → To-Be ${c.leafCount.tobe}`,
    `難易度(件数) As-Is H${c.difficulty.count.asis.H}/M${c.difficulty.count.asis.M}/L${c.difficulty.count.asis.L}` +
      ` → To-Be H${c.difficulty.count.tobe.H}/M${c.difficulty.count.tobe.M}/L${c.difficulty.count.tobe.L}`,
  ];
  return lines.join('\n');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---- フロー図（Mermaid） ----

function mmSanitize(s: string): string {
  return (s || '').replace(/"/g, "'").replace(/[\r\n]+/g, ' ').trim();
}
function laneOf(n: FlowNode): Id | undefined {
  return (n as { laneId?: Id }).laneId;
}

function pickFlowView(
  project: Project,
  level: ProcessLevel,
  scopeParentId?: Id,
): FlowLevelView | undefined {
  return project.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );
}

/** 利用可能なフロービュー（粒度・スコープ・ノード数）の一覧文字列。 */
export function flowViewLevels(project: Project): string {
  const list = project.flow.byLevel.map(
    (v) =>
      `${LEVEL_LABEL[v.level]}${v.scopeParentId ? `(scope:${v.scopeParentId})` : ''}:ノード${Object.keys(v.nodes).length}`,
  );
  return list.length ? list.join(' / ') : '(フロービューなし)';
}

/**
 * 指定粒度のフロービューを Mermaid flowchart 文字列に変換する。レーン(担当)は subgraph で近似。
 * 工程=四角 / 開始終了=スタジアム / 判断=ひし形 / 合流=丸 / 帳票情報=平行四辺形。課題ノートは除外。
 */
export function formatFlowMermaid(
  project: Project,
  level: ProcessLevel = 'medium',
  scopeParentId?: Id,
): string {
  const view = pickFlowView(project, level, scopeParentId);
  if (!view) {
    return `指定粒度のフロービューがありません（${LEVEL_LABEL[level]}）。利用可能: ${flowViewLevels(project)}`;
  }
  const codes = computeCodes(project.core);
  const nodes = Object.values(view.nodes).filter((n) => n.kind !== 'issue'); // 課題ノートは注釈なので除外
  if (nodes.length === 0) {
    return `このビュー（${LEVEL_LABEL[level]}）に表示するノードがありません。list_tasks で工程を確認してください。`;
  }

  const idMap = new Map<string, string>();
  nodes.forEach((n, i) => idMap.set(n.id, `n${i}`));
  const drawn = new Set(nodes.map((n) => n.id));

  const labelOf = (n: FlowNode): string => {
    if (n.kind === 'task') {
      const t = project.core.tasks[n.taskId];
      return mmSanitize(`${codes[n.taskId] ?? ''} ${t?.name ?? '(無題)'}`) || '(無題)';
    }
    if (n.kind === 'control') {
      const def = { start: '開始', end: '終了', decision: '判断', merge: '合流' }[n.control];
      return mmSanitize(n.label || def);
    }
    if (n.kind === 'doc') {
      const ios = [...(project.details[n.taskId]?.inputs ?? []), ...(project.details[n.taskId]?.outputs ?? [])];
      return mmSanitize(ios.find((x) => x.id === n.ioId)?.name ?? '帳票');
    }
    if (n.kind === 'comment') return mmSanitize(n.text || 'コメント');
    return ' ';
  };
  const shapeOf = (n: FlowNode): string => {
    const id = idMap.get(n.id)!;
    const l = labelOf(n) || ' ';
    if (n.kind === 'doc') return `${id}[/"${l}"/]`;
    if (n.kind === 'comment') return `${id}>"${l}"]`;
    if (n.kind === 'control') {
      if (n.control === 'decision') return `${id}{"${l}"}`;
      if (n.control === 'merge') return `${id}(("${l}"))`;
      return `${id}(["${l}"])`; // start / end
    }
    return `${id}["${l}"]`; // task
  };

  const orient = view.orientation === 'vertical' ? 'TB' : 'LR';
  const out: string[] = [`flowchart ${orient}`];

  const lanes = Object.values(view.lanes).sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  if (lanes.length) {
    for (const lane of lanes) {
      out.push(`  subgraph lane_${lane.order}["${mmSanitize(lane.title || '（レーン）')}"]`);
      for (const n of nodes) if (laneOf(n) === lane.id) out.push(`    ${shapeOf(n)}`);
      out.push('  end');
    }
    for (const n of nodes) if (laneOf(n) === undefined) out.push(`  ${shapeOf(n)}`); // レーン未割当
  } else {
    for (const n of nodes) out.push(`  ${shapeOf(n)}`);
  }

  for (const e of Object.values(view.edges)) {
    if (!drawn.has(e.source) || !drawn.has(e.target)) continue;
    const s = idMap.get(e.source);
    const t = idMap.get(e.target);
    if (!s || !t) continue;
    const arrow = e.role === 'ioLink' ? '-.->' : '-->';
    const lbl = e.label ? `|"${mmSanitize(e.label)}"|` : '';
    out.push(`  ${s} ${arrow}${lbl} ${t}`);
  }
  return out.join('\n');
}

// ---- 手順書 / 資料台帳 ----

/** 手順書 1 件を整形（目的・各ステップの action/why/bodyMd・条件分岐・参照・画像）。未作成なら固定文言。 */
export function formatProcedure(project: Project, taskId: Id): string {
  const doc = project.manual.procedures[taskId];
  if (!doc) return '手順書は未作成です。';

  const codes = computeCodes(project.core);
  const t = project.core.tasks[taskId];
  const codeOf = (id: Id): string => `${codes[id] ?? '?'} ${project.core.tasks[id]?.name ?? id}`;
  const ioNameOf = (tid: Id, ioId: Id): string => {
    const d = project.details[tid];
    const item = [...(d?.inputs ?? []), ...(d?.outputs ?? [])].find((io) => io.id === ioId);
    return item?.name ?? ioId;
  };
  const assetNameOf = (assetId: Id): string => project.manual.assets[assetId]?.name ?? assetId;

  const out: string[] = [];
  out.push(`■ 手順書: ${codes[taskId] ?? '?'} ${t?.name || '(無題)'} {id:${taskId}}`);
  out.push(doc.purpose ? `目的: ${doc.purpose}` : '目的: (未設定)');
  out.push(`改訂: ${doc.updatedAt}`);

  if (!doc.steps.length) {
    out.push('', 'ステップはまだありません。');
    return out.join('\n');
  }

  doc.steps.forEach((s, i) => {
    out.push('', `${i + 1}. ${s.action} {stepId:${s.id}}`);
    if (s.why) out.push(`   なぜ: ${s.why}`);
    if (s.bodyMd) out.push(`   本文: ${s.bodyMd}`);
    if (s.conds.length) {
      out.push('   条件:');
      for (const c of s.conds) {
        const dest = c.targetTaskId ? ` → 飛び先: ${codeOf(c.targetTaskId)}` : '';
        out.push(`     - もし「${c.when}」なら「${c.thenMd}」${dest} {condId:${c.id}}`);
      }
    }
    if (s.refs.length) {
      out.push('   参照:');
      for (const r of s.refs) {
        if (r.kind === 'asset') out.push(`     - 資料: ${assetNameOf(r.assetId)} {assetId:${r.assetId}}`);
        else if (r.kind === 'io') out.push(`     - 帳票: ${ioNameOf(r.taskId, r.ioId)} {ioId:${r.ioId}}`);
        else out.push(`     - 工程: ${codeOf(r.taskId)} {taskId:${r.taskId}}`);
      }
    }
    if (s.images.length) {
      out.push('   画像:');
      for (const img of s.images) {
        out.push(`     - ${img.file}${img.caption ? `（${img.caption}）` : ''} {imageId:${img.id}}`);
      }
    }
  });

  return out.join('\n');
}

/** プロジェクト全体のサマリ（メタ・件数・整合性・As-Is/To-Be ヘッドライン）。 */
export function formatSummary(project: Project, path: string): string {
  const counts = {
    tasks: Object.keys(project.core.tasks).length,
    deps: Object.keys(project.core.dependencies).length,
    assignees: Object.keys(project.core.assignees).length,
  };
  const issues = project.quarantine?.length ?? 0;
  return [
    `タイトル: ${project.meta.title}`,
    `ファイル: ${path}`,
    `更新: ${project.meta.updatedAt}`,
    `工程 ${counts.tasks} / 依存 ${counts.deps} / 担当 ${counts.assignees}`,
    issues ? `退避された壊れた参照: ${issues}` : '',
    '— As-Is / To-Be —',
    formatCompare(project),
  ]
    .filter(Boolean)
    .join('\n');
}
