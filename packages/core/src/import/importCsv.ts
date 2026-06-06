// 取り込み（初回ブートストラップ・`docs/05-persistence.md` §6）。CSV → 新規 Project + ImportReport。
// 外部→内部 ID の発番はここだけ（idGen）。Excel は将来 xlsx を噛ませて同じ Importer IF に載せる。
import type {
  Project,
  ProcessTask,
  ProcessLevel,
  Assignee,
  TaskDetail,
  IoItem,
  IssueItem,
  Dependency,
  Id,
} from '../model/types';
import type { IdGen } from '../ids';
import { CURRENT_SCHEMA_VERSION } from '../persistence/migrate';

export interface ImportReport {
  created: { tasks: number; ios: number; issues: number; dependencies: number };
  unresolvedDeps: Array<{ row: number; ref: string }>;
  hierarchyIssues: Array<{ row: number; reason: string }>;
  warnings: string[];
}

const LEVELS: Record<string, ProcessLevel> = {
  大: 'large',
  中: 'medium',
  小: 'small',
  詳細: 'detail',
  large: 'large',
  medium: 'medium',
  small: 'small',
  detail: 'detail',
};
const RANK: Record<ProcessLevel, number> = { large: 0, medium: 1, small: 2, detail: 3 };

// 最小の CSV パーサ（ダブルクオート・カンマ・改行に対応）。
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const splitMulti = (s: string): string[] =>
  s
    .split(/[\n;；]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function importCsv(text: string, idGen: IdGen): { project: Project; report: ImportReport } {
  const report: ImportReport = {
    created: { tasks: 0, ios: 0, issues: 0, dependencies: 0 },
    unresolvedDeps: [],
    hierarchyIssues: [],
    warnings: [],
  };
  const rows = parseCsv(text);
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { id: idGen(), title: '取り込みプロジェクト', createdAt: now, updatedAt: now, appVersion: '0.0.0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
  };
  if (rows.length === 0) {
    report.warnings.push('空のファイルです');
    return { project, report };
  }

  // ヘッダ → 列インデックス
  const header = rows[0]!.map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h === name);
  const idx = {
    code: col('工程No'),
    name: col('作業名'),
    assignee: col('担当'),
    level: col('粒度'),
    prev: col('前工程'),
    inputs: col('インプット'),
    outputs: col('アウトプット'),
    issue: col('課題'),
  };
  if (idx.name < 0) {
    report.warnings.push('「作業名」列が見つかりません');
    return { project, report };
  }

  const assigneeByName = new Map<string, Id>();
  const ensureAssignee = (name: string): Id => {
    const key = name.trim();
    let id = assigneeByName.get(key);
    if (!id) {
      id = idGen();
      const a: Assignee = { id, name: key, kind: 'department' };
      project.core.assignees[id] = a;
      assigneeByName.set(key, id);
    }
    return id;
  };

  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  // レベル別の最後のタスク（親の解決用）
  const lastByRank: (Id | undefined)[] = [undefined, undefined, undefined, undefined];
  const nameToId = new Map<string, Id>();
  const codeToId = new Map<string, Id>();
  const pendingDeps: Array<{ row: number; toId: Id; ref: string; scope: Id | undefined }> = [];

  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2; // 1-based + ヘッダ
    const name = get(r, idx.name);
    if (!name) return;
    const levelRaw = get(r, idx.level);
    const level = LEVELS[levelRaw] ?? 'medium';
    if (levelRaw && !LEVELS[levelRaw]) {
      report.hierarchyIssues.push({ row: rowNo, reason: `不明な粒度「${levelRaw}」→ 中として取込` });
    }
    const rank = RANK[level];
    // 親 = 1 段上のランクの直近タスク（無ければさらに上、レベルスキップは記録）
    let parentId: Id | undefined;
    for (let up = rank - 1; up >= 0; up--) {
      if (lastByRank[up]) {
        parentId = lastByRank[up];
        if (up !== rank - 1) {
          report.hierarchyIssues.push({ row: rowNo, reason: 'レベルスキップ（親を上位で解決）' });
        }
        break;
      }
    }

    const id = idGen();
    const task: ProcessTask = { id, name, level, order: i, parentId };
    const code = get(r, idx.code);
    if (code) task.code = code;
    const assigneeName = get(r, idx.assignee);
    if (assigneeName) task.assigneeId = ensureAssignee(assigneeName);
    project.core.tasks[id] = task;
    report.created.tasks++;
    nameToId.set(name, id);
    if (code) codeToId.set(code, id);
    lastByRank[rank] = id;
    for (let below = rank + 1; below < lastByRank.length; below++) lastByRank[below] = undefined;

    // 詳細（I/O・課題）
    const detail: TaskDetail = { taskId: id };
    const inputs = splitMulti(get(r, idx.inputs)).map<IoItem>((nm) => {
      report.created.ios++;
      return { id: idGen(), name: nm, kind: level === 'small' || level === 'detail' ? 'info' : 'doc' };
    });
    const outputs = splitMulti(get(r, idx.outputs)).map<IoItem>((nm) => {
      report.created.ios++;
      return { id: idGen(), name: nm, kind: level === 'small' || level === 'detail' ? 'info' : 'doc' };
    });
    const issues = splitMulti(get(r, idx.issue)).map<IssueItem>((iss) => {
      report.created.issues++;
      return { id: idGen(), issue: iss };
    });
    if (inputs.length) detail.inputs = inputs;
    if (outputs.length) detail.outputs = outputs;
    if (issues.length) detail.issues = issues;
    project.details[id] = detail;

    // 前工程（後で解決）
    for (const ref of splitMulti(get(r, idx.prev))) {
      pendingDeps.push({ row: rowNo, toId: id, ref, scope: parentId });
    }
  });

  // 前工程参照の解決（工程No 優先 → 作業名）
  for (const dep of pendingDeps) {
    const fromId = codeToId.get(dep.ref) ?? nameToId.get(dep.ref);
    if (!fromId || fromId === dep.toId) {
      report.unresolvedDeps.push({ row: dep.row, ref: dep.ref });
      continue;
    }
    const id = idGen();
    const d: Dependency = { id, from: fromId, to: dep.toId, type: 'FS', scopeParentId: dep.scope };
    project.core.dependencies[id] = d;
    report.created.dependencies++;
  }

  return { project, report };
}
