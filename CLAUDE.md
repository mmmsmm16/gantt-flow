# gantt-flow

工程表（WBS/ガント）とスイムレーン業務フロー図を **単一データから同期** する Tauri デスクトップアプリ。
日本語の社内ツール。**既定オフライン・ローカルファイル運用**。AI アシストは**オプトイン（既定オフ）**で、
有効時のみユーザが設定したプロバイダ（Anthropic / Azure OpenAI）へプロジェクト内容とメモを送信する。
API キーはローカル保持で当社サーバ等へは送らない。
ユーザとの対話は日本語で行う。

## 進め方（レビュー・意思決定の様式）

このユーザは**視覚で判断する**。複数の変更提案や「何を採用・承認するか」を諮るときは、
**Markdown の箇条書きではなく HTML の意思決定ボード**（Artifact）で見せる。ボードの型:

- **承認待ち → 完了 → 残り** の順（判断が要るものを先頭に）。各項目に **Before→After の小モック**を付ける。
- 承認待ちは **承認／保留／却下＋コメント**、末尾に「決定をコピー」で貼り戻せるテキストにまとめる。完了はコンパクトに折りたたむ。
- 自律実装は**追加系のみ**。削除・統合・既定変更・スキーマ/保存形式変更・Rust/Tauri 実機依存は**承認待ち（★）に回す**。
- 公開前に検証する: 事実確認（「完了」の主張が実コミットと一致するか）・HTML/JS の健全性・デザイン/情報設計。
- ユーザの実務背景（製造業現場の業務改善コンサル。ヒアリング中のライブ入力＋自席整形）を土台に、
  優先度は「ライブ捕捉の摩擦ゼロ化」から。設計意図は `docs/superpowers/specs/2026-07-06-product-redefinition.md`。

## モノレポ構成（npm workspaces + Rust crate）

- `packages/core` (`@gantt-flow/core`) — **純粋 TS のドメイン層。React も Tauri も import しない**。
  `model` / `commands` / `sync`(reconcile) / `persistence`(IF) / `import` / `export` / `validate` / `metrics` / `history`。
  `project.manual` は手順書・資料台帳の層（`commands/manual.ts`、ナビ導出は `sync/procedureNav.ts` —
  `bands`/`milestoneGuides` と同型の純関数で reconcile には関与しない）。
  読み取り専用の集計・点検層: `lint.ts`（業務リント＝納品前チェック。validate の参照整合性＋手順書欠落・担当/工数未入力・
  方策未記入を列挙）/ `export/compareReport.ts`（As-Is→To-Be 改善効果の集計行列。比較ダイアログ・HTML レポート・
  Excel シートの数字の単一ソース）/ `metrics.ts` の `computeHearingProgress`・`computeProjectSummary`
  （サマリ・ステータスバー・Excel 出力が同一流儀で共有）。いずれも決定論・sync/commands 非依存。
- `apps/desktop` (`@gantt-flow/desktop`) — Tauri 2 + React 18 + Vite 5 + Zustand 4。
  `src/` はフラット構成（`App.tsx` `store.ts` `TableView.tsx` `FullTable.tsx` `FlowCanvas.tsx` `flowSvg.ts`
  `Inspector.tsx` `persistence.ts` など約 30 ファイル）＋ダイアログ/共通 UI の `src/ui/`。
  `src-tauri/` は Rust の薄いアダプタ（ダイアログ・autosave・更新検知。保存とロックは `crates/fsstore` に委譲）。
  desktop の共有機構（重複実装しない）: `ToastAction`＝トーストのアクションボタン（破壊的操作の「元に戻す」標準）/
  `openWindowOrWarn`＝`window.open` null をトースト警告する共通ラッパ / 重い出力・印刷は
  「`setBusy` → rAF で1フレーム譲る → 実行 → finally 解除」の定石 / `statusUi.ts`＝ヒアリング状況のラベル・順序・
  クラス（`.st-unheard` 点線含む）の一元管理 / `procedureFocus` シグナル（`{taskId, seq}`）＝手順書タブへの章ジャンプ
  （ビュー間フォーカス連携の雛形）。
- `apps/mcp-server` (`@gantt-flow/mcp`) — core を stdio で公開する MCP サーバ。各編集を
  「core コマンド → `reconcileProject` → `meta.updatedAt` 更新 → アトミック保存」の 1 単位で適用する（write-through）。
- `crates/fsstore` — 共有フォルダ向けのアトミック保存＋助言ロックを担う純 Rust 層（Tauri 殻から呼ばれる）。

## 破ってはいけない設計ルール

1. **`packages/core` は UI/OS 非依存**。React / Tauri / ブラウザ専用 API を core に持ち込まない（Node 上で単体テストできること）。
2. すべてのコア変更は **commands 経由の純粋関数** `(project, args, idGen) => project'`（手順書系は末尾に `now` も注入）。
   commands は **`core` / `details` / `manual` のみ** 更新し、**`flow` は触らない**（`packages/core/src/commands/index.ts`）。
3. flow への反映は **`reconcileFlow(core, details, view, idGen) => { view, report }`**（純粋・決定論・最重要）。
4. **ID 生成は必ず `idGen`（`ids.ts` の `IdGen`）を注入**する。直接 UUID を呼ばない。
   テストは決定論カウンタ（`test/helpers.ts` の `counter()`）を注入して出力をバイト安定にする。
5. undo/redo は **ストア層（`apps/desktop/src/store.ts`）がスナップショットで保持**。core は履歴を持たない。

## reconcile の不変条件（変更時は必ず維持・`docs/04` `docs/08`）

- **対象タスク 1 件 ⇄ タスクノード 1 個**（粒度 × スコープごと）。別粒度/別スコープは対象外。
- **データだけの編集で生存ノードの x/y は不変**（手動配置を保持）。レーン変更など構造要因のみ再配置。
- **`pinned` エッジ・制御ノードは同期で消えない**。
- **冪等**: `reconcileFlow(reconcileFlow(x)) == reconcileFlow(x)`（2 回目は added/removed が空）。
- **ダングリング参照を作らない**。`FlowIssueNote.targetNodeId` は常に実在ノード（対象 I/O 消失時はタスクノードへ寄せる）。
- **IoItem 1 ⇔ doc ノード 1** / **IssueItem 1 ⇔ issue ノード 1**。1 件削除で対応ノードのみ撤去。
- ユーザー経路（`pinned` 直結 or A→判断→B）で到達可能なら直接エッジを張らない。

## 開発コマンド

- ルート: `npm test --workspaces` / `npm run typecheck --workspaces`
- core: `npm test -w @gantt-flow/core`（vitest）/ 単一テスト絞り込み: `npm test -w @gantt-flow/core -- reconcile`
- desktop: `npm run dev -w @gantt-flow/desktop`（Vite, http://localhost:5173）/ `npm run build -w @gantt-flow/desktop`
- mcp-server: `npm run build -w @gantt-flow/mcp`（tsup → `dist/index.js`）/ `npm run dev -w @gantt-flow/mcp`（tsx 直実行）
- 注意: PowerShell の `npm run dev -- --port 5174` は `--port` が npm に食われて効かない（`vite 5174` になる）。
  ポート指定は `npx vite --port 5174` を `apps/desktop` で直接叩くか Bash 経由で。
- git worktree 運用時は `node_modules` が共有されないため、各 worktree で `npm ci` を実行してから dev/test を回す。

## テスト方針（`docs/08-testing.md`）

- **同期エンジンが最大リスク** → ゴールデンテスト（決定論・注入 `idGen`）＋ **fast-check** プロパティテスト。
- マイグレーション: フィクスチャ → `migrate()` → 現行形と deep-equal。現行版は no-op。
- 永続化: `save`→`open` ラウンドトリップ、アトミック書き込み、**マイグレーションはメモリ上のみ**（明示保存まで書き戻さない）。
- E2E は薄く（ハッピーパス 1 本）。ロジック網羅は core 単体テストに寄せる。

## ⚠️ ドキュメントと実装の乖離

`docs/` は設計書で、一部は **計画段階** の記述。**コードを正**とし、docs は設計意図の参照に使う:

- `docs/01` はフロー描画に **@xyflow/react (React Flow)** を想定するが、**実装は自前 SVG**
  （`apps/desktop/src/flowSvg.ts` + `FlowCanvas.tsx`）。`@xyflow/react` 依存は無い。
- `docs/01` の `apps/desktop/src/{store,table,flow,shell}/` という階層は **未採用**。実体はフラットな `src/*` ＋ `src/ui/`。
- 現用の `.gflow` は **v2 ZIP コンテナ**（`project.json`＋`assets/`。`persistence/container.ts`）。
  旧**単一 JSON**（`.gflow`/`.json`）は読み込みのみ後方互換で、明示保存時に v2 になる（schemaVersion 2）。
  Tauri IPC は base64 でバイト列を渡す（既定拡張子は `apps/desktop/src/persistence.ts` の `PROJECT_EXT`）。
- **画像バイナリは Project 外**（`apps/desktop/src/assetStore.ts` のメモリ層。Project には
  `StepImage.file`＝内容ハッシュ名のみ）。保存時に参照分だけ ZIP へ書き（GC）、メモリは消さない。
  localStorage の autosave/backups は**画像を含まない**（クラッシュ復旧時の画像欠落は許容仕様）。

## スタック詳細

- **バリデーション**: Zod（読込時パース＋マイグレーション境界）。壊れた参照は `quarantine` へ退避して落とさない。
- **Excel/CSV**: SheetJS (`xlsx`)。取り込みは **新規プロジェクト生成専用**（再取り込み更新はしない）。往復はネイティブ `.gflow`。
- **Tauri 2**: capability allowlist（`src-tauri/capabilities/default.json`）でファイル系・ダイアログのみ許可。`tauri.conf.json` 参照。
- **AI アシスト**: プロバイダ抽象は `apps/desktop/src/ai/provider.ts`（`AnthropicProvider`＝公式 `@anthropic-ai/sdk`・
  `AzureOpenAiProvider`＝生 fetch・`MockAiProvider`＝テスト/E2E 用）。既定オフライン・オプトイン
  （`useUI.aiEnabled`・localStorage `gf-ai`）で、`requestProposals` は無効時に fetch/SDK へ一切到達しない。
  CSP（`tauri.conf.json` の `csp`/`devCsp` 両方）は `https://api.anthropic.com` と
  `https://*.openai.azure.com` の **2 ドメインのみ** 追加。API キーは `gf-ai-key-*` localStorage
  （「この PC に保存」時のみ）＋セッションメモリにのみ存在し、Project にも SettingsFile にも入れない。
  `runBatch`/`BatchOp`/`BatchOpSchema`/`parseProposals` は `@gantt-flow/core`（`batch.ts`）へ昇格・
  決定論化済みで、`apps/mcp-server` も同じ core 実装を import する（write-through 動作は不変）。
