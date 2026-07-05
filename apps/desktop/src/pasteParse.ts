// クリップボード（Excel / TSV）貼り付けの列マッピング＋階層推定＋正規化。純粋・決定論・UI 非依存。
// 見出し行があれば列名から [工程No / 作業名 / 担当 / 工数] を対応付け、無ければ位置（0=名前・1=担当・2=工数）。
// 出力は正規化済みの [name, assignee, effortMinutesStr, depthStr] 行配列で、store.pasteRowsAsTasks が位置で読む。
//
// 見出し検出は「作業名を含む工程（例: 受注工程）を誤って見出しと判定し、実データ行を落とす」事故を
// 避けるため、部分一致ではなく**セル完全一致の辞書**で行い、かつ担当/工数/工程No の構造列が見出しに
// 現れる場合のみ見出しとみなす（データ行にはセル値として「担当」「工数」「工程No」がまず現れない）。
//
// 階層（depth）は木構造を作り替えるため、2 つの信号から推定する:
//  1. 工程No 列があり階層コード（1 / 1-1 / 1-1-2）なら、区切り数から depth を決める（往復貼り戻し向け）。
//  2. 無ければ作業名セルの**行頭インデント**（スペース/タブ/全角）をスタック法で depth 化（テキスト概要向け）。
// depth 0 は基準粒度、以降 大→中→小→詳細 と1段ずつ細かくなる（store 側で親子と粒度を組む）。

export type PasteColumnKey = 'name' | 'assignee' | 'effort' | 'code';

// セル値が完全一致したら見出しとみなすラベル辞書（前後空白は除去して照合）。
const HEADER_LABELS: Record<string, PasteColumnKey> = {
  作業名: 'name', 作業: 'name', 作業内容: 'name', 工程: 'name', 工程名: 'name', タスク: 'name',
  名称: 'name', 項目: 'name', 業務: 'name', 業務内容: 'name', 内容: 'name', ステップ: 'name',
  担当: 'assignee', 担当者: 'assignee', 部門: 'assignee', 部署: 'assignee', 責任者: 'assignee', ロール: 'assignee',
  工数: 'effort', 所要時間: 'effort', 作業時間: 'effort', 時間: 'effort', 所要: 'effort', '工数(h)': 'effort', '工数（h）': 'effort',
  工程No: 'code', 工程no: 'code', No: 'code', 'No.': 'code', NO: 'code', 番号: 'code', 通番: 'code', ステップNo: 'code',
};

// 工数セルを分へ。"2h" "2時間" "0.5" "120分" 等。数値のみは時間とみなす（工数列の慣習）。負値/非数は無視。
export function parseEffortCell(s: string): number | undefined {
  const t = s.trim();
  if (!t) return undefined;
  const min = /^(\d+(?:\.\d+)?)\s*(分|mins?|min)$/i.exec(t);
  if (min) {
    const v = Number(min[1]);
    return Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
  }
  const hr = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|時間|時)?$/i.exec(t);
  if (hr) {
    const v = Number(hr[1]);
    return Number.isFinite(v) && v >= 0 ? Math.round(v * 60) : undefined;
  }
  return undefined;
}

// 構造列（担当 / 工数 / 工程No）が見出しに現れるときだけ見出し行とみなす（誤検出でデータを落とさない）。
function looksLikeHeader(row: string[]): boolean {
  const keys = row.map((c) => HEADER_LABELS[c.trim()]).filter(Boolean) as PasteColumnKey[];
  return keys.includes('assignee') || keys.includes('effort') || keys.includes('code');
}

function mapHeader(row: string[]): Partial<Record<PasteColumnKey, number>> {
  const map: Partial<Record<PasteColumnKey, number>> = {};
  row.forEach((cell, i) => {
    const key = HEADER_LABELS[cell.trim()];
    if (key && map[key] === undefined) map[key] = i;
  });
  if (map.name === undefined) map.name = 0; // 名前列が見出しから決まらなければ先頭列。
  return map;
}

// 工程No コードの階層深さ（区切り数）。"1"→0, "1-1"→1, "1-1-2"→2, "1.2"→1。非階層/空は 0。
function codeDepth(code: string): number {
  const t = code.trim();
  if (!t) return 0;
  const segs = t.split(/[-.．－_]/).filter((s) => s !== '');
  return Math.max(0, segs.length - 1);
}

// 行頭インデント幅（スペース/タブ/全角スペースの連なりの文字数）。タブは 1 段の目安として重み付け。
function indentWidth(raw: string): number {
  const m = /^[\s　]*/.exec(raw);
  if (!m) return 0;
  let w = 0;
  for (const ch of m[0]) w += ch === '\t' ? 4 : 1; // タブは 4 相当（distinct 幅のスタック法で正規化される）
  return w;
}

// インデント幅の列からスタック法で depth を割り当てる（幅の跳びは1段ずつ・浅くなれば pop）。
function depthsFromIndent(widths: number[]): number[] {
  const stack: number[] = [];
  return widths.map((w) => {
    while (stack.length > 0 && w < stack[stack.length - 1]!) stack.pop();
    if (stack.length > 0 && stack[stack.length - 1] === w) return stack.length - 1; // 同幅＝兄弟
    stack.push(w); // より深い（または最初）＝1段深く
    return stack.length - 1;
  });
}

export interface PasteParseResult {
  /** 正規化行 [name, assignee, effortMinutesStr, depthStr]（空名は除外）。 */
  rows: string[][];
  /** 見出し行を検出して落としたか（トーストで利用者に知らせる）。 */
  hadHeader: boolean;
  /** どの列を何に割り当てたか（見出し無しは位置マッピング）。 */
  columns: Partial<Record<PasteColumnKey, number>>;
  /** 階層（depth>0）を推定したか（トーストで利用者に知らせる）。 */
  hierarchical: boolean;
}

export function parsePastedRows(text: string): PasteParseResult {
  const grid = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.split('\t'));
  while (grid.length && grid[grid.length - 1]!.every((c) => !c.trim())) grid.pop(); // 末尾の空行を除去
  if (!grid.length) return { rows: [], hadHeader: false, columns: {}, hierarchical: false };

  let columns: Partial<Record<PasteColumnKey, number>>;
  let dataStart = 0;
  let hadHeader = false;
  if (grid.length >= 2 && looksLikeHeader(grid[0]!)) {
    columns = mapHeader(grid[0]!);
    dataStart = 1;
    hadHeader = true;
  } else {
    columns = { name: 0, assignee: 1, effort: 2 }; // 位置マッピング（従来互換）
  }

  // データ行（空名を除外）を先に集める。生の名前セル（インデント判定用）も保持。
  const data: { name: string; assignee: string; effMin?: number; rawName: string; code: string }[] = [];
  for (let i = dataStart; i < grid.length; i++) {
    const r = grid[i]!;
    const rawName = r[columns.name ?? 0] ?? '';
    const name = rawName.trim();
    if (!name) continue;
    const assignee = columns.assignee !== undefined ? (r[columns.assignee] ?? '').trim() : '';
    const effMin = columns.effort !== undefined ? parseEffortCell(r[columns.effort] ?? '') : undefined;
    const code = columns.code !== undefined ? (r[columns.code] ?? '').trim() : '';
    data.push({ name, assignee, effMin, rawName, code });
  }

  // depth 推定: 工程No 列が階層コードを含むなら code から、無ければインデントから。
  const codesHierarchical = columns.code !== undefined && data.some((d) => codeDepth(d.code) > 0);
  let depths: number[];
  if (codesHierarchical) {
    depths = data.map((d) => codeDepth(d.code));
  } else {
    depths = depthsFromIndent(data.map((d) => indentWidth(d.rawName)));
  }

  const rows = data.map((d, i) => [
    d.name,
    d.assignee,
    d.effMin != null ? String(d.effMin) : '',
    String(depths[i] ?? 0),
  ]);
  return { rows, hadHeader, columns, hierarchical: depths.some((d) => d > 0) };
}
