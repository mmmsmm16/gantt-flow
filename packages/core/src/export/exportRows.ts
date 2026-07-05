// 出力（`docs/06-roadmap.md` Phase4）。Project → 表の行列。Excel/CSV はこの行列を各形式に流す。
import type { Project, ProcessTask, ProcessLevel, Automation, Id } from '../model/types';
import { computeCodes } from '../codes';
import { isMilestone } from '../milestone';

const LEVEL_LABEL: Record<ProcessLevel, string> = {
  large: '大',
  medium: '中',
  small: '小',
  detail: '詳細',
};

// 自動化区分の表示ラベル。納品物（Excel/CSV/印刷）は人間が読むため日本語で出す。
// 取込側（importCsv）はこのラベルと内部値の双方を受ける（ラウンドトリップ維持）。
export const AUTOMATION_LABEL: Record<Automation, string> = {
  manual: '手作業',
  system: 'システム自動',
  partial: '一部自動',
};

export const EXPORT_HEADER = [
  '工程No',
  '作業名',
  '担当',
  '粒度',
  '前工程',
  'インプット',
  'アウトプット',
  '課題',
  '業務内容',
  '使用システム',
  '工数(分)',
  '備考',
  // 以下は改善提案の根拠になる分析項目。画面で入力できるのに従来は出力から落ちていた（提言#3）。
  // 既存列の位置を保つため末尾に追加（CSV ラウンドトリップ・位置依存の検証を壊さない）。
  'ボリューム',
  '例外対応',
  '自動化区分',
  'データ連携先',
  '関連規程',
  '難易度',
];

export interface ProjectToRowsOptions {
  /**
   * 前工程列の参照方法。
   * - 'code'（既定）: 工程No。再取込時に一意解決できるため CSV ラウンドトリップ用。
   * - 'name': 作業名。XLSX / 印刷など人間が読む出力用（旧来の表示）。
   */
  depRef?: 'code' | 'name';
}

/** 出力行に元の工程 id を添えた形（見出し行は id=null）。選択行だけの TSV コピー等で
 *  行↔工程の対応が要るとき用。projectToRows はこれの cells だけを取り出す薄いラッパ。 */
export interface ExportRow {
  id: Id | null;
  cells: string[];
}

export function projectToRowsWithIds(project: Project, opts: ProjectToRowsOptions = {}): ExportRow[] {
  const depRef = opts.depRef ?? 'code';
  const { tasks, dependencies, assignees } = project.core;
  const byParent = new Map<Id | undefined, ProcessTask[]>();
  for (const t of Object.values(tasks)) {
    const key = t.parentId ?? undefined;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(t);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.order - b.order);

  const nameOf = (id: Id) => tasks[id]?.name ?? '';
  const codes = computeCodes(project.core);
  const rows: ExportRow[] = [{ id: null, cells: EXPORT_HEADER }];

  const walk = (parentId: Id | undefined) => {
    const arr = byParent.get(parentId) ?? [];
    arr.forEach((t) => {
      const ms = isMilestone(project.core, t.id);
      // MS は工程No を持たない（computeCodes が採番しない）ため空欄で出す。行自体は残す。
      const no = codes[t.id] ?? '';
      const d = project.details[t.id];
      // 前工程の参照は depRef で切替（'code'=工程No / 'name'=作業名）。欠けている側は
      // もう一方で補う（コード未計算・名前空の工程でも列を空にしない）。
      const prev = Object.values(dependencies)
        .filter((dep) => dep.to === t.id)
        .map((dep) =>
          depRef === 'name'
            ? nameOf(dep.from) || (codes[dep.from] ?? '')
            : codes[dep.from] ?? nameOf(dep.from),
        )
        .join('；');
      rows.push({
        id: t.id,
        cells: [
          no,
          ms ? `◆ ${t.name}` : t.name,
          ms ? '' : t.assigneeId ? assignees[t.assigneeId]?.name ?? '' : '',
          LEVEL_LABEL[t.level],
          prev,
          (d?.inputs ?? []).map((x) => x.name).join('；'),
          (d?.outputs ?? []).map((x) => x.name).join('；'),
          (d?.issues ?? []).map((x) => (x.measure ? `${x.issue}→${x.measure}` : x.issue)).join('；'),
          d?.how ?? '',
          d?.system ?? '',
          ms ? '' : d?.effortMinutes != null ? String(d.effortMinutes) : '',
          d?.note ?? '',
          d?.volume ?? '',
          d?.exception ?? '',
          d?.automation ? AUTOMATION_LABEL[d.automation] : '',
          d?.dataLink ?? '',
          d?.regulation ?? '',
          d?.difficulty ?? '',
        ],
      });
      walk(t.id);
    });
  };
  walk(undefined);
  return rows;
}

export function projectToRows(project: Project, opts: ProjectToRowsOptions = {}): string[][] {
  return projectToRowsWithIds(project, opts).map((r) => r.cells);
}

// CSV 数式インジェクション（Formula/CSV Injection）対策。Excel/Sheets はセルが
// = + - @ TAB CR で始まると「数式」として解釈し、=HYPERLINK(...) での情報送信や
// DDE 経由のコマンド起動（=cmd|'...'）に悪用され得る。納品物として CSV を配る前提のため、
// 該当セルの先頭に ' を足して文字列として扱わせる（OWASP 推奨）。取り込み側（importCsv の
// stripCsvFormulaGuard）が対称的に ' を剥がすので CSV ラウンドトリップは保たれる。
export const CSV_FORMULA_TRIGGER = /^[=+\-@\t\r]/;
function neutralizeFormula(s: string): string {
  return CSV_FORMULA_TRIGGER.test(s) ? `'${s}` : s;
}

function csvCell(s: string): string {
  const v = neutralizeFormula(s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function rowsToCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

// クリップボード用 TSV（Excel 書き戻し）。列はタブ、行は CRLF（Excel の貼り付け慣習）。
// 数式インジェクション対策は CSV と共通。タブ/改行/二重引用符を含むセルは "…" で囲み内部を "" にエスケープ
// （そうしないと本文中のタブ・改行が列/行を破壊する）。
function tsvCell(s: string): string {
  const v = neutralizeFormula(s);
  return /[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function rowsToTsv(rows: string[][]): string {
  return rows.map((r) => r.map(tsvCell).join('\t')).join('\r\n');
}

export function projectToCsv(project: Project): string {
  return rowsToCsv(projectToRows(project));
}
