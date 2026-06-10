// フロントの保存/開く/取り込み/出力。
// 保存はまず File System Access API（showSaveFilePicker）で「同一ファイルへ上書き」を試み、
// ハンドルを覚えておく＝2 回目以降はダイアログ無しで上書き。非対応ブラウザはダウンロードにフォールバック。
// 将来 Tauri 配下では window.__TAURI__ 経由でローカルファイルへアトミック保存に差し替える。
import * as XLSX from 'xlsx';
import {
  serializeProject,
  deserializeProject,
  projectToRows,
  projectToCsv,
  type Project,
  type FlowLevelView,
} from '@gantt-flow/core';
import { buildFlowSvg } from './flowSvg';

// File System Access API は一部ブラウザのみ。lib.dom に未収録のため使う範囲だけ最小宣言する
//（既存の lib 型と衝突しないよう独自名で定義）。
interface FsWritable {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}
interface FsFileHandle {
  readonly name: string;
  createWritable(): Promise<FsWritable>;
  getFile(): Promise<File>;
}
interface FsPickerType {
  description?: string;
  accept: Record<string, string[]>;
}
declare global {
  interface Window {
    showSaveFilePicker?: (opts?: {
      suggestedName?: string;
      types?: FsPickerType[];
    }) => Promise<FsFileHandle>;
    showOpenFilePicker?: (opts?: {
      types?: FsPickerType[];
      multiple?: boolean;
    }) => Promise<FsFileHandle[]>;
  }
}

const JSON_TYPES: FsPickerType[] = [
  { description: 'gantt-flow プロジェクト', accept: { 'application/json': ['.json'] } },
];

// 開いている/保存先のファイルハンドル（File System Access API 対応時のみ）。
// これがあると次回の保存はダイアログ無しで同じファイルへ上書きする。
let fileHandle: FsFileHandle | null = null;

export function hasFileHandle(): boolean {
  return fileHandle !== null;
}
export function currentFileName(): string | null {
  return fileHandle?.name ?? null;
}
/** 新規/取り込み等で「保存先を忘れる」（次の保存でピッカーを出す）。 */
export function forgetFileHandle(): void {
  fileHandle = null;
}

const fsSupported = (): boolean =>
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

const isAbort = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

const safeName = (title: string) =>
  (title.trim() || 'project').replace(/[^\w\-一-龠ぁ-んァ-ヶ。、ー]/g, '_');

function download(name: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// 保存: File System Access 対応なら同一ファイルへ上書き（初回 / saveAs はピッカー）。
// 戻り値はファイル名。ユーザーがピッカーをキャンセルしたら null（呼び出し側は何もしない）。
// 非対応ブラウザは従来どおりダウンロード（拡張子 .json）。
export async function saveProjectToFile(
  project: Project,
  opts: { saveAs?: boolean } = {},
): Promise<string | null> {
  const json = serializeProject(project);
  const suggested = `${safeName(project.meta.title)}.json`;
  if (fsSupported()) {
    try {
      if (!fileHandle || opts.saveAs) {
        fileHandle = await window.showSaveFilePicker!({
          suggestedName: suggested,
          types: JSON_TYPES,
        });
      }
      const w = await fileHandle.createWritable();
      await w.write(json);
      await w.close();
      return fileHandle.name;
    } catch (err) {
      if (isAbort(err)) return null; // ユーザーがキャンセル
      // それ以外の失敗（権限など）はダウンロードにフォールバック
    }
  }
  download(suggested, json, 'application/json');
  return suggested;
}

// ---- 出力（Phase4） ----
export function exportCsvFile(project: Project): string {
  const name = `${safeName(project.meta.title)}.csv`;
  download(name, '﻿' + projectToCsv(project), 'text/csv;charset=utf-8');
  return name;
}

export function exportExcelFile(project: Project): string {
  const name = `${safeName(project.meta.title)}.xlsx`;
  const ws = XLSX.utils.aoa_to_sheet(projectToRows(project));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '工程表');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  download(name, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return name;
}

export function exportSvgFile(project: Project, view: FlowLevelView): string {
  const name = `${safeName(project.meta.title)}-flow.svg`;
  download(name, buildFlowSvg(project, view), 'image/svg+xml');
  return name;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 印刷 / PDF: 工程表（全項目）＋現在のフロー図を 1 枚の印刷用 HTML にまとめ、
// 隠し iframe で印刷ダイアログを出す（ブラウザの「PDF として保存」で PDF 化できる）。
// ポップアップブロックを避けるため window.open ではなく iframe を使う。
export function printProjectAndFlow(project: Project, view: FlowLevelView | undefined): void {
  const title = project.meta.title || 'プロジェクト';
  const rows = projectToRows(project);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const thead = `<tr>${header.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const tbody = body
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('');
  const svg = view ? buildFlowSvg(project, view) : '';
  const today = new Date().toISOString().slice(0, 10);
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", Meiryo, sans-serif; color: #1a1a1a; margin: 16mm; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { color: #666; font-size: 11px; margin-bottom: 14px; }
  h2 { font-size: 13px; margin: 18px 0 6px; border-bottom: 2px solid #333; padding-bottom: 2px; }
  table { border-collapse: collapse; width: 100%; font-size: 10px; table-layout: fixed; }
  th, td { border: 1px solid #bbb; padding: 3px 5px; text-align: left; vertical-align: top; word-break: break-word; }
  th { background: #f0f0f0; }
  .figure { margin-top: 6px; }
  .figure svg { max-width: 100%; height: auto; }
  @media print { @page { size: A4 landscape; margin: 12mm; } h2 { break-before: page; } h2:first-of-type { break-before: auto; } }
</style></head><body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">工程表・業務フロー図 / 出力日: ${today}</div>
  <h2>工程表（手順一覧表）</h2>
  <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
  ${svg ? `<h2>業務フロー図</h2><div class="figure">${svg}</div>` : ''}
</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  Object.assign(iframe.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
    setTimeout(() => iframe.remove(), 1000); // 印刷ダイアログ後に後片付け
  };
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow?.document;
  if (!doc) {
    iframe.remove();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
}

// ---- 取り込み（Excel → 行列） ----
export async function readTableFile(file: File): Promise<string[][]> {
  if (file.name.toLowerCase().endsWith('.csv')) {
    const text = await file.text();
    return text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.split(','));
  }
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '' });
  return rows.map((r) => r.map((c) => String(c ?? '')));
}

// 開く: File System Access 対応ならピッカーでハンドルを取得（以後の保存は上書き）。
// 非対応ブラウザは <input type=file>。不正なファイルは throw（Zod）。
export async function openProjectFromFile(): Promise<Project | null> {
  if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
    let handles: FsFileHandle[];
    try {
      handles = await window.showOpenFilePicker({ types: JSON_TYPES, multiple: false });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
    const handle = handles[0];
    if (!handle) return null;
    const file = await handle.getFile();
    const project = deserializeProject(await file.text()); // 不正なら throw
    fileHandle = handle; // 検証成功後にだけ保存先として採用
    return project;
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        const text = await file.text();
        const project = deserializeProject(text); // 不正なら throw（Zod）
        fileHandle = null; // input 経由は上書き不可（毎回ダウンロード保存）
        resolve(project);
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}
