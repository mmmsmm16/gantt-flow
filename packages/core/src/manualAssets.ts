// 手順書（manual）が参照する画像ファイル名の収集。純関数・UI/OS 非依存。
// 保存時 GC（参照分だけ ZIP へ）と MCP write-through（既存 assets を落とさない）で共用する。
import type { Project } from './model/types';

/** project 内の全 StepImage.file（内容ハッシュ由来名）の集合を返す。 */
export function collectReferencedAssetFiles(project: Project): Set<string> {
  const files = new Set<string>();
  for (const doc of Object.values(project.manual.procedures)) {
    for (const step of doc.steps) {
      for (const img of step.images) {
        if (img.file) files.add(img.file);
      }
    }
  }
  return files;
}
