// ハンドブック（HTML）出力の生成器。純関数・副作用ゼロ（DOM/localStorage/store に一切触れない）。
// 画面=業務ポータル（固定サイドバー・工程検索・担当フィルタ・現在地・折りたたみ・モバイル drawer）、
// 紙=@media print で冊子体裁へ変形（サイドバー等の画面 UI を落とし、明朝組版の章立てにする）。
// 表現層のハイブリッド化: 構造は案B、見出しの明朝組版・条件分岐の朱書き・印刷組版は案A から移植
// （spec: docs/superpowers/plans/2026-07-05-handbook-export.md Task 4）。
// 出力は常にライトテーマ・自己完結（外部 URL 参照ゼロ・`<script src>` 禁止・画像は data URI）。
// インライン JS は許可するが、ユーザ文字列は JS リテラルに埋めない: 検索/フィルタ/現在地は
// DOM の textContent・data-* 属性から読み、data-* も escapeHtml 経由（XSS 規律を維持）。
// 場所エイリアス解決(aliases)・画像バイト(assets)は呼び出し側が渡す（core/localStorage/assetStore の
// セッションメモリを直接読まない＝node 環境でもゴールデンテストできる）。
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  Project,
  Id,
  Core,
  Manual,
  ProcessTask,
  StepRef,
  StepCond,
  StepImage,
  ProcedureStep,
  ProcedureNavItem,
  FlowLevelView,
} from '@gantt-flow/core';
import { computeCodes, deriveProcedureNav } from '@gantt-flow/core';
import { buildFlowSvg, decorateFlowSvg } from './flowSvg';
import { resolveLocator, type ResolvedLocator } from './locationAliases';
import { isLeaf, ancestorsOf, resolveRef } from './procShared';
import { mimeForFile } from './assetStore';
import { bytesToB64 } from './b64';
import { MarkdownLite } from './markdownLite';

export interface HandbookOptions {
  /** 場所エイリアス対応表（loadLocationAliases() の結果を渡す。空なら全て disconnected 表記）。 */
  aliases: Record<string, string>;
  /** 参照される画像バイト（snapshotAssets(collectReferencedAssetFiles(project)) の結果を渡す）。 */
  assets: Record<string, Uint8Array>;
  /** 出力日表記用（省略時のみ new Date()。テストは固定値でバイト安定に）。 */
  now?: string;
}

const LEVEL_LABEL: Record<string, string> = { large: '大', medium: '中', small: '小', detail: '詳細' };

// 担当（assignee）に決定論的に割り当てる色。ユーザ名を CSS セレクタ/JS に埋めず、
// ソート済み一覧のインデックスで固定パレットから選ぶ（色値は静的＝安全）。
const ROLE_PALETTE = [
  '#3767a6',
  '#2f7d5b',
  '#a56a12',
  '#6a53a6',
  '#a6371f',
  '#1f6f7a',
  '#8a4b8f',
  '#5a6b2f',
];

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 手順書本文(bodyMd)・条件の対処(thenMd)を MarkdownLite で読み取り専用レンダリング(XSS 安全実証済み)。
const md = (text: string): string => renderToStaticMarkup(createElement(MarkdownLite, { text }));

// 意図的にホスト(実行環境)のローカル日付を使う（仕様: 出力日はユーザの体感日付が正）。
function localDateYmd(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const byOrder = (ts: ProcessTask[]): ProcessTask[] =>
  [...ts].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

function codeOf(codes: Record<Id, string>, id: Id): string {
  return codes[id] ?? '';
}

function nameOf(project: Project, codes: Record<Id, string>, id: Id): string {
  const t = project.core.tasks[id];
  return `${codes[id] ? codes[id] + ' ' : ''}${t?.name ?? ''}`;
}

function assigneeNameOf(project: Project, id: Id): string | undefined {
  const aid = project.core.tasks[id]?.assigneeId;
  return aid ? project.core.assignees[aid]?.name : undefined;
}

// 資料の場所表記。url ロケータのみ実 URL への <a> を許す（自己完結の例外＝台帳の場所表記）。
function locatorHtml(loc: ResolvedLocator): string {
  if (loc.state === 'url' && /^https?:\/\//.test(loc.display)) {
    return `<a href="${escapeHtml(loc.display)}">${escapeHtml(loc.display)}</a>`;
  }
  return escapeHtml(loc.display);
}

// タスクへのアンカー id は文書内で一意にする（大工程・中工程カード・末端サブブロックが同じ taskId に
// 行き着きうるフォールバックがあるため、初出のみ付与する）。
function anchorAttr(used: Set<Id>, id: Id): string {
  if (used.has(id)) return '';
  used.add(id);
  return ` id="hb-task-${escapeHtml(id)}"`;
}

// 中工程配下の末端工程（deriveProcedureNav 順）。mid 自身が末端なら mid を単一の末端として扱う。
// buildProcCard（本文）と collectChapters（サイドバー目次）で共有し両者を乖離させない。
function leavesOfMid(core: Core, manual: Manual, mid: ProcessTask): ProcedureNavItem[] {
  const nav = deriveProcedureNav(core, mid.id, manual);
  if (nav.length === 0 && isLeaf(core, mid.id)) {
    return [
      {
        taskId: mid.id,
        name: mid.name,
        layer: 0,
        parallel: false,
        hasProcedure: (manual.procedures[mid.id]?.steps.length ?? 0) > 0,
      },
    ];
  }
  return nav;
}

// ---- 描画コンテキスト（不変な参照をまとめて引き回しを減らす。used のみ pass ごとに差し替える） ----
interface Render {
  project: Project;
  opts: HandbookOptions;
  codes: Record<Id, string>;
  anchored: ReadonlySet<Id>;
  roleColor: Map<string, string>;
  /** 「フロー上の位置」カード用の全スコープ中ビュー（無ければ位置カードは省略）。 */
  positionView?: FlowLevelView;
}

// 中レベルの全スコープビュー(level==='medium'・scopeParentId 無し)。ユーザーがそのタブを一度も
// 開いていないプロジェクトでは view 自体が無い/ノード 0 のことが多いため、その場合は位置カードを
// 丸ごと省略する(フォールバックで throw しない・空スコープを描かない)。
function findPositionView(project: Project): FlowLevelView | undefined {
  return project.flow.byLevel.find(
    (v) =>
      v.level === 'medium' &&
      !v.scopeParentId &&
      Object.values(v.nodes).some((n) => n.kind === 'task'),
  );
}

// 中工程セクション冒頭の「フロー上の位置」カード。ハイライト対象は中工程自身＋配下の全末端
// （章に載る工程と同じ集合=leavesOfMid の結果）。decorateFlowSvg は使わない(ヘッダー/凡例は不要)。
function buildPositionCard(r: Render, mid: ProcessTask, leaves: ProcedureNavItem[]): string {
  const view = r.positionView;
  if (!view) return '';
  const highlightTaskIds = new Set<Id>([mid.id, ...leaves.map((l) => l.taskId)]);
  const svg = buildFlowSvg(r.project, view, { highlightTaskIds });
  return (
    `<figure class="hb-pos">` +
    `<figcaption class="hb-pos-cap">フロー上の位置</figcaption>` +
    `<div class="hb-pos-scroll">${svg}</div>` +
    `</figure>`
  );
}

// ---- 目次モデル（サイドバー用。工程カード＝中工程 1 件） ----
interface TocMid {
  taskId: Id;
  code: string;
  name: string;
  assignee?: string;
  written: boolean; // 配下末端のいずれかに手順書あり
  layer: number; // トポロジ層（0..）。同一 layer=並行候補（deriveProcedureNav と同じ考え方を中工程に適用）
  parallel: boolean; // 同一 layer に他の中工程がある
}
interface TocChapter {
  taskId: Id;
  code: string;
  name: string;
  mids: TocMid[];
}

// 中工程（同じ大工程配下の兄弟）の並行判定。deriveProcedureNav（packages/core）の
// 「同一 layer=並行」の longest-path 緩和ロジックを、対象を末端でなく中工程に適用したもの。
// サイドバーの縦フローナビ用（本文の末端ナビとは独立に、章内の中工程同士の並行を示す）。
function deriveMidLayering(core: Core, mids: ProcessTask[]): Map<Id, { layer: number; parallel: boolean }> {
  const idSet = new Set(mids.map((m) => m.id));
  const deps = Object.values(core.dependencies).filter((d) => idSet.has(d.from) && idSet.has(d.to));
  const layer = new Map<Id, number>();
  for (const m of mids) layer.set(m.id, 0);
  for (let iter = 0; iter < mids.length; iter++) {
    let changed = false;
    for (const d of deps) {
      const nl = (layer.get(d.from) ?? 0) + 1;
      if (nl > (layer.get(d.to) ?? 0)) {
        layer.set(d.to, nl);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const counts = new Map<number, number>();
  for (const m of mids) {
    const l = layer.get(m.id) ?? 0;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  const result = new Map<Id, { layer: number; parallel: boolean }>();
  for (const m of mids) {
    const l = layer.get(m.id) ?? 0;
    result.set(m.id, { layer: l, parallel: (counts.get(l) ?? 0) > 1 });
  }
  return result;
}

function collectChapters(
  project: Project,
  codes: Record<Id, string>,
): { chapters: TocChapter[]; assignees: string[] } {
  const core = project.core;
  const manual = project.manual;
  const larges = byOrder(Object.values(core.tasks).filter((t) => !t.parentId));
  const nameset = new Set<string>();
  const chapters = larges.map((large) => {
    const midCandidates = byOrder(Object.values(core.tasks).filter((t) => t.parentId === large.id));
    const mids = midCandidates.length > 0 ? midCandidates : [large];
    const layering = deriveMidLayering(core, mids);
    const midEntries: TocMid[] = mids.map((mid) => {
      const assignee = assigneeNameOf(project, mid.id);
      if (assignee) nameset.add(assignee);
      const lp = layering.get(mid.id) ?? { layer: 0, parallel: false };
      return {
        taskId: mid.id,
        code: codeOf(codes, mid.id),
        name: mid.name,
        assignee,
        written: leavesOfMid(core, manual, mid).some((n) => n.hasProcedure),
        layer: lp.layer,
        parallel: lp.parallel,
      };
    });
    return { taskId: large.id, code: codeOf(codes, large.id), name: large.name, mids: midEntries };
  });
  const assignees = [...nameset].sort((a, b) => a.localeCompare(b, 'ja'));
  return { chapters, assignees };
}

// ---- サイドバー（表題・検索・担当フィルタ・現在地付き目次） ----

function buildSidebar(
  r: Render,
  chapters: TocChapter[],
  assignees: string[],
  hasAssets: boolean,
  dateY: string,
): string {
  const title = r.project.meta.title || 'プロジェクト';

  const searchIcon =
    `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" aria-hidden="true">` +
    `<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`;
  const flowIcon =
    `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true">` +
    `<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="4" width="7" height="6" rx="1"/>` +
    `<rect x="8.5" y="14" width="7" height="6" rx="1"/><path d="M6.5 10v2h11v-2M12 12v2"/></svg>`;
  const ledgerIcon =
    `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" aria-hidden="true">` +
    `<path d="M4 5h16M4 12h16M4 19h16"/></svg>`;

  // 担当フィルタ（1 件以上あるときのみ）。all ボタンは data-all、各担当は data-assignee(escaped)。
  const filterBlock =
    assignees.length > 0
      ? `<span class="hb-filter-label">担当で絞り込む</span>` +
        `<div class="hb-chips" id="hb-chips" role="group" aria-label="担当フィルタ">` +
        `<button type="button" class="hb-fchip is-on" data-all>全て</button>` +
        assignees
          .map((a) => {
            const c = r.roleColor.get(a) ?? '#889';
            return (
              `<button type="button" class="hb-fchip" data-assignee="${escapeHtml(a)}" data-color="${escapeHtml(c)}" style="--hb-role:${c}">` +
              `<span class="dot"></span>${escapeHtml(a)}</button>`
            );
          })
          .join('') +
        `</div>` +
        // 非該当工程を「非表示(既定)」にするか「淡色表示」にするかの小トグル。
        // 既定を非表示にして hero の「自分がやる工程だけを表示」の文言と挙動を一致させる。
        `<div class="hb-fmode" id="hb-fmode" role="group" aria-label="非該当工程の表示方法">` +
        `<button type="button" class="hb-fmode-btn is-on" data-mode="hide" aria-pressed="true">非表示</button>` +
        `<button type="button" class="hb-fmode-btn" data-mode="dim" aria-pressed="false">淡色表示</button>` +
        `</div>`
      : '';

  // 中工程を「箱＋縦の連結線」で並べる縦フローナビ（手順書タブの .proc-mflow と同じ表現）。
  const groups = chapters
    .map((chap) => {
      const nodes = chap.mids
        .map((m, i) => {
          const color = m.assignee ? r.roleColor.get(m.assignee) : undefined;
          const roleStyle = color ? ` style="--hb-role:${color}"` : '';
          const roleAttr = m.assignee ? ` data-assignee="${escapeHtml(m.assignee)}"` : '';
          const parBadge = m.parallel ? `<span class="par">∥並行</span>` : '';
          const covBadge = `<span class="cov ${m.written ? 'ok' : 'none'}">${m.written ? '✓' : '—'}</span>`;
          const link =
            `<a class="hb-toc-link hb-mnode${m.written ? '' : ' todo'}" href="#hb-task-${escapeHtml(m.taskId)}"${roleAttr}${roleStyle}>` +
            `<span class="no">${escapeHtml(m.code)}</span><span class="nm">${escapeHtml(m.name)}</span>` +
            `${parBadge}${covBadge}</a>`;
          return (i > 0 ? `<div class="hb-mlink" aria-hidden="true"></div>` : '') + link;
        })
        .join('');
      const cn = chap.code ? `<span class="cn">${escapeHtml(chap.code)}</span>` : '';
      return (
        `<div class="hb-toc-group">` +
        `<button type="button" class="hb-toc-btn" aria-expanded="true">${cn}` +
        `<span class="tt">${escapeHtml(chap.name)}</span><span class="caret" aria-hidden="true"></span></button>` +
        `<div class="hb-toc-links"><nav class="hb-mflow" aria-label="${escapeHtml(chap.name)}の工程フロー">${nodes}</nav></div></div>`
      );
    })
    .join('');

  const ledgerLink = hasAssets
    ? `<a class="hb-toc-top hb-toc-appendix" href="#hb-assets">${ledgerIcon}資料台帳</a>`
    : '';

  return (
    `<aside class="hb-side" id="hb-side">` +
    `<div class="hb-side-head">` +
    `<p class="hb-kicker">業務ハンドブック</p>` +
    `<h1 class="hb-side-title">${escapeHtml(title)}</h1>` +
    `<p class="hb-side-meta">${escapeHtml(dateY)} 版 ・ gantt-flow で生成</p>` +
    `</div>` +
    `<div class="hb-tools">` +
    `<div class="hb-search">${searchIcon}` +
    `<input id="hb-search" type="search" placeholder="工程を検索…" aria-label="工程を検索" autocomplete="off"></div>` +
    filterBlock +
    `</div>` +
    `<nav class="hb-toc" id="hb-toc" aria-label="目次">` +
    `<a class="hb-toc-top" href="#hb-flows">${flowIcon}業務フロー図</a>` +
    groups +
    `<p class="hb-toc-empty" id="hb-toc-empty">該当する工程がありません</p>` +
    ledgerLink +
    `</nav>` +
    `</aside>`
  );
}

// ---- フロー図（案A のフレーム＋キャプション。画面/紙とも同じ buildFlowSvg/decorateFlowSvg） ----

function buildFlowsSection(project: Project): string {
  const cards: string[] = [];
  let n = 0;
  for (const view of project.flow.byLevel) {
    if (view.scopeParentId) continue;
    const taskNodes = Object.values(view.nodes).filter((nd) => nd.kind === 'task').length;
    if (taskNodes === 0) continue;
    n += 1;
    const label = LEVEL_LABEL[view.level] ?? view.level;
    const svg = decorateFlowSvg(buildFlowSvg(project, view), {
      title: label,
      subtitle: project.meta.title || 'プロジェクト',
    });
    cards.push(
      `<figure class="hb-fig">` +
        `<figcaption class="hb-fig-cap"><span class="tag">図${n}</span><b>${escapeHtml(label)}</b></figcaption>` +
        `<div class="hb-fig-scroll">${svg}</div></figure>`,
    );
  }
  const body = cards.length
    ? `<div class="hb-figs">${cards.join('')}</div>`
    : `<div class="hb-empty">フロー図はありません。</div>`;
  return (
    `<section class="hb-flows" id="hb-flows">` +
    `<p class="hb-sec-eyebrow">OVERVIEW</p><h2 class="hb-sec-title">業務フロー図</h2>` +
    body +
    `</section>`
  );
}

// ---- 本文（大工程=章 → 中工程=工程カード → 末端=サブブロック） ----

const REF_ICON: Record<StepRef['kind'], string> = { asset: '📚', io: '📄', task: '🔗' };

function buildRefChip(r: Render, ref: StepRef): string {
  const res = resolveRef(r.project, ref);
  const icon = REF_ICON[ref.kind];
  if (res.broken) {
    return `<span class="hb-mchip broken"><span class="ic">${icon}</span>${escapeHtml(res.label)}（リンク切れ）</span>`;
  }
  if (ref.kind === 'asset') {
    const asset = r.project.manual.assets[ref.assetId];
    const loc = resolveLocator(asset?.locator, r.opts.aliases);
    const locHtml = loc.display ? `<span class="loc">${locatorHtml(loc)}</span>` : '';
    return `<span class="hb-mchip ref"><span class="ic">${icon}</span>${escapeHtml(res.label)}${locHtml}</span>`;
  }
  return `<span class="hb-mchip io"><span class="ic">${icon}</span>${escapeHtml(res.label)}</span>`;
}

function buildShot(opts: HandbookOptions, img: StepImage): string {
  const bytes = opts.assets[img.file];
  const body = bytes
    ? `<img src="data:${mimeForFile(img.file)};base64,${bytesToB64(bytes)}" alt="${escapeHtml(img.caption || 'ステップ画像')}">`
    : `<div class="hb-shot-missing">画像が見つかりません</div>`;
  const caption = img.caption?.trim() ? `<figcaption>${escapeHtml(img.caption)}</figcaption>` : '';
  return `<figure class="hb-shot"><div class="frame">${body}</div>${caption}</figure>`;
}

// 朱書き注記（条件分岐）。飛び先はアンカー実在時のみリンク化・非末端等の未アンカーはプレーン・欠落は切れ表記。
function buildCond(r: Render, c: StepCond): string {
  const { project, codes, anchored } = r;
  const target = c.targetTaskId ? project.core.tasks[c.targetTaskId] : undefined;
  let jump = '';
  if (c.targetTaskId) {
    if (!target) {
      jump = `<span class="hb-cond-link broken">→ リンク切れ</span>`;
    } else if (anchored.has(c.targetTaskId)) {
      jump = `<a class="hb-cond-link" href="#hb-task-${escapeHtml(c.targetTaskId)}">→ ${escapeHtml(nameOf(project, codes, c.targetTaskId))}</a>`;
    } else {
      jump = `<span class="hb-cond-link plain">→ ${escapeHtml(nameOf(project, codes, c.targetTaskId))}</span>`;
    }
  }
  return (
    `<div class="hb-cond">` +
    `<p class="hb-cond-when"><span class="hb-cond-mark">条件</span>${escapeHtml(c.when)}</p>` +
    (c.thenMd.trim() ? `<div class="hb-cond-then">${md(c.thenMd)}</div>` : '') +
    (jump ? `<p class="hb-cond-jump"><span class="hb-cond-k">飛び先</span>${jump}</p>` : '') +
    `</div>`
  );
}

function buildStep(r: Render, step: ProcedureStep): string {
  const bodyHtml =
    (step.bodyMd ?? '').trim() !== '' ? `<div class="hb-step-detail">${md(step.bodyMd ?? '')}</div>` : '';
  const condsHtml = step.conds.map((c) => buildCond(r, c)).join('');
  const refsHtml =
    step.refs.length > 0 ? `<div class="hb-chips">${step.refs.map((rf) => buildRefChip(r, rf)).join('')}</div>` : '';
  const imagesHtml =
    step.images.length > 0 ? `<div class="hb-shots">${step.images.map((img) => buildShot(r.opts, img)).join('')}</div>` : '';
  return (
    `<li class="hb-step"><div class="hb-step-b">` +
    `<p class="hb-step-do">${escapeHtml(step.action)}</p>` +
    (step.why?.trim() ? `<p class="hb-step-why"><span class="k">目的</span>${escapeHtml(step.why)}</p>` : '') +
    bodyHtml +
    condsHtml +
    refsHtml +
    imagesHtml +
    `</div></li>`
  );
}

const EMPTY_NOTE = `<div class="hb-empty"><span class="hb-empty-badge">未作成</span>（手順書未作成）</div>`;

// 末端 1 件分の中身（目的行＋ステップ or 未作成）。手順書が無ければ「（手順書未作成）」1 行のみ。
function buildLeafBody(r: Render, taskId: Id): string {
  const d = r.project.details[taskId];
  const doc = r.project.manual.procedures[taskId];
  const steps = doc?.steps ?? [];
  const howHtml = d?.how?.trim() ? `<p class="hb-purpose-line"><b>目的</b>${escapeHtml(d.how)}</p>` : '';
  const stepsHtml =
    steps.length === 0 ? EMPTY_NOTE : `<ol class="hb-steps">${steps.map((s) => buildStep(r, s)).join('')}</ol>`;
  return howHtml + stepsHtml;
}

// 末端サブブロック（中工程カードが複数末端を束ねるとき、各末端の小見出し＋中身）。
function buildSubBlock(r: Render, used: Set<Id>, item: ProcedureNavItem): string {
  const { project, codes } = r;
  const d = project.details[item.taskId];
  const metaParts: string[] = [];
  const asg = assigneeNameOf(project, item.taskId);
  if (asg) metaParts.push(escapeHtml(asg));
  if (d?.effortMinutes != null) metaParts.push(`${d.effortMinutes}分`);
  const meta = metaParts.length ? `<span class="hb-sub-meta">${metaParts.join(' ・ ')}</span>` : '';
  return (
    `<section class="hb-sub"${anchorAttr(used, item.taskId)}>` +
    `<div class="hb-sub-head"><span class="hb-sub-no">${escapeHtml(codeOf(codes, item.taskId))}</span>` +
    `<h4>${escapeHtml(project.core.tasks[item.taskId]?.name ?? item.name)}</h4>${meta}</div>` +
    buildLeafBody(r, item.taskId) +
    `</section>`
  );
}

// カードの全文検索用テキスト。工程コード/名だけでなく、配下末端のステップ本文(action/why/bodyMd)・
// 条件(when/対処)・参照資料名/IO 名まで連結する（検索対象の拡大: C-06）。ユーザ文字列を含むため
// 呼び出し側で escapeHtml を通して data 属性へ入れる（XSS 規律を維持）。
function collectSearchText(r: Render, taskIds: Id[]): string {
  const { project } = r;
  const parts: string[] = [];
  for (const id of taskIds) {
    const t = project.core.tasks[id];
    if (t?.name) parts.push(t.name);
    const d = project.details[id];
    if (d?.how?.trim()) parts.push(d.how);
    const doc = project.manual.procedures[id];
    if (doc?.purpose?.trim()) parts.push(doc.purpose);
    for (const s of doc?.steps ?? []) {
      if (s.action?.trim()) parts.push(s.action);
      if (s.why?.trim()) parts.push(s.why);
      if (s.bodyMd?.trim()) parts.push(s.bodyMd);
      for (const c of s.conds) {
        if (c.when?.trim()) parts.push(c.when);
        if (c.thenMd?.trim()) parts.push(c.thenMd);
      }
      for (const rf of s.refs) parts.push(resolveRef(project, rf).label);
    }
  }
  // 空白で連結。改行は検索の妨げになるので単一スペースへ畳む。
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// 中工程 1 件分の工程カード。mid 自身が末端ならカードが末端そのもの、そうでなければ末端をサブブロックで束ねる。
function buildProcCard(r: Render, used: Set<Id>, chapName: string, mid: ProcessTask): string {
  const { project, codes, roleColor } = r;
  const core = project.core;
  const leaves = leavesOfMid(core, project.manual, mid);
  const selfLeaf = isLeaf(core, mid.id);
  const posCard = buildPositionCard(r, mid, leaves);

  const assignee = assigneeNameOf(project, mid.id);
  const color = assignee ? roleColor.get(assignee) : undefined;
  const roleTag = assignee
    ? `<span class="hb-role"><span class="rdot"></span>${escapeHtml(assignee)}</span>`
    : '';
  const effort = project.details[mid.id]?.effortMinutes;
  const timeTag = effort != null ? `<span class="hb-proc-time">${effort}分</span>` : '';

  const purpose = project.manual.procedures[mid.id]?.purpose?.trim();
  const purposeBand = purpose
    ? `<div class="hb-group-purpose"><span class="k">この工程の目的</span><p>${escapeHtml(purpose)}</p></div>`
    : '';

  let body: string;
  if (selfLeaf) {
    body = posCard + purposeBand + buildLeafBody(r, mid.id);
  } else if (leaves.length === 0) {
    body = posCard + purposeBand + `<div class="hb-empty">この工程には末端工程がありません。</div>`;
  } else {
    body = posCard + purposeBand + leaves.map((lf) => buildSubBlock(r, used, lf)).join('');
  }

  const emptyClass = selfLeaf && (project.manual.procedures[mid.id]?.steps.length ?? 0) === 0 ? ' empty' : '';
  const dataName = `${codeOf(codes, mid.id) ? codeOf(codes, mid.id) + ' ' : ''}${mid.name}`;
  const roleAttr = assignee ? ` data-assignee="${escapeHtml(assignee)}"` : '';
  const roleStyle = color ? ` style="--hb-role:${color}"` : '';
  const searchIds = selfLeaf ? [mid.id] : [mid.id, ...leaves.map((l) => l.taskId)];
  const searchText = collectSearchText(r, searchIds);

  return (
    `<article class="hb-proc${emptyClass}"${anchorAttr(used, mid.id)} data-anchor="hb-task-${escapeHtml(mid.id)}"` +
    `${roleAttr} data-chap="${escapeHtml(chapName)}" data-name="${escapeHtml(dataName)}" data-search="${escapeHtml(searchText)}"${roleStyle}>` +
    `<div class="hb-proc-head"><span class="hb-proc-no">${escapeHtml(codeOf(codes, mid.id))}</span>` +
    `<h3>${escapeHtml(mid.name)}</h3>${roleTag}${timeTag}</div>` +
    `<div class="hb-proc-body">${body}</div>` +
    `</article>`
  );
}

// 大工程 1 件分の章（折りたたみヘッダ＋章リード＋中工程カード群）。子が無ければ自身を唯一の中工程として扱う。
function buildChapter(r: Render, used: Set<Id>, large: ProcessTask): string {
  const { project, codes } = r;
  const core = project.core;
  const midCandidates = byOrder(Object.values(core.tasks).filter((t) => t.parentId === large.id));
  const mids = midCandidates.length > 0 ? midCandidates : [large];
  const chapName = nameOf(project, codes, large.id);
  const bodyId = `hb-cbody-${large.id}`;
  const cards = mids.map((m) => buildProcCard(r, used, chapName, m)).join('');
  const cn = codeOf(codes, large.id) ? `<span class="cn">${escapeHtml(codeOf(codes, large.id))}</span>` : '';
  return (
    `<section class="hb-chap"${anchorAttr(used, large.id)}>` +
    `<button type="button" class="hb-chap-head" aria-expanded="true" data-target="${escapeHtml(bodyId)}">` +
    cn +
    `<h2>${escapeHtml(large.name)}</h2>` +
    `<span class="hb-chap-count">${mids.length} 工程</span><span class="caret" aria-hidden="true"></span></button>` +
    `<div class="hb-chap-body" id="${escapeHtml(bodyId)}">${cards}</div>` +
    `</section>`
  );
}

function buildMain(r: Render, used: Set<Id>): string {
  const roots = byOrder(Object.values(r.project.core.tasks).filter((t) => !t.parentId));
  return `<main class="hb-main-body">${roots.map((large) => buildChapter(r, used, large)).join('')}</main>`;
}

// ---- 資料台帳一覧 ----

function usageOf(manual: Manual, assetId: Id): { tasks: number; steps: number } {
  let tasks = 0;
  let steps = 0;
  for (const doc of Object.values(manual.procedures)) {
    const n = doc.steps.reduce(
      (acc, s) => acc + (s.refs.some((ref) => ref.kind === 'asset' && ref.assetId === assetId) ? 1 : 0),
      0,
    );
    if (n > 0) {
      tasks += 1;
      steps += n;
    }
  }
  return { tasks, steps };
}

function buildAssetsSection(project: Project, opts: HandbookOptions): string {
  const assets = Object.values(project.manual.assets).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (assets.length === 0) return '';
  const cards = assets
    .map((a) => {
      const u = usageOf(project.manual, a.id);
      const loc = resolveLocator(a.locator, opts.aliases);
      const locHtml = loc.display ? locatorHtml(loc) : '（未設定）';
      return (
        `<div class="hb-led-card">` +
        `<p class="hb-led-name">${escapeHtml(a.name)}</p>` +
        (a.desc?.trim() ? `<p class="hb-led-desc">${escapeHtml(a.desc)}</p>` : '') +
        `<p class="hb-led-loc">${locHtml}</p>` +
        `<p class="hb-led-use">参照 ― ${u.tasks} 工程・${u.steps} ステップ</p>` +
        `</div>`
      );
    })
    .join('');
  return (
    `<section class="hb-ledger" id="hb-assets">` +
    `<p class="hb-sec-eyebrow">APPENDIX</p><h2 class="hb-sec-title">資料台帳</h2>` +
    `<p class="hb-ledger-sub">工程から参照している資料の一覧です。保管場所はコピーして開いてください。</p>` +
    `<div class="hb-led-grid">${cards}</div></section>`
  );
}

// ---- CSS（画面=案B ポータル＋案A タイポ／朱書き。@media print=案A 冊子へ変形） ----
const FONT_MINCHO =
  "'Yu Mincho','YuMincho','Hiragino Mincho ProN','Hiragino Mincho Pro','Noto Serif JP','HGS明朝E','MS PMincho',serif";
const FONT_GOTHIC =
  "'Inter','Yu Gothic UI','Hiragino Kaku Gothic ProN','Noto Sans JP','Meiryo',system-ui,-apple-system,sans-serif";
const FONT_MONO = "'SFMono-Regular','Cascadia Code',Consolas,'Yu Gothic UI',monospace";

const HANDBOOK_CSS = `
:root{
  --bg:#ffffff;--panel:#f7f8fa;--panel-2:#eef1f4;
  --ink:#1b222c;--ink-2:#4c5866;--ink-3:#7b8794;
  --line:#e4e8ed;--line-2:#d2d8df;
  --brand:#0e6f6a;--brand-dark:#0a534f;--brand-tint:#e2f1ef;
  --ai:#233f5b;--ai-tint:#eef1f5;
  --shu:#a6371f;--shu-tint:#f8ede8;--shu-rule:#e0b6a8;
  --mincho:${FONT_MINCHO};--gothic:${FONT_GOTHIC};--mono:${FONT_MONO};
  --side-w:300px;--top-h:56px;
}
*{box-sizing:border-box;}
html{-webkit-text-size-adjust:100%;}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--gothic);
  font-size:14px;line-height:1.75;font-feature-settings:"palt" 1;-webkit-font-smoothing:antialiased;}
a{color:var(--brand);text-underline-offset:2px;}
code{font-family:var(--mono);font-size:.85em;background:var(--panel-2);border:1px solid var(--line);
  border-radius:4px;padding:.03em .4em;color:#334;}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:3px;}
strong{font-weight:700;}

.hb-app{display:grid;grid-template-columns:var(--side-w) 1fr;min-height:100vh;}

/* sidebar */
.hb-side{position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--panel);
  border-right:1px solid var(--line);display:flex;flex-direction:column;}
.hb-side-head{padding:20px 20px 16px;border-bottom:1px solid var(--line);}
.hb-kicker{font-family:var(--mono);font-size:10.5px;letter-spacing:.22em;color:var(--brand);
  text-transform:uppercase;margin:0 0 7px;font-weight:600;}
.hb-side-title{font-family:var(--mincho);font-size:19px;font-weight:600;letter-spacing:.02em;margin:0;line-height:1.4;}
.hb-side-meta{margin:8px 0 0;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;}
.hb-tools{padding:16px 16px 8px;border-bottom:1px solid var(--line);}
.hb-search{position:relative;}
.hb-search input{width:100%;font:inherit;font-size:13px;padding:9px 12px 9px 32px;border:1px solid var(--line-2);
  border-radius:8px;background:var(--bg);color:var(--ink);}
.hb-search input::placeholder{color:var(--ink-3);}
.hb-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);width:14px;height:14px;stroke:var(--ink-3);}
.hb-filter-label{display:block;font-size:10.5px;font-weight:700;letter-spacing:.14em;color:var(--ink-3);
  margin:16px 0 8px;text-transform:uppercase;}
.hb-chips{display:flex;flex-wrap:wrap;gap:6px;}
.hb-fchip{font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--line-2);background:var(--bg);
  color:var(--ink-2);border-radius:999px;padding:4px 11px 4px 9px;display:inline-flex;align-items:center;gap:6px;}
.hb-fchip .dot{width:8px;height:8px;border-radius:50%;background:var(--hb-role,#c3cad2);flex:none;}
.hb-fchip:hover{border-color:var(--ink-3);}
.hb-fchip.is-on{background:var(--ink);color:#fff;border-color:var(--ink);}
.hb-fchip.is-on .dot{box-shadow:0 0 0 2px rgba(255,255,255,.35);}
.hb-fmode{display:inline-flex;margin-top:10px;gap:2px;padding:2px;background:var(--bg);
  border:1px solid var(--line-2);border-radius:999px;}
.hb-fmode-btn{font:inherit;font-size:11px;cursor:pointer;border:0;background:none;color:var(--ink-2);
  border-radius:999px;padding:3px 11px;}
.hb-fmode-btn.is-on{background:var(--ink);color:#fff;}
.hb-toc{padding:12px 10px 28px;flex:1;}
.hb-toc-top{display:flex;align-items:center;gap:9px;text-decoration:none;color:var(--ink-2);
  font-size:13px;font-weight:600;padding:8px 12px;border-radius:8px;}
.hb-toc-top:hover{background:var(--panel-2);}
.hb-toc-top svg{width:15px;height:15px;stroke:var(--ink-3);flex:none;}
.hb-toc-appendix{margin-top:8px;}
.hb-toc-group{margin:10px 0 4px;}
.hb-toc-btn{width:100%;display:flex;align-items:center;gap:8px;background:none;border:0;cursor:pointer;
  font:inherit;font-family:var(--mincho);font-size:14px;font-weight:600;letter-spacing:.02em;color:var(--ink);
  padding:8px 10px 6px;text-align:left;}
.hb-toc-btn .tt{flex:1;}
.hb-toc-btn .cn{font-family:var(--mono);font-size:10.5px;color:var(--ai);font-weight:700;flex:none;}
.hb-toc-btn .caret{width:9px;height:9px;border-right:1.6px solid var(--ink-3);border-bottom:1.6px solid var(--ink-3);
  transform:rotate(45deg);transition:transform .15s;flex:none;}
.hb-toc-btn[aria-expanded="false"] .caret{transform:rotate(-45deg);}
.hb-toc-links{display:flex;flex-direction:column;padding:2px 8px 6px 18px;}
.hb-toc-links[hidden]{display:none;}
/* 縦フローナビ（手順書タブの .proc-mflow/.proc-mnode/.proc-mlink と同じ「箱＋縦の連結線」表現）。 */
.hb-mflow{display:flex;flex-direction:column;}
.hb-mlink{width:2px;height:10px;background:var(--line-2);margin:0 0 0 calc(50% - 1px);}
.hb-mlink.f-hide{display:none;}
.hb-toc-link{display:flex;align-items:center;gap:7px;text-decoration:none;color:var(--ink-2);
  font-size:12px;padding:7px 10px;border-radius:8px;}
.hb-toc-link.hb-mnode{border:1px solid var(--line-2);border-left:3px solid var(--hb-role,var(--line-2));background:var(--bg);}
.hb-toc-link.hb-mnode.todo{border-style:dashed;}
.hb-toc-link .no{font-family:var(--mono);font-size:10.5px;color:var(--ink-3);flex:none;}
.hb-toc-link .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.hb-toc-link .par{font-size:9.5px;font-weight:700;color:#8a5a12;background:#f6e9cf;
  border:1px solid #e2c68d;border-radius:999px;padding:0 6px;flex:none;}
.hb-toc-link .cov{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;flex:none;}
.hb-toc-link .cov.ok{color:var(--brand);}
.hb-toc-link .cov.none{color:var(--ink-3);font-weight:400;}
.hb-toc-link:hover{background:var(--panel-2);color:var(--ink);}
.hb-toc-link.active{background:var(--brand-tint);color:var(--brand-dark);border-color:var(--brand);font-weight:700;}
.hb-toc-link.dim{opacity:.32;}
.hb-toc-link.hide{display:none;}
.hb-toc-link.f-hide{display:none;}
.hb-toc-empty{display:none;padding:10px 22px;font-size:12px;color:var(--ink-3);}

/* main + topbar */
.hb-main{min-width:0;display:flex;flex-direction:column;}
.hb-topbar{position:sticky;top:0;z-index:20;height:var(--top-h);background:rgba(255,255,255,.92);
  backdrop-filter:saturate(1.4) blur(8px);border-bottom:1px solid var(--line);
  display:flex;align-items:center;gap:12px;padding:0 22px;}
.hb-menu{display:none;background:none;border:1px solid var(--line-2);border-radius:8px;width:36px;height:36px;
  cursor:pointer;align-items:center;justify-content:center;flex:none;}
.hb-menu span,.hb-menu span::before,.hb-menu span::after{display:block;width:16px;height:2px;background:var(--ink);position:relative;}
.hb-menu span::before,.hb-menu span::after{content:"";position:absolute;left:0;}
.hb-menu span::before{top:-5px;}.hb-menu span::after{top:5px;}
.hb-crumb{font-size:12.5px;color:var(--ink-2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.hb-crumb b{color:var(--ink);font-weight:700;}
.hb-crumb .sep{color:var(--ink-3);margin:0 .5em;}
.hb-fstate{flex:none;display:none;align-items:center;gap:8px;font-size:12px;color:var(--ink-2);
  background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:4px 6px 4px 12px;}
.hb-fstate.on{display:inline-flex;}
.hb-fstate .fs-dot{width:8px;height:8px;border-radius:50%;background:#888;}
.hb-fstate b{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums;}
.hb-fstate .clear{background:var(--bg);border:1px solid var(--line-2);border-radius:999px;
  cursor:pointer;font:inherit;font-size:11px;color:var(--ink-2);padding:2px 9px;}
.hb-fstate .clear:hover{border-color:var(--ink-3);color:var(--ink);}

.hb-content{padding:0 34px 96px;max-width:960px;width:100%;}
[id^="hb-task-"],#hb-flows,#hb-assets{scroll-margin-top:calc(var(--top-h) + 14px);}

/* hero (screen) / cover (print) */
.hb-hero{padding:34px 0 12px;}
.hb-eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;color:var(--brand);
  text-transform:uppercase;margin:0 0 6px;font-weight:600;}
.hb-hero h1{font-family:var(--mincho);font-size:30px;font-weight:600;letter-spacing:.03em;margin:0 0 8px;line-height:1.25;}
.hb-hero-sub{margin:0 0 12px;color:var(--ink-2);font-size:13.5px;max-width:44em;}
.hb-hero-meta{margin:0;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums;}

.hb-sec-eyebrow{font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.2em;color:var(--ai);
  text-transform:uppercase;margin:0 0 4px;}
.hb-sec-title{font-family:var(--mincho);font-size:22px;font-weight:600;letter-spacing:.06em;margin:0 0 16px;
  padding-bottom:8px;border-bottom:2px solid var(--ink);}

.hb-flows{padding:24px 0 8px;}
.hb-figs{display:flex;flex-direction:column;gap:16px;}
.hb-fig{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--bg);}
.hb-fig-cap{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);
  background:var(--panel);font-size:12px;color:var(--ink-2);}
.hb-fig-cap b{color:var(--ink);font-weight:700;}
.hb-fig-cap .tag{font-family:var(--mono);font-size:10.5px;color:var(--ai);background:var(--ai-tint);
  border-radius:5px;padding:1px 7px;font-weight:600;}
.hb-fig-scroll{overflow-x:auto;}
.hb-fig-scroll svg{display:block;}

/* chapter */
.hb-chap{margin:34px 0 0;border-top:1px solid var(--line);}
.hb-chap-head{width:100%;display:flex;align-items:center;gap:12px;background:none;border:0;cursor:pointer;
  font:inherit;padding:22px 0 16px;text-align:left;}
.hb-chap-head .cn{font-family:var(--mono);font-size:12px;font-weight:700;color:#fff;background:var(--ai);
  border-radius:6px;padding:3px 9px;flex:none;letter-spacing:.02em;}
.hb-chap-head h2{font-family:var(--mincho);font-size:24px;font-weight:600;margin:0;flex:1;letter-spacing:.05em;}
.hb-chap-count{font-size:11.5px;color:var(--ink-3);flex:none;}
.hb-chap-head .caret{width:10px;height:10px;border-right:2px solid var(--ink-3);border-bottom:2px solid var(--ink-3);
  transform:rotate(45deg);transition:transform .15s;flex:none;}
.hb-chap-head[aria-expanded="false"] .caret{transform:rotate(-45deg);}
.hb-chap-body{padding:4px 0 12px;}
.hb-chap-body[hidden]{display:none;}

/* proc card */
.hb-proc{border:1px solid var(--line);border-radius:14px;background:var(--bg);margin:14px 0;overflow:hidden;
  box-shadow:0 1px 2px rgba(20,30,45,.04);transition:opacity .15s;}
.hb-proc.dim{opacity:.34;}
.hb-proc.f-hide{display:none;}
.hb-proc-head{display:flex;align-items:center;gap:12px;padding:15px 18px;border-left:4px solid var(--hb-role,#cbd2da);
  border-bottom:1px solid var(--line);background:linear-gradient(0deg,var(--panel),var(--bg));}
.hb-proc-no{font-family:var(--mono);font-size:13px;font-weight:700;color:var(--ai);flex:none;}
.hb-proc-head h3{font-family:var(--mincho);font-size:18px;font-weight:600;margin:0;flex:1;letter-spacing:.03em;}
.hb-role{flex:none;font-size:11.5px;font-weight:700;color:var(--hb-role,#556);
  background:var(--bg);border:1px solid var(--hb-role,#cbd2da);border-radius:999px;padding:3px 11px;
  display:inline-flex;align-items:center;gap:6px;}
.hb-role .rdot{width:7px;height:7px;border-radius:50%;background:var(--hb-role,#889);}
.hb-proc-time{flex:none;font-family:var(--mono);font-size:11.5px;color:var(--ink-3);}
.hb-proc-body{padding:6px 18px 16px;}

/* フロー上の位置（中工程セクション冒頭のミニ図。ハイライトは buildFlowSvg 側で付与済み） */
.hb-pos{margin:2px 0 14px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel);}
.hb-pos-cap{margin:0;padding:7px 13px;font-size:10.5px;font-weight:700;letter-spacing:.1em;color:var(--ink-3);
  background:var(--panel-2);border-bottom:1px solid var(--line);text-transform:uppercase;}
.hb-pos-scroll{max-height:260px;overflow:auto;background:var(--bg);}
.hb-pos-scroll svg{display:block;}

.hb-group-purpose{margin:14px 0 10px;padding:12px 15px;background:var(--ai-tint);border-left:3px solid var(--ai);border-radius:0 10px 10px 0;}
.hb-group-purpose .k{display:block;font-size:10.5px;font-weight:700;letter-spacing:.12em;color:var(--ai);
  text-transform:uppercase;margin-bottom:4px;}
.hb-group-purpose p{margin:0;font-size:13.5px;color:#123;}
.hb-purpose-line{margin:12px 0 4px;font-size:13px;color:var(--ink-2);}
.hb-purpose-line b{color:var(--ai);font-weight:700;margin-right:.5em;}

/* sub block */
.hb-sub{margin:16px 0 0;}
.hb-sub-head{display:flex;align-items:baseline;gap:.6em;flex-wrap:wrap;padding-bottom:6px;
  border-bottom:1px dashed var(--line);margin-bottom:4px;}
.hb-sub-no{font-family:var(--mono);font-size:12px;color:var(--ai);flex:none;font-weight:600;}
.hb-sub-head h4{font-family:var(--gothic);font-weight:700;font-size:15px;margin:0;letter-spacing:.01em;}
.hb-sub-meta{font-size:11.5px;color:var(--ink-3);letter-spacing:.04em;}

/* steps */
.hb-steps{list-style:none;margin:8px 0 0;padding:0;counter-reset:st;}
.hb-step{display:grid;grid-template-columns:30px 1fr;gap:0 14px;padding:15px 0;border-top:1px solid var(--line);}
.hb-step:first-child{border-top:0;}
.hb-step::before{counter-increment:st;content:counter(st);grid-row:1/99;
  width:26px;height:26px;border-radius:50%;background:var(--ai);color:#fff;font-size:12.5px;font-weight:700;
  display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums;}
.hb-step-do{font-size:15px;font-weight:700;margin:2px 0 0;letter-spacing:.01em;}
.hb-step-why{margin:5px 0 0;font-size:12.5px;color:var(--ink-2);padding-left:.9em;border-left:2px solid var(--ai-tint);}
.hb-step-why .k{color:var(--ai);font-weight:700;margin-right:.4em;}
.hb-step-detail{margin:11px 0 0;font-size:13.5px;color:var(--ink);}
.hb-step-detail .md-p{margin:0 0 8px;}
.hb-step-detail .md-p:last-child{margin-bottom:0;}
.hb-step-detail .md-ul,.hb-step-detail .md-ol{margin:7px 0;padding-left:1.5em;}
.hb-step-detail li{margin:3px 0;}

/* 朱書き（条件分岐） */
.hb-cond{margin:11px 0 0;background:var(--shu-tint);border:1px solid var(--shu-rule);border-left:3px solid var(--shu);
  border-radius:0 10px 10px 0;padding:11px 15px;}
.hb-cond-when{margin:0;font-size:13.5px;font-weight:700;color:var(--shu);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.hb-cond-mark{font-family:var(--mincho);font-size:11px;font-weight:600;letter-spacing:.12em;
  border:1px solid var(--shu);border-radius:4px;padding:1px 7px;flex:none;}
.hb-cond-then{margin:7px 0 0;font-size:13px;color:var(--ink);}
.hb-cond-then .md-p{margin:0 0 4px;}
.hb-cond-then .md-p:last-child{margin-bottom:0;}
.hb-cond-jump{margin:8px 0 0;font-size:12.5px;}
.hb-cond-k{color:var(--ink-3);margin-right:.5em;}
.hb-cond-link{color:var(--brand);text-decoration:underline;text-underline-offset:2px;font-weight:600;}
.hb-cond-link.broken{color:var(--shu);text-decoration:none;}
.hb-cond-link.plain{color:var(--ink-3);text-decoration:none;}

/* ref/io chips */
.hb-chips{display:flex;flex-wrap:wrap;gap:7px;margin:11px 0 0;}
.hb-mchip{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:3px 11px;
  border:1px solid var(--line-2);color:var(--ink-2);background:var(--bg);}
.hb-mchip.ref{color:#0c6d6d;background:#e0f1f0;border-color:#a9d6d3;}
.hb-mchip.io{color:#3767a6;background:#e9f0f9;border-color:#b6cbe6;}
.hb-mchip.broken{color:var(--shu);background:var(--shu-tint);border-color:var(--shu-rule);}
.hb-mchip .ic{font-size:11px;}
.hb-mchip .loc{font-family:var(--mono);font-size:10.5px;opacity:.85;word-break:break-all;}
.hb-mchip a{color:inherit;text-decoration:underline;}

/* image */
.hb-shots{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 2px;}
.hb-shot{margin:0;}
.hb-shot .frame{display:inline-block;border:1px solid var(--line-2);border-radius:10px;background:var(--bg);padding:8px;max-width:280px;}
.hb-shot img{display:block;border-radius:6px;max-width:100%;height:auto;}
.hb-shot-missing{display:flex;align-items:center;justify-content:center;min-height:64px;padding:8px;
  font-size:12px;color:var(--shu);background:var(--shu-tint);border-radius:6px;}
.hb-shot figcaption{font-size:11.5px;color:var(--ink-3);margin-top:6px;}

/* empty */
.hb-empty{display:flex;align-items:center;gap:10px;color:var(--ink-3);font-size:13px;
  background:var(--panel);border:1px dashed var(--line-2);border-radius:10px;padding:12px 15px;margin:10px 0 0;}
.hb-empty-badge{font-size:11px;font-weight:700;color:var(--shu);background:var(--shu-tint);
  border:1px solid var(--shu-rule);border-radius:6px;padding:2px 8px;flex:none;}

/* ledger */
.hb-ledger{margin:44px 0 0;padding-top:26px;border-top:1px solid var(--line);}
.hb-ledger-sub{color:var(--ink-2);font-size:13px;margin:-8px 0 18px;}
.hb-led-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;}
.hb-led-card{border:1px solid var(--line);border-radius:12px;padding:15px 16px;background:var(--bg);}
.hb-led-name{font-family:var(--mincho);font-size:15.5px;font-weight:600;margin:0 0 6px;}
.hb-led-desc{font-size:12.5px;color:var(--ink-2);margin:0 0 10px;}
.hb-led-loc{font-family:var(--mono);font-size:11px;color:var(--ink);background:var(--panel);
  border:1px solid var(--line);border-radius:7px;padding:6px 9px;word-break:break-all;margin:0 0 8px;}
.hb-led-loc a{color:var(--brand);}
.hb-led-use{font-size:11px;color:var(--ink-3);margin:0;}

.hb-foot{margin:40px 0 0;padding-top:18px;border-top:1px solid var(--line);font-size:11px;color:var(--ink-3);line-height:1.8;}

.hb-scrim{position:fixed;inset:0;background:rgba(15,22,30,.4);opacity:0;pointer-events:none;transition:opacity .2s;z-index:30;}

/* responsive: sidebar becomes a drawer */
@media (max-width:900px){
  .hb-app{grid-template-columns:1fr;}
  .hb-side{position:fixed;left:0;top:0;width:min(86vw,320px);z-index:40;transform:translateX(-100%);
    transition:transform .22s ease;box-shadow:0 0 40px rgba(0,0,0,.18);}
  .hb-app.nav-open .hb-side{transform:translateX(0);}
  .hb-app.nav-open .hb-scrim{opacity:1;pointer-events:auto;}
  .hb-menu{display:inline-flex;}
  .hb-content{padding:0 18px 80px;}
}
@media (prefers-reduced-motion:reduce){*{transition:none !important;}}

/* print: 冊子体裁へ変形（画面 UI を落とし明朝の章立てに linearize） */
@page{margin:18mm;}
@media print{
  body{background:#fff;font-size:10.5pt;line-height:1.7;}
  .hb-side,.hb-topbar,.hb-scrim,.hb-menu{display:none !important;}
  .hb-app{display:block;}
  .hb-content{max-width:none;padding:0;}
  .hb-hero{min-height:82vh;padding-top:24mm;border-bottom:1px solid var(--line);}
  .hb-hero h1{font-size:32pt;letter-spacing:.06em;}
  .hb-hero-sub{font-family:var(--mincho);font-size:13pt;}
  .hb-flows,.hb-chap,.hb-ledger{break-before:page;border-top:0;}
  .hb-chap-head{padding-top:0;}
  .hb-chap-body[hidden]{display:block !important;}
  .hb-toc-links[hidden]{display:block !important;}
  .hb-proc,.hb-sub,.hb-step,.hb-cond,.hb-fig,.hb-led-card,.hb-pos{break-inside:avoid;}
  .hb-proc.dim,.hb-toc-link.dim{opacity:1 !important;}
  /* 担当フィルタで非表示にした工程も、紙は「全体を1冊」で残さず刷る（淡色/非表示ともに解除）。 */
  .hb-proc.f-hide{display:block !important;}
  .hb-proc{box-shadow:none;}
  /* 紙面では区切りが章見出しと泣き別れしないよう break-inside:avoid で足りるため、
     画面用の max-height/scroll(コンパクト表示)は解除して全体を描く。 */
  .hb-pos-scroll{max-height:none;overflow:visible;}
  /* 業務フロー図(.hb-fig-scroll)は固定 px 幅の SVG。画面は横スクロールで見せるが、
     紙は横スクロールできず右端が見切れるため、紙幅に合わせて縮小して全体を描く。 */
  .hb-fig-scroll{overflow:visible;}
  .hb-fig-scroll svg{max-width:100%;height:auto;}
  .caret{display:none !important;}
  a{color:var(--ink);text-decoration:none;}
}
`;

// ---- インライン JS（検索・担当フィルタ・現在地・折りたたみ・drawer）。
// ユーザ文字列を含まない静的スクリプト。フィルタ/検索/現在地は DOM(textContent/data-*)からのみ読み、
// crumb などの書き込みは textContent/DOM API 経由（innerHTML に data-* を流し込まない＝XSS 安全）。
const HANDBOOK_JS = `
(function(){
  var app=document.getElementById('hb-app');
  if(!app) return;
  var mq=window.matchMedia('(max-width:900px)');
  var menu=document.getElementById('hb-menu');
  var scrim=document.getElementById('hb-scrim');
  function closeNav(){app.classList.remove('nav-open');}
  if(menu) menu.addEventListener('click',function(){app.classList.toggle('nav-open');});
  if(scrim) scrim.addEventListener('click',closeNav);

  // 「フロー上の位置」カード: ミニ図は工程数ぶん横に長く、ハイライト対象が初期スクロール位置
  // (左上)から外れて見えないことがある。初期表示でハイライト矩形が中央に来るようスクロールする
  // (DOM 属性のみを読む静的処理・ユーザ文字列は扱わない)。
  document.querySelectorAll('.hb-pos-scroll').forEach(function(box){
    var svg=box.querySelector('svg');
    if(!svg) return;
    var hl=svg.querySelector('rect[stroke="#0e6f6a"]');
    if(!hl) return;
    var vb=(svg.getAttribute('viewBox')||'0 0 0 0').split(' ').map(Number);
    var hx=parseFloat(hl.getAttribute('x'))||0;
    var hy=parseFloat(hl.getAttribute('y'))||0;
    var hw=parseFloat(hl.getAttribute('width'))||0;
    var hh=parseFloat(hl.getAttribute('height'))||0;
    var cx=(hx-vb[0])+hw/2;
    var cy=(hy-vb[1])+hh/2;
    box.scrollLeft=Math.max(0,cx-box.clientWidth/2);
    box.scrollTop=Math.max(0,cy-box.clientHeight/2);
  });

  document.querySelectorAll('.hb-toc a[href^="#"], .hb-cond-link[href^="#"]').forEach(function(a){
    a.addEventListener('click',function(e){
      var id=a.getAttribute('href').slice(1);
      var el=document.getElementById(id);
      if(!el) return;
      e.preventDefault();
      el.scrollIntoView({behavior:'smooth',block:'start'});
      if(history.replaceState) history.replaceState(null,'','#'+id);
      if(mq.matches) closeNav();
    });
  });

  document.querySelectorAll('.hb-chap-head').forEach(function(btn){
    btn.addEventListener('click',function(){
      var body=document.getElementById(btn.getAttribute('data-target'));
      var open=btn.getAttribute('aria-expanded')==='true';
      btn.setAttribute('aria-expanded',String(!open));
      if(body) body.hidden=open;
    });
  });
  document.querySelectorAll('.hb-toc-btn').forEach(function(btn){
    btn.addEventListener('click',function(){
      var links=btn.nextElementSibling;
      var open=btn.getAttribute('aria-expanded')==='true';
      btn.setAttribute('aria-expanded',String(!open));
      if(links) links.hidden=open;
    });
  });

  var chipBox=document.getElementById('hb-chips');
  var procs=[].slice.call(document.querySelectorAll('.hb-proc'));
  var tocLinks=[].slice.call(document.querySelectorAll('.hb-toc-link'));
  var fstate=document.getElementById('hb-fstate');
  var fsDot=document.getElementById('hb-fs-dot');
  var fsText=document.getElementById('hb-fs-text');
  var fsCount=document.getElementById('hb-fs-count');
  var active=null;
  var hideMode=true; // 既定は「非表示」（淡色表示は data-mode="dim" のトグルで切替）。
  function matchRole(el){
    var a=el.getAttribute('data-assignee');
    return active===null || !a || a===active;
  }
  function applyFilter(){
    var n=0;
    procs.forEach(function(p){
      var on=matchRole(p);
      p.classList.toggle('f-hide',hideMode&&!on);
      p.classList.toggle('dim',!hideMode&&!on);
      if(active!==null && p.getAttribute('data-assignee')===active) n++;
    });
    tocLinks.forEach(function(l){
      var on=matchRole(l);
      l.classList.toggle('f-hide',hideMode&&!on);
      l.classList.toggle('dim',!hideMode&&!on);
      // 目次の縦フロー連結線が宙に浮かないよう、非表示ノードの直前の線も一緒に畳む。
      var prev=l.previousElementSibling;
      if(prev&&prev.classList&&prev.classList.contains('hb-mlink')) prev.classList.toggle('f-hide',hideMode&&!on);
    });
    if(fstate){
      if(active===null){ fstate.classList.remove('on'); }
      else{
        fstate.classList.add('on');
        if(fsText) fsText.textContent=active+' の担当工程';
        if(fsCount) fsCount.textContent=n+' 件';
      }
    }
  }
  if(chipBox){
    chipBox.addEventListener('click',function(e){
      var b=e.target.closest('.hb-fchip'); if(!b) return;
      active=b.hasAttribute('data-all')?null:b.getAttribute('data-assignee');
      if(fsDot) fsDot.style.background=b.getAttribute('data-color')||'#888';
      chipBox.querySelectorAll('.hb-fchip').forEach(function(c){ c.classList.toggle('is-on',c===b); });
      applyFilter();
    });
  }
  var fmode=document.getElementById('hb-fmode');
  if(fmode){
    fmode.addEventListener('click',function(e){
      var b=e.target.closest('.hb-fmode-btn'); if(!b) return;
      hideMode=b.getAttribute('data-mode')==='hide';
      fmode.querySelectorAll('.hb-fmode-btn').forEach(function(c){
        var on=c===b; c.classList.toggle('is-on',on); c.setAttribute('aria-pressed',String(on));
      });
      applyFilter();
    });
  }
  var clr=document.getElementById('hb-fs-clear');
  if(clr) clr.addEventListener('click',function(){
    active=null;
    if(chipBox) chipBox.querySelectorAll('.hb-fchip').forEach(function(c){ c.classList.toggle('is-on',c.hasAttribute('data-all')); });
    applyFilter();
  });

  var search=document.getElementById('hb-search');
  var tocEmpty=document.getElementById('hb-toc-empty');
  // 目次リンク(href=#hb-task-…)と本文カード(data-anchor=hb-task-…)は同じアンカーで対応づく。
  var procBySearchAnchor={};
  procs.forEach(function(p){ procBySearchAnchor[p.getAttribute('data-anchor')]=p; });
  var firstHit=null;
  function runSearch(){
    var q=search.value.trim().toLowerCase();
    var any=false; firstHit=null;
    tocLinks.forEach(function(l){
      // 照合対象: 目次テキスト(工程コード＋名) ＋ 対応カードの data-search(ステップ本文/条件/資料名/IO名)。
      var hay=l.textContent;
      var card=procBySearchAnchor[l.getAttribute('href').slice(1)];
      if(card){ var ds=card.getAttribute('data-search'); if(ds) hay+=' '+ds; }
      var hit=q===''||hay.toLowerCase().indexOf(q)!==-1;
      l.classList.toggle('hide',!hit);
      if(hit){ any=true; if(q!==''&&!firstHit&&card) firstHit=card; }
    });
    if(tocEmpty) tocEmpty.style.display=(q!==''&&!any)?'block':'none';
  }
  if(search){
    search.addEventListener('input',runSearch);
    // Enter で最初の一致カードへスクロール（モバイルは drawer を閉じる）。
    search.addEventListener('keydown',function(e){
      if(e.key!=='Enter') return;
      e.preventDefault();
      if(firstHit){ firstHit.scrollIntoView({behavior:'smooth',block:'start'}); if(mq.matches) closeNav(); }
    });
  }

  var crumb=document.getElementById('hb-crumb');
  var byAnchor={};
  tocLinks.forEach(function(l){ byAnchor[l.getAttribute('href').slice(1)]=l; });
  function setCrumb(chap,name){
    if(!crumb) return;
    crumb.textContent='';
    if(name){
      var c=document.createElement('span'); c.textContent=chap||'';
      var s=document.createElement('span'); s.className='sep'; s.textContent='›';
      var b=document.createElement('b'); b.textContent=name;
      crumb.appendChild(c); crumb.appendChild(s); crumb.appendChild(b);
    }else{
      var b2=document.createElement('b'); b2.textContent=chap||''; crumb.appendChild(b2);
    }
  }
  if('IntersectionObserver' in window){
    var current=null;
    var spy=new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(!en.isIntersecting) return;
        var p=en.target;
        if(p===current) return;
        current=p;
        tocLinks.forEach(function(l){ l.classList.remove('active'); });
        var link=byAnchor[p.getAttribute('data-anchor')];
        if(link) link.classList.add('active');
        setCrumb(p.getAttribute('data-chap'),p.getAttribute('data-name'));
      });
    },{rootMargin:'-14% 0px -70% 0px',threshold:0});
    procs.forEach(function(p){ spy.observe(p); });
    var flow=document.getElementById('hb-flows');
    if(flow){
      var fspy=new IntersectionObserver(function(entries){
        entries.forEach(function(en){
          if(en.isIntersecting && en.intersectionRatio>0.3){
            tocLinks.forEach(function(l){ l.classList.remove('active'); });
            setCrumb('業務フロー図',null);
            current=null;
          }
        });
      },{threshold:[0.3]});
      fspy.observe(flow);
    }
  }
})();
`;

// 手順書が未作成の末端工程（ハンドブックが「（手順書未作成）」と刷る対象）の件数。
// 出力前の確認ダイアログ用（純粋・OS 非依存）。対象は末端工程＝ハンドブックが手順を並べる粒度で、
// procedures[id].steps が空のもの。中間工程(親)は手順を持たない前提のため数えない。
export function countUnwrittenLeaves(project: Project): number {
  const core = project.core;
  return Object.values(core.tasks).filter(
    (t) => isLeaf(core, t.id) && (project.manual.procedures[t.id]?.steps.length ?? 0) === 0,
  ).length;
}

// ---- 本体 ----

export function buildHandbookHtml(project: Project, opts: HandbookOptions): string {
  const codes = computeCodes(project.core);
  const now = opts.now ? new Date(opts.now) : new Date();
  const dateY = localDateYmd(now);
  const title = project.meta.title || 'プロジェクト';

  const { chapters, assignees } = collectChapters(project, codes);
  const roleColor = new Map<string, string>();
  assignees.forEach((a, i) => roleColor.set(a, ROLE_PALETTE[i % ROLE_PALETTE.length]!));
  const hasAssets = Object.keys(project.manual.assets).length > 0;
  const positionView = findPositionView(project);

  // 1st pass(使い捨て): 実描画と同じ組み立てを走らせ「実際に id を出力する taskId」の完全集合を確定する
  // （buildCond のリンク化可否判定に使う）。この pass の文字列出力は破棄する。
  const anchored = new Set<Id>();
  const r1: Render = { project, opts, codes, anchored, roleColor, positionView };
  buildMain(r1, anchored);

  const used = new Set<Id>();
  const r: Render = { project, opts, codes, anchored, roleColor, positionView };
  const sidebar = buildSidebar(r, chapters, assignees, hasAssets, dateY);
  const flows = buildFlowsSection(project);
  const main = buildMain(r, used);
  const assetsSection = buildAssetsSection(project, opts);

  const hero =
    `<section class="hb-hero" id="hb-top">` +
    `<p class="hb-eyebrow">Business Handbook</p>` +
    `<h1>${escapeHtml(title)}</h1>` +
    `<p class="hb-hero-sub">現場の標準作業手順です。左の目次から工程を選ぶか、担当で絞り込んで「自分がやる工程」だけを表示できます。印刷すると冊子体裁で出力されます。</p>` +
    `<p class="hb-hero-meta">出力日 ${escapeHtml(dateY)} ・ gantt-flow で生成</p>` +
    `</section>`;

  const topbar =
    `<header class="hb-topbar">` +
    `<button type="button" class="hb-menu" id="hb-menu" aria-label="目次を開く"><span></span></button>` +
    `<nav class="hb-crumb" id="hb-crumb" aria-live="polite"><b>業務フロー図</b></nav>` +
    `<div class="hb-fstate" id="hb-fstate"><span class="fs-dot" id="hb-fs-dot"></span>` +
    `<span id="hb-fs-text"></span><b id="hb-fs-count"></b>` +
    `<button type="button" class="clear" id="hb-fs-clear">解除</button></div>` +
    `</header>`;

  const footer =
    `<footer class="hb-foot">${escapeHtml(title)} 業務ハンドブック ／ ${escapeHtml(dateY)} ・ gantt-flow で生成` +
    `（schemaVersion ${project.schemaVersion} ／ appVersion ${escapeHtml(project.meta.appVersion || '')}）。本書は社内限りです。</footer>`;

  return (
    `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)} 業務ハンドブック</title>` +
    `<style>${HANDBOOK_CSS}</style>` +
    `</head><body>` +
    `<div class="hb-app" id="hb-app">` +
    sidebar +
    `<div class="hb-main">` +
    topbar +
    `<div class="hb-content">` +
    hero +
    flows +
    main +
    assetsSection +
    footer +
    `</div></div></div>` +
    `<div class="hb-scrim" id="hb-scrim"></div>` +
    `<script>${HANDBOOK_JS}</script>` +
    `</body></html>`
  );
}
