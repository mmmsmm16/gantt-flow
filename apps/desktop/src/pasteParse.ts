// クリップボード（Excel / TSV）貼り付けの列マッピング＋正規化。純粋・決定論・UI 非依存。
// 見出し行があれば列名から [作業名 / 担当 / 工数] を対応付け、無ければ位置（0=名前・1=担当・2=工数）。
// 出力は正規化済みの [name, assignee, effortMinutesStr] 行配列で、store.pasteRowsAsTasks が位置で読む。
//
// 見出し検出は「作業名を含む工程（例: 受注工程）を誤って見出しと判定し、実データ行を落とす」事故を
// 避けるため、部分一致ではなく**セル完全一致の辞書**で行い、かつ担当/工数の構造列が見出しに
// 現れる場合のみ見出しとみなす（データ行にはセル値として「担当」「工数」がまず現れない）。

export type PasteColumnKey = 'name' | 'assignee' | 'effort';

// セル値が完全一致したら見出しとみなすラベル辞書（前後空白は除去して照合）。
const HEADER_LABELS: Record<string, PasteColumnKey> = {
  作業名: 'name', 作業: 'name', 作業内容: 'name', 工程: 'name', 工程名: 'name', タスク: 'name',
  名称: 'name', 項目: 'name', 業務: 'name', 業務内容: 'name', 内容: 'name', ステップ: 'name',
  担当: 'assignee', 担当者: 'assignee', 部門: 'assignee', 部署: 'assignee', 責任者: 'assignee', ロール: 'assignee',
  工数: 'effort', 所要時間: 'effort', 作業時間: 'effort', 時間: 'effort', 所要: 'effort', '工数(h)': 'effort', '工数（h）': 'effort',
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

// 構造列（担当 or 工数）が見出しに現れるときだけ見出し行とみなす（誤検出でデータを落とさない）。
function looksLikeHeader(row: string[]): boolean {
  const keys = row.map((c) => HEADER_LABELS[c.trim()]).filter(Boolean) as PasteColumnKey[];
  return keys.includes('assignee') || keys.includes('effort');
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

export interface PasteParseResult {
  /** 正規化行 [name, assignee, effortMinutesStr]（空名は除外）。 */
  rows: string[][];
  /** 見出し行を検出して落としたか（トーストで利用者に知らせる）。 */
  hadHeader: boolean;
  /** どの列を何に割り当てたか（見出し無しは位置マッピング）。 */
  columns: Partial<Record<PasteColumnKey, number>>;
}

export function parsePastedRows(text: string): PasteParseResult {
  const grid = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.split('\t'));
  while (grid.length && grid[grid.length - 1]!.every((c) => !c.trim())) grid.pop(); // 末尾の空行を除去
  if (!grid.length) return { rows: [], hadHeader: false, columns: {} };

  let columns: Partial<Record<PasteColumnKey, number>>;
  let dataStart = 0;
  let hadHeader = false;
  if (grid.length >= 2 && looksLikeHeader(grid[0]!)) {
    columns = mapHeader(grid[0]!);
    dataStart = 1;
    hadHeader = true;
  } else {
    columns = { name: 0, assignee: 1, effort: 2 }; // 位置マッピング（従来互換＋工数列を追加）
  }

  const rows: string[][] = [];
  for (let i = dataStart; i < grid.length; i++) {
    const r = grid[i]!;
    const name = (r[columns.name ?? 0] ?? '').trim();
    if (!name) continue;
    const assignee = columns.assignee !== undefined ? (r[columns.assignee] ?? '').trim() : '';
    const effMin = columns.effort !== undefined ? parseEffortCell(r[columns.effort] ?? '') : undefined;
    rows.push([name, assignee, effMin != null ? String(effMin) : '']);
  }
  return { rows, hadHeader, columns };
}
