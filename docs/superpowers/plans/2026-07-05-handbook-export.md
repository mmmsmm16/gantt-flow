# ハンドブック出力（構想A）実装計画（サイクル3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** .gflow の内容（フロー図＋手順書＋資料台帳）を**自己完結 HTML 1 ファイル**に書き出し、現場へそのまま配れるようにする。見た目は「手順書タブから編集 UI を除いたもの」（spec の確定方針）。

**Architecture:** 純関数 `buildHandbookHtml(project, aliases): string` をテンプレート文字列で組み、既存の自己完結プリミティブを差し込む — フロー図＝`buildFlowSvg`（インライン SVG・マイルストーン/バンド込み）、Markdown＝`renderToStaticMarkup(<MarkdownLite/>)`（再実装しない・XSS 安全）、画像＝`snapshotAssets`→data URI、場所＝`resolveLocator`（出力時解決・未接続は表記維持）、書き出し＝既存 `download()`（Tauri/ブラウザ共通・**Rust 変更ゼロ**）。スタイルはライト `:root` トークン（styles.css:38-156）＋`.proc-*` コンテンツ系の抽出＋配布用シェルの新規最小 CSS。

**Tech Stack:** TypeScript / React（renderToStaticMarkup は markdownLite.test.tsx で実証済み）/ vitest

**設計出典:** `docs/superpowers/specs/2026-07-04-procedure-layer-design.md`（A. ハンドブック出力／「現場が見るのも同じ画面」）／`.superpowers/sdd/`（探索地図はディスパッチ文面で提供）

## Global Constraints

- **core / Rust / MCP は変更ゼロ**（apps/desktop のみ）。sync/・reconcile 非接触。
- 生成器は**純関数・副作用ゼロ**（localStorage 読取は呼び出し側で `loadLocationAliases()` して渡す）＝node 環境でゴールデンテスト可能。
- 出力は**常にライトテーマ**（flowSvg の FLOW_LIGHT と同方針）。ダーク上書き・編集アフォーダンス（input/hover ツール類）は出力に含めない。
- **自己完結**: 外部 URL への参照（script/css/font/画像）を一切含まない。画像は data URI。テストで機械的に固定する。
- すべてのユーザ文字列は `escapeHtml` を通す（XSS・HTML 破壊防止）。Markdown 部分は MarkdownLite（安全実証済み）のみ。
- クラス名は `.proc-*` を踏襲（手順書タブと WYSIWYG）。
- 印刷を考慮: `@media print` で章ごとの改ページ（`break-before: page` を大工程グループに）。
- 新しい store アクションは無し（ACTION_CLASS 変更不要）。
- レビュー傾斜: Task 1 は専任レビュー、Task 2 はコントローラ直接監査。フルワークスペーステストは Task 3 のみ。
- コミットは日本語 conventional・git add は明示パス。

## 生成 HTML の構成（規範）

```
<!doctype html><html lang="ja"><head><meta charset="utf-8">
  <title>{プロジェクト名} 業務ハンドブック</title>
  <style>…（ライト:rootトークン＋.proc-*抽出＋シェル＋@media print）…</style>
</head><body>
  <header class="hb-cover">タイトル・プロジェクト名・出力日(localDateYmd)・「gantt-flow で生成」</header>
  <nav class="hb-toc">目次（フロー図セクション＋大工程→中工程の階層リスト。アンカーリンク）</nav>
  <section class="hb-flows">レベル別フロー図（全スコープビューのうちタスクノードが1つ以上あるレベルのみ。
    decorateFlowSvg(buildFlowSvg(project, view), {title: レベル名, subtitle: プロジェクト名})。
    横幅超過に備え overflow-x:auto のコンテナで包む）</section>
  <main>
    大工程ごとの章グループ（h2・@media print で改ページ）
      └ 中工程ごとの節（h3・祖先パスのパンくず・工程No=computeCodes）
          └ deriveProcedureNav 順の末端章（.proc-chap 相当）:
              見出し（工程No・名称・担当・工数）／目的（how 一行サマリ）／purpose
              ステップ列（.proc-step: no・action・why・bodyMd→MarkdownLite・conds(.proc-cond
                飛び先はアンカーリンク)・refs(.proc-chip: asset=台帳名+解決済み場所/io=帳票名/task=工程名。
                ダングリングは (リンク切れ) 表記)・images(.proc-shot: data URI・caption)）
              手順書未作成の末端は「（手順書未作成）」の1行だけ出す（工程自体は載せる＝全体像を保つ）
  </main>
  <section class="hb-assets">資料台帳一覧（名称・説明・場所=resolveLocator の display
    （resolved=実パス／disconnected=alias/relPath 表記のまま／url）・使用箇所の逆引き数）</section>
  <footer>生成日時・schemaVersion 等の小さな奥付</footer>
</body></html>
```

対象外（次サイクル以降）: 担当フィルタ等の JS インタラクション（v1 は JS ゼロ）、リンクの実在検査、
Excel/印刷専用整形（@media print の改ページのみ）、現場モード（B）。

---

### Task 1 — 生成器 `buildHandbookHtml`（純関数＋テスト）

**Files:**
- Create: `apps/desktop/src/handbook.ts`（生成器本体＋シェル/抽出 CSS 定数）
- Create: `apps/desktop/src/procShared.ts`（ProcedureView のローカルヘルパをリフト）
- Modify: `apps/desktop/src/ProcedureView.tsx`（リフトしたヘルパを import に置換。**挙動変更ゼロ**）
- Modify: `apps/desktop/src/assetStore.ts`（`mimeForFile` を export ＋ `assetDataUri(file): string | undefined` を追加）
- Create: `apps/desktop/test/handbook.test.ts`

**Interfaces（Produces）:**

```ts
// procShared.ts — ProcedureView.tsx:18-85 のローカルヘルパを移設（実装は移動のみ・変更しない）
export function hasChildren(core: Core, id: Id): boolean;
export function isLeaf(core: Core, id: Id): boolean;
export function ancestorsOf(core: Core, id: Id): ProcessTask[];
export function resolveRef(project: Project, ref: StepRef): { label: string; broken: boolean; kind: StepRef['kind'] };

// handbook.ts
export interface HandbookOptions { aliases: Record<string, string>; assets: Record<string, Uint8Array>; now?: string }
export function buildHandbookHtml(project: Project, opts: HandbookOptions): string;
```

- `assets` は呼び出し側が `snapshotAssets(collectReferencedAssetFiles(project))` で渡す（生成器を純粋に保つ）。
- `now` は出力日表記用（省略時のみ `new Date()`。テストは固定値を渡してバイト安定に）。

- [ ] **Step 1: 失敗するテストを書く**（node 環境・renderToStaticMarkup 実証済みパターン）。規範アサーション:
  - 自己完結: `http://`/`https://` を含む `src=`/`href=`/`url(` が**資料の場所表記以外に**存在しない
    （台帳の url ロケータはテキスト/`<a>` として許可。`<script src>`/`<link>`/`<img src="http` は禁止）・
    `<script>` タグが存在しない・画像は `src="data:image/`。
  - サンプルプロジェクト（createSampleProject・手順書ダミーデータ入り）で: 全末端工程の名前が出る／
    手順書ありの工程は action 文が出る／bodyMd の `**太字**` が `<strong>` になる／conds の飛び先が
    `<a href="#...">` アンカー／refs の資料名が出る／未作成の末端に「手順書未作成」。
  - alias 解決: `aliases={}` なら `営業共有/…` の表記のまま（disconnected）、対応表を渡すと実パス結合が出る。
  - ダングリング ref（存在しない assetId を仕込む）で「リンク切れ」表記・throw しない。
  - エスケープ: 工程名に `<img onerror>` を仕込んでもタグとして出力されない。
  - フロー図: `<svg` がレベル数ぶん含まれる（サンプル＝ノードのあるレベルのみ）。
  - 決定論: 同一入力＋固定 now → 同一文字列。
- [ ] **Step 2: procShared.ts へのリフト**（移動のみ）→ ProcedureView の既存テスト・typecheck が緑のまま。
- [ ] **Step 3: 生成器を実装**（構成は上記「生成 HTML の構成」が規範。CSS はライト :root トークンを
  styles.css:38-156 から**値ごと**インライン化＋`.proc-*` コンテンツ系（.proc-chap/.proc-step/.proc-why/
  .proc-cond/.proc-chip/.proc-shot/.proc-detail .md-*）を抽出＋シェル新規。`escapeHtml` は handbook.ts に
  小関数で持つ（persistence の private と重複可・3行）。）
- [ ] **Step 4: テスト・型チェック** — `npm test -w @gantt-flow/desktop` 全緑・typecheck クリーン
- [ ] **Step 5: コミット**

```bash
git add apps/desktop/src/handbook.ts apps/desktop/src/procShared.ts apps/desktop/src/ProcedureView.tsx \
  apps/desktop/src/assetStore.ts apps/desktop/test/handbook.test.ts
git commit -m "feat(desktop): ハンドブック HTML 生成器 buildHandbookHtml (自己完結・WYSIWYG) を追加"
```

---

### Task 2 — 出力導線（メニュー・パレット・手順書タブのボタン）

**依存:** Task 1 完了後（同じ ProcedureView.tsx を触るため直列）。

**Files:**
- Modify: `apps/desktop/src/persistence.ts`（`exportHandbookFile(project): string` — `buildHandbookHtml` を
  `loadLocationAliases()`/`snapshotAssets(collectReferencedAssetFiles(project))` で呼び、
  `download(safeName(title) + '-handbook.html', html, 'text/html;charset=utf-8')`。戻り値=ファイル名）
- Modify: `apps/desktop/src/App.tsx`（`onExportHandbook` ハンドラ（onExportSvg :498-523 と同型・
  `confirmEmptyOutput` と toast の作法踏襲）＋出力 Menu（:759-775）に「ハンドブック (HTML)」＋
  CommandPalette 配線（:1046-1050））
- Modify: `apps/desktop/src/ui/CommandPalette.tsx`（コマンド登録 :706-710・prop 型 :29-33）
- Modify: `apps/desktop/src/ProcedureView.tsx`（`proc-doc-h`（:752 付近）に「📖 ハンドブック出力」ボタン）
- Modify: `apps/desktop/test/persistence.test.ts`（exportHandbookFile が download を正しい名前/mime で呼ぶ）

- [ ] **Step 1: exportHandbookFile ＋テスト**
- [ ] **Step 2: App/palette/ProcedureView の配線**
- [ ] **Step 3: desktop テスト・typecheck 緑**
- [ ] **Step 4: 実画面セルフチェック（scratchpad puppeteer-core・:5173）**: サンプルを開く→手順書タブの
  ボタンと出力メニューの両方から出力→**生成された HTML ファイルを実際にブラウザで開いてスクショ**
  （表紙/目次/フロー図/章/台帳が見えること・コンソールエラー 0）。ヘッドレスのダウンロードは
  CDP の Browser.setDownloadBehavior か、`buildHandbookHtml` を直接呼んでファイルへ書く方式でも可。
- [ ] **Step 5: コミット**

```bash
git add apps/desktop/src/persistence.ts apps/desktop/src/App.tsx apps/desktop/src/ui/CommandPalette.tsx \
  apps/desktop/src/ProcedureView.tsx apps/desktop/test/persistence.test.ts
git commit -m "feat(desktop): ハンドブック出力の導線 (出力メニュー・パレット・手順書タブ) を追加"
```

---

### Task 3 — 総合検証・実物提示

- [ ] **Step 1: フルスイープ** — `npm test --workspaces` / `npm run typecheck --workspaces` 全緑
- [ ] **Step 2: 実物生成** — サンプル＋画像を貼った状態でハンドブックを生成し、コントローラが
  ブラウザ実表示のスクショと**HTML ファイルそのもの**をユーザへ提示（実物で判断してもらう）
- [ ] **Step 3: 最終レビュー** — opus ブランチレビュー（生成 HTML のセキュリティ=自己完結/エスケープ、
  spec 整合、回帰なし）。migration-safety は永続化形式に変更が無いため不要（読み取りのみ）。
- [ ] **Step 4: push・PR 作成（gh CLI）**

---

### Task 4 — 見せ方の再設計（ユーザ実物評価による追加・B ベースのハイブリッド）

ユーザ評価「コンセプト可・文書としての出来が問題」→ デザイン 2 案モック（scratchpad の
handbook-mock-a.html=冊子 / handbook-mock-b.html=業務ポータル）で比較し、**B ベース＋A の
良いところを移植**で確定。

**確定デザイン（規範）:**
- 構造は案B: 固定サイドバー（工程検索・担当フィルタ・現在地ハイライト付き目次）・章折りたたみ・
  モバイル drawer。担当フィルタは非該当工程を減光＋件数バナー。
- 案A から移植: 見出しの組版（明朝の階層感・章扉的な余白）・条件分岐の「朱書き」注記表現・
  `@media print` は**サイドバーを消して冊子レイアウトへ変形**（画面=ポータル・紙=冊子）。
- 制約の更新: **インライン JS を許可**（自己完結は維持: 外部参照ゼロ・`<script src>` 禁止・
  インライン `<script>` のみ可）。自己完結テストは「src 付き script 禁止・インライン可」に更新。
  XSS 規律は不変（ユーザ文字列は JS 文字列にも埋めない — データは DOM から読む設計にする）。
- buildHandbookHtml のシグネチャ・純粋性・決定論・アンカー整合・エスケープの各テストは維持。

**Files:** apps/desktop/src/handbook.ts（表現層の書き換え）／apps/desktop/test/handbook.test.ts（
自己完結アサーション更新＋フィルタ/目次のマークアップ存在検証）。導線（Task 2）は変更なし。

---

### Task 5 — 手順書タブを新デザインに統一（WYSIWYG 復活・ユーザ判断）

ユーザ判断: 「編集画面と配布物の見た目が違う意味が分からない」→ **タブ側を Task 4 の
ハイブリッドデザインに寄せる**（原則「現場が見るのも編集画面と同じ見た目」への回帰）。

- 対象: styles.css の .proc-* 一式＋ ProcedureView.tsx の最小マークアップ調整（クラス追加程度）。
- 揃える要素: 見出しの明朝組版・章/カードの余白とバッジ・条件分岐の「朱書き」表現・参照チップ・
  ステップ番号の意匠（ハンドブック handbook.ts の CSS が正）。
- **編集機能・操作・キーボード・二窓同期は一切変えない**（DOM 構造の変更は最小・既存テスト緑のまま）。
- ダークテーマ対応必須（ハンドブックはライト専用だが、タブは両テーマ。朱書き等は dark で可読な変種を定義）。
- 実画面セルフチェック: 両テーマ・編集操作一式（リネーム/Delete/選択追従/折りたたみ相当）・
  ハンドブックと並べた見た目の一致スクショ。
