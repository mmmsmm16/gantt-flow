// シナリオ（As-Is / To-Be）のフローを射影して描くための共有ユーティリティ。
// core を射影（lifecycle/担当移動/依存phase反映）→ ビュー保証 → reconcile → tidy。
// 画面3（メインのフロー表示切替・SVG文字列）と画面4（フロー比較・ビュー構造）で共用。
import type { Core, FlowLevelView, ProcessLevel, Project } from '@gantt-flow/core';
import { projectScenarioCore, reconcileProject, ensureLevelView, tidyFlowView, uuid } from '@gantt-flow/core';
import { buildFlowSvg } from './flowSvg';

export interface ScenarioView {
  view: FlowLevelView; // reconcile + tidy 済みのビュー（ノード x/y・レーン・エッジ）
  core: Core; // 射影後の core（担当移動・lifecycle 反映）
  project: Project; // 射影 core を持つ一時 project（buildFlowSvg 等に渡す用）
}

/** 指定シナリオ・粒度の reconcile + tidy 済みビューを返す（全体スコープ）。 */
export function buildScenarioView(
  project: Project,
  phase: 'asis' | 'tobe',
  level: ProcessLevel,
  scopeParentId?: string,
): ScenarioView | null {
  const core = projectScenarioCore(project.core, project.details, phase);
  // To-Be 投影では新設工程(toBe.lifecycle='added')も描きたいので、details の 'added' マーカーを外す
  // （reconcileFlow は 'added' を As-Is 用に除外するため）。As-Is 投影は core 側で既に除外済み。
  let details = project.details;
  if (phase === 'tobe') {
    details = {};
    for (const [id, d] of Object.entries(project.details)) {
      if (d.toBe?.lifecycle === 'added') {
        const { lifecycle: _omit, ...restToBe } = d.toBe;
        details[id] = { ...d, toBe: Object.keys(restToBe).length ? restToBe : undefined };
      } else {
        details[id] = d;
      }
    }
  }
  let tmp: Project = { ...project, core, details, flow: { byLevel: [] } };
  tmp = ensureLevelView(tmp, level, scopeParentId);
  tmp = reconcileProject(tmp, uuid);
  const base = tmp.flow.byLevel.find(
    (v) => v.level === level && (v.scopeParentId ?? undefined) === (scopeParentId ?? undefined),
  );
  if (!base) return null;
  const view = tidyFlowView(core, details, base);
  return { view, core, project: tmp };
}

/** 指定シナリオ・粒度のフロー図 SVG（画面3 のメインペイン用・読み取り専用）。 */
export function buildScenarioFlowSvg(
  project: Project,
  phase: 'asis' | 'tobe',
  level: ProcessLevel,
  scopeParentId?: string,
): string {
  const sv = buildScenarioView(project, phase, level, scopeParentId);
  if (!sv) return '';
  return buildFlowSvg(sv.project, sv.view);
}
