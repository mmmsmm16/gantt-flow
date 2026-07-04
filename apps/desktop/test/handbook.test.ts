// buildHandbookHtml の規範アサーション（node 環境・renderToStaticMarkup 実証パターン: markdownLite.test.tsx）。
// サンプルプロジェクト(createSampleProject)は手順書ダミーデータ入りのため、そのままフィクスチャに使う。
import { describe, it, expect } from 'vitest';
import { createSampleProject, type Project } from '@gantt-flow/core';
import { buildHandbookHtml, type HandbookOptions } from '../src/handbook';

const gen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const NOW = '2026-01-01T00:00:00.000Z';
const opts = (over: Partial<HandbookOptions> = {}): HandbookOptions => ({
  aliases: {},
  assets: {},
  now: NOW,
  ...over,
});

const sample = (): Project => createSampleProject(gen('h'));

const hasChildren = (project: Project, id: string): boolean =>
  Object.values(project.core.tasks).some((t) => (t.parentId ?? undefined) === id);
const leavesOf = (project: Project) => Object.values(project.core.tasks).filter((t) => !hasChildren(project, t.id));
const taskByName = (project: Project, name: string) => Object.values(project.core.tasks).find((t) => t.name === name)!;

describe('buildHandbookHtml', () => {
  it('自己完結: <script>/<link> 無し・style に url() 無し・http(s) href は台帳の場所表記のみ', () => {
    const html = buildHandbookHtml(sample(), opts());

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link ');
    // url(...) は SVG の marker-end="url(#a)" 等、文書内フラグメント参照でのみ使う（外部参照は禁止）。
    expect(html).not.toMatch(/url\(['"]?https?:/);

    // src="..." が現れるならすべて data: (画像 = data URI 以外は禁止)。
    const srcs = [...html.matchAll(/\bsrc="([^"]*)"/g)].map((m) => m[1] ?? '');
    for (const s of srcs) expect(s.startsWith('data:')).toBe(true);

    // http(s) の href は「欠品時対応マニュアル」(url ロケータの資料) のみ許可。
    // 出現箇所は 2 つ: 本文のステップ参照チップ(M3)・末尾の資料台帳一覧。
    const httpHrefs = [...html.matchAll(/href="(https?:[^"]*)"/g)].map((m) => m[1]);
    expect(httpHrefs).toEqual([
      'https://wiki.example.local/manuals/shortage-handling',
      'https://wiki.example.local/manuals/shortage-handling',
    ]);
  });

  it('画像は data:image/ の src になる（サンプルは画像を同梱しないため 1 件手で仕込む）', () => {
    const project = sample();
    const m2 = taskByName(project, '与信確認');
    project.manual.procedures[m2.id]!.steps[0]!.images.push({
      id: 'img-1',
      file: 'abc123.png',
      caption: '確認画面のスクリーンショット',
    });
    const html = buildHandbookHtml(project, opts({ assets: { 'abc123.png': new Uint8Array([1, 2, 3, 4]) } }));
    expect(html).toContain('src="data:image/png;base64,AQIDBA=="');
    expect(html).toContain('確認画面のスクリーンショット');
  });

  it('全末端工程の名前・action文・**太字**の<strong>化・条件飛び先アンカー・資料名・未作成表記が出る', () => {
    const project = sample();
    const html = buildHandbookHtml(project, opts());

    for (const leaf of leavesOf(project)) {
      expect(html).toContain(leaf.name);
    }
    expect(html).toContain('注文書の受信経路を確認する'); // 手順書あり(S1)の action 文
    expect(html).toContain('<strong>FAX</strong>'); // bodyMd の **太字** → <strong>

    const m2 = taskByName(project, '与信確認');
    expect(html).toContain(`href="#hb-task-${m2.id}"`); // S1 step2 の cond 飛び先(→与信確認)

    expect(html).toContain('注文書様式一覧');
    expect(html).toContain('与信確認チェックリスト');
    expect(html).toContain('欠品時対応マニュアル');

    // 12 末端のうち手順書ありは 3 件(注文書受領/与信確認/在庫引当)のみ＝残りは「未作成」表記。
    const noProcCount = (html.match(/（手順書未作成）/g) ?? []).length;
    expect(noProcCount).toBe(leavesOf(project).length - 3);
  });

  it('alias 解決: aliases={} なら alias/relPath 表記のまま(disconnected)、対応表を渡すと実パス結合が出る', () => {
    const project = sample();
    const disconnected = buildHandbookHtml(project, opts());
    expect(disconnected).toContain('営業共有/受注/注文書様式一覧.xlsx');

    const resolved = buildHandbookHtml(project, opts({ aliases: { 営業共有: '/mnt/shared/sales' } }));
    expect(resolved).toContain('/mnt/shared/sales/受注/注文書様式一覧.xlsx');
    expect(resolved).not.toContain('営業共有/受注/注文書様式一覧.xlsx');
  });

  it('ダングリング ref（存在しない assetId）は「リンク切れ」表記になり throw しない', () => {
    const project = sample();
    const s1 = taskByName(project, '注文書受領');
    project.manual.procedures[s1.id]!.steps[0]!.refs.push({ kind: 'asset', assetId: 'no-such-asset' });

    let html = '';
    expect(() => {
      html = buildHandbookHtml(project, opts());
    }).not.toThrow();
    expect(html).toContain('リンク切れ');
  });

  it('エスケープ: 工程名に <img onerror> を仕込んでもタグとして出力されない', () => {
    const project = sample();
    const s1 = taskByName(project, '注文書受領');
    s1.name = '<img src=x onerror=alert(1)>危険工程';
    const html = buildHandbookHtml(project, opts());
    expect(html).not.toContain('<img src=x onerror');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;危険工程');
  });

  it('フロー図: タスクノードのあるレベル/スコープの数ぶん <svg が出る', () => {
    const project = sample();
    const html = buildHandbookHtml(project, opts());
    const expectedCards = project.flow.byLevel.filter((v) => Object.values(v.nodes).some((n) => n.kind === 'task'))
      .length;
    expect(expectedCards).toBe(2); // サンプル = 大(全体)・中(受注業務スコープ)のみノードあり

    // decorateFlowSvg は元図(buildFlowSvg)を入れ子 <svg> として埋め込むため、1 カードにつき <svg が 2 個。
    const svgCount = (html.match(/<svg[ >]/g) ?? []).length;
    expect(svgCount).toBe(expectedCards * 2);
  });

  it('決定論: 同一入力＋固定 now なら同一文字列', () => {
    const project = sample();
    const a = buildHandbookHtml(project, opts());
    const b = buildHandbookHtml(project, opts());
    expect(a).toBe(b);
  });
});
