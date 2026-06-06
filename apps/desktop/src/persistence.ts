// フロントの保存/開く/取り込み/出力。現状はブラウザ（ダウンロード/アップロード）。
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

// 保存: JSON をダウンロード（拡張子 .json）。
export function saveProjectToFile(project: Project): void {
  const blob = new Blob([serializeProject(project)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName(project.meta.title)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- 出力（Phase4） ----
export function exportCsvFile(project: Project): void {
  download(`${safeName(project.meta.title)}.csv`, '﻿' + projectToCsv(project), 'text/csv;charset=utf-8');
}

export function exportExcelFile(project: Project): void {
  const ws = XLSX.utils.aoa_to_sheet(projectToRows(project));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '工程表');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  download(`${safeName(project.meta.title)}.xlsx`, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

export function exportSvgFile(project: Project, view: FlowLevelView): void {
  download(`${safeName(project.meta.title)}-flow.svg`, buildFlowSvg(project, view), 'image/svg+xml');
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

// 開く: <input type=file> で選んだファイルを読み、検証して Project にする。
export function openProjectFromFile(): Promise<Project | null> {
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
        resolve(deserializeProject(text)); // 不正なら throw（Zod）
      } catch (err) {
        reject(err);
      }
    };
    input.click();
  });
}
