// buildImprovementReportHtml の規範アサーション（node 環境・純関数）。
// KPI 含有・XSS エスケープ・自己完結（<script>/外部 URL 不在）・印刷/SVG の体裁を固定する。
import { describe, it, expect } from 'vitest';
import { createSampleProject, updateTaskToBe, type Project } from '@gantt-flow/core';
import { buildImprovementReportHtml } from '../src/reportHtml';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const NOW = '2026-07-05T00:00:00.000Z';

// To-Be を数件入れて KPI が ±0 でなく差分を持つサンプルにする。
function withToBe(): Project {
  const base = createSampleProject(gen('rep'));
  const leaves = Object.values(base.core.tasks).filter(
    (t) => !Object.values(base.core.tasks).some((c) => c.parentId === t.id),
  );
  let p = base;
  const a = leaves[0];
  if (a) p = updateTaskToBe(p, a.id, { effortMinutes: 10, ltDays: 1, difficulty: 'L', automation: 'system' });
  return p;
}

describe('buildImprovementReportHtml', () => {
  it('KPI 4 指標の見出しと出力日・タイトルを含む', () => {
    const html = buildImprovementReportHtml(withToBe(), { now: NOW });
    expect(html).toContain('改善効果レポート');
    expect(html).toContain('工数');
    expect(html).toContain('リードタイム');
    expect(html).toContain('待ち時間');
    expect(html).toContain('自動化率');
    expect(html).toContain('2026-07-05'); // 出力日
    expect(html).toContain('担当別の工数');
    expect(html).toContain('工程別の差分');
  });

  it('自己完結: <script> と外部 URL（href="http）を一切含まない', () => {
    const html = buildImprovementReportHtml(withToBe(), { now: NOW });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="http');
    expect(html).not.toContain('src="http');
  });

  it('@media print（A4 縦）と静的 SVG バーを含む', () => {
    const html = buildImprovementReportHtml(withToBe(), { now: NOW });
    expect(html).toContain('@media print');
    expect(html).toContain('A4 portrait');
    expect(html).toContain('<svg');
    expect(html).toContain('break-inside:avoid');
  });

  it('XSS: プロジェクト名の <img onerror> はエスケープされ生タグにならない', () => {
    const base = createSampleProject(gen('xss'));
    const evil: Project = { ...base, meta: { ...base.meta, title: '<img src=x onerror=alert(1)>' } };
    const html = buildImprovementReportHtml(evil, { now: NOW });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('工程名の <script> 混入（工程別差分の行）もエスケープされる', () => {
    const base = createSampleProject(gen('xss2'));
    // 工数を持つ末端工程＝工程別差分の表に必ず出る行の工程名へ混入させる。
    const leaf = Object.values(base.core.tasks).find(
      (t) => !Object.values(base.core.tasks).some((c) => c.parentId === t.id) && (base.details[t.id]?.effortMinutes ?? 0) > 0,
    )!;
    const evil: Project = {
      ...base,
      core: {
        ...base.core,
        tasks: { ...base.core.tasks, [leaf.id]: { ...leaf, name: '<script>bad()</script>' } },
      },
    };
    const html = buildImprovementReportHtml(evil, { now: NOW });
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
  });
});
