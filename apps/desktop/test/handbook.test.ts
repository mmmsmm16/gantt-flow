// buildHandbookHtml の規範アサーション（node 環境・renderToStaticMarkup 実証パターン: markdownLite.test.tsx）。
// サンプルプロジェクト(createSampleProject)は手順書ダミーデータ入りのため、そのままフィクスチャに使う。
import { describe, it, expect } from 'vitest';
import {
  createSampleProject,
  addTask,
  addDependency,
  addStep,
  addStepCond,
  ensureLevelView,
  reconcileProject,
  type Project,
} from '@gantt-flow/core';
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

// レビュー指摘(デッドアンカー)の再現フィクスチャ: 大→中→小(非末端・詳細を子に持つ)→詳細 の 4 階層。
// アンカーは「大工程・大直下の中工程・末端工程」にしか振られないため、非末端の「小」は文書内のどこにも
// id="hb-task-..." を持たない。この「小」を条件飛び先(targetTaskId)に指定して壊れ方を固定する。
function fourLevelFixture(): { project: Project; largeId: string; midId: string; smallId: string; detailId: string } {
  const idGen = gen('t');
  let p: Project = {
    schemaVersion: 2,
    meta: { id: 'p4', title: '4階層テスト', createdAt: NOW, updatedAt: NOW, appVersion: '0' },
    core: { tasks: {}, dependencies: {}, assignees: {} },
    details: {},
    flow: { byLevel: [] },
    manual: { procedures: {}, assets: {} },
  };
  const largeId = 't-large';
  const midId = 't-mid';
  const smallId = 't-small';
  const detailId = 't-detail';
  p = addTask(p, { name: '大工程', level: 'large', id: largeId }, idGen);
  p = addTask(p, { name: '中工程', level: 'medium', parentId: largeId, id: midId }, idGen);
  p = addTask(p, { name: '小工程(非末端)', level: 'small', parentId: midId, id: smallId }, idGen);
  p = addTask(p, { name: '詳細工程', level: 'detail', parentId: smallId, id: detailId }, idGen);
  p = addStep(p, detailId, { action: '何かする' }, idGen, NOW);
  const stepId = p.manual.procedures[detailId]!.steps[0]!.id;
  p = addStepCond(
    p,
    detailId,
    stepId,
    { when: '異常時', thenMd: '対処する', targetTaskId: smallId },
    idGen,
    NOW,
  );
  return { project: p, largeId, midId, smallId, detailId };
}

// 汎用アサーション: 文書内の href="#..." がすべて実在する id="..." を指すことを機械的に検証する
// （デッドアンカー再発防止のため、フィクスチャ横断で使う）。
function assertAllFragmentLinksResolve(html: string): void {
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]!);
  for (const h of hrefs) {
    expect(ids.has(h)).toBe(true);
  }
}

describe('buildHandbookHtml', () => {
  it('自己完結: src 付き<script>/<link> 無し・style に url() 無し・http(s) href は台帳の場所表記のみ（インライン JS は可）', () => {
    const html = buildHandbookHtml(sample(), opts());

    // インライン <script> は許可（検索/フィルタ/現在地/折りたたみ/drawer）。外部参照＝src 付き script/link は禁止。
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
    expect(html).not.toContain('<link ');
    expect(html).toContain('<script>'); // インライン JS を同梱している（自己完結の中で完結）
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

  it('業務ポータルのシェル: サイドバー・検索・担当フィルタ・現在地目次・折りたたみ・drawer のマークアップが出る', () => {
    const html = buildHandbookHtml(sample(), opts());

    expect(html).toContain('class="hb-side"'); // 固定サイドバー
    expect(html).toContain('id="hb-search"'); // 工程検索
    expect(html).toContain('id="hb-chips"'); // 担当フィルタ群
    expect(html).toContain('data-all'); // 「全て」チップ
    expect(html).toContain('class="hb-toc-link hb-mnode"'); // 現在地ハイライト対象＝縦フローナビの箱
    expect(html).toContain('class="hb-chap-head"'); // 章の折りたたみヘッダ
    expect(html).toContain('id="hb-scrim"'); // モバイル drawer 用スクリム
    expect(html).toContain('data-anchor="hb-task-'); // 現在地スパイ用アンカー

    // 担当フィルタのチップに実在の担当が全て出る（サンプル = 営業部/経理部/在庫管理/倉庫）。
    expect(html).toContain('data-assignee="営業部"');
    expect(html).toContain('data-assignee="経理部"');
    expect(html).toContain('data-assignee="在庫管理"');
    expect(html).toContain('data-assignee="倉庫"');
  });

  it('担当フィルタ: 「非表示/淡色表示」トグルが出て、既定は非表示（非該当カードは display:none）', () => {
    const html = buildHandbookHtml(sample(), opts());

    // 表示方法トグルの UI（担当が 1 件以上あるサンプルでは必ず出る）。
    expect(html).toContain('id="hb-fmode"');
    expect(html).toContain('data-mode="hide"');
    expect(html).toContain('data-mode="dim"');
    // 既定は「非表示」ボタンが選択状態（is-on / aria-pressed="true"）。
    expect(html).toContain('class="hb-fmode-btn is-on" data-mode="hide" aria-pressed="true"');

    // 非該当カード・目次リンクは display:none で消える CSS が入る（淡色 .dim とは別クラス）。
    expect(html).toContain('.hb-proc.f-hide{display:none;}');
    expect(html).toContain('.hb-toc-link.f-hide{display:none;}');

    // JS の既定モードは非表示（hideMode=true）で、フィルタは f-hide を付け外しする。
    expect(html).toContain('var hideMode=true');
    expect(html).toContain("toggle('f-hide',hideMode&&!on)");
  });

  it('サイドバーの縦フローナビ: 手順書タブと同じ「箱＋縦の連結線」（.hb-mflow/.hb-mnode/.hb-mlink）で中工程が並ぶ', () => {
    const project = sample();
    const html = buildHandbookHtml(project, opts());

    // 大工程ごとに .hb-mflow（縦フロー）があり、中工程は .hb-mnode（箱）、箱同士は .hb-mlink（縦線）で繋がる。
    expect(html).toContain('class="hb-mflow"');
    expect(html).toContain('class="hb-mlink"');
    // 箱の中身: コード・名前・作成済み ✓/未作成 — が出る（サンプルは 3 件作成済み・7 件未作成）。
    expect((html.match(/class="hb-toc-link hb-mnode(?: todo)?"/g) ?? []).length).toBe(10); // 全中工程 10 件
    expect((html.match(/<span class="cov ok">✓<\/span>/g) ?? []).length).toBe(3);
    expect((html.match(/<span class="cov none">—<\/span>/g) ?? []).length).toBe(7);
    // 未作成の箱は .todo（破線）になる。
    expect((html.match(/class="hb-toc-link hb-mnode todo"/g) ?? []).length).toBe(7);
    // 箱同士の連結線は「大工程内の中工程数 - 1」本ずつ（受注 4→3・出荷 4→3・請求 2→1 = 7 本）。
    expect((html.match(/class="hb-mlink"/g) ?? []).length).toBe(7);
  });

  it('サイドバーの∥並行バッジ: 同一 layer の中工程が複数あるときだけ表示される（分岐フィクスチャ）', () => {
    const idGen = (() => {
      let n = 0;
      return () => `par-${++n}`;
    })();
    const largeId = 'par-large';
    const m1 = 'par-m1';
    const m2 = 'par-m2';
    const m3 = 'par-m3';
    let p: Project = {
      schemaVersion: 2,
      meta: { id: 'ppar', title: '並行テスト', createdAt: NOW, updatedAt: NOW, appVersion: '0' },
      core: { tasks: {}, dependencies: {}, assignees: {} },
      details: {},
      flow: { byLevel: [] },
      manual: { procedures: {}, assets: {} },
    };
    p = addTask(p, { name: '大工程', level: 'large', id: largeId }, idGen);
    p = addTask(p, { name: '起点工程', level: 'medium', parentId: largeId, id: m1 }, idGen);
    p = addTask(p, { name: '並行工程A', level: 'medium', parentId: largeId, id: m2 }, idGen);
    p = addTask(p, { name: '並行工程B', level: 'medium', parentId: largeId, id: m3 }, idGen);
    p = addDependency(p, m1, m2, idGen);
    p = addDependency(p, m1, m3, idGen);

    const html = buildHandbookHtml(p, opts());
    // 起点(m1)は並行なし・並行工程A/Bは同一 layer なので ∥並行 バッジが 2 件だけ出る。
    expect((html.match(/∥並行/g) ?? []).length).toBe(2);
    const m1Box = html.slice(html.indexOf(`href="#hb-task-${m1}"`), html.indexOf(`href="#hb-task-${m2}"`));
    expect(m1Box).not.toContain('∥並行');
  });

  it('担当フィルタ: data-assignee 属性のユーザ文字列はエスケープされる（属性経由の XSS 防止）', () => {
    const project = sample();
    const sales = Object.values(project.core.assignees).find((a) => a.name === '営業部')!;
    sales.name = '"><img onerror=alert(1)>営業';
    const html = buildHandbookHtml(project, opts());

    // 生タグとして注入されない。
    expect(html).not.toContain('<img onerror=alert(1)>');
    // data-* 属性値は escapeHtml 経由（" > < がエンティティ化される）。
    expect(html).toContain('data-assignee="&quot;&gt;&lt;img onerror=alert(1)&gt;営業"');
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

  it('検索対象の拡大: 各カードの data-search にステップ本文・条件・資料名が連結される（工程名の外まで）', () => {
    const project = sample();
    const html = buildHandbookHtml(project, opts());

    const searchAttrs = [...html.matchAll(/data-search="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(searchAttrs.length).toBeGreaterThan(0);
    // 工程名やコードには無い「ステップ本文(bodyMd の **FAX**)」が検索テキストに入る。
    expect(searchAttrs.some((s) => s.includes('FAX'))).toBe(true);
    // 参照資料名（asset ラベル）も検索対象に含まれる。
    expect(searchAttrs.some((s) => s.includes('欠品時対応マニュアル'))).toBe(true);
    // 検索スクリプトは data-search と Enter ジャンプを実装している。
    expect(html).toContain("card.getAttribute('data-search')");
    expect(html).toContain("if(e.key!=='Enter') return;");
  });

  it('検索用 data-search はエスケープされる（属性経由の XSS 防止）', () => {
    const project = sample();
    const s1 = taskByName(project, '注文書受領');
    project.manual.procedures[s1.id]!.steps[0]!.action = '"><img onerror=alert(1)>危険手順';
    const html = buildHandbookHtml(project, opts());

    // 生タグとして注入されない。
    expect(html).not.toContain('<img onerror=alert(1)>');
    // data-search 属性値には生の < > " が現れない（全て escapeHtml 済み）。
    const searchAttrs = [...html.matchAll(/data-search="([^"]*)"/g)].map((m) => m[1] ?? '');
    for (const s of searchAttrs) {
      expect(s.includes('<')).toBe(false);
      expect(s.includes('>')).toBe(false);
    }
    // エスケープ済みの本文が検索テキストへ入っている。
    expect(searchAttrs.some((s) => s.includes('危険手順'))).toBe(true);
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

  it('フロー図: タスクノードのあるレベル/スコープ(スコープなし)の数ぶん <svg が出る', () => {
    const project = sample();
    const html = buildHandbookHtml(project, opts());
    const expectedCards = project.flow.byLevel.filter(
      (v) => !v.scopeParentId && Object.values(v.nodes).some((n) => n.kind === 'task'),
    ).length;
    expect(expectedCards).toBe(1); // サンプル = 大(全体)のみ（中は受注業務スコープなので除外）

    // フロー図はフローセクション内にのみ出る（サイドバーの装飾アイコン SVG と混ざらないよう範囲を絞る）。
    const flowsHtml = html.slice(html.indexOf('id="hb-flows"'), html.indexOf('class="hb-main-body"'));
    // decorateFlowSvg は元図(buildFlowSvg)を入れ子 <svg> として埋め込むため、1 カードにつき <svg が 2 個。
    const svgCount = (flowsHtml.match(/<svg[ >]/g) ?? []).length;
    expect(svgCount).toBe(expectedCards * 2);
  });

  it('フロー図: スコープ付きビュー（scopeParentId あり）は本文に出ない、スコープ名表記も出ない', () => {
    let project = sample();
    // スコープ付きビュー（受注業務）を手動で作成＋追加。
    // 既存ビューをクローンしてスコープパラメータを差し替え。
    const largeTaskId = Object.values(project.core.tasks).find((t) => !t.parentId && t.level === 'large')!.id;
    const midTaskId = Object.values(project.core.tasks).find((t) => t.parentId === largeTaskId && t.level === 'medium')!.id;
    const scopedView = JSON.parse(JSON.stringify(project.flow.byLevel[0])); // 浅い複製で充分
    scopedView.id = `view-scoped-${midTaskId}`;
    scopedView.scopeParentId = midTaskId;
    project.flow.byLevel.push(scopedView);

    const html = buildHandbookHtml(project, opts());

    // フロー図セクション内でのみチェック（他セクションと混ぶため）。
    const flowsHtml = html.slice(html.indexOf('id="hb-flows"'), html.indexOf('class="hb-main-body"'));

    // スコープなしビューのみカウント（修正後は scopeParentId がないもののみ出るはず）。
    const scopelessViews = project.flow.byLevel.filter(
      (v) => !v.scopeParentId && Object.values(v.nodes).some((n) => n.kind === 'task'),
    );
    const expectedFigures = scopelessViews.length;
    // <figcaption> がカード数分出る。
    const figCount = (flowsHtml.match(/<figcaption class="hb-fig-cap">/g) ?? []).length;
    expect(figCount).toBe(expectedFigures);

    // スコープ親タスク（受注業務）の名前がフロー図キャプションに出ない
    // （修正前は「（受注業務）」のようなスコープ名が label に混ざるはず）。
    const midTaskName = project.core.tasks[midTaskId]!.name;
    const scopeNameInFigcaption = flowsHtml.includes(`（${midTaskName}）`);
    expect(scopeNameInFigcaption).toBe(false);
  });

  it('印刷: 業務フロー図(.hb-fig-scroll)に @media print の紙幅フィット規則が入る（右端の見切れ防止）', () => {
    const html = buildHandbookHtml(sample(), opts());
    // @media print ブロック内に、横スクロールを解除して紙幅に SVG を収める規則があること。
    const printBlock = html.slice(html.indexOf('@media print{'), html.indexOf('</style>'));
    expect(printBlock).toContain('.hb-fig-scroll{overflow:visible;}');
    expect(printBlock).toContain('.hb-fig-scroll svg{max-width:100%;height:auto;}');
  });

  it('決定論: 同一入力＋固定 now なら同一文字列', () => {
    const project = sample();
    const a = buildHandbookHtml(project, opts());
    const b = buildHandbookHtml(project, opts());
    expect(a).toBe(b);
  });

  it('href="#..." はすべて実在する id を指す(サンプル)', () => {
    const html = buildHandbookHtml(sample(), opts());
    assertAllFragmentLinksResolve(html);
  });

  it('デッドアンカー: 非末端(小)への条件飛び先はリンク化されずプレーンテキスト表記になる（レビュー指摘の再現形）', () => {
    const { project, smallId } = fourLevelFixture();
    const html = buildHandbookHtml(project, opts());

    // 「小」はアンカー(id="hb-task-...")を持たない章立てのため、対応する href は出ない。
    expect(html).not.toContain(`href="#hb-task-${smallId}"`);
    // ただし工程は実在するので、名前はプレーンテキストとして表示される（消えない）。
    expect(html).toContain('小工程(非末端)');
    // 実在する工程なので「リンク切れ」表記にもしない。
    expect(html).not.toContain('リンク切れ');
    // 文書内の #アンカー欠落（dangling href）が無いことを機械的に検証する。
    assertAllFragmentLinksResolve(html);
  });

  describe('フロー上の位置（各中工程セクション冒頭のハイライト図）', () => {
    it('中レベルの全スコープビューが無いプロジェクト(サンプル既定)では .hb-pos を出さない', () => {
      // createSampleProject の既定ビューは「中(スコープ=受注業務)」「大(全体)」のみで、
      // level='medium' かつ scopeParentId 無しのビューは無い（フォールバックで throw しない）。
      const html = buildHandbookHtml(sample(), opts());
      expect(html).not.toContain('class="hb-pos"');
    });

    it('全スコープ中ビューがあれば各中工程セクション冒頭に .hb-pos が出て、対象工程だけアクセント太枠になる', () => {
      const idGen = gen('view');
      let project = sample();
      project = ensureLevelView(project, 'medium'); // scopeParentId 無しの全スコープ中ビューを追加
      project = reconcileProject(project, idGen); // 全中工程ぶんのノードを配置

      const html = buildHandbookHtml(project, opts());

      // 全中工程 10 件ぶん(既存テスト同数)の位置カードが出る。
      const posCount = (html.match(/class="hb-pos"/g) ?? []).length;
      expect(posCount).toBe(10);
      expect((html.match(/class="hb-pos-cap">フロー上の位置</g) ?? []).length).toBe(10);

      // サンプルに milestone 工程は無いため、各カードは自身の中工程 1 件だけをハイライトする
      // （アクセント太枠の出現回数の総和が中工程数と一致＝章の工程数と整合）。
      const accentCount = (html.match(/stroke="#0e6f6a" stroke-width="2.5"/g) ?? []).length;
      expect(accentCount).toBe(10);
      // ハロー・減光もどこかに出る(ハイライト機能が実際に効いている)。
      expect(html).toContain('rgba(14,111,106');
      expect(html).toContain('opacity="0.4"');
    });

    it('全スコープ中ビューはあるがノード0件のプロジェクトでも .hb-pos を出さない(throw しない)', () => {
      const idGen = gen('view0');
      let project = sample();
      project = ensureLevelView(project, 'medium'); // ノード0件のまま(reconcile しない)
      expect(() => buildHandbookHtml(project, opts())).not.toThrow();
      const html = buildHandbookHtml(project, opts());
      expect(html).not.toContain('class="hb-pos"');
    });
  });
});
