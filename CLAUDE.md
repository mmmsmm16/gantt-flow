# gantt-flow

工程表（WBS/ガント）とスイムレーン業務フロー図を **単一データから同期** する Tauri デスクトップアプリ。
日本語の社内ツール。オフライン・ローカルファイル運用（外部送信なし）。
ユーザとの対話は日本語で行う。

## モノレポ構成（npm workspaces + Rust crate）

- `packages/core` (`@gantt-flow/core`) — **純粋 TS のドメイン層。React も Tauri も import しない**。
  `model` / `commands` / `sync`(reconcile) / `persistence`(IF) / `import` / `export` / `validate` / `metrics` / `history`。
- `apps/desktop` (`@gantt-flow/desktop`) — Tauri 2 + React 18 + Vite 5 + Zustand 4。
  `src/` はフラット構成（`App.tsx` `store.ts` `TableView.tsx` `FullTable.tsx` `FlowCanvas.tsx` `flowSvg.ts`
  `Inspector.tsx` `persistence.ts` など約 30 ファイル）＋ダイアログ/共通 UI の `src/ui/`。
  `src-tauri/` は Rust の薄いアダプタ（ダイアログ・autosave・更新検知。保存とロックは `crates/fsstore` に委譲）。
- `apps/mcp-server` (`@gantt-flow/mcp`) — core を stdio で公開する MCP サーバ。各編集を
  「core コマンド → `reconcileProject` → `meta.updatedAt` 更新 → アトミック保存」の 1 単位で適用する（write-through）。
- `crates/fsstore` — 共有フォルダ向けのアトミック保存＋助言ロックを担う純 Rust 層（Tauri 殻から呼ばれる）。

## 破ってはいけない設計ルール

1. **`packages/core` は UI/OS 非依存**。React / Tauri / ブラウザ専用 API を core に持ち込まない（Node 上で単体テストできること）。
2. すべてのコア変更は **commands 経由の純粋関数** `(project, args, idGen) => project'`。
   commands は **`core` / `details` のみ** 更新し、**`flow` は触らない**（`packages/core/src/commands/index.ts`）。
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
- `docs/05` の `.gflow` **ZIP バンドル**は未実装。現用の `.gflow` は**単一 JSON**（旧 `.json` も後方互換で
  開ける。`persistence/json.ts`、既定拡張子は `apps/desktop/src/persistence.ts` の `PROJECT_EXT`）。

## スタック詳細

- **バリデーション**: Zod（読込時パース＋マイグレーション境界）。壊れた参照は `quarantine` へ退避して落とさない。
- **Excel/CSV**: SheetJS (`xlsx`)。取り込みは **新規プロジェクト生成専用**（再取り込み更新はしない）。往復はネイティブ `.gflow`。
- **Tauri 2**: capability allowlist（`src-tauri/capabilities/default.json`）でファイル系・ダイアログのみ許可。`tauri.conf.json` 参照。
