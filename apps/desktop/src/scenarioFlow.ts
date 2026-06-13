// シナリオ（As-Is / To-Be）のフロー図 SVG を生成する共有ユーティリティ。
// core を射影（lifecycle/担当移動/依存phase反映）→ ビュー保証 → reconcile → tidy →
// 既存 buildFlowSvg。画面3（メインのフロー表示切替）と画面4（フロー比較）で共用。読み取り専用。
import type { ProcessLevel, Project } from '@gantt-flow/core';
import { projectScenarioCore, reconcileProject, ensureLevelView, tidyFlowView, uuid } from '@gantt-flow/core';
import { buildFlowSvg } from './flowSvg';

export function buildScenarioFlowSvg(
  project: Project,
  phase: 'asis' | 'tobe',
  level: ProcessLevel,
  scopeParentId?: string,
): string {
  const core = projectScenarioCore(project.core, project.details, phase);
  let tmp: Project = { ...project, core, flow: { byLevel: [] } };
  tmp = ensureLevelView(tmp, level, scopeParentId);
  tmp = reconcileProject(tmp, uuid);
  const base = tmp.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );
  if (!base) return '';
  const view = tidyFlowView(core, project.details, base);
  return buildFlowSvg(tmp, view);
}
