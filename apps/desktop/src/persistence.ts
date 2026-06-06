// フロントの保存/開く。現状はブラウザ（ダウンロード/アップロード）。
// 将来 Tauri 配下では window.__TAURI__ 経由でローカルファイルへアトミック保存に差し替える。
import { serializeProject, deserializeProject, type Project } from '@gantt-flow/core';

const safeName = (title: string) =>
  (title.trim() || 'project').replace(/[^\w\-一-龠ぁ-んァ-ヶ。、ー]/g, '_');

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
