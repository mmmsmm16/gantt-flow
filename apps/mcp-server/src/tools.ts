// MCP ツール定義。@gantt-flow/core のコマンドを薄く包み、Workspace.current().apply() で
// 「コマンド→reconcile→保存」を 1 単位で適用する（write-through）。読み取り系は現在の Project を
// 整形して返す。core コマンドは存在しない ID を黙って no-op にするため、ここでは事前に存在確認して
// 分かりやすいエラーを返す（AI が次の手を選べるように）。
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  addTask,
  renameTask,
  setTaskLevel,
  setTaskCode,
  setAssignee,
  addAssignee,
  addDependency,
  removeDependency,
  setDependencyPhase,
  addParallelTask,
  makeParallel,
  deleteTask,
  deleteTaskKeepChildren,
  reorderTask,
  reparentTask,
  updateTaskDetail,
  updateTaskToBe,
  copyAsIsToToBe,
  addIoItem,
  removeIoItem,
  updateIoItem,
  addIssueItem,
  removeIssueItem,
  updateIssueItem,
  importCsv,
  projectToCsv,
  isProjectIntegrityError,
  uuid,
  upsertProcedure,
  addStep,
  removeStep,
  upsertAsset,
  type Project,
  type TaskDetailPatch,
  type TaskDetailToBe,
  type IssueTarget,
  type Id,
  type AssetLocator,
} from '@gantt-flow/core';
import { readFile } from 'node:fs/promises';
import type { Workspace } from './session.js';
import {
  formatTaskTree,
  formatTaskDetail,
  formatDependencies,
  formatAssignees,
  formatMetrics,
  formatCompare,
  formatSummary,
  formatFlowMermaid,
  formatProcedure,
} from './format.js';
import {
  formatFlowLayout,
  setNodePosition,
  nudgeNode,
  pinNode,
  setOrientation,
  setLaneHeight,
  autoLayout,
} from './geometry.js';
import { runBatch, type BatchOp } from './batch.js';
import { formatAudit } from './audit.js';
import { formatCriticalPath, formatAutomationCandidates, formatWorkload } from './analysis.js';

// ---- 共通 ----

const Level = z.enum(['large', 'medium', 'small', 'detail']);
const Automation = z.enum(['manual', 'system', 'partial']);
const Difficulty = z.enum(['H', 'M', 'L']);
const Status = z.enum(['todo', 'heard', 'review', 'done']);
const Color = z.enum(['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'gray']);
const IoKind = z.enum(['doc', 'info']);
const Phase = z.enum(['asis', 'tobe']);
const AssigneeKind = z.enum(['person', 'department']);
const OrientationEnum = z.enum(['horizontal', 'vertical']);

// apply_batch の op スキーマ（議事録等からの一括構築）。task/parent/from/to は「この一括で作る工程の
// ref(エイリアス)」か「既存 taskId」。assignee は名前指定可（無ければ部署として自動作成）。
const DetailPatchShape = z.object({
  how: z.string().optional(),
  system: z.string().optional(),
  effortMinutes: z.number().nonnegative().optional(),
  ltDays: z.number().nonnegative().optional(),
  note: z.string().optional(),
  volume: z.string().optional(),
  exception: z.string().optional(),
  automation: Automation.optional(),
  dataLink: z.string().optional(),
  regulation: z.string().optional(),
  difficulty: Difficulty.optional(),
  status: Status.optional(),
});
const TobePatchShape = z.object({
  effortMinutes: z.number().nonnegative().optional(),
  ltDays: z.number().nonnegative().optional(),
  difficulty: Difficulty.optional(),
  automation: Automation.optional(),
  rationale: z.string().optional(),
  lifecycle: z.enum(['added', 'removed']).optional(),
  assigneeId: z.string().optional(),
});
const BatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_task'), ref: z.string().optional(), name: z.string(), level: Level, parent: z.string().optional(), assignee: z.string().optional(), assigneeId: z.string().optional(), kind: z.enum(['milestone']).optional().describe('節目マーカー。子・出依存・工数を持たない') }),
  z.object({ op: z.literal('upsert_task'), ref: z.string().optional(), name: z.string(), level: Level.optional(), parent: z.string().optional(), assignee: z.string().optional(), assigneeId: z.string().optional(), kind: z.enum(['milestone']).optional().describe('節目マーカー。子・出依存・工数を持たない。新規作成時のみ適用、既存工程の kind は変更しない') }),
  z.object({ op: z.literal('add_dependency'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('set_detail'), task: z.string(), patch: DetailPatchShape }),
  z.object({ op: z.literal('set_tobe'), task: z.string(), patch: TobePatchShape }),
  z.object({ op: z.literal('add_io'), task: z.string(), io: z.enum(['inputs', 'outputs']), name: z.string(), kind: IoKind, formInfo: z.string().optional(), source: z.string().optional() }),
  z.object({ op: z.literal('add_issue'), task: z.string(), issue: z.string(), measure: z.string().optional() }),
  z.object({ op: z.literal('set_procedure'), task: z.string(), purpose: z.string().optional() }),
  z.object({ op: z.literal('add_step'), task: z.string(), action: z.string(), why: z.string().optional(), bodyMd: z.string().optional() }),
  z.object({
    op: z.literal('upsert_asset'),
    ref: z.string().optional(),
    id: z.string().optional(),
    name: z.string(),
    desc: z.string().optional(),
    alias: z.string().optional(),
    relPath: z.string().optional(),
    url: z.string().optional(),
  }),
]);

function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] };
}
function fail(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }], isError: true };
}
function errorText(e: unknown): string {
  if (isProjectIntegrityError(e)) {
    return `参照整合性エラー:\n${e.issues.map((i) => `- [${i.kind}] ${i.ref}: ${i.message}`).join('\n')}`;
  }
  return `エラー: ${e instanceof Error ? e.message : String(e)}`;
}
async function run(fn: () => Promise<string> | string): Promise<CallToolResult> {
  try {
    return text(await fn());
  } catch (e) {
    return fail(errorText(e));
  }
}
function requireTask(p: Project, id: Id): void {
  if (!p.core.tasks[id]) throw new Error(`工程が見つかりません: ${id}`);
}
function requireDep(p: Project, id: Id): void {
  if (!p.core.dependencies[id]) throw new Error(`依存が見つかりません: ${id}`);
}

export function registerTools(server: McpServer, ws: Workspace): void {
  // ============ ファイル / ライフサイクル ============

  server.registerTool(
    'open_project',
    {
      title: 'プロジェクトを開く',
      description: '.gflow / .json のプロジェクトファイルを開いて現在のセッションにする。',
      inputSchema: { path: z.string().describe('プロジェクトファイルの絶対パス') },
    },
    ({ path }) =>
      run(async () => {
        const s = await ws.open(path);
        return `開きました。\n${formatSummary(s.project, s.path)}`;
      }),
  );

  server.registerTool(
    'new_project',
    {
      title: '新規プロジェクト',
      description: '空（または見本データ）のプロジェクトを作成し、指定パスに保存して開く。',
      inputSchema: {
        path: z.string().describe('保存先の絶対パス（.gflow 推奨）'),
        title: z.string().optional().describe('プロジェクト名'),
        sample: z.boolean().optional().describe('true で見本の業務データを投入'),
      },
    },
    ({ path, title, sample }) =>
      run(async () => {
        const s = await ws.create(path, { title, sample });
        return `作成しました。\n${formatSummary(s.project, s.path)}`;
      }),
  );

  server.registerTool(
    'save_project_as',
    {
      title: '別名保存',
      description: '現在のプロジェクトを別パスへ保存し、以後の保存先をそのパスへ切り替える。',
      inputSchema: { path: z.string().describe('保存先の絶対パス') },
    },
    ({ path }) =>
      run(async () => {
        const s = await ws.saveAs(path);
        return `保存しました: ${s.path}`;
      }),
  );

  server.registerTool(
    'import_csv',
    {
      title: 'CSV 取り込み',
      description:
        '工程表 CSV（projectToCsv と同じ列）を読み込んで新規プロジェクトを作り、savePath に保存して開く。csvPath か text のどちらかを指定。',
      inputSchema: {
        savePath: z.string().describe('生成した .gflow の保存先（絶対パス）'),
        csvPath: z.string().optional().describe('読み込む CSV ファイルの絶対パス'),
        text: z.string().optional().describe('CSV 本文（csvPath の代わりに直接渡す）'),
      },
    },
    ({ savePath, csvPath, text: csvText }) =>
      run(async () => {
        const body = csvText ?? (csvPath ? await readFile(csvPath, 'utf8') : undefined);
        if (body === undefined) throw new Error('csvPath か text のいずれかを指定してください。');
        const { project, report } = importCsv(body, uuid);
        const s = await ws.adopt(savePath, project);
        return `取り込みました（工程 ${report.created.tasks} / 依存 ${report.created.dependencies} / 警告 ${report.warnings.length}）。\n${formatSummary(s.project, s.path)}`;
      }),
  );

  // ============ 一括構築（議事録等からの生成・形式知化） ============

  server.registerTool(
    'apply_batch',
    {
      title: '一括構築',
      description:
        '工程/依存/担当/詳細/入出力/課題/手順書/資料台帳をまとめて1回で原子的に構築する。議事録など非構造テキストから抽出した業務を一気にドラフト化する用途。各 op の ref(エイリアス)を後続 op の parent/from/to/task から参照でき、未確定の工程同士も同一バッチ内で繋げられる。dryRun=true で保存せずプレビュー。',
      inputSchema: {
        operations: z.array(BatchOpSchema).describe('順に適用する操作列。add_task に ref を付けて後続の参照に使う'),
        dryRun: z.boolean().optional().describe('true で保存せず結果プレビューのみ'),
      },
    },
    ({ operations, dryRun }) =>
      run(async () => {
        const s = ws.current();
        const result = runBatch(s.project, operations as unknown as BatchOp[]);
        const c = result.created;
        const head = `工程${c.tasks} 依存${c.dependencies} 担当${c.assignees} 入出力${c.ios} 課題${c.issues}`;
        const warn = result.warnings.length ? `\n警告:\n- ${result.warnings.join('\n- ')}` : '';
        if (dryRun) {
          return `【プレビュー（未保存）】作成予定: ${head}${warn}\n\n${formatTaskTree(result.project)}`;
        }
        await s.apply(() => result.project);
        return `一括適用しました（${head}）。${warn}\n\n${formatTaskTree(s.project)}`;
      }),
  );

  server.registerTool(
    'upsert_task',
    {
      title: '工程を冪等に作成/更新',
      description:
        '同じ親に同名の工程があれば更新、無ければ作成（冪等）。議事録の追記や再実行に安全。詳細(工数・手順・難易度など)も同時に設定できる。' +
        '既存工程を更新する場合、level/assignee は上書きするが kind は変更しない（新規作成時のみ適用）。',
      inputSchema: {
        name: z.string(),
        level: Level.optional().describe('新規作成時の粒度（省略で medium）'),
        parentId: z.string().optional(),
        assignee: z.string().optional().describe('担当名（無ければ部署として自動作成）'),
        assigneeId: z.string().optional(),
        kind: z
          .enum(['milestone'])
          .optional()
          .describe('節目マーカー。子・出依存・工数を持たない。新規作成時のみ適用、既存工程の kind は変更しない'),
        detail: DetailPatchShape.optional().describe('工数(分)/手順(how)/難易度 等の As-Is 詳細'),
      },
    },
    ({ name, level, parentId, assignee, assigneeId, kind, detail }) =>
      run(async () => {
        const s = ws.current();
        const ops: BatchOp[] = [
          { op: 'upsert_task', ref: '_t', name, level, parent: parentId, assignee, assigneeId, kind },
        ];
        if (detail && Object.keys(detail).length) ops.push({ op: 'set_detail', task: '_t', patch: detail });
        const result = runBatch(s.project, ops);
        await s.apply(() => result.project);
        const id = result.aliases['_t']!;
        return `upsert 完了。\n${formatTaskDetail(s.project, id)}`;
      }),
  );

  // ============ 読み取り ============

  server.registerTool(
    'get_summary',
    {
      title: 'サマリ',
      description: 'メタ情報・件数・As-Is/To-Be ヘッドラインを返す。',
      inputSchema: {},
    },
    () => run(() => formatSummary(ws.current().project, ws.current().path)),
  );

  server.registerTool(
    'list_tasks',
    { title: '工程ツリー', description: '工程をツリー表示（コード・粒度・担当・集計工数・状態・ID）。', inputSchema: {} },
    () => run(() => formatTaskTree(ws.current().project)),
  );

  server.registerTool(
    'get_task',
    {
      title: '工程の詳細',
      description: '1 工程の全項目（As-Is/To-Be・入出力・課題・前後関係）を返す。',
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) =>
      run(() => {
        requireTask(ws.current().project, taskId);
        return formatTaskDetail(ws.current().project, taskId);
      }),
  );

  server.registerTool(
    'list_dependencies',
    { title: '依存一覧', description: '工程の流れ（依存）を一覧表示。', inputSchema: {} },
    () => run(() => formatDependencies(ws.current().project)),
  );

  server.registerTool(
    'get_flow_mermaid',
    {
      title: '業務フロー図（Mermaid）',
      description:
        '現在の業務フローを Mermaid flowchart で返す（担当レーン=subgraph）。チャット上に図として表示して、今の流れを見ながら編集を進められる。level 省略時は medium。',
      inputSchema: {
        level: Level.optional().describe('粒度（large/medium/small/detail）。省略で medium'),
        scopeParentId: z.string().optional().describe('小/詳細など特定スコープのビューを見る場合の親工程ID'),
      },
    },
    ({ level, scopeParentId }) =>
      run(() => {
        const lv = level ?? 'medium';
        const mmd = formatFlowMermaid(ws.current().project, lv, scopeParentId);
        return `業務フロー（粒度: ${lv}）\n\n\`\`\`mermaid\n${mmd}\n\`\`\``;
      }),
  );

  // ============ フロー図のデザイン微修正（幾何） ============
  // 矢印の経路はノード位置から自動算出されるため、ノードを動かせば矢印も追従する。
  // level 省略時は medium。scopeParentId は小/詳細の特定スコープのビューを指す場合のみ。

  server.registerTool(
    'list_flow_layout',
    {
      title: 'レイアウト確認',
      description: '現在のフローの各ノード座標・レーン・pin・向きを返す（位置を微調整する前の確認用）。',
      inputSchema: { level: Level.optional(), scopeParentId: z.string().optional() },
    },
    ({ level, scopeParentId }) =>
      run(() => formatFlowLayout(ws.current().project, level ?? 'medium', scopeParentId)),
  );

  server.registerTool(
    'set_node_position',
    {
      title: 'ノード位置を設定',
      description: '工程ノードを絶対座標 (x,y) へ移動。矢印は自動で追従する。',
      inputSchema: {
        taskId: z.string(),
        x: z.number(),
        y: z.number(),
        level: Level.optional(),
        scopeParentId: z.string().optional(),
      },
    },
    ({ taskId, x, y, level, scopeParentId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply(setNodePosition(level ?? 'medium', scopeParentId, taskId, x, y));
        return `移動しました。\n${formatFlowLayout(s.project, level ?? 'medium', scopeParentId)}`;
      }),
  );

  server.registerTool(
    'nudge_node',
    {
      title: 'ノードを微移動',
      description: '工程ノードを相対量 (dx,dy) だけ動かす（微調整向き）。',
      inputSchema: {
        taskId: z.string(),
        dx: z.number(),
        dy: z.number(),
        level: Level.optional(),
        scopeParentId: z.string().optional(),
      },
    },
    ({ taskId, dx, dy, level, scopeParentId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply(nudgeNode(level ?? 'medium', scopeParentId, taskId, dx, dy));
        return `微移動しました。\n${formatFlowLayout(s.project, level ?? 'medium', scopeParentId)}`;
      }),
  );

  server.registerTool(
    'pin_node',
    {
      title: 'ノードを固定/解除',
      description: '工程ノードを固定（pin）すると自動整列(auto_layout)で動かさない。pinned=false で解除。',
      inputSchema: {
        taskId: z.string(),
        pinned: z.boolean(),
        level: Level.optional(),
        scopeParentId: z.string().optional(),
      },
    },
    ({ taskId, pinned, level, scopeParentId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply(pinNode(level ?? 'medium', scopeParentId, taskId, pinned));
        return pinned ? 'ノードを固定しました。' : 'ノードの固定を解除しました。';
      }),
  );

  server.registerTool(
    'set_flow_orientation',
    {
      title: 'フローの向き',
      description: 'フロー図の向きを横(horizontal)/縦(vertical)に変更。',
      inputSchema: {
        orientation: OrientationEnum,
        level: Level.optional(),
        scopeParentId: z.string().optional(),
      },
    },
    ({ orientation, level, scopeParentId }) =>
      run(async () => {
        const s = ws.current();
        await s.apply(setOrientation(level ?? 'medium', scopeParentId, orientation));
        return `向きを ${orientation} にしました。`;
      }),
  );

  server.registerTool(
    'set_lane_height',
    {
      title: 'レーン高さを設定',
      description: '担当レーン（assigneeId で指定）の高さ(px)を変更。並行工程が多いレーンを太くする等。',
      inputSchema: {
        assigneeId: z.string(),
        height: z.number().positive(),
        level: Level.optional(),
        scopeParentId: z.string().optional(),
      },
    },
    ({ assigneeId, height, level, scopeParentId }) =>
      run(async () => {
        const s = ws.current();
        await s.apply(setLaneHeight(level ?? 'medium', scopeParentId, assigneeId, height));
        return `レーン高さを ${Math.round(height)} にしました。\n${formatFlowLayout(s.project, level ?? 'medium', scopeParentId)}`;
      }),
  );

  server.registerTool(
    'auto_layout',
    {
      title: '自動整列',
      description: '依存の前後で左→右に段組みし直す自動整列（tidy）。pin したノードは保持。手動配置はリセットされる。',
      inputSchema: { level: Level.optional(), scopeParentId: z.string().optional() },
    },
    ({ level, scopeParentId }) =>
      run(async () => {
        const s = ws.current();
        await s.apply(autoLayout(level ?? 'medium', scopeParentId));
        return `整列しました。\n${formatFlowLayout(s.project, level ?? 'medium', scopeParentId)}`;
      }),
  );

  server.registerTool(
    'list_assignees',
    { title: '担当一覧', description: '担当（人/部署）を一覧表示。', inputSchema: {} },
    () => run(() => formatAssignees(ws.current().project)),
  );

  server.registerTool(
    'get_metrics',
    { title: '工数集計', description: '末端工数の上位ロールアップと総工数。', inputSchema: {} },
    () => run(() => formatMetrics(ws.current().project)),
  );

  server.registerTool(
    'compare_scenarios',
    { title: 'As-Is/To-Be 比較', description: '工数・LT・待ち時間・難易度分布を As-Is と To-Be で比較。', inputSchema: {} },
    () => run(() => formatCompare(ws.current().project)),
  );

  // ============ 分析・示唆（工数/LT） ============

  server.registerTool(
    'analyze_critical_path',
    {
      title: 'クリティカルパス分析',
      description:
        'リードタイムを律速する工程列（最長重み付き経路）を返す。ここを短縮/並行化すると LT が縮む。各工程の LT と待ち時間も表示。',
      inputSchema: { phase: Phase.optional().describe('asis(既定) / tobe') },
    },
    ({ phase }) => run(() => formatCriticalPath(ws.current().project, phase ?? 'asis')),
  );

  server.registerTool(
    'analyze_automation_candidates',
    {
      title: '自動化/形式知化の候補',
      description:
        '手作業×高工数×ベテラン依存(H) の末端工程を効き目順に返す。自動化や暗黙知の形式知化で最も効果が大きい工程の特定に使う。',
      inputSchema: {},
    },
    () => run(() => formatAutomationCandidates(ws.current().project)),
  );

  server.registerTool(
    'analyze_workload',
    {
      title: '担当別の負荷',
      description: '担当(部署/人)別の総工数・工程数・ベテラン依存数を工数の多い順に返す。負荷の偏り＝ボトルネック人員の検出に。',
      inputSchema: { phase: Phase.optional().describe('asis(既定) / tobe') },
    },
    ({ phase }) => run(() => formatWorkload(ws.current().project, phase ?? 'asis')),
  );

  server.registerTool(
    'validate_project',
    { title: '整合性チェック', description: '参照整合性の問題（依存の端点欠落・親欠落・循環など）を列挙。', inputSchema: {} },
    () =>
      run(() => {
        const issues = ws.current().issues();
        if (!issues.length) return '整合性の問題はありません。';
        return issues.map((i) => `- [${i.kind}] ${i.ref}: ${i.message}`).join('\n');
      }),
  );

  server.registerTool(
    'audit_completeness',
    {
      title: '形式知化の進捗チェック',
      description:
        '末端工程の入力欠落（手順/難易度/工数/LT/自動化/入出力）と「次に聞くべき質問」を、完成度の低い順に返す。暗黙知の形式知化ヒアリングを進めるための羅針盤。',
      inputSchema: {
        onlyIncomplete: z.boolean().optional().describe('true で未完成(100%未満)のみ'),
        limit: z.number().int().positive().optional().describe('表示件数の上限（既定30）'),
      },
    },
    ({ onlyIncomplete, limit }) =>
      run(() => formatAudit(ws.current().project, { onlyIncomplete, limit })),
  );

  server.registerTool(
    'export_table_csv',
    { title: 'CSV 出力', description: '工程表を CSV（RFC4180）で返す。', inputSchema: {} },
    () => run(() => projectToCsv(ws.current().project)),
  );

  server.registerTool(
    'get_project_json',
    { title: 'JSON 取得', description: 'Project ドキュメント全体を JSON で返す（デバッグ・機械処理用）。', inputSchema: {} },
    () => run(() => JSON.stringify(ws.current().project, null, 2)),
  );

  // ============ 工程（構造） ============

  server.registerTool(
    'add_task',
    {
      title: '工程を追加',
      description: '工程を追加する。parentId 省略でルート。作成された工程の ID を返す。',
      inputSchema: {
        name: z.string(),
        level: Level,
        parentId: z.string().optional(),
        assigneeId: z.string().optional(),
        kind: z.enum(['milestone']).optional().describe('節目マーカー。子・出依存・工数を持たない'),
      },
    },
    ({ name, level, parentId, assigneeId, kind }) =>
      run(async () => {
        const s = ws.current();
        if (parentId) requireTask(s.project, parentId);
        const id = uuid();
        await s.apply((p) => addTask(p, { name, level, parentId, assigneeId, id, kind }, uuid));
        return `追加しました {id:${id}}\n${formatTaskTree(s.project)}`;
      }),
  );

  server.registerTool(
    'rename_task',
    { title: '工程名を変更', description: '工程の作業名を変更。', inputSchema: { taskId: z.string(), name: z.string() } },
    ({ taskId, name }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => renameTask(p, taskId, name));
        return `変更しました: ${name}`;
      }),
  );

  server.registerTool(
    'set_task_level',
    { title: '粒度を変更', description: '工程の粒度（大/中/小/詳細）を変更。', inputSchema: { taskId: z.string(), level: Level } },
    ({ taskId, level }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => setTaskLevel(p, taskId, level));
        return `粒度を ${level} にしました。`;
      }),
  );

  server.registerTool(
    'set_task_code',
    {
      title: '工程Noを設定',
      description: '工程No の手動上書き。空文字で自動採番へ戻す。',
      inputSchema: { taskId: z.string(), code: z.string().optional() },
    },
    ({ taskId, code }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => setTaskCode(p, taskId, code));
        return code ? `工程No を ${code} にしました。` : '工程No を自動採番に戻しました。';
      }),
  );

  server.registerTool(
    'set_task_assignee',
    {
      title: '担当を設定',
      description: '工程の担当を設定（assigneeId 省略で担当解除）。',
      inputSchema: { taskId: z.string(), assigneeId: z.string().optional() },
    },
    ({ taskId, assigneeId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        if (assigneeId && !s.project.core.assignees[assigneeId])
          throw new Error(`担当が見つかりません: ${assigneeId}`);
        await s.apply((p) => setAssignee(p, taskId, assigneeId));
        return '担当を更新しました。';
      }),
  );

  server.registerTool(
    'reorder_task',
    {
      title: '兄弟内で並べ替え',
      description: '同じ親の中で工程の位置（0 始まり）を変更。',
      inputSchema: { taskId: z.string(), toIndex: z.number().int().nonnegative() },
    },
    ({ taskId, toIndex }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => reorderTask(p, taskId, toIndex));
        return `並べ替えました。\n${formatTaskTree(s.project)}`;
      }),
  );

  server.registerTool(
    'reparent_task',
    {
      title: '親を変更（移動）',
      description: 'サブツリーを別の親へ移動（newParentId 省略でルート）。粒度は新しい深さに合わせて再計算。',
      inputSchema: {
        taskId: z.string(),
        newParentId: z.string().optional(),
        index: z.number().int().nonnegative().optional(),
      },
    },
    ({ taskId, newParentId, index }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        if (newParentId) requireTask(s.project, newParentId);
        await s.apply((p) => reparentTask(p, taskId, newParentId, index));
        return `移動しました。\n${formatTaskTree(s.project)}`;
      }),
  );

  server.registerTool(
    'delete_task',
    {
      title: '工程を削除',
      description: '工程を削除。既定はサブツリーごと削除し前後を繋ぎ直す。keepChildren=true で子を 1 階層上へ昇格して残す。',
      inputSchema: { taskId: z.string(), keepChildren: z.boolean().optional() },
    },
    ({ taskId, keepChildren }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => (keepChildren ? deleteTaskKeepChildren(p, taskId) : deleteTask(p, taskId)));
        return `削除しました。\n${formatTaskTree(s.project)}`;
      }),
  );

  server.registerTool(
    'add_parallel_task',
    {
      title: '並行工程を追加',
      description: '基準工程 refId と同じ親・粒度・担当の新工程を直後に作り、ref の前工程のみコピーする。',
      inputSchema: { refId: z.string() },
    },
    ({ refId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, refId);
        const id = uuid();
        await s.apply((p) => addParallelTask(p, refId, uuid, id));
        return `並行工程を追加しました {id:${id}}\n${formatTaskTree(s.project)}`;
      }),
  );

  server.registerTool(
    'make_parallel',
    {
      title: '既存工程を並行化',
      description: '既存工程 taskId を基準工程 baseId と同じ前後関係にする（同粒度のみ）。',
      inputSchema: { taskId: z.string(), baseId: z.string() },
    },
    ({ taskId, baseId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        requireTask(s.project, baseId);
        await s.apply((p) => makeParallel(p, taskId, baseId, uuid));
        return `並行化しました。\n${formatDependencies(s.project)}`;
      }),
  );

  // ============ 依存（流れ） ============

  server.registerTool(
    'add_dependency',
    {
      title: '依存を追加',
      description: '工程 from → to の流れ（依存）を追加。',
      inputSchema: { from: z.string(), to: z.string() },
    },
    ({ from, to }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, from);
        requireTask(s.project, to);
        await s.apply((p) => addDependency(p, from, to, uuid));
        return `依存を追加しました。\n${formatDependencies(s.project)}`;
      }),
  );

  server.registerTool(
    'remove_dependency',
    { title: '依存を削除', description: 'depId の依存を削除。', inputSchema: { dependencyId: z.string() } },
    ({ dependencyId }) =>
      run(async () => {
        const s = ws.current();
        requireDep(s.project, dependencyId);
        await s.apply((p) => removeDependency(p, dependencyId));
        return `依存を削除しました。\n${formatDependencies(s.project)}`;
      }),
  );

  server.registerTool(
    'set_dependency_phase',
    {
      title: '依存のシナリオを設定',
      description: '依存の所属シナリオを設定（asis 専用 / tobe 専用 / 省略で両方）。並行化の表現に使う。',
      inputSchema: { dependencyId: z.string(), phase: Phase.optional() },
    },
    ({ dependencyId, phase }) =>
      run(async () => {
        const s = ws.current();
        requireDep(s.project, dependencyId);
        await s.apply((p) => setDependencyPhase(p, dependencyId, phase));
        return `シナリオを ${phase ?? '両方'} にしました。`;
      }),
  );

  // ============ 担当 ============

  server.registerTool(
    'add_assignee',
    {
      title: '担当を追加',
      description: '担当（人/部署）を追加。',
      inputSchema: { name: z.string(), kind: AssigneeKind },
    },
    ({ name, kind }) =>
      run(async () => {
        const s = ws.current();
        const before = new Set(Object.keys(s.project.core.assignees));
        await s.apply((p) => addAssignee(p, { name, kind }, uuid));
        const id = Object.keys(s.project.core.assignees).find((k) => !before.has(k));
        return `追加しました {assigneeId:${id ?? '?'}}\n${formatAssignees(s.project)}`;
      }),
  );

  // ============ 工程表詳細（As-Is） ============

  server.registerTool(
    'update_task_detail',
    {
      title: 'As-Is 詳細を更新',
      description: '工程表の As-Is 項目を更新（渡した項目のみ反映）。工数=分・LT=日。',
      inputSchema: {
        taskId: z.string(),
        how: z.string().optional(),
        system: z.string().optional(),
        effortMinutes: z.number().nonnegative().optional(),
        ltDays: z.number().nonnegative().optional(),
        note: z.string().optional(),
        volume: z.string().optional(),
        exception: z.string().optional(),
        automation: Automation.optional(),
        dataLink: z.string().optional(),
        regulation: z.string().optional(),
        difficulty: Difficulty.optional(),
        status: Status.optional(),
        fillColor: Color.optional(),
        textColor: Color.optional(),
      },
    },
    ({ taskId, ...rest }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        const patch: TaskDetailPatch = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
        }
        if (Object.keys(patch).length === 0) throw new Error('更新する項目がありません。');
        await s.apply((p) => updateTaskDetail(p, taskId, patch));
        return `更新しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  server.registerTool(
    'update_task_tobe',
    {
      title: 'To-Be 差分を更新',
      description:
        'To-Be（あるべき姿）の差分を更新。値を渡すと設定、null を渡すとその差分を削除（As-Is と同じへ戻す）。',
      inputSchema: {
        taskId: z.string(),
        effortMinutes: z.number().nonnegative().nullable().optional(),
        ltDays: z.number().nonnegative().nullable().optional(),
        difficulty: Difficulty.nullable().optional(),
        automation: Automation.nullable().optional(),
        assigneeId: z.string().nullable().optional(),
        rationale: z.string().nullable().optional(),
        lifecycle: z.enum(['added', 'removed']).nullable().optional(),
      },
    },
    ({ taskId, ...rest }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        const patch: Partial<TaskDetailToBe> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v === undefined) continue; // キー未指定は触らない
          (patch as Record<string, unknown>)[k] = v === null ? undefined : v; // null=差分削除
        }
        if (Object.keys(patch).length === 0) throw new Error('更新する項目がありません。');
        await s.apply((p) => updateTaskToBe(p, taskId, patch));
        return `To-Be を更新しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  server.registerTool(
    'copy_asis_to_tobe',
    {
      title: '現状をTo-Beへ複製',
      description: 'As-Is の工数・LT・難易度・自動化を To-Be の起点へ複製する。',
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => copyAsIsToToBe(p, taskId));
        return `複製しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  // ============ 入出力（帳票/情報） ============

  server.registerTool(
    'add_io_item',
    {
      title: '入出力を追加',
      description: '工程の入力/出力（帳票=doc / 情報=info）を追加。',
      inputSchema: {
        taskId: z.string(),
        io: z.enum(['inputs', 'outputs']),
        name: z.string(),
        kind: IoKind,
        formInfo: z.string().optional(),
        source: z.string().optional(),
      },
    },
    ({ taskId, io, name, kind, formInfo, source }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => addIoItem(p, taskId, io, { name, kind, formInfo, source }, uuid));
        return `追加しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  server.registerTool(
    'update_io_item',
    {
      title: '入出力を更新',
      description: '入出力アイテムを更新（渡した項目のみ）。',
      inputSchema: {
        taskId: z.string(),
        ioId: z.string(),
        name: z.string().optional(),
        kind: IoKind.optional(),
        formInfo: z.string().optional(),
        source: z.string().optional(),
      },
    },
    ({ taskId, ioId, ...rest }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v;
        await s.apply((p) => updateIoItem(p, taskId, ioId, patch));
        return `更新しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  server.registerTool(
    'remove_io_item',
    {
      title: '入出力を削除',
      description: '入出力アイテムを削除。',
      inputSchema: { taskId: z.string(), ioId: z.string() },
    },
    ({ taskId, ioId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => removeIoItem(p, taskId, ioId));
        return `削除しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  // ============ 課題 ============

  server.registerTool(
    'add_issue_item',
    {
      title: '課題を追加',
      description: '工程に課題（と方策）を追加。target を io にすると特定の帳票/情報へ紐づく。',
      inputSchema: {
        taskId: z.string(),
        issue: z.string(),
        measure: z.string().optional(),
        targetIoId: z.string().optional().describe('特定の入出力に紐づける場合の ioId'),
      },
    },
    ({ taskId, issue, measure, targetIoId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        const target: IssueTarget | undefined = targetIoId ? { kind: 'io', ioId: targetIoId } : undefined;
        await s.apply((p) => addIssueItem(p, taskId, { issue, measure, target }, uuid));
        return `追加しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  server.registerTool(
    'update_issue_item',
    {
      title: '課題を更新',
      description: '課題の本文/方策を更新（渡した項目のみ）。',
      inputSchema: {
        taskId: z.string(),
        issueId: z.string(),
        issue: z.string().optional(),
        measure: z.string().optional(),
      },
    },
    ({ taskId, issueId, issue, measure }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        const patch: Record<string, unknown> = {};
        if (issue !== undefined) patch.issue = issue;
        if (measure !== undefined) patch.measure = measure;
        await s.apply((p) => updateIssueItem(p, taskId, issueId, patch));
        return `更新しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  server.registerTool(
    'remove_issue_item',
    {
      title: '課題を削除',
      description: '課題を削除。',
      inputSchema: { taskId: z.string(), issueId: z.string() },
    },
    ({ taskId, issueId }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        await s.apply((p) => removeIssueItem(p, taskId, issueId));
        return `削除しました。\n${formatTaskDetail(s.project, taskId)}`;
      }),
  );

  // ============ 手順書 / 資料台帳 ============

  server.registerTool(
    'get_procedure',
    {
      title: '手順書を取得',
      description: '工程の手順書（目的・各ステップの action/why/bodyMd・条件分岐・参照資料・画像）を返す。未作成なら「手順書は未作成です」。',
      inputSchema: { taskId: z.string() },
    },
    ({ taskId }) =>
      run(() => {
        requireTask(ws.current().project, taskId);
        return formatProcedure(ws.current().project, taskId);
      }),
  );

  server.registerTool(
    'upsert_procedure',
    {
      title: '手順書を作成/更新',
      description:
        '工程の手順書を作成/更新する。purpose(目的)を渡すと設定し、steps を渡すと既存の全ステップを置換する' +
        '（各ステップは新規IDで作り直すため、既存ステップの条件分岐/参照/画像は失われる）。purpose/steps とも省略可（省略した側は変更しない）。',
      inputSchema: {
        taskId: z.string(),
        purpose: z.string().optional(),
        steps: z
          .array(
            z.object({
              action: z.string(),
              why: z.string().optional(),
              bodyMd: z.string().optional(),
            }),
          )
          .optional()
          .describe('渡すと既存の全ステップを置換する（各ステップの条件分岐/参照/画像は空で作り直される）'),
      },
    },
    ({ taskId, purpose, steps }) =>
      run(async () => {
        const s = ws.current();
        requireTask(s.project, taskId);
        const now = new Date().toISOString();
        await s.apply((p) => {
          let next = upsertProcedure(p, taskId, purpose === undefined ? {} : { purpose }, now);
          if (steps) {
            const existingIds = (next.manual.procedures[taskId]?.steps ?? []).map((st) => st.id);
            for (const id of existingIds) next = removeStep(next, taskId, id, now);
            for (const st of steps) next = addStep(next, taskId, st, uuid, now);
          }
          return next;
        });
        return `更新しました。\n${formatProcedure(s.project, taskId)}`;
      }),
  );

  server.registerTool(
    'upsert_asset',
    {
      title: '資料を登録/更新',
      description:
        '資料台帳（手順書の参照から使う資料）を登録/更新する（id 省略で新規作成、指定で更新）。' +
        '所在地は alias+relPath（プロジェクト内の相対パス）か url のいずれかで指定（両方省略で未設定）。',
      inputSchema: {
        id: z.string().optional().describe('省略で新規作成、指定で更新'),
        name: z.string(),
        desc: z.string().optional(),
        alias: z.string().optional().describe('相対パスの起点となるエイリアス（relPath とセットで指定）'),
        relPath: z.string().optional().describe('alias からの相対パス'),
        url: z.string().optional(),
      },
    },
    ({ id, name, desc, alias, relPath, url }) =>
      run(async () => {
        const s = ws.current();
        const locator: AssetLocator | undefined =
          alias && relPath ? { alias, relPath } : url ? { url } : undefined;
        const before = new Set(Object.keys(s.project.manual.assets));
        await s.apply((p) => upsertAsset(p, { id, name, desc, locator }, uuid));
        const assetId = id ?? Object.keys(s.project.manual.assets).find((k) => !before.has(k));
        const a = assetId ? s.project.manual.assets[assetId] : undefined;
        return `登録しました {assetId:${assetId ?? '?'}}\n- ${a?.name ?? name}${a?.desc ? `（${a.desc}）` : ''}`;
      }),
  );
}
