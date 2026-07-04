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
  Automation,
  Difficulty,
  Id,
} from '../model/types';
import type { IdGen } from '../ids';
import { CURRENT_SCHEMA_VERSION } from '../persistence/migrate';
import { CSV_FORMULA_TRIGGER, AUTOMATION_LABEL } from '../export/exportRows';

// 自動化区分（取込）。出力の日本語ラベル（exportRows の AUTOMATION_LABEL）と内部値の双方を受ける。
const AUTOMATION_BY_LABEL: Record<string, Automation> = { manual: 'manual', system: 'system', partial: 'partial' };
for (const [k, v] of Object.entries(AUTOMATION_LABEL)) AUTOMATION_BY_LABEL[v] = k as Automation;
// 難易度（取込）。H/M/L と 高/中/低 の双方を受ける。
const DIFFICULTY_BY_LABEL: Record<string, Difficulty> = { H: 'H', M: 'M', L: 'L', 高: 'H', 中: 'M', 低: 'L' };

// エクスポート側（exportRows の neutralizeFormula）が数式インジェクション対策で先頭に付けた
// ' を剥がし、元の値へ戻す（ラウンドトリップ維持）。'=… のように ' の直後が数式トリガ文字の
// ときだけ剥がすので、ユーザーが意図して付けた通常の ' は保持される。
const stripCsvFormulaGuard = (s: string): string =>
  s.length > 1 && s[0] === "'" && CSV_FORMULA_TRIGGER.test(s.slice(1)) ? s.slice(1) : s;

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
  return rowsToProject(parseCsv(text), idGen);
}

// 行列（CSV/Excel 共通）→ 新規 Project。Excel 取り込みは app 側でパースして本関数に渡す。
export function rowsToProject(
  rows: string[][],
  idGen: IdGen,
): { project: Project; report: ImportReport } {
  const report: ImportReport = {
    created: { tasks: 0, ios: 0, issues: 0, dependencies: 0 },
    unresolvedDeps: [],
    hierarchyIssues: [],
    warnings: [],
  };
  const now = new Date().toISOString();
  const project: Project = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { id: idGen(), title: '取り込みプロジェクト', createdAt: now, updatedAt: now, appVersion: '0.0.0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
    manual: { procedures: {}, assets: {} },
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
    how: col('業務内容'),
    system: col('使用システム'),
    effort: col('工数(分)'),
    note: col('備考'),
    volume: col('ボリューム'),
    exception: col('例外対応'),
    automation: col('自動化区分'),
    dataLink: col('データ連携先'),
    regulation: col('関連規程'),
    difficulty: col('難易度'),
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

  const get = (r: string[], i: number) =>
    i >= 0 ? stripCsvFormulaGuard((r[i] ?? '').trim()) : '';
  // レベル別の最後のタスク（親の解決用）
  const lastByRank: (Id | undefined)[] = [undefined, undefined, undefined, undefined];
  const nameToId = new Map<string, Id>();
  const dupNames = new Set<string>(); // 同名が複数ある作業名（名前参照では特定不能）
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
    if (nameToId.has(name)) dupNames.add(name);
    else nameToId.set(name, id);
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
    const issues = splitMulti(get(r, idx.issue)).map<IssueItem>((raw) => {
      report.created.issues++;
      // エクスポートの「課題→方策」形式を復元（最初の → で分割。両側が空なら 1 つの課題文として扱う）
      const sep = raw.indexOf('→');
      if (sep >= 0) {
        const iss = raw.slice(0, sep).trim();
        const measure = raw.slice(sep + 1).trim();
        if (iss && measure) return { id: idGen(), issue: iss, measure };
      }
      return { id: idGen(), issue: raw };
    });
    if (inputs.length) detail.inputs = inputs;
    if (outputs.length) detail.outputs = outputs;
    if (issues.length) detail.issues = issues;
    const how = get(r, idx.how);
    if (how) detail.how = how;
    const system = get(r, idx.system);
    if (system) detail.system = system;
    const effortRaw = get(r, idx.effort);
    if (effortRaw) {
      const effort = Number(effortRaw);
      if (Number.isFinite(effort)) detail.effortMinutes = effort;
      else report.warnings.push(`${rowNo} 行目: 工数(分)「${effortRaw}」を数値として読めないため無視`);
    }
    const note = get(r, idx.note);
    if (note) detail.note = note;
    // 分析項目（提言#3）。空欄は付けない（optional・後方互換）。
    const volume = get(r, idx.volume);
    if (volume) detail.volume = volume;
    const exception = get(r, idx.exception);
    if (exception) detail.exception = exception;
    const automationRaw = get(r, idx.automation);
    if (automationRaw) {
      const a = AUTOMATION_BY_LABEL[automationRaw];
      if (a) detail.automation = a;
      else report.warnings.push(`${rowNo} 行目: 自動化区分「${automationRaw}」は不明（手作業/システム自動/一部自動）`);
    }
    const dataLink = get(r, idx.dataLink);
    if (dataLink) detail.dataLink = dataLink;
    const regulation = get(r, idx.regulation);
    if (regulation) detail.regulation = regulation;
    const difficultyRaw = get(r, idx.difficulty);
    if (difficultyRaw) {
      const diff = DIFFICULTY_BY_LABEL[difficultyRaw];
      if (diff) detail.difficulty = diff;
      else report.warnings.push(`${rowNo} 行目: 難易度「${difficultyRaw}」は不明（H/M/L）`);
    }
    project.details[id] = detail;

    // 前工程（後で解決）
    for (const ref of splitMulti(get(r, idx.prev))) {
      pendingDeps.push({ row: rowNo, toId: id, ref, scope: parentId });
    }
  });

  // 前工程参照の解決（工程No 優先 → 作業名。同名複数は誤接続を避けて未解決扱い）
  for (const dep of pendingDeps) {
    const byCode = codeToId.get(dep.ref);
    if (!byCode && dupNames.has(dep.ref)) {
      report.unresolvedDeps.push({ row: dep.row, ref: dep.ref });
      report.warnings.push(
        `${dep.row} 行目: 前工程「${dep.ref}」は同名の工程が複数あり特定できません（工程No で指定してください）`,
      );
      continue;
    }
    const fromId = byCode ?? nameToId.get(dep.ref);
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
